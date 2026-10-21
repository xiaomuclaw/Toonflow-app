import { Router } from "express";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";

const router = Router();

// ACT: 素材改名与工作区文件同走归属模块统一协调入口（任务锁顺序 → 路径锁内文件操作、归属/定位事务迁移、
// 编辑占用/任务跟进检查、失败回滚与重定位日志，并在同一协调内持久更新受影响任务 outputs 定位）。
export default router.post("/", validateFields({ path: z.string().min(1).max(4096), target: z.string().min(1).max(4096) }), async (req, res) => {
  const root = await u.assets.getAssetsDirectory();
  const source = await u.workspaceFile.resolveWorkspacePath(root, req.body.path);
  const target = await u.workspaceFile.resolveWorkspacePath(root, req.body.target);
  u.workspaceFile.protectWorkspaceRoot(source.directory, source.path);
  u.workspaceFile.protectWorkspaceRoot(target.directory, target.path);
  target.path = resolve(dirname(target.path), basename(resolve(root, req.body.target)));
  const result = await u.cleanup.relocateWorkspacePathWithTasks({ directory: source.directory, source: source.path, target: target.path });
  if (!result.ok) {
    const status = result.code === "EINVALID" ? 400 : result.code === "EMISSING" ? 404
      : result.code === "EBUSY" || result.code === "EOCCUPIED" || result.code === "EEXIST" || result.code === "EIDENTITY" ? 409 : 500;
    // T15/§P.5（第七轮 R4）：失败出口同样不得吞掉保护状态（如「移动未发生但已有意图/保护仍在，需人工核对」）。
    return res.status(status).json(error(result.message, { code: result.code, ...(result.warning ? { warning: result.warning } : {}) }, status));
  }
  res.json(success({
    from: result.from,
    to: result.to,
    migratedRecords: result.migrated,
    taskRefs: result.refs,
    ...(result.updatedTasks?.length ? { updatedTasks: result.updatedTasks, updatedOutputs: result.updatedOutputs ?? 0 } : {}),
    // T15/§O.3：意图清除失败等「已完成但保护仍在」的如实说明，必须透传给调用方（第六轮 C 侧提出）。
    ...(result.warning ? { warning: result.warning } : {}),
  }));
});
