# Linux + 现有 SnowLuma Docker 部署

适用配置：amd64，现有容器名 `snowluma`，HTTP 3000 / 正向 WS 3001，二者使用同一 Token（用户已确认 Docker 29.8.1；Compose 插件版本尚待核对）。Agent 单实例独立运行，通过 SSH 使用网页控制台。

本仓库交付 P3–P5 的代码、部署文件和模拟测试。当前开发机 Docker Linux Engine 不可达，镜像构建与 Linux 容器运行尚未实测，不能据此称镜像已验收。请先执行第 3 节的容器 smoke 检查，再连接真实 SnowLuma；真实 QQ/媒体/权限验收属于 P6。

## 1. 配置与网络

在服务器克隆 fork 并切换工作分支（若已有 checkout，直接进入该目录）：

```bash
git clone --branch codex/linux-external-onebot-plan https://github.com/cyone123/QQ-agent.git
cd QQ-agent
docker version
docker compose version
docker info --format '{{.OSType}} {{.Architecture}}'
docker inspect snowluma --format 'Image={{.Image}} User={{.Config.User}}'
docker volume inspect qq-gateway-data qq-client-data >/dev/null
```

Docker Compose v2 或更新的插件即可；`docker info` 应显示 Linux / x86_64。确认拉到包含 Dockerfile 的新提交；实现未推送前请勿使用远端旧版本部署。构建需要访问镜像仓库、Debian 包源以及锁文件中的 npm 包源。

不重建现有 SnowLuma，只接入共享网络，保留已有 QQ 登录态及三个卷：

```bash
docker network inspect qq-agent-net >/dev/null 2>&1 || docker network create qq-agent-net
if ! docker inspect snowluma --format '{{json .NetworkSettings.Networks}}' | grep -q '"qq-agent-net"'; then
  docker network connect qq-agent-net snowluma
fi
```

SnowLuma 的 OneBot 服务必须监听容器内 `0.0.0.0:3000/3001`，仅监听 127.0.0.1 无法跨容器访问。正向 WS 必须上报事件。通过 SnowLuma 原有 WebUI 自行核对；不要将真实 Token 回传到聊天或写入 Git。此后重新创建 SnowLuma 时，在原 `docker run` 中增加 `--network qq-agent-net`，或重新执行网络连接。

| Agent 使用 | SnowLuma 内部位置 | Agent 挂载位置 | 权限 |
|---|---|---|---|
| `qq-gateway-data` | `/app/data` | `/mnt/snowluma/data` | 只读 |
| `qq-client-data` | `/app/.local/share` | `/mnt/snowluma/qq-share` | 只读 |
| `qq-agent-data` | 不共享 | `/var/lib/qq-agent` | Agent 自有读写 |

暂不挂载 `qq-client-config`。映射只允许读取前两行根目录内的文件，拒绝根外路径、越界 file URI、越界符号链接和目录。`/tmp`、`/app/.cache` 等位置未覆盖，失败会尝试已有 URL 下载路径；内网 URL 仍受 SSRF 限制。不要为接入而全局开启 `allowPrivateImageHosts`。挂载整个 gateway 卷仍意味着 Agent 可读其中配置；此规则不是第三方插件沙箱。

## 2. 构建与首次初始化

```bash
docker compose config --quiet
docker compose build --pull qq-agent
docker image inspect qq-agent:linux-p3-p5 --format 'Image={{.Id}} User={{.Config.User}}'
```

镜像固定 `node:24.16.0-bookworm-slim`，生产依赖由 package-lock 锁定；基础镜像和 apt 源可能更新，发布时记录最终镜像 ID/基础摘要，而非声称整个构建逐字节可复现。镜像以 `node`（UID/GID 1000:1000）运行，带 FFmpeg、ffprobe、CA 和时区；不带 Electron、QQ、SnowLuma、用户插件或真实数据。

初始化完整默认配置（模式 external、图片 Base64、映射两卷、扩展热重载关闭、白名单为空且不放行所有人）：

```bash
docker compose run --rm --no-deps qq-agent node deploy/init-data.mjs
```

脚本以非 root 用户运行，配置权限 0600；使用独占创建，第二次执行会拒绝覆盖已有配置，这时应跳过初始化继续使用原配置。Docker 首次挂载空命名卷会带入镜像目录的 UID/GID 及 0700 权限。若你预先创建的 Agent 卷不可写，先确认这确实是 **Agent 自有卷**，可只修正卷根目录：

```bash
docker run --rm --user 0:0 --mount type=volume,src=qq-agent-data,dst=/data \
  --entrypoint sh qq-agent:linux-p3-p5 -c 'chown 1000:1000 /data && chmod 700 /data'
```

不要将该命令用于 QQ 卷，不递归改变 QQ 数据所有者，也不使用 chmod 777。旧 Agent 数据迁移需另行检查内部文件权限；一个数据卷只能供一个 Agent 实例运行。

已有预先准备的配置也可作为初始化源传入。先在服务器将文件权限设为 0600，再通过只读 bind mount 提供，避免令牌进入命令历史：

```bash
chmod 600 /安全位置/config.json
docker compose run --rm --no-deps \
  -v /安全位置/config.json:/run/agent-config.json:ro \
  qq-agent node deploy/init-data.mjs /run/agent-config.json
```

该源文件还需允许 UID 1000 读取；不能读时使用默认初始化并经 SSH 控制台配置即可，无须扩大权限。

## 3. Linux 镜像 smoke 检查

在装有 Node.js >=20 的 Docker 客户端环境运行：

```bash
node deploy/smoke.mjs qq-agent:linux-p3-p5
```

检查仅创建随机命名的临时 Agent 容器/卷，并在结束时清理这些资源；不会挂载或调用现有 QQ 卷。验证非 root、无开发依赖、FFmpeg/ffprobe、协议端离线时 `/healthz` 和状态 API 可访问、真实 SIGTERM 正常退出、重启锁及数据持久化。需要可用的 Linux Docker Engine；不要求真实 QQ 或模型。

核心代码测试可在 Linux checkout 安装开发依赖后执行（不在生产镜像安装）：

```bash
npm ci --ignore-scripts
npm run test:deployment
```

POSIX 下生命周期测试发送真实信号，非 root 下会额外验证媒体权限拒绝；Windows 中使用 IPC 分发信号 handler，不能替代 Linux 验收。旧全量套件已知基线失败见 P0–P2 记录，不应靠修改断言掩盖。

## 4. 启动与 SSH 控制台

```bash
docker compose up -d --no-build qq-agent
docker compose ps
curl --fail http://127.0.0.1:3210/healthz
docker compose logs --tail=100 qq-agent
```

本地电脑执行，保持 SSH 连接：

```bash
ssh -N -L 3210:127.0.0.1:3210 用户名@服务器地址
```

浏览器打开 `http://127.0.0.1:3210`，按顺序配置：

1. 设置 → OneBot：确认 external、`ws://snowluma:3001`、`http://snowluma:3000`；填写 WS Token，HTTP Token 保持空（沿用 WS）。若存有旧独立 HTTP Token，点其“清除”。保存后自动重连。
2. SnowLuma 页签：点“测试连接”，分别检查 WS、HTTP、账号。测试 API 查询版本和账号，结果缓存 10 秒；不发送 QQ 消息。WS 已连接并不代表 QQ 账号已就绪。
3. 设置 → 模型接口：填写模型服务地址、Key 和模型。
4. 设置 → 白名单：添加指定群/好友。初始不响应任何会话，避免误连后立即处理所有消息。
5. 媒体设置保持 `base64`，映射保留示例；每张本地图片/收藏表情上限 **15 MiB**。普通图、多图和收藏表情均先转 Base64；成功后才计入去重/存档。`auto` 保留桌面本地路径优先策略，不适合不共享出站文件的容器。

环境 `QQ_AGENT_HOST` / `QQ_AGENT_PORT` 优先于磁盘配置，界面会显示实际监听值和重启提示。Compose 内监听 0.0.0.0，但宿主机仅发布 `127.0.0.1:3210`。不要直接将控制台暴露公网；现有固定控制台标记及 SSE 机制不是公网登录系统。Host/Origin 防护保持启用。

SnowLuma 的管理 WebUI 可另开 `ssh -N -L 5099:127.0.0.1:5099 用户名@服务器地址`，浏览器访问 `http://127.0.0.1:5099`。控制台不会尝试在你的浏览器打开 Docker 内部主机名。既有 SnowLuma 端口的防火墙策略保持独立管理。

## 5. 媒体权限与扩展

只读挂载并不自动赋予可读权限。P6 用真实图片/视频样例核对路径，然后只查看目录权限、文件 UID/GID，避免输出完整登录配置。可用如下命令检查已知样例（将占位路径换成实际路径）：

```bash
docker exec snowluma id
docker exec snowluma stat -c '%u:%g %a %n' /app/data/已知媒体文件
docker compose exec qq-agent id
docker compose exec qq-agent stat -c '%u:%g %a %n' /mnt/snowluma/data/已知媒体文件
```

需要现有共享组时，在单独的 `compose.override.yaml` 给 Agent 添加 `group_add: ["实际GID"]` 后重建 Agent；先确认目录有组执行/文件有组读权限。不要猜 GID，也不要为此以 root 跑 Agent。仍不可读就使用安全 URL 降级，按具体目录另行规划权限。

镜像 `/opt/qq-agent/skills`、`plugins` 为空，不带用户扩展；加载器对已存在的只读扩展目录只读扫描，不主动创建/写入。需要抽帧时安装提供 `video.frames` / `video.frames.available` 的可信扩展并只读挂载，例如 override：

```yaml
services:
  qq-agent:
    volumes:
      - /srv/qq-agent/skills:/opt/qq-agent/skills:ro
      - /srv/qq-agent/plugins:/opt/qq-agent/plugins:ro
    # group_add:
    #   - "实际需要的共享组GID"
```

先在宿主机创建目录并检查内容。只读挂载下不要使用控制台市场安装/删除来更改这些目录，应在宿主机更新后重启 Agent（热重载默认关闭）。扩展如果要写自己的目录则需要适配为写入 Agent 数据目录。插件自行读协议路径不自动受核心映射适配；可复用 `src/media-paths.js` 的 `resolveMediaPath()`（返回 `{ok,path}` 或 `{ok:false,reason}`），但任意插件代码仍有 Node 进程自身的文件权限。

本地出站视频未设计共享出站目录，外部模式会明确拒绝，要求可用 HTTP(S) URL；不将大视频无条件装进 Base64。入站视频映射/下载与 ffprobe 已接入，抽帧能力还依赖上述扩展。

## 6. 故障排查与运行限制

| 表现 | 检查 |
|---|---|
| 域名解析失败 | 两个容器是否在 qq-agent-net，容器名是否 snowluma |
| 连接拒绝 | SnowLuma 是否监听 0.0.0.0:3000/3001，账号是否登录 |
| HTTP/WS 401 | 显式 Token 是否一致；HTTP 空值是否按预期继承；不尝试自动扫描本地 Token |
| WS 通但 HTTP 失败 | 分别检查 HTTP 服务与鉴权，点击测试连接 |
| 协议路径未映射/无图片 | 实际文件是否在两个卷内、映射根/权限/符号链接；可用 URL 是否被拒或过期 |
| 配置未保存 | 设置中查看错误提示，检查映射 JSON/绝对路径/监听端口及数据卷权限 |
| 容器重启循环 | 检查配置语义错误、固定端口冲突、数据卷写权限；不并发启动第二实例 |
| unhealthy 但 QQ 离线 | healthz 与 QQ 状态无关，先查 HTTP/进程；restart 只在进程退出后重启 |

`docker stop`/Compose stop 的宽限期 40 秒；Agent 总退出期限 25 秒，正常会关闭 WS/SSE、取消模型任务、刷存档和日志，退出不终止外部 SnowLuma。第三方插件不可取消的操作仍可能触发超时退出。

日志按 10 MiB ×3 轮转；数据卷中的历史会话、媒体、记忆不自动执行额外清理，请按实际容量设置备份与保留策略。Windows 数据中的历史绝对路径不能直接当作 Linux 路径；收藏表情有受控目录内同名重定位，其他路径仍需逐项验证。

## 7. 备份、升级、回滚

所有操作在服务器 checkout 内进行。备份前停 Agent，SnowLuma 保持运行。不要使用 `docker compose down -v` 或删除已有 QQ 卷。

```bash
docker compose stop qq-agent
mkdir -p backups
chmod 700 backups
backup_name="agent-$(date +%Y%m%d-%H%M%S).tar.gz"
docker run --rm --user 0:0 --mount type=volume,src=qq-agent-data,dst=/data,readonly \
  --mount type=bind,src="$PWD/backups",dst=/backup --entrypoint sh \
  qq-agent:linux-p3-p5 -c 'umask 077; tar -czf "/backup/$1" -C /data .' sh "$backup_name"
docker tag qq-agent:linux-p3-p5 qq-agent:rollback-before-upgrade
docker compose build --pull qq-agent
docker compose up -d --no-build qq-agent
```

备份含 Key、聊天及登录相关内容，应保存在受控目录。构建失败时仍可用旧镜像恢复运行。

只回滚程序、保留当前数据：

```bash
docker compose stop qq-agent
QQ_AGENT_IMAGE_TAG=rollback-before-upgrade docker compose up -d --no-build qq-agent
```

若确需回滚数据，保留现卷，恢复到**新的**命名卷再替换 Compose 中 `qq-agent-data.name`，避免直接清空现数据：

```bash
docker compose stop qq-agent
restore_volume="qq-agent-restored-$(date +%Y%m%d-%H%M%S)"
docker volume create "$restore_volume"
# 将下面的备份文件名替换为上面确认的真实备份，不要使用通配符。
docker run --rm --user 0:0 --mount type=volume,src="$restore_volume",dst=/data \
  --mount type=bind,src="$PWD/backups",dst=/backup,readonly --entrypoint sh \
  qq-agent:rollback-before-upgrade -c 'tar -xzf /backup/已确认的备份.tar.gz -C /data && chown 1000:1000 /data && chmod 700 /data'
```

确认恢复卷内容后，将 override 的顶层 `volumes: { qq-agent-data: { name: "新卷名" } }` 指向它，以旧镜像启动一个 Agent。备份不含运行中的数据写入，旧 lock 文件即使保留也应由启动检测处理；如被误判，先确认没有任何其他 Agent 使用该卷，再处理锁，不盲目删锁。

## 参考

- [Docker Compose 外部网络](https://docs.docker.com/compose/how-tos/networking/)
- [Compose 服务配置：volumes、group_add、healthcheck、stop_grace_period](https://docs.docker.com/reference/compose-file/services/)
- [官方 Node Docker 镜像](https://github.com/nodejs/docker-node)
- [实施计划](linux-external-onebot-implementation-plan.md)、[P0–P2 记录](linux-external-onebot-p0-p2.md)、[P3–P5 记录](linux-external-onebot-p3-p5.md)
