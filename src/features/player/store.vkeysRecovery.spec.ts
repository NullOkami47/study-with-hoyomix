import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { ProviderRegistry } from './providers/registry'
import type { AudioProvider, Playable } from './providers/types'
import { createPlaybackStore, MEDIA_RENEWAL_INTERVAL_MS, type PlaybackStore } from './store'

const track = (id = 'a', providers = ['vkeys', 'lx', 'gd-studio']): Track => ({
  id, title: id, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: providers.map((provider) => ({ provider, externalId: provider + '-' + id })),
})
const media = (id: string): Playable => ({ kind: 'audio', url: 'https://media.invalid/' + id + '.mp3', mimeType: 'audio/mpeg' })
function provider(id: string) {
  let calls = 0
  return {
    id, canResolve: (item: Track) => item.sources.some((source) => source.provider === id),
    resolve: vi.fn(async (item: Track): Promise<Playable> => media(id + '/' + item.id + '-' + ++calls)),
  } satisfies AudioProvider
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const micro = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve() }
const stores: PlaybackStore[] = []
function setup(providers: AudioProvider[], loadRegistry?: () => Promise<ProviderRegistry>) {
  const registry = new ProviderRegistry(providers.map((item, priority) => ({
    provider: item, priority, enabled: true, timeoutMs: 1_000,
  })))
  const store = createPlaybackStore({ registry, loadRegistry, storage: { getItem: () => null, setItem: () => {} } })
  store.setShuffle(false)
  stores.push(store)
  return { store, registry }
}
function recover(store: PlaybackStore, position = 42, stillStalled?: () => boolean) {
  expect(store.requestSourceRecovery).toBeTypeOf('function')
  return store.requestSourceRecovery!(store.activeProviderId.value!, store.playbackGeneration.value, position, stillStalled)
}
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('provider-agnostic same-position recovery', () => {
  it.each(['vkeys', 'lx', 'gd-studio'])('renews an expired %s URL with only that provider registered', async (id) => {
    const source = provider(id)
    const { store } = setup([source])
    const current = track('a', [id])
    await store.playNow(current)
    const generation = store.playbackGeneration.value
    const session = store.listeningSessionId.value
    const oldPlayable = store.playable.value
    store.reportMediaState('buffering', generation)

    expect(await recover(store)).toBe('recovered')
    expect(source.resolve).toHaveBeenCalledTimes(2)
    expect(store.playable.value).not.toEqual(oldPlayable)
    expect(store.currentTrack.value).toBe(current)
    expect(store.currentIndex.value).toBe(0)
    expect(store.activeProviderId.value).toBe(id)
    expect(store.pendingResumePosition.value).toBe(42)
    expect(store.playbackGeneration.value).toBe(generation + 1)
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.status.value).toBe('ready')
  })

  it('continues Vkeys to LX to GD at the same position without revisiting failed providers', async () => {
    const vkeys = provider('vkeys'), lx = provider('lx'), gd = provider('gd-studio')
    const { store } = setup([vkeys, lx, gd])
    await store.playNow(track())
    const session = store.listeningSessionId.value
    vkeys.resolve.mockRejectedValueOnce(new Error('expired stream cannot be renewed'))
    expect(await recover(store)).toBe('continuing')
    expect(store.activeProviderId.value).toBe('lx')
    expect(store.pendingResumePosition.value).toBe(42)
    expect(await recover(store, 43)).toBe('continuing')
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.pendingResumePosition.value).toBe(43)
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.currentTrack.value?.id).toBe('a')
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(lx.resolve).toHaveBeenCalledTimes(1)
    expect(gd.resolve).toHaveBeenCalledTimes(1)
    expect(store.attempts.value.filter((attempt) => !attempt.ok).map((attempt) => attempt.providerId)).toEqual(['vkeys', 'lx'])
  })

  it('halts after one renewal without progress, even after the interval, and allows an explicit Play retry', async () => {
    let now = 50_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const vkeys = provider('vkeys')
    const { store } = setup([vkeys])
    await store.playNow(track('a', ['vkeys']))
    expect(await recover(store)).toBe('recovered')
    now += MEDIA_RENEWAL_INTERVAL_MS * 2
    expect(await recover(store)).toBe('halted')
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(store.status.value).toBe('error')
    expect(store.pendingResumePosition.value).toBe(42)
    await store.play()
    expect(vkeys.resolve).toHaveBeenCalledTimes(3)
    expect(store.activeProviderId.value).toBe('vkeys')
    expect(store.pendingResumePosition.value).toBe(42)
  })

  it('keeps a manually selected source and position when its fresh resolution fails', async () => {
    const vkeys = provider('vkeys'), lx = provider('lx')
    const { store } = setup([vkeys, lx])
    await store.playNow(track())
    await store.setSourceOverride('vkeys')
    const session = store.listeningSessionId.value
    vkeys.resolve.mockRejectedValueOnce(new Error('source unavailable'))
    expect(await recover(store)).toBe('halted')
    expect(store.sourceOverride.value).toBe('vkeys')
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.pendingResumePosition.value).toBe(42)
    expect(lx.resolve).not.toHaveBeenCalled()
  })

  it('ignores duplicate recovery requests while one renewal is pending', async () => {
    const vkeys = provider('vkeys'), pending = deferred<Playable>()
    const { store } = setup([vkeys])
    await store.playNow(track('a', ['vkeys']))
    vkeys.resolve.mockReturnValueOnce(pending.promise)
    const first = recover(store)
    await micro()
    expect(await recover(store)).toBe('stale')
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    pending.resolve(media('fresh'))
    expect(await first).toBe('recovered')
    expect(store.playable.value).toEqual(media('fresh'))
  })

  it.each(['pause', 'pause-resume', 'next', 'override', 'stop', 'dispose', 'progress'] as const)(
    'discards a pending renewal after %s', async (action) => {
      const vkeys = provider('vkeys'), lx = provider('lx'), pending = deferred<Playable>()
      const { store } = setup([vkeys, lx])
      store.enqueue(track('a')); store.enqueue(track('b'))
      await store.playQueueIndex(0)
      const oldPlayable = store.playable.value
      let stalled = true
      vkeys.resolve.mockReturnValueOnce(pending.promise)
      const recovery = recover(store, 42, () => stalled)
      await micro()
      expect(vkeys.resolve).toHaveBeenCalledTimes(2)
      if (action === 'pause' || action === 'pause-resume') {
        store.pause()
        store.reportMediaState('paused', store.playbackGeneration.value)
        if (action === 'pause-resume') await store.play()
      } else if (action === 'next') await store.next()
      else if (action === 'override') await store.setSourceOverride('lx')
      else if (action === 'stop') store.stop()
      else if (action === 'dispose') store.dispose()
      else stalled = false
      const expectedPlayable = store.playable.value
      const generation = store.playbackGeneration.value
      pending.resolve(media('stale'))
      expect(await recovery).toBe('stale')
      expect(store.playable.value).toEqual(expectedPlayable)
      expect(store.playbackGeneration.value).toBe(generation)
      if (action === 'pause') expect(store.playbackIntent.value).toBe('paused')
      if (action === 'pause-resume' || action === 'progress') expect(store.playable.value).toEqual(oldPlayable)
      if (action === 'next') expect(store.currentTrack.value?.id).toBe('b')
      if (action === 'override') expect(store.activeProviderId.value).toBe('lx')
    },
  )

  it('does not begin recovery after progress, a manual pause or an invalid position', async () => {
    const vkeys = provider('vkeys')
    const { store } = setup([vkeys])
    await store.playNow(track('a', ['vkeys']))
    expect(await recover(store, 42, () => false)).toBe('stale')
    for (const position of [-1, NaN, Infinity]) expect(await recover(store, position)).toBe('stale')
    store.pause()
    expect(await recover(store)).toBe('stale')
    expect(vkeys.resolve).toHaveBeenCalledTimes(1)
  })

  it('refreshes the registry before requesting a fresh URL and ignores progress while loading it', async () => {
    const vkeys = provider('vkeys'), pending = deferred<ProviderRegistry>()
    const loadRegistry = vi.fn<() => Promise<ProviderRegistry>>()
    const { store, registry } = setup([vkeys], loadRegistry)
    loadRegistry.mockResolvedValueOnce(registry).mockReturnValueOnce(pending.promise)
    await store.playNow(track('a', ['vkeys']))
    let stalled = true
    const recovery = recover(store, 42, () => stalled)
    await micro()
    expect(loadRegistry).toHaveBeenLastCalledWith({ forceRefresh: true })
    stalled = false
    pending.resolve(registry)
    expect(await recovery).toBe('stale')
    expect(vkeys.resolve).toHaveBeenCalledTimes(1)
  })
  it('does not renew the same stalled provider and position again after its own reload emits playing', async () => {
    let now = 50_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const vkeys = provider('vkeys'), gd = provider('gd-studio')
    const { store } = setup([vkeys, gd])
    await store.playNow(track('a', ['vkeys', 'gd-studio']))
    expect(await recover(store)).toBe('recovered')
    store.reportMediaState('playing', store.playbackGeneration.value)
    now += MEDIA_RENEWAL_INTERVAL_MS * 6
    expect(await recover(store)).toBe('continuing')
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).toHaveBeenCalledTimes(1)
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.pendingResumePosition.value).toBe(42)
  })

})
