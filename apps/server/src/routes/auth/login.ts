import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import {
  checkLoginRateLimit,
  clearLoginFailures,
  createSession,
  getAuthStatus,
  recordLoginFailure,
  serializeSessionCookie,
  verifyCredentials,
} from "@/utils/auth";

const router = Router();

export default router.post("/", validateFields({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
}), async (req, res) => {
  const username = (req.body.username as string).trim();
  const password = req.body.password as string;
  if (!getAuthStatus().initialized) return res.status(503).json(error("管理员未初始化", null, 503));
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  const rateLimit = checkLoginRateLimit(ip, username);
  if (rateLimit.blocked) {
    res.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return res.status(429).json(error(`登录失败次数过多，请 ${Math.ceil(rateLimit.retryAfterSeconds / 60)} 分钟后再试`, null, 429));
  }
  // ACT: 账号与密码错误统一文案，不向未认证请求区分账号是否存在。
  if (!(await verifyCredentials(username, password))) {
    recordLoginFailure(ip, username);
    return res.status(401).json(error("账号或密码错误", null, 401));
  }
  clearLoginFailures(ip, username);
  res.set("Cache-Control", "no-store");
  res.set("Set-Cookie", serializeSessionCookie(createSession(username)));
  res.json(success({ username }));
});
