import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { previewCleanup, validateCleanupSettings } from "@/utils/cleanup";
import type { CleanupSettings } from "@/utils/cleanup";

const router = Router();

// ACT: 可选传入拟保存的 settings.cleanup 值，用于“先预览再保存”；缺省按当前保存的设置预览。
export default router.post("/", async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  let settings: CleanupSettings | undefined;
  if (body.settings !== undefined) {
    const validated = validateCleanupSettings(body.settings);
    if (!validated.ok) throw Object.assign(new Error(validated.message), { status: 400 });
    settings = validated.value;
  }
  res.json(success(await previewCleanup(settings)));
});
