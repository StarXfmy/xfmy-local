# 本地课表

课表、日历、待办与天气。纯前端，没有后端、没有账号。

一个地址可以很多人一起用：页面是同一份静态文件，每个人录的课表只写进自己设备的浏览器存储，互相看不到，服务器上也不存任何东西。所以把它发给同学不需要做账号、不需要数据库。

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

**第一次打开要用手机移动数据，别连校园 WiFi**：`github.io` 在这个学校的网络里被按域名关键字掐断（本机实测连接超时），移动数据下安卓和鸿蒙能打开；iPhone 走 `github.io` 打不开，要救 iPhone 就得给 Pages 绑一个自有域名。装好之后离线使用不再依赖网络。

手机上手忙脚乱时打开 `https://<账号>.github.io/xfmy-local/diag.html`，它会自己测：能不能注册离线壳、缓存了多少文件、IndexedDB 能不能真写进去、那几个标签在不在页面里。

## 改了代码后重新打包

`sync.mjs` 与 `kernel/` 的相对层级必须保住（`kernel/js/model.js` 里是 `import '../../sync.mjs'`），所以要先摆一个暂存目录再打包：

```bash
rm -rf _stage/app && mkdir -p _stage/app
cp -r kernel _stage/app/kernel
cp sync.mjs  _stage/app/sync.mjs
MSYS_NO_PATHCONV=1 py -3 build_phone.py _stage/app \
  --base /xfmy-local/ --entry kernel/index.html --exclude test \
  --icon-src pc/dayplan.ico --out _build/xfmy-local \
  --name "Day Plan" --short-name "Day Plan"
```

四个坑：

- `--base` 必须和实际访问路径**逐字一致**，错了就是手机装完白屏、第二次打开也不报错。Git Bash 会把 `/xxx/` 改写成本机路径，所以命令前要加 `MSYS_NO_PATHCONV=1`；脚本遇到带盘符、反斜杠、空格的 base 会直接拒绝产出。
- 输出目录里如果已经有 `.git`，重打包会保住它（脚本先把 `.git` 挪到临时目录再放回）。手动删掉 `.git` 重新 init 会让提交与远端历史无关，push 会被拒。
- 暂存目录 `_stage/app` 每次都要重拷（上面那条 `rm -rf` 不是多余的）：留着上次的拷贝，改好的 `kernel/` 根本进不了包，产出的还是旧代码，而打包脚本看不出任何问题。
- `--short-name` 就是手机桌面上那个图标的名字，页面标题和 manifest 名字由它和 `--name` 决定。改了名已经装过的设备不会跟着变，要重新「添加到主屏幕」才更新。
- **重打包之前先把预览服务器关掉**（`py -3 -m http.server` 那一类，绑 `0.0.0.0` 的也一样）。输出目录被别的进程开着时清空它会失败，脚本现在会报错并把 `.git` 放回原位、产物不动，但你要的是能产出，所以先关：`tasklist | findstr python` 看有没有还活着的 `python3.13.exe`，确认是哪个会话起的再停掉。

## 注意

数据只有设备本地这一份副本，浏览器或系统清理功能可能把它清掉。请定期在「同步」页点「导出全量备份」并把那个 JSON 存到别处——这里没有云端兜底。
