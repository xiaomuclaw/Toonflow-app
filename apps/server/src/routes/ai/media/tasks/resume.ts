import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { resumeMediaTasks } from "@/utils/mediaTasks";

const bindTaskSchema = z.strictObject({
  taskId: z.string().trim().min(1).max(256),
  /** 人工核对过的上游任务 ID；只用于查询/下载已有任务，不会创建新的上游任务。 */
  upstreamId: z.string().trim().min(1).max(512),
});

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  taskIds: z.array(z.string().min(1).max(256)).max(200).optional(),
  batchId: z.string().min(1).max(128).optional(),
  batchKey: z.string().trim().min(16).max(128).optional(),
  // ACT: 仅 resume 接受 bindTasks：给没有上游 ID 的待核对任务绑定人工核对过的上游 ID。
  bindTasks: z.array(bindTaskSchema).max(200).optional(),
}), async (req, res) => {
  const { directory, taskIds, batchId, batchKey, bindTasks } = req.body as {
    directory: string;
    taskIds?: string[];
    batchId?: string;
    batchKey?: string;
    bindTasks?: { taskId: string; upstreamId: string }[];
  };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  // 恢复只查询/下载已有任务：绝不创建新的上游任务；不兼容时保持 blocked，可再次 resume。
  res.json(success(await resumeMediaTasks({ directory: cwd, taskIds, batchId, batchKey, bindTasks })));
});
