import { msg } from "@toonflow/i18n";
import { messageError } from "@toonflow/i18n/errors";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, chmod, lstat, mkdir, mkdtemp, realpath, rename, rm } from "@toonflow/file";
import { file } from "@toonflow/file/bun";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { builds, downloadSources } from "./catalog";

export { createFfmpeg } from "./runtime";
export { executeRemoteFfmpeg } from "./remote";
export { acquireFfmpegSlot, queueFfmpegSlot, tryAcquireFfmpegSlot } from "./slot";
export { markFfmpegSlotHeld, waitForRealExit, wrapFfmpegSlotCommand, wrapFfmpegSlotStatic } from "./commandSlot";
export type { BrowserFfmpegRequest, FfmpegRemoteEvent } from "./browserTypes";
export type * from "./types";
export { downloadSources };
export type SourceId = typeof downloadSources[number]["id"];
export type FfmpegMode = "auto" | "download" | "system";
export type DownloadState = {
  phase: "idle" | "downloading" | "verifying" | "installing" | "completed" | "error" | "cancelled";
  file?: string;
  received: number;
  total?: number;
  error?: string;
};

// OHOS Bun 目前报告 linux，宿主显式标识平台，避免下载不能运行的 Linux FFmpeg。
const platform = process.platform === "linux" && process.env.TOONFLOW_PLATFORM === "ohos" ? "ohos" : process.platform;
export const target = `${platform}-${process.arch}`;
export const build = Object.hasOwn(builds, target) ? builds[target as keyof typeof builds] : undefined;
const toolNames = ["ffmpeg", "ffprobe"] as const;

function executableName(name: string) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

async function readVersion(path: string, name: string, signal?: AbortSignal) {
  const child = Bun.spawn([path, "-version"], {
    stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true, timeout: 15000, signal,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "FFREPORT")),
  });
  // ACT: 用 Response 包装读取流，避免在无 Bun 流扩展类型的检查环境（vue-tsc）里报错。
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  signal?.throwIfAborted();
  const version = output.split(/\r?\n/, 1)[0];
  if (code !== 0 || !version?.startsWith(`${name} version `)) throw messageError(msg`${name} 无法运行，请检查平台兼容性或重新下载`);
  return version;
}

type ToolProbe = { path: string | null; origin: "download" | "system" | null; version: string | null; error: unknown };
export type ToolStatus = Record<typeof toolNames[number], { path: string | null; origin: "download" | "system" | null; version: string | null; error: string | null }>;
// ACT: 运行程序版本检查做短期缓存并合并同一时刻的并发查询，状态轮询和每次执行不再反复 spawn；安装完成后由 clearToolStatusCache 立即失效。
const toolStatusTtl = 60 * 1000;
const toolStatusCache = new Map<string, { cachedAt: number; probe: Promise<Record<typeof toolNames[number], ToolProbe>> }>();

async function probeToolStatus(directory: string, mode: FfmpegMode) {
  const entries = await Promise.all(toolNames.map(async (name) => {
    const downloaded = join(directory, executableName(name));
    const hasDownload = mode !== "system" && await file(downloaded).exists();
    const path = hasDownload ? downloaded : mode === "download" ? null : Bun.which(executableName(name));
    const origin = path ? hasDownload ? "download" as const : "system" as const : null;
    if (!path) return [name, { path, origin, version: null, error: "未找到可用程序" }] as const;
    try {
      return [name, { path, origin, version: await readVersion(path, name), error: null }] as const;
    } catch (error) {
      return [name, { path, origin, version: null, error }] as const;
    }
  }));
  return Object.fromEntries(entries) as Record<typeof toolNames[number], ToolProbe>;
}

export async function getToolStatus(directory: string, mode: FfmpegMode, formatError = (error: unknown) => error instanceof Error ? error.message : String(error)): Promise<ToolStatus> {
  const key = `${mode}\0${directory}`;
  const cached = toolStatusCache.get(key);
  let probe = cached && Date.now() - cached.cachedAt < toolStatusTtl ? cached.probe : undefined;
  if (!probe) {
    // ACT: 同一时刻只探测一次，并发查询等待同一结果；探测自身失败不缓存，下一次调用重新检查。
    probe = probeToolStatus(directory, mode).catch(error => {
      toolStatusCache.delete(key);
      throw error;
    });
    toolStatusCache.set(key, { cachedAt: Date.now(), probe });
  }
  const status = await probe;
  // ACT: 缓存原始错误，按调用方当前语言格式化，避免把上一次请求的语言带入本次结果。
  return Object.fromEntries(toolNames.map(name => [name, {
    ...status[name],
    error: status[name].error === null ? null : typeof status[name].error === "string" ? status[name].error : formatError(status[name].error),
  }] as const)) as ToolStatus;
}

/**
 * ACT: 安装完成后清理版本检查缓存，让状态查询与执行立即看到新程序；不需要事件系统，配置改动由缓存键中的 mode 区分。
 */
export function clearToolStatusCache() {
  toolStatusCache.clear();
}

async function checkDirectory(path: string) {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw messageError(msg`安装目录必须是普通文件夹：${path}`);
  return stat !== null;
}

export async function installFfmpeg(directory: string, sourceId: SourceId, signal: AbortSignal, report: (state: DownloadState) => void) {
  const source = downloadSources.find(item => item.id === sourceId);
  if (!source?.available) throw new Error("此下载源暂不可用，请选择其他下载源");
  if (!build) throw messageError(msg`暂不支持自动下载 ${target} 版本`);
  signal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]);
  signal.throwIfAborted();
  const parent = dirname(resolve(directory));
  await checkDirectory(parent);
  await mkdir(parent, { recursive: true });
  const root = await realpath(parent);
  const destination = join(root, basename(directory));
  await checkDirectory(destination);
  const temporary = await mkdtemp(join(root, ".install-"));
  const staged = join(temporary, "bin");
  const previous = join(temporary, "previous");
  let preserveBackup = false;
  try {
    await mkdir(staged);
    for (const name of toolNames) {
      signal.throwIfAborted();
      const asset = build[name];
      report({ phase: "downloading", file: name, received: 0 });
      const response = await fetch(`${source.urlPrefix}${asset.fileName}`, { signal });
      if (!response.ok || !response.body) throw messageError(msg`${name} 下载失败（HTTP ${response.status}）`);
      const total = Number(response.headers.get("content-length")) || undefined;
      let received = 0;
      const hash = createHash("sha256");
      const compressed = join(temporary, asset.fileName);
      await pipeline(Readable.from(response.body), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > 128 * 1024 * 1024) return callback(new Error("下载文件超过允许大小"));
          hash.update(chunk);
          report({ phase: "downloading", file: name, received, total });
          callback(null, chunk);
        },
      }), createWriteStream(compressed, { flags: "wx", signal }), { signal });
      report({ phase: "verifying", file: name, received, total });
      if (hash.digest("hex") !== asset.sha256) throw messageError(msg`${name} 文件校验失败，请换源重试`);
      const binary = join(staged, executableName(name));
      let extracted = 0;
      await pipeline(createReadStream(compressed, { signal }), createGunzip(), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          extracted += chunk.length;
          callback(extracted > 256 * 1024 * 1024 ? new Error("解压文件超过允许大小") : null, chunk);
        },
      }), createWriteStream(binary, { flags: "wx", signal }), { signal });
      if (process.platform !== "win32") await chmod(binary, 0o755);
      await readVersion(binary, name, signal);
    }
    signal.throwIfAborted();
    // ACT: 两个程序验证完毕再整体替换；提交开始后不响应取消，避免留下半套程序。
    report({ phase: "installing", received: 0 });
    const existed = await checkDirectory(destination);
    if (existed) await rename(destination, previous);
    try {
      await rename(staged, destination);
    } catch (error) {
      if (existed) {
        try { await rename(previous, destination); }
        catch {
          preserveBackup = true;
          throw messageError(msg`安装失败且无法恢复旧版本，旧文件保留在 ${previous}`, { cause: error });
        }
      }
      throw error;
    }
  } finally {
    // 仅清理本次 mkdtemp 创建、且仍位于数据目录内的临时目录。
    if (!preserveBackup && dirname(temporary) === root) {
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => {
        console.warn(`FFmpeg 临时目录清理失败：${temporary}`, error);
      });
    }
  }
}
