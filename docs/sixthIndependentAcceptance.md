# Toonflow 第六轮独立验收与最后收口要求

核查对象：`server-20261008-20`。线上只读取证时间：**2026-10-09 03:16—03:22（北京时间）**。本报告随后完成源码与证据交叉核对。

**结论：上轮剩余 8 组中，7 组主缺陷从源码关闭；原 T01—T18 累计 17 组主缺陷源码已修，剩余 T15 一组、两条具体故障路径。尚不能称为全部验收通过。**

本轮新增关闭 T02、T03、T06、T07、T11、T14、T18；保留此前关闭的 T01、T04、T05、T08、T09、T10、T12、T13、T16、T17。下一轮只收尾 T15 和本文明确列出的证据说明，不再重做已修功能。

“主缺陷源码已修”指已发现反例在当前正式调用链中得到关闭，**不等于所有故障、浏览器交错和跨天场景均已动态通过**。本轮独立核实了线上运行、接口、文件指纹及本机类型检查；Q/C/W 子 AI 对负责范围进行了只读复核。

本轮审计新增真实生成 **0**，未调用内置 Agent 推理，未改产品源码、真实配置、用户画布，未部署、重启、开启清理或做生产故障注入。新增内容仅为本报告和[审计快照](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/sixthIndependentAudit20261009/auditSnapshot.json)。没有新增测试文件、临时测试程序、mock 服务或自动检查入口。

## 1. 已独立核实的当前状态

| 项目 | 核实结果 |
| --- | --- |
| 公网 | https://flow.xmxcode.com；页面及入口资源均 HTTP 200 |
| 容器 | `toonflow-toonflow-1`，running / healthy，restartCount=0 |
| 镜像及 BUILD_ID | `toonflow:server-20261008-20` / `server-20261008-20` |
| 完整镜像 ID | `sha256:232811f1a0d679839c6704a4c704ff2d768bab4f87d52cee4dcb8eeb82d966aa` |
| 实际启动 | UTC 2026-10-08 18:58:03.136193184，即北京时间 2026-10-09 02:58:03 |
| 实际入口 | `bun build/server/index.js`；SHA256 `abb33ec243a163750ec625a8ec6a34675a72f28882c3d6b61f465dfc5079843a` |
| 数据及端口 | `/opt/toonflow/data → /app/data`；`127.0.0.1:3930 → 3000`；stopTimeout=60 秒 |
| 源码指纹 | 本机与容器 **42/42** 个关键文件一致；不是全仓所有文件比对 |
| 已安装插件 | tools / nodes / providers 合计 **21/21** 与相应 build 一致 |
| 网页入口 | `/assets/index-BPjVkrCs.js`，338508 字节；公网与容器 SHA256 同为 `9cb97224615a3c1589e7e85cdb1eae6e1f18b5e9eb81bbd6b34c50f4658a606b` |
| 服务就绪 | schedulerReady / creationReady / protectionReady / cleanupReady=true；recovering / stopping=false；归属、保护及释放表均为 ok |
| 运行状态 | paused=false；生成并发 2、下载并发 2、等待提醒 24 小时；blocked、pausedTracking、预约、准入中、在途请求均为 0 |
| 清理设置 | 文本、图片、视频、原始资料、缓存 **全部关闭**；天数为 2 / 2 / 2 / 30 / 2 |
| 文本配置 | `wb`，4 个模型；本次未修改 |
| 任务分母 | 13 批、43 条任务：36 cancelled、2 failed、5 succeeded；其中 2 条有 upstreamId；无活动任务，读取无错误 |
| 发布材料 | r20 备份目录存在；未演练恢复；未发现残留 repairValidation 隔离容器 |

本次 HTTP/MCP 实测：

- 登录 200，Cookie 含 HttpOnly / Secure / SameSite=Lax；未登录读设置 401。
- 正确网页请求头读取设置、清理状态均为 200；网页 Cookie 访问 MCP 为 401，MCP Token 读取网页设置为 401。
- MCP 使用实际 SDK 初始化并列出 **48 个工具，用时 1020ms**；查询一条已有成功视频任务 **365ms**，返回 succeeded、available，路径及 SHA256 正确。
- `getAppState` 返回 `connections=[]`、工作区根为 `/app/data/workspaces`。这仅是当时连接快照；本轮没有做真实网页画布操作，也没有验证后台标签页交错。
- 审计 MCP 会话已终止，网页审计登录已退出（200）。

以上短查询不等于大批受理、100 个订阅、几天等待或整条浏览器流程已重新验收。

两条原有成片完整保留：

| 相对工作区根的文件 | 字节数 | SHA256 |
| --- | ---: | --- |
| `studio1/assets/generated/video53ec9e26-0b22-40f5-97f3-617c1dd5c4e2.mp4` | 3107025 | `997b0f2592fbe8519cfe02249c14af6f176cc86eb01e784b271a2f949420d01e` |
| `myProject/assets/generated/video13587274-03a5-4843-a1ed-0a1540dce38c.mp4` | 2206448 | `531ddcb9763a8e2a636adc4d1a6943badaa782310ae4b1a8d471a9e87f64b31d` |

本轮实际执行 `bun run typecheck`：server 退出码 0，ffmpeg 退出码 0；web 退出码 1，唯一诊断仍为仓库根 `electrobun.config.ts(1,39)` 找不到 `./.hutch/devkit/api/config/ElectrobunConfig`（TS2307）。未重新 build；不能写成“全仓检查全绿”。

## 2. T01—T18 的当前判定

| 组 | 当前判定 | 本轮结论 |
| --- | --- | --- |
| T01 | 保留主缺陷源码已修 | unknown 普通重提仍被阻断，人工处理保留重复费用提示 |
| T02 | 本轮主缺陷源码已修 | 入口按剩余时间传入可兑现的媒体收尾预算；说明数字需对齐，见第 6 节 |
| T03 | 本轮主缺陷源码已修 | 统一创建门接入后台、旧同步、Agent/节点和供应商调试台；坏归属/非法时间进入未知故障 |
| T04 | 保留主缺陷源码已修 | 生成预约与容量去重未见直接回退 |
| T05 | 保留主缺陷源码已修 | 下载、保存及终态合并的暂停/取消复核未见直接回退 |
| T06 | 本轮主缺陷源码已修 | 无 pendingAssets 时补查询视频地址，也先保存 Retry-After 下限再处理 abort |
| T07 | 本轮主缺陷源码已修 | 已核验身份失配即 blocked，不再退回原 submissionIdentity 放行 |
| T08 | 保留主缺陷源码已修 | 实际文件 SHA 认回、已清理结果不复活未见直接回退 |
| T09 | 保留主缺陷源码已修 | 条件更新与旧格式 submitting 的保守处理未见直接回退 |
| T10 | 保留主缺陷源码已修 | 取消代次与前置失败撤销未见直接回退；动态证据仍有一处夸大判词 |
| T11 | 本轮主缺陷源码已修 | 查询绑定原路径；投递校验任务与路径；结果替换后重建观察；cancel 直查也校验 |
| T12 | 保留主缺陷源码已修 | 设置草稿与在途 GET 的版本保护未见直接回退 |
| T13 | 保留主缺陷源码已修 | 节点只等自身查询，单次短截止与后台聚合保持 |
| T14 | 本轮主缺陷源码已修 | 每次 hold 新 leaseId，身份与版本双匹配；确认续租前持久保护下限和版本代次 |
| T15 | **部分修复，仍剩两条** | 普通连续改名、锁内发现和补偿集合改善；精确恢复仍自阻断，持续写失败后缺少重启屏障 |
| T16 | 保留主缺陷源码已修 | 坏/缺保护表、marker 故障、祖先保护未见直接回退 |
| T17 | 保留主缺陷源码已修 | 预期内容指纹、路径锁及同代清围栏未见直接回退；成功认回正例仍缺动态记录 |
| T18 | 本轮主缺陷源码已修 | 超时后仍未确认子进程退出时保持名额，不 finish、不提前发终止事件 |

关键源码核对位置：

- T06/T07：[scheduler.ts](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1453) 的补查询错误处理，以及同文件 211—218 行的身份失配分支。
- T11：[useMediaTask.ts](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:1045) 的任务/路径校验、1158—1171 行的结果身份观察、1568/1614 行附近的 cancel 直查校验。
- T14：[workspaceFiles.ts](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/lib/workspaceFiles.ts:655) 的每 hold 身份；[editing.ts](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/editing.ts:117) 的确认前持久下限；旧释放表代次迁移、非法时间处理已联查。
- T18：[commandSlot.ts](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/commandSlot.ts) 的真实退出等待：15 秒后 SIGKILL，再等 5 秒仍未确认则保留占用。该分支可能持续等待，需要运行诊断，但已不是旧的“超时自动放槽”缺陷。

T03 的“已准入作业在 await 之后遇到全局暂停”属于既有准入/在途收尾边界；现有契约承认已准入预约，并未要求撤销全部已准入作业。本轮不据此重新打开“创建入口漏门”主缺陷，也不新增暂停语义。

## 3. T15 剩余两条：具体触发、影响和依据

### 3.1 P1：持续写盘失败后重启，未完成改名的保护可能丢失

**大白话：文件已经从 A 搬到 B，登记只写了一部分；如果随后补偿和故障记录都写不进去，当前进程会阻断，但重启后可能忘掉这件事。任务仍指向 A，B 在满足清理条件时可被删除。**

这条反例要求连续存储失败，不能写成一次普通改名失败必然丢数据。明确前提：健康的 succeeded 任务输出指向 A；归属结构及 task 引用合法；源为工作区普通文件；不存在其他编辑占用或独立保护。

正式可达过程：

1. [cleanup/index.ts:555](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:555) 执行真实 A→B；此前 Q/C 只有进程内协调，**没有先落盘的未完成迁移意图**。
2. 归属表发布为 B 后，父目录 fsync 报错；回写旧 records 也失败。最新 -20 已把“可能已发布”的写入纳入回滚，但回滚本身仍可能失败。
3. [fileRecords/index.ts:1676](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:1676) 的补偿失败；1695—1696 行设置 recordsFailure 后尝试落盘，仍失败。
4. C 保留真实文件 B，并尝试写 source/target 范围保护。若保护及其故障标记也写失败，[fileRecords/index.ts:1372](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:1372) 所在分支只能保留本进程的内存保护。
5. 此时重启，存储恢复可写。磁盘允许出现：合法 records=B、任务 outputs=A、真实 B 存在、旧合法保护表没有故障、重定位日志尚未写出。内存故障消失，没有持久意图供重启识别。
6. Q 不会兜底这组错位：[store.ts:369](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/store.ts:369) 只装载合法批次与索引；[scheduler.ts:1667](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1667) 恢复时跳过终态任务；[outputState.ts:65](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/outputState.ts:65) 无可靠迁移日志时只显示 missing，不建立保护。

清理影响也已追到正式删除调用：归属表按 B 分组；succeeded 且无 tracking/block 不算占用，引用检查不核对 task.outputs 是否包含 B；迁移保留原 updatedAt 并保存真实 B 的文件版本。因此，**若所有同路径归属的类别已开启、保留期均到期，B 未再改动且无其他保护/编辑占用**，候选判断及删除前复核均可通过，最终到达 [cleanup/index.ts:825](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:825) 的 unlink。不能仅把它描述为显示路径异常。

**当前线上五类清理均关闭，本轮没有发现线上误删，也没有在生产构造此故障。**上述结论是当前源码正式调用链的可达反例。

### 3.2 P2：源文件已反搬回来时，提示允许的精确重试仍被自己拦住

**大白话：系统让用户“按原来的 A→B 再试一次”来恢复，但另一层又把同一份故障记录当作占用，恢复无法继续。**

这条反例的关键是 **source A 仍存在**，不能笼统写成所有精确重试均失败。自然故障链：

1. A→B 的文件和归属迁移成功，随后任务 outputs 写入失败，内存仍指向 A。
2. [mediaTasks/index.ts:1377](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1377) 补偿成功反搬 B→A，但 1383—1395 行的 outputs 补偿再次失败。
3. 随后持久阻断写入恢复成功，保存当前 outputs=A 和 `relocationBlocked=A→B`。最终真实文件、归属、任务路径都可以在 A，阻断仍记录 A→B。
4. 用户即使通过已有入口核对并解除 C 的范围保护，Q 在 [index.ts:1320](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1320) 放行“精确同源同目标”，1501 行调用 C 时，旧 task block 仍存在。
5. C 的 [占用判断](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:190) 把这个 block 算 occupied，550—552 行返回 EOCCUPIED。
6. Q 只有等 C 成功后到 1533/1538 行才清 block，因而到不了解除步骤。

**边界保留：**源不存在且已有可靠迁移日志、目标身份匹配时，C 491—503 行有另一条“已移动”认回路径；本反例不否认那条路径可能成功。

## 4. 下一轮可开工方案：同一改名事务收尾

两条问题合并修复，不分别叠加补丁。继续遵守[原完整任务书](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/completeRepairExecutionPlan.md)、[执行契约 §K/§N.2](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/executionContract.md:504) 和仓库规范。

**先由主窗口 I 与 Q/C 固定以下接缝，再按文件所有权并行：**

| 所有者 | 本轮职责 | 文件边界 |
| --- | --- | --- |
| Q | 任务发现、固定任务锁序、事务身份传递、outputs 提交/补偿、精确恢复及启动时消费未完成事实 | `apps/server/src/utils/mediaTasks/` |
| C | 移动前持久意图、source/target 保护、归属/定位/释放时间迁移、路径锁、恢复核对与清理消费 | `apps/server/src/utils/fileRecords/`、`utils/cleanup/`；必要的正式路由由 I 协调归属 |
| I | 接缝冻结、集成、T02 说明对齐、证据更正、检查及既有授权内发布核验 | 契约/报告/发布材料；入口说明如需改动由 I 独占 |
| W | 无需重新重构；如接口返回变化，只做消费核对或只读互审 | 保留当前 T10/T11/T12/T13/T14 前端成果 |

各组共享仓库，禁止覆盖或回退别人修改。Q/C 接缝有依赖时先提供接口再接入，不为并行引入重复账本或锁倒序。

最小实现要求：

1. **移动前已有可恢复事实。**在现有固定锁序内，真实 rename 之前先可靠持久化带事务身份的意图，覆盖目录、source/target、关联记录/任务身份及足以核对同一迁移的版本依据。优先复用既有保护/重定位存储。持久化失败就不移动；进程内锁、失败后再尝试写 marker 不能替代此前置步骤。
2. **意图覆盖整个提交过程。**文件、归属、保护、释放时间、定位和受影响 task.outputs 全部提交完成，或完整补偿完成并确认落盘，才允许解除。不能在 C 搬完文件但 Q 尚未写完 outputs 时提前清掉；解除失败保持可诊断保护。
3. **重启消费同一事实。**有未完成意图时，即使任务已 succeeded、各 JSON 各自合法，也不能自动当健康迁移成功。源和目标继续受保护，清理、改名、输出改写使用同一事务事实；状态要能读到阻断原因和恢复路径。
4. **精确恢复真正可达。**同一事务在持锁核对实际文件、归属、任务输出与身份后，可以继续提交或完整回滚；仅对本次确认匹配的自身阻断作恢复许可。其他任务占用、编辑租约、祖先保护、其他事务保护仍有效。不能先无条件清 block，也不能只按两个路径相等就认回。
5. **旧路径复用仍须拒绝误认。**恢复遇到 A 已被新文件复用、关联身份/版本不符时继续保守拒绝；源不存在而目标确已是该事务落点的既有分支保留。不得用“文件存在”替代身份核验。
6. **保留本轮已有修复。**锁内发现 affected、fallback 路径锁内查 refs、“可能已发布”的补偿集合、-20 的六个单条归属助手回滚均保留。不要重做其他 17 组。
7. **状态文案必须真实。**区分“本进程已阻断”“已确认持久保护”“持久化失败，需恢复核对”。目前 cleanup 572/580/636 行附近直接宣称“已建立持久故障”的失败文案应随此链路纠正，不能在 marker 也失败时仍保证跨重启。

不新增事务框架、不引入新依赖；复用统一文件入口及原子写。仅在现有接口确实不能表达恢复时再考虑最小接口变化；路由变更仍必须一个接口一个文件，并运行既有 `bun run routes`，不手改生成 router。

## 5. 验收条件与执行边界

只使用隔离目录/隔离实例的非收费操作。可用现有接口、命令和人工操作，但**禁止新增任何测试文件、临时测试程序、mock 服务、自动检查入口或测试专用封装**。不能安全构造的故障直接记“未动态覆盖”，不得用顺序成功冒充竞态通过。

| 场景 | 必须核对的结果 |
| --- | --- |
| 普通 A→B、B→C | 文件、全部后代归属/释放时间、任务输出和定位一致；完成后无遗留意图 |
| 真正重叠的连续改名 | 明确记录两请求发生重叠及先后顺序；第二次不得绕过 outputs 未发布窗口；仅“立即再发”不算证明交错 |
| 意图写入失败 | 真实文件仍为 A，没有已开始的实际移动；错误可见 |
| records 替换已发布后 fsync 失败 | 本次报错项也纳入补偿；最终要么完整一致，要么留下此前已落盘的未完成保护 |
| 补偿、范围保护和故障标记继续写失败，随后重启 | 磁盘恢复可写后仍能读取先前意图；source/target 不误清、不允许普通改名绕过；真实位置与任务状态可诊断 |
| 本文 3.2 的“反搬成功、outputs 补偿失败” | 正式入口精确恢复能走完；状态全部核对成功后清对应 block/意图；不同目标仍拒绝 |
| 旧路径被新文件复用、事务身份不符 | 不能认走新文件，不能解除其他事务/编辑/范围保护 |
| 源已不在、目标有可靠原事务依据 | 原有成功认回能力不退回；不能仅凭目标存在放行 |

每步保留文件落点与 SHA/版本、归属路径与身份、task.outputs、保护/意图、readiness、HTTP 状态和实际命令退出码。反例 3.1 的删除风险验证若需要开启清理，只能针对隔离副本；两条线上成片和用户真实资料不可用作故障样本。

验证结论分为“源码已关闭”“独立互审无同类已知缺陷”“实际动态已覆盖”“未动态覆盖”。不能安全注入的 fsync 窄分支可明确缺证并提供逐阶段源码依据；不能因此声称完整故障实测，更不能把仍存在的已知源码缺陷写成已完成。

执行次序：

1. 冻结事务身份及先持久后移动的顺序；Q/C 分别实现，I 同时更正文档，互不改对方文件。
2. Q 审 C 的重启与清理消费；C 审 Q 的精确恢复、终态任务和 outputs 发布；I 追一次正式 rename 全调用链。
3. 按改动执行 server 类型检查、必要构建与实际接口验证；只有触及 ffmpeg/web 等才补对应检查。web 既有 Electrobun 声明错误独立记录，不用外层退出码覆盖真实结果。
4. 已知源码缺陷关闭后，在既有授权内完成发布。先重新检查线上活动任务与当前状态，沿用维护/备份/优雅收尾/回退流程；不能把本报告“当前无活动任务”当作未来事实。保留 wb 配置、两条成片和用户资料；五类清理维持关闭，维护暂停按原状态恢复；不动桌面及其他业务。
5. 核对完整 image ID、BUILD_ID、实际入口及网页指纹、关键源码、21 个插件、health、HTTP/MCP、任务分母及原成片指纹。报告写实际新版本，不预填未来时间，不需要用户逐项转述。

**新增真实生成请求预算仍为 0。**即使验证与视频业务相关，也不调用上游创建或内置 Agent 推理。隔离实例不能保留有效生成凭据再单靠 paused 防外发；如需运行会加载供应商的既有路径，先核对全部生成凭据移除和 IPv4/IPv6 出网边界。先决条件失败即停止该验证链。

## 6. 非阻断说明与证据更正：不另开产品缺陷组

### 6.1 T02 预算说明应与代码一致

当前 [index.ts:93](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/index.ts:93) 的清理外层上限是 `cleanupBudget + 1500ms`；清理内部先等编辑 finalize，不能只按参数 2 秒算。

以正式阶段上限核算：HTTP 约 27 秒、MCP 2 秒、清理最多约 3.5 秒，45 秒总预算下媒体约剩 12.5 秒。入口反算实际传入约 **abort 3.5 秒 + 最终写 8 秒 + 自然等待余量 1 秒**；原来的零/0.5 秒宽限主缺陷已关。

[契约 §N.4](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/executionContract.md:547) 要求实际传入预算可兑现，**没有规定 abort 硬性至少 5 秒**。因此不据此继续整组返工。I 把“清理≤2 秒”“媒体保底13秒/abort保底5秒”等注释、日志与报告改成目标值和实际缩减规则，或调整前段上限兑现原数字；不要新增硬性需求。

隔离 -19 的长作业停机记录给出了媒体 32100ms、abort 实等 103ms/可用 5000ms、最终写可用 12897ms、容器 stop 33.3 秒、退出 0。这是**执行者提供的动态摘录**；本轮未独立重启复跑。HTTP 真正耗满的变体两次未构造成功，仍未动态覆盖。

### 6.2 run3 的准确口径

材料集中在 [run3](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3)。保留历史记录，补可追溯更正，不删除不利记录。

- [commandResults.jsonl](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3/commandResults.jsonl) 当前 49 行，上轮 26 行，本轮追加 23 行。旧 HTTP 状态误作 exitCode 已更正；无法核准的旧时间已有 null/区间说明。
- **第 36、37、43—49 行仍含 `02:2x` / `03:0x` 等占位时间，共 9 行。**文件最后修改为北京时间 02:59，末行却写 03:5x，不能直接当准确原始时间台账。用实际 Docker/日志/命令来源校准；无法还原则标 null/未知与可证明时间区间，不猜数字。本条是证据准确性问题，不推断造假。
- 全仓 typecheck 的第 12、46 行外层 exitCode=0，但正文承认 desktop/web 失败。应记录子命令真实退出码，区分已知环境问题，不能称“32 包全通过”。
- [validationResults.jsonl](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3/validationResults.jsonl) 仍 14 行，含历史记录、更正、互审和事件，**不是 14 个独立场景全动态通过**。
- [fifthRound_verification.json](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3/fifthRound_verification.json) 的 T15“A→B 立即 B→C”只证明顺序连续改名；锁内 affected 窗口关闭来自源码核对，不能将两者混写为竞争窗口动态通过。-18 的持久 block 样本只验证不同目标被拒绝，未验证本文精确恢复成功。-20 六个单条写入助手只做了源码和类型检查。
- [t10_dynamic_evidence.json:41](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3/t10_dynamic_evidence.json:41) 已补“未走网页确认重提、未投递真正旧 A 响应”的解释，却仍保留“通过（等价的动态证据 + 说明）”。改为“部分子场景通过，完整交错未动态覆盖”，不要重开 T10 源码组。
- T14 已有双匹配、缺版本拒绝、版本递增和旧格式迁移记录；完整过期 ABA、异常退出后的保留期重算未动态覆盖。T11 为源码/互审，未跑真实浏览器交错；T17 成功认回正例、真实 429、100 订阅、桌面及跨天等待仍未补测。
- T18“退出仍未确认”分支仅完成源码核对；已有并发及排队取消记录属于其他分支回归，不能替代该分支的动态验证。
- 本轮只确认服务器保留 `build19.log`、`build20.log` 和 r19/r20 源码包，未读取两份完整构建日志，也未重新构建镜像。

### 6.3 误生成与外发说明继续分清来源

历史误生成 `video_6081f73981` 在**第五轮**独立只读 GET 中已确认 completed、有结果；本轮看到执行者已更正[事件台账](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3/incident_unintended_upstream.json)，没有再次查该上游 ID。金额/退款仍未核实，不能改写为成功取消或整个返工零费用。

最新执行记录另承认：最初只封 IPv4，一次携假 Key 的请求到达真实供应商并返回 401，随后补双栈封堵。这是执行者自报，本轮未独立复核其原始请求；不能宣称全部验证外部零流量，也没有本轮新增收费任务的独立证据。

本次独立审计自身新增生成 0 已确定；执行窗口本次新增生成 0 为其记录口径，和历史误生成分别记账。

## 7. 可直接复制给执行窗口

> 继续 Toonflow 剩余返工。完整读取 E:\Ai\codex3\Toonflow\Toonflow-app-master\docs\sixthIndependentAcceptance.md，并遵守 completeRepairExecutionPlan.md 与 executionContract.md。当前 18 组中 17 组主缺陷源码已修，本轮只收尾 T15：移动前持久迁移意图以覆盖连续写盘失败后重启；源已反搬回 A 时，同一事务的 A→B 精确恢复须真正可达且不绕过其他保护。主窗口 I 先与 Q/C 冻结事务身份、锁序、持久化和解除时点，Q/C 按本文文件所有权并行，互审后完成非收费验证及既有授权内的发布核验；W 保留成果，无需重构。同步处理第 6 节的 T02 预算说明、run3 时间/退出码/T10/T15 证据措辞，明确源码与动态范围，不让我逐项传话。新增真实生成请求为 0，不调用内置 Agent 推理，不新增测试文件、临时测试程序、mock 服务或自动检查入口；先决条件失败立即停止该验证链。凭据仍从 E:\Ai\codex3\Toonflow\toonflowHandoff\deploymentSecrets.json 读取，仅用于已授权用途，不复制到日志或公开文档。保留 wb 配置、原成片、用户资料和其他 17 组成果；五类清理保持关闭，不动桌面与其他业务。一次性交付真实版本、具体文件行号、检查结果、未测项和完整证据；已知源码缺陷未关闭不得称全部完成。
