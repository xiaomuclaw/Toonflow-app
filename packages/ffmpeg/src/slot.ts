// ACT: FFmpeg 执行容量是宿主进程级信号量；同一进程内 HTTP 路由、工具宿主注入、供应商调用与原生 fluent 工厂共享，
// 不得由各 bundle 的模块变量各自限流（F11）。
const maxConcurrentFfmpeg = 2;
let runningFfmpeg = 0;
const waitingFfmpeg = new Set<() => void>();

// ACT: 释放时先递减再按 FIFO 直接放行下一个等待者，容量恒定且不跳队。
function grantNextFfmpegWaiter() {
  if (runningFfmpeg >= maxConcurrentFfmpeg) return;
  const next = waitingFfmpeg.values().next().value as (() => void) | undefined;
  if (!next) return;
  waitingFfmpeg.delete(next);
  runningFfmpeg++;
  next();
}

export function handOffFfmpegSlot() {
  runningFfmpeg--;
  grantNextFfmpegWaiter();
}

/** 同步尝试占用一个执行槽：仅在没有排队者且未达上限时成功（保持 FIFO 公平）。 */
export function tryAcquireFfmpegSlot(): (() => void) | undefined {
  if (runningFfmpeg >= maxConcurrentFfmpeg || waitingFfmpeg.size) return undefined;
  runningFfmpeg++;
  return handOffFfmpegSlot;
}

/** 排队等待一个执行槽；获得后调用 run(release)。等待期间取消则出队且不执行，并回调 onCancel。 */
export function queueFfmpegSlot(signal: AbortSignal, run: (release: () => void) => void, onCancel?: () => void) {
  if (signal.aborted) {
    onCancel?.();
    return;
  }
  const waiter = () => { signal.removeEventListener("abort", cancel); run(handOffFfmpegSlot); };
  const cancel = () => { waitingFfmpeg.delete(waiter); onCancel?.(); };
  waitingFfmpeg.add(waiter);
  signal.addEventListener("abort", cancel, { once: true });
  grantNextFfmpegWaiter();
}

export function acquireFfmpegSlot(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve<(() => void) | undefined>(undefined);
  return new Promise<(() => void) | undefined>(resolve => {
    // ACT: 排队请求随取消立即出队，不启动子进程；运行中的取消仍由 kill 逻辑处理。
    const waiter = () => { signal.removeEventListener("abort", cancel); resolve(handOffFfmpegSlot); };
    const cancel = () => { waitingFfmpeg.delete(waiter); resolve(undefined); };
    waitingFfmpeg.add(waiter);
    signal.addEventListener("abort", cancel, { once: true });
    grantNextFfmpegWaiter();
  });
}
