const version = "2.0.1";

const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
] as const;

const baseUrl = "https://do.xmxcode.com";
/** 参考图上限（含首尾帧）。 */
const maxReferences = 9;
/** 各模型原生支持的时长档位（秒）。 */
const durationTiers: Record<string, number[]> = {
  "seedance-v2.5": [10, 30],
  "seedance-v2.0": [5, 10, 15],
};
const supportedRatios = ["9:16", "16:9", "1:1"];
const supportedResolutions = ["720p"];

/** 结构化跟进分类；宿主任务层据此区分可重试、受阻与业务失败，不靠 HTTP 状态码一概决定。 */
type MediaProviderFollowUp = "retry" | "blocked" | "failed" | "pendingReview";

/**
 * 本地准备/校验失败（请求尚未发出，确定未提交）：带结构化分类，
 * 宿主任务层据此记「提交前失败」，不占保守额度、也不进入待核对（契约 v3 §C.5）。
 */
function localFailure(message: string): never {
  throw Object.assign(new Error(message), { name: "MediaLocalFailureError", status: 400, followUp: "failed" });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("接口响应格式错误");
  return value as Record<string, unknown>;
}

/** 读取配置的 API Key；异步任务方法的 this.config 是通用配置，值类型未按 rules 收窄。 */
function apiKeyOf(config: { apiKey?: unknown }): string {
  return typeof config.apiKey === "string" ? config.apiKey.trim() : "";
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
 * 结构化 HTTP 错误：宿主按 status / followUp / retryAfterMs 分类，
 * 400 等明确拒绝记为业务失败，401/403 视为凭据受阻，5xx/429/超时可重试，查询 404 记为待核对。
 */
function httpError(message: string, response: Response, phase: "submit" | "query") {
  const status = response.status;
  const followUp: MediaProviderFollowUp = status === 401 || status === 403 ? "blocked"
    : status === 408 || status === 425 || status === 429 || status >= 500 ? "retry"
    : phase === "query" ? "pendingReview" : "failed";
  return Object.assign(new Error(`${message}：HTTP ${status}`), {
    name: "MediaProviderHttpError",
    status,
    followUp,
    retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
  });
}

/** 将宿主抽象的媒体输入转成网关接受的参考图字符串（URL 或 data URL）。 */
function mediaToString(input: MediaInput): string {
  if (input.type === "url") return input.url;
  if (input.type === "base64") return input.data.startsWith("data:") ? input.data : `data:${input.mimeType};base64,${input.data}`;
  return `data:${input.mimeType};base64,${Buffer.from(input.data).toString("base64")}`;
}

/** 结果地址相对网关时补全为绝对地址；宿主下载前会再校验 origin 才附鉴权。 */
function absoluteUrl(url: string) {
  return url.startsWith("/") ? `${baseUrl}${url}` : url;
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * 提交体：首尾帧在前、其余参考图随后；单图用 image，多图用 images。
 * 超能力参数直接拒绝并说明可选档位，不静默修改用户请求（时长缺省才用模型首档）。
 * 本适配不消费的输入（参考视频、参考音频）与无法履行的 mode 语义一律明确拒绝，不静默忽略（契约 v3 §C.4）。
 */
function buildBody(request: VideoRequest): Record<string, unknown> {
  const tiers = durationTiers[request.model];
  if (!tiers) localFailure(`该模型不支持异步视频任务：${request.model || "未指定模型"}`);
  if (request.videos?.length) localFailure("该模型不支持参考视频，请移除参考视频后重新提交（不会被静默忽略）");
  if (request.audios?.length) localFailure("该模型不支持参考音频，请移除参考音频后重新提交（不会被静默忽略）");
  const references: string[] = [];
  if (request.firstFrame) references.push(mediaToString(request.firstFrame));
  if (request.lastFrame) references.push(mediaToString(request.lastFrame));
  for (const image of request.images ?? []) references.push(mediaToString(image));
  if (references.length > maxReferences) localFailure(`参考图最多 ${maxReferences} 张（含首尾帧），当前 ${references.length} 张`);
  // 生成模式一致性：本适配按参考图推断图文模式，不消费 mode 字段，
  // 因此只接受与参考素材一致的声明；与参考素材冲突或声明了不支持的类别时直接拒绝。
  const mode = request.mode;
  if (Array.isArray(mode)) {
    for (const entry of mode) {
      const matched = /^(image|video|audio)Reference:(\d+)$/.exec(String(entry));
      if (!matched) localFailure(`该模型不支持生成模式 ${String(entry)}，请调整后再提交`);
      if (matched![1] !== "image") localFailure("该模型不支持参考视频/参考音频模式，请调整后再提交（不会被静默忽略）");
      const declared = Number(matched![2]);
      if (declared > maxReferences) localFailure(`该模型最多支持 ${maxReferences} 张参考图，模式声明的 ${declared} 超出范围`);
      if (references.length > declared) localFailure(`生成模式声明最多 ${declared} 张参考图，当前提交 ${references.length} 张`);
    }
  } else if (typeof mode === "string" && mode) {
    if (mode === "text" && references.length) localFailure("已声明文生视频模式，但提交了参考素材，请调整后再提交");
    if (mode === "singleImage" && references.length !== 1) localFailure(`单图模式需要 1 张参考图，当前提交 ${references.length} 张`);
    if (mode === "startEndRequired" && !(request.firstFrame && request.lastFrame)) localFailure("首尾帧模式需要同时提供首帧与尾帧");
    if ((mode === "startFrameOptional" || mode === "endFrameOptional") && (references.length < 1 || references.length > 2)) {
      localFailure(`${mode} 模式需要 1–2 张参考图（首帧与可选尾帧）`);
    }
  }
  const duration = request.duration ?? tiers[0]!;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) localFailure("时长必须是正数秒");
  if (!tiers.includes(duration)) localFailure(`该模型仅支持 ${tiers.join(" / ")} 秒时长，请调整后再提交`);
  if (request.ratio !== undefined && request.ratio !== "" && !supportedRatios.includes(request.ratio)) {
    localFailure(`该模型仅支持 ${supportedRatios.join(" / ")} 画面比例，请调整后再提交`);
  }
  if (request.resolution !== undefined && request.resolution !== "" && !supportedResolutions.includes(request.resolution)) {
    localFailure(`该模型仅支持 ${supportedResolutions.join(" / ")} 分辨率，请调整后再提交`);
  }
  const body: Record<string, unknown> = { model: request.model, prompt: request.prompt, duration, ratio: request.ratio || "9:16" };
  if (references.length === 1) body.image = references[0];
  else if (references.length > 1) body.images = references;
  return body;
}

export default {
  id: "dolaVideo",
  label: "Dola 视频 (Seedance)",
  version,
  apiUrl: baseUrl,
  readme: `Dola2API 视频网关（do.xmxcode.com），提供 Seedance 系列视频生成。

- seedance-v2.5：时长 10 / 30 秒
- seedance-v2.0：时长 5 / 10 / 15 秒
- 支持文生视频与参考图（图生视频，最多 9 张参考图，含首尾帧）；比例 9:16 / 16:9 / 1:1；时长与比例超出上述档位会被拒绝，不会静默改成近似档
- 输出统一为 720p；视频生成通常需要 5~25 分钟，也可能更久
- 异步任务：提交只取得上游任务 ID，由宿主持久化后长期查询；成片地址由宿主下载槽取回，查询失败不影响已受理任务

密钥在安装后于「设置 → 媒体模型」中填写。`,
  rules,
  models: [
    {
      id: "seedance-v2.5",
      label: "Seedance V2.5",
      type: "video",
      mode: ["text", "singleImage", ["imageReference:9"]],
      durationResolutionMap: [{ duration: [10, 30], resolution: ["720p"] }],
      imageRatios: ["9:16", "16:9", "1:1"],
    },
    {
      id: "seedance-v2.0",
      label: "Seedance V2.0",
      type: "video",
      mode: ["text", "singleImage", ["imageReference:9"]],
      durationResolutionMap: [{ duration: [5, 10, 15], resolution: ["720p"] }],
      imageRatios: ["9:16", "16:9", "1:1"],
    },
  ] satisfies ProviderModel[],
  /** 只提交并返回上游任务 ID，不轮询、不等待；由任务层持久化后自行查询。 */
  async submitMedia(request: ImageRequest | VideoRequest | AudioRequest): Promise<{ upstreamId: string }> {
    const apiKey = apiKeyOf(this.config);
    if (!apiKey) throw Object.assign(new Error("请填写 API Key"), { name: "MediaProviderAuthError", followUp: "blocked" });
    const response = await this.tool.fetch(`${baseUrl}/v1/videos/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(request as VideoRequest)),
      signal: this.signal,
    });
    if (!response.ok) throw httpError("请求失败", response, "submit");
    const data = object(await response.json());
    const upstreamId = typeof data.id === "string" ? data.id : "";
    if (!upstreamId) throw Object.assign(new Error("未返回任务ID"), { name: "MediaProviderContractError", followUp: "retry" });
    return { upstreamId };
  },
  /**
   * 查询上游任务：只返回状态与结果定位信息（url 资产），不在查询里下载完整成片；
   * 成片由宿主任务层在独立下载槽用受限下载取回，并按 origin 规则附带鉴权。
   * 响应中若带 id / model / account 字段则原样最小透传，供宿主的人工绑定只读核对使用（不额外发探测请求）。
   */
  async queryMedia(upstreamId: string): Promise<ProviderMediaTaskState> {
    const apiKey = apiKeyOf(this.config);
    if (!apiKey) throw Object.assign(new Error("请填写 API Key"), { name: "MediaProviderAuthError", followUp: "blocked" });
    const response = await this.tool.fetch(`${baseUrl}/v1/videos/generations/${upstreamId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: this.signal,
    });
    if (!response.ok) throw httpError("任务查询失败", response, "query");
    const task = object(await response.json());
    const raw = typeof task.status === "string" ? task.status : "";
    const status = raw.toLowerCase();
    // ACT: 只透传上游确实返回的身份字段，缺失就不写，宿主按「无法核对」处理，不编造归属。
    const identity: Record<string, string> = {};
    for (const field of ["id", "model", "account"] as const) {
      const value = task[field];
      if (typeof value === "string" && value.trim()) identity[field === "id" ? "upstreamId" : field] = value.trim();
    }
    if (typeof task.url === "string" && task.url) {
      const state: ProviderMediaTaskState = {
        status: "succeeded",
        assets: [{ mediaType: "video", type: "url", url: absoluteUrl(task.url), mimeType: "video/mp4" }],
      };
      return Object.assign(state, { upstreamState: raw || "succeeded" }, identity);
    }
    if (["cancelled", "canceled"].includes(status)) {
      return Object.assign({ status: "cancelled" } as ProviderMediaTaskState, { upstreamState: raw }, identity);
    }
    if (["failed", "failure", "error"].includes(status)) {
      const state: ProviderMediaTaskState = { status: "failed", error: this.tool.errorMessage(task) || `视频生成失败（${raw}）` };
      return Object.assign(state, { upstreamState: raw }, identity);
    }
    const state: ProviderMediaTaskState = { status: "running" };
    return Object.assign(state, { upstreamState: raw || "unknown" }, identity);
  },
  /** 上游未提供取消接口，不能确认取消；任务层据此保留 cancellationRequested 状态。 */
  async cancelMedia(): Promise<{ confirmed: boolean }> {
    return { confirmed: false };
  },
  /**
   * 同步兼容路径：提交后每 5 秒查询，最长等待 12 小时。
   * 不适合批量或跨天等待，长任务请改用任务层 submitMedia/queryMedia（submitVideoTasks）。
   */
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const apiKey = apiKeyOf(this.config);
    if (!apiKey) localFailure("请填写 API Key（本地准备失败，未提交）");
    // ACT: 视频生成通常 5~25 分钟，30 秒长视频上游可能超过 2 小时；单次等待上限放宽到 12 小时，避免上游成功而本地先超时失败。
    const signal = AbortSignal.any([AbortSignal.timeout(12 * 60 * 60 * 1000), ...(this.signal ? [this.signal] : [])]);

    const response = await this.tool.fetch(`${baseUrl}/v1/videos/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(request)),
      signal,
    });
    if (!response.ok) throw httpError("请求失败", response, "submit");
    const data = object(await response.json());
    const taskId = typeof data.id === "string" ? data.id : "";
    if (!taskId) throw Object.assign(new Error("未返回任务ID"), { name: "MediaProviderContractError", followUp: "retry" });

    let videoUrl = "";
    while (!videoUrl) {
      await wait(signal, 5000);
      const poll = await this.tool.fetch(`${baseUrl}/v1/videos/generations/${taskId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
      });
      if (!poll.ok) throw httpError("任务查询失败", poll, "query");
      const task = object(await poll.json());
      const status = String(task.status ?? "").toLowerCase();
      if (typeof task.url === "string" && task.url) {
        videoUrl = task.url;
      } else if (["failed", "failure", "error", "cancelled", "canceled"].includes(status)) {
        throw Object.assign(new Error(this.tool.errorMessage(task) || `视频生成失败（${status}）`), { name: "MediaProviderBusinessError", followUp: "failed" });
      }
    }

    // ACT: 只返回结果定位信息，完整文件由宿主下载槽受限下载（含 100 MB 限制与同源鉴权校验）。
    return [{ mediaType: "video", type: "url", url: absoluteUrl(videoUrl), mimeType: "video/mp4" }];
  },
} satisfies ProviderDefinition<typeof rules>;
