import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { mkdir, readFile, readdir, writeAtomic } from "@toonflow/file";
import conf from "@/utils/conf";

/** 任务状态机（单调推进；终态不可被旧轮询覆盖，T 为终态）。 */
export const mediaTaskStates = [
  "preparing", "queued", "submitting", "running", "downloading", "succeeded", "failed", "cancelled", "unknown",
] as const;
export type MediaTaskState = (typeof mediaTaskStates)[number];
export type MediaTaskMediaType = "image" | "video" | "audio";
export type MediaTaskReferenceField = "images" | "videos" | "audios" | "firstFrame" | "lastFrame";

/**
 * 跟进标记（与业务主状态分开）：缺省视为 active。
 * blocked = 凭据/兼容受阻，停止密集重试，等待 resume；paused = 用户明确暂停服务端跟进。
 */
export const mediaTaskTrackingStatuses = ["active", "blocked", "paused"] as const;
export type MediaTaskTrackingStatus = (typeof mediaTaskTrackingStatuses)[number];

export type MediaTaskOutput = {
  /** 工作区相对路径（正斜杠）。按契约 v4 §G 保留为历史原路径，不因目录改名被覆盖。 */
  path: string;
  mimeType: string;
  mediaType: MediaTaskMediaType;
  /** 落盘内容摘要；崩溃重入时按内容去重，避免重复保存同一结果。 */
  sha256?: string;
  /**
   * 当前实际定位（契约 v4 §G/§K）：目录/文件改名后在同一事务内持久更新为最新工作区相对路径；
   * 摘要同时透出 path（历史）与 resolvedPath（最新），可用性与认回一律以 resolvedPath 优先。
   */
  resolvedPath?: string;
};

/**
 * 查询身份快照（T07）：{providerId, modelId, 规范化 API 基址, revision, credentialRef}。
 * 受理时冻结为 submissionIdentity；人工核验成功时把「核验当时」的这一份写进 verifiedRecovery.identity。
 * 只有当前身份与它全等时，才允许复用已核验免检（Key/地址/版本/模型任一变化都必须重新核对）。
 * 只保存非敏感引用，绝不包含原始 Key。
 */
export type MediaTaskQueryIdentitySnapshot = {
  providerId: string;
  modelId: string;
  /** 规范化 API 基址（协议 + 主机 + 端口 + 路径）。 */
  apiBase?: string;
  /** 供应商文件 sha256；读取不到时缺省（缺项不与有值的一方视为相同）。 */
  revision?: string;
  /** 查询凭据的非敏感引用（providerId + Key 的 SHA-256 截断）。 */
  credentialRef: string;
};

/**
 * 历史提交身份（契约 v4 §E）：受理时写入并冻结，用于日后判断「当前查询身份是否仍是提交时那一份」。
 * 只保存非敏感引用，绝不包含原始 Key。
 */
export type MediaTaskSubmissionIdentity = {
  providerId: string;
  modelId: string;
  /** 规范化 API 基址（协议 + 主机 + 端口 + 路径）。 */
  apiBase?: string;
  /** 提交时的供应商文件 sha256。 */
  revision: string;
  /** 查询凭据的非敏感引用（providerId + Key 的 SHA-256 截断）。 */
  credentialRef: string;
};

/** 两项查询身份（或其中一项缺失）是否可证明「仍是同一份身份」：五项全等才算一致。 */
export function mediaTaskQueryIdentityMatches(
  left: MediaTaskQueryIdentitySnapshot | undefined,
  right: MediaTaskQueryIdentitySnapshot | undefined,
) {
  if (!left || !right) return false;
  return left.providerId === right.providerId
    && left.modelId === right.modelId
    && (left.apiBase ?? "") === (right.apiBase ?? "")
    && (left.revision ?? "") === (right.revision ?? "")
    && left.credentialRef === right.credentialRef;
}

/**
 * 已核实的恢复依据（契约 v4 §E）：人工只读核对成功后持久化，
 * 下次 load 复用；但只有当前身份与 identity（核验当时的完整查询身份）仍全等时才可免检，
 * 否则保持受阻、要求重新核对（T07：核验后变更 Key/地址/revision 不得继续免检）。
 */
export type MediaTaskVerifiedRecovery = {
  /** 核对时响应回显并与候选相等、且已写入本地的上游任务 ID。 */
  upstreamId: string;
  /** 上游回显并与任务模型一致时记录。 */
  model?: string;
  /** 只有与可信身份派生标识比较一致才记录账户哈希（不可逆）。 */
  accountHash?: string;
  verifiedAt: string;
  /** bind=人工补绑；rematch=已有 ID 被兼容门挡住后的同 ID 只读复核。 */
  source: "bind" | "rematch";
  /**
   * 核验当时的完整查询身份（T07）；旧记录该字段缺失时不得免检，只能重新核对。
   */
  identity?: MediaTaskQueryIdentitySnapshot;
};

/**
 * 改名事务部分失败后的持久阻断（T15）：迁移/补偿无法完成时写入受影响任务，
 * 供诊断与后续重试；任何一次成功完成的迁移都会在同一写入内清除该字段。
 * 它不是终态标记，也不会被恢复流程自动抹掉。
 */
export type MediaTaskRelocationBlock = {
  at: string;
  reason: string;
  /** 工作区相对路径（源/目标）。 */
  source: string;
  target: string;
  /** 本次事务涉及的全部受影响任务 ID（便于整体核对与恢复）。 */
  taskIds: string[];
  /**
   * 事务身份（契约 §O.1，Q/C 共用同一确定性算法）：
   * `"relocate:" + sha256(目录 + "\0" + 源绝对路径 + "\0" + 目标绝对路径).slice(0, 16)`。
   * 旧记录可能缺失（缺失时只能按 source/target 核对，不改写为其它值）。
   */
  transactionId?: string;
  /** 事务所在的规范化工作区绝对路径（§O.1）；旧记录可能缺失。 */
  directory?: string;
  /** 本次事务涉及的引用身份（§O.1，`task:<id>` 与记录身份）；旧记录可能缺失。 */
  refs?: string[];
};

export type MediaTaskInputSnapshot = {
  field: MediaTaskReferenceField;
  /** 数组下标；firstFrame/lastFrame 固定为 -1。 */
  index: number;
  /** 原工作区相对路径。 */
  path: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  /** 内容寻址快照绝对路径。 */
  snapshot: string;
};

export type MediaTaskRecord = {
  taskId: string;
  batchId: string;
  itemKey: string;
  /** sha256(规范化目录 \0 batchKey \0 itemKey)。 */
  idempotencyKey: string;
  /** sha256(规范化请求 + 快照引用)。 */
  fingerprint: string;
  /** 规范化（realpath）工作区绝对路径。 */
  directory: string;
  mediaType: MediaTaskMediaType;
  state: MediaTaskState;
  /** 每次有效更新自增；用于并发写入的可观测性与陈旧写入检测。 */
  stateVersion: number;
  /** 媒体 schema 解析后的请求（不含 directory）。 */
  request: Record<string, unknown>;
  canvasId?: string;
  nodeId?: string;
  providerId: string;
  modelId: string;
  /** 供应商文件 sha256；变更后恢复需人工确认。 */
  providerRevision: string;
  /** 提交时的供应商 API 基地址（非密钥）；恢复时地址变更即保持受阻，不向其他地址盲查。 */
  providerApiUrl?: string;
  inputSnapshots: MediaTaskInputSnapshot[];
  upstreamId?: string;
  outputs: MediaTaskOutput[];
  /** 已去敏的错误文案。 */
  error?: string;
  cancellationRequested: boolean;
  upstreamCancellation?: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** 下一次允许跟进（查询/下载）的时间；查询退避与下载退避共用。 */
  retryAt?: string;
  retryCount?: number;
  /** 跟进标记；缺省视为 active（旧记录兼容）。 */
  trackingStatus?: MediaTaskTrackingStatus;
  /** blocked/paused 的可读原因（已去敏）。 */
  waitingReason?: string;
  /** 上次查询上游的尝试时间。 */
  lastQueryAt?: string;
  /** 上次查询成功的时间。 */
  lastQuerySucceededAt?: string;
  /** 上游最近状态原文（供应商透传时保留原值）。 */
  lastUpstreamState?: string;
  /** 上游报告成功、结果可取的时间。 */
  resultReadyAt?: string;
  /** 取得上游任务 ID 的时间；查询退避阶段与等待提醒按此计算。 */
  submittedAt?: string;
  /**
   * 用户明确放弃核对的时间（仅 unknown 且无上游 ID）；不声称上游取消，仅解除保守额度。
   * 与 abandonRevokedAt 一起表示当前是否仍有豁免。
   */
  abandonedAt?: string;
  /** 放弃后重新绑定/恢复成功的时间；记录后撤销豁免，按实际上游未终结事实重新计入额度。 */
  abandonRevokedAt?: string;
  /**
   * 提交时查询凭据的非敏感引用（providerId + API Key 的 SHA-256 截断，不可逆、不能用于调用上游）。
   * 用于核对「同一账户」；不存原始 Key，也不持久化任何可用于请求的凭据。
   */
  providerCredentialRef?: string;
  /** 历史提交身份（契约 v4 §E）；旧记录缺失时回退到上面的 providerApiUrl/providerRevision/providerCredentialRef。 */
  submissionIdentity?: MediaTaskSubmissionIdentity;
  /** 人工核对成功后的恢复依据（契约 v4 §E）；存在、upstreamId 匹配且当前身份与 identity 全等时才免检。 */
  verifiedRecovery?: MediaTaskVerifiedRecovery;
  /**
   * 提交尝试事实的显式取值（T09）：受理时写入 "pending"（本地准备中，尚未发起上游创建）；
   * 真正的网络尝试门槛成功落盘后改为 "attempted"，并同时写 submissionAttemptedAt。
   * 恢复时只有「显式 pending」才允许判定“确定未提交 → failed”；缺失该字段的旧格式记录
   * （含上一版可能已发网络但未写字段的记录）一律保守判 unknown，绝不自动重提。
   */
  submissionAttemptState?: "pending" | "attempted";
  /**
   * 「真正开始网络尝试」的时间事实（契约 v4 §F）：与 submitting 状态分开持久化，供摘要透出，
   * 让调用方区分「准备失败」与「提交不明」。写入该字段后中断即按 unknown 保守处理。
   */
  submissionAttemptedAt?: string;
  /** 改名事务部分失败后的持久阻断（T15）；成功迁移时清除。 */
  relocationBlocked?: MediaTaskRelocationBlock;
};

export type MediaTaskBatch = {
  batchId: string;
  directory: string;
  batchKey: string;
  mediaType: MediaTaskMediaType;
  createdAt: string;
  updatedAt: string;
  tasks: MediaTaskRecord[];
};

const terminalStates: readonly MediaTaskState[] = ["succeeded", "failed", "cancelled", "unknown"];
/** 真正结束的状态；unknown 不属于此类——它是待核对状态，仍需保留关联，可被人工核对后继续。 */
const finishedStates: readonly MediaTaskState[] = ["succeeded", "failed", "cancelled"];

export function isTerminalMediaTaskState(state: MediaTaskState) {
  return terminalStates.includes(state);
}

/** 已结束（不再有任何跟进价值）的主状态。 */
export function isFinishedMediaTaskState(state: MediaTaskState) {
  return finishedStates.includes(state);
}

/** 跟进标记：旧记录缺省按 active 处理，非法值同样回退 active。 */
export function mediaTaskTrackingStatus(task: MediaTaskRecord): MediaTaskTrackingStatus {
  return task.trackingStatus === "blocked" || task.trackingStatus === "paused" ? task.trackingStatus : "active";
}

/**
 * 是否处于「用户明确放弃核对」的有效豁免期：放弃过且尚未通过 bind/resume 撤销。
 * 仅用于无上游 ID 的 unknown 任务；放弃后核实到原 ID 会被撤销并按实际事实重新计入。
 */
export function mediaTaskAbandoned(task: MediaTaskRecord) {
  return !!task.abandonedAt && !task.abandonRevokedAt;
}

/**
 * 保守占用「上游未终结的在途额度」（契约 v3 §B）：
 * - preparing/queued 尚未提交 → 不占；
 * - 已结束（succeeded/failed/cancelled）→ 不占；
 * - downloading（上游已明确成功终结，只剩取回）→ 不占，下载用独立并发额度；
 * - 无上游 ID 的待核对（unknown）→ 保守占，除非用户明确放弃核对且未撤销；
 * - 其余（submitting/running、已绑定 ID 的 unknown）→ 占，包含 paused/blocked 但未终结的任务。
 */
export function occupiesUpstreamSlot(task: MediaTaskRecord) {
  if (isFinishedMediaTaskState(task.state)) return false;
  if (task.state === "preparing" || task.state === "queued") return false;
  if (task.state === "downloading") return false;
  if (task.state === "unknown" && !task.upstreamId && mediaTaskAbandoned(task)) return false;
  return true;
}

/**
 * 清理已到期的 retryAt；未来 retryAt 必须保留（契约 v3 §B）：
 * 重启恢复、pause/resume、bind、手动刷新都不得清掉尚未到期的退避下限，
 * 下一次尝试不早于上游 Retry-After 与本地退避的较晚值。
 */
export function clearExpiredMediaTaskRetryAt(task: Pick<MediaTaskRecord, "retryAt">) {
  if (!task.retryAt) return;
  const at = Date.parse(task.retryAt);
  if (Number.isNaN(at) || at <= Date.now()) task.retryAt = undefined;
}

/**
 * 查询凭据身份引用：只保存 providerId + API Key 的 SHA-256 截断值，
 * 用于判断「当前凭据是否仍是提交时的那一份」；不可逆，也不能用于调用上游。
 */
export function mediaProviderCredentialReference(providerId: string, apiKey: string) {
  return createHash("sha256").update("toonflow-media-credential").update("\0").update(providerId).update("\0").update(apiKey).digest("hex").slice(0, 32);
}

/**
 * 账户标识的派生哈希（不可逆）：只有与同一条提交身份下已记录的可信账户哈希一致时，
 * 上游回显的账户才算「已核实」；没有任何可信依据时保持 unverifiable，不编造账户归属。
 */
export function mediaTaskAccountHash(account: string) {
  const normalized = account.trim().toLowerCase();
  if (!normalized) return undefined;
  return createHash("sha256").update("toonflow-media-account").update("\0").update(normalized).digest("hex").slice(0, 32);
}

/** 历史提交身份：优先新字段，旧记录回退到 providerApiUrl/providerRevision/providerCredentialRef（缺项保留 undefined）。 */
export function mediaTaskSubmissionIdentity(task: MediaTaskRecord): MediaTaskSubmissionIdentity | undefined {
  const identity = task.submissionIdentity;
  const providerId = identity?.providerId ?? task.providerId;
  const modelId = identity?.modelId ?? task.modelId;
  const revision = identity?.revision ?? task.providerRevision;
  const credentialRef = identity?.credentialRef ?? task.providerCredentialRef;
  const apiBase = identity?.apiBase ?? task.providerApiUrl;
  if (!providerId || !modelId || !revision || !credentialRef) return undefined;
  return { providerId, modelId, revision, credentialRef, ...(apiBase ? { apiBase } : {}) };
}

// 单进程单实例：内存索引即权威视图，写入同步落盘（writeAtomic + durable）。
// Q1/F14：公共内存视图只在原子落盘成功后发布；首写进行中只有内部保留位，读接口与幂等重传都看不到它。
const batches = new Map<string, MediaTaskBatch>();
const batchOfTask = new Map<string, string>();
const taskOfKey = new Map<string, string>();
// (规范化目录, batchKey) → batchId 列表；历史数据可能有同键多文件，查询时全部聚合。
const batchKeys = new Map<string, string[]>();
/** 整批快照写入串行链：避免并发全量落盘互相覆盖（同一批次内任务更新与追加提交）。 */
const batchChains = new Map<string, Promise<unknown>>();
/** 首写保留位：仅用于并发首写的互斥，不进入任何读路径，也不用于幂等重传的 existing 判定。 */
const reservingTaskIds = new Set<string>();
const reservingIdempotencyKeys = new Set<string>();
/** 在途落盘计数：停机时用于最终排空写队列。 */
let pendingWrites = 0;
let pendingWriteWaiters: (() => void)[] = [];
let storeLoading: Promise<void> | undefined;
let storeReady = false;
/** 装载时被跳过的损坏批次文件（去敏为文件名）；非空表示任务台账未能完整确认。 */
const storeLoadWarnings: string[] = [];

/** 同一客户端 batchKey 在同一工作区内的稳定标识。 */
export function mediaTaskBatchKey(directory: string, batchKey: string) {
  return `${directory}\u0000${batchKey}`;
}

function registerBatchKey(batch: MediaTaskBatch) {
  if (typeof batch.directory !== "string" || typeof batch.batchKey !== "string") return;
  const key = mediaTaskBatchKey(batch.directory, batch.batchKey);
  const list = batchKeys.get(key) ?? [];
  if (!list.includes(batch.batchId)) list.push(batch.batchId);
  batchKeys.set(key, list);
}

export function mediaTasksRootDirectory() {
  return join(dirname(conf.path), "mediaTasks");
}

export function mediaTasksBatchesDirectory() {
  return join(mediaTasksRootDirectory(), "batches");
}

export function mediaTasksInputsDirectory() {
  return join(mediaTasksRootDirectory(), "inputs");
}

export function ensureMediaTasksStore(): Promise<void> {
  storeLoading ??= loadMediaTasksStore().catch(error => {
    storeLoading = undefined;
    storeReady = false;
    throw error;
  });
  return storeLoading;
}

/** 存储是否已经加载完成；就绪判断不能只看目录可写。 */
export function mediaTasksStoreLoaded() {
  return storeReady;
}

/** 装载时被跳过的损坏批次文件（文件名，已去敏）；非空时任务台账未能完整确认，就绪必须为 false。 */
export function mediaTaskStoreLoadWarnings() {
  return [...storeLoadWarnings];
}

async function loadMediaTasksStore() {
  await mkdir(mediaTasksBatchesDirectory(), { recursive: true });
  const entries = await readdir(mediaTasksBatchesDirectory(), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const path = join(mediaTasksBatchesDirectory(), entry.name);
    try {
      const batch = JSON.parse(await readFile(path, "utf8")) as MediaTaskBatch;
      if (!batch || typeof batch !== "object" || typeof batch.batchId !== "string" || !Array.isArray(batch.tasks)) {
        throw new Error("批次记录结构无效");
      }
      if (batches.has(batch.batchId)) throw new Error("批次 ID 重复");
      // Q1：整个文件校验通过后才建立索引，避免损坏文件留下指向不存在批次的部分索引。
      for (const task of batch.tasks) {
        if (!task || typeof task.taskId !== "string" || typeof task.idempotencyKey !== "string") throw new Error("任务记录结构无效");
        // ACT: 兼容早期记录缺省字段，缺失数组按空处理，不猜测业务内容。
        task.outputs ??= [];
        task.inputSnapshots ??= [];
        task.stateVersion ??= 0;
        task.cancellationRequested = task.cancellationRequested === true;
        // ACT: 旧记录补跟进字段；unknown 保留待核对原样（不视为失败），其余非终态缺省 active。
        if (task.trackingStatus !== "active" && task.trackingStatus !== "blocked" && task.trackingStatus !== "paused") {
          task.trackingStatus = task.state === "unknown" ? undefined : "active";
        }
      }
      batches.set(batch.batchId, batch);
      registerBatchKey(batch);
      for (const task of batch.tasks) {
        batchOfTask.set(task.taskId, batch.batchId);
        taskOfKey.set(task.idempotencyKey, task.taskId);
      }
    } catch (error) {
      // ACT: 损坏文件跳过并保留，不删除，避免掩盖恢复依据；同时记录装载告警，就绪判断据此为 false。
      const message = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
        ? String((error as { message: string }).message) : String(error);
      storeLoadWarnings.push(`任务批次文件无法读取：${entry.name}（${message.slice(0, 200)}）`);
      console.warn(`媒体任务批次文件无法读取，已跳过：${path}`, error);
    }
  }
  storeReady = true;
}

export function getMediaTaskBatch(batchId: string) {
  return batches.get(batchId);
}

function compareBatchCreatedAt(left: MediaTaskBatch, right: MediaTaskBatch) {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.batchId < right.batchId ? -1 : left.batchId > right.batchId ? 1 : 0;
}

/** 该 (目录, batchKey) 下的全部批次（历史数据可能分散在多个文件）。 */
export function listMediaTaskBatchesByKey(directory: string, batchKey: string) {
  const list = batchKeys.get(mediaTaskBatchKey(directory, batchKey)) ?? [];
  return list.map(batchId => batches.get(batchId)).filter((batch): batch is MediaTaskBatch => !!batch).sort(compareBatchCreatedAt);
}

/** 追加/复用的目标批次：同键多文件时取最新创建的一个。 */
export function findMediaTaskBatch(directory: string, batchKey: string) {
  const candidates = listMediaTaskBatchesByKey(directory, batchKey);
  return candidates[candidates.length - 1];
}

export function getMediaTask(taskId: string) {
  const batchId = batchOfTask.get(taskId);
  const batch = batchId ? batches.get(batchId) : undefined;
  return batch?.tasks.find(task => task.taskId === taskId);
}

export function getMediaTaskByKey(idempotencyKey: string) {
  const taskId = taskOfKey.get(idempotencyKey);
  return taskId ? getMediaTask(taskId) : undefined;
}

export function listMediaTaskBatches() {
  return [...batches.values()];
}

export function listMediaTasks(): MediaTaskRecord[] {
  return [...batches.values()].flatMap(batch => batch.tasks);
}

export function listMediaTasksInState(state: MediaTaskState): MediaTaskRecord[] {
  return listMediaTasks().filter(task => task.state === state);
}

export function listActiveMediaTasks(): MediaTaskRecord[] {
  return listMediaTasks().filter(task => !isTerminalMediaTaskState(task.state));
}

/**
 * 运行时改名阻断（T15/§O.1）：持久阻断（task.relocationBlocked）写不出时，仍必须保留**被实际消费**的
 * 运行时阻断；只在当前进程有效，成功迁移（任务侧发布落盘成功）后清除。跨重启的保守由 C 的持久意图/
 * 范围保护承担；状态摘要据此给出「本进程已阻断」而不是「已持久保护」。
 */
const runtimeRelocationBlocks = new Map<string, MediaTaskRelocationBlock>();

export function registerRuntimeRelocationBlock(taskId: string, block: MediaTaskRelocationBlock) {
  runtimeRelocationBlocks.set(taskId, block);
}

export function clearRuntimeRelocationBlock(taskId: string) {
  runtimeRelocationBlocks.delete(taskId);
}

/** 任务当前有效的改名阻断：持久字段优先，持久写失败时回退到运行时阻断。 */
export function effectiveRelocationBlock(task: MediaTaskRecord): MediaTaskRelocationBlock | undefined {
  return task.relocationBlocked ?? runtimeRelocationBlocks.get(task.taskId);
}

/**
 * 未完成改名事务清单（§O.3 启动消费）：**包含终态任务**——存在未完成改名事实时，即使任务已 succeeded、
 * 各 JSON 各自合法，也不得当作「迁移成功」；恢复流程与状态摘要据此给出可读诊断
 * （transactionId/source/target/阻断来源），不改写任务状态本身。origin 区分持久阻断与本进程运行时阻断。
 */
export function listUnfinishedRelocationTasks(): { task: MediaTaskRecord; block: MediaTaskRelocationBlock; origin: "persisted" | "runtime" }[] {
  const entries: { task: MediaTaskRecord; block: MediaTaskRelocationBlock; origin: "persisted" | "runtime" }[] = [];
  for (const task of listMediaTasks()) {
    const block = effectiveRelocationBlock(task);
    if (!block) continue;
    entries.push({ task, block, origin: task.relocationBlocked ? "persisted" : "runtime" });
  }
  return entries;
}

export function countMediaTasksByState(tasks: MediaTaskRecord[]) {
  const counts: Partial<Record<MediaTaskState, number>> = {};
  for (const task of tasks) counts[task.state] = (counts[task.state] ?? 0) + 1;
  return counts;
}

/* ---------------------------------------------------------------------------
 * 改名事务活动边界与参与集合（T15/§P.1/§P.2，同步只读）
 * ------------------------------------------------------------------------- */

/** 工作区相对前缀归一化（与改名影响判定同口径：正斜杠、去首 ./ 与尾斜杠）。 */
export function normalizeRelativePrefix(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

/** 输出的「当前实际定位」（resolvedPath 优先；没有 resolvedPath 时 path 就是当前定位）。 */
export function currentOutputPath(output: MediaTaskOutput) {
  const current = typeof output.resolvedPath === "string" && output.resolvedPath ? output.resolvedPath : output.path;
  return typeof current === "string" ? normalizeRelativePrefix(current) : "";
}

/** 当前定位是否落在给定相对前缀下（目录本身或真正后代；a 与 ab 不混）。 */
export function outputPathUnderPrefix(current: string, prefix: string) {
  return !!current && !!prefix && (current === prefix || current.startsWith(`${prefix}/`));
}

/** §P.1 从引用集合中取任务身份（task:<taskId>）；record:<id> 等引用不属于参与集合。 */
export function taskIdsFromRelocationRefs(refs: readonly unknown[] | undefined): string[] {
  const ids: string[] = [];
  for (const ref of refs ?? []) {
    if (typeof ref !== "string" || !ref.startsWith("task:")) continue;
    const id = ref.slice("task:".length).trim();
    if (id) ids.push(id);
  }
  return ids;
}

/** 事务身份（§P.1）：Q 的阻断记录与 C 的持久意图共用；旧格式阻断可能缺 transactionId。 */
export type RelocationTransactionIdentity = {
  /** 事务所在工作区（规范化绝对路径）；旧格式阻断按目录 + 精确 source→target 核对。 */
  directory: string;
  transactionId?: string;
  /** 工作区相对源/目标（阻断记录口径）。 */
  source: string;
  target: string;
};

function sameDirectoryRoot(left: string, right: string) {
  // Windows 下 path.relative 已按大小写不敏感比较。
  return relative(left, right) === "";
}

/**
 * §P.1 阻断记录是否属于给定事务：双方都有事务身份时按身份核（确定性 ID 同目录同路径对一致）；
 * 任一方缺失（旧格式阻断）时退回精确 source→target 相对路径核对——不得按前缀/祖先放行。
 */
export function relocationBlockMatchesTransaction(block: MediaTaskRelocationBlock, transaction: Pick<RelocationTransactionIdentity, "transactionId" | "source" | "target">) {
  if (transaction.transactionId && block.transactionId) return block.transactionId === transaction.transactionId;
  return normalizeRelativePrefix(block.source) === normalizeRelativePrefix(transaction.source)
    && normalizeRelativePrefix(block.target) === normalizeRelativePrefix(transaction.target);
}

/**
 * §P.1：C 的迁移意图摘要透出的 participants（冻结契约 §P.1）。store 保持叶子模块（不 import fileRecords），
 * 由调用方（Q 的协调层 / status 层，均已导入 fileRecords）传入意图条目，这里只做容忍读取：
 * 字段未落地/为空时返回空集合，参与集合自动回退到 Q 自身的持久阻断记录 ∪ 当前核对发现。
 */
export function relocationIntentParticipantIds(intent: unknown): string[] {
  if (!intent || typeof intent !== "object") return [];
  const value = (intent as { participants?: unknown }).participants;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && !!item.trim()).map(item => item.trim());
}

/**
 * §P.1 事务完整参与集合（同步只读，供恢复与 health/status 诊断）：
 * Q 的持久/运行时阻断记录（该事务全部任务 —— 覆盖「已发布到目标、仅剩 block」的成员）∪
 * 调用方传入的 C 意图 participants（按冻结契约透出；未落地时为空）。
 * 不含「当前核对发现」的成员——调用方必须再与本次发现并集（恢复集合 = 持久 ∪ 当前）。
 */
export function relocationTransactionParticipants(transaction: RelocationTransactionIdentity & {
  /** C 的持久意图 participants（调用方从意图摘要读取后传入；store 不反向依赖 fileRecords）。 */
  intentParticipants?: readonly string[];
}): string[] {
  const participants = new Set<string>();
  for (const entry of listUnfinishedRelocationTasks()) {
    if (!sameDirectoryRoot(entry.task.directory, transaction.directory)) continue;
    if (!relocationBlockMatchesTransaction(entry.block, transaction)) continue;
    participants.add(entry.task.taskId);
    for (const id of taskIdsFromRelocationRefs(entry.block.taskIds)) participants.add(id);
    for (const id of taskIdsFromRelocationRefs(entry.block.refs)) participants.add(id);
  }
  for (const id of transaction.intentParticipants ?? []) {
    const value = typeof id === "string" ? id.trim() : "";
    if (value) participants.add(value);
  }
  return [...participants].sort();
}

/**
 * §P.1 单参与者逐项核对（同步只读）：undefined=已收敛；否则为未收敛原因。
 * - 任一 outputs 的当前定位仍在「本方向的另一侧」前缀下（commit=仍在源、compensate=仍在目标）⇒ 未收敛；
 * - 任务记录缺失（已删除/未加载）⇒ 未收敛（缺任务不得当整组完成）；
 * - 仍带**本事务**的阻断记录 ⇒ 未收敛；其他事务的阻断与本事务收敛判定无关（重叠阻断在改名入口已被拒绝）。
 * 事务身份只认确定性 transactionId 或精确 source→target；不得按前缀/祖先放宽。
 */
export function relocationParticipantOpenReason(taskId: string, input: {
  transactionId?: string;
  /** 工作区相对源/目标（与阻断记录同口径）。 */
  source: string;
  target: string;
  direction: "commit" | "compensate";
}): string | undefined {
  const task = getMediaTask(taskId);
  if (!task) return "任务记录不存在（已删除或未加载），无法核对 outputs 与本事务阻断";
  const prefix = normalizeRelativePrefix(input.direction === "commit" ? input.source : input.target);
  const side = input.direction === "commit" ? "源路径" : "目标路径";
  const stale = task.outputs
    .map(output => currentOutputPath(output))
    .filter(current => outputPathUnderPrefix(current, prefix));
  if (stale.length) {
    return input.direction === "commit"
      ? `任务 outputs 仍定位在${side}（未发布到目标）：${stale.join("、")}`
      : `任务 outputs 仍定位在${side}（补偿未回落）：${stale.join("、")}`;
  }
  const block = effectiveRelocationBlock(task);
  if (block && relocationBlockMatchesTransaction(block, input)) {
    return `本事务的改名阻断记录仍在（${normalizeRelativePrefix(block.source)} → ${normalizeRelativePrefix(block.target)}），尚未解除`;
  }
  return undefined;
}

/**
 * §P.2 活动边界（①运行时）：本进程内该事务的正向/补偿调用尚未返回。
 * 纯内存、同步、**不取任何锁**：供 C 的显式恢复入口（POST /api/cleanup/protections）判忙——
 * 有活动事务时返回 409 忙状态，不得把「路径锁空闲」当作「整个改名已完成」（R1b）。
 */
const activeRelocationTransactions = new Map<string, { phase: "forward" | "compensating"; participants: string[]; startedAt: string; depth: number }>();

export function beginRelocationTransactionActivity(transactionId: string, phase: "forward" | "compensating", participants: readonly string[]) {
  const current = activeRelocationTransactions.get(transactionId);
  activeRelocationTransactions.set(transactionId, {
    phase,
    participants: [...participants],
    startedAt: current?.startedAt ?? new Date().toISOString(),
    // 同一事务理论上一路在途；用深度计数防御意外重入，避免内层收尾提前清掉外层活动事实。
    depth: (current?.depth ?? 0) + 1,
  });
}

export function updateRelocationTransactionPhase(transactionId: string, phase: "forward" | "compensating") {
  const current = activeRelocationTransactions.get(transactionId);
  if (current) current.phase = phase;
}

export function endRelocationTransactionActivity(transactionId: string) {
  const current = activeRelocationTransactions.get(transactionId);
  if (!current) return;
  if (current.depth > 1) {
    current.depth -= 1;
    return;
  }
  activeRelocationTransactions.delete(transactionId);
}

/** §P.2 只读判定（同步、无锁、不等待）：该事务本进程内是否有未返回的正向/补偿调用。 */
export function isRelocationTransactionActive(transactionId: string): boolean {
  return typeof transactionId === "string" && !!transactionId.trim() && activeRelocationTransactions.has(transactionId.trim());
}

/**
 * §P.2 事务 phase（供 health/status 诊断）：本进程正向/补偿调用在途时如实给 forward/compensating；
 * 无在途调用但有未收敛持久事实时为 unsettled（不得当作已完成）。
 */
export function relocationTransactionPhase(transactionId?: string): "forward" | "compensating" | "unsettled" {
  return (transactionId ? activeRelocationTransactions.get(transactionId)?.phase : undefined) ?? "unsettled";
}

async function persistBatch(batch: MediaTaskBatch) {
  await writeAtomic(join(mediaTasksBatchesDirectory(), `${batch.batchId}.json`), JSON.stringify(batch), { durable: true });
}

/** 计数的整批落盘：停机排空据此等待全部关键写入（含已取得上游 ID 的临界段）。 */
async function persistBatchCounted(batch: MediaTaskBatch) {
  pendingWrites += 1;
  try {
    await persistBatch(batch);
  } finally {
    pendingWrites -= 1;
    if (!pendingWrites && pendingWriteWaiters.length) {
      const waiters = pendingWriteWaiters;
      pendingWriteWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}

/** 等待全部已排队的任务写入完成（仅写队列；停机收敛由 scheduler 统一编排）。 */
export type MediaTaskWriteDrainResult = {
  /** 是否在截止前全部排空。 */
  completed: boolean;
  /** 调用返回时仍在途的写入数量。 */
  pendingWrites: number;
};

/**
 * 带截止的写队列排空（契约 v4 §A.2）：必须在截止内返回，未排空也要如实报告数量。
 * options.deadline 为绝对截止（Date.now() 毫秒时间戳）；未给或已过期时只做一次计数检查。
 */
export async function drainMediaTaskWriteQueue(options: { deadline?: number } = {}): Promise<MediaTaskWriteDrainResult> {
  const deadline = typeof options.deadline === "number" && Number.isFinite(options.deadline) ? options.deadline : Number.POSITIVE_INFINITY;
  while (pendingWrites > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        const index = pendingWriteWaiters.indexOf(finish);
        if (index >= 0) pendingWriteWaiters.splice(index, 1);
        resolve();
      };
      // 至少每 250ms 复检一次，保证外部截止到点即返回。
      timer = setTimeout(finish, Math.min(remaining, 250));
      timer.unref?.();
      pendingWriteWaiters.push(finish);
    });
  }
  return { completed: pendingWrites === 0, pendingWrites };
}

/** 在途落盘数量（只读观测，供状态摘要与停机判断）。 */
export function pendingMediaTaskWrites() {
  return pendingWrites;
}

/**
 * 在途受理计数（契约 v4 §A.3）：从受理入口进入（含目录/供应商/快照/批次锁等待）
 * 到持久完成的请求数量。未开始写盘的协调等待不允许被判定成「已排空」。
 */
let inflightRequests = 0;

/** 登记一次在途受理；返回的结束函数幂等，必须在使用方 finally 中调用。 */
export function beginMediaTaskInflight() {
  inflightRequests += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    inflightRequests -= 1;
  };
}

/**
 * 排空判定用的在途总量：受理入口请求 + 尚未结束的协调等待（taskChains/batchChains）。
 * 只反映内部协调状态，不进入任何公开台账字段。
 */
export function countMediaTaskInflight() {
  return inflightRequests + taskChains.size + batchChains.size;
}

/** 同一批次的整快照写入串行化。 */
function withBatchChain<T>(batchId: string, operation: () => Promise<T>): Promise<T> {
  const previous = batchChains.get(batchId) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => undefined, () => undefined);
  batchChains.set(batchId, settled);
  void settled.then(() => {
    if (batchChains.get(batchId) === settled) batchChains.delete(batchId);
  });
  return result;
}

/** 首写保留位：只拒绝真正的并发首写，不参与任何对外可见性或幂等重传判定。 */
function reserveTasks(tasks: MediaTaskRecord[]) {
  for (const task of tasks) {
    if (batchOfTask.has(task.taskId) || reservingTaskIds.has(task.taskId)) {
      throw Object.assign(new Error("任务 ID 冲突"), { status: 409 });
    }
    if (taskOfKey.has(task.idempotencyKey) || reservingIdempotencyKeys.has(task.idempotencyKey)) {
      throw Object.assign(new Error("任务幂等键冲突"), { status: 409 });
    }
  }
  for (const task of tasks) {
    reservingTaskIds.add(task.taskId);
    reservingIdempotencyKeys.add(task.idempotencyKey);
  }
}

function releaseTasks(tasks: MediaTaskRecord[]) {
  for (const task of tasks) {
    reservingTaskIds.delete(task.taskId);
    reservingIdempotencyKeys.delete(task.idempotencyKey);
  }
}

/**
 * 创建批次并持久化受理记录（preparing）。
 * Q1/F14：构造候选 → 原子持久化成功 → 再发布公共内存视图；首写失败直接向调用方传播，
 * 因此 accepted/existing 永远指向已落盘记录，读接口也不会命中未持久化的任务。
 */
export async function createMediaTaskBatch(input: {
  batchId: string;
  batchKey: string;
  directory: string;
  mediaType: MediaTaskMediaType;
  tasks: MediaTaskRecord[];
}): Promise<MediaTaskBatch> {
  await ensureMediaTasksStore();
  const now = new Date().toISOString();
  const batch: MediaTaskBatch = {
    batchId: input.batchId,
    directory: input.directory,
    batchKey: input.batchKey,
    mediaType: input.mediaType,
    createdAt: now,
    updatedAt: now,
    tasks: input.tasks,
  };
  if (batches.has(batch.batchId)) throw Object.assign(new Error("批次 ID 冲突"), { status: 409 });
  reserveTasks(batch.tasks);
  try {
    await persistBatchCounted(batch);
  } finally {
    releaseTasks(batch.tasks);
  }
  // 落盘成功后才发布：此前的并发读者看不到这些任务。
  batches.set(batch.batchId, batch);
  registerBatchKey(batch);
  for (const task of batch.tasks) {
    batchOfTask.set(task.taskId, batch.batchId);
    taskOfKey.set(task.idempotencyKey, task.taskId);
  }
  return batch;
}

/** 新任务并入既有批次：先落盘含新任务的候选快照，成功后再发布到公共内存视图。 */
export async function appendMediaTasks(batchId: string, tasks: MediaTaskRecord[]): Promise<MediaTaskBatch> {
  await ensureMediaTasksStore();
  return withBatchChain(batchId, async () => {
    const batch = batches.get(batchId);
    if (!batch) throw Object.assign(new Error("批次不存在"), { status: 404 });
    reserveTasks(tasks);
    try {
      const updatedAt = new Date().toISOString();
      const candidate: MediaTaskBatch = { ...batch, tasks: [...batch.tasks, ...tasks], updatedAt };
      await persistBatchCounted(candidate);
      // 发布：保持批次与任务对象引用身份，只把已落盘内容写入公共视图。
      batch.tasks.push(...tasks);
      batch.updatedAt = updatedAt;
    } finally {
      releaseTasks(tasks);
    }
    for (const task of tasks) {
      batchOfTask.set(task.taskId, batch.batchId);
      taskOfKey.set(task.idempotencyKey, task.taskId);
    }
    return batch;
  });
}

/**
 * 批次级更新（仅用于受理阶段，任务尚无执行者）；先落盘候选再发布，落盘失败时公共视图完全不变。
 * 不支持增删任务（该语义由 appendMediaTasks 提供），避免引用身份与索引错位。
 */
export async function updateMediaTaskBatch(batchId: string, plan: (batch: MediaTaskBatch) => boolean | void): Promise<MediaTaskBatch | undefined> {
  await ensureMediaTasksStore();
  return withBatchChain(batchId, async () => {
    const batch = batches.get(batchId);
    if (!batch) return undefined;
    const candidate = structuredClone(batch);
    if (plan(candidate) === false) return batch;
    if (candidate.tasks.length !== batch.tasks.length) throw new Error("批次更新不支持增删任务，请使用 appendMediaTasks");
    candidate.updatedAt = new Date().toISOString();
    await persistBatchCounted(candidate);
    for (const [index, task] of batch.tasks.entries()) Object.assign(task, candidate.tasks[index]!);
    batch.updatedAt = candidate.updatedAt;
    return batch;
  });
}

const taskChains = new Map<string, Promise<unknown>>();

/** 按 key（taskId 或幂等键）串行的更新队列。 */
export function withMediaTaskLock<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
  const previous = taskChains.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => undefined, () => undefined);
  taskChains.set(key, settled);
  void settled.then(() => {
    if (taskChains.get(key) === settled) taskChains.delete(key);
  });
  return result;
}

/**
 * 单任务串行更新：plan 收到当前记录与版本号；返回 apply 函数才视为有效更新
 * （apply 内修改记录，stateVersion 自增并同步落盘）。plan 返回 undefined/false
 * 时视为陈旧或条件不满足，不写入、不落盘。
 * Q1/F14：先在副本上应用变更并整批落盘，成功后才把内容发布回公共视图，落盘失败公共视图不变。
 */
function runMediaTaskUpdate(
  taskId: string,
  plan: (task: MediaTaskRecord, version: number) => ((task: MediaTaskRecord) => void) | undefined,
): Promise<MediaTaskRecord | undefined> {
  return (async () => {
    const batchId = batchOfTask.get(taskId);
    if (!batchId) return undefined;
    return withBatchChain(batchId, async () => {
      const batch = batches.get(batchId);
      const index = batch?.tasks.findIndex(task => task.taskId === taskId) ?? -1;
      const task = batch && index >= 0 ? batch.tasks[index] : undefined;
      if (!batch || !task) return undefined;
      const version = task.stateVersion;
      const apply = plan(task, version);
      if (!apply) return task;
      const candidate = structuredClone(task);
      apply(candidate);
      candidate.stateVersion = version + 1;
      candidate.updatedAt = new Date().toISOString();
      const batchCandidate: MediaTaskBatch = {
        ...batch,
        updatedAt: candidate.updatedAt,
        tasks: batch.tasks.map((item, position) => position === index ? candidate : item),
      };
      await persistBatchCounted(batchCandidate);
      // 发布：保持任务对象引用身份，只写入已落盘内容。
      Object.assign(task, candidate);
      batch.updatedAt = candidate.updatedAt;
      return task;
    });
  })();
}

export function updateMediaTask(
  taskId: string,
  plan: (task: MediaTaskRecord, version: number) => ((task: MediaTaskRecord) => void) | undefined,
): Promise<MediaTaskRecord | undefined> {
  return withMediaTaskLock(taskId, () => runMediaTaskUpdate(taskId, plan));
}

/**
 * 已持有该任务锁的协调外层专用（如目录改名的「先取任务锁 → 再取路径锁」顺序）：
 * 不重复获取任务锁，避免自锁；其他调用方一律使用 updateMediaTask。
 */
export function updateMediaTaskWithinLock(
  taskId: string,
  plan: (task: MediaTaskRecord, version: number) => ((task: MediaTaskRecord) => void) | undefined,
): Promise<MediaTaskRecord | undefined> {
  return runMediaTaskUpdate(taskId, plan);
}

/** 条件更新的「真正生效」结果：applied 只在 apply 确实执行且整批落盘成功时为 true。 */
export type MediaTaskConditionalUpdateResult = { applied: boolean; task?: MediaTaskRecord };

/**
 * 「本次条件更新是否真正生效」（T09）：不改变 updateMediaTask 的返回约定
 * （条件不成立时它仍返回原记录，调用方不能据此放行）。
 * 只有 plan 返回了 apply 且该次落盘成功（Promise 正常 resolve）才 applied=true；
 * plan 判定不成立或任务不存在时为 false；落盘失败的错误照常向上传播。
 */
export async function updateMediaTaskIfApplied(
  taskId: string,
  plan: (task: MediaTaskRecord, version: number) => ((task: MediaTaskRecord) => void) | undefined,
): Promise<MediaTaskConditionalUpdateResult> {
  let applied = false;
  const task = await updateMediaTask(taskId, (current, version) => {
    const apply = plan(current, version);
    if (!apply) return undefined;
    return record => {
      applied = true;
      apply(record);
    };
  });
  return { applied, ...(task ? { task } : {}) };
}

/** 与 updateMediaTaskWithinLock 对应的「真正生效」版本（调用方已持有该任务锁）。 */
export async function updateMediaTaskWithinLockIfApplied(
  taskId: string,
  plan: (task: MediaTaskRecord, version: number) => ((task: MediaTaskRecord) => void) | undefined,
): Promise<MediaTaskConditionalUpdateResult> {
  let applied = false;
  const task = await runMediaTaskUpdate(taskId, (current, version) => {
    const apply = plan(current, version);
    if (!apply) return undefined;
    return record => {
      applied = true;
      apply(record);
    };
  });
  return { applied, ...(task ? { task } : {}) };
}

/** 规范化 JSON（对象键排序），用于指纹计算。 */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function mediaTaskIdempotencyKey(directory: string, batchKey: string, itemKey: string) {
  return createHash("sha256").update(directory).update("\0").update(batchKey).update("\0").update(itemKey).digest("hex");
}

export function mediaTaskFingerprint(mediaType: MediaTaskMediaType, request: unknown, snapshots: MediaTaskInputSnapshot[]) {
  const references = snapshots.map(snapshot => `${snapshot.field}:${snapshot.index}:${snapshot.sha256}`).join(",");
  return createHash("sha256").update(mediaType).update("\0").update(canonicalJson(request)).update("\0").update(references).digest("hex");
}
