import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, mkdir, readFile, realpath, rename, stat, writeAtomic } from "@toonflow/file";
import conf from "@/utils/conf";
// §P.2 活动边界②：显式核对前按最新任务账本核对参与集合是否收敛。
// 只依赖 mediaTasks 的叶子存储模块（store.ts 不反向 import fileRecords/cleanup，无循环依赖；Q 的运行时
// 活动判定 isRelocationTransactionActive 另经动态 import 读取，见 relocationRuntimeActivityProbe）。
import { effectiveRelocationBlock, ensureMediaTasksStore, getMediaTask, mediaTasksStoreLoaded } from "@/utils/mediaTasks/store";
import { lockWorkspaceFiles } from "@/utils/workspace/files";

export type FileSourceKind = "generated" | "original" | "cache";
export type FileMediaKind = "text" | "image" | "video" | "audio" | "unknown";

export type FileRecord = {
  id: string;
  /** 工作区内绝对路径（realpath 后）。 */
  path: string;
  /** 工作区根目录（realpath 后）。 */
  directory: string;
  sourceKind: FileSourceKind;
  mediaKind: FileMediaKind;
  /** 删除前重查校验；登记时文件缺失用 { size: -1, mtimeMs: 0 } 表示。 */
  version: { size: number; mtimeMs: number };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** 清理完成标记（真实删除成功或结合持久意图确认已发生后写入；文件重新登记/被外部改写时清除）。 */
  cleanedAt?: string;
  /**
   * 删除意图：真实删除前持久化的可恢复保护。删除成功转 cleanedAt；删除失败/文件被改写时清除。
   * 旧意图本身不构成删除依据，下一轮按最新天数、占用与版本重新计算保留期。
   */
  cleanupIntentAt?: string;
  /** 引用方标识（task:<taskId>、node:<nodeId> 等）。 */
  refs: string[];
};

export type RegisterFileRecordInput = {
  path: string;
  directory: string;
  sourceKind: FileSourceKind;
  mediaKind: FileMediaKind;
  refs?: string[];
};

export type TouchFileRecordPatch = {
  refs?: string[];
  updatedAt?: string;
  /** 清理标记：字符串写入清理时间，null 清除（文件被外部改写后重新计时）。 */
  cleanedAt?: string | null;
};

export type FileOutputState = "available" | "cleaned" | "missing";
export type FileOutputStatus = {
  state: FileOutputState;
  /** 归属查询使用的规范路径（realpath 优先，缺失时按工作区内词法路径）。 */
  path: string;
  cleanedAt?: string;
};

/**
 * 登记保护守卫（供任务/同步/素材等落盘路径使用）：
 * begin 先写入持久围栏，调用方在同一路径锁内写文件 → complete() 登记并解除围栏；
 * 登记失败时围栏保留（启动/清理前恢复重试），错误向调用方传播，不得 warn 后成功。
 */
export type FileRegistrationGuard = {
  complete(): Promise<FileRecord>;
  abort(): Promise<void>;
};

/**
 * 登记保护可选参数（T17；旧调用签名不变，第二参数可省略）：
 * expectedContent = 本次将要发布的新内容身份（size + sha256）。提供时崩溃恢复可确认
 * “新内容已原子发布但登记未完”并自动重登记；缺省时覆盖写场景一律保留围栏待核对。
 */
export type FileRegistrationGuardOptions = {
  expectedContent?: { size: number; sha256: string };
};

/**
 * 覆盖写恢复记录（T17）：begin 时记录目标当前版本（写前事实）与调用方给出的预期发布内容身份。
 * 恢复时据此区分「新建文件尚未落盘」「覆盖前已有旧文件（仍是旧内容）」「新内容已原子发布但登记未完」；
 * 缺预期内容身份的旧围栏一律保守保留待核对，不得把“文件存在”当作本次写入完成。
 */
export type FileWriteRecovery = {
  /** 写前目标状态：exists=false 表示 begin 时目标不存在（size=-1/mtimeMs=0）。 */
  preWrite: { exists: boolean; size: number; mtimeMs: number };
  /** 预期发布的新内容身份（调用方提供时记录；恢复仅在此身份与真实内容一致时才自动登记）。 */
  expectedContent?: { size: number; sha256: string };
  at: string;
};

/**
 * 未完成改名事务的持久意图（T15/§O.1、§O.2）：真实 rename **之前**写入保护表的事务身份事实。
 * 同一事务在 source 与 target 两端各有一条保护条目（条目路径为两端之一），
 * 后代匹配语义与既有范围保护一致：意图存在期间两端及其真正后代都不得被清理，
 * 改名遇到该围栏必须拒绝（同事务续做除外，见 cleanup 的 relocateWorkspacePath）。
 */
export type FileRelocationIntent = {
  /** 事务身份（§O.1 确定性 ID：`relocate:<sha256(directory\0source\0target) 前 16 位>`）。 */
  transactionId: string;
  directory: string;
  /** 事务的源/目标绝对路径。 */
  source: string;
  target: string;
  /** 本次事务涉及的引用身份（task:<id> 等记录引用）与记录身份（record:<id>）。 */
  refs: string[];
  createdAt: string;
  /**
   * §P.1 参与集合：本次 affected 任务 id（含“已发布到目标”的成员）。
   * Q 传入或由 C 从 refs 的任务引用推导；显式核对据此判断事务是否已收敛。
   */
  participants?: string[];
  /**
   * 原意图的证据（§P.3）：建立时源路径归属记录 id 与真实文件版本。**不得被重试时的当前文件覆盖**。
   * size/mtime 用于恢复核对（文件被外部替换时拒绝误认）；sha256 仅在源为常规文件且不超过
   * 内容身份上限时记录，作为内容身份硬证据；recordIds 为诊断与人工核对线索（归属合并时 id 可能合法变化）。
   */
  versionBasis?: { recordIds: string[]; size: number; mtimeMs: number; sha256?: string };
};

export type FileProtection = {
  path: string;
  directory: string;
  /** 未完成的登记输入（恢复时重试；成功后清除）。 */
  pendingRegistration?: RegisterFileRecordInput;
  /** 未完成写入的恢复依据（T17；与 pendingRegistration 同代建立/清除）。 */
  pendingWrite?: FileWriteRecovery;
  /** 无法自动恢复的范围保护原因（归属迁移失败且回滚失败等；需显式解除）。 */
  rangeReason?: string;
  /**
   * 未完成改名事务的持久意图（T15/§O.2）：提交（rename + 归属/释放时间/定位日志全部落盘）
   * 或回滚确认落盘后才清除；清除失败时保留，作为「保护仍在，需清理核对」的持久事实。
   */
  relocationIntent?: FileRelocationIntent;
  /** 保护代次身份：complete/abort/恢复只能解除同一代围栏，不能用旧快照清掉新 guard。 */
  guardId?: string;
  /** 代次版本：同一路径重新开始登记时递增；恢复与解除的同代核对依据。 */
  guardVersion?: number;
  createdAt: string;
  updatedAt: string;
};

/** 保护表故障标记：解析失败或存在无法确认的坏条目时持久保留，跨重启阻断清理直到显式核对恢复。 */
export type FileProtectionsFailure = { error: string; at: string };

/** 编辑释放时间表故障标记（T14）：与保护表故障同口径持久保留，未知期间暂停自动删除。 */
export type EditingReleasesFailure = FileProtectionsFailure;

/**
 * 归属记录表故障标记（T03）：整表解析失败、存在无法确认的坏条目或不可解析/非法时间字段时持久保留。
 * 归属未知期间不得按剩余条目继续清理，也不得放行新生成；只有显式核对（POST /api/cleanup/protections）才清除。
 */
export type FileRecordsFailure = FileProtectionsFailure;

export type FileRelocation = {
  directory: string;
  from: string;
  to: string;
  refs: string[];
  at: string;
};

/** 编辑占用释放时间（持久）：用于保留期「最后实际保护解除时间」的较晚者计算。 */
export type EditingReleaseEntry = { directory: string; path: string; releasedAt: string };

export type FileRecordsStoreHealth = { ok: boolean; error?: string; degraded?: string };

/**
 * 待处理改名事务意图摘要（T15/§O.2，同步可读；供 readiness/status 诊断）：
 * 未完成事务的 transactionId、两端路径与原因（存在范围保护时取其文案，否则为固定说明）。
 */
export type FileRelocationIntentSummary = {
  transactionId: string;
  directory: string;
  source: string;
  target: string;
  createdAt: string;
  reason: string;
  /** §P.1 参与任务 id（存在时透出，供诊断与人工核对判断收敛范围）。 */
  participants?: string[];
};

/**
 * 保护/归属就绪快照（T03，供 Q 的生成准入与 I 的 health 诊断消费；字段可扩展，ok 为唯一判据）：
 * - ok=false：归属存储未加载完成，或归属记录/保护表/释放时间表存在未清除的持久故障
 *   （整表坏、无法确认的坏条目、非法时间字段、曾有保护状态未知；一律不得放行新收费生成）；
 * - protectionsInitialized=false 且无故障：首次空安装（健康空表），可与“已有保护状态未知”区分；
 * - relocationIntents：未完成改名事务意图（存在即两端路径已被保护；不改变 ok，供诊断与人工核对）。
 */
export type FileRecordsReadiness = {
  ok: boolean;
  loaded: boolean;
  protections: "ok" | "unknown";
  /** 保护表是否已初始化过（marker 存在）；false 且无故障 = 首次空安装。 */
  protectionsInitialized: boolean;
  protectionsFailure?: FileProtectionsFailure;
  releases: "ok" | "unknown";
  releasesFailure?: FileProtectionsFailure;
  /** 归属记录表状态（T03）：整表坏/坏条目/非法时间字段 → "unknown"。 */
  records: "ok" | "unknown";
  recordsFailure?: FileProtectionsFailure;
  /** 未完成改名事务意图（T15/§O.2）：非空表示存在待处理迁移，两端路径受保护，需提交/回滚或显式核对。 */
  relocationIntents?: FileRelocationIntentSummary[];
  error?: string;
  degraded?: string;
};
export type MigrateFileRecordsResult = { migrated: number; recordIds: string[]; refs: string[]; paths: { from: string; to: string }[] };
export type DuplicateFileRecordsResult = { duplicated: number; recordIds: string[] };
export type RemoveFileRecordsResult = { removed: number; recordIds: string[] };

const sourceKinds: readonly FileSourceKind[] = ["generated", "original", "cache"];
const mediaKinds: readonly FileMediaKind[] = ["text", "image", "video", "audio", "unknown"];
// ACT: 重定位日志按时间保留最近条目，供任务输出/页面视图在改名后解析新定位。
const maxRelocations = 2000;
// ACT: 编辑释放时间是保留期“较晚起点”的保护性数据，容量取足够大的上限；条目很小，单机规模不会触顶。
const maxEditingReleases = 50_000;

// 单进程单实例：内存索引即权威视图，变更串行落盘（writeAtomic + durable）。
// 同一物理路径可有多条归属（不同来源/媒体类型各自保留，多归属全保留）；记录以 id 为键，另有路径索引。
const records = new Map<string, FileRecord>();
const recordIdsByPath = new Map<string, Set<string>>();
const protections = new Map<string, FileProtection>();
const editingReleases = new Map<string, EditingReleaseEntry>();
/** 当前进程内正在写入（begin 之后、complete/abort 之前）的登记围栏：恢复必须跳过 live guard。 */
const liveGuardIds = new Set<string>();
let relocations: FileRelocation[] = [];
let protectionsFailure: FileProtectionsFailure | undefined;
// T14：释放时间表损坏时同样持久故障（未知释放时间可能缩短保留期），不得置空后照常清理。
let editingReleasesFailure: FileProtectionsFailure | undefined;
// T03：归属记录表损坏/坏条目/非法时间字段时持久故障（归属未知不得按“剩余条目”继续清理或放行新生成）。
let recordsFailure: FileRecordsFailure | undefined;
/**
 * 租约版本持久代次（T14）：全局单调递增，续租前预留并持久化；过期移除后不复用旧版本号，
 * 使迟到释放无法命中过期后重新建立的占用（即使 leaseId 被复用或进程重启）。
 */
let editingLeaseGeneration = 0;
/**
 * 代次文件未知/损坏时的保守起点（T14）：真实代次无法证明时，把新版本抬到远离历史值的高位，
 * 使显式核对恢复后的新占用版本不会与损坏前已发出的版本相撞（版本对客户端不透明）。
 * 起点取 max(固定下限, 当前时间)：即使代次文件被删除/反复损坏而从未写回，跨重启的重启也不会发出
 * 相同版本（时钟前进 ⇒ 起点单调升高），比纯常量更保守。
 */
const unknownLeaseGenerationSeed = 2 ** 40;

function seedUnknownLeaseGeneration() {
  const seed = Math.max(unknownLeaseGenerationSeed, Date.now());
  if (editingLeaseGeneration < seed) editingLeaseGeneration = seed;
}
/** 保护表是否曾初始化过（marker 文件）：区分“首次空安装”与“已有保护状态未知”（T16）。 */
let protectionsInitialized = false;
/** 记录表文件是否出现过（含损坏后被备份）：保护表缺失时结合该信号判定“已有保护状态未知”。 */
let recordsFileSeen = false;
/** 重定位日志是否出现过：同上，作为“本安装已运行过”的保守证据之一。 */
let relocationsFileSeen = false;
/** 编辑释放时间表是否曾初始化过（marker 文件；同理区分缺失与首次无记录）。 */
let editingReleasesInitialized = false;
/**
 * 初始化标记写入失败（T16 互审）：标记不可写时“缺失保护表/释放表”不得判为首次空安装；
 * 故障同时持久化进对应数据表自身（含 failure 字段），跨重启保持未知状态。
 */
let protectionsMarkerWriteFailed = false;
let editingReleasesMarkerWriteFailed = false;
/** 非阻断性的降级说明（记录表/日志损坏备份等），保留供诊断。 */
let storeDegraded: string | undefined;
let storeReady = false;
let storeLoading: Promise<void> | undefined;
let mutationChain: Promise<unknown> = Promise.resolve();

function noteDegraded(note: string) {
  storeDegraded = storeDegraded ? `${storeDegraded}；${note}` : note;
}

/** 当前故障原因（保护表优先）：任一存在都必须暂停自动删除与放行新生成（保守）。 */
function storeFailureReason() {
  if (protectionsFailure) return `登记保护表故障（${protectionsFailure.at}）：${protectionsFailure.error}`;
  if (editingReleasesFailure) return `编辑释放时间表故障（${editingReleasesFailure.at}）：${editingReleasesFailure.error}`;
  if (recordsFailure) return `文件归属记录故障（${recordsFailure.at}）：${recordsFailure.error}`;
  return undefined;
}

function healthSnapshot(): FileRecordsStoreHealth {
  const reason = storeFailureReason();
  return {
    ok: storeReady && !reason,
    ...(reason
      ? { error: `${reason}；需显式核对恢复（POST /api/cleanup/protections，携带核对原因与相关路径）后才能继续自动清理` }
      : storeReady ? {} : { error: "文件归属存储尚未加载" }),
    ...(storeDegraded ? { degraded: storeDegraded } : {}),
  };
}

export function fileRecordsDirectory() {
  return join(dirname(conf.path), "fileRecords");
}

function recordsFilePath() {
  return join(fileRecordsDirectory(), "records.json");
}

function protectionsFilePath() {
  return join(fileRecordsDirectory(), "protections.json");
}

/** 保护表初始化标记（T16）：保护表数据首次写出（或读到既有数据文件）时写入；
 * 此后 protections.json 缺失即为“既有保护状态未知”；空安装无标记，重启仍是首次空安装。 */
function protectionsMarkerFilePath() {
  return join(fileRecordsDirectory(), "protections.marker.json");
}

/** 编辑释放时间表初始化标记（T14）：同理区分“首次无释放记录”与“释放时间表缺失（保留期未知）”。 */
function editingReleasesMarkerFilePath() {
  return join(fileRecordsDirectory(), "editingReleases.marker.json");
}

function relocationsFilePath() {
  return join(fileRecordsDirectory(), "relocations.json");
}

function editingReleasesFilePath() {
  return join(fileRecordsDirectory(), "editingReleases.json");
}

/** 物理路径归一化键：同一文件的不同写法共用路径索引。 */
export function fileRecordPathKey(path: string) {
  const value = resolve(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** 路径键前缀匹配：candidate 是 base 本身或真正后代（分隔符边界，a 与 ab 不混）。 */
export function isSameOrDescendantKey(baseKey: string, candidateKey: string) {
  if (candidateKey === baseKey) return true;
  const prefix = baseKey.endsWith(sep) ? baseKey : `${baseKey}${sep}`;
  return candidateKey.startsWith(prefix);
}

export function ensureFileRecordsLoaded(): Promise<void> {
  storeLoading ??= loadFileRecords().catch(error => {
    storeLoading = undefined;
    throw error;
  });
  return storeLoading;
}

/** 归属存储是否已成功加载（清理就绪判定之一；加载失败后允许重试）。 */
export function fileRecordsStoreLoaded() {
  return storeReady;
}

function isRegistrationInput(value: unknown): value is RegisterFileRecordInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.path === "string" && !!input.path && typeof input.directory === "string" && !!input.directory
    && sourceKinds.includes(input.sourceKind as FileSourceKind) && mediaKinds.includes(input.mediaKind as FileMediaKind)
    && (input.refs === undefined || (Array.isArray(input.refs) && input.refs.every(ref => typeof ref === "string")));
}

/**
 * 时间字段必须可解析且有限（T03/N.3）：空串、not-a-date、无穷值一律不得当作有效时间参与保留期计算。
 * JSON.parse 对 1e999 会产生 Infinity，因此数值型时间也要显式检查有限性。
 */
function isParsableTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalParsableTime(value: unknown) {
  return value === undefined || isParsableTime(value);
}

function isFileRecord(value: unknown): value is FileRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const version = record.version as Record<string, unknown> | undefined;
  return typeof record.id === "string" && !!record.id
    && typeof record.path === "string" && !!record.path
    && typeof record.directory === "string" && !!record.directory
    && sourceKinds.includes(record.sourceKind as FileSourceKind) && mediaKinds.includes(record.mediaKind as FileMediaKind)
    && !!version && Number.isFinite(version.size) && Number.isFinite(version.mtimeMs)
    && isParsableTime(record.createdAt) && isParsableTime(record.updatedAt)
    && isOptionalParsableTime(record.completedAt) && isOptionalParsableTime(record.cleanedAt) && isOptionalParsableTime(record.cleanupIntentAt)
    && Array.isArray(record.refs) && record.refs.every(ref => typeof ref === "string");
}

function isFileWriteRecovery(value: unknown): value is FileWriteRecovery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const pre = entry.preWrite as Record<string, unknown> | undefined;
  if (!pre || typeof pre !== "object" || Array.isArray(pre)) return false;
  if (typeof pre.exists !== "boolean" || !Number.isFinite(pre.size) || !Number.isFinite(pre.mtimeMs)) return false;
  if (!isParsableTime(entry.at)) return false;
  if (entry.expectedContent !== undefined) {
    const expected = entry.expectedContent as Record<string, unknown> | undefined;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) return false;
    if (!Number.isFinite(expected.size) || typeof expected.sha256 !== "string") return false;
  }
  return true;
}

/** 改名事务意图结构校验（T15/§O.2）：身份字段缺失/时间非法视为坏条目，按持久故障保守处理。 */
function isFileRelocationIntent(value: unknown): value is FileRelocationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  if (typeof intent.transactionId !== "string" || !intent.transactionId) return false;
  if (typeof intent.directory !== "string" || !intent.directory) return false;
  if (typeof intent.source !== "string" || !intent.source) return false;
  if (typeof intent.target !== "string" || !intent.target) return false;
  if (!Array.isArray(intent.refs) || !intent.refs.every(ref => typeof ref === "string")) return false;
  if (!isParsableTime(intent.createdAt)) return false;
  // §P.1：可选参与集合（坏值按无法确认的条目保守处理，不得静默丢弃）。
  if (intent.participants !== undefined
    && (!Array.isArray(intent.participants) || !intent.participants.every(id => typeof id === "string" && !!id))) return false;
  if (intent.versionBasis !== undefined) {
    const basis = intent.versionBasis as Record<string, unknown> | undefined;
    if (!basis || typeof basis !== "object" || Array.isArray(basis)) return false;
    if (!Array.isArray(basis.recordIds) || !basis.recordIds.every(id => typeof id === "string")) return false;
    if (!Number.isFinite(basis.size) || !Number.isFinite(basis.mtimeMs)) return false;
    if (basis.sha256 !== undefined && (typeof basis.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(basis.sha256))) return false;
  }
  return true;
}

function isFileProtection(value: unknown): value is FileProtection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== "string" || !entry.path) return false;
  if (entry.pendingRegistration !== undefined && !isRegistrationInput(entry.pendingRegistration)) return false;
  if (entry.pendingWrite !== undefined && !isFileWriteRecovery(entry.pendingWrite)) return false;
  if (entry.rangeReason !== undefined && typeof entry.rangeReason !== "string") return false;
  if (entry.relocationIntent !== undefined && !isFileRelocationIntent(entry.relocationIntent)) return false;
  if (entry.guardId !== undefined && typeof entry.guardId !== "string") return false;
  if (entry.guardVersion !== undefined && (typeof entry.guardVersion !== "number" || !Number.isInteger(entry.guardVersion))) return false;
  // T03：保护条目时间字段同样必须可解析（非法时间不得当作有效保护/恢复时点）。
  return isParsableTime(entry.createdAt) && isParsableTime(entry.updatedAt);
}

function indexRecord(record: FileRecord) {
  records.set(record.id, record);
  const key = fileRecordPathKey(record.path);
  const ids = recordIdsByPath.get(key);
  if (ids) ids.add(record.id);
  else recordIdsByPath.set(key, new Set([record.id]));
}

function unindexRecord(record: FileRecord) {
  records.delete(record.id);
  const key = fileRecordPathKey(record.path);
  const ids = recordIdsByPath.get(key);
  if (!ids) return;
  ids.delete(record.id);
  if (!ids.size) recordIdsByPath.delete(key);
}

/** 该物理路径的全部归属记录，按登记先后排列（最早已登记的在前）。 */
function recordsAt(pathKey: string): FileRecord[] {
  const ids = recordIdsByPath.get(pathKey);
  if (!ids) return [];
  return [...ids].map(id => records.get(id)).filter((record): record is FileRecord => !!record)
    .sort((left, right) => (left.createdAt === right.createdAt ? (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      : left.createdAt < right.createdAt ? -1 : 1));
}

/** 源路径本身及真正后代的全部归属记录（不含相似前缀兄弟，如 a 与 ab）。 */
function collectUnderKey(baseKey: string): FileRecord[] {
  const result: FileRecord[] = [];
  for (const record of records.values()) {
    if (isSameOrDescendantKey(baseKey, fileRecordPathKey(record.path))) result.push(record);
  }
  return result;
}

function cloneRecord(record: FileRecord) {
  return structuredClone(record);
}

function cloneProtection(protection: FileProtection) {
  return structuredClone(protection);
}

/** 归属是否仍在同一工作区内（复制/移动维护归属时的最小边界校验，与工作区文件接口口径一致）。 */
function isWithin(root: string, path: string) {
  const offset = relative(root, path);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

function laterOf(left: string | undefined, right: string | undefined) {
  if (!left) return right;
  if (!right) return left;
  return left < right ? right : left;
}

function errorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  return (message || fallback).slice(0, 300);
}

/** 真实文件内容 sha256（T17 恢复核对预期发布内容；读取失败返回 undefined，按“无法确认”保守处理）。 */
async function fileSha256(path: string) {
  const bytes = await readFile(path).catch(() => null);
  if (!bytes) return undefined;
  return createHash("sha256").update(bytes).digest("hex");
}

async function backupCorrupt(target: string) {
  const backup = `${target}.corrupt-${Date.now()}`;
  await rename(target, backup).catch(error => console.warn(`文件归属存储备份失败：${target}`, error));
  return backup;
}

/**
 * 只读复制损坏内容到备份路径（**不移动原文件**）：保护/释放表只有在故障已持久化之后才允许处理原文件；
 * 故障标记写不进去时必须保留损坏文件原样，否则重启后可能被判成“首次空安装”健康状态（T16 互审）。
 */
async function backupCorruptContent(target: string, content: string): Promise<string | undefined> {
  const backup = `${target}.corrupt-${Date.now()}`;
  try {
    await writeAtomic(backup, content, { durable: true });
    return backup;
  } catch (error) {
    console.warn(`损坏存储内容备份失败（原文件保持原样）：${target}`, error);
    return undefined;
  }
}

async function readStoreFile(target: string) {
  return readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function loadFileRecords() {
  // ACT: 目录不存在时创建；各存储文件缺失按空表处理（首次运行）。
  await mkdir(fileRecordsDirectory(), { recursive: true });
  await loadRecordsFile();
  await loadProtectionsFile();
  await loadRelocationsFile();
  await loadEditingReleasesFile();
  storeReady = true;
}

async function loadRecordsFile() {
  const target = recordsFilePath();
  const content = await readStoreFile(target);
  if (content === null) return;
  recordsFileSeen = true;
  let list: unknown[] | undefined;
  let failed: FileRecordsFailure | undefined;
  try {
    const parsed = JSON.parse(content) as { records?: unknown; failure?: unknown };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (Array.isArray(parsed.records)) list = parsed.records;
      if (isProtectionsFailure(parsed.failure)) failed = parsed.failure;
    }
  } catch {
    list = undefined;
  }
  if (!list) {
    // T03：整表解析失败意味着全部归属未知——必须进入可诊断、跨重启的持久故障状态，
    // 不得“重建空表后按无候选视为健康”。顺序：先把故障写进归属表自身（failure 字段跨重启生效）；
    // 持久化失败时保留损坏文件原样（重启会重新识别同一故障），成功后才只读备份原始内容供人工核对。
    records.clear();
    recordIdsByPath.clear();
    const failure: FileRecordsFailure = { error: "文件归属记录无法解析，全部归属未知，已暂停自动清理与新生成准入", at: new Date().toISOString() };
    setRecordsFailure(failure);
    let persisted = false;
    try {
      await persistRecords();
      persisted = true;
    } catch (error) {
      setRecordsFailure({ ...failure, error: `${failure.error}；故障标记持久化失败（已保留损坏文件原样以防重启误判）` });
      console.error("文件归属表故障标记持久化失败，保留损坏文件原样以防重启误判", error);
    }
    if (persisted) {
      const backup = await backupCorruptContent(target, content);
      setRecordsFailure({ ...failure, error: backup ? `${failure.error}；原损坏内容已备份为 ${backup}` : `${failure.error}；原损坏内容备份失败（原文件已被故障记录替换）` });
      await persistRecords().catch(error => console.error("文件归属表故障标记补充备份信息失败", error));
    }
    return;
  }
  records.clear();
  recordIdsByPath.clear();
  const invalid: string[] = [];
  for (const entry of list) {
    if (!isFileRecord(entry)) {
      invalid.push(JSON.stringify(entry)?.slice(0, 200) ?? "");
      console.warn(`文件归属记录条目无效（无法确认归属或时间非法的条目），已跳过并以持久故障阻断清理：${JSON.stringify(entry)?.slice(0, 200)}`);
      continue;
    }
    indexRecord(entry);
  }
  if (failed) {
    setRecordsFailure(failed);
  } else if (invalid.length) {
    // T03：坏条目的归属（例如同一物理文件的 original 归属 refs 损坏成非数组）无法确认，
    // 不得“跳过坏条目后按剩余条目继续”被当作健康——持久故障阻断全部自动删除与新生成准入。
    const failure: FileRecordsFailure = { error: `文件归属记录存在 ${invalid.length} 条无法确认的条目（结构损坏或时间非法），其归属范围未知`, at: new Date().toISOString() };
    setRecordsFailure(failure);
    let persisted = false;
    try {
      await persistRecords();
      persisted = true;
    } catch (error) {
      setRecordsFailure({ ...failure, error: `${failure.error}；故障标记持久化失败（已保留原文件原样以防重启误判）` });
      console.error("文件归属表坏条目故障标记持久化失败，保留原文件原样以防重启误判", error);
    }
    if (persisted) {
      const backup = await backupCorruptContent(target, content);
      setRecordsFailure({ ...failure, error: backup ? `${failure.error}；原始内容已备份为 ${backup}` : `${failure.error}；原始内容备份失败（原文件已被故障记录替换）` });
      await persistRecords().catch(error => console.error("文件归属表坏条目故障标记补充备份信息失败", error));
    }
  }
}

function isProtectionsFailure(value: unknown): value is FileProtectionsFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.error === "string" && typeof entry.at === "string";
}

/** 保护表故障状态：ok=false 且带可诊断原因；清除只能走 clearProtectionsStoreFailure 的显式核对。 */
function setProtectionsFailure(failure: FileProtectionsFailure | undefined) {
  protectionsFailure = failure;
  if (failure) console.error(failure.error);
}

/** 编辑释放时间表故障状态（T14）：与保护表故障同口径，未知期间清理必须暂停删除。 */
function setEditingReleasesFailure(failure: FileProtectionsFailure | undefined) {
  editingReleasesFailure = failure;
  if (failure) console.error(failure.error);
}

/** 归属记录表故障状态（T03）：与保护表故障同口径，未知期间清理与新生成准入都必须阻断。 */
function setRecordsFailure(failure: FileRecordsFailure | undefined) {
  recordsFailure = failure;
  if (failure) console.error(failure.error);
}

/**
 * 运行时建立“编辑释放/代次状态未知”的持久故障（T14；收尾写失败、续租保护下限写失败等）：
 * 内存立即生效（本次进程内清理/新生成停摆），并尽力持久化到释放时间表自身，跨重启保持保守。
 * 返回是否已写入持久存储（false 表示磁盘不可写，重启后依赖数据文件自身的原样事实重新识别）。
 */
export async function markEditingReleasesStoreFailure(reason: string, detail?: unknown): Promise<boolean> {
  const message = `${reason}${detail === undefined ? "" : `：${errorMessage(detail, "未知错误")}`}`;
  const failure: FileProtectionsFailure = { error: message, at: new Date().toISOString() };
  setEditingReleasesFailure(failure);
  try {
    await persistEditingReleases();
    return true;
  } catch (error) {
    console.error("编辑释放时间表故障标记持久化失败（内存故障保持，重启依赖数据文件原样识别）", error);
    return false;
  }
}

async function persistProtections() {
  // ACT: 故障标记跟随保护表持久化（T16）；普通写入成功不代表历史保护已恢复，不得把 ok 改回 true。
  await writeAtomic(
    protectionsFilePath(),
    JSON.stringify({ protections: [...protections.values()], ...(protectionsFailure ? { failure: protectionsFailure } : {}) }, null, 2),
    { durable: true },
  );
  // 数据文件写出即代表本表已初始化：补标记（标记存在而保护表缺失 = 既有保护状态未知，不得按空表继续）。
  await ensureProtectionsMarker();
}

/** 保护表数据写出后补标记；标记存在而保护表缺失 = 既有保护状态未知（不得按空表继续）。 */
async function ensureProtectionsMarker() {
  if (protectionsInitialized) return;
  try {
    await writeAtomic(protectionsMarkerFilePath(), JSON.stringify({ initializedAt: new Date().toISOString() }, null, 2), { durable: true });
    protectionsInitialized = true;
  } catch (error) {
    const first = !protectionsMarkerWriteFailed;
    protectionsMarkerWriteFailed = true;
    if (first) {
      noteDegraded("保护表初始化标记写入失败：缺失保护表不得再按首次空安装处理，已按持久故障保守阻断");
      console.warn("保护表初始化标记写入失败", error);
    }
    // T16 互审：标记不可写不能只记降级——把故障持久化进保护表自身（failure 字段跨重启生效），
    // 并保留内存故障；此后“缺失保护表”一律按“已有保护状态未知”处理，显式核对恢复前不清理/不放行新生成。
    if (!protectionsFailure) {
      const markerFailure: FileProtectionsFailure = { error: "保护表初始化标记写入失败，既有保护状态无法与首次空安装区分", at: new Date().toISOString() };
      setProtectionsFailure(markerFailure);
      try {
        // 直接写数据文件（不经 persistProtections，避免再次触发本函数造成递归）；写入失败时数据文件保持原状，重启会重新识别。
        await writeAtomic(
          protectionsFilePath(),
          JSON.stringify({ protections: [...protections.values()], failure: markerFailure }, null, 2),
          { durable: true },
        );
      } catch (persistError) {
        console.error("保护表标记故障持久化失败（数据文件保持原状，重启会重新识别同一故障）", persistError);
      }
    }
  }
}

async function persistEditingReleases() {
  // 故障标记跟随释放时间表持久化（T14）：有故障时任何记录写入都保留标记，跨重启保持保守。
  // generation 为租约版本持久代次（T14）：与释放时间同批持久提交，过期移除后版本不复用。
  await writeAtomic(
    editingReleasesFilePath(),
    JSON.stringify({
      releases: [...editingReleases.values()],
      generation: editingLeaseGeneration,
      ...(editingReleasesFailure ? { failure: editingReleasesFailure } : {}),
    }, null, 2),
    { durable: true },
  );
  await ensureEditingReleasesMarker();
}

/** 释放时间表初始化标记：写入成功即认为该表“曾初始化”，之后缺失按未知处理。 */
async function ensureEditingReleasesMarker() {
  if (editingReleasesInitialized) return;
  try {
    await writeAtomic(editingReleasesMarkerFilePath(), JSON.stringify({ initializedAt: new Date().toISOString() }, null, 2), { durable: true });
    editingReleasesInitialized = true;
  } catch (error) {
    const first = !editingReleasesMarkerWriteFailed;
    editingReleasesMarkerWriteFailed = true;
    if (first) {
      noteDegraded("编辑释放时间表初始化标记写入失败：该表缺失不得再按首次无记录处理，已按持久故障保守阻断");
      console.warn("编辑释放时间表初始化标记写入失败", error);
    }
    // T14/T16 同口径：标记不可写时把故障持久化进释放时间表自身，保守暂停自动删除，跨重启保持。
    if (!editingReleasesFailure) {
      const markerFailure: FileProtectionsFailure = { error: "编辑释放时间表初始化标记写入失败，释放时间无法与首次无记录区分", at: new Date().toISOString() };
      setEditingReleasesFailure(markerFailure);
      try {
        await writeAtomic(
          editingReleasesFilePath(),
          JSON.stringify({ releases: [...editingReleases.values()], failure: markerFailure }, null, 2),
          { durable: true },
        );
      } catch (persistError) {
        console.error("编辑释放时间表标记故障持久化失败（数据文件保持原状，重启会重新识别同一故障）", persistError);
      }
    }
  }
}

/** 保护表加载：区分首次空安装（健康空表）与既有保护状态未知/坏表（持久故障，跨重启保守）。 */
async function loadProtectionsFile() {
  const target = protectionsFilePath();
  const content = await readStoreFile(target);
  // 标记的存在说明此前初始化过保护表；仅“标记缺失且保护表也缺失”才视为首次空安装。
  protectionsInitialized = protectionsInitialized || (await readStoreFile(protectionsMarkerFilePath())) !== null;
  if (content === null) {
    // 其他存储的“曾出现过”证据（含直接读盘：保护表先于它们加载时内存标志尚不可用）：
    // 只要存在任一证据就不能判为首次空安装（T16 互审：缺失保护表一律 unknown）。
    const otherStoresSeen = recordsFileSeen
      || relocationsFileSeen
      || editingReleasesInitialized
      || (await readStoreFile(relocationsFilePath())) !== null
      || (await readStoreFile(editingReleasesMarkerFilePath())) !== null;
    if (protectionsInitialized || otherStoresSeen || protectionsMarkerWriteFailed) {
      // T16：既有保护状态未知（文件被删，或标记写入失败/丢失）：不得当健康空表继续清理。
      // 只有在“保护表、归属记录、释放记录、重定位日志均未出现过”时才允许判为首次空安装。
      const failure: FileProtectionsFailure = {
        error: protectionsInitialized
          ? "登记保护记录文件缺失（此前已初始化保护表），既有保护范围无法确认"
          : protectionsMarkerWriteFailed
            ? "登记保护记录文件缺失，且保护表初始化标记写入失败（无法证明是首次空安装），既有保护范围无法确认"
            : "登记保护记录文件缺失，但存在其他已初始化的归属数据（无法证明是首次空安装），既有保护范围无法确认",
        at: new Date().toISOString(),
      };
      setProtectionsFailure(failure);
      await persistProtections().catch(error => {
        setProtectionsFailure({ ...failure, error: `${failure.error}；故障标记持久化失败` });
        console.error("登记保护表缺失故障标记持久化失败", error);
      });
      return;
    }
    // 首次空安装：健康空表（不写标记——只有真正写出保护表数据后才算“已初始化”，
    // 否则空安装重启后会被误判为“保护表缺失”）。
    return;
  }
  // 数据文件存在即代表本表曾初始化：先确保标记存在，之后该表缺失一律按故障处理。
  await ensureProtectionsMarker();
  let list: unknown[] | undefined;
  let failed: FileProtectionsFailure | undefined;
  try {
    const parsed = JSON.parse(content) as { protections?: unknown; failure?: unknown };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (Array.isArray(parsed.protections)) list = parsed.protections;
      if (isProtectionsFailure(parsed.failure)) failed = parsed.failure;
    }
  } catch {
    list = undefined;
  }
  if (!list) {
    // 保护记录不可用意味着无法确认“未完成登记”的保护范围：必须保守（T16 互审）。
    // 顺序保证：先把故障持久化进保护表自身（failure 字段跨重启生效）；**持久化失败时保留损坏文件原样**，
    // 不先移走证据——否则“标记写失败 + 故障标记写失败 + 其他表也缺失”会在重启后被判成首次空安装。
    const failure: FileProtectionsFailure = { error: "登记保护记录无法解析，既有保护范围未知，已暂停自动清理", at: new Date().toISOString() };
    setProtectionsFailure(failure);
    let persisted = false;
    try {
      await persistProtections();
      persisted = true;
    } catch (error) {
      setProtectionsFailure({ ...failure, error: `${failure.error}；故障标记持久化失败（已保留损坏文件原样以防重启误判）` });
      console.error("登记保护表故障标记持久化失败，保留损坏文件原样以防重启误判", error);
    }
    if (persisted) {
      // 故障已跨重启生效（保护表内含 failure 字段）：再只读复制一份损坏内容供人工核对（复制失败不影响安全）。
      const backup = await backupCorruptContent(target, content);
      setProtectionsFailure({ ...failure, error: backup ? `${failure.error}；原损坏内容已备份为 ${backup}` : `${failure.error}；原损坏内容备份失败（原文件已被故障记录替换）` });
      await persistProtections().catch(error => console.error("登记保护表故障标记补充备份信息失败", error));
    }
    await ensureProtectionsMarker();
    return;
  }
  protections.clear();
  const invalid: string[] = [];
  for (const entry of list) {
    if (!isFileProtection(entry)) {
      invalid.push(JSON.stringify(entry)?.slice(0, 200) ?? "");
      console.warn(`登记保护条目无效，已跳过：${JSON.stringify(entry)?.slice(0, 200)}`);
      continue;
    }
    protections.set(fileRecordPathKey(entry.path), {
      ...entry,
      directory: typeof entry.directory === "string" ? entry.directory : "",
    });
  }
  if (failed) {
    setProtectionsFailure(failed);
  } else if (invalid.length) {
    // 坏条目的路径无法确认：保守标记故障（保留已解析条目），清理暂停到显式核对恢复。
    const failure: FileProtectionsFailure = { error: `保护表存在 ${invalid.length} 条无法解析的条目，其保护范围未知`, at: new Date().toISOString() };
    setProtectionsFailure(failure);
    await persistProtections().catch(error => console.error("保护表故障标记持久化失败", error));
  }
  await ensureProtectionsMarker();
}

async function loadEditingReleasesFile() {
  const target = editingReleasesFilePath();
  const content = await readStoreFile(target);
  editingReleasesInitialized = editingReleasesInitialized || (await readStoreFile(editingReleasesMarkerFilePath())) !== null;
  if (content === null) {
    if (editingReleasesInitialized || editingReleasesMarkerWriteFailed) {
      // T14/T16：释放时间表曾初始化而现在缺失（或标记不可写无法证明首次无记录）：释放时间未知，保守持久故障。
      seedUnknownLeaseGeneration();
      const failure: FileProtectionsFailure = {
        error: editingReleasesInitialized
          ? "编辑占用释放时间记录文件缺失（此前已初始化），释放时间未知"
          : "编辑占用释放时间记录文件缺失，且初始化标记写入失败（无法证明是首次无记录），释放时间未知",
        at: new Date().toISOString(),
      };
      setEditingReleasesFailure(failure);
      await persistEditingReleases().catch(error => {
        setEditingReleasesFailure({ ...failure, error: `${failure.error}；故障标记持久化失败` });
        console.error("编辑释放时间表缺失故障标记持久化失败", error);
      });
      return;
    }
    // 首次运行：无释放记录（不写标记——只有真正写出释放记录后才算“已初始化”，
    // 否则空安装重启后会被误判为“释放时间表缺失”）。
    return;
  }
  // 数据文件存在即代表本表曾初始化：先确保标记存在，之后该表缺失一律按故障处理。
  await ensureEditingReleasesMarker();
  let list: unknown[] | undefined;
  let failed: FileProtectionsFailure | undefined;
  let generation: number | undefined;
  let generationInvalid = false;
  try {
    const parsed = JSON.parse(content) as { releases?: unknown; failure?: unknown; generation?: unknown };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (Array.isArray(parsed.releases)) list = parsed.releases;
      if (isProtectionsFailure(parsed.failure)) failed = parsed.failure;
      if (parsed.generation !== undefined) {
        if (typeof parsed.generation === "number" && Number.isInteger(parsed.generation) && parsed.generation >= 0) generation = parsed.generation;
        else generationInvalid = true;
      }
    }
  } catch {
    list = undefined;
  }
  if (!list) {
    // T14/T16 同口径：释放时间影响保留期起点，损坏时建立持久故障并暂停自动删除（不得置空后照常清理）。
    // 顺序保证：先把故障写进释放时间表自身；**持久化失败时保留损坏文件原样**，不先移走证据（防重启误判为首次无记录）。
    seedUnknownLeaseGeneration();
    const failure: FileProtectionsFailure = { error: "编辑占用释放时间记录无法解析，释放时间未知期间已暂停自动删除", at: new Date().toISOString() };
    setEditingReleasesFailure(failure);
    let persisted = false;
    try {
      await persistEditingReleases();
      persisted = true;
    } catch (error) {
      setEditingReleasesFailure({ ...failure, error: `${failure.error}；故障标记持久化失败（已保留损坏文件原样以防重启误判）` });
      console.error("编辑释放时间表故障标记持久化失败，保留损坏文件原样以防重启误判", error);
    }
    if (persisted) {
      const backup = await backupCorruptContent(target, content);
      setEditingReleasesFailure({ ...failure, error: backup ? `${failure.error}；原损坏内容已备份为 ${backup}` : `${failure.error}；原损坏内容备份失败（原文件已被故障记录替换）` });
      await persistEditingReleases().catch(error => console.error("编辑释放时间表故障标记补充备份信息失败", error));
    }
    await ensureEditingReleasesMarker();
    return;
  }
  editingReleases.clear();
  const invalid: unknown[] = [];
  for (const entry of list) {
    const value = entry as Record<string, unknown> | undefined;
    if (!value || typeof value.path !== "string" || !value.path || typeof value.directory !== "string"
      // T14：releasedAt 必须可解析且有限；空串/not-a-date 不得当作有效释放时间参与保留期。
      || !isParsableTime(value.releasedAt)) {
      invalid.push(entry);
      continue;
    }
    editingReleases.set(fileRecordPathKey(value.path), { directory: value.directory, path: value.path, releasedAt: value.releasedAt });
  }
  // T14 迁移口径（版本代次）：文件本身可解析（释放时间可信）但 generation **缺失或非法**时，
  // 历史已发放的版本范围不可证明 → 一律按未知代次处理，抬高到固定保守起点，绝不让新版本从 1 重新开始。
  // 该起点会在下一次续租/释放的持久化中写回文件（persistEditingReleases 总是携带 generation），完成迁移；
  // 代次只是版本唯一性依据，释放时间与保护范围不受影响，因此不额外置持久故障（避免过度阻断），仅留诊断说明。
  if (generation !== undefined) {
    editingLeaseGeneration = Math.max(editingLeaseGeneration, generation);
  } else {
    generationInvalid = true;
    seedUnknownLeaseGeneration();
  }
  if (generationInvalid) {
    noteDegraded("编辑释放时间表缺少或包含非法租约版本代次（旧格式/损坏值），已按保守起点抬高新版本范围并在下次持久化写回");
  }
  if (failed) {
    setEditingReleasesFailure(failed);
  } else if (invalid.length) {
    // 坏条目的路径/时间无法确认（丢失的是“较晚保留期起点”）：保守标记故障，显式核对恢复后才继续删除。
    const failure: FileProtectionsFailure = {
      error: `编辑释放时间表存在 ${invalid.length} 条无法解析的条目（路径或 releasedAt 非法），释放时间未知`,
      at: new Date().toISOString(),
    };
    setEditingReleasesFailure(failure);
    await persistEditingReleases().catch(error => console.error("编辑释放时间表故障标记持久化失败", error));
  }
}

async function loadRelocationsFile() {
  const target = relocationsFilePath();
  const content = await readStoreFile(target);
  if (content === null) return;
  // 出现过即是“本安装已运行/登记过”的保守证据：保护表缺失时据此判“既有保护状态未知”而不是首次空安装。
  relocationsFileSeen = true;
  let list: unknown[] | undefined;
  try {
    const parsed = JSON.parse(content) as { relocations?: unknown };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.relocations)) list = parsed.relocations;
  } catch {
    list = undefined;
  }
  if (!list) {
    // 重定位日志只是消费辅助，损坏不阻断清理（不构成为安全保护）；备份后置空并记录。
    const backup = await backupCorrupt(target);
    noteDegraded(`文件重定位日志无法解析，已备份为 ${backup}`);
    console.warn(`文件重定位日志无法解析，已备份为 ${backup}`);
    return;
  }
  relocations = list.filter((entry): entry is FileRelocation => {
    const value = entry as Record<string, unknown> | undefined;
    return !!value && typeof value.from === "string" && typeof value.to === "string" && typeof value.directory === "string"
      && typeof value.at === "string" && Array.isArray(value.refs) && value.refs.every(ref => typeof ref === "string");
  }).slice(-maxRelocations);
}

/** 变更串行化：加载完成后再执行，避免并发写坏记录表。 */
function queueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(() => ensureFileRecordsLoaded()).then(operation);
  mutationChain = result.then(() => undefined, () => undefined);
  return result;
}

async function persistRecords() {
  // ACT: 格式化 JSON 便于人工核对与验收时间回拨；记录量在单机规模内可接受。
  // T03: 故障标记跟随归属表持久化（跨重启保守）；普通写入成功不得清除历史故障（显式核对才清）。
  await writeAtomic(
    recordsFilePath(),
    JSON.stringify({ records: [...records.values()], ...(recordsFailure ? { failure: recordsFailure } : {}) }, null, 2),
    { durable: true },
  );
}

async function persistRelocations() {
  await writeAtomic(relocationsFilePath(), JSON.stringify({ relocations }, null, 2), { durable: true });
}

function snapshotProtections() {
  return new Map([...protections].map(([key, value]) => [key, cloneProtection(value)]));
}

function restoreProtections(snapshot: Map<string, FileProtection>) {
  protections.clear();
  for (const [key, value] of snapshot) protections.set(key, value);
}

async function inspectPath(path: string) {
  const resolved = await realpath(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!resolved) return { path: resolve(path), version: { size: -1, mtimeMs: 0 } };
  const info = await stat(resolved);
  return { path: resolved, version: { size: info.size, mtimeMs: info.mtimeMs } };
}

function mergeRefs(previous: readonly string[] | undefined, next: readonly string[] | undefined) {
  const merged: string[] = [];
  for (const ref of [...(previous ?? []), ...(next ?? [])]) {
    if (typeof ref === "string" && ref && !merged.includes(ref)) merged.push(ref);
  }
  return merged;
}

async function restoreRecords(backup: { pathKey: string; records: FileRecord[] }[]) {
  for (const entry of backup) {
    for (const record of recordsAt(entry.pathKey)) unindexRecord(record);
    for (const record of entry.records) indexRecord(cloneRecord(record));
  }
}

/** 全量快照（事务回滚用：目录改名涉及源目录本身与全部源后代，按键备份容易漏项）。 */
function snapshotRecords() {
  return [...records.values()].map(cloneRecord);
}

function restoreRecordsSnapshot(snapshot: FileRecord[]) {
  records.clear();
  recordIdsByPath.clear();
  for (const record of snapshot) indexRecord(cloneRecord(record));
}

function validateRegistrationInput(input: RegisterFileRecordInput) {
  if (typeof input.path !== "string" || !input.path) throw new Error("文件路径无效");
  if (typeof input.directory !== "string" || !input.directory) throw new Error("工作目录无效");
  if (!sourceKinds.includes(input.sourceKind)) throw new Error(`文件来源类型无效：${String(input.sourceKind)}`);
  if (!mediaKinds.includes(input.mediaKind)) throw new Error(`媒体类型无效：${String(input.mediaKind)}`);
}

/**
 * 单条归属写入的持久提交 + 「可能已发布即视为已发布」回滚（契约 §N.2；第五轮互审要求与 migrateFileRecord/
 * duplicateFileRecords/removeFileRecords 同口径）：
 * writeAtomic 先替换目标再 fsync 父目录，后者失败时内容可能已经发布，因此持久化抛错后不能只恢复内存——
 * 1) 调用持久化前先记录「已发起写入」标记；
 * 2) 抛错后按失败前快照重写存储（把内存与盘上统一到失败前状态）；
 * 3) 重写仍失败时保留当前内存状态并建立**持久故障**（跨重启保守，显式核对恢复），错误照常抛出；
 * 4) 不确定是否已发布时按更保守的一侧处理（宁可重写，也不让内存与盘上静默分叉）。
 * 调用约定：只在 queueMutation 内调用（本函数自身不再入队，避免自等死锁）。
 */
async function persistRecordsWithRollback(restoreMemory: () => Promise<void>, context: string): Promise<void> {
  let recordsWritten = false;
  try {
    // 先记录本次写入尝试：writeAtomic 的 rename 与 fsync 之间失败时，替换可能已经发生。
    recordsWritten = true;
    await persistRecords();
  } catch (error) {
    await restoreMemory();
    const rolledBack = await (async () => {
      try {
        if (recordsWritten) await persistRecords();
        return true;
      } catch {
        return false;
      }
    })();
    if (!rolledBack) {
      // 持久回滚未完成：内存与盘上可能不一致，建立归属持久故障（清理与新生成准入同时阻断）并要求人工核对。
      const failure: FileRecordsFailure = {
        error: `${context}失败且持久回滚未完成，账本状态需人工核对：${errorMessage(error, "归属写入失败")}`,
        at: new Date().toISOString(),
      };
      setRecordsFailure(failure);
      await persistRecords().catch(persistError => console.error(`${context}回滚失败后的故障标记持久化失败（内存保持阻断，重启需人工核对）`, persistError));
    }
    throw error;
  }
}

/**
 * 登记：同一物理路径按 (sourceKind, mediaKind) 合并为一条归属（保留 createdAt，refs 去重累积，
 * 刷新 version/updatedAt，清 cleanedAt/cleanupIntentAt）；不同来源或媒体类型各自保留一条记录
 * （多归属全保留，清理时必须全部归属都满足条件才删除）。
 */
export async function registerFileRecord(input: RegisterFileRecordInput): Promise<FileRecord> {
  validateRegistrationInput(input);
  return queueMutation(async () => {
    const inspected = await inspectPath(input.path);
    const directory = await realpath(input.directory).catch(() => resolve(input.directory));
    const key = fileRecordPathKey(inspected.path);
    const now = new Date().toISOString();
    const backup = { pathKey: key, records: recordsAt(key).map(cloneRecord) };
    const previous = recordsAt(key).find(record => record.sourceKind === input.sourceKind && record.mediaKind === input.mediaKind);
    // ACT: 同一归属再次登记视为同路径内容被本应用重写：refs 继续累积，落盘时间与版本刷新，清理标记清除。
    const record: FileRecord = previous
      ? { ...previous, path: inspected.path, directory, version: inspected.version, updatedAt: now, completedAt: now, cleanedAt: undefined, cleanupIntentAt: undefined, refs: mergeRefs(previous.refs, input.refs) }
      : { id: crypto.randomUUID(), path: inspected.path, directory, sourceKind: input.sourceKind, mediaKind: input.mediaKind, version: inspected.version, createdAt: now, updatedAt: now, completedAt: now, refs: mergeRefs(undefined, input.refs) };
    indexRecord(record);
    await persistRecordsWithRollback(() => restoreRecords([backup]), "文件归属登记");
    return cloneRecord(record);
  });
}

/**
 * 触碰记录：对同一物理路径的全部归属合并 refs、刷新 updatedAt/版本，并可按需写入或清除清理标记；
 * 记录不存在时忽略（未登记文件按未知处理，不自动归类）。
 */
export async function touchFileRecord(path: string, patch: TouchFileRecordPatch): Promise<void> {
  return queueMutation(async () => {
    const key = fileRecordPathKey(path);
    const targets = recordsAt(key);
    if (!targets.length) return;
    const backup = { pathKey: key, records: targets.map(cloneRecord) };
    const updatedAt = patch.updatedAt ?? new Date().toISOString();
    for (const record of targets) {
      if (patch.refs) record.refs = mergeRefs(record.refs, patch.refs);
      record.updatedAt = updatedAt;
      if (patch.cleanedAt !== undefined) {
        record.cleanedAt = patch.cleanedAt === null ? undefined : patch.cleanedAt;
        // 清除完成标记即视为重新计时：删除意图一并清除，避免旧意图绕过新的保留期。
        if (patch.cleanedAt === null) record.cleanupIntentAt = undefined;
      }
      const inspected = await inspectPath(record.path);
      record.path = inspected.path;
      record.version = inspected.version;
    }
    await persistRecordsWithRollback(() => restoreRecords([backup]), "归属触碰刷新");
  });
}

/** 移除该物理路径的全部归属记录（文件删除后清账；文件不存在时也可用于清理过期记录）。 */
export async function removeFileRecord(path: string): Promise<void> {
  return queueMutation(async () => {
    const key = fileRecordPathKey(path);
    const targets = recordsAt(key);
    if (!targets.length) return;
    const backup = { pathKey: key, records: targets.map(cloneRecord) };
    for (const record of targets) unindexRecord(record);
    await persistRecordsWithRollback(() => restoreRecords([backup]), "归属移除清账");
  });
}

/**
 * 删除意图（真实删除前持久化）：删除成功转 cleanedAt；失败清除；本身不构成删除依据。
 */
export async function markFileRecordCleanupIntent(path: string, at?: string): Promise<void> {
  return queueMutation(async () => {
    const key = fileRecordPathKey(path);
    const targets = recordsAt(key);
    if (!targets.length) return;
    const backup = { pathKey: key, records: targets.map(cloneRecord) };
    const value = at ?? new Date().toISOString();
    for (const record of targets) record.cleanupIntentAt = value;
    await persistRecordsWithRollback(() => restoreRecords([backup]), "删除意图写入");
  });
}

/** 清除删除意图（删除失败或文件被改写，下轮按最新天数与占用重算）。 */
export async function clearFileRecordCleanupIntent(path: string): Promise<void> {
  return queueMutation(async () => {
    const key = fileRecordPathKey(path);
    const targets = recordsAt(key);
    if (!targets.length) return;
    const backup = { pathKey: key, records: targets.map(cloneRecord) };
    let changed = false;
    for (const record of targets) {
      if (record.cleanupIntentAt === undefined) continue;
      record.cleanupIntentAt = undefined;
      changed = true;
    }
    if (!changed) return;
    await persistRecordsWithRollback(() => restoreRecords([backup]), "删除意图清除");
  });
}

/** 确认清理完成：真实删除成功，或结合持久意图确认上次删除已发生；写 cleanedAt 并清意图。 */
export async function confirmFileRecordCleaned(path: string, at?: string): Promise<void> {
  return queueMutation(async () => {
    const key = fileRecordPathKey(path);
    const targets = recordsAt(key);
    if (!targets.length) return;
    const backup = { pathKey: key, records: targets.map(cloneRecord) };
    const value = at ?? new Date().toISOString();
    for (const record of targets) {
      record.cleanedAt = value;
      record.cleanupIntentAt = undefined;
    }
    await persistRecordsWithRollback(() => restoreRecords([backup]), "清理完成标记写入");
  });
}

/**
 * 登记保护开始：先落盘持久围栏（覆盖“文件已写、记录未登记”的崩溃窗口），再由调用方在
 * 同一路径锁内完成文件写入并调用 complete()。complete() 失败时围栏保留，供清理前恢复重试。
 * 每次 begin 分配 guardId 并递增 guardVersion：complete/abort/恢复只允许解除同一代围栏，
 * 旧快照不能清掉同路径后来建立的新 guard（T17）；进程内 begin 未 complete/abort 的记为 live guard。
 * T17：begin 同时记录目标写前版本（自动探测）；调用方能提供 expectedContent（新内容 size+sha256）时
 * 恢复才可确认“本次写入已原子发布”，否则覆盖写场景一律保守保留围栏待核对。
 * 调用约定：调用方必须自行持有目标路径的工作区文件锁；本函数不取路径锁（归属写队列内不反向取锁）。
 */
export async function beginFileRegistrationProtection(
  input: RegisterFileRecordInput,
  options: FileRegistrationGuardOptions = {},
): Promise<FileRegistrationGuard> {
  validateRegistrationInput(input);
  const expectedContent = options.expectedContent;
  if (expectedContent && (typeof expectedContent.size !== "number" || !Number.isInteger(expectedContent.size)
    || expectedContent.size < 0 || typeof expectedContent.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedContent.sha256))) {
    throw new Error("预期发布内容身份无效：需要非负整数 size 与小写十六进制 sha256");
  }
  const guardId = crypto.randomUUID();
  let guardKey = "";
  let guardVersion = 0;
  // 先登记为 live guard：恢复在落盘围栏与 add 之间也绝不会把本代围栏当崩溃遗留处理。
  liveGuardIds.add(guardId);
  try {
    await queueMutation(async () => {
      const inspected = await inspectPath(input.path);
      const key = fileRecordPathKey(inspected.path);
      guardKey = key;
      const previous = protections.get(key);
      const now = new Date().toISOString();
      guardVersion = (previous?.guardVersion ?? 0) + 1;
      const pendingWrite: FileWriteRecovery = {
        preWrite: inspected.version.size >= 0
          ? { exists: true, size: inspected.version.size, mtimeMs: inspected.version.mtimeMs }
          : { exists: false, size: -1, mtimeMs: 0 },
        ...(expectedContent ? { expectedContent: { size: expectedContent.size, sha256: expectedContent.sha256 } } : {}),
        at: now,
      };
      const next: FileProtection = {
        path: inspected.path,
        directory: input.directory,
        pendingRegistration: { ...input, path: inspected.path },
        pendingWrite,
        ...(previous?.rangeReason ? { rangeReason: previous.rangeReason } : {}),
        // T15/§O.2：既有未完成改名意图不因新的登记围栏被覆盖（意图只在提交/回滚/显式核对后清除）。
        ...(previous?.relocationIntent ? { relocationIntent: previous.relocationIntent } : {}),
        guardId,
        guardVersion,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      protections.set(key, next);
      try {
        await persistProtections();
      } catch (error) {
        if (previous) protections.set(key, previous);
        else protections.delete(key);
        throw error;
      }
    });
  } catch (error) {
    liveGuardIds.delete(guardId);
    throw error;
  }
  const clearPending = () => queueMutation(async () => {
    const entry = protections.get(guardKey);
    // 同一代核对：路径上的围栏已被更新的 guard 取代（或已被恢复解除）时不得清除。
    if (!entry?.pendingRegistration || entry.guardId !== guardId || entry.guardVersion !== guardVersion) return;
    const snapshot = snapshotProtections();
    const next: FileProtection = { ...entry, updatedAt: new Date().toISOString() };
    delete next.pendingRegistration;
    delete next.pendingWrite;
    delete next.guardId;
    delete next.guardVersion;
    // T15/§O.2：条目仍承载范围保护或未完成改名意图时只清围栏字段，保留条目本身（意图不得被围栏解除连带清除）。
    if (next.rangeReason || next.relocationIntent) protections.set(guardKey, next);
    else protections.delete(guardKey);
    try {
      await persistProtections();
    } catch (error) {
      restoreProtections(snapshot);
      throw error;
    }
  });
  return {
    complete: async () => {
      // 登记必须成功落盘后才解除围栏；失败保留围栏并把错误传播给调用方。
      try {
        const record = await registerFileRecord(input);
        await clearPending();
        return record;
      } finally {
        liveGuardIds.delete(guardId);
      }
    },
    abort: async () => {
      try {
        await clearPending();
      } finally {
        liveGuardIds.delete(guardId);
      }
    },
  };
}

/** 未完成登记的保护恢复：在清理删除之前执行；成功则解除围栏，失败保留围栏（该路径不参与删除）。 */
export async function recoverPendingFileProtections(): Promise<{ recovered: number; failed: { path: string; reason: string }[]; skipped: string[] }> {
  await ensureFileRecordsLoaded();
  let recovered = 0;
  const failed: { path: string; reason: string }[] = [];
  const skipped: string[] = [];
  for (const [key, protection] of [...protections]) {
    if (!protection.pendingRegistration) continue;
    // 进程内正在写入（begin 后未 complete/abort）的围栏不得当遗留恢复。
    if (protection.guardId && liveGuardIds.has(protection.guardId)) {
      skipped.push(protection.path);
      continue;
    }
    let release: (() => void) | undefined;
    try {
      // 恢复必须持目标路径锁：写入方仍持锁时视为 live guard，跳过。
      release = lockWorkspaceFiles([protection.path]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EBUSY") {
        skipped.push(protection.path);
        continue;
      }
      failed.push({ path: protection.path, reason: errorMessage(error, "无法锁定待恢复路径") });
      continue;
    }
    try {
      // 锁内重读当前围栏，并与本轮快照核对 guardId/版本（同代保护才允许解除）。
      const entry = protections.get(key);
      if (!entry?.pendingRegistration) continue;
      if (entry.guardId !== protection.guardId || entry.guardVersion !== protection.guardVersion) {
        skipped.push(protection.path);
        continue;
      }
      // T17：按写前事实与预期内容身份区分三类场景，只有可确认“本次写入已原子发布”才自动登记。
      const inspected = await inspectPath(entry.path);
      if (inspected.version.size < 0) {
        // 类 1：新建文件不存在 / 覆盖写未发布（原子写未 rename）：不能证明写入已发生，保留围栏。
        failed.push({ path: protection.path, reason: "文件尚未落盘，无法确认登记结果，保留保护围栏" });
        continue;
      }
      const write = entry.pendingWrite;
      const expected = write?.expectedContent;
      if (expected) {
        const actualSha = await fileSha256(inspected.path);
        if (inspected.version.size !== expected.size || actualSha !== expected.sha256) {
          const pre = write?.preWrite;
          const unchangedPre = !!pre?.exists && pre.size === inspected.version.size && Math.abs(pre.mtimeMs - inspected.version.mtimeMs) < 1;
          failed.push({
            path: protection.path,
            reason: unchangedPre
              ? "仍是覆盖写之前的旧内容，未确认本次写入发布，保留保护围栏待核对"
              : "文件内容与本次预期发布内容不符，保留保护围栏待核对",
          });
          continue;
        }
      } else if (!write || write.preWrite.exists) {
        // 类 2：覆盖写前的旧文件仍在（或旧版围栏没有预写记录）：文件存在不能区分旧内容与本次新内容，保留待核对。
        failed.push({
          path: protection.path,
          reason: write
            ? "覆盖写目标已存在旧文件，无法确认本次新内容已发布，保留保护围栏待核对"
            : "围栏缺少预写版本记录，无法确认本次写入结果，保留保护围栏待核对",
        });
        continue;
      }
      // 类 3：写前目标不存在（新建），原子写在持锁写入后发布才可能出现文件——按已发布恢复登记。
      await registerFileRecord(entry.pendingRegistration);
      await queueMutation(async () => {
        const current = protections.get(key);
        if (!current?.pendingRegistration) return;
        if (current.guardId !== protection.guardId || current.guardVersion !== protection.guardVersion) return;
        const snapshot = snapshotProtections();
        const next: FileProtection = { ...current, updatedAt: new Date().toISOString() };
        delete next.pendingRegistration;
        delete next.pendingWrite;
        delete next.guardId;
        delete next.guardVersion;
        // T15/§O.2：恢复完成只解除围栏，范围保护与未完成改名意图必须保留。
        if (next.rangeReason || next.relocationIntent) protections.set(key, next);
        else protections.delete(key);
        try {
          await persistProtections();
        } catch (error) {
          restoreProtections(snapshot);
          throw error;
        }
      });
      recovered += 1;
    } catch (error) {
      failed.push({ path: protection.path, reason: errorMessage(error, "登记保护恢复失败") });
    } finally {
      release?.();
    }
  }
  return { recovered, failed, skipped };
}

/**
 * 该物理路径是否处于登记保护中：精确路径或任一祖先目录保护（范围保护覆盖真正后代，不误匹配兄弟）。
 * 清理据此保守跳过。
 */
export async function isFileRegistrationProtected(path: string): Promise<boolean> {
  await ensureFileRecordsLoaded();
  let key = fileRecordPathKey(path);
  for (;;) {
    if (protections.has(key)) return true;
    const parent = dirname(key);
    if (parent === key) return false;
    key = parent;
  }
}

/** 源路径本身及真正后代上的登记保护（目录移动拒绝依据、范围核对）。 */
export async function listFileProtectionsUnder(path: string): Promise<FileProtection[]> {
  await ensureFileRecordsLoaded();
  const baseKey = fileRecordPathKey(path);
  return [...protections.entries()]
    .filter(([key]) => isSameOrDescendantKey(baseKey, key))
    .map(([, value]) => cloneProtection(value));
}

export async function listFileProtections(): Promise<FileProtection[]> {
  await ensureFileRecordsLoaded();
  return [...protections.values()].map(cloneProtection);
}

/**
 * 移动前持久意图（T15/§O.2，核心）：真实 `renameWorkspaceFile` **之前**把事务身份写入保护表，
 * 对 source 与 target **两侧**建立保护条目（后代匹配语义同既有范围保护）：
 * - 条目合并进既有同路径保护条目（保留登记围栏/范围保护/guardId 等字段，不覆盖其他事实）；
 * - **写入失败 ⇒ 抛错**：调用方不得移动文件；同时建立**保护表持久故障**（`setProtectionsFailure`，
 *   `writeAtomic` 先替换后 fsync，失败时意图可能已发布），并尽力把故障标记随保护表持久化——
 *   不得只回滚内存后抛错（互审 P3：重启前也要有可诊断的阻断事实）；
 * - 只有提交（rename + 归属/释放时间/定位日志全部落盘）或回滚确认落盘后才允许清除（clearFileRelocationIntent）。
 * 调用约定：调用方已持有源/目标路径锁（锁序：Q 任务锁 → 本函数所在路径锁）。
 */
export async function markFileRelocationIntent(input: {
  transactionId: string;
  directory: string;
  source: string;
  target: string;
  refs: readonly string[];
  /** §P.1：本次 affected 任务 id（Q 传入；C 侧也会从 refs 的 task 引用推导后合并）。 */
  participants?: readonly string[];
  versionBasis?: { recordIds: string[]; size: number; mtimeMs: number; sha256?: string };
}): Promise<void> {
  return queueMutation(async () => {
    const now = new Date().toISOString();
    // §P.3（R2）：命中同 transactionId 的原持久意图时，**原证据一律保留**——source/target/方向、createdAt
    // 与 versionBasis 不得被重试时的当前文件覆盖（否则外部替换 content 后重试会“用当前文件重写证据后放行”）。
    // 只合并参与集合与引用身份，并把同一意图对象挂到本次调用的两端键上（正反两方向都保持双端保护）。
    const previous = findRelocationIntentInMemory(input.transactionId);
    const participants = mergeParticipants(previous?.participants, input.participants);
    const intent: FileRelocationIntent = previous
      ? {
          ...previous,
          refs: mergeRefs(previous.refs, input.refs),
          ...(participants ? { participants } : {}),
        }
      : {
          transactionId: input.transactionId,
          directory: input.directory,
          source: input.source,
          target: input.target,
          refs: [...new Set(input.refs)],
          createdAt: now,
          ...(participants ? { participants } : {}),
          ...(input.versionBasis
            ? { versionBasis: { recordIds: [...input.versionBasis.recordIds], size: input.versionBasis.size, mtimeMs: input.versionBasis.mtimeMs, ...(input.versionBasis.sha256 ? { sha256: input.versionBasis.sha256 } : {}) } }
            : {}),
        };
    for (const path of [input.source, input.target]) {
      const key = fileRecordPathKey(path);
      const entry = protections.get(key);
      protections.set(key, {
        ...entry,
        path,
        directory: input.directory || entry?.directory || "",
        relocationIntent: intent,
        createdAt: entry?.createdAt ?? now,
        updatedAt: now,
      });
    }
    try {
      await persistProtections();
    } catch (error) {
      // 先持久后移动：写入失败不得移动文件。互审 P3：writeAtomic 先替换目标再 fsync 父目录，
      // 失败时意图可能已经发布——不得只回滚内存后抛错：保留内存保护（本进程立即阻断相关范围），
      // 建立保护表持久故障并尽力随保护表持久化（写入成功则意图与故障一起落盘，跨重启保守）。
      const failure: FileProtectionsFailure = {
        error: `移动前迁移意图持久化失败（${input.transactionId}，${input.source} → ${input.target}）：${errorMessage(error, "未知错误")}；本次未移动文件，保护状态需恢复核对（POST /api/cleanup/protections）`,
        at: new Date().toISOString(),
      };
      setProtectionsFailure(failure);
      await persistProtections().catch(persistError => console.error("移动意图故障标记持久化失败（内存保持阻断，重启需人工核对）", persistError));
      throw Object.assign(
        new Error(`移动前迁移意图无法持久化，本次未移动文件（文件仍在原位）；保护表持久故障已建立（本进程已阻断，跨重启状态需恢复核对）：${errorMessage(error, "保护表写入失败")}`),
        { code: "EINTENTPERSIST", cause: error },
      );
    }
  });
}

/** 内存中该事务的意图条目（同一事务在两端各挂一份同一对象；命中任意一份即可）。 */
function findRelocationIntentInMemory(transactionId: string): FileRelocationIntent | undefined {
  for (const entry of protections.values()) {
    if (entry.relocationIntent?.transactionId === transactionId) return entry.relocationIntent;
  }
  return undefined;
}

/** 参与集合合并（去重保序；两处都为空的旧意图不带 participants 字段，按 refs 推导参与集合）。 */
function mergeParticipants(existing: readonly string[] | undefined, incoming: readonly string[] | undefined): string[] | undefined {
  const merged: string[] = [];
  for (const id of [...(existing ?? []), ...(incoming ?? [])]) {
    if (typeof id === "string" && id && !merged.includes(id)) merged.push(id);
  }
  return merged.length ? merged : undefined;
}

/**
 * 迁移意图清除结果（§P.4，不得绝对宣称“跨重启保护仍在”）：
 * - confirmed：保护表写入成功返回，清除已落盘确认；
 * - unconfirmed：写入抛错但当前**磁盘内容已核对为无该事务意图**（writeAtomic 先替换后 fsync，失败时清除
 *   可能已发布）；此时不得宣称「保护仍在」，也不得宣称「已确认」——按未确认示警。
 * 写入失败且磁盘仍可判读有意图 / 不可判读时一律抛错（内存保守保留），由调用方如实透传。
 */
export type FileRelocationIntentClearOutcome = {
  /** 实际清除的条目数（0 表示该事务当前已无意图，按幂等成功处理）。 */
  cleared: number;
  persistence: "confirmed" | "unconfirmed";
  /** unconfirmed 时的可读说明（供调用方透传 warning）。 */
  note?: string;
};

/**
 * 读取磁盘保护表判断某事务意图当前是否仍存在（§P.4 清除失败语义）：
 * 文件缺失/可解析且无该事务 ⇒ absent；可解析且仍存在 ⇒ present；读不到或不可判读 ⇒ unknown。
 */
async function relocationIntentStateOnDisk(transactionId: string): Promise<"present" | "absent" | "unknown"> {
  let content: string | null;
  try {
    content = await readStoreFile(protectionsFilePath());
  } catch {
    return "unknown";
  }
  if (content === null) return "absent";
  try {
    const parsed = JSON.parse(content) as { protections?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.protections)) return "unknown";
    return parsed.protections.some(entry =>
      (entry as { relocationIntent?: { transactionId?: unknown } } | undefined)?.relocationIntent?.transactionId === transactionId)
      ? "present"
      : "absent";
  } catch {
    return "unknown";
  }
}

/**
 * 清除某改名事务的持久意图（T15/§O.2；提交/回滚确认落盘后，或显式人工核对）：
 * 只移除 relocationIntent 字段，条目仍带登记围栏/范围保护时保留条目本身；
 * 持久化失败时按 §P.4 核对磁盘事实后分类：清除已发布 ⇒ 返回 unconfirmed（内存与磁盘对齐，禁止宣称保护仍在）；
 * 磁盘仍存在或有意图不可判读 ⇒ 恢复内存快照（意图保留）并抛错——调用方必须如实说明对应状态。
 * 返回实际清除的条目数（0 表示该事务已无意图，按幂等成功处理）。
 */
export async function clearFileRelocationIntent(transactionId: string): Promise<FileRelocationIntentClearOutcome> {
  return queueMutation(async () => {
    const snapshot = snapshotProtections();
    let cleared = 0;
    for (const [key, entry] of [...protections]) {
      if (entry.relocationIntent?.transactionId !== transactionId) continue;
      const next: FileProtection = { ...entry, updatedAt: new Date().toISOString() };
      delete next.relocationIntent;
      if (next.pendingRegistration || next.rangeReason) protections.set(key, next);
      else protections.delete(key);
      cleared += 1;
    }
    if (!cleared) return { cleared: 0, persistence: "confirmed" as const };
    try {
      await persistProtections();
      return { cleared, persistence: "confirmed" as const };
    } catch (error) {
      // §P.4：writeAtomic 先替换目标再 fsync 父目录，失败时清除可能已经发布——不得只恢复内存后绝对宣称
      // 「跨重启保护仍在」。按当前磁盘内容分类：已无该意图 ⇒ 清除已发布（落盘未确认）；仍有 ⇒ 保护仍在；
      // 不可判读 ⇒ 结果未确认（可能已发布、也可能仍在）。
      const disk = await relocationIntentStateOnDisk(transactionId);
      if (disk === "absent") {
        const note = `迁移意图清除已发布但落盘未确认（保护表写入失败：${errorMessage(error, "未知错误")}；当前磁盘内容已核对为无该事务意图，重启不会恢复该意图屏障）`;
        noteDegraded(note);
        console.warn(note);
        return { cleared, persistence: "unconfirmed" as const, note };
      }
      restoreProtections(snapshot);
      if (disk === "present") {
        throw Object.assign(
          new Error(`迁移意图清除写入失败：当前磁盘保护仍在（本进程内存保持同一保护；可重试，或经 POST /api/cleanup/protections 显式核对）：${errorMessage(error, "保护表写入失败")}`),
          { code: "ECLEARFAILED", cause: error },
        );
      }
      throw Object.assign(
        new Error(`迁移意图清除结果未确认：保护表写入失败且当前磁盘内容不可判读（清除可能已发布、也可能仍在，需核对保护表与磁盘后重试或显式核对）：${errorMessage(error, "保护表写入失败")}`),
        { code: "ECLEARUNKNOWN", cause: error },
      );
    }
  });
}

/** 显式核对入口的意图清除结果（§P.4）：落盘确认 / 清除已发布但落盘未确认（附可读说明）。 */
export type FileRelocationIntentPathClearOutcome = {
  transactions: number;
  entries: number;
  persistence: "confirmed" | "unconfirmed";
  note?: string;
};

const relocationTaskRefPrefix = "task:";

/** §P.1 参与集合：意图持久化的 participants ∪ refs 中的任务引用（旧意图无 participants 字段时按 refs 推导）。 */
function relocationIntentParticipants(intent: FileRelocationIntent): string[] {
  const participants = new Set<string>();
  for (const id of intent.participants ?? []) {
    if (typeof id === "string" && id) participants.add(id);
  }
  for (const ref of intent.refs) {
    if (typeof ref === "string" && ref.startsWith(relocationTaskRefPrefix)) {
      const id = ref.slice(relocationTaskRefPrefix.length).trim();
      if (id) participants.add(id);
    }
  }
  return [...participants];
}

/** 任务阻断是否属于该事务：优先按 transactionId；旧记录缺失时按同一 directory 下的 source/target 对核对。 */
function relocationBlockMatchesIntent(
  block: { transactionId?: string; source: string; target: string; directory?: string },
  intent: FileRelocationIntent,
) {
  if (typeof block.transactionId === "string" && block.transactionId) return block.transactionId === intent.transactionId;
  const directory = intent.directory || block.directory || "";
  if (!directory) return false;
  const same = (left: string, right: string) =>
    fileRecordPathKey(resolve(directory, left)) === fileRecordPathKey(resolve(directory, right));
  return same(block.source, intent.source) && same(block.target, intent.target);
}

/** 任务 outputs 的当前定位（与 Q 同口径：resolvedPath 优先，正斜杠归一化）。 */
function relocationOutputCurrentPath(output: { path?: unknown; resolvedPath?: unknown }): string {
  const current = typeof output.resolvedPath === "string" && output.resolvedPath ? output.resolvedPath : output.path;
  return typeof current === "string" ? current.replaceAll("\\", "/").replace(/^\.?\//, "").replace(/\/+$/, "") : "";
}

/** 端点在目录内的工作区相对前缀（用于与任务 outputs 的定位比较；不在目录内/等于根/跨盘时返回 undefined）。 */
function relocationEndpointPrefix(directory: string, endpoint: string): string | undefined {
  const prefix = relative(resolve(directory), resolve(endpoint)).replaceAll("\\", "/").replace(/^\.?\//, "").replace(/\/+$/, "");
  if (!prefix || prefix === ".." || prefix.startsWith("../") || isAbsolute(prefix)) return undefined;
  return prefix;
}

/** 真实文件位置：目标端在且源端不在 = 已提交到目标；源端在且目标端不在 = 已回源端；其余按人工核对场景不据此阻断。 */
async function relocationEndpointPosition(intent: FileRelocationIntent): Promise<"at-target" | "at-source" | "ambiguous"> {
  const present = (path: string) => lstat(path).then(() => true, () => false);
  const [sourcePresent, targetPresent] = await Promise.all([present(intent.source), present(intent.target)]);
  if (targetPresent && !sourcePresent) return "at-target";
  if (sourcePresent && !targetPresent) return "at-source";
  return "ambiguous";
}

/**
 * Q 运行时活动判定（§P.2 ①，只读）：动态读取 Q 在 mediaTasks 暴露的 `isRelocationTransactionActive(transactionId)`。
 * 该导出尚未上线或不可用时返回 undefined（按“无法判定”处理，不阻塞持久收敛判定，也不反向等待任务锁）。
 */
async function relocationRuntimeActivity(transactionId: string): Promise<boolean | undefined> {
  try {
    const module = (await import("@/utils/mediaTasks")) as unknown as { isRelocationTransactionActive?: unknown };
    const probe = module.isRelocationTransactionActive;
    if (typeof probe !== "function") return undefined;
    return (probe as (id: string) => boolean)(transactionId) === true;
  } catch {
    return undefined;
  }
}

/**
 * §P.2 活动边界判定（R1b，只读、不取任务锁）：
 * ① Q 进程内该事务的正向/补偿调用尚未返回（Q 暴露的只读判定）；
 * ② 持久意图存在且参与集合未全部收敛（参与任务记录缺失、仍带该事务阻断、或真实文件位置与 outputs 定位不一致）。
 * 返回可读原因；判定为未活动时返回 undefined。
 */
async function relocationIntentActivityReason(intent: FileRelocationIntent): Promise<string | undefined> {
  if (await relocationRuntimeActivity(intent.transactionId) === true) {
    return "该事务的任务输出提交/补偿仍在进行（事务进行中，请稍后核对）";
  }
  const participants = relocationIntentParticipants(intent);
  if (!participants.length) return undefined;
  await ensureMediaTasksStore().catch(() => undefined);
  if (!mediaTasksStoreLoaded()) return "任务存储未就绪，无法核对参与集合（事务进行中，请稍后核对）";
  for (const taskId of participants) {
    const task = getMediaTask(taskId);
    if (!task) return `参与任务 ${taskId} 的任务记录缺失，无法确认该事务已收敛（缺任务不能当整组完成，需先核对任务账本）`;
    const block = effectiveRelocationBlock(task);
    if (block && relocationBlockMatchesIntent(block, intent)) {
      return `参与任务 ${taskId} 仍有该事务的未解除改名阻断（${block.source} → ${block.target}），需先按任务阻断记录完成恢复`;
    }
  }
  const position = await relocationEndpointPosition(intent);
  if (position === "ambiguous") return undefined;
  const directory = intent.directory;
  if (!directory) return undefined;
  // 提交后（文件在目标端）outputs 仍指源端 / 补偿后（文件回源端）outputs 仍指目标端：定位未收敛。
  const stalePrefix = position === "at-target"
    ? relocationEndpointPrefix(directory, intent.source)
    : relocationEndpointPrefix(directory, intent.target);
  if (!stalePrefix) return undefined;
  for (const taskId of participants) {
    const task = getMediaTask(taskId);
    if (!task) continue;
    const stale = task.outputs.find(output => {
      const current = relocationOutputCurrentPath(output);
      return !!current && (current === stalePrefix || current.startsWith(`${stalePrefix}/`));
    });
    if (stale) {
      return `参与任务 ${taskId} 的 outputs 仍指向 ${stale.resolvedPath ?? stale.path}，与真实文件位置（${position === "at-target" ? "已在目标端" : "已回源端"}）不一致，事务未收敛（需先完成 outputs 提交或补偿）`;
    }
  }
  return undefined;
}

/**
 * 清除结果分类（§P.4）：全部事务在磁盘上均已无意图 ⇒ published（清除已发布，落盘未确认）；
 * 任一事务磁盘上仍有意图 ⇒ present（写入失败、保护仍在）；其余（不可判读）⇒ unknown（结果未确认）。
 */
async function classifyRelocationIntentClearFailure(transactionIds: readonly string[]): Promise<"published" | "present" | "unknown"> {
  const states = await Promise.all(transactionIds.map(transactionId => relocationIntentStateOnDisk(transactionId)));
  if (states.some(state => state === "present")) return "present";
  if (states.length > 0 && states.every(state => state === "absent")) return "published";
  return "unknown";
}

/**
 * 显式核对入口专用：清除与给定路径相关（条目路径或事务两端之一为该路径本身/后代）的全部改名意图。
 * 一次核对按事务整体清除两端（半个事务的意图保留不一致）；返回事务数与条目数供回执统计。
 * 互审 P5：先取相关路径的工作区路径锁，避免在「写意图 → rename → migrate」窗口内被人工调用
 * 清掉在途意图（锁忙按 409 返回，由调用方稍后重试）；锁内以最新保护表复核。
 * §P.2（R1b）：清除前必须先查活动边界——Q 运行时该事务仍在提交/补偿，或持久参与集合未全部收敛（参与任务
 * 缺失、仍带该事务阻断、outputs 与真实文件位置不一致）时返回 **409 忙状态**并给出可读原因
 * （含 transactionId 与两端路径），不把“路径锁空闲”当作“整个改名已完成”。
 * §P.4：清除落盘失败时按磁盘事实分类——清除已发布按 unconfirmed 返回（不得宣称保护仍在）；
 * 磁盘仍有意图/不可判读时恢复内存并抛错，如实说明对应状态。
 * 锁序说明：本函数只取路径锁，不取任务锁——与改名事务（Q 任务锁 → C 路径锁）不构成反序/环；
 * 活动判定是 Q 的只读查询与任务账本只读核对，不反向等待任务锁。
 */
export async function clearFileRelocationIntentsForPath(path: string): Promise<FileRelocationIntentPathClearOutcome> {
  const requested = resolve(path);
  const key = fileRecordPathKey(requested);
  await ensureFileRecordsLoaded();
  const match = (entryKey: string, intent: FileRelocationIntent) =>
    isSameOrDescendantKey(key, entryKey)
    || isSameOrDescendantKey(key, fileRecordPathKey(intent.source))
    || isSameOrDescendantKey(key, fileRecordPathKey(intent.target));
  // 只读预扫：收集相关事务的条目/两端路径作为加锁集合；持锁后按最新保护表复核。
  const lockPaths = new Set<string>([requested]);
  let anyMatch = false;
  for (const [entryKey, entry] of protections) {
    const intent = entry.relocationIntent;
    if (!intent || !match(entryKey, intent)) continue;
    anyMatch = true;
    for (const candidate of [entry.path, intent.source, intent.target]) {
      if (typeof candidate === "string" && candidate) lockPaths.add(resolve(candidate));
    }
  }
  if (!anyMatch) return { transactions: 0, entries: 0, persistence: "confirmed" };
  let release: (() => void) | undefined;
  try {
    release = lockWorkspaceFiles([...lockPaths]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBUSY") {
      throw Object.assign(new Error("相关路径正在使用（可能存在进行中的改名事务），请稍后重试显式核对"), { status: 409, code: "EBUSY" });
    }
    throw error;
  }
  try {
    return await queueMutation(async () => {
      // 锁内复核：预扫到加锁之间可能有变更；在途事务要么已结束（无匹配则 0），要么已被路径锁挡住。
      const transactionIds = new Set<string>();
      const intents = new Map<string, FileRelocationIntent>();
      for (const [entryKey, entry] of protections) {
        const intent = entry.relocationIntent;
        if (intent && match(entryKey, intent)) {
          transactionIds.add(intent.transactionId);
          if (!intents.has(intent.transactionId)) intents.set(intent.transactionId, intent);
        }
      }
      if (!transactionIds.size) return { transactions: 0, entries: 0, persistence: "confirmed" as const };
      // §P.2（R1b）：有活动事务时拒绝解除（409），可读原因包含 transactionId 与两端路径。
      const busy: string[] = [];
      for (const [transactionId, intent] of intents) {
        const reason = await relocationIntentActivityReason(intent);
        if (reason) busy.push(`事务 ${transactionId}（${intent.source} → ${intent.target}）：${reason}`);
      }
      if (busy.length) {
        throw Object.assign(
          new Error(`存在进行中的改名事务，暂不能解除事务保护（事务进行中，请稍后核对）：${busy.join("；")}`),
          { status: 409, code: "EBUSY" },
        );
      }
      const snapshot = snapshotProtections();
      let entries = 0;
      for (const [entryKey, entry] of [...protections]) {
        const transactionId = entry.relocationIntent?.transactionId;
        if (!transactionId || !transactionIds.has(transactionId)) continue;
        const next: FileProtection = { ...entry, updatedAt: new Date().toISOString() };
        delete next.relocationIntent;
        if (next.pendingRegistration || next.rangeReason) protections.set(entryKey, next);
        else protections.delete(entryKey);
        entries += 1;
      }
      try {
        await persistProtections();
        return { transactions: transactionIds.size, entries, persistence: "confirmed" as const };
      } catch (error) {
        const classification = await classifyRelocationIntentClearFailure([...transactionIds]);
        if (classification === "published") {
          const note = `迁移意图清除已发布但落盘未确认（保护表写入失败：${errorMessage(error, "未知错误")}；当前磁盘内容已核对为无相关事务意图，重启不会恢复该意图屏障）`;
          noteDegraded(note);
          console.warn(note);
          return { transactions: transactionIds.size, entries, persistence: "unconfirmed" as const, note };
        }
        restoreProtections(snapshot);
        if (classification === "present") {
          throw Object.assign(
            new Error(`改名事务意图清除写入失败：当前磁盘保护仍在（本进程内存保持同一保护；可重试，或核对保护表后重试显式核对）：${errorMessage(error, "保护表写入失败")}`),
            { code: "ECLEARFAILED", cause: error },
          );
        }
        throw Object.assign(
          new Error(`改名事务意图清除结果未确认：保护表写入失败且当前磁盘内容不可判读（清除可能已发布、也可能仍在，需核对保护表与磁盘后重试或显式核对）：${errorMessage(error, "保护表写入失败")}`),
          { code: "ECLEARUNKNOWN", cause: error },
        );
      }
    });
  } finally {
    release?.();
  }
}

/** 待处理改名意图摘要（按 transactionId 去重；供诊断、状态接口与 readiness 展示）。 */
export async function listFileRelocationIntents(): Promise<FileRelocationIntentSummary[]> {
  await ensureFileRecordsLoaded();
  return relocationIntentsSnapshot();
}

/** 同步快照（readiness 判据同步可读；未加载完成时为空）。 */
function relocationIntentsSnapshot(): FileRelocationIntentSummary[] {
  const seen = new Map<string, FileRelocationIntentSummary>();
  for (const entry of protections.values()) {
    const intent = entry.relocationIntent;
    if (!intent || seen.has(intent.transactionId)) continue;
    const participants = relocationIntentParticipants(intent);
    seen.set(intent.transactionId, {
      transactionId: intent.transactionId,
      directory: intent.directory,
      source: intent.source,
      target: intent.target,
      createdAt: intent.createdAt,
      reason: entry.rangeReason ?? "改名事务提交/回滚未确认，两端保护仍在，需清理核对",
      ...(participants.length ? { participants } : {}),
    });
  }
  return [...seen.values()];
}

/**
 * 未完成改名事务意图的保护判定（T15/§O.2/§3.1，§P.3 统一判定）：该物理路径自身或任一祖先目录上存在
 * 意图条目 ⇒ true。两端条目均以本方式覆盖其后代；清理占用判定据此保持
 * （意图存在期间不得删除，不受 updatedAt 保留期策略影响）。改名、覆盖写、清理、显式核对共用本判定。
 */
export async function isFileRelocationIntentProtected(path: string): Promise<boolean> {
  return (await findFileIntentProtectionAtOrAbove(path)) !== undefined;
}

/** 未完成事务端点（含后代）的普通写入/覆盖写拒绝事实（§P.3；含事务身份、两端与恢复路径）。 */
export type FileRelocationWriteBlock = {
  transactionId: string;
  directory: string;
  source: string;
  target: string;
  message: string;
};

/**
 * 普通覆盖写前的统一保护判定（§P.3/R2）：路径自身或任一祖先处于未完成改名事务范围 ⇒ 返回可读拒绝事实。
 * 调用方（文件写路由等）必须在真实写入前消费本判定（不得“先写后看”）。
 */
export async function findFileRelocationWriteBlock(path: string): Promise<FileRelocationWriteBlock | undefined> {
  const protection = await findFileIntentProtectionAtOrAbove(path);
  const intent = protection?.relocationIntent;
  if (!intent) return undefined;
  return {
    transactionId: intent.transactionId,
    directory: intent.directory,
    source: intent.source,
    target: intent.target,
    message: `该路径位于未完成的改名事务保护范围内（事务 ${intent.transactionId}：${intent.source} → ${intent.target}），为避免改写未完成事务的文件，本次写入已拒绝；请先完成该事务的精确重试或人工核对恢复（POST /api/cleanup/protections），恢复后再重试本次写入`,
  };
}

/** 按事务身份读取持久意图（只读；同事务两端为同一对象，取首条命中即可）。 */
export async function findFileRelocationIntentByTransactionId(transactionId: string): Promise<FileRelocationIntent | undefined> {
  await ensureFileRecordsLoaded();
  return findRelocationIntentInMemory(transactionId);
}

/**
 * 该路径自身或任一祖先上的改名意图条目（改名目标端核对、覆盖写判定与清理占用共用同一判定）。
 * §P.3/R1c 兜底：兼容升级前遗留的「单端意图」（归属迁移后源端条目曾被移走），除按键与祖先命中外，
 * 还按意图记录的 source/target 反查——路径落在任一端点自身或其真正后代时同样视为处于保护范围。
 */
export async function findFileIntentProtectionAtOrAbove(path: string): Promise<FileProtection | undefined> {
  await ensureFileRecordsLoaded();
  const targetKey = fileRecordPathKey(path);
  let key = targetKey;
  for (;;) {
    const entry = protections.get(key);
    if (entry?.relocationIntent) return cloneProtection(entry);
    const parent = dirname(key);
    if (parent === key) break;
    key = parent;
  }
  for (const entry of protections.values()) {
    const intent = entry.relocationIntent;
    if (!intent) continue;
    if (isSameOrDescendantKey(fileRecordPathKey(intent.source), targetKey)
      || isSameOrDescendantKey(fileRecordPathKey(intent.target), targetKey)) {
      return cloneProtection(entry);
    }
  }
  return undefined;
}

/**
 * 范围保护（无法自动恢复的失败保护）：写入持久原因，清理跳过涉及范围，需上层核对后显式解除。
 * T15/N.2：范围保护写入失败**不得只撤销内存修改**——保留内存保护（本进程清理/改名立刻被阻断），
 * 同时建立持久故障标记（尽力写盘；跨重启保守），并把错误传播给调用方作为硬失败（停止本次操作）。
 */
export async function markFileRangeProtected(entries: { path: string; directory?: string; reason: string }[]): Promise<void> {
  if (!entries.length) return;
  return queueMutation(async () => {
    const now = new Date().toISOString();
    for (const entry of entries) {
      const key = fileRecordPathKey(entry.path);
      const previous = protections.get(key);
      protections.set(key, {
        path: entry.path,
        directory: entry.directory ?? previous?.directory ?? "",
        ...(previous?.pendingRegistration ? { pendingRegistration: previous.pendingRegistration } : {}),
        ...(previous?.pendingWrite ? { pendingWrite: previous.pendingWrite } : {}),
        // T15/§O.2：范围保护与未完成改名意图叠加时两者都保留（以更保守者为准，意图不因范围保护写入被覆盖）。
        ...(previous?.relocationIntent ? { relocationIntent: previous.relocationIntent } : {}),
        rangeReason: entry.reason,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      });
    }
    try {
      await persistProtections();
    } catch (error) {
      // §6.2/§O.3 文案真实性：首次持久写入失败只能说「本进程已阻断」；故障标记随保护表尽力持久化，
      // 是否跨重启有效必须由恢复核对确认，不得在 marker 也写不进去时宣称跨重启已保证。
      const failure: FileProtectionsFailure = {
        error: `范围保护持久化失败（${entries.map(entry => entry.path).join("、").slice(0, 200)}）：${errorMessage(error, "未知错误")}；本进程内清理与后续改名已阻断（跨重启保护未确认），需恢复核对（POST /api/cleanup/protections）`,
        at: new Date().toISOString(),
      };
      setProtectionsFailure(failure);
      await persistProtections().catch(persistError => console.error("范围保护写入失败后故障标记持久化失败（内存保持阻断，重启需人工核对）", persistError));
      throw error;
    }
  });
}

/** 显式解除某路径的范围保护；返回是否实际清除了范围保护（供恢复入口回执统计真实清除数）。 */
export async function clearFileRangeProtection(path: string): Promise<boolean> {
  return queueMutation(async () => {
    const key = fileRecordPathKey(path);
    const entry = protections.get(key);
    if (!entry?.rangeReason) return false;
    const snapshot = snapshotProtections();
    // 条目仍承载未完成登记围栏或改名事务意图（T15/§O.2）时只清除 rangeReason，保留条目本身。
    if (entry.pendingRegistration || entry.relocationIntent) {
      const next: FileProtection = { ...entry, updatedAt: new Date().toISOString() };
      delete next.rangeReason;
      protections.set(key, next);
    } else protections.delete(key);
    try {
      await persistProtections();
    } catch (error) {
      restoreProtections(snapshot);
      throw error;
    }
    return true;
  });
}

/** 保护表故障快照（供状态接口展示；故障未显式清除前清理必须暂停删除）。 */
export function fileProtectionsFailureSnapshot(): FileProtectionsFailure | undefined {
  return protectionsFailure ? { ...protectionsFailure } : undefined;
}

/** 编辑释放时间表故障快照（T14；未显式清除前释放时间未知，自动删除保持暂停）。 */
export function editingReleasesFailureSnapshot(): FileProtectionsFailure | undefined {
  return editingReleasesFailure ? { ...editingReleasesFailure } : undefined;
}

/** 归属记录表故障快照（T03；未显式清除前归属未知，自动删除与新生成准入都必须保持阻断）。 */
export function fileRecordsFailureSnapshot(): FileRecordsFailure | undefined {
  return recordsFailure ? { ...recordsFailure } : undefined;
}

/**
 * 显式恢复核对（T16/T14/T03）：确认故障前的归属/保护/释放数据已人工核对/处置后清除持久故障标记
 * （归属记录表、保护表与编辑释放时间表故障一并清除）。必须提供核对原因；
 * 普通写入成功不得调用本函数代替核对。仅故障状态清除，历史保护条目与释放时间不受影响。
 */
export async function clearProtectionsStoreFailure(reason: string): Promise<void> {
  const note = reason.trim();
  if (!note) throw new Error("显式恢复核对必须提供核对原因");
  return queueMutation(async () => {
    if (!protectionsFailure && !editingReleasesFailure && !recordsFailure) return;
    const previousProtections = protectionsFailure;
    const previousReleases = editingReleasesFailure;
    const previousRecords = recordsFailure;
    if (previousProtections) setProtectionsFailure(undefined);
    if (previousReleases) setEditingReleasesFailure(undefined);
    if (previousRecords) setRecordsFailure(undefined);
    let persistedRecords = false;
    let persistedProtections = false;
    try {
      if (previousRecords) {
        await persistRecords();
        persistedRecords = true;
      }
      await persistProtections();
      persistedProtections = true;
      if (previousReleases) await persistEditingReleases();
    } catch (error) {
      if (previousProtections) setProtectionsFailure(previousProtections);
      if (previousReleases) setEditingReleasesFailure(previousReleases);
      if (previousRecords) setRecordsFailure(previousRecords);
      // 已成功抹掉故障标记的存储要把标记写回，否则重启后会被误判为健康（写回失败时内存保持阻断）。
      if (persistedRecords) await persistRecords().catch(persistError => console.error("恢复失败后归属故障标记写回失败（内存保持阻断）", persistError));
      if (persistedProtections) await persistProtections().catch(persistError => console.error("恢复失败后保护故障标记写回失败（内存保持阻断）", persistError));
      throw error;
    }
    noteDegraded(`归属/保护/释放状态故障已显式核对恢复（${note}）`
      + (previousProtections ? `；原保护表故障：${previousProtections.error}` : "")
      + (previousReleases ? `；原释放时间表故障：${previousReleases.error}` : "")
      + (previousRecords ? `；原归属记录表故障：${previousRecords.error}` : ""));
  });
}

/**
 * 归属存储健康：加载失败、保护记录/释放时间记录不可解析、存在无法确认的坏条目或保护表状态未知时
 * ok=false（清理必须暂停删除，新生成准入按 T03 保守不放行）。签名稳定，字段可扩展。
 */
export async function fileRecordsStoreHealth(): Promise<FileRecordsStoreHealth> {
  try {
    await ensureFileRecordsLoaded();
  } catch (error) {
    return { ok: false, error: errorMessage(error, "文件归属存储不可用") };
  }
  return healthSnapshot();
}

/** 健康快照（同步）：未加载完成或保护/释放状态不可用时 ok=false，供就绪判定使用。 */
export function fileRecordsStoreHealthSnapshot(): FileRecordsStoreHealth {
  return healthSnapshot();
}

/**
 * 保护/归属就绪快照（T03，同步、可诊断；Q 的生成准入与 I 的 health 展示共用）：
 * - protectionsInitialized=false 且无故障：首次空安装（健康空表，可与“已有保护状态未知”区分）；
 * - protections/releases 为 unknown（文件缺失、坏表、故障未显式恢复）或存储未加载 → ok=false；
 * - relocationIntents：未完成改名事务意图（T15/§O.2）：非空即表示存在待处理迁移（两端受保护），
 *   不改变 ok（合法在途事务不阻断准入），供诊断与人工核对（POST /api/cleanup/protections）。
 */
export function fileRecordsReadinessSnapshot(): FileRecordsReadiness {
  const health = healthSnapshot();
  const relocationIntents = relocationIntentsSnapshot();
  return {
    ok: health.ok,
    loaded: storeReady,
    protections: protectionsFailure || !storeReady ? "unknown" : "ok",
    protectionsInitialized,
    ...(protectionsFailure ? { protectionsFailure: { ...protectionsFailure } } : {}),
    releases: editingReleasesFailure || !storeReady ? "unknown" : "ok",
    ...(editingReleasesFailure ? { releasesFailure: { ...editingReleasesFailure } } : {}),
    records: recordsFailure || !storeReady ? "unknown" : "ok",
    ...(recordsFailure ? { recordsFailure: { ...recordsFailure } } : {}),
    ...(relocationIntents.length ? { relocationIntents } : {}),
    ...(health.error ? { error: health.error } : {}),
    ...(health.degraded ? { degraded: health.degraded } : {}),
  };
}

/**
 * 恢复范围保护所覆盖的祖先目录保护（不含精确路径与后代）：目录改名/移动前核对两端祖先保护，
 * 受保护目录内的子文件不得通过普通 rename 移出保护范围。无祖先保护时返回 undefined。
 */
export async function findFileAncestorProtection(path: string): Promise<FileProtection | undefined> {
  await ensureFileRecordsLoaded();
  let key = dirname(fileRecordPathKey(path));
  for (;;) {
    const entry = protections.get(key);
    if (entry) return cloneProtection(entry);
    const parent = dirname(key);
    if (parent === key) return undefined;
    key = parent;
  }
}

/**
 * 显式核对解除未完成登记围栏（POST /api/cleanup/protections 的人工核对入口使用）：
 * 只清除该路径的 pendingRegistration/pendingWrite（进程内正在写入的 live guard 拒绝清除并抛 409），
 * 返回是否实际清除了围栏；归属账本与范围保护不受影响。
 */
export async function clearFileRegistrationFence(path: string): Promise<boolean> {
  return queueMutation(async () => {
    const key = fileRecordPathKey(path);
    const entry = protections.get(key);
    if (!entry?.pendingRegistration) return false;
    if (entry.guardId && liveGuardIds.has(entry.guardId)) {
      throw Object.assign(new Error("该路径正在写入（live guard），不能解除登记围栏"), { status: 409, code: "EBUSY" });
    }
    const snapshot = snapshotProtections();
    const next: FileProtection = { ...entry, updatedAt: new Date().toISOString() };
    delete next.pendingRegistration;
    delete next.pendingWrite;
    delete next.guardId;
    delete next.guardVersion;
    // T15/§O.2：显式解除登记围栏只清围栏字段，范围保护与未完成改名意图保留（意图由专用核对清除）。
    if (next.rangeReason || next.relocationIntent) protections.set(key, next);
    else protections.delete(key);
    try {
      await persistProtections();
    } catch (error) {
      restoreProtections(snapshot);
      throw error;
    }
    return true;
  });
}

/**
 * 改名/移动跟随（递归，事务化）：源路径本身与真正后代的归属迁移到目标树（保留 id、createdAt、refs 与计时，
 * 刷新版本并清除清理标记；目标同 (sourceKind, mediaKind) 归属合并为一条）。源路径记录随之移除。
 * 未完成登记保护随真实路径迁移；编辑占用释放时间（T14/T15）随 rename 迁移到新路径，改名不得缩短保留期。
 * 调用方必须已持有源/目标路径锁（本函数不取路径锁）。
 *
 * 事务边界（T15）：一次提交 records + protections + editingReleases + relocations 的持久内容；
 * 每次 inspectPath/unindex/index 与每次持久写都在事务快照之后执行——任一步（含逐条迁移的 I/O）失败
 * 先恢复全部内存快照，再把已经写出的存储文件按快照重写（持久回滚），不留下半迁移内存；
 * 持久回滚也失败时抛 EROLLBACKFAILED 明确阻断（调用方必须建立持久范围保护），不得把文件/账本回滚当作已完成。
 * options.recordRelocation 提供时，同一事务内追加重定位日志（没有事务外的单独追加入口）。
 */
export async function migrateFileRecord(
  oldPath: string,
  newPath: string,
  options: { recordRelocation?: { directory: string } } = {},
): Promise<MigrateFileRecordsResult> {
  return queueMutation(async () => {
    const fromKey = fileRecordPathKey(oldPath);
    const moving = collectUnderKey(fromKey);
    const source = resolve(oldPath);
    const targetBase = resolve(newPath);
    const plans: { record: FileRecord; newAbs: string }[] = [];
    for (const record of moving) {
      const suffix = relative(source, record.path);
      const newAbs = suffix ? join(targetBase, suffix) : targetBase;
      // 归属只跟随工作区内文件；跨工作区移动不继承（保持原记录，避免错误归属）。
      if (!isWithin(record.directory, newAbs)) continue;
      if (fileRecordPathKey(newAbs) === fileRecordPathKey(record.path)) continue;
      plans.push({ record, newAbs });
    }
    const movingProtections = [...protections.entries()].filter(([key]) => isSameOrDescendantKey(fromKey, key));
    const movingReleases = [...editingReleases.entries()].filter(([key]) => isSameOrDescendantKey(fromKey, key));
    if (!plans.length && !movingProtections.length && !movingReleases.length) return { migrated: 0, recordIds: [], refs: [], paths: [] };
    // 先取全部快照，再执行任何 inspectPath/unindex/index 与持久写：逐条迁移 I/O 抛错也不能留下半迁移内存。
    const recordsSnapshot = snapshotRecords();
    const protectionBackup = snapshotProtections();
    const releasesBackup = new Map(editingReleases);
    const relocationsBackup = [...relocations];
    let relocatedReleases = 0;
    let migrated = 0;
    const recordIds: string[] = [];
    const refs: string[] = [];
    const paths: { from: string; to: string }[] = [];
    let recordsWritten = false;
    let protectionsWritten = false;
    let releasesWritten = false;
    let relocationsWritten = false;
    try {
      for (const { record, newAbs } of plans) {
        const inspected = await inspectPath(newAbs);
        const key = fileRecordPathKey(inspected.path);
        const sibling = recordsAt(key).find(item => item.id !== record.id && item.sourceKind === record.sourceKind && item.mediaKind === record.mediaKind);
        unindexRecord(record);
        if (sibling) {
          // ACT: 目标已有同一归属：合并引用与保留期，不产生两条重复归属。
          indexRecord({
            ...sibling, path: inspected.path, directory: record.directory, version: inspected.version,
            updatedAt: laterOf(sibling.updatedAt, record.updatedAt) ?? sibling.updatedAt,
            completedAt: laterOf(sibling.completedAt, record.completedAt),
            cleanedAt: undefined, cleanupIntentAt: undefined, refs: mergeRefs(sibling.refs, record.refs),
          });
          recordIds.push(sibling.id);
        } else {
          indexRecord({ ...record, path: inspected.path, version: inspected.version, cleanedAt: undefined, cleanupIntentAt: undefined });
          recordIds.push(record.id);
        }
        refs.push(...record.refs);
        paths.push({ from: record.path, to: inspected.path });
        migrated += 1;
      }
      for (const [key, protection] of movingProtections) {
        protections.delete(key);
        const sourcePath = resolve(protection.path);
        const suffix = relative(source, sourcePath);
        const newAbs = suffix ? join(targetBase, suffix) : targetBase;
        const targetKey = fileRecordPathKey(newAbs);
        const targetPrevious = protections.get(targetKey);
        const sourcePending = protection.pendingRegistration
          ? { ...protection.pendingRegistration, path: newAbs }
          : undefined;
        // 互审 P6：目标键已有条目时按字段合并，保留目标既有的 rangeReason/登记围栏等事实，不得直接覆盖。
        // 登记围栏（pendingRegistration/pendingWrite/guardId/guardVersion）按“同一代整组”取自目标侧或源侧，
        // 不跨代混合；两侧范围保护原因同时存在且不同则合并保留（仅人工核对文案，不丢事实）。
        const keepTargetFence = !!targetPrevious?.pendingRegistration;
        const pendingRegistration = keepTargetFence ? targetPrevious!.pendingRegistration : sourcePending;
        const pendingWrite = keepTargetFence ? targetPrevious!.pendingWrite : protection.pendingWrite;
        const guardId = keepTargetFence ? targetPrevious!.guardId : protection.guardId;
        const guardVersion = keepTargetFence ? targetPrevious!.guardVersion : protection.guardVersion;
        const rangeReason = targetPrevious?.rangeReason && protection.rangeReason && targetPrevious.rangeReason !== protection.rangeReason
          ? `${targetPrevious.rangeReason}；${protection.rangeReason}`
          : targetPrevious?.rangeReason ?? protection.rangeReason;
        const relocationIntent = targetPrevious?.relocationIntent ?? protection.relocationIntent;
        protections.set(targetKey, {
          path: newAbs,
          directory: targetPrevious?.directory || protection.directory || moving[0]?.directory || "",
          ...(pendingRegistration ? { pendingRegistration } : {}),
          ...(pendingWrite ? { pendingWrite } : {}),
          ...(rangeReason ? { rangeReason } : {}),
          ...(relocationIntent ? { relocationIntent } : {}),
          ...(guardId ? { guardId } : {}),
          ...(guardVersion !== undefined ? { guardVersion } : {}),
          createdAt: targetPrevious?.createdAt ?? protection.createdAt,
          updatedAt: new Date().toISOString(),
        });
        // §P.3/R1c（双端保护固定）：未完成事务的端点保护不得随归属迁移收缩——事务意图条目继续保留在源端
        // （直到协调层按唯一解除时点统一清除），使 source、target 及后代在整个未完成期间都被同一判定覆盖；
        // 其余围栏/范围保护仍按既有语义只随真实路径迁移（避免同一代围栏同时挂在两处）。
        if (protection.relocationIntent) {
          protections.set(key, {
            path: protection.path,
            directory: protection.directory || moving[0]?.directory || "",
            relocationIntent: protection.relocationIntent,
            createdAt: protection.createdAt,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      for (const [key, entry] of movingReleases) {
        // T15：编辑释放时间随 rename 迁移（改名后新路径仍按“最后实际解除时间”计算完整保留期）。
        const suffix = relative(source, resolve(entry.path));
        const newAbs = suffix ? join(targetBase, suffix) : targetBase;
        const newKey = fileRecordPathKey(newAbs);
        editingReleases.delete(key);
        if (newKey === key) {
          editingReleases.set(key, { directory: entry.directory, path: newAbs, releasedAt: entry.releasedAt });
          relocatedReleases += 1;
          continue;
        }
        const previous = editingReleases.get(newKey);
        if (!previous || Date.parse(previous.releasedAt) < Date.parse(entry.releasedAt)) {
          editingReleases.set(newKey, { directory: entry.directory, path: newAbs, releasedAt: entry.releasedAt });
        }
        relocatedReleases += 1;
      }
      const uniqueRefs = [...new Set(refs)];
      const relocationEntries = options.recordRelocation && uniqueRefs.length
        ? [{ directory: options.recordRelocation.directory, from: source, to: targetBase, refs: uniqueRefs, at: new Date().toISOString() }]
        : [];
      if (relocationEntries.length) {
        relocations.push(...relocationEntries);
        if (relocations.length > maxRelocations) relocations = relocations.slice(-maxRelocations);
      }
      // T15/N.2「可能已发布即视为已发布」：writeAtomic 先替换目标再 fsync 父目录，后者失败时文件可能已经改变；
      // 因此在**发起写入之前**就标记本次尝试，回滚时对全部已发起过的存储文件按快照重写（不再只补“成功返回”的项）。
      recordsWritten = true;
      await persistRecords();
      if (movingProtections.length > 0) {
        protectionsWritten = true;
        await persistProtections();
      }
      if (relocatedReleases > 0) {
        releasesWritten = true;
        await persistEditingReleases();
      }
      if (relocationEntries.length) {
        relocationsWritten = true;
        await persistRelocations();
      }
      return { migrated, recordIds, refs: uniqueRefs, paths };
    } catch (error) {
      // 内存先回到事务前状态；再把已经（或可能已经）写出的存储文件重写回快照（持久回滚），不只恢复内存。
      restoreRecordsSnapshot(recordsSnapshot);
      restoreProtections(protectionBackup);
      editingReleases.clear();
      for (const [key, value] of releasesBackup) editingReleases.set(key, value);
      relocations = relocationsBackup;
      const rolledBack = await (async () => {
        try {
          if (recordsWritten) await persistRecords();
          if (protectionsWritten) await persistProtections();
          if (releasesWritten) await persistEditingReleases();
          if (relocationsWritten) await persistRelocations();
          return true;
        } catch {
          return false;
        }
      })();
      const message = errorMessage(error, "归属迁移写入失败");
      if (!rolledBack) {
        // T15：持久回滚未完成时账本内存与磁盘可能不一致——建立归属持久故障（清理与新生成准入同时阻断），
        // 跨重启保持保守并需人工核对（POST /api/cleanup/protections 显式恢复）。
        const failure: FileRecordsFailure = {
          error: `归属迁移失败且持久回滚未完成，账本状态需人工核对：${message}`,
          at: new Date().toISOString(),
        };
        setRecordsFailure(failure);
        await persistRecords().catch(persistError => console.error("归属迁移回滚失败后的故障标记持久化失败（内存保持阻断，重启需人工核对）", persistError));
        throw Object.assign(new Error(`归属迁移失败且持久回滚未完成，账本状态需人工核对：${message}`), { code: "EROLLBACKFAILED", cause: error });
      }
      throw error;
    }
  });
}

/**
 * 复制跟随（递归）：为每个副本文件产生新记录 ID，计时从复制完成起，不照搬原任务/编辑占用的
 * 活跃身份（refs 为空，按实际使用另行登记）；源记录不动。调用方必须已持有源/目标路径锁。
 */
export async function duplicateFileRecords(sourcePath: string, targetPath: string): Promise<DuplicateFileRecordsResult> {
  return queueMutation(async () => {
    const moving = collectUnderKey(fileRecordPathKey(sourcePath));
    if (!moving.length) return { duplicated: 0, recordIds: [] };
    const source = resolve(sourcePath);
    const targetBase = resolve(targetPath);
    const mapped: { record: FileRecord; newAbs: string }[] = [];
    for (const record of moving) {
      const suffix = relative(source, record.path);
      const newAbs = suffix ? join(targetBase, suffix) : targetBase;
      if (!isWithin(record.directory, newAbs)) continue;
      if (fileRecordPathKey(newAbs) === fileRecordPathKey(record.path)) continue;
      mapped.push({ record, newAbs });
    }
    if (!mapped.length) return { duplicated: 0, recordIds: [] };
    const backupKeys = new Set<string>();
    for (const { newAbs } of mapped) backupKeys.add(fileRecordPathKey(newAbs));
    const backup = [...backupKeys].map(pathKey => ({ pathKey, records: recordsAt(pathKey).map(cloneRecord) }));
    const now = new Date().toISOString();
    const recordIds: string[] = [];
    for (const { record, newAbs } of mapped) {
      const inspected = await inspectPath(newAbs);
      const id = crypto.randomUUID();
      indexRecord({
        id, path: inspected.path, directory: record.directory, sourceKind: record.sourceKind, mediaKind: record.mediaKind,
        version: inspected.version, createdAt: now, updatedAt: now, completedAt: now, refs: [],
      });
      recordIds.push(id);
    }
    // T15：可能已发布即视为已发布——先标记本次写入尝试，失败回滚时按快照重写存储（不只恢复内存）。
    let recordsWritten = false;
    try {
      recordsWritten = true;
      await persistRecords();
    } catch (error) {
      await restoreRecords(backup);
      const rolledBack = await (async () => {
        try {
          if (recordsWritten) await persistRecords();
          return true;
        } catch {
          return false;
        }
      })();
      if (!rolledBack) {
        throw Object.assign(new Error(`复制登记失败且持久回滚未完成，账本状态需人工核对：${errorMessage(error, "归属写入失败")}`), { code: "EROLLBACKFAILED", cause: error });
      }
      throw error;
    }
    return { duplicated: recordIds.length, recordIds };
  });
}

/**
 * 删除跟随（递归）：移除被删除路径本身与真正后代的归属记录及相关登记保护。
 * §P.3/R1c：携带未完成改名事务意图的保护条目不随普通删除清账（事务屏障保持到协调层统一解除或显式核对）。
 */
export async function removeFileRecords(path: string): Promise<RemoveFileRecordsResult> {
  return queueMutation(async () => {
    const baseKey = fileRecordPathKey(path);
    const moving = collectUnderKey(baseKey);
    const protectionBackup = snapshotProtections();
    let protectionsChanged = false;
    for (const [key, entry] of [...protections]) {
      if (!isSameOrDescendantKey(baseKey, key)) continue;
      // §P.3/R1c：未完成改名事务的意图条目（连同条目上的其他保护事实）不得随普通删除清账丢失——
      // 事务屏障只能由协调层提交/补偿确认或显式核对清除，与登记围栏/范围保护的“只清本类字段”口径一致。
      if (entry.relocationIntent) continue;
      protections.delete(key);
      protectionsChanged = true;
    }
    if (!moving.length && !protectionsChanged) return { removed: 0, recordIds: [] };
    const backupKeys = [...new Set(moving.map(record => fileRecordPathKey(record.path)))];
    const backup = backupKeys.map(pathKey => ({ pathKey, records: recordsAt(pathKey).map(cloneRecord) }));
    const recordIds = moving.map(record => record.id);
    for (const record of moving) unindexRecord(record);
    // T15：两个存储的写入尝试都可能已发布（replace 后 fsync 失败）；回滚按快照重写全部已发起的存储。
    let recordsWritten = false;
    let protectionsWritten = false;
    try {
      recordsWritten = true;
      await persistRecords();
      if (protectionsChanged) {
        protectionsWritten = true;
        await persistProtections();
      }
    } catch (error) {
      await restoreRecords(backup);
      restoreProtections(protectionBackup);
      const rolledBack = await (async () => {
        try {
          if (recordsWritten) await persistRecords();
          if (protectionsWritten) await persistProtections();
          return true;
        } catch {
          return false;
        }
      })();
      if (!rolledBack) {
        throw Object.assign(new Error(`归属清账失败且持久回滚未完成，账本状态需人工核对：${errorMessage(error, "归属写入失败")}`), { code: "EROLLBACKFAILED", cause: error });
      }
      throw error;
    }
    return { removed: recordIds.length, recordIds };
  });
}

export async function listFileRecords(filter: { directory?: string; sourceKind?: FileSourceKind } = {}): Promise<FileRecord[]> {
  await ensureFileRecordsLoaded();
  const directory = filter.directory ? fileRecordPathKey(filter.directory) : undefined;
  return [...records.values()]
    .filter(record => (!directory || fileRecordPathKey(record.directory) === directory) && (!filter.sourceKind || record.sourceKind === filter.sourceKind))
    .map(cloneRecord);
}

/** 该物理路径的全部归属记录（多归属）；供清理删除前复核与“已清理”展示使用，只读不改保留期。 */
export async function getFileRecordsByPath(path: string): Promise<FileRecord[]> {
  await ensureFileRecordsLoaded();
  return recordsAt(fileRecordPathKey(path)).map(cloneRecord);
}

/** 该物理路径最早登记的归属记录（单条展示用）；无记录时返回 undefined。 */
export async function getFileRecordByPath(path: string): Promise<FileRecord | undefined> {
  return (await getFileRecordsByPath(path))[0];
}

/** 源路径本身及真正后代的归属记录（目录操作与终态输出定位使用）。 */
export async function getFileRecordsUnder(path: string): Promise<FileRecord[]> {
  await ensureFileRecordsLoaded();
  return collectUnderKey(fileRecordPathKey(path)).map(cloneRecord);
}

/**
 * 查找一次已完成的改名（同工作区、源/目标完全一致）。可选 refs 约束身份：
 * 只有重定位日志的 refs 与期望身份相交才视为已确认，避免旧路径复用后串到别的任务。
 */
export async function findFileRelocation(directory: string, from: string, to: string, refs?: readonly string[]): Promise<FileRelocation | undefined> {
  await ensureFileRecordsLoaded();
  const directoryKey = fileRecordPathKey(directory);
  const fromKey = fileRecordPathKey(resolve(from));
  const toKey = fileRecordPathKey(resolve(to));
  const wanted = refs?.length ? new Set(refs) : undefined;
  return [...relocations].reverse().find(entry =>
    fileRecordPathKey(entry.directory) === directoryKey
    && fileRecordPathKey(resolve(entry.from)) === fromKey
    && fileRecordPathKey(resolve(entry.to)) === toKey
    && (!wanted || entry.refs.some(ref => wanted.has(ref))));
}

/**
 * 解析改名后的实际文件定位：输入旧路径（工作区内相对或绝对），返回最新目标路径；
 * 未发生可追踪的改名时返回 undefined。链路多跳时逐跳解析（有界）。
 * options.refs 提供时按任务/资产身份约束：只使用 refs 相交的重定位条目（日志淘汰或旧路径被复用
 * 时返回 undefined，而不是把旧任务串到新文件）。
 */
export async function resolveRelocatedFilePath(
  directory: string,
  path: string,
  options: { refs?: readonly string[] } = {},
): Promise<{ path: string; relocatedFrom: string; refs: string[] } | undefined> {
  await ensureFileRecordsLoaded();
  const original = isAbsolute(path) ? resolve(path) : resolve(directory, path);
  const directoryKey = fileRecordPathKey(directory);
  const wanted = options.refs?.length ? new Set(options.refs) : undefined;
  let current = original;
  const refs = new Set<string>();
  let moved = false;
  for (let hop = 0; hop < 10; hop += 1) {
    const currentKey = fileRecordPathKey(current);
    const entry = [...relocations].reverse().find(item =>
      fileRecordPathKey(item.directory) === directoryKey
      && isSameOrDescendantKey(fileRecordPathKey(item.from), currentKey)
      && (!wanted || (item.refs.length > 0 && item.refs.some(ref => wanted.has(ref)))));
    if (!entry) break;
    const suffix = relative(resolve(entry.from), current);
    current = suffix ? join(resolve(entry.to), suffix) : resolve(entry.to);
    for (const ref of entry.refs) refs.add(ref);
    moved = true;
  }
  if (!moved) return undefined;
  return { path: current, relocatedFrom: original, refs: [...refs] };
}

/**
 * 释放时间条目合并（同一路径只保留“较晚”的 releasedAt，保持保留期不缩短）与容量收敛；
 * 条目在写入前已通过时间可解析校验，这里按解析后的时间点比较（不同 ISO 写法不因字典序误判）。
 */
function applyEditingReleaseEntries(entries: readonly EditingReleaseEntry[]) {
  for (const entry of entries) {
    const key = fileRecordPathKey(entry.path);
    const previous = editingReleases.get(key);
    if (previous && Date.parse(previous.releasedAt) >= Date.parse(entry.releasedAt)) continue;
    editingReleases.set(key, { directory: entry.directory, path: entry.path, releasedAt: entry.releasedAt });
  }
  if (editingReleases.size > maxEditingReleases) {
    const oldest = [...editingReleases.entries()].sort((left, right) => Date.parse(left[1].releasedAt) - Date.parse(right[1].releasedAt));
    for (const [key] of oldest.slice(0, editingReleases.size - maxEditingReleases)) editingReleases.delete(key);
  }
}

/**
 * 编辑占用保护下限 + 租约版本代次的单次持久提交（T14，释放/过期/续租共用同一批量持久化）：
 * - releases：最后保护解除时间下限（保留期“较晚起点”）；
 * - count：预留的版本代次数量，成功返回 base（本次可用版本为 base+1..base+count），
 *   过期移除/重启后版本都不再从 1 重新开始；
 * 调用方（续租）必须在**确认续租成功之前**调用；失败时不改变任何内存状态并抛错。
 * releasedAt 非法的条目不得被当作有效时间参与保留期：建立持久未知状态并拒绝本次写入。
 */
export async function persistEditingRenewal(input: {
  releases: readonly EditingReleaseEntry[];
  count?: number;
}): Promise<{ base: number }> {
  const count = Number.isInteger(input.count) && (input.count ?? 0) > 0 ? input.count! : 0;
  if (!input.releases.length && !count) return { base: editingLeaseGeneration };
  const invalid = input.releases.find(entry => !isParsableTime(entry.releasedAt));
  if (invalid) {
    await markEditingReleasesStoreFailure(`编辑占用释放时间非法（无法解析且有限）：${invalid.path}`, invalid.releasedAt);
    throw Object.assign(new Error("编辑占用释放时间必须是可解析且有限的 ISO 时间"), { code: "EINVALID", status: 400 });
  }
  return queueMutation(async () => {
    const releasesBackup = new Map(editingReleases);
    const generationBackup = editingLeaseGeneration;
    const base = editingLeaseGeneration;
    applyEditingReleaseEntries(input.releases);
    if (count) editingLeaseGeneration = base + count;
    try {
      await persistEditingReleases();
    } catch (error) {
      editingReleases.clear();
      for (const [key, value] of releasesBackup) editingReleases.set(key, value);
      editingLeaseGeneration = generationBackup;
      throw error;
    }
    return { base };
  });
}

/**
 * 持久记录编辑占用的实际释放时间（显式释放或断联过期；T14 保留期“较晚起点”数据源之一）。
 * 同一路径只保留最新释放时间；失败时恢复内存快照并传播错误。
 */
export async function recordEditingReleases(entries: readonly EditingReleaseEntry[]): Promise<void> {
  if (!entries.length) return;
  await persistEditingRenewal({ releases: entries });
}

/** 该物理路径最近一次编辑占用实际解除时间（持久；无记录时 undefined）。 */
export async function lastEditingReleasedAt(path: string): Promise<string | undefined> {
  await ensureFileRecordsLoaded();
  return editingReleases.get(fileRecordPathKey(path))?.releasedAt;
}

/** 在目录边界内取真实定位：存在时 realpath，缺失时用最近存在祖先的真实根拼接（不越界）。 */
async function canonicalWithin(base: string, target: string) {
  let current = target;
  for (;;) {
    const info = await lstat(current).catch(() => null);
    if (info) {
      const real = await realpath(current).catch(() => current);
      return current === target ? real : join(real, relative(current, target));
    }
    if (current === base) return target;
    const next = dirname(current);
    if (next === current || !isWithin(base, next)) return target;
    current = next;
  }
}

async function outputStateOf(base: string, path: string): Promise<FileOutputStatus> {
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path);
  if (!isWithin(base, target)) throw Object.assign(new Error("文件路径不在工作区内"), { status: 403 });
  const canonical = await canonicalWithin(base, target);
  const exists = await lstat(canonical).then(info => info.isFile() || info.isDirectory(), () => false);
  if (exists) return { state: "available", path: canonical };
  const list = recordsAt(fileRecordPathKey(canonical));
  if (list.length && list.every(record => !!record.cleanedAt)) {
    const cleanedAt = list.map(record => record.cleanedAt!).sort();
    return { state: "cleaned", path: canonical, cleanedAt: cleanedAt[cleanedAt.length - 1] };
  }
  return { state: "missing", path: canonical };
}

/**
 * 任务输出/页面视图的输出可用性判定数据（消费方：Q 的任务摘要、W 的节点与文件视图）：
 * available=文件存在；cleaned=全部归属完成清理且文件不存在（附 cleanedAt）；missing=无清理依据的缺失。
 */
export async function getFileOutputState(directory: string, path: string): Promise<FileOutputStatus> {
  await ensureFileRecordsLoaded();
  return outputStateOf(resolve(directory), path);
}

/** 批量版本（每项异常退化为 missing，不中断整体；键为传入的原始路径字符串）。 */
export async function getFileOutputStates(directory: string, paths: readonly string[]): Promise<Record<string, FileOutputStatus>> {
  await ensureFileRecordsLoaded();
  const base = resolve(directory);
  const result: Record<string, FileOutputStatus> = {};
  for (const path of paths) {
    try {
      result[path] = await outputStateOf(base, path);
    } catch {
      result[path] = { state: "missing", path: typeof path === "string" ? path : "" };
    }
  }
  return result;
}

/** 该路径是否已被自动清理（全部归属完成清理且文件不存在）：旧页面写入据此阻断复活。 */
export async function isFileCleanedByCleanup(path: string): Promise<boolean> {
  await ensureFileRecordsLoaded();
  const target = resolve(path);
  const exists = await lstat(target).then(() => true, () => false);
  if (exists) return false;
  const list = recordsAt(fileRecordPathKey(target));
  return list.length > 0 && list.every(record => !!record.cleanedAt);
}
