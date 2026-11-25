import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { ProviderRegistry } from './providers/registry'
import type { Playable } from './providers/types'
import { createPlaybackStore, type PlaybackStore } from './store'

const stores: PlaybackStore[] = []
const tracks = ['a', 'b', 'c'].map(id => ({
  id, title: id, sources: [{ provider: 'lx', externalId: id }],
} as Track))
const audio = (track: Track): Playable => ({
  kind: 'audio', url: 'https://media.invalid/' + track.id + '.mp3', mimeType: 'audio/mpeg',
})
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.useRealTimers() })
async function setup() {
  const resolve = vi.fn(async (track: Track) => audio(track))
  const registry = new ProviderRegistry([
    { provider: { id: 'lx', resolve }, enabled: true, priority: 1, timeoutMs: 1000 },
  ])
  const loadRegistry = vi.fn(async () => registry)
  const peekRegistry = vi.fn((): ProviderRegistry | undefined => registry)
  const store = createPlaybackStore({ loadRegistry, peekRegistry, storage: {
    getItem: key => key.includes('shuffle') ? 'false' : null, setItem: () => {},
  } })
  stores.push(store)
  store.reconcileUpcomingQueue(tracks)
  await store.playQueueIndex(0)
  store.setPreloadPolicy('auto')
  return { store, resolve, registry, loadRegistry, peekRegistry }
}

describe('transition preparation and synchronous handoff freshness', () => {
  it('checks the ticket margin again after asynchronous registry validation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t = await setup()
    await t.store.prepareTransition(1)
    const prepared = t.store.preparedNext.value!
    vi.setSystemTime(Date.now() + 89_000)
    let finish!: (registry: ProviderRegistry) => void
    t.loadRegistry.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const next = t.store.next()
    vi.setSystemTime(Date.now() + 2_000)
    finish(t.registry)
    await next
    expect(t.store.currentTrack.value).toBe(tracks[1])
    expect(t.store.preloadHandoff.value).toBeNull()
    expect(t.store.playable.value).not.toBe(prepared.playable)
    expect(t.resolve.mock.calls.filter(([track]) => track === tracks[1])).toHaveLength(2)
  })

  it('counts another Next from the pending target while its preparation is unresolved', async () => {
    const t = await setup()
    let finish!: (value: Playable) => void
    t.resolve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const preparing = t.store.prepareTransition(1)
    await flushPromises()
    const first = t.store.next()
    const second = t.store.next()
    await second
    finish(audio(tracks[1]))
    await Promise.all([preparing, first])
    expect(t.store.currentTrack.value).toBe(tracks[2])
    expect(t.resolve.mock.calls.filter(([track]) => track === tracks[1])).toHaveLength(1)
    expect(t.store.preloadHandoff.value).toBeNull()
  })

  it('does not resurrect an awaited selection after Pause followed by Play', async () => {
    const t = await setup()
    let finish!: (value: Playable) => void
    t.resolve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const preparing = t.store.prepareTransition(1)
    await flushPromises()
    const next = t.store.next()
    t.store.pause()
    await t.store.play()
    finish(audio(tracks[1]))
    await Promise.all([preparing, next])
    expect(t.store.currentTrack.value).toBe(tracks[0])
    expect(t.store.playbackIntent.value).toBe('playing')
  })

  it.each(['native pause', 'seek'] as const)('cancels an awaited adoption on %s without changing native listening intent', async action => {
    const t = await setup()
    t.store.reportMediaState('playing', t.store.playbackGeneration.value)
    await t.store.prepareTransition(1)
    let finish!: (registry: ProviderRegistry) => void
    t.loadRegistry.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const next = t.store.next()
    if (action === 'native pause') t.store.reportMediaState('paused', t.store.playbackGeneration.value)
    else t.store.reportProgress(15, t.store.playbackGeneration.value, true)
    finish(t.registry)
    await next
    expect(t.store.currentTrack.value).toBe(tracks[0])
    expect(t.store.preloadHandoff.value).toBeNull()
    expect(t.store.playbackIntent.value).toBe('playing')
  })

  it('refuses the same prepared transition when the current provider snapshot is missing', async () => {
    const t = await setup()
    await t.store.prepareTransition(1)
    const id = t.store.preparedNext.value!.id
    expect(t.store.canHandoffPreparation(id)).toBe(true)
    t.peekRegistry.mockReturnValue(undefined)
    expect(t.store.canHandoffPreparation(id)).toBe(false)
    expect(t.store.tryAdvancePreparedAfterEnded(t.store.playbackGeneration.value)).toBe(false)
    expect(t.store.currentTrack.value).toBe(tracks[0])
  })
})
