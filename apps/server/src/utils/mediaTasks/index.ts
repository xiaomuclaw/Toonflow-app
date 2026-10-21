import { isAbsolute, relative, resolve } from "node:path";
import { lstat, realpath } from "@toonflow/file";
import { audioGenerationSchema, imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { translateError, translateMessage, validationOptions } from "@/lib/i18n";
import { getMediaProvider } from "@/utils/media/provider";
// §O.2/§4.2：延迟意图的解除由 Q 在 outputs 发布持久化成功后显式调用（mediaTasks → fileRecords 单向依赖，
// fileRecords 不反向 import mediaTasks；该函数只用归属写队列，不取路径锁/任务锁，不改变既有锁序）。
// §P.1：listFileRelocationIntents 同样来自 fileRecords——读取 C 持久意图的 participants（Q 传入、C 持久化）。
// §P.4：clearFileRelocationIntent 的清除结果三态（confirmed/unconfirmed/抛错）由 Q 按实透传 warning。
import { clearFileRelocationIntent, listFileRelocationIntents } from "@/utils/fileRecords";
import type { FileRelocationIntentClearOutcome } from "@/utils/fileRecords";
// §O.1 事务身份与改名入口统一复用 C 的导出（mediaTasks ↔ cleanup 既有双向 import：只在函数体内延迟使用，
// 不做顶层调用/解构；cleanup 的 relocationTransactionId 是函数声明，Q 侧仅在实际改名时读取）。
import { relocateWorkspacePath, relocationTransactionId } from "@/utils/cleanup";
import type { RelocateWorkspaceResult } from "@/utils/cleanup";
import {
  appendMediaTasks, beginMediaTaskInflight, beginRelocationTransactionActivity, clearExpiredMediaTaskRetryAt, clearRuntimeRelocationBlock, countMediaTasksByState, createMediaTaskBatch, currentOutputPath,
  effectiveRelocationBlock, endRelocationTransactionActivity, ensureMediaTasksStore, findMediaTaskBatch,
  getMediaTask, getMediaTaskBatch, getMediaTaskByKey, isFinishedMediaTaskState, listMediaTaskBatchesByKey, listMediaTasks, listUnfinishedRelocationTasks, mediaProviderCredentialReference,
  mediaTaskAbandoned, mediaTaskBatchKey, mediaTaskFingerprint, mediaTaskIdempotencyKey, mediaTaskQueryIdentityMatches, mediaTaskTrackingStatus, normalizeRelativePrefix, outputPathUnderPrefix,
  registerRuntimeRelocationBlock, relocationBlockMatchesTransaction, relocationIntentParticipantIds, relocationParticipantOpenReason, relocationTransactionParticipants, updateMediaTask, updateMediaTaskBatch,
  updateMediaTaskWithinLock, updateMediaTaskWithinLockIfApplied, updateRelocationTransactionPhase, withMediaTaskLock,
} from "./store";
import type {
  MediaTaskMediaType, MediaTaskOutput, MediaTaskRecord, MediaTaskRelocationBlock, MediaTaskState, MediaTaskTrackingStatus, MediaTaskVerifiedRecovery,
} from "./store";
import { createInputSnapshots } from "./snapshots";
import {
  abortMediaTaskJob, cancelUpstreamMediaTask, isMediaTasksStopping, mediaProviderApiKeyOf, mediaTaskQueryIdentity, mediaTasksRuntimeSettings, normalizeProviderBase,
  providerCompatibility, requestMediaTaskSchedulerTick, verifyUpstreamMediaTask,
} from "./scheduler";
import type { MediaTaskQueryIdentity, UpstreamOwnershipVerification } from "./scheduler";
import { aggregateMediaTaskOutputState, mediaTaskOutputAvailability } from "./outputState";
import type { MediaTaskOutputState } from "./outputState";

export type { MediaTaskBatch, MediaTaskInputSnapshot, MediaTaskMediaType, MediaTaskOutput, MediaTaskRecord, MediaTaskRelocationBlock, MediaTaskState, MediaTaskTrackingStatus } from "./store";
export type { MediaTaskOutputState } from "./outputState";
export {
  beginStopping, countAdmittedGenerations, countGenerationReservations, drainMediaTaskWrites, getSchedulerStatus,
  initializeMediaTasks, mediaTasksDispatchReadiness, mediaTasksReadyForDispatch, mediaTasksRecoveryReadiness, stopMediaTaskScheduler,
} from "./scheduler";
export { countMediaTaskInflight, ensureMediaTasksStore } from "./store";
export type { RelocationTransactionIdentity } from "./store";
// §P.2（R1b/§3.4）：C 的显式恢复入口（POST /api/cleanup/protections）在不取任务锁的前提下调用的只读判忙
// 判定——本进程内该事务的正向/补偿调用尚未返回即为活动中；纯内存同步，不等待任何锁。
export { isRelocationTransactionActive } from "./store";
export type { MediaTaskDrainOutcome, MediaTasksDispatchReadiness, MediaTasksSchedulerStatus } from "./scheduler";

export const mediaTaskMediaTypes = ["image", "video", "audio"] as const;

export type MediaTaskSubmitItem = {
  /** 1-128 字符，同一 batchKey 内唯一。 */
  itemKey: string;
  /** image/video/audioGenerationSchema 解析前的请求（不含 directory）。 */
  request: unknown;
  canvasId?: string;
  nodeId?: string;
};

export type MediaTaskSubmitResult = {
  batchId: string;
  items: { itemKey: string; status: "accepted" | "existing" | "rejected"; taskId?: string; reason?: string }[];
};

export type MediaTaskSummary = {
  taskId: string;
  batchId: string;
  itemKey: string;
  mediaType: MediaTaskMediaType;
  state: MediaTaskState;
  providerId: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /**
   * 输出可用性逐项表达（契约 v4 §G 统一字段）：state 可播放/下载判定；resolvedPath 为最新工作区相对路径
   * （仅可用且已改名时给出；未给出时用 path）；cleanedAt 为清理完成时间；path 保留为历史原路径。
   */
  outputs: {
    /** 历史原路径（工作区相对，正斜杠）；改名后不覆盖，最新定位看 resolvedPath。 */
    path: string;
    mimeType: string;
    mediaType: MediaTaskMediaType;
    sha256?: string;
    state: MediaTaskOutputState;
    cleanedAt?: string;
    /** 原路径已被可追踪改名（或已持久化改名事实）时的最新工作区相对路径（仅 state=available 时给出）。 */
    resolvedPath?: string;
  }[];
  error?: string;
  cancellationRequested: boolean;
  upstreamCancellation?: boolean;
  canvasId?: string;
  nodeId?: string;
  /** 跟进标记：active（默认）/ blocked（凭据或兼容受阻，等待 resume）/ paused（用户明确暂停服务端跟进）。 */
  trackingStatus: MediaTaskTrackingStatus;
  /** blocked/paused 的可读原因（已去敏）。 */
  waitingReason?: string;
  lastQueryAt?: string;
  lastQuerySucceededAt?: string;
  /** 上游最近状态原文。 */
  lastUpstreamState?: string;
  /** 上游报告成功、结果可取的时间。 */
  resultReadyAt?: string;
  /** 下一次允许跟进（查询/下载）的时间；未来下限不会被重启/暂停/恢复清掉。 */
  retryAt?: string;
  /** 用户明确放弃核对的时间（仅无上游 ID 的待核对任务）。 */
  abandonedAt?: string;
  /** 放弃后重新绑定/恢复成功的时间；记录后豁免撤销。 */
  abandonRevokedAt?: string;
  /** 当前是否仍处于「放弃核对」的有效豁免期（无 ID unknown 且未撤销）。 */
  abandoned?: boolean;
  /** 任务级输出可用性聚合（无输出时不返回）。 */
  outputState?: MediaTaskOutputState;
  /** 任务级最近清理完成时间（来源为归属记录的 cleanedAt）。 */
  cleanedAt?: string;
  /** 提交时间 + 提醒小时数；waitingReminderHours=0 时不返回。 */
  waitingReminderAt?: string;
  /** 是否已超过等待提醒阈值（只提醒，不判失败）。 */
  waitingReminder?: boolean;
  /**
   * 服务端对「生成 POST（上游创建请求）是否已发起」的明确事实（T10，供网页区分准备失败与提交不明）：
   * pending=尚未发起（本地准备中或受理前中断，确定未提交）；attempted=已发起提交尝试
   * （结果不明时按原键恢复查询，不自动重提）；unknown=旧记录缺少该事实，不可判定（不得当作未提交）。
   */
  submissionAttempt?: "pending" | "attempted" | "unknown";
  /** 已发起提交尝试的时间（submissionAttempt=attempted 且记录到时间时给出）。 */
  submissionAttemptedAt?: string;
  /** 改名事务部分失败后的持久阻断（T15）；由后续成功迁移解除。 */
  relocationBlocked?: MediaTaskRelocationBlock;
};

export type MediaTaskGetResult = {
  tasks: MediaTaskSummary[];
  nextCursor?: string;
  counts: Partial<Record<MediaTaskState, number>>;
};

export type MediaTaskCancelResult = {
  items: {
    taskId: string;
    state: MediaTaskState;
    cancellationRequested: boolean;
    upstreamCancellation?: boolean;
    /** 跟进标记（取消下载后为 paused 表示「已暂停取回」，可 resume 继续）。 */
    trackingStatus?: MediaTaskTrackingStatus;
    /** 知情放弃核对的时间（abandonUnconfirmed=true 时写入）。 */
    abandonedAt?: string;
    abandonRevokedAt?: string;
    /** 未能取消时的原因（如待核对任务缺少上游 ID）。 */
    reason?: string;
  }[];
};

/** 跟进入口（pause/resume）的逐项结果。 */
export type MediaTaskFollowUpItemStatus = "paused" | "resumed" | "blocked" | "rejected";

export type MediaTaskFollowUpItem = {
  taskId: string;
  status: MediaTaskFollowUpItemStatus;
  state?: MediaTaskState;
  trackingStatus?: MediaTaskTrackingStatus;
  upstreamId?: string;
  reason?: string;
};

export type MediaTaskFollowUpResult = { items: MediaTaskFollowUpItem[] };

export type MediaTaskBindInput = { taskId: string; upstreamId: string };

function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function sameDirectory(left: string, right: string) {
  // Windows 下 path.relative 已按大小写不敏感比较。
  return relative(left, right) === "";
}

async function normalizeDirectory(directory: unknown) {
  if (typeof directory !== "string" || !directory.trim() || !isAbsolute(directory)) invalid("工作目录必须是绝对路径");
  return realpath(directory).catch(() => invalid("工作目录不存在，请重新选择文件夹", 404));
}

/**
 * agent/MCP 直调服务时的目录校验：只允许宿主已授权的工作区（cwd）。
 * 路由层已用 u.workspace.resolveWorkspace 校验，这里防止绕过。
 */
export async function resolveTaskDirectory(requested: string | undefined, workspace: string): Promise<string> {
  const root = await realpath(workspace).catch(() => invalid("工作目录不存在，请重新选择文件夹", 404));
  if (requested === undefined || !requested.trim()) return root;
  if (!isAbsolute(requested)) invalid("工作目录必须是绝对路径");
  const target = await realpath(requested).catch(() => invalid("工作目录不存在，请重新选择文件夹", 404));
  if (!sameDirectory(root, target)) invalid("只能操作当前工作区", 403);
  return root;
}

/** 等待提醒：整个生成等待不限时，只按配置小时数提醒，不判失败。 */
function waitingReminderOf(task: MediaTaskRecord, waitingReminderHours: number) {
  if (!waitingReminderHours || isFinishedMediaTaskState(task.state)) return undefined;
  const started = Date.parse(task.submittedAt ?? task.createdAt);
  if (Number.isNaN(started)) return undefined;
  const at = started + waitingReminderHours * 3600000;
  return { waitingReminderAt: new Date(at).toISOString(), waitingReminder: Date.now() >= at };
}

/**
 * 「生成 POST 是否已发起」的三态事实（T10）：
 * - attempted：已持久化提交尝试事实，或已有上游 ID（ID 本身就是已发起的证据）；
 * - pending：新格式记录显式声明尚未发起（本地准备阶段，确定未提交）；
 * - unknown：旧格式记录缺少该事实（含上一版可能在未写字段时已发过网络的情况），不可判定，不得当作未提交。
 */
function submissionAttemptFactOf(task: MediaTaskRecord): "pending" | "attempted" | "unknown" {
  if (task.submissionAttemptState === "attempted" || task.submissionAttemptedAt || task.upstreamId) return "attempted";
  if (task.submissionAttemptState === "pending") return "pending";
  return "unknown";
}

/**
 * 摘要：透出跟进、退避、放弃、改名定位与输出可用性字段（契约 v3 §B / v4 §G）。
 * 输出可用性按「当前实际定位（resolvedPath 优先）+ C 的清理记录」判定，缺文件不谎报可用。
 */
async function summaryOf(task: MediaTaskRecord, waitingReminderHours: number): Promise<MediaTaskSummary> {
  const reminder = waitingReminderOf(task, waitingReminderHours);
  const availability = await Promise.all(task.outputs.map(output => mediaTaskOutputAvailability(task, output)));
  const outputs = task.outputs.map((output, index) => {
    const item = availability[index]!;
    // 统一字段：state / resolvedPath / cleanedAt / sha256 / path（path 保留为历史原路径）。
    return {
      path: output.path,
      mimeType: output.mimeType,
      mediaType: output.mediaType,
      ...(output.sha256 ? { sha256: output.sha256 } : {}),
      state: item.state,
      ...(item.cleanedAt ? { cleanedAt: item.cleanedAt } : {}),
      ...(item.resolvedPath ? { resolvedPath: item.resolvedPath } : {}),
    };
  });
  const aggregate = aggregateMediaTaskOutputState(availability);
  const abandoned = mediaTaskAbandoned(task);
  return {
    taskId: task.taskId,
    batchId: task.batchId,
    itemKey: task.itemKey,
    mediaType: task.mediaType,
    state: task.state,
    providerId: task.providerId,
    modelId: task.modelId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    outputs,
    ...(task.error ? { error: task.error } : {}),
    cancellationRequested: task.cancellationRequested,
    ...(task.upstreamCancellation === undefined ? {} : { upstreamCancellation: task.upstreamCancellation }),
    ...(task.canvasId ? { canvasId: task.canvasId } : {}),
    ...(task.nodeId ? { nodeId: task.nodeId } : {}),
    trackingStatus: mediaTaskTrackingStatus(task),
    ...(task.waitingReason ? { waitingReason: task.waitingReason } : {}),
    ...(task.lastQueryAt ? { lastQueryAt: task.lastQueryAt } : {}),
    ...(task.lastQuerySucceededAt ? { lastQuerySucceededAt: task.lastQuerySucceededAt } : {}),
    ...(task.lastUpstreamState ? { lastUpstreamState: task.lastUpstreamState } : {}),
    ...(task.resultReadyAt ? { resultReadyAt: task.resultReadyAt } : {}),
    ...(task.retryAt ? { retryAt: task.retryAt } : {}),
    ...(task.abandonedAt ? { abandonedAt: task.abandonedAt } : {}),
    ...(task.abandonRevokedAt ? { abandonRevokedAt: task.abandonRevokedAt } : {}),
    ...(abandoned ? { abandoned } : {}),
    ...(aggregate?.outputState ? { outputState: aggregate.outputState } : {}),
    ...(aggregate?.cleanedAt ? { cleanedAt: aggregate.cleanedAt } : {}),
    ...(reminder ? reminder : {}),
    // T10：提交尝试事实（三态，恒显式给出）与改名阻断（T15）。
    submissionAttempt: submissionAttemptFactOf(task),
    ...(task.submissionAttemptedAt ? { submissionAttemptedAt: task.submissionAttemptedAt } : {}),
    ...(task.relocationBlocked ? { relocationBlocked: task.relocationBlocked } : {}),
  };
}

function compareTasks(left: { createdAt: string; taskId: string }, right: { createdAt: string; taskId: string }) {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
}

function encodeCursor(task: MediaTaskRecord) {
  return Buffer.from(JSON.stringify({ createdAt: task.createdAt, taskId: task.taskId })).toString("base64url");
}

function decodeCursor(cursor: unknown) {
  if (typeof cursor !== "string" || !cursor.trim()) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt?: unknown; taskId?: unknown };
    if (typeof parsed?.createdAt !== "string" || typeof parsed?.taskId !== "string") throw new Error("游标字段无效");
    return { createdAt: parsed.createdAt, taskId: parsed.taskId };
  } catch {
    return invalid("分页游标无效");
  }
}

function selectedTasks(directory: string, input: { taskIds?: string[]; batchId?: string; batchKey?: string }) {
  if (Array.isArray(input.taskIds)) {
    if (!input.taskIds.length) invalid("taskIds 不能为空");
    if (input.taskIds.length > 200) invalid("taskIds 最多 200 个");
    const tasks: MediaTaskRecord[] = [];
    for (const taskId of input.taskIds) {
      if (typeof taskId !== "string" || !taskId.trim()) invalid("taskIds 必须是字符串数组");
      const task = getMediaTask(taskId);
      // 目录不一致的任务对该工作区不可见。
      if (task && sameDirectory(task.directory, directory)) tasks.push(task);
    }
    return tasks;
  }
  if (typeof input.batchId === "string" && input.batchId.trim()) {
    const batch = getMediaTaskBatch(input.batchId);
    if (!batch || !sameDirectory(batch.directory, directory)) return [];
    return [...batch.tasks].sort(compareTasks);
  }
  if (typeof input.batchKey === "string" && input.batchKey.trim()) {
    return listMediaTaskBatchesByKey(directory, input.batchKey.trim()).flatMap(batch => batch.tasks).sort(compareTasks);
  }
  return invalid("请提供 taskIds、batchId 或 batchKey");
}

/** 收尾：本次受理的新任务从 preparing 放行到 queued（只动本次新增项）。 */
async function queueAcceptedTasks(batchId: string, taskIds: Set<string>) {
  const now = new Date().toISOString();
  await updateMediaTaskBatch(batchId, batch => {
    let changed = false;
    for (const task of batch.tasks) {
      if (!taskIds.has(task.taskId) || task.state !== "preparing") continue;
      task.state = "queued";
      task.stateVersion += 1;
      task.updatedAt = now;
      changed = true;
    }
    return changed;
  });
}

async function pageOf(tasks: MediaTaskRecord[], cursor: unknown, limit: number, waitingReminderHours: number): Promise<MediaTaskGetResult> {
  const sorted = [...tasks].sort(compareTasks);
  const start = decodeCursor(cursor);
  let offset = 0;
  if (start) {
    const found = sorted.findIndex(task => compareTasks(task, start) > 0);
    offset = found < 0 ? sorted.length : found;
  }
  const page = sorted.slice(offset, offset + limit);
  const last = page[page.length - 1];
  const nextCursor = last && offset + limit < sorted.length ? encodeCursor(last) : undefined;
  return {
    tasks: await Promise.all(page.map(task => summaryOf(task, waitingReminderHours))),
    ...(nextCursor ? { nextCursor } : {}),
    counts: countMediaTasksByState(sorted),
  };
}

/* -------------------------------------------------- F16 模型能力前置校验 */

type ProviderModelView = {
  id: string;
  type: string;
  mode?: unknown;
  imageRatios?: string[];
  durationResolutionMap?: { duration?: unknown; resolution?: unknown }[];
};

function referenceCounts(request: Record<string, unknown>) {
  const count = (value: unknown) => Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1;
  return { image: count(request.images) + count(request.firstFrame) + count(request.lastFrame), video: count(request.videos), audio: count(request.audios) };
}

/** 参考数量上限取模型 mode 声明的最大 imageReference:N / videoReference:N / audioReference:N。 */
function declaredReferenceLimits(mode: unknown) {
  const limits: Partial<Record<"image" | "video" | "audio", number>> = {};
  if (!Array.isArray(mode)) return limits;
  for (const entry of mode) {
    if (!Array.isArray(entry)) continue;
    for (const item of entry) {
      const matched = typeof item === "string" ? /^(image|video|audio)Reference:(\d+)$/.exec(item) : null;
      if (!matched) continue;
      const category = matched[1] as "image" | "video" | "audio";
      limits[category] = Math.max(limits[category] ?? 0, Number(matched[2]));
    }
  }
  return limits;
}

/**
 * 提交前按模型声明校验参考数量、时长、分辨率与比例（F16）：
 * 超能力时明确拒绝并给出可选档位，不静默修改用户请求，也不等上游失败。
 * 模型声明了 mode 时，「未声明的参考类别」与「未声明的 mode」同样在受理前拒绝（契约 v3 §C.4），
 * 不能因为字段存在于通用类型就推定供应商支持；模型完全没有 mode 元数据时只能交给供应商判定。
 */
function validateModelRequest(model: ProviderModelView, mediaType: MediaTaskMediaType, request: Record<string, unknown>) {
  const limits = declaredReferenceLimits(model.mode);
  const counts = referenceCounts(request);
  const declaredModes = Array.isArray(model.mode) ? model.mode : [];
  const hasModeMetadata = declaredModes.length > 0;
  const modes = declaredModes.filter((item): item is string => typeof item === "string");
  // 字符串模式（singleImage/multiReference/首尾帧）同样表示模型声明支持参考图。
  const declaresImages = limits.image !== undefined || modes.some(mode =>
    mode === "singleImage" || mode === "multiReference" || mode === "startEndRequired" || mode === "startFrameOptional" || mode === "endFrameOptional");
  for (const category of ["image", "video", "audio"] as const) {
    const limit = limits[category];
    const label = { image: "参考图", video: "参考视频", audio: "参考音频" }[category];
    if (counts[category] <= 0) continue;
    if (category === "image" ? !declaresImages : limit === undefined) {
      // 模型声明了 mode 却没声明该类别 → 受理前拒绝，不静默忽略（契约 v3 §C.4）。
      if (hasModeMetadata) return `所选模型未声明支持${label}，不接受该参考素材（不会被静默忽略）`;
      continue;
    }
    if (limit !== undefined && counts[category] > limit) return `所选模型最多支持 ${limit} 个${label}，当前提交 ${counts[category]} 个`;
  }
  if (modes.includes("singleImage") && !modes.includes("multiReference") && limits.image === undefined && counts.image > 1) {
    return `所选模型只支持单张参考图，当前提交 ${counts.image} 张`;
  }
  const ratios = Array.isArray(model.imageRatios) ? model.imageRatios.filter((item): item is string => typeof item === "string" && !!item) : [];
  if (ratios.length && typeof request.ratio === "string" && request.ratio && !ratios.includes(request.ratio)) {
    return `所选模型不支持 ${request.ratio} 画面比例，可选：${ratios.join(" / ")}`;
  }
  if (mediaType !== "video") return undefined;
  // 请求声明的 mode 必须是模型声明过的模式；数组模式按参考上限逐项核对，未声明的一律拒绝。
  const requestedMode = request.mode;
  if (hasModeMetadata && requestedMode !== undefined && requestedMode !== null) {
    const declared = declaredModes.some(item => JSON.stringify(item) === JSON.stringify(requestedMode));
    if (!declared) {
      const available = declaredModes.map(item => Array.isArray(item) ? item.join("+") : String(item)).join(" / ");
      return `所选模型不支持 ${Array.isArray(requestedMode) ? requestedMode.join("+") : String(requestedMode)} 生成模式，可选：${available}`;
    }
    if (Array.isArray(requestedMode)) {
      for (const entry of requestedMode) {
        const matched = typeof entry === "string" ? /^(image|video|audio)Reference:(\d+)$/.exec(entry) : null;
        if (!matched) return `生成模式 ${String(entry)} 无效，无法确认模型支持`;
        const category = matched[1] as "image" | "video" | "audio";
        const declaredLimit = Number(matched[2]);
        if (counts[category] > declaredLimit) {
          return `生成模式声明最多 ${declaredLimit} 个${ { image: "参考图", video: "参考视频", audio: "参考音频" }[category] }，当前提交 ${counts[category]} 个`;
        }
      }
    }
  }
  const durations = new Set<number>();
  const resolutions = new Set<string>();
  for (const entry of Array.isArray(model.durationResolutionMap) ? model.durationResolutionMap : []) {
    if (!entry || typeof entry !== "object") continue;
    for (const duration of Array.isArray(entry.duration) ? entry.duration : []) if (typeof duration === "number" && Number.isFinite(duration)) durations.add(duration);
    for (const resolution of Array.isArray(entry.resolution) ? entry.resolution : []) if (typeof resolution === "string" && resolution) resolutions.add(resolution);
  }
  if (durations.size && typeof request.duration === "number" && !durations.has(request.duration)) {
    return `所选模型不支持 ${request.duration} 秒时长，可选：${[...durations].sort((left, right) => left - right).join(" / ")} 秒`;
  }
  if (resolutions.size && typeof request.resolution === "string" && request.resolution && !resolutions.has(request.resolution)) {
    return `所选模型不支持 ${request.resolution} 分辨率，可选：${[...resolutions].join(" / ")}`;
  }
  return undefined;
}

/* -------------------------------------------------------------- 受理/查询 */

/**
 * 受理入口（契约 v4 §A.3）：从进入（含目录/供应商/快照/批次锁等待）到持久完成都计入在途受理，
 * 停机排空判定必须同时看作业与这个计数，未开始写盘的协调等待不允许被判成「已排空」。
 */
export async function submitMediaTasks(input: {
  directory: string;
  /** 16-128 字符；客户端首次发送前生成并持久保存。 */
  batchKey: string;
  mediaType: MediaTaskMediaType;
  items: MediaTaskSubmitItem[];
}, options?: { signal?: AbortSignal }): Promise<MediaTaskSubmitResult> {
  const endInflight = beginMediaTaskInflight();
  try {
    return await submitMediaTasksInternal(input, options);
  } finally {
    endInflight();
  }
}

/** 受理：校验请求 → 固定输入快照 → 幂等判定 → 先持久化受理记录再返回 accepted。 */
async function submitMediaTasksInternal(input: {
  directory: string;
  /** 16-128 字符；客户端首次发送前生成并持久保存。 */
  batchKey: string;
  mediaType: MediaTaskMediaType;
  items: MediaTaskSubmitItem[];
}, options?: { signal?: AbortSignal }): Promise<MediaTaskSubmitResult> {
  await ensureMediaTasksStore();
  // 停机后封闭受理（契约 v3 §A.1）：不产生新的上游任务，也不返回任何 taskId。
  if (isMediaTasksStopping()) invalid("服务正在停止，暂不受理新的生成任务", 503);
  const signal = options?.signal;
  const directory = await normalizeDirectory(input.directory);
  if (typeof input.batchKey !== "string" || input.batchKey.length < 16 || input.batchKey.length > 128) invalid("batchKey 长度必须为 16-128 个字符");
  if (!mediaTaskMediaTypes.includes(input.mediaType)) invalid("mediaType 必须是 image、video 或 audio");
  if (!Array.isArray(input.items) || !input.items.length) invalid("items 不能为空");
  // 单次传输限制；排队任务数不设业务上限。
  if (input.items.length > 50) invalid("单次提交最多 50 条任务");
  const schema = input.mediaType === "image" ? imageGenerationSchema : input.mediaType === "video" ? videoGenerationSchema : audioGenerationSchema;
  const settings = mediaTasksRuntimeSettings();
  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const results: MediaTaskSubmitResult["items"] = [];
  const pending: { result: MediaTaskSubmitResult["items"][number]; task: MediaTaskRecord }[] = [];
  const itemKeys = new Set<string>();
  for (const item of input.items) {
    // 请求中断时停止处理剩余项；已持久化项仍可查回，未受理项可同键重传。
    if (signal?.aborted) break;
    const itemKey = typeof item?.itemKey === "string" ? item.itemKey.trim() : "";
    const reject = (reason: string, key = itemKey || String(item?.itemKey ?? "")) => results.push({ itemKey: key, status: "rejected", reason });
    if (!itemKey || itemKey.length > 128) {
      reject("itemKey 必须为 1-128 个字符");
      continue;
    }
    if (itemKeys.has(itemKey)) {
      reject("同一批次内 itemKey 不能重复");
      continue;
    }
    itemKeys.add(itemKey);
    const request = item.request && typeof item.request === "object" && !Array.isArray(item.request) ? item.request as Record<string, unknown> : undefined;
    if (!request) {
      reject("request 必须是 JSON 对象");
      continue;
    }
    if (item.canvasId !== undefined && (typeof item.canvasId !== "string" || !item.canvasId.trim() || item.canvasId.length > 256)) {
      reject("canvasId 无效");
      continue;
    }
    if (item.nodeId !== undefined && (typeof item.nodeId !== "string" || !item.nodeId.trim() || item.nodeId.length > 256)) {
      reject("nodeId 无效");
      continue;
    }
    const parsed = schema.safeParse(request, validationOptions());
    if (!parsed.success) {
      reject(parsed.error.issues.map(issue => translateMessage(issue.message)).join("；") || "请求参数无效");
      continue;
    }
    const mediaRequest = parsed.data as Record<string, unknown>;
    const providerInfo = await getMediaProvider(mediaRequest.providerId as string).catch(() => undefined);
    if (!providerInfo) {
      reject("所选媒体供应商不存在，请重新选择");
      continue;
    }
    const model = providerInfo.models.find(candidate => candidate.id === mediaRequest.modelId && candidate.type === input.mediaType);
    if (!model) {
      reject("所选媒体模型不存在或类型不匹配，请重新选择");
      continue;
    }
    // ACT: 超能力参数在受理前就明确拒绝（F16），不静默改成近似档，也不等上游失败。
    const unsupported = validateModelRequest(model as ProviderModelView, input.mediaType, mediaRequest);
    if (unsupported) {
      reject(unsupported);
      continue;
    }
    let snapshots;
    try {
      snapshots = await createInputSnapshots(directory, input.mediaType, mediaRequest, settings.referenceBudgetMb, signal);
    } catch (error) {
      reject(translateError(error) || "无法读取参考素材");
      continue;
    }
    const idempotencyKey = mediaTaskIdempotencyKey(directory, input.batchKey, itemKey);
    const fingerprint = mediaTaskFingerprint(input.mediaType, mediaRequest, snapshots);
    // 提交时记录查询凭据的非敏感引用，用于日后核对「是否仍是同一账户」；不存原始 Key（契约 v3 §C.2）。
    const credentialRef = mediaProviderCredentialReference(providerInfo.id, mediaProviderApiKeyOf(providerInfo.id));
    const apiBase = normalizeProviderBase(providerInfo.apiUrl);
    // Q1/F14：这里不做锁外 existing 判定——锁外返回 existing 可能命中并发首写尚未落盘的记录。
    // 幂等判定统一在批次锁内的 resolveDuplicates 完成，只有已持久化（即已发布）的记录才会返回 existing。
    const task: MediaTaskRecord = {
      taskId: crypto.randomUUID(),
      batchId,
      itemKey,
      idempotencyKey,
      fingerprint,
      directory,
      mediaType: input.mediaType,
      state: "preparing",
      stateVersion: 1,
      request: mediaRequest,
      ...(item.canvasId ? { canvasId: item.canvasId } : {}),
      ...(item.nodeId ? { nodeId: item.nodeId } : {}),
      providerId: mediaRequest.providerId as string,
      modelId: mediaRequest.modelId as string,
      providerRevision: providerInfo.revision,
      ...(providerInfo.apiUrl ? { providerApiUrl: providerInfo.apiUrl } : {}),
      providerCredentialRef: credentialRef,
      // 历史提交身份（契约 v4 §E）：受理时冻结，恢复/人工 bind 时作为唯一可信提交链依据。
      submissionIdentity: {
        providerId: providerInfo.id,
        modelId: mediaRequest.modelId as string,
        ...(apiBase ? { apiBase } : {}),
        revision: providerInfo.revision,
        credentialRef,
      },
      inputSnapshots: snapshots,
      outputs: [],
      cancellationRequested: false,
      trackingStatus: "active",
      // T09：显式记录「尚未发起提交尝试」的事实。只有新格式带该显式事实的记录，
      // 中断时才能判定“确定未提交”；旧格式记录缺此字段时保守判 unknown。
      submissionAttemptState: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const result: MediaTaskSubmitResult["items"][number] = { itemKey, status: "accepted", taskId: task.taskId };
    results.push(result);
    pending.push({ result, task });
  }
  /**
   * F14：幂等检查必须与批次写入在同一协调范围内，锁内逐项重查。
   * 同键同参并发重传稳定返回 existing；同键不同参返回 rejected；混合新项正常追加。
   */
  const resolveDuplicates = () => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index]!;
      const current = getMediaTaskByKey(entry.task.idempotencyKey);
      if (!current) continue;
      pending.splice(index, 1);
      if (current.fingerprint === entry.task.fingerprint) {
        entry.result.status = "existing";
        entry.result.taskId = current.taskId;
        entry.result.reason = undefined;
        continue;
      }
      entry.result.status = "rejected";
      entry.result.taskId = undefined;
      entry.result.reason = "同一 itemKey 已提交过不同参数的请求，请更换 itemKey";
    }
  };
  // ACT: batchId 对同一 (工作区, batchKey) 稳定，追加提交并入同一批次文件。
  let resolvedBatchId: string = batchId;
  if (pending.length) {
    // ACT: 同键串行执行"查批次-建批次"；并发提交不得产生两个批次文件。
    resolvedBatchId = await withMediaTaskLock(`batch:${mediaTaskBatchKey(directory, input.batchKey)}`, async () => {
      resolveDuplicates();
      const existingBatch = findMediaTaskBatch(directory, input.batchKey);
      if (!pending.length) return existingBatch?.batchId ?? batchId;
      const tasks = pending.map(entry => entry.task);
      const taskIds = new Set(tasks.map(task => task.taskId));
      const targetBatchId: string = existingBatch?.batchId ?? batchId;
      // 记录内的 batchId 必须与落点批次一致（复用既有批次时不能留临时 ID）。
      for (const task of tasks) task.batchId = targetBatchId;
      if (existingBatch) {
        // 先持久化受理记录（preparing），落盘成功后才发布并可被读接口/重传命中，再放行调度。
        await appendMediaTasks(targetBatchId, tasks);
        await queueAcceptedTasks(targetBatchId, taskIds);
        return targetBatchId;
      }
      await createMediaTaskBatch({
        batchId: targetBatchId, batchKey: input.batchKey, directory, mediaType: input.mediaType, tasks,
      });
      await queueAcceptedTasks(targetBatchId, taskIds);
      return targetBatchId;
    });
    for (const { result, task } of pending) result.taskId = task.taskId;
  } else {
    const existingBatch = findMediaTaskBatch(directory, input.batchKey);
    if (existingBatch) resolvedBatchId = existingBatch.batchId;
  }
  // 受理已完成（记录已落盘）：立即触发一次调度，让排队任务尽快开始执行；
  // 本次响应不等上游生成，也不等首次查询（MCP/HTTP 受理语义不变）。
  if (results.some(item => item.status === "accepted")) requestMediaTaskSchedulerTick();
  return { batchId: resolvedBatchId, items: results };
}

/** 查询：目录限定，支持 taskIds（≤200）、batchId 或 batchKey（同键跨多次提交聚合）分页。 */
export async function getMediaTasks(query: {
  directory: string;
  taskIds?: string[];
  batchId?: string;
  batchKey?: string;
  cursor?: string;
  limit?: number;
}): Promise<MediaTaskGetResult> {
  await ensureMediaTasksStore();
  const directory = await normalizeDirectory(query.directory);
  const waitingReminderHours = mediaTasksRuntimeSettings().waitingReminderHours;
  if (Array.isArray(query.taskIds)) {
    const tasks = selectedTasks(directory, { taskIds: query.taskIds });
    return { tasks: await Promise.all(tasks.map(task => summaryOf(task, waitingReminderHours))), counts: countMediaTasksByState(tasks) };
  }
  const limit = typeof query.limit === "number" && Number.isFinite(query.limit) ? Math.min(Math.max(Math.trunc(query.limit), 1), 200) : 50;
  if (typeof query.batchId === "string" && query.batchId.trim()) {
    const batch = getMediaTaskBatch(query.batchId);
    if (!batch || !sameDirectory(batch.directory, directory)) return { tasks: [], counts: {} };
    return pageOf(batch.tasks, query.cursor, limit, waitingReminderHours);
  }
  if (typeof query.batchKey === "string" && query.batchKey.trim()) {
    const batchKey = query.batchKey.trim();
    if (batchKey.length < 16 || batchKey.length > 128) invalid("batchKey 长度必须为 16-128 个字符");
    // ACT: 同键历史数据可能分散在多个批次文件，按 (createdAt, taskId) 统一分页返回。
    const tasks = listMediaTaskBatchesByKey(directory, batchKey).flatMap(batch => batch.tasks);
    return pageOf(tasks, query.cursor, limit, waitingReminderHours);
  }
  return invalid("请提供 taskIds、batchId 或 batchKey");
}

/* ---------------------------------------------------------------- 取消 */

/**
 * 取消（契约 v3 §B）：
 * - preparing/queued：确定未提交 → 本地 cancelled；
 * - downloading：中止本机下载，只暂停取回（保留 downloading 与恢复能力），不声称上游取消；
 * - unknown 且无上游 ID：默认只记录取消意图，不伪造取消；只有明确传 abandonUnconfirmed=true 才按「知情放弃核对」处理；
 * - submitting/running/已绑定 ID：尝试上游确认取消，未确认则只保留取消意图（不重新生成）。
 * 取消 ≠ 暂停跟进：暂停/恢复另见 pauseMediaTasks / resumeMediaTasks。
 */
export async function cancelMediaTasks(input: {
  directory: string;
  taskIds?: string[];
  batchId?: string;
  batchKey?: string;
  /**
   * 仅适用于 unknown 且没有 upstreamId 的任务：用户明确知情「放弃核对，上游可能仍在生成」。
   * 默认 false；不会声称上游取消，只解除保守额度并保留键、输入与历史。
   */
  abandonUnconfirmed?: boolean;
}): Promise<MediaTaskCancelResult> {
  await ensureMediaTasksStore();
  const directory = await normalizeDirectory(input.directory);
  const tasks = selectedTasks(directory, input);
  const abandonUnconfirmed = input.abandonUnconfirmed === true;
  const items: MediaTaskCancelResult["items"] = [];
  const report = (task: MediaTaskRecord, reason?: string) => items.push({
    taskId: task.taskId,
    state: task.state,
    cancellationRequested: task.cancellationRequested,
    ...(task.upstreamCancellation === undefined ? {} : { upstreamCancellation: task.upstreamCancellation }),
    trackingStatus: mediaTaskTrackingStatus(task),
    ...(task.abandonedAt ? { abandonedAt: task.abandonedAt } : {}),
    ...(task.abandonRevokedAt ? { abandonRevokedAt: task.abandonRevokedAt } : {}),
    ...(reason ? { reason } : {}),
  });
  for (const task of tasks) {
    const current = getMediaTask(task.taskId) ?? task;
    if (isFinishedMediaTaskState(current.state)) {
      report(current, "任务已结束，取消不改变已完成的业务事实");
      continue;
    }
    if (abandonUnconfirmed) {
      // 仅 unknown 且无上游 ID 允许知情放弃；其他状态逐项拒绝，不能把已知 running/downloading 改成 unknown。
      if (current.state !== "unknown" || current.upstreamId) {
        report(current, "abandonUnconfirmed 仅适用于没有上游任务 ID 的待核对（unknown）任务");
        continue;
      }
      const abandonedAt = current.abandonedAt && !current.abandonRevokedAt ? current.abandonedAt : new Date().toISOString();
      const updated = await updateMediaTask(current.taskId, next => next.state === "unknown" && !next.upstreamId
        ? record => {
          // 幂等：重复放弃保留原 abandonedAt；保留键、输入与历史，只解除保守额度（不占上游在途）。
          record.abandonedAt = abandonedAt;
          record.abandonRevokedAt = undefined;
          record.trackingStatus = "paused";
          record.waitingReason = "已放弃核对（不声称上游取消；核到原 ID 后仍可用 bind/resume 接回并按实际计入额度）";
          record.retryAt = undefined;
          record.retryCount = undefined;
        }
        : undefined);
      report(updated ?? current, current.abandonedAt && !current.abandonRevokedAt
        ? "该任务已处于放弃核对状态（重复操作幂等）"
        : "已按明确放弃核对处理：不声称上游取消，保留键、输入与历史；核到原 ID 仍可 bind/resume 接回");
      continue;
    }
    if (current.state === "preparing" || current.state === "queued") {
      const updated = await updateMediaTask(current.taskId, next => next.state === "preparing" || next.state === "queued"
        ? record => {
          record.state = "cancelled";
          record.cancellationRequested = true;
          record.trackingStatus = undefined;
          record.waitingReason = undefined;
          record.completedAt = new Date().toISOString();
          record.retryAt = undefined;
          record.retryCount = undefined;
        }
        : undefined);
      report(updated ?? current, "尚未提交上游，已取消");
      continue;
    }
    if (current.state === "downloading") {
      // 中止本机下载并暂停取回：上游已经生成完成，保留 downloading 与恢复能力（resume 继续取回）。
      abortMediaTaskJob(current.taskId);
      const updated = await updateMediaTask(current.taskId, next => next.state === "downloading"
        ? record => {
          record.cancellationRequested = true;
          record.trackingStatus = "paused";
          record.waitingReason = "已暂停取回结果；上游已生成的内容不会重复生成，用 resume 可继续取回";
          // 未来 retryAt 下限保留：取消取回不等于取消上游退避约束（契约 v3 §B）。
          clearExpiredMediaTaskRetryAt(record);
        }
        : undefined);
      report(updated ?? current, "已暂停取回结果（保留可恢复状态；上游已生成的内容不会重复生成）");
      continue;
    }
    if (current.state === "unknown" && !current.upstreamId) {
      // 没有独立放弃参数时不得伪造取消：只记录取消意图，保持待核对与保守额度。
      const updated = await updateMediaTask(current.taskId, next => next.state === "unknown" && !next.upstreamId
        ? record => {
          record.cancellationRequested = true;
          record.waitingReason = "待核对任务缺少上游 ID：已记录取消意图，但不能确认上游是否已受理；如确认放弃核对请明确使用 abandonUnconfirmed";
        }
        : undefined);
      report(updated ?? current, "待核对任务未确认上游受理：已记录取消意图，如需放弃核对请在明确知情后使用 abandonUnconfirmed（不会声称上游已取消）");
      continue;
    }
    // submitting / running / 已绑定 ID 的 unknown：先尝试上游确认取消，未确认则只保留取消意图。
    const confirmed = await cancelUpstreamMediaTask(current);
    if (confirmed) {
      abortMediaTaskJob(current.taskId);
      const updated = await updateMediaTask(current.taskId, next => next.state === "submitting" || next.state === "running" || next.state === "unknown"
        ? record => {
          record.state = "cancelled";
          record.cancellationRequested = true;
          record.upstreamCancellation = true;
          record.trackingStatus = undefined;
          record.waitingReason = undefined;
          record.completedAt = new Date().toISOString();
          record.retryAt = undefined;
          record.retryCount = undefined;
        }
        : undefined);
      report(updated ?? current, "上游已确认取消");
      continue;
    }
    const updated = await updateMediaTask(current.taskId, next => isFinishedMediaTaskState(next.state) ? undefined : record => {
      record.cancellationRequested = true;
    });
    report(
      updated ?? current,
      "已记录取消意图；上游未确认取消时会继续按原任务查询，恢复到确认取消或上游终态（不重新生成）",
    );
  }
  return { items };
}

/* ------------------------------------------------------------ 暂停/恢复跟进 */

/**
 * 本次实际查询所用的账户/命名空间（T07）：按**当前**配置的 providerId + 凭据引用计算，
 * 不受任务历史提交 Key 影响。历史 Key A/B 的两条任务切到同一当前 Key C 后属于同一命名空间，
 * 绑定唯一性必须在该命名空间内成立，否则顺序操作也能双重绑定同一个上游 ID。
 */
function mediaTaskQueryNamespace(providerId: string, info?: { id?: string }) {
  const id = info?.id ?? providerId;
  return `${id}\u0000${mediaProviderCredentialReference(id, mediaProviderApiKeyOf(id))}`;
}

/**
 * 绑定唯一性临界区锁键（契约 v4 §E/T07）：同一「本次实际查询账户命名空间 + upstreamId」串行化，
 * 两个任务不得在检查之后同时通过再绑定同一个上游 ID。
 */
function mediaTaskUpstreamBindingKey(namespace: string, upstreamId: string) {
  return `upstream-binding:${namespace}\u0000${upstreamId}`;
}

/** 同一「本次实际查询账户命名空间」下该上游 ID 是否已绑定到别的本地任务（跨工作区同样拦截）。 */
function findUpstreamOwner(taskId: string, namespace: string, upstreamId: string) {
  return listMediaTasks().find(candidate => {
    if (candidate.taskId === taskId || candidate.upstreamId !== upstreamId) return false;
    return mediaTaskQueryNamespace(candidate.providerId) === namespace;
  });
}

/** 核对成功后要持久化的恢复依据（契约 v4 §E/T07）：只记录真正核实过的字段，绝不编造账户。 */
function verifiedRecoveryOf(
  task: MediaTaskRecord,
  upstreamId: string,
  verification: UpstreamOwnershipVerification,
  source: MediaTaskVerifiedRecovery["source"],
  identity: MediaTaskQueryIdentity,
): MediaTaskVerifiedRecovery {
  return {
    upstreamId,
    ...(verification.verified.includes("model") ? { model: task.modelId } : {}),
    ...(verification.accountHash ? { accountHash: verification.accountHash } : {}),
    verifiedAt: new Date().toISOString(),
    source,
    // T07：持久化「核验当时」的完整查询身份；此后 Key/地址/供应商版本变化时免检立即失效，必须重新核对。
    identity,
  };
}

/**
 * 写入核验结果前的身份复核（T07）：核验期间供应商身份/凭据/地址/版本发生变化时不得写入
 * 「已核实」结论。任务版本（含 pause）的比较由各调用点在锁内用闭包版本号完成。
 */
async function verificationIdentityStillCurrent(providerId: string, task: MediaTaskRecord, expected: MediaTaskQueryIdentity) {
  const fresh = await getMediaProvider(providerId).catch(() => undefined);
  if (!fresh) return { ok: false as const, reason: "供应商已被删除或无法读取，未写入恢复依据" };
  if (!mediaTaskQueryIdentityMatches(expected, mediaTaskQueryIdentity(task, fresh))) {
    return { ok: false as const, reason: "核对期间供应商身份或查询凭据已变化，未写入恢复依据（请重新核对后再试）" };
  }
  return { ok: true as const };
}

/**
 * 暂停服务端跟进：置 trackingStatus=paused（主状态不变，上游可能仍在生成），停止查询/下载，等待 resume。
 * 排队/准备阶段（preparing/queued）没有可暂停的跟进动作：明确返回「不适用」，
 * 排队启停由全局 settings.mediaTasks.paused 或取消控制（契约 §4/§5.2，V04）。
 */
export async function pauseMediaTasks(input: {
  directory: string;
  taskIds?: string[];
  batchId?: string;
  batchKey?: string;
}): Promise<MediaTaskFollowUpResult> {
  await ensureMediaTasksStore();
  const directory = await normalizeDirectory(input.directory);
  const tasks = selectedTasks(directory, input);
  const items: MediaTaskFollowUpItem[] = [];
  for (const task of tasks) {
    const current = getMediaTask(task.taskId) ?? task;
    const base = {
      taskId: current.taskId,
      state: current.state,
      trackingStatus: mediaTaskTrackingStatus(current),
      ...(current.upstreamId ? { upstreamId: current.upstreamId } : {}),
    };
    if (isFinishedMediaTaskState(current.state)) {
      items.push({ ...base, status: "rejected", reason: "任务已结束，无需暂停跟进" });
      continue;
    }
    if (current.state === "preparing" || current.state === "queued") {
      items.push({ ...base, status: "rejected", reason: "任务尚未提交上游，没有可暂停的跟进动作：排队启停请使用全局暂停，或直接取消该任务" });
      continue;
    }
    let applied = false;
    let updated: MediaTaskRecord | undefined;
    try {
      updated = await updateMediaTask(current.taskId, record => {
        if (isFinishedMediaTaskState(record.state)) return undefined;
        return target => {
          applied = true;
          target.trackingStatus = "paused";
          target.waitingReason = record.state === "submitting"
            ? "已暂停服务器跟进（提交已在进行中，不会强杀；取得上游 ID 后会保留暂停状态）"
            : "已暂停服务器跟进（主状态不变，上游可能仍在生成）";
          // 未来 retryAt 下限保留：暂停不推翻上游 Retry-After 与本地退避（契约 v3 §B）。
          clearExpiredMediaTaskRetryAt(target);
        };
      });
    } catch (error) {
      items.push({ ...base, status: "rejected", reason: translateError(error) || "暂停跟进失败" });
      continue;
    }
    if (!applied || !updated) {
      items.push({ ...base, status: "rejected", reason: "任务已结束，无需暂停跟进" });
      continue;
    }
    // T06：暂停后中止正在进行的下载网络尝试（可中断即中断，真实网络收尾后作业退出并归还下载槽；
    // 已持久化的上游 ID 与已保存结果不受影响，resume 后继续取回原结果）。
    // 提交中的任务不强杀（避免丢掉可能已取得的 ID），只记暂停意图。
    if (updated.state === "downloading") abortMediaTaskJob(current.taskId);
    items.push({
      taskId: updated.taskId,
      status: "paused",
      state: updated.state,
      trackingStatus: mediaTaskTrackingStatus(updated),
      ...(updated.upstreamId ? { upstreamId: updated.upstreamId } : {}),
    });
  }
  requestMediaTaskSchedulerTick();
  return { items };
}

/**
 * 恢复跟进：置回 active 并立即安排一次查询。
 * 只查询/下载已有任务，绝不创建新上游任务；兼容更新继续查询，不兼容保持 blocked 可再次 resume。
 * bindTasks 用于给没有上游 ID 的待核对任务绑定人工核对过的上游 ID（校验工作区、供应商、任务类型）。
 */
export async function resumeMediaTasks(input: {
  directory: string;
  taskIds?: string[];
  batchId?: string;
  batchKey?: string;
  bindTasks?: MediaTaskBindInput[];
}): Promise<MediaTaskFollowUpResult> {
  await ensureMediaTasksStore();
  const directory = await normalizeDirectory(input.directory);
  const hasSelection = Array.isArray(input.taskIds) || (typeof input.batchId === "string" && !!input.batchId.trim())
    || (typeof input.batchKey === "string" && !!input.batchKey.trim());
  if (!hasSelection && input.bindTasks === undefined) invalid("请提供 taskIds、batchId、batchKey 或 bindTasks");
  const items: MediaTaskFollowUpItem[] = [];
  const handled = new Set<string>();
  if (input.bindTasks !== undefined) {
    if (!Array.isArray(input.bindTasks) || !input.bindTasks.length) invalid("bindTasks 不能为空");
    if (input.bindTasks.length > 200) invalid("bindTasks 最多 200 条");
    for (const entry of input.bindTasks) {
      const taskId = typeof entry?.taskId === "string" ? entry.taskId.trim() : "";
      const upstreamId = typeof entry?.upstreamId === "string" ? entry.upstreamId.trim() : "";
      if (!taskId || taskId.length > 256) invalid("bindTasks 每项必须包含有效的 taskId");
      if (!upstreamId || upstreamId.length > 512 || /[\s\u0000-\u001f]/.test(upstreamId)) invalid("bindTasks 每项必须包含有效的 upstreamId（不含空白字符）");
      const task = getMediaTask(taskId);
      if (!task || !sameDirectory(task.directory, directory)) {
        items.push({ taskId, status: "rejected", reason: "任务不存在或不属于当前工作区" });
        continue;
      }
      handled.add(taskId);
      if (task.upstreamId) {
        if (task.upstreamId !== upstreamId) {
          items.push({
            taskId, status: "rejected", state: task.state, trackingStatus: mediaTaskTrackingStatus(task), upstreamId: task.upstreamId,
            reason: "任务已有不同的上游任务 ID，不能覆盖绑定",
          });
          continue;
        }
        // 同任务同 ID：默认幂等；被自动兼容门挡住（如历史记录缺地址/凭据引用）时，
        // 用同一条只读核对放行，成功后恢复跟进，不写新 ID、不重新生成。
        if (mediaTaskTrackingStatus(task) !== "blocked") {
          items.push({
            taskId, status: "resumed", state: task.state, trackingStatus: mediaTaskTrackingStatus(task), upstreamId,
            reason: "任务已绑定同一上游任务 ID（幂等，未做改动）；如需继续跟进请使用 resume",
          });
          continue;
        }
        // T07：核对之前先固定任务版本、上游 ID 与「核验当时使用的完整查询身份」；
        // 核对期间发生的 pause（版本变化）或 Key/地址/版本变化都必须在写入前比较时被发现，不得被迟到核验吸收。
        const rematchInfo = await getMediaProvider(task.providerId).catch(() => undefined);
        if (!rematchInfo) {
          items.push({
            taskId, status: "rejected", state: task.state, trackingStatus: mediaTaskTrackingStatus(task), upstreamId,
            reason: "供应商已被删除或无法读取，无法核对任务归属",
          });
          continue;
        }
        const rematchIdentity = mediaTaskQueryIdentity(task, rematchInfo);
        const rematchNamespace = mediaTaskQueryNamespace(task.providerId, rematchInfo);
        const unblockVersion = task.stateVersion;
        const unblockProviderId = task.providerId;
        const unblockUpstreamId = task.upstreamId;
        const unblock = await verifyUpstreamMediaTask(task, upstreamId);
        if (!unblock.ok) {
          items.push({
            taskId, status: "rejected", state: task.state, trackingStatus: mediaTaskTrackingStatus(task), upstreamId,
            reason: unblock.reason ?? "上游任务归属核对失败，保持受阻",
          });
          continue;
        }
        // 核对成功解除 blocked 必须持久化 verifiedRecovery（下次 load 复用，但身份变化即失效），
        // 且绑定唯一性（按本次实际查询账户命名空间）、任务版本与查询身份在同一临界区锁内最终重查。
        const unblockOutcome = await withMediaTaskLock(mediaTaskUpstreamBindingKey(rematchNamespace, upstreamId), async () => {
          const owner = findUpstreamOwner(taskId, rematchNamespace, upstreamId);
          if (owner) return { applied: false, reason: `该上游任务 ID 在当前查询账户下已绑定到本地任务 ${owner.taskId}（批次 ${owner.batchId}），不能重复绑定` };
          const identityCheck = await verificationIdentityStillCurrent(unblockProviderId, task, rematchIdentity);
          if (!identityCheck.ok) return { applied: false, reason: identityCheck.reason };
          let applied = false;
          const updated = await updateMediaTask(taskId, (record, version) => {
            if (isFinishedMediaTaskState(record.state)) return undefined;
            // 落盘前重查任务版本与供应商身份：核对开始后被别的写入（含 pause）改动则放弃写入，不覆盖新事实。
            if (version !== unblockVersion || record.providerId !== unblockProviderId || record.upstreamId !== unblockUpstreamId) return undefined;
            return target => {
              applied = true;
              target.trackingStatus = "active";
              target.waitingReason = undefined;
              target.verifiedRecovery = verifiedRecoveryOf(task, upstreamId, unblock, "rematch", rematchIdentity);
              clearExpiredMediaTaskRetryAt(target);
              if (target.abandonedAt && !target.abandonRevokedAt) target.abandonRevokedAt = new Date().toISOString();
            };
          });
          return { applied, updated, reason: applied ? undefined : "核对期间任务状态/版本已变化，未写入恢复依据（请重新查询后再试）" };
        });
        items.push({
          taskId, status: unblockOutcome.applied ? "resumed" : "rejected", state: unblockOutcome.updated?.state ?? task.state,
          trackingStatus: unblockOutcome.applied ? "active" : mediaTaskTrackingStatus(task), upstreamId,
          reason: unblockOutcome.applied
            ? `已按只读查询核对（${unblock.verified.join("/")}）并解除受阻状态，已持久化恢复依据，继续按原 ID 查询`
            : unblockOutcome.reason ?? "任务已结束，无法恢复跟进",
        });
        continue;
      }
      if (task.state !== "unknown") {
        items.push({
          taskId, status: "rejected", state: task.state, trackingStatus: mediaTaskTrackingStatus(task),
          reason: "只有待核对（unknown）任务需要人工绑定上游任务 ID",
        });
        continue;
      }
      const info = await getMediaProvider(task.providerId).catch(() => undefined);
      if (!info) {
        items.push({ taskId, status: "rejected", state: task.state, trackingStatus: mediaTaskTrackingStatus(task), reason: "供应商已被删除或无法读取，无法核对任务归属" });
        continue;
      }
      if (!info.models.some(model => model.id === task.modelId)) {
        items.push({ taskId, status: "rejected", state: task.state, trackingStatus: mediaTaskTrackingStatus(task), reason: `供应商已不再提供模型 ${task.modelId}，无法核对任务归属` });
        continue;
      }
      // 核对开始前的任务版本、供应商身份与「本次实际查询身份」快照：写入前必须在临界区内再次比对（契约 v4 §E/T07）。
      const verificationVersion = task.stateVersion;
      const verificationProviderId = task.providerId;
      const verificationIdentity = mediaTaskQueryIdentity(task, info);
      const verificationNamespace = mediaTaskQueryNamespace(task.providerId, info);
      // 只读上游核对：核对响应 ID / 模型 / 可验证账户；核对失败不写 ID、不新建生成、不留半绑定。
      const verification = await verifyUpstreamMediaTask(task, upstreamId);
      if (!verification.ok) {
        items.push({
          taskId, status: "rejected", state: task.state, trackingStatus: mediaTaskTrackingStatus(task),
          reason: verification.reason ?? "上游任务归属核对失败，未绑定",
        });
        continue;
      }
      // 绑定唯一性（同「本次实际查询账户命名空间 + upstreamId」不得绑定到另一本地任务）在共同临界区锁内重查后再写入。
      const bindingOutcome = await withMediaTaskLock(mediaTaskUpstreamBindingKey(verificationNamespace, upstreamId), async () => {
        const owner = findUpstreamOwner(taskId, verificationNamespace, upstreamId);
        if (owner) return { applied: false, reason: `该上游任务 ID 在当前查询账户下已绑定到本地任务 ${owner.taskId}（批次 ${owner.batchId}），不能重复绑定` };
        const identityCheck = await verificationIdentityStillCurrent(verificationProviderId, task, verificationIdentity);
        if (!identityCheck.ok) return { applied: false, reason: identityCheck.reason };
        let applied = false;
        const updated = await updateMediaTask(taskId, (record, version) => {
          if (record.state !== "unknown" || record.upstreamId) return undefined;
          if (version !== verificationVersion || record.providerId !== verificationProviderId) return undefined;
          return target => {
            applied = true;
            target.upstreamId = upstreamId;
            target.state = "running";
            target.trackingStatus = "active";
            target.waitingReason = undefined;
            target.error = undefined;
            target.submittedAt ??= new Date().toISOString();
            target.lastUpstreamState = verification.upstreamState ? `bound:${verification.upstreamState}` : "bound";
            // 核对成功即持久化恢复依据（含核验当时的完整查询身份）：身份变化后免检立即失效。
            target.verifiedRecovery = verifiedRecoveryOf(task, upstreamId, verification, "bind", verificationIdentity);
            clearExpiredMediaTaskRetryAt(target);
            target.retryCount = 0;
            // 放弃核对后重新接回：撤销豁免，按实际上游未终结事实重新计入额度（契约 v3 §B）。
            if (target.abandonedAt && !target.abandonRevokedAt) target.abandonRevokedAt = new Date().toISOString();
          };
        });
        return { applied, updated, reason: applied ? undefined : "任务状态或版本在核对期间已变化，未绑定（请重新查询后再试）" };
      }).catch(error => ({ applied: false, updated: undefined, reason: translateError(error) || "绑定上游任务 ID 失败" }));
      if (!bindingOutcome.applied) {
        items.push({
          taskId, status: "rejected", state: task.state, trackingStatus: mediaTaskTrackingStatus(task),
          reason: bindingOutcome.reason ?? "绑定上游任务 ID 失败",
        });
        continue;
      }
      const unverifiable = verification.unverifiable.length ? `；上游未回显 ${verification.unverifiable.join("/")}，该维度无法核对` : "";
      items.push({
        taskId, status: "resumed", state: bindingOutcome.updated!.state, trackingStatus: "active", upstreamId,
        reason: `已按只读查询核对（${verification.verified.join("/")}）并绑定上游任务 ID，已持久化恢复依据，立即恢复查询${unverifiable}`,
      });
    }
  }
  if (hasSelection) {
    const tasks = selectedTasks(directory, input);
    for (const task of tasks) {
      if (handled.has(task.taskId)) continue;
      const current = getMediaTask(task.taskId) ?? task;
      const base = {
        taskId: current.taskId,
        state: current.state,
        trackingStatus: mediaTaskTrackingStatus(current),
        ...(current.upstreamId ? { upstreamId: current.upstreamId } : {}),
      };
      if (isFinishedMediaTaskState(current.state)) {
        items.push({ ...base, status: "rejected", reason: "任务已结束，无法恢复跟进" });
        continue;
      }
      // Q3/契约 v3 §B：恢复只用于「已有上游 ID 的查询/下载」。
      // 无 ID 的 preparing/queued 明确拒绝——resume 绝不能触发首次生成；无 ID 的 unknown 需先 bind 成功。
      if (!current.upstreamId) {
        const pendingSubmit = current.state === "preparing" || current.state === "queued";
        items.push({
          ...base, status: "rejected",
          reason: current.state === "unknown"
            ? "待核对任务缺少上游任务 ID：请先用 bindTasks 绑定人工核对过的上游 ID；恢复入口不会触发首次生成"
            : pendingSubmit
            ? "任务尚未提交上游：恢复入口只查询/下载已有任务，不会触发首次生成；如需生成请重新提交（全局排队/暂停用设置 mediaTasks.paused 控制）"
            : "任务缺少上游任务 ID，无法查询（恢复入口不会创建新的上游任务）",
        });
        continue;
      }
      {
        const info = await getMediaProvider(current.providerId).catch(() => undefined);
        if (!info) {
          await updateMediaTask(current.taskId, record => isFinishedMediaTaskState(record.state) ? undefined : target => {
            target.trackingStatus = "blocked";
            target.waitingReason = "供应商已被删除或无法读取，需人工恢复后再次 resume";
            clearExpiredMediaTaskRetryAt(target);
          });
          items.push({ ...base, status: "blocked", trackingStatus: "blocked", reason: "供应商已被删除或无法读取，需人工恢复后再次 resume" });
          continue;
        }
        const compatibility = providerCompatibility(current, info);
        if (!compatibility.compatible) {
          await updateMediaTask(current.taskId, record => isFinishedMediaTaskState(record.state) ? undefined : target => {
            target.trackingStatus = "blocked";
            target.waitingReason = compatibility.reason ?? "供应商配置不兼容，需人工确认";
            clearExpiredMediaTaskRetryAt(target);
          });
          items.push({ ...base, status: "blocked", trackingStatus: "blocked", reason: compatibility.reason ?? "供应商配置不兼容，需人工确认" });
          continue;
        }
      }
      let applied = false;
      let updated: MediaTaskRecord | undefined;
      try {
        updated = await updateMediaTask(current.taskId, record => {
          if (isFinishedMediaTaskState(record.state)) return undefined;
          return target => {
            applied = true;
            // 有上游 ID 的待核对旧记录恢复为 running，继续按原 ID 查询。
            if (target.state === "unknown" && target.upstreamId) target.state = "running";
            target.trackingStatus = "active";
            target.waitingReason = undefined;
            target.error = undefined;
            // 未来 retryAt 下限保留：恢复不得提前突破上游 Retry-After / 本地退避（契约 v3 §B）。
            clearExpiredMediaTaskRetryAt(target);
            target.completedAt = undefined;
            // 取消后恢复取回：用户明确要求继续取回，清除取消意图（不重新生成上游任务）。
            if (target.state === "downloading") target.cancellationRequested = false;
            // 放弃核对后恢复：撤销豁免，按实际上游未终结事实重新计入额度。
            if (target.abandonedAt && !target.abandonRevokedAt) target.abandonRevokedAt = new Date().toISOString();
          };
        });
      } catch (error) {
        items.push({ ...base, status: "rejected", reason: translateError(error) || "恢复跟进失败" });
        continue;
      }
      if (!applied || !updated) {
        items.push({ ...base, status: "rejected", reason: "任务已结束，无法恢复跟进" });
        continue;
      }
      const retryAt = updated.retryAt && Date.parse(updated.retryAt) > Date.now() ? updated.retryAt : undefined;
      items.push({
        taskId: updated.taskId,
        status: "resumed",
        state: updated.state,
        trackingStatus: mediaTaskTrackingStatus(updated),
        ...(updated.upstreamId ? { upstreamId: updated.upstreamId } : {}),
        reason: retryAt
          ? `已恢复跟进，继续按原任务查询/补取；遵守最早重试时间 ${retryAt}（不创建新的上游任务）`
          : "已恢复跟进，立即安排一次查询（不创建新的上游任务）",
      });
    }
  }
  requestMediaTaskSchedulerTick();
  return { items };
}

/* ------------------------------------------------------ 任务输出路径迁移（供 C 调用） */

// 路径归一化 / 当前定位 / 前缀判定统一复用 store 的只读助手（§P.1 状态与核对同口径，避免第二套判定）。

/** 绝对路径转工作区相对；相对路径保持原样（统一正斜杠）。 */
function relativeInDirectory(directory: string, path: string) {
  return normalizeRelativePrefix(isAbsolute(path) ? relative(directory, path) : path);
}

/**
 * §P.1/缝2：把 C 的归属路径映射（绝对 path 对，`paths`）转成工作区相对映射；非法/原地不动的项丢弃，
 * 按最长前缀优先，保证嵌套路径按最具体的一条映射。
 */
function relocationRelativePathPairs(directory: string, paths: unknown) {
  if (!Array.isArray(paths)) return [] as { from: string; to: string }[];
  const pairs: { from: string; to: string }[] = [];
  for (const item of paths) {
    if (!item || typeof item !== "object") continue;
    const from = (item as { from?: unknown }).from;
    const to = (item as { to?: unknown }).to;
    if (typeof from !== "string" || !from || typeof to !== "string" || !to) continue;
    const relativeFrom = normalizeRelativePrefix(relative(directory, isAbsolute(from) ? from : resolve(directory, from)));
    const relativeTo = normalizeRelativePrefix(relative(directory, isAbsolute(to) ? to : resolve(directory, to)));
    if (!relativeFrom || !relativeTo || relativeFrom === relativeTo) continue;
    pairs.push({ from: relativeFrom, to: relativeTo });
  }
  return pairs.sort((left, right) => right.from.length - left.from.length);
}

/**
 * §P.1/缝2：outputs 定位改写。C 提供 paths 时按**精确路径对**映射（未覆盖的项不改写，由收敛核对如实报告，
 * 避免把不属于本次迁移的定位擅自搬走）；paths 为空时按 source→target 前缀映射（目录整体改名的既有语义，
 * 供 alreadyRelocated 等 paths 为空的既有路径使用）。
 */
function rewriteOutputUnderRelocation(output: MediaTaskOutput, movedFrom: string, movedTo: string, pairs: { from: string; to: string }[]): MediaTaskOutput | undefined {
  const current = currentOutputPath(output);
  if (!current) return undefined;
  if (pairs.length) {
    for (const pair of pairs) {
      if (outputPathUnderPrefix(current, pair.from)) return { ...output, resolvedPath: `${pair.to}${current.slice(pair.from.length)}` };
    }
    return undefined;
  }
  if (!outputPathUnderPrefix(current, movedFrom)) return undefined;
  return { ...output, resolvedPath: `${movedTo}${current.slice(movedFrom.length)}` };
}

/** 按字典序嵌套获取受影响任务锁（契约 v4 §K）：并发批处理不会互相错序。 */
async function withMediaTaskLocks<T>(taskIds: string[], operation: () => Promise<T>): Promise<T> {
  const [first, ...rest] = taskIds;
  if (!first) return operation();
  return withMediaTaskLock(first, () => withMediaTaskLocks(rest, operation));
}

export type MediaTaskRelocateInput = {
  /** 单任务形式；省略时按 directory 对受影响多任务做批处理。 */
  taskId?: string;
  /** 批处理形式；单任务形式可省略（由任务记录推导）。 */
  directory?: string;
  /** 工作区内绝对路径或工作区相对路径（正/反斜杠均可）。 */
  source: string;
  target: string;
};

/**
 * §P.1/§P.2 事务收敛状态（可读返回，含未收敛 taskId 与原因）：
 * participants = 本次事务完整参与集合（持久意图/持久阻断 ∪ 当前核对发现，含已发布到目标的成员）；
 * phase = committed（全部提交收敛）/compensated（全部完整补偿收敛）/unsettled（存在未收敛项，唯一意图未解除）；
 * open 逐项给出未收敛原因（任务缺失、outputs 未到目标/未回落、本事务阻断未清、方向失败等）。
 */
export type MediaTaskRelocationConvergence = {
  transactionId: string;
  phase: "committed" | "compensated" | "unsettled";
  participants: string[];
  open: { taskId: string; reason: string }[];
};

export type MediaTaskRelocateResult = {
  ok: boolean;
  /** 实际改写 outputs 条数。 */
  updated?: number;
  reason?: string;
  /** EINVALID | ENOTFOUND | EBUSY | EOCCUPIED | ERECORDS | EPARTIAL（沿用 C 的 relocateWorkspacePath 代码）。 */
  code?: string;
  tasks?: { taskId: string; updated: number }[];
  /**
   * 事务未收敛（§P.2）：部分失败且补偿不足，或参与集合未全部收敛——受影响任务已写入阻断记录或唯一意图保留，
   * reason 中如实区分「已确认持久保护」与「持久化失败，需恢复核对（仅本进程运行时阻断）」。
   */
  blocked?: boolean;
  /**
   * C 协调结果带出的如实说明（§O.2：改名事务已完成但迁移意图保护清除失败等）：
   * 「保护仍在，需清理核对」必须被调用方与前端看到，不得在 Q 的返回结构里被吞掉；成功与失败路径都原样透传。
   */
  warning?: string;
  /** §P.1/§P.2：本事务参与集合与逐项收敛状态（涉及事务时给出；未收敛即未解除唯一意图、不返回成功）。 */
  convergence?: MediaTaskRelocationConvergence;
};

type RelocationSnapshot = {
  before: MediaTaskOutput[];
  after: MediaTaskOutput[];
  /**
   * 迁移前的有效阻断（持久字段优先、运行时兜底）：回滚时按原值恢复，不把已有阻断抹掉；
   * 若原本只有运行时阻断，回滚写入会把它升级为持久事实（更保守）。
   */
  beforeBlock?: MediaTaskRelocationBlock;
};

/** 两个工作区相对路径是否互相覆盖（相等或互为祖先/后代；a 与 ab 不混）。 */
function relocationPathsOverlap(left: string, right: string) {
  const normalizedLeft = normalizeRelativePrefix(left);
  const normalizedRight = normalizeRelativePrefix(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}/`)
    || normalizedRight.startsWith(`${normalizedLeft}/`);
}

/**
 * 同一目录内与本次改名路径相关的未完成改名阻断（T15/§O.1 的实际消费点）：
 * 命中即拒绝本次改名并给出可读原因（含事务身份与阻断来源），避免在「真实文件位置与任务 outputs
 * 未核对」的状态上继续搬动/改写；**精确重试同一条 source→target** 是人工恢复路径，允许继续
 * （成功事务会在同一写入内清除阻断）。
 */
function blockedRelocationTasks(directory: string, from: string, to: string) {
  return listUnfinishedRelocationTasks()
    .filter(entry => sameDirectory(entry.task.directory, directory))
    .filter(({ block }) => !(normalizeRelativePrefix(block.source) === from && normalizeRelativePrefix(block.target) === to))
    .filter(({ block }) => relocationPathsOverlap(block.source, from) || relocationPathsOverlap(block.target, from)
      || relocationPathsOverlap(block.source, to) || relocationPathsOverlap(block.target, to));
}

/**
 * 在受影响任务上持久化改名阻断记录（T15/§O.1）：调用方必须已持有这些任务的锁。
 * 记录携带事务身份（transactionId/directory/refs），供重启后与 C 的持久意图互认、按同一事务恢复。
 * 写入失败的项不吞掉：返回失败 taskId 列表，同时保留**运行时阻断**（同样带事务身份）供后续改名判据
 * 实际消费；调用方据此停止本次操作并如实说明「持久化失败，需恢复核对」，不得宣称跨重启已保证。
 */
async function persistRelocationBlock(taskIds: string[], block: MediaTaskRelocationBlock): Promise<string[]> {
  const failed: string[] = [];
  for (const taskId of taskIds) {
    const value = { ...block, taskIds: [...block.taskIds], ...(block.refs ? { refs: [...block.refs] } : {}) };
    try {
      const updated = await updateMediaTaskWithinLock(taskId, () => target => {
        target.relocationBlocked = value;
      });
      if (!updated) {
        // 任务记录不存在（已结束/被移除）：持久阻断写不进任何记录，只能靠运行时阻断与 C 的持久范围保护。
        registerRuntimeRelocationBlock(taskId, value);
        failed.push(taskId);
        continue;
      }
      clearRuntimeRelocationBlock(taskId);
    } catch (error) {
      registerRuntimeRelocationBlock(taskId, value);
      failed.push(taskId);
      console.warn(`媒体任务改名阻断记录写入失败（已保留运行时阻断）：${taskId}`, error);
    }
  }
  return failed;
}

/**
 * 多任务写回部分失败的真实补偿（T15/§O.1/§O.3/§P.2）：
 * 1) 先把真实文件与归属反向搬回（同样带身份与**同一事务身份**约束：C 据此识别同一事务的补偿方向，
 *    不把它当成另一笔触及既有意图的移动）；**反向同样传 deferIntentRelease=true**——两个方向都不得由 C
 *    自行解除唯一意图（R1a），由 Q 在「全部参与者已提交」或「全部参与者已完整补偿」逐项核对通过后统一解除；
 * 2) 反向搬回成功时，把全部**尝试写入**的参与项（含本次报错的项）outputs 真回滚到迁移前快照——
 *    writeAtomic 先替换目标再 fsync 父目录，Promise 拒绝不代表文件没改变，因此「可能已发布」一律按已发布处理，
 *    内存等于 before（可能盘上是 after）与等于 after 的项都要回写 before；只有被其它写入改成第三种内容才跳过；
 * 3) 逐项核对**完整参与集合**（含此前已发布到目标、本次未改写的成员）：全部 outputs 均不在目标前缀、
 *    且无本事务阻断残留，才算「全部参与者已完整补偿且落盘」，由调用方解除唯一意图；
 * 4) 任一参与者未收敛（反向搬回失败、outputs 回滚不完整、outputs 仍定位在目标、本事务阻断未清、任务缺失）时，
 *    给**全部参与者**写入**带事务身份的**阻断记录（含源/目标、涉及任务、引用身份与原因），供诊断与后续按
 *    同一事务重试恢复——不允许只留一句“已保持阻断”，也不允许把未收敛当整组完成。
 *    文案真实性（§4.7）：只有全部写盘成功才写「已确认持久保护」；写失败必须写「持久化失败，需恢复核对」，
 *    并说明当前仅本进程已阻断（跨重启保护未确认），不得在 marker 写失败时仍宣称跨重启已保证。
 */
async function compensateRelocationFailure(input: {
  directory: string;
  /** 真实文件当前所在绝对路径（正向迁移的 to）。 */
  movedAbsFrom: string;
  /** 需要恢复的绝对路径（正向迁移的 from）。 */
  movedAbsTo: string;
  expectRefs: string[];
  /** §O.1 事务身份（与本次正向调用同一 ID，补偿方向不重算）。 */
  transactionId: string;
  /** 真实改名结果带出的归属引用（记录身份，§O.1 refs 的一部分）。 */
  recordRefs: string[];
  affected: string[];
  /** §P.1：本次事务完整参与集合（含已发布到目标、本次未改写的成员）；补偿不足时对全部参与者写阻断。 */
  participants: string[];
  rewritten: Map<string, RelocationSnapshot>;
  relativeFrom: string;
  relativeTo: string;
  message: string;
}): Promise<{ reason: string; code?: string; blocked: boolean; warning?: string; converged: boolean; open: { taskId: string; reason: string }[] }> {
  // §P.2：补偿阶段同属活动中（①运行时判定对 C 的显式恢复入口仍然可见）。
  updateRelocationTransactionPhase(input.transactionId, "compensating");
  // §P.1：反向调用同样把参与集合交给 C（C 写进意图的 relocationIntent.participants）。
  // §P.2/R1a：反向补偿不得由 C 自行解除唯一意图——与正向一致传 deferIntentRelease=true，
  // 意图保留到 Q 完成「全部参与者已完整补偿」逐项核对（唯一解除时点）后才清除。
  const reverted = await relocateWorkspacePath({
    directory: input.directory, source: input.movedAbsFrom, target: input.movedAbsTo, expectRefs: input.expectRefs,
    transactionId: input.transactionId, deferIntentRelease: true, participants: input.participants,
  }).catch(() => undefined);
  let fileRolledBack = reverted?.ok === true;
  // 补偿反向搬回自身的如实说明（如 C 失败分支的意图清除说明）：与正向一致，不得吞掉，随结果透出。
  const rollbackWarning = reverted?.ok ? reverted.warning : undefined;
  /**
   * §P.2/缝1(b)：反向调用失败时不能一律按失败码当补偿失败，也不能一律按「已回滚」放行——
   * 注意 C 的 rolledBack 是**该调用方向**的语义：反向调用（B→A）上的 rolledBack=true 表示
   * 文件与账本回到补偿前位置（真实文件在正向目标端 B），**不是**回到正向源端 A，因此不得据此释放；
   * 只对「本次调用未执行任何文件操作」的两种失败（调用异常/抛错、反向源端已不存在的 EMISSING）
   * 核对真实文件位置：文件只在正向源端 ⇒ 等价于已回滚（从未移动或已被回滚），继续做 outputs 补偿
   * 并按收敛判定（全部成功才由调用方释放唯一意图）。其余失败码（含 ERECORDS 的归属迁移/账本回滚
   * 不完整族——C 会自行建立范围保护并要求人工核对）保持保守：不推断已回滚，保留意图与阻断。
   */
  let rollbackPositionNote = "";
  if (!fileRolledBack && (reverted === undefined || (reverted.ok === false && reverted.code === "EMISSING"))) {
    const presence = await relocationEndpointPresence(input.movedAbsTo, input.movedAbsFrom);
    if (presence === "at-source") {
      fileRolledBack = true;
      rollbackPositionNote = "（反向调用返回失败，但已核对真实文件在源端：按已回滚收敛）";
    }
  }
  /** C 已确认反向调用回滚到补偿前位置（文件仍在正向目标端）：补偿未完成，屏障必须保留。 */
  const reverseRollbackConfirmed = reverted?.ok === false && reverted.rolledBack === true;
  /** 反向补偿未确认回滚时的如实说明（失败码与原文；C 侧保护已由 C 按其分支处理）。 */
  const rollbackFailureNote = fileRolledBack
    ? ""
    : reverseRollbackConfirmed
      ? "；反向补偿未完成：C 已确认文件与账本回滚到补偿前位置（真实文件在正向目标端），本事务未收敛"
      : reverted === undefined
        ? "；反向补偿调用异常（未返回可判读结果）"
        : reverted.ok === false
          ? `；反向补偿返回失败（${reverted.code}）：${reverted.message}`
          : "";
  let outputsRolledBack = true;
  /** outputs 回滚未真正生效的参与项（状态可能被其它写入改成第三种内容）：逐项列入未收敛，不得当整组完成。 */
  const rollbackFailed: string[] = [];
  if (fileRolledBack) {
    for (const [taskId, snapshot] of input.rewritten) {
      const restored = await updateMediaTaskWithinLockIfApplied(taskId, current => {
        const outputs = JSON.stringify(current.outputs);
        const matchesBefore = outputs === JSON.stringify(snapshot.before);
        const matchesAfter = outputs === JSON.stringify(snapshot.after);
        // 「可能已发布即按已发布处理」：内存仍是 before 时盘上也可能是 after（先替换后 fsync 失败），
        // 两种都回写 before；只有被其它写入改成第三种内容时跳过，避免覆盖新事实。
        if (!matchesBefore && !matchesAfter) return undefined;
        return target => {
          target.outputs = snapshot.before.map(output => ({ ...output }));
          target.relocationBlocked = snapshot.beforeBlock;
        };
      }).then(result => result.applied, () => false);
      if (!restored) {
        outputsRolledBack = false;
        rollbackFailed.push(taskId);
      }
    }
  }
  // §P.1/§P.2 补偿收敛核对：全部参与者 outputs 均已不在目标前缀、且无本事务阻断残留，才算完整补偿。
  // 反向搬回失败（真实文件位置未还原）或任一项回滚未生效时逐项列入未收敛，不得按 outputs 前缀"看着像"就放行；
  // 此前已发布到目标、本次未改写的参与者（outputs 仍指向目标/本事务阻断未清）也在此如实列出。
  const open: { taskId: string; reason: string }[] = [];
  for (const participant of input.participants) {
    if (!fileRolledBack) {
      open.push({
        taskId: participant,
        reason: reverseRollbackConfirmed
          ? "反向补偿未完成：C 已确认文件与账本在补偿前位置（真实文件在正向目标端），该参与者的文件与 outputs 未收敛"
          : `反向补偿未确认把真实文件恢复到源端（${input.relativeFrom} → ${input.relativeTo} 的文件位置需人工核对），无法确认该参与者的文件与 outputs 一致`,
      });
      continue;
    }
    if (rollbackFailed.includes(participant)) {
      open.push({ taskId: participant, reason: "任务 outputs 回滚未生效（状态可能已被其它写入改变），需人工核对" });
      continue;
    }
    const reason = relocationParticipantOpenReason(participant, {
      transactionId: input.transactionId, source: input.relativeFrom, target: input.relativeTo, direction: "compensate",
    });
    if (reason) open.push({ taskId: participant, reason });
  }
  if (fileRolledBack && outputsRolledBack && !open.length) {
    // 全部参与者已完整补偿且落盘：由调用方在唯一解除时点清除意图（此处不写阻断、不自行清意图）。
    return {
      reason: `任务输出定位更新失败，目录改名与已写任务输出均已回滚：${input.message}${rollbackPositionNote}`, code: "EBUSY", blocked: false,
      converged: true, open: [],
      ...(rollbackWarning ? { warning: rollbackWarning } : {}),
    };
  }
  const block: MediaTaskRelocationBlock = {
    at: new Date().toISOString(),
    // reason 只陈述「本次改名事务未完成、两端保持阻断」；是否跨重启持久由下方写入结果如实补充，不预先宣称。
    reason: fileRolledBack
      ? outputsRolledBack
        ? `任务输出定位更新失败：目录改名与已写任务输出均已回滚，但参与集合未全部收敛（含此前已发布到目标的成员或残留阻断，需按同一事务恢复）：${input.message}`
        : `任务输出定位更新失败，目录改名已回滚但任务输出回滚不完整：${input.message}`
      : reverseRollbackConfirmed
        ? `任务输出定位更新失败，反向补偿未完成（C 已确认文件与账本回滚到补偿前位置，真实文件在正向目标端）：${input.message}`
        : `任务输出定位更新失败，且反向补偿未确认把真实文件恢复到源端（${input.relativeFrom} → ${input.relativeTo} 的文件位置需人工核对）：${input.message}`,
    source: input.relativeFrom,
    target: input.relativeTo,
    // §P.1：阻断记录承载**完整参与集合**（不是只记本次改写项）——恢复时据此包含已发布到目标的成员。
    taskIds: [...input.participants],
    transactionId: input.transactionId,
    directory: input.directory,
    refs: [...new Set([...input.expectRefs, ...input.recordRefs])],
  };
  const blockWriteFailed = await persistRelocationBlock(input.participants, block);
  // 持久阻断写不出的项已保留运行时阻断：本次操作按「已停止并阻断」返回，且如实区分两种持久化事实。
  const durableNote = blockWriteFailed.length
    ? `；持久化失败，需恢复核对：任务 ${blockWriteFailed.join("、")} 的阻断未落盘（跨重启保护未确认），当前仅本进程已阻断（运行时阻断仍被后续改名判据实际消费；重启后请先人工核对真实文件与任务 outputs）`
    : "；已确认持久保护（跨重启保持：改名、输出改写与清理都按该事务事实保守阻断；恢复方式为精确重试同一条 source→target 或人工核对）";
  const rollbackNote = rollbackWarning
    ? `；补偿反向改名已完成但迁移意图保护未能清除（保护仍在，需清理核对）：${rollbackWarning}`
    : "";
  const openNote = open.length
    ? `；参与集合未全部收敛（未解除唯一意图，恢复方式为精确重试同一条 source→target 或人工核对）：${open.map(item => `${item.taskId}（${item.reason}）`).join("；")}`
    : "";
  return {
    reason: `${block.reason}${rollbackFailureNote}${rollbackPositionNote}${openNote}${rollbackNote}${durableNote}`, code: "EPARTIAL", blocked: true,
    converged: false, open,
    ...(rollbackWarning ? { warning: rollbackWarning } : {}),
  };
}

/**
 * §P.1 本事务完整参与集合：当前核对发现的参与者 ∪ 持久事实（Q 的阻断记录 ∪ C 的意图摘要 participants）。
 * 恢复集合不得只按「当前 outputs 的源前缀」筛选——已发布到目标、仅剩 block 的成员必须包含在内。
 */
async function relocationParticipantSet(directory: string, transactionId: string, from: string, to: string, discovered: readonly string[]) {
  const participants = new Set<string>(discovered);
  // C 的持久意图 participants（§P.1，Q 上次调用时传入、C 持久化）：读取失败按空集合处理（Q 自身的
  // 持久阻断记录仍然提供参与事实，不因读取失败而漏掉已发布到目标的成员）。
  const intentParticipants: string[] = [];
  for (const intent of await listFileRelocationIntents().catch(() => [])) {
    if (intent.transactionId !== transactionId) continue;
    intentParticipants.push(...relocationIntentParticipantIds(intent));
  }
  for (const id of relocationTransactionParticipants({ directory, transactionId, source: from, target: to, intentParticipants })) {
    participants.add(id);
  }
  return [...participants].sort();
}

/** 收敛状态里未收敛项的可读说明（逐项含 taskId 与原因）。 */
function describeOpenParticipants(open: readonly { taskId: string; reason: string }[]) {
  return open.map(item => `${item.taskId}（${item.reason}）`).join("；");
}

/**
 * §P.1/§P.2（R3）：对「outputs 已在目标、仅剩本事务阻断」的成员做锁内核对与解除——
 * 调用方已持有目录内全部任务锁，核对通过后在此处（与 outputs 发布同临界区）条件落盘清除其 block。
 * 核不过（任务缺失 / outputs 仍在源前缀 / 阻断属于其他事务 / 落盘失败）一律返回未收敛原因，不吞掉；
 * 其他事务的阻断不属于本事务收敛事实，但也不越权清除，交由改名入口的阻断消费处理。
 */
async function settleRelocationParticipantAtTarget(input: {
  taskId: string;
  transactionId: string;
  movedFrom: string;
  movedTo: string;
}): Promise<{ settled: true } | { settled: false; reason: string }> {
  const task = getMediaTask(input.taskId);
  if (!task) return { settled: false, reason: "任务记录不存在（已删除或未加载），无法核对 outputs 与本事务阻断" };
  const stale = task.outputs
    .map(output => currentOutputPath(output))
    .filter(current => outputPathUnderPrefix(current, input.movedFrom));
  if (stale.length) return { settled: false, reason: `任务 outputs 仍定位在源路径（未发布到目标）：${stale.join("、")}` };
  const identity = { transactionId: input.transactionId, source: input.movedFrom, target: input.movedTo };
  const effective = effectiveRelocationBlock(task);
  if (effective && !relocationBlockMatchesTransaction(effective, identity)) {
    return {
      settled: false,
      reason: `任务存在其他未完成改名事务阻断（${normalizeRelativePrefix(effective.source)} → ${normalizeRelativePrefix(effective.target)}），本事务不得宣告收敛`,
    };
  }
  // 无有效阻断（已收敛）与只运行时阻断（无持久字段可清）：清内存阻断即收敛。
  if (!effective || !task.relocationBlocked) {
    clearRuntimeRelocationBlock(input.taskId);
    return { settled: true };
  }
  try {
    const cleared = await updateMediaTaskWithinLockIfApplied(input.taskId, current => {
      const currentBlock = effectiveRelocationBlock(current);
      if (currentBlock && !relocationBlockMatchesTransaction(currentBlock, identity)) return undefined;
      if (!current.relocationBlocked) return undefined;
      const stillStale = current.outputs.some(output => outputPathUnderPrefix(currentOutputPath(output), input.movedFrom));
      if (stillStale) return undefined;
      return target => {
        // 锁内核对通过：本事务阻断解除（与 outputs 发布同一类条件落盘写入）。
        target.relocationBlocked = undefined;
      };
    });
    if (!cleared.applied) {
      // 条件不成立时可能是阻断已被并发清掉（已收敛）或状态变化：按最新事实重新核对后再报。
      const remaining = relocationParticipantOpenReason(input.taskId, { ...identity, direction: "commit" });
      return remaining ? { settled: false, reason: remaining } : { settled: true };
    }
    clearRuntimeRelocationBlock(input.taskId);
    return { settled: true };
  } catch (error) {
    return { settled: false, reason: `本事务改名阻断解除写入失败（${translateError(error) || "保护写入失败"}），需恢复核对` };
  }
}

/**
 * 真实文件位置核对（缝1/缝2，只读）：源端/目标端各自是否存在（文件或目录）。
 * ENOENT=不存在；其他错误=不可判读——按 unknown 处理，绝不能当收敛；两端都存在/都不存在同样不算收敛依据。
 */
async function relocationEndpointPresence(sourceAbs: string, targetAbs: string): Promise<"at-source" | "at-target" | "both" | "neither" | "unknown"> {
  const present = (path: string) => lstat(path).then(() => true as const, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false as const : undefined);
  const [sourcePresent, targetPresent] = await Promise.all([present(sourceAbs), present(targetAbs)]);
  if (sourcePresent === undefined || targetPresent === undefined) return "unknown";
  if (sourcePresent && !targetPresent) return "at-source";
  if (!sourcePresent && targetPresent) return "at-target";
  return sourcePresent && targetPresent ? "both" : "neither";
}

/**
 * 只能在任何文件操作之前返回的失败码（C 的 rename 之前的拒绝）：这些失败码下真实文件必然仍在源端，
 * 不需要（也不应该）按存在性推断；其余失败码/抛错必须核对真实文件位置才敢判定「已回源端」。
 */
const preMoveRelocationFailureCodes = new Set(["EINVALID", "ENOTFOUND", "EIDENTITY", "EOCCUPIED", "EBUSY", "EEXIST"]);

/**
 * §P.2/缝1(a)：正向调用失败（C 未提交；rename 抛错、归属迁移失败已回滚、意图写入失败等）后的收尾。
 * **不发布任何 outputs**；只有「真实文件确在源端 + 全部参与者 outputs 未指向目标 + 无本事务阻断」的
 * 平凡收敛（本次事务没有产生任何需要恢复的改动）才允许解除 C 保留的唯一意图；
 * 其余状态（文件在目标端/两端不明/不可判读、outputs 或阻断未收敛）一律保留意图、对全部参与者
 * 写持久阻断并给出可读未收敛原因（对应 R1a 自然链：屏障不因失败链丢失）。
 */
async function settleFailedForwardRelocation(input: {
  transactionId: string;
  participants: string[];
  /** 工作区相对源/目标（阻断记录与核对口径）。 */
  from: string;
  to: string;
  /** 绝对源/目标（真实文件位置核对）。 */
  sourceAbs: string;
  targetAbs: string;
  message: string;
  code?: string;
  /** C 的失败结果确认「文件与账本已回滚到源端」（rolledBack=true，仅正向语义）——无需再按存在性推断。 */
  rolledBack?: boolean;
  /** 调用在 C 的 rename 之前失败/抛错（本次调用未执行任何文件操作）：与 C 的 pre-move 失败码同判。 */
  preMove?: boolean;
}): Promise<{ converged: boolean; blocked: boolean; reason: string; open: { taskId: string; reason: string }[] }> {
  const presence = input.rolledBack === true ? "at-source" : await relocationEndpointPresence(input.sourceAbs, input.targetAbs);
  // 「已回源端」判据：C 已显式确认回滚到源端；或文件只在源端；rename 之前的失败（含调用抛错）允许
  // 「两端都在」（目标端是既有同名内容，本次未移动过文件）。
  const preMoveFailure = input.preMove === true || (!!input.code && preMoveRelocationFailureCodes.has(input.code));
  const fileAtSource = input.rolledBack === true
    || presence === "at-source"
    || (preMoveFailure && presence === "both");
  const open: { taskId: string; reason: string }[] = [];
  for (const participant of input.participants) {
    const reason = relocationParticipantOpenReason(participant, {
      transactionId: input.transactionId, source: input.from, target: input.to, direction: "compensate",
    });
    if (reason) open.push({ taskId: participant, reason });
  }
  if (fileAtSource && !open.length) {
    return {
      converged: true, blocked: false, open: [],
      reason: `${input.message}；已核对真实文件不在目标端（${input.rolledBack === true
        ? "C 已确认文件与账本回滚到源端"
        : presence === "at-source" ? "源端存在、目标端不存在" : "本次未移动文件；目标端的既有同名内容不属于本事务"}），本次未产生任何 outputs 发布，参与集合未发现未收敛项——唯一意图不保留`,
    };
  }
  if (!fileAtSource) {
    const presenceNote = presence === "at-target"
      ? "真实文件在目标端（源端已不存在）"
      : presence === "both"
        ? "源与目标两端同时存在"
        : presence === "neither"
          ? "源与目标均不存在"
          : "源/目标存在性无法判读";
    for (const participant of input.participants) {
      if (open.some(item => item.taskId === participant)) continue;
      open.push({ taskId: participant, reason: `正向改名未完成且${presenceNote}，无法确认该参与者的文件与 outputs 一致，需人工核对` });
    }
  }
  const block: MediaTaskRelocationBlock = {
    at: new Date().toISOString(),
    reason: fileAtSource
      ? `正向改名未完成，真实文件已核对在源端，但参与集合仍有未收敛项（${input.from} → ${input.to}）：${input.message}`
      : `正向改名未完成，真实文件位置与参与集合需核对（${input.from} → ${input.to}）：${input.message}`,
    source: input.from,
    target: input.to,
    taskIds: [...input.participants],
    transactionId: input.transactionId,
    refs: input.participants.map(id => `task:${id}`),
  };
  const blockWriteFailed = await persistRelocationBlock(input.participants, block);
  const durableNote = blockWriteFailed.length
    ? `；持久化失败，需恢复核对：任务 ${blockWriteFailed.join("、")} 的阻断未落盘（跨重启保护未确认），当前仅本进程已阻断`
    : "；已确认持久保护（跨重启保持）";
  const openNote = open.length ? `；参与集合未全部收敛：${describeOpenParticipants(open)}` : "";
  return {
    converged: false, blocked: true, open,
    reason: `${block.reason}${openNote}${durableNote}；唯一意图保留，恢复方式为精确重试同一条 ${input.from} → ${input.to}（同一事务身份）或人工核对`,
  };
}

/**
 * 改名事务的目录级协调锁键（T15/§N.2）：影响任务发现与 outputs 发布必须在同一任务锁临界区内完成。
 * 同一工作区的改名事务经此串行化，消除「第二次改名按第一次发布前的旧 outputs 发现 affected=[]」的窗口。
 * 锁序（唯一，不得反序）：目录协调锁 → 目录内任务锁（taskId 字典序）→ C 的源/目标路径锁（C 在
 * relocateWorkspacePath 内取）；Q 的补偿/阻断写入都在同一临界区内，用已持有的任务锁。
 */
function mediaTaskRelocateLockKey(directory: string) {
  return `relocate:${directory}`;
}

/** 持有一个工作区内全部任务锁（taskId 字典序）后执行：发现与发布都不会被任务更新/另一改名交错。 */
async function withDirectoryTaskLocks<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const taskIds = listMediaTasks()
    .filter(candidate => sameDirectory(candidate.directory, directory))
    .map(candidate => candidate.taskId)
    .sort();
  return withMediaTaskLocks(taskIds, operation);
}

/**
 * 终态任务输出的目录/文件改名协调外层（契约 v4 §K/T15，§N.2/§P 扩展）：
 * 锁序固定为「目录协调锁 → 目录内全部任务锁（taskId 字典序）→ C 的 relocateWorkspacePath 的源/目标路径锁」，
 * **影响任务发现与 outputs 发布在同一任务锁临界区内**：连续 A→B、B→C 的第二段改名不会再按发布前的旧 outputs
 * 得到 affected=[]，发布未完成前不释放任务锁。
 * 真实文件操作、归属迁移与引用/占用重查都在 C 的路径锁内完成；
 * 影响范围与改写都只按**当前实际定位**（resolvedPath 优先）判定，历史 path 仅作历史：
 * 旧任务 a→b 保存 path=a、resolvedPath=b 后，复用 a 的新文件再 a→c 不会再改动旧任务；
 * 迁移成功后在同一事务内持久更新受影响 task.outputs[].resolvedPath（真实输出路径作为持久事实），
 * path 按 §G 保留为历史原路径，摘要同时透出 resolvedPath 与 path。
 * 已有针对相关路径的未完成改名阻断（task.relocationBlocked 或持久写失败后的运行时阻断）时，本函数
 * **拒绝**本次改名并给出可读原因（含事务身份与来源；精确重试同一 source→target 是人工恢复路径，允许继续）。
 * 调用 C 时按受影响任务身份传 expectRefs（task:<taskId>）：已完成后重试/顺序多任务协调只认同一身份，
 * 不把复用旧路径的新文件串到旧任务。C 拒绝迁移（活跃任务引用/编辑占用/未完成登记）时按其 code 原样返回且不改任务定位。
 * §O.1/§O.3：本次调用同时传确定性 transactionId（复用 C 的 relocationTransactionId，单一来源）——C 据此把
 * 移动前意图与本次调用认成同一事务：§3.2 的「源已反搬回 A、持久 block=A→B」精确重试由此可被放行，其他重叠事务仍拒绝。
 * **§P.1 完整参与集合（R3）**：参与集合 = 当前核对发现的 outputs 参与者 ∪ 持久事实（Q 的阻断记录
 * taskIds/refs ∪ C 意图摘要 participants）；调用 C 时随事务身份传 `participants`（含已发布到目标、
 * 仅剩 block 的成员，C 写入 relocationIntent.participants）。恢复不再只按「当前 outputs 的源前缀」筛选。
 * 对「outputs 已在目标、仅剩本事务阻断」的成员：在同一任务锁临界区内逐项核对并清除其 block。
 * **§P.2 唯一解除时点（R1a）**：正反两个方向都传 deferIntentRelease=true，C 均不自行解除意图；
 * 仅当「全部参与者 outputs 已提交且落盘」或「全部参与者已完整补偿且落盘」并逐项核对通过后，才由 Q 调用
 * clearFileRelocationIntent（清除失败按 warning 透传）；任一参与者未收敛即保留意图、不返回成功，
 * 并在结果里给出可读收敛状态（convergence：participants/open 含未收敛 taskId 与原因）。
 * **§P.2 活动边界**：从调用 C 起（含发布、结算与补偿）到本事务收尾，本进程内视为活动中——
 * store 的 isRelocationTransactionActive（同步、无锁）供 C 的显式恢复入口判忙。
 * C 结果里的 warning（如「改名事务已完成但迁移意图清除失败，保护仍在需清理核对」）原样透传到
 * MediaTaskRelocateResult.warning（成功、补偿与失败路径都不吞掉），供路由响应与前端展示（§O.2）。
 * 多任务写回部分失败时执行真实补偿（回滚全部**尝试写入**的 outputs，含本次报错项；并核对完整参与集合），
 * 补偿不足则持久阻断（blocked=true）；持久阻断写不出时保留运行时阻断并如实说明。
 */
export async function relocateMediaTaskOutput(input: MediaTaskRelocateInput): Promise<MediaTaskRelocateResult> {
  await ensureMediaTasksStore();
  const taskId = typeof input.taskId === "string" && input.taskId.trim() ? input.taskId.trim() : undefined;
  const explicitDirectory = typeof input.directory === "string" && input.directory.trim() ? input.directory : undefined;
  const task = taskId ? getMediaTask(taskId) : undefined;
  if (taskId && !task) return { ok: false, code: "ENOTFOUND", reason: "任务不存在" };
  const directory = task?.directory ?? (explicitDirectory ? await realpath(explicitDirectory).catch(() => undefined) : undefined);
  if (!directory) return { ok: false, code: "EINVALID", reason: "需要提供有效的 taskId 或工作目录" };
  if (task && !sameDirectory(task.directory, directory)) return { ok: false, code: "EINVALID", reason: "任务不属于该工作区" };
  if (typeof input.source !== "string" || !input.source.trim() || typeof input.target !== "string" || !input.target.trim()) {
    return { ok: false, code: "EINVALID", reason: "需要提供源与目标路径" };
  }
  const from = relativeInDirectory(directory, input.source);
  if (!from) return { ok: false, code: "EINVALID", reason: "源路径无效" };
  const to = relativeInDirectory(directory, input.target);
  if (!to) return { ok: false, code: "EINVALID", reason: "目标路径无效" };
  // §O.1/互审2：事务身份的契约输入是**绝对路径**——先按工作区根显式 resolve（相对路径表单也落到同一
  // 绝对路径；不 realpath、不改大小写），再计算 ID，并把同一组绝对路径传给 C，防止未来相对/绝对混合
  // 表单导致同一事务被算成两个 ID。
  const sourceAbsolute = resolve(directory, input.source);
  const targetAbsolute = resolve(directory, input.target);
  const transactionId = relocationTransactionId(directory, sourceAbsolute, targetAbsolute);
  return withMediaTaskLock(mediaTaskRelocateLockKey(directory), () => withDirectoryTaskLocks(directory, async () => {
    // 1) 阻断消费（T15）：与本次改名路径相关的未完成改名阻断必须先被处理（人工核对或重试同一条事务），
    //    否则拒绝本次操作——不允许在「真实文件位置与任务 outputs 未核对」的状态上继续搬文件/改定位。
    const blocked = blockedRelocationTasks(directory, from, to);
    if (blocked.length) {
      const blockedIds = [...new Set(blocked.map(entry => entry.task.taskId))].sort();
      const first = blocked[0]!;
      return {
        ok: false, code: "EPARTIAL", blocked: true,
        reason: `工作区内存在未完成的改名事务阻断（涉及任务 ${blockedIds.join("、")}；未完成事务 ${first.block.transactionId ?? "（旧格式，无事务身份）"}：${first.block.source} → ${first.block.target}，来源：${first.origin === "persisted" ? "持久阻断" : "本进程运行时阻断"}），本次改名已停止：请先按任务 relocationBlocked 记录人工核对真实文件与 outputs，再操作；精确重试同一条 source→target 是允许的恢复路径`,
      };
    }
    // 2) 参与集合（§P.1，R3）：当前核对发现（outputs 在当前源前缀下）∪ 持久事实（Q 的未完成阻断记录
    //    taskIds/refs ∪ C 的意图摘要 participants）。不得只按「当前 outputs 的源前缀」筛选——已发布到
    //    目标、仅剩 block 的成员必须进入同一事务的恢复集合，否则精确重试只会选中一半参与者（漏 T1）。
    //    与 outputs 发布在同一临界区（已持目录内全部任务锁，且无其它改名事务并发交错）。
    const candidates = taskId
      ? [getMediaTask(taskId)].filter((candidate): candidate is MediaTaskRecord => !!candidate)
      : listMediaTasks().filter(candidate => sameDirectory(candidate.directory, directory));
    const affected = candidates
      .filter(candidate => candidate.outputs.some(output => outputPathUnderPrefix(currentOutputPath(output), from)))
      .map(candidate => candidate.taskId)
      .sort();
    const participants = await relocationParticipantSet(directory, transactionId, from, to, affected);
    // 既无当前 outputs 参与者、也无任何持久事务事实：保持原「零参与即成功」语义（不取 C 的路径锁）。
    if (!participants.length) return { ok: true, updated: 0, tasks: [] };
    // 身份约束：只认该事务参与任务在归属/定位日志里的引用（重试或顺序多任务协调按同一次改名确认；
    // 含已发布到目标的成员——精确恢复的源路径身份、自身占用放行与移动结果归属核对都以完整参与集合为准）。
    const expectRefs = participants.map(id => `task:${id}`);
    let failure: { reason: string; code?: string; blocked?: boolean; warning?: string; converged?: boolean; open?: { taskId: string; reason: string }[] } | undefined;
    /** C 协调结果的如实说明（如意图清除失败「保护仍在，需清理核对」）：任何成功/失败返回都不吞掉（§O.2）。 */
    let warning: string | undefined;
    let updated = 0;
    const tasks: { taskId: string; updated: number }[] = [];
    /** 已**尝试写入**的任务（含本次报错项）→ 迁移前快照与本次写入内容（部分失败时按此补偿回写）。 */
    const rewritten = new Map<string, RelocationSnapshot>();
    /** §P.1/§P.2：本事务参与集合与逐项收敛状态（任何涉及事务的返回都如实带出，含未收敛 taskId 与原因）。 */
    let convergence: MediaTaskRelocationConvergence | undefined;
    /**
     * §P.2 唯一解除时点：只有「全部参与者 outputs 已提交且落盘」或「全部参与者已完整补偿且落盘」
     * 且参与集合逐项核对通过后才解除 C 延迟保留的唯一意图；清除失败不得吞掉，按 warning 全路径透传
     * （「保护仍在，需清理核对」）。
     */
    const releaseDeferredIntent = async () => {
      const clearFailure = await clearFileRelocationIntent(transactionId).then(
        (outcome: FileRelocationIntentClearOutcome) => {
          // §P.4/§O.3 清除结果三态：confirmed=清除已落盘确认；unconfirmed=清除可能已发布但落盘未确认——
          // 不得宣称「保护仍在」，也不得当作「已确认清除」，按未确认示警并给出核对路径。
          if (outcome.persistence === "unconfirmed") {
            return `改名事务已完成，但迁移意图清除结果未确认（清除可能已发布、也可能仍在，需经 POST /api/cleanup/protections 核对保护表与磁盘）${outcome.note ? `：${outcome.note}` : ""}`;
          }
          return undefined;
        },
        (error: unknown) => `改名事务已完成，但迁移意图保护清除失败（保护仍在，需清理核对；可经 POST /api/cleanup/protections 显式核对后清理）：${translateError(error) || "保护表写入失败"}`,
      );
      if (clearFailure) warning = warning ? `${warning}；${clearFailure}` : clearFailure;
    };
    // §P.2 活动边界（①运行时）：从调用 C 起（含 outputs 发布、已到目标成员结算与补偿）到本事务收尾，
    // 本进程内视为活动中；isRelocationTransactionActive 纯内存同步、不等待任何锁，供 C 的显式恢复入口判忙。
    beginRelocationTransactionActivity(transactionId, "forward", participants);
    try {
      // §O.1/§O.3/§P.1：把事务身份与完整参与集合交给 C——C 在真实 rename 前持久化同 ID 意图（含 participants），
      // 并据此识别「本次即该事务的续做」（§3.2 精确恢复不再被该事务自身的意图/占用判成 EOCCUPIED；
      // 其他事务与占用仍一律拒绝）。
      // §P.2：协调路径正向也传 deferIntentRelease=true——C 提交完成后**保留**持久意图，待 Q 完成 outputs
      // 发布与参与集合逐项核对后，在唯一解除时点清除（见 releaseDeferredIntent），堵住「C 已清意图 →
      // Q publish 失败 → 补偿反向意图写入失败 → 持久 block 也写失败」三重连续写失败下磁盘无任何重启屏障的缺口。
      let result: RelocateWorkspaceResult;
      try {
        result = await relocateWorkspacePath({
          directory, source: sourceAbsolute, target: targetAbsolute, expectRefs, transactionId, deferIntentRelease: true,
          participants,
        });
      } catch (error) {
        // §P.2/缝1(a)：C 的 rename 失败分支对非 EEXIST 错误直接抛出——必须转成可读失败并走同一收尾，
        // 不让异常越过本层（否则 C 保留的意图没有任何收敛判定）。
        result = { ok: false, code: "ERECORDS", message: `改名调用失败：${translateError(error) || "未知错误"}` };
      }
      if (!result.ok) {
        // §P.2/缝1(a)：正向未提交——不发布任何 outputs。只有真实文件确在源端、且全部参与者
        // outputs 未指向目标、无本事务阻断的平凡收敛才（幂等）解除 C 保留的唯一意图；否则保留意图 +
        // 对全部参与者写持久阻断，并如实报告未收敛（R1a 自然链的屏障不因失败链丢失）。
        const settled = await settleFailedForwardRelocation({
          transactionId, participants,
          from, to, sourceAbs: sourceAbsolute, targetAbs: targetAbsolute,
          message: result.message, code: result.code,
          // C 的 rolledBack=true（正向语义）表示文件与账本已确认回滚到源端，无需再按存在性推断。
          rolledBack: result.rolledBack === true,
        });
        failure = { reason: settled.reason, code: result.code, blocked: settled.blocked, open: settled.open };
        if (settled.converged) {
          await releaseDeferredIntent();
          convergence = { transactionId, phase: "compensated", participants, open: settled.open };
        } else {
          convergence = { transactionId, phase: "unsettled", participants, open: settled.open };
        }
      } else {
        warning = result.warning;
        const movedFrom = normalizeRelativePrefix(relative(directory, result.from));
        const movedTo = normalizeRelativePrefix(relative(directory, result.to));
        // §P.1/缝2：C 的归属路径映射优先（alreadyRelocated/精确续做返回的 paths 可能为空/部分）；
        // 为空时按 source→target 前缀映射（既有目录改名语义）。
        const pathPairs = relocationRelativePathPairs(directory, result.paths);
        // 可靠归属（T15）：迁移结果带出归属引用时，必须与本事务参与身份相交，否则说明该路径上的文件
        // 属于别的任务（旧任务路径被复用），不得把这些新文件认成本批任务的输出，也不改写任何任务定位。
        const movedRefs = (Array.isArray(result.refs) ? result.refs : []).filter((ref): ref is string => typeof ref === "string");
        if (movedRefs.length > 0 && !movedRefs.some(ref => expectRefs.includes(ref))) {
          // 文件已实际迁移（C 成功）但不属于本事务参与者：没有需要发布的 outputs。
          // §P.2：仍必须逐项核对参与集合——全部已到目标且本事务阻断已清才解除唯一意图；否则保留并如实报告，
          // 不能以「文件不是我们的」为由留下带 block 的参与成员却宣告完成。
          const open: { taskId: string; reason: string }[] = [];
          for (const participant of participants) {
            const reason = relocationParticipantOpenReason(participant, {
              transactionId, source: movedFrom, target: movedTo, direction: "commit",
            });
            if (reason) open.push({ taskId: participant, reason });
          }
          convergence = { transactionId, phase: open.length ? "unsettled" : "committed", participants, open };
          if (open.length) {
            failure = {
              reason: `目录改名已完成，但本事务参与集合未全部收敛（本次移动的归属引用不属于该参与集合）：${describeOpenParticipants(open)}；唯一意图保留，恢复方式为精确重试同一条 ${from} → ${to}（同一事务身份）或人工核对`,
              code: "EPARTIAL", blocked: true, open,
            };
          } else {
            await releaseDeferredIntent();
            return { ok: true, updated: 0, tasks: [], ...(warning ? { warning } : {}), convergence };
          }
        } else {
          for (const currentId of affected) {
            let touched = 0;
            let snapshot: RelocationSnapshot | undefined;
            try {
              const applied = await updateMediaTaskWithinLockIfApplied(currentId, current => {
                const rewrittenOutputs = current.outputs.map(output => rewriteOutputUnderRelocation(output, movedFrom, movedTo, pathPairs));
                const matched = rewrittenOutputs.filter(Boolean).length;
                if (!matched) return undefined;
                const after = current.outputs.map((output, index) => rewrittenOutputs[index] ?? output);
                touched = matched;
                // 迁移前的有效阻断（持久字段优先、运行时兜底）：补偿回滚时按原值恢复，不把已有阻断抹掉。
                const previousBlock = effectiveRelocationBlock(current);
                snapshot = {
                  before: current.outputs.map(output => ({ ...output })),
                  after: after.map(output => ({ ...output })),
                  ...(previousBlock ? { beforeBlock: { ...previousBlock, taskIds: [...previousBlock.taskIds] } } : {}),
                };
                return target => {
                  target.outputs = after;
                  // 成功迁移即解除此前的持久阻断（可恢复：重试成功后不再阻断）。
                  target.relocationBlocked = undefined;
                };
              });
              if (!applied.applied) continue;
              // 落盘成功后才撤销运行时阻断（写失败/回滚时仍保留）。
              clearRuntimeRelocationBlock(currentId);
              tasks.push({ taskId: currentId, updated: touched });
              updated += touched;
              if (snapshot) rewritten.set(currentId, snapshot);
            } catch (error) {
              // 任务定位写失败：真实文件已移动，执行真实补偿（反向搬回 + 已写 outputs 回滚）；
              // 本次报错项也可能已经发布（writeAtomic 先替换目标再 fsync 父目录），必须一并纳入补偿。
              if (snapshot) rewritten.set(currentId, snapshot);
              const message = translateError(error) || "任务输出定位更新失败";
              failure = await compensateRelocationFailure({
                directory,
                movedAbsFrom: result.to,
                movedAbsTo: result.from,
                expectRefs,
                // 补偿方向仍是同一事务（不重算 ID）：C 据此允许撤销自家意图、拒绝其他事务的路径；
                // 反向调用同样 deferIntentRelease=true（见补偿函数内），两个方向都不由 C 自行解除唯一意图。
                transactionId,
                recordRefs: movedRefs,
                affected,
                // §P.1：补偿与阻断记录覆盖完整参与集合（含此前已发布到目标的成员）。
                participants,
                rewritten,
                relativeFrom: movedFrom,
                relativeTo: movedTo,
                message,
              });
              break;
            }
          }
          if (failure) {
            // 补偿已在 compensateRelocationFailure 内完成并逐项核对完整参与集合：
            // 仅当「全部参与者已完整补偿且落盘」才在这里解除唯一意图（§P.2）；否则保留意图并如实返回未收敛。
            if (failure.converged) {
              convergence = { transactionId, phase: "compensated", participants, open: [] };
              await releaseDeferredIntent();
            } else {
              convergence = { transactionId, phase: "unsettled", participants, open: failure.open ?? [] };
            }
          } else {
            // 3) 已到目标、仅剩本事务阻断的成员（R3）：锁内核对后清除其 block——与 outputs 发布同临界区，不能漏清。
            const open: { taskId: string; reason: string }[] = [];
            for (const participant of participants) {
              if (affected.includes(participant)) continue;
              const settled = await settleRelocationParticipantAtTarget({ taskId: participant, transactionId, movedFrom, movedTo });
              if (!settled.settled) open.push({ taskId: participant, reason: settled.reason });
            }
            // 4) 参与集合逐项核对（含本次发布项）：全部 outputs 已离开源前缀、本事务阻断已清，才算收敛。
            const openAll: { taskId: string; reason: string }[] = [...open];
            for (const participant of participants) {
              if (open.some(item => item.taskId === participant)) continue;
              const reason = relocationParticipantOpenReason(participant, {
                transactionId, source: movedFrom, target: movedTo, direction: "commit",
              });
              if (reason) openAll.push({ taskId: participant, reason });
            }
            convergence = { transactionId, phase: openAll.length ? "unsettled" : "committed", participants, open: openAll };
            if (openAll.length) {
              // 任一参与者未收敛 ⇒ 不解除整个意图、不返回成功（§P.2）。
              failure = {
                reason: `目录改名与已发布 outputs 已完成，但本事务参与集合未全部收敛：${describeOpenParticipants(openAll)}；唯一意图保留，恢复方式为精确重试同一条 ${from} → ${to}（同一事务身份）或人工核对`,
                code: "EPARTIAL", blocked: true, open: openAll,
              };
            } else {
              // §P.2 唯一解除时点：全部参与者 outputs 已提交且落盘，逐项核对通过 → 解除唯一意图。
              await releaseDeferredIntent();
            }
          }
        }
      }
    } finally {
      // §P.2：本事务在本进程的活动事实随收尾（成功/失败/补偿/异常）一并结束。
      endRelocationTransactionActivity(transactionId);
    }
    if (failure) {
      // 正向迁移与补偿反搬各自的如实说明都不吞掉（去重后合并；同一事务两侧的「保护仍在，需清理核对」）。
      const mergedWarning = [warning, failure.warning]
        .filter((value): value is string => typeof value === "string" && !!value)
        .filter((value, index, list) => list.indexOf(value) === index)
        .join("；") || undefined;
      return {
        ok: false, code: failure.code, reason: failure.reason,
        ...(updated ? { updated } : {}), ...(tasks.length ? { tasks } : {}), ...(failure.blocked ? { blocked: true } : {}),
        ...(mergedWarning ? { warning: mergedWarning } : {}), ...(convergence ? { convergence } : {}),
      };
    }
    return { ok: true, updated, tasks, ...(warning ? { warning } : {}), ...(convergence ? { convergence } : {}) };
  }));
}

/** 批处理别名：与 relocateMediaTaskOutput({ directory, source, target }) 等价，便于正式路由/agent 工具直接调用。 */
export function relocateMediaTaskOutputs(input: { directory: string; source: string; target: string }): Promise<MediaTaskRelocateResult> {
  return relocateMediaTaskOutput(input);
}
