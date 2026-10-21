<template>
  <el-dialog v-model="visible" title="设置" width="min(1080px, calc(100vw - 32px))" alignCenter appendToBody>
    <div class="settings">
      <aside class="sidebar" aria-label="设置分类">
        <template v-for="item in settingsPanels" :key="item.id">
          <h3 v-if="item.groupLabel" class="settingsGroupLabel">{{ item.groupLabel }}</h3>
          <button class="settingsItem" type="button" :aria-label="item.id === 'about' && hasDesktopUpdate ? `${item.label}，有新版本可用` : item.label" :aria-pressed="activePanel.id === item.id" @click="activePanel = item">
            <el-badge class="panelIcon" isDot :hidden="item.id !== 'about' || !hasDesktopUpdate">
              <component :is="item.icon" :size="18" aria-hidden="true" />
            </el-badge>
            <span>{{ item.label }}</span>
          </button>
        </template>
      </aside>
      <section class="content" :aria-label="activePanel.label" tabindex="0">
        <!-- ACT: 设置冲突的可执行恢复入口：重新加载会放弃本地未保存修改（F18）。 -->
        <el-alert v-if="settingsConflict" class="conflictNotice" type="warning" :closable="false" showIcon
          title="设置已在其他窗口被修改，本地修改尚未保存">
          <p class="conflictHint">重新加载会放弃本地未保存的设置修改，请先复制需要的改动。</p>
          <el-button size="small" type="primary" @click="reloadSettings">重新加载设置</el-button>
        </el-alert>
        <h2 class="panelTitle">{{ activePanel.label }}</h2>
        <div class="panelContent">
          <!-- ACT: 不包裹 transition/keep-alive：异步面板在部分运行时下会让 out-in 过渡停在 leave 状态，导致切换后内容不更新。 -->
          <component
            :is="activePanel.component"
            v-bind="['pluginMarket', 'languageModel', 'mediaModel', 'personalization'].includes(activePanel.id) ? { visible } : {}" />
        </div>
      </section>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { defineAsyncComponent, shallowRef } from "vue";
import { hasDesktopUpdate } from "@/stores/desktopUpdate";
import { reloadSettings, settingsConflict } from "@/stores/settings";
import {
  IconPalette,
  IconSettings,
  IconPhotoVideo,
  IconBuildingStore,
  IconInfoCircle,
  IconCode,
  IconShieldLock,
  IconPlugConnected,
  IconUserCog,
  IconSubtitlesAi,
  IconDatabase,
} from "@tabler/icons-vue";

const settingsPanels = [
  { id: "ui", label: "界面设置", icon: IconPalette, component: defineAsyncComponent(() => import("./panels/ui.vue")) },
  { id: "general", label: "常规配置", icon: IconSettings, component: defineAsyncComponent(() => import("./panels/general/index.vue")) },
  {
    id: "languageModel",
    label: "文本模型",
    icon: IconSubtitlesAi,
    groupLabel: "模型",
    component: defineAsyncComponent(() => import("./panels/languageModel/index.vue")),
  },
  { id: "mediaModel", label: "媒体模型", icon: IconPhotoVideo, component: defineAsyncComponent(() => import("./panels/mediaModel/index.vue")) },
  {
    id: "pluginMarket",
    label: "插件市场",
    icon: IconBuildingStore,
    groupLabel: "市场",
    component: defineAsyncComponent(() => import("./panels/pluginMarket/index.vue")),
  },
  { id: "mcp", label: "MCP", icon: IconPlugConnected, groupLabel: "其他", component: defineAsyncComponent(() => import("./panels/mcp/index.vue")) },
  { id: "storageCleanup", label: "存储与清理", icon: IconDatabase, component: defineAsyncComponent(() => import("./panels/storageCleanup/index.vue")) },
  { id: "personalization", label: "个性化", icon: IconUserCog, component: defineAsyncComponent(() => import("./panels/personalization.vue")) },
  { id: "privacy", label: "隐私", icon: IconShieldLock, component: defineAsyncComponent(() => import("./panels/privacy.vue")) },
  { id: "developer", label: "开发者选项", icon: IconCode, component: defineAsyncComponent(() => import("./panels/developer/index.vue")) },
  { id: "about", label: "关于", icon: IconInfoCircle, component: defineAsyncComponent(() => import("./panels/about.vue")) },
];
const activePanel = shallowRef(settingsPanels[0]!);
const visible = defineModel<boolean>({ default: false });
</script>

<style lang="scss" scoped>
.settings {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr);
  height: min(72vh, calc(100dvh - 140px));
  overflow: hidden;

  .sidebar {
    min-height: 0;
    overflow-y: auto;
    padding: 2px;

    .settingsGroupLabel {
      margin: 14px 12px 6px;
      color: var(--el-text-color-secondary);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.5;
    }

    .settingsItem {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 12px;
      margin-bottom: 4px;
      border: 0;
      border-radius: var(--el-border-radius-base);
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      text-align: start;
      cursor: pointer;

      .panelIcon { display: inline-flex; flex-shrink: 0; }

      > span {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      &:hover {
        background: var(--el-fill-color-light);
      }

      &[aria-pressed="true"] {
        background: var(--el-color-primary-light-9);
        color: var(--el-color-primary);
      }

      &:focus-visible {
        outline: 2px solid var(--el-color-primary);
      }
    }
  }

  .content {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 0 20px;
    overflow: hidden;

    .panelTitle {
      flex-shrink: 0;
      margin: 0 0 20px;
      font-size: 18px;
    }

    .panelContent {
      flex: 1;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding-left: 5px;
      padding-right: 5px;
      padding-bottom: 50px;

      > :deep(.el-fade-in-enter-active),
      > :deep(.el-fade-in-leave-active) {
        transition-duration: 100ms;
      }
    }
  }

  @media (max-width: 700px) {
    grid-template-columns: 44px minmax(0, 1fr);

    .sidebar {
      .settingsGroupLabel {
        margin: 12px 0 6px;
        text-align: center;
      }

      .settingsItem {
        justify-content: center;
        padding: 12px;
        span {
          display: none;
        }
      }
    }

    .content {
      padding: 0 8px 0 16px;
    }
  }
}
</style>
