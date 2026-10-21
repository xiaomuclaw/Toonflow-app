# 服务器部署 Fork（xiaomuclaw/Toonflow-app）

本仓库是 [HBAI-Ltd/Toonflow-app](https://github.com/HBAI-Ltd/Toonflow-app)（上游）的服务器部署二改版。上游持续更新，本 fork 保留自己的定制并定期合并上游新版本。**任何 AI 窗口接手前先完整读完本文档。**

## 上游与版本锚点

- 上游地址：https://github.com/HBAI-Ltd/Toonflow-app （另有 Gitee/AtomGit 镜像，见上游 README）
- 本 fork：https://github.com/xiaomuclaw/Toonflow-app
- 当前合并基线：上游 **v2.0.7**（commit `30139c9`，2026-10-20）
- 二改起点：上游 commit **`4210cb97`**（"改为供应商可选的媒体处理中间件"，2026-10-08）
- 二改基线提交：`b57c62c`（基线定制）；`6f1f622`（二改完整版）；merge commit `1e347ad`（2.0.7 合并结果）

### 下次上游发新版的更新流程

```bash
# 1) 拿上游新代码
git remote add upstream https://github.com/HBAI-Ltd/Toonflow-app.git   # 首次
git fetch upstream --tags
# 2) 合并（例如升级到 v2.0.8）
git checkout main
git merge v2.0.8          # 或 upstream/main
# 3) 解决冲突时参考下面的"定制清单"，每条都有明确的文件锚点
# 4) bun install && bun run typecheck（或项目对应检查命令）后提交
```

冲突解决总原则：**上游新架构优先，二改语义逐条移植**。二改的语义不是"整文件覆盖"，而是若干个独立功能点（见下），每个功能点在冲突块里找到对应注入位置。

## 定制清单（合并上游时必须保住的语义）

### A. 登录认证（服务器公网部署的入口保护）

- `apps/server/src/utils/auth/`：单账号会话认证（初始化、会话校验、`createAuthGate()`）
- `apps/server/src/routes/auth/{login,logout,status}.ts`：`/api/auth/*`
- `apps/web/src/lib/authClient.ts`：`authFetch`、`attachAuthInterceptor`（全局 axios 401 拦截）、`registerAuthHandling`、`reportUnauthorized`
- `apps/web/src/pages/login/`：登录页
- `apps/web/src/main.ts`：**认证门**——挂载前 `checkAuthentication()`，未登录只渲染 loginPage；`registerAuthHandling()` 在登录后注册全局拦截
- `apps/server/src/app.ts`：`createApp` 增加 `auth` 选项；auth 门必须在 body 解析之前（`app.use("/api", createAuthGate())`）
- `apps/server/src/utils/workspace/index.ts`：`canManageRequest(req)` = 本机客户端或已登录管理员；`routes/agents/get.ts`、`routes/agents/a2a/save.ts`、`routes/agent.ts` 等管理类接口用它替换 `isLocalWorkspaceRequest`
- `apps/server/src/index.ts`：`auth: process.env.TOONFLOW_AUTH !== "0"`（默认开启；`TOONFLOW_AUTH=0` 关闭）

### B. 健康检查

- `apps/server/src/routes/health.ts`：`/api/health`（存活=进程响应；就绪=数据目录可写）。Docker 编排与隧道验收用。

### C. 文件清理 / 保护 / 归属账本（清理保护体系）

- `apps/server/src/utils/cleanup/`：清理调度器、`relocateWorkspacePathWithTasks`（改名统一协调入口：任务锁→路径锁→归属/定位事务迁移→编辑占用检查→失败回滚）、`validateCleanupSettings`
- `apps/server/src/utils/fileRecords/`：文件登记账本（`beginFileRegistrationProtection` 围栏、`findFileRelocationWriteBlock`、`isFileCleanedByCleanup`、`removeFileRecords`、`duplicateFileRecords`）
- `apps/server/src/routes/cleanup/*`：`/api/cleanup/*`（preview/protections/record/status/editing）
- `apps/server/src/routes/settings/save.ts`：保存前 `validateCleanupSettings`；settings 里 `cleanup` 段校验
- 接入点：`routes/assets/save.ts`（经 `u.assets.writeAssetFile`）、`utils/assets/index.ts`（writeAssetFile 清理阻断+登记保护；moveAsset 统一协调；removeAsset 归属清账）、`routes/assets/*` 已收编进 `u.assets.*`
- Web：`apps/web/src/lib/workspaceFiles.ts`（editingClient 租约、`holdEditing`、`queryAvailability`、`queryFileAvailability`）；`stores/settings.ts`；设置面板 `storageCleanup` 面板（`apps/web/src/components/settings/panels/storageCleanup/`）；textNode 可用性徽标与编辑保护（`editingHold`）

### D. 持久媒体任务队列（批量生成核心）

- `apps/server/src/utils/mediaTasks/`：调度器/存储/快照/输出状态（`submitMediaTasks`/`getMediaTasks`/`cancelMediaTasks`/`pauseMediaTasks`/`resumeMediaTasks`/`resolveTaskDirectory`/`getSchedulerStatus`/`initializeMediaTasks`/`drainMediaTaskWrites`/`beginStopping`）
- 注意与上游 `apps/server/src/utils/media/tasks.ts`（内存临时任务）**共存**：`utils.ts` 里 `mediaTasks`（上游）与 `mediaTaskScheduler`（二改）两个名字
- 路由：`/api/ai/media/tasks/{submit,get,pause,resume,cancel,status}`（status 是上游的临时任务查询，其余是持久队列）
- 供应商能力位：`asyncMedia`（`packages/toolScaffold/src/runtime.ts` MediaModel 字段；`utils/media/provider.ts` 解析 `submitMedia`/`queryMedia`）
- 生成管线：`apps/server/src/utils/media/generation.ts`（二改版为主体：准入判据/参考媒体预算 200MB/内容寻址落盘/部分结果登记 savedOutputs；上游的 `getMediaPrice` 估价已并入）
- `apps/server/src/routes/providers/debug/run.ts`：调试台流之前 `getSchedulerStatus()` 准入检查（503）
- `packages/nodeScaffold/src/useMediaTask.ts` + `runtime.ts` 导出 + `package.json` 的 `./showNodeError` 等子路径导出
- `packages/ffmpeg/src/{slot,commandSlot}.ts`：FFmpeg 命令槽并发
- Web 节点：videoGenerationNode（taskStatus/待写回/继续查询 UI）、agent 工具上下文 `media: MediaContext & MediaTasksContext`（`agent/tools/index.ts`）
- settings 校验：`mediaTasks.waitingReminderHours` 0–720

### E. 私有媒体供应商

- `packages/providers/src/media/dolaVideo.ts`：Dola2API 网关（Seedance v2.0: 5/10/15s；v2.5: 10/30s；9:16/16:9/1:1；720p）
- `packages/providers/src/media/xmxImage.ts`：私有图片供应商
- `packages/providers/package.json` exports 追加两项
- `apps/server/src/app.ts` `autoInstallProviders` 数组包含 `"xmxImage.ts", "dolaVideo.ts"`
- `provider.ts` 解析器允许 `apiUrl` 顶层 const 引用并作为只读元数据透出（内容寻址下载鉴权用）
- **服务器容器内还有一份手工覆盖**：`providers/dolaVideo.ts` 曾按 2.0 时长档位手改（服务器 `/root/dolaVideo.ts.bak-2026-10-15` 有备份）。升级后以仓库版为准核对容器内文件

### F. 停机协调（优雅停机）

- `apps/server/src/app.ts`：停机门中间件（`toonflowStopping` → 503；`httpInflight` 在途计数；SSE writeHead 拦截提前放行）
- `apps/server/src/index.ts`：SIGTERM/SIGINT → 45s 总预算分阶段（HTTP→MCP→清理→媒体排空），`drainOutcome` 日志
- `apps/server/src/utils/mcp/runtime.ts`：`stopMcpRuntime()`（mark closing → close server → settle 队列 → 断控制连接）
- `compose.yaml` 的 `stop_grace_period` 与预算匹配

### G. 其他小语义

- `apps/server/src/utils/mcp/control.ts`：连接命令 FIFO（容量 8/等待 120s/执行 120s）；`transcribeAudio` 免执行超时；`allowedHost` 用上游 `isMobileLinkRequest`/`getRuntimePlatform`
- `apps/server/src/utils/mcp/tools.ts`：`createControlCanvas`（R16/R17 readOnly + expectedCanvasId 透传）；workspaceFiles rename 走 `relocateWorkspacePathWithTasks`
- `apps/web/src/pages/workspace/panels/canvas/useCanvasTools.ts`：`isReadOnlyCall`/`saveAfterCall`（任务受理与保存失败分离反馈）/expectedCanvasId 复核
- `apps/web/src/stores/settings.ts`：`revision`/`settingsConflict`/`reloadSettings`/`expectedRevision` 乐观锁/草稿版本保护
- `apps/web/src/main.ts`：登录门（见 A）
- textNode：`truncated`（stopReason=length）/可用性徽标/编辑保护
- `apps/server/src/agent/mentionFiles.ts`：画布识别快速路径 + 2MB 预算兜底完整解析（R26）——**保留上游的递归 folders 扫描**（二改原版只扫根目录，合并时已取上游递归+二改快速路径）
- `apps/web/src/pages/workspace/panels/document/components/fileTree.vue`：可用性徽标（queryFileAvailability）
- `apps/server/src/index.ts`：`TOONFLOW_SERVER_PORT` 环境变量（1–65535 校验）

## 已知取舍（合并时的降级决定，接手 AI 不要"修复"它们，先读这里）

1. **videoGenerationNode 以二改版为主体**：上游 2.0.5+ 新增的 `mediaPrice` 估价显示、逐帧拉片入口（`createFrameAnalysis`）、部分媒体历史增强在该节点 UI 中**未合并**（服务端 API 与其他节点不受影响）。下次上游更新若该文件仍冲突，继续以二改版为骨架评估。
2. **conversation.vue 采用上游版**：二改在该文件只有无语义差异（重排/缩进），无损失。
3. **canvasMenu.vue 采用上游版**：上游把画布读取移到 `canvasFiles.ts` 且用 saveRevision 计数器；二改的 readTextSnapshot 版本锚定在该架构下无挂载点，401 处理由 `authClient` 全局拦截器覆盖。
4. **nodeScaffold/src/components/**：二改从 nodeShared 搬来的组件副本保留在仓库里（`package.json` 有对应子路径导出），与上游 nodeShared 并存；`videoGenerationNode` 用 scaffold 副本，`textNode` 用 nodeShared。两套并存是刻意的，不要擅自统一。
5. `providers/types.d.ts`、`media/provider.ts` 的 `supportsPrice/supportsBalance/icon/rules` 是上游 2.0.4+ 的能力，已并入合并结果。

## 部署要点（改配置时看）

- 服务器：152.53.170.228，Docker 容器 `toonflow-toonflow-1`，数据 `/opt/toonflow/data`，域名 `flow.xmxcode.com`（MCP: `/mcp`）
- 环境变量：`TOONFLOW_AUTH`（默认开）、`TOONFLOW_SERVER_PORT`、`TOONFLOW_BUILD_ID`（插件同步 revision）、`TOONFLOW_DATA_DIR`
- 本地构建目录布局：`build/{web,tools,nodes,ext,providers,skills}`；源码运行时 providers/skills 直接指向 `packages/`
- MCP 部署模式：`initializeMcpRuntime(app, ..., auth)` 之外还有独立端口监听（127.0.0.1:10588 起，最多 +31），远程必须 HTTPS

## AI 接手注意事项

- 先读本文档，再看 `git log --graph` 理解分叉结构；不要 rebase 重写已发布的历史
- 合并上游后跑类型检查（`bun run typecheck` 或等价命令）并抽查上面 A–G 每条的关键文件是否还在
- 二改代码里的中文注释带契约编号（如 R16/F06/T12/§P.3），这些是历史验收体系的引用，保留原样，不要删除或"规范化"
- `deploymentSecrets.json`/`toonflowHandoff/` 在仓库外（本地 `E:/Ai/codex3/Toonflow/toonflowHandoff`），不进 git
