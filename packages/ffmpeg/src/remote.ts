import { msg } from "@toonflow/i18n";
import { messageError } from "@toonflow/i18n/errors";
import { chainMethods, queryMethods, runMethods } from "./browserTypes";
import type { BrowserFfmpegRequest, FfmpegCall, FfmpegRemoteEvent } from "./browserTypes";
import { acquireFfmpegSlot } from "./slot";
import { markFfmpegSlotHeld, waitForRealExit } from "./commandSlot";
import type { FfmpegCommand, FfmpegFactory } from "./types";

export { chainMethods, queryMethods, runMethods } from "./browserTypes";

const chainNames = new Set<string>(chainMethods);
const queryNames = new Set<string>(queryMethods);
const runNames = new Set<string>(runMethods);
const inputNames = new Set(["input", "addInput", "mergeAdd"]);
const outputNames = new Set(["output", "addOutput", "save", "saveToFile", "concat", "concatenate", "mergeToFile"]);

function serializeError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, ...("code" in error ? { code: error.code } : {}), ...("i18nMessage" in error ? { i18nMessage: error.i18nMessage } : {}) }
    : { name: "Error", message: String(error) };
}

function invoke(command: FfmpegCommand, call: FfmpegCall, extra: unknown[] = []) {
  if ((inputNames.has(call.method) || outputNames.has(call.method)) && typeof call.args[0] !== "string") {
    throw new Error("浏览器 FFmpeg 输入、输出必须使用工作区文件路径");
  }
  const args = call.args.map((value, index) => call.undefinedArgs?.includes(index) ? undefined : value);
  return Reflect.apply((command as unknown as Record<string, (...args: unknown[]) => unknown>)[call.method]!, command, [...args, ...extra]);
}

/** 浏览器只传链式调用数据，执行及显式路径检查仍使用原生工作区工厂。容量由 ./slot 的进程级信号量统一约束。 */
export async function executeRemoteFfmpeg(
  factory: FfmpegFactory,
  request: BrowserFfmpegRequest,
  emit: (event: FfmpegRemoteEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const release = await acquireFfmpegSlot(signal);
  try {
    signal.throwIfAborted();
    for (const call of request.calls) {
      if (!chainNames.has(call.method)) throw messageError(msg`FFmpeg 配置方法不可用：${call.method}`);
    }
    const operation = request.operation;
    if (!queryNames.has(operation.method) && !runNames.has(operation.method)) {
      throw messageError(msg`FFmpeg 执行方法不可用：${operation.method}`);
    }
    let command = factory(request.options);
    // F11：本入口已持有执行槽；标记命令避免包装后的终态方法重复拿槽（双重占用会减少容量并可能死锁）。
    markFfmpegSlotHeld(command);
    for (const call of request.calls) command = invoke(command, call) as FfmpegCommand;
    await new Promise<void>(resolve => {
      let finished = false;
      const send = (event: string, args: unknown[]) => { if (!finished) emit({ event, args }); };
      const finish = (event: string, args: unknown[]) => {
        if (finished) return;
        if (signal.aborted) {
          event = "error";
          args = [serializeError(signal.reason ?? new DOMException("FFmpeg 已取消", "AbortError"))];
        }
        send(event, args);
        finished = true;
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      const fail = (error: unknown, ...args: unknown[]) => finish("error", [serializeError(error), ...args]);
      const cancel = () => {
        // ACT: kill 只发送信号；等原生完成事件再返回，调用方才能安全清理输出文件。
        if (!queryNames.has(operation.method)) command.kill("SIGKILL");
      };
      signal.addEventListener("abort", cancel, { once: true });
      // ACT: 取消可能早于 spawn；保留监听，准备阶段结束后立即终止，且接住迟到的 error。
      command.on("start", (...args) => {
        if (signal.aborted) command.kill("SIGKILL");
        else send("start", args);
      });
      command.on("error", (...args: unknown[]) => {
        // T18/第四轮：fluent 在输入流错误、超时、输出流错误分支先 emitEnd(error) 再 kill（processor.js 450-499），
        // 命令 error 早于子进程真实退出；外层名额必须等真实退出后再释放，否则会提前放行下一作业、
        // 也会让调用方以为输出可安全清理。准备阶段（无子进程）的错误立即完成。
        const [error, ...rest] = args;
        waitForRealExit(command, () => fail(error, ...rest));
      });
      command.on("end", (...args) => finish("end", args));
      for (const event of ["progress", "stderr", "codecData", "filenames"] as const) {
        command.addListener(event, (...args: unknown[]) => send(event, args));
      }
      try {
        signal.throwIfAborted();
        if (queryNames.has(operation.method)) {
          // ACT: fluent 未公开查询子进程；取消后等查询回调释放文件，不等待查询不会触发的 start。
          invoke(command, operation, [(error: unknown, data: unknown) => error ? fail(error) : finish("result", [data])]);
        } else {
          invoke(command, operation);
        }
      } catch (error) {
        fail(error);
      }
    });
  } catch (error) {
    emit({ event: "error", args: [serializeError(error)] });
  } finally {
    release?.();
  }
}
