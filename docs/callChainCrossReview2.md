# 第二轮互审记录（第五轮返工，2026-10-08 夜）

依据：本轮 goal「按 Q/W/C/I 文件所有权并行并交叉复核正式调用链」。方式：在 Q/W/C 交付后另派**两名相互独立、互不可见**的只读子审查员（独立上下文；禁用写文件/构建/测试/启动服务；每条结论须带 file:line；不确定须标「未能确认」）。

- 范围一：后台任务/身份/停机 —— T09 / T07 / T10（服务端部分）/ T02 / T03 / T06 / T15（任务侧）+ 契约 v4 §E。
- 范围二：前端实例/代次 + 文件事务/保护 —— T10 / T11 / T12 / T14 / T15（文件侧）/ T16 / T17 + 契约 v4 §I/§J/§K。

## 一、范围一结论摘要

| 接缝 | 结论 | 证据要点（审查员给出的 file:line） |
| --- | --- | --- |
| T09 提交许可 | 接通（1 处残余窗口） | `store.ts:754-768`（updateMediaTaskIfApplied 仅在 apply 生效且整批落盘成功后为 true）、`store.ts:694-724`、`scheduler.ts:914-963`、恢复两入口 `scheduler.ts:1522-1530/1606-1620`；`updateMediaTask` 原返回约定未被破坏 |
| T07 核验身份 | 接通 | `store.ts:68-78` 五项全等；`scheduler.ts:183-227` 身份失配即 blocked 且不得回落缺地址兼容；`index.ts:824-843` 命名空间按当前凭据；`index.ts:997-1050`（rematch 先固定版本/身份再 await、写入前比较）、`1068-1122`（bind 同序） |
| T02 收尾预算 | 接通 | `scheduler.ts:1836-1873`（先预留 abortGrace+finalWriteReserve）、`1875-1923`（abort 从发生时刻重算、最终写用全局截止、drainOutcome 如实）、`store.ts:499-522`、`index.ts:34-86` |
| T03 生成门 | **有缺口（已修）** | 调度链全部经同一判据（`scheduler.ts:784-788/806-822/852-863/1533-1558`；startJob 仅 3 个调用点且全在 tick 内）；**旧同步入口**（`utils/media/generation.ts`←`routes/ai/media/generate.ts`、Agent mediaGeneration 工具、nodeScaffold 局部重绘）原先不查任何就绪门 |
| T06 | 接通 | `index.ts:911-921/934`（pause 中止在途下载）、`scheduler.ts:1302-1317`（更晚 retryAt 与 paused 原因分离）、`1402-1413`（abort+retryAfterMs 落盘）、`1633-1645`（重启不清未来 retryAt） |
| T15 任务侧 | 接通 | `index.ts:1237-1247`（当前定位/前缀改写）、`1369-1377`（只按当前定位选任务）、`1385-1396`（refs 交集约束）、`1300-1340`（补偿）、`1284-1290`（持久阻断）、`outputState.ts:53-64/68`（历史路径需 refs 才认回） |
| 契约 §E | **有偏差（已修）** | 语义已实现（全等 + 当前命名空间锁内重查），但文档字段名 `verifiedIdentity`/`verifiedQueryNamespace` 与实现（`identity`，命名空间临时派生）不一致 |

发现的问题与处置：

| # | 问题 | 处置 |
| --- | --- | --- |
| 1 | **旧同步生成入口不受就绪门约束**（保护/台账不健康时仍可发起新收费请求） | **已修（I）**：`utils/media/generation.ts` 的 `generateMedia` 入口加 `fileRecordsStoreHealthSnapshot()` 门（未就绪 → 503 EBLOCKED + 可读原因），覆盖 HTTP/Agent/节点三处调用 |
| 2 | 契约/实现字段不一致 | **已修（I）**：`docs/executionContract.md` §E 改为以 `identity` 为准并注明命名空间派生规则、`queryIdentity` 非落盘字段 |
| 3 | T02 内部 30s 自然等待上限偏保守 | **记录**：不越全局预算；abort 宽限非零的验收不受影响 |
| 4 | submitting+cancellationRequested+显式 pending 恢复判 failed 而非 cancelled | **已修（Q）**：`scheduler.ts:575-593` 新增 `finalizeUnattemptedSubmission`，两处恢复入口改用；证据强度不变（仍只在显式 pending 且无尝试时收尾） |
| 5 | account 维度恒 unverifiable（无可信种子） | **记录为固有限制**（上游不回显 account；绑定仍要求 ID 回显 + 当前命名空间唯一） |

## 二、范围二结论摘要

14 个接缝中 11 个确认接通（含：T12 草稿版本判定接通；T14 前端 pageId 碰撞处理与 leaseId 三处真实发送；T14 后端释放身份与停机 finalize；T16 缺表/坏表区分与两端祖先保护；T17 三类区分与三处写入侧传 expectedContent；§I/§J/§K 一致性）。

发现的问题与处置：

| # | 问题 | 处置 |
| --- | --- | --- |
| 1 | **T10 可达缺口**：`onCanvasSaved` 清绑定但未停订阅 → 旧任务 A 的迟到摘要可被采纳进新任务 B（守卫 `binding?.taskId` 弱判据） | **已修（W）**：`clearBinding()`/`revokeUnsubmitted()` 内统一 `stopPolling()`；`startPolling()` 强制把订阅同步到当前绑定；`onHubResult` 改为强判据（要求当前绑定存在且 taskId 一致，否则丢弃并结算等待者）；查询/错误投递均携带发起时快照键 |
| 2 | T11 窄窗口：已保存结果投递在 await 前后未复核目标，迟到旧路径可切回 | **已修（W）**：投递携带 `queriedTaskId/queriedPath`，应用前比对节点当前值，不匹配整单丢弃；刷新路径每个 await 后校验订阅代次与当前 savedResult |
| 3 | T16 标记写失败时缺表可被判「首次空安装」的健康分支（三重同时不成立才可达） | **已修（C）**：marker 写失败升级为持久故障（内存 + 保护表 `failure` 字段）；缺表判定收紧为需保护表/records/relocations/releases marker 全部无证据；损坏分支先持久化故障、失败则保留损坏文件原样（不再移走证据） |
| 4 | T14 停机 finalize 未被剩余预算覆盖 | **已修（I）**：`index.ts` 清理阶段外层加 `Promise.race` 预算上限（含 finalize） |
| 5 | T17 观察：scheduler 写入路径不传 expectedContent（保守但无法自动恢复） | **已修（Q）**：`withRegisteredOutput` 新增可选 `expectedContent`；`saveTaskOutput` 传入真实 `{size, sha256}` |
| 6 | T16 观察：受保护子树自身改名被整体拒绝（更严格） | **记录**：方向保守，不再扩大改动面 |

## 三、处置后的复核

- `bun run routes` 正常；全仓 `bun run typecheck`：**32 包通过**，仅 `@toonflow/desktop`（electrobun 声明缺失）与 `@toonflow/web`（唯一诊断 `electrobun.config.ts` 缺 `.hutch/devkit` 声明）失败——与第四轮验收报告记录的既有基线一致，未新增诊断。
- 修复后构建 `toonflow:server-20261008-16`（`sha256:a0e851d002ca…`），并在隔离实例先验迁移兼容（任务/保护状态保留）后按发布门上线；发布后 21/21 插件文件一致、任务分母与成片不变、公网入口一致。
- 本轮动态验证（非收费、隔离实例）：T03 恢复入口（真实故障）、T16 缺表/坏表/越界改名、T09 旧格式恢复、T07 三样本、T15 a→b 与复用路径、T14 租约实例 API、T17 两类围栏、T18 并发上限与排队取消回调——见 `evidence/repairExecution20261008/run3/validationResults.jsonl`。
- **未动态验证（如实）**：T10/T11/T12 的浏览器时序交错、T14 前端复制标签/关闭重开的真实浏览器行为、T02 耗尽自然等待的长作业、T06 真实 429/Retry-After、T07 双账户真实绑定竞争、T17「新内容已发布→自动登记」分支、T05/T08 的窄竞态。以上均为源码/两轮互审级核对，未冒充实测。
- **异常如实披露**：隔离验收期间发生 1 次未预期的真实上游创建（`video_6081f73981`，见 `run3/incident_unintended_upstream.json`），原因是脚本先置 paused 的请求因引号拼接错误返回 409 未被察觉；已记录取消意图并复位暂停。除该 1 次外，本轮新增收费生成 0。
