import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProviderConfigurationUnavailableError } from './providerConfigFailure'
import type { Track } from '../catalog/types'
import { createPlaybackStore, type PlaybackStore } from './store'
import { ProviderRegistry } from './providers/registry'
import { ProviderResolveError, type AudioProvider } from './providers/types'

const stores: PlaybackStore[] = []
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0) }
const track = (id: string): Track => ({ id, title: id, aliases: {}, games: ['hsr'], tabs: ['focus'],
  relationIds: [], workGroupId: 'fixture', vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'lx', externalId: 'wy:' + id }, { provider: 'gd-studio', externalId: 'netease:' + id }] })
function setup(alwaysTransient = false) {
  let bCalls = 0
  const lx: AudioProvider = { id: 'lx', canResolve: () => true, resolve: vi.fn(async value => {
    if (value.id === 'b' && (++bCalls === 1 || alwaysTransient)) throw new ProviderResolveError('unavailable', { transient: true })
    return { kind: 'audio' as const, url: 'https://media.invalid/' + value.id + '.mp3', mimeType: 'audio/mpeg' }
  }) }
  const gd: AudioProvider = { id: 'gd-studio', canResolve: () => true, resolve: vi.fn(async () => { throw new ProviderResolveError('not_found') }) }
  const registry = new ProviderRegistry([lx, gd].map((provider, priority) => ({ provider, priority, enabled: true, timeoutMs: 1000 })))
  const store = createPlaybackStore({ loadRegistry: async () => registry,
    storage: { getItem: key => key.includes('shuffle') ? 'false' : null, setItem() {} } })
  store.reconcileUpcomingQueue(['a', 'b', 'c'].map(track)); stores.push(store)
  return { store, lx, gd, registry, bCalls: () => bCalls }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { stores.splice(0).forEach(store => store.dispose()); vi.restoreAllMocks(); vi.useRealTimers() })

it('retries the transient provider on the same automatically selected track despite another provider not_found', async () => {
  const { store, gd, bCalls } = setup()
  await store.playQueueIndex(0); store.reportMediaState('playing', store.playbackGeneration.value)
  await store.advanceAfterEnded(); await flush()
  expect(store.currentTrack.value?.id).toBe('b')
  expect(store.playbackNotices.value.some(n => n.kind === 'skipped')).toBe(false)
  await vi.advanceTimersByTimeAsync(1500); await flush()
  expect(store.currentTrack.value?.id).toBe('b'); expect(store.activeProviderId.value).toBe('lx')
  expect(store.status.value).toBe('ready'); expect(bCalls()).toBe(2)
  expect(gd.resolve).toHaveBeenCalledTimes(1)
})

it('cancels the mixed-failure retry on explicit Pause without advancing the queue', async () => {
  const { store, bCalls } = setup()
  await store.playQueueIndex(0); store.reportMediaState('playing', store.playbackGeneration.value)
  await store.advanceAfterEnded(); await flush(); store.pause()
  await vi.advanceTimersByTimeAsync(10000); await flush()
  expect(store.currentTrack.value?.id).toBe('b'); expect(store.playbackIntent.value).toBe('paused')
  expect(bCalls()).toBe(1); expect(store.playbackNotices.value.some(n => n.kind === 'skipped')).toBe(false)
})

it('bounds a persistent mixed outage to two same-track retries and one queue advancement', async () => {
  const { store, gd, bCalls } = setup(true)
  await store.playQueueIndex(0); store.reportMediaState('playing', store.playbackGeneration.value)
  await store.advanceAfterEnded(); await flush()
  await vi.advanceTimersByTimeAsync(6000); await flush()
  expect(bCalls()).toBe(3); expect(gd.resolve).toHaveBeenCalledTimes(1)
  expect(store.currentTrack.value?.id).toBe('c')
  expect(store.playbackNotices.value.filter(n => n.kind === 'skipped')).toHaveLength(1)
})


it('preserves the transient-provider selection through a configuration outage during its retry', async () => {
  const calls: string[] = []
  const lx: AudioProvider = { id: 'lx', canResolve: () => true, resolve: async value => {
    calls.push('lx:' + value.id)
    throw new ProviderResolveError('unavailable', { transient: true })
  } }
  const gd: AudioProvider = { id: 'gd-studio', canResolve: () => true, resolve: async value => {
    calls.push('gd:' + value.id)
    throw new ProviderResolveError('forbidden')
  } }
  const registry = new ProviderRegistry([lx, gd].map((provider, priority) => ({
    provider, priority, enabled: true, timeoutMs: 1000,
  })))
  let loads = 0
  const store = createPlaybackStore({
    loadRegistry: async () => {
      if (++loads === 2) throw new ProviderConfigurationUnavailableError('network')
      return registry
    },
    peekRegistry: () => registry,
    storage: { getItem: key => key.includes('shuffle') ? 'false' : null, setItem() {} },
  })
  stores.push(store)
  store.reconcileUpcomingQueue(['a', 'b'].map(track))
  await store.playQueueIndex(0); await flush()
  expect(calls).toEqual(['lx:a', 'gd:a'])
  await vi.advanceTimersByTimeAsync(1500); await flush()
  expect(calls).toEqual(['lx:a', 'gd:a'])
  await vi.advanceTimersByTimeAsync(1000); await flush()
  expect(calls).toEqual(['lx:a', 'gd:a', 'lx:a'])
  expect(store.currentTrack.value?.id).toBe('a')
})
