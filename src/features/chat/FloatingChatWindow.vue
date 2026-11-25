<script setup lang="ts">
/**
 * A floating window: it owns where it is, how big it is, and the gestures that change
 * either. It owns nothing about chat. Messages, presence, transport and moderation
 * belong to whatever is slotted into its body.
 *
 * Gestures are Pointer Events throughout. One implementation then covers mouse, pen and
 * touch, and `setPointerCapture` keeps a drag attached to the window even when the
 * pointer outruns it -- which it will, because clamping deliberately stops the window
 * before the cursor stops.
 *
 * Phones get the same movable, resizable window as desktop, opening at 300x380 as in
 * StudyWithMiku (https://github.com/shshouse/StudyWithMiku, GPL-3.0). They remember their
 * own layout, and follow the visual viewport so the on-screen keyboard cannot hide the
 * composer.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { GripHorizontal, X } from 'lucide-vue-next'

import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import { safeLocalStorage } from '../../utils/safeStorage'
import {
  CHAT_LAYOUT_STORAGE_KEY,
  CHAT_NARROW_LAYOUT_STORAGE_KEY,
  DEFAULT_CHAT_HEIGHT,
  DEFAULT_CHAT_WIDTH,
  DEFAULT_NARROW_CHAT_HEIGHT,
  DEFAULT_NARROW_CHAT_WIDTH,
  clampChatLayout,
  defaultChatLayout,
  defaultNarrowChatLayout,
  parseChatLayout,
  reconcileChatLayout,
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
}>(), { inert: false, reserved: undefined, obstructedTop: undefined })
const emit = defineEmits<{ (event: 'close'): void }>()

const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)
const titleId = 'floating-chat-title'
const root = ref<HTMLElement>()
/** Matches the 47.99rem breakpoint the workspace uses for "narrow". */
const NARROW_VIEWPORT = 767

const isNarrow = (): boolean => typeof window !== 'undefined' && window.innerWidth <= NARROW_VIEWPORT
const narrow = ref(isNarrow())
const storageKey = (): string => narrow.value ? CHAT_NARROW_LAYOUT_STORAGE_KEY : CHAT_LAYOUT_STORAGE_KEY

/** The visual viewport's offset inside the layout viewport, which moves when a keyboard opens. */
const viewportLeft = ref(0)
const viewportTop = ref(0)

function viewport(): Viewport {
  // On a phone the keyboard shrinks the visual viewport, not the layout viewport; fitting the
  // window to the visual one keeps its header and composer above the keyboard.
  const visual = narrow.value ? window.visualViewport : undefined
  return {
    width: visual?.width ?? window.innerWidth,
    height: visual?.height ?? window.innerHeight,
    top: props.obstructedTop?.(),
  }
}

function storedLayout(): ChatLayout | undefined {
  return parseChatLayout(safeLocalStorage.getItem(storageKey()))
}

function derivedLayout(): ChatLayout {
  const stored = storedLayout()
  if (stored) return reconcileChatLayout(stored, viewport(), props.reserved?.(), true)
  return narrow.value
    ? defaultNarrowChatLayout(viewport(), props.reserved?.())
    : defaultChatLayout(viewport(), props.reserved?.())
}

// Resolved during setup rather than on mount, so the first painted frame is already the
// remembered layout instead of a placeholder that then jumps.
function initialLayout(): ChatLayout {
  if (typeof window === 'undefined') {
    return { x: 0, y: 0, width: DEFAULT_CHAT_WIDTH, height: DEFAULT_CHAT_HEIGHT }
  }
  return derivedLayout()
}

const layout = ref<ChatLayout>(initialLayout())
/** Whether this mode's layout came from the user or storage, rather than being derived. */
const userPlaced = ref(typeof window === 'undefined' ? false : storedLayout() !== undefined)
const dragging = ref(false)
const resizing = ref(false)
const gestureable = computed(() => !props.inert)

const style = computed(() => ({
  transform: `translate(${layout.value.x + viewportLeft.value}px, ${layout.value.y + viewportTop.value}px)`,
  width: `${layout.value.width}px`,
  height: `${layout.value.height}px`,
}))

function syncVisualViewport(): void {
  viewportLeft.value = narrow.value ? window.visualViewport?.offsetLeft ?? 0 : 0
  viewportTop.value = narrow.value ? window.visualViewport?.offsetTop ?? 0 : 0
}

function persist(): void {
  safeLocalStorage.setItem(storageKey(), serialiseChatLayout(layout.value))
}

function sameLayout(first: ChatLayout, second: ChatLayout): boolean {
  return first.x === second.x && first.y === second.y
    && first.width === second.width && first.height === second.height
}

function setLayout(next: ChatLayout, remember: boolean): void {
  if (sameLayout(layout.value, next)) return
  layout.value = next
  if (remember && userPlaced.value) persist()
}

/**
 * Fits the window to the viewport in front of the user. On desktop a safety move becomes the
 * remembered placement, as before. On a phone it does not: the viewport shrinks every time the
 * keyboard opens, and remembering that squeezed size would lose the size the user chose. The
 * phone window is re-derived from its stored layout instead, so it grows back on its own.
 */
function applyViewport(): void {
  const wasNarrow = narrow.value
  narrow.value = isNarrow()
  syncVisualViewport()
  if (narrow.value !== wasNarrow) {
    userPlaced.value = storedLayout() !== undefined
    layout.value = derivedLayout()
    return
  }
  if (narrow.value) {
    setLayout(derivedLayout(), false)
    return
  }
  setLayout(userPlaced.value
    ? reconcileChatLayout(layout.value, viewport(), props.reserved?.(), true)
    : defaultChatLayout(viewport(), props.reserved?.()), true)
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

/**
 * What a finished gesture stores. A resize stores the size the user dragged to. A move on a
 * phone stores only the new position: while the keyboard or a landscape turn squeezes the
 * window, its displayed size is a temporary clamp, and saving it would stop the window from
 * growing back to the size the user chose.
 */
function rememberedLayout(kind: 'move' | 'resize'): ChatLayout {
  if (kind === 'resize' || !narrow.value) return layout.value
  const stored = storedLayout()
  return {
    ...layout.value,
    width: stored?.width ?? Math.max(layout.value.width, DEFAULT_NARROW_CHAT_WIDTH),
    height: stored?.height ?? Math.max(layout.value.height, DEFAULT_NARROW_CHAT_HEIGHT),
  }
}

function track(
  event: PointerEvent,
  onMove: (deltaX: number, deltaY: number) => void,
  active: typeof dragging,
  kind: 'move' | 'resize',
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
    // Capture is an optimisation: the listeners below are on the handle either way.
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
    // One write per gesture rather than one per frame.
    safeLocalStorage.setItem(storageKey(), serialiseChatLayout(rememberedLayout(kind)))
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
  }, dragging, 'move')
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
  }, resizing, 'resize')
}

function onKeydown(event: KeyboardEvent): void {
  // On a phone there is no pointer to reach the close button quickly with an external
  // keyboard, so Escape closes the window; the workspace returns focus to its opener.
  if (event.key !== 'Escape' || event.defaultPrevented || !narrow.value || props.inert) return
  event.preventDefault()
  event.stopPropagation()
  emit('close')
}

/** Called by the workspace when the window is reopened, so it lands somewhere valid. */
function reconcile(): void {
  applyViewport()
  if (userPlaced.value && !narrow.value) persist()
}

/** Reconcile against live Player geometry without discarding a user-chosen placement. */
function renegotiate(): void {
  syncVisualViewport()
  if (narrow.value) {
    setLayout(derivedLayout(), false)
    return
  }
  setLayout(userPlaced.value
    ? reconcileChatLayout(layout.value, viewport(), props.reserved?.(), true)
    : defaultChatLayout(viewport(), props.reserved?.()), true)
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
  window.visualViewport?.addEventListener('resize', applyViewport)
  window.visualViewport?.addEventListener('scroll', syncVisualViewport)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', applyViewport)
  window.visualViewport?.removeEventListener('resize', applyViewport)
  window.visualViewport?.removeEventListener('scroll', syncVisualViewport)
})

defineExpose({ reconcile, renegotiate, focusWindow, windowElement })
</script>

<template>
  <!--
    A non-modal landmark on every screen size: music and the workspace stay usable around it.
    A higher workspace modal temporarily makes it inert.
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
    @keydown="onKeydown"
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
      A resize handle is a pointer affordance. It carries no tabindex and no role, because a
      focusable control that only responds to a drag would promise a keyboard interaction it
      cannot honour. Reading, closing and reopening never require a resize.
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
  /* Fixed, so the window is positioned against the viewport its layout was clamped to. */
  position: fixed;
  top: 0;
  left: 0;
  z-index: var(--layer-workspace-chat-window);
  display: flex;
  flex-direction: column;
  /* The body scrolls; the window does not grow past the size the user chose. */
  min-height: 0;
  overflow: hidden;
  color: var(--colour-text-primary);
  border: 0;
  border-radius: var(--liquid-radius-popover);
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
  padding: 0.375rem 0.375rem 0.375rem 0.75rem;
  border-block-end: 1px solid var(--liquid-separator);
  cursor: grab;
  /* A drag must not paint a text selection or start a page scroll. */
  user-select: none;
  touch-action: none;
}
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
  width: 2.75rem;
  height: 2.75rem;
  padding: 0;
  place-items: center;
  color: var(--colour-text-primary);
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
  transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease;
}

.chat-window__close:hover { background: rgb(255 255 255 / 9%); }
.chat-window__close:hover,
.chat-window__close:focus-visible { filter: var(--control-hover-filter); }
.chat-window__close:active { transform: scale(0.94); filter: var(--control-active-filter); }

.chat-window__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  padding: 0.75rem 0.875rem 0.875rem;
  overflow: hidden;
  overscroll-behavior: contain;
}

.chat-window__resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 1.25rem;
  height: 1.25rem;
  cursor: nwse-resize;
  /* Two hairlines rather than a glyph: visible, but quieter than the close button. */
  background:
    linear-gradient(135deg, transparent 46%, var(--colour-text-muted) 46%, var(--colour-text-muted) 54%, transparent 54%),
    linear-gradient(135deg, transparent 70%, var(--colour-text-muted) 70%, var(--colour-text-muted) 78%, transparent 78%);
  touch-action: none;
}

/* A fingertip needs a 44px target; the hairlines stay in the corner, the hit area grows. */
@media (pointer: coarse) {
  .chat-window__resize {
    width: 2.75rem;
    height: 2.75rem;
    background-size: 1.25rem 1.25rem;
    background-position: right bottom;
    background-repeat: no-repeat;
  }
}

@media (max-height: 450px) {
  .chat-window__header { padding-block: 0.25rem; }
  .chat-window__body { padding-block: 0.25rem; }
}

@media (prefers-reduced-motion: reduce) {
  .chat-window__close { transition-duration: 0ms; }
}
</style>
