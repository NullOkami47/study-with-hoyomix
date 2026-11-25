import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { createPlaybackStore } from './store'
import { ProviderRegistry } from './providers/registry'
import type { AudioProvider } from './providers/types'
import type { ResolveOptions, ResolveResult } from './resolver'

const tracks = ['a', 'b', 'c'].map((id) => ({ id, title: id, sources: [{ provider: 'gd-studio', externalId: `netease:${id}:320` }] } as Track))
const success = (track: Track): ResolveResult => ({ ok: true, providerId: 'gd-studio', playable: { kind: 'audio', url: `https://media.invalid/gd-studio/${track.id}.mp3`, mimeType: 'audio/mpeg' }, attempts: [] })
async function setup(resolve = vi.fn(async (track: Track) => success(track))) {
  const store = createPlaybackStore({ resolve })
  store.reconcileUpcomingQueue(tracks)
  await store.prepareQueueIndex(0)
  store.setPreloadPolicy('auto')
  await store.armNextPreparation()
  await flushPromises()
  return { store, resolve }
}

beforeEach(() => window.localStorage.setItem('hoyomix-player-shuffle-v1', 'false'))

describe('isolated next-track preparation', () => {
  it('resolves only the next third-party item inside the lead window without mutating active state or intent', async () => {
    const { store, resolve } = await setup()
    expect(resolve.mock.calls.map(([track]) => track.id)).toEqual(['a', 'b'])
    expect(store.preparedNext.value?.track).toBe(tracks[1])
    expect(store.currentTrack.value).toBe(tracks[0])
    expect(store.currentIndex.value).toBe(0)
    expect(store.playbackIntent.value).toBe('paused')
    expect(store.status.value).toBe('ready')
    expect(store.attempts.value).toEqual([])
    store.dispose()
  })

  it('adopts a fresh preparation on Next instead of resolving the track a second time', async () => {
    const { store, resolve } = await setup()
    const prepared = store.preparedNext.value
    await store.next()
    await flushPromises()
    // The already prepared result is adopted; 'c' waits for its own bounded lead window.
    expect(resolve.mock.calls.map(([track]) => track.id)).toEqual(['a', 'b'])
    expect(store.preloadHandoff.value?.id).toBe(prepared?.id)
    expect(store.preloadHandoff.value?.generation).toBe(store.playbackGeneration.value)
    expect(store.playable.value).toEqual(prepared?.playable)
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.status.value).toBe('ready')
    store.releasePreloadHandoff(store.playbackGeneration.value - 1)
    expect(store.preloadHandoff.value).not.toBeNull()
    store.releasePreloadHandoff(store.playbackGeneration.value)
    expect(store.preloadHandoff.value).toBeNull()
    store.dispose()
  })

  it('re-arms the same next track after a preference invalidates its armed preparation', async () => {
    const lxTracks = ['a', 'b'].map((id) => ({
      id, title: id, sources: [{ provider: 'lx', externalId: `wy:${id}` }],
    } as Track))
    const resolve = vi.fn(async (track: Track): Promise<ResolveResult> => ({
      ok: true, providerId: 'lx', attempts: [],
      playable: { kind: 'audio', url: `https://media.invalid/${track.id}.mp3`, mimeType: 'audio/mpeg' },
    }))
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(lxTracks)
    await store.prepareQueueIndex(0)
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    store.invalidatePreload()
    await flushPromises()
    const before = resolve.mock.calls.filter(([track]) => track.id === 'b').length
    await store.armNextPreparation()
    expect(resolve.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(before + 1)
    expect(store.preparedNext.value?.armed).toBe(true)
    store.dispose()
  })

  it('waits for an in-flight third-party resolve instead of resolving the same next track twice', async () => {
    let finish: ((result: ResolveResult) => void) | undefined
    const resolve = vi.fn(async (track: Track): Promise<ResolveResult> =>
      track.id === 'b' ? new Promise(settle => { finish = settle }) : success(track))
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    store.setPreloadPolicy('auto')
    const pending = store.armNextPreparation()
    await flushPromises()
    expect(resolve.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(1)

    const armed = store.armNextPreparation()
    expect(resolve.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(1)
    finish?.(success(tracks[1]))
    await Promise.all([armed, pending])
    expect(store.preparedNext.value?.armed).toBe(true)
    store.dispose()
  })

  it('does not reuse a manual provider preparation after Next switches back to automatic mode', async () => {
    const both = ['a', 'b'].map((id) => ({
      id, title: id, sources: [
        { provider: 'jellyfin', externalId: `item-${id}` },
        { provider: 'chksz', externalId: `id-${id}` },
      ],
    } as Track))
    const provider = (id: string): AudioProvider => ({ id, resolve: async () => null })
    const registry = new ProviderRegistry([
      { provider: provider('jellyfin'), enabled: true, priority: 1, timeoutMs: 1000 },
      { provider: provider('chksz'), enabled: true, priority: 2, timeoutMs: 1000 },
    ])
    const resolve = vi.fn(async (track: Track, _registry: unknown, options?: ResolveOptions): Promise<ResolveResult> => ({
      ok: true, providerId: options?.sourceOverride ?? 'jellyfin', attempts: [],
      playable: { kind: 'audio', url: `https://media.invalid/${options?.sourceOverride ?? 'jellyfin'}/${track.id}.mp3`, mimeType: 'audio/mpeg' },
    }))
    const store = createPlaybackStore({ resolve, registry })
    store.reconcileUpcomingQueue(both)
    await store.prepareQueueIndex(0)
    store.setPreloadPolicy('auto')
    await store.setSourceOverride('chksz')
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('chksz')

    await store.next()
    expect(store.sourceOverride.value).toBeUndefined()
    expect(store.activeProviderId.value).toBe('jellyfin')
    expect(resolve.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(2)
    store.dispose()
  })

  it('releases a promoted handoff when playback stops before the deck consumes it', async () => {
    const { store } = await setup()
    await store.next()
    expect(store.preloadHandoff.value).not.toBeNull()

    store.stop()

    expect(store.preloadHandoff.value).toBeNull()
    store.dispose()
  })

  it.each(['reorder', 'remove', 'clear', 'replace', 'offline', 'constrained', 'source', 'preferences', 'dispose'])(
    'aborts and ignores late preparation on %s', async (change) => {
      const finishers: Array<(value: ResolveResult) => void> = []
      const signals: AbortSignal[] = []
      const resolve = vi.fn(async (track: Track, _registry: unknown, options?: ResolveOptions): Promise<ResolveResult> => {
        if (track === tracks[1]) {
          signals.push(options!.signal!)
          return new Promise((settle) => { finishers.push(settle) })
        }
        return success(track)
      })
      const store = createPlaybackStore({ resolve })
      store.reconcileUpcomingQueue(tracks)
      await store.prepareQueueIndex(0)
      store.setPreloadPolicy('auto')
      const pending = store.armNextPreparation()
      await flushPromises()
      if (change === 'reorder') store.moveQueueItem(1, 2)
      if (change === 'remove') store.removeQueueIndex(1)
      if (change === 'clear') store.clearUpcomingQueue()
      if (change === 'replace') store.refreshQueuedTracks([tracks[0], { ...tracks[1] }, tracks[2]])
      if (change === 'offline') store.setPreloadPolicy('none')
      if (change === 'constrained') store.setPreloadPolicy('metadata')
      if (change === 'source') await store.setSourceOverride('youtube')
      if (change === 'preferences') store.invalidatePreload()
      if (change === 'dispose') store.dispose()
      expect(signals[0]?.aborted).toBe(true)
      finishers[0]?.(success(tracks[1]))
      await pending
      await flushPromises()
      expect(store.preparedNext.value?.track).not.toBe(tracks[1])
      expect(store.currentTrack.value?.id).toBe(change === 'clear' ? undefined : 'a')
      store.dispose()
    },
  )

  it('does not surface failed third-party preparation on the active song', async () => {
    const resolve = vi.fn(async (track: Track, _registry: unknown, options?: ResolveOptions): Promise<ResolveResult> => {
      if (track.id === 'b') {
        options?.onAttempt?.({ providerId: 'gd-studio', ok: false, code: 'unavailable', latencyMs: 0 })
        throw new Error('speculative failure')
      }
      return success(track)
    })
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    await flushPromises()
    expect(store.preparedNext.value).toBeNull()
    expect(store.attempts.value).toEqual([])
    expect(store.status.value).toBe('ready')
    expect(store.playable.value).toEqual((success(tracks[0]) as { playable: unknown }).playable)
    store.dispose()
  })

  it('falls back to a fresh resolve when the preparation is stale, discarding the drifted handoff', async () => {
    // A resolved media URL carries a transient ticket that is not refreshed on use, so a
    // preparation older than its validity window must never be promoted. `preparationValidityMs: 0`
    // makes every preparation stale, which is the only way to reach this path deterministically.
    let bCalls = 0
    const resolve = vi.fn(async (track: Track) => {
      const result = success(track)
      if (track.id === 'b' && ++bCalls > 1 && result.ok && result.playable.kind === 'audio') {
        result.playable.url += '?revision=2'
      }
      return result
    })
    const store = createPlaybackStore({ resolve, preparationValidityMs: 0 })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    await flushPromises()
    await new Promise((settle) => setTimeout(settle, 5))
    await store.next()

    expect(resolve.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(2)
    // The re-resolved URL no longer matches the armed deck, so the handoff is dropped rather than
    // promoting an element that holds a URL the resolver did not return.
    expect(store.preloadHandoff.value).toBeNull()
    store.dispose()
  })

  it('does not speculatively resolve YouTube or other third-party-only items', async () => {
    const { store, resolve } = await setup()
    store.refreshQueuedTracks([tracks[0], { ...tracks[1], sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }] }, tracks[2]])
    resolve.mockClear()
    await flushPromises()
    expect(resolve).not.toHaveBeenCalled()
    expect(store.preparedNext.value).toBeNull()
    store.dispose()
  })

  it('never resolves R2 during next-track speculative preload', async () => {
    const r2Tracks = ['r1', 'r2'].map((id) => ({
      id,
      title: id,
      sources: [{ provider: 'r2', externalId: `${id}.mp3` }],
    } as Track))
    const resolve = vi.fn(async (track: Track): Promise<ResolveResult> => ({
      ok: true,
      providerId: 'r2',
      playable: { kind: 'audio', url: `https://media.invalid/${track.id}.mp3`, mimeType: 'audio/mpeg' },
      attempts: [],
    }))
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(r2Tracks)
    await store.prepareQueueIndex(0)
    resolve.mockClear()
    store.setPreloadPolicy('auto')
    await flushPromises()

    expect(resolve).not.toHaveBeenCalled()
    expect(store.preparedNext.value).toBeNull()
    store.dispose()
  })

  it('never resolves ChKSz during next-track speculative preload even when ChKSz BYOK is effective priority 1', async () => {
    const chkszTracks = ['c1', 'c2'].map((id) => ({
      id,
      title: id,
      sources: [
        { provider: 'chksz', externalId: '12345' },
        { provider: 'jellyfin', externalId: `item-${id}` },
      ],
    } as Track))
    const resolve = vi.fn(async (track: Track, _registry: unknown, options?: ResolveOptions): Promise<ResolveResult> => {
      return {
        ok: true,
        providerId: 'chksz',
        playable: { kind: 'audio', url: `https://media.invalid/chksz/${track.id}.mp3`, mimeType: 'audio/mpeg' },
        attempts: [],
      }
    })
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(chkszTracks)
    await store.prepareQueueIndex(0)
    resolve.mockClear()
    store.setPreloadPolicy('auto')
    await flushPromises()

    expect(store.preparedNext.value?.providerId).not.toBe('chksz')
    if (resolve.mock.calls.length > 0) {
      const lastCall = resolve.mock.calls[resolve.mock.calls.length - 1]
      const resolveOptions = lastCall[2] as ResolveOptions | undefined
      expect(resolveOptions?.excludeProviderIds).toContain('chksz')
    }
    store.dispose()
  })

  it('does not resolve any provider before the bounded lead window', async () => {
    const resolve = vi.fn(async (track: Track) => success(track))
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    store.setPreloadPolicy('auto')
    await flushPromises()
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(store.preparedNext.value).toBeNull()
    await store.armNextPreparation()
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(store.preparedNext.value?.providerId).toBe('gd-studio')
    store.dispose()
  })

  /**
   * The armed preparation is the one the transition actually consumes, so unlike the speculative
   * warm-up it is provider-agnostic. These cases pin that difference, and pin that "provider-
   * agnostic" still respects automatic order and a strict manual override.
   */
  describe('armed preparation', () => {
    it('arms the next track for a provider the speculative warm-up never touches', async () => {
      const lxTracks = ['a', 'b'].map((id) => ({
        id, title: id, sources: [{ provider: 'lx', externalId: `wy:${id}` }],
      } as Track))
      const resolve = vi.fn(async (
        track: Track, _registry: unknown, options?: ResolveOptions,
      ): Promise<ResolveResult> => ({
        ok: true,
        providerId: options?.sourceOverride ?? 'lx',
        playable: { kind: 'audio', url: `https://media.invalid/${track.id}.mp3`, mimeType: 'audio/mpeg' },
        attempts: [],
      }))
      const store = createPlaybackStore({ resolve })
      store.reconcileUpcomingQueue(lxTracks)
      await store.prepareQueueIndex(0)
      store.setPreloadPolicy('auto')
      await flushPromises()

      // The warm-up declines LX outright…
      expect(store.preparedNext.value).toBeNull()

      await store.armNextPreparation()
      expect(store.preparedNext.value?.track).toBe(lxTracks[1])
      expect(store.preparedNext.value?.providerId).toBe('lx')
      store.dispose()
    })

    it('pins the request to the manually chosen provider and refuses a substitute answer', async () => {
      const both = ['a', 'b'].map((id) => ({
        id,
        title: id,
        sources: [
          { provider: 'jellyfin', externalId: `item-${id}` },
          { provider: 'chksz', externalId: '12345' },
        ],
      } as Track))
      // A real registry is required here: with none, the manual override is not a registered
      // provider, so `resolveCurrent` rejects it before anything can be armed — which would make
      // this test pass for the wrong reason.
      const stubProvider = (id: string): AudioProvider => ({ id, resolve: async () => null })
      const registry = new ProviderRegistry([
        { provider: stubProvider('chksz'), enabled: true, priority: 1, timeoutMs: 1_000 },
        { provider: stubProvider('jellyfin'), enabled: true, priority: 2, timeoutMs: 1_000 },
      ])
      const requestedOverrides: (string | undefined)[] = []
      const resolve = vi.fn(async (
        track: Track, _registry: unknown, options?: ResolveOptions,
      ): Promise<ResolveResult> => {
        requestedOverrides.push(options?.sourceOverride)
        return {
          ok: true,
          providerId: 'jellyfin',
          playable: { kind: 'audio', url: `https://media.invalid/${track.id}.mp3`, mimeType: 'audio/mpeg' },
          attempts: [],
        }
      })
      const store = createPlaybackStore({ resolve, registry })
      store.reconcileUpcomingQueue(both)
      await store.prepareQueueIndex(0)
      store.setPreloadPolicy('auto')
      await flushPromises()
      await store.setSourceOverride('chksz')
      await store.armNextPreparation()

      expect(requestedOverrides[requestedOverrides.length - 1]).toBe('chksz')
      // The resolver answered with Jellyfin, which is not what was asked for, so nothing is armed.
      // Manual ChKSz can therefore never be satisfied by a Jellyfin recording.
      expect(store.preparedNext.value).toBeNull()
      store.dispose()
    })

    it('does not resolve again while a fresh preparation already exists', async () => {
      const { store, resolve } = await setup()
      const callsBefore = resolve.mock.calls.length
      await store.armNextPreparation()
      expect(resolve.mock.calls.length).toBe(callsBefore)
      store.dispose()
    })

    it('arms nothing while preloading is disabled', async () => {
      const { store, resolve } = await setup()
      store.setPreloadPolicy('none')
      await flushPromises()
      resolve.mockClear()
      await store.armNextPreparation()
      expect(resolve).not.toHaveBeenCalled()
      expect(store.preparedNext.value).toBeNull()
      store.dispose()
    })

    it('arms nothing when the active track is the last one', async () => {
      const { store, resolve } = await setup()
      await store.playQueueIndex(2)
      await flushPromises()
      resolve.mockClear()
      await store.armNextPreparation()
      expect(resolve).not.toHaveBeenCalled()
      store.dispose()
    })

    it('attempts the armed preparation once per track even when it fails', async () => {
      const lxTracks = ['a', 'b'].map((id) => ({
        id, title: id, sources: [{ provider: 'lx', externalId: `wy:${id}` }],
      } as Track))
      const resolve = vi.fn(async (track: Track): Promise<ResolveResult> =>
        track.id === 'b'
          ? { ok: false, code: 'exhausted', attempts: [] }
          : {
              ok: true,
              providerId: 'lx',
              playable: { kind: 'audio', url: `https://media.invalid/${track.id}.mp3`, mimeType: 'audio/mpeg' },
              attempts: [],
            })
      const store = createPlaybackStore({ resolve })
      store.reconcileUpcomingQueue(lxTracks)
      await store.prepareQueueIndex(0)
      store.setPreloadPolicy('auto')
      await flushPromises()
      resolve.mockClear()

      // Media progress fires several times a second, so the caller is expected to ask repeatedly.
      await store.armNextPreparation()
      await store.armNextPreparation()
      await store.armNextPreparation()

      // A preparation that cannot succeed must not become a resolve storm for the whole lead window.
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(store.preparedNext.value).toBeNull()
      store.dispose()
    })

    it('falls back to a fresh resolve when an armed preparation becomes stale before next', async () => {
      const lxTracks = ['a', 'b'].map((id) => ({
        id, title: id, sources: [{ provider: 'lx', externalId: `wy:${id}` }],
      } as Track))
      let bCalls = 0
      const resolve = vi.fn(async (track: Track): Promise<ResolveResult> => {
        if (track.id === 'b') bCalls++
        return {
          ok: true, providerId: 'lx', attempts: [],
          playable: { kind: 'audio', url: `https://media.invalid/${track.id}.mp3?call=${bCalls}`, mimeType: 'audio/mpeg' },
        }
      })
      const store = createPlaybackStore({ resolve, preparationValidityMs: 50 })
      store.reconcileUpcomingQueue(lxTracks)
      await store.prepareQueueIndex(0)
      store.setPreloadPolicy('auto')
      await store.armNextPreparation()
      expect(store.preparedNext.value?.armed).toBe(true)
      expect(bCalls).toBe(1)

      // Wait past preparationValidityMs so preparation becomes stale
      await new Promise((resolve) => setTimeout(resolve, 60))

      await store.next()
      expect(bCalls).toBe(2)
      expect(store.preloadHandoff.value).toBeNull()
      expect(store.playable.value?.kind === 'audio' && store.playable.value.url).toBe('https://media.invalid/b.mp3?call=2')
      store.dispose()
    })

    it('cancels armed preparation when source override changes and re-arms for the manual provider', async () => {
      const both = ['a', 'b'].map((id) => ({
        id,
        title: id,
        sources: [
          { provider: 'jellyfin', externalId: `item-${id}` },
          { provider: 'chksz', externalId: `id-${id}` },
        ],
      } as Track))
      const stubProvider = (id: string): AudioProvider => ({ id, resolve: async () => null })
      const registry = new ProviderRegistry([
        { provider: stubProvider('jellyfin'), enabled: true, priority: 1, timeoutMs: 1_000 },
        { provider: stubProvider('chksz'), enabled: true, priority: 2, timeoutMs: 1_000 },
      ])
      const resolve = vi.fn(async (track: Track, _registry: unknown, options?: ResolveOptions): Promise<ResolveResult> => ({
        ok: true, providerId: options?.sourceOverride ?? 'jellyfin', attempts: [],
        playable: { kind: 'audio', url: `https://media.invalid/${options?.sourceOverride ?? 'jellyfin'}/${track.id}.mp3`, mimeType: 'audio/mpeg' },
      }))
      const store = createPlaybackStore({ resolve, registry })
      store.reconcileUpcomingQueue(both)
      await store.prepareQueueIndex(0)
      store.setPreloadPolicy('auto')
      await store.armNextPreparation()
      expect(store.preparedNext.value?.providerId).toBe('jellyfin')

      // Changing source override cancels the previous preparation
      await store.setSourceOverride('chksz')
      expect(store.preparedNext.value).toBeNull()

      // Re-arming now resolves with the manual provider
      await store.armNextPreparation()
      expect(store.preparedNext.value?.providerId).toBe('chksz')
      store.dispose()
    })
  })
})


// P96-06 (task 8.7a): the ticket-margin adoption rule, the starting state after a handover, and the
// ladder steps counted toward the skip-run bound. Only `Date` is faked, so the clock moves on demand.
describe('handover starting state and ticket margin (P96-06)', () => {
  async function handoverSetup() {
    vi.useFakeTimers({ toFake: ['Date'] })
    const resolve = vi.fn(async (track: Track) => success(track))
    const registry = new ProviderRegistry([{
      provider: { id: 'gd-studio', resolve: async () => null } as unknown as AudioProvider,
      enabled: true, priority: 1, timeoutMs: 100,
    }])
    const store = createPlaybackStore({ resolve, registry })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    await flushPromises()
    expect(store.preparedNext.value?.track.id).toBe('b')
    return { store, resolve, resolvesOfB: () => resolve.mock.calls.filter(([track]) => track.id === 'b').length }
  }

  it.each([[60_000, true], [89_000, true], [91_000, false], [101_000, false]])(
    'at preparation age %i ms, promotes it: %s (30 s of ticket life required)',
    async (age, promoted) => {
      const { store, resolvesOfB } = await handoverSetup()
      try {
        vi.setSystemTime(Date.now() + age)
        await store.next()
        await flushPromises()
        expect(store.currentTrack.value?.id).toBe('b')
        expect(resolvesOfB()).toBe(promoted ? 1 : 2)
        expect(store.awaitingStart.value !== undefined).toBe(promoted)
      } finally { store.dispose(); vi.useRealTimers() }
    },
  )

  it('keeps the starting state through a playing report and ends it on currentTime progress', async () => {
    const { store } = await handoverSetup()
    try {
      await store.next()
      const generation = store.playbackGeneration.value
      expect(store.awaitingStart.value).toEqual({ generation, startPosition: 0 })
      store.reportMediaState('playing', generation)
      expect(store.status.value).toBe('ready')
      store.reportProgress(0, generation)
      expect(store.status.value).toBe('ready')
      store.reportProgress(0.3, generation)
      expect(store.status.value).toBe('playing')
      expect(store.awaitingStart.value).toBeUndefined()
    } finally { store.dispose(); vi.useRealTimers() }
  })

  it('runs step (b) only below the ticket margin and counts every step toward the skip bound', async () => {
    const { store, resolvesOfB } = await handoverSetup()
    try {
      await store.next()
      const generation = store.playbackGeneration.value
      // A valid ticket: step (b) is skipped and not counted.
      expect(await store.recoverHandover('reResolve', generation)).toBe(false)
      expect(await store.recoverHandover('srcSwap', generation)).toBe(true)
      vi.setSystemTime(Date.now() + 95_000)
      expect(await store.recoverHandover('reResolve', generation)).toBe(true)
      expect(resolvesOfB()).toBe(2)
      const renewed = store.playbackGeneration.value
      expect(renewed).toBeGreaterThan(generation)
      expect(store.awaitingStart.value).toEqual({ generation: renewed, startPosition: 0 })
      // Two steps reached the bound of a three-track queue (min(10, n - 1) = 2): straight to the notice.
      expect(await store.recoverHandover('srcSwap', renewed)).toBe(false)
      expect(await store.recoverHandover('notice', renewed)).toBe(true)
      expect(store.status.value).toBe('paused')
      expect(store.playbackIntent.value).toBe('playing')
      expect(store.playbackNotices.value.filter(({ kind }) => kind === 'tapToResume')).toHaveLength(1)
    } finally { store.dispose(); vi.useRealTimers() }
  })
})

describe('speculative provider identity', () => {
  it.each(['armed transition', 'direct queue transition'])('respects GD priority without unnecessary Jellyfin speculation through %s', async (transition) => {
    const providers = ['gd-studio', 'jellyfin'].map((id, index) => ({
      provider: { id, canResolve: () => true, resolve: async () => null },
      enabled: true, priority: index === 0 ? 5 : 30, timeoutMs: 1000,
    }))
    const registry = new ProviderRegistry(providers)
    const resolve = vi.fn(async (track: Track, _registry: ProviderRegistry, options?: ResolveOptions): Promise<ResolveResult> => ({
      ok: true, providerId: options?.sourceOverride ?? 'gd-studio',
      playable: { kind: 'audio', url: 'https://media.invalid/' + track.id + '.mp3', mimeType: 'audio/mpeg' }, attempts: [],
    }))
    const store = createPlaybackStore({ registry, resolve })
    try {
      store.enqueue({ id: 'A', title: 'A', sources: [{ provider: 'chksz', externalId: '12345' }, { provider: 'jellyfin', externalId: 'item-A' }] } as Track)
      store.enqueue({ id: 'B', title: 'B', sources: [{ provider: 'chksz', externalId: '12346' }, { provider: 'jellyfin', externalId: 'item-B' }] } as Track)
      await store.prepareQueueIndex(0)
      resolve.mockClear()
      store.setPreloadPolicy('auto')
      await flushPromises()
      expect(resolve).not.toHaveBeenCalled()
      expect(store.preparedNext.value).toBeNull()
      if (transition === 'armed transition') {
        await store.armNextPreparation()
        expect(resolve.mock.calls[0]?.[2]?.sourceOverride).toBeUndefined()
        expect(resolve.mock.calls[0]?.[2]?.excludeProviderIds).toBeUndefined()
        expect(store.preparedNext.value?.providerId).toBe('gd-studio')
        expect(store.preparedNext.value?.armed).toBe(true)
      }
      await store.playQueueIndex(1)
      expect(store.activeProviderId.value).toBe('gd-studio')
      expect(resolve.mock.calls.filter(([track]) => track.id === 'B')).toHaveLength(1)

    } finally { store.dispose() }
  })
})
