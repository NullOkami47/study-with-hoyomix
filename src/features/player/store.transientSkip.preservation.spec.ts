// Task 41.7 preservation (MUST PASS on the unfixed code and after the fix): permanent failures
// still skip at once with the `skipped` notice, the skip run stays bounded by
// min(MAX_UNAVAILABLE_SKIPS, n - 1) and ends in `queueUnplayable`, and offline still waits (D28).
//
// Real `createPlaybackStore`, the real `resolveTrack` and `ProviderRegistry`, fake timers. No
// timer is advanced past 0 ms before the assertions, so an immediate skip is what is checked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { ProviderRegistry, type ProviderRegistration } from './providers/registry'
import { ProviderResolveError, type AudioProvider, type ResolveFailureCode } from './providers/types'
import { createPlaybackStore, MAX_UNAVAILABLE_SKIPS, type PlaybackStore } from './store'

const sequential = { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} }
const micro = async () => { for (let i = 0; i < 80; i += 1) await Promise.resolve() }
const flush = async () => { await micro(); await vi.advanceTimersByTimeAsync(0); await micro() }

const makeTrack = (id: string, providers: string[] = ['lx']): Track => ({
  id, title: `${id}-title`, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: providers.map((provider) => ({ provider, externalId: `${provider}-${id}` })),
}) as unknown as Track

type Failure = ResolveFailureCode | 'plainError' | 'null' | 'hang'
function lxProvider(fail: (trackId: string) => Failure | undefined) {
  const calls: string[] = []
  const provider = {
    id: 'lx', calls,
    canResolve: (track: Track) => track.sources.some((source) => source.provider === 'lx'),
    resolve: vi.fn(async (track: Track) => {
      calls.push(track.id)
      const failure = fail(track.id)
      if (failure === 'hang') return await new Promise<never>(() => {})
      if (failure === 'null') return null
      if (failure === 'plainError') throw new Error(`lx cannot play ${track.id}`)
      if (failure) throw new ProviderResolveError(failure)
      return { kind: 'audio' as const, url: `https://media.invalid/lx/${track.id}-${calls.length}.mp3`, mimeType: 'audio/mpeg' }
    }),
  }
  return provider as unknown as AudioProvider & { calls: string[] }
}

function setup(tracks: Track[], fail: (trackId: string) => Failure | undefined) {
  const provider = lxProvider(fail)
  const registry = new ProviderRegistry([{ provider, enabled: true, priority: 1, timeoutMs: 100 } as ProviderRegistration])
  const store = createPlaybackStore({ loadRegistry: async () => registry, storage: sequential })
  store.reconcileUpcomingQueue(tracks)
  const resolvesOf = (id: string) => provider.calls.filter((call) => call === id).length
  return { store, provider, resolvesOf }
}
const kinds = (store: PlaybackStore) => store.playbackNotices.value.map((notice) => notice.kind)

beforeEach(() => { window.localStorage.setItem('hoyomix-player-shuffle-v1', 'false'); vi.useFakeTimers() })
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'onLine')
})

describe('41.7 preservation: permanent failures still skip at once', () => {
  it('a next track no provider is mapped for (not_mapped) is skipped immediately with the skipped notice', async () => {
    const { store, resolvesOf } = setup([makeTrack('a'), makeTrack('b', ['jellyfin']), makeTrack('c')], () => undefined)
    try {
      await store.playQueueIndex(0); await flush()
      store.reportMediaState('playing', store.playbackGeneration.value)
      await store.advanceAfterEnded(); await flush()
      expect(store.currentTrack.value?.id).toBe('c')
      expect(store.status.value).toBe('ready')
      expect(resolvesOf('b')).toBe(0)
      expect(store.recentFailures.value.at(-1)?.attempts.map((attempt) => attempt.code)).toEqual(['not_mapped'])
      expect(kinds(store)).toEqual(['skipped'])
      expect(store.playbackNotices.value[0]).toMatchObject({ kind: 'skipped', trackId: 'b', title: 'b-title' })
    } finally { store.dispose() }
  })

  const permanent: Failure[] = [
    'null', 'plainError', 'unavailable', 'invalid_response', 'credential_required', 'invalid_credential',
    'quota_exhausted', 'forbidden', 'not_found', 'csp_blocked',
  ]
  for (const failure of permanent) {
    it(`a next track whose only provider fails with ${failure} is skipped immediately, resolved once`, async () => {
      const { store, resolvesOf } = setup(['a', 'b', 'c'].map((id) => makeTrack(id)), (id) => id === 'b' ? failure : undefined)
      try {
        await store.playQueueIndex(0); await flush()
        store.reportMediaState('playing', store.playbackGeneration.value)
        await store.advanceAfterEnded(); await flush()
        expect(store.currentTrack.value?.id).toBe('c')
        expect(store.status.value).toBe('ready')
        expect(resolvesOf('b')).toBe(1)
        expect(kinds(store)).toEqual(['skipped'])
      } finally { store.dispose() }
    })
  }

  it('a runtime failure of the only provider still skips immediately', async () => {
    const { store, resolvesOf } = setup(['a', 'b', 'c'].map((id) => makeTrack(id)), () => undefined)
    try {
      await store.playQueueIndex(0); await flush()
      store.reportMediaState('playing', store.playbackGeneration.value)
      await store.advanceAfterEnded(); await flush()
      expect(store.currentTrack.value?.id).toBe('b')
      const outcome = await store.reportPlaybackFailure('lx', store.playbackGeneration.value); await flush()
      expect(outcome).toBe('skipped')
      expect(store.currentTrack.value?.id).toBe('c')
      expect(resolvesOf('b')).toBe(1)
      expect(kinds(store)).toEqual(['skipped'])
    } finally { store.dispose() }
  })
})

describe('41.7 preservation: the skip run bound (D31) and the terminal notice', () => {
  it('every track permanently unavailable with Repeat All: min(MAX_UNAVAILABLE_SKIPS, n - 1) skips, then queueUnplayable', async () => {
    const ids = ['a', 'b', 'c', 'd']
    const { store, resolvesOf } = setup(ids.map((id) => makeTrack(id)), () => 'plainError')
    try {
      store.setRepeatMode('all')
      await store.playQueueIndex(0); await flush()
      for (let i = 0; i < 6; i += 1) await flush()
      const bound = Math.min(MAX_UNAVAILABLE_SKIPS, ids.length - 1)
      expect(kinds(store).filter((kind) => kind === 'skipped')).toHaveLength(bound)
      expect(kinds(store).filter((kind) => kind === 'queueUnplayable')).toHaveLength(1)
      expect(store.status.value).toBe('error')
      expect(store.currentTrack.value?.id).toBe(ids[bound])
      expect(ids.map(resolvesOf)).toEqual([1, 1, 1, 1])
    } finally { store.dispose() }
  })
})

describe('41.7 preservation: offline still waits (D28)', () => {
  it('offline when the advance resolve times out: waiting, no skip, then one retry on online', async () => {
    const { store, resolvesOf } = setup(['a', 'b', 'c'].map((id) => makeTrack(id)), (id) => id === 'b' && resolvesOf('b') === 1 ? 'hang' : undefined)
    try {
      await store.playQueueIndex(0); await flush()
      store.reportMediaState('playing', store.playbackGeneration.value)
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
      void store.advanceAfterEnded(); await flush()
      await vi.advanceTimersByTimeAsync(100); await flush()
      expect(store.currentTrack.value?.id).toBe('b')
      expect(store.status.value).toBe('error')
      expect(kinds(store)).toEqual(['waitingForNetwork'])
      await vi.advanceTimersByTimeAsync(20_000); await flush()
      expect(resolvesOf('b'), 'no timer retry while offline').toBe(1)
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
      window.dispatchEvent(new Event('online')); await flush()
      expect(store.currentTrack.value?.id).toBe('b')
      expect(store.status.value).toBe('ready')
      expect(resolvesOf('b')).toBe(2)
      expect(kinds(store)).not.toContain('skipped')
      expect(resolvesOf('c')).toBe(0)
    } finally { store.dispose() }
  })
})
