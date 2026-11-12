import { computed, ref, shallowRef, watch, type Ref } from 'vue'

import type { Track } from '../catalog/types'
import { resolveTrack, type ResolveOptions, type ResolveResult } from './resolver'
import { isProviderEligible, ProviderRegistry, type ProviderRegistrationSnapshot } from './providers/registry'
import type { Playable, ProviderAttempt } from './providers/types'
import type { PreloadPolicy } from './preloadPolicy'
import { isTransitionMode, transitionDuration, type TransitionMode } from './transitionEngine'
import { playbackPresentationFor } from './presentation'
import { recordPlayback } from './playbackLog'

/** One provider resolve attempt in the debug log (task 41.8). The source name is untrusted, so only its id is kept. */
function recordAttempt(type: string, attempt: ProviderAttempt, context: Record<string, unknown>): void {
  recordPlayback(type, {
    ...context,
    providerId: attempt.providerId,
    sourceId: attempt.sourceId ?? null,
    ok: attempt.ok,
    code: attempt.code ?? null,
    latencyMs: attempt.latencyMs,
    transient: attempt.transient === true,
  })
}

export interface TrackPreparation {
  id: number
  track: Track
  providerId: string
  playable: Extract<Playable, { kind: 'audio' }>
  generation: number
  /** Selection fingerprint prevents reusing a fallback after provider preferences change. */
  selectionKey?: string
  /**
   * Epoch milliseconds at which preparation began (a conservative ticket-age estimate).
   *
   * A resolved media URL is a Worker-minted transient ticket whose token is random per resolve
   * (`workers/providers/transientMedia.ts`), so a preparation cannot be reused indefinitely. This
   * timestamp is what lets the transition reuse a preparation that is still valid and fall back to
   * a fresh resolve when it is not.
   */
  preparedAt: number
  /** Set only once playback enters the bounded lead window. */
  armed: boolean
  /** Kept private during preloading and shown only if this track is promoted. */
  attempts?: readonly ProviderAttempt[]
}

export type PlaybackStatus = 'idle' | 'resolving' | 'ready' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'
export type PlaybackIntent = 'playing' | 'paused'
export type PlaybackMediaState = 'ready' | 'playing' | 'paused' | 'buffering' | 'ended'
export type ResolveTrack = (track: Track, registry: ProviderRegistry, options?: ResolveOptions) => Promise<ResolveResult>

/**
 * What `failCurrent` decided for a current track that cannot continue on its current source.
 *
 * - `stale`: the failure belongs to an older request or generation and changed nothing.
 * - `continuing`: another automatic provider is being resolved for the same track at the same position.
 * - `waiting`: the store waits (offline, the registry has not loaded yet, or every failure was
 *   transient, task 41.7) and retries on its own.
 * - `skipped`: an automatic skip to another queued track was scheduled.
 * - `halted`: playback stays on the track with `status = 'error'`; only here may the view pause the element.
 */
export type FailureOutcome = 'stale' | 'continuing' | 'waiting' | 'skipped' | 'halted'

/**
 * What a same-position source recovery did: `recovered` when a fresh URL now plays the track at the
 * saved position, otherwise the `failCurrent` outcome (`stale` when nothing was attempted or the
 * stream resumed by itself).
 */
export type RecoveryOutcome = 'recovered' | FailureOutcome

/** Why the current track failed; decides which of the `failCurrent` steps apply. */
export type FailureOrigin =
  | 'resolve' | 'runtime' | 'recovery' | 'recoveryResume' | 'media' | 'stall' | 'playRejected'
  | 'userPlay' | 'manualOverride' | 'registry' | 'offline'

export interface FailureContext {
  /** The `requestId` the failing work ran under. */
  request: number
  /** The `playbackGeneration` the failing work ran under. */
  generation: number
  /** The provider that failed, when the failure is attributable to one. */
  providerId?: string
  /** The presented position to continue from, in seconds. */
  position?: number
  /** Whether a Jellyfin recovery was already tried at this position. */
  triedJellyfin?: boolean
}

/** Who asked for a resolve of the current track. */
export type ResolveOrigin = 'auto' | 'userPlay' | 'manualOverride'

/** Kinds of playback notice; each is shown with the `player.notice.<kind>` message. */
export type PlaybackNoticeKind =
  | 'skipped' | 'queueUnplayable' | 'waitingForNetwork' | 'sourcesUnavailable' | 'trackFailed' | 'tapToResume'

/**
 * A step of the handover recovery ladder (P96-06): (a) `srcSwap` plays the new URL on the element
 * that played the previous track, (b) `reResolve` renews the same provider at the same position
 * when the ticket is below HANDOVER_TICKET_MARGIN_MS, (c) `notice` adds the tap-to-resume notice.
 */
export type HandoverStep = 'srcSwap' | 'reResolve' | 'notice'

/** Set while an adopted preparation has not yet shown `currentTime` progress (P96-06). */
export interface AwaitingStart {
  generation: number
  /** The position the handed-over track starts from, in seconds. */
  startPosition: number
}

/** A dismissible message about a playback decision the listener did not make (P96-04). */
export interface PlaybackNotice {
  /** Unique within the store; pass to `dismissNotice`. */
  id: number
  kind: PlaybackNoticeKind
  trackId?: string
  title?: string
  /** The provider the notice is about, for `trackFailed` under a manual source. */
  source?: string
  /** Epoch milliseconds at which the notice was added. */
  time: number
}

/** The evidence of an automatically skipped track, kept after the queue moves on (Property 28). */
export interface RecentFailure {
  trackId: string
  title: string
  origin: FailureOrigin
  attempts: readonly ProviderAttempt[]
  /** Epoch milliseconds at which the track was skipped. */
  time: number
}

export interface PlaybackStoreOptions {
  /** A synchronously current registry, or undefined when refresh/revalidation is required. */
  peekRegistry?: () => ProviderRegistry | undefined
  loadRegistry?: (options?: {
    forceRefresh?: boolean
  }) => Promise<ProviderRegistry>
  registry?: ProviderRegistry
  resolve?: ResolveTrack
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  random?: () => number
  /**
   * How long a resolved next-track preparation may be reused, in milliseconds.
   *
   * Defaults to {@link PREPARATION_VALIDITY_MS}. It exists as a seam so a caller (or a test) can
   * force the stale-preparation path without waiting, and so a deployment with a different ticket
   * lifetime has one place to say so.
   */
  preparationValidityMs?: number
}

export interface PlaybackStore {
  shuffle: Readonly<Ref<boolean>>
  repeatMode: Readonly<Ref<RepeatMode>>
  setShuffle(enabled: boolean): void
  cycleRepeatMode(): void
  setRepeatMode(mode: RepeatMode): void
  replaceQueueSource(tracks: readonly Track[]): void
  advanceAfterEnded(): Promise<void>
  /** Adopt only a prepared immediate next track without crossing an async boundary. */
  tryAdvancePreparedAfterEnded(generation: number): boolean
  preparedNext: Readonly<Ref<TrackPreparation | null>>
  preloadHandoff: Readonly<Ref<TrackPreparation | null>>
  preloadPolicy: Readonly<Ref<PreloadPolicy>>
  setPreloadPolicy(policy: PreloadPolicy): void
  invalidatePreload(): void
  /** Reject only the failed standby load; its next selection must resolve a fresh source. */
  rejectNextPreparation(preparationId: number): void
  releasePreloadHandoff(generation: number): void
  /**
   * Prepare the immediate next queued track for the provider the current mode would actually use.
   *
   * Called by the player once the active track is close enough to its end that the resolved media
   * URL will still be valid when promoted. The same enabled provider chain handles active and
   * prepared tracks; no eager provider-specific warm-up spends requests before this window.
   *
   * A no-op when a preparation for that track is already fresh, so it is safe to call repeatedly
   * from a progress handler.
   */
  armNextPreparation(): Promise<void>
  prepareTransition(index: number): Promise<void>
  canHandoffPreparation(id: number): boolean
  rejectPreparation(id: number): void
  nextPreparationIndex: Readonly<Ref<number>>
  transitionMode: Readonly<Ref<TransitionMode>>
  crossfadeDuration: Readonly<Ref<number>>
  setTransitionMode(mode: TransitionMode): void
  setCrossfadeDuration(seconds: number): void
  dispose(): void
  activeProviderId: Readonly<Ref<string | undefined>>
  attempts: Readonly<Ref<readonly ProviderAttempt[]>>
  /** Only the current track's newest resolution, separate from retained recovery evidence. */
  latestAttempts: Readonly<Ref<readonly ProviderAttempt[]>>
  currentIndex: Readonly<Ref<number>>
  currentTrack: Readonly<Ref<Track | undefined>>
  enabledProviderIds: Readonly<Ref<readonly string[]>>
  manualProviderIds: Readonly<Ref<readonly string[]>>
  automaticProviderIds: Readonly<Ref<readonly string[]>>
  playbackIntent: Readonly<Ref<PlaybackIntent>>
  playbackGeneration: Readonly<Ref<number>>
  /** Changes on track selection/replay, but survives same-track source recovery. */
  listeningSessionId: Readonly<Ref<number>>
  playable: Readonly<Ref<Playable | null>>
  pendingResumePosition: Readonly<Ref<number | undefined>>
  queue: Readonly<Ref<readonly Track[]>>
  sourceOverride: Readonly<Ref<string | undefined>>
  status: Readonly<Ref<PlaybackStatus>>
  volume: Readonly<Ref<number>>
  enqueue(track: Track): void
  removeQueueIndex(index: number): boolean
  moveQueueItem(from: number, to: number): boolean
  playNext(track: Track): void
  clearUpcomingQueue(): void
  reconcileUpcomingQueue(filteredTracks: readonly Track[]): void
  refreshQueuedTracks(filteredTracks: readonly Track[]): void
  next(): Promise<void>
  pause(): void
  play(): Promise<void>
  playNow(track: Track): Promise<void>
  prepareQueueIndex(index: number): Promise<void>
  playQueueIndex(index: number, stillNeeded?: () => boolean): Promise<void>
  previous(): Promise<void>
  reportMediaState(state: PlaybackMediaState, generation: number): void
  /**
   * Presented `currentTime` of the active element. Ends the starting state of a handover once it
   * passes the start position, and only then reports `playing` (P96-06). A discontinuity
   * resets the observation baseline and cancels an awaited queue selection, without counting
   * a seek as playback progress.
   */
  reportProgress(currentTime: number, generation: number, discontinuity?: boolean): void
  /** Set from a handover until the first `currentTime` progress (P96-06). */
  awaitingStart: Readonly<Ref<AwaitingStart | undefined>>
  /**
   * Run one handover ladder step for `generation` (P96-06). `srcSwap` and `reResolve` count toward
   * the skip-run bound and return false at the bound; `reResolve` also returns false while the
   * ticket keeps at least HANDOVER_TICKET_MARGIN_MS of life. `notice` adds the tap-to-resume notice,
   * keeps intent `playing` and leaves `status = 'paused'`.
   */
  recoverHandover(step: HandoverStep, generation: number): Promise<boolean>
  /** Same-position renewal and automatic provider chain; optional for older store adapters. */
  requestSourceRecovery?(currentProviderId: string, generation: number, positionSeconds: number, stillStalled?: () => boolean): Promise<RecoveryOutcome>
  /** Boolean view of {@link requestJellyfinRecovery}: true only for `recovered`. */
  requestJellyfinFallback(currentProviderId: string, generation: number, positionSeconds: number, stillStalled?: () => boolean): Promise<boolean>
  /** Same-position Jellyfin recovery; returns `recovered` or the `failCurrent` outcome. */
  requestJellyfinRecovery(currentProviderId: string, generation: number, positionSeconds: number, stillStalled?: () => boolean): Promise<RecoveryOutcome>
  /** The registry snapshot and the providers failed at this position, for {@link jellyfinUsable}. */
  registrySnapshot(): { registry: ProviderRegistry; failedProviderIds: readonly string[] }
  consumePendingResumePosition(): number | undefined
  /** A runtime failure of the active provider; returns the `failCurrent` outcome. */
  reportPlaybackFailure(providerId: string, generation: number): Promise<FailureOutcome>
  /**
   * Re-resolve the current track through the same provider after a media error, keeping the
   * position. Returns false when no renewal was made, so the caller can fall back to the normal
   * failure path. `stillNeeded` rejects stale stall recovery after progress or interruption.
   */
  renewMedia(providerId: string, generation: number, stillNeeded?: () => boolean): Promise<boolean>
  setSourceOverride(providerId?: string): Promise<void>
  setVolume(value: number): void
  stop(): void
  /** Notices about automatic skips, waits and failures, oldest first (P96-04). */
  playbackNotices: Readonly<Ref<readonly PlaybackNotice[]>>
  dismissNotice(id: number): void
  /**
   * Add a notice the view detects itself (the browser refused a start, D29). Attached to the
   * current track; replaces an earlier notice of the same kind for that track.
   */
  addPlaybackNotice(kind: 'tapToResume'): void
  /** The latest automatically skipped tracks with their attempts, at most MAX_RECENT_FAILURES. */
  recentFailures: Readonly<Ref<readonly RecentFailure[]>>
}

export type RepeatMode = 'off' | 'all' | 'one'
const SHUFFLE_KEY = 'hoyomix-player-shuffle-v1'
const REPEAT_KEY = 'hoyomix-player-repeat-v1'

export function shuffleTracks<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index--) {
    const sample = random()
    const target = Math.floor(Math.min(0.9999999999999999, Math.max(0, sample)) * (index + 1))
    ;[result[index], result[target]] = [result[target], result[index]]
  }
  return result
}

const VOLUME_KEY = 'hoyomix-player-volume'

/**
 * How long a resolved next-track preparation stays reusable.
 *
 * Must stay inside the Worker's transient-media ticket lifetime (`TICKET_TTL_MS = 120_000` in
 * `workers/providers/transientMedia.ts`). That ticket is **not** refreshed on use, so promoting a
 * preparation whose ticket has expired would hand the media element a URL that answers
 * `410 preparation_expired`. 100 s leaves a 20 s margin under that ceiling, and covers the 60 s
 * lead window in which the player arms the next track (`NEXT_TRACK_PRELOAD_LEAD_SECONDS`).
 */
export const PREPARATION_VALIDITY_MS = 100_000
/** The Worker's transient media ticket lifetime from the resolve (`TICKET_TTL_MS` in `transientMedia.ts`). */
export const MEDIA_TICKET_TTL_MS = 120_000
/** Minimum ticket life a preparation must have left to be promoted at a handover (P96-06). */
export const HANDOVER_TICKET_MARGIN_MS = 30_000
/** Consecutive unavailable tracks skipped before playback gives up and stays stopped. */
export const MAX_UNAVAILABLE_SKIPS = 10
/** Delays before retrying a registry that has never loaded (D27). */
export const REGISTRY_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000]
/**
 * Delays before the extra fresh resolves of a track whose every recorded failure was transient
 * (task 41.7). Two retries in one listening session of one track; at most 5.5 s of added wait
 * before a track that keeps failing is skipped as before.
 */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [1_500, 4_000]
/** Failure codes that describe the request, not the track: a retry may succeed. */
const TRANSIENT_FAILURE_CODES: ReadonlySet<string> = new Set(['timeout', 'rate_limited'])

/**
 * Whether every recorded failure of a track may succeed on a retry (task 41.7).
 *
 * `not_mapped` entries are ignored (an ineligible provider says nothing about the others); with
 * nothing else recorded the answer is false. A provider that reported sub-source attempts (LX)
 * collapses them into a top-level `unavailable`, so its sub-source codes decide instead. A failure
 * is transient when its code is `timeout` or `rate_limited` or the provider marked it `transient`
 * (a dropped request or a 5xx outage); every other code, including a runtime media failure, is an
 * answer about the track.
 */
export function failuresAreTransient(attempts: readonly ProviderAttempt[]): boolean {
  const failed = attempts.filter((attempt) => !attempt.ok)
  const withSubSources = new Set(failed.filter((attempt) => attempt.sourceId !== undefined).map((attempt) => attempt.providerId))
  const relevant = failed.filter((attempt) => attempt.code !== 'not_mapped' &&
    !(attempt.sourceId === undefined && withSubSources.has(attempt.providerId) && attempt.code === 'unavailable' && !attempt.transient))
  return relevant.length > 0 &&
    relevant.every((attempt) => attempt.transient === true || TRANSIENT_FAILURE_CODES.has(attempt.code ?? ''))
}
/** Failure origins that first try the remaining automatic providers at the same position (Property 25). */
const SAME_POSITION_CHAIN_ORIGINS: ReadonlySet<FailureOrigin> = new Set<FailureOrigin>([
  'recovery', 'recoveryResume', 'media', 'stall', 'playRejected', 'runtime',
])

/**
 * Presented playback progress, in seconds within one listening session, that ends a skip run
 * (D31). A `playing` report alone is not progress: a track can report it and fail at once.
 */
export const PLAYBACK_PROGRESS_RESET_SECONDS = 2
/**
 * A presented-time step larger than this is a seek or a resume jump, not playback progress, so
 * it does not count toward PLAYBACK_PROGRESS_RESET_SECONDS. Media `timeupdate` steps are far smaller.
 */
const PROGRESS_STEP_LIMIT_SECONDS = 5
/** Recent-failures entries kept; the oldest is dropped first (Property 28). */
export const MAX_RECENT_FAILURES = 10
/**
 * Notices kept; the oldest is dropped first. Covers a full skip run (MAX_UNAVAILABLE_SKIPS skip
 * notices plus its terminal notice) with room to spare.
 */
export const MAX_PLAYBACK_NOTICES = 20
/** Minimum spacing between two same-provider media URL renewals. */
export const MEDIA_RENEWAL_INTERVAL_MS = 10_000

/**
 * Whether a resolved preparation is still inside its validity window.
 *
 * Exported because the player view needs the same predicate: a preparation may only be handed to
 * the standby deck while it is fresh, otherwise the deck would start fetching a media URL whose
 * ticket has already expired.
 */
export function isPreparationFresh(
  preparation: TrackPreparation,
  validityMs: number = PREPARATION_VALIDITY_MS,
  now: number = Date.now(),
): boolean {
  const preparedAt = preparation.preparedAt ?? (preparation as unknown as { createdAt?: number }).createdAt ?? 0
  return now - preparedAt <= validityMs && now < effectiveTicketExpiry(preparedAt, preparation.playable.expiresAt)
}

/**
 * Whether a resolved media ticket still has at least HANDOVER_TICKET_MARGIN_MS of life left
 * (the earlier of the provider deadline and the shared TTL). A preparation below the margin is re-resolved at a
 * handover instead of promoted (P96-06).
 */
function effectiveTicketExpiry(resolvedAt: number, expiresAt?: number): number {
  const sharedExpiry = resolvedAt + MEDIA_TICKET_TTL_MS
  if (expiresAt === undefined) return sharedExpiry
  // An explicit but invalid deadline cannot grant the legacy lifetime.
  return Number.isFinite(expiresAt) ? Math.min(sharedExpiry, expiresAt) : Number.NEGATIVE_INFINITY
}

export function hasHandoverTicketMargin(resolvedAt: number, now: number = Date.now(), expiresAt?: number): boolean {
  return effectiveTicketExpiry(resolvedAt, expiresAt) - now >= HANDOVER_TICKET_MARGIN_MS
}

/**
 * Whether a same-position Jellyfin recovery can be attempted for `track` with `registry`.
 *
 * True when a Jellyfin registration is enabled and automatic (`automaticEligible !== false`), is
 * eligible for the track, has not already failed at this position, and is not the active provider.
 * The one predicate shared by the store's recovery and the player view, so both decide alike for
 * the same registry snapshot (Property 19).
 */
export function jellyfinUsable(
  track: Track | undefined,
  registry: ProviderRegistry,
  state: { failedProviderIds?: Iterable<string>; activeProviderId?: string } = {},
): boolean {
  if (!track || state.activeProviderId === 'jellyfin') return false
  if (state.failedProviderIds && [...state.failedProviderIds].includes('jellyfin')) return false
  const jellyfin = registry.enabled().find(({ provider }) => provider.id === 'jellyfin')
  return Boolean(jellyfin && isProviderEligible(jellyfin.provider, track))
}

function initialVolume(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const stored = storage?.getItem(VOLUME_KEY)
    if (stored === null || stored === undefined) return 0.7
    const parsed = Number(stored)
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.7
  } catch {
    return 0.7
  }
}

function browserStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function createPlaybackStore(options: PlaybackStoreOptions = {}): PlaybackStore {
  const staticRegistry = options.registry ?? new ProviderRegistry([])
  const resolver = options.resolve ?? resolveTrack
  const storage = options.storage ?? browserStorage()
  const queue = shallowRef<Track[]>([])
  const random = options.random ?? Math.random
  const stored = (key: string): string | null => { try { return storage?.getItem(key) ?? null } catch { return null } }
  const persist = (key: string, value: string): void => { try { storage?.setItem(key, value) } catch { /* Optional storage. */ } }
  const shuffle = ref(stored(SHUFFLE_KEY) !== 'false')
  const storedRepeat = stored(REPEAT_KEY)
  const repeatMode = ref<RepeatMode>(storedRepeat === 'all' || storedRepeat === 'one' ? storedRepeat : 'off')
  let sourceTracks: readonly Track[] = []
  const manualNextIds = new Set<string>()
  const excludedIds = new Set<string>()
  const currentIndex = ref(-1)
  const playable = shallowRef<Playable | null>(null)
  const activeProviderId = ref<string>()
  const sourceOverride = ref<string>()
  const status = ref<PlaybackStatus>('idle')
  const playbackIntent = ref<PlaybackIntent>('paused')
  const pendingResumePosition = ref<number>()
  const attempts = shallowRef<ProviderAttempt[]>([])
  const latestAttempts = shallowRef<ProviderAttempt[]>([])
  const volume = ref(initialVolume(storage))
  const savedTransition = stored('hoyomix-transition-mode-v1')
  const transitionMode = ref<TransitionMode>(isTransitionMode(savedTransition) ? savedTransition : 'off')
  const savedDuration = stored('hoyomix-crossfade-duration-v1')
  const crossfadeDuration = ref(transitionDuration(savedDuration === null ? 5 : Number(savedDuration)))
  function setTransitionMode(mode: TransitionMode): void {
    if (!isTransitionMode(mode)) return
    transitionMode.value = mode
    persist('hoyomix-transition-mode-v1', mode)
  }
  function setCrossfadeDuration(seconds: number): void {
    crossfadeDuration.value = transitionDuration(seconds)
    persist('hoyomix-crossfade-duration-v1', String(crossfadeDuration.value))
  }
  const enabledProviderIds = shallowRef(
    staticRegistry.selectable().map(({ provider }) => provider.id),
  )
  const automaticProviderIds = shallowRef<readonly string[]>(staticRegistry.enabled().map(({ provider }) => provider.id))
  const manualProviderIds = shallowRef<readonly string[]>([])
  const playbackGeneration = ref(0)
  const listeningSessionId = ref(0)
  let endedListeningSession = false
  const jellyfinFallbackAttempts = new Map<string, AbortController>()
  let recoveryRetryPosition: number | undefined
  let recoveryController: AbortController | undefined
  let sourceRecovery: { generation: number } | undefined
  const renewedSourcePositions = new Map<string, { session: number; position: number }>()
  function cancelRecovery(): void {
    if (recoveryController) {
      for (const [attemptKey, controller] of jellyfinFallbackAttempts) {
        if (controller === recoveryController) jellyfinFallbackAttempts.delete(attemptKey)
      }
    }
    recoveryController?.abort()
    recoveryController = undefined
  }
  const failedProviderIds = new Set<string>()
  const runtimeFailures = shallowRef<ProviderAttempt[]>([])
  let requestId = 0
  /** Listener pause or a newer selection supersedes an awaited preparation validation. */
  let queueSelectionRevision = 0
  let pendingQueueSelection: { revision: number; index: number; track: Track; request: number; generation: number } | undefined
  let resolutionController: AbortController | undefined
  let mediaRenewalController: AbortController | undefined
  function advanceRequest(): number {
    resolutionController?.abort()
    resolutionController = undefined
    latestAttempts.value = []
    return ++requestId
  }
  let preparedQueueSelection = false
  /** The skip run of Property 27: consecutive automatic skips since progress or a listener choice. */
  let unavailableSkips = 0
  /** True once any `loadRegistry` call has succeeded; a static registry counts as loaded. */
  let registryLoadedOnce = options.loadRegistry === undefined
  /** Registry retries scheduled while the registry has never loaded (D27). */
  let registryRetries = 0
  /** The pending registry retry timer (D27); cleared on a new resolve, a queue move, `stop()` and `dispose()`. */
  let registryRetryTimer: ReturnType<typeof setTimeout> | undefined
  /** Transient retries spent on one track in one listening session (task 41.7). */
  let transientRetries: { session: number; trackId: string; count: number } | undefined
  /** The pending transient retry timer (task 41.7); cleared with the other pending retries. */
  let transientRetryTimer: ReturnType<typeof setTimeout> | undefined
  /** The one pending offline retry (D28); its `online` listener is attached only while it is pending. */
  let onlineRetry: { generation: number; trackId: string; intent: PlaybackIntent; position?: number } | undefined
  /**
   * Where an automatic skip returns after a Play Now that appended `trackId` (D26): the index after
   * the entry that was current. Cleared by any other listener queue move, `stop()` and
   * `replaceQueueSource`.
   */
  let playNowReturn: { trackId: string; index: number } | undefined
  /** The last registry snapshot, used by the same-position chain without a refresh (D18). */
  let lastRegistry: ProviderRegistry = staticRegistry
  /** The listening session whose one recovery registry refresh was spent (D18). */
  let recoveryRefreshSession: number | undefined
  /** The same-position chain resolve started by the latest `continuing` outcome. */
  let chainResolution: Promise<void> | undefined
  let renewalsWithoutProgress = 0
  let lastMediaRenewalAt = Number.NEGATIVE_INFINITY
  /** The starting state of a handover (P96-06); only meaningful for its own generation. */
  const awaitingStart = shallowRef<AwaitingStart>()
  /** When the media ticket of the handed-over playable was resolved, for ladder step (b). */
  let handoverTicket: { generation: number; resolvedAt: number; expiresAt?: number } | undefined
  const playbackNotices = shallowRef<PlaybackNotice[]>([])
  /** The last `reportProgress` position of the current generation (task 41 notice auto-clear). */
  let lastProgressReport: { generation: number; time: number } | undefined
  /** A forward step larger than this between two reports is a seek, not playback progress. */
  const PROGRESS_STEP_MAX_SECONDS = 5
  const recentFailures = shallowRef<RecentFailure[]>([])
  let nextNoticeId = 1
  /** Presented progress within one listening session, which ends a skip run (D31). */
  let sessionProgress: { session: number; last?: number; advanced: number } = { session: -1, advanced: 0 }
  let stopProgressWatch: (() => void) | undefined
  const preloadPolicy = ref<PreloadPolicy>('none')
  const preparedNext = shallowRef<TrackPreparation | null>(null)
  const preloadHandoff = shallowRef<TrackPreparation | null>(null)
  const preloadRevision = ref(0)
  let preloadRequest = 0
  let preloadController: AbortController | undefined
  let pendingPreparation: { track: Track; promise: Promise<void> } | undefined
  let preloadMediaFallbackController: AbortController | undefined
  interface PreparationSelection {
    sourceOverride: string | undefined
    registrations: readonly ProviderRegistrationSnapshot[]
    providerIds: readonly string[]
  }
  const preparationSelections = new Map<number, { selection: PreparationSelection }>()
  let disposed = false
  const preparationValidityMs = options.preparationValidityMs ?? PREPARATION_VALIDITY_MS
  /**
   * The (track, generation) the armed preparation was last attempted for.
   *
   * Media progress fires several times a second, so without this a preparation that keeps failing
   * would be retried on every tick for the whole lead window. One attempt per track per playback
   * generation starts the resolver chain. A later media-load failure can advance to a remaining
   * provider once; progress never restarts a failed provider. Keying on the generation means a track change
   * or a manual provider switch naturally re-arms.
   */
  let armedAttempt: { trackId: string; generation: number; mediaFailedProviders: Set<string> } | undefined

  const currentTrack = (): Track | undefined => queue.value[currentIndex.value]
  const currentTrackRef = computed(currentTrack)
  const nextPreparationIndex = computed(() => currentIndex.value < 0 || !currentTrack() ? -1 : repeatMode.value === 'one' ? -1 :
    currentIndex.value + 1 < queue.value.length ? currentIndex.value + 1 :
      repeatMode.value === 'all' && queue.value.length > 1 ? 0 : -1)
  const nextPreparationTrack = () => queue.value[nextPreparationIndex.value]
  function selectionKey(track: Track, registry: ProviderRegistry): string {
    return JSON.stringify([sourceOverride.value ?? null, registry.enabled(sourceOverride.value)
      .filter(({ provider }) => isProviderEligible(provider, track))
      .map(({ provider, priority }) => [provider.id, priority])])
  }
  function rejectPreparation(id: number): void {
    rejectNextPreparation(id)
  }
  function canHandoffPreparation(id: number): boolean {
    const prepared = preparedNext.value
    if (!prepared || prepared.id !== id || prepared.generation !== playbackGeneration.value ||
      sourceOverride.value !== undefined || !preparationIsFresh(prepared) ||
      !hasHandoverTicketMargin(preparationResolvedAt(prepared), Date.now(), prepared.playable.expiresAt)) return false
    const evidence = preparationSelections.get(prepared.id)
    try {
      const registry = options.peekRegistry ? options.peekRegistry() : lastRegistry
      return Boolean(evidence && registry && preparationSelectionsMatch(evidence.selection,
        preparationSelectionFor(prepared.track, registry)))
    } catch { return false }
  }

  function cancelPreloadMediaFallback(): void {
    preloadMediaFallbackController?.abort()
    preloadMediaFallbackController = undefined
  }

  function cancelNextPreparation(): void {
    cancelPreloadMediaFallback()
    preloadRequest += 1
    preloadController?.abort()
    preloadController = undefined
    pendingPreparation = undefined
    preparationSelections.clear()
    preparedNext.value = null
    armedAttempt = undefined
  }

  function rejectNextPreparation(preparationId: number): void {
    const preparation = preparedNext.value
    if (!preparation || preparation.id !== preparationId) return
    recordPlayback('preparation.rejected', {
      trackId: preparation.track.id, providerId: preparation.providerId,
      preparationId, gen: preparation.generation, reason: 'media_error',
    })
    preparationSelections.delete(preparationId)
    preparedNext.value = null
    const attempt = armedAttempt
    if (!preparation.armed || !attempt || attempt.trackId !== preparation.track.id ||
      attempt.generation !== playbackGeneration.value || preparation.generation !== playbackGeneration.value ||
      nextPreparationTrack() !== preparation.track || sourceOverride.value !== undefined ||
      playbackIntent.value !== 'playing' || status.value === 'paused' || preloadPolicy.value !== 'auto' || disposed) return
    // A successful resolve is not a playable source until its media loads. Try each remaining
    // automatic provider once, without retrying failed providers on every progress event.
    attempt.mediaFailedProviders.add(preparation.providerId)
    for (const previous of preparation.attempts ?? []) {
      if (!previous.ok && previous.sourceId === undefined) attempt.mediaFailedProviders.add(previous.providerId)
    }
    const promise = prepareNextTrack(preparation.track, [...attempt.mediaFailedProviders], true)
    const pending = { track: preparation.track, promise }
    pendingPreparation = pending
    void promise.finally(() => { if (pendingPreparation === pending) pendingPreparation = undefined })
  }

  function invalidatePreload(): void {
    recordPlayback('preparation.invalidated', { reason: 'preferences' })
    preloadHandoff.value = null
    preloadRevision.value += 1
  }

  function setPreloadPolicy(policy: PreloadPolicy): void {
    if (preloadPolicy.value === policy) return
    recordPlayback('preparation.policyChanged', { from: preloadPolicy.value, to: policy })
    const prepared = preparedNext.value
    const preservePrepared = preloadPolicy.value !== 'none' && policy !== 'none' &&
      prepared?.armed === true && preparationIsFresh(prepared)
    preloadPolicy.value = policy
    if (!preservePrepared) {
      preloadHandoff.value = null
      preloadRevision.value += 1
    }
  }

  function releasePreloadHandoff(generation: number): void {
    if (generation === playbackGeneration.value) preloadHandoff.value = null
  }

  /**
   * Whether a preparation may still be handed to the media element.
   *
   * A stale preparation is not merely useless: its media URL carries a ticket that has already
   * expired, so promoting it would produce a `410` instead of playback. Falling back to a fresh
   * resolve is always correct, just slower, which is why the check is a hard gate rather than a
   * preference.
   */
  const preparationIsFresh = (preparation: TrackPreparation): boolean =>
    isPreparationFresh(preparation, preparationValidityMs)
  const preparationResolvedAt = (preparation: TrackPreparation): number =>
    preparation.preparedAt ?? (preparation as unknown as { createdAt?: number }).createdAt ?? 0

  function clearAwaitingStart(): void {
    if (awaitingStart.value) awaitingStart.value = undefined
    handoverTicket = undefined
  }

  /**
   * The provider the immediate next track would play through under the current mode.
   *
   * Manual mode is strict: the override is returned only when it is registered and eligible for
   * that track, so a manual choice can never be replaced by another provider. Automatic mode
   * returns the first eligible provider in the registry's own automatic order. It names the first
   * attempt only: an armed preparation may also use a later provider after verified failures.
   *
   * The final declared-binding fallback is retained only for an injected resolver with no registry
   * configuration. A configured registry must supply the eligible order itself.
   */
  function targetProviderFor(track: Track, registry: ProviderRegistry): string | undefined {
    const override = sourceOverride.value
    if (override) {
      const registration = registry.selectable().find(({ provider }) => provider.id === override)
      if (registration) return isProviderEligible(registration.provider, track) ? override : undefined
      return !options.registry && !options.loadRegistry && track.sources.some(({ provider }) => provider === override) ? override : undefined
    }
    const automatic = registry.enabled().find(({ provider }) => isProviderEligible(provider, track))
    if (automatic) return automatic.provider.id
    return !options.registry && !options.loadRegistry ? track.sources[0]?.provider : undefined
  }

  function preparationSelectionFor(track: Track, registry: ProviderRegistry): PreparationSelection {
    const registrations = registry.enabled(sourceOverride.value)
    const providerIds = registrations.filter(({ provider }) => isProviderEligible(provider, track))
      .map(({ provider }) => provider.id)
    // Preserve the existing declared-binding seam for a resolver supplied without registrations.
    const target = options.resolve && !options.registry && !options.loadRegistry ? targetProviderFor(track, registry) : undefined
    return { sourceOverride: sourceOverride.value, registrations, providerIds: providerIds.length ? providerIds : target ? [target] : [] }
  }

  function preparationSelectionsMatch(left: PreparationSelection, right: PreparationSelection): boolean {
    return left.sourceOverride === right.sourceOverride &&
      left.providerIds.length === right.providerIds.length && left.providerIds.every((id, i) => id === right.providerIds[i]) &&
      left.registrations.length === right.registrations.length && left.registrations.every((entry, i) => {
        const other = right.registrations[i]
        return entry.provider === other.provider && entry.priority === other.priority &&
          entry.timeoutMs === other.timeoutMs && entry.automaticEligible === other.automaticEligible
      })
  }

  async function preparationCanBeReused(preparation: TrackPreparation, track: Track): Promise<boolean> {
    const evidence = preparationSelections.get(preparation.id)
    const rejected = (reason: string): false => {
      recordPlayback('preparation.reuseRejected', {
        id: preparation.id, trackId: track.id, preparationGen: preparation.generation,
        gen: playbackGeneration.value, ageMs: Date.now() - preparationResolvedAt(preparation), reason,
      })
      return false
    }
    if (!evidence) return rejected('missing-evidence')
    if (preparation.track !== track) return rejected('track-identity')
    if (preparation.generation !== playbackGeneration.value) return rejected('generation')
    if (!preparationIsFresh(preparation)) return rejected('expired')
    try {
      // The repository returns its cached registry unless preferences/config have changed. Re-read
      // at the reuse boundary so a disabled provider cannot be adopted via a stale lastRegistry.
      const registry = options.loadRegistry ? await options.loadRegistry() : staticRegistry
      const selection = preparationSelectionFor(track, registry)
      if (preparedNext.value?.id !== preparation.id) return rejected('superseded')
      if (preparation.generation !== playbackGeneration.value) return rejected('generation-after-registry')
      if (preparationSelections.get(preparation.id) !== evidence) return rejected('evidence-changed')
      if (!preparationIsFresh(preparation)) return rejected('expired-after-registry')
      if (!hasHandoverTicketMargin(preparationResolvedAt(preparation), Date.now(), preparation.playable.expiresAt)) return rejected('ticket-margin-after-registry')
      if (!preparationSelectionsMatch(evidence.selection, selection)) return rejected('provider-selection')
      return true
    } catch {
      return rejected('registry-error')
    }
  }

  /** Resolve only inside the lead window or an explicit transition, using the eligible chain. */
  async function prepareNextTrack(
    track: Track, failedMediaProviders: readonly string[] = [], requirePlaying = false,
  ): Promise<void> {
    const identity = ++preloadRequest
    const generation = playbackGeneration.value
    const startedAt = Date.now()
    const controller = new AbortController()
    preloadController = controller
    if (requirePlaying) preloadMediaFallbackController = controller
    preparedNext.value = null
    preparationSelections.clear()
    const selectionRevision = queueSelectionRevision
    const stillRelevant = () => !requirePlaying || (!disposed && selectionRevision === queueSelectionRevision && playbackIntent.value === 'playing' && status.value !== 'paused' &&
      generation === playbackGeneration.value && nextPreparationTrack() === track &&
      preloadPolicy.value === 'auto' && sourceOverride.value === undefined)
    const observedAttempts: ProviderAttempt[] = []
    const observe = (attempt: ProviderAttempt) => {
      observedAttempts.push(attempt)
      recordAttempt('preparation.attempt', attempt, { trackId: track.id, speculative: false })
    }
    try {
      const registry = options.loadRegistry ? registryLoaded(await options.loadRegistry()) : staticRegistry
      if (controller.signal.aborted || identity !== preloadRequest || !stillRelevant()) return

      const selection = preparationSelectionFor(track, registry)
      const candidates = selection.providerIds.filter(id => !failedMediaProviders.includes(id))
      const targetProvider = candidates[0]
      if (!targetProvider) return

      const activeIds = registry.enabled().map(({ provider }) => provider.id)
      const strictProvider = selection.sourceOverride
      const excludeProviderIds = strictProvider ? [...new Set([
        ...activeIds.filter((id) => id !== targetProvider),
        ...track.sources.map((s) => s.provider).filter((id) => id !== targetProvider),
      ])] : failedMediaProviders.length ? [...failedMediaProviders] : undefined
      recordPlayback('preparation.started', { trackId: track.id, targetProvider })
      const key = selectionKey(track, registry)
      const result = await resolver(track, registry, {
        signal: controller.signal,
        sourceOverride: strictProvider,
        excludeProviderIds,
        onAttempt: observe,
      })
      if (controller.signal.aborted || identity !== preloadRequest || !stillRelevant()) return
      if (observedAttempts.length === 0) {
        for (const attempt of result.attempts) recordAttempt('preparation.attempt', attempt, { trackId: track.id, speculative: false })
      }
      recordPlayback('preparation.resolve', {
        trackId: track.id, targetProvider, ok: result.ok,
        providerId: result.ok ? result.providerId : null, kind: result.ok ? result.playable.kind : null,
        latencyMs: Date.now() - startedAt,
      })
      if (result.ok && result.playable.kind === 'audio') {
        const providerIndex = candidates.indexOf(result.providerId)
        const summaries = result.attempts.filter(({ providerId }) => candidates.includes(providerId))
        // A fallback is reusable only with the resolver's ordered failure summaries. Sub-source
        // callbacks remain private diagnostics, and cannot stand in for a provider-level failure.
        const matches = strictProvider ? result.providerId === strictProvider : providerIndex >= 0 &&
          (providerIndex === 0 || (summaries.length === providerIndex + 1 && summaries.every((attempt, i) =>
            attempt.providerId === candidates[i] && attempt.ok === (i === providerIndex))))
        if (!matches) return
        preparationSelections.set(identity, { selection })
        preparedNext.value = {
          id: identity, track, providerId: result.providerId, playable: result.playable, generation,
          // Start time is conservative even if registry/provider resolution was slow.
          preparedAt: startedAt, selectionKey: key, armed: true,
          attempts: observedAttempts.length ? [...observedAttempts] : [...result.attempts],
        }
      }
    } catch {
      recordPlayback('preparation.failed', { trackId: track.id, cancelled: controller.signal.aborted })
    } finally {
      if (preloadController === controller) preloadController = undefined
      if (preloadMediaFallbackController === controller) preloadMediaFallbackController = undefined
    }
  }

  async function armNextPreparation(): Promise<void> {
    await prepareTransition(nextPreparationIndex.value)
  }

  async function prepareTransition(index: number): Promise<void> {
    if (disposed || preloadPolicy.value !== 'auto' || !isQueueIndex(index)) return
    const track = queue.value[index]
    if (index === currentIndex.value || !currentTrack() || !playable.value) return
    const generation = playbackGeneration.value
    const request = preloadRequest
    const stillCurrent = () => !disposed && generation === playbackGeneration.value &&
      queue.value[index] === track && preloadPolicy.value === 'auto' && request === preloadRequest
    const reuse = async (preparation: TrackPreparation): Promise<boolean> => {
      const valid = hasHandoverTicketMargin(preparationResolvedAt(preparation), Date.now(), preparation.playable.expiresAt) &&
        await preparationCanBeReused(preparation, track)
      if (!stillCurrent()) return false
      if (valid && preparedNext.value?.id === preparation.id) {
        if (!preparedNext.value.armed) preparedNext.value = { ...preparation, armed: true }
        return true
      }
      if (preparedNext.value?.id === preparation.id) {
        preparationSelections.delete(preparation.id)
        preparedNext.value = null
      }
      return false
    }
    const inFlight = pendingPreparation
    if (inFlight?.track === track) {
      await inFlight.promise
      if (!stillCurrent()) return
      const finished = preparedNext.value
      if (finished && await reuse(finished)) return
      if (!stillCurrent()) return
    } else {
      const existing = preparedNext.value
      if (existing && await reuse(existing)) return
      if (!stillCurrent()) return
    }
    if (armedAttempt?.trackId === track.id && armedAttempt.generation === generation) return
    preloadController?.abort()
    armedAttempt = { trackId: track.id, generation, mediaFailedProviders: new Set() }
    const promise = prepareNextTrack(track)
    const pending = { track, promise }
    pendingPreparation = pending
    try { await promise } finally { if (pendingPreparation === pending) pendingPreparation = undefined }
  }

  const stopPreloadWatch = watch([
    currentIndex, currentTrackRef, nextPreparationTrack,
    () => playable.value !== null,
    sourceOverride, preloadRevision,
  ], cancelNextPreparation, { flush: 'sync' })

  function dispose(): void {
    cancelRecovery()
    cancelPendingRetries()
    disposed = true
    advanceRequest()
    stopPreloadWatch()
    stopProgressWatch?.()
    cancelNextPreparation()
    preloadHandoff.value = null
  }

  /**
   * Remember a successfully loaded registry. Kept synchronous and applied right after the caller's
   * own `await`, so loading adds no microtask turn to the existing resolve paths.
   */
  function registryLoaded(registry: ProviderRegistry): ProviderRegistry {
    registryLoadedOnce = true
    registryRetries = 0
    lastRegistry = registry
    removeNotices('sourcesUnavailable')
    return registry
  }

  interface ResolveCurrentOptions {
    forceRefresh?: boolean
    position?: number
    origin?: ResolveOrigin
  }

  async function resolveCurrent(resolveOptions: ResolveCurrentOptions = {}): Promise<void> {
    const { forceRefresh = false, position: resumePosition, origin = 'auto' } = resolveOptions
    const failureOrigin: FailureOrigin = origin === 'auto' ? 'resolve' : origin
    renewalsWithoutProgress = 0
    clearAwaitingStart()
    cancelRecovery()
    // A new resolve supersedes any waiting retry; a failure here arms a fresh one.
    cancelPendingRetries()
    pendingResumePosition.value = resumePosition
    const track = currentTrack()
    if (!track) return
    const thisRequest = advanceRequest()
    const controller = new AbortController()
    resolutionController = controller
    // Sync deck observers must not see the previous playable under a new source generation.
    status.value = 'resolving'
    playable.value = null
    activeProviderId.value = undefined
    playbackGeneration.value += 1
    const thisGeneration = playbackGeneration.value
    const fail = (failOrigin: FailureOrigin = failureOrigin): FailureOutcome =>
      failCurrent(failOrigin, { request: thisRequest, generation: thisGeneration, position: resumePosition })
    attempts.value = [...runtimeFailures.value]
    const observedAttempts: ProviderAttempt[] = []
    const overrideAttempts: ProviderAttempt[] = []
    // One live array backs both the resolver's top-level attempts and the composite LX
    // provider's per-sub-source attempts, so diagnostics render them in emission order.
    const observeAttempt = (attempt: ProviderAttempt): void => {
      recordAttempt('resolve.attempt', attempt, { gen: thisGeneration, trackId: track.id, origin })
      observedAttempts.push(attempt)
      if (thisRequest === requestId) {
        attempts.value = [...runtimeFailures.value, ...overrideAttempts, ...observedAttempts]
        latestAttempts.value = [...overrideAttempts, ...observedAttempts]
      }
    }

    let activeRegistry: ProviderRegistry
    try {
      activeRegistry = options.loadRegistry
        ? registryLoaded(await options.loadRegistry({ forceRefresh }))
        : staticRegistry
    } catch {
      if (thisRequest === requestId) {
        preloadHandoff.value = null
        // Before the first successful load the failure says nothing about the track (D27).
        fail(registryLoadedOnce ? failureOrigin : 'registry')
      }
      return
    }

    try {
      if (thisRequest !== requestId) return

      const enabledIds = activeRegistry.selectable().map(({ provider }) => provider.id)
      enabledProviderIds.value = enabledIds
      automaticProviderIds.value = activeRegistry.enabled().map(({ provider }) => provider.id)
      manualProviderIds.value = activeRegistry.selectableFor(track).map(({ provider }) => provider.id)
      const activeSourceOverride = sourceOverride.value
      const overrideRegistration = activeSourceOverride
        ? activeRegistry.selectable().find(({ provider }) => provider.id === activeSourceOverride)
        : undefined
      const overrideEligible = overrideRegistration
        ? isProviderEligible(overrideRegistration.provider, track)
        : false
      if (activeSourceOverride && !overrideRegistration) {
        overrideAttempts.push({
          providerId: activeSourceOverride,
          ok: false,
          code: 'unavailable',
          latencyMs: 0,
        })
        recordAttempt('resolve.attempt', overrideAttempts[overrideAttempts.length - 1], { gen: thisGeneration, trackId: track.id, origin, override: true })
        attempts.value = [...runtimeFailures.value, ...overrideAttempts]
        latestAttempts.value = [...overrideAttempts]
        fail()
        return
      } else if (
        activeSourceOverride &&
        !overrideEligible
      ) {
        overrideAttempts.push({
          providerId: activeSourceOverride,
          ok: false,
          code: 'not_mapped',
          latencyMs: 0,
        })
        recordAttempt('resolve.attempt', overrideAttempts[overrideAttempts.length - 1], { gen: thisGeneration, trackId: track.id, origin, override: true })
        attempts.value = [...runtimeFailures.value, ...overrideAttempts]
        latestAttempts.value = [...overrideAttempts]
        fail()
        return
      }
      attempts.value = [...runtimeFailures.value, ...overrideAttempts]
      latestAttempts.value = [...overrideAttempts]

      const result = await resolver(track, activeRegistry, {
        signal: controller.signal,
        sourceOverride: activeSourceOverride,
        excludeProviderIds: [...failedProviderIds],
        onAttempt(attempt) {
          observeAttempt(attempt)
        },
      })
      if (thisRequest !== requestId) return
      // The observed trace mirrors `result.attempts` for top-level providers and additionally
      // carries the composite LX provider's per-sub-source entries, which the resolver never
      // sees. A resolver injected through the public `resolve` seam that never calls `onAttempt`
      // still settles from its own returned list.
      const settledAttempts = observedAttempts.length > 0 ? observedAttempts : result.attempts
      if (observedAttempts.length === 0) {
        for (const attempt of result.attempts) recordAttempt('resolve.attempt', attempt, { gen: thisGeneration, trackId: track.id, origin })
      }
      attempts.value = [...runtimeFailures.value, ...overrideAttempts, ...settledAttempts]
      latestAttempts.value = [...overrideAttempts, ...settledAttempts]
      if (!result.ok) {
        recordPlayback('resolve.failed', { gen: thisGeneration, trackId: track.id, origin })
        fail()
        return
      }
      const handoff = preloadHandoff.value
      if (handoff && (handoff.track !== track || handoff.generation !== playbackGeneration.value ||
        result.providerId !== handoff.providerId || result.playable.kind !== 'audio' || result.playable.url !== handoff.playable.url)) {
        preloadHandoff.value = null
      }
      recoveryRetryPosition = undefined
      if (result.playable.kind !== 'audio') pendingResumePosition.value = undefined
      playable.value = result.playable
      activeProviderId.value = result.providerId
      status.value = 'ready'
      recordPlayback('resolve.ok', {
        gen: thisGeneration, trackId: track.id, origin, providerId: result.providerId, kind: result.playable.kind,
        resumePosition: resumePosition ?? null, handoff: Boolean(preloadHandoff.value),
      })
    } catch {
      if (thisRequest === requestId) { preloadHandoff.value = null; fail() }
    } finally {
      if (resolutionController === controller) resolutionController = undefined
    }
  }

  /** Keep a runtime failure of `providerId` so the attempts list and recent failures show it. */
  function appendRuntimeFailure(providerId: string | undefined, _origin: FailureOrigin): void {
    if (!providerId) return
    const failure: ProviderAttempt = { providerId, ok: false, code: 'unavailable', latencyMs: 0 }
    runtimeFailures.value = [...runtimeFailures.value, failure]
  }

  /**
   * Whether this recovery may force a registry refresh: true once per listening session, so a
   * run of failures in one session reuses the snapshot the first refresh produced (D18).
   */
  function takeRecoveryRefresh(): boolean {
    if (recoveryRefreshSession === listeningSessionId.value) return false
    recoveryRefreshSession = listeningSessionId.value
    return true
  }

  /** Wait for the same-position chain resolve a `continuing` outcome started. */
  async function settleChain(outcome: FailureOutcome): Promise<FailureOutcome> {
    if (outcome === 'continuing') await chainResolution
    return outcome
  }

  /** Enabled automatic providers that could still play `track` at this position. */
  function remainingAutomaticProviders(track: Track, failed: ReadonlySet<string>): string[] {
    return lastRegistry.enabled()
      .filter(({ provider }) => !failed.has(provider.id) && isProviderEligible(provider, track))
      .map(({ provider }) => provider.id)
  }

  /**
   * Where an automatic skip goes: the next index, wrapping with Repeat All; -1 when there is none.
   * A track appended by Play Now that is last with Repeat Off returns to the first entry from the
   * Play Now return index that is not the current entry (D26).
   */
  function skipTarget(): number {
    const length = queue.value.length
    const index = currentIndex.value
    if (index + 1 < length) return index + 1
    if (repeatMode.value === 'all') return length > 1 ? 0 : -1
    const playNowEntry = playNowReturn
    if (repeatMode.value === 'off' && playNowEntry && queue.value[index]?.id === playNowEntry.trackId) {
      for (let target = playNowEntry.index; target < length; target += 1) if (target !== index) return target
    }
    return -1
  }

  /**
   * Publish a playback notice (`player.notice.<kind>`). Every `skipped` notice is kept, one per
   * skip (Property 28); any other kind replaces an earlier notice of that kind for the same track,
   * so a repeated wait or failure is announced once and stays current.
   */
  function addNotice(kind: PlaybackNoticeKind, detail: { track?: Track; source?: string } = {}): void {
    const { track, source } = detail
    const kept = kind === 'skipped'
      ? playbackNotices.value
      : playbackNotices.value.filter((notice) => notice.kind !== kind || notice.trackId !== track?.id)
    const notice: PlaybackNotice = {
      id: nextNoticeId++, kind, time: Date.now(),
      ...(track ? { trackId: track.id, title: track.title } : {}),
      ...(source ? { source } : {}),
    }
    playbackNotices.value = [...kept, notice].slice(-MAX_PLAYBACK_NOTICES)
    recordPlayback('notice.add', { kind, trackId: track?.id ?? null, gen: playbackGeneration.value, status: status.value })
  }

  function removeNotices(kind: PlaybackNoticeKind): void {
    if (playbackNotices.value.some((notice) => notice.kind === kind)) {
      playbackNotices.value = playbackNotices.value.filter((notice) => notice.kind !== kind)
      recordPlayback('notice.remove', { kind, gen: playbackGeneration.value })
    }
  }

  function dismissNotice(id: number): void {
    if (playbackNotices.value.some((notice) => notice.id === id)) {
      playbackNotices.value = playbackNotices.value.filter((notice) => notice.id !== id)
    }
  }

  function addPlaybackNotice(kind: 'tapToResume'): void {
    if (kind !== 'tapToResume' || disposed) return
    addNotice(kind, { track: currentTrack() })
  }

  /**
   * Keep a skipped track's evidence after the queue moves on: its attempts, including the
   * runtime failures `startQueueIndex` clears for the next track (at most MAX_RECENT_FAILURES).
   */
  function pushRecentFailure(track: Track | undefined, trackAttempts: readonly ProviderAttempt[], origin: FailureOrigin): void {
    if (!track) return
    const runtime = runtimeFailures.value.filter((failure) => !trackAttempts.includes(failure))
    const entry: RecentFailure = {
      trackId: track.id, title: track.title, origin, attempts: [...runtime, ...trackAttempts], time: Date.now(),
    }
    recentFailures.value = [...recentFailures.value, entry].slice(-MAX_RECENT_FAILURES)
  }

  /**
   * End the skip run once the presented time has advanced by PLAYBACK_PROGRESS_RESET_SECONDS
   * within the current listening session (D31). Backward steps and jumps larger than
   * PROGRESS_STEP_LIMIT_SECONDS (seeks, resume positions) do not count.
   */
  function observeProgress(currentTime: number): void {
    if (disposed || !Number.isFinite(currentTime)) return
    const session = listeningSessionId.value
    if (sessionProgress.session !== session) sessionProgress = { session, advanced: 0 }
    const last = sessionProgress.last
    sessionProgress.last = currentTime
    if (last === undefined || !playable.value) return
    const step = currentTime - last
    if (step <= 0 || step > PROGRESS_STEP_LIMIT_SECONDS) return
    sessionProgress.advanced += step
    if (sessionProgress.advanced >= PLAYBACK_PROGRESS_RESET_SECONDS) unavailableSkips = 0
  }

  function onlineEventTarget(): Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined {
    return typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : undefined
  }

  /** Cancel the waiting registry retry and the offline retry, removing the `online` listener. */
  function cancelPendingRetries(): void {
    if (registryRetryTimer !== undefined) {
      clearTimeout(registryRetryTimer)
      registryRetryTimer = undefined
    }
    if (transientRetryTimer !== undefined) {
      clearTimeout(transientRetryTimer)
      transientRetryTimer = undefined
    }
    if (onlineRetry) {
      onlineRetry = undefined
      onlineEventTarget()?.removeEventListener('online', handleOnline)
    }
  }

  /** Run the pending offline retry once, if the generation, track and intent are unchanged. */
  function handleOnline(): void {
    const retry = onlineRetry
    if (!retry) return
    onlineRetry = undefined
    onlineEventTarget()?.removeEventListener('online', handleOnline)
    removeNotices('waitingForNetwork')
    if (disposed || retry.generation !== playbackGeneration.value || currentTrack()?.id !== retry.trackId ||
      playbackIntent.value !== retry.intent) return
    void resolveCurrent({ position: retry.position, origin: 'auto' })
  }

  /**
   * Retry the current track once at `position` on the next `online` event (D28). One retry is
   * pending at most; the store's `online` listener is attached only while it is.
   */
  function armOnlineRetry(position: number | undefined): void {
    const track = currentTrack()
    if (!track) return
    const target = onlineEventTarget()
    if (!target) return
    if (!onlineRetry) target.addEventListener('online', handleOnline)
    onlineRetry = { generation: playbackGeneration.value, trackId: track.id, intent: playbackIntent.value, position }
  }

  /**
   * Retry a registry that has never loaded after `delayMs` (D27). Guarded by the request and the
   * generation; cancelled by a new resolve, a queue move, `stop()` and `dispose()`.
   */
  function scheduleRegistryRetry(delayMs: number, position: number | undefined): void {
    if (registryRetryTimer !== undefined) clearTimeout(registryRetryTimer)
    registryRetries += 1
    const request = requestId
    const generation = playbackGeneration.value
    registryRetryTimer = setTimeout(() => {
      registryRetryTimer = undefined
      if (disposed || request !== requestId || generation !== playbackGeneration.value) return
      void resolveCurrent({ position, origin: 'auto' })
    }, delayMs)
  }

  /**
   * A fresh resolve of the current track after `delayMs` (task 41.7). Guarded by the request, the
   * generation, the track and a `playing` intent; cancelled with the other pending retries. The
   * registry is not force-refreshed: a refresh that fails replaces the loaded registry with an
   * empty one, which would turn the retry into a halt.
   */
  function scheduleTransientRetry(delayMs: number, position: number | undefined): void {
    if (transientRetryTimer !== undefined) clearTimeout(transientRetryTimer)
    const request = requestId
    const generation = playbackGeneration.value
    const trackId = currentTrack()?.id
    transientRetryTimer = setTimeout(() => {
      transientRetryTimer = undefined
      if (disposed || request !== requestId || generation !== playbackGeneration.value ||
        currentTrack()?.id !== trackId || playbackIntent.value !== 'playing') return
      recordPlayback('failCurrent.transientRetry.fire', { trackId: trackId ?? null, gen: generation })
      void resolveCurrent({ position, origin: 'auto' })
    }, delayMs)
  }

  /**
   * The one terminal path for a current track that cannot continue on its current source.
   *
   * In order: (1) automatic runtime failures first try the remaining automatic providers for the
   * same track at the same position; (2) offline or a registry that never loaded waits instead of
   * skipping; (3) an explicit listener action (Play, a manual source) never skips; (4) a paused or
   * prepared-only selection, or a session with no provider enabled, stays on the track; (5)
   * otherwise the store skips to the next queued track, bounded by MAX_UNAVAILABLE_SKIPS and one
   * pass through the queue. Every outcome except `continuing` leaves `status = 'error'`.
   */
  function failCurrent(origin: FailureOrigin, ctx: FailureContext): FailureOutcome {
    const trackId = currentTrack()?.id ?? null
    const outcome = failCurrentOutcome(origin, ctx)
    recordPlayback('store.failCurrent', {
      origin, outcome, gen: ctx.generation, trackId, providerId: ctx.providerId ?? null,
      position: ctx.position ?? null, triedJellyfin: ctx.triedJellyfin ?? null,
    })
    return outcome
  }

  function failCurrentOutcome(origin: FailureOrigin, ctx: FailureContext): FailureOutcome {
    if (disposed || ctx.request !== requestId || ctx.generation !== playbackGeneration.value) return 'stale'
    appendRuntimeFailure(ctx.providerId, origin)
    const track = currentTrack()

    // 1. Same-position chain (Property 25), on the cached registry (D18).
    if (SAME_POSITION_CHAIN_ORIGINS.has(origin) && sourceOverride.value === undefined && track) {
      if (ctx.providerId) failedProviderIds.add(ctx.providerId)
      if (ctx.triedJellyfin) failedProviderIds.add('jellyfin')
      if (remainingAutomaticProviders(track, failedProviderIds).length > 0) {
        chainResolution = resolveCurrent({ position: ctx.position, origin: 'auto', forceRefresh: takeRecoveryRefresh() })
        return 'continuing'
      }
    }

    status.value = 'error'

    // 2. Wait instead of skipping.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      addNotice('waitingForNetwork', { track })
      armOnlineRetry(ctx.position)
      return 'waiting'
    }
    if (!registryLoadedOnce) {
      if (registryRetries < REGISTRY_RETRY_DELAYS_MS.length) {
        scheduleRegistryRetry(REGISTRY_RETRY_DELAYS_MS[registryRetries], ctx.position)
        return 'waiting'
      }
      addNotice('sourcesUnavailable')
      return 'halted'
    }

    // 3. Explicit listener actions never skip (Properties 29, 30).
    if (origin === 'userPlay' || origin === 'manualOverride' || sourceOverride.value !== undefined) {
      addNotice('trackFailed', { track, source: sourceOverride.value })
      return 'halted'
    }

    // 4. Situations that must not skip (3.17). With no provider enabled at all, every track
    // fails for the same reason; skipping would only empty the queue.
    if (playbackIntent.value !== 'playing' || preparedQueueSelection || enabledProviderIds.value.length === 0) return 'halted'

    // 4b. Task 41.7: when every recorded failure is transient (a timeout, a rate limit, a dropped
    // request), resolve the track again before skipping it, at most TRANSIENT_RETRY_DELAYS_MS.length
    // times per track and listening session. Hidden pages retry too: the network still works.
    if (track && failuresAreTransient(attempts.value)) {
      const session = listeningSessionId.value
      const spent = transientRetries?.session === session && transientRetries.trackId === track.id ? transientRetries.count : 0
      const visibility = typeof document !== 'undefined' ? document.visibilityState : null
      const codes = attempts.value.filter((attempt) => !attempt.ok).map((attempt) => attempt.code ?? null)
      if (spent < TRANSIENT_RETRY_DELAYS_MS.length) {
        const delayMs = TRANSIENT_RETRY_DELAYS_MS[spent]
        transientRetries = { session, trackId: track.id, count: spent + 1 }
        recordPlayback('failCurrent.transientRetry', { origin, trackId: track.id, gen: ctx.generation, retry: spent + 1, delayMs, visibility, codes })
        scheduleTransientRetry(delayMs, ctx.position)
        return 'waiting'
      }
      recordPlayback('failCurrent.transientExhausted', { origin, trackId: track.id, gen: ctx.generation, retries: spent, visibility, codes })
    }

    // 5. Bounded skip (Properties 26, 27, 28).
    const target = skipTarget()
    if (target < 0 || unavailableSkips >= Math.min(MAX_UNAVAILABLE_SKIPS, queue.value.length - 1)) {
      if (unavailableSkips > 0) addNotice('queueUnplayable')
      return 'halted'
    }
    unavailableSkips += 1
    pushRecentFailure(track, attempts.value, origin)
    addNotice('skipped', { track })
    const { request, generation } = ctx
    queueMicrotask(() => {
      if (disposed || request !== requestId || generation !== playbackGeneration.value ||
        playbackIntent.value !== 'playing' || status.value !== 'error' || queue.value[target] === undefined) return
      recordPlayback('advance.unavailableSkip', { fromTrackId: track?.id ?? null, toIndex: target })
      void startQueueIndex(target)
    })
    return 'skipped'
  }

  function enqueue(track: Track): void {
    if (queue.value.some(({ id }) => id === track.id)) return
    const previousCurrentIndex = currentIndex.value
    queue.value = [...queue.value, track]
    // D26: an appended track that fails while last returns to the entry after the one that was current.
    playNowReturn = previousCurrentIndex >= 0 ? { trackId: track.id, index: previousCurrentIndex + 1 } : undefined
  }

  function isQueueIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < queue.value.length
  }

  function removeQueueIndex(index: number): boolean {
    if (!isQueueIndex(index)) return false
    playNowReturn = undefined
    if (index > currentIndex.value) {
      excludedIds.add(queue.value[index].id)
      manualNextIds.delete(queue.value[index].id)
    }
    if (index === currentIndex.value) {
      if (!preparedQueueSelection) return false
      queue.value = queue.value.filter((_track, queueIndex) => queueIndex !== index)
      stop()
      return true
    }
    queue.value = queue.value.filter((_track, queueIndex) => queueIndex !== index)
    if (index < currentIndex.value) currentIndex.value -= 1
    return true
  }

  function moveQueueItem(from: number, to: number): boolean {
    if (!isQueueIndex(from) || !isQueueIndex(to)) return false
    if (from === to) return true
    playNowReturn = undefined
    const currentId = currentTrack()?.id
    const reordered = [...queue.value]
    const [track] = reordered.splice(from, 1)
    reordered.splice(to, 0, track)
    queue.value = reordered
    currentIndex.value = currentId === undefined ? -1 : reordered.findIndex(({ id }) => id === currentId)
    return true
  }

  function playNext(track: Track): void {
    const existingIndex = queue.value.findIndex(({ id }) => id === track.id)
    playNowReturn = undefined
    excludedIds.delete(track.id)
    manualNextIds.add(track.id)
    if (existingIndex >= 0) {
      if (existingIndex === currentIndex.value) return
      if (existingIndex < currentIndex.value) {
        const updated = [...queue.value]
        const [historical] = updated.splice(existingIndex, 1)
        currentIndex.value -= 1
        updated.splice(currentIndex.value + 1, 0, historical)
        queue.value = updated
      } else moveQueueItem(existingIndex, currentIndex.value + 1)
      return
    }
    const updated = [...queue.value]
    updated.splice(currentIndex.value + 1, 0, track)
    queue.value = updated
  }

  function clearUpcomingQueue(): void {
    playNowReturn = undefined
    for (const track of queue.value.slice(currentIndex.value + 1)) excludedIds.add(track.id)
    manualNextIds.clear()
    if (preparedQueueSelection) {
      queue.value = []
      stop()
      return
    }
    queue.value = queue.value.slice(0, currentIndex.value + 1)
  }

  function buildUpcomingQueue(filteredTracks: readonly Track[], appendMissing: boolean, deterministic = false): Track[] {
    const matching = new Map<string, Track>()
    for (const track of filteredTracks) {
      if (!matching.has(track.id)) matching.set(track.id, track)
    }

    const upcomingStart = currentIndex.value + 1
    const reconciled = queue.value.slice(0, upcomingStart)
    const includedIds = new Set(reconciled.map(({ id }) => id))
    const manual: Track[] = []
    for (const queued of queue.value.slice(upcomingStart)) {
      const track = matching.get(queued.id) ?? queued
      if (track && (matching.has(track.id) || currentIndex.value >= 0) && manualNextIds.has(track.id) && !includedIds.has(track.id)) {
        manual.push(track)
        includedIds.add(track.id)
      }
    }
    reconciled.push(...manual)
    const ordinary: Track[] = []
    if (deterministic && appendMissing) {
      for (const track of matching.values()) if (!includedIds.has(track.id) && !excludedIds.has(track.id)) {
        ordinary.push(track); includedIds.add(track.id)
      }
      return [...reconciled, ...ordinary]
    }
    for (const queued of queue.value.slice(upcomingStart)) {
      const track = matching.get(queued.id)
      if (track && !includedIds.has(track.id)) {
        ordinary.push(track)
        includedIds.add(track.id)
      }
    }
    if (appendMissing) {
      for (const track of matching.values()) {
        if (!includedIds.has(track.id) && !excludedIds.has(track.id)) {
          ordinary.push(track)
          includedIds.add(track.id)
        }
      }
    }
    return [...reconciled, ...(shuffle.value && appendMissing ? shuffleTracks(ordinary, random) : ordinary)]
  }

  function updateUpcomingQueue(filteredTracks: readonly Track[], appendMissing: boolean): void {
    queue.value = buildUpcomingQueue(filteredTracks, appendMissing)
  }

  function reconcileUpcomingQueue(filteredTracks: readonly Track[]): void {
    sourceTracks = filteredTracks
    excludedIds.clear()
    if (preparedQueueSelection) {
      stop()
      updateUpcomingQueue(filteredTracks, true)
      if (queue.value.length > 0) void prepareQueueIndex(0)
      return
    }
    updateUpcomingQueue(filteredTracks, true)
  }

  function replaceQueueSource(tracks: readonly Track[]): void {
    playNowReturn = undefined
    sourceTracks = tracks
    // A catalogue replacement fills new matches, while explicit removals remain excluded.
    queue.value = buildUpcomingQueue(tracks, true)
  }

  function setShuffle(enabled: boolean): void {
    if (shuffle.value === enabled) return
    shuffle.value = enabled
    persist(SHUFFLE_KEY, String(enabled))
    queue.value = buildUpcomingQueue(sourceTracks.length ? sourceTracks : queue.value, true, !enabled)
  }

  function setRepeatMode(mode: RepeatMode): void {
    if (mode !== 'off' && mode !== 'all' && mode !== 'one') return
    repeatMode.value = mode
    persist(REPEAT_KEY, mode)
  }

  function cycleRepeatMode(): void {
    setRepeatMode(repeatMode.value === 'off' ? 'all' : repeatMode.value === 'all' ? 'one' : 'off')
  }

  function tryAdvancePreparedAfterEnded(generation: number): boolean {
    if (disposed || generation !== playbackGeneration.value || playbackIntent.value !== 'playing' ||
      repeatMode.value === 'one' || sourceOverride.value !== undefined || pendingQueueSelection ||
      preloadPolicy.value === 'none') return false
    const index = nextPreparationIndex.value
    const target = queue.value[index]
    const prepared = preparedNext.value
    const evidence = prepared && preparationSelections.get(prepared.id)
    if (!target || !prepared?.armed || !evidence || prepared.track !== target ||
      prepared.generation !== generation || !preparationIsFresh(prepared) ||
      !hasHandoverTicketMargin(preparationResolvedAt(prepared), Date.now(), prepared.playable.expiresAt)) return false
    try {
      const registry = options.loadRegistry ? options.peekRegistry?.() : staticRegistry
      if (!registry || !preparationSelectionsMatch(evidence.selection, preparationSelectionFor(target, registry))) return false
    } catch { return false }
    // No await can intervene between the current-registry check and this adoption.
    // All ordinary selection, cancellation, generation and ticket rules still run.
    playNowReturn = undefined
    unavailableSkips = 0
    void startQueueIndex(index, prepared)
    return playbackGeneration.value === generation + 1 && currentTrackRef.value === target && playable.value === prepared.playable
  }

  async function advanceAfterEnded(): Promise<void> {
    recordPlayback('store.advanceAfterEnded', { repeatMode: repeatMode.value, index: currentIndex.value, length: queue.value.length })
    if (repeatMode.value === 'one' && currentTrack()) {
      // The view may restart its existing media element; this fallback handles other media kinds.
      await playQueueIndex(currentIndex.value)
    } else if (currentIndex.value + 1 < queue.value.length) {
      await next()
    } else if (repeatMode.value === 'all' && queue.value.length > 0) {
      await playQueueIndex(0)
    } else {
      reportMediaState('ended', playbackGeneration.value)
      playbackIntent.value = 'paused'
    }
  }

  function refreshQueuedTracks(filteredTracks: readonly Track[]): void {
    const preparedTrack = preparedQueueSelection ? currentTrack() : undefined
    const preparedTrackId = preparedTrack?.id
    const refreshed = buildUpcomingQueue(filteredTracks, false)
    if (!preparedTrackId) {
      queue.value = refreshed
      return
    }
    const replacement = filteredTracks.find(({ id }) => id === preparedTrackId)
    if (replacement) refreshed[currentIndex.value] = replacement
    queue.value = refreshed
    if (replacement && replacement !== preparedTrack) {
      failedProviderIds.clear()
      runtimeFailures.value = []
      void resolveCurrent()
    }
  }

  async function prepareQueueIndex(index: number): Promise<void> {
    if (!isQueueIndex(index)) return
    mediaRenewalController?.abort()
    queueSelectionRevision += 1
    playNowReturn = undefined
    listeningSessionId.value += 1
    endedListeningSession = false
    currentIndex.value = index
    preparedQueueSelection = true
    sourceOverride.value = undefined
    failedProviderIds.clear()
    runtimeFailures.value = []
    playbackIntent.value = 'paused'
    await resolveCurrent()
  }

  async function playQueueIndex(index: number, stillNeeded: () => boolean = () => true): Promise<void> {
    if (!isQueueIndex(index) || !stillNeeded()) return
    // A listener queue move other than Play Now itself ends the Play Now return (D26).
    playNowReturn = undefined
    await startListenerQueueIndex(index, stillNeeded)
  }

  async function startListenerQueueIndex(index: number, stillNeeded: () => boolean = () => true): Promise<void> {
    // Every caller here is a listener choice or a natural track end, so a fresh run of
    // unavailable-track skips may begin from it.
    unavailableSkips = 0
    await startQueueIndex(index, undefined, stillNeeded)
  }

  async function startQueueIndex(index: number, validatedPreparation?: TrackPreparation, stillNeeded: () => boolean = () => true): Promise<void> {
    if (!isQueueIndex(index) || !stillNeeded()) return
    mediaRenewalController?.abort()
    const selectionRevision = ++queueSelectionRevision
    const target = queue.value[index]
    const preparationRequest = requestId
    const preparationGeneration = playbackGeneration.value
    pendingQueueSelection = { revision: selectionRevision, index, track: target, request: preparationRequest, generation: preparationGeneration }
    const pending = pendingPreparation
    if (!validatedPreparation && pending?.track === target) {
      await pending.promise
      if (disposed || !stillNeeded() || selectionRevision !== queueSelectionRevision || preparationGeneration !== playbackGeneration.value ||
        preparationRequest !== requestId || target !== queue.value[index]) {
        if (pendingQueueSelection?.revision === selectionRevision) pendingQueueSelection = undefined
        return
      }
    }
    const prepared = preparedNext.value?.track === target ? preparedNext.value : null
    if (validatedPreparation && prepared !== validatedPreparation) return
    // Reuse only a preparation whose media ticket is still valid. Reusing a stale one would hand
    // the deck a URL that answers `410 preparation_expired`, so a stale preparation falls through
    // to a fresh resolve instead: slower, but always correct.
    // Advancing the queue clears a manual override. A preparation resolved under that override
    // cannot be adopted as an automatic choice for the next track.
    // P96-06: a preparation is promoted only with HANDOVER_TICKET_MARGIN_MS of ticket life left, so
    // the promoted URL does not answer `410` within the first seconds of the track.
    const validPreparation = prepared && hasHandoverTicketMargin(preparationResolvedAt(prepared), Date.now(), prepared.playable.expiresAt) &&
      sourceOverride.value === undefined && (validatedPreparation === prepared || await preparationCanBeReused(prepared, target))
    // Registry validation can await; a concurrent stop/selection must still supersede this move.
    if (disposed || !stillNeeded() || selectionRevision !== queueSelectionRevision || preparationRequest !== requestId || preparationGeneration !== playbackGeneration.value ||
      queue.value[index] !== target) {
      if (pendingQueueSelection?.revision === selectionRevision) pendingQueueSelection = undefined
      return
    }
    renewalsWithoutProgress = 0
    clearAwaitingStart()
    cancelRecovery()
    // A queue move cancels the waiting registry and offline retries of the previous track.
    cancelPendingRetries()
    pendingResumePosition.value = undefined
    jellyfinFallbackAttempts.clear()
    recoveryRetryPosition = undefined
    listeningSessionId.value += 1
    endedListeningSession = false
    manualNextIds.delete(target.id)
    pendingQueueSelection = undefined
    const reusable = validPreparation && prepared && preparedNext.value?.id === prepared.id &&
      sourceOverride.value === undefined && preparationIsFresh(prepared) &&
      hasHandoverTicketMargin(preparationResolvedAt(prepared), Date.now(), prepared.playable.expiresAt) ? prepared : null
    preloadHandoff.value = reusable
      ? { ...reusable, generation: playbackGeneration.value + 1 }
      : null
    preparedQueueSelection = false
    playable.value = null
    currentIndex.value = index
    sourceOverride.value = undefined
    failedProviderIds.clear()
    runtimeFailures.value = []
    playbackIntent.value = 'playing'
    recordPlayback('queue.start', {
      index, trackId: target.id, reusedPreparation: Boolean(reusable), preparedFor: prepared ? true : false,
      preparedStale: Boolean(prepared && !reusable), providerId: reusable?.providerId ?? null,
    })
    if (reusable) {
      // Adopt the prepared result outright. The standby deck already holds this exact URL, so the
      // transition needs neither a provider round trip nor a media reload: `syncActiveDeck`
      // promotes that element because the handoff's id and URL both still match it. `requestId`
      // still advances so a resolution left in flight for the previous track cannot write state.
      advanceRequest()
      playbackGeneration.value += 1
      attempts.value = [...(reusable.attempts ?? [])]
      latestAttempts.value = [...(reusable.attempts ?? [])]
      // The starting state (P96-06): `playing` is reported only after `currentTime` progress.
      awaitingStart.value = { generation: playbackGeneration.value, startPosition: 0 }
      handoverTicket = { generation: playbackGeneration.value, resolvedAt: preparationResolvedAt(reusable), expiresAt: reusable.playable.expiresAt }
      playable.value = reusable.playable
      activeProviderId.value = reusable.providerId
      status.value = 'ready'
      return
    }
    await resolveCurrent()
  }

  async function playNow(track: Track): Promise<void> {
    const replacePreparedSelection = preparedQueueSelection
    if (replacePreparedSelection) stop()
    enqueue(track)
    let index = queue.value.findIndex(({ id }) => id === track.id)
    if (replacePreparedSelection && index > 0) {
      moveQueueItem(index, 0)
      index = 0
    }
    // Keep the return index only when this Play Now appended the track (D26).
    if (playNowReturn?.trackId !== track.id) playNowReturn = undefined
    await startListenerQueueIndex(index)
  }

  function selectedQueueIndex(): number {
    const pending = pendingQueueSelection
    return pending && pending.revision === queueSelectionRevision && pending.request === requestId &&
      pending.generation === playbackGeneration.value && queue.value[pending.index] === pending.track
      ? pending.index : currentIndex.value
  }

  async function next(): Promise<void> {
    const index = selectedQueueIndex() + 1
    if (index < queue.value.length) await playQueueIndex(index)
  }

  async function previous(): Promise<void> {
    const index = selectedQueueIndex() - 1
    if (index >= 0) await playQueueIndex(index)
  }

  async function setSourceOverride(providerId?: string): Promise<void> {
    mediaRenewalController?.abort()
    queueSelectionRevision += 1
    renewedSourcePositions.clear()
    jellyfinFallbackAttempts.clear()
    preparedQueueSelection = false
    const observedPosition = playbackPresentationFor(store).currentTime.value
    const resumePosition = !endedListeningSession && playable.value && Number.isFinite(observedPosition) && observedPosition > 0 ? observedPosition : undefined
    recoveryRetryPosition = undefined
    sourceOverride.value = providerId || undefined
    failedProviderIds.clear()
    runtimeFailures.value = []
    if (currentTrack()) await resolveCurrent({ position: resumePosition, origin: 'manualOverride' })
  }

  function setVolume(value: number): void {
    volume.value = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.7))
    try {
      storage?.setItem(VOLUME_KEY, String(volume.value))
    } catch {
      // Storage is an enhancement; denied storage cannot break anonymous playback.
    }
  }

  function pause(): void {
    cancelPreloadMediaFallback()
    queueSelectionRevision += 1
    pendingQueueSelection = undefined
    // A pause invalidates an in-flight stall renewal even if Play is pressed before it settles.
    if (sourceRecovery?.generation === playbackGeneration.value) resolutionController?.abort()
    mediaRenewalController?.abort()
    sourceRecovery = undefined
    cancelRecovery()
    playbackIntent.value = 'paused'
  }
  function stop(): void {
    pendingQueueSelection = undefined
    cancelRecovery()
    cancelPendingRetries()
    clearAwaitingStart()
    playNowReturn = undefined
    pendingResumePosition.value = undefined
    jellyfinFallbackAttempts.clear()
    recoveryRetryPosition = undefined
    preparedQueueSelection = false
    preloadHandoff.value = null
    advanceRequest()
    playbackGeneration.value += 1
    currentIndex.value = -1
    endedListeningSession = false
    playable.value = null
    activeProviderId.value = undefined
    sourceOverride.value = undefined
    manualProviderIds.value = []
    failedProviderIds.clear()
    runtimeFailures.value = []
    attempts.value = []
    playbackIntent.value = 'paused'
    status.value = 'idle'
  }
  async function play(): Promise<void> {
    if (!currentTrack() && queue.value.length === 0) return
    preparedQueueSelection = false
    // The listener's Play answers a tap-to-resume notice.
    removeNotices('tapToResume')
    if (endedListeningSession && currentTrack()) {
      endedListeningSession = false
      listeningSessionId.value += 1
    }
    playbackIntent.value = 'playing'
    if (status.value === 'error') renewedSourcePositions.clear()
    if (status.value === 'error' && (recoveryRetryPosition !== undefined || pendingResumePosition.value !== undefined)) {
      // P96-02: resolve the configured chain for the same track at the saved position, with
      // Jellyfin in its configured place; an exhausted chain halts on this track (failCurrent step 3).
      const position = recoveryRetryPosition ?? pendingResumePosition.value
      recoveryRetryPosition = undefined
      failedProviderIds.clear()
      runtimeFailures.value = []
      await resolveCurrent({ forceRefresh: true, position, origin: 'userPlay' })
      return
    }
    if (!currentTrack()) {
      await playQueueIndex(0)
      return
    }
    if (currentTrack() && (!playable.value || status.value === 'error')) {
      failedProviderIds.clear()
      runtimeFailures.value = []
      await resolveCurrent({ forceRefresh: true })
    }
  }
  function reportMediaState(state: PlaybackMediaState, generation: number): void {
    if (generation !== playbackGeneration.value || !playable.value) return
    if (state === 'ended') endedListeningSession = true
    if (state === 'paused' || state === 'ended') cancelRecovery()
    if (state === 'paused') {
      cancelPreloadMediaFallback()
      queueSelectionRevision += 1
      pendingQueueSelection = undefined
    }
    if (state === 'paused' && status.value === 'error') return
    if (status.value === 'paused' && playbackIntent.value === 'playing' && (state === 'buffering' || state === 'ready')) return
    // D31: `playing` alone does not end a skip run (presented progress does, see observeProgress).
    // P96-06: a handed-over element reports `playing` only once `currentTime` advanced (reportProgress).
    if (state === 'playing' && awaitingStart.value?.generation === generation) return
    status.value = state
  }

  function reportProgress(currentTime: number, generation: number, discontinuity = false): void {
    const previous = lastProgressReport
    if (generation === playbackGeneration.value && Number.isFinite(currentTime)) lastProgressReport = { generation, time: currentTime }
    if (discontinuity) {
      if (generation === playbackGeneration.value && Number.isFinite(currentTime)) {
        mediaRenewalController?.abort()
        queueSelectionRevision += 1
        pendingQueueSelection = undefined
        cancelPreloadMediaFallback()
      }
      return
    }
    const pending = awaitingStart.value
    if (pending && pending.generation === generation && generation === playbackGeneration.value &&
      Number.isFinite(currentTime) && currentTime > pending.startPosition) {
      awaitingStart.value = undefined
      if (playable.value && playbackIntent.value === 'playing' && !['error', 'ended', 'idle', 'resolving'].includes(status.value)) {
        status.value = 'playing'
      }
    }
    // Task 41: real progress for this generation answers a tap-to-resume notice by itself. Only a
    // small forward step while playing counts (a seek or a stale report does not).
    if (previous?.generation === generation && generation === playbackGeneration.value &&
      currentTime > previous.time && currentTime - previous.time <= PROGRESS_STEP_MAX_SECONDS &&
      playbackIntent.value === 'playing' && ['playing', 'buffering'].includes(status.value)) {
      renewalsWithoutProgress = 0
      if (status.value === 'playing' && playbackNotices.value.some((notice) => notice.kind === 'tapToResume')) {
        recordPlayback('notice.autoClear', { kind: 'tapToResume', gen: generation, currentTime })
        removeNotices('tapToResume')
      }
    }
  }

  async function recoverHandover(step: HandoverStep, generation: number): Promise<boolean> {
    recordPlayback('store.recoverHandover.begin', { step, gen: generation, status: status.value, intent: playbackIntent.value })
    const result = await recoverHandoverStep(step, generation)
    recordPlayback('store.recoverHandover.result', { step, gen: generation, result, newGen: playbackGeneration.value, skips: unavailableSkips })
    return result
  }

  async function recoverHandoverStep(step: HandoverStep, generation: number): Promise<boolean> {
    const track = currentTrack()
    if (disposed || generation !== playbackGeneration.value || !track || !playable.value ||
      playbackIntent.value !== 'playing') return false
    if (step === 'notice') {
      // Ladder step (c): intent stays `playing`; `paused` keeps Media Session out of `playing`.
      awaitingStart.value = undefined
      if (status.value !== 'error') status.value = 'paused'
      addNotice('tapToResume', { track })
      return true
    }
    // Every ladder step counts toward the skip-run bound (Property 27); at the bound, go to the notice.
    if (unavailableSkips >= Math.min(MAX_UNAVAILABLE_SKIPS, queue.value.length - 1)) return false
    if (step === 'srcSwap') {
      unavailableSkips += 1
      return true
    }
    // Step (b) only when the ticket is expired or below the margin.
    const ticket = handoverTicket
    const providerId = activeProviderId.value
    if (!ticket || ticket.generation !== generation || hasHandoverTicketMargin(ticket.resolvedAt, Date.now(), ticket.expiresAt) || !providerId) return false
    unavailableSkips += 1
    const startPosition = awaitingStart.value?.generation === generation ? awaitingStart.value.startPosition : 0
    const renewed = await renewMediaAt(providerId, generation, startPosition > 0 ? startPosition : undefined)
    if (renewed) awaitingStart.value = { generation: playbackGeneration.value, startPosition }
    return renewed
  }

  function registrySnapshot(): { registry: ProviderRegistry; failedProviderIds: readonly string[] } {
    return { registry: lastRegistry, failedProviderIds: [...failedProviderIds] }
  }

  /**
   * Renew a stalled stream once using the existing media renewal budget, then let the normal
   * failure chain choose a remaining provider. Keep the position and listener intent throughout.
   */
  async function requestSourceRecovery(
    currentProviderId: string,
    generation: number,
    positionSeconds: number,
    stillStalled: () => boolean = () => true,
  ): Promise<RecoveryOutcome> {
    const track = currentTrack()
    if (
      disposed || sourceRecovery?.generation === generation || generation !== playbackGeneration.value ||
      !track || playable.value?.kind !== 'audio' || playbackIntent.value !== 'playing' ||
      ['ended', 'error'].includes(status.value) || !currentProviderId ||
      currentProviderId !== activeProviderId.value || failedProviderIds.has(currentProviderId) ||
      !Number.isFinite(positionSeconds) || positionSeconds < 0 || !stillStalled()
    ) return 'stale'

    const recovery = { generation }
    sourceRecovery = recovery
    const isCurrent = () => !disposed && sourceRecovery === recovery &&
      generation === playbackGeneration.value && currentTrack()?.id === track.id &&
      currentProviderId === activeProviderId.value && playbackIntent.value === 'playing' && stillStalled()
    let request = requestId
    try {
      const previous = renewedSourcePositions.get(currentProviderId)
      const renewedHere = previous?.session === listeningSessionId.value && Math.abs(previous.position - positionSeconds) < 0.25
      if (!renewedHere && renewalsWithoutProgress < 1 && Date.now() - lastMediaRenewalAt >= MEDIA_RENEWAL_INTERVAL_MS) {
        const renewal = renewMediaAt(currentProviderId, generation, positionSeconds, isCurrent)
        request = requestId
        if (await renewal) return 'recovered'
      }
      if (request !== requestId || !isCurrent()) return 'stale'
      return await reportPlaybackFailureOutcome(currentProviderId, generation, positionSeconds)
    } finally {
      if (sourceRecovery === recovery) sourceRecovery = undefined
    }
  }

  /** Boolean view of the legacy {@link requestJellyfinRecovery} API. */
  async function requestJellyfinFallback(
    currentProviderId: string,
    generation: number,
    positionSeconds: number,
    stillStalled: () => boolean = () => true,
  ): Promise<boolean> {
    return await requestJellyfinRecovery(currentProviderId, generation, positionSeconds, stillStalled) === 'recovered'
  }

  /**
   * Same-position recovery of a stalled or failed stream through Jellyfin (P95-02 residual, D18).
   *
   * Returns `stale` without touching `status` when nothing was attempted, the attempt was
   * superseded, or the stream is no longer stalled at a decision point. When Jellyfin is not usable
   * in the registry, or its attempt fails, the failure goes to `failCurrent('recovery')`, which
   * resolves the remaining automatic providers at the same position before any skip.
   */
  async function requestJellyfinRecovery(
    currentProviderId: string,
    generation: number,
    positionSeconds: number,
    stillStalled: () => boolean = () => true,
  ): Promise<RecoveryOutcome> {
    const track = currentTrack()
    if (
      generation !== playbackGeneration.value ||
      !track ||
      !playable.value ||
      playbackIntent.value !== 'playing' ||
      currentProviderId !== activeProviderId.value ||
      currentProviderId === 'jellyfin' ||
      !Number.isFinite(positionSeconds) ||
      positionSeconds < 0 ||
      !track.sources.some((source) => source.provider === 'jellyfin')
    ) return 'stale'

    const attemptKey = `${track.id}:${currentProviderId}`
    if (jellyfinFallbackAttempts.has(attemptKey)) return 'stale'
    const request = advanceRequest()
    const controller = new AbortController()
    jellyfinFallbackAttempts.set(attemptKey, controller)
    cancelRecovery()
    recoveryController = controller
    const observedAttempts: ProviderAttempt[] = []
    let completedAttempt = false
    /**
     * Hand the failure to `failCurrent`. The recovery controller is detached first, so the
     * chain's own resolve does not release this track's one-shot attempt key.
     */
    const fail = (triedJellyfin: boolean): Promise<FailureOutcome> => {
      // Only a made attempt spends the one-shot key, as at 8309e3a.
      if (triedJellyfin) completedAttempt = true
      if (recoveryController === controller) recoveryController = undefined
      return settleChain(failCurrent('recovery', {
        request, generation, providerId: currentProviderId, position: positionSeconds, triedJellyfin,
      }))
    }
    try {
      const registry = options.loadRegistry
        ? registryLoaded(await options.loadRegistry({
            forceRefresh: takeRecoveryRefresh(),
          }))
        : staticRegistry
      if (
        controller.signal.aborted ||
        request !== requestId ||
        generation !== playbackGeneration.value || playbackIntent.value !== 'playing' || !stillStalled()
      ) return 'stale'

      automaticProviderIds.value = registry.enabled().map(({ provider }) => provider.id)
      if (!jellyfinUsable(track, registry, { failedProviderIds, activeProviderId: activeProviderId.value })) {
        return await fail(false)
      }

      const result = await resolver(track, registry, {
        signal: controller.signal,
        sourceOverride: 'jellyfin',
        onAttempt(attempt) { observedAttempts.push(attempt) },
      })
      if (
        controller.signal.aborted || playbackIntent.value !== 'playing' || !stillStalled() ||
        request !== requestId ||
        generation !== playbackGeneration.value
      ) return 'stale'

      completedAttempt = true
      const attemptsFromResult = observedAttempts.length > 0 ? observedAttempts : result.attempts
      attempts.value = [...attempts.value, ...attemptsFromResult]
      latestAttempts.value = [...attemptsFromResult]
      if (!result.ok || result.providerId !== 'jellyfin' || result.playable.kind !== 'audio') {
        // Kept for Play after a halted recovery (P96-02 path, task 8.4).
        recoveryRetryPosition = positionSeconds
        return await fail(true)
      }

      playable.value = null
      recoveryRetryPosition = undefined
      pendingResumePosition.value = positionSeconds
      playbackGeneration.value += 1
      playable.value = result.playable
      activeProviderId.value = result.providerId
      status.value = 'ready'
      recordPlayback('resolve.ok', { gen: playbackGeneration.value, trackId: track.id, origin: 'jellyfinRecovery', providerId: result.providerId, kind: 'audio' })
      return 'recovered'
    } catch {
      if (!completedAttempt && !controller.signal.aborted && request === requestId && generation === playbackGeneration.value && playbackIntent.value === 'playing' && stillStalled()) {
        recoveryRetryPosition = positionSeconds
        return await fail(true)
      }
      return 'stale'
    } finally {
      if (!completedAttempt && jellyfinFallbackAttempts.get(attemptKey) === controller) {
        jellyfinFallbackAttempts.delete(attemptKey)
      }
      controller.abort()
      if (recoveryController === controller) recoveryController = undefined
    }
  }

  function consumePendingResumePosition(): number | undefined {
    const position = pendingResumePosition.value
    pendingResumePosition.value = undefined
    return position
  }
  /**
   * Renews an expired or interrupted media URL without treating its provider as failed.
   *
   * Media URLs are short-lived same-origin tickets, while a browser fetches audio in ranges as it
   * plays. A phone in the background, a network switch or a long pause can delay the next range
   * request past the ticket's lifetime; the request then answers 410 and the element errors even
   * though the provider is healthy. Excluding the provider at that point is what used to end in
   * "no source available". So a media error first asks the same provider for a fresh URL and
   * resumes at the same position, in the same listening session.
   *
   * Bounded twice: at most one renewal until media makes real forward progress, and at most one per
   * MEDIA_RENEWAL_INTERVAL_MS, so a URL that keeps failing falls through to the normal failure
   * handling instead of looping.
   */
  async function renewMedia(providerId: string, generation: number, stillNeeded: () => boolean = () => true): Promise<boolean> {
    if (!stillNeeded() || renewalsWithoutProgress >= 1 || Date.now() - lastMediaRenewalAt < MEDIA_RENEWAL_INTERVAL_MS) return false
    const observed = playbackPresentationFor(store).currentTime.value
    const position = Number.isFinite(observed) && observed > 0 ? observed : undefined
    return await renewMediaAt(providerId, generation, position, stillNeeded)
  }

  /** The renewal itself: a fresh URL from the same provider, resumed at `position`. */
  async function renewMediaAt(
    providerId: string,
    generation: number,
    position: number | undefined,
    stillNeeded: () => boolean = () => true,
  ): Promise<boolean> {
    const track = currentTrack()
    if (
      disposed || !stillNeeded() || generation !== playbackGeneration.value || !track || playbackIntent.value !== 'playing' ||
      playable.value?.kind !== 'audio' || !providerId || providerId !== activeProviderId.value
    ) return false
    // A new URL or its own playing event must not reset the stall budget at this position.
    renewedSourcePositions.set(providerId, { session: listeningSessionId.value, position: position ?? 0 })
    renewalsWithoutProgress += 1
    const startedAt = Date.now()
    lastMediaRenewalAt = startedAt
    const thisRequest = advanceRequest()
    const controller = new AbortController()
    resolutionController = controller
    mediaRenewalController = controller
    // Queue choices, seeks and explicit Pause abort this controller. Native pause only revokes
    // the view's ownership, so an explicit listener Play may reauthorise its existing recovery.
    const ownsRenewal = () => !disposed && !controller.signal.aborted && thisRequest === requestId &&
      generation === playbackGeneration.value && playbackIntent.value === 'playing' && stillNeeded()
    const observedAttempts: ProviderAttempt[] = []
    const observe = (attempt: ProviderAttempt) => {
      recordAttempt('resolve.attempt', attempt, { gen: generation, trackId: track.id, origin: 'renewal' })
      observedAttempts.push(attempt)
      if (ownsRenewal()) latestAttempts.value = [...observedAttempts]
    }
    cancelRecovery()
    try {
      const registry = options.loadRegistry ? await options.loadRegistry({ forceRefresh: true }) : staticRegistry
      if (!ownsRenewal()) return false
      registryLoaded(registry)
      if (!registry.selectable().some(({ provider }) => provider.id === providerId)) return false
      const result = await resolver(track, registry, {
        signal: controller.signal,
        sourceOverride: providerId,
        onAttempt: observe,
        excludeProviderIds: registry.enabled()
          .map(({ provider }) => provider.id)
          .filter((id) => id !== providerId),
      })
      if (!ownsRenewal()) return false
      latestAttempts.value = observedAttempts.length ? [...observedAttempts] : [...result.attempts]
      if (!observedAttempts.length) {
        for (const attempt of result.attempts) recordAttempt('resolve.attempt', attempt, { gen: generation, trackId: track.id, origin: 'renewal' })
      }
      if (!result.ok || result.providerId !== providerId || result.playable.kind !== 'audio' ||
        Date.now() >= effectiveTicketExpiry(startedAt, result.playable.expiresAt)) return false
      // Publish the resume intent before withdrawing the old descriptor, so the view can
      // preserve its native source while the replacement loads and seeks.
      const starting = awaitingStart.value?.generation === generation ? awaitingStart.value : undefined
      pendingResumePosition.value = position
      playable.value = null
      playbackGeneration.value += 1
      if (starting) {
        awaitingStart.value = { generation: playbackGeneration.value, startPosition: position ?? starting.startPosition }
        handoverTicket = { generation: playbackGeneration.value, resolvedAt: startedAt, expiresAt: result.playable.expiresAt }
      }
      playable.value = result.playable
      activeProviderId.value = result.providerId
      status.value = 'ready'
      recordPlayback('resolve.ok', { gen: playbackGeneration.value, trackId: track.id, origin: 'renewal', providerId: result.providerId, kind: 'audio' })
      return true
    } catch {
      return false
    } finally {
      if (resolutionController === controller) resolutionController = undefined
      if (mediaRenewalController === controller) mediaRenewalController = undefined
    }
  }

  async function reportPlaybackFailure(providerId: string, generation: number): Promise<FailureOutcome> {
    return await reportPlaybackFailureOutcome(providerId, generation)
  }

  /**
   * A runtime failure of the active provider, routed through `failCurrent`. Returns the outcome;
   * `continuing` settles only after the same-position chain resolve has finished.
   */
  async function reportPlaybackFailureOutcome(providerId: string, generation: number, positionSeconds?: number): Promise<FailureOutcome> {
    if (
      generation !== playbackGeneration.value ||
      !providerId ||
      providerId !== activeProviderId.value ||
      failedProviderIds.has(providerId)
    ) return 'stale'
    const ctx = { request: requestId, generation }
    const observed = playbackPresentationFor(store).currentTime.value
    // A renewed element can fail before metadata/seek consumes the original resume position.
    // Its fresh presentation is still zero, so keep the pending seek through provider fallback.
    const position = positionSeconds ?? pendingResumePosition.value ?? (Number.isFinite(observed) && observed > 0 ? observed : undefined)
    // The failed media is gone whatever `failCurrent` decides; keep the position for Play.
    cancelRecovery()
    pendingResumePosition.value = position
    playable.value = null
    activeProviderId.value = undefined
    const outcome = failCurrent('runtime', { ...ctx, providerId, position })
    // Without a chain resolve, the attempts list shows this session's runtime failures, as a
    // resolve that finds nothing would.
    if (outcome !== 'continuing' && outcome !== 'stale') attempts.value = [...runtimeFailures.value]
    return await settleChain(outcome)
  }

  const store: PlaybackStore = {
    shuffle, repeatMode, setShuffle, cycleRepeatMode, setRepeatMode, replaceQueueSource, advanceAfterEnded, tryAdvancePreparedAfterEnded,
    transitionMode, crossfadeDuration, setTransitionMode, setCrossfadeDuration, nextPreparationIndex, prepareTransition, canHandoffPreparation, rejectPreparation,
    preparedNext, preloadHandoff, preloadPolicy, setPreloadPolicy, invalidatePreload, rejectNextPreparation, releasePreloadHandoff, armNextPreparation, dispose,
    activeProviderId, attempts, latestAttempts,
    currentIndex, currentTrack: currentTrackRef, enabledProviderIds, manualProviderIds, automaticProviderIds, playbackIntent, playbackGeneration, listeningSessionId,
    playable, queue, sourceOverride,
    status, volume, pendingResumePosition, enqueue, next, pause, play,
    removeQueueIndex, moveQueueItem, playNext, clearUpcomingQueue, reconcileUpcomingQueue, refreshQueuedTracks,
    playNow, prepareQueueIndex, playQueueIndex, previous, reportMediaState, requestJellyfinFallback,
    requestSourceRecovery, requestJellyfinRecovery, registrySnapshot, reportProgress, awaitingStart, recoverHandover,
    consumePendingResumePosition, reportPlaybackFailure, renewMedia, setSourceOverride, setVolume,
    stop, playbackNotices, dismissNotice, addPlaybackNotice, recentFailures,
  }
  stopProgressWatch = watch(() => playbackPresentationFor(store).currentTime.value, observeProgress, { flush: 'sync' })
  return store
}
