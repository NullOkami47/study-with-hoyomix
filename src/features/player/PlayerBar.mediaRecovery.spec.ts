import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { ProviderRegistry } from './providers/registry'
import type { AudioProvider, Playable } from './providers/types'
import { createPlaybackStore, type PlaybackStore } from './store'

const storage = { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} }
const track = (id: string): Track => ({
  id, title: id, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'lx', externalId: `wy:${id}:320k` }, { provider: 'gd-studio', externalId: `netease:${id}:320` }],
}) as unknown as Track
const audio = (name: string): Playable => ({ kind: 'audio', url: `https://media.invalid/${name}.mp3`, mimeType: 'audio/mpeg' })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let i = 0; i < 60; i += 1) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 60; i += 1) await Promise.resolve()
}
let store: PlaybackStore
let wrapper: VueWrapper
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})
afterEach(() => { wrapper?.unmount(); store?.dispose(); vi.restoreAllMocks(); vi.useRealTimers() })

async function setup(resolve: AudioProvider['resolve'], fallback: AudioProvider['resolve'] = async () => null, validity?: number) {
  const lx: AudioProvider = { id: 'lx', canResolve: () => true, resolve: vi.fn(resolve) }
  const gd: AudioProvider = { id: 'gd-studio', canResolve: () => true, resolve: vi.fn(fallback) }
  const registry = new ProviderRegistry([
    { provider: lx, enabled: true, priority: 1, timeoutMs: 30_000 },
    { provider: gd, enabled: true, priority: 2, timeoutMs: 30_000 },
  ])
  store = createPlaybackStore({ registry, storage, preparationValidityMs: validity })
  store.enqueue(track('a')); store.enqueue(track('b'))
  wrapper = mount(PlayerBar, { props: { store } })
  await store.playQueueIndex(0); await flush()
  return { lx, gd }
}
const active = () => wrapper.get<HTMLAudioElement>('audio[data-audio-role="active"]').element
function reportPosition(position = 42) {
  const element = active()
  Object.defineProperty(element, 'duration', { configurable: true, value: 240 })
  Object.defineProperty(element, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } })
  element.currentTime = position
  element.dispatchEvent(new Event('loadedmetadata'))
  element.dispatchEvent(new Event('timeupdate'))
}
function mediaError(element: HTMLAudioElement, code = 4) {
  Object.defineProperty(element, 'error', { configurable: true, value: { code, message: 'Temporary media source failure' } })
  element.dispatchEvent(new Event('error'))
}

describe('same-track media recovery without Jellyfin', () => {
  it('does not cancel initial media-load recovery on the error-induced pause before metadata', async () => {
    const renewal = deferred<Playable | null>()
    let calls = 0
    const { gd } = await setup(async () => ++calls === 1 ? audio('unloadable') : renewal.promise, async () => audio('gd-fallback'))
    store.removeQueueIndex(1)
    const element = active()
    Object.defineProperty(element, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_NOTHING })
    mediaError(element, 4); await flush()
    Object.defineProperty(element, 'paused', { configurable: true, value: true })
    element.dispatchEvent(new Event('pause')); await flush()
    renewal.resolve(null); await flush()
    expect(gd.resolve).toHaveBeenCalledTimes(1)
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.playable.value).toEqual(audio('gd-fallback'))
  })

  it.each(['play rejection', 'second error'] as const)('joins a concurrent %s instead of cancelling a valid fresh resolve', async (duplicate) => {
    const firstPlay = deferred<void>()
    const renewal = deferred<Playable | null>()
    let renewalSignal: AbortSignal | undefined
    let calls = 0
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (this: HTMLMediaElement) {
      return this.getAttribute('src')?.includes('/expired.') ? firstPlay.promise : Promise.resolve()
    })
    const { lx, gd } = await setup(async (_track, signal) => {
      if (++calls === 1) return audio('expired')
      renewalSignal = signal
      return renewal.promise
    })
    store.removeQueueIndex(1)
    await flush()
    reportPosition(); await flush()
    const session = store.listeningSessionId.value
    const element = active()
    mediaError(element)
    if (duplicate === 'play rejection') firstPlay.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'))
    else { mediaError(element); firstPlay.resolve() }
    await flush()
    renewal.resolve(audio('fresh'))
    await flush()

    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.status.value).not.toBe('error')
    expect(store.activeProviderId.value).toBe('lx')
    expect(store.playable.value).toEqual(audio('fresh'))
    expect(store.pendingResumePosition.value).toBe(42)
    expect(store.listeningSessionId.value).toBe(session)
    expect(renewalSignal?.aborted).toBe(false)
    expect(lx.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).not.toHaveBeenCalled()
  })

  it('tries the next provider once for the same track and position when renewal really fails', async () => {
    let calls = 0
    const { lx, gd } = await setup(async () => ++calls === 1 ? audio('expired') : null, async () => audio('gd-fallback'))
    reportPosition(73); await flush()
    mediaError(active())
    await flush()
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.playable.value).toEqual(audio('gd-fallback'))
    expect(store.pendingResumePosition.value).toBe(73)
    expect(lx.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).toHaveBeenCalledTimes(1)
  })

  it('discards a failed standby without changing active playback or repeatedly preloading it', async () => {
    const calls = new Map<string, number>()
    const { lx, gd } = await setup(async (current) => {
      const count = (calls.get(current.id) ?? 0) + 1; calls.set(current.id, count)
      return audio(`${current.id}-${count}`)
    })
    store.reportMediaState('playing', store.playbackGeneration.value)
    store.setPreloadPolicy('auto')
    await store.armNextPreparation(); await flush()
    const generation = store.playbackGeneration.value
    const initial = store.playable.value
    mediaError(wrapper.get<HTMLAudioElement>('audio[data-audio-role="standby"]').element, 2)
    await flush()
    const afterFailure = store.preparedNext.value
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.playable.value).toBe(initial)
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.status.value).toBe('playing')
    await store.armNextPreparation(); await store.armNextPreparation(); await flush()
    const callsBeforeNext = calls.get('b')
    await store.next(); await flush()

    expect(afterFailure).toBeNull()
    expect(callsBeforeNext).toBe(1)
    expect(calls.get('b')).toBe(2)
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.playable.value).toEqual(audio('b-2'))
    expect(store.playbackGeneration.value).toBeGreaterThan(generation)
    expect(initial).toEqual(audio('a-1'))
    expect(lx.resolve).toHaveBeenCalledTimes(3)
    expect(gd.resolve).toHaveBeenCalledTimes(1)
  })

  it('resolves again instead of promoting an expired preparation', async () => {
    const calls = new Map<string, number>()
    await setup(async (current) => {
      const count = (calls.get(current.id) ?? 0) + 1; calls.set(current.id, count)
      return audio(`${current.id}-${count}`)
    }, undefined, 1000)
    store.setPreloadPolicy('auto')
    await store.armNextPreparation(); await flush()
    await vi.advanceTimersByTimeAsync(1001)
    await store.next(); await flush()
    expect(calls.get('b')).toBe(2)
    expect(store.playable.value).toEqual(audio('b-2'))
    expect(store.preloadHandoff.value).toBeNull()
  })

  it('ignores a late renewal and its play rejection after rapid next/previous navigation', async () => {
    const renewal = deferred<Playable | null>()
    const firstPlay = deferred<void>()
    let count = 0
    let renewalSignal: AbortSignal | undefined
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function (this: HTMLMediaElement) {
      return this.getAttribute('src')?.includes('/a-1.') ? firstPlay.promise : Promise.resolve()
    })
    const { gd } = await setup(async (current, signal) => {
      count += 1
      if (count === 2) { renewalSignal = signal; return renewal.promise }
      return audio(`${current.id}-${count}`)
    })
    mediaError(active()); await flush()
    await store.next(); await store.previous(); await flush()
    const currentGeneration = store.playbackGeneration.value
    const selected = store.playable.value
    firstPlay.reject(new DOMException('Old load failed', 'NotSupportedError'))
    renewal.resolve(audio('late-renewal')); await flush()
    expect(renewalSignal?.aborted).toBe(true)
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.playbackGeneration.value).toBe(currentGeneration)
    expect(store.playable.value).toEqual(selected)
    expect(store.status.value).not.toBe('error')
    expect(gd.resolve).not.toHaveBeenCalled()
  })

  it('does not let a cancelled preload complete over rapid next/previous selection', async () => {
    const preparation = deferred<Playable | null>()
    let bCalls = 0
    let preloadSignal: AbortSignal | undefined
    await setup(async (current, signal) => {
      if (current.id === 'b' && ++bCalls === 1) { preloadSignal = signal; return preparation.promise }
      return audio(current.id + '-selected')
    })
    store.setPreloadPolicy('auto')
    const preparing = store.armNextPreparation(); await flush()
    expect(preloadSignal?.aborted).toBe(false)
    const advancing = store.next()
    const previous = store.previous()
    await previous; await flush()
    const generation = store.playbackGeneration.value
    const selected = store.playable.value
    preparation.resolve(audio('late-preload'))
    await Promise.all([preparing, advancing]); await flush()
    expect(bCalls).toBe(1)
    expect(preloadSignal?.aborted).toBe(true)
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.playable.value).toBe(selected)
    expect(store.preparedNext.value).toBeNull()
  })

  it('bounds repeated source failures before playback makes progress', async () => {
    let calls = 0
    const { lx, gd } = await setup(async () => audio(++calls === 1 ? 'expired' : 'fresh'))
    store.removeQueueIndex(1); await flush()
    mediaError(active()); await flush()
    expect(store.playable.value).toEqual(audio('fresh'))
    const broken = active()
    for (let i = 0; i < 10; i += 1) mediaError(broken)
    await flush()
    await vi.advanceTimersByTimeAsync(60_000); await flush()
    expect(lx.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).toHaveBeenCalledTimes(1)
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.status.value).toBe('error')
  })

  it('keeps the pending seek when a renewed source fails before metadata reaches the saved position', async () => {
    let calls = 0
    const { lx, gd } = await setup(async () => audio(++calls === 1 ? 'expired' : 'fresh'), async () => audio('gd-fallback'))
    reportPosition(73)
    mediaError(active()); await flush()
    expect(store.pendingResumePosition.value).toBe(73)
    expect(store.playable.value).toEqual(audio('fresh'))
    mediaError(active()); await flush()
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.pendingResumePosition.value).toBe(73)
    expect(store.currentTrack.value?.id).toBe('a')
    expect(lx.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).toHaveBeenCalledTimes(1)
  })

})


describe('stalled media recovery with registered audio providers', () => {
  function stallAt(position = 42) {
    const element = active()
    Object.defineProperty(element, 'paused', { configurable: true, value: false })
    Object.defineProperty(element, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA })
    reportPosition(position)
    element.dispatchEvent(new Event('playing'))
    element.dispatchEvent(new Event('waiting'))
    return element
  }

  it('renews a stalled LX stream at the same position without a media error or another provider', async () => {
    let calls = 0
    let adoptedSignal: AbortSignal | undefined
    const { lx, gd } = await setup(async (_track, signal) => {
      if (++calls === 1) return audio('stalled')
      adoptedSignal = signal
      return audio('renewed')
    })
    store.removeQueueIndex(1)
    stallAt(73); await flush()
    const session = store.listeningSessionId.value
    await vi.advanceTimersByTimeAsync(9_000); await flush()

    expect(store.playable.value).toEqual(audio('renewed'))
    expect(adoptedSignal?.aborted).toBe(false)
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.activeProviderId.value).toBe('lx')
    expect(store.pendingResumePosition.value).toBe(73)
    expect(store.listeningSessionId.value).toBe(session)
    expect(lx.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).not.toHaveBeenCalled()
  })

  it('uses GD Studio at the saved position when renewing a stalled LX stream fails', async () => {
    let calls = 0
    const { lx, gd } = await setup(async () => ++calls === 1 ? audio('stalled') : null, async () => audio('gd-recovery'))
    store.removeQueueIndex(1)
    stallAt(73); await flush()
    await vi.advanceTimersByTimeAsync(9_000); await flush()

    expect(store.playable.value).toEqual(audio('gd-recovery'))
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.pendingResumePosition.value).toBe(73)
    expect(lx.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).toHaveBeenCalledTimes(1)
  })

  it.each(['progress', 'native pause', 'listener pause', 'seek'] as const)(
    'discards a stalled renewal after %s while resolution is pending', async (interruption) => {
      const renewal = deferred<Playable | null>()
      let calls = 0
      const { lx, gd } = await setup(async () => ++calls === 1 ? audio('stalled') : renewal.promise)
      store.removeQueueIndex(1)
      const element = stallAt(); await flush()
      const generation = store.playbackGeneration.value
      await vi.advanceTimersByTimeAsync(9_000); await flush()
      expect(lx.resolve).toHaveBeenCalledTimes(2)

      if (interruption === 'progress') {
        element.currentTime = 43
        element.dispatchEvent(new Event('timeupdate'))
      } else if (interruption === 'native pause') {
        Object.defineProperty(element, 'paused', { configurable: true, value: true })
        element.dispatchEvent(new Event('pause'))
      } else if (interruption === 'seek') {
        Object.defineProperty(element, 'seeking', { configurable: true, value: true })
        element.dispatchEvent(new Event('seeking'))
      } else store.pause()
      await flush()
      const playCount = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
      renewal.resolve(audio('obsolete-renewal')); await flush()

      expect(store.playbackGeneration.value).toBe(generation)
      expect(store.playable.value).toEqual(audio('stalled'))
      expect(gd.resolve).not.toHaveBeenCalled()
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCount)
    },
  )

  it('does not replace a newly selected track with a late stalled renewal', async () => {
    const renewal = deferred<Playable | null>()
    let calls = 0
    await setup(async (current) => current.id === 'a' && ++calls === 2 ? renewal.promise : audio(current.id))
    stallAt(); await flush()
    await vi.advanceTimersByTimeAsync(9_000); await flush()
    expect(calls).toBe(2)
    await store.next(); await flush()
    const generation = store.playbackGeneration.value
    renewal.resolve(audio('obsolete-renewal')); await flush()

    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.playable.value).toEqual(audio('b'))
    expect(store.playbackGeneration.value).toBe(generation)
  })

  it('recovers a real media error after progress invalidates a pending stall renewal', async () => {
    const renewal = deferred<Playable | null>()
    let calls = 0
    const { lx, gd } = await setup(async () => ++calls === 1 ? audio('stalled') : renewal.promise, async () => audio('gd-recovery'))
    store.removeQueueIndex(1)
    const element = stallAt(); await flush()
    await vi.advanceTimersByTimeAsync(9_000); await flush()
    expect(lx.resolve).toHaveBeenCalledTimes(2)
    reportPosition(43); await flush()
    mediaError(element); await flush()
    renewal.resolve(null); await flush()

    expect(store.playable.value).toEqual(audio('gd-recovery'))
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.pendingResumePosition.value).toBe(43)
    expect(store.currentTrack.value?.id).toBe('a')
    expect(gd.resolve).toHaveBeenCalledTimes(1)
  })

  it('rearms monitoring when progress and another waiting event supersede a pending stall renewal', async () => {
    const renewal = deferred<Playable | null>()
    let calls = 0
    const { gd } = await setup(async () => ++calls === 1 ? audio('stalled') : renewal.promise, async () => audio('gd-recovery'))
    store.removeQueueIndex(1)
    const element = stallAt(); await flush()
    await vi.advanceTimersByTimeAsync(9_000); await flush()
    expect(calls).toBe(2)
    reportPosition(43)
    element.dispatchEvent(new Event('waiting')); await flush()
    renewal.resolve(audio('obsolete')); await flush()
    expect(store.playable.value).toEqual(audio('stalled'))
    await vi.advanceTimersByTimeAsync(9_000); await flush()

    expect(gd.resolve).toHaveBeenCalledTimes(1)
    expect(store.playable.value).toEqual(audio('gd-recovery'))
    expect(store.pendingResumePosition.value).toBe(43)
  })

  it.each([false, true])('resets renewal allowance only after real progress (advances=%s)', async (advances) => {
    let calls = 0
    const { lx, gd } = await setup(async () => {
      if (++calls === 1) return audio('stalled')
      await new Promise<void>((resolve) => setTimeout(resolve, 1_100))
      return audio('renewed-' + calls)
    }, async () => audio('gd-recovery'))
    store.removeQueueIndex(1)
    stallAt(73); await flush()
    await vi.advanceTimersByTimeAsync(10_100); await flush()
    expect(store.playable.value).toEqual(audio('renewed-2'))
    stallAt(73); await flush()
    if (advances) { reportPosition(74); await flush() }
    await vi.advanceTimersByTimeAsync(10_100); await flush()

    expect(store.currentTrack.value?.id).toBe('a')
    if (advances) {
      expect(lx.resolve).toHaveBeenCalledTimes(3)
      expect(gd.resolve).not.toHaveBeenCalled()
      expect(store.pendingResumePosition.value).toBe(74)
    } else {
      expect(lx.resolve).toHaveBeenCalledTimes(2)
      expect(gd.resolve).toHaveBeenCalledTimes(1)
      expect(store.playable.value).toEqual(audio('gd-recovery'))
      expect(store.pendingResumePosition.value).toBe(73)
    }
  })

  it('does not refill renewal allowance for a native seek without playback progress', async () => {
    let calls = 0
    const { lx, gd } = await setup(async () => {
      if (++calls === 1) return audio('stalled')
      await new Promise<void>((resolve) => setTimeout(resolve, 1_100))
      return audio('renewed-' + calls)
    }, async () => audio('gd-recovery'))
    store.removeQueueIndex(1)
    stallAt(73); await flush()
    await vi.advanceTimersByTimeAsync(10_100); await flush()
    const element = stallAt(73); await flush()
    Object.defineProperty(element, 'seeking', { configurable: true, value: true })
    element.dispatchEvent(new Event('seeking'))
    reportPosition(74)
    Object.defineProperty(element, 'seeking', { configurable: true, value: false })
    element.dispatchEvent(new Event('seeked'))
    element.dispatchEvent(new Event('timeupdate'))
    element.dispatchEvent(new Event('waiting')); await flush()
    await vi.advanceTimersByTimeAsync(10_100); await flush()

    expect(lx.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).toHaveBeenCalledTimes(1)
    expect(store.pendingResumePosition.value).toBe(74)
  })

  it('leaves a slow preloaded handover to its existing bounded loading watchdog', async () => {
    const { lx, gd } = await setup(async (current) => audio(current.id))
    store.setPreloadPolicy('auto')
    await store.armNextPreparation(); await flush()
    expect(store.preparedNext.value?.track.id).toBe('b')
    const first = active()
    first.dispatchEvent(new Event('pause'))
    first.dispatchEvent(new Event('ended')); await flush()
    expect(store.currentTrack.value?.id).toBe('b')
    const generation = store.playbackGeneration.value
    const promoted = active()
    Object.defineProperty(promoted, 'paused', { configurable: true, value: false })
    Object.defineProperty(promoted, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA })
    Object.defineProperty(promoted, 'networkState', { configurable: true, value: HTMLMediaElement.NETWORK_LOADING })
    promoted.dispatchEvent(new Event('waiting')); await flush()
    const calls = vi.mocked(lx.resolve).mock.calls.length
    await vi.advanceTimersByTimeAsync(8_000); await flush()

    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.playbackGeneration.value).toBe(generation)
    expect(lx.resolve).toHaveBeenCalledTimes(calls)
    expect(gd.resolve).not.toHaveBeenCalled()
    expect(store.awaitingStart.value?.generation).toBe(generation)
  })

  it('cancels an error queued behind a stall renewal when a native pause arrives later', async () => {
    const renewal = deferred<Playable | null>()
    let calls = 0
    const { gd } = await setup(async () => ++calls === 1 ? audio('stalled') : renewal.promise, async () => audio('gd-recovery'))
    store.removeQueueIndex(1)
    const element = stallAt(); await flush()
    const generation = store.playbackGeneration.value
    await vi.advanceTimersByTimeAsync(9_000); await flush()
    reportPosition(43)
    mediaError(element); await flush()
    Object.defineProperty(element, 'paused', { configurable: true, value: true })
    element.dispatchEvent(new Event('pause')); await flush()
    const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
    renewal.resolve(null); await flush()

    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.playable.value).toEqual(audio('stalled'))
    expect(store.status.value).toBe('paused')
    expect(gd.resolve).not.toHaveBeenCalled()
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays)
  })

  it('rearms after a seek completes while buffering even without another waiting event', async () => {
    const renewal = deferred<Playable | null>()
    let calls = 0
    const { gd } = await setup(async () => ++calls === 1 ? audio('stalled') : renewal.promise, async () => audio('gd-recovery'))
    store.removeQueueIndex(1)
    const element = stallAt(); await flush()
    await vi.advanceTimersByTimeAsync(9_000); await flush()
    Object.defineProperty(element, 'seeking', { configurable: true, value: true })
    element.dispatchEvent(new Event('seeking'))
    reportPosition(73)
    renewal.resolve(audio('obsolete')); await flush()
    Object.defineProperty(element, 'seeking', { configurable: true, value: false })
    element.dispatchEvent(new Event('seeked')); await flush()
    await vi.advanceTimersByTimeAsync(9_000); await flush()

    expect(gd.resolve).toHaveBeenCalledTimes(1)
    expect(store.playable.value).toEqual(audio('gd-recovery'))
    expect(store.pendingResumePosition.value).toBe(73)
  })

  it('continues stall monitoring after the handover watchdog observes progress without timeupdate', async () => {
    const { lx } = await setup(async (current) => audio(current.id))
    store.setPreloadPolicy('auto')
    await store.armNextPreparation(); await flush()
    const first = active()
    first.dispatchEvent(new Event('pause'))
    first.dispatchEvent(new Event('ended')); await flush()
    const generation = store.playbackGeneration.value
    const promoted = active()
    Object.defineProperty(promoted, 'paused', { configurable: true, value: false })
    Object.defineProperty(promoted, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA })
    Object.defineProperty(promoted, 'networkState', { configurable: true, value: HTMLMediaElement.NETWORK_LOADING })
    Object.defineProperty(promoted, 'duration', { configurable: true, value: 240 })
    promoted.currentTime = 2
    promoted.dispatchEvent(new Event('waiting')); await flush()
    await vi.advanceTimersByTimeAsync(14_000); await flush()

    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.playbackGeneration.value).toBeGreaterThan(generation)
    expect(store.pendingResumePosition.value ?? active().currentTime).toBe(2)
    expect(vi.mocked(lx.resolve).mock.calls.filter(([current]) => current.id === 'b')).toHaveLength(2)
  })

  it('honours a native pause before the stall deadline without requesting a source', async () => {
    const { lx, gd } = await setup(async () => audio('current'))
    store.removeQueueIndex(1)
    const element = stallAt(); await flush()
    Object.defineProperty(element, 'paused', { configurable: true, value: true })
    element.dispatchEvent(new Event('pause'))
    await vi.advanceTimersByTimeAsync(60_000); await flush()

    expect(store.status.value).toBe('paused')
    expect(store.playable.value).toEqual(audio('current'))
    expect(lx.resolve).toHaveBeenCalledTimes(1)
    expect(gd.resolve).not.toHaveBeenCalled()
  })
})
