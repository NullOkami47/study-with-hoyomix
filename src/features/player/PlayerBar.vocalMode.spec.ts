import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick, watch } from 'vue'

import { createCatalogFilterState } from '../catalog/filterState'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { playbackCommands } from './commands'
import { ProviderRegistry } from './providers/registry'
import type { Playable } from './providers/types'
import { createPlaybackStore } from './store'

// Real filter/store/component integration. Only provider I/O and the native media
// boundary are controlled, following PlayerBar.crossfade.spec.ts. These events
// do not qualify browser decoding or physical-device background behaviour.
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

const audio = (id: string, provider = 'lx'): Playable => ({
  kind: 'audio', url: 'https://media.invalid/' + provider + '/' + id + '.mp3', mimeType: 'audio/mpeg',
})
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await nextTick()
}
function media(element: HTMLAudioElement, buffered = 30): void {
  Object.defineProperties(element, {
    duration: { configurable: true, value: 30 },
    readyState: { configurable: true, value: 4 },
    ended: { configurable: true, value: false },
    seeking: { configurable: true, value: false },
    buffered: { configurable: true, value: { length: buffered ? 1 : 0, start: () => 0, end: () => buffered } },
    seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 30 } },
  })
}
const cleanups: Array<() => void> = []
afterEach(() => {
  cleanups.splice(0).reverse().forEach(close => close())
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(
  mode: 'off' | 'crossfade' | 'smart',
  startIndex = 4,
  queueTracks: Track[] = tracks,
  useRegistryLoader = false,
) {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => document.visibilityState === 'hidden')
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
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
  let validateRegistry: () => Promise<ProviderRegistry> = async () => registry
  const store = createPlaybackStore(useRegistryLoader
    ? { loadRegistry: () => validateRegistry(), peekRegistry: () => registry, storage, random: () => 0 }
    : { registry, storage, random: () => 0 })
  const filters = createCatalogFilterState(queueTracks, storage)
  // Match the workspace's catalogue-to-queue wiring, rather than assigning queue refs.
  const stopFilterWatch = watch(filters.filteredTracks, filtered => store.reconcileUpcomingQueue(filtered), { flush: 'sync', immediate: true })
  store.setTransitionMode(mode)
  store.setPreloadPolicy('auto')
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const requests: Array<{ element: HTMLMediaElement; src: string | null }> = []
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    requests.push({ element: this, src: this.getAttribute('src') })
    Object.defineProperty(this, 'paused', { configurable: true, value: false })
    this.dispatchEvent(new Event('play'))
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    if (this.paused) return
    Object.defineProperty(this, 'paused', { configurable: true, value: true })
    this.dispatchEvent(new Event('pause'))
  })
  const wrapper = mount(PlayerBar, { props: { store } })
  cleanups.push(() => { wrapper.unmount(); stopFilterWatch(); store.dispose() })
  await store.playQueueIndex(startIndex)
  await flush()
  const active = () => wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
  const standby = () => wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element
  media(active())
  active().currentTime = 10
  active().dispatchEvent(new Event('timeupdate'))
  await flush()
  const setVisibility = async (state: DocumentVisibilityState) => {
    visibility.mockReturnValue(state)
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
  }
  return {
    store, filters, wrapper, lx, gd, play, requests, active, standby, registry, setVisibility,
    setRegistryValidation: (validate: () => Promise<ProviderRegistry>) => { validateRegistry = validate },
  }
}

function count(wrapper: VueWrapper): string { return wrapper.get('[data-player-queue-count]').text() }
async function prepare(t: Awaited<ReturnType<typeof setup>>): Promise<HTMLAudioElement> {
  await t.store.armNextPreparation()
  await flush()
  const standby = t.standby()
  media(standby)
  standby.dispatchEvent(new Event('progress'))
  await flush()
  return standby
}
async function navigate(t: Awaited<ReturnType<typeof setup>>, direction: 'next' | 'previous'): Promise<void> {
  playbackCommands[direction]?.()
  await flush()
  const standby = t.wrapper.find<HTMLAudioElement>('[data-audio-role="standby"]')
  if (standby.exists()) {
    media(standby.element)
    standby.element.dispatchEvent(new Event('progress'))
  }
  await vi.advanceTimersByTimeAsync(700)
  await flush()
  await vi.advanceTimersByTimeAsync(1600)
  await flush()
  media(t.active())
  t.active().dispatchEvent(new Event('playing'))
}
function naturalEnd(element: HTMLAudioElement): void {
  element.currentTime = 30
  Object.defineProperty(element, 'ended', { configurable: true, value: true })
  Object.defineProperty(element, 'paused', { configurable: true, value: true })
  element.dispatchEvent(new Event('pause'))
  element.dispatchEvent(new Event('ended'))
}

describe('Vocal transport with deferred preparation validation', () => {
  it('cancels Off-mode Previous when Vocal excludes its target before validation completes', async () => {
    const t = await setup('off', 1, tracks.slice(0, 2), true)
    t.store.setRepeatMode('all')
    await prepare(t)
    expect(t.store.preparedNext.value?.track.id).toBe('bgm')
    const callsBeforePrevious = t.lx.mock.calls.length
    let validate!: () => void
    let deferred = true
    t.setRegistryValidation(() => {
      if (!deferred) return Promise.resolve(t.registry)
      deferred = false
      return new Promise(resolve => { validate = () => resolve(t.registry) })
    })
    const generation = t.store.playbackGeneration.value
    const previous = t.store.previous()
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-a')
    t.filters.setMode('vocal')
    await flush()
    validate()
    await previous
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-a')
    expect(t.store.playbackGeneration.value).toBe(generation)
    expect(t.lx.mock.calls.slice(callsBeforePrevious).map(([track]) => track.id)).toEqual([])
    // Explicit history selection remains available to the listener.
    await t.store.playQueueIndex(0)
    expect(t.store.currentTrack.value?.id).toBe('bgm')
    expect(t.lx.mock.calls.at(-1)?.[0].id).toBe('bgm')
  })
})

describe.each(['off', 'crossfade', 'smart'] as const)('Vocal PlayerBar with %s transitions', mode => {

  it('filters during instrumental playback without interrupting its deck, position or intent', async () => {
    const t = await setup(mode, 0)
    const current = t.active()
    const generation = t.store.playbackGeneration.value
    const playable = t.store.playable.value
    const plays = t.requests.length
    expect(count(t.wrapper)).toBe('4')
    t.filters.setMode('vocal')
    await flush()
    expect(t.filters.filteredTracks.value.map(track => track.id)).toEqual(['song-a', 'song-b', 'song-c'])
    expect(t.store.currentTrack.value?.id).toBe('bgm')
    expect(t.store.playbackGeneration.value).toBe(generation)
    expect(t.store.playable.value).toBe(playable)
    expect(t.active()).toBe(current)
    expect(current.currentTime).toBe(10)
    expect(current.paused).toBe(false)
    expect(t.store.playbackIntent.value).toBe('playing')
    expect(t.store.status.value).toBe('playing')
    expect(t.requests).toHaveLength(plays)
    expect(count(t.wrapper)).toBe('3')
    expect(tracks.map(track => track.tabs)).toEqual([['focus'], ['focus'], ['chill'], [], ['sleep']])
    naturalEnd(current)
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-a')
    expect(count(t.wrapper)).toBe('2')
  })

  it.each([30, 0])('does not replay an excluded instrumental at EOS during Repeat One (buffered %s s)', async buffered => {
    const t = await setup(mode, 0)
    t.store.setRepeatMode('one')
    t.filters.setMode('vocal')
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('bgm')
    const plays = t.requests.length
    media(t.active(), buffered)
    naturalEnd(t.active())
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-a')
    expect(t.store.playbackIntent.value).toBe('playing')
    expect(t.requests.slice(plays).map(request => request.src)).toEqual(['https://media.invalid/lx/song-a.mp3'])
    expect(t.store.repeatMode.value).toBe('one')
    expect(count(t.wrapper)).toBe('2')
  })

  it.each(['off', 'one', 'all'] as const)('Next/Previous skip filtered history under Repeat %s', async repeat => {
    const t = await setup(mode, 3)
    t.store.setRepeatMode(repeat)
    t.filters.setMode('vocal')
    await flush()
    expect([...t.store.filteredHistoryIds!.value]).toEqual(['bgm', 'choir'])
    const before = t.lx.mock.calls.length
    await navigate(t, 'previous')
    expect(t.store.currentTrack.value?.id).toBe('song-a')
    // 'choir' is still in the physical queue after this backwards step.
    expect(t.store.queue.value.map(track => track.id)).toEqual(['bgm', 'song-a', 'choir', 'song-b', 'song-c'])
    expect(count(t.wrapper)).toBe('2')
    const generation = t.store.playbackGeneration.value
    await navigate(t, 'previous')
    expect(t.store.currentTrack.value?.id).toBe('song-a')
    expect(t.store.playbackGeneration.value).toBe(generation)
    await navigate(t, 'next')
    expect(t.store.currentTrack.value?.id).toBe('song-b')
    expect(count(t.wrapper)).toBe('1')
    await navigate(t, 'next')
    expect(t.store.currentTrack.value?.id).toBe('song-c')
    expect(count(t.wrapper)).toBe('0')
    expect(t.lx.mock.calls.slice(before).map(([track]) => track.id)).not.toContain('bgm')
    expect(t.lx.mock.calls.slice(before).map(([track]) => track.id)).not.toContain('choir')
    expect(t.store.repeatMode.value).toBe(repeat)
  })

  it('stops at the final vocal EOS with Repeat Off', async () => {
    const t = await setup(mode)
    t.filters.setMode('vocal')
    await flush()
    const generation = t.store.playbackGeneration.value
    const resolves = t.lx.mock.calls.length
    const plays = t.requests.length
    naturalEnd(t.active())
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-c')
    expect(t.store.status.value).toBe('ended')
    expect(t.store.playbackIntent.value).toBe('paused')
    expect(t.store.playbackGeneration.value).toBe(generation)
    expect(t.lx).toHaveBeenCalledTimes(resolves)
    expect(t.requests).toHaveLength(plays)
    expect(count(t.wrapper)).toBe('0')
  })

  it('repeats a buffered vocal deck with Repeat One without resolving or replaying filtered history', async () => {
    const t = await setup(mode)
    t.store.setRepeatMode('one')
    t.filters.setMode('vocal')
    await flush()
    const current = t.active()
    const source = current.getAttribute('src')
    const generation = t.store.playbackGeneration.value
    const session = t.store.listeningSessionId.value
    const resolves = t.lx.mock.calls.length
    const plays = t.requests.length
    naturalEnd(current)
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-c')
    expect(t.active()).toBe(current)
    expect(current.getAttribute('src')).toBe(source)
    expect(current.currentTime).toBe(0)
    expect(t.store.listeningSessionId.value).toBe(session + 1)
    expect(t.store.playbackGeneration.value).toBe(generation)
    expect(t.store.playbackIntent.value).toBe('playing')
    expect(t.store.status.value).toBe('playing')
    expect(t.lx).toHaveBeenCalledTimes(resolves)
    expect(t.requests.slice(plays).map(request => request.src)).toEqual([source])
  })

  it('resolves only the current vocal again when Repeat One cannot reuse a full buffer', async () => {
    const t = await setup(mode)
    t.store.setRepeatMode('one')
    t.filters.setMode('vocal')
    await flush()
    const generation = t.store.playbackGeneration.value
    media(t.active(), 0)
    naturalEnd(t.active())
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-c')
    expect(t.store.playbackGeneration.value).toBe(generation + 1)
    expect(t.store.playbackIntent.value).toBe('playing')
    expect(t.lx.mock.calls.map(([track]) => track.id)).toEqual(['song-c', 'song-c'])
    expect(t.gd).not.toHaveBeenCalled()
    expect(count(t.wrapper)).toBe('0')
  })

  it('wraps Repeat All through vocal-only cycles and counts only playable upcoming rows', async () => {
    const t = await setup(mode)
    t.store.setRepeatMode('all')
    t.filters.setMode('vocal')
    await flush()
    const before = t.lx.mock.calls.length
    const plays = t.requests.length
    for (const [id, upcoming] of [['song-a', '2'], ['song-b', '1'], ['song-c', '0'], ['song-a', '2']] as const) {
      media(t.active())
      naturalEnd(t.active())
      await flush()
      expect(t.store.currentTrack.value?.id).toBe(id)
      expect(t.store.playbackIntent.value).toBe('playing')
      expect(count(t.wrapper)).toBe(upcoming)
    }
    expect(t.lx.mock.calls.slice(before).map(([track]) => track.id)).toEqual(['song-a', 'song-b', 'song-c', 'song-a'])
    expect(t.gd).not.toHaveBeenCalled()
    expect(t.requests.slice(plays).map(request => request.src)).toEqual([
      'https://media.invalid/lx/song-a.mp3', 'https://media.invalid/lx/song-b.mp3',
      'https://media.invalid/lx/song-c.mp3', 'https://media.invalid/lx/song-a.mp3',
    ])
  })

  it('ends an empty Vocal/game intersection under Repeat All without replaying the excluded active track', async () => {
    const t = await setup(mode, 2)
    t.store.setRepeatMode('all')
    // Only ZZZ remains; replacing the catalogue removes its sole confirmed vocal.
    t.filters.toggleGame('genshin')
    t.filters.toggleGame('hsr')
    t.filters.replaceTracks(tracks.filter(track => track.id !== 'song-c'))
    t.filters.setMode('vocal')
    await flush()
    expect(t.filters.filteredTracks.value).toEqual([])
    expect(count(t.wrapper)).toBe('0')
    const resolves = t.lx.mock.calls.length
    const plays = t.requests.length
    naturalEnd(t.active())
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('choir')
    expect(t.store.status.value).toBe('ended')
    expect(t.store.playbackIntent.value).toBe('paused')
    expect(t.store.preparedNext.value).toBeNull()
    expect(t.lx).toHaveBeenCalledTimes(resolves)
    expect(t.requests).toHaveLength(plays)
  })

  it('discards an in-flight instrumental preparation when Vocal excludes its retained history row', async () => {
    const t = await setup(mode)
    t.store.setRepeatMode('all')
    let release!: (playable: Playable) => void
    t.lx.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = t.store.armNextPreparation()
    await flush()
    expect(t.lx.mock.calls.at(-1)?.[0].id).toBe('bgm')
    const generation = t.store.playbackGeneration.value
    const plays = t.requests.length
    t.filters.setMode('vocal')
    release(audio('bgm'))
    await pending
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-c')
    expect(t.store.playbackGeneration.value).toBe(generation)
    expect(t.store.preparedNext.value).toBeNull()
    expect(t.requests).toHaveLength(plays)
    await prepare(t)
    expect(t.store.preparedNext.value?.track.id).toBe('song-a')
    expect(t.standby().getAttribute('src')).toBe('https://media.invalid/lx/song-a.mp3')
    expect(t.lx.mock.calls.map(([track]) => track.id)).toEqual(['song-c', 'bgm', 'song-a'])
  })

  it('keeps same-track provider fallback valid while the catalogue switches to Vocal', async () => {
    const t = await setup(mode)
    let release!: (playable: Playable) => void
    t.gd.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const failure = t.store.reportPlaybackFailure('lx', t.store.playbackGeneration.value)
    await flush()
    expect(t.gd.mock.calls.map(([track]) => track.id)).toEqual(['song-c'])
    t.filters.setMode('vocal')
    release(audio('song-c', 'gd-studio'))
    await failure
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-c')
    expect(t.store.activeProviderId.value).toBe('gd-studio')
    expect(t.store.playbackIntent.value).toBe('playing')
    expect(t.active().getAttribute('src')).toBe('https://media.invalid/gd-studio/song-c.mp3')
    expect(t.lx.mock.calls.map(([track]) => track.id)).toEqual(['song-c'])
    expect(count(t.wrapper)).toBe('0')
  })

  it('rechecks Vocal before a failed-provider automatic skip can wrap into non-vocal history', async () => {
    const t = await setup(mode)
    t.store.setRepeatMode('all')
    t.gd.mockResolvedValue(null)
    const deferred: Array<() => void> = []
    const schedule = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => { deferred.push(callback) })
    try {
      await t.store.reportPlaybackFailure('lx', t.store.playbackGeneration.value)
      expect(deferred.length).toBeGreaterThan(0)
      t.filters.setMode('vocal')
      for (const callback of deferred.splice(0)) callback()
      await flush()
      expect(t.store.currentTrack.value?.id).toBe('song-a')
      expect(t.store.activeProviderId.value).toBe('lx')
      expect(t.store.playbackIntent.value).toBe('playing')
      expect(t.lx.mock.calls.map(([track]) => track.id)).toEqual(['song-c', 'song-a'])
      expect(t.gd.mock.calls.map(([track]) => track.id)).toEqual(['song-c'])
      expect(count(t.wrapper)).toBe('2')
    } finally { schedule.mockRestore() }
  })

  it('hands off only the replacement vocal preparation while hidden and preserves it on return', async () => {
    const t = await setup(mode)
    t.store.setRepeatMode('all')
    await prepare(t)
    const excluded = t.store.preparedNext.value!
    expect(excluded.track.id).toBe('bgm')
    t.filters.setMode('vocal')
    await flush()
    expect(t.store.canHandoffPreparation(excluded.id)).toBe(false)
    const incoming = await prepare(t)
    expect(t.store.preparedNext.value?.track.id).toBe('song-a')
    const outgoing = t.active()
    const plays = t.requests.length
    const generation = t.store.playbackGeneration.value
    await t.setVisibility('hidden')
    naturalEnd(outgoing)
    // The background path must request play within the native ended callback.
    expect(t.store.currentTrack.value?.id).toBe('song-a')
    expect(t.requests.slice(plays)).toEqual([{ element: incoming, src: 'https://media.invalid/lx/song-a.mp3' }])
    await flush()
    expect(t.lx.mock.calls.filter(([track]) => track.id === 'song-a')).toHaveLength(1)
    // A prepared handover needs real position progress as well as native playing.
    incoming.dispatchEvent(new Event('playing'))
    incoming.currentTime = 0.5
    incoming.dispatchEvent(new Event('timeupdate'))
    await flush()
    expect(t.active()).toBe(incoming)
    expect(t.store.playbackGeneration.value).toBe(generation + 1)
    expect(t.wrapper.attributes('data-transition-active')).toBe('false')
    const returnedGeneration = t.store.playbackGeneration.value
    await t.setVisibility('visible')
    expect(t.store.currentTrack.value?.id).toBe('song-a')
    expect(t.store.playbackGeneration.value).toBe(returnedGeneration)
    expect(t.active()).toBe(incoming)
    expect(t.store.status.value).toBe('playing')
    // At 0.5 s / 30 s (< 50%), song-b is not preloaded yet; the adopted song-a is resolved once.
    expect(t.lx.mock.calls.map(([track]) => track.id)).toEqual(['song-c', 'bgm', 'song-a'])
    incoming.currentTime = 15
    incoming.dispatchEvent(new Event('timeupdate'))
    await flush()
    expect(t.lx.mock.calls.map(([track]) => track.id)).toEqual(['song-c', 'bgm', 'song-a', 'song-b'])
    expect(count(t.wrapper)).toBe('2')
  })
})

describe.each(['crossfade', 'smart'] as const)('Vocal %s pending deck handover', mode => {
  it('cancels a filtered incoming play before its late playing event can commit', async () => {
    const t = await setup(mode)
    t.store.setRepeatMode('all')
    const incoming = await prepare(t)
    const excluded = t.store.preparedNext.value!
    expect(excluded.track.id).toBe('bgm')
    let accept!: () => void
    t.play.mockImplementationOnce(function (this: HTMLMediaElement) {
      return new Promise<void>(resolve => { accept = () => {
        Object.defineProperty(this, 'paused', { configurable: true, value: false })
        this.dispatchEvent(new Event('play'))
        this.dispatchEvent(new Event('playing'))
        resolve()
      } })
    })
    t.active().currentTime = 26
    t.active().dispatchEvent(new Event('timeupdate'))
    await flush()
    expect(t.wrapper.attributes('data-transition-active')).toBe('true')
    expect(t.store.currentTrack.value?.id).toBe('song-c')
    t.filters.setMode('vocal')
    await flush()
    expect(t.store.canHandoffPreparation(excluded.id)).toBe(false)
    accept()
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-c')
    expect(t.wrapper.attributes('data-transition-active')).toBe('false')
    expect(incoming.paused).toBe(true)
    expect(incoming.hasAttribute('src')).toBe(false)
    naturalEnd(t.active())
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-a')
  })

  it('ends vocal overlap on backgrounding without reviving filtered outgoing history', async () => {
    const t = await setup(mode)
    t.store.setRepeatMode('all')
    t.filters.setMode('vocal')
    await flush()
    const incoming = await prepare(t)
    const outgoing = t.active()
    outgoing.currentTime = 26
    outgoing.dispatchEvent(new Event('timeupdate'))
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-a')
    expect(t.wrapper.attributes('data-transition-active')).toBe('true')
    await t.setVisibility('hidden')
    expect(t.wrapper.attributes('data-transition-active')).toBe('false')
    expect(outgoing.paused).toBe(true)
    expect(incoming.paused).toBe(false)
    expect(incoming.volume).toBe(t.store.volume.value)
    const plays = t.requests.length
    const generation = t.store.playbackGeneration.value
    await t.setVisibility('visible')
    await vi.advanceTimersByTimeAsync(1600)
    await flush()
    expect(t.store.currentTrack.value?.id).toBe('song-a')
    expect(t.store.playbackGeneration.value).toBe(generation)
    expect(t.active()).toBe(incoming)
    expect(t.requests).toHaveLength(plays)
    expect(count(t.wrapper)).toBe('2')
  })
})
