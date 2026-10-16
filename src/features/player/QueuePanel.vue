<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Play, Repeat, Repeat1, Shuffle, Trash2 } from 'lucide-vue-next'

import type { Track } from '../catalog/types'
import { translate, type TranslationKey } from '../../i18n'
import { resolveDisplayTitle } from '../catalog/displayTitle'
import { usePreferences } from '../../stores/preferences'
import type { PlaybackStore } from './store'

type QueueStore = Pick<PlaybackStore,
  'currentIndex' | 'playQueueIndex' | 'queue' | 'removeQueueIndex' | 'moveQueueItem' | 'playNext' | 'clearUpcomingQueue'
> & Partial<Pick<PlaybackStore, 'shuffle' | 'repeatMode' | 'setShuffle' | 'cycleRepeatMode'>>

const props = defineProps<{ store: QueueStore }>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)

/**
 * Localised queue labels.
 *
 * Display-only: the queue itself keeps holding the canonical tracks, so a language switch changes
 * the text a row shows and nothing about which track is queued or how it resolves.
 */
const label = (track: Track): string => resolveDisplayTitle(track, locale.value, track.title)

const currentEntry = computed(() => {
  const index = props.store.currentIndex.value
  return index >= 0 ? props.store.queue.value[index] : undefined
})

const upcomingEntries = computed(() => {
  const start = Math.max(0, props.store.currentIndex.value + 1)
  return props.store.queue.value.slice(start).map((track, offset) => ({ track, queueIndex: start + offset }))
})
const historyEntries = computed(() => props.store.queue.value.slice(0, Math.max(0, props.store.currentIndex.value))
  .map((track, queueIndex) => ({ track, queueIndex })))
const historyOpen = ref(true)
const upcomingViewport = ref<HTMLElement>()
const historyViewport = ref<HTMLElement>()
const upcomingScroll = ref(0)
const historyScroll = ref(0)
const upcomingHeight = ref(480)
const historyHeight = ref(240)
const mobile = ref(typeof window !== 'undefined' && window.matchMedia?.('(max-width: 47.99rem)').matches || false)
const compactRows = ref(false)
const rowHeight = computed(() => mobile.value || compactRows.value ? 160 : 62)
const overscan = 5
const upcomingStart = computed(() => Math.max(0, Math.floor(upcomingScroll.value / rowHeight.value) - overscan))
const upcomingEnd = computed(() => Math.min(upcomingEntries.value.length,
  Math.ceil((upcomingScroll.value + upcomingHeight.value) / rowHeight.value) + overscan))
const visibleUpcoming = computed(() => upcomingEntries.value.slice(upcomingStart.value, upcomingEnd.value))
const historyStart = computed(() => Math.max(0, Math.floor(historyScroll.value / rowHeight.value) - overscan))
const historyEnd = computed(() => Math.min(historyEntries.value.length,
  Math.ceil((historyScroll.value + historyHeight.value) / rowHeight.value) + overscan))
const visibleHistory = computed(() => historyEntries.value.slice(historyStart.value, historyEnd.value))
let sizeObserver: ResizeObserver | undefined
let mediaQuery: MediaQueryList | undefined
function measure(): void {
  const width = upcomingViewport.value?.clientWidth ?? 0
  compactRows.value = width > 0 && width < 448
  upcomingHeight.value = upcomingViewport.value?.clientHeight || 480
  historyHeight.value = historyViewport.value?.clientHeight || 240
}
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined') {
    sizeObserver = new ResizeObserver(measure)
    if (upcomingViewport.value) sizeObserver.observe(upcomingViewport.value)
    if (historyViewport.value) sizeObserver.observe(historyViewport.value)
  }
  mediaQuery = window.matchMedia?.('(max-width: 47.99rem)')
  mediaQuery?.addEventListener('change', onMediaChange)
})
function onMediaChange(event: MediaQueryListEvent): void { mobile.value = event.matches; upcomingScroll.value = 0; historyScroll.value = 0 }
onBeforeUnmount(() => { sizeObserver?.disconnect(); mediaQuery?.removeEventListener('change', onMediaChange) })
watch([upcomingViewport, historyViewport], () => {
  sizeObserver?.disconnect()
  if (upcomingViewport.value) sizeObserver?.observe(upcomingViewport.value)
  if (historyViewport.value) sizeObserver?.observe(historyViewport.value)
  measure()
}, { flush: 'post' })
watch([() => upcomingEntries.value.length, () => historyEntries.value.length], () => {
  upcomingScroll.value = Math.min(upcomingScroll.value, Math.max(0, upcomingEntries.value.length * rowHeight.value - upcomingHeight.value))
  historyScroll.value = Math.min(historyScroll.value, Math.max(0, historyEntries.value.length * rowHeight.value - historyHeight.value))
  if (upcomingViewport.value) upcomingViewport.value.scrollTop = upcomingScroll.value
  if (historyViewport.value) historyViewport.value.scrollTop = historyScroll.value
})

/** Arrow, Page and Home/End keys reach rows beyond the rendered window. */
function navigateRows(event: KeyboardEvent, queueIndex: number, history = false): void {
  const entries = history ? historyEntries.value : upcomingEntries.value
  const index = entries.findIndex(entry => entry.queueIndex === queueIndex)
  const page = Math.max(1, Math.floor((history ? historyHeight.value : upcomingHeight.value) / rowHeight.value))
  const targetIndex = ({ ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + page,
    PageUp: index - page, Home: 0, End: entries.length - 1 } as Record<string, number>)[event.key]
  if (targetIndex === undefined || event.altKey || event.ctrlKey || event.metaKey) return
  event.preventDefault()
  const destination = Math.max(0, Math.min(entries.length - 1, targetIndex))
  const viewport = history ? historyViewport.value : upcomingViewport.value
  if (!viewport) return
  const top = Math.max(0, destination * rowHeight.value - rowHeight.value * 2)
  viewport.scrollTop = top
  if (history) historyScroll.value = top
  else upcomingScroll.value = top
  void nextTick(() => {
    const row = [...viewport.querySelectorAll<HTMLElement>('[data-queue-track]')]
      .find(element => element.dataset.queueTrack === entries[destination]?.track.id)
    row?.querySelector<HTMLButtonElement>('button[data-queue-track-button], button')?.focus({ preventScroll: true })
  })
}

const panel = ref<HTMLElement>()
const draggingId = ref<string>()
let activeDrag: {
  pointerId: number
  sourceId: string
  targetId?: string
  handle: HTMLElement
  move: (event: PointerEvent) => void
  finish: (event: PointerEvent) => void
  cancel: (event: PointerEvent) => void
} | undefined

function actionLabel(key: 'queue.playNow' | 'queue.playNext' | 'queue.remove' | 'queue.moveUp' | 'queue.moveDown', title: string): string {
  return `${text(key)}: ${title}`
}

/** The reorder control for one row, identified by track rather than by position. */
function moveControl(trackId: string, direction: -1 | 1): HTMLButtonElement | undefined {
  const attribute = direction === 1 ? 'data-queue-move-down' : 'data-queue-move-up'
  const controls = panel.value?.querySelectorAll<HTMLButtonElement>(
    '[data-queue-move-up], [data-queue-move-down]',
  )
  return [...(controls ?? [])].find((control) => control.getAttribute(attribute) === trackId)
}

/**
 * Keyboard continuity across a reorder.
 *
 * A successful one-position move disables the control that performed it -- that row is no longer
 * at the end it was moving towards -- and a disabled control cannot hold focus. The browser drops
 * focus to the body, the drawer's own Escape handler never sees the next keypress, and a
 * keyboard-only user is stranded in a surface they can no longer close.
 *
 * So when the activation came from the focused reorder control, focus is handed to the same row's
 * opposite control once the DOM has settled. That control is guaranteed to be enabled, because a
 * one-position move in one direction is exactly the inverse of a one-position move in the other.
 *
 * Pointer activations are left untouched: a mouse press must not relocate focus as a side effect
 * of reordering, so the restoration is scoped to activations the keyboard produced.
 */
function moveBy(entry: { queueIndex: number; track: Track }, direction: -1 | 1, event?: MouseEvent): void {
  const index = upcomingEntries.value.findIndex(({ track }) => track.id === entry.track.id)
  const target = upcomingEntries.value[index + direction]
  if (!target) return
  const trackId = entry.track.id
  const origin = event?.currentTarget as HTMLElement | null | undefined
  const ownedFocus = Boolean(origin) && origin === document.activeElement
  const fromKeyboard = event !== undefined && event.detail === 0
  if (!props.store.moveQueueItem(entry.queueIndex, target.queueIndex)) return
  if (!ownedFocus || !fromKeyboard) return
  const destination = index + direction
  if (destination < upcomingStart.value || destination >= upcomingEnd.value) {
    const top = Math.max(0, destination * rowHeight.value - rowHeight.value * overscan)
    if (upcomingViewport.value) upcomingViewport.value.scrollTop = top
    upcomingScroll.value = top
  }
  void nextTick(() => {
    const inverse = moveControl(trackId, direction === 1 ? -1 : 1)
    if (inverse && !inverse.disabled) inverse.focus({ preventScroll: true })
  })
}

function rowIdFromPoint(clientX: number, clientY: number): string | undefined {
  const element = document.elementFromPoint(clientX, clientY)
  const row = element?.closest<HTMLElement>('[data-queue-track]')
  const id = row?.dataset.queueTrack
  if (!id || id === currentEntry.value?.id || !upcomingEntries.value.some(({ track }) => track.id === id)) return undefined
  return id
}

function releaseDragCapture(): void {
  if (!activeDrag) return
  window.removeEventListener('pointermove', activeDrag.move)
  window.removeEventListener('pointerup', activeDrag.finish)
  window.removeEventListener('pointercancel', activeDrag.cancel)
  activeDrag.handle.removeEventListener('pointermove', activeDrag.move)
  activeDrag.handle.removeEventListener('pointerup', activeDrag.finish)
  activeDrag.handle.removeEventListener('pointercancel', activeDrag.cancel)
  try { activeDrag.handle.releasePointerCapture(activeDrag.pointerId) } catch { /* Already released. */ }
  activeDrag = undefined
  draggingId.value = undefined
}

watch(upcomingEntries, () => {
  const sourceId = activeDrag?.sourceId
  if (sourceId && !upcomingEntries.value.some(({ track }) => track.id === sourceId)) releaseDragCapture()
})

function finishDrag(event: PointerEvent): void {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return
  const { sourceId, targetId } = activeDrag
  releaseDragCapture()
  if (!targetId || sourceId === targetId) return
  const source = upcomingEntries.value.find(({ track }) => track.id === sourceId)
  const target = upcomingEntries.value.find(({ track }) => track.id === targetId)
  if (source && target) props.store.moveQueueItem(source.queueIndex, target.queueIndex)
}

function cancelDrag(event: PointerEvent): void {
  if (!activeDrag || event.pointerId !== activeDrag.pointerId) return
  releaseDragCapture()
}

function startDrag(event: PointerEvent, sourceId: string): void {
  if (event.button > 0 || activeDrag || !upcomingEntries.value.some(({ track }) => track.id === sourceId)) return
  const handle = event.currentTarget
  if (!(handle instanceof HTMLElement)) return
  event.preventDefault()
  draggingId.value = sourceId
  const move = (moveEvent: PointerEvent): void => {
    if (!activeDrag || moveEvent.pointerId !== activeDrag.pointerId) return
    const viewport = upcomingViewport.value
    if (viewport) {
      const bounds = viewport.getBoundingClientRect()
      const edge = 36
      if (moveEvent.clientY >= bounds.top && moveEvent.clientY < bounds.top + edge) viewport.scrollTop -= rowHeight.value * 2
      if (moveEvent.clientY <= bounds.bottom && moveEvent.clientY > bounds.bottom - edge) viewport.scrollTop += rowHeight.value * 2
      upcomingScroll.value = viewport.scrollTop
    }
    activeDrag.targetId = rowIdFromPoint(moveEvent.clientX, moveEvent.clientY)
  }
  const finish = (finishEvent: PointerEvent): void => finishDrag(finishEvent)
  const cancel = (cancelEvent: PointerEvent): void => cancelDrag(cancelEvent)
  activeDrag = { pointerId: event.pointerId, sourceId, handle, move, finish, cancel }
  try { handle.setPointerCapture(event.pointerId) } catch { /* Capture is an enhancement. */ }
  const target: EventTarget = handle.isConnected ? window : handle
  target.addEventListener('pointermove', move as EventListener)
  target.addEventListener('pointerup', finish as EventListener)
  target.addEventListener('pointercancel', cancel as EventListener)
}

onBeforeUnmount(releaseDragCapture)
</script>

<template>
  <section ref="panel" class="queue-panel surface-glass" :class="{ 'queue-panel--compact': compactRows }" data-queue-panel aria-labelledby="queue-panel-title">
    <header class="queue-panel__header">
      <div>
        <p class="queue-panel__eyebrow">{{ text('player.nowPlaying') }}</p>
        <h2 id="queue-panel-title">{{ text('queue.title') }}</h2>
      </div>
      <div class="queue-panel__mode-actions">
        <button type="button" data-queue-shuffle :aria-pressed="props.store.shuffle?.value ?? false" :aria-label="text('queue.shuffle')" :title="text('queue.shuffle')" @click="props.store.setShuffle?.(!(props.store.shuffle?.value ?? false))"><Shuffle :size="18" aria-hidden="true" /></button>
        <button type="button" data-queue-repeat :aria-label="`${text('queue.repeat')}: ${text(`queue.repeat.${props.store.repeatMode?.value ?? 'off'}` as TranslationKey)}`" :title="text(`queue.repeat.${props.store.repeatMode?.value ?? 'off'}` as TranslationKey)" @click="props.store.cycleRepeatMode?.()"><Repeat1 v-if="props.store.repeatMode?.value === 'one'" :size="18" aria-hidden="true" /><Repeat v-else :size="18" aria-hidden="true" /><span class="queue-panel__repeat-state">{{ text(`queue.repeat.${props.store.repeatMode?.value ?? 'off'}` as TranslationKey) }}</span></button>
      </div>
      <button type="button" class="queue-panel__clear" data-queue-clear :aria-label="text('queue.clearLabel')" :disabled="upcomingEntries.length === 0" @click="props.store.clearUpcomingQueue()">
        <Trash2 :size="16" aria-hidden="true" /><span>{{ text('queue.clear') }}</span>
      </button>
    </header>

    <div v-if="currentEntry" class="queue-panel__current surface-glass" data-queue-now-playing aria-current="true" :data-queue-track="currentEntry.id">
      <div class="queue-panel__current-icon" aria-hidden="true"><Play :size="16" fill="currentColor" /></div>
      <div class="queue-panel__track-copy"><span class="queue-panel__label">{{ text('queue.nowPlaying') }}</span><strong>{{ label(currentEntry) }}</strong></div>
    </div>

    <div v-if="historyEntries.length" class="queue-panel__history">
      <button type="button" data-queue-history-toggle :aria-expanded="historyOpen" @click="historyOpen = !historyOpen">{{ text('queue.previouslyPlayed') }} ({{ historyEntries.length }}) <span aria-hidden="true">{{ historyOpen ? '▴' : '▾' }}</span></button>
      <div v-if="historyOpen" ref="historyViewport" class="queue-panel__history-viewport" data-queue-history-viewport @scroll="historyScroll = ($event.target as HTMLElement).scrollTop">
        <ol class="queue-panel__list" :style="{ paddingTop: `${historyStart * rowHeight}px`, paddingBottom: `${(historyEntries.length - historyEnd) * rowHeight}px` }">
          <li v-for="entry in visibleHistory" :key="entry.track.id" class="queue-panel__history-row" :style="{ height: `${rowHeight}px` }" data-queue-history :data-queue-track="entry.track.id" :aria-posinset="entry.queueIndex + 1" :aria-setsize="historyEntries.length">
            <span class="queue-panel__history-position">{{ entry.queueIndex + 1 }}</span>
            <button type="button" :aria-label="text('queue.playFrom').replace('{title}', label(entry.track))" @keydown="navigateRows($event, entry.queueIndex, true)" @click="props.store.playQueueIndex(entry.queueIndex)">{{ label(entry.track) }}</button>
          </li>
        </ol>
      </div>
    </div>

    <div class="queue-panel__up-next">
      <h3>{{ text('queue.upNext') }} ({{ upcomingEntries.length }})</h3>
      <div v-if="upcomingEntries.length" ref="upcomingViewport" class="queue-panel__viewport" data-queue-viewport @scroll="upcomingScroll = ($event.target as HTMLElement).scrollTop">
      <ol class="queue-panel__list" :style="{ paddingTop: `${upcomingStart * rowHeight}px`, paddingBottom: `${(upcomingEntries.length - upcomingEnd) * rowHeight}px` }">
        <li v-for="(entry, localIndex) in visibleUpcoming" :key="entry.track.id" class="queue-panel__row" :style="{ height: `${rowHeight}px` }" data-queue-up-next :data-queue-track="entry.track.id" :data-queue-dragging="draggingId === entry.track.id ? 'true' : 'false'" :aria-posinset="entry.queueIndex - Math.max(0, props.store.currentIndex.value + 1) + 1" :aria-setsize="upcomingEntries.length">
          <button type="button" class="queue-panel__drag-handle" data-queue-drag-handle :aria-label="`${text('queue.drag')}: ${label(entry.track)}`" :aria-grabbed="draggingId === entry.track.id ? 'true' : 'false'" @pointerdown="startDrag($event, entry.track.id)"><span aria-hidden="true">⋮⋮</span></button>
          <button type="button" class="queue-panel__track" data-queue-track-button @keydown="navigateRows($event, entry.queueIndex)" :aria-label="text('queue.playFrom').replace('{title}', label(entry.track))" @click="props.store.playQueueIndex(entry.queueIndex)">{{ label(entry.track) }}</button>
          <div class="queue-panel__actions">
            <button type="button" :data-queue-play-now="entry.track.id" :aria-label="actionLabel('queue.playNow', label(entry.track))" @click="props.store.playQueueIndex(entry.queueIndex)"><span aria-hidden="true">▶</span></button>
            <button type="button" :data-queue-play-next="entry.track.id" :aria-label="actionLabel('queue.playNext', label(entry.track))" @click="props.store.playNext(entry.track)"><span aria-hidden="true">⏭</span></button>
            <button type="button" :data-queue-remove="entry.track.id" :aria-label="actionLabel('queue.remove', label(entry.track))" @click="props.store.removeQueueIndex(entry.queueIndex)"><span aria-hidden="true">×</span></button>
          </div>
          <div class="queue-panel__move-actions" :aria-label="`${text('queue.upNext')}: ${label(entry.track)}`">
            <button type="button" :data-queue-move-up="entry.track.id" :aria-label="actionLabel('queue.moveUp', label(entry.track))" :disabled="upcomingStart + localIndex === 0" @click="moveBy(entry, -1, $event)"><span aria-hidden="true">↑</span></button>
            <button type="button" :data-queue-move-down="entry.track.id" :aria-label="actionLabel('queue.moveDown', label(entry.track))" :disabled="upcomingStart + localIndex === upcomingEntries.length - 1" @click="moveBy(entry, 1, $event)"><span aria-hidden="true">↓</span></button>
          </div>
        </li>
      </ol>
      </div>
      <p v-else class="queue-panel__empty">{{ text('queue.empty') }}</p>
    </div>
  </section>
</template>

<style scoped>
.queue-panel { display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; min-height: 0; padding: 1rem; color: var(--colour-text-primary); border-radius: var(--radius-surface); box-shadow: var(--glass-shadow); }
.queue-panel__header { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; justify-content: space-between; }
.queue-panel__header h2, .queue-panel__header p, .queue-panel h3, .queue-panel__empty { margin: 0; }
.queue-panel__header h2 { font-size: 1rem; }
.queue-panel__eyebrow, .queue-panel__label { color: var(--colour-text-muted); font-size: 0.75rem; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
.queue-panel__clear, .queue-panel__drag-handle, .queue-panel__actions button, .queue-panel__move-actions button { display: inline-grid; min-width: 2.75rem; min-height: 2.75rem; padding: 0.5rem; place-items: center; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: var(--radius-control); cursor: pointer; }
.queue-panel__clear { display: inline-flex; gap: 0.4rem; align-items: center; }
.queue-panel__clear:disabled, .queue-panel__move-actions button:disabled { cursor: not-allowed; opacity: 0.5; }
.queue-panel__current { display: flex; gap: 0.75rem; align-items: center; padding: 0.75rem; border-radius: var(--radius-control); box-shadow: var(--glass-highlight); }
.queue-panel__current-icon { display: grid; flex: 0 0 2.75rem; width: 2.75rem; height: 2.75rem; place-items: center; color: var(--colour-background); background: var(--colour-accent); border-radius: 50%; }
.queue-panel__track-copy { display: grid; min-width: 0; gap: 0.2rem; }
.queue-panel__track-copy strong, .queue-panel__track { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.queue-panel__up-next { display: grid; gap: 0.5rem; min-width: 0; }
.queue-panel h3 { color: var(--colour-text-muted); font-size: 0.875rem; font-weight: 650; }
.queue-panel__list { margin: 0; padding: 0; list-style: none; }
.queue-panel__row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 0.4rem; align-items: center; min-width: 0; padding: 0.25rem; border: 1px solid transparent; border-radius: var(--radius-control); }
.queue-panel__row[data-queue-dragging="true"] { border-color: var(--colour-accent); filter: brightness(1.12); transform: translateY(-0.1rem); }
.queue-panel__drag-handle { touch-action: none; cursor: grab; }
.queue-panel__drag-handle:active { cursor: grabbing; }
.queue-panel__track { width: 100%; min-width: 0; min-height: 2.75rem; padding: 0.5rem 0.25rem; color: var(--colour-text-primary); text-align: left; background: transparent; border: 0; cursor: pointer; }
.queue-panel__actions, .queue-panel__move-actions { display: flex; gap: 0.25rem; }
.queue-panel__actions button, .queue-panel__move-actions button { min-width: 2.75rem; min-height: 2.75rem; padding: 0.35rem; border-radius: 50%; }
.queue-panel__empty { color: var(--colour-text-muted); font-size: 0.875rem; }
.queue-panel__mode-actions { display: flex; gap: 0.35rem; margin-inline-start: auto; }
.queue-panel__mode-actions button, .queue-panel__history > button { display: inline-flex; align-items: center; justify-content: center; gap: 0.3rem; min-height: 2.75rem; padding: 0.35rem 0.55rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: var(--radius-control); cursor: pointer; }
.queue-panel__mode-actions button[aria-pressed="true"] { color: var(--colour-accent); box-shadow: var(--glass-highlight); }
.queue-panel__repeat-state { font-size: 0.75rem; }
.queue-panel__up-next { flex: 1; min-height: 6rem; }
.queue-panel__viewport { min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; contain: layout paint; transform: translateZ(0); }
.queue-panel__up-next { grid-template-rows: auto minmax(0, 1fr); }
.queue-panel__history { display: grid; gap: 0.25rem; min-height: 0; }
.queue-panel__history > button { justify-content: space-between; width: 100%; }
.queue-panel__history-viewport { max-height: min(20vh, 8rem); overflow-y: auto; overscroll-behavior: contain; contain: layout paint; transform: translateZ(0); }
.queue-panel__history-row { display: flex; align-items: center; gap: 0.75rem; min-width: 0; padding-inline: 0.5rem; }
.queue-panel__history-row button { overflow: hidden; min-height: 2.75rem; color: var(--colour-text-primary); text-overflow: ellipsis; text-align: left; white-space: nowrap; background: none; border: 0; cursor: pointer; }
.queue-panel__history-position { color: var(--colour-text-muted); font-variant-numeric: tabular-nums; }
button:hover:not(:disabled) { filter: var(--control-hover-filter); }
button:active:not(:disabled) { filter: var(--control-active-filter); }
button:focus-visible { box-shadow: var(--focus-ring); }
.queue-panel--compact .queue-panel__row { grid-template-columns: auto minmax(0, 1fr) auto; }
.queue-panel--compact .queue-panel__actions { grid-column: 2 / -1; justify-content: flex-end; }
.queue-panel--compact .queue-panel__move-actions { grid-column: 1 / -1; justify-content: flex-end; }
@media (max-width: 47.99rem) { .queue-panel__row { grid-template-columns: auto minmax(0, 1fr) auto; } .queue-panel__actions { grid-column: 2 / -1; justify-content: flex-end; } .queue-panel__move-actions { grid-column: 1 / -1; justify-content: flex-end; } }
</style>
