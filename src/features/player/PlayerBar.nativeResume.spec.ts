import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import CompactPlayback from './CompactPlayback.vue'
import { createPlaybackStore, type PlaybackStore } from './store'
import { ProviderRegistry } from './providers/registry'
import { playbackCommands } from './commands'
import { playbackPresentationFor } from './presentation'

// Native ordering is controlled here; real decoding and WebKit's missing
// playing/pending-play-promise sequence are covered by the browser evidence.
let wrapper: VueWrapper | undefined
let store: PlaybackStore
let settlePlay: 'pending' | 'resolved' = 'pending'
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); await nextTick() }
const active = () => wrapper!.get<HTMLAudioElement>('audio[data-audio-role="active"]').element
const set = (audio: HTMLAudioElement, values: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(audio, key, { configurable: true, value })
}
const track: Track = { id: 'resume', title: 'Resume', aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'resume', vocalStatus: 'instrumental', needsClassification: false, sources: [{ provider: 'lx', externalId: 'wy:resume:320k' }] }
async function setup() {
  const resolve = vi.fn(async () => ({ kind: 'audio' as const, url: 'https://media.invalid/resume.mp3', mimeType: 'audio/mpeg' }))
  store = createPlaybackStore({ registry: new ProviderRegistry([{ provider: { id: 'lx', canResolve: () => true, resolve }, enabled: true, priority: 1, timeoutMs: 1000 }]), storage: { getItem: key => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem() {} } })
  const open = ref(true)
  wrapper = mount(defineComponent({ setup: () => () => h('div', [h(PlayerBar, { store }), open.value ? h(CompactPlayback, { store }) : null]) }), { attachTo: document.body })
  store.enqueue(track)
  await store.playQueueIndex(0); await flush()
  const audio = active()
  set(audio, { paused: false, ended: false, seeking: false, duration: 180, readyState: 4, networkState: 1, seekable: { length: 1, start: () => 0, end: () => 180 }, buffered: { length: 1, start: () => 0, end: () => 180 } })
  audio.currentTime = 1
  audio.dispatchEvent(new Event('loadedmetadata'))
  audio.dispatchEvent(new Event('playing'))
  audio.dispatchEvent(new Event('timeupdate')); await flush()
  expect(store.status.value).toBe('playing')
  return { audio, resolve, open }
}
async function pauseSeekReopen(audio: HTMLAudioElement, open: ReturnType<typeof ref<boolean>>, time = 65) {
  await wrapper!.get('[data-compact-play]').trigger('click')
  expect(audio.paused).toBe(true)
  playbackCommands.seek?.(time)
  set(audio, { seeking: true }); audio.dispatchEvent(new Event('seeking'))
  audio.dispatchEvent(new Event('timeupdate'))
  set(audio, { seeking: false, readyState: 2, networkState: 2 }); audio.dispatchEvent(new Event('seeked'))
  open.value = false; await nextTick(); open.value = true; await flush()
  expect(active()).toBe(audio)
  expect(audio.currentTime).toBe(time)
  expect(wrapper!.get('[data-compact-play]').attributes('aria-label')).toBe('Play')
}
const progress = async (audio: HTMLAudioElement, time: number) => { audio.currentTime = time; audio.dispatchEvent(new Event('timeupdate')); await flush() }

beforeEach(() => {
  vi.useFakeTimers(); settlePlay = 'pending'
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false })
    this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('waiting'))
    return settlePlay === 'resolved' ? Promise.resolve() : new Promise<void>(() => {})
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true }); this.dispatchEvent(new Event('pause'))
  })
})
afterEach(() => { wrapper?.unmount(); store?.dispose(); wrapper = undefined; vi.restoreAllMocks(); vi.useRealTimers() })

describe('native resume state reconciliation', () => {
  it.each(['pending', 'resolved'] as const)('observes native progress after reopen without playing or a %s play promise changing the UI', async result => {
    const { audio, resolve, open } = await setup()
    await pauseSeekReopen(audio, open)
    const loads = vi.mocked(HTMLMediaElement.prototype.load).mock.calls.length
    const source = audio.getAttribute('src')
    settlePlay = result
    await wrapper!.get('[data-compact-play]').trigger('click'); await flush()
    const calls = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
    expect(audio.paused).toBe(false)
    expect(store.status.value).toBe('paused')
    await progress(audio, 65.25)
    expect(store.status.value).toBe('paused')
    await progress(audio, 65.5)
    expect(store.status.value).toBe('playing')
    expect(wrapper!.get('[data-compact-play]').attributes('aria-label')).toBe('Pause')
    expect(wrapper!.get('[data-player-play]').attributes('aria-label')).toBe('Pause')
    expect(active()).toBe(audio); expect(audio.getAttribute('src')).toBe(source)
    expect(audio.currentTime).toBe(65.5)
    expect(vi.mocked(HTMLMediaElement.prototype.play)).toHaveBeenCalledTimes(calls)
    expect(vi.mocked(HTMLMediaElement.prototype.load)).toHaveBeenCalledTimes(loads)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('does not infer playback from paused seek events or from play alone', async () => {
    const { audio, open } = await setup(); await pauseSeekReopen(audio, open)
    await progress(audio, 65)
    expect(store.status.value).toBe('paused')
    await wrapper!.get('[data-compact-play]').trigger('click')
    await progress(audio, 65)
    expect(store.status.value).toBe('paused')
    set(audio, { seeking: true }); await progress(audio, 70)
    expect(store.status.value).toBe('paused')
    set(audio, { seeking: false }); audio.dispatchEvent(new Event('seeked')); await progress(audio, 70)
    expect(store.status.value).toBe('paused')
    await progress(audio, 70.25)
    expect(store.status.value).toBe('playing')
  })

  it('honours a real native pause while play remains pending and never restarts it', async () => {
    const { audio, open } = await setup(); await pauseSeekReopen(audio, open)
    await wrapper!.get('[data-compact-play]').trigger('click'); await progress(audio, 65.25); await progress(audio, 65.5)
    audio.pause(); await flush()
    const calls = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
    await progress(audio, 65.75); await vi.advanceTimersByTimeAsync(30_000)
    expect(audio.paused).toBe(true); expect(store.status.value).toBe('paused')
    expect(wrapper!.get('[data-compact-play]').attributes('aria-label')).toBe('Play')
    expect(vi.mocked(HTMLMediaElement.prototype.play)).toHaveBeenCalledTimes(calls)
  })

  it('keeps repeated rapid pause-seek-reopen-play on one native element without duplicate requests', async () => {
    const { audio, resolve, open } = await setup()
    const subscriptions = vi.spyOn(audio, 'addEventListener')
    const calls = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
    for (const time of [65, 20, 85]) {
      await pauseSeekReopen(audio, open, time)
      await wrapper!.get('[data-compact-play]').trigger('click')
      await progress(audio, time + 0.25)
      await progress(audio, time + 0.5)
      expect(store.status.value).toBe('playing')
      expect(active()).toBe(audio)
    }
    expect(vi.mocked(HTMLMediaElement.prototype.play)).toHaveBeenCalledTimes(calls + 3)
    expect(subscriptions).not.toHaveBeenCalled(); expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('does not accept progress after a newer Pause or Stop command', async () => {
    const { audio, open } = await setup(); await pauseSeekReopen(audio, open)
    await wrapper!.get('[data-compact-play]').trigger('click')
    playbackCommands.pause(); await progress(audio, 65.25)
    expect(store.playbackIntent.value).toBe('paused'); expect(store.status.value).toBe('paused')
    playbackCommands.stop(); await progress(audio, 65.5)
    expect(store.status.value).toBe('idle'); expect(store.playable.value).toBeNull()
  })

  it('ignores a queued old pause after the current Play has resumed native progress', async () => {
    const { audio, open } = await setup(); await pauseSeekReopen(audio, open)
    await wrapper!.get('[data-compact-play]').trigger('click'); await progress(audio, 65.25); await progress(audio, 65.5)
    audio.dispatchEvent(new Event('pause')); await flush()
    expect(audio.paused).toBe(false); expect(store.status.value).toBe('playing')
    expect(wrapper!.get('[data-compact-play]').attributes('aria-label')).toBe('Pause')
  })

  it('ignores an older resume rejection after a newer Pause and Play have succeeded', async () => {
    const { audio, open } = await setup(); await pauseSeekReopen(audio, open)
    let reject!: (reason: unknown) => void
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: false })
      this.dispatchEvent(new Event('play'))
      return new Promise<void>((_resolve, fail) => { reject = fail })
    })
    await wrapper!.get('[data-compact-play]').trigger('click')
    await progress(audio, 65.25); await progress(audio, 65.5)
    playbackCommands.pause(); playbackCommands.play(); await flush()
    await progress(audio, 65.75); await progress(audio, 66)
    reject(new DOMException('obsolete resume', 'NotAllowedError')); await flush()
    expect(store.status.value).toBe('playing'); expect(audio.paused).toBe(false)
    expect(store.playbackNotices.value.some(notice => notice.kind === 'tapToResume')).toBe(false)
  })

  it('does not turn an error or a seek jump into resumed playback', async () => {
    const { audio, open } = await setup(); await pauseSeekReopen(audio, open)
    await wrapper!.get('[data-compact-play]').trigger('click')
    await progress(audio, 65.25); await progress(audio, 100)
    expect(store.status.value).toBe('paused')
    set(audio, { error: { code: 2 } }); await progress(audio, 100.25); await progress(audio, 100.5)
    expect(store.status.value).toBe('paused')
    set(audio, { error: null }); await progress(audio, 100.75)
    expect(store.status.value).toBe('paused')
    await progress(audio, 101)
    expect(store.status.value).toBe('playing')
  })
it.each(['NotAllowedError', 'NotSupportedError'] as const)(
    'ignores an older automatic retry rejection after a newer retry makes native progress (%s)',
    async errorName => {
      const { audio, resolve } = await setup()
      playbackCommands.pause()
      vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('initial refusal', 'NotAllowedError'))
      playbackCommands.play(); await flush()
      expect(store.playbackNotices.value.some(notice => notice.kind === 'tapToResume')).toBe(true)

      let rejectOlder!: (error: unknown) => void
      vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(function (this: HTMLMediaElement) {
        Object.defineProperty(this, 'paused', { configurable: true, value: false })
        this.dispatchEvent(new Event('play'))
        this.dispatchEvent(new Event('waiting'))
        return new Promise<void>((_resolve, reject) => { rejectOlder = reject })
      })
      window.dispatchEvent(new Event('focus')); await flush()
      await vi.advanceTimersByTimeAsync(5_000); await flush()

      vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(function (this: HTMLMediaElement) {
        Object.defineProperty(this, 'paused', { configurable: true, value: false })
        this.dispatchEvent(new Event('play')); this.dispatchEvent(new Event('playing'))
        return Promise.resolve()
      })
      await vi.advanceTimersByTimeAsync(2_000); await flush()
      await progress(audio, 1.25); await progress(audio, 1.5)
      expect(store.status.value).toBe('playing')
      expect(store.playbackNotices.value.some(notice => notice.kind === 'tapToResume')).toBe(false)
      const generation = store.playbackGeneration.value
      const calls = resolve.mock.calls.length

      rejectOlder(new DOMException('obsolete automatic retry', errorName)); await flush()
      expect(store.status.value).toBe('playing')
      expect(store.playbackGeneration.value).toBe(generation)
      expect(resolve).toHaveBeenCalledTimes(calls)
      expect(active()).toBe(audio)
      expect(audio.paused).toBe(false)
      expect(store.playbackNotices.value.some(notice => notice.kind === 'tapToResume')).toBe(false)
    },
  )

  it('publishes a real active stalled event during handover and clears it only on valid native progress', async () => {
    const { audio } = await setup()
    const generation = store.playbackGeneration.value
    ;(store.awaitingStart as Ref<{ generation: number; startPosition: number } | undefined>).value = { generation, startPosition: 1 }
    store.reportMediaState('ready', generation)
    const presentation = playbackPresentationFor(store)
    audio.dispatchEvent(new Event('waiting')); await flush()
    expect(presentation.nativeStalled.value).toBe(false)
    audio.dispatchEvent(new Event('stalled')); await flush()
    expect(presentation.nativeStalled.value).toBe(true)
    await progress(audio, 1)
    expect(presentation.nativeStalled.value).toBe(true)
    await progress(audio, 1.25)
    expect(presentation.nativeStalled.value).toBe(false)
    expect(store.awaitingStart.value).toBeUndefined()
    expect(store.status.value).toBe('playing')
  })

  it('does not clear a native stall from a paused seek or a queued playing event on a paused element', async () => {
    const { audio } = await setup()
    audio.dispatchEvent(new Event('stalled')); await flush()
    const presentation = playbackPresentationFor(store)
    expect(presentation.nativeStalled.value).toBe(true)
    set(audio, { paused: true, seeking: true })
    await progress(audio, 30)
    audio.dispatchEvent(new Event('playing')); await flush()
    expect(presentation.nativeStalled.value).toBe(true)
  })

  it('resets a stalled fact on a new generation and ignores events from the retired deck', async () => {
    const { audio } = await setup()
    const presentation = playbackPresentationFor(store)
    audio.dispatchEvent(new Event('stalled')); await flush()
    expect(presentation.nativeStalled.value).toBe(true)
    await store.playQueueIndex(0); await flush()
    expect(active()).not.toBe(audio)
    expect(presentation.nativeStalled.value).toBe(false)
    audio.dispatchEvent(new Event('stalled')); audio.dispatchEvent(new Event('playing')); await flush()
    expect(presentation.nativeStalled.value).toBe(false)
  })

})
