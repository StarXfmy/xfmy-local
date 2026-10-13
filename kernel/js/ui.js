/* 界面小工具：建元素、转义、提示条、确认框。
   刻意不用 innerHTML 拼用户数据 —— 待办文字、课程名这些都是自己写的字符串，
   走 textContent 就省掉一整类注入麻烦。 */

export function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

export function add(parent) {
  for (var i = 1; i < arguments.length; i++) {
    var k = arguments[i];
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) { k.forEach(function (x) { add(parent, x); }); continue; }
    parent.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  }
  return parent;
}

export function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }

export function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** "2026-10-13" → "10月13日" */
export function cnDay(ds) {
  ds = String(ds || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return '';
  return Number(ds.slice(5, 7)) + '月' + Number(ds.slice(8, 10)) + '日';
}

export function weekdayCn(dow) { return ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][dow - 1] || ''; }

let toastTimer = null;
/** 一句话提示；kind 用 'ok' / 'err' / 'warn' */
export function toast(text, kind) {
  var box = document.getElementById('toast');
  if (!box) return;
  box.textContent = String(text || '');
  box.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { box.className = 'toast'; }, kind === 'err' ? 5200 : 2600);
}

/** 危险操作前问一句（删除、覆盖导入、恢复备份） */
export function confirmBox(question) {
  return Promise.resolve(window.confirm(question));
}

/** 一个按钮 */
export function button(label, cls, onClick) {
  var b = el('button', 'btn ' + (cls || ''), label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** 一行输入：标签 + input */
export function field(label, input) {
  var row = el('label', 'field');
  add(row, el('span', 'flabel', label), input);
  return row;
}

export function input(attrs, value) {
  var i = document.createElement('input');
  Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
  if (value !== undefined) i.value = value;
  return i;
}

export function select(options, value) {
  var s = document.createElement('select');
  options.forEach(function (o) {
    var op = document.createElement('option');
    op.value = o[0]; op.textContent = o[1];
    s.appendChild(op);
  });
  if (value !== undefined) s.value = value;
  return s;
}

/** 卡片外壳：标题 + 右上角说明 + 内容 */
export function card(title, sub) {
  var box = el('section', 'card');
  if (title) {
    var head = el('div', 'chead');
    add(head, el('h2', null, title), sub ? el('span', 'csub', sub) : null);
    box.appendChild(head);
  }
  var body = el('div', 'cbody');
  box.appendChild(body);
  box.body = body;
  return box;
}
