// Native media event ordering against the mounted product player and store.
// These synthetic tests do not establish physical-device or OS background acceptance.
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { playbackCommands } from './commands'
import { ProviderRegistry } from './providers/registry'
import type { AudioProvider, Playable } from './providers/types'
import { createPlaybackStore, type PlaybackStore } from './store'

const micro = async () => { for (let index = 0; index < 60; index += 1) await Promise.resolve() }
const flush = async () => { await micro(); await vi.advanceTimersByTimeAsync(0); await micro() }
const wrappers: VueWrapper[] = []
const stores: PlaybackStore[] = []
const media = (id: string): Playable => ({ kind: 'audio', url: 'https://media.invalid/' + id + '.mp3', mimeType: 'audio/mpeg' })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function provider(id: string) {
  let calls = 0
  return {
    id,
    canResolve: (track: Track) => track.sources.some(source => source.provider === id),
    resolve: vi.fn(async (track: Track, _signal: AbortSignal): Promise<Playable> => media(id + '/' + track.id + '-' + ++calls)),
  } satisfies AudioProvider
}
function ready(element: HTMLAudioElement, time = 1, paused = false) {
  Object.defineProperties(element, {
    duration: { configurable: true, value: 240 },
    readyState: { configurable: true, value: HTMLMediaElement.HAVE_FUTURE_DATA },
    paused: { configurable: true, value: paused },
    ended: { configurable: true, value: false },
    seeking: { configurable: true, value: false },
    buffered: { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } },
    seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } },
  })
  element.currentTime = time
}
const active = (wrapper: VueWrapper) => wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
async function setup() {
  const lx = provider('lx'), gd = provider('gd-studio')
  const registry = new ProviderRegistry([lx, gd].map((source, priority) => ({
    provider: source, priority, enabled: true, timeoutMs: 1_000,
  })))
  const refresh = vi.fn(async () => {})
  const store = createPlaybackStore({
    registry,
    loadRegistry: async ({ forceRefresh } = {}) => { if (forceRefresh) await refresh(); return registry },
    peekRegistry: () => registry,
    storage: { getItem: key => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem() {} },
  })
  stores.push(store)
  for (const id of ['a', 'b', 'c']) store.enqueue({
    id, title: id, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'lx', externalId: 'wy:' + id + ':320k' }, { provider: 'gd-studio', externalId: 'gd-' + id }],
  })
  const wrapper = mount(PlayerBar, { props: { store } })
  wrappers.push(wrapper)
  await store.playQueueIndex(0); await flush()
  const first = active(wrapper)
  ready(first.element)
  await first.trigger('playing')
  await first.trigger('timeupdate'); await flush()
  expect(store.status.value).toBe('playing')
  return { store, wrapper, first, lx, gd, refresh }
}
function naturalEnd(element: HTMLAudioElement) {
  element.currentTime = 240
  Object.defineProperties(element, {
    ended: { configurable: true, value: true },
    paused: { configurable: true, value: true },
  })
  element.dispatchEvent(new Event('pause'))
  element.dispatchEvent(new Event('ended'))
}
async function setupPromotion() {
  const result = await setup()
  result.first.element.currentTime = 225
  await result.first.trigger('timeupdate'); await flush()
  expect(result.store.preparedNext.value?.track.id).toBe('b')
  const standby = result.wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element
  ready(standby, 0, true)
  const pendingPlay = deferred<void>()
  vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(pendingPlay.promise)
  naturalEnd(result.first.element); await flush()
  const promoted = active(result.wrapper)
  expect(promoted.element).toBe(standby)
  expect(result.store.currentTrack.value?.id).toBe('b')
  expect(result.store.awaitingStart.value?.generation).toBe(result.store.playbackGeneration.value)
  expect(result.lx.resolve).toHaveBeenCalledTimes(2)
  return { ...result, promoted, pendingPlay }
}
const unsupported = () => new DOMException('The source could not start', 'NotSupportedError')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.UTC(2026, 10, 17))
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  for (const store of stores.splice(0)) store.dispose()
  Reflect.deleteProperty(document, 'visibilityState')
  Reflect.deleteProperty(document, 'hidden')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('native operation ownership', () => {
  it('leaves natural end progression to ended instead of publishing an EOS pause as an interruption', async () => {
    const { store, first } = await setup()
    const generation = store.playbackGeneration.value
    first.element.currentTime = 240
    Object.defineProperties(first.element, {
      ended: { configurable: true, value: true }, paused: { configurable: true, value: true },
    })
    await first.trigger('pause'); await flush()
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.status.value).toBe('playing')
    expect(store.playbackGeneration.value).toBe(generation)
    await first.trigger('ended'); await flush()
    expect(store.currentTrack.value?.id).toBe('b')
    expect(store.playbackGeneration.value).toBe(generation + 1)
  })
  it('keeps a bounded start monitor when a manual source change supersedes a handover renewal', async () => {
    const { store, wrapper, promoted, pendingPlay, lx } = await setupPromotion()
    const renewal = deferred<Playable>()
    lx.resolve.mockReturnValueOnce(renewal.promise)
    await promoted.trigger('error'); pendingPlay.reject(unsupported()); await micro()
    expect(lx.resolve).toHaveBeenCalledTimes(3)
    const oldSignal = lx.resolve.mock.calls[2][1]

    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValue(new Promise<void>(() => {}))
    await wrapper.get('select').setValue('gd-studio'); await flush()
    expect(oldSignal.aborted).toBe(true)
    expect(store.activeProviderId.value).toBe('gd-studio')
    // A real source load resets the ended resource; the load() test double does not.
    const replacement = active(wrapper)
    Object.defineProperties(replacement.element, {
      paused: { configurable: true, value: false }, ended: { configurable: true, value: false },
      seeking: { configurable: true, value: false }, readyState: { configurable: true, value: 1 },
      networkState: { configurable: true, value: 2 },
    })
    await replacement.trigger('waiting')
    const generation = store.playbackGeneration.value
    const freshRecovery = vi.spyOn(store, 'requestSourceRecovery')
    const freshFailure = vi.spyOn(store, 'reportPlaybackFailure')
    renewal.resolve(media('obsolete-handover-renewal')); await flush()

    await vi.advanceTimersByTimeAsync(30_000); await flush()
    expect(store.currentTrack.value?.id).toBe('b')
    expect(
      store.playbackNotices.value.some(notice => notice.kind === 'tapToResume' || notice.kind === 'trackFailed') ||
      freshRecovery.mock.calls.some(call => call[1] >= generation) ||
      freshFailure.mock.calls.some(call => call[1] >= generation),
    ).toBe(true)
  })

  it.each(['pause', 'stop', 'next', 'native-pause', 'seek', 'timer-resume'] as const)(
    'ignores a Repeat One rejection after a newer %s command',
    async command => {
      const { store, wrapper, first, lx, gd } = await setup()
      store.setRepeatMode('one')
      const repeat = deferred<void>()
      vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(repeat.promise)
      naturalEnd(first.element); await flush()
      if (command === 'next') store.setRepeatMode('off')
      if (command === 'native-pause') {
        ready(first.element, 0, true)
        await first.trigger('pause')
      } else if (command === 'seek') {
        ready(first.element, 0, false)
        playbackCommands.seek?.(65)
        await first.trigger('seeking')
        first.element.currentTime = 65.25; await first.trigger('timeupdate')
      } else if (command === 'timer-resume') {
        ready(first.element, 0, false)
        const lease = playbackCommands.pauseForInterruption()
        expect(lease).toBeDefined()
        lease?.resumeIfStillOwned()
      } else playbackCommands[command]?.()
      await flush()
      const expected = {
        trackId: store.currentTrack.value?.id,
        generation: store.playbackGeneration.value,
        session: store.listeningSessionId.value,
        intent: store.playbackIntent.value,
        source: store.playable.value,
        lxCalls: lx.resolve.mock.calls.length,
        gdCalls: gd.resolve.mock.calls.length,
      }
      expect(expected.trackId).toBe(command === 'stop' ? undefined : command === 'next' ? 'b' : 'a')
      repeat.reject(unsupported()); await flush()
      expect(store.currentTrack.value?.id).toBe(expected.trackId)
      expect(store.playbackGeneration.value).toBe(expected.generation)
      expect(store.listeningSessionId.value).toBe(expected.session)
      expect(store.playbackIntent.value).toBe(expected.intent)
      expect(store.playable.value).toBe(expected.source)
      expect(lx.resolve).toHaveBeenCalledTimes(expected.lxCalls)
      expect(gd.resolve).toHaveBeenCalledTimes(expected.gdCalls)
    },
  )

  it('keeps the current Repeat One failure eligible for its ordinary reload', async () => {
    const { store, first, lx } = await setup()
    store.setRepeatMode('one')
    const repeat = deferred<void>()
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(repeat.promise)
    naturalEnd(first.element); await flush()
    const generation = store.playbackGeneration.value
    const calls = lx.resolve.mock.calls.length
    repeat.reject(unsupported()); await flush()
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.playbackGeneration.value).toBe(generation + 1)
    expect(lx.resolve).toHaveBeenCalledTimes(calls + 1)
    expect(store.playbackIntent.value).toBe('playing')
  })
})
