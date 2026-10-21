import { lstat, rm, rmdir } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

// ACT: 删除在路径锁内完成真实文件操作与归属清账（含真正后代，a 与 ab 不混）；
// 归属落盘失败不吞：文件已删除时明确报错，记录由下一轮缺失清理兜底。
export default router.delete("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096), recursive: z.boolean().optional() }), async (req, res) => {
  const { directory, path } = await u.workspaceFile.resolveWorkspaceFile(req, req.body.directory, req.body.path);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  let removedRecords = 0;
  try {
    if ((await lstat(path)).isDirectory() && req.body.recursive !== true) await rmdir(path);
    else await rm(path, { recursive: req.body.recursive === true });
    try {
      removedRecords = (await u.fileRecords.removeFileRecords(path)).removed;
    } catch (cause) {
      return res.status(500).json(error("文件已删除，但归属记录清理失败，已保留可恢复线索", {
        code: "ERECORDS", detail: cause instanceof Error ? cause.message.slice(0, 300) : "",
      }, 500));
    }
  } finally { release(); }
  res.json(success({ removedRecords }));
});
