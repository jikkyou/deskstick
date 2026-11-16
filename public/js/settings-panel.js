/**
 * 设置面板：文字样式（中/英分开）、文字颜色、存储位置
 * 只调字体族与颜色，<b>不动字号与行高</b>——尺寸比例由版式统一控制，避免破坏现有排版。
 */
import { el } from './api.js';

const FONTS_CJK = [
  'Microsoft YaHei',       // 微软雅黑
  'Microsoft YaHei UI',    // 微软雅黑 UI
  'DengXian',              // 等线
  'Source Han Sans SC',    // 思源黑体
  'SimSun',                // 宋体
  'SimHei',                // 黑体
  'KaiTi',                 // 楷体
  'FangSong',              // 仿宋
];

const FONTS_LATIN = [
  'Segoe UI',
  'Segoe UI Variable Display',
  'Arial',
  'Tahoma',
  'Verdana',
  'Trebuchet MS',
  'Consolas',
  'Cascadia Code',
];

const LABEL_CJK = {
  'Microsoft YaHei': '微软雅黑',
  'Microsoft YaHei UI': '微软雅黑 UI',
  'DengXian': '等线',
  'Source Han Sans SC': '思源黑体',
  'SimSun': '宋体',
  'SimHei': '黑体',
  'KaiTi': '楷体',
  'FangSong': '仿宋',
};

const DEFAULTS = {
  fontCjk: 'Microsoft YaHei UI',
  fontLatin: 'Segoe UI',
  colorText: '#eef2f7',
  colorDim: '#b3bfd0',
};

export function applyTypography(t) {
  const v = Object.assign({}, DEFAULTS, t || {});
  const r = document.documentElement.style;
  r.setProperty('--font-cjk', '"' + v.fontCjk + '"');
  r.setProperty('--font-latin', '"' + v.fontLatin + '"');
  r.setProperty('--text', v.colorText);
  r.setProperty('--text-dim', v.colorDim);
}

let overlay = null;

export function openSettings(ctx) {
  // ctx = { settings, api, onSaved, toast }
  if (overlay) return;

  const cur = Object.assign({}, DEFAULTS, (ctx.settings && ctx.settings.type) || {});
  const draft = Object.assign({}, cur);
  const curCal = Object.assign({ maxRows: 3, weeks: 5 }, (ctx.settings && ctx.settings.calendar) || {});
  const draftCal = Object.assign({}, curCal);

  const ov = el('div', 'sp-overlay');
  const panel = el('div', 'sp-panel');

  const head = el('div', 'sp-head');
  head.append(el('div', 'sp-title', '设置'));
  const close = el('button', 'sp-close', '✕');
  close.onclick = () => destroy();
  head.append(close);

  const bodyEl = el('div', 'sp-body');

  /* ── 文字样式 ── */
  bodyEl.append(el('div', 'sp-group', '文字样式'));

  function fontRow(label, list, key, zhLabel) {
    const row = el('div', 'sp-row');
    row.append(el('div', 'sp-label', label));
    const sel = el('select', 'sp-select');
    list.forEach((f) => {
      const o = el('option', '', zhLabel ? (zhLabel[f] || f) : f);
      o.value = f;
      if (f === draft[key]) o.selected = true;
      sel.append(o);
    });
    sel.onchange = () => { draft[key] = sel.value; updatePreview(); };
    row.append(sel);
    return row;
  }

  bodyEl.append(fontRow('中文', FONTS_CJK, 'fontCjk', LABEL_CJK));
  bodyEl.append(fontRow('英文', FONTS_LATIN, 'fontLatin', null));

  // 字体预览块已移除
  function updatePreview() { /* 预览块已删除，保留空函数供字体/颜色选择器调用 */ }

  /* ── 文字颜色 ── */
  bodyEl.append(el('div', 'sp-group', '文字颜色'));

  function colorRow(label, key) {
    const row = el('div', 'sp-row');
    row.append(el('div', 'sp-label', label));
    const wrapC = el('div', 'sp-color');
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = draft[key];
    const hex = el('span', 'sp-hex', draft[key]);
    inp.oninput = () => { draft[key] = inp.value; hex.textContent = inp.value; updatePreview(); };
    wrapC.append(inp, hex);
    row.append(wrapC);
    return row;
  }

  bodyEl.append(colorRow('正文', 'colorText'));
  bodyEl.append(colorRow('次要文字', 'colorDim'));

  /* ── 待办 · 月历 ── */
  bodyEl.append(el('div', 'sp-group', '待办 · 月历'));

  const rowsRow = el('div', 'sp-row');
  rowsRow.append(el('div', 'sp-label', '每格行数'));
  const rowsSel = el('select', 'sp-select');
  for (let i = 1; i <= 8; i++) {
    const o = el('option', '', i + ' 行');
    o.value = String(i);
    if (i === draftCal.maxRows) o.selected = true;
    rowsSel.append(o);
  }
  rowsSel.onchange = function () { draftCal.maxRows = Number(rowsSel.value); };
  rowsRow.append(rowsSel);
  bodyEl.append(rowsRow);

  const weeksRow = el('div', 'sp-row');
  weeksRow.append(el('div', 'sp-label', '显示周数'));
  const weeksSel = el('select', 'sp-select');
  for (let i = 1; i <= 5; i++) {
    const o = el('option', '', i + ' 周');
    o.value = String(i);
    if (i === (draftCal.weeks || 5)) o.selected = true;
    weeksSel.append(o);
  }
  weeksSel.onchange = function () { draftCal.weeks = Number(weeksSel.value); };
  weeksRow.append(weeksSel);
  bodyEl.append(weeksRow);

  bodyEl.append(el('div', 'sp-note',
    '「每格行数」决定每天最多列几条待办，条数越多字越小；「显示周数」决定日历铺几行，行数越少每格越高、字也越大。两者都会按卡片实际高度自动算字号，保证每条都完整显示。'));

  /* ── 启动与运行 ── */
  bodyEl.append(el('div', 'sp-group', '启动与运行'));

  const autoRow = el('div', 'sp-row');
  autoRow.append(el('div', 'sp-label', '开机启动'));
  const swWrap = el('label', 'sp-switch');
  const swInput = document.createElement('input');
  swInput.type = 'checkbox';
  swInput.checked = false;
  swInput.disabled = true;
  const swSlider = el('span', 'sp-slider');
  swWrap.append(swInput, swSlider);
  const swNote = el('span', 'sp-switch-note', '读取中…');
  autoRow.append(swWrap, swNote);
  bodyEl.append(autoRow);

  let autoSupported = false;

  ctx.api.autostart().then((st) => {
    autoSupported = !!st.supported;
    if (!autoSupported) {
      swNote.textContent = '当前是网页版，没有可自启的程序';
      return;
    }
    swInput.disabled = false;
    swInput.checked = !!st.enabled;
    if (st.enabled && st.current && st.expected && st.current !== st.expected) {
      swNote.textContent = '保存后路径会更新为当前程序';
    } else {
      swNote.textContent = st.enabled ? '开机会自动启动' : '开机不启动';
    }
    swInput.onchange = () => {
      swNote.textContent = swInput.checked ? '开机会自动启动' : '开机不启动';
    };
  }).catch(() => { swNote.textContent = '读取失败'; });

  const scaleRow = el('div', 'sp-row');
  scaleRow.append(el('div', 'sp-label', '界面缩放'));
  const scaleSel = document.createElement('select');
  scaleSel.className = 'sp-select';
  [['auto', '自动（按屏幕）'], ['1', '100%'], ['1.25', '125%'], ['1.5', '150%'], ['2', '200%']]
    .forEach(function (pair) {
      const o = document.createElement('option');
      o.value = pair[0];
      o.textContent = pair[1];
      scaleSel.append(o);
    });
  scaleSel.value = (ctx.settings && ctx.settings.uiScale) || 'auto';
  scaleSel.onchange = function () {
    // 立刻预览
    const probe = Object.assign({}, ctx.settings || {}, { uiScale: scaleSel.value });
    ctx.onSaved && ctx.onSaved(probe, true);
  };
  scaleRow.append(scaleSel);
  bodyEl.append(scaleRow);
  bodyEl.append(el('div', 'sp-note',
    '「自动」按屏幕宽度折算：1920 宽为 100%，3840 宽会放大到 200%，字号和卡片一起变大。'));

  /* ── 存储位置 ── */
  bodyEl.append(el('div', 'sp-group', '存储位置'));

  const stRow = el('div', 'sp-row sp-row-col');
  stRow.append(el('div', 'sp-label', '数据目录'));
  const stPath = el('div', 'sp-path', '读取中…');
  const stBtn = el('button', 'sp-btn sp-btn-ghost sp-btn-sm', '打开目录');
  stBtn.onclick = () => {
    if (stPath.dataset.p) ctx.api.openPath(stPath.dataset.p).catch((e) => ctx.toast(e.message));
  };
  const stLine = el('div', 'sp-path-line');
  stLine.append(stPath, stBtn);
  stRow.append(stLine);
  const stNote = el('div', 'sp-note', '布局与各组件数据都是这个目录下的 JSON 文件，直接复制走就能备份。');
  stRow.append(stNote);
  bodyEl.append(stRow);

  ctx.api.appinfo().then((info) => {
    stPath.textContent = info.dataDir;
    stPath.dataset.p = info.dataDir;
    stPath.title = info.dataDir;
  }).catch(() => { stPath.textContent = '读取失败'; });

  /* ── 底部按钮 ── */
  const foot = el('div', 'sp-foot');
  const reset = el('button', 'sp-btn sp-btn-ghost', '恢复默认');
  const cancel = el('button', 'sp-btn sp-btn-ghost', '取消');
  const save = el('button', 'sp-btn sp-btn-primary', '保存');

  reset.onclick = () => {
    Object.assign(draft, DEFAULTS);
    applyTypography(draft);           // 实时预览
    // 回填控件
    bodyEl.querySelectorAll('select').forEach((sel, i) => {
      sel.value = i === 0 ? draft.fontCjk : draft.fontLatin;
    });
    bodyEl.querySelectorAll('input[type=color]').forEach((inp, i) => {
      inp.value = i === 0 ? draft.colorText : draft.colorDim;
      const h = inp.parentElement.querySelector('.sp-hex');
      if (h) h.textContent = inp.value;
    });
    updatePreview();
  };

  cancel.onclick = () => { applyTypography(cur); destroy(); };

  save.onclick = async () => {
    const next = Object.assign({}, ctx.settings || {});
    next.type = Object.assign({}, draft);
    next.calendar = Object.assign({}, draftCal);
    next.uiScale = scaleSel.value;
    try {
      await ctx.api.save('settings', next);
      applyTypography(next.type);
      ctx.onSaved && ctx.onSaved(next);
    } catch (e) {
      ctx.toast && ctx.toast('保存失败：' + e.message);
      return;
    }

    // 开机启动单独一个接口（写注册表）
    if (autoSupported) {
      try {
        await ctx.api.setAutostart(swInput.checked);
      } catch (e) {
        ctx.toast && ctx.toast('开机启动设置失败：' + e.message);
      }
    }

    ctx.toast && ctx.toast('设置已保存');
    destroy();
  };

  foot.append(reset, el('div', 'sp-spacer'), cancel, save);

  panel.append(head, bodyEl, foot);
  ov.append(panel);
  ov.onclick = (e) => { if (e.target === ov) { applyTypography(cur); destroy(); } };
  document.body.append(ov);
  overlay = ov;

  updatePreview();

  function destroy() {
    if (overlay) { overlay.remove(); overlay = null; }
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Escape') { applyTypography(cur); destroy(); }
  }
  document.addEventListener('keydown', onKey);
}
