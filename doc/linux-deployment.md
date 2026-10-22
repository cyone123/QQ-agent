# Linux 首次部署：必要步骤

适用于你现有的 `snowluma` 容器：amd64，HTTP 3000、正向 WS 3001，共用 Token。保留现有 SnowLuma 和 QQ 数据，只新增 Agent 容器。

开始前：当前实现需先提交并推送到下面的分支；SnowLuma 中的 OneBot HTTP / 正向 WS 服务需监听 `0.0.0.0`，QQ 已登录。服务器需有 Docker Compose 插件。

## 1. 在服务器下载项目

```bash
git clone --branch codex/linux-external-onebot-plan https://github.com/cyone123/QQ-agent.git
cd QQ-agent
```

已有项目目录时，在该目录切换到上述分支并拉取最新代码即可。

## 2. 将 SnowLuma 加入共享网络

```bash
docker network create qq-agent-net
docker network connect qq-agent-net snowluma
```

只需首次执行。如果提示网络已存在，或 SnowLuma 已连接该网络，跳过对应命令。

## 3. 构建、初始化并启动 Agent

在项目目录执行：

```bash
docker compose build qq-agent
docker compose run --rm --no-deps qq-agent node deploy/init-data.mjs
docker compose up -d --no-build qq-agent
```

初始化只执行一次；提示配置已存在时跳过初始化，不覆盖原配置。共享媒体卷、路径映射和 Base64 发送已预设，无需手动修改配置文件。

## 4. 从自己的电脑打开控制台

在你自己的电脑上执行，替换用户名和服务器地址，保持 SSH 连接：

```bash
ssh -N -L 3210:127.0.0.1:3210 用户名@服务器地址
```

浏览器打开 **http://127.0.0.1:3210**。

## 5. 在网页填写配置

1. **设置 → OneBot**：保持“外部 OneBot”，WS 地址为 `ws://snowluma:3001`，HTTP 地址为 `http://snowluma:3000`。填入你的 WS Token，HTTP Token 留空沿用。
2. **SnowLuma 页签 → 测试连接**：确认 WS、HTTP 和账号检查通过。
3. **设置 → 模型 API**：填写模型服务地址、Key 和模型。
4. **设置 → 聊天白名单**：添加要响应的群或好友；初始白名单为空，不会处理聊天。

完成后，在白名单会话中 @ 机器人测试一次回复。

---

遇到问题再查看 [验证、排障与运维参考](linux-operations.md)，其中包含日志、媒体权限、扩展、备份和回滚命令。

当前 Linux 镜像构建/运行尚未实测，真实媒体路径与权限验证留到 P6；具体状态见 [实施记录](linux-external-onebot-p3-p5.md)。
