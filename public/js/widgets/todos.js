import { defineWidget } from '../registry.js';
import { el, uid, todayStr } from '../api.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];

function key(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 农历 / 节气 / 节日（lunar-javascript 全局注入；缺失时静默降级） */
function lunarInfo(y, m, d) {
  try {
    if (typeof window.Solar === 'undefined') return null;
    const solar = window.Solar.fromYmd(y, m, d);
    const lunar = solar.getLunar();
    const fest = solar.getFestivals().concat(lunar.getFestivals());
    if (fest.length) return { text: fest[0], cls: 'fest' };
    const jq = lunar.getJieQi();
    if (jq) return { text: jq, cls: 'jq' };
    if (lunar.getDay() === 1) return { text: lunar.getMonthInChinese() + '月', cls: 'first' };
    return { text: lunar.getDayInChinese(), cls: '' };
  } catch (e) {
    return null;
  }
}

/** 生成日期矩阵：优先 5 行，放不下自动 6 行 */
function matrix(year, month, weeks) {
  const startDay = new Date(year, month, 1).getDay();
  const dim = new Date(year, month + 1, 0).getDate();
  const prevDim = new Date(year, month, 0).getDate();
  const natural = Math.ceil((startDay + dim) / 7);
  // weeks 指定了就按它来（1-5），没指定沿用自动（至少 5 行）
  const rows = weeks
    ? Math.max(1, Math.min(5, Number(weeks) || natural))
    : Math.max(5, natural);
  const cells = [];
  for (let i = startDay - 1; i >= 0; i--) {
    cells.push({ d: new Date(year, month - 1, prevDim - i), other: true });
  }
  for (let i = 1; i <= dim; i++) cells.push({ d: new Date(year, month, i), other: false });
  let n = 1;
  while (cells.length < rows * 7) cells.push({ d: new Date(year, month + 1, n++), other: true });
  // 本月天数 + 上月余数可能已经超过 rows*7（weeks 少的时候尤其明显），要截断，
  // 否则多出来的格子会被挤成「隐式行」，把每行高度压扁。
  if (cells.length > rows * 7) cells.length = rows * 7;
  return { cells: cells, rows: rows };
}


/* 按格子的实际高度反算字号和行高 —— maxRows 条待办必须完整放得下。
 * 周数越少 → 格子越高 → 字号越大；maxRows 越多 → 每条越矮 → 字号越小。
 */
function fitCalendar(grid, maxRows) {
  if (!grid) return;
  const apply = function () {
    const cell = grid.querySelector('.cal-cell');
    if (!cell) return;
    const cellH = cell.clientHeight;
    // 布局没稳定时高度会很小（比如刚重绘的中间态），跳过这次
    if (!cellH || cellH < 40) return;

    const numRow = cell.querySelector('.cal-numrow');
    const numH = numRow ? numRow.offsetHeight : 16;
    const cs = getComputedStyle(cell);
    const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);

    // 底部要给「+」按钮留一条
    const addBtn = cell.querySelector('.cal-add');
    const addH = addBtn ? (addBtn.offsetHeight || 12) : 0;

    const listH = cellH - numH - padV - addH - 2;
    if (listH <= 0) return;

    // 条目之间有 2px 间距，算高度时要扣掉
    const GAP = 2;
    const avail = listH - GAP * (maxRows - 1);
    const itemH = Math.max(6, avail / maxRows);
    // 字号跟着每条的高度走，0.70 是留给行距的余量
    const fs = Math.max(7, Math.min(13.5, itemH * 0.70));

    const capped = Math.min(itemH, Math.max(8, listH));
    grid.style.setProperty('--cal-item-h', capped.toFixed(2) + 'px');
    grid.style.setProperty('--cal-fs', fs.toFixed(2) + 'px');
  };
  requestAnimationFrame(apply);
  setTimeout(apply, 90);      // 等卡片缩放/布局稳定后再算一次

  // 卡片被拖动缩放时，格子高度变了要重算（rAF 节流，避免抖动）
  if (grid.__ro) { try { grid.__ro.disconnect(); } catch (e) {} }
  if (typeof ResizeObserver === 'function') {
    let raf = 0;
    const ro = new ResizeObserver(function () {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; apply(); });
    });
    ro.observe(grid);
    grid.__ro = ro;
  }
}

/* ══════════════════════════════════════════════════════
   当天详情浮层：一天事多时看全、增、删、改
   ══════════════════════════════════════════════════════ */
function openDayModal(ctx, dateStr, onChange) {
  const overlay = el('div', 'day-overlay');
  const modal = el('div', 'day-modal');
  overlay.append(modal);
  document.body.append(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', esc);
    if (onChange) onChange();
  };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  function items() {
    return ctx.state.todos
      .filter((t) => t.date === dateStr)
      .sort((a, b) => (a.done - b.done) || (a.created - b.created));
  }

  function render() {
    modal.innerHTML = '';
    const d = new Date(dateStr + 'T00:00:00');
    const li = lunarInfo(d.getFullYear(), d.getMonth() + 1, d.getDate());
    const list = items();

    /* 头部 */
    const head = el('div', 'dm-head');
    head.append(el('div', 'dm-date', `${d.getMonth() + 1} 月 ${d.getDate()} 日`));
    const sub = el('div', 'dm-sub', `星期${WD[d.getDay()]}${li ? ' · ' + li.text : ''} · ${list.length} 条`);
    head.append(sub);
    const x = el('button', 'dm-close', '✕');
    x.onclick = close;
    head.append(x);

    /* 列表 */
    const box = el('div', 'dm-list');
    if (!list.length) {
      box.append(el('div', 'empty', '这天还没有事项\n在下面输入框添加'));
    }
    list.forEach((t) => {
      const row = el('div', 'dm-item' + (t.done ? ' done' : ''));
      const check = el('div', 'dm-check', '✓');
      const txt = el('div', 'dm-txt', t.text);
      const del = el('button', 'dm-del', '✕');
      del.title = '删除';

      check.onclick = (e) => {
        e.stopPropagation();
        t.done = !t.done;
        t.doneAt = t.done ? Date.now() : null;
        save();
      };
      del.onclick = (e) => {
        e.stopPropagation();
        ctx.state.todos = ctx.state.todos.filter((v) => v.id !== t.id);
        save();
      };
      txt.ondblclick = (e) => {
        e.stopPropagation();
        editInline(row, txt, t);
      };
      row.append(check, txt, del);
      box.append(row);
    });

    /* 底部输入 */
    const foot = el('div', 'dm-foot');
    const input = document.createElement('input');
    input.className = 'input';
    input.placeholder = '添加一条，回车保存';
    input.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const v = input.value.trim();
      if (!v) return;
      ctx.state.todos.push({ id: uid(), text: v, date: dateStr, done: false, created: Date.now() });
      input.value = '';
      save();
    };
    foot.append(input);

    modal.append(head, box, foot);
    setTimeout(() => input.focus(), 30);
  }

  function editInline(row, txt, t) {
    if (row.querySelector('.dm-edit')) return;
    const inp = document.createElement('input');
    inp.className = 'input dm-edit';
    inp.value = t.text;
    row.replaceChild(inp, txt);
    inp.focus();
    inp.select();
    const done = (commit) => {
      if (!inp.isConnected) return;
      if (commit) {
        const v = inp.value.trim();
        if (v) t.text = v;
        else ctx.state.todos = ctx.state.todos.filter((x) => x.id !== t.id);
      }
      save();
    };
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    };
    inp.onblur = () => done(true);
  }

  function save() {
    ctx.saveData('todos');
    ctx.refresh();
    render();
  }

  render();
}

defineWidget({
  type: 'todos',
  name: '待办 · 月历',
  size: { w: 1840, h: 620 },
  config: { ym: null },

  render(body, ctx) {
    const cfg = ctx.model.config || (ctx.model.config = {});
    const todos = ctx.state.todos;
    const today = todayStr();

    let year, month;
    if (cfg.ym) {
      const parts = String(cfg.ym).split('-').map(Number);
      year = parts[0]; month = parts[1] - 1;
    } else {
      const now = new Date();
      year = now.getFullYear(); month = now.getMonth();
    }
    const ymKey = `${year}-${String(month + 1).padStart(2, '0')}`;

    const byDate = new Map();
    todos.forEach((t) => {
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date).push(t);
    });
    byDate.forEach((arr) => arr.sort((a, b) => (a.done - b.done) || (a.created - b.created)));

    const wrap = el('div', 'cal-wrap');
    body.append(wrap);

    /* ── 顶部工具栏 ── */
    const head = el('div', 'cal-head');
    const prev = el('button', 'btn cal-nav', '‹');
    const next = el('button', 'btn cal-nav', '›');
    const title = el('div', 'cal-title', `${year} 年 ${month + 1} 月`);
    const todayBtn = el('button', 'btn', '今天');

    const monthTodos = todos.filter((t) => String(t.date).startsWith(ymKey));
    const undone = monthTodos.filter((t) => !t.done).length;
    const stat = el('div', 'cal-stat', `本月 ${monthTodos.length} 条 · 未完成 ${undone}`);

    const go = (dy) => {
      const d = new Date(year, month + dy, 1);
      cfg.ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      ctx.setConfig({ ym: cfg.ym });
      ctx.refresh();
    };
    prev.onclick = () => go(-1);
    next.onclick = () => go(1);
    todayBtn.onclick = () => {
      const d = new Date();
      cfg.ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      ctx.setConfig({ ym: cfg.ym });
      ctx.refresh();
    };

    const spacer = el('div', 'cal-spacer');
    head.append(prev, title, next, todayBtn, spacer, stat);

    /* ── 星期表头 ── */
    const week = el('div', 'cal-week');
    WD.forEach((w, i) => {
      week.append(el('div', 'cal-wd' + (i === 0 || i === 6 ? ' weekend' : ''), w));
    });

    /* ── 网格 ── */
    // 日历设置：每格几条待办（1-8）+ 显示几周（1-5）
    const calCfg = (ctx.state.settings && ctx.state.settings.calendar) || {};
    const maxRows = Math.max(1, Math.min(8, Number(calCfg.maxRows) || 3));
    const weeks = Math.max(1, Math.min(5, Number(calCfg.weeks) || 5));

    const grid = el('div', 'cal-grid');
    const mx = matrix(year, month, weeks);
    // 必须用 minmax(0, 1fr)：纯 1fr 在 flex 子项里会退化成内容高度（格子只有几像素）
    grid.style.gridTemplateRows = 'repeat(' + mx.rows + ', minmax(0, 1fr))';
    grid.style.setProperty('--cal-fs-scale', '1');

    mx.cells.forEach(({ d, other }) => {
      const ds = key(d);
      const items = byDate.get(ds) || [];
      const cell = el('div', 'cal-cell' + (other ? ' other' : '') + (ds === today ? ' today' : ''));
      cell.dataset.date = ds;

      const numRow = el('div', 'cal-numrow');
      numRow.append(el('div', 'cal-num', String(d.getDate())));
      const li = lunarInfo(d.getFullYear(), d.getMonth() + 1, d.getDate());
      if (li) numRow.append(el('div', 'cal-lunar' + (li.cls ? ' ' + li.cls : ''), li.text));
      if (items.length) {
        const badge = el('div', 'cal-badge', String(items.length));
        badge.title = '查看当天全部 ' + items.length + ' 条';
        badge.style.cursor = 'pointer';
        badge.onclick = (e) => {
          e.stopPropagation();
          openDayModal(ctx, ds, function () { ctx.refresh(); });
        };
        numRow.append(badge);
      }
      cell.append(numRow);

      const listBox = el('div', 'cal-items');
      items.slice(0, maxRows).forEach((t) => {
        const it = el('div', 'cal-item' + (t.done ? ' done' : ''));
        const span = el('span', 'cal-item-txt', t.text);
        const del = el('button', 'cal-del', '✕');
        del.title = '删除这一条';
        it.append(span, del);

        let clickTimer = null;
        it.onclick = (e) => {
          if (e.target.closest('.cal-del')) return;
          e.stopPropagation();
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
          clickTimer = setTimeout(() => {
            clickTimer = null;
            t.done = !t.done;
            t.doneAt = t.done ? Date.now() : null;
            ctx.saveData('todos');
            ctx.refresh();
          }, 230);
        };
        it.ondblclick = (e) => {
          e.stopPropagation();
          if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
          startEdit(cell, ds, t);
        };
        // 小 × ：直接删除，不划线
        del.onclick = (e) => {
          e.stopPropagation();
          ctx.state.todos = ctx.state.todos.filter((x) => x.id !== t.id);
          ctx.saveData('todos');
          ctx.refresh();
        };
        listBox.append(it);
      });
      cell.append(listBox);

      // 右下角 + 按钮
      const addBtn = el('button', 'cal-add', '+');
      addBtn.title = '添加事项';
      addBtn.onclick = (e) => {
        e.stopPropagation();
        startEdit(cell, ds, null);
      };
      cell.append(addBtn);

      /* 单击空白 → 打开当天详情；双击仍可直接新建 */
      let cellTimer = null;
      cell.onclick = (e) => {
        if (e.target.closest('.cal-item') || e.target.closest('.cal-add') || e.target.closest('.cal-editor')) return;
        if (cellTimer) { clearTimeout(cellTimer); cellTimer = null; return; }
        cellTimer = setTimeout(() => {
          cellTimer = null;
          openDayModal(ctx, ds, () => ctx.refresh());
        }, 240);
      };
      cell.ondblclick = (e) => {
        if (e.target.closest('.cal-item') || e.target.closest('.cal-add') || e.target.closest('.cal-editor')) return;
        if (cellTimer) { clearTimeout(cellTimer); cellTimer = null; }
        startEdit(cell, ds, null);
      };

      grid.append(cell);
    });

    wrap.append(head, week, grid);
    fitCalendar(grid, maxRows);

    /* ── 就地编辑 ── */
    function startEdit(cell, ds, item) {
      if (cell.querySelector('.cal-editor')) return;
      const box = el('div', 'cal-editor');
      const input = document.createElement('input');
      input.className = 'cal-input';
      input.placeholder = '回车保存';
      input.value = item ? item.text : '';
      box.append(input);
      cell.append(box);
      setTimeout(() => input.focus(), 20);

      let closed = false;
      const commit = () => {
        if (closed) return;
        closed = true;
        const text = input.value.trim();
        if (!text) {
          if (item) {
            ctx.state.todos = ctx.state.todos.filter((x) => x.id !== item.id);
            ctx.saveData('todos');
          }
          ctx.refresh();
          return;
        }
        if (item) item.text = text;
        else ctx.state.todos.push({ id: uid(), text, date: ds, done: false, created: Date.now() });
        ctx.saveData('todos');
        ctx.refresh();
      };
      const cancel = () => {
        if (closed) return;
        closed = true;
        ctx.refresh();
      };

      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      };
      input.onblur = () => commit();
      box.onclick = (e) => e.stopPropagation();
      box.ondblclick = (e) => e.stopPropagation();
    }
  },
});
