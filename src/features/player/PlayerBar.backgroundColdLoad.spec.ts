// Regression coverage for Android Firefox locked-screen/hidden renewal and
// cold track advance when no standby preparation is held. Mirrors the
// 2026-11-20 staging debug log (`deck.coldLoad` mounting an unactivated deck
// with `everPlayed: false` while `visibilityState === 'hidden'`).
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { ProviderRegistry } from './providers/registry'
import { createPlaybackStore, type PlaybackStore } from './store'
import { playbackLog } from './playbackLog'

const ANDROID_FIREFOX_UA =
  'Mozilla/5.0 (Android 17; Mobile; rv:160.0) Gecko/160.0 Firefox/160.0'

let wrapper: VueWrapper | undefined
let store: PlaybackStore | undefined

const flush = async () => {
  for (let i = 0; i < 60; i += 1) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

const track = (id: string): Track => ({
  id,
  title: id,
  aliases: {},
  games: ['genshin'],
  relationIds: [],
  tabs: ['focus'],
  workGroupId: 'wg',
  vocalStatus: 'instrumental',
  needsClassification: false,
  sources: [{ provider: 'gd-studio', externalId: `netease:${id}:320` }],
}) as Track

const activeElement = () =>
  wrapper!.get<HTMLAudioElement>('audio[data-audio-role="active"]').element

function setReady(audio: HTMLAudioElement, time: number, paused: boolean): void {
  Object.defineProperties(audio, {
    duration: { configurable: true, value: 240 },
    readyState: { configurable: true, value: 4 },
    paused: { configurable: true, value: paused },
    ended: { configurable: true, value: false },
    seeking: { configurable: true, value: false },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } },
    seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } },
  })
  audio.currentTime = time
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
  Object.defineProperty(document, 'hidden', { configurable: true, value: state === 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  playbackLog.clear()
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID_FIREFOX_UA)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLAudioElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false })
    this.dispatchEvent(new Event('play'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLAudioElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true })
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})

afterEach(() => {
  wrapper?.unmount()
  store?.dispose()
  wrapper = undefined
  store = undefined
  Reflect.deleteProperty(document, 'visibilityState')
  Reflect.deleteProperty(document, 'hidden')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setupPlayingTrackA() {
  let call = 0
  const resolve = vi.fn(async (t: Track) => {
    call += 1
    return {
      kind: 'audio' as const,
      url: `https://staging.example.invalid/api/providers/gd-studio/media/${t.id}/${String(call).padStart(32, 'a')}`,
      mimeType: 'audio/mpeg',
    }
  })
  const provider = { id: 'gd-studio', canResolve: () => true, resolve }
  store = createPlaybackStore({
    registry: new ProviderRegistry([{ provider, enabled: true, priority: 1, timeoutMs: 1000 }]),
    storage: { getItem: (k) => (k === 'hoyomix-player-shuffle-v1' ? 'false' : null), setItem: () => {} },
  })
  store.setPreloadPolicy('none')
  store.enqueue(track('a'))
  store.enqueue(track('b'))
  wrapper = mount(PlayerBar, { props: { store }, attachTo: document.body })

  await store.playQueueIndex(0)
  await flush()
  const initial = activeElement()
  setReady(initial, 1.5, false)
  initial.dispatchEvent(new Event('playing'))
  initial.dispatchEvent(new Event('timeupdate'))
  await flush()

  setVisibility('hidden')
  await flush()
  playbackLog.clear()
  return { initial, resolve }
}

describe('Android Firefox hidden coldLoad / renewal element reuse', () => {
  it('reuses the activated audio element with preload="auto" and without clearDeck teardown on hidden renewMedia at t=0', async () => {
    const { initial } = await setupPlayingTrackA()
    // Reset both element time and store presentation time to 0 (no pendingResumePosition)
    initial.currentTime = 0
    initial.dispatchEvent(new Event('timeupdate'))
    await flush()
    playbackLog.clear()

    const renewed = await store!.renewMedia('gd-studio', store!.playbackGeneration.value)
    await flush()

    expect(renewed).toBe(true)
    const after = activeElement()
    expect(initial.isConnected).toBe(true)
    expect(after).toBe(initial)
    expect(after.getAttribute('preload')).toBe('auto')

    const entries = playbackLog.snapshot()
    const coldLoad = entries.find((e) => e.type === 'deck.coldLoad')
    expect(coldLoad).toMatchObject({ reusedElement: true })
    const releaseClears = entries.filter(
      (e) => e.type === 'media.app.source.after' && e.site === 'release-source' && e.src === null,
    )
    expect(releaseClears).toHaveLength(0)
  })

  it('reuses the activated audio element with preload="auto" and without clearDeck teardown on hidden mid-track renewMedia', async () => {
    const { initial } = await setupPlayingTrackA()
    const renewed = await store!.renewMedia('gd-studio', store!.playbackGeneration.value)
    await flush()

    expect(renewed).toBe(true)
    const after = activeElement()
    expect(initial.isConnected).toBe(true)
    expect(after).toBe(initial)
    expect(after.getAttribute('preload')).toBe('auto')

    const entries = playbackLog.snapshot()
    const coldLoad = entries.find((e) => e.type === 'deck.coldLoad')
    expect(coldLoad).toMatchObject({ reusedElement: true })
    const releaseClears = entries.filter(
      (e) => e.type === 'media.app.source.after' && e.site === 'release-source' && e.src === null,
    )
    expect(releaseClears).toHaveLength(0)
  })

  it('reuses the activated audio element with preload="auto" and without clearDeck teardown on hidden cold advance (store.next)', async () => {
    const { initial } = await setupPlayingTrackA()
    await store!.next()
    await flush()

    expect(store!.currentTrack.value?.id).toBe('b')
    const after = activeElement()
    expect(initial.isConnected).toBe(true)
    expect(after).toBe(initial)
    expect(after.getAttribute('preload')).toBe('auto')

    const entries = playbackLog.snapshot()
    const coldLoad = entries.find((e) => e.type === 'deck.coldLoad')
    expect(coldLoad).toMatchObject({ reusedElement: true, trackId: 'b' })
  })

  it('cleanly tears down the retained empty deck when store.stop() runs during in-flight cold advance', async () => {
    const { initial, resolve } = await setupPlayingTrackA()
    let finishNext: ((value: { kind: 'audio'; url: string; mimeType: string }) => void) | undefined
    resolve.mockImplementationOnce(
      () =>
        new Promise((res) => {
          finishNext = res
        }),
    )

    const pendingNext = store!.next()
    await flush()
    expect(initial.isConnected).toBe(true)

    store!.stop()
    await flush()
    expect(wrapper!.findAll('audio')).toHaveLength(0)

    finishNext?.({
      kind: 'audio',
      url: 'https://staging.example.invalid/api/providers/gd-studio/media/b/' + 'b'.repeat(32),
      mimeType: 'audio/mpeg',
    })
    await pendingNext
    await flush()
    expect(wrapper!.findAll('audio')).toHaveLength(0)
  })
})
