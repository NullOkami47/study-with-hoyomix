import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import type { Playable } from './providers/types'
import { ProviderRegistry } from './providers/registry'
import { createPlaybackStore, type PlaybackStore } from './store'

const stores: PlaybackStore[] = []
const audio = (id: string): Playable => ({ kind: 'audio', url: 'https://media.invalid/' + id + '.mp3', mimeType: 'audio/mpeg' })
const tracks = ['a', 'b'].map(id => ({ id, title: id, sources: [
  { provider: 'gd-studio', externalId: id }, { provider: 'lx', externalId: id },
] } as Track))
afterEach(() => { for (const store of stores.splice(0)) store.dispose() })
async function setup() {
  const gd = vi.fn(async (track: Track) => audio('gd-' + track.id))
  const lx = vi.fn(async (track: Track, _signal: AbortSignal): Promise<Playable> => audio('lx-' + track.id))
  const registry = new ProviderRegistry([
    { provider: { id: 'gd-studio', resolve: gd }, enabled: true, priority: 1, timeoutMs: 1000 },
    { provider: { id: 'lx', resolve: lx }, enabled: true, priority: 2, timeoutMs: 1000 },
  ])
  const store = createPlaybackStore({ registry, storage: { getItem: key => key.includes('shuffle') ? 'false' : null, setItem: () => {} } })
  stores.push(store)
  store.reconcileUpcomingQueue(tracks)
  await store.playQueueIndex(0)
  store.setPreloadPolicy('auto')
  await store.armNextPreparation()
  return { store, gd, lx }
}

describe('completed preparation across constrained network changes', () => {
  it.each(['rejectNextPreparation', 'rejectPreparation'] as const)('does not create a media fallback after auto to metadata through %s', async reject => {
    const { store, gd, lx } = await setup()
    const preparation = store.preparedNext.value!
    store.setPreloadPolicy('metadata')
    expect(store.preparedNext.value).toBe(preparation)
    store[reject](preparation.id)
    await flushPromises()
    expect(lx).not.toHaveBeenCalled()
    expect(gd).toHaveBeenCalledTimes(2)
    expect(store.preparedNext.value).toBeNull()
    expect(store.currentTrack.value).toBe(tracks[0])
  })

  it('aborts an in-flight fallback when downgraded and ignores its completion after auto returns', async () => {
    const { store, lx } = await setup()
    let finish!: (value: Playable) => void
    let signal!: AbortSignal
    lx.mockImplementationOnce((_track, incomingSignal) => {
      signal = incomingSignal
      return new Promise(resolve => { finish = resolve })
    })
    store.rejectNextPreparation(store.preparedNext.value!.id)
    await flushPromises()
    expect(lx).toHaveBeenCalledTimes(1)
    store.setPreloadPolicy('metadata')
    expect(signal.aborted).toBe(true)
    store.setPreloadPolicy('auto')
    finish(audio('late-fallback'))
    await flushPromises()
    expect(store.preparedNext.value).toBeNull()
    expect(store.currentTrack.value).toBe(tracks[0])
  })

  it('adopts an already completed media fallback after downgrade without resolving it again', async () => {
    const { store, gd, lx } = await setup()
    store.rejectNextPreparation(store.preparedNext.value!.id)
    await flushPromises()
    const prepared = store.preparedNext.value!
    expect(prepared.providerId).toBe('lx')
    store.setPreloadPolicy('metadata')
    await store.armNextPreparation()
    await store.next()
    expect(store.preloadHandoff.value?.id).toBe(prepared.id)
    expect(gd).toHaveBeenCalledTimes(2)
    expect(lx).toHaveBeenCalledTimes(1)
  })
})
