import { Router } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { beginFileRegistrationProtection, findFileRelocationWriteBlock, isFileCleanedByCleanup } from "@/utils/fileRecords";

const router = Router();

export default router.put("/", validateFields({ path: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  if (!req.is("application/octet-stream") || (req.body !== undefined && !Buffer.isBuffer(req.body))) {
    throw Object.assign(new Error("请发送文件原始内容"), { status: 400 });
  }
  const root = await u.assets.getAssetsDirectory();
  const { directory, path } = await u.workspaceFile.resolveWorkspacePath(root, req.query.path as string);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try {
    // ACT: 已清理资产不能被上传静默复活（清理记录阻断）。
    if (await isFileCleanedByCleanup(path)) {
      throw Object.assign(new Error("文件已被自动清理，未覆盖磁盘内容；请使用新文件名重新上传"), { status: 409, code: "ECLEANED" });
    }
    // §P.3（R2）：素材保存与工作区写入同口径——未完成改名事务的两端（含后代）在写入前消费统一保护判定，
    // 命中即拒绝并给出事务身份、两端与恢复路径（不先写后看）。
    const relocationBlock = await findFileRelocationWriteBlock(path);
    if (relocationBlock) {
      throw Object.assign(new Error(relocationBlock.message), { status: 409, code: "ERELOCATING" });
    }
    // ACT: 资产上传登记为原始资料；先建立持久登记保护（围栏），登记失败保留围栏并传播给调用方。
    // T17：同时记录本次上传内容身份（大小 + SHA256），覆盖已有旧文件时恢复可区分“旧内容 / 本次已完成内容”。
    const body = req.body ?? Buffer.alloc(0);
    const guard = await beginFileRegistrationProtection(
      { path, directory, sourceKind: "original", mediaKind: "unknown", refs: [] },
      { expectedContent: { size: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") } },
    );
    let written = false;
    try {
      await u.workspaceFile.writeWorkspaceFile(path, body, true);
      written = true;
      await guard.complete();
    } catch (error) {
      if (!written) await guard.abort().catch(() => undefined);
      throw error;
    }
  }
  finally { release(); }
  res.json(success());
});
