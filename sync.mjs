/**
 * 本地版数据同步核心
 * ------------------------------------------------------------------
 * 用途：电脑（pywebview，数据落 JSON 文件）与手机（PWA，数据落 IndexedDB）
 *      两边都能改，靠「导出改动包 → 传到另一台 → 导入合并」合成同一份。
 * 特点：纯逻辑，不碰 DOM、不碰文件、不碰网络，时间戳与列白名单由调用方注入，
 *      所以能直接在 node 里跑测试。
 *
 * 记录模型（所有集合统一，包括课表）：
 *   rec = { col, id, data, updatedAt, deleted, origin }
 *     col        集合名：todos / events / capsules / courses / timetableSettings ...
 *     id         稳定字符串 id，跨设备必须一致（不要各设备自己生成不同的 id）
 *     data       业务字段本体，只允许 JSON 可序列化的值
 *     updatedAt  毫秒数字，最后一次改动的时间，合并只看它
 *     deleted    true 表示墓碑（删除记录）。删除必须留墓碑，否则另一台下次导出
 *                会把这条又"复活"传回来。
 *     origin     最后改动它的设备名（pc / android / harmony / iphone），只为排查用
 *
 * 关键约定：
 *   1. 设备偏好（主题、字体、时区开关、挂件）**不进同步包**，各台机器自己存自己的。
 *   2. 课表是"整份文档"型数据，同步时拆成 courses 里每门课一条记录 + 一条设置记录，
 *      这样两边各改 different 门课时能各自合并，而不是整张课表互相覆盖。
 *   3. 合并采用 last-write-wins（按 updatedAt 取较新）。被覆盖掉的旧内容不丢，
 *      一律进 conflicts 列表，界面上可回看、可一键还原。
 */

export const KIND = 'xfmy-sync';
export const VER = 1;

/** 默认参与同步的集合；调用方可覆盖 */
export const DEFAULT_COLS = ['todos', 'events', 'capsules', 'courses', 'timetableSettings'];

/** 冲突列表最多留多少条，防止存储无限膨胀 */
export const CONFLICT_CAP = 200;

const ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

/* ------------------------------------------------------------------ 基础工具 */

/** 键排序后序列化，用来判断两条内容是否真的一样 */
export function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function sameData(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function cloneData(v) {
  return v === undefined ? undefined : JSON.parse(stableStringify(v));
}

export function emptyState(device) {
  return { device: device || 'pc', lastSyncAt: 0, records: {}, conflicts: [] };
}

function colMap(state, col, create) {
  if (!state.records[col]) {
    if (!create) return null;
    state.records[col] = {};
  }
  return state.records[col];
}

/* ------------------------------------------------------------------ 本地读写 */

/** 新建或改写一条记录（本地编辑走这里，时间戳由调用方给） */
export function putRecord(state, col, id, data, opts) {
  const o = opts || {};
  if (!ID_RE.test(String(id))) throw new Error('bad id: ' + id);
  const m = colMap(state, col, true);
  const prev = m[id];
  const at = Number(o.updatedAt);
  if (!Number.isFinite(at) || at <= 0) throw new Error('bad updatedAt');
  const rec = {
    col,
    id: String(id),
    data: cloneData(data),
    updatedAt: at,
    deleted: false,
    origin: o.origin || state.device,
  };
  // 同毫秒重复写：仍然覆盖，但 rev 递增，便于人看出"这台改过"
  rec.rev = prev ? Number(prev.rev || 0) + 1 : 1;
  m[id] = rec;
  return rec;
}

/** 删除一条：打墓碑，不是真删。本地没有这条也不报错（另一台可能已经删了） */
export function removeRecord(state, col, id, opts) {
  const o = opts || {};
  const m = colMap(state, col, true);
  const at = Number(o.updatedAt);
  if (!Number.isFinite(at) || at <= 0) throw new Error('bad updatedAt');
  const prev = m[id];
  m[id] = {
    col,
    id: String(id),
    data: prev ? prev.data : null,
    updatedAt: at,
    deleted: true,
    origin: o.origin || state.device,
    rev: prev ? Number(prev.rev || 0) + 1 : 1,
  };
  return m[id];
}

/** 读取列表（墓碑自动过滤），按可选的比较器排序 */
export function listActive(state, col, cmp) {
  const m = colMap(state, col, false);
  if (!m) return [];
  const out = Object.keys(m).map((k) => m[k]).filter((r) => !r.deleted);
  if (cmp) out.sort(cmp);
  return out;
}

export function getRecord(state, col, id) {
  const m = colMap(state, col, false);
  const r = m && m[id];
  return r && !r.deleted ? r : null;
}

/** 清理过期墓碑（比如 30 天前的），传 0 表示全清 */
export function pruneTombstones(state, beforeMs) {
  let n = 0;
  for (const col of Object.keys(state.records)) {
    const m = state.records[col];
    for (const id of Object.keys(m)) {
      const r = m[id];
      if (r.deleted && Number(r.updatedAt) <= Number(beforeMs)) {
        delete m[id];
        n++;
      }
    }
  }
  return n;
}

/* ------------------------------------------------------------------ 导出改动 */

/**
 * 生成同步包。
 *   since: 上次同步时间点（毫秒）。只带 updatedAt > since 的记录。
 *   full : true 时忽略 since，把全部记录（含墓碑）都带上——首次给新设备用。
 */
export function exportChanges(state, opts) {
  const o = opts || {};
  const cols = o.cols || DEFAULT_COLS;
  const full = !!o.full;
  const since = full ? -1 : Number(o.since !== undefined ? o.since : state.lastSyncAt) || 0;
  const out = [];
  const summary = {};
  for (const col of Object.keys(state.records)) {
    if (cols.indexOf(col) < 0) continue;
    const m = state.records[col];
    for (const id of Object.keys(m)) {
      const r = m[id];
      if (Number(r.updatedAt) <= since) continue;
      out.push({
        col: r.col,
        id: r.id,
        data: cloneData(r.data),
        updatedAt: r.updatedAt,
        deleted: !!r.deleted,
        origin: r.origin,
        rev: r.rev,
      });
      summary[col] = (summary[col] || 0) + 1;
    }
  }
  return {
    kind: KIND,
    ver: VER,
    from: o.device || state.device,
    madeAt: Number(o.now) || 0,
    since: full ? null : since,
    full: full,
    summary: summary,
    records: out,
  };
}

/* ------------------------------------------------------------------ 导入合并 */

function pushConflict(list, item) {
  list.push(item);
  if (list.length > CONFLICT_CAP) list.splice(0, list.length - CONFLICT_CAP);
}

/**
 * 把同步包并进本地，返回 { state, report }。
 * 不修改传入的 state（纯函数），report 里给全部分类计数与冲突明细。
 *
 * opts: { cols, now, device, dryRun }
 */
export function importPackage(state, pkg, opts) {
  const o = opts || {};
  const cols = o.cols || DEFAULT_COLS;
  const errors = [];

  if (!state || typeof state !== 'object' || !state.records) throw new Error('本机状态不是对象');
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('同步包不是对象');
  if (pkg.kind !== KIND) errors.push('kind 不是 ' + KIND);
  if (Number(pkg.ver) !== VER) errors.push('ver 不支持: ' + pkg.ver);
  if (!Array.isArray(pkg.records)) errors.push('records 不是数组');
  if (errors.length) return { state: state, report: { ok: false, errors: errors } };

  const next = {
    device: state.device,
    lastSyncAt: Number(state.lastSyncAt) || 0,
    records: {},
    conflicts: (state.conflicts || []).slice(),
  };
  for (const col of Object.keys(state.records)) {
    next.records[col] = {};
    for (const id of Object.keys(state.records[col])) next.records[col][id] = Object.assign({}, state.records[col][id]);
  }

  const rep = {
    ok: true,
    added: 0,
    updated: 0,
    deleted: 0,
    revived: 0,
    skippedOlder: 0,
    skippedSame: 0,
    ignoredTombstone: 0,
    rejected: 0,
    conflicts: [],
    incomingFrom: pkg.from,
    packageCount: pkg.records.length,
  };

  let maxSeen = 0;
  for (const r of pkg.records) {
    const col = r && r.col;
    const id = r && r.id;
    if (!col || id === undefined || id === null || !ID_RE.test(String(id))) { rep.rejected++; continue; }
    if (cols.indexOf(col) < 0) { rep.rejected++; continue; }
    const at = Number(r.updatedAt);
    if (!Number.isFinite(at) || at <= 0) { rep.rejected++; continue; }
    maxSeen = Math.max(maxSeen, at);

    const m = colMap(next, col, true);
    const local = m[String(id)];
    const incoming = {
      col: col,
      id: String(id),
      data: cloneData(r.data),
      updatedAt: at,
      deleted: !!r.deleted,
      origin: r.origin || pkg.from || 'unknown',
      rev: Number(r.rev) || 1,
    };

    // 本地没有这条
    if (!local) {
      if (incoming.deleted) { rep.ignoredTombstone++; continue; }   // 要删一条本来就不在的，不用留墓碑
      m[incoming.id] = incoming;
      rep.added++;
      continue;
    }

    // 来者更旧 → 不动
    if (incoming.updatedAt < Number(local.updatedAt)) { rep.skippedOlder++; continue; }

    // 时间相同
    if (incoming.updatedAt === Number(local.updatedAt)) {
      if (sameData(local.data, incoming.data) && !!local.deleted === !!incoming.deleted) { rep.skippedSame++; continue; }
      // 同刻不同内容：保留本地，把来者收进冲突等人裁决，绝不静默覆盖
      pushConflict(next.conflicts, {
        reason: 'same-time',
        col: col, id: incoming.id, at: o.now || incoming.updatedAt,
        local: { data: local.data, deleted: !!local.deleted, updatedAt: local.updatedAt, origin: local.origin },
        incoming: { data: incoming.data, deleted: incoming.deleted, updatedAt: incoming.updatedAt, origin: incoming.origin },
      });
      const c = next.conflicts[next.conflicts.length - 1];
      c.key = col + '/' + incoming.id + '/' + incoming.updatedAt;
      rep.conflicts.push(c.key);
      continue;
    }

    // 来者更新
    if (incoming.deleted) {
      if (!local.deleted) {
        // 本地这份被对方删掉了：内容进冲突区，误删能找回
        pushConflict(next.conflicts, {
          reason: 'deleted-by-' + incoming.origin,
          col: col, id: incoming.id, at: o.now || incoming.updatedAt,
          local: { data: local.data, deleted: false, updatedAt: local.updatedAt, origin: local.origin },
          incoming: { data: null, deleted: true, updatedAt: incoming.updatedAt, origin: incoming.origin },
        });
        const c = next.conflicts[next.conflicts.length - 1];
        c.key = col + '/' + incoming.id + '/' + incoming.updatedAt;
        rep.conflicts.push(c.key);
        rep.deleted++;
      }
      m[incoming.id] = Object.assign({}, incoming, { data: local.data });   // 墓碑保留最后已知内容
      continue;
    }

    if (local.deleted) {
      // 本地是墓碑、对方那份内容更新 → 算改回来（复活）
      rep.revived++;
    } else if (!sameData(local.data, incoming.data)) {
      pushConflict(next.conflicts, {
        reason: 'overwritten',
        col: col, id: incoming.id, at: o.now || incoming.updatedAt,
        local: { data: local.data, deleted: false, updatedAt: local.updatedAt, origin: local.origin },
        incoming: { data: incoming.data, deleted: false, updatedAt: incoming.updatedAt, origin: incoming.origin },
      });
      const c = next.conflicts[next.conflicts.length - 1];
      c.key = col + '/' + incoming.id + '/' + incoming.updatedAt;
      rep.conflicts.push(c.key);
      rep.updated++;
    } else {
      rep.updated++;
    }
    m[incoming.id] = incoming;
  }

  if (!o.dryRun) {
    // 记下"这份包里最新的时间"，下次导出只带这之后的
    next.lastSyncAt = Math.max(next.lastSyncAt, maxSeen);
  }
  rep.newLastSyncAt = next.lastSyncAt;
  return { state: next, report: rep };
}

/** 导入后人工裁决冲突：take='incoming' 用对方那份，take='local' 就等于丢掉冲突项 */
export function resolveConflict(state, key, take, opts) {
  const o = opts || {};
  const list = state.conflicts || [];
  const idx = list.findIndex((c) => c.key === key);
  if (idx < 0) return { ok: false, reason: 'not-found' };
  const c = list[idx];
  if (take === 'incoming') {
    const m = colMap(state, c.col, true);
    const rec = {
      col: c.col,
      id: c.id,
      data: cloneData(c.incoming.data),
      updatedAt: Number(o.now) || Date.now(),
      deleted: !!c.incoming.deleted,
      origin: (o.device || state.device) + '/resolve',
      rev: Number((m[c.id] && m[c.id].rev) || 0) + 1,
    };
    m[c.id] = rec;
  }
  list.splice(idx, 1);
  return { ok: true, took: take };
}

/* ------------------------------------------------------------------ 全量备份 */

/** 全量备份（含冲突列表），用于防浏览器/系统清存储 */
export function fullBackup(state, opts) {
  const o = opts || {};
  return {
    kind: 'xfmy-backup',
    ver: VER,
    device: state.device,
    madeAt: Number(o.now) || 0,
    lastSyncAt: state.lastSyncAt,
    records: cloneData(flattenRecords(state)),
    conflicts: cloneData(state.conflicts || []),
  };
}

function flattenRecords(state) {
  const out = [];
  for (const col of Object.keys(state.records)) {
    const m = state.records[col];
    for (const id of Object.keys(m)) out.push(Object.assign({}, m[id]));
  }
  return out;
}

/** 从全量备份恢复：整体覆盖本机（导入前应先自行导出本机一份留底） */
export function restoreBackup(backup, opts) {
  const o = opts || {};
  const errors = [];
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) throw new Error('备份不是对象');
  if (backup.kind !== 'xfmy-backup') errors.push('kind 不是 xfmy-backup');
  if (!Array.isArray(backup.records)) errors.push('records 不是数组');
  if (errors.length) return { ok: false, errors: errors };
  const st = emptyState(o.device || backup.device);
  st.lastSyncAt = Number(backup.lastSyncAt) || 0;
  for (const r of backup.records) {
    if (!r || !r.col || !ID_RE.test(String(r.id))) continue;
    const m = colMap(st, r.col, true);
    m[String(r.id)] = {
      col: r.col,
      id: String(r.id),
      data: cloneData(r.data),
      updatedAt: Number(r.updatedAt) || 0,
      deleted: !!r.deleted,
      origin: r.origin || 'restore',
      rev: Number(r.rev) || 1,
    };
  }
  st.conflicts = Array.isArray(backup.conflicts) ? cloneData(backup.conflicts) : [];
  return { ok: true, state: st };
}

/** 把"整份课表文档"拆成 courses 记录，喂进状态。改门次时间表走 timetableSettings */
export function loadTimetable(state, table, opts) {
  const o = opts || {};
  const at = Number(o.updatedAt);
  if (!Number.isFinite(at) || at <= 0) throw new Error('bad updatedAt');
  const idOf = o.idOf || ((c, i) => 'course-' + String(c.id !== undefined ? c.id : i));
  const kept = [];
  const courses = (table && Array.isArray(table.courses)) ? table.courses : [];
  courses.forEach((c, i) => {
    const id = idOf(c, i);
    kept.push(id);
    const m = colMap(state, 'courses', true);
    const prev = m[id];
    if (!prev || !sameData(prev.data, c)) m[id] = { col: 'courses', id: id, data: cloneData(c), updatedAt: at, deleted: false, origin: o.origin || state.device, rev: prev ? Number(prev.rev || 0) + 1 : 1 };
    else if (prev.deleted) m[id] = { col: 'courses', id: id, data: cloneData(c), updatedAt: at, deleted: false, origin: o.origin || state.device, rev: Number(prev.rev || 0) + 1 };
  });
  // 这一次没有的课，视为删掉（打墓碑）
  const m = colMap(state, 'courses', true);
  for (const id of Object.keys(m)) {
    if (kept.indexOf(id) < 0 && !m[id].deleted) m[id] = { col: 'courses', id: id, data: m[id].data, updatedAt: at, deleted: true, origin: o.origin || state.device, rev: Number(m[id].rev || 0) + 1 };
  }
  const settings = (table && typeof table === 'object') ? { termStart: table.termStart, weeks: table.weeks, periods: table.periods } : {};
  putRecord(state, 'timetableSettings', 'main', settings, { updatedAt: at, origin: o.origin });
  return { courseCount: courses.length };
}

/** 把 courses 记录组回"整份课表"给 UI 用 */
export function dumpTimetable(state) {
  const courses = listActive(state, 'courses').map((r) => r.data);
  const s = getRecord(state, 'timetableSettings', 'main');
  const st = s ? s.data : {};
  return {
    courses: courses,
    termStart: st.termStart,
    weeks: st.weeks,
    periods: st.periods,
  };
}

/* ---------------------------------------------------- 站点导出数据的一次性搬运 */

/**
 * 站点版导出的 backup-*.json（形如 {todos:[...], events:[...], capsules:[...]}）
 * 一次性灌进本地版。之后两边就是各自独立的账本，不再互相回写。
 *   opts.cols      要搬哪些集合，默认待办/日程/时光胶囊（动态、云盘这类本地版没有）
 *   opts.now       记录缺 created_at 时用的时间戳
 *   opts.overwrite 默认 false：本地已有同 id 就不动，避免重跑把改动盖掉
 */
export function importLegacyBackup(state, backup, opts) {
  const o = opts || {};
  const cols = o.cols || ['todos', 'events', 'capsules'];
  const fallback = Number(o.now) || Date.now();
  const imported = {};
  let skipped = 0;
  const unknown = [];
  if (!backup || typeof backup !== 'object') throw new Error('站点备份不是对象');
  for (const key of Object.keys(backup)) {
    const list = backup[key];
    if (!Array.isArray(list)) continue;
    if (cols.indexOf(key) < 0) { unknown.push(key); continue; }
    list.forEach((item, i) => {
      if (!item || typeof item !== 'object') { skipped++; return; }
      const id = item.id !== undefined && item.id !== null && String(item.id) !== '' ? String(item.id) : key + '-' + i;
      if (!ID_RE.test(id)) { skipped++; return; }
      const m = colMap(state, key, true);
      if (m[id] && !o.overwrite) { skipped++; return; }
      const data = {};
      for (const f of Object.keys(item)) {
        if (f === 'id' || f === 'created_at' || f === 'file') continue;
        data[f] = cloneData(item[f]);
      }
      const at = Date.parse(item.created_at);
      putRecord(state, key, id, data, {
        updatedAt: Number.isFinite(at) && at > 0 ? at : fallback,
        origin: o.origin || 'site-import',
      });
      imported[key] = (imported[key] || 0) + 1;
    });
  }
  return { imported: imported, skipped: skipped, ignoredCollections: unknown };
}
