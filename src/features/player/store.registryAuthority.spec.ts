import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeProviderRepository } from './runtimeConfig'
import { createPlaybackStore } from './store'
import type { Track } from '../catalog/types'
import type { Playable } from './providers/types'
import { ProviderRegistry } from './providers/registry'
import { resolveTrack } from './resolver'

const endpoint = new URL('/api/providers/config', window.location.origin).href
const tracks = ['a', 'b'].map(id => ({ id, title: id, sources: [{ provider: 'lx', externalId: id }] })) as Track[]
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(dispose => dispose()); vi.useRealTimers() })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const audio = (id: string): Playable => ({
  kind: 'audio', url: 'https://media.invalid/' + id + '.mp3', mimeType: 'audio/mpeg', expiresAt: Date.now() + 120_000,
})
function response(mode: 'enabled' | 'empty' | 'disabled' | 'denied' = 'enabled') {
  const result = Response.json({ version: 1, providers: mode === 'empty' ? [] : [
    { id: 'lx', available: true, enabled: mode !== 'disabled', automaticEligible: true, priority: 1 },
  ] }, { status: mode === 'denied' ? 403 : 200 })
  Object.defineProperty(result, 'url', { value: endpoint })
  return result
}
async function setup() {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  let disabled = false
  const fetcher = vi.fn(async () => response())
  const resolve = vi.fn(async (track: Track): Promise<Playable | null> => audio(track.id))
  const repository = createRuntimeProviderRepository({ fetch: fetcher,
    providerPreferences: { isDisabled: () => disabled, revision: () => disabled ? 1 : 0 },
    lxProviderFactory: () => ({ id: 'lx', canResolve: () => true, resolve }),
  })
  await repository.load()
  let afterLoad: (() => Promise<unknown>) | undefined
  const store = createPlaybackStore({ loadRegistry: async options => {
    const registry = await repository.loadPlayback(options)
    const hook = afterLoad
    afterLoad = undefined
    await hook?.()
    return registry
  }, peekRegistry: repository.peekPlayback,
    storage: { getItem: key => key.includes('shuffle') ? 'false' : null, setItem() {} },
  })
  cleanups.push(() => store.dispose())
  store.reconcileUpcomingQueue(tracks)
  return { repository, store, resolve, fetcher, disable: () => { disabled = true },
    afterNextLoad: (hook: () => Promise<unknown>) => { afterLoad = hook },
  }
}

describe('current registry authority after asynchronous playback work', () => {
  it('rejects a memoised resolver result that is no longer a member of the revalidated registry', async () => {
    const { repository, resolve, fetcher } = await setup()
    const pending = deferred<Playable>()
    resolve.mockImplementationOnce(() => pending.promise)
    let cached: ReturnType<typeof resolveTrack> | undefined
    const adapter = vi.fn((track: Track, registry: ProviderRegistry, options: Parameters<typeof resolveTrack>[2]) =>
      cached ??= resolveTrack(track, registry, {
        signal: options?.signal, sourceOverride: options?.sourceOverride, excludeProviderIds: options?.excludeProviderIds,
      }))
    const store = createPlaybackStore({ loadRegistry: repository.loadPlayback, peekRegistry: repository.peekPlayback,
      resolve: adapter, storage: { getItem: key => key.includes('shuffle') ? 'false' : null, setItem() {} },
    })
    cleanups.push(() => store.dispose())
    store.reconcileUpcomingQueue(tracks)
    const playing = store.playQueueIndex(0)
    await vi.advanceTimersByTimeAsync(0)
    fetcher.mockResolvedValue(response('empty'))
    await repository.load({ forceRefresh: true })
    pending.resolve(audio('memoised-revoked'))
    await playing
    expect(adapter).toHaveBeenCalledTimes(2)
    expect(store.playable.value).toBeNull()
    expect(store.activeProviderId.value).toBeUndefined()
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.playbackNotices.value.some(notice => notice.kind === 'skipped')).toBe(false)
  })

  it.each(['empty', 'disabled', 'denied', 'local'] as const)('does not publish a resolve completed after %s revocation', async mode => {
    const { store, repository, resolve, fetcher, disable } = await setup()
    const pending = deferred<Playable>()
    resolve.mockImplementationOnce(() => pending.promise)
    const playing = store.playQueueIndex(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolve).toHaveBeenCalledTimes(1)
    if (mode === 'local') disable()
    else { fetcher.mockResolvedValue(response(mode)); await repository.load({ forceRefresh: true }) }
    expect(repository.peekPlayback()?.selectable() ?? []).toHaveLength(0)
    pending.resolve(audio('revoked'))
    await playing
    expect(store.playable.value).toBeNull()
    expect(store.activeProviderId.value).toBeUndefined()
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.playbackNotices.value.some(notice => notice.kind === 'skipped')).toBe(false)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('discards a preparation resolved after authoritative empty configuration', async () => {
    const { store, repository, resolve, fetcher } = await setup()
    await store.playQueueIndex(0)
    store.setPreloadPolicy('auto')
    store.reportMediaState('playing', store.playbackGeneration.value)
    const pending = deferred<Playable>()
    resolve.mockImplementationOnce(() => pending.promise)
    const preparing = store.prepareTransition(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolve).toHaveBeenCalledTimes(2)
    fetcher.mockResolvedValue(response('empty'))
    await repository.load({ forceRefresh: true })
    pending.resolve(audio('revoked-preparation'))
    await preparing
    expect(store.preparedNext.value).toBeNull()
  })

  it('does not adopt a captured preparation while a forced validation is pending', async () => {
    const { store, repository, fetcher, resolve } = await setup()
    await store.playQueueIndex(0)
    store.setPreloadPolicy('auto')
    store.reportMediaState('playing', store.playbackGeneration.value)
    await store.prepareTransition(1)
    const prepared = store.preparedNext.value!
    expect(prepared).not.toBeNull()
    await vi.advanceTimersByTimeAsync(6000)
    const pending = deferred<Response>()
    fetcher.mockImplementationOnce(() => pending.promise)
    const advancing = store.next()
    const forced = repository.loadPlayback({ forceRefresh: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(repository.peekPlayback()).toBeUndefined()
    expect(store.playable.value).not.toBe(prepared.playable)
    expect(resolve).toHaveBeenCalledTimes(2)
    pending.resolve(response())
    await Promise.all([advancing, forced])
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.playable.value).not.toBe(prepared.playable)
    expect(store.playable.value?.kind).toBe('audio')
    expect(resolve).toHaveBeenCalledTimes(3)
  })

  it('does not publish a renewed ticket after permissions change during renewal', async () => {
    const { store, repository, fetcher, resolve } = await setup()
    await store.playQueueIndex(0)
    store.reportMediaState('playing', store.playbackGeneration.value)
    const initial = store.playable.value
    const pending = deferred<Playable>()
    resolve.mockImplementationOnce(() => pending.promise)
    const renewal = store.renewMedia('lx', store.playbackGeneration.value)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolve).toHaveBeenCalledTimes(2)
    fetcher.mockResolvedValue(response('empty'))
    await repository.load({ forceRefresh: true })
    pending.resolve(audio('revoked-renewal'))
    expect(await renewal).toBe(false)
    expect(store.playable.value).toBe(initial)
  })

  it('rejects an old preparation when authoritative empty configuration wins the adoption race', async () => {
    const { store, repository, fetcher, resolve, afterNextLoad } = await setup()
    await store.playQueueIndex(0)
    store.setPreloadPolicy('auto')
    store.reportMediaState('playing', store.playbackGeneration.value)
    await store.prepareTransition(1)
    const prepared = store.preparedNext.value!
    expect(prepared).not.toBeNull()
    afterNextLoad(async () => {
      fetcher.mockResolvedValue(response('empty'))
      await repository.load({ forceRefresh: true })
    })
    await store.next()
    expect(repository.peekPlayback()?.selectable()).toHaveLength(0)
    expect(store.playable.value).toBeNull()
    expect(store.preloadHandoff.value).toBeNull()
    expect(store.currentTrack.value?.id).toBe('b')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('bounds repeated configuration changes without skipping or an automatic retry loop', async () => {
    const { store, repository, resolve } = await setup()
    resolve.mockImplementation(async () => {
      await repository.load({ forceRefresh: true })
      return audio('obsolete')
    })
    await store.playQueueIndex(0)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(store.playable.value).toBeNull()
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.playbackIntent.value).toBe('playing')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(store.playbackNotices.value.some(notice => notice.kind === 'skipped')).toBe(false)
  })

  it('does not dispatch another fallback provider from a superseded registry', async () => {
    let current = true
    const first = deferred<Playable | null>()
    const fallback = vi.fn(async () => audio('fallback'))
    const registry = new ProviderRegistry([
      { provider: { id: 'lx', canResolve: () => true, resolve: () => first.promise }, enabled: true, priority: 1, timeoutMs: 1000 },
      { provider: { id: 'gd-studio', canResolve: () => true, resolve: fallback }, enabled: true, priority: 2, timeoutMs: 1000 },
    ])
    const resolving = resolveTrack(tracks[0], registry, { isRegistryCurrent: () => current })
    const rejected = expect(resolving).rejects.toMatchObject({ name: 'ProviderConfigurationChangedError' })
    current = false
    first.resolve(null)
    await rejected
    expect(fallback).not.toHaveBeenCalled()
  })
})
