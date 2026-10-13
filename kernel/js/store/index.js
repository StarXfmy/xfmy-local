/* 存储层入口：挑一个实现给上层用。
   电脑上有 pywebview 的桥就用文件（看得见、拷得走），否则退回 IndexedDB。
   两个实现接口一样：load() / save(state) / label。 */
import * as pc from './pc.js';
import * as browser from './browser.js';

export function createStorage(prefer) {
  if (prefer !== 'browser' && pc.available()) return pc.create();
  if (browser.available()) return browser.create();
  throw new Error('这台设备既没有文件桥也没有 IndexedDB，存不了数据');
}
