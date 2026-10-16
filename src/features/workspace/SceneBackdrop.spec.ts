import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createBackgroundStore } from '../backgrounds/store'
import type { PublicBackground } from '../backgrounds/types'
import SceneBackdrop from './SceneBackdrop.vue'
const background = (id: string): PublicBackground => ({
  id, revision: 1, status: 'published', kind: 'video', contentType: 'video/mp4', byteSize: 100, width: 3840, height: 2160, durationMs: 10_000,
  mediaUrl: `/backgrounds/${id}.mp4`, posterUrl: `/backgrounds/${id}.jpg`, rightsStatus: 'not-reviewed', createdAt: 1, updatedAt: 1, publishedAt: 1, archivedAt: null,
})
const stores: ReturnType<typeof createBackgroundStore>[] = []
const wrappers: ReturnType<typeof mount>[] = []
async function setup(ids = ['belle', 'ellen'], props = {}, entries = ids.map(background), quality: 'auto' | 'native' = 'auto') {
  const store = createBackgroundStore({
    repository: { list: async () => entries, getAccountSelection: async () => null, saveAccountSelection: async s => s },
    storage: { getItem: () => JSON.stringify({ selectedIds: ids, autoRotate: true, intervalSeconds: 15 }), setItem: () => undefined },
  })
  stores.push(store)
  store.setQualityMode(quality)
  const wrapper = mount(SceneBackdrop, { props: { mode: 'ambient', lowPower: false, store, ...props } })
  wrappers.push(wrapper); await flushPromises(); return { store, wrapper }
}
describe('SceneBackdrop video background', () => {
  it('keeps the selected poster visible during startup and terminal video failure', async () => {
    const { wrapper, store } = await setup(['belle'])
    expect(wrapper.get('picture img').attributes('src')).toBe('/backgrounds/belle.jpg')
    store.onVideoError(); await flushPromises()
    expect(wrapper.find('video').exists()).toBe(false)
    expect(wrapper.get('picture img').attributes('src')).toBe('/backgrounds/belle.jpg')
    expect(wrapper.get('picture img').attributes('data-background-active')).toBe('true')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(wrapper.get('picture img').attributes('src')).toBe('/backgrounds/belle.jpg')
    expect(store.current.value?.id).toBe('belle')
  })
  it('reveals the poster when a stall leaves no decoded frame and during recovery load', async () => {
    const { wrapper } = await setup(['belle'])
    const video = wrapper.get('video')
    Object.defineProperty(video.element, 'readyState', { value: 4, configurable: true })
    await video.trigger('playing')
    expect(video.classes()).toContain('scene-backdrop__video--active')
    Object.defineProperty(video.element, 'readyState', { value: 0, configurable: true })
    await video.trigger('waiting')
    expect(video.classes()).not.toContain('scene-backdrop__video--active')
    await vi.advanceTimersByTimeAsync(8_000); await flushPromises()
    expect(video.classes()).not.toContain('scene-backdrop__video--active')
    expect(wrapper.get('picture img').attributes('src')).toBe('/backgrounds/belle.jpg')
  })
  it('never promotes an undecoded pending slot or a stale source event', async () => {
    const { wrapper, store } = await setup(); store.setPlaybackMode('sequential')
    const [first, next] = wrapper.findAll('video')
    Object.defineProperty(first.element, 'readyState', { value: 4, configurable: true })
    await first.trigger('playing'); await flushPromises()
    store.nextBackground(); await flushPromises()
    await next.trigger('playing')
    expect(first.classes()).toContain('scene-backdrop__video--active')
    expect(next.classes()).not.toContain('scene-backdrop__video--active')
    Object.defineProperty(next.element, 'readyState', { value: 4, configurable: true })
    Object.defineProperty(next.element, 'currentSrc', { value: '/backgrounds/old.mp4', configurable: true })
    await next.trigger('playing')
    expect(next.classes()).not.toContain('scene-backdrop__video--active')
    expect(first.classes()).toContain('scene-backdrop__video--active')
  })
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  })
  afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); stores.splice(0).forEach(s => s.destroy()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
  it('uses two slots with one autoplaying video and a persistent selected poster', async () => {
    const { wrapper } = await setup()
    expect(wrapper.findAll('video')).toHaveLength(2)
    expect(wrapper.findAll('video[autoplay]')).toHaveLength(1)
    expect(wrapper.get('picture img').attributes('src')).toBe('/backgrounds/belle.jpg')
    expect(wrapper.html()).not.toContain('quiet-study-room')
    const v = wrapper.get('video')
    expect(v.attributes()).toEqual(expect.objectContaining({ autoplay: '', loop: '', playsinline: '' }))
    expect(v.attributes('poster')).toBeUndefined()
    expect((v.element as HTMLVideoElement).muted).toBe(true)
  })
  it('starts only the requested slot when rotation occurs before the first frame', async () => {
    const { wrapper, store } = await setup(); store.setPlaybackMode('sequential')
    const original = wrapper.get('video').element
    await vi.advanceTimersByTimeAsync(15_000); await flushPromises()
    expect(wrapper.findAll('video')).toHaveLength(2)
    expect(wrapper.get('video').element).toBe(original)
    expect(wrapper.get('video').attributes('src')).toBe('/backgrounds/ellen.mp4')
  })
  it('internal loops do not advance selection or restart the rotation timer', async () => {
    const { wrapper, store } = await setup(); store.setPlaybackMode('sequential')
    await vi.advanceTimersByTimeAsync(10_000); await wrapper.get('video').trigger('ended')
    expect(store.current.value?.id).toBe('belle')
    await vi.advanceTimersByTimeAsync(5_000); expect(store.current.value?.id).toBe('ellen')
  })
  it('preloads a paused next slot, crossfades on playing and releases the old decoder', async () => {
    const { wrapper, store } = await setup(); store.setPlaybackMode('sequential')
    const v = wrapper.get('video')
    Object.defineProperty(v.element, 'readyState', { value: 4, configurable: true })
    await v.trigger('playing')
    await flushPromises()
    const next = wrapper.findAll('video')[1]
    expect(next.attributes('src')).toBe('/backgrounds/ellen.mp4')
    expect(next.attributes('autoplay')).toBeUndefined()
    const play = vi.mocked(HTMLMediaElement.prototype.play).mockClear()
    await next.trigger('loadeddata')
    expect(play).not.toHaveBeenCalled()
    expect(v.classes()).toContain('scene-backdrop__video--active')
    store.nextBackground(); await flushPromises()
    expect(v.classes()).toContain('scene-backdrop__video--active')
    expect(v.attributes('src')).toBe('/backgrounds/belle.mp4')
    Object.defineProperty(next.element, 'readyState', { value: 4, configurable: true })
    await next.trigger('playing')
    expect(v.classes()).not.toContain('scene-backdrop__video--active')
    expect(next.classes()).toContain('scene-backdrop__video--active')
    const load = vi.mocked(HTMLMediaElement.prototype.load).mockClear()
    await vi.advanceTimersByTimeAsync(400); await flushPromises()
    expect(load.mock.instances).toContain(v.element)
    expect(v.attributes('autoplay')).toBeUndefined()
    expect(wrapper.findAll('video[autoplay]')).toHaveLength(1)
  })
  it('allows selected posters only in explicit still/low-power/reduced-motion policy', async () => {
    const { wrapper, store } = await setup(['belle'], { lowPower: true })
    expect(wrapper.find('video').exists()).toBe(false)
    expect(wrapper.get('picture img').attributes('src')).toBe('/backgrounds/belle.jpg')
    await wrapper.setProps({ lowPower: false }); store.setPlaybackPolicy({ reducedMotion: true, lowPower: false, saveData: false }); await flushPromises()
    expect(wrapper.find('video').exists()).toBe(false)
  })
  it('restores the native src when the released slot preloads its previous URL again', async () => {
    const {wrapper,store}=await setup();store.setPlaybackMode('sequential')
    const [first,second]=wrapper.findAll('video')
    for(const element of [first,second])Object.defineProperty(element.element,'readyState',{value:4,configurable:true})
    await first.trigger('playing');await flushPromises()
    store.nextBackground();await flushPromises();await second.trigger('playing')
    await vi.advanceTimersByTimeAsync(400);await flushPromises()
    expect(first.attributes('src')).toBe('/backgrounds/belle.mp4')
    expect(first.attributes('autoplay')).toBeUndefined()
  })
  it('restores the native src when switching back to the retiring URL before the fade finishes', async () => {
    const {wrapper,store}=await setup();store.setPlaybackMode('sequential')
    const [first,second]=wrapper.findAll('video')
    for(const element of [first,second])Object.defineProperty(element.element,'readyState',{value:4,configurable:true})
    await first.trigger('playing');await flushPromises()
    store.nextBackground();await flushPromises();await second.trigger('playing')
    store.nextBackground();await flushPromises()
    expect(first.attributes('src')).toBe('/backgrounds/belle.mp4')
    await first.trigger('playing')
    expect(first.classes()).toContain('scene-backdrop__video--active')
  })
  it('retries rejected autoplay on a gesture without repeated loads', async () => {
    const play = vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException('Blocked', 'NotAllowedError'))
    await setup(['belle']); const load = vi.mocked(HTMLMediaElement.prototype.load); const count = load.mock.calls.length
    play.mockResolvedValue(undefined); window.dispatchEvent(new Event('pointerdown')); await flushPromises()
    expect(play.mock.calls.length).toBeGreaterThan(1); expect(load.mock.calls.length).toBe(count)
  })
  it('resolves reduced motion before first render without starting any video', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ backgrounds: [] }))))
    const store = createBackgroundStore({
      repository: { list: async () => [background('synthetic')], getAccountSelection: async () => null, saveAccountSelection: async selection => selection },
      storage: { getItem: () => null, setItem: () => undefined },
    })
    await store.load()
    stores.push(store)
    const wrapper = mount(SceneBackdrop, { props: { mode: 'ambient', lowPower: false, store } })
    wrappers.push(wrapper); await flushPromises()
    expect(wrapper.find('video').exists()).toBe(false)
    expect(wrapper.get('img').attributes('src')).toBe('/backgrounds/synthetic.jpg')
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
    expect(HTMLMediaElement.prototype.load).not.toHaveBeenCalled()
  })
  it('recovers a media play failure without waiting for an unrelated user gesture', async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException('Decode failed', 'NotSupportedError'))
    await setup(['belle'])
    const load = vi.mocked(HTMLMediaElement.prototype.load); const initial = load.mock.calls.length
    await vi.advanceTimersByTimeAsync(8_000)
    expect(load.mock.calls.length).toBe(initial + 1)
  })
  it('recovers a Belle readyState=2 stall once after grace, cancelling recovery after progress', async () => {
    const { wrapper } = await setup(['belle']); const v = wrapper.get('video')
    Object.defineProperty(v.element, 'readyState', { configurable: true, value: 2 })
    const load = vi.mocked(HTMLMediaElement.prototype.load); const initial = load.mock.calls.length
    await v.trigger('waiting'); await vi.advanceTimersByTimeAsync(8_000)
    expect(load.mock.calls.length).toBe(initial + 1)
    await v.trigger('waiting'); (v.element as HTMLVideoElement).currentTime = 1
    await v.trigger('timeupdate'); await vi.advanceTimersByTimeAsync(8_000)
    expect(load.mock.calls.length).toBe(initial + 1)
  })
  it('pauses only scene media when hidden', async () => {
    const { wrapper } = await setup(['belle']); const pause = vi.mocked(HTMLMediaElement.prototype.pause).mockClear()
    const music = document.createElement('audio'); document.body.append(music)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange'))
    expect(pause.mock.instances).toEqual(wrapper.findAll('video').map(v => v.element)); music.remove()
  })
  it('uses the lower-cost Belle derivative only after a genuine native stall', async () => {
    const entry = { ...background('belle'), playbackFallback: { mediaUrl: '/backgrounds/belle-smooth.mp4', width: 2560, height: 1440, fps: 30, byteSize: 100 } }
    const { wrapper } = await setup(['belle'], {}, [entry], 'native')
    const original = wrapper.get('video').element
    expect(wrapper.get('video').attributes('src')).toBe(entry.mediaUrl)
    await vi.advanceTimersByTimeAsync(8_000); await flushPromises()
    expect(wrapper.get('video').attributes('src')).toBe(entry.playbackFallback.mediaUrl)
    expect(wrapper.findAll('video')).toHaveLength(2)
    expect(wrapper.get('video').element).toBe(original)
    expect(wrapper.get('picture img').attributes('src')).toBe('/backgrounds/belle.jpg')
  })
  it('starts Auto directly with Belle smooth playback while retaining its native master', async () => {
    const entry = { ...background('belle'), playbackFallback: { mediaUrl: '/backgrounds/belle-smooth.mp4', width: 2560, height: 1440, fps: 30, byteSize: 100 } }
    const { wrapper } = await setup(['belle'], {}, [entry])
    expect(wrapper.get('video').attributes('src')).toBe(entry.playbackFallback.mediaUrl)
    expect(entry.mediaUrl).toBe('/backgrounds/belle.mp4')
    expect(wrapper.findAll('video')).toHaveLength(2)
  })
  it('adapts Belle after sustained dropped frames, ignoring one bad observation', async () => {
    const entry = { ...background('belle'), playbackFallback: { mediaUrl: '/backgrounds/belle-smooth.mp4', width: 2560, height: 1440, fps: 30, byteSize: 100 } }
    const { wrapper } = await setup(['belle'], {}, [entry], 'native')
    const video = wrapper.get('video').element as HTMLVideoElement
    Object.defineProperty(video, 'readyState', { value: 4, configurable: true })
    let at = 0, frames = 0, dropped = 0
    vi.spyOn(performance, 'now').mockImplementation(() => at)
    Object.defineProperty(video, 'getVideoPlaybackQuality', { value: () => ({ totalVideoFrames: frames, droppedVideoFrames: dropped }) })
    await wrapper.get('video').trigger('timeupdate')
    at = 6_000; frames = 300; dropped = 90; video.currentTime = 6
    await wrapper.get('video').trigger('timeupdate')
    expect(wrapper.get('video').attributes('src')).toBe(entry.mediaUrl)
    at = 12_000; frames = 600; dropped = 180; video.currentTime = 12
    await wrapper.get('video').trigger('timeupdate'); await flushPromises()
    expect(wrapper.findAll('video').some(v => v.attributes('src') === entry.playbackFallback.mediaUrl)).toBe(true)
  })
  it('keeps CSS geometry fixed without transform, drift, or geometry transitions', () => {
    const css = readFileSync('src/features/workspace/SceneBackdrop.vue', 'utf8').split('<style scoped>')[1]
    expect(css).toContain('position: fixed'); expect(css).toContain('object-fit: cover')
    expect(css).not.toMatch(/transform:|animation:|@keyframes/)
    expect([...css.matchAll(/transition:\s*([^;]+)/g)].map(m => m[1])).toEqual(['opacity var(--background-crossfade-duration) ease', 'none', 'none'])
  })
  it('switches both the active and paused-next sources to the 1440p companions', async () => {
    const entries = ['belle', 'ellen'].map(id => ({ ...background(id),
      width: 1920, height: 1080,
      highQualityVersion: { mediaUrl: `/backgrounds/${id}-high.mp4`, width: 2560, height: 1440, fps: 30, byteSize: 200 },
    }))
    const { wrapper, store } = await setup(['belle', 'ellen'], {}, entries)
    store.setPlaybackMode('sequential')
    store.setQualityMode('1440p')
    await flushPromises()
    const active = wrapper.find('[data-background-active="true"]')
    Object.defineProperty(active.element, 'readyState', { configurable: true, value: 4 })
    await active.trigger('playing'); await flushPromises()
    expect(active.attributes('src')).toBe('/backgrounds/belle-high.mp4')
    expect(wrapper.find('[data-background-active="false"]').attributes('src')).toBe('/backgrounds/ellen-high.mp4')
    expect(wrapper.find('[data-background-active="false"]').attributes('autoplay')).toBeUndefined()
  })
  it('falls back from a stalled 1440p companion to 1080p without changing the saved choice', async () => {
    const entry = { ...background('belle'), width: 1920, height: 1080,
      highQualityVersion: { mediaUrl: '/backgrounds/belle-high.mp4', width: 2560, height: 1440, fps: 30, byteSize: 200 },
    }
    const { wrapper, store } = await setup(['belle'], {}, [entry])
    store.setQualityMode('1440p'); await flushPromises()
    expect(wrapper.get('video').attributes('src')).toBe('/backgrounds/belle-high.mp4')
    await vi.advanceTimersByTimeAsync(8_000); await flushPromises()
    expect(wrapper.get('video').attributes('src')).toBe(entry.mediaUrl)
    expect(store.qualityMode.value).toBe('1440p')
  })
  it('falls back from sustained 1440p frame drops but ignores one bad window', async () => {
    const entry = { ...background('belle'), width: 1920, height: 1080,
      highQualityVersion: { mediaUrl: '/backgrounds/belle-high.mp4', width: 2560, height: 1440, fps: 30, byteSize: 200 },
    }
    const { wrapper, store } = await setup(['belle'], {}, [entry])
    store.setQualityMode('1440p'); await flushPromises()
    const video = wrapper.get('video')
    Object.defineProperty(video.element, 'readyState', { value: 4, configurable: true })
    let at = 0, total = 0, dropped = 0
    vi.spyOn(performance, 'now').mockImplementation(() => at)
    Object.defineProperty(video.element, 'getVideoPlaybackQuality', { value: () => ({ totalVideoFrames: total, droppedVideoFrames: dropped }) })
    await video.trigger('timeupdate')
    at = 6_000; total = 180; dropped = 40; (video.element as HTMLVideoElement).currentTime = 6
    await video.trigger('timeupdate')
    expect(video.attributes('src')).toBe(entry.highQualityVersion.mediaUrl)
    at = 12_000; total = 360; dropped = 80; (video.element as HTMLVideoElement).currentTime = 12
    await video.trigger('timeupdate'); await flushPromises()
    const lower = wrapper.findAll('video').find(v => v.attributes('src') === entry.mediaUrl)!
    expect(lower).toBeDefined()
    Object.defineProperty(lower.element, 'readyState', { value: 4, configurable: true })
    await lower.trigger('playing'); await flushPromises()
    expect(wrapper.get('[data-background-active="true"]').attributes('src')).toBe(entry.mediaUrl)
    expect(store.qualityMode.value).toBe('1440p')
  })
  it('keeps still policy when the 1440p preference is enabled', async () => {
    const { wrapper, store } = await setup(['belle'], { mode: 'still' })
    store.setQualityMode('1440p'); await flushPromises()
    expect(wrapper.findAll('video')).toHaveLength(0)
    expect(wrapper.get('img').attributes('src')).toBe('/backgrounds/belle.jpg')
  })
})
