# Toonflow 第三轮独立验收与一次性返工清单

审计日期：2026-10-08（北京时间）。审计对象：执行窗口第三轮交付及线上 server-20261008-12。

**结论：不通过本轮完整验收。部署已完成，若干主路径确实修好，但仍有 18 组代码或接线问题。不能将“已部署、基础可访问”写成“长任务、清理和并发已全面验收”。**

本报告由规划/独立验收窗口编写，区别于执行窗口自报验收。当前阶段仅审查并记录，未改产品源码、部署、重启、开启清理或新增收费生成。18 组是按修复责任合并后的分组，不是 18 次线上故障；下文明确区分现场实测、源码可达反例和未验证项。

原任务书继续有效：[completeRepairExecutionPlan.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/completeRepairExecutionPlan.md)。本报告补充其未闭合分支，不推翻已有正确改动。历史 [secondIndependentAcceptance.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/secondIndependentAcceptance.md) 和 [independentAcceptance.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/independentAcceptance.md) 保留。

独立现场数据、完整指纹及实际检查结果：[auditSnapshot.json](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/thirdIndependentAudit20261008/auditSnapshot.json)。

## 1. 本次实际核实到的现场

| 项目 | 独立核实结果 |
| --- | --- |
| 公网入口 | https://flow.xmxcode.com；MCP 为 /mcp |
| 正式容器 | toonflow-toonflow-1，running / healthy |
| 镜像标签 | toonflow:server-20261008-12 |
| 完整镜像 ID | sha256:e9afabc0c1d3a3b25a14827aca94fcd3d078d1a4398cb24688969ad7c5943060 |
| BUILD_ID | server-20261008-12 |
| 启动时间 | 2026-10-08T09:46:00.002983321Z，即北京时间 17:46:00 |
| 端口和数据 | 127.0.0.1:3930 → 3000；/opt/toonflow/data → /app/data |
| 登录配置 | AUTH=1、COOKIE_SECURE=1 |
| 现场调度 | paused=false；生成并发 2，下载并发 2；等待提醒 24 小时 |
| 清理开关 | text/image/video/original/cache 全关闭，天数为 2/2/2/30/2 |
| 文本模型配置 | wb，4 个模型；没有重新导入旧 cline 配置 |
| 任务分母 | 13 批次、43 条：36 cancelled、2 failed、5 succeeded；有 upstreamId 的记录为 2 条，未解决活动任务 0 |
| 隔离实例 | docker ps -a 未见仍留存的 Toonflow 隔离验证容器 |
| 身份一致性 | 抽核 23 个当前本机源码文件与运行容器内源码，全部 SHA256 相同；tools 8、nodes 8、providers 5，共 21 个安装文件与容器构建文件相同 |
| 当前网页入口 | 新开页面加载 assets/index-JTxenVxX.js，显示管理员登录 |
| 原有网页 | 用户原标签页仍加载 assets/index-DGvzOLuV.js，显示 studio1 的 3 个节点；没有强制刷新或改画布 |
| 备份目录 | /opt/toonflow/backup/repairExecution20261008 存在；未在本轮做恢复演练 |

运行容器内有完整工作区，因此可以直接比对源码；源码一致和安装产物一致分别核对，未以其中一项代替另一项。

### 1.1 本次 HTTP、MCP 与上游只读检查

- 用项目实际依赖的 @modelcontextprotocol/client，经 Bun 连接公网 MCP，初始化和工具列表成功，共 48 个工具；初始化加读取列表耗时约 1681ms。
- 带正确 taskIds 调用 getVideoTasks，读到已有任务 6efddcaf-8e7a-44ae-a2e0-b6cf9c9ec0de 为 succeeded，输出项实际字段为 state: available。这也直接证实第 T11 项所讨论的后端返回结构。
- getAppState 当时返回 connections=[]。当前新页尚未登录、原页仍为旧包，不能据此宣布画布 MCP 坏了，也不能把本次服务端任务查询成功当成已完成新版画布控制/hidden 验收。
- 公网 health 200，schedulerReady=true、recovering=false、stopping=false、blocked=0。
- 未登录读设置 401；MCP Token 不能代替网页 Cookie（401）；网页登录 200，Cookie 带 HttpOnly、Secure、SameSite=Lax；网页 Cookie 不能代替 MCP Token（401）。
- 设置接口除登录外还要求既有页面来源和 x-toonflow-workspace 标记。最初手工请求缺少这些字段返回 403；按现有协议补齐后为 200，并有 x-toonflow-settings-revision。不是设置功能故障。
- 清理状态接口 200，全关时当前 preview 为 0。状态里的 lastRunAt、15 字节/1 文件是历史清理记录，不是本轮执行过删除。
- Python 默认 HTTP 客户端经本机代理访问公网时被 Cloudflare 返回 403 / error code 1010；换用项目实际 MCP 客户端成功。记录该客户端差异，未修改 Cloudflare、代理或认证规则，也不据此宣称公网 MCP 整体不可用。
- 已结束本轮 MCP 客户端会话；本轮临时浏览器页已关闭，用户原标签页保留。未向 Toonflow 内置 Agent 发送消息或付费推理。

两条已有视频文件独立核实：

| 工作区及文件 | 字节数 | 完整 SHA256 |
| --- | ---: | --- |
| studio1/assets/generated/video53ec9e26-0b22-40f5-97f3-617c1dd5c4e2.mp4 | 3107025 | 997b0f2592fbe8519cfe02249c14af6f176cc86eb01e784b271a2f949420d01e |
| myProject/assets/generated/video13587274-03a5-4843-a1ed-0a1540dce38c.mp4 | 2206448 | 531ddcb9763a8e2a636adc4d1a6943badaa782310ae4b1a8d471a9e87f64b31d |

本轮还用服务器现有配置，各查询一次上述两个已有 Dola 上游 ID，没有调用创建接口：

| 原上游 ID | HTTP | status | 原样返回的模型 | 账户字段 |
| --- | ---: | --- | --- | --- |
| video_cf44a643ed | 200 | completed | seedance-v2.0 | 未返回 |
| video_a10458c9a0 | 200 | completed | seedance-v2.0 | 未返回 |

两次响应都回显了相同 ID 并有结果 URL。本证据只说明这两条任务此时可查询；不证明上游保证数天/永久保留，也不证明跨账户归属。响应 URL 和 Key 未写入审计文件。

### 1.2 本次本地检查

- apps/server：bun run typecheck，exit 0。
- apps/web：bun run typecheck，exit 1；唯一输出为 electrobun.config.ts 找不到 ./.hutch/devkit/api/config/ElectrobunConfig。与既有桌面开发依赖缺失一致，没有把它写成“全绿”。
- 本轮未重新构建、改写 build 或新增任何测试文件。正式构建成功属于执行窗口证据，独立窗口补核了当前运行身份与安装文件。
- 无 .git；没有初始化仓库、清理、重置或覆盖任何执行窗口工作。

## 2. 确实修好的部分，继续保留

以下是源码审查确认的改进；除上节明确实测的内容外，不扩大为全链路动态通过。

| 已有成果 | 保留结论及边界 |
| --- | --- |
| 首写、追加和状态更新的幂等持久化 | 先原子落盘后发布内存，同 batchKey 去重在锁内；原“未落盘就返回 existing”主缺陷已修。容量预约需另补 T04，不能倒退回提前发布 |
| 上游 ID 保存 | 删除了已收到 ID 却因普通 abort 直接丢弃的分支；暂停意图可以随 ID 保存。完整停机协调仍见 T02 |
| 无 ID 的 resume | queued/preparing 不再用 resume 触发首次生成；放弃与恢复撤销豁免已有字段 |
| 生成和下载额度区分 | downloading 已从上游生成占用排除；已经持久化的未来 retryAt 在恢复/操作中保留。下载内部 sleep 旁路仍见 T06 |
| 同步供应商首次后台执行 | submitMedia/queryMedia 成对能力分流，原同步 generate fallback 可达；不再只提示无法执行的 resume。输入快照仍见 T09 |
| XMX / Dola 请求体传图 | XMX 有图走 edits multipart，按序逐图附加，失败不降级文生图；Dola 单图 image、多图 images，首尾帧/其他图顺序明确；不支持参考类别/mode 会拒绝 |
| MCP closing 主路径 | 先置 closing，settle 不再继续 dispatch；signal 已传至公共提交。提交前收尾仍见 T10 |
| 保存 ACK 主路径 | 固定写入文本快照及 manifest，六项匹配清绑定，同任务/同输出复用 token；普通 failed 含部分输出走待回写 |
| 画布冲突重载 | 清提示与丢 revision 已拆开，重载保留此次读取对应的 revision；原 R07 主缺陷关闭，二次交叉保存仍需 V15 实测 |
| 页面聚合基础 | 跨 bundle 共享 hub、taskId 去重、200 分片、显式 limit、hidden 降频、无订阅释放已实现；整轮等待见 T13 |
| 清理意图 | cleanupIntentAt 与 cleanedAt 分离；unlink 失败不把旧意图当成下次越过保留期的依据 |
| 正常文件登记 | 正常写入路径已有“持久保护→写入→登记→解除”；下面指出的是恢复和故障分支，不否定正常路径 |
| 目录正常操作 | 真正后代递归迁移、相似前缀兄弟区分、复制新身份、删除清账有实现；失败事务和任务定位见 T15 |
| 内置子 Agent | 父任务恢复前重新 FIFO 取槽的普通路径已修；未新增付费模型调用验证整条嵌套链 |
| 同名定制插件 | 当前/旧官方/新官方三级哈希，定制保留，新官方进入非加载 pendingUpdates；清单和标记原子写。21 个当前官方安装文件另已实测一致 |

## 3. 仍需修复的 18 组问题

P1 表示可能造成重复生成、结果/资料保护失效或核心队列停滞，需优先关闭；P2 表示功能语义、恢复或可用性缺口。**本节反例以当前源码和实际依赖调用链为依据，未在正式任务上制造故障。**

### T01 / P1：本地已有 taskId 的 unknown 仍能被当成“已结束”后再生成

对应 W2、R02/R06。

依据：[视频节点 awaitingReview](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodes/videoGenerationNode/src/index.vue:171)、[继续生成入口](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodes/videoGenerationNode/src/index.vue:374)。

awaitingReview 仅识别 unknown 且没有 taskId。服务器已经受理并返回本地 taskId、随后上游受理未知，是正常的另一种 unknown。它不属于 taskActive，也不属于 awaitingReview，却进入“上一次任务已经结束”确认框；确认后 discard 并以新键 start。原上游可能还在生成，页面提示却没有真实表达该风险，也没走 abandonUnconfirmed 的既定流程。

收口：按任务状态和已核实的上游终态判断，不能用“非 active”代替终态；unknown 不因有本地 taskId 就变成可重新生成。UI、节点 MCP 和公共 hook 共同复核，保留原键/恢复关联。核验两种 unknown、failed 的部分输出、cleaned 的成功结果及真正可重新生成的终态，不新增收费试单。

### T02 / P1：停机总预算超过 Docker 60 秒，在途受理也没有完整排空

对应 Q2、I4、R01/F13。

依据：[启动入口](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/index.ts:46)、[清理等待](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:476)、[媒体 drain](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1591)、[持久写队列](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/store.ts:362)、[受理入口](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:414)。

退出顺序是 MCP → 清理 → 媒体 drain。清理可先等 30 秒，再开始媒体的 45 秒 + 5 秒，合计可达 80 秒，还没计 MCP 和最终写队列；现场 Compose 只有 60 秒。最后的 drainMediaTaskWriteQueue 又没有截止时间，“超时必返回”的注释不成立。

此外 server.close 没等待回调；受理开始时检查 stopping，之后目录/供应商/快照/批次锁等待没有统一在途计数。drain 只等 jobs 和当前 pendingWrites，不等尚未开始写入的 taskChains/batchChains。可能在请求仍准备或等锁时判断已经排空并退出。不能据此直接断言已重复收费，但契约要求的在途受理收敛尚未实现。

收口：一个全局截止时间贯穿封门、HTTP/MCP 在途、清理、作业和最终落盘；已有 ID 的持久化有明确优先级；等待中的协调队列也计入。Docker 宽限覆盖真实总预算并有余量。空闲 SIGTERM exit 0 仅证明空闲停机，不能作为此项通过依据。

### T03 / P1：恢复完成前仍能从受理入口派发新生成

对应 Q2、I4。

依据：[初始化](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1551)、[tick 门](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1298)、[受理后请求 tick](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:572)。

加载台账后延迟 2 秒才恢复。受理完成可以提前触发 tick；派发门只看已产生的 recoveryState.error/recoveryErrors，没有要求 settled、非 recovering，也没在这个门里核对装载 warnings。损坏批次 warnings 到 recover 才被纳入。因此展示 ready=false 并不真正阻止新生成，恢复中的已有占用/保护尚未核实也可能派发。

收口：所有派发入口复用同一恢复就绪条件；恢复未完成或台账/保护不明时不派新生成。受理可以按既定契约排队，但不能绕开门。核对启动定时器、直接受理触发和设置变化触发，不能只修周期 tick。

### T04 / P1：生成作业在等待落盘时没有容量预约，可突破并发 2

对应 Q1/Q3。

依据：[startJob](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:762)、[开始生成](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:958)、[额度统计](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1344)、[落盘后发布](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/store.ts:537)。

generate job 已登记，但 queued→submitting 在等待批次锁/写盘时，公开状态仍为 queued。下一 tick 只按任务业务状态计算上游占用，跳过已有 job 的任务却没有把该 job 计作容量预约。如果持久化慢过一个 tick，又会放其他 queued，随后都可进入上游。

收口：对已准入、尚未发布 submitting 的 generate job 计一次预约，与已在途任务去重；失败、取消和停止时归还。继续保留正确的“durable 后 publish”。验证依据必须是实际准入/请求数量，不只看最终台账状态。

### T05 / P2：下载已暂停，迟到网络响应仍会保存并改成 succeeded

对应 Q3、R02、V07。

依据：[pause](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:780)、[下载返回后的逻辑](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1221)、[下载收尾](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1280)。

pause 只设置 trackingStatus=paused，不中止下载 job。下载前检查 active，但网络返回后仅检查 state=downloading；后续保存、登记和成功收尾不复核 paused，成功还会清掉暂停意图。

可达顺序是“请求在途→暂停成功→响应回来→才开始落盘→succeeded”，不属于“已经进入不可中断落盘段允许完成”的例外。

收口：网络返回后、开始不可中断落盘前及状态合并时重查当前意图/版本；遵循既定暂停语义，不丢已经可靠保存的结果，也不以旧回调清新暂停。

### T06 / P1：下载的长 Retry-After 仍占槽，前四次等待没有持久化

对应 Q3、R03、V05。

依据：[下载重试](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1225)。

前四次失败直接在 download job 内 sleep(retryDelayMsFor(...))；第五次才 scheduleDownloadRetry。Retry-After 已能透传和解析；若两条下载收到小时级 Retry-After，可占满默认两个下载槽数小时。暂停也不能结束这段等待；等待下限未落盘时重启，又可能提前请求。

收口：每次应延迟的重试都先持久化 retryAt、退出当前下载作业释放执行槽；仅到期且可跟进时再拿槽。不得清除上游给出的更晚下限。分别证明生成槽、下载槽、查询间隔三者的行为。执行 V05 人工派生记录只核对了“已经存在的 retryAt 能否保留”，未覆盖此分支。

### T07 / P1：供应商兼容、人工绑定及恢复身份仍有四个缺口

对应 Q4、R04、V08。

依据：[providerCompatibility](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:141)、[上游核对](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:401)、[同 ID 解 blocked](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:862)、[新绑定](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:910)。

1. 完整地址相同时完全忽略 providerRevision，没有核过查询协议的兼容依据；两边地址都缺失且 revision 相同又提前 true，绕过后面的凭据引用检查。
2. ID、模型缺失只记 unverifiable；account 只要非空便记 verified，没有与可信身份比较；任意一个身份字段存在即可放行。只返回模型或一个未经比较的账户名也能通过，并不能证明候选任务确属该历史任务。
3. 核对成功解除 blocked 只改 active/reason/retryAt，没有保存独立、可审计的已核实恢复身份。下次 loadTaskProvider 仍用原来的缺地址/旧凭据资料走同一兼容门，又被挡回 blocked。首次 bind 也没有建立该恢复依据。
4. 全局 upstreamId owner 检查在上游 await 之前；写入只锁各自 taskId，没有同查询账户+上游 ID 的共同协调和锁内重查。两个任务可以同时通过检查后绑定同一 ID；核对开始时的任务版本和供应商身份也未在落盘前重查。

收口：按既定契约分别保存历史提交身份、当前查询身份和核实后的恢复依据；明确兼容协议，不以所有 revision 不同都自动挡住，也不以地址相同就全部放过。上游没返回的字段保持“无法确认”，不得编造账户。正常可信自提交续查无需每次额外人工核对；身份变化/人工 bind 必须满足受控核验规则。绑定唯一性、版本和身份在统一临界区内最终重查。

本次已补真实只读边界：两条 Dola 响应有 ID/model，无 account。执行窗口“未允许真实探测”的表述不适用于原任务书 V08 明确允许的已有 ID 查询。该结果仍不解决代码里的账户核验和恢复接线问题。

### T08 / P1：已有 output 的认回仍只检查文件存在，可能把坏文件当成成片

对应 Q6、F15、V11。

依据：[known output 分支](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1242)、[可用性检查](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/outputState.ts:35)。

下载得到正确字节并计算 SHA 后，台账已有相同 SHA 的 output 就调用 mediaTaskOutputAvailability；这个函数只 stat，普通文件即 available，于是跳过新下载的正确内容。旧文件被同长度不同内容替换时，仍可保留坏文件并完成任务。

收口：认回入口核对实际磁盘内容 SHA，不把展示用的轻量存在性检查当成完整性证明；复用已有 mediaOutputSha256/内容核对能力。已清理不自动复活，缺失/损坏按原任务补取，不能新生成。新文件冲突分支已加真 SHA，应保留并补上此旁路。

### T09 / P1：参考输入快照没有贯穿同步执行，快照校验及准备中断也有缺口

对应 Q5、参考图原需求、V09/V10。

依据：[同步执行前校验与调用](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:883)、[同步生成重新读原文件](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/media/generation.ts:127)、[快照读写](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/snapshots.ts:90)、[submitting 时点](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:958)。

- 同步后台任务先校验工作区原图，然后 generateMedia 又读一次原文件，没有使用已经持久化的快照。排队时原图删改会让完好快照的任务失败；校验后、读取前换图则可能静默提交另一张图。
- 内容寻址快照已存在时仅核存在，恢复时核长度，实际读出时未核 SHA；同长度错误内容可进入异步 provider。
- 在加载供应商、读取快照等本地准备前已经持久化 submitting/submittedAt。准备中途 abort 直接返回，恢复对无 ID submitting 统一记 unknown，虽然当时可能确定还没开始网络尝试，仍占保守容量、要求人工核对。

收口：同步/异步后台均用受理时的持久快照构造真实 provider 输入，在现有读取入口核长度和 SHA；本地准备与真正开始提交有可恢复的事实区分，确定未发请求的失败不误入上游未知。旧独立同步 HTTP 接口可维持原结构，不另造框架，不长时间锁整个工作区。核验受理后原图修改/删除、多图顺序、实际发送字节 SHA 和准备中断。

这不是宣称 XMX multipart 仍丢字段；请求体传图已修，问题在宿主选择了哪些实际字节。

### T10 / P1：提交前取消留下幽灵绑定，取消后的失败查询又可能清恢复关联

对应 W1/W2、R05/R06、V13/V14。

依据：[send 的 try 边界](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:629)、[绑定创建](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:776)、[cancel](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:814)、[hub 错误处理](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:210)。

- start 已持久化 pending。send 中目录 await 后的取消/身份检查在 try 外，抛出的 preSubmit 绕过 catch 内 revokeBinding。POST 确实被挡住了，但留下根本没提交的键；后续 start 发现绑定只查不提交，节点可能一直查不到任务。这一子项为 P2。
- cancel 先用简版响应改 state，再 await poll；hub 把查询错误捕获后正常完成。简版为 cancelled、完整摘要因断网/401/空结果未拿到时，调用方仍可能 clearBinding，丢掉尚未核实的部分结果回写关联。这一子项为 P1。

收口：所有提交前 await/校验都纳入同一可撤销生命周期，只撤销本次确定未发出的新绑定；POST 已发出则保留原键查回。完整摘要查询要明确表达“成功取到”“未找到”“失败”，不能以 Promise resolve 代替确认无输出。只有可靠终态和输出处理完成才清绑定。

### T11 / P2：输出字段错接，改名路径、后续清理状态和等待原因没有完整消费

对应 Q6/W4、R09、V16/V17。

依据：[服务端摘要](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:179)、[前端摘要类型](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:6)、[输出选择](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:543)、[保存 ACK](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:459)、[素材库](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/pages/workspace/panels/canvas/components/assetLibrary.vue:219)。

1. 后端输出项是 state 和 resolvedPath，前端读 outputState 且不消费 resolvedPath。已清理/缺失项可被当可用；混合输出可能先取坏文件，改名后仍绑旧 path。全部 cleaned 时顶层虽可能禁播放，内部仍可能设置 pendingWriteBack。
2. 正常成功后停止订阅，保存 ACK 清本地绑定；重新挂载只找 localStorage。已保存节点之后被清理，没有可靠途径刷新其可用性，旧路径仍可能播放/下载失败。
3. 文档文件树和素材库没有报告所称的 cleanedAt/outputState 消费链，不能仅凭视频节点一处文案宣布全部视图完成。
4. hook 没有完整消费/返回 trackingStatus、waitingReason、retryAt；paused/blocked 的 running 仍可能显示“继续在服务器执行”，节点 MCP 也缺受阻原因。

收口：前后端字段统一，使用可信最新路径；保存恢复关联可以清，但已保存结果的任务/资产身份要支持后续可用性查询。按既定产品范围补节点、文件树、素材库的实际状态，优先复用公共查询。人工清理与上游失败明确区分，查询可用性不触发生成。

### T12 / P2：设置重载没有真正串入保存队列，可被迟到响应覆盖

对应 W3、F18、V18。

依据：[reloadSettings](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/stores/settings.ts:124)、[重载按钮](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/components/settings/index.vue:20)。

现在只 await 调用时的 saveQueue；整个 GET→校验→发布并没有加入队列，也无重载单飞。两个重载响应逆序到达，旧响应可覆盖新 settings/revision；一个结束就把共享 applyingSettings=false，另一个仍在途时自动保存可能重新开始。新输入、显式 saveSettings 和迟到重载仍有交错。

收口：保存、重载和发布有同一个可解释的串行/版本规则；只发布仍有效的响应，过期响应不能覆盖更新。保留已修好的“单次读取失败保草稿/旧 revision/冲突/重试入口”。动态补离线失败后重试及并行重载/保存，不能只做成功 GET。

### T13 / P2：节点状态调用等整页聚合轮，慢批次仍会消耗 MCP 120 秒预算

对应 W5、批量 MCP 原需求、V19/V20。

依据：[hub 的串行分组查询](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:166)、[poll](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:488)。

poll 等待整个 hub round。hub 按目录、分片、多个 batchKey 串行查询。一个节点自己的状态即使先已取得，也要等其他未知键/慢目录；若若干请求各自耗时接近查询上限，总时间仍可吃满控制调用预算。不是每次状态查询都必然超时，但原长期方案要消除的等待耦合还在。

收口：节点工具读取本地已知摘要，或仅等待自己的订阅结果并有短截止；后续页级观察独立持续。保留跨 bundle 聚合，不能退回每个节点无限独立轮询。验证记录真实订阅数、唯一 ID、batchKey、实际请求数以及单个目标返回时刻，不要求凑 100 个付费任务。

### T14 / P1：编辑保护不完整，多标签、租约与删除竞争、解除后的保留期仍有缺口

对应 C3/W4、R09、V21。

依据：[editing 路由](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/routes/cleanup/editing.ts:21)、[占用键和释放](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/editing.ts:30)、[清理判定](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:270)、[文档接入](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/pages/workspace/panels/document/index.vue:115)、[前端租约错误](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/lib/workspaceFiles.ts:227)。

- owner 用 Cookie token 摘要，两个同浏览器标签共享身份和同路径条目；A 关闭可释放 B 正在编辑的文件，直到 B 下次续租。
- renew 不取得删除所用路径锁；清理检查占用后尚有多次 await。期间页面可收到续租成功，清理仍继续 unlink。
- 释放/TTL 仅删内存条目，不持久化最后实际保护解除时间；期限只看登记和任务解除。文件本来已到期，关编辑器后下一轮就可删，没有从解除保护起重新获得完整保留期；重启也丢租约。
- holdEditing 业务调用只在文本文件编辑，排除了 canvasNode 和非文本文件；图片编辑、画布文本、视频待回写未接。首次登记失败只是保存错误，界面无消费者，不能声称已有断联宽限保护。

收口：登录身份之下有独立页面/编辑占用身份，按页面释放；登记/释放/删除在同一协调边界重查；真实解除时间可靠持久化进入保留期。把任务书已点名的编辑和待回写入口接齐，首次保护失败明确可见，不得静默假成功。核对双标签同文件、hidden 续租、重新登录/重启、登记与删除交错及最后解除后的完整期限。

### T15 / P1：目录改名的失败回滚不完整，正式入口也没有更新任务输出定位

对应 C2/Q6、R09、V17。

依据：[迁移备份](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:750)、[实际改名协调](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:429)、[任务侧重定位函数](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1071)、[路径日志解析](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:918)、[正式 rename](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/routes/workspaces/files/rename.ts:18)。

- backupKeys 只有源目录本身与新路径，漏掉所有源后代原记录。迁移失败时 restoreRecords 无法恢复被移走的源子文件归属。
- records 已落盘、protections 再落盘失败时，仅恢复内存，没有恢复已经写出的账本；迁移成功后 appendFileRelocations 失败，外层只把物理目录改回，账本仍留在目标，却提示文件操作已回滚。
- 正式 rename 直接进 C 的 relocateWorkspacePath；Q 的 relocateMediaTaskOutput 全仓只有定义，没接正式调用。实际多任务输出未按固定锁序协调，也未持久更新 task.outputs.path。
- 路径日志虽存 refs，解析按旧路径匹配，未以任务/资产身份约束，且有 2000 条/10 跳上限。旧路径被别的文件复用再改名，旧任务可能串到新文件；日志淘汰会失定位。旧路径上任意普通文件又被优先视为 available。迁移后清理的新路径 cleanedAt 也不一定被查到。

收口：正式 rename 进入覆盖受影响多任务的协调，真实输出路径作为持久事实更新；路径日志仅作受身份约束的兼容信息。回滚覆盖源后代、目标、保护和定位记录的持久内容；不能完成时保持明确阻断。核验目录多输出、旧路径复用、迁移后清理、写失败及回滚，不能只有成功顺序演练。

### T16 / P1：保护表出错或目录回滚失败后，删除阻断不能可靠保持

对应 C1/C2。

依据：[保护表加载](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:289)、[写入后健康标记](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:357)、[路径保护判定](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:640)、[范围保护登记](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:662)。

目录失败时写 rangeReason 到源/目标目录，但清理只查 protections.has(文件精确路径)，不匹配目录后代，“已保护涉及范围”对树内文件不成立。

保护表解析失败被移为备份，受阻健康状态仅内存；随后任意新保护写成功就 health=true，未恢复未知旧保护也能放行。重启后原表缺失又被当成首次空表。有效 JSON 中坏条目直接跳过，也没有保守阻断其未知范围。

收口：范围保护涵盖真正后代且不误匹配兄弟；无法确认保护数据时，故障状态跨重启保持；只有完成明确恢复核对才解除。可写不等于历史保护已恢复，不能用一次新写成功代替修复。

### T17 / P1：保护恢复可能把正在写入的围栏误当遗留并清除

对应 C1、R08。

依据：[恢复登记保护](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:608)、[每轮清理先恢复](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:519)。

恢复遍历保护快照后直接登记并清当前 pending，不取写入路径锁，也不比较 guardId/版本。它可把仍在写的 live guard 当成崩溃遗留，或用旧快照清掉同路径后来建立的新 guard。inspectPath 对尚未存在的文件返回 size=-1，也不能自然防止提前解除。

收口：遵守既定锁顺序，正在写的路径跳过恢复；仅恢复可确认的落盘结果，解除必须匹配同一代保护。正常成功路径已有围栏，重点补恢复生命周期，不能在每个调用方堆新锁而互相死锁。

### T18 / P1：原生 FFmpeg 拼接重复拿槽可死锁，仍有未覆盖启动/释放边界

对应 I2/F11、V23。

依据：[终态包装](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/commandSlot.ts:29)、[FIFO 放行](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/slot.ts:8)、[宿主工厂](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/ffmpeg/index.ts:42)、[runtime clone/静态 ffprobe](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/runtime.ts:80)。

实际安装依赖 concat 的调用链是 concat→this.ffprobe→回调 this.run。当前同时包这些方法，持槽标记由 executeRemoteFfmpeg 外层入口设置；原生包装器自己取得槽时没有设置。ffprobe 回调在原回调之前释放槽，并立即 FIFO 放行下一项。

可达顺序：

1. A.concat 占槽 1，内部 A.ffprobe 占槽 2。
2. B.concat 排队。
3. A.ffprobe 完成，先释放槽 2，FIFO 立即让 B.concat 占槽 2；B 的 ffprobe 排队。
4. 再回到 A 的 probe 回调，A.run 也排队。
5. A/B 外层占满槽，但真正可结束它们的内部工作全部排队，形成死锁。

另外 clone 返回新实例未继承包装；静态 ffprobe 使用未代理工厂；原生 exec/execute 别名未覆盖。有的流关闭/错误先 emit error 后 kill，error 事件释放槽也不等于进程真实退出。

收口：把信号量放在实际子进程生命周期边界，明确外层链式配方与内部 probe/run 的关系；统一克隆、静态调用、别名和取消的占用释放，避免双重拿槽。不要靠继续扩充终态方法列表修补。用已有成片免费验证原生双 concat、HTTP/原生混合、排队取消和运行取消，核真实进程退出。

同时纠正报告：stream/pipe 在已包装实例上会同步建流再调用 run，不可仅因“同步返回流对象”就断言不能纳入；真正覆盖边界按依赖调用链说明。执行 V23 的 HTTP 三路不覆盖上述原生反例。

## 4. 执行证据不能按“26 项全部通过”使用

证据目录：[repairExecution20261008/run1](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run1)。

| 证据项 | 当前可支持的结论 | 不能支持的扩大结论 |
| --- | --- | --- |
| validationResults.jsonl | 27 条记录，即 V01—V26 加 V02b，多条明确写源码核对/部分实测 | 27 条记录不等于 27 项动态通过，也不是简单的 26/26 全绿 |
| submissionLedger.jsonl | 11 行，其中 10 行有明确 HTTP 和耗时 | 3_4_concurrent_same_batch 为 http=?、ms=null、items=[]；不能独立还原第 3、4 次并发返回和完整 12 次分母，V02b/V03 的响应也未在此形成同口径明细 |
| V03 | 失败→重传失败→恢复写入的顺序记录 | 未覆盖首写在途与重传交错；幂等代码本轮已修，不因缺此实测否定，但不能说交错已测 |
| V05 | 隔离副本派生 running/downloading/retryAt 后的恢复字段检查 | 不是上游真实 429/Retry-After；不能证明等待释放下载槽 |
| V06 | 无在途作业时 SIGTERM 正常退出和重启 | 不是慢清理+作业+写盘收敛，也不是 ID 临界段演练 |
| V08 | 执行阶段源码核对及缺字段 blocked | 本独立审计另补两条原 ID 只读结果；模型/ID可见、account缺失，不能宣称完整账户归属已证实 |
| V11 | 两条历史视频 SHA/存在性 | 同长度坏内容认回分支并未动态触发；而 T08 也指出该分支仍有代码缺陷 |
| V13/V14 | signal、manifest/token 的主分支源码 | 不能覆盖 try 外取消、摘要查询失败清绑定或所有 ACK 交错 |
| V15/V18 | 主分支修改与前轮部分经验 | 本轮二次交叉保存、离线重载失败后重试未跑；这是可以按隔离产品流程补的工作 |
| V16/V17/V21 | 部分清理/迁移成功顺序样本、先有占用后清理 | 未证明所有视图显示、任务输出正式改名、租约/删除交错、故障回滚和保护解除后完整期限 |
| V19 | 无订阅时 6 秒内 0 次任务查询 | 不能证明有订阅的聚合、分片和单目标返回时限 |
| V20 | 执行报告称 hidden 内两个 getCanvas 成功 | getVideoTasks 因缺 taskIds/batchKey 返回校验提示，未做可逆文字修改；不能把到达工具层当成功查询。本独立审计补服务端查询，但未补 hidden 画布全链 |
| V22 | 父槽重取源码闭合 | 未跑新增付费 Agent 链；额度 0 应继续遵守 |
| V23 | HTTP 入口的并发/转码样本 | 原生工厂仅自检/源码覆盖，不能写所有入口无死锁 |
| V24 | 正常定制保留及安装一致 | 写失败分支未动态验证 |
| V25/V26 | 本轮独立补了完整镜像 ID、23 源码、21 插件、认证、任务/媒体分母 | 不补齐其他 V 项，也不等于用户旧标签页已经更新 |

当前 run1 没有 commandResults.jsonl 或足以逐项重放判断的原始命令/浏览器时间线；executionManifest.time 还是 17:5x，镜像 ID 是缩写。不是说所有动作没做，而是第三方不能仅靠摘要复核。后续保留实际命令退出码、起止时间、响应与关联 ID；凭据、Cookie、签名 URL 必须去敏。

收费/自然等待不能安全复现的窄场景，继续明确标源码审查或未实测；不为凑通过新增付费任务、伪造上游状态或编写临时测试程序。可以非收费完成的验证不要再用外部限制笼统跳过。

另有明确仓库规范偏差：新 routes/cleanup/editing.ts 同时注册 POST/DELETE/GET，违反一个接口一个文件。由 C 拆分、同步调用并执行既有 routes 生成命令；不能手工改 router.ts。此项与功能收口一起完成，不扩成全仓格式翻修。

## 5. 一次性并行返工安排

继续使用“主窗口 I + Q/W/C 三个子 AI”。先冻结交界契约，再并行实现；冲突文件只交一个所有者。用户不需要逐项在窗口间传话。

| 所有者 | 本轮责任与文件边界 | 完成后交叉复核 |
| --- | --- | --- |
| Q：后台任务 | T02 媒体/受理部分、T03—T09、T11 摘要、T15 多任务重定位入口；独占 apps/server/src/utils/mediaTasks/ | W 查返回/取消/防重；C 查占用、输出、锁序 |
| W：网页和节点 | T01、T10—T13、T14 前端占用；独占 packages/nodeScaffold/src/useMediaTask.ts、videoGenerationNode、apps/web 设置/画布/文件入口 | Q 查状态语义和真实字段；C 查清理和编辑生命周期 |
| C：归属和清理 | T14 后端、T15 事务、T16/T17、editing 路由规范；独占 fileRecords/、cleanup/、对应清理/文件路由 | Q 查任务锁/保护；W 查正式入口与页面消费 |
| I：主窗口集成 | T02 全局生命周期、T18 FFmpeg、类型/构建、证据、部署收口；独占 server index/app、FFmpeg、部署与报告文件 | 再逐项核本报告、原任务书 V01—V26 和历史 R/F 对照 |

顺序要求：

1. Q/W 先统一输出项 state、resolvedPath、任务 trackingStatus、未知状态及查询结果语义。Q/C 先确定多任务重定位、保护代次、锁序和恢复就绪的共同接口。不要让两边分别写“已接线”却字段不一致。
2. 三组可并行改各自文件；I 同期修 FFmpeg 和总停机截止。Q/C/W 提供变化摘要后，I 才装配共享出口及生命周期。
3. 交叉审查必须实际从正式路由/节点/工具走到公共函数，搜索所有调用方；新增一个没被调用的协调函数不算完成。
4. 先在隔离数据、现有产品能力和现有成片上做非收费验证。禁止任何新测试文件、临时测试程序、mock 服务或测试专用入口；需要编辑媒体/文档验证时走已授权隔离产品流程。没安全可复现条件的场景保持源码证据，不编造真实任务。
5. 完成可安全执行的 V15/V18、有效范围的 V20、活动订阅 V19、原生 FFmpeg V23，并补全逐请求幂等台账。10—20 次提交是验证量，不是产品最多 100 个视频的限制；新增收费生成预算仍为 0。
6. server typecheck、按改动的包检查和完整候选构建必须实际记录；web 既有 .hutch 缺失如仍在单列。路由拆分后运行既有 bun run routes，不手工维护生成文件。不要新增自动检查脚本。
7. 发布仍受原任务书第 11 节前置条件约束。不能只依据自报“全部完成”切换；先关闭本报告 P1 和必需接线，确认迁移/回退兼容及原任务事实保留，再按既有授权更新 Toonflow。不要为了这份审计立即重启现网。
8. 继续保留 wb、Key、原工作区、原 ID/文件和五类全关。凭据沿用既有私有交接文件，不要求用户重发；不把旧 serverSettingsImport 整段覆盖当前设置，不在普通证据里打印秘密。
9. 新版本上线后提示保存草稿、刷新/重新登录并核对前端入口与 MCP connectionId；不能把旧包的可视画布当成新版验收样本。不要强制刷新用户有未保存内容的页面。
10. 最终交一份完整结果：每个 T 项“已修/未修/证据限制”、对应 V 项、文件和运行版本、实际分母、收费新增 0、回退边界。中间进度自行写入文件，常规决策不分批抛给用户。

不建议在未核实旧版理解新字段/保护协议前简单回退 -11；本审计没有实施回退。当前无活动任务、清理全关仅降低此刻触发机会，不代表问题已经消失。

## 6. 可直接发给执行窗口的一段话

请完整读取 E:\Ai\codex3\Toonflow\Toonflow-app-master\docs\thirdIndependentAcceptance.md，并继续遵循 completeRepairExecutionPlan.md 和仓库 AGENTS.md。第三轮独立验收未通过，当前线上是 server-20261008-12；这次请按报告 T01—T18 一次性收口，保留已修成果，主窗口负责集成、FFmpeg、停机和验证，Q/W/C 子 AI 按文件所有权并行，完成后互审正式调用链。不要只改报告，也不要把源码核对或顺序检查写成竞态实测。沿用现有私有凭据，不再让我传账号 Key；保护 wb、原工作区、原视频与五类清理关闭状态，新增收费生成 0，禁止新增任何测试文件/临时测试程序。补齐可非收费完成的二次冲突、离线设置恢复、有效 hidden MCP、活动订阅聚合、原生 FFmpeg 和逐请求台账；按原任务书发布门处理上线与回退，所有剩余问题和限制最后一次性汇总，不逐项让我在窗口间传话。
