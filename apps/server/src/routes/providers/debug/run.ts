import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error } from "@/lib/responseFormat";
import { getSchedulerStatus } from "@/utils/mediaTasks";

export default Router().post("/", validateFields({
  ...u.providerDebug.providerDebugSchema,
  request: z.record(z.string(), z.json()),
}), async (req, res) => {
  // T03/§N.1（第五轮互审补充）：供应商调试台是**真实创建入口**。响应头一旦 flush 就无法再返回可读错误，
  // 因此准入检查必须在建立流之前完成：全局暂停、台账/恢复未就绪、保护与归属未知时直接 503（不发起任何上游创建）。
  const admission = getSchedulerStatus();
  if (!admission.ready) {
    res.status(503).json(error(`新生成未获准（供应商调试台）：${admission.dispatchBlockReason ?? "任务台账/保护状态未就绪或已全局暂停"}；请先完成恢复核对或取消暂停`, { code: "EBLOCKED" }, 503));
    return;
  }
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  const send = (event: Record<string, unknown>) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); };
  try {
    await u.providerDebug.runProviderSource(req.body.source, req.body.config ?? {}, req.body.request, AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]), send);
    send({ type: "done" });
  } finally {
    res.off("close", close);
    res.end();
  }
});
