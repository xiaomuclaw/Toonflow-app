const version = "2.0.2";

const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
] as const;

const baseUrl = "https://new.xmxcode.com";
const maxDownloadSize = 100 * 1024 * 1024;

/** 结构化跟进分类；宿主任务层据此区分可重试、受阻与业务失败，不靠 HTTP 状态码一概决定。 */
type MediaProviderFollowUp = "retry" | "blocked" | "failed" | "pendingReview";

/**
 * 本地准备/校验失败（请求尚未发出，确定未提交）：带结构化分类，
 * 宿主任务层据此记「提交前失败」，不占保守额度、也不进入待核对（契约 v3 §C.5）。
 */
function localFailure(message: string): never {
  throw Object.assign(new Error(message), { name: "MediaLocalFailureError", status: 400, followUp: "failed" });
}

/** 解析 Retry-After（秒数或 HTTP 日期）为毫秒；无法解析返回 undefined。 */
function parseRetryAfterMs(value: string | null) {
  if (!value) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * 结构化 HTTP 错误：宿主按 status / followUp 分类，不靠 HTTP 状态码一概决定生成失败。
 * 401/403 → 凭据受阻；429/5xx/超时 → 可重试；其余明确拒绝 → 业务失败。
 */
function httpError(message: string, response: Response) {
  const status = response.status;
  const followUp: MediaProviderFollowUp = status === 401 || status === 403 ? "blocked"
    : status === 408 || status === 425 || status === 429 || status >= 500 ? "retry"
    : "failed";
  return Object.assign(new Error(`${message}：HTTP ${status}`), {
    name: "MediaProviderHttpError",
    status,
    followUp,
    retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("接口响应格式错误");
  return value as Record<string, unknown>;
}

/** 将宿主抽象的媒体输入转成网关接受的参考图字符串（URL 或 data URL）。 */
function mediaToString(input: MediaInput): string {
  if (input.type === "url") return input.url;
  if (input.type === "base64") return input.data.startsWith("data:") ? input.data : `data:${input.mimeType};base64,${input.data}`;
  return `data:${input.mimeType};base64,${Buffer.from(input.data).toString("base64")}`;
}

function sniffMime(base64: string): string {
  if (base64.startsWith("iVBORw0KGgo")) return "image/png";
  if (base64.startsWith("/9j/")) return "image/jpeg";
  if (base64.startsWith("UklGR")) return "image/webp";
  return "image/png";
}

/** GPT-Image 只支持固定档位；把比例或尺寸映射到最接近的档位。 */
function toSize(request: ImageRequest): string {
  const size = typeof request.size === "string" ? request.size.trim() : "";
  if (/^\d{3,4}x\d{3,4}$/.test(size)) return size;
  if (/^(1|1\.5|2|4)K$/i.test(size)) {
    const ratio = typeof request.ratio === "string" ? request.ratio.trim() : "";
    if (/^9\s*[:/]\s*16|^2\s*[:/]\s*3|^3\s*[:/]\s*4/.test(ratio)) return "1024x1536";
    if (/^16\s*[:/]\s*9|^3\s*[:/]\s*2|^4\s*[:/]\s*3/.test(ratio)) return "1536x1024";
    return "1024x1024";
  }
  const ratio = typeof request.ratio === "string" ? request.ratio.trim() : "";
  if (/^16\s*[:/]\s*9|^3\s*[:/]\s*2|^4\s*[:/]\s*3|^21\s*[:/]\s*9/.test(ratio)) return "1536x1024";
  if (/^9\s*[:/]\s*16|^2\s*[:/]\s*3|^3\s*[:/]\s*4|^9\s*[:/]\s*21/.test(ratio)) return "1024x1536";
  return "1024x1024";
}

function extensionFor(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

/**
 * 下载鉴权：只有 HTTPS 且与网关完整 origin（协议+主机+端口）一致的地址才附带密钥；
 * 同主机但不同协议或端口的地址不带密钥。
 */
function authorizedHeaders(url: URL, apiKey: string): Record<string, string> {
  if (url.protocol !== "https:") return {};
  try {
    return url.origin === new URL(baseUrl).origin ? { Authorization: `Bearer ${apiKey}` } : {};
  } catch {
    // ACT: 网关地址无法解析时按跨来源处理，不带密钥。
    return {};
  }
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
 * 手动跟随重定向：每一跳按新地址重新判断是否附带密钥，跨来源重定向绝不带走 Authorization；
 * 无法解析重定向目标时不做二跳，由调用方按非 2xx 处理（不猜测最终地址）。
 */
async function fetchAuthorized(fetchImpl: typeof fetch, url: string, apiKey: string, signal: AbortSignal) {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error("图片地址无效");
  }
  for (let hop = 0; ; hop += 1) {
    if (current.protocol !== "https:" && current.protocol !== "http:") throw new Error("图片地址必须使用 HTTP 或 HTTPS");
    if (current.username || current.password) throw new Error("图片地址不能包含凭据");
    const response = await fetchImpl(current, { headers: authorizedHeaders(current, apiKey), signal, redirect: "manual" });
    const target = redirectTarget(response, current);
    if (!target) return response;
    await response.body?.cancel().catch(() => {});
    if (hop >= 5) throw new Error("图片下载重定向次数过多");
    current = target;
  }
}

/** 受限流式下载：逐块计数，超过 100 MB 或收到中止立即断流，不把响应全量读入内存。 */
async function readBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("下载内容为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxDownloadSize) throw new Error("下载内容超过 100 MB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, size);
}

/** 参考图字符串（URL 或 data URL）→ multipart 附件字节。 */
async function referenceToFile(reference: string, index: number, apiKey: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<{ filename: string; mimeType: string; bytes: Uint8Array }> {
  const dataUrl = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(reference);
  if (dataUrl) {
    const mimeType = dataUrl[1] || "image/png";
    const raw = dataUrl[3] ?? "";
    const bytes = dataUrl[2] ? Buffer.from(raw, "base64") : Buffer.from(decodeURIComponent(raw), "binary");
    return { filename: `reference-${index + 1}.${extensionFor(mimeType)}`, mimeType, bytes };
  }
  const url = reference.startsWith("/") ? `${baseUrl}${reference}` : reference;
  const response = await fetchAuthorized(fetchImpl, url, apiKey, signal);
  if (!response.ok) throw new Error(`参考图下载失败：HTTP ${response.status}`);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || "image/png";
  return { filename: `reference-${index + 1}.${extensionFor(mimeType)}`, mimeType, bytes: await readBytes(response, signal) };
}

/** 手写 multipart/form-data 请求体（带参考图时必须走 /v1/images/edits）。 */
function buildMultipartBody(fields: Record<string, string>, files: { field: string; filename: string; mimeType: string; bytes: Uint8Array }[]): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `----toonflow-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`));
    chunks.push(file.bytes);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  // ACT: fetch 的 body 类型只接受 buffer 为 ArrayBuffer 的视图，Buffer 的池化 ArrayBufferLike 视图不匹配，按总长拼一次。
  const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export default {
  id: "xmxImage",
  label: "XMX 图片 (GPT-Image)",
  version,
  apiUrl: baseUrl,
  readme: `XMX 图片网关（new.xmxcode.com），OpenAI 图片接口兼容，提供 GPT-Image 系列模型。

支持文生图与参考图（图生图、多参考图）。密钥在安装后于「设置 → 媒体模型」中填写。`,
  rules,
  models: [
    {
      id: "gpt-image-2.5-sunburst",
      label: "GPT Image 2.5 Sunburst",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    },
    {
      id: "gpt-image-2.5",
      label: "gpt-image-2.5",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
    },
  ] satisfies ProviderModel[],
  async generateImage(request: ImageRequest): Promise<MediaAsset[]> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) localFailure("请填写 API Key（本地准备失败，未提交）");
    // ACT: 单次生成最多等待 10 分钟。
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);

    const references = (request.images ?? []).map(mediaToString);
    const size = toSize(request);
    const quality = typeof request.quality === "string" && request.quality ? request.quality : "";
    const count = typeof request.n === "number" && request.n > 1 ? request.n : 1;

    const send = async () => {
      if (references.length === 0) {
        // 纯文字生图：/v1/images/generations（JSON）。
        const body: Record<string, unknown> = {
          model: request.model,
          prompt: request.prompt,
          size,
          response_format: "b64_json",
          ...(quality ? { quality } : {}),
          ...(count > 1 ? { n: count } : {}),
        };
        return this.tool.fetch(`${baseUrl}/v1/images/generations`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      }
      // 带参考图：必须走 /v1/images/edits 的 multipart/form-data（image 字段可重复，最多 16 张）。
      if (references.length > 16) localFailure("参考图最多 16 张（本地准备失败，未提交）");
      const files: { field: string; filename: string; mimeType: string; bytes: Uint8Array }[] = [];
      for (let index = 0; index < references.length; index += 1) {
        // ACT: 参考图在生成请求之前取回，这一段的失败属于「本地准备失败，确定未提交」（不占额度、不转待核对）。
        const file = await referenceToFile(references[index]!, index, apiKey, this.tool.fetch, signal)
          .catch((error: unknown) => localFailure(`参考图读取失败：${error instanceof Error ? error.message : String(error)}（本地准备失败，未提交）`));
        files.push({ field: "image", ...file });
      }
      const { body, contentType } = buildMultipartBody(
        {
          model: request.model,
          prompt: request.prompt,
          size,
          response_format: "b64_json",
          ...(quality ? { quality } : {}),
          ...(count > 1 ? { n: String(count) } : {}),
        },
        files,
      );
      return this.tool.fetch(`${baseUrl}/v1/images/edits`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": contentType },
        body,
        signal,
      });
    };

    const response = await send();
    if (!response.ok) throw httpError("请求失败", response);
    const data = object(await response.json());
    const items = Array.isArray(data.data) ? data.data : [];
    if (!items.length) throw new Error("响应未包含生成图片");

    const assets: MediaAsset[] = [];
    for (const item of items) {
      const entry = object(item);
      const b64 = entry.b64_json;
      if (typeof b64 === "string" && b64) {
        assets.push({ mediaType: "image", type: "base64", data: b64, mimeType: sniffMime(b64) });
        continue;
      }
      if (typeof entry.url === "string" && entry.url) {
        // 网关可能返回相对路径；下载统一走同源鉴权与手动重定向校验。
        const url = entry.url.startsWith("/") ? `${baseUrl}${entry.url}` : entry.url;
        const media = await fetchAuthorized(this.tool.fetch, url, apiKey, signal);
        if (!media.ok) throw new Error(`图片下载失败：HTTP ${media.status}`);
        assets.push({
          mediaType: "image",
          type: "binary",
          data: await readBytes(media, signal),
          mimeType: media.headers.get("content-type")?.split(";")[0] || "image/png",
        });
      }
    }
    if (!assets.length) throw new Error("响应未包含可用图片");
    return assets;
  },
} satisfies ProviderDefinition<typeof rules>;
