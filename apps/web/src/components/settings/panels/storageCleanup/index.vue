<template>
  <div class="storageCleanup">
    <section class="settingSection" aria-labelledby="cleanupNoticeTitle">
      <h3 id="cleanupNoticeTitle">自动清理</h3>
      <p class="description">开启后，过期资料将从服务器永久删除，请在到期前下载。原始资料删除后，再次运行相关工作流需要重新上传。仅作用于服务器受管文件，不删除你电脑上的文件。</p>
    </section>

    <section class="settingSection" aria-labelledby="cleanupRulesTitle">
      <h3 id="cleanupRulesTitle">清理规则</h3>
      <div class="ruleList">
        <div v-for="row in categoryRows" :key="row.id" class="ruleItem">
          <div class="ruleInfo">
            <span class="ruleLabel">{{ row.label }}</span>
            <span class="ruleDescription">{{ row.description }}</span>
          </div>
          <div class="ruleControls">
            <el-input-number
              v-model="draft[row.id].days"
              class="daysInput"
              :min="1"
              :max="3650"
              :precision="0"
              :disabled="saving"
              :aria-label="`${row.label}保留天数`" />
            <span class="daysUnit">天</span>
            <el-switch
              :modelValue="draft[row.id].enabled"
              :loading="togglingCategory === row.id"
              :disabled="saving"
              :aria-label="`${row.label}自动清理`"
              @change="(value) => toggleCategory(row.id, value === true)" />
          </div>
        </div>
      </div>
      <el-alert v-if="daysError" class="ruleError" :title="daysError" type="warning" :closable="false" showIcon />
      <div class="actions">
        <el-button :loading="previewing" :disabled="saving" @click="previewDraft">预览待清理</el-button>
        <el-button type="primary" :loading="saving" :disabled="!dirty || !!daysError || previewing" @click="saveDraft">保存</el-button>
      </div>
      <p v-if="dirty" class="description">修改尚未保存；保存后按新规则执行，定时清理每小时运行一次。</p>
    </section>

    <section class="settingSection" aria-labelledby="cleanupPreviewTitle">
      <h3 id="cleanupPreviewTitle">待清理概览</h3>
      <dl class="summaryList">
        <div v-for="row in categoryRows" :key="row.id" class="summaryItem">
          <dt>{{ row.label }}</dt>
          <dd>{{ summaryText(row.id) }}</dd>
        </div>
        <div class="summaryItem totalItem">
          <dt>合计</dt>
          <dd>{{ previewValue ? `${previewValue.total.count} 个 · ${formatBytes(previewValue.total.bytes)}` : "—" }}</dd>
        </div>
      </dl>
      <p class="description">{{ previewHint }}</p>
    </section>

    <section class="settingSection" aria-labelledby="cleanupStatusTitle">
      <div class="settingHeader">
        <h3 id="cleanupStatusTitle">最近执行</h3>
        <el-button text :icon="IconRefresh" :loading="loadingStatus" :disabled="saving || previewing" @click="refreshStatus">刷新</el-button>
      </div>
      <el-alert v-if="statusError" :title="statusError" type="error" :closable="false" showIcon />
      <dl class="summaryList">
        <div class="summaryItem"><dt>最近清理时间</dt><dd>{{ lastRunText }}</dd></div>
        <div class="summaryItem"><dt>删除文件</dt><dd>{{ cleanupStatus ? `${cleanupStatus.lastDeleted} 个` : "—" }}</dd></div>
        <div class="summaryItem"><dt>释放空间</dt><dd>{{ cleanupStatus ? formatBytes(cleanupStatus.lastFreedBytes) : "—" }}</dd></div>
        <div class="summaryItem"><dt>失败数量</dt><dd>{{ cleanupStatus ? `${cleanupStatus.lastFailures} 个` : "—" }}</dd></div>
      </dl>
      <p class="description">定时清理每小时运行一次，只处理已开启的类别；占用中的文件自动跳过并下一轮重试。</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import axios from "axios";
import { ElMessage, ElMessageBox } from "element-plus";
import { IconRefresh } from "@tabler/icons-vue";
import { saveSettings, settings } from "@/stores/settings";

type CleanupCategory = "text" | "image" | "video" | "original" | "cache";
type CleanupRule = { enabled: boolean; days: number };
type CleanupValue = Record<CleanupCategory, CleanupRule>;
type CleanupSummary = { count: number; bytes: number };
type CleanupPreview = { categories: Record<CleanupCategory, CleanupSummary>; total: CleanupSummary };
type CleanupStatus = { lastRunAt: string; lastFreedBytes: number; lastFailures: number; lastDeleted: number };

const cleanupCategories: CleanupCategory[] = ["text", "image", "video", "original", "cache"];
const defaultDays: Record<CleanupCategory, number> = { text: 2, image: 2, video: 2, original: 30, cache: 2 };
const categoryRows = [
  { id: "text", label: "生成文本", description: "文本节点等生成的文本结果" },
  { id: "image", label: "生成图片", description: "生成的图片结果文件" },
  { id: "video", label: "生成视频", description: "生成的视频结果文件" },
  { id: "original", label: "原始资料", description: "上传到工作区的原始资料，删除后需要重新上传" },
  { id: "cache", label: "可再生成缓存", description: "可以重新生成的中间与缓存文件" },
] as const;

const draft = reactive<Record<CleanupCategory, { enabled: boolean; days: number | undefined }>>({
  text: { enabled: false, days: defaultDays.text },
  image: { enabled: false, days: defaultDays.image },
  video: { enabled: false, days: defaultDays.video },
  original: { enabled: false, days: defaultDays.original },
  cache: { enabled: false, days: defaultDays.cache },
});
const previewValue = ref<CleanupPreview>();
const previewHint = ref("按已保存的设置统计。");
const cleanupStatus = ref<CleanupStatus>();
const statusError = ref("");
const loadingStatus = ref(false);
const previewing = ref(false);
const saving = ref(false);
const togglingCategory = ref<CleanupCategory | "">("");

function labelOf(category: CleanupCategory) {
  return categoryRows.find(row => row.id === category)?.label ?? category;
}

function readSavedRule(source: unknown, category: CleanupCategory): CleanupRule {
  const value = source && typeof source === "object" && !Array.isArray(source) ? source as Record<string, unknown> : {};
  const rule = value[category] && typeof value[category] === "object" && !Array.isArray(value[category]) ? value[category] as Record<string, unknown> : {};
  const days = typeof rule.days === "number" && Number.isInteger(rule.days) && rule.days >= 1 && rule.days <= 3650 ? rule.days : defaultDays[category];
  return { enabled: rule.enabled === true, days };
}

const savedCleanup = computed<CleanupValue>(() => Object.fromEntries(
  cleanupCategories.map(category => [category, readSavedRule(settings.value.cleanup, category)]),
) as CleanupValue);

watch(savedCleanup, value => {
  for (const category of cleanupCategories) {
    draft[category].enabled = value[category].enabled;
    draft[category].days = value[category].days;
  }
}, { immediate: true });

const daysError = computed(() => {
  for (const category of cleanupCategories) {
    const days = draft[category].days;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) return `${labelOf(category)}的保留天数必须是 1-3650 的整数`;
  }
  return "";
});

const dirty = computed(() => cleanupCategories.some(category => draft[category].enabled !== savedCleanup.value[category].enabled
  || (typeof draft[category].days === "number" && draft[category].days !== savedCleanup.value[category].days)));

const lastRunText = computed(() => {
  const at = cleanupStatus.value?.lastRunAt;
  if (!at) return "尚未执行";
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleString();
});

function errorMessage(error: unknown) {
  return axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || error.message : error instanceof Error ? error.message : "操作失败";
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function summaryText(category: CleanupCategory) {
  const summary = previewValue.value?.categories?.[category];
  return summary ? `${summary.count} 个 · ${formatBytes(summary.bytes)}` : "—";
}

function requestValue(): CleanupValue {
  return Object.fromEntries(cleanupCategories.map(category => [category, {
    enabled: draft[category].enabled,
    days: draft[category].days ?? defaultDays[category],
  }])) as CleanupValue;
}

async function requestPreview(value: CleanupValue) {
  const { data } = await axios.post<{ code: number; data: CleanupPreview; message?: string }>("/api/cleanup/preview", { settings: value });
  if (data.code !== 200 || !data.data) throw new Error(data.message || "预览待清理文件失败");
  return data.data;
}

async function refreshStatus() {
  loadingStatus.value = true;
  statusError.value = "";
  try {
    const { data } = await axios.get<{ code: number; data: { cleanupStatus: CleanupStatus | null; preview: CleanupPreview }; message?: string }>("/api/cleanup/status");
    if (data.code !== 200 || !data.data) throw new Error(data.message || "读取清理状态失败");
    cleanupStatus.value = data.data.cleanupStatus ?? undefined;
    previewValue.value = data.data.preview;
    previewHint.value = "按已保存的设置统计。";
  } catch (error) {
    statusError.value = errorMessage(error);
  } finally {
    loadingStatus.value = false;
  }
}

async function toggleCategory(category: CleanupCategory, enabled: boolean) {
  if (!enabled) {
    draft[category].enabled = false;
    return;
  }
  if (daysError.value) {
    ElMessage.error(daysError.value);
    return;
  }
  togglingCategory.value = category;
  try {
    // 首次开启先展示候选预览，用户确认后才改动编辑值。
    const preview = await requestPreview({ ...requestValue(), [category]: { enabled: true, days: draft[category].days ?? defaultDays[category] } });
    previewValue.value = preview;
    previewHint.value = "按当前编辑中的设置统计。";
    const summary = preview.categories[category];
    const detail = summary.count ? `开启后将清理 ${summary.count} 个文件（${formatBytes(summary.bytes)}），这些资料将从服务器永久删除` : "当前没有符合条件的过期文件";
    const confirmed = await ElMessageBox.confirm(`${detail}。确认开启「${labelOf(category)}」自动清理？`, "确认开启自动清理", {
      type: "warning", confirmButtonText: "确认开启", cancelButtonText: "取消",
    }).then(() => true, () => false);
    if (confirmed) draft[category].enabled = true;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    togglingCategory.value = "";
  }
}

async function previewDraft() {
  if (daysError.value) {
    ElMessage.error(daysError.value);
    return;
  }
  previewing.value = true;
  try {
    previewValue.value = await requestPreview(requestValue());
    previewHint.value = "按当前编辑中的设置统计。";
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    previewing.value = false;
  }
}

async function saveDraft() {
  if (daysError.value) {
    ElMessage.error(daysError.value);
    return;
  }
  const value = requestValue();
  // 缩短已开启类别的保留天数会立即扩大清理范围：先预览确认再保存。
  const shortened = cleanupCategories.some(category => savedCleanup.value[category].enabled && value[category].enabled && value[category].days < savedCleanup.value[category].days);
  saving.value = true;
  try {
    if (shortened) {
      const preview = await requestPreview(value);
      previewValue.value = preview;
      previewHint.value = "按当前编辑中的设置统计。";
      const confirmed = await ElMessageBox.confirm(`保留天数缩短后将立即清理更多资料，本次预计清理 ${preview.total.count} 个文件（${formatBytes(preview.total.bytes)}）。过期资料将从服务器永久删除，请在到期前下载。确认保存？`, "确认缩短保留天数", {
        type: "warning", confirmButtonText: "确认保存", cancelButtonText: "取消",
      }).then(() => true, () => false);
      if (!confirmed) return;
    }
    await saveSettings(() => ({ cleanup: value }));
    ElMessage.success("清理设置已保存");
    await refreshStatus();
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    saving.value = false;
  }
}

onMounted(refreshStatus);
</script>

<style lang="scss" scoped>
.storageCleanup {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 0 4px 8px;

  .settingSection {
    min-width: 0;

    h3 {
      margin: 0 0 12px;
      color: var(--el-text-color-primary);
      font-size: 14px;
      font-weight: 600;
    }

    .settingHeader {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;

      h3 { margin: 0; }
    }

    .description {
      margin: 8px 0 0;
      color: var(--el-text-color-secondary);
      font-size: 12px;
      line-height: 1.6;
    }

    .ruleList {
      display: flex;
      flex-direction: column;
      gap: 12px;

      .ruleItem {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;

        .ruleInfo {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;

          .ruleLabel {
            font-size: 13px;
            color: var(--el-text-color-primary);
          }

          .ruleDescription {
            font-size: 12px;
            color: var(--el-text-color-secondary);
          }
        }

        .ruleControls {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;

          .daysInput { width: 120px; }
          .daysUnit { font-size: 12px; color: var(--el-text-color-secondary); }
        }
      }
    }

    .ruleError { margin-top: 12px; }

    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 16px;
    }

    .summaryList {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin: 0;

      .summaryItem {
        display: grid;
        grid-template-columns: 96px minmax(0, 1fr);
        gap: 12px;
        font-size: 12px;
        line-height: 1.6;

        dt { color: var(--el-text-color-regular); }
        dd { margin: 0; color: var(--el-text-color-secondary); }
      }

      .totalItem {
        dt { color: var(--el-text-color-primary); }
        dd { color: var(--el-text-color-primary); }
      }
    }
  }
}
</style>
