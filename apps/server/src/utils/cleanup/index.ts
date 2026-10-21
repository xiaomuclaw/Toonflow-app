import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { lstat, readFile, stat, unlink } from "@toonflow/file";
import conf from "@/utils/conf";
import {
  clearFileRecordCleanupIntent, clearFileRelocationIntent, confirmFileRecordCleaned, ensureFileRecordsLoaded,
  fileRecordPathKey, fileRecordsStoreHealth, fileRecordsStoreHealthSnapshot, findFileAncestorProtection, findFileIntentProtectionAtOrAbove, findFileRelocation,
  findFileRelocationIntentByTransactionId,
  getFileRecordsByPath, getFileRecordsUnder, isSameOrDescendantKey,
  isFileRegistrationProtected, isFileRelocationIntentProtected, lastEditingReleasedAt, listFileProtectionsUnder, listFileRecords,
  markFileRangeProtected, markFileRecordCleanupIntent, markFileRelocationIntent, migrateFileRecord, removeFileRecord,
  recoverPendingFileProtections, touchFileRecord,
} from "@/utils/fileRecords";
import type { FileProtection, FileRelocationIntent } from "@/utils/fileRecords";
import type { FileRecord } from "@/utils/fileRecords";
import { disposeEditingOccupancy, finalizeEditingOccupancyOnShutdown, getActiveEditingOccupancy, hasActiveEditingOccupancy, listActiveEditingUnder } from "@/utils/fileRecords/editing";
import { getMediaTasks, relocateMediaTaskOutput } from "@/utils/mediaTasks";
import { getMediaTask } from "@/utils/mediaTasks/store";import { isWithin, lockWorkspaceFiles, renameWorkspaceFile, resolveWorkspacePath } from "@/utils/workspace/files";

// T03：保护/归属就绪快照与编辑占用停机收尾对 Q/I 可用（isCleanupReady 语义不变，均为同步判据）。
// T15/§O.2：readiness 透出待处理改名意图（transactionId + 两端路径 + 原因）供诊断。
// §4.2：clearFileRelocationIntent 一并从本模块转出，供 Q 在 task.outputs 发布后解除延后的迁移意图。
export { clearFileRelocationIntent, fileRecordsReadinessSnapshot, fileRecordsStoreHealthSnapshot } from "@/utils/fileRecords";
export type { FileRecordsReadiness, FileRelocationIntentSummary } from "@/utils/fileRecords";
export { finalizeEditingOccupancyOnShutdown } from "@/utils/fileRecords/editing";

export const cleanupCategories = ["text", "image", "video", "original", "cache"] as const;
export type CleanupCategory = (typeof cleanupCategories)[number];

export type CleanupRule = { enabled: boolean; days: number };
export type CleanupSettings = Record<CleanupCategory, CleanupRule>;
export type CleanupSummary = { count: number; bytes: number };
export type CleanupPreview = { categories: Record<CleanupCategory, CleanupSummary>; total: CleanupSummary };
export type CleanupStatus = {
  lastRunAt: string;
  lastFreedBytes: number;
  lastFailures: number;
  lastDeleted: number;
  /** 本轮因路径锁忙而跳过的数量（不是失败，下一轮重新评估）。 */
  lastDeferred?: number;
  /** 本轮未能执行删除的原因（归属存储/恢复保护不可用等）。 */
  lastError?: string;
};
export type CleanupFailure = { path: string; reason: string };
export type CleanupRunResult = { deleted: number; freedBytes: number; failures: CleanupFailure[]; deferred: number; error?: string };

/**
 * 非单文件失败（整轮/运行中停止）在 failures 里的来源标记：此时 path 不是某个文件，而是可读来源说明，
 * 便于诊断区分「某个文件清理失败」与「整轮因存储/保护状态未知而停止」。
 */
const cleanupRunFailureSource = {
  store: "<归属/保护存储>",
  recovery: "<登记保护恢复>",
  midRun: "<清理运行>",
} as const;

const categoryLabels: Record<CleanupCategory, string> = { text: "生成文本", image: "生成图片", video: "生成视频", original: "原始资料", cache: "可再生成缓存" };
const categoryDefaultDays: Record<CleanupCategory, number> = { text: 2, image: 2, video: 2, original: 30, cache: 2 };
// ACT: 清理状态放在 conf 顶层而不是 settings 内，避免每小时写入触发设置 revision 变化和跨窗口保存冲突。
const cleanupStatusKey = "cleanupStatus";
const dayMs = 24 * 60 * 60 * 1000;
const maxDays = 3650;
const taskRefPrefix = "task:";
// ACT: 非终态 + unknown（待核对，不视为失败）都算占用；blocked/paused 由任务跟踪状态判断。
const occupiedTaskStates = new Set(["preparing", "queued", "submitting", "running", "downloading", "unknown"]);
const occupiedTrackingStatuses = new Set(["blocked", "paused"]);

export function defaultCleanupSettings(): CleanupSettings {
  return Object.fromEntries(cleanupCategories.map(category => [category, { enabled: false, days: categoryDefaultDays[category] }])) as CleanupSettings;
}

/** 读取当前清理设置：字段缺失或非法时退回默认值（enabled=false, 预填天数）。 */
export function readCleanupSettings(): CleanupSettings {
  const raw = conf.get("settings", {}).cleanup;
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const value = defaultCleanupSettings();
  for (const category of cleanupCategories) {
    const entry = source[category];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rule = entry as Record<string, unknown>;
    if (typeof rule.enabled === "boolean") value[category].enabled = rule.enabled;
    if (typeof rule.days === "number" && Number.isInteger(rule.days) && rule.days >= 1 && rule.days <= maxDays) value[category].days = rule.days;
  }
  return value;
}

/**
 * 校验待保存的 settings.cleanup：enabled 必须布尔；days 一旦提供必须是 1-3650 整数（关闭状态同样要求合法）。
 * 整个 cleanup 字段缺失时视为不校验（前端可能不传该字段），返回防御式默认值。
 */
export function validateCleanupSettings(settings: unknown): { ok: true; value: CleanupSettings } | { ok: false; message: string } {
  if (settings === undefined || settings === null) return { ok: true, value: defaultCleanupSettings() };
  if (typeof settings !== "object" || Array.isArray(settings)) return { ok: false, message: "清理设置必须是对象" };
  const source = settings as Record<string, unknown>;
  const value = defaultCleanupSettings();
  for (const category of cleanupCategories) {
    const entry = source[category];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, message: `${categoryLabels[category]}清理设置结构无效` };
    const rule = entry as Record<string, unknown>;
    if (Object.hasOwn(rule, "enabled")) {
      if (typeof rule.enabled !== "boolean") return { ok: false, message: `${categoryLabels[category]}清理开关必须是布尔值` };
      value[category].enabled = rule.enabled;
    }
    if (Object.hasOwn(rule, "days")) {
      const days = rule.days;
      if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > maxDays) {
        return { ok: false, message: `${categoryLabels[category]}保留天数必须是 1-3650 的整数` };
      }
      value[category].days = days;
    }
  }
  return { ok: true, value };
}

export function readCleanupStatus(): CleanupStatus | null {
  const raw = conf.get(cleanupStatusKey);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    lastRunAt: typeof value.lastRunAt === "string" ? value.lastRunAt : "",
    lastFreedBytes: typeof value.lastFreedBytes === "number" ? value.lastFreedBytes : 0,
    lastFailures: typeof value.lastFailures === "number" ? value.lastFailures : 0,
    lastDeleted: typeof value.lastDeleted === "number" ? value.lastDeleted : 0,
    ...(typeof value.lastDeferred === "number" ? { lastDeferred: value.lastDeferred } : {}),
    ...(typeof value.lastError === "string" && value.lastError ? { lastError: value.lastError } : {}),
  };
}

function writeCleanupStatus(status: CleanupStatus) {
  conf.set(cleanupStatusKey, status);
}

function categoryOf(record: FileRecord): CleanupCategory | undefined {
  if (record.sourceKind === "original") return "original";
  if (record.sourceKind === "cache") return "cache";
  if (record.sourceKind !== "generated") return undefined;
  return record.mediaKind === "text" || record.mediaKind === "image" || record.mediaKind === "video" ? record.mediaKind : undefined;
}

function cleanMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  return (message || fallback).slice(0, 300);
}

type TaskRef = { directory: string; taskId: string };
type TaskOccupancy = { occupied: boolean; releaseAt?: number };
type OccupancyLookup = Map<string, TaskOccupancy>;

function occupancyKey(directory: string, taskId: string) {
  return `${fileRecordPathKey(directory)}\u0000${taskId}`;
}

function taskReleaseAt(task: { completedAt?: string; updatedAt?: string }) {
  const value = Date.parse(task.completedAt ?? task.updatedAt ?? "");
  return Number.isNaN(value) ? undefined : value;
}

/**
 * 跟进状态补判：MediaTaskSummary 未暴露 trackingStatus 时直接读任务记录，
 * 保证 blocked/paused 任务所需数据即使主状态看似终态也不被清理（旧记录缺省 active）。
 */
function trackingStatusOf(taskId: string) {
  return getMediaTask(taskId)?.trackingStatus;
}

/**
 * T15：任务改名阻断（relocationBlocked，Q 持久写入的未完结迁移事实）必须被实际判定消费——
 * 输出定位不明的任务，其所需数据一律不清理（阻塞解除由任务层成功重试清空）。
 */
function relocationBlockedOf(taskId: string) {
  return getMediaTask(taskId)?.relocationBlocked;
}

/**
 * 任务占用查询：非终态、unknown 待核对、trackingStatus=blocked/paused 视为占用（保护其所需数据）；
 * 查询失败保守按占用处理；终态任务返回占用解除时间，作为成片保留期的较晚起点。
 */
async function resolveTaskOccupancy(refs: TaskRef[]): Promise<OccupancyLookup> {
  const result: OccupancyLookup = new Map();
  if (!refs.length) return result;
  const byDirectory = new Map<string, string[]>();
  for (const { directory, taskId } of refs) {
    const list = byDirectory.get(directory);
    if (list) list.push(taskId);
    else byDirectory.set(directory, [taskId]);
  }
  for (const [directory, taskIds] of byDirectory) {
    for (let offset = 0; offset < taskIds.length; offset += 100) {
      const chunk = taskIds.slice(offset, offset + 100);
      try {
        const data = await getMediaTasks({ directory, taskIds: chunk });
        for (const task of data.tasks) {
          const declared = (task as { trackingStatus?: unknown }).trackingStatus;
          const trackingStatus = typeof declared === "string" ? declared : trackingStatusOf(task.taskId);
          const blocked = !!relocationBlockedOf(task.taskId);
          const occupied = occupiedTaskStates.has(task.state)
            || (typeof trackingStatus === "string" && occupiedTrackingStatuses.has(trackingStatus))
            || blocked;
          result.set(occupancyKey(directory, task.taskId), occupied ? { occupied: true } : { occupied: false, releaseAt: taskReleaseAt(task) });
        }
      } catch (error) {
        console.warn(`清理候选任务状态查询失败，已跳过相关文件：${directory}`, error);
        for (const taskId of chunk) result.set(occupancyKey(directory, taskId), { occupied: true });
      }
    }
  }
  return result;
}

type GroupClaim = { record: FileRecord; category: CleanupCategory };
type GroupClaims =
  | { status: "ok"; claims: GroupClaim[]; taskRefs: TaskRef[] }
  /** 存在无类别归属（生成音频、未知来源等）：永不自动清理，并阻止同路径其他归属被删除。 */
  | { status: "unmanaged" }
  /** task 引用格式异常：本轮保守跳过。 */
  | { status: "malformed" };

function collectTaskRefsOf(records: FileRecord[]): { refs: TaskRef[]; malformed: boolean } {
  const refs: TaskRef[] = [];
  for (const record of records) {
    for (const ref of record.refs) {
      if (!ref.startsWith(taskRefPrefix)) continue;
      const taskId = ref.slice(taskRefPrefix.length).trim();
      if (!taskId) return { refs, malformed: true };
      refs.push({ directory: record.directory, taskId });
    }
  }
  return { refs, malformed: false };
}

function claimsOf(records: FileRecord[]): GroupClaims {
  const claims: GroupClaim[] = [];
  for (const record of records) {
    const category = categoryOf(record);
    if (category === undefined) return { status: "unmanaged" };
    claims.push({ record, category });
  }
  const refs = collectTaskRefsOf(records);
  if (refs.malformed) return { status: "malformed" };
  return { status: "ok", claims, taskRefs: refs.refs };
}

/**
 * 保留期起点：登记（落盘/导入/修改）时间、引用任务最后解除占用时间、编辑占用最后实际解除时间（持久）的较晚者；
 * 重启丢租约但持久释放时间保留；普通预览不改变该值。
 */
async function retentionStart(record: FileRecord, occupancy: OccupancyLookup) {
  const updatedAt = Date.parse(record.updatedAt);
  let start = Number.isNaN(updatedAt) ? 0 : updatedAt;
  for (const ref of record.refs) {
    if (!ref.startsWith(taskRefPrefix)) continue;
    const entry = occupancy.get(occupancyKey(record.directory, ref.slice(taskRefPrefix.length).trim()));
    if (entry && !entry.occupied && entry.releaseAt !== undefined) start = Math.max(start, entry.releaseAt);
  }
  const releasedAt = await lastEditingReleasedAt(record.path);
  const released = releasedAt ? Date.parse(releasedAt) : Number.NaN;
  if (!Number.isNaN(released)) start = Math.max(start, released);
  return start;
}

type GroupInspection = { status: "ready"; size: number } | { status: "missing" } | { status: "changed" } | { status: "blocked"; reason: string };

/** 删除前重校验：文件存在、仍在工作区内且非符号链接、stat 与全部归属记录的 version 一致。 */
async function inspectGroup(records: FileRecord[]): Promise<GroupInspection> {
  const record = records[0];
  if (!record) return { status: "missing" };
  let target: { directory: string; path: string };
  try {
    target = await resolveWorkspacePath(record.directory, relative(record.directory, record.path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "blocked", reason: cleanMessage(error, "路径校验失败") };
  }
  let info;
  try {
    info = await lstat(target.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "blocked", reason: cleanMessage(error, "无法读取文件信息") };
  }
  if (!info.isFile()) return { status: "blocked", reason: "目标不是普通文件" };
  // ACT: 时间戳转毫秒浮点在不同 stat 调用间可能偶发精度差；用 1ms 容差避免把未改动文件误判为外部改写（误判只会保守保留并重置计时）。
  const sameMoment = (a: number, b: number) => Math.abs(a - b) < 1;
  const changed = records.some(entry => entry.version.size !== info.size || !sameMoment(entry.version.mtimeMs, info.mtimeMs));
  return changed ? { status: "changed" } : { status: "ready", size: info.size };
}

type GroupEvaluation =
  | { status: "ready"; size: number; start: number }
  | { status: "missing" }
  | { status: "changed" }
  | { status: "blocked"; reason: string }
  /** 规则不允许或仍被占用：静默跳过，下轮按最新规则与占用状态重算。 */
  | { status: "held" };

/**
 * 单个物理路径的清理判定（扫描与删除前复核共用同一套规则）：
 * 全部归属类别开启且到期、无编辑占用/登记保护、无活跃/待核对/受阻任务占用、文件版本一致。
 * 删除意图（cleanupIntentAt）不构成删除依据：文件仍在时一律按最新天数重新计算。
 */
async function evaluateGroup(records: FileRecord[], settings: CleanupSettings, now: number, occupancy: OccupancyLookup): Promise<GroupEvaluation> {
  const claims = claimsOf(records);
  if (claims.status !== "ok") return { status: "held" };
  if (claims.claims.some(claim => !settings[claim.category].enabled)) return { status: "held" };
  const record = records[0]!;
  if (hasActiveEditingOccupancy(record.directory, record.path)) return { status: "held" };
  // T15/§O.2/§3.1：未完成改名事务意图对 source/target 两侧（含其后代）都按占用处理——意图存在期间
  // 这些路径不得被删除；这里直接保持（held），不参与“到期/按 updatedAt 重算保留期”策略。
  if (await isFileRelocationIntentProtected(record.path)) return { status: "held" };
  if (await isFileRegistrationProtected(record.path)) return { status: "held" };
  const occupied = claims.claims.some(({ record: claim }) => claim.refs.some(ref => ref.startsWith(taskRefPrefix)
    && occupancy.get(occupancyKey(claim.directory, ref.slice(taskRefPrefix.length).trim()))?.occupied === true));
  if (occupied) return { status: "held" };
  const starts: number[] = [];
  for (const { record: claim } of claims.claims) starts.push(await retentionStart(claim, occupancy));
  const anyCleaned = claims.claims.some(({ record: claim }) => !!claim.cleanedAt);
  const aged = claims.claims.every(({ category }, index) => now - starts[index]! >= settings[category].days * dayMs);
  // ACT: 无完成标记且未到期时先跳过（不查磁盘）；有完成标记时必须检查文件是否仍在（外部重建）。
  if (!anyCleaned && !aged) return { status: "held" };
  const inspection = await inspectGroup(records);
  if (inspection.status !== "ready") return inspection;
  // 已有完成标记但文件仍在（版本一致）：说明被外部重建，清除标记并重新计时。
  if (anyCleaned) return { status: "changed" };
  if (!aged) return { status: "held" };
  return { status: "ready", size: inspection.size, start: Math.min(...starts) };
}

/** 单组判定：按最新归属与引用现查任务占用（用于删除前复核，保证与扫描同一套规则）。 */
async function evaluateRecords(records: FileRecord[], settings: CleanupSettings, now: number): Promise<GroupEvaluation> {
  const claims = claimsOf(records);
  if (claims.status !== "ok") return { status: "held" };
  return evaluateGroup(records, settings, now, await resolveTaskOccupancy(claims.taskRefs));
}

type CleanupGroup = { path: string; directory: string; size: number; category: CleanupCategory; records: FileRecord[]; start: number };

type CleanupScan = {
  /** 可删除候选（文件存在且 version 一致）。 */
  candidates: CleanupGroup[];
  /** 已到期但本轮不能删除：文件缺失清账、被外部改过重新计时、路径异常记录失败。 */
  skipped: { group: CleanupGroup; status: "missing" | "changed" | "blocked"; reason?: string }[];
};

/**
 * 候选计算：只扫归属记录（不扫磁盘目录推断）；同路径多归属必须全部满足各自类别条件。
 * 任务占用先按工作区分批查询一次，避免逐文件查任务。
 */
async function scanCleanup(settings: CleanupSettings): Promise<CleanupScan> {
  const all = await listFileRecords();
  const now = Date.now();
  const groups = new Map<string, FileRecord[]>();
  for (const record of all) {
    const key = fileRecordPathKey(record.path);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  const prepared: { records: FileRecord[]; claims: Extract<GroupClaims, { status: "ok" }> }[] = [];
  const taskRefs: TaskRef[] = [];
  for (const group of groups.values()) {
    const claims = claimsOf(group);
    if (claims.status !== "ok") continue;
    if (claims.claims.some(claim => !settings[claim.category].enabled)) continue;
    prepared.push({ records: group, claims });
    taskRefs.push(...claims.taskRefs);
  }
  const occupancy = await resolveTaskOccupancy(taskRefs);
  const scan: CleanupScan = { candidates: [], skipped: [] };
  for (const { records, claims } of prepared) {
    const evaluation = await evaluateGroup(records, settings, now, occupancy);
    const first = records[0]!;
    const entry: CleanupGroup = {
      path: first.path,
      directory: first.directory,
      size: evaluation.status === "ready" ? evaluation.size : 0,
      category: claims.claims[0]!.category,
      records,
      start: evaluation.status === "ready" ? evaluation.start : 0,
    };
    if (evaluation.status === "ready") scan.candidates.push(entry);
    else if (evaluation.status === "missing") scan.skipped.push({ group: entry, status: "missing" });
    else if (evaluation.status === "changed") scan.skipped.push({ group: entry, status: "changed" });
    else if (evaluation.status === "blocked") scan.skipped.push({ group: entry, status: "blocked", reason: evaluation.reason });
  }
  // 最早到期的优先，保证单批上限下先后顺序稳定。
  scan.candidates.sort((left, right) => (left.start === right.start ? (left.path < right.path ? -1 : left.path > right.path ? 1 : 0) : left.start - right.start));
  return scan;
}

/** 候选概要；可选传入拟保存的清理设置，用于“先预览后保存”。缺省按当前保存的设置预览。 */
export async function previewCleanup(settings: CleanupSettings = readCleanupSettings()): Promise<CleanupPreview> {
  const { candidates } = await scanCleanup(settings);
  const categories = Object.fromEntries(cleanupCategories.map(category => [category, { count: 0, bytes: 0 }])) as Record<CleanupCategory, CleanupSummary>;
  const total: CleanupSummary = { count: 0, bytes: 0 };
  for (const candidate of candidates) {
    const summary = categories[candidate.category];
    summary.count += 1;
    summary.bytes += candidate.size;
    total.count += 1;
    total.bytes += candidate.size;
  }
  return { categories, total };
}

/**
 * 文件已不存在时：有删除意图（上次删除已发生）→ 确认 cleanedAt 并保留持久标记；
 * 无清理依据的外部缺失 → 清掉过期记录（消费方按 missing 表达，不伪装 cleaned）。
 * 工作区目录不可用时保留记录，避免整体误扫。
 */
async function sweepMissing(records: FileRecord[]) {
  const directory = records[0]?.directory;
  if (!directory || !(await stat(directory).then(info => info.isDirectory(), () => false))) return;
  if (records.some(record => record.cleanedAt)) return;
  if (records.some(record => record.cleanupIntentAt)) {
    // ACT: 意图存在而文件已缺失：确认上次真实删除已发生，转为完成标记。
    await confirmFileRecordCleaned(records[0]!.path);
    return;
  }
  await removeFileRecord(records[0]!.path);
}

/** 路径锁获取：忙视为本轮跳过（下一轮重新评估），不强制抢锁。 */
function tryLockWorkspaceFile(path: string): { release: () => void } | { busy: true } | { reason: string } {
  try {
    return { release: lockWorkspaceFiles([path]) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBUSY") return { busy: true };
    return { reason: cleanMessage(error, "无法锁定文件") };
  }
}

/**
 * §O.1 改名事务身份（Q/C 共用同一确定性 ID）：`relocate:<sha256(directory\0source\0target) 前 16 位>`。
 * 两端都用绝对路径计算；重启后无需额外传参即可重新算出同一 ID。
 * Q 可直接复用本导出函数计算并传入（勿另写一份公式，避免恢复时两侧 ID 不一致）。
 */
export function relocationTransactionId(directory: string, source: string, target: string) {
  const digest = createHash("sha256").update(`${resolve(directory)}\u0000${resolve(source)}\u0000${resolve(target)}`).digest("hex");
  return `relocate:${digest.slice(0, 16)}`;
}

/** 工作区相对路径归一化（与 Q 的 blockedRelocationTasks 判据同口径：正斜杠、去首 ./ 与尾斜杠）。 */
function normalizeWorkspaceRelative(directory: string, value: string) {
  const relativeValue = isAbsolute(value) ? relative(directory, value) : value;
  return relativeValue.replaceAll("\\", "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

/**
 * §O.3 同事务精确恢复识别：任务**仅**因「本次精确 source→target 的持久改名阻断」而占用时，
 * 且真实文件仍在 source、归属身份已由 expectRefs 核对（调用点在此之前完成），本次恢复必须放行——
 * 不得因该事务自身的阻断返回 EOCCUPIED。判据：
 * - 任务当前没有其他占用原因（非终态 state、blocked/paused 跟踪仍一律拒绝）；
 * - 任务的 relocationBlocked 的 source/target 与本次改名的相对路径完全一致；不同目标、其他事务、其他路径对一律拒绝。
 * 路径对一致 ⇒ 确定性事务 ID 一致（§O.1），因此不依赖 Q 是否已把 transactionId 写入阻断记录。
 */
function allowsSameTransactionRelocation(directory: string, taskId: string, source: string, target: string) {
  const task = getMediaTask(taskId);
  const block = task?.relocationBlocked;
  if (!task || !block) return false;
  if (occupiedTaskStates.has(task.state)) return false;
  if (typeof task.trackingStatus === "string" && occupiedTrackingStatuses.has(task.trackingStatus)) return false;
  return normalizeWorkspaceRelative(directory, block.source) === normalizeWorkspaceRelative(directory, source)
    && normalizeWorkspaceRelative(directory, block.target) === normalizeWorkspaceRelative(directory, target);
}

/**
 * 属于本次事务自身、且不含其他保护（范围保护/未完成登记围栏）的意图条目（§O.3）：
 * 精确重试与崩溃后续做可放行；带范围保护或登记围栏的条目仍按既有判据拒绝。
 */
function isOwnTransactionIntentFence(fence: FileProtection, transactionId: string) {
  return !!fence.relocationIntent && fence.relocationIntent.transactionId === transactionId
    && !fence.rangeReason && !fence.pendingRegistration;
}

export type RelocationFailureCode = "EINVALID" | "EBUSY" | "EOCCUPIED" | "ERECORDS" | "EMISSING" | "EEXIST" | "EIDENTITY";

/**
 * Q 返回「阻断类 EPARTIAL」的固定原因前缀（mediaTasks/index.ts 的阻断消费分支，该分支在搬动任何文件之前拒绝）。
 * 这是 Q/C 接缝标识：只有此前缀（且无本对路径的已记录迁移）才按“未搬动、账本一致”的纯阻断处理。
 * Q 若改动该文案，C 会回落到保守分支（建立范围保护），宁可多阻断也不漏保护——需在互审中同步。
 */
const blockedRelocationRefusalPrefix = "工作区内存在未完成的改名事务阻断";

export type RelocateWorkspaceResult =
  | {
      ok: true;
      migrated: number;
      recordIds: string[];
      refs: string[];
      from: string;
      to: string;
      /** 受影响归属记录的旧/新绝对路径（供任务输出精确定位；同一事务的持久结果）。 */
      paths: { from: string; to: string }[];
      /** 同一改名已由本进程完成（顺序多任务协调的重复调用）：文件未再次移动，仍返回同一 from/to。 */
      alreadyRelocated?: boolean;
      /**
       * §O.2：操作可视为已完成，但迁移意图保护清除失败时的如实说明
       * （「保护仍在，需清理核对」，可经 POST /api/cleanup/protections 显式核对后清理）。
       */
      warning?: string;
      /**
       * §O.2/§4.2（deferIntentRelease=true 且本次成功）：迁移意图**尚未清除**，由调用方在
       * 受影响 `task.outputs` 成功落盘后调用 `clearFileRelocationIntent(transactionId)` 解除；
       * 清除失败由调用方按 warning 透传。缺省（false）时本函数在提交后自行清除。
       */
      intentPending?: boolean;
      /** 任务协调外层已持久更新输出定位的任务（relocateWorkspacePathWithTasks 汇总）。 */
      updatedTasks?: string[];
      updatedOutputs?: number;
    }
  | {
      ok: false;
      code: RelocationFailureCode;
      message: string;
      /** Q 协调结果带出的如实说明（如意图清除失败），失败返回同样不得吞掉。 */
      warning?: string;
      /**
       * 失败但**真实文件/账本已确认回滚到源端**（migrate 失败后反向 rename 已落盘）。
       * 供 Q 的补偿收敛判定使用：不得因本次 ok:false 就当作目录未回滚（否则保留的意图无人释放）。
       * 仅在该确证回滚的分支为 true；可能已发布/位置不明时不设置。
       */
      rolledBack?: true;
    };

/** §P.3 内容身份上限：不超过该大小的常规文件记录 sha256；超限/目录/读取失败时按 size/mtime 核对。 */
const relocationBasisHashCapBytes = 32 * 1024 * 1024;

/** §P.3 内容身份（真实移动前计算）：仅对不超过上限的常规文件计算 sha256（避免大文件在改名路径上重复读盘）。 */
async function relocationContentIdentity(path: string, info: { size: number; isFile: () => boolean }): Promise<{ sha256?: string }> {
  if (!info.isFile() || info.size > relocationBasisHashCapBytes) return {};
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return {};
  return { sha256: createHash("sha256").update(bytes).digest("hex") };
}

/**
 * §P.3（R2）原意图核对：命中同 transactionId 的持久意图时，先按**原意图记录的**方向与 versionBasis 核对
 * 当前源端，不一致一律保守拒绝并说明差异；不得用重试时的当前文件覆盖 versionBasis 后放行。
 * - 方向：必须与意图方向一致，或为事务内位置互换（合法反搬 B→A，且可解释）——其他方向拒绝；
 * - size：硬性一致；
 * - 内容身份：意图记录了 sha256 时按真实文件内容硬性核对（源端变成非普通文件也视为不一致）；
 * - mtime：仅在「本事务此前从未真正搬动过这对路径」时硬性核对——真实改名对文件是 copy+unlink，会刷新
 *   mtime，合法反搬/续做不得被误伤；从未搬动过仍发生 mtime 变化 ⇒ 外部改写/替换；
 * - 记录 id：归属合并时 id 可合法变化，默认仅作为诊断随拒绝文案输出；**无任务身份约束的 fallback 改名**
 *   （未传 expectRefs）下记录 id 是唯一身份证据，与意图记录完全不相交时保守拒绝。
 */
async function verifyRelocationIntentConsistency(input: {
  intent: FileRelocationIntent;
  directory: string;
  source: string;
  target: string;
  expectRefs?: readonly string[];
  sourceInfo: { size: number; mtimeMs: number; isFile: () => boolean };
  records: FileRecord[];
}): Promise<string | undefined> {
  const samePath = (left: string, right: string) => fileRecordPathKey(resolve(left)) === fileRecordPathKey(resolve(right));
  const forward = samePath(input.intent.source, input.source) && samePath(input.intent.target, input.target);
  const reverse = samePath(input.intent.source, input.target) && samePath(input.intent.target, input.source);
  if (!forward && !reverse) {
    return `本次改名与同事务原意图记录的方向不一致（原意图：${input.intent.source} → ${input.intent.target}；本次：${input.source} → ${input.target}），已保守拒绝移动`;
  }
  const basis = input.intent.versionBasis;
  if (!basis) return undefined;
  const differences: string[] = [];
  if (basis.size !== input.sourceInfo.size) differences.push(`size 原意图=${basis.size} 当前=${input.sourceInfo.size}`);
  if (basis.sha256) {
    if (!input.sourceInfo.isFile()) {
      differences.push("原意图记录为常规文件，当前源端不是常规文件（可能已被目录/其他类型替换）");
    } else {
      const actual = await readFile(input.source).then(bytes => createHash("sha256").update(bytes).digest("hex"), () => undefined);
      if (actual === undefined) differences.push("当前文件内容无法读取，无法核对内容身份");
      else if (actual !== basis.sha256) differences.push(`内容 sha256 与原意图不符（原意图=${basis.sha256.slice(0, 12)}… 当前=${actual.slice(0, 12)}…）`);
    }
  }
  const logRefs = input.intent.refs.filter(ref => !ref.startsWith("record:"));
  const relocatedBefore = logRefs.length > 0
    && !!((await findFileRelocation(input.directory, input.intent.source, input.intent.target, logRefs))
      || (await findFileRelocation(input.directory, input.intent.target, input.intent.source, logRefs)));
  if (!relocatedBefore && Math.abs(basis.mtimeMs - input.sourceInfo.mtimeMs) >= 1) {
    differences.push(`mtime 原意图=${new Date(basis.mtimeMs).toISOString()} 当前=${new Date(input.sourceInfo.mtimeMs).toISOString()}`);
  }
  if (!differences.length) return undefined;
  const currentIds = new Set(input.records.map(record => record.id));
  const idMismatch = basis.recordIds.length > 0 && currentIds.size > 0 && !basis.recordIds.some(id => currentIds.has(id));
  const idNote = idMismatch
    ? `；记录身份也不一致（原意图=${basis.recordIds.map(id => id.slice(0, 8)).join("、")}，当前=${[...currentIds].map(id => id.slice(0, 8)).join("、")}）`
    : "";
  if (!differences.length) {
    // 无 expectRefs 的任务身份约束时，源端归属记录 id 是唯一身份证据：与意图记录完全不相交视为被替换。
    if (idMismatch && !input.expectRefs?.length) {
      return `源路径当前归属记录身份与同事务原意图不一致（可能是复用/替换后的其他文件）${idNote}；已保守拒绝移动，未覆盖原意图证据（需人工核对）`;
    }
    return undefined;
  }
  return `源路径与同事务原意图记录的版本依据不一致（可能已被外部替换或改写）：${differences.join("；")}${idNote}；已保守拒绝移动，未覆盖原意图证据（需人工核对后按原意图恢复真实文件，或经 POST /api/cleanup/protections 显式核对）`;
}

/**
 * §P.4 清除结果文案：成功但落盘未确认（清除可能已发布，不得宣称保护仍在）与失败（按 fileRecords 给出的
 * 分类说明：写入失败、保护仍在 / 结果未确认）分别组织可读前缀，供成功/失败出口如实透传。
 */
async function clearIntentOutcomeWarning(transactionId: string, prefix: string): Promise<string | undefined> {
  return clearFileRelocationIntent(transactionId).then(
    outcome => outcome.persistence === "unconfirmed"
      ? `${prefix}，但迁移意图清除落盘未确认（清除可能已发布、重启不再保留该屏障，需核对保护状态；可经 POST /api/cleanup/protections 核对）：${outcome.note ?? "保护表写入失败"}`
      : undefined,
    error => `${prefix}，但迁移意图清除未完成（${cleanMessage(error, "保护表写入失败")}）`,
  );
}

/**
 * 目录/文件真实改名（含终态任务输出改名）：
 * 锁顺序（唯一）：Q 任务协调外层先取受影响任务锁 → 本函数再一次取得源/目标路径锁 → fileRecords 串行落盘。
 * 锁内重查引用集合、编辑占用与登记保护：有活跃任务引用/编辑占用/未完成登记时拒绝移动；返回 refs/paths 供
 * 调用方更新任务输出定位（本函数不反向调用任务更新）。
 * 归属迁移 + 保护表 + 编辑释放时间 + 重定位日志在一个事务内持久提交（见 migrateFileRecord）；持久回滚失败返回明确阻断。
 * 同一改名已完成后（源不存在、目标存在、定位日志与目标归属可确认）重复调用返回 alreadyRelocated（幂等重试），
 * 不重复移动文件，也不把复用旧路径的新文件串到旧任务；expectRefs 可选身份约束（task:<taskId> 等）：
 * 源存在时要求源路径当前归属与 expectRefs 相交（否则返回 EIDENTITY，不认走复用旧路径的新文件）。
 * T16：源位于受保护目录（祖先保护）内时，目标必须仍在同一保护范围内，普通 rename 不得把文件移出保护。
 * T15/§O.2（先持久后移动）：真实 rename 之前先把带事务身份的持久意图写入保护表（source/target 两侧）；
 * 意图写入失败 ⇒ 不移动（明确错误，文件仍在 source）；提交（rename + 归属/释放时间/定位日志全部落盘）
 * 或回滚确认落盘后才清除意图；清除失败/清除落盘未确认按 §P.4 如实区分（不得绝对宣称保护仍在）。
 * §P.3（R2）：命中同事务原意图时先核原意图记录的方向与 versionBasis（size/内容身份，mtime 在本事务
 * 从未真正搬动过时核对），不一致保守拒绝并说明差异；不得用重试时的当前文件覆盖原证据；
 * 未完成事务的源/目标两端（含后代）由 fileRecords 的双端意图条目持续保护。
 * §4.2（deferIntentRelease）：任务协调调用方（Q）可要求把意图解除**延后到 task.outputs 发布确认之后**——
 * 本次成功时不清除意图，返回 `intentPending: true`，由调用方在 outputs 成功落盘后调用
 * `clearFileRelocationIntent(transactionId)`；缺省（false）保持提交后自清（fallback 直连等无 outputs 的场景）。
 * T15/§O.3（同事务精确恢复）：本次事务自身的意图/任务阻断（同一 transactionId 或同一精确 source→target）
 * 且身份已核对时不返回 EOCCUPIED，让精确恢复走完；其他任务占用、编辑租约、祖先保护、范围保护、
 * 其他事务保护一律仍然拒绝。
 */
export async function relocateWorkspacePath(input: {
  directory: string;
  source: string;
  target: string;
  expectRefs?: readonly string[];
  /**
   * T15/N.2：未协调 fallback 专用。为 true 时，源路径当前归属存在任务引用（或引用格式异常）一律拒绝：
   * 有任务引用的改名必须经任务输出协调（Q）完成，不得在任务锁外直接移动文件。
   */
  requireRefsEmpty?: boolean;
  /**
   * §O.3：Q 传入的确定性事务身份（应与 relocationTransactionId 计算结果一致）。
   * 缺省或空白时按 §O.1 由绝对路径重算——重启后重算结果一致，恢复不依赖额外传参。
   */
  transactionId?: string;
  /** §P.1：Q 传入的完整参与集合（本次 affected 任务 id，含已发布到目标的成员）；写入意图供收敛核对。 */
  participants?: readonly string[];
  /**
   * §4.2/Q 协调专用：为 true 且本次成功时**不清除**迁移意图，返回 intentPending=true，
   * 由调用方在受影响 task.outputs 成功落盘后调用 clearFileRelocationIntent(transactionId) 解除
   * （避免「C 已搬完文件、Q 尚未写完 outputs」的窗口内屏障被提前解除）。
   * 失败/回滚分支不受影响（一律保留意图）。
   */
  deferIntentRelease?: boolean;
}): Promise<RelocateWorkspaceResult> {
  const directory = resolve(input.directory);
  const source = resolve(input.source);
  const target = resolve(input.target);
  const transactionId = typeof input.transactionId === "string" && input.transactionId.trim()
    ? input.transactionId.trim()
    : relocationTransactionId(directory, source, target);
  if (!isWithin(directory, source) || !isWithin(directory, target)) {
    return { ok: false, code: "EINVALID", message: "只能操作当前工作区内的文件" };
  }
  let release: (() => void) | undefined;
  try {
    release = lockWorkspaceFiles([source, target]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBUSY") return { ok: false, code: "EBUSY", message: "文件正在使用，稍后重试" };
    throw error;
  }
  try {
    const sourceInfo = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!sourceInfo) {
      // 顺序多任务协调会重复调用同一改名：源已不在且能确认目标就是同一次改名的落点（重定位日志 +
      // 目标归属身份）时，按已完成确认，不重复移动文件也不把旧任务串到复用旧路径的新文件。
      const done = await findFileRelocation(directory, source, target, input.expectRefs);
      const targetInfo = await lstat(target).catch(() => null);
      const targetRecords = targetInfo ? await getFileRecordsUnder(target) : [];
      // T15：提供 expectRefs 时必须以期望身份核对目标归属；否则（日志无 refs 等）不能确认同一次改名。
      const identityConfirmed = !!done && (input.expectRefs?.length
        ? targetRecords.some(record => record.refs.some(ref => input.expectRefs!.includes(ref)))
        : (done.refs.length === 0 || targetRecords.some(record => record.refs.some(ref => done.refs.includes(ref)))));
      if (done && targetInfo && identityConfirmed) {
        // §O.2：该事务已由本进程确认为完成（幂等重试/顺序协调）⇒ 提交已确认；
        // §4.2：deferIntentRelease=true 时同样延后解除（由调用方在 outputs 发布后清除），此处不清意图。
        const deferred = input.deferIntentRelease === true;
        if (deferred) {
          return { ok: true, migrated: 0, recordIds: [], refs: done.refs, from: source, to: target, paths: [], alreadyRelocated: true, intentPending: true };
        }
        const warning = await clearIntentOutcomeWarning(transactionId, "改名事务已完成");
        return { ok: true, migrated: 0, recordIds: [], refs: done.refs, from: source, to: target, paths: [], alreadyRelocated: true, ...(warning ? { warning } : {}) };
      }
      // 第七轮缝3（提交续做，严格识别）：源端缺失、目标端存在，且**同 transactionId 的持久意图**在、目标侧
      // 归属记录携带与 input.expectRefs（或意图 refs，含 record:<id>）相交的身份时，按「真实改名已发生、
      // 归属迁移未完成」续做：复用 migrateFileRecord 完成源侧残留记录/释放时间迁移（沿用既有合并/回滚语义，
      // 不覆盖目标已有记录，不调用 mark、不改写原意图证据——target 端版本依据只来自意图原记录）。
      // 方向允许「原方向」与「事务内位置互换」（§P.3 合法反搬：反向补偿调用 Q 显式复用同一 transactionId，
      // 此时本函数源/目标恰为意图目标/源的互换）；两种方向都要求目标端归属身份相交，身份无法确认
      // （两处身份都为空或不相交）⇒ 维持 EMISSING 保守拒绝，不把复用旧路径的新文件串到旧事务。
      if (targetInfo) {
        const continuationIntent = await findFileRelocationIntentByTransactionId(transactionId);
        const samePath = (left: string, right: string) => fileRecordPathKey(resolve(left)) === fileRecordPathKey(resolve(right));
        const sameDirection = continuationIntent
          && samePath(continuationIntent.source, source) && samePath(continuationIntent.target, target);
        const swappedDirection = continuationIntent
          && samePath(continuationIntent.source, target) && samePath(continuationIntent.target, source);
        if (continuationIntent && (sameDirection || swappedDirection)) {
          const wantedRefs = new Set<string>([...(input.expectRefs ?? []), ...continuationIntent.refs]);
          const continuationIdentity = targetRecords.some(record =>
            record.refs.some(ref => wantedRefs.has(ref)) || wantedRefs.has(`record:${record.id}`));
          if (continuationIdentity) {
            try {
              const completed = await migrateFileRecord(source, target, { recordRelocation: { directory } });
              if (input.deferIntentRelease === true) {
                return {
                  ok: true, migrated: completed.migrated, recordIds: completed.recordIds, refs: completed.refs,
                  from: source, to: target, paths: completed.paths, alreadyRelocated: true, intentPending: true,
                };
              }
              const warning = await clearIntentOutcomeWarning(transactionId, "改名事务已完成（归属迁移收尾）");
              return {
                ok: true, migrated: completed.migrated, recordIds: completed.recordIds, refs: completed.refs,
                from: source, to: target, paths: completed.paths, alreadyRelocated: true, ...(warning ? { warning } : {}),
              };
            } catch (error) {
              const message = cleanMessage(error, "归属迁移收尾失败");
              if ((error as { code?: string }).code === "EROLLBACKFAILED") {
                // 账本可能半迁移：硬状态，建立持久范围保护并要求人工核对（真实文件已在目标端）。
                const protectedNote = await markFileRangeProtected([
                  { path: source, directory, reason: `改名已完成但归属迁移收尾失败且持久回滚未完成：${message}` },
                  { path: target, directory, reason: `改名已完成但归属迁移收尾失败且持久回滚未完成：${message}` },
                ]).then(() => "已确认持久保护", () => "范围保护持久化失败（本进程内已阻断，重启后保护是否仍在需恢复核对；可经 POST /api/cleanup/protections 显式核对）");
                return { ok: false, code: "ERECORDS", message: `改名已完成但归属迁移收尾失败且持久回滚未完成（${protectedNote}），迁移意图保护保留，需人工核对账本与文件位置（POST /api/cleanup/protections）：${message}` };
              }
              // 持久回滚已完成（账本仍在源侧）：意图与任务阻断仍是屏障，可再次以同一事务身份精确重试续做。
              return { ok: false, code: "ERECORDS", message: `改名已完成，归属迁移收尾失败（文件在目标位置，账本已回滚待重试）：${message}；可精确重试同一条 ${source} → ${target}（同一事务身份）完成收尾` };
            }
          }
        }
      }
      // §O.2 重启诊断：源缺失但仍有本事务的持久意图（例如 rename 已完成、归属迁移未完成）时，
      // 如实提示未完成事务与真实位置核对路径，不把「源文件不存在」当作干净状态。
      const pendingIntent = await findFileIntentProtectionAtOrAbove(source).then(entry => entry?.relocationIntent, () => undefined);
      const intentNote = pendingIntent && pendingIntent.transactionId === transactionId
        ? `；存在同一改名事务的未完成意图（${pendingIntent.source} → ${pendingIntent.target}，事务 ${pendingIntent.transactionId}），真实文件位置与账本需人工核对（核对后可经 POST /api/cleanup/protections 显式清理意图）`
        : "";
      return { ok: false, code: "EMISSING", message: `源文件不存在${intentNote}` };
    }
    const records = await getFileRecordsUnder(source);
    // T15/N.2：未协调 fallback 的原子守卫（路径锁内重查，堵住外层判定与移动之间的窗口）：
    // 源归属出现任务引用时必须回到任务协调，不得被未协调的移动绕过。
    if (input.requireRefsEmpty) {
      const refsNow = collectTaskRefsOf(records);
      if (refsNow.malformed || refsNow.refs.length) {
        return { ok: false, code: "EOCCUPIED", message: "源路径当前归属存在任务引用（或引用无法解析），必须经任务输出协调改名，已拒绝未协调的移动" };
      }
    }
    // T15：源存在时按 expectRefs 核对身份；当前归属与该身份无交集的（复用旧路径的新文件）不得被认走。
    if (input.expectRefs?.length) {
      const wanted = new Set(input.expectRefs);
      const confirmed = records.some(record => record.refs.some(ref => wanted.has(ref)));
      if (!confirmed) {
        return { ok: false, code: "EIDENTITY", message: "源路径当前归属与预期身份不一致（可能是复用旧路径的新文件），已保守拒绝移动" };
      }
    }
    // §P.3（R2）：命中同事务原意图时，先核**原意图记录的**方向与 versionBasis——不一致（外部替换/改写）
    // 保守拒绝并说明差异；不得用重试时的当前文件覆盖 versionBasis 后放行。
    const existingIntent = await findFileRelocationIntentByTransactionId(transactionId);
    if (existingIntent) {
      const inconsistency = await verifyRelocationIntentConsistency({
        intent: existingIntent, directory, source, target, expectRefs: input.expectRefs, sourceInfo, records,
      });
      if (inconsistency) return { ok: false, code: "EIDENTITY", message: inconsistency };
    }
    // T16：两端祖先保护核对——源在受保护目录内而目标移出该范围时拒绝（保护不会随普通改名失效）。
    const ancestorProtection = await findFileAncestorProtection(source);
    if (ancestorProtection) {
      const scopeKey = fileRecordPathKey(ancestorProtection.path);
      if (!isSameOrDescendantKey(scopeKey, fileRecordPathKey(target))) {
        const ancestorIntent = ancestorProtection.relocationIntent;
        const intentNote = ancestorIntent
          ? `；该范围存在未完成的改名事务（${ancestorIntent.source} → ${ancestorIntent.target}，事务 ${ancestorIntent.transactionId}）`
          : "";
        return {
          ok: false, code: "EOCCUPIED",
          message: `源位于受保护范围（${ancestorProtection.path}${ancestorProtection.rangeReason ? `：${ancestorProtection.rangeReason}` : ""}）内，移出范围会使文件失去保护${intentNote}，已保守拒绝移动`,
        };
      }
    }
    const editing = listActiveEditingUnder(directory, source);
    if (editing.length) return { ok: false, code: "EOCCUPIED", message: `正在编辑：${editing[0]!.path}` };
    // §O.3：本次事务自身的意图围栏（无范围保护/登记围栏、transactionId 一致）不阻断精确续做；
    // 其他事务的意图、范围保护、未完成登记围栏一律仍然拒绝。
    const fences = (await listFileProtectionsUnder(source)).filter(fence => !isOwnTransactionIntentFence(fence, transactionId));
    // §P.3/R1c 兜底（兼容升级前遗留的单端意图）：源路径命中某未完成事务记录的 source/target 端、而该条目
    // 不在本路径键/祖先上时（归属迁移曾把源端条目移走），同样按「其他事务的未完成保护」拒绝。
    const relatedIntentFence = await findFileIntentProtectionAtOrAbove(source);
    if (relatedIntentFence?.relocationIntent && !isOwnTransactionIntentFence(relatedIntentFence, transactionId)
      && !fences.some(fence => fileRecordPathKey(fence.path) === fileRecordPathKey(relatedIntentFence.path))) {
      fences.push(relatedIntentFence);
    }
    if (fences.length) {
      // N.2：范围保护/未完成登记围栏必须被实际判定消费——后续改名遇到阻断即拒绝并给出可读原因。
      const range = fences.find(fence => fence.rangeReason);
      if (range) {
        return { ok: false, code: "EOCCUPIED", message: `源路径存在持久范围保护：${range.rangeReason}（${range.path}），已保守拒绝移动` };
      }
      const pending = fences.find(fence => fence.pendingRegistration);
      if (pending) {
        return { ok: false, code: "EOCCUPIED", message: `存在未完成的归属登记保护：${pending.path}` };
      }
      const intent = fences.find(fence => fence.relocationIntent)?.relocationIntent;
      if (intent) {
        return {
          ok: false, code: "EOCCUPIED",
          message: `源路径存在未完成的改名事务保护（${intent.source} → ${intent.target}，事务 ${intent.transactionId}），保护仍在需清理核对，已保守拒绝移动`,
        };
      }
      return { ok: false, code: "EOCCUPIED", message: `存在未完成的归属登记保护：${fences[0]!.path}` };
    }
    // §O.3：目标端落入**其他**事务意图范围（含祖先与自身）时拒绝；本次事务自身的意图放行。
    const targetIntentFence = await findFileIntentProtectionAtOrAbove(target);
    if (targetIntentFence?.relocationIntent && targetIntentFence.relocationIntent.transactionId !== transactionId) {
      const intent = targetIntentFence.relocationIntent;
      return {
        ok: false, code: "EOCCUPIED",
        message: `目标路径处于其他未完成的改名事务保护范围内（${intent.source} → ${intent.target}，事务 ${intent.transactionId}），已保守拒绝移动`,
      };
    }
    const refs = collectTaskRefsOf(records);
    if (refs.malformed) return { ok: false, code: "EOCCUPIED", message: "存在无法解析的任务引用，已保守拒绝移动" };
    if (refs.refs.length) {
      const lookup = await resolveTaskOccupancy(refs.refs);
      const occupied = refs.refs.filter(ref => lookup.get(occupancyKey(ref.directory, ref.taskId))?.occupied === true);
      // §O.3 同事务识别：仅当本次带 expectRefs 且身份已核对（上文）时，任务**仅**因「本次精确
      // source→target 的持久改名阻断」而占用的按自身事实放行；其他占用原因、其他路径对仍拒绝。
      const allowOwnTransaction = !!input.expectRefs?.length;
      const blocking = occupied.filter(ref =>
        !(allowOwnTransaction && allowsSameTransactionRelocation(ref.directory, ref.taskId, source, target)));
      if (blocking.length) return { ok: false, code: "EOCCUPIED", message: `任务仍在跟进：${[...new Set(blocking.map(item => item.taskId))].join("、")}` };
    }
    // §O.2 核心（先持久后移动）：真实 rename 之前先把事务意图写入保护表（source/target 两侧）。
    // 写入失败 ⇒ 不移动（不得先移后补）；此时没有任何迁移发生，文件仍在 source。
    try {
      await markFileRelocationIntent({
        transactionId,
        directory,
        source,
        target,
        // §O.1 refs：本次涉及的记录引用身份（task:<id>、node:<id> 等）与记录身份（record:<id>）。
        refs: [...new Set([...records.flatMap(record => record.refs), ...records.map(record => `record:${record.id}`)])],
        // §P.1 参与集合：Q 传入的完整参与集合 ∪ C 侧从当前记录任务引用推导（mark 内并集合并、去重）。
        participants: [...new Set([
          ...(input.participants ?? []),
          ...records.flatMap(record => record.refs)
            .filter(ref => ref.startsWith(taskRefPrefix))
            .map(ref => ref.slice(taskRefPrefix.length).trim())
            .filter(Boolean),
        ])],
        versionBasis: {
          recordIds: records.map(record => record.id), size: sourceInfo.size, mtimeMs: sourceInfo.mtimeMs,
          // §P.3 内容身份：常规文件且不超过上限时记录 sha256（重试/恢复按真实内容核对，外部替换可被直接识别）。
          ...(await relocationContentIdentity(source, sourceInfo)),
        },
      });
    } catch (error) {
      return { ok: false, code: "ERECORDS", message: cleanMessage(error, "移动前迁移意图无法持久化，本次未移动文件（文件仍在原位）") };
    }
    try {
      await renameWorkspaceFile(source, target);
    } catch (error) {
      // rename 失败：提交未开始（真实文件未移动）。§P.2：协调路径（deferIntentRelease=true）下不得由 C
      // 自行解除唯一意图——保留原意图，由任务协调层在补偿收敛（含「从未移动」的平凡收敛）后清除；
      // fallback 直连路径（无任务参与）保持提交前自清语义（清除失败/落盘未确认如实透传）。
      let intentNote = "；迁移意图保留（提交未开始，文件仍在原位），由任务协调层在补偿收敛后解除";
      if (input.deferIntentRelease !== true) {
        const clearNote = await clearIntentOutcomeWarning(transactionId, "改名失败");
        intentNote = clearNote ? `；${clearNote}` : "";
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return { ok: false, code: "EEXIST", message: `${cleanMessage(error, "已存在同名文件或目录")}${intentNote}` };
      }
      throw error;
    }
    try {
      const result = await migrateFileRecord(source, target, { recordRelocation: { directory } });
      // §4.2：Q 协调调用方要求延后解除时，本次成功不清除意图——返回 intentPending=true，
      // 由调用方在受影响 task.outputs 成功落盘后调用 clearFileRelocationIntent(transactionId)；
      // 避免「C 已搬完文件、Q 尚未写完 outputs」窗口内磁盘失去屏障（三重连续写失败后重启不再丢保护）。
      if (input.deferIntentRelease === true) {
        return {
          ok: true, migrated: result.migrated, recordIds: result.recordIds, refs: result.refs,
          from: source, to: target, paths: result.paths, intentPending: true,
        };
      }
      // §O.2：提交（rename + 归属/释放时间/定位日志全部落盘）完成后才清除意图；
      // 清除失败/清除落盘未确认 ⇒ 保留（或如实示警未确认），操作可视为已完成但状态必须如实显示。
      const warning = await clearIntentOutcomeWarning(transactionId, "改名事务已完成");
      return { ok: true, migrated: result.migrated, recordIds: result.recordIds, refs: result.refs, from: source, to: target, paths: result.paths, ...(warning ? { warning } : {}) };
    } catch (error) {
      const message = cleanMessage(error, "归属迁移失败");
      if ((error as { code?: string }).code === "EROLLBACKFAILED") {
        // 持久回滚未完成：文件保持目标位置（与最近一次成功写出的账本一侧尽量一致），范围保护阻断清理并要求人工核对。
        // §O.2：回滚不完整 ⇒ 意图保留 + 持久故障并集（以更保守者为准）；不得在这里清除意图。
        const protectedNote = await markFileRangeProtected([
          { path: source, directory, reason: `归属迁移失败且持久回滚未完成：${message}` },
          { path: target, directory, reason: `归属迁移失败且持久回滚未完成：${message}` },
        ]).then(() => "已确认持久保护", () => "范围保护持久化失败（本进程内已阻断，重启后保护是否仍在需恢复核对；可经 POST /api/cleanup/protections 显式核对）");
        return { ok: false, code: "ERECORDS", message: `归属迁移失败且持久回滚未完成（${protectedNote}），迁移意图保护保留，需人工核对账本与文件位置（POST /api/cleanup/protections）：${message}` };
      }
      const rolledBack = await renameWorkspaceFile(target, source).then(() => true, () => false);
      if (rolledBack) {
        // 回滚确认落盘（账本由 migrateFileRecord 的持久回滚恢复、文件已搬回 source）。§P.2：协调路径
        // （deferIntentRelease=true）下不得由 C 自行解除唯一意图——保留原意图，由任务协调层在补偿收敛
        // （含「已回源端」的收敛）后清除；fallback 直连路径保持回滚确认后自清语义（清除结果按 §P.4 如实透传）。
        let intentNote = "；迁移意图保留（文件已回滚到原位），由任务协调层在补偿收敛后解除";
        if (input.deferIntentRelease !== true) {
          const clearNote = await clearIntentOutcomeWarning(transactionId, "归属迁移失败，文件操作已回滚");
          intentNote = clearNote ? `；${clearNote}` : "";
        }
        return { ok: false, code: "ERECORDS", message: `归属迁移失败，文件操作已回滚${intentNote}：${message}`, rolledBack: true };
      }
      const protectedNote = await markFileRangeProtected([
        { path: source, directory, reason: `归属迁移失败且回滚失败：${message}` },
        { path: target, directory, reason: `归属迁移失败且回滚失败：${message}` },
      ]).then(() => "已确认持久保护", () => "范围保护持久化失败（本进程内已阻断，重启后保护是否仍在需恢复核对；可经 POST /api/cleanup/protections 显式核对）");
      return { ok: false, code: "ERECORDS", message: `归属迁移失败且回滚失败（${protectedNote}），迁移意图保护保留，需人工核对：${message}` };
    }
  } finally {
    release?.();
  }
}

function relocationFailureCode(code: string | undefined): RelocationFailureCode {
  if (code === "EINVALID" || code === "EBUSY" || code === "EOCCUPIED" || code === "EMISSING" || code === "EEXIST" || code === "EIDENTITY") return code;
  // 互审：Q 的 ENOTFOUND（任务不存在）保留 404 语义（EMISSING→404），其余（EPARTIAL/ERECORDS 等）折叠为账本错误（500，消息原样透出）。
  if (code === "ENOTFOUND") return "EMISSING";
  return "ERECORDS";
}

/**
 * 任务输出改名协作入口（正式 rename 与 agent 工具改名统一走这里，不再直接调 relocateWorkspacePath）：
 * 锁序（N.2 唯一）：Q 的 `relocateMediaTaskOutput` 先按 taskId 字典序取任务锁 → C 的 relocateWorkspacePath
 * 在同一临界区取源/目标路径锁并完成文件+归属+定位事务 → Q 在任务锁内持久更新各任务 outputs 定位（发布）。
 * C 只用路径锁覆盖文件/归属/定位事务期间，不反向取任务锁，也不在任务锁外做未协调移动。
 * Q 因“没有任务 outputs 匹配源前缀”按其语义不移动文件时：仅当源归属**无任务引用**才允许兜底
 * （fallback 也必须先经任务协调；有任务引用说明定位与归属不一致，一律保守拒绝而不绕过）。
 * C 保持「取路径锁 + 文件操作 + 归属/定位持久化 + 返回受影响 refs/paths」语义，不直接更新任务记录。
 */
export async function relocateWorkspacePathWithTasks(input: { directory: string; source: string; target: string }): Promise<RelocateWorkspaceResult> {
  const directory = resolve(input.directory);
  const source = resolve(input.source);
  const target = resolve(input.target);
  if (!isWithin(directory, source) || !isWithin(directory, target)) {
    return { ok: false, code: "EINVALID", message: "只能操作当前工作区内的文件" };
  }
  const records = await getFileRecordsUnder(source);
  const collected = collectTaskRefsOf(records);
  if (collected.malformed) return { ok: false, code: "EOCCUPIED", message: "存在无法解析的任务引用，已保守拒绝移动" };
  const coordinated = await relocateMediaTaskOutput({ directory, source, target });
  if (!coordinated.ok) {
    if (coordinated.code === "EPARTIAL") {
      const reason = coordinated.reason ?? "";
      // T15/Q 互审：EPARTIAL 有两种语义，不能一律建立范围保护——
      // (a) 阻断类：Q 在搬动**之前**因“已有未完结改名阻断”拒绝，真实文件与账本未动。必须原样透传 Q 的
      //     可读原因（含“精确重试同一条 source→target 是允许的恢复路径”），不建立范围保护——否则该恢复
      //     重试会先被 C 的范围保护/围栏判据以 EOCCUPIED 挡死，恢复路径被自己的保护锁死。
      // (b) 回滚失败/补偿不足类：Q 已实际搬动过或已写入持久阻断，文件/账本可能不一致，必须建立持久范围保护。
      // 判据优先用结构事实：同一 source→target 的已记录迁移（重定位日志精确匹配）证明这一对路径被实际搬动过，
      // 直接按 (b) 处理；文本前缀只作为 (a) 的显式标识；无法识别的一律按 (b) 保守建立保护（宁可多阻断，
      // 显式核对入口 POST /api/cleanup/protections 可恢复），不冒漏保护的风险。
      const movedForThisPair = !!(await findFileRelocation(directory, source, target));
      if (!movedForThisPair && reason.startsWith(blockedRelocationRefusalPrefix)) {
        // 阻断类：不改文件、不建保护，把 Q 的原因与恢复指引原样交给调用方（409 冲突语义）。
        return { ok: false, code: "EOCCUPIED", message: reason };
      }
      // (b) 补偿不足类：按真实文件位置区分（互审 P4 / 第七轮缝2）：
      // - 「目录改名已回滚（源端在、目标端不在），仅任务 outputs 回滚不完整」：文件/账本一致，**不建立范围保护**——
      //   否则精确重试会被自身范围保护以 EOCCUPIED 挡死、人工核对又被 §P.2 事务活动判定 409，两条恢复路径互锁
      //   （违反验收 §4 矩阵第 4 行）。双端持久意图 + Q 的持久阻断仍是屏障：清理被意图保护拦、覆盖写被
      //   findFileRelocationWriteBlock 拦、精确重试（同一事务身份）被本事务意图围栏放行、其他事务/保护仍拒绝。
      // - 其余硬状态（仅目标端在 / 两端都在 / 两端都不在 / 存在性未知）：文件与账本一致性无法确认，
      //   保留**持久**范围保护并要求人工核对（显式核对入口可恢复）；范围保护写不进去时只能保证「本进程已阻断」，
      //   不得宣称跨重启已保证——文案如实区分并给出恢复路径（§6.2/§O.3）。
      const presence = (path: string) => lstat(path).then(() => true as const, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false as const : undefined);
      const [sourcePresent, targetPresent] = await Promise.all([presence(source), presence(target)]);
      const directoryRolledBack = sourcePresent === true && targetPresent === false;
      const unknownPaths = [...(sourcePresent === undefined ? [source] : []), ...(targetPresent === undefined ? [target] : [])];
      const directoryState = directoryRolledBack
        ? `目录改名已回滚（真实文件在源位置 ${source}），任务 outputs 回滚不完整`
        : sourcePresent === false && targetPresent === true
          ? `目录回滚失败（真实文件在目标位置 ${target}，源位置已不存在）`
          : sourcePresent === true && targetPresent === true
            ? `源与目标两端路径同时存在（${source} 与 ${target}），目录真实位置需人工核对`
            : sourcePresent === false && targetPresent === false
              ? `源与目标均不存在，目录真实位置需人工核对`
              : `源/目标存在性无法确认（${unknownPaths.join("、")}），需人工核对`;
      const recoveryNote = `恢复路径：精确重试同一条 ${source} → ${target}（同一事务身份）以完成提交，或人工核对后经 POST /api/cleanup/protections 显式清理${directoryRolledBack ? "迁移意图" : "范围保护与迁移意图"}`;
      if (directoryRolledBack) {
        // 文件/账本一致且仍有双端意图 + 任务阻断：不建立范围保护，保留自动收敛通道（见上）。
        return {
          ok: false, code: "ERECORDS",
          message: `任务输出定位更新失败（${directoryState}；真实文件与账本一致，未建立范围保护：双端迁移意图与任务阻断仍为持久屏障）；${recoveryNote}：${reason}`,
        };
      }
      const protectionReason = `多任务输出定位更新失败：${directoryState}：${reason}`;
      const note = await markFileRangeProtected([
        { path: source, directory, reason: protectionReason },
        { path: target, directory, reason: protectionReason },
      ]).then(() => "已确认持久范围保护", () => "范围保护持久化失败（本进程内已阻断，重启后保护是否仍在需恢复核对；可经 POST /api/cleanup/protections 显式核对）");
      return { ok: false, code: "ERECORDS", message: `任务输出定位更新失败（${directoryState}；${note}）；${recoveryNote}：${reason}` };
    }
    return { ok: false, code: relocationFailureCode(coordinated.code), message: coordinated.reason ?? "任务输出定位更新失败" };
  }
  const updatedTasks = (coordinated.tasks ?? []).map(task => task.taskId);
  const updatedOutputs = coordinated.updated ?? 0;
  const sourceInfo = await lstat(source).catch(() => null);
  if (sourceInfo) {
    // T15/N.2：Q 未发现受影响任务时不得直接绕过任务协调。源归属存在任务引用说明任务定位与归属不一致
    // （可能正处于 outputs 发布前的窗口），必须保守拒绝；只有无任务引用的普通文件才允许路径锁内的直接事务。
    if (collected.refs.length) {
      return {
        ok: false, code: "EOCCUPIED",
        message: "源路径存在任务引用但任务层未确认本次改名（任务定位与归属不一致），已保守拒绝未协调的移动",
      };
    }
    // 兜底：普通文件在路径锁内直接完成事务；requireRefsEmpty 在锁内再复核一次，堵住判定与移动之间的窗口。
    const fallback = await relocateWorkspacePath({ directory, source, target, requireRefsEmpty: true });
    if (!fallback.ok) return fallback;
    // §O.2 文案透传：本函数所有 ok 返回都不得吞掉 warning（「保护仍在，需清理核对」必须到路由响应）；
    // 兜底事务自身的 warning 与 Q 协调结果的 warning 都保留（两者同时存在时合并，不丢任一事实）。
    const fallbackWarning = [fallback.warning, coordinated.warning].filter((note): note is string => !!note).join("；");
    return {
      ...fallback,
      ...(updatedTasks.length ? { updatedTasks, updatedOutputs } : {}),
      ...(fallbackWarning ? { warning: fallbackWarning } : {}),
    };
  }
  const targetInfo = await lstat(target).catch(() => null);
  if (!targetInfo) {
    // 互审 6：源与目标均不存在时同样不得吞掉 Q 协调结果的如实说明（如意图清除失败/保护仍在）。
    return { ok: false, code: "EMISSING", message: "源文件不存在", ...(coordinated.warning ? { warning: coordinated.warning } : {}) };
  }
  // 汇总视图按迁移前的归属账本投影（与 migrateFileRecord 的路径映射一致；合并到目标同名归属时记录 id 以目标为准）。
  const projected = records
    .map(record => {
      const suffix = relative(source, record.path);
      return { record, newAbs: suffix ? resolve(target, suffix) : target };
    })
    .filter(({ record, newAbs }) => isWithin(record.directory, newAbs) && fileRecordPathKey(newAbs) !== fileRecordPathKey(record.path));
  return {
    ok: true,
    migrated: projected.length,
    recordIds: projected.map(({ record }) => record.id),
    refs: [...new Set(collected.refs.map(ref => ref.taskId))].map(taskId => `task:${taskId}`),
    from: source,
    to: target,
    paths: projected.map(({ record, newAbs }) => ({ from: record.path, to: newAbs })),
    updatedTasks,
    updatedOutputs,
    // §O.2：Q 协调结果（含 alreadyRelocated 语义的路径）带出的 warning 原样透传到路由响应。
    ...(coordinated.warning ? { warning: coordinated.warning } : {}),
  };
}

/* ------------------------------------------------------------------ 运行与停止 */

// 停机协调：beginCleanupStopping 置门后不再派发新一轮；stopCleanupScheduler 等待在途批次收敛（有超时保护）。
let stopping = false;
let initialized = false;
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
let activeRun: Promise<CleanupRunResult> | undefined;

/**
 * 恢复保护/归属存储是否可用（T03：false 时不得执行删除，也不得放行新收费生成派发；
 * I 的 health 路由、Q 的生成准入与停机门共用）。保护表状态未知、释放时间表故障、归属存储未加载
 * 或加载失败一律 false；同步可诊断细节见 fileRecordsReadinessSnapshot()。
 */
export function isCleanupReady(): boolean {
  const health = fileRecordsStoreHealthSnapshot();
  if (!health.ok) void ensureFileRecordsLoaded().catch(() => undefined);
  return health.ok;
}

/** 置停止门：停止派发新一轮清理并清周期 timer（同步、幂等）。 */
export function beginCleanupStopping(): void {
  stopping = true;
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = undefined;
  }
}

/** 等待当前清理批次收敛后返回（内部超时保护；不在途时立即返回）。停机收尾在此时持久写入编辑占用解除时间。 */
export async function stopCleanupScheduler(timeoutMs = 30_000): Promise<void> {
  beginCleanupStopping();
  // T14：活动租约只存内存，停机前必须把「最后实际保护解除时间」持久化（重启后重算完整保留期），
  // 失败只记录不阻断停机主流程（无该写入则重启后保护窗口可能被缩短，属保守性缺口）。
  await finalizeEditingOccupancyOnShutdown().catch(error => console.warn("[停机] 编辑占用解除时间持久化失败", error));
  const run = activeRun;
  if (!run) return;
  await Promise.race([
    run.then(() => undefined, () => undefined),
    new Promise<void>(resolvePromise => {
      const timer = setTimeout(resolvePromise, Math.max(0, timeoutMs));
      timer.unref?.();
    }),
  ]);
}

/**
 * 执行一轮清理：只处理 enabled 的类别；先恢复未完成的登记保护，再扫描候选。
 * 删除流程：路径锁内重读最新规则/全部归属/版本/任务与编辑占用 → 写持久删除意图 → 删除 → 确认 cleanedAt；
 * 删除失败清除意图，下轮按最新天数与占用重算（旧意图不构成删除依据）。
 * 锁忙跳过本轮（deferred）；归属存储或保护不可用时整轮不删并暴露错误。
 * force 放开单批 500 条上限（供人工/验收即时运行），其余安全检查不变。
 * 在途批次被跟踪：stopCleanupScheduler 会等待其收敛（含超时保护）。
 */
export function runCleanup(force = false): Promise<CleanupRunResult> {
  if (stopping) return Promise.resolve({ deleted: 0, freedBytes: 0, failures: [], deferred: 0 });
  const run = executeCleanupRun(force);
  activeRun = run;
  const settle = () => {
    if (activeRun === run) activeRun = undefined;
  };
  void run.then(settle, settle);
  return run;
}

async function executeCleanupRun(force: boolean): Promise<CleanupRunResult> {
  if (stopping) return { deleted: 0, freedBytes: 0, failures: [], deferred: 0 };
  const health = await fileRecordsStoreHealth().catch(error => ({ ok: false as const, error: cleanMessage(error, "文件归属存储不可用") }));
  if (!health.ok) {
    const message = health.error ?? "文件归属存储不可用";
    writeCleanupStatus({ lastRunAt: new Date().toISOString(), lastFreedBytes: 0, lastFailures: 1, lastDeleted: 0, lastDeferred: 0, lastError: message });
    return { deleted: 0, freedBytes: 0, failures: [{ path: cleanupRunFailureSource.store, reason: message }], deferred: 0, error: message };
  }
  const failures: CleanupFailure[] = [];
  // ACT: 未完成登记保护先于删除恢复；恢复失败的路径保留围栏，本轮及以后都不会被删除。
  // 跳过项为正在写入的 live guard（持路径锁或进程内未完成），不是失败，仅计数展示。
  const recovery = await recoverPendingFileProtections().catch(error => ({ recovered: 0, failed: [{ path: cleanupRunFailureSource.recovery, reason: cleanMessage(error, "登记保护恢复失败") }], skipped: [] as string[] }));
  for (const item of recovery.failed) failures.push({ path: item.path, reason: `待恢复登记未完成：${item.reason}` });
  const settings = readCleanupSettings();
  if (!cleanupCategories.some(category => settings[category].enabled)) {
    return { deleted: 0, freedBytes: 0, failures, deferred: 0 };
  }
  // ACT: 单批上限 500 条，避免一次扫删阻塞正常生成；剩余候选下一轮继续。
  const batchLimit = force ? Number.POSITIVE_INFINITY : 500;
  const scan = await scanCleanup(settings);
  let deleted = 0;
  let freedBytes = 0;
  let processed = 0;
  let deferred = recovery.skipped.length;
  // 到期但不能删除的：锁内重查（文件仍缺失→意图确认/清账；仍被改过→清除标记重新计时）。
  for (const { group } of scan.skipped) {
    if (processed >= batchLimit) break;
    processed += 1;
    const lock = tryLockWorkspaceFile(group.path);
    if ("busy" in lock) { deferred += 1; continue; }
    if ("reason" in lock) { failures.push({ path: group.path, reason: lock.reason }); continue; }
    try {
      const freshRecords = await getFileRecordsByPath(group.path);
      if (!freshRecords.length) continue;
      const inspection = await inspectGroup(freshRecords);
      if (inspection.status === "missing") await sweepMissing(freshRecords);
      else if (inspection.status === "changed") await touchFileRecord(group.path, { cleanedAt: null });
      else if (inspection.status === "blocked") failures.push({ path: group.path, reason: inspection.reason });
      // 变为 ready：本轮不删除，下一轮按最新候选重新评估。
    } catch (error) {
      failures.push({ path: group.path, reason: cleanMessage(error, "清理失败") });
    } finally {
      lock.release();
    }
  }
  for (const candidate of scan.candidates) {
    if (processed >= batchLimit) break;
    // T03：归属/保护状态在本次运行中变为未知（并发迁移回滚失败、保护标记写失败等）时立即停止剩余删除，
    // 不得以扫描时的旧结论继续删（已删除项保留完成标记，账本未知部分由显式核对恢复）。
    if (!fileRecordsStoreHealthSnapshot().ok) {
      failures.push({ path: cleanupRunFailureSource.midRun, reason: "归属/保护状态在清理运行中变为未知，已停止本轮剩余删除" });
      break;
    }
    processed += 1;
    const lock = tryLockWorkspaceFile(candidate.path);
    if ("busy" in lock) { deferred += 1; continue; }
    if ("reason" in lock) { failures.push({ path: candidate.path, reason: lock.reason }); continue; }
    try {
      // ACT: 删除前在同一协调边界内重读规则、全部归属与引用/任务/编辑占用，再重查版本；任一不满足即跳过本轮。
      const freshRecords = await getFileRecordsByPath(candidate.path);
      if (!freshRecords.length) continue;
      const evaluation = await evaluateRecords(freshRecords, readCleanupSettings(), Date.now());
      if (evaluation.status === "held") continue;
      if (evaluation.status === "missing") {
        await sweepMissing(freshRecords);
        continue;
      }
      if (evaluation.status === "changed") {
        // 文件在被扫描后被外部修改：清除清理标记、刷新版本并重新计时，本轮不删除。
        await touchFileRecord(candidate.path, { cleanedAt: null });
        continue;
      }
      if (evaluation.status === "blocked") {
        failures.push({ path: candidate.path, reason: evaluation.reason });
        continue;
      }
      // ACT: 删除前在同一路径锁内最后重读编辑占用与版本；续租/释放持同一路径锁，检查后到 unlink 之间不再有窗口。
      const occupancyEntry = getActiveEditingOccupancy(candidate.directory, candidate.path);
      if (occupancyEntry) continue;
      await markFileRecordCleanupIntent(candidate.path);
      try {
        await unlink(candidate.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // 已被外部删除：意图确认删除已发生，保留完成标记。
          await confirmFileRecordCleaned(candidate.path);
          continue;
        }
        // 删除失败：清除删除意图，下轮按最新天数与占用重算（旧意图不得绕过延长后的期限）。
        await clearFileRecordCleanupIntent(candidate.path).catch(() => undefined);
        failures.push({ path: candidate.path, reason: cleanMessage(error, "删除失败") });
        continue;
      }
      // ACT: 删除成功后保留记录并写完成标记（不立即清账），供任务输出与节点显示“已清理”。
      await confirmFileRecordCleaned(candidate.path);
      deleted += 1;
      freedBytes += evaluation.size;
    } catch (error) {
      failures.push({ path: candidate.path, reason: cleanMessage(error, "清理失败") });
    } finally {
      lock.release();
    }
  }
  writeCleanupStatus({
    lastRunAt: new Date().toISOString(), lastFreedBytes: freedBytes, lastFailures: failures.length,
    lastDeleted: deleted, lastDeferred: deferred, ...(failures.length ? { lastError: failures[0]!.reason } : {}),
  });
  return { deleted, freedBytes, failures, deferred };
}

const firstRunDelayMs = 60 * 1000;
const runIntervalMs = 60 * 60 * 1000;

/** 服务启动入口（由 app.ts 调用）：60 秒后首轮，此后每 60 分钟一轮；单实例。 */
export function initializeCleanup() {
  if (initialized || stopping) return;
  initialized = true;
  // ACT: 启动即尝试加载归属存储与保护记录，让 isCleanupReady 尽快反映真实就绪状态。
  void ensureFileRecordsLoaded().catch(error => console.warn("文件归属存储加载失败", error));
  scheduleCleanupRun(firstRunDelayMs);
}

function scheduleCleanupRun(delayMs: number) {
  if (stopping) return;
  cleanupTimer = setTimeout(() => {
    cleanupTimer = undefined;
    void runCleanup()
      .catch(error => console.warn("自动清理执行失败", error))
      .finally(() => {
        if (!stopping) scheduleCleanupRun(runIntervalMs);
      });
  }, delayMs);
  cleanupTimer.unref?.();
}

/** 兼容入口：等价 beginCleanupStopping + 释放编辑占用巡检（旧调用方可继续使用）。 */
export function stopCleanup() {
  beginCleanupStopping();
  disposeEditingOccupancy();
}
