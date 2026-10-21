import u from "@/utils";
import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { maxSystemPromptLength } from "@/agent/runtime/prompt";
import { t } from "@/lib/i18n";

const router = Router();
const settingsMetaKey = "settingsMeta";

type SettingsMeta = { revision: string; updatedAt: string };

function computeRevision(settings: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

// ACT: 设置保存的"校验-写入-刷新-revision"在同一串行链内完成；并发请求依次进入，避免 A 取到 B 的内容版本（F08）。
let settingsSaveChain: Promise<unknown> = Promise.resolve();
function withSettingsSaveLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = settingsSaveChain.then(operation, operation);
  settingsSaveChain = result.catch(() => {});
  return result;
}

export default router.put("/", validateFields({ settings: z.record(z.string(), z.json()).and(z.object({
  agentSystemPrompt: z.string().max(maxSystemPromptLength, { error: () => t`系统提示词不能超过 ${maxSystemPromptLength} 个字符` }).optional(),
  desktopUpdateSource: z.enum(["official", "github", "custom"]).optional(),
  desktopUpdateCustomUrl: z.string().max(2048).refine(value => !value || u.desktop.isValidUpdateUrl(value),
    "自定义更新源必须是不含账号、查询参数或锚点的 HTTP(S) 地址").optional(),
  mcp: z.object({ enabled: z.boolean().optional(), token: z.string().optional(), port: z.number().int().min(1).max(65535).optional() }).optional(),
})).refine(value => value.desktopUpdateSource !== "custom" || !!value.desktopUpdateCustomUrl, {
  path: ["desktopUpdateCustomUrl"], message: "选择自定义更新源前，请先填写有效地址",
}), expectedRevision: z.string().max(128).optional() }), (req, res) => withSettingsSaveLock(async () => {
  u.mcpControl.assertAppRequest(req);
  const { settings, expectedRevision } = req.body;
  const currentRevision = computeRevision(u.conf.get("settings", {}));
  // ACT: 旧窗口基于过期 revision 的整体覆盖会被拒绝，避免撤销较新的 Key 与策略；不写入任何内容。
  if (typeof expectedRevision === "string" && expectedRevision && expectedRevision !== currentRevision) {
    return res.status(409).json(error("设置已在其他窗口被修改，请重新加载后再保存", { currentRevision }, 409));
  }
  u.removeLegacySettings(settings);
  // ACT: 清理开关必须为布尔、天数为 1-3650 整数；缺失时补默认值（默认全部关闭）。
  const cleanupCheck = u.cleanup.validateCleanupSettings((settings as Record<string, unknown>).cleanup);
  if (!cleanupCheck.ok) return res.status(400).json(error(cleanupCheck.message, null, 400));
  (settings as Record<string, unknown>).cleanup = cleanupCheck.value;
  // ACT: 等待提醒小时数 0-720 整数；0 表示不提醒（长期等待契约 B）。
  const mediaTasksInput = (settings as Record<string, unknown>).mediaTasks;
  if (mediaTasksInput && typeof mediaTasksInput === "object" && !Array.isArray(mediaTasksInput)) {
    const hours = (mediaTasksInput as Record<string, unknown>).waitingReminderHours;
    if (hours !== undefined && (typeof hours !== "number" || !Number.isInteger(hours) || hours < 0 || hours > 720)) {
      return res.status(400).json(error("等待提醒小时数必须是 0-720 的整数（0 表示不提醒）", null, 400));
    }
  }
  const previousSettings = u.conf.get("settings", {});
  u.conf.set("settings", settings);
  const [models] = await Promise.all([u.ai.refreshProviderModels(previousSettings), u.mcpRuntime.reloadMcpRuntime()]);
  // ACT: 模型刷新可能改写 customProviders，保存完成后按最终设置内容重算 revision。
  const revision = computeRevision(u.conf.get("settings", {}));
  u.conf.set(settingsMetaKey, { revision, updatedAt: new Date().toISOString() } as SettingsMeta);
  res.set("x-toonflow-settings-revision", revision);
  res.json(success(models, "设置已保存"));
}));
