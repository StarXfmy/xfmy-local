/* 入口：挑存储 → 读数据 → 按地址栏的 #标签 渲染对应视图。
   所有写操作最后都走这里的 refresh()：落盘 + 重画 + 提示，一条路走完，不留"改了没存"的缝。 */
import * as M from './model.js';
import * as T from './timetable.js';
import * as N from './net.js';
import { createStorage } from './store/index.js';
import * as B from './bridge.js';
import { el, add, clear, toast } from './ui.js';
import { VIEWS } from './views.js';

const NAV = [['today', '今天'], ['courses', '课表'], ['calendar', '日历'], ['todos', '待办'],
  ['weather', '天气'], ['sync', '同步'], ['settings', '设置']];

let storage = null;
let view = null;
let clockTimer = null;
const app = {
  cal: { y: 0, m: 0, sel: '', move: function (d) { this.m += d; while (this.m < 0) { this.m += 12; this.y--; } while (this.m > 11) { this.m -= 12; this.y++; } } },
  holidays: null, holidaysAt: 0, wxForce: false,
  city: function () {
    var v = M.pref('city', null);
    return v && typeof v.lat === 'number' ? v : { name: '绍兴', lat: 30.002, lon: 120.579 };
  },
  tz: function () { return T.tzNow(M.pref('tz', 'Asia/Shanghai')); },
  fileMode: B.mode(),
  refresh: function (msg) {
    return M.persist().then(function () {
      if (msg) toast(msg, 'ok');
      render();
    }).catch(function (e) { toast('存不下去：' + (e.message || e), 'err'); });
  }
};

function currentKey() {
  var k = (location.hash || '').replace('#', '');
  return VIEWS[k] ? k : 'today';
}

function render() {
  var key = currentKey();
  document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('on', b.dataset.k === key); });
  var host = document.getElementById('view');
  clear(host);
  view = key;
  try { (VIEWS[key])(host, app); }
  catch (e) { add(host, el('p', 'hint err', '这一页画不出来：' + (e.message || e))); }
  startClock();
  loadHolidaysIfNeeded(key);
}

/** 今天页的时钟每秒走字；离开那一页就把定时器停掉，不空跑 */
function startClock() {
  if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
  if (view !== 'today') return;
  var tick = function () {
    var n = document.getElementById('bigClock');
    if (!n) return;
    var tz = M.pref('tz', 'Asia/Shanghai');
    try { n.textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()); }
    catch (e) { n.textContent = new Date().toLocaleTimeString(); }
  };
  tick();
  clockTimer = setInterval(tick, 1000);
}

function loadHolidaysIfNeeded(key) {
  if (key !== 'calendar') return;
  var wantYear = app.cal.y;
  if (app.holidays && app.holidaysYear === wantYear) return;
  N.getHolidays(wantYear).then(function (r) {
    app.holidays = r.map; app.holidaysAt = r.at; app.holidaysYear = wantYear;
    if (currentKey() === 'calendar') render();
  }).catch(function () { app.holidays = {}; app.holidaysYear = wantYear; });
}

function boot() {
  var now = new Date();
  app.cal.y = now.getFullYear();
  app.cal.m = now.getMonth();
  try { storage = createStorage(); }
  catch (e) {
    document.getElementById('view').textContent = '存不了数据：' + e.message;
    return;
  }
  app.storage = storage;
  var nav = document.getElementById('nav');
  NAV.forEach(function (item) {
    var a = el('a', 'tab', item[1]);
    a.href = '#' + item[0];
    a.dataset.k = item[0];
    add(nav, a);
  });
  add(nav, (function () {
    var s = el('span', 'stamp');
    s.id = 'saveState';
    s.textContent = '数据在：' + storage.label;
    return s;
  })());
  window.addEventListener('hashchange', render);
  // 关掉前还有没存下去的改动，提醒一句（电脑上是同步写文件，手机浏览器才有这个风险）
  window.addEventListener('beforeunload', function (e) {
    if (!M.isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  M.loadStore(storage).then(function (r) {
    if (r.error) { toast('数据文件读不出来：' + r.error + '（这次先按空数据打开，别存，先自己备份一下）', 'err'); }
    render();
    if (r.fresh) toast('这是这台设备第一次打开，还没有数据：去设置页导入课表，或直接加待办', 'ok');
  }).catch(function (e) {
    document.getElementById('view').textContent = '启动失败：' + (e.message || e);
  });
}

/* 电脑壳是在页面脚本跑完之后才把桥注进来的，早一步挑存储层会把桌面窗口当成浏览器，
   数据就写进 IndexedDB 而不是那个 JSON 文件。等它一下（没壳最多 1.5 秒就走浏览器那条路）。 */
B.whenBridge().then(boot);
