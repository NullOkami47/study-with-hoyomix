<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import type { LibraryExport } from './types'
import {
  getDefaultRemoteLibraryRepository,
  type RemoteLibraryRepository,
  type RemoteMergeEnvelope,
} from './remoteRepository'

const props = withDefaults(defineProps<{
  localLibrary: LibraryExport
  repository?: RemoteLibraryRepository
  confirming?: boolean
}>(), {
  repository: () => getDefaultRemoteLibraryRepository(),
})
const emit = defineEmits<{
  (event: 'confirm', confirmationToken: string): void
  (event: 'cancel'): void
}>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
const envelope = ref<RemoteMergeEnvelope | null>(null)
const busy = ref(true)
const failed = ref(false)
const conflicts = computed(() => {
  if (!envelope.value) return 0
  const preview = envelope.value.preview
  return preview.playlistConflicts.length + preview.preferenceConflicts.length + preview.historyConflicts.length
})

async function loadPreview(): Promise<void> {
  busy.value = true
  failed.value = false
  try {
    envelope.value = await props.repository.previewMerge(props.localLibrary)
  } catch {
    failed.value = true
  } finally {
    busy.value = false
  }
}

async function confirm(): Promise<void> {
  if (!envelope.value || busy.value || props.confirming) return
  emit('confirm', envelope.value.confirmationToken)
}

onMounted(loadPreview)
</script>

<template>
  <dialog open class="merge-dialog surface-glass" aria-labelledby="library-merge-title">
    <h3 id="library-merge-title">{{ text('account.data.mergeTitle') }}</h3>
    <p>{{ text('account.data.mergeNotice') }}</p>
    <p v-if="busy && !envelope" role="status">{{ text('account.data.previewLoading') }}</p>
    <p v-if="failed" role="alert">{{ text('account.data.actionFailed') }}</p>
    <dl v-if="envelope" class="merge-dialog__summary">
      <div>
        <dt>{{ text('account.data.addedFavourites') }}</dt>
        <dd data-testid="merge-added-favourites">{{ envelope.preview.addedFavouriteTrackIds.length }}</dd>
      </div>
      <div>
        <dt>{{ text('account.data.addedPlaylists') }}</dt>
        <dd>{{ envelope.preview.addedPlaylistIds.length }}</dd>
      </div>
      <div>
        <dt>{{ text('account.data.conflicts') }}</dt>
        <dd>{{ conflicts }}</dd>
      </div>
      <div>
        <dt>{{ text('account.data.historyEntries') }}</dt>
        <dd data-testid="merge-history-count">{{ envelope.preview.merged.recentHistory.length }}</dd>
      </div>
    </dl>
    <p v-if="envelope && conflicts > 0" class="merge-dialog__warning">
      {{ text('account.data.localWins') }}
    </p>
    <div class="merge-dialog__actions">
      <button data-testid="cancel-library-merge" type="button" :disabled="busy || confirming" @click="emit('cancel')">
        {{ text('account.data.cancel') }}
      </button>
      <button data-testid="confirm-library-merge" type="button" :disabled="busy || confirming || !envelope" @click="confirm">
        {{ text('account.data.confirmMerge') }}
      </button>
    </div>
  </dialog>
</template>

<style scoped>
.merge-dialog {
  position: fixed;
  inset: 50% auto auto 50%;
  z-index: 1100;
  display: grid;
  width: min(30rem, calc(100% - 2rem));
  max-height: calc(100dvh - 2rem);
  gap: 1rem;
  padding: 1.25rem;
  overflow: auto;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
  box-shadow: var(--glass-shadow);
  transform: translate(-50%, -50%);
}

h3,
p,
dl,
dd {
  margin: 0;
}

.merge-dialog__summary {
  display: grid;
  gap: 0.5rem;
}

.merge-dialog__summary div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}

.merge-dialog__warning {
  color: var(--colour-accent-strong);
}

.merge-dialog__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.75rem;
}

button {
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  cursor: pointer;
}
</style>
