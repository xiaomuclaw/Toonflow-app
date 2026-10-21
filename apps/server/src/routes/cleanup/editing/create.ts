import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import {
  editingOccupancyGraceMs, editingOccupancyRenewIntervalMs, renewEditingOccupancies,
} from "@/utils/fileRecords/editing";
import { editingPageIdOf, requireEditingLoginDigest, resolveEditingPaths } from "@/utils/fileRecords/editingIdentity";

const router = Router();

// ACT: 编辑器打开/周期性续租（约每 30 秒）；body { directory, paths, pageId?, leaseId?, versions? }。
// 只延长传入路径，hidden 不主动释放，断联 5 分钟宽限后失效；持同一路径锁提交，
// 清理删除持同一锁，续租成功就不会与 unlink 交错。versions 为与 paths 对齐的期望版本（可选）。
// T14：leaseId 是每次租约实例身份（前端进入编辑时生成并持续携带；服务端回显）；同 pageId 的复制标签
// 用不同 leaseId 各自独立记账，晚到的释放不会删掉另一个实例的租约；缺省为旧客户端 legacy 占用。
// T14/N.3：确认续租前先在服务端持久化「保护下限 + 版本代次」（persistEditingRenewal）——
// 异常退出/崩溃后重启的清理按该持久下限重算完整保留期；持久化失败本次续租不确认（503，不静默假成功）。
export default router.post("/", validateFields({
  directory: z.string().min(1).max(4096),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(256),
  pageId: z.string().min(1).max(128).optional(),
  leaseId: z.string().min(1).max(128).optional(),
  versions: z.array(z.number().int().nonnegative()).max(256).optional(),
}, "body"), async (req, res) => {
  const loginDigest = requireEditingLoginDigest(req);
  const pageId = editingPageIdOf(req.body.pageId);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const paths = await resolveEditingPaths(directory, req.body.paths);
  const versions = Array.isArray(req.body.versions) ? req.body.versions as number[] : undefined;
  const release = u.workspaceFile.lockWorkspaceFiles(paths);
  let result: Awaited<ReturnType<typeof renewEditingOccupancies>>;
  try {
    result = await renewEditingOccupancies({
      loginDigest, pageId, directory, paths,
      ...(versions ? { versions } : {}),
      ...(req.body.leaseId ? { leaseId: req.body.leaseId as string } : {}),
    });
  } finally {
    release();
  }
  res.set("Cache-Control", "no-store").json(success({
    renewAfterMs: editingOccupancyRenewIntervalMs,
    graceMs: editingOccupancyGraceMs,
    expiresAt: result.expiresAt,
    items: result.items,
  }));
});
