import { createHash } from "node:crypto";
import { relative } from "node:path";
import { readFile, stat } from "@toonflow/file";
import { getFileRecordsByPath, resolveRelocatedFilePath } from "@/utils/fileRecords";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import type { MediaTaskOutput, MediaTaskRecord } from "./store";

/** 输出可用性（契约 v3 §B/§E）：available 可播放/下载；cleaned 已按清理规则删除；missing 文件缺失且无清理依据。 */
export type MediaTaskOutputState = "available" | "cleaned" | "missing";

export type MediaTaskOutputAvailability = {
  state: MediaTaskOutputState;
  /** 清理完成时间（仅 cleaned 时给出；数据来源为 C 的归属记录）。 */
  cleanedAt?: string;
  /** 原路径已被可追踪改名时的最新工作区相对路径（仍可用）。 */
  resolvedPath?: string;
};

/** 最近的清理完成时间：归属记录里可能同时存在多条（多归属），取最新一次。 */
function latestCleanedAt(records: { cleanedAt?: string }[]) {
  return records.map(record => record.cleanedAt).filter((value): value is string => typeof value === "string" && !!value)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)).pop();
}

function outputAbsolutePath(directory: string, path: string) {
  return resolveWorkspacePath(directory, path).then(resolved => resolved.path);
}

/**
 * 单个输出的可用性（T15）：按「当前实际定位（resolvedPath 优先）+ 可靠归属」判断——
 * 1) 当前定位存在普通文件即 available（改名后持久更新的 resolvedPath 就是权威定位）；
 * 2) 历史 path 只有在归属记录明确引用本任务（refs 含 task:<taskId>）时才可认回；
 *    该路径被别的文件复用时（归属不含本任务）不得返回 available，否则会把新文件串成旧任务的成片；
 * 3) 两个定位都不存在时，再按 C 的可追踪改名解析最新定位（日志同样带任务身份约束）；
 * 4) 仍缺失时按归属记录区分「已清理」（有 cleanedAt）与「外部缺失」（missing，不伪装成已清理）。
 * 路径无效或判定失败按 missing 处理，不谎报可用。
 */
export async function mediaTaskOutputAvailability(task: MediaTaskRecord, output: MediaTaskOutput): Promise<MediaTaskOutputAvailability> {
  const currentPath = typeof output.resolvedPath === "string" && output.resolvedPath ? output.resolvedPath : output.path;
  const historyPath = output.path;
  const records: { cleanedAt?: string }[] = [];
  if (typeof currentPath === "string" && currentPath) {
    const absolute = await outputAbsolutePath(task.directory, currentPath).catch(() => undefined);
    if (absolute) {
      const info = await stat(absolute).catch(() => null);
      if (info?.isFile()) {
        return currentPath === historyPath ? { state: "available" } : { state: "available", resolvedPath: currentPath };
      }
      records.push(...await getFileRecordsByPath(absolute).catch(() => []));
    }
  }
  // 历史路径只作历史（T15）：必须有本任务的可靠归属引用才认回，复用该路径的新文件不属于本任务。
  if (typeof historyPath === "string" && historyPath && historyPath !== currentPath) {
    const absolute = await outputAbsolutePath(task.directory, historyPath).catch(() => undefined);
    if (absolute) {
      const pathRecords = await getFileRecordsByPath(absolute).catch(() => []);
      records.push(...pathRecords);
      const ownedByTask = pathRecords.some(record => Array.isArray(record.refs) && record.refs.includes(`task:${task.taskId}`));
      if (ownedByTask) {
        const info = await stat(absolute).catch(() => null);
        if (info?.isFile()) return { state: "available", resolvedPath: historyPath };
      }
    }
  }
  for (const candidate of [...new Set([currentPath, historyPath].filter((value): value is string => typeof value === "string" && !!value))]) {
    // 定位日志解析必须按任务身份约束（refs = task:<taskId>）：旧路径被别的文件复用或日志淘汰时
    // 返回 undefined，而不是把旧任务串到新文件（契约 v4 §K）。
    const relocated = await resolveRelocatedFilePath(task.directory, candidate, { refs: [`task:${task.taskId}`] }).catch(() => undefined);
    if (!relocated) continue;
    const movedInfo = await stat(relocated.path).catch(() => null);
    if (movedInfo?.isFile()) {
      return { state: "available", resolvedPath: relative(task.directory, relocated.path).replaceAll("\\", "/") };
    }
  }
  const cleanedAt = latestCleanedAt(records);
  return cleanedAt ? { state: "cleaned", cleanedAt } : { state: "missing" };
}

export type MediaTaskOutputSummary = {
  /** 任务级聚合：有任一可用项 → available；否则优先表达已清理，再退到缺失。 */
  outputState?: MediaTaskOutputState;
  /** 任务级最近清理时间。 */
  cleanedAt?: string;
};

/** 任务级聚合规则（纯函数，摘要与调度共用，避免重复判定）。 */
export function aggregateMediaTaskOutputState(states: MediaTaskOutputAvailability[]): MediaTaskOutputSummary {
  if (!states.length) return {};
  const available = states.filter(state => state.state === "available").length;
  const cleanedAt = latestCleanedAt(states);
  if (available > 0) return { outputState: "available", ...(cleanedAt ? { cleanedAt } : {}) };
  if (states.some(state => state.state === "cleaned")) return { outputState: "cleaned", ...(cleanedAt ? { cleanedAt } : {}) };
  return { outputState: "missing" };
}

/** 输出文件当前的真实内容摘要；不存在、非普通文件或路径无效时返回 undefined（用于真实内容认回）。 */
export async function mediaOutputSha256(directory: string, path: string) {
  try {
    const { path: absolute } = await resolveWorkspacePath(directory, path);
    const info = await stat(absolute);
    if (!info.isFile()) return undefined;
    const bytes = await readFile(absolute);
    return createHash("sha256").update(bytes).digest("hex");
  } catch {
    return undefined;
  }
}
