/* 存储层·电脑实现：把状态写进电脑上一个真实的 JSON 文件，路径由 pywebview 壳决定。
   这是整个内核里**唯一**允许直接碰 window.pywebview.api 的地方（写文件这件事只有壳能做），
   上层照旧只看到 load()/save()。 */

function bridge() {
  var api = (typeof window !== 'undefined' && window.pywebview && window.pywebview.api) || null;
  return api && typeof api.state_read === 'function' && typeof api.state_write === 'function' ? api : null;
}

export function available() {
  return !!bridge();
}

export function create() {
  var api = bridge();
  return {
    kind: 'file',
    label: '本地文件（电脑上的数据文件）',
    load: function () {
      return Promise.resolve(api.state_read()).then(function (text) {
        if (!text) return null;
        try { return JSON.parse(text); }
        catch (e) { throw new Error('数据文件读不出来的：' + e.message); }
      });
    },
    save: function (state) {
      return Promise.resolve(api.state_write(JSON.stringify(state))).then(function (r) {
        if (r && String(r).indexOf('err') === 0) throw new Error('写数据文件失败：' + r);
        return r;
      });
    }
  };
}
