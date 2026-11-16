import { defineWidget } from '../registry.js';
import { el } from '../api.js';

/**
 * 雪球卡片
 *
 * 数据不经过 Node 后端，而是走 DeskHost 里那个「雪球窗口」的浏览器上下文：
 *   卡片 --postMessage--> C# DeskHost --ExecuteScriptAsync--> 雪球窗口里的 fetch
 *   卡片 <--postMessage-- C# DeskHost <--返回 JSON-------- 雪球窗口里的 fetch
 *
 * 这样做的好处：
 *   1. 请求自带用户在雪球窗口里登录的 Cookie
 *   2. 阿里云 WAF 的 JS 挑战由真浏览器自己过，后端 curl 做不到
 *   3. 全程只有用户点「刷新」才发请求，没有任何定时器
 */

// 实测（2026-11-13）：
//   自选股列表  https://stock.xueqiu.com/v5/stock/portfolio/stock/list.json?size=90&category=1&pid=-1  → 200
//   批量行情    https://stock.xueqiu.com/v5/stock/batch/quote.json?symbol=A,B,C                    → 200
//   关注动态    https://stock.xueqiu.com/v4/statuses/home_timeline.json                          → 403（需登录）
// 注意必须带 stock. 子域：打 www.xueqiu.com 是 Tomcat 404，打相对路径会落到 SPA 上。
const HOST = 'https://stock.xueqiu.com';
const API = {
  portfolio: HOST + '/v5/stock/portfolio/stock/list.json?size=90&category=1&pid=-1',
  batchQuote: (syms) => HOST + '/v5/stock/batch/quote.json?symbol=' + syms.join(',') + '&extend=detail',
};

// 关注流不走接口：/v4/statuses/home_timeline.json 等四个候选路径全部 403（openresty），
// 带 cookie 也不行。改成直接抓雪球首页已经渲染好的 .timeline__item。

function hasBridge() {
  return !!(window.chrome && window.chrome.webview &&
            typeof window.chrome.webview.postMessage === 'function');
}

/* 待回包的请求：reqId -> resolve */
const pending = new Map();
let bridgeBound = false;

function bindBridge() {
  if (bridgeBound || !hasBridge()) return;
  bridgeBound = true;
  window.chrome.webview.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d) return;

    // 1) 窗口没开
    if (d.type === 'xueqiuData' && d.needOpen) {
      const p1 = pending.get(d.reqId);
      if (p1) { pending.delete(d.reqId); p1.reject({ needOpen: true, message: d.error || '雪球窗口还没打开' }); }
      return;
    }

    // 2) fetch 结果（C# 从雪球窗口的页面里直接转发过来的）
    if (d.type === 'xqResult') {
      const p2 = pending.get(d.reqId);
      if (!p2) return;
      pending.delete(d.reqId);
      if (d.error) { p2.reject(new Error(d.error)); return; }
      if (d.body === undefined || d.body === null) { p2.reject(new Error('没有返回数据')); return; }
      p2.resolve({ ok: d.ok, status: d.status, body: d.body });
      return;
    }
  });
}

let seq = 0;
function ask(path, mode, tabName) {
  return new Promise((resolve, reject) => {
    if (!hasBridge()) { reject({ needOpen: true, message: '这里只能在工作台窗口里用' }); return; }
    bindBridge();
    const reqId = 'xq' + (++seq) + '_' + Date.now();
    pending.set(reqId, { resolve, reject });
    if (mode === 'tab') {
      window.chrome.webview.postMessage({ type: 'xueqiuClickTab', tab: tabName, reqId: reqId });
    } else if (mode === 'grab') {
      window.chrome.webview.postMessage({ type: 'xueqiuGrab', reqId: reqId });
    } else {
      window.chrome.webview.postMessage({ type: 'xueqiuFetch', path: path, reqId: reqId });
    }
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        reject(new Error('请求超时（25 秒）'));
      }
    }, 26000);
  });
}

/* ── 解析 ── */

/* 自选股列表：{ data: { pid, category, stocks: [{symbol,name,exchange,...}] } } */
function parsePortfolioList(txt) {
  const j = JSON.parse(txt);
  const list = (j && j.data && j.data.stocks) || [];
  return list.map((x) => ({
    symbol: x.symbol || '',
    name: x.name || '',
    exchange: x.exchange || '',
  })).filter((x) => x.symbol);
}

/* 批量行情：{ data: { items: [{ market:{...}, quote:{ symbol,name,current,percent,... } }] } } */
function parseBatchQuote(txt) {
  const j = JSON.parse(txt);
  const items = (j && j.data && j.data.items) || [];
  const map = {};
  items.forEach((it) => {
    const q = it.quote || it;
    if (!q || !q.symbol) return;
    map[q.symbol] = {
      price: q.current != null ? q.current : null,
      chg: q.percent != null ? q.percent : null,
      chgAbs: q.chg != null ? q.chg : null,
    };
  });
  return map;
}

function parseTimeline(txt) {
  const j = JSON.parse(txt);
  const list = (j && (j.list || (j.data && j.data.list))) || [];
  return list.map((s) => ({
    id: s.id,
    name: (s.user && s.user.screen_name) || '',
    text: String(s.text || s.description || '').replace(/<[^>]+>/g, '').trim(),
    created: s.created_at,
    replies: s.reply_count || 0,
    likes: s.like_count || 0,
    target: s.target || '',
  })).filter((x) => x.text);
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
  return (d.getMonth() + 1) + '/' + d.getDate();
}

/* ── 卡片 ── */

defineWidget({
  type: 'xueqiu',
  name: '雪球',
  size: { w: 380, h: 420 },

  render(body, ctx) {
    const wrap = el('div', 'xq-wrap');

    /* 顶部：tab + 刷新 */
    const head = el('div', 'xq-head');
    const tabs = el('div', 'xq-tabs');
    const btnRefresh = el('button', 'xq-btn', '刷新');
    head.append(tabs, btnRefresh);
    wrap.append(head);

    const box = el('div', 'xq-body');
    wrap.append(box);
    body.append(wrap);

    let tab = 'portfolio';       // portfolio | timeline
    let cache = {};              // tab -> rows
    let busy = false;

    const TABS = [
      ['portfolio', '自选股'],
      ['timeline', '关注'],
      ['hot', '热门'],
    ];

    TABS.forEach(([k, label]) => {
      const t = el('button', 'xq-tab' + (k === tab ? ' on' : ''), label);
      t.dataset.k = k;
      t.onclick = () => {
        if (tab === k) return;
        tab = k;
        [...tabs.children].forEach((c) => c.classList.toggle('on', c.dataset.k === k));
        paint();
      };
      tabs.append(t);
    });

    function paintEmpty(msg, showOpen) {
      box.innerHTML = '';
      const e = el('div', 'xq-empty');
      e.append(el('div', '', msg));
      if (showOpen) {
        const b = el('button', 'xq-btn xq-btn-open', '打开雪球窗口');
        b.onclick = () => {
          if (!hasBridge()) { ctx.toast('只能在工作台窗口里用'); return; }
          window.chrome.webview.postMessage({ type: 'xueqiuOpen' });
          ctx.toast('雪球窗口正在打开，登录后点刷新');
        };
        e.append(b);
      }
      box.append(e);
    }

    function paint() {
      const rows = cache[tab];
      if (!rows) {
        paintEmpty(busy ? '读取中…' : '点右上角「刷新」读数据', !busy);
        return;
      }
      box.innerHTML = '';
      if (!rows.length) {
        paintEmpty('没有数据。可能还在登录，或者雪球返回了空列表。', true);
        return;
      }

      if (tab === 'portfolio') {
        const list = el('div', 'xq-list');
        rows.forEach((r) => {
          const row = el('div', 'xq-row');
          const left = el('div', 'xq-row-l');
          left.append(el('div', 'xq-name', r.name || r.symbol));
          left.append(el('div', 'xq-sym', r.symbol));
          const right = el('div', 'xq-row-r');
          if (r.price != null) right.append(el('div', 'xq-price', String(r.price)));
          if (r.chg != null) {
            const v = Number(r.chg);
            const c = el('div', 'xq-chg ' + (v > 0 ? 'up' : v < 0 ? 'down' : 'flat'),
              (v > 0 ? '+' : '') + v.toFixed(2) + '%');
            right.append(c);
          }
          row.append(left, right);
          list.append(row);
        });
        box.append(list);
      } else {
        const list = el('div', 'xq-feed');
        rows.forEach((r) => {
          const it = el('div', 'xq-post');
          const top = el('div', 'xq-post-h');
          top.append(el('span', 'xq-post-n', r.name || '匿名'));
          top.append(el('span', 'xq-post-t', r.date || fmtTime(r.created)));
          it.append(top);
          const body = el('div', 'xq-post-x', r.text);
          it.append(body);
          // 内容长了给个展开键（默认折叠到 4 行）
          if (r.text && r.text.length > 90) {
            const more = el('button', 'xq-more', '展开全文');
            more.onclick = (ev) => {
              ev.stopPropagation();
              const opened = body.classList.toggle('open');
              more.textContent = opened ? '收起' : '展开全文';
            };
            it.append(more);
          }
          const meta = el('div', 'xq-post-m');
          if (r.replies) meta.append(el('span', '', '💬 ' + r.replies));
          if (r.likes) meta.append(el('span', '', '👍 ' + r.likes));
          if (meta.children.length) it.append(meta);
          list.append(it);
        });
        box.append(list);
      }
    }

    async function load(force) {
      if (busy) return;
      if (!force && cache[tab]) return;
      busy = true;
      paint();
      try {
        if (tab === 'portfolio') {
          // 第一步：拿自选股列表（只有代码和名字）
          const r1 = await ask(API.portfolio);
          const t1 = (r1 && r1.body) || '';
          if (!t1) throw new Error('自选股空响应');
          // 只在真的没通过时才判断登录；200 的响应体里也可能出现 error_code 字样，
          // 之前用 /error_code/ 一起判断会导致拿到数据却报「要求登录」。
          if (r1.status === 401 || r1.status === 403) {
            throw { needLogin: true, message: '雪球要求登录' };
          }
          if (r1.status !== 200) {
            throw new Error('列表 HTTP ' + r1.status);
          }
          let list = [];
          try {
            list = parsePortfolioList(t1);
          } catch (pe) {
            throw new Error('列表解析失败: ' + pe.message + ' | 开头: ' + t1.slice(0, 60));
          }
          if (!list.length) {
            cache.portfolio = [];
            busy = false;
            paint();
            return;
          }
          // 第二步：批量拉行情（价格、涨跌幅）
          const r2 = await ask(API.batchQuote(list.map((x) => x.symbol)));
          const t2 = (r2 && r2.body) || '{}';
          const q = parseBatchQuote(t2);
          cache.portfolio = list.map((x) => Object.assign({}, x, q[x.symbol] || {}));
        } else {
          // tab === 'timeline' → 切到雪球首页的「关注」
          // tab === 'hot'      → 切到雪球首页的「热门」
          const tabName = tab === 'hot' ? '热门' : '关注';
          const res = await ask(null, 'tab', tabName);
          const txt = (res && res.body) || '';
          if (!txt) throw new Error('空响应');
          let data;
          try { data = JSON.parse(txt); }
          catch (pe) { throw new Error(tabName + ' 解析失败: ' + pe.message); }
          const items = data.items || [];
          if (!items.length) {
            throw new Error('没抓到「' + tabName + '」。雪球窗口现在在 ' + (data.url || '未知页面')
              + '，请确认窗口停在「首页」并已登录，再点刷新。');
          }
          cache[tab] = items;
        }
        busy = false;
        paint();
      } catch (e) {
        busy = false;
        const needOpen = e && (e.needOpen || e.needLogin);
        const msg = (e && e.message) ? e.message : String(e);
        cache[tab] = null;
        paintEmpty(needOpen ? msg + '，请先打开雪球窗口登录' : ('读取失败：' + msg), true);
        if (!needOpen) ctx.toast('雪球：' + msg, 3000);
      }
    }

    btnRefresh.onclick = () => { delete cache[tab]; load(true); };

    paint();
    // 不自动拉数据：第一次也等用户点刷新
  },
});
