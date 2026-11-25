import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { createRuntimeProviderRepository } from './runtimeConfig'
import { createPlaybackStore } from './store'
import { registerPlaybackMediaSession } from './mediaSession'
import { playbackLog } from './playbackLog'

const endpoint = new URL('/api/providers/config', window.location.origin).href
const tracks = ['current', 'genshin-the-jadeite-reflection'].map(id => ({
  id, title: id, sources: [{ provider: 'lx', externalId: id }],
})) as Track[]
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  playbackLog.clear()
  vi.useRealTimers()
})
function config() {
  const value = Response.json({ version: 1, providers: [
    { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 1 },
  ] })
  Object.defineProperty(value, 'url', { value: endpoint })
  return value
}
async function setup(delayMs: number, fail: boolean) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-15T16:33:29Z'))
  const fetcher = vi.fn().mockImplementation(async () => config()).mockResolvedValueOnce(config())
    .mockImplementationOnce(() => new Promise((resolve, reject) => setTimeout(() =>
      fail ? reject(new TypeError('network unavailable')) : resolve(config()), delayMs)))
  const providerResolve = vi.fn(async (track: Track) => ({
    kind: 'audio' as const, url: 'https://media.invalid/' + track.id + '.mp3',
    mimeType: 'audio/mpeg', expiresAt: Date.now() + 120_000,
  }))
  const repository = createRuntimeProviderRepository({ fetch: fetcher,
    providerPreferences: { isDisabled: () => false, revision: () => 0 },
    lxProviderFactory: () => ({ id: 'lx', canResolve: () => true, resolve: providerResolve }),
  })
  const store = createPlaybackStore({ loadRegistry: repository.loadPlayback, peekRegistry: repository.peekPlayback,
    storage: { getItem: key => key.includes('shuffle') ? 'false' : null, setItem() {} },
  })
  disposers.push(() => store.dispose())
  store.reconcileUpcomingQueue(tracks)
  await store.playQueueIndex(0)
  store.setPreloadPolicy('auto')
  store.reportMediaState('playing', store.playbackGeneration.value)
  await store.prepareTransition(1)
  return { store, repository, providerResolve, fetcher }
}

describe('Firefox configuration latency through the real playback store', () => {
  it.each([[41_245, false], [32_059, true]] as const)(
    'keeps normal ended progression bounded with %ims refresh (failure=%s)', async (delay, fail) => {
      const { store, providerResolve } = await setup(delay, fail)
      const prepared = store.preparedNext.value!
      expect(prepared).not.toBeNull()
      await vi.advanceTimersByTimeAsync(80_000)
      let completed = false
      const advancing = store.advanceAfterEnded().then(() => { completed = true })
      await vi.advanceTimersByTimeAsync(250)
      expect(completed, 'valid prepared normal-end handover must not await network configuration').toBe(true)
      expect(store.currentTrack.value?.id).toBe(tracks[1].id)
      expect(store.playbackIntent.value).toBe('playing')
      expect(store.playable.value).toBe(prepared.playable)
      expect(providerResolve).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(delay)
      await advancing
      expect(store.currentTrack.value?.id).toBe(tracks[1].id)
      expect(store.playbackIntent.value).toBe('playing')
      expect(providerResolve).toHaveBeenCalledTimes(2)
    },
  )

  it('re-resolves an expired preparation through the permitted provider without reusing its ticket', async () => {
    const { store, providerResolve } = await setup(32_059, true)
    const expired = store.preparedNext.value!
    await vi.advanceTimersByTimeAsync(115_331)
    await store.advanceAfterEnded()
    expect(store.currentTrack.value?.id).toBe(tracks[1].id)
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.playable.value).not.toBe(expired.playable)
    expect(store.playable.value?.expiresAt).toBeGreaterThan(expired.playable.expiresAt!)
    expect(store.preloadHandoff.value).toBeNull()
    expect(providerResolve).toHaveBeenCalledTimes(3)
  })

  it('waits after an expired lease without provider dispatch, then resolves the selected track after recovery', async () => {
    const { store, providerResolve } = await setup(32_059, true)
    await vi.advanceTimersByTimeAsync(121_000)
    playbackLog.clear()
    const advancing = store.advanceAfterEnded()
    await vi.advanceTimersByTimeAsync(4000)
    await advancing
    expect(store.currentTrack.value?.id).toBe(tracks[1].id)
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.playable.value).toBeNull()
    expect(providerResolve).toHaveBeenCalledTimes(2)
    expect(playbackLog.snapshot().filter(event => event.type === 'resolve.attempt')).toHaveLength(0)
    expect(playbackLog.snapshot().find(event => event.type === 'store.failCurrent')).toMatchObject({
      origin: 'registry', outcome: 'waiting', providerId: null,
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.currentTrack.value?.id).toBe(tracks[1].id)
    expect(store.playable.value).not.toBeNull()
    expect(providerResolve).toHaveBeenCalledTimes(3)
    expect(store.playbackNotices.value.some(notice => notice.kind === 'skipped')).toBe(false)
  })

  it('bounds persistent failures without skipping the selected track or repeatedly resolving media', async () => {
    const { store, fetcher, providerResolve } = await setup(32_059, true)
    fetcher.mockRejectedValue(new TypeError('offline'))
    await vi.advanceTimersByTimeAsync(121_000)
    const advancing = store.advanceAfterEnded()
    await vi.advanceTimersByTimeAsync(4000)
    await advancing
    await vi.advanceTimersByTimeAsync(60_000)
    const calls = fetcher.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(calls)
    expect(calls).toBe(5)
    expect(providerResolve).toHaveBeenCalledTimes(2)
    expect(store.currentTrack.value?.id).toBe(tracks[1].id)
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.playbackNotices.value.some(notice => notice.kind === 'skipped')).toBe(false)
  })

  it('keeps an explicit Media Session pause through late refresh and ended callbacks', async () => {
    const { store } = await setup(32_059, true)
    const handlers = new Map<string, (detail: MediaSessionActionDetails) => void>()
    const prior = Object.getOwnPropertyDescriptor(navigator, 'mediaSession')
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: {
      setActionHandler: (action: string, handler: (detail: MediaSessionActionDetails) => void) => handlers.set(action, handler),
      setPositionState() {}, metadata: null, playbackState: 'none',
    } })
    const unregister = registerPlaybackMediaSession(store, {
      isPlaying: () => true,
      pause: () => { store.pause(); store.reportMediaState('paused', store.playbackGeneration.value) },
      pauseForInterruption: () => undefined, play: () => { void store.play() }, stop: () => store.stop(),
    }, () => store.currentTrack.value?.title ?? '')
    disposers.push(() => {
      unregister()
      if (prior) Object.defineProperty(navigator, 'mediaSession', prior)
      else delete (navigator as unknown as { mediaSession?: unknown }).mediaSession
    })
    await vi.advanceTimersByTimeAsync(80_000)
    const advancing = store.next()
    handlers.get('pause')?.({ action: 'pause' })
    expect(store.playbackIntent.value).toBe('paused')
    const pausedTrack = store.currentTrack.value?.id
    await vi.advanceTimersByTimeAsync(42_000)
    await advancing
    expect(store.playbackIntent.value).toBe('paused')
    expect(store.status.value).not.toBe('playing')
    expect(store.currentTrack.value?.id).toBe(pausedTrack)
  })
})
