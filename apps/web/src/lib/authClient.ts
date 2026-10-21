import axios, { type AxiosInstance } from "axios";
import { ElMessage } from "element-plus";
import "element-plus/es/components/message/style/css";

// F07：登录过期只提示与引导重新登录，保留草稿、任务关联与待回写结果；绝不强制刷新页面丢内容。
let sessionExpired = false;
let banner: HTMLElement | undefined;
let bannerMessage: HTMLElement | undefined;
const sessionBarId = "toonflowSessionExpiredBar";

function removeBanner() {
  banner?.remove();
  banner = undefined;
  bannerMessage = undefined;
}

function setBannerMessage(text: string) {
  if (bannerMessage) bannerMessage.textContent = text;
}

function createButton(label: string, primary: boolean, onClick: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = [
    "padding: 3px 10px", "border-radius: 4px", "font: inherit", "font-size: 12px", "cursor: pointer",
    primary
      ? "border: 1px solid var(--el-color-primary, #409eff); background: var(--el-color-primary, #409eff); color: #fff"
      : "border: 1px solid var(--el-border-color, #dcdfe6); background: var(--el-bg-color-overlay, #fff); color: var(--el-text-color-primary, #303133)",
  ].join(";");
  button.onclick = onClick;
  return button;
}

// ACT: 登录过期状态条不阻塞页面：草稿与任务留在原地，用户可在新窗口完成登录后继续当前页面。
function showBanner() {
  if (banner || typeof document === "undefined" || !document.body) return;
  const bar = document.createElement("div");
  bar.id = sessionBarId;
  bar.setAttribute("role", "alert");
  bar.style.cssText = [
    "position: fixed", "top: 0", "left: 0", "right: 0", "z-index: 3000",
    "display: flex", "align-items: center", "gap: 10px", "padding: 8px 12px",
    "background: var(--el-color-warning-light-9, #fdf6ec)", "border-bottom: 1px solid var(--el-color-warning-light-5, #f5dab1)",
    "color: var(--el-text-color-primary, #303133)", "font-size: 13px", "line-height: 1.4",
  ].join(";");
  const text = document.createElement("span");
  text.style.cssText = "flex: 1; min-width: 0";
  text.textContent = "登录已过期：未保存的草稿、任务关联与待回写结果都已保留。请重新登录，登录后只会继续查询，不会重放生成。";
  bannerMessage = text;
  bar.append(text, createButton("重新登录", true, openLoginWindow), createButton("已在其他窗口登录，继续", false, () => void checkSessionRestored()));
  document.body.appendChild(bar);
  banner = bar;
}

function openLoginWindow() {
  const popup = window.open("/login?resume=1", "toonflowLogin");
  if (!popup) setBannerMessage("浏览器阻止了新窗口，请手动打开登录地址；登录完成后点击“已在其他窗口登录，继续”。");
}

async function checkSessionRestored() {
  setBannerMessage("正在确认登录状态…");
  try {
    const response = await fetch("/api/auth/status", { headers: { "Accept-Language": navigator.language } });
    const payload = await response.json().catch(() => undefined) as { code?: number; data?: { authRequired?: boolean; authenticated?: boolean } } | undefined;
    if (payload?.code === 200 && (payload.data?.authRequired !== true || payload.data.authenticated === true)) {
      markSessionRestored();
      return;
    }
    setBannerMessage("仍未登录：请在新窗口完成登录后再次确认；本页面的草稿与任务关联会继续保留。");
  } catch {
    setBannerMessage("无法连接服务器确认登录状态，请检查网络后重试；本页面的草稿与任务关联会继续保留。");
  }
}

/** 任一客户端遇到 401 时调用：只登记一次登录过期，不重放任何已发出的生成/删除请求。 */
export function noteUnauthorized() {
  if (sessionExpired) return;
  sessionExpired = true;
  ElMessage.warning({ message: "登录已过期，请重新登录；未保存的草稿与任务关联会保留，本页面不会刷新", grouping: true });
  showBanner();
  window.dispatchEvent(new CustomEvent("toonflow:session-expired"));
}

export function isSessionExpired() {
  return sessionExpired;
}

/** 重新认证成功：清除过期状态并按只恢复查询的语义通知订阅者（不重放生成）。 */
export function markSessionRestored() {
  if (!sessionExpired && !banner) return;
  sessionExpired = false;
  removeBanner();
  ElMessage.success({ message: "已重新登录，正在继续查询任务", grouping: true });
  window.dispatchEvent(new CustomEvent("toonflow:auth-restored"));
}

/** 从 Axios 错误、Response 或状态码判断是否为 401，并统一登记登录过期。 */
export function reportUnauthorized(reason: unknown): boolean {
  const status = axios.isAxiosError(reason)
    ? reason.response?.status
    : reason instanceof Response ? reason.status
      : typeof (reason as { status?: unknown } | null)?.status === "number" ? (reason as { status: number }).status
        : undefined;
  if (status !== 401) return false;
  noteUnauthorized();
  return true;
}

function onResponseRejected(reason: unknown) {
  reportUnauthorized(reason);
  return Promise.reject(reason);
}

export function attachAuthInterceptor(instance: AxiosInstance) {
  instance.interceptors.response.use(undefined, onResponseRejected);
}

let listenersRegistered = false;

function registerListeners() {
  if (listenersRegistered || typeof window === "undefined") return;
  listenersRegistered = true;
  // 任意模块（含节点 UMD）可用该事件上报 401，无需依赖本模块的实例引用。
  window.addEventListener("toonflow:unauthorized", () => noteUnauthorized());
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    if ((event.data as { type?: string } | null)?.type === "toonflow:login-complete") markSessionRestored();
  });
}

let registered = false;

export function registerAuthHandling() {
  registerListeners();
  if (registered) return;
  registered = true;
  attachAuthInterceptor(axios);
}

export async function authFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetch(input, init);
  if (response.status === 401) noteUnauthorized();
  return response;
}

registerListeners();
