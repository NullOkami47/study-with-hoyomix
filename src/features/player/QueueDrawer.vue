<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from 'lucide-vue-next'

import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import QueuePanel from './QueuePanel.vue'
import { clampQueueSize, QUEUE_SIZE_KEY, readQueueSize } from './queueGeometry'
import type { PlaybackStore } from './store'

type QueueStore = Pick<PlaybackStore,
  'currentIndex' | 'playQueueIndex' | 'queue' | 'removeQueueIndex' | 'moveQueueItem' | 'playNext' | 'clearUpcomingQueue'
> & Partial<Pick<PlaybackStore, 'shuffle' | 'repeatMode' | 'setShuffle' | 'cycleRepeatMode'>>

const props = defineProps<{ store: QueueStore }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
const drawer = ref<HTMLElement>()
function initialSize() {
  if (typeof window === 'undefined') return clampQueueSize({ width: 512, height: 640 }, 1280, 800)
  let storage: Storage | undefined
  try { storage = window.localStorage } catch { /* Optional storage. */ }
  return readQueueSize(storage, window.innerWidth, window.innerHeight)
}
const size = ref(initialSize())
let opener: HTMLElement | undefined
let resizeStart: { x: number; y: number; width: number; height: number; pointerId: number } | undefined
function onResizePointerMove(event: PointerEvent): void {
  if (!resizeStart || resizeStart.pointerId !== event.pointerId) return
  size.value = clampQueueSize({
    width: resizeStart.width + resizeStart.x - event.clientX,
    height: resizeStart.height + event.clientY - resizeStart.y,
  }, window.innerWidth, window.innerHeight)
}
function onResizePointerEnd(event: PointerEvent): void {
  if (!resizeStart || resizeStart.pointerId !== event.pointerId) return
  resizeStart = undefined
  window.removeEventListener('pointermove', onResizePointerMove)
  window.removeEventListener('pointerup', onResizePointerEnd)
  window.removeEventListener('pointercancel', onResizePointerEnd)
  try { window.localStorage.setItem(QUEUE_SIZE_KEY, JSON.stringify(size.value)) } catch { /* Optional persistence. */ }
}
function beginResize(event: PointerEvent): void {
  if (event.button !== 0 || window.matchMedia?.('(max-width: 47.99rem)').matches) return
  event.preventDefault()
  resizeStart = { x: event.clientX, y: event.clientY, width: size.value.width, height: size.value.height, pointerId: event.pointerId }
  window.addEventListener('pointermove', onResizePointerMove)
  window.addEventListener('pointerup', onResizePointerEnd)
  window.addEventListener('pointercancel', onResizePointerEnd)
}
function keyboardResize(event: KeyboardEvent): void {
  const step = event.shiftKey ? 64 : 16
  const delta = {
    ArrowLeft: { width: step, height: 0 },
    ArrowRight: { width: -step, height: 0 },
    ArrowUp: { width: 0, height: -step },
    ArrowDown: { width: 0, height: step },
  }[event.key]
  if (!delta) return
  event.preventDefault()
  size.value = clampQueueSize({ width: size.value.width + delta.width, height: size.value.height + delta.height }, window.innerWidth, window.innerHeight)
  try { window.localStorage.setItem(QUEUE_SIZE_KEY, JSON.stringify(size.value)) } catch { /* Optional persistence. */ }
}
function clampToViewport(): void { size.value = clampQueueSize(size.value, window.innerWidth, window.innerHeight) }

onMounted(() => {
  if (document.activeElement instanceof HTMLElement) opener = document.activeElement
  drawer.value?.focus({ preventScroll: true })
  window.addEventListener('resize', clampToViewport)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', clampToViewport)
  window.removeEventListener('pointermove', onResizePointerMove)
  window.removeEventListener('pointerup', onResizePointerEnd)
  window.removeEventListener('pointercancel', onResizePointerEnd)
  if (opener?.isConnected && drawer.value?.contains(document.activeElement)) {
    opener.focus({ preventScroll: true })
  }
})


function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
  }
}

</script>

<template>
  <aside
    ref="drawer"
    class="queue-drawer liquid-popover"
    id="workspace-queue-drawer"
    data-queue-drawer
    role="dialog"
    aria-modal="false"
    aria-labelledby="queue-drawer-title"
    tabindex="-1"
    :style="{ '--queue-width': `${size.width}px`, '--queue-height': `${size.height}px` }"
    @keydown="onKeydown"
  >
    <header class="queue-drawer__header">
      <h2 id="queue-drawer-title">{{ text('queue.drawerLabel') }}</h2>
      <button type="button" data-queue-close :aria-label="text('queue.close')" @click="emit('close')"><X :size="20" aria-hidden="true" /></button>
    </header>
    <QueuePanel :store="props.store" />
    <button type="button" class="queue-drawer__resize" data-queue-resize :aria-label="text('queue.resize')" @pointerdown="beginResize" @keydown="keyboardResize" />
  </aside>
</template>

<style scoped>
.queue-drawer { position: fixed; top: 1rem; right: 1rem; z-index: var(--layer-workspace-queue-drawer); display: grid; grid-template-rows: auto minmax(0, 1fr); width: var(--queue-width); height: var(--queue-height); max-width: calc(100vw - 2rem); max-height: calc(100dvh - 2rem); overflow: hidden; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: var(--radius-surface); box-shadow: var(--glass-shadow); contain: layout; }
.queue-drawer__header { display: flex; gap: 1rem; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; border-block-end: var(--glass-border); }
.queue-drawer__header h2 { margin: 0; font-size: 1rem; }
.queue-drawer__header button { display: grid; width: 2.75rem; height: 2.75rem; padding: 0; place-items: center; color: var(--colour-text-primary); background: transparent; border: var(--glass-border); border-radius: 50%; cursor: pointer; }
.queue-drawer > :deep(.queue-panel) { min-height: 0; overflow: hidden; border-radius: 0; box-shadow: none; }
.queue-drawer__resize { position: absolute; bottom: 0; left: 0; width: 2.75rem; height: 2.75rem; border: 0; background: transparent; cursor: nesw-resize; touch-action: none; }
.queue-drawer__resize::after { content: ''; position: absolute; bottom: 0.55rem; left: 0.55rem; width: 0.9rem; height: 0.9rem; border-bottom: 2px solid var(--colour-text-muted); border-left: 2px solid var(--colour-text-muted); border-radius: 0 0 0 0.2rem; }
button:hover { filter: var(--control-hover-filter); }
button:active { filter: var(--control-active-filter); }
button:focus-visible { box-shadow: var(--focus-ring); }
@media (max-width: 47.99rem) {
  .queue-drawer { inset-block: auto 0; inset-inline: 0; width: 100%; height: min(85dvh, 42rem); max-height: min(85dvh, 42rem); border-block-end: 0; border-radius: var(--radius-surface) var(--radius-surface) 0 0; }
  .queue-drawer__resize { display: none; }
}
.queue-drawer { background: var(--liquid-popover-tint); border: 0; border-radius: var(--liquid-radius-popover); box-shadow: var(--liquid-shadow); }
.queue-drawer__header { border-color: var(--liquid-separator); }
.queue-drawer__header button { border: 0; }
.queue-drawer > :deep(.queue-panel) { background: transparent; border: 0; backdrop-filter: none; }
@media (max-width: 47.99rem) {
  .queue-drawer { right: var(--workspace-edge-inset); bottom: calc(var(--workspace-edge-inset) + 5.5rem); left: var(--workspace-edge-inset); width: auto; height: min(65dvh, 36rem); max-height: min(65dvh, 36rem); border-radius: var(--liquid-radius-popover); }
}
</style>
