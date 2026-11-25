import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCatalogFilterState } from '../catalog/filterState'
import type { Track } from '../catalog/types'
import { ProviderRegistry } from './providers/registry'
import type { Playable } from './providers/types'
import { createPlaybackStore, type PlaybackStore } from './store'

const tracks: Track[] = [
  { id: 'bgm', title: 'Instrumental', games: ['hsr'], tabs: ['focus'], vocalStatus: 'instrumental' },
  { id: 'song-a', title: 'Song A', games: ['genshin'], tabs: ['focus'], vocalStatus: 'vocal' },
  { id: 'choir', title: 'Unverified Choir', games: ['zzz'], tabs: ['chill'], vocalStatus: 'uncertain' },
  { id: 'song-b', title: 'Song B', games: ['hsr'], tabs: [], vocalStatus: 'vocal' },
  { id: 'song-c', title: 'Song C', games: ['zzz'], tabs: ['sleep'], vocalStatus: 'vocal' },
].map(track => ({
  ...track, aliases: {}, relationIds: [], workGroupId: track.id, needsClassification: false,
  sources: ['lx', 'gd-studio'].map(provider => ({ provider, externalId: track.id })),
})) as Track[]

const stores: PlaybackStore[] = []
afterEach(() => { stores.splice(0).forEach(store => store.dispose()) })
const ids = (store: PlaybackStore) => store.queue.value.map(track => track.id)
const audio = (id: string, provider = 'lx'): Playable => ({
  kind: 'audio', url: `https://media.invalid/${provider}/${id}.mp3`, mimeType: 'audio/mpeg',
})

function setup(mode: 'vocal' | null = 'vocal', dynamicRegistry = false) {
  const values = new Map([['hoyomix-player-shuffle-v1', 'false']])
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  const lx = vi.fn(async (track: Track): Promise<Playable | null> => audio(track.id))
  const gd = vi.fn(async (track: Track): Promise<Playable | null> => audio(track.id, 'gd-studio'))
  const registry = new ProviderRegistry([
    { provider: { id: 'lx', resolve: lx }, enabled: true, priority: 1, timeoutMs: 1000 },
    { provider: { id: 'gd-studio', resolve: gd }, enabled: true, priority: 2, timeoutMs: 1000 },
  ])
  const filters = createCatalogFilterState(tracks, storage)
  filters.setMode(mode)
  const loadRegistry = vi.fn(async () => registry)
  const store = createPlaybackStore({ ...(dynamicRegistry ? { loadRegistry } : { registry }), storage, random: () => 0 })
  stores.push(store)
  store.reconcileUpcomingQueue(filters.filteredTracks.value)
  return { store, filters, storage, registry, loadRegistry, lx, gd }
}

describe('Vocal queue using the ordinary playback engine', () => {
  it('skips excluded history when Repeat All wraps, preloads, and traverses the next cycle', async () => {
    const { store, filters } = setup(null)
    filters.setMode(null)
    store.reconcileUpcomingQueue(filters.filteredTracks.value)
    await store.playQueueIndex(4)
    const current = store.currentTrack.value
    const generation = store.playbackGeneration.value
    filters.setMode('vocal')
    store.reconcileUpcomingQueue(filters.filteredTracks.value)
    expect(store.currentTrack.value).toBe(current)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(ids(store)).toEqual(['bgm', 'song-a', 'choir', 'song-b', 'song-c'])
    store.setRepeatMode('all')
    store.setPreloadPolicy('auto')
    expect(store.nextPreparationIndex.value).toBe(1)
    await store.armNextPreparation()
    expect(store.preparedNext.value?.track.id).toBe('song-a')
    await store.advanceAfterEnded()
    expect(store.currentTrack.value?.id).toBe('song-a')
    await store.next()
    expect(store.currentTrack.value?.id).toBe('song-b')
    await store.previous()
    expect(store.currentTrack.value?.id).toBe('song-a')
    await store.previous()
    expect(store.currentTrack.value?.id).toBe('song-a')
    await store.advanceAfterEnded()
    expect(store.currentTrack.value?.id).toBe('song-b')
  })

  it('ends an empty vocal intersection instead of repeating excluded history', async () => {
    const { store, filters, lx } = setup(null)
    filters.setMode(null)
    store.reconcileUpcomingQueue(filters.filteredTracks.value)
    await store.playQueueIndex(2)
    filters.replaceTracks(tracks.filter(track => track.vocalStatus !== 'vocal'))
    filters.setMode('vocal')
    store.reconcileUpcomingQueue(filters.filteredTracks.value)
    store.setRepeatMode('all')
    store.setPreloadPolicy('auto')
    const calls = lx.mock.calls.length
    expect(store.nextPreparationIndex.value).toBe(-1)
    await store.armNextPreparation()
    await store.advanceAfterEnded()
    expect(store.status.value).toBe('ended')
    expect(store.playbackIntent.value).toBe('paused')
    expect(lx).toHaveBeenCalledTimes(calls)
  })

  it('rechecks an automatic recovery skip when Vocal filters change before its microtask', async () => {
    const { store, filters, lx, gd } = setup(null)
    await store.playQueueIndex(4)
    store.setRepeatMode('all')
    lx.mockResolvedValue(null)
    gd.mockResolvedValue(null)
    const deferred: (() => void)[] = []
    const schedule = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => { deferred.push(callback) })
    try {
      await store.reportPlaybackFailure('lx', store.playbackGeneration.value)
      expect(deferred.length).toBeGreaterThan(0)
      filters.setMode('vocal')
      store.reconcileUpcomingQueue(filters.filteredTracks.value)
      lx.mockImplementation(async track => audio(track.id))
      gd.mockImplementation(async track => audio(track.id, 'gd-studio'))
      for (const callback of deferred.splice(0)) callback()
      await flushPromises()
      expect(store.currentTrack.value?.id).toBe('song-a')
    } finally {
      schedule.mockRestore()
    }
  })

  it('reselects the natural successor if its prepared history is filtered during registry validation', async () => {
    const { store, registry, loadRegistry, lx } = setup(null, true)
    store.reconcileUpcomingQueue([tracks[0], tracks[1], tracks[4]])
    await store.playQueueIndex(2)
    store.setRepeatMode('all')
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    expect(store.preparedNext.value?.track.id).toBe('bgm')
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    loadRegistry.mockImplementationOnce(async () => { entered(); await gate; return registry })
    const advance = store.advanceAfterEnded()
    await waiting
    store.reconcileUpcomingQueue([tracks[1], tracks[4]])
    release()
    await advance
    expect(store.currentTrack.value?.id).toBe('song-a')
    expect(lx.mock.calls.map(([track]) => track.id)).toEqual(['song-c', 'bgm', 'song-a'])
  })

  it('attempts each eligible track at most once when unavailable history remains in Repeat All', async () => {
    const { store, lx, gd } = setup(null)
    const history = Array.from({ length: 5 }, (_, i) => ({ ...tracks[0], id: `history-${i}` }))
    store.reconcileUpcomingQueue([])
    store.reconcileUpcomingQueue([...history, tracks[1], tracks[3]])
    await store.playQueueIndex(6)
    store.reconcileUpcomingQueue([tracks[1], tracks[3]])
    store.setRepeatMode('all')
    lx.mockResolvedValue(null)
    gd.mockResolvedValue(null)
    await store.reportPlaybackFailure('lx', store.playbackGeneration.value)
    await flushPromises()
    expect(lx.mock.calls.map(([track]) => track.id)).toEqual(['song-b', 'song-a'])
    expect(gd.mock.calls.map(([track]) => track.id)).toEqual(['song-b', 'song-a'])
    expect(store.playbackNotices.value.filter(notice => notice.kind === 'skipped')).toHaveLength(1)
    expect(store.playbackNotices.value.some(notice => notice.kind === 'queueUnplayable')).toBe(true)
  })

  it('honours Play Next for excluded history while a natural successor is being validated', async () => {
    const { store, registry, loadRegistry } = setup(null, true)
    store.reconcileUpcomingQueue([tracks[0], tracks[1], tracks[4]])
    await store.playQueueIndex(2)
    store.setRepeatMode('all')
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    loadRegistry.mockImplementationOnce(async () => { entered(); await gate; return registry })
    const advance = store.advanceAfterEnded()
    await waiting
    store.reconcileUpcomingQueue([tracks[1], tracks[4]])
    store.playNext(tracks[0])
    release()
    await advance
    expect(store.currentTrack.value?.id).toBe('bgm')
  })

  it('does not revisit an unavailable track when filters change during the failure cycle', async () => {
    const { store, lx, gd } = setup(null)
    store.reconcileUpcomingQueue([tracks[0], tracks[1], tracks[3]])
    await store.playQueueIndex(2)
    store.reconcileUpcomingQueue([tracks[1], tracks[3]])
    store.setRepeatMode('all')
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    lx.mockImplementation(async track => {
      if (track.id === 'song-a') { entered(); await gate }
      return null
    })
    gd.mockResolvedValue(null)
    await store.reportPlaybackFailure('lx', store.playbackGeneration.value)
    await waiting
    store.reconcileUpcomingQueue([tracks[1], tracks[3], tracks[4]])
    release()
    await flushPromises()
    expect(lx.mock.calls.map(([track]) => track.id)).toEqual(['song-b', 'song-a', 'song-c'])
    expect(store.playbackNotices.value.some(notice => notice.kind === 'queueUnplayable')).toBe(true)
  })

  it('does not spend handover recovery budget on excluded history', async () => {
    const { store } = setup(null)
    store.reconcileUpcomingQueue([tracks[0], tracks[2], tracks[3]])
    await store.playQueueIndex(2)
    store.reconcileUpcomingQueue([tracks[3]])
    const generation = store.playbackGeneration.value
    expect(await store.recoverHandover('srcSwap', generation)).toBe(false)
    expect(store.currentTrack.value?.id).toBe('song-b')
  })

  it('allows handover recovery only for the remaining eligible queue budget', async () => {
    const { store } = setup(null)
    store.reconcileUpcomingQueue([tracks[0], tracks[2], tracks[3], tracks[4]])
    await store.playQueueIndex(2)
    store.reconcileUpcomingQueue([tracks[3], tracks[4]])
    const generation = store.playbackGeneration.value
    expect(await store.recoverHandover('srcSwap', generation)).toBe(true)
    expect(await store.recoverHandover('srcSwap', generation)).toBe(false)
  })

  it('shares the eligible queue budget between handover recovery and unavailable skips', async () => {
    const { store, lx, gd } = setup()
    store.reconcileUpcomingQueue([tracks[1], tracks[3]])
    await store.playQueueIndex(0)
    store.setRepeatMode('all')
    expect(await store.recoverHandover('srcSwap', store.playbackGeneration.value)).toBe(true)
    lx.mockResolvedValue(null)
    gd.mockResolvedValue(null)
    await store.reportPlaybackFailure('lx', store.playbackGeneration.value)
    await flushPromises()
    expect(store.currentTrack.value?.id).toBe('song-a')
    expect(lx.mock.calls.map(([track]) => track.id)).toEqual(['song-a'])
  })

  it('does not override a newer listener selection while validating a natural successor', async () => {
    const { store, registry, loadRegistry } = setup(null, true)
    store.reconcileUpcomingQueue([tracks[0], tracks[1], tracks[4]])
    await store.playQueueIndex(2)
    store.setRepeatMode('all')
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    loadRegistry.mockImplementationOnce(async () => { entered(); await gate; return registry })
    const advance = store.advanceAfterEnded()
    await waiting
    await store.playNow(tracks[3])
    release()
    await advance
    expect(store.currentTrack.value?.id).toBe('song-b')
  })

  it('plays Next and Previous across vocal tracks regardless of their unchanged tabs', async () => {
    const { store } = setup()
    expect(ids(store)).toEqual(['song-a', 'song-b', 'song-c'])
    await store.next()
    expect(store.currentTrack.value?.id).toBe('song-a')
    await store.next()
    expect(store.currentTrack.value?.id).toBe('song-b')
    await store.previous()
    expect(store.currentTrack.value?.id).toBe('song-a')
    await store.previous()
    expect(store.currentTrack.value?.id).toBe('song-a')
    await store.playQueueIndex(2)
    const generation = store.playbackGeneration.value
    await store.next()
    expect(store.currentTrack.value?.id).toBe('song-c')
    expect(store.playbackGeneration.value).toBe(generation)
    expect(tracks.map(track => track.tabs)).toEqual([['focus'], ['focus'], ['chill'], [], ['sleep']])
  })

  it('shuffles only upcoming vocal entries and restores catalogue order without moving history', async () => {
    const { store } = setup()
    await store.next()
    const current = store.currentTrack.value
    store.setShuffle(true)
    expect(ids(store)).toEqual(['song-a', 'song-c', 'song-b'])
    expect(store.currentTrack.value).toBe(current)
    store.setShuffle(false)
    expect(ids(store)).toEqual(['song-a', 'song-b', 'song-c'])
    await store.next()
    store.setShuffle(true)
    expect(ids(store).slice(0, 2)).toEqual(['song-a', 'song-b'])
    expect(new Set(ids(store)).size).toBe(3)
  })

  it.each(['off', 'all', 'one'] as const)('handles natural end with Repeat %s', async mode => {
    const { store } = setup()
    await store.playQueueIndex(2)
    store.setRepeatMode(mode)
    const generation = store.playbackGeneration.value
    await store.advanceAfterEnded()
    expect(store.currentTrack.value?.id).toBe(mode === 'all' ? 'song-a' : 'song-c')
    expect(store.playbackIntent.value).toBe(mode === 'off' ? 'paused' : 'playing')
    if (mode === 'off') expect(store.status.value).toBe('ended')
    else expect(store.playbackGeneration.value).toBeGreaterThan(generation)
  })

  it('manual Next still advances under Repeat One and Previous returns through vocal history', async () => {
    const { store } = setup()
    await store.next()
    store.setRepeatMode('one')
    await store.next()
    expect(store.currentTrack.value?.id).toBe('song-b')
    await store.previous()
    expect(store.currentTrack.value?.id).toBe('song-a')
    expect(store.nextPreparationIndex.value).toBe(-1)
  })

  it('handles a single vocal match and an empty structural intersection without resolving excluded tracks', async () => {
    const { store, filters, lx } = setup()
    filters.toggleGame('genshin')
    filters.toggleGame('zzz')
    store.reconcileUpcomingQueue(filters.filteredTracks.value)
    expect(ids(store)).toEqual(['song-b'])
    await store.next()
    store.setRepeatMode('all')
    await store.advanceAfterEnded()
    expect(store.currentTrack.value?.id).toBe('song-b')
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    expect(store.preparedNext.value).toBeNull()
    store.stop()
    filters.replaceTracks(tracks.filter(track => track.id !== 'song-b'))
    store.reconcileUpcomingQueue(filters.filteredTracks.value)
    await store.next()
    await store.previous()
    await store.advanceAfterEnded()
    expect(ids(store)).toEqual([])
    expect(store.currentTrack.value).toBeUndefined()
    expect(lx.mock.calls.every(([track]) => track.id === 'song-b')).toBe(true)
  })

  it('retains explicit Play Next, reorder and removal across a vocal catalogue refresh', async () => {
    const { store, filters } = setup()
    await store.next()
    store.playNext(tracks[4])
    store.setShuffle(true)
    expect(ids(store)).toEqual(['song-a', 'song-c', 'song-b'])
    expect(store.removeQueueIndex(2)).toBe(true)
    const added = { ...tracks[3], id: 'song-new' }
    filters.replaceTracks([...tracks, added])
    store.replaceQueueSource(filters.filteredTracks.value)
    expect(ids(store)).toEqual(['song-a', 'song-c', 'song-new'])
    expect(store.moveQueueItem(2, 1)).toBe(true)
    expect(ids(store)).toEqual(['song-a', 'song-new', 'song-c'])
  })

  it('prepares the vocal successor through fallback and adopts it without another resolution', async () => {
    const { store, lx, gd } = setup()
    lx.mockImplementation(async track => track.id === 'song-b' ? null : audio(track.id))
    await store.next()
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    const prepared = store.preparedNext.value
    expect(prepared?.track.id).toBe('song-b')
    expect(prepared?.providerId).toBe('gd-studio')
    await store.next()
    expect(store.currentTrack.value?.id).toBe('song-b')
    expect(store.preloadHandoff.value?.id).toBe(prepared?.id)
    expect(store.playable.value).toEqual(prepared?.playable)
    expect(lx.mock.calls.map(([track]) => track.id)).toEqual(['song-a', 'song-b'])
    expect(gd.mock.calls.map(([track]) => track.id)).toEqual(['song-b'])
  })

  it('invalidates an excluded standby without changing the active track or transition preferences', async () => {
    const { store, filters } = setup()
    await store.next()
    store.setTransitionMode('crossfade')
    store.setCrossfadeDuration(4)
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    const current = store.currentTrack.value
    const playable = store.playable.value
    const generation = store.playbackGeneration.value
    const old = store.preparedNext.value!
    filters.toggleGame('hsr')
    store.reconcileUpcomingQueue(filters.filteredTracks.value)
    await flushPromises()
    expect(store.currentTrack.value).toBe(current)
    expect(store.playable.value).toBe(playable)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.canHandoffPreparation(old.id)).toBe(false)
    await store.armNextPreparation()
    expect(store.preparedNext.value?.track.id).toBe('song-c')
    expect(store.transitionMode.value).toBe('crossfade')
    expect(store.crossfadeDuration.value).toBe(4)
  })

  it('recovers a failed active source on the same vocal track before advancing', async () => {
    const { store, gd } = setup()
    await store.next()
    store.reportMediaState('playing', store.playbackGeneration.value)
    const session = store.listeningSessionId.value
    await store.reportPlaybackFailure('lx', store.playbackGeneration.value)
    expect(store.currentTrack.value?.id).toBe('song-a')
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.playbackIntent.value).toBe('playing')
    expect(gd.mock.calls.map(([track]) => track.id)).toEqual(['song-a'])
    expect(ids(store)).toEqual(['song-a', 'song-b', 'song-c'])
  })
})
