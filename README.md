# Utopia 3.5 Minecraft Server Docker

乌托邦 3.5 Fabric Minecraft 服务端 Docker 镜像和配置工具。地图、日志、`server.properties`、白名单等运行数据会持久化到宿主机目录。

默认设置：

- 不开启白名单：`white-list=false`
- 不开启正版登录验证：`online-mode=false`
- 默认端口：`25565`
- 默认内存：`4096M`

## 一键启动

先创建一个目录保存地图数据：

```bash
mkdir -p ~/utopia35-server/data
cd ~/utopia35-server
```

拉取镜像：

```bash
docker pull danzai233/utopia35-mc-server:3.5
```

启动服务器：

```bash
docker run -d \
  --name utopia35-mc \
  --restart unless-stopped \
  -p 25565:25565 \
  -v "$PWD/data:/data" \
  -e EULA=true \
  -e MIN_MEMORY=4096M \
  -e MAX_MEMORY=4096M \
  -e MOTD="Utopia 3.5 Fabric Server" \
  -e ONLINE_MODE=false \
  -e ENABLE_WHITELIST=false \
  danzai233/utopia35-mc-server:3.5
```

查看日志：

```bash
docker logs -f utopia35-mc
```

停止、启动、重启：

```bash
docker stop utopia35-mc
docker start utopia35-mc
docker restart utopia35-mc
```

删除容器但保留地图数据：

```bash
docker rm -f utopia35-mc
```

地图和配置会保存在 `~/utopia35-server/data`，删除容器不会删除这个目录。

## 修改配置

修改 Docker 环境变量后，需要重建容器。地图在 `./data`，不会丢。

例如改成 8G 内存、30 人、公开端口 `30065`：

```bash
docker rm -f utopia35-mc
docker run -d \
  --name utopia35-mc \
  --restart unless-stopped \
  -p 30065:25565 \
  -v "$PWD/data:/data" \
  -e EULA=true \
  -e MIN_MEMORY=8192M \
  -e MAX_MEMORY=8192M \
  -e MAX_PLAYERS=30 \
  -e MOTD="Utopia 3.5" \
  -e ONLINE_MODE=false \
  -e ENABLE_WHITELIST=false \
  danzai233/utopia35-mc-server:3.5
```

开启正版登录验证：

```bash
docker rm -f utopia35-mc
docker run -d \
  --name utopia35-mc \
  --restart unless-stopped \
  -p 25565:25565 \
  -v "$PWD/data:/data" \
  -e EULA=true \
  -e ONLINE_MODE=true \
  -e ENABLE_WHITELIST=false \
  danzai233/utopia35-mc-server:3.5
```

开启白名单：

```bash
docker rm -f utopia35-mc
docker run -d \
  --name utopia35-mc \
  --restart unless-stopped \
  -p 25565:25565 \
  -v "$PWD/data:/data" \
  -e EULA=true \
  -e ONLINE_MODE=false \
  -e ENABLE_WHITELIST=true \
  -e ENFORCE_WHITELIST=true \
  danzai233/utopia35-mc-server:3.5
```

常用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EULA` | `false` | 必须设置为 `true` 才会启动 |
| `MIN_MEMORY` / `MAX_MEMORY` | `4096M` | Java 初始/最大内存 |
| `MOTD` | `Utopia 3.5 Fabric Server` | 服务器列表显示文本 |
| `SERVER_PORT` | `25565` | 容器内服务端口 |
| `MAX_PLAYERS` | `20` | 最大玩家数 |
| `ONLINE_MODE` | `false` | 正版登录验证 |
| `ENABLE_WHITELIST` | `false` | 白名单开关 |
| `ENFORCE_WHITELIST` | `false` | 强制白名单 |
| `PVP` | `true` | PVP 开关 |
| `ALLOW_FLIGHT` | `true` | 允许飞行 |
| `VIEW_DISTANCE` | `10` | 视距 |
| `SIMULATION_DISTANCE` | `10` | 模拟距离 |
| `ENABLE_RCON` | `false` | RCON 开关 |
| `RCON_PASSWORD` | 空 | RCON 密码，开启 RCON 时必须设置强密码 |

需要覆盖更多 `server.properties` 时，可以设置 `SERVER_PROPERTIES`，用 `\n` 分隔多行：

```bash
-e SERVER_PROPERTIES='spawn-protection=0\nforce-gamemode=true'
```

也可以直接编辑持久化目录里的 `data/server.properties`，然后重启容器。不过如果同一个配置项也由环境变量设置，容器启动时会用环境变量覆盖它。

## Docker Compose

clone 仓库后：

```bash
git clone https://github.com/DanZai233/utopia35-mc-docker.git
cd utopia35-mc-docker
cp .env.example .env
```

接受 EULA：

```bash
./mcctl set EULA true
```

启动已发布镜像：

```bash
docker compose pull
docker compose up -d
docker compose logs -f minecraft
```

修改配置：

```bash
./mcctl set MAX_MEMORY 8192M
./mcctl set MAX_PLAYERS 30
./mcctl set MOTD "Utopia 3.5"
./mcctl set ONLINE_MODE false
./mcctl set ENABLE_WHITELIST false
./mcctl restart
```

Compose 的运行数据会在仓库目录的 `./data`。

## Web 控制面板

仓库内带了一个可选的 Web 控制面板，用来做常见服务器管理：

- 查看容器状态、健康状态、CPU、内存、数据目录
- 启动、停止、重启 Minecraft 容器
- 修改常用运行配置：内存、MOTD、人数、正版验证、白名单、视距、RCON 等
- 实时查看服务器日志
- 通过 RCON 输入控制台命令
- 快捷执行玩家管理命令：`op`、`deop`、白名单、踢出、封禁、广播、保存地图等
- 上传、禁用、启用、删除 mod
- 创建和下载地图备份

第一次使用前建议先设置面板密码：

```bash
./mcctl set PANEL_PASSWORD "换成一个强密码"
```

启动服务器和面板：

```bash
./mcctl panel up
```

只启动面板，不主动启动 Minecraft 服务：

```bash
./mcctl panel only
```

查看面板地址：

```bash
./mcctl panel url
```

默认地址是：

```text
http://127.0.0.1:8080
```

也可以直接使用 Docker Compose：

```bash
docker compose --profile panel pull
docker compose --profile panel up -d
```

面板默认只绑定 `127.0.0.1`，也就是只能从服务器本机访问。如果你要放到公网，请务必先修改 `PANEL_PASSWORD`，并把面板放在 HTTPS、Cloudflare Access、Tailscale、VPN 或其他认证保护后面。不要把带 Docker socket 权限的管理面板裸露到公网。

面板保存配置时会写两个文件：

- `.env`：给 Docker Compose 下次创建或重建容器时使用
- `data/server.env`：给当前 Minecraft 容器每次启动时读取，优先级高于 Compose 环境变量

因此通过面板修改配置后，通常点一次“重启”就能让配置生效，不需要删除地图数据。上传、禁用或删除 mod 后也需要重启服务器。

RCON 默认关闭。要在面板里输入服务器命令，可以在“配置”页点击“生成并启用 RCON”，保存后重启服务器。

面板相关变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PANEL_BIND` | `127.0.0.1` | 面板监听的宿主机地址 |
| `PANEL_HOST_PORT` | `8080` | 面板宿主机端口 |
| `PANEL_PASSWORD` | `change-me` | 面板登录密码 |
| `PANEL_CONTAINER_NAME` | `utopia35-panel` | 面板容器名 |
| `ENV_CONFIG_FILE` | `/data/server.env` | Minecraft 启动时读取的运行配置文件 |

## 备份地图

使用 `mcctl`：

```bash
./mcctl backup
```

备份文件会生成到 `./backups/world-YYYYMMDD-HHMMSS.tar.gz`。

只用 Docker 时，可以直接打包数据目录：

```bash
tar -czf utopia35-world-backup.tar.gz -C ~/utopia35-server/data world
```

## 本地构建镜像

如果你拿到了新的服务端整包：

```bash
./mcctl prepare "/path/to/乌托邦3.5服务端"
./mcctl build
./mcctl up
```

`./mcctl prepare` 会把非 mod 服务端文件放到 `server-files/`，并把 `mods/` 拆到 `.docker-pack/mods-00` 到 `.docker-pack/mods-15`。这些目录用于生成较小的 Docker 镜像层，低上行带宽推送 DockerHub 时会更稳；实际 jar 文件仍然被 Git 忽略。

已有地图仍然在 `./data`。如果你想让新的默认 `config` 或 `kubejs` 覆盖旧数据，请先备份，然后手动合并 `server-files/` 和 `data/` 中对应目录。

## 发布到公网

局域网内测试通过后，把服务器所在机器的 `25565/tcp` 映射到公网即可。云服务器安全组、防火墙和路由器端口转发都需要放行该端口。

如果 `docker run` 使用了 `-p 30065:25565`，玩家连接地址就是：

```text
公网 IP:30065
```

## 授权说明

这个仓库默认不会提交 `server-files/`、`.docker-pack/` 里的实际 jar 文件和地图数据，因为 Minecraft 服务端、mod jar、材质或脚本可能有各自的再分发限制。

如果要发布已经包含整包的镜像，请先确认你有权分发这些文件，并遵守 Minecraft EULA。
