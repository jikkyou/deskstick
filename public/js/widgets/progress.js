import { defineWidget } from '../registry.js';
import { el, uid } from '../api.js';

const PALETTE = ['#5aa2ff', '#4dd4a0', '#ffb454', '#c084fc', '#ff7b8a', '#48d1e0'];

defineWidget({
  type: 'progress',
  name: '进度',
  size: { w: 380, h: 260 },

  render(body, ctx) {
    const items = ctx.state.progress;
    const wrap = el('div', 'prog-wrap');
    body.append(wrap);

    if (!items.length) {
      wrap.append(el('div', 'empty', '还没有进度项\n在下面加一个，比如「本月读书 3/8」'));
    }

    items.forEach((it, i) => {
      const item = el('div', 'prog-item');
      const top = el('div', 'prog-top');
      const label = el('div', 'prog-label', it.label);
      const val = el('div', 'prog-val', `${it.current} / ${it.target}${it.unit || ''}`);
      const actions = el('div', 'prog-actions');
      const minus = el('button', '', '−');
      const plus = el('button', '', '+');
      const del = el('button', '', '✕');
      minus.onclick = () => { it.current = Math.max(0, it.current - (it.step || 1)); ctx.saveData('progress'); ctx.refresh(); };
      plus.onclick = () => { it.current = Math.min(it.target, it.current + (it.step || 1)); ctx.saveData('progress'); ctx.refresh(); };
      del.onclick = () => {
        ctx.state.progress = ctx.state.progress.filter((x) => x.id !== it.id);
        ctx.saveData('progress');
        ctx.refresh();
      };
      actions.append(minus, plus, del);
      const right = el('div', 'prog-right');
      right.append(val, actions);
      top.append(label, right);

      const track = el('div', 'prog-track');
      const fill = el('div', 'prog-fill');
      const pct = it.target > 0 ? Math.max(0, Math.min(1, it.current / it.target)) : 0;
      fill.style.width = (pct * 100).toFixed(1) + '%';
      fill.style.background = it.color || PALETTE[i % PALETTE.length];
      if (pct >= 1) fill.style.boxShadow = '0 0 12px rgba(77,212,160,.55)';
      track.append(fill);

      item.append(top, track);
      wrap.append(item);
    });

    // 新增
    const adder = el('div', 'todo-add');
    const nameIn = document.createElement('input');
    nameIn.className = 'input';
    nameIn.placeholder = '名称';
    nameIn.style.flex = '1';
    const targetIn = document.createElement('input');
    targetIn.className = 'input';
    targetIn.type = 'number';
    targetIn.value = '100';
    targetIn.style.width = '64px';
    targetIn.style.flex = '0 0 auto';
    const addBtn = el('button', 'btn primary', '加');
    const commit = () => {
      const label = nameIn.value.trim();
      if (!label) return;
      ctx.state.progress.push({
        id: uid(), label,
        current: 0,
        target: Math.max(1, Number(targetIn.value) || 100),
        unit: '', step: 1,
        color: PALETTE[ctx.state.progress.length % PALETTE.length],
      });
      nameIn.value = '';
      ctx.saveData('progress');
      ctx.refresh();
    };
    addBtn.onclick = commit;
    nameIn.onkeydown = (e) => { if (e.key === 'Enter') commit(); };
    adder.append(nameIn, targetIn, addBtn);
    wrap.append(adder);
  },
});
