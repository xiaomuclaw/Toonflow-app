import { t, translateError, translateMessage } from "@/lib/i18n";
import { dirname, join } from "node:path";
import { build, clearToolStatusCache, createFfmpeg, downloadSources, executeRemoteFfmpeg, getToolStatus, installFfmpeg, target, wrapFfmpegSlotCommand, wrapFfmpegSlotStatic } from "@toonflow/ffmpeg";
import type { BrowserFfmpegRequest, DownloadState, FfmpegFactory, FfmpegMode, FfmpegRemoteEvent, SourceId } from "@toonflow/ffmpeg";
import conf from "@/utils/conf";

const directory = join(dirname(conf.path), "ffmpeg", target);
let download: DownloadState = { phase: "idle", received: 0 };
let downloadError: unknown;
// ACT: 沿用 server 单进程模型，每次只下载一套程序；不持久化运行中的任务。
let controller: AbortController | undefined;
const requiredListeners = new Set<() => void>();

export function onRequired(listener: () => void) {
  requiredListeners.add(listener);
  return () => { requiredListeners.delete(listener); };
}

// ACT: 执行容量与排队统一在 @toonflow/ffmpeg/remote 的进程级信号量处理（R23），避免 HTTP 路由与工具插件两套上限。
export async function executeWorkspaceFfmpeg(
  factory: FfmpegFactory, request: BrowserFfmpegRequest, emit: (event: FfmpegRemoteEvent) => void, signal: AbortSignal,
) {
  await executeRemoteFfmpeg(factory, request, emit, signal);
}

export async function createWorkspaceFfmpeg(cwd: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { tools } = await getStatus();
  signal?.throwIfAborted();
  if (!tools.ffmpeg.path || tools.ffmpeg.error || !tools.ffprobe.path || tools.ffprobe.error) {
    for (const listener of requiredListeners) listener();
    throw Object.assign(new Error("当前操作需要 FFmpeg，请在插件市场下载安装或配置可用版本后重试。"), {
      name: "FfmpegRequiredError", code: "FFMPEG_REQUIRED", status: 424,
    });
  }
  const ffmpeg = createFfmpeg(cwd);
  ffmpeg.setFfmpegPath(tools.ffmpeg.path);
  ffmpeg.setFfprobePath(tools.ffprobe.path);
  // F11/T18：原生 fluent 工厂（供应商 tool.ffmpeg、Agent 工具等）的每次真实执行都经过宿主进程级容量；
  // 链式配置方法不占容量；命令实例共享一个"进程租约"（concat 内部 probe→run 不重复拿槽、不死锁）；
  // clone 返回的实例同样受约束；静态 ffprobe（内部自建实例）经 wrapFfmpegSlotStatic 计入容量；
  // stream/pipe 内部同步调用 this.run()，由 run 的包装统一计入。
  const slotSignal = signal ?? new AbortController().signal;
  // 互审 §L：能力查询静态形式（FfmpegCommand.available*）同样会启动真实 ffmpeg 进程，必须计入宿主进程级容量。
  const staticSlotMethods = new Set(["ffprobe",
    "availableFilters", "getAvailableFilters", "availableCodecs", "getAvailableCodecs",
    "availableEncoders", "getAvailableEncoders", "availableFormats", "getAvailableFormats"]);
  return new Proxy(ffmpeg, {
    apply: (target, thisArgument, argumentsList: Parameters<FfmpegFactory>) =>
      wrapFfmpegSlotCommand(Reflect.apply(target, thisArgument, argumentsList), slotSignal),
    get: (target, property, receiver) => {
      const value = Reflect.get(target, property, receiver);
      if (typeof property === "string" && staticSlotMethods.has(property) && typeof value === "function") {
        return wrapFfmpegSlotStatic(value as (...values: unknown[]) => unknown, slotSignal);
      }
      return value;
    },
  }) as FfmpegFactory;
}

export function getProgress() {
  return download.error ? { ...download, error: translateError(downloadError ?? download.error) } : download;
}

export async function getStatus() {
  const raw = conf.get("settings", {}).ffmpeg;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const mode: FfmpegMode = value.mode === "download" || value.mode === "system" ? value.mode : "auto";
  const source = downloadSources.find(item => item.id === value.source)?.id ?? "npmmirror";
  const tools = await getToolStatus(directory, mode, translateError);
  return {
    platform: process.platform,
    arch: process.arch,
    target,
    supported: Boolean(build),
    directory,
    version: build?.version ?? "",
    sources: downloadSources.map(({ id, label, description, available, homepage }) => ({ id, label: translateMessage(label), description: translateMessage(description), available, homepage })),
    config: { mode, source },
    tools: { ffmpeg: { ...tools.ffmpeg, error: tools.ffmpeg.error ? translateMessage(tools.ffmpeg.error) : null },
      ffprobe: { ...tools.ffprobe, error: tools.ffprobe.error ? translateMessage(tools.ffprobe.error) : null } },
    download: getProgress(),
  };
}

export function startDownload(source: SourceId) {
  if (controller) throw Object.assign(new Error("正在下载，请等待完成或取消后再试"), { status: 409 });
  if (!downloadSources.some(item => item.id === source && item.available)) throw Object.assign(new Error("此下载源暂不可用，请选择其他下载源"), { status: 400 });
  if (!build) throw Object.assign(new Error(t`暂不支持自动下载 ${target} 版本`), { status: 400 });
  const active = new AbortController();
  controller = active;
  download = { phase: "downloading", received: 0 };
  downloadError = undefined;
  void installFfmpeg(directory, source, active.signal, state => { download = state; }).then(() => {
    download = { phase: "completed", received: 0 };
    // ACT: 安装完成后立即失效版本检查缓存，状态查询与后续执行马上看到新程序，不必等缓存过期。
    clearToolStatusCache();
  }).catch((error: unknown) => {
    downloadError = error;
    download = active.signal.aborted
      ? { phase: "cancelled", received: 0 }
      : { phase: "error", received: 0, error: error instanceof Error ? error.message : String(error) };
  }).finally(() => { controller = undefined; });
  return getProgress();
}

export function cancelDownload() {
  if (download.phase !== "installing") controller?.abort();
  return getProgress();
}
