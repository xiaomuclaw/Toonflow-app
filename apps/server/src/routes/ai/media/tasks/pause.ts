import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { pauseMediaTasks } from "@/utils/mediaTasks";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  // ACT: 必须给出明确范围（taskIds / batchId / batchKey），由服务层统一校验并逐项返回。
  taskIds: z.array(z.string().min(1).max(256)).max(200).optional(),
  batchId: z.string().min(1).max(128).optional(),
  batchKey: z.string().trim().min(16).max(128).optional(),
}), async (req, res) => {
  const { directory, taskIds, batchId, batchKey } = req.body as { directory: string; taskIds?: string[]; batchId?: string; batchKey?: string };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  // 暂停只改跟进标记：主状态不变，上游可能仍在生成；取消请用 /api/ai/media/tasks/cancel。
  res.json(success(await pauseMediaTasks({ directory: cwd, taskIds, batchId, batchKey })));
});
