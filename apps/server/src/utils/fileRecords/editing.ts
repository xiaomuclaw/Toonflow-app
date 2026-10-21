import { fileRecordPathKey, isSameOrDescendantKey, markEditingReleasesStoreFailure, persistEditingRenewal, recordEditingReleases } from "@/utils/fileRecords";

/**
 * 编辑占用（会话级集合）：占用身份 = 登录身份摘要 + 页面实例（pageId）+ 租约实例（leaseId）+ 规范目录 + 路径。
 * 客户端约每 30 秒续租一次并由路由持同一路径锁提交；服务端按断联宽限 5 分钟保留保护，
 * 关闭编辑器主动释放；续租递增 version（释放与清理复核依据）。
 * T14：pageId 是“真实页面实例”（sessionStorage 持久），复制标签可能沿用同一 pageId；leaseId 是
 * “每次租约实例”（每次进入编辑的页面会话生成，create/renew 携带并由服务端回显），两者共同作为占用键：
 * 同页不同租约实例互不合并；新租约释放必须**同时**满足 leaseId 与逐路径 version（缺失/错位不降级），
 * 迟到/不带完整身份的释放不得删掉后建立的租约。只有显式旧格式客户端（无 leaseId 且无 versions）
 * 才走兼容分支：只释放无 leaseId 的 legacy 记录。
 * 版本取自跨过期不复用的持久代次（每次续租前持久预留），过期移除/重启后都不再从 1 重算。
 * hidden 不主动释放，过期后的旧页面写入仍由 revision 与清理记录在写入接口处阻断。
 * 释放/过期/续租都把「最后保护解除时间下限」持久写入 fileRecords 侧（重启丢租约但保护下限保留）；
 * 停机收尾 finalizeEditingOccupancyOnShutdown() 为仍生效的占用持久写入解除时间，失败建立持久故障。
 */
export type EditingOccupancyEntry = {
  /** 登录身份摘要（session:<token 摘要> 或本机 local）。 */
  loginDigest: string;
  /** 页面实例 UUID；旧客户端未提供时用 editingDefaultPageId 兼容“每登录单页面”行为。 */
  pageId: string;
  /** 每次租约实例身份；旧客户端缺省（legacy 占用，见模块注释的显式降级语义）。 */
  leaseId?: string;
  /** 规范工作区根（realpath 后）。 */
  directory: string;
  /** 规范文件路径（realpath 优先，缺失时按工作区内词法路径）。 */
  path: string;
  /** 占用版本：每次续租递增；释放/删除复核与旧回调阻断依据。 */
  version: number;
  createdAt: string;
  renewedAt: string;
  /** 到期时间（ms epoch）；续租从最近一次续租重新计算宽限。 */
  expiresAt: number;
};

/** 建议客户端续租周期。 */
export const editingOccupancyRenewIntervalMs = 30 * 1000;
/** 断联宽限：超过该时间未续租的占用不再生效。 */
export const editingOccupancyGraceMs = 5 * 60 * 1000;
/** 旧客户端（不带 pageId）的兼容页面身份。 */
export const editingDefaultPageId = "default";

const pruneIntervalMs = 60 * 1000;
const entries = new Map<string, EditingOccupancyEntry>();
let pruneTimer: ReturnType<typeof setInterval> | undefined;
let releaseFlush: Promise<void> = Promise.resolve();

/** 租约实例身份（T14）：trim 后 1-128 字符；缺省/非法按旧客户端（legacy）处理。 */
export function editingLeaseIdOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 128) : undefined;
}

function entryKey(loginDigest: string, pageId: string, leaseKey: string, directoryKey: string, pathKey: string) {
  return `${loginDigest}\u0000${pageId}\u0000${leaseKey}\u0000${directoryKey}\u0000${pathKey}`;
}

/**
 * 过期巡检：过期条目不再生效；其释放时间异步持久化（失败保留条目，下次巡检重试）。
 * 只清理“同一对象未被续租替换”的条目，避免续租与过期回调交错时误写释放时间/误删新占用。
 */
function pruneExpired(now = Date.now()) {
  const expired: { key: string; entry: EditingOccupancyEntry }[] = [];
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) expired.push({ key, entry });
  }
  if (!expired.length) return;
  releaseFlush = releaseFlush.then(() => persistExpiredReleases(expired)).catch(error => {
    console.warn("编辑占用过期释放时间持久化失败，将在下次巡检重试", error);
  });
}

async function persistExpiredReleases(expired: { key: string; entry: EditingOccupancyEntry }[]) {
  const pending = expired.filter(({ key, entry }) => entries.get(key) === entry);
  if (!pending.length) return;
  await recordEditingReleases(pending.map(({ entry }) => ({
    directory: entry.directory,
    path: entry.path,
    releasedAt: new Date(entry.expiresAt).toISOString(),
  })));
  for (const { key, entry } of pending) {
    if (entries.get(key) === entry) entries.delete(key);
  }
}

function ensurePruneTimer() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => pruneExpired(), pruneIntervalMs);
  pruneTimer.unref?.();
}

/** 对外视图：到期时间用 ISO 字符串表达（JSON 友好）。 */
export type EditingOccupancyView = Omit<EditingOccupancyEntry, "expiresAt"> & { expiresAt: string };

function toPublic(entry: EditingOccupancyEntry): EditingOccupancyView {
  return { ...entry, expiresAt: new Date(entry.expiresAt).toISOString() };
}

export type RenewEditingOccupanciesResult = {
  expiresAt: string;
  items: { path: string; version: number; leaseId?: string; expiresAt: string; conflict?: boolean }[];
};

/**
 * 登记/续租一批编辑占用（同一登录身份 + 同一页面实例 + 同一租约实例 + 同一目录 + 显式路径集合）。
 * 只创建或延长传入路径；不传入的路径自然过期，不因其他文件的续租被延长。
 * leaseId 可选（前端每个租约实例生成并持久携带）：提供时占用按 (pageId, leaseId) 独立记账并随 items 回显，
 * 同 pageId 的复制标签/多次进入编辑互不覆盖；缺省为 legacy 占用（旧客户端显式降级语义）。
 * versions 可选：与 paths 按位置对齐的期望版本；不一致时照常续租（仍是本页面占用）但在
 * 条目上返回 conflict=true，供页面重新同步版本。
 * T14/N.3（异步）：确认续租前先把**保护下限**（本次占用覆盖到的解除时点）与**版本代次**
 * 用同一批量持久化提交（persistEditingRenewal）；持久化失败则本次续租不确认并抛错，
 * 不改变任何内存占用。版本取自跨过期不复用的持久代次（base+1..base+count），过期移除/重启后都从 1 重算的旧行为已废除。
 * 调用约定：路由必须已持这些路径的工作区文件锁（清理删除持同一锁，续租不会与删除交错）。
 */
export async function renewEditingOccupancies(input: {
  loginDigest: string;
  pageId: string;
  leaseId?: string;
  directory: string;
  paths: readonly string[];
  versions?: readonly (number | undefined)[];
}): Promise<RenewEditingOccupanciesResult> {
  const now = Date.now();
  const expiresAt = now + editingOccupancyGraceMs;
  const at = new Date(now).toISOString();
  const directoryKey = fileRecordPathKey(input.directory);
  const leaseId = editingLeaseIdOf(input.leaseId);
  // T14：保护下限 = 本次续租覆盖到的解除时点（max(now, expiresAt)）；异常退出/崩溃后重启的清理
  // 依据该持久下限重算完整保留期，页面未恢复连接也不会按旧时间删除刚被编辑过的文件。
  const lowerBound = new Date(Math.max(now, expiresAt)).toISOString();
  let base = 0;
  if (input.paths.length) {
    try {
      base = (await persistEditingRenewal({
        releases: input.paths.map(path => ({ directory: input.directory, path, releasedAt: lowerBound })),
        count: input.paths.length,
      })).base;
    } catch (error) {
      await markEditingReleasesStoreFailure("编辑占用续租保护下限/版本代次持久化失败，本次续租未确认", error);
      throw Object.assign(new Error(`编辑占用保护无法持久化，本次续租未确认：${error instanceof Error ? error.message : "写入失败"}`), { status: 503, code: "EPERSIST" });
    }
  }
  const items: RenewEditingOccupanciesResult["items"] = [];
  input.paths.forEach((path, index) => {
    const pathKey = fileRecordPathKey(path);
    const key = entryKey(input.loginDigest, input.pageId, leaseId ?? "", directoryKey, pathKey);
    const previous = entries.get(key);
    const expected = input.versions?.[index];
    const version = base + index + 1;
    const conflict = expected !== undefined && previous !== undefined && previous.version !== expected;
    entries.set(key, {
      loginDigest: input.loginDigest,
      pageId: input.pageId,
      ...(leaseId ? { leaseId } : {}),
      directory: input.directory,
      path,
      version,
      createdAt: previous?.createdAt ?? at,
      renewedAt: at,
      expiresAt,
    });
    items.push({ path, version, ...(leaseId ? { leaseId } : {}), expiresAt: new Date(expiresAt).toISOString(), ...(conflict ? { conflict } : {}) });
  });
  pruneExpired(now);
  ensurePruneTimer();
  return { expiresAt: new Date(expiresAt).toISOString(), items };
}

export type ReleaseEditingOccupanciesResult = {
  released: number;
  skipped: { path: string; reason: string }[];
};

/**
 * 释放编辑占用：只删除属于同一登录身份 + 同一 pageId 的条目（任意页面不能释放他人占用）。
 * 传入 paths 时释放这些路径；缺省释放该页面（可按目录/租约限定）的全部占用。
 * 身份匹配（T14/N.3，防止迟到释放删掉后建立的租约）：新租约释放必须**同时**满足
 * leaseId（本次 hold 实例）与逐路径 version；任一缺失、错位或部分缺失都不得静默降级——
 * 按「不匹配」处理并返回可读原因（不做只按 leaseId 的降级释放）。
 * 只有请求不带任何身份（无 leaseId 且无 versions）的**显式旧格式客户端**才走兼容分支：
 * 只释放无 leaseId 的 legacy 记录，带 leaseId 的新代次占用一律跳过。
 * 释放时间先持久写入 fileRecords 侧（保留期“较晚起点”），失败保留内存占用并传播错误。
 * 调用约定：路由必须已持被释放路径的工作区文件锁。
 */
export async function releaseEditingOccupancies(input: {
  loginDigest: string;
  pageId: string;
  leaseId?: string;
  directory?: string;
  paths?: readonly string[];
  versions?: readonly (number | undefined)[];
}): Promise<ReleaseEditingOccupanciesResult> {
  pruneExpired();
  const directoryKey = input.directory ? fileRecordPathKey(input.directory) : undefined;
  const leaseId = editingLeaseIdOf(input.leaseId);
  const pathKeyList = input.paths?.length ? input.paths.map(path => fileRecordPathKey(path)) : undefined;
  const pathKeys = pathKeyList ? new Set(pathKeyList) : undefined;
  const versionsProvided = input.versions !== undefined;
  // 版本必须与路径按位置对齐；长度不一致/任一项缺失都按“身份不完整”处理（不静默降级为只按 leaseId 释放）。
  const versionsAligned = versionsProvided && pathKeyList !== undefined && input.versions!.length === pathKeyList.length;
  const versionByPathKey = new Map<string, number>();
  if (versionsAligned) {
    pathKeyList!.forEach((key, index) => {
      const version = input.versions![index];
      if (version !== undefined) versionByPathKey.set(key, version);
    });
  }
  const targets: { key: string; entry: EditingOccupancyEntry }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const [key, entry] of entries) {
    if (entry.loginDigest !== input.loginDigest) continue;
    if (entry.pageId !== input.pageId) continue;
    if (directoryKey && fileRecordPathKey(entry.directory) !== directoryKey) continue;
    const pathKey = fileRecordPathKey(entry.path);
    if (pathKeys && !pathKeys.has(pathKey)) continue;
    if (leaseId !== undefined || versionsProvided) {
      // 新格式释放：leaseId 与逐路径 version 必须同时满足，任一缺失/错位按不匹配处理。
      if (leaseId === undefined) {
        skipped.push({ path: entry.path, reason: "缺少租约实例身份（leaseId），未释放新代次占用" });
        continue;
      }
      if (!versionsAligned) {
        skipped.push({ path: entry.path, reason: "缺少与路径对齐的逐路径版本（versions），未做降级释放" });
        continue;
      }
      const expected = versionByPathKey.get(pathKey);
      if (expected === undefined) {
        skipped.push({ path: entry.path, reason: "该路径缺少占用版本，未做降级释放" });
        continue;
      }
      if (entry.leaseId !== leaseId) {
        skipped.push({ path: entry.path, reason: "租约实例不匹配，未释放其他租约实例的占用" });
        continue;
      }
      if (entry.version !== expected) {
        skipped.push({ path: entry.path, reason: "占用版本不一致，未释放更新的占用" });
        continue;
      }
      targets.push({ key, entry });
      continue;
    }
    // 显式旧格式客户端（无 leaseId 且无 versions）：只释放无 leaseId 的旧格式记录。
    if (entry.leaseId !== undefined) {
      skipped.push({ path: entry.path, reason: "缺少租约身份或版本，未释放新代次占用（旧客户端只释放无 leaseId 的旧租约）" });
      continue;
    }
    targets.push({ key, entry });
  }
  if (!targets.length) return { released: 0, skipped };
  const releasedAt = new Date().toISOString();
  await recordEditingReleases(targets.map(({ entry }) => ({ directory: entry.directory, path: entry.path, releasedAt })));
  for (const { key, entry } of targets) {
    if (entries.get(key) === entry) entries.delete(key);
  }
  return { released: targets.length, skipped };
}

/** 该物理路径是否有生效的编辑占用（清理删除前复核使用）。 */
export function hasActiveEditingOccupancy(directory: string, path: string): boolean {
  return getActiveEditingOccupancy(directory, path) !== undefined;
}

/** 该物理路径当前生效的编辑占用条目（含 version）；清理删除前在同一路径锁内复核。 */
export function getActiveEditingOccupancy(directory: string, path: string): EditingOccupancyEntry | undefined {
  pruneExpired();
  const directoryKey = fileRecordPathKey(directory);
  const pathKey = fileRecordPathKey(path);
  for (const entry of entries.values()) {
    if (fileRecordPathKey(entry.directory) === directoryKey && fileRecordPathKey(entry.path) === pathKey) return entry;
  }
  return undefined;
}

/** 源路径本身及真正后代上的编辑占用（目录移动拒绝依据）。 */
export function listActiveEditingUnder(directory: string, path: string): EditingOccupancyEntry[] {
  pruneExpired();
  const directoryKey = fileRecordPathKey(directory);
  const baseKey = fileRecordPathKey(path);
  return [...entries.values()].filter(entry =>
    fileRecordPathKey(entry.directory) === directoryKey && isSameOrDescendantKey(baseKey, fileRecordPathKey(entry.path)));
}

/** 列出占用（可按登录身份/页面/租约实例/目录过滤），用于诊断与验收核对；不刷新到期时间。 */
export function listEditingOccupancies(filter: { loginDigest?: string; pageId?: string; leaseId?: string; directory?: string } = {}): EditingOccupancyView[] {
  pruneExpired();
  const directoryKey = filter.directory ? fileRecordPathKey(filter.directory) : undefined;
  const leaseId = editingLeaseIdOf(filter.leaseId);
  return [...entries.values()]
    .filter(entry => (!filter.loginDigest || entry.loginDigest === filter.loginDigest)
      && (!filter.pageId || entry.pageId === filter.pageId)
      && (leaseId === undefined || entry.leaseId === leaseId)
      && (!directoryKey || fileRecordPathKey(entry.directory) === directoryKey))
    .map(toPublic);
}

/** 停机清理：清巡检定时器与全部内存条目（I 的停止协调可经 stopCleanup 一次性调用）。 */
export function disposeEditingOccupancy() {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = undefined;
  }
  entries.clear();
}

/**
 * 停机收尾（T14；供 Q/I 在停止协调内调用，签名稳定）：
 * `finalizeEditingOccupancyOnShutdown(): Promise<void>`
 * 1) 等待此前排队中的释放/过期持久化收敛；
 * 2) 为仍生效的占用持久写入「最后实际保护解除时间」到 fileRecords 侧——
 *    取 max(now, expiresAt)，重启后按该时点重算**完整**保留期（活动租约只存内存，正常停止不得直接清空丢依据）；
 * 3) 清巡检定时器与内存条目。
 * T14：持久化失败时**建立持久未知状态**（跨重启暂停自动删除，需显式核对恢复），
 * 并把错误抛给调用方；不得只打印告警后按旧时间继续退出。重复调用幂等。
 */
export async function finalizeEditingOccupancyOnShutdown(): Promise<void> {
  const snapshot = [...entries.values()];
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = undefined;
  }
  try {
    await releaseFlush.catch(() => undefined);
    if (snapshot.length) {
      const now = Date.now();
      await recordEditingReleases(snapshot.map(entry => ({
        directory: entry.directory,
        path: entry.path,
        // 保守：按租约原本会持续到的时点作为解除时间，完整保留期不因停机被压缩。
        releasedAt: new Date(Math.max(now, entry.expiresAt)).toISOString(),
      })));
    }
  } catch (error) {
    await markEditingReleasesStoreFailure("停机收尾写入编辑占用解除时间失败，释放时间未知，需人工核对", error).catch(() => undefined);
    throw error;
  } finally {
    entries.clear();
  }
}
