# Toonflow 第二轮独立验收

日期：2026-10-08（Asia/Shanghai）。线上收尾快照：15:53。验收对象：执行窗口返工后的 server-20261008-11。

**结论：这轮有实质修复，基础服务和普通 MCP 排队已可用；尚不通过整体验收，跨天视频任务的可靠性仍需返工。**

本报告保留并接续第一轮的 F01—F20，不把已修好的部分重复判失败，也不把源码存在的恢复缺陷归为单纯“尚未测试”。

本轮只审查源码、核对部署文件，执行非收费 HTTP/MCP 查询和浏览器查看，并记录验收文档。未改产品源码、未部署或重启服务、未新建生成任务、未切换调度或清理开关、未改桌面安装。未新增测试文件、临时测试程序或 mock 服务。

## 1. 本轮独立核实的结果

| 项目 | 实际结果与范围 |
| --- | --- |
| 线上身份 | 容器 toonflow-toonflow-1，镜像 toonflow:server-20261008-11，镜像 ID sha256:ff76b89669b4de42e98b498ac7626a8967fd6fdf8af3ce409de91a4757deb45d；running、healthy |
| HTTP 就绪 | /api/health 返回 200，status=ok、schedulerReady=true。这是当前启动后的观察，不证明所有恢复异常分支都正确 |
| 网页认证 | 未登录读设置 401；正确登录 200；Cookie 有 HttpOnly、Secure、SameSite=Lax |
| MCP 认证隔离 | 错误 MCP Token 返回 401；正确 Token 可初始化，发现 48 个工具；MCP Token 不能代替网页登录读取设置 |
| MCP 普通并发 | 对同一个已连接画布同时发两个只读 getCanvas，分别 1344ms、1937ms 成功，没有上一轮的直接报忙；未出现 isError |
| 只读不写画布 | 上述查询前后，画布 SHA256、mtime、文件大小一致。文件 2906 字节，SHA256 fef61c31c9cc4a55c2fb8e39abf3046c18c0166fafe7a8c9ea21f43571e9397e |
| 任务读取 | 已有成功视频经 HTTP 与 MCP 均能读取；MCP 查询 672ms 返回已有输出，没有等待上游重新生成 |
| 网页实际显示 | 本轮独立登录、进入 studio1、打开画布；文本、图片、视频生成节点均能显示；已有视频节点显示 Seedance V2.5，模型菜单对同步供应商标注“同步” |
| 清理面板 | 生成文本、图片、视频、原始资料、缓存五类均显示，天数为 2/2/2/30/2，可填数字；开关全关，预览为 0。未执行删除 |
| 关键源码一致性 | 抽查的 21 个关键源文件，本机与容器内源码 SHA256 全部一致 |
| 插件一致性 | ffmpeg、mediaGeneration、canvas 三个工具，videoGenerationNode、textNode 两个节点，以及 Dola/XMX 两个供应商，已核对本机构建、容器构建与安装文件的一致性。上一轮 FFmpeg 安装文件落后已消除 |
| 公网入口文件 | 公网实际入口 /assets/index-DGvzOLuV.js 与容器同文件一致，SHA256 dcce945df84636bb83eb79873589900431771f7c02849db439879a463a50e8c3 |
| 本地类型检查 | apps/server 的 bun run typecheck 通过。apps/web 未通过：electrobun.config.ts 找不到 .hutch/devkit/api/config/ElectrobunConfig；与执行前基线一致，不能写“全项目检查通过” |
| 页面回收 | 本轮创建的页面关闭后，其 connectionId 已从 MCP 消失。另有一个页面连接仍在，未将其当作僵尸或操作它 |

本机与 Linux 容器的整个 server/web bundle 不是同字节，本轮没有进行可重复构建证明。公网 HTML 还有 Cloudflare 注入脚本，不能直接与原始 HTML 比较整页哈希；上表只陈述已经核对的源码、插件和实际公网入口文件。

## 2. 当前任务与配置

- 13 个批次文件、43 条任务：36 cancelled、2 failed、5 succeeded；无尚未解决的活动或 unknown 任务。
- 成功记录仍为 3 条图片、2 条视频；两条视频的上游 ID 仍是 video_a10458c9a0、video_cf44a643ed。
- 两条 failed 都属于不支持持久异步任务能力的 APIMart 提交，未登记 upstreamId。其中一条已通过正式查询接口核对，见 R11。
- 调度 paused=false；生成额度 2、下载并发 2；waitingReminderHours=24。
- 五类自动清理全部关闭。文本供应商为 wb，4 个模型。
- 本轮没有新发生成请求。任务台账不等同于上游完整账单，未重新检查失败请求的计费。

当前代码已经把单次提交、查询和下载时限与总生成等待分开：提交 90 秒、查询 30 秒、下载 60 秒无数据/单次 15 分钟；总生成等待不设固定结束时限，24 小时只提醒。**这项方向正确，但下面的状态、落盘和恢复缺陷仍可能中断长期跟进，不能据此宣布跨天任务已完整解决。**

目前只有 Dola 提供本轮接入的持久异步能力。其他同步供应商不因此自动获得跨天恢复能力。

## 3. 必须继续处理的关键问题

以下均重新沿当前代码核对。“源码触发链”表示条件成立时存在明确执行路径；本轮没有在真实用户任务上制造停机、误删或重复收费。

### R01 · P1 · 停机可能丢掉已经收到的上游 ID（F13）

定位：[scheduler.ts](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:600)、[启动入口](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/index.ts:38)。

scheduler 第 600—602 行已从供应商返回值取出 upstreamId，第 608 行却可能因 signal.aborted 直接返回，保存 ID 在第 611—621 行。停机的第 1230 行会中断作业。因此，遇到“已收到受理结果、尚未落盘”的窗口，ID 可以被直接丢弃；重启第 1089—1091 行只能转 unknown，不能按这个 ID 自动继续。

10 秒等待作业数量归零没有修复这条分支。此外，停机没有完整等待 HTTP 关闭和最终写队列，也缺少阻止在途 tick/resume 再派新作业的 stopping 状态。

要求：先阻止新受理与新提交，保住已经收到的 ID 等关键落盘，再结束作业并最终排空写队列。独立 MCP listener、清理调度也应纳入所属进程的停止协调。不能把这项仅写成“尚未做 SIGTERM 演练”。

### R02 · P1 · 暂停、恢复和未知结果取消的语义仍不可靠（长期方案）

定位：[任务操作](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:658)、[查询完成处理](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:783)。

1. pause 主要写 paused，没有中止或约束在途查询/下载。查询稍后成功，第 783 行可写回 active；下载第 924—954 行也未检查 paused。用户暂停后，仍可能自动下载并完成。
2. resume 第 786 行允许没有上游 ID 的 queued/preparing 恢复，第 828 行置 active，后续会提交上游。当前工具及冻结契约却承诺“只恢复查询/下载，绝不创建新上游任务”。这是可能触发首次生成，不是已经证明重复提交。
3. cancel 第 583 行把没有 ID 的 unknown 直接置 cancelled，并释放保守在途额度。没有独立的“知情放弃核对”参数，之后也不能再通过 bind/resume 接回原任务；上游此时可能仍在生成。

要求：区分已受理的后台任务、暂停跟进、取消上游、放弃核对；恢复入口不得悄悄扩大语义。在途回调写状态前必须尊重最新操作，不能用旧查询结果覆盖新暂停。

### R03 · P1/P2 · 下载受阻会卡住后续生成，重启会打破退避约束（F03）

定位：[额度计算](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/store.ts:124)、[恢复退避](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:1109)。

“先恢复下载/查询，再放新提交”已经修好。但 occupiesUpstreamSlot 仍把 downloading 算作上游未终结额度。默认额度 2 时，两条已生成成功、但下载受阻或暂停的成片，就能挡住后面全部 queued。冻结契约的生成额度指上游尚未终结，下载另有容量。

运行时已经正确取 Retry-After 与本地退避的较晚时间；恢复第 1111—1113 行却清掉未来 retryAt，pause/resume 也清时间。服务器重启或人工恢复可提前突破上游要求的最早重试时间。

要求：依据已经确认的上游终结事实释放生成额度，保留独立下载和数据保护；已持久化的 Retry-After 下限在重启及暂停/恢复后仍生效。

### R04 · P1 · 供应商变更和人工绑定缺少必要核对（长期方案）

定位：[providerCompatibility](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:232)、[人工绑定](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:734)。

当前兼容判断主要检查 asyncMedia、模型存在，以及两边都声明时的 origin；已保存的 providerRevision 没有参与判断，任务没有账户凭据引用。切换账户、同源下换协议路径、旧记录缺地址等情况，无法据此证明原任务可以安全续查。

bindTasks 只通过本地供应商/模型检查，就在第 749—758 行写入上游 ID，没有验证该上游任务的账户、模型及绑定归属。误绑后已有 ID 又不能再绑定。

要求：落实已冻结的受控兼容与归属核对；无法证明时保持 blocked，保留原任务与输入，不写入原始 Key，也不重新生成。

### R05 · P1 · MCP 正常排队已好，取消路径仍可能继续执行（F01）

定位：[control.ts](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mcp/control.ts:198)、[视频节点](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodes/videoGenerationNode/src/index.vue:557)、[提交 hook](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:454)。

- 单条尚未执行的排队命令可以移出，普通 FIFO 本轮也已实测通过。
- 但整体取消第 223 行逐条 settle，而 settle 第 198 行无条件 dispatchNext；第 225 行才关闭响应。禁用 MCP 或轮换 Token 时，本应一起取消的队列仍会继续发出 call。
- 节点生成只在入口检查 MCP signal，随后没有把它传进 startGeneration/useMediaTask。外层 Promise.race 先返回，不会停止目录解析后的 POST。因此命令在“已进入节点函数、还没提交”的阶段被取消后，仍可能稍后提交。

要求：整体关闭队列先禁止派发；取消信号贯穿提交前的异步步骤。已经受理的后台任务不随控制命令超时取消，这条原契约继续保留。

### R06 · P1 · 成片恢复关联仍可能提前丢失（F04/F05）

定位：[画布保存](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/pages/workspace/panels/canvas/index.vue:585)、[任务关联](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:210)。

原键找回、canvasId 维度、unknown 保留和首次查询异步都已接通。但还存在三条绕过保护的路径：

1. 画布第 585 行先固定待保存文本，再等写入；等待期间视频完成并绑定新输出。旧写请求返回，第 612 行广播保存成功；hook 第 210—217 行只比较目录/文件名就清关联，没有确认这份保存真的包含新结果。之后关页或下一次保存失败，恢复依据就丢失。
2. hook 第 312—315 行处理失败任务的部分输出后立即清关联；第 511—514 行把取消响应里的 succeeded/unknown/failed 也直接清关联。取消与成功碰到一起时，可能尚未取回成片就停止跟踪。
3. -11 新增的同步分支绕过已有绑定保护：unknown 不算 active，用户可以换同步模型再次生成；视频节点第 339 行直接走同步路径，绕过 mediaTask.start 的保护。可能出现两条生成和后到输出互相覆盖。

要求：保存确认必须对应具体结果及保存快照；部分输出、取消竞态、同步/持久路径都统一遵守“有未解决绑定先恢复、成片回写确认后再清关联”。

### R07 · P1 · 冲突重载之后又丢失读取版本（F06）

定位：[画布重载](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/pages/workspace/panels/canvas/components/canvasMenu.vue:234)、[冲突清理](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/pages/workspace/panels/canvas/index.vue:647)。

普通首次打开已保存读时 revision，这是有效修复。但冲突重载先读取磁盘并记住新 revision；第 665—666 行随后 clearCanvasConflict，又在第 647、649 行清掉刚取得的版本。

触发：B 遇到冲突后重载 → A 再次修改并保存 → B 保存自己较旧的内容。第 590—591 行重新读取 A 的最新版本号，可能为 B 的旧内容背书并覆盖 A。

要求：清除冲突提示不等于清除刚读取的内容版本。用两个隔离页面的普通文字修改即可非收费复验。

### R08 · P1 · 自动清理仍有删到正在使用输出的竞态（F10）

定位：[任务结果落盘](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:443)、[清理删除](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:377)。

任务在第 443—452 行释放文件锁后，第 458 行才登记新任务引用。清理第 377—396 行仍可能使用先前取得的归属/占用快照。

具体触发：新任务复用同内容的到期旧文件，文件 stat 没变；清理在新引用登记窗口取到旧判定，之后即使新引用已经补上，也可能按旧判定删除该输出。同步生成也有先放开文件锁、后登记的窗口。

多归属记录和 unknown/blocked/paused 保护已经加入；问题是删除与新占用登记没有形成一个完整的业务协调范围。

要求：复用文件、登记归属/引用、删除前复核必须相互协调。清理继续保持关闭，待这条非收费隔离复验通过后再验收开启条件。

### R09 · P1/P2 · 清理来源、标记和界面回写没有全部接通（F09/F10）

定位：[fileRecords](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/fileRecords/index.ts:272)、[清理判定](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/cleanup/index.ts:245)、[任务摘要](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:152)。

已修好的部分：文本节点、节点素材、附件和同步生成的主要登记入口，多归属、持久 cleanedAt，以及普通终态按较晚时间起算。

仍缺：

- 目录改名/复制只处理精确路径记录，不递归迁移或复制子文件归属。正式文件接口支持目录操作，因此不只是“没测试”。
- /api/cleanup/record 有接口，但没有网页或任务消费者；任务仍原样返回旧输出路径，节点仍可能显示完成、指向已删除文件。不能宣称已显示“已清理”。
- cleanedAt 同时充当删除意图，且第 245 行可绕过保留期限。一次删除失败后，用户即使延长天数，下轮仍可能按旧标记删除。
- 尚缺完整编辑占用登记。已有文本 revision 能挡住部分旧保存，不应扩大成“所有文本一定复活”，也不能替代整条保护链。

缓存目前没有符合定义的登记项时为 0，符合冻结契约，不再把这一点单独列为缺陷。

### R10 · P1 · 内置子 Agent 并发问题没有被排除（F12）

定位：[subAgent.ts](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/agent/tools/subAgent.ts:36)。

第 36—38 行让出父任务的槽位并设 yielded=true；第 42 行创建的是子任务的新槽。第 85—106 行子任务完成后直接返回，父任务继续推理，没有重新取得自己的槽。

可追踪的反例：A/B/C 占满 3 槽，A 委派 G 并让槽；G 完成后把槽交给排队 D，A 随后恢复，此时实际 A/B/C/D 同时执行。只看槽计数的仿真会漏掉 A。

这是 Toonflow 内置子 Agent 的计数问题，不等于外部 Codex 的子 AI 数量限制。执行报告的“有证据排除、未修改”应撤回，修复父任务恢复和异常释放的完整生命周期。

### R11 · P2 · 同步供应商仍被先受理后失败，且提示了不可执行的恢复（F20）

定位：[提交兼容门](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:250)、[resume 终态判定](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:782)。

第 250—253 行在首次提交阶段也要求 asyncMedia=true，使正常同步供应商无法到达第 720 行的同步后台 fallback。HTTP/MCP 的公共受理契约仍包含图片、视频、音频并描述后台执行。

正式查询已看到 APIMart 任务 0bbd67e9-9ba7-4062-9876-ccdc77ea2c43：state=failed，错误文案却要求“人工确认后 resume（任务未提交上游）”；resume 明确拒绝 failed，所以这条提示不可执行。

要求：恢复原先约定的同步后台范围，或在受理前明确拒绝并修正工具/HTTP能力说明。无需因此给其他供应商新做异步适配器；不得继续受理后用无法执行的提示收尾。

## 4. 其余仍需处理的可靠性缺口

| 项目 | 当前缺口、定位与要求 |
| --- | --- |
| F11：全局 FFmpeg 边界 | 官方工具已通过宿主注入，HTTP 与它共用额度；但 [原生工厂](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/ffmpeg/index.ts:26) 仍直接暴露给工具/供应商，不受该槽限制。“低频”不能替代已冻结的唯一执行边界 |
| F11：定制插件保护 | [initialize.ts](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/plugins/initialize.ts:29) 在 BUILD_ID 变化后仍直接覆盖同名内置插件，没有识别或备份用户改写。另名插件能保留，不代表同名定制已保护。当前文件一致性已修，未据此推断这轮实际发生过用户定制丢失 |
| F14：落盘失败下的幂等 | [store.ts](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/store.ts:307) 先把任务发布到内存索引，再等 durable；并发重传可在 index.ts:398—402 锁外返回 existing。若首次落盘失败随后回滚，第二个请求已拿到不存在的 ID。正常同键重传修复成立，故障分支仍未闭合 |
| F15：输出认回 | [scheduler.ts:449](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/scheduler.ts:449) 与同步保存主要按相同长度复用已有文件；第 954 行看到 outputs 中有 SHA 就跳过，也不检查文件存在。必须核真实内容/存在性，不能只信文件名或台账 |
| F16：未支持的输入 | 原先点名的 Dola 图片数量、时长档、比例、720p 已校验。但 [index.ts:285](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/server/src/utils/mediaTasks/index.ts:285) 对未声明的参考类别略过，Dola buildBody 不消费 videos/audios/mode。应拒绝不支持的输入，不能静默忽略；这不等于原 XMX 图生图参考图故障复发 |
| F18：设置重载失败 | 按钮已补，但 [settings.ts:122](E:/Ai/codex3/Toonflow/Toonflow-app-master/apps/web/src/stores/settings.ts:122) 在请求成功前清冲突、置 settingsReady=false，失败不恢复，横幅消失且自动保存停用。保留重试入口和本地修改，成功后再切状态 |
| 长期方案：网页查询聚合 | [useMediaTask.ts:232](E:/Ai/codex3/Toonflow/Toonflow-app-master/packages/nodeScaffold/src/useMediaTask.ts:232) 仍每节点单独定时并每次查一个 taskId。100 个活跃节点会各自以约 3 秒加请求耗时查询；服务器的 200-ID 查询能力尚未在网页聚合使用。它不等于每次都会触发 MCP 超时，但会增加重复网络/页面负载 |
| 本地准备失败分类 | 提交 90 秒计时在 scheduler.ts:701 开始，之后才加载供应商和读取快照；与“本地准备不占预算”的注释不符。快照缺失等确定未发上游的错误可能转 unknown、保守占住额度。应区分本地准备和已可能提交的故障 |
| F04：首包未知后的观察 | hook 第 418—423 行保留键，但没有自动启动恢复查询；提示“稍后继续确认”实际依赖点击继续查询、重新挂载或登录恢复。应让提示与实际行为一致 |

## 5. 第一轮 F01—F20 的本轮状态

“主要修复成立”不等于所有异常场景都已完成端到端验证。

| 原编号 | 第二轮判断 |
| --- | --- |
| F01 | 普通 FIFO 已实测通过；取消边界仍需 R05 |
| F02 | 原先按查询异常次数结束任务的逻辑已移除，Dola 查询/下载分离；完整长期跟进还受 R01—R04 影响 |
| F03 | 恢复优先级已修；生成额度和持久退避见 R03 |
| F04 | 原键找回、unknown 保留、首次查询异步已接通；仍有 R06 和首包未知观察缺口 |
| F05 | 关联维度、待回写标记已有；保存确认和其他清关联分支仍有 R06 |
| F06 | 普通首次保存已修；冲突重载仍有 R07 |
| F07 | 401 统一处理、保留页面、登录后按原键查询的主要源码接线成立；完整恢复竞态未独立实测 |
| F08 | 保存、刷新、返回 revision 的同一串行范围已落实，原点名竞态在源码层关闭；本轮未改真实设置重跑并发写 |
| F09 | 主要业务登记已补；目录操作仍有 R09 |
| F10 | 多归属、持久标记及长期任务保护已有；R08/R09 未闭合 |
| F11 | 安装版本不一致已独立确认修复；原生旁路及同名定制保护仍有缺口 |
| F12 | 未修复；“已排除”不成立，见 R10 |
| F13 | 清启动 timer、增加等待已有；关键 ID 落盘和完整停机未闭合，见 R01 |
| F14 | 正常并发重传/追加的锁内重查已补；持久化失败窗口仍在 |
| F15 | 稳定内容命名和逐项登记已有；真实内容认回、文件缺失和清理竞态未闭合 |
| F16 | 原点名参数校验已补；不支持的参考类别/模式仍需拒绝 |
| F17 | HTTPS + 完整 origin + 逐跳重算授权头已落实，原点名路径在源码层关闭；未新增收费媒体复验 |
| F18 | 已有重载按钮；读取失败后的恢复仍有缺口 |
| F19 | compose 已透传 Secure，线上 Cookie 也实测为 Secure，可关闭原点名问题 |
| F20 | 旧同步工具保留返回结构、节点首次查询异步、模型分流已有；公共后台受理契约和完整长期恢复仍待 R02/R04/R06/R11 |

## 6. 执行报告需要更正的口径

1. F12 不能继续写“有证据排除”。F13 不只是没有做真实演练，而是存在可追踪的丢 ID 分支。
2. F05 的“画布保存成功才清关联”还缺少“保存的正是该结果”这个必要条件；排队/取消截图不能证明成功回写竞态通过。
3. F09/F10 的主要登记与多归属演练是有效进展，但没有覆盖目录迁移、删除并发和页面“已清理”状态。
4. F11 当前 hash MATCH 是有效证据；不能由此推断原生 FFmpeg 旁路及定制插件保护也完成。
5. 执行窗口已记录真实 Edge hidden→visible 样本，但现有记录没有把 hidden 期间的 MCP 发出/完成时间交叉对应。本轮 IAB 仍为 visible；不宣布“后台标签全链路已独立通过”。
6. 报告称画布恢复为原有 2 节点，本轮磁盘和页面实际为 3 节点，包含“诊断视频节点”。本轮没有新建/删除节点。应核对最终清理状态，不能照抄旧的 2 节点结论。
7. 两条已有成功视频均已计入；本轮没有新增收费请求。没有把接口请求次数、任务数量、输出数量混为同一个口径。
8. 交接密钥文件无需重发，但 serverSettingsImport.customProviders 仍是旧 cline 快照，当前线上与 languageProviders 是 wb。后续不能直接导入旧段覆盖当前配置。

## 7. 下一轮可并行的返工划分

沿用现有技术栈、文件入口、状态字段和严格开发规范；不新增框架或测试入口。

| 所有者 | 文件范围与工作 |
| --- | --- |
| Q：任务后端 | mediaTasks/index.ts、scheduler.ts、store.ts、snapshots.ts、media/provider.ts；负责 R01—R04、R11 以及 F14/F15/F16 的任务侧问题 |
| W：网页与 MCP | useMediaTask.ts、视频节点、画布保存/重载、settings Store、mcp/control.ts；负责 R05—R07、F18、网页查询聚合 |
| C：清理与归属 | cleanup、fileRecords、workspace 文件操作；负责 R08/R09 的归属、目录操作、清理标记、删除与占用协议 |
| 主执行窗口集成 | 先冻结共享类型、锁顺序、取消/恢复语义；资源限制、插件升级保护及停机装配由主窗口集中处理。scheduler.ts 的落盘/清理边界只让 Q 修改，C 提供所需接口，避免两组同时改该文件 |

每组必须明确“不独占代码库，不回退其他人的修改”。有依赖的集成和发布顺序执行；不为凑并行让多个 AI 同时改共享状态机。

验证继续按用户允许的小规模范围：不必再投 100 个视频，也无需重复消耗已有两条真实视频额度。优先围绕报告触发条件，在隔离工作区/临时配置目录用产品接口与浏览器手动验证；不写测试文件、临时测试程序或 mock 服务，不在真实任务上制造误删和停机。

应覆盖：响应已回但未落盘时停止、暂停与查询完成竞争、恢复不新建、unknown 取消、下载占用释放、未来 Retry-After 恢复、旧保存确认新结果、冲突重载后再次并发修改、清理与新引用登记、目录改名/复制、幂等首次落盘失败、设置重载失败恢复。

没有实际做的场景继续标“未验证”；不能用重复类型检查或仅统计内部计数的仿真代替业务结果。

## 8. 本轮证据与限制

证据目录：[secondIndependentAudit20261008](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/secondIndependentAudit20261008)。

- [verificationSummary.json](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/secondIndependentAudit20261008/verificationSummary.json)：从本轮实际工具输出转录的结构化汇总，带相关输出块标识；不是原始日志。
- [readOnlyChecks.jsonl](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/secondIndependentAudit20261008/readOnlyChecks.jsonl)：收尾查询直接追加的去敏原始观察值，含身份、台账、配置、健康和本轮页面连接回收。
- [视频节点截图](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/secondIndependentAudit20261008/videoNodeCurrent.png)及同名 txt：本轮页面与模型菜单；没有发生成请求。
- [清理面板截图](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/secondIndependentAudit20261008/cleanupCurrent.png)及同名 txt：五项规则全关、天数和预览。
- [browserSummary.json](E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/secondIndependentAudit20261008/browserSummary.json)：本轮页面、visibility 和操作范围。

本轮没有实际跨几天等待，没有新增收费调用，没有触发生产故障或清理，也没有重新构建覆盖现场。源码问题和现场复现已分别标明。当前无活动任务使线上看起来平稳，不能证明这些只在长任务、并发或中断时触发的分支已正确。

建议执行窗口下一轮只围绕本报告剩余项返工，保留本轮已通过部分。修完后再提供唯一部署身份、逐项结果与原始证据，交回独立验收。

