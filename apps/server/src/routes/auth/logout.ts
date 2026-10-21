import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { destroySession, getSessionToken, serializeClearedSessionCookie } from "@/utils/auth";

const router = Router();

export default router.post("/", (req, res) => {
  destroySession(getSessionToken(req));
  res.set("Cache-Control", "no-store");
  res.set("Set-Cookie", serializeClearedSessionCookie());
  res.json(success(null, "已退出登录"));
});
