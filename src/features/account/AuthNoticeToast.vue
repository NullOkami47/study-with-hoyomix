<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { translate } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import { consumeAuthNotice, type AuthNotice } from './authNotice'

const AUTO_DISMISS_MS = 8_000

const { locale } = usePreferences()
const notice = ref<AuthNotice | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined

function dismiss(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  notice.value = null
}

onMounted(() => {
  notice.value = consumeAuthNotice()
  if (notice.value) timer = setTimeout(dismiss, AUTO_DISMISS_MS)
})
onBeforeUnmount(dismiss)
</script>

<template>
  <div
    v-if="notice"
    class="auth-notice-toast surface-glass"
    :class="`auth-notice-toast--${notice.kind}`"
    :role="notice.kind === 'error' ? 'alert' : 'status'"
    data-auth-notice
    :data-auth-notice-kind="notice.kind"
  >
    <p>{{ translate(locale, notice.key) }}</p>
    <button type="button" :aria-label="translate(locale, 'account.notice.dismiss')" @click="dismiss">
      <span aria-hidden="true">×</span>
    </button>
  </div>
</template>

<style scoped>
.auth-notice-toast {
  position: fixed;
  inset-block-start: 1rem;
  inset-inline: 0;
  z-index: 1100;
  display: flex;
  gap: 0.75rem;
  align-items: center;
  width: min(28rem, calc(100vw - 2rem));
  margin-inline: auto;
  padding: 0.75rem 0.75rem 0.75rem 1rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
  box-shadow: var(--glass-shadow);
}

.auth-notice-toast--error {
  border-inline-start: 0.25rem solid #c2410c;
}

.auth-notice-toast p {
  flex: 1;
  margin: 0;
  font-size: 0.9375rem;
}

.auth-notice-toast button {
  min-width: 2.75rem;
  min-height: 2.75rem;
  color: var(--colour-accent-strong);
  background: transparent;
  border: 0;
  border-radius: 0.5rem;
  cursor: pointer;
  font-size: 1.25rem;
}
</style>
