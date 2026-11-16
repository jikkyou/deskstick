/**
 * 股票行情卡片
 * - 中文/拼音/代码检索添加自选
 * - 置顶项（pinned）永远排最前
 * - 每条：名称 + 市场标签/代码 + mini 分时图 + 最新价 + 涨跌幅
 * - 顶部：三市成交额统计（总额 / 较昨日 / 近 60 日均值）
 * 数据全部经本地后端转发（/api/stock*），浏览器不直连东财。
 */
import { defineWidget } from '../registry.js';
import { el } from '../api.js';

const UP = '#ff7070';
const DOWN = '#45d29b';
const FLAT = '#9aa7ba';

/* 取行情的窗口：工作日 9:00–16:10，其余时间按休市处理（低频刷新） */
function isTradingNow() {
  const d = new Date();
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= 9 * 60 && m <= 16 * 60 + 10;
}

function num(v, dec) {
  if (v === null || v === undefined || v === '-' || v === '') return null;
  const n = Number(v);
  if (isNaN(n)) return null;
  return n.toFixed(dec === undefined ? 2 : dec);
}

function yi(v) {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (!isFinite(n)) return '—';
  const y = n / 1e8;
  return y >= 10000 ? (y / 10000).toFixed(2) + ' 万亿' : Math.round(y).toLocaleString('en-US') + ' 亿';
}

function clockText(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function marketTag(secid) {
  const m = String(secid).split('.')[0];
  if (m === '1') return '沪';
  if (m === '0') return '深';
  if (m === '116') return '港';
  return '美';
}

function codeText(secid) {
  const parts = String(secid).split('.');
  const code = parts[1] || '';
  const m = parts[0];
  if (m === '1') return 'SH' + code;
  if (m === '0') return ((code[0] === '8' || code[0] === '4') ? 'BJ' : 'SZ') + code;
  if (m === '116') return 'HK' + code;
  return code;
}

/* mini 分时图 */
function drawSpark(cv, points, preClose) {
  const dpr = window.devicePixelRatio || 1;
  const cw = 74, ch = 20;          // 与 CSS .stk-spark 保持一致，不依赖 clientWidth
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  if (!points || points.length < 2) return;

  const vals = points.map((p) => p.v);
  let min = Math.min.apply(null, vals);
  let max = Math.max.apply(null, vals);
  if (preClose && isFinite(preClose)) {
    min = Math.min(min, preClose);
    max = Math.max(max, preClose);
  }
  if (max - min < 1e-6) max = min + 0.01;

  const pad = 1.5;
  const x = (i) => (i / (points.length - 1)) * (cw - pad * 2) + pad;
  const y = (v) => ch - pad - ((v - min) / (max - min)) * (ch - pad * 2);

  const last = vals[vals.length - 1];
  const up = preClose ? last >= preClose : true;
  const color = preClose ? (Math.abs(last - preClose) < 1e-9 ? FLAT : (up ? UP : DOWN)) : UP;

  g.beginPath();
  g.moveTo(x(0), ch);
  points.forEach((p, i) => g.lineTo(x(i), y(p.v)));
  g.lineTo(x(points.length - 1), ch);
  g.closePath();
  g.fillStyle = color === FLAT ? 'rgba(154,167,186,.13)'
    : (up ? 'rgba(255,112,112,.18)' : 'rgba(69,210,155,.18)');
  g.fill();

  if (preClose && isFinite(preClose)) {
    g.beginPath();
    g.setLineDash([2, 2]);
    g.moveTo(0, y(preClose));
    g.lineTo(cw, y(preClose));
    g.strokeStyle = 'rgba(255,255,255,.15)';
    g.lineWidth = 1;
    g.stroke();
    g.setLineDash([]);
  }

  g.beginPath();
  points.forEach((p, i) => { if (i) g.lineTo(x(i), y(p.v)); else g.moveTo(x(i), y(p.v)); });
  g.strokeStyle = color;
  g.lineWidth = 1.1;
  g.lineJoin = 'round';
  g.stroke();
}

defineWidget({
  type: 'stocks',
  name: '股票行情',
  size: { w: 445, h: 415 },
  config: { refreshSec: 5 },

  render(body, ctx) {
    const cfg = ctx.model.config || (ctx.model.config = {});
    const store = ctx.state.stocks || (ctx.state.stocks = { list: [], refreshSec: 5 });
    if (!Array.isArray(store.list)) store.list = [];

    let quotes = {};
    let trends = {};
    let mkt = null;
    let lastTs = 0;
    let errText = '';
    let timer = null;
    let alive = true;
    let searchTimer = null;
    let trendAt = 0;
    let failCount = 0;      // 连续失败次数，用于退避
    let dragSecid = null;   // 正在拖动的行

    function ordered() {
      return store.list.filter((w) => w.pinned).concat(store.list.filter((w) => !w.pinned));
    }

    const wrap = el('div', 'stk-wrap');

    // 置顶区：显示在三市统计上方
    const topBox = el('div', 'stk-top');
    wrap.append(topBox);

    const mktBox = el('div', 'stk-mkt');
    wrap.append(mktBox);

    const head = el('div', 'stk-head');
    const status = el('div', 'stk-status');
    const addBtn = el('button', 'stk-btn', '+');
    addBtn.title = '添加自选（支持中文、拼音、代码）';
    head.append(status, addBtn);
    wrap.append(head);

    const addBar = el('div', 'stk-addbar');
    const addInput = document.createElement('input');
    addInput.className = 'stk-input';
    addInput.placeholder = '中文 / 拼音 / 代码，如 茅台、gzmt、600519';
    const addClose = el('button', 'stk-btn', '✕');
    addBar.append(addInput, addClose);
    addBar.style.display = 'none';
    wrap.append(addBar);

    const sug = el('div', 'stk-sug');
    sug.style.display = 'none';
    wrap.append(sug);

    const list = el('div', 'stk-list');
    wrap.append(list);

    const foot = el('div', 'stk-foot');
    wrap.append(foot);

    body.append(wrap);

    function saveStore() {
      if (ctx.save) ctx.save('stocks', store);
    }

    function paintMkt() {
      mktBox.innerHTML = '';
      if (!mkt) {
        mktBox.append(el('div', 'stk-mkt-empty', '三市数据读取中…'));
        return;
      }

      const prev = mkt.prevSame;
      const hasPrev = prev !== null && prev !== undefined && prev > 0;
      const diff = hasPrev ? mkt.total - prev : null;
      const diffPct = hasPrev ? (diff / prev) * 100 : null;

      const r1 = el('div', 'stk-mkt-row');
      r1.append(el('span', 'k', '三市成交'));
      r1.append(el('span', 'v strong', yi(mkt.total)));

      const tag = el('span', 'k', '较昨同期');
      if (mkt.lastTime) tag.title = '与昨日同一时刻（' + mkt.lastTime + '）对比';
      r1.append(tag);

      if (hasPrev) {
        const up = diff >= 0;
        r1.append(el('span', 'v ' + (up ? 'up' : 'down'),
          (up ? '放量 ' : '缩量 ') + yi(Math.abs(diff)) + ' ' +
          (diffPct >= 0 ? '+' : '') + diffPct.toFixed(2) + '%'));
      } else {
        r1.append(el('span', 'v', '—'));
      }
      mktBox.append(r1);

      const r2 = el('div', 'stk-mkt-row');
      r2.append(el('span', 'k', '预测全天'));
      if (mkt.elapsed >= 240) {
        r2.append(el('span', 'v', '已收盘 ' + yi(mkt.total)));
      } else if (mkt.elapsed > 0) {
        r2.append(el('span', 'v strong', yi(mkt.predict)));
        r2.append(el('span', 'k', '按已走 ' + mkt.elapsed + '/240 分钟外推'));
      } else {
        r2.append(el('span', 'v', '未开盘'));
      }
      mktBox.append(r2);
    }

    function paintStatus() {
      const live = isTradingNow();
      status.textContent = '';
      status.classList.toggle('live', live);
      status.append(el('span', 'stk-dot'), el('span', '', live ? '交易中' : '已收盘'));
    }

    /* 把 from 拖到 to 的位置；置顶项不参与排序 */
    function reorderList(fromId, toId) {
      if (fromId === toId) return;
      const from = store.list.findIndex((x) => x.secid === fromId);
      const to = store.list.findIndex((x) => x.secid === toId);
      if (from < 0 || to < 0) return;
      if (store.list[from].pinned || store.list[to].pinned) return;
      const moved = store.list.splice(from, 1)[0];
      store.list.splice(to, 0, moved);
      saveStore();
      paintList();
      ctx.toast('顺序已保存');
    }

    function buildRow(w, isTop) {
      const q = quotes[w.secid];
      const tr = trends[w.secid];
      const pctVal = q && q.pct !== undefined && q.pct !== '-' ? Number(q.pct) : null;
      const cls = pctVal === null ? '' : (pctVal > 0.0001 ? ' up' : (pctVal < -0.0001 ? ' down' : ' flat'));

      const row = el('div', 'stk-row' + cls + (isTop ? ' top' : ''));

      const main = el('div', 'stk-main');
      const nm = el('div', 'stk-name');
      if (w.pinned) nm.append(el('span', 'stk-star', '★'));
      nm.append(document.createTextNode((q && q.name) || w.name || w.secid));
      nm.title = (q && q.name) || w.name || '';
      const cd = el('div', 'stk-code');
      cd.append(el('span', 'stk-tag', marketTag(w.secid)));
      cd.append(el('span', 'stk-code-txt', codeText(w.secid)));
      main.append(nm, cd);

      const cv = document.createElement('canvas');
      cv.className = 'stk-spark';

      const nums = el('div', 'stk-nums');
      const price = el('div', 'stk-price', q ? (num(q.price, q.decimals) || '—') : '—');
      let pt = '—';
      if (pctVal !== null) pt = (pctVal > 0 ? '+' : '') + pctVal.toFixed(2) + '%';
      const pct = el('div', 'stk-pct', pt);
      nums.append(price, pct);

      const del = el('button', 'stk-del', '×');
      del.title = '从自选里移除';
      del.onclick = (ev) => {
        ev.stopPropagation();
        store.list = store.list.filter((x) => x.secid !== w.secid);
        saveStore();
        paintList();
      };

      // 普通行可拖动排序（置顶项固定在上面，不参与）
      if (!isTop) {
        row.draggable = true;
        row.ondragstart = (e) => {
          dragSecid = w.secid;
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', w.secid); } catch (err) {}
        };
        row.ondragend = () => {
          row.classList.remove('dragging');
          dragSecid = null;
        };
        row.ondragover = (e) => {
          if (!dragSecid || dragSecid === w.secid) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          row.classList.add('drag-over');
        };
        row.ondragleave = () => { row.classList.remove('drag-over'); };
        row.ondrop = (e) => {
          e.preventDefault();
          row.classList.remove('drag-over');
          if (dragSecid) reorderList(dragSecid, w.secid);
        };
      }

      row.append(main, cv, nums, del);
      row.onclick = () => {
        const code = String(w.secid).split('.')[1] || '';
        const mk = String(w.secid).split('.')[0];
        const url = 'https://quote.eastmoney.com/' + (mk === '116' ? 'hk' : '') + code + '.html';
        try { window.open(url, '_blank'); } catch (e) {}
      };

      drawSpark(cv, tr && tr.points, tr && tr.preClose);
      return row;
    }

    function paintList() {
      list.innerHTML = '';
      topBox.innerHTML = '';

      const rows = ordered();
      if (!rows.length) {
        topBox.style.display = 'none';
        list.append(el('div', 'stk-empty', '还没有自选 · 点右上角 + 添加'));
        return;
      }

      const pin = rows.filter((w) => w.pinned);
      const rest = rows.filter((w) => !w.pinned);

      // 置顶项固定显示在三市成交统计的上方
      topBox.style.display = pin.length ? 'block' : 'none';
      pin.forEach((w) => topBox.append(buildRow(w, true)));

      rest.forEach((w) => list.append(buildRow(w, false)));
      if (!rest.length) {
        list.append(el('div', 'stk-empty', '其余自选为空 · 点右上角 + 添加'));
      }
    }

    function paintFoot() {
      if (errText) {
        foot.textContent = '⚠ ' + errText;
        foot.classList.add('err');
      } else {
        foot.classList.remove('err');
        foot.textContent = lastTs ? clockText(lastTs) + ' 更新' : '';
      }
    }

    function paint() {
      paintMkt();
      paintStatus();
      paintList();
      paintFoot();
    }

    /* 一次请求拿齐：自选报价 + 三市统计（减少上游请求，东财在限流我们） */
    async function refreshBoard() {
      const secids = ordered().map((w) => w.secid).join(',');
      try {
        const r = await fetch('/api/stock/board?secids=' + encodeURIComponent(secids));
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        quotes = {};
        (d.items || []).forEach((it) => { quotes[it.market + '.' + it.code] = it; });
        let dirty = false;
        (d.items || []).forEach((it) => {
          const w = store.list.find((x) => x.secid === it.market + '.' + it.code);
          if (w && !w.name && it.name) { w.name = it.name; dirty = true; }
        });
        if (dirty) saveStore();
        if (d.market) mkt = d.market;
        lastTs = d.ts;
        errText = '';
      } catch (e) {
        errText = e.message;
      }
    }

    async function refreshTrends() {
      const rows = ordered();
      for (let i = 0; i < rows.length; i++) {
        if (!alive) return;
        const id = rows[i].secid;
        try {
          const r = await fetch('/api/stock/trend?secid=' + encodeURIComponent(id));
          const d = await r.json();
          if (r.ok) trends[id] = { points: d.points || [], preClose: d.preClose };
        } catch (e) { /* 单只失败忽略 */ }
        await new Promise((res) => setTimeout(res, 120));
      }
    }

    async function tick() {
      await refreshBoard();
      if (Date.now() - trendAt > 180000) {
        trendAt = Date.now();
        refreshTrends().then(() => { if (alive) paintList(); });
      }
      failCount = errText ? (failCount + 1) : 0;
      if (alive) paint();
    }

    function schedule() {
      if (timer) clearTimeout(timer);
      if (!alive) return;
      // 休市期间 5 分钟才探一次，够用来发现第二天开盘，又不白打接口
      // 瞟一眼的场景，交易时段 90 秒足够；下限 30 秒防止误配成高频
      const base = isTradingNow() ? Math.max(30, Number(cfg.refreshSec) || 90) : 300;
      // 上游连续失败时指数退避（最多 5 分钟），避免接口挂了还在猛打
      // 偶发失败不退避（东财时常掐连接），连续 3 次才开始翻倍
      const backoff = failCount >= 3
        ? Math.min(300, base * Math.pow(2, Math.min(failCount - 2, 4)))
        : base;
      timer = setTimeout(() => { tick().then(schedule); }, backoff * 1000);
    }

    function closeAdd() {
      addBar.style.display = 'none';
      sug.style.display = 'none';
      sug.innerHTML = '';
      addInput.value = '';
    }

    function openAdd() {
      addBar.style.display = 'flex';
      addInput.value = '';
      addInput.focus();
    }

    async function doSearch(q) {
      sug.innerHTML = '';
      if (!q) { sug.style.display = 'none'; return; }
      sug.style.display = 'block';
      sug.append(el('div', 'stk-sug-item dim', '搜索中…'));
      try {
        const r = await fetch('/api/stock/search?q=' + encodeURIComponent(q));
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        sug.innerHTML = '';
        // A 股优先，港股/美股次之，窝轮/三板等衍生品排最后
        const rank = (t) => (/A$/.test(t || '') ? 0 : (/港|美|沪|深/.test(t || '') ? 1 : 2));
        const items = (d.items || [])
          .slice()
          .sort((a, b) => rank(a.type) - rank(b.type))
          .slice(0, 10);
        if (!items.length) {
          sug.append(el('div', 'stk-sug-item dim', '没找到，换个关键词'));
          return;
        }
        items.forEach((it) => {
          const has = store.list.some((w) => w.secid === it.secid);
          const row = el('div', 'stk-sug-item' + (has ? ' has' : ''));
          row.append(el('span', 'stk-sug-name', it.name));
          row.append(el('span', 'stk-sug-code', (it.type || '') + ' ' + it.code));
          if (has) row.append(el('span', 'stk-sug-has', '已添加'));
          row.onclick = () => {
            if (has) { ctx.toast('已经在自选里了'); return; }
            store.list.push({ secid: it.secid, name: it.name });
            saveStore();
            closeAdd();
            paintList();
            tick().then(schedule);
            ctx.toast('已添加 ' + it.name);
          };
          sug.append(row);
        });
      } catch (e) {
        sug.innerHTML = '';
        sug.append(el('div', 'stk-sug-item dim', '搜索失败：' + e.message));
      }
    }

    addBtn.onclick = (e) => {
      e.stopPropagation();
      if (addBar.style.display === 'flex') closeAdd();
      else openAdd();
    };
    addClose.onclick = (e) => { e.stopPropagation(); closeAdd(); };
    addInput.oninput = () => {
      clearTimeout(searchTimer);
      const q = addInput.value.trim();
      searchTimer = setTimeout(() => doSearch(q), 280);
    };
    addInput.onkeydown = (e) => {
      if (e.key === 'Escape') closeAdd();
    };

    function onVis() {
      if (!document.hidden && alive) tick().then(schedule);
    }
    document.addEventListener('visibilitychange', onVis);

    ctx.onDestroy && ctx.onDestroy(() => {
      alive = false;
      if (timer) clearTimeout(timer);
      clearTimeout(searchTimer);
      document.removeEventListener('visibilitychange', onVis);
    });

    paint();
    tick().then(schedule);
  },
});
