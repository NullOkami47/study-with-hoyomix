<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { ChevronDown, ListMusic, MoreHorizontal, Music2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-vue-next'

import YouTubePlayer from './YouTubePlayer.vue'
import type { PlaybackMediaState, PlaybackStore } from './store'
import { isPreparationFresh } from './store'
import { translate, type TranslationKey } from '../../i18n'
import { resolveDisplayTitle } from '../catalog/displayTitle'
import { usePreferences } from '../../stores/preferences'
import { registerPlayerCommands, type PlaybackPauseLease, type PlayerCommands } from './commands'
import { NEXT_TRACK_PRELOAD_LEAD_SECONDS, selectPreloadPolicy } from './preloadPolicy'
import { formatPlaybackQuality } from './qualityFormat'
import { createJellyfinProvider } from './providers/jellyfin'
import { formatPlaybackTime, publishPlaybackPresentation } from './presentation'
import { registerPlaybackMediaSession } from './mediaSession'

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
const activeDeckIndex = ref(0)
const deckElement = (index: number): HTMLAudioElement | null => audioDeckElements.value.find(
  (element) => element.dataset.audioDeck === String(index),
) ?? null
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
interface TimerPauseLeaseState {
  generation: number
  owner: symbol
  resumeRequested: boolean
  revision: number
  settled: boolean
}
let activeTimerPauseLease: TimerPauseLeaseState | undefined

function formatProviderLabel(id: string): string {
  if (id === 'youtube') return 'YouTube'
  if (id === 'r2') return 'R2'
  if (id === 'jellyfin') return 'Jellyfin'
  if (id === 'chksz') return 'ChKSz'
  if (id === 'lx') return 'LX Music'
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

const primaryArtworkUrl = computed(() => props.store.playable.value?.metadata?.artworkUrl)
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
function onArtworkError(): void {
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
  }
  return text(keys[code ?? 'unavailable'] ?? 'player.statusUnavailable')
}

async function play(
  generation = props.store.playbackGeneration.value,
  providerId = props.store.activeProviderId.value,
): Promise<void> {
  if (generation !== props.store.playbackGeneration.value) return
  if (props.mediaSuspended && props.store.playable.value?.kind === 'youtube') {
    resumeAfterSuspension = true
    applyYouTubeSuspension(generation)
    return
  }
  props.store.play()
  youtube.value?.play()
  try {
    await audio.value?.play()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      // Browser autoplay policy: the track is resolved and ready but the
      // browser requires a user gesture before playback can begin.  Do NOT
      // report this as a provider failure — keep the playable loaded and
      // show the play button so a subsequent user click succeeds.
      if (generation === props.store.playbackGeneration.value) {
        props.store.pause()
        props.store.reportMediaState('ready', generation)
      }
      return
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      // Playback was interrupted (e.g. a new track was loaded while this
      // one was still buffering).  Silently ignore.
      return
    }
    await reportFailure(providerId, generation)
  }
}

function pauseMedia(): void {
  props.store.pause()
  youtube.value?.pause()
  audio.value?.pause()
}

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value
}

function invalidateInterruptionOwnership(clearDeferredResume = true): void {
  playbackCommandRevision += 1
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
  pauseMedia()
  props.store.stop()
}

defineExpose({ pause, stop })

function toggle(): void {
  if (props.store.playbackIntent.value === 'playing') pause()
  else {
    invalidateInterruptionOwnership(false)
    void play()
  }
}

function next(): void {
  invalidateInterruptionOwnership()
  void props.store.next()
}

function previous(): void {
  invalidateInterruptionOwnership()
  void props.store.previous()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.target !== event.currentTarget) return
  if (event.code === 'Space') { event.preventDefault(); toggle() }
  else if (event.code === 'ArrowRight') { event.preventDefault(); next() }
  else if (event.code === 'ArrowLeft') { event.preventDefault(); previous() }
}

function onSourceChange(event: Event): void {
  invalidateInterruptionOwnership()
  void props.store.setSourceOverride((event.target as HTMLSelectElement).value || undefined)
}

function pauseForInterruption(): PlaybackPauseLease | undefined {
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

function assignDeck(index: number, deck: AudioDeck): void {
  const outgoing = audioDecks.value[index]
  if (outgoing.src && (outgoing.src !== deck.src || outgoing.trackId !== deck.trackId)) {
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
  assignDeck(index, emptyDeck())
}

function standbyDeckIndex(): number {
  return activeDeckIndex.value === 0 ? 1 : 0
}

function syncPreparedDeck(): void {
  const prepared = props.store.preparedNext.value
  const standbyIndex = standbyDeckIndex()
  // An early speculative resolve does not start a media fetch. The standby URL is assigned only
  // after the lead-window arm, while the preparation's transient ticket is still fresh.
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
  if (props.store.preloadPolicy.value === 'none') {
    clearDeck(standbyIndex)
    return
  }
  void nextTick(() => {
    const latest = props.store.preparedNext.value
    // A *stale* preparation must not hold the standby deck open: its URL is no longer usable, so
    // treat it the same as no preparation at all.
    if ((latest?.armed && isPreparationFresh(latest)) || props.store.preloadHandoff.value) return
    const standby = audioDecks.value[standbyDeckIndex()]
    if (props.store.currentTrack.value?.id === standby.trackId && props.store.status.value === 'resolving') return
    clearDeck(standbyDeckIndex())
  })
}

function syncActiveDeck(): void {
  const playable = props.store.playable.value
  if (playable?.kind !== 'audio') {
    clearDeck(activeDeckIndex.value)
    return
  }
  const generation = props.store.playbackGeneration.value
  const trackId = props.store.currentTrack.value?.id ?? ''
  const handoff = props.store.preloadHandoff.value
  const promotedIndex = handoff && handoff.generation === generation && handoff.track.id === trackId &&
    handoff.playable.url === playable.url
    ? audioDecks.value.findIndex((deck) =>
      deck.preparationId === handoff.id && deck.trackId === trackId && deck.src === playable.url)
    : -1
  if (promotedIndex >= 0) {
    const previousActive = activeDeckIndex.value
    activeDeckIndex.value = promotedIndex
    assignDeck(promotedIndex, {
      ...audioDecks.value[promotedIndex], generation, preload: 'metadata', preparationId: undefined,
    })
    if (previousActive !== promotedIndex) clearDeck(previousActive)
    props.store.releasePreloadHandoff(generation)
    return
  }
  const activeIndex = activeDeckIndex.value
  const currentDeck = audioDecks.value[activeIndex]
  if (
    currentDeck.src === playable.url && currentDeck.trackId === trackId &&
    currentDeck.generation === generation
  ) return
  const coldIndex = standbyDeckIndex()
  activeDeckIndex.value = coldIndex
  assignDeck(coldIndex, {
    generation, mimeType: playable.mimeType, preload: 'metadata', src: playable.url, trackId,
  })
  clearDeck(activeIndex)
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
  if (activeDeckEvent(index, event)) mediaPresentationHandlers.value.update(event, index)
}

function onDeckState(index: number, event: Event, state: PlaybackMediaState): void {
  if (!activeDeckEvent(index, event)) {
    if (state === 'playing' && event.currentTarget instanceof HTMLAudioElement) event.currentTarget.pause()
    return
  }
  if (state === 'ended') mediaStateHandlers.value.ended()
  else mediaStateHandlers.value[state]()
}

function onDeckPlay(index: number, event: Event): void {
  if (activeDeckEvent(index, event)) nativePlayCommandHandler.value()
  else if (event.currentTarget instanceof HTMLAudioElement) event.currentTarget.pause()
}

function onDeckError(index: number, event: Event): void {
  if (activeDeckEvent(index, event)) void playbackFailureHandler.value()
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

function updateMediaPresentation(element: HTMLAudioElement): void {
  duration.value = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0
  seekable.value = element.seekable.length > 0
  const elapsed = Number.isFinite(element.currentTime) ? Math.max(0, element.currentTime) : 0
  currentTime.value = duration.value > 0 ? Math.min(elapsed, duration.value) : elapsed
  armNextTrackIfDue()
}

/**
 * Ask the store to prepare the next track once the active track is inside the preload lead window.
 *
 * Driven from media progress rather than from the track change, because the resolved media URL
 * carries a ticket with a 30 second lifetime: resolving at the start of a multi-minute track would
 * produce a URL that has already expired by the time the track is promoted. `armNextPreparation` is
 * a no-op while a fresh preparation exists, so calling it on every progress tick is cheap.
 */
function armNextTrackIfDue(): void {
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
    updateMediaPresentation(element)
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
      updateMediaPresentation(element)
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

async function reportFailure(providerId?: string, generation = props.store.playbackGeneration.value): Promise<void> {
  if (providerId) await props.store.reportPlaybackFailure(providerId, generation)
}

function syncVolume(volume: number): void {
  if (audio.value) audio.value.volume = volume
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

function handleMediaEnded(generation: number): void {
  if (generation !== props.store.playbackGeneration.value) return
  if (props.store.repeatMode.value === 'off') {
    if (props.store.currentIndex.value + 1 >= props.store.queue.value.length) reportMediaState('ended', generation)
    else { invalidateInterruptionOwnership(); void props.store.next() }
    return
  }
  if (props.store.repeatMode.value === 'one') {
    const element = audio.value
    // A fully buffered deck can replay without minting a new transient media ticket.
    if (element && Number.isFinite(element.duration) && element.duration > 0 &&
      element.buffered.length === 1 && element.buffered.start(0) <= 0.05 && element.buffered.end(0) >= element.duration - 0.25) {
      element.currentTime = 0
      void element.play().catch(() => { void props.store.advanceAfterEnded() })
      return
    }
  }
  invalidateInterruptionOwnership()
  void props.store.advanceAfterEnded()
}

function reportNativePlayCommand(generation: number): void {
  if (
    generation === props.store.playbackGeneration.value &&
    activeTimerPauseLease
  ) invalidateInterruptionOwnership()
}

watch(
  () => props.store.preparedNext.value,
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
  () => props.store.volume.value,
  (volume) => {
    if (volume > 0) lastAudibleVolume.value = volume
    syncVolume(volume)
  },
  { immediate: true },
)
// The volume watcher runs before template refs exist on an initial mount.
watch(audio, (element) => {
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
    if (audio.value) {
      syncVolume(props.store.volume.value)
      if (props.store.playbackIntent.value === 'playing') await play(generation, providerId)
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
    else if (mediaState) reportMediaState(mediaState, generation)
  }
})

onMounted(() => {
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
  window.addEventListener('online', updateConnectivity)
  window.addEventListener('offline', updateConnectivity)
  connection()?.addEventListener?.('change', updateConnectivity)
})

onBeforeUnmount(() => {
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
    class="player-bar liquid-shell"
    :class="{ 'player-bar--compact': compact, 'player-bar--collapsed': collapsed }"
    :data-player-compact="compact ? '' : undefined"
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
          v-if="deck.src"
          v-show="false"
          ref="audioDeckElements"
          :data-audio-deck="deckIndex"
          :data-audio-role="deckIndex === activeDeckIndex ? 'active' : 'standby'"
          :muted="deckIndex !== activeDeckIndex"
          :data-playback-generation="deck.generation"
          :data-track-id="deck.trackId"
          :preload="deck.preload"
          :src="deck.src"
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
            :aria-label="text(store.playbackIntent.value === 'playing' ? 'player.pause' : 'player.play')"
            @click="toggle"
          >
            <Pause v-if="store.playbackIntent.value === 'playing'" :size="24" aria-hidden="true" />
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
