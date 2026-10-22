# Linux 外部 OneBot：P3–P5 实施与验证记录

日期：2026-10-22。分支：`codex/linux-external-onebot-plan`。

P3、P4 已实现并通过模拟及浏览器验证。P5 的镜像、Compose、初始化、smoke 脚本和运维文档已交付；Linux 镜像构建/非 root 运行尚未验收。P6 不在本轮范围，未连接真实 QQ 或服务器。

用户补充确认：服务器 amd64、Docker 29.8.1；OneBot HTTP 3000、正向 WS 3001；两者共用 Token。Compose 插件版本未提供，不阻塞实现，部署前核对。真实图片/视频路径、UID/GID 及权限由用户选择留到 P6。

## P3：媒体

新增 `src/media-paths.js`，供核心及扩展复用：

- 区分绝对路径、file URI、HTTP(S)、内联图及文件 ID。file URI 解码一次，拒绝主机名、片段/查询、NUL 和 `..`；保留中文、空格及编码后的文件名。
- 外部路径只允许配置映射，按目录边界匹配并选择最长前缀，不直接读取任意协议端绝对路径。POSIX 和 Windows 协议路径均可映射。
- 解析真实根/文件路径，拒绝映射根外符号链接、目录和无读权限文件。返回 `INVALID_PATH`、`NOT_PATH`、`UNMAPPED_PATH`、`OUTSIDE_ROOT`、`SYMLINK_ESCAPE`、`NOT_FILE`、`NOT_FOUND`、`UNREADABLE`、`IO_ERROR` 等原因；调用方继续安全 URL 降级。解析器不下载、不写入挂载目录。
- 已接入表情收藏 `get_image`、视频事件 path / `get_video/get_file/get_image`、控制台 `/api/media-data` 图片预览及发送表情时的缓存重试。Agent 自有下载、收藏和转码路径保持独立。第三方插件自行读取的路径不自动改写。
- `base64` 模式下普通本地图片、收藏表情、多图段直接生成 `base64://`，不先尝试容器间不可共享的本地 file URI。`auto` 保留原本地策略。外部出站视频只接受 HTTP(S) URL，本地视频明确提示未配置共享出站目录。
- 本地图片和内联图统一单张上限 **15 MiB**；本地读取先 fstat 再有界读取，拒绝目录、空文件及读取时增长。Base64 至少产生约 4/3 字节膨胀，另有 JSON/网络副本；本实现不将大视频转 Base64，也没有对任意插件的并发内存设全局上限。
- 沿用每会话发送链、限频及发送后存档/去重；补齐表情成功后去重。准备/发送失败不标记已发送，允许后续重试。收藏自有目录路径检查也补了真实符号链接边界。

URL 下载继续使用原 safe-fetch，不放宽生产 SSRF 策略。映射并不能保证真实媒体可读：现有两个卷不覆盖 `/tmp`、其他缓存根或根外链接目标。

## P4：网页控制台

- OneBot 设置新增 local/external、媒体策略、映射 JSON、监听地址/端口；连接字段保存后自动重连，监听显示实际值、环境覆盖说明及重启提示。
- 已保存 Token 继续掩码回传；空输入保持不变。新增显式清除按钮，通过同一自动保存队列提交，HTTP 空值沿用 WS Token。输入校验失败在界面显示“未保存”。
- 外部 SnowLuma 页签显示脱敏后的 WS/HTTP 地址、独立连接/HTTP/账号状态、诊断、应用日志及手动连接测试；不请求本地 QQ/协议日志，不提供本地启停、目录或 WebUI 打开操作。
- 外部离线可进入设置；启动提示不要求本地 snowluma 目录；顶部体检圆点分别展示账号、HTTP、WS、配置。设置中的桌面启动/托盘/打开目录控件隐藏，改为服务器操作说明。
- WebUI 给出 SSH 转发说明；前端不自动打开 `snowluma` 容器主机名。Host/Origin、SSE 同源机制未放宽。

浏览器在隔离临时配置和不可达模拟协议地址下实际打开：验证首启进入设置、外部页无启动按钮、测试连接显示错误、可导航到 OneBot/媒体/监听表单。此处只验证本机同源浏览器；SSH 在真实服务器上的转发仍需 P6。

## P5：部署交付

- `Dockerfile`：固定 Node 24.16.0 bookworm-slim，安装 FFmpeg/ffprobe、CA、tzdata；`npm ci --omit=dev --ignore-scripts`，只复制运行必需源码/UI/公开元数据，`USER node`（1000:1000），exec 形式入口，健康检查与 SIGTERM。
- `.dockerignore` 使用文件白名单，排除 QQ/用户数据、依赖、Git、用户扩展、环境文件和密钥等。
- `compose.yaml`：amd64、现有 external 网络/QQ 卷；媒体卷只读；数据卷独立；宿主机回环 3210；init、40 秒宽限期、去除 capabilities、no-new-privileges、日志轮转。不挂 Docker socket。
- `deploy/config.linux.example.json`：external、3000/3001、HTTP Token 沿用 WS、两个映射、Base64、热重载关闭、白名单默认关闭。没有真实凭据。
- `deploy/init-data.mjs` 合并完整默认值、验证后独占创建配置；不覆盖已有配置/Token。配置首次写入及后续更新使用 0600（Windows 不具备相同 POSIX 权限语义）。
- `deploy/smoke.mjs`：供 Linux Docker 环境构建后验收，使用随机临时 Agent 资源，验证非 root、生产依赖、FFmpeg、离线 health/API、SIGTERM、锁和卷持久化；不挂载真实 QQ 卷。
- `doc/linux-deployment.md`：网络接入、初始化、Token/模型/白名单、SSH、UID/GID、只读扩展、备份、新卷恢复和镜像回滚命令；README 增加入口。镜像不带用户抽帧扩展，只有 FFmpeg 不能单独启用 `video.frames` 能力，需按文档挂载可信扩展。
- package-lock 原根元数据为 0.3.0，已与 package.json 的 0.4.0 对齐，未更新依赖版本。

## 验证证据

`npm run test:deployment` 包含原 4 套以及新增的以下测试，本轮全部通过：

| 新套件 | 验证 |
|---|---|
| `media-paths-test.mjs` | 边界/最长前缀、中文空格、URI 单次解码/拒绝越界、POSIX/Windows 协议路径、目录/缺失、符号链接逃逸、大小、真实收藏/视频读取和 URL 降级 |
| `media-send-test.mjs` | 本地普通图片/收藏/多图 Base64、失败不计成功与重试、去重、超限/缺失文件、外部视频拒绝及 URL、本地 auto 兼容 |
| `external-ui-test.mjs` | jsdom 执行实际渲染/保存函数，离线页面、无本地 API、手动连接测试、媒体/监听保存、Token 掩码保留/显式清空、非法 JSON 不提交 |
| `deploy-init-test.mjs` | 完整默认、external、默认白名单关闭、重复初始化不覆盖 Token；POSIX 检查 0600 |

URL 降级测试的本地 HTTP fixture 只在该隔离测试配置中启用私网读取；未改变任何真实配置或默认策略。权限拒绝仅在非 root POSIX 环境断言，Windows/root 明确跳过；不能将 Windows 测试当成 Linux 共享卷权限验收。

受影响的原测试通过：selftest 41、HTTP 覆盖 116、e2e 44、UI 渲染 85；sender file URI / send-path、sticker collect、safe-fetch-file、OneBot 白名单、UI wiring、skill-modal-ui 均通过。执行 JS 语法检查、`git diff --check`、`docker compose config --quiet` 通过。

在独立临时目录使用缓存离线运行 `npm ci --offline --omit=dev --ignore-scripts --no-audit --no-fund` 成功，仅安装 4 个生产包，顶层为 js-yaml 5.4.1、undici 6.28.0、ws 8.21.3。该结果证明锁文件生产安装可用，不能替代 Debian 镜像构建。

原全量套件中已记录的 3 项环境/基线失败不在本轮修复范围，参见 P0–P2 记录；未宣称整个 npm test / test:coverage 全绿。

## 尚未验收

本机 Docker CLI/Compose 可用，但 Linux Engine 命名管道 `dockerDesktopLinuxEngine` 不存在。尝试 Desktop CLI 和隐藏启动已安装的 Docker Desktop 后仍未获得引擎；`docker compose build --pull qq-agent` 因此在实际构建前失败。独立查询 Docker Hub 的镜像 manifest 也遇到 registry 网络连接超时。

因此尚未执行 Linux 镜像构建、非 root 容器 smoke、POSIX 原生信号和 Linux 权限测试；不能将 P5 的阶段验收标记为完成。文档和 smoke 脚本已备妥，需在可用 Linux Docker 上补验。

P6 另需真实服务器核对：镜像 ID/Compose 版本、OneBot 监听地址/鉴权/事件、白名单内一次回复、图片与收藏、视频映射与抽帧扩展、SnowLuma 重启重连、Agent 停止/重建、SSH/SSE。用户已明确真实媒体样例与权限检查留到 P6。本轮未向真实 QQ 发消息，也未部署到用户服务器。
