# Linux 服务与外部 SnowLuma 接入实现计划

- 日期：2026-10-22
- 分支：`codex/linux-external-onebot-plan`
- 状态：P0–P4 已实现并通过 Windows 下的模拟验证；P5 部署文件已交付，Linux 镜像构建/非 root 运行验收受本机 Docker Engine 不可达阻塞；P6 尚未执行。Linux 原生信号和真实 SnowLuma 验收仍待进行。
- 阶段记录：[P0–P2 实施与验证记录](./linux-external-onebot-p0-p2.md)、[P3–P5 实施与验证记录](./linux-external-onebot-p3-p5.md)。可执行部署步骤以 [Linux 部署文档](./linux-deployment.md) 为准；下文为原始设计依据。
- 目标：在 Linux 上独立部署 QQ Agent 核心，连接现有 Docker SnowLuma，保留网页控制台、记忆、存档和媒体能力。

## 1. 已确认的部署基础

用户现有容器由以下参数创建：

```bash
docker run -d \
  --name snowluma \
  --restart unless-stopped \
  --shm-size=1g \
  --ulimit nofile=65536:1048576 \
  --cap-add=SYS_PTRACE \
  --security-opt seccomp=unconfined \
  -e SNOWLUMA_WEBUI_HOST=0.0.0.0 \
  -e SNOWLUMA_WEBUI_PORT=5099 \
  -e SNOWLUMA_QQ_FLAGS="--disable-gpu --disable-software-rasterizer --disable-gpu-compositing" \
  -p 6081:6081 \
  -p 5099:5099 \
  -p 3000:3000 \
  -p 3001:3001 \
  -v qq-gateway-data:/app/data \
  -v qq-client-config:/app/.config \
  -v qq-client-data:/app/.local/share \
  motricseven7/snowluma:latest
```

已知卷及用途：

| 卷名 | SnowLuma 容器路径 | 用途 |
|---|---|---|
| `qq-gateway-data` | `/app/data` | SnowLuma 配置、缓存及数据库 |
| `qq-client-config` | `/app/.config` | QQ 客户端配置 |
| `qq-client-data` | `/app/.local/share` | QQ 用户数据、登录态及缓存 |

端口映射不能证明相应 OneBot 服务已经启用；实际监听地址、Token、账号在线情况需要部署时核对。`latest` 不能说明当前运行版本，联调记录应保存实际镜像 ID/摘要。

## 2. 范围与交付结果

本次实施范围：

1. 独立 Node.js 服务支持 Linux 和容器生命周期。
2. 明确区分本地托管协议端与外部协议端，保留已有 Windows 桌面行为。
3. 通过正向 WS 收事件，通过 HTTP 调用 OneBot API。
4. 只读挂载现有缓存卷，统一解析媒体本地路径。
5. 外部模式下本地图片、表情优先转 Base64 发送。
6. 提供 Docker 镜像、Compose、示例配置、部署及回滚说明。
7. 通过 SSH 隧道访问网页控制台。

暂不包含：反向 WS、通过 WS 调用 API、公开域名访问及登录系统、替换 SnowLuma、迁移 QQ 登录态、数据库重构、多副本部署、大视频共享出站目录。协议端返回卷外文件时先使用已有 URL 下载路径；共享目录扩展另行处理。

完成标准：一个 Agent 容器可持续处理指定白名单内的消息；SnowLuma 重启后恢复连接；Agent 正常停止并持久化状态；重建 Agent 容器不丢配置、记忆和存档。

## 3. 代码现状与改造依据

| 文件 | 现状 | 计划 |
|---|---|---|
| `src/server.js` | 已有 headless 入口；只对 SIGINT 调用 app.stop | SIGINT/SIGTERM 统一、幂等退出 |
| `src/config.js` | 已有 snowluma URL/Token、数据目录和端口配置 | 新增模式、监听地址、媒体配置及校验 |
| `src/app.js` | 混合进程管理、Token 恢复、服务监听和 OneBot 接入 | 按模式隔离本地功能，修正探测、配置更新和退出 |
| `src/onebot.js` | WS 收事件，HTTP POST 调用 API；已有重连退避 | 保持传输方式，完善外部连接诊断和日志脱敏 |
| `src/routes.js` | 状态检测固定访问回环地址，包含 Windows 启动/打开操作 | 外部状态诊断、能力标识、禁用本地操作 |
| `src/sender.js` | 本地路径优先，部分场景 Base64 回退 | 外部模式明确选择图片传输策略 |
| `src/sticker-manager.js` | 直接读取 get_image 返回路径 | 接入统一路径解析 |
| `src/video-reader.js` | 直接读取消息 path 或 API 返回路径 | 接入统一路径解析并保留 URL 降级 |
| `src/plugin-loader.js` | 插件和技能目录位于应用根目录 | 镜像不打包用户扩展；文档说明可选挂载 |
| `ui/app/00-core.js` | 初始引导和体检含本地 SnowLuma 假设 | 外部模式允许离线进入控制台 |
| `ui/app/03-snowluma.js` | 本地 QQ、协议端管理页面 | 外部模式显示地址、连接状态及操作说明 |
| `ui/app/06-settings-render.js`、`07-settings-events.js` | 设置渲染与事件处理 | 增加外部模式和相关设置 |
| `ui/app/02-sse-sessions.js` | EventSource 直接访问 /api/events | 保持 SSH 同源访问并验证实时更新 |

特别注意：当前前端 API 发送的是固定 `x-console-token` 标记，SSE 未携带用户管理令牌。第一版不以配置 `server.token` 作为完整浏览器认证方案，继续依赖宿主机回环绑定和 SSH 隧道。

## 4. 目标配置契约

示例为配置片段，实际配置仍由现有默认值补齐：

```json
{
  "snowluma": {
    "mode": "external",
    "autoLaunch": false,
    "wsUrl": "ws://snowluma:3001",
    "httpUrl": "http://snowluma:3000",
    "accessToken": "",
    "httpAccessToken": ""
  },
  "server": {
    "host": "0.0.0.0",
    "port": 3210
  },
  "media": {
    "sendLocalMode": "base64",
    "pathMappings": [
      { "remote": "/app/data", "local": "/mnt/snowluma/data" },
      { "remote": "/app/.local/share", "local": "/mnt/snowluma/qq-share" }
    ]
  },
  "extensions": {
    "hotReload": false
  }
}
```

配置规则：

- `snowluma.mode`：`local` / `external`；旧配置缺失时默认为 `local`，保持桌面兼容。
- `external` 强制跳过本地进程控制、目录探测和 Token 候选轮换；即使残留 `autoLaunch=true` 也不启动协议端。
- 外部模式只使用显式配置的 Token；HTTP Token 留空时沿用 WS Token，保持现有约定。401 提示核对配置，不尝试空 Token。
- `server.host` 默认仍为 `127.0.0.1`；容器通过 `QQ_AGENT_HOST=0.0.0.0` 覆盖。
- `media.sendLocalMode`：`auto` / `base64`；默认 `auto` 保留现有行为，服务器示例显式设为 `base64`。
- `media.pathMappings` 默认为空；映射根必须是绝对路径，禁止泛化到整个文件系统根目录。
- `QQ_AGENT_DATA_DIR` 使用绝对目录。实施时核对 `QQ_AGENT_PORT` 当前读取与合并顺序，保证显式环境变量覆盖磁盘配置；新增 HOST 使用同一优先级。
- 环境变量覆盖在运行时生效，不将该覆盖写回为用户配置；UI 显示实际监听值及“需重启生效”的行为。
- OneBot 地址、令牌或模式变更后，通过统一连接配置更新函数应用并重连，旧连接与旧轮询不得继续运行。
- 不将真实 Token 放入仓库、Compose 示例或连接日志。

## 5. 外部协议端模式实现

### 5.1 本地能力隔离

在应用层建立明确的模式判断或能力对象，供路由与 UI 共用。外部模式下：

- 不读取本地 snowluma/config，也不自动替换配置里的 Token。
- 不启动或停止 QQ、SnowLuma，不执行 explorer.exe、cmd.exe、WMIC 或 PowerShell。
- 本地启动、停止、打开目录等 API 即使被直接请求也返回明确的“不支持当前模式”，不能仅隐藏按钮。
- 不访问 Docker socket，协议端由现有 Docker 容器独立管理。
- Agent 退出仅结束自身连接和任务，不影响外部 SnowLuma。
- WebUI 地址不自动构造成浏览器不可解析的 `http://snowluma:5099`；页面给出 SSH 转发或现有服务器访问说明。

### 5.2 连接与诊断

- 保持现有正向 WS + HTTP API 传输，不新增第二套事件入口。
- 删除外部模式中固定探测回环端口的辅助重连，优先复用 OneBotClient 已有退避机制，避免两个重连机制互相打断。
- 将连接状态、HTTP 可用性、账号信息分开显示；不能以 WS 打开等同于 QQ 已在线。
- 提供手动“测试连接”，检查 get_version_info、get_login_info，必要时用 get_status；实际支持差异以返回值判断。
- 状态查询不能每次发起完整联网检查，探测结果短期缓存，避免前端轮询造成请求堆积。
- DNS/连接拒绝、HTTP 401、WS 鉴权失败、超时、账号尚未就绪分别提供可操作提示；不再提示“到本地启动 QQ”。
- 处理自定义 URL 路径、wss/https，不通过默认端口推断服务是否存在。
- 日志和诊断移除 access_token 等敏感查询参数；不输出完整凭据。

## 6. 媒体共享与路径映射

### 6.1 接收媒体

拟新增 `src/media-paths.js`，统一负责协议端路径到 Agent 可读路径的解析，不承担网络下载。

处理规则：

1. 区分本地路径、file URI、HTTP URL、Base64 和媒体文件 ID；文件 ID 不参与路径转换。
2. 外部模式仅接受映射根中的协议端绝对路径，不直接读取任意返回的本地绝对路径。
3. 按目录边界匹配，多个规则时优先最长前缀；`/app/data-other` 不能命中 `/app/data`。
4. 正规化路径并拒绝越界；file URI 只解码一次，拒绝非预期远程主机。
5. 解析符号链接后的真实文件也必须落在映射本地根内；拒绝逃逸链接和目录对象。
6. 返回不存在、无权限或不在允许范围内时，向上层给出可区分的失败原因，再走原有 URL 下载降级。
7. 映射只用于读取，不能用于删除、覆盖协议端文件；下载和转码产物写入 Agent 自有目录。

接入位置：sticker-manager 的 get_image 缓存读取、video-reader 的消息 path 与 get_video/get_file 等返回路径，以及审计发现的其他核心本地媒体读取点。明确插件仍可能自行读取路径，文档提供可复用解析能力，不能宣称未适配插件全部兼容。

共享范围初版挂载两个卷，暂不挂载 qq-client-config。若返回路径位于 `/tmp`、`/app/.cache`、其他 HOME 或卷外符号链接目标，当前配置不覆盖：优先 URL；必要时单独补目录。不能仅根据卷名声称所有媒体均可读取。

`qq-gateway-data` 含协议端配置，整个卷只读挂载仍允许 Agent 读取其中凭据。此方案用于用户自有单机部署；路径规则限制核心媒体读取范围，不能当作隔离任意插件代码的沙箱。

### 6.2 发送媒体

- `base64` 模式下，本地图片、收藏表情读取 Agent 自有文件后转换成 OneBot `base64://` 引用，不先发送 SnowLuma 不可访问的 file URI。
- 复用现有限流、去重、发送超时和存档逻辑；传输准备失败不能提前登记“发送成功”。
- 统一容量上限，收藏表情已有 15 MB 限制，应在实施时确认普通图片采用的上限并记录到配置/说明，超限明确报错，避免无界读取。
- 内存评估考虑 Base64 约 4/3 膨胀和 JSON 请求副本；不把大视频无条件装进内存。
- 公网 URL 继续走既有校验；不全局开启 allowPrivateImageHosts。内部媒体服务如后续需要，单独设计可信地址例外。
- 大视频出站暂保留可用 URL；需要本地文件传递的扩展明确提示未配置共享出站目录。

## 7. 容器、权限与生命周期

### 7.1 镜像

- 新增 Dockerfile，以 Node.js 24 的 Debian slim 系列为候选基础，实际构建时验证 package-lock 和生产依赖兼容性并固定可复现版本。
- 使用 `npm ci --omit=dev`，直接以 exec 形式运行 `node src/server.js`，不通过 npm 包裹主进程。
- 安装 ca-certificates、FFmpeg/ffprobe 和时区支持；不运行 setup，不安装或下载 QQ、SnowLuma、Electron。
- 仅复制运行所需源码、UI 和公开元数据；.dockerignore 排除 data、snowluma、runtime、node_modules、.git、私钥、.env、测试产物及日志。
- 使用非 root 用户；Agent 自有数据卷初始化时赋予该用户写权限。
- 不给 Agent SYS_PTRACE 或 seccomp=unconfined；这些权限仅属于既有 SnowLuma。
- 可选扩展位于应用根 skills/plugins：默认镜像不包含用户扩展；后续通过明确的只读挂载安装，保持热重载默认关闭。实施时核对目录初始化是否尝试写入只读挂载。

### 7.2 权限

挂载只读不等于可读。部署检查需记录 SnowLuma 实际运行 UID/GID 与样例缓存的所有权、目录执行权限。优先使用已有可读权限或 Agent 补充所需组；不能以 `chmod -R 777` 或递归改变 QQ 数据卷所有者解决问题。确实不具备读取权限时，先走 URL 降级，再按具体目录设计最小权限调整。

### 7.3 启停和健康检查

- SIGINT/SIGTERM 共享幂等退出入口，停止接收新任务、终止正在处理的任务、清理轮询和监听器、关闭 WS/SSE/HTTP，完成存档索引及日志刷新。
- 核对 server.close 和 logger.flush 的实际完成语义，必要时等待完成；退出存在上限，超时以非零状态结束。
- 外部模式端口被占应失败退出，不沿用桌面端自动换到下一个端口，避免 Docker 映射失效。
- 新增不含配置或凭据的轻量存活端点，例如 `/healthz`。健康检查只判断核心 HTTP 服务可响应，不因 QQ 下线或模型 API 暂时失败而标记进程故障。
- Docker 健康状态与业务就绪分别记录；`restart: unless-stopped` 只负责进程退出后的重启，不能假定 unhealthy 会自动重启。
- 联调检查实例锁在容器重启后是否遗留及是否误判；共享卷不得供两个 Agent 实例并发运行，PID 锁不能替代跨容器部署约束。

## 8. 目标 Compose

保留现有 snowluma 容器，目标 Compose 如下（实际交付见仓库根目录 `compose.yaml`）：

```yaml
services:
  qq-agent:
    build: .
    container_name: qq-agent
    restart: unless-stopped
    init: true
    environment:
      TZ: Asia/Shanghai
      QQ_AGENT_DATA_DIR: /var/lib/qq-agent
      QQ_AGENT_HOST: "0.0.0.0"
      QQ_AGENT_PORT: "3210"
    ports:
      - "127.0.0.1:3210:3210"
    volumes:
      - qq-agent-data:/var/lib/qq-agent
      - qq-gateway-data:/mnt/snowluma/data:ro
      - qq-client-data:/mnt/snowluma/qq-share:ro
    networks:
      - qq-agent-net
    stop_grace_period: 40s
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  qq-agent-data:
    name: qq-agent-data
  qq-gateway-data:
    external: true
    name: qq-gateway-data
  qq-client-data:
    external: true
    name: qq-client-data

networks:
  qq-agent-net:
    external: true
    name: qq-agent-net
```

首次部署时先检查网络是否存在、SnowLuma 是否已加入；仅在缺失时执行：

```bash
docker network create qq-agent-net
docker network connect qq-agent-net snowluma
```

此操作不重建 SnowLuma。以后用户重新创建 SnowLuma 时，其 docker run 需要包含 `--network qq-agent-net`，或重新连接网络。

第一版通过 SSH 访问：

```bash
ssh -N -L 3210:127.0.0.1:3210 用户名@服务器地址
```

浏览器打开 `http://127.0.0.1:3210`。保持现有 Host/Origin 防护，不为容器监听 0.0.0.0 全局放开来源检查。若需远程管理 SnowLuma，可另加 5099/6081 隧道，具体访问策略由服务器已有配置决定。当前公开端口调整不作为 Agent 接入的前提。

首次初始化：先构建镜像，创建并初始化 Agent 数据卷，再以不输出密钥的文件复制或受控输入方式写入完整配置；配置文件属主与运行用户一致，权限限制为该用户可读写。示例配置不得覆盖已有真实配置。随后启动 Agent，通过 SSH 控制台设置模型和白名单。部署文档需给出可重复执行的实际命令。

## 9. 实施阶段与依赖

| 阶段 | 工作 | 阶段验收 |
|---|---|---|
| P0 基线 | 保存工作区状态、运行适用现有测试、记录当前配置语义 | 已知失败与改造导致失败可区分 |
| P1 配置/模式 | 新增配置校验、外部模式、本地 API 能力限制 | 外部模式不执行任何本地进程控制或 Token 扫描 |
| P2 服务/连接 | HOST 支持、固定服务端口、配置变更重连、诊断、SIGTERM、健康端点 | 无 SnowLuma 时可进控制台；模拟服务恢复后可重连 |
| P3 媒体 | 路径解析、安全边界、图片/视频读取和出站 Base64 | 样例媒体读取成功，卷外路径被拒绝，发送链路保持去重 |
| P4 界面 | 外部设置、连接测试、离线引导、禁用桌面操作 | 浏览器和 SSE 均可通过 SSH 同源访问 |
| P5 部署 | Dockerfile、Compose、配置样例、初始化与回滚文档 | Linux 镜像构建并以非 root 用户运行 |
| P6 联调 | 在真实 SnowLuma 上验证账号、消息、媒体和重启 | 满足下方验收矩阵，记录版本及未覆盖能力 |

P1 是 P2/P4 的基础；P3 可在明确配置契约后实现；P5 依赖服务入口和监听方案完成；真实服务器联调在本地验证后进行。本计划不创建其他聊天或自动化任务。

## 10. 验证与验收矩阵

### 自动验证

- 配置：旧配置默认行为、合法/非法模式、HOST/PORT 环境覆盖、映射规则校验。
- 外部模式：即使存在本地 snowluma 目录和 autoLaunch=true，也不扫描 Token、不启动或停止本地进程。
- 模拟 OneBot：WS 事件进入白名单处理、HTTP 鉴权、错误 Token 明确失败、断线恢复、配置更新只保留一个连接循环。
- 路径映射：目录边界、最长前缀、中文与空格、file URI、路径越界、符号链接越界、不存在文件、权限错误及 URL 降级。
- 发送：本地图片/表情生成 base64 引用、体积超限、文件不可读、失败不计成功去重、local/auto 保持原行为。
- 生命周期：子进程接收 SIGTERM 后在期限内退出、日志/索引落盘、重启能重新拿锁；HTTP/SSE 不阻塞退出。
- 控制台：外部离线仍能配置；本地按钮不出现，直接调用对应 API 也被拒绝；来源校验不被削弱。
- 运行已有适用测试，重点包含 selftest、OneBot 白名单、sender、safe-fetch、sticker 和界面接线；Linux 环境执行完整适用套件，Windows 专用检查的跳过必须有明确理由。
- Linux 验证使用真实 Linux/Docker 环境，不能用 Windows 测试通过替代镜像验证。无该环境时明确记录待验收项。

### 真实部署验证

| 场景 | 预期 |
|---|---|
| HTTP get_version_info / get_login_info | 返回实现版本、正确账号，Token 不出现在日志 |
| 白名单群被 @ | 一次有效回复，非白名单不处理 |
| 发送普通图片、收藏表情 | SnowLuma 收到 Base64/URL，群里正常显示 |
| 接收图片并收藏 | 返回路径映射可读，收藏持久化在 Agent 卷 |
| 接收视频并抽帧 | 命中共享路径或 URL，ffmpeg/ffprobe 正常 |
| 重启 SnowLuma | Agent 自动重连，不触发本地启动、不重复建循环 |
| Docker stop Agent | 在宽限期内退出，SnowLuma 继续运行 |
| 重建 Agent | 配置、记忆、存档和表情文件保留 |
| SSH 控制台 | 配置 API、会话页及 SSE 实时更新可用 |

自动化测试不向真实 QQ 群发消息；真实消息验收使用用户指定测试会话并控制调用量。

## 11. 服务器上需要核实的信息

部署前只读采集以下信息，不回传真实令牌或完整登录配置：

1. `docker inspect snowluma` 中的实际镜像 ID、挂载位置、网络与运行参数。
2. `qq-gateway-data`、`qq-client-data` 是否存在；相关目录、样例缓存权限及 SnowLuma UID/GID。
3. OneBot 正向 WS/HTTP 是否启用，端口及监听地址；通过带凭据的实际调用验证鉴权，不在命令历史中明文写 Token。
4. 一张图片和一段视频的事件/API 响应中的路径形态；无需提供聊天正文或登录信息。
5. 卷外缓存、相对路径、file URI、内部下载 URL 是否出现；针对实际样例决定是否追加映射。
6. Linux 架构、Docker/Compose 版本、可用资源和出网情况。

缺少这些信息不阻止代码实现和模拟验证，但不能将真实媒体联调标为完成。

## 12. 回滚与运维

- 上线前备份 Agent 数据卷；首次连接不迁移或修改现有 QQ 数据卷。
- 保存上一版 Agent 镜像和配置副本；配置变更保持兼容，避免无关数据格式迁移。
- 回滚时先停止新版 Agent，恢复匹配配置/镜像后只启动一个实例。
- 停止或删除 Agent 容器不删除命名卷；禁止使用带卷删除的命令清理现有 QQ 数据。
- 现有 SnowLuma 保持独立，Agent 回滚不需要重启 SnowLuma；闲置网络连接可在确认不再使用时移除。
- Docker 日志按 Compose 轮转；保留项目已有日志清理机制。长期消息和会话文件无界增长问题在运维文档中说明，暂不改变用户保留策略。
- 当前 Windows 数据若需迁移，单独处理历史本地路径，不能直接假设 Windows file URI 在 Linux 可用。

## 13. 待交付文件清单

- `Dockerfile`、`.dockerignore`、`compose.yaml`。
- `deploy/config.linux.example.json`：无真实凭据、外部模式、媒体映射、关闭扩展热重载。
- `doc/linux-deployment.md`：初始化、接入现有网络和卷、SSH、权限、诊断、备份及回滚。
- `src/media-paths.js` 及对应测试。
- 上述核心与 UI 文件的最小必要修改；新增配置/连接/生命周期测试接入 package.json。
- README 增加 Linux 外部协议端部署入口，并明确桌面安装与服务器安装的区别。
- 联调记录：环境版本、验收结果、未覆盖能力及剩余配置项。

## 14. 参考资料

- [SnowLuma Docker 部署与卷说明](https://snowluma.github.io/en/docs/guide/deploy/docker)
- [SnowLuma Docker Framework 源码](https://github.com/SnowLuma/SnowLuma.Docker.Framework)
- [OneBot v11 正向 WebSocket 规范](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)
- [Docker Compose 网络说明](https://docs.docker.com/compose/how-tos/networking/)

外部文档与 latest 镜像会变化；实际服务器的路径、权限和能力以运行容器及 API 结果为准。
