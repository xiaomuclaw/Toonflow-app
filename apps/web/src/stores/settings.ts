import axios from "axios";
import { normalizeLocale } from "@toonflow/i18n";
import { computed, nextTick, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";
import { canvasShortcutFields, defaultCanvasShortcuts, getShortcutBindings, isShortcutAllowed, normalizeShortcut, type CanvasShortcuts } from "@/lib/canvasShortcuts";
import { normalizeNodeMenu, type StoredNodeMenuItem } from "@toonflow/server/nodeMenu";
import type { ReasoningEfforts, ThinkingLevel } from "@toonflow/server/modelReasoning";
import "element-plus/es/components/message/style/css";

export const settings = ref<Record<string, unknown>>({});
// ACT: revision 来自服务端响应头；页面在 loadSettings 完成后才挂载，加载标记仅保留在设置初始化与自动保存内部。
export const revision = ref("");
export const settingsConflict = ref(false);
/** G/T12：保存、重载与发布共用同一串行队列，任何一次读取都不会与另一次发布交错。 */
let settingsVersion = 0;
/** T12：本地草稿版本。只有"用户/界面产生的实际修改"才自增（发布写入不计）。 */
let settingsDraftVersion = 0;
// G/T12：applyingSettings 用引用计数，一个重载/保存结束不能放开另一个仍在途的发布。
let applyingCount = 0;
let conflictNotified = false;
let pendingReload: Promise<void> | undefined;

function beginApplying() {
  applyingCount++;
  applyingSettings = true;
}

function endApplying() {
  applyingCount = Math.max(0, applyingCount - 1);
  if (applyingCount === 0) applyingSettings = false;
}

function readRevisionHeader(value: unknown) {
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}
// ACT: 页面在 loadSettings 完成后才挂载，加载标记仅保留在设置初始化与自动保存内部。
let settingsReady = false;
let saveQueue = Promise.resolve();
let applyingSettings = false;

export const settingsStorage = {
  getItem(key: string) {
    const stores = settings.value.stores as Record<string, unknown> | undefined;
    if (stores && Object.hasOwn(stores, key)) return JSON.stringify(stores[key]);
    // ACT: 只迁移当前来源可读取的旧缓存，保留原值；不同端口的 localStorage 不能互读。
    const value = localStorage.getItem(key);
    if (value !== null) settingsStorage.setItem(key, value);
    return value;
  },
  setItem(key: string, value: string) {
    settings.value.stores = { ...(settings.value.stores as Record<string, unknown> | undefined), [key]: JSON.parse(value) };
  },
};

export const defaultUiSettings = { theme: "dark", language: "system", primaryColor: "#409eff", fontScale: 100, mobileScale: 75, radius: 8, startupAnimation: true };
export const uiSettings = computed(() => {
  const raw = settings.value.ui;
  const ui = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    language: normalizeLocale(ui.language) ?? "system" as const,
    theme: ui.theme === "light" || ui.theme === "dark" || ui.theme === "system" ? ui.theme : defaultUiSettings.theme,
    primaryColor: typeof ui.primaryColor === "string" && /^#[\da-f]{6}$/i.test(ui.primaryColor) ? ui.primaryColor : defaultUiSettings.primaryColor,
    fontScale: typeof ui.fontScale === "number" && Number.isFinite(ui.fontScale) ? Math.min(125, Math.max(85, ui.fontScale)) : defaultUiSettings.fontScale,
    mobileScale: typeof ui.mobileScale === "number" && Number.isFinite(ui.mobileScale) ? Math.min(100, Math.max(50, ui.mobileScale)) : defaultUiSettings.mobileScale,
    radius: typeof ui.radius === "number" && Number.isFinite(ui.radius) ? Math.min(16, Math.max(0, ui.radius)) : defaultUiSettings.radius,
    startupAnimation: ui.startupAnimation !== false,
  };
});

export function updateUiSettings(patch: Partial<typeof defaultUiSettings>) {
  const current = settings.value.ui;
  settings.value = { ...settings.value, ui: { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), ...patch } };
}

export const generalSettings = computed(() => {
  const raw = settings.value.general;
  const general = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const shortcuts = general.canvasShortcuts && typeof general.canvasShortcuts === "object" && !Array.isArray(general.canvasShortcuts)
    ? general.canvasShortcuts as Record<string, unknown> : {};
  const savedBindings = new Map(canvasShortcutFields.flatMap(field => {
    const value = shortcuts[field.id];
    const binding = typeof value === "string" ? normalizeShortcut(value) : undefined;
    return binding !== undefined && isShortcutAllowed(field, binding) ? [[field.id, binding] as const] : [];
  }));
  return {
    nodeMenu: normalizeNodeMenu(general.nodeMenu),
    canvasCompositingEnabled: general.canvasCompositingEnabled === true,
    canvasEdgeAnimationEnabled: general.canvasEdgeAnimationEnabled !== false,
    canvasEdgeColorMode: general.canvasEdgeColorMode === "none" || general.canvasEdgeColorMode === "custom" ? general.canvasEdgeColorMode : "theme",
    canvasEdgeColor: typeof general.canvasEdgeColor === "string" && /^#[\da-f]{6}$/i.test(general.canvasEdgeColor) ? general.canvasEdgeColor : defaultUiSettings.primaryColor,
    canvasShortcuts: Object.fromEntries(canvasShortcutFields.map(field => {
      if (savedBindings.has(field.id)) return [field.id, savedBindings.get(field.id)];
      const binding = defaultCanvasShortcuts[field.id];
      const conflicts = canvasShortcutFields.some(other => other.gesture === field.gesture
        && getShortcutBindings(savedBindings.get(other.id) ?? "").some(value => getShortcutBindings(binding).includes(value)));
      return [field.id, conflicts ? "" : binding];
    })) as CanvasShortcuts,
  };
});

export function updateGeneralSettings(patch: Omit<Partial<typeof generalSettings.value>, "nodeMenu"> & { nodeMenu?: StoredNodeMenuItem[] }) {
  const current = settings.value.general;
  settings.value = { ...settings.value, general: { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), ...patch } };
}

export const privacySettings = computed(() => {
  const raw = settings.value.privacy;
  const privacy = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    dataCollectionEnabled: privacy.dataCollectionEnabled !== false,
    anonymousId: typeof privacy.anonymousId === "string" ? privacy.anonymousId : "",
  };
});

export type CustomProviderModel = { id: string; label: string; contextWindow?: number; maxOutputTokens?: number; reasoningEfforts?: ReasoningEfforts };
export type CustomProvider = { id: string; label: string; icon?: string; version?: string; apiUrl: string; apiKey: string; protocol: string; models: CustomProviderModel[] };
export const customProviders = computed<CustomProvider[]>(() => Array.isArray(settings.value.customProviders)
  ? settings.value.customProviders.filter((item): item is CustomProvider => !!item && typeof item.id === "string" && typeof item.label === "string" && Array.isArray(item.models)
    && item.models.every((model: CustomProviderModel) => !!model && typeof model.id === "string" && typeof model.label === "string"))
  : []);

type ResolvedAiModel = { providerId: string; modelId: string; reasoningLevels: ThinkingLevel[] };
const resolvedModelReasoning = ref<Partial<Record<string, ThinkingLevel[]>>>({});
export const modelChoices = computed(() => customProviders.value.flatMap(provider => provider.models.map(model => ({
  value: JSON.stringify([provider.id, model.id]), providerId: provider.id, modelId: model.id, label: model.label, contextWindow: model.contextWindow,
  reasoningLevels: resolvedModelReasoning.value[JSON.stringify([provider.id, model.id])],
}))));

function applyModelReasoning(models: ResolvedAiModel[]) {
  resolvedModelReasoning.value = Object.fromEntries(models.map(model => [JSON.stringify([model.providerId, model.modelId]), model.reasoningLevels]));
}

async function loadModelReasoning() {
  const { data } = await axios.get<{ code: number; data: ResolvedAiModel[] }>(
    "/api/ai/models", { headers: { "Cache-Control": "no-cache", "x-toonflow-workspace": "1" } },
  );
  if (data.code !== 200 || !Array.isArray(data.data)) throw new Error("读取模型推理等级失败");
  applyModelReasoning(data.data);
}

export async function loadSettings() {
  if (settingsReady) return;
  const response = await axios.get("/api/settings/get", { headers: { "Cache-Control": "no-cache", "x-toonflow-workspace": "1" } });
  const data = response.data;
  revision.value = readRevisionHeader(response.headers["x-toonflow-settings-revision"]);
  settingsVersion++;
  if (settingsReady) return;
  if (data.code !== 200 || !data.data || typeof data.data !== "object" || Array.isArray(data.data)) {
    throw new Error("读取设置失败");
  }
  settings.value = data.data;
  await loadModelReasoning();
  // 等初始化引发的监听执行完，再允许自动保存。
  await nextTick();
  settingsReady = true;
}

export function saveSettings(update?: (current: Record<string, unknown>) => Record<string, unknown> | undefined) {
  // ACT: 队列内读取最新配置再计算变更，确认成功后发布；仅协调当前页面的保存。
  const saving = saveQueue.then(async () => {
    const patch = update?.(settings.value);
    if (update && !patch) return false;
    const requestedNodeMenu = JSON.stringify(((patch?.general ?? settings.value.general) as { nodeMenu?: unknown } | undefined)?.nodeMenu);
    let response;
    try {
      response = await axios.put<{ code: number; data: { customProviders?: CustomProvider[]; mediaProvider?: { id: string }; modelRefreshErrors?: string[]; nodeMenu?: StoredNodeMenuItem[] | null; aiModels?: ResolvedAiModel[] } | null }>(
        "/api/settings/save",
        { settings: { ...settings.value, ...patch }, expectedRevision: revision.value || undefined },
        { headers: { "x-toonflow-workspace": "1" } },
      );
    } catch (error) {
      // 409 表示其他窗口已保存更新版本；保留本地修改，等待用户重新加载后再保存。
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        settingsConflict.value = true;
        throw Object.assign(new Error("设置已在其他窗口被修改，请重新加载后再保存"), { conflict: true });
      }
      throw error;
    }
    const data = response.data;
    if (data.code !== 200) throw new Error("保存设置失败");
    if (data.data?.aiModels) applyModelReasoning(data.data.aiModels);
    revision.value = readRevisionHeader(response.headers["x-toonflow-settings-revision"]) || revision.value;
    settingsConflict.value = false;
    conflictNotified = false;
    const providers = data.data?.customProviders;
    if ((patch && Object.hasOwn(patch, "customProviders")) || providers) invalidateNodeModels("language");
    if (patch || providers) {
      // T12：发布也计入 applyingSettings 引用计数并自增版本号，供重载判断响应是否过期。
      beginApplying();
      try { settings.value = { ...settings.value, ...patch, ...(providers ? { customProviders: providers } : {}) }; settingsVersion++; }
      finally { endApplying(); }
    }
    if (data.data && Object.hasOwn(data.data, "nodeMenu")
      && requestedNodeMenu === JSON.stringify((settings.value.general as { nodeMenu?: unknown } | undefined)?.nodeMenu)
      && requestedNodeMenu !== JSON.stringify(data.data.nodeMenu ?? undefined)) {
      beginApplying();
      try {
        const general = { ...(settings.value.general as Record<string, unknown> | undefined) };
        if (data.data.nodeMenu?.length) general.nodeMenu = data.data.nodeMenu;
        else delete general.nodeMenu;
        settings.value = { ...settings.value, general };
        settingsVersion++;
      } finally { endApplying(); }
    }
    if (data.data?.mediaProvider) {
      invalidateNodeModels("media");
      window.dispatchEvent(new CustomEvent("toonflow:plugin-installed", { detail: { type: "provider", name: data.data.mediaProvider.id } }));
    }
    if (patch && Object.hasOwn(patch, "mediaProviderConfigs")) {
      window.dispatchEvent(new Event("toonflow:provider-config-changed"));
    }
    if (data.data?.modelRefreshErrors?.length) ElMessage.warning(`API Key 已保存，部分模型获取失败：${data.data.modelRefreshErrors.join("；")}`);
    return true;
  });
  saveQueue = saving.then(() => {}, () => {});
  return saving;
}

/**
 * 供设置面板处理版本冲突：丢弃本地快照，重新读取服务端设置。
 * 契约 v3 §D.6 / v4 §G、T12：GET→校验→发布整体进入与保存同一条串行队列（并单飞），
 * 过期响应（队列前后版本已变化）不得覆盖新 settings/revision；重载期间旧排队快照也不会覆盖新读取结果。
 * T12：GET 在途期间用户仍可编辑——用确实随草稿修改变化的 settingsDraftVersion 保护。
 */
export function reloadSettings(): Promise<void> {
  // 单飞：并发重载复用同一在途请求，避免多份 GET 逆序到达互相覆盖。
  pendingReload ??= (async () => {
    const request = saveQueue.then(async () => {
      const startedVersion = settingsVersion;
      const startedDraft = settingsDraftVersion;
      const response = await axios.get("/api/settings/get", { headers: { "Cache-Control": "no-cache", "x-toonflow-workspace": "1" } });
      const data = response.data;
      if (data.code !== 200 || !data.data || typeof data.data !== "object" || Array.isArray(data.data)) {
        throw new Error("读取设置失败，请稍后重试");
      }
      const nextRevision = readRevisionHeader(response.headers["x-toonflow-settings-revision"]);
      if (!nextRevision) throw new Error("设置缺少版本标识，未切换本地状态；请确认服务端已更新后重试");
      // 队列保证不会交错；版本号仍作双保险：过期响应不发布，保留当前较新的状态。
      if (settingsVersion !== startedVersion) return;
      if (settingsDraftVersion !== startedDraft) {
        throw Object.assign(new Error("重新加载期间有新的本地修改，已保留本地修改未覆盖；请先保存或处理本地修改后再次重新加载"), { draftChanged: true });
      }
      beginApplying();
      try {
        revision.value = nextRevision;
        settings.value = data.data;
        settingsVersion++;
      } finally {
        endApplying();
      }
      // 等发布引发的监听执行完再无痕恢复自动保存。
      await nextTick();
      settingsReady = true;
      settingsConflict.value = false;
      conflictNotified = false;
    });
    saveQueue = request.then(() => {}, () => {});
    try {
      await request;
    } catch (error) {
      // 失败路径不改变 settingsReady / revision / settingsConflict：横幅与重试按钮保留，自动保存继续可用。
      if (axios.isAxiosError(error) && error.response?.status === 401) return;
      if ((error as { draftChanged?: boolean } | undefined)?.draftChanged) {
        ElMessage.warning(error instanceof Error ? error.message : "重新加载期间有新的本地修改，已保留本地修改未覆盖");
        return;
      }
      ElMessage.error(axios.isAxiosError<{ message?: string }>(error)
        ? error.response?.data?.message || "重新加载设置失败，请检查网络后重试"
        : error instanceof Error ? error.message : "重新加载设置失败，请检查网络后重试");
    } finally {
      pendingReload = undefined;
    }
  })();
  return pendingReload;
}

// T12：发布写入（applyingSettings 内的重载/保存结果）不算草稿修改；其余都是真实的本地草稿变化，
// 计入 settingsDraftVersion 供 reloadSettings 判断在途 GET 期间草稿是否被改过。
watch(settings, () => {
  if (!settingsReady || applyingSettings) return;
  settingsDraftVersion++;
  void saveSettings().catch((error: unknown) => {
    // 会话过期由全局 401 处理负责提示与回到登录，避免重复报错。
    if (axios.isAxiosError(error) && error.response?.status === 401) return;
    if (error && typeof error === "object" && "conflict" in error && (error as { conflict?: unknown }).conflict === true) {
      if (!conflictNotified) {
        conflictNotified = true;
        ElMessage.warning("设置已在其他窗口被修改，本地修改未保存；可在设置面板重新加载");
      }
      return;
    }
    ElMessage.error("设置保存失败，请稍后重试");
  });
}, { deep: true, flush: "sync" });
