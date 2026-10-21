import { z } from "zod";

export type { MediaModel, MediaReference, MediaGenerationRequest, GeneratedMedia, MediaContext } from "@toonflow/tools-scaffold/runtime";

const relativePath = z.string().min(1).max(2048).refine(
  path => !/^[\\/]|[:\u0000-\u001f]/.test(path) && path.split(/[\\/]/).every(part => part && part !== "." && part !== ".."),
  "路径必须是工作区内的相对路径，不能包含空路径段或 ..",
);
const imageReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/i) });
const videoReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^video\/[a-z0-9.+-]+$/i) });
const audioReference = z.strictObject({ path: relativePath, mimeType: z.string().regex(/^audio\/[a-z0-9.+-]+$/i) });
const sharedFields = {
  providerId: z.string().regex(/^[a-z][a-zA-Z0-9]{0,95}$/),
  modelId: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(1).max(100000),
  outputDirectory: relativePath.optional(),
  images: z.array(imageReference).max(64).optional(),
  ratio: z.string().regex(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/).optional(),
};
const referenceMode = z.templateLiteral([z.enum(["image", "video", "audio"]), "Reference:", z.number()])
  .refine(value => /Reference:(?:[1-9]\d?|1\d{2}|2[0-4]\d|25[0-6])$/.test(value), "参考数量必须在 1 到 256 之间");

export const listMediaModelsSchema = z.strictObject({});
export const imageGenerationSchema = z.strictObject({
  ...sharedFields,
  size: z.string().trim().min(1).max(64).optional(),
});
export const videoGenerationSchema = z.strictObject({
  ...sharedFields,
  videos: z.array(videoReference).max(64).optional(),
  audios: z.array(audioReference).max(64).optional(),
  firstFrame: imageReference.optional(),
  lastFrame: imageReference.optional(),
  resolution: z.string().trim().min(1).max(64).optional(),
  duration: z.number().finite().positive().max(3600).optional(),
  generateAudio: z.boolean().optional(),
  mode: z.union([
    z.enum(["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", "text"]),
    z.array(referenceMode).min(1).max(3),
  ]).optional(),
});
export const audioGenerationSchema = z.strictObject({
  providerId: sharedFields.providerId,
  modelId: sharedFields.modelId,
  prompt: sharedFields.prompt,
  outputDirectory: sharedFields.outputDirectory,
  images: sharedFields.images,
  audios: z.array(audioReference).max(64).optional(),
  voice: z.string().trim().min(1).max(256).optional(),
  speed: z.number().finite().positive().optional(),
  volume: z.number().finite().optional(),
  pitch: z.number().finite().optional(),
  language: z.string().trim().min(1).max(64).optional(),
  format: z.string().trim().min(1).max(64).optional(),
  sampleRate: z.number().int().positive().optional(),
});

// ACT: 持久媒体任务工具共享 HTTP 任务接口的字段；directory 省略时使用当前工作区。
const mediaTaskItemSchema = z.strictObject({
  itemKey: z.string().trim().min(1).max(128),
  request: z.json(),
  canvasId: z.string().trim().min(1).max(256).optional(),
  nodeId: z.string().trim().min(1).max(256).optional(),
});

export const submitMediaTasksSchema = z.strictObject({
  directory: z.string().min(1).max(4096).optional(),
  /** 客户端首次发送前生成并持久保存；重传同键同参数复用同一 taskId。 */
  batchKey: z.string().trim().min(16).max(128),
  mediaType: z.enum(["image", "video", "audio"]),
  /** 单次传输 ≤ 50；排队任务数不设业务上限。 */
  items: z.array(mediaTaskItemSchema).min(1).max(50),
});

export const getMediaTasksSchema = z.strictObject({
  directory: z.string().min(1).max(4096).optional(),
  taskIds: z.array(z.string().min(1).max(256)).min(1).max(200).optional(),
  batchId: z.string().min(1).max(256).optional(),
  /** 客户端稳定批次键；返回同一 (工作区, batchKey) 下的全部任务（跨多次提交）。 */
  batchKey: z.string().trim().min(16).max(128).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).refine(value => !!value.taskIds?.length || !!value.batchId || !!value.batchKey, "需要提供 taskIds、batchId 或 batchKey");

export const cancelMediaTasksSchema = z.strictObject({
  directory: z.string().min(1).max(4096).optional(),
  taskIds: z.array(z.string().min(1).max(256)).min(1).max(200).optional(),
  batchId: z.string().min(1).max(256).optional(),
  batchKey: z.string().trim().min(16).max(128).optional(),
  /**
   * 知情放弃核对（默认 false，服务端按 === true 判定）：仅适用于 unknown 且没有 upstreamId 的任务。
   * 置真表示用户明确知情「放弃核对，上游可能仍在生成」：保留原键/输入/历史、trackingStatus=paused、
   * 解除保守额度，并且不会声称上游已取消；其他状态逐项拒绝，普通取消不要默认传 true。
   */
  abandonUnconfirmed: z.boolean().optional(),
}).refine(value => !!value.taskIds?.length || !!value.batchId || !!value.batchKey, "需要提供 taskIds、batchId 或 batchKey");

const followUpScopeFields = {
  directory: z.string().min(1).max(4096).optional(),
  taskIds: z.array(z.string().min(1).max(256)).min(1).max(200).optional(),
  batchId: z.string().min(1).max(256).optional(),
  batchKey: z.string().trim().min(16).max(128).optional(),
};

export const pauseMediaTasksSchema = z.strictObject(followUpScopeFields)
  .refine(value => !!value.taskIds?.length || !!value.batchId || !!value.batchKey, "需要提供 taskIds、batchId 或 batchKey");

export const resumeMediaTasksSchema = z.strictObject({
  ...followUpScopeFields,
  /** 仅给没有上游 ID 的待核对任务绑定人工核对过的上游 ID；不会创建新的上游任务。 */
  bindTasks: z.array(z.strictObject({
    taskId: z.string().trim().min(1).max(256),
    upstreamId: z.string().trim().min(1).max(512),
  })).max(200).optional(),
}).refine(value => !!value.taskIds?.length || !!value.batchId || !!value.batchKey || !!value.bindTasks?.length, "需要提供 taskIds、batchId、batchKey 或 bindTasks");

export type MediaTaskState = "preparing" | "queued" | "submitting" | "running" | "downloading" | "succeeded" | "failed" | "cancelled" | "unknown";

/** 跟进标记：active（默认）/ blocked（凭据或兼容受阻，等待 resume）/ paused（用户明确暂停服务端跟进）。 */
export type MediaTaskTrackingStatus = "active" | "blocked" | "paused";

/** 输出可用性：available 可播放/下载；cleaned 已按清理规则删除；missing 文件缺失且无清理依据。 */
export type MediaTaskOutputState = "available" | "cleaned" | "missing";

export type MediaTaskSummary = {
  taskId: string;
  batchId: string;
  itemKey: string;
  mediaType: "image" | "video" | "audio";
  state: MediaTaskState;
  providerId: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  outputs: {
    path: string;
    mimeType: string;
    mediaType: "image" | "video" | "audio";
    sha256?: string;
    state?: MediaTaskOutputState;
    cleanedAt?: string;
    /** 原路径已被可追踪改名时的最新工作区相对路径。 */
    resolvedPath?: string;
  }[];
  error?: string;
  cancellationRequested: boolean;
  upstreamCancellation?: boolean;
  canvasId?: string;
  nodeId?: string;
  trackingStatus?: MediaTaskTrackingStatus;
  waitingReason?: string;
  lastQueryAt?: string;
  lastQuerySucceededAt?: string;
  lastUpstreamState?: string;
  resultReadyAt?: string;
  /** 下一次允许跟进（查询/下载）的时间；未来下限不会被重启/暂停/恢复清掉。 */
  retryAt?: string;
  /** 用户明确放弃核对的时间（仅无上游 ID 的待核对任务）。 */
  abandonedAt?: string;
  /** 放弃后重新绑定/恢复成功的时间；记录后豁免撤销。 */
  abandonRevokedAt?: string;
  /** 当前是否仍处于「放弃核对」的有效豁免期。 */
  abandoned?: boolean;
  /** 任务级输出可用性聚合（无输出时不返回）。 */
  outputState?: MediaTaskOutputState;
  /** 任务级最近清理完成时间。 */
  cleanedAt?: string;
  waitingReminderAt?: string;
  waitingReminder?: boolean;
};

export type MediaTaskSubmitResult = {
  batchId: string;
  items: { itemKey: string; status: "accepted" | "existing" | "rejected"; taskId?: string; reason?: string }[];
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
    /** 取消后为 paused 表示「已暂停取回」（下载中取消，可 resume 继续）。 */
    trackingStatus?: MediaTaskTrackingStatus;
    /** abandonUnconfirmed=true 时写入的放弃核对时间。 */
    abandonedAt?: string;
    abandonRevokedAt?: string;
    reason?: string;
  }[];
};

export type MediaTaskFollowUpResult = {
  items: {
    taskId: string;
    status: "paused" | "resumed" | "blocked" | "rejected";
    state?: MediaTaskState;
    trackingStatus?: MediaTaskTrackingStatus;
    upstreamId?: string;
    reason?: string;
  }[];
};

/** 宿主注入的任务方法；缺失时工具明确报错，不伪造成功。 */
export interface MediaTasksContext {
  submitVideoTasks?(input: z.infer<typeof submitMediaTasksSchema>, signal?: AbortSignal): Promise<MediaTaskSubmitResult>;
  getVideoTasks?(input: z.infer<typeof getMediaTasksSchema>, signal?: AbortSignal): Promise<MediaTaskGetResult>;
  cancelVideoTasks?(input: z.infer<typeof cancelMediaTasksSchema>, signal?: AbortSignal): Promise<MediaTaskCancelResult>;
  /** 暂停服务端跟进（主状态不变，上游可能仍在生成）；排队/准备阶段没有可暂停的跟进动作，会明确拒绝。 */
  pauseVideoTasks?(input: z.infer<typeof pauseMediaTasksSchema>, signal?: AbortSignal): Promise<MediaTaskFollowUpResult>;
  /** 恢复跟进并立即查询；只查询/下载已有任务，绝不创建新上游任务；无上游 ID 的任务需先 bind 成功。 */
  resumeVideoTasks?(input: z.infer<typeof resumeMediaTasksSchema>, signal?: AbortSignal): Promise<MediaTaskFollowUpResult>;
}

