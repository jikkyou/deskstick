/** 后端接口的薄封装 */
async function req(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

export const api = {
  state: () => req('/api/state'),
  save: (key, value) => req('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }),
  list: (p) => req('/api/fs?path=' + encodeURIComponent(p)),
  read: (p) => req('/api/fs/read?path=' + encodeURIComponent(p)),
  reveal: (p, select) => req('/api/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p, select: !!select }),
  }),
  appinfo: () => req('/api/appinfo'),
  autostart: () => req('/api/autostart'),
  setAutostart: (enabled) => req('/api/autostart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !!enabled }),
  }),
  openPath: (p) => req('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p }),
  }),
  roots: () => req('/api/fsroots'),
  addRoot: (p) => req('/api/fsroots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', path: p }),
  }),
  delRoot: (p) => req('/api/fsroots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'remove', path: p }),
  }),
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
