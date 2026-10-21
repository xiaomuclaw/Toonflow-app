import { createHash } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { lstat, mkdir, readFile, stat, writeAtomic } from "@toonflow/file";
// ACT: 引入供应商包以获得 MediaInput 等全局声明；只做类型使用。
import type { Provider } from "@toonflow/providers";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { maxMediaSize, mediaExtensions } from "@/utils/media/assetBytes";
import { mediaTasksInputsDirectory } from "./store";
import type { MediaTaskInputSnapshot, MediaTaskMediaType, MediaTaskReferenceField } from "./store";

type Reference = { path: string; mimeType: string };

const referenceFields: { field: MediaTaskReferenceField; multiple: boolean }[] = [
  { field: "images", multiple: true },
  { field: "videos", multiple: true },
  { field: "audios", multiple: true },
  { field: "firstFrame", multiple: false },
  { field: "lastFrame", multiple: false },
];

function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function referenceCategory(field: MediaTaskReferenceField): "image" | "video" | "audio" {
  return field === "videos" ? "video" : field === "audios" ? "audio" : "image";
}

function readReference(value: unknown): Reference {
  const reference = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  if (!reference || typeof reference.path !== "string" || !reference.path.trim() || typeof reference.mimeType !== "string" || !reference.mimeType.trim()) {
    invalid("参考素材必须包含 path 与 mimeType");
  }
  return { path: reference.path, mimeType: reference.mimeType };
}

export function requestReferences(request: Record<string, unknown>) {
  const references: { field: MediaTaskReferenceField; index: number; reference: Reference }[] = [];
  for (const { field, multiple } of referenceFields) {
    const value = request[field];
    if (value === undefined || value === null) continue;
    if (!multiple) {
      references.push({ field, index: -1, reference: readReference(value) });
      continue;
    }
    if (!Array.isArray(value)) invalid(`参考素材 ${field} 必须是数组`);
    value.forEach((item, index) => references.push({ field, index, reference: readReference(item) }));
  }
  return references;
}

function snapshotExtension(mimeType: string, path: string) {
  const known = mediaExtensions[mimeType.split(";")[0].trim().toLowerCase()];
  if (typeof known === "string" && known) return known;
  const original = extname(path).replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(original) ? original : "bin";
}

/**
 * 提交受理阶段固定输入快照：内容寻址去重（sha256 前 2 位目录），
 * 排队/执行期间原始文件被修改或删除都不影响任务输入。
 */
export async function createInputSnapshots(
  directory: string,
  mediaType: MediaTaskMediaType,
  request: Record<string, unknown>,
  budgetMb: number,
  signal?: AbortSignal,
): Promise<MediaTaskInputSnapshot[]> {
  signal?.throwIfAborted();
  const references = requestReferences(request);
  const budget = Math.max(1, budgetMb) * 1024 * 1024;
  const snapshots: MediaTaskInputSnapshot[] = [];
  let total = 0;
  for (const { field, index, reference } of references) {
    signal?.throwIfAborted();
    const category = referenceCategory(field);
    if (!reference.mimeType.toLowerCase().startsWith(`${category}/`)) invalid(`参考素材类型必须为 ${category}`);
    const resolved = await resolveWorkspacePath(directory, reference.path);
    const info = await stat(resolved.path);
    if (!info.isFile()) invalid("参考素材必须是工作区内的普通文件");
    if (info.size <= 0 || info.size > maxMediaSize) invalid("参考素材为空或超过 100 MB");
    total += info.size;
    if (total > budget) invalid(`单个请求的参考素材总大小不能超过 ${budgetMb} MB`);
    const bytes = await readFile(resolved.path, { signal });
    if (!bytes.length || bytes.length > maxMediaSize) invalid("参考素材为空或超过 100 MB");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const snapshot = join(mediaTasksInputsDirectory(), sha256.slice(0, 2), `${sha256}.${snapshotExtension(reference.mimeType, reference.path)}`);
    await mkdir(dirname(snapshot), { recursive: true });
    const existing = await lstat(snapshot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) {
      await writeAtomic(snapshot, bytes, { exclusive: true, durable: true }).catch((error: NodeJS.ErrnoException) => {
        // ACT: 内容寻址并发去重；已存在说明同一内容已被保存。
        if (error.code !== "EEXIST") throw error;
      });
    }
    snapshots.push({
      field, index, path: reference.path.replaceAll("\\", "/"), mimeType: reference.mimeType,
      sha256, bytes: bytes.byteLength, snapshot,
    });
  }
  return snapshots;
}

/** 恢复时确认快照文件仍完整（长度核对；内容摘要在真正读取时核对）。 */
export async function inputSnapshotsReady(snapshots: MediaTaskInputSnapshot[]): Promise<boolean> {
  for (const snapshot of snapshots) {
    const info = await lstat(snapshot.snapshot).catch(() => null);
    if (!info?.isFile() || info.size !== snapshot.bytes) return false;
  }
  return true;
}

/**
 * 本地准备失败（确定未发上游）：带结构化分类，任务层据此记「提交前失败」，
 * 不占保守在途额度、也不转成待核对（契约 v3 §C.5）。
 */
function localFailure(message: string): never {
  throw Object.assign(new Error(message), { status: 400, name: "MediaLocalFailureError", followUp: "failed" });
}

export type MediaTaskReferenceInputs = {
  images?: MediaInput[];
  videos?: MediaInput[];
  audios?: MediaInput[];
  firstFrame?: MediaInput;
  lastFrame?: MediaInput;
};

/**
 * 执行只用受理时持久快照的字节；顺序与提交时一致。
 * T09/契约 v4 §F：读取入口同时核对长度与 SHA256（同长度错误内容不得进入 provider）；
 * 任何不一致都是「确定未提交」的本地准备失败，记提交前失败、不占保守额度、不写 unknown。
 */
export async function buildSnapshotInputs(snapshots: MediaTaskInputSnapshot[], signal?: AbortSignal): Promise<MediaTaskReferenceInputs> {
  const inputs: MediaTaskReferenceInputs = {};
  for (const snapshot of snapshots) {
    signal?.throwIfAborted();
    const info = await stat(snapshot.snapshot).catch(() => null);
    if (!info?.isFile() || info.size !== snapshot.bytes) {
      localFailure("任务输入快照缺失或长度不符，无法提交上游（本地准备失败，未提交）");
    }
    const bytes = await readFile(snapshot.snapshot, { signal }).catch(() => localFailure("任务输入快照读取失败，无法提交上游（本地准备失败，未提交）"));
    if (!bytes.length || bytes.byteLength !== snapshot.bytes) {
      localFailure("任务输入快照为空或长度不符，无法提交上游（本地准备失败，未提交）");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256) {
      localFailure("任务输入快照内容摘要不一致，无法提交上游（本地准备失败，未提交）");
    }
    const input: MediaInput = { type: "base64", data: bytes.toString("base64"), mimeType: snapshot.mimeType };
    if (snapshot.field === "firstFrame" || snapshot.field === "lastFrame") inputs[snapshot.field] = input;
    else (inputs[snapshot.field] ??= []).push(input);
  }
  return inputs;
}
