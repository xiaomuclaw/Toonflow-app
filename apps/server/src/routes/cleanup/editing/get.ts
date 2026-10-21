import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import {
  editingOccupancyGraceMs, editingOccupancyRenewIntervalMs, listEditingOccupancies,
} from "@/utils/fileRecords/editing";
import { requireEditingLoginDigest } from "@/utils/fileRecords/editingIdentity";

const router = Router();

// ACT: 查询当前登录身份在本目录的编辑占用（诊断/验收核对用），不续期。
// 传 pageId 时只看该页面；传 leaseId 时只看该租约实例（T14）；缺省列出该登录在本目录的全部占用。
export default router.get("/", validateFields({
  directory: z.string().min(1).max(4096),
  pageId: z.string().min(1).max(128).optional(),
  leaseId: z.string().min(1).max(128).optional(),
}, "query"), async (req, res) => {
  const loginDigest = requireEditingLoginDigest(req);
  const directory = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  const pageId = typeof req.query.pageId === "string" && req.query.pageId ? req.query.pageId : undefined;
  const leaseId = typeof req.query.leaseId === "string" && req.query.leaseId ? req.query.leaseId : undefined;
  res.set("Cache-Control", "no-store").json(success({
    renewAfterMs: editingOccupancyRenewIntervalMs,
    graceMs: editingOccupancyGraceMs,
    entries: listEditingOccupancies({ loginDigest, directory, ...(pageId ? { pageId } : {}), ...(leaseId ? { leaseId } : {}) }),
  }));
});
