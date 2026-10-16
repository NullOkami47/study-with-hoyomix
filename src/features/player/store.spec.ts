import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import { ProviderRegistry } from './providers/registry'
import type { AudioProvider } from './providers/types'
import { resolveTrack, type ResolveOptions, type ResolveResult } from './resolver'
import { createPlaybackStore, shuffleTracks, type PlaybackStore } from './store'

const first = { id: 'first', title: 'First', sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }] } as Track
const second = { id: 'second', title: 'Second', sources: [{ provider: 'youtube', externalId: 'lmnopqrstuv' }] } as Track

// Order-sensitive legacy scenarios explicitly choose sequential playback.
beforeEach(() => window.localStorage.setItem('hoyomix-player-shuffle-v1', 'false'))

describe('queue playback modes and history', () => {
  const source = [first, second, { ...first, id: 'third' }, { ...first, id: 'fourth' }] as Track[]
  const resolver = vi.fn(async (): Promise<ResolveResult> => ({
    ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
  }))
  const ids = (store: PlaybackStore) => store.queue.value.map(({ id }) => id)

  it('defaults Shuffle on for first visits and respects an explicit off after reload', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const firstVisit = createPlaybackStore({ storage })
    expect(firstVisit.shuffle.value).toBe(true)
    firstVisit.setShuffle(false)
    expect(createPlaybackStore({ storage }).shuffle.value).toBe(false)
    expect(values.get('hoyomix-player-shuffle-v1')).toBe('false')
    firstVisit.setShuffle(true)
    expect(createPlaybackStore({ storage }).shuffle.value).toBe(true)
  })

  it('uses injectable Fisher-Yates randomness without moving current or history', async () => {
    expect(shuffleTracks([0, 1, 2, 3], () => 0)).toEqual([1, 2, 3, 0])
    const store = createPlaybackStore({ resolve: resolver, random: () => 0, storage: { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: vi.fn() } })
    store.reconcileUpcomingQueue(source)
    await store.playQueueIndex(0)
    await store.next()
    const history = store.queue.value[0]
    const current = store.currentTrack.value
    store.setShuffle(true)
    expect(store.queue.value[0]).toBe(history)
    expect(store.currentTrack.value).toBe(current)
    expect(ids(store)).toEqual(['first', 'second', 'fourth', 'third'])
    store.setShuffle(false)
    expect(ids(store)).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('keeps manual Play Next first during shuffle and structural reconciliation', async () => {
    const store = createPlaybackStore({ resolve: resolver, random: () => 0, storage: { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: vi.fn() } })
    store.reconcileUpcomingQueue(source)
    await store.playQueueIndex(0)
    store.playNext(source[3])
    store.setShuffle(true)
    expect(ids(store)[1]).toBe('fourth')
    store.reconcileUpcomingQueue(source)
    expect(ids(store)[1]).toBe('fourth')
  })

  it('preserves history and explicit removal when a full replacement adds matches', async () => {
    const store = createPlaybackStore({ resolve: resolver, storage: { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: vi.fn() } })
    store.reconcileUpcomingQueue(source.slice(0, 3))
    await store.playQueueIndex(0)
    await store.next()
    store.removeQueueIndex(2)
    store.replaceQueueSource(source)
    expect(ids(store)).toEqual(['first', 'second', 'fourth'])
    expect(store.currentIndex.value).toBe(1)
  })

  it('persists modes and cycles repeat off, all, one', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const store = createPlaybackStore({ storage })
    store.setShuffle(true)
    store.cycleRepeatMode()
    expect(store.repeatMode.value).toBe('all')
    store.cycleRepeatMode()
    expect(store.repeatMode.value).toBe('one')
    store.cycleRepeatMode()
    expect(store.repeatMode.value).toBe('off')
    store.setRepeatMode('one')
    const restored = createPlaybackStore({ storage })
    expect(restored.shuffle.value).toBe(true)
    expect(restored.repeatMode.value).toBe('one')
  })

  it('advances according to repeat off, all, and one', async () => {
    const store = createPlaybackStore({ resolve: resolver, storage: { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: vi.fn() } })
    store.reconcileUpcomingQueue(source.slice(0, 2))
    await store.playQueueIndex(1)
    const last = store.currentTrack.value
    store.setRepeatMode('off')
    await store.advanceAfterEnded()
    expect(store.currentTrack.value).toBe(last)
    expect(store.status.value).toBe('ended')
    store.setRepeatMode('all')
    await store.advanceAfterEnded()
    expect(store.currentIndex.value).toBe(0)
    store.setRepeatMode('one')
    const generation = store.playbackGeneration.value
    await store.advanceAfterEnded()
    expect(store.currentIndex.value).toBe(0)
    expect(store.playbackGeneration.value).toBeGreaterThan(generation)
  })
})

const multiSource = {
  ...first,
  sources: [
    { provider: 'r2', externalId: 'first.ogg' },
    { provider: 'youtube', externalId: 'abcdefghijk' },
    { provider: 'chksz', externalId: '1315196858' },
  ],
} as Track

const provider = (id: string): AudioProvider => ({
  id,
  resolve: vi.fn(async (track: Track) => {
    if (id !== 'youtube') return null
    const source = track.sources.find(({ provider: providerId }) => providerId === id)
    return source ? { kind: 'youtube' as const, videoId: source.externalId } : null
  }),
})

const registry = (...entries: Array<[id: string, priority: number]>) => new ProviderRegistry(
  entries.map(([id, priority]) => ({ provider: provider(id), enabled: true, priority, timeoutMs: 100 })),
)

describe('playback store', () => {
  it('keeps queue order deterministic across play, enqueue, next, and previous', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })

    await store.playNow(first)
    store.enqueue(second)
    store.enqueue(first)
    await store.next()
    await store.previous()

    expect(store.queue.value.map(({ id }) => id)).toEqual(['first', 'second'])
    expect(store.currentTrack.value?.id).toBe('first')
  })

  it('keeps resolver success ready until generation-safe media events report the truth', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })

    await store.playNow(first)
    const generation = store.playbackGeneration.value

    expect(store.status.value).toBe('ready')
    expect(store.playbackIntent.value).toBe('playing')

    store.reportMediaState('playing', generation)
    expect(store.status.value).toBe('playing')

    store.reportMediaState('paused', generation)
    expect(store.status.value).toBe('paused')
    expect(store.playbackIntent.value).toBe('paused')

    store.reportMediaState('buffering', generation - 1)
    expect(store.status.value).toBe('paused')
  })

  it('persists clamped volume without requiring an account', () => {
    const storage = { getItem: vi.fn(() => '0.35'), setItem: vi.fn() }
    const store = createPlaybackStore({ storage })

    expect(store.volume.value).toBe(0.35)
    store.setVolume(4)
    expect(store.volume.value).toBe(1)
    expect(storage.setItem).toHaveBeenLastCalledWith('hoyomix-player-volume', '1')
  })

  it('uses the default volume when no persisted value exists', () => {
    const store = createPlaybackStore({ storage: { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: vi.fn() } })
    expect(store.volume.value).toBe(0.7)
  })

  it('keeps anonymous playback usable when browser storage is unavailable', () => {
    const storage = {
      getItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      setItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
    }

    const store = createPlaybackStore({ storage })
    expect(store.volume.value).toBe(0.7)
    expect(() => store.setVolume(0.4)).not.toThrow()
    expect(store.volume.value).toBe(0.4)
  })

  it('re-resolves the current track when the source override changes', async () => {
    const resolve = vi.fn(async (_track, _registry, options): Promise<ResolveResult> => ({
      ok: true,
      providerId: options?.sourceOverride ?? 'r2',
      playable: { kind: 'youtube', videoId: 'abcdefghijk' },
      attempts: [],
    }))
    const store = createPlaybackStore({ resolve, registry: registry(['youtube', 1]) })

    await store.playNow(first)
    await store.setSourceOverride('youtube')

    expect(resolve).toHaveBeenLastCalledWith(first, expect.anything(), expect.objectContaining({ sourceOverride: 'youtube' }))
    expect(store.activeProviderId.value).toBe('youtube')
  })

  it('excludes the runtime-failed provider and resolves the next mapped source', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, providerId: 'r2', playable: { kind: 'audio', url: 'https://media.invalid/broken.ogg', mimeType: 'audio/ogg' }, attempts: [] })
      .mockResolvedValueOnce({ ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [] })
    const store = createPlaybackStore({ resolve })

    await store.playNow(first)
    await store.reportPlaybackFailure('r2', store.playbackGeneration.value)

    expect(resolve).toHaveBeenLastCalledWith(first, expect.anything(), expect.objectContaining({ excludeProviderIds: ['r2'] }))
    expect(store.activeProviderId.value).toBe('youtube')
    expect(store.attempts.value).toContainEqual(expect.objectContaining({ providerId: 'r2', ok: false, code: 'unavailable' }))
  })

  it('ignores a deferred media error from a previous track generation', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })

    await store.playNow(first)
    const staleGeneration = store.playbackGeneration.value
    store.enqueue(second)
    await store.next()
    await store.reportPlaybackFailure('youtube', staleGeneration)

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(store.currentTrack.value).toBe(second)
    expect(store.activeProviderId.value).toBe('youtube')
  })

  it('ignores a deferred iframe error after a source generation changes', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({
      resolve,
      registry: registry(['youtube', 1]),
    })

    await store.playNow(first)
    const staleGeneration = store.playbackGeneration.value
    await store.setSourceOverride('youtube')
    await store.reportPlaybackFailure('youtube', staleGeneration)

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(store.status.value).toBe('ready')
  })

  it('preserves an explicit failed override without falling back to automatic selection', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, providerId: 'r2', playable: { kind: 'audio', url: 'https://media.invalid/first.ogg', mimeType: 'audio/ogg' }, attempts: [] })
      .mockResolvedValueOnce({ ok: true, providerId: 'r2', playable: { kind: 'audio', url: 'https://media.invalid/override.ogg', mimeType: 'audio/ogg' }, attempts: [] })
      .mockResolvedValueOnce({ ok: false, code: 'exhausted', attempts: [] })
    const store = createPlaybackStore({
      resolve,
      registry: registry(['r2', 1], ['youtube', 2]),
    })

    await store.playNow(multiSource)
    await store.setSourceOverride('r2')
    await store.reportPlaybackFailure('r2', store.playbackGeneration.value)

    expect(store.sourceOverride.value).toBe('r2')
    expect(store.status.value).toBe('error')
    expect(store.playable.value).toBeNull()
    expect(store.activeProviderId.value).toBeUndefined()
    expect(store.attempts.value).toEqual([
      { providerId: 'r2', ok: false, code: 'unavailable', latencyMs: 0 },
    ])
  })

  it('loads the current registry for each new, next, previous, and override resolution', async () => {
    const loadRegistry = vi.fn(async () => registry(['youtube', 1]))
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ loadRegistry, resolve })

    await store.playNow(first)
    store.enqueue(second)
    await store.next()
    await store.previous()
    await store.setSourceOverride('youtube')

    expect(loadRegistry).toHaveBeenCalledTimes(4)
    expect(loadRegistry).toHaveBeenNthCalledWith(1, expect.objectContaining({ forceRefresh: false, onSubAttempt: expect.any(Function) }))
    expect(loadRegistry).toHaveBeenNthCalledWith(4, expect.objectContaining({ forceRefresh: false, onSubAttempt: expect.any(Function) }))
  })

  it('uses changed Admin priority on the next registry-backed resolution', async () => {
    const registries = [
      registry(['r2', 1], ['youtube', 2]),
      registry(['youtube', 1], ['r2', 2]),
    ]
    const loadRegistry = vi.fn(async () => registries.shift() ?? new ProviderRegistry([]))
    const observedOrder: string[][] = []
    const resolve = vi.fn(async (_track: Track, activeRegistry: ProviderRegistry): Promise<ResolveResult> => {
      observedOrder.push(activeRegistry.enabled().map(({ provider: activeProvider }) => activeProvider.id))
      return { ok: false, code: 'exhausted', attempts: [] }
    })
    const store = createPlaybackStore({ loadRegistry, resolve })

    await store.playNow(multiSource)
    await store.setSourceOverride()

    expect(observedOrder).toEqual([
      ['r2', 'youtube'],
      ['youtube', 'r2'],
    ])
    expect(store.enabledProviderIds.value).toEqual(['youtube', 'r2'])
  })

  it('fails with no attempt when the effective registry disables all providers', async () => {
    const store = createPlaybackStore({
      loadRegistry: vi.fn(async () => new ProviderRegistry([])),
    })

    await store.playNow(first)

    expect(store.enabledProviderIds.value).toEqual([])
    expect(store.attempts.value).toEqual([])
    expect(store.status.value).toBe('error')
  })

  it('records and preserves an override disabled by the current registry without fallback', async () => {
    const store = createPlaybackStore({
      loadRegistry: vi.fn(async () => new ProviderRegistry([
        { provider: provider('youtube'), enabled: true, priority: 2, timeoutMs: 100 },
      ])),
    })

    await store.playNow(multiSource)
    await store.setSourceOverride('chksz')

    expect(store.sourceOverride.value).toBe('chksz')
    expect(store.status.value).toBe('error')
    expect(store.playable.value).toBeNull()
    expect(store.activeProviderId.value).toBeUndefined()
    expect(store.attempts.value).toEqual([
      { providerId: 'chksz', ok: false, code: 'unavailable', latencyMs: 0 },
    ])
  })

  it('records and preserves an effective override missing from the track without fallback', async () => {
    const store = createPlaybackStore({
      loadRegistry: vi.fn(async () => registry(['r2', 1], ['youtube', 2])),
    })

    await store.playNow(first)
    await store.setSourceOverride('r2')

    expect(store.sourceOverride.value).toBe('r2')
    expect(store.status.value).toBe('error')
    expect(store.playable.value).toBeNull()
    expect(store.activeProviderId.value).toBeUndefined()
    expect(store.attempts.value).toEqual([
      { providerId: 'r2', ok: false, code: 'not_mapped', latencyMs: 0 },
    ])
  })

  it('forces a registry refresh before retrying after an active playback failure', async () => {
    const loadRegistry = vi.fn(async () => registry(['r2', 1], ['youtube', 2]))
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, providerId: 'r2', playable: { kind: 'audio', url: 'https://media.example/first.ogg', mimeType: 'audio/ogg' }, attempts: [] })
      .mockResolvedValueOnce({ ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [] })
    const store = createPlaybackStore({ loadRegistry, resolve })

    await store.playNow(multiSource)
    await store.reportPlaybackFailure('r2', store.playbackGeneration.value)

    expect(loadRegistry).toHaveBeenNthCalledWith(1, expect.objectContaining({ forceRefresh: false, onSubAttempt: expect.any(Function) }))
    expect(loadRegistry).toHaveBeenNthCalledWith(2, expect.objectContaining({ forceRefresh: true, onSubAttempt: expect.any(Function) }))
    expect(store.activeProviderId.value).toBe('youtube')
  })

  it('prepares only the immediate next queue entry without changing active playback state', async () => {
    const resolve = vi.fn(async (track: Track): Promise<ResolveResult> => ({
      ok: true, providerId: 'jellyfin', attempts: [],
      playable: { kind: 'audio', url: 'https://media.invalid/' + track.id + '.ogg', mimeType: 'audio/ogg' },
    }))
    const jellyfinFirst = { ...first, sources: [{ provider: 'jellyfin', externalId: 'first.ogg' }] } as Track
    const jellyfinSecond = { ...second, sources: [{ provider: 'jellyfin', externalId: 'second.ogg' }] } as Track
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue([jellyfinFirst, jellyfinSecond, { ...jellyfinSecond, id: 'third', title: 'Third' } as Track])
    await store.prepareQueueIndex(0)
    const active = {
      track: store.currentTrack.value, index: store.currentIndex.value,
      intent: store.playbackIntent.value, status: store.status.value,
      playable: store.playable.value, attempts: store.attempts.value,
    }

    store.setPreloadPolicy('metadata')
    await vi.waitFor(() => expect(store.preparedNext.value?.track.id).toBe('second'))

    expect(resolve.mock.calls.map(([track]) => track.id)).toEqual(['first', 'second'])
    expect(store.preparedNext.value).toMatchObject({
      track: jellyfinSecond, providerId: 'jellyfin',
      playable: { kind: 'audio', url: 'https://media.invalid/second.ogg' },
    })
    expect(store.currentTrack.value).toBe(active.track)
    expect(store.currentIndex.value).toBe(active.index)
    expect(store.playbackIntent.value).toBe(active.intent)
    expect(store.status.value).toBe(active.status)
    expect(store.playable.value).toBe(active.playable)
    expect(store.attempts.value).toBe(active.attempts)
  })

  it('removes a prepared first track as queue state rather than protected history', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue([first, second])
    await store.prepareQueueIndex(0)

    expect(store.removeQueueIndex(0)).toBe(true)

    expect(store.queue.value).toEqual([second])
    expect(store.currentIndex.value).toBe(-1)
    expect(store.currentTrack.value).toBeUndefined()
    expect(store.playable.value).toBeNull()
    expect(store.playbackIntent.value).toBe('paused')
  })

  it('clears a prepared first track with the rest of the upcoming queue', async () => {
    const store = createPlaybackStore({ resolve: vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    })) })
    store.reconcileUpcomingQueue([first, second])
    await store.prepareQueueIndex(0)

    store.clearUpcomingQueue()

    expect(store.queue.value).toEqual([])
    expect(store.currentIndex.value).toBe(-1)
    expect(store.playable.value).toBeNull()
    expect(store.status.value).toBe('idle')
  })

  it('replaces an untouched prepared selection when filters change', async () => {
    const resolve = vi.fn(async (track: Track): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: track.sources[0]!.externalId }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue([first, second])
    await store.prepareQueueIndex(0)

    store.reconcileUpcomingQueue([second])
    await vi.waitFor(() => expect(store.currentTrack.value).toBe(second))

    expect(store.queue.value).toEqual([second])
    expect(store.playbackIntent.value).toBe('paused')
    expect(resolve).toHaveBeenLastCalledWith(second, expect.anything(), expect.anything())
  })

  it('moves explicit Play now ahead of an untouched prepared selection', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue([first, second])
    await store.prepareQueueIndex(0)
    const explicit = { ...second, id: 'explicit', title: 'Explicit' } as Track

    await store.playNow(explicit)

    expect(store.queue.value).toEqual([explicit, first, second])
    expect(store.currentIndex.value).toBe(0)
    expect(store.currentTrack.value).toBe(explicit)
    expect(store.playbackIntent.value).toBe('playing')
  })

  it('ignores stale initial resolution after the catalogue replaces the prepared track', async () => {
    let settleBundled!: (result: ResolveResult) => void
    const replacement = {
      ...first,
      title: 'Published First',
      sources: [{ provider: 'r2', externalId: 'published-first.ogg' }],
    } as Track
    const resolve = vi.fn((track: Track): Promise<ResolveResult> => {
      if (track === first) {
        return new Promise((resolveResult) => { settleBundled = resolveResult })
      }
      return Promise.resolve({
        ok: true, providerId: 'r2',
        playable: { kind: 'audio', url: 'https://media.invalid/published-first.ogg', mimeType: 'audio/ogg' },
        attempts: [],
      })
    })
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue([first, second])
    const bundledPreparation = store.prepareQueueIndex(0)

    store.refreshQueuedTracks([replacement, second])
    await Promise.resolve()
    settleBundled({
      ok: true, providerId: 'youtube',
      playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    })
    await bundledPreparation
    await Promise.resolve()

    expect(store.currentTrack.value).toBe(replacement)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(store.playable.value).toMatchObject({
      kind: 'audio', url: 'https://media.invalid/published-first.ogg',
    })
    expect(store.activeProviderId.value).toBe('r2')
    expect(store.playbackIntent.value).toBe('paused')
  })

  it('retries the selected track when Play is requested without a playable', async () => {
    const resolve = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'exhausted', attempts: [] })
      .mockResolvedValueOnce({
        ok: true, providerId: 'youtube',
        playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
      })
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue([first, second])
    await store.prepareQueueIndex(0)

    expect(store.currentTrack.value).toBe(first)
    expect(store.playable.value).toBeNull()
    expect(store.playbackIntent.value).toBe('paused')

    await store.play()

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(store.currentTrack.value).toBe(first)
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.playable.value).toMatchObject({ kind: 'youtube' })
    expect(store.status.value).toBe('ready')
  })

  it('keeps an empty player paused when Play has no track to select', async () => {
    const resolve = vi.fn()
    const store = createPlaybackStore({ resolve })

    await store.play()

    expect(store.playbackIntent.value).toBe('paused')
    expect(store.currentIndex.value).toBe(-1)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('stops playback by clearing the active queue position without deleting the queue', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })
    await store.playNow(first)
    store.enqueue(second)

    store.stop()

    expect(store.currentIndex.value).toBe(-1)
    expect(store.currentTrack.value).toBeUndefined()
    expect(store.playable.value).toBeNull()
    expect(store.playbackIntent.value).toBe('paused')
    expect(store.status.value).toBe('idle')
    expect(store.queue.value.map(({ id }) => id)).toEqual(['first', 'second'])
  })
})

describe('playback store queue mutations', () => {
  it('moves the current track without re-resolving or changing playback state', async () => {
    const resolve = vi.fn(async (_track: Track, _registry: ProviderRegistry, options?: ResolveOptions): Promise<ResolveResult> => ({
      ok: true,
      providerId: options?.sourceOverride ?? 'youtube',
      playable: { kind: 'youtube', videoId: 'abcdefghijk' },
      attempts: [],
    }))
    const store = createPlaybackStore({ resolve, registry: registry(['youtube', 1]) })

    await store.playNow(multiSource)
    await store.setSourceOverride('youtube')
    store.enqueue(second)
    store.enqueue({ ...second, id: 'third', title: 'Third' } as Track)

    const before = {
      activeProviderId: store.activeProviderId.value,
      attempts: store.attempts.value,
      playable: store.playable.value,
      playbackGeneration: store.playbackGeneration.value,
      playbackIntent: store.playbackIntent.value,
      sourceOverride: store.sourceOverride.value,
      status: store.status.value,
    }

    expect(store.moveQueueItem(0, 2)).toBe(true)

    expect(store.queue.value.map(({ id }) => id)).toEqual(['second', 'third', 'first'])
    expect(store.currentIndex.value).toBe(2)
    expect(store.currentTrack.value).toBe(multiSource)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(store.activeProviderId.value).toBe(before.activeProviderId)
    expect(store.attempts.value).toBe(before.attempts)
    expect(store.playable.value).toBe(before.playable)
    expect(store.playbackGeneration.value).toBe(before.playbackGeneration)
    expect(store.playbackIntent.value).toBe(before.playbackIntent)
    expect(store.sourceOverride.value).toBe(before.sourceOverride)
    expect(store.status.value).toBe(before.status)
  })

  it('moves another queue item across current while keeping the same current track active', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })

    await store.playNow(first)
    store.enqueue(second)
    await store.next()
    store.enqueue({ ...second, id: 'third', title: 'Third' } as Track)
    const current = store.currentTrack.value
    const generation = store.playbackGeneration.value

    expect(store.moveQueueItem(2, 0)).toBe(true)

    expect(store.queue.value.map(({ id }) => id)).toEqual(['third', 'first', 'second'])
    expect(store.currentIndex.value).toBe(2)
    expect(store.currentTrack.value).toBe(current)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('removes an item before current without interrupting playback', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })

    await store.playNow(first)
    store.enqueue(second)
    await store.next()
    store.enqueue({ ...second, id: 'third', title: 'Third' } as Track)
    const current = store.currentTrack.value
    const generation = store.playbackGeneration.value
    const playable = store.playable.value

    expect(store.removeQueueIndex(0)).toBe(true)

    expect(store.queue.value.map(({ id }) => id)).toEqual(['second', 'third'])
    expect(store.currentIndex.value).toBe(0)
    expect(store.currentTrack.value).toBe(current)
    expect(store.playable.value).toBe(playable)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('refuses invalid indices and removal of the current row', async () => {
    const store = createPlaybackStore()
    await store.playNow(first)

    expect(store.removeQueueIndex(-1)).toBe(false)
    expect(store.removeQueueIndex(1)).toBe(false)
    expect(store.moveQueueItem(-1, 0)).toBe(false)
    expect(store.moveQueueItem(0, 1)).toBe(false)
    expect(store.removeQueueIndex(0)).toBe(false)
    expect(store.queue.value.map(({ id }) => id)).toEqual(['first'])
    expect(store.currentIndex.value).toBe(0)
  })

  it('deletes and clears upcoming items without stopping the current track', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })

    await store.playNow(first)
    store.enqueue(second)
    store.enqueue({ ...second, id: 'third', title: 'Third' } as Track)
    const current = store.currentTrack.value
    const state = {
      activeProviderId: store.activeProviderId.value,
      attempts: store.attempts.value,
      playable: store.playable.value,
      playbackGeneration: store.playbackGeneration.value,
      playbackIntent: store.playbackIntent.value,
      status: store.status.value,
    }

    expect(store.removeQueueIndex(2)).toBe(true)
    store.clearUpcomingQueue()

    expect(store.queue.value.map(({ id }) => id)).toEqual(['first'])
    expect(store.currentTrack.value).toBe(current)
    expect(store.currentIndex.value).toBe(0)
    expect(store.activeProviderId.value).toBe(state.activeProviderId)
    expect(store.attempts.value).toBe(state.attempts)
    expect(store.playable.value).toBe(state.playable)
    expect(store.playbackGeneration.value).toBe(state.playbackGeneration)
    expect(store.playbackIntent.value).toBe(state.playbackIntent)
    expect(store.status.value).toBe(state.status)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('moves an existing upcoming track to the next position without duplicating it', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })
    const third = { ...second, id: 'third', title: 'Third' } as Track

    await store.playNow(first)
    store.enqueue(second)
    store.enqueue(third)

    store.playNext(third)

    expect(store.queue.value.map(({ id }) => id)).toEqual(['first', 'third', 'second'])
    expect(store.currentIndex.value).toBe(0)
    expect(store.playbackIntent.value).toBe('playing')
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('places play-next first with no current track and does not start playback implicitly', () => {
    const resolve = vi.fn()
    const store = createPlaybackStore({ resolve })

    store.playNext(second)

    expect(store.queue.value.map(({ id }) => id)).toEqual(['second'])
    expect(store.currentIndex.value).toBe(-1)
    expect(store.currentTrack.value).toBeUndefined()
    expect(store.status.value).toBe('idle')
    expect(store.playbackIntent.value).toBe('paused')
    expect(store.playbackGeneration.value).toBe(0)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('reconciles only upcoming rows, preserving manual order and deduplicating canonical IDs', async () => {
    const resolve = vi.fn(async (): Promise<ResolveResult> => ({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    }))
    const store = createPlaybackStore({ resolve })
    const stale = { ...second, id: 'stale', title: 'Stale' } as Track
    const manual = { ...second, id: 'manual', title: 'Manual' } as Track
    const appended = { ...second, id: 'appended', title: 'Appended' } as Track
    const refreshedManual = { ...manual, title: 'Manual refreshed' }
    const refreshedAppended = { ...appended, title: 'Appended refreshed' }
    const refreshedCurrent = { ...second, title: 'Current refreshed' }

    await store.playNow(first)
    store.enqueue(second)
    store.enqueue(stale)
    store.enqueue(manual)
    store.enqueue(appended)
    await store.next()

    store.reconcileUpcomingQueue([
      refreshedAppended,
      refreshedManual,
      appended,
      refreshedCurrent,
      first,
      refreshedManual,
    ])

    expect(store.queue.value.map(({ id }) => id)).toEqual(['first', 'second', 'manual', 'appended'])
    expect(store.queue.value[0]).toBe(first)
    expect(store.queue.value[1]).toBe(second)
    expect(store.queue.value[1].title).toBe('Second')
    expect(store.queue.value[2]).toBe(refreshedManual)
    expect(store.queue.value[3]).toBe(refreshedAppended)
    expect(store.currentIndex.value).toBe(1)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('keeps an unmatched current track until next handling advances into reconciled upcoming rows', async () => {
    const resolve = vi.fn(async (track: Track): Promise<ResolveResult> => ({
      ok: true,
      providerId: 'youtube',
      playable: { kind: 'youtube', videoId: track.sources[0]?.externalId ?? 'abcdefghijk' },
      attempts: [],
    }))
    const store = createPlaybackStore({ resolve })

    await store.playNow(first)
    store.enqueue(second)
    store.reconcileUpcomingQueue([second])

    expect(store.currentTrack.value).toBe(first)
    expect(store.queue.value.map(({ id }) => id)).toEqual(['first', 'second'])
    expect(resolve).toHaveBeenCalledTimes(1)

    await store.next()

    expect(store.currentTrack.value).toBe(second)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('does not invalidate pending resolution when queue mutations reorder upcoming rows', async () => {
    let finishResolve!: (result: ResolveResult) => void
    const resolve = vi.fn(() => new Promise<ResolveResult>((resolveResult) => {
      finishResolve = resolveResult
    }))
    const store = createPlaybackStore({ resolve })

    const pending = store.playNow(first)
    store.enqueue(second)
    const generation = store.playbackGeneration.value
    const playable = store.playable.value

    store.reconcileUpcomingQueue([second])
    expect(store.moveQueueItem(1, 0)).toBe(true)
    expect(store.currentIndex.value).toBe(1)
    expect(store.currentTrack.value).toBe(first)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.playable.value).toBe(playable)
    expect(resolve).toHaveBeenCalledTimes(1)

    finishResolve({
      ok: true, providerId: 'youtube', playable: { kind: 'youtube', videoId: 'abcdefghijk' }, attempts: [],
    })
    await pending

    expect(store.currentTrack.value).toBe(first)
    expect(store.status.value).toBe('ready')
  })

  const third: Track = { ...second, id: 'third', title: 'Third' }
  const fourth: Track = { ...second, id: 'fourth', title: 'Fourth' }
  const fifth: Track = { ...second, id: 'fifth', title: 'Fifth' }

  function playbackSnapshot(store: PlaybackStore) {
    return {
      currentTrack: store.currentTrack.value,
      playable: store.playable.value,
      activeProviderId: store.activeProviderId.value,
      sourceOverride: store.sourceOverride.value,
      attempts: store.attempts.value,
      enabledProviderIds: store.enabledProviderIds.value,
      playbackGeneration: store.playbackGeneration.value,
      playbackIntent: store.playbackIntent.value,
      status: store.status.value,
    }
  }

  function expectPlaybackUnchanged(store: PlaybackStore, before: ReturnType<typeof playbackSnapshot>) {
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      expect(store[key].value, key).toBe(before[key])
    }
  }

  async function activeQueue() {
    const activeRegistry = registry(['youtube', 1])
    const loadRegistry = vi.fn(async () => activeRegistry)
    const resolve = vi.fn(resolveTrack)
    const store = createPlaybackStore({ loadRegistry, resolve })
    for (const track of [first, second, third, fourth]) store.enqueue(track)
    await store.playQueueIndex(1)
    await store.setSourceOverride('youtube')
    store.reportMediaState('playing', store.playbackGeneration.value)
    return { store, loadRegistry, resolve, activeRegistry }
  }

  const mutations = [
    { name: 'move current forward', apply: (store: PlaybackStore) => store.moveQueueItem(1, 3), ids: ['first', 'third', 'fourth', 'second'], index: 3 },
    { name: 'move current backward', apply: (store: PlaybackStore) => store.moveQueueItem(1, 0), ids: ['second', 'first', 'third', 'fourth'], index: 0 },
    { name: 'move another row backward across current', apply: (store: PlaybackStore) => store.moveQueueItem(3, 0), ids: ['fourth', 'first', 'second', 'third'], index: 2 },
    { name: 'move another row forward across current', apply: (store: PlaybackStore) => store.moveQueueItem(0, 3), ids: ['second', 'third', 'fourth', 'first'], index: 0 },
    { name: 'remove history', apply: (store: PlaybackStore) => store.removeQueueIndex(0), ids: ['second', 'third', 'fourth'], index: 0 },
    { name: 'remove upcoming', apply: (store: PlaybackStore) => store.removeQueueIndex(2), ids: ['first', 'second', 'fourth'], index: 1 },
    { name: 'clear upcoming', apply: (store: PlaybackStore) => store.clearUpcomingQueue(), ids: ['first', 'second'], index: 1 },
    { name: 'play next existing canonical ID', apply: (store: PlaybackStore) => store.playNext({ ...fourth }), ids: ['first', 'second', 'fourth', 'third'], index: 1 },
    { name: 'play next new track', apply: (store: PlaybackStore) => store.playNext(fifth), ids: ['first', 'second', 'fifth', 'third', 'fourth'], index: 1 },
    { name: 'reconcile upcoming', apply: (store: PlaybackStore) => store.reconcileUpcomingQueue([fifth, fourth]), ids: ['first', 'second', 'fourth', 'fifth'], index: 1 },
  ]

  it.each(mutations)('preserves paused playback and source state: $name', async ({ apply, ids, index }) => {
    const { store, resolve, loadRegistry } = await activeQueue()
    store.reportMediaState('paused', store.playbackGeneration.value)
    const before = playbackSnapshot(store)
    const previousQueue = store.queue.value

    apply(store)

    expect(store.queue.value.map(({ id }) => id)).toEqual(ids)
    expect(store.queue.value).not.toBe(previousQueue)
    expect(previousQueue.map(({ id }) => id)).toEqual(['first', 'second', 'third', 'fourth'])
    expect(store.currentIndex.value).toBe(index)
    expectPlaybackUnchanged(store, before)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(loadRegistry).toHaveBeenCalledTimes(2)
  })

  describe.each(['registry', 'resolver'] as const)('pending %s', (stage) => {
    it.each(mutations)('allows the original request to settle after $name', async ({ apply, ids, index }) => {
      const { store, resolve, loadRegistry, activeRegistry } = await activeQueue()
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((done) => { release = done })
      const reachedStage = new Promise<void>((done) => { entered = done })
      if (stage === 'registry') {
        loadRegistry.mockImplementationOnce(async () => {
          entered()
          await gate
          return activeRegistry
        })
      } else {
        resolve.mockImplementationOnce(async (track, providers, options) => {
          entered()
          await gate
          return resolveTrack(track, providers, options)
        })
      }
      const pending = store.setSourceOverride('youtube')
      await reachedStage
      const before = playbackSnapshot(store)
      const resolveCount = resolve.mock.calls.length
      expect(store.status.value).toBe('resolving')
      expect(store.playable.value).toBeNull()
      expect(resolveCount).toBe(stage === 'registry' ? 2 : 3)

      try {
        apply(store)

        expect(store.queue.value.map(({ id }) => id)).toEqual(ids)
        expect(store.currentIndex.value).toBe(index)
        expectPlaybackUnchanged(store, before)
        expect(resolve).toHaveBeenCalledTimes(resolveCount)
        expect(loadRegistry).toHaveBeenCalledTimes(3)
      } finally {
        release()
        await pending
      }

      expect(store.currentTrack.value).toBe(second)
      expect(store.playbackGeneration.value).toBe(before.playbackGeneration)
      expect(store.playbackIntent.value).toBe('playing')
      expect(store.sourceOverride.value).toBe('youtube')
      expect(store.status.value).toBe('ready')
      expect(store.activeProviderId.value).toBe('youtube')
      expect(store.playable.value).toEqual({ kind: 'youtube', videoId: 'lmnopqrstuv' })
      expect(store.attempts.value).toMatchObject([{ providerId: 'youtube', ok: true }])
      expect(resolve).toHaveBeenCalledTimes(3)
    })
  })

  it.each([-1, 4, 0.5, NaN, Infinity, -Infinity])('rejects invalid mutation index %s without changing the queue', async (index) => {
    const { store, resolve } = await activeQueue()
    const queue = store.queue.value
    const before = playbackSnapshot(store)

    expect(store.removeQueueIndex(index)).toBe(false)
    expect(store.moveQueueItem(index, 0)).toBe(false)
    expect(store.moveQueueItem(0, index)).toBe(false)

    expect(store.queue.value).toBe(queue)
    expect(store.currentIndex.value).toBe(1)
    expectPlaybackUnchanged(store, before)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('protects the current canonical row and treats a valid same-index move as a no-op', async () => {
    const { store, resolve } = await activeQueue()
    const queue = store.queue.value
    const before = playbackSnapshot(store)

    expect(store.removeQueueIndex(1)).toBe(false)
    expect(store.moveQueueItem(1, 1)).toBe(true)
    store.playNext({ ...second, title: 'Refreshed current' })

    expect(store.queue.value).toBe(queue)
    expect(store.currentIndex.value).toBe(1)
    expectPlaybackUnchanged(store, before)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('moves a requested historical canonical track after current rather than copying it', async () => {
    const { store, resolve } = await activeQueue()
    const before = playbackSnapshot(store)

    store.playNext({ ...first })

    expect(store.queue.value.map(({ id }) => id)).toEqual(['second', 'first', 'third', 'fourth'])
    expect(store.currentIndex.value).toBe(0)
    expect(store.queue.value[1]).toBe(first)
    expectPlaybackUnchanged(store, before)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it.each(['fresh', 'stopped'])('keeps all queue mutations non-playing with no current (%s)', async (state) => {
    const resolve = vi.fn(resolveTrack)
    const store = createPlaybackStore({ resolve, registry: registry(['youtube', 1]) })
    for (const track of [first, second, third]) store.enqueue(track)
    if (state === 'stopped') {
      await store.playQueueIndex(1)
      store.stop()
    }
    const before = playbackSnapshot(store)
    const resolveCount = resolve.mock.calls.length

    store.playNext({ ...third })
    expect(store.queue.value.map(({ id }) => id)).toEqual(['third', 'first', 'second'])
    expectPlaybackUnchanged(store, before)
    store.playNext(fourth)
    expect(store.queue.value.map(({ id }) => id)).toEqual(['fourth', 'third', 'first', 'second'])
    expectPlaybackUnchanged(store, before)
    expect(store.removeQueueIndex(2)).toBe(true)
    expect(store.moveQueueItem(2, 0)).toBe(true)
    expect(store.queue.value.map(({ id }) => id)).toEqual(['second', 'fourth', 'third'])
    expectPlaybackUnchanged(store, before)
    store.reconcileUpcomingQueue(Object.freeze([first, third, { ...first }]))
    expect(store.queue.value.map(({ id }) => id)).toEqual(['third', 'first'])
    expectPlaybackUnchanged(store, before)
    store.clearUpcomingQueue()
    expect(store.queue.value).toEqual([])
    expect(store.removeQueueIndex(0)).toBe(false)
    expect(store.moveQueueItem(0, 0)).toBe(false)
    expectPlaybackUnchanged(store, before)
    store.reconcileUpcomingQueue([first, { ...first }, second])
    expect(store.queue.value.map(({ id }) => id)).toEqual(['first', 'second'])
    expect(store.currentIndex.value).toBe(-1)
    expectPlaybackUnchanged(store, before)
    expect(resolve).toHaveBeenCalledTimes(resolveCount)
  })

  it('refreshes upcoming source data, appends new matches, and leaves history/current objects untouched', async () => {
    const { store, resolve } = await activeQueue()
    const before = playbackSnapshot(store)
    const refreshedThird = { ...third, title: 'Refreshed third', sources: [{ provider: 'youtube', externalId: 'zyxwvutsrqp' }] }
    const filtered = Object.freeze([fifth, { ...first }, { ...second }, fourth, refreshedThird, { ...fifth }])

    store.reconcileUpcomingQueue(filtered)

    expect(store.queue.value.map(({ id }) => id)).toEqual(['first', 'second', 'third', 'fourth', 'fifth'])
    expect(store.queue.value[0]).toBe(first)
    expect(store.queue.value[1]).toBe(second)
    expect(store.queue.value[2]).toBe(refreshedThird)
    expect(store.queue.value[4]).toBe(fifth)
    expect(store.currentIndex.value).toBe(1)
    expectPlaybackUnchanged(store, before)
    expect(resolve).toHaveBeenCalledTimes(2)

    await store.next()

    expect(store.currentTrack.value).toBe(refreshedThird)
    expect(store.playable.value).toEqual({ kind: 'youtube', videoId: 'zyxwvutsrqp' })
    expect(store.playbackGeneration.value).toBe(before.playbackGeneration + 1)
    expect(store.playbackIntent.value).toBe('playing')
  })

  it('refreshes only existing upcoming rows without appending absent matching IDs', async () => {
    const { store } = await activeQueue()
    const before = playbackSnapshot(store)
    const refreshedThird = { ...third, title: 'Refreshed third', sources: [{ provider: 'youtube', externalId: 'zyxwvutsrqp' }] }
    store.refreshQueuedTracks([fifth, refreshedThird, fourth])

    expect(store.queue.value.map(({ id }) => id)).toEqual(['first', 'second', 'third', 'fourth'])
    expect(store.queue.value[2]).toBe(refreshedThird)
    expect(store.queue.value[3]).toBe(fourth)
    expectPlaybackUnchanged(store, before)
  })

  it('retains unmatched history/current on empty reconciliation and repopulates only on another reconciliation', async () => {
    const { store, resolve } = await activeQueue()
    const before = playbackSnapshot(store)

    store.reconcileUpcomingQueue([])

    expect(store.queue.value).toEqual([first, second])
    expectPlaybackUnchanged(store, before)
    await store.next()
    expectPlaybackUnchanged(store, before)
    store.reconcileUpcomingQueue([third, first, second, fourth, third])
    expect(store.queue.value).toEqual([first, second, third, fourth])
    expect(store.removeQueueIndex(2)).toBe(true)
    store.clearUpcomingQueue()
    expect(store.queue.value).toEqual([first, second])
    expectPlaybackUnchanged(store, before)
    store.reconcileUpcomingQueue([fourth, third])
    expect(store.queue.value).toEqual([first, second, fourth, third])
    expectPlaybackUnchanged(store, before)
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('preserves runtime-failed provider exclusions and attempt history through pure mutations', async () => {
    const r2: AudioProvider = {
      id: 'r2',
      resolve: vi.fn(async () => ({ kind: 'audio' as const, url: 'https://media.invalid/first.ogg', mimeType: 'audio/ogg' })),
    }
    const youtube = provider('youtube')
    const store = createPlaybackStore({ registry: new ProviderRegistry([
      { provider: r2, enabled: true, priority: 1, timeoutMs: 100 },
      { provider: youtube, enabled: true, priority: 2, timeoutMs: 100 },
    ]) })
    await store.playNow(multiSource)
    await store.reportPlaybackFailure('r2', store.playbackGeneration.value)
    const before = playbackSnapshot(store)
    for (const track of [second, third, fourth]) store.enqueue(track)

    store.moveQueueItem(0, 1)
    store.removeQueueIndex(0)
    store.playNext(second)
    store.reconcileUpcomingQueue([third, fourth])
    store.clearUpcomingQueue()

    expect(store.queue.value).toEqual([multiSource])
    expectPlaybackUnchanged(store, before)
    await store.reportPlaybackFailure('youtube', store.playbackGeneration.value)
    expect(store.status.value).toBe('error')
    expect(store.playable.value).toBeNull()
    expect(store.attempts.value).toMatchObject([
      { providerId: 'r2', ok: false, code: 'unavailable' },
      { providerId: 'youtube', ok: false, code: 'unavailable' },
    ])
    expect(r2.resolve).toHaveBeenCalledTimes(1)
    expect(youtube.resolve).toHaveBeenCalledTimes(1)
  })

  it('clears runtime failure exclusions and retries providers when user explicitly triggers play() on an errored track', async () => {
    let r2Attempts = 0
    const r2: AudioProvider = {
      id: 'r2',
      resolve: vi.fn(async () => {
        r2Attempts += 1
        return { kind: 'audio' as const, url: `https://media.invalid/track-${r2Attempts}.mp3`, mimeType: 'audio/mpeg' }
      }),
    }
    const store = createPlaybackStore({
      registry: new ProviderRegistry([
        { provider: r2, enabled: true, priority: 1, timeoutMs: 100 },
      ]),
    })

    await store.playNow(multiSource)
    expect(store.status.value).toBe('ready')
    expect(store.playable.value).not.toBeNull()
    expect(r2.resolve).toHaveBeenCalledTimes(1)

    // Report runtime playback failure on r2
    await store.reportPlaybackFailure('r2', store.playbackGeneration.value)
    expect(store.status.value).toBe('error')
    expect(store.playable.value).toBeNull()

    // User explicitly retries playback via play()
    await store.play()
    expect(r2.resolve).toHaveBeenCalledTimes(2)
    expect(store.status.value).toBe('ready')
    expect(store.playable.value).not.toBeNull()
  })

  it('clears runtime failure exclusions when queued tracks are refreshed with replacement metadata', async () => {
    let r2Attempts = 0
    const r2: AudioProvider = {
      id: 'r2',
      resolve: vi.fn(async () => {
        r2Attempts += 1
        return { kind: 'audio' as const, url: `https://media.invalid/track-${r2Attempts}.mp3`, mimeType: 'audio/mpeg' }
      }),
    }
    const store = createPlaybackStore({
      registry: new ProviderRegistry([
        { provider: r2, enabled: true, priority: 1, timeoutMs: 100 },
      ]),
    })

    await store.prepareQueueIndex(0)
    // Put track into queue with prepareQueueIndex
    const initialTrack = { ...multiSource, id: 'track-to-refresh' }
    store.enqueue(initialTrack)
    await store.prepareQueueIndex(0)
    expect(store.status.value).toBe('ready')

    // Simulate playback failure
    await store.reportPlaybackFailure('r2', store.playbackGeneration.value)
    expect(store.status.value).toBe('error')

    // Refresh queued tracks with updated track object
    const updatedTrack = { ...initialTrack, title: 'Updated Title' }
    store.refreshQueuedTracks([updatedTrack])

    // Wait for resolveCurrent triggered by refreshQueuedTracks to complete
    await vi.waitFor(() => {
      expect(r2.resolve).toHaveBeenCalledTimes(2)
      expect(store.status.value).toBe('ready')
    })
  })

  it('preserves manual sourceOverride for capability-based provider when canResolve returns true', async () => {
    const lxProvider: AudioProvider = {
      id: 'lx',
      canResolve: (track) => track.sources.some((s) => s.provider === 'chksz'),
      resolve: vi.fn(async () => ({
        kind: 'audio' as const,
        url: 'https://lx.example/audio.mp3',
        mimeType: 'audio/mpeg',
      })),
    }
    const store = createPlaybackStore({
      registry: new ProviderRegistry([
        { provider: lxProvider, enabled: true, priority: 10, timeoutMs: 100 },
      ]),
    })

    const track = {
      id: 'test-track',
      title: 'Test',
      aliases: {},
      games: ['genshin'],
      relationIds: [],
      tabs: ['chill'],
      workGroupId: 'wg',
      needsClassification: false,
      vocalStatus: 'instrumental',
      sources: [{ provider: 'chksz', externalId: '12345' }],
    } as Track

    await store.playNow(track)
    await store.setSourceOverride('lx')

    expect(store.sourceOverride.value).toBe('lx')
    expect(store.activeProviderId.value).toBe('lx')
    expect(store.status.value).toBe('ready')
    expect(lxProvider.resolve).toHaveBeenCalled()
  })

  describe('strict manual override playback flow', () => {
    it('never falls through to another provider when an explicit override fails (LX fails, Jellyfin would succeed)', async () => {
      const lxResolve = vi.fn().mockResolvedValue(null)
      const jellyfinResolve = vi.fn().mockResolvedValue({
        kind: 'audio' as const,
        url: 'https://jellyfin.example/audio.mp3',
        mimeType: 'audio/mpeg',
      })
      const store = createPlaybackStore({
        registry: new ProviderRegistry([
          {
            provider: {
              id: 'lx',
              canResolve: () => true,
              resolve: lxResolve,
            },
            enabled: true,
            priority: 1,
            timeoutMs: 100,
          },
          {
            provider: {
              id: 'jellyfin',
              canResolve: () => true,
              resolve: jellyfinResolve,
            },
            enabled: true,
            priority: 2,
            timeoutMs: 100,
          },
        ]),
      })

      const track = {
        id: 'test-track',
        title: 'Test Track',
        aliases: {},
        games: ['genshin'],
        relationIds: [],
        tabs: ['focus'],
        workGroupId: 'wg',
        vocalStatus: 'instrumental',
        needsClassification: false,
        sources: [{ provider: 'jellyfin', externalId: 'jf-123' }],
      } as Track

      await store.playNow(track)
      jellyfinResolve.mockClear()

      await store.setSourceOverride('lx')

      expect(store.sourceOverride.value).toBe('lx')
      expect(store.status.value).toBe('error')
      expect(store.playable.value).toBeNull()
      expect(store.activeProviderId.value).toBeUndefined()
      expect(jellyfinResolve).not.toHaveBeenCalled()
      expect(store.attempts.value.length).toBeGreaterThan(0)
      expect(store.attempts.value.every((a) => a.providerId === 'lx')).toBe(true)
      expect(store.attempts.value.some((a) => a.providerId === 'lx' && !a.ok)).toBe(true)
    })

    it('surfaces failure and preserves override when explicit provider is unavailable / disabled', async () => {
      const jellyfinResolve = vi.fn().mockResolvedValue({
        kind: 'audio' as const,
        url: 'https://jellyfin.example/audio.mp3',
        mimeType: 'audio/mpeg',
      })
      const store = createPlaybackStore({
        registry: new ProviderRegistry([
          {
            provider: { id: 'lx', resolve: vi.fn() },
            enabled: false,
            priority: 1,
            timeoutMs: 100,
          },
          {
            provider: { id: 'jellyfin', canResolve: () => true, resolve: jellyfinResolve },
            enabled: true,
            priority: 2,
            timeoutMs: 100,
          },
        ]),
      })

      const track = {
        id: 'test-track',
        title: 'Test Track',
        aliases: {},
        games: ['genshin'],
        relationIds: [],
        tabs: ['focus'],
        workGroupId: 'wg',
        vocalStatus: 'instrumental',
        needsClassification: false,
        sources: [{ provider: 'jellyfin', externalId: 'jf-123' }],
      } as Track

      await store.playNow(track)
      jellyfinResolve.mockClear()

      await store.setSourceOverride('lx')

      expect(store.sourceOverride.value).toBe('lx')
      expect(store.status.value).toBe('error')
      expect(store.playable.value).toBeNull()
      expect(store.activeProviderId.value).toBeUndefined()
      expect(jellyfinResolve).not.toHaveBeenCalled()
      expect(store.attempts.value).toEqual([
        { providerId: 'lx', ok: false, code: 'unavailable', latencyMs: 0 },
      ])
    })

    it('surfaces failure and preserves override when explicit provider is not mapped for the track', async () => {
      const jellyfinResolve = vi.fn().mockResolvedValue({
        kind: 'audio' as const,
        url: 'https://jellyfin.example/audio.mp3',
        mimeType: 'audio/mpeg',
      })
      const store = createPlaybackStore({
        registry: new ProviderRegistry([
          {
            provider: {
              id: 'lx',
              canResolve: () => false,
              resolve: vi.fn(),
            },
            enabled: true,
            priority: 1,
            timeoutMs: 100,
          },
          {
            provider: { id: 'jellyfin', canResolve: () => true, resolve: jellyfinResolve },
            enabled: true,
            priority: 2,
            timeoutMs: 100,
          },
        ]),
      })

      const track = {
        id: 'test-track',
        title: 'Test Track',
        aliases: {},
        games: ['genshin'],
        relationIds: [],
        tabs: ['focus'],
        workGroupId: 'wg',
        vocalStatus: 'instrumental',
        needsClassification: false,
        sources: [{ provider: 'jellyfin', externalId: 'jf-123' }],
      } as Track

      await store.playNow(track)
      jellyfinResolve.mockClear()

      await store.setSourceOverride('lx')

      expect(store.sourceOverride.value).toBe('lx')
      expect(store.status.value).toBe('error')
      expect(store.playable.value).toBeNull()
      expect(store.activeProviderId.value).toBeUndefined()
      expect(jellyfinResolve).not.toHaveBeenCalled()
      expect(store.attempts.value).toEqual([
        { providerId: 'lx', ok: false, code: 'not_mapped', latencyMs: 0 },
      ])
    })

    it('surfaces failure and preserves override when explicit provider encounters a runtime media error', async () => {
      const jellyfinResolve = vi.fn().mockResolvedValue({
        kind: 'audio' as const,
        url: 'https://jellyfin.example/audio.mp3',
        mimeType: 'audio/mpeg',
      })
      const lxResolve = vi.fn().mockResolvedValue({
        kind: 'audio' as const,
        url: 'https://lx.example/broken.mp3',
        mimeType: 'audio/mpeg',
      })
      const store = createPlaybackStore({
        registry: new ProviderRegistry([
          {
            provider: { id: 'lx', canResolve: () => true, resolve: lxResolve },
            enabled: true,
            priority: 1,
            timeoutMs: 100,
          },
          {
            provider: { id: 'jellyfin', canResolve: () => true, resolve: jellyfinResolve },
            enabled: true,
            priority: 2,
            timeoutMs: 100,
          },
        ]),
      })

      const track = {
        id: 'test-track',
        title: 'Test Track',
        aliases: {},
        games: ['genshin'],
        relationIds: [],
        tabs: ['focus'],
        workGroupId: 'wg',
        vocalStatus: 'instrumental',
        needsClassification: false,
        sources: [{ provider: 'jellyfin', externalId: 'jf-123' }],
      } as Track

      await store.playNow(track)
      await store.setSourceOverride('lx')
      expect(store.activeProviderId.value).toBe('lx')
      jellyfinResolve.mockClear()

      await store.reportPlaybackFailure('lx', store.playbackGeneration.value)

      expect(store.sourceOverride.value).toBe('lx')
      expect(store.status.value).toBe('error')
      expect(store.playable.value).toBeNull()
      expect(store.activeProviderId.value).toBeUndefined()
      expect(jellyfinResolve).not.toHaveBeenCalled()
      expect(store.attempts.value).toContainEqual(
        expect.objectContaining({ providerId: 'lx', ok: false, code: 'unavailable' }),
      )
    })

    it('surfaces failure and preserves override when explicit provider requires credential (credential_required)', async () => {
      const jellyfinResolve = vi.fn().mockResolvedValue({
        kind: 'audio' as const,
        url: 'https://jellyfin.example/audio.mp3',
        mimeType: 'audio/mpeg',
      })
      const { ProviderResolveError } = await import('./providers/types')
      const chkszResolve = vi.fn().mockRejectedValue(new ProviderResolveError('credential_required'))
      const store = createPlaybackStore({
        registry: new ProviderRegistry([
          {
            provider: { id: 'chksz', canResolve: () => true, resolve: chkszResolve },
            enabled: true,
            priority: 1,
            timeoutMs: 100,
          },
          {
            provider: { id: 'jellyfin', canResolve: () => true, resolve: jellyfinResolve },
            enabled: true,
            priority: 2,
            timeoutMs: 100,
          },
        ]),
      })

      const track = {
        id: 'test-track',
        title: 'Test Track',
        aliases: {},
        games: ['genshin'],
        relationIds: [],
        tabs: ['focus'],
        workGroupId: 'wg',
        vocalStatus: 'instrumental',
        needsClassification: false,
        sources: [{ provider: 'chksz', externalId: 'chk-1' }, { provider: 'jellyfin', externalId: 'jf-1' }],
      } as Track

      await store.playNow(track)
      jellyfinResolve.mockClear()

      await store.setSourceOverride('chksz')

      expect(store.sourceOverride.value).toBe('chksz')
      expect(store.status.value).toBe('error')
      expect(store.playable.value).toBeNull()
      expect(store.activeProviderId.value).toBeUndefined()
      expect(jellyfinResolve).not.toHaveBeenCalled()
      expect(store.attempts.value).toEqual([
        expect.objectContaining({ providerId: 'chksz', ok: false, code: 'credential_required' }),
      ])
    })
  })

  describe('automatic fallback flow', () => {
    it('falls through to the next provider when automatic resolution encounters a failure (LX fails, Jellyfin succeeds)', async () => {
      const lxResolve = vi.fn().mockResolvedValue(null)
      const jellyfinResolve = vi.fn().mockResolvedValue({
        kind: 'audio' as const,
        url: 'https://jellyfin.example/audio.mp3',
        mimeType: 'audio/mpeg',
      })
      const store = createPlaybackStore({
        registry: new ProviderRegistry([
          {
            provider: {
              id: 'lx',
              canResolve: () => true,
              resolve: lxResolve,
            },
            enabled: true,
            priority: 1,
            timeoutMs: 100,
          },
          {
            provider: {
              id: 'jellyfin',
              canResolve: () => true,
              resolve: jellyfinResolve,
            },
            enabled: true,
            priority: 2,
            timeoutMs: 100,
          },
        ]),
      })

      const track = {
        id: 'test-track',
        title: 'Test Track',
        aliases: {},
        games: ['genshin'],
        relationIds: [],
        tabs: ['focus'],
        workGroupId: 'wg',
        vocalStatus: 'instrumental',
        needsClassification: false,
        sources: [{ provider: 'jellyfin', externalId: 'jf-123' }],
      } as Track

      await store.playNow(track)

      expect(store.sourceOverride.value).toBeUndefined()
      expect(store.status.value).toBe('ready')
      expect(store.activeProviderId.value).toBe('jellyfin')
      expect(store.playable.value).toEqual({
        kind: 'audio',
        url: 'https://jellyfin.example/audio.mp3',
        mimeType: 'audio/mpeg',
      })
      expect(lxResolve).toHaveBeenCalled()
      expect(jellyfinResolve).toHaveBeenCalled()
      expect(store.attempts.value).toEqual([
        expect.objectContaining({ providerId: 'lx', ok: false }),
        expect.objectContaining({ providerId: 'jellyfin', ok: true }),
      ])
    })
  })
})
