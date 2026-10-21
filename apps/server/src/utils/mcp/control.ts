import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import conf from "@/utils/conf";
import { isMobileLinkRequest } from "@/utils/mobileLink";
import { getRuntimePlatform } from "@/lib/platform";

export const controlStateSchema = z.object({
  directory: z.string().max(4096).nullable(),
  canvasId: z.string().max(256).nullable(),
  panel: z.string().max(32),
  projectList: z.array(z.object({ directory: z.string().max(4096), name: z.string().max(256), lastOpenedAt: z.number() })).max(1000),
  tools: z.array(z.object({
    nodeId: z.string().max(256), name: z.templateLiteral(["node:", z.string()]), nodeLabel: z.string().max(200).optional(),
    description: z.string().max(4000), parameters: z.record(z.string(), z.json()),
  })).max(10000),
}).passthrough();

type ControlState = z.infer<typeof controlStateSchema>;
type ControlResult = { result?: unknown; error?: string };
// ACT: F01 同一连接的普通命令进入有界 FIFO；容量与等待预算超限时给出可理解的拒绝；已受理的后台媒体任务不受控制命令超时影响。
const controlQueueCapacity = 8;
const controlWaitBudgetMs = 120000;
const controlExecutionTimeoutMs = 120000;

type QueuedCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  directory?: string;
  expectedCanvasId?: string;
  readOnly: boolean;
  enqueuedAt: number;
  dispatchedAt?: number;
  waitTimer?: ReturnType<typeof setTimeout>;
  executionTimer?: ReturnType<typeof setTimeout>;
  settle(result: ControlResult): void;
};
// closing：整体关闭（禁用、换 Token、断页、停机）先置真，停止受理与派发，再逐条 settle。
type Connection = { id: string; state: ControlState; revision: number; response: Response; queue: QueuedCall[]; closing: boolean };
// ACT: 控制连接只属于当前单进程，重连重新注册，不持久化运行中的命令。
const connections = new Map<string, Connection>();

export function getMcpSettings() {
  const value = conf.get("settings", {}).mcp as { enabled?: unknown; token?: unknown; port?: unknown } | undefined;
  return {
    enabled: value?.enabled === true,
    token: typeof value?.token === "string" ? value.token : "",
    port: typeof value?.port === "number" && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535 ? value.port : 10588,
  };
}

function allowedHost(req: Request) {
  return isMobileLinkRequest(req) || !getRuntimePlatform().requiresLocalHost || ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname);
}

export function getAppOrigin(req: Request) {
  const source = req.get("origin") ?? req.get("referer");
  if (!source || !allowedHost(req)) throw Object.assign(new Error("只允许 Toonflow 页面访问控制连接"), { status: 403 });
  let url: URL;
  try { url = new URL(source); }
  catch { throw Object.assign(new Error("页面来源无效"), { status: 403 }); }
  if (!["http:", "https:"].includes(url.protocol) || url.host !== req.get("host")) throw Object.assign(new Error("页面来源与服务地址不一致"), { status: 403 });
  return url.origin;
}

export function authorizeMcp(req: Request) {
  const { enabled, token } = getMcpSettings();
  if (!enabled || token.length < 32 || !allowedHost(req)) return false;
  const actual = Buffer.from(req.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (req.get("origin")) {
    try { getAppOrigin(req); } catch { return false; }
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function assertAppRequest(req: Request) {
  getAppOrigin(req);
  if (req.get("x-toonflow-workspace") !== "1") throw Object.assign(new Error("只允许 Toonflow 页面访问控制连接"), { status: 403 });
}

export function assertControlRequest(req: Request) {
  assertAppRequest(req);
  if (!authorizeMcp(req)) throw Object.assign(new Error("MCP 未开启或访问凭证无效"), { status: 403 });
}

function queueInfo(connection: Connection) {
  const executing = connection.queue.some(item => item.dispatchedAt !== undefined) ? 1 : 0;
  return { capacity: controlQueueCapacity, executing, queued: connection.queue.length - executing };
}

/** 按 FIFO 派发队首命令；执行前重查连接、工作区与画布身份（R17）。closing 后不再派发任何新命令。 */
function dispatchNext(connection: Connection) {
  if (connection.closing) return;
  if (connection.queue.some(item => item.dispatchedAt !== undefined)) return;
  const call = connection.queue[0];
  if (!call) return;
  const reject = (error: string) => call.settle({ error });
  if (call.directory && connection.state.directory !== call.directory) return reject("工作区已切换，请重新调用 getAppState");
  if (call.expectedCanvasId && connection.state.canvasId !== call.expectedCanvasId) return reject("目标画布已切换，请重新获取 getAppState");
  if (connection.response.destroyed || connection.response.writableEnded) return reject("Toonflow 页面已断开，操作已取消");
  clearTimeout(call.waitTimer);
  call.waitTimer = undefined;
  call.dispatchedAt = Date.now();
  // ACT: A2A/MCP 的转写与 Agent 共用浏览器 ASR 超时，避免长音频在两分钟时被截断。
  call.executionTimer = name === "transcribeAudio" ? undefined : setTimeout(() => {
    if (!connection.response.destroyed) connection.response.write(`data: ${JSON.stringify({ type: "cancel", callId: call.id })}\n\n`);
    call.settle({ error: "控制命令执行超时，已取消" });
  }, controlExecutionTimeoutMs);
  connection.response.write(`data: ${JSON.stringify({ type: "call", callId: call.id, name: call.name, args: call.args, directory: call.directory, ...(call.expectedCanvasId ? { expectedCanvasId: call.expectedCanvasId } : {}), ...(call.readOnly ? { readOnly: true } : {}) })}\n\n`);
}

export function listConnections() {
  return [...connections.values()].map(({ id, state, queue }) => ({
    id, state,
    pending: { capacity: controlQueueCapacity, executing: queue.some(item => item.dispatchedAt !== undefined) ? 1 : 0, queued: queue.filter(item => item.dispatchedAt === undefined).length },
  }));
}

export function getConnection(id?: string, directory?: string) {
  if (id) {
    const connection = connections.get(id);
    if (!connection) throw new Error("Toonflow 页面已断开，请重新调用 getAppState");
    return connection;
  }
  const matches = [...connections.values()].filter(item => !directory || item.state.directory === directory);
  if (matches.length > 1) throw new Error("存在多个 Toonflow 页面，请用 target.connectionId 指定操作目标");
  return matches[0];
}

/**
 * 整体关闭的唯一顺序（R05）：先标 closing 停止受理与后续 dispatch，再取走队列并逐条 settle
 * （settle 内部因 closing 不再派发），最后关闭响应。禁用、换 Token、断页、停机共用这一路径。
 */
function closeConnectionCalls(connection: Connection, error: string) {
  connection.closing = true;
  const calls = connection.queue;
  connection.queue = [];
  for (const call of calls) call.settle({ error });
}

export function connectControl(id: string, response: Response) {
  if (connections.has(id)) throw Object.assign(new Error("控制连接已存在"), { status: 409 });
  const connection: Connection = { id, response, revision: 0, queue: [], closing: false, state: { directory: null, canvasId: null, panel: "home", projectList: [], tools: [] } };
  response.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  response.flushHeaders();
  connections.set(id, connection);
  response.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
  const socket = response.socket;
  const request = response.req;
  const close = () => {
    clearInterval(heartbeat);
    response.off("close", close);
    socket?.off("close", close);
    request?.off("close", close);
    if (connections.get(id) === connection) connections.delete(id);
    // 页面断开时排队与执行中的命令全部结束，不留在队列里等待连接重建。
    closeConnectionCalls(connection, "Toonflow 页面已断开，操作已取消");
  };
  // ACT: 部分运行时下 SSE 客户端断开不一定触发 close 事件；用写状态检测僵尸连接并清理。
  const heartbeat = setInterval(() => {
    if (response.destroyed || response.writableEnded) { close(); return; }
    try { response.write(": keepalive\n\n"); }
    catch { close(); }
  }, 20000);
  response.once("close", close);
  socket?.once("close", close);
  request?.once("close", close);
}

export function updateControlState(id: string, revision: number, state: ControlState) {
  const connection = getConnection(id)!;
  if (revision <= connection.revision) return;
  connection.revision = revision;
  connection.state = state;
}

export function finishControlCall(connectionId: string, callId: string, result: ControlResult) {
  const connection = getConnection(connectionId)!;
  const call = connection.queue.find(item => item.id === callId && item.dispatchedAt !== undefined);
  if (!call) throw Object.assign(new Error("控制命令已取消或不存在"), { status: 404 });
  call.settle(result);
}

/**
 * F01：同一连接的普通命令进入有界 FIFO，按顺序执行（只读命令同样排队，但不触发网页全图保存）。
 * 容量已满或排队等待超过预算时明确拒绝并说明队列状态；被取消/超时的排队命令立即出队，不会稍后执行。
 */
export function callControl(connectionId: string, name: string, args: Record<string, unknown>, signal: AbortSignal, directory?: string, expectedCanvasId?: string, readOnly?: boolean) {
  signal.throwIfAborted();
  const connection = getConnection(connectionId)!;
  // closing 后不再受理任何新命令（禁用、换 Token、断页、停机共用关闭路径）。
  if (connection.closing) throw new Error("控制连接正在关闭，本次命令未执行，请重新获取应用状态");
  if (directory && connection.state.directory !== directory) throw new Error("工作区已切换，请重新调用 getAppState");
  // R17：命令携带发出时的画布身份，由网页在执行前复核；同项目切画布后旧命令会被拒绝。
  if (expectedCanvasId && connection.state.canvasId !== expectedCanvasId) throw new Error("目标画布已切换，请重新获取 getAppState");
  const current = queueInfo(connection);
  if (connection.queue.length >= controlQueueCapacity) {
    throw new Error(`此页面控制命令队列已满（容量 ${current.capacity}，正在执行 ${current.executing} 条、排队 ${current.queued} 条），请等待前面的命令完成后再调用`);
  }
  const callId = crypto.randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const call: QueuedCall = { id: callId, name, args, directory, expectedCanvasId, readOnly: readOnly === true, enqueuedAt: Date.now(), settle: () => {} };
    const finish = ({ result, error }: ControlResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(call.waitTimer);
      clearTimeout(call.executionTimer);
      signal.removeEventListener("abort", abort);
      const index = connection.queue.indexOf(call);
      if (index >= 0) connection.queue.splice(index, 1);
      // 释放执行槽后立即派发下一条，保持 FIFO 顺序；整体关闭（closing）时不再派发。
      if (!connection.closing) dispatchNext(connection);
      if (error !== undefined) reject(new Error(error));
      else resolve(result);
    };
    const abort = () => {
      // 已派发的命令通知网页取消；仍在排队的命令只出队，绝不写 call 消息、也不事后执行。
      if (call.dispatchedAt !== undefined && !connection.response.destroyed) connection.response.write(`data: ${JSON.stringify({ type: "cancel", callId })}\n\n`);
      finish({ error: "控制命令已取消或超时" });
    };
    let settled = false;
    call.settle = finish;
    // 等待预算从入队起算：排队过久仍未开始执行的命令直接出队，避免客户端已经放弃后命令才执行。
    call.waitTimer = setTimeout(() => {
      if (call.dispatchedAt !== undefined) return;
      const info = queueInfo(connection);
      finish({ error: `控制命令排队等待超过 ${Math.round(controlWaitBudgetMs / 1000)} 秒仍未开始执行，已从队列移除（容量 ${info.capacity}，正在执行 ${info.executing} 条、排队 ${info.queued} 条），请稍后重试` });
    }, controlWaitBudgetMs);
    signal.addEventListener("abort", abort, { once: true });
    connection.queue.push(call);
    dispatchNext(connection);
  });
}

/** 停机第 1 步（I 接线 stopMcpRuntime）：先置 closing，拒绝新受理与新派发，再关闭监听与 settle。 */
export function markControlConnectionsClosing() {
  for (const connection of connections.values()) connection.closing = true;
}

/** 停机入口（I 接线）：与禁用、换 Token、断页共用同一关闭顺序；之后可由运行时关闭监听。 */
export function closeAllControlConnections(reason = "服务正在停止，控制命令已取消") {
  const current = [...connections.values()];
  connections.clear();
  for (const connection of current) {
    closeConnectionCalls(connection, reason);
    connection.response.end();
  }
}

for (const key of ["settings.mcp.enabled", "settings.mcp.token"] as const) conf.onDidChange(key, () => {
  closeAllControlConnections("MCP 设置已修改，控制命令已取消");
});
