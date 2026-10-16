import { computed, ref, shallowRef, watch, type Ref } from 'vue'

import type { Track } from '../catalog/types'
import { resolveTrack, type ResolveOptions, type ResolveResult } from './resolver'
import { isProviderEligible, ProviderRegistry } from './providers/registry'
import type { Playable, ProviderAttempt } from './providers/types'
import type { PreloadPolicy } from './preloadPolicy'

export interface TrackPreparation {
  id: number
  track: Track
  providerId: string
  playable: Extract<Playable, { kind: 'audio' }>
  generation: number
  /**
   * Epoch milliseconds at which this preparation was resolved.
   *
   * A resolved media URL is a Worker-minted transient ticket whose token is random per resolve
   * (`workers/providers/transientMedia.ts`), so a preparation cannot be reused indefinitely. This
   * timestamp is what lets the transition reuse a preparation that is still valid and fall back to
   * a fresh resolve when it is not.
   */
  preparedAt: number
  /** Set only once playback enters the bounded lead window. */
  armed: boolean
}

export type PlaybackStatus = 'idle' | 'resolving' | 'ready' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'
export type PlaybackIntent = 'playing' | 'paused'
export type PlaybackMediaState = 'ready' | 'playing' | 'paused' | 'buffering' | 'ended'
export type ResolveTrack = (track: Track, registry: ProviderRegistry, options?: ResolveOptions) => Promise<ResolveResult>

export interface PlaybackStoreOptions {
  loadRegistry?: (options?: {
    forceRefresh?: boolean
    onSubAttempt?: (attempt: ProviderAttempt) => void
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
  preparedNext: Readonly<Ref<TrackPreparation | null>>
  preloadHandoff: Readonly<Ref<TrackPreparation | null>>
  preloadPolicy: Readonly<Ref<PreloadPolicy>>
  setPreloadPolicy(policy: PreloadPolicy): void
  invalidatePreload(): void
  releasePreloadHandoff(generation: number): void
  /**
   * Prepare the immediate next queued track for the provider the current mode would actually use.
   *
   * Called by the player once the active track is close enough to its end that the resolved media
   * URL will still be valid when the track is promoted. Unlike the speculative warm-up it is not
   * restricted to self-managed providers, because by this point the track is the one that will
   * genuinely play next and the resolve replaces the one the transition would otherwise perform.
   *
   * A no-op when a preparation for that track is already fresh, so it is safe to call repeatedly
   * from a progress handler.
   */
  armNextPreparation(): Promise<void>
  dispose(): void
  activeProviderId: Readonly<Ref<string | undefined>>
  attempts: Readonly<Ref<readonly ProviderAttempt[]>>
  currentIndex: Readonly<Ref<number>>
  currentTrack: Readonly<Ref<Track | undefined>>
  enabledProviderIds: Readonly<Ref<readonly string[]>>
  manualProviderIds: Readonly<Ref<readonly string[]>>
  playbackIntent: Readonly<Ref<PlaybackIntent>>
  playbackGeneration: Readonly<Ref<number>>
  playable: Readonly<Ref<Playable | null>>
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
  playQueueIndex(index: number): Promise<void>
  previous(): Promise<void>
  reportMediaState(state: PlaybackMediaState, generation: number): void
  reportPlaybackFailure(providerId: string, generation: number): Promise<void>
  setSourceOverride(providerId?: string): Promise<void>
  setVolume(value: number): void
  stop(): void
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
 * Must stay inside the Worker's transient-media ticket lifetime (`TICKET_TTL_MS = 30_000` in
 * `workers/providers/transientMedia.ts`). That ticket is **not** refreshed on use, so promoting a
 * preparation whose ticket has expired would hand the media element a URL that answers
 * `410 preparation_expired`. 25 s leaves a small margin under that ceiling, which is also why the
 * player arms the preparation only near the end of the active track rather than at its start.
 */
export const PREPARATION_VALIDITY_MS = 25_000

/**
 * Providers a speculative warm-up must never resolve.
 *
 * ChKSz resolution spends a rate-limited quota (20/min, 50/day) and can consume the owner's
 * fallback key, so resolving a track that may never play is not free; R2 is not deck-playable
 * audio. The armed preparation deliberately does not apply this list, because by then the track is
 * the one that will actually play next and the resolve replaces the one the transition would
 * otherwise perform — it is not extra traffic.
 */
const SPECULATIVE_EXCLUDED_PROVIDER_IDS: readonly string[] = ['chksz', 'r2']

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
  return now - preparedAt <= validityMs
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
  const attempts = shallowRef<ProviderAttempt[]>([])
  const volume = ref(initialVolume(storage))
  const enabledProviderIds = shallowRef(
    staticRegistry.selectable().map(({ provider }) => provider.id),
  )
  const manualProviderIds = shallowRef<readonly string[]>([])
  const playbackGeneration = ref(0)
  const failedProviderIds = new Set<string>()
  const runtimeFailures = shallowRef<ProviderAttempt[]>([])
  let requestId = 0
  let preparedQueueSelection = false
  const preloadPolicy = ref<PreloadPolicy>('none')
  const preparedNext = shallowRef<TrackPreparation | null>(null)
  const preloadHandoff = shallowRef<TrackPreparation | null>(null)
  const preloadRevision = ref(0)
  let preloadRequest = 0
  let preloadSchedule = 0
  let preloadController: AbortController | undefined
  let pendingSpeculation: { track: Track; promise: Promise<void> } | undefined
  let disposed = false
  const preparationValidityMs = options.preparationValidityMs ?? PREPARATION_VALIDITY_MS
  /**
   * The (track, generation) the armed preparation was last attempted for.
   *
   * Media progress fires several times a second, so without this a preparation that keeps failing
   * would be retried on every tick for the whole lead window. One attempt per track per playback
   * generation is enough: if it fails, the transition performs its own resolve and surfaces the
   * failure through the normal, non-speculative path. Keying on the generation means a track change
   * or a manual provider switch naturally re-arms.
   */
  let armedAttempt: { trackId: string; generation: number } | undefined

  const currentTrack = (): Track | undefined => queue.value[currentIndex.value]
  const currentTrackRef = computed(currentTrack)

  function cancelNextPreparation(): void {
    preloadRequest += 1
    preloadController?.abort()
    preloadController = undefined
    pendingSpeculation = undefined
    preparedNext.value = null
    armedAttempt = undefined
  }

  function invalidatePreload(): void {
    preloadHandoff.value = null
    preloadRevision.value += 1
  }

  function setPreloadPolicy(policy: PreloadPolicy): void {
    if (preloadPolicy.value === policy) return
    preloadHandoff.value = null
    preloadPolicy.value = policy
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

  /**
   * The provider the immediate next track would play through under the current mode.
   *
   * Manual mode is strict: the override is returned only when it is registered and eligible for
   * that track, so a manual choice can never be replaced by another provider. Automatic mode
   * returns the first eligible provider in the registry's own automatic order — the same decision
   * the resolver would make; naming it here is what lets the prepared result be verified against
   * it instead of trusting whatever the resolver happened to return.
   *
   * The final fallback to the track's own declared bindings covers a registry that carries no
   * matching registration (a test seam, or a deployment whose provider config has not loaded yet),
   * which is the behaviour this path had before it became provider-agnostic.
   */
  function targetProviderFor(track: Track, registry: ProviderRegistry): string | undefined {
    const override = sourceOverride.value
    if (override) {
      const registration = registry.selectable().find(({ provider }) => provider.id === override)
      if (registration) return isProviderEligible(registration.provider, track) ? override : undefined
      return track.sources.some(({ provider }) => provider === override) ? override : undefined
    }
    const automatic = registry.enabled().find(({ provider }) => isProviderEligible(provider, track))
    if (automatic) return automatic.provider.id
    return track.sources[0]?.provider
  }

  /**
   * Resolve `track` and publish it as the next-track preparation.
   *
   * `speculative` restricts the work to providers whose resolution is free: ChKSz spends a
   * rate-limited quota (20/min, 50/day) and can consume the owner's fallback key, and R2 is not
   * deck-playable audio, so warming those up for a track that may never play is not free. The
   * armed path deliberately does not apply that restriction.
   */
  async function prepareNextTrack(track: Track, speculative: boolean): Promise<void> {
    const identity = ++preloadRequest
    const generation = playbackGeneration.value
    const controller = new AbortController()
    preloadController = controller
    try {
      const registry = options.loadRegistry ? await options.loadRegistry() : staticRegistry
      if (controller.signal.aborted || identity !== preloadRequest) return

      const targetProvider = targetProviderFor(track, registry)
      if (!targetProvider) return
      if (speculative && SPECULATIVE_EXCLUDED_PROVIDER_IDS.includes(targetProvider)) return

      const activeIds = registry.enabled().map(({ provider }) => provider.id)
      const excludeProviderIds = [...new Set([
        ...activeIds.filter((id) => id !== targetProvider),
        ...track.sources.map((s) => s.provider).filter((id) => id !== targetProvider),
        ...(speculative ? SPECULATIVE_EXCLUDED_PROVIDER_IDS : []),
      ])]
      const result = await resolver(track, registry, {
        signal: controller.signal,
        sourceOverride: targetProvider,
        excludeProviderIds,
      })
      if (controller.signal.aborted || identity !== preloadRequest) return
      if (result.ok && result.providerId === targetProvider && result.playable.kind === 'audio') {
        preparedNext.value = {
          id: identity,
          track,
          providerId: result.providerId,
          playable: result.playable,
          generation,
          preparedAt: Date.now(),
          armed: !speculative,
        }
      }
    } catch {
      // Speculative failure must never leak into active attempts or fallback.
    }
  }

  async function armNextPreparation(): Promise<void> {
    const preloadEnabled = () => preloadPolicy.value !== 'none'
    if (disposed || !preloadEnabled()) return
    const track = queue.value[currentIndex.value + 1]
    if (!track || !currentTrack() || !playable.value) return
    const existing = preparedNext.value
    if (existing && existing.track === track && preparationIsFresh(existing)) {
      if (!existing.armed) preparedNext.value = { ...existing, armed: true }
      return
    }
    if (armedAttempt?.trackId === track.id && armedAttempt.generation === playbackGeneration.value) return
    const generation = playbackGeneration.value
    armedAttempt = { trackId: track.id, generation }
    const inFlight = pendingSpeculation
    if (inFlight?.track === track) {
      await inFlight.promise
      if (disposed || generation !== playbackGeneration.value || queue.value[currentIndex.value + 1] !== track || !preloadEnabled()) return
      const finished = preparedNext.value
      if (finished && finished.track === track && preparationIsFresh(finished)) {
        preparedNext.value = { ...finished, armed: true }
        return
      }
    }
    await prepareNextTrack(track, false)
  }

  /**
   * The provider a **speculative** warm-up may use, or undefined when there is none.
   *
   * Deliberately narrower than {@link targetProviderFor}: the warm-up stays on Jellyfin because it
   * is the only provider whose resolution is free and self-managed. Its media ticket still expires,
   * so the view waits for the lead-window arm before assigning it to the standby deck. Resolving a track
   * that may never play through ChKSz would spend a rate-limited quota (and possibly the owner's
   * fallback key), and R2/YouTube are not deck-playable audio. The armed preparation is the one
   * that is allowed to be provider-agnostic, because by then the track really is next.
   */
  function speculativeTargetProvider(track: Track): string | undefined {
    const override = sourceOverride.value
    if (override !== undefined && override !== 'jellyfin') return undefined
    return track.sources.some(({ provider }) => provider === 'jellyfin') ? 'jellyfin' : undefined
  }

  const stopPreloadWatch = watch([
    currentIndex, currentTrackRef,
    () => queue.value[currentIndex.value + 1],
    () => playable.value !== null,
    sourceOverride, preloadPolicy, preloadRevision,
  ], () => {
    cancelNextPreparation()
    const schedule = ++preloadSchedule
    queueMicrotask(() => {
      if (schedule !== preloadSchedule) return
      const track = queue.value[currentIndex.value + 1]
      if (disposed || preloadPolicy.value === 'none' || !currentTrack() || !playable.value || !track) return
      // Speculation is deliberately limited to the self-managed Jellyfin provider: it must not
      // consume a third-party quota or user BYOK credential before the next track is certain.
      if (!speculativeTargetProvider(track)) return
      const promise = prepareNextTrack(track, true)
      const pending = { track, promise }
      pendingSpeculation = pending
      void promise.finally(() => {
        if (pendingSpeculation === pending) pendingSpeculation = undefined
      })
    })
  }, { flush: 'sync' })

  function dispose(): void {
    disposed = true
    preloadSchedule += 1
    requestId += 1
    stopPreloadWatch()
    cancelNextPreparation()
    preloadHandoff.value = null
  }

  async function resolveCurrent(forceRefresh = false): Promise<void> {
    const track = currentTrack()
    if (!track) return
    const thisRequest = ++requestId
    playbackGeneration.value += 1
    status.value = 'resolving'
    playable.value = null
    activeProviderId.value = undefined
    attempts.value = [...runtimeFailures.value]
    const observedAttempts: ProviderAttempt[] = []
    const overrideAttempts: ProviderAttempt[] = []
    // One live array backs both the resolver's top-level attempts and the composite LX
    // provider's per-sub-source attempts, so diagnostics render them in emission order.
    const observeAttempt = (attempt: ProviderAttempt): void => {
      observedAttempts.push(attempt)
      if (thisRequest === requestId) {
        attempts.value = [...runtimeFailures.value, ...overrideAttempts, ...observedAttempts]
      }
    }

    try {
      const activeRegistry = options.loadRegistry
        ? await options.loadRegistry({ forceRefresh, onSubAttempt: observeAttempt })
        : staticRegistry
      if (thisRequest !== requestId) return

      const enabledIds = activeRegistry.selectable().map(({ provider }) => provider.id)
      enabledProviderIds.value = enabledIds
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
        attempts.value = [...runtimeFailures.value, ...overrideAttempts]
        status.value = 'error'
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
        attempts.value = [...runtimeFailures.value, ...overrideAttempts]
        status.value = 'error'
        return
      }
      attempts.value = [...runtimeFailures.value, ...overrideAttempts]

      const result = await resolver(track, activeRegistry, {
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
      attempts.value = [...runtimeFailures.value, ...overrideAttempts, ...settledAttempts]
      if (!result.ok) {
        status.value = 'error'
        return
      }
      const handoff = preloadHandoff.value
      if (handoff && (handoff.track !== track || handoff.generation !== playbackGeneration.value ||
        result.providerId !== 'jellyfin' || result.playable.kind !== 'audio' || result.playable.url !== handoff.playable.url)) {
        preloadHandoff.value = null
      }
      playable.value = result.playable
      activeProviderId.value = result.providerId
      status.value = 'ready'
    } catch {
      if (thisRequest === requestId) { preloadHandoff.value = null; status.value = 'error' }
    }
  }

  function enqueue(track: Track): void {
    if (!queue.value.some(({ id }) => id === track.id)) queue.value = [...queue.value, track]
  }

  function isQueueIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < queue.value.length
  }

  function removeQueueIndex(index: number): boolean {
    if (!isQueueIndex(index)) return false
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

  async function advanceAfterEnded(): Promise<void> {
    if (repeatMode.value === 'one' && currentTrack()) {
      // The view may restart its existing media element; this fallback handles other media kinds.
      await playQueueIndex(currentIndex.value)
    } else if (currentIndex.value + 1 < queue.value.length) {
      await next()
    } else if (repeatMode.value === 'all' && queue.value.length > 0) {
      await playQueueIndex(0)
    } else reportMediaState('ended', playbackGeneration.value)
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
    currentIndex.value = index
    preparedQueueSelection = true
    sourceOverride.value = undefined
    failedProviderIds.clear()
    runtimeFailures.value = []
    playbackIntent.value = 'paused'
    await resolveCurrent()
  }

  async function playQueueIndex(index: number): Promise<void> {
    if (index < 0 || index >= queue.value.length) return
    const target = queue.value[index]
    manualNextIds.delete(target.id)
    const prepared = preparedNext.value?.track === target ? preparedNext.value : null
    // Reuse only a preparation whose media ticket is still valid. Reusing a stale one would hand
    // the deck a URL that answers `410 preparation_expired`, so a stale preparation falls through
    // to a fresh resolve instead: slower, but always correct.
    // Advancing the queue clears a manual override. A preparation resolved under that override
    // cannot be adopted as an automatic choice for the next track.
    const reusable = prepared && preparationIsFresh(prepared) && sourceOverride.value === undefined ? prepared : null
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
    if (reusable) {
      // Adopt the prepared result outright. The standby deck already holds this exact URL, so the
      // transition needs neither a provider round trip nor a media reload: `syncActiveDeck`
      // promotes that element because the handoff's id and URL both still match it. `requestId`
      // still advances so a resolution left in flight for the previous track cannot write state.
      requestId += 1
      playbackGeneration.value += 1
      attempts.value = []
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
    await playQueueIndex(index)
  }

  async function next(): Promise<void> {
    if (currentIndex.value + 1 < queue.value.length) await playQueueIndex(currentIndex.value + 1)
  }

  async function previous(): Promise<void> {
    if (currentIndex.value > 0) await playQueueIndex(currentIndex.value - 1)
  }

  async function setSourceOverride(providerId?: string): Promise<void> {
    preparedQueueSelection = false
    sourceOverride.value = providerId || undefined
    failedProviderIds.clear()
    runtimeFailures.value = []
    if (currentTrack()) await resolveCurrent()
  }

  function setVolume(value: number): void {
    volume.value = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.7))
    try {
      storage?.setItem(VOLUME_KEY, String(volume.value))
    } catch {
      // Storage is an enhancement; denied storage cannot break anonymous playback.
    }
  }

  function pause(): void { playbackIntent.value = 'paused' }
  function stop(): void {
    preparedQueueSelection = false
    preloadHandoff.value = null
    requestId += 1
    playbackGeneration.value += 1
    currentIndex.value = -1
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
    playbackIntent.value = 'playing'
    if (!currentTrack()) {
      await playQueueIndex(0)
      return
    }
    if (currentTrack() && !playable.value) {
      failedProviderIds.clear()
      runtimeFailures.value = []
      await resolveCurrent(true)
    }
  }
  function reportMediaState(state: PlaybackMediaState, generation: number): void {
    if (generation !== playbackGeneration.value || !playable.value) return
    status.value = state
    if (state === 'playing') playbackIntent.value = 'playing'
    else if (state === 'paused' || state === 'ended') playbackIntent.value = 'paused'
  }
  async function reportPlaybackFailure(providerId: string, generation: number): Promise<void> {
    if (
      generation !== playbackGeneration.value ||
      !providerId ||
      providerId !== activeProviderId.value ||
      failedProviderIds.has(providerId)
    ) return
    failedProviderIds.add(providerId)
    runtimeFailures.value = [
      ...runtimeFailures.value,
      { providerId, ok: false, code: 'unavailable', latencyMs: 0 },
    ]
    await resolveCurrent(true)
  }

  return {
    shuffle, repeatMode, setShuffle, cycleRepeatMode, setRepeatMode, replaceQueueSource, advanceAfterEnded,
    preparedNext, preloadHandoff, preloadPolicy, setPreloadPolicy, invalidatePreload, releasePreloadHandoff, armNextPreparation, dispose,
    activeProviderId, attempts,
    currentIndex, currentTrack: currentTrackRef, enabledProviderIds, manualProviderIds, playbackIntent, playbackGeneration,
    playable, queue, sourceOverride,
    status, volume, enqueue, next, pause, play,
    removeQueueIndex, moveQueueItem, playNext, clearUpcomingQueue, reconcileUpcomingQueue, refreshQueuedTracks,
    playNow, prepareQueueIndex, playQueueIndex, previous, reportMediaState, reportPlaybackFailure, setSourceOverride, setVolume,
    stop,
  }
}
