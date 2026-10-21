# Toonflow 服务器部署与运维（D 工作包）

适用对象：负责 Linux 镜像与独立部署的执行者/运维者。契约与所有权见 `docs/executionContract.md` §9/§10，任务书见 `docs/deepseekExecutionPlan.md` §7。
本文档不含任何真实密码或 Key；凭据只在服务器 `/opt/toonflow/.env`（0600）与仓库外私有交接文件中。

## 1. 架构与数据目录

- 单实例、非 root（镜像内 `bun` 用户）容器；容器内端口 **3000**（`apps/server/src/index.ts` 固定监听 3000）。
- 服务器只监听回环：宿主机 `127.0.0.1:3930` → 容器 `3000`；业务端口不裸露公网。
- 部署目录 `/opt/toonflow/`：Compose 项目名 `toonflow`、容器名 `toonflow`；数据目录 `/opt/toonflow/data`（bind 挂载到容器 `/app/data`，见 §3）。
- 基础镜像 `oven/bun:1.3.14`（与 lockfile `packageManager: bun@1.3.14` 一致），镜像内已含 FFmpeg；镜像不含任何密钥。

容器内 `/app/data`（即宿主机 `/opt/toonflow/data`）结构：

| 路径 | 内容 |
| --- | --- |
| `settings.json` | 全局设置（`conf`，0600）；含供应商配置与 MCP 配置 |
| `auth.json` | 管理员凭据哈希（0600，首启生成；只有 username/passwordHash/时间） |
| `workspaces/` | 项目工作区（用户画布、素材、输出） |
| `mediaTasks/batches/` | 媒体任务持久记录（G1 任务层引入） |
| `mediaTasks/inputs/` | 参考媒体输入快照（内容寻址去重） |
| `fileRecords/records.json` | 文件归属记录（G2 清理层引入） |
| `providers/`、`nodes/`、`tools/`、`ext/`、`skills/` | 插件同步目录：按 `TOONFLOW_BUILD_ID`（pluginRevision）覆盖内置文件并保留用户修改 |
| `mcpRuntime*.json` | MCP 运行时会话文件 |

说明：`mediaTasks/`、`fileRecords/` 在对应工作包合并后的版本中才会出现，属预期；不要为了“对齐目录”手工创建。

## 2. 首次部署步骤

以下步骤在**源码集成门通过后**执行；本工作包已完成 §2.1 的目录与 `.env` 准备（未构建、未启动）。

### 2.1 目录与 .env（已由 D 工作包准备）

```sh
# 目录（root 所有，755；数据目录归属在首次构建后按镜像内 bun uid 对齐）
mkdir -p /opt/toonflow /opt/toonflow/data
chmod 755 /opt/toonflow /opt/toonflow/data

# /opt/toonflow/.env（0600，root），示例模板——不要写入真实值到仓库或聊天
TOONFLOW_ADMIN_PASSWORD=<首启管理员密码，仅首次初始化使用>
TOONFLOW_AUTH=1
TOONFLOW_BUILD_ID=server-20261008-1
# 公网 HTTPS 阶段才追加：
# TOONFLOW_COOKIE_SECURE=1
```

```sh
chmod 600 /opt/toonflow/.env   # 复核：ls -l /opt/toonflow/.env → -rw------- root root
```

- Compose 通过 `${TOONFLOW_ADMIN_PASSWORD:?需要在 .env 提供}` 插值；`.env` 缺失该变量时任何 `docker compose` 命令都会直接报错，不会用空密码启动。
- `.env` 属于部署目录，不进入源码仓库（仓库 `.gitignore`、`.dockerignore` 已排除 `.env`）。

### 2.2 上传源码与构建

1. 把仓库工作树（含 Dockerfile、compose.yaml 的服务器副本）上传到 `/opt/toonflow/src/`（`node_modules/`、`data/`、`build/` 可不上传，构建在容器内完成）。
2. 在 `/opt/toonflow/` 放置服务器专用 `compose.yaml`（与仓库根版本差异只有两处：`image` 明确 tag、数据用 bind 挂载，见 §3 模板）。
3. 构建并打 tag：

```sh
cd /opt/toonflow
docker compose config -q          # 校验插值与结构（-q 只校验，不打印含密码的解析结果）
docker compose build              # 基础镜像 oven/bun:1.3.14 + 容器内 bun install/build:server
docker image ls toonflow          # 记录镜像 ID 与 tag
```

### 2.3 启动前对齐数据目录归属

镜像内应用以非 root 用户 `bun` 运行，bind 挂载的宿主目录必须归属一致。构建完成后读取实际 uid/gid（只读手段，来自本次自己的镜像）：

```sh
docker run --rm --entrypoint sh toonflow:server-20261008-1 -c 'id -u bun; id -g bun'
chown -R <uid>:<gid> /opt/toonflow/data
chmod 750 /opt/toonflow/data
```

说明：`oven/bun` 镜像的 `bun` 用户 uid 以实际读取为准，不预先假设；若后续更换基础镜像版本需重新核对。

### 2.4 启动与健康检查

```sh
cd /opt/toonflow
docker compose up -d
docker compose ps                                   # State 应为 running
curl -fsS http://127.0.0.1:3930/api/auth/status     # 回环健康检查（公开端点，不需登录）
docker compose logs --tail 50 toonflow              # 应见 [认证] 已根据环境变量初始化管理员账号
ls -l /opt/toonflow/data/auth.json                  # 首启后存在，权限 600
```

`/api/auth/status` 预期 JSON（`{code,data,message}`）：`data` 含 `authRequired: true`、`initialized: true`、`authenticated: false`（未带会话 Cookie 时）。

### 2.5 首次管理员初始化流程

- 首次启动时读取 `<data>/auth.json`；文件不存在才使用 `TOONFLOW_ADMIN_PASSWORD` 生成 argon2id 哈希并落盘（0600），**不保留明文**。
- 用户名默认 `admin`，可用环境变量 `TOONFLOW_ADMIN_USERNAME` 覆盖（仅首启用）。
- 若 `auth.json` 不存在且未提供 `TOONFLOW_ADMIN_PASSWORD`：启动日志提示“管理员未初始化”，登录接口拒绝登录（服务可运行但不可登录）。
- **后续修改密码**（当前实现无修改密码的 HTTP 接口）：

```sh
cd /opt/toonflow
docker compose stop
cp data/auth.json data/auth.json.bak-$(date +%Y%m%d%H%M%S)   # 备份旧凭据
rm data/auth.json
# 在 .env 中把 TOONFLOW_ADMIN_PASSWORD 换成新密码
docker compose up -d
docker compose logs --tail 20 toonflow   # 确认“已根据环境变量初始化管理员账号”
```

- 会话为内存态，重启容器即全部失效；修改密码后需重新登录。
- 不要删除 `auth.json` 之外的数据；不要在普通 settings 接口中保存密码。

## 3. Compose 文件（仓库根 vs 服务器副本）

仓库根 `compose.yaml`（默认值，named volume）保持：

```yaml
services:
  toonflow:
    build: .
    init: true
    restart: unless-stopped
    ports:
      - "127.0.0.1:3930:3000"
    environment:
      TOONFLOW_ADMIN_PASSWORD: ${TOONFLOW_ADMIN_PASSWORD:?需要在 .env 提供}
      TOONFLOW_AUTH: "1"
      TOONFLOW_BUILD_ID: ${TOONFLOW_BUILD_ID:-dev}
    volumes:
      - toonflowData:/app/data

volumes:
  toonflowData:
```

服务器部署副本 `/opt/toonflow/compose.yaml`（差异：明确镜像 tag、bind 挂载独立数据目录；**部署时以此为准**）：

```yaml
services:
  toonflow:
    build:
      context: ./src
    image: toonflow:server-20261008-1        # 更新时同步修改 tag 与 .env 的 TOONFLOW_BUILD_ID
    init: true
    restart: unless-stopped
    ports:
      - "127.0.0.1:3930:3000"
    environment:
      TOONFLOW_ADMIN_PASSWORD: ${TOONFLOW_ADMIN_PASSWORD:?需要在 .env 提供}
      TOONFLOW_AUTH: "1"
      TOONFLOW_BUILD_ID: ${TOONFLOW_BUILD_ID:-dev}
    volumes:
      - /opt/toonflow/data:/app/data
```

- 卷选择说明（契约 §9 要求二选一并记录）：服务器采用 **bind 挂载** `/opt/toonflow/data`，便于直接备份与迁移；仓库默认仍为命名卷 `toonflowData`（其他部署方式不受影响）。服务器部署**不使用**命名卷，也不使用 `docker compose down -v`。
- `init: true` 由 Docker 注入 init 进程，利于信号与子进程回收（SIGTERM 处理由主控在工作包 I 接入）。

## 4. 更新步骤

1. **停止新受理**：通过受保护设置把 `settings.mediaTasks.paused` 置 `true`；记录当前未完成任务的 `taskId`（查询任务接口），确认没有处于 `submitting/running/downloading` 的任务或已接受其将继续等待。
2. **备份**：见 §8（数据目录 + `.env` + 当前 compose/tag 记录）。
3. **上传新源码**：更新 `/opt/toonflow/src/`；修改服务器 `compose.yaml` 的 `image` 为新 tag（如 `toonflow:server-20261009-1`），并把 `.env` 的 `TOONFLOW_BUILD_ID` 改为同一标识（pluginRevision 依此同步插件并保留用户修改）。
4. **构建**：

```sh
cd /opt/toonflow
docker compose config -q
docker compose build
```

5. **重启切新版本**：

```sh
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3930/api/auth/status
docker compose logs --tail 50 toonflow
```

6. **恢复受理**：确认健康后取消暂停（主控执行），并从任务接口核对暂停期间 `queued` 任务开始执行。

注意：更新不得清空 `data`、不得删除幂等/任务记录强迫重建；数据目录只做向前兼容处理。

## 5. 回退步骤

1. 确认要回退的镜像 tag 仍在本机（更新时**不要删除**前一 tag：`docker image ls toonflow`）。
2. 停止当前容器（仅本项目；**禁止**加 `-v`）：

```sh
cd /opt/toonflow
docker compose down
```

3. 把 `compose.yaml` 的 `image` 改回前一 tag，`.env` 的 `TOONFLOW_BUILD_ID` 同步改回；**不重新构建**：

```sh
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3930/api/auth/status
```

4. 数据校验：`data/` 不删除、不覆盖；`settings.json`、`auth.json`、`workspaces/` 保持原样。
5. **不要**恢复旧的 `mediaTasks` 幂等记录快照来重放任务：回退可能使任务格式不向前兼容，旧记录回灌有重复提交上游（重复收费）风险。回退后只按任务接口查询现有任务状态，不自动重提 `unknown`。
6. 若需要腾空间删镜像，只删除明确的旧 Toonflow tag（`docker rmi toonflow:server-<旧tag>`），保留至少一个可回退 tag；**禁止** `docker system prune`。

## 6. 访问方式（域名未定）

- 域名尚未分配给 Toonflow，当前只做回环验收。本机浏览器通过 SSH 隧道：

```sh
ssh -L 3930:127.0.0.1:3930 root@152.53.170.228
# 然后本机打开 http://127.0.0.1:3930/
```

- 服务器上 3930 只绑定回环（`127.0.0.1`），不经 SSH 隧道无法从公网访问；不改动、不接管现有任何 Nginx 站点。
- 域名明确后：新增**专属** Nginx 站点文件，`nginx -t` 成功后 `nginx -s reload`；不 restart 整机 nginx，不影响其他站点。HTTPS 阶段需在 `.env` 追加 `TOONFLOW_COOKIE_SECURE=1` 后重启本容器。

## 7. MCP 接入

- 服务器 MCP endpoint：`/mcp`（经隧道即 `http://127.0.0.1:3930/mcp`）。
- Token 使用现有独立 Bearer token 配置（`settings.json` 的 `mcp` 段），**不经过** Cookie 登录；具体 token 与启用动作由主控在验收阶段导入 `serverMcpProposed`（见 `docs/executionContract.md` §6/§8），本工作包不写入、不输出。
- MCP 新增任务工具（`submitVideoTasks/getVideoTasks/cancelVideoTasks`）为 F 工作包交付，部署侧不单独配置。

## 8. 备份与不备份清单

备份（写入部署目录外或同机独立备份位置，不写入被替换的镜像/构建目录）：

1. `/opt/toonflow/data/` 全量（含 `workspaces/`、`settings.json`、`auth.json`、`mediaTasks/`、`fileRecords/`、插件覆盖目录）——服务器部署的权威数据；
2. `/opt/toonflow/.env`（含管理员初始密码，按密钥对待，0600 保存，不进入聊天/仓库）；
3. `/opt/toonflow/compose.yaml` 与当前镜像 tag、镜像 ID 记录（`docker image inspect` 摘要）；
4. 部署基线证据（`toonflowHandoff/evidence/` 下的快照文件，如 `deployPrep20261008.txt`）。

备份示例（停本容器后打包，避免写入中的文件被复制成半截）：

```sh
cd /opt/toonflow
docker compose stop
tar -czf /opt/toonflow-backup/data-$(date +%Y%m%d%H%M%S).tgz -C /opt/toonflow data .env compose.yaml
docker compose start
ls -lh /opt/toonflow-backup/
```

不备份：

- Docker 命名卷/其他项目数据（本部署不用命名卷；其他应用的卷与容器绝不复制、不删除）；
- `node_modules/`、`build/` 等可由源码重建的产物；
- 容器写时层与临时文件；
- 服务器上其他应用（guanmu、open-ai-canvas、new-api 等）与 Nginx 站点配置；
- 任何真实 Key 的额外副本（凭据只在 `.env` 与私有交接文件中）。

## 9. 安全与红线

- 密钥只运行时注入：不写进 `Dockerfile`、`ENV` 默认值、镜像层、compose 明文、Git 或日志；`docker compose config` 校验用 `-q`，避免解析结果把密码打到终端。
- 只操作本项目资源：不使用 `docker system prune`、不对其他项目 `docker compose down`、不重启整机 nginx、不动其他容器与站点。
- 不删除数据卷/数据目录；回退不重放旧幂等记录；`unknown` 任务不自动重提。
- 数据目录归属跟随镜像内 `bun` 用户，实际 uid 以构建后读取为准。

## 10. 当前部署状态（2026-10-08，D 工作包）

- 服务器已创建 `/opt/toonflow/`、`/opt/toonflow/data/` 与 `/opt/toonflow/.env`（0600）；数据目录归属在首次构建后按镜像 `bun` uid 对齐。
- 未构建镜像、未启动容器、未配置域名/Nginx、未导入 settings（等源码集成门与主控通知）。
- 基线证据：`toonflowHandoff/evidence/deployPrep20261008.txt`（目录/权限/端口/容器快照）。


## 公网域名与 HTTPS（2026-10-08 已上线）

- 域名：`https://flow.xmxcode.com`（Cloudflare 代理，A 记录 `152.53.170.228`，与同服务器其他站点一致）。
- 源站：宿主 Nginx 独立站点 `/etc/nginx/sites-available/flow.xmxcode.com` → 反代 `127.0.0.1:3930`；real-ip snippet `cloudflare-real-ip-flow.conf`；`client_max_body_size 200m`；SSE 禁缓冲、7200s 读超时（应用层 20s 心跳兜底）。
- TLS：Let's Encrypt 单域名证书（certbot --nginx 管理，`/etc/letsencrypt/live/flow.xmxcode.com/`），80→443 跳转；续期由既有 certbot timer 自动完成。
- 容器环境新增 `TOONFLOW_COOKIE_SECURE=1`（公网 Cookie 带 Secure）。
- 未改动任何其他站点；`nginx -t` 通过后 reload。
- 注意：Cloudflare 的 Browser Integrity Check 会拦截 `Python-urllib` 一类特征 UA（实测 Chrome/curl/node/undici 均 200）；真实浏览器与 MCP 客户端不受影响；命令行调试请使用普通 UA。

## 11. 第三轮返工发布规程（2026-10-08，候选 -12；依据 contract v3 §A 与执行任务书 §11）

本节为一次性发布 runbook；凭据仍只从 `/opt/toonflow/.env`（0600）与仓库外交接文件读取，不打印。

### 11.1 维护门（公网阻断写请求，管理走回环）
```sh
# 站点配置：/etc/nginx/sites-available/flow.xmxcode.com（启用链接在 sites-enabled/）
# 临时加入（只影响 Toonflow 站点）：
#   location / { if ($request_method !~ ^(GET|HEAD|OPTIONS)$) { return 503; } ...原有 proxy_pass... }
nginx -t && systemctl reload nginx
# 管理写操作（保存 paused=true 等）直接走回环端口，不经 Nginx：
curl -s -b /tmp/<jar> -H 'Content-Type: application/json' -H 'x-toonflow-workspace: 1' \
     -X PUT -d @/tmp/<body>.json http://127.0.0.1:3930/api/settings/save
```
- 维护门必须在切换前启用；结束后删除该规则并 `nginx -t && systemctl reload nginx`。
- 同时用**旧版现有设置**持久保存 `settings.mediaTasks.paused=true`（完整快照 + expectedRevision），等待在途项收口（无 submitting/running 且队列稳定）后停止旧容器。

### 11.2 备份（不删数据、不上传仓库）
```sh
install -d -m 700 /opt/toonflow/backup/repairExecution20261008
tar -C /opt/toonflow -czf /opt/toonflow/backup/repairExecution20261008/data-<时间>.tgz data
cp -p /opt/toonflow/.env /opt/toonflow/compose.yaml /opt/toonflow/backup/repairExecution20261008/
docker image inspect toonflow:server-20261008-11 --format '{{.Id}}' > /opt/toonflow/backup/repairExecution20261008/image-before.txt
```
- 备份写入前先确认绝对路径与剩余空间（当前 data ≈ 26 MB）；备份目录 0700，恢复前验证可读。

### 11.3 插件基线种子（三级哈希的“上次官方基线”）
旧版安装没有逐文件清单；升级前用**上一版镜像内的 build 产物**与当前 data 安装文件生成清单，避免保守迁移把未改官方文件误判为定制：
```sh
# 对 tools/nodes/providers 三组：officialHash=-11 镜像 build 文件哈希；installedHash=当前 data 文件哈希
# status：两者相同 → unchanged（下次同步自动更新）；不同 → customized（保留 + 待更新位置）
docker run --rm --entrypoint sh toonflow:server-20261008-11 -c 'sha256sum /app/build/tools/*.tool.js /app/build/nodes/*.umd.js /app/build/providers/media/*.ts'
docker exec toonflow-toonflow-1 sha256sum /app/data/tools/*.tool.js /app/data/nodes/*.umd.js /app/data/providers/*.ts
# 生成 /opt/toonflow/data/{tools,nodes,providers}/manifest.json（原子写、0600/0666 按目录权限）
```
- 种子后逐文件核对清单条数 = 实际文件数；无法核实的文件不写入清单（保持“旧基线不可信”的保守语义）。

### 11.4 候选构建与切换
1. 本机构建（G2）后上传改动文件到 `/opt/toonflow/app`；`docker build -t toonflow:server-20261008-12 /opt/toonflow/app`（唯一 tag，不复用旧 tag）。
2. 构建产物核对：镜像内 `build/nodes/*.umd.js`、`build/tools/*.tool.js`、`build/providers/media/*.ts`、`build/server/index.js` 关键特征串（本轮：`abandonUnconfirmed`、`writeBackToken`、`停止` 相关文案、`pendingUpdates`）。
3. 更新 `/opt/toonflow/compose.yaml`（image → `server-20261008-12`，补 `stop_grace_period: 60s`）与 `.env`（`TOONFLOW_BUILD_ID=server-20261008-12`）。
4. `docker compose up -d`；启动期间保持持久 `paused=true` 与原有清理开关。
5. 观察启动日志 `[插件同步] <组> revision=… {status 计数}` 与 `/api/health`（`schedulerReady/recovering/blocked/pausedTracking/recoveryErrors`）；存在恢复错误时不放行新生成与清理。
6. 确认恢复无误后：恢复开工前调度设置（`paused=false`、并发 2/2、提醒 24h，沿用开工快照），删除维护规则并 reload Nginx。

### 11.5 发布后核对与回退
- 核对：容器/镜像 ID/BUILD_ID、`data/{providers,nodes,tools}` 安装哈希 ≥ build 一致（定制差异单列）、公网入口 JS/CSS 与容器一致、登录/MCP 认证隔离、原两条视频与原项目可读、任务分母无新增收费创建、无验证 queued 遗留。
- 回退：`compose.yaml` image 改回 `server-20261008-11` + `.env` BUILD_ID 回退 + `up -d`；**保留最新 data 不恢复旧快照**。旧版不认识的新字段按缺省处理（旧版读取路径已兼容可选字段）；若旧版会忽略记录保护或重放任务，则保持维护并向前修复（契约 v3 §A/§B）。

## 12. 当前部署状态（2026-10-08 第三轮返工后）

| 项 | 值 |
| --- | --- |
| 镜像 / ID | `toonflow:server-20261008-12` / `sha256:e9afabc0c1d3…` |
| BUILD_ID / 容器 | `server-20261008-12` / `toonflow-toonflow-1`（running、healthy） |
| 数据 / 端口 | `/opt/toonflow/data → /app/data`；`127.0.0.1:3930 → 3000`（公网经 Nginx + HTTPS） |
| 停机宽限 | compose `stop_grace_period: 60s`（应用内收敛 45s + 5s） |
| 备份 | `/opt/toonflow/backup/repairExecution20261008/`（data-20261008-174529.tgz、.env、compose.yaml、image-before.txt，0700） |
| 回退 | compose `image:` 改回 `toonflow:server-20261008-11` + `.env` BUILD_ID 回退 + `up -d`；保留最新 data，不恢复旧快照 |
| 插件清单 | `data/{tools,nodes,providers}/manifest.json`（逐文件 officialHash/installedHash/status；定制保留在 `pendingUpdates/`） |
| 运行配置 | `paused=false`、生成/下载并发 2/2、提醒 24h；五类清理全关（2/2/2/30/2） |
| 维护门 | 已撤（发布时临时启用，公网非 GET → 503；恢复后 `nginx -t` + reload 正常） |

发布规程见 §11（第三轮返工发布规程）；本轮实际执行与核对结果见 `docs/executionProgress.md` 与 `docs/executionAcceptance.md` 的第三轮章节，证据在 `toonflowHandoff/evidence/repairExecution20261008/run1/`。

## 14. 当前部署状态（2026-10-08 第四轮收口后，镜像 -14）

| 项 | 值 |
| --- | --- |
| 镜像 / ID | `toonflow:server-20261008-14` / `sha256:b0653d6819e3f916cb85c866c2268418af2890e068d46d901f8fc575572e1c42` |
| BUILD_ID / 容器 | `server-20261008-14` / `toonflow-toonflow-1`（running、healthy、restarts=0） |
| 数据 / 端口 | `/opt/toonflow/data → /app/data`；`127.0.0.1:3930 → 3000`（公网经 Nginx + HTTPS） |
| 停机宽限 | compose `stop_grace_period: 60s`（应用内 45s 单一截止；-14 实测 `docker stop -t 60` ExitCode=0） |
| 备份 | `/opt/toonflow/backup/repairExecution20261008-r14/`（data-20261008-155110.tgz、.env、compose.yaml、image-before.txt，0700） |
| 回退 | compose `image:` 改回 `toonflow:server-20261008-13` + `.env` BUILD_ID 回退 + `up -d`；保留最新 data，不恢复旧快照 |
| 插件清单 | `data/{tools,nodes,providers}/manifest.json`；-14 启动同步 tools {unchanged:8}、nodes {unchanged:7, updated:1}、providers {unchanged:5}；21/21 文件与镜像 build 一致 |
| 运行配置 | `paused=false`、生成/下载并发 2/2、提醒 24h；五类清理全关（2/2/2/30/2） |
| 维护门 | 已撤（发布时临时启用，公网非 GET → 503；撤除后公网 POST 恢复，登录错误口令 401） |
| 本轮新增接口 | `POST /api/cleanup/protections`（保护表故障/范围保护的显式恢复入口，需认证 + 核对原因；无故障时幂等 no-op） |

收口轮次（互审修复）的发现、处置与复核见 `docs/callChainCrossReview.md`；发布与实测记录见 `toonflowHandoff/evidence/repairExecution20261008/run2/release-14.json` 与 `docs/executionAcceptance.md` 第四轮收口章节。

## 13. 当前部署状态（2026-10-08 第四轮返工后，镜像 -13）

| 项 | 值 |
| --- | --- |
| 镜像 / ID | `toonflow:server-20261008-13` / `sha256:df73e3eb2e14f35b4ca31d51d56e923419d8970c6f54efa736dee37517d59567` |
| BUILD_ID / 容器 | `server-20261008-13` / `toonflow-toonflow-1`（running、healthy） |
| 停机宽限 / 应用预算 | compose `stop_grace_period: 60s`；应用内单一全局预算 45s（封门→在途 HTTP→MCP/清理→媒体排空→写队列），日志含各阶段与 `drainOutcome` |
| 停机门 | 新请求返回 503 ESTOPPING；已受理在途请求继续完成关键落盘后才 close（Bun close 会断开在途连接） |
| 备份 | `/opt/toonflow/backup/repairExecution20261008/`（data-*.tgz、.env、compose.yaml、切换前镜像 ID） |
| 回退 | compose `image:` 改回 `toonflow:server-20261008-12` + `.env` BUILD_ID 回退 + `up -d`；保留最新 data |

## 15. 当前部署状态（2026-10-09 第五轮返工后，镜像 -16）

| 项 | 值 |
| --- | --- |
| 镜像 / ID | `toonflow:server-20261008-16` / `sha256:a0e851d002ca8427972ec521b075bae9e3d7f79f57febef50ef2442a0bb441d0` |
| BUILD_ID / 容器 | `server-20261008-16` / `toonflow-toonflow-1`（running、healthy） |
| 数据 / 端口 | `/opt/toonflow/data → /app/data`；`127.0.0.1:3930 → 3000`（公网经 Nginx + HTTPS） |
| 停机宽限 | compose `stop_grace_period: 60s`；应用内单一 45s 预算，媒体阶段先预留 abort 宽限（默认 5s）与最终写保留（默认 8s），清理阶段另有外层预算上限 |
| 保护/归属就绪 | 生成派发与同步生成入口共用 `fileRecordsStoreHealthSnapshot()` 判据；保护未知时阻断新收费创建并给出 `dispatchBlockReason`；显式恢复入口 `POST /api/cleanup/protections`（认证 + 核对原因，可带 paths） |
| 编辑占用 | 身份 = 登录摘要 + 页面实例 pageId（含碰撞重分配）+ 每次租约实例 leaseId + 目录 + 路径；释放必须带 versions 或 leaseId（无身份释放只作用于 legacy）；停机写入保守解除时间 |
| 备份 | `/opt/toonflow/backup/repairExecution20261008-r16/`（data-20261008-180552.tgz、.env、compose.yaml、image-before.txt，0700） |
| 回退 | compose `image:` 改回 `toonflow:server-20261008-14` + `.env` BUILD_ID 回退 + `up -d`；保留最新 data，不恢复旧快照；镜像 -1…-14 保留 |
| 发布后状态 | 21/21 插件文件与镜像 build 一致；13 批 36 cancelled/2 failed/5 succeeded 与两条成片 SHA 不变；`paused=false`、五类清理全关；`protectionReady=true`（发布后已按核对依据显式恢复） |
| 维护门 | 已撤（发布时临时启用，公网非 GET → 503；撤除后公网 POST 恢复，登录错误口令 401） |

第五轮的问题清单、处置与验证范围见 `docs/executionAcceptance.md` 第五轮章节与 `docs/callChainCrossReview2.md`；证据与命令台账在 `toonflowHandoff/evidence/repairExecution20261008/run3/`。

## 16. 当前部署状态（2026-10-09 第五轮验收收口后，镜像 -19）

| 项 | 值 |
| --- | --- |
| 镜像 / ID | `toonflow:server-20261008-19` / `sha256:ddea4904c9ddc7cd6da99ff729a091b5dafcd5e0e7454f1059482b3a2c54cdb1` |
| BUILD_ID / 容器 | `server-20261008-19` / `toonflow-toonflow-1`（running、healthy） |
| 数据 / 端口 | `/opt/toonflow/data → /app/data`；`127.0.0.1:3930 → 3000`（公网经 Nginx + HTTPS） |
| 新创建准入 | 后台调度 / 旧同步 HTTP / Agent / 节点 / **供应商调试台** 共用 §N.1 统一判据；`health.creationReady`（含全局暂停）与 `schedulerReady`（恢复完成，不含暂停）分工，`dispatchBlockReason` 可读 |
| 编辑租约 | 释放必须同时匹配 leaseId 与逐路径 version；每 hold 不复用出网身份；C 在 create/renew 2xx 前持久化保护下限与版本代次（含旧格式文件缺 `generation` 的保守迁移） |
| 改名事务 | 任务锁→路径锁固定序；发现与 outputs 发布同临界区；可能已发布写入纳入补偿；阻断被实际消费（阻断类 EPARTIAL 不建范围保护、保留精确重试路径） |
| 停机预算 | 45s 单一截止内显式分配**目标值**（HTTP≤26999ms、MCP≤2000ms、清理≤2000ms+外层上限 1500ms、媒体目标 abort 5000ms + 最终写 8000ms）；实际值按当刻剩余反算、可能压缩并由 `drainOutcome`（abortGrace 请求/可用/实际、`abortGraceTruncated`、`finalWriteAvailableMs`、`totalMs`）如实上报；最坏阶段上限叠加时媒体实际约 12.5s（第六轮验收 §6.1 口径） |
| 插件 / 公网 | 21/21 插件与镜像 build 一致；入口 `assets/index-BPjVkrCs.js`（`9cb97224…`）公网
| 备份 / 回退 | `/opt/toonflow/backup/repairExecution20261009-r19`；回退=改 image 回 `toonflow:server-20261008-16` + `.env` BUILD_ID + `up -d`，镜像 -1…-16 保留 |
| 运行限制 | FFmpeg 等待上限「退出未确认」时保持占用且不投递终止事件——需人工巡检残留进程（不宣称必然收敛）；清理阶段 finalize 有外层预算上限，超时后后台仍尽力写盘 |

## 17. 当前部署状态（2026-10-09 补做与再发布后，镜像 -20）

| 项 | 值 |
| --- | --- |
| 镜像 / ID | `toonflow:server-20261008-20` / `sha256:232811f1a0d679839c6704a4c704ff2d768bab4f87d52cee4dcb8eeb82d966aa` |
| BUILD_ID / 容器 | `server-20261008-20` / `toonflow-toonflow-1`（running、healthy） |
| 相对 -19 的差异 | 仅 `utils/fileRecords` 的单条写入「可能已发布 → 按快照重写」口径（§N.2）及其断言；插件与公网入口指纹不变 |
| 发布后核对 | 21/21 插件与镜像 build 一致（nodes 全部 unchanged）；13 批 36 cancelled/2 failed/5 succeeded；两成片 SHA 不变；入口 `index-BPjVkrCs.js`（`9cb97224…`）公网一致；`readiness.ok=true`、`paused=false`、`schedulerReady=creationReady=protectionReady=cleanupReady=true` |
| 备份 / 回退 | `/opt/toonflow/backup/repairExecution20261009-r20`；回退=改 image 回 `toonflow:server-20261008-19` + `.env` BUILD_ID + `up -d`；镜像 -1…-16、-19 保留 |
| 动态边界证据 | 停机阶段耗尽边界（长作业在途）：媒体阶段 32100ms、abortWaitedMs=103、abortGrace 可用 5000ms、finalWriteAvailable 12897ms、ExitCode 0——见 `evidence/repairExecution20261008/run3/fifthRound_verification.json` 的 `t02BoundaryDynamic` |

## 18. 当前部署状态（2026-10-09 第六轮收尾后，镜像 -22）

| 项 | 值 |
| --- | --- |
| 镜像 / ID | `toonflow:server-20261008-22` / `sha256:a5ae52faacbbe0c6c95c7a9dd48b48470b9735acbe8bcc90732094452d13c4c9` |
| BUILD_ID / 容器 | `server-20261008-22` / `toonflow-toonflow-1`（running、healthy） |
| 相对 -20 的差异 | T15 收尾：移动前持久迁移意图（保护表 `relocationIntent`，双端）、协调路径延后解除（`deferIntentRelease`，Q 在 outputs 落盘后清除）、同事务身份精确恢复、重启消费与清理占用、三态文案；另有 rename 路由/agent/MCP 的 warning 透传 |
| 发布后核对 | 21/21 插件与镜像 build 一致（全部 unchanged）；13 批 36 cancelled/2 failed/5 succeeded；两成片 SHA 与公网入口 `index-BPjVkrCs.js`（`9cb97224…`）不变；`readiness.ok=true`、`unfinishedRelocations` 为空 |
| 备份 / 回退 | `/opt/toonflow/backup/repairExecution20261009-r22`；回退=改 image 回 `toonflow:server-20261008-20` + `.env` BUILD_ID + `up -d`；镜像 -1…-20 保留 |
| 动态验证 | 见 `evidence/repairExecution20261008/run3/sixthRound_verification.json`（7 场景 + 未动态清单）与 `run3/commandResults.jsonl` 末 12 行 |

## 19. 当前部署状态（2026-10-09 第七轮 T15 R1–R4 收口后，镜像 -23）

| 项 | 值 |
| --- | --- |
| 镜像 / ID | `toonflow:server-20261008-23` / `sha256:13312184f5f32a7fcca9e2bac33624843cb5542d019d6cd21e6867774c112081` |
| BUILD_ID / 容器 | `server-20261008-23` / `toonflow-toonflow-1`（running、healthy；created/started 2026-10-09T05:16:23Z = CST 13:16:23，restarts=0） |
| 相对 -22 的差异 | 契约 §P 冻结：**P.1 参与集合**（`relocationIntent.participants`，恢复集合=持久∪发现）、**P.2 活动边界与唯一解除时点**（Q 运行时判定 + 持久未收敛；协调路径正反两向 C 均不自行解除；显式恢复命中活动事务 409 EBUSY）、**P.3 原意图身份与写保护**（`verifyRelocationIntentConsistency`：方向/尺寸/内容 sha256（≤32MiB）/未搬动时 mtime；双端保护固定不随迁移收缩；普通覆盖写统一拦截：写路由 ×2 + MCP writeBinary + Agent writeFile + generation 落盘 + scheduler 输出落盘）、缝3 源缺失+目标可信身份的严格续做、**P.4 清除三态**（已确认清除/清除未确认/写入失败保护仍在）、**P.5 提示出口**（HTTP 成功与失败、MCP 失败进入可见文本、Agent 宿主日志级如实、网页 `notifyRelocationWarning`/`notifyRelocationFailure` 消费） |
| 发布后核对 | 21/21 插件与镜像 build 逐文件一致（tools 8/nodes 8/providers 5 全部 unchanged）；13 批 43 条 36 cancelled/2 failed/5 succeeded（无新增）；两成片 SHA 不变；公网入口 `index-DDSkC3mS.js`（`080dbefc…`）与容器一致；`readiness.ok=true`；公网登录 200/退出 200；paused=false、并发 2/2、提醒 24h、五类清理全关 |
| 备份 / 回退 | `/opt/toonflow/backup/repairExecution20261009-r23`（data-20261009-1320.tgz 21,629,007 bytes + .env + compose.yaml + image-before.txt）；回退=改 image 回 `toonflow:server-20261008-22` + `.env` BUILD_ID + `up -d`；镜像 -22/-20 保留；保留最新 data（不恢复快照） |
| 动态验证 | 见 `evidence/repairExecution20261008/run3/seventhRound_verification.json`（S-A R2 写保护/版本核对、S-B R3 多任务收敛+409 忙、S-C R1a 发布失败自然链+重启保护+显式核对、S-D 源缺失严格续做正/负例、S-E MCP 出口；含未动态清单与残余边界） |
| 已知残余边界 | 硬歧义状态（目标端在但身份不可确认/两端都在/均不在/不可判读）保留保护 + 人工核对；EIDENTITY 拒绝且从未移动时按平凡收敛释放旧意图（数据一致，属策略边界）；`unfinishedRelocations` 按任务阻断投影（每任务一条），仅意图状态由 `readiness.relocationIntents` 诊断 |
