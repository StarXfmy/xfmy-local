/* 发布层：把「未来几天」压成一份 widget.json，用 GitHub Contents API 写回自己的仓库，
   桌面上的小组件（iOS 的 Scriptable、安卓/鸿蒙的网页挂件）按固定 URL 去取它。

   四条约定，改这块代码前先看清楚：
   · 只有显式点「发布」或开了自动发布才联网；失败只提示，绝不影响本机数据——
     本机的真相始终在 IndexedDB 里，widget.json 只是一份对外可见的影子。
   · 凭证单独存一个 key（前缀 + '-auth'），不进 prefs、不进同步包、也绝不写进快照。
   · 快照按天铺开（days[]），不是只发「今天」。小组件多久刷一次由系统说了算，
     夜里过了零点它可能还挂着昨天那份；发未来几天的数据，让取的一方按自己
     的本地日期挑当天，跨零点就自己好了。天气只发当天那份并标日期。
   · 「发什么」可收紧：仓库是公开的，待办文字未必愿意让别人读到。 */
import * as M from './model.js';
import * as T from './timetable.js';
import * as N from './net.js';

const NS = 'xfmy-github';
const CFG_KEY = NS + '-cfg';
const AUTH_KEY = NS + '-auth';
const API = 'https://api.github.com';

/** 发布范围，从松到紧。默认走中间那档。 */
export const SCOPES = [
  ['full', '课程 + 待办文字 + 日程文字 + 出门建议'],
  ['lite', '课程与日程，待办只报条数'],
  ['count', '只发课程名和时间']
];

/* ---------------------------------------------------------------- 配置与凭证 */

export function cfg() {
  var out = {};
  try { out = JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {}; } catch (e) { out = {}; }
  return out;
}

export function setCfg(patch) {
  var next = Object.assign(cfg(), patch || {});
  if (next.secret !== undefined) {          // 凭证走自己的 key，别和这堆混在一起
    delete next.secret;
    if (patch.secret) localStorage.setItem(AUTH_KEY, String(patch.secret).trim());
    else localStorage.removeItem(AUTH_KEY);
  }
  try { localStorage.setItem(CFG_KEY, JSON.stringify(next)); } catch (e) { /* 存不下就这次不记 */ }
  return next;
}

export function secret() { return localStorage.getItem(AUTH_KEY) || ''; }

export function ready() {
  var c = cfg();
  return !!(c.owner && c.repo && secret());
}

/** 小组件要读的那个公开地址。没发布过也给个样子，好让人知道往哪填。
   域名和仓库路径从配置里推，不写死：换仓库或换 Pages 域名时这里跟着变。 */
export function publicUrl() {
  var c = cfg();
  var owner = (c.owner || 'starxfmy').toLowerCase();
  var repo = c.repo || 'xfmy-local';
  return 'https://' + owner + '.github.io/' + repo + '/' + repoPath();
}

function repoPath() {
  return String(cfg().path || 'widget.json').replace(/^\/+/, '');
}

/** 换一个猜不到的文件名。仓库是公开的，路径本身就是唯一的访问控制——
   默认的 widget.json 太规整，等于半公开；带上随机尾巴才好得多。
   注意：改完要重新发布一次，旧名字那份还留在仓库里（要彻底消失得去仓库手动删）。 */
export function randomPath() {
  var s = '';
  var abc = 'abcdefghijkmnpqrstuvwxyz23456789';   // 去掉容易看错的 1/l/0/o
  for (var i = 0; i < 6; i++) s += abc.charAt(Math.floor(Math.random() * abc.length));
  return 'widget-' + s + '.json';
}

/* ---------------------------------------------------------------- 纯计算部分 */

function pad2(n) { return (n < 10 ? '0' : '') + String(n); }

/** YYYY-MM-DD 往后挪几天，照样跨月跨年。用正午那个时刻，避开夏令时导致的 ±1 天。 */
function shiftDay(ds, dy) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ds || ''));
  if (!m) return '';
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (dy || 0), 12, 0, 0);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 待办分组：欠着的（含没定日期）在前、今天的在后，跟 views.js 里 groupTodos 同一口径。 */
function todoGroups(todos, ds) {
  var late = [], today = [];
  (todos || []).forEach(function (t) {
    if (t.done) return;
    if (!t.date) { late.push({ text: t.text, when: '没定日期', late: true }); return; }
    if (t.date === ds) today.push({ text: t.text, when: '今天' });
    else if (t.date < ds) late.push({ text: t.text, when: '拖了 ' + T.dayGap(t.date, ds) + ' 天', late: true });
  });
  return { late: late, today: today };
}

function cut(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** 农历一行：lunar.js 把 Solar 挂在 window 上，取不到就空着——别让它拖垮整份快照。 */
function lunarOf(ds) {
  try {
    if (typeof window === 'undefined' || !window.Solar) return '';
    var lun = window.Solar.fromDate(new Date(ds + 'T12:00:00')).getLunar();
    var d = lun.getDayInChinese();
    return d === '初一' ? lun.getMonthInChinese() + '月' : d;
  } catch (e) { return ''; }
}

/** 发几天：钳到 1..7。
    输入框的 max 只是界面提示，手打的数字照样能存进配置（有人填过 365，
    快照立刻涨到 104 KB，Scriptable 小组件读这种体积会超时，反而什么都显示不出来）。 */
export function clampDays(n) {
  var v = Math.floor(Number(n));
  if (!isFinite(v) || v <= 0) return 5;
  return v > 7 ? 7 : v;
}

/**
 * 生成快照。数据全从 src 给，这个函数不碰网络也不碰存储，能单独跑测试。
 *   src = { doc, todos, events, day, minutes, tz, wx, tips, appUrl, at }
 */
export function snapshotOf(src, opts) {
  var o = Object.assign({ scope: 'full', days: 5, maxRows: 8 }, opts || {});
  o.days = clampDays(o.days);
  var doc = src.doc || { periods: [], courses: [], termStart: '' };
  var start = String(src.day || ''), scope = o.scope;
  var days = [];
  for (var i = 0; i < o.days; i++) {
    var ds = shiftDay(start, i);
    if (!ds) break;
    var isToday = i === 0;
    var list = T.coursesOn(doc, ds);
    var g = todoGroups(src.todos, ds);
    var evs = (src.events || []).filter(function (e) {
      // 生日是每年重复的，占小组件地方；日历页看就行
      if (e.kind === 'birthday' || e.kind === 'lunar-birthday') return false;
      return e.date === ds;
    });
    var rows = list.slice(0, o.maxRows).map(function (c) {
      var r = T.lessonRange(c, doc.periods);
      return {
        when: T.courseWhen(c, doc.periods),
        name: cut(c.name, 20),
        room: scope === 'count' ? '' : cut(c.room || '', 16),
        now: isToday && !!r && src.minutes >= r.from && src.minutes < r.to
      };
    });
    // 倒计时只对「今天」有意义；往后几天按 0 点算，等于给个「第一节是什么时候」
    var nl = T.nextLesson(doc, ds, isToday ? src.minutes : 0);
    var next = null;
    if (nl && !nl.empty) {
      if (nl.inClass) next = { text: '在上 ' + cut(nl.course.name, 16) + ' · 剩 ' + T.humanLeft(nl.minutes), state: 'in' };
      else if (!nl.finished) next = { text: '下一节 ' + cut(nl.course.name, 16) + ' · ' + T.humanLeft(nl.minutes) + '后', state: 'soon' };
      else next = { text: '今天的 ' + list.length + ' 节课上完了', state: 'done' };
    }
    var nTodo = g.today.length + g.late.length;
    var item = {
      date: ds,
      weekday: WD[T.dowOf(ds) - 1] || '',
      lunar: lunarOf(ds),
      week: T.weekOfTerm(doc.termStart, ds) || null,
      courseCount: list.length,
      courses: rows,
      moreCourses: Math.max(0, list.length - rows.length),
      next: next,
      todoCount: nTodo,
      lateCount: g.late.length,
      eventCount: evs.length,
      summary: (list.length ? list.length + ' 节课' : '没课') + (nTodo ? ' · ' + nTodo + ' 件待办' : '')
    };
    // 待办文字只有 full 档给（lite 只报条数）；日程文字到 lite 档为止，count 档全省
    if (scope === 'full') {
      item.todos = (isToday ? g.late.concat(g.today) : g.today).slice(0, o.maxRows)
        .map(function (x) { return { text: cut(x.text, 40), when: x.when, late: !!x.late }; });
    }
    if (scope !== 'count') {
      item.events = evs.slice(0, o.maxRows)
        .map(function (e) { return { title: cut(e.title, 24), kind: e.kind === 'event' ? '日程' : '生日' }; });
    }
    days.push(item);
  }
  var wx = null;
  if (src.wx && src.wx.city && src.wx.current) {
    wx = {
      date: start, city: src.wx.city,
      text: src.wx.current.text, temp: src.wx.current.temp, wind: src.wx.current.wind,
      min: src.wx.today ? src.wx.today.min : null, max: src.wx.today ? src.wx.today.max : null,
      pop: src.wx.today ? src.wx.today.pop : null,
      offline: !!src.wx.offline, ago: src.wx.ago || ''
    };
  }
  return {
    v: 2,
    at: src.at || M.now(),
    tz: src.tz || 'Asia/Shanghai',
    scope: scope,
    appUrl: src.appUrl || '',
    colors: { bg: '#f6ead8', card: '#fffdf7', ink: '#33291d', sub: '#7a6a55', accent: '#c8863c', warn: '#b3402f' },
    days: days,
    wx: wx,
    tips: scope === 'full' ? (src.tips || []) : []
  };
}

/* ---------------------------------------------------------------- 取数并组装 */

function cityPref() {
  var v = M.pref('city', null);
  return v && typeof v.lat === 'number' ? v : { name: '绍兴', lat: 30.002, lon: 120.579 };
}

/** 天气取不到就让 wx 空着，别因为一个接口挂了就发不出去。 */
async function weatherBlock(tz, day) {
  try {
    var r = await N.getWeather(cityPref());
    return {
      wx: { city: r.data.city, current: r.data.current, today: r.data.today, offline: r.offline, ago: N.agoLabel(r.at) },
      tips: N.advice(r.data)
    };
  } catch (e) { return { wx: null, tips: [] }; }
}

export async function buildSnapshot(opts) {
  var c = cfg(), o = opts || {};
  // 调用方可能传 {scope:undefined}（配置还没填），Object.assign 会把默认值盖掉，所以逐项判过
  var scope = o.scope || c.scope || 'lite';
  var days = clampDays(o.days || c.days);
  var tz = M.pref('tz', 'Asia/Shanghai');
  var t = T.tzNow(tz);
  var block = await weatherBlock(tz, t.day);
  return snapshotOf({
    doc: M.timetableDoc(),
    todos: M.todos(),
    events: M.events(),
    day: t.day,
    minutes: t.minutes,
    tz: tz,
    wx: block.wx,
    tips: block.tips,
    appUrl: (typeof location !== 'undefined' && location.origin && location.origin.indexOf('http') === 0
      ? location.origin : 'https://starxfmy.github.io') + '/xfmy-local/kernel/index.html#today'
  }, { days: days, scope: scope });
}

/* ---------------------------------------------------------------- 写回仓库 */

function b64(str) {
  var by = new TextEncoder().encode(str), s = '';
  for (var i = 0; i < by.length; i++) s += String.fromCharCode(by[i]);
  return btoa(s);
}

async function api(path, init) {
  var res = await fetch(API + path, {
    method: init && init.method ? init.method : 'GET',
    credentials: 'omit',
    headers: {
      'Authorization': 'Bearer ' + secret(),
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: init && init.body ? init.body : undefined
  });
  if (res.status === 401) throw new Error('凭证不对，或没有这个仓库的 Contents 写权限（要 fine-grained）');
  if (res.status === 403) throw new Error('GitHub 回 403：多半是限流，或仓库开了分支保护');
  if (res.status === 404) return null;             // 文件还不存在，走「新建」那一支
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    // 别把状态码就丢掉：409 要拿它的 message 判要不要重读 sha 再试一次
    var err = new Error('接口回 ' + res.status + (data && data.message ? '：' + data.message : ''));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/**
 * 内容指纹：自动发布靠它挡掉"内容没变又提交一次"。
 * 只算真正的内容（days/wx/tips/scope），at 每次都是新的，算进去就永远判成变了、
 * 每次保存都会往仓库提一笔。倒计时写进了 days，所以时间真的推进了照样会重新发。
 */
function fingerprint(snap) {
  var s = JSON.stringify({ d: snap.days, w: snap.wx, t: snap.tips, s: snap.scope });
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + s.length;
}

/** 手动点按钮是 force（内容没变也重新提交一次）；自动发布不是。 */
export async function publish(opts) {
  var o = opts || {}, c = cfg();
  if (!c.owner || !c.repo) throw new Error('先填 owner 和仓库名');
  if (!secret()) throw new Error('先填访问令牌');
  var snap = await buildSnapshot({ scope: c.scope, days: c.days });
  var json = JSON.stringify(snap);
  var fp = fingerprint(snap);
  if (!o.force && fp === c.lastFp) return { skipped: true, report: '跟上次一样，没重复提交' };

  var path = repoPath();
  var base = '/repos/' + c.owner + '/' + c.repo + '/contents/' + path;
  var body = {
    message: 'widget: 快照 ' + snap.days[0].date + '（' + snap.scope + '）',
    content: b64(json),
    branch: c.branch || 'main'
  };
  var commit = function () { return api(base, { method: 'PUT', body: JSON.stringify(body) }); };
  var cur = await api(base);
  if (cur && cur.sha) body.sha = cur.sha;          // 覆盖已有文件必须带它的 sha，否则 422
  try {
    var r = await commit();
    return done(r, fp, json, path, snap);
  } catch (e) {
    if (e.status !== 409) throw e;
    // 别处（电脑上、网页上）刚改过这个文件：重读 sha 再试一次，还失败就如实报
    var fresh = await api(base);
    if (!fresh || !fresh.sha) throw new Error('提交冲突，而且读不回文件当前版本');
    body.sha = fresh.sha;
    return done(await commit(), fp, json, path, snap);
  }
}

function done(r, fp, json, path, snap) {
  if (!r || !r.commit) throw new Error('接口没给 commit，等于没提交成功');
  setCfg({ lastFp: fp, lastAt: Date.now(), lastSize: json.length, lastCommit: r.commit.sha });
  return { skipped: false, report: '已提交 ' + path + '，约 ' + (Math.round(json.length / 102.4) / 10) + ' KB',
    url: publicUrl(), snapshot: snap };
}

/** 给设置页「预览」用：不发出去，只把要发的东西打印到控制台 */
export async function previewSnapshot() {
  var s = await buildSnapshot({ scope: cfg().scope, days: cfg().days });
  console.log('widget.json 预览：\n' + JSON.stringify(s, null, 2));
  return s;
}

/* ---------------------------------------------------------------- 自动发布 */

let timer = null;

/** 本机数据每次落盘后调一下。开了自动发布就延后再发，输入框逐字保存不至于把 API 打爆。 */
export function autoAfterSave() {
  var c = cfg();
  if (!c.auto || !ready()) return;
  clearTimeout(timer);
  timer = setTimeout(function () {
    publish({ force: false })
      .then(function (r) { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('xfmy-published', { detail: r })); })
      .catch(function (e) { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('xfmy-publish-error', { detail: e.message || String(e) })); });
  }, Math.max(5, Number(c.delay) || 10) * 1000);
}
