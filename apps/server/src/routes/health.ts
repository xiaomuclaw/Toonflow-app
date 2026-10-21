import { Router } from "express";
import { access, constants } from "@toonflow/file";
import { dirname } from "node:path";
import { error, success } from "@/lib/responseFormat";
import conf from "@/utils/conf";
import { isCleanupReady } from "@/utils/cleanup";
import { fileRecordsReadinessSnapshot } from "@/utils/fileRecords";
import { getSchedulerStatus } from "@/utils/mediaTasks";

// ACT: 存活/就绪最小检查：进程可响应即存活；数据目录可写视为就绪（容器编排与隧道验收使用）。
export default Router().get("/", async (_req, res) => {
  try {
    await access(dirname(conf.path), constants.W_OK);
  } catch {
    res.status(503).json(error("数据目录不可写", null, 503));
    return;
  }
  // ACT: 存活与就绪分开表达：目录可写即存活；调度器恢复完成（ready）才是业务就绪。
  // 恢复失败不是 503：容器存活不变，用 ready=false + dispatchBlockReason/recoveryErrors 暴露可诊断原因（契约 v3 §A.4、v4 §B/T03）。
  const scheduler = getSchedulerStatus();
  const recoveryErrors = Array.isArray(scheduler.recoveryErrors) ? scheduler.recoveryErrors : [];
  // T03：保护/归属就绪与「为什么不派发」必须在健康摘要里可读；isCleanupReady 同时触发归属存储的加载重试
  // （清理与本判据共用同一份 C 侧状态，不在这里复制第二套判定）。
  const cleanupReady = isCleanupReady();
  // T03/T16：归属与保护存储的细分状态（首次空安装 vs 曾初始化后缺失/坏表 vs 释放表故障）单独透出，便于诊断“为什么不派发/不清理”。
  const readiness = fileRecordsReadinessSnapshot();
  res.json(success({
    status: "ok",
    // I 集成：schedulerReady 保持「恢复完成、可承接派发」的旧语义（不含用户暂停）；统一新创建门单独用 creationReady 暴露。
    schedulerReady: scheduler.recoveryReady === undefined ? scheduler.ready : scheduler.recoveryReady,
    creationReady: scheduler.ready,
    recovering: scheduler.recovering ?? false,
    stopping: scheduler.stopping ?? false,
    paused: scheduler.paused === true,
    blocked: scheduler.blockedCount ?? 0,
    pausedTracking: scheduler.pausedTrackingCount ?? 0,
    // T03 新增（向后兼容：只增加字段）：保护就绪、清理就绪与派发门关闭原因。
    protectionReady: scheduler.protectionReady === true,
    ...(scheduler.protectionReason ? { protectionReason: scheduler.protectionReason } : {}),
    cleanupReady,
    readiness,
    ...(scheduler.dispatchBlockReason ? { dispatchBlockReason: scheduler.dispatchBlockReason } : {}),
    ...(scheduler.generationReservations === undefined ? {} : { generationReservations: scheduler.generationReservations }),
    ...(scheduler.generationAdmitted === undefined ? {} : { generationAdmitted: scheduler.generationAdmitted }),
    ...(scheduler.inflightRequests === undefined ? {} : { inflightRequests: scheduler.inflightRequests }),
    ...(recoveryErrors.length ? { recoveryErrors: recoveryErrors.slice(0, 5) } : {}),
    ...(scheduler.storageWarnings?.length ? { storageWarnings: scheduler.storageWarnings.slice(0, 5) } : {}),
    // §O.3（T15）：未完成改名事务（含终态任务）的只读诊断；存在时不得把任务当作「迁移成功」，
    // 恢复方式（精确重试同一条 source→target 或人工核对）与阻断来源随摘要透出。
    ...(scheduler.unfinishedRelocations?.length ? { unfinishedRelocations: scheduler.unfinishedRelocations } : {}),
    ...(scheduler.drainOutcome ? { drainOutcome: scheduler.drainOutcome } : {}),
  }));
});
