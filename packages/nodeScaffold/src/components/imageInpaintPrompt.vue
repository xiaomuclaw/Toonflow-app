<template>
  <teleport :to="target ?? 'body'" :disabled="!target">
  <el-card v-show="!!target" class="inpaintPrompt" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
    <promptInput v-model="promptModel" v-model:text="prompt" :references="[]" expandable />
    <div class="promptFooter">
      <el-select
        v-model="model"
        class="modelSelect"
        filterable
        :loading="modelsLoading"
        :disabled="disabled || generating"
        placeholder="选择模型"
        aria-label="局部重绘模型"
        noDataText="请先在设置中添加图片模型"
        placement="top-start"
        @visible-change="visible => visible && loadModels().catch(error => showNodeError(error, '模型读取失败'))">
        <template #prefix><icon-sparkles :size="17" /></template>
        <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
          <el-option v-for="item in provider.models" :key="item.modelId" :label="item.label" :value="JSON.stringify([item.providerId, item.modelId])" />
        </el-option-group>
      </el-select>
      <el-popover trigger="click" placement="top-start" :width="260" :disabled="disabled || generating || !selectedModel" :showArrow="false">
        <template #reference>
          <el-button class="settingsButton" text size="small" :disabled="disabled || generating || !selectedModel" aria-label="局部重绘设置">
            <span>{{ ratio }} · {{ size }} · 1张</span>
            <icon-chevron-up :size="14" aria-hidden="true" />
          </el-button>
        </template>
        <div class="inpaintSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
          <label>
            <span>分辨率</span>
            <el-select v-model="size" :disabled="disabled || generating" aria-label="局部重绘分辨率">
              <el-option v-for="item in sizeOptions" :key="item" :label="item" :value="item" />
            </el-select>
          </label>
          <label>
            <span>比例</span>
            <el-select v-model="ratio" :disabled="disabled || generating" aria-label="局部重绘比例">
              <el-option v-for="item in ratioOptions" :key="item" :label="item" :value="item" />
            </el-select>
          </label>
        </div>
      </el-popover>
      <el-button
        class="sendButton"
        :icon="generating ? IconPlayerStop : IconArrowUp"
        :disabled="!generating && (disabled || !prompt.trim() || !selectedModel)"
        :title="generating ? '停止生成' : '局部重绘'"
        :aria-label="generating ? '停止生成' : '局部重绘'"
        @click="generating ? generationController?.abort() : startGeneration()" />
    </div>
  </el-card>
  </teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElCard, ElOption, ElOptionGroup, ElPopover, ElSelect } from "element-plus";
import { IconArrowUp, IconChevronUp, IconPlayerStop, IconSparkles } from "@tabler/icons-vue";
import { groupNodeModels, useNodeAi, type NodeImageRequest, type NodeMediaModel } from "../nodeAi";
import { showNodeError } from "../showNodeError";
import promptInput from "./promptInput.vue";

const props = defineProps<{
  generate: (input: Omit<NodeImageRequest, "directory" | "outputDirectory" | "images">, signal: AbortSignal) => Promise<void>;
  disabled?: boolean;
  target?: HTMLElement;
}>();
const ai = useNodeAi();
const prompt = ref("");
const promptModel = ref<NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>>([]);
const model = ref("");
const size = ref("");
const ratio = ref("16:9");
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const generating = ref(false);
const modelGroups = computed(() => groupNodeModels(models.value));
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === model.value));
const sizeOptions = computed(() => selectedModel.value?.imageSizes?.length ? selectedModel.value.imageSizes : ["2K"]);
const ratioOptions = computed(() => selectedModel.value?.imageRatios?.length ? selectedModel.value.imageRatios : ["16:9"]);
let modelsRequest: Promise<void> | undefined;
let generationController: AbortController | undefined;
let disposed = false;

watch(selectedModel, choice => {
  if (!choice) return;
  // ACT: 沿用图片生成节点的 K 单位排序，其他单位排在数值选项之后。
  if (!sizeOptions.value.includes(size.value)) size.value = sizeOptions.value.toSorted((left, right) =>
    (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity)
  )[0]!;
  if (!ratioOptions.value.includes(ratio.value)) ratio.value = ratioOptions.value.includes("16:9") ? "16:9" : ratioOptions.value[0]!;
}, { flush: "sync" });

onMounted(() => loadModels().catch(error => { if (!disposed) showNodeError(error, "模型读取失败"); }));
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
});
defineExpose({ generating });

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then(items => {
    if (disposed || generating.value) return;
    models.value = items.filter(item => item.type === "image");
    if (!model.value) {
      const first = models.value[0];
      model.value = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function startGeneration() {
  const choice = selectedModel.value;
  if (disposed || generating.value || props.disabled || !choice || !prompt.value.trim()) return;
  const controller = generationController = new AbortController();
  generating.value = true;
  try {
    await props.generate({
      providerId: choice.providerId,
      modelId: choice.modelId,
      prompt: prompt.value.trim(),
      size: size.value,
      ratio: ratio.value,
    }, controller.signal);
  } catch (error) {
    if (!controller.signal.aborted && !disposed) showNodeError(error, "局部重绘失败");
  } finally {
    generating.value = false;
    generationController = undefined;
  }
}
</script>

<style scoped lang="scss">
.inpaintPrompt {
  .promptFooter {
    display: flex;
    align-items: center;
    gap: 12px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      :deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    .settingsButton {
      flex-shrink: 0;
      :deep(> span) { gap: 6px; }
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

.inpaintSettings {
  display: grid;
  gap: 12px;

  label {
    display: grid;
    gap: 6px;
    color: var(--el-text-color-regular);
    font-size: 12px;
  }
}
</style>
