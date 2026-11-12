import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { Track } from '../catalog/types'
import type { Playable } from './providers/types'
import { ProviderRegistry } from './providers/registry'
import { createPlaybackStore, type PlaybackStore } from './store'
import { playbackCommands } from './commands'
import PlayerBar from './PlayerBar.vue'

const wrappers: VueWrapper[] = []
const stores: PlaybackStore[] = []
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); await nextTick() }
const media = (id: string): Playable => ({ kind: 'audio', url: 'https://media.invalid/' + id + '.mp3', mimeType: 'audio/mpeg' })
const ready = (element: HTMLAudioElement) => Object.defineProperties(element, {
  duration: { configurable: true, value: 240 },
  readyState: { configurable: true, value: HTMLMediaElement.HAVE_FUTURE_DATA },
  buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } },
  seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } },
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  for (const store of stores.splice(0)) store.dispose()
  vi.restoreAllMocks(); vi.useRealTimers()
})
async function setup() {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  let bCalls = 0
  let finish!: (playable: Playable | null) => void
  const vkeys = vi.fn(async (track: Track): Promise<Playable | null> => {
    if (track.id === 'b') {
      bCalls++
      if (bCalls === 2) return new Promise(resolve => { finish = resolve })
      return media('b-' + bCalls)
    }
    return media(track.id)
  })
  const gd = vi.fn(async (track: Track): Promise<Playable> => media('gd-' + track.id))
  const registry = new ProviderRegistry([
    { provider: { id: 'vkeys', resolve: vkeys }, enabled: true, priority: 1, timeoutMs: 1000 },
    { provider: { id: 'gd-studio', resolve: gd }, enabled: true, priority: 2, timeoutMs: 1000 },
  ])
  const store = createPlaybackStore({ registry, storage: {
    getItem: key => key.includes('shuffle') ? 'false' : null, setItem: () => {},
  } })
  stores.push(store)
  const tracks = ['a', 'b', 'c'].map(id => ({ id, title: id, games: [], aliases: {}, relationIds: [], tabs: [],
    workGroupId: 'test', vocalStatus: 'instrumental', needsClassification: false, sources: [
    { provider: 'vkeys', externalId: id }, { provider: 'gd-studio', externalId: id },
  ] } as Track))
  store.reconcileUpcomingQueue(tracks)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    if (this.paused) return
    Object.defineProperty(this, 'paused', { configurable: true, value: true })
    this.dispatchEvent(new Event('pause'))
  })
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    if (this.getAttribute('src')?.endsWith('/b-1.mp3')) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true })
      // No error event precedes this rejection: the rejection must initiate renewal itself.
      return Promise.reject(new DOMException('expired prepared URL', 'NotSupportedError'))
    }
    Object.defineProperties(this, { paused: { configurable: true, value: false }, ended: { configurable: true, value: false } })
    this.dispatchEvent(new Event('play'))
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  })
  const wrapper = mount(PlayerBar, { props: { store } })
  wrappers.push(wrapper)
  await store.playQueueIndex(0); await flush()
  const first = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
  ready(first)
  first.currentTime = 225; first.dispatchEvent(new Event('timeupdate')); await flush()
  const standby = wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element
  ready(standby)
  expect(store.preparedNext.value?.track.id).toBe('b')
  const generation = store.playbackGeneration.value
  first.currentTime = 240
  Object.defineProperty(first, 'ended', { configurable: true, value: true })
  first.dispatchEvent(new Event('ended')); await flush()
  return { store, wrapper, first, standby, vkeys, gd, play, generation, finish: (value: Playable | null) => finish(value) }
}

describe('promoted-deck rejection before any media error', () => {
  it('renews the same provider once and retains awaitingStart until real progress', async () => {
    const t = await setup()
    expect(t.vkeys.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(2)
    expect(t.gd).not.toHaveBeenCalled()
    expect(t.store.currentTrack.value?.id).toBe('b')
    expect(t.store.awaitingStart.value?.generation).toBe(t.generation + 1)
    // A later duplicate error shares the rejection-owned renewal.
    Object.defineProperty(t.standby, 'error', { configurable: true, value: { code: 4 } })
    t.standby.dispatchEvent(new Event('error')); await flush()
    expect(t.vkeys.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(2)
    t.finish(media('b-renewed')); await flush()
    const renewed = t.wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
    expect(renewed.getAttribute('src')).toContain('/b-renewed.mp3')
    expect(t.store.activeProviderId.value).toBe('vkeys')
    expect(t.store.awaitingStart.value?.generation).toBe(t.store.playbackGeneration.value)
    expect(t.store.status.value).toBe('ready')
    ready(renewed); renewed.currentTime = 0.5; renewed.dispatchEvent(new Event('timeupdate')); await flush()
    expect(t.store.awaitingStart.value).toBeUndefined()
    expect(t.store.status.value).toBe('playing')
    expect(t.gd).not.toHaveBeenCalled()
  })

  it('falls back only after the single same-provider renewal fails, preserving track and position', async () => {
    const t = await setup()
    expect(t.vkeys.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(2)
    expect(t.gd).not.toHaveBeenCalled()
    t.finish(null); await flush()
    expect(t.gd).toHaveBeenCalledTimes(1)
    expect(t.store.activeProviderId.value).toBe('gd-studio')
    expect(t.store.currentTrack.value?.id).toBe('b')
    expect(t.store.playbackIntent.value).toBe('playing')
    expect(t.store.pendingResumePosition.value ?? 0).toBe(0)
    expect(t.vkeys.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(2)
  })

  it.each(['pause', 'pause-resume', 'next', 'stop'] as const)('cannot publish a late promoted renewal after %s', async action => {
    const t = await setup()
    expect(t.vkeys.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(2)
    if (action === 'next') { playbackCommands.next?.(); await flush() }
    else if (action === 'stop') playbackCommands.stop()
    else {
      playbackCommands.pause()
      if (action === 'pause-resume') {
        // This case isolates a cancelled renewal; a newly rejected Play has its own recovery test.
        t.play.mockResolvedValueOnce(undefined)
        playbackCommands.play(); await flush()
      }
    }
    const generation = t.store.playbackGeneration.value
    const selected = t.store.playable.value
    const plays = t.play.mock.calls.length
    t.finish(media('late-renewal')); await flush()
    expect(t.store.playbackGeneration.value).toBe(generation)
    expect(t.store.playable.value).toBe(selected)
    expect(t.store.currentTrack.value?.id).toBe(action === 'next' ? 'c' : action === 'stop' ? undefined : 'b')
    expect(t.play.mock.calls.length).toBe(plays)
    expect(t.gd).not.toHaveBeenCalled()
  })
})
