import { t, translateError, translateMessage } from "@/lib/i18n";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "@toonflow/file";
import { join, relative } from "node:path";
import { mediaProviders, type Provider } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, MediaModel, MediaReference } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { getMediaProvider, listMediaProviders, loadMediaProviderSource } from "@/utils/media/provider";
import { assetBytes, contentAddressedMediaName, detectMimeType, maxMediaSize } from "@/utils/media/assetBytes";
import type { AssetDownloadAuthorization } from "@/utils/media/assetBytes";
import { beginFileRegistrationProtection, findFileRelocationWriteBlock } from "@/utils/fileRecords";
import { getSchedulerStatus } from "@/utils/mediaTasks";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";

// ACT: 单请求参考媒体总字节预算，避免一次生成把大量并行参考图读入内存（R10）。
const defaultReferenceBudgetMb = 200;

/** 附带在异常上的已落盘输出；任务层据此登记部分结果，不重跑上游（R08/F15）。 */
export type GeneratedMediaOutput = GeneratedMedia & { absolutePath: string; sha256: string };

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

/**
 * 本地准备/校验失败（确定未发上游）：任务层据此记「提交前失败」，不占保守在途额度、不转待核对（契约 v3 §C.5）。
 * 只用于真正在发起供应商请求之前失败的场景；上游已受理后的错误（如下载失败）不使用它。
 */
function localInputFailure(message: string): never {
  throw Object.assign(new Error(message), { status: 400, name: "MediaLocalFailureError", followUp: "failed" });
}

/** 内容寻址落盘：同一 sha256 固定同一路径；已存在时核对普通文件与真实内容，不只比长度（F15）。 */
async function writeContentAddressed(path: string, bytes: Uint8Array) {
  const existing = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing?.isFile()) {
    const current = await readFile(path).catch(() => null);
    const expected = createHash("sha256").update(bytes).digest("hex");
    if (current && createHash("sha256").update(current).digest("hex") === expected) return;
  }
  // T15/§P.3（第七轮 R2 接线）：未完成改名事务端点（含后代）的普通覆盖写必须被拦（与 HTTP/MCP/Agent 写路径
  // 同一判定），避免把未完成事务的文件换成新内容后仍按旧意图认回；内容一致（上面已 return）不算改写。
  const writeBlock = await findFileRelocationWriteBlock(path);
  if (writeBlock) throw Object.assign(new Error(writeBlock.message), { status: 409, code: "ERELOCATING" });
  await writeWorkspaceFile(path, bytes);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageOptions(value: unknown, pattern: RegExp) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 64 && item === item.trim() && pattern.test(item)))] : undefined;
}

export async function listMediaModels(): Promise<MediaModel[]> {
  const installedProviders = await listMediaProviders();
  return installedProviders.flatMap(provider => provider.models.flatMap(model => {
    if (model.type !== "image" && model.type !== "video" && model.type !== "audio") return [];
    const builtIn = (mediaProviders as readonly Provider[]).find(item => item.id === provider.id)?.models.find(item => item.id === model.id);
    return [{
      providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label, type: model.type,
      // ACT: 暴露供应商持久任务能力，网页节点据此选择持久任务链或同步生成路径（F20）。
      asyncMedia: provider.asyncMedia,
      mode: model.mode, durationResolutionMap: model.durationResolutionMap, audio: model.audio,
      ...(model.type === "audio" ? { voices: model.voices } : {}),
      ...(model.type === "image" ? {
        imageSizes: imageOptions(Array.isArray(model.imageSizes) ? model.imageSizes : builtIn?.imageSizes, /^[^\u0000-\u001f\u007f]+$/),
        imageRatios: imageOptions(Array.isArray(model.imageRatios) ? model.imageRatios : builtIn?.imageRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/),
      } : {}),
    } as MediaModel];
  }));
}

export async function readReference(cwd: string, reference: MediaReference, mediaType: string, signal?: AbortSignal): Promise<Extract<MediaInput, { type: "base64" }>> {
  signal?.throwIfAborted();
  const { path } = await resolveWorkspacePath(cwd, reference.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxMediaSize) localInputFailure("参考媒体须为不超过 100 MB 的文件（本地准备失败，未提交）");
  const bytes = await readFile(path, { signal });
  if (!bytes.length || bytes.length > maxMediaSize) localInputFailure("参考媒体为空或超过 100 MB（本地准备失败，未提交）");
  const mimeType = detectMimeType(bytes, reference.mimeType);
  if (!mimeType.startsWith(`${mediaType}/`)) localInputFailure(translateMessage(t`参考媒体类型须为 ${mediaType}`));
  return { type: "base64", data: bytes.toString("base64"), mimeType };
}

export async function generateMedia(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  // T03/第五轮（契约 §N.1）：旧同步生成入口（/api/ai/media/generate、Agent mediaGeneration 工具、节点局部重绘）
  // 必须消费与后台调度**同一**的新创建准入判据——任务台账未装载/恢复未完成/装载告警/保护与归属未就绪/全局暂停
  // 任一成立即拒绝创建上游请求（受理排队与真实创建分开；同步入口没有排队语义，直接拒绝并给出可读原因）。
  const admission = getSchedulerStatus();
  if (!admission.ready) {
    throw Object.assign(new Error(`新生成未获准（同步入口）：${admission.dispatchBlockReason ?? "任务台账/保护状态未就绪或已全局暂停"}；请先完成恢复核对或取消暂停`), {
      status: 503, code: "EBLOCKED",
    });
  }
  if (!request.prompt.trim()) localInputFailure("请输入生成提示词");
  const directory = await realpath(cwd);
  const outputDirectory = request.outputDirectory ?? "assets/generated";
  try {
    await resolveWorkspacePath(directory, outputDirectory, true);
  } catch (error) {
    localInputFailure(translateError(error) || "输出目录无效（本地准备失败，未提交）");
  }
  const providerInfo = await getMediaProvider(request.providerId);
  const model = providerInfo.models.find(model => model.id === request.modelId && model.type === mediaType);
  if (!model) localInputFailure("所选媒体模型不存在或类型不匹配，请重新选择");
  const configurations = record(conf.get("settings", {}).mediaProviderConfigs);
  const configuration = record(configurations[providerInfo.id]);
  const provider = await loadMediaProviderSource(providerInfo.source, configuration, signal, undefined, directory);
  const generate = mediaType === "image" ? provider.generateImage : mediaType === "video" ? provider.generateVideo : provider.generateAudio;
  if (typeof generate !== "function") localInputFailure(translateMessage(t`此供应商不支持${translateMessage({ image: "图片", video: "视频", audio: "音频" }[mediaType])}生成`));
  const rules = Array.isArray(provider.rules) ? provider.rules : [];
  if (rules.some(rule => rule.field === "apiKey") && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) {
    localInputFailure("请先在媒体模型设置中配置供应商 API Key（本地准备失败，未提交）");
  }
  // ACT: 结果下载只允许同源 HTTPS 地址附带鉴权（F17）；供应商地址缺失时按公开地址下载。
  const apiUrl = typeof provider.apiUrl === "string" && provider.apiUrl ? provider.apiUrl : providerInfo.apiUrl ?? "";
  const token = typeof configuration.apiKey === "string" ? configuration.apiKey.trim().replace(/^Bearer(?:\s+|$)/i, "").trim() : "";
  const authorization: AssetDownloadAuthorization | undefined = apiUrl && token ? { apiUrl, token } : undefined;
  const referenceBudgetMb = (() => {
    const value = record(conf.get("settings", {}).mediaTasks).referenceBudgetMb;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : defaultReferenceBudgetMb;
  })();
  const referenceBudget = referenceBudgetMb * 1024 * 1024;
  let referenceBytes = 0;
  // ACT: 顺序读取并累计总预算，单文件仍受 100MB 限制；避免并行读入大量参考媒体（R10）。
  const references = async (items: MediaReference[] | undefined, type: string) => {
    if (!items) return undefined;
    const result: Extract<MediaInput, { type: "base64" }>[] = [];
    for (const item of items) {
      const input = await readReference(directory, item, type, signal);
      referenceBytes += Math.floor((input.data.length * 3) / 4);
      if (referenceBytes > referenceBudget) localInputFailure(`参考媒体总大小超过 ${referenceBudgetMb} MB 限制（本地准备失败，未提交）`);
      result.push(input);
    }
    return result;
  };
  const images = await references(request.images, "image");
  signal?.throwIfAborted();
  const assets = mediaType === "audio"
    ? await provider.generateAudio!({
      model: request.modelId, text: request.prompt, images, audios: await references(request.audios, "audio"),
      voice: request.voice, speed: request.speed, volume: request.volume, pitch: request.pitch, language: request.language, format: request.format, sampleRate: request.sampleRate,
    })
    : mediaType === "image"
    ? await provider.generateImage!({ model: request.modelId, prompt: request.prompt, images, ratio: request.ratio, size: request.size })
    : await provider.generateVideo!({
      model: request.modelId, prompt: request.prompt, images,
      videos: await references(request.videos, "video"), audios: await references(request.audios, "audio"),
      firstFrame: request.firstFrame ? await readReference(directory, request.firstFrame, "image", signal) : undefined,
      lastFrame: request.lastFrame ? await readReference(directory, request.lastFrame, "image", signal) : undefined,
      ratio: request.ratio, resolution: request.resolution, duration: request.duration,
      generateAudio: request.generateAudio, mode: request.mode,
    });
  if (!Array.isArray(assets) || !assets.length) invalid("供应商未返回生成结果");
  const written: string[] = [];
  const outputs: GeneratedMediaOutput[] = [];
  const result: GeneratedMedia[] = [];
  try {
    for (const asset of assets) {
      signal?.throwIfAborted();
      const { bytes, mimeType } = await assetBytes(asset, mediaType, signal, { authorization });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      signal?.throwIfAborted();
      const output = await resolveWorkspacePath(directory, outputDirectory, true);
      await mkdir(output.path, { recursive: true });
      // ACT: 内容寻址文件名（<类型>-<sha256 前 32 位>.<扩展名>）；同内容复用同一路径，崩溃后可认回原文件。
      const file = join(outputDirectory, contentAddressedMediaName(mediaType, mimeType, sha256));
      const { path } = await resolveWorkspacePath(directory, file);
      signal?.throwIfAborted();
      // ACT: 锁目标文件而不是输出目录，多任务并发保存不同结果不再互相阻塞（R07）。
      const release = lockWorkspaceFiles([path]);
      try {
        // R08/Q6：同一路径锁内先落盘登记围栏，再写/核实真实文件，最后 complete() 登记；
        // complete() 失败时围栏保留（清理前可恢复重试）并把错误传播给调用方，不再 warn 后继续成功。
        const guard = await beginFileRegistrationProtection(
          { path, directory, sourceKind: "generated", mediaKind: mediaType },
          // T17：给出目标内容身份，恢复时能区分“新建 / 覆盖前已有旧文件 / 新内容已发布”三类。
          { expectedContent: { size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") } },
        );
        try {
          await writeContentAddressed(path, bytes);
        } catch (error) {
          await guard.abort().catch(() => undefined);
          throw error;
        }
        const published = relative(directory, path).replace(/\\/g, "/");
        written.push(path);
        await guard.complete();
        outputs.push({ path: published, mimeType, mediaType, absolutePath: path, sha256 });
        result.push({ path: published, mimeType, mediaType });
      } finally { release(); }
    }
    signal?.throwIfAborted();
    return result;
  } catch (err) {
    // ACT: 保留已成功落盘的文件（含 sha256），调用方按 savedOutputs 登记部分结果而不重跑上游（R08/F15）。
    if (err && typeof err === "object") Object.assign(err, { savedPaths: [...written], savedOutputs: outputs });
    throw err;
  }
}
