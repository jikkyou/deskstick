import { defineWidget } from '../registry.js';
import { el, uid, fmtTime } from '../api.js';

function titleOf(n) {
  const line = (n.body || '').split('\n').find((l) => l.trim());
  return (line || '（空）').trim().slice(0, 30);
}

/* 图片：压缩到最长边 1600 再上传，避免几 MB 的截图原样堆进磁盘 */
function compressImage(file) {
  return new Promise(function (resolve, reject) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = function () {
      const MAX = 1600;
      let w = img.width, h = img.height;
      if (Math.max(w, h) > MAX) {
        const r = MAX / Math.max(w, h);
        w = Math.round(w * r);
        h = Math.round(h * r);
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

async function uploadImage(file) {
  const dataUrl = await compressImage(file);
  const r = await fetch('/api/notes/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: dataUrl }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d.name;
}

defineWidget({
  type: 'notes',
  name: '随手记',
  size: { w: 360, h: 420 },
  config: { view: 'list', current: null, q: '' },

  render(body, ctx) {
    const cfg = ctx.model.config || (ctx.model.config = {});
    const notes = ctx.state.notes;

    const wrap = el('div', 'notes-wrap');
    body.append(wrap);

    if (cfg.view === 'edit') {
      const note = notes.find((n) => n.id === cfg.current);
      if (!note) { cfg.view = 'list'; return ctx.refresh(); }

      const bar = el('div', 'notes-top');
      const back = el('button', 'btn', '← 返回');
      back.onclick = () => {
        if (note.body !== undefined) note.updated = note.updated || Date.now();
        cfg.view = 'list';
        ctx.saveData('notes');
        ctx.refresh();
      };
      const del = el('button', 'btn', '删除');
      del.onclick = () => {
        if (!confirm('删除这条记录？')) return;
        ctx.state.notes = notes.filter((n) => n.id !== note.id);
        cfg.view = 'list';
        ctx.saveData('notes');
        ctx.refresh();
      };
      const spacer = el('div', ''); spacer.style.flex = '1';
      bar.append(back, spacer, del);

      const ta = document.createElement('textarea');
      ta.value = note.body || '';
      ta.placeholder = '想到什么就写什么…';
      ta.oninput = () => {
        note.body = ta.value;
        note.updated = Date.now();
        ctx.saveData('notes');
      };
      ta.onblur = () => ctx.saveData('notes');

      const imgBox = el('div', 'note-imgs');

      function paintImages() {
        imgBox.innerHTML = '';
        const arr = note.images || [];
        imgBox.style.display = arr.length ? 'flex' : 'none';
        arr.forEach((name) => {
          const cell = el('div', 'note-img');
          const im = document.createElement('img');
          im.src = '/notes-img/' + name;
          im.loading = 'lazy';
          im.title = '点击看大图';
          im.onclick = () => window.open('/notes-img/' + name, '_blank');
          const del = el('button', 'note-img-del', '×');
          del.title = '移出这条笔记';
          del.onclick = (ev) => {
            ev.stopPropagation();
            note.images = (note.images || []).filter((x) => x !== name);
            note.updated = Date.now();
            ctx.saveData('notes');
            paintImages();
          };
          cell.append(im, del);
          imgBox.append(cell);
        });
      }

      async function addFiles(files) {
        const imgs = Array.prototype.slice.call(files).filter((f) => f.type && f.type.indexOf('image/') === 0);
        if (!imgs.length) return;
        for (let i = 0; i < imgs.length; i++) {
          try {
            ctx.toast('图片处理中…（' + (i + 1) + '/' + imgs.length + '）');
            const name = await uploadImage(imgs[i]);
            if (!note.images) note.images = [];
            note.images.push(name);
            note.updated = Date.now();
            ctx.saveData('notes');
            paintImages();
          } catch (e) {
            ctx.toast('图片添加失败：' + e.message);
          }
        }
      }

      // 粘贴：从剪贴板拿图片（配合 Win+Shift+S 截图最顺手）
      ta.onpaste = (e) => {
        const cd = e.clipboardData;
        if (!cd) return;
        const files = cd.files && cd.files.length ? cd.files : null;
        if (files) {
          const imgs = Array.prototype.slice.call(files).filter((f) => f.type && f.type.indexOf('image/') === 0);
          if (imgs.length) {
            e.preventDefault();
            addFiles(imgs);
          }
        }
      };

      const edit = el('div', 'note-edit');
      edit.append(ta);

      // 拖拽：把图片文件拖进来
      edit.addEventListener('dragover', (e) => {
        if (e.dataTransfer && e.dataTransfer.types && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0) {
          e.preventDefault();
          edit.classList.add('drag-on');
        }
      });
      edit.addEventListener('dragleave', () => edit.classList.remove('drag-on'));
      edit.addEventListener('drop', (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault();
        edit.classList.remove('drag-on');
        addFiles(e.dataTransfer.files);
      });

      wrap.append(bar, edit, imgBox);
      paintImages();
      setTimeout(() => ta.focus(), 30);
      return;
    }

    // 列表视图
    const top = el('div', 'notes-top');
    const q = document.createElement('input');
    q.className = 'input';
    q.placeholder = '搜索…';
    q.value = cfg.q || '';
    q.style.flex = '1';
    q.oninput = () => {
      cfg.q = q.value;
      renderList();
    };
    const add = el('button', 'btn primary', '+ 新记');
    add.onclick = () => {
      const n = { id: uid(), body: '', created: Date.now(), updated: Date.now() };
      ctx.state.notes.unshift(n);
      cfg.view = 'edit';
      cfg.current = n.id;
      ctx.saveData('notes');
      ctx.refresh();
    };
    top.append(q, add);

    const list = el('div', 'notes-list');
    wrap.append(top, list);

    function renderList() {
      list.innerHTML = '';
      const kw = (cfg.q || '').trim().toLowerCase();
      const arr = notes
        .filter((n) => !kw || (n.body || '').toLowerCase().includes(kw))
        .sort((a, b) => (b.updated || b.created) - (a.updated || a.created));

      if (!arr.length) {
        list.append(el('div', 'empty', kw ? '没找到匹配的记录' : '还没有记录\n点「+ 新记」开始'));
        return;
      }
      arr.forEach((n) => {
        const item = el('div', 'note');
        const meta = fmtTime(n.updated || n.created);
        const cnt = (n.images || []).length;
        item.append(
          el('div', 'note-t', titleOf(n)),
          el('div', 'note-m', meta + (cnt ? '   📷 ' + cnt : ''))
        );
        item.onclick = () => {
          cfg.view = 'edit';
          cfg.current = n.id;
          ctx.refresh();
        };
        list.append(item);
      });
    }

    renderList();
  },
});
