<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { AdminBackground, AdminBackgroundMetadataPatch, AdminRepository } from './client'
import AdminStatusChip from './primitives/AdminStatusChip.vue'
import AdminPageHeader from './primitives/AdminPageHeader.vue'
import AdminConfirmDialog from './primitives/AdminConfirmDialog.vue'
import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'

const props = defineProps<{ repository: AdminRepository }>()

const { locale } = usePreferences()

function t(key: string): string {
  return translate(locale.value, key as TranslationKey)
}

const GAME_OPTIONS = ['zzz', 'genshin', 'hsr'] as const

interface MetadataDraft {
  title: string
  game: string
  customGame: string
  collection: string
  displayOrder: string
}

const backgrounds = ref<AdminBackground[]>([])
const state = ref<'loading' | 'ready' | 'unavailable'>('loading')
const busyId = ref<string | null>(null)
const message = ref('')
const confirmingPurgeId = ref<string | null>(null)
const isDragging = ref(false)
const conversionProgress = ref<number | null>(null)
const drafts = reactive<Record<string, MetadataDraft>>({})
let uploadController: AbortController | undefined
onBeforeUnmount(() => uploadController?.abort())

const backgroundToPurge = computed(() =>
  backgrounds.value.find((b) => b.id === confirmingPurgeId.value) ?? null,
)

const collectionOptions = computed(() => {
  const seen = new Set<string>()
  for (const background of backgrounds.value) {
    const collection = background.collection?.trim()
    if (collection) seen.add(collection)
  }
  return Array.from(seen).sort()
})

function syncDraft(background: AdminBackground): void {
  const game = background.game?.trim() ?? ''
  const isKnownGame = (GAME_OPTIONS as readonly string[]).includes(game)
  drafts[background.id] = {
    title: background.title ?? '',
    game: game ? (isKnownGame ? game : 'custom') : '',
    customGame: game && !isKnownGame ? game : '',
    collection: background.collection ?? '',
    displayOrder: background.displayOrder != null ? String(background.displayOrder) : '',
  }
}

watch(backgrounds, (list) => {
  for (const background of list) syncDraft(background)
}, { immediate: true })

function onConfirmPurge(): void {
  if (backgroundToPurge.value && busyId.value === null) {
    void purge(backgroundToPurge.value)
  }
}

async function load(): Promise<void> {
  state.value = 'loading'
  try {
    backgrounds.value = await props.repository.listBackgrounds()
    state.value = 'ready'
  } catch {
    state.value = 'unavailable'
    message.value = t('admin.backgrounds.loadError') || 'Background media could not be loaded.'
  }
}

function validImage(file: File): boolean {
  return ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && file.size <= 12 * 1024 * 1024
    || ['video/mp4', 'video/webm', 'video/quicktime'].includes(file.type) && file.size <= 200 * 1024 * 1024
}

/**
 * Map an upload failure onto the most precise message the UI can honestly
 * give. In particular a 503 is not a generic failure: it means the deployment
 * has no `BACKGROUND_BUCKET` binding, so the Worker refuses to store anything.
 * Reporting that plainly is what keeps the drop zone from advertising an
 * upload that this environment cannot accept.
 */
function uploadErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.startsWith('video_')) return t('admin.backgrounds.conversionFailed')
  if (message === 'admin_503') return t('admin.backgrounds.storageUnavailable')
  if (message === 'admin_415') return t('admin.backgrounds.unsupportedType')
  if (message === 'admin_422') return t('admin.backgrounds.serverValidationError')
  if (message === 'admin_413') return t('admin.backgrounds.fileTooLargeOrInvalid')
  return t('admin.backgrounds.uploadFailed')
}

async function handleFileUpload(file: File): Promise<void> {
  if (busyId.value !== null) return
  message.value = ''
  if (!validImage(file)) {
    message.value = t('admin.backgrounds.fileTooLargeOrInvalid') || 'Choose a JPEG, PNG, or WebP image no larger than 12 MB.'
    return
  }
  busyId.value = 'upload'
  try {
    uploadController = new AbortController()
    const options = { signal: uploadController.signal, onProgress: (value: number) => { conversionProgress.value = Math.round(value * 100) }, onStage: () => { conversionProgress.value = null; message.value = t('admin.backgrounds.uploading') } }
    if (file.type.startsWith('video/')) { conversionProgress.value = 0; await props.repository.uploadBackground(file, options) }
    else await props.repository.uploadBackground(file)
    message.value = t('admin.backgrounds.uploadedDraft') || 'Image uploaded as a draft.'
    await load()
  } catch (error) {
    message.value = uploadErrorMessage(error)
  } finally {
    busyId.value = null
    conversionProgress.value = null; uploadController = undefined
  }
}

async function onUpload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  await handleFileUpload(file)
  input.value = ''
}

function onDrop(event: DragEvent): void {
  isDragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) void handleFileUpload(file)
}

async function onReplace(background: AdminBackground, event: Event): Promise<void> {
  if (busyId.value !== null) return
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!validImage(file)) {
    message.value = t('admin.backgrounds.fileTooLargeOrInvalid') || 'Choose a JPEG, PNG, or WebP image no larger than 12 MB.'
    input.value = ''
    return
  }
  busyId.value = background.id
  try {
    uploadController = new AbortController()
    const options = { signal: uploadController.signal, onProgress: (value: number) => { conversionProgress.value = Math.round(value * 100) }, onStage: () => { conversionProgress.value = null; message.value = t('admin.backgrounds.uploading') } }
    if (file.type.startsWith('video/')) { conversionProgress.value = 0; await props.repository.replaceBackground(background.id, file, options) }
    else await props.repository.replaceBackground(background.id, file)
    message.value = t('admin.backgrounds.revisionReplaced') || 'Background revision replaced.'
    await load()
  } catch (error) {
    message.value = uploadErrorMessage(error)
  } finally {
    busyId.value = null
    conversionProgress.value = null; uploadController = undefined
    input.value = ''
  }
}

async function lifecycle(background: AdminBackground, action: 'publish' | 'archive' | 'restore'): Promise<void> {
  busyId.value = background.id
  message.value = ''
  try {
    if (action === 'publish') await props.repository.publishBackground(background.id)
    else if (action === 'archive') await props.repository.archiveBackground(background.id)
    else await props.repository.restoreBackground(background.id)
    await load()
  } catch {
    message.value = (t('admin.backgrounds.actionFailed') || 'Background {action} failed.').replace('{action}', action)
  } finally {
    busyId.value = null
  }
}

async function purge(background: AdminBackground): Promise<void> {
  if (busyId.value !== null) return
  busyId.value = background.id
  try {
    await props.repository.purgeBackground(background.id)
    confirmingPurgeId.value = null
    message.value = t('admin.backgrounds.purgeSuccess') || 'Background permanently purged.'
    await load()
  } catch {
    message.value = t('admin.backgrounds.purgeFailed') || 'Background purge failed. No retry was attempted.'
  } finally {
    busyId.value = null
  }
}

async function saveMetadata(background: AdminBackground): Promise<void> {
  if (busyId.value !== null) return
  const draft = drafts[background.id]
  if (!draft) return
  const title = draft.title.trim()
  if (title.length === 0 || title.length > 120) {
    message.value = t('admin.backgrounds.titleInvalid') || 'Enter a title between 1 and 120 characters.'
    return
  }
  let displayOrder: number | null = null
  const rawOrder = draft.displayOrder.trim()
  if (rawOrder !== '') {
    const parsed = Number(rawOrder)
    if (!Number.isInteger(parsed) || parsed < 0) {
      message.value = t('admin.backgrounds.orderInvalid') || 'Display order must be zero or greater.'
      return
    }
    displayOrder = parsed
  }
  const game = draft.game === 'custom' ? draft.customGame.trim() : draft.game.trim()
  const collection = draft.collection.trim()
  const patch: AdminBackgroundMetadataPatch = {
    title,
    game: game === '' ? null : game,
    collection: collection === '' ? null : collection,
    displayOrder,
  }
  busyId.value = background.id
  message.value = ''
  try {
    await props.repository.patchBackgroundMetadata(background.id, patch)
    message.value = t('admin.backgrounds.metadataSaved') || 'Background metadata saved.'
    await load()
  } catch {
    message.value = t('admin.backgrounds.metadataFailed') || 'Background metadata could not be saved.'
  } finally {
    busyId.value = null
  }
}

function statusVariant(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'published') return 'success'
  if (status === 'draft') return 'warning'
  return 'neutral'
}

function backgroundStatusLabel(status: AdminBackground['status']): string {
  if (status === 'published') return t('admin.backgrounds.publishedChip') || 'published'
  if (status === 'draft') return t('admin.backgrounds.draftChip') || 'draft'
  if (status === 'archived') return t('admin.backgrounds.archivedChip') || 'archived'
  return status
}

function backgroundTitle(background: AdminBackground): string {
  const title = background.title?.trim()
  if (title) return title
  return t('admin.backgrounds.untitled') || 'Untitled background'
}

onMounted(load)
</script>

<template>
  <div class="background-manager" data-background-manager>
    <AdminPageHeader
      :title="t('admin.backgrounds.title') || 'Backgrounds'"
      :subtitle="t('admin.backgrounds.subtitle') || 'Manage ambient images and background videos for study sessions.'"
    />

    <AdminConfirmDialog
      :open="confirmingPurgeId !== null"
      :loading="busyId === backgroundToPurge?.id"
      :teleport="false"
      variant="danger"
      :title="t('admin.backgrounds.purgeConfirmTitle') || 'Purge background permanently'"
      :description="t('admin.backgrounds.purgeConfirmDescDetailed') || 'This cannot be undone. Uploaded media is permanently deleted from storage. Shipped media is never removed from the repository — it is only tombstoned, so its original files stay intact.'"
      :confirm-text="t('admin.backgrounds.purgeBtn') || 'Purge permanently'"
      :cancel-text="t('admin.catalogue.cancel') || 'Cancel'"
      dialog-data-attr="data-background-purge-dialog"
      confirm-data-attr="data-background-purge-confirm"
      cancel-data-attr="data-background-purge-cancel"
      @cancel="confirmingPurgeId = null"
      @confirm="onConfirmPurge"
    />

    <!-- Upload Drop Zone -->
    <div
      class="background-manager__upload-zone"
      :class="{ 'background-manager__upload-zone--dragging': isDragging }"
      @dragover.prevent="isDragging = true"
      @dragleave.prevent="isDragging = false"
      @drop.prevent="onDrop"
    >
      <div class="background-manager__upload">
        <label>
          <span class="background-manager__upload-title">{{ t('admin.backgrounds.upload') || 'Upload background' }}</span>
          <span class="background-manager__upload-subtitle">{{ t('admin.backgrounds.dropPrompt') || 'Drag & drop or click to choose file' }}</span>
          <input
            data-background-upload
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
            :disabled="busyId !== null"
            @change="onUpload"
          />
        </label>
        <p class="background-manager__specs">
          {{ t('admin.backgrounds.uploadSpecs') || 'Images: JPEG, PNG or WebP up to 12 MB and 7680 × 4320. Videos: MP4, WebM or MOV up to 200 MB and 2 minutes.' }}
        </p>
        <!-- This boundary must describe what the pipeline actually does. It
             previously claimed video upload was unavailable, which contradicts
             both the file picker and the Worker's multipart validation path. -->
        <p class="background-manager__boundary" data-background-video-boundary>
          {{ t('admin.backgrounds.boundary') || 'Videos are converted in this browser (AVC WebCodecs required) into 1080p and 1440p MP4 with no audio, plus a thumbnail, and uploaded together. The server re-validates both versions before storing a draft; a raw video sent without that conversion is refused.' }}
        </p>
      </div>
    </div>

    <div v-if="conversionProgress !== null" role="status" data-background-conversion>
      <p>{{ t('admin.backgrounds.converting') }} {{ conversionProgress }}%</p>
      <progress max="100" :value="conversionProgress" :aria-label="t('admin.backgrounds.converting')" />
      <button type="button" @click="uploadController?.abort()">{{ t('admin.backgrounds.cancelConversion') }}</button>
    </div>

    <datalist id="background-manager-collections">
      <option v-for="option in collectionOptions" :key="option" :value="option" />
    </datalist>

    <p v-if="state === 'loading'" class="background-manager__status" role="status">{{ t('admin.backgrounds.loading') || 'Loading background media...' }}</p>
    <div v-else-if="state === 'unavailable'" class="background-manager__error" role="alert">
      <p>{{ message }}</p>
      <button type="button" @click="load">{{ t('admin.backgrounds.retry') || 'Retry' }}</button>
    </div>
    <p v-else-if="backgrounds.length === 0" class="background-manager__empty" data-background-empty>
      {{ t('admin.backgrounds.empty') || 'No background media has been uploaded.' }}
    </p>

    <!-- Background Catalogue Grid -->
    <ul v-else class="background-manager__list">
      <li
        v-for="background in backgrounds"
        :key="background.id"
        class="background-manager__item"
        :data-background-id="background.id"
        :data-background-status="background.status"
      >
        <div class="background-manager__preview-wrap">
          <img v-if="background.kind === 'image'" :src="background.mediaUrl" :alt="t('admin.backgrounds.previewAlt') || 'Background preview'" loading="lazy" />
          <video v-else :src="background.mediaUrl" :poster="background.posterUrl ?? undefined" :aria-label="t('admin.backgrounds.previewAlt') || 'Background preview'" muted playsinline preload="metadata" />
          <div class="background-manager__badge-overlay">
            <AdminStatusChip :variant="statusVariant(background.status)" size="sm">
              {{ backgroundStatusLabel(background.status) }}
            </AdminStatusChip>
            <span class="background-manager__format-tag">{{ background.kind }}</span>
            <AdminStatusChip v-if="background.isShipped" variant="info" size="sm">
              {{ t('admin.backgrounds.shippedBadge') || 'Shipped' }}
            </AdminStatusChip>
          </div>
        </div>

        <div class="background-manager__details">
          <h3 class="background-manager__title">{{ backgroundTitle(background) }}</h3>
          <p class="background-manager__resolution">{{ background.width }} × {{ background.height }}</p>
          <p>{{ t('admin.backgrounds.statusLabel') || 'Status' }}: <strong>{{ backgroundStatusLabel(background.status) }}</strong> · {{ t('admin.backgrounds.revisionLabel') || 'revision' }} {{ background.revision }}</p>
          <p>{{ t('admin.backgrounds.rightsLabel') || 'Rights/provenance' }}: <strong>{{ background.rightsStatus }}</strong></p>
          <p>{{ t('admin.backgrounds.posterLabel') || 'Poster' }}: {{ background.kind === 'image' ? (t('admin.backgrounds.posterNotRequired') || 'not required') : (background.posterUrl ? (t('admin.backgrounds.posterAvailable') || 'available') : (t('admin.backgrounds.posterManualRequired') || 'manual poster required')) }}</p>
        </div>

        <details class="background-manager__editor">
          <summary class="background-manager__editor-summary">{{ t('admin.backgrounds.editMetadata') || 'Edit metadata' }}</summary>
          <form v-if="drafts[background.id]" class="background-manager__editor-form" data-background-metadata-form @submit.prevent="saveMetadata(background)">
            <label class="background-manager__field">
              <span>{{ t('admin.backgrounds.fieldTitle') || 'Title' }}</span>
              <input
                v-model="drafts[background.id].title"
                data-background-metadata-title
                type="text"
                maxlength="120"
                :disabled="busyId !== null"
              />
            </label>
            <label class="background-manager__field">
              <span>{{ t('admin.backgrounds.fieldGame') || 'Game' }}</span>
              <select v-model="drafts[background.id].game" data-background-metadata-game :disabled="busyId !== null">
                <option value=""></option>
                <option value="zzz">zzz</option>
                <option value="genshin">genshin</option>
                <option value="hsr">hsr</option>
                <option value="custom">{{ t('admin.backgrounds.gameCustom') || 'Other / custom' }}</option>
              </select>
            </label>
            <label v-if="drafts[background.id].game === 'custom'" class="background-manager__field">
              <span>{{ t('admin.backgrounds.fieldGame') || 'Game' }}</span>
              <input
                v-model="drafts[background.id].customGame"
                data-background-metadata-game-custom
                type="text"
                :disabled="busyId !== null"
              />
            </label>
            <label class="background-manager__field">
              <span>{{ t('admin.backgrounds.fieldCollection') || 'Collection' }}</span>
              <input
                v-model="drafts[background.id].collection"
                data-background-metadata-collection
                type="text"
                list="background-manager-collections"
                :disabled="busyId !== null"
              />
            </label>
            <label class="background-manager__field">
              <span>{{ t('admin.backgrounds.fieldDisplayOrder') || 'Display order' }}</span>
              <input
                v-model="drafts[background.id].displayOrder"
                data-background-metadata-order
                type="number"
                min="0"
                :disabled="busyId !== null"
              />
            </label>
            <button
              type="submit"
              class="background-manager__btn background-manager__btn--save"
              data-background-metadata-save
              :disabled="busyId !== null"
            >
              {{ t('admin.backgrounds.saveMetadata') || 'Save changes' }}
            </button>
          </form>
        </details>

        <div class="background-manager__actions">
          <button
            v-if="background.status === 'draft'"
            data-background-publish
            type="button"
            class="background-manager__btn background-manager__btn--publish"
            :disabled="busyId !== null"
            @click="lifecycle(background, 'publish')"
          >
            {{ t('admin.backgrounds.publishBtn') || 'Publish' }}
          </button>
          <button
            v-if="background.status === 'published'"
            data-background-archive
            type="button"
            class="background-manager__btn background-manager__btn--archive"
            :disabled="busyId !== null"
            @click="lifecycle(background, 'archive')"
          >
            {{ t('admin.backgrounds.disableBtn') || 'Disable' }}
          </button>
          <button
            v-if="background.status === 'archived'"
            data-background-restore
            type="button"
            class="background-manager__btn background-manager__btn--restore"
            :disabled="busyId !== null"
            @click="lifecycle(background, 'restore')"
          >
            {{ t('admin.backgrounds.enableBtn') || 'Re-enable' }}
          </button>
          <label v-if="!background.isShipped && background.status !== 'archived'" class="background-manager__replace">
            <span>{{ t('admin.backgrounds.replaceBtn') || 'Replace media' }}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime" :disabled="busyId !== null" @change="onReplace(background, $event)" />
          </label>
          <button
            v-if="background.status === 'archived'"
            data-background-purge
            type="button"
            class="background-manager__btn background-manager__btn--purge"
            :disabled="busyId !== null"
            @click="confirmingPurgeId = background.id"
          >
            {{ t('admin.backgrounds.deletePermanentlyBtn') || 'Permanently delete' }}
          </button>
        </div>
      </li>
    </ul>

    <p v-if="state === 'ready' && message" class="background-manager__toast" role="status" aria-live="polite">
      {{ message }}
    </p>
  </div>
</template>

<style scoped>
.background-manager {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1.25rem;
}

.background-manager p,
.background-manager h3 {
  margin: 0;
}

.background-manager__upload-zone {
  border: 2px dashed rgba(255, 255, 255, 0.15);
  border-radius: var(--radius-surface);
  background: var(--colour-surface-opaque);
  transition: all 0.2s ease;
}

.background-manager__upload-zone--dragging {
  border-color: #38bdf8;
  background: rgba(56, 189, 248, 0.05);
}

.background-manager__upload {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.75rem;
  padding: 1.5rem;
}

.background-manager__upload label {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.375rem;
  cursor: pointer;
}

.background-manager__upload-title {
  font-size: 1.0625rem;
  font-weight: 700;
  color: var(--colour-text-primary);
}

.background-manager__upload-subtitle {
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
}

.background-manager__upload input[type="file"] {
  min-width: 0;
  max-width: 100%;
  margin-top: 0.5rem;
  padding: 0.5rem;
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--glass-edge);
  color: var(--colour-text-primary);
}

.background-manager__specs {
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
}

.background-manager__boundary {
  color: #f59e0b;
  font-size: 0.8125rem;
  line-height: 1.5;
  background: rgba(245, 158, 11, 0.08);
  padding: 0.625rem 0.875rem;
  border-radius: 0.5rem;
  border: 1px solid rgba(245, 158, 11, 0.2);
}

.background-manager__list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  gap: 1.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.background-manager__item {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
  overflow: hidden;
  transition: transform 0.15s ease, border-color 0.15s ease;
}

.background-manager__item:hover {
  border-color: rgba(255, 255, 255, 0.15);
}

.background-manager__preview-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 0.5rem;
  overflow: hidden;
  background: #080d16;
}

.background-manager__preview-wrap img,
.background-manager__preview-wrap video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.background-manager__badge-overlay {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  gap: 6px;
  align-items: center;
}

.background-manager__format-tag {
  font-size: 0.6875rem;
  text-transform: uppercase;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  color: #f8fafc;
}

.background-manager__details {
  display: grid;
  gap: 0.375rem;
  min-width: 0;
}

.background-manager__title {
  font-size: 1rem;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.background-manager__resolution {
  font-variant-numeric: tabular-nums;
  color: var(--colour-text-primary);
}

.background-manager__details p {
  color: var(--colour-text-muted);
  font-size: 0.8125rem;
  line-height: 1.45;
}

.background-manager__editor {
  border: 1px solid var(--glass-edge);
  border-radius: 0.5rem;
  background: rgba(0, 0, 0, 0.18);
  overflow: hidden;
}

.background-manager__editor-summary {
  cursor: pointer;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--colour-text-primary);
}

.background-manager__editor-form {
  display: grid;
  gap: 0.625rem;
  padding: 0.75rem;
  border-top: 1px solid var(--glass-edge);
}

.background-manager__field {
  display: grid;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--colour-text-muted);
}

.background-manager__field input,
.background-manager__field select {
  min-width: 0;
  width: 100%;
  padding: 0.4rem 0.5rem;
  border-radius: 0.4rem;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--glass-edge);
  color: var(--colour-text-primary);
  font: inherit;
}

.background-manager__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  margin-top: auto;
}

.background-manager__btn,
.background-manager__replace {
  min-height: 2.25rem;
  padding: 0.375rem 0.75rem;
  color: var(--colour-text-primary);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--glass-edge);
  border-radius: 0.5rem;
  font: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.background-manager__btn:hover,
.background-manager__replace:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.2);
}

.background-manager__btn--publish,
.background-manager__btn--save {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.28);
  color: #4ade80;
}

.background-manager__btn--archive {
  background: rgba(234, 179, 8, 0.12);
  border-color: rgba(234, 179, 8, 0.28);
  color: #facc15;
}

.background-manager__btn--restore {
  background: rgba(59, 130, 246, 0.12);
  border-color: rgba(59, 130, 246, 0.28);
  color: #60a5fa;
}

.background-manager__btn--purge {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.25);
  color: #f87171;
}

.background-manager__btn--purge-confirm {
  background: #dc2626;
  color: #ffffff;
  border: none;
  font-weight: 600;
}

.background-manager__replace input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}

.background-manager__confirm {
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.35);
  border-radius: 0.5rem;
  font-size: 0.8125rem;
  color: #fca5a5;
}

.background-manager__confirm-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.background-manager__toast {
  padding: 0.75rem 1rem;
  background: rgba(34, 197, 94, 0.15);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: #4ade80;
  border-radius: 0.5rem;
  font-size: 0.875rem;
}

@media (max-width: 30rem) {
  .background-manager__actions > * {
    width: 100%;
    justify-content: center;
  }

  .background-manager__editor-form .background-manager__btn {
    width: 100%;
  }
}
</style>
