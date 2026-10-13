/* 存储层·浏览器实现：状态整份存进 IndexedDB 的一条记录。
   手机版走这里；电脑上如果 pywebview 的桥没接上，也退回这里（至少不丢数据）。
   上层只看到 load()/save()，不知道底下是文件还是 IndexedDB。 */
const DB_NAME = 'xfmy-local';
const DB_VER = 1;
const STORE = 'state';
const KEY = 'state';

function openDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = function () {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('IndexedDB 打不开')); };
    req.onblocked = function () { reject(new Error('IndexedDB 被别的标签页占着')); };
  });
}

function withStore(mode, fn) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, mode);
      var req = fn(tx.objectStore(STORE));
      tx.oncomplete = function () { resolve(req && req.result); };
      tx.onerror = function () { reject(tx.error || new Error('读写失败')); };
      tx.onabort = function () { reject(tx.error || new Error('事务被中止')); };
    }).finally(function () { db.close(); });
  });
}

export function available() {
  return typeof indexedDB !== 'undefined';
}

export function create() {
  return {
    kind: 'indexeddb',
    label: '浏览器本地存储（IndexedDB）',
    load: function () { return withStore('readonly', function (s) { return s.get(KEY); }); },
    save: function (state) { return withStore('readwrite', function (s) { return s.put(state, KEY); }); },
    wipe: function () { return withStore('readwrite', function (s) { return s.delete(KEY); }); }
  };
}
