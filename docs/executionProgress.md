# Toonflow 服务器二改 · 执行进度

规则：每完成一个门槛追加更新；中断恢复先重读 `docs/deepseekExecutionPlan.md` 与本文件最新条目。

## 2026-10-08 G0 完成

- 三份文档已读；私有凭据已核对（结构完整，未复制进仓库）。
- 桌面供应商哈希与交接记录一致（xmxImage 2.0.1 / dolaVideo 2.0.0）。
- 仓库外基线备份：`toonflowHandoff/baseline/source-20261008/` + `source-baseline-sha256.txt`（747 文件）；桌面供应商只读副本 `baseline/desktop-providers/`。
- 服务器只读基线：`toonflowHandoff/evidence/serverBaseline20261008.txt`；3000/3930/8790 空闲；`/opt/toonflow` 未占用。
- 契约冻结：`docs/executionContract.md`（任务/供应商/归属清理/认证/设置版本/MCP/部署/所有权/R 项映射）。
- 依赖安装：`bun install --frozen-lockfile` 成功（Bun 1.3.14）。
- 未决外部输入：Toonflow 专属域名（未提供；先回环+SSH 隧道，公网阶段除外）。
- 收费计数：视频 0/2，图生图 0/2（主控统一计数）。

## 下一步

- G1 并行：P（供应商迁移）、Q（持久任务）、A（登录与设置保护）；I 先冻结 types.d.ts 扩展与 file durable 原语。

## 2026-10-08 G1/G2 完成 + 集成门通过

- **P 供应商**：`packages/providers/src/media/xmxImage.ts`（2.0.1，保留 edits multipart；下载同源才带 Key、受限流式 100MB）；`dolaVideo.ts`（去掉 8790 台账；新增 submitMedia/queryMedia/cancelMedia；generateVideo 同步兼容 + 12h）；`apps/server/src/utils/media/assetBytes.ts`（宿主受限下载 + R30 严格签名校验）。
- **Q 任务后端**：`utils/mediaTasks/`（store/snapshots/scheduler/index）、`routes/ai/media/tasks/{submit,get,cancel}.ts`、mediaGeneration 插件三工具（submitVideoTasks/getVideoTasks/cancelVideoTasks 自动进 MCP）；幂等（directory+batchKey+itemKey）、状态单调防覆盖、unknown 不重提、暂停调度可查可取消、内容寻址快照。
- **A 登录与设置**：`utils/auth/`（argon2 哈希、内存会话 7 天滑动、登录限速 5/15min、HttpOnly SameSite Cookie）、`routes/auth/*`；settings GET/PUT 加 revision（409 冲突）；前端登录页 + main.ts 启动顺序 + 401 拦截 + 设置冲突提示。
- **F 前端/MCP**：视频节点走持久任务（localStorage 绑定先落盘再提交、刷新按原键恢复、卸载不取消任务）；画布 expectedRevision 版本保存 + 409 横幅；只读工具不触发全图保存（R16）；控制命令 expectedCanvasId 校验（R17）；文本截断提示（R20）；视频预览直链 Range（R15，桌面回退 Blob）；node:generateVideo 快速返回 accepted/taskId。
- **C 清理**：`utils/fileRecords/`（来源归属，durable 持久化）、`utils/cleanup/`（五类开关、候选规则、活跃占用保护、多归属全保留、删除前版本复核、单实例每小时）；路由 preview/status；设置面板"存储与清理"（默认全 off）。
- **D 部署准备**：Dockerfile（TOONFLOW_AUTH=1）、compose.yaml（127.0.0.1:3930→3000、env 插值）、docs/deployment.md；服务器 `/opt/toonflow/{app,data,.env}` 已建（.env 0600，未打印）。
- **I 集成**：app.ts（auth gate 在 body 解析前、mediaTasks/cleanup 初始化、autoInstallProviders 加两供应商）；index.ts（auth + pluginRevision=TOONFLOW_BUILD_ID）；utils.ts 出口；canManageRequest 替换 31 处管理接口（R12）；generation.ts 引用 assetBytes + 参考总预算 200MB（R10）+ 文件级锁（R07）+ 保留成功成果（R08）；工作区写入 `x-toonflow-file-kind` 登记；工作区读取隔离头（R13）；settings/save 接清理校验；R27 MCP 会话 TTL 30min + 上限 64。
- **验证**：server typecheck 0、web typecheck 仅既存 electrobun/.hutch 错误、providers typecheck 0、mcp typecheck 0；本地 `bun run build:server` exit 0（build/providers 含新供应商；nodes/tools/web/server 产物齐全）。
- 收费计数：视频 0/2，图生图 0/2。

## 下一步

- 部署到服务器（构建镜像 + up + 导入受控设置/MCP token），然后 G3 验收 V01—V12。

## 2026-10-08 G3 验收进行中（服务器已上线隔离环境）

- 部署：镜像 `toonflow:server-20261008-4`（当前），容器 `toonflow-toonflow-1`，回环 127.0.0.1:3930；数据 bind `/opt/toonflow/data`；`.env` 0600（BUILD_ID 随版本递增，触发内置插件同步 ✓ R11 验证）。
- 受控设置导入：自定义文本供应商、媒体供应商配置（xmxImage/dolaVideo Key）、MCP 专用 Token（enabled）、清理全 off、mediaTasks 初始暂停。
- **V01 认证** ✓（401/登录/HttpOnly/登出/MCP Token 正确与错误区分）
- **V02 设置冲突** ✓（旧 revision 409，新设置未被覆盖）
- **V03/V04 受理与重启** ✓（15 项受理 + 重传 existing + 冲突 rejected + batchId 稳定 + batchKey 取消 16/16 + 重启后保持）
- **V11 清理** ✓（off 零删除；回拨 40 天开启后到期项真实删除、活跃引用与未登记文件保留、状态记录正确；已恢复 off）
- **V09 图生图** ✓（文生图 1 次产出参考 + 单图 edits 1 次 + 多图 edits 1 次，全部 succeeded，PNG 落盘与归属登记验证）
- **V10/R16/R17** ✓（登录页→工作区→画布；MCP getCanvas/addNode 经网页执行；后台标签可操作；10 次只读查询画布零写入；目标画布变化拒绝且不误写）
- **V07** ✓（视频运行中重启容器，任务从 running 恢复，未重提）
- **V06** 部分 ✓（重传 existing；关网页任务继续；重开需重新登录（内存会话，设计内）后项目从持久化恢复）
- **V05 真实视频**：taskId `6efddcaf…`（seedance-v2.0 5s，参考图 1 张），生成中（收费计数：视频 1/2）。完成后补录文件验证。
- 过程中发现并修复缺陷：**SSE 僵尸连接**（Bun 下断开不触发 close → 前端重连产生新 id 累积 → MCP 报"多个页面"）；修复为心跳写状态检测 + req close 兜底，已部署 -4 并验证（重启后 directory-only 查询恢复）。
- 待办：V05 完成验证、V12 回退演练、管理员密码轮换（浏览器快照曾显示密码字段值）、README/交付文档。

## 下一步

- 完成 V05 文件验证 → V12 回退演练 → 交付文档与访问说明（域名待用户提供）。

## 2026-10-08 追加批次完成（终态，镜像 -6）

- 补齐审计清单未实施项：**R21**（subAgent 并发 3 + 防死锁让位）、**R23**（FFmpeg 统一容量 2，下沉到 `@toonflow/ffmpeg/remote` 覆盖路由与工具插件；探测缓存 60s）、**R14**（Agent 流 15s 心跳 + 前端忽略）、**R26**（画布根级标记完整解析）、**R31**（用户模型限制优先）、**健康/就绪检查**（`/api/health` + compose healthcheck）、**SIGTERM 优雅停机**。
- 部署终态：镜像 `toonflow:server-20261008-6`；服务器 compose = 固定 tag + `build: ./app`（rebuild 生成新 tag，up 用固定 tag 可回退）；容器 healthy。
- 验证：health 200、容器 healthy、restart 出现停机日志、登录/MCP 46 工具/视频任务 succeeded 全部回归。
- 剩余：R24/R25/R29 条件项保持原状；V08/R18/R19/R20/R30 行为为静态证据。

## 2026-10-08 公网域名与 HTTPS 完成（终态）

- 用户提供 Cloudflare 令牌；已创建 `flow.xmxcode.com` A 记录（152.53.170.228，橙云，与现有站点一致）。
- 宿主 Nginx 新增独立站点反代 127.0.0.1:3930（real-ip snippet、200m 上传、SSE 禁缓冲），certbot 签发 Let's Encrypt 证书并启用 80→443 跳转；未影响其他 14 个站点。
- 容器启用 `TOONFLOW_COOKIE_SECURE=1`；公网实测：health 200、未登录 401、登录 200 + Cookie(HttpOnly/Secure/SameSite)、设置读取 200 + revision、MCP initialize 200 + session。
- CF 的 BIC 仅拦截 python-urllib 特征 UA；Chrome/curl/node/undici 实测 200，真实用户与 MCP 客户端不受影响。

## 2026-10-08 G3 完成（首轮交付，镜像 -5）

- **V01—V12 全部完成**（明细见 `docs/executionAcceptance.md`）：认证、设置冲突、受理/幂等/取消、重启恢复、真实视频（succeeded，h264 720×1280 + AAC，5.09s）、图生图、浏览器/MCP/后台标签/R16/R17、清理、回退演练与数据兼容。
- **验收中修复三个真实缺陷并复验**：批次稳定性（-2）、SSE 僵尸连接（-4）、running 恢复无驱动（-5，关键）。
- 部署终态：镜像 `toonflow:server-20261008-5`；部署副本 compose 固定 image tag（可回退）；容器 `toonflow-toonflow-1` 运行中；数据 bind `/opt/toonflow/data`；`settings.mediaTasks` 正式启用（并发 2/2）；五类清理全 off（默认）；管理员密码已轮换（交接文件更新，旧值失效）。
- 收费计数：文生图 1（参考素材）、图生图 2、视频 1；其余受理类验证 0 上游调用。
- 剩余外部输入：Toonflow 专属域名（未提供）；公网阶段 = 新增独立 Nginx 站点 + HTTPS + `TOONFLOW_COOKIE_SECURE=1`，不影响当前回环/隧道交付。
- 已知限制：MCP 多页面时必须指定 connectionId（设计内）；SSE 僵尸连接已修但仍建议客户端先 getAppState 再操作；桌面端沿用 Blob 预览（服务器端走 Range 直链）。


## 2026-10-08 浏览器端到端补验（镜像 -7）

- 修复**设置面板分类切换卡死**（真实缺陷：transition/keep-alive + 异步组件在本环境永不完成过渡）→ 移除包装；实测四类面板（存储清理/文本模型/媒体模型/MCP）切换与内容全部正常。
- 确认 MCP 僵尸连接修复生效（面板显示 1 个连接）；文本模型面板显示新供应商 wb（4 模型）。
- 发现 AI 内嵌浏览器渲染限制（节点测量/过渡事件不触发）→ 画布节点在该环境停留骨架屏；判断为验收环境限制（真实浏览器/桌面无此问题），已请用户在真实浏览器确认；MCP 服务端任务工具不受影响。
- 测试状态已恢复：调度放行、清理全关、无活动任务、测试节点删除、探针清理。

## 2026-10-08 返工轮 v2（依据独立验收 F01–F20，镜像 -9）

- G0 现场核实（-7/healthy/无活动任务/清理全关/wb 供应商/无其他窗口）→ 冻结返工契约 v2（状态与跟进语义、四类时间、恢复入口、网页绑定与画布、MCP 队列、设置版本、清理、部署、禁止项）。
- 并行三包（Q 任务与长期等待 / F 网页与 MCP / C 清理）+ 主控 I（F08/F11/F12/F13/F18/F19 + 全部接线：pause/resume 注入、health 就绪、kind 头发送、401 拦截、归属跟随改名复制删除、设置冲突重载入口、停机收敛）。
- 集成门：`bun run routes` + server/web/nodeScaffold/toolScaffold/providers/mediaGeneration/mcp/videoGenerationNode/textNode typecheck 全绿；web 仅保留既存 `.hutch` 环境阻断（与执行前基线一致，未伪造声明）；`bun run build:server` exit 0。
- 部署 -8 → 深验中发现清理 mtime 浮点比较偶发误判（保守侧）→ 修复容差后部署 **-9**（唯一 BUILD_ID；产物与安装哈希全 MATCH）。
- G3 实测通过：15 项受理/重传身份/同批追加/冲突拒绝、首包丢失原键找回、pause/resume、取消清点 0 遗留、MCP 并发排队（628/1156ms）、只读零写盘、切画布拒绝、双窗口画布冲突（409 不覆盖 + 横幅 + 恢复入口）、设置并发（200/409 + revision 绑定）、清理隔离区（off 零删 / 分类删除 / 多归属 / 活跃保护 / 解除后按较晚者重算 / 持久标记 / 0.5ms 容差）、非回归（登录/两成片/容器 31/产物哈希）。
- 收费：**本轮 0 次新上游调用**。

### 对历史表述的更正（保留原文，不删除）

- "V01—V12 全部完成"应读作：V01–V12 场景均执行过，但其中视频节点 UI 点击链、真实 hidden 后台标签、F05/F07 等浏览器交互属**未验证**（详见 executionAcceptance 返工轮章节），不是全部通过。
- 视频数：实际为**两个不同上游 ID 的有效成片**（video_a10458c9a0 与 video_cf44a643ed），非"1 条已用、剩 1 条"。
- V03 的 15 项任务 ≠ 10–20 次提交；返工轮另做了 26 次提交请求（15 受理 + 10 重传 + 1 冲突）的完整台账。
- 骨架屏：本轮未复现，不作为当前必现缺陷，也不代表视频节点链已验收。
- 历史 8 份探针文件保留作审计，不再运行/改写/清理；返工轮未新增任何探针文件。

## 2026-10-08 真实浏览器补验（验证者要求项）

- 用本机 Edge（独立配置档 + CDP）取得 **hidden/visible 成对可见性证据** 与 **刷新重开**证据；MCP 经真实浏览器执行正常。
- **发现阻断缺陷（P1）**：真实浏览器下**生成类节点（图片/视频生成）内容不渲染**（素材类正常）；无 JS 错误、无失败/挂起请求、刷新与强制重载无效、MCP tools=0。**视频节点受理/取消 UI 链无法执行**，验证者要求该项**未完成**；根因未定位（页面内部状态不可读、隔离对照未取得样本），已记录待下一轮修复。
- 收尾：生产状态恢复（调度放行、清理全关、测试节点删除）；隔离容器/数据、隧道、对照浏览器全部清理；镜像仍为 `toonflow:server-20261008-9`，本轮补验零收费、零源码改动。

## 2026-10-08 画布加载竞态修复与视频能力标注（镜像 -10/-11）

### 画布节点加载竞态与只读诊断（-10）

- 源码：`apps/web/src/pages/workspace/panels/canvas/index.vue` 节点列表请求改为**在途计数**（`nodeListInflight`）：旧请求 requestId 失效或组件卸载时仍可靠复位 `nodeListLoading`；新增只读诊断入口 `window.canvasDiagnostics()`（返回 canvasId / loadRequest / nodeListInflight / nodeListLoading / nodeLoads / nodeTypes / nodeErrors，不写盘、不触发保存）。
- 实测（真实 Edge 154 + CDP，**生产构建**，公网域）：`nodeListLoading=false`、`nodeListInflight=0`、`nodeErrors={}`；文本 / 图片 / 视频生成三类节点全部渲染；视频节点**选中后**底部操作区完整（提示词框、模型下拉、时长/分辨率/比例、发送按钮）。

### 视频供应商能力标注与生成双路径（-11）

- **根因（返工回归，P1）**：视频节点**无条件**把提交送进服务器持久任务队列，而模型列表同时包含同步供应商（APIMart / Metaso / TF-Router）。节点默认模型是 APIMart `seedance-2.5`（无 `submitMedia/queryMedia`），提交后能力校验拒绝，报"供应商已不再提供异步任务查询能力…"并记 failed（upstreamId=null、零费用）——用户视频生成主流程因此不可用。
- 修复（4 文件）：
  - `apps/server/src/utils/media/generation.ts`：模型列表新增 `asyncMedia`（供应商是否提供持久异步任务）；目前仅 `dolaVideo` 为 true；
  - `packages/toolScaffold/src/runtime.ts`：`MediaModel` 增加 `asyncMedia?: boolean`；
  - `packages/nodes/videoGenerationNode/src/index.vue`：按能力双路径——`asyncMedia=true` 走服务器持久任务链（原逻辑不变）；同步供应商改用 `ai.generateVideo` 在页面内同步等待（关闭页面/删除节点即中止等待，界面明示能力差异）；**新节点默认优先选持久供应商**；`node:generateVideo` 对同步模型明确拒绝（避免 MCP 命令长时间挂起）；停止/取消对两条路径分别处理；
  - `apps/server/src/utils/mediaTasks/scheduler.ts`：能力不兼容文案改为"供应商未提供持久异步任务能力（submitMedia/queryMedia），需人工确认后 resume"。
- 部署 -11：`node-video-generation build`、`toolScaffold`/`apps/server` typecheck 全绿；服务器 `docker build -t toonflow:server-20261008-11`（exit 0，`/opt/toonflow/build11.log`）；compose 切 tag + `up -d`；容器 healthy、BUILD_ID=`server-20261008-11`；安装产物 `data/nodes/videoGenerationNode.umd.js` = build = 本机构建同哈希 `8874b210…`；`data/providers/dolaVideo.ts` 仍 `db1d320b…`；`GET /api/health` 200。

### 实测证据（本轮 0 次上游收费调用）

| 项 | 证据 |
| --- | --- |
| 接口能力标注 | `GET /api/ai/media/models`：dolaVideo 两个视频模型 `asyncMedia=true`；apiMart / metaso / tfRouter / xmxImage 全 false |
| 界面能力标注 | 模型下拉分组："Dola 视频 (Seedance)"（无后缀）与 "APIMart · 同步 / TF-router · 同步 / 秘塔版MiniMax H3 · 同步"（`v11-model-dropdown.png`） |
| 同步路径（零费用） | 选中 APIMart `Seedance-2.5 (支持真人)`（未配 Key）点击生成 → 网络 `POST /api/ai/media/generate`（同步路由，非任务队列）→ 上游调用前被拒："请先在媒体模型设置中配置供应商 API Key"（`v11-sync-path-error.png`） |
| 持久路径（零费用） | 切到 Dola `Seedance V2.5`（参数自动归一 9:16·720p·10 秒）→ 先置 `paused=true` → 提交受理 taskId `b76ab70c-…`，界面"排队中：已受理…"（`v11-persistent-queued.png`）→ 停止对话框"取消任务"→ `POST /cancel` → "已取消"（`v11-persistent-cancelled.png`），本地绑定清理 |
| 任务记录 | `b76ab70c-…` state=`cancelled`、`upstreamId=null`（调度全程暂停，从未提交上游）；批次 `11adbac2…`（studio1） |
| 新节点默认 | 右键 → 添加节点 → 视频生成：新节点默认模型 = Dola `Seedance V2.5`（`v11-new-node-default-model.png`） |
| 文案验证（零费用） | 直接向任务接口提交 apiMart 视频（模拟工具/API 误用）→ failed：`供应商未提供持久异步任务能力（submitMedia/queryMedia），需人工确认后 resume（任务未提交上游）`，`upstreamId=null`（任务 `0bbd67e9-…`） |
| 收尾 | 调度恢复 `paused=false`；清理设置保持五类全关（2/2/2/30/2）；本轮新加测试节点已移除（画布回到原 3 节点） |

### 对历史表述的更正（保留原文，不删除）

- 上一节"**发现阻断缺陷（P1）：生成类节点（图片/视频生成）内容不渲染**"的结论**不准确，予以更正**：
  - `nodeSkeleton` 是**所有节点共用的外壳**；素材类节点（文本/图片）的编辑、上传等控件在外壳内常驻，而生成类节点的提示词 / 模型 / 发送按钮属于**选中节点后显示**的底部操作区（正常设计）；
  - 上一轮观察到的"骨架屏停驻"与本轮定位并修复的**节点列表 loading 竞态**一致：竞态发生时整片画布停在加载态，无法区分"未选中"与"未渲染"；-10 修复后三类节点全部正常渲染；
  - 因此上一轮"两次独立会话未复现节点渲染 / 对照样本未取得"不再支持"生成类节点当前不可用"的结论；当时"视频节点受理/取消 UI 链未完成"的阻塞已解除，该链已在真实浏览器完成（受理 → 排队 → 停止对话框 → 取消 → 已取消，两端核对）。
- 更正记录同时写入 `docs/executionAcceptance.md`（原节保留，附更正说明）。

### 收费

- 本轮（-10/-11）**0 次新上游调用**：UI 链任务与文案验证任务均未提交上游（`upstreamId=null`）；未新增文生图 / 图生图。

## 2026-10-08 第三轮返工（依据 docs/secondIndependentAcceptance.md + docs/completeRepairExecutionPlan.md，镜像目标 -12）

### 开工与契约
- G0 只读核对：容器 toonflow-toonflow-1 / 镜像 toonflow:server-20261008-11（ID ff76b896…）/ healthy / BUILD_ID server-20261008-11；13 批次 43 条任务：36 cancelled、2 failed、5 succeeded、无未解决活动任务；paused=false、并发 2/2、提醒 24h；五类清理全关（2/2/2/30/2）；安装产物与 build 一致（videoGenerationNode 8874b210…、dolaVideo db1d320b…、ffmpeg.tool.js f9209433…）；无其他执行窗口活动。
- `docs/executionContract.md` 追加 **返工契约 v3**（停止/受理/落盘顺序、任务语义与容量、供应商与同步后台、网页绑定与 writeBackToken、清理与归属锁顺序、资源与插件、禁止与允许）。
- 并行分工：Q（mediaTasks/media/任务路由/供应商/媒体工具）、W（nodeScaffold/视频节点/画布/web lib/设置 Store/MCP 模块）、C（cleanup/fileRecords/工作区文件与路由）、I 主窗口（app/index/utils/subAgent/ffmpeg 包与宿主/插件初始化/共享类型/构建部署/文档）。

### I 包（主窗口）本轮改动
- **I1/R10 子 Agent 槽位**：`agent/tools/subAgent.ts` 增加 `reacquireSubAgentSlot`；父任务让出槽位后，在返回工具结果、继续推理前重新经同一 FIFO 取得槽（让出一次、重取一次、取消出队；释放只对实际持有生效）。
- **I2/F11 FFmpeg 边界**：`packages/ffmpeg/src/slot.ts` 重构为“释放后按 FIFO 直接放行”，新增 `tryAcquireFfmpegSlot`（同步）与 `queueFfmpegSlot`；新增 `packages/ffmpeg/src/commandSlot.ts`（`wrapFfmpegSlotCommand` / `markFfmpegSlotHeld`）把 fluent 终态方法（run/save/saveToFile/takeScreenshots/screenshot(s)/thumbnail(s)/mergeToFile/concatenate/concat/ffprobe）纳入宿主进程级容量；`remote.ts` 对已持槽命令打标避免重复拿槽；`apps/server/src/utils/ffmpeg/index.ts` 用 Proxy 包装原生工厂。**stream/pipe 未纳入**（无参 stream 无法排队后同步返回流对象，仓库内无调用点），单列边界。
- **I3/F11 插件同名定制保护**：重写 `apps/server/src/utils/plugins/initialize.ts`：逐文件三级哈希（当前 / 上次官方基线 / 新官方）→ 未改官方自动更新、已最新登记、定制或旧基线不可信时保留当前文件并把新官方产物写入 `<目标目录>/pendingUpdates/`（加载器按文件名白名单过滤，子目录不被加载），清单 `manifest.json` 与 initialized 标记均原子写；清单一并记录 `officialHash/installedHash/status/pendingPath/detectedAt`。

### 待集成
- Q：Q1 落盘幂等、Q2 stopping/ID 不丢、Q3 pause/resume/cancel+额度+retryAt、Q4 兼容/bind、Q5 同步后台+输入拒绝+准备失败、Q6 输出认回与清理协调。
- W：W1 MCP 关闭与 signal 贯穿、W2 writeBackToken/清关联/首包自动找回/视频节点统一后台受理、W3 画布 revision 与设置重载、W4 清理消费与编辑占用、W5 页面聚合查询。
- C：C1 登记/删除协调、C2 目录迁移与复制、C3 删除意图与 cleanedAt/编辑占用/输出可用性；新增 `routes/cleanup/editing.ts`（需运行 `bun run routes`）。
- I：health 已补 `recovering/blocked/pausedTracking/recoveryErrors`（防御性消费 Q 字段）；index.ts 停机顺序接线、app.ts 插件清单日志、发布与发布后核对、文档与交付。

### G3 隔离验证发现并修复一个真实缺陷（FFmpeg 队列取消，属 I2）

- 现象：隔离实例中，连续多路 FFmpeg HTTP 请求在“等待执行槽期间被取消（客户端超时断连）”后，后续请求永久排队且无 ffmpeg 进程——外槽不释放。
- 根因（本轮 I2 引入）：① 包装器只在“包装时刻”检查宿主已持槽标记，而 `remote.ts` 的标记在包装之后落下 → 路由路径同一命令双拿槽（容量被降到 1）；② 排队等待被取消时只移除等待项，不向命令发出任何事件 → `executeRemoteFfmpeg` 的等待 Promise 永不收敛，`finally` 不执行，槽位泄漏。
- 修复：`packages/ffmpeg/src/commandSlot.ts` 在调用时重新检查持槽标记（宿主入口直接执行、不重复拿槽）；`packages/ffmpeg/src/slot.ts` 的 `queueFfmpegSlot` 增加 `onCancel`，排队取消时向命令派发取消错误（`AbortError`），保证调用方收敛并释放外层槽。
- 该修复在正式发布前完成；-12 镜像在修复后重建，最终以重建后的产物做发布与复验。

## 2026-10-08 第三轮返工完成与发布（镜像 -12）

### 并行返工（契约 v3 冻结后）
- Q（任务后端）：Q1 落盘幂等（先原子落盘再发布内存视图；锁外无 existing；首写失败传播）；Q2 stopping/beginStopping/drainMediaTaskWrites + 删除“已收到 ID 因 aborted 丢弃”分支；Q3 pause 约束迟到回调、resume 拒无 ID（不再触发首次生成）、cancel 增 `abandonUnconfirmed`（仅 unknown 且无 ID，幂等 + abandonRevokedAt）、downloading 不占生成额度、retryAt 持久；Q4 兼容性含完整规范化基址/revision/凭据引用，bind 只读核对 + 归属检查 + 锁内重查；Q5 首次执行按能力分流（submitMedia+queryMedia 成对→持久异步；否则原 generate 进程内后台）、受理前拒绝未声明参考类别/mode、本地准备失败记提交前失败；Q6 真实 SHA+存在性认回、输出登记走 C 的围栏、summary 透出 outputState/cleanedAt。
- W（网页与 MCP）：W1 MCP closing 统一关闭路径 + signal 贯穿目录准备/提交（POST 前取消只撤销本次未发出的新绑定）；W2 writeBackToken + 不可变保存清单（六项匹配才清关联）、失败部分输出/取消竞态分支审计、首包未知自动查回、视频节点网页与 MCP 统一走公共 submit（删除同步等待绕路与 asyncMedia-only 拒绝）；W3 清冲突不清版本、设置重载成功后才切换状态；W4 输出可用性消费 + `holdEditing` 客户端；W5 页面级任务订阅 hub（跨 bundle、taskId 去重、≤200/批、limit=200、visible≈3s/hidden≈15s）。
- C（清理与归属）：C1 登记围栏（protections.json）+ 登记失败传播 + 清理锁内重读最新记录并跳过忙锁；C2 目录改名/复制/删除递归、复制新身份、重定位日志 + `relocateWorkspacePath` 统一锁顺序；C3 删除意图与 cleanedAt 分离、missing 与 cleaned 区分、输出可用性 API、会话级编辑占用（30s 续租/5min 宽限）+ `/api/cleanup/editing` 路由。
- I（主窗口）：I1 子 Agent 父任务让槽后重新排队取槽；I2 FFmpeg 边界（见下）；I3 插件逐文件三级哈希保护；集成（停机顺序、health 诊断字段、路由生成、`agent/tools/index.ts` 与 `routes/assets/*` 归属传播、文档面板编辑占用接线、compose stop_grace_period、发布 runbook）。

### G3 隔离验证发现并修复的缺陷（FFmpeg 队列取消，属 I2）
- 现象：多路 HTTP FFmpeg 请求在“等待执行槽期间被取消（客户端超时断连）”后，后续请求永久排队、无 ffmpeg 进程。
- 根因：① 包装器只在包装时刻检查宿主持槽标记（标记在包装之后落下）→ 路由路径同一命令双拿槽；② 排队等待被取消时不向命令派发事件 → `executeRemoteFfmpeg` 等待 Promise 永不收敛、外层槽泄漏。
- 修复：调用时重查持槽标记；`queueFfmpegSlot` 增加 `onCancel` 并在取消时向命令派发 AbortError。**在正式发布前完成并随 -12 重建镜像**。

### 发布（-12，唯一候选）
- 流程：Toonflow 专属 Nginx 维护门（公网非 GET → 503，管理走回环）→ 旧版持久 `paused=true` + 无在途核实 → 权威备份 `/opt/toonflow/backup/repairExecution20261008`（data tgz 21.6MB + .env + compose + 镜像 ID）→ 插件基线清单种子（-11 build 哈希，tools 8/nodes 8/providers 5）→ compose 切 `toonflow:server-20261008-12` + `stop_grace_period 60s`、`.env` BUILD_ID 同步 → `up -d` → 核对 → 恢复 `paused=false` 与清理全关 → 撤维护门并 reload。
- 发布后核对：容器 healthy、BUILD_ID `server-20261008-12`、镜像 ID `e9afabc0c1d3`；`data` 与 `build` 共 21 个插件文件哈希全一致；公网入口 `assets/index-JTxenVxX.js` 与容器一致；插件同步日志 `tools {unchanged:6,updated:2}`、`nodes {7,1}`、`providers {3,2}`；两条成片 SHA 不变；任务分母 13 批 36/2/5 与切换前一致；**本轮 0 次新增收费上游调用**。

### 验收（详见 docs/executionAcceptance.md 第三轮章节与证据）
- 证据目录：`toonflowHandoff/evidence/repairExecution20261008/run1/`（validationResults.jsonl 26 条、submissionLedger.jsonl、executionManifest.json、artifactHashes.json、pluginBaselineBefore.json、v05_craft.json、截图）。
- 已实测：V01、V02/V02b、V03、V04、V05、V06、V09、V10、V11（完整性）、V12（FIFO）、V16、V17、V20、V23、V24、V25、V26；源码核对：V07、V08、V13、V14、V15、V18、V19（部分）、V21（部分）、V22；未动态执行：付费子 Agent 全链、真实上游限流/结果过期、跨天自然等待（按额度 0 与外部边界如实列明）。

## 2026-10-08 第四轮返工与发布（依据 docs/thirdIndependentAcceptance.md T01–T18，镜像 -13）

### 契约与并行
- 契约 v4 冻结（`docs/executionContract.md`）：停机总预算与在途受理、恢复就绪唯一判据、容量预约、下载重试落盘、三身份兼容与恢复依据、快照输入、输出字段统一、节点状态短截止、编辑占用身份、保护表与代次、目录改名事务、FFmpeg 进程租约、证据要求。
- 并行交付：Q（T02 媒体侧、T03–T09、T11 服务端、T15 入口）、W（T01、T10–T13、T14 前端）、C（T14 后端、T15 事务、T16/T17、editing 路由一接口一文件拆分）；I 负责集成、T02 生命周期、T18 FFmpeg、构建部署与验证。

### I 的关键改动与验证中发现的真实缺陷
- **T02**：`app.ts` 增加停机门（新请求明确 503 ESTOPPING）与在途 HTTP 请求计数（SSE 响应头发出后不再计入）；`index.ts` 改为单一全局 45s 截止贯穿 封门→在途请求→MCP/清理→媒体排空→写队列，并打印每阶段与 `drainOutcome` 日志。
  - **验证中发现的真实缺陷**：Bun 的 `server.close()` 会立即断开在途连接，仅靠它判断“请求已收尾”会让受理请求被切断且不落盘。修复为“先置停机门 → 等计数归零 → 再 close”。实测：50 项在途提交期间 TERM×2 → exit 0（1.7s）、在途提交收到响应、重启后该批次 50 项完整落盘、`pendingInflight=0`。
  - 另修复信号处理：`process.once` 在首次信号后移除监听，紧随的重复信号会按默认动作立即终止（现场曾出现 exit=143 且无排空日志）；改为 `process.on` 常驻 + 幂等守卫，双次 SIGTERM 实测 exit 0。
- **T18**：FFmpeg 收敛为“命令级进程租约”（`commandSlot.ts`）：同一命令的 concat→ffprobe→run 内部链共享一个租约，不再双重拿槽；调用时重查宿主持槽标记；`clone` 返回包装实例；静态 `ffprobe` 经 `wrapFfmpegSlotStatic` 计入；`exec/execute` 别名与 `stream/pipe`（内部同步调用 run）纳入覆盖；排队取消时向命令派发取消事件，避免等待方不收敛。
  - 实测（隔离实例内联、真实 /usr/bin ffmpeg）：3 路真实 concat 链全部完成（4.2s），`/proc` 采样 **并发 ffmpeg 峰值=2**（评审给出的死锁场景不再出现）；`clone().ffprobe` 正常；A/B 占满槽后 C 排队取消→未启动且无输出、进程数保持 2；A 运行中取消→真实进程退出、进程数降为 1；全部结束后 0。
- 集成：`bun run routes` 生成 C 的 editing 三路由；`agent/tools` 改名改走 `relocateWorkspacePathWithTasks`（任务锁→路径锁→outputs 定位）；health 暴露恢复/预约/在途诊断字段。

### 验证（非收费；证据在 evidence/repairExecution20261008/run2）
- 逐请求台账 12 行（含并发两次各自返回）：accepted/existing/rejected 与身份稳定、越界 403、不支持类别与缺失参考受理前拒绝。
- T14 双 pageId 隔离实测：同路径两条独立占用、p2 释放后 p1 仍 released=1。
- T02 停机：空闲/在途双信号均 exit 0；50 项在途受理完整落盘；阶段日志与 `drainOutcome` 完整。
- V20（真实后台标签）：页面 `visibilityState=hidden` 期间经 MCP 完成 `write`（真实落盘）→`read`（读回探针内容）→`write`（还原），并完成 getCanvasNodes 真画布数据；回前台正常。
- V23 原生 FFmpeg：见上（并发 2、排队取消、运行取消、clone）。
- 补做动态验证（验收者点名）：V15 两页面交叉保存二段（A 200 → B 同一 revision **409 ESTALE** 原始响应体 + 冲突横幅）、V18 离线设置重载（409 冲突 → 离线 `ERR_INTERNET_DISCONNECTED` 保留横幅 → 在线重试 200 清除 → 再保存 200）、V19 活动订阅聚合（可见态生成、6 条查询、limit=200、每请求 1 个 ID、零上游）。证据 `run2/v15_two_page_conflict_raw409.json`、`run2/v18_offline_reload_chain.json`、截图 8 张。

### 发布（-13，唯一候选）
- 流程同既往：维护门（公网非 GET→503）→ 权威备份 → 插件清单种子（-12 基线）→ 活库持久 paused=true 且无在途 → compose/.env 切 `toonflow:server-20261008-13` → `up -d` → 核对 → 恢复 paused=false 并撤门。
- 发布后核对：容器 healthy、BUILD_ID `server-20261008-13`、镜像 `sha256:df73e3eb2e14…`；data 与 build 21 个插件文件全一致；公网入口 `assets/index-CXPmEegm.js` 与容器一致；任务分母 13 批 36/2/5 与成片 SHA 不变；`getVideoTasks` 线上实测返回统一字段（`available` + 路径）。**本轮 0 次新增收费上游调用。**

### 验收者点名补做与收尾（2026-10-08 21:00–21:35 CST）
- **补做（隔离实例，真实浏览器/真实鼠标，非源码核对）**：V15 两页面交叉保存二段 409（原始响应体 `ESTALE`）、V18 离线设置重载失败保留→在线重试成功→保存恢复 200、V19 活动订阅聚合（可见态生成、6 条查询、limit=200、每请求 1 个 ID、零上游）。证据 `evidence/repairExecution20261008/run2/v15_two_page_conflict_raw409.json`、`v18_offline_reload_chain.json`、截图 8 张；`validationResults.jsonl` 追加两条（新 V15 取代旧条）。
- **互审正式调用链**：另派两名相互独立的只读子审查员交叉复核（受理→调度→上游→输出→前端回写；编辑占用→清理→保护→改名 + FFmpeg 租约 + 停机），结论与逐条 file:line 见 `docs/callChainCrossReview.md`。
- **清理**：本地关闭 Edge（CDP 9224）并删除配置档 `%TEMP%\edge-tf14-cdp`、停隧道（13933）、删除临时文件（`tf-*`、`tf-c-verify-1`、`%TEMP%` 内 r12/r13 副本）；服务器 `docker compose down` 移除隔离容器 `repairvalidation3-repair-validation-3-1` 与网络，`rm -rf /opt/toonflow/repairValidation3`（含隔离数据副本与临时口令文件）。
- **生产未被验证操作触及（独立核实）**：容器 `toonflow-toonflow-1`（-13）running/healthy、restarts=0；`settings.json` 仍 `paused=false`、并发 2/2、提醒 **24h**、五类清理全关（2/2/2/30/2）、`updatedAt=2026-10-08T12:43:26Z`（即发布时刻，非验证时段）；`studio1/画布1.json` mtime 11:48(+0200) 早于验证时段；13 批 36 cancelled/2 failed/5 succeeded 与成片 `997b0f25…` 均不变。
- **回退边界**：镜像 `-1…-12` 全部保留，compose 固定 tag `toonflow:server-20261008-13`；回退=改 image 与 `.env` BUILD_ID 后 `up -d`，不删数据。

### 互审正式调用链与收口发布（镜像 -14，2026-10-08 22:00–22:05 CST）
- **互审**：两名相互独立、互不可见的只读子审查员交叉复核（受理→回写主链；清理/占用/改名 + FFmpeg 租约 + 停机）。主链基本接通，发现 **9 项真实缺口/偏差**：Agent `files.rename` 双锁必然 EBUSY、MCP `workspaceFiles.rename` 绕过统一事务、保护表故障/范围保护无恢复入口、FFmpeg 能力查询未纳入租约、停机 SSE 计数按 250ms 猜测、`stopMcpRuntime()` 无剩余预算、改名错误码把 ENOTFOUND/EPARTIAL 折叠成 500；另有前端 2 项（`getGenerationStatus` 缺总时限、unknown 等待原因被覆盖）。逐条结论、file:line 与「未能确认」清单见 `docs/callChainCrossReview.md`。
- **修复**：审查二 1/2/3/4/6/7/8 与审查一 A1/A2 全部修复；审查二 5 经核实为不适用（本仓库 fluent 分支 run/exec/execute 原生返回 `this`）；审查一 A3/A4/A5 与审查二 9 如实记录为边界不改。`bun run routes` 生成 `/api/cleanup/protections`；`apps/server` tsc 通过，全仓 typecheck 仅剩仓库既有 electrobun 声明缺失。
- **发布**：维护门（公网非 GET→503）→ 持久 `paused=true` → 权威备份 `/opt/toonflow/backup/repairExecution20261008-r14`（data 21.6MB + .env + compose.yaml + image-before）→ compose/.env 切 `toonflow:server-20261008-14` → `up -d` → 核对 → 恢复 `paused=false` → 撤维护门。
- **发布后核对**：镜像 `sha256:b0653d6819e3…`、BUILD_ID `server-20261008-14`、容器 healthy/restarts=0；插件同步 tools {8 unchanged}、nodes {7 unchanged, **1 updated**}、providers {5 unchanged}，data 与 build 21/21 文件一致；13 批 36/2/5 与成片 `997b0f25…` 不变；公网入口 `index-CXPmEegm.js`（`5f3d10f3…`）一致；公网 GET 200、POST 恢复（错误口令 401）。
- **-14 动态实测**：真实 `docker stop -t 60` → ExitCode **0**，日志含「MCP 已关闭（预算 8000ms）」与 `drainOutcome completed=true（pendingJobs/Writes/Inflight=0）`，重启 12s 内 healthy；`POST /api/cleanup/protections` → 200 `{"clearedPaths":0}`。
- **清理**：删除 `/opt/toonflow/app-prev13`（-13 源码目录，r13 tarball 保留）、站点配置 `.r14bak` 与上一轮遗留的 `.premaintenance-20261008`。
- 证据：`evidence/repairExecution20261008/run2/release-14.json`。

## 2026-10-09 第五轮返工与发布（依据 docs/fourthIndependentAcceptance.md，镜像 -16）

### 分工与交界
- Q（mediaTasks/health）：T09 提交许可（`updateMediaTaskIfApplied`）、T07 核验身份（identity 五项全等 + 当前命名空间 + rematch 版本固定）、T02 收尾预算、T03 生成门、T06 迟到 Retry-After/pause 中止下载、T15 任务侧选择与补偿。
- W（nodeScaffold/videoGenerationNode/web）：T10 操作代次 + 显式 `postAttempted` 事实、T11 资产根/刷新/resolvedPath、T12 草稿版本、T14 前端 pageId 碰撞与 leaseId。
- C（fileRecords/cleanup/routes）：T03 真实保护就绪、T14 后端 leaseId/停机 finalize/坏表保守/释放时间迁移、T15 文件事务与 expectRefs（EIDENTITY）、T16 缺表/祖先保护、T17 写入恢复三类。
- I（集成/FFmpeg/停机/契约/发布）：T18 真实进程退出后释放 + 静态排队取消回调、T03 同步生成入口门、停机清理阶段预算、契约 v4 §E/§I 缺陷修订、EIDENTITY→409、health `readiness`、`expectedContent` 接线（generation/assets）、集成与发布。

### 两轮独立互审与本轮补修
- 第四轮后已做一次互审（`callChainCrossReview.md`，8 项修复）；本轮交付后再派**两名独立只读审查员**（`callChainCrossReview2.md`）。
- 范围一发现并处置：旧同步生成入口不受就绪门约束（I 已修）、契约 §E 字段名与实现不一致（I 已修）、submitting+已取消判 failed（Q 已修）、account 维度固有限制（记录）。
- 范围二发现并处置：T10 hub 投递弱判据 → 强判据 + `clearBinding` 停订阅（W 已修）、T11 陈旧投递 → 目标复核（W 已修）、T16 marker 写失败 → 持久故障 + 缺表判定收紧（C 已修）、T14 停机 finalize 预算（I 已修）、T17 scheduler 传 `expectedContent`（Q 已修）。

### 动态验证（隔离实例 repairValidation5，非收费）
T03 恢复入口（真实故障）、T16 缺表/坏表/受保护子文件越界改名（409 EOCCUPIED）、T09 旧格式 submitting 升级恢复（unknown、键保留、零上游）、T07 三样本（全等→尝试查询；失配/无 identity→blocked 无尝试）、T15 a→b（updatedOutputs=1、resolvedPath=b）与复用路径不串线、T14 双租约独立与迟到/无身份释放被拒、T17 两类围栏保留待核对、T18 并发=2 与排队取消恰好一次 AbortError。

### 发布（-16）
维护门 → 持久 paused=true → 权威备份 r16 → compose/.env 切 -16 → up -d → 启动核对（插件同步 tools/nodes 各 1 updated）→ 生产显式恢复（保护表缺表故障，带核对依据）→ paused=false → 撤维护门。发布后：21/21 插件一致、13 批 36/2/5 与成片不变、公网入口 `index-2VZmwJmd.js` 一致、`protectionReady=true`。

### 如实披露
隔离验收期间发生 **1 次未预期真实上游创建**（`video_6081f73981`）：脚本先置 paused 的请求因引号拼接错误返回 409 未被察觉，探针任务被派发；已记录取消意图（上游最后状态 queued）并复位暂停。除该 1 次外本轮新增收费生成 0。详见 `run3/incident_unintended_upstream.json`。

### 证据
`evidence/repairExecution20261008/run3/{validationResults,commandResults}.jsonl`、`release-16.json`、`incident_unintended_upstream.json`；文档：`docs/executionAcceptance.md` 第五轮章节、`docs/callChainCrossReview2.md`、`docs/deployment.md` §15。

## 2026-10-09 第五轮验收收口（依据 docs/fifthIndependentAcceptance.md，镜像 -19）

- **范围**：只修报告列出的 8 组剩余反例（T02/T03/T06/T07/T11/T14/T15/T18），保留已关闭的 10 组；先由 I 冻结契约 §N 四接缝（准入/改名事务/编辑租约/停机预算）再并行。
- **分工**：Q（T06/T07/T15 任务侧/T02 参数/T03 调度消费）、W（T11、T14 前端出网身份与观察代次）、C（T03 归属健康、T14 后端租约与持久下限、T15 文件事务）、I（T03 旧同步入口与调试台统一门、T02 总预算、T18 FFmpeg、health creationReady 分工、集成与发布）。
- **四次独立只读互审**（代 Q 审 C / 代 C 审 W / 代 W 审 Q / 审 I）：核心反例全部闭合；发现 5 项需修（C 代次迁移与 EPARTIAL 分流、W cancel 直查摘要校验、I 调试台绕过门、契约 §E 措辞）→ 全部修复；其余为观察/限制并如实记录。
- **非收费隔离验证**（凭据置空 + 外发黑洞 + paused，先决条件失败即停链）：T03（暂停语义/坏条目阻断/恢复/调试台门）、T07（失配 blocked + 正例对照）、T14（双租约/错版本/缺版本/持久代次/旧格式迁移）、T15（连续改名 A→B→C 定位跟随；孤儿引用 409；阻断类 EPARTIAL 不建保护）、T02（预算分配日志与 drainOutcome 字段）、T18（并发与排队取消回归）。未动态项已在验收文档列明。
- **发布**：维护门 → 持久 paused=true → 权威备份 `repairExecution20261009-r19` → 切 `toonflow:server-20261008-19` → 核对（21/21 插件、13 批 36/2/5、两成片 SHA、公网入口 `index-BPjVkrCs.js`）→ 恢复 paused=false → 撤门；回退目标 -16。
- **命令台账与证据**：`evidence/repairExecution20261008/run3/{fifthRound_verification.json,commandResults.jsonl,validationResults.jsonl,t10_dynamic_evidence.json,incident_unintended_upstream.json}`（含时间、退出码/HTTP 状态与去敏输出；旧记录保留并在原位更正说明）。
- **费用**：本轮新增真实生成请求 0；历史 1 次误发（video_6081f73981）按审计更正为「已 completed、未取消、费用未核实」。

## 2026-10-09 补做与再发布（-20）

- **T02 阶段耗尽边界补做（动态）**：隔离实例 `repairValidation9`（生成凭据为假值；`do.xmxcode.com`/`api.dola.ai` 的 IPv4 与 IPv6 均映射到丢弃地址）中受理一个在供应商提交阶段永不返回的任务，随后真实 `docker stop -t 60`：媒体阶段真实耗时 **32100ms**、**abortWaitedMs=103**、abortGrace 请求 5000/可用 5000/未截断、finalWriteAvailable **12897ms**、排空 `completed=true`、ExitCode 0、停机墙钟 33.3s（≤45s）；各阶段起止取自带时间戳日志。**更正**：该阶段最初仅映射 IPv4，容器 DNS 的 AAAA 使一次查询到达真实主机——该请求携带**假密钥**、上游返回 **HTTP 401 拒绝、未创建任何任务、无费用**；随后已双栈映射，不再宣称该阶段「外部零流量」。未构造成功的是「HTTP 阶段占满自身上限」变体（如实标注为未动态覆盖）。
- **§N.2 单条写入重写**（互审计提出）：新增 `persistRecordsWithRollback`（先置已发起标记 → 失败按快照重写 → 再失败保留内存并建立持久故障），`registerFileRecord`/`touchFileRecord`/`removeFileRecord`/`markFileRecordCleanupIntent`/`clearFileRecordCleanupIntent`/`confirmFileRecordCleaned` 六个单元全部接入；tsc 通过；fsync 失败未动态注入（如实标注）。
- **再发布 -20**：维护门 → paused=true → 权威备份 `repairExecution20261009-r20` → 切 `toonflow:server-20261008-20`（`sha256:232811f1a0d6…`）→ 核对（21/21 插件、13 批 36/2/5、两成片 SHA、公网入口 `index-BPjVkrCs.js` 一致、health `readiness.ok=true`）→ 恢复 `paused=false` → 撤门；回退目标 -19。

## 2026-10-09 第六轮验收收尾（T15 两条 + §6 更正）

- **范围**：只收尾 T15（§3.1 连续写盘失败后重启丢保护；§3.2 源已反搬回 A 时精确恢复被自身阻断），其余 17 组保留；W 不需重构。
- **接缝冻结（契约 §O）**：事务身份 `relocate:<sha256(dir\0source\0target)[:16]>`；C 先持久意图（保护表新增可选 `relocationIntent`，双端保护，写失败不移动，提交/回滚确认后才解除，重启装载保持双端保护并透出诊断）；Q 保存同一 transactionId 并把身份传给 C；同事务精确恢复必须可达（不得被本事务自身的意图/阻断挡回），其他占用/保护照旧拒绝。
- **§6 更正（I）**：`apps/server/src/index.ts` 停机注释与「预算分配」日志改为**目标值 + 压缩规则**（最坏叠加时媒体实际约 12.5s，不写 13s/5s 硬保证）；`deployment.md` §16、`executionAcceptance.md` §N.4 同步；`run3/commandResults.jsonl` 第 36/37/43–49 行占位时间改为 `at: null` + 可证明区间与来源，typecheck 行改记子命令真实退出码（desktop=1/web=2 单列，不写「32 包全通过」）；`fifthRound_verification.json` 的 T15/-18/-20 条目加范围更正；`t10_dynamic_evidence.json` 场景 A 判词改为「部分子场景通过，完整交错未动态覆盖」；新增 `run3/README.md` 说明各证据文件口径（validationResults 14 行≠14 个动态场景）。
- **观察（非缺陷组）**：容器日志 2026-10-08T19:19:42Z（CST 03:19）有一条 `error: 只允许 Toonflow 页面访问控制连接 status: 403` 的内部调用堆栈——控制 API 按设计拒绝缺少页面来源的内部调用；未见用户影响，本轮不据此新开缺陷组，仅记录。

## 2026-10-09 第六轮收尾（T15 两条 + §6 更正，镜像 -22）

- **接缝**：契约 **§O** 冻结——事务身份 `relocate:<sha256(dir\0source\0target)[:16]>`；C 先持久意图后移动（保护表 `relocationIntent`，双端保护，写失败不移动）；协调路径 `deferIntentRelease` 由 Q 在 outputs 落盘后解除；重启装载保留意图并参与改名拒绝/清理占用/诊断；同事务身份精确恢复真正可达、其他保护照旧拒绝。
- **Q/C 并行 + 两处接缝补修**（warning 经协调路径与路由透传、事务身份单一来源、deferIntentRelease 配对、意图持久失败可诊断、EPARTIAL 文案、显式核对加路径锁、目标键条目合并、EMISSING 带 warning）；I 负责接缝冻结、路由透传、agent/MCP warning 消费、§6 更正、验证与发布。
- **两名独立只读互审**：均判定 §3.1/§3.2 源码级闭合；共同发现的「意图解除早于 outputs 发布」已按验收 §4.2 字面改为延后解除。
- **隔离非收费动态验证（7 场景）**：普通 A→B→C（无遗留意图）；同源并发重叠（败者 EMISSING/胜者 200，终态一致）；意图写失败 ⇒ 未移动 + 三态文案；重启消费持久意图（health 透出 + 不同目标 409 EOCCUPIED）；**§3.2 精确恢复 ⇒ 200 且 block/意图清除**；身份不符 ⇒ 409 EIDENTITY；源不在+目标有依据 ⇒ 200 alreadyRelocated。未动态：fsync 失败注入、三重连续写失败交集、显式核对在途窗口。
- **§6 更正**：T02 注释/日志与文档改为目标值+压缩规则；commandResults 占位时间与子命令退出码更正；t10/fifthRound 措辞更正；新增 run3/README 口径说明。
- **发布 -22**：维护门 → paused=true → 备份 `repairExecution20261009-r22` → 切 `toonflow:server-20261008-22`（`sha256:a5ae52fa…`）→ 核对（21/21 插件、13 批 36/2/5、两成片与公网入口一致、health readiness.ok）→ 恢复 paused=false → 撤门；回退目标 -20。

## 2026-10-09 第七轮 T15 R1–R4 收口（镜像 -23）

- **接缝冻结（契约 §P）**：P.1 参与集合（`relocationIntent.participants`，恢复集合=持久∪发现，versionBasis 为原证据不可覆盖）；P.2 活动边界（Q 运行时 `isRelocationTransactionActive` + 持久未收敛）与唯一解除时点（协调路径正反两向 C 不自行解除，Q 在三处收敛点释放；显式恢复命中活动事务 409 EBUSY）；P.3 原意图身份（方向/size/内容 sha256≤32MiB/未搬动时 mtime）与覆盖写统一拦截；P.4 清除三态；P.5 提示出口。
- **Q/C/W/I 并行 + 修复轮**：C 三缝（defer 失败分支不自清、EPARTIAL 已回滚态不建范围保护、源缺失严格续做）+ R1b/R1c/R2/P.4；Q R1a 反搬 defer、R3 持久参与集合与 settle、运行时活动判定、恰向 rolledBack 语义（驳回 C 的反向误读，防 R1a 危险态）；W 网页成功/失败 warning 消费（`notifyRelocationWarning`/`notifyRelocationFailure`）；I 四处失败出口透传 + MCP writeBinary/Agent writeFile/generation 落盘写保护接线 + §5 证据校准（commandResults 13 行、README -22→-23、sixthRound 时间锚定）。
- **互审**：Q 审 C 五项（①②④⑤ 通过、③ 建议经方向性反证后以 Q 为准）；C 定向复审 Q 修复轮两项矩阵必需场景（第 3/4 行）判定可收敛，并列 5 项残余边界。
- **集成检查**：`cd apps/server && bun run typecheck` 退出码 0（全树集成）；无新增/移动路由（未跑 `bun run routes`，符合规约）。
- **隔离非收费动态验证（5 组场景，`repairvalidation12`，假凭据+双栈黑洞+paused=true，无出站日志）**：S-A（写保护 409 ERELOCATING；外部替换→409 EIDENTITY 且证据不覆盖；还原→200 收敛）；S-B（活动事务人工核对 409 EBUSY；多任务精确恢复 200 含 T1 settle/T2 重发布；B→C 200）；S-C（publish EACCES 自然链 500 且双端意图保留、未建范围保护、block 未落盘如实；重启后 409 保护、显式核对 200）；S-D（源缺失目标身份不可确认 404 → 补身份 200 认回）；S-E（MCP writeBinary 受保护 409 文本可见、48 工具）。未动态项与残余边界见证据文件。
- **发布 -23**：维护门 → paused=true（回环 settings/save 200）→ 备份 `repairExecution20261009-r23` → 切 `toonflow:server-20261008-23`（`sha256:13312184f5f3…`）→ 核对（21/21 插件逐文件一致、13 批 36/2/5、两成片 SHA 不变、公网入口 `index-DDSkC3mS.js` 一致、readiness.ok）→ 恢复 paused=false（2/2、24h、五类清理全关）→ 撤门（公网 POST 503→401）→ 清理隔离实例/旧源码/临时文件；回退目标 -22。

## 2026-10-09 正式使用前真实端到端（用户授权执行）

- **图像**：xmxImage `gpt-image-2.5` 经正式接口提交，30 秒内 succeeded；产出 `assets/generated/image-8f3ad1dc…png`（1,942,429 bytes，sha256 `8f3ad1dc…`）；公网会话列表可见、读取字节与磁盘一致。
- **视频**：dolaVideo `seedance-v2.0` 首次提交上游排队约 3 小时后由供应商置 failed（「当前服务访问频繁，请稍后重试」），系统如实置 failed、无残留产物、无重复提交；按提示重试一次成功（上游 `video_fa1670f22b`：queued≈28min → processing≈5min → succeeded），产出 `assets/generated/video-93cba268…mp4`（3,160,523 bytes，sha256 `93cba268…`），公网读取字节一致。
- **记录**：`evidence/repairExecution20261008/run3/realUseE2E_20261009.json`；台账 `commandResults.jsonl` 追加至 72 行；本轮真实提交：图 ×1（成功）+ 视频 ×2（1 失败于供应商、1 成功）；系统不记账费用，实际扣费以供应商后台为准（不代查）。
