import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { getAuthStatus, getSession, getSessionToken } from "@/utils/auth";

const router = Router();

export default router.get("/", (req, res) => {
  const session = getSession(getSessionToken(req));
  res.set("Cache-Control", "no-store");
  res.json(success({
    authenticated: session !== undefined,
    ...(session ? { username: session.username } : {}),
    ...getAuthStatus(),
  }));
});
