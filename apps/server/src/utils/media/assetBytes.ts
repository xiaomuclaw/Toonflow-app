import { t } from "@/lib/i18n";

export const maxMediaSize = 100 * 1024 * 1024;
/** 下载连续无数据上限（契约 B）；总尝试上限由调用方的信号控制。 */
export const downloadIdleTimeoutMs = 60000;
const maxDownloadRedirects = 5;
export const mediaExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/opus": "opus", "audio/pcm": "pcm",
};

/** 下载鉴权：只有 HTTPS 且与供应商 API 完整 origin（协议+主机+端口）一致的地址才附带 Authorization。 */
export type AssetDownloadAuthorization = {
  /** 供应商 API 基地址（如 https://do.xmxcode.com）。 */
  apiUrl: string;
  /** 供应商令牌；只用于本次下载请求头，不落盘、不写日志。 */
  token: string;
};

export type AssetDownloadOptions = {
  authorization?: AssetDownloadAuthorization;
  /** 连续无数据上限；缺省 60 秒。 */
  idleTimeoutMs?: number;
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

export function detectMimeType(bytes: Uint8Array, fallback: string): string {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  const text = header.toString("ascii");
  const mimeType = fallback.split(";")[0].trim().toLowerCase();
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(text)) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return "audio/wav";
  if (text.startsWith("fLaC")) return "audio/flac";
  if (text.startsWith("OggS")) return mimeType.startsWith("video/") ? "video/ogg" : mimeType === "audio/opus" ? "audio/opus" : "audio/ogg";
  if (header[0] === 0xff && (header[1]! & 0xf6) === 0xf0) return "audio/aac";
  if (text.startsWith("ID3") || (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0 && (header[1]! & 0x06) !== 0)) return "audio/mpeg";
  if (text.slice(4, 8) === "ftyp") {
    if (/avif|avis/.test(text.slice(8))) return "image/avif";
    if (/^M4[AB] $/.test(text.slice(8, 12)) || mimeType.startsWith("audio/")) return "audio/mp4";
    return text.slice(8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return mimeType.startsWith("audio/") ? "audio/webm" : "video/webm";
  return ({ "image/jpg": "image/jpeg", "audio/mp3": "audio/mpeg", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/x-flac": "audio/flac" } as Record<string, string>)[mimeType] ?? mimeType;
}

/** 仅按文件头识别媒体类型；无法识别返回 null。 */
export function sniffMimeType(bytes: Uint8Array): string | null {
  // ACT: 空 fallback 使 detectMimeType 只走文件头分支，识别失败返回空串。
  return detectMimeType(bytes, "") || null;
}

/** 内容寻址的落盘文件名：同一内容固定落到同一路径，崩溃/重启后按 sha256 认回原文件，不产生失联重复文件。 */
export function contentAddressedMediaName(mediaType: "image" | "video" | "audio", mimeType: string, sha256: string) {
  const extension = mediaExtensions[mimeType.split(";")[0].trim().toLowerCase()];
  if (!extension) throw new Error(`生成结果格式不受支持：${mimeType || "未知"}`);
  return `${mediaType}-${sha256.slice(0, 32)}.${extension}`;
}

/** 解析 Retry-After（秒数或 HTTP 日期）为毫秒；无法解析返回 undefined。 */
function retryAfterMsOf(value: string | null) {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function authorizationHeaders(url: URL, authorization?: AssetDownloadAuthorization): Record<string, string> {  if (!authorization || !authorization.token) return {};
  if (url.protocol !== "https:") return {};
  let origin = "";
  try {
    origin = new URL(authorization.apiUrl).origin;
  } catch {
    // ACT: 供应商地址无法解析时按跨来源处理，不带密钥。
    return {};
  }
  return url.origin === origin ? { Authorization: `Bearer ${authorization.token}` } : {};
}

function redirectTarget(response: Response, current: URL) {
  if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
  const location = response.headers.get("location");
  if (!location) return undefined;
  try {
    return new URL(location, current);
  } catch {
    return undefined;
  }
}

/**
 * 手动跟随重定向：每一跳重新计算鉴权头，跨来源（含协议或端口不同）不带供应商密钥；
 * 无法解析重定向目标时不做二跳，由调用方按非 2xx 处理（不猜测最终地址）。
 */
async function fetchAssetResponse(url: string, authorization: AssetDownloadAuthorization | undefined, signal?: AbortSignal) {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return invalid("生成结果必须使用 HTTP 或 HTTPS 地址");
  }
  for (let hop = 0; ; hop += 1) {
    if (current.protocol !== "https:" && current.protocol !== "http:") invalid("生成结果必须使用 HTTP 或 HTTPS 地址");
    if (current.username || current.password) invalid("生成结果地址不能包含凭据");
    const response = await fetch(current, { signal, redirect: "manual", headers: authorizationHeaders(current, authorization) });
    const target = redirectTarget(response, current);
    if (!target) return response;
    await response.body?.cancel().catch(() => {});
    if (hop >= maxDownloadRedirects) invalid("生成结果重定向次数过多，已停止下载");
    current = target;
  }
}

/** 单次读取；连续无数据超过 idleTimeoutMs 即中止本次尝试（由调用方重试，不算任务失败）。 */
function idleTimeoutError(idleTimeoutMs: number) {
  return Object.assign(new Error(`下载超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到数据`), { name: "MediaDownloadIdleTimeout" });
}

export async function downloadAsset(url: string, signal?: AbortSignal, options: AssetDownloadOptions = {}): Promise<{ bytes: Buffer; mimeType: string }> {
  const response = await fetchAssetResponse(url, options.authorization, signal);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error(t`下载生成结果失败（HTTP ${response.status}）`), {
      status: response.status,
      retryAfterMs: retryAfterMsOf(response.headers.get("retry-after")),
    });
  }
  if (Number(response.headers.get("content-length")) > maxMediaSize) {
    await response.body?.cancel();
    invalid("生成文件不能超过 100 MB");
  }
  const reader = response.body?.getReader();
  if (!reader) invalid("生成结果为空");
  const idleTimeoutMs = options.idleTimeoutMs ?? downloadIdleTimeoutMs;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(idleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxMediaSize) invalid("生成文件不能超过 100 MB");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return { bytes: Buffer.concat(chunks, size), mimeType: response.headers.get("content-type") ?? "" };
}

export async function assetBytes(
  asset: MediaAsset,
  mediaType: "image" | "video" | "audio",
  signal?: AbortSignal,
  options: AssetDownloadOptions = {},
): Promise<{ bytes: Buffer; mimeType: string }> {
  if (!asset || asset.mediaType !== mediaType) invalid("供应商返回的媒体类型不正确");
  let bytes: Buffer;
  let mimeType = asset.mimeType ?? "";
  if (asset.type === "url") {
    const result = await downloadAsset(asset.url, signal, options);
    bytes = result.bytes;
    const responseMimeType = result.mimeType.split(";")[0].trim().toLowerCase();
    mimeType = responseMimeType && responseMimeType !== "application/octet-stream" ? result.mimeType : mimeType;
  } else if (asset.type === "base64") {
    const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(asset.data);
    const content = (data?.[2] ?? asset.data).replace(/\s/g, "");
    if (content.length > Math.ceil(maxMediaSize / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(content) || content.length % 4 === 1) invalid("生成结果的 base64 内容无效或超过 100 MB");
    bytes = Buffer.from(content, "base64");
    mimeType = data?.[1] ?? mimeType;
  } else if (asset.type === "binary" && ArrayBuffer.isView(asset.data) && asset.data.BYTES_PER_ELEMENT === 1) {
    // ACT: 视图复用同一块内存，不复制大文件。
    bytes = Buffer.from(asset.data.buffer, asset.data.byteOffset, asset.data.byteLength);
  } else { return invalid("供应商返回了无效的媒体结果"); }
  if (!bytes.byteLength || bytes.byteLength > maxMediaSize) invalid("生成文件为空或超过 100 MB");
  const sniffed = sniffMimeType(bytes);
  mimeType = detectMimeType(bytes, mimeType);
  // ACT: R30 —— 文件头无法识别时拒绝以图片/视频名义落盘的错误页（HTML/JSON 伪装媒体）。
  if (!sniffed && /^(?:image|video)\//.test(mimeType)) invalid("生成结果不是支持的图片、视频或音频格式");
  if (!mimeType.startsWith(`${mediaType}/`) || !mediaExtensions[mimeType]) invalid("生成结果不是支持的图片、视频或音频格式");
  return { bytes, mimeType };
}
