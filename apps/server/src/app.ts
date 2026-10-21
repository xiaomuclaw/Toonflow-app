import logger from "morgan";
import express from "express";
import cors from "cors";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readFile } from "@toonflow/file";
import type { Request, Response, NextFunction } from "express";
import buildRoute from "@/core";
import { error } from "@/lib/responseFormat";
import desktopRequest from "@/lib/desktop";
import initializePlugins from "@/utils/plugins/initialize";
import { languageRequest, resolveRequestLocale, runWithLocale, setLocaleFallback, translateError, translateMessage } from "@/lib/i18n";
import { detectLocale, normalizeLocale } from "@toonflow/i18n";
import { z } from "zod";

const autoInstallProviders = ["tfRouter.ts", "apiMart.ts", "metaso.ts", "xmxImage.ts", "dolaVideo.ts"];

export async function createApp({
  webRoot,
  dataDirectory,
  toolsRoot,
  nodesRoot,
  extRoot,
  providersRoot,
  skillsRoot,
  agentsRoot,
  pluginRevision,
  auth,
}: {
  webRoot: string;
  dataDirectory?: string;
  toolsRoot?: string;
  nodesRoot?: string;
  extRoot?: string;
  providersRoot?: string;
  skillsRoot?: string;
  agentsRoot?: string;
  pluginRevision?: string;
  /** 独立服务器部署启用单账号会话认证；桌面复用应用时不传。 */
  auth?: boolean;
}) {
  // conf 由下方的路由动态加载，必须先确定整个进程共用的数据目录。
  if (dataDirectory) process.env.TOONFLOW_DATA_DIR = resolve(dataDirectory);
  const { default: conf } = await import("@/utils/conf");
  setLocaleFallback(() => normalizeLocale((conf.get("settings", {}).ui as { language?: unknown } | undefined)?.language)
    ?? detectLocale([Intl.DateTimeFormat().resolvedOptions().locale]));
  // ACT: 记录逐组插件同步结果（未改官方自动更新、定制保留到 pendingUpdates），供发布后核对安装身份（I3/V24/V25）。
  const pluginManifests: { group: string; manifest: Awaited<ReturnType<typeof initializePlugins>> }[] = [];
  if (dataDirectory && toolsRoot)
    pluginManifests.push({ group: "tools", manifest: await initializePlugins(resolve(dataDirectory, "tools"), toolsRoot, /^[a-z][a-zA-Z0-9]*\.tool\.js$/, pluginRevision) });
  if (dataDirectory && nodesRoot) pluginManifests.push({ group: "nodes", manifest: await initializePlugins(resolve(dataDirectory, "nodes"), nodesRoot, /^[a-z][a-zA-Z0-9]*\.umd\.js$/, pluginRevision) });
  if (dataDirectory && extRoot) {
    const { default: initializeExt } = await import("@/utils/plugins/initializeExt");
    await initializeExt(resolve(dataDirectory, "ext"), extRoot, pluginRevision);
  }
  // ACT: 内置媒体供应商随构建同步，其他供应商文件和独立保存的配置保留。
  if (dataDirectory && providersRoot) {
    const sourceDirectory = resolve(providersRoot, "media");
    let providerRevision = pluginRevision;
    if (providerRevision === undefined) {
      const hash = createHash("sha256");
      for (const name of autoInstallProviders) {
        const source = await readFile(resolve(sourceDirectory, name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return Buffer.alloc(0);
          throw error;
        });
        hash.update(name).update("\0").update(source).update("\0");
      }
      providerRevision = hash.digest("hex");
    }
    pluginManifests.push({ group: "providers", manifest: await initializePlugins(resolve(dataDirectory, "providers"), sourceDirectory, autoInstallProviders, providerRevision) });
  }
  for (const { group, manifest } of pluginManifests) {
    if (!manifest) continue;
    const files = Object.values(manifest.files);
    const counts = files.reduce<Record<string, number>>((totals, item) => { totals[item.status] = (totals[item.status] ?? 0) + 1; return totals; }, {});
    const pending = files.filter(item => item.status === "customized" && item.pendingPath).map(item => item.pendingPath);
    console.log(`[插件同步] ${group} revision=${manifest.revision ?? "-"} ${JSON.stringify(counts)}${pending.length ? ` 待人工合并=${pending.join("、")}` : ""}`);
  }
  // ACT: 技能和团队只补首次安装，保留用户修改。
  if (dataDirectory && skillsRoot) await initializePlugins(resolve(dataDirectory, "skills"), skillsRoot);
  if (dataDirectory && agentsRoot) await initializePlugins(resolve(dataDirectory, "agents"), agentsRoot);
  const app = express();

  // ACT: 停机门与在途请求计数（T02）：停机时先置 toonflowStopping 让新请求得到明确 503（不误当业务失败），
  // 已受理的在途请求继续完成关键落盘；等计数归零后再真正 close。Bun 的 server.close() 会立即断开在途连接，
  // 因此不能把它当作“请求已收尾”的判断依据。SSE 等长连接在响应头发出后不再计入。
  let httpInflight = 0;
  app.locals.toonflowStopping = false;
  app.use((request, response, next) => {
    if (app.locals.toonflowStopping === true && !(request.method === "GET" && request.path === "/api/health")) {
      response.status(503).json(error("服务正在停止，请稍后重试", { code: "ESTOPPING" }, 503));
      return;
    }
    httpInflight += 1;
    let done = false;
    const finish = () => { if (!done) { done = true; httpInflight = Math.max(0, httpInflight - 1); } };
    response.once("finish", finish);
    response.once("close", finish);
    // ACT: 响应头一旦发出且为 SSE（长连接）即视为“已开始流式返回”，不再计入停机等待。
    // 精确拦截 writeHead（flushHeaders 内部也经它）而不是用固定延时猜测——互审复核发现按 250ms 采样时，
    // 晚于该时刻才 flush 头的 SSE 会被一直计入，导致停机等待到截止前 12s 才 close。
    const writeHead = response.writeHead.bind(response) as (...values: unknown[]) => unknown;
    (response as unknown as { writeHead: (...values: unknown[]) => unknown }).writeHead = (...values: unknown[]) => {
      const result = writeHead(...values);
      const type = String(response.getHeader("content-type") ?? "");
      if (type.includes("text/event-stream")) finish();
      return result;
    };
    next();
  });
  app.locals.toonflowHttpInflight = () => httpInflight;

  if (process.env.NODE_ENV === "dev") {
    await buildRoute();
    app.use(logger("dev"));
  }
  app.use(cors());
  app.use(languageRequest);
  // ACT: 认证门必须在大请求体解析之前，未通过时也不进入任何业务路由。
  if (auth) {
    if (!dataDirectory) throw new Error("启用认证需要提供数据目录");
    const { initializeAuth, createAuthGate } = await import("@/utils/auth");
    await initializeAuth(dataDirectory);
    app.use("/api", createAuthGate());
  }
  app.use("/a2a", express.json({ limit: "2mb" }));
  app.use(["/api/workspaces/files/write", "/api/assets/save"], express.raw({ type: "application/octet-stream", limit: "100mb" }));
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));
  app.use("/api/desktop", desktopRequest);

  const { default: initializeProviderModels } = await import("@/utils/ai/initialize");
  await initializeProviderModels();
  const router = await import("@/router");
  router.default(app);
  const [{ createMcpRouter }, { getMcpTools }, { authorizeMcp }, { skillResources }] = await Promise.all([
    import("@toonflow/mcp"),
    import("@/utils/mcp/tools"),
    import("@/utils/mcp/control"),
    import("@/utils/mcp/resources"),
  ]);
  app.use("/mcp", createMcpRouter({ getTools: getMcpTools, authorize: authorizeMcp, resources: skillResources,
    runInRequest: (request, operation) => runWithLocale(resolveRequestLocale(request.get("accept-language")), operation),
    translate: translateMessage,
    translateError,
  }));
  const { createA2aRouter } = await import("@/agent/a2a");
  app.use("/a2a", createA2aRouter());
  app.use(express.static(webRoot));

  // ACT: 任务持久化在启动后异步恢复，不阻塞监听；恢复逻辑由调度器自行延迟。
  const { initializeMediaTasks } = await import("@/utils/mediaTasks");
  void initializeMediaTasks();
  const { initializeCleanup } = await import("@/utils/cleanup");
  void initializeCleanup();

  // 错误处理
  app.use((err: Error & { status?: number }, request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) return next(err);
    console.error(err);
    if (err instanceof z.ZodError) {
      return response.status(400).json(error("参数错误", err.issues.map(issue => ({ ...issue, message: translateMessage(issue.message) })), 400));
    }
    const code = (err as NodeJS.ErrnoException).code;
    const status = err.status || ({ ENOENT: 404, ENOTDIR: 404, EEXIST: 409, ENOTEMPTY: 409, EACCES: 403, EPERM: 403 }[code ?? ""] ?? 500);
    const message =
      {
        ENOENT: "找不到这个文件或文件夹，可能已被移动、删除，或者位置选错了。",
        ENOTDIR: "你选中的是文件，但这里需要选择文件夹。请重新选择。",
        EEXIST: "这个名称已经被占用了，请换一个名称。原来的内容不会被覆盖。",
        ENOTEMPTY: "这个文件夹里还有内容，不能直接删除。请先清空或移走里面的文件。",
        EACCES: "没有权限访问这个文件或文件夹。请检查权限，或换一个位置重试。",
        EPERM: "系统不允许这次操作。文件可能正在被其他程序使用，请关闭后重试。",
        EISDIR: "你选中的是文件夹，但这里需要的是文件。请重新选择具体文件。",
      }[code ?? ""] ?? translateError(err);
    response.status(status).json(error(message, code ? { code } : null, status));
  });

  return app;
}
