# ps5watch 交接文档（HANDOFF）

> **2026-10-13 更新：已重构为 Web 控制台（v2）。** 使用方式、目录结构见 README.md。
> - 状态从 `state/state.json` 迁移到 `state/ps5watch.db`（SQLite，首次启动自动导入；原文件保留，另有 `state.json.bak`）
> - 旧脚本移到 `legacy/`；第 2、4 节的命令和文件列表以 README 为准，第 6 节的踩坑记录依然有效
> - 定时运行由控制台内置调度接管；`scripts/install-autostart.ps1` 会注册开机自启并移除旧计划任务 `PS5Watch`
> - 2026-10-13 17:25 实测：站点已解封（首个请求必为反爬挑战页，第二次即通过）

> 2026-10-12 由 ZCode 会话整理。本包是完整可运行副本，含全部代码、状态、凭据。
> ⚠️ **bduss.txt 与 bd_open.json 是百度账号登录凭据，勿外传。**

---

## 1. 这个工具是干什么的

监控 2468c.com（"奥德彪计划"）PS5 分类的新游戏，自动：

1. **crawl** — 增量抓新游戏详情页，提取百度盘链接 + 提取码
2. **transfer** — 转存分享资源到百度盘 `/游戏资源/PS5`
3. **normalize** — 把目录规整成标准 `PPSAxxxxx` / `CUSAxxxxx` serial 命名

设计为无人值守：Windows 计划任务 `PS5Watch` 每天 10:00 自动跑 `run`（三步连做）。

## 2. 目录结构与文件说明

```
ps5watch/
├── ps5watch.mjs        主 CLI（check/crawl/transfer/normalize/run/report/seed/retry-failed）
├── lib_site.mjs        站点抓取：反爬双跳、全局串行限速 5.5s/请求、重试
├── lib_baidu.mjs       百度盘操作：转存=BaiduPCS-Go，列表=xpan开放API，改/移/删=BaiduPCS-Go mv/rm
├── lib_norm.mjs        目录规整引擎（serial 推导、改名、合并、判重、删前验空）
├── du.mjs              网盘用量分布扫描（渐进式、断点续扫；node du.mjs [目录名] 深挖指定目录）
├── login.mjs           扫码登录器：弹 Chrome 窗口 → 抓 HttpOnly cookie → 写 bduss.txt → 灌 BaiduPCS-Go
├── probe.sh            站点解封探针（每小时1次，解封自动跑 run）
├── config.json         站点/目标目录/节奏配置
├── bin/BaiduPCS-Go.exe v4.0.2 转存引擎（5MB 单文件）
├── bduss.txt           ★凭据：BDUSS/STOKEN（转存登录态）
├── bd_open.json        ★凭据：开放平台 access_token/refresh_token（目录列表用，自动续期）
└── state/
    ├── state.json      增量状态（1023 帖子、98 链接的处理状态）
    ├── du-report.json  用量分布报告（断点，重跑 du.mjs 自动续）
    ├── import/         2026-10-12 会话的原始产物（种子数据）
    └── logs/           每次规整/run 的日志
```

## 3. 换机器部署（5 分钟）

1. 安装 Node.js ≥18（用了内置 fetch/WebSocket）+ Git Bash（probe.sh 用）+ curl
2. 解压本包到任意目录，如 `C:\tools\ps5watch`
3. 验证：`node ps5watch.mjs check` → 应显示「百度盘登录: 有效 ✓」
   - 若失效：`node login.mjs` 扫码（手机百度网盘 App）
4. 注册计划任务（改路径后执行）：
   ```
   schtasks /Create /F /TN "PS5Watch" /SC DAILY /ST 10:00 /TR "cmd /c cd /d C:\tools\ps5watch && node ps5watch.mjs run >> state\daily.log 2>&1"
   ```

## 4. 日常命令

```
node ps5watch.mjs check      # 体检：站点可达性 + 登录态 + 统计
node ps5watch.mjs run        # 一键：crawl → transfer → normalize
node ps5watch.mjs crawl      # 只抓新游戏
node ps5watch.mjs transfer   # 只转存 pending
node ps5watch.mjs normalize  # 只规整目录
node ps5watch.mjs retry-failed && node ps5watch.mjs transfer   # 重试失败项
node ps5watch.mjs report     # 状态统计
node du.mjs                  # 网盘用量分布（断点续扫）
node du.mjs 游戏资源          # 深挖单个目录
schtasks /Run /TN "PS5Watch" # 手动触发计划任务
```

## 5. 当前进度（2026-10-12 16:40）

- 2468c.com PS5 分类共 **1023 个游戏**，已收录全部 URL
- **98 条百度盘链接已全部转存**（93 新转存 + 5 已存在），`state/state.json` 有逐条状态
- **974 个游戏待补抓**：站点因本会话早期并发抓取触发了 IP 封禁（教训：必须串行）。
  解封后 `crawl` 会自动补齐（含历史缺口自愈逻辑），预计 1.5h（5s/页）
- 目录已规整：`/游戏资源/PS5` 下 90 个标准 serial 目录
  - 3 个例外保持原名：`卡卡罗特-FPKG`、`三位一体5：发条阴谋支持4.xx-pkg`（FPKG 自制包无 serial）、`ps5-games.md`
- **网盘用量**（9/15 顶层已扫，见 state/du-report.json）：
  高中资料 778.7GB / longmao 417.3GB / 软件资源 191.6GB / 火影忍者解包 89.7GB /
  个人资料 35.5GB（与网页版"详细信息"完全一致，验证过）/ TMP 18.8GB / 软考 8.1GB
  **总量 18TB 已用 87.7%，剩约 2.2TB —— 全部 973 个存量游戏可能装不下**，
  空间不足会逐条记录为 err_*，清理空间后 retry-failed 即可续转

## 6. 架构决策与踩坑记录（重要，勿重蹈覆辙）

> **2026-10-14 更新：已移除 BaiduPCS-Go。** 写操作改由 `server/baidu.mjs` 直接调用百度接口：
> 建目录/移动/删除走 `pcs.baidu.com/rest/2.0/pcs/file?app_id=266719`（带 BDUSS），
> 转存走 `/share/verify → /s/<surl>（网盘客户端 UA 取 bdstoken/shareid/share_uk）→ /share/list → /share/transfer`。
> 下面「为什么用 BaiduPCS-Go」的结论已过时：当年的 -6 是缺 STOKEN、缺 bdstoken 或用了浏览器 UA 访问分享页导致的，不是 TLS 指纹问题。

### 为什么转存用 BaiduPCS-Go 而不是 curl/浏览器
- **curl / Node fetch 直调 `pan.baidu.com/api/*` 一律返回 errno -6**（TLS/HTTP2 指纹墙，
  新旧 BDUSS 都一样，完整浏览器头也没用）。BaiduPCS-Go（Go TLS）能过
- **BDUSS 是会话 cookie，浏览器关闭即失效**，无法从浏览器 profile 持久化捞取；
  Chrome headless 在本机还有静默失败问题
- BaiduPCS-Go 登录方式：`login.mjs` 扫码拿 cookie 后自动执行
  `BaiduPCS-Go.exe login -bduss=... -stoken=...`；who 命令可验

### 为什么列表用开放平台 API
- BaiduPCS-Go 的 `ls` 在 v4.0.2 报 -6（其 xpan 旧端点问题），不要用
- 开放平台 `GET /rest/2.0/xpan/file?method=list&access_token=...` 稳定可用；
  token 30 天过期，lib_baidu.mjs 用 refresh_token 自动续（约 10 年有效）
- ⚠️ 该开放平台应用是**应用目录写权限**（只能写 /apps/<app>/，全网盘只读），
  所以**所有写操作（改名/移动/删除/转存）都走 BaiduPCS-Go**，列表走开放平台
- 开放平台的「文件分享服务」（xpan share transfer）是需单独开通的付费接口，
  个人应用拿不到；分享转存的 sekey 只能从网页端 `/share/verify` 拿，而它被指纹墙挡 ——
  这就是甩不掉 BaiduPCS-Go 的根本原因（评估过：不值得为去掉它常驻无头浏览器）

### 网页转存 API 细节（lib_baidu.mjs 旧版验证过，备查）
- verify 的 surl 必须去掉前导 1（`/s/1XXXX` 的 1 是路径一部分），否则 errno 105
- `randsk`(sekey) 已是 URL 编码形态，拼 URL 时勿再 encodeURIComponent，否则 200025
- `/share/list` 已废弃（errno 2），fs_id 从分享页 HTML 正则提取
- move 的 filelist 每项是 `{path, dest, newname}`（dest=目标目录），不是路径数组
- 文件名冲突（errno 12）**不区分大小写**；网页版「详细信息」的目录大小是特权端点，
  API 拿不到（递归 du.mjs 扫出来是准的，已对账）

### 规整规则（lib_norm.mjs）
- 标准 = `^[A-Z]{4}\d{4,6}$`（PPSA/CUSA/CUAS/PUSA…12 种前缀）
- 非标准目录：目录名推 serial → 推不出按内部 rar 文件名 > 全部文件 > 子目录名推导
- 多源同 serial 合并；目标已有同名文件（忽略大小写）判重删除
- **删源目录前强制 ls 验空**（有一次 move 未生效就删导致的误删，已从回收站恢复过，
  从此加了验空）

### 站点抓取（lib_site.mjs）
- 2468c.com 反爬：首次访问返回 JS 设 cookie 小页面，curl 带 cookie jar 两次请求即过
- **并发 >1 会触发 IP 硬封**（连接重置 0 字节，实测封禁 3h+ 未解，真实浏览器也进不去）
- 全局串行 + 5.5s 间隔 + 挑战页自动刷新会话，已内置

## 7. 已知问题 / TODO

- [ ] 站点解封后跑一次 `node ps5watch.mjs run`（或等计划任务），补齐 974 个游戏
- [ ] 存量转存完后再跑一轮 `normalize`（新转存的目录可能是版本名格式）
- [ ] 网盘空间 2.2TB 余量，装不下全部存量；如需全量先清理（du.mjs 定位大目录）
- [ ] `du.mjs` 断点已存 9/15 顶层目录，重跑自动续扫剩余 6 个
- [ ] BaiduPCS-Go 如遇转存接口失效，升级版本：github.com/qjfoidnh/BaiduPCS-Go/releases
