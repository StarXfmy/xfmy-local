/* 内核的数据模型：整份应用里**只有这一层**碰同步层（../../sync.mjs）。
   上层（界面）拿到的是"待办列表、整份课表"这种东西，不需要知道背后是一条条记录。

   三条硬规矩（来自 手机本地版方案.md 第四节）：
   1. 数据一律走记录模型 {col,id,data,updatedAt,deleted,origin}，删除留墓碑；
   2. id 跨设备必须同一个：搬站点的沿用原 id，本地新建走这里的 newId()；
   3. 课表拆条存（一门课一条 + 一条设置），改一门课不会把另一台改的那门一起抹掉。 */
import * as S from '../../sync.mjs';

/* ---------------------------------------------------------------- 设备与 id */

/** 这台设备叫什么。origin 字段与导出包的 from 都用它，排查同步问题时看得懂是谁改的。 */
export function detectDevice() {
  var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (typeof window !== 'undefined' && window.pywebview) return 'pc';
  if (/HarmonyOS|HUAWEI.*Mobile.*Browser|ArkWeb/i.test(ua)) return 'harmony';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iphone';
  if (/Android/i.test(ua)) return 'android';
  return /Windows|Macintosh|X11/i.test(ua) ? 'pc' : 'browser';
}

/** 本地新建记录的 id：时间戳(base36) + 随机尾巴。所有端共用这一个生成器，
   不然同一门课在两台手机上各生成一套 id，同步时就变成"两条课"。 */
export function newId(prefix) {
  var t = Date.now().toString(36);
  var r = Math.random().toString(36).slice(2, 6);
  return (prefix ? prefix + '-' : '') + t + r;
}

export function now() { return Date.now(); }

/* ---------------------------------------------------------------- 状态装载 */

let state = null;
let storage = null;
let dirty = false;
let saving = null;

export function device() { return state ? state.device : detectDevice(); }

export function attach(st, store) {
  storage = store;
  state = st && st.records ? st : S.emptyState(detectDevice());
  state.device = state.device || detectDevice();
  if (!Array.isArray(state.conflicts)) state.conflicts = [];
  return state;
}

export async function loadStore(store) {
  var raw = null;
  try { raw = await store.load(); }
  catch (e) { return { error: e.message || String(e), state: null }; }
  if (raw && typeof raw === 'object' && raw.records) return { state: attach(raw, store), storage: store };
  var fresh = S.emptyState(detectDevice());
  return { state: attach(fresh, store), storage: store, fresh: true };
}

/** 改动之后落盘。连续改多次只写一次（输入框逐字保存不至于把磁盘打爆）。 */
export function persist() {
  dirty = true;
  if (saving) return saving;
  saving = Promise.resolve().then(function () {
    saving = null;
    if (!dirty) return null;
    dirty = false;
    return storage.save(JSON.parse(JSON.stringify(state)));
  });
  return saving;
}

export function isDirty() { return dirty; }

/* ---------------------------------------------------------------- 待办 */

const byOrderThenTime = function (a, b) {
  var A = a.data || {}, B = b.data || {};
  if (!!A.done !== !!B.done) return A.done ? 1 : -1;
  var da = String(A.date || ''), db = String(B.date || '');
  if (da !== db) return da < db ? -1 : 1;
  return (Number(A.order) || 0) - (Number(B.order) || 0);
};

export function todos() { return S.listActive(state, 'todos', byOrderThenTime).map(unwrap); }

export function addTodo(data) {
  var id = (data && data.id) || newId('todo');
  var rec = S.putRecord(state, 'todos', id, {
    text: String((data && data.text) || '').slice(0, 500),
    done: false,
    date: normalizeDate(data && data.date),
    order: Number(data && data.order) || now(),
    createdAt: now()
  }, { updatedAt: now() });
  return unwrap(rec);
}

export function patchTodo(id, patch) {
  var rec = S.getRecord(state, 'todos', id);
  if (!rec) return null;
  var next = Object.assign({}, rec.data, patch);
  next.text = String(next.text || '').slice(0, 500);
  next.date = normalizeDate(next.date);
  next.done = !!next.done;
  if (patch.doneAt === undefined && patch.done) next.doneAt = now();
  return unwrap(S.putRecord(state, 'todos', id, next, { updatedAt: now() }));
}

export function removeTodo(id) { return S.removeRecord(state, 'todos', id, { updatedAt: now() }); }

/* ---------------------------------------------------------------- 日程 */

export function events() {
  return S.listActive(state, 'events', function (a, b) {
    return String(a.data.date).localeCompare(String(b.data.date)) || (a.data.createdAt || 0) - (b.data.createdAt || 0);
  }).map(unwrap);
}

export function addEvent(data) {
  var id = (data && data.id) || newId('event');
  return unwrap(S.putRecord(state, 'events', id, {
    date: normalizeDate(data.date),
    title: String((data && data.title) || '').slice(0, 100),
    kind: (data && (data.kind === 'birthday' || data.kind === 'lunar-birthday')) ? data.kind : 'event',
    createdAt: now()
  }, { updatedAt: now() }));
}

export function removeEvent(id) { return S.removeRecord(state, 'events', id, { updatedAt: now() }); }

/* ---------------------------------------------------------------- 课表
   存的时候是一门课一条记录 + 一条 timetableSettings，
   用的时候通过 timetableDoc() 拼回整份，界面照旧按整份表算。 */

export function timetableDoc() {
  var d = S.dumpTimetable(state) || {};
  return {
    termStart: normalizeDate(d.termStart),
    weeks: clampInt(d.weeks, 1, 70, 0),
    periods: Array.isArray(d.periods) ? d.periods.slice(0, 20).map(normalizePeriod).filter(Boolean) : [],
    courses: (Array.isArray(d.courses) ? d.courses : []).filter(isValidCourse).sort(byCourse)
  };
}

/** 只改一门课（新增/编辑/删除都走单条记录），不要整份覆盖。 */
export function putCourse(course) {
  var id = courseId(course.id);
  var data = {
    id: id, name: String(course.name || '').slice(0, 60), teacher: String(course.teacher || '').slice(0, 40),
    room: String(course.room || '').slice(0, 40), day: clampInt(course.day, 1, 7, 0),
    start: normalizeHm(course.start), end: normalizeHm(course.end),
    pStart: clampInt(course.pStart, 1, 30, 0), pEnd: clampInt(course.pEnd, 1, 30, 0),
    weekFrom: clampInt(course.weekFrom, 1, 70, 1), weekTo: clampInt(course.weekTo, 1, 70, 1),
    weeks: normalizeWeeks(course.weeks)
  };
  if (data.weekTo < data.weekFrom) data.weekTo = data.weekFrom;
  return unwrap(S.putRecord(state, 'courses', id, data, { updatedAt: now() }));
}

export function removeCourse(id) { return S.removeRecord(state, 'courses', id, { updatedAt: now() }); }

/** 学期设置（开学日、总周数、节次时刻表）单独一条记录，改它不影响任何一门课 */
export function putTimetableSettings(patch) {
  var rec = S.getRecord(state, 'timetableSettings', 'main');
  var cur = rec ? rec.data : {};
  var next = {
    termStart: patch.termStart === undefined ? normalizeDate(cur.termStart) : normalizeDate(patch.termStart),
    weeks: patch.weeks === undefined ? clampInt(cur.weeks, 1, 70, 0) : clampInt(patch.weeks, 1, 70, 0),
    periods: patch.periods === undefined ? (Array.isArray(cur.periods) ? cur.periods : [])
      : patch.periods.map(normalizePeriod).filter(Boolean)
  };
  return unwrap(S.putRecord(state, 'timetableSettings', 'main', next, { updatedAt: now() }));
}

/** 从站点导出的课表.json 一次性搬过来（字段名对齐：totalWeeks→weeks、slots→periods） */
export function importTimetableDoc(doc) {
  var src = doc && doc.timetable ? doc.timetable : doc;
  if (!src || !Array.isArray(src.courses)) throw new Error('这份文件里没有 courses 清单，不像课表');
  var at = now();
  var mapped = {
    termStart: normalizeDate(src.termStart),
    weeks: clampInt(src.weeks !== undefined ? src.weeks : src.totalWeeks, 1, 70, 0),
    periods: (Array.isArray(src.periods) ? src.periods : (Array.isArray(src.slots) ? src.slots : [])).map(normalizePeriod).filter(Boolean),
    courses: src.courses.filter(isValidCourse).map(function (c) {
      return Object.assign({}, c, { id: courseId(c.id), weeks: normalizeWeeks(c.weeks) });
    })
  };
  // 整份灌进来只在"导入"这一次发生（用户明确要覆盖），日常编辑走 putCourse
  // idOf 必须显式给：不传的话同步层会把记录 id 写成 "course-"+data.id，而 putCourse 用的记录 id 就是 data.id，
  // 两边对不上，导入的课一编辑就变成两门
  return S.loadTimetable(state, mapped, { updatedAt: at, idOf: function (c) { return String(c.id); } });
}

/* ---------------------------------------------------------------- 同步四件事 */

export function exportChanges(opts) {
  return S.exportChanges(state, Object.assign({ now: now(), device: state.device }, opts || {}));
}

export function importPackage(pkg, opts) {
  var r = S.importPackage(state, pkg, Object.assign({ now: now(), device: state.device }, opts || {}));
  state = r.state;
  return r.report;
}

/** 站点「我的」页导出的 backup.json（{todos:[],events:[],capsules:[]}）一次性搬进来。
   之后两边各记各的账，不再回写。默认不覆盖同 id 的现有记录，免得重跑把改动盖掉。 */
export function importLegacyBackup(backup, opts) {
  return S.importLegacyBackup(state, backup, Object.assign({ now: now(), origin: 'site-import' }, opts || {}));
}

export function conflicts() { return (state.conflicts || []).slice().reverse(); }

/** 裁决一条冲突。同步层处理 'local' 只把冲突项划掉，可「被对方盖掉」和「被对方删掉」这两类
   本机内容已经变成对方那份了 —— 不写回来，界面上那句"留我这版"就是假的。 */
export function resolveConflict(key, take) {
  var pending = (state.conflicts || []).filter(function (c) { return c.key === key; })[0];
  var r = S.resolveConflict(state, key, take, { now: now(), device: state.device });
  if (r.ok && take === 'local' && pending && pending.reason !== 'same-time'
    && pending.local && !pending.local.deleted && pending.local.data) {
    S.putRecord(state, pending.col, pending.id, pending.local.data, { updatedAt: now(), origin: state.device + '/keep-local' });
  }
  return r;
}

export function fullBackup() { return S.fullBackup(state, { now: now() }); }

export function restoreBackup(backup) {
  var r = S.restoreBackup(backup, { device: state.device });
  if (r.ok) attach(r.state, storage);
  return r;
}

export function stats() {
  var cols = {}, tomb = 0;
  Object.keys(state.records || {}).forEach(function (c) {
    var m = state.records[c], n = 0;
    Object.keys(m).forEach(function (k) { if (m[k].deleted) tomb++; else n++; });
    if (n) cols[c] = n;
  });
  return { cols: cols, tombstones: tomb, conflicts: (state.conflicts || []).length, lastSyncAt: state.lastSyncAt || 0 };
}

/** 同步状态里"上次同步到什么时候"，导出改动只带这之后的 */
export function lastSyncAt() { return state.lastSyncAt || 0; }

/* ---------------------------------------------------------------- 小工具 */

function unwrap(rec) { return Object.assign({ id: rec.id }, rec.data, { updatedAt: rec.updatedAt, origin: rec.origin }); }

function normalizeDate(v) {
  var s = String(v || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function normalizeHm(v) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return '';
  var h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return '';
  // 分和时都要补零：只补小时会把 08:00 写成 "08:0"，下一轮校验时这条就被当无效悄悄丢掉了
  return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
}

function normalizePeriod(p) {
  if (!p) return null;
  var s = normalizeHm(p.start), e = normalizeHm(p.end);
  return s && e ? { start: s, end: e } : null;
}

function normalizeWeeks(v) {
  if (Array.isArray(v)) return v.map(Number).filter(function (n) { return Number.isInteger(n) && n >= 1 && n <= 70; }).slice(0, 70);
  if (typeof v === 'string') {
    // 教务那种「2-6周,9-17周(双)」的写法，导入时能认就认，认不出就留空（留空表示按起止周算）
    var out = [];
    v.split(/[,，;；]/).forEach(function (seg) {
      var m = /^\s*(\d+)\s*(?:[-~～至]\s*(\d+)\s*)?周/.exec(seg);
      if (!m) return;
      var a = +m[1], b = m[2] ? +m[2] : a, odd = /单/.test(seg), even = /双/.test(seg);
      for (var w = a; w <= b && w <= 70; w++) {
        if ((odd && w % 2 === 0) || (even && w % 2 === 1)) continue;
        if (out.indexOf(w) < 0) out.push(w);
      }
    });
    return out;
  }
  return [];
}

function clampInt(v, lo, hi, fallback) {
  var n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
}

/** 记录 id 允许的字符，跟同步层的 ID_RE 对齐：站点那份里带空格或中文的 id 换成本机生成号，
   不然导出的包在另一台会被当成非法 id 直接丢条。 */
const ID_SAFE = /^[A-Za-z0-9_.:-]{1,120}$/;

function courseId(v) {
  var s = v === undefined || v === null ? '' : String(v).trim();
  return ID_SAFE.test(s) ? s : newId('course');
}

function isValidCourse(c) {
  if (!c || typeof c !== 'object' || !String(c.name || '').trim()) return false;
  var d = Number(c.day);
  if (!Number.isInteger(d) || d < 1 || d > 7) return false;      // 星期越界整条丢，不夹到 1～7 里
  var hasTime = normalizeHm(c.start) && normalizeHm(c.end) && normalizeHm(c.start) < normalizeHm(c.end);
  var hasPeriod = Number(c.pStart) >= 1 && Number(c.pEnd) >= Number(c.pStart);
  return hasTime || hasPeriod;
}

function byCourse(a, b) {
  return a.day - b.day || (a.pStart || 0) - (b.pStart || 0) || String(a.start || '').localeCompare(String(b.start || ''));
}

/* ---------------------------------------------------------------- 设备偏好
   主题、字体、时区、城市这些**不进同步包**：手机上试个配色不该把电脑也改了。 */
const PREF_KEY = 'xfmy-local-prefs';
let prefs = null;

export function prefsAll() {
  if (prefs) return prefs;
  try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { prefs = {}; }
  return prefs;
}

export function pref(k, fallback) {
  var v = prefsAll()[k];
  return v === undefined ? fallback : v;
}

export function setPref(k, v) {
  var p = prefsAll();
  if (v === undefined) delete p[k]; else p[k] = v;
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) {}
  return v;
}
