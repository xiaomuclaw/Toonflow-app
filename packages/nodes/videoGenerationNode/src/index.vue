<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="player?.enterFullscreen()"
    :bottomWidth="660"
    :style="{ width: previewUrl && videoWidth ? `${videoWidth + 18}px` : undefined }">
    <template #topActions>
      <el-button :icon="IconMusic" text :disabled="!usableOutput || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('extractAudio')">提取音轨</el-button>
      <el-button :icon="IconLayersSubtract" text :disabled="!usableOutput || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('separate')">分离音视频</el-button>
      <el-button :icon="IconScissors" text :disabled="!usableOutput || generating || deleting || uploading || actions?.processing" @click.stop="actions?.open('trim')">截取片段</el-button>
      <mediaHistory mediaType="video" :current="outputFile" :disabled="generating || deleting || uploading" @select="outputs.video = { dataType: 'VIDEO', value: $event }" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || deleting" text title="替换视频" aria-label="替换视频" @click.stop="fileInput?.click()">替换视频</el-button>
      <input ref="fileInput" type="file" accept="video/*" hidden aria-label="选择替换视频" :disabled="generating || deleting || uploading" @change="replaceOutput" />
    </template>
    <template #topRightActions>
      <el-dropdown trigger="click" placement="bottom-end" :disabled="!player?.ready || player?.capturing || generating || deleting || uploading" @command="player?.captureFrame($event)">
        <el-button :icon="IconPhotoScan" :loading="player?.capturing" :disabled="!player?.ready || player?.capturing || generating || deleting || uploading" text title="截取视频帧" aria-label="截取视频帧" />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="current" :icon="IconPhotoScan">截取当前帧</el-dropdown-item>
            <el-dropdown-item command="first" :icon="IconPlayerSkipBack">截取首帧</el-dropdown-item>
            <el-dropdown-item command="last" :icon="IconPlayerSkipForward">截取尾帧</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </template>
    <div v-loading="generating || uploading" class="videoContent nopan" :aria-busy="generating || uploading">
      <videoPlayer
        v-if="previewUrl"
        ref="player"
        :src="previewUrl"
        label="生成视频"
        @loadedmetadata="resizeVideo" />
      <div v-else class="videoEmpty" role="img" aria-label="暂无生成视频">
        <icon-camera-ai :size="48" stroke="1.25" aria-hidden="true" />
      </div>
      <el-alert v-if="taskStatusText || pendingWriteBack || outputUnavailableText" class="taskStatus" :type="awaitingReview || outputUnavailableText ? 'warning' : 'info'" :closable="false" :title="taskStatusText || outputUnavailableText || writeBackText">
        <template v-if="awaitingReview || pendingWriteBack || canResumeQuery" #default>
          <div class="taskStatusActions">
            <el-button size="small" text @click.stop="refreshTask">继续查询</el-button>
            <el-button v-if="awaitingReview && taskId" size="small" text @click.stop="requestStop">取消任务</el-button>
            <el-button v-if="awaitingReview" size="small" text type="danger" @click.stop="discardPending">人工核对后清除标识</el-button>
          </div>
        </template>
      </el-alert>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem
          v-if="refList.length"
          v-model="refList"
          @preview="setReferencePreview"
          @remove="removeReference" />
        <div v-if="frameMode" class="referenceHint">
          {{ selectedMode === "startFrameOptional" ? "仅一张图片时作为尾帧；两张图片按顺序作为首帧、尾帧" : "图片引用按顺序作为首帧、尾帧" }}
        </div>
        <promptInput v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" expandable />
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || deleting"
            placeholder="选择模型"
            aria-label="生成模型"
            noDataText="请先在设置中添加视频模型"
            placement="top-start"
            @visible-change="(visible) => visible && loadModels().catch((error) => showNodeError(error, '模型读取失败'))">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.models[0]?.asyncMedia === true ? provider.label : `${provider.label} · 同步`">
              <el-option
                v-for="item in provider.models"
                :key="item.modelId"
                :label="item.label"
                :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <generationSettings
            v-model:duration="data.duration"
            v-model:resolution="data.resolution"
            v-model:ratio="data.ratio"
            v-model:mode="data.mode"
            v-model:generateAudio="data.generateAudio"
            :ratios="ratioOptions"
            :model="selectedModel"
            :disabled="generating || deleting || !selectedModel" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="deleting || uploading || (!generating && (!generationPrompt || !selectedModel))"
            :title="generating ? '停止生成' : '生成视频'"
            :aria-label="generating ? '停止生成' : '生成视频'"
            @click="generating ? requestStop() : requestGeneration().catch((error) => showNodeError(error, '视频生成失败'))" />
        </div>
        <div v-if="selectedModel && selectedModel.asyncMedia !== true" class="syncHint">
          该供应商为同步生成：任务由服务器后台受理，但只在当前服务进程内执行，服务重启后无法按原任务 ID 继续查询。
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <videoActions ref="actions" :file="outputFile" :src="previewUrl" :disabled="generating || deleting || uploading" />
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElAlert, ElButton, ElCard, ElMessage, ElMessageBox, ElSelect, ElOption, ElOptionGroup, ElLoading, ElDropdown, ElDropdownMenu, ElDropdownItem } from "element-plus";
import { IconCameraAi, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer, IconMusic, IconLayersSubtract, IconScissors, IconPhotoScan, IconPlayerSkipBack, IconPlayerSkipForward } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, showNodeError, useMediaTask, useNode, z, type NodeMediaModel, type NodeVideoRequest, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { groupNodeModels } from "@toonflow/node-shared/groupNodeModels";
import { useNodeReferences } from "@toonflow/node-shared/useNodeReferences";
import promptInput from "@toonflow/nodes-scaffold/components/promptInput";
import videoPlayer from "@toonflow/nodes-scaffold/videoPlayer";
import videoActions from "@toonflow/node-video/videoActions";
import referenceItem from "@toonflow/nodes-scaffold/components/referenceItem";
import mediaHistory from "@toonflow/nodes-scaffold/components/mediaHistory";
import generationSettings from "./components/generationSettings.vue";

defineOptions({
  inheritAttrs: false,
  icon: IconCameraAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "VIDEO", "AUDIO", "STRING"], label: "图片、视频、音频、文本输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "视频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({
  label: "视频生成",
});
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; model: string; duration?: number; resolution: string; ratio: string; mode: string; generateAudio: boolean });
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.model ??= "";
data.value.resolution ??= "";
data.value.mode ??= "";
data.value.generateAudio ??= true;
data.value.ratio ??= "9:16";
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();
let disposed = false;
const deleting = ref(false);
const player = ref<InstanceType<typeof videoPlayer>>();
const actions = ref<InstanceType<typeof videoActions>>();
const videoWidth = ref(0);
const canvasContext = inject<(() => { id: string } | undefined) | undefined>("canvas", undefined);
// W2/R11：网页点击与节点 MCP 都走同一公共 submit（mediaTask.start）；同步供应商由服务器后台受理，节点不再直接等待成片。
const mediaTask = useMediaTask({
  mediaType: "video",
  nodeId: id,
  resolveDirectory: () => files.getWorkspaceFiles().list().then(({ directory }) => directory),
  canvasId: () => canvasContext?.()?.id,
  // T11：重新挂载后按节点已保存结果的最小元数据查询可用性（只读公共查询，不触发生成）。
  savedResult: () => {
    const current = outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined;
    return current ? { path: current.url, ...(current.taskId ? { taskId: current.taskId } : {}) } : undefined;
  },
  // T11：服务端确认最新输出路径（改名后的 resolvedPath）时，节点定位统一切到它：
  // 播放、下载与后续保存读的都是这份值，不再请求画布里的旧地址；任务与回写身份保持不变。
  resolveOutputPath({ path }) {
    const current = outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined;
    if (!current || normalizePath(current.url) === normalizePath(path)) return;
    outputs.value.video = { dataType: "VIDEO", value: { ...current, url: path } };
  },
  bindOutput(output, meta) {
    // W2：节点最小结果元数据随输出写入节点，供画布保存快照导出同一份回写清单。
    // 同一结果（路径、类型、任务、token 都一致）重复绑定不再改动画布数据，避免把已保存的画布重新弄脏。
    const current = outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined;
    if (current && current.url === output.path && current.mimeType === output.mimeType
      && current.taskId === meta.taskId && current.writeBackToken === meta.writeBackToken) return;
    outputs.value.video = { dataType: "VIDEO", value: { url: output.path, mimeType: output.mimeType, taskId: meta.taskId, writeBackToken: meta.writeBackToken } };
  },
});
const { state: taskState, label: taskLabel, active: taskActive, taskId, errorText: taskError, notice: taskNotice, observing, pendingWriteBack, queryPending } = mediaTask;
const generating = computed(() => taskActive.value);
// T01：unknown 一律是“待核对”，不因已有本地 taskId 变成“可重新生成”；
// 有 taskId 时同时提供继续查询、取消任务与人工核对后清除标识。
const awaitingReview = computed(() => taskState.value === "unknown");
// 停止观察或后台标签降频后，可显式继续查询（恢复不依赖重新填写提示词或模型）。
const canResumeQuery = computed(() => !observing.value && (taskActive.value || !!taskId.value));
const writeBackText = "生成完成：输出已写入节点，画布保存成功后自动清理任务关联";
// R09/W4：已清理或缺失的输出显示明确状态，停止播放/下载，不显示成上游失败。
const outputUnavailableText = computed(() => {
  const availability = mediaTask.outputState.value;
  if (availability === "cleaned") return "输出已清理：文件已按清理规则删除，旧播放与下载已停用；不会自动重新生成";
  if (availability === "missing") return "输出缺失：结果文件不在工作区，旧播放与下载已停用；可在任务记录中核对";
  return "";
});
const taskStatusText = computed(() => {
  if (taskState.value === "idle") return "";
  // 成功且已绑定输出时由预览本身反馈，不再压住画面。
  if (taskState.value === "succeeded" && !taskError.value) return "";
  const detail = taskError.value || taskNotice.value;
  const pending = queryPending.value ? "（本轮尚未在 5 秒内返回，仍在查询）" : "";
  return detail ? `${taskLabel.value}：${detail}${pending}` : `${taskLabel.value}${pending}`;
});
let modelsRequest: Promise<void> | undefined;
// ACT: 供应商未声明视频比例范围，沿用界面的通用比例，具体支持范围由供应商校验。
const ratioOptions = ["16:9", "9:16", "1:1", "4:3", "3:4"];
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
const selectedMode = computed(() => selectedModel.value?.mode?.find((item) => JSON.stringify(item) === data.value.mode) as NodeVideoRequest["mode"]);
const frameMode = computed(() => ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(selectedMode.value)));
const mediaCounts = computed(() => ({
  image: refList.value.filter((item) => item.dataType === "IMAGE").length,
  video: refList.value.filter((item) => item.dataType === "VIDEO").length,
  audio: refList.value.filter((item) => item.dataType === "AUDIO").length,
}));
const matchingModes = computed(() => getMatchingModes(selectedModel.value));

function getMatchingModes(choice?: NodeMediaModel) {
  return (choice?.mode ?? []).filter((mode) => {
    const { image, video, audio } = mediaCounts.value;
    if (Array.isArray(mode)) return image + video + audio > 0 && Object.entries(mediaCounts.value).every(([type, count]) =>
      count <= Number(mode.find((item) => item.startsWith(`${type}Reference:`))?.split(":")[1] ?? 0)
    );
    if (mode === "text") return image + video + audio === 0;
    if (video || audio) return false;
    if (mode === "singleImage") return image === 1;
    if (mode === "startEndRequired") return image === 2;
    return ["endFrameOptional", "startFrameOptional"].includes(mode) && image >= 1 && image <= 2;
  });
}

function getDurations(choice: NodeMediaModel) {
  return [...new Set((choice.durationResolutionMap ?? []).flatMap((item) => item.duration))].sort((a, b) => a - b);
}

function getResolutions(choice: NodeMediaModel, duration?: number) {
  // ACT: 当前视频分辨率使用 p 单位；出现其他单位时再统一换算。
  return [...new Set((choice.durationResolutionMap ?? []).filter((item) => item.duration.includes(duration!)).flatMap((item) => item.resolution))]
    .sort((left, right) => (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity));
}
// ACT: 引用改变时只替换不适用的模式；普通媒体优先作为参考，避免自动变成首尾帧。
watch([selectedModel, matchingModes, () => data.value.mode], ([choice, matches]) => {
  if (!choice || matches.some((item) => JSON.stringify(item) === data.value.mode)) return;
  const modes = choice.mode ?? [];
  const mode = matches.find(Array.isArray) ?? matches.find((item) => item === "singleImage")
    ?? matches.find((item) => item === "endFrameOptional") ?? matches[0]
    ?? modes.find((item) => JSON.stringify(item) === data.value.mode) ?? modes.find(Array.isArray) ?? modes[0];
  data.value.mode = mode === undefined ? "" : JSON.stringify(mode);
}, { flush: "sync" });
// ACT: 参数在节点内归一化，未选中、未挂载底部设置时也可由 Agent 直接生成。
watch([selectedModel, () => data.value.duration], ([choice]) => {
  if (!choice) return;
  const durations = getDurations(choice);
  if (!durations.includes(data.value.duration!)) data.value.duration = durations[0];
  const resolutions = getResolutions(choice, data.value.duration);
  if (!resolutions.includes(data.value.resolution)) data.value.resolution = resolutions[0] ?? "";
  if (!ratioOptions.includes(data.value.ratio)) data.value.ratio = "9:16";
  if (choice.audio !== "optional") data.value.generateAudio = choice.audio === true;
}, { flush: "sync" });
const modelGroups = computed(() => groupNodeModels(models.value));
const generationPrompt = computed(() =>
  [
    data.value.prompt.trim(),
    ...refList.value.flatMap((item, index) => (item.dataType === "STRING" && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])),
  ]
    .filter(Boolean)
    .join("\n\n")
);
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
function normalizePath(value: string | undefined) {
  return (value ?? "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}
// W4：任务报告输出已清理或缺失时，节点不再把旧路径当可播放成片；仅停用展示与操作，不改写画布上的历史路径。
const usableOutput = computed(() => {
  const file = outputFile.value;
  if (!file) return undefined;
  const status = mediaTask.status();
  if ((status.outputState === "cleaned" || status.outputState === "missing") && status.outputPath
    && normalizePath(file.url) === normalizePath(status.outputPath)) return undefined;
  return file;
});
const previewUrl = files.useFileUrl(
  usableOutput,
  (error) => showNodeError(error, "视频读取失败"),
  // 视频预览走同源直链，由浏览器按 Range 流式读取，避免整段下载和对象 URL 常驻内存（R15）。
  true
);

// T14：待回写结果在画布保存成功前登记编辑占用，避免清理器删掉尚未写入画布的结果；
// 首次登记失败必须可见（节点/编辑器显示错误），不得静默假成功。
let releaseWriteBackHold: (() => void) | undefined;
let writeBackHoldPath = "";
function syncWriteBackHold() {
  const path = outputFile.value?.url;
  if (pendingWriteBack.value && path) {
    if (writeBackHoldPath && writeBackHoldPath !== path) {
      releaseWriteBackHold?.();
      releaseWriteBackHold = undefined;
      writeBackHoldPath = "";
    }
    if (!releaseWriteBackHold) {
      try {
        releaseWriteBackHold = files.getWorkspaceFiles().holdEditing?.(path, { onError: message => showNodeError(message, "待回写结果保护登记失败") });
        writeBackHoldPath = path;
      } catch (error) {
        showNodeError(error, "待回写结果保护登记失败");
      }
    }
    return;
  }
  // 画布保存成功（待回写解除）或结果被替换/清理后释放占用，保留期从实际解除时间重新计算。
  releaseWriteBackHold?.();
  releaseWriteBackHold = undefined;
  writeBackHoldPath = "";
}
watch([pendingWriteBack, () => outputFile.value?.url], syncWriteBackHold, { immediate: true });

onMounted(() => {
  void loadModels().catch((error) => showNodeError(error, "模型读取失败"));
  // 刷新或重开后按 localStorage 中的任务标识恢复查询；不会自动重新提交。
  // T11：恢复查询结束后（没有活动绑定时）按节点已保存结果查询可用性，已清理/缺失则停用播放，不触发生成。
  void mediaTask.attach().then(() => mediaTask.refreshSavedAvailability()).catch(() => {});
});
onScopeDispose(() => {
  disposed = true;
  releaseWriteBackHold?.();
  releaseWriteBackHold = undefined;
  writeBackHoldPath = "";
});
// 服务端任务错误直接显示（含 failed/unknown 与未被受理的原因）。
watch(taskError, (message) => {
  if (message) showNodeError(message, "视频生成任务");
});

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || generating.value || deleting.value || uploading.value || disposed) return;
  if (!file.type.startsWith("video/")) return void showNodeError("请选择视频文件", "视频替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("视频不能为空且不能超过 100 MB", "视频替换失败");
  uploading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const url = await files.uploadFile(file);
    if (disposed) {
      await workspace.remove(url);
      return;
    }
    // ACT: 保留历史输出文件，避免破坏撤销记录和复制节点的引用。
    outputs.value.video = { dataType: "VIDEO", value: { url, mimeType: file.type } };
  } catch (error) {
    showNodeError(error, "视频替换失败");
  } finally {
    uploading.value = false;
  }
}

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then((items) => {
    if (generating.value || deleting.value) return;
    models.value = items.filter((item) => item.type === "video");
    // ACT: 只给空配置选默认模型，保留暂时不可用的旧选择及其参数；默认优先支持持久任务的供应商（如 Dola）。
    if (!data.value.model) {
      const first = models.value.find((item) => item.asyncMedia === true) ?? models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function startGeneration(signal?: AbortSignal) {
  const choice = selectedModel.value;
  if (generating.value) throw new Error(`视频任务正在进行（${taskId.value || "等待服务器状态"}），请等待完成或先取消`);
  // 上一次输出尚未随画布保存：先让画布保存成功，避免结果与恢复依据一起丢失。
  if (pendingWriteBack.value) throw new Error("上一次生成的结果尚未保存到画布，请先处理画布保存或冲突后再开始新的生成");
  if (uploading.value) throw new Error("视频正在替换，请等待完成");
  if (deleting.value) throw new Error("节点正在删除");
  if (!choice) throw new Error("请先选择视频模型");
  if (!generationPrompt.value) throw new Error("请输入生成提示词");
  if (refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  const images = refList.value.flatMap((item) => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  if (choice.mode?.length && !matchingModes.value.length) throw new Error("当前模型没有适合这些参考素材的生成模式，请更换模型或调整引用");
  const input: Omit<NodeVideoRequest, "directory"> = {
    providerId: choice.providerId,
    modelId: choice.modelId,
    prompt: generationPrompt.value,
    mode: selectedMode.value,
    duration: data.value.duration,
    resolution: data.value.resolution || undefined,
    ratio: data.value.ratio,
    generateAudio: choice.audio === "optional" ? data.value.generateAudio : choice.audio,
    outputDirectory: `assets/${id}`,
    images: frameMode.value ? undefined : images,
    firstFrame: frameMode.value && (selectedMode.value !== "startFrameOptional" || images.length > 1) ? images[0] : undefined,
    lastFrame: frameMode.value ? images[selectedMode.value === "startFrameOptional" && images.length === 1 ? 0 : 1] : undefined,
    videos: refList.value.flatMap((item) => item.dataType === "VIDEO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
    audios: refList.value.flatMap((item) => item.dataType === "AUDIO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
  };
  // R11/W2：同步与持久供应商统一交给服务器公共受理链（首次提交由服务端按能力分流后台执行）；
  // MCP 控制信号贯穿目录准备与提交，取消发生在提交前时不会产生迟到受理。
  const accepted = await mediaTask.start(input, signal ? { signal } : undefined);
  // 没有 taskId 时不是 accepted：明确提示等待核对，不重复提交。
  if (accepted.status === "pending") ElMessage.warning(accepted.message || "提交结果待核对：已保留任务标识并按原标识查询，不会重复提交");
  return { status: accepted.status, taskId: accepted.taskId, state: accepted.state, message: accepted.message };
}

// 节点内点击生成：待回写状态下先由用户明确选择是否替换上一次的恢复关联。
async function requestGeneration() {
  if (pendingWriteBack.value) {
    const confirmed = await ElMessageBox.confirm(
      "上一次生成的结果尚未保存到画布（画布保存冲突或失败）。继续生成会替换临时恢复关联；请确认画布内容已保存或可放弃。",
      "继续生成",
      { type: "warning", confirmButtonText: "继续生成", cancelButtonText: "取消", closeOnClickModal: false }
    ).then(() => true, () => false);
    if (!confirmed) return;
    mediaTask.discard();
  } else if (awaitingReview.value) {
    // T01：unknown（无论有没有本地 taskId）不是终态，一律不得进入“重新生成”路径：
    // 只能继续查询、取消任务，或人工核对后明确清除本地标识；上游可能仍在生成，不能重新提交。
    throw new Error("上一次提交的结果仍待核对（上游可能仍在生成），不能直接重新生成：请先使用“继续查询”，或在服务器任务列表中人工核对后用“人工核对后清除标识”解除本节点的本地任务关联");
  } else if (taskId.value && !taskActive.value) {
    // 可信终态（例如已完成但输出已清理/缺失）；重新生成需要用户明确解除该节点的本地任务关联。
    const confirmed = await ElMessageBox.confirm(
      "上一次任务已经结束（结果可能已清理或不可用），任务记录与历史仍保留在服务器。继续生成会解除本节点保存的本地任务关联。",
      "继续生成",
      { type: "warning", confirmButtonText: "继续生成", cancelButtonText: "取消", closeOnClickModal: false }
    ).then(() => true, () => false);
    if (!confirmed) return;
    mediaTask.discard();
  }
  await startGeneration();
}

async function refreshTask() {
  await mediaTask.refresh();
}

async function discardPending() {
  // T01：有 taskId 的待核对任务要明确提示“上游可能仍在生成”，清除标识不取消上游任务。
  const message = taskId.value
    ? `任务 ${taskId.value} 的状态仍待核对，上游可能仍在生成。清除本地标识不会取消上游任务，清除后再次生成可能产生重复任务与重复费用；请先在服务器任务列表中核对本次提交。`
    : "仅清除本页面保存的任务标识：如果服务器实际已经受理该提交，清除后再次生成可能产生重复任务与重复费用。请先确认服务器任务列表中没有本次提交。";
  const confirmed = await ElMessageBox.confirm(message, "人工核对后清除标识", {
    type: "warning", confirmButtonText: "清除本地标识", cancelButtonText: "取消", closeOnClickModal: false,
  }).then(() => true, () => false);
  if (confirmed) mediaTask.discard();
}

// 用户点停止：统一按服务器任务链处理（同步供应商同样返回 taskId，取消语义一致）。
async function requestStop() {
  if (!taskId.value) {
    // 没有 taskId 时不能取消一个尚未确认的任务：只支持继续查询或仅停止本地观察。
    const decision = await ElMessageBox.confirm(
      "本次提交的结果尚未确认（没有 taskId）。可以继续查询确认，或仅停止本页面的观察；两者都不会取消服务器上的任务。",
      "提交待核对",
      { type: "info", confirmButtonText: "继续查询", cancelButtonText: "仅停止观察", distinguishCancelAndClose: true, closeOnClickModal: false }
    ).then(() => "query" as const, (action: unknown) => action === "close" ? "close" as const : "observe" as const);
    if (decision === "close") return;
    if (decision === "query") await refreshTask();
    else mediaTask.stopObserving();
    return;
  }
  const decision = await ElMessageBox.confirm(
    awaitingReview.value
      ? `任务 ${taskId.value} 的状态仍待核对（上游可能仍在生成）。取消会尝试请求供应商停止生成（不保证撤销任务或费用）；仅停止观察只关闭本页面的进度跟踪，不会改变任务状态。`
      : `任务 ${taskId.value} 正在服务器执行。取消任务会请求供应商停止生成（不保证撤销任务或费用）；仅停止观察只是关闭本页面的进度跟踪，任务继续执行。`,
    "停止生成",
    { type: "warning", confirmButtonText: "取消任务", cancelButtonText: "仅停止观察", distinguishCancelAndClose: true, closeOnClickModal: false }
  ).then(() => "cancel" as const, (action: unknown) => action === "close" ? "close" as const : "observe" as const);
  if (decision === "close") return;
  if (decision === "observe") {
    mediaTask.stopObserving();
    return;
  }
  try {
    await mediaTask.cancel("task");
  } catch (error) {
    showNodeError(error, "取消任务失败");
  }
}

nodeEvent.on("save", (reason) => {
  // 服务端任务与节点组件无关，刷新节点后仍会按任务标识继续跟踪。
  if (reason === "reload" && (uploading.value || deleting.value)) throw new Error("视频处理中，请完成后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value) throw new Error("视频正在替换，请稍后删除节点");
  deleting.value = true;
  try {
    // 删除节点只停止本地观察：服务器任务继续执行，不自动取消；任务标识保留以便撤销删除后继续查看。
    if (taskId.value && (taskActive.value || observing.value)) {
      ElMessage.warning(`节点已删除，服务器任务 ${taskId.value} 继续执行，不会自动取消`);
    }
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeVideo(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (!video.videoWidth || !video.videoHeight) return;
  videoWidth.value = Math.max(180, (240 * video.videoWidth) / video.videoHeight);
  await nextTick();
  updateNodeInternals();
}

function getConfig() {
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      duration: data.value.duration,
      resolution: data.value.resolution,
      ratio: data.value.ratio,
      mode: selectedMode.value,
      generateAudio: data.value.generateAudio,
    },
    models: models.value,
    ratios: ratioOptions,
    matchingModes: matchingModes.value,
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取此视频生成节点的当前配置、可选视频模型能力、通用比例及适合当前引用的模式，不含密钥；时长与分辨率须符合 durationResolutionMap",
  parameters: z.strictObject({}),
  readOnly: true,
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return getConfig();
  },
});

nodeTools.register({
  name: "setConfig",
  description: "修改此视频生成节点的模型、时长、分辨率、比例、模式或声音；先用 getConfig 查询能力，providerId 与 modelId 必须同时提供；mode 使用返回的原始字符串或数组，须匹配当前引用；不修改提示词、不启动生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    duration: z.number().positive().optional(),
    resolution: z.string().min(1).optional(),
    ratio: z.enum(ratioOptions).optional(),
    mode: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    generateAudio: z.boolean().optional(),
  }).refine((args) => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value
      : models.value.find((item) => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效视频模型");
    const durations = getDurations(choice);
    if (args.duration !== undefined && !durations.includes(args.duration)) throw new Error(`当前模型不支持时长 ${args.duration}，可选：${durations.join("、")}`);
    const duration = args.duration ?? (durations.includes(data.value.duration!) ? data.value.duration : durations[0]);
    const resolutions = getResolutions(choice, duration);
    if (args.resolution !== undefined && !resolutions.includes(args.resolution)) throw new Error(`当前时长不支持分辨率 ${args.resolution}，可选：${resolutions.join("、")}`);
    const resolution = args.resolution ?? (resolutions.includes(data.value.resolution) ? data.value.resolution : resolutions[0] ?? "");
    if (args.mode !== undefined && !getMatchingModes(choice).some((item) => JSON.stringify(item) === JSON.stringify(args.mode))) throw new Error("所选模式不受当前模型支持或不适用于当前引用，请根据模型能力及已连接素材选择");
    if (args.generateAudio !== undefined && choice.audio !== "optional" && args.generateAudio !== (choice.audio === true)) throw new Error("当前模型不支持切换声音，请查看 getConfig 返回的 audio 能力");
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    data.value.duration = duration;
    data.value.resolution = resolution;
    if (args.ratio !== undefined) data.value.ratio = args.ratio;
    if (args.mode !== undefined) data.value.mode = JSON.stringify(args.mode);
    if (args.generateAudio !== undefined) data.value.generateAudio = args.generateAudio;
    return getConfig();
  },
});

nodeTools.register({
  name: "setPrompt",
  description: "修改此节点的视频生成提示词，支持 {{ref 1}} 等参考标记；只修改提示词，不启动生成",
  parameters: z.strictObject({ prompt: z.string() }),
  execute({ prompt: value }) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    data.value.prompt = value;
    data.value.promptModel = value.split("\n").map((text) => [{ type: "Write", text }]);
    return { prompt: value };
  },
});

nodeTools.register({
  name: "generateVideo",
  description: "发起此节点的后台视频生成任务：使用当前提示词、模型、模式、时长、分辨率、比例和参考素材，任务由服务器受理并继续执行（同步供应商由服务器后台执行，但在服务重启后无法按原任务 ID 继续查询）；立即返回 accepted/existing 与 taskId。若本节点已有未解决的本地任务关联（含 unknown 待核对，无论是否已有 taskId）只按原标识查询，不新建提交键，返回 existing/pending；unknown 不是终态，绝不重新生成，请用 getGenerationStatus 查询并由人工核对后再处理。不要在未查询状态时重复调用",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration(signal);
  },
});

nodeTools.register({
  name: "getGenerationStatus",
  readOnly: true,
  description: "从服务器查询此节点跟踪的视频任务状态：idle 表示当前没有跟踪中的任务，其余为 preparing/queued/submitting/running/downloading/succeeded/failed/cancelled/unknown；同时返回 taskId、提示或错误文案、是否请求取消、是否等待画布回写（pendingWriteBack）、跟进状态（trackingStatus/waitingReason/retryAt）以及当前节点输出。仅等待本节点自身订阅结果，最多约 5 秒；超时返回本地已知摘要并带 queryPending=true（仍在查询，可稍后再次调用）。succeeded 表示结果文件已保存并已绑定到节点；unknown 表示提交结果待核对，任务关联会保留，不会自动重新生成",
  parameters: z.strictObject({}),
  async execute() {
    // H/T13 + 互审：整次状态查询（含目录解析与服务器往返）统一受短截止约束，超时按本地已知摘要返回并标记 queryPending=true；
    // 原先只有“等待自身订阅结果”一段有 5s 上限，前置目录解析/在途请求挂起会让整个工具调用长时间不返回。
    let settled = false;
    const query = mediaTask.refresh().then(() => { settled = true; }, () => { settled = true; });
    await Promise.race([query, new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5000);
      (timer as unknown as { unref?: () => void }).unref?.();
    })]);
    const status = { ...mediaTask.status(), outputs: outputs.value };
    if (!settled) status.queryPending = true;
    return status;
  },
});

nodeTools.register({
  name: "cancelGeneration",
  description: "请求取消服务器上的此视频任务，会尝试让供应商停止生成；没有 taskId 时按原 batchKey 查询并取消。不删除已有输出，不保证供应商撤销任务或费用。cancellationRequested 表示服务器已记录取消意图，随后用 getGenerationStatus 查询终止状态",
  parameters: z.strictObject({}),
  execute() {
    return mediaTask.cancel("task");
  },
});
</script>

<style scoped lang="scss">
.videoContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .videoEmpty {
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  .taskStatus {
    position: absolute;
    top: 8px;
    left: 8px;
    right: 8px;
    padding: 4px 8px;
    --el-alert-padding: 4px 8px;
    --el-alert-title-font-size: 12px;

    .taskStatusActions {
      display: flex;
      justify-content: flex-end;
      gap: 4px;
      margin-top: 2px;
    }
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }

}

.promptCard {
  .referenceHint {
    margin: 8px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .syncHint {
    margin-top: 6px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.5;
  }

  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      &:deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    .sendButton {
      width: 32px;
      height: 32px;
      margin-left: auto;
      padding: 0;
      --el-button-bg-color: var(--el-text-color-primary);
      --el-button-border-color: transparent;
      --el-button-text-color: var(--el-bg-color);
      --el-button-hover-bg-color: var(--el-text-color-regular);
      --el-button-hover-border-color: transparent;
      --el-button-hover-text-color: var(--el-bg-color);
    }
  }
}
</style>
