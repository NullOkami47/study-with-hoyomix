<script setup lang="ts">
import { ref } from 'vue'

import { translate, type TranslationKey } from '../../i18n'
import { getDefaultLocalLibraryRepository, type LocalLibraryRepository } from '../library/localRepository'
import AccountPreferenceSync from './AccountPreferenceSync.vue'
import type { VolumeControls } from './accountPreferences'
import {
  getDefaultRemoteLibraryRepository,
  type RemoteLibraryRepository,
} from '../library/remoteRepository'
import type { FocusSessionRepository } from '../focus/localRepository'
import { usePreferences } from '../../stores/preferences'

const props = withDefaults(defineProps<{
  localRepository?: LocalLibraryRepository
  repository?: RemoteLibraryRepository
  focusRepository?: FocusSessionRepository
  player?: VolumeControls
}>(), {
  localRepository: () => getDefaultLocalLibraryRepository(),
  repository: () => getDefaultRemoteLibraryRepository(),
  focusRepository: undefined,
})
const emit = defineEmits<{ (event: 'deleted'): void }>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
const deleteConfirmation = ref('')
const status = ref('')
const busy = ref(false)

async function exportData(): Promise<void> {
  busy.value = true
  status.value = ''
  let url: string | undefined
  try {
    const value = await props.repository.exportAccountData()
    url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'study-with-hoyomix-account.json'
    anchor.click()
    status.value = text('account.data.exportReady')
  } catch {
    status.value = text('account.data.actionFailed')
  } finally {
    const exportUrl = url
    if (exportUrl) setTimeout(() => URL.revokeObjectURL(exportUrl), 0)
    busy.value = false
  }
}

async function clearSyncedHistory(): Promise<void> {
  busy.value = true
  status.value = ''
  try {
    await props.repository.clearHistory()
    await props.localRepository.clearHistory()
    status.value = text('account.data.historyCleared')
  } catch {
    status.value = text('account.data.actionFailed')
  } finally {
    busy.value = false
  }
}

async function deleteAccount(): Promise<void> {
  if (deleteConfirmation.value !== 'DELETE') return
  busy.value = true
  status.value = ''
  try {
    await props.repository.deleteAccount()
    // The remote deletion has already succeeded and the D1 cascade is authoritative, so a
    // local Focus cleanup failure is reported without withholding the deletion result.
    try {
      await props.focusRepository?.clear()
    } catch {
      status.value = text('account.data.focusCleanupFailed')
    }
    emit('deleted')
  } catch {
    status.value = text('account.data.actionFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="data-controls" aria-labelledby="account-data-heading">
    <h3 id="account-data-heading">{{ text('account.data.title') }}</h3>
    <p>{{ text('account.data.privacyNotice') }}</p>
    <AccountPreferenceSync v-if="player" :player="player" />
    <div class="data-controls__actions">
      <button type="button" :disabled="busy" @click="exportData">{{ text('account.data.export') }}</button>
      <button data-testid="clear-synced-history" type="button" :disabled="busy" @click="clearSyncedHistory">
        {{ text('account.data.clearHistory') }}
      </button>
    </div>
    <fieldset>
      <legend>{{ text('account.data.deleteTitle') }}</legend>
      <label for="account-delete-confirmation">{{ text('account.data.deletePrompt') }}</label>
      <input
        id="account-delete-confirmation"
        v-model="deleteConfirmation"
        data-testid="delete-confirmation"
        autocomplete="off"
      />
      <button
        data-testid="delete-account"
        type="button"
        :disabled="busy || deleteConfirmation !== 'DELETE'"
        @click="deleteAccount"
      >
        {{ text('account.data.delete') }}
      </button>
    </fieldset>
    <p v-if="status" role="status">{{ status }}</p>
  </section>
</template>

<style scoped>
.data-controls {
  display: grid;
  gap: 0.75rem;
  padding-top: 0.75rem;
  border-top: var(--glass-border);
}

h3,
p {
  margin: 0;
}

p,
label,
legend {
  color: var(--colour-text-muted);
  font-size: 0.875rem;
}

.data-controls__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

fieldset {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0.75rem;
  border: var(--glass-border);
  border-radius: 0.5rem;
}

input,
button {
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
}

button {
  cursor: pointer;
}
</style>
