# 本地课表

自己的课表、日历、待办与天气。纯前端，没有后端、没有账号。

**这个仓库里只有代码，没有任何个人数据。** 你的课表、待办、日程、时光胶囊都只存在你设备上：

- 电脑（pywebview 壳）：`本地版数据.json`
- 手机 / 浏览器：IndexedDB

换设备靠「同步」页导出改动包再导入合并，不走任何服务器。

## 用法

把本仓库内容放到任意静态托管的 `/xfmy-local/` 路径下。用 GitHub Pages 就是仓库 Settings → Pages → Source 选 `main` + `/ (root)` → Save，然后手机浏览器访问

```
https://<账号>.github.io/xfmy-local/kernel/index.html
```

再「添加到主屏幕」。装一次之后可以完全离线使用：Service Worker 预缓存全部文件，外部天气接口取不到时会回放上次缓存的那份并标注取用时间。

手机上手忙脚乱时打开 `https://<账号>.github.io/xfmy-local/diag.html`，它会自己测：能不能注册离线壳、缓存了多少文件、IndexedDB 能不能真写进去、那几个标签在不在页面里。

## 改了代码后重新打包

`sync.mjs` 与 `kernel/` 的相对层级必须保住（`kernel/js/model.js` 里是 `import '../../sync.mjs'`），所以要先摆一个暂存目录再打包：

```bash
mkdir -p stage/app
cp -r kernel stage/app/kernel
cp sync.mjs  stage/app/sync.mjs
MSYS_NO_PATHCONV=1 py -3 build_phone.py stage/app \
  --base /xfmy-local/ --entry kernel/index.html --exclude test \
  --icon-src pc/dayplan.ico --out dist/xfmy-local
```

两个坑：

- `--base` 必须和实际访问路径**逐字一致**，错了就是手机装完白屏、第二次打开也不报错。Git Bash 会把 `/xxx/` 改写成本机路径，所以命令前要加 `MSYS_NO_PATHCONV=1`；脚本遇到带盘符、反斜杠、空格的 base 会直接拒绝产出。
- 输出目录里如果已经有 `.git`，重打包会保住它（脚本先把 `.git` 挪到临时目录再放回）。手动删掉 `.git` 重新 init 会让提交与远端历史无关，push 会被拒。

## 注意

数据只有设备本地这一份副本，浏览器或系统清理功能可能把它清掉。请定期在「同步」页点「导出全量备份」并把那个 JSON 存到别处——这里没有云端兜底。
