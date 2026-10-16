<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import type { FocusSessionRepository, FocusSessionStorageMode } from './localRepository'
import type { RemoteFocusSessionRepository } from './remoteRepository'

type FocusHistoryStatus = 'storage_error' | 'pending_overflow' | 'overflow_full'

const props = defineProps<{
  repository: FocusSessionRepository
  historyStatus?: FocusHistoryStatus
  remoteRepository?: RemoteFocusSessionRepository
  signedIn?: boolean
}>()
const emit = defineEmits<{ (event: 'open-calendar'): void }>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
const actionStatus = ref('')
const confirmingClear = ref(false)
const storageMode = ref<FocusSessionStorageMode>(props.repository.storageMode())
const canSync = computed(() => Boolean(props.signedIn && props.remoteRepository))

const historyStatusKey = computed<TranslationKey | undefined>(() => {
  const keys: Record<FocusHistoryStatus, TranslationKey> = {
    storage_error: 'focus.history.storageError',
    pending_overflow: 'focus.history.capacityRecoverable',
    overflow_full: 'focus.history.capacityFatal',
  }
  return props.historyStatus ? keys[props.historyStatus] : undefined
})

function syncStorageMode(): void {
  storageMode.value = props.repository.storageMode()
}

async function exportHistory(): Promise<void> {
  actionStatus.value = ''
  let url: string | undefined
  try {
    const exported = await props.repository.exportFocusHistory()
    url = URL.createObjectURL(new Blob(
      [`${JSON.stringify(exported, null, 2)}\n`],
      { type: 'application/json' },
    ))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'study-with-hoyomix-focus-history.json'
    anchor.click()
    actionStatus.value = text('focus.history.exportReady')
  } catch {
    actionStatus.value = text('focus.history.actionFailed')
  } finally {
    syncStorageMode()
    const exportUrl = url
    if (exportUrl) setTimeout(() => URL.revokeObjectURL(exportUrl), 0)
  }
}


function requestClear(): void {
  confirmingClear.value = true
  actionStatus.value = text('focus.history.confirmStatus')
}

function cancelClear(): void {
  confirmingClear.value = false
  actionStatus.value = ''
}

async function confirmClear(): Promise<void> {
  actionStatus.value = ''
  try {
    await props.repository.clear()
    confirmingClear.value = false
    actionStatus.value = text('focus.history.cleared')
  } catch {
    actionStatus.value = text('focus.history.actionFailed')
  } finally {
    syncStorageMode()
  }
}

onMounted(() => {
  void props.repository.list().then(syncStorageMode).catch(() => {
    syncStorageMode()
    actionStatus.value = text('focus.history.actionFailed')
  })
})
</script>

<template>
  <section class="focus-history-controls" data-focus-history-controls aria-labelledby="focus-history-title">
    <h4 id="focus-history-title">{{ text('focus.history.title') }}</h4>
    <p>{{ text('focus.history.privacy') }}</p>
    <p data-focus-storage-status role="status">
      {{ text(storageMode === 'memory' ? 'focus.history.memory' : 'focus.history.persistent') }}
    </p>
    <p
      v-if="historyStatusKey"
      class="focus-history-controls__issue"
      data-focus-history-status
      role="status"
      aria-live="polite"
    >
      {{ text(historyStatusKey) }}
    </p>

    <div class="focus-history-controls__actions">
      <button data-testid="focus-open-calendar" type="button" @click="emit('open-calendar')">
        {{ text('focus.history.openCalendar') }}
      </button>
      <button data-testid="focus-export" type="button" @click="exportHistory">
        {{ text('focus.history.export') }}
      </button>
      <button
        v-if="!confirmingClear"
        data-testid="focus-clear"
        type="button"
        @click="requestClear"
      >
        {{ text('focus.history.clear') }}
      </button>
    </div>

    <div v-if="confirmingClear" class="focus-history-controls__confirmation">
      <p>{{ text('focus.history.confirmPrompt') }}</p>
      <div class="focus-history-controls__actions">
        <button data-testid="focus-clear-confirm" type="button" @click="confirmClear">
          {{ text('focus.history.confirm') }}
        </button>
        <button data-testid="focus-clear-cancel" type="button" @click="cancelClear">
          {{ text('focus.history.cancel') }}
        </button>
      </div>
    </div>

    <p data-testid="focus-clear-status" role="status" aria-live="polite">
      {{ actionStatus }}
    </p>
    <p v-if="canSync" data-testid="focus-sync-status" role="status" aria-live="polite">
      {{ text('account.preferenceSync.description') }}
    </p>
  </section>
</template>

<style scoped>
.focus-history-controls {
  display: grid;
  gap: 0.75rem;
  padding-block-start: 0.75rem;
  border-block-start: var(--glass-border);
}

h4,
p {
  margin: 0;
}

h4 {
  color: var(--colour-text-primary);
  font-size: 0.875rem;
}

p {
  color: var(--colour-text-muted);
  font-size: 0.875rem;
  line-height: 1.5;
}

.focus-history-controls__issue {
  color: var(--colour-accent-strong);
  font-weight: 650;
}

.focus-history-controls__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

button {
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  cursor: pointer;
  font: inherit;
  transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease;
}

button:hover { filter: var(--control-hover-filter); }
button:active { transform: scale(0.96); filter: var(--control-active-filter); }

.focus-history-controls__confirmation {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
}
</style>
