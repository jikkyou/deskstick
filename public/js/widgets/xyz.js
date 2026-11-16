/**
 * 小宇宙播客卡片
 * 视图：login（扫码） / subs（我的订阅） / rec（发现） / eps（单集） / rank（榜单）
 * 播放进度本地保存（/api/xyz/progress），重开卡片能续播
 */
import { defineWidget } from '../registry.js';
import { el } from '../api.js';

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  return m + ' 分钟';
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const p = (n) => String(n).padStart(2, '0');
  if (s >= 3600) return Math.floor(s / 3600) + ':' + p(Math.floor((s % 3600) / 60)) + ':' + p(s % 60);
  return Math.floor(s / 60) + ':' + p(s % 60);
}

function dateText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 86400000;
  if (diff < 1) return '今天';
  if (diff < 2) return '昨天';
  if (diff < 30) return Math.floor(diff) + ' 天前';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

// 复制回退：http 下 clipboard API 不可用，用 execCommand。
// 不弹 prompt —— 模态框会卡住整个页面（自动化环境下尤其明显）。
function copyFallback(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch (e) {
    return false;
  }
}

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

function postJson(url, body) {
  return getJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

defineWidget({
  type: 'xyz',
  name: '小宇宙',
  size: { w: 445, h: 460 },
  config: {},

  render(body, ctx) {
    const root = el('div', 'xz');
    body.append(root);

    let view = 'subs';
    let subs = [];
    let curPod = null;
    let curRank = null;
    let feed = null;
    let progress = {};
    let curEid = '';
    let curEp = null;           // 当前单集（详情页用）
    let backView = 'subs';      // 详情页返回到哪
    let epInfo = false;         // 详情页是否在「信息」视图（i 按钮）
    let epTick = null;          // 详情页进度条刷新函数
    let queueOpen = false;      // 播放列表面板是否打开
    let favBusy = false;
    let pollTimer = null;
    let lastSaved = 0;
    let alive = true;

    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.style.display = 'none';
    const player = el('div', 'xz-player');
    const pTitle = el('div', 'xz-ptitle', '');
    const pBar = el('div', 'xz-pbar');
    const pFill = el('div', 'xz-pfill');
    pBar.append(pFill);
    const pBtn = el('button', 'xz-pbtn', '\u25b6');
    const pTime = el('div', 'xz-ptime', '0:00');
    player.append(audio, pBtn, pTitle, pBar, pTime);
    player.style.display = 'none';

    async function loadProgress() {
      try { progress = await getJson('/api/xyz/progress'); } catch (e) { progress = {}; }
    }

    function saveProgress(force) {
      if (!curEid || !audio.duration) return;
      const now = Date.now();
      if (!force && now - lastSaved < 5000) return;
      lastSaved = now;
      postJson('/api/xyz/progress', { eid: curEid, pos: audio.currentTime, dur: audio.duration })
        .then((r) => { progress[curEid] = r; markRow(); })
        .catch(() => {});
    }

    function markRow() {
      root.querySelectorAll('[data-eid]').forEach((row) => {
        const eid = row.dataset.eid;
        const p = progress[eid];
        let badge = row.querySelector('.xz-prog');
        if (!p || !p.dur || p.pos < 5) { if (badge) badge.remove(); return; }
        const pct = Math.min(100, Math.round((p.pos / p.dur) * 100));
        if (!badge) { badge = el('div', 'xz-prog'); row.append(badge); }
        badge.textContent = pct >= 98 ? '已听完' : pct + '%';
        if (pct >= 98) badge.classList.add('xz-prog-done');
      });
    }

    // 登录彻底失效时后端会返回 NEED_LOGIN，直接回登录页重扫
    function handleErr(e, box) {
      const msg = String((e && e.message) || e || '');
      if (msg.indexOf('NEED_LOGIN') >= 0) {
        ctx.toast('登录已失效，请重新扫码');
        stopPoll();
        view = 'login';
        paint();
        return true;
      }
      if (box) box.innerHTML = '<div class="xz-empty">加载失败：' + msg + '</div>';
      return false;
    }

    function stopPoll() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    function paint() {
      stopPoll();
      epTick = null;
      root.innerHTML = '';
      if (view === 'login') paintLogin();
      else if (view === 'rec') paintRec();
      else if (view === 'eps') paintEps();
      else if (view === 'rank') paintRank();
      else if (view === 'ep') paintEp();
      else paintSubs();
      root.append(player);
      const bar = tabBar();
      if (bar) root.append(bar);
      markRow();
    }

    function tabBar() {
      if (view !== 'subs' && view !== 'rec') return null;
      const bar = el('div', 'xz-tabs');
      [['subs', '订阅'], ['rec', '发现']].forEach(function (pair) {
        const b = el('button', 'xz-tab' + (view === pair[0] ? ' xz-tab-on' : ''), pair[1]);
        b.onclick = function () { if (view !== pair[0]) { view = pair[0]; paint(); } };
        bar.append(b);
      });
      return bar;
    }

    function paintLogin() {
      const box = el('div', 'xz-login');
      box.append(el('div', 'xz-hint', '用手机小宇宙 App 扫码登录'));
      const qrBox = el('div', 'xz-qr');
      const tip = el('div', 'xz-tip', '正在生成二维码…');
      box.append(qrBox, tip);
      root.append(box);

      (async () => {
        try {
          const r = await postJson('/api/xyz/qr/create');
          if (!alive) return;
          try {
            if (typeof window.qrcode === 'function') {
              const qr = window.qrcode(0, 'M');
              qr.addData(r.url);
              qr.make();
              qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
              const svg = qrBox.querySelector('svg');
              if (svg) { svg.style.width = '100%'; svg.style.height = '100%'; }
            } else {
              qrBox.innerHTML = '<div class="xz-qr-fallback">二维码库未加载</div>';
            }
          } catch (e) {
            qrBox.innerHTML = '<div class="xz-qr-fallback">' + String(e.message) + '</div>';
          }
          tip.textContent = '等待扫码…';

          pollTimer = setInterval(async () => {
            if (!alive) { stopPoll(); return; }
            try {
              const s = await postJson('/api/xyz/qr/poll', { id: r.id });
              if (s.status === 'LOGIN_OK') {
                stopPoll();
                ctx.toast('登录成功：' + ((s.user && s.user.nickname) || ''));
                await loadProgress();
                view = 'subs';
                paint();
                return;
              }
              if (s.status === 'SCANNED') tip.textContent = '已扫码，请在手机上确认';
              else if (s.status === 'USED' || s.status === 'CONFIRMED') tip.textContent = '登录中…';
              else tip.textContent = '等待扫码…';
            } catch (e) {
              tip.textContent = '轮询失败：' + e.message;
            }
          }, 2000);
        } catch (e) {
          tip.textContent = '二维码生成失败：' + e.message;
        }
      })();
    }

    function paintSubs() {
      const head = el('div', 'xz-head');
      head.append(el('div', 'xz-title', '我的订阅'));
      const rf = el('button', 'xz-link', '刷新');
      rf.title = '重新拉取订阅（登录失效会自动出二维码）';
      rf.onclick = () => paint();
      const out = el('button', 'xz-link', '退出');
      out.onclick = async () => {
        try { await postJson('/api/xyz/logout'); } catch (e) { /* 忽略 */ }
        view = 'login';
        paint();
      };
      head.append(rf, out);
      root.append(head);

      const list = el('div', 'xz-list');
      root.append(list);
      list.innerHTML = '<div class="xz-empty">加载中…</div>';

      (async () => {
        try {
          const d = await getJson('/api/xyz/subscriptions?limit=60');
          if (!alive) return;
          subs = d.data || [];
          list.innerHTML = '';
          if (!subs.length) { list.innerHTML = '<div class="xz-empty">还没有订阅播客</div>'; return; }
          subs.forEach((s) => {
            const row = el('div', 'xz-row');
            const img = document.createElement('img');
            img.className = 'xz-cover';
            img.loading = 'lazy';
            img.src = (s.image && s.image.picUrl) || s.image || '';
            const info = el('div', 'xz-info');
            info.append(
              el('div', 'xz-name', s.title || '（未命名）'),
              el('div', 'xz-sub', (s.author || '') + (s.latestEpisodePubDate ? ' · ' + dateText(s.latestEpisodePubDate) : ''))
            );
            row.append(img, info);
            row.onclick = () => { curPod = s; view = 'eps'; paint(); };
            list.append(row);
          });
        } catch (e) {
          handleErr(e, list);
        }
      })();
    }

    /* 分页轮播：每页 per 个，下面一排小点点，左右箭头 + 拖动翻页 */
    function pager(items, per, renderItem) {
      const pages = Math.max(1, Math.ceil(items.length / per));
      const wrap = el('div', 'xz-pager');
      const vp = el('div', 'xz-pager-vp');
      const track = el('div', 'xz-pager-track');

      for (let i = 0; i < pages; i++) {
        const pg = el('div', 'xz-pager-page');
        items.slice(i * per, (i + 1) * per).forEach((it) => pg.append(renderItem(it)));
        track.append(pg);
      }
      vp.append(track);
      wrap.append(vp);

      let cur = 0;
      const dots = [];

      function go(i) {
        cur = Math.max(0, Math.min(pages - 1, i));
        track.style.transform = 'translateX(' + (-cur * 100) + '%)';
        dots.forEach((d, j) => d.classList.toggle('on', j === cur));
        if (prevBtn) prevBtn.classList.toggle('off', cur === 0);
        if (nextBtn) nextBtn.classList.toggle('off', cur === pages - 1);
      }

      let prevBtn = null, nextBtn = null;

      if (pages > 1) {
        prevBtn = el('button', 'xz-pg-btn xz-pg-prev', '\u2039');
        nextBtn = el('button', 'xz-pg-btn xz-pg-next', '\u203a');
        prevBtn.onclick = (e) => { e.stopPropagation(); go(cur - 1); };
        nextBtn.onclick = (e) => { e.stopPropagation(); go(cur + 1); };
        wrap.append(prevBtn, nextBtn);

        const dotBox = el('div', 'xz-dots');
        for (let i = 0; i < pages; i++) {
          const d = el('span', 'xz-dot' + (i === 0 ? ' on' : ''));
          d.onclick = (e) => { e.stopPropagation(); go(i); };
          dotBox.append(d);
          dots.push(d);
        }
        wrap.append(dotBox);

        go(0);

        // 水平拖动 / 滑动翻页
        let sx = 0, sy = 0, dragging = false, moved = false;
        vp.addEventListener('pointerdown', (e) => {
          sx = e.clientX; sy = e.clientY; dragging = true; moved = false;
        });
        vp.addEventListener('pointermove', (e) => {
          if (!dragging) return;
          if (Math.abs(e.clientX - sx) > 8 && Math.abs(e.clientX - sx) > Math.abs(e.clientY - sy)) moved = true;
        });
        vp.addEventListener('pointerup', (e) => {
          if (!dragging) return;
          dragging = false;
          if (!moved) return;
          const dx = e.clientX - sx;
          if (Math.abs(dx) < 24) return;
          go(dx < 0 ? cur + 1 : cur - 1);
        });
        vp.addEventListener('pointercancel', () => { dragging = false; });
      }

      return wrap;
    }

    function paintRec() {
      const head = el('div', 'xz-head');
      head.append(el('div', 'xz-title', '发现'));
      const rf = el('button', 'xz-link', '刷新');
      rf.onclick = () => { feed = null; paint(); };
      head.append(rf);
      root.append(head);

      const box = el('div', 'xz-list');
      root.append(box);
      box.innerHTML = '<div class="xz-empty">加载中…</div>';

      (async () => {
        try {
          if (!feed) {
            const d = await getJson('/api/xyz/feed?limit=9');
            const blocks = d.blocks || [];
            const picks = [];
            const ranks = [];
            blocks.forEach((b) => {
              if (b.type === 'EDITOR_PICK') {
                // 结构是 { type, data: { date, picks: [{episode}] } }
                const body = b.data || b;
                (body.picks || []).forEach((x) => picks.push(x.episode || x));
              }
              if (b.type === 'TOP_LIST') {
                (b.data || []).forEach((l) => ranks.push(l));
              }
            });
            // 后端聚合了最近几天的精选（?limit=9），优先用它；
            // 拿不到就退回 feed 自带的 3 条。
            const merged = (d.picks && d.picks.length)
              ? d.picks.map((x) => x.episode || x)
              : picks;
            feed = { picks: merged, ranks: ranks };
          }
          if (!alive) return;
          box.innerHTML = '';
          if (feed.picks.length) {
            box.append(el('div', 'xz-sec', '编辑精选' + (feed.picks.length > 3 ? '（' + feed.picks.length + '）' : '')));
            box.append(pager(feed.picks, 3, epRow));
          }
          if (feed.ranks.length) {
            box.append(el('div', 'xz-sec', '榜单'));
            feed.ranks.forEach((l) => {
              const row = el('div', 'xz-rank');
              const t = el('div', 'xz-rt');
              t.append(el('span', 'xz-rname', l.title || '榜单'));
              t.append(el('span', 'xz-rcnt', ((l.items || []).length) + ' 期'));
              row.append(t, el('span', 'xz-arrow', '\u203a'));
              row.onclick = () => { curRank = l; view = 'rank'; paint(); };
              box.append(row);
            });
          }
          if (!feed.picks.length && !feed.ranks.length) {
            box.innerHTML = '<div class="xz-empty">暂时没有推荐内容</div>';
          }
          markRow();
        } catch (e) {
          handleErr(e, box);
        }
      })();
    }

    function paintRank() {
      const head = el('div', 'xz-head');
      const back = el('button', 'xz-link', '\u2190 返回');
      back.onclick = () => { view = 'rec'; paint(); };
      head.append(back, el('div', 'xz-title', (curRank && curRank.title) || '榜单'));
      root.append(head);

      const box = el('div', 'xz-list');
      root.append(box);
      if (curRank && curRank.information) box.append(el('div', 'xz-note', curRank.information));
      const items = (curRank && curRank.items) || [];
      if (!items.length) { box.append(el('div', 'xz-empty', '这个榜单暂时没有内容')); return; }
      items.forEach((it, i) => {
        const e = it.item || it.episode || it;
        box.append(epRow(e, i + 1));
      });
      if (items.length <= 3) {
        box.append(el('div', 'xz-note', '官方只放出前 ' + items.length + ' 期预览'));
      }
      markRow();
    }


    /* ───────── 单集详情（正在播放） ───────── */
    function cleanShow(html) {
      if (!html) return '';
      let h = String(html);
      h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
      h = h.replace(/<style[\s\S]*?<\/style>/gi, '');
      h = h.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
      h = h.replace(/<(?!\/?(p|br|img)\b)[^>]*>/gi, '');
      h = h.replace(/<img[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi,
        '<img src="$1" style="max-width:100%;border-radius:8px;margin:6px 0;display:block">');
      return h;
    }

    function paintEp() {
      if (!curEp) { view = 'subs'; paint(); return; }

      const head = el('div', 'xz-head');
      const back = el('button', 'xz-link', '\u2190 返回');
      back.onclick = () => { view = backView; paint(); };
      const infoBtn = el('button', 'xz-link xz-ibtn' + (epInfo ? ' on' : ''), 'i');
      infoBtn.title = epInfo ? '收起详情' : '看简介和 shownotes';
      infoBtn.onclick = () => { epInfo = !epInfo; paint(); };
      const ttl = el('div', 'xz-title', epInfo ? '单集详情' : '正在播放');
      head.append(back, ttl, infoBtn);
      root.append(head);

      // ── 信息页：简介 + shownotes ──
      if (epInfo) {
        const box = el('div', 'xz-list xz-detail');
        box.append(el('div', 'xz-dtitle2', curEp.title || '\uff08\u65e0\u6807\u9898\uff09'));
        box.append(el('div', 'xz-dsub', ((curEp.podcast || {}).title || '') +
          (curEp.pubDate ? ' \u00b7 ' + dateText(curEp.pubDate) : '') +
          (curEp.duration ? ' \u00b7 ' + fmtDur(curEp.duration) : '')));

        if (curEp.description) {
          box.append(el('div', 'xz-sec', '\u7b80\u4ecb'));
          box.append(el('div', 'xz-desc', String(curEp.description).slice(0, 2000)));
        }
        if (curEp.shownotes) {
          box.append(el('div', 'xz-sec', 'Shownotes'));
          const sn = el('div', 'xz-show');
          const html = cleanShow(curEp.shownotes);
          if (html.trim()) sn.innerHTML = html;
          else sn.textContent = '\uff08\u65e0\u5185\u5bb9\uff09';
          box.append(sn);
        }
        if (!curEp.description && !curEp.shownotes) {
          box.append(el('div', 'xz-empty', '\u8fd9\u4e00\u96c6\u6ca1\u6709\u7b80\u4ecb'));
        }
        root.append(box);
        return;
      }

      // ── 播放列表（覆盖在播放页上） ──
      if (queueOpen) {
        const qbox = el('div', 'xz-list xz-queue');
        const qhead = el('div', 'xz-qhead');
        qhead.append(el('div', 'xz-sec', '播放列表'));
        const closeBtn = el('button', 'xz-link', '收起');
        closeBtn.onclick = () => { queueOpen = false; paint(); };
        qhead.append(closeBtn);
        qbox.append(qhead);
        const qlist = el('div', 'xz-qlist');
        qbox.append(qlist);
        qlist.innerHTML = '<div class="xz-empty">加载中…</div>';
        root.append(qbox);

        (async () => {
          try {
            const d = await getJson('/api/xyz/queue');
            if (!alive || !queueOpen) return;
            const arr = d.items || [];
            qlist.innerHTML = '';
            if (!arr.length) {
              qlist.innerHTML = '<div class="xz-empty">还没播过什么</div>';
              return;
            }
            arr.forEach((it) => {
              const row = el('div', 'xz-ep' + (it.eid === curEid ? ' xz-cur' : ''));
              const info = el('div', 'xz-info');
              info.append(
                el('div', 'xz-name', it.title || '（无标题）'),
                el('div', 'xz-sub', (it.podcast || '') + (it.duration ? ' · ' + fmtDur(it.duration) : ''))
              );
              row.append(info);
              row.onclick = () => {
                if (it.eid === curEid) { queueOpen = false; paint(); return; }
                // 队列里的条目直接播（用存下来的 url）
                const fake = {
                  eid: it.eid, pid: it.pid, title: it.title, duration: it.duration,
                  image: { picUrl: it.image }, podcast: { title: it.podcast },
                  enclosure: { url: it.url },
                };
                queueOpen = false;
                playEp(fake);
              };
              qlist.append(row);
            });
          } catch (e) {
            handleErr(e, qlist);
          }
        })();

        const clr = el('button', 'xz-link', '清空');
        clr.style.margin = '6px auto 0';
        clr.onclick = async () => {
          try { await postJson('/api/xyz/queue', { clear: true }); queueOpen = false; paint(); }
          catch (e) { ctx.toast('清空失败'); }
        };
        qbox.append(clr);
        return;
      }

      // ── 播放页：大封面 + 控制 ──
      const box = el('div', 'xz-play-view');

      const cover = el('div', 'xz-bigcover');
      const img = document.createElement('img');
      img.src = (curEp.image && curEp.image.picUrl) || curEp.image || '';
      cover.append(img);
      box.append(cover);

      box.append(el('div', 'xz-ptitle2', curEp.title || '\uff08\u65e0\u6807\u9898\uff09'));
      box.append(el('div', 'xz-psub2', ((curEp.podcast || {}).title || '') +
        (curEp.pubDate ? ' \u00b7 ' + dateText(curEp.pubDate) : '')));

      // 大进度条
      const barWrap = el('div', 'xz-bbar');
      const barFill = el('div', 'xz-bfill');
      barWrap.append(barFill);
      const timeRow = el('div', 'xz-btime');
      const tCur = el('span', 'xz-bt-cur', '0:00');
      const tLeft = el('span', 'xz-bt-left', '\u2013' + fmtClock(curEp.duration || 0));
      timeRow.append(tCur, tLeft);
      box.append(barWrap, timeRow);

      barWrap.onclick = (ev) => {
        if (!audio.duration) return;
        const r = barWrap.getBoundingClientRect();
        audio.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * audio.duration;
      };

      // 播放控制：后退 15 / 播放 / 前进 30
      const ctl = el('div', 'xz-ctl');
      const b15 = el('button', 'xz-cbtn', '\u21ba15');
      b15.title = '后退 15 秒';
      b15.onclick = () => {
        if (!audio.duration) return;
        audio.currentTime = Math.max(0, audio.currentTime - 15);
      };
      const bPlay = el('button', 'xz-cbtn xz-cmain', audio.paused ? '\u25b6' : '\u23f8');
      bPlay.onclick = () => {
        if (audio.paused) {
          audio.play().then(() => { bPlay.textContent = '\u23f8'; pBtn.textContent = '\u23f8'; })
               .catch(() => ctx.toast('播放被浏览器拦了，再点一下'));
        } else {
          audio.pause();
          bPlay.textContent = '\u25b6';
          pBtn.textContent = '\u25b6';
        }
      };
      const b30 = el('button', 'xz-cbtn', '30\u21bb');
      b30.title = '前进 30 秒';
      b30.onclick = () => {
        if (!audio.duration) return;
        audio.currentTime = Math.min(audio.duration, audio.currentTime + 30);
      };
      ctl.append(b15, bPlay, b30);
      box.append(ctl);

      // 功能行：播放列表 / 收藏 / 分享
      const tools = el('div', 'xz-tools');
      const tList = el('button', 'xz-tool', '\u2630 播放列表');
      tList.onclick = () => { queueOpen = !queueOpen; paint(); };
      const isFav = !!(curEp.isFavorited);
      const tFav = el('button', 'xz-tool' + (isFav ? ' on' : ''), (isFav ? '\u2665' : '\u2661') + ' 收藏');
      tFav.onclick = async () => {
        if (favBusy) return;
        favBusy = true;
        const next = !curEp.isFavorited;
        try {
          const r = await postJson('/api/xyz/favorite', { eid: curEp.eid, favorited: next });
          curEp.isFavorited = !!r.favorited;
          ctx.toast(r.favorited ? '已收藏' : '已取消收藏');
          paint();
        } catch (e) {
          if (!handleErr(e)) ctx.toast('收藏失败：' + e.message);
        } finally {
          favBusy = false;
        }
      };
      const tShare = el('button', 'xz-tool', '\u2934 分享');
      tShare.onclick = () => {
        const link = 'https://www.xiaoyuzhoufm.com/episode/' + curEp.eid;
        // http 下 navigator.clipboard 不可用（非安全上下文），回退到 execCommand
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(link)
            .then(() => ctx.toast('链接已复制'))
            .catch(() => {
              const ok = copyFallback(link);
              ctx.toast(ok ? '链接已复制' : ('复制被拦了，链接：' + link), 8000);
            });
        } else {
          const ok = copyFallback(link);
          ctx.toast(ok ? '链接已复制' : ('复制被拦了，链接：' + link), 8000);
        }
      };
      tools.append(tList, tFav, tShare);
      box.append(tools);

      // 这页的进度条跟随播放实时更新
      epTick = function () {
        if (!audio.duration) return;
        const pct = (audio.currentTime / audio.duration) * 100;
        barFill.style.width = pct + '%';
        tCur.textContent = fmtClock(audio.currentTime);
        tLeft.textContent = '\u2013' + fmtClock(Math.max(0, audio.duration - audio.currentTime));
        const want = audio.paused ? '\u25b6' : '\u23f8';
        if (bPlay.textContent !== want) bPlay.textContent = want;
      };
      epTick();

      root.append(box);
    }

    function paintEps() {
      const head = el('div', 'xz-head');
      const back = el('button', 'xz-link', '\u2190 返回');
      back.onclick = () => { view = 'subs'; paint(); };
      head.append(back, el('div', 'xz-title', (curPod && curPod.title) || '播客'));
      root.append(head);

      const list = el('div', 'xz-list');
      root.append(list);
      list.innerHTML = '<div class="xz-empty">加载中…</div>';

      (async () => {
        try {
          const d = await getJson('/api/xyz/episodes?pid=' + encodeURIComponent(curPod.pid) + '&limit=40');
          if (!alive) return;
          list.innerHTML = '';
          const arr = d.data || [];
          if (!arr.length) { list.innerHTML = '<div class="xz-empty">这个播客还没有单集</div>'; return; }
          arr.forEach((e) => list.append(epRow(e)));
          markRow();
        } catch (e) {
          handleErr(e, list);
        }
      })();
    }

    function epRow(e, idx) {
      const row = el('div', 'xz-ep');
      if (e && e.eid) row.dataset.eid = e.eid;
      const info = el('div', 'xz-info');
      const name = el('div', 'xz-name', (idx ? idx + '. ' : '') + ((e && e.title) || '（无标题）'));
      const pod = e && e.podcast && e.podcast.title ? e.podcast.title : '';
      const sub = (pod ? pod + ' · ' : '') + dateText(e && e.pubDate) + ' · ' + fmtDur(e && e.duration);
      info.append(name, el('div', 'xz-sub', sub));
      row.append(info);
      if (e && e.eid) row.onclick = () => playEp(e);
      return row;
    }

    function playEp(e) {
      const url = (e.enclosure && e.enclosure.url) || '';
      if (!url) { ctx.toast('这条单集没有音频地址'); return; }
      if (curEid && curEid !== e.eid) saveProgress(true);

      curEp = e;
      epInfo = false;                          // 换集回到播放视图
      if (view !== 'ep') backView = view;      // 记住从哪来的
      curEid = e.eid || '';
      audio.src = url;
      pTitle.textContent = e.title || '';
      player.style.display = 'flex';
      pFill.style.width = '0%';
      pTime.textContent = '0:00';
      pBtn.textContent = '\u23f8';

      let resumeAt = 0;
      const pr = curEid ? progress[curEid] : null;
      if (pr && pr.pos > 5 && (!pr.dur || pr.pos < pr.dur - 10)) resumeAt = pr.pos;

      const onMeta = function () {
        audio.removeEventListener('loadedmetadata', onMeta);
        if (resumeAt > 0 && audio.duration && resumeAt < audio.duration - 5) {
          audio.currentTime = resumeAt;
          ctx.toast('从 ' + fmtClock(resumeAt) + ' 继续');
        }
        audio.play().then(() => { pBtn.textContent = '\u23f8'; })
             .catch(() => { pBtn.textContent = '\u25b6'; });
      };
      audio.addEventListener('loadedmetadata', onMeta);

      // 记进播放队列（失败不影响播放）
      postJson('/api/xyz/queue', {
        item: {
          eid: e.eid, pid: e.pid, title: e.title,
          podcast: e.podcast, image: e.image,
          duration: e.duration, enclosure: e.enclosure,
        },
      }).catch(() => {});

      if (view !== 'ep') { view = 'ep'; paint(); }

      audio.load();
      setTimeout(function () {
        if (audio.paused && audio.readyState >= 2) {
          audio.removeEventListener('loadedmetadata', onMeta);
          if (resumeAt > 0 && audio.duration && resumeAt < audio.duration - 5) audio.currentTime = resumeAt;
          audio.play().then(() => { pBtn.textContent = '\u23f8'; })
               .catch(() => { pBtn.textContent = '\u25b6'; });
        }
      }, 1200);
    }

    pTitle.style.cursor = 'pointer';
    pTitle.title = '打开详情';
    pTitle.onclick = () => {
      if (!curEp) return;
      if (view !== 'ep') { backView = view; view = 'ep'; paint(); }
    };

    pBtn.onclick = () => {
      if (audio.paused) {
        audio.play()
          .then(() => { pBtn.textContent = '\u23f8'; })
          .catch(() => ctx.toast('播放被浏览器拦了，再点一下'));
      } else {
        audio.pause();
        pBtn.textContent = '\u25b6';
        saveProgress(true);
      }
    };

    audio.addEventListener('timeupdate', () => {
      const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
      pFill.style.width = pct + '%';
      pTime.textContent = fmtClock(audio.currentTime);
      if (epTick) epTick();          // 详情页的大进度条
      saveProgress(false);
    });
    audio.addEventListener('pause', () => saveProgress(true));
    audio.addEventListener('ended', () => { pBtn.textContent = '\u25b6'; saveProgress(true); });
    audio.addEventListener('error', () => { pBtn.textContent = '\u25b6'; });

    pBar.onclick = (ev) => {
      if (!audio.duration) return;
      const r = pBar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      audio.currentTime = ratio * audio.duration;
    };

    const obs = new MutationObserver(function () {
      if (!document.body.contains(root)) {
        alive = false;
        stopPoll();
        saveProgress(true);
        try { audio.pause(); audio.src = ''; } catch (e) { /* 忽略 */ }
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    root.innerHTML = '<div class="xz-empty">检查登录状态…</div>';
    (async () => {
      try {
        const st = await getJson('/api/xyz/status');
        view = st.loggedIn ? 'subs' : 'login';
        if (st.loggedIn) await loadProgress();
      } catch (e) {
        view = 'login';
      }
      if (alive) paint();
    })();
  },
});
