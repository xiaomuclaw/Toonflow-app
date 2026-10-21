import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { cancelMediaTasks } from "@/utils/mediaTasks";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  // ACT: 必须给出明确范围（taskIds 或 batchId），由服务层统一校验并逐项返回。
  taskIds: z.array(z.string().min(1).max(256)).max(200).optional(),
  batchId: z.string().min(1).max(128).optional(),
  batchKey: z.string().trim().min(16).max(128).optional(),
  /**
   * 知情放弃核对（默认 false）：仅适用于 unknown 且没有 upstreamId 的任务。
   * 置真时记录 abandonedAt、保留键/输入/历史并解除保守额度，但不会声称上游已取消；其他状态逐项拒绝。
   */
  abandonUnconfirmed: z.boolean().optional(),
}), async (req, res) => {
  const { directory, taskIds, batchId, batchKey, abandonUnconfirmed } = req.body as {
    directory: string;
    taskIds?: string[];
    batchId?: string;
    batchKey?: string;
    abandonUnconfirmed?: boolean;
  };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  // 取消 ≠ 暂停跟进：下载中取消只暂停取回并保留恢复能力；待核对任务默认只记取消意图。
  res.json(success(await cancelMediaTasks({ directory: cwd, taskIds, batchId, batchKey, abandonUnconfirmed: abandonUnconfirmed === true })));
});
