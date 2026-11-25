import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { ProviderRegistry } from './providers/registry'
import type { Playable } from './providers/types'
import { ProviderConfigurationUnavailableError } from './providerConfigFailure'
import { publishPlaybackPresentation } from './presentation'
import { createLxUserProvider } from './providers/lxUser'
import type { LxRuntimeClient } from './lx/runtime/client'
import type { LxSourceRepository } from './lx/types'
import { createPlaybackStore, REGISTRY_RETRY_DELAYS_MS, type PlaybackStore } from './store'

const storage = { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} }
const track = (id: string) => ({ id, title: id, sources: [{ provider: 'lx', externalId: id }] }) as Track
const playable = (id: string): Playable => ({ kind: 'audio', url: `https://media.example/${id}.mp3`, mimeType: 'audio/mpeg' })
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
let store: PlaybackStore | undefined
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000) })
afterEach(() => { store?.dispose(); store = undefined; vi.restoreAllMocks(); vi.useRealTimers() })

function setup(resolve = vi.fn(async (current: Track) => playable(current.id))) {
  const registry = new ProviderRegistry([{ provider: { id: 'lx', resolve }, enabled: true, priority: 1, timeoutMs: 1000 }])
  const loadRegistry = vi.fn(async () => registry)
  store = createPlaybackStore({ loadRegistry, storage })
  store.reconcileUpcomingQueue(['caprice', 'dew', 'third'].map(track))
  return { store, resolve, registry, loadRegistry }
}

describe('AOD recovery preserves the current track and listener intent', () => {
  it('retries real composite LX sub-source timeouts while keeping track and resume position', async () => {
    let loads = 0
    const provider = createLxUserProvider({
      sourceRepository: { list: async () => [{ id: 'builtin-fixture', name: 'Fixture', script: '// test',
        sha256: 'fixture', builtIn: true, enabled: true, priority: 1, importedAt: 0, updatedAt: 0 }] } as unknown as LxSourceRepository,
      globalSourceRepository: { list: async () => [], revision: () => 0, pendingApproval: () => [], invalidate() {} },
      qualityStore: { lxQuality: () => 'standard' }, cspSources: { connect: [], media: ['https://media.example'] },
      runtimeClientFactory: () => ({
        loadSource: async () => { if (++loads === 2) throw new Error('source load timed out'); return {} },
        callMusicUrl: async () => ({ url: 'https://media.example/fresh.mp3' }),
        dispose: async () => {},
      }) as unknown as LxRuntimeClient,
    })
    const registry = new ProviderRegistry([{ provider, enabled: true, priority: 1, timeoutMs: 1000 }])
    store = createPlaybackStore({ registry, storage })
    store.reconcileUpcomingQueue(['caprice', 'dew'].map(id => ({ ...track(id), sources: [{ provider: 'lx', externalId: 'wy:123456' }] })))
    await store.playQueueIndex(0)
    expect(store.playable.value?.kind).toBe('audio')
    publishPlaybackPresentation(store, { currentTime: 42, duration: 240, canSeek: true })
    const renewal = store.renewMedia('lx', store.playbackGeneration.value)
    await flush()
    expect(loads).toBe(2)
    await vi.advanceTimersByTimeAsync(1500)
    expect(await renewal).toBe(true)
    expect(loads).toBe(3)
    expect(store.currentTrack.value?.id).toBe('caprice')
    expect(store.consumePendingResumePosition()).toBe(42)
  })

  it('retries a temporary configuration failure after a previous successful registry without skipping the queue', async () => {
    const s = setup()
    await s.store.playQueueIndex(0)
    s.loadRegistry.mockRejectedValueOnce(new ProviderConfigurationUnavailableError('network'))
    await s.store.advanceAfterEnded()
    expect(s.store.currentTrack.value?.id).toBe('dew')
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(s.store.currentTrack.value?.id).toBe('dew')
    expect(s.store.playable.value).toEqual(playable('dew'))
    expect(s.store.playbackNotices.value.some(n => n.kind === 'skipped')).toBe(false)
  })

  it('bounds persistent configuration retries and keeps the same queue selection for manual resumption', async () => {
    const s = setup()
    await s.store.playQueueIndex(0)
    s.loadRegistry.mockRejectedValue(new ProviderConfigurationUnavailableError('network'))
    await s.store.advanceAfterEnded()
    for (const delay of REGISTRY_RETRY_DELAYS_MS) { await vi.advanceTimersByTimeAsync(delay); await flush() }
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.store.currentTrack.value?.id).toBe('dew')
    expect(s.store.status.value).toBe('error')
    expect(s.loadRegistry).toHaveBeenCalledTimes(5)
    expect(s.resolve).toHaveBeenCalledTimes(1)
    expect(s.store.playbackNotices.value.some(n => n.kind === 'skipped')).toBe(false)
  })

  it('cancels a scheduled configuration retry on explicit Pause', async () => {
    const s = setup()
    s.loadRegistry.mockRejectedValueOnce(new ProviderConfigurationUnavailableError('network'))
    await s.store.playQueueIndex(0)
    s.store.pause()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(s.loadRegistry).toHaveBeenCalledTimes(1)
    expect(s.resolve).not.toHaveBeenCalled()
    expect(s.store.playbackIntent.value).toBe('paused')
  })

  it('retries transient source renewal at the original position before reporting the track unavailable', async () => {
    const s = setup()
    await s.store.playQueueIndex(0)
    publishPlaybackPresentation(s.store, { currentTime: 42, duration: 240, canSeek: true })
    s.resolve.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(playable('renewed'))
    const renewal = s.store.renewMedia('lx', s.store.playbackGeneration.value)
    await flush()
    expect(s.resolve).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1500)
    expect(await renewal).toBe(true)
    expect(s.store.currentTrack.value?.id).toBe('caprice')
    expect(s.store.playable.value).toEqual(playable('renewed'))
    expect(s.store.consumePendingResumePosition()).toBe(42)
    expect(s.resolve).toHaveBeenCalledTimes(3)
  })

  it('coalesces concurrent same-generation renewals and succeeds for both observers', async () => {
    const s = setup()
    await s.store.playQueueIndex(0)
    let finish!: (value: Playable) => void
    s.resolve.mockImplementationOnce(() => new Promise<Playable>(r => { finish = r }))
    const generation = s.store.playbackGeneration.value
    const first = s.store.renewMedia('lx', generation)
    const second = s.store.renewMedia('lx', generation)
    await flush()
    finish(playable('renewed'))
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(s.resolve).toHaveBeenCalledTimes(2)
  })

  it('does not retry or publish a late source after Pause during renewal backoff', async () => {
    const s = setup()
    await s.store.playQueueIndex(0)
    s.resolve.mockRejectedValueOnce(new TypeError('offline'))
    const generation = s.store.playbackGeneration.value
    const renewal = s.store.renewMedia('lx', generation)
    await flush()
    s.store.pause()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await renewal).toBe(false)
    expect(s.store.playbackGeneration.value).toBe(generation)
    expect(s.store.playbackIntent.value).toBe('paused')
    expect(s.resolve).toHaveBeenCalledTimes(2)
  })

  it('spends at most two media retry delays then allows normal permitted-provider fallback', async () => {
    const s = setup()
    await s.store.playQueueIndex(0)
    s.resolve.mockRejectedValue(new TypeError('offline'))
    const renewal = s.store.renewMedia('lx', s.store.playbackGeneration.value)
    await flush()
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(4000)
    expect(await renewal).toBe(false)
    expect(s.resolve).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.resolve).toHaveBeenCalledTimes(4)
  })

  it('does not attribute a failed forced configuration refresh to the media provider', async () => {
    const s = setup()
    await s.store.playQueueIndex(0)
    publishPlaybackPresentation(s.store, { currentTime: 42, duration: 240, canSeek: true })
    const generation = s.store.playbackGeneration.value
    s.loadRegistry.mockRejectedValueOnce(new ProviderConfigurationUnavailableError('network'))
    expect(await s.store.renewMedia('lx', generation)).toBe(false)
    expect(await s.store.reportPlaybackFailure('lx', generation)).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.store.currentTrack.value?.id).toBe('caprice')
    expect(s.store.playable.value).toEqual(playable('caprice'))
    expect(s.store.consumePendingResumePosition()).toBe(42)
    expect(s.store.playbackNotices.value.some(n => n.kind === 'skipped')).toBe(false)
  })
})
