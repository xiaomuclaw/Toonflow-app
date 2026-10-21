# Toonflow 第七轮独立验收与 T15 收尾清单

对象：`server-20261008-22`。本轮线上取证时间为 **2026-10-09 11:35—11:37（北京时间）**；随后完成源码、执行记录及 Q/C/W 交叉核对。

**结论：本次交付仍需收尾。原 18 组中，17 组保留主缺陷源码已关闭的结论，T15 仍为部分修复。**

本次确有进展：真实移动前已经先持久化意图；正常正向路径会等任务输出落盘再解除；上轮严格限定的“文件、归属、任务输出都在 A，带同事务 block，已解除 C 范围保护且无其他占用”的**单任务精确重试已修好**。T02 的预算说明也已改成目标值与实际缩减规则。

剩余问题属于同一改名事务的直接接缝：**保护没有覆盖完整生命周期；恢复不核对原意图的文件版本；多任务部分回滚后恢复会漏参与者；保护提示在部分出口被丢弃。**本报告不重开其他 17 组，也不把未动态验证本身当作新的源码缺陷。

本轮只做独立核查，未改产品源码、真实设置或画布，未部署、重启、开启清理或生产故障注入；新增真实生成请求 **0**，未调用内置 Agent 推理。新增文件仅为本报告和[审计快照](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/seventhIndependentAudit20261009/auditSnapshot.json)。没有新增测试文件、mock 服务或自动检查入口。

## 1. 已独立核实的线上事实

| 项目 | 当前取证结果 |
| --- | --- |
| 公网 | [flow.xmxcode.com](https://flow.xmxcode.com)，页面和入口资源 200 |
| 容器 | `toonflow-toonflow-1`，running / healthy，restartCount=0 |
| 镜像 / BUILD_ID | `toonflow:server-20261008-22` / `server-20261008-22` |
| 完整镜像 ID | `sha256:a5ae52faacbbe0c6c95c7a9dd48b48470b9735acbe8bcc90732094452d13c4c9` |
| 实际启动 | UTC 2026-10-09 03:24:04.6318939，即北京时间 **11:24:04** |
| 实际入口 | `bun build/server/index.js`；SHA256 `9a8837f61d61074ae31f8da1da0a110e91ac11edc958e444bf0089f128026e3b` |
| 数据 / 端口 | `/opt/toonflow/data → /app/data`；`127.0.0.1:3930 → 3000`；stopTimeout=60 秒 |
| 关键源码 | 本机与容器 **45/45** 文件指纹一致；上轮 42 文件中 9 个改变，另补核 MCP、Agent、素材改名 3 个本次改动文件 |
| 安装插件 | **21/21** 与相应 build 一致 |
| 网页入口 | `/assets/index-BPjVkrCs.js`，338508 字节；公网/容器 SHA256 均为 `9cb97224615a3c1589e7e85cdb1eae6e1f18b5e9eb81bbd6b34c50f4658a606b` |
| 就绪 | schedulerReady / creationReady / protectionReady / cleanupReady=true；recovering / stopping=false；归属、保护和释放表为 ok |
| 运行设置 | paused=false；生成/下载并发 2/2；等待提醒 24 小时；`wb` 文本配置 4 个模型 |
| 清理 | 五类全部关闭；文本/图片/视频/原始资料/缓存天数为 2/2/2/30/2 |
| 任务分母 | **13 批、43 条**：36 cancelled、2 failed、5 succeeded；2 条有 upstreamId；无活动状态任务、无持久 relocationBlocked，读取无错误 |
| 备份 / 隔离实例 | r22 备份目录存在；未演练恢复；未发现遗留 repairValidation 容器 |

两条原有成片均存在，大小及完整 SHA256 与上轮相同：

| 文件（相对工作区根） | 字节 | SHA256 |
| --- | ---: | --- |
| `studio1/assets/generated/video53ec9e26-0b22-40f5-97f3-617c1dd5c4e2.mp4` | 3107025 | `997b0f2592fbe8519cfe02249c14af6f176cc86eb01e784b271a2f949420d01e` |
| `myProject/assets/generated/video13587274-03a5-4843-a1ed-0a1540dce38c.mp4` | 2206448 | `531ddcb9763a8e2a636adc4d1a6943badaa782310ae4b1a8d471a9e87f64b31d` |

本轮真实接口核查：

- 登录 200，Cookie 的 HttpOnly / Secure / SameSite=Lax 正常；未登录读取设置 401。
- 正确页面请求头读取设置及清理状态均 200；网页 Cookie 访问 MCP 401，MCP Token 读取网页设置 401。
- 实际 MCP SDK 初始化并列出 48 工具：**1423ms**；查询一条原有成功视频任务：**382ms**，返回 succeeded / available，路径和 SHA 正确。
- `getAppState` 当时为 `connections=[]`；本轮没有进行浏览器画布交互或后台标签页验证。
- 审计 MCP 会话已终止，网页会话退出 200。

本轮在 `apps/server` 实际执行 `bun run typecheck`，退出码 **0**。未重新 build，也未重跑未改动的 ffmpeg/web/desktop 检查。执行者仍记录 desktop/web 的 Electrobun 声明环境问题，不能把全仓检查写成全绿。

这些结果证明本次版本确实已上线、基本读链路及原文件正常；不代替下列故障链的验证。

## 2. T15 仍需处理的具体路径

以下均为当前源码及正式调用链核对；**本审计没有动态注入这些故障，也没有观察到生产误删**。

### R1 / P1：保护没有覆盖“文件 + 全部任务记录”的完整事务

**R1a：反向补偿提前解除唯一意图。**正向 Q 在 [mediaTasks/index.ts:1542](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1542) 传入 `deferIntentRelease=true`，这一段已修。但 [反向补偿:1381](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1381) 沿用同一 transactionId，未传延迟解除；C 反搬成功后于 [cleanup/index.ts:730](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:730) 清意图。[fileRecords/index.ts:1484](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:1484) 按 ID 清全部匹配项，没有独立的“正向意图”留下。

自然失败链：任务定位文件已被替换为 B，随后 fsync 报错，内存尚未发布 → 文件/归属成功反搬 A，唯一意图被清掉 → Q 的 outputs 补偿失败 → 随后的 task block、C 范围保护及故障记录也写失败 → 重启可出现文件/归属在 A、任务持久定位仍 B，而没有意图或 block。未完成恢复的文件因此失去既定保护；启用相关清理、满足到期和其他判据后有被删除的风险。

任务输出补偿位于 Q 1391—1403 行，发生在 C 清意图之后。Q 1613 行“正向延迟意图在失败路径不清”的注释与实际同 ID 清除行为不符。修复必须让保护覆盖**反搬和所有任务输出补偿**，不能只补正向。

**R1b：人工核对接口也能在任务输出尚未发布时解除保护。**[protections.ts:35](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/routes/cleanup/protections.ts:35) 直接解除保护及意图；底层 1532 行只取路径锁。C defer 返回时已在 cleanup 758—759 行释放路径锁，Q 仍可能持任务锁等待 outputs 落盘。此时正式 `POST /api/cleanup/protections` 可提前清掉在途意图；若随后任务发布或补偿失败，反搬前意图、task block、C 范围保护及故障标记也持续写失败，重启后可能没有保护仍待恢复事务的屏障。

这是**锁的覆盖阶段不足**，不是已证明存在锁倒序死锁。人工核对必须接入完整事务活动判定或同一任务协调边界，不能把“路径锁空闲”等同于“整个改名已完成”。

**R1c：双端保护在归属迁移时缩成目标单端。**[fileRecords/index.ts:1909](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:1909) 把 source 上的意图按普通保护迁到 target，1930—1942 行合并后 source 键消失；[保护消费者:1600](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:1600) 只查当前键及祖先，没有按意图中的 source/target 反查。Q 也不补回 source 保护。因此，在全部任务输出完成前、以及该状态重启后，不能保证原路径及后代继续被事务保护。

这三条应统一处理为“同一事务持有固定两端保护，直到全部提交或全部补偿完成”，不要分别叠三个互不相干的开关。

### R2 / P1：恢复没有核对原意图的内容/版本，正式写接口又能改写被保护的源

**大白话：有未完成的 A→B 改名时，A 被换成新内容，再重试仍可能把新内容认成旧任务结果。**

该反例不需要伪造归属或 task JSON：

1. A→B 的双端意图已落盘，真实移动前进程退出；重启后文件、归属、任务输出仍在 A。
2. 使用合法的 `PUT /api/workspaces/files/write` 覆盖 A 为明显不同大小的新内容，不传可选的 expectedRevision/来源 header。
3. [write.ts:26](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/routes/workspaces/files/write.ts:26) 只取路径锁，31 行只检查已清理状态；91 行正常覆盖，没有检查迁移意图。旧 task refs 保留。
4. 再经正式入口 A→B。C 622—626 行只比较 refs，648 行按同路径对 transactionId 放行，692—699 行用当前文件重新写版本依据，**未核对旧意图原先记录的版本**，随后把新内容移到 B 并更新旧任务。

[fileRecords/index.ts:105](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:105) 明确将 versionBasis 仅作诊断，Q 也没有补充版本校验。本轮“归属换成另一任务时返回 EIDENTITY”的记录，只覆盖 refs 冲突，不能覆盖“refs 没变、实际内容已变”。

修复要先读取并核对**原持久意图**，不要用重试时的当前文件覆盖旧证据后再认回。路径哈希可以用于定位记录，不能独自证明是同一次文件操作。沿用既有版本/内容身份工具，既识别内容替换，也兼容合法反搬导致的元数据变化；未完成事务的两端普通覆盖写及输出改写也要消费统一保护。

### R3 / P2：多任务部分回滚后，精确恢复只找源路径，漏掉已更新到目标的参与者

**大白话：一个目录里有多个视频结果，一部分记录已改、一部分没改；恢复时只处理后一部分，前一部分留下的阻断再也解不开。**

自然过程：

1. 目录 A 包含终态任务 T1、T2 的结果。A→B 后 T1 outputs 已成功发布为 B，T2 写入失败。
2. 文件/归属成功反搬 A；T1 outputs 补偿失败、T2 补偿成功；随后两者均成功保存 `block=A→B`。
3. 核对解除 C 范围保护后，精确重试 A→B。[参与者发现:1520](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1520) 只按当前 outputs 的 A 前缀筛选，选中 T2，漏掉仍指 B 的 T1。
4. C 允许同路径事务的自身阻断并搬完整目录；Q 只清 T2 的 block，1627 行却解除整个意图并返回成功。
5. T1 block 残留。再做 A→B 时所有 outputs 已在 B，1527 行返回零参与者；做 B→C 又被旧 block 拒绝。现有 C 保护核对不会清掉 task block。

恢复集合必须来自**该事务保存的完整参与任务身份 + 当前核验状态**，包含已经指向目标的参与者。锁住并核对所有参与者，正确处理“路径已经对了但 block 尚未解除”的成员；一项未收敛就不能将整个事务宣告完成。不要把全部删除旧 block 当作修复。

上轮单任务且所有定位都在 A、已解除 C 范围保护且无其他占用的反例已修，本条是多任务部分发布/部分补偿的直接剩余。

### R4 / P2：保护状态提示仍在网页和部分错误出口丢失

后端已新增 warning，但还没有完整传给实际使用者：

- 成功 HTTP 响应带 warning；[workspaceFiles.ts:600](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/lib/workspaceFiles.ts:600) 丢弃响应，[assetMenu.vue:82](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/pages/workspace/panels/canvas/components/assetMenu.vue:82) 也只等成功。画布更新后，没有通过本次改名响应向用户呈现“保护仍待核对”等提示。
- 公共事务的 EMISSING 分支已能保留已有 warning，但[工作区改名接口:23](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/routes/workspaces/files/rename.ts:23)、[素材改名接口:23](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/routes/assets/rename.ts:23)、[MCP:188](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mcp/tools.ts:188)、[Agent 宿主:61](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/agent/tools/index.ts:61) 的失败出口未继续透传。
- MCP 成功 warning 已结构化返回，这部分保留。Agent 成功 warning 目前只进服务端日志；ToolFiles.rename 为 Promise<void>，本次未发现内置工具实际消费该 rename 方法，不能写成“模型已收到提示”或“正式 Agent 链路已实测”。

复用既有通知与响应格式，成功时让网页看到“操作已完成，保护状态仍需核对”，失败时保留失败原因和保护状态。保持现有 rename 调用兼容及成功/失败语义。MCP 核对最终模型可见内容，不能只给 Error 添加可能在序列化时丢失的属性。无需重构整个前端。

## 3. 统一收尾规则，避免只修当前例子

执行基线仍为[完整任务书](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/completeRepairExecutionPlan.md)、[第六轮报告](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/sixthIndependentAcceptance.md)及[契约 §O](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/executionContract.md:551)。§O 的实现细节如不能满足已约定的保护/身份要求，应同步修正，不用现有实现反过来降低验收要求。

**固定顺序：持久原意图 → 文件/归属操作 → 全部任务提交或全部补偿 → 核对全部参与者 → 解除本事务保护。**

在原有结构内完成以下规则：

1. **一个事务的收尾由协调层统一负责。**正向与反向都沿用同一持久保护事实，Q 尚未完成全部 outputs 时 C 不自行清意图。意图首写失败则不移动；已开始移动但尚未确认完整提交或完整补偿时，失败必须保留已落盘的原意图；完整提交或完整补偿确认后再清。不要把两个方向同一个 ID 的保护误当作两份独立保护。
2. **原意图不可被重试随意重建。**已有意图先核身份、方向、当前落点及完整参与集合；核对成功才续做。为兼容反搬，需要区分允许的事务内位置变化与外部内容替换，但不要求新增事务框架。
3. **端点保护始终覆盖 source、target 及后代。**普通登记保护可以随文件迁移；事务端点保护不能随移动丢掉源端。让清理、改名、覆盖写、输出改写及显式恢复使用同一判断，搜索所有真实调用方，避免只封一个路由。
4. **显式恢复不能清掉仍活动的事务。**复用已有目录/任务协调，或提供同边界的在途判断；按原任务锁→路径锁顺序处理，不在持路径锁后反向等任务锁。Q 提交/补偿尚在进行时返回可读的忙状态。崩溃后恢复仍须核对原持久事实。
5. **恢复按持久参与集合收敛。**包含源位置、目标位置以及已发布但带旧 block 的成员；逐项核对和清对应阻断。缺任务、身份不符、任一落盘失败均不能当整组完成。没有源路径匹配项不等于没有待恢复事务。
6. **清除结果的文案按实际证据。**当前 fileRecords 1493—1497、1560—1563 在保护文件替换后 fsync 报错时仅恢复内存，磁盘可能已经无意图。此时不能绝对宣称“跨重启保护仍在”。完整提交后的清除异常不单独推导为数据丢失：可以完善持久补偿，或明确显示“清除结果未确认，需要核对”；前面的未完成事务则必须有可靠屏障。
7. **保持已有正确能力。**源已不在但目标有可信原事务依据的认回、其他任务/编辑/祖先保护拒绝、锁内发现、fallback refs 检查、全部可能已发布写入的补偿、-20 六个归属助手，以及其他 17 组均保留。

不新增依赖、框架、测试文件、临时测试程序或 mock；所有新文件/自有名称按仓库小驼峰规范，磁盘操作复用统一入口。路径/方法变化同步所有调用方；若新增/移动路由则运行既有 `bun run routes`，不手改生成文件。

## 4. 并行分工与最小验收

先由 I 与 Q/C 确定“原意图、完整参与集合、在途边界、唯一解除时点”的接口，再并行；不要让两个执行者同时改同一文件。

| 所有者 | 责任与文件所有权 |
| --- | --- |
| Q | R1 反搬/全部 outputs 收尾、R3 完整参与集合、提供完整事务活动协调；`apps/server/src/utils/mediaTasks/` |
| C | R1 双端保护/显式恢复、R2 原意图身份与写保护、清除失败语义；`utils/fileRecords/`、`utils/cleanup/`、相关保护/文件路由 |
| W | R4 网页现有通知及响应消费，仅改必要前端入口；保留此前节点/订阅/编辑租约成果 |
| I | 契约与跨组接线、MCP/Agent/HTTP 错误和 warning 出口、证据校准、检查与既有授权内发布；与 C 明确路由文件独占归属 |

所有执行者共享目录，应保留他人的工作。Q/C 先互审整条提交及补偿链；W/I 核查用户可见结果，不只核某个内部 return 对象。

最小验收矩阵只需要隔离资料，不需要新生成视频：

| 场景 | 应得到的结果 |
| --- | --- |
| 普通 A→B→C、已解除 C 范围保护且无其他占用的单任务精确恢复 | 文件、归属、全部 outputs 一致；结束后无该事务遗留 |
| 正向 C 已完成、Q outputs 未完成 | 两端及后代仍受保护；清理/覆盖写/普通改名不能绕过；显式核对不能提前清除 |
| 反搬已完成、Q outputs 补偿未完成 | 唯一意图仍可靠存在；这时中断/重启也能诊断并保护原事务 |
| 两任务：T1 已发布、T2 失败；反搬后 T1 补偿失败 | 正式精确恢复包含 T1、T2；全部 block/意图正确收敛，之后 B→C 可以正常执行 |
| 原意图存在，A 的内容或身份已改变 | 正式覆盖写受保护；针对历史/外部已有变化，精确恢复明确拒绝误认，且不覆盖旧版本依据 |
| 合法反搬或源不存在、目标确有原事务依据 | 身份核验不会误伤合法续做；保持可信目标认回 |
| 意图首写失败、归属替换后 fsync 失败、补偿/marker 连续失败再重启 | 首写失败不移动；已经移动的失败链保留此前可靠保护，或完整恢复一致；不能靠随后碰巧写 marker 成功 |
| 人工核对与正在提交/补偿交错 | 有活动事务时拒绝解除；无活动且核对完成后才按同一事实清理 |
| 成功仍待核对、失败带保护信息 | 网页实际显示；MCP 最终结果保留；Agent 宿主与真实工具消费边界如实记录 |

必须保存：每步文件位置与版本/内容指纹、原意图及当前阶段、完整参与任务列表、各任务 outputs/block、归属、保护、接口响应、HTTP 状态及命令退出码。

“同源两请求竞争”不等于 A→B / B→C 的发布交错；人工预置一份 block 再恢复，也不能替代自然故障链产生 block 的验证。无法安全构造的 fsync 或窄交错，明确标为源码/互审及未动态覆盖；不得宣称完整故障实测，也不得把尚存的源码反例写成关闭。

按实际改动运行必要类型检查、构建和接口/界面手动验证；不要为补证据新建测试文件、测试专用封装或自动检查入口。**新增真实生成请求预算继续为 0**，不调用上游创建或内置 Agent 推理。隔离验证不得携有效生成凭据单靠 paused 防外发，先决条件不成立即停止该验证链。

确认源码反例关闭后，在原有授权内发布；先重新检查当时的活动任务、设置和资料，沿用维护门、备份、优雅收尾及回退方案。维持 wb 配置、五类清理关闭、原成片与用户资料；不动桌面和其他业务。核对真实镜像 ID、入口、源码及插件指纹、任务分母和原成片，不能把本报告的静态快照当未来状态。

## 5. 执行证据的有效范围与更正

材料仍在 [run3](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3)。

**已经更正的部分应保留：**T02 固定时长说法已改为目标与缩减规则；旧 9 行占位时间改为 null/区间；旧 typecheck 第 12/46 行区分子命令失败；T10 判词和旧 T15 顺序验证范围已有更正。

仍有以下具体问题：

- [commandResults.jsonl](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3/commandResults.jsonl) 当前 **61 行**，上轮 49 行，本轮增加 12 行。第 **50、52** 行再次出现 `10:0x`、`11:1x` 占位时间。
- 第 **51** 行又写“全仓 32 包通过”，同时附 desktop/web 环境失败说明；应列实际子命令结果。第 **1** 行命令是单独的 server typecheck，却被填进全仓及 desktop/web 输出，命令与结果范围不符。不要把一段更正文本批量替换到不对应的历史命令。
- 本轮两份证据文件最后修改均为 **11:25:11**，其中第 **58—61** 行却记 **11:27/11:29/11:35/11:40**；[sixthRound_verification.json:3](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3/sixthRound_verification.json:3) 的总区间到 **11:45**。本轮独立 Docker 取证确认当前容器启动为 **11:24:04**。时间来源必须重新对应，不能将缺乏来源依据的时间直接当作原始日志时间。
- 这属于证据准确性问题，**不能据此推断操作没执行或记录造假**。保存原记录及更正说明，用 Docker、原日志、文件时间等能证明的来源校准；不能还原的留 null/未知及区间。若原时间来自服务器其他时区，保留原值和时区再转换。
- [README.md:12](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3/README.md:12) 的“当前版本”仍为 -20，未纳入本轮文件；更新索引，旧版本验证仍归旧版本。
- validationResults.jsonl 仍 **14 行**，包含旧记录、更正、互审和事件；不是 14 场景全部动态通过。

本轮执行者新增文件记录了 **7 类样本**：顺序连续改名、同源并发竞争、意图首写失败、人工写入持久保护后重启、同构状态精确恢复、不同任务 refs 冲突、已有目标依据认回。**这些是执行者提供的记录，本审计没有独立重放。**

其中“相邻两个场景分别成功”不能等同于移动后 fsync 失败、补偿及多层故障写入连续失败后重启的完整链；“别的任务 refs 冲突”不能等同于 refs 未变但内容替换；同源并发也没有覆盖 B→C 的发布窗口。新增验证应补本文 R1—R4 的真实状态，而非继续重复简单正例。

本轮没有新停机动态样本，原 -19 长作业 SIGTERM 不能重标为 -22 实测。历史那次误生成仍按之前已核实的 completed、未取消、费用/退款未核实保留；本轮没有再次查询该上游 ID。审计自身新增生成 0 与执行者本轮自报 0 分开计数，不写整个返工零费用。

## 6. 可直接交给执行窗口

> 继续 Toonflow 收尾，完整读取 E:\Ai\codex3\Toonflow\Toonflow-app-master\docs\seventhIndependentAcceptance.md。当前 -22 已上线，其他 17 组保留，T15 按本文 R1—R4 一次收口：保护贯穿正反向全部任务提交/补偿且人工核对不得提前清；双端保护固定；恢复先核原意图内容/版本并保护普通覆盖写；按完整持久参与集合恢复多任务；补齐网页与 MCP 的保护状态提示。I 先冻结事务活动边界、参与集合和唯一解除时点，Q/C/W 按本文文件所有权并行，互审后做非收费验证及既有授权内发布核验。同步校准第 5 节时间、命令/输出及场景证据，未测项如实写明，不用相邻样本代替完整故障链。新增真实生成为 0，不调用内置 Agent 推理，不新增测试文件、临时测试程序、mock 或自动检查入口。凭据继续读取 E:\Ai\codex3\Toonflow\toonflowHandoff\deploymentSecrets.json，不重复索要或输出密钥。保留 wb、五类清理关闭、原成片及用户资料，不动桌面和其他业务；已知源码反例未关闭不得称全部完成，无需我逐项转述。
