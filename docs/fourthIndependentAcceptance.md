# Toonflow 第四轮独立验收与剩余返工清单

审计日期：2026-10-08（北京时间）；现场核查时间约 22:08—22:23。对象：执行窗口第四轮及收口发布 server-20261008-14。

**结论：本轮仍不通过完整验收。-14 已真实上线，基础访问、认证隔离和现有任务查询正常；18 个原问题组中，5 组主缺陷已从当前源码关闭，另外 13 组仍有明确的剩余问题。这里的“组”是原任务分组，不是线上发生故障的次数；源码关闭也不等于所有交错场景已经动态验收。**

本轮进展应保留：生成额度预约、任务台账恢复门、下载返回后的暂停检查、真实 SHA 认回、同步和异步共用参考快照、未知任务重提拦截、节点查询短截止、编辑入口接线、正常改名事务、双 concat 避免重复拿槽，均有实际代码改动。不要回退或重做这些正确部分。

本报告只做独立验收和返工交接。未改产品源码、部署、重启、真实设置、用户画布，未开启清理，未发起新增收费生成，也未新增测试文件或临时测试程序。

- 原完整任务书：[completeRepairExecutionPlan.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/completeRepairExecutionPlan.md)。
- 上轮问题基线：[thirdIndependentAcceptance.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/thirdIndependentAcceptance.md)。
- 本轮执行者自报：[executionAcceptance.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/executionAcceptance.md)、[callChainCrossReview.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/callChainCrossReview.md)。
- 本轮独立现场证据：[auditSnapshot.json](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/fourthIndependentAudit20261008/auditSnapshot.json)。

## 1. 已独立核实的现场

| 项目 | 实际结果 |
| --- | --- |
| 公网 | https://flow.xmxcode.com；MCP 为 /mcp |
| 容器 | toonflow-toonflow-1，running / healthy，restartCount=0 |
| 镜像 | toonflow:server-20261008-14 |
| 完整 image ID | sha256:b0653d6819e3f916cb85c866c2268418af2890e068d46d901f8fc575572e1c42 |
| BUILD_ID | server-20261008-14 |
| 当前启动时间 | 2026-10-08T13:53:38.250378319Z，即北京时间 21:53:38 |
| 数据 / 端口 / 停机宽限 | /opt/toonflow/data → /app/data；127.0.0.1:3930 → 3000；60 秒 |
| health | schedulerReady=true，recovering=false，stopping=false；blocked、pausedTracking、generationReservations、generationAdmitted、inflightRequests 均为 0 |
| 运行设置 | paused=false，生成/下载并发 2/2，等待提醒 24 小时 |
| 五类清理 | text/image/video/original/cache 全关闭，天数 2/2/2/30/2 |
| 文本供应商 | wb，4 个模型；未用旧交接配置覆盖 |
| 任务总量 | 13 批、43 条：36 cancelled、2 failed、5 succeeded；2 条有 upstreamId，无活动任务；任务 JSON 读取未报错 |
| 身份比对 | 抽核 31 个本机源码文件与运行容器内源码，SHA256 全相同；安装 tools 8、nodes 8、providers 5，共 21 文件与容器 build 全相同 |
| 原有成片 | 两条均存在，字节数和 SHA256 与上轮一致，详见下表 |
| 隔离实例 | docker ps -a 未见残留 Toonflow 隔离验证容器 |
| 备份 | /opt/toonflow/backup/repairExecution20261008-r14 存在；本轮未演练恢复 |

| 原有视频 | 大小 | SHA256 |
| --- | --- | --- |
| studio1/assets/generated/video53ec9e26-0b22-40f5-97f3-617c1dd5c4e2.mp4 | 3,107,025 字节 | 997b0f2592fbe8519cfe02249c14af6f176cc86eb01e784b271a2f949420d01e |
| myProject/assets/generated/video13587274-03a5-4843-a1ed-0a1540dce38c.mp4 | 2,206,448 字节 | 531ddcb9763a8e2a636adc4d1a6943badaa782310ae4b1a8d471a9e87f64b31d |

实际 HTTP/MCP 检查：

- 公网登录 200，Cookie 带 HttpOnly、Secure、SameSite=Lax。
- 未登录读设置 401；用网页 Cookie 访问 MCP 401；用 MCP Token 读网页设置 401。
- 按真实协议带 Origin、x-toonflow-workspace 读取设置 200；revision 在 x-toonflow-settings-revision 响应头，已实际读到。最初探针只看 JSON 字段，已纠正取值位置，不把它当产品故障。
- 清理状态接口 200。
- 用项目实际 @modelcontextprotocol/client 经 Bun 连接公网：初始化加 tools/list 约 1,939ms，共 48 个工具。按正确 taskIds 查询原视频任务成功，核实 succeeded、输出 state=available、路径和 SHA256；第二次核对摘要约 1,235ms。本轮没有调用生成工具。
- getAppState 当时 connections=[]。这不证明画布故障，也不算已验证新版画布控制。
- 原用户标签页仍加载 index-DGvzOLuV.js，显示 studio1 三节点；新开的临时页加载 index-CXPmEegm.js，显示管理员登录。本轮未强刷原页、未在新页登录并改画布；临时页已关闭，MCP 审计会话已结束。

实际本机检查：apps/server 的 bun run typecheck 通过；packages/ffmpeg 的 tsc 通过；apps/web 的 bun run typecheck 失败，唯一诊断仍是 electrobun.config.ts 缺少 .hutch/devkit/api/config/ElectrobunConfig。此项属于已有桌面开发依赖缺失，不能写成前端检查全绿。本轮未重建构建产物。

## 2. T01—T18 当前状态

| 原编号 | 本轮判断 | 已成立的修复与剩余范围 |
| --- | --- | --- |
| T01 | 主缺陷源码已修 | 所有 unknown 都待核实；普通生成拦截，原绑定只查询，人工解除有重复生成提示 |
| T02 | 部分修复 | 全局预算、在途受理、双信号已有；长作业耗尽等待后没有真正的 abort 收尾宽限 |
| T03 | 部分修复 | 任务表恢复/告警门已接；fileRecords/保护健康尚未进入新生成准入 |
| T04 | 主缺陷源码已修 | 慢落盘前的 generate job 已计容量预约，与公开在途去重 |
| T05 | 主缺陷源码已修 | 下载响应、保存、成功合并重查暂停/取消；暂停的网络占槽问题归 T06 |
| T06 | 部分修复 | 前四次 sleep 占槽已删除；暂停后迟到的新 Retry-After 会丢失，暂停下载仍占网络作业 |
| T07 | 部分修复 | 正常兼容与 ID 回显核对已有；核验依据免检范围、账户归属锁和 rematch 版本仍有洞 |
| T08 | 主缺陷源码已修 | 已有输出也读取实际文件核 SHA；路径复用串线归 T15 |
| T09 | 部分修复 | 同步/异步输入快照与实际 SHA 已接；提交许可判错、旧记录缺字段误判未提交 |
| T10 | 部分修复 | 提交前 try 与摘要三态已有；迟到取消响应会清新绑定、POST 前失败仍可能留幽灵绑定 |
| T11 | 部分修复 | 活动任务 state/resolvedPath/等待原因已有；全局素材目录、保存后观察、旧路径播放未闭合 |
| T12 | 部分修复 | 重载单飞和保存队列已有；GET 在途时用户新输入仍会被覆盖 |
| T13 | 主缺陷源码已修 | 单节点等自身结果，连目录准备在内有 5 秒短截止；更宽动态样本仍有限 |
| T14 | 部分修复 | 多编辑入口、版本、路径锁和释放时间已有；页面身份、关闭重开、重启/坏表仍丢保护 |
| T15 | 部分修复 | 正式 rename 入口与正常迁移已有；历史路径串线、部分失败回滚、释放时间迁移不完整 |
| T16 | 部分修复 | 正常坏表故障持久化与清理祖先保护已有；缺表、通过改名移出保护仍有洞 |
| T17 | 部分修复 | live guard、路径锁与代次已修；覆盖写重启时仍把旧文件存在当作新写入完成 |
| T18 | 部分修复 | 原双 concat 死锁、clone/别名/查询覆盖已改善；错误早于进程退出释放、静态排队取消不回调 |

以下 13 组剩余问题全部是当前源码可达反例。没有在正式数据上制造取消竞态、坏表、错误改名、长作业停机或清理误删。优先处理 T09、T07、T10，再并行处理其他组；不要把“没有在线制造故障”当作不存在代码缺陷。

## 3. 剩余问题、修复边界与验收条件

### T09 / P1：提交许可与旧记录兼容仍可能造成重复上游请求

依据：[markSubmissionAttempt](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:861)、[条件更新的返回语义](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/store.ts:648)、[供应商提交](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:902)、[旧记录恢复](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1505)。

1. markSubmissionAttempt 只判断 updateMediaTask 返回的对象存在；条件不成立时公共更新函数仍返回原 task。取消正在落盘、提交门先看到尚未发布的旧状态并排在其后时，锁内更新会因 cancellationRequested=true 被拒绝，却仍因返回对象为真而继续调用上游。普通 submitting 取消只记意图、未确认上游取消时不会 abort，因此这条交错可达。
2. 新恢复逻辑把缺 submissionAttemptedAt 的 submitting 无 ID 记录直接当作“确定未提交”并转 failed。旧版本所有这类记录天然缺字段，可能实际上已经向上游发过请求。第 1 个缺陷还可能在新记录里制造“已发网络但没有该字段”的状态。

修复要求：提交许可必须由本次条件更新真正生效、且最新持久状态允许提交来证明，不能把返回旧对象当许可。为旧记录保留保守 unknown 语义；只有新格式明确记录的未尝试事实，才允许判确定未提交。不要为修这一处全局改变 updateMediaTask 的返回约定。同步/异步快照与 SHA 修复继续保留。

验收：证明“cancel 先可靠落盘、提交许可后执行”时新增上游创建为零；证明旧格式 submitting 无 ID 经过升级恢复仍 unknown、保留键/输入/额度且不会自动重提。正常新格式的准备失败仍应能明确报提交前失败。本轮现场无活动任务，不能据此声称这 43 条现存终态任务已被误处理。

### T07 / P1：恢复核验依据仅凭 ID 复用，未绑定核验当时的查询身份

依据：[兼容提前放行](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:187)、[恢复记录字段](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/store.ts:54)、[归属锁与 owner](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:793)、[rematch](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:938)。

- verifiedRecovery.upstreamId 相同就直接兼容；记录没有核验时完整 queryIdentity。因此 bind/rematch 一次后，再改 Key、API 地址或供应商代码版本，仍可盲续查。
- 绑定锁和归属查找用历史 providerCredentialRef。历史 Key A/B 的两条任务如今都用当前 Key C 核验同一个 ID，会进入不同归属空间；顺序操作也能双重绑定。
- rematch 在 await 上游核验之后才读取 task.stateVersion；核验期间发生的 pause 会被吸收到这个新版本，后续比较通过，再写回 active。初次 bind 已在核验前取版本，这部分不要撤回。

修复要求：持久核验当时的 providerId、modelId、规范 API 基址、revision、credentialRef；当前身份仍一致才复用核验结果。归属唯一性按此次实际查询账户/命名空间划定，在共同锁内重查；核验前固定任务版本和完整查询身份，写入前再次比较。保留原始提交身份，不保存原始 Key。

验收：核验后分别变更 Key/地址/revision，不得继续免检；两个旧账户任务切到同一当前账户绑定同一 ID，第二次必须被拒绝；rematch 在途发生 pause，不得被迟到核验取消暂停。

这里必须同时修订 [executionContract.md 的 v4 规则](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/executionContract.md:459)：它自身写了“只要 verifiedRecovery 的 ID 匹配就直接续查”，削弱了原任务书的身份变化核验要求。这不是单纯“没按 v4 实现”。上游未回显 account/model 继续如实标不可验证，不把缺字段本身另算一个已证实账户漏洞。

### T10 / P1、P2：旧取消响应清掉新任务；确定未发 POST 的失败仍留绑定

依据：[取消流程](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:986)、[applyTask 清绑定](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:800)、[网页重提入口](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodes/videoGenerationNode/src/index.vue:405)、[提交准备](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:826)。

- cancel 捕获旧任务 A，POST 返回后先把 UI 设为 cancelled，再 await 完整摘要。此时网页允许确认“上一次已结束”并提交 B。A 摘要迟到后没有原绑定/代次检查，applyTask(cancelled) 清掉的是当前 B 的绑定和观察。
- currentDirectory(true) 在生成 POST 前发目录查询。该 GET 断网/401/目录错误时没有 preSubmit 标记，catch 仍转 unknown 并保留键；以后 start 只查询，查不到根本没提交过的任务。

修复要求：取消/查询固定目录、taskId、绑定及操作代次，每次 await 后核对；旧 A 不得更新 B，也不得更新已卸载实例。用明确的“生成 POST 是否已发起”事实区分准备失败与真正提交不明，不依赖某些异常才有的 preSubmit 属性。

验收：取消 A→摘要慢→提交 B→A 迟到，B 的键、绑定、观察和服务端任务都保留。目录 GET 失败时生成 POST 计数为零；恢复网络后能正常提交一次；POST 已发出的不明结果继续原键恢复查询。

### T02 / P1：长作业耗尽等待截止后，abort 宽限实际为零

依据：[媒体阶段截止](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1722)、[先等满再 abort](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1734)、[排空后退出](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/index.ts:81)。

媒体阶段实际截止为 min(全局截止, 进入本阶段后默认 30 秒)。先自然等待到此截止，再 abort，然后用同一个已经到期的 deadline 限制 abortGrace；最终写队列也使用过期截止。因此可能全局 45 秒还剩约 15 秒，媒体阶段已经不再等待关键收尾并返回退出。

修复要求：同一总预算内先预留 abort 与最终持久写时间，再计算自然等待截止；不要把已经耗尽的截止再当作宽限。保持单一预算、新受理门、双信号幂等和在途计数等正确实现。

验收：长作业占用跨过自然等待截止时，日志证明 abort 后实际获得收尾时间，关键状态写入可完成，最终不超过全局预算。未完成必须如实报告。已有 1.7—5.1 秒停机样本和 -14 空闲 exit=0 不能证明此边界关闭。

### T03 / P1：保护表故障未进入新生成准入

依据：[唯一派发判据](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:771)、[两个并行初始化](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/app.ts:153)、[保护故障](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:345)、[原任务书要求](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/completeRepairExecutionPlan.md:177)。

判据目前只看任务表；isCleanupReady 没有接入生成准入。纯文本无参考时，受理快照和执行输入都为空循环，上游调用前也没有另一个文件保护步骤替它阻断。因此保护表损坏、任务表正常时，清理会暂停，而新视频仍可提交上游。

修复要求：Q/C 共用可诊断的保护恢复状态，接入所有新生成入口的唯一判据；保护未知时可按原契约接收入队，不派新收费创建。已有任务跟进和保护保全按原方案处理，不用另加互相等待的锁。

验收：隔离数据的保护状态不健康时，health 明确反映原因，所有触发路径均不发新上游请求；完成明确恢复后才放行。原任务表 2 秒抢跑和装载 warnings 问题已经修好，不再重复作为未实现项。

### T06 / P2：暂停后迟到的新 Retry-After 被丢弃，下载网络作业仍占槽

依据：[重试记录条件](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1214)、[下载错误取下限](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1316)、[pause 入口](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:856)。

下载在途→用户暂停→迟到响应返回 429/Retry-After 时，scheduleDownloadRetry 因 trackingStatus 已非 active 而不保存新下限。随后 resume 没有这个下限可保留，可能提前请求。这与已有 retryAt 跨重启保存、普通迟到查询更新不是同一场景。

pause 也不中止正在进行的网络下载；两条在途下载都暂停后，两个下载槽仍占到响应或本次尝试超时，当前尝试上限 15 分钟。旧的小时级作业内 sleep 已删除，不再沿用该旧描述。

修复要求：上游退避事实与用户暂停意图分开合并，保存更晚 retryAt，同时保留 paused/原因；可中断下载在真实网络收尾后归还槽，不丢已可靠取得的 ID 或结果。

验收：暂停后取得的新 Retry-After 在 resume、重启后仍生效；暂停中的两条下载不长期阻塞其他可执行下载。真实上游错误无法安全制造时说明验证范围，不新增收费请求或伪造正式任务。

### T11 / P2：素材库根目录接错；保存后状态与播放路径未接完

依据：[素材库可用性查询](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/pages/workspace/panels/canvas/components/assetLibrary.vue:149)、[项目目录传入](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/pages/workspace/panels/canvas/index.vue:64)、[全局素材根目录](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/assets/index.ts:5)、[保存后查询](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:661)、[节点播放器](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodes/videoGenerationNode/src/index.vue:267)。

1. 素材库列表/读取来自 data/assets，但新增可用性查询把相对路径放进 project.directory。只在全局库存在的正常素材会被误判 missing，预览被关或播放被停。本轮线上 data/assets 不存在，未在正式资料上触发；这是已接错的源码路径。
2. ACK 后清活动绑定、停观察；refreshSavedAvailability 唯一业务调用在节点挂载，无绑定时 refresh 直接返回。同一页面随后发生清理/改名，显示不继续更新。
3. 重挂载查到 resolvedPath 后只更新 hook.resultPath，available 分支播放器仍用画布旧 outputFile.url，可能继续请求旧地址。

修复要求：可用性与实际读取使用同一资产根和身份；已保存输出保留轻量有效的刷新入口；恢复后的当前路径统一供播放、下载和保存使用。不得通过每节点新增高频独立轮询破坏已有聚合。

验收：全局独有素材正常预览；任务保存 ACK 后保持同页，文件变化能够更新显示；P 改到 Q 后重开旧画布实际请求 Q，后续保存不写回 P。当前活动任务的统一字段消费已修，不重做。

### T12 / P2：重载 GET 等待期间的新输入仍被覆盖

依据：[reloadSettings](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/stores/settings.ts:144)、[普通 UI 更新](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/stores/settings.ts:69)、[自动保存监听](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/stores/settings.ts:234)。

settingsVersion 只在发布等路径变化，不随普通 UI 编辑变化。GET 在途时界面仍可编辑；新保存排在 reload 后，迟到 GET 先覆盖 settings，后面的保存再读取被覆盖的数据，新输入便丢失。单飞和旧保存队列等待解决了上一种竞争，没解决这一种。

修复要求：使用确实随草稿修改变化的版本保护，或重载期间明确禁止编辑等最小方案；成功/失败后的编辑状态恢复完整。

验收：GET 慢→用户新输入→GET 返回→保存执行，新输入不能静默丢失。已有离线失败保留→在线重载→保存成功证据继续有效，但不覆盖此交错。

### T14 / P1：页面身份与租约生命周期仍有空窗

依据：[pageId 生成](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/lib/workspaceFiles.ts:60)、[首次登记与关闭](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/lib/workspaceFiles.ts:383)、[释放版本可省略](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/routes/cleanup/editing/release.ts:24)、[后端释放](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/editing.ts:173)、[停止清内存](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/editing.ts:226)、[释放表装载](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:381)。

- sessionStorage 的 pageId 在复制标签、部分带 opener 的同源新页面中会被复制；后端相同 loginDigest/pageId/path 合并一条租约，最后续租的页面关闭仍能解除另一个页面的保护。
- 首次 create 响应未回就关闭时，会发不带 versions 的 DELETE。立刻重开后，新 create 先到、旧 DELETE 后到，后端无版本释放会删掉新租约；迟到 create 响应也没有旧/新 hold 代次区分。
- 活动租约只在内存，正常停止 dispose 直接清空，也不等待 releaseFlush。正在编辑的旧文件重启、页面未及时重连时，没有本次解除时点可供重新计完整保留期。
- editingReleases 表损坏时置空后继续清理，可能缩短本应保留的时间；不能用注释说明这种取舍就视为安全完成。

修复要求：区分真实页面实例和同页每次租约实例，旧响应/释放不得影响后建立的租约；复制标签身份需要碰撞处理或重新分配。活动保护在退出/重启中应有保守可恢复的解除依据，释放写入纳入收尾；坏表不能仅记录告警并置空后照常删除。

验收：真实复制标签、create/DELETE 请求重排、快速关闭重开、编辑中重启及释放表故障均按隔离数据验证，保护与保留期不出现空窗。v4 对 pageId 固定存 sessionStorage 的设计也要同步修正；现有手工指定 p1/p2 的 API 实测只证明身份本来不同的情况。文本、图片、画布文本、待回写入口本轮已接好。

### T15 / P1：历史路径复用串文件、部分失败回滚不全、编辑释放时间未迁移

依据：[任务迁移选择与重写](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1217)、[多任务写回与回滚](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1235)、[归属迁移](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:940)、[普通存在性优先返回](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/outputState.ts:35)、[释放时间](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:1201)、[清理期限计算](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:224)。

- 旧任务 a→b 后保存 path=a、resolvedPath=b。复用 a 创建新文件，再 a→c，选择/重写逻辑仍匹配历史 path=a，把旧任务 resolvedPath 改为 c。C 的源存在分支没有核对 expectRefs。另，b 缺失、a 被新文件复用时，摘要先按 stat(a) 返回 available，尚未进入带 refs 的日志解析，也能串错文件。
- 多任务 A.outputs 写成功、B 写失败时，仅反向移目录和 C 账本，不恢复已写过的 A.outputs；反向移动再失败时只有“已保持阻断”文案，没有相应持久阻断。归属迁移逐条 inspectPath/unindex/index 还在 try 外，后续 I/O 抛错可能留下半迁移内存。
- editingReleases 按路径单独保存，却没加入 rename 迁移。已到期文件今天编辑后关闭，本来重新获得完整保留期；普通改名后新路径读不到释放时间，又按旧 updatedAt 清理。无需并发或磁盘故障即可触发。

修复要求：历史 path 只作历史，当前定位和可靠归属共同决定影响范围；回退兼容不能认走复用路径的新文件。任务 outputs、归属、保护、定位日志、编辑解除时间纳入完整操作/补偿范围，覆盖准备和每次持久写；无法回滚必须真的建立可恢复的持久阻断。

验收：a→b、复用 a、a→c 后旧任务仍指 b；b 缺失时不把新 a 当旧输出。多任务中途失败后所有任务与文件一致或明确持久阻断。编辑关闭后改名不缩短保留期。正式 HTTP/assets/Agent/MCP rename 已接入，原重复锁与源后代快照遗漏不再作为未修项。

### T16 / P1：缺保护表视为健康空表；受保护后代可改名移出范围

依据：[保护表缺失分支](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:330)、[改名前保护检查](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:467)、[只查源及后代](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:823)。

已有安装 protections.json 缺失时直接按空表返回；坏表先移走、持久故障标记写失败后再重启，也可能走入此分支。首次空安装与既有保护丢失尚未区分。

清理本身已检查祖先保护，但改名前只查源及后代。目录 a 被范围保护时，a/f→b/f 可以通过普通 rename 移出范围，保护还留在 a，b/f 此后不再受限。

修复要求：识别初始空表与已有保护状态未知；故障恢复应跨重启保持保守。正常移动要检查两端相关祖先保护，不能通过移动绕过核对，也不要禁止全部正常改名。

验收：保护表缺失/标记持久化失败后重启保持受阻；受保护目录内子文件改到外部被正确拒绝或在同一事务继承保护。POST /api/cleanup/protections 的认证和非空核对原因已接入；现有 200 no-op 仅证明入口可用，不证明有故障时恢复正确，更不代表该入口有鉴权漏洞。

### T17 / P2：覆盖写恢复仍把旧文件存在当作本次写入完成

依据：[恢复登记](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:772)、[声明归属的覆盖写](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/routes/workspaces/files/write.ts:55)。

原路径已有旧文件，begin 保护成功后、实际覆盖写发生前退出；恢复只核文件存在且 size>=0，就按 pending 的新来源/类型登记并解除保护。它不知道本次新内容是否真正发布。

修复要求：记录足够的预写版本、目标内容身份或发布事实，恢复时能区分旧内容与本次已完成内容；不确定就保留待核对。live guard、路径锁和代次检查已经修好，继续保留。

验收：区分新建文件不存在、覆盖前已有旧文件、新内容已原子发布但登记未完三类。不能仅拿“文件不存在时不恢复”的样本覆盖全部写入场景。

### T18 / P1、P2：错误先于真实退出释放；静态查询排队取消不回调

依据：[命令 error 释放](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/commandSlot.ts:87)、[外层完成与释放](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/remote.ts:64)、[静态排队](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/commandSlot.ts:173)、[队列取消](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/slot.ts:31)。

已安装依赖 @renmu/fluent-ffmpeg 2.3.3 的 [processor.js](E:/Ai/codex3/Toonflow/Toonflow-app-master/node_modules/.bun/@renmu+fluent-ffmpeg@2.3.3/node_modules/@renmu/fluent-ffmpeg/lib/processor.js:450) 在输入流错误、超时、输出流错误分支均先 emitEnd(error)，后 kill（450—454、466—471、488—499）。当前原生包装和外层 HTTP 包装在 error 即完成/释放，没有补等 exit/close。可能提前放行下一作业，并让调用方误以为可以清理输出；本轮没有动态制造进程重叠。

静态 ffprobe/能力查询容量满时 queueFfmpegSlot 没传 onCancel。取消只移除 waiter，原函数尚未执行，外部 callback 永远没有完成来源，调用方可能一直等待。

修复要求：按真实子进程生命周期收敛释放；准备阶段无进程的错误能正常结束，运行阶段的业务 error 不能替代真实退出。静态排队取消也要让调用方可靠收敛且只回调一次。

验收：进程发生 timeout/流错误时，实际退出前不释放名额、不宣告输出可安全清理；满槽排队的静态查询取消后 callback 恰好完成一次且未启动进程。原双 concat 自我死锁确已修，本轮的三路 concat 成功证据不能扩写成所有释放/取消分支都已通过。

## 4. 执行证据这轮补了什么，仍缺什么

证据目录：[run2](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run2)。

- submissionLedger 现在确有 12 行，每行都有 HTTP 与耗时；11 次 HTTP 200、1 次越界 403，耗时 1,309—1,908ms。项目级结果累计 accepted 10、existing 7、rejected 3；403 行无 items。请求数、任务项数、上游收费创建次数必须分开。第 7 行“已有+新增”实际用了新 batchKey、两项都是 accepted，不能据标签声称验证了同批 existing+accepted 混合。
- validationResults 有 27 行，含同编号后续补录，不能叫 27 个独立场景全部动态通过。后续 V18 记录已补 409→离线 GET 失败→在线 GET 200→保存 200，不能继续沿用早期“没跑通”的旧摘要。
- V15 新证据支持 A 保存 200、B 同 revision 保存 409 和原始 ESTALE；但全套“两次冲突、完整重载、再冲突”的连续请求时间线仍不完整。不要把反复看到横幅当作每个重载步骤已成功。
- V19 是一个目录、一个订阅、一个 taskId，约 15 秒内 submit 一次、get 五次。它证明活动订阅发生了查询，不证明多 ID 去重/分片或慢请求 5 秒上限。按用户约定用 10—20 次非收费提交/适量订阅补必要覆盖即可，100 不是产品上限，也不要求制造 100 次收费视频。
- V20 的 hidden write/read/write 与 getCanvasNodes 目前主要是执行文档叙述和截图；run2 没有对应原始 MCP JSON 时间线。workspaceFiles 的 write/read 可由服务端直接执行，本身不能替代画布控制桥的写操作证明；已有 getCanvasNodes 叙述也不能推出画布修改已实测。独立审计这轮只核了公开任务工具，未补新版 hidden 画布写入。
- T02 的在途 50 项与重复信号样本、-14 空闲停机样本有保留价值，但都不覆盖耗尽自然等待后 abort 的边界。
- T18 三路真实 concat、clone 和普通取消有记录；新增能力查询、静态排队取消、error 早于 exit 的分支未由这些记录证明。
- commandResults 10 行时间均含 18:0x/19:4x 等占位，部分命令用省略号、占位容器名、摘要输出，仍不是可复核的原始命令台账。其中两行明确记录 /tmp/nativeCheck.mjs、/tmp/cancelCheck.mjs；不能一面写“无临时验证程序/全部内联”，一面交这类记录。以后遵守禁止测试文件和临时测试程序的要求，不再创建同类文件；本审计没有创建。
- executionManifest/artifactHashes 主要是 -13；release-14.json 补了 -14 完整镜像身份。本次独立证据另补当前完整身份、31 源码指纹、21 插件指纹和保留数据，历史与当前不可混写。
- 自然跨天等待、真实上游错误、不可安全构造的磁盘/竞态场景可以明确写源码核对或未验证。未动态测试本身不是每项的代码缺陷；第 3 节列的是另外确有可达路径的问题。

## 5. 一次性继续执行安排

继续“主窗口 I + Q/W/C 三个子 AI”，不需要用户逐项传话。先统一交界，再按文件所有权并行；已完成的成果与用户数据继续保留。

| 所有者 | 本次责任与独占边界 |
| --- | --- |
| Q 后台任务 | T02 媒体收尾、T03 生成门、T06/T07/T09、T15 任务归属和多任务补偿；apps/server/src/utils/mediaTasks/ |
| W 网页节点 | T10/T11/T12、T14 页面/租约实例与观察；nodeScaffold、videoGenerationNode、web 设置/文件/素材相关入口 |
| C 归属清理 | T03 提供真实保护就绪、T14 后端生命周期、T15 文件事务与释放时间、T16/T17；fileRecords/cleanup/对应路由 |
| I 主控集成 | 修正交界契约、T02 全局生命周期、T18 FFmpeg、共享出口/路由生成、非收费验证、发布与完整证据 |

必须先对齐四件事：

1. Q/C：保护就绪快照、当前路径与历史路径定义、任务/文件/释放时间的一致补偿和锁顺序。
2. Q/W：真正的提交尝试事实、旧格式 unknown、取消迟到结果的任务和操作代次。
3. W/C：document 实例、每次 hold 实例、版本/释放的协议；不能以 sessionStorage 一定独立或无版本 DELETE 为默认安全前提。
4. Q/I：核验依据必须约束当前 queryIdentity；v4 免检规则同步修订。执行窗口自行写的契约不能削弱原任务目标后据此宣布完成。

验证与交付：

- 按第 3 节逐项沿正式入口核对，已修与未实测分开，不只修改报告，不用新函数定义代替调用接线。
- 新增收费生成仍为 0；不调用内置 Agent 产生模型费用，不修改生产状态制造错误，不新增任何测试文件、临时测试程序、mock 服务或自动检查入口。
- 在现有隔离数据与已有产品能力上完成可安全进行的必要验证。10—20 次提交是验证规模，不是用户业务总任务上限。无法安全触发的窄竞态，给出完整源码推导和限制。
- 类型检查、按改动的构建与路由生成保留真实命令、起止时间、退出码、去敏响应和关联 ID。web 既有桌面声明缺失单列，不编造全绿。
- 发布遵循原任务书的前置条件；修复关键问题、确认迁移/回退兼容后再按既有授权发布。不要收到本报告就立即重启线上，也不要把“旧版忽略新字段”当作安全回退证明。
- 保留 wb、现有 Key、原项目、原任务、原视频、五类清理关闭状态；凭据沿用私有交接文件，不要求用户重发，不用旧 settings 导入整段覆盖当前设置。
- 新版验收须确认页面入口与节点安装版本；保存草稿后再刷新/重新登录，不强刷用户旧页面。
- 最终一次性交付：T01—T18 逐项状态、修复位置、实际验证范围与证据、当前版本和数据分母、收费新增 0、剩余风险及回退边界。常规问题由主窗口协调，不拆成多轮让用户传话。

## 6. 可直接发给执行窗口

请完整读取 E:\Ai\codex3\Toonflow\Toonflow-app-master\docs\fourthIndependentAcceptance.md，并继续遵守 completeRepairExecutionPlan.md 与 AGENTS.md。当前 -14 真实上线，但第四轮独立验收仍未通过：保留已关闭的 5 组主缺陷，一次性收口报告列出的 13 组剩余问题，优先修 T09 提交许可/旧记录恢复、T07 核验身份、T10 迟到取消覆盖；按 Q/W/C/I 文件所有权并行并交叉复核正式调用链，同时修正报告点出的 v4 契约缺陷。沿用已有私有凭据，保护现有配置和用户数据，五类清理保持关闭，新增收费生成 0，禁止新增测试文件/临时测试程序。补齐可安全非收费完成的真实证据，满足原发布条件再上线；最后一次性汇总结果和限制，不只改报告，也不要让我逐项传话。
