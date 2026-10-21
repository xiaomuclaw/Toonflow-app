<template>
  <panel class="canvasMenuPanel" position="top-left">
    <el-card class="canvasMenu" shadow="never" :bodyStyle="{ padding: '5px 10px' }">
      <div class="menuContent">
        <el-input v-model="projectNameDraft" class="workspaceNameInput" :style="{ '--workspaceName': JSON.stringify(projectNameDraft || ' ') }" size="small" :title="directory" :disabled="!workspaceStore.project" aria-label="项目名称"
          @keydown.stop @keydown.enter="saveProjectName" @keydown.esc.prevent="projectNameDraft = workspaceName" @blur="saveProjectName" />
        <el-divider direction="vertical" />
        <el-popover v-model:visible="canvasListVisible" trigger="click" placement="bottom-start" :width="214" :showArrow="false" :disabled="!directory">
          <template #reference>
            <el-button class="canvasTrigger" text :loading="busy" :disabled="busy || !directory" aria-label="切换画布" :aria-expanded="canvasListVisible">
              <span>{{ activeCanvasName }}</span><icon-chevron-down :size="14" />
            </el-button>
          </template>
          <div class="canvasPicker" @keydown.esc="canvasListVisible = false">
            <div class="pickerHeader">
              <span>画布</span>
              <el-button class="iconButton" text :icon="IconPlus" :disabled="busy || editingId !== null" aria-label="新增画布" @click="handleAddCanvas" />
            </div>
            <el-scrollbar maxHeight="280px">
              <div v-for="canvas in canvases" :key="canvas.id" class="canvasItem">
                <el-input v-if="editingId === canvas.id" ref="nameInputs" v-model="canvasName" class="nameEditor" size="small" :disabled="busy" :maxlength="120" :aria-label="newCanvasId === canvas.id ? '新画布名称' : '画布名称'" @keydown.stop @keydown.enter="saveCanvas" @blur="saveCanvas" />
                <template v-else>
                  <button class="canvasChoice" type="button" :disabled="busy || editingId !== null" :aria-pressed="activeCanvasId === canvas.id" :title="canvas.name" @click="handleSwitchCanvas(canvas.id)">{{ canvas.name }}</button>
                  <div class="itemAction">
                    <icon-check v-if="activeCanvasId === canvas.id" class="selectedIcon" :size="18" aria-hidden="true" />
                    <el-button class="iconButton renameButton" text :icon="IconEdit" :disabled="busy || editingId !== null" :aria-label="`编辑 ${canvas.name}`" title="编辑" @click="editCanvas(canvas)" />
                    <el-button class="iconButton deleteButton" text type="danger" :icon="IconTrash" :disabled="busy || editingId !== null" :aria-label="`删除 ${canvas.name}`" title="删除画布" @click="removeCanvas(canvas)" />
                  </div>
                </template>
              </div>
            </el-scrollbar>
            <el-text v-if="renameError" type="danger" role="alert">{{ renameError }}</el-text>
          </div>
        </el-popover>
      </div>
    </el-card>
    <div class="menuExtension"><slot /></div>
  </panel>
</template>

<script setup lang="ts">
import axios from "axios";
import { translate } from "@toonflow/i18n/vue";
import { computed, inject, nextTick, ref, shallowRef, watch, type ShallowRef } from "vue";
import { Panel, useVueFlow, type FlowExportObject } from "@vue-flow/core";
import { ElMessage, ElMessageBox, type InputInstance } from "element-plus";
import { IconEdit, IconCheck, IconChevronDown, IconPlus, IconTrash } from "@tabler/icons-vue";
import { useWorkspaceStore } from "@/stores/workspace";
import { reportUnauthorized } from "@/lib/authClient";
import useWorkspaceFiles, { type TextSnapshot } from "@/lib/workspaceFiles";
import { getCanvasAssetDirectories, isCanvasFile } from "@/pages/workspace/canvasFile";

const props = defineProps<{
  directory?: string;
  initialCanvasId?: string;
  activateCanvas?: (id: string, signal?: AbortSignal) => Promise<void>;
  flushSave: (action?: () => Promise<void>) => Promise<void>;
}>();
const workspaceStore = useWorkspaceStore();
const workspaceName = computed(() => workspaceStore.project?.name || "未命名工作区");
const projectNameDraft = ref("");
watch([() => workspaceStore.project?.directory, workspaceName], () => {
  projectNameDraft.value = workspaceName.value;
}, { immediate: true });

function saveProjectName(event: Event) {
  if (event instanceof KeyboardEvent && event.isComposing) return;
  const project = workspaceStore.project;
  if (project) workspaceStore.renameProject(project.directory, projectNameDraft.value);
  projectNameDraft.value = workspaceName.value;
}

type Canvas = { id: string; name: string; flow?: Pick<FlowExportObject, "nodes" | "edges" | "viewport"> };
const canvases = inject<ShallowRef<Canvas[]>>("canvasList", shallowRef<Canvas[]>([]));
const getRetainedNodes = inject<(id: string) => { id: string; data?: unknown }[]>("canvasAssetNodes", () => []);
const performFileAction = inject<(directory: string, action: "copy" | "rename" | "delete", path: string, target?: string) => Promise<void>>("performWorkspaceFileAction");
const boundCanvas = shallowRef<Canvas>();
const activeCanvasId = defineModel<string>("canvasId", { default: "" });
watch(canvases, () => {
  if (boundCanvas.value) activeCanvasId.value = canvases.value.includes(boundCanvas.value) ? boundCanvas.value.id : "";
}, { flush: "sync" });
const canvasListVisible = ref(false);
const activeCanvasName = computed(() => canvases.value.find(canvas => canvas.id === activeCanvasId.value)?.name || translate("选择画布"));
const busy = ref(false);
const loadError = ref("");
const editingId = ref<string | null>(null);
const newCanvasId = ref<string | null>(null);
const nameInputs = ref<InputInstance[]>([]);
const canvasName = ref("");
const renameError = ref("");
const { toObject, setNodes, setEdges, setViewport } = useVueFlow();
// F06：读取画布内容时同时记录该内容的版本标识；首次保存必须使用读取时的版本。
const loadedRevisions = new Map<string, { directory: string; revision: string; encoding: TextSnapshot["encoding"] }>();

watch(() => props.directory, async (directory, _previous, onCleanup) => {
  let cancelled = false;
  onCleanup(() => { cancelled = true; });
  busy.value = true;
  loadError.value = "";
  boundCanvas.value = undefined;
  activeCanvasId.value = "";
  try {
    if (props.initialCanvasId === undefined) canvases.value = [];
    newCanvasId.value = null;
    editingId.value = null;
    renameError.value = "";
    if (!directory) return;
    if (props.initialCanvasId === "") return;
    if (props.initialCanvasId) {
      await applyCanvas(props.initialCanvasId, directory);
      return;
    }
    let loaded = await listCanvases(directory);
    if (cancelled) return;
    if (!loaded.length) {
      try {
        loaded = [await createCanvasFile(directory, "画布1")];
      } catch (err) {
        if (!axios.isAxiosError<{ data?: { code?: string } }>(err) || err.response?.status !== 409 || err.response.data.data?.code !== "EEXIST") throw err;
        // 同时打开工作区时，读取另一请求刚创建的默认画布，不覆盖同名文件。
        const refreshed = await listCanvases(directory);
        // 画布1.json 若被其他 JSON 占用，则使用下一个空闲名称，保留原文件。
        loaded = refreshed.length ? refreshed : [await createCanvasFile(directory)];
      }
    }
    if (cancelled) return;
    canvases.value = loaded;
    if (canvases.value[0]) await applyCanvas(canvases.value[0].id, directory);
  } catch (err) {
    if (!cancelled) {
      loadError.value = errorMessage(err, "读取画布失败");
      if (!props.initialCanvasId) ElMessage.error(loadError.value);
    }
  } finally {
    if (!cancelled) busy.value = false;
  }
}, { immediate: true });

function errorMessage(err: unknown, fallback: string) {
  // F07：工作区文件接口的 401 统一上报登录过期状态条，不在此处刷新页面。
  reportUnauthorized(err);
  return axios.isAxiosError<{ message?: string }>(err) ? err.response?.data.message || fallback : err instanceof Error ? err.message : fallback;
}

function getCanvases() {
  return canvases.value.map(({ id, name }) => ({ id, name }));
}

function getCanvasDirectory(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!props.directory) throw new Error("请先选择工作目录");
  if (busy.value || editingId.value !== null) throw new Error("画布正在加载或编辑，请稍后重试");
  return props.directory;
}

function checkCanvasDirectory(directory: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (props.directory !== directory) throw new Error("工作目录已切换，本次画布操作已停止");
}

async function readCanvasFlow(canvas: Canvas, directory: string, signal?: AbortSignal) {
  // F06：内容与版本必须来自同一次读取；首次保存使用这里的 revision，不能用保存时的最新版本为旧内容背书。
  const snapshot = await useWorkspaceFiles(directory).readTextSnapshot(canvas.id, { signal });
  checkCanvasDirectory(directory, signal);
  let data: Partial<NonNullable<Canvas["flow"]>> & { toonflowCanvas?: boolean } | null;
  try {
    data = JSON.parse(snapshot.text) as typeof data;
  } catch {
    throw new Error("画布文件格式无效");
  }
  if (data?.toonflowCanvas !== true || !Array.isArray(data.nodes) || !Array.isArray(data.edges) || !data.viewport
    || ![data.viewport.x, data.viewport.y, data.viewport.zoom].every(Number.isFinite) || data.viewport.zoom <= 0) throw new Error("画布文件格式无效");
  // 旧画布可能保存了临时导出进度，重新打开时任务已不存在。
  for (const node of data.nodes) if (node.type === "remote-videoNode" && node.data) delete node.data.exportProgress;
  loadedRevisions.set(canvas.id, { directory, revision: snapshot.revision, encoding: snapshot.encoding });
  // R07：同一次读取的 revision 随内容一起返回，冲突重载后仍以这次读取的版本参与冲突检测。
  return { nodes: data.nodes, edges: data.edges, viewport: data.viewport, revision: snapshot.revision, encoding: snapshot.encoding };
}

/**
 * 取走该画布读取内容时记录的版本标识；只能由首次保存消费一次，读取失败不得退回普通覆盖写。
 */
function takeCanvasRevision(directory: string, fileName: string) {
  const record = loadedRevisions.get(fileName);
  if (!record) return undefined;
  loadedRevisions.delete(fileName);
  if (record.directory !== directory) return undefined;
  return { revision: record.revision, encoding: record.encoding };
}

/** 写入失败时把读取时的版本放回：重试仍以读取内容时的版本参与冲突检测，不会改读最新版本为旧内容背书。 */
function rememberCanvasRevision(fileName: string, record: { directory: string; revision: string; encoding: TextSnapshot["encoding"] }) {
  loadedRevisions.set(fileName, record);
}

/** 冲突处理等场景明确放弃已记录的读取版本，由下一次保存重新读取磁盘当前版本。 */
function forgetCanvasRevision(fileName: string) {
  loadedRevisions.delete(fileName);
}

async function applyCanvas(canvasId: string, directory: string, signal?: AbortSignal) {
  checkCanvasDirectory(directory, signal);
  const nextCanvas = canvases.value.find(canvas => canvas.id === canvasId);
  const currentCanvas = canvases.value.find(canvas => canvas.id === activeCanvasId.value);
  if (!nextCanvas) throw new Error("画布不存在，请重新获取画布列表");
  if (nextCanvas === currentCanvas) return;
  if (currentCanvas && props.activateCanvas) {
    await props.activateCanvas(canvasId, signal);
    checkCanvasDirectory(directory, signal);
    return;
  }
  if (!nextCanvas.flow) nextCanvas.flow = await readCanvasFlow(nextCanvas, directory, signal);
  await props.flushSave();
  checkCanvasDirectory(directory, signal);
  if (currentCanvas) currentCanvas.flow = toObject();
  // 应用画布数据时暂时清空文件名，避免初始化触发自动保存。
  activeCanvasId.value = "";
  setNodes(nextCanvas.flow.nodes);
  // 命中宽度由画布统一配置，不使用旧文件中的覆盖值。
  setEdges(nextCanvas.flow.edges.map(({ interactionWidth, ...edge }) => edge));
  await setViewport(nextCanvas.flow.viewport);
  await nextTick();
  checkCanvasDirectory(directory);
  boundCanvas.value = nextCanvas;
  activeCanvasId.value = nextCanvas.id;
  signal?.throwIfAborted();
}

// 冲突处理：放弃本窗口内容，重新载入磁盘上其他窗口保存的版本。
// R07：返回与内容同源的 revision；调用方清除冲突提示时不得清掉它，下一次保存仍按该版本检测冲突。
async function reloadCanvas(canvasId: string, signal?: AbortSignal) {
  const directory = getCanvasDirectory(signal);
  const canvas = canvases.value.find(item => item.id === canvasId);
  if (!canvas) throw new Error("画布不存在，请重新获取画布列表");
  if (activeCanvasId.value !== canvas.id) throw new Error("画布已切换，请重新载入");
  const flow = await readCanvasFlow(canvas, directory, signal);
  canvas.flow = flow;
  activeCanvasId.value = "";
  setNodes(flow.nodes);
  setEdges(flow.edges.map(({ interactionWidth, ...edge }) => edge));
  await setViewport(flow.viewport);
  await nextTick();
  checkCanvasDirectory(directory, signal);
  boundCanvas.value = canvas;
  activeCanvasId.value = canvas.id;
  signal?.throwIfAborted();
  return { revision: flow.revision, encoding: flow.encoding };
}

async function switchCanvas(canvasId: string, signal?: AbortSignal) {
  const directory = getCanvasDirectory(signal);
  canvasListVisible.value = false;
  busy.value = true;
  try {
    if (props.activateCanvas) await props.activateCanvas(canvasId, signal);
    else await applyCanvas(canvasId, directory, signal);
    checkCanvasDirectory(directory, signal);
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

async function handleSwitchCanvas(canvasId: string) {
  const directory = props.directory;
  try {
    await switchCanvas(canvasId);
  } catch (err) {
    if (props.directory === directory) ElMessage.error(errorMessage(err, "切换画布失败"));
  }
}

async function removeCanvas(canvas: Canvas) {
  if (busy.value || editingId.value !== null || !props.directory) return;
  const directory = props.directory;
  const id = canvas.id;
  busy.value = true;
  canvasListVisible.value = false;
  try {
    const confirmed = await ElMessageBox.confirm(`确定删除“${canvas.name}”？对应的 ${id} 文件及独占的节点素材也会被删除，其他画布共用的素材会保留。此操作不可撤销。`, "删除画布", {
      type: "warning", confirmButtonText: "删除", cancelButtonText: "取消", closeOnClickModal: false,
    }).then(() => true, () => false);
    if (!confirmed) return;
    checkCanvasDirectory(directory);
    const nextCanvas = canvases.value.find(item => item.id !== id);
    if (nextCanvas && activeCanvasId.value === id) await applyCanvas(nextCanvas.id, directory);
    const files = useWorkspaceFiles(directory);
    const readNodes = async (canvasId: string) => {
      const data = await files.readJson<{ toonflowCanvas?: boolean; nodes?: { id: string; data?: unknown }[] }>(canvasId);
      if (data?.toonflowCanvas !== true || !Array.isArray(data.nodes) || data.nodes.some(node => !node || typeof node.id !== "string")) {
        throw new Error(`无法确认 ${canvasId} 的素材引用`);
      }
      return [...data.nodes, ...getRetainedNodes(canvasId)];
    };
    let removedNodes: { id: string; data?: unknown }[] = [];
    await props.flushSave(async () => {
      checkCanvasDirectory(directory);
      if (canvas.id !== id || !canvases.value.includes(canvas)) throw new Error("画布已变更，请重新选择");
      removedNodes = await readNodes(id);
      if (!performFileAction) {
        await files.remove(id);
        checkCanvasDirectory(directory);
        canvases.value = canvases.value.filter(item => item !== canvas);
        await nextTick();
      }
    });
    // coordinator 自己进入保存临界区，必须在上一次 flush 完成后调用，避免重入保存队列。
    if (performFileAction) await performFileAction(directory, "delete", id);
    await props.flushSave(async () => {
      checkCanvasDirectory(directory);
      const retainedNodes = (await Promise.all((await listCanvases(directory, true)).map(canvas => readNodes(canvas.id)))).flat();
      const assetDirectories = getCanvasAssetDirectories(removedNodes, retainedNodes);
      checkCanvasDirectory(directory);
      const results = await Promise.allSettled(assetDirectories.map(path => files.remove(path, true).catch(error => {
        if (!axios.isAxiosError<{ data?: { code?: string } }>(error) || error.response?.data.data?.code !== "ENOENT") throw error;
      })));
      const failed = results.flatMap((result, index) => result.status === "rejected" ? [assetDirectories[index]] : []);
      if (failed.length) throw new Error(`画布已删除，但 ${failed.length} 个素材目录清理失败：${failed.join("、")}`);
    });
    if (props.directory === directory) ElMessage.success("画布已删除");
  } catch (err) {
    if (props.directory === directory) ElMessage.error(errorMessage(err, "删除画布失败"));
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

async function createCanvasFile(directory: string, name?: string, signal?: AbortSignal) {
  if (name !== undefined) name = normalizeCanvasName(name);
  const files = useWorkspaceFiles(directory);
  const flow = { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
  for (let number = 1; ; number++) {
    checkCanvasDirectory(directory, signal);
    const canvasName = name ?? `画布${number}`;
    const id = `${canvasName}.json`;
    try {
      await files.writeJson(id, { toonflowCanvas: true, ...flow }, true);
      // 记录刚创建文件的版本，后续首次保存据此参与冲突检测；读取失败只影响冲突检测，不阻塞创建。
      const snapshot = await files.readTextSnapshot(id).catch(() => undefined);
      if (snapshot) loadedRevisions.set(id, { directory, revision: snapshot.revision, encoding: snapshot.encoding });
      return { id, name: canvasName, flow };
    } catch (err) {
      if (name !== undefined || !axios.isAxiosError<{ data?: { code?: string } }>(err) || err.response?.status !== 409 || err.response.data.data?.code !== "EEXIST") throw err;
    }
  }
}

async function listCanvases(directory: string, recursive = false): Promise<Canvas[]> {
  const files = useWorkspaceFiles(directory);
  const { entries } = await files.list();
  if (recursive) {
    // 文件接口只返回普通文件和目录，不跟随符号链接；素材目录不参与画布扫描。
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      if (entry.type === "directory" && entry.name.toLowerCase() !== "assets") entries.push(...(await files.list(entry.path)).entries);
    }
  }
  const loaded = await Promise.all(entries.filter(entry => entry.type === "file" && /\.json$/i.test(entry.name)).map(async entry => {
    if (!(await isCanvasFile(files, entry.path))) return null;
    return { id: entry.path, name: entry.name.slice(0, -5) };
  }));
  return loaded.filter(canvas => canvas !== null).sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
}

async function addCanvas(name?: string, signal?: AbortSignal): Promise<string> {
  const directory = getCanvasDirectory(signal);
  busy.value = true;
  try {
    const canvas = await createCanvasFile(directory, name, signal);
    checkCanvasDirectory(directory);
    canvases.value = [...canvases.value, canvas];
    signal?.throwIfAborted();
    await applyCanvas(canvas.id, directory, signal);
    canvasListVisible.value = false;
    return canvas.id;
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

async function handleAddCanvas() {
  if (busy.value || editingId.value !== null || !props.directory) return;
  const directory = props.directory;
  busy.value = true;
  try {
    const canvas = await createCanvasFile(directory);
    checkCanvasDirectory(directory);
    canvases.value = [...canvases.value, canvas];
    newCanvasId.value = canvas.id;
    busy.value = false;
    await editCanvas(canvas);
  } catch (err) {
    if (props.directory === directory) ElMessage.error(errorMessage(err, "新增画布失败"));
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

async function editCanvas(canvas: { id: string; name: string }) {
  if (busy.value || editingId.value !== null) return;
  editingId.value = canvas.id;
  canvasName.value = canvas.name;
  renameError.value = "";
  await nextTick();
  nameInputs.value[0]?.focus();
  nameInputs.value[0]?.select();
}

async function finishEdit() {
  if (busy.value) return;
  editingId.value = null;
  renameError.value = "";
  const createdId = newCanvasId.value;
  newCanvasId.value = null;
  if (createdId) await handleSwitchCanvas(createdId);
}

function normalizeCanvasName(name: string) {
  name = name.trim();
  if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error("画布名称不是有效文件名");
  }
  return name;
}

async function renameCanvasFile(id: string, name: string, directory: string, signal?: AbortSignal) {
  checkCanvasDirectory(directory, signal);
  const canvas = canvases.value.find(item => item.id === id);
  if (!canvas) throw new Error("画布不存在，请重新获取画布列表");
  name = normalizeCanvasName(name);
  if (name === canvas.name) return;
  const target = `${id.slice(0, id.lastIndexOf("/") + 1)}${name}.json`;
  if (performFileAction) {
    await performFileAction(directory, "rename", id, target);
    checkCanvasDirectory(directory, signal);
    return;
  }
  await props.flushSave(async () => {
    checkCanvasDirectory(directory, signal);
    await useWorkspaceFiles(directory).rename(id, target);
    checkCanvasDirectory(directory);
    // 文件已改名时先更新保存路径，再响应取消，避免自动保存重新创建旧文件。
    const revision = loadedRevisions.get(id);
    if (revision) {
      loadedRevisions.delete(id);
      loadedRevisions.set(target, revision);
    }
    if (activeCanvasId.value === id) activeCanvasId.value = target;
    if (newCanvasId.value === id) newCanvasId.value = target;
    if (editingId.value === id) editingId.value = target;
    Object.assign(canvas, { id: target, name });
    canvases.value = [...canvases.value];
    signal?.throwIfAborted();
  });
  checkCanvasDirectory(directory, signal);
}

function syncCanvasPath(previous: string, target: string) {
  // 重命名后读取版本随画布路径一起迁移，首次保存仍使用读取内容时的版本。
  const revision = loadedRevisions.get(previous);
  if (revision) {
    loadedRevisions.delete(previous);
    loadedRevisions.set(target, revision);
  }
  if (activeCanvasId.value === previous) activeCanvasId.value = target;
  if (newCanvasId.value === previous) newCanvasId.value = target;
  if (editingId.value === previous) editingId.value = target;
}

async function renameCanvas(canvasId: string, name: string, signal?: AbortSignal) {
  const directory = getCanvasDirectory(signal);
  busy.value = true;
  try {
    await renameCanvasFile(canvasId, name, directory, signal);
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

async function saveCanvas(event?: Event) {
  if (event instanceof KeyboardEvent && event.isComposing) return;
  const id = editingId.value;
  if (busy.value || !props.directory || id === null) return;
  const directory = props.directory;
  const canvas = canvases.value.find(item => item.id === id);
  if (!canvasName.value.trim() || canvasName.value.trim() === canvas?.name) {
    await finishEdit();
    return;
  }
  busy.value = true;
  renameError.value = "";
  try {
    await renameCanvasFile(id, canvasName.value, directory);
    busy.value = false;
    await finishEdit();
  } catch (err) {
    if (props.directory === directory) {
      renameError.value = errorMessage(err, "重命名画布失败");
      canvasListVisible.value = true;
    }
  } finally {
    if (props.directory === directory) busy.value = false;
  }
}

function syncDocumentNode(canvasId: string, nodeId: string, handleId: string, text: string, inline: boolean) {
  const node = canvases.value.find(canvas => canvas.id === canvasId)?.flow?.nodes.find(node => node.id === nodeId);
  if (!node) return;
  const data = node.data ??= {};
  const output = data.outputs?.[handleId];
  if (output?.dataType === "STRING") output.value = text;
  else if (inline) (data.outputs ??= {})[handleId] = { dataType: "STRING", value: text };
}

defineExpose({ getCanvases, addCanvas, switchCanvas, renameCanvas, syncCanvasPath, syncDocumentNode, reloadCanvas, loadError, takeCanvasRevision, rememberCanvasRevision, forgetCanvasRevision });
</script>

<style lang="scss" scoped>
.canvasMenuPanel.vue-flow__panel {
  left: 0;
}

.canvasPicker {
  .iconButton { width: 28px; height: 28px; padding: 0; margin: 0; }

  .pickerHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 8px 8px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .canvasItem {
    display: flex;
    align-items: center;
    border-radius: var(--el-border-radius-base);

    .nameEditor {
      width: 100%;
      padding: 2px 0;
    }

    &:hover, &:focus-within {
      background: var(--el-fill-color);
      .itemAction {
        .renameButton, .deleteButton { opacity: 1; }
        .selectedIcon { visibility: hidden; }
      }
    }

    .canvasChoice {
      flex: 1;
      min-width: 0;
      padding: 6px 8px;
      border: 0;
      background: transparent;
      color: var(--el-text-color-primary);
      font: inherit;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;

      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; border-radius: inherit; }
    }

    .itemAction {
      position: relative;
      display: flex;
      flex-shrink: 0;
      width: 56px;
      height: 28px;
      margin-right: 2px;

      .selectedIcon { position: absolute; top: 5px; left: 5px; pointer-events: none; }
      .renameButton, .deleteButton { opacity: 0; }
    }
  }

  @media (hover: none) {
    .canvasItem .itemAction {
      display: flex;
      width: auto;
      align-items: center;
      .selectedIcon { position: static; visibility: visible; }
      .renameButton, .deleteButton { opacity: 1; }
    }
  }
}

.menuExtension {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
}

.canvasMenu {
  margin-left: 100px;

  .menuContent {
    display: flex;
    align-items: center;
    gap: 10px;

    .workspaceNameInput {
      width: auto;
      min-width: 2em;

      &::after {
        content: var(--workspaceName);
        padding: 0 7px;
        white-space: pre;
        visibility: hidden;
      }

      :deep(.el-input__wrapper) {
        position: absolute;
        inset: 0;
        box-shadow: none;
      }

      :deep(.el-input__inner) {
        font-family: inherit;
        font-weight: inherit;
        letter-spacing: inherit;
      }
    }

    .canvasTrigger {
      padding: 0 4px;
      :deep(> span) { display: flex; align-items: center; gap: 6px; }
      span { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
    }
  }
}
</style>
