/* 课表算法：第几周、今天有哪些课、下一节还有多久。
   纯函数，不碰 DOM、不碰存储，所以能单独跑测试（kernel/test/timetable.test.mjs）。
   字段名跟同步层对齐：doc = {termStart, weeks, periods, courses}。 */

export function toMin(hm) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  var h = +m[1], mi = +m[2];
  return h > 23 || mi > 59 ? null : h * 60 + mi;
}

/** "2026-10-12" → 星期几（1=周一 … 7=周日）。按 UTC 正午取，不受本机时区影响。 */
export function dowOf(dayStr) {
  var d = new Date(String(dayStr || '') + 'T12:00:00Z');
  if (isNaN(d.getTime())) return 0;
  var g = d.getUTCDay();
  return g === 0 ? 7 : g;      // 周日 getUTCDay() 是 0，不能跟"日期无效"共用 0
}

/** 两个 YYYY-MM-DD 差几个自然日（取中午算，躲开夏令时造成的 ±1 天） */
export function dayGap(from, to) {
  var a = new Date(from + 'T12:00:00'), b = new Date(to + 'T12:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.round((b - a) / 86400000);
}

/** 开学第几周。没填开学日或那天在开学前 → 0（表示"算不出来"，调用方自己决定怎么显示）。 */
export function weekOfTerm(termStart, dayStr) {
  if (!termStart || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayStr || ''))) return 0;
  var w = Math.floor(dayGap(termStart, dayStr) / 7) + 1;   // 天数要折成周数
  return w > 0 ? w : 0;
}

/** 这周在不在上课期内。没填开学日就当作"不知道"，一律算在内 —— 别把课全藏了让人以为课表空了。 */
export function inTermWeek(doc, wk) {
  var d = doc || {};
  if (!d.termStart) return true;
  if (!wk) return false;
  return wk <= (d.weeks || 70);
}

export function courseInWeek(c, wk) {
  if (!wk) return true;
  if (c.weeks && c.weeks.length) return c.weeks.indexOf(wk) >= 0;
  return wk >= (c.weekFrom || 1) && wk <= (c.weekTo || 99);
}

/** 排序键统一折成"当天第几分钟"：不换算就会出现第 6 节的课排在 07:30 的课前面。 */
export function courseOrder(c, periods) {
  var p = periods && periods.length ? periods[(c.pStart || 0) - 1] : null;
  if (p) {
    var m = toMin(p.start);
    if (m !== null) return m;
  }
  var t = toMin(c.start);
  if (t !== null) return t;
  return c.pStart ? 1000 + c.pStart : 99999;
}

/** 某天实际要上的课（按周次筛过、按时间排好） */
export function coursesOn(doc, dayStr) {
  var d = doc || {}, ds = String(dayStr || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return [];
  var dow = dowOf(ds), wk = weekOfTerm(d.termStart, ds);
  if (!inTermWeek(d, wk)) return [];
  return (d.courses || []).filter(function (c) {
    return c.day === dow && courseInWeek(c, wk);
  }).sort(function (a, b) {
    return courseOrder(a, d.periods) - courseOrder(b, d.periods)
      || String(a.start || '').localeCompare(String(b.start || ''));
  });
}

/** 一门课的起止分钟：拿节次去查节次时刻表，缺哪一节就返回 null（宁可不显示也不编时间）。 */
export function lessonRange(c, periods) {
  var a = periods && periods[(c.pStart || 0) - 1], b = periods && periods[(c.pEnd || 0) - 1];
  if (!a || !b) return null;
  var from = toMin(a.start), to = toMin(b.end);
  if (from === null || to === null || to <= from) return null;
  return { from: from, to: to };
}

/** 下一节课。没填节次时刻表返回 null；那天没课返回 {empty:true}；都下课了返回 {finished:true}。 */
export function nextLesson(doc, dayStr, minutes) {
  var d = doc || {}, periods = d.periods || [];
  if (!periods.length) return null;
  var list = coursesOn(d, dayStr);
  if (!list.length) return { empty: true };
  var cur = null, soon = null;
  list.forEach(function (c) {
    var r = lessonRange(c, periods);
    if (!r) return;
    if (minutes >= r.from && minutes < r.to && (!cur || r.to < cur.to)) cur = { course: c, to: r.to };
    if (r.from > minutes && (!soon || r.from < soon.from)) soon = { course: c, from: r.from };
  });
  if (cur) return { course: cur.course, inClass: true, minutes: cur.to - minutes };
  if (soon) return { course: soon.course, inClass: false, minutes: soon.from - minutes };
  return { finished: true, count: list.length };
}

/** 某个时区"现在"是哪一天、当天第几分钟。时钟和课表必须同一个口径，否则改了时区会差一天。 */
export function tzNow(tz) {
  var now = new Date();
  try {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(now);
    var g = {};
    parts.forEach(function (p) { if (p.type !== 'literal') g[p.type] = p.value; });
    var h = +g.hour;
    if (h === 24) h = 0;      // 个别环境午夜给 "24"，此时日期已滚到下一天
    return { day: g.year + '-' + g.month + '-' + g.day, minutes: h * 60 + (+g.minute) };
  } catch (e) {
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return { day: now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()),
      minutes: now.getHours() * 60 + now.getMinutes() };
  }
}

/** 显示用：一门课写成「第 1–2 节 08:00」或「08:00–09:40」 */
export function courseWhen(c, periods) {
  if (c.start) return c.start + '–' + (c.end || '');
  if (!c.pStart) return '时间待定';
  var r = lessonRange(c, periods);
  var label = '第 ' + c.pStart + '–' + c.pEnd + ' 节';
  if (!r) return label;
  var f = Math.floor(r.from / 60), m = r.from % 60;
  return label + ' ' + (f < 10 ? '0' : '') + f + ':' + (m < 10 ? '0' : '') + m;
}

/** 剩余分钟数说人话：超过一小时折成"4 小时 15 分" */
export function humanLeft(mins) {
  if (mins >= 60) return Math.floor(mins / 60) + ' 小时' + (mins % 60 ? ' ' + (mins % 60) + ' 分' : '');
  return mins + ' 分钟';
}
