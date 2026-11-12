import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { ProviderRegistry } from './providers/registry'
import type { AudioProvider, Playable } from './providers/types'
import { createPlaybackStore, isPreparationFresh, MEDIA_TICKET_TTL_MS, type PlaybackStore } from './store'

const epoch = Date.UTC(2026, 10, 10)
const micro = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve() }
const stores: PlaybackStore[] = []
const media = (id: string, expiresAt?: number): Playable => ({
  kind: 'audio', url: 'https://media.invalid/' + id + '.mp3', mimeType: 'audio/mpeg',
  ...(expiresAt === undefined ? {} : { expiresAt }),
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function setup(expiresAt?: number) {
  let calls = 0
  const source = {
    id: 'vkeys', canResolve: () => true,
    resolve: vi.fn(async (track: Track, _signal: AbortSignal): Promise<Playable> => media(track.id + '-' + ++calls, expiresAt)),
  } satisfies AudioProvider
  const registry = new ProviderRegistry([{ provider: source, priority: 1, enabled: true, timeoutMs: 1_000 }])
  const store = createPlaybackStore({ registry, storage: { getItem: () => null, setItem: () => {} } })
  stores.push(store)
  store.setShuffle(false)
  for (const id of ['a', 'b', 'c', 'd']) store.enqueue({
    id, title: id, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'vkeys', externalId: 'vk-' + id }],
  })
  await store.playQueueIndex(0)
  store.setPreloadPolicy('auto')
  return { store, source }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch) })
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  vi.restoreAllMocks(); vi.useRealTimers()
})

describe('standalone preparation tickets through the real resolver', () => {
  it('expires a short provider ticket at its exact absolute deadline', async () => {
    const { store } = await setup(epoch + 30_000)
    await store.armNextPreparation()
    const prepared = store.preparedNext.value!
    expect(prepared.playable.expiresAt).toBe(epoch + 30_000)
    expect(isPreparationFresh(prepared, undefined, epoch + 29_999)).toBe(true)
    expect(isPreparationFresh(prepared, undefined, epoch + 30_000)).toBe(false)
  })

  it('requires the full 30-second margin of the actual ticket, including its boundary', async () => {
    const { store } = await setup(epoch + 45_000)
    await store.armNextPreparation()
    const id = store.preparedNext.value!.id
    vi.setSystemTime(epoch + 15_000)
    expect(store.canHandoffPreparation(id)).toBe(true)
    vi.setSystemTime(epoch + 15_001)
    expect(store.canHandoffPreparation(id)).toBe(false)
  })

  it('resolves the next track afresh instead of adopting a ticket below the actual margin', async () => {
    const { store, source } = await setup(epoch + 45_000)
    await store.armNextPreparation()
    const prepared = store.preparedNext.value!
    vi.setSystemTime(epoch + 15_001)
    source.resolve.mockResolvedValueOnce(media('b-fresh', epoch + 120_000))
    await store.next()
    expect(source.resolve).toHaveBeenCalledTimes(3)
    expect(store.preloadHandoff.value).toBeNull()
    expect(store.playable.value).not.toBe(prepared.playable)
    expect(store.playable.value).toEqual(media('b-fresh', epoch + 120_000))
    expect(store.currentTrack.value?.id).toBe('b')
  })

  it.each([undefined, epoch + 600_000])('keeps the legacy validity and shared TTL cap for expiry %s', async (expiresAt) => {
    const { store } = await setup(expiresAt)
    await store.armNextPreparation()
    const prepared = store.preparedNext.value!
    vi.setSystemTime(epoch + MEDIA_TICKET_TTL_MS - 30_000)
    expect(store.canHandoffPreparation(prepared.id)).toBe(true)
    vi.setSystemTime(Date.now() + 1)
    expect(store.canHandoffPreparation(prepared.id)).toBe(false)
    expect(isPreparationFresh(prepared, undefined, epoch + 100_001)).toBe(false)
  })

  it('does not restart a short ticket lifetime when a slow preparation completes', async () => {
    const { store, source } = await setup()
    const pending = deferred<Playable>()
    source.resolve.mockReturnValueOnce(pending.promise)
    const preparation = store.armNextPreparation()
    await micro()
    vi.setSystemTime(epoch + 20_000)
    pending.resolve(media('b-slow', epoch + 45_000))
    await preparation
    expect(store.preparedNext.value!.preparedAt).toBe(epoch)
    expect(store.canHandoffPreparation(store.preparedNext.value!.id)).toBe(false)
    vi.setSystemTime(epoch + 45_000)
    expect(isPreparationFresh(store.preparedNext.value!)).toBe(false)
  })

  it('keeps request-start age even when the slow preparation returns a long-lived ticket', async () => {
    const { store, source } = await setup()
    const pending = deferred<Playable>()
    source.resolve.mockReturnValueOnce(pending.promise)
    const preparation = store.armNextPreparation()
    await micro()
    vi.setSystemTime(epoch + 90_001)
    pending.resolve(media('b-slow', epoch + 600_000))
    await preparation
    expect(store.preparedNext.value!.preparedAt).toBe(epoch)
    expect(store.canHandoffPreparation(store.preparedNext.value!.id)).toBe(false)
  })

  it('carries the adopted short expiry into the handover renewal ladder', async () => {
    const { store, source } = await setup(epoch + 45_000)
    await store.armNextPreparation()
    await store.next()
    const generation = store.playbackGeneration.value
    const session = store.listeningSessionId.value
    vi.setSystemTime(epoch + 15_001)
    source.resolve.mockResolvedValueOnce(media('renewed', epoch + 90_000))
    expect(await store.recoverHandover('reResolve', generation)).toBe(true)
    expect(source.resolve).toHaveBeenCalledTimes(3)
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.awaitingStart.value?.generation).toBe(generation + 1)
    expect(store.playable.value).toEqual(media('renewed', epoch + 90_000))
  })

  it('carries a renewed short expiry into the next handover freshness check', async () => {
    const { store, source } = await setup(epoch + 120_000)
    await store.armNextPreparation(); await store.next()
    source.resolve.mockResolvedValueOnce(media('short-renewal', epoch + 45_000))
    expect(await store.renewMedia('vkeys', store.playbackGeneration.value)).toBe(true)
    const generation = store.playbackGeneration.value
    vi.setSystemTime(epoch + 15_001)
    expect(await store.recoverHandover('reResolve', generation)).toBe(true)
    expect(source.resolve).toHaveBeenCalledTimes(4)
    expect(store.awaitingStart.value?.generation).toBe(generation + 1)
  })

  it('does not extend the shared TTL by the duration of a slow renewal', async () => {
    const { store, source } = await setup()
    await store.armNextPreparation(); await store.next()
    const pending = deferred<Playable>()
    source.resolve.mockReturnValueOnce(pending.promise)
    const renewal = store.renewMedia('vkeys', store.playbackGeneration.value)
    await micro()
    vi.setSystemTime(epoch + 90_001)
    pending.resolve(media('slow-renewal', epoch + 600_000))
    expect(await renewal).toBe(true)
    expect(await store.recoverHandover('reResolve', store.playbackGeneration.value)).toBe(true)
    expect(source.resolve).toHaveBeenCalledTimes(4)
  })

  it('rejects a renewal that has already expired instead of publishing a new generation', async () => {
    const { store, source } = await setup()
    await store.armNextPreparation(); await store.next()
    const generation = store.playbackGeneration.value
    const previous = store.playable.value
    source.resolve.mockResolvedValueOnce(media('already-expired', epoch - 1))
    expect(await store.renewMedia('vkeys', generation)).toBe(false)
    expect(store.playable.value).toBe(previous)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.awaitingStart.value?.generation).toBe(generation)
  })
  it.each(['pending-next', 'seek'] as const)('aborts a pending renewal immediately after %s without changing the current generation', async (action) => {
    const { store, source } = await setup()
    const prepared = deferred<Playable>()
    source.resolve.mockReturnValueOnce(prepared.promise)
    const preparation = store.armNextPreparation()
    await micro()
    const pending = deferred<Playable>()
    source.resolve.mockReturnValueOnce(pending.promise)
    const generation = store.playbackGeneration.value
    const original = store.playable.value
    const renewal = store.renewMedia('vkeys', generation)
    await micro()
    const signal = source.resolve.mock.calls[2][1]
    const selection = action === 'pending-next' ? store.next() : undefined
    if (action === 'seek') store.reportProgress(42, generation, true)
    await micro()
    const abortedAtCommand = signal.aborted
    pending.resolve(media('obsolete-renewal'))
    const renewed = await renewal
    const unchanged = store.playable.value === original && store.playbackGeneration.value === generation
    prepared.resolve(media('prepared-b'))
    await preparation
    await selection
    expect(abortedAtCommand).toBe(true)
    expect(renewed).toBe(false)
    expect(unchanged).toBe(true)
    expect(store.currentTrack.value?.id).toBe(action === 'pending-next' ? 'b' : 'a')
    expect(store.playbackIntent.value).toBe('playing')
  })

})
