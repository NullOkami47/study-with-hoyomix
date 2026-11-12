import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { Track } from '../catalog/types'
import { ProviderRegistry } from './providers/registry'
import type { Playable } from './providers/types'
import { createPlaybackStore, isPreparationFresh, type PlaybackStore } from './store'

const stores: PlaybackStore[] = []
const tracks = ['a', 'b', 'c'].map(id => ({ id, title: id, sources: [{ provider: 'vkeys', externalId: id }] } as Track))
const audio = (track: Track, expiresAt?: number): Playable => ({
  kind: 'audio', url: 'https://media.invalid/' + track.id + '.mp3', mimeType: 'audio/mpeg',
  ...(expiresAt === undefined ? {} : { expiresAt }),
})
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.useRealTimers() })
async function setup(lifetime?: number) {
  vi.useFakeTimers({ toFake: ['Date'] })
  const resolve = vi.fn(async (track: Track) => audio(track, lifetime === undefined ? undefined : Date.now() + lifetime))
  const registry = new ProviderRegistry([{ provider: { id: 'vkeys', resolve }, enabled: true, priority: 1, timeoutMs: 1000 }])
  const loadRegistry = vi.fn(async () => registry)
  const store = createPlaybackStore({ loadRegistry, peekRegistry: () => registry, storage: {
    getItem: key => key.includes('shuffle') ? 'false' : null, setItem: () => {},
  } })
  stores.push(store)
  store.reconcileUpcomingQueue(tracks)
  await store.playQueueIndex(0)
  store.setPreloadPolicy('auto')
  await store.prepareTransition(1)
  return { store, resolve, registry, loadRegistry }
}

describe('advertised ticket expiry through preparation and handover', () => {
  it('refuses a thirty-second ticket at its actual expiry despite the legacy reuse window', async () => {
    const { store } = await setup(30_000)
    const prepared = store.preparedNext.value!
    expect(isPreparationFresh(prepared)).toBe(true)
    vi.setSystemTime(Date.now() + 30_000)
    expect(isPreparationFresh(prepared)).toBe(false)
    expect(store.canHandoffPreparation(prepared.id)).toBe(false)
    expect(store.tryAdvancePreparedAfterEnded(store.playbackGeneration.value)).toBe(false)
  })

  it.each(['crossfade', 'background', 'foreground'] as const)('declines a short ticket below the thirty-second handover margin for %s', async mode => {
    const { store, resolve } = await setup(45_000)
    const prepared = store.preparedNext.value!
    vi.setSystemTime(Date.now() + 15_001)
    expect(isPreparationFresh(prepared)).toBe(true)
    if (mode === 'crossfade') expect(store.canHandoffPreparation(prepared.id)).toBe(false)
    else if (mode === 'background') expect(store.tryAdvancePreparedAfterEnded(store.playbackGeneration.value)).toBe(false)
    else {
      await store.next()
      expect(store.currentTrack.value).toBe(tracks[1])
      expect(store.preloadHandoff.value).toBeNull()
      expect(store.playable.value).not.toBe(prepared.playable)
      expect(resolve.mock.calls.filter(([track]) => track === tracks[1])).toHaveLength(2)
    }
  })

  it('rechecks upstream expiry after awaiting a current registry', async () => {
    const { store, registry, loadRegistry } = await setup(45_000)
    vi.setSystemTime(Date.now() + 14_000)
    let finish!: (registry: ProviderRegistry) => void
    loadRegistry.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const next = store.next()
    vi.setSystemTime(Date.now() + 2_000)
    finish(registry)
    await next
    expect(store.preloadHandoff.value).toBeNull()
    expect(store.currentTrack.value).toBe(tracks[1])
  })

  it.each([undefined, 500_000])('never extends the shared ticket limit when upstream expiry is %s', async lifetime => {
    const { store } = await setup(lifetime)
    const prepared = store.preparedNext.value!
    expect(store.canHandoffPreparation(prepared.id)).toBe(true)
    vi.setSystemTime(Date.now() + 90_001)
    expect(store.canHandoffPreparation(prepared.id)).toBe(false)
    vi.setSystemTime(Date.now() + 10_000)
    expect(isPreparationFresh(prepared)).toBe(false)
  })

  it('uses the original request time even when preparing a response takes most of its life', async () => {
    const { store, resolve } = await setup(500_000)
    store.invalidatePreload()
    let finish!: (result: Playable) => void
    resolve.mockImplementationOnce(() => new Promise(done => { finish = done }))
    const started = Date.now()
    const prepare = store.prepareTransition(1)
    await flushPromises()
    vi.setSystemTime(started + 91_000)
    finish(audio(tracks[1], Date.now() + 500_000))
    await prepare
    expect(store.canHandoffPreparation(store.preparedNext.value!.id)).toBe(false)
  })

  it('carries short expiry into the handover ladder and into renewed starting tickets', async () => {
    const { store, resolve } = await setup(45_000)
    await store.next()
    const generation = store.playbackGeneration.value
    expect(store.awaitingStart.value?.generation).toBe(generation)
    vi.setSystemTime(Date.now() + 16_000)
    expect(await store.recoverHandover('reResolve', generation)).toBe(true)
    expect(resolve.mock.calls.filter(([track]) => track === tracks[1])).toHaveLength(2)
    const renewedGeneration = store.playbackGeneration.value
    expect(store.awaitingStart.value?.generation).toBe(renewedGeneration)
    vi.setSystemTime(Date.now() + 16_000)
    expect(await store.recoverHandover('reResolve', renewedGeneration)).toBe(true)
    expect(resolve.mock.calls.filter(([track]) => track === tracks[1])).toHaveLength(3)
  })
})
