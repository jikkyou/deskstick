import { defineWidget } from '../registry.js';
import { el } from '../api.js';

const ICON = {
  '.txt': '📄', '.md': '📝', '.log': '📜', '.json': '🧾', '.js': '🟨', '.ts': '🟦',
  '.css': '🎨', '.html': '🌐', '.pdf': '📕', '.doc': '📘', '.docx': '📘',
  '.xls': '📗', '.xlsx': '📗', '.ppt': '📙', '.pptx': '📙', '.zip': '🗜', '.rar': '🗜',
  '.7z': '🗜', '.png': '🖼', '.jpg': '🖼', '.jpeg': '🖼', '.gif': '🖼', '.webp': '🖼',
  '.mp4': '🎬', '.mkv': '🎬', '.avi': '🎬', '.mp3': '🎵', '.wav': '🎵',
  '.exe': '⚙', '.lnk': '🔗', '.py': '🐍', '.rs': '🦀',
};

function samePath(a, b) {
  return String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();
}

defineWidget({
  type: 'files',
  name: '快速访问',
  size: { w: 445, h: 418 },
  config: { path: null },

  render(body, ctx) {
    const cfg = ctx.model.config || (ctx.model.config = {});

    const wrap = el('div', 'files-wrap');
    body.append(wrap);

    const bar = el('div', 'files-path');
    const pickBtn = el('button', 'btn files-pick', '▾');
    pickBtn.title = '切换文件夹';
    const up = el('button', 'btn files-up', '↑');
    up.title = '上一级';
    const ptext = el('div', 'p', '');
    const redo = el('button', 'btn files-redo', '⟳');
    redo.title = '刷新';
    bar.append(pickBtn, up, ptext, redo);

    const list = el('div', 'files-list');
    wrap.append(bar);

    // 快捷入口：桌面 / 下载 / 文档（从根目录列表里自动识别）
    const quick = el('div', 'files-quick');
    const ICOS = { '桌面': '🖥', '下载': '⬇', '文档': '📄' };
    // 常用目录显示短名，其余显示完整路径
    function prettyRoot(p) {
      const h = (navigator.userAgent.indexOf('Windows') >= 0) ? '' : '';
      const known = [
        ['\\Desktop', '🖥 桌面'],
        ['\\Downloads', '⬇ 下载'],
        ['\\Documents', '📄 文档'],
        ['\\Pictures', '🖼 图片'],
        ['\\Music', '🎵 音乐'],
        ['\\Videos', '🎬 视频'],
      ];
      for (let i = 0; i < known.length; i++) {
        if (p.endsWith(known[i][0])) return known[i][1] + '  ' + p;
      }
      return p;
    }
    (ctx.state.quickDirs || []).forEach(function (q) {
      if (!q.exists) return;
      const b = el('button', 'fq', (ICOS[q.label] || '📁') + ' ' + q.label);
      b.title = '用资源管理器打开 ' + q.path;
      b.onclick = function () {
        ctx.api.openPath(q.path).catch(function (e) { ctx.toast(e.message); });
      };
      quick.append(b);
    });
    if (quick.children.length) wrap.append(quick);

    wrap.append(list);

    let roots = (ctx.state.roots || []).slice();
    let cur = cfg.path || (roots.find((r) => r.exists) || roots[0] || {}).path || null;
    let menu = null;

    function closeMenu() {
      if (menu && menu.parentNode) menu.remove();
      menu = null;
    }

    function buildMenu() {
      closeMenu();
      menu = el('div', 'fp-menu');

      const title = el('div', 'fp-title', '显示的文件夹');
      menu.append(title);

      roots.forEach((r) => {
        const row = el('div', 'fp-item' + (samePath(r.path, cur) ? ' on' : '') + (r.exists ? '' : ' missing'));

        const ico = el('span', 'fp-ico', r.exists ? '📁' : '⚠');
        const name = el('span', 'fp-name', prettyRoot(r.path));
        name.title = r.exists ? r.path : r.path + '（不存在）';

        const del = el('button', 'fp-del', '✕');
        del.title = '从列表移除';
        del.onclick = (e) => {
          e.stopPropagation();
          ctx.api.delRoot(r.path)
            .then((res) => { roots = res.roots; refreshRoots(); buildMenu(); })
            .catch((err) => ctx.toast(err.message));
        };

        row.append(ico, name, del);
        row.onclick = () => {
          if (!r.exists) { ctx.toast('这个目录不存在'); return; }
          cur = r.path;
          cfg.path = cur;
          ctx.setConfig({ path: cur });
          closeMenu();
          load(cur);
        };
        menu.append(row);
      });

      const addBox = el('div', 'fp-add');
      const inp = document.createElement('input');
      inp.className = 'fp-input';
      inp.placeholder = '粘贴完整路径后回车添加';
      inp.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        const v = inp.value.trim();
        if (!v) return;
        ctx.api.addRoot(v)
          .then((res) => {
            roots = res.roots;
            refreshRoots();
            buildMenu();
            ctx.toast('已添加');
          })
          .catch((err) => ctx.toast(err.message));
      };
      addBox.append(inp);
      menu.append(addBox);

      document.body.append(menu);
      const rect = pickBtn.getBoundingClientRect();
      menu.style.left = Math.min(rect.left, window.innerWidth - 360) + 'px';
      menu.style.top = rect.bottom + 6 + 'px';
      setTimeout(() => inp.focus(), 30);
    }

    function refreshRoots() {
      // 同步给全局 state，别的组件也能看到
      ctx.state.roots = roots;
      ctx.state.fsRoots = roots.map((r) => r.path);
    }

    async function load(p) {
      ptext.textContent = '读取中…';
      list.innerHTML = '';
      try {
        const d = await ctx.api.list(p);
        cur = d.path;
        cfg.path = cur;
        ctx.setConfig({ path: cur });
        ptext.textContent = cur;
        ptext.title = cur;

        const isRoot = roots.some((r) => samePath(r.path, cur));
        up.disabled = isRoot;
        up.style.opacity = isRoot ? '.3' : '1';

        if (!d.entries.length) {
          list.append(el('div', 'empty', '空文件夹'));
          return;
        }
        d.entries.slice(0, 300).forEach((f) => {
          const row = el('div', 'fitem' + (f.isDir ? ' dir' : ''));
          const ico = el('div', 'fi', f.isDir ? '📁' : (ICON[f.ext] || '📄'));
          const name = el('div', 'fn', f.name);
          name.title = f.name;
          const size = el('div', 'fs', f.isDir ? '' : f.sizeText);
          row.append(ico, name, size);
          row.onclick = () => {
            if (f.isDir) load(f.path);
            else ctx.api.reveal(f.path).catch((e) => ctx.toast(e.message));
          };
          row.ondblclick = () => ctx.api.reveal(f.path).catch((e) => ctx.toast(e.message));
          row.oncontextmenu = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openCtxMenu(ev.clientX, ev.clientY, f);
          };
          list.append(row);
        });
        const info = el('div', 'files-foot', `共 ${d.entries.length} 项`);
        list.append(info);
      } catch (e) {
        ptext.textContent = '读取失败';
        list.append(el('div', 'empty', e.message));
      }
    }

    /* ── 右键菜单：打开 / 打开文件所在位置 / 复制路径 ── */
    let ctxMenu = null;

    function closeCtxMenu() {
      if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
    }

    function openCtxMenu(x, y, f) {
      closeCtxMenu();
      const m = el('div', 'ctx-menu');
      m.style.left = x + 'px';
      m.style.top = y + 'px';

      const mk = (label, fn) => {
        const it = el('div', 'ctx-item', label);
        it.onclick = (ev) => { ev.stopPropagation(); closeCtxMenu(); fn(); };
        m.append(it);
      };

      if (f.isDir) mk('📂 打开文件夹', () => ctx.api.reveal(f.path).catch((e) => ctx.toast(e.message)));
      else mk('▶ 打开文件', () => ctx.api.reveal(f.path).catch((e) => ctx.toast(e.message)));

      mk('📁 打开文件所在位置', () => ctx.api.reveal(f.path, true).catch((e) => ctx.toast(e.message)));

      m.append(el('div', 'ctx-sep'));
      mk('⧉ 复制路径', () => {
        navigator.clipboard.writeText(f.path)
          .then(() => ctx.toast('路径已复制'))
          .catch(() => ctx.toast('复制失败'));
      });

      document.body.append(m);
      ctxMenu = m;
      // 贴边时回收
      const r = m.getBoundingClientRect();
      if (r.right > innerWidth - 8) m.style.left = (x - r.width) + 'px';
      if (r.bottom > innerHeight - 8) m.style.top = (y - r.height) + 'px';
    }

    document.addEventListener('click', closeCtxMenu);
    window.addEventListener('blur', closeCtxMenu);

    pickBtn.onclick = (e) => {
      e.stopPropagation();
      if (menu) { closeMenu(); return; }
      buildMenu();
    };
    up.onclick = () => {
      const parts = cur.replace(/[\\/]+$/, '').split(/[\\/]/);
      parts.pop();
      const parent = parts.join('\\') || cur;
      if (roots.some((r) => parent.toLowerCase().startsWith(r.path.toLowerCase().replace(/[\\/]+$/, '')))) load(parent);
      else {
        const first = roots.find((r) => r.exists);
        if (first) load(first.path);
      }
    };
    redo.onclick = () => load(cur);

    document.addEventListener('click', (e) => {
      if (menu && !menu.contains(e.target) && !pickBtn.contains(e.target)) closeMenu();
    });

    if (cur) load(cur);
    else list.append(el('div', 'empty', '还没有可浏览的目录\n点左上角 ▾ 添加'));
  },
});
