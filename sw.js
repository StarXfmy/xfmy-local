/*
 * 本地版离线壳 Service Worker
 * ------------------------------------------------------------------
 * 这份文件是模板：build_phone.py 会把下面几个 var 行的双下划线占位符替换成真实值——
 *   BUILD     本次构建的内容指纹（任何文件改动都会变，用来整体换缓存）
 *   BASE      站点在域名下的路径前缀，例如 /xfmy-local/
 *   ENTRY     启动页相对路径，例如 kernel/index.html（断网又没缓存时回落到这一页）
 *   PRECACHE  要预缓存的相对路径数组
 * 装好之后手机没网也能打开；联网时后台自动取新版。
 */

'use strict';

var BUILD = 'e96c7ee09a10';
var BASE = '/xfmy-local/';
var ENTRY = 'kernel/index.html';
var PRECACHE = ["assets/icon-180.png", "assets/icon-192.png", "assets/icon-512.png", "diag.html", "kernel/css/app.css", "kernel/holidays/2025.json", "kernel/holidays/2026.json", "kernel/holidays/2027.json", "kernel/index.html", "kernel/js/bridge.js", "kernel/js/lunar.js", "kernel/js/main.js", "kernel/js/model.js", "kernel/js/net.js", "kernel/js/publish.js", "kernel/js/store/browser.js", "kernel/js/store/index.js", "kernel/js/store/pc.js", "kernel/js/timetable.js", "kernel/js/ui.js", "kernel/js/views.js", "manifest.webmanifest", "sync.mjs", "widget.html"];

var APP_CACHE = 'xfmy-app-' + BUILD;
var API_CACHE = 'xfmy-api-v1';          // 外部接口响应单独一个库，跨构建保留（离线能看上次天气）
var MAX_API_ENTRIES = 120;

// 允许"离线回落"的外部域名：天气、节假日、CDN 库。别的跨源请求一律不拦。
var API_HOSTS = [
  'api.open-meteo.com',
  'archive-api.open-meteo.com',
  'cdn.jsdelivr.net',
  'fastly.jsdelivr.net',
  'raw.githubusercontent.com'
];

function url(u) { return new URL(u, self.location.href); }
function asset(rel) { return url(BASE + String(rel).replace(/^\.\//, '').replace(/^\//, '')); }
function isApiHost(u) {
  try {
    for (var i = 0; i < API_HOSTS.length; i++) if (u.hostname === API_HOSTS[i]) return true;
    return false;
  } catch (e) { return false; }
}

self.addEventListener('install', function (evt) {
  evt.waitUntil(
    caches.open(APP_CACHE).then(function (cache) {
      // 逐个 add，个别文件 404 不该拖垮整个安装
      return Promise.all(PRECACHE.map(function (rel) {
        return cache.add(asset(rel)).catch(function (e) { return void 0; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (evt) {
  evt.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k === APP_CACHE || k === API_CACHE) return void 0;
        return caches.delete(k);           // 旧版本缓存整体清掉，不留半新半旧
      }));
    }).then(function () { return trimApiCache(); })
      .then(function () { return self.clients.claim(); })
  );
});

/* API_CACHE 做个粗上限，防止天气响应无限堆积 */
function trimApiCache() {
  return caches.open(API_CACHE).then(function (cache) {
    return cache.keys();
  }).then(function (keys) {
    if (keys.length <= MAX_API_ENTRIES) return void 0;
    var drop = keys.slice(0, keys.length - MAX_API_ENTRIES);
    return caches.open(API_CACHE).then(function (cache) {
      return Promise.all(drop.map(function (req) { return cache.delete(req); }));
    });
  }).catch(function () { return void 0; });
}

self.addEventListener('fetch', function (evt) {
  var req = evt.request;
  if (req.method !== 'GET') return;
  var u = new URL(req.url);
  var sameOrigin = u.origin === self.location.origin;

  if (sameOrigin) {
    // 页面本身：先要最新的（联网时改动能立刻生效），断网或挂了才回缓存
    if (req.mode === 'navigate' || u.pathname === BASE || u.pathname.indexOf(BASE) === 0 && /\.html$/i.test(u.pathname)) {
      evt.respondWith(networkFirst(req, { fallbackPage: asset(ENTRY) }));
      return;
    }
    // 小组件读的快照：这份是"本机刚发出去的影子"，必须每次尽量取新的。
    // 走 cacheFirst 的话第一次的结果会一直发下去，桌面看到的永远停在发布当天。
    // 挂件那边每十分钟带一个 ?v= 时间戳来绕 Pages 的 CDN 缓存，所以缓存时把查询串抹掉：
    // 不抹的话每个时间戳都是一条新缓存，APP_CACHE 又不清理，几天就攒出几百份同样的快照。
    if (/\/widget[^/]*\.json$/i.test(u.pathname)) {
      var norm = new Request(u.origin + u.pathname, { method: 'GET', credentials: 'omit' });
      evt.respondWith(networkFirstKeep(norm, API_CACHE));
      return;
    }
    // 静态资源：命中缓存直接用（离线可用），没有再取网并回填
    evt.respondWith(cacheFirst(req));
    return;
  }

  if (isApiHost(u)) {
    // 外部数据：联网时取最新并记一份；离线时把上次记的那份给出去
    evt.respondWith(networkFirstKeep(req, API_CACHE));
  }
  // 其它跨源请求（比如他自己填的 AI 接口）不拦，交给浏览器原样处理
});

function cacheFirst(req) {
  return caches.match(req, { ignoreSearch: false }).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(APP_CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    });
  });
}

function networkFirst(req, opts) {
  var o = opts || {};
  return fetch(req).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(APP_CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (hit) {
      if (hit) return hit;
      if (o.fallbackPage) return caches.match(o.fallbackPage);
      return Response.error();
    });
  });
}

function networkFirstKeep(req, cacheName) {
  return fetch(req).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(cacheName).then(function (c) { c.put(req, copy); return trimApiCache(); });
    }
    return res;
  }).catch(function () {
    return caches.open(cacheName).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return hit;
        // 给个可读的空响应，让页面自己显示"这是 X 小时前缓存的天气"
        return new Response(JSON.stringify({ offline: true, cached: true }), {
          status: 504,
          headers: { 'content-type': 'application/json' }
        });
      });
    });
  });
}

// 页面发来"有新版本"时让它自己提示刷新
self.addEventListener('message', function (evt) {
  if (evt.data && evt.data.type === 'xfmy-skip-waiting') self.skipWaiting();
});
