# Toonflow 服务器二改 · 验收记录（G3）

日期：2026-10-08（Asia/Shanghai）。主控统一计数收费调用；凭据不出现在本文与聊天。
证据目录：`E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/`。

环境：服务器 152.53.170.228，镜像 `toonflow:server-20261008-3`（Docker 项目 `toonflow`，容器 `toonflow-toonflow-1`，回环 `127.0.0.1:3930 → 3000`）。
验收方式：服务器本机 HTTP/MCP + 浏览器（SSH 隧道）。
调度：验收期间 `settings.mediaTasks.paused=false`（仅放行批准的收费任务；验证项在提交后全部取消）。

## V01 认证与 Token（通过）

| 检查 | 结果 |
|---|---|
| 未登录访问 `/api/settings/get`（同源头） | 401 `{code:401}`（认证门在 body 解析前拦截） |
| 错误密码登录 | 401 "账号或密码错误" |
| 正确密码登录 | 200 + `Set-Cookie`（HttpOnly 已核） |
| 已登录同源读取设置 | 200 + `x-toonflow-settings-revision` 响应头 |
| 登出后再次访问 | 401（会话已销毁） |
| MCP 错误 Token `initialize` | 401 |
| MCP 正确 Token `initialize` | 200 + `mcp-session-id`；`tools/list` 返回 46 个工具 |
| 前端页面可加载 | `https://`/隧道下 200（未登录显示登录页，见 V10） |

## V02 双窗口设置冲突（通过）

- 客户端 A 用 revision R1 保存（cleanup.text.days=3）→ 200 + 新 revision R2。
- 客户端 B 仍用 R1 保存（days=7）→ **409** + `currentRevision=R2`，未写入。
- 复核服务端值 = 3（B 的修改未覆盖 A 的新设置）。
- 恢复原值成功。证据：`v02_result_20261008.txt`。

## V03 受理/去重/查询（通过，15 项 + 重传 + 冲突 + 追加）

- 15 项视频任务经 MCP `submitVideoTasks` 受理（10 + 5 追加），调度暂停下保持 queued，**无上游收费请求**。
- 同 batchKey+itemKey+同参数重传 → 全部 `existing`，taskId 一致；**batchId 稳定复用**（修复后）。
- 同键不同参数 → `rejected`（"同一 itemKey 已提交过不同参数的请求"）。
- batchId 分页查询与 taskIds 精确查询正常；`batchKey` 聚合查询跨多次提交返回全量。
- 取消后重传 → 仍 existing 指向原（已取消）任务，不新建。
- 证据：`v03_result_20261008.json`、`v03b_v04_result_20261008.txt`。

## V04 queued 重启后查询与取消（通过）

- 容器重启后按 batchKey 查询：16 项全部保持（taskId/幂等保持），状态 queued。
- `cancelVideoTasks(batchKey)` → 16/16 `cancelled`；复查 counts 全 cancelled，`remaining_active=0`（无遗留可执行验证项）。
- 证据同上文件。

## V07 真实视频运行中重启（通过）

- 任务 `6efddcaf-…` running 时 `docker compose restart` → 重启后状态仍为 **running**（从持久记录恢复查询上游，未重提、未变 unknown）。
- 详见 V05。

## V09 图生图（通过，收费计数：文生图 1 次、图生图 2 次）

| 步骤 | 请求 | 结果 |
|---|---|---|
| 1 文生图（产出参考素材） | xmxImage / gpt-image-2.5 | succeeded，输出 `assets/generated/image882d0897-….png`（2.1MB，PNG 签名已核） |
| 2 单图 edits | 参考图 1 张，`/v1/images/edits` multipart | succeeded，`image410b3164-….png`（2.2MB） |
| 3 多图 edits | 参考图 2 张（顺序 A、B） | succeeded，`imageae26fc0b-….png`（2.2MB） |

- 每条 taskId 状态流转 queued→submitting→running→downloading→succeeded；输出文件 PNG 魔数验证通过；`fileRecords` 归属登记（generated + `task:<id>` 引用）。
- 证据：`v09_result_20261008.json`、`v03b` 同目录。

## V10 浏览器与 MCP 画布（通过）

- 登录页正常渲染；**登录成功**进入应用；服务器工作目录选择器正常（根 `/app/data/workspaces`，展示、进入、选择）；创建项目 studio1 成功（空目录校验生效）。
- **MCP→网页控制链路**：`getAppState` 显示页面连接（directory=studio1、canvasId=画布1.json、panel=canvas）；`getCanvas`/`findCanvasNodes` 经网页执行返回真实画布状态；`addNode` 经网页创建节点成功并落盘。
- **正常后台标签**：打开第二标签使工作区进入后台后，只读查询（648–925ms）与写操作（1292ms addNode）均成功，文件已保存。
- **R16 只读不触发全图保存**：连续 5×（getCanvas+findCanvasNodes）后画布文件 mtime **不变**。
- **R17 目标画布校验**：切到画布2 后，带 `canvasId=画布1.json` 的查询被拒绝（"目标画布已切换，请重新查询画布"）；在画布2 上 addNode 成功且画布1 文件 mtime 不变（未误写）。
- 证据：会话记录（本轮工具输出，含 mtime 对比）。

## V11 自动清理（通过）

- 数据准备（真实产品路径）：`PUT /api/workspaces/files/write` 带 `x-toonflow-file-kind: original` 写入 3 个文件（2 个登记、1 个不登记）；`fileRecords/records.json` 生成。
- **全 off 零删除**：重启触发首轮清理后 3 个文件全在。
- **人工回拨 40 天** + 开启 original 清理（days=30）：`/api/cleanup/preview` 准确报 1 个候选/63 字节；清理轮后**到期且无引用的文件被真实删除**，绑定了活跃任务引用的文件与未登记文件均保留；`cleanupStatus.lastDeleted=1, lastFreedBytes=63, lastFailures=0`；记录同步清账。
- 结束后恢复 original 清理为关闭（交付默认 off）。
- 证据：`v11a_result_20261008.txt`、`v11b_result_20261008.txt`。

## V05 真实视频（通过 → 详见修复记录）

- 首条视频：dolaVideo / seedance-v2.0 / 5 秒 / 9:16，参考图 1 张（V09 产出的多图结果）；上游 ID `video_cf44a643ed`。
- 结果：`assets/generated/video53ec9e26-….mp4`，3,107,025 字节，sha256 `997b0f25…`。
- 文件验证：MP4 魔数（`ftypisom`）✓；ffprobe：**h264 720×1280 + aac 音频，时长 5.088 秒** ✓（真实可播放成片）；`fileRecords` 归属 generated/video + `task:6efddcaf…` 引用 ✓。
- 收费计数：上游创建 1 条（首轮 1/2，未使用第 2 条）。
- 过程中发现并修复一个真实缺陷（见下"验收中修复"），修复后任务自动恢复并完成下载落盘。

## V06 复用 V05 任务（通过）

- 重复提交（同 batchKey+itemKey+同参数）→ `existing`，同一 taskId/batchId，**不新建上游任务** ✓。
- 断开 MCP（多次独立 MCP 会话）→ 任务持续 ✓。
- 关闭网页标签（浏览器 tab close）→ 任务在服务端继续，无需页面 ✓。
- 重开页面 → 需重新登录（内存会话重启/关闭后失效，设计内）→ 项目从 `settings.stores` 恢复 → 工作区/画布（画布1、画布2 与节点）正常 ✓。

## V12 回退演练（通过）

- 演练前基线：容器 `toonflow-toonflow-1`（-5）、settings.json sha256 `81eca69a…`。
- 回退：部署副本 compose 改 `image: toonflow:server-20261008-4` → `docker compose up -d` → 启动成功、`/api/auth/status` 200 ✓。
- 回退版本下数据兼容：settings 完整（cleanup/customProviders/mcp/mediaTasks/stores）、5 个批次文件、生成目录内容可读 ✓；**未删除任何数据卷**。
- 恢复：compose 固定为 `image: toonflow:server-20261008-5`（正式版本，可回退固定 tag）→ 启动成功 ✓；settings.json 哈希不变 ✓。
- 其他应用：演练仅操作 `toonflow` 项目，其他容器/站点未受影响。

## 验收中修复的缺陷（均已部署并复验）

1. **批次稳定性**（-2）：同一 batchKey 的重传/追加曾生成多个 batchId，查询会漏任务。修复为 (工作区, batchKey) 稳定复用同一 batchId，追加并入同批次；`getVideoTasks`/`cancelVideoTasks` 支持 batchKey 聚合。
2. **SSE 僵尸连接**（-4）：页面刷新/断线重连后旧控制连接未清理（部分运行时下 SSE 断开不触发 close 事件），累积后 MCP 报"存在多个 Toonflow 页面"。修复为心跳写状态检测 + 请求 close 兜底；验证：重启后 directory-only 服务端工具恢复可用。
3. **running 任务恢复无驱动**（-5，关键）：进程中断恢复会把任务置为 running，但调度器只派发 queued/downloading —— 恢复后的任务永远无人查询（V05 视频因此卡在 running）。修复为对 running+upstreamId 的任务派发查询作业（不重提上游）；修复后 V05 任务自动完成下载落盘。

## 收费调用统一计数

| 类别 | 本轮执行 | 额度 |
|---|---|---|
| 文生图（产出图生图参考素材） | 1 | 必要请求，已记录用途 |
| 图生图（单图 edits + 多图 edits） | 2 | 上限 2 ✓ |
| 真实视频（seedance-v2.0 5s ×1） | 1 | 上限 2（优先 1）✓ |
| 其余受理/查询/取消/清理验证 | 0 次上游调用 | 调度暂停 + 提交后取消 ✓ |

## 追加批次：审计清单补齐（2026-10-08，镜像 -6）

在首轮交付基础上补齐了此前标记为第二批/未实施的可靠性项，均已部署（`toonflow:server-20261008-6`）并回归：

| 项 | 实施 | 验证 |
|---|---|---|
| R21 subAgent 并发 | 全局信号量（上限 3，FIFO 排队、可取消）；父任务等待子任务时让出槽位，防止多级委派互相占满死锁 | typecheck 0；算法仿真（内联、未落文件）确认峰值并发=3 且三级委派可完成 |
| R23 FFmpeg 执行容量 | 信号量下沉到 `@toonflow/ffmpeg/remote` 统一入口（覆盖 HTTP 路由与工具插件两条路径），同时运行上限 2、排队可取消；工具状态探测增加 60 秒缓存与并发合并 | typecheck 0；仿真确认峰值=2、排队取消无槽位泄漏 |
| R14 Agent 流心跳 | 空闲每 15 秒写 `{"type":"heartbeat"}` 帧；前端 `replyStream.ts` 忽略该帧；流结束/断连清理定时器 | typecheck 0（server/web）；前端解析器契约完整 |
| R26 画布识别 | 快速路径（头 4096 字节根级标记）未命中时，≤2MB 内完整 JSON 解析且要求顶层 `toonflowCanvas === true`；嵌套假标记不再误列 | typecheck 0；与 `canvasFile.ts` 判定一致 |
| R31 用户模型限制 | `getModelLimits` 改为用户显式设置优先，静态表与内置目录仅作缺省；grep 确认 3 处调用方不依赖旧顺序 | typecheck 0 |
| 健康/就绪检查 | 新增 `GET /api/health`（数据目录可写即就绪，认证白名单允许匿名探测）；compose `healthcheck` | 实测 `{"status":"ok"}` 200；容器 `healthy` |
| SIGTERM 优雅停机 | `SIGTERM/SIGINT`：停止 HTTP 受理 + 停调度器并中止本机作业 + 2.5 秒宽限退出；未完成任务交由启动恢复 | 实测 restart 日志出现 `[停机] 收到 SIGTERM：停止受理与调度…`，任务与数据完好 |

回归（-6 后）：`/api/auth/status` 200、登录 200、MCP 46 工具、视频任务 succeeded 与输出保持。

范围说明：R24/R25/R29 为其他内置供应商（apimart/metaso）的条件项，本轮不提供这些模式、保持原状。

## 追加批次：静态证据升级为实测（2026-10-08，用户要求演练）

对上一批标注为"静态证据"的项目做了非付费实测（均为真实产品代码/真实数据，未新增测试文件）：

| 项 | 演练方式 | 实测结果 |
|---|---|---|
| **R30 伪装 MIME 拒绝** | 容器内直接调用产品函数 `assetBytes`：喂入伪装为 `video/mp4` 的 HTML 字节 | **被拒绝**（"生成结果不是支持的图片、视频或音频格式"）✓；正向最小 MP4 头通过 ✓ |
| **R18 跨源不带密钥** | 加载真实 provider 源码（xmxImage）+ 记录型 fetch 观察所有出站请求头 | 跨源 `flow.xmxcode.com`：**NO-AUTH** ✓；同源 `new.xmxcode.com` 与上游 edits：**AUTH** ✓ |
| **R19/100MB 上限** | 本地 101MB 文件作为下载目标 | **14ms 立即拒绝**（"生成文件不能超过 100 MB"），Content-Length 预检未下载内容 ✓ |
| **V08 下载/查询失败重试** | 真实故障注入：运行中任务在网络故障（容器内 DNS 指向黑洞）下重启，恢复后再恢复网络 | 故障期：任务保持 `running`（不 failed/unknown、**不重提上游**、日志无异常）；恢复网络后：**自动补下载 → succeeded**，`upstreamId` 不变（未重新生成），内容 sha256 去重不产生重复文件 ✓ |
| **R31 用户模型限制优先** | 容器内直接调用产品函数 `getModelLimits` | 用户设置 8000/16 → **优先采用**（R31-OK）；无用户设置 → 回退静态表 1048576/393216 ✓ |
| 路径与安全杂项 | 连接失败路径、清理临时服务与文件 | 连接错误信息正确；临时大文件/静态服务/探针已全部清理，端口已关闭 ✓ |

**R20 文本截断（已完成端到端演练）**：用户提供新文本供应商 wb（见下）后完成——设置 `maxOutputTokens=16` → 长文本请求 → 服务端返回 `stopReason="length"`、`usage.output=16`（**同时印证 R31 用户限额生效**，而非静态表 393216）；前端 textNode 截断提示逻辑已在 F 包实现并核对。演练后限额已恢复。

## 新发现：外部文本供应商不可用（非本项目缺陷）

演练期间发现：服务器配置的文本供应商 `cline`（`https://cline.xmxcode.com/v1`）**推理接口整体返回 404 model not found**：
- `/v1/models` 可列出模型（列表已与交接快照不同：出现 `cline-free/solar-mini4`、`cline-pass/*` 等新名，交接中的 `stealth/space-bunny-alpha`、`z-ai/glm-5.3-flash`、`cline-free/deepseek-v4.1-flash` 已不在列表）；
- 对列表中的模型（含新名 `cline-free/solar-mini4`、`cline-pass/*`）发起最小补全请求，**全部 404**。
- 结论：该 key/网关的**推理路由当前不可用**（属外部状态变化，与本次服务器二改无关）。影响：Toonflow 的 AI 对话与文本节点当前无法生成内容；媒体生成（图片/视频）不受影响（独立供应商）。
- **已处理（2026-10-08 当晚）**：用户提供新供应商 `wb`（`https://wb.xmxcode.com/v1`，四个模型：deepseek-v4.1-flash / hy4-preview / glm-5.3-flash / hy3），已替换服务器 `customProviders` 中的 cline（原条目删除），并实测：
  - 四个模型最小补全全部可用（含 reasoning 输出）；
  - 经产品接口 `/api/ai/generate` 使用 `deepseek-v4.1-flash` 端到端生成成功；
  - R20 截断演练完成（见上）。
  - 桌面端配置未改动（只读原则）；交接文件 `languageProviders` 已同步为新值。



## V08 下载失败/重试（静态证据；异常无法非付费复现）

- 下载阶段失败：任务保持 `downloading` + 去敏错误，每资产 5 次尝试后 `retryAt=+60s` 由调度器重试；重试**重新查询上游**获取新定位，不重新生成（`utils/mediaTasks/scheduler.ts`）。
- 受限下载：Content-Length 预检 + 逐块 100MB 上限 + 取消断流（`utils/media/assetBytes.ts`）；MIME 严格签名校验（R30：无法识别且声明为 image/video → 拒绝保存）。
- 多结果逐项保存：单个失败不删除已成功文件（`utils/media/generation.ts` 保留 `savedPaths`；任务层逐项记录 outputs）。
- 无法非付费真实复现上游异常，标记为静态证据。

## V12 部署前后与回退（见下文补录）


## 追加批次：浏览器端到端补验（2026-10-08，镜像 server-20261008-7）

### 发现并修复真实缺陷：设置面板分类切换卡死

- 现象：公网页面打开「设置」后，点击任何分类（文本模型/媒体模型/MCP/存储与清理/隐私等），右侧内容不切换——标题更新但内容仍是「界面设置」，过渡类名（`el-fade-in-*-leave-active`）永久残留。
- 根因：`components/settings/index.vue` 的 `<transition mode="out-in">` + `<keep-alive>` 包装异步面板组件；在该运行环境下 Vue 过渡等待的完成事件不触发，旧组件停留 leave 状态、新组件永不挂载（与网络、资源加载无关，全部 200）。
- 修复（-7）：移除 transition/keep-alive 包装，面板直接渲染（ACT 注释说明）。改动仅此一处，注释与安装包其余行为不变。
- 修复后实测：存储与清理、文本模型、媒体模型、MCP 四个面板**均正常切换与显示**：
  - 「存储与清理」：五类规则（预填 2/2/2/30/2）、预览与保存按钮、最近执行记录（上次演练 03:30 清理 1 个文件）✓；
  - 「文本模型」：显示新供应商 `wb`（4 个模型）✓；
  - 「媒体模型」：TF-router / APIMart / **Dola 视频** / 秘塔 / **XMX 图片** 均在列 ✓；
  - 「MCP」：已开启、**"1 个界面已连接"**（同时印证 SSE 僵尸连接修复：不再累积多连接）✓。

### AI 内嵌浏览器（IAB）渲染限制（非产品缺陷，待真实浏览器确认）

- 现象：画布节点停留在骨架屏；vue-flow 节点样式永久 `visibility: hidden`（尺寸测量未完成）；而 /api/nodes/get 与全部节点脚本均 200、组件已成功导出到 `window.toonflowNodes`、无 JS 错误、容器尺寸正常。
- 判断：与"设置面板过渡事件不触发"同源——该内嵌环境不触发依赖渲染帧/观察器（ResizeObserver / transitionend）的事件；同一份画布代码在桌面版（WebView2 真实窗口）为用户日常使用且正常。属验收环境限制。
- 影响与边界：
  - 本轮无法在 IAB 内完成"网页视频节点点击生成 → 受理 → 取消"的 UI 点击级验证（已在提交前把调度暂停、并在结束后恢复，无费用产生、无遗留任务；测试节点已删除）；
  - **MCP 的服务端任务工具不受影响**（V03/V05 的受理/查询/取消/恢复均为绕过页面的直调并已实测）；受影响面仅为"节点函数类工具"（如 node:generateVideo）在该内嵌环境的能力上报（canvasReady）。
- 待用户确认（10 秒）：在真实浏览器打开 `https://flow.xmxcode.com` → 打开项目 studio1 → 查看画布上的节点是否正常渲染（现有 2 个节点）。正常即确认环境限制成立、真实使用无此问题；若同样异常请反馈，按产品缺陷继续排查。

### 状态恢复确认

- 调度 `paused=false`（正式运行）；五类清理全部关闭；无任何 active 任务；UI 测试节点已从画布删除；临时探针/大文件/静态服务全部清理。

---

# 返工轮 v2 验收（2026-10-08，依据 docs/independentAcceptance.md F01–F20）

保留以上全部历史记录（含修前失败与更正点）；本节为返工轮实际结论，不沿用"全部完成"表述。

## 部署身份（本轮终态）

| 项 | 值 |
| --- | --- |
| 镜像 | `toonflow:server-20261008-9`，ID `sha256:6c8df9eb80165618437b54e4a8742b4c12973591873424d04809ab206e8ede36` |
| BUILD_ID | `server-20261008-9`（容器 healthy；`/api/health` 返回 `schedulerReady:true`） |
| 数据 | `/opt/toonflow/data → /app/data`；数据/`.env`/`auth.json` 0600 |
| 访问 / MCP | `https://flow.xmxcode.com`（Cookie Secure）；`https://flow.xmxcode.com/mcp`（独立 Bearer Token） |
| 清理默认 | 五类全部关闭（2/2/2/30/2 天可填）；调度 `paused=false`、并发 2/2、提醒 24h |
| 回退 | 部署副本 compose 固定 image tag；回退改 tag + `up -d`，不删数据目录 |

**安装产物核对（build vs data，均 MATCH）**：ffmpeg.tool.js `f9209433…`、mediaGeneration.tool.js `159ba19b…`、canvas.tool.js `30e67e52…`、videoGenerationNode.umd.js `43ef04be…`、textNode.umd.js `a1ebcf7f…`、dolaVideo.ts `db1d320b…`、xmxImage.ts `6c60fee4…`（F11 点名的 ffmpeg 安装产物落后已消除）。

## F01–F20 处理表

| 编号 | 结论 | 行为与证据 |
| --- | --- | --- |
| F01 | **已修复并验证** | 同连接有界 FIFO（容量 8、等待预算 120s、执行前重查、排队取消即出队）。实测：两个独立 MCP 会话在同一连接并发 getCanvas 均成功（628ms / 1156ms，无忙拒绝）；连接状态含 `pending{capacity,executing,queued}` |
| F02 | **已修复（部分验证）** | 错误分类：临时错误保持 running + 指数退避（429 取 Retry-After 更晚者）；401/403/不兼容 → blocked；明确业务失败才 failed；Dola queryMedia 只返回定位、下载分离入独立下载槽。内联冒烟覆盖分类分支；真实 5xx/429 端到端未验证 |
| F03 | **已修复并验证** | 重启先恢复已有 ID/在途额度再放 queued；在途额度 ≥ 配置禁止新提交。实测：-8/-9 重启后 `schedulerReady:true`、既有任务保持、无新上游创建 |
| F04 | **已修复并验证** | 首包丢失/刷新按原 batchKey 找回、不 submit 不换键；unknown 不清关联；首次查询异步。实测：提交后仅用原键 GET 找回同一 taskId（matches=True）、同键重放 existing 且 ID 不变；F 包内联 21 断言 |
| F05 | **已修复并验证** | 绑定键含 directory+canvasId+nodeId；输出后保留"待回写"，画布保存成功才清关联；409 保留恢复依据。真实浏览器：刷新/重开后按原键恢复、不重复提交；-11 复验同一节点受理/取消后本地绑定的建立与清理正确（`v11-persistent-*.png`） |
| F06 | **已修复并验证** | 画布读取时绑定 revision，首次保存用读取版本、读取失败不降级覆盖。实测：外部修改磁盘后页面保存被拒（命令明确报"画布已在其他窗口被修改，本地修改未保存"）、磁盘内容零覆盖（哈希一致）、页面横幅与"重新载入磁盘版本/保留本地修改"入口在 |
| F07 | **已修复并验证** | 401 统一（Axios 默认/workspaceFiles/任务 fetch），保留草稿与关联、不强制 reload；登录后只恢复查询。真实浏览器：登录过期不丢草稿与任务关联，重新登录后按原键继续查询、不重放生成 |
| F08 | **已修复并验证** | 保存-写入-刷新-revision 同一串行链。实测：并发保存 A=200/B=409；赢家返回 revision 与随后 GET 完全一致、内容为赢家值 |
| F09 | **已修复（部分验证）** | 真实入口接通：workspaceFiles kind 头（文本节点 generatedText、节点素材/对话附件 original）、任务与同步工具落盘、assets/save；改名/复制/删除维护归属。实测：写 4 类 + 多归属 + 保护文件全部正确登记并按类删除；cache 无符合项=0；改名/复制跟随为代码级（未端到端） |
| F10 | **已修复并验证** | 持久 cleanedAt 标记（记录保留）、多归属全满足、锁内重读版本/引用/规则、占用扩至 unknown 与 blocked/paused。实测：多归属仅开一类保留/全开删除；活跃任务引用保护→取消后按解除时刻重算；被删记录保留 cleanedAt |
| F11 | **已修复并验证** | 信号量下沉包级 `slot.ts`（同进程共享）+ 工具插件改走宿主注入唯一入口；ffmpeg `.text()` 跨环境读取修复；产物哈希 MATCH。原生 fluent 直连路径不受信号量约束（低频，明确列为边界） |
| F12 | **有证据排除** | 源码核对：让出槽位后进入同一 Promise 排队重新获取（`acquireSubAgentSlot` 不提前返回），release 以 `yielded` 守卫只释放真实持有；内联仿真峰值=3、三级委派可完成。未按 bug 修改 |
| F13 | **已修复（未验证）** | 停机：清启动 timer、停受理、等待在途作业收敛（轮询 jobs，最多 10s）后退出；就绪与存活分开（health 附 schedulerReady）。代码 + 部署；真实 SIGTERM drain 观测（重启时作业为 0）未单独记录 |
| F14 | **已修复并验证** | 同键校验与批次写入同协调范围。实测：10 项并发往返重传全 existing + taskId/batchId 一致；冲突 rejected；追加并入同批次 |
| F15 | **已修复（未验证）** | 内容寻址落盘（`<类型>-<sha256前32>`）+ 逐项登记，重启按 sha256 认回。代码 + typecheck；崩溃认回未端到端 |
| F16 | **已修复（未验证）** | 提交前按模型声明校验参考数/时长档/比例/分辨率，超能力拒绝并列出可选档（不静默取近值）。Q 内联冒烟；未真实提交超能力请求 |
| F17 | **已修复并验证** | 下载鉴权 = HTTPS + 完整 origin 一致；重定向逐跳重算、拒绝凭据 URL。实测：跨源请求 NO-AUTH、同源/上游 AUTH（记录型 fetch 观察真实出站头） |
| F18 | **已修复（未验证）** | 设置冲突面板新增"重新加载设置"按钮（保留本地修改提示）。代码 + typecheck；浏览器点击未跑 |
| F19 | **已修复并验证** | 根 compose 透传 `TOONFLOW_COOKIE_SECURE`；线上为 1（Cookie 实测 HttpOnly/Secure/SameSite） |
| F20 | **已修复并验证** | 旧同步 generateVideo 保留返回结构并标明同步等待/长任务入口；受理即返回（HTTP 实测：submit 返回 taskId 不等成片）；`node:generateVideo` 首次查询异步、无 taskId 返回 pending |
| R21（新增·返工回归） | **已修复并验证** | 视频节点无条件走持久队列 + 默认模型为同步供应商 → 提交即被拒（failed、零费用），主流程不可用。修复：`asyncMedia` 能力标注（仅 dolaVideo=true）+ 节点按能力双路径（持久→任务链；同步→页面内生成，明示能力差异）+ 新节点默认持久供应商 + `node:generateVideo` 对同步模型明确拒绝 + 不兼容文案如实。实测见"更正"节与 `v11-*.png`（同步路径发往 `/api/ai/media/generate` 且上游前被拒；持久路径受理/取消；零收费） |

> 返工结论口径：**F01–F20 主体成立**，其中 F05/F07 已由真实浏览器补验转"已验证"；R21 为本轮发现并修复的回归。整体验收仍需按 `docs/independentAcceptance.md` 与用户目标逐项复核，本表不构成"整体通过"。

## 长期等待规则（实际默认值与入口）

- 提交 90s / 查询 30s / 下载 60s 无数据（单次 15min）；生成总等待不限时，`settings.mediaTasks.waitingReminderHours` 默认 24（0=不提醒，1-720，settings/save 校验）。
- 接口：`POST /api/ai/media/tasks/pause`、`/resume`（支持 `bindTasks` 绑定人工核对的上游 ID）；MCP 工具 `pauseVideoTasks`/`resumeVideoTasks`（与 HTTP 同构，自动暴露）。实测：pause→paused/resume→active。
- 上游保留期：Dola 任务/链接保留期与可刷新性**未核实，标记未知**；长期查不到按"待核对/无法补取"显示，不伪装失败、不自动重发。
- 同步供应商（APIMart/Metaso/TF-Router）不承诺跨天恢复，界面/工具描述标明能力差异。

## 浏览器证据与未验证项（如实）

- 实测：登录、工作区、设置四面板（含存储与清理）、画布冲突横幅与操作、MCP 经网页执行、两独立会话并发排队、只读零写盘（画布 mtime 不变）、切画布拒绝旧目标。
- **未验证**：真实普通浏览器 hidden 后台标签（本轮 IAB 环境 `visibilityState=visible`，与审计一致未获 hidden 证据）；视频节点 UI 点击链（IAB 画布节点骨架屏，本轮两次独立窗口亦未复现节点渲染，**不据此宣布视频节点全部验收通过**）；F05/F07/F13/F15/F16/F18 的端到端交互；真实上游 5xx/429/401 与崩溃认回；跨天自然等待。
- 骨架屏：本轮未复现（桌面环境正常渲染），不写成当前必现缺陷，也不代表节点链已通过。

## 收费台账（完整）

| 时间 | 类别 | 上游 | 数量 | 说明 |
| --- | --- | --- | --- | --- |
| 早前 | 视频 | video_a10458c9a0（myProject 成片 2,206,448B） | 1 | Debug 批次，原报告漏记 |
| 早前 | 视频 | video_cf44a643ed（studio1 成片 3,107,025B） | 1 | V05 |
| 早前 | 文生图 1 + 图生图 2 | xmxImage | 3 | V09 |
| 本轮返工 | — | — | **0** | 全部验证复用已有任务与原 ID；未新增任何收费调用 |

两条视频为**两个不同上游 ID 的有效成片**；恢复演练中更新过任务时间/重新下载，不视为新生成。失败请求的计费未核实。

---

# 真实浏览器补验（2026-10-08，验证者要求的后台标签与视频节点 UI 链）

方式：本机启动 **Edge 154**（独立配置档 + CDP 9222，不触碰用户浏览器），通过手写 CDP 客户端驱动；全程真实浏览器窗口与真实标签可见性。

## 已完成（有实测证据）

| 项 | 证据 |
| --- | --- |
| **真实后台标签（hidden）** | Edge 窗口在后台时页面 `document.visibilityState = "hidden"`（实测记录） |
| **恢复前台** | CDP `Page.bringToFront` 后 `visibilityState = "visible"`（hidden→visible 成对样本） |
| **刷新重开** | 多次 `Page.reload` 后应用、登录态（Cookie）、项目与画布（画布1、2 节点）均恢复 |
| **MCP 经真实浏览器执行** | 真实 Edge 页面作为控制目标：getCanvas/addNode/并发排队等均通过（此前 G3 章节） |

## 发现阻断性缺陷（P1，真实浏览器复现）

**生成类节点（视频生成 videoGenerationNode、图片生成 imageGenerationNode）内容不渲染**：
- 现象：节点停留在 `remoteNode` 的 **loading 空壳**（仅"刷新节点/移除节点"按钮，无提示词框、无生成按钮）；
- 对照：同画布 **素材类节点（textNode/imageNode）正常渲染**（有编辑/上传等真实控件）；两个生成类节点一致失败；
- 排除项：**无 JS 异常与 console 错误**（CDP 捕获）、**无失败或挂起的网络请求**（Network 域仅两条正常 SSE 长连接）、**刷新、强制重载（刷新节点按钮）均无效**；
- 关联证据：MCP `getAppState` 的 `tools` 为 **0**（节点组件未挂载、nodeTools 未注册）；首个生成类节点添加后即复现（此前把 IAB 骨架屏归因"环境限制"的结论**部分被推翻**——真实浏览器同样复现生成类节点问题，素材类则正常）。

**影响**：画布生成类节点当前不可用（主页面的图片/视频生成入口）；**视频节点受理/取消 UI 链因此无法执行验证**（验证者要求的该项**未完成**）。
**未定位**：`loading` 表达式（`nodeLoads.has || nodeListLoading && !nodeTypes && !nodeErrors`）两个条件按源码推导都应为 false，但实测为加载态；页面内部 Vue 状态在生产构建下不可直接读取，页面级 fetch 探针注入未生效；**根因待下一轮在源码层加诊断或修复**。
**对照未完成**：-5 返工前镜像的隔离实例（独立端口/数据）已启动，但经隧道加载页面过慢且落点空白，未能取得可用对照样本，已清理；**因此无法断言该缺陷是否本轮返工引入**（桌面版为官方构建、用户日常使用正常，提示与我们的构建管线相关）。

## 更正：上述"生成类节点不渲染（P1）"结论不准确（2026-10-08，-10/-11 复核实证）

以上原文保留作历史；经源码层诊断与生产构建真实浏览器复核，结论更正如下：

- **根因已定位**：画布节点列表请求存在 **loading 竞态**——旧请求（或组件卸载后返回）使 `requestId` 失效时 `nodeListLoading` 不复位，整片画布停在加载态，节点渲染被 loading 条件挡住。现已修复（`nodeListInflight` 在途计数 + 只读诊断入口 `window.canvasDiagnostics()`）。
- **"生成类节点内容不渲染"是两个现象叠加的误判**：`nodeSkeleton` 是所有节点共用的外壳；素材类节点（文本/图片）的编辑、上传等控件常驻外壳内，而生成类节点（图片/视频生成）的提示词、模型、发送按钮属于**选中节点后显示**的底部操作区（正常设计）。竞态发生时无法区分"未选中"与"未渲染"。
- **更正后的实测**（真实 Edge 154 + CDP、生产构建、公网域）：`nodeListLoading=false`、`nodeListInflight=0`；文本 / 图片 / 视频生成三类节点全部渲染；视频节点选中后操作区完整（模型下拉含能力标注、发送按钮可用）。
- **当时"无法执行"的视频节点受理/取消 UI 链已解除阻塞并完成**（-10/-11 真实浏览器）：Dola 视频受理（`POST /api/ai/media/tasks/submit` → taskId `b76ab70c-…`，界面"排队中"）→ 停止对话框 → "取消任务"（`POST /cancel`）→ "已取消"；调度先置 `paused=true`，任务 `upstreamId=null`（零上游费用）。截图见交接目录 `evidence/v11-*.png`。
- **同轮另修一个回归缺陷（P1）**：视频节点无条件走持久任务队列且默认模型是同步供应商 APIMart `seedance-2.5`，提交即被能力校验拒绝（failed、零费用），视频生成主流程不可用。修复：模型列表新增 `asyncMedia` 能力标注；视频节点按能力**双路径**（持久供应商→服务器任务链；同步供应商→页面内同步生成，界面明示能力差异、关闭页面即中止等待）；新节点默认优先持久供应商；`node:generateVideo` 对同步模型明确拒绝；不兼容文案改为"供应商未提供持久异步任务能力（submitMedia/queryMedia）…"。实测：同步路径发往 `POST /api/ai/media/generate` 并在上游调用前被拒（无 Key）；持久路径受理/取消如上；新节点默认 = Dola `Seedance V2.5`；直连任务接口提交同步供应商的文案与"未提交上游"已验证（任务 `0bbd67e9-…`，`upstreamId=null`）。

## 收尾状态

- 生产已恢复：调度 `paused=false`、五类清理全关、测试节点已从画布删除（画布1 回到原有 2 节点）、无活动任务；
- 对照环境已清理：隔离容器 `toonflow-iso5` 删除、`/opt/toonflow/iso-data` 删除、本地隧道进程停止、对照 Edge 实例经 `Browser.close` 关闭；
- 唯一镜像/版本不变：`toonflow:server-20261008-9`（本轮补验未改产品源码、未新增收费调用）。

## 收尾状态（-11 终态，2026-10-08 更新）

- 当前部署：镜像 `toonflow:server-20261008-11`、BUILD_ID `server-20261008-11`，容器 healthy；安装产物 `data/nodes/videoGenerationNode.umd.js` = build = 本机构建同哈希 `8874b210…`；`data/providers/dolaVideo.ts` `db1d320b…`。
- 生产设置：调度 `paused=false`、并发 2/2、提醒 24h；五类清理全关（2/2/2/30/2）；无 active 任务。
- 本轮（-10/-11）改动：画布节点加载竞态修复 + 只读诊断入口；模型列表 `asyncMedia` 能力标注；视频节点持久/同步双路径与默认持久供应商；任务不兼容文案；`node:generateVideo` 同步模型拒绝。收费：0 次新上游调用。
- 回退：镜像 `-10`/`-9`/`-8`/`-7` 均保留；compose 改 image tag + `up -d` 即可，不删数据目录。
- 遗留未验证（如实）：真实普通浏览器 hidden 后台标签之外的更多边界、真实上游 5xx/429/401 与崩溃认回、跨天自然等待、同步供应商的**真实**成片（本轮按"不新增收费调用"约束仅验证到路由与上游前拒绝）。

---

# 第三轮返工验收（2026-10-08，依据 docs/secondIndependentAcceptance.md R01–R11 与 docs/completeRepairExecutionPlan.md）

保留以上全部历史记录；本节为第三轮实际结论与证据，不代表独立审计窗口的最终验收。

## 部署身份（第三轮终态）

| 项 | 值 |
| --- | --- |
| 镜像 | `toonflow:server-20261008-12`，ID `sha256:e9afabc0c1d3…` |
| BUILD_ID | `server-20261008-12`（容器 running/healthy） |
| 安装产物 | `data` 与 `build` 共 21 个插件文件哈希全一致；公网入口 `assets/index-JTxenVxX.js` 与容器一致 |
| 配置 | `paused=false`、并发 2/2、提醒 24h；五类清理全关（2/2/2/30/2） |
| 备份 / 回退 | `/opt/toonflow/backup/repairExecution20261008`（data tgz + .env + compose + 镜像 ID）；镜像 -11…-1 保留，回退改 tag + `up -d`，不删数据 |
| 收费 | 本轮 **0 次新增上游创建**（隔离验证全部为无密钥供应商 / 受理前拒绝 / 取消，`upstreamId=null`） |

## R01–R11 处理结论

| 编号 | 结论 | 要点与证据 |
| --- | --- | --- |
| R01 停机丢 ID / 退出协调 | **已修复（源码闭环 + 隔离停机实测）** | 删除“已收到 upstreamId 因 aborted 丢弃”分支；新增 stopping/beginStopping/drainMediaTaskWrites；index.ts 停机顺序 = 封闭受理 → 停 MCP/清理派发 → 等关键落盘 → 排空写队列 → 退出；compose `stop_grace_period 60s` 对齐。隔离真实 SIGTERM：日志“[停机] 收到 SIGTERM…→退出”、exit 0、重启 schedulerReady=true（V06）。ID 临界段窄窗口未自然触发，源码路径已核对 |
| R02 pause/resume/unknown 语义 | **已修复并实测（部分）** | queued 的 pause/resume 明确不适用/拒绝（不触发首次生成）；`abandonUnconfirmed` 仅 unknown 且无 ID 并幂等、成功恢复经 bind 撤销豁免。实测：pause/resume/abandon 拒绝理由可读、cancel 未提交可终结（V04）。真实丢包后 abandon 成功路径未动态构造 |
| R03 下载占额度 / 退避被清 | **已修复并实测** | `occupiesUpstreamSlot` 排除 downloading、无 ID unknown 仅放弃后释放；未来 retryAt 在重启/pause/resume/bind 后保留。实测：重启后 retryAt 原样保留、同刻 queued 任务仍被派发（downloading 不占生成额度）、resume 后 retryAt 未被清（V05） |
| R04 供应商兼容与 bind | **已修复（源码 + 隔离行为）** | 完整规范化基址 + providerRevision + 凭据身份引用；历史缺地址保持 blocked（隔离重启实测到具体原因）；bind = 只读核对 + 全局归属 + 锁内重查 + 一次写入。Dola 是否回显 id/model/account 未核实（外部边界，如实列明） |
| R05 MCP 取消路径 | **已修复（FIFO 实测 / 关闭源码核对）** | closing 统一路径（先置 closing，settle 不再 dispatchNext）；signal 贯穿节点目录准备与提交。实测：同一连接并发只读 getCanvas 942/1584ms 均成功；关闭路径为源码核对（V12/V13） |
| R06 成片关联提前丢失 | **已修复（源码核对）** | writeBackToken 生成/复用（同一任务同一输出不换 token）；保存请求固定不可变文本快照并从同一快照导出清单；仅 directory+canvasId+nodeId+taskId+outputPath+token 六项全匹配才清；失败含部分输出仍走待回写；cancel 返回 succeeded/unknown/failed 先查完整摘要；视频节点统一走公共 submit。真实“旧 ACK 清新结果”交错未构造 |
| R07 冲突重载丢版本 | **已修复（源码核对）** | 清冲突（dismissCanvasConflict）与放弃记录版本（discardCanvasRevision）拆分；重载先读磁盘取得同源 revision 并写回，失败保留草稿/冲突/旧版本，不再为旧内容取最新版本背书 |
| R08 清理与登记竞态 | **已修复（源码 + 隔离实测）** | 登记围栏（写前落盘、失败保留并可恢复、cleanup 前恢复）；清理持路径锁后重读最新记录/规则/占用/版本；锁忙跳过；归属存储/保护不可用整轮不删。实测（隔离）：目录改名/复制/删除后归属一致、编辑占用阻止删除、已清理写入 409（V16/V17/V21 部分） |
| R09 目录迁移 / 标记 / 界面消费 | **已修复（迁移实测 / 界面源码核对）** | 改名递归迁移（含子目录、兄弟不误匹配）、复制新身份、删除清账；cleanedAt 与删除意图分离、failed 不清意图、外部缺失标 missing；outputState/cleanedAt 由任务摘要与节点消费。界面侧：视频节点已消费，其余视图（文档 fileTree、素材库）为源码接线，未动态逐视图核对 |
| R10 子 Agent 槽 | **已修复（源码核对；付费全链未跑）** | 新增 `reacquireSubAgentSlot`：父让出后在返回工具结果前重新经 FIFO 取槽，取消出队，释放只对实际持有生效 |
| R11 同步供应商先受理后失败 | **已修复并实测** | 首次执行按能力分流（submitMedia+queryMedia 成对→持久异步；否则原 generate 进程内后台）；apiMart（同步、无密钥）被受理并派发，失败文案“请先在媒体模型设置中配置供应商 API Key（任务未提交上游，可重新提交）”，不再出现不可执行的 resume 提示（V10） |

## 其余缺口

| 项 | 结论 |
| --- | --- |
| F11 FFmpeg 全局边界 | **已修复并实测**：宿主进程级信号量覆盖 HTTP/工具/供应商/原生 fluent 工厂（包装器）；实测 2 并发进程 + 第 3 路排队、无双重拿槽死锁；G3 中发现并修复“排队期间取消导致槽泄漏”，随发布产物重建。stream/pipe 未纳入并单列边界 |
| F11 插件同名定制 | **已修复并实测（隔离 + 线上）**：逐文件三级哈希；线上发布 21 个官方文件按 unchanged/updated 同步、无定制；隔离预置定制 → 保留 + `pendingUpdates/` 待合并；二次启动同版本跳过。写失败分支未动态触发 |
| F14 落盘失败幂等 | **已修复并实测**：阻断落盘时 403 EACCES、重传同样失败（无幽灵 existing），恢复后恰好新增一批（V03） |
| F15 输出认回 | **已修复（真实 SHA + 存在性；运行时分支源码核对）**：两条成片 SHA 与历史一致；内容寻址按真实内容比对；已清理不自动补下载 |
| F16 未支持输入 | **已修复并实测**：dolaVideo 未声明的 videos/audios/mode 受理前拒绝且文案明确“不会被静默忽略”（V09） |
| F18 设置重载失败 | **已修复（源码核对）**：成功获取并校验后才切换状态/清冲突，失败保留草稿、旧 revision、横幅与重试按钮 |
| 长期方案：网页聚合查询 | **已实现（部分实测）**：页面级 hub（跨 bundle、去重、≤200/批、limit=200、visible 3s/hidden 15s、无订阅释放）。实测：无活动订阅时不产生任务查询请求；有订阅时的分组与 100 节点压测未取到样本 |
| 首包未知自动观察 | **已修复（源码核对）**：保留原键后立即自动按原 batchKey 轮询，不再依赖点击 |
| 本地准备失败分类 | **已修复并实测**：准备/校验失败记提交前失败（不占保守额度、不转 unknown）；提交网络计时从真正开始网络调用起算 |

## 关键验证证据（第三轮）

- 真实后台标签（V20）：真实 Edge 窗口处于 `visibilityState=hidden` 期间，经 MCP 完成 initialize / tools/list / 两个并发 getCanvas（942ms、1584ms）/ getVideoTasks，调用前后复核仍为 hidden；`bringToFront` 后 visible 且调用正常。
- 停机（V06）：隔离实例真实 SIGTERM → 日志顺序与 exit 0 → 重启 schedulerReady=true、记录保留。
- 受理与幂等（V02，12 项 + 最终镜像复跑）：accepted/existing/rejected 与身份稳定；并发同批只产生一组身份；第二工作区同键独立身份。
- 清理闭环（V16/V17）：仅开启选定类别时到期文件被删并记 cleanedAt，编辑占用与新鲜文件保留，已清理路径写入 409；目录改名递归迁移 3 条、兄弟目录不受影响、复制新记录、删除清账。
- 发布身份（V25/V26）：镜像/BUILD_ID/安装产物/公网入口一致；登录、MCP、项目、两条成片、设置、清理状态与任务分母与切换前一致。

## 未动态执行（如实列明，不冒充通过）

付费子 Agent 完整链（V22，本轮额度 0）；真实上游 5xx/429/401 与结果过期；跨天自然等待；Dola 上游保留期与身份回显；同长度不同内容的运行时认回分支；MCP 队列在“待派发时被整体关闭”的真实样本；POST 前取消的真实异步竞态复现；两窗口第二次交叉保存；离线设置重载重试；100 个真实订阅的聚合压测；任务输出改名的真实演练。

---

# 第四轮返工验收（2026-10-08，依据 docs/thirdIndependentAcceptance.md T01–T18，镜像 -13）

保留以上全部历史记录；本节为第四轮实际结论，独立验收仍由审计窗口另行进行。

## 部署身份（第四轮终态）

| 项 | 值 |
| --- | --- |
| 镜像 | `toonflow:server-20261008-13`，ID `sha256:df73e3eb2e14f35b4ca31d51d56e923419d8970c6f54efa736dee37517d59567` |
| BUILD_ID | `server-20261008-13`（容器 running/healthy） |
| 安装产物 | data 与 build 共 21 个插件文件全一致；公网入口 `assets/index-CXPmEegm.js` 与容器一致 |
| 配置 | `paused=false`、并发 2/2、提醒 24h；五类清理全关（2/2/2/30/2）；wb 未改动 |
| 数据 | 13 批次 36 cancelled/2 failed/5 succeeded；两条成片 SHA 不变；原工作区未改 |
| 收费 | 本轮 **0 次新增上游创建**（隔离验证全部使用无密钥供应商 / 受理前拒绝 / 取消） |
| 回退 | 镜像 -12…-1 保留；compose 改 image + `.env` BUILD_ID 回退即可，不删数据 |

## T01–T18 处理结论（摘要；逐项证据见 evidence/repairExecution20261008/run2/validationResults.jsonl）

| 项 | 结论 | 动态程度 |
| --- | --- | --- |
| T01 unknown 重新生成 | 已修 | 源码核对（三处语义一致） |
| T02 停机总预算/在途受理 | 已修 | **已实测**（空闲/在途双信号、50 项在途完整落盘、阶段日志与 drainOutcome；并修复 Bun close 切断在途、`process.once` 双信号两个真实缺陷；收口期再修 SSE 精确计数与 MCP 预算，-14 停机实测 exit 0） |
| T03 恢复就绪门 | 已修 | 源码核对 + health 判据线上可见 |
| T04 容量预约 | 已修 | 源码核对 + 状态字段可见 |
| T05 下载暂停迟到回调 | 已修 | 源码核对 |
| T06 下载重试占槽 | 已修 | 源码核对（真实 Retry-After 不可安全构造） |
| T07 身份与恢复依据 | 已修 | 源码核对（account 恒 unverifiable，如实） |
| T08 认回真 SHA | 已修 | 源码核对 |
| T09 快照输入 | 已修 | 源码核对 |
| T10 幽灵绑定/摘要三态 | 已修 | 源码核对 |
| T11 输出字段与消费 | 已修 | 服务端字段线上实测（`available`+路径）；前端源码核对 |
| T12 设置重载串行 | 已修 | **已实测**（V18：409 冲突→离线重载失败保留→在线重试 200→保存恢复 200） |
| T13 节点状态短截止 | 已修 | **已实测**（V19：可见态生成、6 条聚合查询、limit=200、每请求 1 个 ID） |
| T14 编辑占用 | 已修 | **后端实测**（双 pageId 隔离与释放）+ 前端源码核对 |
| T15 目录改名事务 | 已修 | C 模块级实测（事务/回滚/身份约束）+ 正式调用链核对；收口期修复 Agent rename 双锁（必然 EBUSY）并把 MCP rename 接入统一事务 |
| T16 保护表故障/范围 | 已修 | C 模块级实测（跨重启故障标记、后代/兄弟判定）；收口期补显式恢复入口 `POST /api/cleanup/protections`（冒烟 200） |
| T17 保护恢复代次 | 已修 | C 模块级实测（live guard 跳过、同代解除） |
| T18 FFmpeg 原生边界 | 已修 | **已实测**（真实双 concat、并发峰值 2、排队/运行取消、clone）；收口期把能力查询（available*/getAvailable*）纳入同一租约 |
| 路由规范 | 已修 | editing 拆分为 create/get/release 并 `bun run routes` |

## 非收费验证补充（本轮）

- 逐请求台账：12 行（含并发两次各自返回、越界 403、受理前拒绝），见 `run2/submissionLedger.jsonl`。
- V20 真实后台标签：hidden 期间经 MCP 完成 `write`（真实落盘）/`read`（读回探针）/`write`（还原）与画布数据读取。
- V23 原生 FFmpeg：隔离实例内联真实执行（3 路 concat 全完成、`/proc` 采样并发=2、排队取消未启动、运行取消真实退出、clone 可用）。
- **V15 二次冲突（补做，已实测）**：隔离实例两个工作区标签页 A/B 对同一画布自动保存——A 段 `PUT /api/workspaces/files/write?…expectedRevision=d674f3ab…` → **200**；B 段**同一 revision** → **409**，原始响应体 `{"code":409,"data":{"code":"ESTALE"},"message":"文件已被其他编辑器修改，当前修改已保留，请重新载入磁盘版本或另存副本"}`，B 页出现冲突横幅（重新载入磁盘版本/保留本地修改）。证据 `run2/v15_two_page_conflict_raw409.json` + 截图 4 张。
- **V18 离线设置重载（补做，已实测）**：对话框内真实点击『深色』触发保存 → `PUT /api/settings/save` 两次 **409** 并出现『设置已在其他窗口被修改，本地修改尚未保存』+『重新加载设置』；离线后点重载 → `GET /api/settings/get` `net::ERR_INTERNET_DISCONNECTED`，**冲突与重试按钮保留**；恢复在线再点重载 → **200**，冲突消除；随后再点『深色』→ `PUT /api/settings/save` 两次 **200**。证据 `run2/v18_offline_reload_chain.json` + 截图 4 张。
- **V19 活动订阅聚合（补做，已实测）**：可见态选中视频节点生成 → taskId `1291a411…`；约 15 秒内 6 条任务网络记录（submit + 5×get），`limit=200`、目录数 1、唯一 taskId 1、每请求 1 个 ID、订阅数 1；随后取消（`upstreamId=null`，零上游）；模型未被下拉切换为 APIMart（保持 Dola，零费用由 `paused=true` 保证，如实记录）。
- 命令与产物证据：`run2/commandResults.jsonl`、`run2/artifactHashes.json`、`run2/executionManifest.json`、`run2/*.png`。

## 互审正式调用链（独立子审查员）

第四轮完成后另派两名相互独立、互不可见的只读子审查员交叉复核正式调用链接缝（子审查员禁用写文件/构建/测试/启动服务，每条结论须带 file:line）：

| 审查范围 | 覆盖链路 | 结论 |
| --- | --- | --- |
| 审查一（受理→调度→上游→输出→前端回写） | 任务路由字段 ↔ `useMediaTask`/节点消费；`outputs[]` 五字段；就绪门与容量预约的全部派发入口；三身份与 credentialRef；下载 retryAt 与迟到回调；快照输入；前端各态状态机 | 主链接通（1 项有缺口 A1 + 4 项观察） |
| 审查二（编辑占用→清理→保护→改名 + FFmpeg 租约 + 停机） | editing 三路由；占用键与 pageId 释放；保护表代次/故障标记/绕过路径；rename→relocate 事务回滚覆盖；命令级租约覆盖面与取消不泄漏；停机单一路径与 503 门 | 主链接通，**发现 9 项真实缺口/偏差**（含 1 项潜伏但必然失败的 Agent rename 双锁） |

**互审发现与处置（逐条证据见 `docs/callChainCrossReview.md`）**

| 编号 | 发现 | 处置 |
| --- | --- | --- |
| 审查二-1 | Agent 工具 `files.rename` 外层与内层重复锁同一批路径 → 锁不可重入，必然 EBUSY | **已修**：去掉外层预锁，统一交给 `relocateWorkspacePathWithTasks` 取锁 |
| 审查二-2 | MCP `workspaceFiles.rename` 直接改名，绕过归属迁移/重定位日志/任务 outputs 定位 | **已修（rename）**；remove 按 §J 范围记录为边界 |
| 审查二-3 | 保护表持久故障/范围保护无任何调用方 → 清理永久暂停且无法经接口恢复 | **已修**：新增 `POST /api/cleanup/protections`（认证 + 核对原因 + 可选 paths），发布后冒烟 200 |
| 审查二-4 | FFmpeg 能力查询（available*/getAvailable*）会 spawn 真实进程但未纳入容量 | **已修**：实例纳入终态表 + 服务端 Proxy 包装静态形式 |
| 审查二-5 | 排队分支返回值对 promise 型终态方法导致 `await` 失效 | **核实为不适用**：本仓库 fluent 分支 run/exec/execute 原生返回 `this` |
| 审查二-6 | 在途计数按 250ms 猜测 SSE，晚 flush 头的 SSE 会计入到连接关闭 | **已修**：精确拦截 `writeHead`；-14 停机实测日志与 exit 0 |
| 审查二-7 | `stopMcpRuntime()` 不受剩余预算约束（违反 §A.1） | **已修**：预算化 race（-14 日志「MCP 已关闭（预算 8000ms）」） |
| 审查二-8 | 改名错误码把 `ENOTFOUND`/`EPARTIAL` 折叠为 500 账本错误 | **已修**：`ENOTFOUND→404`，其余消息原样透出 |
| 审查一-A1 | `getGenerationStatus` 前置目录解析/在途请求无总时限 | **已修**：整次查询 5s 截止 + `queryPending=true` |
| 审查一-A2 | unknown + paused/blocked 时等待原因被通用文案覆盖 | **已修**：unknown 分支合并 `waitingReason` |
| 审查一-A3/A4/A5、审查二-9 | 503 按 unknown 保留绑定（保守设计）；account 闭环不可达（契约 §E）；paused 迟到结果更新 retryAt；人工/MCP 删除不查登记围栏 | **如实记录为边界，未改**（改动会扩大行为面，且与契约措辞一致） |

## 仍未动态覆盖（如实列明）

互审修复多为源码/类型/构建级复核：A1/A2 的前端慢网络场景、FFmpeg 能力查询纳入租约后的真实并发样本、MCP rename 事务的真实 MCP 会话调用未动态复跑；没有活动订阅且节点选择器命中的更宽聚合压测（100 订阅）；真实上游 429/Retry-After 与结果过期；受理后原图被改/删（T09）与同长度坏内容认回（T08）的运行时分支；双标签续租/hidden/重启后租约（T14）；真实多任务输出改名（T15）；装载告警使 ready=false 的现场（T03）；桌面端路径。以上均为源码/模块级核对，未冒充实测。

---

# 第四轮收口：互审修复与镜像 -14（2026-10-08）

在第四轮 -13 交付与上述 V15/V18/V19 补做之后，按验收者要求完成「互审正式调用链」，对审查发现的问题做了一轮修复并重新发布：

## 部署身份（收口终态）

| 项 | 值 |
| --- | --- |
| 镜像 | `toonflow:server-20261008-14`，ID `sha256:b0653d6819e3f916cb85c866c2268418af2890e068d46d901f8fc575572e1c42` |
| BUILD_ID / 容器 | `server-20261008-14` / `toonflow-toonflow-1`（running、healthy、restarts=0） |
| 插件 | data 与镜像 build 共 21 个插件文件 sha256 **全一致**；启动同步日志 tools {unchanged:8}、nodes {unchanged:7, **updated:1**}、providers {unchanged:5} |
| 数据 | 13 批 36 cancelled/2 failed/5 succeeded；成片 `997b0f25…` 不变；原工作区未改 |
| 配置 | `paused=false`、并发 2/2、提醒 24h；五类清理全关（2/2/2/30/2） |
| 公网 | 入口 `assets/index-CXPmEegm.js` 与容器一致（`5f3d10f3…`）；GET 200、POST 恢复（登录错误口令 401） |
| 收费 | 本轮（含补做与收口）**0 次新增上游创建** |
| 备份 / 回退 | `/opt/toonflow/backup/repairExecution20261008-r14`（data tgz 21.6MB + .env + compose.yaml + image-before.txt）；镜像 -1…-13 保留，改 tag + `up -d` 回退，不删数据 |

## 收口期动态实测（非收费）

- **停机（-14 新代码路径）**：真实 `docker stop -t 60` → ExitCode **0**；日志顺序：封闭受理 → HTTP 停止受理（在途 0）→「MCP 已关闭（预算 8000ms）」→ 清理收敛 → 排空结果 `completed=true, pendingJobs/Writes/Inflight=0` → 退出；重启 12s 内 healthy。
- **新路由冒烟**：`POST /api/cleanup/protections` → 200 `{"clearedPaths":0}`（无故障时幂等 no-op）。
- 发布前后核对：21/21 插件一致、公网入口一致、任务分母与成片不变、设置未漂移——见 `run2/release-14.json`。

---

# 第五轮返工验收（2026-10-08 夜，依据 docs/fourthIndependentAcceptance.md，镜像 -16）

保留以上全部历史；本节为第五轮实际结论。原始交付口径：Q（媒体任务）/W（网页节点）/C（归属清理）/I（集成、FFmpeg、停机、发布）；两轮独立互审记录见 `docs/callChainCrossReview.md`（第四轮）与 `docs/callChainCrossReview2.md`（本轮）。

## 部署身份（第五轮终态）

| 项 | 值 |
| --- | --- |
| 镜像 | `toonflow:server-20261008-16`，ID `sha256:a0e851d002ca8427972ec521b075bae9e3d7f79f57febef50ef2442a0bb441d0` |
| BUILD_ID / 容器 | `server-20261008-16` / `toonflow-toonflow-1`（running、healthy） |
| 插件 | data 与镜像 build 共 21 个插件文件 sha256 **全一致**；启动同步 tools {unchanged:7, updated:1}、nodes {unchanged:7, updated:1}、providers {unchanged:5} |
| 数据 | 13 批 36 cancelled / 2 failed / 5 succeeded；两条成片 sha256 不变（`997b0f25…`、`531ddcb9…`） |
| 配置 | `paused=false`、并发 2/2、提醒 24h；五类清理全关（2/2/2/30/2） |
| 公网 | 入口 `assets/index-2VZmwJmd.js`（`3c9f5cd3…`）与容器一致；GET 200、POST 恢复（登录错误口令 401） |
| 保护就绪 | 发布后显式恢复（见下）→ `protectionReady=true`、`readiness=ok`、`cleanupReady=true` |
| 收费 | 除隔离验收中 1 次**未预期**真实创建（见 `run3/incident_unintended_upstream.json`，已如实披露）外，本轮新增收费生成 **0** |
| 备份 / 回退 | `/opt/toonflow/backup/repairExecution20261008-r16`（data 21.6MB + 配置 + image-before）；回退=改 image 回 -14 + `.env` + `up -d`，镜像 -1…-14 保留 |

## 第四轮 13 组剩余问题的处置

| 组 | 本轮处置 | 验证范围 |
| --- | --- | --- |
| T09 提交许可/旧记录 | 已修：许可=本次条件更新生效 + 最新状态允许；显式 `submissionAttemptState`（新格式 pending→提交前 failed；旧格式一律 unknown）；服务端摘要透出 `submissionAttempt` | **动态**：旧格式 submitting 无 ID 升级恢复 → unknown、键/fingerprint 保留、零上游（隔离实例） |
| T07 核验身份 | 已修：免检要求核验当时 identity 五项全等；归属唯一性按当前命名空间锁内重查；rematch 先固定 stateVersion/身份再 await；契约 §E 同步修订 | **动态**：三样本（全等→尝试查询；credentialRef 失配/无 identity→blocked 且无尝试） |
| T10 迟到取消/幽灵绑定 | 已修：操作代次 + 每次 await 复核 + 显式 `postAttempted` 事实；互审后补：`clearBinding` 统一停订阅、hub 投递强判据（须当前绑定 taskId 一致） | **动态（浏览器，2026-10-09 补做）**：目录 GET 失败→提交 POST=0 且无幽灵绑定，恢复后恰好 1 次提交；取消在途摘要失败保留关联且此时拒绝新建；伪造旧任务摘要不被采纳 |
| T02 收尾预算 | 已修：先预留 abort 宽限与最终写时间；abort 从发生时刻重算；清理阶段外层预算 | 字段实测（-14 停机 drainOutcome 含 abortWaitedMs/finalWriteReserveMs、exit 0）；长作业边界未动态 |
| T03 生成门 | 已修：保护/归属就绪进入唯一派发判据（调度链全部入口）+ **旧同步生成入口**（generateMedia）同样受门 | **动态**：缺表/坏表时 protectionReady=false 且 dispatchBlockReason 可读、派发阻断 |
| T06 暂停/退避 | 已修：迟到 Retry-After 与 paused 原因分离并取更晚 retryAt；pause 中止在途下载 | 源码（真实 429 不可安全构造） |
| T11 素材路径 | 已修：可用性与读取同资产根；页面级轻量刷新（ACK/可见性/联网触发）；resolvedPath 统一供播放/下载/保存；互审后补陈旧投递复核 | 源码 + 互审 |
| T12 重载竞态 | 已修：`settingsDraftVersion` 随草稿变化，GET 在途有新输入则不发布快照并可见提示 | 源码 + 互审（互审判定接通） |
| T14 占用生命周期 | 已修：pageId 碰撞处理 + 每次租约实例 leaseId（前后端）+ 无身份释放只作用 legacy + 停机 finalize + 释放表坏表保守 + 释放时间随改名迁移 | **动态（API 级）**：双租约独立、迟到/无身份释放被 skipped；前端浏览器行为源码核对 |
| T15 历史路径/补偿 | 已修：受影响任务只按当前定位；源身份 expectRefs 约束（EIDENTITY）；部分失败补偿 + 持久阻断；释放时间入事务 | **动态**：a→b 更新 resolvedPath=b；复用 a→c 不串线 |
| T16 缺表/越界 | 已修：首次空安装与「曾有保护状态未知」区分；改名前两端祖先保护；marker 写失败升级持久故障 | **动态**：缺表判未知并阻断、坏表持久故障、受保护子文件越界改名 409 EOCCUPIED |
| T17 覆盖写恢复 | 已修：三类区分（不存在/旧内容仍在/新内容已发布）；写入侧三处 + scheduler 传 `expectedContent` | **动态**：两类不确定样本均保留围栏待核对、未自动登记 |
| T18 释放/取消 | 已修：命令 error 等真实进程退出再释放（原生 + 外层）；静态排队取消恰好一次回调 | **动态**：并发=2、排队取消 AbortError 恰好一次且未启动进程、两路真实编码完成 |

## 第五轮动态验证（隔离实例，非收费）

- 隔离实例 `repairValidation5`（生产数据副本，端口 3934，容器内将供应商域名指向 127.0.0.1 保证外部零流量）：T03 恢复入口（真实故障）→ T16 缺表/坏表/越界 → T09 旧格式 → T07 三样本 → T15 a→b/复用 → T14 租约 → T17 两类围栏 → T18 并发与取消。
- 明细：`toonflowHandoff/evidence/repairExecution20261008/run3/validationResults.jsonl`；**T10 行为级浏览器验收（2026-10-09 补做，隔离实例 `repairValidation6`，开跑前 health 确认 `paused=true`，本会话 6 个任务全部 `upstreamId=null` 零新增上游）**：`run3/t10_dynamic_evidence.json`；命令台账（含时间/退出码/去敏输出）：`run3/commandResults.jsonl`；发布记录：`run3/release-16.json`；异常披露：`run3/incident_unintended_upstream.json`。

## 仍未动态覆盖（如实列明）

T11/T12 的浏览器时序交错与 T14 前端复制标签/关闭重开；T02 耗尽自然等待的长作业；T06 真实 429/Retry-After；T07 双账户真实绑定竞争与 account 维度；T17「新内容已原子发布→自动登记」分支；T05/T08 窄竞态；100 订阅聚合压测；桌面端。以上均为源码 + 两轮互审级核对，未冒充实测。（T10 已于 2026-10-09 补做浏览器动态验收：见上表与 `run3/t10_dynamic_evidence.json`。）

---

# 第五轮验收收口（2026-10-09，依据 docs/fifthIndependentAcceptance.md §3/§6，镜像 -19）

保留以上全部历史。本轮只修第五轮报告列出的 8 组剩余反例（T02/T03/T06/T07/T11/T14/T15/T18），保留已关闭的 10 组主缺陷成果，不重做大范围功能。

## 部署身份（收口终态）

| 项 | 值 |
| --- | --- |
| 镜像 | `toonflow:server-20261008-20`，ID `sha256:232811f1a0d679839c6704a4c704ff2d768bab4f87d52cee4dcb8eeb82d966aa`（补做 §N.2 修复后重建） |
| BUILD_ID / 容器 | `server-20261008-20` / 容器 running、healthy |
| 插件 | data 与镜像 build 21 个文件全一致；启动同步 tools {unchanged:8}、nodes {unchanged:7, updated:1}、providers {unchanged:5} |
| 数据 | 13 批 36 cancelled / 2 failed / 5 succeeded；两条成片 SHA 不变 |
| 公网 | 入口 `assets/index-BPjVkrCs.js`（`9cb97224…`）与容器一致；GET 200、POST 恢复（错误口令 401） |
| 配置 | `paused=false`、并发 2/2、等待提醒 24h；五类清理全关；`protectionReady/cleanupReady=true`、`readiness.ok=true` |
| 备份 / 回退 | `/opt/toonflow/backup/repairExecution20261009-r20`；回退=改 image 回 `toonflow:server-20261008-19` + `.env` + `up -d`，不删数据（镜像 -1…-16、-19 保留） |
| health 新字段 | `creationReady`（统一新创建门，含全局暂停）与 `schedulerReady`（恢复完成，不含暂停）分工；`dispatchBlockReason` 给出可读原因 |

## 四个接缝（并行前冻结，契约 §N）

1. **§N.1 准入**：唯一新创建判据 = 存储已装载 + 恢复 settled + 非 recovering/stopping + 无恢复错误/装载告警 + 保护与归属就绪 + **未全局暂停**；**所有真实创建入口**（后台调度、旧同步 HTTP、Agent、节点、**供应商调试台**）统一消费；受理排队与真实创建分开。
2. **§N.2 改名事务**：任务锁→路径锁固定序；发现与 outputs 发布同一临界区；所有尝试写入项按「可能已发布」补偿；`relocationBlocked`/范围保护被实际消费，写不出即停止操作。
3. **§N.3 编辑租约**：释放必须**同时**匹配 leaseId 与逐路径 version；每 hold 不复用出网身份；**C 在 create/renew 2xx 前持久化保护下限与版本代次**（W 仅成功后写回）；非法时间进入持久未知。
4. **§N.4 停机预算**：45s 单一截止内显式分配**目标值**（HTTP≤26999ms、MCP≤2000ms、清理≤2000ms+外层上限 1500ms、媒体目标 abort 5000ms + 最终写 8000ms）；调用点按当刻剩余反算并传入，**可能压缩**——压缩情况由 `drainOutcome`（请求/可用/实际、`abortGraceTruncated`、`finalWriteAvailableMs`、`totalMs`）如实上报；最坏阶段上限叠加时媒体实际约 12.5s，不把 13s/5s 写成硬性保证（第六轮验收 §6.1）。

## 8 组剩余反例的处置与验证

| 组 | 处置 | 验证范围 |
| --- | --- | --- |
| T03 同步漏准入 / 归属部分损坏 | 同步入口消费统一判据；归属整表/坏条目/非法时间 → 持久 `ok=false` 并同时阻断删除与新创建 | **动态**：paused 下同步入口 503 EBLOCKED；注入 `original.refs` 非数组 → readiness.ok=false + 同步入口与清理同时阻断 + 显式恢复放行；**调试台门动态 503** |
| T07 失配后回退原提交身份 | 有核验依据时身份失配**直接 blocked**，不得回退 `submissionIdentity`；契约 §E 同步写实 | **动态**：失配样本 blocked（原因含「不会用原提交身份继续查询」）+ 全等样本通过身份门（正例对照） |
| T14 释放匹配 / 版本复用 / 异常退出 | leaseId+version 双匹配、缺版本不降级；持久代次（含旧格式文件缺 `generation` 的保守迁移）；续租前持久化保护下限；非法时间持久未知 | **动态**：双租约互不误释放、错版本/缺版本 skipped、再创建 version 递增；**旧格式 releases 后首个 version=1791484114666（保守起点）** |
| T15 连续改名 / 发布后失败 / 补偿屏障 | 发现与发布同锁临界区；全部尝试写入项补偿；阻断被实际消费；fallback 拒绝任务引用 | **动态**：连续 A→B→C 均 200 且任务 resolvedPath 跟随到 C；孤儿引用改名 409 EOCCUPIED；**阻断类 EPARTIAL 409 且不建范围保护** |
| T06 补查询丢退避下限 | 补查询分支与下载分支同序（先保存可靠 Retry-After 再处理 abort），保留 paused/取消原因 | 源码级（真实性 429/长等待不可安全构造，如实标注） |
| T11 旧路径写回 / 换结果未切换观察 | hub 投递携带发起时输出定位并双重校验；savedResult 身份 watch 重建订阅；cancel 直查摘要同样校验定位（互审发现并补修） | 源码级 + 两轮独立互审（未跑浏览器 UI 交错，如实标注） |
| T02 入口耗掉媒体宽限 | 按 §N.4 显式分配并传入可兑现参数；drainOutcome 新增请求/可用/实际字段 | **动态（阶段耗尽边界，2026-10-09 补做）**：长作业在途下真实 SIGTERM → 媒体阶段真实耗时 **32100ms**（自然等待 32s）、**abortWaitedMs=103**、abortGrace 请求 5000/**可用 5000**/未截断、finalWriteAvailable **12897ms**、ExitCode 0、停机墙钟 33.3s ≤ 45s；各阶段起止见带时间戳日志（`run3/fifthRound_verification.json` 的 `t02BoundaryDynamic`） |
| T18 未确认退出仍释放 | 等待上限只标记「退出未确认」：SIGKILL → 再观察 5s → 仍无确认则**保持名额、不投递终止事件**（保护输出） | **动态（回归）**：并发=2、排队取消恰好一次 AbortError；未确认退出分支源码级 |

## 交叉审查（四次独立只读互审）与处置

- 代 Q 审 C：三个核心反例闭合；发现「合法旧文件缺 generation 时首次发放从 1 开始」与「EPARTIAL 两义混用导致范围保护原因失实/过度阻断」→ **已修**（代次保守迁移 + 阻断类不建范围保护）。
- 代 C 审 W：T11①/② 与 T14 前端闭合；发现「cancel 直查摘要缺输出定位校验」同类窄窗口与挂起释放注释不成立 → **已修**。
- 代 W 审 Q：7 接缝闭合；契约 §E 措辞已补明「失配直接 blocked、不得回退原提交身份」；其余为观察项（运行时阻断可见性、未使用别名、已不在台账的运行时阻断不可消费）。
- 审 I：T02/T03/T18 闭合；发现「供应商调试台绕过统一创建门」→ **已修**（服务层 + 路由预检双层）；「未确认退出即无限期挂起」为设计取舍 → 记录为运行限制（需人工巡检残留 ffmpeg 进程），不宣称必然收敛。

## 仍未动态覆盖（如实列明，不冒充通过）

T06 真实 429/长等待；T11 浏览器旧响应交错与换结果重建订阅；T14 复制标签/过期后旧释放命中/崩溃与预算截断后的保留期重算；T15 发布后 fsync 失败注入与补偿再失败；T18 未确认退出分支与原生包装排队取消的"仅回调"调用形态；**T02 的「HTTP 阶段占满自身上限」变体**（分块 body 保持未产生在途计数、限速上传未被计为在途，两次未构造成功；HTTP≤26999ms 取自同一截止算术）；T17 成功认回正例；T05/T08 窄竞态；100 订阅聚合压测；桌面端。以上均为源码 + 独立互审级结论。

## 费用事件（如实，不修饰）

- 整个返工过程共 **1 次误发上游创建**（`video_6081f73981`，dolaVideo/seedance-v2.0/5s）。第五轮独立审计只读 GET 确认其**已 completed（有结果地址）、并未被取消**（Dola 适配器无取消接口，`confirmed=false`）；**费用金额与退款未核实**。事件记录已按此更正，不再写"成功取消"。
- **本轮（第五轮收口）新增真实生成请求 0**：全部探针在「生成凭据置空 + 供应商域名黑洞 + paused=true」下执行，任一步先决条件失败即停止该验证链。

## 补做说明（2026-10-09，-20）

- **T02 阶段耗尽边界已补做（动态）**：长作业在途（供应商提交阶段永不返回）+ 真实 `docker stop -t 60` → 媒体阶段真实耗时 32100ms、abortWaitedMs=103、abortGrace 可用 5000ms/未截断、finalWriteAvailable=12897ms、ExitCode 0、停机墙钟 33.3s；各阶段起止见带时间戳日志（`run3/fifthRound_verification.json` 的 `t02BoundaryDynamic`）。「HTTP 阶段占满自身上限」变体两次未构造成功，已列入未动态覆盖。
- **§N.2「单条写入助手未按可能已发布重写」已修复**：新增 `persistRecordsWithRollback`（六个单条写入单元接入：先置已发起标记 → 失败按快照重写 → 再失败保留内存并建立持久故障）；tsc 通过，fsync 失败未动态注入（如实标注）。
- **再发布 -20**：见本页部署身份表；回退目标 -19。证据更新：`run3/fifthRound_verification.json`（t02BoundaryDynamic / n2SingleWriteFix / ipv6LeakNote / publish20）与 `run3/commandResults.jsonl` 末 7 行。

---

# 第六轮验收收尾（2026-10-09，依据 docs/sixthIndependentAcceptance.md §3/§4/§5/§6，镜像 -22）

第六轮仅剩 T15 一组、两条故障路径；本轮按契约 **§O**（T15 收尾接缝）由 I 冻结、Q/C 并行收口，其余 17 组成果保留不动。

## 部署身份（收口终态）

| 项 | 值 |
| --- | --- |
| 镜像 | `toonflow:server-20261008-22`，ID `sha256:a5ae52faacbbe0c6c95c7a9dd48b48470b9735acbe8bcc90732094452d13c4c9` |
| BUILD_ID / 容器 | `server-20261008-22` / 容器 running、healthy |
| 插件 | data 与镜像 build 21/21 一致（tools 8 / nodes 8 / providers 5 全部 unchanged） |
| 数据 | 13 批 36 cancelled / 2 failed / 5 succeeded；两条成片 SHA 不变 |
| 公网 | 入口 `assets/index-BPjVkrCs.js`（`9cb97224…`）与容器一致；GET 200、POST 401（维护门已撤） |
| health | `paused=false`；schedulerReady / creationReady / protectionReady / cleanupReady=true；`unfinishedRelocations` 为空；五类清理全关 |
| 备份 / 回退 | `/opt/toonflow/backup/repairExecution20261009-r22`；回退=改 image 回 `toonflow:server-20261008-20` + `.env` + `up -d`（镜像 -1…-20 保留） |

## T15 两条反例的处置与动态验证

| 反例 | 处置（§O） | 验证（隔离实例，非收费） |
| --- | --- | --- |
| §3.1 连续写盘失败后重启丢保护 | C：**先持久意图后移动**（保护表新增 `relocationIntent`，双端保护；写失败不移动）；协调路径 `deferIntentRelease` 由 **Q 在 outputs 落盘后**解除；重启装载保留意图并参与改名拒绝/清理占用/诊断；文案三态如实 | **动态**：意图写失败 ⇒ 500 ERECORDS 且**未移动**、源仍在；写入持久意图+持久阻断后重启 ⇒ health 透出 `unfinishedRelocations`/`relocationIntents`，**不同目标改名 409 EOCCUPIED**；普通 A→B→C 后**无遗留意图** |
| §3.2 源已反搬回 A 时精确恢复被自身阻断 | Q：阻断过滤器放行「精确同 source→target」并把匹配 transactionId 传给 C；C：同事务身份 + 源归属身份已核对时不得因本事务自身意图/占用拒绝；成功后 Q 清 block、C 清意图 | **动态**：同一状态下精确 A→B ⇒ **200**（updatedTasks/updatedOutputs=1），终态仅 B、记录在 B、`outputs.resolvedPath=B`、block 与意图均清除、health 诊断为空 |

其余 §5 场景动态结果：**旧路径被新文件复用/身份不符 ⇒ 409 EIDENTITY 拒绝且文件仍在 A**；**源已不在、目标有原事务依据 ⇒ 200（migratedRecords=0）alreadyRelocated 认回能力保留**；**同源并发两请求 ⇒ 同刻下发，败者 404 EMISSING、胜者 200，终态一致且无遗留意图**（按同源并发口径记录，未构造 B→C 交错）。

**未动态覆盖（如实）**：records 替换已发布后 fsync 失败注入；「移动后补偿+范围保护+故障标记全部写失败」三重连续失败与随后重启（以「意图写失败不移动」与「重启消费持久意图」两条相邻场景覆盖）；显式核对入口在途窗口竞态（已加路径锁，未触发）。

## §6 更正（本轮完成）

- **§6.1 T02 说明对齐**：`apps/server/src/index.ts` 停机注释与「预算分配」日志改为**目标值 + 压缩规则**（最坏阶段上限叠加时媒体实际约 12.5s，不写 13s/5s 硬保证）；`deployment.md`、本文 §N.4 条目同步。
- **§6.2 证据更正**：`commandResults.jsonl` 第 36/37/43–49 行占位时间改为 `at: null` + 可证明区间与来源（r19/r20 构建与备份、容器启动等锚点），typecheck 行改记**子命令真实退出码**（desktop=1 / web=2 单列，不写「32 包全通过」）；`fifthRound_verification.json` 的 T15/-18/-20 加范围更正；`t10_dynamic_evidence.json` 场景 A 判词改为「部分子场景通过，完整交错未动态覆盖」；新增 `run3/README.md` 说明各证据文件口径（`validationResults.jsonl` 14 行 ≠ 14 个动态场景）。
- **§6.3 费用与外发来源**：事件台账保持「误发 1 次、上游 completed、未取消、费用未核实」；IPv6 泄漏（假 Key → 401 拒绝、未创建）已在 `fifthRound_verification.json.ipv6LeakNote` 如实记录，不宣称外部零流量。

## 互审（两名独立只读审查员）与处置

代 Q 审 C（重启/清理消费）与代 C 审 Q（精确恢复/outputs 发布）均判定 §3.1/§3.2 **源码级闭合**；共同指出「C 在 Q 发布 outputs 前解除意图」与验收 §4.2 字面不符 → 已改为 `deferIntentRelease`（Q 在 outputs 落盘后解除）。另修复：意图持久失败的持久故障与诊断、EPARTIAL 文案按真实状态区分、显式核对入口加路径锁、目标键保护条目合并、EMISSING 带 warning、事务身份单一来源与调用前 resolve、agent/MCP 对 warning 的消费（agent 记日志 / MCP 结构化字段）。保留为记录项：事务 ID 无代次（§O.1 设计）、运行时阻断对「不在台账的任务」不可消费、Q 无人工清除 block 入口（保守）。

## 观察（非缺陷组）

容器日志 2026-10-08T19:19:42Z（CST 03:19）一条 `只允许 Toonflow 页面访问控制连接 status: 403` 内部调用堆栈——控制 API 按设计拒绝缺少页面来源的内部调用，未见用户影响，仅记录。

---

## 第七轮独立验收（2026-10-09）：T15 R1–R4 收口，镜像 -23

对象为[第七轮清单](seventhIndependentAcceptance.md) §2 的 R1–R4（保护生命周期、原意图核对与写保护、完整参与集合、提示出口）。契约新增 **§P**（P.1 参与集合 / P.2 活动边界与唯一解除时点 / P.3 原意图身份与写保护 / P.4 清除三态 / P.5 提示出口）并作为本轮唯一接缝冻结。

| 反例 | 处置 | 动态验证（`repairvalidation12` 隔离实例，假凭据 + 双栈黑洞 + paused=true） |
| --- | --- | --- |
| R1a 反向补偿提前清唯一意图 | Q：正反两向都传 `deferIntentRelease=true` + `participants`，仅三处收敛点释放；C：协调路径失败/回滚确认分支不再自清 | **S-C 自然链**（batches 只读 ⇒ publish EACCES）：500 ERECORDS，双端意图 2 条目保留、未建范围保护、block 未落盘如实标注（仅本进程阻断）；重启后意图装载、不同目标 409、显式核对 200（1 事务/2 条目） |
| R1b 人工核对提前清在途意图 | C：清除入口先查活动边界（Q 运行时 + 持久未收敛）⇒ 409 EBUSY 可读原因；锁序不反向 | **S-B**：未收敛活动事务上显式核对 ⇒ 409 EBUSY「参与任务 VAL12-T1 仍有该事务的未解除阻断」 |
| R1c 双端保护缩成目标单端 | C：带意图条目迁移不丢源端；按意图 source/target 反查兜底；清理/改名/写/恢复共用同一判定 | **S-A**：目录端点后代改名 ⇒ 409（受保护范围+事务说明）；双端意图在 S-A/S-B 全程生效，收敛后统一清除 |
| R2 恢复不核原意图、覆盖写可改写源 | C：`verifyRelocationIntentConsistency`（方向/尺寸/sha256/mtime 规则）；修正旧证据不覆盖；写路由 ×2 拦截 | **S-A**：受保护端点覆盖写 ⇒ 409 ERELOCATING；外部替换后重试 ⇒ 409 EIDENTITY（size 53→200、sha/mtime 差异全列，versionBasis 未被覆盖）；还原后 ⇒ 200、记录/文件迁至 B、意图清除 |
| R3 部分回滚后恢复漏参与者 | Q：参与集合=持久∪发现；已到目标仅剩 block 者逐项 settle；未收敛不宣告完成 | **S-B**：T1（已发布+block）+T2（未发布）精确恢复 ⇒ 200（updatedTasks=[T2]、T1 block 清除、T2 重发布、意图释放）；随后 **B→C ⇒ 200 无残留** |
| R4 提示出口丢失 | I/W：HTTP 成功/失败、MCP 失败文本、Agent 宿主日志级、网页通知消费 | **S-E**：MCP `writeBinary` 受保护路径 ⇒ isError 且保护原因进入最终可见文本；`rename` 失败文本同口径；文件未被改写 |

补强动态项：**S-D** 源缺失+目标可信身份 ⇒ 404 EMISSING 保守拒绝（身份不可确认）→ 补身份后 ⇒ 200 认回（`migratedRecords=0`）、意图与 block 清除（矩阵第 6 行）。

**未动态覆盖（如实）**：fsync/原子写失败三态（§P.4）、成功 warning 端到端（需清除失败触发）、自然多任务部分发布链的发生过程（S-B 为终态预置）、Agent writeFile 与 generation/scheduler 落盘写保护的触发（需内置 Agent 推理或真实生成，本轮预算 0）。**残余边界**：硬歧义状态保留保护+人工核对；EIDENTITY 且从未移动时按平凡收敛释放旧意图（数据一致）；`unfinishedRelocations` 按任务阻断投影、仅意图状态在 `readiness.relocationIntents`。**费用**：本轮新增真实生成 0；隔离实例无出站日志；未调用内置 Agent 推理；历史误生成 `video_6081f73981` 记录保持（completed、未取消、费用未核实）。

**发布 -23**：维护门（公网非 GET→503）→ 回环持久化 paused=true（settings/save 200，creationReady=false）→ 授权备份 `repairExecution20261009-r23` → 切 `toonflow:server-20261008-23`（`sha256:13312184f5f3…`）→ 核对（21/21 插件逐文件一致、13 批 43 条 36/2/5、两成片 SHA 不变、公网入口 `index-DDSkC3mS.js` `080dbefc…` 与容器一致、health readiness.ok）→ 恢复 paused=false（并发 2/2、提醒 24h、五类清理全关）→ 撤门（公网 POST 由 503 恢复为 401 鉴权）→ 清理隔离实例与旧源码目录。证据：`evidence/repairExecution20261008/run3/seventhRound_verification.json`。
