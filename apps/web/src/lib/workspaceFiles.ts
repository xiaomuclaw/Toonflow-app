import axios from "axios";
import { isMobile, isRemoteConnection } from "./platform";
import { ElMessage } from "element-plus";
import { toValue, type MaybeRefOrGetter } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { registerApiLanguage } from "@/lib/i18n";
import { attachAuthInterceptor } from "@/lib/authClient";

type WorkspaceEntry = { name: string; path: string; type: "file" | "directory" };
export type TextSnapshot = { text: string; revision: string; encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" };
const client = axios.create({ baseURL: "/api/workspaces/files", headers: { "x-toonflow-workspace": "1" } });
registerApiLanguage(client);
// ACT: 工作区文件请求统一走登录过期处理（保留草稿，不强制刷新）。
attachAuthInterceptor(client);
/** 显式声明来源的文件类型；缺省不发送，未登记文件不会被自动清理。 */
type FileKind = "generatedText" | "generatedImage" | "generatedVideo" | "original";
const fileUrls = new Map<string, { directory: string; path: string; url: Promise<string>; users: number }>();

function cachePath(path: string) {
  return path.replaceAll("\\", "/").split("/").filter(part => part && part !== ".").join("/").toLowerCase();
}

function invalidateUrls(directory: string, path: string) {
  // ACT: 仅失效时保守合并路径写法；实际读取仍交服务端校验，区分大小写的文件最多多读一次。
  directory = cachePath(directory);
  path = cachePath(path);
  for (const [key, entry] of fileUrls) {
    const entryPath = cachePath(entry.path);
    if (cachePath(entry.directory) === directory && (entryPath === path || entryPath.startsWith(`${path}/`))) fileUrls.delete(key);
  }
}

/* -------------------------------------------------- W4 编辑占用（页面会话级） */

/**
 * 编辑占用：编辑中的工作区文件统一从这里登记，供清理器在删除前复核“编辑中”保护。
 * T14/v4 §I 分两层身份：
 *  - 真实页面实例 pageId（sessionStorage 持久，同一标签页的所有 bundle 共享）。复制标签、带 opener 的同源
 *    新页面会复制 sessionStorage，因此这里做碰撞处理：Web Locks 优先、BroadcastChannel 探询兜底，
 *    探测到同一身份已被其他存活实例持有时本实例重新分配（先到者保留），不再假设 sessionStorage 一定独立。
 *  - 每个 hold 的出网租约实例 leaseId：新建 hold 时生成，同一页面跨 hold 绝不复用（身份重新分配时轮换）；
 *    create/renew 与 DELETE 都携带本 hold 的 leaseId 与逐路径 versions，释放必须同时满足两者，
 *    迟到释放不得删掉过期后重开的新占用（服务端按 leaseId 与版本匹配，两者都没有的老客户端只释放 legacy）。
 * 一个页面会话共用一份续租计时器（默认约 30 秒，以服务端返回的 renewAfterMs 为准），不按文件另起定时器；
 * hidden 不主动释放；关闭编辑器调用 release() 主动释放；页面断联由服务端宽限（约 5 分钟）兜底。
 * 只读预览/播放不登记长期占用，只有真正进入编辑（或待回写结果）时才调用。
 * 后端接口（C 提供，路由文件 routes/cleanup/editing/{create,get,release}.ts，一个方法一个文件）：
 *   POST   /api/cleanup/editing/create   { directory, paths: string[], pageId, leaseId, versions? } 登记/续租本 hold 的占用（逐 hold 单独请求）
 *   DELETE /api/cleanup/editing/release  { directory, paths: string[], pageId, leaseId, versions } 释放本 hold 的占用（版本未知时不发送）
 *   GET    /api/cleanup/editing/get?directory=&pageId=                   只读查询占用（诊断/核对，不续期）
 * versions 与 paths 按位置对齐；create 返回 items[].version/conflict/expiresAt（conflict 先重读版本再登记一轮；
 * expiresAt 是服务端确认的保护下限，下一次续租必须早于它）；release 返回 released/skipped/deferred
 * （未释放要可见，保护保留到服务端宽限到期）。按执行契约 §N.3：create/renew 由服务端在响应成功前持久化
 * 可恢复的保护下限，W 在确认成功前不写回版本/下限，也绝不发送缺版本的释放。
 */
const editingRenewFallbackMs = 30000;
/** T14：页面实例身份（sessionStorage 持久）；同一标签页跨 bundle 共享。 */
const editingPageIdStorageKey = "toonflow.editingPageId";
const editingPageIdHostKey = Symbol.for("toonflow.editingPageIdHost");
const editingHoldErrorEvent = "toonflow:editing-hold-error";
/** T14：页面实例身份的跨标签协商（复制标签/带 opener 的新页面会复制 sessionStorage）。 */
const editingPageIdChannelName = "toonflow.editing-page-identity";
const editingPageIdLockPrefix = "toonflow-editing-identity:";
const editingPageIdProbeMs = 400;
const editingPageIdClaimAttempts = 5;
type EditingPageIdHost = {
  id: string;
  channel?: BroadcastChannel;
  /** 已成功声明（或已探询确认）独占了哪一个身份值；不等于当前 id 时需要重新协商。 */
  claimedId?: string;
  lockHeld?: string;
  claiming?: Promise<void>;
};
const editingPageIdHost = globalThis as typeof globalThis & { [editingPageIdHostKey]?: EditingPageIdHost };

function editingIdentityHost(): EditingPageIdHost {
  return editingPageIdHost[editingPageIdHostKey] ?? (editingPageIdHost[editingPageIdHostKey] = { id: "" });
}

function createEditingPageId() {
  return crypto.randomUUID();
}

/** 读取当前页面实例 UUID（不触发碰撞协商，协商在后台进行；协商后身份变化会重新登记占用）。 */
export function getEditingPageId(): string {
  const host = editingIdentityHost();
  if (!host.id) {
    let stored = "";
    try { stored = sessionStorage.getItem(editingPageIdStorageKey) ?? ""; } catch { /* 仅内存身份 */ }
    host.id = stored || createEditingPageId();
    try { sessionStorage.setItem(editingPageIdStorageKey, host.id); } catch { /* 仅内存身份 */ }
    void ensureEditingPageIdentity();
  }
  return host.id;
}

type EditingLocks = { request(name: string, options: { ifAvailable: boolean }, callback: (lock: unknown) => unknown): Promise<unknown> };

function editingChannel(): BroadcastChannel | undefined {
  const host = editingIdentityHost();
  if (host.channel) return host.channel;
  if (typeof BroadcastChannel === "undefined") return undefined;
  try {
    const channel = new BroadcastChannel(editingPageIdChannelName);
    channel.addEventListener("message", event => {
      const message = event.data as { type?: string; id?: string } | null;
      if (!message || typeof message.id !== "string") return;
      // 另一个同源页面正在声明同一个身份：先到者保留，应答让后来者重新分配。
      if (message.type === "probe" && message.id === host.id) channel.postMessage({ type: "occupied", id: host.id });
    });
    host.channel = channel;
    return channel;
  } catch {
    return undefined;
  }
}

/** 探询同一身份是否已被其他存活页面实例持有（同一标签页内的 bundle 共享 host，不会自问自答）。 */
function probeEditingPageIdOccupied(id: string): Promise<boolean> {
  const channel = editingChannel();
  if (!channel) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.removeEventListener("message", listener);
      resolve(value);
    };
    const listener = (event: MessageEvent) => {
      const message = event.data as { type?: string; id?: string } | null;
      if (message?.type === "occupied" && message.id === id) finish(true);
    };
    const timer = setTimeout(() => finish(false), editingPageIdProbeMs);
    channel.addEventListener("message", listener);
    channel.postMessage({ type: "probe", id });
  });
}

/**
 * T14：声明当前页面实例身份是否独占。优先 Web Locks（先到者持有身份锁直到页面销毁），
 * 其次 BroadcastChannel 探询；两者都不可用时按现有会话身份继续（同一标签页内仍然一致）。
 */
async function claimEditingPageId(host: EditingPageIdHost): Promise<boolean> {
  const locks = (navigator as Navigator & { locks?: EditingLocks }).locks;
  if (host.lockHeld === host.id) return true;
  if (locks?.request) {
    const claimed = await new Promise<boolean>(resolve => {
      void locks.request(`${editingPageIdLockPrefix}${host.id}`, { ifAvailable: true }, lock => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        // 持有到页面销毁：其他实例无法同时声明同一身份。
        return new Promise<void>(() => {});
      }).catch(() => resolve(false));
    }).catch(() => false);
    if (!claimed) return false;
    host.lockHeld = host.id;
    return true;
  }
  // 没有 Web Locks 时用一次探询确认身份未被占用；此后由常驻监听应答后续复制标签的探询。
  return !(await probeEditingPageIdOccupied(host.id));
}

/**
 * T14：确保页面实例身份唯一。每次登记前都由它兜底（幂等，单飞；已确认的身份直接返回）：
 * 碰撞时按“先到者保留、后来者重新分配”换一个新身份，并把现有占用按新身份重新登记。
 */
function ensureEditingPageIdentity(): Promise<void> {
  const host = editingIdentityHost();
  if (!host.id) {
    host.id = createEditingPageId();
    try { sessionStorage.setItem(editingPageIdStorageKey, host.id); } catch { /* 仅内存身份 */ }
  }
  // 身份已确认（或已在协商中）：不重复探询，登记不会被身份协商拖慢。
  if (host.claimedId === host.id) return Promise.resolve();
  host.claiming ??= (async () => {
    try {
      for (let attempt = 0; attempt < editingPageIdClaimAttempts; attempt++) {
        if (await claimEditingPageId(host)) {
          host.claimedId = host.id;
          return;
        }
        // 身份已被其他存活实例持有：重新分配（新身份 = 新的租约实例，旧身份由服务端宽限到期）。
        host.id = createEditingPageId();
        host.lockHeld = undefined;
        host.claimedId = undefined;
        try { sessionStorage.setItem(editingPageIdStorageKey, host.id); } catch { /* 仅内存身份 */ }
        rebaseEditingHolds();
      }
      // 连续碰撞（异常环境）：保留最后一次身份继续，避免无限协商；后续复制标签仍由监听应答。
      host.claimedId = host.id;
    } finally {
      host.claiming = undefined;
    }
  })();
  return host.claiming;
}

const editingClient = axios.create({ baseURL: "/api/cleanup/editing", headers: { "x-toonflow-workspace": "1" } });
registerApiLanguage(editingClient);
// ACT: 编辑占用与小文件请求共用登录过期处理（保留草稿，不强制刷新）。
attachAuthInterceptor(editingClient);

/** T14：一次占用登记实例（同一路径可重入）。holdId 用于把迟到响应/释放绑定到它自己的租约实例；
 *  leaseId 是本次 hold 的出网租约实例身份——每个 hold 单独生成、跨 hold 绝不复用。 */
type EditingHold = {
  holdId: string;
  leaseId: string;
  directory: string;
  path: string;
  count: number;
  version?: number;
  /** T14：服务端已确认的保护下限（续租响应 expiresAt）；下一次续租必须早于它。 */
  protectedUntil?: number;
  onError?: (message: string) => void;
};
const editingHolds = new Map<string, EditingHold>();
/** T14：租约实例代次；身份重新分配时递增并轮换 leaseId，用于丢弃迟到响应。 */
let editingLeaseEpoch = 0;
/** 版本尚未取得时先挂起的释放：版本此前已确认的立即带版本发送；始终不发送无版本 DELETE（避免误删后建立的租约）。
 *  挂起后该实例已离开登记表，在途登记响应按其原实例校验时可能被丢弃——这种次序下本次释放不会再发出，
 *  保护由服务端宽限（约 5 分钟）到期兜底，且挂起提示对用户可见。 */
const pendingEditingReleases = new Map<string, EditingHold>();
let editingTimer: ReturnType<typeof setTimeout> | undefined;
let editingRenewDelayMs = editingRenewFallbackMs;
let editingLeaseError = "";

function editingHoldKey(directory: string, path: string) {
  return `${directory}\u0000${path}`;
}

/** 当前登记中的编辑占用（规范目录 + 路径），供界面核对；普通读取不会出现在这里。 */
export function listEditingHolds() {
  return [...editingHolds.values()].map(({ directory, path }) => ({ directory, path }));
}

/** 最近一次编辑占用登记/续租/释放的错误（空字符串表示正常）。 */
export function getEditingLeaseError() {
  return editingLeaseError;
}

/** T14：监听编辑占用登记/续租/释放失败（节点与编辑器据此显示错误，不静默）；返回取消监听函数。 */
export function onEditingHoldError(handler: (detail: { path: string; message: string }) => void) {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ path?: string; message?: string }>).detail;
    handler({ path: detail?.path ?? "", message: detail?.message || "编辑占用登记失败" });
  };
  window.addEventListener(editingHoldErrorEvent, listener);
  return () => window.removeEventListener(editingHoldErrorEvent, listener);
}

/** 首次登记/续租失败要可见：回调 + 页面事件（节点与编辑器据此显示错误，不静默假成功）。 */
function reportEditingError(message: string, path: string, onError?: (message: string) => void) {
  editingLeaseError = message;
  onError?.(message);
  window.dispatchEvent(new CustomEvent(editingHoldErrorEvent, { detail: { path, message } }));
}

function clearEditingError() {
  editingLeaseError = "";
}

/** 仍有“关闭时未拿到占用版本、释放尚未发出”的挂起占用：此时不自动清掉可见提示。 */
function hasPendingReleaseWithoutVersion() {
  for (const hold of pendingEditingReleases.values()) if (hold.version === undefined) return true;
  return false;
}

/**
 * T14：身份重新分配 = 新的租约实例。每个 hold 换新的 holdId 与**新的出网 leaseId**（同一页面跨 hold 不复用），
 * 清各占用的旧代次版本与保护下限、丢弃旧实例的挂起释放（那属于旧身份，不能删除新身份/新租约的占用），
 * 再按新身份重新登记。
 */
function rebaseEditingHolds() {
  editingLeaseEpoch++;
  for (const hold of editingHolds.values()) {
    hold.holdId = crypto.randomUUID();
    hold.leaseId = crypto.randomUUID();
    hold.version = undefined;
    hold.protectedUntil = undefined;
  }
  pendingEditingReleases.clear();
  reportedPendingReleases.clear();
  if (editingHolds.size) void flushEditingHolds().catch(() => {});
}

function scheduleEditingRenew(delay = editingRenewDelayMs) {
  if (!editingHolds.size) {
    editingTimer = undefined;
    return;
  }
  // T14：以服务端已确认的保护下限约束续租时机——下一次续租请求必须早于最短的下限发出（取半程，最低 5 秒），
  // 不能等保护过期后才续。
  const now = Date.now();
  let next = delay;
  for (const hold of editingHolds.values()) {
    if (hold.protectedUntil === undefined) continue;
    next = Math.min(next, Math.max(5000, Math.floor((hold.protectedUntil - now) / 2)));
  }
  editingTimer = setTimeout(() => {
    editingTimer = undefined;
    void flushEditingHolds().finally(() => scheduleEditingRenew());
  }, next);
}

/** 该路径当前登记实例（含已关闭、等待拿到版本再释放的挂起释放）。 */
function findEditingHold(key: string) {
  return editingHolds.get(key) ?? pendingEditingReleases.get(key);
}
/** 把一轮 create 响应按“请求时的占用实例”写回：实例已换（迟到响应）就不落旧代次的版本。 */
function applyEditingRenewResult(
  directory: string,
  requested: { key: string; holdId: string; path: string }[],
  data: { data?: { items?: { path?: string; version?: number; conflict?: boolean }[] } } | undefined,
) {
  const conflicts: string[] = [];
  for (const item of data?.data?.items ?? []) {
    if (!item?.path) continue;
    const key = editingHoldKey(directory, item.path);
    const hold = findEditingHold(key);
    const request = requested.find(entry => entry.key === key);
    // 迟到的旧实例响应：该路径已被新的登记实例接管时丢弃，不覆盖新租约的版本。
    if (!hold || !request || hold.holdId !== request.holdId) continue;
    if (typeof item.version === "number") hold.version = item.version;
    if (item.conflict && !pendingEditingReleases.has(key)) conflicts.push(hold.path);
  }
  return conflicts;
}

async function flushEditingHolds(): Promise<void> {
  // T14：登记前先确认页面实例身份（碰撞时已重新分配并轮换租约实例）。
  await ensureEditingPageIdentity();
  let failure: unknown;
  // T14/§N.3：每个 hold 独立登记——create/renew 携带**本 hold 的 leaseId** 与逐路径 versions，
  // 不把多个 hold 合并到同一出网租约（同一页面跨 hold 不复用 leaseId，旧释放不能命中过期后重开的新占用）。
  for (const [key, hold] of [...editingHolds]) {
    if (editingHolds.get(key) !== hold) continue;
    const epoch = editingLeaseEpoch;
    const leaseId = hold.leaseId;
    const request = { key, holdId: hold.holdId, path: hold.path };
    try {
      // 版本对齐：该 hold 的版本已知才发送；缺失时只续租不携带版本（释放侧同样绝不发送缺版本请求）。
      const versions = hold.version === undefined ? undefined : [hold.version];
      const { data } = await editingClient.post<{ data?: { renewAfterMs?: number; expiresAt?: string; items?: { path?: string; version?: number; expiresAt?: string; conflict?: boolean }[] } }>("/create", {
        directory: hold.directory, paths: [hold.path], pageId: getEditingPageId(), leaseId,
        ...(versions ? { versions } : {}),
      });
      // T14：身份/代次/实例已变化的迟到响应不写回（旧实例的版本不得落到新租约上）。
      if (epoch !== editingLeaseEpoch || editingHolds.get(key) !== hold) continue;
      // 续租周期以服务端约定为准，服务端未返回时保留上次值/默认值。
      const renewAfterMs = data?.data?.renewAfterMs;
      if (typeof renewAfterMs === "number" && Number.isFinite(renewAfterMs) && renewAfterMs >= 5000) editingRenewDelayMs = renewAfterMs;
      // T14：续租成功确认后才记录服务端回执——版本与服务端确认的保护下限（expiresAt）都只在响应到达后写回，
      // 下一次续租由 scheduleEditingRenew 保证早于该下限（保护下限的持久化由 create/renew 在服务端完成）。
      const confirmed = Date.parse(data?.data?.items?.[0]?.expiresAt ?? data?.data?.expiresAt ?? "");
      if (Number.isFinite(confirmed)) hold.protectedUntil = confirmed;
      // T14：记录服务端派发的占用版本（释放时按同一代次复核）；conflict 表示本地版本已过期，
      // 先按服务端返回的新版本重读一次，再登记一轮让服务端确认该代次。
      const conflicts = applyEditingRenewResult(hold.directory, [request], data);
      if (conflicts.length && hold.version !== undefined && epoch === editingLeaseEpoch && editingHolds.get(key) === hold) {
        const retry = await editingClient.post<{ data?: { items?: { path?: string; version?: number; expiresAt?: string }[] } }>("/create", {
          directory: hold.directory, paths: [hold.path], pageId: getEditingPageId(), leaseId, versions: [hold.version],
        });
        if (epoch === editingLeaseEpoch && editingHolds.get(key) === hold) {
          const retried = Date.parse(retry.data?.data?.items?.[0]?.expiresAt ?? "");
          if (Number.isFinite(retried)) hold.protectedUntil = Math.max(hold.protectedUntil ?? 0, retried);
          applyEditingRenewResult(hold.directory, [request], retry.data);
        }
      }
    } catch (error) {
      // 一个 hold 失败不跳过其他 hold；失败即暴露给该占用对应的界面回调（不静默假成功）。
      if (failure === undefined) failure = error;
      reportEditingError(error instanceof Error ? error.message : "编辑占用登记失败", hold.path, hold.onError);
    }
  }
  if (failure === undefined && !hasPendingReleaseWithoutVersion()) clearEditingError();
  // 版本此前已确认的挂起释放立即带版本发出；版本仍未知的保持挂起并由可见提示说明：
  // 若在途登记响应已按其原实例丢弃，该次释放不会再发出 DELETE，保护由服务端宽限到期兜底。
  flushPendingEditingReleases();
  if (failure !== undefined) throw failure;
}

/** 发送一次带 leaseId 与逐路径版本的释放；释放未生效、失败或被更新实例接管都要有明确结果。 */
async function sendEditingRelease(hold: EditingHold, key: string) {
  const epoch = editingLeaseEpoch;
  const version = hold.version;
  // T14/§N.3：释放必须同时携带本次 hold 的 leaseId 与逐路径 version；任一缺失不发送
  // （由调用方挂起并给出可见提示），绝不退化为只按 leaseId 或只按版本释放。
  if (version === undefined) return false;
  try {
    const { data } = await editingClient.delete<{ data?: { released?: number; skipped?: { path?: string; reason?: string }[]; deferred?: string[] } }>("/release", {
      // T14：不带版本的 DELETE 可能删掉快速关闭重开后的新租约，因此始终带版本与本次 hold 的租约实例。
      data: { directory: hold.directory, paths: [hold.path], pageId: getEditingPageId(), leaseId: hold.leaseId, versions: [version] },
    });
    pendingEditingReleases.delete(key);
    if (epoch !== editingLeaseEpoch) return true; // 身份已重分配：旧租约的释放结果不再影响当前状态
    const result = data?.data;
    if ((result?.released ?? 0) > 0) {
      if (!hasPendingReleaseWithoutVersion()) clearEditingError();
      return true;
    }
    if (editingHolds.has(key)) return true;
    const reason = result?.skipped?.[0]?.reason || (result?.deferred?.length ? "文件正被其他操作占用，释放已延迟" : "");
    reportEditingError(`编辑占用未释放${reason ? `：${reason}` : ""}；保护将由服务端宽限到期`, hold.path, hold.onError);
    return true;
  } catch (error) {
    if (epoch !== editingLeaseEpoch || editingHolds.has(key)) {
      pendingEditingReleases.delete(key);
      return true;
    }
    reportEditingError(error instanceof Error ? error.message : "编辑占用释放失败", hold.path, hold.onError);
    return false;
  }
}

/** 挂起释放的可见提示只报一次（同一路径重复上报会持续打扰编辑器/节点）。 */
const reportedPendingReleases = new Set<string>();

/**
 * 刷新挂起释放：版本此前已确认且该路径未被新的登记实例接管时才发送；
 * 版本仍未知时保持挂起（绝不发送无版本 DELETE），并给出可见提示——该情形下本次释放可能不再发出，
 * 由服务端宽限到期兜底（保守，不删除后建立的租约）。
 */
function flushPendingEditingReleases() {
  for (const [key, hold] of [...pendingEditingReleases]) {
    if (editingHolds.has(key)) {
      // 同一路径已被新一次编辑接管（快速关闭重开）：放弃这次释放，绝不删除后建立的租约。
      pendingEditingReleases.delete(key);
      reportedPendingReleases.delete(key);
      continue;
    }
    if (hold.version === undefined) {
      if (!reportedPendingReleases.has(key)) {
        reportedPendingReleases.add(key);
        reportEditingError("编辑占用登记尚未确认，释放已挂起：登记响应仍能确认版本时立即释放；否则本次释放不会发送 DELETE，保护由服务端宽限到期兜底", hold.path, hold.onError);
      }
      continue;
    }
    pendingEditingReleases.delete(key);
    reportedPendingReleases.delete(key);
    void sendEditingRelease(hold, key);
  }
}

// T14：重新登录后重新分配身份（新 pageId + 新租约实例）并重新登记全部占用；hidden 不释放。
if (typeof window !== "undefined") {
  window.addEventListener("toonflow:auth-restored", event => {
    // 同一事件对象被多个 bundle 共享：只有第一个监听者重新分配 pageId，其余按新身份重挂自己的占用。
    const marked = event as (Event & { toonflowPageIdReset?: boolean }) | undefined;
    const host = editingIdentityHost();
    if (marked && !marked.toonflowPageIdReset) {
      marked.toonflowPageIdReset = true;
      host.id = createEditingPageId();
      host.lockHeld = undefined;
      host.claimedId = undefined;
      host.claiming = undefined;
      try { sessionStorage.setItem(editingPageIdStorageKey, host.id); } catch { /* 仅内存身份 */ }
    }
    // 每个 bundle 的占用都换成新的租约实例并按（可能已更新的）新身份重新登记；旧身份的租约由服务端宽限到期。
    rebaseEditingHolds();
    void ensureEditingPageIdentity();
  });
  // hidden 不主动释放；回到前台或恢复联网时立即补一次续租，避免浏览器限速定时器导致服务端宽限到期。
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && editingHolds.size) void flushEditingHolds().catch(() => {});
  });
  window.addEventListener("online", () => {
    if (editingHolds.size) void flushEditingHolds().catch(() => {});
  });
}

/* -------------------------------------------------- T11 文件可用性（公共只读查询） */

const cleanupClient = axios.create({ baseURL: "/api/cleanup/record", headers: { "x-toonflow-workspace": "1" } });
registerApiLanguage(cleanupClient);
attachAuthInterceptor(cleanupClient);
export type FileAvailabilityState = "available" | "cleaned" | "missing";
export type FileAvailability = { known: boolean; state: FileAvailabilityState; cleanedAt?: string };
const availabilityCache = new Map<string, { at: number; value: FileAvailability }>();
const availabilityCacheMs = 30000;

/** T11：输出/文件可用性公共查询（复用 C 的清理记录接口）；只读记录、不改任务、不触发生成。 */
export async function queryFileAvailability(directory: string, path: string, signal?: AbortSignal): Promise<FileAvailability> {
  const key = editingHoldKey(directory, path);
  const cached = availabilityCache.get(key);
  if (cached && Date.now() - cached.at < availabilityCacheMs) return cached.value;
  const { data } = await cleanupClient.get<{ data: { known: boolean; state: FileAvailabilityState; cleanedAt?: string } }>("", { params: { directory, path }, signal });
  const value = data.data;
  availabilityCache.set(key, { at: Date.now(), value });
  return value;
}

/** 文件/任务输出变化后失效缓存（写入、复制、改名、删除、保存回执等）；路径为目录时一并失效其后代。 */
export function invalidateFileAvailability(directory?: string, path?: string) {
  if (!directory || !path) return void availabilityCache.clear();
  const prefix = `${directory}\u0000${path}`;
  for (const key of [...availabilityCache.keys()]) {
    if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}\\`)) availabilityCache.delete(key);
  }
}

/* -------------------------------------------------- R4/§P.5 改名保护状态提示 */

type RelocationWarningBody = { warning?: unknown; data?: { warning?: unknown } };

function relocationWarningText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 失败响应读取 warning：兼容 data.data.warning（与成功结构一致）与 data.warning（错误结构）。 */
function relocationWarningOf(error: unknown) {
  if (!axios.isAxiosError(error)) return undefined;
  const body = error.response?.data as RelocationWarningBody | undefined;
  return relocationWarningText(body?.data?.warning) ?? relocationWarningText(body?.warning);
}

/**
 * R4（第七轮）/执行契约 §P.5：服务端把「改名事务已完成，但保护仍在，需清理核对」按 warning 透传，
 * 网页必须实际消费并可见——成功时提示「操作已完成，保护状态仍需核对」+原文；失败响应若同样带
 * warning，连同失败原因一起显示（错误本身仍由调用方按原样抛出，失败语义不变）。
 * 复用既有 element-plus 通知（与登录过期等提示同一套）；提示本身失败不改变原操作结果。
 */
export function notifyRelocationWarning(warning: unknown, failure?: string) {
  const text = relocationWarningText(warning);
  if (!text) return;
  try {
    ElMessage.warning({
      message: failure ? `${failure}；保护状态仍需核对：${text}` : `操作已完成，保护状态仍需核对：${text}`,
      duration: 10000,
      showClose: true,
      grouping: true,
    });
  } catch { /* 提示不可用时不改变原操作结果 */ }
}

/** 失败出口：保留失败原因，并在响应带 warning 时一并显示保护状态。 */
export function notifyRelocationFailure(error: unknown) {
  const warning = relocationWarningOf(error);
  if (!warning) return;
  const reason = axios.isAxiosError<{ message?: string }>(error)
    ? error.response?.data?.message || error.message || "改名失败"
    : error instanceof Error ? error.message : "改名失败";
  notifyRelocationWarning(warning, reason);
}

export default function useWorkspaceFiles(directory?: MaybeRefOrGetter<string | undefined>) {
  const workspace = directory === undefined ? useWorkspaceStore() : undefined;
  function getDirectory() {
    const path = directory === undefined ? workspace?.project?.directory : toValue(directory);
    if (!path) throw new Error("请先选择工作目录");
    return path;
  }

  async function list(path = "", signal?: AbortSignal) {
    const { data } = await client.get<{ data: { directory: string; empty: boolean; entries: WorkspaceEntry[] } }>("/list", { params: { directory: getDirectory(), path }, signal });
    return data.data;
  }

  async function read(path: string) {
    const { data } = await client.get<ArrayBuffer>("/read", { params: { directory: getDirectory(), path }, responseType: "arraybuffer" });
    return data;
  }

  async function importImage(url: string) {
    const { data } = await client.post<{ data: { path: string; mimeType: string } }>("/importImage", { directory: getDirectory(), url });
    return data.data;
  }

  async function cloneProject(project: { url: string; name: string }, signal?: AbortSignal) {
    const { data } = await client.post<{ data: { directory: string } }>("/clone", { directory: getDirectory(), ...project }, { baseURL: "/api/workspaces", signal });
    return data.data;
  }

  function acquireUrl(path: string, mimeType?: string) {
    const directory = getDirectory();
    const key = JSON.stringify([directory, path, mimeType]);
    let entry = fileUrls.get(key);
    if (!entry) {
      const url = client.get<Blob>("/read", { params: { directory, path }, responseType: "blob" })
        .then(({ data }) => URL.createObjectURL(mimeType ? new Blob([data], { type: mimeType }) : data));
      entry = { directory, path, url, users: 0 };
      fileUrls.set(key, entry);
      const current = entry;
      void url.catch(() => { if (fileUrls.get(key) === current) fileUrls.delete(key); });
    }
    const current = entry;
    current.users++;
    let released = false;
    return {
      url: current.url,
      release() {
        if (released) return;
        released = true;
        if (--current.users) return;
        if (fileUrls.get(key) === current) fileUrls.delete(key);
        // 等待中的读取也要在最后一个使用者离开后释放，不撤销其他节点仍使用的 URL。
        void current.url.then(url => URL.revokeObjectURL(url), () => {});
      },
    };
  }

  async function readText(path: string, maxBytes?: number, signal?: AbortSignal) {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error("读取字节数必须为正整数");
    try {
      const { data } = await client.get<string>("/read", {
        params: { directory: getDirectory(), path }, responseType: "text", transformResponse: [], signal,
        headers: maxBytes === undefined ? undefined : { Range: `bytes=0-${maxBytes - 1}` },
      });
      return data;
    } catch (error) {
      if (maxBytes !== undefined && axios.isAxiosError(error) && error.response?.status === 416 && error.response.headers["content-range"] === "bytes */0") return "";
      throw error;
    }
  }

  async function readJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
    const text = await readText(path, undefined, signal);
    signal?.throwIfAborted();
    return JSON.parse(text);
  }

  async function readTextSnapshot(path: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<TextSnapshot> {
    if (options?.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) throw new Error("读取字节数必须为正整数");
    const { data } = await client.get<{ data: TextSnapshot }>("/read", {
      params: { directory: getDirectory(), path, snapshot: true, maxBytes: options?.maxBytes }, signal: options?.signal,
    });
    return data.data;
  }

  async function writeTextSnapshot(path: string, text: string, snapshot: Pick<TextSnapshot, "revision" | "encoding">, kind?: FileKind) {
    const directory = getDirectory();
    const { data } = await client.put<{ data: { revision: string } }>("/write", text, {
      params: { directory, path, expectedRevision: snapshot.revision, encoding: snapshot.encoding },
      headers: { "Content-Type": "application/octet-stream", ...(kind ? { "x-toonflow-file-kind": kind } : {}) },
    });
    invalidateUrls(directory, path);
    invalidateFileAvailability(directory, path);
    return data.data.revision;
  }

  async function write(path: string, content: string | Blob | ArrayBuffer, exclusive = false, signal?: AbortSignal, kind?: FileKind) {
    const directory = getDirectory();
    await client.put("/write", content, { params: { directory, path, exclusive }, signal, headers: { "Content-Type": "application/octet-stream", ...(kind ? { "x-toonflow-file-kind": kind } : {}) } });
    invalidateUrls(directory, path);
    invalidateFileAvailability(directory, path);
  }

  function writeJson(path: string, data: unknown, exclusive = false) {
    return write(path, `${JSON.stringify(data, null, 2)}\n`, exclusive);
  }

  async function rename(path: string, target: string) {
    const directory = getDirectory();
    try {
      // R4/§P.5：成功响应可能带 warning（改名事务已完成但迁移意图保护清除失败，保护仍在需清理核对），
      // 必须消费并让用户在既有通知里看到；失败响应若带 warning 同样保留失败原因与保护状态。
      const { data } = await client.post<{ data?: { warning?: string } }>("/rename", { directory, path, target });
      notifyRelocationWarning(data?.data?.warning);
    } catch (error) {
      notifyRelocationFailure(error);
      throw error;
    }
    invalidateUrls(directory, path);
    invalidateFileAvailability(directory, path);
    invalidateUrls(directory, target);
    invalidateFileAvailability(directory, target);
  }

  async function copy(path: string, target: string) {
    const directory = getDirectory();
    await client.post("/copy", { directory, path, target });
    invalidateUrls(directory, target);
    invalidateFileAvailability(directory, target);
  }

  async function reveal(path: string) {
    if (isRemoteConnection) throw new Error("远程项目文件无法在本机文件管理器中定位，请下载或导出后查看。");
    if (isMobile) throw new Error("移动端暂不支持在文件管理器中定位项目文件，请使用下载或导出保存文件。");
    await client.post("/reveal", { directory: getDirectory(), path });
  }

  async function remove(path: string, recursive = false) {
    const directory = getDirectory();
    await client.delete("/remove", { data: { directory, path, recursive } });
    invalidateUrls(directory, path);
    invalidateFileAvailability(directory, path);
  }

  async function mkdir(path: string) {
    await client.post("/mkdir", { directory: getDirectory(), path });
  }

  /** T11：文件可用性公共查询（清理记录），供节点与视图显示已清理/缺失；只读，不触发生成。 */
  function queryAvailability(path: string, signal?: AbortSignal) {
    return queryFileAvailability(getDirectory(), path, signal);
  }

  /**
   * W4/T14：登记编辑占用并返回释放函数。同一路径可重入（引用计数），同一个页面会话共用一份续租计时器。
   * 只有真正进入编辑（或持有待回写结果）时调用；只读预览/播放不登记。
   * 首次登记失败必须可见：通过 options.onError 回调与 toonflow:editing-hold-error 事件暴露，不静默假成功。
   * 每个 hold 新建时生成不复用的出网 leaseId；释放始终同时携带该 leaseId 与占用版本：
   * 快速关闭重开（新租约已建立）时不发送释放，版本未就绪时先挂起并可见提示，
   * 绝不使用无版本 DELETE 删掉过期后重开的新占用。
   */
  function holdEditing(path: string, options?: { onError?: (message: string) => void }) {
    const directory = getDirectory();
    const key = editingHoldKey(directory, path);
    const existing = editingHolds.get(key);
    let hold: EditingHold;
    if (existing) {
      existing.count++;
      if (options?.onError) existing.onError = options.onError;
      hold = existing;
    } else {
      // T14：本次 hold 独立的出网租约实例身份（跨 hold 不复用）。
      hold = { holdId: crypto.randomUUID(), leaseId: crypto.randomUUID(), directory, path, count: 1, onError: options?.onError };
      editingHolds.set(key, hold);
      // 首次登记立即上报；失败通过回调/事件提示编辑器与节点（flushEditingHolds 内部已上报）。
      void flushEditingHolds().catch(() => {});
    }
    if (!editingTimer) scheduleEditingRenew();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // 本次占用实例已不再是当前占用（完全释放后又被重新打开）时不代为释放，避免误删新租约。
      if (editingHolds.get(key) !== hold) return;
      if (--hold.count > 0) return;
      editingHolds.delete(key);
      if (!editingHolds.size && editingTimer) {
        clearTimeout(editingTimer);
        editingTimer = undefined;
      }
      if (hold.version === undefined) {
        // T14：首次登记还在途、版本未就绪时不发无版本 DELETE（绝不误删后建立的租约），先挂起并给出可见提示。
        // 挂起后本实例已离开登记表：在途 create 响应按原实例（editingHolds 查找）校验时会被丢弃，
        // 这种次序下本次释放不会再发出 DELETE，保护由服务端宽限（约 5 分钟）到期兜底。
        pendingEditingReleases.set(key, hold);
        flushPendingEditingReleases();
        return;
      }
      void sendEditingRelease(hold, key);
    };
  }

  // ACT: 当前目录逐次读取；跨 await 或防抖的操作传入目录字符串，固定本次目标。
  return { list, read, importImage, cloneProject, acquireUrl, readText, readJson, readTextSnapshot, writeTextSnapshot, write, writeJson, rename, copy, reveal, remove, mkdir, holdEditing, queryAvailability };
}
