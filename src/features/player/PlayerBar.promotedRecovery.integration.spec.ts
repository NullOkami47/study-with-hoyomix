import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { playbackCommands } from './commands'
import { ProviderRegistry } from './providers/registry'
import type { AudioProvider, Playable } from './providers/types'
import { createPlaybackStore, type PlaybackStore } from './store'

const micro = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve() }
const flush = async () => { await micro(); await vi.advanceTimersByTimeAsync(0); await micro() }
const wrappers: VueWrapper[] = []
const stores: PlaybackStore[] = []
const media = (id: string): Playable => ({ kind: 'audio', url: 'https://media.invalid/' + id + '.mp3', mimeType: 'audio/mpeg' })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function provider(id: string) {
  let calls = 0
  return {
    id, canResolve: (track: Track) => track.sources.some((source) => source.provider === id),
    resolve: vi.fn(async (track: Track, _signal: AbortSignal): Promise<Playable> => media(id + '/' + track.id + '-' + ++calls)),
  } satisfies AudioProvider
}
function ready(element: HTMLAudioElement) {
  Object.defineProperties(element, {
    duration: { configurable: true, value: 240 },
    readyState: { configurable: true, value: HTMLMediaElement.HAVE_FUTURE_DATA },
    paused: { configurable: true, value: false },
    seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } },
  })
}
async function setupPromotion() {
  const vkeys = provider('vkeys'), gd = provider('gd-studio')
  const registry = new ProviderRegistry([vkeys, gd].map((source, priority) => ({
    provider: source, priority, enabled: true, timeoutMs: 1_000,
  })))
  const refresh = vi.fn(async () => {})
  const store = createPlaybackStore({
    registry, loadRegistry: async ({ forceRefresh } = {}) => { if (forceRefresh) await refresh(); return registry },
    storage: { getItem: (key) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} },
  })
  stores.push(store)
  for (const id of ['a', 'b']) store.enqueue({
    id, title: id, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'vkeys', externalId: 'vk-' + id }, { provider: 'gd-studio', externalId: 'gd-' + id }],
  })
  const wrapper = mount(PlayerBar, { props: { store } })
  wrappers.push(wrapper)
  await store.playQueueIndex(0); await flush()
  const first = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
  ready(first.element)
  await first.trigger('playing')
  first.element.currentTime = 225
  await first.trigger('timeupdate'); await flush()
  expect(store.transitionMode.value).toBe('off')
  expect(store.preparedNext.value?.track.id).toBe('b')
  const standby = wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element
  ready(standby)
  const pendingPlay = deferred<void>()
  vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(pendingPlay.promise)
  first.element.currentTime = 240
  Object.defineProperty(first.element, 'ended', { configurable: true, value: true })
  await first.trigger('pause'); await first.trigger('ended'); await flush()
  const promoted = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
  expect(promoted.element).toBe(standby)
  expect(store.currentTrack.value?.id).toBe('b')
  expect(store.awaitingStart.value?.generation).toBe(store.playbackGeneration.value)
  expect(vkeys.resolve).toHaveBeenCalledTimes(2)
  return { store, wrapper, promoted, pendingPlay, vkeys, gd, refresh }
}
const unsupported = () => new DOMException('The promoted ticket could not be loaded', 'NotSupportedError')
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 10))
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  for (const store of stores.splice(0)) store.dispose()
  vi.restoreAllMocks(); vi.useRealTimers()
})

describe('standalone promoted-deck rejection and media-error recovery', () => {
  it.each([
    ['rejection-first', 'succeeds'], ['rejection-first', 'fails'],
    ['error-first', 'succeeds'], ['error-first', 'fails'],
  ] as const)('shares one renewal for %s when renewal %s', async (order, outcome) => {
    const { store, wrapper, promoted, pendingPlay, vkeys, gd, refresh } = await setupPromotion()
    const gate = deferred<void>()
    refresh.mockReturnValueOnce(gate.promise)
    const generation = store.playbackGeneration.value
    const session = store.listeningSessionId.value
    const failed = vi.spyOn(store, 'reportPlaybackFailure')
    if (outcome === 'fails') vkeys.resolve.mockRejectedValueOnce(new Error('renewal unavailable'))
    if (order === 'error-first') await promoted.trigger('error')
    pendingPlay.reject(unsupported()); await micro()
    // Rejection alone must start renewal before a delayed error event can rescue the path.
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
    expect(gd.resolve).not.toHaveBeenCalled()
    await promoted.trigger('error'); await promoted.trigger('error'); await micro()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    gate.resolve(); await flush()
    expect(vkeys.resolve).toHaveBeenCalledTimes(3)
    expect(gd.resolve).toHaveBeenCalledTimes(outcome === 'fails' ? 1 : 0)
    expect(failed).toHaveBeenCalledTimes(outcome === 'fails' ? 1 : 0)
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.activeProviderId.value).toBe(outcome === 'fails' ? 'gd-studio' : 'vkeys')
    expect(store.playbackGeneration.value).toBe(generation + 1)
    if (outcome === 'succeeds') {
      expect(store.awaitingStart.value?.generation).toBe(generation + 1)
      const replacement = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
      ready(replacement.element); await replacement.trigger('playing')
      expect(store.awaitingStart.value).toBeDefined()
      replacement.element.currentTime = 0.5
      await replacement.trigger('timeupdate')
      expect(store.awaitingStart.value).toBeUndefined()
      expect(store.status.value).toBe('playing')
    }
  })

  it('spends the same renewal budget when the renewed promoted URL fails again without progress', async () => {
    const { store, wrapper, pendingPlay, vkeys, gd } = await setupPromotion()
    pendingPlay.reject(unsupported()); await flush()
    expect(vkeys.resolve).toHaveBeenCalledTimes(3)
    expect(gd.resolve).not.toHaveBeenCalled()
    await wrapper.get('[data-audio-role="active"]').trigger('error'); await flush()
    expect(vkeys.resolve).toHaveBeenCalledTimes(3)
    expect(gd.resolve).toHaveBeenCalledTimes(1)
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.activeProviderId.value).toBe('gd-studio')
  })

  it.each(['pause', 'pause-play', 'next', 'stop'] as const)('discards a provider renewal settled after %s', async (action) => {
    const { store, wrapper, promoted, pendingPlay, vkeys, gd } = await setupPromotion()
    const pending = deferred<Playable>()
    vkeys.resolve.mockReturnValueOnce(pending.promise)
    const failed = vi.spyOn(store, 'reportPlaybackFailure')
    // Error-first also isolates cancellation from the rejection-first routing defect.
    await promoted.trigger('error'); pendingPlay.reject(unsupported()); await micro()
    expect(vkeys.resolve).toHaveBeenCalledTimes(3)
    const signal = vkeys.resolve.mock.calls[2][1]
    if (action === 'pause' || action === 'pause-play') {
      await wrapper.get('[data-player-play]').trigger('click')
      if (action === 'pause-play') await wrapper.get('[data-player-play]').trigger('click')
    } else if (action === 'next') {
      store.enqueue({ ...store.currentTrack.value!, id: 'c', sources: [{ provider: 'vkeys', externalId: 'vk-c' }] })
      await wrapper.get('[data-player-next]').trigger('click')
    }
    else (wrapper.vm as unknown as { stop(): void }).stop()
    await flush()
    const expected = {
      playable: store.playable.value, generation: store.playbackGeneration.value,
      track: store.currentTrack.value, session: store.listeningSessionId.value,
      intent: store.playbackIntent.value, status: store.status.value,
      awaiting: store.awaitingStart.value, resume: store.pendingResumePosition.value,
      attempts: [...store.attempts.value], latest: [...store.latestAttempts.value],
    }
    pending.resolve(media('stale-renewal')); await flush()
    expect(signal.aborted).toBe(true)
    expect(store.playable.value).toBe(expected.playable)
    expect(store.playbackGeneration.value).toBe(expected.generation)
    expect(store.currentTrack.value).toBe(expected.track)
    expect(store.listeningSessionId.value).toBe(expected.session)
    expect(store.playbackIntent.value).toBe(expected.intent)
    expect(store.status.value).toBe(expected.status)
    expect(store.awaitingStart.value).toBe(expected.awaiting)
    expect(store.pendingResumePosition.value).toBe(expected.resume)
    expect(store.attempts.value).toEqual(expected.attempts)
    expect(store.latestAttempts.value).toEqual(expected.latest)
    expect(failed).not.toHaveBeenCalled()
    expect(gd.resolve).not.toHaveBeenCalled()
  })

  it('ignores a late play rejection from before a Pause then Play on the same generation', async () => {
    const { store, wrapper, pendingPlay, vkeys, gd, refresh } = await setupPromotion()
    const generation = store.playbackGeneration.value
    const previous = store.playable.value
    await wrapper.get('[data-player-play]').trigger('click')
    await wrapper.get('[data-player-play]').trigger('click'); await flush()
    pendingPlay.reject(unsupported()); await flush()
    expect(refresh).not.toHaveBeenCalled()
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).not.toHaveBeenCalled()
    expect(store.playable.value).toBe(previous)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.playbackIntent.value).toBe('playing')
  })

  it('discards a registry-pending media renewal after Pause then Play without starting a provider request', async () => {
    const { store, wrapper, promoted, pendingPlay, vkeys, gd, refresh } = await setupPromotion()
    const gate = deferred<void>()
    refresh.mockReturnValueOnce(gate.promise)
    const failed = vi.spyOn(store, 'reportPlaybackFailure')
    await promoted.trigger('error'); pendingPlay.reject(unsupported()); await micro()
    expect(refresh).toHaveBeenCalledTimes(1)
    const previous = store.playable.value
    const generation = store.playbackGeneration.value
    await wrapper.get('[data-player-play]').trigger('click')
    await wrapper.get('[data-player-play]').trigger('click'); await flush()
    gate.resolve(); await flush()
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
    expect(store.playable.value).toBe(previous)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.playbackIntent.value).toBe('playing')
  })

  it('discards a promoted renewal after PlayerBar unmount without publishing or falling back', async () => {
    const { store, wrapper, promoted, pendingPlay, vkeys, gd } = await setupPromotion()
    const pending = deferred<Playable>()
    vkeys.resolve.mockReturnValueOnce(pending.promise)
    const failed = vi.spyOn(store, 'reportPlaybackFailure')
    await promoted.trigger('error'); pendingPlay.reject(unsupported()); await micro()
    expect(vkeys.resolve).toHaveBeenCalledTimes(3)
    wrapper.unmount()
    wrappers.splice(wrappers.indexOf(wrapper), 1)
    const expected = {
      playable: store.playable.value, generation: store.playbackGeneration.value,
      track: store.currentTrack.value, session: store.listeningSessionId.value,
      intent: store.playbackIntent.value, status: store.status.value,
      awaiting: store.awaitingStart.value, resume: store.pendingResumePosition.value,
      attempts: [...store.attempts.value], latest: [...store.latestAttempts.value],
    }
    pending.resolve(media('late-after-unmount')); await flush()
    expect(store.playable.value).toBe(expected.playable)
    expect(store.playbackGeneration.value).toBe(expected.generation)
    expect(store.currentTrack.value).toBe(expected.track)
    expect(store.listeningSessionId.value).toBe(expected.session)
    expect(store.playbackIntent.value).toBe(expected.intent)
    expect(store.status.value).toBe(expected.status)
    expect(store.awaitingStart.value).toBe(expected.awaiting)
    expect(store.pendingResumePosition.value).toBe(expected.resume)
    expect(store.attempts.value).toEqual(expected.attempts)
    expect(store.latestAttempts.value).toEqual(expected.latest)
    expect(failed).not.toHaveBeenCalled()
    expect(gd.resolve).not.toHaveBeenCalled()
  })

  it('review P2: seek cancels a pending promoted error renewal without fallback', async () => {
    const { store, promoted, pendingPlay, vkeys, gd } = await setupPromotion()
    const pending = deferred<Playable>()
    vkeys.resolve.mockReturnValueOnce(pending.promise)
    const failed = vi.spyOn(store, 'reportPlaybackFailure')
    await promoted.trigger('error'); pendingPlay.reject(unsupported()); await micro()
    expect(vkeys.resolve).toHaveBeenCalledTimes(3)
    const generation = store.playbackGeneration.value
    const signal = vkeys.resolve.mock.calls[2][1]
    promoted.element.currentTime = 42
    Object.defineProperty(promoted.element, 'seeking', { configurable: true, value: true })
    await promoted.trigger('seeking')
    const previous = store.playable.value
    const session = store.listeningSessionId.value
    const attempts = [...store.attempts.value]
    const latest = [...store.latestAttempts.value]
    pending.resolve(media('review-obsolete-renewal')); await flush()
    console.log('REVIEW_P2_SEEK', JSON.stringify({ signalAborted: signal.aborted, failures: failed.mock.calls.length, gdCalls: gd.resolve.mock.calls.length, provider: store.activeProviderId.value, beforeGeneration: generation, afterGeneration: store.playbackGeneration.value }))
    expect(signal.aborted).toBe(true)
    expect(failed).not.toHaveBeenCalled()
    expect(gd.resolve).not.toHaveBeenCalled()
    expect(store.playable.value).toBe(previous)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.activeProviderId.value).toBe('vkeys')
    expect(store.playbackIntent.value).toBe('playing')
    expect(promoted.element.currentTime).toBe(42)
    expect(store.attempts.value).toEqual(attempts)
    expect(store.latestAttempts.value).toEqual(latest)
  })

  it('review P2: explicit Pause then Play does not adopt a cancelled established recovery', async () => {
    const { store, wrapper, promoted, pendingPlay, vkeys, gd, refresh } = await setupPromotion()
    pendingPlay.resolve(); await flush()
    ready(promoted.element); await promoted.trigger('playing')
    promoted.element.currentTime = 0.5; await promoted.trigger('timeupdate'); await flush()
    expect(store.awaitingStart.value).toBeUndefined()
    const gate = deferred<void>()
    refresh.mockReturnValueOnce(gate.promise)
    const failed = vi.spyOn(store, 'reportPlaybackFailure')
    await promoted.trigger('error'); await micro()
    expect(refresh).toHaveBeenCalledTimes(1)
    const generation = store.playbackGeneration.value
    const previous = store.playable.value
    const session = store.listeningSessionId.value
    await wrapper.get('[data-player-play]').trigger('click')
    expect(store.playbackIntent.value).toBe('paused')
    await wrapper.get('[data-player-play]').trigger('click'); await flush()
    const attempts = [...store.attempts.value]
    const latest = [...store.latestAttempts.value]
    gate.resolve(); await flush()
    console.log('REVIEW_P2_PAUSE_PLAY', JSON.stringify({ failures: failed.mock.calls.length, vkeysCalls: vkeys.resolve.mock.calls.length, gdCalls: gd.resolve.mock.calls.length, provider: store.activeProviderId.value, beforeGeneration: generation, afterGeneration: store.playbackGeneration.value, samePlayable: store.playable.value === previous }))
    expect(failed).not.toHaveBeenCalled()
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).not.toHaveBeenCalled()
    expect(store.playable.value).toBe(previous)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.activeProviderId.value).toBe('vkeys')
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.attempts.value).toEqual(attempts)
    expect(store.latestAttempts.value).toEqual(latest)
  })

  it('cancels a pending error renewal from the seek command before native seeking arrives', async () => {
    const { store, promoted, pendingPlay, vkeys, gd } = await setupPromotion()
    const pending = deferred<Playable>()
    vkeys.resolve.mockReturnValueOnce(pending.promise)
    const failed = vi.spyOn(store, 'reportPlaybackFailure')
    await promoted.trigger('error'); pendingPlay.reject(unsupported()); await micro()
    expect(vkeys.resolve).toHaveBeenCalledTimes(3)
    const generation = store.playbackGeneration.value
    const previous = store.playable.value
    const signal = vkeys.resolve.mock.calls[2][1]
    const nativeSeek = vi.fn()
    promoted.element.addEventListener('seeking', nativeSeek)
    playbackCommands.seek?.(42)
    expect(promoted.element.currentTime).toBe(42)
    expect(nativeSeek).not.toHaveBeenCalled()
    expect(signal.aborted).toBe(true)
    pending.resolve(media('obsolete-command-seek')); await flush()
    expect(failed).not.toHaveBeenCalled()
    expect(gd.resolve).not.toHaveBeenCalled()
    expect(store.playable.value).toBe(previous)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.activeProviderId.value).toBe('vkeys')
    expect(store.playbackIntent.value).toBe('playing')
  })

  it('review P2: a fresh play rejection after explicit Pause then Play keeps its own recovery path', async () => {
    const { store, wrapper, promoted, pendingPlay, vkeys, gd, refresh } = await setupPromotion()
    pendingPlay.resolve(); await flush()
    ready(promoted.element); await promoted.trigger('playing')
    promoted.element.currentTime = 0.5; await promoted.trigger('timeupdate'); await flush()
    expect(store.awaitingStart.value).toBeUndefined()
    const generation = store.playbackGeneration.value
    const session = store.listeningSessionId.value
    const gate = deferred<void>()
    refresh.mockReturnValueOnce(gate.promise)
    const failed = vi.spyOn(store, 'reportPlaybackFailure')
    await promoted.trigger('error'); await micro()
    expect(refresh).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-player-play]').trigger('click')
    expect(store.playbackIntent.value).toBe('paused')
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(unsupported())
    await wrapper.get('[data-player-play]').trigger('click'); await flush()
    gate.resolve(); await flush()
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.playbackGeneration.value).toBe(generation + 1)
    // No replacement metadata/seek events are simulated: its separate 10 s resume deadline
    // may expire. The old recovery must neither swallow nor duplicate the new failure chain.
    await vi.advanceTimersByTimeAsync(10_000); await flush()
    console.log('REVIEW_P2_FRESH_REJECTION', JSON.stringify({ failed: failed.mock.calls.length, vkeys: vkeys.resolve.mock.calls.length, gd: gd.resolve.mock.calls.length, provider: store.activeProviderId.value, generation: store.playbackGeneration.value, intent: store.playbackIntent.value, status: store.status.value }))
    expect(failed).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledWith('vkeys', generation)
    expect(gd.resolve).toHaveBeenCalledTimes(1)
    // The cancelled renewal already spent the bounded attempt; the new command must not reset it.
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.playbackGeneration.value).toBe(generation + 1)
    expect(store.playbackIntent.value).toBe('playing')
  })

  it.each(['NotAllowedError', 'AbortError'])('keeps %s on the existing handover refusal ladder', async (name) => {
    const { store, pendingPlay, vkeys, gd, refresh } = await setupPromotion()
    pendingPlay.reject(new DOMException('refused start', name)); await micro()
    expect(refresh).not.toHaveBeenCalled()
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).not.toHaveBeenCalled()
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.awaitingStart.value).toBeDefined()
    expect(store.playbackIntent.value).toBe('playing')
  })
})
