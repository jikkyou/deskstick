import { api, uid, el } from './api.js';
import { registry, widgetDefs } from './registry.js';
import { openSettings, applyTypography } from './settings-panel.js';

// 组件模块（import 即完成注册）—— 加新组件在这里加一行
import './widgets/notes.js';
import './widgets/todos.js';
import './widgets/clock.js';
import './widgets/files.js';
import './widgets/progress.js';
import './widgets/stocks.js';
import './widgets/xyz.js';
import './widgets/xueqiu.js';

const stage = document.getElementById('stage');
const addMenu = document.getElementById('addMenu');
const toastBox = document.getElementById('toast');

let state = { layout: { widgets: [] }, notes: [], todos: [], progress: [], settings: {}, stocks: { list: [], refreshSec: 5 }, fsRoots: [], roots: [] };
const live = new Map(); // id -> { model, node, def }
let zCounter = 10;
let saveTimer = null;

/* ───────────── 工具 ───────────── */

function toast(msg, ms = 1800) {
  toastBox.textContent = msg;
  toastBox.hidden = false;
  clearTimeout(toastBox._t);
  toastBox._t = setTimeout(() => (toastBox.hidden = true), ms);
}

function scheduleSave(key = 'layout', delay = 700) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const payload = key === 'layout'
        ? {
            widgets: state.layout.widgets,
            viewportW: state.layout.viewportW,
            viewportH: state.layout.viewportH,
          }
        : state[key];
      await api.save(key, payload);
      return true;
    } catch (e) {
      toast('保存失败：' + e.message);
    }
  }, delay);
}

async function saveLayoutNow() {
  clearTimeout(saveTimer);
  try {
    await api.save('layout', { widgets: state.layout.widgets });
    const [notes, todos, progress] = [state.notes, state.todos, state.progress];
    await Promise.all([api.save('notes', notes), api.save('todos', todos), api.save('progress', progress)]);
    toast('已保存');
  } catch (e) {
    toast('保存失败：' + e.message);
  }
}


/* ───────────── 背景配色 ───────────── */
const PRESETS = [
  { name: '深蓝', h: 220, s: 27, l: 6 },
  { name: '纯黑', h: 220, s: 10, l: 3 },
  { name: '深紫', h: 268, s: 30, l: 7 },
  { name: '墨绿', h: 158, s: 26, l: 5 },
  { name: '深青', h: 192, s: 34, l: 6 },
  { name: '深棕', h: 28, s: 22, l: 7 },
  { name: '酒红', h: 352, s: 26, l: 7 },
  { name: '石墨', h: 210, s: 5, l: 10 },
];

let theme = Object.assign({}, PRESETS[0]);

function applyTheme(t) {
  theme = Object.assign({}, t);
  const root = document.documentElement;
  root.style.setProperty('--bg-h', String(theme.h));
  root.style.setProperty('--bg-s', theme.s + '%');
  root.style.setProperty('--bg-l', theme.l + '%');
}

function saveTheme() {
  state.settings = state.settings || {};
  state.settings.theme = theme;
  scheduleSave('settings');
}

function buildThemePanel() {
  const panel = document.getElementById('themePanel');
  const sw = document.getElementById('tpSwatches');
  const light = document.getElementById('tpLight');
  if (!panel || !sw) return;

  sw.innerHTML = '';
  PRESETS.forEach(function (p) {
    const b = document.createElement('button');
    b.className = 'tp-swatch';
    b.title = p.name;
    b.style.background = 'hsl(' + p.h + ',' + Math.min(55, p.s + 8) + '%,' + Math.max(12, p.l + 11) + '%)';
    b.onclick = function () {
      applyTheme(p);
      light.value = String(p.l);
      markActive();
      saveTheme();
    };
    b.dataset.h = String(p.h);
    b.dataset.s = String(p.s);
    b.dataset.l = String(p.l);
    sw.appendChild(b);
  });

  function markActive() {
    const kids = sw.children;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      const on = Number(k.dataset.h) === theme.h && Number(k.dataset.s) === theme.s;
      k.classList.toggle('on', on);
    }
  }

  light.oninput = function () {
    const l = Number(light.value);
    theme = Object.assign({}, theme, { l: l });
    applyTheme(theme);
    saveTheme();
  };

  const btn = document.getElementById('btnTheme');
  btn.onclick = function (e) {
    e.stopPropagation();
    const r = btn.getBoundingClientRect();
    panel.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
    panel.style.top = r.bottom + 8 + 'px';
    panel.hidden = !panel.hidden;
    markActive();
  };

  document.addEventListener('click', function (e) {
    if (!panel.hidden && !panel.contains(e.target) && e.target.id !== 'btnTheme') panel.hidden = true;
  });

  markActive();
}



/* 拖动吸附：优先对齐其他组件的边缘 / 间距，其次落 8px 网格 */

/* ─── 拖动/缩放结束后整理：同行均分间距 + 高度对齐 ───────────────
 * 规则：
 *   - 高度差 ≤ 40px 视为「本来就想一样高」，统一到最高的那个；
 *     差超过 40 说明是刻意调高（比如月历），保持不动。
 *   - 横向间距差 > 2px 就重排成等距，只在间距本身合理（-5 ~ 80）时动手，
 *     免得把故意叠在一起的卡片硬拉开。
 *   - 只在拖动结束时跑一次，拖的过程中仍然是 snapPos 的实时吸附。
 */
function normalizeLayout() {
  const ws = state.layout.widgets;
  if (!ws || ws.length < 2) return false;

  // 1) 按 y 分行：纵坐标差不到 24px 算同一行
  const rows = [];
  ws.slice().sort((a, b) => a.y - b.y).forEach(function (w) {
    const row = rows.find(function (r) { return Math.abs(r[0].y - w.y) < 24; });
    if (row) row.push(w);
    else rows.push([w]);
  });

  let changed = false;
  const H_TOL = 40;      // 高度对齐阈值
  const GAP_MIN = -5;    // 间距下界（允许轻微重叠）
  const GAP_MAX = 80;    // 间距上界（超过说明本来就没打算排一行）

  rows.forEach(function (row) {
    if (row.length < 2) return;
    row.sort(function (a, b) { return a.x - b.x; });

    // 2) 高度对齐
    const hs = row.map(function (w) { return w.h; });
    const maxH = Math.max.apply(null, hs);
    const minH = Math.min.apply(null, hs);
    if (maxH !== minH && maxH - minH <= H_TOL) {
      row.forEach(function (w) {
        if (w.h !== maxH) { w.h = maxH; changed = true; }
      });
    }

    // 3) 间距均分
    const n = row.length;
    const left = row[0].x;
    const last = row[n - 1];
    const right = last.x + last.w;
    const sumW = row.reduce(function (s2, w) { return s2 + w.w; }, 0);
    const gap = (right - left - sumW) / (n - 1);

    if (gap >= GAP_MIN && gap <= GAP_MAX) {
      let cx = left;
      row.forEach(function (w) {
        const nx = Math.round(cx);
        if (w.x !== nx) { w.x = nx; changed = true; }
        cx += w.w + gap;
      });
    }

    // 4) 同一行 y 也对齐到最上面那个
    const top = Math.min.apply(null, row.map(function (w) { return w.y; }));
    row.forEach(function (w) {
      if (w.y !== top) { w.y = top; changed = true; }
    });
  });

  if (!changed) return false;

  // 写回 DOM
  ws.forEach(function (w) {
    const r = live.get(w.id);
    if (!r) return;
    r.model.x = w.x; r.model.y = w.y; r.model.w = w.w; r.model.h = w.h;
    r.node.style.left = w.x + 'px';
    r.node.style.top = w.y + 'px';
    r.node.style.width = w.w + 'px';
    r.node.style.height = w.h + 'px';
    if (r.renderBody) r.renderBody();
  });
  scheduleSave();
  return true;
}

function snapPos(x, y, w, h, selfId) {
  const GRID = 8, GAP = 20, TOL = 10;
  const others = state.layout.widgets.filter(function (o) { return o.id !== selfId; });

  let sx = Math.round(x / GRID) * GRID;
  let sy = Math.round(y / GRID) * GRID;

  let bestDx = TOL + 1, bestX = null;
  let bestDy = TOL + 1, bestY = null;

  const tryX = function (c) {
    if (c === null || c === undefined) return;
    const d = Math.abs(x - c);
    if (d < bestDx) { bestDx = d; bestX = c; }
  };
  const tryY = function (c) {
    if (c === null || c === undefined) return;
    const d = Math.abs(y - c);
    if (d < bestDy) { bestDy = d; bestY = c; }
  };

  others.forEach(function (o) {
    // ── 横向：贴边 / 留缝 / 对齐 ──
    tryX(o.x);                       // 左边对齐
    tryX(o.x + o.w + GAP);           // 贴它右边，留标准缝
    tryX(o.x - w - GAP);             // 贴它左边，留标准缝
    tryX(o.x + o.w - w);             // 右边对齐

    // ── 纵向 ──
    tryY(o.y);
    tryY(o.y + o.h + GAP);
    tryY(o.y - h - GAP);
    tryY(o.y + o.h - h);
  });

  // ── 等间距吸附：插到两个卡片中间时，左右两缝一样宽 ──
  const byX = others.slice().sort(function (a, b) { return a.x - b.x; });
  for (let i = 0; i < byX.length - 1; i++) {
    const a = byX[i], b = byX[i + 1];
    const span = b.x - (a.x + a.w);        // 两张之间的可用宽度
    if (span <= w) continue;               // 塞不进去
    const ideal = a.x + a.w + (span - w) / 2;
    tryX(Math.round(ideal));
  }

  // ── 等间距吸附（纵向）：上下两张之间居中 ──
  const byY = others.slice().sort(function (a, b) { return a.y - b.y; });
  for (let i = 0; i < byY.length - 1; i++) {
    const a = byY[i], b = byY[i + 1];
    const span = b.y - (a.y + a.h);
    if (span <= h) continue;
    const ideal = a.y + a.h + (span - h) / 2;
    tryY(Math.round(ideal));
  }

  // 画布边距
  tryX(40);
  tryX(window.innerWidth - 40 - w);
  tryY(52);
  tryY(window.innerHeight - 40 - h);

  if (bestX !== null && bestDx <= TOL) sx = Math.round(bestX);
  if (bestY !== null && bestDy <= TOL) sy = Math.round(bestY);
  return { x: sx, y: sy };
}

/* 画布自适应：窗口比布局小时整体等比缩小，保证内容完整可见 */
function uiZoom() {
  // 界面缩放倍数：auto = 跟着屏幕宽度走（1920 为设计基准）
  const mode = (state.settings && state.settings.uiScale) || 'auto';
  if (mode !== 'auto') {
    const v = parseFloat(mode);
    if (isFinite(v) && v > 0) return v;
  }
  const raw = window.innerWidth / 1920;
  return Math.max(0.6, Math.min(2.4, raw));
}

function fitStage() {
  const z = uiZoom();
  stage.style.transform = '';
  stage.style.transformOrigin = 'top left';
  // zoom 让 Chromium 原生重排，文字按目标尺寸光栅化；transform:scale 是位图放大，会发虚
  stage.style.zoom = Math.abs(z - 1) < 0.005 ? '' : String(Math.round(z * 1000) / 1000);
  stage.dataset.fit = z.toFixed(4);
}


/* ── 画布边缘：编辑模式下显示轮廓 + 三个拖拽手柄（改的是宿主窗口大小）── */
function postHost(obj) {
  try {
    if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(obj);
  } catch (e) { /* 浏览器里没有宿主，忽略 */ }
}

function onHandleDown(e) {
  if (!document.body.classList.contains('editing')) return;
  e.preventDefault();
  e.stopPropagation();
  const dir = e.currentTarget.dataset.dir;
  const sx = e.clientX, sy = e.clientY;

  window.__resizing = true;            // 拖角过程中抑制自动重排
  postHost({ resizeStart: true, dir: dir });

  const onMove = (ev) => {
    postHost({
      resizeMove: true,
      dx: Math.round(ev.clientX - sx),
      dy: Math.round(ev.clientY - sy),
    });
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    window.__resizing = false;
    fitStage();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function buildStageHandles() {
  // 挂到 body 而不是 stage：stage 带 transform:scale()，手柄会被一起缩放，
  // 窗口非满屏时手柄跑到画面中间，抓不到真正的窗口角
  const outline = el('div', 'stage-outline');
  document.body.append(outline);
  const dirs = [['sh-tl', 'nw'], ['sh-tr', 'ne'], ['sh-br', 'se'], ['sh-bl', 'sw']];
  dirs.forEach(function (d) {
    const n = el('div', 'sh ' + d[0]);
    n.dataset.dir = d[1];
    n.addEventListener('mousedown', onHandleDown);
    document.body.append(n);
  });
}

/* ───────────── 卡片 ───────────── */

function makeCtx(r) {
  const cleanups = [];
  return {
    model: r.model,
    state,
    api,
    toast,
    refresh: () => r.renderBody(),
    setConfig: (patch) => {
      r.model.config = { ...(r.model.config || {}), ...patch };
      scheduleSave();
    },
    saveData: (key) => scheduleSave(key),
    // 直接存一类数据（如 stocks），立即落盘
    save: (key, value) => {
      const p = api.save(key, value);
      p.catch((e) => toast('保存失败：' + e.message));
      return p;
    },
    // 组件卸载/重建时清理定时器、事件监听
    onDestroy: (fn) => { if (typeof fn === 'function') cleanups.push(fn); },
    _cleanups: cleanups,
  };
}

function mount(model) {
  const def = registry.get(model.type);
  if (!def) { console.warn('未知组件类型', model.type); return; }

  const node = el('div', 'widget');
  node.dataset.id = model.id;
  node.style.left = (model.x ?? 40) + 'px';
  node.style.top = (model.y ?? 40) + 'px';
  node.style.width = (model.w ?? def.size.w) + 'px';
  node.style.height = (model.h ?? def.size.h) + 'px';
  node.style.opacity = model.opacity ?? 1;
  node.style.zIndex = model.z ?? ++zCounter;

  const head = el('div', 'w-head');
  const title = el('span', 'w-title', def.name);
  const tools = el('div', 'w-tools');

  const btnDel = el('button', 'w-btn danger', '✕');
  btnDel.title = '移除组件';
  btnDel.onclick = (e) => {
    e.stopPropagation();
    if (activeCtx && activeCtx._cleanups) {
      activeCtx._cleanups.forEach((fn) => { try { fn(); } catch (err) {} });
    }
    node.remove();
    state.layout.widgets = state.layout.widgets.filter((w) => w.id !== model.id);
    live.delete(model.id);
    scheduleSave();
  };
  tools.append(btnDel);
  head.append(title, tools);

  const body = el('div', 'w-body');
  const bar = el('div', 'opacity-bar');
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0.15';
  range.max = '1';
  range.step = '0.05';
  range.value = String(model.opacity ?? 1);
  const label = el('span', '', Math.round((model.opacity ?? 1) * 100) + '%');
  range.oninput = () => {
    model.opacity = Number(range.value);
    node.style.opacity = model.opacity;
    label.textContent = Math.round(model.opacity * 100) + '%';
  };
  range.onchange = () => scheduleSave();
  bar.append(range, label);

  const resizerBR = el('div', 'resize-h resize-br');
  const resizerTL = el('div', 'resize-h resize-tl');

  node.append(head, body, bar, resizerBR, resizerTL);
  stage.append(node);

  const r = { model, node, def, renderBody: null };
  let activeCtx = null;
  r.renderBody = () => {
    if (activeCtx && activeCtx._cleanups) {
      activeCtx._cleanups.forEach((fn) => { try { fn(); } catch (e) {} });
    }
    body.innerHTML = '';
    activeCtx = makeCtx(r);
    try {
      def.render(body, activeCtx);
    } catch (e) {
      console.error(e);
      body.append(el('div', 'empty', '组件渲染出错：' + e.message));
    }
  };
  r.renderBody();

  bindDragResize(r);
  live.set(model.id, r);

  // 非编辑模式下点击置顶
  node.addEventListener('mousedown', () => {
    if (document.body.classList.contains('editing')) return;
    model.z = ++zCounter;
    node.style.zIndex = model.z;
  });

  return r;
}

function bindDragResize(r) {
  const { node, model } = r;
  node.addEventListener('mousedown', (e) => {
    if (!document.body.classList.contains('editing')) return;
    const onHead = e.target.closest('.w-head');
    const onBR = e.target.closest('.resize-br');
    const onTL = e.target.closest('.resize-tl');
    const onResize = onBR || onTL;
    if (!onHead && !onResize) return;
    if (e.target.closest('.w-btn')) return;
    e.preventDefault();

    const sx = e.clientX, sy = e.clientY;
    const ox = model.x, oy = model.y, ow = model.w, oh = model.h;
    node.classList.add('dragging');

    const onMove = (ev) => {
      // 画布可能被 scale 缩放，鼠标位移要换算回布局坐标
      const fit = parseFloat(stage.dataset.fit) || 1;
      const dx = (ev.clientX - sx) / fit, dy = (ev.clientY - sy) / fit;
      if (onTL) {
        // 左上角：往右下拖是缩小，左上角跟着走
        const nw = Math.max(200, Math.round(ow - dx));
        const nh = Math.max(140, Math.round(oh - dy));
        model.w = nw;
        model.h = nh;
        model.x = Math.round(ox + (ow - nw));
        model.y = Math.round(oy + (oh - nh));
        node.style.left = model.x + 'px';
        node.style.top = model.y + 'px';
        node.style.width = nw + 'px';
        node.style.height = nh + 'px';
      } else if (onResize) {
        model.w = Math.max(200, Math.round(ow + dx));
        model.h = Math.max(140, Math.round(oh + dy));
        node.style.width = model.w + 'px';
        node.style.height = model.h + 'px';
      } else {
        const sp = snapPos(ox + dx, oy + dy, model.w, model.h, model.id);
        model.x = Math.max(-40, Math.min(window.innerWidth - 90, sp.x));
        model.y = Math.max(0, Math.min(window.innerHeight - 50, sp.y));
        node.style.left = model.x + 'px';
        node.style.top = model.y + 'px';
      }
    };
    const onUp = () => {
      node.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // 松手后整理一次：同行等距 + 高度对齐（阈值内）
      const tid = setTimeout(function () {
        if (normalizeLayout()) toast('已对齐');
        fitStage();
      }, 60);
      scheduleSave();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}


/* 按当前视口重新排布：月历占上方，四个小组件在下面一排 */
function relayout(silent) {
  const ws = state.layout.widgets;
  if (!ws.length) return;
  const m = 40, gap = 20, top = 52;
  // 逻辑视口：stage 带 zoom，内部可用空间是物理尺寸除以缩放倍数
  const z = uiZoom();
  const vw = Math.round(window.innerWidth / z);
  const vh = Math.round(window.innerHeight / z);
  const bottomH = Math.max(240, Math.round((vh - top - m) * 0.42));
  const calH = vh - top - m - gap - bottomH;

  ws.forEach(function (w) {
    if (w.type === 'todos') {
      w.x = m; w.y = top; w.w = vw - m * 2; w.h = calH;
    }
  });

  // 底部按「实际有几个卡片」平分，不要写死 4 列
  const smalls = ws.filter(function (w) { return w.type !== 'todos'; });
  const cols = Math.max(1, smalls.length);
  const cw = Math.round((vw - m * 2 - gap * (cols - 1)) / cols);
  smalls.forEach(function (w, i) {
    w.x = m + i * (cw + gap);
    w.y = top + calH + gap;
    w.w = cw;
    w.h = bottomH;
  });

  // 应用到 DOM
  ws.forEach(function (w) {
    const r = live.get(w.id);
    if (!r) return;
    const n = r.node;
    n.style.left = w.x + 'px';
    n.style.top = w.y + 'px';
    n.style.width = w.w + 'px';
    n.style.height = w.h + 'px';
    r.model.x = w.x; r.model.y = w.y; r.model.w = w.w; r.model.h = w.h;
    r.renderBody();
  });

  state.layout.viewportW = window.innerWidth;
  state.layout.viewportH = window.innerHeight;
  scheduleSave();
  fitStage();
  if (!silent) toast('已按 ' + vw + '×' + vh + ' 重排');
}

/* ───────────── 添加组件 ───────────── */

function showAddMenu(anchor) {
  addMenu.innerHTML = '';
  widgetDefs().forEach((def) => {
    const b = el('button', '', def.name);
    b.onclick = () => {
      addMenu.hidden = true;
      addWidget(def.type);
    };
    addMenu.append(b);
  });
  const rect = anchor.getBoundingClientRect();
  addMenu.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
  addMenu.style.top = rect.bottom + 8 + 'px';
  addMenu.hidden = false;
}

/* 在画布上找一个不与现有组件重叠的位置（8px 步长扫描） */
function findFreeSpot(w, h) {
  const M = 40, STEP = 8;
  const vw = window.innerWidth, vh = window.innerHeight;
  const boxes = state.layout.widgets.map(function (x) {
    return { x: x.x || 0, y: x.y || 0, w: x.w || 0, h: x.h || 0 };
  });
  function hit(bx, by) {
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (bx < b.x + b.w && bx + w > b.x && by < b.y + b.h && by + h > b.y) return true;
    }
    return false;
  }
  for (let y = M; y + h <= vh - M; y += STEP) {
    for (let x = M; x + w <= vw - M; x += STEP) {
      if (!hit(x, y)) return { x: x, y: y, overflow: false };
    }
  }
  return { x: Math.max(M, vw - w - M), y: Math.max(M, vh - h - M), overflow: true };
}

function addWidget(type, cfg) {
  const def = registry.get(type);
  if (!def) return;
  const spot = findFreeSpot(def.size.w, def.size.h);
  const model = {
    id: uid(),
    type,
    x: spot.x,
    y: spot.y,
    w: def.size.w,
    h: def.size.h,
    opacity: 1,
    z: ++zCounter,
    config: { ...(def.config || {}), ...(cfg || {}) },
  };
  state.layout.widgets.push(model);
  mount(model);
  scheduleSave();
  if (spot.overflow) toast('画布已经排满了，新组件放在右下角，拖一下调整位置', 4000);
  return model;
}

/* ───────────── 启动 ───────────── */



function seedIfEmpty() {
  if (state.layout.widgets.length) return;
  // 按视口算三列网格，铺满 1920×1080
  const m = 40, gap = 20, top = 62, cols = 3;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cw = Math.round((vw - m * 2 - gap * (cols - 1)) / cols);
  const usable = vh - top - m;
  const X = (c) => m + c * (cw + gap);
  const seeds = [
    // [type, col, yOffset, w, h]
    ['clock',    0, 0,   cw, 210],
    ['notes',    0, 230, cw, usable - 230],
    ['todos',    1, 0,   cw, 520],
    ['progress', 1, 540, cw, Math.max(240, usable - 540)],
    ['files',    2, 0,   cw, usable],
  ];
  seeds.forEach(([type, col, dy, w, h]) => {
    if (!registry.has(type)) return;
    state.layout.widgets.push({
      id: uid(), type, x: X(col), y: top + dy, w, h, opacity: 1, z: ++zCounter,
      config: JSON.parse(JSON.stringify(registry.get(type).config || {})),
    });
  });
  scheduleSave('layout', 300);
}

async function boot() {
  let rsTimer = null;

  window.addEventListener('resize', function () {
    if (window.__resizing) return;        // 正在拖角：等松手再重排
    clearTimeout(rsTimer);
    rsTimer = setTimeout(function () { relayout(true); }, 380);
  });

  try {
    state = await api.state();
  } catch (e) {
    toast('连不上本地服务：' + e.message, 5000);
  }
  if (!state.layout) state.layout = { widgets: [] };
  if (!Array.isArray(state.layout.widgets)) state.layout.widgets = [];
  state.layout.widgets = state.layout.widgets.filter((w) => registry.has(w.type));

  if (state.settings && state.settings.theme) applyTheme(state.settings.theme);
  if (state.settings && state.settings.type) applyTypography(state.settings.type);
  seedIfEmpty();
  buildThemePanel();
  buildStageHandles();
  postHost({ editing: false });
  fitStage();
  state.layout.widgets.forEach((m) => {
    if (m.z > zCounter) zCounter = m.z;
    mount(m);
  });

  // 记录的视口和当前对不上（换了屏/改了分辨率）→ 自动按当前屏幕重排一次
  // 必须放在 mount 之后：relayout 要靠 live 里的卡片节点，早于 mount 只会改 model 不动 DOM
  const savedW = state.layout.viewportW, savedH = state.layout.viewportH;
  const sizeChanged =
    (savedW && Math.abs(savedW - window.innerWidth) > 40) ||
    (savedH && Math.abs(savedH - window.innerHeight) > 40);
  if (sizeChanged) {
    relayout(true);
  } else {
    fitStage();
  }

  const openSettingsPanel = function () {
    openSettings({
      settings: state.settings || {},
      api: api,
      toast: toast,
      onSaved: function (next, previewOnly) {
        // 只有「界面缩放」变了才需要重排整个桌面；
        // 改字体/颜色/月历行数这些，绝不能动卡片位置。
        const scaleChanged = String(state.settings.uiScale || 'auto') !== String(next.uiScale || 'auto');
        state.settings = next;
        // 让改了外观/行数设置的组件立刻重画
        live.forEach(function (r) { if (r.renderBody) r.renderBody(); });
        fitStage();
        if (scaleChanged) relayout(true);
      },
    });
  };
  window.__wsOpenSettings = openSettingsPanel;   // 托盘菜单通过 ExecuteScriptAsync 调这个

  const btnSettings = document.getElementById('btnSettings');
  if (btnSettings) btnSettings.onclick = openSettingsPanel;

  document.getElementById('btnRelayout').onclick = function () { relayout(false); };
  document.getElementById('btnAdd').onclick = (e) => {
    // 必须拦截冒泡：否则同一个 click 冒到 document 上，
    // 被「点空白处关闭菜单」的监听判成外部点击，菜单刚弹出就被关掉
    e.stopPropagation();
    showAddMenu(e.currentTarget);
  };
  document.getElementById('btnEdit').onclick = (e) => {
    const on = document.body.classList.toggle('editing');
    postHost({ editing: on });
    e.currentTarget.classList.toggle('on', on);
    e.currentTarget.textContent = on ? '完成' : '编辑';
    // 编辑模式下让组件重绘一次（有些组件在编辑态要禁用交互）
    live.forEach((r) => r.renderBody());
  };
  document.getElementById('btnSave').onclick = saveLayoutNow;

  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('#btnAdd')) return;
    if (!addMenu.hidden && !addMenu.contains(e.target)) addMenu.hidden = true;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') addMenu.hidden = true;
    if (e.key === 'e' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      document.getElementById('btnEdit').click();
    }
    if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveLayoutNow();
    }
  });

}

boot();

// 供调试
window.__ws = { get state() { return state; }, live: live };
