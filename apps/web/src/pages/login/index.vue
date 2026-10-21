<template>
  <main class="loginPage">
    <section class="loginPanel" aria-labelledby="loginTitle">
      <h1 id="loginTitle" class="loginTitle">Toonflow 管理员登录</h1>
      <p class="loginDescription">{{ resume ? "登录成功后会回到原页面继续查询任务；原页面未保存的草稿与任务关联都会保留。" : "请输入服务器管理员的账号与密码。" }}</p>
      <form class="loginForm" @submit.prevent="submitLogin">
        <label class="fieldLabel" for="loginUsername">账号</label>
        <el-input id="loginUsername" v-model="username" autocomplete="username" placeholder="管理员账号" :disabled="submitting" />
        <label class="fieldLabel" for="loginPassword">密码</label>
        <el-input id="loginPassword" v-model="password" type="password" showPassword autocomplete="current-password" placeholder="密码" :disabled="submitting" />
        <el-alert v-if="errorMessage" class="loginError" :title="errorMessage" type="error" :closable="false" showIcon />
        <el-button class="loginButton" type="primary" nativeType="submit" :loading="submitting">登录</el-button>
      </form>
    </section>
  </main>
</template>

<script setup lang="ts">
import { ref } from "vue";

const username = ref("");
const password = ref("");
const submitting = ref(false);
const errorMessage = ref("");
// 由登录过期状态条打开时（?resume=1）只恢复登录，不刷新原页面，避免丢失未保存内容。
const resume = new URLSearchParams(window.location.search).get("resume") === "1";

async function submitLogin() {
  if (submitting.value) return;
  if (!username.value.trim() || !password.value) {
    errorMessage.value = "请输入账号和密码";
    return;
  }
  submitting.value = true;
  errorMessage.value = "";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    });
    const payload = await response.json().catch(() => undefined) as { code?: number; message?: string } | undefined;
    if (!response.ok || payload?.code !== 200) {
      errorMessage.value = typeof payload?.message === "string" && payload.message ? payload.message : `登录失败（${response.status}）`;
      return;
    }
    if (resume && window.opener) {
      // 通知原页面重新认证成功（只恢复查询，不重放生成），然后关闭本窗口。
      window.opener.postMessage({ type: "toonflow:login-complete" }, window.location.origin);
      window.close();
      return;
    }
    window.location.reload();
  } catch {
    errorMessage.value = "无法连接服务器，请稍后重试";
  } finally {
    submitting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.loginPage {
  display: grid;
  place-items: center;
  min-height: 100svh;
  padding: 24px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
  font-family: "Inter", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;

  .loginPanel {
    display: grid;
    gap: 12px;
    width: 100%;
    max-width: 360px;
    padding: 32px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: var(--ui-radius, 8px);
    background: var(--el-bg-color-overlay, var(--el-bg-color));

    .loginTitle {
      margin: 0;
      font-size: 22px;
      font-weight: 650;
    }

    .loginDescription {
      margin: 0;
      font-size: 13px;
      color: var(--el-text-color-secondary);
    }

    .loginForm {
      display: grid;
      gap: 8px;
      margin-top: 8px;

      .fieldLabel {
        font-size: 13px;
        color: var(--el-text-color-regular);
      }

      .loginError {
        margin: 4px 0;
      }

      .loginButton {
        margin-top: 12px;
        width: 100%;
      }
    }
  }
}
</style>
