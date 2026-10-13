/* 联网层：天气（Open-Meteo）与节假日（holiday-cn）。
   两条约定要守着：
   · 一律用 https 绝对地址 —— 手机的离线壳才知道哪些请求可以缓存回放；
   · 离线不能拿旧数据冒充实时 —— 自己记一份"上次成功是什么时候"，取不到新数据时如实标出来。
     （离线壳回吐缓存那份时状态码仍是 200，所以不能只看状态码，得看 navigator.onLine 和这份时间戳。） */

const WX_URL = function (city) {
  return 'https://api.open-meteo.com/v1/forecast?latitude=' + city.lat + '&longitude=' + city.lon
    + '&current_weather=true&timezone=Asia%2FShanghai&forecast_days=2'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode'
    + '&hourly=temperature_2m,weathercode,precipitation_probability';
};
/* 节假日取数顺序：先读**包内的本地副本**（kernel/holidays/年份.json），再退到外网。
   为什么：cdn.jsdelivr.net 在国内经常连不通（实测这台机器直接 000），而离线包里的副本
   由 Service Worker 预缓存，断网也有红「休」灰「班」。外网只当补充新年份数据用。
   每年 11～12 月官方公布下一年安排后，更新 kernel/holidays/ 下的文件即可。 */
const HOL_URLS = [
  function (y) { return 'holidays/' + y + '.json'; },
  function (y) { return 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/' + y + '.json'; },
  function (y) { return 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/' + y + '.json'; }
];

const WMO = {
  0: '晴', 1: '大致晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷雨', 96: '雷雨伴冰雹', 99: '雷雨伴冰雹'
};

const CACHE_KEY = 'xfmy-local-net';
const WX_TTL = 30 * 60 * 1000;          // 天气半小时内的缓存直接用，免得反复打接口
const HOL_TTL = 7 * 24 * 3600 * 1000;   // 节假日一年也改不了几次
const HOL_EMPTY_RETRY = 3600 * 1000;    // 取到空表（比如 2027 年官方还没公布）只挡 1 小时，别把空结果锁 7 天

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function writeCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* 存不下就算了，不影响这次显示 */ }
}

/** 数据新鲜度说人话：刚刚 / X 分钟前 / X 小时前 / X 天前 */
export function agoLabel(ms) {
  if (!ms) return '没有';
  var d = Date.now() - ms;
  if (d < 90000) return '刚刚';
  if (d < 3600000) return Math.round(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.round(d / 3600000) + ' 小时前';
  return Math.round(d / 86400000) + ' 天前';
}

function fetchJson(url, ms) {
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, ms || 12000) : null;
  return fetch(url, { credentials: 'omit', signal: ctrl ? ctrl.signal : undefined }).then(function (res) {
    if (timer) clearTimeout(timer);
    if (!res.ok) throw new Error('接口回 ' + res.status);
    return res.json();
  });
}

/* ---------------------------------------------------------------- 天气 */

function shape(d, city) {
  var cw = d && d.current_weather;
  if (!cw || typeof cw.temperature !== 'number') throw new Error('天气数据不完整');
  var day = (d && d.daily) || {}, hr = (d && d.hourly) || {};
  var today = {
    max: day.temperature_2m_max ? Math.round(day.temperature_2m_max[0]) : null,
    min: day.temperature_2m_min ? Math.round(day.temperature_2m_min[0]) : null,
    pop: day.precipitation_probability_max ? day.precipitation_probability_max[0] : null,
    text: WMO[(day.weathercode ? day.weathercode[0] : cw.weathercode)] || ''
  };
  var hours = [];
  if (hr.time && hr.time.length) {
    var nowIso = localHourIso();
    var start = 0;
    for (var i = 0; i < hr.time.length; i++) { if (hr.time[i].slice(0, 13) >= nowIso) { start = i; break; } }
    for (var k = start; k < Math.min(start + 24, hr.time.length); k++) {
      hours.push({
        time: String(hr.time[k]).slice(11, 16),
        temp: Math.round(hr.temperature_2m[k]),
        pop: hr.precipitation_probability ? hr.precipitation_probability[k] : null,
        text: WMO[hr.weathercode[k]] || ''
      });
    }
  }
  return {
    city: city.name,
    current: { temp: Math.round(cw.temperature), text: WMO[cw.weathercode] || '', wind: Math.round(cw.windspeed || 0) },
    today: today, hours: hours
  };
}

/** 数据时间戳是 Asia/Shanghai 的本地时间，比较也必须用同城时间，否则会多列出过去 8 小时 */
function localHourIso() {
  try {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
    }).formatToParts(new Date());
    var o = {};
    parts.forEach(function (p) { o[p.type] = p.value; });
    return o.year + '-' + o.month + '-' + o.day + 'T' + (o.hour === '24' ? '00' : o.hour);
  } catch (e) { return new Date().toISOString().slice(0, 13); }
}

/** 取天气。返回 {data, at, offline, note}：offline 为真时 data 是上次那份缓存。 */
export async function getWeather(city, force) {
  var c = readCache(), key = 'wx-' + city.lat + ',' + city.lon, hit = c[key];
  if (!force && hit && Date.now() - hit.at < WX_TTL) return { data: hit.data, at: hit.at, offline: false, cached: true };
  try {
    var d = shape(await fetchJson(WX_URL(city)), city);
    c[key] = { at: Date.now(), data: d };
    writeCache(c);
    return { data: d, at: c[key].at, offline: false };
  } catch (e) {
    if (hit) return { data: hit.data, at: hit.at, offline: true, note: e.message || String(e) };
    throw new Error('天气取不到（' + (e.message || e) + '），而且这台设备上还没有存过');
  }
}

/** 出行建议的规则版：不依赖任何后端，取到天气就能给 */
export function advice(w) {
  var out = [];
  if (!w || !w.today) return out;
  var max = w.today.max, min = w.today.min, pop = w.today.pop;
  if (max !== null && max >= 33) out.push('今天热（最高 ' + max + '°），出门带水，避开中午那段太阳');
  else if (min !== null && min <= 8) out.push('早上 ' + min + '°，外套别省');
  if (pop !== null && pop >= 50) out.push('降水概率 ' + pop + '%，伞塞包里');
  else if (pop !== null && pop >= 30) out.push('降水概率 ' + pop + '%，带不带伞看你顺路');
  if (/雨|雪/.test(w.current && w.current.text || '')) out.push('现在' + w.current.text + '，路上慢一点');
  if (/雷/.test(w.today.text || '')) out.push('今天有雷雨，别在树下躲');
  if (!out.length) out.push('天气平常，正常安排');
  return out;
}

/* ---------------------------------------------------------------- 节假日 */

/** 取某年节假日，返回 {map:{'2026-10-01':{name,off}}, at, offline}。取不到就回空表，日历照样能翻。 */
export async function getHolidays(year, force) {
  var c = readCache(), key = 'hol-' + year, hit = c[key];
  var ttl = (hit && hit.empty) ? HOL_EMPTY_RETRY : HOL_TTL;
  if (!force && hit && Date.now() - hit.at < ttl) return { map: hit.map, at: hit.at, offline: false, cached: true };
  for (var i = 0; i < HOL_URLS.length; i++) {
    try {
      var j = await fetchJson(HOL_URLS[i](year), 9000);
      var map = {};
      var days = (j && j.days) || {};
      Object.keys(days).forEach(function (k) {
        var d = days[k];
        if (d && d.date) map[d.date] = { name: String(d.name || ''), off: !!d.isOffDay };
      });
      // 空表只挡 1 小时：官方还没公布下一年时，别把"什么都没有"锁成一星期
      c[key] = { at: Date.now(), map: map, empty: Object.keys(map).length === 0 };
      writeCache(c);
      return { map: map, at: c[key].at, offline: false };
    } catch (e) { /* 换下一个源 */ }
  }
  if (hit && !hit.empty) return { map: hit.map, at: hit.at, offline: true };
  return { map: {}, at: 0, offline: true, none: true };
}
