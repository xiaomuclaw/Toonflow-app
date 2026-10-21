import { computed, onScopeDispose, ref, watch } from "vue";

export type MediaTaskState = "preparing" | "queued" | "submitting" | "running" | "downloading" | "succeeded" | "failed" | "cancelled" | "unknown";
export type MediaTaskOutputState = "available" | "cleaned" | "missing";

export type MediaTaskOutput = {
  /** 输出原路径（历史字段；改名/迁移后可能已不是最新位置）。 */
  path: string;
  mimeType: string;
  mediaType: string;
  /** G/T11：服务端冻结字段 state；缺省视为 available（旧记录兼容）。cleaned/missing 不再作为可播放成片绑定。 */
  state?: MediaTaskOutputState;
  /** G/T11：改名/迁移后的可信最新工作区相对路径；存在时优先于 path。 */
  resolvedPath?: string;
  /** G/T11：落盘内容 SHA256（服务端已知时透出）。 */
  sha256?: string;
  cleanedAt?: string;
  /** 兼容 v3 前的旧字段名。 */
  outputState?: MediaTaskOutputState;
};

/** G/T11：逐项输出可用性；state 优先，兼容旧 outputState，缺省视为 available。 */
export function mediaTaskOutputState(output: MediaTaskOutput | undefined): MediaTaskOutputState {
  return output?.state ?? output?.outputState ?? "available";
}

/** G/T11：优先使用服务端确认的最新路径（改名后 resolvedPath），其次原 path。 */
export function mediaTaskOutputPath(output: MediaTaskOutput | undefined) {
  return output?.resolvedPath || output?.path || "";
}

/** W2 画布保存清单条目：由发送保存的同一份不可变文本快照导出，用于精确清理“已完成、待保存”关联。 */
export type MediaTaskWriteBackManifestEntry = { nodeId: string; taskId: string; outputPath: string; writeBackToken: string };

type MediaTaskSummary = {
  taskId: string;
  itemKey?: string;
  state: MediaTaskState;
  outputs: MediaTaskOutput[];
  error?: string;
  cancellationRequested: boolean;
  upstreamCancellation?: boolean;
  outputState?: MediaTaskOutputState;
  cleanedAt?: string;
  trackingStatus?: "active" | "blocked" | "paused";
  waitingReason?: string;
  retryAt?: string;
  resultReadyAt?: string;
  lastQueryAt?: string;
  lastQuerySucceededAt?: string;
  lastUpstreamState?: string;
  abandonedAt?: string;
  abandonRevokedAt?: string;
};

/** 持久绑定的受理阶段：pending=提交结果待核对（无 taskId）；submitted=已取得 taskId；succeeded=输出已写入节点、等待画布保存。 */
type MediaTaskBindingState = "pending" | "submitted" | "succeeded";

type MediaTaskBinding = {
  batchKey: string;
  itemKey: string;
  taskId?: string;
  state: MediaTaskBindingState;
  submittedAt: string;
  request: unknown;
  /** 已绑定到节点的输出路径；画布保存成功前保留，用于重开后校验与找回。 */
  outputPath?: string;
  /** W2：首次绑定某 taskId 的某输出身份时生成并持久；同一任务同一输出的重复轮询、重挂载、登录恢复复用。 */
  writeBackToken?: string;
};

type MediaTaskAcceptance = {
  status: "accepted" | "existing" | "pending";
  taskId?: string;
  state: MediaTaskState | "idle";
  message?: string;
};

type MediaTaskCancelResult = {
  state: MediaTaskState | "idle";
  taskId?: string;
  cancellationRequested: boolean;
  upstreamCancellation?: boolean;
  observing: boolean;
  message?: string;
};

const activeStates = new Set<MediaTaskState>(["preparing", "queued", "submitting", "running", "downloading"]);
// 服务端状态统一显示为中文，文案与 docs/executionContract.md §2 状态机一致。
const stateLabels: Record<MediaTaskState, string> = {
  preparing: "准备中", queued: "排队中", submitting: "提交中", running: "生成中", downloading: "下载中",
  succeeded: "已完成", failed: "生成失败", cancelled: "已取消", unknown: "待核对",
};
const storagePrefix = "toonflow.mediaTask";
const pollInterval = 3000;
const hiddenPollInterval = 15000;
const pollIntervalMax = 60000;
const submitTimeout = 90000;
const queryTimeout = 30000;
// H/T13：节点工具（getGenerationStatus/refresh 等）只等待自身订阅结果的短截止；
// 超时返回本地已知摘要并注明仍在查询，页级观察（hub）继续独立进行。
const nodeResultWaitMs = 5000;
// W5：每次任务查询显式携带的大小（服务端最多 200 个 ID），分片而不是总量上限。
const queryPageSize = 200;
// 同一 batchKey 的一轮分页上限：超过则下一轮继续按原键查询，不丢关联。
const batchKeyPageLimit = 8;
// 画布保存成功后由画布面板广播；用于在输出确实落盘后清理临时恢复关联（F05/W2）。
const canvasSavedEvent = "toonflow:canvas-saved";
const authRestoredEvent = "toonflow:auth-restored";

function normalizePath(value: string | undefined) {
  return (value ?? "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

async function requestTask<T>(path: string, init: { method: "GET" | "POST"; query?: Record<string, string>; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const url = new URL(`/api/ai/media/tasks/${path}`, window.location.origin);
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: init.method,
      headers: { "x-toonflow-workspace": "1", ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: init.signal,
    });
  } catch (error) {
    // 请求未拿到响应：结果未知，保留绑定按原键重试。
    if ((error as Error | undefined)?.name === "AbortError") throw error;
    throw Object.assign(new Error("任务服务暂时不可用，请检查网络后重试"), { unknowable: true });
  }
  // F07：登录过期不当作任务失败，保留草稿、任务关联与待回写输出，只提示重新登录。
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent("toonflow:unauthorized"));
    throw Object.assign(new Error("登录已过期，请重新登录；任务关联已保留，重新登录后自动继续查询"), { unauthorized: true });
  }
  const payload = await response.json().catch(() => undefined) as { code?: number; data?: T; message?: string } | undefined;
  if (!response.ok || payload?.code !== 200) {
    throw Object.assign(new Error(payload?.message || `任务请求失败（HTTP ${response.status}）`), { status: response.status, unknowable: response.status >= 500 });
  }
  return payload.data as T;
}

/* -------------------------------------------------- W5 页面级任务查询聚合 */

/**
 * T10：一次聚合投递。queried* 是本次投递「查询时使用的键」，订阅方据此判定迟到结果；
 * 缺少这些键的投递不做键校验（仅用于不携带目标的异常分支，已不再产生）。
 */
type TaskHubDelivery = {
  task?: MediaTaskSummary;
  error?: unknown;
  queriedTaskId?: string;
  queriedBatchKey?: string;
  queriedItemKey?: string;
  /** T11：发起本轮查询时绑定的输出定位（同任务旧路径的迟到结果据此失效，不把旧路径写回节点）。 */
  queriedOutputPath?: string;
};

type TaskHubSubscriber = {
  id: number;
  /** 规范目录：同一页面的订阅按它分组，同目录合并请求。 */
  directory: string;
  taskId?: string;
  batchKey?: string;
  itemKey?: string;
  /** T11：当前绑定的输出定位；随每轮查询目标固定，投递时按它校验同任务旧路径。 */
  outputPath?: string;
  receive(result: TaskHubDelivery): void;
};

type TaskHub = {
  nextId: number;
  subscribers: Map<number, TaskHubSubscriber>;
  round?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  /** 连续查询失败轮数：前台逐步退避到 60 秒，成功清零。 */
  failures: number;
  attached: boolean;
  onVisibility: () => void;
  onOnline: () => void;
  onAuthRestored: () => void;
};

// W5：宿主运行时注入点（globalThis + Symbol.for，与 nodeAi 模型缓存同一策略），
// 同一页面的不同节点 bundle 共享同一套订阅、定时器和请求分组，而不是各持模块变量。
const hubKey = Symbol.for("toonflow.mediaTaskHub");
const hubHost = globalThis as typeof globalThis & { [hubKey]?: TaskHub };

function hubDelay(hub: TaskHub) {
  const base = typeof document !== "undefined" && document.visibilityState === "hidden" ? hiddenPollInterval : pollInterval;
  return hub.failures ? Math.min(base * 2 ** Math.min(hub.failures, 5), pollIntervalMax) : base;
}

function deliver(hub: TaskHub, id: number, result: TaskHubDelivery) {
  const subscriber = hub.subscribers.get(id);
  // 已退订或已重建的旧订阅不再接收迟到结果，避免污染切换后的画布。
  if (!subscriber) return;
  subscriber.receive(result);
}

/** T10/T11：一轮聚合查询的目标快照（发起请求前固定查询键与输出定位，投递时据此判定迟到结果）。 */
type TaskHubQueryTarget = { subscriber: TaskHubSubscriber; queriedTaskId?: string; queriedBatchKey?: string; queriedItemKey?: string; queriedOutputPath?: string };

async function queryHubRound(hub: TaskHub) {
  const subscribers = [...hub.subscribers.values()];
  if (!subscribers.length) return;
  const groups = new Map<string, TaskHubQueryTarget[]>();
  for (const subscriber of subscribers) {
    // 目录尚未解析完成时跳过，避免发起无效查询。
    if (!subscriber.directory) continue;
    const target: TaskHubQueryTarget = {
      subscriber,
      ...(subscriber.taskId
        ? { queriedTaskId: subscriber.taskId }
        : { ...(subscriber.batchKey ? { queriedBatchKey: subscriber.batchKey } : {}), ...(subscriber.itemKey ? { queriedItemKey: subscriber.itemKey } : {}) }),
      // T11：查询发起时的输出定位随投递返回，投递时与绑定的当前定位比对。
      ...(subscriber.outputPath ? { queriedOutputPath: subscriber.outputPath } : {}),
    };
    const list = groups.get(subscriber.directory);
    if (list) list.push(target);
    else groups.set(subscriber.directory, [target]);
  }
  let failedRounds = 0;
  for (const [directory, group] of groups) {
    try {
      // T10：本轮查询目标在发起请求前固定（订阅对象的 taskId/batchKey 可能在 await 期间被换绑改写）；
      // 投递时带着“查询时的 key”，绑定已换成新任务的一律按迟到结果丢弃。
      const byTaskId = group.filter(item => item.queriedTaskId);
      const byBatchKey = group.filter(item => !item.queriedTaskId && item.queriedBatchKey);
      const foundById = new Map<string, MediaTaskSummary>();
      const ids = [...new Set(byTaskId.map(item => item.queriedTaskId!))];
      for (let index = 0; index < ids.length; index += queryPageSize) {
        const chunk = ids.slice(index, index + queryPageSize);
        const data = await requestTask<{ tasks: MediaTaskSummary[] }>("get", {
          method: "GET",
          query: { directory, taskIds: chunk.join(","), limit: String(queryPageSize) },
          signal: AbortSignal.timeout(queryTimeout),
        });
        for (const task of data.tasks ?? []) foundById.set(task.taskId, task);
      }
      for (const target of byTaskId) {
        deliver(hub, target.subscriber.id, {
          task: foundById.get(target.queriedTaskId!), queriedTaskId: target.queriedTaskId,
          ...(target.queriedOutputPath ? { queriedOutputPath: target.queriedOutputPath } : {}),
        });
      }
      // 相同 batchKey 合并为一次分页查询，再按 itemKey 找到该提交项。
      for (const batchKey of [...new Set(byBatchKey.map(item => item.queriedBatchKey!))]) {
        const wanted = new Set(byBatchKey.filter(item => item.queriedBatchKey === batchKey).map(item => item.queriedItemKey).filter((key): key is string => !!key));
        const foundByItemKey = new Map<string, MediaTaskSummary>();
        let cursor: string | undefined;
        for (let page = 0; page < batchKeyPageLimit; page++) {
          const data = await requestTask<{ tasks: MediaTaskSummary[]; nextCursor?: string }>("get", {
            method: "GET",
            query: { directory, batchKey, limit: String(queryPageSize), ...(cursor ? { cursor } : {}) },
            signal: AbortSignal.timeout(queryTimeout),
          });
          for (const task of data.tasks ?? []) if (task.itemKey && wanted.has(task.itemKey)) foundByItemKey.set(task.itemKey, task);
          if (!data.nextCursor || [...wanted].every(key => foundByItemKey.has(key))) break;
          cursor = data.nextCursor;
        }
        for (const target of byBatchKey) {
          if (target.queriedBatchKey !== batchKey) continue;
          deliver(hub, target.subscriber.id, {
            task: target.queriedItemKey ? foundByItemKey.get(target.queriedItemKey) : undefined,
            queriedBatchKey: target.queriedBatchKey, ...(target.queriedItemKey ? { queriedItemKey: target.queriedItemKey } : {}),
            ...(target.queriedOutputPath ? { queriedOutputPath: target.queriedOutputPath } : {}),
          });
        }
      }
    } catch (error) {
      // T10：错误投递同样带着本轮查询键，避免旧订阅的失败污染新绑定。
      failedRounds++;
      for (const target of group) {
        deliver(hub, target.subscriber.id, {
          error, ...(target.queriedTaskId ? { queriedTaskId: target.queriedTaskId } : {}),
          ...(target.queriedBatchKey ? { queriedBatchKey: target.queriedBatchKey } : {}),
          ...(target.queriedItemKey ? { queriedItemKey: target.queriedItemKey } : {}),
          ...(target.queriedOutputPath ? { queriedOutputPath: target.queriedOutputPath } : {}),
        });
      }
    }
  }
  hub.failures = failedRounds ? hub.failures + 1 : 0;
}

function hubSchedule(hub: TaskHub, delay = hubDelay(hub)) {
  if (!hub.subscribers.size) return;
  if (hub.timer) clearTimeout(hub.timer);
  hub.timer = setTimeout(() => {
    hub.timer = undefined;
    void hubRun(hub);
  }, delay);
}

function hubRun(hub: TaskHub): Promise<void> {
  const running = hub.round;
  if (running) return running;
  const round = queryHubRound(hub).then(() => {}, () => {}).finally(() => {
    if (hub.round === round) {
      hub.round = undefined;
      hubSchedule(hub);
    }
  });
  hub.round = round;
  return round;
}

/** 立即查询（可见/联网/重新登录/用户刷新）；again=true 表示需要基于最新操作事实的再一轮查询。 */
function hubRequest(hub: TaskHub, again = false): Promise<void> {
  if (again && hub.round) return hub.round.then(() => hubRun(hub), () => hubRun(hub));
  return hubRun(hub);
}

function detachHubListeners(hub: TaskHub) {
  if (!hub.attached) return;
  hub.attached = false;
  document.removeEventListener("visibilitychange", hub.onVisibility);
  window.removeEventListener("online", hub.onOnline);
  window.removeEventListener(authRestoredEvent, hub.onAuthRestored);
}

function attachHubListeners(hub: TaskHub) {
  if (hub.attached) return;
  hub.attached = true;
  document.addEventListener("visibilitychange", hub.onVisibility);
  window.addEventListener("online", hub.onOnline);
  window.addEventListener(authRestoredEvent, hub.onAuthRestored);
}

function getTaskHub(): TaskHub {
  const existing = hubHost[hubKey];
  if (existing) return existing;
  const hub: TaskHub = {
    nextId: 1, subscribers: new Map(), failures: 0, attached: false,
    onVisibility() {
      // 回到前台立即补查；进入后台改为放缓的固定间隔。
      if (document.visibilityState === "visible") void hubRun(hub);
      else if (hub.subscribers.size) hubSchedule(hub);
    },
    onOnline() { void hubRun(hub); },
    onAuthRestored() { void hubRun(hub); },
  };
  hubHost[hubKey] = hub;
  return hub;
}

function subscribeTask(hub: TaskHub, subscriber: Omit<TaskHubSubscriber, "id">) {
  const id = hub.nextId++;
  hub.subscribers.set(id, { ...subscriber, id });
  attachHubListeners(hub);
  return id;
}

function unsubscribeTask(hub: TaskHub, id: number | undefined) {
  if (id === undefined) return;
  hub.subscribers.delete(id);
  if (hub.subscribers.size) return;
  // 无订阅时释放 timer 与事件监听。
  if (hub.timer) clearTimeout(hub.timer);
  hub.timer = undefined;
  detachHubListeners(hub);
}

function updateTaskSubscriber(hub: TaskHub, id: number | undefined, patch: Partial<Pick<TaskHubSubscriber, "directory" | "taskId" | "batchKey" | "itemKey" | "outputPath">>) {
  if (id === undefined) return;
  const subscriber = hub.subscribers.get(id);
  if (!subscriber) return;
  Object.assign(subscriber, patch);
}

/* ------------------ T11 已保存输出可用性：页面级轻量刷新（不新增每节点高频轮询） */

/**
 * T11：画布保存成功（ACK）后临时关联被清理，节点的已保存结果仍需要“文件变化能更新显示”的入口。
 * 这里用与任务查询同一套页面级聚合思路：同一页面所有 bundle 共享一个订阅表与一个计时器，
 * 只按目录分组、按 taskId 去重查询，处于前台时低频（约 60 秒）核对，并在前台/联网/重新登录/
 * 画布保存成功时立即补查一次；没有订阅就释放计时器与监听。禁止每个节点各起一个轮询。
 */
type SavedAvailabilityTarget = { directory: string; taskId?: string; path?: string };
/**
 * T11 互审：一次可用性投递。queriedTaskId/queriedPath 是**本次查询针对的订阅目标身份**，
 * 投递到达时若节点当前已保存结果已经不是这一份（被替换/改写），订阅方按迟到结果丢弃。
 */
type SavedAvailabilityDelivery = {
  state?: MediaTaskOutputState;
  path?: string;
  cleanedAt?: string;
  error?: unknown;
  queriedTaskId?: string;
  queriedPath?: string;
};
type SavedAvailabilityHub = {
  nextId: number;
  subscribers: Map<number, { target: SavedAvailabilityTarget; receive(result: SavedAvailabilityDelivery): void }>;
  round?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  /** 画布保存回执可能连续到来：合并成一次补查，避免每个 ACK 一轮请求。 */
  savedDebounce?: ReturnType<typeof setTimeout>;
  attached: boolean;
  onVisibility: () => void;
  onOnline: () => void;
  onAuthRestored: () => void;
  onCanvasSaved: () => void;
};

/** T11：已保存输出的不可用提示（同一文案集中定义，便于在恢复可用时只清掉这类提示）。 */
const cleanedSavedOutputNotice = "已保存的输出已被清理：任务记录与历史保留，已停止播放与下载；不会自动重新生成";
const missingSavedOutputNotice = "已保存的输出文件缺失或不可用；不会自动重新生成";
const savedAvailabilityInterval = 60000;
const savedAvailabilityHiddenInterval = 300000;
const savedAvailabilityHubKey = Symbol.for("toonflow.mediaTaskSavedAvailabilityHub");
const savedAvailabilityHost = globalThis as typeof globalThis & { [savedAvailabilityHubKey]?: SavedAvailabilityHub };

/** 任务摘要 → 已保存结果的可用性投递（服务端冻结字段：state 优先、resolvedPath 优先于 path）。 */
function savedAvailabilityOfTask(task: MediaTaskSummary, fallbackPath?: string): SavedAvailabilityDelivery {
  const output = (task.outputs ?? []).find(item => !!mediaTaskOutputPath(item)) ?? task.outputs?.[0];
  const path = mediaTaskOutputPath(output) || fallbackPath || "";
  const cleanedAt = output?.cleanedAt ?? task.cleanedAt;
  const state = output ? mediaTaskOutputState(output) : task.outputState;
  return {
    ...(state ? { state } : {}),
    ...(path ? { path } : {}),
    ...(cleanedAt ? { cleanedAt } : {}),
  };
}

/** 单个已保存结果的可用性查询：有 taskId 按任务摘要（服务端冻结字段），否则按清理记录公共查询。 */
async function querySavedAvailability(target: SavedAvailabilityTarget): Promise<SavedAvailabilityDelivery> {
  if (target.taskId) {
    const data = await requestTask<{ tasks?: MediaTaskSummary[] }>("get", {
      method: "GET",
      query: { directory: target.directory, taskIds: target.taskId, limit: "1" },
      signal: AbortSignal.timeout(queryTimeout),
    });
    const task = (data.tasks ?? []).find(item => item.taskId === target.taskId);
    return task ? savedAvailabilityOfTask(task, target.path) : {};
  }
  if (!target.path) return {};
  const url = new URL("/api/cleanup/record", window.location.origin);
  url.searchParams.set("directory", target.directory);
  url.searchParams.set("path", target.path);
  const response = await fetch(url.toString(), { headers: { "x-toonflow-workspace": "1" }, signal: AbortSignal.timeout(queryTimeout) });
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent("toonflow:unauthorized"));
    throw Object.assign(new Error("登录已过期"), { unauthorized: true });
  }
  if (!response.ok) return { path: target.path };
  const payload = await response.json().catch(() => undefined) as { code?: number; data?: { state?: string; cleanedAt?: string } } | undefined;
  const value = payload?.code === 200 ? payload.data?.state : undefined;
  if (value !== "available" && value !== "cleaned" && value !== "missing") return { path: target.path };
  return { state: value, path: target.path, ...(payload?.data?.cleanedAt ? { cleanedAt: payload.data.cleanedAt } : {}) };
}

/** T11 互审：投递前重读订阅表（已退订/已重建的旧订阅不再接收迟到结果）。 */
function deliverSavedAvailability(hub: SavedAvailabilityHub, id: number, delivery: SavedAvailabilityDelivery) {
  const subscriber = hub.subscribers.get(id);
  if (!subscriber) return;
  subscriber.receive(delivery);
}

async function querySavedAvailabilityRound(hub: SavedAvailabilityHub) {
  // T11 互审：本轮查询目标在发起请求前固定（订阅目标可能在 await 期间被改写到新输出）；
  // 投递时带着“查询时的身份（任务 + 路径/输出代次）”，应用前再与节点当前已保存结果比对，
  // 避免同任务的旧路径响应把定位写回旧文件。
  const targets = new Map<number, SavedAvailabilityTarget>();
  for (const [id, subscriber] of hub.subscribers) targets.set(id, { ...subscriber.target });
  const groups = new Map<string, { taskIds: Map<string, number[]> }>();
  for (const [id, target] of targets) {
    const { directory, taskId } = target;
    if (!directory || !taskId) continue;
    const group = groups.get(directory) ?? { taskIds: new Map<string, number[]>() };
    group.taskIds.set(taskId, [...(group.taskIds.get(taskId) ?? []), id]);
    groups.set(directory, group);
  }
  // 按 taskId 去重、批量查询；没有 taskId 的（旧记录）逐项走清理记录查询。
  for (const [directory, group] of groups) {
    const ids = [...group.taskIds.keys()];
    const found = new Map<string, MediaTaskSummary>();
    try {
      for (let index = 0; index < ids.length; index += queryPageSize) {
        const chunk = ids.slice(index, index + queryPageSize);
        const data = await requestTask<{ tasks?: MediaTaskSummary[] }>("get", {
          method: "GET",
          query: { directory, taskIds: chunk.join(","), limit: String(queryPageSize) },
          signal: AbortSignal.timeout(queryTimeout),
        });
        for (const task of data.tasks ?? []) found.set(task.taskId, task);
      }
    } catch (error) {
      for (const [taskId, idsForTask] of group.taskIds) {
        for (const id of idsForTask) {
          const target = targets.get(id);
          deliverSavedAvailability(hub, id, {
            error, queriedTaskId: taskId, ...(target?.path ? { queriedPath: target.path } : {}),
          });
        }
      }
      continue;
    }
    for (const [taskId, idsForTask] of group.taskIds) {
      const task = found.get(taskId);
      for (const id of idsForTask) {
        const target = targets.get(id);
        // T11：发起时的逐路径身份随投递返回；投递到达时订阅方可据此判定同任务的旧路径响应（P）失效。
        const queried = { queriedTaskId: taskId, ...(target?.path ? { queriedPath: target.path } : {}) };
        if (!task) {
          // T11：未找到也要投递（带发起时身份），让订阅方按节点当前结果重建订阅，不让旧订阅在“查不到”时永远沉默。
          deliverSavedAvailability(hub, id, queried);
          continue;
        }
        deliverSavedAvailability(hub, id, { ...savedAvailabilityOfTask(task, target?.path), ...queried });
      }
    }
  }
  for (const [id, target] of targets) {
    const { directory, taskId, path } = target;
    if (!directory || taskId || !path) continue;
    try {
      deliverSavedAvailability(hub, id, { ...(await querySavedAvailability({ directory, path })), queriedPath: path });
    } catch (error) {
      deliverSavedAvailability(hub, id, { error, queriedPath: path });
    }
  }
}

function savedAvailabilityDelay(hub: SavedAvailabilityHub) {
  return typeof document !== "undefined" && document.visibilityState === "hidden" ? savedAvailabilityHiddenInterval : savedAvailabilityInterval;
}

function scheduleSavedAvailability(hub: SavedAvailabilityHub, delay = savedAvailabilityDelay(hub)) {
  if (!hub.subscribers.size) return;
  if (hub.timer) clearTimeout(hub.timer);
  hub.timer = setTimeout(() => {
    hub.timer = undefined;
    void runSavedAvailabilityRound(hub);
  }, delay);
}

function runSavedAvailabilityRound(hub: SavedAvailabilityHub): Promise<void> {
  const running = hub.round;
  if (running) return running;
  const round = querySavedAvailabilityRound(hub).then(() => {}, () => {}).finally(() => {
    if (hub.round === round) {
      hub.round = undefined;
      scheduleSavedAvailability(hub);
    }
  });
  hub.round = round;
  return round;
}

/** 立即补查（前台/联网/重新登录/画布保存成功/用户显式刷新）；已有一轮在途时在其结束后再补一轮。 */
function requestSavedAvailability(hub: SavedAvailabilityHub): Promise<void> {
  if (hub.round) return hub.round.then(() => runSavedAvailabilityRound(hub), () => runSavedAvailabilityRound(hub));
  return runSavedAvailabilityRound(hub);
}

function detachSavedAvailabilityListeners(hub: SavedAvailabilityHub) {
  if (!hub.attached) return;
  hub.attached = false;
  document.removeEventListener("visibilitychange", hub.onVisibility);
  window.removeEventListener("online", hub.onOnline);
  window.removeEventListener(authRestoredEvent, hub.onAuthRestored);
  window.removeEventListener(canvasSavedEvent, hub.onCanvasSaved);
  if (hub.savedDebounce) clearTimeout(hub.savedDebounce);
  hub.savedDebounce = undefined;
}

function attachSavedAvailabilityListeners(hub: SavedAvailabilityHub) {
  if (hub.attached) return;
  hub.attached = true;
  document.addEventListener("visibilitychange", hub.onVisibility);
  window.addEventListener("online", hub.onOnline);
  window.addEventListener(authRestoredEvent, hub.onAuthRestored);
  window.addEventListener(canvasSavedEvent, hub.onCanvasSaved);
}

function getSavedAvailabilityHub(): SavedAvailabilityHub {
  const existing = savedAvailabilityHost[savedAvailabilityHubKey];
  if (existing) return existing;
  const hub: SavedAvailabilityHub = {
    nextId: 1, subscribers: new Map(), attached: false,
    onVisibility() { if (document.visibilityState === "visible") void requestSavedAvailability(hub); else scheduleSavedAvailability(hub); },
    onOnline() { void requestSavedAvailability(hub); },
    onAuthRestored() { void requestSavedAvailability(hub); },
    // ACK 事件触发一次页面级补查（同时就是“已保存输出”的刷新入口），不按节点各起定时器；
    // 连续保存合并到同一次补查。
    onCanvasSaved() {
      if (hub.savedDebounce) clearTimeout(hub.savedDebounce);
      hub.savedDebounce = setTimeout(() => {
        hub.savedDebounce = undefined;
        void requestSavedAvailability(hub);
      }, 800);
    },
  };
  savedAvailabilityHost[savedAvailabilityHubKey] = hub;
  return hub;
}

function subscribeSavedAvailability(target: SavedAvailabilityTarget, receive: (result: SavedAvailabilityDelivery) => void) {
  const hub = getSavedAvailabilityHub();
  const id = hub.nextId++;
  hub.subscribers.set(id, { target, receive });
  attachSavedAvailabilityListeners(hub);
  void requestSavedAvailability(hub);
  return id;
}

function updateSavedAvailabilitySubscriber(id: number | undefined, target: SavedAvailabilityTarget) {
  if (id === undefined) return;
  const subscriber = getSavedAvailabilityHub().subscribers.get(id);
  if (!subscriber) return;
  subscriber.target = target;
}

function unsubscribeSavedAvailability(id: number | undefined) {
  if (id === undefined) return;
  const hub = getSavedAvailabilityHub();
  hub.subscribers.delete(id);
  if (hub.subscribers.size) return;
  if (hub.timer) clearTimeout(hub.timer);
  hub.timer = undefined;
  detachSavedAvailabilityListeners(hub);
}

/* -------------------------------------------------- 单节点任务绑定 */

/**
 * 持久媒体任务绑定：提交前先把任务标识写入 localStorage，再从服务端按 taskId（未确认时按原 batchKey）查询状态。
 * 首个响应丢失、刷新或重开后按原键找回，绝不自动生成新键重复提交（禁止重复收费）。
 * 同一页面的所有实例共享一个任务查询聚合器（W5），按目录分组、按 taskId 去重。
 */
export function useMediaTask(options: {
  mediaType: "image" | "video" | "audio";
  nodeId: string;
  resolveDirectory(): Promise<string>;
  canvasId?(): string | undefined;
  bindOutput(output: MediaTaskOutput, meta: { taskId: string; writeBackToken: string }): void;
  /** T11：节点上已保存结果的最小元数据（历史输出路径与任务 ID），用于重新挂载后查询可用性；只读，不触发生成。 */
  savedResult?(): { path?: string; taskId?: string } | undefined;
  /**
   * T11：重新挂载/被动刷新时查到服务端确认的最新输出路径（改名后的 resolvedPath）时的回调；
   * 节点据此把播放、下载与后续保存统一切到该路径，不再请求画布里的旧地址。
   */
  resolveOutputPath?(resolved: { path: string; previousPath?: string; taskId?: string; sha256?: string; mimeType?: string }): void;
}) {
  const state = ref<MediaTaskState | "idle">("idle");
  const taskId = ref("");
  const errorText = ref("");
  const notice = ref("");
  const observing = ref(false);
  const cancellationRequested = ref(false);
  /** 输出已写入节点、画布尚未以正确版本保存；期间保留任务关联与恢复依据（F05）。 */
  const pendingWriteBack = ref(false);
  /** 服务端报告的输出可用性：cleaned/missing 时界面显示已清理或缺失，不当作上游失败。 */
  const outputState = ref<MediaTaskOutputState | undefined>();
  /** G/T11：服务端跟进状态与等待原因（paused/blocked 不得显示成“继续在服务器执行”）。 */
  const trackingStatus = ref<"active" | "blocked" | "paused" | undefined>();
  const waitingReason = ref("");
  const retryAt = ref("");
  /** H/T13：本轮节点状态读取是否仍在等待订阅结果（超时后为 true，用于“仍在查询”提示）。 */
  const queryPending = ref(false);
  /** 当前结果的工作区路径：来自本次活动绑定或已保存结果查询。 */
  const resultPath = ref("");
  let binding: MediaTaskBinding | undefined;
  let storageKey = "";
  let directory = "";
  let canvasId = "";
  let attached: Promise<void> | undefined;
  /** W1 启动门：并发 start 调用串行收口，避免两次调用都判断“没有绑定”后各自提交。 */
  let starting: Promise<MediaTaskAcceptance> | undefined;
  let subscriberId: number | undefined;
  let disposed = false;
  let polling = false;
  let idlePolls = 0;
  const controllers = new Set<AbortController>();
  // H/T13：只等待本订阅自身结果的等待者集合（onHubResult 到达或短截止时统一结算）。
  const resultWaiters = new Set<() => void>();
  /**
   * T10 操作代次：建立/解除/替换绑定都会自增。取消与查询在开始时固定「目录、taskId、绑定、操作代次」，
   * 每次 await 之后复核；旧任务（A）的迟到摘要/取消响应不得更新后建立的新任务（B）、也不得更新已卸载实例。
   */
  let bindingEpoch = 0;
  /** T11：已保存结果的页面级低频可用性订阅（ACK 后仍保持显示更新）。 */
  let savedAvailabilityId: number | undefined;

  const active = computed(() => activeStates.has(state.value as MediaTaskState));
  const label = computed(() => state.value === "idle" ? "" : stateLabels[state.value as MediaTaskState]);

  // F05：关联键含 directory + canvasId + nodeId，避免同一节点 ID 在不同画布之间串关联。
  function bindingKey(value: string, canvas: string) {
    return [storagePrefix, value, canvas, options.nodeId].join("\u0000");
  }

  function readCanvasId() {
    try {
      return options.canvasId?.() ?? "";
    } catch {
      return "";
    }
  }

  async function currentDirectory(refresh = false) {
    if (refresh || !directory) {
      directory = await options.resolveDirectory();
      canvasId = readCanvasId();
      storageKey = bindingKey(directory, canvasId);
    }
    return directory;
  }

  function readBinding(): MediaTaskBinding | undefined {
    try {
      const text = localStorage.getItem(storageKey);
      if (!text) return undefined;
      const parsed = JSON.parse(text) as Partial<MediaTaskBinding> | null;
      if (!parsed || typeof parsed.batchKey !== "string" || typeof parsed.itemKey !== "string"
        || typeof parsed.submittedAt !== "string" || parsed.request === undefined) return undefined;
      if (parsed.taskId !== undefined && typeof parsed.taskId !== "string") return undefined;
      const stored = parsed.state;
      const bindingState: MediaTaskBindingState = stored === "submitted" || stored === "succeeded" || stored === "pending"
        ? stored
        : parsed.taskId ? "submitted" : "pending";
      return {
        batchKey: parsed.batchKey, itemKey: parsed.itemKey, submittedAt: parsed.submittedAt, request: parsed.request,
        state: bindingState,
        ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
        ...(typeof parsed.outputPath === "string" && parsed.outputPath ? { outputPath: parsed.outputPath } : {}),
        ...(typeof parsed.writeBackToken === "string" && parsed.writeBackToken ? { writeBackToken: parsed.writeBackToken } : {}),
      };
    } catch {
      return undefined;
    }
  }

  // ACT: 提交前先落盘任务标识；写入失败宁可不提交，也不产生无法按原键查回的任务。
  function persist(next: MediaTaskBinding) {
    try {
      const text = JSON.stringify(next);
      localStorage.setItem(storageKey, text);
      if (localStorage.getItem(storageKey) !== text) throw new Error("verify");
    } catch {
      throw new Error("无法保存任务标识（浏览器存储不可用），请检查隐私设置后重试；本次没有提交任务");
    }
  }

  // 后台状态更新使用容错写入：写不进去也不回滚已经发生的受理事实。
  function persistQuiet(next: MediaTaskBinding) {
    try {
      persist(next);
    } catch {
      notice.value = "任务标识未能保存，关闭页面后可能无法自动恢复查询";
    }
  }

  function releaseBinding(key = storageKey) {
    try {
      if (key) localStorage.removeItem(key);
    } catch {
      // 存储不可用时仅清理内存状态，不影响已受理任务。
    }
  }

  function abortRequests() {
    for (const controller of controllers) controller.abort(new Error("已停止观察任务"));
    controllers.clear();
  }

  function resetTracking() {
    trackingStatus.value = undefined;
    waitingReason.value = "";
    retryAt.value = "";
    queryPending.value = false;
    resultPath.value = "";
    for (const settle of [...resultWaiters]) settle();
  }

  /** T10 操作代次：绑定被建立/解除/替换时自增，使在途的旧操作（取消、摘要查询、提交）失效。 */
  function bumpBindingEpoch() {
    bindingEpoch++;
  }

  /** T10：本次操作是否仍是最新操作——未卸载、未换绑、代次未变化。 */
  function isCurrentOperation(epoch: number, expectedBinding: MediaTaskBinding | undefined) {
    return !disposed && epoch === bindingEpoch && binding === expectedBinding;
  }

  function clearBinding() {
    // T10 互审：解除绑定必须同时释放订阅——否则聚合器仍按旧任务的 taskId 查询，
    // 用户随后提交新任务（尚无 taskId）时会用旧任务的迟到摘要污染新任务的绑定与节点输出。
    stopPolling();
    binding = undefined;
    taskId.value = "";
    cancellationRequested.value = false;
    pendingWriteBack.value = false;
    resetTracking();
    releaseBinding();
    bumpBindingEpoch();
  }

  /** 只撤销这次确实未发出的新绑定，既有绑定不动（W1 §5.5）。 */
  function revokeBinding(target: MediaTaskBinding, key: string) {
    if (binding === target) binding = undefined;
    taskId.value = "";
    cancellationRequested.value = false;
    pendingWriteBack.value = false;
    outputState.value = undefined;
    resetTracking();
    releaseBinding(key);
    bumpBindingEpoch();
  }

  /**
   * T10：本次生成 POST 确定没有发起（目录查询失败/断网/401/身份切换/调用方取消）时，
   * 只撤销本次未发出的新绑定，允许用户直接重试；不进入 unknown、不留幽灵绑定。
   */
  function revokeUnsubmitted(current: MediaTaskBinding, createdKey?: string) {
    if (current.taskId) return;
    // T10 互审：没有留下绑定就不再保留订阅（旧任务的订阅不得继续向本实例投递）。
    stopPolling();
    if (createdKey) revokeBinding(current, createdKey);
    else if (binding === current) {
      binding = undefined;
      taskId.value = "";
      cancellationRequested.value = false;
      pendingWriteBack.value = false;
      outputState.value = undefined;
      resetTracking();
      bumpBindingEpoch();
    }
  }

  /** H/T13：本订阅收到任何结果（含错误/未找到）即结算等待者。 */
  function settleResultWaiters() {
    for (const settle of [...resultWaiters]) settle();
  }

  /** H/T13：只等待自身订阅结果，短截止后按本地已知摘要返回。 */
  function waitForOwnResult(timeoutMs = nodeResultWaitMs) {
    return new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resultWaiters.delete(finish);
        queryPending.value = resultWaiters.size > 0;
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      resultWaiters.add(finish);
      queryPending.value = true;
    });
  }

  function stopPolling() {
    observing.value = false;
    unsubscribeTask(getTaskHub(), subscriberId);
    subscriberId = undefined;
  }

  function syncSubscriber() {
    updateTaskSubscriber(getTaskHub(), subscriberId, {
      directory, taskId: binding?.taskId, batchKey: binding?.batchKey, itemKey: binding?.itemKey,
      outputPath: binding?.outputPath,
    });
  }

  function onAuthRestored() {
    // 重新登录只恢复查询：沿用原 batchKey / taskId，不重放生成；停止观察过也会重新开始观察。
    if (!binding) return;
    startPolling();
    void poll(true);
  }

  function onCanvasSaved(event: Event) {
    // T10/T11：已卸载实例不再处理保存回执（避免给已离开的节点改状态或重新拉起订阅）。
    if (disposed) return;
    const detail = (event as CustomEvent<{ directory?: string; fileName?: string; manifest?: MediaTaskWriteBackManifestEntry[] }>).detail;
    if (!binding) {
      // T11：没有活动绑定时 ACK 仍要能补上新结果（历史选择/上传替换后旧订阅不能作为唯一观察）：
      // 先按当前 savedResult 重建/同步页面级订阅——新建订阅会立即补查，已有订阅由页级 ACK 刷新补查。
      if (detail?.directory && directory && normalizePath(detail.directory) !== normalizePath(directory)) return;
      void currentDirectory().then(() => {
        if (!disposed) syncSavedAvailability();
      }).catch(() => {});
      return;
    }
    if (binding.state !== "succeeded" || !detail) return;
    if (normalizePath(detail.directory) !== normalizePath(directory)) return;
    if (!canvasId || normalizePath(detail.fileName) !== normalizePath(canvasId)) return;
    // W2：只认同一份保存快照导出的清单，且目录、画布、节点、任务、输出、token 全匹配才清临时关联；
    // 旧 ACK 或没有清单的保存不得清掉较晚输出的绑定（R06）。
    const entry = detail.manifest?.find(item => !!item
      && item.nodeId === options.nodeId && item.taskId === binding?.taskId
      && item.outputPath === binding?.outputPath && item.writeBackToken === binding?.writeBackToken);
    if (!entry) return;
    clearBinding();
    notice.value = "生成完成，画布已保存";
    // T11：ACK 只清临时关联，不清显示能力——已保存输出继续按页面级低频刷新入口更新可用性
    // （文件被清理/改名后同页仍能更新显示，且不新增每节点独立轮询）。
    void refreshSavedAvailability();
  }

  window.addEventListener(canvasSavedEvent, onCanvasSaved);
  window.addEventListener(authRestoredEvent, onAuthRestored);
  onScopeDispose(() => {
    disposed = true;
    window.removeEventListener(canvasSavedEvent, onCanvasSaved);
    window.removeEventListener(authRestoredEvent, onAuthRestored);
  });

  async function poll(again = false) {
    if (!binding) return;
    // 明确查询（继续查询/启动前确认/取消后核对）需要订阅才能收到聚合器的结果；
    // 尚未观察时恢复订阅，已观察时只同步订阅内容。
    if (!observing.value) startPolling();
    else syncSubscriber();
    // H/T13：只等待本订阅自己的结果或短截止；不等待整页聚合轮，慢目录/其它键不再拖满工具预算。
    const own = waitForOwnResult();
    void hubRequest(getTaskHub(), again);
    await own;
  }

  function startPolling() {
    if (disposed || !binding) return;
    const hub = getTaskHub();
    if (subscriberId === undefined) {
      observing.value = true;
      subscriberId = subscribeTask(hub, {
        directory, taskId: binding.taskId, batchKey: binding.batchKey, itemKey: binding.itemKey,
        outputPath: binding.outputPath,
        receive: onHubResult,
      });
      // 首次查询异步执行：受理返回不等待进度查询（F04）；轮询周期由页面级聚合器统一调度。
      void hubRequest(hub);
      return;
    }
    // T10 互审：已订阅时也必须把订阅同步到当前绑定——避免“停止观察未执行/换绑”留下按旧任务查询的订阅。
    observing.value = true;
    syncSubscriber();
  }

  function onHubResult(result: TaskHubDelivery) {
    // T10 互审：按 taskId 投递时要求当前绑定存在且 taskId 完全一致才采纳。
    // 绑定为空、绑定还没有 taskId（新提交尚未确认）、或 taskId 不同（旧任务的迟到结果）一律丢弃：
    // 不改绑定/观察/界面，但结算本订阅等待者，避免调用方无谓等满短截止。
    if (result.queriedTaskId !== undefined) {
      if (!binding || !binding.taskId || binding.taskId !== result.queriedTaskId) {
        settleResultWaiters();
        return;
      }
    } else {
      // 按 batchKey/itemKey 投递（首包未确认）：同样要求与当前绑定一致，否则丢弃。
      if (result.queriedBatchKey !== undefined && binding?.batchKey !== result.queriedBatchKey) {
        settleResultWaiters();
        return;
      }
      if (result.queriedItemKey !== undefined && binding?.itemKey !== result.queriedItemKey) {
        settleResultWaiters();
        return;
      }
    }
    // T11：投递还携带发起时的输出定位；同一任务但绑定输出已切到新定位（改名后切路径、旧响应迟到）时
    // 按迟到结果丢弃，绝不把旧路径写回节点（不同 taskId 的检查只保护 A→B）。
    if (result.queriedOutputPath !== undefined
      && normalizePath(binding?.outputPath) !== normalizePath(result.queriedOutputPath)) {
      settleResultWaiters();
      return;
    }
    // H/T13：任何结果（含错误/未找到）都算本轮订阅已返回，先结算本地等待者。
    settleResultWaiters();
    if (disposed || !binding) return;
    if (result.error !== undefined) {
      idlePolls++;
      if ((result.error as { unauthorized?: boolean }).unauthorized) notice.value = "登录已过期，任务关联已保留；重新登录后自动继续查询";
      else if (!errorText.value) notice.value = "任务状态查询失败，将自动重试";
      return;
    }
    const task = result.task;
    if (!task) {
      // 短时间查不到记录不是未受理的证明：保留关联与原键，稍后继续查询。
      idlePolls++;
      notice.value = "暂未查到任务记录，已保留原任务标识并继续查询";
      return;
    }
    idlePolls = 0;
    if (!binding.taskId && task.taskId) {
      binding.taskId = task.taskId;
      binding.state = "submitted";
      taskId.value = task.taskId;
      persistQuiet(binding);
      syncSubscriber();
    }
    applyTask(task);
  }

  /** 三态摘要查询（T10）：成功取到 / 未找到 / 查询失败；不能以 Promise resolve 代替“确认无输出”。 */
  type SummaryQuery = { outcome: "ok" | "notFound" | "failed"; task?: MediaTaskSummary; error?: unknown };

  /**
   * 三态摘要查询（T10）：成功取到 / 未找到 / 查询失败；不能以 Promise resolve 代替“确认无输出”。
   * pinnedDirectory 固定本次查询的目录（取消/恢复流程在 await 前就固定，避免中途换目录）。
   */
  async function requestSummary(query: { taskId?: string; batchKey?: string; itemKey?: string }, signal?: AbortSignal, pinnedDirectory?: string): Promise<SummaryQuery> {
    const target = pinnedDirectory ?? await currentDirectory(true);
    const params: Record<string, string> = { directory: target, limit: query.taskId ? "1" : String(queryPageSize) };
    if (query.taskId) params.taskIds = query.taskId;
    else params.batchKey = query.batchKey ?? "";
    let data: { tasks?: MediaTaskSummary[] };
    try {
      data = await requestTask<{ tasks: MediaTaskSummary[] }>("get", {
        method: "GET",
        query: params,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(queryTimeout)]) : AbortSignal.timeout(queryTimeout),
      });
    } catch (error) {
      return { outcome: "failed", error };
    }
    const tasks = data.tasks ?? [];
    const task = query.taskId
      ? tasks.find(item => item.taskId === query.taskId)
      : tasks.find(item => query.itemKey !== undefined && item.itemKey === query.itemKey) ?? tasks.find(item => !!item.taskId) ?? tasks[0];
    return task ? { outcome: "ok", task } : { outcome: "notFound" };
  }

  /** T11：已保存结果的可用性公共查询（只读，不触发生成）；失败返回 undefined，不误报可用。 */
  async function queryFileAvailability(path: string): Promise<{ state: MediaTaskOutputState; cleanedAt?: string } | undefined> {
    if (!path || !directory) return undefined;
    try {
      const result = await querySavedAvailability({ directory, path });
      if (!result.state) return undefined;
      return { state: result.state, ...(result.cleanedAt ? { cleanedAt: result.cleanedAt } : {}) };
    } catch {
      return undefined;
    }
  }

  /**
   * T11：本次结果是否仍然是「节点当前那一份已保存结果」的——投递/刷新是异步的，
   * 期间的替换、改写（含改名后节点已切到新路径）都必须让迟到结果作废，绝不把定位切回旧路径。
   * 同一任务（taskId 相同）但路径已变也视为不同结果：旧定位的在途响应不得覆盖新定位。
   */
  function isSameSavedResult(expected: { path?: string; taskId?: string }) {
    const latest = options.savedResult?.();
    if (!latest?.path && !latest?.taskId) return false;
    if (expected.taskId) {
      if (latest.taskId !== expected.taskId) return false;
      if (expected.path !== undefined && latest.path !== undefined) {
        return normalizePath(expected.path) === normalizePath(latest.path);
      }
      return true;
    }
    return !!expected.path && !!latest.path && normalizePath(expected.path) === normalizePath(latest.path);
  }

  /**
   * T11：投递针对的订阅身份是否仍是节点当前那一份已保存结果（任务 + 发起时的路径/输出代次比对）。
   * 只比对 taskId 保护不了同任务的 P→Q：改定位后旧 hub 响应必须以路径不一致失效并丢弃。
   */
  function matchesSavedAvailabilityTarget(delivery: SavedAvailabilityDelivery, saved: { path?: string; taskId?: string }) {
    if (delivery.queriedTaskId !== undefined) {
      if (saved.taskId !== delivery.queriedTaskId) return false;
      if (delivery.queriedPath !== undefined && saved.path !== undefined) {
        return normalizePath(saved.path) === normalizePath(delivery.queriedPath);
      }
      return true;
    }
    if (delivery.queriedPath !== undefined) {
      return !!saved.path && normalizePath(saved.path) === normalizePath(delivery.queriedPath);
    }
    return false;
  }

  /** T11：把一次可用性结果发布到节点显示（刷新与页面级订阅共用），并把服务端确认的最新路径交给节点。 */
  function applySavedAvailability(delivery: SavedAvailabilityDelivery, saved: { path?: string; taskId?: string }) {
    if (disposed || binding) return;
    // T11 互审：应用前复核「这次结果针对的还是节点当前那份已保存结果」。
    // 结果在途期间节点输出被替换/改写时（含已切到改名后的新路径），一律丢弃迟到结果。
    if (!matchesSavedAvailabilityTarget(delivery, saved)) return;
    if (delivery.error !== undefined) {
      // 查询失败不误报可用或已清理：保留当前显示，页面级低频入口会继续核对。
      notice.value ||= "已保存输出的可用性暂时查询不到，将按页面级低频继续核对";
      return;
    }
    const path = delivery.path || saved.path || "";
    if (path) resultPath.value = path;
    if (delivery.state === undefined) return;
    outputState.value = delivery.state === "available" ? undefined : delivery.state;
    if (delivery.state === "available") {
      // 恢复可用时只清掉本功能自己的“不可用”提示，不覆盖任务链路的其它提示（如“画布已保存”）。
      if (notice.value === cleanedSavedOutputNotice || notice.value === missingSavedOutputNotice) notice.value = "";
    } else {
      notice.value = delivery.state === "cleaned"
        ? cleanedSavedOutputNotice
        : missingSavedOutputNotice;
    }
    // T11：服务端确认的最新路径（改名后的 resolvedPath）统一交给节点用于播放、下载与后续保存，
    // 不再请求画布里的旧地址；路径未变化或仍不可用时不动。
    if (delivery.state === "available" && path && saved.path && normalizePath(path) !== normalizePath(saved.path)) {
      options.resolveOutputPath?.({ path, previousPath: saved.path, ...(saved.taskId ? { taskId: saved.taskId } : {}) });
      // 节点定位已切到最新路径：把订阅目标同步到新路径（任务 ID 不变，查询仍按 taskId）。
      syncSavedAvailability();
    }
  }

  /**
   * T11：一次可用性投递的处理。投递携带的是「发起查询时的订阅身份（任务 + 路径）」；与节点当前已保存结果
   * 不一致时（历史选择/上传替换/改名切路径后的旧订阅）不能只丢弃：把订阅重建到当前结果并立即补查一次，
   * 旧订阅不得继续作为唯一观察，也不能靠提高轮询频率解决。
   */
  function receiveSavedAvailability(delivery: SavedAvailabilityDelivery) {
    if (disposed || binding) return;
    const latest = options.savedResult?.();
    if (!latest?.path && !latest?.taskId) {
      // 节点已没有已保存结果：释放观察。
      syncSavedAvailability();
      return;
    }
    if (!matchesSavedAvailabilityTarget(delivery, latest)) {
      const hadSubscription = savedAvailabilityId !== undefined;
      syncSavedAvailability();
      // 已有订阅时立即补查新结果（新建订阅由 subscribeSavedAvailability 自行补查，不重复发轮）。
      if (hadSubscription && savedAvailabilityId !== undefined) void requestSavedAvailability(getSavedAvailabilityHub());
      return;
    }
    applySavedAvailability(delivery, latest);
  }

  /** T11：按当前节点已保存结果维护页面级低频可用性订阅（有活动绑定时由任务摘要链路负责，不重复订阅）。 */
  function syncSavedAvailability() {
    if (disposed || binding) {
      unsubscribeSavedAvailability(savedAvailabilityId);
      savedAvailabilityId = undefined;
      return;
    }
    const saved = options.savedResult?.();
    if (!saved?.path && !saved?.taskId) {
      unsubscribeSavedAvailability(savedAvailabilityId);
      savedAvailabilityId = undefined;
      return;
    }
    const target: SavedAvailabilityTarget = {
      directory,
      ...(saved.taskId ? { taskId: saved.taskId } : {}),
      ...(saved.path ? { path: saved.path } : {}),
    };
    if (savedAvailabilityId === undefined) {
      savedAvailabilityId = subscribeSavedAvailability(target, receiveSavedAvailability);
      return;
    }
    updateSavedAvailabilitySubscriber(savedAvailabilityId, target);
  }

  // T11：节点当前已保存结果的“身份”（任务 + 路径）。历史「设为当前结果」、上传替换或改名切路径都会改变它——
  // 监听变化并把观察目标重建到新结果（切到新结果 B），旧订阅不再作为唯一观察。
  if (options.savedResult) {
    const savedResultIdentity = computed(() => {
      const saved = options.savedResult?.();
      return saved ? `${saved.taskId ?? ""}\u0000${saved.path ? normalizePath(saved.path) : ""}` : "";
    });
    watch(savedResultIdentity, () => {
      if (disposed) return;
      void currentDirectory().then(() => {
        if (disposed) return;
        const hadSubscription = savedAvailabilityId !== undefined;
        syncSavedAvailability();
        // 已有订阅时立即补查一次新结果（新建订阅由 subscribeSavedAvailability 自行补查）。
        if (hadSubscription && savedAvailabilityId !== undefined) void requestSavedAvailability(getSavedAvailabilityHub());
      }).catch(() => {});
    });
  }

  /**
   * T11：重新挂载后查询已保存结果的可用性（任务摘要优先，其次 /api/cleanup/record 公共查询）。
   * 只读：不提交、不触发生成、不改任务关联；活动绑定时由任务摘要链路负责。
   * ACK 之后本入口仍有效（`refresh` 之外还可由页面级低频订阅持续更新显示）。
   */
  async function refreshSavedAvailability(): Promise<MediaTaskOutputState | undefined> {
    if (disposed || binding) return outputState.value;
    const saved = options.savedResult?.();
    if (!saved?.path && !saved?.taskId) return undefined;
    const epoch = bindingEpoch;
    const expectedBinding = binding;
    await currentDirectory();
    // T11 互审：目录解析后在途期间节点输出可能已被替换/改写，直接放弃本次刷新（不改显示、不切路径）。
    if (!isCurrentOperation(epoch, expectedBinding) || !isSameSavedResult(saved)) return outputState.value;
    if (saved?.taskId) {
      const summary = await requestSummary({ taskId: saved.taskId });
      if (!isCurrentOperation(epoch, expectedBinding) || !isSameSavedResult(saved)) return outputState.value;
      if (summary.outcome === "ok" && summary.task) {
        const availability = outputStateOf(summary.task);
        const output = availableOutput(summary.task);
        const path = mediaTaskOutputPath(output) || saved.path || "";
        outputState.value = availability;
        if (path) resultPath.value = path;
        if (path && (availability === "cleaned" || availability === "missing")) {
          notice.value = availability === "cleaned"
            ? cleanedSavedOutputNotice
            : missingSavedOutputNotice;
        } else if (availability === undefined && path && saved.path && normalizePath(path) !== normalizePath(saved.path)) {
          // T11：改名（改名记录/迁移）后的最新路径统一交给节点，播放、下载与后续保存都用它。
          options.resolveOutputPath?.({ path, previousPath: saved.path, taskId: summary.task.taskId });
        }
        syncSavedAvailability();
        return availability;
      }
    }
    const path = saved?.path;
    if (!path) return undefined;
    const file = await queryFileAvailability(path);
    if (!isCurrentOperation(epoch, expectedBinding) || !isSameSavedResult(saved)) return outputState.value;
    resultPath.value = path;
    outputState.value = file?.state === "available" ? undefined : file?.state;
    if (outputState.value === "cleaned") notice.value = cleanedSavedOutputNotice;
    else if (outputState.value === "missing") notice.value = missingSavedOutputNotice;
    syncSavedAvailability();
    return outputState.value;
  }

  /** 统一从任务摘要判断输出可用性：服务端 outputState 优先，其次按各输出 state（兼容旧 outputState）归并。 */
  function outputStateOf(task: MediaTaskSummary): MediaTaskOutputState | undefined {
    if (task.outputState) return task.outputState;
    const outputs = task.outputs ?? [];
    if (!outputs.length) return undefined;
    const states = outputs.map(item => mediaTaskOutputState(item));
    if (states.every(value => value === "available")) return undefined;
    if (states.every(value => value === "cleaned")) return "cleaned";
    if (states.every(value => value === "missing")) return "missing";
    // 混合输出优先可用项：仍有 available 时由 availableOutput 处理，不整体判为清理/缺失。
    if (states.includes("available")) return undefined;
    return states.includes("cleaned") ? "cleaned" : "missing";
  }

  function availableOutput(task: MediaTaskSummary): MediaTaskOutput | undefined {
    return (task.outputs ?? []).find(item => !!mediaTaskOutputPath(item) && mediaTaskOutputState(item) === "available");
  }

  function bindSucceededOutput(task: MediaTaskSummary, suffix = "") {
    outputState.value = outputStateOf(task);
    const output = availableOutput(task);
    if (!output) {
      // R09/W4：已清理或缺失的输出不再当作可播放成片绑定，也不作为上游失败；任务关联保留供显示与人工核对。
      const reportedPath = mediaTaskOutputPath(task.outputs?.[0]);
      errorText.value = "";
      notice.value = outputState.value === "cleaned"
        ? "生成结果已被自动清理：任务记录与历史保留，已停止播放与下载；不会自动重新生成"
        : "任务已完成，但输出文件缺失或不可用；不会自动重新生成";
      if (binding) {
        binding.taskId = task.taskId;
        binding.state = "succeeded";
        if (reportedPath) binding.outputPath = reportedPath;
        binding.writeBackToken = undefined;
        persistQuiet(binding);
        // T11：订阅目标同步到当前输出定位（同一任务的后续投递按新定位校验）。
        syncSubscriber();
      }
      if (reportedPath) resultPath.value = reportedPath;
      // 已清理/缺失的输出没有可回写内容：解除“待回写”，不阻塞后续生成（是否重建关联由用户明确操作）。
      pendingWriteBack.value = false;
      return false;
    }
    const taskIdValue = task.taskId;
    // G/T11：改名后使用 resolvedPath，其次原 path；输出项整体（含 state/cleanedAt/sha256）交给节点。
    const outputPath = mediaTaskOutputPath(output);
    // W2：同一任务同一输出身份复用同一 writeBackToken；只有新任务或真正新输出才新建。
    const sameResult = binding?.taskId === taskIdValue && binding?.outputPath === outputPath && !!binding.writeBackToken;
    const writeBackToken = sameResult ? binding!.writeBackToken! : crypto.randomUUID();
    options.bindOutput({ ...output, path: outputPath }, { taskId: taskIdValue, writeBackToken });
    resultPath.value = outputPath;
    if (binding) {
      binding.taskId = taskIdValue;
      binding.state = "succeeded";
      binding.outputPath = outputPath;
      binding.writeBackToken = writeBackToken;
      persistQuiet(binding);
      // T11：订阅目标同步到当前输出定位（同一任务的后续投递按新定位校验）。
      syncSubscriber();
    }
    pendingWriteBack.value = true;
    notice.value = `生成完成${suffix}，画布保存成功后自动清理任务关联`;
    return true;
  }

  /** 服务端退避时间的人类可读表达；无效时间不展示。 */
  function retryText(value: string) {
    const at = Date.parse(value);
    return Number.isNaN(at) ? "" : new Date(at).toLocaleTimeString();
  }

  function applyTask(task: MediaTaskSummary) {
    // T10：只应用当前绑定的任务。旧任务（A）的迟到摘要（取消后补查、旧一轮聚合查询）
    // 既不得更新后建立的新任务（B）的绑定/观察/界面，也不得在关联已被解除后重新拉起状态。
    if (!binding) return;
    if (binding.taskId && task.taskId && binding.taskId !== task.taskId) return;
    state.value = task.state;
    cancellationRequested.value = task.cancellationRequested;
    trackingStatus.value = task.trackingStatus ?? (activeStates.has(task.state) ? "active" : undefined);
    waitingReason.value = task.waitingReason ?? "";
    retryAt.value = task.retryAt ?? "";
    errorText.value = task.error ?? "";
    if (task.state === "succeeded") {
      bindSucceededOutput(task);
      stopPolling();
      return;
    }
    if (activeStates.has(task.state)) {
      // G/T11：paused/blocked 不得显示成“继续在服务器执行”，并透出可读等待原因与下次重试时间。
      if (trackingStatus.value === "paused") {
        notice.value = `任务已暂停跟进：服务器不再自动查询（上游可能仍在生成）${waitingReason.value ? `；${waitingReason.value}` : ""}，可在任务记录中恢复`;
      } else if (trackingStatus.value === "blocked") {
        notice.value = `任务跟进受阻${waitingReason.value ? `：${waitingReason.value}` : ""}；任务关联已保留，可继续查询或到任务记录中恢复`;
      } else if (retryAt.value) {
        const at = retryText(retryAt.value);
        notice.value = `任务继续在服务器执行${at ? `，服务器将在 ${at} 后重试查询` : ""}，可关闭页面`;
      } else {
        notice.value = "已受理，任务继续在服务器执行，可关闭页面";
      }
      return;
    }
    // 契约 A：unknown 是待核对状态，保留关联继续查询，绝不提示重新生成或自动重提。
    if (task.state === "unknown") {
      // 互审：unknown 同样要透出服务端等待原因（paused/blocked 等），不再被通用文案覆盖。
      notice.value = `提交结果待核对，已保留任务标识；可继续查询或人工核对${waitingReason.value ? `；${waitingReason.value}` : ""}`;
      return;
    }
    if (task.state === "failed") {
      // W2：failed 含合法部分输出时保留失败原因并继续“待回写”，不能直接清关联。
      if (availableOutput(task)) {
        bindSucceededOutput(task, "（部分输出已取回）");
        errorText.value ||= task.error || "生成失败";
        stopPolling();
        return;
      }
      errorText.value ||= "生成失败";
      notice.value = "";
      clearBinding();
      stopPolling();
      return;
    }
    if (task.state === "cancelled") {
      // W2：确认 cancelled 且没有待回写结果才清关联；取消前已取回的输出仍走待回写。
      if (availableOutput(task)) {
        bindSucceededOutput(task, "（取消前已取回部分输出）");
        stopPolling();
        return;
      }
      notice.value = "任务已取消";
      clearBinding();
      stopPolling();
    }
  }

  async function send(current: MediaTaskBinding, sendOptions?: { signal?: AbortSignal; identity?: { directory: string; canvasId: string }; createdKey?: string }) {
    const caller = sendOptions?.signal;
    // W1/T10：取消信号与目录/画布身份校验都纳入同一可撤销生命周期——POST 未发出时只撤销本次未发出的新绑定。
    const preSubmitFailure = (message: string) => Object.assign(new Error(message), { cancelled: true, preSubmit: true });
    const ensureActive = () => {
      if (caller?.aborted) throw preSubmitFailure("本次提交已取消（未发往服务器）");
    };
    const controller = new AbortController();
    /**
     * T10：显式事实——本次生成 POST 是否真的已发起。只有真正进入网络调用前一刻才置位，
     * 不复用异常上的 preSubmit 属性推断；置位之前的任何失败都是“确定未提交”。
     */
    let postAttempted = false;
    state.value = "submitting";
    errorText.value = "";
    try {
      ensureActive();
      // 目录准备与身份校验在 try 内：这里抛出的 preSubmit 同样走撤销路径，不留幽灵绑定。
      const target = await currentDirectory(true);
      ensureActive();
      const identity = sendOptions?.identity;
      if (identity && (target !== identity.directory || readCanvasId() !== identity.canvasId)) {
        throw preSubmitFailure("工作区或画布已切换，本次提交已取消（未发往服务器）");
      }
      controllers.add(controller);
      const canvas = readCanvasId();
      ensureActive();
      // 真正进入网络调用前一刻：此后结果不明才按 unknown 保留原键恢复查询。
      postAttempted = true;
      const data = await requestTask<{ items: { itemKey: string; status: "accepted" | "existing" | "rejected"; taskId?: string; reason?: string }[] }>("submit", {
        method: "POST",
        body: {
          directory: target, batchKey: current.batchKey, mediaType: options.mediaType,
          items: [{ itemKey: current.itemKey, request: current.request, nodeId: options.nodeId, ...(canvas ? { canvasId: canvas } : {}) }],
        },
        // 已受理的后台任务不随控制命令超时取消：控制信号只约束本次提交请求本身。
        signal: caller
          ? AbortSignal.any([caller, controller.signal, AbortSignal.timeout(submitTimeout)])
          : AbortSignal.any([controller.signal, AbortSignal.timeout(submitTimeout)]),
      });
      const item = data.items?.find(entry => entry.itemKey === current.itemKey) ?? data.items?.[0];
      if (!item || item.status === "rejected" || !item.taskId) {
        throw Object.assign(new Error(item?.reason || "任务没有被服务器受理"), { rejected: true });
      }
      current.taskId = item.taskId;
      current.state = "submitted";
      current.submittedAt = new Date().toISOString();
      if (disposed || binding !== current) {
        // T10：POST 返回时组件已卸载或绑定已被替换（用户取消后新建了 B）：
        // 不得改写当前 UI/观察，也不得用 A 覆盖 B 在同一个键上的绑定；但这次受理是真实的上游事实，
        // 必须留下可见的找回依据，避免变成无主任务或被当成未提交而重复生成。
        if (binding === current) persistQuiet(current);
        else notice.value = `本次提交实际上已被服务器受理（任务 ${item.taskId}），本节点此后改用新的任务关联；可在服务器任务列表中继续核对`;
        return;
      }
      taskId.value = item.taskId;
      cancellationRequested.value = false;
      errorText.value = "";
      notice.value = "已受理，任务继续在服务器执行，可关闭页面";
      idlePolls = 0;
      try {
        persist(current);
      } catch {
        // 受理事实不因标识保存失败回滚；只是关闭页面后无法自动恢复查询。
        notice.value = "任务已受理，但任务标识未能保存，关闭页面后可能无法自动恢复查询";
      }
      // 收到 taskId 即完成受理动作：只启动轮询，不等待首次进度查询（F04）。
      state.value = "queued";
      syncSavedAvailability();
      startPolling();
    } catch (failure) {
      if ((failure as { rejected?: boolean }).rejected) {
        // 服务端明确拒绝：没有创建任务，清除本次标识以便修改参数后重新发起。
        // 失败原因由调用方抛出并提示，这里不再重复写 errorText，避免重复提示。
        // T10：本次提交已被新任务取代时不改当前 UI/绑定。
        if (binding === current) {
          stopPolling();
          clearBinding();
          state.value = "failed";
          errorText.value = "";
          notice.value = "";
        }
        throw failure;
      }
      if (!postAttempted) {
        // T10：确定没有发出生成 POST（目录查询失败/断网/401/工作区或画布切换/调用方取消）→ 属准备失败：
        // 撤销本次未发出的新绑定、允许直接重试；不转 unknown、不占用“防重复提交”的键。
        const owned = binding === current;
        revokeUnsubmitted(current, sendOptions?.createdKey);
        // 已被新任务取代时不改当前 UI；调用方仍收到“未提交”的明确失败。
        if (!owned) throw Object.assign(failure instanceof Error ? failure : new Error(String(failure)), { preSubmit: true });
        state.value = "idle";
        errorText.value = "";
        notice.value = (failure as { cancelled?: boolean }).cancelled
          ? "本次提交已取消，没有发往服务器"
          : "准备提交时未完成（未发往服务器），可直接重试";
        throw Object.assign(failure instanceof Error ? failure : new Error(String(failure)), { preSubmit: true });
      }
      // POST 已发起但结果不明（超时/网络中断/5xx/控制命令中断）：保留原键与请求，之后按原键确认，不重复提交。
      current.state = "pending";
      persistQuiet(current);
      state.value = "unknown";
      errorText.value = "提交结果待核对：任务标识已保存，稍后会按原标识继续确认，不会重复提交";
      notice.value = "";
      // F04/W2：立即按原 batchKey / itemKey 自动开始恢复查询，不依赖点击“继续查询”。
      if (!disposed) startPolling();
    } finally {
      controllers.delete(controller);
    }
  }

  function attach(): Promise<void> {
    // F04：失败的 attach 不永久缓存，之后仍可再次恢复；成功结果只在本次会话内缓存。
    attached ??= (async () => {
      await currentDirectory(true);
      binding = readBinding();
      taskId.value = binding?.taskId ?? "";
      if (!binding) return;
      if (!binding.taskId) {
        // 首包响应丢失：不重新提交也不换新键，只按原 batchKey 查询找回。
        binding.state = "pending";
        persistQuiet(binding);
        state.value = "unknown";
        notice.value = "提交结果待核对：正在按原任务标识查询，不会重复提交";
        startPolling();
        return;
      }
      if (!activeStates.has(state.value as MediaTaskState) && state.value !== "succeeded") state.value = "queued";
      if (binding.state === "succeeded" && binding.outputPath && binding.writeBackToken) {
        // 重挂载时输出已写入节点但尚未确认保存：保守保持“待回写”，直到同一快照的保存确认到达。
        pendingWriteBack.value = true;
      }
      // T11：重新挂载即恢复活动任务观察；已保存结果的可用性由 refreshSavedAvailability 接管。
      syncSavedAvailability();
      startPolling();
    })().catch((failure: unknown) => {
      attached = undefined;
      if (!errorText.value) errorText.value = failure instanceof Error ? failure.message : "任务状态恢复失败";
    });
    return attached;
  }

  function start(request: unknown, options?: { signal?: AbortSignal }): Promise<MediaTaskAcceptance> {
    const previous = starting;
    const run: Promise<MediaTaskAcceptance> = (async () => {
      // W1 启动门：等待并发的上一次启动收口后再判断绑定，避免两次调用同时认为“没有绑定”。
      if (previous) await previous.catch(() => {});
      if (options?.signal?.aborted) throw Object.assign(new Error("本次提交已取消（未发往服务器）"), { cancelled: true, preSubmit: true });
      await attach();
      // T10：等待期间组件已被卸载时不再新建绑定（此时还没有任何网络提交）。
      if (disposed) throw Object.assign(new Error("节点已关闭，本次没有提交任务"), { cancelled: true, preSubmit: true });
      if (options?.signal?.aborted) throw Object.assign(new Error("本次提交已取消（未发往服务器）"), { cancelled: true, preSubmit: true });
      const current = binding;
      if (current) {
        // T10：查询期间绑定可能被人工清除或换成新任务，返回值不得把旧 taskId 与新任务状态混在一起。
        const epoch = bindingEpoch;
        // T01：只要还有本地绑定（含 unknown、无论是否已有 taskId），一律只查询、不新建提交键；
        // 只有可信终态（succeeded/failed/cancelled 且输出处理完成）或用户人工核对后 discard 才会解除绑定。
        if (!current.taskId) {
          // 没有 taskId 时只查询确认，不重新提交（防重复收费）；查不到保留关联供人工核对。
          await poll(true);
          if (!isCurrentOperation(epoch, current)) return { status: "pending", state: state.value, message: notice.value || "任务关联已变更，请重新查询" };
          // 查询按原 batchKey 找回 taskId 后按 existing 返回；仍未找到保持 pending。
          return current.taskId
            ? { status: "existing", taskId: current.taskId, state: state.value, message: errorText.value || notice.value }
            : { status: "pending", state: state.value, message: errorText.value || notice.value };
        }
        // 已有绑定只查询，不重复提交；查询后可能已直接完成并绑定输出。
        await poll(true);
        if (!isCurrentOperation(epoch, current)) return { status: "pending", state: state.value, message: notice.value || "任务关联已变更，请重新查询" };
        return { status: "existing", taskId: current.taskId, state: state.value, message: errorText.value || notice.value };
      }
      // 最初目录/画布身份：提交准备开始前固定，persist 与 POST 前各重查一次（W1）。
      const initialDirectory = directory;
      const initialCanvasId = readCanvasId();
      const created: MediaTaskBinding = {
        batchKey: crypto.randomUUID(), itemKey: crypto.randomUUID(), state: "pending",
        submittedAt: new Date().toISOString(), request,
      };
      if (options?.signal?.aborted) throw Object.assign(new Error("本次提交已取消（未发往服务器）"), { cancelled: true, preSubmit: true });
      if (directory !== initialDirectory || readCanvasId() !== initialCanvasId) {
        throw Object.assign(new Error("工作区或画布已切换，本次提交已取消（未发往服务器）"), { cancelled: true, preSubmit: true });
      }
      persist(created);
      binding = created;
      // T10：新绑定是一次新的操作代次；此前在途的取消/摘要查询不得再写状态。
      bumpBindingEpoch();
      // T11：进入活动任务绑定后由任务摘要链路负责显示，停止已保存结果的可用性订阅。
      syncSavedAvailability();
      const createdKey = storageKey;
      await send(created, { signal: options?.signal, identity: { directory: initialDirectory, canvasId: initialCanvasId }, createdKey });
      // 没有 taskId 时不得返回 accepted：界面与调用方显示“提交待核对”，可人工核对或继续查询。
      if (!created.taskId) return { status: "pending", state: state.value, message: errorText.value || notice.value };
      // T10：提交在途时绑定已被替换（用户改用了新任务）：本次受理事实照实返回，但不借用新任务的界面状态。
      if (binding !== created) return { status: "accepted", taskId: created.taskId, state: "queued", message: notice.value };
      return { status: "accepted", taskId: created.taskId, state: state.value, message: errorText.value || notice.value };
    })();
    const tracked = run.finally(() => {
      if (starting === tracked) starting = undefined;
    });
    starting = tracked;
    return tracked;
  }

  async function cancel(mode: "task" | "observe" = "task"): Promise<MediaTaskCancelResult> {
    if (mode === "observe") {
      stopObserving();
      return { state: state.value, taskId: taskId.value || undefined, cancellationRequested: cancellationRequested.value, observing: observing.value, message: notice.value };
    }
    await attach();
    if (disposed) return { state: state.value, taskId: taskId.value || undefined, cancellationRequested: cancellationRequested.value, observing: observing.value, message: notice.value };
    // T10：本次取消固定「目录、taskId、绑定实例与操作代次」，每个 await 之后复核；
    // 旧任务的迟到取消响应/摘要不得更新后建立的新任务（B）或已卸载实例。
    const epoch = bindingEpoch;
    const current = binding;
    // T11：同时固定发起时的输出定位（含尚未建立输出的情形）；取消直查摘要不走 hub，
    // 应用前必须按它复核，防同任务的旧路径（P）在改名到 Q 后经直查摘要写回。
    const requestedOutputPath = current?.outputPath;
    const target = current?.taskId ?? taskId.value;
    if (!current && !target) return { state: state.value, taskId: undefined, cancellationRequested: false, observing: observing.value, message: "当前没有可取消的服务器任务" };
    /** 当前状态的三态返回（用于本次取消已被更新操作取代时的安全返回）。 */
    const currentResult = (): MediaTaskCancelResult => ({
      state: state.value, taskId: taskId.value || undefined, cancellationRequested: cancellationRequested.value,
      observing: observing.value, message: notice.value || "本次取消的旧任务已被新的任务关联取代，未改动当前状态",
    });
    const body = target ? { taskIds: [target] } : { batchKey: current!.batchKey };
    let cancelDirectory: string;
    try {
      cancelDirectory = await currentDirectory(true);
    } catch (error) {
      if (!isCurrentOperation(epoch, current)) return currentResult();
      throw error;
    }
    if (!isCurrentOperation(epoch, current)) return currentResult();
    const data = await requestTask<{ items: { taskId: string; state: MediaTaskState; cancellationRequested: boolean; upstreamCancellation?: boolean }[] }>("cancel", {
      method: "POST",
      body: { directory: cancelDirectory, ...body },
      signal: AbortSignal.timeout(queryTimeout),
    });
    if (!isCurrentOperation(epoch, current)) return currentResult();
    const item = target ? data.items?.find(entry => entry.taskId === target) : data.items?.find(entry => entry.state !== "unknown");
    if (!item) {
      if (target) throw new Error("取消请求没有被服务器受理");
      // 服务器上没有该提交键的记录：保留本地标识与人工核对入口，不谎称已取消。
      notice.value = "服务器上没有查到该提交记录，本地任务标识已保留";
      return { state: state.value, taskId: undefined, cancellationRequested: false, observing: observing.value, message: notice.value };
    }
    state.value = item.state;
    cancellationRequested.value = item.cancellationRequested;
    if (activeStates.has(item.state)) {
      notice.value = item.upstreamCancellation === false ? "已请求取消，等待服务器确认；供应商可能无法撤销本次生成" : "已请求取消，等待服务器确认";
      startPolling();
    } else {
      // W2/T10：cancel 返回 succeeded/unknown/failed/cancelled 时先查完整摘要（三态：
      // 成功取到 / 未找到 / 查询失败），由 applyTask 统一裁决；
      // 只有可靠终态且输出处理完成才清关联——查询失败或空结果一律保留绑定与待回写。
      const reportedLabel = stateLabels[item.state];
      const summary = await requestSummary({ taskId: current?.taskId ?? target, batchKey: current?.batchKey, itemKey: current?.itemKey }, undefined, cancelDirectory);
      // T10：摘要返回时若已换绑/卸载，旧任务（A）的迟到摘要不得清掉或改写新任务（B）的绑定与观察。
      if (!isCurrentOperation(epoch, current)) return currentResult();
      // T11：取消直查摘要不携带发起时输出定位——应用前按同一身份复核：直查在途期间同一任务的输出定位
      // 已被更新（改名 P→Q 后任务 hub 先落地 Q）时丢弃旧摘要，不把旧路径写回绑定/节点，也不改动观察。
      if (normalizePath(binding?.outputPath) !== normalizePath(requestedOutputPath)) {
        notice.value = "取消核对期间任务结果已更新（结果定位已变化），本次取消的旧摘要未采用";
        return currentResult();
      }
      if (summary.outcome === "ok" && summary.task) {
        applyTask(summary.task);
        if (binding && state.value === "cancelled" && !pendingWriteBack.value) {
          notice.value = "任务已取消";
          clearBinding();
          stopPolling();
        }
      } else {
        // 不能以 Promise resolve 代替“确认无输出”：保留关联与待回写依据，按“待核对”继续观察以便稍后收敛。
        notice.value = summary.outcome === "notFound"
          ? `服务器返回“${reportedLabel}”，但未查到完整任务摘要；任务关联与可能的部分输出已保留，正按原任务继续查询`
          : `服务器返回“${reportedLabel}”，但完整摘要查询失败（网络或登录问题）；任务关联与可能的部分输出已保留，正按原任务继续查询`;
        if (!activeStates.has(state.value as MediaTaskState) && state.value !== "succeeded") state.value = "unknown";
        cancellationRequested.value = true;
        startPolling();
      }
      if (binding && activeStates.has(state.value as MediaTaskState) && cancellationRequested.value) {
        // 取消意图仍有效但上游未确认：保持等待确认的提示，不退化为普通“已受理”。
        notice.value = item.upstreamCancellation === false ? "已请求取消，等待服务器确认；供应商可能无法撤销本次生成" : "已请求取消，等待服务器确认";
      }
    }
    return {
      state: state.value, taskId: taskId.value || item.taskId, cancellationRequested: cancellationRequested.value,
      ...(item.upstreamCancellation === undefined ? {} : { upstreamCancellation: item.upstreamCancellation }),
      observing: observing.value, message: notice.value,
    };
  }

  function stopObserving() {
    stopPolling();
    abortRequests();
    if (binding) notice.value = "已停止观察，任务继续在服务器执行，重新打开或刷新节点可继续查看";
  }

  /** 人工核对后放弃本地关联：不取消服务器任务、不自动重新生成；再次生成会创建新的提交键。 */
  function discard() {
    stopPolling();
    clearBinding();
    state.value = "idle";
    errorText.value = "";
    outputState.value = undefined;
    notice.value = "已清除本地任务标识；如需继续查询服务器任务，请使用任务查询接口按原 batchKey 找回";
  }

  function status() {
    return {
      state: state.value, taskId: taskId.value || undefined, active: active.value, observing: observing.value,
      cancellationRequested: cancellationRequested.value, pendingWriteBack: pendingWriteBack.value,
      ...(outputState.value ? { outputState: outputState.value } : {}),
      ...(resultPath.value ? { outputPath: resultPath.value } : {}),
      // G/T11：透出跟进状态/等待原因/下次重试时间，paused/blocked 的节点不显示成“继续在服务器执行”。
      ...(trackingStatus.value ? { trackingStatus: trackingStatus.value } : {}),
      ...(waitingReason.value ? { waitingReason: waitingReason.value } : {}),
      ...(retryAt.value ? { retryAt: retryAt.value } : {}),
      // H/T13：节点工具在短截止内未等到自身订阅结果时为 true，界面/调用方据此显示“仍在查询”。
      ...(queryPending.value ? { queryPending: true } : {}),
      ...(notice.value ? { message: notice.value } : {}),
      ...(errorText.value ? { error: errorText.value } : {}),
    };
  }

  onScopeDispose(() => {
    // 节点卸载只停止本地观察，不取消服务器任务（任务与网页无关，继续在服务器执行）。
    stopPolling();
    abortRequests();
    resetTracking();
    // T11：卸载时释放本节点在页面级可用性聚合里的订阅（没有订阅就释放计时器）。
    unsubscribeSavedAvailability(savedAvailabilityId);
    savedAvailabilityId = undefined;
  });

  return {
    state, label, active, taskId, errorText, notice, observing, pendingWriteBack, outputState,
    trackingStatus, waitingReason, retryAt, queryPending,
    attach, start, cancel, discard, stopObserving, refreshSavedAvailability,
    refresh: async () => {
      await attach();
      if (!binding) {
        // T11：ACK 之后没有活动绑定时，显式刷新入口仍然有效（只读查询已保存输出的可用性，不触发生成）。
        await refreshSavedAvailability();
        return;
      }
      // 明确恢复查询：重新开始观察（停止观察、回前台、网络恢复、重新登录后都可继续）。
      // 轮询与状态读取复用页面级聚合器已在途的请求，不重复发起同一批查询（W5）；
      // H/T13：只等待本订阅自己的结果或短截止，不阻塞调用方等待整页聚合轮。
      startPolling();
      await poll();
    },
    status,
  };
}
