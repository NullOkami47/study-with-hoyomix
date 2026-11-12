import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import PlayerBar from './PlayerBar.vue'
import { createPlaybackStore } from './store'
import { ProviderRegistry } from './providers/registry'
import type { Track } from '../catalog/types'

const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await nextTick()
}
const ready = (element: HTMLAudioElement) => Object.defineProperties(element, {
  duration: { configurable: true, value: 30 },
  readyState: { configurable: true, value: 4 },
  buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 30 } },
  seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 30 } },
})
const originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers()
  if (originalTouchPoints) Object.defineProperty(navigator, 'maxTouchPoints', originalTouchPoints)
  else Reflect.deleteProperty(navigator, 'maxTouchPoints')
})
async function setup(mode: 'crossfade' | 'smart') {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  const resolve = vi.fn(async (track: Track) => ({
    kind: 'audio' as const, url: 'https://media.invalid/' + track.id + '.mp3', mimeType: 'audio/mpeg',
  }))
  const registry = new ProviderRegistry([
    { provider: { id: 'lx', resolve }, enabled: true, priority: 1, timeoutMs: 1000 },
  ])
  const loadRegistry = vi.fn(async () => registry)
  const store = createPlaybackStore({ registry, loadRegistry, peekRegistry: () => registry, storage: {
    getItem: key => key.includes('shuffle') ? 'false' : null, setItem: () => {},
  } })
  store.setTransitionMode(mode)
  store.reconcileUpcomingQueue(['a', 'b', 'c'].map(id => ({
    id, title: id, aliases: {}, games: [], tabs: [], sources: [{ provider: 'lx', externalId: id }],
    relationIds: [], workGroupId: 'g', vocalStatus: 'instrumental', needsClassification: false,
  } as Track)))
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const plays: Array<{ element: HTMLMediaElement; volume: number }> = []
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    plays.push({ element: this, volume: this.volume })
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
  await store.playQueueIndex(0)
  await flush()
  const active = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
  ready(active)
  active.currentTime = 10
  active.dispatchEvent(new Event('timeupdate'))
  await flush()
  const standby = wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element
  ready(standby)
  standby.dispatchEvent(new Event('progress'))
  await flush()
  return { store, wrapper, active, standby, resolve, plays, visibility, registry, loadRegistry, close: () => { wrapper.unmount(); store.dispose() } }
}

describe.each(['crossfade', 'smart'] as const)('%s with native background handoff', mode => {
  it.each(['background', 'off'] as const)('cancels only the pending overlap adoption on %s during registry validation', async action => {
    const t = await setup(mode)
    try {
      const generation = t.store.playbackGeneration.value
      let finish!: (registry: ProviderRegistry) => void
      // The lead-window reuse check runs first; suspend the subsequent overlap adoption.
      t.loadRegistry.mockResolvedValueOnce(t.registry)
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      t.active.currentTime = 26
      t.active.dispatchEvent(new Event('timeupdate'))
      await flush()
      expect(t.wrapper.attributes('data-transition-active')).toBe('true')
      expect(t.store.currentTrack.value?.id).toBe('a')
      if (action === 'background') {
        t.visibility.mockReturnValue('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
      } else t.store.setTransitionMode('off')
      await flush()
      expect(t.standby.paused).toBe(true)
      finish(t.registry)
      await flush()
      expect(t.store.currentTrack.value?.id).toBe('a')
      expect(t.store.playbackGeneration.value).toBe(generation)
      expect(t.wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element).toBe(t.active)
      expect(t.active.paused).toBe(false)
      expect(t.store.playbackIntent.value).toBe('playing')
      expect(t.resolve).toHaveBeenCalledTimes(2)
      // Normal ended handoff remains available after the cancelled early transition.
      Object.defineProperty(t.active, 'ended', { configurable: true, value: true })
      t.active.dispatchEvent(new Event('ended'))
      await flush()
      expect(t.store.currentTrack.value?.id).toBe('b')
      expect(t.wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element).toBe(action === 'background' ? t.active : t.standby)
      expect(t.resolve.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(1)
    } finally { t.close() }
  })

  it('does not let a cancelled overlap overwrite a newer manual target', async () => {
    const t = await setup(mode)
    try {
      let finish!: (registry: ProviderRegistry) => void
      // The lead-window reuse check runs first; suspend the subsequent overlap adoption.
      t.loadRegistry.mockResolvedValueOnce(t.registry)
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      t.active.currentTime = 26
      t.active.dispatchEvent(new Event('timeupdate'))
      await flush()
      t.store.setTransitionMode('off')
      await flush()
      await t.store.playQueueIndex(2)
      const generation = t.store.playbackGeneration.value
      const playable = t.store.playable.value
      finish(t.registry)
      await flush()
      expect(t.store.currentTrack.value?.id).toBe('c')
      expect(t.store.playbackGeneration.value).toBe(generation)
      expect(t.store.playable.value).toBe(playable)
      expect(t.store.playbackIntent.value).toBe('playing')
    } finally { t.close() }
  })

  it('keeps preroll from rewinding or silencing a committing foreground overlap', async () => {
    const t = await setup(mode)
    try {
      t.active.currentTime = 29
      t.active.dispatchEvent(new Event('timeupdate'))
      await flush()
      expect(t.store.currentTrack.value?.id).toBe('b')
      expect(t.wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element).toBe(t.standby)
      expect(t.wrapper.attributes('data-transition-active')).toBe('true')
      expect(t.plays.filter(p => p.element === t.standby)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(250)
      expect(t.standby.volume).toBeGreaterThan(0)
      expect(t.active.volume).toBeGreaterThan(0)
      expect(t.standby.paused).toBe(false)
      expect(t.resolve).toHaveBeenCalledTimes(2)
    } finally { t.close() }
  })

  it('declines all zero-volume play on Apple WebKit while retaining the ready foreground handoff', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 Version/27.2 Safari/605.1.15')
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 })
    const t = await setup(mode)
    try {
      t.active.currentTime = 26
      t.active.dispatchEvent(new Event('timeupdate'))
      await flush()
      t.active.currentTime = 29
      t.active.dispatchEvent(new Event('timeupdate'))
      await flush()
      expect(t.store.currentTrack.value?.id).toBe('a')
      expect(t.plays.filter(p => p.element === t.standby)).toHaveLength(0)
      expect(t.store.preparedNext.value?.track.id).toBe('b')
      Object.defineProperty(t.active, 'ended', { configurable: true, value: true })
      t.active.dispatchEvent(new Event('ended'))
      await flush()
      expect(t.wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element).toBe(t.standby)
      expect(t.plays.some(p => p.volume === 0)).toBe(false)
      expect(t.resolve.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(1)
    } finally { t.close() }
  })

  it('uses the stable active element synchronously when hidden with transition mode enabled', async () => {
    const t = await setup(mode)
    try {
      t.visibility.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      t.active.currentTime = 29
      t.active.dispatchEvent(new Event('timeupdate'))
      await flush()
      expect(t.plays.filter(p => p.element === t.standby)).toHaveLength(0)
      const count = t.plays.length
      Object.defineProperty(t.active, 'ended', { configurable: true, value: true })
      t.active.dispatchEvent(new Event('ended'))
      expect(t.store.currentTrack.value?.id).toBe('b')
      expect(t.plays.length).toBe(count + 1)
      expect(t.plays.at(-1)?.element).toBe(t.active)
      await flush()
      expect(t.wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element).toBe(t.active)
      expect(t.resolve).toHaveBeenCalledTimes(2)
    } finally { t.close() }
  })
})
