# 本地课表

自己的课表、日历、待办与天气。纯前端，没有后端、没有账号。

**这个仓库里只有代码，没有任何个人数据。** 你的课表、待办、日程、时光胶囊都只存在你设备上：

- 电脑（pywebview 壳）：`本地版数据.json`
- 手机 / 浏览器：IndexedDB

换设备靠「同步」页导出改动包再导入合并，不走任何服务器。

## 用法

把本仓库内容放到任意静态托管的 `/xfmy-local/` 路径下，用 GitHub Pages 就是 Settings → Pages 选 main 分支根目录，然后访问
`https://<账号>.github.io/xfmy-local/kernel/index.html`，手机浏览器打开后「添加到主屏幕」。

装一次之后可以完全离线使用：Service Worker 预缓存全部 18 个文件，外部天气接口取不到时会回放上次缓存的那份并标注是缓存。

## 重新打包

改了代码后在电脑上重新生成离线壳与缓存清单（`sync.mjs` 与 `kernel/` 的相对层级要保住）：

```bash
mkdir -p stage/app
cp -r kernel stage/app/kernel
cp sync.mjs  stage/app/sync.mjs
MSYS_NO_PATHCONV=1 py -3 build_phone.py stage/app \
  --base /xfmy-local/ --entry kernel/index.html --exclude test \
  --out dist/xfmy-local
```

`--base` 必须和实际访问路径逐字一致，否则 Service Worker 注册失败、手机装完是白屏。

## 注意

浏览器可能因系统清理而丢掉 IndexedDB 里的数据。请定期在「同步」页点「导出全量备份」并把那个 JSON 存到别处——这里没有云端兜底。
