import { inject, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { NodeMediaValue } from "./values";
import { useNodePreviewReady } from "./useNodePreviewReady";

/** 显式声明来源的文件类型；缺省不发送，未登记文件不会被自动清理。 */
export type FileKind = "generatedText" | "generatedImage" | "generatedVideo" | "original";

export interface WorkspaceFiles {
  list(path?: string): Promise<{ directory: string; entries: { name: string; path: string; type: "file" | "directory" }[] }>;
  read(path: string): Promise<ArrayBuffer>;
  acquireUrl?(path: string, mimeType: string): { url: Promise<string>; release(): void };
  readText(path: string): Promise<string>;
  readTextSnapshot(path: string): Promise<{ text: string; revision: string; encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" }>;
  writeTextSnapshot(path: string, text: string, snapshot: { revision: string; encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" }, kind?: FileKind): Promise<string>;
  readJson<T = unknown>(path: string): Promise<T>;
  write(path: string, content: string | Blob | ArrayBuffer, exclusive?: boolean, signal?: AbortSignal, kind?: FileKind): Promise<void>;
  writeJson(path: string, data: unknown, exclusive?: boolean): Promise<void>;
  rename(path: string, target: string): Promise<void>;
  remove(path: string, recursive?: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** T14：登记编辑占用（保护编辑中/待回写文件不被清理），返回释放函数；宿主未提供该能力时省略。 */
  holdEditing?(path: string, options?: { onError?: (message: string) => void }): () => void;
  /** T11：文件可用性公共查询（清理记录）；宿主未提供该能力时省略，调用方需容忍缺省。 */
  queryAvailability?(path: string, signal?: AbortSignal): Promise<{ known: boolean; state: "available" | "cleaned" | "missing"; cleanedAt?: string }>;
}

function getNodeDirectory(nodeId: string) {
  if (!nodeId || /[\\/]/.test(nodeId) || nodeId === "." || nodeId === "..") throw new Error("节点 ID 不能作为文件夹名称");
  return `assets/${nodeId}`;
}

// ACT: 桌面端工作区可以是任意目录，工作区文件读取要求页面的 x-toonflow-workspace 头；媒体直链无法携带该头，
// 因此桌面端继续使用 Blob 预览，独立服务器部署（目录固定在 data/workspaces 内）才走同源直链。
function isDesktopApp() {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("desktop") === "1";
}

export async function uploadNodeFile(files: WorkspaceFiles, nodeId: string, file: File) {
  const directory = getNodeDirectory(nodeId);
  for (const path of ["assets", directory]) {
    await files.mkdir(path).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error.response?.data?.data?.code !== "EEXIST") throw error;
    });
  }
  const extension = file.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? "";
  const path = `${directory}/${crypto.randomUUID()}${extension}`;
  await files.write(path, file, true, undefined, "original");
  return path;
}

export function useNodeFiles() {
  const createFiles = inject<(() => WorkspaceFiles) | undefined>("workspaceFiles", undefined);
  const retainNodeFiles = inject("retainNodeFiles", false);
  const getWorkspaceDirectory = inject<(() => string) | undefined>("workspaceDirectory", undefined);

  function getWorkspaceFiles() {
    if (!createFiles) throw new Error("当前画布未提供工作区文件能力");
    return createFiles();
  }

  async function resolveDirectory() {
    try {
      const directory = getWorkspaceDirectory?.();
      if (directory) return directory;
    } catch {
      // 宿主未选择工作目录时回退到文件接口返回的规范目录。
    }
    return (await getWorkspaceFiles().list()).directory;
  }

  function uploadFile(nodeId: string, file: File) {
    // ACT: 多步上传共用开始时的工作区，避免切换项目后写入另一目录。
    return uploadNodeFile(getWorkspaceFiles(), nodeId, file);
  }

  async function removeNodeFiles(nodeId: string) {
    const directory = getNodeDirectory(nodeId);
    // ACT: 支持撤销的画布保留节点素材，不随节点删除物理文件。
    if (retainNodeFiles) return;
    await getWorkspaceFiles().remove(directory, true).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error.response?.data?.data?.code !== "ENOENT") throw error;
    });
  }

  function useFileUrl(file: MaybeRefOrGetter<NodeMediaValue | undefined>, onError: (error: unknown) => void, stream = false) {
    const fileUrl = ref("");
    const previewReady = useNodePreviewReady();
    watch([() => toValue(file), previewReady], async ([value, ready], _previous, onCleanup) => {
      let cancelled = false;
      let url = "";
      let shared: ReturnType<NonNullable<WorkspaceFiles["acquireUrl"]>> | undefined;
      onCleanup(() => {
        cancelled = true;
        shared?.release();
        if (url) URL.revokeObjectURL(url);
      });
      fileUrl.value = "";
      if (!value || !ready) return;
      try {
        if (stream && !isDesktopApp()) {
          // ACT: 大体积媒体走同源直链，由浏览器按 Range 流式读取；不整段下载，也不占用内存配额（R15）。
          const directory = await resolveDirectory();
          if (!cancelled) fileUrl.value = `/api/workspaces/files/read?directory=${encodeURIComponent(directory)}&path=${encodeURIComponent(value.url)}`;
          return;
        }
        const files = getWorkspaceFiles();
        shared = files.acquireUrl?.(value.url, value.mimeType);
        if (shared) {
          const sharedUrl = await shared.url;
          if (!cancelled) fileUrl.value = sharedUrl;
          return;
        }
        const content = await files.read(value.url);
        if (cancelled) return;
        fileUrl.value = url = URL.createObjectURL(new Blob([content], { type: value.mimeType }));
      } catch (error) {
        if (!cancelled) onError(error);
      }
    }, { immediate: true });
    return fileUrl;
  }

  return { getWorkspaceFiles, uploadFile, removeNodeFiles, useFileUrl };
}
