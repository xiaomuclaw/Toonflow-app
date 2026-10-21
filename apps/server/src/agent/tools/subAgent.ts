import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import { teamNameSchema } from "@toonflow/teams-scaffold/runtime";
import { addUsage, emptyUsage, type SubAgentModel, type SubAgentResult } from "@/agent/runtime/subAgent";
import { createTeamRunner } from "@/agent/teams";
import { runRemoteTeam } from "@/agent/teams/remote";
import { listTeams, getRemoteTeam } from "@/utils/teams";

// ACT: 子 Agent 全局并发上限，跨父/子 Agent 共享；这是应用层保护，避免多级委派同时打满模型与工具资源，可按服务器容量调整。
const maxConcurrentSubAgents = 3;
type SubAgentSlot = { yielded: boolean };
let runningSubAgents = 0;
const waitingSubAgents = new Set<() => void>();
// ACT: 让出槽位的子 Agent 在等待自己的子任务期间不再占用名额，避免父等待子、子又等待孙时互相占满全部名额造成死锁。
const subAgentSlot = new AsyncLocalStorage<SubAgentSlot>();

function grantSubAgentSlots() {
  for (const waiter of waitingSubAgents) {
    if (runningSubAgents >= maxConcurrentSubAgents) return;
    waitingSubAgents.delete(waiter);
    runningSubAgents++;
    waiter();
  }
}

function releaseSubAgentSlot(slot: SubAgentSlot) {
  if (!slot.yielded) runningSubAgents--;
  grantSubAgentSlots();
}

function acquireSubAgentSlot(signal?: AbortSignal): Promise<SubAgentSlot> {
  signal?.throwIfAborted();
  const held = subAgentSlot.getStore();
  if (held && !held.yielded && runningSubAgents >= maxConcurrentSubAgents) {
    held.yielded = true;
    runningSubAgents--;
  }
  return new Promise<SubAgentSlot>((resolve, reject) => {
    // ACT: 排队期间可取消；aborted 立即出队并抛出取消原因，不残留等待项。
    const waiter = () => { signal?.removeEventListener("abort", cancel); resolve({ yielded: false }); };
    const cancel = () => { waitingSubAgents.delete(waiter); reject(signal!.reason); };
    waitingSubAgents.add(waiter);
    signal?.addEventListener("abort", cancel, { once: true });
    grantSubAgentSlots();
  });
}

/**
 * R10：父任务把槽位让给自己的子任务后，必须在返回工具结果、继续推理前重新通过同一 FIFO 取得槽，
 * 否则“A 让槽给 D、子任务结束”后 A 与 B/C/D 会一起超限运行。已让出才重取，未让出直接返回（幂等）。
 */
function reacquireSubAgentSlot(slot: SubAgentSlot, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!slot.yielded) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const waiter = () => { slot.yielded = false; signal?.removeEventListener("abort", cancel); resolve(); };
    const cancel = () => { waitingSubAgents.delete(waiter); reject(signal!.reason); };
    waitingSubAgents.add(waiter);
    signal?.addEventListener("abort", cancel, { once: true });
    grantSubAgentSlots();
  });
}

const parameters = z.strictObject({
  tasks: z.array(z.strictObject({
    name: z.string().trim().min(1).max(80).describe("本次任务名称"),
    task: z.string().trim().min(1).max(24000).describe("完整任务、必要背景、相对路径、已获授权和预期交付；不继承主对话历史"),
    team: teamNameSchema.optional().describe("已安装团队或远端 A2A 连接名；省略则创建临时子 Agent"),
    taskId: z.string().min(1).max(512).optional().describe("继续远端等待补充的 A2A task 时原样传回"),
    contextId: z.string().min(1).max(512).optional().describe("继续远端 A2A 会话时原样传回"),
  })).min(1),
});

export async function createSubAgentTool({ cwd, tools, canvas, runTask, ...modelOptions }: SubAgentModel & {
  cwd: string; tools: ToolDefinition[]; canvas?: CanvasContext;
  runTask: (name: string, task: string, signal?: AbortSignal, onProgress?: (text: string) => void) => Promise<{ result: SubAgentResult; usage: ReturnType<typeof emptyUsage> }>;
}): Promise<ToolDefinition> {
  if (tools.some(tool => tool.name === "subAgent")) throw new Error("工具名称 subAgent 已被内置子任务工具占用");
  const teams = (await listTeams()).filter(team => team.enabled && !team.loadError);
  const subAgentTool: ToolDefinition = {
    name: "subAgent", label: "子任务与团队",
    description: `并行执行委派的独立任务。省略 team 创建可继续对话的子 Agent，继承宿主工具，包括提问、继续委派和 report 上报；指定 team 调用已安装团队或外部 A2A。宿主工具：${[...tools.map(tool => tool.name), "subAgent"].join("、")}。团队目录：${JSON.stringify(teams.map(({ name, description, kind }) => ({ name, description, kind })))}。本地团队按清单分工。任务数量、执行轮次和总时长不设固定上限，子 Agent 并发由应用层统一排队，可由用户停止。`,
    promptSnippet: "按需使用 subAgent 委派独立工作，或指定已安装 team 调用专用团队。",
    promptGuidelines: [
      "简单任务直接完成；只委派相互独立的工作，提供必要背景和真实授权。并行任务不得修改同一文件或画布，依赖任务分次处理。",
      "委派不扩大权限或消耗算力授权。远端团队会收到 task 文本，仅发送完成任务所需且获准分享的内容；不能访问本机工具或未发送的文件。",
      "核验结果和 status；inputRequired 表示等待补充，应向用户确认后带原 taskId/contextId 继续该远端团队。错误、取消、达到限制均不等于完成，不自动重试可能已经产生副作用的任务。",
    ],
    parameters: z.toJSONSchema(parameters, { io: "input", target: "draft-07" }),
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate) {
      signal?.throwIfAborted();
      // R10：记录本次调用所属父任务自己的槽位对象；让出后要在继续推理前重新取得。
      const parentSlot = subAgentSlot.getStore();
      const { tasks } = parameters.parse(params);
      const results: SubAgentResult[] = tasks.map(task => ({ name: task.name, status: "running", result: "准备执行" }));
      const usage = emptyUsage();
      const content = () => [{ type: "text" as const, text: JSON.stringify({ tasks: results }) }];
      const update = () => { if (!signal?.aborted) onUpdate?.({ content: content(), details: {} }); };
      update();
      await Promise.all(tasks.map(async (task, index) => {
        const onProgress = (text: string) => { results[index]!.result = text; update(); };
        let slot: SubAgentSlot | undefined;
        try {
          slot = await acquireSubAgentSlot(signal);
          const output = await subAgentSlot.run(slot, async () => {
            const remote = task.team && getRemoteTeam(task.team);
            if ((task.taskId || task.contextId) && !remote) throw new Error("只有远端 A2A 团队支持 taskId/contextId");
            if (remote) return runRemoteTeam({ ...task, name: task.team!, signal, onProgress });
            if (task.team) return (await createTeamRunner({ ...modelOptions, cwd, tools: inheritedTools, canvas, name: task.team })).run(task.task, signal, onProgress);
            return runTask(task.name, task.task, signal, onProgress);
          });
          results[index] = { ...output.result, name: task.name };
          addUsage(usage, output.usage);
        } catch (error) {
          results[index] = { name: task.name, status: signal?.aborted ? "cancelled" : "error", result: error instanceof Error ? error.message : String(error) };
        } finally {
          if (slot) releaseSubAgentSlot(slot);
        }
        update();
      }));
      // R10：全部子任务结束、返回工具结果前，父任务重新排队取得自己的槽位；取消时保持已让出状态，由外层释放逻辑处理。
      if (parentSlot?.yielded) await reacquireSubAgentSlot(parentSlot, signal);
      return { content: content(), details: {}, usage };
    },
  };
  const inheritedTools = [...tools, subAgentTool];
  return subAgentTool;
}
