// Task 41.7 bug condition exploration (owner report 2026-10-28, Android Chrome PWA): on an
// automatic advance the notice "已略過《…》：沒有可播放它的音源。" (`skipped`) appears, yet playing
// the same track again succeeds. The advance resolve makes one attempt per provider and
// `failCurrent` skips on any failure, so a transient failure (a provider timeout while the page
// is hidden, a dropped request) is treated as "no source". These cases FAIL on the unfixed code.
//
// Real `createPlaybackStore`, the real `resolveTrack` and `ProviderRegistry`, fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { ProviderRegistry, type ProviderRegistration } from './providers/registry'
import type { AudioProvider, ProviderAttempt, ProviderResolveContext } from './providers/types'
import { createJellyfinProvider } from './providers/jellyfin'
import { createLxUserProvider } from './providers/lxUser'
import type { LxRuntimeClient } from './lx/runtime/client'
import { LX_NETWORK_ERROR } from './lx/runtime/protocol'
import type { LxSourceRecord, LxSourceRepository } from './lx/types'
import { createPlaybackStore, failuresAreTransient, type PlaybackStore } from './store'

const sequential = { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} }
const micro = async () => { for (let i = 0; i < 80; i += 1) await Promise.resolve() }
const flush = async () => { await micro(); await vi.advanceTimersByTimeAsync(0); await micro() }
const elapse = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await micro() }

const makeTrack = (id: string): Track => ({
  id, title: `${id}-title`, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'lx', externalId: `lx-${id}` }],
}) as unknown as Track

type Behaviour = 'ok' | 'hang' | 'network' | 'subTimeout'
/**
 * The only provider. `plan(trackId, call)` decides each call: `hang` never answers (the resolver's
 * timeout fires), `network` throws the fetch `TypeError`, `subTimeout` reports a timed-out LX
 * sub-source and answers null (what the composite LX provider does when every sub-source fails).
 */
function lxProvider(plan: (trackId: string, call: number) => Behaviour) {
  const calls: string[] = []
  const provider = {
    id: 'lx', calls,
    canResolve: (track: Track) => track.sources.some((source) => source.provider === 'lx'),
    resolve: vi.fn(async (track: Track, _signal: AbortSignal, context?: ProviderResolveContext) => {
      calls.push(track.id)
      const behaviour = plan(track.id, calls.filter((id) => id === track.id).length)
      if (behaviour === 'hang') return await new Promise<never>(() => {})
      if (behaviour === 'network') throw new TypeError('Failed to fetch')
      if (behaviour === 'subTimeout') {
        context?.onSubAttempt?.({ providerId: 'lx', sourceId: 'src-1', sourceName: 'Source 1', ok: false, code: 'timeout', latencyMs: 4_000 })
        return null
      }
      return { kind: 'audio' as const, url: `https://media.invalid/lx/${track.id}-${calls.length}.mp3`, mimeType: 'audio/mpeg' }
    }),
  }
  return provider as unknown as AudioProvider & { calls: string[] }
}

function setup(plan: (trackId: string, call: number) => Behaviour) {
  const provider = lxProvider(plan)
  const registry = new ProviderRegistry([{ provider, enabled: true, priority: 1, timeoutMs: 100 } as ProviderRegistration])
  const store = createPlaybackStore({
    loadRegistry: async () => registry,
    storage: sequential,
  })
  store.reconcileUpcomingQueue(['a', 'b', 'c'].map(makeTrack))
  const resolvesOf = (id: string) => provider.calls.filter((call) => call === id).length
  return { store, provider, resolvesOf }
}

const notices = (store: PlaybackStore) => store.playbackNotices.value.map((notice) => notice.kind)

/** Track `a` plays, then ends by itself: the automatic advance to `b`. */
async function playAThenAdvance(store: PlaybackStore): Promise<void> {
  await store.playQueueIndex(0); await flush()
  store.reportMediaState('playing', store.playbackGeneration.value)
  void store.advanceAfterEnded()
  await flush()
}

function expectPlaysB(store: PlaybackStore, detail: () => unknown): void {
  const state = {
    track: store.currentTrack.value?.id, status: store.status.value, intent: store.playbackIntent.value,
    playable: store.playable.value?.kind ?? null, notices: notices(store), detail: detail(),
  }
  expect(state, 'b plays after a transient failure, with no skipped notice').toMatchObject({
    track: 'b', status: 'ready', intent: 'playing', playable: 'audio',
  })
  expect(state.notices).not.toContain('skipped')
}

let visibility: 'visible' | 'hidden' = 'visible'
beforeEach(() => {
  window.localStorage.setItem('hoyomix-player-shuffle-v1', 'false')
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' })
  vi.useFakeTimers()
})
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers()
  Reflect.deleteProperty(document, 'visibilityState')
  Reflect.deleteProperty(document, 'hidden')
})

describe('41.7 exploration: a transient failure on automatic advance is retried, not skipped', () => {
  it('(a) the next track\'s only provider times out once, then answers: it plays', async () => {
    const { store, resolvesOf } = setup((id, call) => id === 'b' && call === 1 ? 'hang' : 'ok')
    try {
      await playAThenAdvance(store)
      await elapse(100) // the provider timeout
      await elapse(6_000)
      expectPlaysB(store, () => ({ resolvesOfB: resolvesOf('b'), resolvesOfC: resolvesOf('c') }))
      expect(resolvesOf('b')).toBe(2)
      expect(resolvesOf('c')).toBe(0)
    } finally { store.dispose() }
  })

  it('(a) a dropped request (fetch TypeError) once, then the provider answers: it plays', async () => {
    const { store, resolvesOf } = setup((id, call) => id === 'b' && call === 1 ? 'network' : 'ok')
    try {
      await playAThenAdvance(store)
      await elapse(6_000)
      expectPlaysB(store, () => ({ resolvesOfB: resolvesOf('b') }))
      expect(resolvesOf('b')).toBe(2)
    } finally { store.dispose() }
  })

  it('(b) the next-track preparation failed (timeout) and the advance resolve fails again: b is re-resolved fresh and plays', async () => {
    const { store, resolvesOf } = setup((id, call) => id === 'b' && call <= 2 ? 'hang' : 'ok')
    try {
      store.setPreloadPolicy('auto')
      await store.playQueueIndex(0); await flush()
      store.reportMediaState('playing', store.playbackGeneration.value)
      void store.armNextPreparation()
      await elapse(100); await flush()
      expect(store.preparedNext.value, 'a failed preparation is not published').toBeNull()
      expect(resolvesOf('b')).toBe(1)
      void store.advanceAfterEnded()
      await flush()
      await elapse(100)
      await elapse(6_000)
      expectPlaysB(store, () => ({ resolvesOfB: resolvesOf('b') }))
      expect(resolvesOf('b'), 'preparation + advance + one fresh retry').toBe(3)
    } finally { store.dispose() }
  })

  it('(d) the real LX provider: its only sub-source hits a sandbox network_error once, then answers: it plays', async () => {
    let musicUrlCalls = 0
    const runtime: Partial<LxRuntimeClient> = {
      loadSource: vi.fn(async () => ({ initedMeta: undefined })),
      callMusicUrl: vi.fn(async () => {
        musicUrlCalls += 1
        // Call 1 resolves `a`; call 2 is the automatic advance to `b`.
        if (musicUrlCalls === 2) throw new Error(`LX musicUrl rejected: ${LX_NETWORK_ERROR}: Failed to fetch`)
        return { url: `https://cdn.example.com/lx/${musicUrlCalls}.mp3` }
      }),
      dispose: vi.fn(async () => undefined),
    }
    const source: LxSourceRecord = {
      id: 'builtin-1', name: 'Built-in', sha256: 'sha', enabled: true, priority: 1, script: '//', builtIn: true, importedAt: 0, updatedAt: 0,
    }
    const provider = createLxUserProvider({
      sourceRepository: { list: async () => [source] } as unknown as LxSourceRepository,
      runtimeClientFactory: () => runtime as LxRuntimeClient,
      qualityStore: { lxQuality: () => 'standard' },
      cspSources: { connect: [], media: ['https://*.example.com'] },
    })
    const registry = new ProviderRegistry([{ provider, enabled: true, priority: 1, timeoutMs: 1_000 } as ProviderRegistration])
    const store = createPlaybackStore({
      loadRegistry: async () => registry,
      storage: sequential,
    })
    const lxTrack = (id: string) => ({ ...makeTrack(id), sources: [{ provider: 'chksz', externalId: String(100 + id.charCodeAt(0)) }] }) as unknown as Track
    store.reconcileUpcomingQueue(['a', 'b', 'c'].map(lxTrack))
    try {
      await playAThenAdvance(store)
      await elapse(6_000)
      expectPlaysB(store, () => ({ attempts: store.attempts.value, musicUrlCalls }))
      expect(musicUrlCalls, 'a + the failed advance + one fresh retry').toBe(3)
    } finally { store.dispose() }
  })

  it('(c) Android: page hidden, every LX sub-source times out once (top-level null), then LX answers: it plays', async () => {
    const { store, resolvesOf } = setup((id, call) => id === 'b' && call === 1 ? 'subTimeout' : 'ok')
    try {
      await store.playQueueIndex(0); await flush()
      store.reportMediaState('playing', store.playbackGeneration.value)
      visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))
      void store.advanceAfterEnded()
      await flush()
      await elapse(6_000)
      expectPlaysB(store, () => ({ resolvesOfB: resolvesOf('b'), attempts: store.attempts.value }))
      expect(resolvesOf('b')).toBe(2)
    } finally { store.dispose() }
  })
})

describe('41.7 fix: the transient retry is bounded and classified', () => {
  it('a next track that times out every time is skipped after two retries (1.5 s, 4 s), within 10 s of the advance', async () => {
    const { store, resolvesOf } = setup((id) => id === 'b' ? 'hang' : 'ok')
    try {
      await store.playQueueIndex(0); await flush()
      store.reportMediaState('playing', store.playbackGeneration.value)
      const startedAt = Date.now()
      void store.advanceAfterEnded(); await flush()
      let skippedAt: number | undefined
      for (let elapsed = 0; elapsed < 20_000 && skippedAt === undefined; elapsed += 100) {
        await elapse(100)
        if (store.currentTrack.value?.id === 'c') skippedAt = Date.now() - startedAt
      }
      expect(resolvesOf('b'), 'advance + two retries').toBe(3)
      expect(skippedAt).toBeDefined()
      // Three 100 ms timeouts plus the 1.5 s and 4 s waits.
      expect(skippedAt!).toBeGreaterThanOrEqual(5_500)
      expect(skippedAt!).toBeLessThan(10_000)
      expect(notices(store)).toEqual(['skipped'])
      expect(store.status.value).toBe('ready')
    } finally { store.dispose() }
  })

  it('stop() during the wait cancels the retry', async () => {
    const { store, resolvesOf } = setup((id, call) => id === 'b' && call === 1 ? 'hang' : 'ok')
    try {
      await playAThenAdvance(store)
      await elapse(100)
      expect(store.status.value).toBe('error')
      store.stop()
      await elapse(10_000)
      expect(resolvesOf('b')).toBe(1)
      expect(store.currentTrack.value).toBeUndefined()
    } finally { store.dispose() }
  })

  it('pause during the wait holds the retry; Play afterwards resolves the errored track again and it plays', async () => {
    const { store, resolvesOf } = setup((id, call) => id === 'b' && call === 1 ? 'hang' : 'ok')
    try {
      await playAThenAdvance(store)
      await elapse(100)
      expect(store.status.value).toBe('error')
      store.pause()
      await elapse(10_000)
      expect(resolvesOf('b'), 'a paused wait does not resolve').toBe(1)
      expect(store.currentTrack.value?.id).toBe('b')
      expect(store.status.value).toBe('error')
      expect(notices(store)).not.toContain('skipped')
      await store.play(); await flush()
      expectPlaysB(store, () => ({ resolvesOfB: resolvesOf('b') }))
      expect(resolvesOf('b')).toBe(2)
      expect(resolvesOf('c')).toBe(0)
    } finally { store.dispose() }
  })

  it('a listener skip during the wait cancels the retry of the left track', async () => {
    const { store, resolvesOf } = setup((id, call) => id === 'b' && call === 1 ? 'hang' : 'ok')
    try {
      await playAThenAdvance(store)
      await elapse(100)
      await store.next(); await flush()
      await elapse(10_000)
      expect(store.currentTrack.value?.id).toBe('c')
      expect(resolvesOf('b')).toBe(1)
      expect(notices(store)).toEqual([])
    } finally { store.dispose() }
  })

  const attempt = (code: ProviderAttempt['code'], extra: Partial<ProviderAttempt> = {}): ProviderAttempt =>
    ({ providerId: 'lx', ok: false, latencyMs: 0, code, ...extra })
  it.each([
    ['timeout', [attempt('timeout')], true],
    ['rate_limited', [attempt('rate_limited')], true],
    ['dropped request (transient unavailable)', [attempt('unavailable', { transient: true })], true],
    ['timeout with other providers not_mapped', [attempt('not_mapped', { providerId: 'chksz' }), attempt('timeout')], true],
    ['LX sub-source timeouts behind a collapsed unavailable', [attempt('timeout', { sourceId: 's1' }), attempt('unavailable')], true],
    ['nothing recorded', [], false],
    ['only not_mapped', [attempt('not_mapped')], false],
    ['plain unavailable', [attempt('unavailable')], false],
    ['timeout plus a permanent answer', [attempt('timeout'), attempt('unavailable', { providerId: 'jellyfin' })], false],
    ['LX sub-source csp_blocked', [attempt('csp_blocked', { sourceId: 's1' }), attempt('unavailable')], false],
    ['credential_required', [attempt('credential_required')], false],
    ['invalid_response', [attempt('invalid_response')], false],
  ])('failuresAreTransient: %s -> %s', (_name, attempts, expected) => {
    expect(failuresAreTransient(attempts as ProviderAttempt[])).toBe(expected)
  })

  it('the Jellyfin proxy marks a dropped request and a 5xx outage transient, and a 404 as no answer', async () => {
    const jellyfinTrack = { ...makeTrack('a'), sources: [{ provider: 'jellyfin', externalId: 'jf-a' }] } as unknown as Track
    const signal = new AbortController().signal
    const dropped = createJellyfinProvider({ fetch: (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch })
    await expect(dropped.resolve(jellyfinTrack, signal)).rejects.toMatchObject({ code: 'unavailable', transient: true })
    const outage = createJellyfinProvider({ fetch: (async (url: string) => responseAt(url, 503)) as unknown as typeof fetch })
    await expect(outage.resolve(jellyfinTrack, signal)).rejects.toMatchObject({ code: 'unavailable', transient: true })
    const missing = createJellyfinProvider({ fetch: (async (url: string) => responseAt(url, 404)) as unknown as typeof fetch })
    await expect(missing.resolve(jellyfinTrack, signal)).resolves.toBeNull()
  })
})

/** A response whose final URL is the request URL, as the proxy provider requires. */
function responseAt(url: string, status: number): Response {
  const response = new Response(null, { status })
  Object.defineProperty(response, 'url', { value: url })
  return response
}
