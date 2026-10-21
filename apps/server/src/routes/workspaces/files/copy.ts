import { rm } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

// ACT: 目录复制递归登记每个副本（新记录 ID、计时从复制完成起、不照搬原任务/编辑占用身份）；
// 归属落盘在源/目标路径锁内完成，失败回滚本次副本，不吞账本错误成功返回。
export default router.post("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096), target: z.string().min(1).max(4096) }), async (req, res) => {
  const source = await u.workspaceFile.resolveWorkspaceFile(req, req.body.directory, req.body.path);
  const target = await u.workspaceFile.resolveWorkspacePath(source.directory, req.body.target);
  u.workspaceFile.protectWorkspaceRoot(source.directory, source.path);
  u.workspaceFile.protectWorkspaceRoot(target.directory, target.path);
  const release = u.workspaceFile.lockWorkspaceFiles([source.path, target.path]);
  let duplicated = 0;
  try {
    try {
      await u.workspaceFile.copyWorkspaceFile(source.path, target.path);
    } catch (cause) {
      if (!(cause instanceof Error) || (cause as NodeJS.ErrnoException).code !== "ECOPYINCOMPLETE") throw cause;
      return res.status(500).json(error(cause.message, { code: "ECOPYINCOMPLETE", partial: true, target: req.body.target }, 500));
    }
    try {
      const result = await u.fileRecords.duplicateFileRecords(source.path, target.path);
      duplicated = result.duplicated;
    } catch (cause) {
      // 归属复制失败：回滚本次独占创建的副本，账本错误向调用方传播。
      const rollback = await rm(target.path, { recursive: true, force: true }).then(() => true, (rollbackError: unknown) => {
        console.warn(`复制归属登记失败且回滚副本失败：${target.path}`, rollbackError);
        return false;
      });
      return res.status(500).json(error(
        rollback ? `复制完成但归属登记失败，已回滚副本` : "复制完成但归属登记失败，且回滚副本未成功，需人工核对",
        { code: "ERECORDS", rolledBack: rollback, detail: cause instanceof Error ? cause.message.slice(0, 300) : "" },
        500,
      ));
    }
  } finally { release(); }
  res.json(success({ duplicatedRecords: duplicated }));
});
