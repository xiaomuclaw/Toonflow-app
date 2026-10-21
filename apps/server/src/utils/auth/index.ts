import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { mkdir, readFile, writeAtomic } from "@toonflow/file";
import type { NextFunction, Request, Response } from "express";
import { error } from "@/lib/responseFormat";

type AuthCredentials = { username: string; passwordHash: string; createdAt: string; updatedAt: string };
export type Session = { username: string; createdAt: number; lastSeenAt: number };

const sessionCookieName = "toonflowSession";
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const loginWindowMs = 15 * 60 * 1000;
const maxLoginFailures = 5;
const pruneIntervalMs = 10 * 60 * 1000;
// 挂载点相对路径；登录、状态查询与健康检查本身不能要求已登录（健康检查只返回就绪状态，不含敏感信息）。
const publicPaths = new Set(["/auth/login", "/auth/status", "/health"]);

// ACT: 单进程内存会话，重启即失效；数据量固定为单账号，无需持久化会话。
const sessions = new Map<string, Session>();
const loginFailures = new Map<string, { failures: number; lastFailureAt: number }>();
let credentials: AuthCredentials | undefined;
let authRequired = false;
let lastPruneAt = 0;

export async function initializeAuth(dataDirectory: string) {
  if (authRequired) return;
  if (process.env.TOONFLOW_AUTH === "0") {
    console.warn("[认证] TOONFLOW_AUTH=0，管理员认证已关闭");
    return;
  }
  authRequired = true;
  const authPath = resolve(dataDirectory, "auth.json");
  const content = await readFile(authPath, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return undefined;
    throw err;
  });
  if (content !== undefined) {
    try {
      const parsed = JSON.parse(content) as Partial<AuthCredentials>;
      if (typeof parsed.username !== "string" || !parsed.username || typeof parsed.passwordHash !== "string" || !parsed.passwordHash) {
        throw new Error("缺少 username 或 passwordHash");
      }
      const now = new Date().toISOString();
      credentials = {
        username: parsed.username,
        passwordHash: parsed.passwordHash,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : now,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now,
      };
      console.log("[认证] 已加载管理员账号");
    } catch (err) {
      // ACT: 不覆盖损坏的 auth.json，也不回退到环境变量，保持未初始化并由登录接口明确报错。
      console.error("[认证] auth.json 读取失败，管理员未初始化：", err instanceof Error ? err.message : err);
    }
    return;
  }
  const password = process.env.TOONFLOW_ADMIN_PASSWORD;
  if (!password) {
    console.warn("[认证] 未找到 auth.json，且未设置 TOONFLOW_ADMIN_PASSWORD；管理员未初始化，登录接口将拒绝登录");
    return;
  }
  const username = process.env.TOONFLOW_ADMIN_USERNAME?.trim() || "admin";
  const now = new Date().toISOString();
  const created: AuthCredentials = { username, passwordHash: await Bun.password.hash(password), createdAt: now, updatedAt: now };
  await mkdir(dataDirectory, { recursive: true });
  await writeAtomic(authPath, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600, durable: true });
  credentials = created;
  console.log(`[认证] 已根据环境变量初始化管理员账号：${username}`);
}

export function getAuthStatus() {
  return { authRequired, initialized: credentials !== undefined };
}

export async function verifyCredentials(username: string, password: string) {
  if (!credentials) return false;
  // ACT: 用户名不匹配也执行一次哈希校验，避免用响应时间区分账号是否存在。
  const verified = await Bun.password.verify(password, credentials.passwordHash).catch(() => false);
  return verified && username === credentials.username;
}

export function createSession(username: string) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  sessions.set(token, { username, createdAt: now, lastSeenAt: now });
  return token;
}

export function getSession(token: string | undefined) {
  if (!token) return undefined;
  const session = sessions.get(token);
  if (!session) return undefined;
  const now = Date.now();
  if (now - session.lastSeenAt > sessionTtlMs) {
    sessions.delete(token);
    return undefined;
  }
  session.lastSeenAt = now;
  if (now - lastPruneAt > pruneIntervalMs) pruneSessions();
  return session;
}

export function destroySession(token: string | undefined) {
  if (token) sessions.delete(token);
}

export function pruneSessions() {
  const now = Date.now();
  lastPruneAt = now;
  for (const [token, session] of sessions) {
    if (now - session.lastSeenAt > sessionTtlMs) sessions.delete(token);
  }
  for (const [key, record] of loginFailures) {
    if (now - record.lastFailureAt > loginWindowMs) loginFailures.delete(key);
  }
}

export function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function getSessionToken(req: Request) {
  return parseCookies(req.headers.cookie)[sessionCookieName];
}

function secureSuffix() {
  // ACT: 公网 HTTPS 必须显式设置 TOONFLOW_COOKIE_SECURE=1；回环验收才允许省略。
  return process.env.TOONFLOW_COOKIE_SECURE === "1" ? "; Secure" : "";
}

export function serializeSessionCookie(token: string) {
  return `${sessionCookieName}=${token}; HttpOnly; SameSite=Lax; Path=/${secureSuffix()}; Max-Age=${Math.floor(sessionTtlMs / 1000)}`;
}

export function serializeClearedSessionCookie() {
  return `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/${secureSuffix()}; Max-Age=0`;
}

function rateLimitKey(ip: string, username: string) {
  return `${ip}\0${username}`;
}

export function checkLoginRateLimit(ip: string, username: string) {
  const key = rateLimitKey(ip, username);
  const record = loginFailures.get(key);
  if (!record) return { blocked: false, retryAfterSeconds: 0 };
  const elapsed = Date.now() - record.lastFailureAt;
  if (elapsed > loginWindowMs) {
    loginFailures.delete(key);
    return { blocked: false, retryAfterSeconds: 0 };
  }
  if (record.failures < maxLoginFailures) return { blocked: false, retryAfterSeconds: 0 };
  return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((loginWindowMs - elapsed) / 1000)) };
}

export function recordLoginFailure(ip: string, username: string) {
  const key = rateLimitKey(ip, username);
  const now = Date.now();
  const record = loginFailures.get(key);
  if (!record || now - record.lastFailureAt > loginWindowMs) loginFailures.set(key, { failures: 1, lastFailureAt: now });
  else {
    record.failures += 1;
    record.lastFailureAt = now;
  }
}

export function clearLoginFailures(ip: string, username: string) {
  loginFailures.delete(rateLimitKey(ip, username));
}

export function isAuthenticatedRequest(req: Request) {
  return getSession(getSessionToken(req)) !== undefined;
}

export function createAuthGate() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!authRequired) return next();
    // ACT: 挂载在 /api 下时 req.path 已去掉挂载前缀；白名单按小写比较，避免大小写差异把登录页也挡在 401 外。
    const path = req.path.replace(/\/+$/, "").toLowerCase() || "/";
    if (publicPaths.has(path)) return next();
    if (getSession(getSessionToken(req))) return next();
    res.status(401).json(error("未登录或登录已过期", null, 401));
  };
}
