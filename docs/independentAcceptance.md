# Toonflow 二改独立验收

日期：2026-10-08（Asia/Shanghai）。结论：**基础服务已可用，部分二改有效；暂不整体验收通过。**

此报告核对执行交付、当前源码、部署产物及现场行为。不会把执行窗口的“全部完成”直接当作验收结论。用户追加的跨天视频等待设计另见 longRunningVideoPolicy.md；可直接交给执行窗口的返工任务见 deepseekRepairPrompt.md。

本轮只做审查、必要的非付费 HTTP / MCP / 浏览器核验及文档、截图记录。未改产品源码、未重启或重新部署、未新增收费生成、未更改桌面安装、未操作其他服务器业务、未新增测试程序。

## 1. 已独立核实的可用部分

| 项目 | 本轮证据与范围 |
| --- | --- |
| 公网与登录 | https://flow.xmxcode.com 可访问；health 200；未登录读取设置 401；登录成功后 200，Cookie 有 HttpOnly / Secure / SameSite=Lax |
| 两类认证隔离 | MCP Token 不能替代网页 Cookie 读取设置；错误 MCP Token 返回 401，正确 Token 可 initialize，发现 46 个工具 |
| 基础网页 | 实际登录、进入 studio1、打开画布及存储与清理面板；现有文本、图片两个节点正常渲染 |
| 清理面板配置 | 五项全关闭；生成文本 / 图片 / 视频 / 缓存预填 2 天，原始资料 30 天；status / preview 可读取。这不等于五类实际业务都已接通 |
| MCP 单命令 | getCanvas、findCanvasNodes 能经网页返回真实画布信息 |
| 本轮页面连接回收 | 关闭本轮创建的页面后，其 connectionId 从 getAppState 消失。剩余两个连接可能属于其他页面，未将其认定为僵尸 |
| 图生图迁移 | XMX 修复源码已安装，保留 edits multipart；台账有参考输入数量 0 / 1 / 2 的三条成功记录和真实文件。上游实际收到的附件数量/内容本轮未独立复验 |
| 视频产物 | 台账实际有两条不同上游 ID 的成功视频，文件存在；均经 ffprobe 确认为 H264 720×1280、AAC、5.088 秒 |
| 基础持久化 | 受理记录、输入快照、上游 ID、已知 ID 的恢复路径、durable 原子写均已有实现；不能据此推断所有异常恢复都可靠 |
| 本地检查 | apps/server 的 bun run typecheck 通过；apps/web 的 typecheck 未通过，见下方限制 |

本轮没有重新调用收费上游验证图像参考内容，也没有检查上游账单；上述媒体结论来自真实任务记录、输入快照、源码和有效输出文件。

## 2. 当前部署身份与媒体数量

| 项目 | 快照 |
| --- | --- |
| 容器 | toonflow-toonflow-1 |
| 镜像标签 | toonflow:server-20261008-7 |
| 镜像 ID | sha256:2f3ced8c7980f08ef8d4566f3048e6f1d2cf41bc3f1609b46ff6d5d812407ebc |
| BUILD_ID / 认证 | server-20261008-7 / TOONFLOW_AUTH=1 / TOONFLOW_COOKIE_SECURE=1 |
| 监听 | 宿主 127.0.0.1:3930 → 容器 3000，容器 healthy，以 bun 用户运行 |
| 数据 | /opt/toonflow/data → /app/data；.env、settings.json、auth.json 权限均为 0600 |
| 资源快照 | 总内存约 7.7 GiB、可用约 3.5 GiB；可用磁盘约 123 GiB；Toonflow 空闲内存约 197 MiB |
| 调度 / 清理 | paused=false；生成并发 2、下载并发 2；五类清理关闭 |
| 任务 | 5 个批次文件，21 条任务：16 cancelled、5 succeeded，其中图片 3、视频 2；核验时没有 active |

两条视频分别是：

| 记录 | taskId / upstreamId | 文件证据 |
| --- | --- | --- |
| Debug 批次，原报告漏记 | eb7d5249-5e6c-44a5-a22a-5f1cb461070c / video_a10458c9a0 | myProject 下 video13587274-03a5-4843-a1ed-0a1540dce38c.mp4；2,206,448 字节；SHA256 531ddcb9763a8e2a636adc4d1a6943badaa782310ae4b1a8d471a9e87f64b31d |
| V05 | 6efddcaf-8e7a-44ae-a2e0-b6cf9c9ec0de / video_cf44a643ed | studio1 下 video53ec9e26-0b22-40f5-97f3-617c1dd5c4e2.mp4；3,107,025 字节；SHA256 997b0f2592fbe8519cfe02249c14af6f176cc86eb01e784b271a2f949420d01e |

这两条仍在原先“最多 2 条视频”的范围内，但不能再按报告的“已用 1 条、剩余 1 条”安排生成。成功记录不等同于完整扣费账单；本轮未核实所有失败请求的计费。

抽查的 13 个关键源文件与容器中部署源码同哈希；当前安装的 XMX / Dola 供应商也与源码一致。videoGenerationNode 和 mediaGeneration 的安装产物与镜像 build 产物一致。**FFmpeg 插件例外，见 F11。** 没有把少量哈希抽查描述为整个镜像可重复构建证明。

## 3. 阻断整体验收的问题

P1 表示应在本次完整交付验收前修复；P2 表示需要明确处理的可靠性、配置或交付缺口。“源码触发链”表示逻辑可追踪，但本轮未在真实用户数据上触发损失。

### F01 · P1 · MCP 画布命令仍然直接报忙

**现场复现。** 同一已连接画布并行发送两个只读 getCanvas，一个约 1188ms 成功，另一个约 657ms 返回 isError=true：“此页面正在执行另一条控制命令，请等待完成”。

apps/server/src/utils/mcp/control.ts:124-148 仍然在 pending 非空时直接拒绝，没有任务书要求的有界排队。HTTP 200 不能掩盖工具结果里的 isError。

应补按连接的有界 FIFO、取消与队列等待超时，执行前重新核对目标画布。已经受理的后台媒体任务不随控制命令超时取消。此问题针对网页控制；不能扩大为“服务器 submitVideoTasks 也都不能批量受理”。

### F02 · P1 · 查询与下载异常仍可能结束尚未失败的上游任务

**源码触发链。** scheduler.ts:82-92、345-355 将可识别的 HTTP 查询异常累计到阈值后置 failed，包含临时 5xx；473-490 的下载恢复只要补查结果地址出错一次，就可能进入 failed / unknown。

Dola 的 queryMedia 又在 packages/providers/src/media/dolaVideo.ts:179-188 内下载完整文件，未真正交给独立下载槽。其错误没有结构化 status / Retry-After，跨 VM 的 Error 识别也不稳；本轮没有验证“某个 Dola 状态码第几次必定失败”。

应区分上游业务状态、查询受阻和下载受阻；有上游 ID 时持续跟进，临时错误退避，不重新生成。详见长期等待方案。

### F03 · P1 · 重启时先放新任务，已有上游任务可能长期得不到查询

**源码触发链。** scheduler.ts:622-634 优先派 queued，再派恢复的 running，且共用生成槽。大量待提交项会排在已经付费的上游任务前面；重启后实际在途量也不能仅用本地正在运行的函数数量计算。

应先恢复已有 ID / downloading，重建在途额度，再允许新任务提交。查询间隔可以释放本地网络槽，不能释放上游在途额度。

### F04 · P1 · 提交首包丢失与 unknown 的网页恢复不完整

**源码触发链。** packages/nodeScaffold/src/useMediaTask.ts:198-200 把 unknown 调用 finish 清关联；216-219 连续三次空查询也清关联并提示重新生成。281-308 虽保留超时提交键，却在无 taskId 时不能可靠启动查询恢复；attach 的首次 Promise 还会永久缓存。

应按原 batchKey / itemKey 找回任务，保留待核对状态和恢复按钮。不能换新键自动生成，也不能把没有 taskId 的结果包装为 accepted。未知结果重新生成存在重复付费风险，本轮没有制造重复扣费。

### F05 · P1 · 视频任务关联会丢失，也缺少画布维度

**源码触发链。** useMediaTask.ts:81-101 的 localStorage 键只有 directory + nodeId；182-191 在把输出写到节点内存后就清关联。videoGenerationNode/src/index.vue:144-152、288-295 未把完整任务身份随节点可靠保存。

同 ID 节点的不同画布可能串关联；任务完成后画布尚未落盘即刷新，可能找不回输出。应持久关联 directory / canvasId / nodeId / batchKey / itemKey / taskId，画布保存成功后才清临时关联；409 或保存失败保留“完成、待回写”。

### F06 · P1 · 画布首次保存可能覆盖另一个窗口的新内容

**源码触发链。** apps/web/src/pages/workspace/panels/canvas/components/canvasMenu.vue:157 读取时没有保存对应 revision；apps/web/src/pages/workspace/panels/canvas/index.vue:563-591 到第一次保存才读取最新 revision，并用旧窗口内容写入。读取错误还可能被吞并退化为普通覆盖写。

A、B 打开同一旧画布后，A 已保存，B 首次保存仍可能带最新 revision 覆盖 A。应在读取画布内容时同时绑定版本，失败不降级覆盖；冲突保留草稿，不静默重试。

### F07 · P1 · 登录过期处理会丢草稿，任务查询也不会正确转登录恢复

**源码触发链。** apps/web/src/lib/authClient.ts:7-12 在 401 后 800ms reload；只挂默认 Axios，工作区独立客户端和媒体 fetch 未统一。任务轮询会把 401 当普通查询失败，每约三秒重试。

应保留草稿、任务关联和待回写结果，显示重新登录；登录成功只恢复查询，不重放生成。关闭页面只停止观察，不结束服务器任务，这一点当前已符合方向。

### F08 · P1 · 设置 revision 的并发返回窗口仍可能破坏防覆盖

**源码触发链。** apps/server/src/routes/settings/save.ts:41 写入后，42 行 await 模型刷新，44 行再从全局最新设置取 revision。期间另一请求可写入 B，导致 A 收到 B 的 revision，但本地仍保留 A 内容。

apps/web/src/stores/settings.ts:149-160 会继续使用这个版本。后续 A 的旧内容可能被当成基于 B 的合法保存。应在同一保存协调范围内绑定保存内容和返回 revision；不能只验证最简单的“拿旧版本立即再保存得到 409”。

### F09 · P1 · 五类清理的真实业务来源没有完整接通

**源码触发链。** workspaces/files/write.ts:50-54 只有收到 x-toonflow-file-kind 才登记，web/src/lib/workspaceFiles.ts:110-117 没有发送该字段。文本、原始资料、旧同步生图、缓存及改名/复制/删除等入口没有完整归属链。

面板能保存天数、人工带头写一个 original 文件能删除，不代表用户平时产生的五类内容都会自动清理。必须通过正式业务入口登记来源，复用 useWorkspaceFiles；不能按扩展名扫描弥补。

### F10 · P1 · 清理标记、共享引用与删除前复核不完整

**源码触发链。** cleanup/index.ts:299-311 设置 cleanedAt 后立即 removeFileRecord，未保留持久清理标记，也未更新任务输出/节点；fileRecords/index.ts:147-152 同路径覆盖原归属；cleanup:285 删除前没有重新读取全部引用和规则。

有底层读写队列，问题不是“完全没锁”，而是业务版本和占用复核未与删除形成同一协调边界。应保留清理标记、多归属与活跃输入/编辑引用；删除后恢复不能继续挂不存在的成果。

文本路径已有 revision 保护，删除后部分保存会收到 409，不能笼统断言所有文本都会复活。当前清理全关闭，本轮未发现已经发生的用户误删。

### F11 · P1 · FFmpeg 的全局限流声明与源码、安装产物均不一致

**运行文件与源码均有证据。**

- packages/ffmpeg/src/remote.ts:31 的信号量是模块变量；packages/toolScaffold/index.ts:126-127 独立打包工具，服务器另有一份。即使安装最新版，也不能据此保证所有入口共用一个“最多 2 个”的宿主槽；media/provider.ts:364 的原生工厂还有旁路。
- 镜像 /app/build/tools/ffmpeg.tool.js 的 SHA256 为 f7678241cfe6d0b4344a735128ccb75dbd56aa5321d3e2f274e0a21f623a49c2；安装文件 /app/data/tools/ffmpeg.tool.js 为 b385d8a4b4cf46e82bac22829dea00b5d8e353be9e2f4800bb2275235a99a795。
- 直接读取两个文件，build 的远程执行函数含获取/释放容量槽，installed 对应函数没有这段代码。不是仅凭哈希或压缩变量名判定功能差异。没有实际压测其峰值，也未确定差异产生于哪次操作。
- utils/plugins/initialize.ts:10 仅比较组级 BUILD_ID，相同便跳过整组，没有逐文件一致性校验；实际复制不会改写文件内容。

应由宿主唯一入口掌握执行额度，覆盖 HTTP、工具及供应商调用；查明安装差异来源、保留用户定制后更新，发布后逐项核对 build / installed，并使用唯一 BUILD_ID。不要只把另一个模块变量复制进插件，也不以清空数据强迫同步。

### F12 · P1 · 父 Agent 让出槽位后恢复推理未重新获取

**源码触发链。** apps/server/src/agent/tools/subAgent.ts:36-39 的 yielded 置真后不重新获取。父任务等待子任务时让位可以避免死锁，但恢复推理时仍应重新排队获取额度。

现有算法仿真不能证明实际 Agent 嵌套执行峰值不超过 3。应核对整条生命周期，结束、取消和异常只释放真正持有的槽。

## 4. 其余需要处理的缺口

| 编号 | 级别 | 证据与要求 |
| --- | --- | --- |
| F13 | P2 | apps/server/src/index.ts:38-44 固定等 2.5 秒 exit，未等待关键写入 drain；scheduler.ts:715 的启动 timer 未在 stop 清理。补停机协调及恢复就绪语义，不能以日志出现 SIGTERM 当完整证明 |
| F14 | P2 | mediaTasks/index.ts:263、304 并发同键的幂等检查在锁外，进入锁后未逐项重查；并行同参数可能整次 409。要求同键同参稳定返回 existing，混合新项正常追加 |
| F15 | P2 | scheduler.ts:203-207 随机路径先落盘，540-541 才登记输出，中间中断可产生失联重复文件；media/generation.ts:134 的部分 savedPaths 附在异常上但任务层未消费。要求已成功输出可恢复、逐项登记 |
| F16 | P2 | dolaVideo.ts:62-71 未完整校验参考图数量、时长及分辨率，时长静默取近值。参数超能力应提交前说明，不静默修改用户请求 |
| F17 | P2 | xmxImage.ts:60、dolaVideo.ts:82 的下载鉴权仅比较 host，同 host 的 HTTP 也可能附 Key。按 HTTPS、完整 origin 和重定向规则处理。本轮没有发现实际 Key 泄露 |
| F18 | P2 | stores/settings.ts:121-126、143-145、172-180 虽有 settingsConflict / reloadSettings，组件没有重载入口。提示去设置重新加载却无对应操作；补可执行恢复，并保留用户修改 |
| F19 | P2 | 根 compose.yaml 未透传 TOONFLOW_COOKIE_SECURE，文档只让修改 .env 不足以重现。线上实际 Cookie 已是 Secure，问题是部署模板和说明不一致 |
| F20 | P1（关联新增长期需求） | 旧 MCP generateVideo 已说明等待生成完成并返回文件路径，仍走同步；尚未明确不适合批量/跨天及持久任务迁移入口。node:generateVideo 的受理还 await 首次查询。按长期方案完善入口与能力说明，保留旧返回契约 |

## 5. 原交付报告需要更正的证据范围

1. executionProgress.md 的“V01—V12 全部完成”与 executionAcceptance.md 后文承认视频节点完整点击链未完成相矛盾。
2. V03 记载的是 15 项任务（10 + 5）、重传及追加，不能直接折算成任务书要求的 10～20 次提交。还缺首包受理响应丢失后刷新恢复的完整证据。
3. v03_result_20261008.json 保留修前 same_batch=false / 查询为 0；v03b_v04_result_20261008.txt 中 batchKey 可查 16，但某返回 batchId 只查 6，现场历史也存在同 batchKey 的多个批次文件。应保留修前证据并分清历史、修后结果，不将它们全部引用为当前通过。
4. R16 只验证 getCanvas / findCanvasNodes；它们原本就免 flush，不能证明节点状态查询 node:getGenerationStatus 同样无写入。R17 没有覆盖“请求已发出，执行前切换画布”的竞态。
5. V11 人工带来源头构造的原始文件不覆盖五类真实业务；不能据此宣布完整清理功能完成。
6. 当前两条成功视频与报告“视频 1/2、第二条未用”不符。恢复演练更新过任务时间，不要将同一上游 ID 的恢复误计成新生成，也不要漏掉另一个 ID。
7. 仓库外交接目录发现 8 份验收/探针 Python 文件，包括 acceptV01.py、acceptV02.py、acceptV03b.py、acceptV09.py、acceptV11.py、acceptV11b.py、pollV05.py、v03_probe.py，与“未新增测试程序”不符。本轮未执行或删除它们；后续遵守禁止新增的明确约束，不能以挪到仓库外规避。
8. 原先将骨架屏直接归因 IAB 缺少充分证据。本轮现有两个节点正常渲染，未复现骨架屏；也没有凭此证明视频节点整个点击链已通过。
9. 本轮另开 IAB 标签后旧页面 visibilityState 仍为 visible，所以未获得真实后台 hidden 标签证据。普通浏览器后台场景仍待补验；不能把“打开第二标签”直接记成通过。
10. 下载恢复只记录一次 DNS 故障演练，不覆盖 401 / 403 / 429、HTTP 查询失败阈值、补查下载定位失败以及保存中断。临时网络故障能恢复是有效证据，但范围有限。

## 6. 验证限制与证据位置

本地 server typecheck 通过；web typecheck 因 electrobun.config.ts:1 找不到 .hutch/devkit/api/config/ElectrobunConfig 失败。该配置与执行前基线一致，执行报告也记录过环境依赖问题；本轮未将其误判为新功能引入的类型错误，也未写成“全项目 typecheck 通过”。

本轮没有重新构建以覆盖当前构建现场。普通 Edge 的自动化连接受到 unsupported Codex auth method: apikey 限制，因此浏览器核验使用 IAB；没有通过模拟 User-Agent 冒充普通浏览器验收。

本轮证据目录：

E:/Ai/codex3/Toonflow/toonflowHandoff/evidence/independentAudit20261008/

- readOnlyChecks.jsonl：39 条分组记录，包含认证、配置、MCP 并行报忙、源码/供应商哈希、成片信息、连接回收及安装产物差异。由本轮去敏工具输出归档，保留原始观察值。
- canvasCurrent.png：本轮现有画布节点实际渲染。
- cleanupCurrent.png：本轮存储与清理面板。
- 更早的演练记录在交接 evidence 目录。它们是执行窗口证据，不能与本轮独立现场复验混为一类。

## 7. 后续处理顺序

先修任务状态与恢复、MCP/网页保存、清理归属三个关键包，再收口并发和部署产物；按文件所有权并行，共享类型、设置、文件入口和发布集中集成。

先完成非付费复验，不再增加真实视频或图生图。当前需要交付的是修复后的行为及证据，不是扩大压测。不能在修复前开启全盘清理或批量投放付费任务。

目前凭据仍由仓库外 deploymentSecrets.json 提供，无需用户重发。但 serverSettingsImport.customProviders 仍是旧 cline 快照；线上和 languageProviders 已是 wb。执行窗口必须以核对后的当前配置为准，不能盲目导入旧段覆盖新设置。

本报告及长期方案尚未改变线上行为。修复完成后按 deepseekRepairPrompt.md 逐项补证，再重新判断是否整体验收通过。
