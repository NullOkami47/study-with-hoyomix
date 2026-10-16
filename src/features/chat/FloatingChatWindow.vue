<script setup lang="ts">
/**
 * A floating window: it owns where it is, how big it is, and the gestures that change
 * either. It owns nothing about chat. Messages, presence, transport and moderation
 * belong to whatever is slotted into its body, so the community-chat work that lands
 * later replaces the slot content without touching a line of the drag or resize code.
 *
 * Gestures are Pointer Events throughout. One implementation then covers mouse, pen and
 * touch, and `setPointerCapture` keeps a drag attached to the window even when the
 * pointer outruns it -- which it will, because clamping deliberately stops the window
 * before the cursor stops.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { GripHorizontal, X } from 'lucide-vue-next'

import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import { safeLocalStorage } from '../../utils/safeStorage'
import {
  CHAT_LAYOUT_STORAGE_KEY,
  CHAT_SAFE_MARGIN,
  DEFAULT_CHAT_HEIGHT,
  DEFAULT_CHAT_WIDTH,
  clampChatLayout,
  defaultChatLayout,
  parseChatLayout,
  reconcileChatLayout,
  resolveChatSheetLayout,
  resolveChatLayout,
  serialiseChatLayout,
  type ChatLayout,
  type Rect,
  type Viewport,
} from './chatLayout'

const props = withDefaults(defineProps<{
  /** Blocks interaction while a modal owns the screen above the window. */
  inert?: boolean
    /**
   * The first region is the whole Player card. Further regions are hard protected controls
   * and transient surfaces, so the window may yield artwork but never a control.
   */
  reserved?: () => Rect | Rect[] | undefined
  /**
   * How much of the top of the viewport another surface owns, measured live. The window
   * never sits above it, because its header is its drag handle: underneath that surface
   * the header cannot be grabbed and the close button cannot be pressed.
   */
  obstructedTop?: () => number
  /** Allow the narrow sheet's body to shrink while retaining its measured header. */
  constrainToAvailableSpace?: boolean
}>(), { inert: false, reserved: undefined, obstructedTop: undefined, constrainToAvailableSpace: false })
const emit = defineEmits<{ (event: 'close'): void }>()

const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
const titleId = 'floating-chat-title'
const root = ref<HTMLElement>()
/**
 * Matches the 47.99rem breakpoint the workspace uses for "narrow". Below it the window
 * is a sheet rather than a movable object: a drag on a small touch screen competes with
 * the browser's own scroll and pull-to-refresh gestures, and loses often enough that
 * offering it would be worse than not having it. Resize is withheld for the same
 * reason. Everything else -- read, close, reopen -- is unchanged, so nothing is behind
 * a gesture the user cannot perform.
 */
const NARROW_VIEWPORT = 767

// Resolved during setup rather than on mount, so the first painted frame is already the
// remembered layout. Deferring it to onMounted would show the window at a placeholder
// position for one frame and then move it, which reads as a glitch on every load.
function initialLayout(): ChatLayout {
  if (typeof window === 'undefined') {
    return { x: 0, y: 0, width: DEFAULT_CHAT_WIDTH, height: DEFAULT_CHAT_HEIGHT }
  }
  const raw = safeLocalStorage.getItem(CHAT_LAYOUT_STORAGE_KEY)
  /**
   * Opening on a phone must not cost the layout chosen on a monitor. CSS places the sheet,
   * so this value is not what the user sees while narrow -- it is only what the window
   * returns to, and clamping it here against a 375px viewport would discard exactly that.
   * It is reconciled on the way back to a wide viewport, by applyViewport, where the
   * viewport it is being fitted to is the one it will actually be shown in.
   */
  if (window.innerWidth <= NARROW_VIEWPORT) {
    const stored = parseChatLayout(raw)
    if (stored) return stored
  }
  return resolveChatLayout(raw, viewport(), props.reserved?.())
}

function viewport(): Viewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    top: props.obstructedTop?.(),
  }
}

const layout = ref<ChatLayout>(initialLayout())
/**
 * Whether the layout came from the user or storage. Preserve it whenever safe; a viewport
 * or Player change may cause only the smallest move needed to protect interaction controls.
 */const userPlaced = ref(
  typeof window === 'undefined'
    ? false
    : safeLocalStorage.getItem(CHAT_LAYOUT_STORAGE_KEY) !== null,
)
const dragging = ref(false)
const resizing = ref(false)
/**
 * How much of the bottom of the viewport the sheet must leave clear, in pixels.
 *
 * The sheet spans the width, so the player is directly beneath it rather than beside it,
 * and the player is not one size: it is a compact strip until media plays and considerably
 * taller once an official embed appears inside it. A constant offset would therefore be
 * correct only while nothing was playing, and would put the sheet over the transport
 * exactly when the user has something to pause.
 *
 * Held as a value rather than read during render: it is a layout measurement, and taking
 * one inside a computed would tie painting to measuring. It is refreshed on the events
 * that can change it -- mount, viewport resize, and the workspace telling us the player
 * has been renegotiated -- which is the same set the derived desktop placement uses.
 */
const sheetBlockEnd = ref(CHAT_SAFE_MARGIN)
const sheetAvailableHeight = ref<number>()
const narrow = ref(typeof window === 'undefined' ? false : window.innerWidth <= NARROW_VIEWPORT)
const gestureable = computed(() => !narrow.value && !props.inert)
/**
 * The window box, or nothing at all on a narrow screen.
 *
 * A sheet is not a window whose gestures have been taken away. Clamping desktop
 * coordinates into a 375px viewport produces an arbitrary inset position and a size
 * inherited from whatever the user last dragged on a monitor -- neither of which is a
 * decision about a phone. So the geometry is handed to CSS there, which can express
 * "across the width, above the player, bounded height" directly, and cannot be in two
 * minds about it the way an inline style competing with a stylesheet would be.
 */
const style = computed(() => (narrow.value ? {
  '--chat-sheet-block-end': `${sheetBlockEnd.value}px`,
  '--chat-sheet-available-block-size': sheetAvailableHeight.value === undefined ? undefined : `${sheetAvailableHeight.value}px`,
} : {
  transform: `translate(${layout.value.x}px, ${layout.value.y}px)`,
  width: `${layout.value.width}px`,
  height: `${layout.value.height}px`,
}))

/**
 * Keep the narrow sheet above playback controls. If the whole Player card leaves too little
 * room for a usable body, yield its non-interactive area while retaining the control rows.
 */
function measureSheetBand(): void {
  if (!narrow.value) return
  const regions = props.reserved?.()
  const headerHeight = root.value?.querySelector<HTMLElement>('[data-floating-chat-handle]')?.getBoundingClientRect().height ?? 0
  const border = root.value ? getComputedStyle(root.value) : undefined
  const headerBoxHeight = headerHeight + (parseFloat(border?.borderTopWidth ?? '0') || 0) + (parseFloat(border?.borderBottomWidth ?? '0') || 0)
  const geometry = resolveChatSheetLayout(viewport(), regions, headerBoxHeight)
  sheetBlockEnd.value = geometry.blockEnd
  sheetAvailableHeight.value = props.constrainToAvailableSpace ? geometry.availableHeight : undefined
}
function persist(): void {
  safeLocalStorage.setItem(CHAT_LAYOUT_STORAGE_KEY, serialiseChatLayout(layout.value))
}

function sameLayout(first: ChatLayout, second: ChatLayout): boolean {
  return first.x === second.x && first.y === second.y
    && first.width === second.width && first.height === second.height
}

function setReconciledLayout(next: ChatLayout): void {
  if (sameLayout(layout.value, next)) return
  layout.value = next
  // A safety move caused by player growth or a viewport resize becomes the new remembered
  // placement. Narrow sheets never call this path, so they cannot overwrite desktop geometry.
  if (userPlaced.value) persist()
}

function applyViewport(): void {
  narrow.value = window.innerWidth <= NARROW_VIEWPORT
  measureSheetBand()
  // CSS owns the sheet geometry. Leave the remembered desktop placement intact while narrow.
  if (narrow.value) return
  setReconciledLayout(userPlaced.value
    ? reconcileChatLayout(layout.value, viewport(), props.reserved?.(), true)
    : defaultChatLayout(viewport(), props.reserved?.()))
}
/**
 * A drag begins on the header and nowhere else, and not on a control inside it. Testing
 * for the nearest interactive ancestor rather than for the header itself is what lets
 * the close button live in the drag handle without a press on it also moving the window.
 */
function isGestureTarget(event: PointerEvent): boolean {
  const target = event.target
  if (!(target instanceof Element)) return false
  return !target.closest('button, a, input, select, textarea, [contenteditable="true"]')
}

function track(
  event: PointerEvent,
  onMove: (deltaX: number, deltaY: number) => void,
  active: typeof dragging,
): void {
  const originX = event.clientX
  const originY = event.clientY
  const handle = event.currentTarget as HTMLElement
  active.value = true
  // Suppresses the text selection and the synthetic scroll that a press-and-move would
  // otherwise start. Pointer capture keeps every subsequent event on this handle.
  event.preventDefault()
  try {
    handle.setPointerCapture(event.pointerId)
  } catch {
    // Capture is an optimisation, not a requirement: the listeners below are on the
    // handle either way, and a browser that refuses capture still delivers them.
  }

  const move = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== event.pointerId) return
    onMove(moveEvent.clientX - originX, moveEvent.clientY - originY)
  }
  const finish = (endEvent: PointerEvent): void => {
    if (endEvent.pointerId !== event.pointerId) return
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', finish)
    handle.removeEventListener('pointercancel', finish)
    try {
      handle.releasePointerCapture(event.pointerId)
    } catch {
      // Already released with the gesture.
    }
    active.value = false
    // The gesture is what makes this layout the user's, so nothing may re-derive it after.
    userPlaced.value = true
    // One write per gesture rather than one per frame: the intermediate positions of a
    // drag are not layouts the user chose.
    persist()
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
}

function onHeaderPointerDown(event: PointerEvent): void {
  if (!gestureable.value || !isGestureTarget(event) || event.button > 0) return
  const origin = { ...layout.value }
  track(event, (deltaX, deltaY) => {
    layout.value = reconcileChatLayout(
      clampChatLayout(
        { ...layout.value, x: origin.x + deltaX, y: origin.y + deltaY },
        viewport(),
      ),
      viewport(),
      props.reserved?.(),
      true,
    )
  }, dragging)
}

function onResizePointerDown(event: PointerEvent): void {
  if (!gestureable.value || event.button > 0) return
  const origin = { ...layout.value }
  track(event, (deltaX, deltaY) => {
    layout.value = reconcileChatLayout(
      clampChatLayout(
        { ...layout.value, width: origin.width + deltaX, height: origin.height + deltaY },
        viewport(),
      ),
      viewport(),
      props.reserved?.(),
      true,
    )
  }, resizing)
}

/** Called by the workspace when the window is reopened, so it lands somewhere valid. */
function reconcile(): void {
  applyViewport()
  // Nothing is reconciled while narrow, so there is nothing to write. Persisting anyway
  // would be the one path that could still commit a sheet-shaped layout over the user's
  // remembered desktop one.
  if (userPlaced.value && !narrow.value) persist()
}

/** Reconcile against live Player geometry without discarding a user-chosen placement. */
function renegotiate(): void {
  if (narrow.value) { measureSheetBand(); return }
  setReconciledLayout(userPlaced.value
    ? reconcileChatLayout(layout.value, viewport(), props.reserved?.(), true)
    : defaultChatLayout(viewport(), props.reserved?.()))
}
function focusWindow(): void {
  root.value?.focus()
}

/**
 * The window's own element, so a caller that owns a focus transition can name it as a
 * target instead of racing this component for document.activeElement.
 */
function windowElement(): HTMLElement | undefined {
  return root.value
}

onMounted(() => {
  // The Player and focus bar are measured after mount, then observed so a media start,
  // collapse or viewport change can reconcile chat against their live rectangles.
  renegotiate()
  window.addEventListener('resize', applyViewport)
})

onBeforeUnmount(() => window.removeEventListener('resize', applyViewport))

watch(() => props.constrainToAvailableSpace, renegotiate, { flush: 'post' })

defineExpose({ reconcile, renegotiate, focusWindow, windowElement })
</script>

<template>
  <!--
    A labelled section, which computes to a landmark region. Deliberately not
    role="dialog": when explicitly opened, this non-modal window traps no focus and blocks
    nothing, so announcing it as a dialog would describe behaviour it does not have.
  -->
  <section
    ref="root"
    class="chat-window liquid-popover"
    data-floating-chat
    :data-chat-dragging="dragging ? 'true' : 'false'"
    :data-chat-narrow="narrow ? 'true' : 'false'"
    :class="{ 'chat-window--active': dragging || resizing }"
    :aria-labelledby="titleId"
    :inert="props.inert || undefined"
    :aria-hidden="props.inert ? 'true' : undefined"
    tabindex="-1"
    :style="style"
  >
    <header
      class="chat-window__header"
      data-floating-chat-handle
      :aria-label="gestureable ? text('chat.dragWindow') : undefined"
      @pointerdown="onHeaderPointerDown"
    >
      <GripHorizontal v-if="gestureable" class="chat-window__grip" :size="16" aria-hidden="true" />
      <h2 :id="titleId">{{ text('chat.title') }}</h2>
      <button
        type="button"
        class="chat-window__close"
        data-floating-chat-close
        :aria-label="text('chat.closeFloating')"
        @click="emit('close')"
      >
        <X :size="18" aria-hidden="true" />
      </button>
    </header>

    <div class="chat-window__body">
      <slot />
    </div>

    <!--
      A resize handle is a pointer affordance. It carries no tabindex and no role,
      because a focusable control that only responds to a drag would promise a keyboard
      interaction it cannot honour. The window remains fully usable without it: reading,
      closing and reopening never require a resize.
    -->
    <span
      v-if="gestureable"
      class="chat-window__resize"
      data-floating-chat-resize
      aria-hidden="true"
      :title="text('chat.resizeWindow')"
      @pointerdown="onResizePointerDown"
    />
  </section>
</template>

<style scoped>
.chat-window {
  /* Fixed, so the window is positioned against the viewport its layout was clamped to.
     Inside the workspace's transformed zones the same coordinates would be relative to
     a box that is itself inset, and the clamp would be measuring the wrong rectangle. */
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--layer-workspace-chat-window);
  display: flex;
  flex-direction: column;
  /* The body scrolls; the window does not grow past the size the user chose. Without
     min-height: 0 here a flex child's auto minimum would let the content push the
     window taller than its own height. */
  min-height: 0;
  overflow: hidden;
  color: var(--colour-text-primary);
  border-radius: var(--radius-surface);
}

.chat-window--active {
  /* Subtle lift, no spring: a drag should feel attached to the pointer. */
  box-shadow: 0 1.25rem 2.75rem rgb(0 0 0 / 38%);
}

.chat-window__header {
  display: flex;
  flex: 0 0 auto;
  gap: 0.5rem;
  align-items: center;
  padding: 0.5rem 0.5rem 0.5rem 0.75rem;
  border-block-end: var(--glass-border);
  cursor: grab;
  /* A drag must not paint a text selection across the title. */
  user-select: none;
  touch-action: none;
}

/*
 * The narrow-screen sheet.
 *
 * Not a window clamped small: it spans the width the way every other surface does at this
 * size, sits on the bottom edge above the player, and is bounded so it can never grow into
 * the top bar. Its own body scrolls, so a long conversation lengthens the scroll rather
 * than the sheet. Geometry lives here in full -- the component writes no box at this width,
 * so there is nothing for an inline style to disagree with.
 */
.chat-window[data-chat-narrow="true"] {
  /* Bottom-anchored, so the header and its close button are the part nearest the thumb. */
  top: auto;
  right: var(--workspace-edge-inset);
  bottom: var(--chat-sheet-block-end, var(--workspace-edge-inset));
  left: var(--workspace-edge-inset);
  width: auto;
  /* Bounded rather than sized: enough of the viewport to be a real reading surface, never
     so much that it reaches the top bar, and never taller than the room left above the
     player. 3rem covers the wrapped two-row bar this width produces. */
  height: auto;
  max-height: min(60dvh, calc(100dvh - var(--chat-sheet-block-end, 0px) - 3rem), var(--chat-sheet-available-block-size, 100dvh));
}
.chat-window[data-chat-narrow="true"] .chat-window__header { cursor: default; touch-action: auto; }
.chat-window--active .chat-window__header { cursor: grabbing; }
.chat-window__grip { flex: 0 0 auto; color: var(--colour-text-muted); }
.chat-window__header h2 {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 0.9375rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-window__close {
  display: grid;
  flex: 0 0 auto;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  place-items: center;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 50%;
  cursor: pointer;
  transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease;
}

.chat-window__close:hover,
.chat-window__close:focus-visible { filter: var(--control-hover-filter); }
.chat-window__close:active { transform: scale(0.94); filter: var(--control-active-filter); }

.chat-window__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 0.875rem 1rem 1rem;
  overflow: auto;
  overscroll-behavior: contain;
}

.chat-window__resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 1.25rem;
  height: 1.25rem;
  cursor: nwse-resize;
  /* Two hairlines rather than a glyph: visible as an affordance, quiet enough that it
     does not read as a control competing with the close button. */
  background:
    linear-gradient(135deg, transparent 46%, var(--colour-text-muted) 46%, var(--colour-text-muted) 54%, transparent 54%),
    linear-gradient(135deg, transparent 70%, var(--colour-text-muted) 70%, var(--colour-text-muted) 78%, transparent 78%);
  touch-action: none;
}

@media (prefers-reduced-motion: reduce) {
  .chat-window__close { transition-duration: 0ms; }
}
.chat-window { border: 0; border-radius: var(--liquid-radius-popover); }
.chat-window__header { border-color: var(--liquid-separator); }
.chat-window__close { width: 2.75rem; height: 2.75rem; border: 0; background: transparent; }
.chat-window__close:hover { background: rgb(255 255 255 / 9%); }
</style>
