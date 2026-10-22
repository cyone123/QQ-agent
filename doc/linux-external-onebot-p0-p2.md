# Linux 外部 OneBot：P0–P2 实施与验证记录

日期：2026-10-22。工作分支：`codex/linux-external-onebot-plan`。

本轮实现配置、外部模式隔离、监听、连接更新、诊断和 headless 停机。尚未实施媒体路径解析、Base64 发送策略、前端外部模式界面、Docker 镜像或服务器部署，分别保留至 P3–P6。媒体配置目前只完成默认值与校验，不能据此认为共享媒体已经可用。

## P0：基线

- 基准提交：`fdfd325e148d91845a0aeea3dfdff4cf92fc61a1`。
- 开始时没有已修改的受跟踪文件，只有上一轮新增的实现计划文档。
- 环境：Windows、Node.js `v24.16.0`；项目支持范围仍为 Node.js >=20。
- 初始没有依赖，测试因缺少 `ws` 失败。使用 `npm ci --ignore-scripts` 安装锁定依赖；未下载 Electron 二进制，未运行 setup、QQ 或 SnowLuma。
- 改造前的 `npm test` 在 `setup-qq-version.mjs` 失败：本机未安装 SnowLuma，检查仍要求输出 CLIENT_BUILD。此前 selftest、Skill、白名单、表情、界面、用量等测试通过。
- 对覆盖测试发现的失败另取原始 HEAD 源码快照复现，确认见下方三项基线问题；未为这些问题扩大本轮修改范围。

配置原语义：磁盘配置覆盖默认配置；原先 PORT 环境值位于默认配置中，会被磁盘值覆盖。原先配置保存不更新 OneBot 连接；状态与辅助轮询固定探测回环端口；入口只有 SIGINT 正常停机。日志刷新实际使用同步追加，可在返回前完成当前缓冲落盘；原 HTTP close 未等待完成。

## P1：配置与本地能力隔离

新增 `src/deployment-config.js`，集中管理部署字段校验、外部模式判断、能力标识、监听参数解析和连接文本脱敏。

| 字段 | 默认值 / 行为 |
|---|---|
| `snowluma.mode` | `local`，可设 `external`；旧配置缺失时保持本地行为 |
| `server.host` | `127.0.0.1` |
| `server.port` | `3210 + PROFILE 偏移` |
| `media.sendLocalMode` | `auto`，接受 `auto` / `base64`，实际传输策略待 P3 |
| `media.pathMappings` | `[]`；校验绝对路径、非文件系统根目录、不得包含 `..`，实际解析待 P3 |

WS 地址接受 `ws/wss`，HTTP 地址接受 `http/https`，支持服务路径前缀及查询参数，拒绝错误协议、URL 用户信息和片段。模式、地址、监听参数或媒体配置非法时，保存 API 返回 400，内存配置不被非法 patch 改写。可解析但语义非法的磁盘配置会明确阻止启动，不被改名或替换成默认配置；非法 JSON 仍沿用既有备份逻辑。

`QQ_AGENT_DATA_DIR` 要求绝对目录。HOST/PORT 的实际监听优先级为环境变量 > 磁盘配置 > 默认值，显式空值或非法值报错。环境覆盖不进入配置对象和配置文件；`GET /api/status` 单独返回实际监听、下次启动配置和是否需重启。HOST/PORT 保存后不动态重新绑定。

外部模式下，即使残留 `autoLaunch=true` 和有效的本地 SnowLuma 目录：

- 不探测本地 SnowLuma 目录，不读其 Token，不进行空 Token 候选轮换。
- 不启动/停止本地 QQ、SnowLuma，不进行 Windows QQ 进程查询；外部状态不再探测本机 5099/3001。
- 本地管理函数本身拒绝操作；启动、停止、打开目录、打开 WebUI 等 HTTP API 返回 `409 / UNSUPPORTED_MODE`。本地模式下非 Windows 平台的桌面打开操作也返回 409。
- 本地进程操作在异步探测后的执行点再次检查模式，避免等待过程中切换到外部模式后继续操作。
- 退出只关闭 Agent 自身连接和任务，外部 SnowLuma 继续由服务器独立管理。

外部模式的 Token 仅来自显式配置；`httpAccessToken` 为空时继续沿用 `accessToken`。本地模式的扫描与候选机制保留。

## P2：服务与连接

### 监听与可访问性

服务使用实际 HOST/PORT 监听。外部模式端口占用直接失败，本地模式保留最多尝试连续 10 个端口的桌面兼容行为。

新增 `GET /healthz`：正常返回 `200 {"ok":true}`，停机期间返回 503，不要求管理 Token，不包含配置、连接地址或凭据，也不依赖 QQ/模型在线。API 原有 Token、Host、Origin/Referer 校验保持启用；监听 `0.0.0.0` 不会放开 API 来源限制，部署仍按计划使用回环端口映射和 SSH。

外部协议端不可达不阻塞 HTTP 服务启动，静态控制台、配置和状态 API 可响应。前端现有启动引导和按钮尚未改造，完整外部模式交互仍属于 P4，不能将“HTTP 页面可访问”视作前端验收完成。

### 连接更新与恢复

配置层新增变更订阅。应用订阅 OneBot 模式、目录、URL 和 Token 变化，通过统一入口清理旧连接、候选、辅助轮询和诊断缓存，再应用新配置。路由保存与 `app.updateConfig()` 均走此路径；普通设置变更不重连。订阅在停机时移除。

保留正向 WS 收事件、HTTP POST 发消息/查询。外部模式只使用 OneBotClient 的退避循环，不运行本地端口辅助重连；本地轮询在模式切换时清除，其已在途的探测结果也不得作用于新轮询。

WS 建连超时 10 秒，失败退避从 3 秒增加至最多 30 秒。配置变化主动重连会清零退避，旧 socket 及旧代际回调不能覆盖新账号信息。WS 已连接但账号信息未就绪时，每 15 秒补查；断线清除旧账号信息，不能把“曾经拿到账号”继续当成当前就绪。

HTTP 请求在关闭或配置更新时可中断，关闭后拒绝新的 API 调用，避免待发送任务在停机后继续出站。请求超时覆盖响应体读取；错误和连接日志移除显式 Token 以及地址中的敏感查询值。本轮同时修复了日志转发回调误引用后来被替换函数、导致 headless 启动日志不输出的问题。

### 状态和连接测试 API

`GET /api/status` 新增/扩展：

| 字段 | 含义 |
|---|---|
| `capabilities` | `localProcessControl`、`desktopActions`、`tokenDiscovery`，供 P4 使用 |
| `server` | `listening`、`configured`、`restartRequired` |
| `snowluma.mode` | 当前模式 |
| `snowluma.running` | 外部模式为 `null`，表示不探测外部进程，不代表已停止 |
| `onebot.connected` | WS 连接状态 |
| `onebot.http` | 最近 HTTP 调用结果：`available`、`checkedAt`、`error`；未检查为 `null` |
| `onebot.self` | 当前账号；尚未拿到有效账号时为 `null` |
| `onebot.diagnosis` | 区分鉴权失败、DNS、拒绝连接、超时、账号未就绪等提示 |
| `onebot.connectionTest` | 最近手动连接测试结果，尚未测试为 `null` |

外部状态查询只读已有状态，不额外联网探测，不把 WS、HTTP、账号状态混为一项。

新增 `POST /api/onebot/test-connection`，空 JSON 请求体即可。并行检查 `get_version_info`、`get_login_info`，分别使用 5 秒超时；返回 `wsConnected`、`version`、`login`、`checkedAt` 和综合 `ok`。综合成功要求 WS 已连接、两个 API 成功且账号有效。并发请求复用同一个检查，结果缓存 10 秒；连接配置变更清空缓存。API 使用现有控制台鉴权与来源校验，前端按钮待 P4 接入。

### 生命周期

SIGINT/SIGTERM 共用幂等退出入口，启动失败也执行清理，以非零状态退出。重复调用 `app.stop()` 共享同一个 Promise。

停机阻止新入站处理及 OneBot 发送，等待启动阶段结束，移除配置订阅，清理插件 watcher、遥测、社区、端口辅助轮询和价格刷新定时器；中断在途模型请求并等待会话完成 aborted 落盘，再刷新索引、结束 SSE、等待 HTTP close、刷新日志和释放实例锁。实例锁的进程级退出钩子注册改为幂等。

会话收尾限时 15 秒；headless 总退出上限 25 秒，失败或超时非零退出。不能被正常取消的插件操作或挂起的 HTTP 请求仍受总期限限制，不保证任意第三方插件都能优雅取消。PID 文件锁依然不是跨容器互斥机制，仍要求单实例部署。

## 自动验证

新增测试已接入 `npm run test:deployment`，并由 `npm test` 首先运行：

| 测试 | 主要证据 |
|---|---|
| `deployment-config-test.mjs` | 旧配置默认、非法值、HOST/PORT 优先级、环境不回写、非法更新不变更内存、语义错误不改名配置 |
| `external-onebot-test.mjs` | 外部离线启动、本地目录零读取、autoLaunch 忽略、管理 API 与直接函数拒绝、Origin 防护、独立 HTTP 鉴权、路径前缀/查询保留、状态不探测、检查并发/缓存、断线恢复、错误令牌不轮换、模式切换后单连接、SSE 结束、索引与日志落盘 |
| `headless-lifecycle-test.mjs` | 真实 headless 子进程入口，SIGINT/SIGTERM handler、正常退出、重启拿锁、外部端口占用失败退出 |
| `headless-active-stop-test.mjs` | 中断等待中的模型请求、会话 aborted 落盘、停机后禁止继续发送 |

上述测试均在隔离临时数据目录和模拟 OneBot/模型服务上执行，不向真实 QQ 发消息。Windows 的 `child.kill(SIGTERM)` 是强制终止，因此 Windows 测试通过测试专用 IPC fixture 分发进程信号事件，覆盖真实 handler；Linux 下同一测试直接发送 POSIX 信号。Windows 通过不能替代 Linux 原生信号验收。

现有 `npm test` 原含 26 个测试文件，逐项执行以避免首个失败遮蔽后续结果：25 个通过，1 个基线失败。selftest 41 项、HTTP 接口覆盖 116 项、端到端链路覆盖 44 项、界面接线 5 项均通过。

以下失败在原始 HEAD 快照中同样复现：

1. `setup-qq-version.mjs`：84 项通过、1 项失败；未安装 SnowLuma 时缺少 CLIENT_BUILD 输出。
2. `coverage-offline.mjs`：147 项通过、1 项失败；测试用公网域名在当前环境解析到内网地址，被已有 SSRF 防护拒绝。
3. `coverage-ui.mjs`：20 项通过、1 项失败；`landing.html` 缺少测试要求的带版本号安装包下载链接。

因此 `npm test` / `npm run test:coverage` 仍会因上述基线问题非零退出，不能标为全绿；新增部署测试单独可运行。验证本轮修改时另执行受影响的 selftest、HTTP 覆盖和部署套件，未修改上述无关测试来掩盖失败。

## 下一阶段与环境限制

- 当前只具备 Windows 本地验证环境。检测到 Docker CLI，但 Docker Desktop Linux Engine 未运行；未构建镜像，未运行 Linux 容器，Linux 原生信号待验证。
- 未连接用户 Linux 服务器，也未对真实 SnowLuma 的监听、鉴权、卷权限、图片/视频样例或重启恢复作验收。
- P3 才接入媒体读取路径映射与 Base64 出站；P4 才实现外部模式设置、连接测试按钮和离线引导；P5 才提供可运行 Docker/Compose 与初始化流程；P6 完成真实部署联调。
- 本轮代码可以进行 headless 外部连接模拟验证，但尚不是完整的 Docker 部署交付。
