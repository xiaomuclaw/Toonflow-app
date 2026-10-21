import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { mkdir, readFile, stat } from "@toonflow/file";
import conf from "@/utils/conf";
import { getMediaProvider, loadMediaProviderSource } from "@/utils/media/provider";
import { assetBytes, contentAddressedMediaName, downloadIdleTimeoutMs, mediaExtensions } from "@/utils/media/assetBytes";
import type { AssetDownloadAuthorization } from "@/utils/media/assetBytes";
import { beginFileRegistrationProtection, fileRecordsReadinessSnapshot, fileRecordsStoreHealthSnapshot, findFileRelocationWriteBlock } from "@/utils/fileRecords";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import {
  clearExpiredMediaTaskRetryAt, countMediaTaskInflight, drainMediaTaskWriteQueue, ensureMediaTasksStore, getMediaTask, isFinishedMediaTaskState, listMediaTasks,
  listMediaTasksInState, listUnfinishedRelocationTasks, mediaProviderCredentialReference, mediaTaskAccountHash, mediaTaskQueryIdentityMatches, mediaTaskStoreLoadWarnings, mediaTaskSubmissionIdentity, mediaTaskTrackingStatus,
  relocationIntentParticipantIds, relocationParticipantOpenReason, relocationTransactionParticipants, relocationTransactionPhase,
  mediaTasksStoreLoaded, occupiesUpstreamSlot, updateMediaTask, updateMediaTaskIfApplied,
} from "./store";
import type { MediaTaskOutput, MediaTaskQueryIdentitySnapshot, MediaTaskRecord, MediaTaskState } from "./store";
import { buildSnapshotInputs, inputSnapshotsReady } from "./snapshots";
import type { MediaTaskReferenceInputs } from "./snapshots";
import { mediaOutputSha256, mediaTaskOutputAvailability } from "./outputState";

type LoadedMediaProvider = Awaited<ReturnType<typeof loadMediaProviderSource>>;
type MediaTaskPhase = "submit" | "query" | "download";

const pollTickIntervalMs = 1000;
/** 提交一次网络尝试上限（契约 B）；提交阶段不做本地自动重试。 */
const submitAttemptTimeoutMs = 90000;
/** 查询一次网络尝试上限（契约 B）。 */
const queryAttemptTimeoutMs = 30000;
/** 下载一次尝试总上限；连续无数据上限见 assetBytes.downloadIdleTimeoutMs（契约 B）。 */
const downloadAttemptTimeoutMs = 15 * 60000;
/** 临时网络错误指数退避：10 秒起，封顶 5 分钟（±20% 抖动）。 */
const retryBaseDelayMs = 10000;
const retryMaxDelayMs = 5 * 60000;
/** 下载失败后的最早重试间隔。 */
const downloadRetryMinDelayMs = 60000;
/** 一次性查询作业并行上限；查询间隔不占执行槽，也不需要占用上游在途额度。 */
const maxConcurrentQueryJobs = 4;
/** 长时间等待（2 小时后）的查询/补取频率。 */
const longWaitRetryDelayMs = 5 * 60000;
const defaultWaitingReminderHours = 24;
const maxWaitingReminderHours = 24 * 30;

export type MediaTasksRuntimeSettings = {
  paused: boolean;
  /** 上游未终结的在途额度（默认 2），不是批次数量上限。 */
  generationConcurrency: number;
  downloadConcurrency: number;
  referenceBudgetMb: number;
  /** 整个生成等待的提醒小时数；0 表示不提醒，只提醒不判失败。 */
  waitingReminderHours: number;
};

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function reminderHours(value: unknown, fallback: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? Math.min(value, maximum) : fallback;
}

export function mediaTasksRuntimeSettings(): MediaTasksRuntimeSettings {
  const raw = conf.get("settings.mediaTasks");
  const settings = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    paused: settings.paused === true,
    generationConcurrency: positiveInteger(settings.generationConcurrency, 2, 16),
    downloadConcurrency: positiveInteger(settings.downloadConcurrency, 2, 16),
    referenceBudgetMb: positiveInteger(settings.referenceBudgetMb, 200, 4096),
    waitingReminderHours: reminderHours(settings.waitingReminderHours, defaultWaitingReminderHours, maxWaitingReminderHours),
  };
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/* ---------------------------------------------------------------- 错误分类 */

type MediaTaskFollowUp = "retry" | "blocked" | "failed" | "pendingReview" | "unknown";

type MediaTaskErrorInfo = {
  followUp: MediaTaskFollowUp;
  status?: number;
  retryAfterMs?: number;
  timeout: boolean;
};

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** 错误文案读取：供应商运行在独立 VM 上下文，不能用 instanceof Error 判断其异常对象。 */
function errorMessageOf(error: unknown) {
  const record = recordOf(error);
  if (typeof record?.message === "string" && record.message) return record.message;
  return typeof error === "string" ? error : "";
}

/**
 * 完整规范化 API 基址（协议 + 主机 + 端口 + 路径）。
 * 同源不同路径（如 /v1 与 /v2）不是同一个提交身份，恢复时必须按完整基址比对（契约 v3 §C.2）。
 */
export function normalizeProviderBase(value: string | undefined) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.trim().replace(/\/+$/, "");
  }
}

/** 供应商配置视图：兼容 getMediaProvider 的返回结构与最小测试替身。 */
export type MediaProviderView = {
  id?: string;
  apiUrl?: string;
  asyncMedia?: boolean;
  revision?: string;
  models: { id: string }[];
};

/**
 * 当前查询身份（契约 v4 §E/T07）：加载供应商时计算，不落盘原始 Key，只与历史提交身份
 * 及「核验当时的身份」比较。credentialRef 为派生引用（providerId + Key 的 SHA-256 截断），不能用于调用上游。
 */
export type MediaTaskQueryIdentity = MediaTaskQueryIdentitySnapshot;

/** 用当前配置计算查询身份；apiUrl/revision 直接来自已加载的供应商视图。 */
export function mediaTaskQueryIdentity(task: MediaTaskRecord, info: MediaProviderView): MediaTaskQueryIdentity {
  const providerId = info.id ?? task.providerId;
  return {
    providerId,
    modelId: task.modelId,
    apiBase: normalizeProviderBase(info.apiUrl),
    revision: typeof info.revision === "string" && info.revision ? info.revision : undefined,
    credentialRef: mediaProviderCredentialReference(providerId, mediaProviderApiKeyOf(providerId)),
  };
}

export type ProviderCompatibility = {
  compatible: boolean;
  reason?: string;
  /** 放行依据，便于诊断与人工核对：自提交链 / 人工核实的恢复依据 / 缺地址旧记录。 */
  basis?: "submissionIdentity" | "verifiedRecovery" | "legacyAddressMissing";
};

/**
 * 身份失配的字段级原因（T07，用于可读等待原因）：只列字段名，不输出凭据引用值。
 * identity 缺失（旧记录未保存核验身份）时同样视为不一致，必须重新只读核对。
 */
function identityMismatchFields(expected: MediaTaskQueryIdentitySnapshot | undefined, current: MediaTaskQueryIdentitySnapshot) {
  if (!expected) return "核验记录未保存核验身份";
  const differences: string[] = [];
  if (expected.providerId !== current.providerId) differences.push("供应商");
  if (expected.modelId !== current.modelId) differences.push("模型");
  if ((expected.apiBase ?? "") !== (current.apiBase ?? "")) differences.push("API 基址");
  if ((expected.revision ?? "") !== (current.revision ?? "")) differences.push("供应商文件版本");
  if (expected.credentialRef !== current.credentialRef) differences.push("查询凭据（账户或 Key）");
  return differences.length ? `差异：${differences.join("、")}` : "核验身份字段不一致";
}

/**
 * 受控兼容规则（契约 v4 §E/T07）：核对历史提交身份、当前查询身份与人工核实的恢复依据。
 * - 有 verifiedRecovery 且 upstreamId 匹配（T07）：仅当当前查询身份与 verifiedRecovery.identity 全等才免检续查；
 *   任一不一致（providerId/modelId/API 基址/revision/credentialRef）→ 直接 blocked 并要求重新只读核对，
 *   不得再用原 submissionIdentity 相等放行（原提交身份仅保留供审计）；
 * - 无核验依据时：要求 apiBase（规范化）+ revision + credentialRef 全等 → 续查；
 * - 地址缺失但 revision 相同 → 允许续查（旧记录兼容），但必须先通过 credentialRef 检查；
 *   不得提前 true 跳过凭据检查，也不因地址相同就放过版本变化。
 * - 其余 → blocked（可读原因），等待人工核对/再次 resume。
 * requireQueryCapability=false（首次提交阶段）：同步供应商同样可以后台执行，不要求 submitMedia/queryMedia。
 */
export function providerCompatibility(
  task: MediaTaskRecord,
  info: MediaProviderView,
  options: { requireQueryCapability?: boolean } = {},
): ProviderCompatibility {
  const requireQueryCapability = options.requireQueryCapability !== false;
  if (info.id !== undefined && info.id !== task.providerId) {
    return { compatible: false, reason: "供应商与任务记录不一致，需人工确认任务归属后再 resume" };
  }
  if (requireQueryCapability && info.asyncMedia !== true) {
    // ACT: 只有恢复（查询/下载原上游 ID）才需要持久异步能力；首次提交由调度器按能力分流。
    return { compatible: false, reason: "供应商未提供原任务查询能力（queryMedia），无法续查该上游任务，需人工确认后 resume" };
  }
  if (!info.models.some(model => model.id === task.modelId)) {
    return { compatible: false, reason: `供应商已不再提供模型 ${task.modelId}，需人工确认后 resume` };
  }
  // 1) 已核实的恢复依据（T07）：只在「当前查询身份与核验当时（verifiedRecovery.identity）全等」时才免检。
  //    核验后变更 Key / API 地址 / 供应商文件版本 / 模型，免检立即失效；
  //    存在针对当前 upstreamId 的核验依据时，它的身份约束**不得**被原 submissionIdentity 替代：
  //    失配直接 blocked 并要求重新只读核验，绝不因「当前身份恰好等于原提交身份」而放行
  //    （原提交身份仅保留供审计）。当前账户命名空间锁、核验前固定版本与核验后身份复查保持不变。
  const verified = task.verifiedRecovery;
  const verifiedForTask = !!verified && !!task.upstreamId && verified.upstreamId === task.upstreamId;
  const currentQueryIdentity: MediaTaskQueryIdentitySnapshot = {
    providerId: info.id ?? task.providerId,
    modelId: task.modelId,
    apiBase: normalizeProviderBase(info.apiUrl),
    revision: typeof info.revision === "string" && info.revision ? info.revision : undefined,
    credentialRef: mediaProviderCredentialReference(info.id ?? task.providerId, mediaProviderApiKeyOf(info.id ?? task.providerId)),
  };
  if (verifiedForTask) {
    if (mediaTaskQueryIdentityMatches(verified!.identity, currentQueryIdentity)) {
      return { compatible: true, basis: "verifiedRecovery" };
    }
    return {
      compatible: false,
      reason: `已有针对当前上游任务 ID 的核验依据，但当前查询身份与核验当时不一致（${identityMismatchFields(verified!.identity, currentQueryIdentity)}）：免检已失效，必须重新只读核对后 resume，不会用原提交身份继续查询`,
    };
  }
  const identity = mediaTaskSubmissionIdentity(task);
  if (!identity) {
    return { compatible: false, reason: "任务记录缺少提交时的供应商身份（地址/版本/凭据引用），无法证明仍是同一查询身份，需人工核对后 resume" };
  }
  // 2) 凭据身份引用先行核对：缺字段或与当前不同一律 blocked，不得因地址相同/缺失提前放行。
  const query = mediaTaskQueryIdentity(task, info);
  if (identity.credentialRef !== query.credentialRef) {
    return { compatible: false, reason: "当前查询凭据与提交时不同（账户或 Key 已变更），需人工确认任务归属后再 resume" };
  }
  const declaredBase = identity.apiBase;
  const currentBase = query.apiBase;
  if (declaredBase && currentBase) {
    if (declaredBase !== currentBase) {
      return { compatible: false, reason: `供应商地址已变更（${declaredBase} → ${currentBase}），需人工确认任务归属后再 resume` };
    }
    // 地址相同不等于协议兼容：供应商文件版本变化一律需要人工只读核对，不因同址全放过。
    if (!query.revision) {
      return { compatible: false, reason: "无法读取当前供应商文件版本，无法证明查询协议未变，需人工确认后 resume" };
    }
    if (query.revision !== identity.revision) {
      return { compatible: false, reason: "供应商文件版本已变化，需人工只读核对任务归属后 resume（不会自动重试或重新生成）" };
    }
    return { compatible: true, basis: "submissionIdentity" };
  }
  // 3) 旧记录缺地址：只有供应商文件版本一致（提交身份未变）才放行；凭据引用已在上方核对。
  //    已有核验依据的任务在上方第 1 步已决出结论，不会走到这里（T07：不得用原提交身份替代核验身份）。
  if (query.revision && query.revision === identity.revision) {
    return { compatible: true, basis: "legacyAddressMissing" };
  }
  return { compatible: false, reason: "任务记录与当前供应商未声明可核对的 API 地址或版本不一致，无法证明查询地址未变，需人工确认后 resume" };
}

/** 当前配置里的供应商 API Key；只用于比对凭据引用与注入供应商上下文，不落盘、不外传。 */
export function mediaProviderApiKeyOf(providerId: string) {
  const settings = conf.get("settings", {}) as Record<string, unknown>;
  const configurations = settings.mediaProviderConfigs;
  const config = configurations && typeof configurations === "object" && !Array.isArray(configurations)
    ? (configurations as Record<string, unknown>)[providerId]
    : undefined;
  const apiKey = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).apiKey : undefined;
  return typeof apiKey === "string" ? apiKey.trim().replace(/^Bearer(?:\s+|$)/i, "").trim() : "";
}

/** 跨 VM 读取可验证的结构化 HTTP 状态，而不是依赖 instanceof 或状态码文本。 */
function httpStatusOf(error: unknown) {
  const record = recordOf(error);
  if (record) {
    for (const key of ["status", "statusCode"]) {
      const value = record[key];
      if (typeof value === "number" && value >= 100 && value < 600) return value;
    }
  }
  const matched = /\bHTTP[\s/:]*([45]\d\d)\b/i.exec(errorMessageOf(error));
  return matched ? Number(matched[1]) : undefined;
}

function followUpOf(error: unknown): MediaTaskFollowUp | undefined {
  const value = recordOf(error)?.followUp;
  return value === "retry" || value === "blocked" || value === "failed" || value === "pendingReview" ? value : undefined;
}

function waitingReasonOf(error: unknown) {
  const value = recordOf(error)?.waitingReason;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 2000) : undefined;
}

function retryAfterMsOf(error: unknown) {
  const source = recordOf(error)?.retryAfterMs;
  if (typeof source === "number" && Number.isFinite(source) && source > 0) return Math.round(source);
  return undefined;
}

/** 单次尝试超时或本地中止（停机中止由调用方先用作业信号判断，不算错误）。 */
function isAttemptTimeout(error: unknown) {
  const name = recordOf(error)?.name;
  return name === "MediaTaskAttemptTimeout" || name === "TimeoutError" || name === "AbortError";
}

/**
 * 错误分类（契约 A、v3 §C.5）：禁止用 HTTP 状态码一概决定生成失败。
 * - 查询网络错误/超时/5xx/429 → retry（保持 running，按退避重试）
 * - 查询 401/403/凭据失效/不兼容 → blocked（停止密集重试，等待 resume）
 * - 查询其他 4xx（如 404 记录不存在）→ pendingReview（待核对/无法补取，不伪装成失败）
 * - 提交只有确定未受理（明确拒绝或提交前校验失败）才 failed，其余一律 unknown（待核对，不自动重提）
 * - 本地准备/校验失败（快照缺失、供应商能力不足、入参非法）确定未提交 → failed，不占保守额度、不转 unknown
 * - 下载失败都只重试，绝不重新生成
 */
function classifyMediaTaskError(error: unknown, phase: MediaTaskPhase): MediaTaskErrorInfo {
  const status = httpStatusOf(error);
  const timeout = isAttemptTimeout(error);
  const retryAfterMs = retryAfterMsOf(error);
  const structured = followUpOf(error);
  let followUp: MediaTaskFollowUp;
  if (structured) followUp = structured;
  else if (phase === "download") followUp = "retry";
  else if (phase === "submit") followUp = "unknown";
  else if (status === undefined) followUp = "retry";
  else if (status === 401 || status === 403) followUp = "blocked";
  else if (status === 408 || status === 425 || status === 429 || status >= 500) followUp = "retry";
  else followUp = "pendingReview";
  // 提交阶段：只有确定未受理才记失败，其余（含上游 5xx、网关 502、超时）保留提交键待核对。
  if (phase === "submit") followUp = followUp === "failed" || followUp === "blocked" ? "failed" : "unknown";
  // 本地准备失败（快照/校验/能力）：确定未提交，任何阶段都不当成可能已受理。
  if (recordOf(error)?.name === "MediaLocalFailureError" && phase === "submit") followUp = "failed";
  // 下载阶段：上游已生成结果，任何下载错误都只重试，不把任务判失败。
  if (phase === "download") followUp = "retry";
  return { followUp, status, retryAfterMs, timeout };
}

/** 生命周期错误：宿主自己在提交前/查询前生成的确定性错误，带结构化跟进分类。 */
function taskLifecycleError(message: string, followUp: "failed" | "blocked", waitingReason?: string) {
  return Object.assign(new Error(message), { name: "MediaTaskLifecycleError", followUp, waitingReason: waitingReason ?? message });
}

/** ±20% 抖动，避免同一批任务在同一秒集中打上游。 */
function jitter(ms: number) {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/** 查询阶段频率（契约 B）：<5 分钟 10 秒；5–30 分钟 30 秒；30 分钟–2 小时 60 秒；2 小时后 5 分钟。 */
function queryStageDelayMs(waitedMs: number) {
  if (!Number.isFinite(waitedMs) || waitedMs < 0) return jitter(retryBaseDelayMs);
  if (waitedMs < 5 * 60000) return jitter(10000);
  if (waitedMs < 30 * 60000) return jitter(30000);
  if (waitedMs < 2 * 3600000) return jitter(60000);
  return jitter(longWaitRetryDelayMs);
}

/** 临时错误退避：10 秒起指数增长封顶 5 分钟；Retry-After 更晚则取更晚（封顶只作下限保护）。 */
function retryDelayMsFor(info: MediaTaskErrorInfo, attempt: number) {
  const backoff = jitter(Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** Math.min(Math.max(attempt - 1, 0), 6)));
  return info.retryAfterMs !== undefined ? Math.max(info.retryAfterMs, backoff) : backoff;
}

function waitingSinceMs(task: MediaTaskRecord) {
  const started = Date.parse(task.submittedAt ?? task.createdAt);
  return Number.isNaN(started) ? 0 : Date.now() - started;
}

/** 错误文案统一走供应商去敏入口，失败时退回本地脱敏，绝不落盘密钥。 */
function providerErrorMessage(provider: LoadedMediaProvider | undefined, error: unknown) {
  if (provider) {
    try {
      const message = provider.tool.errorMessage(error);
      if (message) return message.slice(0, 2000);
    } catch {
      // ACT: 去敏失败时退回通用处理，不把原始异常写入任务记录。
    }
  }
  return errorMessageOf(error).replace(/(Bearer\s+)[^\s"'<>]+/gi, "$1••••••")
    .replace(/([?&][^=&#\s]+)=[^&#\s"'<>]*/g, "$1=••••••")
    .replace(/((?:api[_-]?key|secret|token|password|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"',;}&<>]+/gi, "$1••••••")
    .slice(0, 2000);
}

/* ------------------------------------------------------------ 供应商与兼容 */

/**
 * 加载任务对应的供应商实例：按阶段决定是否需要「原任务查询能力」（契约 v3 §C）。
 * - submit：只需认可提交能力（submitMedia+queryMedia 或有同步 generate），同步供应商不再被拒；
 * - query/download：必须能按原上游 ID 查询，否则保持 blocked 等待人工处理；
 * - skipCompatibility（仅人工 bind 的只读核对）：不做自动续查兼容门，
 *   由调用方用一次只读查询核对响应 ID/模型/账户，这是历史记录缺字段时唯一的受控放行路径。
 */
async function loadTaskProvider(
  task: MediaTaskRecord,
  signal: AbortSignal,
  phase: MediaTaskPhase,
  options: { skipCompatibility?: boolean } = {},
): Promise<LoadedMediaProvider> {
  const requireQueryCapability = phase !== "submit";
  const missing = () => phase === "submit"
    ? taskLifecycleError("供应商已被删除或无法读取，任务未提交上游，可重新提交", "failed")
    : taskLifecycleError("供应商已被删除或无法读取，需人工确认后 resume", "blocked");
  const info = await getMediaProvider(task.providerId).catch((error: Error & { status?: number; code?: string }) => {
    if (error.status === 404 || error.code === "ENOENT") throw missing();
    throw error;
  });
  if (!options.skipCompatibility) {
    const compatibility = providerCompatibility(task, info, { requireQueryCapability });
    if (!compatibility.compatible) {
      const reason = compatibility.reason ?? "供应商配置不兼容，需人工确认后 resume";
      // 提交阶段属于「确定未发上游」：明确说明可重新提交，不再提示不可执行的 resume 操作（R11）。
      throw phase === "submit" ? taskLifecycleError(`${reason}（任务未提交上游，不会自动重试，可调整后重新提交）`, "failed") : taskLifecycleError(reason, "blocked");
    }
  }
  const settings = conf.get("settings", {}) as Record<string, unknown>;
  const configurations = settings.mediaProviderConfigs;
  const config = configurations && typeof configurations === "object" && !Array.isArray(configurations)
    ? (configurations as Record<string, unknown>)[info.id]
    : undefined;
  // ACT: 密钥只从当前设置读取并注入供应商上下文，绝不写入任务记录。
  const provider = await loadMediaProviderSource(info.source, config && typeof config === "object" && !Array.isArray(config) ? config as Record<string, unknown> : {}, signal, undefined, task.directory);
  const rules = Array.isArray(provider.rules) ? provider.rules : [];
  if (rules.some(rule => rule.field === "apiKey") && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) {
    const reason = "请先在媒体模型设置中配置供应商 API Key";
    throw phase === "submit" ? taskLifecycleError(`${reason}（任务未提交上游，可重新提交）`, "failed") : taskLifecycleError(reason, "blocked");
  }
  return provider;
}

/** 结果下载鉴权（F17）：只有与供应商 apiUrl 同源 HTTPS 的地址才附令牌。 */
function downloadAuthorizationOf(provider: LoadedMediaProvider | undefined): AssetDownloadAuthorization | undefined {
  const apiUrl = typeof provider?.apiUrl === "string" ? provider.apiUrl : "";
  const raw = provider?.config?.apiKey;
  const token = typeof raw === "string" ? raw.trim().replace(/^Bearer(?:\s+|$)/i, "").trim() : "";
  return apiUrl && token ? { apiUrl, token } : undefined;
}

async function cancelUpstream(provider: LoadedMediaProvider, upstreamId: string) {
  const cancelMedia = provider.cancelMedia;
  if (typeof cancelMedia !== "function") return false;
  try {
    const result = await cancelMedia.call(provider, upstreamId);
    return result?.confirmed === true;
  } catch {
    return false;
  }
}

/** 取消时向上游请求取消；只有供应商明确确认才算确认取消。 */
export async function cancelUpstreamMediaTask(task: MediaTaskRecord): Promise<boolean> {
  if (!task.upstreamId) return false;
  const attempt = createAttempt(new AbortController().signal, queryAttemptTimeoutMs);
  try {
    const provider = await loadTaskProvider(task, attempt.signal, "query");
    return await cancelUpstream(provider, task.upstreamId);
  } catch {
    return false;
  } finally {
    attempt.done();
  }
}

export type UpstreamOwnershipVerification = {
  ok: boolean;
  /** 上游响应中已核实一致的字段名（原始来源为上游响应，不是本地推断）。 */
  verified: string[];
  /** 上游响应未提供、或无可信依据可比对、当前无法核实的字段名。 */
  unverifiable: string[];
  /** 无法核对时的可读原因（已去敏）。 */
  reason?: string;
  /** 上游返回的状态原文（去敏）。 */
  upstreamState?: string;
  /** 账户与可信身份派生标识一致时记录的账户哈希（不可逆）；否则不写。 */
  accountHash?: string;
};

/**
 * 人工绑定/恢复前的只读归属核对（契约 v4 §E）：用当前查询身份对候选 ID 做一次只读查询，
 * 核对响应 ID / 模型 / 可验证账户；不创建任何上游任务，也不写入本地记录。
 * - 必须回显 ID 且与候选相等，否则无法确认归属，拒绝绑定（至少 ID 相符才允许绑定）；
 * - 模型只有回显时才比较；
 * - 账户只有与可信身份派生标识比较一致才算 verified，否则 unverifiable，不编造账户；
 * - 历史记录缺地址/凭据引用时这条只读核对是唯一的受控放行路径（不做自动续查兼容门）。
 */
export async function verifyUpstreamMediaTask(task: MediaTaskRecord, upstreamId: string): Promise<UpstreamOwnershipVerification> {
  if (stopping) return { ok: false, verified: [], unverifiable: [], reason: "服务正在停止，暂不受理绑定核对" };
  const attempt = createAttempt(new AbortController().signal, queryAttemptTimeoutMs);
  try {
    const provider = await loadTaskProvider(task, attempt.signal, "query", { skipCompatibility: true });
    const queryMedia = provider.queryMedia;
    if (typeof queryMedia !== "function") {
      return { ok: false, verified: [], unverifiable: [], reason: "供应商未提供原任务查询能力，无法核对上游任务归属" };
    }
    const result = await queryMedia.call(provider, upstreamId);
    const record = recordOf(result) ?? {};
    const status = typeof record.status === "string" ? record.status : "";
    if (!["running", "succeeded", "failed", "cancelled"].includes(status)) {
      return { ok: false, verified: [], unverifiable: [], reason: "上游未返回可识别的任务状态，无法确认该 ID 属于当前供应商账户" };
    }
    const upstreamState = typeof record.upstreamState === "string" ? record.upstreamState : status;
    const verified: string[] = ["status"];
    const unverifiable: string[] = [];
    const conflict = (message: string) => ({ ok: false, verified, unverifiable, reason: message, upstreamState });
    // 响应 ID：必须回显且与候选 ID 相等——这是绑定归属的最低证据，缺一不可。
    const responseId = typeof record.upstreamId === "string" ? record.upstreamId.trim() : typeof record.id === "string" ? record.id.trim() : "";
    if (!responseId) {
      return {
        ok: false, verified, unverifiable: [...unverifiable, "upstreamId"], upstreamState,
        reason: "上游查询未回显任务 ID，无法确认该 ID 属于当前账户（至少需要 ID 相符才允许绑定）",
      };
    }
    if (responseId !== upstreamId) return conflict("上游返回的任务 ID 与候选 ID 不一致，拒绝绑定");
    verified.push("upstreamId");
    // 模型：供应商回显时才比较。
    const responseModel = typeof record.model === "string" ? record.model.trim() : "";
    if (responseModel) {
      if (responseModel !== task.modelId) return conflict(`上游返回的模型 ${responseModel} 与任务模型不一致，拒绝绑定`);
      verified.push("model");
    } else unverifiable.push("model");
    // 账户：只有与可信身份派生标识（此前已核实的账户哈希）一致才算 verified，否则保持 unverifiable。
    const responseAccount = typeof record.account === "string" ? record.account.trim() : "";
    const trustedAccountHash = task.verifiedRecovery?.accountHash;
    let accountHash: string | undefined;
    if (responseAccount) {
      const candidate = mediaTaskAccountHash(responseAccount);
      if (candidate && trustedAccountHash && candidate === trustedAccountHash) {
        accountHash = candidate;
        verified.push("account");
      } else unverifiable.push("account");
    } else unverifiable.push("account");
    return { ok: true, verified, unverifiable, upstreamState, ...(accountHash ? { accountHash } : {}) };
  } catch (error) {
    return {
      ok: false, verified: [], unverifiable: [],
      reason: providerErrorMessage(undefined, error) || "上游核对查询失败，未绑定",
    };
  } finally {
    attempt.done();
  }
}

/* -------------------------------------------------------------- 任务更新 */

/** 终态（succeeded/failed/cancelled）不可再被跟进更新覆盖；unknown 仍可被核对后继续。 */
function taskPlan(predicate: (task: MediaTaskRecord) => boolean, apply: (task: MediaTaskRecord) => void) {
  return (current: MediaTaskRecord) => {
    if (isFinishedMediaTaskState(current.state)) return undefined;
    if (!predicate(current)) return undefined;
    return apply;
  };
}

/** 已结束：任务明确失败（上游业务失败或提交前校验失败）。 */
async function markTaskFailed(taskId: string, message: string, upstreamState?: string) {
  return updateMediaTask(taskId, taskPlan(() => true, task => {
    task.state = "failed";
    task.error = message.slice(0, 2000);
    task.trackingStatus = undefined;
    task.waitingReason = undefined;
    if (upstreamState) task.lastUpstreamState = upstreamState;
    task.completedAt = new Date().toISOString();
    task.retryAt = undefined;
    task.retryCount = undefined;
  }));
}

/** 待核对：提交结果不确定（无上游 ID）。不自动重提，关联与输入保留；用户暂停跟进时不被改回 active。 */
async function markTaskUnknown(taskId: string, message: string) {
  return updateMediaTask(taskId, taskPlan(() => true, task => {
    task.state = "unknown";
    task.error = message.slice(0, 2000);
    if (mediaTaskTrackingStatus(task) !== "paused") {
      task.trackingStatus = "active";
      task.waitingReason = undefined;
    }
    task.retryAt = undefined;
    task.retryCount = undefined;
    task.completedAt = undefined;
  }));
}

/** 受阻：凭据/兼容问题，停止密集重试，等待 resume；业务主状态不变，未来 retryAt 下限保留。 */
async function markTaskBlocked(taskId: string, reason: string) {
  return updateMediaTask(taskId, taskPlan(() => true, task => {
    task.trackingStatus = "blocked";
    task.waitingReason = reason.slice(0, 2000);
    clearExpiredMediaTaskRetryAt(task);
    task.retryCount = undefined;
  }));
}

async function markTaskCancelled(taskId: string, options: { reason?: string; upstreamCancellation?: boolean; upstreamState?: string } = {}) {
  pendingAssets.delete(taskId);
  return updateMediaTask(taskId, taskPlan(() => true, task => {
    task.state = "cancelled";
    task.cancellationRequested = true;
    if (options.upstreamCancellation !== undefined) task.upstreamCancellation = options.upstreamCancellation;
    if (options.reason) task.error = options.reason.slice(0, 2000);
    task.trackingStatus = undefined;
    task.waitingReason = undefined;
    if (options.upstreamState) task.lastUpstreamState = options.upstreamState;
    task.completedAt = new Date().toISOString();
    task.retryAt = undefined;
    task.retryCount = undefined;
  }));
}

/**
 * 「显式未尝试」任务的恢复收尾（T09 + 取消语义）：新格式 pending 且无提交尝试时间 → 确定未发上游。
 * - 用户已取消（cancellationRequested）：按本地取消收尾，不声称上游取消、不占保守额度，
 *   不把取消意图盖成“提交前失败、可重新提交”；
 * - 否则记提交前失败（确定未提交，不占保守额度、不写 unknown）。
 * 两个分支使用同等证据（显式 pending），不放宽保守主线：缺字段的旧格式或已尝试一律仍按 unknown 处理。
 */
async function finalizeUnattemptedSubmission(taskId: string, cancellationRequested: boolean) {
  if (cancellationRequested) {
    await markTaskCancelled(taskId, { upstreamCancellation: false });
    return;
  }
  await markTaskFailed(taskId, "任务在提交前中断（尚未开始网络尝试），上游未被受理，可重新提交");
}

/** 记录一次查询尝试结果（成功或失败）并安排下一次跟进时间。 */
async function scheduleQueryFollowUp(taskId: string, input: {
  queriedAt: string;
  delayMs: number;
  succeeded?: boolean;
  upstreamState?: string;
  waitingReason?: string;
  countFailure?: boolean;
}) {
  return updateMediaTask(taskId, taskPlan(task => task.state === "running" || task.state === "downloading", task => {
    task.lastQueryAt = input.queriedAt;
    task.retryAt = new Date(Date.now() + input.delayMs).toISOString();
    task.retryCount = input.countFailure ? (task.retryCount ?? 0) + 1 : 0;
    if (input.succeeded) task.lastQuerySucceededAt = input.queriedAt;
    if (input.upstreamState) task.lastUpstreamState = input.upstreamState;
    // T06：上游退避事实（retryAt/上游状态）照常合并，但迟到回调不得覆盖用户明确表达的暂停/取消原因。
    const userIntent = mediaTaskTrackingStatus(task) !== "active" || task.cancellationRequested;
    if (input.waitingReason !== undefined && !userIntent) task.waitingReason = input.waitingReason.slice(0, 2000);
  }));
}

/* ---------------------------------------------------------------- 作业信号 */

type MediaTaskAttempt = {
  signal: AbortSignal;
  done: () => void;
  timedOut: () => boolean;
  /** 真正开始网络尝试时才启动限时；本地准备（供应商加载、快照读取）不计入提交预算（契约 v3 §C.5）。 */
  start: (timeoutMs?: number) => void;
};

/**
 * 单次网络尝试的信号：合并作业信号与本次尝试超时。
 * 一次尝试被中断后不复用已经 aborted 的 controller，下次尝试重新创建（契约 B）。
 */
function createAttempt(jobSignal: AbortSignal, timeoutMs = 0): MediaTaskAttempt {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const start = (ms = timeoutMs) => {
    if (timer || ms <= 0) return;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(Object.assign(new Error("网络尝试超时"), { name: "MediaTaskAttemptTimeout" }));
    }, ms);
    timer.unref?.();
  };
  const abort = () => controller.abort(jobSignal.reason);
  if (jobSignal.aborted) abort();
  else jobSignal.addEventListener("abort", abort, { once: true });
  start();
  return {
    signal: controller.signal,
    done: () => {
      if (timer) clearTimeout(timer);
      jobSignal.removeEventListener("abort", abort);
    },
    timedOut: () => timedOut,
    start,
  };
}

/* ------------------------------------------------------------ 结果落盘/登记 */

async function lockWorkspaceFilesWithRetry(paths: string[], attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return lockWorkspaceFiles(paths);
    } catch (error) {
      if (attempt >= attempts || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      await sleep(50 * attempt);
    }
  }
}

/**
 * 同一路径锁内完成「登记围栏 → 核实/写入 → 登记完成」（Q6/R08，C 的围栏协议）：
 * 写文件之前先落盘持久保护，complete() 失败时围栏保留（供清理前恢复重试）并把错误传播给调用方；
 * 本地核实/写入失败时撤销围栏并传播。禁止 warn 后继续成功。
 * T17：必须同时提供本次将要发布内容的身份（size + sha256），覆盖写崩溃后恢复才能区分
 * 「仍是旧内容」与「新内容已原子发布但登记未完」并自动重登记；不传时（若将来出现拿不到内容身份的
 * 调用路径）恢复只能保守保留围栏待核对，不会自动恢复——Q 的结果落盘是内容寻址写入，
 * 始终能给出 bytes 长度与 sha256，因此该保守路径不应在新调用点出现。
 */
async function withRegisteredOutput(input: {
  path: string;
  directory: string;
  mediaKind: "image" | "video" | "audio";
  taskId: string;
  /** 本次将要发布的内容身份（T17）；缺失时覆盖写恢复不会自动重登记，只保留围栏待核对。 */
  expectedContent?: { size: number; sha256: string };
  /** 锁内核实/写入真实文件；抛错表示本次登记失败（围栏撤销、错误传播）。 */
  prepare: () => Promise<void>;
}): Promise<void> {
  const release = await lockWorkspaceFilesWithRetry([input.path]);
  try {
    const guard = await beginFileRegistrationProtection({
      path: input.path, directory: input.directory, sourceKind: "generated", mediaKind: input.mediaKind, refs: [`task:${input.taskId}`],
    }, input.expectedContent ? { expectedContent: input.expectedContent } : {});
    try {
      await input.prepare();
    } catch (error) {
      await guard.abort().catch(() => undefined);
      throw error;
    }
    await guard.complete();
  } finally {
    release();
  }
}

/**
 * 已有同名输出按真实内容认回（F15/Q6）：文件名内容寻址，但仍必须核对普通文件与真实 SHA-256；
 * 只看长度会误认同长度不同内容的文件。内容不一致（或读取失败）时按需重写。
 */
async function outputContentMatches(path: string, sha256: string) {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isFile()) return false;
  const current = await readFile(path).catch(() => null);
  if (!current) return false;
  return createHash("sha256").update(current).digest("hex") === sha256;
}

/**
 * 结果落盘（F15）：内容寻址文件名，同一 sha256 固定同一路径。
 * 落盘与登记之间崩溃后按真实 SHA-256 认回已有文件，不产生失联重复文件。
 * 文件写入与归属登记在同一路径锁内按围栏协议完成，登记失败保留保护并向调用方传播。
 */
async function saveTaskOutput(task: MediaTaskRecord, bytes: Buffer, mimeType: string, sha256: string, signal?: AbortSignal) {
  const directory = task.directory;
  const requested = task.request.outputDirectory;
  const outputDirectory = typeof requested === "string" && requested.trim() ? requested : "assets/generated";
  const fileName = contentAddressedMediaName(task.mediaType, mimeType, sha256);
  const folder = await resolveWorkspacePath(directory, outputDirectory, true);
  await mkdir(folder.path, { recursive: true });
  const target = await resolveWorkspacePath(directory, join(outputDirectory, fileName));
  signal?.throwIfAborted();
  // 锁顺序（契约 v3 §E.1）：任务锁（如需）→ 一次取得目标路径锁 → fileRecords 串行登记。
  await withRegisteredOutput({
    path: target.path, directory, mediaKind: task.mediaType, taskId: task.taskId,
    // T17：内容寻址写入的内容身份就是本次将要发布的事实（bytes 真实长度 + 校验过的 sha256），
    // 覆盖写崩溃恢复据此可确认「新内容已原子发布」而自动重登记，而不是只留围栏待核对。
    expectedContent: { size: bytes.length, sha256 },
    prepare: async () => {
      // ACT: 已存在且真实内容一致的普通文件直接认回；否则原子覆盖写（不靠长度判断）。
      if (!await outputContentMatches(target.path, sha256)) {
        // §P.3/R2（追加）：未完成改名事务端点（含其祖先目录，如 assets/generated 整体改名）期间，
        // 新任务输出不得落进去换内容/改目录 mtime——真实写入前消费统一保护判定，命中即拒绝
        // （内容一致认回不发生写入，按不拦截处理，见上方 outputContentMatches）。
        const relocationBlock = await findFileRelocationWriteBlock(target.path);
        if (relocationBlock) throw Object.assign(new Error(relocationBlock.message), { code: "ERELOCATING", status: 409 });
        await writeWorkspaceFile(target.path, bytes);
      }
    },
  });
  return {
    path: relative(directory, target.path).replaceAll("\\", "/"),
    mimeType, mediaType: task.mediaType, sha256,
  } satisfies MediaTaskOutput;
}

/* ------------------------------------------------------------------ 作业 */

type JobKind = "generate" | "query" | "download";
type JobHandle = { kind: JobKind; controller: AbortController };
const jobs = new Map<string, JobHandle>();
/** 查询刚拿到的结果定位信息（内存缓存；重启后由下载作业重新查询取得）。 */
const pendingAssets = new Map<string, MediaAsset[]>();
let ticking = false;
let schedulerTimer: ReturnType<typeof setInterval> | undefined;
let startTimer: ReturnType<typeof setTimeout> | undefined;
let schedulerStarted = false;
let lastTickAt: string | undefined;
let recoveryState: { settled: boolean; error?: string; recoveredAt?: string } = { settled: false };
/** 逐项恢复错误（已去敏）；非空表示台账/保护/在途数量未能完全确认，就绪必须为 false。 */
let recoveryErrors: string[] = [];
/** 恢复过程进行中：此时不能声称 ready。 */
let recovering = false;
/**
 * 停机排空结果（内部超时保护下仍要可诊断；T02 要求各阶段实际预算与真实宽限可读）：
 * abortGraceRequestedMs 是请求值，abortGraceAvailableMs 是本次真正可用的宽限，
 * abortWaitedMs 是真实等待耗时；三者不一致时说明宽限并未按请求值兑现，不得据请求值宣称已兑现。
 */
export type MediaTaskDrainOutcome = {
  completed: boolean; reason: string; at: string;
  pendingJobs: number; pendingWrites: number; pendingInflight: number;
  /** 中止后真实等待到的收尾时间（T02 证据）。 */
  abortWaitedMs?: number;
  /** 本次为最终持久写预留的时间（请求值）。 */
  finalWriteReserveMs?: number;
  /** 传入/推导的 abort 宽限请求值。 */
  abortGraceRequestedMs?: number;
  /** 本次实际可用的 abort 宽限（可能被前段预算压缩为更小值或 0）。 */
  abortGraceAvailableMs?: number;
  /** 请求宽限是否被压缩（true = 本次收尾并非按请求值兑现）。 */
  abortGraceTruncated?: boolean;
  /** 中止等待窗内是否所有作业都已退出（未发生中止时为 true；false 表示耗尽可用宽限或仍有作业）。 */
  abortGraceSufficient?: boolean;
  /** 最终写队列实际可用的时间（与预留请求值区分）。 */
  finalWriteAvailableMs?: number;
  /** 排空开始/结束时间与总耗时（T02：各阶段实际开始/结束可读）。 */
  startedAt?: string;
  finishedAt?: string;
  totalMs?: number;
};
/** 停机排空结果（内部超时保护下仍要可诊断）。 */
let drainOutcome: MediaTaskDrainOutcome | undefined;
/**
 * 进程级 stopping（契约 v3 §A.1）：置真后拒绝新受理、新作业、迟到 tick 与恢复派发；
 * 在途作业与关键落盘（含已取得 upstreamId 的临界段）继续收敛到结束。
 */
let stopping = false;
/** 停机排空只执行一次：并发调用共享同一收敛 Promise（幂等）。 */
let drainingPromise: Promise<void> | undefined;

/** 停机状态：受理入口、调度 tick、作业派发与恢复派发都据此拒绝。 */
export function isMediaTasksStopping() {
  return stopping;
}

export function hasMediaTaskJob(taskId: string) {
  return jobs.has(taskId);
}

/** 中止本机作业（下载中取消）；状态由调用方显式持久化。 */
export function abortMediaTaskJob(taskId: string) {
  jobs.get(taskId)?.controller.abort();
}

function countJobs(kind: JobKind) {
  let total = 0;
  for (const job of jobs.values()) if (job.kind === kind) total += 1;
  return total;
}

/**
 * 保护/归属就绪（T03）：消费 C 的归属存储健康快照（同一份现有导出，Q/C 共用同一判据）。
 * 保护未知（尚未加载完成、保护表故障未显式核对、释放时间表故障）时一律视为未就绪，
 * 新收费创建不得派发；加载重试由 C 的清理初始化与 status/health 探测触发，Q 不复制一份状态。
 */
function mediaTaskProtectionReadiness() {
  const health = fileRecordsStoreHealthSnapshot();
  const reason = health.ok ? undefined : (health.error ?? "文件保护/归属存储状态未知");
  return { ready: health.ok === true, ...(reason ? { reason } : {}) };
}

export type MediaTasksDispatchReadiness = {
  ready: boolean;
  /** 未就绪的可诊断原因（已去敏）。 */
  reason?: string;
  /** 保护/归属存储是否明确可用（T03 新增判据）。 */
  protectionReady: boolean;
  /** 保护不可用时的原因。 */
  protectionReason?: string;
  /** 是否处于全局暂停（§N.1 新创建门的一部分；受理排队与查询/取消不受影响）。 */
  paused: boolean;
};

/**
 * 唯一新创建准入判据（契约 v4 §B/T03，§N.1 扩展）：存储已装载 && 恢复 settled && 非 recovering && 非 stopping
 * && 无恢复错误 && 装载告警已纳入判定 && **保护/归属存储明确可用** && **未全局暂停（settings.mediaTasks.paused）**。
 * 所有真实创建入口（后台调度、I 的旧同步入口与 Agent/节点同步路径）都必须复用这个判据；
 * 受理仍可按契约接收入队（queued 等待门打开），查询/取消/下载补取不受 paused 影响，不算违规。
 */
export function mediaTasksDispatchReadiness(): MediaTasksDispatchReadiness {
  return computeCreationReadiness(true);
}

/**
 * 兼容视图（I 集成补充）：**不含**「全局暂停」的恢复/保护就绪，保持旧 `schedulerReady` 的语义
 * （「恢复完成、可承接派发」），避免把「用户主动暂停」误报成「调度器未就绪」。
 * 统一新创建门仍以 `mediaTasksDispatchReadiness()` 为准（health 的 creationReady 字段）。
 */
export function mediaTasksRecoveryReadiness(): MediaTasksDispatchReadiness {
  return computeCreationReadiness(false);
}

function computeCreationReadiness(checkPaused: boolean): MediaTasksDispatchReadiness {
  const protection = mediaTaskProtectionReadiness();
  const paused = mediaTasksRuntimeSettings().paused;
  const blocked = (reason: string): MediaTasksDispatchReadiness => ({
    ready: false, reason, protectionReady: protection.ready, paused,
    ...(protection.reason ? { protectionReason: protection.reason } : {}),
  });
  if (stopping) return blocked("服务正在停止，不再派发新生成");
  if (!mediaTasksStoreLoaded()) return blocked("任务台账尚未装载完成");
  if (recovering) return blocked("任务台账恢复进行中");
  if (!recoveryState.settled) return blocked("任务台账恢复尚未完成");
  if (recoveryState.error) return blocked(`任务台账恢复失败：${recoveryState.error}`);
  if (recoveryErrors.length > 0) return blocked(`恢复存在逐项错误：${recoveryErrors[0]}`);
  const warnings = mediaTaskStoreLoadWarnings();
  if (warnings.length > 0) return blocked(`任务台账装载告警未清：${warnings[0]}`);
  if (!protection.ready) return blocked(`文件保护/归属存储未就绪：${protection.reason ?? "状态未知"}`);
  // 全局暂停属于「新创建」门（§N.1）：同步入口与后台派发必须得到同一结论；排队受理继续可用。
  if (checkPaused && paused) return blocked("已全局暂停（settings.mediaTasks.paused=true）：不发起新的上游创建与下载补取，排队受理与查询/取消不受影响");
  return { ready: true, protectionReady: true, paused };
}

/** 布尔别名：现有调用方（健康摘要、派发入口）继续使用。 */
export function mediaTasksReadyForDispatch() {
  return mediaTasksDispatchReadiness().ready;
}

/**
 * 已准入但尚未发布 `submitting` 的生成作业容量预约（契约 v4 §C/T04）：
 * generate job 已登记（可能仍在等批次锁/写盘）时公开状态还是 queued，
 * 如果不计入在途，下一 tick 会按台账状态误判还有余量而超额放行。
 * 与已计入上游在途额度的任务去重（同一任务只计一次）；失败/取消/停机后作业退出即归还。
 */
export function countGenerationReservations() {
  let total = 0;
  for (const [taskId, job] of jobs) {
    if (job.kind !== "generate") continue;
    const task = getMediaTask(taskId);
    // 已按业务状态计入上游在途额度的任务不重复预约；任务缺失也保守计入，直到作业退出。
    if (task && occupiesUpstreamSlot(task)) continue;
    total += 1;
  }
  return total;
}

/** 实际准入的生成数量（上游在途 + 预约）：容量判断与验收都按这个数，不只看台账状态。 */
export function countAdmittedGenerations() {
  return listMediaTasks().filter(occupiesUpstreamSlot).length + countGenerationReservations();
}

function startJob(taskId: string, kind: JobKind, runner: (signal: AbortSignal) => Promise<void>) {
  if (stopping || jobs.has(taskId)) return;
  // T03：新收费创建的最终防线也必须走唯一就绪判据（保护/归属未知、台账未就绪时任何一个派发入口都不能开工）。
  if (kind === "generate" && !mediaTasksReadyForDispatch()) return;
  const controller = new AbortController();
  jobs.set(taskId, { kind, controller });
  void runner(controller.signal)
    .catch(error => console.warn(`媒体任务作业异常：${taskId}`, error))
    .finally(() => {
      if (jobs.get(taskId)?.controller === controller) jobs.delete(taskId);
    });
}

function toProviderRequest(task: MediaTaskRecord, inputs: MediaTaskReferenceInputs): ImageRequest | VideoRequest | AudioRequest {
  const request = task.request;
  const model = task.modelId;
  if (task.mediaType === "audio") {
    return {
      model, text: request.prompt as string, images: inputs.images, audios: inputs.audios,
      voice: request.voice as string | undefined, speed: request.speed as number | undefined,
      volume: request.volume as number | undefined, pitch: request.pitch as number | undefined,
      language: request.language as string | undefined, format: request.format as string | undefined,
      sampleRate: request.sampleRate as number | undefined,
    };
  }
  if (task.mediaType === "image") {
    return {
      model, prompt: request.prompt as string, images: inputs.images,
      ratio: request.ratio as string | undefined, size: request.size as string | undefined,
    };
  }
  return {
    model, prompt: request.prompt as string, images: inputs.images, videos: inputs.videos, audios: inputs.audios,
    firstFrame: inputs.firstFrame, lastFrame: inputs.lastFrame,
    ratio: request.ratio as string | undefined, resolution: request.resolution as string | undefined,
    duration: request.duration as number | undefined, generateAudio: request.generateAudio as boolean | undefined,
    mode: request.mode as VideoRequest["mode"],
  };
}

/** 提交阶段失败：只有确定未受理才 failed，其余保留提交键进入待核对（不自动重提）。 */
async function markSubmitFailure(taskId: string, provider: LoadedMediaProvider | undefined, error: unknown) {
  const info = classifyMediaTaskError(error, "submit");
  const message = providerErrorMessage(provider, error) || "提交上游失败";
  if (info.followUp === "failed") {
    await markTaskFailed(taskId, message);
    return;
  }
  await markTaskUnknown(taskId, `${message}（提交结果不确定，不会自动重提）`);
}

/**
 * 提交网络尝试前的统一门槛（契约 v4 §F/T09）：本地准备（供应商加载、快照读取、校验）完成后才到这里。
 * 1) 此时用户已取消且确定未发上游 → 本地取消，不产生费用；
 * 2) 用「本次条件更新是否真正生效」证明提交许可，而不是把 updateMediaTask 返回的旧对象当许可：
 *    取消正在落盘、提交门先看到尚未发布的旧状态并排在其后的交错下，锁内条件更新会被拒绝，
 *    此时绝不能继续调用上游（T09 第 1 条）。
 * 3) 落盘成功后还要按最新持久状态复核（submitting、未取消、已记录提交尝试事实），三态一致性通过才放行。
 * 4) 持久化「提交尝试事实」submissionAttemptState=attempted + submissionAttemptedAt：只有写入该事实后的
 *    中断才是「可能已受理」，恢复按 unknown 保守处理；显式 pending 才是「确定未提交」。
 * 返回 false 表示不应继续发起网络尝试。
 */
async function markSubmissionAttempt(taskId: string, signal: AbortSignal) {
  if (signal.aborted) return false;
  const latest = getMediaTask(taskId);
  if (!latest || latest.state !== "submitting") return false;
  if (latest.cancellationRequested) {
    await markTaskCancelled(taskId, { upstreamCancellation: false });
    return false;
  }
  const attemptedAt = new Date().toISOString();
  let applied = false;
  try {
    // 条件许可：只有锁内读到的最新持久状态仍是「待提交且未取消」时才写提交尝试事实。
    const outcome = await updateMediaTaskIfApplied(taskId, current => {
      if (current.state !== "submitting" || current.cancellationRequested) return undefined;
      if (current.upstreamId) return undefined;
      return record => {
        applied = true;
        record.submissionAttemptState = "attempted";
        record.submissionAttemptedAt ??= attemptedAt;
      };
    });
    if (!applied || !outcome.task) {
      // 条件更新未生效：最常见的原因是「取消已可靠落盘」（锁内读到 cancellationRequested 而被拒绝）。
      // 无论哪种情况本次都没有发起网络尝试，因此这里可以确定未提交 → 对已落盘的取消意图做本地取消收尾，
      // 不把任务留在 submitting 让恢复流程当成“提交前中断/受理不明”。
      const blocked = getMediaTask(taskId);
      if (blocked?.state === "submitting" && blocked.cancellationRequested && !blocked.upstreamId) {
        await markTaskCancelled(taskId, { upstreamCancellation: false });
      }
      return false;
    }
  } catch (error) {
    // 提交尝试事实无法可靠落盘：确定未提交（不能把“写不出事实”当成已发上游），也必须停止后续网络调用。
    await markTaskFailed(taskId, `提交前无法记录提交尝试事实：${errorMessageOf(error) || "写入任务台账失败"}（任务未提交上游，可重新提交）`)
      .catch(() => undefined);
    return false;
  }
  if (signal.aborted) return false;
  // 最新持久状态复核：许可落盘后被取消的任务不得再发起新收费创建（T09/T10）。
  const confirmed = getMediaTask(taskId);
  if (!confirmed || confirmed.state !== "submitting") return false;
  if (confirmed.upstreamId) return false;
  if (confirmed.cancellationRequested) {
    // 提交许可落盘后、真正发起网络尝试之前观察到取消：确定未发上游 → 本地取消，不产生费用。
    await markTaskCancelled(taskId, { upstreamCancellation: false });
    return false;
  }
  if (confirmed.submissionAttemptState !== "attempted") return false;
  return true;
}

/**
 * 异步供应商：只做一次提交尝试并立即持久化上游 ID，查询交给独立的一次性查询作业。
 * Q2/R01：一旦拿到 upstreamId，任何 abort/停机分支都不得跳过持久化；保存时合并最新 pause/cancel 意图。
 */
async function runAsyncSubmit(taskId: string, provider: LoadedMediaProvider, signal: AbortSignal, attempt: MediaTaskAttempt) {
  const task = getMediaTask(taskId);
  if (!task || task.state !== "submitting") return;
  let request: ImageRequest | VideoRequest | AudioRequest;
  try {
    // ACT: 读取输入快照属于本地准备，不占用提交的 90 秒网络预算（契约 v3 §C.5）。
    request = toProviderRequest(task, await buildSnapshotInputs(task.inputSnapshots, signal));
  } catch (error) {
    // 本地准备失败确定未提交：记提交前失败，不占保守额度、也不转 unknown。
    if (signal.aborted) return;
    await markSubmitFailure(taskId, provider, error);
    return;
  }
  if (signal.aborted) return;
  const submitMedia = provider.submitMedia;
  if (typeof submitMedia !== "function") {
    // 提交能力在受理后被移除：确定未发上游，按提交前失败收尾，不空转到 unknown。
    await markTaskFailed(taskId, "供应商已不再提供异步提交能力，任务未提交上游，可重新提交");
    return;
  }
  // 本地准备完成、真正开始网络尝试之前：持久化提交尝试事实（取消检查也在同一门槛内）。
  if (!await markSubmissionAttempt(taskId, signal)) return;
  // 提交网络尝试从真正开始调用时计时（本地准备不计入）；供应商 this.signal 已在加载时绑定该尝试信号。
  attempt.start(submitAttemptTimeoutMs);
  let upstreamId = "";
  try {
    const result = await submitMedia.call(provider, request);
    upstreamId = typeof result?.upstreamId === "string" ? result.upstreamId.trim() : "";
    if (!upstreamId) throw taskLifecycleError("供应商未返回上游任务 ID", "failed");
  } catch (error) {
    if (signal.aborted) {
      // 请求可能已经发出：无法证明未受理，保留提交键进入待核对（不自动重提）。
      await markSubmitFailure(taskId, provider, Object.assign(new Error("提交被中断，受理结果不确定"), { followUp: "unknown" }));
      return;
    }
    await markSubmitFailure(taskId, provider, error);
    return;
  }
  // Q2/R01：此处不再因 signal.aborted 直接返回——上游 ID 是必须保住的业务事实。
  // 上游 ID 立即持久化（停机/宽限都由写队列排空保证完成），并合并最新 pause/cancel 意图。
  const now = new Date().toISOString();
  await updateMediaTask(taskId, taskPlan(
    current => !current.upstreamId && (current.state === "submitting" || current.state === "unknown" || current.state === "running"),
    current => {
      current.upstreamId = upstreamId;
      current.submittedAt = now;
      current.state = "running";
      // 提交期间用户暂停跟进时保留 paused，不得改回 active（契约 v3 §B）。
      if (mediaTaskTrackingStatus(current) !== "paused") {
        current.trackingStatus = "active";
        current.waitingReason = undefined;
      }
      current.error = undefined;
      current.lastUpstreamState = "submitted";
      current.retryAt = new Date(Date.now() + queryStageDelayMs(0)).toISOString();
      current.retryCount = 0;
    },
  ));
  // 提交期间已被取消：尽力中止上游，避免留下无人认领的付费任务。
  const latest = getMediaTask(taskId);
  if (latest?.cancellationRequested && latest.upstreamId === upstreamId) {
    const confirmed = await cancelUpstream(provider, upstreamId);
    if (confirmed) await markTaskCancelled(taskId, { upstreamCancellation: true, upstreamState: "cancelled" });
  }
}

/**
 * 同步供应商：在服务进程内后台执行 provider.generate*（无上游 ID，中断即待核对，不自动重提）。
 * T09/契约 v4 §F：输入一律用受理时持久快照构造（不再重新读取工作区原文件），
 * 排队期间原图被修改/删除不影响任务输入，也不会在「校验后、读取前」静默提交另一张图；
 * 结果继续走受限流式取回 + 内容寻址登记（单文件 ≤ 100MB、MIME 以文件头为准）。
 */
async function runSyncTask(taskId: string, provider: LoadedMediaProvider, signal: AbortSignal) {
  const task = getMediaTask(taskId);
  if (!task || task.state !== "submitting") return;
  let inputs: MediaTaskReferenceInputs;
  try {
    inputs = await buildSnapshotInputs(task.inputSnapshots, signal);
  } catch (error) {
    // 本地准备失败（确定未提交）：记提交前失败，不占保守额度、也不转 unknown。
    if (signal.aborted) return;
    await markSubmitFailure(taskId, provider, error);
    return;
  }
  if (signal.aborted) return;
  const latest = getMediaTask(taskId);
  if (!latest || latest.state !== "submitting") return;
  // 本地准备完成、真正开始网络尝试之前：持久化提交尝试事实（同步供应商同样与 submitting 状态分开）。
  if (!await markSubmissionAttempt(taskId, signal)) return;
  const request = toProviderRequest(latest, inputs);
  let assets: MediaAsset[];
  try {
    if (latest.mediaType === "image") {
      if (typeof provider.generateImage !== "function") throw taskLifecycleError("供应商已不再提供图片生成能力，任务未提交上游，可重新提交", "failed");
      assets = await provider.generateImage.call(provider, request as ImageRequest);
    } else if (latest.mediaType === "video") {
      if (typeof provider.generateVideo !== "function") throw taskLifecycleError("供应商已不再提供视频生成能力，任务未提交上游，可重新提交", "failed");
      assets = await provider.generateVideo.call(provider, request as VideoRequest);
    } else {
      if (typeof provider.generateAudio !== "function") throw taskLifecycleError("供应商已不再提供音频生成能力，任务未提交上游，可重新提交", "failed");
      assets = await provider.generateAudio.call(provider, request as AudioRequest);
    }
  } catch (error) {
    if (signal.aborted) return;
    // 提交阶段错误分类：确定未受理才 failed，其余（含超时/网络中断）保留待核对，不自动重提。
    await markSubmitFailure(taskId, provider, error);
    return;
  }
  if (!Array.isArray(assets) || !assets.length) {
    await markSubmitFailure(taskId, provider, Object.assign(new Error("供应商未返回生成结果"), { followUp: "unknown" }));
    return;
  }
  const authorization = downloadAuthorizationOf(provider);
  const outputs: MediaTaskOutput[] = [];
  /** 已可靠保存结果立即持久化：任何失败/中止分支都不得丢弃（契约 v3 §A.3）。 */
  const persistSavedOutputs = async () => {
    if (!outputs.length) return;
    await updateMediaTask(taskId, taskPlan(() => true, current => {
      const known = new Set(current.outputs.map(output => output.path));
      for (const output of outputs) if (!known.has(output.path)) current.outputs.push(output);
    }));
  };
  try {
    for (const asset of assets) {
      signal?.throwIfAborted();
      const { bytes, mimeType } = await assetBytes(asset, latest.mediaType, signal, { authorization, idleTimeoutMs: downloadIdleTimeoutMs });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      outputs.push(await saveTaskOutput(latest, bytes, mimeType, sha256, signal));
    }
  } catch (error) {
    await persistSavedOutputs().catch(persistError => {
      console.warn(`媒体任务部分输出登记失败：${taskId}`, persistError);
    });
    if (signal.aborted) return;
    const message = providerErrorMessage(provider, error) || errorMessageOf(error) || "生成结果保存失败";
    // 上游已生成但结果未能可靠落盘/登记：保持失败可诊断，已保存的部分输出保留，登记保护可恢复重试。
    await markTaskFailed(taskId, `生成完成但结果保存失败：${message}（已保存的部分输出保留在工作区；不会自动重新生成）`);
    return;
  }
  // 全部结果已可靠保存：即使此刻收到 abort/停机，也不跳过本次终态持久化。
  await updateMediaTask(taskId, taskPlan(current => current.state === "submitting", record => {
    const known = new Set(record.outputs.map(output => output.path));
    for (const output of outputs) if (!known.has(output.path)) record.outputs.push(output);
    record.state = "succeeded";
    record.completedAt = new Date().toISOString();
    record.trackingStatus = undefined;
    record.waitingReason = undefined;
    record.error = undefined;
    record.lastUpstreamState = "succeeded";
  }));
}

async function runGenerationJob(taskId: string, signal: AbortSignal) {
  // Q3：派发瞬间重查跟进标记——调度选中后用户暂停的任务不得被改回 active 并提交上游。
  const started = await updateMediaTask(taskId, taskPlan(
    current => current.state === "queued" && !current.cancellationRequested && mediaTaskTrackingStatus(current) === "active",
    task => {
      task.state = "submitting";
      task.error = undefined;
      clearExpiredMediaTaskRetryAt(task);
      task.retryCount = undefined;
      task.waitingReason = undefined;
      task.trackingStatus = "active";
      task.submittedAt ??= new Date().toISOString();
    },
  ));
  if (!started || started.state !== "submitting") return;
  const task = getMediaTask(taskId);
  if (!task) return;
  // 供应商加载属于本地准备，不计入提交网络预算；提交限时在真正发起网络请求前启动（runAsyncSubmit）。
  // 同步供应商整段生成沿用作业信号，由供应商自身超时控制。
  const attempt = createAttempt(signal);
  let provider: LoadedMediaProvider;
  try {
    provider = await loadTaskProvider(task, attempt.signal, "submit");
  } catch (error) {
    attempt.done();
    if (signal.aborted) return;
    await markSubmitFailure(taskId, undefined, error);
    return;
  }
  if (signal.aborted) {
    attempt.done();
    return;
  }
  // 首次执行分流（R11/契约 v3 §C.1）：submitMedia+queryMedia 成对 → 持久异步；
  // 否则用原 generate* 在服务进程内后台执行（同步供应商同样受理，不再被 asyncMedia 硬门拒绝）。
  const canPersistAsync = typeof provider.submitMedia === "function" && typeof provider.queryMedia === "function";
  try {
    if (canPersistAsync) {
      await runAsyncSubmit(taskId, provider, signal, attempt);
      return;
    }
    await runSyncTask(taskId, provider, signal);
  } finally {
    attempt.done();
  }
}

/** 查询失败后的跟进：退避重试 / 受阻 / 待核对 / 业务失败，都不重新提交上游。 */
async function applyFollowUpFailure(taskId: string, provider: LoadedMediaProvider | undefined, error: unknown, phase: MediaTaskPhase) {
  const info = classifyMediaTaskError(error, phase);
  const base = providerErrorMessage(provider, error) || (phase === "query" ? "查询上游任务失败" : "下载生成结果失败");
  // ACT: 本地单次尝试超时不代表上游失败，文案里说清原任务仍按 ID 保留。
  const message = info.timeout ? `${base}（本次尝试超时，原任务与上游 ID 保留，稍后继续）` : base;
  const queriedAt = new Date().toISOString();
  const task = getMediaTask(taskId);
  const attempt = (task?.retryCount ?? 0) + 1;
  if (info.followUp === "failed") {
    await markTaskFailed(taskId, message);
    return;
  }
  if (info.followUp === "unknown") {
    await markTaskUnknown(taskId, `${message}（提交结果不确定，不会自动重提）`);
    return;
  }
  if (info.followUp === "blocked") {
    await markTaskBlocked(taskId, waitingReasonOf(error) ?? message);
    return;
  }
  const pendingReview = info.followUp === "pendingReview";
  const delay = pendingReview
    ? Math.max(info.retryAfterMs ?? 0, jitter(longWaitRetryDelayMs))
    : retryDelayMsFor(info, attempt);
  await scheduleQueryFollowUp(taskId, {
    queriedAt,
    delayMs: delay,
    countFailure: true,
    // ACT: 查询失败不覆盖上游最近一次已知状态，具体错误写进 waitingReason。
    waitingReason: pendingReview ? `${message}（待核对/无法补取，继续按原任务查询）` : message,
  });
}

/**
 * 查询结果套用：running 继续阶段频率，succeeded 进入下载，failed/cancelled 收尾。
 * Q3/R02：迟到回调只能记录上游事实，不得把 paused/blocked 改回 active，也不得越过暂停派下载。
 */
async function applyQueryResult(taskId: string, provider: LoadedMediaProvider, result: ProviderMediaTaskState) {
  const status = typeof result?.status === "string" ? result.status : "";
  const rawState = typeof (result as { upstreamState?: unknown }).upstreamState === "string" ? String((result as { upstreamState?: unknown }).upstreamState) : "";
  const queriedAt = new Date().toISOString();
  const task = getMediaTask(taskId);
  if (!task) return;
  if (status === "failed") {
    // 上游明确业务失败：即使暂停跟进也照实记录，不把失败伪装成进行中。
    await markTaskFailed(taskId, providerErrorMessage(provider, result.error) || "上游生成失败", rawState || status);
    return;
  }
  if (status === "cancelled") {
    await markTaskCancelled(taskId, { upstreamCancellation: true, upstreamState: rawState || status });
    return;
  }
  if (status === "succeeded") {
    const assets = Array.isArray(result.assets) ? result.assets : [];
    if (assets.length) pendingAssets.set(taskId, assets);
    await updateMediaTask(taskId, taskPlan(current => current.state === "running" || current.state === "downloading", record => {
      record.state = "downloading";
      record.error = undefined;
      record.lastQueryAt = queriedAt;
      record.lastQuerySucceededAt = queriedAt;
      record.lastUpstreamState = rawState || status;
      record.resultReadyAt = record.resultReadyAt ?? new Date().toISOString();
      record.retryCount = 0;
      // Q3：取消与成功相遇时保留成功事实与结果——进入 downloading；取消/暂停只表达为「暂停取回」（可 resume 继续）。
      // 判定放在 apply 内，用当前版本记录，避免用旧快照把 paused 改回 active。
      const stopRetrieval = mediaTaskTrackingStatus(record) !== "active" || record.cancellationRequested;
      if (stopRetrieval) {
        record.trackingStatus = "paused";
        record.waitingReason = record.cancellationRequested
          ? "上游已生成成功；本地取消未获上游确认，结果保留待取回（用 resume 继续取回，不会重新生成）"
          : "已暂停服务器跟进（主状态不变，结果可在 resume 后取回）";
        // 暂停/取消只停止取回：未来 retryAt 下限保留，resume 后不得提前突破（契约 v3 §B）。
        clearExpiredMediaTaskRetryAt(record);
        return;
      }
      record.trackingStatus = "active";
      record.waitingReason = assets.length ? undefined : "上游已成功但未提供结果地址（待核对，稍后重新查询补取）";
      record.retryAt = assets.length ? undefined : new Date(Date.now() + queryStageDelayMs(waitingSinceMs(record))).toISOString();
    }));
    return;
  }
  const upstreamState = rawState || status || "空";
  await scheduleQueryFollowUp(taskId, {
    queriedAt,
    delayMs: queryStageDelayMs(waitingSinceMs(task)),
    succeeded: true,
    upstreamState,
    waitingReason: status === "running" ? undefined : `上游返回了无法识别的状态：${upstreamState}（继续按原 ID 跟进）`,
  });
}

/** 一次性查询作业：查一次上游就结束，查询间隔不占本地执行槽。 */
async function runQueryJob(taskId: string, signal: AbortSignal) {
  const task = getMediaTask(taskId);
  if (!task || task.state !== "running" || !task.upstreamId) return;
  if (mediaTaskTrackingStatus(task) !== "active") return;
  const attempt = createAttempt(signal, queryAttemptTimeoutMs);
  let provider: LoadedMediaProvider;
  try {
    provider = await loadTaskProvider(task, attempt.signal, "query");
  } catch (error) {
    attempt.done();
    if (signal.aborted) return;
    await applyFollowUpFailure(taskId, undefined, error, "query");
    return;
  }
  const queryMedia = provider.queryMedia;
  if (typeof queryMedia !== "function") {
    attempt.done();
    await markTaskBlocked(taskId, "供应商已不再提供异步任务查询能力，需人工确认后 resume");
    return;
  }
  let result: ProviderMediaTaskState;
  try {
    result = await queryMedia.call(provider, task.upstreamId);
  } catch (error) {
    attempt.done();
    if (signal.aborted) return;
    await applyFollowUpFailure(taskId, provider, error, "query");
    return;
  }
  attempt.done();
  if (signal.aborted) return;
  await applyQueryResult(taskId, provider, result);
}

/**
 * 下载重试（契约 v4 §D/T06）：任何需要延迟的重试（含第 1–4 次）都先持久化 retryAt 并结束当前下载作业，
 * 释放下载执行槽；只有到期且可跟进时，下一次 tick 才重新拿槽（暂停/停止也因此能结束这段等待）。
 * 不清除上游给出的更晚 Retry-After 下限：已有未来 retryAt 更晚时保留更晚值。
 * 用户暂停/取消期间的迟到响应也必须保存更晚 retryAt（上游退避事实），但保留 paused/取消原因，
 * 不把用户意图覆盖成下载失败文案（T06：事实与意图分开合并）。
 */
async function scheduleDownloadRetry(taskId: string, message: string, delayMs: number) {
  pendingAssets.delete(taskId);
  await updateMediaTask(taskId, taskPlan(
    // 主状态仍是下载中即可写入退避事实；暂停/取消只影响“谁的原因被展示”，不影响上游退避下限的保存。
    current => current.state === "downloading",
    task => {
      const requested = Date.now() + Math.max(downloadRetryMinDelayMs, Math.max(0, Math.round(delayMs)));
      const existing = task.retryAt ? Date.parse(task.retryAt) : Number.NaN;
      const at = Number.isFinite(existing) && existing > requested ? existing : requested;
      task.retryAt = new Date(at).toISOString();
      task.retryCount = (task.retryCount ?? 0) + 1;
      const userIntent = mediaTaskTrackingStatus(task) !== "active" || task.cancellationRequested;
      if (!userIntent) task.waitingReason = message.slice(0, 2000);
    },
  ));
}

/** 下载作业：结果下载失败只重试下载（必要时重新查询上游刷新定位），绝不重新生成。 */
async function runDownloadJob(taskId: string, signal: AbortSignal) {
  const task = getMediaTask(taskId);
  if (!task || task.state !== "downloading" || !task.upstreamId) return;
  // Q3/R02：暂停/受阻跟进时不取回；下载中的 cancel 只暂停取回（保留 downloading 与恢复能力）。
  if (mediaTaskTrackingStatus(task) !== "active") return;
  if (task.cancellationRequested) return;
  let assets = pendingAssets.get(taskId);
  pendingAssets.delete(taskId);
  let provider: LoadedMediaProvider | undefined;
  if (!assets?.length) {
    // 重启或链接过期：重新查询上游刷新结果定位（只查询，不重新生成）。
    const attempt = createAttempt(signal, queryAttemptTimeoutMs);
    try {
      provider = await loadTaskProvider(task, attempt.signal, "download");
      const queryMedia = provider.queryMedia;
      if (typeof queryMedia !== "function") throw taskLifecycleError("供应商已不再提供异步任务查询能力，需人工确认后 resume", "blocked");
      const result = await queryMedia.call(provider, task.upstreamId);
      attempt.done();
      if (signal.aborted) return;
      const status = typeof result?.status === "string" ? result.status : "";
      const rawState = typeof (result as { upstreamState?: unknown }).upstreamState === "string" ? String((result as { upstreamState?: unknown }).upstreamState) : "";
      if (status === "succeeded") {
        assets = Array.isArray(result.assets) ? result.assets : [];
        if (!assets.length) {
          await scheduleDownloadRetry(taskId, "上游已成功但未提供结果地址（待核对/无法补取，稍后重新查询）", jitter(longWaitRetryDelayMs));
          return;
        }
      } else if (status === "failed") {
        await markTaskFailed(taskId, providerErrorMessage(provider, result.error) || "上游生成失败", rawState || status);
        return;
      } else if (status === "cancelled") {
        await markTaskCancelled(taskId, { upstreamCancellation: true, upstreamState: rawState || status });
        return;
      } else {
        await updateMediaTask(taskId, taskPlan(
          current => current.state === "downloading" && mediaTaskTrackingStatus(current) === "active" && !current.cancellationRequested,
          record => {
            record.lastUpstreamState = rawState || status || "running";
            record.waitingReason = "上游结果尚未就绪，稍后继续补取";
            record.retryAt = new Date(Date.now() + queryStageDelayMs(waitingSinceMs(record))).toISOString();
          },
        ));
        return;
      }
    } catch (error) {
      attempt.done();
      // T06：与文件下载分支同序——先分类并保存可靠 Retry-After 退避下限，再处理 paused/停机中止。
      // 暂停恰好中止这次补查询、迟到异常带可靠 Retry-After 时不得丢弃（否则 resume 会过早重试）；
      // 记录退避不改变暂停/取消意图与原因，也不触发任何自动恢复派发。
      const info = classifyMediaTaskError(error, "query");
      if (signal.aborted) {
        if (info.retryAfterMs !== undefined) {
          await scheduleDownloadRetry(taskId, "本次补查询被暂停中止；已保存上游给出的更晚重试下限", info.retryAfterMs)
            .catch(() => undefined);
        }
        return;
      }
      // 重新查询上游按查询阶段分类：凭据受阻要停下等待 resume，不能一直当下载重试。
      const message = providerErrorMessage(provider, error) || "无法恢复结果下载";
      if (info.followUp === "blocked") {
        await markTaskBlocked(taskId, waitingReasonOf(error) ?? message);
        return;
      }
      if (info.followUp === "failed") {
        await markTaskFailed(taskId, message);
        return;
      }
      const delay = info.followUp === "pendingReview"
        ? Math.max(info.retryAfterMs ?? 0, jitter(longWaitRetryDelayMs))
        : retryDelayMsFor(info, (task.retryCount ?? 0) + 1);
      await scheduleDownloadRetry(taskId, info.followUp === "pendingReview" ? `${message}（待核对/无法补取，继续按原任务查询）` : message, delay);
      return;
    }
  }
  if (signal.aborted || !assets?.length) return;
  // 缓存定位不再重新加载供应商时，仍需其 apiUrl/apiKey 判断下载鉴权。
  if (!provider) provider = await loadTaskProvider(task, signal, "download").catch(() => undefined);
  const authorization = downloadAuthorizationOf(provider);
  const failures = new Map<number, number>();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index]!;
    for (;;) {
      if (signal.aborted) return;
      const current = getMediaTask(taskId);
      if (!current || current.state !== "downloading") return;
      // 迟到回调不得越过暂停/取消：暂停不派下载，取消只暂停取回（由调用方持久化意图）。
      if (mediaTaskTrackingStatus(current) !== "active" || current.cancellationRequested) return;
      const assetAttempt = createAttempt(signal, downloadAttemptTimeoutMs);
      let downloaded: { bytes: Buffer; mimeType: string };
      try {
        downloaded = await assetBytes(asset, current.mediaType, assetAttempt.signal, { authorization, idleTimeoutMs: downloadIdleTimeoutMs });
      } catch (error) {
        assetAttempt.done();
        const info = classifyMediaTaskError(error, "download");
        if (signal.aborted) {
          // T06：暂停/停机中止了本次网络尝试——不改变用户意图，但上游已给出的更晚 Retry-After 是事实，
          // 必须保留下来（否则 resume 会提前发起请求）；没有该事实时不写入任何新值。
          if (info.retryAfterMs !== undefined) {
            await scheduleDownloadRetry(taskId, "本次下载尝试被暂停中止；已保存上游给出的更晚重试下限", info.retryAfterMs)
              .catch(() => undefined);
          }
          return;
        }
        const pendingAttempt = (failures.get(index) ?? 0) + 1;
        failures.set(index, pendingAttempt);
        // T06：先持久化 retryAt 并结束本次下载作业（立即释放下载槽），不在作业内 sleep 占槽数小时。
        const attempt = Math.max(pendingAttempt, (getMediaTask(taskId)?.retryCount ?? 0) + 1);
        await scheduleDownloadRetry(taskId, `结果下载失败：${providerErrorMessage(provider, error) || "下载中断"}`, retryDelayMsFor(info, attempt));
        return;
      }
      assetAttempt.done();
      if (signal.aborted) return;
      const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
      // T05：网络返回后重新读取当前任务与跟进意图——暂停/取消不得被迟到响应覆盖，
      // 也不在暂停期间开始新的不可中断落盘段。
      const latest = getMediaTask(taskId);
      if (!latest || latest.state !== "downloading") return;
      if (mediaTaskTrackingStatus(latest) !== "active" || latest.cancellationRequested) return;
      // Q6/T08：已登记的同 sha256 输出只有「文件真实存在且磁盘内容 SHA 一致」才认回；
      // 已清理（cleanedAt）的文件不自动下载复活，缺失/损坏只补取同一内容（不新生成）。
      const known = latest.outputs.find(output => output.sha256 === sha256);
      if (known) {
        const availability = await mediaTaskOutputAvailability(latest, known);
        if (availability.state === "available") {
          const currentPath = availability.resolvedPath ?? known.path;
          if (await mediaOutputSha256(latest.directory, currentPath) === sha256) break;
          // 内容不一致（同长度坏文件）：继续按需重写为正确内容，不把坏文件当成成片。
        } else if (availability.state === "cleaned") {
          await updateMediaTask(taskId, taskPlan(current => current.state === "downloading", record => {
            record.waitingReason = "结果文件已按清理规则删除（不自动重新下载），如需保留请调整清理规则后重新生成";
          }));
          break;
        }
      }
      // 开始不可中断落盘前的最后一次意图/版本复核（本作业自身的合并只发生在落盘之后）。
      const beforeSave = getMediaTask(taskId);
      if (!beforeSave || beforeSave.state !== "downloading" || beforeSave.stateVersion !== latest.stateVersion) return;
      if (mediaTaskTrackingStatus(beforeSave) !== "active" || beforeSave.cancellationRequested) return;
      let output: MediaTaskOutput;
      try {
        output = await saveTaskOutput(latest, downloaded.bytes, downloaded.mimeType, sha256, signal);
      } catch (error) {
        if (signal.aborted) return;
        const pendingAttempt = (failures.get(index) ?? 0) + 1;
        failures.set(index, pendingAttempt);
        const info = classifyMediaTaskError(error, "download");
        // 保存失败的延迟重试同样先落盘 retryAt 并释放下载槽（T06）。
        const attempt = Math.max(pendingAttempt, (getMediaTask(taskId)?.retryCount ?? 0) + 1);
        await scheduleDownloadRetry(taskId, `保存生成结果失败：${errorMessageOf(error) || "写入工作区失败"}`, retryDelayMsFor(info, attempt));
        return;
      }
      const saved = await updateMediaTask(taskId, taskPlan(currentState => currentState.state === "downloading", record => {
        const existing = record.outputs.findIndex(item => item.sha256 && item.sha256 === output.sha256);
        if (existing >= 0) record.outputs[existing] = output;
        else record.outputs.push(output);
        record.error = undefined;
        // 暂停/取消竞态下保留暂停原因：已保存的结果照常入账，但不把跟进意图清成 active。
        if (mediaTaskTrackingStatus(record) === "active" && !record.cancellationRequested) record.waitingReason = undefined;
      }));
      if (!saved || saved.state !== "downloading") return;
      break;
    }
  }
  // 收尾成功：paused/cancelled 竞态下不把「暂停取回」写成成功（保持 downloading 可恢复）。
  await updateMediaTask(taskId, taskPlan(
    current => current.state === "downloading" && !current.cancellationRequested && mediaTaskTrackingStatus(current) === "active",
    record => {
      record.state = "succeeded";
      record.completedAt = new Date().toISOString();
      record.trackingStatus = undefined;
      record.waitingReason = undefined;
      record.error = undefined;
      record.lastUpstreamState = "succeeded";
      record.retryAt = undefined;
      record.retryCount = undefined;
    },
  ));
}

/* -------------------------------------------------------------- 调度/恢复 */

/**
 * 调度顺序（契约 C）：先推进已有上游 ID 的下载与查询，再统计上游未终结的在途额度（含容量预约），
 * 只有余量足够时才放新 queued；查询间隔不占执行槽，也不释放上游在途额度。
 * 所有派发入口（周期 tick、受理后触发、设置变化触发、启动定时器）共用同一就绪判据
 * mediaTasksReadyForDispatch()：恢复未完成/台账不明时不派新生成（契约 v4 §B/T03）。
 */
async function schedulerTick() {
  if (ticking) return;
  // 停机后不再受理迟到 tick（契约 v3 §A.1）。
  if (stopping) return;
  // 恢复进行中不派发任何作业，避免与恢复写入交错；恢复完成后由启动路径立即补一次 tick。
  if (recovering || !recoveryState.settled) return;
  ticking = true;
  try {
    await ensureMediaTasksStore();
    lastTickAt = new Date().toISOString();
    const settings = mediaTasksRuntimeSettings();
    const now = Date.now();
    const followable = (task: MediaTaskRecord) => mediaTaskTrackingStatus(task) === "active"
      && !jobs.has(task.taskId)
      && (!task.retryAt || Date.parse(task.retryAt) <= now);
    // 0) submitting 但无作业（进程中断或作业异常退出）：按恢复规则收敛，绝不自动重提。
    for (const task of listMediaTasksInState("submitting")) {
      if (jobs.has(task.taskId)) continue;
      if (task.upstreamId) {
        await updateMediaTask(task.taskId, taskPlan(current => current.state === "submitting", record => {
          record.state = "running";
          clearExpiredMediaTaskRetryAt(record);
          record.retryCount = 0;
        }));
      } else if (task.submissionAttemptState === "pending" && !task.submissionAttemptedAt) {
        // T09：只有新格式显式记录的「尚未尝试」事实才允许判确定未提交
        // （不占保守额度、不写 unknown）。用户已在该状态下取消时按本地取消收尾，
        // 不把取消意图盖成“提交前失败、可重新提交”；缺该字段的旧格式记录一律保守判 unknown，绝不自动重提。
        await finalizeUnattemptedSubmission(task.taskId, task.cancellationRequested);
      } else {
        await markTaskUnknown(task.taskId, task.submissionAttemptState === "attempted"
          ? "上游受理结果不确定，需人工核对（不会自动重提）"
          : "记录缺少明确的提交尝试事实（旧格式），上游是否已受理无法证明，需人工核对（不会自动重提）");
      }
    }
    // 1) 下载优先：上游已成功，结果最快到手。
    let downloads = countJobs("download");
    for (const task of listMediaTasksInState("downloading")) {
      if (settings.paused) break;
      if (downloads >= settings.downloadConcurrency) break;
      if (!task.upstreamId || !followable(task)) continue;
      downloads += 1;
      startJob(task.taskId, "download", signal => runDownloadJob(task.taskId, signal));
    }
    // 2) 恢复后的 running 重新查询上游；查询始终可用（全局暂停也保持查询）。
    let queries = countJobs("query");
    for (const task of listMediaTasksInState("running")) {
      if (queries >= maxConcurrentQueryJobs) break;
      if (!task.upstreamId || !followable(task)) continue;
      queries += 1;
      startJob(task.taskId, "query", signal => runQueryJob(task.taskId, signal));
    }
    // 3) 有余量才放新任务：在途数（含已准入未发布 submitting 的作业预约）≥配置时 queued 保持 queued。
    //    派发门为唯一就绪判据：全局暂停、恢复未完成、台账/保护不明或装载告警都不提交新生成。
    if (!settings.paused && mediaTasksReadyForDispatch()) {
      let inFlight = countAdmittedGenerations();
      for (const task of listMediaTasksInState("queued")) {
        if (inFlight >= settings.generationConcurrency) break;
        if (task.cancellationRequested || !followable(task)) continue;
        inFlight += 1;
        startJob(task.taskId, "generate", signal => runGenerationJob(task.taskId, signal));
      }
    }
  } finally {
    ticking = false;
  }
}

/**
 * 恢复：先加载已有上游 ID 与下载中的任务，能安全继续的继续，不确定的一律待核对，绝不自动重提。
 * 逐项错误必须汇总（契约 v3 §A.4）：无法确认任务台账/保护/在途数量时不得静默 ready。
 */
export async function recoverMediaTasks() {
  await ensureMediaTasksStore();
  // 装载阶段被跳过的损坏批次文件属于「台账未能完整确认」：列入逐项错误，就绪必须为 false。
  recoveryErrors = [...mediaTaskStoreLoadWarnings()];
  // §O.3（T15 收尾）启动消费：未完成的改名事务（**含终态任务**）不得被当作「迁移成功」静默跳过。
  // 逐项给出可读诊断（事务身份 / 源 / 目标 / 阻断来源），任务状态本身不改写；同一事实仍由
  // 改名阻断过滤（Q）、C 的持久意图/范围保护与清理占用判定各自在自身入口实际消费。
  for (const entry of listUnfinishedRelocationTasks()) {
    console.warn(`媒体任务存在未完成的改名事务阻断：任务 ${entry.task.taskId}（state=${entry.task.state}），`
      + `${entry.block.transactionId ?? "旧格式（无事务身份）"}，${entry.block.source} → ${entry.block.target}`
      + `（阻断来源：${entry.origin === "persisted" ? "持久阻断" : "本进程运行时阻断"}）；`
      + "真实文件位置与 task.outputs 未经核对确认，恢复方式：按原 source→target 精确重试或人工核对后再操作");
  }
  for (const task of listMediaTasks()) {
    try {
      if (isFinishedMediaTaskState(task.state)) continue;
      if (task.state === "preparing") {
        if (!(await inputSnapshotsReady(task.inputSnapshots))) {
          await markTaskFailed(task.taskId, "输入快照不完整，任务未提交上游，请重新提交");
          continue;
        }
        if (task.cancellationRequested) {
          await markTaskCancelled(task.taskId, { upstreamCancellation: false });
          continue;
        }
        await updateMediaTask(task.taskId, taskPlan(current => current.state === "preparing", record => { record.state = "queued"; }));
        continue;
      }
      if (task.state === "queued") {
        if (task.cancellationRequested) await markTaskCancelled(task.taskId, { upstreamCancellation: false });
        continue;
      }
      if (task.state === "unknown") {
        // 待核对：有上游 ID 的旧记录继续查询；无 ID 的保持 unknown（保守占用在途额度，不自动提交）。
        if (task.upstreamId && mediaTaskTrackingStatus(task) === "active") {
          await updateMediaTask(task.taskId, taskPlan(current => current.state === "unknown", record => {
            record.state = "running";
            record.trackingStatus = "active";
            record.waitingReason = undefined;
            record.error = undefined;
            clearExpiredMediaTaskRetryAt(record);
            record.retryCount = 0;
          }));
        }
        continue;
      }
      if (!task.upstreamId) {
        if (task.state === "submitting" && task.submissionAttemptState === "pending" && !task.submissionAttemptedAt) {
          // T09/契约 v4 §F：只有新格式显式记录的「尚未开始网络尝试」事实才判确定未提交；
          // 已有取消意图时按本地取消收尾（不声称上游取消），否则记提交前失败，不占保守在途额度、也不进 unknown。
          // 缺失该字段的旧格式记录一律保守判 unknown。
          await finalizeUnattemptedSubmission(task.taskId, task.cancellationRequested);
          continue;
        }
        // 同步供应商没有上游 ID，跨重启无法按 ID 续查：明确说明边界，不承诺恢复，也不自动重提。
        const info = await getMediaProvider(task.providerId).catch(() => undefined);
        const syncOnly = !!info && info.asyncMedia !== true;
        await markTaskUnknown(task.taskId, syncOnly
          ? "该任务使用同步供应商（无上游任务 ID），进程中断后无法按 ID 续查；结果不确定，不会自动重提"
          : "进程中断时上游受理结果不确定，需人工核对（不会自动重提）");
        continue;
      }
      const info = await getMediaProvider(task.providerId).catch(() => undefined);
      if (!info) {
        await markTaskBlocked(task.taskId, "供应商已被删除或无法读取，需人工恢复后 resume");
        continue;
      }
      const compatibility = providerCompatibility(task, info);
      if (!compatibility.compatible) {
        await markTaskBlocked(task.taskId, compatibility.reason ?? "供应商配置已变更，需人工确认后 resume");
        continue;
      }
      // 已有上游 ID：submitting 归并为 running（不重新提交），downloading 保留占用；排队查询/补下载。
      await updateMediaTask(task.taskId, taskPlan(
        current => current.state === "submitting" || current.state === "running" || current.state === "downloading",
        record => {
          if (record.state === "submitting") record.state = "running";
          record.error = undefined;
          record.retryCount = 0;
          // 用户明确暂停/受阻的任务保持原跟进标记，等待 resume；未来 retryAt 下限保留（契约 v3 §B）。
          if (mediaTaskTrackingStatus(record) === "active") {
            clearExpiredMediaTaskRetryAt(record);
            record.waitingReason = undefined;
          }
        },
      ));
    } catch (error) {
      const message = providerErrorMessage(undefined, error) || "媒体任务恢复失败";
      recoveryErrors.push(`${task.taskId}：${message}`);
      console.warn(`媒体任务恢复失败：${task.taskId}`, error);
    }
  }
}

export type MediaTasksSchedulerStatus = {
  started: boolean;
  /** 任务存储已加载完成（未加载时下面的统计为 0，不能据此判断没有任务）。 */
  storageReady: boolean;
  /** 恢复过程结束（成功或失败都置真）。 */
  recovered: boolean;
  /** 恢复正在进行：此时不应声称 ready。 */
  recovering: boolean;
  /** 唯一派发就绪判据 mediaTasksReadyForDispatch() 的结果（含装载告警、保护就绪与 stopping；§N.1 起**含全局暂停**）。 */
  ready: boolean;
  /** I 集成补充：不含「全局暂停」的恢复/保护就绪（旧 schedulerReady 语义，供健康摘要区分「未就绪」与「用户暂停」）。 */
  recoveryReady: boolean;
  /** 派发门关闭时的可诊断原因（T03）；门打开时不返回。 */
  dispatchBlockReason?: string;
  /** 保护/归属存储是否明确可用（T03：新收费创建的前置判据之一）。 */
  protectionReady: boolean;
  /** 保护/归属存储不可用时的原因（已去敏）。 */
  protectionReason?: string;
  /** 恢复整体错误（去敏、可诊断）。 */
  recoveryError?: string;
  /** 逐项恢复错误（去敏）；非空表示台账/保护/在途数量未完全确认。 */
  recoveryErrors: string[];
  /** 装载阶段被跳过的损坏批次文件（去敏文件名）；非空时台账未完整确认。 */
  storageWarnings: string[];
  /**
   * §O.3 启动消费（T15）：未完成改名事务的只读诊断（**含终态任务**）——
   * 存在即表示「真实文件位置 / task.outputs 未经核对确认」，不得当作迁移成功；
   * origin 区分持久阻断与仅本进程的运行时阻断（后者的跨重启保护未确认）。
   * §P.1/§P.2 扩展：participants=该事务完整参与集合（Q 阻断记录 ∪ C 意图摘要，含已发布到目标的成员）；
   * openParticipants=逐项核对未收敛项（含原因，任一未收敛即不得宣告事务完成）；
   * phase=forward/compensating（本进程在途）/unsettled（无在途调用但持久事实未收敛）。
   */
  unfinishedRelocations: {
    taskId: string;
    state: MediaTaskState;
    origin: "persisted" | "runtime";
    transactionId?: string;
    source: string;
    target: string;
    at: string;
    participants: string[];
    openParticipants: { taskId: string; reason: string }[];
    phase: "forward" | "compensating" | "unsettled";
  }[];
  recoveredAt?: string;
  paused: boolean;
  /** 进程级 stopping：已封闭新受理/新作业/迟到 tick 与恢复派发。 */
  stopping: boolean;
  /** 停机排空结果（内部超时保护；未完成时说明原因与剩余数量）。 */
  drainOutcome?: MediaTaskDrainOutcome;
  settings: { generationConcurrency: number; downloadConcurrency: number; waitingReminderHours: number };
  /** 上游未终结的在途额度占用情况（只按业务状态统计）。 */
  upstreamInFlight: number;
  /** 已准入但尚未发布 submitting 的生成作业容量预约数（T04；不进入公开台账）。 */
  generationReservations: number;
  /** 实际准入的生成数量 = 上游在途 + 预约；容量判断与验收按这个数，不只看台账状态。 */
  generationAdmitted: number;
  /** 在途受理/协调数量（T02）：排空判定必须同时看 jobs 与这个数。 */
  inflightRequests: number;
  /** blocked 跟进数量（tasks.blocked 的同义顶层字段，供健康摘要直接读取）。 */
  blockedCount: number;
  /** paused 跟进数量（tasks.pausedTracking 的同义顶层字段）。 */
  pausedTrackingCount: number;
  tasks: { queued: number; submitting: number; running: number; downloading: number; unknown: number; blocked: number; pausedTracking: number };
  jobs: { generate: number; query: number; download: number };
  lastTickAt?: string;
  nextRetryAt?: string;
};

/** 调度器就绪与在途额度（契约 C）：由健康/状态接口读取，恢复完成不等于目录可写。 */
export function getSchedulerStatus(): MediaTasksSchedulerStatus {
  const settings = mediaTasksRuntimeSettings();
  const tasks = listMediaTasks();
  const counts = { queued: 0, submitting: 0, running: 0, downloading: 0, unknown: 0, blocked: 0, pausedTracking: 0 };
  let upstreamInFlight = 0;
  let nextRetryAt: string | undefined;
  for (const task of tasks) {
    if (occupiesUpstreamSlot(task)) upstreamInFlight += 1;
    if (task.state === "queued") counts.queued += 1;
    if (task.state === "submitting") counts.submitting += 1;
    if (task.state === "running") counts.running += 1;
    if (task.state === "downloading") counts.downloading += 1;
    if (task.state === "unknown") counts.unknown += 1;
    if (isFinishedMediaTaskState(task.state)) continue;
    const tracking = mediaTaskTrackingStatus(task);
    if (tracking === "blocked") counts.blocked += 1;
    if (tracking === "paused") counts.pausedTracking += 1;
    if (task.retryAt && (!nextRetryAt || task.retryAt < nextRetryAt)) nextRetryAt = task.retryAt;
  }
  const generationReservations = countGenerationReservations();
  // T03：就绪判据与原因在同一处计算，健康摘要据此暴露“为什么不派发”。
  // I 集成补充：`ready` = 统一新创建门（含全局暂停）；`recoveryReady` = 不含暂停的恢复/保护就绪（旧 schedulerReady 语义）。
  const readiness = mediaTasksDispatchReadiness();
  const recoveryReadiness = mediaTasksRecoveryReadiness();
  return {
    started: schedulerStarted,
    storageReady: mediaTasksStoreLoaded(),
    recovered: recoveryState.settled,
    recovering,
    ready: readiness.ready,
    recoveryReady: recoveryReadiness.ready,
    ...(readiness.reason ? { dispatchBlockReason: readiness.reason } : {}),
    protectionReady: readiness.protectionReady,
    ...(readiness.protectionReason ? { protectionReason: readiness.protectionReason } : {}),
    recoveryError: recoveryState.error,
    recoveryErrors: [...recoveryErrors],
    storageWarnings: mediaTaskStoreLoadWarnings(),
    // §O.3 启动消费：未完成改名事务（含终态任务）的实时诊断——启动后可读、按事实清除，不被静默跳过。
    // §P.1/§P.2：同一事务的完整参与集合与逐项收敛状态并入只读 status（health 的 unfinishedRelocations）。
    unfinishedRelocations: (() => {
      // C 的迁移意图摘要（同步内存快照）：提供 Q 上次调用时写入的 participants（§P.1），与 Q 自身的
      // 持久阻断记录并集；意图条目读取一次供全部条目复用。
      const relocationIntents = fileRecordsReadinessSnapshot().relocationIntents ?? [];
      return listUnfinishedRelocationTasks().map(entry => {
        const intentParticipants = entry.block.transactionId
          ? relocationIntents
            .filter(intent => intent.transactionId === entry.block.transactionId)
            .flatMap(intent => relocationIntentParticipantIds(intent))
          : [];
        const transaction = {
          directory: entry.task.directory, transactionId: entry.block.transactionId,
          source: entry.block.source, target: entry.block.target, intentParticipants,
        };
        const participants = relocationTransactionParticipants(transaction);
        const openParticipants = participants
          .map(taskId => ({ taskId, reason: relocationParticipantOpenReason(taskId, { ...transaction, direction: "commit" }) }))
          .filter((item): item is { taskId: string; reason: string } => typeof item.reason === "string");
        return {
          taskId: entry.task.taskId,
          state: entry.task.state,
          origin: entry.origin,
          ...(entry.block.transactionId ? { transactionId: entry.block.transactionId } : {}),
          source: entry.block.source,
          target: entry.block.target,
          at: entry.block.at,
          participants,
          openParticipants,
          phase: relocationTransactionPhase(entry.block.transactionId),
        };
      });
    })(),
    recoveredAt: recoveryState.recoveredAt,
    paused: settings.paused,
    stopping,
    ...(drainOutcome ? { drainOutcome } : {}),
    settings: {
      generationConcurrency: settings.generationConcurrency,
      downloadConcurrency: settings.downloadConcurrency,
      waitingReminderHours: settings.waitingReminderHours,
    },
    upstreamInFlight,
    generationReservations,
    generationAdmitted: upstreamInFlight + generationReservations,
    inflightRequests: countMediaTaskInflight(),
    blockedCount: counts.blocked,
    pausedTrackingCount: counts.pausedTracking,
    tasks: counts,
    jobs: { generate: countJobs("generate"), query: countJobs("query"), download: countJobs("download") },
    lastTickAt,
    nextRetryAt,
  };
}

/**
 * 立即触发一次调度（pause/resume、受理后不等下一个 tick）；统一走同一就绪判据（T03）：
 * 停机、恢复未完成、台账/保护不明时拒绝派发，由周期 tick 在门打开后接手。
 */
export function requestMediaTaskSchedulerTick() {
  if (!mediaTasksReadyForDispatch()) return;
  void schedulerTick().catch(error => console.warn("媒体任务调度失败", error));
}

async function startMediaTaskScheduler() {
  startTimer = undefined;
  if (stopping) return;
  recovering = true;
  try {
    await recoverMediaTasks();
    recoveryState = { settled: true, recoveredAt: new Date().toISOString() };
  } catch (error) {
    recoveryState = { settled: true, error: errorMessageOf(error) || "媒体任务恢复失败" };
    console.warn("媒体任务恢复失败", error);
  } finally {
    recovering = false;
  }
  if (stopping) return;
  schedulerTimer ??= setInterval(() => {
    void schedulerTick().catch(error => console.warn("媒体任务调度失败", error));
  }, pollTickIntervalMs);
  schedulerTimer.unref?.();
  await schedulerTick().catch(error => console.warn("媒体任务调度失败", error));
}

/**
 * 服务启动入口（由 app.ts 调用）：加载存储后延迟 2 秒再恢复与调度，不阻塞启动。
 * 返回的 Promise 只等待存储加载完成。停机后不再启动调度。
 */
export async function initializeMediaTasks() {
  await ensureMediaTasksStore();
  if (schedulerStarted || stopping) return;
  schedulerStarted = true;
  startTimer = setTimeout(() => { void startMediaTaskScheduler(); }, 2000);
  startTimer.unref?.();
}

/**
 * 停机第一步（契约 v3 §A.1，主窗口 I 装配）：同步置 stopping 并清启动/周期 timer。
 * 置真后拒绝新受理、新作业、迟到 tick 与恢复派发；在途作业与已取得 upstreamId 的关键落盘继续收敛。
 */
export function beginStopping() {
  if (stopping) return;
  stopping = true;
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = undefined;
  }
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = undefined;
  }
}

/** 在途作业数量（排空判断）。 */
export function countMediaTaskJobs() {
  return jobs.size;
}

/**
 * 停机收敛（契约 v4 §A，§N.4 预算接缝）：一个全局截止时间贯穿「等在途作业与在途受理/协调队列 →
 * 中止剩余作业 → 短收敛窗 → 带截止排空写队列」，未排空也必须在截止内 resolve 并把结果写入 drainOutcome。
 * - options.deadline 为绝对截止（Date.now() 毫秒时间戳）；与 timeoutMs 同时给出时取更早者；
 *   只给 deadline 时按 deadline，不再被默认 30 秒静默截断；
 * - options.abortGraceMs / finalWriteReserveMs 为 I 在该截止内**可兑现**的数值（§N.4）：本函数先预留这两块、
 *   再计算自然等待截止，并把请求值、本次实际可用值与真实等待（abortWaitedMs）分别写进 drainOutcome；
 *   前段耗到上限导致宽限被压缩时不静默，drainOutcome.abortGraceTruncated/abortGraceAvailableMs 如实反映；
 * - 在途受理（含目录/供应商/快照/批次锁等待）与协调队列计入排空判定，不允许被判成「已排空」；
 * - 重复调用幂等（并发调用共享同一收敛 Promise）。
 */
export function drainMediaTaskWrites(options: { timeoutMs?: number; abortGraceMs?: number; finalWriteReserveMs?: number; deadline?: number } = {}): Promise<void> {
  drainingPromise ??= runDrainForShutdown(options);
  return drainingPromise;
}

/** 停机排空截止：显式 deadline 与 now+timeoutMs 取更早者；两者都未给时用默认 30 秒预算。 */
function mediaTaskDrainDeadline(options: { timeoutMs?: number; deadline?: number }) {
  // T02：只给 deadline（I 按 45 秒总预算显式分配）时按 deadline 计算，不得被默认 30 秒静默截断；
  // 只有调用方确实没给任何截止时才退回默认 30 秒。
  const hasDeadline = Number.isFinite(options.deadline) && (options.deadline ?? 0) > 0;
  const hasTimeout = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0;
  const requested = hasDeadline ? Math.trunc(options.deadline!) : Number.POSITIVE_INFINITY;
  const timeoutMs = hasTimeout ? Math.trunc(options.timeoutMs!) : (hasDeadline ? Number.POSITIVE_INFINITY : 30000);
  return Math.min(requested, Date.now() + timeoutMs);
}

/** 排空预算的组成部分（T02）：自然等待 / 中止宽限 / 最终持久写预留都从同一全局截止里划分。 */
type MediaTaskDrainBudget = {
  deadline: number;
  abortGraceMs: number;
  finalWriteReserveMs: number;
  /** 自然等待（等在途作业与在途受理收敛）的截止：已提前预留 abort 宽限与最终持久写时间。 */
  naturalWaitDeadline: number;
};

/**
 * 停机排空预算（契约 v4 §A/T02）：同一总预算内先预留「强制中止后的收尾宽限」与「最终写队列持久化」两块时间，
 * 再计算自然等待截止；不得先把全局截止等满、再把已经耗尽的截止当作 abort 宽限（那等于没有收尾时间）。
 */
function mediaTaskDrainBudget(options: { timeoutMs?: number; deadline?: number; abortGraceMs?: number; finalWriteReserveMs?: number }): MediaTaskDrainBudget {
  const deadline = mediaTaskDrainDeadline(options);
  const abortGraceMs = Number.isFinite(options.abortGraceMs) && (options.abortGraceMs ?? 0) > 0 ? Math.trunc(options.abortGraceMs!) : 5000;
  const finalWriteReserveMs = Number.isFinite(options.finalWriteReserveMs) && (options.finalWriteReserveMs ?? 0) > 0
    ? Math.trunc(options.finalWriteReserveMs!) : 8000;
  const now = Date.now();
  return {
    deadline,
    abortGraceMs,
    finalWriteReserveMs,
    naturalWaitDeadline: Math.max(now, deadline - abortGraceMs - finalWriteReserveMs),
  };
}

async function runDrainForShutdown(options: { timeoutMs?: number; abortGraceMs?: number; finalWriteReserveMs?: number; deadline?: number }): Promise<void> {
  // 未显式进入 stopping 时也按停机收敛处理，避免排空期间继续派发新作业。
  beginStopping();
  const budget = mediaTaskDrainBudget(options);
  const startedAt = Date.now();
  // 1) 自然等待：等在途作业与在途受理/协调队列（含尚未开始写盘的等待）都收敛。
  //    睡眠长度受自然等待截止约束（T02），不让 100ms 粒度吃掉为 abort 与最终落盘预留的时间。
  while (jobs.size > 0 || countMediaTaskInflight() > 0) {
    const remaining = budget.naturalWaitDeadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(100, remaining));
  }
  let aborted = false;
  let abortWaitedMs = 0;
  let abortGraceAvailableMs = 0;
  let abortGraceSufficient = true;
  if (jobs.size > 0) {
    aborted = true;
    const abortStartedAt = Date.now();
    for (const job of jobs.values()) job.controller.abort();
    // 2) 中止宽限：从「现在」重新计时，并且仍为最终持久写保留预留时间；
    //    绝不再拿已经耗尽的总截止当宽限（T02：长作业耗尽等待后 abort 宽限实际为零）。
    const abortDeadline = Math.min(abortStartedAt + budget.abortGraceMs, Math.max(abortStartedAt, budget.deadline - budget.finalWriteReserveMs));
    // 实际可用宽限可能小于请求值（前段允许耗到上限时）——如实记录，不假称已兑现请求的宽限。
    abortGraceAvailableMs = Math.max(0, abortDeadline - abortStartedAt);
    while (jobs.size > 0 && Date.now() < abortDeadline) {
      const remaining = abortDeadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(100, remaining));
    }
    // 真实 abort 等待：从发出中止到本次中止等待结束的实际耗时（是否仍有作业见 pendingJobs）。
    abortWaitedMs = Date.now() - abortStartedAt;
    // 宽限是否足够：本次中止等待窗内是否所有作业都已退出（false 时可能耗尽了可用宽限）。
    abortGraceSufficient = jobs.size === 0;
  }
  // 3) 最终写队列排空必须带截止：未排空也返回，并把未完成情况写入 drainOutcome。
  const finalWriteStartedAt = Date.now();
  const writeDrain = await drainMediaTaskWriteQueue({ deadline: budget.deadline });
  const finalWriteAvailableMs = Math.max(0, budget.deadline - finalWriteStartedAt);
  // 协调链的收尾是异步的：给极短复核窗，避免把微任务窗口误报成「仍有在途受理」。
  if (jobs.size === 0 && writeDrain.pendingWrites === 0 && countMediaTaskInflight() > 0) {
    const settleDeadline = Math.min(budget.deadline, Date.now() + 250);
    while (countMediaTaskInflight() > 0 && Date.now() < settleDeadline) await sleep(25);
  }
  const pendingJobs = jobs.size;
  const pendingWrites = writeDrain.pendingWrites;
  const pendingInflight = countMediaTaskInflight();
  const completed = pendingJobs === 0 && pendingWrites === 0 && pendingInflight === 0;
  const reason = completed
    ? aborted
      ? `在途作业已在宽限内中止并收敛（实际收尾 ${abortWaitedMs}ms；请求宽限 ${budget.abortGraceMs}ms，实际可用 ${abortGraceAvailableMs}ms；最终持久写可用 ${finalWriteAvailableMs}ms），关键落盘、在途受理与写队列已排空`
      : "在途作业自然收敛，关键落盘、在途受理与写队列已排空"
    : `剩余预算内未完成：jobs=${pendingJobs}，pendingWrites=${pendingWrites}，inflight=${pendingInflight}（保留最后可靠状态，下次启动按恢复规则继续）`;
  const finishedAt = Date.now();
  drainOutcome = {
    completed, reason, at: new Date().toISOString(), pendingJobs, pendingWrites, pendingInflight,
    abortWaitedMs, finalWriteReserveMs: budget.finalWriteReserveMs,
    abortGraceRequestedMs: budget.abortGraceMs,
    abortGraceAvailableMs,
    // 请求的宽限是否被前段预算压缩（true 时 I/审计可据此判断本次收尾并非按请求值兑现）。
    abortGraceTruncated: aborted && abortGraceAvailableMs < budget.abortGraceMs,
    // 中止等待窗内是否所有作业都已退出（false 表示耗尽了可用宽限或仍有作业）。
    abortGraceSufficient,
    finalWriteAvailableMs,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    totalMs: finishedAt - startedAt,
  };
  if (!completed) console.warn(`[停机] 媒体任务排空未完成：${reason}`);
}

/**
 * 兼容停机入口：置 stopping、清 timer 并中止本机作业。状态保持原样，
 * 未完成的上游查询与下载在下次启动按恢复规则继续（绝不重提）。
 * 新的 server 生命周期请用 beginStopping() + drainMediaTaskWrites()。
 */
export function stopMediaTaskScheduler() {
  beginStopping();
  for (const job of jobs.values()) job.controller.abort();
}
