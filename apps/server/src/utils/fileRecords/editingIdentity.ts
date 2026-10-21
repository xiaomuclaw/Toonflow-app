import { createHash } from "node:crypto";
import type { Request } from "express";
import { getSession, getSessionToken } from "@/utils/auth";
import { getDesktopRuntime } from "@/utils/desktop";
import { isLocalWorkspaceRequest } from "@/utils/workspace";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { editingDefaultPageId } from "@/utils/fileRecords/editing";

/**
 * 编辑占用身份解析（HTTP 侧，供清理/编辑占用路由共用）：
 * 登录身份摘要 = 已登录页面会话的 token 摘要（不保存原始 token）；桌面/本机客户端为单一本地身份。
 * 占用身份 = 登录身份摘要 + 页面实例（pageId）+ 目录 + 路径；任意页面只能续租/释放自己的占用。
 */
export function editingLoginDigestOf(req: Request): string | undefined {
  const token = getSessionToken(req);
  if (token && getSession(token)) return `session:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  if (isLocalWorkspaceRequest(req) || !!getDesktopRuntime(req)) return "local";
  return undefined;
}

export function requireEditingLoginDigest(req: Request): string {
  const digest = editingLoginDigestOf(req);
  if (!digest) throw Object.assign(new Error("请先登录后再登记编辑占用"), { status: 401 });
  return digest;
}

/** 页面实例身份：前端生成并持久于 sessionStorage 的 UUID；缺省按兼容单页面身份处理（旧客户端）。 */
export function editingPageIdOf(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 128) : editingDefaultPageId;
}

/** 规范工作区内路径（允许父目录暂缺）；解析失败向调用方传播，不静默跳过。 */
export async function resolveEditingPaths(directory: string, paths: unknown): Promise<string[]> {
  if (!Array.isArray(paths)) return [];
  const resolved: string[] = [];
  for (const path of paths) {
    resolved.push((await resolveWorkspacePath(directory, path as string, true)).path);
  }
  return resolved;
}
