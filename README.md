# 盘架 PanShelf — 游戏目录全量同步 + 百度网盘按需入盘（Web 控制台）

把网站分类（默认 2468c.com 的 PS5 分类）里的全部游戏同步成一个可搜索的游戏库，记下每个游戏的编号和百度盘链接；
网盘空间有限，所以默认不转存——想玩哪个搜出来点「加入网盘」，不要了点「从网盘删除」腾空间。
入盘的游戏只保留一个版本（优先 exFAT），目录规整成 `PPSAxxxxx` / `CUSAxxxxx` 标准编号目录。所有参数、进度、日志都在网页里看和改。

> 命令行入口和数据库文件沿用旧名 `ps5watch.mjs` / `state/ps5watch.db`。

## 启动

```
npm run setup        # 首次：安装依赖并构建网页（需要 Node.js ≥ 22.13）
npm start            # 启动控制台 → http://127.0.0.1:5175
```

建议设为开机自启（同时会移除旧版的 `PS5Watch` 每日计划任务，定时已由控制台接管）：

```
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Uninstall   # 取消自启
```

自启后服务在后台无窗口运行，日志写入 `state\server.log`。

## 页面

| 页面 | 用途 |
|---|---|
| 总览 | 采集 → 转存 → 规整三站流水线、进行中的任务、账号/空间/站点状态、最近消息 |
| 游戏库 | 按游戏名 / 编号搜索；加入网盘、从网盘删除（先预览再确认）、重新采集、跳过 |
| 任务 | 所有任务的实时进度、速度、预计剩余时间和日志；暂停 / 继续 / 取消 / 重新运行 |
| 网盘 | 空间与用量（逐层深挖）；目录规整（先预览、勾选，再执行） |
| 设置 | 采集节奏、转存入盘、规整规则、定时运行、通知、来源管理、扫码登录 |

## 关键行为

- **站点请求永远串行**：同一域名全局只有一个在途请求，间隔和随机抖动可在设置里调（默认 5.5 秒 + 0~1.5 秒）。
  连续失败达到阈值判定为封禁，采集自动停止，之后按间隔探测，恢复后自动重新采集。
- **全量同步、按需入盘**：采集会同步站点上全部游戏（定时任务每天翻最新几页发现新帖，并补抓所有缺口），
  默认**不转存**，链接标为「可入盘」；在游戏库搜索游戏名或游戏编号，点「加入网盘」才转存。
  想恢复「采到就存」，在「设置 → 转存入盘」打开自动转存。
- **从网盘删除游戏**：游戏库勾选游戏 →「从网盘删除」，先按游戏编号列出网盘里对应的文件夹和大小，确认后删除；
  删掉的内容进百度网盘回收站，游戏回到「未入盘」，随时可以再加入。含多个游戏编号的文件夹不会被删。
- **转存过程**：转存会边等边存直到采集结束。
  网盘剩余空间低于保底线（默认 200 GB）时转存自动暂停并通知，清理后在任务页点「继续」。
- **每个游戏只收录一个版本**：采集时读取每个链接上方的「备注」判断格式和版本号，
  按 exFAT > 文件夹 > 未标注 挑一个，同格式取最高版本；PKG / FPKG 和单独的补丁 / DLC 链接标为「已跳过」。
  游戏库的链接表里能看到每条链接的格式、备注和跳过原因，需要时可对单条链接手动转存。
- **转存后清理**：每次转存有新内容后，自动删除目标目录里名称含独立 pkg / fpkg 的文件和目录，兜住备注没写清楚的情况
  （规则在「设置 → 转存入盘」修改，存量可在任务页新建「清理排除项」）。
- **规整先预览**：转存完成后自动生成规整预览（只读），确认勾选后才执行；删除源目录前仍会验证已清空。
- **任务可中断续跑**：所有进度落在 SQLite（`state/ps5watch.db`），服务重启后未完成的任务标记为「已中断」，重新运行即从断点继续。
- **多来源**：在「设置 → 来源」添加其他分类或站点，每个来源有独立的游戏库和转存目录。

## 命令行

控制台在运行时，命令会转交给控制台执行（保证不会和控制台同时请求站点）；否则在当前进程里执行。

```
node ps5watch.mjs check                 # 账号 / 空间 / 统计
node ps5watch.mjs run                   # 一轮：采集 → 转存 → 规整预览
node ps5watch.mjs crawl [--pages N] [--no-backlog]
node ps5watch.mjs transfer
node ps5watch.mjs normalize [--apply]   # 生成规整预览；--apply 直接执行全部
node ps5watch.mjs du [目录] [--force]    # 网盘用量扫描
node ps5watch.mjs prune [--dry]          # 删除命中排除规则的文件（--dry 只列清单）
node ps5watch.mjs dedupe [--apply]       # 同一游戏转存了多个版本时只留选中的那个（默认只预览）
node ps5watch.mjs retry-failed
node ps5watch.mjs login                 # 扫码登录百度网盘
node ps5watch.mjs serve                 # 等同 npm start
```

## 目录结构

```
server/            后端（Fastify + node:sqlite）
  index.mjs        入口：HTTP、静态网页、调度器
  api.mjs          REST 接口 + SSE 实时推送（/api/stream）
  jobs.mjs         任务引擎：通道（site/pan/scan）、暂停/取消、进度、日志
  scheduler.mjs    每日定时流水线 + 封禁探测
  site.mjs         站点抓取（curl + cookie jar，按域名串行限速）
  sources.mjs      来源管理与站点适配器（wp2468c / generic）
  baidu.mjs        百度盘：纯 Node.js 实现（PCS/分享转存写 + xpan 开放平台读）
  login.mjs        扫码登录（弹浏览器 + CDP 取 BDUSS/STOKEN）
  notify.mjs       站内消息 / Windows 通知 / Webhook
  settings.mjs     参数默认值与校验
  tasks/           crawl（含 probe）、transfer、normalize（plan/exec）、du
web/               前端（Vite + React + TypeScript + Tailwind），构建产物在 web/dist
ps5watch.mjs       命令行
scripts/           开机自启脚本
state/             数据库、cookie、浏览器配置、日志
bduss.txt, bd_open.json   ★ 百度账号凭据，勿外传
```

## 开发

```
npm run dev:server   # 后端（文件变更自动重启）
npm run dev:web      # 前端开发服务器 http://127.0.0.1:5176（/api 代理到 5175）
npm run build        # 构建前端
```
