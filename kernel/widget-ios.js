/* iOS 挂件脚本的模块版。由 手机版小组件/widget-ios.scriptable.js 生成，别单独改这份。
   发布时本地版会把它一起发到 Gitee，iPhone 上的加载器拉这个文件来跑。 */

module.exports.run = async function () {
// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: orange; icon-glyph: calendar-alt;
/*
 * Day Plan 桌面小组件
 * ------------------------------------------------------------------
 * 装 Scriptable（免费）→ 新建脚本 → 整份粘进来 → 桌面加一个 Scriptable 小组件并选这个脚本。
 *
 * 只读一个 URL：Day Plan 设置页「发布到桌面小组件」提交出去的 widget.json。
 * 小组件这边不做课表运算 —— 第几周、今天几节课、还有多久上课，全在 App 里算好写进快照，
 * 这里只负责摆，免得两边各算一套单双周，迟早对不上。
 *
 * 想换快照地址：长按小组件 → Edit Widget → Parameter（参数）里填完整 URL；留空就读下面这个默认地址。
 * 参数里填的是 github.io 也不用改：下面会自动换成 raw 域名再试一次，哪个通用哪个。
 * 刷新：refreshAfterDate 只是"最早什么时候可以刷"，真正多久刷一次由 iOS 决定（省电模式更懒）。
 *       所以快照里带了未来好几天的数据，过了零点它自己就能挑对当天，不靠刷新时机。
 */

// 默认走 raw.githubusercontent.com：它和 Pages 是同一份内容，但国内直连时 *.github.io 常被掐、
// raw 这个域名反而通。
const DEFAULT_URL = 'https://raw.githubusercontent.com/StarXfmy/xfmy-local/main/widget-9tu5ms.json';
// Gitee（码云）那一份：国内网络基本都通，给连不上 GitHub 的设备用。
// 注意它的 raw 地址会 302 跳到自己家的 CDN，所以下面取数是手动跟跳的。
const GITEE_RAW = 'https://gitee.com/StarXfmy/dayplan/raw/main/widget.json';
const GITEE_API = 'https://gitee.com/api/v5/repos/StarXfmy/dayplan/contents/widget.json';

/* 本地缓存：每次成功读到快照就顺手存一份，读不到时拿它顶一会儿。
   用 local 而不是 iCloud：这是设备本地目录，小组件环境里读写都稳。 */
let FM = null, CACHE = '';
try {
  FM = FileManager.local();
  CACHE = FM.joinPath(FM.documentsDirectory(), 'dayplan-snap.json');
} catch (e) { FM = null; }
const REFRESH_MIN = 15;   // 期望的最小刷新间隔（分钟）；iOS 不保证照做
const PER_TRY = 5;        // 单个地址最多等这么久：小组件整次刷新有十秒上下的时限，
                          // 头一个地址卡太久，轮不到后面的候选就被系统掐掉了

/** 把 Pages 地址换成等价的 raw 地址：内容一样，换个域名常常就通了。
    小组件的「参数」优先级高于上面的默认值，所以以前填过 github.io 的一直在填那个。 */
function rawTwin(u) {
  const m = /^https?:\/\/([^.]+)\.github\.io\/([^/?#]+)\/(.*)$/i.exec(String(u || '').trim());
  if (!m) return '';
  const file = m[3].split('?')[0].split('#')[0];
  return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/main/' + file;
}

const cands = [];
function pushCand(u) {
  u = String(u || '').trim();
  if (u && cands.indexOf(u) < 0) cands.push(u);
}
pushCand(args.widgetParameter);
pushCand(rawTwin(args.widgetParameter));
pushCand(GITEE_RAW);
pushCand(DEFAULT_URL);
pushCand(GITEE_API);

function shortUrl(u) {
  return String(u)
    .replace(/^https?:\/\/gitee\.com\/api\/v5\/repos\//, 'Gitee接口/')
    .replace(/^https?:\/\/gitee\.com\//, 'Gitee/')
    .replace(/^https?:\/\/raw\.githubusercontent\.com\//, 'raw/')
    .replace(/^https?:\/\/([^/]+)\/([^/]+)\/.*\//i, '$1/$2/…')
    .replace(/^https?:\/\//, '');
}

/** 取文本，遇到 3xx 自己跟过去：Scriptable 对 302 不保证自动跟随，
    而 Gitee 的 raw 地址恰恰是 302 跳到自家 CDN——跟丢就什么也读不到。
    注意：Scriptable 的 Request 没有 setMethod()，方法就是 req.method = 'X' 属性赋值；
    默认本来就是 GET，所以这里什么都不用设。 */
async function fetchText(url) {
  let target = url;
  for (let hop = 0; hop < 5; hop++) {
    const req = new Request(target);
    req.timeoutInterval = PER_TRY;
    const text = await req.loadString();
    const res = req.response || {};
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400) {
      const h = res.headers || {};
      const loc = h.location || h.Location || '';
      if (!loc) return { status: status, text: text };
      target = loc;
      continue;
    }
    return { status: status, text: text };
  }
  throw new Error('跳转超过 5 次');
}

/** 响应变快照。Gitee 的接口回的是「包装」：真内容在 content 里、还是 base64。 */
function toSnap(url, r) {
  let text = r.text || '';
  if (url.indexOf('/api/v5/') >= 0) {
    const wrap = JSON.parse(text);
    text = Data.fromBase64String(String(wrap.content || '').replace(/\s/g, '')).toRawString();
  }
  return JSON.parse(text);
}

let snap = null;
const lines = [];
for (let i = 0; i < cands.length && !snap; i++) {
  // 查询串带十分钟粒度的戳：CDN 那边是 max-age=600，戳一变就绕开那份缓存
  const bust = cands[i] + (cands[i].indexOf('?') < 0 ? '?' : '&') + 'v=' + Math.floor(Date.now() / 600000);
  const t0 = Date.now();
  try {
    const r = await fetchText(bust);
    snap = toSnap(cands[i], r);
    lines.push(shortUrl(cands[i]) + ' [' + r.status + '] 通了 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  } catch (e) {
    lines.push(shortUrl(cands[i]) + ' 不行：' + String(e && e.message ? e.message : e));
  }
}

// 一个地址都没读到：翻本地缓存顶着（断网、Gitee 抽风时还能看见课表，只是会标上时间）
let fromCache = false;
if (!snap && FM && CACHE) {
  try {
    if (FM.fileExists(CACHE)) {
      snap = JSON.parse(FM.readString(CACHE));
      fromCache = true;
    }
  } catch (e) { snap = null; fromCache = false; }
}
// 这次是真读到了，就把好的那份存下来，供下次断网时用（存失败不影响显示）
if (snap && !fromCache && FM && CACHE) {
  try { FM.writeString(CACHE, JSON.stringify(snap)); } catch (e) { }
}

const fam = config.runsInWidget ? config.widgetFamily : 'medium';
const w = new ListWidget();
w.setPadding(10, 12, 10, 12);
w.spacing = 4;
w.refreshAfterDate = new Date(Date.now() + REFRESH_MIN * 60 * 1000);
if (snap && snap.appUrl) w.url = snap.appUrl;

const C = snap ? snap.colors : { bg: '#f6ead8', card: '#fffdf7', ink: '#33291d', sub: '#7a6a55', accent: '#c8863c', warn: '#b3402f' };
w.backgroundColor = new Color(C.bg);
const ink = new Color(C.ink), sub = new Color(C.sub), accent = new Color(C.accent), warn = new Color(C.warn);

if (!snap) {
  const t = w.addText('Day Plan');
  t.textColor = accent; t.font = Font.boldSystemFont(fam === 'small' ? 14 : 17);
  const h = w.addText('取不到快照，每个地址的结果如下');
  h.textColor = ink; h.font = Font.systemFont(fam === 'small' ? 11 : 13); h.lineLimit = 2;
  // 把每个地址的状态码/错误摊开：连不上、超时、跳转跟丢，解法完全不同
  lines.slice(0, 4).forEach((s) => {
    const d = w.addText(s);
    d.textColor = sub; d.font = Font.systemFont(9); d.lineLimit = 2; d.minimumScaleFactor = 0.5;
  });
} else {
  const today = pickToday(snap.days);
  const stale = !today || today.date !== localDay(0);
  const day = today || (snap.days && snap.days[0]) || null;

  // 第一行：星期 + 农历 + 第几周
  if (day) {
    const head = w.addStack();
    const wd = head.addText(day.weekday || day.date);
    wd.textColor = accent; wd.font = Font.boldSystemFont(fam === 'small' ? 14 : 16);
    if (day.lunar) {
      head.addSpacer(6);
      const lu = head.addText(day.lunar);
      lu.textColor = sub; lu.font = Font.systemFont(11);
    }
    if (day.week) {
      head.addSpacer(6);
      const wk = head.addText('第' + day.week + '周');
      wk.textColor = sub; wk.font = Font.systemFont(11);
    }
  }

  if (stale) {
    const s = w.addText('快照停在 ' + (day ? day.date : '?') + '，去 Day Plan 发布一次');
    s.textColor = warn; s.font = Font.systemFont(11); s.lineLimit = 2; s.minimumScaleFactor = 0.7;
  }

  // 天气只在"就是今天那份"时才显示，免得挂着一句昨天的降温提醒
  if (snap.wx && snap.wx.date === localDay(0) && snap.wx.city) {
    let line = snap.wx.city + ' ' + snap.wx.text + ' ' + snap.wx.temp + '°';
    if (snap.wx.min !== null && snap.wx.max !== null) line += ' ' + snap.wx.min + '~' + snap.wx.max + '°';
    if (snap.wx.pop !== null && snap.wx.pop >= 30) line += ' 降水' + snap.wx.pop + '%';
    if (snap.wx.offline) line += '·' + snap.wx.ago;
    const t = w.addText(line);
    t.textColor = sub; t.font = Font.italicSystemFont(11); t.minimumScaleFactor = 0.7; t.lineLimit = 1;
  }

  if (day && day.next && !stale) {
    // 桌面这张图可能挂很久，而快照里那句倒计时是发布那一刻算的死文本。
    // 新快照（v≥3）带整张节次表 + 每门课的 pStart/pEnd，卡片自己按手机时间认现在上第几节；
    // 认不出（老快照）才退回 atMin 口径。规则与鸿蒙、安卓、card-logic.js 逐条一致。
    const nx = day.next;
    const auto = autoCount(snap, day);
    let line = nx.text;
    let isIn = nx.state === 'in';
    if (auto) {
      line = auto[0]; isIn = auto[1];
    } else if (typeof nx.atMin === 'number' && day.date === localDay(0) && nx.state !== 'done') {
      const now = new Date();
      const diff = nx.atMin - (now.getHours() * 60 + now.getMinutes());
      const nm = nx.name || '';
      if (nx.state === 'in') {
        line = diff > 0 ? '在上 ' + nm + ' · 剩 ' + leftText(diff) : '这节课按课表该下课了';
      } else {
        line = diff > 0 ? '下一节 ' + nm + ' · ' + leftText(diff) + '后' : '这节课按课表该开始了';
      }
    }
    const big = w.addText(line);
    big.textColor = isIn ? warn : ink;
    big.font = Font.boldSystemFont(fam === 'small' ? 13 : 15);
    big.lineLimit = 2; big.minimumScaleFactor = 0.6;
  }

  // 课程表：小尺寸给两行，中三行，大五到八行
  const maxRows = fam === 'small' ? 2 : fam === 'medium' ? 3 : 8;
  if (day && day.courses && day.courses.length) {
    w.addSpacer(2);
    day.courses.slice(0, maxRows).forEach((c) => {
      const row = w.addStack();
      const when = row.addText(c.when);
      when.textColor = sub; when.font = Font.systemFont(fam === 'large' ? 12 : 11);
      row.addSpacer(6);
      const name = row.addText(c.name + (c.room ? ' @' + c.room : ''));
      name.textColor = c.now ? accent : ink;
      name.font = c.now ? Font.boldSystemFont(fam === 'large' ? 13 : 12) : Font.systemFont(fam === 'large' ? 13 : 12);
      name.lineLimit = 1; name.minimumScaleFactor = 0.5;
    });
    if (day.moreCourses) {
      const m = w.addText('还有 ' + day.moreCourses + ' 节');
      m.textColor = sub; m.font = Font.systemFont(10);
    }
  } else if (day) {
    const n = w.addText(stale ? '那天没课' : '今天没课');
    n.textColor = sub; n.font = Font.systemFont(13);
  }

  // 待办：快照按范围可能只给条数不给文字，两种都能摆
  if (day && day.todos && day.todos.length && fam !== 'small') {
    w.addSpacer(2);
    day.todos.slice(0, fam === 'large' ? 5 : 2).forEach((t) => {
      const s = w.addText((t.late ? '! ' : '· ') + t.text);
      s.textColor = t.late ? warn : ink; s.font = Font.systemFont(11); s.lineLimit = 1; s.minimumScaleFactor = 0.6;
    });
  } else if (day && day.todoCount) {
    const s = w.addText('待办 ' + day.todoCount + ' 件' + (day.lateCount ? '（' + day.lateCount + ' 件拖了）' : ''));
    s.textColor = day.lateCount ? warn : sub; s.font = Font.systemFont(11); s.lineLimit = 1;
  }

  if (fam === 'large' && snap.tips && snap.tips.length) {
    w.addSpacer(3);
    snap.tips.slice(0, 2).forEach((t) => {
      const s = w.addText(t); s.textColor = sub; s.font = Font.italicSystemFont(11); s.lineLimit = 2;
    });
  }

  w.addSpacer(null);   // 弹性留白：内容少的时候把「发布时间」顶到最底
  const foot = w.addText((snap.at ? timeOf(snap.at) : '') + (fromCache ? ' 那份 · 离线中' : ' 发布'));
  foot.textColor = fromCache ? warn : sub; foot.font = Font.systemFont(9);
}

// 在桌面上跑：挂上去就行。在 App 里点运行：必须显式弹出来，
// 否则画的卡片没地方显示，看上去像"点了没反应"。
if (config.runsInWidget) {
  Script.setWidget(w);
} else if (fam === 'small') {
  await w.presentSmall();
} else if (fam === 'large') {
  await w.presentLarge();
} else {
  await w.presentMedium();
}
Script.complete();

/* ---------------------------------------------------------------- 小工具 */

function localDay(offset) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + (offset || 0));
  return fmt(d);
}

function fmt(d) {
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 挑"今天"那一条；快照里已经没有今天了（太久没发布）就回 null，由上面标成过期 */
function pickToday(days) {
  if (!days || !days.length) return null;
  const t = localDay(0);
  for (let i = 0; i < days.length; i++) if (days[i].date === t) return days[i];
  return null;
}

function timeOf(ms) {
  const d = new Date(ms), p = (n) => (n < 10 ? '0' : '') + n;
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function numOk(v) { return typeof v === 'number' && !isNaN(v); }

/**
 * 用整张节次表 + 每门课的 pStart/pEnd，按手机本地时间认出现在上第几节。
 * 一节一节铺（而不是按整门课的起止区间）是为了识破连上课里的课间：
 * 8:00–8:40 / 8:45–9:25 那门两节的课，8:42 其实没在上，不该说「在上 · 剩 X」。
 * 老快照没有这些字段时返回 null，调用处退回 atMin 口径。
 * 规则与 card-logic.js 的 periodState 逐条一致。
 */
function autoCount(snap, day) {
  const periods = (snap && snap.periods) || [];
  const list = (day && day.courses) || [];
  if (!periods.length || !list.length) return null;
  if (day.date !== localDay(0)) return null;
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const segs = [];
  const taken = {};
  for (let i = 0; i < list.length; i++) {
    const c = list[i] || {};
    if (!numOk(c.pStart) || c.pStart < 1) continue;
    const a = c.pStart - 1, b = (numOk(c.pEnd) && c.pEnd >= c.pStart ? c.pEnd : c.pStart) - 1;
    for (let k = a; k <= b && k < periods.length; k++) {
      const p = periods[k] || {};
      if (!numOk(p.startMin) || !numOk(p.endMin) || p.endMin <= p.startMin) continue;
      if (taken[k]) continue;                    // 同一节被两门课占：取先出现的，和课表画法一致
      taken[k] = true;
      segs.push({ start: p.startMin, end: p.endMin, name: c.name || '' });
    }
  }
  if (!segs.length) return null;
  segs.sort((x, y) => x.start - y.start);
  for (const s of segs) {
    if (nowMin >= s.start && nowMin < s.end) return ['在上 ' + s.name + ' · 剩 ' + leftText(s.end - nowMin), true];
  }
  for (const s of segs) {
    if (s.start > nowMin) return ['下一节 ' + s.name + ' · ' + leftText(s.start - nowMin) + '后', false];
  }
  const n = numOk(day.courseCount) && day.courseCount > 0 ? day.courseCount : segs.length;
  return ['今天的 ' + n + ' 节课上完了', false];
}

/** 把"还剩几分钟"说成人话，口径和 App 里的一致。 */
function leftText(m) {
  m = Math.max(0, Math.round(m));
  if (m >= 60) {
    const h = Math.floor(m / 60), r = m % 60;
    return r ? h + ' 小时 ' + r + ' 分' : h + ' 小时';
  }
  return m + ' 分钟';
}

};
