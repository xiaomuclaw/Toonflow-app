# 互审记录：正式调用链（第四轮返工后，2026-10-08）

依据：第四轮 goal「完成后互审正式调用链」。方式：另派**两名相互独立、互不可见**的只读子审查员（独立上下文），
禁用写文件/构建/测试/启动服务；只允许读文件与搜索类命令；每条结论必须带 file:line；不确定的必须标「未能确认」。
两名审查员各自报告**原文**收录于本节（结论表为摘要，逐条证据见其报告编号），并附主窗口处置与复核方式。

- 审查一：媒体任务「受理 → 调度 → 上游 → 输出 → 前端回写」正式调用链接缝（契约 v4 §B/§C/§D/§E/§F/§G/§H；T01/T05–T11/T13）
- 审查二：「编辑占用 → 清理 → 保护表 → 目录改名」链 + 「FFmpeg 进程租约」+ 「停机排空」（契约 v4 §A/§I/§J/§K/§L；T02/T14–T18）

---

## 一、审查一（受理→回写主链）结论摘要

| # | 接缝 | 结论 |
| --- | --- | --- |
| 1 | 任务路由字段 ↔ 前端消费（taskId/state/outputs/三态 summary/unknown/awaitingReview） | 接通（1 条低危观察 A3） |
| 2 | outputs[]（state/resolvedPath/cleanedAt/sha256/path）写入 ↔ 读取 | 接通（素材库/文件树已接公共只读查询） |
| 3 | 就绪门 / 容量预约的派发入口覆盖 | 接通（`startJob` 仅 3 处调用，全在 tick 内；无绕过入口） |
| 4 | 三身份 + credentialRef 顺序 + account 可信来源 | 接通（account 为闭环不可达，A4） |
| 5 | 下载重试先落 retryAt 再结束作业 / 迟到回调忽略 | 接通（作业内已无 sleep，三重复核 stateVersion/tracking/paused） |
| 6 | 快照输入与 T09/T08 | 接通（旧同步直连通道除外，见边界） |
| 7 | 前端状态机与 5s 截止 | **有缺口**（A1 总时限、A2 unknown 文案） |

发现的问题与处置：

| 编号 | 问题（审查一） | 处置 |
| --- | --- | --- |
| A1 | `getGenerationStatus` 的“≤5s”只覆盖“等待自身订阅结果”，前置 `attach()`/目录解析无超时且失败 Promise 会缓存 | **已修**：节点工具整次查询统一 5s 截止，超时返回本地摘要并 `queryPending=true`（`packages/nodes/videoGenerationNode/src/index.vue` getGenerationStatus） |
| A2 | unknown 且 paused/blocked 时通用文案覆盖 `waitingReason` | **已修**：unknown 分支合并服务端等待原因（`packages/nodeScaffold/src/useMediaTask.ts` applyTask） |
| A3 | 明确 503（ESTOPING）按 unknowable 保留本地绑定 | **不改，如实记录**：服务端确未持久化，但客户端无法把“确认未受理”与其它 5xx 可靠区分；保留绑定 + 人工核对是防重复扣费的保守取舍 |
| A4 | account 核实闭环不可达（唯一可信来源是同路径写入的 accountHash） | **设计使然**：契约 §E“无可信来源不编造”，account 恒 unverifiable，已在验收文档如实标注 |
| A5 | paused 期间迟到“上游 running”结果仍更新 retryAt/waitingReason（不改回 active、不派下载） | **记录为轻微影响**：不违反 §B 明文；resume 后可能延后一次查询，不改代码 |

审查一「未能确认」清单（如实保留为已知边界）：
- 图片/音频节点仍走旧同步通道（合同 v4 §D.8 只点名视频节点）。
- 旧同步直连 `generateVideo` 路径不受 T09 快照保障（契约写明旧独立同步 HTTP 接口可维持原结构）。
- `getFileOutputState` 与任务侧 `resolvedPath` 在“改名+清理”组合场景的一致性未动态验证（静态取值域一致）。

---

## 二、审查二（清理/占用/改名 + FFmpeg + 停机）结论摘要

| 接缝 | 结论 |
| --- | --- |
| 编辑占用（三路由、占用键语义、pageId 释放、陈旧占用、pageId 缺失兼容、holdEditing 五入口） | 接通 |
| 清理链（保护表代次/持久故障/后代判定/锁内重读） | 接通（人工/Agent 删除不查登记围栏 = 边界） |
| 改名事务（路由 → withTasks → 任务锁 → 路径锁 → outputs.resolvedPath；回滚覆盖四类持久内容） | 接通（Agent 工具接线断开、MCP 绕过 = 问题 1/2） |
| FFmpeg（终态方法覆盖、clone、静态 ffprobe、供应商/Agent 出口、取消不泄漏） | 接通（能力查询未覆盖 = 问题 4） |
| 停机（单一截止、503 门、在途计数、drainOutcome、退出码） | 接通（SSE 计数偏差、MCP 无预算 = 问题 6/7） |
| 字段名/错误码映射 | 基本接通（改名错误码折叠 = 问题 8） |

发现的问题与处置：

| 编号 | 问题（审查二） | 处置 |
| --- | --- | --- |
| 1 | Agent 工具 `files.rename` 外层 `withWritePaths` 与内层 relocate 重复锁同一批路径 → 锁不可重入，必然 EBUSY（潜伏：仓内无内置调用方） | **已修**：去掉外层预锁，只做路径解析与根目录保护，锁与事务全部交给 `relocateWorkspacePathWithTasks`（`apps/server/src/agent/tools/index.ts`） |
| 2 | MCP `workspaceFiles` 的 rename 直接 `renameWorkspaceFile`，绕过归属迁移/重定位日志/任务 outputs 定位/占用与保护检查 | **rename 已修**：改走同一事务入口；**remove 保持原样并记录**：契约 §J 只约束清理判定，人工/MCP 删除不受保护表阻断（如需阻断属范围扩展，未擅自加） |
| 3 | 保护表持久故障 / 范围保护只有内部函数、无任何调用方 → 故障后自动清理永久暂停且只能改盘上文件恢复 | **已修**：新增 `POST /api/cleanup/protections`（认证 + directory + reason，可选 paths 解除范围保护）；发布后冒烟实测 `200 {"clearedPaths":0}` |
| 4 | FFmpeg 能力查询（availableFilters/Codecs/Encoders/Formats 及 get* 别名）会 spawn 真实进程但未纳入租约 | **已修**：命令实例纳入终态方法表（回调式完成计数）；服务端 Proxy 同时包装静态形式（`packages/ffmpeg/src/commandSlot.ts`、`apps/server/src/utils/ffmpeg/index.ts`） |
| 5 | 排队分支对“promise 型终态方法”返回 command 使 `await` 失效 | **核实为不适用**：本仓库 fluent 分支（@renmu/fluent-ffmpeg）的 `run/exec/execute` 原生返回 `this`（processor.js:393-640），排队分支返回 command 与原生语义一致；能力查询为回调式（已由问题 4 覆盖） |
| 6 | 在途计数“SSE 响应头后不计入”实为“进入后 250ms 一次判定”，晚 flush 头的 SSE 会占满到连接关闭 | **已修**：改为精确拦截 `response.writeHead`（`flushHeaders` 亦经其），响应头为 `text/event-stream` 时立即不再计入（`apps/server/src/app.ts`） |
| 7 | `stopMcpRuntime()` 不受剩余预算约束（严格违反 §A.1） | **已修**：以剩余预算 `min(8000, remaining-12s)` 做 race；-14 停机实测日志出现「MCP 已关闭（预算 8000ms）」 |
| 8 | Q 的 `ENOTFOUND`/`EPARTIAL` 被折叠为 `ERECORDS`（500），丢失 404/部分完成语义 | **已修**：`ENOTFOUND→EMISSING(404)`；其余折叠为账本错误，消息原样透出（`apps/server/src/utils/cleanup/index.ts`） |
| 9 | editing create 持锁失败整体 409 无部分续租；人工/MCP 删除不检查登记围栏 | **如实记录为已知边界**（未改） |

审查二「未能确认」清单：全部锁/竞态结论均为源码核对（未动态执行）；`files.rename` 是否被第三方插件调用；能力查询在真实负载下是否可达；「只调 screenshots 不 run 是否泄漏租约」（**本次核实**：该 fork 的 `screenshots/thumbnail` 内部自调 `ffprobe → run`，由 run 的包装统一计入，不会泄漏）；MCP rename/remove 是否被验收口径视为 §K 正式入口（**已按“是”处理：rename 已接入统一事务**）。

---

## 三、修复后的复核（本窗口执行）

| 步骤 | 结果 |
| --- | --- |
| 类型检查 | `apps/server` tsc 通过；全仓 `bun run typecheck`：nodeScaffold / node-video-generation / server 等通过；仅 `@toonflow/desktop`、`@toonflow/web` 因仓库既有 electrobun 声明缺失失败（与本次改动无关） |
| 路由生成 | `bun run routes` 生成 `/api/cleanup/protections` 并挂载 |
| 构建 | `toonflow:server-20261008-14`（`sha256:b0653d6819e3…`），产物含新路由与能力查询覆盖标记 |
| 发布 | 维护门（公网非 GET→503）→ 持久 paused=true → 权威备份 → compose/.env 切 -14 → up -d → 核对 → 恢复 paused=false → 撤门 |
| 发布后核对 | BUILD_ID `server-20261008-14`；容器 running/healthy/restarts=0；21/21 插件文件与镜像 build 一致；插件同步日志 tools 8 / nodes {7 unchanged, 1 updated} / providers 5；13 批 36 cancelled/2 failed/5 succeeded 与成片 `997b0f25…` 不变；公网入口 `index-CXPmEegm.js` 与容器一致（`5f3d10f3…`）；公网 GET 200、POST 401（维护门已撤） |
| 停机实测（-14 新代码路径） | `docker stop -t 60` → ExitCode=0；日志：封闭受理 → HTTP 停止受理（在途 0）→「MCP 已关闭（预算 8000ms）」→ 清理收敛 → 排空结果 `completed=true, pendingJobs/Writes/Inflight=0` → 退出；重启 healthy |
| 新路由冒烟 | `POST /api/cleanup/protections`（认证 + Origin + reason）→ 200 `{"clearedPaths":0}`（无故障时幂等 no-op） |
| 未动态复核 | A1/A2 的前端慢网络场景、能力查询纳入租约后的真实并发样本、MCP rename 事务的真实调用（MCP 会话未复跑）——均为源码 + 构建 + 类型检查级复核，未冒充实测 |

## 四、本次互审未能覆盖的范围（如实列明）

- 未复核 §B/§C/§D/§E/§F/§G/§H 中与两审查清单无关的其余条款；未复核桌面端（desktop/mobile）路径。
- 未做动态竞态构造（锁交错、SSE 晚 flush、能力查询并发）：契约 §M 要求源码级结论必须标注，已逐条标注。
- 审查员为独立上下文的只读子审查员（同一工具环境、不同上下文），不是外部第三方审计；独立验收仍由审计窗口另行进行。
