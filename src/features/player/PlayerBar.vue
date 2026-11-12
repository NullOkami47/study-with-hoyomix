<script setup lang="ts">
import { type DirectiveBinding, computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, shallowRef, watch, watchEffect } from 'vue'
import { ChevronDown, ListMusic, LoaderCircle, MoreHorizontal, Music2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-vue-next'

import YouTubePlayer from './YouTubePlayer.vue'
import type { FailureOutcome, PlaybackMediaState, PlaybackStore } from './store'
import { isPreparationFresh } from './store'
import { translate, type TranslationKey } from '../../i18n'
import { resolveDisplayTitle } from '../catalog/displayTitle'
import { usePreferences } from '../../stores/preferences'
import { registerPlayerCommands, type PlaybackPauseLease, type PlayerCommands } from './commands'
import { NEXT_TRACK_PRELOAD_LEAD_SECONDS, selectPreloadPolicy } from './preloadPolicy'
import { inspectBuffer, waitForBuffer } from './bufferReadiness'
import { boundedOverlapDuration, fadeGains, supportsNativeVolumeControl, transitionDuration } from './transitionEngine'
import { planSmartMix, startPassiveEnergySampling, type EnergySample } from './smartMix'
import { formatPlaybackQuality } from './qualityFormat'
import { deriveLxCandidates } from './lx/candidates'
import { isChkszExternalId } from '../../shared/chksz'
import { createJellyfinProvider } from './providers/jellyfin'
import { formatPlaybackTime, publishPlaybackPresentation } from './presentation'
import { registerPlaybackMediaSession } from './mediaSession'
import { describeMediaElement, installPlaybackLogLifecycle, recordPlayback } from './playbackLog'

const props = withDefaults(defineProps<{
  store: PlaybackStore
  compact?: boolean
  queueOpen?: boolean
  mediaSuspended?: boolean
}>(), {
  compact: false,
  queueOpen: false,
  mediaSuspended: false,
})
const emit = defineEmits<{ (event: 'toggle-queue'): void }>()
const { locale } = usePreferences()
const text = (key: TranslationKey, params?: Record<string, unknown>): string => translate(locale.value, key, params)
interface NetworkInformationLike {
  effectiveType?: string
  saveData?: boolean
  addEventListener?(type: 'change', listener: () => void): void
  removeEventListener?(type: 'change', listener: () => void): void
}
interface AudioDeck {
  generation: number
  mimeType: string
  preload: 'metadata' | 'auto'
  preparationId?: number
  /**
   * The element that played the previous track, kept mounted without a source during a handover
   * so ladder step (a) can play the new URL on it (P96-06).
   */
  retained?: boolean
  src: string
  trackId: string
}
interface RawTimeRange {
  start: number
  end: number
}
interface BufferedSegment {
  start: number
  end: number
  startPercent: number
  endPercent: number
  widthPercent: number
  containsCurrent: boolean
}
const emptyDeck = (): AudioDeck => ({ generation: -1, mimeType: '', preload: 'metadata', src: '', trackId: '' })
const initialPlayable = props.store.playable.value
const audioDecks = ref<[AudioDeck, AudioDeck]>([
  initialPlayable?.kind === 'audio' ? {
    generation: props.store.playbackGeneration.value, mimeType: initialPlayable.mimeType,
    preload: 'metadata', src: initialPlayable.url, trackId: props.store.currentTrack.value?.id ?? '',
  } : emptyDeck(),
  emptyDeck(),
])
const audioDeckElements = ref<HTMLAudioElement[]>([])
const glassHeroRoot = ref<HTMLElement>()
const activeDeckIndex = ref(0)
// Only same-track recovery can keep the outgoing source. It stays audible until the new
// element has sought and started, preserving Chrome's native media session in the background.
const recoveryRetainedIndex = ref<number>()
const prerollDeckIndex = ref<number>()
const prerollRewindIndex = ref<number>()
const PREROLL_LEAD_SECONDS = 1.2
let preroll: { index: number; element: HTMLAudioElement; preparationId: number; generation: number } | undefined
let rejectedPrerollId: number | undefined
let prerollTimer: ReturnType<typeof setTimeout> | undefined
let backgroundHandoff: { index: number; element: HTMLAudioElement; preparationId: number; generation: number; trackId: string } | undefined
let backgroundStartedGeneration: number | undefined
const expectedPrerollPauses = new WeakMap<HTMLAudioElement, { generation: number; src: string }>()
let recoveryRetainTimer: ReturnType<typeof setTimeout> | undefined
const deckElement = (index: number): HTMLAudioElement | null => audioDeckElements.value.find(
  (element) => element.dataset.audioDeck === String(index),
) ?? null
// Render and immediate handoff share an idempotent source writer. Vue's native
// :src patch would otherwise re-load the URL after the synchronous play request.
const vAudioSource = (element: HTMLAudioElement, binding: DirectiveBinding<string | undefined>): void => {
  if (binding.value) {
    if (element.getAttribute('src') !== binding.value) element.setAttribute('src', binding.value)
  } else if (element.hasAttribute('src')) element.removeAttribute('src')
}
const audio = computed(() => {
  const playable = props.store.playable.value
  const deck = audioDecks.value[activeDeckIndex.value]
  if (
    playable?.kind !== 'audio' || deck.generation !== props.store.playbackGeneration.value ||
    deck.trackId !== props.store.currentTrack.value?.id || deck.src !== playable.url
  ) return null
  return deckElement(activeDeckIndex.value)
})
const youtube = ref<{ pause(): void; play(): void; setVolume(value: number): void } | null>(null)
const offline = ref(typeof navigator !== 'undefined' && !navigator.onLine)
const collapsed = ref(true)
const currentTime = ref(0)
const duration = ref(0)
const seekable = ref(false)
const lastAudibleVolume = ref(0.7)
const canSeek = computed(() => props.store.playable.value?.kind === 'audio' && duration.value > 0 && seekable.value)
const trackGames = computed(() => props.store.currentTrack.value?.games.map((game) => text(`game.${game}`)).join(' · ') ?? '')
const bufferedRawRanges = ref<RawTimeRange[]>([])
const bufferedSegments = computed<BufferedSegment[]>(() => {
  if (props.store.playable.value?.kind !== 'audio' || duration.value <= 0) return []
  const total = duration.value
  const pos = currentTime.value
  return bufferedRawRanges.value.map((range) => {
    const clampedStart = Math.max(0, Math.min(range.start, total))
    const clampedEnd = Math.max(clampedStart, Math.min(range.end, total))
    const startPercent = (clampedStart / total) * 100
    const endPercent = (clampedEnd / total) * 100
    const widthPercent = Math.max(0, endPercent - startPercent)
    const containsCurrent = pos >= clampedStart && pos <= clampedEnd
    return {
      start: clampedStart,
      end: clampedEnd,
      startPercent,
      endPercent,
      widthPercent,
      containsCurrent,
    }
  }).filter((segment) => segment.widthPercent > 0)
})
const currentBufferedExtent = computed<BufferedSegment | null>(() => {
  const current = currentTime.value
  const enclosing = bufferedSegments.value.find(
    (segment) => current >= segment.start && current <= segment.end,
  )
  if (enclosing) return enclosing
  const priorSegments = bufferedSegments.value.filter((segment) => segment.start <= current)
  return priorSegments.length > 0 ? priorSegments[priorSegments.length - 1] : null
})
const playedPercent = computed(() => {
  if (duration.value <= 0) return 0
  return Math.max(0, Math.min(100, (currentTime.value / duration.value) * 100))
})
/**
 * The localised label for the current track.
 *
 * Display-only. The store keeps using the untouched track for identity, provider selection and
 * queue operations, so switching language can never change what is played or how it is resolved.
 */
const currentTrackLabel = computed(() =>
  resolveDisplayTitle(props.store.currentTrack.value, locale.value, text('player.noTrack')))
/** The store's playback notices as localised text (P96-04). Optional: test stubs may omit them. */
const playbackNoticeItems = computed(() => (props.store.playbackNotices?.value ?? []).map((notice) => {
  const track = notice.trackId ? props.store.queue.value.find(({ id }) => id === notice.trackId) : undefined
  const title = track ? resolveDisplayTitle(track, locale.value, notice.title ?? '') : notice.title ?? text('player.noTrack')
  return { id: notice.id, kind: notice.kind, message: text(`player.notice.${notice.kind}` as TranslationKey, { title }) }
}))
const dismissPlaybackNotice = (id: number): void => { props.store.dismissNotice?.(id) }
const upcomingCount = computed(() => props.store.queue.value.slice(Math.max(0, props.store.currentIndex.value + 1)).length)
const queueLabel = computed(() => text('player.queueLabel').replace('{count}', String(upcomingCount.value)))
const connection = (): NetworkInformationLike | undefined =>
  (navigator as Navigator & { connection?: NetworkInformationLike }).connection
const updateConnectivity = (): void => {
  offline.value = !navigator.onLine
  props.store.setPreloadPolicy(selectPreloadPolicy({
    online: navigator.onLine,
    connection: connection(),
  }))
}
let unregisterPlayerCommands: (() => void) | undefined
let unregisterMediaSession: (() => void) | undefined
let resumeAfterSuspension = false
let youtubeSuspensionApplied = false
let playbackCommandRevision = 0
/** Media promises are invalidated by pauses without revoking a timer pause lease. */
let mediaOperationRevision = 0
const INITIAL_PLAY_FALLBACK_MS = 7_000
const PLAYBACK_STALL_FALLBACK_MS = 9_000
let playbackStallTimer: number | undefined
let resumeSeekTimer: number | undefined
let lastObservedPosition = 0
let nativeInterruptionGeneration: number | undefined
/** A network failure can stop a previously playing decoder before its replacement is ready. */
const networkErrorSources = new WeakMap<HTMLAudioElement, { generation: number; commandRevision: number; pauseObserved: boolean }>()
/** P96-06: a handed-over element that has not advanced shows the starting state, never Pause. */
const transportStarting = computed(() => props.store.playbackIntent.value === 'playing' &&
  props.store.awaitingStart?.value?.generation === props.store.playbackGeneration.value &&
  ['playing', 'buffering', 'resolving', 'ready'].includes(props.store.status.value))
const transportPlaying = computed(() => !transportStarting.value && props.store.playbackIntent.value === 'playing' &&
  ['playing', 'buffering', 'resolving', 'ready'].includes(props.store.status.value))
/** The progress check armed on every handover, for every provider (P96-06). */
const HANDOVER_PROGRESS_TIMEOUT_MS = 5_000
/**
 * Delay before the ladder step after a refused start (`NotAllowedError`, an unchanged-load
 * `AbortError`): the step runs in a later task, outside the rejected `play()` chain.
 */
const HANDOVER_REFUSAL_STEP_DELAY_MS = 250
/**
 * Task 41: a watchdog check that finds the handover element still loading (accepted `play()`, no
 * MediaError, network activity) re-arms instead of escalating, up to this total from the handover
 * start. A phone-network refill from an empty buffer can take well over 5 s; past this bound the
 * ladder runs as before, so a stuck load still reaches the notice in about 25 s at most.
 */
const HANDOVER_LOADING_LIMIT_MS = 20_000
/**
 * Task 41: automatic resume after a refused or missing start (tap-to-resume notice). Retries run
 * on page events and, while the page is visible, at these delays after each refused attempt; then
 * stop (4 timer retries per track, well inside 20 `play()` calls per minute).
 */
const AUTO_RESUME_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000] as const
/** Non-gesture page events closer together than this share one attempt. */
const AUTO_RESUME_EVENT_SPACING_MS = 1_000
/** An automatic `play()` still unsettled after this counts as not started (the next retry may run). */
const AUTO_RESUME_SETTLE_MS = 5_000
interface AutoResumeState {
  generation: number
  /** Timer retries used for this generation (index into AUTO_RESUME_BACKOFF_MS). */
  backoffUsed: number
  timer: number | undefined
  inFlight: boolean
  /** The last attempt's `play()` was accepted; page events wait for progress or a new refusal. */
  accepted: boolean
  lastAttemptAt: number
}
let autoResume: AutoResumeState | undefined
/**
 * Task 41: the last `play()` request per element, and the last network-activity event. A request
 * is recorded before its promise is awaited, because the HTML spec keeps that promise pending
 * until playback actually starts: a buffering element has a pending, not a resolved, `play()`.
 * Pending and resolved both count as accepted; a rejection removes the request.
 */
interface PlayRequest { src: string; generation: number; state: 'pending' | 'resolved' }
const playRequests = new WeakMap<HTMLMediaElement, PlayRequest>()
interface ActiveMediaRecovery {
  /** A cancelled starting handover cannot be adopted by a later Play command. */
  startedDuringHandover: boolean
  operationRevision: number
  commandRevision: number
  cancelled: boolean
  /** Explicit Pause and seek retire this owner; only native interruptions can be reauthorised. */
  retired: boolean
  generation: number
  providerId: string | undefined
  stillNeeded?: () => boolean
  promise: Promise<void>
}
let activeMediaRecovery: ActiveMediaRecovery | undefined
const loadActivityAt = new WeakMap<HTMLMediaElement, number>()
const loadObservedElements = new WeakSet<HTMLMediaElement>()
const LOAD_ACTIVITY_EVENTS = ['loadstart', 'progress', 'waiting', 'stalled'] as const
interface HandoverState {
  generation: number
  trackId: string
  /** `Date.now()` at the handover start; bounds the loading extension. */
  startedAt: number
  startPosition: number
  /** Deck index of the retained element that played the previous track; -1 when none is left. */
  retainedIndex: number
  step: 'promoted' | 'swapped' | 'reResolving' | 'reResolved'
  advancing: boolean
}
let handover: HandoverState | undefined
let handoverWatchdog: number | undefined
interface TimerPauseLeaseState {
  generation: number
  owner: symbol
  resumeRequested: boolean
  revision: number
  settled: boolean
}
let activeTimerPauseLease: TimerPauseLeaseState | undefined
/**
 * Origin of the last pause of the active element (D20, P95-03). `player` is a pause this component
 * asked for (`pauseMedia`); any other `pause` event is `native` (OS, headset, another tab). A timer
 * pause lease never takes ownership after a native pause, so its release cannot undo that pause.
 */
let lastPauseOrigin: { origin: 'native' | 'player'; generation: number } | undefined
let playerPauseRequested = false

/* Playback event log (task 41.1). Logging only: none of this changes what the player does. */
/** Elements that reached playing at least once (Chrome ties media activation to the element). */
const everPlayedElements = new WeakSet<HTMLMediaElement>()
const instrumentedElements = new WeakSet<HTMLMediaElement>()
const LOGGED_MEDIA_EVENTS = [
  'play', 'playing', 'pause', 'waiting', 'stalled', 'suspend', 'canplay', 'loadstart', 'error', 'ended', 'emptied', 'abort',
] as const
const PROGRESS_SAMPLE_INTERVAL_MS = 5_000
let lastProgressSampleAt = Number.NEGATIVE_INFINITY
let uninstallPlaybackLogLifecycle: (() => void) | undefined
function elementEverPlayed(element: HTMLMediaElement | null | undefined): boolean {
  return Boolean(element && everPlayedElements.has(element))
}
function pageLogState(): Record<string, unknown> {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation
  return {
    visibility: typeof document !== 'undefined' ? document.visibilityState : null,
    focused: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : null,
    userActive: activation?.isActive ?? null,
    userHasBeenActive: activation?.hasBeenActive ?? null,
  }
}
function onLoggedMediaEvent(event: Event): void {
  const element = event.currentTarget
  if (!(element instanceof HTMLMediaElement)) return
  if (event.type === 'playing') everPlayedElements.add(element)
  recordPlayback(`media.${event.type}`, {
    ...describeMediaElement(element), active: element.dataset.audioDeck === String(activeDeckIndex.value),
    everPlayed: everPlayedElements.has(element), visibility: document.visibilityState,
  })
}
function instrumentDeckElements(): void {
  for (const element of audioDeckElements.value) {
    if (instrumentedElements.has(element)) continue
    instrumentedElements.add(element)
    for (const type of LOGGED_MEDIA_EVENTS) element.addEventListener(type, onLoggedMediaEvent)
  }
}

/* Task 41: network activity per deck element, read by the handover watchdog. */
function onLoadActivity(event: Event): void {
  if (event.currentTarget instanceof HTMLMediaElement) loadActivityAt.set(event.currentTarget, Date.now())
}
function observeDeckLoadActivity(): void {
  for (const element of audioDeckElements.value) {
    if (loadObservedElements.has(element)) continue
    loadObservedElements.add(element)
    for (const type of LOAD_ACTIVITY_EVENTS) element.addEventListener(type, onLoadActivity)
  }
}

/**
 * The handover element is still loading: its `play()` for the current `src` and generation was
 * requested and not rejected (pending or resolved), it has no MediaError, it cannot play ahead yet,
 * and the network is fetching (or fetched within one check). An idle, refused or errored element
 * is not loading, so the ladder decides it as before.
 */
function handoverElementLoading(element: HTMLMediaElement | null | undefined, generation: number): boolean {
  if (!element || element.error) return false
  const src = element.getAttribute('src')
  const request = playRequests.get(element)
  if (!src || !request || request.src !== src || request.generation !== generation) return false
  if (element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return false
  if (element.networkState === HTMLMediaElement.NETWORK_LOADING) return true
  const lastActivity = loadActivityAt.get(element)
  return lastActivity !== undefined && Date.now() - lastActivity <= HANDOVER_PROGRESS_TIMEOUT_MS
}

function clearPlaybackStall(): void {
  if (playbackStallTimer !== undefined) {
    clearTimeout(playbackStallTimer)
    playbackStallTimer = undefined
  }
}

function canAttemptStallRecovery(): boolean {
  const providerId = props.store.activeProviderId.value
  if (
    activeMediaRecovery?.generation === props.store.playbackGeneration.value ||
    handoverActive(handover, props.store.playbackGeneration.value) ||
    props.store.awaitingStart?.value?.generation === props.store.playbackGeneration.value ||
    autoResume?.generation === props.store.playbackGeneration.value ||
    props.store.pendingResumePosition.value !== undefined ||
    nativeInterruptionGeneration === props.store.playbackGeneration.value ||
    props.store.playbackIntent.value !== 'playing' ||
    ['ended', 'error', 'resolving'].includes(props.store.status.value) ||
    props.store.playable.value?.kind !== 'audio' || !providerId
  ) return false
  return props.store.registrySnapshot?.().registry.selectable().some(({ provider }) => provider.id === providerId) === true
}

/** Only a `halted` outcome stops the element; every other outcome leaves it to `syncActiveDeck`. */
function pauseIfHalted(outcome: FailureOutcome | 'recovered', generation: number): void {
  if (outcome === 'halted' && generation === props.store.playbackGeneration.value) audio.value?.pause()
}

function clearHandoverWatchdog(): void {
  if (handoverWatchdog !== undefined) {
    clearTimeout(handoverWatchdog)
    handoverWatchdog = undefined
  }
}

/** End the handover check: clear the watchdog and unmount the retained previous element. */
function endHandover(): void {
  clearHandoverWatchdog()
  const state = handover
  handover = undefined
  if (state) recordPlayback('handover.end', { gen: state.generation, trackId: state.trackId, step: state.step })
  if (state) releaseRetainedDeck(state.retainedIndex)
}

function releaseRetainedDeck(index: number): void {
  const deck = audioDecks.value[index]
  if (deck?.retained && !deck.src && index !== activeDeckIndex.value) clearDeck(index)
}

function handoverActive(state: HandoverState | undefined, generation = props.store.playbackGeneration.value): state is HandoverState {
  return Boolean(state && state === handover && state.generation === generation &&
    state.trackId === props.store.currentTrack.value?.id)
}

/** Start the check after a promotion; only a real handover (the store's starting state) gets one. */
function beginHandover(generation: number, trackId: string, retainedIndex: number): void {
  clearHandoverWatchdog()
  handover = undefined
  const awaiting = props.store.awaitingStart?.value
  if (awaiting?.generation !== generation) {
    recordPlayback('handover.notStarting', { gen: generation, trackId, retainedIndex, awaitingGen: awaiting?.generation ?? null })
    releaseRetainedDeck(retainedIndex)
    return
  }
  recordPlayback('handover.begin', { gen: generation, trackId, retainedIndex, startPosition: awaiting.startPosition, deck: activeDeckIndex.value })
  handover = {
    generation, trackId, startedAt: Date.now(), startPosition: awaiting.startPosition, retainedIndex, step: 'promoted', advancing: false,
  }
  armHandoverWatchdog()
}

/**
 * One check at HANDOVER_PROGRESS_TIMEOUT_MS after each ladder step, however late the timer fires.
 * No progress past the start position starts the next ladder step, except while the element is
 * still loading (task 41): then the check re-arms, until HANDOVER_LOADING_LIMIT_MS from the start.
 */
function armHandoverWatchdog(timeoutMs = HANDOVER_PROGRESS_TIMEOUT_MS): void {
  clearHandoverWatchdog()
  const state = handover
  if (!state) return
  recordPlayback('handover.watchdog.arm', { gen: state.generation, step: state.step, timeoutMs })
  handoverWatchdog = window.setTimeout(() => {
    handoverWatchdog = undefined
    if (!handoverActive(state, state.generation)) return
    const element = audio.value
    const started = prerollRewindIndex.value !== activeDeckIndex.value &&
      (props.store.awaitingStart?.value?.generation !== state.generation ||
      Boolean(element && element.currentTime > state.startPosition))
    const elapsedMs = Date.now() - state.startedAt
    const remainingMs = HANDOVER_LOADING_LIMIT_MS - elapsedMs
    const ended = started || props.store.playbackIntent.value !== 'playing'
    const extend = !ended && remainingMs > 0 && handoverElementLoading(element, state.generation)
    recordPlayback('handover.watchdog.fire', {
      ...describeMediaElement(element), gen: state.generation, step: state.step, started,
      startPosition: state.startPosition, intent: props.store.playbackIntent.value, everPlayed: elementEverPlayed(element),
      decision: ended ? 'end' : extend ? 'extend' : 'ladder', elapsedMs, ...pageLogState(),
    })
    if (ended) {
      endHandover()
      // Hidden pages may advance native time without delivering timeupdate. Transfer that
      // observed progress to the normal watchdog before releasing the handover's monitoring.
      if (started && element && !element.paused && !element.seeking && props.store.playbackIntent.value === 'playing') {
        props.store.reportProgress?.(element.currentTime, state.generation)
        updateMediaPresentation(element)
        schedulePlaybackStall(PLAYBACK_STALL_FALLBACK_MS)
      }
    } else if (extend) {
      const nextMs = Math.min(HANDOVER_PROGRESS_TIMEOUT_MS, remainingMs)
      recordPlayback('handover.watchdog.extend', {
        gen: state.generation, step: state.step, elapsedMs, nextMs, limitMs: HANDOVER_LOADING_LIMIT_MS,
        lastLoadActivityMs: element && loadActivityAt.has(element) ? Date.now() - (loadActivityAt.get(element) ?? 0) : null,
      })
      armHandoverWatchdog(nextMs)
    } else void advanceHandoverLadder(state)
  }, timeoutMs)
}

/** A refused start is decided at once: the next ladder step replaces the pending progress check. */
function refuseHandoverStart(state: HandoverState, reason: string): void {
  recordPlayback('handover.refused', { gen: state.generation, step: state.step, reason, advancing: state.advancing, active: handoverActive(state, state.generation) })
  if (!handoverActive(state, state.generation) || state.advancing) return
  clearHandoverWatchdog()
  clearPlaybackStall()
  handoverWatchdog = window.setTimeout(() => {
    handoverWatchdog = undefined
    void advanceHandoverLadder(state)
  }, HANDOVER_REFUSAL_STEP_DELAY_MS)
}

/** The handover ladder (P96-06): (a) `src` swap, (b) same-position re-resolve, (c) tap-to-resume notice. */
async function advanceHandoverLadder(state: HandoverState): Promise<void> {
  if (!handoverActive(state, state.generation) || state.advancing) return
  state.advancing = true
  clearHandoverWatchdog()
  clearPlaybackStall()
  try {
    if (state.step === 'promoted') {
      state.step = 'swapped'
      recordPlayback('handover.ladder', { gen: state.generation, step: 'srcSwap', retainedIndex: state.retainedIndex })
      if (state.retainedIndex >= 0 && await props.store.recoverHandover('srcSwap', state.generation)) {
        if (!handoverActive(state, state.generation)) return
        if (swapToRetainedElement(state)) return
      }
    }
    if (!handoverActive(state, state.generation)) return
    if (state.step === 'swapped') {
      state.step = 'reResolving'
      recordPlayback('handover.ladder', { gen: state.generation, step: 'reResolve' })
      const renewed = await props.store.recoverHandover('reResolve', state.generation)
      if (state !== handover) return
      if (renewed) {
        state.generation = props.store.playbackGeneration.value
        state.step = 'reResolved'
        // The playable watcher plays the renewed URL; this is its one progress check.
        armHandoverWatchdog()
        return
      }
      state.step = 'reResolved'
    }
    if (!handoverActive(state, state.generation)) return
    recordPlayback('handover.ladder', { gen: state.generation, step: 'notice', ...pageLogState() })
    recordPlayback('notice.tapToResume.raise', { site: 'handoverLadder', gen: state.generation, trackId: state.trackId })
    const noticed = await props.store.recoverHandover('notice', state.generation)
    endHandover()
    if (noticed) armAutoResume(state.generation, 'handoverLadder')
  } finally {
    state.advancing = false
  }
}

/**
 * Ladder step (a): play the handed-over URL on the element that played the previous track (it was
 * unlocked by the listener's gesture), from the start position, and re-arm the watchdog once.
 */
function swapToRetainedElement(state: HandoverState): boolean {
  const playable = props.store.playable.value
  const retainedIndex = state.retainedIndex
  state.retainedIndex = -1
  const element = deckElement(retainedIndex)
  if (playable?.kind !== 'audio' || retainedIndex === activeDeckIndex.value ||
    !audioDecks.value[retainedIndex]?.retained || !element) {
    recordPlayback('handover.srcSwap', { gen: state.generation, ok: false, retainedIndex, hasElement: Boolean(element) })
    return false
  }
  const promotedIndex = activeDeckIndex.value
  recordPlayback('handover.srcSwap', { gen: state.generation, ok: true, fromDeck: promotedIndex, toDeck: retainedIndex, targetEverPlayed: elementEverPlayed(element) })
  const generation = props.store.playbackGeneration.value
  activeDeckIndex.value = retainedIndex
  assignDeck(retainedIndex, {
    generation, mimeType: playable.mimeType, preload: 'auto', src: playable.url, trackId: state.trackId,
  })
  // The promoted element is released the same way a promotion releases the outgoing deck.
  clearDeck(promotedIndex)
  try { element.currentTime = state.startPosition } catch { /* Applied by the next readiness event. */ }
  armHandoverWatchdog()
  void nextTick(() => {
    if (!handoverActive(state, generation) || audio.value !== element) return
    syncVolume(props.store.volume.value)
    void play(generation, props.store.activeProviderId.value, false)
  })
  return true
}

/*
 * Automatic resume (task 41). After a refused or missing start ends in the tap-to-resume notice,
 * while the listener still wants playback (intent `playing`), retry through `play()` on the active
 * element (its current `src`) when the page becomes usable again or on any gesture, and with a
 * bounded backoff while visible. A pause, a native interruption, a new generation or progress
 * ends it. The Media Session `play` action keeps its own path (commands.play).
 */
function clearAutoResumeTimer(state: AutoResumeState | undefined = autoResume): void {
  if (state?.timer !== undefined) {
    clearTimeout(state.timer)
    state.timer = undefined
  }
}

function cancelAutoResume(reason: string): void {
  const state = autoResume
  if (!state) return
  clearAutoResumeTimer(state)
  autoResume = undefined
  recordPlayback('autoResume.cancel', { gen: state.generation, reason, backoffUsed: state.backoffUsed })
}

function armAutoResume(generation: number, site: string): void {
  if (generation !== props.store.playbackGeneration.value || props.store.playbackIntent.value !== 'playing') return
  let state = autoResume
  if (state?.generation !== generation) {
    cancelAutoResume('newStart')
    state = { generation, backoffUsed: 0, timer: undefined, inFlight: false, accepted: false, lastAttemptAt: Number.NEGATIVE_INFINITY }
    autoResume = state
  }
  state.accepted = false
  recordPlayback('autoResume.arm', { gen: generation, site, backoffUsed: state.backoffUsed, ...pageLogState() })
  scheduleAutoResumeBackoff()
}

/** One timer retry at a time, only while visible; hidden pages wait for a page event. */
function scheduleAutoResumeBackoff(): void {
  const state = autoResume
  if (!state || state.timer !== undefined || state.inFlight || state.accepted) return
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  const delayMs = AUTO_RESUME_BACKOFF_MS[state.backoffUsed]
  if (delayMs === undefined) return
  state.backoffUsed += 1
  recordPlayback('autoResume.backoff', { gen: state.generation, delayMs, retry: state.backoffUsed })
  state.timer = window.setTimeout(() => {
    state.timer = undefined
    void attemptAutoResume('backoff')
  }, delayMs)
}

function autoResumeEligible(state: AutoResumeState): boolean {
  return state === autoResume && state.generation === props.store.playbackGeneration.value &&
    props.store.playbackIntent.value === 'playing' && props.store.status.value === 'paused' &&
    nativeInterruptionGeneration !== state.generation && props.store.playable.value?.kind === 'audio'
}

async function attemptAutoResume(trigger: string): Promise<void> {
  const state = autoResume
  if (!state) return
  recordPlayback('autoResume.trigger', { trigger, gen: state.generation, inFlight: state.inFlight, accepted: state.accepted, ...pageLogState() })
  if (!autoResumeEligible(state)) {
    if (state.generation !== props.store.playbackGeneration.value || props.store.playbackIntent.value !== 'playing' ||
      nativeInterruptionGeneration === state.generation) cancelAutoResume(`ineligible:${trigger}`)
    return
  }
  const gesture = trigger === 'pointerdown' || trigger === 'keydown'
  if (state.inFlight || (state.accepted && !gesture)) return
  if (!gesture && trigger !== 'backoff' && Date.now() - state.lastAttemptAt < AUTO_RESUME_EVENT_SPACING_MS) return
  if (trigger !== 'backoff' && state.timer !== undefined) {
    // An event attempt replaces the pending timer retry and gives its slot back.
    clearAutoResumeTimer(state)
    state.backoffUsed = Math.max(0, state.backoffUsed - 1)
  }
  state.inFlight = true
  state.lastAttemptAt = Date.now()
  const element = audio.value
  recordPlayback('autoResume.attempt', {
    ...describeMediaElement(element), trigger, gen: state.generation, backoffUsed: state.backoffUsed,
    everPlayed: elementEverPlayed(element), ...pageLogState(),
  })
  let settleTimer: number | undefined
  let settled: 'resolved' | 'refused' | 'pending' = 'pending'
  try {
    // A `play()` that never settles must not hold the retries forever. Only this attempt's own
    // resolved `play()` is accepted; any rejection (NotAllowedError, AbortError, ...) is refused.
    settled = await Promise.race([
      play(state.generation, props.store.activeProviderId.value, false, true)
        .then((resolved) => resolved ? 'resolved' as const : 'refused' as const),
      new Promise<'pending'>((resolve) => { settleTimer = window.setTimeout(() => resolve('pending'), AUTO_RESUME_SETTLE_MS) }),
    ])
  } finally {
    if (settleTimer !== undefined) clearTimeout(settleTimer)
    state.inFlight = false
  }
  if (state !== autoResume) return
  const outcome = settled === 'resolved' ? 'accepted' : settled
  recordPlayback('autoResume.outcome', { trigger, gen: state.generation, outcome, status: props.store.status.value })
  if (outcome === 'accepted') state.accepted = true
  else scheduleAutoResumeBackoff()
}

function onAutoResumePageEvent(event: Event): void {
  if (event.type === 'visibilitychange' && document.visibilityState !== 'visible') cancelPreroll()
  if (!autoResume) return
  if (event.type === 'visibilitychange' && document.visibilityState !== 'visible') {
    // Hidden: stop the timer retries (a hidden retry is refused) and keep the slot for later.
    if (autoResume.timer !== undefined) {
      clearAutoResumeTimer(autoResume)
      autoResume.backoffUsed = Math.max(0, autoResume.backoffUsed - 1)
    }
    return
  }
  if (event instanceof KeyboardEvent && event.repeat) return
  void attemptAutoResume(event.type)
}

const AUTO_RESUME_DOCUMENT_EVENTS = ['visibilitychange', 'resume', 'pointerdown', 'keydown'] as const
const AUTO_RESUME_WINDOW_EVENTS = ['pageshow', 'focus', 'online'] as const
const AUTO_RESUME_LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true }
function installAutoResumeListeners(): void {
  for (const type of AUTO_RESUME_DOCUMENT_EVENTS) document.addEventListener(type, onAutoResumePageEvent, AUTO_RESUME_LISTENER_OPTIONS)
  for (const type of AUTO_RESUME_WINDOW_EVENTS) window.addEventListener(type, onAutoResumePageEvent, AUTO_RESUME_LISTENER_OPTIONS)
}
function uninstallAutoResumeListeners(): void {
  for (const type of AUTO_RESUME_DOCUMENT_EVENTS) document.removeEventListener(type, onAutoResumePageEvent, AUTO_RESUME_LISTENER_OPTIONS)
  for (const type of AUTO_RESUME_WINDOW_EVENTS) window.removeEventListener(type, onAutoResumePageEvent, AUTO_RESUME_LISTENER_OPTIONS)
}

function schedulePlaybackStall(timeoutMs: number): void {
  if (playbackStallTimer !== undefined || !canAttemptStallRecovery()) return
  const generation = props.store.playbackGeneration.value
  lastObservedPosition = currentTime.value
  playbackStallTimer = window.setTimeout(() => {
    playbackStallTimer = undefined
    if (generation !== props.store.playbackGeneration.value || audio.value?.seeking ||
      props.store.playbackIntent.value !== 'playing' ||
      ['ended', 'error'].includes(props.store.status.value)) return
    const element = audio.value
    if (element && Math.abs(element.currentTime - lastObservedPosition) >= 0.25) {
      updateMediaPresentation(element)
      schedulePlaybackStall(timeoutMs)
      return
    }
    if (element?.paused && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return
    // D21 (P95-04): the decision follows `currentTime` progress and the media events that armed this
    // timer, never the timer's own delay; a late firing with no progress is a stall.
    const providerId = props.store.activeProviderId.value
    if (!element || !providerId || !canAttemptStallRecovery()) return
    const position = element.currentTime
    void recoverMediaFailure(providerId, generation, () =>
      audio.value === element && !element.seeking &&
      (!element.paused || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) &&
      nativeInterruptionGeneration !== generation && props.store.playbackIntent.value === 'playing' &&
      Math.abs(element.currentTime - position) < 0.25)
  }, timeoutMs)
}

function formatProviderLabel(id: string): string {
  if (id === 'youtube') return 'YouTube'
  if (id === 'r2') return 'R2'
  if (id === 'jellyfin') return 'Jellyfin'
  if (id === 'chksz') return 'ChKSz'
  if (id === 'lx') return 'LX Music'
  if (id === 'vkeys') return 'Vkeys'
  if (id === 'gd-studio') return 'GD Studio'
  if (id === 'lx-huanyin') return '幻音'
  return id
}

const providerName = computed(() => {
  const id = props.store.activeProviderId.value
  if (!id) return ''
  return formatProviderLabel(id)
})
const statusText = computed(() => {
  if (offline.value) return text('player.offlineUnavailable')
  const failed = props.store.attempts.value
    // Top-level summary only: composite LX sub-source attempts carry sourceId/sourceName
    // and are surfaced exclusively by the diagnostics panel.
    .filter(({ ok, code, providerId, sourceId, sourceName }) =>
      !sourceId && !sourceName && !ok && code !== 'not_mapped' && providerId !== 'r2')
    .map(({ providerId, code }) => `${formatProviderLabel(providerId)} ${failureText(code)}`)
  const statusKeys: Partial<Record<typeof props.store.status.value, TranslationKey>> = {
    ready: 'player.statusReady',
    playing: 'player.statusPlaying',
    paused: 'player.statusPaused',
    buffering: 'player.statusBuffering',
    ended: 'player.statusEnded',
  }
  const active = props.store.status.value === 'resolving'
    ? text('player.statusResolving')
    : props.store.status.value === 'error'
      ? text('player.statusNoSource')
      : text(statusKeys[props.store.status.value] ?? 'player.statusChoose')
  return [...failed, active].join(' · ')
})
const sourceIds = computed(() => {
  const ids = props.store.manualProviderIds
    ? [...props.store.manualProviderIds.value]
    : (props.store.currentTrack.value?.sources
        .map(({ provider }) => provider)
        .filter((provider) => new Set(props.store.enabledProviderIds.value).has(provider)) ?? [])
  // Retain an active override in selectable IDs so the dropdown preserves and displays
  // the user's manual choice even when the provider is in an error or unavailable state.
  const currentOverride = props.store.sourceOverride.value
  if (currentOverride && !ids.includes(currentOverride)) {
    ids.push(currentOverride)
  }
  return ids
})
const playbackQualityText = computed(() => {
  if (!props.store.currentTrack.value) return ''
  return formatPlaybackQuality(props.store.playable.value, text) || text('player.qualityStandard')
})
const releaseProviderText = playbackQualityText

const artworkIdentity = computed(() => JSON.stringify([props.store.currentTrack.value?.id, props.store.playbackGeneration.value]))
const canonicalArtworkUrl = computed(() => {
  const providerId = props.store.activeProviderId.value
  const track = props.store.currentTrack.value
  if ((providerId !== 'lx' && providerId !== 'gd-studio') || props.store.playable.value?.kind !== 'audio' ||
      !props.store.enabledProviderIds.value.includes(providerId) || !track) return undefined
  let id: string | undefined
  if (providerId === 'gd-studio') {
    // Use the exact binding GD Studio resolved, with the canonical NetEase binding as fallback.
    const gdSource = track.sources.find(source => source.provider === 'gd-studio')
    id = gdSource
      ? /^netease:([0-9]{1,20})(?::(?:128|192|320|740|999))?$/.exec(gdSource.externalId)?.[1]
      : track.sources.find(source => source.provider === 'chksz' && isChkszExternalId(source.externalId))?.externalId
  } else {
    id = deriveLxCandidates(track).find(candidate => candidate.source === 'wy' && isChkszExternalId(candidate.id))?.id
  }
  return id ? '/api/providers/' + providerId + '/artwork/' + encodeURIComponent(id) : undefined
})
const primaryArtworkUrl = computed(() => props.store.playable.value?.metadata?.artworkUrl ?? canonicalArtworkUrl.value)
const artworkPhase = ref<'primary' | 'resolving' | 'jellyfin' | 'failed'>('primary')
const jellyfinArtworkUrl = ref<string>()
const artworkUrl = computed(() => artworkPhase.value === 'jellyfin' ? jellyfinArtworkUrl.value : primaryArtworkUrl.value)
let artworkAttempt = 0
let artworkAbort: AbortController | undefined
let lastJellyfinAttemptKey: string | undefined

function canUseJellyfinArtwork(): boolean {
  return props.store.activeProviderId.value === 'chksz' &&
    props.store.playable.value?.kind === 'audio' &&
    props.store.enabledProviderIds.value.includes('jellyfin') &&
    Boolean(props.store.currentTrack.value?.sources.some(source => source.provider === 'jellyfin'))
}

async function tryJellyfinArtwork(): Promise<void> {
  if (artworkPhase.value !== 'primary') return
  if (!canUseJellyfinArtwork()) {
    artworkPhase.value = 'failed'
    return
  }
  const track = props.store.currentTrack.value!
  const generation = props.store.playbackGeneration.value
  const attemptKey = `${track.id}:${generation}`
  if (lastJellyfinAttemptKey === attemptKey) {
    artworkPhase.value = 'failed'
    return
  }
  lastJellyfinAttemptKey = attemptKey
  const attempt = ++artworkAttempt
  artworkAbort = new AbortController()
  artworkPhase.value = 'resolving'
  try {
    // The existing provider resolve path validates the same canonical track's Jellyfin source,
    // checks Worker provider policy, and returns the item or album artwork proxy URL.
    const resolved = await createJellyfinProvider({}).resolve(track, artworkAbort.signal)
    if (attempt !== artworkAttempt || props.store.currentTrack.value?.id !== track.id ||
        props.store.playbackGeneration.value !== generation || !canUseJellyfinArtwork()) return
    const url = resolved?.metadata?.artworkUrl
    if (url) {
      jellyfinArtworkUrl.value = url
      artworkPhase.value = 'jellyfin'
    } else {
      artworkPhase.value = 'failed'
    }
  } catch {
    if (attempt === artworkAttempt) artworkPhase.value = 'failed'
  }
}

watch(
  () => [
    props.store.currentTrack.value?.id,
    props.store.playbackGeneration.value,
    props.store.playable.value?.metadata?.artworkUrl,
    props.store.activeProviderId.value,
  ],
  () => {
    artworkAbort?.abort()
    artworkAttempt++
    jellyfinArtworkUrl.value = undefined
    artworkPhase.value = 'primary'
    if (!primaryArtworkUrl.value && props.store.playable.value?.kind === 'audio' &&
        props.store.activeProviderId.value === 'chksz') void tryJellyfinArtwork()
  },
  { immediate: true },
)
function onArtworkError(event: Event): void {
  // An old image may finish after a track/generation change. It must not erase the new cover.
  const image = event.target as HTMLImageElement | null
  if (image?.dataset.artworkIdentity !== artworkIdentity.value) return
  if (artworkUrl.value && image.src !== new URL(artworkUrl.value, window.location.origin).href) return
  if (artworkPhase.value === 'primary') void tryJellyfinArtwork()
  else if (artworkPhase.value === 'jellyfin') artworkPhase.value = 'failed'
}
const hasArtwork = computed(() => Boolean(artworkUrl.value &&
  (artworkPhase.value === 'primary' || artworkPhase.value === 'jellyfin')))
onBeforeUnmount(() => artworkAbort?.abort())
const artworkAlt = computed(() => {
  const title = currentTrackLabel.value
  return text('player.artworkAlt', { title })
})
watchEffect(() => publishPlaybackPresentation(props.store, {
  currentTime: currentTime.value, duration: duration.value, canSeek: canSeek.value,
  artworkUrl: hasArtwork.value ? artworkUrl.value : undefined,
}), { flush: 'sync' })

function failureText(code?: string): string {
  const keys: Record<string, TranslationKey> = {
    invalid_response: 'player.statusInvalid', not_mapped: 'player.statusNotMapped',
    rate_limited: 'player.statusRateLimited', timeout: 'player.statusTimeout', unavailable: 'player.statusUnavailable',
    credential_required: 'player.statusCredentialRequired', invalid_credential: 'player.statusInvalidCredential',
    csp_blocked: 'player.statusCspBlocked',
  }
  return text(keys[code ?? 'unavailable'] ?? 'player.statusUnavailable')
}

async function play(
  generation = props.store.playbackGeneration.value,
  providerId = props.store.activeProviderId.value,
  userInitiated = true,
  /**
   * Task 41 automatic resume: the listener did not ask, so the store's Play (which answers the
   * notice) and the stall fallback are left out; the notice stays until real progress clears it.
   */
  automatic = false,
): Promise<boolean> {
  // Resolves `true` only when the media element's own `play()` resolved (task 41.6: an automatic
  // resume counts as accepted only then); every other path, rejections included, resolves `false`.
  if (generation !== props.store.playbackGeneration.value) return false
  if (userInitiated) {
    nativeInterruptionGeneration = undefined
    lastPauseOrigin = undefined
    // A new listener command may adopt the still-pending same-source result. Cancellation
    // belongs to the previous command; automatic play requests never restore its authority.
    if (activeMediaRecovery?.generation === generation && activeMediaRecovery.providerId === providerId &&
      !activeMediaRecovery.startedDuringHandover && !activeMediaRecovery.retired) {
      activeMediaRecovery.cancelled = false
      activeMediaRecovery.commandRevision = playbackCommandRevision
      activeMediaRecovery.operationRevision = mediaOperationRevision
      const element = audio.value
      const source = element && networkErrorSources.get(element)
      if (source?.generation === generation) source.commandRevision = playbackCommandRevision
    }
  }
  else if (nativeInterruptionGeneration === generation) return false
  playerPauseRequested = false
  clearPlaybackStall()
  if (props.mediaSuspended && props.store.playable.value?.kind === 'youtube') {
    resumeAfterSuspension = true
    applyYouTubeSuspension(generation)
    return false
  }
  if (props.store.status.value === 'error' && props.store.pendingResumePosition.value !== undefined) {
    await props.store.play()
    return false
  }
  if (!automatic) props.store.play()
  if (userInitiated && prerollRewindIndex.value === activeDeckIndex.value && !completePrerollRewind(activeDeckIndex.value) && !handover) {
    beginHandover(generation, props.store.currentTrack.value?.id ?? '', -1)
  }
  if (props.store.pendingResumePosition.value !== undefined) {
    if (resumeSeekTimer === undefined) resumeSeekTimer = window.setTimeout(() => {
      resumeSeekTimer = undefined
      if (generation === props.store.playbackGeneration.value &&
        props.store.playbackIntent.value === 'playing' && props.store.pendingResumePosition.value !== undefined) {
        void reportFailure(providerId, generation)
        audio.value?.pause()
      }
    }, 10_000)
    if (audio.value) updateMediaPresentation(audio.value)
    return false
  }
  youtube.value?.play()
  const element = audio.value
  const loadedSrc = element?.getAttribute('src')
  const operationRevision = mediaOperationRevision
  recordPlayback('play.call', {
    ...describeMediaElement(element), gen: generation, userInitiated, providerId: providerId ?? null,
    handover: handoverActive(handover, generation), everPlayed: elementEverPlayed(element), automatic, ...pageLogState(),
  })
  // Recorded before the await: the promise stays pending while the element buffers (task 41.6).
  const request: PlayRequest | undefined = element && loadedSrc ? { src: loadedSrc, generation, state: 'pending' } : undefined
  if (element && request) playRequests.set(element, request)
  try {
    if (!automatic) schedulePlaybackStall(INITIAL_PLAY_FALLBACK_MS)
    await element?.play()
    if (request) request.state = 'resolved'
    recordPlayback('play.resolved', { gen: generation, deck: element?.dataset.audioDeck ?? null, paused: element?.paused ?? null })
    return Boolean(element)
  } catch (error) {
    // Only this request is withdrawn; a newer `play()` on the element keeps its own.
    if (element && request && playRequests.get(element) === request) playRequests.delete(element)
    recordPlayback('play.rejected', {
      gen: generation, deck: element?.dataset.audioDeck ?? null, everPlayed: elementEverPlayed(element),
      name: error instanceof DOMException || error instanceof Error ? error.name : typeof error,
      message: error instanceof Error || error instanceof DOMException ? error.message : null, ...pageLogState(),
    })
    // A failed resource can both emit error and reject play(). Its existing recovery owns
    // the generation until renewal/fallback settles; reporting it twice would abort renewal.
    if (generation !== props.store.playbackGeneration.value || operationRevision !== mediaOperationRevision ||
      props.store.playbackIntent.value !== 'playing' || playerUnmounted || audio.value !== element ||
      element?.getAttribute('src') !== loadedSrc) return false
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      // Browser autoplay policy: the track is resolved and ready but the
      // browser requires a user gesture before playback can begin.  Do NOT
      // report this as a provider failure — keep the playable loaded and
      // show the play button so a subsequent user click succeeds.
      if (generation === props.store.playbackGeneration.value) {
        clearPlaybackStall()
        // After a handover the ladder runs at once (P96-06).
        if (handoverActive(handover, generation)) {
          refuseHandoverStart(handover, 'NotAllowedError')
          return false
        }
        props.store.reportMediaState('paused', generation)
        // A refused automatic resume keeps the notice it answers (or the listener's dismissal).
        if (automatic) return false
        // D29: say so, and let one tap start playback.
        if (props.store.playbackIntent.value === 'playing') {
          recordPlayback('notice.tapToResume.raise', { site: 'playRejected', gen: generation })
          props.store.addPlaybackNotice('tapToResume')
          armAutoResume(generation, 'playRejected')
        }
      }
      return false
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      // A load replaced by a newer one is ignored. After a handover, an abort of the unchanged load
      // (same element, `src` and generation) is a missing start (P96-06). An automatic resume's
      // abort outside a handover is a not-started attempt: its caller schedules the next retry.
      if (handoverActive(handover, generation) && element && audio.value === element &&
        element.getAttribute('src') === loadedSrc) refuseHandoverStart(handover, 'AbortError')
      return false
    }
    // Resource refusal and a later error event share one bounded renewal, even while the
    // promoted deck is awaiting its first progress. Gesture/unchanged-load refusals stay above.
    if (element && audio.value === element && element.getAttribute('src') === loadedSrc) {
      await recoverMediaFailure(providerId, generation)
    }
    return false
  }
}

function pauseMedia(): void {
  finishOverlap('pause')
  stopSampling()
  releaseRecoverySource()
  clearPlaybackStall()
  endHandover()
  cancelAutoResume('pause')
  if (resumeSeekTimer !== undefined) { clearTimeout(resumeSeekTimer); resumeSeekTimer = undefined }
  playerPauseRequested = true
  props.store.pause()
  youtube.value?.pause()
  audio.value?.pause()
}

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value
}

function invalidateInterruptionOwnership(clearDeferredResume = true, preservePreroll = false): void {
  cancelManualSelection()
  if (!preservePreroll) cancelPreroll()
  playbackCommandRevision += 1
  mediaOperationRevision += 1
  cancelTimerPauseLease()
  if (clearDeferredResume) resumeAfterSuspension = false
}

function timerPauseLeaseIsValid(lease: TimerPauseLeaseState): boolean {
  return (
    !lease.settled &&
    activeTimerPauseLease === lease &&
    activeTimerPauseLease.owner === lease.owner &&
    lease.revision === playbackCommandRevision &&
    lease.generation === props.store.playbackGeneration.value
  )
}

function cancelTimerPauseLease(lease = activeTimerPauseLease): void {
  if (!lease || lease.settled) return
  lease.settled = true
  if (activeTimerPauseLease === lease) activeTimerPauseLease = undefined
}

function resumeTimerPauseLeaseWhenReady(lease = activeTimerPauseLease): boolean {
  if (!lease?.resumeRequested) return false
  if (!timerPauseLeaseIsValid(lease)) {
    cancelTimerPauseLease(lease)
    return false
  }
  if (props.mediaSuspended || !props.store.playable.value) return true
  lease.settled = true
  activeTimerPauseLease = undefined
  void play(lease.generation, props.store.activeProviderId.value)
  return true
}

function pause(): void {
  invalidateInterruptionOwnership()
  clearPlaybackStall()
  pauseMedia()
}

function applyYouTubeSuspension(generation = props.store.playbackGeneration.value): void {
  if (youtubeSuspensionApplied || props.store.playable.value?.kind !== 'youtube') return
  resumeAfterSuspension ||= props.store.playbackIntent.value === 'playing'
  youtubeSuspensionApplied = true
  pauseMedia()
  props.store.reportMediaState('paused', generation)
}

function stop(): void {
  invalidateInterruptionOwnership()
  clearPlaybackStall()
  pauseMedia()
  props.store.stop()
}

defineExpose({ pause, stop })

function toggle(): void {
  if (transportPlaying.value || transportStarting.value) pause()
  else resumeFromListener()
}

/** The user-initiated play, also behind the tap-to-resume notice (D29). */
function resumeFromListener(): void {
  invalidateInterruptionOwnership(false)
  void play()
}

function next(): void {
  const index = manualTargetIndex(1)
  if (props.store.transitionMode.value !== 'off' && !props.store.queue.value[index]) return
  recordPlayback('advance.user', { direction: 'next', index: props.store.currentIndex.value })
  invalidateInterruptionOwnership()
  clearPlaybackStall()
  if (props.store.transitionMode.value === 'off') void props.store.next()
  else void transitionByUser(index)
}

function previous(): void {
  const index = manualTargetIndex(-1)
  if (props.store.transitionMode.value !== 'off' && !props.store.queue.value[index]) return
  recordPlayback('advance.user', { direction: 'previous', index: props.store.currentIndex.value })
  invalidateInterruptionOwnership()
  clearPlaybackStall()
  if (props.store.transitionMode.value === 'off') void props.store.previous()
  else void transitionByUser(index)
}

let playerUnmounted = false
let manualTransitionRevision = 0
let manualPreparation: number | undefined
let pendingManualTarget: { index: number; track: PlaybackStore['queue']['value'][number]; generation: number; revision: number } | undefined
function cancelManualSelection(): void {
  manualTransitionRevision += 1
  pendingManualTarget = undefined
  manualPreparation = undefined
}
function manualTargetIndex(direction: 1 | -1): number {
  const pending = pendingManualTarget
  const base = pending && pending.revision === manualTransitionRevision &&
    pending.generation === props.store.playbackGeneration.value && props.store.queue.value[pending.index] === pending.track
    ? pending.index : props.store.currentIndex.value
  return base + direction
}
async function transitionByUser(index: number): Promise<void> {
  const revision = ++manualTransitionRevision
  finishOverlap('manual-switch')
  const target = props.store.queue.value[index]
  if (!target || index === props.store.currentIndex.value) return
  const generation = props.store.playbackGeneration.value
  const current = () => !playerUnmounted && revision === manualTransitionRevision && generation === props.store.playbackGeneration.value &&
    target === props.store.queue.value[index]
  manualPreparation = revision
  pendingManualTarget = { index, track: target, generation, revision }
  try {
    if (props.store.sourceOverride.value === undefined && props.store.transitionMode.value !== 'off' &&
        props.store.playbackIntent.value === 'playing') {
      await props.store.prepareTransition(index)
      await nextTick()
      if (!current()) return
      const prepared = props.store.preparedNext.value
      const standby = deckElement(standbyDeckIndex())
      if (prepared?.track === target && standby && !pageIsHidden()) {
        await waitForBuffer(standby, 2, current)
      }
      if (!current()) return
      if (await tryCrossfade(index, true)) return
    }
    if (current()) await props.store.playQueueIndex(index)
  } finally {
    if (manualPreparation === revision) manualPreparation = undefined
    if (pendingManualTarget?.revision === revision) pendingManualTarget = undefined
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return
  if (event.code === 'Space') { event.preventDefault(); toggle() }
  else if (event.code === 'ArrowRight') { event.preventDefault(); next() }
  else if (event.code === 'ArrowLeft') { event.preventDefault(); previous() }
}

function onSourceChange(event: Event): void {
  finishOverlap('provider-change')
  invalidateInterruptionOwnership()
  clearPlaybackStall()
  void props.store.setSourceOverride((event.target as HTMLSelectElement).value || undefined)
}

function pauseForInterruption(): PlaybackPauseLease | undefined {
  // D20: after a native pause the intent still reads `playing`, but the playback is not ours to resume.
  if (lastPauseOrigin?.origin === 'native' && lastPauseOrigin.generation === props.store.playbackGeneration.value) {
    return undefined
  }
  const ownsPlayingIntent = resumeAfterSuspension || props.store.playbackIntent.value === 'playing'
  if (!ownsPlayingIntent) return undefined

  const lease: TimerPauseLeaseState = {
    generation: props.store.playbackGeneration.value,
    owner: Symbol('playback-interruption'),
    resumeRequested: false,
    revision: playbackCommandRevision,
    settled: false,
  }
  activeTimerPauseLease = lease
  resumeAfterSuspension = false
  if (props.store.playbackIntent.value === 'playing') pauseMedia()

  return {
    cancel() {
      cancelTimerPauseLease(lease)
    },
    isSettled() {
      return lease.settled
    },
    resumeIfStillOwned() {
      if (lease.settled) return
      lease.resumeRequested = true
      resumeTimerPauseLeaseWhenReady(lease)
    },
  }
}

function onVolume(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  if (Number.isFinite(value)) props.store.setVolume(Math.min(1, Math.max(0, value)))
}

function toggleMute(): void {
  const volume = props.store.volume.value
  if (volume > 0) lastAudibleVolume.value = volume
  props.store.setVolume(volume > 0 ? 0 : lastAudibleVolume.value)
}

function formatTime(value: number): string {
  return formatPlaybackTime(value)
}


interface DeckOverlap {
  from: number; to: number; outgoing: HTMLAudioElement; incoming: HTMLAudioElement
  preparationId: number; generation: number; promoted: boolean; committing: boolean
  seconds: number; progress: number; startedAt: number
}
const overlap = shallowRef<DeckOverlap | null>(null)
let fadeTimer: ReturnType<typeof setInterval> | undefined
let transitionAttempt: number | undefined
let stopEnergySampling: (() => void) | undefined
let samplingElement: HTMLAudioElement | undefined
let energySamples: EnergySample[] = []
const preparationObservations = new Map<number, string>()
let startLatency: { generation: number; startedAt: number } | undefined

const pageIsHidden = () => document.visibilityState === 'hidden'
function overlapDeckAllowed(index: number): boolean {
  const state = overlap.value
  return Boolean(state && (index === state.from || index === state.to) &&
    deckElement(state.from) === state.outgoing && deckElement(state.to) === state.incoming)
}
function applyOverlapVolume(): void {
  const state = overlap.value
  if (!state) return
  const [outgoing, incoming] = fadeGains(state.progress, props.store.volume.value)
  state.outgoing.volume = outgoing
  state.incoming.volume = incoming
}
function finishOverlap(reason: string): void {
  const state = overlap.value
  if (!state) return
  overlap.value = null
  if (fadeTimer !== undefined) clearInterval(fadeTimer)
  fadeTimer = undefined
  const discarded = state.promoted ? state.from : state.to
  // Withdraw authorisation before pausing so queued events cannot restart a discarded deck.
  const element = state.promoted ? state.outgoing : state.incoming
  element.pause()
  element.muted = true
  if (state.promoted) clearDeck(discarded)
  else { try { element.currentTime = 0 } catch { /* An interrupted load may not be seekable. */ } }
  const active = deckElement(activeDeckIndex.value)
  if (active) { active.muted = false; active.volume = props.store.volume.value }
  recordPlayback('transition.end', { reason, promoted: state.promoted, progress: state.progress })
  if (!playerUnmounted) void nextTick(() => syncPreparedDeck())
}
function stopSampling(): void {
  stopEnergySampling?.()
  stopEnergySampling = undefined
  samplingElement = undefined
  energySamples = []
}
function observeEnergy(element: HTMLAudioElement): void {
  const eligible = props.store.transitionMode.value === 'smart' && !element.paused &&
    document.visibilityState !== 'hidden' && duration.value > 0 &&
    duration.value - currentTime.value <= Math.max(24, props.store.crossfadeDuration.value * 2)
  if (!eligible) { if (samplingElement) stopSampling(); return }
  if (samplingElement === element) return
  stopSampling()
  samplingElement = element
  stopEnergySampling = startPassiveEnergySampling(element, sample => {
    if (samplingElement !== element) return
    energySamples.push(sample)
    if (energySamples.length > 12) energySamples.shift()
  }, state => {
    if (state === 'unavailable' || state === 'suspended') energySamples = []
    recordPlayback('transition.analysis', {state, gen: props.store.playbackGeneration.value})
  })
}
function plannedTransition(manual = false) {
  if (manual) return { durationSeconds: transitionDuration(props.store.crossfadeDuration.value, true), reason: 'manual', analysed: false }
  return props.store.transitionMode.value === 'smart'
    ? planSmartMix(props.store.crossfadeDuration.value, duration.value, energySamples)
    : { durationSeconds: transitionDuration(props.store.crossfadeDuration.value), reason: 'configured', analysed: false }
}
async function tryCrossfade(targetIndex: number, manual = false): Promise<boolean> {
  // Apple mobile WebKit also rejects the zero-volume start used by an overlap.
  if (playerUnmounted || overlap.value || preroll || recoveryRetainedIndex.value !== undefined || isAppleMobileWebKit() ||
      props.store.transitionMode.value === 'off' || props.store.preloadPolicy.value !== 'auto' ||
      props.store.playbackIntent.value !== 'playing' || props.mediaSuspended || document.visibilityState === 'hidden') return false
  const prepared = props.store.preparedNext.value
  const outgoing = audio.value
  const to = standbyDeckIndex(), incoming = deckElement(to)
  const plan = plannedTransition(manual)
  const remaining = outgoing ? outgoing.duration - outgoing.currentTime : 0
  if (!manual && (!Number.isFinite(remaining) || remaining < .25)) return false
  if (!prepared || !outgoing || outgoing.paused || outgoing.ended || outgoing.seeking || !incoming ||
      prepared.track !== props.store.queue.value[targetIndex] || audioDecks.value[to].preparationId !== prepared.id ||
      !props.store.canHandoffPreparation(prepared.id) || transitionAttempt === prepared.id) return false
  const incomingRemaining = incoming.duration - incoming.currentTime
  // A short incoming track shortens the automatic lead as well as the envelope. Otherwise a
  // one-second overlap could start twelve seconds early and discard the outgoing outro.
  if (!manual && remaining > Math.min(plan.durationSeconds, incomingRemaining / 2) + .1) return false
  const seconds = boundedOverlapDuration(plan.durationSeconds, remaining, incomingRemaining)
  if (seconds === 0 || !inspectBuffer(incoming, Math.max(2, seconds + .5)).ready ||
      !supportsNativeVolumeControl(incoming)) return false
  transitionAttempt = prepared.id
  const state: DeckOverlap = { from: activeDeckIndex.value, to, outgoing, incoming,
    preparationId: prepared.id, generation: props.store.playbackGeneration.value, promoted: false,
    committing: false, seconds, progress: 0, startedAt: performance.now() }
  overlap.value = state
  incoming.volume = 0
  incoming.muted = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    // An accepted play is required before touching the outgoing track/store. A bounded timeout
    // leaves the ordinary handoff available when mobile autoplay or the radio refuses overlap.
    const started = incoming.play().then(() => {
      // play() can settle after a timeout, cancellation, or removal of the native listeners.
      // Stop only an abandoned deck; a newer transition may already own this same element.
      const authorised = !playerUnmounted && (overlapDeckAllowed(to) ||
        (audio.value === incoming && props.store.playbackIntent.value === 'playing' &&
          nativeInterruptionGeneration !== props.store.playbackGeneration.value))
      if (!authorised) { incoming.pause(); incoming.muted = true }
    })
    await Promise.race([started, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('transition-start-timeout')), 1500)
    })])
    if (overlap.value !== state || state.generation !== props.store.playbackGeneration.value ||
        props.store.playbackIntent.value !== 'playing' || pageIsHidden() ||
        !props.store.canHandoffPreparation(prepared.id) || prepared.track !== props.store.queue.value[targetIndex]) {
      if (overlap.value === state) finishOverlap('cancelled-before-start')
      return false
    }
    state.seconds = boundedOverlapDuration(state.seconds, outgoing.duration - outgoing.currentTime,
      incoming.duration - incoming.currentTime)
    if (state.seconds === 0) { finishOverlap('too-late'); return false }
    state.committing = true
    await props.store.playQueueIndex(targetIndex, () => overlap.value === state &&
      state.generation === props.store.playbackGeneration.value &&
      props.store.playbackIntent.value === 'playing' && !pageIsHidden() &&
      props.store.transitionMode.value !== 'off' && props.store.preloadPolicy.value === 'auto')
    if (overlap.value !== state || activeDeckIndex.value !== to || props.store.playable.value !== prepared.playable) {
      if (overlap.value === state) finishOverlap('handoff-rejected')
      return false
    }
    state.promoted = true
    state.committing = false
    state.generation = props.store.playbackGeneration.value
    state.startedAt = performance.now()
    recordPlayback('transition.start', { mode: props.store.transitionMode.value, seconds: state.seconds,
      reason: plan.reason, analysed: plan.analysed, manual, preparationId: prepared.id })
    fadeTimer = setInterval(() => {
      if (overlap.value !== state) return
      if (props.store.playbackIntent.value !== 'playing' || state.generation !== props.store.playbackGeneration.value) {
        finishOverlap('interrupted'); return
      }
      state.progress = Math.min(1, (performance.now() - state.startedAt) / (state.seconds * 1000))
      applyOverlapVolume()
      if (state.progress >= 1) finishOverlap('complete')
    }, 50)
    return true
  } catch {
    if (overlap.value === state) finishOverlap('play-refused')
    recordPlayback('transition.unavailable', { preparationId: prepared.id, manual })
    return false
  } finally { if (timeout !== undefined) clearTimeout(timeout) }
}
function observePreparation(index: number): void {
  const deck = audioDecks.value[index]
  if (deck.preparationId === undefined) return
  const result = inspectBuffer(deckElement(index), Math.max(2, props.store.crossfadeDuration.value + .5))
  const phase = result.ready ? 'ready' : result.totalBufferedSeconds > 0 ? 'buffering' : 'fetching'
  const observation = phase + ':' + Math.floor(result.bufferedSeconds)
  if (preparationObservations.get(deck.preparationId) === observation) return
  preparationObservations.set(deck.preparationId, observation)
  if (preparationObservations.size > 4) preparationObservations.delete(preparationObservations.keys().next().value!)
  recordPlayback('preparation.buffer', { preparationId: deck.preparationId, phase,
    bufferedSeconds: result.bufferedSeconds, totalBufferedSeconds: result.totalBufferedSeconds, ready: result.ready })
}
function onTransitionVisibility(): void {
  if (document.visibilityState !== 'hidden') return
  cancelManualSelection()
  finishOverlap('background')
  stopSampling()
}

function assignDeck(index: number, deck: AudioDeck, preserveElement = false): void {
  if (preroll?.index === index && (deck.preparationId !== preroll.preparationId || deck.src !== audioDecks.value[index].src)) cancelPreroll()
  if (prerollRewindIndex.value === index && (deck.src !== audioDecks.value[index].src || deck.generation !== audioDecks.value[index].generation)) prerollRewindIndex.value = undefined
  const outgoing = audioDecks.value[index]
  if (!preserveElement && outgoing.src && (outgoing.src !== deck.src || outgoing.trackId !== deck.trackId)) {
    const element = deckElement(index)
    if (element) {
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  }
  audioDecks.value[index] = deck
  audioDecks.value = [...audioDecks.value] as [AudioDeck, AudioDeck]
  // Synchronous rapid switching can clear and reuse this index before Vue
  // patches the DOM. Its prior vnode may still contain the same URL, so Vue
  // would not restore the attribute removed above. Restore only when absent
  // or different; an eligible preloaded deck keeps its native source intact.
  const element = deckElement(index)
  if (deck.src && element && element.getAttribute('src') !== deck.src) element.setAttribute('src', deck.src)
}

function clearDeck(index: number): void {
  const element = deckElement(index)
  if (element) { networkErrorSources.delete(element); expectedPrerollPauses.delete(element) }
  assignDeck(index, emptyDeck())
}

function standbyDeckIndex(): number {
  return activeDeckIndex.value === 0 ? 1 : 0
}

/** Unmount the deck's source but keep its element for ladder step (a) (P96-06). */
function retainDeck(index: number): void {
  assignDeck(index, { ...emptyDeck(), retained: true })
}

function releaseRecoverySource(restorePreparation = false): void {
  const index = recoveryRetainedIndex.value
  recoveryRetainedIndex.value = undefined
  if (recoveryRetainTimer !== undefined) clearTimeout(recoveryRetainTimer)
  recoveryRetainTimer = undefined
  if (index !== undefined) clearDeck(index)
  // The outgoing element may have ended before the incoming one started. Its slot is still
  // available for an armed preparation even when the retained index was already released.
  if (restorePreparation) syncPreparedDeck()
}

function isNetworkErrorSource(index: number, element: HTMLAudioElement): boolean {
  const source = networkErrorSources.get(element)
  return source !== undefined && source.generation === audioDecks.value[index].generation &&
    source.commandRevision === playbackCommandRevision && element.error?.code === 2 &&
    !playerPauseRequested && props.store.playbackIntent.value === 'playing'
}

function retainRecoverySource(index: number): boolean {
  if (recoveryRetainedIndex.value !== undefined) return recoveryRetainedIndex.value === index
  const deck = audioDecks.value[index]
  const element = deckElement(index)
  if (!deck.src || deck.trackId !== props.store.currentTrack.value?.id || !element ||
    (element.paused && !isNetworkErrorSource(index, element)) || element.ended || nativeInterruptionGeneration === props.store.playbackGeneration.value ||
    props.store.pendingResumePosition.value === undefined || props.store.playbackIntent.value !== 'playing') return false
  recoveryRetainedIndex.value = index
  // Share the existing bounded loading window; a stalled replacement cannot retain a source forever.
  recoveryRetainTimer = setTimeout(() => releaseRecoverySource(true), HANDOVER_LOADING_LIMIT_MS)
  return true
}

function cancelPreroll(): void {
  const previous = preroll
  preroll = undefined
  prerollDeckIndex.value = undefined
  if (prerollTimer !== undefined) clearTimeout(prerollTimer)
  prerollTimer = undefined
  if (previous) {
    const src = previous.element.getAttribute('src')
    if (!previous.element.paused && src) expectedPrerollPauses.set(previous.element, { generation: previous.generation, src })
    previous.element.pause()
    try { previous.element.currentTime = 0 } catch { /* A failed source is released by its owner. */ }
  }
}

/** Native completion may arrive without seeked after a page lifecycle pause. */
function completePrerollRewind(index: number, seeked = false): boolean {
  if (prerollRewindIndex.value !== index) return true
  const element = deckElement(index)
  if (!element || element.seeking || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || (!seeked && element.currentTime > 0.25)) return false
  prerollRewindIndex.value = undefined
  syncVolume(props.store.volume.value)
  return true
}

function isAppleMobileWebKit(): boolean {
  if (typeof navigator === 'undefined') return false
  const userAgent = navigator.userAgent
  if (!/AppleWebKit\//u.test(userAgent)) return false
  return /iPad|iPhone|iPod/u.test(userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function maybePreroll(): void {
  // iPadOS/iOS WebKit can report a completed, buffered standby element as ended
  // immediately after a volume-zero play request. Keep the URL preloaded, but leave
  // the standby element paused and let the native ended handoff promote it.
  if (isAppleMobileWebKit()) return
  if (document.visibilityState !== 'visible') return
  // Crossfade and preroll cannot own or rewind the same standby element.
  if (playerUnmounted || overlap.value || preroll || recoveryRetainedIndex.value !== undefined || handover || props.store.repeatMode.value === 'one' ||
    props.store.playbackIntent.value !== 'playing' || props.store.status.value !== 'playing' ||
    nativeInterruptionGeneration === props.store.playbackGeneration.value) return
  const current = audio.value
  const prepared = props.store.preparedNext.value
  if (!current || current.paused || current.ended || current.seeking || !Number.isFinite(current.duration) ||
    current.duration - current.currentTime <= 0 || current.duration - current.currentTime > PREROLL_LEAD_SECONDS ||
    !prepared?.armed || !isPreparationFresh(prepared) || rejectedPrerollId === prepared.id) return
  const index = standbyDeckIndex()
  const deck = audioDecks.value[index]
  const element = deckElement(index)
  if (!element || deck.preparationId !== prepared.id || deck.src !== prepared.playable.url ||
    element.error || element.seeking || element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ||
    !Number.isFinite(element.duration) || element.duration <= PREROLL_LEAD_SECONDS ||
    element.buffered.length === 0 || element.buffered.start(0) > 0.05 ||
    element.buffered.end(0) < Math.min(element.duration, 3)) return
  const candidate = { index, element, preparationId: prepared.id, generation: props.store.playbackGeneration.value }
  preroll = candidate
  prerollDeckIndex.value = index
  prerollTimer = setTimeout(() => {
    if (preroll !== candidate) return
    rejectedPrerollId = candidate.preparationId
    cancelPreroll()
  }, 3_000)
  // Chromium may suspend a never-unmuted element in a hidden page. Keep this finite
  // pre-roll inaudible through its volume, then restore volume only after rewind.
  element.volume = 0
  element.muted = false
  try {
    if (element.currentTime > 0) element.currentTime = 0
    recordPlayback('handover.preroll', { gen: candidate.generation, preparationId: prepared.id, deck: index })
    void element.play().then(() => {
      // A late fulfilled play must not restart a cancelled or replaced standby.
      if (preroll !== candidate && audio.value !== element) element.pause()
    }).catch(() => {
      if (preroll !== candidate) return
      rejectedPrerollId = candidate.preparationId
      cancelPreroll()
    })
  } catch {
    rejectedPrerollId = candidate.preparationId
    cancelPreroll()
  }
}

function syncPreparedDeck(): void {
  if (playerUnmounted || overlap.value || recoveryRetainedIndex.value !== undefined) return
  const prepared = props.store.preparedNext.value
  const standbyIndex = standbyDeckIndex()
  // Only a lead-window arm or an explicit transition resolves the standby URL.
  // Assign it while the preparation's transient ticket is still fresh.
  if (prepared?.armed && isPreparationFresh(prepared)) {
    assignDeck(standbyIndex, {
      generation: prepared.generation,
      mimeType: prepared.playable.mimeType,
      preload: props.store.preloadPolicy.value === 'auto' ? 'auto' : 'metadata',
      preparationId: prepared.id,
      src: prepared.playable.url,
      trackId: prepared.track.id,
    })
    return
  }
  // A retained previous element belongs to the handover check, which releases it.
  if (audioDecks.value[standbyIndex].retained) return
  if (props.store.preloadPolicy.value === 'none') {
    clearDeck(standbyIndex)
    return
  }
  void nextTick(() => {
    if (playerUnmounted || overlap.value || recoveryRetainedIndex.value !== undefined) return
    const latest = props.store.preparedNext.value
    // A *stale* preparation must not hold the standby deck open: its URL is no longer usable, so
    // treat it the same as no preparation at all.
    if ((latest?.armed && isPreparationFresh(latest)) || props.store.preloadHandoff.value) return
    const standby = audioDecks.value[standbyDeckIndex()]
    if (standby.retained) return
    if (props.store.currentTrack.value?.id === standby.trackId && props.store.status.value === 'resolving') return
    clearDeck(standbyDeckIndex())
  })
}

function syncActiveDeck(): void {
  clearPlaybackStall()
  if (resumeSeekTimer !== undefined) { clearTimeout(resumeSeekTimer); resumeSeekTimer = undefined }
  const playable = props.store.playable.value
  const generation = props.store.playbackGeneration.value
  const trackId = props.store.currentTrack.value?.id ?? ''
  const handoff = props.store.preloadHandoff.value
  const mixing = overlap.value
  if (mixing && !mixing.committing && mixing.generation !== generation) finishOverlap('generation-changed')
  if (mixing?.committing && playable?.kind !== 'audio' && handoff?.id === mixing.preparationId) return
  const held = recoveryRetainedIndex.value
  if (held !== undefined && (audioDecks.value[held].trackId !== trackId ||
    props.store.playbackIntent.value !== 'playing' || playable?.kind === 'youtube')) releaseRecoverySource()
  // A track change or any other new generation ends the handover check; a ladder re-resolve
  // (step b) carries it to the renewed generation.
  if (handover) {
    if (handover.trackId !== trackId) endHandover()
    else if (handover.generation !== generation) {
      if (handover.step !== 'reResolving') endHandover()
      else if (playable?.kind === 'audio') handover.generation = generation
    }
  }
  if (playable?.kind !== 'audio') {
    // A synchronous background adoption briefly clears store.playable. Keep the
    // existing node/source until the verified next source is published below.
    if (backgroundHandoff) return
    const index = activeDeckIndex.value
    const deck = audioDecks.value[index]
    if (!handoff && retainRecoverySource(index)) return
    // An automatic advance to a preparation keeps the element that played the previous track.
    if (handoff && deck.src && deck.trackId !== handoff.track.id) retainDeck(index)
    else if (!(handoff && deck.retained)) clearDeck(index)
    return
  }
  const immediate = backgroundHandoff
  if (immediate && handoff?.id === immediate.preparationId && generation === immediate.generation &&
    trackId === immediate.trackId && playable.url === handoff.playable.url &&
    deckElement(immediate.index) === immediate.element) {
    activeDeckIndex.value = immediate.index
    prerollRewindIndex.value = undefined
    assignDeck(immediate.index, { generation, mimeType: playable.mimeType, preload: 'auto', src: playable.url, trackId }, true)
    // Native events can fire before Vue's next render. Stamp this same element now.
    immediate.element.dataset.playbackGeneration = String(generation)
    immediate.element.dataset.trackId = trackId
    immediate.element.dataset.audioRole = 'active'
    immediate.element.muted = false
    syncVolume(props.store.volume.value)
    props.store.releasePreloadHandoff(generation)
    clearDeck(1 - immediate.index)
    recordPlayback('handover.sameElement', { gen: generation, trackId, deck: immediate.index })
    beginHandover(generation, trackId, -1)
    return
  }
  const promotedIndex = handoff && handoff.generation === generation && handoff.track.id === trackId &&
    handoff.playable.url === playable.url
    ? audioDecks.value.findIndex((deck) =>
      deck.preparationId === handoff.id && deck.trackId === trackId && deck.src === playable.url)
    : -1
  if (promotedIndex >= 0) {
    const previousActive = activeDeckIndex.value
    const warmed = preroll?.index === promotedIndex && preroll.preparationId === handoff?.id ? preroll : undefined
    preroll = undefined
    prerollDeckIndex.value = undefined
    if (prerollTimer !== undefined) clearTimeout(prerollTimer)
    prerollTimer = undefined
    activeDeckIndex.value = promotedIndex
    assignDeck(promotedIndex, {
      ...audioDecks.value[promotedIndex], generation, preload: 'metadata', preparationId: undefined,
    })
    if (warmed && warmed.element.currentTime > 0) {
      prerollRewindIndex.value = promotedIndex
      warmed.element.volume = 0
      try { warmed.element.currentTime = 0 } catch { prerollRewindIndex.value = undefined }
    }
    const retained = previousActive !== promotedIndex && Boolean(audioDecks.value[previousActive].retained)
    if (previousActive !== promotedIndex && !retained && !overlapDeckAllowed(previousActive)) clearDeck(previousActive)
    if (overlap.value?.committing && overlap.value.to === promotedIndex) overlap.value.promoted = true
    props.store.releasePreloadHandoff(generation)
    const promotedElement = deckElement(promotedIndex)
    startLatency = { generation, startedAt: performance.now() }
    recordPlayback('preparation.handoff', { preparationId: handoff?.id ?? null, reusedElement: true, ...inspectBuffer(promotedElement) })
    recordPlayback('handover.promote', {
      ...describeMediaElement(promotedElement), gen: generation, trackId, fromDeck: previousActive, toDeck: promotedIndex,
      retained, targetEverPlayed: elementEverPlayed(promotedElement), ...pageLogState(),
    })
    beginHandover(generation, trackId, retained ? previousActive : -1)
    return
  }
  const activeIndex = activeDeckIndex.value
  const currentDeck = audioDecks.value[activeIndex]
  if (
    currentDeck.src === playable.url && currentDeck.trackId === trackId &&
    currentDeck.generation === generation
  ) return
  const coldIndex = recoveryRetainedIndex.value === undefined ? standbyDeckIndex() : 1 - recoveryRetainedIndex.value
  activeDeckIndex.value = coldIndex
  assignDeck(coldIndex, {
    generation, mimeType: playable.mimeType,
    preload: props.store.pendingResumePosition.value === undefined ? 'metadata' : 'auto', src: playable.url, trackId,
  })
  if (activeIndex !== coldIndex && activeIndex !== recoveryRetainedIndex.value) clearDeck(activeIndex)
  startLatency = { generation, startedAt: performance.now() }
  recordPlayback('deck.coldLoad', { gen: generation, trackId, fromDeck: activeIndex, toDeck: coldIndex, hadHandoff: Boolean(handoff) })
}

function activeDeckEvent(index: number, event: Event): boolean {
  const playable = props.store.playable.value
  const deck = audioDecks.value[index]
  return playable?.kind === 'audio' && index === activeDeckIndex.value &&
    deck.generation === props.store.playbackGeneration.value &&
    deck.trackId === props.store.currentTrack.value?.id && deck.src === playable.url &&
    event.currentTarget === deckElement(index)
}

function onDeckPresentation(index: number, event: Event): void {
  observePreparation(index)
  if (!activeDeckEvent(index, event)) {
    if (event.currentTarget === deckElement(index) && ['canplay', 'progress', 'loadedmetadata'].includes(event.type)) maybePreroll()
    return
  }
  if (prerollRewindIndex.value === index && !completePrerollRewind(index, event.type === 'seeked')) return
  if (event.type === 'seeking') { cancelManualSelection(); finishOverlap('seek'); stopSampling(); cancelPreroll(); clearPlaybackStall() }
  if ((event.type === 'seeking' || event.type === 'seeked') && event.currentTarget instanceof HTMLAudioElement) {
    retireMediaRecovery()
    props.store.reportProgress?.(event.currentTarget.currentTime, props.store.playbackGeneration.value, true)
  }
  if (event.type === 'timeupdate' && event.currentTarget instanceof HTMLAudioElement) {
    const generation = props.store.playbackGeneration.value
    const elapsed = event.currentTarget.currentTime
    if (startLatency?.generation === generation && elapsed > 0 && !event.currentTarget.paused) {
      recordPlayback('preparation.playback-start', { gen: generation, latencyMs: performance.now() - startLatency.startedAt })
      startLatency = undefined
    }
    if (!event.currentTarget.seeking) props.store.reportProgress?.(elapsed, generation)
    const sampleAt = performance.now()
    if (sampleAt - lastProgressSampleAt >= PROGRESS_SAMPLE_INTERVAL_MS) {
      lastProgressSampleAt = sampleAt
      recordPlayback('media.progress', { ...describeMediaElement(event.currentTarget), gen: generation })
    }
    // Progress past the start position ends the handover check (P96-06).
    if (handoverActive(handover, generation) && elapsed > handover.startPosition) endHandover()
    // Playing again after an automatic resume (task 41): nothing left to retry.
    if (autoResume?.generation === generation && props.store.status.value === 'playing' && !event.currentTarget.seeking) {
      cancelAutoResume('progress')
    }
  }
  mediaPresentationHandlers.value.update(event, index)
  if (event.type === 'seeked' && ['playing', 'buffering'].includes(props.store.status.value)) schedulePlaybackStall(PLAYBACK_STALL_FALLBACK_MS)
  maybePreroll()
}

function onDeckState(index: number, event: Event, state: PlaybackMediaState): void {
  const element = event.currentTarget
  // A queued pause from the ended source may arrive after this same element has
  // started its replacement. A real native/user pause still has paused=true.
  if (state === 'paused' && backgroundStartedGeneration === props.store.playbackGeneration.value &&
    activeDeckEvent(index, event) && element instanceof HTMLAudioElement && !element.paused) return
  if (state === 'paused' && element instanceof HTMLAudioElement) {
    const expected = expectedPrerollPauses.get(element)
    expectedPrerollPauses.delete(element)
    if (expected && element === deckElement(index) && element.getAttribute('src') === expected.src &&
      audioDecks.value[index].generation >= expected.generation && audioDecks.value[index].generation <= expected.generation + 1) return
  }
  if (preroll?.index === index && preroll.element === element) return
  if (activeDeckEvent(index, event) && state === 'paused' && element instanceof HTMLAudioElement && !element.ended) cancelPreroll()
  if (state === 'paused' && element instanceof HTMLAudioElement && element === deckElement(index) &&
    isNetworkErrorSource(index, element)) {
    const source = networkErrorSources.get(element)!
    if (!source.pauseObserved) {
      source.pauseObserved = true
      // Keep the existing native session until replacement playing. A second pause is an
      // interruption, and explicit player commands invalidate this lease independently.
      props.store.reportMediaState('buffering', props.store.playbackGeneration.value)
      return
    }
  }
  if (state === 'paused' && element instanceof HTMLAudioElement && !element.ended &&
    (activeDeckEvent(index, event) || (index === recoveryRetainedIndex.value && element === deckElement(index)))) {
    // An initial load failure also emits pause before metadata, with no playing source to
    // retain. Keep its existing provider fallback; only a distinct interruption cancels it.
    if (activeMediaRecovery && (!element.error || networkErrorSources.get(element)?.pauseObserved)) {
      activeMediaRecovery.cancelled = true
    }
  }
  if (!activeDeckEvent(index, event)) {
    if (overlapDeckAllowed(index)) {
      if (state === 'paused' && !(event.currentTarget as HTMLAudioElement).ended) pauseMedia()
      else if (state === 'ended' || state === 'buffering') finishOverlap('outgoing-' + state)
      return
    }
    if (index === recoveryRetainedIndex.value && event.currentTarget === deckElement(index)) {
      if (state === 'paused' && event.currentTarget instanceof HTMLAudioElement && !event.currentTarget.ended) {
        const generation = props.store.playbackGeneration.value
        nativeInterruptionGeneration = generation
        lastPauseOrigin = { origin: 'native', generation }
        clearPlaybackStall()
        if (resumeSeekTimer !== undefined) clearTimeout(resumeSeekTimer)
        resumeSeekTimer = undefined
        releaseRecoverySource()
        audio.value?.pause()
        props.store.reportMediaState('paused', generation)
      } else if (state === 'ended') releaseRecoverySource()
      return
    }
    if (state === 'playing' && event.currentTarget instanceof HTMLAudioElement) event.currentTarget.pause()
    return
  }
  if (state === 'playing' && props.store.playbackIntent.value !== 'playing') {
    audio.value?.pause()
    return
  }
  if (state === 'playing') { releaseRecoverySource(true); nativeInterruptionGeneration = undefined; lastPauseOrigin = undefined; playerPauseRequested = false }
  if (state === 'ended') { clearPlaybackStall(); mediaStateHandlers.value.ended() }
  else {
    mediaStateHandlers.value[state]()
    if (state === 'buffering' && props.store.playbackIntent.value === 'playing') {
      schedulePlaybackStall(PLAYBACK_STALL_FALLBACK_MS)
    }
    else if (state === 'playing') { clearPlaybackStall(); schedulePlaybackStall(PLAYBACK_STALL_FALLBACK_MS) }
    else if (state === 'paused') {
      cancelManualSelection()
      finishOverlap('native-pause')
      stopSampling()
      clearPlaybackStall()
      // A native or OS pause is honoured: no ladder step and no notice.
      endHandover()
      if (resumeSeekTimer !== undefined) { clearTimeout(resumeSeekTimer); resumeSeekTimer = undefined }
      if (!audio.value?.ended) {
        nativeInterruptionGeneration = props.store.playbackGeneration.value
        lastPauseOrigin = { origin: playerPauseRequested ? 'player' : 'native', generation: props.store.playbackGeneration.value }
      }
      playerPauseRequested = false
    }
  }
}

function onDeckPlay(index: number, event: Event): void {
  if (preroll?.index === index && preroll.element === event.currentTarget) return
  if (index === recoveryRetainedIndex.value && event.currentTarget === deckElement(index)) return
  if (activeDeckEvent(index, event)) nativePlayCommandHandler.value()
  else if (!overlapDeckAllowed(index) && event.currentTarget instanceof HTMLAudioElement) event.currentTarget.pause()
}

function onDeckError(index: number, event: Event): void {
  if (activeDeckEvent(index, event)) cancelPreroll()
  if (preroll?.index === index && preroll.element === event.currentTarget) cancelPreroll()
  const mediaError = event.currentTarget instanceof HTMLMediaElement ? event.currentTarget.error : null
  const preparationId = audioDecks.value[index].preparationId
  if (overlapDeckAllowed(index)) {
    const wasActive = activeDeckEvent(index, event)
    if (mediaError) finishOverlap('media-error')
    if (!wasActive || !mediaError) return
  }
  if (!activeDeckEvent(index, event)) {
    if (mediaError && preparationId !== undefined && event.currentTarget === deckElement(index)) {
      props.store.rejectNextPreparation(preparationId)
      recordPlayback('preparation.media-failed', { preparationId })
    }
    return
  }
  // After a native pause only an event whose element carries a MediaError is a failure;
  // an error-less event in that state stays ignored.
  if (nativeInterruptionGeneration === props.store.playbackGeneration.value && !mediaError) return
  const element = event.currentTarget
  const knownFailure = element instanceof HTMLAudioElement ? networkErrorSources.get(element) : undefined
  // An interrupted, already-observed network failure stays cancelled when a duplicate error
  // arrives after its resolver settled. A new listener Play clears the interruption explicitly.
  if (knownFailure?.generation === props.store.playbackGeneration.value && knownFailure.pauseObserved &&
    nativeInterruptionGeneration === props.store.playbackGeneration.value) return
  if (mediaError?.code === 2 && element instanceof HTMLAudioElement &&
    element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    nativeInterruptionGeneration !== props.store.playbackGeneration.value && !playerPauseRequested &&
    props.store.playbackIntent.value === 'playing' && ['playing', 'buffering'].includes(props.store.status.value) &&
    !networkErrorSources.has(element)) {
    networkErrorSources.set(element, {
      generation: props.store.playbackGeneration.value, commandRevision: playbackCommandRevision, pauseObserved: false,
    })
  }
  void recoverMediaFailure(props.store.activeProviderId.value, props.store.playbackGeneration.value)
}

/** Keep store cancellation from becoming a failed renewal in the awaiting view callback. */
function retireMediaRecovery(): void {
  mediaOperationRevision += 1
  if (activeMediaRecovery) {
    activeMediaRecovery.retired = true
    activeMediaRecovery.cancelled = true
  }
}

/** One load failure may produce several events before its same-track renewal has settled. */
function recoverMediaFailure(
  providerId: string | undefined,
  generation: number,
  stillNeeded?: () => boolean,
): Promise<void> {
  if (playerUnmounted || generation !== props.store.playbackGeneration.value || providerId !== props.store.activeProviderId.value) {
    return Promise.resolve()
  }
  // A retired command cannot own a new load failure; its late result remains cancelled.
  if (activeMediaRecovery?.generation === generation && activeMediaRecovery.providerId === providerId &&
    !activeMediaRecovery.retired) {
    recordPlayback('media.recovery.join', { gen: generation, providerId: providerId ?? null })
    const pending = activeMediaRecovery
    // A real load failure must outlive the progress guard of an earlier stall. If the stall
    // renews successfully its new generation makes this follow-up stale; otherwise retry the
    // error path once, sharing it with any overlapping error or play rejection.
    return !stillNeeded && pending.stillNeeded
      ? pending.promise.then(() => {
          const stillAllowed = () => !playerUnmounted && !pending.cancelled && pending.commandRevision === playbackCommandRevision &&
            pending.operationRevision === mediaOperationRevision &&
            nativeInterruptionGeneration !== generation && props.store.playbackIntent.value === 'playing'
          if (stillAllowed()) return recoverMediaFailure(providerId, generation, stillAllowed)
        })
      : pending.promise
  }
  const recovery: ActiveMediaRecovery = {
    startedDuringHandover: handoverActive(handover, generation) || props.store.awaitingStart?.value?.generation === generation,
    commandRevision: playbackCommandRevision, operationRevision: mediaOperationRevision, cancelled: false, retired: false, generation, providerId, stillNeeded,
    promise: Promise.resolve().then(() => handleDeckError(providerId, generation,
      () => !playerUnmounted && !recovery.cancelled && recovery.commandRevision === playbackCommandRevision &&
        recovery.operationRevision === mediaOperationRevision &&
        props.store.playbackIntent.value === 'playing' && (stillNeeded?.() ?? true), Boolean(stillNeeded))).finally(() => {
      if (activeMediaRecovery !== recovery) return
      activeMediaRecovery = undefined
      // Progress and waiting events while the resolve was pending could not arm the watchdog.
      if (stillNeeded && generation === props.store.playbackGeneration.value &&
        !stillNeeded() && !audio.value?.paused && !audio.value?.seeking) {
        schedulePlaybackStall(PLAYBACK_STALL_FALLBACK_MS)
      }
    }),
  }
  activeMediaRecovery = recovery
  recordPlayback('media.recovery.begin', { gen: generation, providerId: providerId ?? null })
  return recovery.promise
}

/**
 * A media error is first treated as an expired or interrupted URL: the same provider is asked for
 * a fresh one at the same position (see `renewMedia`). A stalled stream uses the same bounded
 * path, with a guard that discards a late result once playback resumes or is interrupted.
 * Failed renewal tries the remaining automatic providers before any skip.
 */
async function handleDeckError(
  providerId: string | undefined,
  generation: number,
  stillNeeded: () => boolean = () => true,
  stalled = false,
): Promise<void> {
  if (generation !== props.store.playbackGeneration.value || providerId !== props.store.activeProviderId.value || !stillNeeded()) return
  clearPlaybackStall()
  if (stalled && providerId && props.store.requestSourceRecovery) {
    const element = audio.value
    if (!element) return
    pauseIfHalted(await props.store.requestSourceRecovery(providerId, generation, element.currentTime, stillNeeded), generation)
    return
  }
  const starting = handoverActive(handover, generation) ? handover : undefined
  if (starting) { clearHandoverWatchdog(); starting.step = 'reResolving' }
  const renewed = providerId && await props.store.renewMedia(providerId, generation, stillNeeded)
  if (!stillNeeded()) return
  if (starting && starting === handover) {
    if (renewed) {
      starting.generation = props.store.playbackGeneration.value
      starting.step = 'reResolved'
      armHandoverWatchdog()
      return
    }
    endHandover()
  }
  if (renewed) return
  if (generation !== props.store.playbackGeneration.value || !stillNeeded()) return
  pauseIfHalted(await reportFailure(providerId, generation), generation)
}

function updateBufferState(element: HTMLAudioElement): void {
  if (!element.buffered) {
    bufferedRawRanges.value = []
    return
  }
  const ranges: RawTimeRange[] = []
  for (let i = 0; i < element.buffered.length; i++) {
    ranges.push({
      start: element.buffered.start(i),
      end: element.buffered.end(i),
    })
  }
  bufferedRawRanges.value = ranges
}
function resetBufferState(): void {
  bufferedRawRanges.value = []
}

function updateMediaPresentation(element: HTMLAudioElement, allowTransition = true): void {
  if (prerollRewindIndex.value === activeDeckIndex.value && element === deckElement(activeDeckIndex.value) && !completePrerollRewind(activeDeckIndex.value)) return
  duration.value = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0
  seekable.value = element.seekable.length > 0
  const elapsed = Number.isFinite(element.currentTime) ? Math.max(0, element.currentTime) : 0
  currentTime.value = duration.value > 0 ? Math.min(elapsed, duration.value) : elapsed
  const pendingResume = props.store.pendingResumePosition.value
  if (
    pendingResume !== undefined &&
    element.dataset.playbackGeneration === String(props.store.playbackGeneration.value)
  ) {
    const target = duration.value > 0 ? Math.min(pendingResume, duration.value) : pendingResume
    if (element.seeking) return
    if (Math.abs(element.currentTime - target) <= 1) {
      if (resumeSeekTimer !== undefined) { clearTimeout(resumeSeekTimer); resumeSeekTimer = undefined }
      props.store.consumePendingResumePosition()
      if (props.store.playbackIntent.value === 'playing') void play(props.store.playbackGeneration.value, props.store.activeProviderId.value, false)
    } else {
      const ranges = element.seekable
      for (let i = 0; i < ranges.length; i++) {
        if (target >= ranges.start(i) && target <= ranges.end(i)) {
          try { element.currentTime = target } catch { /* Retry on the next readiness event. */ }
          break
        }
      }
      return
    }
  }
  if (Math.abs(currentTime.value - lastObservedPosition) >= 0.25) {
    lastObservedPosition = currentTime.value
    clearPlaybackStall()
    if (props.store.status.value === 'playing' || props.store.status.value === 'buffering') schedulePlaybackStall(PLAYBACK_STALL_FALLBACK_MS)
  }
  if (!allowTransition) return
  observeEnergy(element)
  armNextTrackIfDue()
  if (manualPreparation === undefined && !element.seeking && props.store.transitionMode.value !== 'off' && props.store.repeatMode.value !== 'one' && duration.value > 0 &&
      duration.value - currentTime.value <= plannedTransition().durationSeconds) {
    void tryCrossfade(props.store.nextPreparationIndex.value)
  }
}

/**
 * Ask the store to prepare the next track once the active track is inside the preload lead window.
 *
 * Driven from media progress rather than from the track change, because the resolved media URL
 * carries a ticket with a 120 second lifetime: resolving at the start of a multi-minute track would
 * produce a URL that has already expired by the time the track is promoted. `armNextPreparation` is
 * a no-op while a fresh preparation exists, so calling it on every progress tick is cheap.
 */
function armNextTrackIfDue(): void {
  if (manualPreparation !== undefined || overlap.value) return
  if (duration.value <= 0) return
  if (duration.value - currentTime.value > NEXT_TRACK_PRELOAD_LEAD_SECONDS) return
  void props.store.armNextPreparation()
}

// Presentation is separate from the existing playback/lease state machines.
// Capture source identity as well as generation, including the pre-render window.
const mediaPresentationHandlers = computed(() => {
  const generation = props.store.playbackGeneration.value
  const trackId = props.store.currentTrack.value?.id
  const playable = props.store.playable.value
  const currentMedia = (): HTMLAudioElement | null => {
    const current = props.store.playable.value
    if (
      generation !== props.store.playbackGeneration.value ||
      trackId !== props.store.currentTrack.value?.id ||
      playable?.kind !== 'audio' || current?.kind !== 'audio' || playable.url !== current.url
    ) return null
    const element = audio.value
    if (
      !element || element.dataset.playbackGeneration !== String(generation) ||
      element.dataset.trackId !== trackId || element.getAttribute('src') !== current.url
    ) return null
    return element
  }
  function seekTo(value: number): void {
    const element = currentMedia()
    if (!element || !canSeek.value) return
    if (!Number.isFinite(value)) return
    cancelManualSelection()
    finishOverlap('seek')
    stopSampling()
    updateMediaPresentation(element, false)
    if (!canSeek.value) return
    updateBufferState(element)
    try {
      const target = Math.min(duration.value, Math.max(0, value))
      // Only seek within a range the current native source actually offers.
      const ranges = element.seekable
      let nearest = ranges.start(0)
      let distance = Infinity
      for (let index = 0; index < ranges.length; index++) {
        const candidate = Math.max(ranges.start(index), Math.min(ranges.end(index), target))
        if (Math.abs(candidate - target) < distance) { nearest = candidate; distance = Math.abs(candidate - target) }
      }
      element.currentTime = nearest
      retireMediaRecovery()
      props.store.reportProgress?.(nearest, generation, true)
      updateMediaPresentation(element, false)
    } catch {
      // A source may lose seekability between metadata and this user command.
      // Do not fabricate elapsed time or treat an unavailable seek as provider failure.
    }
  }
  return {
    update(event: Event, deckIndex?: number) {
      const element = currentMedia()
      if (element && event.currentTarget === element) {
        if (deckIndex !== undefined && deckIndex !== activeDeckIndex.value) return
        updateMediaPresentation(element)
        updateBufferState(element)
      }
    },
    updateBuffer(element: HTMLAudioElement) {
      updateBufferState(element)
    },
    seekTo,
    seek(event: Event) { seekTo(Number((event.target as HTMLInputElement).value)) },
  }
})

watch(
  [
    () => props.store.playbackGeneration.value,
    () => props.store.currentTrack.value?.id,
    () => props.store.playable.value?.kind,
    () => props.store.playable.value?.kind === 'audio' ? props.store.playable.value.url : undefined,
  ],
  // Batch queue/index changes: their intermediate track must not reset progress.
  () => { currentTime.value = 0; duration.value = 0; seekable.value = false; resetBufferState() },
)

async function reportFailure(providerId?: string, generation = props.store.playbackGeneration.value): Promise<FailureOutcome> {
  return providerId ? await props.store.reportPlaybackFailure(providerId, generation) : 'stale'
}

function syncVolume(volume: number): void {
  if (overlap.value) { applyOverlapVolume(); return }
  for (let index = 0; index < audioDecks.value.length; index++) {
    const element = deckElement(index)
    if (!element) continue
    const audible = (index === activeDeckIndex.value || index === recoveryRetainedIndex.value) &&
      index !== prerollRewindIndex.value
    element.volume = audible ? volume : 0
  }
  youtube.value?.setVolume(volume)
}

function reportMediaState(state: PlaybackMediaState, generation: number): void {
  if (
    state === 'playing' &&
    generation === props.store.playbackGeneration.value &&
    activeTimerPauseLease
  ) invalidateInterruptionOwnership()
  props.store.reportMediaState(state, generation)
}

function tryBackgroundHandoff(generation: number): boolean {
  if (document.visibilityState !== 'hidden' || props.store.repeatMode.value === 'one' ||
    nativeInterruptionGeneration === generation || recoveryRetainedIndex.value !== undefined) return false
  const element = audio.value
  const prepared = props.store.preparedNext.value
  if (!element?.ended || !prepared?.armed || props.store.playbackIntent.value !== 'playing') return false
  const pending = { index: activeDeckIndex.value, element, preparationId: prepared.id,
    generation: generation + 1, trackId: prepared.track.id }
  backgroundHandoff = pending
  let advanced = false
  try { advanced = props.store.tryAdvancePreparedAfterEnded(generation) }
  finally { backgroundHandoff = undefined }
  if (!advanced) return false
  invalidateInterruptionOwnership(true, true)
  backgroundStartedGeneration = props.store.playbackGeneration.value
  // No timer or nextTick before the actual native play request.
  void play(backgroundStartedGeneration, props.store.activeProviderId.value, false)
  return true
}

function handleMediaEnded(generation: number): void {
  finishOverlap('ended')
  if (generation !== props.store.playbackGeneration.value) return
  recordPlayback('advance.auto', {
    gen: generation, trackId: props.store.currentTrack.value?.id ?? null, repeatMode: props.store.repeatMode.value,
    index: props.store.currentIndex.value, length: props.store.queue.value.length, ...pageLogState(),
  })
  if (tryBackgroundHandoff(generation)) return
  if (props.store.repeatMode.value === 'off') {
    if (props.store.currentIndex.value + 1 >= props.store.queue.value.length) {
      reportMediaState('ended', generation)
      props.store.pause()
    }
    else { invalidateInterruptionOwnership(true, true); void props.store.next() }
    return
  }
  if (props.store.repeatMode.value === 'one') {
    const element = audio.value
    // A fully buffered deck can replay without minting a new transient media ticket.
    if (element && Number.isFinite(element.duration) && element.duration > 0 &&
      element.buffered.length === 1 && element.buffered.start(0) <= 0.05 && element.buffered.end(0) >= element.duration - 0.25) {
      reportMediaState('ended', generation)
      if (props.store.playbackIntent.value !== 'playing' || nativeInterruptionGeneration === generation) return
      void props.store.play()
      element.currentTime = 0
      void element.play().catch((error: unknown) => {
        recordPlayback('play.rejected', { gen: generation, site: 'repeatOne', name: error instanceof Error ? error.name : typeof error })
        void props.store.advanceAfterEnded()
      })
      return
    }
  }
  invalidateInterruptionOwnership(true, true)
  void props.store.advanceAfterEnded()
}

function reportNativePlayCommand(generation: number): void {
  if (
    generation === props.store.playbackGeneration.value &&
    activeTimerPauseLease
  ) invalidateInterruptionOwnership()
}

watch(() => props.store.transitionMode.value, () => { cancelManualSelection(); finishOverlap('setting'); stopSampling() })
watch(() => props.store.playbackIntent.value, intent => {
  if (intent === 'paused') {
    // Also covers store.pause() callers outside this view, including a synchronous Pause/Play.
    retireMediaRecovery()
    cancelManualSelection(); finishOverlap('intent-pause'); stopSampling()
  }
}, { flush: 'sync' })
watch(
  () => [props.store.preparedNext.value, props.store.preloadPolicy.value] as const,
  syncPreparedDeck,
  { flush: 'sync', immediate: true },
)
watch(
  [
    () => props.store.preloadHandoff.value,
    () => props.store.playable.value,
    () => props.store.currentTrack.value?.id,
    () => props.store.playbackGeneration.value,
  ],
  syncActiveDeck,
  { flush: 'sync', immediate: true },
)

watch(
  () => [props.store.playbackIntent.value, props.store.status.value] as const,
  ([intent, status]) => {
    if (intent !== 'playing' || ['error', 'idle'].includes(status) || (status === 'paused' && !audio.value?.ended)) cancelPreroll()
    if (recoveryRetainedIndex.value !== undefined && (intent !== 'playing' || ['paused', 'error', 'ended', 'idle'].includes(status))) {
      releaseRecoverySource()
      audio.value?.pause()
    }
  },
  { flush: 'sync' },
)
watch(
  () => props.store.volume.value,
  (volume) => {
    if (volume > 0) lastAudibleVolume.value = volume
    syncVolume(volume)
  },
  { immediate: true },
)
// The volume watcher runs before template refs exist on an initial mount.
watch(audio, (element) => {
  if (samplingElement && samplingElement !== element) stopSampling()
  if (element) {
    syncVolume(props.store.volume.value)
    // A promoted deck already delivered metadata while it was standby. Observe
    // its real state now; it need not emit loadedmetadata a second time.
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) updateMediaPresentation(element)
    updateBufferState(element)
  } else {
    resetBufferState()
  }
}, { flush: 'post' })
watch(
  () => props.store.playable.value,
  async (observedPlayable) => {
    if (!observedPlayable) return
    const generation = props.store.playbackGeneration.value
    const providerId = props.store.activeProviderId.value
    await nextTick()
    if (
      observedPlayable !== props.store.playable.value ||
      generation !== props.store.playbackGeneration.value
    ) return
    if (generation === backgroundStartedGeneration) return
    if (audio.value) {
      syncVolume(props.store.volume.value)
      if (props.store.playbackIntent.value === 'playing' && !overlap.value?.promoted) await play(generation, providerId, false)
    }
  },
)
watch(
  [
    () => props.mediaSuspended,
    () => props.store.playable.value?.kind ?? null,
    () => props.store.playbackGeneration.value,
  ],
  ([suspended, playableKind]) => {
    if (activeTimerPauseLease && !timerPauseLeaseIsValid(activeTimerPauseLease)) {
      cancelTimerPauseLease(activeTimerPauseLease)
    }
    if (suspended) {
      if (playableKind === 'youtube') applyYouTubeSuspension()
      else youtubeSuspensionApplied = false
      return
    }

    youtubeSuspensionApplied = false
    if (resumeTimerPauseLeaseWhenReady()) return
    if (!resumeAfterSuspension || !props.store.playable.value) return
    resumeAfterSuspension = false
    void play()
  },
  { flush: 'sync', immediate: true },
)

const playbackFailureHandler = computed(() => {
  const providerId = props.store.activeProviderId.value
  const generation = props.store.playbackGeneration.value
  return () => reportFailure(providerId, generation)
})

const youtubeReadyHandler = computed(() => {
  const generation = props.store.playbackGeneration.value
  return () => {
    if (props.mediaSuspended) {
      applyYouTubeSuspension(generation)
      youtube.value?.pause()
      props.store.reportMediaState('paused', generation)
      return
    }
    props.store.reportMediaState('ready', generation)
    syncVolume(props.store.volume.value)
    if (
      generation === props.store.playbackGeneration.value &&
      props.store.playbackIntent.value === 'playing'
    ) youtube.value?.play()
  }
})

const mediaStateHandlers = computed(() => {
  const generation = props.store.playbackGeneration.value
  const report = (state: PlaybackMediaState) => () => reportMediaState(state, generation)
  return {
    ready: report('ready'),
    playing: report('playing'),
    paused: report('paused'),
    buffering: report('buffering'),
    ended: () => handleMediaEnded(generation),
  }
})

const nativePlayCommandHandler = computed(() => {
  const generation = props.store.playbackGeneration.value
  return () => reportNativePlayCommand(generation)
})

const youtubeStateHandler = computed(() => {
  const generation = props.store.playbackGeneration.value
  return (state: number) => {
    const states: Partial<Record<number, PlaybackMediaState>> = {
      0: 'ended', 1: 'playing', 2: 'paused', 3: 'buffering', 5: 'ready',
    }
    const mediaState = states[state]
    if (props.mediaSuspended && mediaState && mediaState !== 'paused') {
      applyYouTubeSuspension(generation)
      youtube.value?.pause()
      props.store.reportMediaState('paused', generation)
      return
    }
    if (mediaState === 'ended') handleMediaEnded(generation)
    else if (mediaState) {
      if (generation === props.store.playbackGeneration.value) {
        if (mediaState === 'playing' && props.store.playbackIntent.value !== 'playing') void props.store.play()
        if (mediaState === 'paused' && props.store.playbackIntent.value !== 'paused') props.store.pause()
      }
      reportMediaState(mediaState, generation)
    }
  }
})

onMounted(() => {
  uninstallPlaybackLogLifecycle = installPlaybackLogLifecycle()
  instrumentDeckElements()
  observeDeckLoadActivity()
  installAutoResumeListeners()
  const commands: PlayerCommands = {
    isPlaying: () => props.store.playbackIntent.value === 'playing' || resumeAfterSuspension,
    pause,
    pauseForInterruption,
    play: () => {
      invalidateInterruptionOwnership(false)
      void play()
    },
    stop,
    previous,
    next,
    seek: (seconds) => mediaPresentationHandlers.value.seekTo(seconds),
  }
  unregisterPlayerCommands = registerPlayerCommands(commands)
  unregisterMediaSession = registerPlaybackMediaSession(props.store, commands, () => currentTrackLabel.value)
  updateConnectivity()
  document.addEventListener('visibilitychange', onTransitionVisibility)
  window.addEventListener('online', updateConnectivity)
  window.addEventListener('offline', updateConnectivity)
  connection()?.addEventListener?.('change', updateConnectivity)
})

onUpdated(() => {
  instrumentDeckElements()
  observeDeckLoadActivity()
})

onBeforeUnmount(() => {
  playerUnmounted = true
  finishOverlap('unmount')
  stopSampling()
  cancelManualSelection()
  document.removeEventListener('visibilitychange', onTransitionVisibility)
  cancelPreroll()
  uninstallPlaybackLogLifecycle?.()
  uninstallPlaybackLogLifecycle = undefined
  uninstallAutoResumeListeners()
  cancelAutoResume('unmount')
  clearPlaybackStall()
  clearHandoverWatchdog()
  handover = undefined
  if (resumeSeekTimer !== undefined) clearTimeout(resumeSeekTimer)
  releaseRecoverySource()
  for (const element of audioDeckElements.value) {
    element.pause()
    element.removeAttribute('src')
    element.load()
  }
  unregisterPlayerCommands?.()
  unregisterMediaSession?.()
  publishPlaybackPresentation(props.store, { currentTime: 0, duration: 0, canSeek: false })
  window.removeEventListener('online', updateConnectivity)
  window.removeEventListener('offline', updateConnectivity)
  connection()?.removeEventListener?.('change', updateConnectivity)
  props.store.setPreloadPolicy('none')
})
</script>

<template>
  <section
    ref="glassHeroRoot"
    class="player-bar liquid-shell"
    data-glass-hero="player"
    :class="{ 'player-bar--compact': compact, 'player-bar--collapsed': collapsed }"
    :data-player-compact="compact ? '' : undefined"
    :data-transition-active="overlap ? 'true' : 'false'"
    :data-media-suspended="mediaSuspended ? 'true' : 'false'"
    :inert="mediaSuspended || undefined"
    :aria-hidden="mediaSuspended ? 'true' : undefined"
    :aria-label="text('player.music')"
    tabindex="0"
    @keydown="onKeydown"
  >
    <div class="player-bar__heading">
      <div class="player-bar__identity">
        <div class="player-bar__artwork" aria-hidden="true">
          <img
            v-if="hasArtwork && artworkUrl"
            data-player-artwork-image
            :key="artworkIdentity"
            :data-artwork-identity="artworkIdentity"
            class="player-bar__artwork-image"
            :src="artworkUrl"
            :alt="artworkAlt"
            referrerpolicy="no-referrer"
            @error="onArtworkError"
          />
          <div v-else data-player-artwork-fallback aria-hidden="true" class="player-bar__artwork-fallback">
            <Music2 :size="24" />
          </div>
        </div>
        <div class="player-bar__track-copy">
          <p v-show="!collapsed">{{ text('player.nowPlaying') }}</p>
          <h2 data-player-canonical-title>{{ currentTrackLabel }}</h2>
          <p v-if="trackGames" class="player-bar__metadata" data-player-track-metadata>{{ trackGames }}</p>
          <p
            v-if="store.currentTrack.value"
            class="player-bar__release player-bar__quality"
            data-player-release-provider
            data-player-quality
          >{{ playbackQualityText }}</p>
        </div>
      </div>
      <label v-if="!compact && sourceIds.length" v-show="!collapsed">
        <span>{{ text('player.source') }}</span>
        <select
          :aria-label="text('player.sourceLabel')"
          :value="store.sourceOverride.value ?? store.activeProviderId.value ?? ''"
          @change="onSourceChange"
        >
          <option value="">{{ text('player.automatic') }}</option>
          <option v-for="provider in sourceIds" :key="provider" :value="provider">
            {{ formatProviderLabel(provider) }}
          </option>
        </select>
      </label>
      <button
        type="button"
        class="player-bar__collapse"
        data-player-collapse
        :aria-label="text(collapsed ? 'player.expand' : 'player.collapse')"
        :aria-expanded="!collapsed"
        @click="toggleCollapsed"
      >
        <MoreHorizontal v-if="collapsed" :size="22" aria-hidden="true" />
        <ChevronDown v-else :size="18" aria-hidden="true" />
      </button>
    </div>

    <div class="player-bar__body">
      <p class="player-bar__status" role="status" :aria-label="text('player.statusName')" aria-live="polite">{{ statusText }}</p>
      <ul class="player-bar__notices" data-player-notices aria-live="polite" :aria-label="text('player.notice.region')">
        <li v-for="notice in playbackNoticeItems" :key="notice.id" :data-player-notice="notice.kind">
          <span>{{ notice.message }}</span>
          <button
            v-if="notice.kind === 'tapToResume'"
            type="button"
            data-player-notice-resume
            @click="resumeFromListener"
          >{{ text('player.notice.resume') }}</button>
          <button type="button" :aria-label="text('player.notice.dismiss')" @click="dismissPlaybackNotice(notice.id)">×</button>
        </li>
      </ul>

      <div v-show="!collapsed" class="player-bar__video-container">
        <YouTubePlayer
          v-if="store.playable.value?.kind === 'youtube'"
          :key="store.playbackGeneration.value"
          ref="youtube"
          :title="text('player.officialYouTube')"
          :video-id="store.playable.value.videoId"
          @ready="youtubeReadyHandler"
          @state="youtubeStateHandler"
          @error="playbackFailureHandler"
        />
      </div>
      <template v-for="(deck, deckIndex) in audioDecks" :key="deckIndex">
        <audio
          v-if="deck.src || deck.retained"
          v-show="false"
          ref="audioDeckElements"
          :data-audio-deck="deckIndex"
          :data-audio-role="deckIndex === activeDeckIndex ? 'active' : deck.retained || deckIndex === recoveryRetainedIndex ? 'retained' : 'standby'"
          :muted="deckIndex !== activeDeckIndex && deckIndex !== recoveryRetainedIndex && deckIndex !== prerollDeckIndex && !overlapDeckAllowed(deckIndex)"
          :data-playback-generation="deck.generation"
          :data-track-id="deck.trackId"
          :preload="deck.preload"
          v-audio-source="deck.src || undefined"
          :type="deck.mimeType"
          @loadedmetadata="onDeckPresentation(deckIndex, $event)"
          @durationchange="onDeckPresentation(deckIndex, $event)"
          @timeupdate="onDeckPresentation(deckIndex, $event)"
          @progress="onDeckPresentation(deckIndex, $event)"
          @seeking="onDeckPresentation(deckIndex, $event)"
          @seeked="onDeckPresentation(deckIndex, $event)"
          @emptied="onDeckPresentation(deckIndex, $event)"
          @play="onDeckPlay(deckIndex, $event)"
          @canplay="onDeckPresentation(deckIndex, $event); onDeckState(deckIndex, $event, 'ready')"
          @playing="onDeckState(deckIndex, $event, 'playing')"
          @pause="onDeckState(deckIndex, $event, 'paused')"
          @waiting="onDeckState(deckIndex, $event, 'buffering')"
          @stalled="onDeckState(deckIndex, $event, 'buffering')"
          @ended="onDeckState(deckIndex, $event, 'ended')"
          @error="onDeckError(deckIndex, $event)"
        ></audio>
      </template>

      <div v-if="store.playable.value?.kind !== 'youtube'" class="player-bar__progress" data-player-progress>
        <div class="player-bar__seek-group">
          <div class="player-bar__track-base" aria-hidden="true" />
          <div
            class="player-bar__buffer-track"
            data-player-buffer
            :data-buffered-extent="currentBufferedExtent ? `${currentBufferedExtent.startPercent.toFixed(1)}%-${currentBufferedExtent.endPercent.toFixed(1)}%` : undefined"
            aria-hidden="true"
          >
            <div
              v-for="(seg, idx) in bufferedSegments"
              :key="idx"
              class="player-bar__buffer-segment"
              data-player-buffer-segment
              :data-current="seg.containsCurrent ? 'true' : undefined"
              :style="{ left: `${seg.startPercent}%`, width: `${seg.widthPercent}%` }"
            />
          </div>
          <div
            class="player-bar__played-track"
            data-player-played
            :style="{ '--played-percent': String(playedPercent) }"
            aria-hidden="true"
          />
          <input
            data-player-seek
            type="range"
            min="0"
            :max="duration"
            step="0.1"
            :value="canSeek ? currentTime : 0"
            :disabled="!canSeek"
            :aria-label="text('player.seek')"
            :aria-valuetext="formatTime(currentTime) + ' / ' + (duration > 0 ? formatTime(duration) : '--:--')"
            @input="mediaPresentationHandlers.seek"
          />
        </div>
        <div v-show="!collapsed" class="player-bar__time" dir="ltr">
          <span data-player-elapsed :aria-label="text('player.elapsed')">{{ formatTime(currentTime) }}</span>
          <span data-player-duration :aria-label="text('player.duration')">{{ duration > 0 ? formatTime(duration) : '--:--' }}</span>
        </div>
      </div>

      <div class="player-bar__controls">
        <div class="player-bar__transport">
          <button
            type="button"
            data-player-previous
            :aria-label="text('player.previous')"
            @click="previous"
          >
            <SkipBack :size="18" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="player-bar__play"
            data-player-play
            :aria-label="text(transportStarting ? 'player.transport.starting' : transportPlaying ? 'player.pause' : 'player.play')"
            :aria-busy="transportStarting ? 'true' : undefined"
            :data-player-starting="transportStarting ? '' : undefined"
            @click="toggle"
          >
            <LoaderCircle v-if="transportStarting" class="player-bar__starting" :size="24" aria-hidden="true" />
            <Pause v-else-if="transportPlaying" :size="24" aria-hidden="true" />
            <Play v-else :size="24" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-player-next
            :aria-label="text('player.next')"
            @click="next"
          >
            <SkipForward :size="18" aria-hidden="true" />
          </button>
        </div>
        <div v-show="!collapsed" class="player-bar__secondary">
          <div class="player-bar__volume-group">
            <button type="button" :aria-label="text(store.volume.value > 0 ? 'player.mute' : 'player.unmute')" @click="toggleMute">
              <Volume2 v-if="store.volume.value > 0" :size="18" aria-hidden="true" />
              <VolumeX v-else :size="18" aria-hidden="true" />
            </button>
            <label class="player-bar__volume">
              <span>{{ text('player.volume') }}</span>
              <input :aria-label="text('player.volume')" type="range" min="0" max="1" step="0.05" :value="store.volume.value" @input="onVolume" />
            </label>
          </div>
          <button
            type="button"
            class="player-bar__queue"
            data-player-toggle-queue
            aria-controls="workspace-queue-drawer"
            :aria-label="queueLabel"
            :aria-expanded="queueOpen ? 'true' : 'false'"
            @click="emit('toggle-queue')"
          >
            <ListMusic :size="18" aria-hidden="true" />
            <span class="player-bar__queue-label">{{ text('queue.title') }} ·</span>
            <span data-player-queue-count>{{ upcomingCount }}</span>
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.player-bar { display: grid; gap: 0.625rem; padding: 0.875rem; border-radius: var(--radius-surface); }
.player-bar--collapsed {
  gap: 0.375rem;
  padding: 0.5rem 0.75rem;
}
.player-bar--collapsed .player-bar__body {
  gap: 0.25rem;
}
.player-bar--collapsed .player-bar__artwork {
  width: 2rem;
  height: 2rem;
  flex: 0 0 2rem;
}
.player-bar--collapsed .player-bar__heading h2 {
  margin-top: 0;
  font-size: 0.9375rem;
}
.player-bar--collapsed .player-bar__progress input[type="range"] {
  min-height: 1.25rem;
  height: 1.25rem;
}
.player-bar--collapsed .player-bar__controls {
  gap: 0;
}
.player-bar--collapsed .player-bar__transport {
  gap: 0.5rem;
}
.player-bar--collapsed button {
  width: 2.25rem;
  height: 2.25rem;
}
.player-bar--collapsed .player-bar__play {
  width: 2.5rem;
  height: 2.5rem;
}
.player-bar--compact { width: 100%; max-width: var(--workspace-player-inline-size); }
.player-bar--compact .player-bar__heading h2,
.player-bar--compact .player-bar__status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.player-bar__heading, .player-bar__identity { display: flex; flex-wrap: wrap; gap: 0.625rem; align-items: center; justify-content: space-between; }
.player-bar__heading { min-width: 0; }
.player-bar__collapse { margin-inline-start: auto; }
.player-bar__body { display: grid; gap: 0.625rem; min-width: 0; }
.player-bar__identity { flex: 1; flex-wrap: nowrap; min-width: 0; justify-content: flex-start; }
.player-bar__artwork { display: grid; flex: 0 0 var(--workspace-player-artwork-size); width: var(--workspace-player-artwork-size); aspect-ratio: 1; place-items: center; color: var(--colour-accent-strong); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: var(--radius-surface); box-shadow: var(--glass-highlight), var(--glass-shade); overflow: hidden; }
.player-bar__artwork-image { width: 100%; height: 100%; aspect-ratio: 1; object-fit: cover; display: block; }
.player-bar__artwork-fallback { display: grid; place-items: center; width: 100%; height: 100%; }
.player-bar__track-copy { min-width: 0; }
.player-bar__heading p, .player-bar__heading h2, .player-bar__status { margin: 0; }
.player-bar__heading p, label span { color: var(--colour-text-muted); font-size: 0.75rem; font-weight: 650; }
.player-bar__heading h2 { margin-top: 0.25rem; font-size: 1rem; }
.player-bar__heading .player-bar__release { margin-top: 0.25rem; color: var(--colour-text-muted); font-size: 0.75rem; }
.player-bar__heading label { display: grid; gap: 0.25rem; }
.player-bar__status { color: var(--colour-accent-strong); font-size: 0.875rem; line-height: 1.5; }
.player-bar__notices { margin: 0; padding: 0; list-style: none; font-size: 0.8125rem; line-height: 1.4; }
.player-bar__notices:empty { display: none; }
.player-bar__notices li { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.player-bar__notices button { min-width: 2rem; min-height: 2rem; border: 0; background: none; color: inherit; cursor: pointer; }
.player-bar__starting { animation: player-bar-starting 1s linear infinite; }
@keyframes player-bar-starting { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .player-bar__starting { animation: none; } }
select { min-height: 2.5rem; padding: 0.4375rem 0.625rem; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; cursor: pointer; transition: filter var(--motion-duration) ease; }
select:hover { filter: var(--control-hover-filter); }
select:active { filter: var(--control-active-filter); }
.player-bar__controls { display: grid; gap: 0.625rem; }
.player-bar__transport { display: flex; align-items: center; justify-content: center; gap: 0.875rem; }
.player-bar__progress { display: grid; min-width: 0; }
.player-bar__time { display: flex; justify-content: space-between; gap: 0.625rem; color: var(--colour-text-muted); font-size: 0.75rem; line-height: 1.4; font-variant-numeric: tabular-nums; }
.player-bar__secondary, .player-bar__volume-group { display: flex; align-items: center; gap: 0.4375rem; min-width: 0; }
.player-bar__volume-group { flex: 1; }
.player-bar__heading .player-bar__metadata { margin-top: 0.25rem; }
button { display: grid; width: 2.5rem; height: 2.5rem; padding: 0; place-items: center; color: var(--colour-text-primary); background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 50%; cursor: pointer; transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease; }
button:hover { filter: var(--control-hover-filter); }
button:active { transform: scale(0.94); filter: var(--control-active-filter); }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--colour-focus); outline-offset: 2px; }
button { flex-shrink: 0; }
.player-bar__play { width: 3rem; height: 3rem; color: var(--colour-background); background: var(--colour-accent); box-shadow: var(--glass-highlight), var(--glass-shade); }
.player-bar__queue { display: flex; width: auto; min-width: 2.5rem; padding-inline: 0.625rem; gap: 0.4375rem; border-radius: var(--workspace-player-details-radius); font: inherit; }
.player-bar__queue span { color: inherit; font-size: 0.875rem; font-weight: 650; white-space: nowrap; }
.player-bar__volume { display: grid; flex: 1; gap: 0.25rem; min-width: 0; }
input[type="range"] { width: 100%; min-height: 2.5rem; margin: 0; padding: 0; accent-color: var(--colour-accent); cursor: pointer; transition: filter var(--motion-duration) ease; }
.player-bar__volume input[type="range"] {
  --range-thumb: 1rem;
  width: calc(100% - var(--range-thumb));
  margin-inline: calc(var(--range-thumb) / 2);
  overflow: visible;
}
input[type="range"]:hover { filter: var(--control-hover-filter); }
input[type="range"]:active { filter: var(--control-active-filter); }
input[type="range"]:disabled { cursor: default; opacity: 0.5; filter: none; }
.player-bar__seek-group {
  --seek-thumb: 0.875rem;
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 2.5rem;
  overflow: visible;
}
.player-bar--collapsed .player-bar__seek-group {
  min-height: 1.25rem;
}
.player-bar__track-base {
  position: absolute;
  left: calc(var(--seek-thumb) / 2);
  right: calc(var(--seek-thumb) / 2);
  height: 0.25rem;
  border-radius: 0.125rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.2);
  pointer-events: none;
}
.player-bar__buffer-track {
  position: absolute;
  left: calc(var(--seek-thumb) / 2);
  right: calc(var(--seek-thumb) / 2);
  height: 0.25rem;
  border-radius: 0.125rem;
  pointer-events: none;
  overflow: hidden;
}
.player-bar__buffer-segment {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 0.125rem;
  background: rgba(255, 255, 255, 0.28);
  transition: width 0.15s ease, left 0.15s ease;
}
.player-bar__played-track {
  position: absolute;
  left: calc(var(--seek-thumb) / 2);
  width: calc((100% - var(--seek-thumb)) * var(--played-percent, 0) / 100);
  height: 0.25rem;
  border-radius: 0.125rem;
  background: var(--colour-accent);
  pointer-events: none;
  transition: width 0.05s linear;
}
input[data-player-seek] {
  position: relative;
  z-index: 2;
  width: 100%;
  background: transparent;
  overflow: visible;
  -webkit-appearance: none;
  appearance: none;
}
input[data-player-seek]::-webkit-slider-runnable-track {
  background: transparent;
  height: 0.25rem;
}
input[data-player-seek]::-moz-range-track {
  background: transparent;
  height: 0.25rem;
}
input[data-player-seek]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 0.875rem;
  height: 0.875rem;
  margin-top: -0.3125rem;
  border-radius: 50%;
  background: #ffffff;
  border: 2px solid var(--colour-accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  transition: transform 0.1s ease;
}
input[data-player-seek]:hover::-webkit-slider-thumb {
  transform: scale(1.15);
}
input[data-player-seek]::-moz-range-thumb {
  width: 0.875rem;
  height: 0.875rem;
  border-radius: 50%;
  background: #ffffff;
  border: 2px solid var(--colour-accent);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  transition: transform 0.1s ease;
}
input[data-player-seek]:hover::-moz-range-thumb {
  transform: scale(1.15);
}

/* Preserve the full transport/volume/queue control row on a landscape phone while
   reclaiming the non-interactive identity and spacing above it. */
@media (orientation: landscape) and (max-height: 30rem) and (max-width: 47.99rem) {
  .player-bar { gap: 0.25rem; padding: 0.5rem; }
  .player-bar__heading { gap: 0.375rem; }
  .player-bar__heading p { display: none !important; }
  .player-bar__heading h2 { margin-top: 0; }
  .player-bar__artwork { flex-basis: 2.5rem; width: 2.5rem; height: 2.5rem; }
  .player-bar__body,
  .player-bar__controls { gap: 0.25rem; }
  .player-bar__status { font-size: 0.75rem; line-height: 1.2; }
  .player-bar__transport,
  .player-bar__secondary { gap: 0.5rem; }
  .player-bar__volume { display: flex; align-items: center; gap: 0.25rem; }
}

/* The compact player is one optical body. Its hit targets remain 44px while the
   glyphs read as controls floating directly in the material. */
.player-bar {
  font-family: -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
  border-radius: var(--liquid-radius-shell);
}
.player-bar__artwork {
  background: rgb(255 255 255 / 9%);
  border: 0;
  border-radius: var(--liquid-radius-control);
  box-shadow: none;
}
.player-bar__heading h2 { font-weight: 690; letter-spacing: -0.02em; }
.player-bar__heading .player-bar__metadata,
.player-bar__heading .player-bar__quality { color: var(--liquid-text-secondary); font-weight: 400; }
.player-bar button {
  width: 2.75rem;
  height: 2.75rem;
  color: var(--liquid-text-primary);
  background: transparent;
  border: 0;
  box-shadow: none;
}
.player-bar button:hover { background: rgb(255 255 255 / 9%); filter: none; }
.player-bar button:active { background: rgb(255 255 255 / 14%); }
.player-bar__play { color: var(--liquid-text-primary); background: transparent; }
.player-bar__queue { border-radius: var(--liquid-radius-control); }
/* The shared button metric is a 44px circle. This command also carries a label,
   so it has to grow sideways. A fixed square is what stacked 播放 / 佇 / 列. */
.player-bar button.player-bar__queue {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: max-content;
  max-width: 100%;
  min-width: 2.75rem;
  height: 2.75rem;
  padding-inline: 0.75rem;
  white-space: nowrap;
}
.player-bar:not(.player-bar--collapsed) .player-bar__secondary { flex-wrap: nowrap; }
.player-bar:not(.player-bar--collapsed) .player-bar__controls { align-content: start; }
.player-bar__track-base { border: 0; background: rgb(255 255 255 / 14%); box-shadow: none; }
.player-bar__buffer-segment { background: rgb(235 245 255 / 34%); }
.player-bar__played-track { background: var(--colour-accent-strong); }
.player-bar--collapsed {
  position: relative;
  display: block;
  min-height: 5.25rem;
  padding: 0.625rem 9rem 0.625rem 0.75rem;
  border-radius: 999px;
}
.player-bar--collapsed .player-bar__heading { display: block; min-width: 0; }
.player-bar--collapsed .player-bar__identity { flex-wrap: nowrap; gap: 0.75rem; min-width: 0; }
.player-bar--collapsed .player-bar__artwork {
  flex: 0 0 3.75rem;
  width: 3.75rem;
  height: 3.75rem;
}
.player-bar--collapsed .player-bar__track-copy { overflow: hidden; }
.player-bar--collapsed .player-bar__heading h2,
.player-bar--collapsed .player-bar__heading .player-bar__metadata,
.player-bar--collapsed .player-bar__heading .player-bar__quality {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.player-bar--collapsed .player-bar__heading h2 { font-size: 1.0625rem; line-height: 1.25; }
.player-bar--collapsed .player-bar__heading .player-bar__metadata,
.player-bar--collapsed .player-bar__heading .player-bar__quality { margin-top: 0.125rem; font-size: 0.6875rem; }
.player-bar--collapsed .player-bar__body,
.player-bar--collapsed .player-bar__controls,
.player-bar--collapsed .player-bar__transport { display: contents; }
.player-bar--collapsed .player-bar__progress,
.player-bar--collapsed [data-player-previous] { display: none; }
.player-bar--collapsed .player-bar__status {
  position: absolute;
  top: 0;
  left: -10000px;
  white-space: nowrap;
}
.player-bar--collapsed .player-bar__collapse,
.player-bar--collapsed [data-player-play],
.player-bar--collapsed [data-player-next] {
  position: absolute;
  top: 50%;
  width: 2.75rem;
  height: 2.75rem;
  transform: translateY(-50%);
  border-radius: 50%;
}
.player-bar--collapsed .player-bar__collapse { right: 5.875rem; color: var(--liquid-text-secondary); }
.player-bar--collapsed [data-player-play] { right: 3rem; }
.player-bar--collapsed [data-player-next] { right: 0.25rem; }
.player-bar--collapsed [data-player-play] svg { width: 1.5rem; height: 1.5rem; fill: currentColor; }
.player-bar--collapsed [data-player-next] svg { width: 1.375rem; height: 1.375rem; fill: currentColor; }
.player-bar--collapsed .player-bar__collapse:active,
.player-bar--collapsed [data-player-play]:active,
.player-bar--collapsed [data-player-next]:active { transform: translateY(-50%) scale(0.94); }
@media (max-width: 47.99rem) {
  .player-bar--collapsed { min-height: 4.75rem; padding-right: 8.75rem; }
  .player-bar--collapsed .player-bar__artwork { flex-basis: 3.25rem; width: 3.25rem; height: 3.25rem; }
  .player-bar--collapsed .player-bar__identity { gap: 0.5rem; }
  .player-bar--collapsed .player-bar__heading h2 { font-size: 0.9375rem; }
  .player-bar--collapsed .player-bar__heading .player-bar__metadata,
  .player-bar--collapsed .player-bar__heading .player-bar__quality { font-size: 0.625rem; }
  .player-bar:not(.player-bar--collapsed) { max-height: calc(100dvh - 7.5rem); overflow-y: auto; }
  .player-bar:not(.player-bar--collapsed) .player-bar__secondary { display: flex; gap: 0.5rem; }
  .player-bar:not(.player-bar--collapsed) .player-bar__volume-group { flex: 1 1 auto; min-width: 0; }
  .player-bar:not(.player-bar--collapsed) button.player-bar__queue { flex: 0 0 auto; width: auto; min-width: 2.75rem; padding-inline: 0.5rem; }
  .player-bar:not(.player-bar--collapsed) .player-bar__queue-label { display: none; }
}
@media (orientation: landscape) and (max-height: 30rem) and (max-width: 47.99rem) {
  .player-bar--collapsed { min-height: 4rem; padding-block: 0.375rem; }
  .player-bar--collapsed .player-bar__artwork { flex-basis: 2.75rem; width: 2.75rem; height: 2.75rem; }
  .player-bar--collapsed .player-bar__heading .player-bar__metadata,
  .player-bar--collapsed .player-bar__heading .player-bar__quality { display: block !important; }
}
</style>
