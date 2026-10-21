# Toonflow 第五轮独立验收与收口要求

审计日期：2026-10-09（北京时间）。现场只读核查约 01:04—01:17。审计对象：执行窗口第五轮交付的 server-20261008-16。

**结论：真实发布、基础访问正常，但仍不通过完整验收。第四轮剩余 13 组中，本轮新增关闭 5 组主缺陷；原 T01—T18 合计 10 组主缺陷已从源码关闭，8 组仍有确定的剩余路径。组数不代表线上故障次数；源码关闭不代表所有交错场景已经动态通过。**

新增关闭的是 T09、T10、T12、T16、T17。保留此前已关闭的 T01、T04、T05、T08、T13。继续执行只围绕本报告的 8 组剩余问题及证据更正，不重做已正确修复的功能。

**执行窗口本轮有 1 次未预期真实上游创建，违反“新增收费生成 0”的执行约束。本审计只读查询确认该上游任务已经 completed、有结果地址，并未被取消。此次独立审计自身新增生成请求为 0。费用金额和是否退款未核实。**

本轮未修改产品源码、真实设置或用户画布，未部署、重启或开启清理，未新增测试文件、临时测试程序或 mock 服务。新增内容仅为本报告和独立审计证据；登录、退出审计会话以及读取接口属于本轮实际核查。

- 原任务要求：[completeRepairExecutionPlan.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/completeRepairExecutionPlan.md)。
- 上轮基线：[fourthIndependentAcceptance.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/fourthIndependentAcceptance.md)。
- 本轮执行自报：[executionAcceptance.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/executionAcceptance.md)、[callChainCrossReview2.md](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/callChainCrossReview2.md)。
- 本轮独立证据：[auditSnapshot.json](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/fifthIndependentAudit20261009/auditSnapshot.json)。

## 1. 独立核实的线上事实

| 项目 | 当前结果 |
| --- | --- |
| 公网 | [flow.xmxcode.com](https://flow.xmxcode.com)，MCP 为 /mcp |
| 容器 / 镜像 | toonflow-toonflow-1；toonflow:server-20261008-16 |
| 完整镜像 ID | sha256:a0e851d002ca8427972ec521b075bae9e3d7f79f57febef50ef2442a0bb441d0 |
| BUILD_ID / 启动 | server-20261008-16；2026-10-09 00:06:01 北京时间 |
| 状态 | running / healthy，restartCount=0，stopTimeout=60 |
| 数据 / 端口 | /opt/toonflow/data → /app/data；127.0.0.1:3930 → 3000 |
| 真实入口 | bun build/server/index.js；该运行文件 SHA256 为 07cf2e8f9459e8fc0741c8fc7732b0688be8904204c351a7718d0e91c118acd3 |
| 源码与插件 | 抽核 37 个本机关键源码文件与容器源码，全部同 SHA256；21 个已安装插件与对应 build 文件同 SHA256 |
| 网页入口 | /assets/index-2VZmwJmd.js；公网与容器 SHA256 均为 3c9f5cd33592d95264b7dda5300c17eda6c802d9d6c91e5de5fe6ca8653d4dbe |
| health | schedulerReady/protectionReady/cleanupReady=true；recovering/stopping=false，readiness.ok=true |
| 当前工作 | paused=false；blocked、pausedTracking、generationReservations、generationAdmitted、inflightRequests 均为 0 |
| 生成设置 | 生成/下载并发 2/2，等待提醒 24 小时 |
| 清理设置 | text/image/video/original/cache 全关闭；天数 2/2/2/30/2 |
| 文本供应商 | wb，4 个模型；未被旧交接配置覆盖 |
| 任务分母 | 13 批、43 任务：36 cancelled、2 failed、5 succeeded；2 条有 upstreamId，无活动任务；读取任务文件无错误 |
| 备份 / 隔离实例 | r16 备份目录存在，未演练恢复；docker ps -a 未见残留 Toonflow 隔离容器 |

启动时曾因历史安装缺 protections.json 而按未知状态阻断；执行者随后做了显式恢复。当前 health 保留核对说明，且 readiness.ok=true。不能把这条历史说明误报为“现在仍阻断”，也不能据当前健康断言坏归属条目的分支已安全，见 T03。

| 保留的原有成片 | 大小 | SHA256 |
| --- | --- | --- |
| studio1/assets/generated/video53ec9e26-0b22-40f5-97f3-617c1dd5c4e2.mp4 | 3,107,025 字节 | 997b0f2592fbe8519cfe02249c14af6f176cc86eb01e784b271a2f949420d01e |
| myProject/assets/generated/video13587274-03a5-4843-a1ed-0a1540dce38c.mp4 | 2,206,448 字节 | 531ddcb9763a8e2a636adc4d1a6943badaa782310ae4b1a8d471a9e87f64b31d |

本轮实际 HTTP/MCP：

- 公网首页、当前 JS 入口、正常登录、授权设置读取和清理状态读取均为 200。Cookie 带 HttpOnly、Secure、SameSite=Lax。
- 未登录读设置 401；网页 Cookie 访问 MCP 401；MCP Token 访问网页设置 401。权限隔离保持正常。
- 设置 revision 响应头仍为 17aa1bd8564f71eaf26f34720444c7245eef74ebf34e3b4b2894a3405f569307。
- 用项目实际 @modelcontextprotocol/client 连接公网，initialize + tools/list 约 1,456ms，48 个工具。
- 按当前协议使用 target.directory 和 args.taskIds 查询原任务 6efddcaf-8e7a-44ae-a2e0-b6cf9c9ec0de，约 656ms 成功，succeeded、输出 available、路径和 SHA 正确。
- getAppState 当时 connections=[]；已验证服务端任务查询可以不依赖画布连接，本轮没有独立操作新版网页画布或复现 hidden 控制交错。所有本轮 MCP 会话及单独的网页审计登录均已结束。

实际本机检查：server 的 bun run typecheck 通过，ffmpeg 包的 bun run typecheck 通过；web 检查失败，唯一诊断仍是 electrobun.config.ts 缺 .hutch/devkit/api/config/ElectrobunConfig，属于既有桌面开发依赖缺失。本轮没有重新构建或修改依赖。

审计命令自身的纠正也保留：安装供应商目录被展平，首次按同层路径比较未找到 build 文件，后按实际 media 子目录核实；MCP 初次探针缺 args 包装，下一次只传 args.directory，均按返回的真实协议纠正，最终查询成功。这些不是产品故障。Python 默认 HTTP 客户端对上游收到 403，改用运行容器的 Bun fetch 只读 GET 后取得 200，不把 403 当任务失败。

## 2. 原 T01—T18 的当前状态

| 编号 | 当前判断 | 已关闭主缺陷与本轮剩余范围 |
| --- | --- | --- |
| T01 | 主缺陷源码已修 | unknown 普通重提继续被拦，人工解除仍提示重复费用风险 |
| T02 | 部分修复 | 媒体内部先留收尾时间已修；入口各阶段没有为其兑现足够预算 |
| T03 | 部分修复 | 保护门已接后台；旧同步入口只接半门，坏归属条目仍被当健康 |
| T04 | 主缺陷源码已修 | generate 预约与容量去重保持正常 |
| T05 | 主缺陷源码已修 | 下载返回、保存前及终态合并复查暂停/取消保持正常 |
| T06 | 部分修复 | 文件下载的迟到退避与暂停中止已修；补查询地址分支仍丢下限 |
| T07 | 部分修复 | 身份落盘、当前账户锁和版本复核已修；核验失配后仍可回退原提交身份放行 |
| T08 | 主缺陷源码已修 | 磁盘真实 SHA 认回、已清理不复活保持正常 |
| T09 | 主缺陷源码已修 | 本次条件更新真正生效才许可；旧记录缺字段不再误判未提交 |
| T10 | 主缺陷源码已修 | 取消代次守卫及 POST 前失败撤销已接；动态报告需更正范围 |
| T11 | 部分修复 | 素材根、保存后聚合观察、路径回写已接；同任务陈旧路径及替换结果后的订阅仍有洞 |
| T12 | 主缺陷源码已修 | 草稿同步版本保护已接，GET 在途新输入不再静默被覆盖 |
| T13 | 主缺陷源码已修 | 单节点等待自身查询，整次 5 秒截止保持正常 |
| T14 | 部分修复 | 页面身份、hold 守卫、正常停机释放已改善；租约身份、版本及异常退出仍有空窗 |
| T15 | 部分修复 | 历史路径、正常补偿及释放时间迁移已修；连续改名和发布后失败仍不原子 |
| T16 | 主缺陷源码已修 | 已有安装缺保护表、坏表、marker 失败及移出祖先保护反例已关 |
| T17 | 主缺陷源码已修 | 覆盖写按预期内容/SHA 恢复，正式写入均接线；成功恢复正例尚未动态覆盖 |
| T18 | 部分修复 | 常规真实退出等待和静态取消已修；15 秒兜底仍在未确认退出时放行 |

以下全部剩余反例来自当前源码及正式调用链。没有在生产制造坏表、文件误删、取消竞态、长作业停机或错误改名。

## 3. 剩余 8 组：修复要求与验收条件

### T03 / P1：同步生成漏完整准入；归属表部分损坏仍放行

依据：[同步生成入口](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/media/generation.ts:95)、[正式 HTTP 调用](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/routes/ai/media/generate.ts:18)、[健康快照](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:196)、[归属装载](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:427)、[清理归属计算](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:276)。

1. generateMedia 只检查 fileRecordsStoreHealthSnapshot，随后直接 provider.generate*，未检查任务台账/恢复门或全局 mediaTasks.paused。文件保护正常、任务台账损坏或恢复未完成时，后台队列已阻断，旧 HTTP/Agent/节点同步入口仍可创建上游任务。app.ts 的 HTTP stopping 门已存在，不误报为 HTTP 完全无停机防线；缺的是统一准入与既定暂停语义。
2. 归属表整表解析失败只记降级，部分坏条目直接跳过；健康快照不考虑这类错误。一个物理文件同时有 generated/video（保留 2 天）与 original（关闭清理或保留 30 天）两条归属，若 original 的 refs 损坏成非数组，它被丢弃，清理只看到剩下的 generated 归属，可能删除本应继续保留的原始资料。不能用“坏全表为空，没有候选”证明部分坏表安全。

修复要求：Q/C/I 共用完整的新生成判据，所有真实创建入口都消费；排队受理与发起创建继续分开。归属整表/坏条目/不可解析时间进入可诊断、跨重启保守的未知状态，显式核对前同时阻断自动删除和新生成。不要仅补调用点却继续返回错误的健康结论。

验收：隔离数据覆盖完整任务表故障、恢复未完成、全局暂停、归属单条损坏与时间坏值；分别核 HTTP、Agent、旧节点及后台路径，新创建为零、原文件保留、原因可读；核对恢复后才放行。沿用已有产品入口和允许的内联手动验证，不为此调用付费模型。

### T07 / P1：新绑定身份失配后，仍能用原提交身份放行

依据：[兼容判定](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:180)、[人工绑定保存](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1069)、[契约对应规则](E:/Ai/codex3/Toonflow/Toonflow-app-master/docs/executionContract.md:461)。

当前 verifiedRecovery.identity 全等时直接续查是正确的；但不相等时又走原 submissionIdentity 比较，后者相等仍放行。

反例：原账户 A 提交后 unknown → 切 B，用 B 只读核验并绑定 ID_B → 保存原提交身份 A 与核验身份 B → 再切回 A。当前身份与 B 不同，却与原 A 相同，代码允许用 A 查询 ID_B，绕过重新核验。run3 的失配样本缺完整 submissionIdentity，没有覆盖此回退路径。

修复要求：已有针对当前 upstreamId 的核验依据时，它的身份约束不能被原提交身份替代。失配直接 blocked，重新只读核验；原提交身份保留供审计。同步消除契约“否则比较原提交身份”的歧义。当前账户命名空间锁、核验前固定版本和核验后身份复查均保留。

验收：样本携完整原提交身份，覆盖 A→B 绑定→A，及 Key/API 基址/revision 各自变化；均不得直接用错误身份续查。无真实可绑定上游时，明确源码和隔离样本范围，不创建收费任务凑样本。

### T14 / P1：释放必须同时核身份和版本；异常退出仍可能丢编辑保护

依据：[续租与释放](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/editing.ts:130)、[释放匹配](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/editing.ts:195)、[释放路由](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/routes/cleanup/editing/release.ts:45)、[停机收尾](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/editing.ts:277)、[释放时间写入](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:1676)、[释放表装载](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:705)。

1. 当前有 versions 就只比较版本，否则才比较 leaseId。同一登录、pageId、路径创建租约 A/B，两者首次均 version=1；释放 A 携 leaseId=A 与 versions=[1]，B 也通过版本匹配而被一起释放。这是合法 API 的可达反例，本轮没有声称普通双标签已动态复现。释放路由遇到部分版本缺失，还会丢弃整组版本，退化为只按 leaseId 释放。
2. 服务端版本按现存 entry 加一，过期移除后重新从 1 开始。前端出网 leaseId 在同页面跨 hold 复用，旧 DELETE 若迟到到“旧租约过期移除、新 hold 重开”之后，可能以相同身份和 version=1 命中新占用。新 document 身份、页面碰撞处理和旧 create 的 holdId 守卫确实已修，不能替代这个出网租约生命周期问题。
3. 续租成功只更新内存。正常 finalize 成功写入 max(now, expiresAt) 已修；但写失败也 finally 清空，cleanup 只 warn 后继续退出，释放表写失败恢复旧表且不建立故障。崩溃或全局预算截断也没有机会执行成功收尾。一个已经达到清理期限的旧文件，用户刚打开编辑后发生上述异常；重启 60 秒后清理启动，页面尚未恢复连接，系统仍按旧时间判断，缺少这次解除后应有的完整保留期。
4. releasedAt 只检查是字符串。空字符串或 not-a-date 可以进入健康状态，清理计算遇到 NaN 则忽略，不能保证保留期。

修复要求：

- 新租约释放同时满足 leaseId 与逐路径 version；缺失、错位或部分缺失不得静默降级。只有真正的旧格式记录才走明确的兼容分支。
- 每个 hold 使用不复用的实例身份，或服务端提供跨过期不复用的代次，确保旧释放不能命中新占用。
- 成功确认续租前持久化可恢复的保护下限；可以复用已有批量持久化，不要求每次另造一套存储。恢复时在保护状态可证明之前保持保守，不能只靠退出回调。
- 时间字段必须可解析且有限；失败需进入可诊断、跨重启保留的未知状态。

验收：隔离资料覆盖同 page 不同 lease 同版本、缺失/错位版本、过期后的旧释放、正常停机、异常退出、收尾写失败、非法时间。逐项核文件保护与解除后的完整保留期；API 验证和真实浏览器验证分别列明。不得在用户文件上启用清理来验证。

### T15 / P1：连续改名与发布后失败，仍能让文件和任务定位分离

依据：[影响任务发现](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1370)、[任务输出写入](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1397)、[文件锁释放](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:534)、[无任务回退](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:580)、[原子发布及同步](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/file/src/index.ts:174)、[归属补偿标记](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:1468)、[任务阻断写入](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:1284)、[范围保护失败](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:1211)。

已修的当前 resolvedPath 选择、历史 refs 核对、释放时间迁移、try 前快照和普通多任务补偿继续保留。剩余是三个交界问题：

**连续改名。** 第一次 A→B 已完成文件与归属迁移，路径锁释放，但 Q 尚未发布 outputs=B。第二次 B→C 在任务锁外依据旧 outputs=A 得到 affected=[]，可以进入不持任务锁的 fallback。一个可双成功的精确顺序是：第二次完成空 affected 判定 → 第一次发布 B 并确认 B 存在、成功返回 → 第二次把 B 搬到 C 并成功返回。最终磁盘在 C，持久 task.outputs 仍为 B；以后 B 被新文件复用，当前路径优先判断还可能把新文件当旧输出。若第二次先搬完，第一次也可能报 EMISSING；不把“双成功”写成任何交错都会发生。

**已发布但持久同步失败。** writeAtomic 先替换目标，再 fsync 父目录；后者在 Linux 可以抛错，Promise 拒绝不代表文件没改变。Q 只有 update 成功返回才把当前项放入 rewritten。以唯一受影响任务为例：盘上任务已经 outputs=B，但父目录同步失败，当前项不在补偿列表；反搬文件 B→A 后却宣称全部回滚，重启仍读到任务 B。C 的 recordsWritten 等标记同样在成功返回后才置真，存在相同的漏补偿边界。

**补偿失败没有可靠屏障。** Q 的 relocationBlocked 写失败仅 warn；写成功的字段也未被实际阻断判据消费。C 外层已尝试建立持久范围保护，这点必须保留；但范围保护写失败会撤销内存修改，也不建立故障状态。两条持久写都失败时，返回“受阻”不代表后续操作真的被阻止。

修复要求：

- Q/C 先统一固定锁序与事务边界，将影响任务发现、文件与归属移动、全部 outputs 写入、校验和补偿纳入同一协调范围；避免在输出发布前释放关键路径协调，也避免互相倒序取锁。
- fallback 遇到任务 refs 或未完结迁移事实不能绕过任务协调；不能只修顺序改名。
- 对所有尝试写入的参与项按“可能已经发布”处理，包括当前报错项。使用明确的发布阶段信息，或把这些项全部纳入补偿；不要仅补成功返回的项。
- 无法证明恢复完整时，必须保留实际被消费的运行时阻断，并通过已有持久事务/保护事实保证重启仍保守。持久阻断写不出时先停止相关操作，不能仅打印告警或返回文案。

验收：保留现有顺序 A→B、复用 A→C；另覆盖连续 A→B/B→C、单任务发布后 fsync 失败、多任务中途失败、反搬失败、补偿保护再次失败。核对真实文件、归属表、释放时间、所有任务 outputs 与重启后定位。故障无法在允许条件下安全注入时，明确源码证明及未动态项，不在生产造故障，不新增临时测试程序。

### T06 / P2：补查询视频地址时，仍可能丢迟到的退避下限

依据：[补查询地址错误分支](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1388)、[已修的文件下载分支](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1428)、[暂停中止下载](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:934)、[Dola 查询错误](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/providers/src/media/dolaVideo.ts:202)。

真正的 asset 下载 catch 已在判断 abort 前分类并保存 Retry-After；暂停 downloading 时中止作业也已修。遗漏的是 downloading 重启、链接失效或无 pendingAssets 时，先用原 ID 补查询结果地址的分支：它仍先判断 signal.aborted 返回，再分类异常。暂停恰好中止这个查询、迟到异常带可靠 Retry-After 时，服务端退避下限被丢掉，恢复后可能过早重试。

修复要求：复用已正确的事实合并顺序，先保存可靠退避下限，再处理 abort；保留 paused、取消意图与原因，不能为了记录退避而自动恢复派发。

验收：明确覆盖“没有 pendingAssets，必须先补查询”的分支，不能拿文件下载报错结果替代。本轮没有真实 429 或长时间等待的独立动态证据，继续如实标注。

### T11 / P2：同任务旧路径仍能写回；换结果后观察对象没有同步切换

依据：[查询身份](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:485)、[投递校验](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:1002)、[ACK 的无绑定分支](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:853)、[独立刷新](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:1106)、[视频路径回写](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodes/videoGenerationNode/src/index.vue:167)、[替换结果](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodes/videoGenerationNode/src/index.vue:350)、[MCP 刷新](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodes/videoGenerationNode/src/index.vue:613)、[历史结果选择](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/components/mediaHistory.vue:113)。

1. 聚合 hub 按 ID 查询时，投递只带 queriedTaskId，没有发起时的路径/输出代次。任务 A 的旧路径 P 查询在途，文件改到 Q；MCP 刷新走另一条独立查询先拿到 Q，节点正确回写 Q。随后旧 hub 的 A/P 响应到达，因 taskId 仍相同通过检查，resolveOutputPath 又写回 P，并可被画布深监听保存落盘。现有“不同任务 ID 则丢弃”只能保护 A→B，不能保护同任务 P→Q。
2. 用户通过历史“设为当前结果”或上传替换更换当前结果后，hook 没有监听 savedResult 身份变化来重建订阅。旧订阅 A 继续查询，发现当前为 B 只丢弃，未建立 B 的观察。无 binding 的 ACK 分支直接返回，页级 ACK 刷新也仅刷新旧订阅，不能补上新结果。

修复要求：统一以任务、当前输出路径和操作代次校验投递；换结果或改定位使旧投递失效，并重建当前输出订阅。覆盖独立 refresh 与 hub 之间的交错，不靠提高轮询频率解决。已修的全局 assets HEAD 根、ACK 后页级观察（前台 60 秒/隐藏 300 秒）和 resolvedPath 回写保持。

验收：旧 hub 响应在途 → 同任务改名 → 独立 refresh 先得新路径 → 旧响应到达，最终显示及保存仍是新路径；再经正式历史选择和上传替换，确认观察目标切到新结果。网页行为、API 读取和源码推导分别列明，不拿“换响应内容后得到 notFound”替代旧订阅真实投递。

### T02 / P2：媒体内部预留已修，入口仍可能耗掉其实际宽限

依据：[HTTP 阶段预算](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/index.ts:64)、[后续 MCP 与清理阶段](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/index.ts:72)、[媒体内部预算](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1886)、[实际 abort 截止](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1919)。

Q 已先从自然等待中扣除 abort 宽限及最终写时间，第四轮“自然等待耗尽才 abort”的原问题已修。当前问题在入口交界：总预算 45 秒，HTTP 阶段最多可用约 33 秒，仅预留 12 秒；随后 MCP 可用 1 秒、cleanup 外层可用 2.5 秒，交 Q 时只剩约 8.5 秒。Q 默认还留 8 秒最终写，即便传入 5 秒 abortGrace，真正可用的 abort 宽限也仅约 0.5 秒；剩余不超过 8 秒时可退化到零。这是前段耗到允许上限的条件反例，不是每次停机都会发生。

修复要求：由 I 按同一个截止统一分配各阶段实际预算，明确兑现 Q 的 abort 与最终写预留；不要扩大原 45 秒总预算，也不要只传入一个无法兑现的 grace 数字。保留现有新受理门、在途计数、双信号幂等和 Q 内部提前预留。

验收：隔离且无真实上游创建时，覆盖 HTTP/MCP/cleanup 各占预算、Q 仍有工作需中止的交界；记录各阶段实际开始/结束、真实 abort 等待、最终写和总耗时。不能用空闲进程快速退出证明该边界。

证据归属需更正：run3 将含 abortWaitedMs/finalWriteReserveMs 的记录归为 -14。本轮读取服务器保留的 -14 源码归档，scheduler SHA256 为 499d3ba6fa88cba68fa80638e8c426b705461d90bb7d15c357bf3e1e8c9fd0d3，与第四轮线上指纹相同；源码不含这两个字段。因此该记录不能作为 -16 的动态验收证明。保留原记录并补充真实日志来源/版本，不能只修改版本标签后宣布通过；本报告不推定记录错误的原因。

### T18 / P2：15 秒未确认退出，仍会释放 FFmpeg 名额并触发清理

依据：[等待退出上限](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/commandSlot.ts:75)、[远端失败收尾](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/remote.ts:82)、[浏览器错误交付](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/ffmpeg/src/browser.ts:94)、[处理 Promise](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodes/videoNode/src/videoProcessing.ts:38)、[输出目录清理](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodes/videoNode/src/components/videoActions.vue:370)。

常规错误后等待真实 exit/close、准备阶段无进程立即失败、静态排队取消 onCancel 均已修。剩余限定在等待上限：15 秒没看到退出事件，wait helper 仅告警便 complete；原生包装释放名额，remote 也执行 fail/finish/resolve 后释放。

正式 HTTP 和工具经 executeWorkspaceFfmpeg 到 remote，正式参数允许 options.timeout。当前依赖的超时分支先发 error 再 kill，不能证明进程必定 15 秒内退出。浏览器桥收到 remote 的 error 后会 reject，视频处理的 finally 继而 workspace.remove(outputDirectory, true)。因此在“错误后超过 15 秒仍未退出”这个条件下，系统会放名额并开始删输出，而旧进程可能仍写入。本轮未制造此异常，也未声称用户文件已被删。

修复要求：等待上限只能标记“退出未确认”，不能调用代表已退出的同一完成路径；继续占用名额并保护输出，或明确终止且确认真实退出后才释放。不要仅告警后继续正常清理。原生 error 仍可能立即通知业务，但当前未找到原生调用方据此直接删除输出，不另列未经证实的原生清理缺陷。

验收：覆盖正常结束、15 秒内退出、超限未确认退出、排队取消、静态包装取消；确认名额计数和真实进程一致，输出保护在退出确认前有效。只能做源码审查的异常项如实列出，不新增测试文件或临时进程模拟服务。

## 4. 本轮执行证据的有效范围与更正

证据目录：[run3](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3)。本审计保留原记录，没有替执行窗口改写历史报告。

| 记录 | 能支持什么 | 不能据此宣布什么 |
| --- | --- | --- |
| validationResults.jsonl，14 行 | 各行标明的场景、源码互审、补录及事件 | 不是 14 个独立动态场景全部通过 |
| commandResults.jsonl，26 行 | 部分命令与摘要结果 | 第 4/6/9/14/15 行时间有 x 占位；第 5/7/18 行将 HTTP 状态填 exitCode；不能当作完整原始命令台账 |
| 全仓 typecheck 记录第 12 行 | 正文明确 desktop/web 失败、其他若干包成功 | 外层 exitCode=0 不能证明全仓检查全绿；本轮独立 web 检查也失败 |
| T09 旧格式 submitting | 执行者记录旧记录保守恢复；当前源码双入口已核对 | 不能因此替代其他未知状态和恢复交错验证 |
| T10 前置失败 | 目录 GET 失败时 POST=0、恢复后一次提交及 MCP 不自动丢绑定有记录 | 不等于原网页确认重提与旧 A 取消摘要迟到的完整时序已动态通过 |
| T14 租约 | 无 version、仅 leaseId 组合的隔离释放记录 | 未覆盖同版本不同 lease 且同时传入两种参数、过期复用和异常退出 |
| T15 改名 | 顺序 A→B，复用 A→C 有效 | 不覆盖连续改名窗口、发布后 fsync 失败、补偿屏障再次失败 |
| T17 写恢复 | 旧字节不匹配和文件不存在两个负例有效 | 新字节已发布、登记未完的成功认回正例尚未动态覆盖 |
| T18 FFmpeg | HTTP 排队取消覆盖外层等候路径 | 不能泛化为直接静态包装、error 超限与真实进程退出全部覆盖 |

T10 的文档还需两处精确更正：

- “原 UI 确认→提交 B 的交错已不可达”不符当前源码。cancel 仍会先置 cancelled，videoGenerationNode 仍允许确认 discard 再生成；现在靠取消后的代次守卫保护，是修复有效，并非交互被删除。
- 实际驱动 node:generateVideo 直接进入 startGeneration，没有走网页 requestGeneration 确认。将 X 查询的返回体替换为旧 A 后，hub 按 X 查得 notFound，不等于把原 A 的迟到响应投递给已换绑实例。

截图引用也需修正：t10_dynamic_evidence.json 列出两张，run3 实际只有 t10_after_login.png；t10_isolated_after_login.png 不存在。本轮已查看唯一存在的截图，它显示登录后的项目首页和 studio1 卡片，不是画布交错过程截图。本轮没有独立操作新版真实画布，不能替执行窗口背书其浏览器交错验收。

不用为了填满表格制造收费任务、等待真实数天或污染用户资料。每项明确标成“独立动态核实”“执行者动态记录”“当前源码已核”“尚未验证”，有缺陷则写待修；没有执行的场景保留限制。构建和计数不能替代行为证据。

## 5. 那次误生成的最终核实结果

执行记录：[incident_unintended_upstream.json](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/repairExecution20261008/run3/incident_unintended_upstream.json)。

- 时间：2026-10-08 23:15:47 北京时间。
- 环境：repairValidation5 隔离实例，带生产配置副本。
- 起因：暂停设置保存返回 409（引号/expectedRevision 处理问题），脚本没有在先决条件失败后停止，后续探针实际派发。
- 本地 taskId：4c9e16f6-3ea9-4bde-ba84-265554abb1bd；batchId：13995534-12f4-4fb9-affb-5aabde593253。
- 上游 ID：video_6081f73981；dolaVideo / seedance-v2.0 / 5 秒 / 9:16。
- 执行者只记录了取消意图。当前 [Dola 取消适配器](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/providers/src/media/dolaVideo.ts:236) 明确无上游取消接口并返回 confirmed=false，不能写“已成功取消”。

本轮通过运行容器 Bun fetch 向该 ID 发只读 GET，HTTP 200，status=completed，urlPresent=true。没有再次创建、下载视频或保存结果 URL。原隔离目录及其任务文件已被执行者移除，目前不存在；不能把它们继续列为可现场读取的原始证据。金额和退款未核实。

后续执行的零创建约束必须在隔离环境先落实：禁止携带可用上游密钥并仅靠 paused 开关防外发；需要真实配置做只读核验时，仅做指定 GET，不走提交探针。隔离入口验证使用移除有效生成凭据、阻断外发等可核实措施；任一步先决条件失败立即停该验证链。此处是修正执行方法，不要求增加产品功能或新的测试框架。

本轮审计新增创建为 0，不代表执行窗口整个返工过程为 0。事件台账应保留“误发 1 次、上游已完成、费用未核实”，不要用后续取消意图覆盖事实。

## 6. 一次性收口安排：主窗口 I + Q/W/C 并行

本轮只修上面 8 组剩余问题，保留 10 组主缺陷源码已修的成果。继续使用原任务书的文件所有权；不另开一轮无边界功能扩展，不需要用户逐项转述。

| 负责人 | 本轮具体工作 | 文件边界 |
| --- | --- | --- |
| Q 后台任务 | T06 补查退避、T07 核验身份、T15 发现/outputs/补偿、T02 媒体预算参数、T03 调度准入消费 | apps/server/src/utils/mediaTasks/；涉及其他组文件先给接口要求 |
| W 网页节点 | T11 输出观察和响应代次；T14 每次 hold 的出网身份及版本；更正 T10 动态范围 | packages/nodeScaffold/、对应生成节点、apps/web 前端文件/编辑入口 |
| C 归属清理 | T03 归属健康；T14 持久保护及释放匹配；T15 路径协调、账本和失败屏障 | apps/server/src/utils/fileRecords/、utils/cleanup/、对应后端路由 |
| I 主控集成 | T03 旧同步入口和统一出口；T02 总预算；T18 FFmpeg；共享契约/类型/路由生成、证据和最终发布核验 | media/generation.ts、server/index.ts、utils.ts、FFmpeg 及共享文件、文档/部署 |

并行前先由 I 固定四个接缝，记录到既有 executionContract.md：

1. Q/C/I：统一新创建准入、归属未知的健康和恢复语义。受理排队与实际创建分开。
2. Q/C：改名的固定锁序、发现阶段与发布阶段的协调、可能已发布写入的补偿、真实阻断消费者。
3. W/C：leaseId/version 同时匹配、每次 hold 代次、恢复保护下限与坏时间处理。
4. I/Q：同一 45 秒截止内各阶段的实际预算，包括 abort 和最终写可兑现的预留。

这些接口固定后并行：Q 做 T06/T07，W 做 T11，C 做健康与租约，I 做 FFmpeg 和入口预算。T15 及 T03/T14 接缝由所有者按约定先提供接口再接入；不得由两组同时改同一文件，也不要为形式并行引入锁倒序。子 AI 要知道自己与其他执行者共享仓库，保留他人的改动。

集成与交付顺序：

1. 完成对应实现和所有正式调用方核对，由另一组只读互审：Q 审 C 事务，C 审 W 租约，W 审 Q 摘要/定位，I 审预算、FFmpeg、共享门。
2. 按受影响包执行已有 typecheck/build；路由结构变化后由 I 在 apps/server 执行 bun run routes。原有桌面依赖缺失单列，不伪写全绿。
3. 非收费、隔离资料验证优先覆盖四组 P1；窄竞态或异常无法安全动态覆盖时给出准确源码链和限制。不新增测试文件、临时测试程序、mock 服务或自动检查入口。
4. 汇总 8 组逐条状态、剩余限制、原始命令和证据。已知剩余反例不能仍然存在却宣布全部完成；纯动态覆盖不足与已确认源码缺陷分开。
5. 继续沿用既有 Toonflow 发布授权、备份和回退流程；保留当前 wb 文本模型配置、现存数据、两个原有成片和关闭的清理设置，不能用旧交接副本覆盖当前配置。桌面安装和其他业务不动。
6. 发布后核镜像完整 ID、BUILD_ID、真实入口、关键源码/插件/公网资源指纹、health、HTTP/MCP 权限、现有任务及输出；不发新的真实生成来证明上线。
7. 更新既有 executionProgress.md、executionAcceptance.md 与本轮证据目录，给每条真实时间、版本、cwd、原始 exitCode/HTTP 状态和输出；修订说明保留旧记录，不覆写历史。
8. 最终一次性报告完成项、源码仍待修项、未动态验证项、费用事件。不要每关闭一个小项就让用户在两个窗口中转。

上述只是给执行窗口的下一轮工作要求。本次独立审计没有实施这些修复或发布。

## 7. 可直接交给执行窗口的提示词

> 继续 Toonflow 返工 Goal。完整读取 E:\Ai\codex3\Toonflow\Toonflow-app-master\docs\fifthIndependentAcceptance.md，以其中 T02/T03/T06/T07/T11/T14/T15/T18 的剩余反例和第 6 节为本轮收口范围；同时遵守 completeRepairExecutionPlan.md 的既有约束。主窗口负责 I，Q/W/C 三组按文件所有权并行，先统一准入、改名事务、编辑租约和停机预算四个接缝，再实现、交叉审查、非收费验证及既有授权内的发布核验，一次性交付。保留已经修好的 10 组，不重复重构，不让我逐项传话。更正 run3 的版本/场景/截图证据范围，并把误发上游 video_6081f73981 已 completed、费用未核实写入事件记录；不能写成功取消或全程零费用。新增真实生成请求为 0；隔离探针不得携有效生成凭据只靠 paused 防外发，任何先决条件失败即停止该验证链。禁止新增测试文件、临时测试程序或 mock 服务。凭据仍从 E:\Ai\codex3\Toonflow\toonflowHandoff\deploymentSecrets.json 读取，仅用于已授权用途，保留当前 wb 配置，不改桌面和其他业务。未测项如实注明，已知源码缺陷未关闭不得称全部完成；无需我再次转述或重复发凭据。
