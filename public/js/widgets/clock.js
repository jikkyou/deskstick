import { defineWidget } from '../registry.js';
import { el } from '../api.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];

const WMO = {
  0: ['☀', '晴'], 1: ['☀', '大致晴'], 2: ['⛅', '多云'], 3: ['☁', '阴'],
  45: ['🌫', '雾'], 48: ['🌫', '雾凇'],
  51: ['🌦', '小毛雨'], 53: ['🌦', '毛毛雨'], 55: ['🌧', '浓毛雨'],
  56: ['🌧', '冻毛雨'], 57: ['🌧', '冻毛雨'],
  61: ['🌧', '小雨'], 63: ['🌧', '中雨'], 65: ['🌧', '大雨'],
  66: ['🌧', '冻雨'], 67: ['🌧', '冻雨'],
  71: ['🌨', '小雪'], 73: ['🌨', '中雪'], 75: ['❄', '大雪'], 77: ['❄', '米雪'],
  80: ['🌦', '阵雨'], 81: ['🌧', '阵雨'], 82: ['⛈', '强阵雨'],
  85: ['🌨', '阵雪'], 86: ['❄', '强阵雪'],
  95: ['⛈', '雷阵雨'], 96: ['⛈', '雷雨冰雹'], 99: ['⛈', '强雷雨冰雹'],
};

const CACHE_MS = 8 * 60 * 1000;

/* wttr.in 的天气代码 → WMO 代码（open-meteo 那套） */
const WW_TO_WMO = {
  113: 0, 116: 2, 119: 3, 122: 3, 143: 45, 248: 45, 260: 48,
  176: 80, 179: 85, 182: 79, 185: 66, 200: 95, 227: 75, 230: 75,
  263: 51, 266: 53, 281: 56, 284: 57, 293: 61, 296: 63, 299: 63,
  302: 65, 305: 65, 308: 65, 311: 66, 314: 67, 317: 79, 320: 79,
  323: 71, 326: 73, 329: 73, 332: 75, 335: 75, 338: 75, 350: 79,
  353: 80, 356: 81, 359: 82, 362: 85, 365: 85, 368: 85, 371: 86,
  374: 79, 377: 79, 386: 95, 389: 96, 392: 95, 395: 99,
  149: 2,   // wttr 新码，实测会返回，按「多云」处理
};

/* 带超时的 fetch —— 默认 fetch 没有超时，网络不通会一直挂着 */
function fetchTimeout(url, ms) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms || 8000);
  return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
    .finally(function () { clearTimeout(timer); });
}

/* 解析 open-meteo 原始数据 */
function parseOpenMeteo(j) {
  const d = {
    temp: j.current.temperature_2m,
    feels: j.current.apparent_temperature,
    hum: j.current.relative_humidity_2m,
    wind: j.current.wind_speed_10m,
    code: j.current.weather_code,
    daily: [],
    hours: [],
    src: 'open-meteo',
  };

  if (j.daily && j.daily.time) {
    for (let i = 0; i < j.daily.time.length; i++) {
      d.daily.push({
        date: j.daily.time[i],
        code: j.daily.weather_code[i],
        max: j.daily.temperature_2m_max[i],
        min: j.daily.temperature_2m_min[i],
        prob: j.daily.precipitation_probability_max ? j.daily.precipitation_probability_max[i] : null,
        mm: j.daily.precipitation_sum ? j.daily.precipitation_sum[i] : null,
      });
    }
  }

  if (j.hourly && j.hourly.time) {
    const today = j.daily.time[0];
    for (let i = 0; i < j.hourly.time.length; i++) {
      const t = j.hourly.time[i];
      if (t.slice(0, 10) !== today) continue;
      d.hours.push({
        hour: Number(t.slice(11, 13)),
        mm: j.hourly.precipitation[i] || 0,
        prob: j.hourly.precipitation_probability[i] == null ? 0 : j.hourly.precipitation_probability[i],
      });
    }
  }
  return d;
}

/* 解析 wttr.in 原始数据 */
function parseWttr(j) {
  const c = (j.current_condition || [])[0];
  if (!c) throw new Error('wttr.in 无当前数据');

  const d = {
    temp: Number(c.temp_C),
    feels: Number(c.FeelsLikeC),
    hum: Number(c.humidity),
    wind: Number(c.windspeedKmph),
    code: (WW_TO_WMO[Number(c.weatherCode)] !== undefined ? WW_TO_WMO[Number(c.weatherCode)] : 2),
    daily: [],
    hours: [],
    src: 'wttr.in',
  };

  (j.weather || []).slice(0, 4).forEach(function (day) {
    const hs = day.hourly || [];
    const mid = hs[4] || hs[0];
    let maxProb = 0, sumMm = 0;
    hs.forEach(function (h) {
      const p = Number(h.chanceofrain) || 0;
      if (p > maxProb) maxProb = p;
      sumMm += Number(h.precipMM) || 0;
    });
    const code = mid ? (WW_TO_WMO[Number(mid.weatherCode)] !== undefined ? WW_TO_WMO[Number(mid.weatherCode)] : 3) : 3;
    d.daily.push({
      date: day.date,
      code: code,
      max: Number(day.maxtempC),
      min: Number(day.mintempC),
      prob: maxProb,
      mm: sumMm,
    });
  });

  const today = (j.weather || [])[0];
  if (today && today.hourly) {
    today.hourly.forEach(function (h) {
      d.hours.push({
        hour: Math.floor((Number(h.time) || 0) / 100),
        mm: Number(h.precipMM) || 0,
        prob: Number(h.chanceofrain) || 0,
      });
    });
  }
  return d;
}

/* 天气统一走本地后端代理 —— wttr.in 和 open-meteo 都不发 CORS 头，
 * 浏览器直接 fetch 会被拦，所以必须由 Node 侧转发。 */
async function getWeather(lat, lon) {
  const key = 'wx2:' + lat + ',' + lon;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (cached && Date.now() - cached.t < CACHE_MS) return cached.d;
  } catch (e) { /* ignore */ }

  try {
    const r = await fetchTimeout('/api/weather?lat=' + encodeURIComponent(lat)
      + '&lon=' + encodeURIComponent(lon), 22000);
    if (!r.ok) throw new Error('天气代理 HTTP ' + r.status);
    const pack = await r.json();
    if (!pack.ok) throw new Error(pack.error || '天气源不可用');

    const d = pack.src === 'wttr' ? parseWttr(pack.data) : parseOpenMeteo(pack.data);
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: d }));
    return d;
  } catch (e) {
    // 拿不到新的就用上次的，界面上标「离线」
    try {
      const stale = JSON.parse(localStorage.getItem(key) || 'null');
      if (stale && stale.d) return Object.assign({}, stale.d, { stale: true });
    } catch (e2) { /* ignore */ }
    throw e;
  }
}


/** 24 小时降水柱状图 */
function rainChart(hours) {
  const box = el('div', 'rain-box');
  if (!hours.length) return box;

  const maxP = Math.max(15, Math.max.apply(null, hours.map(function (h) { return h.prob; })));
  const bars = el('div', 'rain-bars');
  hours.forEach(function (h) {
    const b = el('div', 'rain-bar');
    b.style.height = Math.max(3, Math.round((h.prob / maxP) * 100)) + '%';
    if (h.mm >= 2) b.style.background = 'linear-gradient(180deg,#6fb2ff,#2f6fd0)';
    else if (h.mm > 0) b.style.background = 'linear-gradient(180deg,#8ec5ff,#4a8fff)';
    else if (h.prob >= 40) b.style.background = 'rgba(120,170,240,.55)';
    else b.style.background = 'rgba(150,175,210,.22)';
    b.title = String(h.hour).padStart(2, '0') + ':00　概率 ' + h.prob + '%　' + h.mm.toFixed(1) + ' mm';
    bars.append(b);
  });

  const axis = el('div', 'rain-axis');
  ['0', '6', '12', '18', '24'].forEach(function (t) { axis.append(el('span', '', t + '时')); });

  const total = hours.reduce(function (s, h) { return s + h.mm; }, 0);
  const peak = hours.reduce(function (m, h) { return Math.max(m, h.prob); }, 0);

  const top = el('div', 'rain-top');
  top.append(
    el('span', 'rain-label', '24 小时降水'),
    el('span', 'rain-sum', total > 0
      ? '预计 ' + total.toFixed(1) + ' mm · 概率峰值 ' + peak + '%'
      : '今日无降水 · 概率峰值 ' + peak + '%'),
  );

  const total0 = hours.reduce(function (s2, h) { return s2 + h.mm; }, 0);
  const peak0 = hours.reduce(function (m, h) { return Math.max(m, h.prob); }, 0);
  if (total0 < 0.1 && peak0 < 10) {
    box.className = 'rain-box dry';
    bars.className = 'rain-bars';
    const note = el('div', 'rain-note', '全天无降水');
    const mid = el('div', 'rain-mid');
    mid.append(note);
    box.append(top, mid, bars, axis);
    return box;
  }

  box.append(top, bars, axis);
  return box;
}

/** 未来三天 */
function forecastRow(daily) {
  const row = el('div', 'fc-row');
  const list = daily.slice(1, 4);
  if (!list.length) return row;

  const names = ['明天', '后天', '大后天'];
  list.forEach(function (d, i) {
    const w = WMO[d.code] || ['·', ''];
    const dd = new Date(d.date + 'T00:00:00');

    const item = el('div', 'fc-item');
    item.append(el('div', 'fc-day', names[i] || ''));
    item.append(el('div', 'fc-ico', w[0]));
    const t = el('div', 'fc-temp');
    t.innerHTML = '<b>' + Math.round(d.max) + '°</b><span class="fc-sep">/</span>' + Math.round(d.min) + '°';
    item.append(t);
    if (d.prob != null && d.prob > 0) item.append(el('div', 'fc-prob', '雨 ' + d.prob + '%'));
    item.title = (dd.getMonth() + 1) + '月' + dd.getDate() + '日 · ' + w[1];
    row.append(item);
  });
  return row;
}

defineWidget({
  type: 'clock',
  name: '时间 · 天气',
  size: { w: 445, h: 398 },
  config: { lat: 30.67, lon: 104.07, city: '成都' },

  render(body, ctx) {
    // 和默认配置合并：layout.json 里 config 是 {} 时也能拿到 lat/lon/city
    const cfg = Object.assign({ lat: 30.67, lon: 104.07, city: '成都' },
                              ctx.model.config || (ctx.model.config = {}));
    const wrap = el('div', 'clock-wrap');
    const timeEl = el('div', 'clock-time');
    const dateEl = el('div', 'clock-date');
    const nowBox = el('div', 'weather-now');
    const fcBox = el('div', 'fc-box');
    const rainBox = el('div', 'rain-slot');
    wrap.append(timeEl, dateEl, nowBox, fcBox, rainBox);
    body.append(wrap);

    function tick() {
      const d = new Date();
      const p = function (n) { return String(n).padStart(2, '0'); };
      timeEl.innerHTML = p(d.getHours()) + ':' + p(d.getMinutes()) + '<span class="sec">:' + p(d.getSeconds()) + '</span>';
      dateEl.textContent = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 · 星期' + WD[d.getDay()];
    }
    tick();
    const timer = setInterval(tick, 1000);

    let cancelled = false;
    const obs = new MutationObserver(function () {
      if (!document.body.contains(wrap)) { clearInterval(timer); cancelled = true; obs.disconnect(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    nowBox.innerHTML = '<div class="wx-loading">天气加载中…</div>';

    function paintWeather(w) {
      if (cancelled) return;
      try {
      const meta = WMO[w.code] || ['·', '未知'];

      nowBox.innerHTML = '';
      nowBox.append(el('div', 'wn-ico', meta[0]));
      nowBox.append(el('div', 'wn-temp', Math.round(w.temp) + '°'));
      const m = el('div', 'wn-meta');
      m.innerHTML = '<b>' + cfg.city + ' · ' + meta[1]
        + (w.stale ? ' <span class="wx-stale">· 离线</span>' : '')
        + '</b><br>体感 ' + Math.round(w.feels)
        + '° · 湿度 ' + w.hum + '% · 风 ' + Math.round(w.wind) + ' km/h';
      nowBox.append(m);

      fcBox.innerHTML = '';
      if (w.daily && w.daily.length > 1) fcBox.append(forecastRow(w.daily));

      rainBox.innerHTML = '';
      if (w.hours && w.hours.length) rainBox.append(rainChart(w.hours));
      } catch (err) {
        console.error('[weather] 绘制失败:', err && err.stack ? err.stack : err);
        nowBox.innerHTML = '<div class="wx-loading">天气绘制失败：' + (err && err.message ? err.message : err) + '</div>';
      }
    }

    // 每 10 分钟自己刷一次；失败保留上一次的画面，不清空
    const WEATHER_EVERY = 10 * 60 * 1000;
    let wxTimer = null;
    function loadWeather(first) {
      if (cancelled) return;
      if (!first && !nowBox.children.length) nowBox.innerHTML = '<div class="wx-loading">天气加载中…</div>';
      getWeather(cfg.lat, cfg.lon)
        .then(paintWeather)
        .catch(function (e) {
          console.error('[weather] 失败:', e && e.stack ? e.stack : e);
          if (cancelled) return;
          // 从来没成功过才显示错误；有旧画面就让它留着
          if (!nowBox.children.length || nowBox.querySelector('.wx-loading')) {
            nowBox.innerHTML = '<div class="wx-loading">天气连不上，稍后自动重试</div>';
          }
        });
    }
    loadWeather(true);
    wxTimer = setInterval(function () { loadWeather(false); }, WEATHER_EVERY);
    // 卡片被移除时停掉
    const wxObs = new MutationObserver(function () {
      if (!document.body.contains(wrap)) { clearInterval(wxTimer); wxObs.disconnect(); }
    });
    wxObs.observe(document.body, { childList: true, subtree: true });

  },
});
