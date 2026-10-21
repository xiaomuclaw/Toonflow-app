import { createHash } from "node:crypto";
import u from "@/utils";
import { Router } from "express";
import { success } from "@/lib/responseFormat";

const settingsMetaKey = "settingsMeta";

type SettingsMeta = { revision: string; updatedAt: string };

function computeRevision(settings: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}

const router = Router();

export default router.get("/", (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  const settings = u.conf.get("settings", {});
  if (u.cleanNodeMenuSettings(settings)) u.conf.set("settings", settings);
  const revision = computeRevision(settings);
  // ACT: settingsMeta 缺失或与当前设置内容不符时惰性修复，覆盖旧版本写入与启动期模型刷新产生的漂移。
  const meta = u.conf.get(settingsMetaKey) as SettingsMeta | undefined;
  if (!meta || meta.revision !== revision) u.conf.set(settingsMetaKey, { revision, updatedAt: new Date().toISOString() });
  res.set("x-toonflow-settings-revision", revision);
  res.json(success(settings));
});
