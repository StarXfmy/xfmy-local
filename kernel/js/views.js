/* 七个视图。每个视图只做两件事：把当前数据画出来、把用户动作写回 model。
   改完数据统一调 app.refresh()（它会落盘并重画），所以视图里没有一处自己存数据。 */
import * as M from './model.js';
import * as T from './timetable.js';
import * as N from './net.js';
import * as B from './bridge.js';
import { el, add, clear, pad2, cnDay, weekdayCn, toast, button, field, input, select, card } from './ui.js';

/* ---------------------------------------------------------------- 农历 */
function lunarOf(date) {
  try {
    if (!window.Solar) return '';
    var lun = window.Solar.fromDate(date).getLunar();
    var d = lun.getDayInChinese();
    return d === '初一' ? lun.getMonthInChinese() + '月' : d;
  } catch (e) { return ''; }
}
function lunarFull(date) {
  try {
    if (!window.Solar) return '';
    var lun = window.Solar.fromDate(date).getLunar();
    return lun.getYearGan() + lun.getYearZhi() + '年' + lun.getMonthInChinese() + '月' + lun.getDayInChinese();
  } catch (e) { return ''; }
}
function lunarMD(date) {
  try {
    var lun = window.Solar.fromDate(date).getLunar();
    return { m: Math.abs(lun.getMonth()), d: lun.getDay() };
  } catch (e) { return null; }
}

/* ---------------------------------------------------------------- 今天 */
export function viewToday(mount, app) {
  var doc = M.timetableDoc();
  var t = app.tz();
  var c = el('div', 'today');

  var clock = el('p', 'bigclock', '--:--:--');
  clock.id = 'bigClock';
  var dateLine = el('p', 'dateline', t.day + ' ' + weekdayCn(T.dowOf(t.day)));
  var lunarLine = el('p', 'lunarrow', lunarFull(new Date()));
  add(c, clock, dateLine, lunarLine);

  // 天气一行：取不到或取的是旧缓存，都要说清楚是几点钟的
  var wx = el('p', 'wxline', '天气读取中…');
  wx.id = 'todayWx';
  add(c, wx);
  N.getWeather(app.city()).then(function (r) {
    var d = r.data;
    var s = d.city + ' · ' + d.current.text + ' · ' + d.current.temp + '°';
    if (d.today.max !== null) s += ' · 今日 ' + d.today.min + '~' + d.today.max + '°';
    if (d.today.pop !== null) s += ' · 降水 ' + d.today.pop + '%';
    if (r.offline) s += '（离线，数据来自 ' + N.agoLabel(r.at) + '）';
    wx.textContent = s;
  }).catch(function (e) { wx.textContent = '天气没取到：' + e.message; });

  // 今日课程
  var list = T.coursesOn(doc, t.day);
  var box = card('今日课程', list.length ? list.length + ' 节' : '没课');
  if (!list.length) {
    add(box.body, el('p', 'empty', doc.termStart ? '今天没有课。' : '还没设开学日期，先在课表页填一下。'));
  } else {
    list.forEach(function (co) {
      var r = T.lessonRange(co, doc.periods);
      var running = !!r && t.minutes >= r.from && t.minutes < r.to;
      var row = el('p', 'row' + (running ? ' now' : ''));
      add(row, el('b', 'when', T.courseWhen(co, doc.periods)),
        el('span', 'name', co.name),
        co.room ? el('i', 'where', co.room) : null);
      add(box.body, row);
    });
    var next = el('p', 'nextlesson');
    add(box.body, next);
    var nl = T.nextLesson(doc, t.day, t.minutes);
    if (!nl) next.textContent = '想显示「还有几分钟上课」，去课表页把节次时刻表填上。';
    else if (nl.finished) next.textContent = '今天的 ' + list.length + ' 节课上完了';
    else if (nl.inClass) next.textContent = '正在上：' + nl.course.name + '，还剩 ' + T.humanLeft(nl.minutes);
    else next.textContent = '下一节：' + nl.course.name + '，' + T.humanLeft(nl.minutes) + '后'
      + (nl.course.room ? ' · ' + nl.course.room : '');
  }
  add(c, box);

  // 今日待办与欠账（只读，要改去待办页）
  var ds = t.day, md = ds.slice(5);
  var groups = groupTodos(M.todos(), ds);
  var todo = card('今天要做的', groups.today.length + groups.late.length ? '' : '清空了');
  if (!groups.today.length && !groups.late.length) {
    add(todo.body, el('p', 'empty', '今天没有待办。'));
  } else {
    groups.late.forEach(function (x) {
      add(todo.body, add(el('p', 'row late'), el('b', 'when', x.when), el('span', 'name', x.t.text)));
    });
    groups.today.forEach(function (x) {
      add(todo.body, add(el('p', 'row'), el('b', 'when', '今天'), el('span', 'name', x.text)));
    });
  }
  var evs = eventsOn(M.events(), ds, md);
  if (evs.length) {
    var ev = card('今天的日程');
    evs.forEach(function (e) { add(ev.body, add(el('p', 'row'), el('b', 'when', e.kind === 'event' ? '日程' : '生日'), el('span', 'name', e.title))); });
    add(todo.body, el('p', 'hint', ''));
    add(c, ev);
  }
  add(c, todo);
  add(mount, c);
}

function groupTodos(items, ds) {
  var late = [], today = [], future = [];
  items.forEach(function (t) {
    if (t.done) return;
    if (!t.date) { late.push(Object.assign({ when: '没定日期' }, t)); return; }
    if (t.date === ds) today.push(t);
    else if (t.date < ds) late.push(Object.assign({ when: cnDay(t.date) + ' · 拖了 ' + T.dayGap(t.date, ds) + ' 天' }, t));
    else future.push(t);
  });
  return { late: late, today: today, future: future };
}

function eventsOn(events, ds, md) {
  var lmd = lunarMD(new Date());
  return events.filter(function (e) {
    if (e.kind === 'birthday') return String(e.date || '').slice(5) === md;
    if (e.kind === 'lunar-birthday') return !!lmd && String(e.date || '').slice(5) === (pad2(lmd.m) + '-' + pad2(lmd.d));
    return e.date === ds;
  });
}

/* ---------------------------------------------------------------- 课表 */
export function viewCourses(mount, app) {
  var doc = M.timetableDoc();
  var t = app.tz();
  var wk = T.weekOfTerm(doc.termStart, t.day);

  var head = card('学期', doc.termStart ? ('开学 ' + doc.termStart + ' · 这周第 ' + (wk || '?') + ' 周 · 共 ' + (doc.weeks || '?') + ' 周') : '还没设开学日期');
  var form = el('div', 'inlineform');
  var term = input({ type: 'date' }, doc.termStart);
  var wks = input({ type: 'number', min: '1', max: '70', placeholder: '总周数' }, doc.weeks || '');
  add(form, field('开学第一个周一', term), field('总周数', wks),
    button('存学期设置', 'primary', function () {
      M.putTimetableSettings({ termStart: term.value, weeks: wks.value });
      app.refresh('学期设置存好了');
    }));
  add(head.body, form);
  if (!doc.termStart) add(head.body, el('p', 'hint', '不填开学日就算不出"这周第几周"，单双周也不会灰。'));
  add(mount, head);

  // 周视图
  var grid = el('div', 'weekgrid');
  for (var d = 1; d <= 7; d++) {
    var col = el('div', 'daycol' + (d === T.dowOf(t.day) ? ' today' : ''));
    add(col, el('h3', null, weekdayCn(d)));
    var items = doc.courses.filter(function (c) { return c.day === d; });
    if (!items.length) add(col, el('p', 'empty small', '没课'));
    items.forEach(function (c) {
      var off = !T.courseInWeek(c, wk);
      var cell = el('div', 'course' + (off ? ' off' : ''));
      add(cell, el('b', null, T.courseWhen(c, doc.periods)), el('span', null, c.name),
        c.room ? el('i', null, c.room) : null,
        el('em', null, '第 ' + c.weekFrom + '–' + c.weekTo + ' 周' + (off ? '（本周没）' : '')));
      cell.addEventListener('click', function () { editCourse(c, doc, app); });
      add(col, cell);
    });
    add(grid, col);
  }
  var wkBox = card('本周课表', '点一门课可以改或删');
  add(wkBox.body, grid);
  add(mount, wkBox);

  // 加课
  var addBox = card('加一门课');
  var name = input({ placeholder: '课程名', maxlength: '60' });
  var room = input({ placeholder: '教室' });
  var teacher = input({ placeholder: '老师（可不填）' });
  var day = select([[1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [7, '周日']], String(T.dowOf(t.day)));
  var ps = input({ type: 'number', min: '1', max: '30', placeholder: '第几节起' });
  var pe = input({ type: 'number', min: '1', max: '30', placeholder: '到第几节' });
  var st = input({ placeholder: '或写时间 08:00', size: '6', maxlength: '5' });
  var en = input({ placeholder: '09:40', size: '6', maxlength: '5' });
  var wf = input({ type: 'number', min: '1', max: '70', value: String(wk || 1) });
  var wt = input({ type: 'number', min: '1', max: '70', value: String(doc.weeks || (wk + 12)) });
  var addMsg = el('p', 'hint');
  add(addBox.body,
    add(el('div', 'inlineform'), field('课程名', name), field('教室', room), field('老师', teacher), field('星期', day)),
    add(el('div', 'inlineform'), field('第几节起', ps), field('到第几节', pe), field('钟点起', st), field('钟点止', en), field('第几周起', wf), field('第几周止', wt)),
    add(el('div', 'inlineform'), button('加进课表', 'primary', function () {
      var c = {
        name: name.value.trim(), room: room.value.trim(), teacher: teacher.value.trim(),
        day: Number(day.value), pStart: Number(ps.value) || 0, pEnd: Number(pe.value) || 0,
        start: st.value.trim(), end: en.value.trim(),
        weekFrom: Number(wf.value) || 1, weekTo: Number(wt.value) || 1
      };
      var okTime = /^\d{1,2}:\d{2}$/.test(c.start) && /^\d{1,2}:\d{2}$/.test(c.end) && c.start < c.end;
      var okPeriod = c.pStart >= 1 && c.pEnd >= c.pStart;
      if (!c.name) { addMsg.textContent = '课程名要写'; addMsg.className = 'hint err'; return; }
      if (!okTime && !okPeriod) { addMsg.textContent = '时间要么写「第几节到第几节」，要么写成 08:00 这样的钟点'; addMsg.className = 'hint err'; return; }
      M.putCourse(c);
      app.refresh('加好了：' + c.name);
    }), addMsg));
  add(addBox.body, el('p', 'hint', '只填一组时间就行：有节次就靠节次时刻表换算钟点。'));
  add(mount, addBox);

  // 节次时刻表
  var pBox = card('节次时刻表', doc.periods.length ? '已填 ' + doc.periods.length + ' 节' : '没填 → 倒计时不会显示');
  var rows = el('div', 'periods');
  var inputs = [];
  for (var i = 0; i < 12; i++) {
    var p = doc.periods[i] || {};
    var a = input({ placeholder: '08:00', size: '5', maxlength: '5' }, p.start || '');
    var b = input({ placeholder: '08:45', size: '5', maxlength: '5' }, p.end || '');
    inputs.push([a, b]);
    add(rows, add(el('div', 'prow'), el('b', null, String(i + 1)), a, el('span', null, '–'), b));
  }
  add(pBox.body, rows,
    add(el('p', 'rowline'), button('存时刻表', 'primary', function () {
      var out = [], bad = false, gap = -1;
      inputs.forEach(function (pair, idx) {
        var s = pair[0].value.trim(), e = pair[1].value.trim();
        if (!s && !e) { if (gap < 0 && out.length) gap = idx; return; }
        if (!/^\d{1,2}:\d{2}$/.test(s) || !/^\d{1,2}:\d{2}$/.test(e)) { bad = '第 ' + (idx + 1) + ' 节的起止时间没写全或写歪了'; return; }
        // 中间空一格就把后面的整体上移了：第 5 节会变成第 4 节，倒计时全错
        if (gap >= 0) { bad = '第 ' + (gap + 1) + ' 节空着，第 ' + (idx + 1) + ' 节却有时间：节次要连着填，中间别空'; return; }
        out.push({ start: s, end: e });
      });
      if (bad) { toast(bad, 'err'); return; }
      M.putTimetableSettings({ periods: out });
      app.refresh(out.length ? '时刻表存好了，共 ' + out.length + ' 节' : '时刻表已清空');
    })),
    el('p', 'hint', '一格都不填就保存，等于清空时刻表。'));
  add(mount, pBox);
}

function editCourse(c, doc, app) {
  var box = card('改这门课：' + c.name);
  var name = input({ maxlength: '60' }, c.name);
  var room = input({}, c.room || '');
  var teacher = input({}, c.teacher || '');
  var day = select([[1, '周一'], [2, '周二'], [3, '周三'], [4, '周四'], [5, '周五'], [6, '周六'], [7, '周日']], String(c.day));
  var ps = input({ type: 'number', min: '1', max: '30' }, c.pStart || '');
  var pe = input({ type: 'number', min: '1', max: '30' }, c.pEnd || '');
  var wf = input({ type: 'number', min: '1', max: '70' }, c.weekFrom);
  var wt = input({ type: 'number', min: '1', max: '70' }, c.weekTo);
  add(box.body,
    add(el('div', 'inlineform'), field('课程名', name), field('教室', room), field('老师', teacher), field('星期', day)),
    add(el('div', 'inlineform'), field('第几节起', ps), field('到第几节', pe), field('第几周起', wf), field('第几周止', wt)),
    add(el('p', 'rowline'),
      button('保存修改', 'primary', function () {
        M.putCourse(Object.assign({}, c, {
          name: name.value.trim() || c.name, room: room.value.trim(), teacher: teacher.value.trim(),
          day: Number(day.value), pStart: Number(ps.value) || 0, pEnd: Number(pe.value) || 0,
          weekFrom: Number(wf.value) || 1, weekTo: Number(wt.value) || 1
        }));
        app.refresh('改好了');
      }),
      button('删掉这门课', 'danger', function () {
        if (window.confirm('删掉「' + c.name + '」？删除会留一条记录，另一台导入时不会又把它复活。')) {
          M.removeCourse(c.id);
          app.refresh('删掉了');
        }
      })));
  var host = document.getElementById('view');
  clear(host).appendChild(box);
  box.scrollIntoView({ block: 'start' });
}

/* ---------------------------------------------------------------- 日历 */
export function viewCalendar(mount, app) {
  var cal = app.cal;
  var t = app.tz();
  var box = card('月历', '农历与节假日');
  var head = add(el('p', 'rowline'),
    button('← 上个月', '', function () { cal.move(-1); app.refresh(); }),
    el('b', 'caltitle', cal.y + ' 年 ' + (cal.m + 1) + ' 月'),
    button('回本月', '', function () { var d = new Date(); cal.y = d.getFullYear(); cal.m = d.getMonth(); app.refresh(); }),
    button('下个月 →', '', function () { cal.move(1); app.refresh(); }));
  add(box.body, head);

  var grid = el('div', 'calgrid');
  ['一', '二', '三', '四', '五', '六', '日'].forEach(function (w) { add(grid, el('b', 'calw', w)); });
  var first = new Date(cal.y, cal.m, 1);
  var startDow = (first.getDay() + 6) % 7;
  var days = new Date(cal.y, cal.m + 1, 0).getDate();
  for (var i = 0; i < startDow; i++) add(grid, el('div', 'cald empty'));
  var hol = app.holidays || {};
  var todos = M.todos(), events = M.events();
  for (var d = 1; d <= days; d++) {
    var date = new Date(cal.y, cal.m, d);
    var ds = date.getFullYear() + '-' + pad2(cal.m + 1) + '-' + pad2(d);
    var h = hol[ds];
    var cell = el('div', 'cald' + (ds === t.day ? ' today' : '') + (ds === cal.sel ? ' sel' : ''));
    add(cell, el('b', null, String(d)),
      h ? el('i', 'hol' + (h.off ? ' off' : ' work'), h.off ? '休' : '班') : null,
      el('span', 'lun', lunarOf(date)),
      h && h.name ? el('em', 'holname' + (h.off ? '' : ' work'), h.off ? h.name : h.name + '补班') : null,
      todos.some(function (x) { return !x.done && x.date === ds; }) ? el('u', 'dot tdot') : null,
      events.some(function (e) { return e.date === ds; }) ? el('u', 'dot edot') : null);
    (function (ds2) { cell.addEventListener('click', function () { cal.sel = cal.sel === ds2 ? '' : ds2; app.refresh(); }); })(ds);
    add(grid, cell);
  }
  add(box.body, grid);
  add(box.body, el('p', 'hint', '红「休」是放假；灰「班」是调休，那天要上课，所以后面写的是「补班」而不是假期。' + (app.holidaysAt ? '节假日数据取自 ' + N.agoLabel(app.holidaysAt) + '。' : '节假日数据还没取到，联网后点设置页的刷新。')));
  add(mount, box);

  if (cal.sel) {
    var ds = cal.sel;
    var one = card(ds + ' 这天');
    var dayTodos = todos.filter(function (x) { return x.date === ds; });
    add(one.body, el('h4', null, '待办'));
    if (!dayTodos.length) add(one.body, el('p', 'empty small', '这天没有待办'));
    dayTodos.forEach(function (x) { add(one.body, todoRow(x, app)); });
    var ti = input({ placeholder: '给这天记一条待办', maxlength: '500' });
    add(one.body, add(el('p', 'rowline'), ti, button('加', 'primary', function () {
      if (!ti.value.trim()) return toast('先写内容', 'err');
      M.addTodo({ text: ti.value.trim(), date: ds }); app.refresh('加好了');
    })));
    add(one.body, el('h4', null, '日程'));
    var dayEvs = events.filter(function (e) { return e.date === ds; });
    if (!dayEvs.length) add(one.body, el('p', 'empty small', '这天没有日程'));
    dayEvs.forEach(function (e) {
      add(one.body, add(el('p', 'row'), el('span', 'name', e.title),
        button('删', 'danger', function () { M.removeEvent(e.id); app.refresh('删了'); })));
    });
    var et = input({ placeholder: '日程标题（如 班会）', maxlength: '100' });
    var ek = select([['event', '普通日程'], ['birthday', '公历生日（每年）'], ['lunar-birthday', '农历生日（每年）']], 'event');
    add(one.body, add(el('p', 'rowline'), et, ek, button('记', 'primary', function () {
      if (!et.value.trim()) return toast('先写标题', 'err');
      var d0 = et.value.trim();
      M.addEvent({ date: ek.value === 'event' ? ds : '2000' + ds.slice(4), title: d0, kind: ek.value });
      app.refresh('记下了');
    })));
    add(mount, one);
  }
}

/* ---------------------------------------------------------------- 待办 */
export function viewTodos(mount, app) {
  var t = app.tz();
  var items = M.todos();
  var g = groupTodos(items, t.day);
  var done = items.filter(function (x) { return x.done; });

  var box = card('待办', g.late.length ? '有 ' + g.late.length + ' 件拖了日子' : '');
  var ti = input({ placeholder: '要做什么？', maxlength: '500' });
  var td = input({ type: 'date' }, t.day);
  add(box.body, add(el('p', 'rowline'), ti, field('哪天', td), button('加一条', 'primary', function () {
    if (!ti.value.trim()) return toast('先写内容', 'err');
    M.addTodo({ text: ti.value.trim(), date: td.value });
    app.refresh('加好了');
  })));
  function section(title, rows, late) {
    if (!rows.length) return;
    add(box.body, el('h4', null, title));
    rows.forEach(function (x) { add(box.body, todoRow(x, app, late)); });
  }
  section('今天要做的', g.today.concat(g.late), true);
  section('以后的', g.future);
  var noDate = items.filter(function (x) { return !x.done && !x.date; });
  section('没定日期', noDate);
  if (!g.today.length && !g.late.length && !g.future.length && !noDate.length) add(box.body, el('p', 'empty', '一条待办都没有，轻松。'));
  if (done.length) {
    add(box.body, el('h4', null, '已完成 ' + done.length + ' 件'));
    done.slice(0, 30).forEach(function (x) { add(box.body, todoRow(x, app)); });
  }
  add(mount, box);
}

function todoRow(x, app, showDate) {
  var cb = input({ type: 'checkbox' });
  cb.checked = !!x.done;
  cb.addEventListener('change', function () { M.patchTodo(x.id, { done: cb.checked }); app.refresh(cb.checked ? '勾掉了' : '又挂回来了'); });
  var row = add(el('p', 'row todo' + (x.done ? ' done' : '')), cb, el('span', 'name', x.text));
  if (x.date) add(row, el('i', 'when', x.date === app.tz().day ? '今天' : cnDay(x.date)));
  add(row, button('×', 'tiny', function () {
    window.confirm('删掉「' + x.text + '」？') && (M.removeTodo(x.id), app.refresh('删了'));
  }));
  return row;
}

/* ---------------------------------------------------------------- 天气 */
export function viewWeather(mount, app) {
  var box = card('天气', '数据来自 Open-Meteo');
  var cities = [['30.002,120.579', '绍兴'], ['30.29,120.16', '杭州'], ['29.87,121.55', '宁波'], ['39.90,116.41', '北京'],
    ['31.23,121.47', '上海'], ['23.13,113.26', '广州'], ['30.67,104.07', '成都']];
  var cur = app.city();
  var sel = select(cities.map(function (x) { return [x[0], x[1]]; }), cur.lat + ',' + cur.lon);
  add(box.body, add(el('p', 'rowline'), field('城市', sel), button('换', 'primary', function () {
    var p = sel.value.split(',');
    var name = (cities.filter(function (x) { return x[0] === sel.value; })[0] || ['', '自定义'])[1];
    M.setPref('city', { name: name, lat: Number(p[0]), lon: Number(p[1]) });
    app.refresh('城市换成' + name);
  })));
  var body = el('div', 'wxbody');
  add(box.body, body);
  add(mount, box);
  body.textContent = '读取中…';
  N.getWeather(cur, app.wxForce).then(function (r) {
    clear(body);
    var d = r.data;
    add(body, el('p', 'wxnow', d.current.text + ' ' + d.current.temp + '° · 风 ' + d.current.wind + ' km/h · ' + d.city));
    if (r.offline) add(body, el('p', 'hint warn', '现在是离线显示：这份是 ' + N.agoLabel(r.at) + ' 取的，不是实时的。'));
    if (d.today.max !== null) add(body, el('p', null, '今天 ' + d.today.min + '~' + d.today.max + '°，降水概率 ' + (d.today.pop === null ? '?' : d.today.pop) + '%'));
    add(body, el('h4', null, '接下来 24 小时'));
    var hrs = el('div', 'hours');
    d.hours.forEach(function (h) { add(hrs, add(el('span', 'hr'), el('b', null, h.time), el('span', null, h.temp + '°'), el('i', null, h.text + (h.pop !== null ? ' ' + h.pop + '%' : '')))); });
    add(body, hrs);
    add(body, el('h4', null, '出门怎么说'));
    var adv = el('ul', 'advice');
    N.advice(d).forEach(function (s) { add(adv, el('li', null, s)); });
    add(body, adv);
    app.wxForce = false;
  }).catch(function (e) { clear(body); add(body, el('p', 'hint err', e.message)); app.wxForce = false; });
  add(mount, el('p', 'hint', '断网或电脑关机时这里显示的是上次缓存的那份，并会写明是几点钟取的 —— 不会拿旧天气冒充实时。'));
}

/* ---------------------------------------------------------------- 同步 */
export function viewSync(mount, app) {
  var st = M.stats();
  var box = card('同步', '电脑与手机各自改，靠"导出改动 → 传过去 → 导入合并"合成同一份');
  add(box.body, el('p', 'hint', '上次同步：' + (M.lastSyncAt() ? new Date(M.lastSyncAt()).toLocaleString('zh-CN') : '还没有过')
    + '；本机 ' + Object.keys(st.cols).map(function (k) { return k + ' ' + st.cols[k]; }).join('、')
    + (st.tombstones ? '；删除留痕 ' + st.tombstones + ' 条' : '') + '。'));

  add(box.body, el('h4', null, '① 把这台机器的改动带出去'));
  add(box.body, add(el('p', 'rowline'),
    button('导出改动', 'primary', function () { doExport(app, false); }),
    button('导出全量（给新设备）', '', function () { doExport(app, true); }),
    el('span', 'hint', '只带上次同步之后的改动，文件几 KB；首次给新设备要用全量。')));

  add(box.body, el('h4', null, '② 把另一台带过来的包并进来'));
  add(box.body, add(el('p', 'rowline'), button('导入合并', 'primary', function () { doImport(app); }),
    el('span', 'hint', '重复导入同一份不会多出东西，顺序也无所谓。')));
  var rep = el('div', 'importreport');
  add(box.body, rep);

  add(box.body, el('h4', null, '③ 两台都改了同一条时'));
  var list = M.conflicts();
  if (!list.length) add(box.body, el('p', 'empty small', '没有冲突记录。'));
  else {
    add(box.body, el('p', 'hint', '被盖掉的旧内容都留在这里，可以逐条选用哪一版。'));
    list.forEach(function (k) {
      var row = add(el('p', 'row'), el('b', 'when', k.col), el('span', 'name', summarize(k)), el('i', 'when', N.agoLabel(k.at)));
      add(row, button('用它那版', '', function () { M.resolveConflict(k.key, 'incoming'); app.refresh('已采用对方那份'); }));
      add(row, button('留我这版', '', function () { M.resolveConflict(k.key, 'local'); app.refresh('已保留本机'); }));
      add(box.body, row);
    });
  }
  add(mount, box);

  var warn = card('别忘了备份');
  add(warn.body, el('p', 'hint', '手机上的数据只有手机里那一份，浏览器或系统的"清理"可能把它清掉，没有服务器兜底。'
    + '隔段时间点一次「导出全量备份」，存到微信收藏或网盘里。'));
  add(warn.body, add(el('p', 'rowline'),
    button('导出全量备份', 'primary', function () {
      B.saveText('全量备份-' + stamp() + '.json', JSON.stringify(M.fullBackup()))
        .then(function (msg) { toast(msg, 'ok'); }).catch(function (e) { toast(e.message, 'err'); });
    }),
    button('从备份恢复', 'danger', function () { doRestore(app); })));
  add(mount, warn);
}

function summarize(k) {
  var a = (k.local && k.local.data) || {}, b = (k.incoming && k.incoming.data) || {};
  var name = a.text || a.name || a.title || b.text || b.name || b.title || k.id;
  var other = b.text || b.name || b.title || a.text || a.name || a.title || '';
  return name + (other && other !== name ? ' （另一版：' + other + '）' : '');
}

function stamp() {
  var d = new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
}

function doExport(app, full) {
  var pkg = M.exportChanges({ full: full });
  if (!pkg.records.length) { toast('这台机器自上次同步后没有改动，没东西可导', 'warn'); return; }
  B.saveText('同步-' + pkg.from + '-' + stamp() + (full ? '-全量' : '') + '.json', JSON.stringify(pkg))
    .then(function (msg) { toast(msg + '；这次带出 ' + pkg.records.length + ' 条', 'ok'); })
    .catch(function (e) { toast(e.message, 'err'); });
}

function doImport(app) {
  B.pickText('.json,application/json').then(function (text) {
    if (!text) return null;
    var pkg;
    try { pkg = JSON.parse(text); } catch (e) { return toast('那个文件不是能读的 JSON', 'err'); }
    if (pkg && pkg.kind === 'xfmy-backup') return toast('这是全量备份，要用下面的「从备份恢复」', 'err');
    var rep = M.importPackage(pkg);
    if (!rep.ok) { toast('导入失败：' + (rep.errors || []).join('；'), 'err'); return; }
    app.refresh('导入完成：新增 ' + rep.added + '、更新 ' + rep.updated + '、删除 ' + rep.deleted
      + (rep.revived ? '、复活 ' + rep.revived : '') + (rep.conflicts.length ? '、' + rep.conflicts.length + ' 条要裁决' : '')
      + '、跳过 ' + (rep.skippedSame + rep.skippedOlder) + ' 条没变化');
  }).catch(function (e) { toast(e.message, 'err'); });
}

function doRestore(app) {
  B.pickText('.json,application/json').then(function (text) {
    if (!text) return null;
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return toast('那个文件读不出来', 'err'); }
    if (!obj || obj.kind !== 'xfmy-backup') return toast('这不是全量备份文件', 'err');
    if (!window.confirm('恢复会覆盖本机现在的全部数据（建议先点「导出全量备份」留个底）。继续吗？')) return null;
    var r = M.restoreBackup(obj);
    if (!r.ok) return toast('恢复失败：' + (r.errors || []).join('；'), 'err');
    app.refresh('已从备份恢复');
  }).catch(function (e) { toast(e.message, 'err'); });
}

/* ---------------------------------------------------------------- 设置 */
export function viewSettings(mount, app) {
  var box = card('这台设备');
  add(box.body, el('p', null, '设备名：' + M.device() + '　·　存储：' + app.storage.label + '　·　取文件：' + app.fileMode));
  var tz = select([['Asia/Shanghai', '中国标准时间'], ['Asia/Tokyo', '东京'], ['Europe/London', '伦敦'],
    ['America/New_York', '纽约'], ['America/Los_Angeles', '洛杉矶']], M.pref('tz', 'Asia/Shanghai'));
  add(box.body, add(el('p', 'rowline'), field('时区（时钟与"今天"按它算）', tz), button('存', 'primary', function () {
    M.setPref('tz', tz.value); app.refresh('时区换了，只影响这台设备');
  })));
  add(box.body, el('p', 'hint', '时区、城市这类偏好只存在这台设备上，不会跟着同步包跑到手机上去。'));
  add(mount, box);

  var imp = card('导入课表');
  add(imp.body, el('p', 'hint', '手上只有纸质课表或手机截图、没有 JSON 文件的话不用这里——去「课表」页「加一门课」一条条填就行。这个入口是给「导出全量」那种包和站点导出的 课表.json 用的。'));
  add(imp.body, add(el('p', 'rowline'),
    button('导入课表文件', 'primary', function () { importTimetableFile(app); })));
  add(mount, imp);

  var net = card('联网数据');
  add(net.body, add(el('p', 'rowline'),
    button('重取天气', '', function () { app.wxForce = true; app.refresh('天气重新取过了'); }),
    button('重取节假日', '', function () { app.holidays = null; app.holidaysForce = true; app.refresh('节假日重新取过了'); })));
  add(net.body, el('p', 'hint', '断网时这两项会退回上次缓存的那份，并写明是几点钟取的。节假日平时直接读包里带的那份，不依赖外网。'));
  add(mount, net);
}

function importTimetableFile(app) {
  B.pickText('.json').then(function (text) {
    if (!text) return null;
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return toast('那个文件不是 JSON', 'err'); }
    var doc = obj.timetable || obj;
    if (!Array.isArray(doc.courses)) return toast('文件里没有 courses 清单，不像课表', 'err');
    if (!window.confirm('读到了 ' + doc.courses.length + ' 门课'
      + (doc.termStart ? '，开学 ' + doc.termStart : '')
      + '。导入会把现在课表里没有的课打删除标记，确认继续？')) return null;
    var r = M.importTimetableDoc(doc);
    app.refresh('课表导入完成：' + r.courseCount + ' 门课');
  }).catch(function (e) { toast(e.message, 'err'); });
}

/* 站点备份的搬运能力留在 model.js 的 importLegacyBackup() 里（含测试），
   设置页那个入口按用户要求去掉了；以后要恢复就重新接一个按钮，不用重写逻辑。 */

/* ---------------------------------------------------------------- 视图表 */
export const VIEWS = {
  today: viewToday, courses: viewCourses, calendar: viewCalendar,
  todos: viewTodos, weather: viewWeather, sync: viewSync, settings: viewSettings
};
