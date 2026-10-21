import { t } from "@/lib/i18n";
import { listMediaModels, generateMedia } from "@/utils/media/generation";
import { createWorkspaceFfmpeg, executeWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { basename, dirname, join, relative, resolve } from "node:path";
import { access, constants, copyFile, lstat, mkdir, readFile, readdir, rm, rmdir, stat, withFileAccess } from "@toonflow/file";
import {
  defineTool, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition,
  detectSupportedImageMimeTypeFromFile, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CanvasContext, MediaContext, QuestionContext, ToolContext, ToolFiles } from "@toonflow/tools-scaffold/runtime";
import type { MediaTasksContext } from "@toonflow/tool-media-generation/runtime";
import conf from "@/utils/conf";
import { isWithin, resolveWorkspacePath, writeWorkspaceFile, lockWorkspaceFiles, protectWorkspaceRoot } from "@/utils/workspace/files";
import { listTools, loadTool, validateToolConfig } from "@/utils/plugins/tools";
import { createSkillContext } from "@/agent/skills";
import { cancelMediaTasks, getMediaTasks, pauseMediaTasks, resolveTaskDirectory, resumeMediaTasks, submitMediaTasks } from "@/utils/mediaTasks";
import { createBrowserContext } from "@/utils/browser";
import { importImage } from "@/utils/workspace/chatImages";
import { createAssetContext } from "@/agent/assets";
import { readDocument } from "@/utils/documents";
import { createMcpAgentTools } from "@/utils/mcp/servers";
import { asrRequestSchema } from "@toonflow/tools-scaffold/runtime";
import { duplicateFileRecords, findFileRelocationWriteBlock, removeFileRecord, removeFileRecords } from "@/utils/fileRecords";
import { relocateWorkspacePathWithTasks } from "@/utils/cleanup";

export function createAgentToolContext(cwd: string, config: Record<string, unknown> = {}, canvas?: CanvasContext, question?: QuestionContext, workspaceAvailable = true): ToolContext {
  const requireWorkspace = () => { if (!workspaceAvailable) throw new Error("此对话未提供工作目录，无法使用文件或媒体操作"); };
  const skillsDirectory = join(dirname(conf.path), "skills");
  const resolvePath = async (path: string, readOnly = false) => {
    const absolute = resolve(cwd, path);
    const root = readOnly && isWithin(skillsDirectory, absolute) ? skillsDirectory : cwd;
    return (await resolveWorkspacePath(root, relative(root, absolute), true)).path;
  };
  const withWritePaths = async (paths: string[], operation: (targets: string[]) => Promise<void>) => {
    const targets = await Promise.all(paths.map(path => resolvePath(path)));
    const release = lockWorkspaceFiles(targets);
    try { await operation(targets); }
    finally { release(); }
  };
  const files: ToolFiles = {
    importImage: url => { requireWorkspace(); return importImage(cwd, url); },
    readFile: async (path, readOnly = false) => readFile(await resolvePath(path, readOnly)),
    access: async (path, readOnly = false) => access(await resolvePath(path, readOnly)),
    stat: async (path, readOnly = false) => stat(await resolvePath(path, readOnly)),
    readdir: async (path, readOnly = false) => readdir(await resolvePath(path, readOnly)),
    detectImageMimeType: async (path, readOnly = false) => {
      const target = await resolvePath(path, readOnly);
      return withFileAccess([target], "read", () => detectSupportedImageMimeTypeFromFile(target));
    },
    writeFile: (path, content, exclusive = false) => withWritePaths([path], async ([target]) => {
      // T15/§P.3（第七轮 R2 接线）：未完成改名事务端点（含后代）的普通覆盖写必须被拦（与 HTTP/MCP 写路径同一判定）。
      const writeBlock = await findFileRelocationWriteBlock(target);
      if (writeBlock) throw Object.assign(new Error(writeBlock.message), { code: "ERELOCATING", status: 409 });
      await writeWorkspaceFile(target, content, exclusive);
    }),
    mkdir: (path, recursive = false) => withWritePaths([path], async ([target]) => {
      await mkdir(target, { recursive });
    }),
    rename: async (path, target) => {
      // T15/互审：改名必须由统一入口 relocateWorkspacePathWithTasks 在内部取路径锁；外层 withWritePaths 先锁同一批路径
      // 会让锁（不可重入）必然 EBUSY。这里只做路径解析与根目录保护，锁与归属/任务定位事务全部交给统一入口。
      const [source, destination] = await Promise.all([resolvePath(path), resolvePath(target)]);
      protectWorkspaceRoot(cwd, source);
      protectWorkspaceRoot(cwd, destination);
      const finalTarget = resolve(dirname(destination), basename(resolve(cwd, target)));
      // R09/C2 + T15：改名走统一入口（任务锁 → 源/目标路径锁 → 递归归属迁移 + 重定位日志 + 任务 outputs 定位更新），
      // 失败明确报错而不是 warn 掩盖账本状态；占用/忙碌/已存在返回 409。
      const result = await relocateWorkspacePathWithTasks({ directory: cwd, source, target: finalTarget });
      if (!result.ok) {
        const status = result.code === "EINVALID" ? 400 : result.code === "EMISSING" ? 404
          : result.code === "EBUSY" || result.code === "EOCCUPIED" || result.code === "EEXIST" || result.code === "EIDENTITY" ? 409 : 500;
        // T15/§P.5（第七轮 R4）：失败出口把保护状态并入抛出的错误文本（宿主/调用方可见），
        // 不静默丢弃「保护仍在需核对」这一事实。
        throw Object.assign(
          new Error(result.warning ? `${result.message}（保护状态：${result.warning}）` : result.message),
          { code: result.code, status, ...(result.warning ? { warning: result.warning } : {}) },
        );
      }
      // T15/§O.3（第六轮互审 3）：`portFiles.rename` 的接口不承载返回值，warning（如「已完成但迁移意图保护清除失败，
      // 保护仍在需清理核对」）至少必须进入服务端日志，不能静默丢弃；HTTP 路由已结构化透出该字段。
      if (result.warning) console.warn(`[改名] ${result.from} → ${result.to} 已完成，但需人工关注：${result.warning}`);
    },
    remove: (path, recursive = false) => withWritePaths([path], async ([target]) => {
      protectWorkspaceRoot(cwd, target);
      if ((await lstat(target)).isDirectory() && !recursive) await rmdir(target);
      else await rm(target, { recursive });
      // 归属清账覆盖目录后代；失败传播，不用 warn 掩盖账本错误。
      await (recursive ? removeFileRecords(target) : removeFileRecord(target));
    }),
    copyFile: (path, target, exclusive = false) => withWritePaths([path, target], async ([source, destination]) => {
      await copyFile(source, destination, exclusive ? constants.COPYFILE_EXCL : 0);
      // ACT: 复制的文件重新起算保留期（不复用源归属的计时）；登记失败传播，不吞账本错误。
      await duplicateFileRecords(source, destination);
    }),
  };
  // ACT: 持久任务工具直连 mediaTasks 服务；directory 必须与宿主工作区一致，避免绕过工作区授权。
  const media: MediaContext & MediaTasksContext = {
    listModels: listMediaModels,
    generateImage: (request, signal) => generateMedia(cwd, "image", request, signal),
    generateVideo: (request, signal) => generateMedia(cwd, "video", request, signal),
    generateAudio: (request, signal) => generateMedia(cwd, "audio", request, signal),
    submitVideoTasks: async (input, signal) => {
      const directory = await resolveTaskDirectory(input.directory, cwd);
      return submitMediaTasks({ ...input, directory }, { signal });
    },
    getVideoTasks: async (input, signal) => {
      const directory = await resolveTaskDirectory(input.directory, cwd);
      signal?.throwIfAborted();
      return getMediaTasks({ ...input, directory });
    },
    cancelVideoTasks: async (input, signal) => {
      const directory = await resolveTaskDirectory(input.directory, cwd);
      signal?.throwIfAborted();
      return cancelMediaTasks({ ...input, directory });
    },
    pauseVideoTasks: async (input, signal) => {
      const directory = await resolveTaskDirectory(input.directory, cwd);
      signal?.throwIfAborted();
      return pauseMediaTasks({ ...input, directory });
    },
    resumeVideoTasks: async (input, signal) => {
      const directory = await resolveTaskDirectory(input.directory, cwd);
      signal?.throwIfAborted();
      return resumeMediaTasks({ ...input, directory });
    },
  };
  return {
    cwd, config, files, resolvePath, writeFile: files.writeFile, canvas, question,
    skills: workspaceAvailable ? createSkillContext(cwd) : undefined, assets: workspaceAvailable ? createAssetContext(cwd) : undefined,
    browser: createBrowserContext(cwd),
    asr: {
      async transcribe(path, options = {}) {
        requireWorkspace();
        options.signal?.throwIfAborted();
        if (!canvas) throw new Error("当前对话未连接画布，无法使用浏览器语音识别");
        const source = await resolvePath(path);
        const args = asrRequestSchema.parse({ path: relative(cwd, source).replaceAll("\\", "/"), lang: options.lang });
        options.signal?.throwIfAborted();
        const result = await canvas.call({ name: "transcribeAudio", args }, options.signal);
        if (typeof result !== "string") throw new Error("语音识别返回了无效的文本");
        return result;
      },
    },
    ffmpeg: signal => { requireWorkspace(); return createWorkspaceFfmpeg(cwd, signal); },
    // ACT: 工具插件的 FFmpeg 远程请求统一走宿主执行入口，共享进程级容量（F11）。
    ffmpegExecute: (factory, request, emit, signal) => executeWorkspaceFfmpeg(factory, request, emit, signal),
    media,
    sdk: {
      defineTool, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition,
      createReadToolDefinition: (directory, options) => {
        const operations = options?.operations ?? {
          readFile: (path: string) => files.readFile(path, true),
          access: (path: string) => files.access(path, true),
          detectImageMimeType: (path: string) => files.detectImageMimeType(path, true),
        };
        const tool = createReadToolDefinition(directory, { ...options, operations: {
          ...operations,
          readFile: async path => readDocument(path, await operations.readFile(path)),
        } });
        return { ...tool, description: `${tool.description}
HTML、Markdown、JSON、XML、配置和代码文件读取原文；Office、OpenDocument、RTF、EPUB、CSV、PDF 在本地解析为 Markdown。offset/limit 对应读取后的行。扫描 PDF 需要先做 OCR。` };
      },
      detectSupportedImageMimeTypeFromFile: path => files.detectImageMimeType(path, true),
    },
  };
}

export async function createAgentTools(cwd: string, canvas?: CanvasContext, question?: QuestionContext, includeMcp = true): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  const names = new Set<string>();
  const context = createAgentToolContext(cwd, {}, canvas, question);
  for (const item of await listTools()) {
    if (!item.enabled) continue;
    if (item.loadError) throw new Error(`${item.displayName}：${item.loadError}`);
    const { plugin, metadata } = await loadTool(item.name);
    const config = validateToolConfig(plugin, item.config);
    const definitions = await plugin.createTools({ ...context, config });
    for (const tool of definitions) {
      if (!tool.name || typeof tool.execute !== "function") throw new Error(t`${item.displayName} 返回了无效的工具`);
      if (names.has(tool.name)) throw new Error(t`工具名称重复：${tool.name}`);
      names.add(tool.name);
      tools.push({
        ...tool,
        promptGuidelines: [
          ...(metadata.prompt ? [metadata.prompt] : []),
          ...(tool.promptGuidelines ?? []),
        ],
      });
    }
  }
  if (includeMcp) tools.push(...await createMcpAgentTools());
  return tools;
}
