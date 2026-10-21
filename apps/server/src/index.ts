import { resolve } from "node:path";
import { createApp } from "./app";

const startTime = Date.now();
const realPort = 3000;
// 源码位于 apps/server/src，生产构建位于 build/server，均从文件位置定位根目录。
const fromSource = import.meta.path.endsWith(".ts");
const appDirectory = resolve(import.meta.dirname, fromSource ? "../../.." : "../..");
const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(appDirectory, "data");
const app = await createApp({
  webRoot: resolve(appDirectory, "build/web"),
  dataDirectory,
  toolsRoot: resolve(appDirectory, "build/tools"),
  nodesRoot: resolve(appDirectory, "build/nodes"),
  extRoot: resolve(appDirectory, "build/ext"),
  // ACT: 暂不安装内置团队，随团队打包一同恢复。
  // agentsRoot: resolve(appDirectory, "build/agents"),
  providersRoot: resolve(appDirectory, fromSource ? "packages/providers/src" : "build/providers"),
  skillsRoot: resolve(appDirectory, fromSource ? "packages/skills" : "build/skills"),
  // 发布标识随镜像写入；插件同步按此版本覆盖内置文件并保留用户修改。
  pluginRevision: process.env.TOONFLOW_BUILD_ID,
  auth: process.env.TOONFLOW_AUTH !== "0",
});
const { initializeMcpRuntime } = await import("./utils/mcp/runtime");
const server = app.listen(realPort, async () => {
  await initializeMcpRuntime(app, `http://127.0.0.1:${realPort}`, resolve(appDirectory, fromSource ? "packages/mcp/src/stdio.ts" : "build/mcp/stdio.js"));
  console.log(`[服务启动成功]: http://localhost:${realPort}`);
  console.log(`[启动耗时]: ${(Date.now() - startTime).toFixed(2)}ms`);
});

// ACT: 优雅停机（契约 v4 §A，T02）：单一全局截止贯穿 封门 → 在途 HTTP/MCP → 清理收敛 → 媒体作业与关键落盘
// （含在途受理/协调队列）→ 最终写队列排空。各阶段取“剩余预算”，不各自叠加固定上限；应用总预算 45s，
// 小于 compose stop_grace_period(60s) 并留余量；到截止即退出，未完成情况由 drainOutcome 记录。
const shutdownBudgetMs = 45000;
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  // ACT: 用常驻监听而不是 once——首次信号后监听若被移除，紧随其后的重复信号会按默认动作立即终止进程，
  // 使停机协调来不及收敛（T02 现场：在途请求期间曾出现 exit=143）。shuttingDown 守卫保证只执行一次。
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = Date.now() + shutdownBudgetMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    console.log(`[停机] 收到 ${signal}：封闭受理与派发，总预算 ${Math.round(shutdownBudgetMs / 1000)}s，等待关键落盘…`);
    try {
      process.once("exit", code => console.log(`[停机] 进程退出 code=${code}`));
      process.on("uncaughtException", error => console.error("[停机] 未捕获异常", error));
      process.on("unhandledRejection", reason => console.error("[停机] 未处理的 Promise 拒绝", reason));
    } catch { /* 诊断挂钩失败不影响停机主流程。 */ }
    void (async () => {
      const [{ beginStopping, drainMediaTaskWrites, getSchedulerStatus }, { stopMcpRuntime }, { beginCleanupStopping, stopCleanupScheduler }] = await Promise.all([
        import("./utils/mediaTasks"),
        import("./utils/mcp/runtime"),
        import("./utils/cleanup"),
      ]);
      // 1) 封闭新受理与派发（调度拒绝新作业；清理拒绝新一轮）。
      beginStopping();
      beginCleanupStopping();
      console.log("[停机] 阶段：已封闭受理与派发");
      // T02/契约 §N.4：在同一个 45s 截止内**显式分配**各阶段预算（下列为**目标值**）。
      // 实际值在调用点按当刻剩余反算，可能被压缩；压缩情况由 drainOutcome 的 abortGraceTruncated/abortGraceAvailableMs
      // 如实上报（第六轮验收 §6.1 校准）。最坏阶段上限叠加（HTTP 27s + MCP 2s + 清理含外层 3.5s）时媒体实际约 12.5s，
      // 因此不把 13s/5s 写成硬性保证。
      const ABORT_GRACE_MS = 5000;
      const FINAL_WRITE_RESERVE_MS = 8000;
      const MEDIA_FLOOR_MS = ABORT_GRACE_MS + FINAL_WRITE_RESERVE_MS;
      const MCP_BUDGET_CAP_MS = 2000;
      const CLEANUP_BUDGET_CAP_MS = 2000;
      const STAGE_MARGIN_MS = 1000;
      const httpCap = Math.max(2000, remaining() - (MEDIA_FLOOR_MS + MCP_BUDGET_CAP_MS + CLEANUP_BUDGET_CAP_MS + STAGE_MARGIN_MS));
      console.log(`[停机] 预算分配（目标值；实际按剩余反算并可能压缩，见媒体阶段日志与 drainOutcome）：总 ${Math.round(shutdownBudgetMs / 1000)}s；HTTP≤${httpCap}ms、MCP≤${MCP_BUDGET_CAP_MS}ms、清理≤${CLEANUP_BUDGET_CAP_MS}ms（外层上限 +1500ms）、媒体目标 abort ${ABORT_GRACE_MS}ms + 最终写 ${FINAL_WRITE_RESERVE_MS}ms`);
      // 2) 先置停机门让新 HTTP 请求得到明确 503，再等待已受理的在途请求完成（含其关键落盘与受理持久化）；
      // 最后才真正 close（Bun 的 close 会立即断开在途连接，不能当作请求收尾判断，T02）。
      (app.locals as { toonflowStopping?: boolean }).toonflowStopping = true;
      const httpInflight = (app.locals as { toonflowHttpInflight?: () => number }).toonflowHttpInflight;
      const inflightDeadline = Math.min(deadline, Date.now() + httpCap);
      while (typeof httpInflight === "function" && httpInflight() > 0 && Date.now() < inflightDeadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const pendingHttp = typeof httpInflight === "function" ? httpInflight() : 0;
      server.close();
      console.log(`[停机] 阶段：HTTP 已停止受理（在途请求剩余 ${pendingHttp}）`);
      // 3) 关闭 MCP 派发并停止监听；MCP 阶段同样只为自己的上限占用预算，不得侵入媒体阶段的预留。
      const mcpBudget = Math.min(MCP_BUDGET_CAP_MS, Math.max(500, remaining() - (MEDIA_FLOOR_MS + CLEANUP_BUDGET_CAP_MS)));
      await Promise.race([
        stopMcpRuntime(),
        new Promise<void>(resolve => { const timer = setTimeout(resolve, mcpBudget); timer.unref?.(); }),
      ]).catch((error: unknown) => console.warn("[停机] MCP 收敛失败，继续收敛写队列", error));
      console.log(`[停机] 阶段：MCP 已关闭（预算 ${mcpBudget}ms）`);
      // 清理收敛（含编辑占用 finalize 的持久写）受剩余预算约束，但不得吃掉媒体阶段预留；
      // 外层 race 上限只比内层预算多 1500ms，避免任何单阶段越过全局总预算。
      const cleanupBudget = Math.min(CLEANUP_BUDGET_CAP_MS, Math.max(500, remaining() - MEDIA_FLOOR_MS));
      await Promise.race([
        stopCleanupScheduler(cleanupBudget).catch((error: unknown) => console.warn("[停机] 清理收敛失败，继续收敛写队列", error)),
        new Promise<void>(resolve => { const timer = setTimeout(resolve, cleanupBudget + 1500); timer.unref?.(); }),
      ]);
      console.log(`[停机] 阶段：清理已收敛（预算 ${cleanupBudget}ms）`);
      // 4) 媒体侧：把可兑现的 abort 宽限与最终写预留显式传给 Q（剩余不足时如实缩小，drainOutcome 会记录实际获得的宽限）。
      const mediaRemaining = remaining();
      const abortGraceMs = Math.max(500, Math.min(ABORT_GRACE_MS, mediaRemaining - FINAL_WRITE_RESERVE_MS - STAGE_MARGIN_MS));
      const finalWriteReserveMs = Math.max(1000, Math.min(FINAL_WRITE_RESERVE_MS, mediaRemaining - STAGE_MARGIN_MS));
      console.log(`[停机] 媒体阶段预算：剩余 ${mediaRemaining}ms → abortGrace ${abortGraceMs}ms + 最终写 ${finalWriteReserveMs}ms`);
      await drainMediaTaskWrites({ deadline, abortGraceMs, finalWriteReserveMs });
      // ACT: 停机排空结果写入日志（T02 直接证据）；未排空时如实记录未完成计数。
      const finalStatus = getSchedulerStatus() as { drainOutcome?: unknown; ready?: boolean };
      console.log(`[停机] 排空结果：${JSON.stringify(finalStatus.drainOutcome ?? { completed: null })}`);
      console.log("[停机] 退出");
      process.exit(0);
    })().catch((error: unknown) => {
      console.error("[停机] 收敛失败，保留最后可靠状态并退出", error);
      process.exit(1);
    });
  });
}
