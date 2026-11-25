import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PlayerBar from './PlayerBar.vue'
import { createPlaybackStore, type PlaybackStore } from './store'
import { createRuntimeProviderRepository } from './runtimeConfig'
import { playbackLog } from './playbackLog'
import type { Track } from '../catalog/types'

const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0) }
const storage = { getItem: (k: string) => k.includes('shuffle') ? 'false' : null, setItem() {} }
let wrapper: VueWrapper | undefined, store: PlaybackStore | undefined
const track = (id: string, external: string) => ({ id, title: id, aliases: {}, games: ['genshin'], tabs: ['focus'],
  sources: [{ provider: 'gd-studio', externalId: 'netease:' + external + ':320' }], relationIds: [], workGroupId: 'fixture',
  vocalStatus: 'instrumental', needsClassification: false }) as Track
const ready = (e: HTMLAudioElement, time: number, paused: boolean) => {
  Object.defineProperties(e, { readyState: { configurable: true, value: 4 }, duration: { configurable: true, value: 100 },
    paused: { configurable: true, value: paused }, ended: { configurable: true, value: false },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 100 } },
    seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 100 } } })
  e.currentTime = time
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-15T12:03:48Z'))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 17) AppleWebKit/537.36 Chrome/157.0.0.0 Mobile Safari/537.36')
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function(this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true })
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function(this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false }); this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  playbackLog.clear()
})
afterEach(() => { wrapper?.unmount(); store?.dispose(); wrapper = undefined; store = undefined; vi.restoreAllMocks(); vi.useRealTimers() })
describe('reported AOD failure chain across configuration, real provider, store and decks', () => {
  it('renews code4 on the same track despite a failed forced registry refresh, then continues to the next track', async () => {
    const configUrl = new URL('/api/providers/config', location.origin).href
    let configCalls = 0
    const resolves: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
      if (url.pathname === '/api/providers/config') {
        if (++configCalls === 2) throw new TypeError('Failed to fetch')
        const response = Response.json({ version: 1, providers: [{ id: 'gd-studio', available: true, enabled: true,
          automaticEligible: true, priority: 1 }] })
        Object.defineProperty(response, 'url', { value: configUrl }); return response
      }
      if (url.pathname === '/api/providers/gd-studio/resolve') {
        const external = ['1001','1002','1002','1003'][resolves.length] ?? '1003'
        resolves.push(external)
        const response = Response.json({ mimeType: 'audio/mpeg', url: '/api/providers/gd-studio/media/netease%3A' +
          external + '%3A320/' + String(resolves.length).repeat(32) })
        Object.defineProperty(response, 'url', { value: url.href }); return response
      }
      return new Response(null, { status: 404 })
    })
    const repository = createRuntimeProviderRepository({ providerPreferences: { isDisabled: () => false, revision: () => 0 } })
    store = createPlaybackStore({ loadRegistry: repository.loadPlayback, peekRegistry: repository.peekPlayback, storage })
    store.reconcileUpcomingQueue([track('previous','1001'), track('genshin-caprice-of-the-leaves','1002'), track('zzz-dew-gardening','1003')])
    wrapper = mount(PlayerBar, { props: { store } })
    await store.playQueueIndex(0); await flush()
    let active = wrapper.get<HTMLAudioElement>('audio[data-audio-role="active"]').element
    ready(active, 50, false); active.dispatchEvent(new Event('playing')); active.dispatchEvent(new Event('timeupdate')); await flush()
    await store.armNextPreparation(); await flush()
    const standby = wrapper.get<HTMLAudioElement>('audio[data-audio-role="standby"]').element
    ready(standby, 0, true); standby.dispatchEvent(new Event('canplay')); await flush()
    active.currentTime = 100
    Object.defineProperty(active, 'ended', { configurable: true, value: true })
    Object.defineProperty(active, 'paused', { configurable: true, value: true })
    active.dispatchEvent(new Event('ended')); await flush()
    expect(store.currentTrack.value?.id).toBe('genshin-caprice-of-the-leaves')
    active = wrapper.get<HTMLAudioElement>('audio[data-audio-role="active"]').element
    Object.defineProperty(active, 'readyState', { configurable: true, value: 0 })
    Object.defineProperty(active, 'error', { configurable: true, value: { code: 4 } })
    active.dispatchEvent(new Event('error')); await flush()
    expect(store.currentTrack.value?.id).toBe('genshin-caprice-of-the-leaves')
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.playable.value?.kind).toBe('audio')
    expect(resolves).toEqual(['1001','1002','1002'])
    expect(playbackLog.snapshot().some(e => e.type === 'provider.config.stale')).toBe(true)
    expect(playbackLog.snapshot().some(e => e.type === 'advance.unavailableSkip')).toBe(false)
    active = wrapper.get<HTMLAudioElement>('audio[data-audio-role="active"]').element
    ready(active, .5, false); active.dispatchEvent(new Event('playing')); active.dispatchEvent(new Event('timeupdate')); await flush()
    await store.advanceAfterEnded(); await flush()
    expect(store.currentTrack.value?.id).toBe('zzz-dew-gardening')
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.playbackIntent.value).toBe('playing')
  })
})
