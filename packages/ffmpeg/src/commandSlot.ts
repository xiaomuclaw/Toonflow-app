import { queueFfmpegSlot, tryAcquireFfmpegSlot } from "./slot";

/** 宿主入口（executeRemoteFfmpeg）已持有执行槽的命令标记：同一命令不再重复拿槽，避免双重占用/死锁（F11）。 */
const slotHeldSymbol = Symbol.for("toonflow.ffmpeg.slotHeld");

type CommandSlotState = {
  /** 本命令持有的一个执行槽释放函数；命令内的内部 probe→run 组合共享它，避免自我死锁（T18）。 */
  lease?: () => void;
  /** 正在进行的终态调用数（含 concat 内部调用的 ffprobe/run）；归零才释放租约。 */
  pending: number;
};

const slotStates = new WeakMap<object, CommandSlotState>();

// ACT: 会真正启动 ffmpeg/ffprobe 子进程的终态方法；exec/execute 是 run 的别名（同一函数对象，需分别包装）。
// stream/pipe 内部同步调用 this.run()，因此由 run 的包装统一计入容量，无需单独包装。
// 能力查询（availableFilters/Codecs/Encoders/Formats 及其 get* 别名）内部经 _spawnFfmpeg 真实启动 ffmpeg 进程
// （互审 §L：未纳入租约即可绕过 2 槽上限），按回调式终态方法纳入容量；缩略图等配方内部自调 ffprobe→run，共享同一租约。
const terminalMethods = ["run", "exec", "execute", "save", "saveToFile", "takeScreenshots", "thumbnail", "thumbnails", "screenshot", "screenshots", "mergeToFile", "concatenate", "concat", "ffprobe",
  "availableFilters", "getAvailableFilters", "availableCodecs", "getAvailableCodecs", "availableEncoders", "getAvailableEncoders", "availableFormats", "getAvailableFormats"] as const;

export function markFfmpegSlotHeld(command: unknown) {
  if ((command && typeof command === "object") || typeof command === "function") {
    Object.defineProperty(command, slotHeldSymbol, { value: true, configurable: true });
  }
}

function isFfmpegSlotHeld(command: unknown) {
  return Boolean(command && (command as Record<symbol, unknown>)[slotHeldSymbol]);
}

function stateFor(command: object): CommandSlotState {
  let state = slotStates.get(command);
  if (!state) {
    state = { pending: 0 };
    slotStates.set(command, state);
  }
  return state;
}

// ACT: 完成信号（'end'/'error'/回调/Promise）减少在途计数；归零才把命令租约还给宿主容量。
function completeOne(state: CommandSlotState) {
  state.pending = Math.max(0, state.pending - 1);
  if (state.pending === 0 && state.lease) {
    const release = state.lease;
    state.lease = undefined;
    release();
  }
}

function emitError(command: object, error: unknown) {
  const emitter = command as { emit?: (event: string, ...values: unknown[]) => unknown };
  if (typeof emitter.emit === "function") emitter.emit("error", error);
}

/**
 * T18/第四轮：fluent 在输入流错误、超时、输出流错误等分支会先 `emitEnd(error)` 再 `kill()`（processor.js 450-499），
 * 命令的 'error' 事件因此早于子进程真实退出。名额释放/宣告输出可清理必须等真实退出：
 * 有子进程（ffmpegProc 仍存在且未退出）时等 'exit'/'close'，无子进程（准备阶段错误）时立即完成。
 *
 * T18/第五轮（契约验收 §3-T18）：**等待上限只能标记「退出未确认」，不能走与已确认退出相同的完成路径**。
 * 超过 maxWaitMs 未见到 exit/close 时：先尝试 SIGKILL，再等 killGraceMs 观察真实退出；
 * 仍无确认则**保持占用执行名额、保护输出、不向调用方投递终止事件**（避免调用方据“结束”删除输出目录），
 * 并打出可诊断错误日志交由人工巡检；不再“告警后照常释放”。
 */
export function waitForRealExit(command: object, finish: () => void, options?: { maxWaitMs?: number; killGraceMs?: number }) {
  const maxWaitMs = options?.maxWaitMs ?? 15000;
  const killGraceMs = options?.killGraceMs ?? 5000;
  const proc = (command as {
    ffmpegProc?: { once?: (event: string, listener: () => void) => unknown; exitCode?: number | null; signalCode?: string | null };
  }).ffmpegProc;
  if (!proc || typeof proc.once !== "function") { finish(); return; }
  if ((proc.exitCode !== null && proc.exitCode !== undefined) || proc.signalCode) { finish(); return; }
  let done = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
  const complete = () => {
    if (done) return;
    done = true;
    if (killTimer) clearTimeout(killTimer);
    if (giveUpTimer) clearTimeout(giveUpTimer);
    finish();
  };
  killTimer = setTimeout(() => {
    if (done) return;
    console.error(`[FFmpeg] 子进程错误后 ${maxWaitMs}ms 未见退出事件：已发送 SIGKILL，等待真实退出确认（未确认前不释放执行名额、不宣告输出可清理）`);
    try { (command as { kill?: (signal?: string) => unknown }).kill?.("SIGKILL"); } catch { /* 命令可能已无进程，忽略。 */ }
    giveUpTimer = setTimeout(() => {
      if (done) return;
      // 不调用 complete()：名额保持占用、调用方保持等待、输出不被宣告可清理；由人工巡检该进程。
      console.error("[FFmpeg] SIGKILL 后仍未确认退出：保持占用执行名额并保护输出（不投递终止事件），请人工检查残留 ffmpeg 进程");
    }, killGraceMs);
    (giveUpTimer as unknown as { unref?: () => void }).unref?.();
  }, maxWaitMs);
  (killTimer as unknown as { unref?: () => void }).unref?.();
  proc.once("exit", complete);
  proc.once("close", complete);
}

/**
 * 把 fluent 命令的终态方法纳入宿主进程级执行容量：
 * - 命令第一次启动子进程前取得一个租约（容量满则 FIFO 排队）；同命令内部的 probe→run/自定义组合共享该租约，
 *   不会重复拿槽，也不会与 FIFO 相互等待造成死锁（T18）。
 * - 完成以子进程真实结束信号为准：'end'/'error'、ffprobe 回调或返回 Promise 的 settle。
 * - 宿主入口（executeRemoteFfmpeg）已持槽时不再取租约，由外层统一释放。
 */
export function wrapFfmpegSlotCommand<T extends object>(command: T, signal: AbortSignal): T {
  if (isFfmpegSlotHeld(command)) return command;
  const state = stateFor(command);
  const invokeTerminal = (original: (...values: unknown[]) => unknown, args: unknown[]) => {
    // ACT: 末尾回调（如 ffprobe(callback)、截图回调）包一层可靠完成通知，仍原样转发参数与返回值。
    const forwarded = args.map((value, index) => index === args.length - 1 && typeof value === "function"
      ? (...callbackArgs: unknown[]) => {
        completeOne(state);
        return (value as (...values: unknown[]) => unknown)(...callbackArgs);
      }
      : value);
    let done = false;
    const finish = () => { if (!done) { done = true; completeOne(state); } };
    let result: unknown;
    try {
      result = original.apply(command, forwarded);
    } catch (error) {
      finish();
      throw error;
    }
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      (result as PromiseLike<unknown>).then(finish, finish);
      return result;
    }
    const emitter = command as { once?: (event: string, listener: () => void) => unknown };
    if (typeof emitter.once === "function") {
      emitter.once("end", finish);
      // T18：准备阶段的错误没有子进程，正常完成；运行阶段的业务 error 必须等真实退出再释放（不得提前放行下一作业）。
      emitter.once("error", () => waitForRealExit(command, finish));
    } else {
      finish();
    }
    return result;
  };
  for (const name of terminalMethods) {
    const original = (command as unknown as Record<string, unknown>)[name];
    if (typeof original !== "function") continue;
    Object.defineProperty(command, name, {
      configurable: true,
      writable: true,
      value: function (...args: unknown[]) {
        state.pending += 1;
        // 1) 宿主入口已持槽，或本命令已有租约（concat 内部 probe/run）：直接执行，不重复拿槽。
        if (isFfmpegSlotHeld(command) || state.lease) return invokeTerminal(original as (...values: unknown[]) => unknown, args);
        // 2) 同步取得租约：保持原有同步行为（含同步抛错）。
        const acquired = tryAcquireFfmpegSlot();
        if (acquired) {
          state.lease = acquired;
          return invokeTerminal(original as (...values: unknown[]) => unknown, args);
        }
        // 3) 容量已满：FIFO 排队，取得租约后再启动；排队期间取消则不启动，但必须让命令收到取消错误。
        queueFfmpegSlot(signal, granted => {
          state.lease = granted;
          try {
            invokeTerminal(original as (...values: unknown[]) => unknown, args);
          } catch (error) {
            emitError(command, error);
          }
        }, () => {
          completeOne(state);
          const reason = (signal as AbortSignal & { reason?: unknown }).reason ?? new DOMException("FFmpeg 已取消", "AbortError");
          emitError(command, reason);
        });
        return command;   // 与 fluent 终态方法一致的链式/事件返回值
      },
    });
  }
  // clone 产生的新实例必须同样受容量约束（T18）。
  const cloneOriginal = (command as unknown as Record<string, unknown>)["clone"];
  if (typeof cloneOriginal === "function") {
    Object.defineProperty(command, "clone", {
      configurable: true,
      writable: true,
      value: function (...args: unknown[]) {
        return wrapFfmpegSlotCommand((cloneOriginal as (...values: unknown[]) => object).apply(command, args), signal);
      },
    });
  }
  return command;
}

/**
 * 静态 ffprobe（`ffmpeg.ffprobe(file, callback)` 内部自建实例）的容量包装：
 * 同步可取得租约时保持原行为；容量已满时排队执行，用包装后的末尾回调在真实结束时释放。
 * 排队分支无法同步返回内部实例，返回 undefined（静态调用只按回调取结果）。
 */
export function wrapFfmpegSlotStatic<T extends (...args: unknown[]) => unknown>(fn: T, signal: AbortSignal): T {
  return function (this: unknown, ...args: unknown[]) {
    const hasCallback = typeof args[args.length - 1] === "function";
    const invoke = (release: () => void) => {
      let released = false;
      const done = () => { if (!released) { released = true; release(); } };
      const forwarded = hasCallback
        ? args.map((value, index) => index === args.length - 1
          ? (...callbackArgs: unknown[]) => { done(); return (value as (...values: unknown[]) => unknown)(...callbackArgs); }
          : value)
        : args;
      try {
        const result = (fn as (...values: unknown[]) => unknown).apply(this, forwarded);
        if (!hasCallback) {
          if (result && typeof (result as PromiseLike<unknown>).then === "function") (result as PromiseLike<unknown>).then(done, done);
          else done();
        }
        return result;
      } catch (error) {
        done();
        throw error;
      }
    };
    const acquired = tryAcquireFfmpegSlot();
    if (acquired) return invoke(acquired);
    queueFfmpegSlot(signal, granted => {
      try { invoke(granted); }
      catch (error) {
        granted();
        console.warn("FFmpeg 静态调用失败", error);
      }
    }, () => {
      // T18/第四轮：排队期间取消——原函数从未执行，不会再有回调或 promise，调用方必须在这里得到**恰好一次**收敛来源。
      if (!hasCallback) return;
      const callback = args[args.length - 1] as (...values: unknown[]) => unknown;
      const reason = (signal as AbortSignal & { reason?: unknown }).reason ?? new DOMException("FFmpeg 已取消", "AbortError");
      try { callback(reason); }
      catch (error) { console.warn("FFmpeg 静态排队取消回调失败", error); }
    });
    return undefined;
  } as unknown as T;
}
