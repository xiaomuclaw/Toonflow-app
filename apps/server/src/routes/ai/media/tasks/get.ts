import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { getMediaTasks } from "@/utils/mediaTasks";

const taskIdsSchema = z.union([
  z.string().max(20000),
  z.array(z.string().min(1).max(256)).max(200),
]).optional();

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function parseTaskIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) return value as string[];
  const text = String(value).trim();
  if (!text) return undefined;
  let items: unknown;
  try {
    items = text.startsWith("[") ? JSON.parse(text) : text.split(",");
  } catch {
    invalid("taskIds 必须是字符串数组");
  }
  if (!Array.isArray(items) || items.some(item => typeof item !== "string")) invalid("taskIds 必须是字符串数组");
  const list = items.map(item => item.trim()).filter(Boolean);
  if (!list.length) return undefined;
  if (list.length > 200) invalid("taskIds 最多 200 个");
  return list;
}

export default Router().get("/", validateFields({
  directory: z.string().min(1).max(4096),
  taskIds: taskIdsSchema,
  batchId: z.string().min(1).max(128).optional(),
  batchKey: z.string().min(16).max(128).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
}, "query"), async (req, res) => {
  const { directory, taskIds, batchId, batchKey, cursor, limit } = req.query as Record<string, unknown>;
  const cwd = await u.workspace.resolveWorkspace(req, String(directory));
  const parsedLimit = limit === undefined ? undefined : Number(limit);
  if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200)) invalid("limit 必须是 1-200 的整数");
  res.json(success(await getMediaTasks({
    directory: cwd,
    taskIds: parseTaskIds(taskIds),
    batchId: typeof batchId === "string" && batchId ? batchId : undefined,
    batchKey: typeof batchKey === "string" && batchKey ? batchKey : undefined,
    cursor: typeof cursor === "string" && cursor ? cursor : undefined,
    limit: parsedLimit,
  })));
});
