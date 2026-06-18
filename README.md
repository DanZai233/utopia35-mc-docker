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
- 查看在线玩家并一键填入玩家名
- 单独查看玩家聊天，并从面板向游戏内发送聊天消息
- 提供 `/player` 玩家中心：玩家可注册登录、绑定 Minecraft 名称、查看在线玩家、网页聊天、自助回 home/出生点、卡住自救和每日礼包
- 上传、禁用、启用、删除 mod
- 创建、下载、恢复和删除地图/配置/迁移备份
- 支持每天定时备份地图、每周定时迁移包、本地保留数量和定时上传远端
- 把备份上传到 S3/R2/MinIO，或从远端拉回本地恢复
- 安装并嵌入 BlueMap Web 世界地图

第一次使用前建议先设置面板密码：

```bash
./mcctl set PANEL_PASSWORD "换成一个强密码"
```

也可以先用当前密码登录面板，然后在“配置”页的“面板安全”里修改密码；面板会把新的 `PANEL_PASSWORD` 写回 `.env`。

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

面板默认只绑定 `127.0.0.1`，也就是只能从服务器本机访问。如果你要放到公网，请务必先修改 `PANEL_PASSWORD` 或在“配置”页改掉默认密码，并把面板放在 HTTPS、Cloudflare Access、Tailscale、VPN 或其他认证保护后面。不要把带 Docker socket 权限的管理面板裸露到公网。

面板保存配置时会写两个文件：

- `.env`：给 Docker Compose 下次创建或重建容器时使用
- `data/server.env`：给当前 Minecraft 容器每次启动时读取，优先级高于 Compose 环境变量

因此通过面板修改配置后，通常点一次“重启”就能让配置生效，不需要删除地图数据。上传、禁用或删除 mod 后也需要重启服务器。

RCON 默认关闭。要在面板里输入服务器命令，可以在“配置”页点击“生成并启用 RCON”，保存后重启服务器。

### Web 世界地图

面板的“地图”页会检测并嵌入 [BlueMap](https://modrinth.com/plugin/bluemap)。BlueMap 是 MIT 开源的 Minecraft 3D Web 地图工具，Fabric 服务端可用。

如果还没有安装，点击“安装 BlueMap”会从 Modrinth 下载适用于 Fabric 1.20.1 的 BlueMap jar 到 `data/mods`。安装后需要重启或重新创建 Minecraft 容器，让 BlueMap 生成配置并启动 Web 地图服务。

BlueMap 自己的 Web 服务默认发布在：

```text
http://127.0.0.1:8100
```

面板默认不会让浏览器直接访问这个端口，而是通过登录后的同源地址 `/bluemap/` 代理地图资源。因此用 frp、Nginx 或其他方式把面板 `8080` 映射到外网时，通常只需要转发面板端口，地图页也会一起可用。

面板会优先把内嵌地图打开到已经有瓦片的 `world` 维度，避免 BlueMap 默认选到尚未渲染的其他维度时只显示黑色画布。

如果你已经给 BlueMap 单独配置了公网域名或反代地址，可以设置 `BLUEMAP_PUBLIC_URL` 覆盖面板内嵌地址；留空则使用内置 `/bluemap/` 代理。

首次启动后，如果 BlueMap 日志提示需要同意下载资源，请按提示修改 `data/config/bluemap/core.conf` 中的 `accept-download`，然后重启服务器或执行 BlueMap reload。

面板相关变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PANEL_BIND` | `127.0.0.1` | 面板监听的宿主机地址 |
| `PANEL_HOST_PORT` | `8080` | 面板宿主机端口 |
| `PANEL_PASSWORD` | `change-me` | 面板登录密码，可在“配置”页修改 |
| `PANEL_CONTAINER_NAME` | `utopia35-panel` | 面板容器名 |
| `BLUEMAP_HOST_PORT` | `8100` | BlueMap 地图宿主机端口 |
| `BLUEMAP_PORT` | `8100` | BlueMap 容器内端口 |
| `BLUEMAP_PUBLIC_URL` | 空 | 面板嵌入地图时使用的公网/反代地址，空则使用内置 `/bluemap/` 代理 |
| `BLUEMAP_INTERNAL_URL` | `http://minecraft:8100` | 面板容器访问 BlueMap 的内部地址 |
| `PLAYER_AUTO_WHITELIST` | `false` | 开启白名单时，玩家中心申请白名单后是否自动执行 `whitelist add` |
| `PLAYER_ACTION_COOLDOWN_SECONDS` | `60` | 玩家中心自助传送/自救冷却时间 |
| `PLAYER_DAILY_KIT_HOURS` | `24` | 每日礼包冷却小时数 |
| `PLAYER_DAILY_KIT_COMMANDS` | `give {player} minecraft:bread 16;give {player} minecraft:torch 16` | 每日礼包命令模板，使用 `;` 分隔多条命令 |
| `PLAYER_SPAWN_DIMENSION` | `minecraft:overworld` | 玩家中心“回出生点”的目标维度 |
| `PLAYER_SPAWN_X/Y/Z` | `0 / 80 / 0` | 玩家中心“回出生点”的目标坐标 |
| `SCHEDULED_BACKUP_ENABLED` | `false` | 是否启用每天定时地图备份 |
| `SCHEDULED_BACKUP_TIME` | `04:30` | 定时备份执行时间，使用面板容器本地时间 |
| `SCHEDULED_BACKUP_MIGRATION_WEEKLY` | `false` | 是否每周额外创建迁移包 |
| `SCHEDULED_BACKUP_KEEP_LOCAL` | `7` | 每种定时备份在本地保留的数量 |
| `SCHEDULED_BACKUP_UPLOAD_REMOTE` | `false` | 定时备份完成后是否上传远端 |
| `ENV_CONFIG_FILE` | `/data/server.env` | Minecraft 启动时读取的运行配置文件 |

## 备份与迁移

使用 `mcctl`：

```bash
./mcctl backup
```

备份文件会生成到 `./backups/world-YYYYMMDD-HHMMSS.tar.gz`。

只用 Docker 时，可以直接打包数据目录：

```bash
tar -czf utopia35-world-backup.tar.gz -C ~/utopia35-server/data world
```

Web 面板的“备份与迁移”页提供三种本地备份：

- 地图备份：只打包 `data/world*` 存档目录
- 配置备份：打包 `server.properties`、名单、ban/op、`config`、`defaultconfigs`、`kubejs`、面板 `.env` 等配置
- 完整迁移包：打包世界、mods、配置、脚本、名单和启动相关文件，适合换一台机器继续启动同一个服务器

每个面板创建的备份都会带 `utopia35-backup-manifest.json`，并在 `backups/` 旁边生成同名 `.json` 索引。面板可以从本地备份恢复；恢复时会先停止 Minecraft 容器，再把压缩包里的 `data/` 和 `workspace/` 合并回当前项目。恢复后请检查 `.env`、端口和路径，再启动或重启服务器。

备份包可能包含 `.env`、RCON 密码、面板密码和对象存储密钥，只上传到可信存储。远端备份使用 S3 兼容接口，支持 AWS S3、Cloudflare R2、MinIO 等。可以在面板里填写，也可以写入 `.env`：

```env
REMOTE_BACKUP_ENABLED=true
REMOTE_BACKUP_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
REMOTE_BACKUP_REGION=auto
REMOTE_BACKUP_BUCKET=utopia35-backups
REMOTE_BACKUP_PREFIX=server-a
REMOTE_BACKUP_ACCESS_KEY_ID=...
REMOTE_BACKUP_SECRET_ACCESS_KEY=...
REMOTE_BACKUP_FORCE_PATH_STYLE=true
REMOTE_BACKUP_AUTO_UPLOAD=false
```

换机器时，先部署本仓库并启动面板，填入同一套远端备份配置，然后在“远端备份”里把迁移包拉回本地，再点击“恢复”。如果只想迁移地图，可以只拉回地图备份；如果想尽量保留原服体验，优先使用完整迁移包。

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
