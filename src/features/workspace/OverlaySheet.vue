<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

import { translate } from '../../i18n'
import StudioGlassCanvas from '../liquid-glass/StudioGlassCanvas.vue'
import { usePreferences } from '../../stores/preferences'

let sheetSequence = 0
// One document has one focused element, so exactly one sheet may own focus restoration.
// The claim identifies the owner so a sheet replaced by an intentional modal-to-modal
// handoff never fights the incoming sheet's focus trap over document.activeElement.
let focusClaimSequence = 0
let focusClaimOwner = 0

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  modal?: boolean
  name?: string
  /**
   * `panel` is the edge-anchored sheet the workspace has always used. `centre` is the
   * large centred hub: the same dialog semantics, focus trap and dismissal, laid out in
   * the middle of the viewport over a dimmed backdrop. The distinction is presentation
   * only, which is why it is a variant here rather than a second dialog implementation.
   */
  variant?: 'panel' | 'centre'
  returnFocusTo?: () => HTMLElement | null | undefined
}>(), {
  modal: true,
  name: 'overlay',
  variant: 'panel',
})
const emit = defineEmits<{ (event: 'close'): void }>()
const { locale, lowPower, studioBlur, studioGlassGray, studioEdge, visualStyle } = usePreferences()
const root = ref<HTMLElement>()
const titleId = `overlay-sheet-title-${++sheetSequence}`
let opener: HTMLElement | null = null
let focusClaim = 0
let listenersAttached = false
let closeRequested = false
const outsidePointerIds = new Set<number>()

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(): HTMLElement[] {
  return root.value
    ? [...root.value.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => !element.hidden)
    : []
}

function captureOpener(): void {
  const candidate = document.activeElement
  if (!(candidate instanceof HTMLElement)) {
    opener = null
    return
  }
  const owningSheet = candidate.closest('[data-overlay-sheet]')
  // An opener inside another sheet belongs to the sheet this one replaces. That element
  // leaves the document during the handoff, so it can never receive focus back.
  opener = owningSheet && owningSheet !== root.value ? null : candidate
}

function returnFocus(): void {
  const fallback = opener
  const resolveTarget = props.returnFocusTo
  const claim = focusClaim
  opener = null
  focusClaim = 0
  if (claim === 0) return
  void nextTick(() => {
    if (focusClaimOwner !== claim) return
    focusClaimOwner = 0
    // Resolve after the closing patch so a live control renders its current identity.
    const target = resolveTarget?.() ?? fallback
    target?.focus()
  })
}

function requestClose(): void {
  if (closeRequested) return
  closeRequested = true
  emit('close')
  detachListeners()
  returnFocus()
}

function isOutsideSheet(target: EventTarget | null): boolean {
  return Boolean(
    props.open &&
    props.modal &&
    root.value &&
    target instanceof Node &&
    !root.value.contains(target),
  )
}

function consumeOutsideEvent(event: Event): void {
  event.preventDefault()
  event.stopImmediatePropagation()
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!isOutsideSheet(event.target)) return
  outsidePointerIds.add(event.pointerId)
  consumeOutsideEvent(event)
}

function onDocumentPointerUp(event: PointerEvent): void {
  if (outsidePointerIds.delete(event.pointerId)) consumeOutsideEvent(event)
}

function onDocumentPointerCancel(event: PointerEvent): void {
  if (outsidePointerIds.delete(event.pointerId)) consumeOutsideEvent(event)
}

function onDocumentClick(event: MouseEvent): void {
  if (!isOutsideSheet(event.target)) return
  consumeOutsideEvent(event)
  outsidePointerIds.clear()
  requestClose()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    requestClose()
    return
  }
  if (!props.modal || event.key !== 'Tab') return
  const focusable = focusableElements()
  if (focusable.length === 0) {
    event.preventDefault()
    root.value?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

function onFocusIn(event: FocusEvent): void {
  if (!props.open || !props.modal || !root.value || root.value.contains(event.target as Node)) return
  focusableElements()[0]?.focus()
}

function attachListeners(): void {
  if (listenersAttached) return
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('pointerup', onDocumentPointerUp, true)
  document.addEventListener('pointercancel', onDocumentPointerCancel, true)
  document.addEventListener('click', onDocumentClick, true)
  listenersAttached = true
}

function detachListeners(): void {
  if (!listenersAttached) return
  document.removeEventListener('focusin', onFocusIn, true)
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('pointerup', onDocumentPointerUp, true)
  document.removeEventListener('pointercancel', onDocumentPointerCancel, true)
  document.removeEventListener('click', onDocumentClick, true)
  outsidePointerIds.clear()
  listenersAttached = false
}

function activate(): void {
  closeRequested = false
  outsidePointerIds.clear()
  captureOpener()
  focusClaim = ++focusClaimSequence
  focusClaimOwner = focusClaim
  if (props.modal) attachListeners()
  void nextTick(() => {
    const first = focusableElements()[0]
    if (first) first.focus()
    else root.value?.focus()
  })
}

watch(() => props.open, (open) => {
  if (open) activate()
  else {
    detachListeners()
    returnFocus()
  }
})

onMounted(() => { if (props.open) activate() })
onBeforeUnmount(() => {
  detachListeners()
  if (props.open) returnFocus()
})
</script>

<template>
  <template v-if="open">
    <!--
      Presentational only. Interaction is already blocked by the capture-phase listeners
      above, which is what makes the backdrop safe to mark aria-hidden: it is the visual
      statement that the hub is modal, not the mechanism.
    -->
    <div v-if="variant === 'centre'" class="overlay-sheet__backdrop" data-overlay-backdrop aria-hidden="true" />
    <section
      ref="root"
      :id="`workspace-${name}-sheet`"
      class="overlay-sheet liquid-popover"
      :class="`overlay-sheet--${variant}`"
      :data-overlay-sheet="name"
      :data-overlay-variant="variant"
      role="dialog"
      :aria-modal="modal ? 'true' : undefined"
      :aria-labelledby="titleId"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <StudioGlassCanvas v-if="visualStyle === 'studio'" plate :low-power="lowPower" :blur-radius="studioBlur" :glass-gray="studioGlassGray" :edge="studioEdge" />
      <header class="overlay-sheet__header">
        <h2 :id="titleId">{{ title }}</h2>
        <button type="button" data-overlay-close :aria-label="translate(locale, 'workspace.closeSheet')" @click="requestClose">
          <X :size="20" aria-hidden="true" />
        </button>
      </header>
      <div class="overlay-sheet__body">
        <slot />
      </div>
    </section>
  </template>
</template>

<style scoped>
.overlay-sheet {
  position: fixed;
  z-index: var(--layer-workspace-modal);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  overflow: hidden;
  color: var(--colour-text-primary);
  border-radius: var(--radius-surface);
}

.overlay-sheet--panel {
  inset-block: var(--workspace-sheet-block-start) var(--workspace-sheet-block-end);
  inset-inline-end: var(--workspace-edge-inset);
  width: min(var(--workspace-sheet-inline-size), calc(100vw - (2 * var(--workspace-edge-inset))));
}

/*
 * The centred hub. Height is a percentage of the viewport rather than a fixed block
 * inset, so the panel keeps the same proportion from a laptop to a tall monitor, and the
 * width is capped so its two columns stay a readable measure on a wide one.
 */
.overlay-sheet--centre {
  top: 50%;
  left: 50%;
  width: min(64rem, calc(100vw - (2 * var(--workspace-edge-inset))));
  height: min(88dvh, calc(100dvh - (2 * var(--workspace-edge-inset))));
  transform: translate(-50%, -50%);
}

.overlay-sheet__backdrop {
  position: fixed;
  inset: 0;
  /* One step below the panel: over the workspace, under the hub itself. */
  z-index: calc(var(--layer-workspace-modal) - 1);
  background: rgb(4 8 14 / 58%);
}
.overlay-sheet__header, .overlay-sheet__body { position: relative; z-index: 1; }
.overlay-sheet__header {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  overflow: hidden;
  border-block-end: var(--glass-border);
  border-start-start-radius: inherit;
  border-start-end-radius: inherit;
}
.overlay-sheet__header h2 { margin: 0; font-size: 1rem; }
.overlay-sheet__header button {
  display: grid;
  width: 2.75rem;
  height: 2.75rem;
  padding: 0;
  place-items: center;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 50%;
  cursor: pointer;
  transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease;
}
.overlay-sheet__header button:hover { filter: var(--control-hover-filter); }
.overlay-sheet__header button:active { transform: scale(0.94); filter: var(--control-active-filter); }
.overlay-sheet__header button:focus-visible { filter: var(--control-hover-filter); }
.overlay-sheet__body { min-height: 0; overflow: auto; overscroll-behavior: contain; border-end-start-radius: inherit; border-end-end-radius: inherit; }

.overlay-sheet--centre .overlay-sheet__header { padding: 1rem 1.25rem; }
.overlay-sheet--centre .overlay-sheet__header h2 { font-size: 1.125rem; font-weight: 700; }
/* The hub's own panels scroll; the hub does not. */
.overlay-sheet--centre .overlay-sheet__body { overflow: hidden; }

@media (max-width: 47.99rem) {
  /* A centred panel inset from a 375px viewport wastes the width its content needs, so
     the hub becomes the screen instead. The edge-anchored panel keeps its own geometry:
     the Focus summary is a short interruption, not a workspace of settings. */
  .overlay-sheet--centre {
    inset: 0;
    width: 100vw;
    height: 100dvh;
    border-radius: 0;
    transform: none;
    /* Notches and home indicators: the header's close control and the panel's last row
       both have to stay reachable. */
    padding-block-end: env(safe-area-inset-bottom);
  }
}
.overlay-sheet { border: 0; border-radius: var(--liquid-radius-popover); }
.overlay-sheet--centre {
  width: min(64rem, calc(100vw - (2 * var(--workspace-edge-inset))));
  height: min(88dvh, calc(100dvh - (2 * var(--workspace-edge-inset))));
}
.overlay-sheet__backdrop { background: rgb(4 8 14 / 38%); }
.overlay-sheet__header { border-color: var(--liquid-separator); }
.overlay-sheet__header button { background: transparent; border: 0; }
.overlay-sheet__header button:hover { background: rgb(255 255 255 / 9%); }
@media (max-width: 47.99rem) {
  .overlay-sheet--centre { inset: 0; width: 100vw; height: 100dvh; border-radius: 0; transform: none; }
}
</style>
