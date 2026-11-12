import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { ProviderRegistry } from './providers/registry'
import type { AudioProvider, Playable } from './providers/types'
import { createPlaybackStore, type PlaybackStore } from './store'

const micro = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve() }
const flush = async () => { await micro(); await vi.advanceTimersByTimeAsync(0); await micro() }
const wrappers: VueWrapper[] = []
const stores: PlaybackStore[] = []
const playable = (id: string): Playable => ({ kind: 'audio', url: 'https://media.invalid/' + id + '.mp3', mimeType: 'audio/mpeg' })
function provider(id: string) {
  let calls = 0
  return {
    id, canResolve: (track: Track) => track.sources.some((source) => source.provider === id),
    resolve: vi.fn(async (): Promise<Playable> => playable(id + '-' + ++calls)),
  } satisfies AudioProvider
}
function ready(media: HTMLAudioElement) {
  Object.defineProperties(media, {
    duration: { configurable: true, value: 240 },
    readyState: { configurable: true, value: HTMLMediaElement.HAVE_FUTURE_DATA },
    paused: { configurable: true, value: false },
    seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 240 } },
  })
}
async function setup(
  providers = [provider('vkeys'), provider('lx'), provider('gd-studio')],
  beginPlayback = true,
  beforeRegistryRefresh?: () => Promise<void>,
) {
  const registry = new ProviderRegistry(providers.map((source, priority) => ({
    provider: source, priority, enabled: true, timeoutMs: 1_000,
  })))
  const store = createPlaybackStore({
    registry,
    loadRegistry: beforeRegistryRefresh ? async ({ forceRefresh } = {}) => {
      if (forceRefresh) await beforeRegistryRefresh()
      return registry
    } : undefined,
    storage: { getItem: () => null, setItem: () => {} },
  })
  stores.push(store)
  const track: Track = {
    id: 'a', title: 'Track A', aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: providers.map(({ id }) => ({ provider: id, externalId: id + '-a' })),
  }
  if (beginPlayback) await store.playNow(track)
  const wrapper = mount(PlayerBar, { props: { store } })
  wrappers.push(wrapper)
  if (!beginPlayback) await store.playNow(track)
  await flush()
  const audio = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
  if (beginPlayback) {
    ready(audio.element)
    await audio.trigger('playing')
    audio.element.currentTime = 42
    await audio.trigger('timeupdate')
  }
  return { store, wrapper, audio, providers }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  for (const store of stores.splice(0)) store.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('PlayerBar recovery with Vkeys and registered audio providers', () => {
  it.each(['waiting', 'stalled', 'no further events'])('recovers after %s using the same-position provider chain', async (event) => {
    const { store, wrapper, audio, providers: [vkeys, lx, gd] } = await setup()
    const session = store.listeningSessionId.value
    vkeys!.resolve.mockRejectedValueOnce(new Error('fresh stream unavailable'))
    if (event !== 'no further events') await audio.trigger(event)
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(vkeys!.resolve).toHaveBeenCalledTimes(2)
    expect(lx!.resolve).toHaveBeenCalledTimes(1)
    expect(gd!.resolve).not.toHaveBeenCalled()
    expect(store.activeProviderId.value).toBe('lx')
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.pendingResumePosition.value).toBe(42)
    const replacement = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    ready(replacement.element)
    await replacement.trigger('loadedmetadata')
    await replacement.trigger('seeked')
    await flush()
    expect(replacement.element.currentTime).toBe(42)
    expect(store.pendingResumePosition.value).toBeUndefined()
  })

  it('labels Vkeys and renews its expired URL when it is the only provider', async () => {
    const vkeys = provider('vkeys')
    const { store, wrapper, audio } = await setup([vkeys])
    expect(wrapper.text()).toContain('Vkeys')
    const oldSrc = audio.attributes('src')
    await audio.trigger('waiting')
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(store.activeProviderId.value).toBe('vkeys')
    expect(store.pendingResumePosition.value).toBe(42)
    expect(wrapper.get('[data-audio-role="active"]').attributes('src')).not.toBe(oldSrc)
  })

  it('honours actual progress even when a timeupdate event was delayed', async () => {
    const { audio, providers: [vkeys] } = await setup()
    audio.element.currentTime = 43
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(vkeys!.resolve).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(vkeys!.resolve).toHaveBeenCalledTimes(2)
  })

  it('does not restart a stalled stream after a manual pause', async () => {
    const { store, wrapper, audio, providers: [vkeys] } = await setup()
    await audio.trigger('waiting')
    await wrapper.get('[data-player-play]').trigger('click')
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(store.playbackIntent.value).toBe('paused')
    expect(vkeys!.resolve).toHaveBeenCalledTimes(1)
  })

  it('discards an in-flight renewal when the listener pauses', async () => {
    const { store, wrapper, audio, providers: [vkeys] } = await setup()
    let complete!: (value: Playable) => void
    vkeys!.resolve.mockReturnValueOnce(new Promise<Playable>((done) => { complete = done }))
    const oldPlayable = store.playable.value
    await audio.trigger('waiting')
    await vi.advanceTimersByTimeAsync(9_000)
    expect(vkeys!.resolve).toHaveBeenCalledTimes(2)
    await wrapper.get('[data-player-play]').trigger('click')
    const playCalls = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
    complete(playable('late'))
    await flush()
    expect(store.playbackIntent.value).toBe('paused')
    expect(store.playable.value).toEqual(oldPlayable)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCalls)
  })

  it('uses the existing renewal bound when the replacement also makes no progress', async () => {
    const vkeys = provider('vkeys')
    const { store, wrapper, audio } = await setup([vkeys])
    await audio.trigger('waiting')
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    const replacement = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    ready(replacement.element)
    await replacement.trigger('loadedmetadata')
    await replacement.trigger('seeked')
    await flush()
    await replacement.trigger('waiting')
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(store.status.value).toBe('error')
    expect(store.currentTrack.value?.id).toBe('a')
  })

  it('routes a failed media renewal through the same generic provider chain', async () => {
    const { store, audio, providers: [vkeys, lx] } = await setup()
    vkeys!.resolve.mockRejectedValueOnce(new Error('expired ticket'))
    await audio.trigger('error')
    await flush()
    expect(vkeys!.resolve).toHaveBeenCalledTimes(2)
    expect(lx!.resolve).toHaveBeenCalledTimes(1)
    expect(store.activeProviderId.value).toBe('lx')
    expect(store.pendingResumePosition.value).toBe(42)
  })
  it('recovers an initial audio load that never begins playing', async () => {
    const vkeys = provider('vkeys')
    const { store, wrapper } = await setup([vkeys], false)
    const generation = store.playbackGeneration.value
    const initialCalls = vkeys.resolve.mock.calls.length
    const audio = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    Object.defineProperty(audio.element, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_NOTHING })
    await vi.advanceTimersByTimeAsync(7_000)
    await flush()
    expect(vkeys.resolve).toHaveBeenCalledTimes(initialCalls + 1)
    expect(store.playbackGeneration.value).toBe(generation + 1)
    expect(store.sourceOverride.value).toBeUndefined()
    expect(wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element.currentTime).toBe(0)
    expect(store.pendingResumePosition.value).toBeUndefined()
  })

  it('does not treat an OS pause followed by stalled as a new recovery request', async () => {
    const { store, audio, providers: [vkeys] } = await setup()
    await audio.trigger('pause')
    await audio.trigger('stalled')
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.status.value).toBe('paused')
    expect(vkeys!.resolve).toHaveBeenCalledTimes(1)
  })

  it('keeps a manual pause while the remaining provider is resolving', async () => {
    const { store, wrapper, audio, providers: [vkeys, lx] } = await setup()
    let complete!: (value: Playable) => void
    vkeys!.resolve.mockRejectedValueOnce(new Error('renewal failed'))
    lx!.resolve.mockReturnValueOnce(new Promise<Playable>((done) => { complete = done }))
    await audio.trigger('waiting')
    await vi.advanceTimersByTimeAsync(9_000)
    expect(store.status.value).toBe('resolving')
    await wrapper.get('[data-player-play]').trigger('click')
    const playCalls = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
    complete(playable('lx-fresh'))
    await flush()
    expect(store.playbackIntent.value).toBe('paused')
    expect(store.pendingResumePosition.value).toBe(42)
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCalls)
  })

  it('preserves a progressing next-track preload and handover with Vkeys', async () => {
    const vkeys = provider('vkeys')
    const { store, wrapper, audio } = await setup([vkeys])
    const next: Track = { ...store.currentTrack.value!, id: 'b', title: 'Track B', sources: [{ provider: 'vkeys', externalId: 'vkeys-b' }] }
    store.enqueue(next)
    // Enter just before the 180 s preload lead boundary; keep advancing across that boundary.
    audio.element.currentTime = 174
    await audio.trigger('timeupdate')
    for (let second = 175; second <= 185; second += 1) {
      audio.element.currentTime = second
      await audio.trigger('timeupdate')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await flush()
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.preparedNext.value?.track.id).toBe('b')
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    const standby = wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element
    ready(standby)
    audio.element.currentTime = 240
    Object.defineProperty(audio.element, 'ended', { configurable: true, value: true })
    await audio.trigger('pause')
    await audio.trigger('ended')
    await flush()
    const promoted = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    expect(promoted.element).toBe(standby)
    expect(store.currentTrack.value?.id).toBe('b')
    await promoted.trigger('playing')
    for (let second = 1; second <= 12; second += 1) {
      promoted.element.currentTime = second
      await promoted.trigger('timeupdate')
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(store.status.value).toBe('playing')
    expect(store.awaitingStart.value).toBeUndefined()
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
  })

  it('re-arms detection when real progress supersedes a pending renewal', async () => {
    const { store, audio, providers: [vkeys, lx] } = await setup()
    let complete!: (value: Playable) => void
    vkeys!.resolve.mockReturnValueOnce(new Promise<Playable>((done) => { complete = done }))
    const generation = store.playbackGeneration.value
    await audio.trigger('waiting')
    await vi.advanceTimersByTimeAsync(9_000)
    audio.element.currentTime = 43
    await audio.trigger('timeupdate')
    complete(playable('superseded-by-progress'))
    await flush()
    expect(store.playbackGeneration.value).toBe(generation)
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(vkeys!.resolve).toHaveBeenCalledTimes(2)
    expect(lx!.resolve).toHaveBeenCalledTimes(1)
    expect(store.activeProviderId.value).toBe('lx')
    expect(store.pendingResumePosition.value).toBe(43)
  })

  it('leaves pending resume seeks to their deadline and preserves the saved position on failure', async () => {
    const { store, wrapper, audio, providers: [vkeys, lx] } = await setup()
    await audio.trigger('waiting')
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(store.pendingResumePosition.value).toBe(42)
    const replacement = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    expect(replacement.element.currentTime).toBe(0)
    await replacement.trigger('waiting')
    await vi.advanceTimersByTimeAsync(9_000)
    await flush()
    expect(lx!.resolve).not.toHaveBeenCalled()
    expect(store.pendingResumePosition.value).toBe(42)
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(vkeys!.resolve).toHaveBeenCalledTimes(2)
    expect(lx!.resolve).toHaveBeenCalledTimes(1)
    expect(store.activeProviderId.value).toBe('lx')
    expect(store.pendingResumePosition.value).toBe(42)
  })

  it.each([
    ['error-first', 'succeeds'], ['error-first', 'fails'],
    ['rejection-first', 'succeeds'], ['rejection-first', 'fails'],
  ] as const)('coalesces %s play rejection and media errors while fresh Vkeys resolution %s', async (order, renewal) => {
    const vkeys = provider('vkeys'), gd = provider('gd-studio')
    let rejectPlay!: (error: Error) => void
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectPlay = reject }))
    let releaseRegistry!: () => void
    const registryGate = new Promise<void>((resolve) => { releaseRegistry = resolve })
    const refresh = vi.fn(() => registryGate)
    const { store, audio } = await setup([vkeys, gd], false, refresh)
    const failed = vi.spyOn(store, 'reportPlaybackFailure')
    const generation = store.playbackGeneration.value
    const session = store.listeningSessionId.value
    const track = store.currentTrack.value
    if (renewal === 'fails') vkeys.resolve.mockRejectedValueOnce(new Error('renewal unavailable'))
    const mediaError = () => audio.element.dispatchEvent(new Event('error'))
    if (order === 'error-first') mediaError()
    rejectPlay(new DOMException('The expired stream could not be loaded', 'NotSupportedError'))
    await micro()
    // The browser can emit error and reject play() for the same failed resource. A second
    // error while the registry refresh is pending must not cancel renewal before it fetches.
    mediaError()
    mediaError()
    await micro()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(vkeys.resolve).toHaveBeenCalledTimes(1)
    expect(gd.resolve).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
    expect(store.playbackGeneration.value).toBe(generation)
    releaseRegistry()
    await flush()
    expect(vkeys.resolve).toHaveBeenCalledTimes(2)
    expect(gd.resolve).toHaveBeenCalledTimes(renewal === 'fails' ? 1 : 0)
    expect(store.activeProviderId.value).toBe(renewal === 'fails' ? 'gd-studio' : 'vkeys')
    expect(store.currentTrack.value).toBe(track)
    expect(store.listeningSessionId.value).toBe(session)
    expect(store.playbackIntent.value).toBe('playing')
    expect(store.status.value).toBe('ready')
  })

})
