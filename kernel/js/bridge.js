/* 与"文件"有关的能力：选一个文件读进来、把一段文本存成文件。
   电脑上有 pywebview 的桥就走桥（能落到真实文件、方便微信传出去），
   没有桥（手机/普通浏览器）就退回 <input type=file> 与 <a download>。
   页面只调 pickText() / saveText()，不关心自己跑在哪。 */

function api() {
  var a = (typeof window !== 'undefined' && window.pywebview && window.pywebview.api) || null;
  return a && typeof a.file_pick === 'function' && typeof a.file_save === 'function' ? a : null;
}

/** 读一个文本文件；用户取消返回 null。 */
export function pickText(accept) {
  var a = api();
  if (a) return Promise.resolve(a.file_pick(accept || '.json')).then(function (r) {
    // 电脑壳出错时给的是 {err:'…'}：不拦下来就会被当成文件内容往下传，报错信息也就丢了
    if (r && typeof r === 'object' && r.err) throw new Error(r.err);
    return r || null;
  });
  return new Promise(function (resolve) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = accept || '.json,application/json';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      if (!f) { input.remove(); return resolve(null); }
      var fr = new FileReader();
      fr.onload = function () { input.remove(); resolve(String(fr.result)); };
      fr.onerror = function () { input.remove(); resolve(null); };
      fr.readAsText(f);
    });
    input.click();
  });
}

/** 把文本存成文件；返回一句人话说明存哪儿了。 */
export function saveText(name, text) {
  var a = api();
  if (a) return Promise.resolve(a.file_save(name, text)).then(function (r) {
    var s = String(r || '');
    if (s.indexOf('err') === 0) throw new Error(s);
    return '已存到：' + s;
  });
  var url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  var link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  return Promise.resolve('已交给浏览器下载：' + name);
}

/** 这台设备走的是哪条路，给设置页显示用 */
export function mode() {
  return api() ? '电脑（直接读写文件）' : '浏览器（用下载与选择文件）';
}

/** 等电脑壳把 window.pywebview.api 注进来再用存储层。
   pywebview 是页面脚本跑完之后才注入桥的，立刻判断会把桌面窗口错当成浏览器，
   数据就写进了 IndexedDB 而不是那个 JSON 文件。没有壳时最多等 timeoutMs 就放弃。 */
export function whenBridge(timeoutMs) {
  if (api()) return Promise.resolve(true);
  if (typeof window === 'undefined') return Promise.resolve(false);
  var limit = timeoutMs === undefined ? 1500 : timeoutMs;
  return new Promise(function (resolve) {
    var settled = false;
    var finish = function () {
      if (settled) return;
      settled = true;
      window.removeEventListener('pywebviewready', onReady);
      clearInterval(poll);
      resolve(!!api());
    };
    var onReady = function () { if (api()) finish(); };
    window.addEventListener('pywebviewready', onReady);
    var waited = 0;
    var poll = setInterval(function () { waited += 50; api() || waited >= limit ? finish() : null; }, 50);
  });
}
