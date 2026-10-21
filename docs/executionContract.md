# Toonflow 服务器二改 · 冻结契约（G0）

版本：2026-10-08 v1，由主控冻结；变更须主控更新本文并通知全部负责人。
相关文档：`docs/deepseekExecutionPlan.md`（任务书）、`docs/serverDeploymentPlan.md`（审计）。
本文件不含任何真实密钥与凭据。

## 0. 基线事实（2026-10-08 实测）

- 源码无 `.git`；仓库外基线：`toonflowHandoff/baseline/source-20261008/`（747 文件哈希清单 `source-baseline-sha256.txt`）。
- 桌面供应商实测哈希与交接记录一致：`xmxImage.ts` = B76EC508…39B0C（2.0.1），`dolaVideo.ts` = 7D0026D3…98BA（2.0.0）。只读副本在 `toonflowHandoff/baseline/desktop-providers/`。
- 本机：Bun 1.3.14、Node 24.15.0、Windows。依赖已按 `bun install --frozen-lockfile` 安装。
- 服务器：Ubuntu 24.04.4、4 核、7.7G 内存（可用约 3G）、根盘可用 155G；Docker 29.1.3、Compose v5.5.0、Nginx 1.24.0；**3000/3930/8790 未监听**；`/opt/toonflow` 未占用。基线证据：`toonflowHandoff/evidence/serverBaseline20261008.txt`。
- 服务器上存在多套运行中的应用（guanmu、open-ai-canvas、new-api、cli-proxy-api、grok2api 等）与 14 个 Nginx 站点：本轮**不得**停止、修改或接管其中任何一项。

## 1. 目录与命名

- 新增业务目录/文件一律小驼峰，例如 `apps/server/src/utils/mediaTasks/`、`auth/`、`cleanup/`、`fileRecords/`。
- 数据目录下新增子目录：`mediaTasks/`（任务与快照）、`fileRecords/`（文件归属）。
- 不新增任何测试文件（`.test.ts`/`.spec.ts`/临时测试程序/mock 服务），不新增测试框架。验证只用 typecheck、build、真实 HTTP/MCP、浏览器。

## 2. 任务接口契约（冻结）

HTTP 路径（由路由文件自然生成）：

| 方法 | 路径 | 文件 |
|---|---|---|
| POST | `/api/ai/media/tasks/submit` | `apps/server/src/routes/ai/media/tasks/submit.ts` |
| GET | `/api/ai/media/tasks/get` | `apps/server/src/routes/ai/media/tasks/get.ts` |
| POST | `/api/ai/media/tasks/cancel` | `apps/server/src/routes/ai/media/tasks/cancel.ts` |

服务函数（HTTP 与 MCP 共用，禁止绕过鉴权伪造 HTTP）：

```ts
type MediaTaskState = "preparing" | "queued" | "submitting" | "running" | "downloading" | "succeeded" | "failed" | "cancelled" | "unknown";

type MediaTaskSubmitItem = {
  itemKey: string;            // 1-128 字符，同一 batchKey 内唯一
  request: unknown;           // image/video/audioGenerationSchema 解析后的请求（不含 directory）
  canvasId?: string;          // 可选绑定
  nodeId?: string;
};

// 主入口：apps/server/src/utils/mediaTasks/index.ts
export async function submitMediaTasks(input: {
  directory: string;          // 绝对路径；经 resolveWorkspace 校验
  batchKey: string;           // 16-128 字符；客户端首次发送前生成并持久保存
  mediaType: "image" | "video" | "audio";
  items: MediaTaskSubmitItem[]; // 单次传输 ≤ 50 条（传输分批，不是业务上限）
}, options?: { signal?: AbortSignal }): Promise<{
  batchId: string;
  items: { itemKey: string; status: "accepted" | "existing" | "rejected"; taskId?: string; reason?: string }[];
}>;

export async function getMediaTasks(query: {
  directory: string;
  taskIds?: string[];         // 与 batchId 二选一
  batchId?: string;
  cursor?: string;            // batchId 分页游标（createdAt+taskId）
  limit?: number;             // 默认 50，最大 200
}): Promise<{
  tasks: MediaTaskSummary[];  // 字段见下；不含 Key/Base64/签名地址
  nextCursor?: string;
  counts: Partial<Record<MediaTaskState, number>>;
}>;

export async function cancelMediaTasks(input: {
  directory: string; taskIds?: string[]; batchId?: string;
}): Promise<{ items: { taskId: string; state: MediaTaskState; cancellationRequested: boolean; upstreamCancellation?: boolean }[] }>;
```

`MediaTaskSummary` 每条字段（冻结）：`taskId, batchId, itemKey, mediaType, state, providerId, modelId, createdAt, updatedAt, completedAt?, outputs: { path, mimeType, mediaType }[]（工作区相对路径）, error?（已去敏分类文案）, cancellationRequested, upstreamCancellation?, canvasId?, nodeId?`。

持久记录（内部，`<data>/mediaTasks/batches/<batchId>.json`）额外含：`idempotencyKey`（sha256(规范化目录 + \0 + batchKey + \0 + itemKey)）、`fingerprint`（sha256(规范化请求 JSON，含快照引用)）、`request`、`inputSnapshots`（见 §4）、`providerRevision`、`upstreamId?`。

幂等规则（冻结）：
- 同 idempotencyKey + 同 fingerprint → `existing` 返回原 taskId；
- 同 idempotencyKey + 不同 fingerprint → `rejected`（冲突）；
- 新键 → 持久化受理记录（`preparing`）后返回 `accepted`；
- 受理响应与整批写入分开：先写全部受理记录再返回；请求中断时已持久化项仍可查回。

状态机（单调，除 cancel 语义外不可回退）：
`preparing → queued → submitting → running → downloading → succeeded`；失败 `failed`；`cancelled`（未提交上游或上游确认取消）；`submitting` 中断且无 upstreamId → `unknown`（**不自动重提**）。旧轮询不得把 `cancelled/succeeded` 覆盖回 `running`（更新须比对状态版本号）。

调度（冻结）：
- 单进程单实例调度器；生成并发默认 2、下载并发默认 2（`settings.mediaTasks.generationConcurrency / downloadConcurrency`，正整数）。
- `settings.mediaTasks.paused === true` 时：不发起新的上游提交/下载，queued 保持 queued；查询/取消始终可用。隔离环境首次运行暂停，验收后放行正式任务。
- 429/Retry-After：按退避重试；只对查询/下载自动重试，提交阶段不自动重试（防重复扣费）。区分提交与查询/下载的连接错误。

## 3. 供应商异步契约（冻结，`packages/providers/types.d.ts`）

在 `ProviderDefinition` 增加三个可选方法（名字冻结；未实现者由任务层走同步路径）：

```ts
interface ProviderMediaTaskState {
  status: "running" | "succeeded" | "failed" | "cancelled";
  assets?: MediaAsset[];
  error?: string;
}
/** 可选异步任务能力；实现者必须提供 submitMedia 与 queryMedia 成对。 */
submitMedia?(this: ProviderContext, request: ImageRequest | VideoRequest | AudioRequest): Promise<{ upstreamId: string }>;
queryMedia?(this: ProviderContext, upstreamId: string): Promise<ProviderMediaTaskState>;
cancelMedia?(this: ProviderContext, upstreamId: string): Promise<{ confirmed: boolean }>;
```

- 任务层优先用异步能力：`createMediaTask` → 保存 upstreamId（立即持久化）→ 轮询 `queryMediaTask` → `downloading` 用受限下载。
- 无异步能力（如 xmxImage 同步生成）：后台执行 `generateImage`（无上游 ID）；执行中进程死亡 → `unknown`，不自动重提。
- `providerRevision`（供应商文件 sha256）记录到任务；恢复时若 provider 文件被替换为不同 revision → 该任务标 `unknown` 并提示人工确认（不跨供应商继续查询）。
- 供应商内部禁止把上游密钥写到日志；错误信息过 `tool.errorMessage` 去敏。

## 4. 输入快照与结果下载（冻结）

- 提交时（`preparing`）把参考媒体复制为快照：`<data>/mediaTasks/inputs/<sha256 前2位>/<sha256>.<ext>`（内容寻址去重），任务记录保存快照路径 + 原始工作区相对路径。执行只用快照，排队期间用户修改/删除原文件不影响任务输入。
- 快照字节预算：单请求参考媒体总字节 ≤ 200MB（可配置 `settings.mediaTasks.referenceBudgetMb`）；单文件 ≤ 100MB 不变。
- 结果下载统一走受限流式：预检 Content-Length、逐块计数、超限/取消立即断流释放；单文件 ≤ 100MB。
- 下载 URL 解析：仅当 host 与供应商 `apiUrl` host 完全一致才附加供应商 Authorization；跨来源不带密钥；拒绝非 http(s)、含凭据 URL、不可信重定向（`redirect: "manual"` 或校验最终 URL host）。
- 结果 MIME/可读性：以文件头真实签名为准（R30）。视频/图片头无法识别且 fallback 为 `video/*`、`image/*` 时**拒绝保存**（防 HTML/JSON 错误页伪装）。音频按现有识别放宽。
- 多结果逐项保存：某个失败不删除已成功落盘的文件；任务层逐项记录（`outputs` 已成功项 + `error` 失败项）。

## 5. 文件归属与清理契约（冻结）

`apps/server/src/utils/fileRecords/index.ts`：

```ts
type FileSourceKind = "generated" | "original" | "cache";
type FileMediaKind = "text" | "image" | "video" | "audio" | "unknown";
type FileRecord = {
  id: string;                 // 随机
  path: string;               // 工作区内绝对路径（realpath 后）
  directory: string;          // 工作区根
  sourceKind: FileSourceKind;
  mediaKind: FileMediaKind;
  version: { size: number; mtimeMs: number };  // 删除前重查校验
  createdAt: string; updatedAt: string; completedAt?: string;
  cleanedAt?: string;         // 清理标记（可重入）
  refs: string[];             // 引用方标识（task:<taskId>、node:<nodeId> 等）
};
export async function registerFileRecord(input: {...}): Promise<FileRecord>;
export async function touchFileRecord(path: string, patch: { refs?, updatedAt? }): Promise<void>;
export async function removeFileRecord(path: string): Promise<void>;
export async function listFileRecords(filter?: { directory?, sourceKind? }): Promise<FileRecord[]>;
```

- 记录持久化：`<data>/fileRecords/records.json`，writeAtomic + durable；索引内存缓存，启动重建。
- 登记入口（只此三类，禁止按扩展名/mtime 扫描推断）：
  1. 媒体生成落盘（任务层与旧同步工具 `generateMedia`）→ `generated` + mediaKind；
  2. 资产上传 `routes/assets/save.ts` → `original`；
  3. 工作区文件写入 `routes/workspaces/files/write.ts` 携带显式头 `x-toonflow-file-kind: generatedText | generatedImage | generatedVideo | original`（缺省不登记）。文本节点保存内容时前端带 `generatedText`。
- 清理器 `apps/server/src/utils/cleanup/index.ts`：
  - 设置结构（冻结）：
    ```ts
    settings.cleanup = {
      text:     { enabled: false, days: 2 },
      image:    { enabled: false, days: 2 },
      video:    { enabled: false, days: 2 },
      original: { enabled: false, days: 30 },
      cache:    { enabled: false, days: 2 },
    };
    ```
  - 校验：`enabled` 必须布尔；`enabled=true` 时 `days` 必须为 1-3650 整数，留空/0/负数/非整数 → 保存 400。未开启时天数仍须为合法整数（预填默认值）。
  - 类别映射：text→generated+mediaKind text；image→generated+image；video→generated+video；original→original 全部；cache→cache 全部。
  - 候选条件：`now - updatedAt ≥ days×24h` 且 `refs` 中无活跃占用 且 文件存在且 stat 与 `version` 一致 且 **同一物理文件全部记录均满足各自类别条件**（多归属全保留）。
  - 执行：每小时一批（单实例 setInterval，启动后首轮延迟 60s）；先写 `cleanedAt` 意图 → 删除 → 更新记录；失败逐项记录并下轮重试；不跟随符号链接；路径必须经 `resolveWorkspacePath` 重校验。
  - 未知/无记录文件永不自动清理；项目画布/配置/插件/任务记录/幂等记录/快照不在清理范围。
  - 路由：`POST /api/cleanup/preview`（返回各类别候选数量与总字节）、`GET /api/cleanup/status`（lastRunAt、lastFreedBytes、lastFailures、各类别开关与候选数）。
- 前端：设置面板 `components/settings/panels/storageCleanup/index.vue`，五组独立开关+数字天数（默认按上表），提示文案（过期永久删除、原始资料删除后需重新上传、仅服务器受管文件）。首次开启或缩短期限时先调 preview 展示受影响数量再进行保存。

## 6. 认证契约（冻结）

新增（均为新文件）：

- `apps/server/src/utils/auth/index.ts`
  - `initializeAuth(dataDirectory)`：读/建 `<data>/auth.json`（0600）`{ username, passwordHash, createdAt, updatedAt }`；密码哈希用 `Bun.password.hash`（argon2id）。首次初始化密码来源：环境变量 `TOONFLOW_ADMIN_PASSWORD`（仅在 auth.json 不存在时使用，且不落盘明文）；无环境变量且无 auth.json → 启动日志提示未初始化，登录接口返回"未初始化管理员"。
  - 会话：内存 `Map<token, { username, createdAt, lastSeenAt }>`；token = 32 字节随机 hex；TTL 7 天滑动；`getSession/destroySession`。
  - 登录限速：同 IP+用户名 15 分钟窗口内失败 ≥5 次 → 429；成功清零。
  - 中间件 `createAuthGate()`：挂在 `app.use("/api", ...)`，白名单：`/auth/login`、`/auth/status`；其余 `/api/**` 未认证 → 401 `{code:401,...}`（在 body 解析前拒绝）。
- `apps/server/src/routes/auth/login.ts`（POST）、`logout.ts`（POST）、`status.ts`（GET）。
  - login：`{username, password}` → 校验 → `Set-Cookie: toonflowSession=<token>; HttpOnly; SameSite=Lax; Path=/`（HTTPS 或 `TOONFLOW_COOKIE_SECURE=1` 时加 Secure）→ `{ username }`。
  - status：`{ authenticated, username?, authRequired }`（`authRequired=false` 时不鉴权）。
- 启用条件：`createApp({ auth: true })`。独立入口 `apps/server/src/index.ts` 传 `auth: true`，除非 `TOONFLOW_AUTH=0`。桌面端（`@toonflow/server/app`）不传 → 认证关闭，桌面行为不变。
- 管理接口权限（R12）：`apps/server/src/utils/workspace/index.ts` 新增 `canManageRequest(req)` = `isLocalWorkspaceRequest(req) || 已认证管理员会话`；原 35 处 `isLocalWorkspaceRequest` 调用点统一替换（由主控批量执行）。工作区解析边界不变（服务器仍限 `<data>/workspaces`）。
- 前端：
  - `apps/web/src/pages/login/index.vue`（新）：最小账号/密码/登录/错误提示；成功后 `location.reload()`。
  - `main.ts`：挂载前先 `GET /api/auth/status`；`authRequired && !authenticated` → 挂载登录页；否则走现有 `loadSettings()` 流程。任何情况下不得为显示登录页而公开 `/api/settings/get`。
  - 401 统一处理：axios 默认实例 + workspaceFiles 实例加响应拦截器；直接 fetch 调用点（mcpControl、agent 流等）单独处理；401 → 保留未保存内容并提示重新登录（不自动重放生成/删除请求）。
- MCP：沿用现有独立 Bearer token（`settings.mcp.*`）；服务器导入 `serverMcpProposed.token`。MCP 不经过 Cookie 认证。

## 7. 设置版本契约（冻结）

- `conf` 顶层新增 `settingsMeta: { revision: string, updatedAt: string }`；revision = sha256(JSON.stringify(settings))（每次保存后重算）。
- `GET /api/settings/get`：响应头 `x-toonflow-settings-revision: <rev>`（保持原 body 结构不变）。
- `PUT /api/settings/save`：body 可带 `expectedRevision`（可选，旧客户端不带则不校验）；不匹配 → 409 `{code:409, data:{ currentRevision }}`；成功响应头返回新 revision。
- 服务端自动模型刷新（refreshProviderModels）后统一重算 revision。
- 前端 settings store：维护 `revision`；保存携带 `expectedRevision`；409 → 抛冲突，本地修改保留不覆盖、不自动重试，提示用户（提供"重新加载设置"动作）。渲染/保存语义不改为部分合并。

## 8. MCP 工具契约（冻结）

新增（`apps/server/src/utils/mcp/tools.ts`）：
- `submitVideoTasks`：参数 `{ directory, batchKey, mediaType, items }`（与 §2 对齐，items ≤ 50）。
- `getVideoTasks`：`{ directory, taskIds? , batchId?, cursor?, limit? }`。
- `cancelVideoTasks`：`{ directory, taskIds?, batchId? }`。
三者直接调用 `utils/mediaTasks` 服务函数（服务端内直调，不经网页、不占控制槽）。

控制类改进（R16/R17，F 负责）：
- 控制消息新增 `readOnly?: boolean`（由执行方从节点/画布工具元数据判定：全部目标函数只读 → true）；`readOnly` 为 true 时网页**不得**执行 `flushSave`/全图保存；真正变更保留必要保存。
- 控制消息新增 `expectedCanvasId?: string`；网页在执行前校验当前画布 id 一致，不一致返回明确拒绝错误（不执行、不误写）。
- 任务受理与画布保存分别反馈：受理成功即返回 taskId，画布保存失败不推翻受理事实。

## 9. 部署契约（冻结）

- 目录 `/opt/toonflow/`（新建，专属）；Compose 项目名 `toonflow`；容器名 `toonflow`。
- 镜像 `toonflow:server-<yyyymmdd-N>`；基础镜像沿用 `oven/bun:1.3.14`（与 lockfile `packageManager: bun@1.3.14` 一致；桌面 1.4.0 不做迁移依据）。理由：lockfile 与依赖按 1.3.14 锁定，本轮以实际构建+运行验证为准。
- 端口 `127.0.0.1:3930 → 容器 3000`；不向公网裸露业务端口。
- 卷：`/opt/toonflow/data → /app/data`（bind 或 named volume 二选一，部署时定并在文档记录）。
- 运行时注入（不 COPY 进镜像）：`TOONFLOW_ADMIN_PASSWORD`（首启初始化）、`TOONFLOW_AUTH=1`、`TOONFLOW_BUILD_ID`（发布标识，同时作为 pluginRevision）。
- 首次启动导入 `serverSettingsImport`（仅受控合并：自定义文本供应商、媒体供应商配置），**不覆盖**认证/清理/调度新配置；`settings.mediaTasks.paused=true`、清理默认全 off、`settings.mcp` 导入服务器专用 token（enabled 由部署步骤显式开启）。
- 回退：保留前一镜像 tag；`docker compose down`（仅本项目）后改 tag 启动；不删除数据卷。
- 域名缺失：先用 `ssh -L 3930:127.0.0.1:3930` 隧道本机验收；公网阶段列为外部输入缺口。

## 10. 文件所有权（冻结）

| 角色 | 独占文件（新建为主） |
|---|---|
| I 主控 | `apps/server/src/app.ts`、`index.ts`、`utils.ts`、`src/utils/workspace/index.ts`（含 35 调用点替换）、`src/routes/workspaces/files/{write,read}.ts`、`src/utils/media/generation.ts`、`packages/providers/types.d.ts`、`packages/file/**`、`apps/server/src/routes/settings/*.ts`、`src/utils/mcp/runtime.ts`（会话回收接线） |
| P 供应商 | `packages/providers/src/media/xmxImage.ts`（新）、`dolaVideo.ts`（新）、`apps/server/src/utils/media/assetBytes.ts`（新，供 Q 使用） |
| Q 任务 | `apps/server/src/utils/mediaTasks/**`（新）、`apps/server/src/routes/ai/media/tasks/**`（新）、`packages/tools/mediaGeneration/src/**`（任务版工具适配） |
| A 登录 | `apps/server/src/utils/auth/**`（新）、`apps/server/src/routes/auth/**`（新）、`apps/web/src/pages/login/**`（新）、`apps/web/src/main.ts`、`apps/web/src/stores/settings.ts` |
| F 前端/MCP | `apps/web/src/pages/workspace/**`（index.vue、canvas/index.vue、useCanvasTools.ts）、`apps/web/src/lib/mcpControl.ts`、`packages/nodeScaffold/src/**`、`packages/nodes/videoGenerationNode/src/**`、`packages/mcp/src/index.ts`、`apps/server/src/utils/mcp/{tools,control}.ts`、`apps/server/src/agent/bridge/canvas.ts`、`packages/tools/canvas/src/**` |
| C 清理 | `apps/server/src/utils/cleanup/**`、`fileRecords/**`（新）、`apps/server/src/routes/cleanup/**`（新）、`apps/web/src/components/settings/index.vue`、`components/settings/panels/storageCleanup/**`（新） |
| D 部署 | `Dockerfile`、`compose.yaml`、`docs/deployment*.md`、服务器 `/opt/toonflow/**` |
| V 验收 | 只读；证据写 `toonflowHandoff/evidence/` 与 `docs/executionAcceptance.md` |

规则：不改桌面安装（`D:/Program Files/toonflow/stable` 只读）；不动其他应用；两人不得同时写同一文件；共享文件（app.ts/utils.ts/router.ts/types.d.ts）主控集成；`router.ts` 只由 `bun run routes` 生成。

## 11. R 项映射（本轮处理）

必修（直接相关）：R01 R02 R03 R04 R05 R06 R07 R08 R09 R10 R11 R12 R13 R14 R15 R16 R17 R18 R19 R20 R22 R28 R30。
第二批（尽量，小改）：R21（subAgent 并发上限）、R23（FFmpeg 并发信号量）、R26（画布识别完整解析）、R27（MCP 会话 TTL/容量）、R31（用户模型限制优先）。
条件项（本轮不提供对应模式，保持原状并记录）：R24 R25 R29。
误报复核：如复核为误报需在验收文档给证据，不为凑数改代码。

## 12. 安全红线（全员）

1. 真实 Key/密码只从 `toonflowHandoff/deploymentSecrets.json` 或运行时环境变量读取；**禁止**输出到聊天/日志/文档/Git/镜像/命令行参数。
2. 不改桌面安装与桌面进程；不改服务器其他应用、其他 Nginx 站点、其他数据卷。
3. 未知（unknown）任务绝不自动重提；不为验证凑收费调用；主控统一计数收费请求（首轮视频 ≤2、图生图 ≤2）。
4. 不新增测试文件/测试专用接口；验收只用真实产品路径 + 人工数据操作（如时间回拨仅在临时 data）。
5. 发现越权、密钥泄漏、越界删除、重复扣费风险 → 立即停止相关动作、保留证据、报告主控。

---

# 本轮返工契约 v2（2026-10-08，依据 docs/independentAcceptance.md F01–F20 与 docs/longRunningVideoPolicy.md）

保留以上全部历史条款；本节为返工轮新增，冲突处以本节为准。G0 现场核实（2026-10-08）：容器 toonflow-toonflow-1 / 镜像 toonflow:server-20261008-7 / healthy；任务 5 succeeded + 16 cancelled、无 active/unknown；paused=false、并发 2/2；五类清理关闭；customProviders 仅 wb（4 模型）；无其他执行窗口活动。

## A. 任务状态与跟进语义（冻结）

主状态沿用 `preparing/queued/submitting/running/downloading/succeeded/failed/cancelled/unknown`。**unknown 是待核对状态，不是可遗忘终态**：无上游 ID 的 unknown 不自动提交、不丢关联；有 ID 的任务不因一次查询失败滑入不可恢复终态。

任务记录新增跟进字段（服务端实现，F 端只读展示）：
```ts
trackingStatus?: "active" | "blocked" | "paused";   // 缺省视为 active（旧记录兼容）
waitingReason?: string;                              // blocked/paused 的可读原因（去敏）
lastQueryAt?: string;                                // 上次查询尝试时间
lastQuerySucceededAt?: string;                       // 上次查询成功时间
lastUpstreamState?: string;                          // 上游最近状态原文
resultReadyAt?: string;                              // 上游报成功、结果可取时间
```

迁移规则：旧记录无 trackingStatus 时，`running/downloading/queued/submitting/preparing` → active；`unknown` 保留原样（待核对，不视为失败）。

错误分类（冻结，禁止用 HTTP 状态码一概决定生成失败）：
- 查询网络错误 / 超时 / 5xx / 429 → 保持 `running` + retryAt 退避；429 遵守 Retry-After（封顶 5 分钟仅作下限保护，Retry-After 更晚则取更晚）。
- 401 / 403 / 凭据失效 / 账户不匹配 / 适配器不兼容 → 保留业务事实，`trackingStatus="blocked"` + waitingReason，停止密集重试，等待 resume。
- 上游明确业务失败（响应体表明生成失败）→ `failed`（保留上游状态与去敏原因）。
- 提交网络错误且无上游 ID → `unknown`（待核对）；上游 502 不能证明未受理 → unknown，不自动重试创建。

## B. 时间与等待（冻结默认值）

| 时间 | 默认 | 行为 |
| --- | --- | --- |
| 提交一次网络尝试 | 90 秒 | 无 ID 且不确定受理 → 保留提交键，unknown 待核对；不再次创建 |
| 查询一次网络尝试 | 30 秒 | 有 ID 保留原任务，安排下次查询 |
| 下载一次尝试 | 60 秒无数据；单次总尝试 15 分钟 | 保留已成功输出，继续补下载；100MB 限制不变 |
| 整个生成等待 | 不限时 | `settings.mediaTasks.waitingReminderHours` 默认 24，0=不提醒；只提醒不失败 |

- 任何本地超时都不得自动换键重新生成。
- 上游成功但下载/保存未完成 → 保持 `downloading`；补查结果地址网络失败仍留在 downloading 继续；上游不支持刷新或结果已删除 → 明确"待核对/无法补取"，不保证新链接。
- 查询退避：前 5 分钟约 10 秒、5–30 分钟 30 秒、30 分钟–2 小时 60 秒、2 小时后 5 分钟，±20% 抖动；临时网络错误 10 秒起指数退避封顶 5 分钟；成功查询后回到所在阶段频率。本地网页查询只读本地快照，不让每次 getVideoTasks 等上游。

## C. 容量与重启（冻结）

- 分开两类额度：`generationConcurrency`（默认 2）= **上游未终结的在途额度**；单次提交/查询用短时执行槽，查询间隔不占 HTTP 槽。
- 重启顺序：先加载恢复记录（已有 ID 的 running/downloading 全部重新进入跟进队列、统计在途数）→ 在途数≥配置则**禁止放新 queued** → 有余量才放新任务。无 ID 的 unknown 与 paused/blocked 任务保守占用在途额度。
- 健康/就绪分开表达：`/api/health` 只报存活+目录可写；恢复完成由调度器状态表达（就绪字段，见 D 恢复入口的 status）。

## D. 恢复入口（冻结接口）

```ts
// POST /api/ai/media/tasks/pause   body {directory, taskIds?|batchId?}
// POST /api/ai/media/tasks/resume  body {directory, taskIds?|batchId?, bindTasks?: [{taskId, upstreamId}]}
// MCP: pauseVideoTasks / resumeVideoTasks（字段同 HTTP）
```
- pause：置 `trackingStatus="paused"`（停止服务端查询跟进；主状态不变；上游可能继续生成）。不影响本地网页观察语义。
- resume：置回 `active` 并立即安排一次查询；**只查询/下载已有任务，绝不创建新上游任务**。
- bindTasks（仅 resume）：给无 ID 的 unknown 任务绑定人工核对的上游 ID；校验工作区、供应商、任务信息，核对失败保持原状态并逐项返回原因。
- 不兼容/受阻任务的恢复：resume 重新加载当前凭据；兼容即继续；不兼容保持 blocked 并可再次 resume（可恢复原查询，不删除版本保护）。
- 取消语义不变（取消 ≠ 暂停跟进）；响应逐项返回 taskId/state/trackingStatus。

## E. 网页绑定与画布（冻结）

- 任务关联键（localStorage）含 `directory + canvasId + nodeId`；值含 `batchKey / itemKey / taskId / state / submittedAt`（沿用现有结构扩展，不新增第二套）。
- 提交前先落盘键值；首包丢失/刷新/重开：只按**原 batchKey** GET 查询并按 itemKey 找回；**不调用 submit**、不换新键。查不到记录不视为未受理（保留关联，可人工/自动重试查询）。
- unknown 不清关联；空查询不需连续三次即丢弃；attach 失败可再次恢复（不得永久缓存失败 Promise）。
- 收到 taskId 即完成受理动作，**首次进度查询异步**（不 await），页面节点不得返回无 taskId 的 accepted。
- 输出写节点后关联保持"已完成、待保存"；**画布以正确 revision 保存成功后**才清临时关联；409/保存失败保留"完成、待回写"。
- 画布首次保存使用**读取内容时记录的 revision**；读取失败不得降级为普通覆盖写；冲突保留本地草稿（现有横幅 + 重载入口保留）。
- 只读节点状态查询（`getGenerationStatus` 等 readOnly）不触发全图 flush（沿用 R16 白名单机制，覆盖节点状态工具）。
- 网页停止观察（关标签/暂停观察/回前台/网络恢复）不修改服务器 `trackingStatus`；服务器 pause/resume 是独立明确操作。
- 401 统一处理：Axios 默认实例、workspaceFiles 独立实例、任务/媒体 fetch；登录过期**保留草稿与任务关联**，不强制 reload；重新登录只恢复查询，不重放生成。

## F. MCP 控制命令排队（冻结）

- 同一 connection 的普通并行命令进入**有界 FIFO**：容量默认 8；达到容量或累计等待超预算（默认 120 秒）时返回可理解的拒绝（说明队列状态）。
- 排队中的命令可被取消（signal abort/超时）且被移除，不得稍后偷偷执行；执行前重查 connectionId / directory / canvasId（沿用 R17）。
- 已受理的后台媒体任务不随控制命令超时取消。
- 只读命令与变更命令同一队列（顺序执行保证画布一致），但只读不得触发全图 flush。

## G. 设置版本（冻结）

- 设置保存返回的 revision 必须对应该次落盘内容（保存与模型刷新在**同一协调范围内**绑定，刷新后再计算该次内容 revision；并发请求不得互相取到对方版本）。
- 前端保留 settingsConflict 语义，并补**可执行恢复入口**（设置面板提供"重新加载设置"按钮），冲突提示与操作对应。

## H. 清理契约（冻结）

- 五类真实业务入口登记（C 负责列全并接入；web `workspaceFiles.ts` 发送 `x-toonflow-file-kind` 由 I 接入）：
  - generatedText/generatedImage/generatedVideo：任务落盘（已有）、旧同步工具落盘、文本节点生成保存（web 写文件带 kind）；
  - original：工作区上传/导入、素材上传（已有 assets/save）；
  - cache：明确登记的可再生成中间文件（无符合项则 0）。
- 计时起点：成片 = 可靠落盘时间与最后占用保护解除时间的**较晚者**；原始资料 = 导入/修改；文本 = 生成/修改。重命名/复制/删除/回写维护归属。
- 保护：活跃任务输入快照、编辑中、downloading、unknown 待核对、blocked/paused 任务的所需数据一律不清理；多归属全满足才删；未知历史文件不自动归类。
- 删除流程保留**持久清理标记**（cleanedAt 不立即删记录）；删除前在同一协调边界重读版本、引用、规则；清理后任务输出与节点显示"已清理"，旧页面不能写回。
- 恢复输入与待核对任务不按普通两天缓存处理。

## I. 部署与产物（冻结）

- compose 模板透传 `TOONFLOW_COOKIE_SECURE`（与实际 HTTPS 部署一致）；线上 Secure 保持开启。
- FFmpeg 执行容量收敛到**宿主唯一执行边界**（工具 bundle 经宿主注入函数执行，不得各自模块变量限流）；查明安装产物落后来源后同步修复，保留用户定制，不删 initialized/清 data。
- 停机协调：停止启动 timer 与新受理；在途作业安全中止或收敛；已收到上游 ID 的落盘临界段先完成；作业结束后最终排空写队列。
- 发布后逐项核对 build / data 安装产物哈希与唯一 BUILD_ID。

## J. 本轮禁止与允许（全员）

- 禁止新增任何测试文件、临时测试程序（含仓库外 .py 探针）、mock 服务、测试专用入口；验证用内联命令、产品 HTTP/MCP、浏览器手动操作。
- 默认不调用收费上游；复用已有 2 条成片与原 ID 验证。确需收费需说明并取得新增授权。
- 不改桌面安装、其他服务器业务；不整机重启/prune/down -v；演练用隔离工作区与临时数据目录。

---

# 返工契约 v3（2026-10-08，依据 docs/secondIndependentAcceptance.md R01–R11 与 docs/completeRepairExecutionPlan.md）

保留以上全部历史条款；本节为第三轮新增，冲突处以本节为准。G0 现场核实（2026-10-08 16:0x）：容器 toonflow-toonflow-1 / 镜像 toonflow:server-20261008-11（ID ff76b89669b4…）/ healthy / BUILD_ID server-20261008-11；13 批次 43 条任务：36 cancelled、2 failed、5 succeeded、无未解决活动任务；paused=false、并发 2/2、提醒 24h；五类清理全关（2/2/2/30/2）；无其他执行窗口活动；安装产物与 build 一致（videoGenerationNode 8874b210…、dolaVideo db1d320b…、ffmpeg.tool.js f9209433…）。

## A. 停止、受理与落盘（I 装配，Q/W/C 提供停止入口）

1. 新增进程级 stopping 状态：置真后拒绝新受理、新作业、拒绝迟到 tick 与恢复派发。
2. 停机顺序（唯一）：封闭受理/派发 → 清启动与周期 timer（含清理派发）→ 关闭 MCP 派发并停止监听接收新请求 → 收敛普通 I/O → 等待在途受理、作业及关键落盘（含已取得 upstreamId 的临界段）→ 排空全部写队列 → 关闭剩余连接并退出。
3. 已取得 upstreamId（或同步生成结果）后，任何 abort/停机分支不得跳过持久保存；保存时合并最新 pause/cancel 意图。
4. 恢复：逐项错误汇总；无法确定任务台账、恢复保护或在途数量时 `schedulerReady=false`，停止新生成与清理并暴露可诊断错误（不 catch 后静默 ready）。
5. 幂等可见性：accepted/existing 只能指向已持久化记录（store 先落盘后发布公共视图；锁内重查；首写失败向调用方传播）。

## B. 任务语义与容量（Q 实现、W 消费）

字段（新增/明确，全部可选，旧记录兼容）：`abandonedAt`、`abandonRevokedAt`、`outputState?`("available"|"cleaned"|"missing")、`cleanedAt`（任务输出侧）、`retryAt`（持久）。
- pause：置 `trackingStatus=paused`；迟到查询/下载回调不得改回 active、不得派下载；正在 submitting 无 ID 时先记暂停意图（不强杀提交）。
- resume：只恢复原 ID 的查询/下载，遵守 retryAt；无 ID 的 queued/preparing 明确拒绝（不得触发首次生成）；无 ID unknown 需先 bind 成功。
- cancel：确定未提交 → 本地 cancelled；上游明确确认 → 声明上游取消；下载中 cancel = 暂停取回（保留 downloading 与恢复能力）。
- cancel 新增 `abandonUnconfirmed?: boolean`（默认 false）：仅适用于 unknown 且无 upstreamId；置 `abandonedAt`、保留 unknown/键/输入/历史、`trackingStatus=paused`、解除保守额度、**不声称上游取消**；重复幂等。bind/resume 成功时记录 `abandonRevokedAt` 并撤销豁免（按实际未终结事实重新计入额度）。
- 容量：`downloading`（上游已终结）不占 generationConcurrency；paused/blocked/retryAt 等待期间不占下载执行槽但保留文件保护；无 ID unknown 未放弃时保守占。
- retryAt 持久：重启、pause/resume、手动刷新不得清掉未来 retryAt；下一次尝试不早于 Retry-After 与本地退避的较晚值。
- 摘要透出：已有 trackingStatus、waitingReason、retryAt、resultReadyAt、abandonedAt/abandonRevokedAt、outputState。

## C. 供应商、同步后台与输入（Q，W 接线）

1. 首次执行分流：`submitMedia`/`queryMedia` 成对 → 持久异步；否则调用原 `generate*` 方法在**服务进程内后台执行**，可靠受理（已持久任务 + 已开始执行）后快速返回 taskId。恢复阶段才要求原 ID 查询能力；同步任务跨重启无法续查 → 明确 unknown/blocked 并说明，不承诺跨重启。
2. providerCompatibility：核对 providerId/modelId、完整规范化 API 基址（协议/主机/端口/路径）、providerRevision、查询协议兼容与凭据身份引用；正常自提交链身份未变化可直接续查；人工 bind/账户地址协议变更/历史不足时需只读核对（响应 ID、类型、模型、可验证账户）；缺字段 ≠ 自动兼容；核对失败保持 blocked，不写 ID、不重新生成。
3. bind：只读上游核对 → 全局归属检查 → 锁内重查任务版本 → 一次可靠写入；同任务同 ID 幂等，不覆盖为另一 ID，失败不留半绑定。
4. 不支持的参考类别与 mode（模型未消费的 videos/audios/mode 等）受理前拒绝，不静默忽略；保留 XMX edits multipart 逐图路径。
5. 本地准备失败（快照缺失、校验失败）属确定未提交：记提交前失败，不占保守额度，不转 unknown；提交网络尝试从真正开始计时。

## D. 网页绑定、保存回执与查询（W）

1. `writeBackToken`（网页侧字段，服务端不存）：首次绑定某 taskId 的某输出身份/内容版本时生成并持久于绑定与节点最小结果元数据；同一任务同一输出的重复轮询/重挂载/登录恢复复用；新任务或真正新输出才新建。
2. 画布保存：发送前固定不可变文本快照，并从**同一快照**导出 `{taskId, nodeId, outputPath, writeBackToken}` 清单；保存成功事件携带该清单与本次 revision；禁止收到响应后读当前节点凑清单。
3. 仅当 directory + canvasId + nodeId + taskId + outputPath + writeBackToken 全匹配才清临时关联；部分输出、取消竞态、同步/持久路径统一遵守；failed 含合法部分输出时输出仍走待回写；cancel 返回 succeeded/unknown/failed 时先查完整摘要再决定。
4. 首包 unknown：**立即**启动按原 batchKey/itemKey 的恢复查询（自动，不依赖点击）；空查询/401/断网/重挂载/回前台不触发 submit；attach 失败不永久缓存。
5. 画布 reload：清冲突提示不得清掉同次读取取得的 revision；保存始终使用同源 revision；重载失败保留草稿与冲突。
6. 设置重载：请求成功并校验后才切换 settingsReady/清冲突；失败保留草稿、旧 revision、横幅与可重试按钮；重载期间旧排队快照不得覆盖新结果。
7. 页面任务查询聚合：同一页面跨节点 bundle 共享一套订阅（宿主运行时注入，避免各 bundle 各持模块变量）；按规范 directory 分组、taskId 去重、每次 ≤200 且显式 limit=200；相同 batchKey 分页查回；visible≈3 秒、hidden≈15 秒、online/登录恢复立即补查；无订阅释放 timer/监听。
8. 视频节点网页点击与 `node:generateVideo`：统一走公共 submit（含同步供应商），移除直接同步等待绕路与 asyncMedia-only 首次拒绝；停止/取消对话框语义按公共任务链；能力差异仅作提示。

## E. 清理与归属（C 实现，Q 落盘接线，W 消费）

1. 锁顺序（唯一）：任务锁（需要时）→ 一次性取得全部相关路径锁 → fileRecords 串行写入；清理持路径锁时只读任务快照，不反向等任务锁；归属写队列内不取路径锁/任务锁。目录操作：Q 任务外层先取受影响任务锁 → C 再取源/目标路径锁。
2. 删除意图与 `cleanedAt` 分离：实际删除成功（或结合持久意图确认已发生）才记 cleanedAt；删除失败/文件仍在 → 下轮按最新天数与占用重算（旧意图不得绕过延长后的期限）；无清理依据的外部缺失标 `missing`，不伪装 cleaned。
3. 输出可用性：任务摘要/节点/生成文本/素材与文件视图消费 `outputState`（available/cleaned/missing）+ cleanedAt；已清理停止旧播放/下载并显示已清理，不变成上游失败。
4. 编辑占用：会话级集合（认证页面会话 + 规范目录 + 路径），约 30 秒续租、断联宽限 5 分钟；关闭编辑器主动释放；hidden 不立即释放；过期保护用 revision + 清理记录阻断旧保存；预览/播放/只读不登记长期占用。
5. 目录改名递归迁移源目录本身与真正后代（`a` 与 `ab` 不混），保留归属 ID/来源/多归属/计时；复制产生新记录 ID 并从复制完成起计时，不照搬原任务/编辑占用身份；源/目标路径锁内完成真实文件操作与归属落盘，失败安全回滚。
6. 任务输出改名：Q 提供任务协调外层（按 taskId 顺序取任务锁），C 再一次取源/目标路径锁；锁内重查引用集合；新增引用/占用 → 释放重算或 409；真实文件与页面定位同步更新，不只迁账本。

## F. 资源与插件（I）

1. 内置子 Agent：父让槽后必须在返回工具结果、继续推理前重新通过同一 FIFO 获取槽；让出一次、重取一次、释放幂等；取消等待及时移除；异常/取消只释放实际持有的槽。
2. FFmpeg：宿主唯一执行边界覆盖 HTTP、工具注入、供应商调用与**原生 fluent 工厂**（apps/server/src/utils/ffmpeg 与 packages/ffmpeg）；一个进程只拿一次槽，移除外层重复拿槽；进程真实退出后释放；ffprobe/截图/拼接子过程计入规则写清。
3. 插件升级：按文件三级哈希（当前/上次官方基线/新官方）判定：未改官方文件自动更新；已等于新版本直接登记；当前不同或旧基线不可信 → 保留定制并把新官方产物放非自动加载的待更新位置；升级清单原子保存并记录待处理项。
4. 同名定制若涉及本轮关键修复，由主窗口读取差异最小合并并保留原副本；无法安全消解的行为冲突才集中报告。

## G. 本轮禁止与允许（延续 v2 §J）

- 禁止：新增测试文件/临时测试程序/mock 服务/测试专用入口（含仓库外、改名规避）；新增收费生成（本轮额度 0）；改桌面安装；操作其他业务；reset/clean/stash/初始化 Git；手改 router.ts。
- 允许：typecheck、构建、真实 HTTP/MCP/浏览器验证、隔离数据与临时 data 演练、内联命令与证据记录。
- 证据：集中写入 `toonflowHandoff/evidence/repairExecution20261008/`（小驼峰命名），记录 codeStatus/runtimeStatus/evidenceLevel/limitation，不覆盖失败证据。

---

# 返工契约 v4（2026-10-08，依据 docs/thirdIndependentAcceptance.md T01–T18）

保留以上全部条款；本节为第三轮独立验收后的收口版，冲突处以本节为准。第三轮部署身份：镜像 `toonflow:server-20261008-12`（ID `sha256:e9afabc0c1d3a3b25a14827aca94fcd3d078d1a4398cb24688969ad7c5943060`）、BUILD_ID `server-20261008-12`；本轮新增收费生成预算仍为 0。

## A. 停机总预算（T02，I 装配 Q/C/W 提供停止入口）

1. 单一全局截止 `deadline`：从收到信号起算，覆盖 封门 → 在途受理/协调队列 → 清理收敛 → 媒体作业与关键落盘 → 最终写队列。各阶段等待取"剩余预算"，不得各自叠加固定上限。
2. 顺序固定：`stopping` 置真 + `server.close()`（并等待在途 HTTP 结束或到截止）→ MCP closing（不再派发、断连接）→ 清理停止（短预算）→ 媒体 drain（内部截止 + 强制中止宽限）→ `drainMediaTaskWriteQueue()`（带截止；未排空也返回并写 `drainOutcome`）→ 退出。
3. 在途受理计入排空：从受理入口进入（含目录/供应商/快照/批次锁等待）到持久完成的请求记为 in-flight；`taskChains`/`batchChains` 等待项计入 drain 判定，未开始写盘的协调等待不允许被判定为"已排空"。
4. compose `stop_grace_period` 必须大于应用总预算并留余量；应用总预算默认 45s，硬上限 50s。

## B. 恢复就绪门（T03，Q）

- 新增唯一判据 `mediaTasksReadyForDispatch()`：store 已装载 && recovery settled && !recovering && !stopping && recoveryErrors 为空 && 装载 warnings 已纳入判定。
- 所有派发入口（周期 tick、受理后触发、设置变化触发、启动定时器）复用同一判据；恢复未完成或台账/保护不明时不派新生成。受理可按契约排队，但不得绕开门。

## C. 容量预约（T04，Q）

- 已准入但尚未发布 `submitting` 的 generate job 计一次容量预约，与已发布在途任务去重；失败/取消/停机归还。
- 保持"durable 之后才 publish"；预约记录不进入公开台账。

## D. 下载重试（T06，Q）

- 任何需要延迟的重试（含第 1–4 次）都先持久化 `retryAt` 并结束当前下载 job（释放执行槽）；仅到期且可跟进时才重新拿槽。
- 不得清除上游给出的更晚 Retry-After 下限；暂停/停止时可结束等待。

## E. 身份、兼容与恢复依据（T07，Q）

任务记录新增（可选，旧记录兼容）：
- `submissionIdentity`：受理时写入 {providerId, modelId, apiBase, revision, credentialRef}。
- `queryIdentity`：加载供应商时计算（不落盘原始 Key），用于比较。
- `verifiedRecovery`：人工核对成功后写入 {upstreamId, model?, accountHash?, verifiedAt, source: "bind"|"rematch", **identity**（核验当时的 providerId/modelId/规范化 apiBase/revision/credentialRef 快照）}。
  - 注（第五轮互审对齐）：实现落盘字段名为 `identity`；核验命名空间不单独持久化，而是在绑定时**由当前身份（providerId + credentialRef）派生**并在共同锁内重查——文档与实现的字段集合以此为准。
  - 注：`queryIdentity` 不是落盘字段，而是加载供应商时计算的比较函数；`submissionIdentity` 才是受理时冻结的持久身份。

兼容规则（第四轮修订：核验结果不得脱离核验当时的身份）：
1. 有 `verifiedRecovery` 且 upstreamId 匹配 → **仅在当前 queryIdentity 与 `identity` 全等（providerId/modelId/规范化 apiBase/revision/credentialRef）时才可直接续查**；任一不一致（改 Key、改地址、改供应商代码版本）**直接 blocked**：必须重新只读核对后 resume，**不得回退到 `submissionIdentity`（原提交身份）放行**（已有针对当前 upstreamId 的核验依据时，其身份约束优先于原提交身份；原提交身份只保留供审计）。原因按字段级差异透出（不含凭据值）。（第五轮验收 §3-T07 修订）
2. 否则要求 apiBase（规范化）+ revision + credentialRef 全等 → 续查。
3. 地址缺失但 revision 相同 → 允许续查（旧记录兼容），但必须先通过 credentialRef 检查；不得提前 true 跳过凭据检查。
4. 其余 → blocked，`waitingReason` 可读；resume 在受阻时重新加载凭据再判定。

上游核对（`verifyUpstreamMediaTask`）：
- 必须回显 ID 且与候选相等；model 回显才比较；account 只有与可信身份派生标识比较后才算 verified，否则 unverifiable；**至少 ID 相符**才允许绑定。
- 绑定唯一性按**本次实际查询账户/命名空间**划定（实现：由当前身份 providerId + credentialRef 在绑定时派生、锁内重算；不得用历史 providerCredentialRef 代替当前账户）；在共同临界区锁内重查；落盘前重查任务版本与供应商身份；**核对开始前固定 task.stateVersion 与完整查询身份**（初次 bind 与 rematch 一致），写入前再比较，核验期间发生的 pause/cancel 不得被吸收。
- 核对成功解除 blocked 时必须持久化 `verifiedRecovery`（含 `identity`），下次 load 按规则 1 复用。

## F. 快照输入与本地准备（T09，Q）

- sync 与 async 后台执行统一使用**受理时持久快照**构造 provider 输入；读取入口核长度 + SHA256；同长度错误内容不得进入 provider。
- 本地准备（供应商加载、快照读取、校验）失败属"确定未提交"，记提交前失败，不占保守额度、不写 unknown。
- `submitting` 的持久化时点与"网络尝试开始"事实分开：仅真正开始网络尝试后才允许进入 unknown 语义。

## G. 输出字段与消费（T11，Q 冻结字段 / W 消费）

- 任务摘要 outputs[] 字段统一为：`state`("available"|"cleaned"|"missing")、`resolvedPath`、`cleanedAt`、`sha256`、`path`（原路径保留作历史）；顶层保留 `outputState` 兼容字段。
- 网页 hook 只读上述字段（兼容旧 outputState）；节点/文档文件树/素材库/生成文本视图消费同一公共查询（任务摘要或 `/api/cleanup/record`），已保存结果在重新挂载后可查询可用性；人工清理与上游失败必须区分；查询可用性不得触发生成。
- hook 透出并消费 `trackingStatus`/`waitingReason`/`retryAt`，paused/blocked 不显示成"继续在服务器执行"。

## H. 网页查询时限（T13，W）

- 节点工具（getGenerationStatus 等）只等待**自身订阅结果**并有短截止（≤5s）；超时返回已知摘要并说明"仍在查询"。
- 保留跨 bundle 聚合 hub（目录分组、去重、≤200/批、limit=200、visible≈3s/hidden≈15s、无订阅释放）；页级观察独立持续，不被单次工具调用阻塞。

## I. 编辑占用（T14，C 后端 / W 前端）

- 占用身份 = `{loginDigest, pageId, leaseId（**每次租约实例**身份）, directory, path, version}`；释放必须携带 `pageId + leaseId + versions`（无版本/无实例身份的释放只能作用于显示声明的兼容降级路径，且不得删除后建立的新租约）；同浏览器两个标签互不影响。
  - **页面实例身份（第四轮修订）**：`pageId` 只标识真实页面实例；复制标签/带 opener 的同源新页面会复制 sessionStorage，必须做碰撞处理或重新分配（例如实例内 UUID + 服务端已存在探测后换新），不得把"sessionStorage 一定独立"当安全前提。
  - **租约实例代次**：每次 create 建立新的 `leaseId`（或等价代次）；迟到的 create 响应与迟到的 release 只能作用于其对应代次，不得影响其后建立的租约。
- 续租与释放必须在同一路径锁与占用版本复核内；删除前重读占用与版本；占用记录带 `version`，续租递增。
- 释放/过期写入持久 `lastReleasedAt`（fileRecords 侧），保留期计算取"可靠落盘时间"与"最后实际保护解除时间"的较晚者（成片/资料/文本均适用）；**改名迁移必须同步迁移释放时间**。
- holdEditing 必须接入：文本文件编辑（已有）、画布文本节点编辑、图片编辑入口、视频节点待回写结果；首次登记失败必须在 UI 可见（节点/编辑器错误提示），不得静默假成功。
- 重启/退出：活动租约不得只存在于内存——退出与重启要有**保守可恢复的解除依据**（例如把在续租的占用与解除时点纳入收尾持久化或按保守保留期处理）；持久 `lastReleasedAt` 保留；hidden 不释放；重新登录后前端以新实例身份重新登记。

## J. 保护表与恢复（T16/T17，C）

- 保护条目含 `guardId` 与 `paths`；目录保护按真正后代匹配（不误匹配兄弟），清理判定同时检查精确路径与祖先目录保护。
- 保护表解析失败/缺失 → **持久**故障标记（跨重启）；只有显式恢复核对成功才清除；"新写成功"不得把健康状态改回 true。
- 恢复 pending 登记必须持目标路径锁并核对 guardId/版本：正在写入的 guard 跳过；仅恢复可确认的落盘结果；解除必须匹配同一代 guard。

## K. 目录改名事务（T15，C 实现、Q 提供任务锁入口、W/正式路由接线）

- 正式入口 `POST /api/workspaces/files/rename`（含 assets rename 与 agent 工具改名）必须：Q 外层按 taskId 顺序取任务锁 → C `relocateWorkspacePath` 取源/目标路径锁并完成文件+归属+定位 → 同一事务内持久更新受影响 `task.outputs[].path/resolvedPath`。
- 回滚覆盖：源目录本身与**全部源后代记录**、目标、保护表、定位日志的持久内容；任一持久写失败必须明确阻断（不得只恢复内存）。
- 路径日志（relocations）仅作兼容信息，解析必须按任务/资产身份约束（refs 必须匹配）；旧路径被复用/日志淘汰时不得把旧任务串到新文件。

## L. FFmpeg 边界（T18，I）

- 信号量放在**真实子进程生命周期**边界：同一命令的所有终态入口（run/save/saveToFile/screenshots/thumbnail(s)/mergeToFile/concatenate/concat/ffprobe/stream/pipe/exec/execute 及 clone 后的实例）共享同一占用，且每个子进程只占一次；内部 probe→run 组合（concat 链）不得自我死锁。
- 外层入口（executeRemoteFfmpeg）与原生包装共用同一占用判定；克隆实例、静态 ffprobe 调用与别名必须与实例包装一致。
- 释放以子进程真实退出（exit/close）为准；取消时先排队再启动的项不占槽。

## M. 规范与证据（全员）

- `routes/cleanup/editing.ts` 拆分为一个方法一个文件（POST/DELETE/GET），运行既有 `bun run routes` 生成，不手改 router.ts。
- 证据补 `commandResults.jsonl`（真实命令、工作目录、退出码、起止时间、去敏原始输出）；submissionLedger 逐请求完整（含并发两次各自返回）；executionManifest 使用完整镜像 ID 与实际时间戳。
- 并发/交错类结论必须真实动态执行或在记录中明确标为源码核对，不得写成竞态实测。

## N. 第五轮接缝（T02/T03/T06/T07/T11/T14/T15/T18，2026-10-09 冻结）

第四轮成果（T01/T04/T05/T08/T09/T10/T12/T13/T16/T17 主缺陷）保留不动。本轮先固定以下四个接缝，Q/W/C/I 按此并行，不得单侧改语义。

### N.1 新创建准入与归属未知（Q/C/I）
- **唯一新创建判据**（Q 提供、I/C 消费）：`mediaTasksDispatchReadiness()` 的语义扩展为「统一新创建准入」= 存储已装载 + 恢复 settled + 非 recovering/stopping + 无 recoveryErrors/装载告警 + **保护与归属存储就绪**（见下）+ **未全局暂停**（`settings.mediaTasks.paused`）。
  - **所有真实创建入口**必须消费同一判据：后台调度（Q）、旧同步入口 `/api/ai/media/generate` 与 Agent/节点同步路径（I，`utils/media/generation.ts`）、以及任何后续新增的创建路径；不得各自复制判断。
  - **受理与创建分开**：HTTP/MCP 受理继续允许在未就绪/暂停时入队（写台账、返回 accepted/queued），**实际上游创建**一律被上述判据挡住；暂停语义对同步入口与后台一致（paused=true 时同步入口拒绝创建并给出可读原因）。
- **归属/保护未知语义**（C 提供、Q/I 消费）：`fileRecordsStoreHealthSnapshot().ok=false` 必须覆盖——整表解析失败、**部分坏条目**（无法确认的条目）、不可解析/非法时间字段、marker/释放表故障、曾有保护状态未知。任一为真 ⇒ 同时阻断自动删除与新创建，直到显式核对恢复（`POST /api/cleanup/protections`）。
  - 不允许「跳过坏条目后按剩余条目继续」被当作健康；坏条目必须进入持久故障或使相关路径保守受阻（C 决定实现，但必须可诊断、跨重启保持）。

### N.2 改名事务：锁序、阶段与补偿（Q/C）
- **固定锁序**：任务锁（按 taskId 字典序，Q）→ 源/目标路径锁（C）。任何一侧都不得反序取锁；fallback 路径也必须先取任务协调，不得绕过。
- **阶段划分**：影响任务发现（discovery）与 outputs 发布（publish）必须在**同一任务锁临界区**内完成，路径锁只在文件/归属/定位事务期间持有；**outputs 发布未完成前不得释放任务锁**（消除「第二次改名按旧 outputs 发现 affected=[]」的窗口）。
- **可能已发布即视为已发布**：`writeAtomic` 先替换目标再 fsync 父目录，二者之间失败时文件可能已经改变。Q 必须把**所有尝试写入的参与项**（含本次报错的项）纳入补偿集合；C 的 `recordsWritten` 类标记同理——按「可能已发布」处理，或在发布前记录足够事实以便恢复。
- **真实阻断消费者**：`relocationBlocked` 与 C 的范围保护必须被**实际判定消费**（后续改名/输出改写/清理遇到阻断即拒绝并给出原因），写不出去时**停止本次操作**而不是仅 warn；范围保护写入失败不得只撤销内存修改而不建立故障。

### N.3 编辑租约：身份、版本与持久下限（W/C）
- **释放匹配**：新租约释放必须**同时**满足 `leaseId`（本次 hold 实例）与逐路径 `version`；任一缺失、错位或部分缺失**不得静默降级**——按「不匹配」处理并返回可读原因（只有显式旧格式记录才走兼容分支）。
- **每次 hold 不复用出网身份**：W 为每个 hold 生成新的实例身份（不放复用过期即复活的 leaseId）；C 保证过期移除后的 `version` **不从 1 重新开始**（持久代次），使旧释放无法命中新占用。
- **可恢复的保护下限**（第五轮实测后对齐，2026-10-09）：由 **C 在 create/renew 返回 2xx 之前**把保护下限（`max(now, expiresAt)`，单调推进）与版本代次持久化（复用既有批量持久化）；持久化失败返回 503 且不确认本次续租；**W 只在确认成功后**写回本地版本/下限，失败即显示错误并按周期重试（不静默）。C 在保护状态可证明之前保持保守（不得仅靠退出回调或内存）。异常退出（崩溃/预算截断/收尾写失败）后，重启的清理不得按旧时间删除刚被编辑过的文件。
- **时间字段**：`releasedAt` 等必须是可解析且有限的 ISO 时间；空串/NaN/非法值进入可诊断、跨重启保留的未知状态，不得被当作有效时间参与保留期计算。

### N.4 45 秒总预算的阶段分配（I/Q）
- 由 I 在 `apps/server/src/index.ts` 按**同一个 deadline** 显式分配给各阶段（HTTP 在途、MCP、清理、媒体排空），并把可兑现的数值传给 Q：
  - 媒体阶段调用 `drainMediaTaskWrites({ deadline, abortGraceMs, finalWriteReserveMs })` 时，I 必须保证 `deadline - now ≥ abortGraceMs + finalWriteReserveMs + 自然等待余量`；不得只传一个无法兑现的 grace。
  - 各阶段不扩大 45 秒总预算；新受理门、在途计数、双信号幂等与 Q 内部「先预留再自然等待」全部保留。
  - 实际开始/结束、真实 abort 等待（`abortWaitedMs`）、最终写保留与总耗时必须在 `drainOutcome`/日志中可读。

## O. T15 收尾接缝（持久迁移意图与同事务恢复，2026-10-09 冻结）

第六轮验收只保留 T15 两条反例（连续写盘失败后重启丢保护；源已反搬回 A 时精确恢复被自身阻断）。其余 17 组成果全部保留，不重做。

### O.1 事务身份（Q/C 共用同一确定性 ID）
- `transactionId = "relocate:" + sha256(directory + "\0" + oldAbsolutePath + "\0" + newAbsolutePath).slice(0, 16)`。
  - Q 与 C 各自用**绝对路径**计算，不需额外传参即可在重启后重新算出同一 ID；保存到各自持久事实中。
- 意图/阻断记录必须同时保存：`transactionId`、`directory`、`source`、`target`、`refs`（本次涉及的 `task:<id>` 与记录身份）、`createdAt`、（可选）版本依据（记录 version 摘要）。

### O.2 C：移动前先持久意图（先持久后移动）
- `relocateWorkspacePath` 在真实 `renameWorkspaceFile` **之前**，必须先把意图写入保护表（复用 `protections.json`，新增可选的 `relocationIntent` 字段承载 O.1 信息，`rangeReason` 保留给人工核对文案）：
  - 意图条目对 **source 与 target 双侧**同时生效（后代匹配语义与既有范围保护一致）；
  - **写入失败 ⇒ 不移动**（返回明确错误，文件仍在 A）；
  - 仅在本进程锁内保存、失败后再补写不算数。
- 提交与解除时点：`rename` + 归属迁移（含释放时间/定位日志）**全部完成后**才清除意图；清除失败 ⇒ 保留意图（可诊断保护），操作可视为已完成但状态必须显示「保护仍在，需清理核对」。
  - **第六轮互审修订（2026-10-09）**：协调路径（Q 有 affected 任务）下 C 成功迁移后**不自行解除意图**（`relocateWorkspacePath({..., deferIntentRelease: true})`，返回 `intentPending: true`），由 **Q 在 outputs 成功落盘后**调用 `clearFileRelocationIntent(transactionId)` 解除；fallback 直连路径保持 C 提交后自行解除。理由（验收 §4.2 字面）：不得在「C 搬完文件但 Q 尚未写完 outputs」时提前解除；否则 Q 发布失败 + 补偿反向意图写入失败 + Q 持久 block 写失败三重连续失败下，磁盘会同时没有意图与 block，重启丢失屏障。
- 回滚：任一环节失败按既有补偿路径回滚；回滚**确认落盘**后才清除意图；回滚不完整 ⇒ 意图保留 + 持久故障（两者叠加时以更保守者为准）。
- 重启装载：带意图的条目必须保留双端保护、参与清理占用判定与改名拒绝；`fileRecordsReadinessSnapshot()` 透出待处理意图（含 transactionId 与两端路径）供诊断。

### O.3 Q：任务侧事实与恢复
- `relocationBlocked` 继续保存同一 `transactionId`（沿用既有持久与运行时双轨）；Q 的阻断消费过滤器保持「精确同 source→target 重试放行，其他重叠拒绝」。
- **把事务身份传给 C**：调用 `relocateWorkspacePath` 时新增可选 `transactionId`（Q 计算并传入），C 据此识别「本次即该事务的续做」。
- §3.2 精确恢复：当源已反搬回 A、记录/归属/输出均在 A、持久 block 仍在时，正式入口再次改名 A→B 必须在**同一事务身份**下真正走完（C 不得因该事务自身的意图/占用而返回 EOCCUPIED），成功后 Q 清除 block、C 清除意图；不同目标、其他任务占用、编辑租约、祖先保护、其他事务保护一律仍然拒绝。
- 启动消费：存在未完成意图/阻断时，即使任务已 succeeded、各 JSON 各自合法，也不得当作「迁移成功」——源与目标继续受保护，`outputs` 改写与清理使用同一事务事实；Q 的恢复流程不得跳过诊断。
- 旧路径复用：恢复遇到 A 已被新文件复用、关联身份/版本不符 ⇒ 继续保守拒绝；源不存在且目标有原事务依据的既有认回分支保留，不得以「文件存在」替代身份核验。
- 文案真实性：区分「本进程已阻断」「已确认持久保护」「持久化失败，需恢复核对」；不得在 marker 写失败时仍宣称跨重启已保证。

### O.4 保留与禁止
- 保留：锁内发现 affected、fallback 的 refs 复核、可能已发布写入的补偿集合、`persistRecordsWithRollback` 六单元、`creationReady` 与其他 17 组成果。
- 禁止：新增事务框架/依赖/测试文件/临时程序/mock；不为并行引入重复账本或锁倒序；不手改生成 router（如新增路由由 I 运行 `bun run routes`）。

## P. T15 第七轮收尾接缝（事务活动边界、参与集合、唯一解除时点，2026-10-09 冻结）

第七轮只收口 R1–R4；其余 17 组与 §O 已修成果全部保留。固定顺序：
**持久原意图 → 文件/归属操作 → 全部任务提交或全部补偿 → 核对全部参与者 → 解除本事务保护。**

### P.1 事务身份与参与集合（Q 提供、C 持久化）
- 沿用 §O.1 的 `transactionId`。**新增参与集合**：Q 在调用 C 时传 `participants: string[]`（本次 affected 任务 id，含"已发布到目标"的成员）；C 写入意图的 `relocationIntent.participants`。
- 意图同时保留 `source/target/refs/versionBasis`（原有）——**versionBasis 是原意图的证据，不得被重试时的当前文件覆盖**（见 P.3）。
- 恢复集合 = **持久意图中的 participants ∪ 当前核对中发现的参与者**；任一参与者未收敛（outputs 未到目标 或 block 未清），整个事务不得宣告完成。

### P.2 事务活动边界与唯一解除时点
- **活动边界**：一个事务在下列任一为真时视为"活动中"：①Q 进程内该事务的正向/补偿调用尚未返回（运行时集合，Q 暴露 `isRelocationTransactionActive(transactionId)`）；②持久意图存在且参与集合未全部收敛。
- **唯一解除时点**：仅当「全部参与者 outputs 已提交且落盘」或「全部参与者已完整补偿且落盘」并且参与集合逐项核对通过后，由**协调层（Q）**清算意图（`clearFileRelocationIntent(transactionId)`）。C 在协调路径的**正向与反向**都不自行解除（两方向都传 `deferIntentRelease: true`）；fallback 直连路径（无任务参与）保持 C 提交/回滚后自清。
- **显式恢复（`POST /api/cleanup/protections`）不得清掉活动事务**：C 的清除入口先查 P.2 活动边界（Q 运行时活动 + 持久未收敛），活动中返回 **409 忙状态**并给出可读原因（包含 transactionId 与两端）；无活动且核对完成后才按同一事实清理。锁序不变：不取任务锁时不反向等待（通过 Q 暴露的只读判定，不新增长持锁）。

### P.3 原意图身份与写保护（C）
- **恢复先核原意图**：`relocateWorkspacePath` 命中同 transactionId 意图时，必须核对 **意图中记录的 source/target/方向与 versionBasis**（记录 id、文件 size/mtime 或内容身份）：不一致 ⇒ 保守拒绝并说明差异；**不得用重试时的当前文件重写 versionBasis 后放行**。
- 合法反搬：允许"事务内位置变化"（源目标互换且 block/意图记录的同一事务阶段可解释）继续；外部替换（内容/身份与 versionBasis 明显不符）拒绝。
- **未完成事务两端（含后代）的普通覆盖写必须被拦**：`PUT /api/workspaces/files/write`（及素材保存等同类写入路由）在写前消费统一保护判定——命中未完成事务端点或其后代 ⇒ 拒绝并给可读原因（含事务与恢复路径）；不做"先写后看"。
- **双端保护固定（R1c）**：事务端点保护（source 与 target）在**全部任务提交或全部补偿确认前不随归属迁移收缩**；归属迁移时源端事务意图条目不得被移走/覆盖丢失；清理、改名、覆盖写、输出改写、显式恢复共用同一判定。

### P.4 清除结果语义（C）
- 清除保护/意图的持久写在 fsync 失败后可能已发布或未发布：**清除失败时不得绝对宣称"跨重启保护仍在"**，必须区分「已确认清除」「清除未确认（可能已发布，需核对）」「写入失败、保护仍在」；未完成事务的屏障必须可靠（清除不确认时保留可诊断状态）。

### P.5 提示出口（W/I）
- 成功但保护待核对：HTTP 成功响应（`warning`）必须被**网页实际消费并可见**（既有通知机制），MCP 最终可见文本保留；失败出口（HTTP 两路由、MCP、Agent 宿主）保留失败原因**并携带保护状态**，不得只在错误属性上挂（序列化会丢）。
- Agent `ToolFiles.rename` 为 `Promise<void>`：若内置工具无消费点，如实记录"宿主日志级"，不得写成"模型已收到提示"。
