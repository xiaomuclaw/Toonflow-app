import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { getFileOutputState, getFileRecordsByPath } from "@/utils/fileRecords";

const router = Router();

// ACT: 供任务输出与节点显示“已清理/缺失/可用”；只读归属记录，不刷新 updatedAt（普通预览不续期）。
export default router.get("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const root = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  const requested = req.query.path as string;
  const status = await getFileOutputState(root, requested);
  const records = await getFileRecordsByPath(status.path);
  res.set("Cache-Control", "no-store");
  res.json(success({
    known: records.length > 0,
    state: status.state,
    cleaned: status.state === "cleaned",
    ...(status.cleanedAt ? { cleanedAt: status.cleanedAt } : {}),
    records: records.map(record => ({
      sourceKind: record.sourceKind,
      mediaKind: record.mediaKind,
      updatedAt: record.updatedAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
      ...(record.cleanedAt ? { cleanedAt: record.cleanedAt } : {}),
      ...(record.cleanupIntentAt ? { cleanupIntentAt: record.cleanupIntentAt } : {}),
      refs: record.refs,
    })),
  }));
});
