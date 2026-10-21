import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { listEditingOccupancies, releaseEditingOccupancies } from "@/utils/fileRecords/editing";
import { editingPageIdOf, requireEditingLoginDigest, resolveEditingPaths } from "@/utils/fileRecords/editingIdentity";

const router = Router();

// ACT: 关闭编辑器主动释放；body { directory, paths?, pageId?, leaseId?, versions? }。
// 只释放属于当前登录身份 + 当前 pageId 的占用；paths 缺省释放该页面在本目录的占用。
// T14 身份校验（N.3）：新代次释放必须**同时**提供 leaseId（本次 hold 实例）与逐路径 versions；
// 任一缺失、错位或部分缺失都按「不匹配」处理并逐项返回可读原因，不退化为只按 leaseId 释放
// （此前把整组 versions 丢弃的行为已废除）。只有不带任何身份的旧客户端才走 legacy 兼容分支
// （只释放无 leaseId 的旧租约）——不带完整身份的迟到 DELETE 不得删掉后来建立的新租约。
// 逐路径持锁释放（拿不到锁的计入 deferred，保护保留到过期）；释放时间先持久写 fileRecords 侧。
export default router.delete("/", validateFields({
  directory: z.string().min(1).max(4096),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(256).optional(),
  pageId: z.string().min(1).max(128).optional(),
  leaseId: z.string().min(1).max(128).optional(),
  versions: z.array(z.number().int().nonnegative()).max(256).optional(),
}, "body"), async (req, res) => {
  const loginDigest = requireEditingLoginDigest(req);
  const pageId = editingPageIdOf(req.body.pageId);
  const directory = await u.workspace.resolveWorkspace(req, req.body.directory);
  const leaseId = typeof req.body.leaseId === "string" ? req.body.leaseId : undefined;
  const requestedPaths = req.body.paths === undefined ? undefined : await resolveEditingPaths(directory, req.body.paths);
  const requestedVersions = Array.isArray(req.body.versions) ? req.body.versions as number[] : undefined;
  // 缺省释放按占用列表去重（同路径可能有多个租约实例，逐路径锁不能重复取同一路径）。
  const listedPaths = requestedPaths ?? [...new Set(listEditingOccupancies({ loginDigest, pageId, directory, ...(leaseId ? { leaseId } : {}) }).map(entry => entry.path))];
  const requested = listedPaths.map((path, index) => ({ path, version: requestedVersions?.[index] }));
  const claimed: { path: string; version?: number }[] = [];
  const deferred: string[] = [];
  const releases: (() => void)[] = [];
  try {
    for (const item of requested) {
      try {
        releases.push(u.workspaceFile.lockWorkspaceFiles([item.path]));
        claimed.push(item);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EBUSY") deferred.push(item.path);
        else throw error;
      }
    }
    // 版本按 claim 后的路径逐位保留（不做 any-missing 时整组丢弃的降级）；客户端未带 versions 时不传该字段。
    const claimedVersions = requestedVersions === undefined ? undefined : claimed.map(item => item.version);
    const result = claimed.length
      ? await releaseEditingOccupancies({
        loginDigest, pageId, directory,
        paths: claimed.map(item => item.path),
        ...(claimedVersions ? { versions: claimedVersions } : {}),
        ...(leaseId ? { leaseId } : {}),
      })
      : { released: 0, skipped: [] as { path: string; reason: string }[] };
    res.set("Cache-Control", "no-store").json(success({ released: result.released, skipped: result.skipped, deferred }));
  } finally {
    for (const release of releases) release();
  }
});
