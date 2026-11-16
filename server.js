'use strict';
/**
 * 桌贴 —— 本地服务
 * 零依赖：只用 Node 内置模块。
 * 职责：托管前端静态文件 / 读写 JSON 数据 / 列目录 / 用系统程序打开文件。
 */
const http = require('http');
const fs = require('fs');
const xz = require('./xz');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');
const https = require('https');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const xzStore = new xz.XyzStore(DATA);
const xzProgress = new xz.ProgressStore(DATA);
const xzQueue = new xz.QueueStore(DATA);

// 取可用 token；若上次调用被判 401，这里会先刷新一次
async function xzToken() {
  await xzStore.load();
  return xzStore.data.access || '';
}

// 401 时自动刷新并重试一次
async function xzRetry(fn) {
  let tk = await xzToken();
  if (!tk) return { status: 401, needLogin: true, body: '未登录', json: null };

  let r = await fn(tk);
  if (r.status === 401) {
    // access 过期：用 refresh 换一张再试
    const fresh = await xz.refreshToken(xzStore.data.refresh);
    if (fresh) {
      await xzStore.save({ access: fresh.access, refresh: fresh.refresh });
      r = await fn(fresh.access);
    }
    // 还不行说明 refresh 也废了，必须重新扫码
    if (r.status === 401 || !fresh) {
      return { status: 401, needLogin: true, body: '登录已失效', json: null };
    }
  }
  return r;
}
const PORT = Number(process.env.PORT || 7788);
const HOST = '127.0.0.1';

// ─── 可浏览的根目录：存在 data/fsroots.json，界面上可增删 ──────────
const NOTES_IMG_DIR = path.join(DATA, 'notes-img');
const FSROOTS_FILE = path.join(DATA, 'fsroots.json');
// 默认白名单按当前用户的家目录算，换机器/换用户名都能用
const HOME_DIR = os.homedir();
const DEFAULT_ROOTS = [
  path.join(HOME_DIR, 'Desktop'),
  path.join(HOME_DIR, 'Downloads'),
  path.join(HOME_DIR, 'Documents'),
];

function loadRoots() {
  try {
    const arr = JSON.parse(fs.readFileSync(FSROOTS_FILE, 'utf8'));
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (e) { /* 首次运行，用默认值 */ }
  return DEFAULT_ROOTS.slice();
}

function saveRoots(arr) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(FSROOTS_FILE, JSON.stringify(arr, null, 2), 'utf8');
}

let ROOTS = loadRoots();
if (!fs.existsSync(FSROOTS_FILE)) saveRoots(ROOTS);

function quickDirs() {
  const home = os.homedir();
  const defs = [
    ['桌面', path.join(home, 'Desktop')],
    ['下载', path.join(home, 'Downloads')],
    ['文档', path.join(home, 'Documents')],
  ];
  return defs.map(function (d) {
    let exists = false;
    try { exists = fs.statSync(d[1]).isDirectory(); } catch (e) { exists = false; }
    return { label: d[0], path: d[1], exists: exists };
  });
}

function rootList() {
  return ROOTS.map(function (p) {
    let exists = false;
    try { exists = fs.statSync(p).isDirectory(); } catch (e) { exists = false; }
    return { path: p, exists: exists };
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const DATA_FILES = {
  layout: 'layout.json',
  notes: 'notes.json',
  todos: 'todos.json',
  progress: 'progress.json',
  settings: 'settings.json',
  stocks: 'stocks.json',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

async function loadData(key, fallback) {
  try {
    const raw = await fsp.readFile(path.join(DATA, DATA_FILES[key]), 'utf8');
    return JSON.parse(raw);
  } catch { return fallback; }
}

async function saveData(key, value) {
  await fsp.mkdir(DATA, { recursive: true });
  const file = path.join(DATA, DATA_FILES[key]);
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

/** 路径必须落在白名单根目录之内，防穿越 */
function safeResolve(target) {
  if (!target) throw new Error('缺少 path');
  const abs = path.resolve(target);
  const low = abs.toLowerCase();
  const ok = ROOTS.some((root) => {
    const r = path.resolve(root).toLowerCase();
    return low === r || low.startsWith(r + path.sep);
  });
  if (!ok) throw new Error('该路径不在允许浏览的目录内');
  return abs;
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function listDir(dir) {
  const abs = safeResolve(dir);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
    const full = path.join(abs, e.name);
    let st = null;
    try { st = await fsp.stat(full); } catch { /* 跳过无权限项 */ }
    out.push({
      name: e.name,
      path: full,
      isDir: e.isDirectory(),
      size: st ? st.size : 0,
      sizeText: st && !e.isDirectory() ? fmtSize(st.size) : '',
      mtime: st ? st.mtimeMs : 0,
      ext: e.isDirectory() ? '' : (path.extname(e.name) || '').toLowerCase(),
    });
  }
  out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh-CN'));
  return { path: abs, parent: path.dirname(abs), entries: out };
}

const TEXT_EXT = new Set(['.txt', '.md', '.log', '.json', '.js', '.ts', '.css', '.html', '.htm', '.yml', '.yaml', '.ini', '.csv', '.py', '.rs', '.toml', '.xml', '.sh', '.bat', '.ps1']);

async function readText(file) {
  const abs = safeResolve(file);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new Error('不是文件');
  if (st.size > 2 * 1024 * 1024) throw new Error('文件太大（>2MB）');
  const ext = path.extname(abs).toLowerCase();
  if (!TEXT_EXT.has(ext)) throw new Error('不支持预览该类型：' + ext);
  const buf = await fsp.readFile(abs);
  return { path: abs, text: buf.toString('utf8'), size: st.size };
}

function shellOpen(target) {
  // explorer.exe 对文件/目录都能用；返回码 1 属正常
  // 注意：不能加 windowsHide，否则资源管理器窗口会被以隐藏方式启动（看起来像没反应）
  execFile('explorer.exe', [path.resolve(target)], (err) => {
    if (err && err.code !== 1) console.error('[shellOpen]', err.message);
  });
}

// ─── 股票行情：东方财富公开接口代理 ────────────────────────────
// 免鉴权、免费；东财按源 IP 限流且会临时封禁突发请求 → 必须缓存 + 节流。
const EM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
const EM_REFERER = 'https://quote.eastmoney.com/';
const QUOTE_TTL = 3000;          // 缓存 3 秒
const QUOTE_MIN_INTERVAL = 900;  // 两次上游请求最小间隔
let quoteCache = { key: '', ts: 0, payload: null };
let lastUpstreamAt = 0;

function httpsJson(url, headers, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const req = https.get(url, { headers: headers }, function (res) {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('上游返回的不是 JSON')); }
      });
    });
    req.setTimeout(timeoutMs || 8000, function () { req.destroy(new Error('上游超时')); });
    req.on('error', reject);
  });
}

async function fetchQuotes(secids) {
  const now = Date.now();
  if (quoteCache.payload && quoteCache.key === secids && now - quoteCache.ts < QUOTE_TTL) {
    return quoteCache.payload;
  }
  const wait = QUOTE_MIN_INTERVAL - (now - lastUpstreamAt);
  if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
  lastUpstreamAt = Date.now();

  // fltt=2：直接返回浮点价格（不带的话是放大过的整数，要按 f1 自己除）
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=' +
    encodeURIComponent(secids) + '&fields=f1,f2,f3,f4,f12,f13,f14,f15,f16,f17,f18';

  const j = await httpsJson(url, { 'User-Agent': EM_UA, 'Referer': EM_REFERER }, 8000);
  const diff = (j && j.data && j.data.diff) || [];
  const items = diff.map(function (d) {
    return {
      code: d.f12, market: d.f13, name: d.f14,
      price: d.f2, pct: d.f3, chg: d.f4,
      high: d.f15, low: d.f16, open: d.f17, preClose: d.f18,
      decimals: d.f1,
    };
  });
  const payload = { items: items, ts: Date.now() };
  quoteCache = { key: secids, ts: Date.now(), payload: payload };
  return payload;
}

/* ── 股票：中文/拼音检索 ── */
const EM_SUGGEST = 'https://searchapi.eastmoney.com/api/suggest/get';
const EM_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

async function searchStock(q) {
  const url = EM_SUGGEST + '?input=' + encodeURIComponent(q) + '&type=14&count=12&token=' + EM_TOKEN;
  const j = await httpsJson(url, { 'User-Agent': EM_UA, 'Referer': EM_REFERER }, 8000);
  const rows = (j && j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
  return rows
    .filter(function (r) { return r && r.QuoteID && r.Code && r.Name; })
    .map(function (r) {
      return {
        secid: String(r.QuoteID),
        code: String(r.Code),
        name: String(r.Name),
        pinyin: r.PinYin || '',
        type: r.SecurityTypeName || r.Classify || '',
      };
    });
}

/* ── 股票：当日分时（每分钟一个点）── */
async function fetchTrend(secid) {
  const url = 'https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=' + encodeURIComponent(secid) +
    '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0';
  const j = await httpsJson(url, { 'User-Agent': EM_UA, 'Referer': EM_REFERER }, 8000);
  const d = (j && j.data) || {};
  const trends = d.trends || [];
  const points = trends.map(function (line) {
    // "2026-11-10 09:30,open,close,high,low,vol,amount,avg"
    const p = line.split(',');
    return { t: p[0], v: Number(p[2]), avg: Number(p[7]) || null };
  }).filter(function (x) { return isFinite(x.v); });
  return { secid: secid, name: d.name || '', preClose: d.preClose || null, points: points };
}

/* ── 股票：三市成交额统计 ── */
const MKT_IDS = ['1.000001', '0.399001', '0.899050'];
let mktCache = { ts: 0, data: null };
const MKT_TTL = 45000;

/* 5 分钟 K 线（klt=1 只给当天，klt=5 能带出前一交易日） */
function klineMin5(secid, beg) {
  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid +
    '&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=5&fqt=1&beg=' + beg + '&end=20500101&lmt=300';
  return httpsJson(url, { 'User-Agent': EM_UA, 'Referer': EM_REFERER }, 9000).then(function (j) {
    const k = (j && j.data && j.data.klines) || [];
    return k.map(function (line) {
      const p = line.split(',');
      return { date: p[0].slice(0, 10), time: p[0].slice(11), amount: Number(p[6]) };
    }).filter(function (x) { return isFinite(x.amount); });
  });
}

function ymd(d) {
  const p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

async function marketStat() {
  const now = Date.now();
  if (mktCache.data && now - mktCache.ts < MKT_TTL) return mktCache.data;

  // 1) 实时三市总额
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=' +
    encodeURIComponent(MKT_IDS.join(',')) + '&fields=f2,f3,f6,f12,f14';
  const j = await httpsJson(url, { 'User-Agent': EM_UA, 'Referer': EM_REFERER }, 8000);
  const diff = (j && j.data && j.data.diff) || [];
  let total = 0;
  const parts = diff.map(function (d) {
    const amt = Number(d.f6) || 0;
    total += amt;
    return { name: d.f14, code: d.f12, amount: amt };
  });

  // 2) 昨日同期：拉 5 分钟 K，取最近两个交易日，按「今日已到的最后一根」截昨日
  let prevSame = null;
  let todayAcc = null;
  let lastTime = null;
  try {
    const beg = ymd(new Date(now - 7 * 86400000));
    const sets = await Promise.all(MKT_IDS.map(function (id) { return klineMin5(id, beg); }));

    const dateSet = {};
    sets.forEach(function (ks) { ks.forEach(function (k) { dateSet[k.date] = 1; }); });
    const ds = Object.keys(dateSet).sort();
    if (ds.length >= 2) {
      const todayStr = ds[ds.length - 1];
      const yestStr = ds[ds.length - 2];

      // 今日已经走到第几根（各市场取最晚）
      let maxTime = '';
      sets.forEach(function (ks) {
        ks.forEach(function (k) {
          if (k.date === todayStr && k.time > maxTime) maxTime = k.time;
        });
      });
      lastTime = maxTime;

      let ys = 0, ta = 0;
      sets.forEach(function (ks) {
        ks.forEach(function (k) {
          if (k.date === todayStr) ta += k.amount;
          else if (k.date === yestStr && k.time <= maxTime) ys += k.amount;
        });
      });
      prevSame = ys;
      todayAcc = ta;
    }
  } catch (e) { /* 同期算不出来就留空，不影响主流程 */ }

  // 3) 按交易进度外推全天
  const t = new Date();
  const mins = t.getHours() * 60 + t.getMinutes();
  let elapsed = 0;
  if (mins <= 9 * 60 + 30) elapsed = 0;
  else if (mins <= 11 * 60 + 30) elapsed = mins - (9 * 60 + 30);
  else if (mins <= 13 * 60) elapsed = 120;
  else if (mins <= 15 * 60) elapsed = 120 + (mins - 13 * 60);
  else elapsed = 240;
  const predict = (elapsed >= 240 || elapsed <= 0) ? total : total / (elapsed / 240);

  const data = {
    total: total,
    predict: predict,
    parts: parts,
    elapsed: elapsed,
    prevSame: prevSame,      // 昨日同一时刻的累计
    todayAcc: todayAcc,      // 今日按 5 分钟 K 累加的累计（对账用）
    lastTime: lastTime,      // 对比到哪个分钟
    ts: now,
  };
  mktCache = { ts: now, data: data };
  return data;
}

/* ─── 合并接口：自选报价 + 三市统计，一次 ulist 拿完 ─── */
const BOARD_TTL = 80000;   // 略小于前端 90 秒刷新，重复请求能命中
let boardCache = { key: '', ts: 0, data: null };
let prevSameCache = { ts: 0, data: null };
const PREVSAME_TTL = 10 * 60000;   // 昨日同期一天才变一次，10 分钟够

async function stockBoard(secids) {
  const now = Date.now();
  if (boardCache.data && boardCache.key === secids && now - boardCache.ts < BOARD_TTL) {
    return boardCache.data;
  }

  const extra = secids ? secids.split(',') : [];
  const all = MKT_IDS.concat(extra).filter(function (v, i, a) { return a.indexOf(v) === i; });

  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=' +
    encodeURIComponent(all.join(',')) + '&fields=f1,f2,f3,f4,f6,f12,f13,f14,f15,f16,f17,f18';

  const wait = QUOTE_MIN_INTERVAL - (now - lastUpstreamAt);
  if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
  lastUpstreamAt = Date.now();

  // 东财时常掐连接，内部重试 3 次（每次间隔 400ms）
  let j = null, lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      j = await httpsJson(url, { 'User-Agent': EM_UA, 'Referer': EM_REFERER }, 9000);
      if (j && j.data) break;
      lastErr = new Error('上游返回空数据');
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 2) await new Promise(function (r) { setTimeout(r, 400); });
  }
  if (!j || !j.data) throw (lastErr || new Error('上游无响应'));

  const diff = (j && j.data && j.data.diff) || [];

  const items = [];
  let total = 0;
  const wantSet = {};
  extra.forEach(function (id) { wantSet[id] = 1; });

  diff.forEach(function (d) {
    const secid = d.f13 + '.' + d.f12;
    const isMkt = MKT_IDS.indexOf(secid) >= 0;
    if (isMkt) total += Number(d.f6) || 0;
    // 三市指数如果也在自选里（比如上证指数被置顶），要同时返回给列表
    if (!isMkt || wantSet[secid]) {
      items.push({
        code: d.f12, market: d.f13, name: d.f14,
        price: d.f2, pct: d.f3, chg: d.f4,
        high: d.f15, low: d.f16, open: d.f17, preClose: d.f18,
        decimals: d.f1,
      });
    }
  });

  // 昨日同期：单独缓存，10 分钟才更新
  let prevSame = null, lastTime = null, todayAcc = null;
  if (!prevSameCache.data || now - prevSameCache.ts > PREVSAME_TTL) {
    try {
      const beg = ymd(new Date(now - 7 * 86400000));
      const sets = await Promise.all(MKT_IDS.map(function (id) { return klineMin5(id, beg); }));
      const dateSet = {};
      sets.forEach(function (ks) { ks.forEach(function (k) { dateSet[k.date] = 1; }); });
      const ds = Object.keys(dateSet).sort();
      if (ds.length >= 2) {
        const todayStr = ds[ds.length - 1], yestStr = ds[ds.length - 2];
        let maxTime = '';
        sets.forEach(function (ks) {
          ks.forEach(function (k) { if (k.date === todayStr && k.time > maxTime) maxTime = k.time; });
        });
        let ys = 0, ta = 0;
        sets.forEach(function (ks) {
          ks.forEach(function (k) {
            if (k.date === todayStr) ta += k.amount;
            else if (k.date === yestStr && k.time <= maxTime) ys += k.amount;
          });
        });
        prevSameCache = { ts: now, data: { prevSame: ys, todayAcc: ta, lastTime: maxTime } };
      }
    } catch (e) { /* 拿不到就留空 */ }
  }
  if (prevSameCache.data) {
    prevSame = prevSameCache.data.prevSame;
    todayAcc = prevSameCache.data.todayAcc;
    lastTime = prevSameCache.data.lastTime;
  }

  // 预测全天
  const t = new Date();
  const mins = t.getHours() * 60 + t.getMinutes();
  let elapsed = 0;
  if (mins <= 9 * 60 + 30) elapsed = 0;
  else if (mins <= 11 * 60 + 30) elapsed = mins - (9 * 60 + 30);
  else if (mins <= 13 * 60) elapsed = 120;
  else if (mins <= 15 * 60) elapsed = 120 + (mins - 13 * 60);
  else elapsed = 240;
  const predict = (elapsed >= 240 || elapsed <= 0) ? total : total / (elapsed / 240);

  const data = {
    items: items,
    market: {
      total: total, predict: predict, elapsed: elapsed,
      prevSame: prevSame, todayAcc: todayAcc, lastTime: lastTime,
    },
    ts: Date.now(),
  };
  boardCache = { key: secids, ts: Date.now(), data: data };
  return data;
}

function shellReveal(target) {
  // /select 是 explorer 的参数：打开父目录并选中该项。路径含空格时整体作为一个参数传即可
  const abs = path.resolve(target);
  execFile('explorer.exe', ['/select,' + abs], (err) => {
    if (err && err.code !== 1) console.error('[shellReveal]', err.message);
  });
}

/* ─── 开机自启动（注册表 HKCU\...\Run，不需要管理员权限）─── */
const BS = String.fromCharCode(92);   // 反斜杠：避免生成/传输过程中被吃掉
const AUTOSTART_KEY = ['HKCU', 'Software', 'Microsoft', 'Windows', 'CurrentVersion', 'Run'].join(BS);
const AUTOSTART_NAME = 'DeskStick';
const AUTOSTART_FILE = path.join(DATA, 'autostart.json');

function hostExePath() {
  const p = path.join(ROOT, 'desktop', 'DeskHost.exe');
  return fs.existsSync(p) ? p : null;
}

function regQueryAutostart() {
  return new Promise(function (resolve) {
    execFile('reg', ['query', AUTOSTART_KEY, '/v', AUTOSTART_NAME], { encoding: 'buffer' }, function (err, stdout) {
      if (err) return resolve({ enabled: false, current: null });
      // reg 输出是 GBK，必须解码，否则中文路径读回来是乱码、路径比较永远不相等
      let txt = '';
      try { txt = new TextDecoder('gbk').decode(Buffer.from(stdout || [])); }
      catch (e) { txt = String(stdout || ''); }
      const NL = String.fromCharCode(10);
      const rows = txt.split(NL);
      let line = '';
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].indexOf(AUTOSTART_NAME) >= 0) { line = rows[i]; break; }
      }
      const at = line.indexOf('REG_SZ');
      let cur = at >= 0 ? line.slice(at + 6).trim() : null;
      if (cur) cur = cur.split('"').join('');
      resolve({ enabled: true, current: cur });
    });
  });
}

function regSetAutostart(on, exe) {
  return new Promise(function (resolve, reject) {
    if (on) {
      // 值带引号，避免路径里有空格时被截断
      execFile('reg', ['add', AUTOSTART_KEY, '/v', AUTOSTART_NAME, '/t', 'REG_SZ',
        '/d', '"' + exe + '"', '/f'], function (err) {
        err ? reject(err) : resolve();
      });
    } else {
      execFile('reg', ['delete', AUTOSTART_KEY, '/v', AUTOSTART_NAME, '/f'], function () {
        resolve();   // 本来就不存在也算成功
      });
    }
  });
}

function readAutostartFlag() {
  try { return JSON.parse(fs.readFileSync(AUTOSTART_FILE, 'utf8')); } catch (e) { return null; }
}

function writeAutostartFlag(obj) {
  try {
    fs.writeFileSync(AUTOSTART_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { console.error('[autostart] 写标记失败', e.message); }
}

async function autostartStatus() {
  const exe = hostExePath();
  if (!exe) return { supported: false, enabled: false, current: null, expected: null };
  const st = await regQueryAutostart();
  return { supported: true, enabled: st.enabled, current: st.current, expected: exe };
}

/* 首次运行默认开启；之后若用户开过但程序被移动过，自动修正路径 */
async function ensureAutostart() {
  const exe = hostExePath();
  if (!exe) return;
  const flag = readAutostartFlag();
  if (!flag) {
    try {
      await regSetAutostart(true, exe);
      writeAutostartFlag({ enabled: true, decidedAt: new Date().toISOString() });
      console.log('  [开机启动] 首次运行，已默认开启');
    } catch (e) {
      console.error('  [开机启动] 设置失败:', e.message);
      writeAutostartFlag({ enabled: false, error: String(e.message) });
    }
    return;
  }
  if (flag.enabled) {
    const st = await regQueryAutostart();
    if (!st.enabled || st.current !== exe) {
      try {
        await regSetAutostart(true, exe);
        console.log('  [开机启动] 路径已更新为 ' + exe);
      } catch (e) { /* 忽略 */ }
    }
  }
}

async function handleApi(req, res, u) {
  const p = u.pathname;

  if (p === '/api/state' && req.method === 'GET') {
    const [layout, notes, todos, progress, settings, stocks] = await Promise.all([
      loadData('layout', { widgets: [] }),
      loadData('notes', []),
      loadData('todos', []),
      loadData('progress', []),
      loadData('settings', {}),
      loadData('stocks', { list: [], refreshSec: 5 }),
    ]);
    return sendJson(res, 200, {
      layout, notes, todos, progress, settings, stocks,
      fsRoots: ROOTS,
      roots: rootList(),
      quickDirs: quickDirs(),
      version: 1,
    });
  }

  // ── 天气代理：绕开浏览器的 CORS（wttr.in / open-meteo 都不发 CORS 头）
  if (p === '/api/weather' && req.method === 'GET') {
    const lat = u.searchParams.get('lat') || '30.67';
    const lon = u.searchParams.get('lon') || '104.07';
    const safe = (v) => String(v).replace(/[^0-9.\-]/g, '');

    const tryFetch = async (url, ms) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } finally { clearTimeout(timer); }
    };

    // 1) wttr.in（国内可达，先试）
    try {
      const j = await tryFetch('https://wttr.in/' + safe(lat) + ',' + safe(lon) + '?format=j1', 9000);
      return sendJson(res, 200, { ok: true, src: 'wttr', data: j });
    } catch (e1) { /* 下一个 */ }

    // 2) open-meteo（数据更全）
    try {
      const u2 = 'https://api.open-meteo.com/v1/forecast?latitude=' + safe(lat) + '&longitude=' + safe(lon)
        + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m'
        + '&hourly=precipitation,precipitation_probability'
        + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum'
        + '&timezone=Asia%2FShanghai&forecast_days=4';
      const j = await tryFetch(u2, 9000);
      return sendJson(res, 200, { ok: true, src: 'open-meteo', data: j });
    } catch (e2) { /* 都失败 */ }

    return sendJson(res, 502, { ok: false, error: '天气源都连不上' });
  }

  if (p === '/api/save' && req.method === 'POST') {
    const body = await readBody(req);
    const key = body.key;
    if (!DATA_FILES[key]) return sendJson(res, 400, { error: '未知数据键' });
    await saveData(key, body.value);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/fs' && req.method === 'GET') {
    const target = u.searchParams.get('path') || ROOTS[0];
    try {
      return sendJson(res, 200, await listDir(target));
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === '/api/fs/read' && req.method === 'GET') {
    const target = u.searchParams.get('path');
    try {
      return sendJson(res, 200, await readText(target));
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }

  if (p === '/api/fsroots' && req.method === 'GET') {
    return sendJson(res, 200, { roots: rootList() });
  }

  if (p === '/api/fsroots' && req.method === 'POST') {
    const body = await readBody(req);
    const action = body.action;
    const raw = String(body.path || '').trim().replace(/[\/]+$/, '');
    if (!raw) return sendJson(res, 400, { error: '路径为空' });
    const abs = path.resolve(raw);

    if (action === 'add') {
      let isDir = false;
      try { isDir = fs.statSync(abs).isDirectory(); } catch (e) { isDir = false; }
      if (!isDir) return sendJson(res, 400, { error: '目录不存在：' + abs });
      if (ROOTS.some((r) => r.toLowerCase() === abs.toLowerCase())) {
        return sendJson(res, 400, { error: '已经在列表里了' });
      }
      ROOTS.push(abs);
      saveRoots(ROOTS);
      return sendJson(res, 200, { ok: true, roots: rootList() });
    }

    if (action === 'remove') {
      if (ROOTS.length <= 1) return sendJson(res, 400, { error: '至少要保留一个目录' });
      ROOTS = ROOTS.filter((r) => r.toLowerCase() !== abs.toLowerCase());
      saveRoots(ROOTS);
      return sendJson(res, 200, { ok: true, roots: rootList() });
    }

    return sendJson(res, 400, { error: '未知操作' });
  }

  if (p === '/api/stock' && req.method === 'GET') {
    const secids = String(u.searchParams.get('secids') || '').replace(/[^0-9A-Za-z.,]/g, '');
    if (!secids) return sendJson(res, 400, { error: '缺少 secids 参数' });
    try {
      return sendJson(res, 200, await fetchQuotes(secids));
    } catch (e) {
      return sendJson(res, 502, { error: '取行情失败：' + String((e && e.message) || e) });
    }
  }

  if (p === '/api/stock/board' && req.method === 'GET') {
    const secids = String(u.searchParams.get('secids') || '').replace(/[^0-9A-Za-z.,]/g, '');
    try {
      return sendJson(res, 200, await stockBoard(secids));
    } catch (e) {
      return sendJson(res, 502, { error: '取行情失败：' + String((e && e.message) || e) });
    }
  }

  if (p === '/api/stock/search' && req.method === 'GET') {
    const q = String(u.searchParams.get('q') || '').trim().slice(0, 30);
    if (!q) return sendJson(res, 400, { error: '缺少 q' });
    try {
      return sendJson(res, 200, { items: await searchStock(q) });
    } catch (e) {
      return sendJson(res, 502, { error: '搜索失败：' + String((e && e.message) || e) });
    }
  }

  if (p === '/api/stock/trend' && req.method === 'GET') {
    const secid = String(u.searchParams.get('secid') || '').replace(/[^0-9A-Za-z.]/g, '');
    if (!secid) return sendJson(res, 400, { error: '缺少 secid' });
    try {
      return sendJson(res, 200, await fetchTrend(secid));
    } catch (e) {
      return sendJson(res, 502, { error: '取分时失败：' + String((e && e.message) || e) });
    }
  }

  if (p === '/api/stock/market' && req.method === 'GET') {
    try {
      return sendJson(res, 200, await marketStat());
    } catch (e) {
      return sendJson(res, 502, { error: '取三市数据失败：' + String((e && e.message) || e) });
    }
  }

  if (p === '/api/autostart' && req.method === 'GET') {
    return sendJson(res, 200, await autostartStatus());
  }

  if (p === '/api/autostart' && req.method === 'POST') {
    const body = await readBody(req);
    const on = !!body.enabled;
    const exe = hostExePath();
    if (!exe) return sendJson(res, 400, { error: '当前是网页版，没有可自启的程序' });
    try {
      await regSetAutostart(on, exe);
      writeAutostartFlag({ enabled: on, decidedAt: new Date().toISOString() });
      return sendJson(res, 200, await autostartStatus());
    } catch (e) {
      return sendJson(res, 500, { error: '设置失败：' + String((e && e.message) || e) });
    }
  }

  if (p === '/api/notes/image' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const dataUrl = String(body.data || '');
      const m = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i);
      if (!m) return sendJson(res, 400, { error: '不是有效的图片数据' });

      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 8 * 1024 * 1024) return sendJson(res, 400, { error: '图片太大（上限 8MB）' });

      await fsp.mkdir(NOTES_IMG_DIR, { recursive: true });
      const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
      await fsp.writeFile(path.join(NOTES_IMG_DIR, name), buf);
      return sendJson(res, 200, { name: name, size: buf.length });
    } catch (e) {
      return sendJson(res, 500, { error: '保存图片失败：' + String((e && e.message) || e) });
    }
  }

  /* ── 小宇宙 ── */
  if (p === '/api/xyz/status' && req.method === 'GET') {
    await xzStore.load();
    const d = xzStore.data;
    return sendJson(res, 200, {
      loggedIn: !!(d.access),
      user: d.user || null,
      savedAt: d.savedAt || 0,
    });
  }

  if (p === '/api/xyz/qr/create' && req.method === 'POST') {
    try {
      const q = await xz.qrCreate();
      return sendJson(res, 200, q);
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (p === '/api/xyz/qr/poll' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.id) return sendJson(res, 400, { error: '缺 id' });
      const r = await xz.qrCheck(body.id);
      if (r.access) {
        // 登录成功：先存 token，再拿用户信息
        let user = null;
        try { user = await xz.getMe(r.access); } catch (e) { /* 拿不到用户信息不影响登录 */ }
        await xzStore.save({ access: r.access, refresh: r.refresh || '', user: user });
        return sendJson(res, 200, { status: 'LOGIN_OK', user: user });
      }
      return sendJson(res, 200, { status: r.status, http: r.http });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (p === '/api/xyz/me' && req.method === 'GET') {
    const tk = await xzStore.token();
    if (!tk) return sendJson(res, 401, { error: '未登录' });
    const me = await xz.getMe(tk);
    if (me && me.uid) await xzStore.save({ user: me });
    return sendJson(res, 200, me);
  }

  if (p === '/api/xyz/subscriptions' && req.method === 'GET') {
    const tk = await xzStore.token();
    if (!tk) return sendJson(res, 401, { error: '未登录' });
    const u = new URL(req.url, 'http://x');
    const limit = parseInt(u.searchParams.get('limit') || '50', 10);
    const r = await xzRetry((t) => xz.subscriptionList(t, limit));
    if (r.needLogin) return sendJson(res, 401, { error: 'NEED_LOGIN' });
    if (r.status !== 200) return sendJson(res, r.status || 500, { error: String(r.body).slice(0, 300) });
    return sendJson(res, 200, r.json);
  }

  if (p === '/api/xyz/episodes' && req.method === 'GET') {
    const tk = await xzStore.token();
    if (!tk) return sendJson(res, 401, { error: '未登录' });
    const u = new URL(req.url, 'http://x');
    const pid = u.searchParams.get('pid');
    if (!pid) return sendJson(res, 400, { error: '缺 pid' });
    const limit = parseInt(u.searchParams.get('limit') || '30', 10);
    const r = await xzRetry((t) => xz.episodeList(t, pid, limit));
    if (r.needLogin) return sendJson(res, 401, { error: 'NEED_LOGIN' });
    if (r.status !== 200) return sendJson(res, r.status || 500, { error: String(r.body).slice(0, 300) });
    return sendJson(res, 200, r.json);
  }

  if (p === '/api/xyz/history' && req.method === 'GET') {
    const tk = await xzStore.token();
    if (!tk) return sendJson(res, 401, { error: '未登录' });
    const r = await xzRetry((t) => xz.playHistory(t, 30));
    if (r.needLogin) return sendJson(res, 401, { error: 'NEED_LOGIN' });
    if (r.status !== 200) return sendJson(res, r.status || 500, { error: String(r.body).slice(0, 300) });
    return sendJson(res, 200, r.json);
  }

  if (p === '/api/xyz/logout' && req.method === 'POST') {
    await xzStore.clear();
    return sendJson(res, 200, { ok: true });
  }

  /* ── 小宇宙：首页推荐 ── */
  if (p === '/api/xyz/feed' && req.method === 'GET') {
    const tk = await xzStore.token();
    if (!tk) return sendJson(res, 401, { error: '未登录' });
    const r = await xzRetry((t) => xz.discoveryFeed(t));
    if (r.needLogin) return sendJson(res, 401, { error: 'NEED_LOGIN' });
    if (r.status !== 200) return sendJson(res, r.status || 500, { error: String(r.body).slice(0, 300) });
    // 只挑需要的区块，广告位后端就丢掉
    const blocks = (r.json.data || []).filter(function (b) {
      return b.type === 'EDITOR_PICK' || b.type === 'TOP_LIST';
    });

    // feed 里编辑精选只有当天 3 条，但 /v1/editor-pick/list 能用 loadMoreKey
    // 往前翻历史（每次请求返回若干天，实测能翻 40+ 天 = 120+ 条）。
    // ?limit=N 控制聚合到多少条，供前端做分页轮播。
    const want = Math.max(3, Math.min(60, Number(u.searchParams.get('limit')) || 9));
    const picks = [];
    let lmk = null;
    for (let i = 0; i < 12 && picks.length < want; i++) {
      let er;
      try {
        er = await xzRetry((t) => xz.editorPick(t, lmk));
      } catch (e) { break; }
      if (!er || er.needLogin) return sendJson(res, 401, { error: 'NEED_LOGIN' });
      if (er.status !== 200 || !er.json) break;
      const dayList = er.json.data || [];
      if (!dayList.length) break;
      dayList.forEach(function (d) {
        (d.picks || []).forEach(function (pk) {
          if (picks.length < want) picks.push(Object.assign({ _date: d.date }, pk));
        });
      });
      lmk = er.json.loadMoreKey;
      if (!lmk) break;
    }

    return sendJson(res, 200, { blocks: blocks, picks: picks, limit: want });
  }

  if (p === '/api/xyz/editor-pick' && req.method === 'GET') {
    const tk = await xzStore.token();
    if (!tk) return sendJson(res, 401, { error: '未登录' });
    const r = await xzRetry((t) => xz.editorPick(t));
    if (r.needLogin) return sendJson(res, 401, { error: 'NEED_LOGIN' });
    if (r.status !== 200) return sendJson(res, r.status || 500, { error: String(r.body).slice(0, 300) });
    return sendJson(res, 200, r.json);
  }

  /* ── 小宇宙：播放进度 ── */
  if (p === '/api/xyz/progress' && req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    const eid = u.searchParams.get('eid');
    if (eid) {
      const one = await xzProgress.get(eid);
      return sendJson(res, 200, one || {});
    }
    return sendJson(res, 200, await xzProgress.all());
  }

  if (p === '/api/xyz/progress' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.eid) return sendJson(res, 400, { error: '缺 eid' });
      const saved = await xzProgress.set(body.eid, body.pos, body.dur);
      return sendJson(res, 200, saved || {});
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  /* ── 小宇宙：收藏 ── */
  if (p === '/api/xyz/favorites' && req.method === 'GET') {
    const r = await xzRetry((t) => xz.favoriteList(t));
    if (r.needLogin) return sendJson(res, 401, { error: 'NEED_LOGIN' });
    if (r.status !== 200) return sendJson(res, r.status || 500, { error: String(r.body).slice(0, 200) });
    return sendJson(res, 200, r.json);
  }

  if (p === '/api/xyz/favorite' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body.eid) return sendJson(res, 400, { error: '缺 eid' });
      const r = await xzRetry((t) => xz.favoriteUpdate(t, body.eid, body.favorited));
      if (r.needLogin) return sendJson(res, 401, { error: 'NEED_LOGIN' });
      if (r.status !== 200) return sendJson(res, r.status || 500, { error: String(r.body).slice(0, 200) });
      return sendJson(res, 200, { ok: true, favorited: !!body.favorited });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  /* ── 小宇宙：播放队列 ── */
  if (p === '/api/xyz/queue' && req.method === 'GET') {
    return sendJson(res, 200, { items: await xzQueue.all() });
  }

  if (p === '/api/xyz/queue' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (body.clear) {
        return sendJson(res, 200, { items: await xzQueue.clear() });
      }
      const items = await xzQueue.push(body.item || body);
      return sendJson(res, 200, { items: items });
    } catch (e) {
      return sendJson(res, 500, { error: String(e.message || e) });
    }
  }

  if (p === '/api/appinfo' && req.method === 'GET') {
    return sendJson(res, 200, {
      root: ROOT,
      dataDir: DATA,
      port: PORT,
      node: process.version,
      platform: process.platform,
    });
  }

  if (p === '/api/open' && req.method === 'POST') {
    const body = await readBody(req);
    const abs = path.resolve(String(body.path || ''));
    let ok = false;
    try { ok = fs.statSync(abs).isDirectory(); } catch (e) { ok = false; }
    if (!ok) return sendJson(res, 400, { error: '目录不存在：' + abs });
    shellOpen(abs);
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/reveal' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const abs = safeResolve(body.path);
      if (body.select) shellReveal(abs);
      else shellOpen(abs);
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: String(e.message || e) });
    }
  }

  return sendJson(res, 404, { error: '没有这个接口' });
}

const IMG_PREFIX = '/notes-img/';

function serveNoteImage(req, res, u) {
  const rel = decodeURIComponent(u.pathname.slice(IMG_PREFIX.length));
  const safe = path.basename(rel);                     // 只允许纯文件名，防穿越
  if (!/^[\w.-]+$/.test(safe)) { res.writeHead(400); return res.end('bad name'); }
  const abs = path.join(NOTES_IMG_DIR, safe);
  fs.stat(abs, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('404'); }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'max-age=86400',
    });
    fs.createReadStream(abs).pipe(res);
  });
}

async function serveStatic(req, res, u) {
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const st = await fsp.stat(abs);
    if (st.isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (u.pathname.indexOf(IMG_PREFIX) === 0) return serveNoteImage(req, res, u);
    if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u);
    return await serveStatic(req, res, u);
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
});

ensureAutostart().catch(function (e) { console.error('[autostart]', e.message); });

server.listen(PORT, HOST, () => {
  console.log('');
  console.log("  桌贴 · Daddy's DeskStick 已启动");
  console.log('  →  http://' + HOST + ':' + PORT + '/');
  console.log('');
  console.log('  可浏览目录（界面上可增删）：');
  rootList().forEach((r) => console.log('    ' + (r.exists ? '· ' : '× ') + r.path + (r.exists ? '' : '  (不存在)')));
  console.log('');
  console.log('');
});
