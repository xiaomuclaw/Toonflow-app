import { lstat, rm } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.delete("/", validateFields({ path: z.string().min(1).max(4096) }), async (req, res) => {
  const root = await u.assets.getAssetsDirectory();
  const { directory, path } = await u.workspaceFile.resolveWorkspacePath(root, req.body.path);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try {
    const info = await lstat(path);
    await rm(path, info.isDirectory() ? { recursive: true } : { force: true });
    // 归属清账覆盖目录后代；登记账本失败必须传播，不能留下指向已删除文件的记录。
    await u.fileRecords.removeFileRecords(path);
  } finally { release(); }
  res.json(success());
});
