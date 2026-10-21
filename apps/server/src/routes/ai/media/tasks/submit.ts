import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { submitMediaTasks } from "@/utils/mediaTasks";
import type { MediaTaskMediaType, MediaTaskSubmitItem } from "@/utils/mediaTasks";

const itemSchema = z.strictObject({
  itemKey: z.string().min(1).max(128),
  request: z.json(),
  canvasId: z.string().min(1).max(256).optional(),
  nodeId: z.string().min(1).max(256).optional(),
});

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  batchKey: z.string().min(16).max(128),
  mediaType: z.enum(["image", "video", "audio"]),
  // ACT: 单次传输上限 50；批次数量和排队任务数不设业务上限。
  items: z.array(itemSchema).min(1).max(50),
}), async (req, res) => {
  const { directory, batchKey, mediaType, items } = req.body as {
    directory: string;
    batchKey: string;
    mediaType: MediaTaskMediaType;
    items: MediaTaskSubmitItem[];
  };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  req.once("aborted", close);
  try {
    const result = await submitMediaTasks({ directory: cwd, batchKey, mediaType, items }, { signal: controller.signal });
    if (!res.destroyed) res.json(success(result));
  } finally {
    res.off("close", close);
    req.off("aborted", close);
  }
});
