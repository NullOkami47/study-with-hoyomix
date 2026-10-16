<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { GripVertical } from 'lucide-vue-next'
import type { AdminProvider } from './client'
import AdminConfirmDialog from './primitives/AdminConfirmDialog.vue'
import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'
import { formatRelative as formatRelativeHelper } from './format'

const CANONICAL_PROVIDER_IDS = ['chksz', 'lx', 'jellyfin'] as const

const props = defineProps<{
  providers: AdminProvider[]
  mutating?: string | null
}>()

const emit = defineEmits<{
  (event: 'toggle', key: string, enabled: boolean, confirmation?: string, reason?: string): void
  (event: 'order', providerIds: string[]): void
  (event: 'owner-fallback', enabled: boolean): void
  (event: 'check-health'): void
}>()

const { locale } = usePreferences()

function t(key: string, params?: Record<string, unknown>): string {
  return translate(locale.value, key as TranslationKey, params)
}

const DASH = '\u2014'

const checking = ref(false)
const pendingDisable = ref<AdminProvider | null>(null)
const shutdownConfirmation = ref('')
const shutdownReason = ref('')
const shutdownError = ref('')
const localOrder = ref<string[] | null>(null)
const draggingKey = ref<string | null>(null)
const dragOverKey = ref<string | null>(null)
const draggedIndex = ref<number | null>(null)

const isMutating = computed(() => props.mutating !== null && props.mutating !== undefined)

const sortedCanonicalProviders = computed(() => {
  const allowed = new Set<string>(CANONICAL_PROVIDER_IDS)
  return props.providers
    .filter((p) => allowed.has(p.key))
    .slice()
    .sort((a, b) => a.priority - b.priority || CANONICAL_PROVIDER_IDS.indexOf(a.key as any) - CANONICAL_PROVIDER_IDS.indexOf(b.key as any))
})

const canonicalProviders = computed(() => {
  const base = sortedCanonicalProviders.value
  if (!localOrder.value) return base
  const map = new Map(base.map((p) => [p.key, p]))
  const result: AdminProvider[] = []
  for (const key of localOrder.value) {
    const p = map.get(key)
    if (p) result.push(p)
  }
  for (const p of base) {
    if (!result.some((r) => r.key === p.key)) result.push(p)
  }
  return result
})

watch(() => props.mutating, (next, prev) => {
  if (prev === 'order' && !next) {
    localOrder.value = null
  }
})

watch(() => props.providers, () => {
  localOrder.value = null
})

function providerDisplayName(key: string): string {
  if (key === 'chksz') return 'ChKSz BYOK'
  if (key === 'lx') return 'LX Music'
  if (key === 'jellyfin') return 'Jellyfin'
  return key
}

function providerPolicyLabel(provider: AdminProvider): string {
  if (provider.automaticPolicy === 'direct') return t('admin.providers.policy.automatic') || 'Automatic direct audio'
  return t('admin.providers.policy.manual') || 'Manual-only'
}

const formatLatency = (latencyMs: number | null): string =>
  latencyMs === null ? DASH : `${latencyMs} ms`

const formatRelative = (checkedAt: number | null): string =>
  formatRelativeHelper(checkedAt, locale.value)

const effectiveCount = computed(() =>
  canonicalProviders.value.filter((provider) => provider.effectiveEnabled).length,
)

function onToggle(event: Event, provider: AdminProvider): void {
  const input = event.target as HTMLInputElement
  const enabled = input.checked
  // Keep the control bound to persisted Admin intent while the mutation is in flight.
  // The parent will apply a new checked value only after the server confirms the update.
  input.checked = provider.adminEnabled
  if (!enabled && provider.effectiveEnabled && effectiveCount.value === 1) {
    shutdownConfirmation.value = ''
    shutdownReason.value = ''
    shutdownError.value = ''
    pendingDisable.value = provider
    return
  }
  emit('toggle', provider.key, enabled)
}

function cancelDisable(): void {
  pendingDisable.value = null
  shutdownConfirmation.value = ''
  shutdownReason.value = ''
  shutdownError.value = ''
}

function onConfirmShutdown(payload: { confirmation?: string; reason?: string }): void {
  if (!pendingDisable.value) return
  const reason = (payload.reason ?? shutdownReason.value).trim()
  const confirmation = (payload.confirmation ?? shutdownConfirmation.value).trim()
  if (confirmation !== 'DISABLE ALL PLAYBACK' || reason.length === 0) {
    shutdownError.value = t('admin.providers.shutdown.errorMismatch') || 'Enter the exact confirmation phrase and an internal reason.'
    return
  }
  emit('toggle', pendingDisable.value.key, false, confirmation, reason)
  pendingDisable.value = null
}

function moveUp(index: number): void {
  if (index <= 0 || isMutating.value) return
  const nextOrder = canonicalProviders.value.map((p) => p.key)
  const temp = nextOrder[index]
  nextOrder[index] = nextOrder[index - 1]
  nextOrder[index - 1] = temp
  localOrder.value = nextOrder
  emit('order', nextOrder)
}

function moveDown(index: number): void {
  if (index >= canonicalProviders.value.length - 1 || isMutating.value) return
  const nextOrder = canonicalProviders.value.map((p) => p.key)
  const temp = nextOrder[index]
  nextOrder[index] = nextOrder[index + 1]
  nextOrder[index + 1] = temp
  localOrder.value = nextOrder
  emit('order', nextOrder)
}

function onResetOrder(): void {
  if (isMutating.value) return
  const nextOrder = ['chksz', 'lx', 'jellyfin']
  localOrder.value = nextOrder
  emit('order', nextOrder)
}

interface ActiveDrag {
  pointerId: number
  sourceKey: string
  targetKey?: string
  handle: HTMLElement
  move: (event: PointerEvent) => void
  finish: (event: PointerEvent) => void
  cancel: (event: PointerEvent) => void
}

let activeDrag: ActiveDrag | undefined

function targetKeyFromPoint(clientX: number, clientY: number): string | undefined {
  const element = document.elementFromPoint(clientX, clientY)
  const row = element?.closest<HTMLElement>('[data-provider-key]')
  const key = row?.getAttribute('data-provider-key')
  if (!key || !CANONICAL_PROVIDER_IDS.includes(key as any)) return undefined
  return key
}

function releaseDragCapture(): void {
  if (!activeDrag) return
  activeDrag.handle.removeEventListener('pointermove', activeDrag.move)
  activeDrag.handle.removeEventListener('pointerup', activeDrag.finish)
  activeDrag.handle.removeEventListener('pointercancel', activeDrag.cancel)
  try {
    activeDrag.handle.releasePointerCapture(activeDrag.pointerId)
  } catch {
    /* Capture cleanup enhancement. */
  }
  activeDrag = undefined
  draggingKey.value = null
  dragOverKey.value = null
}

function finishDrag(event: PointerEvent): void {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return
  const { sourceKey, targetKey } = activeDrag
  releaseDragCapture()
  if (!targetKey || sourceKey === targetKey || isMutating.value) return

  const nextOrder = canonicalProviders.value.map((p) => p.key)
  const fromIndex = nextOrder.indexOf(sourceKey)
  const toIndex = nextOrder.indexOf(targetKey)
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return

  const [removed] = nextOrder.splice(fromIndex, 1)
  nextOrder.splice(toIndex, 0, removed)
  localOrder.value = nextOrder
  emit('order', nextOrder)
}

function cancelDrag(event: PointerEvent): void {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return
  releaseDragCapture()
}

function startDrag(event: PointerEvent, sourceKey: string): void {
  if (event.button > 0 || activeDrag || isMutating.value) return
  const handle = event.currentTarget
  if (!(handle instanceof HTMLElement)) return
  event.preventDefault()
  draggingKey.value = sourceKey
  dragOverKey.value = null

  const move = (moveEvent: PointerEvent): void => {
    if (!activeDrag || moveEvent.pointerId !== activeDrag.pointerId) return
    const target = targetKeyFromPoint(moveEvent.clientX, moveEvent.clientY)
    activeDrag.targetKey = target
    dragOverKey.value = target ?? null
  }
  const finish = (finishEvent: PointerEvent): void => finishDrag(finishEvent)
  const cancel = (cancelEvent: PointerEvent): void => cancelDrag(cancelEvent)

  activeDrag = { pointerId: event.pointerId, sourceKey, handle, move, finish, cancel }
  try {
    handle.setPointerCapture(event.pointerId)
  } catch {
    /* Fallback if setPointerCapture is unsupported */
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', cancel)
}

onBeforeUnmount(releaseDragCapture)

function onDragStart(index: number, event: DragEvent): void {
  if (isMutating.value) {
    event.preventDefault()
    return
  }
  draggedIndex.value = index
  const provider = canonicalProviders.value[index]
  if (provider) draggingKey.value = provider.key
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function onDragOver(index: number, event: DragEvent): void {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  const provider = canonicalProviders.value[index]
  if (provider) dragOverKey.value = provider.key
}

function onDrop(targetIndex: number, event: DragEvent): void {
  event.preventDefault()
  const fromIndex = draggedIndex.value
  draggedIndex.value = null
  draggingKey.value = null
  dragOverKey.value = null

  if (fromIndex === null || fromIndex === targetIndex || isMutating.value) {
    return
  }
  const nextOrder = canonicalProviders.value.map((p) => p.key)
  const [removed] = nextOrder.splice(fromIndex, 1)
  nextOrder.splice(targetIndex, 0, removed)
  localOrder.value = nextOrder
  emit('order', nextOrder)
}

function onDragEnd(): void {
  draggedIndex.value = null
  draggingKey.value = null
  dragOverKey.value = null
}

function onOwnerFallback(event: Event): void {
  emit('owner-fallback', (event.target as HTMLInputElement).checked)
}

async function onCheckHealth(): Promise<void> {
  if (checking.value) return
  checking.value = true
  try {
    emit('check-health')
  } finally {
    setTimeout(() => { checking.value = false }, 1000)
  }
}
</script>

<template>
  <section class="provider-controls" data-provider-controls data-provider-health-card>
    <header class="provider-controls__header">
      <h3>{{ t('admin.providers.controlsTitle') || 'Provider controls' }}</h3>
      <button
        type="button"
        class="provider-controls__check"
        data-provider-check-health
        :disabled="checking"
        @click="onCheckHealth"
      >
        {{ checking ? (t('admin.providers.refreshing') || 'Refreshing...') : (t('admin.providers.refreshHealth') || 'Refresh status') }}
      </button>
    </header>

    <AdminConfirmDialog
      :open="pendingDisable !== null"
      :teleport="false"
      variant="danger"
      :title="t('admin.providers.shutdown.title') || 'Disable all playback?'"
      :description="(t('admin.providers.shutdown.detailedDesc') || 'This will disable the last {count} effective provider. Online playback will be unavailable until an admin re-enables a provider. Local Library and timers remain available.').replace('{count}', String(effectiveCount))"
      :confirm-text="t('admin.providers.shutdown.confirmBtn') || 'Confirm'"
      :cancel-text="t('admin.providers.shutdown.cancelBtn') || 'Cancel'"
      require-phrase="DISABLE ALL PLAYBACK"
      :require-reason="true"
      dialog-data-attr="data-provider-shutdown-dialog"
      phrase-data-attr="data-provider-shutdown-confirmation"
      reason-data-attr="data-provider-shutdown-reason"
      cancel-data-attr="data-provider-shutdown-cancel"
      confirm-data-attr="data-provider-shutdown-confirm"
      error-data-attr="data-provider-shutdown-error"
      :error="shutdownError"
      :disable-invalid="false"
      @cancel="cancelDisable"
      @confirm="onConfirmShutdown"
    />

    <ol class="provider-controls__list">
      <li
        v-for="(provider, index) in canonicalProviders"
        :key="provider.key"
        class="provider-controls__item"
        :class="{
          'provider-controls__item--dragging': draggingKey === provider.key,
          'provider-controls__item--drop-target': dragOverKey === provider.key && draggingKey !== provider.key,
        }"
        :data-provider-key="provider.key"
        :data-provider-status="provider.status"
        :data-provider-dragging="draggingKey === provider.key ? 'true' : 'false'"
        :data-provider-drop-target="dragOverKey === provider.key && draggingKey !== provider.key ? 'true' : 'false'"
        draggable="true"
        @dragstart="onDragStart(index, $event)"
        @dragover="onDragOver(index, $event)"
        @drop="onDrop(index, $event)"
        @dragend="onDragEnd"
      >
        <div class="provider-controls__order-lead">
          <button
            type="button"
            class="provider-controls__drag-handle"
            :data-provider-drag-handle="provider.key"
            :aria-label="t('admin.providers.reorderAria', { provider: providerDisplayName(provider.key) })"
            :aria-grabbed="draggingKey === provider.key ? 'true' : 'false'"
            :disabled="isMutating"
            @pointerdown="startDrag($event, provider.key)"
          >
            <GripVertical :size="16" aria-hidden="true" />
          </button>

          <span class="provider-controls__order-badge" data-provider-order-badge>
            {{ index + 1 }}
          </span>
        </div>

        <span class="provider-controls__name">
          <span
            class="provider-health__dot"
            :class="`provider-health__dot--${provider.status}`"
            aria-hidden="true"
          />
          {{ providerDisplayName(provider.key) }}
          <span
            class="provider-health__status"
            :data-provider-status-text="provider.status"
          >{{ provider.status }}</span>
        </span>

        <span class="provider-controls__policy" :data-provider-policy="provider.key">
          {{ providerPolicyLabel(provider) }}
        </span>

        <label class="provider-controls__toggle">
          <input
            type="checkbox"
            :checked="provider.adminEnabled"
            :disabled="mutating === provider.key || mutating === 'order' || (!provider.deploymentAvailable && !provider.adminEnabled)"
            :data-provider-toggle="provider.key"
            @change="onToggle($event, provider)"
          />
          <span>{{ provider.adminEnabled ? (t('admin.providers.enabledByAdmin') || 'Enabled by Admin') : (t('admin.providers.disabledByAdmin') || 'Disabled by Admin') }}</span>
        </label>

        <span class="provider-controls__state">
          <span :data-provider-availability="provider.key">
            {{ provider.deploymentAvailable ? (t('admin.providers.availableInDeployment') || 'Available in this deployment') : (t('admin.providers.unavailableInDeployment') || 'Unavailable in this deployment') }}
          </span>
          <span :data-provider-effective="provider.key">
            {{ provider.effectiveEnabled ? (t('admin.providers.effective') || 'Effective') : (t('admin.providers.notEffective') || 'Not effective') }}
          </span>
          <span class="provider-controls__diagnostics">
            <span class="provider-health__metric provider-health__metric--latency">
              {{ formatLatency(provider.latencyMs) }}
            </span>
            <span
              class="provider-health__metric provider-health__metric--failure"
              :data-provider-failure="provider.failureClass ?? 'none'"
            >
              {{ provider.failureClass ?? DASH }}
            </span>
            <span class="provider-health__metric provider-health__metric--checked">
              {{ formatRelative(provider.checkedAt) }}
            </span>
          </span>
        </span>

        <div class="provider-controls__order-actions">
          <button
            type="button"
            class="provider-controls__order-btn provider-controls__order-btn--up"
            :data-provider-move-up="provider.key"
            :aria-label="t('admin.providers.moveUpAria', { provider: providerDisplayName(provider.key) })"
            :disabled="index === 0 || isMutating"
            @click="moveUp(index)"
          >
            <span aria-hidden="true">&uarr;</span>
          </button>
          <button
            type="button"
            class="provider-controls__order-btn provider-controls__order-btn--down"
            :data-provider-move-down="provider.key"
            :aria-label="t('admin.providers.moveDownAria', { provider: providerDisplayName(provider.key) })"
            :disabled="index === canonicalProviders.length - 1 || isMutating"
            @click="moveDown(index)"
          >
            <span aria-hidden="true">&darr;</span>
          </button>
        </div>

        <label
          v-if="provider.key === 'chksz'"
          class="provider-controls__owner-fallback"
          data-chksz-owner-fallback
        >
          <input
            type="checkbox"
            :checked="provider.ownerFallbackEnabled === true"
            :disabled="mutating === provider.key || mutating === 'order' || (provider.ownerKeyConfigured !== true && provider.ownerFallbackEnabled !== true)"
            @change="onOwnerFallback"
          />
          <span class="provider-controls__owner-fallback-copy">
            <strong>{{ t('admin.providers.chkszFallbackTitle') || 'Use Owner API key as fallback' }}</strong>
            <span v-if="provider.ownerFallbackUsable">{{ t('admin.providers.chkszFallbackUsable') || 'Owner fallback usable' }}</span>
            <span v-else-if="provider.ownerKeyConfigured">{{ t('admin.providers.chkszFallbackConfigured') || 'Owner key configured; fallback is off' }}</span>
            <span v-else>{{ t('admin.providers.chkszFallbackNotConfigured') || 'No Owner key is configured in this deployment' }}</span>
          </span>
        </label>
      </li>
    </ol>

    <footer class="provider-controls__footer">
      <button
        type="button"
        class="provider-controls__reset-order"
        data-provider-order-reset
        :disabled="isMutating"
        @click="onResetOrder"
      >
        {{ t('admin.providers.resetDefaultOrder') }}
      </button>
    </footer>
  </section>
</template>

<style scoped>
.provider-controls {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
  padding: 1rem 1.25rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
}

.provider-controls__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.provider-controls__header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.provider-controls__check {
  min-height: 2.25rem;
  padding: 0.375rem 0.75rem;
  color: var(--colour-accent-strong);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease;
}

.provider-controls__check:hover:not(:disabled) {
  filter: var(--control-hover-filter);
}

.provider-controls__check:active:not(:disabled) {
  transform: scale(0.96);
  filter: var(--control-active-filter);
}

.provider-controls__check:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.provider-controls__dialog {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgb(0 0 0 / 55%);
}

.provider-controls__confirmation {
  display: grid;
  gap: 0.75rem;
  width: min(28rem, 100%);
  padding: 1.25rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
}

.provider-controls__confirmation h4,
.provider-controls__confirmation p {
  margin: 0;
}

.provider-controls__confirmation label {
  display: grid;
  gap: 0.25rem;
}

.provider-controls__confirmation span {
  color: var(--colour-text-muted);
  font-size: 0.875rem;
}

.provider-controls__confirmation input,
.provider-controls__confirmation textarea {
  width: 100%;
  padding: 0.5rem;
  color: inherit;
  background: rgb(255 255 255 / 5%);
  border: var(--glass-border);
  border-radius: 0.5rem;
  font: inherit;
}

.provider-controls__dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.provider-controls__dialog-actions button {
  min-height: 2.25rem;
  padding: 0.375rem 0.75rem;
  color: var(--colour-accent-strong);
  background: rgb(255 255 255 / 5%);
  border: var(--glass-border);
  border-radius: 0.5rem;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.provider-controls__list {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.provider-controls__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) minmax(8rem, auto) auto minmax(8rem, auto) auto;
  align-items: center;
  gap: 0.875rem;
  min-width: 0;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--glass-edge);
  transition: background-color var(--motion-duration) ease, opacity var(--motion-duration) ease;
}

.provider-controls__item:last-child {
  border-bottom: none;
}

.provider-controls__item--dragging,
.provider-controls__item[data-provider-dragging="true"] {
  opacity: 0.55;
  background: rgb(255 255 255 / 4%);
}

.provider-controls__item--drop-target,
.provider-controls__item[data-provider-drop-target="true"] {
  outline: 2px dashed var(--colour-accent);
  outline-offset: -2px;
  border-radius: 0.375rem;
}

.provider-controls__order-lead {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}

.provider-controls__drag-handle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  color: var(--colour-text-muted);
  background: transparent;
  border: none;
  border-radius: 0.25rem;
  cursor: grab;
  touch-action: none;
  user-select: none;
  transition: color var(--motion-duration) ease, background var(--motion-duration) ease;
}

.provider-controls__drag-handle:hover:not(:disabled) {
  color: var(--colour-text-primary);
  background: rgb(255 255 255 / 6%);
}

.provider-controls__drag-handle:active:not(:disabled) {
  cursor: grabbing;
}

.provider-controls__drag-handle:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

@media (max-width: 768px) {
  .provider-controls__item {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
      "badge name policy"
      "toggle toggle toggle"
      "state state state"
      "actions actions actions";
    align-items: start;
    gap: 0.4375rem 0.625rem;
    padding: 0.625rem 0;
  }

  .provider-controls__order-lead { grid-area: badge; }
  .provider-controls__order-badge { grid-area: badge; }
  .provider-controls__name { grid-area: name; }
  .provider-controls__policy { grid-area: policy; }
  .provider-controls__toggle { grid-area: toggle; }
  .provider-controls__state { grid-area: state; }
  .provider-controls__order-actions { grid-area: actions; }
}

.provider-controls__order-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--colour-accent-strong);
  background: rgb(255 255 255 / 6%);
  border: var(--glass-border);
  border-radius: 0.375rem;
}

.provider-controls__name {
  font-weight: 600;
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}

.provider-controls__policy {
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
}

.provider-controls__toggle {
  display: inline-flex;
  min-height: 2rem;
  gap: 0.4375rem;
  align-items: center;
  color: var(--colour-text-muted);
  font-size: 0.875rem;
}

.provider-controls__toggle input {
  width: 1.25rem;
  min-height: 1.25rem;
  padding: 0;
  accent-color: var(--colour-accent);
  cursor: pointer;
}

.provider-controls__toggle input:disabled {
  cursor: not-allowed;
}

.provider-controls__state {
  display: grid;
  gap: 0.125rem;
  color: var(--colour-text-muted);
  font-size: 0.75rem;
}

.provider-controls__order-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
}

.provider-controls__order-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.25rem;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease;
}

.provider-controls__order-btn:hover:not(:disabled) {
  filter: var(--control-hover-filter);
}

.provider-controls__order-btn:active:not(:disabled) {
  transform: scale(0.96);
  filter: var(--control-active-filter);
}

.provider-controls__order-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.provider-controls__footer {
  display: flex;
  justify-content: flex-start;
  padding-top: 0.5rem;
}

.provider-controls__reset-order {
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
  color: var(--colour-accent-strong);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease;
}

.provider-controls__reset-order:hover:not(:disabled) {
  filter: var(--control-hover-filter);
}

.provider-controls__reset-order:active:not(:disabled) {
  transform: scale(0.96);
  filter: var(--control-active-filter);
}

.provider-controls__reset-order:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.provider-controls__owner-fallback {
  grid-column: 1 / -1;
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  min-height: 2.75rem;
  padding: 0.5rem 0.75rem;
  color: var(--colour-text-muted);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  font-size: 0.875rem;
}

.provider-controls__owner-fallback input {
  width: 1.25rem;
  min-height: 1.25rem;
  margin: 0;
  accent-color: var(--colour-accent);
}

.provider-health__dot {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  margin-right: 0.375rem;
  vertical-align: middle;
}

.provider-health__dot--healthy {
  background: #22c55e;
}

.provider-health__dot--degraded {
  background: #f59e0b;
}

.provider-health__dot--unavailable {
  background: #ef4444;
}

.provider-health__dot--unknown {
  background: #94a3b8;
}

.provider-health__status {
  margin-left: 0.375rem;
  padding: 0.125rem 0.375rem;
  font-size: 0.75rem;
  border-radius: 0.25rem;
  background: rgb(255 255 255 / 6%);
  text-transform: capitalize;
}

.provider-controls__diagnostics {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  margin-left: 0.5rem;
}

.provider-health__metric {
  font-size: 0.75rem;
  color: var(--colour-text-muted);
}

.provider-health__metric--failure {
  color: #f59e0b;
}

@media (max-width: 36rem) {
  .provider-controls__item {
    grid-template-columns: 1fr;
    grid-template-areas:
      "badge"
      "name"
      "toggle"
      "state"
      "actions";
    gap: 0.25rem;
  }
  .provider-controls__order-lead { grid-area: badge; }
  .provider-controls__order-badge { grid-area: badge; }
  .provider-controls__name { grid-area: name; }
  .provider-controls__toggle { grid-area: toggle; }
  .provider-controls__state { grid-area: state; }
  .provider-controls__order-actions { grid-area: actions; }
  .provider-controls__owner-fallback { grid-column: 1; }
}
</style>
