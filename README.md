# Utopia 3.5 Minecraft Server Docker

把本地的乌托邦 3.5 Fabric 服务端打包成 Docker 镜像，并把地图和运行配置持久化到宿主机的 `./data` 目录。

## 快速开始

```bash
cd /Users/dan_zai/Git/utopia35-mc-docker
./mcctl init
./mcctl prepare "/Users/dan_zai/Downloads/乌托邦3.5服务端"
./mcctl set EULA true
./mcctl build
./mcctl up
./mcctl logs
```

服务器默认监听 `25565`。运行数据会在 `./data`，其中包括 `world`、`server.properties`、`ops.json`、`whitelist.json`、日志和崩溃报告。

已经发布的 DockerHub 镜像：

```bash
docker pull danzai233/utopia35-mc-server:3.5
```

## 常用配置

所有配置都在 `.env`，也可以用 `mcctl set` 修改：

```bash
./mcctl set MAX_MEMORY 8192M
./mcctl set MAX_PLAYERS 30
./mcctl set MOTD "Utopia 3.5"
./mcctl set ONLINE_MODE true
./mcctl set ENABLE_WHITELIST true
./mcctl restart
```

常用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EULA` | `false` | 必须改成 `true` 才会启动 |
| `HOST_PORT` | `25565` | 宿主机公开端口 |
| `MIN_MEMORY` / `MAX_MEMORY` | `4096M` | Java 初始/最大内存 |
| `MOTD` | `Utopia 3.5 Fabric Server` | 服务器列表显示文本 |
| `MAX_PLAYERS` | `20` | 最大玩家数 |
| `ONLINE_MODE` | `true` | 正版验证 |
| `ENABLE_WHITELIST` | `false` | 白名单开关 |
| `VIEW_DISTANCE` | `10` | 视距 |
| `SIMULATION_DISTANCE` | `10` | 模拟距离 |
| `ENABLE_RCON` | `false` | RCON 开关 |
| `RCON_PASSWORD` | 空 | RCON 密码，开启 RCON 时必须设置强密码 |

需要覆盖更多 `server.properties` 时，可以设置 `SERVER_PROPERTIES`，格式为 `key=value` 多行文本。

## 数据持久化

`compose.yaml` 把宿主机 `./data` 挂载到容器 `/data`。第一次启动时，镜像里的服务端模板会复制到 `/data`；之后容器重建、镜像更新都不会删除地图。

`./mcctl prepare` 会把非 mod 服务端文件放到 `server-files/`，并把 `mods/` 拆到 `.docker-pack/mods-00` 到 `.docker-pack/mods-15`。这些目录用于生成较小的 Docker 镜像层，低上行带宽推送 DockerHub 时会更稳；实际 jar 文件仍然被 Git 忽略。

备份地图：

```bash
./mcctl backup
```

备份文件会生成到 `./backups/world-YYYYMMDD-HHMMSS.tar.gz`。

## 更新服务端整包

如果你拿到了新的服务端整包：

```bash
./mcctl down
./mcctl prepare "/path/to/new/乌托邦服务端"
./mcctl build
./mcctl up
```

已有地图仍然在 `./data`。如果你想让新的默认 `config` 或 `kubejs` 覆盖旧数据，请先备份，然后手动合并 `server-files/` 和 `data/` 中对应目录。

## 发布到公网

局域网内测试通过后，把服务器所在机器的 `25565/tcp` 映射到公网即可。云服务器安全组、防火墙和路由器端口转发都需要放行该端口。

如果你只想换宿主机端口，例如公网用 `30065`：

```bash
./mcctl set HOST_PORT 30065
./mcctl restart
```

玩家连接地址就是 `公网 IP:30065`。

## 发布到 GitHub 和 GHCR

这个仓库默认不会提交 `server-files/`，因为 Minecraft 服务端、mod jar、材质或脚本可能有各自的再分发限制。建议公开 GitHub 仓库时只发布 Docker 工具和配置；如果要发布已经包含整包的镜像，请先确认你有权分发这些文件，并遵守 Minecraft EULA。

本地构建并推送镜像：

```bash
docker login ghcr.io
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<你的 GitHub 用户名>/utopia35-mc-server:3.5 \
  --push .
```

别人使用已经发布的 DockerHub 镜像时，只需要保持 `.env` 里的镜像名为：

```env
IMAGE_NAME=danzai233/utopia35-mc-server
IMAGE_TAG=3.5
```

然后运行：

```bash
docker compose pull
docker compose up -d
```

仓库里包含一个 GitHub Actions 发布工作流。如果你希望 Actions 自动构建镜像，需要提供 `SERVER_PACK_URL` 仓库密钥，指向你有权分发的服务端整包 zip。
