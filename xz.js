/**
 * 小宇宙（Xiaoyuzhou FM）API 封装
 *
 * 登录：二维码（手机 App 扫码），token 通过响应头下发
 *   1. POST web-api…/v1/auth/qrcode/create  {clientId:"xyz-web"}  -> {id, url}
 *   2. POST web-api…/v1/auth/qrcode/login   {id, clientId}         -> {status}
 *      status: WAITTING -> SCANNED -> USED（USED = 登录完成，响应头带 token）
 *
 * 业务：api.xiaoyuzhoufm.com，带 x-jike-access-token 头
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const fsp = fs.promises;

const HOST_LOGIN = 'web-api.xiaoyuzhoufm.com';
const HOST_API = 'api.xiaoyuzhoufm.com';
const CLIENT_ID = 'xyz-web';
const MIDWAY_APP_ID = 'v6worU4NnWyL';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

function request(host, method, pathname, body, token, extraHeaders) {
  return new Promise((resolve) => {
    const data = body !== null && body !== undefined ? JSON.stringify(body) : null;
    const headers = {
      accept: 'application/json, text/plain, */*',
      'user-agent': UA,
      origin: 'https://www.xiaoyuzhoufm.com',
      referer: 'https://www.xiaoyuzhoufm.com/',
      'x-midway-app-id': MIDWAY_APP_ID,
    };
    if (token) headers['x-jike-access-token'] = token;
    if (extraHeaders) Object.assign(headers, extraHeaders);
    if (data) {
      headers['content-type'] = 'application/json;charset=UTF-8';
      headers['content-length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: host, path: pathname, method, headers, timeout: 20000 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, headers: {}, body: e.message, json: null }));
    if (data) req.write(data);
    req.end();
  });
}

class XyzStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'xiaoyuzhou.json');
    this.data = { access: '', refresh: '', savedAt: 0, user: null };
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this.data;
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      this.data = Object.assign({ access: '', refresh: '', savedAt: 0, user: null }, JSON.parse(raw));
    } catch (e) { /* 首次运行没有文件 */ }
    this.loaded = true;
    return this.data;
  }

  async save(patch) {
    await this.load();
    Object.assign(this.data, patch, { savedAt: Date.now() });
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    return this.data;
  }

  async clear() {
    this.data = { access: '', refresh: '', savedAt: 0, user: null };
    this.loaded = true;
    try { await fsp.unlink(this.file); } catch (e) { /* 已不存在 */ }
  }

  async token() {
    await this.load();
    return this.data.access || '';
  }
}

// 二维码状态缓存（服务端轮询，前端只看结果）
const qrSessions = new Map();
let QR = null; // 由 init 注入 qrcode 库

async function qrCreate() {
  const r = await request(HOST_LOGIN, 'POST', '/v1/auth/qrcode/create', { clientId: CLIENT_ID });
  if (r.status !== 200 || !r.json) throw new Error('创建二维码失败：' + r.body.slice(0, 120));
  const { id, url } = r.json;
  let dataUrl = '';
  if (QR) {
    try { dataUrl = await QR.toDataURL(url, { width: 260, margin: 1 }); } catch (e) { /* 前端可自行渲染 */ }
  }
  return { id, url, qr: dataUrl };
}

async function qrCheck(id) {
  const r = await request(HOST_LOGIN, 'POST', '/v1/auth/qrcode/login', { id, clientId: CLIENT_ID });
  const status = (r.json && r.json.status) || 'UNKNOWN';
  const out = { status, http: r.status };
  if (status === 'USED' || status === 'CONFIRMED') {
    const access = r.headers['x-jike-access-token'];
    const refresh = r.headers['x-jike-refresh-token'];
    if (access) {
      out.access = access;
      out.refresh = refresh || '';
    }
  }
  return out;
}

async function getMe(token) {
  const r = await request(HOST_LOGIN, 'GET', '/web/user/get-me', null, token);
  if (r.status !== 200 || !r.json) return { error: r.status, body: r.body.slice(0, 200) };
  return r.json.data || r.json;
}

function subscriptionList(token, limit, loadMoreKey) {
  const body = { sortBy: 'subscribedAt', limit: limit || 50 };
  if (loadMoreKey) body.loadMoreKey = loadMoreKey;
  return request(HOST_API, 'POST', '/v1/subscription/list', body, token);
}

function episodeList(token, pid, limit, loadMoreKey) {
  const body = { pid, limit: limit || 30 };
  if (loadMoreKey) body.loadMoreKey = loadMoreKey;
  return request(HOST_API, 'POST', '/v1/episode/list', body, token);
}

function playHistory(token, limit) {
  return request(HOST_API, 'POST', '/v1/episode-played/list',
    { limit: limit || 30, loadMoreKey: null }, token);
}

function starList(token) {
  return request(HOST_API, 'POST', '/v1/subscription-star/list', {}, token);
}

// ── 首页发现 feed（含 编辑精选 / 榜单 / 分类） ──
function discoveryFeed(token, loadMoreKey) {
  const body = {};
  if (loadMoreKey) body.loadMoreKey = loadMoreKey;
  return request(HOST_API, 'POST', '/v1/discovery-feed/list', body, token);
}

// ── 编辑精选（近若干天） ──
function editorPick(token, loadMoreKey) {
  const body = {};
  if (loadMoreKey) body.loadMoreKey = loadMoreKey;
  return request(HOST_API, 'POST', '/v1/editor-pick/list', body, token);
}

/* ── 播放进度（本地存，不依赖服务端） ── */

// 收藏相关需要 App 端 header（favorite/list 缺了就是 rpc_error）
function appHeaders(token) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '+08:00');
  return {
    'Host': HOST_API,
    'User-Agent': 'Xiaoyuzhou/2.57.1 (build:1576; iOS 17.4.1)',
    'Market': 'AppStore',
    'App-BuildNo': '1576',
    'OS': 'ios',
    'x-jike-access-token': token,
    'Manufacturer': 'Apple',
    'BundleID': 'app.podcast.cosmos',
    'Connection': 'keep-alive',
    'abtest-info': '{}',
    'Accept-Language': 'zh-Hans-CN;q=1.0, zh-Hant-TW;q=0.9',
    'Model': 'iPhone14,2',
    'app-permissions': '4',
    'Accept': '*/*',
    'App-Version': '2.57.1',
    'WifiConnected': 'true',
    'OS-Version': '17.4.1',
    'x-custom-xiaoyuzhou-app-dev': '',
    'Local-Time': now,
    'Timezone': 'Asia/Shanghai',
    'x-jike-device-properties': '',
    'x-jike-device-id': '',
  };
}

function favoriteUpdate(token, eid, favorited) {
  return request(HOST_API, 'POST', '/v1/favorite/update', {
    eid: eid,
    favorited: !!favorited,
    sourcePageName: 8,
    currentPageName: 9,
  }, token, appHeaders(token));
}

function favoriteList(token) {
  return request(HOST_API, 'POST', '/v1/favorite/list', {}, token, appHeaders(token));
}

// 播放队列（本地）
class QueueStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'xyz-queue.json');
    this.items = [];
    this.loaded = false;
    this.MAX = 60;
  }

  async load() {
    if (this.loaded) return this.items;
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const d = JSON.parse(raw);
      this.items = Array.isArray(d) ? d : (d.items || []);
    } catch (e) { this.items = []; }
    this.loaded = true;
    return this.items;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.items, null, 2), 'utf8');
  }

  async all() {
    await this.load();
    return this.items;
  }

  // 加一条（同一 eid 不重复，移到最前）
  async push(item) {
    await this.load();
    if (!item || !item.eid) return this.items;
    this.items = this.items.filter((x) => x.eid !== item.eid);
    this.items.unshift({
      eid: item.eid,
      pid: item.pid || '',
      title: item.title || '',
      podcast: (item.podcast && item.podcast.title) || '',
      image: (item.image && item.image.picUrl) || item.image || '',
      duration: item.duration || 0,
      url: (item.enclosure && item.enclosure.url) || '',
      at: Date.now(),
    });
    if (this.items.length > this.MAX) this.items.length = this.MAX;
    await this.save();
    return this.items;
  }

  async clear() {
    this.items = [];
    this.loaded = true;
    await this.save();
    return this.items;
  }
}

// 用 refresh token 换新 access（接口是 Rails 风格路径，不是 /v1/auth/*）
async function refreshToken(refresh) {
  if (!refresh) return null;
  const r = await request(HOST_LOGIN, 'POST', '/app_auth_tokens.refresh', {}, null, {
    'x-jike-refresh-token': refresh,
  });
  if (r.status !== 200) return null;
  const access = r.headers['x-jike-access-token'];
  if (!access) return null;
  return { access: access, refresh: r.headers['x-jike-refresh-token'] || refresh };
}

class ProgressStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'xyz-progress.json');
    this.data = {};
    this.loaded = false;
    this.MAX = 200;   // 最多留 200 条，按时间淘汰
  }

  async load() {
    if (this.loaded) return this.data;
    try {
      this.data = JSON.parse(await fsp.readFile(this.file, 'utf8')) || {};
    } catch (e) { this.data = {}; }
    this.loaded = true;
    return this.data;
  }

  async get(eid) {
    await this.load();
    return this.data[eid] || null;
  }

  async all() {
    await this.load();
    return this.data;
  }

  async set(eid, pos, dur) {
    if (!eid) return null;
    await this.load();
    this.data[eid] = { pos: Math.max(0, Math.round(pos || 0)), dur: Math.round(dur || 0), at: Date.now() };
    const keys = Object.keys(this.data);
    if (keys.length > this.MAX) {
      keys.sort((a, b) => (this.data[a].at || 0) - (this.data[b].at || 0))
          .slice(0, keys.length - this.MAX)
          .forEach((k) => { delete this.data[k]; });
    }
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    return this.data[eid];
  }
}

module.exports = {
  request, HOST_API,
  XyzStore, ProgressStore, QueueStore, qrCreate, qrCheck, getMe, refreshToken,
  favoriteUpdate, favoriteList,
  subscriptionList, episodeList, playHistory, starList,
  discoveryFeed, editorPick,
  setQrLib: (lib) => { QR = lib; },
  qrSessions,
};
