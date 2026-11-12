import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, onBeforeUnmount, ref, type Ref } from 'vue'

import PlayerBar from './PlayerBar.vue'
import CompactPlayback from './CompactPlayback.vue'
import { createPlaybackStore, type FailureOutcome, type PlaybackStore, type RecoveryOutcome } from './store'
import { ProviderRegistry } from './providers/registry'
import type { Track } from '../catalog/types'
import type { AudioProvider, Playable } from './providers/types'
import type { ResolveOptions, ResolveResult } from './resolver'
import { playbackCommands } from './commands'
import { createSleepTimerStore } from '../timers/sleep/store'

beforeEach(() => {
  window.localStorage.setItem('hoyomix-player-shuffle-v1', 'false')
  // jsdom has no native loader. Resource release is observed separately below;
  // real decoding, seek and media events remain the browser suite's responsibility.
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'mediaSession')
})

function storeStub(): PlaybackStore {
  const track: Track = {
    id: 'embers-release', title: 'Embers', aliases: {}, games: ['hsr'], relationIds: [],
    tabs: ['focus'], workGroupId: 'stellar-moments', vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'r2', externalId: 'embers.ogg' }, { provider: 'youtube', externalId: 'abcdefghijk' }],
  }
  const volumeStore = createPlaybackStore({ storage: { getItem: () => '0.5', setItem: () => {} } })
  const volume = volumeStore.volume
  return {
    shuffle: ref(false), repeatMode: ref('off'), setShuffle: vi.fn(), cycleRepeatMode: vi.fn(), setRepeatMode: vi.fn(),
    replaceQueueSource: vi.fn(), advanceAfterEnded: vi.fn(async () => {}),
    tryAdvancePreparedAfterEnded: vi.fn(() => false),
    preparedNext: ref(null), preloadHandoff: ref(null), preloadPolicy: ref('none'),
    activeProviderId: ref('youtube'), currentTrack: ref(track), queue: ref([track]), currentIndex: ref(0),
    enabledProviderIds: ref(['youtube']), automaticProviderIds: ref(['youtube']), manualProviderIds: ref(['youtube']), playbackIntent: ref('playing'), playbackGeneration: ref(1),
    attempts: ref([]), latestAttempts: ref([]), sourceOverride: ref(undefined), status: ref('playing'), volume, playable: ref(null),
    pendingResumePosition: ref(undefined), listeningSessionId: ref(1),
    enqueue: vi.fn(), removeQueueIndex: vi.fn(() => false), moveQueueItem: vi.fn(() => false),
    playNext: vi.fn(), clearUpcomingQueue: vi.fn(), reconcileUpcomingQueue: vi.fn(), refreshQueuedTracks: vi.fn(),
    setPreloadPolicy: vi.fn(), invalidatePreload: vi.fn(), rejectNextPreparation: vi.fn(), releasePreloadHandoff: vi.fn(), dispose: vi.fn(),
    armNextPreparation: vi.fn(async () => {}),
    prepareTransition: vi.fn(async () => {}), canHandoffPreparation: vi.fn(() => false), rejectPreparation: vi.fn(), nextPreparationIndex: ref(-1),
    transitionMode: ref('off'), crossfadeDuration: ref(5), setTransitionMode: vi.fn(), setCrossfadeDuration: vi.fn(),
    playNow: vi.fn(async () => {}), prepareQueueIndex: vi.fn(async () => {}), playQueueIndex: vi.fn(async () => {}),
    next: vi.fn(async () => {}), pause: vi.fn(), play: vi.fn(), previous: vi.fn(async () => {}), stop: vi.fn(),
    reportMediaState: vi.fn(), reportPlaybackFailure: vi.fn(async (): Promise<FailureOutcome> => 'stale'), renewMedia: vi.fn(async () => false),
    requestJellyfinFallback: vi.fn(async () => false),
    requestJellyfinRecovery: vi.fn(async (): Promise<RecoveryOutcome> => 'stale'),
    registrySnapshot: () => ({ registry: new ProviderRegistry([]), failedProviderIds: [] }),
    reportProgress: vi.fn(), awaitingStart: ref(undefined), recoverHandover: vi.fn(async () => false),
    consumePendingResumePosition: vi.fn(() => undefined),
    setSourceOverride: vi.fn(async () => {}), setVolume: vi.fn(volumeStore.setVolume),
    playbackNotices: ref([]), dismissNotice: vi.fn(), addPlaybackNotice: vi.fn(), recentFailures: ref([]),
  }
}

function audioStoreStub(): PlaybackStore {
  const store = storeStub()
  store.activeProviderId = ref('r2')
  store.playbackIntent = ref('paused')
  store.playable = ref({ kind: 'audio', url: 'https://media.invalid/custom.ogg', mimeType: 'audio/ogg' })
  return store
}

function setDuration(media: HTMLAudioElement, value: number): void {
  Object.defineProperty(media, 'duration', { configurable: true, value })
  Object.defineProperty(media, 'seekable', { configurable: true, value: {
    length: Number.isFinite(value) && value > 0 ? 1 : 0,
    start: () => 0, end: () => value,
  } })
}

function setBuffered(media: HTMLAudioElement, ranges: [number, number][]): void {
  const timeRanges: TimeRanges = {
    length: ranges.length,
    start(index: number) {
      if (index < 0 || index >= ranges.length) throw new DOMException('IndexSizeError')
      return ranges[index]![0]
    },
    end(index: number) {
      if (index < 0 || index >= ranges.length) throw new DOMException('IndexSizeError')
      return ranges[index]![1]
    },
  }
  Object.defineProperty(media, 'buffered', {
    configurable: true,
    get: () => timeRanges,
  })
}

function stalledVkeysStore(providerId: 'lx' | 'vkeys' = 'vkeys') {
  const track: Track = { ...audioStoreStub().currentTrack.value!, sources: [
    { provider: providerId, externalId: providerId }, { provider: 'gd-studio', externalId: 'gd' },
  ] }
  let version = 0
  const vkeys = vi.fn(async () => ({ kind: 'audio' as const, url: '/vkeys-' + ++version + '.mp3', mimeType: 'audio/mpeg' }))
  const gd = vi.fn(async () => ({ kind: 'audio' as const, url: '/gd.mp3', mimeType: 'audio/mpeg' }))
  const registry = new ProviderRegistry([
    { provider: { id: providerId, resolve: vkeys }, enabled: true, priority: 1, timeoutMs: 100 },
    { provider: { id: 'gd-studio', resolve: gd }, enabled: true, priority: 2, timeoutMs: 100 },
  ])
  return { track, vkeys, gd, store: createPlaybackStore({ registry }) }
}

describe('PlayerBar', () => {
  function recoveryStore(jellyfinEnabled = true, automaticEligible = true) {
    const track: Track = { ...audioStoreStub().currentTrack.value!, sources: [
      { provider: 'lx', externalId: 'lx' }, { provider: 'jellyfin', externalId: 'own' },
    ] }
    const registry = new ProviderRegistry([
      { provider: { id: 'lx', resolve: async () => ({ kind: 'audio', url: '/lx.mp3', mimeType: 'audio/mpeg' }) }, enabled: true, priority: 1, timeoutMs: 100 },
      { provider: { id: 'jellyfin', resolve: async () => ({ kind: 'audio', url: '/own.mp3', mimeType: 'audio/mpeg' }) }, enabled: jellyfinEnabled, automaticEligible, priority: 2, timeoutMs: 100 },
    ])
    return { track, store: createPlaybackStore({ registry }) }
  }

  it.each(['player', 'compact'])('allows the %s control to pause while waiting for recovery seek', async (control) => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const { store, track } = recoveryStore()
    await store.playNow(track)
    await store.requestJellyfinFallback('lx', store.playbackGeneration.value, 42)
    const wrapper = mount(PlayerBar, { props: { store } })
    const compact = mount(CompactPlayback, { props: { store } })
    try {
      expect(store.status.value).toBe('ready')
      const button = control === 'compact' ? compact.get('[data-compact-play]') : wrapper.get('[data-player-play]')
      expect(button.attributes('aria-label')).toBe('Pause')
      await button.trigger('click')
      expect(store.playbackIntent.value).toBe('paused')
    } finally { compact.unmount(); wrapper.unmount(); store.dispose() }
  })

  it.each(['system', 'timer'])('cancels the recovery seek timeout on %s pause', async (command) => {
    vi.useFakeTimers()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const actions = new Map<string, (() => void) | null>()
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: {
      metadata: null, playbackState: 'none', setPositionState: vi.fn(),
      setActionHandler: (action: string, handler: (() => void) | null) => actions.set(action, handler),
    } })
    const { store, track } = recoveryStore()
    await store.playNow(track)
    await store.requestJellyfinFallback('lx', store.playbackGeneration.value, 42)
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      playbackCommands.play()
      await flushPromises()
      if (command === 'timer') playbackCommands.pauseForInterruption()
      else actions.get('pause')!()
      expect(store.playbackIntent.value).toBe('paused')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(store.status.value).toBe('ready')
      expect(store.pendingResumePosition.value).toBe(42)
    } finally { wrapper.unmount(); store.dispose() }
  })

  it('cancels the pending recovery seek deadline on native pause and rearms only on explicit Play', async () => {
    vi.useFakeTimers()
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const { store, track } = recoveryStore()
    await store.playNow(track)
    await store.requestJellyfinFallback('lx', store.playbackGeneration.value, 42)
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      playbackCommands.play()
      await flushPromises()
      const playCount = mediaPlay.mock.calls.length
      await wrapper.get('[data-audio-role="active"]').trigger('pause')
      expect(store.playbackIntent.value).toBe('playing')
      expect(store.status.value).toBe('paused')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(store.status.value).toBe('paused')
      expect(store.pendingResumePosition.value).toBe(42)
      expect(mediaPlay).toHaveBeenCalledTimes(playCount)
      expect(store.activeProviderId.value).toBe('jellyfin')
      const generation = store.playbackGeneration.value
      playbackCommands.play()
      await vi.advanceTimersByTimeAsync(10_000)
      // The rearmed deadline reports the Jellyfin seek failure; the store continues the chain at
      // the saved position through LX (tasks 8.3/8.4, Property 25) instead of halting in `error`.
      expect(store.playbackGeneration.value).toBeGreaterThan(generation)
      expect(store.currentTrack.value).toBe(track)
      expect(store.activeProviderId.value).toBe('lx')
      expect(store.pendingResumePosition.value).toBe(42)
      expect(store.status.value).toBe('ready')
    } finally { wrapper.unmount(); store.dispose() }
  })

  it.each(['disabled', 'manual-only'])('reports a native error normally when mapped Jellyfin is %s', async (policy) => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const { store, track } = recoveryStore(policy !== 'disabled', policy !== 'manual-only')
    await store.playNow(track)
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      // The first error renews the same provider's URL (an expired ticket is not a failure).
      const generation = store.playbackGeneration.value
      await wrapper.get('[data-audio-role="active"]').trigger('error')
      await flushPromises()
      expect(store.activeProviderId.value).toBe('lx')
      expect(store.playbackGeneration.value).toBe(generation + 1)
      expect(store.attempts.value.some(attempt => attempt.providerId === 'lx' && !attempt.ok)).toBe(false)
      // A second error before any playback progress is a real failure.
      await wrapper.get('[data-audio-role="active"]').trigger('error')
      await flushPromises()
      expect(store.status.value).toBe('error')
      expect(store.attempts.value.some(attempt => attempt.providerId === 'lx' && !attempt.ok)).toBe(true)
    } finally { wrapper.unmount(); store.dispose() }
  })

  it.each(['lx', 'vkeys'] as const)('recovers a hung %s stream after explicit Play following an OS native pause', async providerId => {
    vi.useFakeTimers()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => new Promise<void>(() => {}))
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const { store, track, vkeys, gd } = stalledVkeysStore(providerId)
    await store.playNow(track)
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      await wrapper.get('[data-audio-role="active"]').trigger('pause')
      expect(store.status.value).toBe('paused')
      await vi.advanceTimersByTimeAsync(9_000)
      expect(store.activeProviderId.value).toBe(providerId)
      expect(vkeys).toHaveBeenCalledTimes(1)
      const generation = store.playbackGeneration.value
      await wrapper.get('[data-player-play]').trigger('click')
      await vi.advanceTimersByTimeAsync(7_000)
      await flushPromises()
      expect(store.activeProviderId.value).toBe(providerId)
      expect(vkeys).toHaveBeenCalledTimes(2)
      expect(store.playbackGeneration.value).toBe(generation + 1)
      expect(gd).not.toHaveBeenCalled()
    } finally { wrapper.unmount(); store.dispose() }
  })

  it.each(['user', 'native'])('does not replay a late buffered Repeat One ended event after %s pause', async (pauseOwner) => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const { store, track } = recoveryStore()
    await store.playNow(track)
    store.setRepeatMode('one')
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      const media = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
      setDuration(media.element, 60)
      setBuffered(media.element, [[0, 60]])
      media.element.currentTime = 60
      const session = store.listeningSessionId.value
      if (pauseOwner === 'user') playbackCommands.pause()
      else await media.trigger('pause')
      const playCount = play.mock.calls.length
      await media.trigger('ended')
      await flushPromises()
      expect(play).toHaveBeenCalledTimes(playCount)
      expect(store.listeningSessionId.value).toBe(session)
      expect(store.playbackIntent.value).toBe(pauseOwner === 'user' ? 'paused' : 'playing')
      playbackCommands.play()
      await flushPromises()
      expect(store.listeningSessionId.value).toBe(session + 1)
      expect(play).toHaveBeenCalledTimes(playCount + 1)
    } finally { wrapper.unmount(); store.dispose() }
  })

  it('repeats naturally completed buffered audio after its native ended pause', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const { store, track } = recoveryStore()
    await store.playNow(track)
    store.setRepeatMode('one')
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      const media = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
      setDuration(media.element, 60)
      setBuffered(media.element, [[0, 60]])
      media.element.currentTime = 60
      Object.defineProperty(media.element, 'ended', { configurable: true, value: true })
      const session = store.listeningSessionId.value
      const playCount = play.mock.calls.length
      await media.trigger('pause')
      await media.trigger('ended')
      await flushPromises()
      expect(play).toHaveBeenCalledTimes(playCount + 1)
      expect(store.listeningSessionId.value).toBe(session + 1)
      expect(media.element.currentTime).toBe(0)
    } finally { wrapper.unmount(); store.dispose() }
  })

  it('starts a new listening session for fully buffered Repeat One without replacing the deck or resolving again', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const resolve = vi.fn(async () => ({ ok: true as const, providerId: 'lx', attempts: [],
      playable: { kind: 'audio' as const, url: '/buffered-repeat.mp3', mimeType: 'audio/mpeg' },
    }))
    const store = createPlaybackStore({ resolve })
    await store.playNow(audioStoreStub().currentTrack.value!)
    store.setRepeatMode('one')
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      const media = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
      const session = store.listeningSessionId.value
      const generation = store.playbackGeneration.value
      const resolveCount = resolve.mock.calls.length
      const source = media.attributes('src')
      setDuration(media.element, 60)
      setBuffered(media.element, [[0, 60]])
      media.element.currentTime = 60
      await media.trigger('ended')
      await flushPromises()
      expect(store.listeningSessionId.value).toBe(session + 1)
      expect(store.playbackIntent.value).toBe('playing')
      expect(store.playbackGeneration.value).toBe(generation)
      expect(wrapper.get('[data-audio-role="active"]').element).toBe(media.element)
      expect(media.attributes('src')).toBe(source)
      expect(media.element.currentTime).toBe(0)
      expect(resolve).toHaveBeenCalledTimes(resolveCount)
    } finally { wrapper.unmount(); store.dispose() }
  })

  it('finishes the listening intent at the end of the last track without requesting recovery', async () => {
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const mediaPause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const mapped = { ...audioStoreStub().currentTrack.value!, sources: [{ provider: 'r2', externalId: 'last.ogg' }] }
    const store = createPlaybackStore({ resolve: async () => ({ ok: true, providerId: 'r2', attempts: [], playable: { kind: 'audio', url: '/last.ogg', mimeType: 'audio/ogg' } }) })
    await store.playNow(mapped)
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      await wrapper.get('[data-audio-role="active"]').trigger('ended')
      expect(store.status.value).toBe('ended')
      expect(store.playbackIntent.value).toBe('paused')
    } finally { wrapper.unmount(); store.dispose(); mediaPlay.mockRestore(); mediaPause.mockRestore() }
  })
  it('does not restart recovery when stalled arrives after an OS native pause', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const store = audioStoreStub()
    store.requestSourceRecovery = vi.fn(async (): Promise<RecoveryOutcome> => 'stale')
    store.activeProviderId = ref('vkeys')
    store.enabledProviderIds = ref(['vkeys', 'gd-studio'])
    store.automaticProviderIds = ref(['vkeys', 'gd-studio'])
    store.playbackIntent = ref('playing')
    store.currentTrack = ref({ ...store.currentTrack.value!, sources: [{ provider: 'vkeys', externalId: 'vkeys' }, { provider: 'gd-studio', externalId: 'own' }] })
    const registry = new ProviderRegistry([
      { provider: { id: 'vkeys', resolve: async () => ({ kind: 'audio', url: '/lx.mp3', mimeType: 'audio/mpeg' }) }, enabled: true, priority: 1, timeoutMs: 100 },
      { provider: { id: 'gd-studio', resolve: async () => ({ kind: 'audio', url: '/own.mp3', mimeType: 'audio/mpeg' }) }, enabled: true, priority: 2, timeoutMs: 100 },
    ])
    store.registrySnapshot = () => ({ registry, failedProviderIds: [] })
    const wrapper = mount(PlayerBar, { props: { store } })
    const media = wrapper.get('[data-audio-role="active"]')
    await media.trigger('pause')
    await media.trigger('stalled')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.requestSourceRecovery).not.toHaveBeenCalled()
    wrapper.unmount()
  })
  it('tolerates browsers that reject individual system media actions and position state', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const actions = new Map<string, ((details: MediaSessionActionDetails) => void) | null>()
    const session = {
      metadata: null, playbackState: 'none',
      setActionHandler: vi.fn((action, handler) => {
        if (action === 'seekto') throw new DOMException('Unsupported action', 'NotSupportedError')
        actions.set(action, handler)
      }),
      setPositionState: vi.fn(() => { throw new DOMException('Unsupported position', 'NotSupportedError') }),
    }
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    const compact = mount(CompactPlayback, { props: { store } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 180)
    media.element.currentTime = 20
    await media.trigger('timeupdate')
    await compact.get<HTMLInputElement>('[data-compact-seek]').setValue('45')
    expect(media.element.currentTime).toBe(45)
    actions.get('pause')!({ action: 'pause' })
    expect(store.pause).toHaveBeenCalledOnce()
    expect(compact.get('[data-compact-elapsed]').text()).toBe('0:45')
    wrapper.unmount()
    compact.unmount()
  })

  it('freezes system progress when buffering and updates artwork without resolving a second player', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const session = { metadata: null, playbackState: 'none', setActionHandler: vi.fn(), setPositionState: vi.fn() }
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
    const store = audioStoreStub()
    store.playable = ref({ kind: 'audio', url: 'https://media.invalid/track.ogg', mimeType: 'audio/ogg', metadata: { artworkUrl: 'https://media.invalid/cover.jpg' } })
    const status = ref<PlaybackStore['status']['value']>('playing')
    store.status = status
    const wrapper = mount(PlayerBar, { props: { store } })
    const compact = mount(CompactPlayback, { props: { store } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 180)
    media.element.currentTime = 30
    await media.trigger('timeupdate')
    expect(session.playbackState).toBe('playing')
    expect(compact.get('img').attributes('src')).toBe('https://media.invalid/cover.jpg')
    status.value = 'buffering'
    await flushPromises()
    expect(session.playbackState).toBe('paused')
    expect(compact.get('[data-compact-elapsed]').text()).toBe('0:30')
    ;(store.playable as Ref<Playable | null>).value = null
    status.value = 'error'
    await flushPromises()
    expect(compact.get('[data-compact-elapsed]').text()).toBe('0:00')
    expect(compact.get('[data-compact-duration]').text()).toBe('--:--')
    expect(compact.get<HTMLInputElement>('[data-compact-seek]').element.disabled).toBe(true)
    expect(session.playbackState).toBe('none')
    expect(session.setPositionState).toHaveBeenLastCalledWith()
    compact.unmount()
  })
  it('does not apply an in-flight Control Centre drag to a replacement track', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    const compact = mount(CompactPlayback, { props: { store } })
    let media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 180)
    await media.trigger('loadedmetadata')
    await compact.get('[data-compact-seek]').trigger('pointerdown')
    ;(store.playbackGeneration as Ref<number>).value += 1
    ;(store.currentTrack as Ref<Track>).value = { ...store.currentTrack.value!, id: 'replacement' }
    await flushPromises()
    media = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    // Generation and track updates happen synchronously, possibly reusing the
    // same deck index and URL before Vue renders. Resource release must not leave
    // the replacement's src absent when the vnode still carries that same URL.
    expect(media.attributes('src')).toBe('https://media.invalid/custom.ogg')
    setDuration(media.element, 180)
    await media.trigger('loadedmetadata')
    await compact.get<HTMLInputElement>('[data-compact-seek]').setValue('70')
    expect(media.element.currentTime).toBe(0)
    await compact.get('[data-compact-seek]').trigger('pointerup')
    await compact.get('[data-compact-seek]').trigger('pointerdown')
    await compact.get<HTMLInputElement>('[data-compact-seek]').setValue('40')
    expect(media.element.currentTime).toBe(40)
    compact.unmount()
  })
  it('shares native progress and transport with a Control Centre view without reloading media on reopen', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    let compact = mount(CompactPlayback, { props: { store } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 180)
    media.element.currentTime = 42
    await media.trigger('timeupdate')
    expect(compact.get('[data-compact-elapsed]').text()).toBe('0:42')
    expect(compact.get('[data-compact-duration]').text()).toBe('3:00')
    expect(compact.find('audio').exists()).toBe(false)
    await compact.get<HTMLInputElement>('[data-compact-seek]').setValue('65')
    expect(media.element.currentTime).toBe(65)
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('1:05')
    await compact.get('[data-compact-next]').trigger('click')
    expect(store.next).toHaveBeenCalledOnce()
    await compact.get('[data-compact-previous]').trigger('click')
    expect(store.previous).toHaveBeenCalledOnce()
    compact.unmount()
    compact = mount(CompactPlayback, { props: { store } })
    expect(compact.get('[data-compact-elapsed]').text()).toBe('1:05')
    expect(wrapper.get('audio').element).toBe(media.element)
    expect(store.playNow).not.toHaveBeenCalled()
    compact.unmount()
  })

  it('connects system media actions to the same audio and clears unsupported position state', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const actions = new Map<string, ((details: MediaSessionActionDetails) => void) | null>()
    const session = {
      metadata: null, playbackState: 'none',
      setActionHandler: vi.fn((action, handler) => { actions.set(action, handler) }),
      setPositionState: vi.fn(),
    }
    Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 180)
    media.element.currentTime = 20
    await media.trigger('timeupdate')
    expect(actions.get('seekto')).toEqual(expect.any(Function))
    actions.get('seekto')!({ action: 'seekto', seekTime: 75 })
    await flushPromises()
    expect(media.element.currentTime).toBe(75)
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 180, playbackRate: 1, position: 75 })
    actions.get('nexttrack')!({ action: 'nexttrack' })
    expect(store.next).toHaveBeenCalledOnce()
    setDuration(media.element, Infinity)
    await media.trigger('durationchange')
    expect(session.setPositionState).toHaveBeenLastCalledWith()
    wrapper.unmount()
    expect(actions.get('seekto')).toBeNull()
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
    Reflect.deleteProperty(navigator, 'mediaSession')
  })

  it.each([['lx', 'manual'], ['vkeys', 'automatic'], ['vkeys', 'manual']] as const)('renews stalled %s at the same position before the %s failure path', async (providerId, mode) => {
    vi.useFakeTimers()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const fallbackTrack: Track = {
      id: 'same-track',
      title: 'Same track',
      aliases: {},
      games: ['hsr'],
      relationIds: [],
      tabs: ['focus'],
      workGroupId: 'wg',
      vocalStatus: 'instrumental',
      needsClassification: false,
      sources: [
        { provider: providerId, externalId: 'vkeys-same-track' },
        { provider: 'gd-studio', externalId: 'gd-same-track' },
      ],
    }
    const selectedProvider: AudioProvider = {
      id: providerId,
      resolve: vi.fn(async () => ({
        kind: 'audio' as const,
        url: 'https://media.invalid/vkeys-same-track.mp3',
        mimeType: 'audio/mpeg',
      })),
    }
    const gdProvider: AudioProvider = {
      id: 'gd-studio',
      resolve: vi.fn(async () => ({
        kind: 'audio' as const,
        url: 'https://media.invalid/gd-same-track.flac',
        mimeType: 'audio/flac',
      })),
    }
    const registry = new ProviderRegistry([
      { provider: selectedProvider, enabled: true, priority: 1, timeoutMs: 100 },
      { provider: gdProvider, enabled: true, priority: 2, timeoutMs: 100 },
    ])
    const store = createPlaybackStore({ registry })

    await store.playNow(fallbackTrack)
    if (mode === 'manual') await store.setSourceOverride(providerId)
    vi.mocked(selectedProvider.resolve).mockClear()
    vi.mocked(selectedProvider.resolve).mockResolvedValueOnce({ kind: 'audio', url: 'https://media.invalid/vkeys-fresh.mp3', mimeType: 'audio/mpeg' })
    const listeningSession = store.listeningSessionId.value
    const wrapper = mount(PlayerBar, { props: { store } })
    const media = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    setDuration(media.element, 240)
    media.element.currentTime = 102
    await media.trigger('timeupdate')
    await media.trigger('waiting')

    await vi.advanceTimersByTimeAsync(9_000)
    await flushPromises()

    expect(selectedProvider.resolve).toHaveBeenCalledTimes(1)
    expect(gdProvider.resolve).not.toHaveBeenCalled()
    expect(store.sourceOverride.value).toBe(mode === 'manual' ? providerId : undefined)
    expect(store.activeProviderId.value).toBe(providerId)
    expect(store.playable.value).toEqual({
      kind: 'audio',
      url: 'https://media.invalid/vkeys-fresh.mp3',
      mimeType: 'audio/mpeg',
    })
    expect(store.currentTrack.value).toBe(fallbackTrack)
    expect(store.listeningSessionId.value).toBe(listeningSession)

    const replacement = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.instances).not.toContain(replacement.element)
    setDuration(replacement.element, 240)
    await replacement.trigger('loadedmetadata')
    expect(replacement.element.currentTime).toBe(102)
    Object.defineProperty(replacement.element, 'seeking', { configurable: true, value: true })
    await replacement.trigger('seeking')
    expect(store.pendingResumePosition.value).toBe(102)
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.instances).not.toContain(replacement.element)
    Object.defineProperty(replacement.element, 'seeking', { configurable: true, value: false })
    await replacement.trigger('seeked')
    await flushPromises()
    expect(store.consumePendingResumePosition()).toBeUndefined()
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.instances).toContain(replacement.element)

    // A reload/playing event alone is not progress and cannot buy another renewal at 102 s.
    await replacement.trigger('playing')
    await replacement.trigger('waiting')
    vi.setSystemTime(Date.now() + 60_000)
    await vi.advanceTimersByTimeAsync(9_000)
    await flushPromises()
    expect(selectedProvider.resolve).toHaveBeenCalledTimes(1)
    expect(store.sourceOverride.value).toBe(mode === 'manual' ? providerId : undefined)
    expect(store.currentTrack.value).toBe(fallbackTrack)
    expect(store.listeningSessionId.value).toBe(listeningSession)
    expect(store.pendingResumePosition.value).toBe(102)
    if (mode === 'automatic') {
      expect(gdProvider.resolve).toHaveBeenCalledTimes(1)
      expect(store.activeProviderId.value).toBe('gd-studio')
    } else {
      expect(gdProvider.resolve).not.toHaveBeenCalled()
      expect(store.status.value).toBe('error')
    }

    const nextTrack: Track = { ...fallbackTrack, id: 'next-track', title: 'Next track' }
    store.enqueue(nextTrack)
    await wrapper.get('[data-player-next]').trigger('click')
    await flushPromises()
    expect(store.currentTrack.value?.id).toBe('next-track')
    wrapper.unmount()
    store.dispose()
    vi.useRealTimers()
  })

  it('does not recover through another source after an explicit user pause', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const track: Track = {
      id: 'paused-track',
      title: 'Paused track',
      aliases: {},
      games: ['hsr'],
      relationIds: [],
      tabs: ['focus'],
      workGroupId: 'wg',
      vocalStatus: 'instrumental',
      needsClassification: false,
      sources: [
        { provider: 'vkeys', externalId: 'vkeys-paused-track' },
        { provider: 'gd-studio', externalId: 'gd-paused-track' },
      ],
    }
    const gdProvider: AudioProvider = {
      id: 'gd-studio',
      resolve: vi.fn(async () => ({
        kind: 'audio' as const,
        url: 'https://media.invalid/gd-paused-track.flac',
        mimeType: 'audio/flac',
      })),
    }
    const vkeysProvider: AudioProvider = {
      id: 'vkeys',
      resolve: vi.fn(async () => ({
        kind: 'audio' as const,
        url: 'https://media.invalid/vkeys-paused-track.mp3',
        mimeType: 'audio/mpeg',
      })),
    }
    const registry = new ProviderRegistry([
      { provider: vkeysProvider, enabled: true, priority: 1, timeoutMs: 100 },
      { provider: gdProvider, enabled: true, priority: 2, timeoutMs: 100 },
    ])
    const store = createPlaybackStore({ registry })
    await store.playNow(track)
    await store.setSourceOverride('vkeys')
    vi.mocked(gdProvider.resolve).mockClear()

    const wrapper = mount(PlayerBar, { props: { store } })
    const media = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    setDuration(media.element, 180)
    media.element.currentTime = 42
    await media.trigger('timeupdate')
    await media.trigger('playing')
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-player-play]').trigger('click')
    await media.trigger('waiting')
    await vi.advanceTimersByTimeAsync(9_000)
    await flushPromises()

    expect(store.playbackIntent.value).toBe('paused')
    expect(store.status.value).toBe('buffering')
    expect(gdProvider.resolve).not.toHaveBeenCalled()
    expect(store.activeProviderId.value).toBe('vkeys')
    wrapper.unmount()
    store.dispose()
    vi.useRealTimers()
  })
  it('publishes native seek availability rather than assuming every known duration can seek', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const wrapper = mount(PlayerBar, { props: { store: audioStoreStub() } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 120)
    Object.defineProperty(media.element, 'seekable', { configurable: true, value: { length: 0 } })
    await media.trigger('loadedmetadata')
    expect(wrapper.get<HTMLInputElement>('[data-player-seek]').element.disabled).toBe(true)
    expect(wrapper.get('[data-player-duration]').text()).toBe('2:00')
  })
  it('renders one compact player surface without duplicating full source controls', () => {
    const store = storeStub()
    const wrapper = mount(PlayerBar, { props: { store, compact: true } })

    expect(wrapper.get('[data-player-compact]').element).toBeTruthy()
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.findAll('.player-bar')).toHaveLength(1)
  })

  it('starts compact and expands without unmounting the active media element', async () => {
    const store = storeStub()
    store.playable = ref({ kind: 'audio', url: 'https://media.invalid/collapse.ogg', mimeType: 'audio/ogg' }) as never
    const wrapper = mount(PlayerBar, { props: { store, compact: true } })
    const toggle = wrapper.get('[data-player-collapse]')
    const media = wrapper.get('audio').element

    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('[data-player-canonical-title]').text()).toBe('Embers')
    expect(wrapper.get('[data-player-quality]').text()).toBe('Standard')
    expect(wrapper.get('[data-player-play]').isVisible()).toBe(true)
    expect(wrapper.get('[data-player-next]').isVisible()).toBe(true)
    expect(wrapper.get<HTMLElement>('.player-bar__secondary').element.style.display).toBe('none')
    await toggle.trigger('click')

    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('audio').element).toBe(media)
    expect(wrapper.get('[data-player-previous]').isVisible()).toBe(true)
    expect(wrapper.get('[data-player-seek]').isVisible()).toBe(true)
    expect(wrapper.get<HTMLElement>('.player-bar__secondary').element.style.display).toBe('')
    expect(wrapper.get<HTMLElement>('.player-bar__status').attributes('role')).toBe('status')

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.get('audio').element).toBe(media)
  })

  it('keeps compact now-playing identity and the standalone Queue command visibly reachable', async () => {
    const wrapper = mount(PlayerBar, { props: { store: storeStub(), compact: true } })

    expect(wrapper.get('[data-player-artwork-fallback]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-player-canonical-title]').text()).toBe('Embers')
    expect(wrapper.get('[data-player-release-provider]').text()).toBe('Standard')
    expect(wrapper.get('[data-player-release-provider]').text()).not.toContain('YouTube')
    expect(wrapper.get('[data-player-release-provider]').text()).not.toContain('embers-release')

    const queue = wrapper.get('[data-player-toggle-queue]')
    expect(queue.text()).toContain('Queue')
    expect(queue.get('[data-player-queue-count]').text()).toBe('0')
    expect(queue.attributes('aria-controls')).toBe('workspace-queue-drawer')
    expect(queue.attributes('aria-expanded')).toBe('false')
    await queue.trigger('click')
    expect(wrapper.emitted('toggle-queue')).toHaveLength(1)
    expect(wrapper.emitted('open-library')).toBeUndefined()
    expect(wrapper.find('[data-player-open-library]').exists()).toBe(false)
  })

  it('pauses and inerts the same official YouTube instance, then resumes the original playing intent', async () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    const status = ref<'playing' | 'paused'>('playing')
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.status = status as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    store.reportMediaState = vi.fn((state) => {
      if (state === 'playing' || state === 'paused') status.value = state
    })
    const youtubePause = vi.fn()
    const youtubePlay = vi.fn()
    let mounts = 0
    let unmounts = 0
    const StatefulYouTube = defineComponent({
      emits: ['state'],
      setup(_props, { emit, expose }) {
        mounts += 1
        const instance = mounts
        onBeforeUnmount(() => { unmounts += 1 })
        expose({
          pause: () => { youtubePause(); emit('state', 2) },
          play: () => { youtubePlay(); emit('state', 1) },
          setVolume: vi.fn(),
        })
        return () => h('div', { 'data-youtube-instance': instance })
      },
    })
    const wrapper = mount(PlayerBar, {
      props: { store, compact: true, mediaSuspended: false },
      global: { stubs: { YouTubePlayer: StatefulYouTube } },
    })
    const officialInstance = wrapper.get('[data-youtube-instance]').element

    await wrapper.setProps({ mediaSuspended: true })
    expect(wrapper.attributes('data-media-suspended')).toBe('true')
    expect(wrapper.attributes('inert')).toBe('true')
    expect(wrapper.attributes('aria-hidden')).toBe('true')
    expect(wrapper.get('[data-youtube-instance]').element).toBe(officialInstance)
    expect(intent.value).toBe('paused')
    expect(status.value).toBe('paused')
    expect(store.pause).toHaveBeenCalledOnce()
    expect(youtubePause).toHaveBeenCalledOnce()
    expect(mounts).toBe(1)
    expect(unmounts).toBe(0)

    await wrapper.setProps({ mediaSuspended: true })
    expect(store.pause).toHaveBeenCalledOnce()
    expect(youtubePause).toHaveBeenCalledOnce()

    await wrapper.setProps({ mediaSuspended: false })

    expect(wrapper.attributes('data-media-suspended')).toBe('false')
    expect(wrapper.attributes('inert')).toBeUndefined()
    expect(wrapper.attributes('aria-hidden')).toBeUndefined()
    expect(wrapper.get('[data-youtube-instance]').element).toBe(officialInstance)
    expect(intent.value).toBe('playing')
    expect(status.value).toBe('playing')
    expect(store.play).toHaveBeenCalledOnce()
    expect(youtubePlay).toHaveBeenCalledOnce()
    expect(mounts).toBe(1)
    expect(unmounts).toBe(0)

    await wrapper.setProps({ mediaSuspended: false })
    expect(store.play).toHaveBeenCalledOnce()
    expect(youtubePlay).toHaveBeenCalledOnce()
  })

  it('keeps an originally paused official player paused after a suspend/resume cycle', async () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('paused')
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    const youtubePause = vi.fn()
    const youtubePlay = vi.fn()
    const StatefulYouTube = defineComponent({
      setup(_props, { expose }) {
        expose({ pause: youtubePause, play: youtubePlay, setVolume: vi.fn() })
        return () => h('div', { 'data-youtube-instance': 'paused' })
      },
    })
    const wrapper = mount(PlayerBar, {
      props: { store, compact: true },
      global: { stubs: { YouTubePlayer: StatefulYouTube } },
    })

    await wrapper.setProps({ mediaSuspended: true })
    await wrapper.setProps({ mediaSuspended: false })

    expect(store.pause).toHaveBeenCalledOnce()
    expect(youtubePause).toHaveBeenCalledOnce()
    expect(store.play).not.toHaveBeenCalled()
    expect(youtubePlay).not.toHaveBeenCalled()
    expect(intent.value).toBe('paused')
    expect(playbackCommands.pauseForInterruption()).toBeUndefined()
    wrapper.unmount()
  })

  it('enforces suspension when YouTube resolves after the sheet opens and resumes once after close', async () => {
    const store = storeStub()
    const playable = ref<null | { kind: 'youtube'; videoId: string }>(null)
    const intent = ref<'playing' | 'paused'>('playing')
    const status = ref<'resolving' | 'paused'>('resolving')
    store.playable = playable as never
    store.playbackIntent = intent as never
    store.status = status as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    store.reportMediaState = vi.fn((state) => {
      if (state === 'paused') status.value = 'paused'
    })
    const youtubePause = vi.fn()
    const youtubePlay = vi.fn()
    const LateYouTube = defineComponent({
      emits: ['ready'],
      setup(_props, { emit, expose }) {
        expose({ pause: youtubePause, play: youtubePlay, setVolume: vi.fn() })
        return () => h('button', { 'data-late-ready': '', onClick: () => emit('ready') })
      },
    })
    const wrapper = mount(PlayerBar, {
      props: { store, compact: true, mediaSuspended: true },
      global: { stubs: { YouTubePlayer: LateYouTube } },
    })

    playable.value = { kind: 'youtube', videoId: 'abcdefghijk' }
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-late-ready]').trigger('click')

    expect(intent.value).toBe('paused')
    expect(status.value).toBe('paused')
    expect(store.pause).toHaveBeenCalledOnce()
    expect(youtubePause).toHaveBeenCalledOnce()
    expect(store.play).not.toHaveBeenCalled()
    expect(youtubePlay).not.toHaveBeenCalled()

    await wrapper.setProps({ mediaSuspended: false })

    expect(store.play).toHaveBeenCalledOnce()
    expect(youtubePlay).toHaveBeenCalledOnce()
  })

  it('defers the real playback command while suspended and resumes it once after close', async () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('paused')
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    const youtubePause = vi.fn()
    const youtubePlay = vi.fn()
    const StatefulYouTube = defineComponent({
      emits: ['ready'],
      setup(_props, { emit, expose }) {
        expose({ pause: youtubePause, play: youtubePlay, setVolume: vi.fn() })
        return () => h('button', { 'data-command-youtube': '', onClick: () => emit('ready') })
      },
    })
    const wrapper = mount(PlayerBar, {
      props: { store, compact: true },
      global: { stubs: { YouTubePlayer: StatefulYouTube } },
    })
    await wrapper.setProps({ mediaSuspended: true })
    vi.mocked(store.play).mockClear()
    youtubePlay.mockClear()

    playbackCommands.play()
    await wrapper.vm.$nextTick()

    expect(store.play).not.toHaveBeenCalled()
    expect(youtubePlay).not.toHaveBeenCalled()
    expect(intent.value).toBe('paused')

    ;(store.playable as Ref<{ kind: 'youtube'; videoId: string } | null>).value = null
    await wrapper.vm.$nextTick()
    await wrapper.setProps({ mediaSuspended: false })

    expect(store.play).not.toHaveBeenCalled()
    expect(youtubePlay).not.toHaveBeenCalled()

    ;(store.playable as Ref<{ kind: 'youtube'; videoId: string } | null>).value = { kind: 'youtube', videoId: 'abcdefghijk' }
    await wrapper.vm.$nextTick()
    await wrapper.get('[data-command-youtube]').trigger('click')

    expect(store.play).toHaveBeenCalledOnce()
    expect(youtubePlay).toHaveBeenCalledOnce()
    await wrapper.setProps({ mediaSuspended: false })
    expect(store.play).toHaveBeenCalledOnce()
    expect(youtubePlay).toHaveBeenCalledOnce()
  })

  it('transfers a sheet-deferred playing intent to a timer lease and resumes only after focus returns', async () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.playbackGeneration = ref(7) as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    const youtubePause = vi.fn()
    const youtubePlay = vi.fn()
    const StatefulYouTube = defineComponent({
      setup(_props, { expose }) {
        expose({ pause: youtubePause, play: youtubePlay, setVolume: vi.fn() })
        return () => h('div', { 'data-lease-youtube': '' })
      },
    })
    const wrapper = mount(PlayerBar, {
      props: { store, compact: true },
      global: { stubs: { YouTubePlayer: StatefulYouTube } },
    })

    await wrapper.setProps({ mediaSuspended: true })
    const lease = playbackCommands.pauseForInterruption()
    await wrapper.setProps({ mediaSuspended: false })

    expect(store.play).not.toHaveBeenCalled()
    expect(youtubePlay).not.toHaveBeenCalled()

    lease?.resumeIfStillOwned()
    expect(store.play).toHaveBeenCalledOnce()
    expect(youtubePlay).toHaveBeenCalledOnce()

    lease?.resumeIfStillOwned()
    expect(store.play).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('returns a valid timer lease to sheet-deferred resume when focus returns before the sheet closes', async () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.playbackGeneration = ref(71) as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    const youtubePlay = vi.fn()
    const StatefulYouTube = defineComponent({
      setup(_props, { expose }) {
        expose({ pause: vi.fn(), play: youtubePlay, setVolume: vi.fn() })
        return () => h('div')
      },
    })
    const wrapper = mount(PlayerBar, {
      props: { store, mediaSuspended: true },
      global: { stubs: { YouTubePlayer: StatefulYouTube } },
    })

    const lease = playbackCommands.pauseForInterruption()
    lease?.resumeIfStillOwned()
    expect(store.play).not.toHaveBeenCalled()

    await wrapper.setProps({ mediaSuspended: false })
    expect(store.play).toHaveBeenCalledOnce()
    expect(youtubePlay).toHaveBeenCalledOnce()

    await wrapper.setProps({ mediaSuspended: false })
    expect(store.play).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('does not resume a timer-deferred lease after its playback generation changes behind an open sheet', async () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    const generation = ref(73)
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.playbackGeneration = generation as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    const wrapper = mount(PlayerBar, {
      props: { store, mediaSuspended: true },
      global: { stubs: { YouTubePlayer: {
        template: '<div />',
        methods: { pause() {}, play() {}, setVolume() {} },
      } } },
    })

    const lease = playbackCommands.pauseForInterruption()
    lease?.resumeIfStillOwned()
    generation.value += 1
    await wrapper.setProps({ mediaSuspended: false })

    expect(store.play).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not resume a timer-deferred lease after another PlayerBar registration takes ownership', async () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.playbackGeneration = ref(74) as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    const youtubeStub = {
      template: '<div />',
      methods: { pause() {}, play() {}, setVolume() {} },
    }
    const wrapper = mount(PlayerBar, {
      props: { store, mediaSuspended: true },
      global: { stubs: { YouTubePlayer: youtubeStub } },
    })

    const lease = playbackCommands.pauseForInterruption()
    lease?.resumeIfStillOwned()
    const replacement = mount(PlayerBar, {
      props: { store: storeStub() },
      global: { stubs: { YouTubePlayer: youtubeStub } },
    })
    replacement.unmount()
    await wrapper.setProps({ mediaSuspended: false })

    expect(store.play).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not resume a timer-deferred missing playable after a new generation resolves', async () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    const generation = ref(75)
    const playable = ref<null | { kind: 'youtube'; videoId: string }>(null)
    store.playable = playable as never
    store.playbackIntent = intent as never
    store.playbackGeneration = generation as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    const wrapper = mount(PlayerBar, {
      props: { store },
      global: { stubs: { YouTubePlayer: {
        template: '<div />',
        methods: { pause() {}, play() {}, setVolume() {} },
      } } },
    })

    const lease = playbackCommands.pauseForInterruption()
    lease?.resumeIfStillOwned()
    generation.value += 1
    playable.value = { kind: 'youtube', videoId: 'abcdefghijk' }
    await wrapper.vm.$nextTick()

    expect(store.play).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('resumes one uninterrupted same-generation timer lease exactly once despite its own paused media state', () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.playbackGeneration = ref(72) as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    const youtubePlay = vi.fn()
    const TimerPausedYouTube = defineComponent({
      emits: ['state'],
      setup(_props, { emit, expose }) {
        expose({
          pause: () => emit('state', 2),
          play: youtubePlay,
          setVolume: vi.fn(),
        })
        return () => h('div')
      },
    })
    const wrapper = mount(PlayerBar, {
      props: { store },
      global: { stubs: { YouTubePlayer: TimerPausedYouTube } },
    })

    const lease = playbackCommands.pauseForInterruption()
    expect(store.reportMediaState).toHaveBeenCalledWith('paused', 72)

    lease?.resumeIfStillOwned()
    lease?.resumeIfStillOwned()

    expect(store.play).toHaveBeenCalledOnce()
    expect(youtubePlay).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it.each(['pause', 'stop'] as const)('invalidates a timer lease after user or external play then %s', async (finalCommand) => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.playbackGeneration = ref(8) as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    store.stop = vi.fn(() => { intent.value = 'paused' })
    const wrapper = mount(PlayerBar, {
      props: { store },
      global: { stubs: { YouTubePlayer: {
        template: '<div />',
        methods: { pause() {}, play() {}, setVolume() {} },
      } } },
    })

    const lease = playbackCommands.pauseForInterruption()
    if (finalCommand === 'pause') {
      await wrapper.vm.$nextTick()
      ;(store.status as Ref<PlaybackStore['status']['value']>).value = 'paused'
      await wrapper.vm.$nextTick()
      await wrapper.get('[aria-label="Play"]').trigger('click')
      await wrapper.vm.$nextTick()
      ;(store.status as Ref<PlaybackStore['status']['value']>).value = 'playing'
      await wrapper.vm.$nextTick()
      await wrapper.get('[aria-label="Pause"]').trigger('click')
    } else {
      playbackCommands.play()
      playbackCommands.stop()
    }
    lease?.resumeIfStillOwned()

    expect(store.play).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('invalidates a pending timer lease when the user plays then pauses through official media controls', async () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.playbackGeneration = ref(10) as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    store.reportMediaState = vi.fn((state) => {
      if (state === 'playing') intent.value = 'playing'
      if (state === 'paused') intent.value = 'paused'
    })
    const DirectControlsYouTube = defineComponent({
      emits: ['state'],
      setup(_props, { emit, expose }) {
        expose({ pause: vi.fn(), play: vi.fn(), setVolume: vi.fn() })
        return () => h('div', [
          h('button', { 'data-direct-play': '', onClick: () => emit('state', 1) }),
          h('button', { 'data-direct-pause': '', onClick: () => emit('state', 2) }),
        ])
      },
    })
    const wrapper = mount(PlayerBar, {
      props: { store },
      global: { stubs: { YouTubePlayer: DirectControlsYouTube } },
    })

    const lease = playbackCommands.pauseForInterruption()
    await wrapper.get('[data-direct-play]').trigger('click')
    await wrapper.get('[data-direct-pause]').trigger('click')
    lease?.resumeIfStillOwned()

    expect(store.reportMediaState).toHaveBeenCalledWith('playing', 10)
    expect(store.reportMediaState).toHaveBeenCalledWith('paused', 10)
    expect(store.play).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('invalidates a pending timer lease on native audio play intent before media reports playing', async () => {
    const mediaPause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    store.activeProviderId = ref('r2') as never
    store.playable = ref({ kind: 'audio', url: 'https://media.invalid/timer.ogg', mimeType: 'audio/ogg' }) as never
    store.playbackIntent = intent as never
    store.playbackGeneration = ref(11) as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    const wrapper = mount(PlayerBar, { props: { store } })

    const lease = playbackCommands.pauseForInterruption()
    await wrapper.get('audio').trigger('play')
    await wrapper.get('audio').trigger('pause')
    lease?.resumeIfStillOwned()

    expect(store.play).not.toHaveBeenCalled()
    expect(mediaPlay).not.toHaveBeenCalled()
    expect(store.reportMediaState).not.toHaveBeenCalledWith('playing', 11)
    expect(store.reportMediaState).toHaveBeenCalledWith('paused', 11)
    wrapper.unmount()
    mediaPause.mockRestore()
    mediaPlay.mockRestore()
  })

  it('invalidates a timer lease when playback moves to a new generation', async () => {
    const store = storeStub()
    const intent = ref<'playing' | 'paused'>('playing')
    const generation = ref(9)
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackIntent = intent as never
    store.playbackGeneration = generation as never
    store.pause = vi.fn(() => { intent.value = 'paused' })
    store.play = vi.fn(async () => { intent.value = 'playing' })
    const wrapper = mount(PlayerBar, {
      props: { store },
      global: { stubs: { YouTubePlayer: {
        template: '<div />',
        methods: { pause() {}, play() {}, setVolume() {} },
      } } },
    })

    const lease = playbackCommands.pauseForInterruption()
    generation.value += 1
    await wrapper.vm.$nextTick()
    lease?.resumeIfStillOwned()

    expect(store.play).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('offers keyboard playback controls without stealing input keystrokes', async () => {
    const store = storeStub()
    const wrapper = mount(PlayerBar, { props: { store } })

    await wrapper.trigger('keydown', { code: 'Space' })
    await wrapper.trigger('keydown', { code: 'ArrowRight' })
    await wrapper.trigger('keydown', { code: 'ArrowLeft' })

    expect(store.pause).toHaveBeenCalledOnce()
    expect(store.next).toHaveBeenCalledOnce()
    expect(store.previous).toHaveBeenCalledOnce()
  })

  it('does not handle Space or Arrow keys originating from interactive descendants', async () => {
    const store = storeStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    const button = wrapper.get('[aria-label="Pause"]')

    await button.trigger('keydown', { code: 'Space' })
    await button.trigger('keydown', { code: 'ArrowRight' })

    expect(store.pause).not.toHaveBeenCalled()
    expect(store.next).not.toHaveBeenCalled()
  })

  it('waits for the lead window before resolving a third-party URL, then promotes the same deck', async () => {
    const originalConnection = Object.getOwnPropertyDescriptor(navigator, 'connection')
    const connection = {
      effectiveType: '4g', saveData: false,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }
    Object.defineProperty(navigator, 'connection', { configurable: true, value: connection })
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const base = storeStub().currentTrack.value!
    const tracks = ['a', 'b', 'c'].map((id) => ({
      ...base, id, title: id, sources: [{ provider: 'lx', externalId: id + '.ogg' }],
    } as Track))
    const resolve = vi.fn(async (track: Track) => ({
      ok: true as const, providerId: 'lx', attempts: [],
      playable: { kind: 'audio' as const, url: 'https://media.invalid/' + track.id + '.ogg', mimeType: 'audio/ogg' },
    }))
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    const wrapper = mount(PlayerBar, { props: { store } })
    await flushPromises()

    const active = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    expect(store.preloadPolicy.value).toBe('auto')
    expect(store.preparedNext.value).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-audio-role="standby"]').exists()).toBe(false)
    setDuration(active.element, 240)
    await active.trigger('loadedmetadata')
    await active.trigger('timeupdate')
    await flushPromises()
    expect(store.preparedNext.value).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)

    active.element.currentTime = 225
    await active.trigger('loadedmetadata')
    await active.trigger('timeupdate')
    await flushPromises()
    const standby = wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]')
    expect(store.preparedNext.value?.track).toBe(tracks[1])
    expect(store.preparedNext.value?.armed).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(standby.attributes('preload')).toBe('auto')
    expect(standby.attributes('src')).toBe('https://media.invalid/b.ogg')
    expect(mediaPlay).not.toHaveBeenCalled()

    setDuration(standby.element, 240)
    standby.element.currentTime = 45
    await standby.trigger('loadedmetadata')
    await standby.trigger('timeupdate')
    await standby.trigger('playing')
    await standby.trigger('error')
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('3:45')
    expect(store.currentTrack.value).toBe(tracks[0])
    expect(store.status.value).toBe('ready')
    expect(store.attempts.value).toEqual([])

    await store.next()
    await flushPromises()
    const promoted = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    expect(promoted.element).toBe(standby.element)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(promoted.element).not.toBe(active.element)
    expect(store.currentTrack.value).toBe(tracks[1])
    await promoted.trigger('timeupdate')
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('0:45')

    wrapper.unmount()
    store.dispose()
    mediaPlay.mockRestore()
    if (originalConnection) Object.defineProperty(navigator, 'connection', originalConnection)
    else Reflect.deleteProperty(navigator, 'connection')
  })

  it('arms the next track near the end of the current one and promotes it without resolving twice', async () => {
    const originalConnection = Object.getOwnPropertyDescriptor(navigator, 'connection')
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { effectiveType: '4g', saveData: false, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    })
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const base = storeStub().currentTrack.value!
    // LX-only bindings: the speculative warm-up deliberately declines LX, so the *only* way the
    // next track can be prepared before the current one ends is the armed preparation.
    const tracks = ['a', 'b'].map((id) => ({
      ...base, id, title: id, sources: [{ provider: 'lx', externalId: `wy:${id}` }],
    } as Track))
    const resolvedTracks: string[] = []
    const resolve = vi.fn(async (
      track: Track, _registry: unknown, options?: ResolveOptions,
    ): Promise<ResolveResult> => {
      resolvedTracks.push(track.id)
      return {
        ok: true as const,
        providerId: options?.sourceOverride ?? 'lx',
        attempts: [],
        playable: {
          kind: 'audio' as const,
          url: 'https://media.invalid/' + track.id + '.mp3',
          mimeType: 'audio/mpeg',
        },
      }
    })
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    const wrapper = mount(PlayerBar, { props: { store } })
    await flushPromises()

    // Nothing is prepared yet, and no standby deck has been armed.
    expect(store.preparedNext.value).toBeNull()
    expect(wrapper.find('[data-audio-role="standby"]').exists()).toBe(false)
    expect(resolvedTracks).toEqual(['a'])

    // The current track reaches its final seconds.
    const active = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    setDuration(active.element, 240)
    active.element.currentTime = 225
    await active.trigger('loadedmetadata')
    await active.trigger('timeupdate')
    await flushPromises()

    // The next track is resolved and its media preload begins *while the current track is still
    // playing* — this is the behaviour the wave exists to add.
    expect(store.preparedNext.value?.track).toBe(tracks[1])
    const standby = wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]')
    expect(standby.attributes('src')).toBe('https://media.invalid/b.mp3')
    expect(standby.attributes('preload')).toBe('auto')
    expect(resolvedTracks).toEqual(['a', 'b'])

    // Promotion reuses that very element and does not resolve 'b' a second time.
    await store.next()
    await flushPromises()
    const promoted = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    expect(promoted.element).toBe(standby.element)
    expect(resolvedTracks).toEqual(['a', 'b'])

    wrapper.unmount()
    store.dispose()
    mediaPlay.mockRestore()
    if (originalConnection) Object.defineProperty(navigator, 'connection', originalConnection)
    else Reflect.deleteProperty(navigator, 'connection')
  })

  it('preloads the next track with preload="auto" when navigator.connection is absent (e.g. Safari / Firefox)', async () => {
    const originalConnection = Object.getOwnPropertyDescriptor(navigator, 'connection')
    Reflect.deleteProperty(navigator, 'connection')
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const base = storeStub().currentTrack.value!
    const tracks = ['a', 'b'].map((id) => ({
      ...base, id, title: id, sources: [{ provider: 'lx', externalId: `wy:${id}` }],
    } as Track))
    const resolvedTracks: string[] = []
    const resolve = vi.fn(async (
      track: Track, _registry: unknown, options?: ResolveOptions,
    ): Promise<ResolveResult> => {
      resolvedTracks.push(track.id)
      return {
        ok: true as const,
        providerId: options?.sourceOverride ?? 'lx',
        attempts: [],
        playable: {
          kind: 'audio' as const,
          url: 'https://media.invalid/' + track.id + '.mp3',
          mimeType: 'audio/mpeg',
        },
      }
    })
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    const wrapper = mount(PlayerBar, { props: { store } })
    await flushPromises()

    const active = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    setDuration(active.element, 240)

    // 1. Far from lead window (e.g. at start): standby deck must not be armed
    active.element.currentTime = 10
    await active.trigger('loadedmetadata')
    await active.trigger('timeupdate')
    await flushPromises()
    expect(store.preparedNext.value).toBeNull()
    expect(wrapper.find('[data-audio-role="standby"]').exists()).toBe(false)
    expect(resolvedTracks).toEqual(['a'])

    // 2. Just outside lead window (remaining 61s > 60s): still not armed
    active.element.currentTime = 179
    await active.trigger('timeupdate')
    await flushPromises()
    expect(store.preparedNext.value).toBeNull()
    expect(wrapper.find('[data-audio-role="standby"]').exists()).toBe(false)
    expect(resolvedTracks).toEqual(['a'])

    // 3. Inside lead window (remaining 15s <= 60s): armed with preload="auto" even without navigator.connection
    active.element.currentTime = 225
    await active.trigger('timeupdate')
    await flushPromises()
    expect(store.preparedNext.value?.track).toBe(tracks[1])
    expect(store.preparedNext.value?.armed).toBe(true)
    const standby = wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]')
    expect(standby.attributes('src')).toBe('https://media.invalid/b.mp3')
    expect(standby.attributes('preload')).toBe('auto')
    expect(resolvedTracks).toEqual(['a', 'b'])

    // 4. Current track ends: active triggers ended event, standby is promoted, no duplicate resolve
    await active.trigger('ended')
    await flushPromises()
    const promoted = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    expect(promoted.element).toBe(standby.element)
    expect(resolvedTracks).toEqual(['a', 'b'])
    expect(store.currentTrack.value).toBe(tracks[1])

    wrapper.unmount()
    store.dispose()
    mediaPlay.mockRestore()
    if (originalConnection) Object.defineProperty(navigator, 'connection', originalConnection)
    else Reflect.deleteProperty(navigator, 'connection')
  })

  it('avoids speculative requests and media loads when Save-Data is enabled', async () => {
    const originalConnection = Object.getOwnPropertyDescriptor(navigator, 'connection')
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { effectiveType: '4g', saveData: true, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    })
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const base = storeStub().currentTrack.value!
    const tracks = ['a', 'b'].map((id) => ({
      ...base, id, title: id, sources: [{ provider: 'lx', externalId: `wy:${id}` }],
    } as Track))
    const resolve = vi.fn(async (track: Track): Promise<ResolveResult> => ({
      ok: true as const,
      providerId: 'lx',
      attempts: [],
      playable: { kind: 'audio' as const, url: 'https://media.invalid/' + track.id + '.mp3', mimeType: 'audio/mpeg' },
    }))
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    const wrapper = mount(PlayerBar, { props: { store } })
    await flushPromises()

    const active = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    setDuration(active.element, 240)
    active.element.currentTime = 225
    await active.trigger('loadedmetadata')
    await active.trigger('timeupdate')
    await flushPromises()

    expect(wrapper.find('[data-audio-role="standby"]').exists()).toBe(false)
    expect(resolve).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    store.dispose()
    mediaPlay.mockRestore()
    if (originalConnection) Object.defineProperty(navigator, 'connection', originalConnection)
    else Reflect.deleteProperty(navigator, 'connection')
  })

  it('avoids speculative requests and media loads on slow connections (2g)', async () => {
    const originalConnection = Object.getOwnPropertyDescriptor(navigator, 'connection')
    Object.defineProperty(navigator, 'connection', {
      configurable: true,
      value: { effectiveType: '2g', saveData: false, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    })
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const base = storeStub().currentTrack.value!
    const tracks = ['a', 'b'].map((id) => ({
      ...base, id, title: id, sources: [{ provider: 'lx', externalId: `wy:${id}` }],
    } as Track))
    const resolve = vi.fn(async (track: Track): Promise<ResolveResult> => ({
      ok: true as const,
      providerId: 'lx',
      attempts: [],
      playable: { kind: 'audio' as const, url: 'https://media.invalid/' + track.id + '.mp3', mimeType: 'audio/mpeg' },
    }))
    const store = createPlaybackStore({ resolve })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    const wrapper = mount(PlayerBar, { props: { store } })
    await flushPromises()

    const active = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    setDuration(active.element, 240)
    active.element.currentTime = 225
    await active.trigger('loadedmetadata')
    await active.trigger('timeupdate')
    await flushPromises()

    expect(wrapper.find('[data-audio-role="standby"]').exists()).toBe(false)
    expect(resolve).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    store.dispose()
    mediaPlay.mockRestore()
    if (originalConnection) Object.defineProperty(navigator, 'connection', originalConnection)
    else Reflect.deleteProperty(navigator, 'connection')
  })

  it('discards stale prepared URL on ended transition instead of promoting expired ticket', async () => {
    const originalConnection = Object.getOwnPropertyDescriptor(navigator, 'connection')
    Reflect.deleteProperty(navigator, 'connection')
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const base = storeStub().currentTrack.value!
    const tracks = ['a', 'b'].map((id) => ({
      ...base, id, title: id, sources: [{ provider: 'lx', externalId: `wy:${id}` }],
    } as Track))
    let bCalls = 0
    const resolve = vi.fn(async (track: Track): Promise<ResolveResult> => {
      if (track.id === 'b') bCalls++
      return {
        ok: true as const,
        providerId: 'lx',
        attempts: [],
        playable: {
          kind: 'audio' as const,
          url: `https://media.invalid/${track.id}.mp3?rev=${bCalls}`,
          mimeType: 'audio/mpeg',
        },
      }
    })
    const store = createPlaybackStore({ resolve, preparationValidityMs: 50 })
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    const wrapper = mount(PlayerBar, { props: { store } })
    await flushPromises()

    const active = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    setDuration(active.element, 240)
    active.element.currentTime = 225
    await active.trigger('loadedmetadata')
    await active.trigger('timeupdate')
    await flushPromises()

    const standby = wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]')
    expect(standby.attributes('src')).toBe('https://media.invalid/b.mp3?rev=1')
    expect(bCalls).toBe(1)

    // Wait until preparation is stale (>50ms)
    await new Promise((resolve) => setTimeout(resolve, 60))

    // Active track ends while prepared ticket has expired
    await active.trigger('ended')
    await flushPromises()

    // Standby deck must NOT be promoted; fresh resolve must occur
    expect(bCalls).toBe(2)
    const currentActive = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    expect(currentActive.attributes('src')).toBe('https://media.invalid/b.mp3?rev=2')
    expect(store.currentTrack.value).toBe(tracks[1])

    wrapper.unmount()
    store.dispose()
    mediaPlay.mockRestore()
    if (originalConnection) Object.defineProperty(navigator, 'connection', originalConnection)
    else Reflect.deleteProperty(navigator, 'connection')
  })

  it('pauses and removes the outgoing deck while the next track resolves', async () => {
    const store = audioStoreStub()
    const nextTrack = { ...store.currentTrack.value!, id: 'next-release', title: 'Next release' }
    store.queue = ref([store.currentTrack.value!, nextTrack]) as never
    store.currentIndex = ref(0) as never
    const wrapper = mount(PlayerBar, { props: { store } })
    const outgoing = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
    const pause = vi.spyOn(outgoing.element, 'pause').mockImplementation(() => {})

    ;(store.playable as Ref<Playable | null>).value = null
    ;(store.currentTrack as Ref<Track | undefined>).value = nextTrack
    ;(store.currentIndex as Ref<number>).value = 1
    ;(store.playbackGeneration as Ref<number>).value += 1
    await wrapper.vm.$nextTick()

    expect(pause).toHaveBeenCalledOnce()
    expect(outgoing.element.hasAttribute('src')).toBe(false)
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledOnce()
    expect(wrapper.find('audio').exists()).toBe(false)
  })

  it('does not pause the replacement at a reused deck index when obsolete native play events arrive', async () => {
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    const outgoing = wrapper.get<HTMLAudioElement>('audio').element
    const pauseOld = vi.spyOn(outgoing, 'pause').mockImplementation(() => {})
    ;(store.playbackGeneration as Ref<number>).value += 1
    await wrapper.vm.$nextTick()
    ;(store.playbackGeneration as Ref<number>).value += 1
    await wrapper.vm.$nextTick()
    const replacement = wrapper.get<HTMLAudioElement>('audio').element
    expect(replacement).not.toBe(outgoing)
    expect(replacement.dataset.audioDeck).toBe(outgoing.dataset.audioDeck)
    const pauseNew = vi.spyOn(replacement, 'pause').mockImplementation(() => {})
    pauseOld.mockClear()
    outgoing.dispatchEvent(new Event('play'))
    outgoing.dispatchEvent(new Event('playing'))
    expect(pauseOld).toHaveBeenCalledTimes(2)
    expect(pauseNew).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('rejects stale deck events and playback commands during track resolution', () => {
    const store = audioStoreStub()
    const nextTrack = { ...store.currentTrack.value!, id: 'next-release', title: 'Next release' }
    store.queue = ref([store.currentTrack.value!, nextTrack]) as never
    store.currentIndex = ref(0) as never
    const wrapper = mount(PlayerBar, { props: { store } })
    const outgoing = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
    const mediaPlay = vi.spyOn(outgoing, 'play').mockResolvedValue()
    vi.spyOn(outgoing, 'pause').mockImplementation(() => {})

    ;(store.playable as Ref<Playable | null>).value = null
    ;(store.currentTrack as Ref<Track | undefined>).value = nextTrack
    ;(store.currentIndex as Ref<number>).value = 1
    ;(store.playbackGeneration as Ref<number>).value += 1
    outgoing.dispatchEvent(new Event('ended'))
    playbackCommands.play()

    expect(store.next).not.toHaveBeenCalled()
    expect(mediaPlay).not.toHaveBeenCalled()
  })

  it('pauses mounted native media before the player bar unmounts', () => {
    const wrapper = mount(PlayerBar, { props: { store: audioStoreStub() } })
    const pause = vi.spyOn(wrapper.get<HTMLAudioElement>('audio').element, 'pause').mockImplementation(() => {})

    wrapper.unmount()

    expect(pause).toHaveBeenCalledOnce()
  })

  it('reports an HTML audio runtime failure for the active provider', async () => {
    const store = storeStub()
    store.activeProviderId = { value: 'r2' } as never
    store.playable = { value: { kind: 'audio', url: 'https://media.invalid/broken.ogg', mimeType: 'audio/ogg' } } as never
    const wrapper = mount(PlayerBar, { props: { store } })

    await wrapper.get('audio').trigger('error')
    expect(store.reportPlaybackFailure).toHaveBeenCalledWith('r2', 1)
  })

  it('maps HTML media lifecycle events to generation-safe truthful states', async () => {
    const store = storeStub()
    store.activeProviderId = { value: 'r2' } as never
    store.status = { value: 'ready' } as never
    store.playable = { value: { kind: 'audio', url: 'https://media.invalid/ready.ogg', mimeType: 'audio/ogg' } } as never
    const wrapper = mount(PlayerBar, { props: { store } })
    const audio = wrapper.get('audio')

    await audio.trigger('playing')
    await audio.trigger('pause')
    await audio.trigger('waiting')
    await audio.trigger('ended')

    expect(store.reportMediaState).toHaveBeenNthCalledWith(1, 'playing', 1)
    expect(store.reportMediaState).toHaveBeenNthCalledWith(2, 'paused', 1)
    expect(store.reportMediaState).toHaveBeenNthCalledWith(3, 'buffering', 1)
    expect(store.reportMediaState).toHaveBeenNthCalledWith(4, 'ended', 1)
  })

  it('automatically advances from native audio completion when an upcoming row exists', async () => {
    const store = audioStoreStub()
    const nextTrack = { ...store.currentTrack.value!, id: 'next-release', title: 'Next release' }
    store.queue = ref([store.currentTrack.value!, nextTrack]) as never
    store.currentIndex = ref(0) as never
    const wrapper = mount(PlayerBar, { props: { store } })

    await wrapper.get('audio').trigger('ended')

    expect(store.next).toHaveBeenCalledOnce()
    expect(store.reportMediaState).not.toHaveBeenCalledWith('ended', 1)
  })

  it('automatically advances from YouTube state 0 when an upcoming row exists', async () => {
    const store = storeStub()
    const nextTrack = { ...store.currentTrack.value!, id: 'next-release', title: 'Next release' }
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.queue = ref([store.currentTrack.value!, nextTrack]) as never
    store.currentIndex = ref(0) as never
    const FakeYouTube = defineComponent({
      emits: ['state'],
      setup(_props, { emit, expose }) {
        expose({ pause: vi.fn(), play: vi.fn(), setVolume: vi.fn() })
        return () => h('button', { 'data-ended': '', onClick: () => emit('state', 0) })
      },
    })
    const wrapper = mount(PlayerBar, {
      props: { store },
      global: { stubs: { YouTubePlayer: FakeYouTube } },
    })

    await wrapper.get('[data-ended]').trigger('click')

    expect(store.next).toHaveBeenCalledOnce()
    expect(store.reportMediaState).not.toHaveBeenCalledWith('ended', 1)
  })

  it('ignores a delayed ended event from a stale playback generation', async () => {
    const store = storeStub()
    const generation = ref(1)
    const nextTrack = { ...store.currentTrack.value!, id: 'next-release', title: 'Next release' }
    const finishers: Array<() => void> = []
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    store.playbackGeneration = generation as never
    store.queue = ref([store.currentTrack.value!, nextTrack]) as never
    store.currentIndex = ref(0) as never
    const FakeYouTube = defineComponent({
      emits: ['state'],
      setup(_props, { emit, expose }) {
        expose({ pause: vi.fn(), play: vi.fn(), setVolume: vi.fn() })
        finishers.push(() => emit('state', 0))
        return () => h('div')
      },
    })
    mount(PlayerBar, {
      props: { store },
      global: { stubs: { YouTubePlayer: FakeYouTube } },
    })

    generation.value = 2
    await flushPromises()
    finishers[0]?.()
    await flushPromises()

    expect(store.next).not.toHaveBeenCalled()
    expect(store.reportMediaState).not.toHaveBeenCalled()
  })

  it('preserves ended state when native audio completes at the end of the queue', async () => {
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })

    await wrapper.get('audio').trigger('ended')

    expect(store.next).not.toHaveBeenCalled()
    expect(store.reportMediaState).toHaveBeenCalledWith('ended', 1)
  })

  it('delegates Repeat All completion to the store for wraparound', async () => {
    const store = audioStoreStub()
    store.repeatMode = ref('all') as never
    const wrapper = mount(PlayerBar, { props: { store } })
    await wrapper.get('audio').trigger('ended')
    expect(store.advanceAfterEnded).toHaveBeenCalledOnce()
    expect(store.reportMediaState).not.toHaveBeenCalledWith('ended', 1)
    wrapper.unmount()
  })

  it('replays a fully buffered Repeat One deck without resolving another source', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const store = audioStoreStub()
    store.playbackIntent = ref('playing')
    store.repeatMode = ref('one') as never
    const wrapper = mount(PlayerBar, { props: { store } })
    const audio = wrapper.get<HTMLAudioElement>('audio')
    setDuration(audio.element, 60)
    setBuffered(audio.element, [[0, 60]])
    audio.element.currentTime = 60
    await audio.trigger('ended')
    expect(audio.element.currentTime).toBe(0)
    expect(play).toHaveBeenCalledOnce()
    expect(store.advanceAfterEnded).not.toHaveBeenCalled()
    wrapper.unmount()
    play.mockRestore()
  })

  it('reports YouTube runtime errors to trigger resolver fallback', async () => {
    const store = storeStub()
    store.playable = { value: { kind: 'youtube', videoId: 'abcdefghijk' } } as never
    const wrapper = mount(PlayerBar, {
      props: { store },
      global: {
        stubs: {
          YouTubePlayer: { template: '<button data-youtube-error @click="$emit(\'error\', 2)" />' },
        },
      },
    })

    await wrapper.get('[data-youtube-error]').trigger('click')
    expect(store.reportPlaybackFailure).toHaveBeenCalledWith('youtube', 1)
  })

  it('maps official YouTube ready and state events to generation-safe truthful states', async () => {
    const store = storeStub()
    store.status = { value: 'ready' } as never
    store.playable = { value: { kind: 'youtube', videoId: 'abcdefghijk' } } as never
    const FakeYouTube = defineComponent({
      emits: ['ready', 'state'],
      setup(_props, { emit, expose }) {
        expose({ pause: vi.fn(), play: vi.fn(), setVolume: vi.fn() })
        return () => h('div', [
          h('button', { 'data-ready': '', onClick: () => emit('ready') }),
          h('button', { 'data-playing': '', onClick: () => emit('state', 1) }),
          h('button', { 'data-paused': '', onClick: () => emit('state', 2) }),
          h('button', { 'data-buffering': '', onClick: () => emit('state', 3) }),
          h('button', { 'data-ended': '', onClick: () => emit('state', 0) }),
        ])
      },
    })
    const wrapper = mount(PlayerBar, {
      props: { store },
      global: { stubs: { YouTubePlayer: FakeYouTube } },
    })

    await wrapper.get('[data-ready]').trigger('click')
    await wrapper.get('[data-playing]').trigger('click')
    await wrapper.get('[data-paused]').trigger('click')
    await wrapper.get('[data-buffering]').trigger('click')
    await wrapper.get('[data-ended]').trigger('click')

    expect(store.reportMediaState).toHaveBeenNthCalledWith(1, 'ready', 1)
    expect(store.reportMediaState).toHaveBeenNthCalledWith(2, 'playing', 1)
    expect(store.reportMediaState).toHaveBeenNthCalledWith(3, 'paused', 1)
    expect(store.reportMediaState).toHaveBeenNthCalledWith(4, 'buffering', 1)
    expect(store.reportMediaState).toHaveBeenNthCalledWith(5, 'ended', 1)
  })

  it('returns to ready paused playback without changing the resolved selection when autoplay is denied', async () => {
    const playable = {
      kind: 'audio' as const,
      url: 'https://media.invalid/selected.ogg',
      mimeType: 'audio/ogg',
    }
    const track: Track = {
      id: 'selected-track', title: 'Selected Track', aliases: {}, games: ['hsr'], relationIds: [],
      tabs: ['focus'], workGroupId: 'selected-work', vocalStatus: 'instrumental', needsClassification: false,
      sources: [{ provider: 'r2', externalId: 'selected.ogg' }],
    }
    const registry = new ProviderRegistry([{
      provider: { id: 'r2', resolve: vi.fn(async () => playable) },
      enabled: true,
      priority: 1,
      timeoutMs: 100,
    }])
    const store = createPlaybackStore({ registry })
    await store.playNow(track)
    await store.setSourceOverride('r2')
    store.pause()
    const reportPlaybackFailure = vi.spyOn(store, 'reportPlaybackFailure')
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(
      new DOMException('play() requires a user gesture', 'NotAllowedError'),
    )
    const preserved = {
      attempts: store.attempts.value,
      generation: store.playbackGeneration.value,
      playable: store.playable.value,
      provider: store.activeProviderId.value,
      sourceOverride: store.sourceOverride.value,
      track: store.currentTrack.value,
    }
    const wrapper = mount(PlayerBar, { props: { store } })

    await wrapper.get('[aria-label="Play"]').trigger('click')
    await flushPromises()

    expect(play).toHaveBeenCalledOnce()
    expect(reportPlaybackFailure).not.toHaveBeenCalled()
    expect(store.status.value).toBe('paused')
    expect(store.playbackIntent.value).toBe('playing')
    expect(wrapper.get('[aria-label="Play"]').element).toBeTruthy()
    expect(store.currentTrack.value).toBe(preserved.track)
    expect(store.currentTrack.value?.id).toBe('selected-track')
    expect(store.playbackGeneration.value).toBe(preserved.generation)
    expect(store.activeProviderId.value).toBe(preserved.provider)
    expect(store.sourceOverride.value).toBe(preserved.sourceOverride)
    expect(store.playable.value).toBe(preserved.playable)
    expect(store.attempts.value).toBe(preserved.attempts)
  })

  it('silently ignores an aborted HTML audio play request', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new DOMException('The play() request was interrupted', 'AbortError'))
    const store = storeStub()
    store.activeProviderId = { value: 'r2' } as never
    store.status = { value: 'paused' } as never
    store.playbackIntent = { value: 'paused' } as never
    store.playable = { value: { kind: 'audio', url: 'https://media.invalid/broken.ogg', mimeType: 'audio/ogg' } } as never
    const wrapper = mount(PlayerBar, { props: { store } })

    await wrapper.get('[aria-label="Play"]').trigger('click')
    await Promise.resolve()

    expect(play).toHaveBeenCalled()
    expect(store.reportPlaybackFailure).not.toHaveBeenCalled()
    expect(store.reportMediaState).not.toHaveBeenCalledWith('ready', 1)
    play.mockRestore()
  })

  it('reports a rejected HTML audio play request for genuine media failures', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new DOMException('Decode failed'))
    const store = storeStub()
    store.activeProviderId = { value: 'r2' } as never
    store.status = { value: 'paused' } as never
    const intent = ref<'playing' | 'paused'>('paused')
    store.playbackIntent = intent
    // Mirror the real store command: an explicit Play changes intent before native play rejects.
    vi.mocked(store.play).mockImplementation(async () => { intent.value = 'playing' })
    store.playable = { value: { kind: 'audio', url: 'https://media.invalid/broken.ogg', mimeType: 'audio/ogg' } } as never
    const wrapper = mount(PlayerBar, { props: { store } })

    await wrapper.get('[aria-label="Play"]').trigger('click')
    await Promise.resolve()

    expect(play).toHaveBeenCalled()
    expect(store.reportPlaybackFailure).toHaveBeenCalledWith('r2', 1)
    play.mockRestore()
  })

  it('does not restart YouTube when a delayed ready event arrives after pause', async () => {
    const youtubePlay = vi.fn()
    const youtubeSetVolume = vi.fn()
    const FakeYouTube = defineComponent({
      emits: ['ready'],
      setup(_props, { emit, expose }) {
        expose({ pause: vi.fn(), play: youtubePlay, setVolume: youtubeSetVolume })
        return () => h('button', { 'data-youtube-ready': '', onClick: () => emit('ready') })
      },
    })
    const store = storeStub()
    const status = ref<'playing' | 'paused'>('playing')
    store.status = status as never
    store.playbackIntent = ref<'playing' | 'paused'>('paused') as never
    store.playbackGeneration = ref(4) as never
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' }) as never
    const wrapper = mount(PlayerBar, {
      props: { store },
      global: { stubs: { YouTubePlayer: FakeYouTube } },
    })

    status.value = 'paused'
    await wrapper.get('[data-youtube-ready]').trigger('click')

    expect(youtubeSetVolume).toHaveBeenCalledWith(0.5)
    expect(youtubePlay).not.toHaveBeenCalled()
    expect(store.play).not.toHaveBeenCalled()
  })

  it('preserves explicit R2 override and surfaces error after runtime media failure without automatic fallback', async () => {
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const provider = (id: string) => ({ id, resolve: vi.fn() })
    const registry = new ProviderRegistry([
      { provider: provider('r2'), enabled: true, priority: 1, timeoutMs: 100 },
      { provider: provider('youtube'), enabled: true, priority: 2, timeoutMs: 100 },
    ])
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, providerId: 'r2', playable: { kind: 'audio', url: 'https://media.invalid/auto.ogg', mimeType: 'audio/ogg' }, attempts: [] })
      .mockResolvedValueOnce({ ok: true, providerId: 'r2', playable: { kind: 'audio', url: 'https://media.invalid/override.ogg', mimeType: 'audio/ogg' }, attempts: [] })
      .mockResolvedValueOnce({ ok: false, code: 'exhausted', attempts: [] })
    const store = createPlaybackStore({ registry, resolve })
    const track = {
      id: 'override', title: 'Override', aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'],
      workGroupId: 'override', vocalStatus: 'instrumental', needsClassification: false,
      sources: [{ provider: 'r2', externalId: 'override.ogg' }, { provider: 'youtube', externalId: 'abcdefghijk' }],
    } as Track
    await store.playNow(track)
    const wrapper = mount(PlayerBar, {
      props: { store },
      global: { stubs: { YouTubePlayer: { template: '<div data-youtube />' } } },
    })

    await wrapper.get('[aria-label="Playback source"]').setValue('r2')
    await flushPromises()
    await wrapper.get('audio').trigger('error')
    await flushPromises()

    expect(store.sourceOverride.value).toBe('r2')
    expect(store.status.value).toBe('error')
    expect(store.activeProviderId.value).toBeUndefined()
    expect(wrapper.get<HTMLSelectElement>('[aria-label="Playback source"]').element.value).toBe('r2')
    mediaPlay.mockRestore()
  })

  it('exposes source override and a polite live source status', async () => {
    const store = storeStub()
    const wrapper = mount(PlayerBar, { props: { store } })

    expect(wrapper.find('option[value="r2"]').exists()).toBe(false)
    await wrapper.get('[aria-label="Playback source"]').setValue('youtube')

    expect(store.setSourceOverride).toHaveBeenCalledWith('youtube')
    expect(wrapper.get('[role="status"]').text()).toBe('Playing')
    expect(wrapper.get('[role="status"]').text()).not.toContain('YouTube')
  })

  it('announces an understandable offline state through the labelled player status', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const wrapper = mount(PlayerBar, { props: { store: storeStub() } })

    window.dispatchEvent(new Event('offline'))
    await wrapper.vm.$nextTick()

    expect(wrapper.get('[role="status"]').text()).toBe('Audio is unavailable offline. Reconnect to play this track.')
    online.mockRestore()
  })

  it('pauses the mounted media exactly once when sleep expiry stops playback', () => {
    let now = 0
    const mediaPause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const store = storeStub()
    store.activeProviderId = { value: 'r2' } as never
    store.playable = { value: { kind: 'audio', url: 'https://media.invalid/sleep.ogg', mimeType: 'audio/ogg' } } as never
    const wrapper = mount(PlayerBar, { props: { store } })
    const sleep = createSleepTimerStore({ clock: { now: () => now }, player: playbackCommands, autoTick: false })
    sleep.selectDuration(15)
    sleep.start()

    now = 15 * 60_000
    sleep.tick()

    expect(mediaPause).toHaveBeenCalledTimes(1)
    expect(store.stop).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    mediaPause.mockRestore()
  })
})


describe('PlayerBar custom controls', () => {
  it('retains real audio without native controls and renders one functional transport', async () => {
    const store = audioStoreStub()
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
    const mediaPause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const wrapper = mount(PlayerBar, { props: { store, compact: true } })
    ;(store.status as Ref<PlaybackStore['status']['value']>).value = 'paused'
    expect(wrapper.findAll('audio')).toHaveLength(1)
    expect(wrapper.get('audio').attributes('controls')).toBeUndefined()
    for (const label of ['Previous track', 'Play', 'Next track']) {
      expect(wrapper.findAll('button[aria-label="' + label + '"]')).toHaveLength(1)
      await wrapper.get('button[aria-label="' + label + '"]').trigger('click')
    }
    expect(store.previous).toHaveBeenCalledOnce()
    expect(store.play).toHaveBeenCalledOnce()
    expect(mediaPlay).toHaveBeenCalledOnce()
    expect(store.next).toHaveBeenCalledOnce()
    ;(store.playbackIntent as Ref<'playing' | 'paused'>).value = 'playing'
    ;(store.status as Ref<PlaybackStore['status']['value']>).value = 'playing'
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('button[aria-label="Pause"]')).toHaveLength(1)
    await wrapper.get('button[aria-label="Pause"]').trigger('click')
    expect(store.pause).toHaveBeenCalledOnce()
    expect(mediaPause).toHaveBeenCalledOnce()
    expect(wrapper.get('[data-player-track-metadata]').text()).toBe('Honkai: Star Rail')
  })

  it('updates elapsed, duration and seek bounds from native media events, including hour-long tracks', async () => {
    const wrapper = mount(PlayerBar, { props: { store: audioStoreStub(), compact: true } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('0:00')
    expect(wrapper.get('[data-player-duration]').text()).toBe('--:--')
    expect(wrapper.get<HTMLInputElement>('[data-player-seek]').element.disabled).toBe(true)
    setDuration(media.element, 185.75)
    await media.trigger('loadedmetadata')
    expect(wrapper.get('[data-player-duration]').text()).toBe('3:05')
    expect(wrapper.get('[data-player-seek]').attributes('max')).toBe('185.75')
    media.element.currentTime = 65.9
    await media.trigger('timeupdate')
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('1:05')
    expect(wrapper.get<HTMLInputElement>('[data-player-seek]').element.value).toBe('65.9')
    expect(wrapper.get('[data-player-seek]').attributes('aria-valuetext')).toBe('1:05 / 3:05')
    setDuration(media.element, 3725)
    media.element.currentTime = 3601
    await media.trigger('durationchange')
    expect(wrapper.get('[data-player-duration]').text()).toBe('1:02:05')
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('1:00:01')
  })

  it('seeks only the current native element without issuing playback or failure commands', async () => {
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 200)
    await media.trigger('loadedmetadata')
    const seek = wrapper.get<HTMLInputElement>('[data-player-seek]')
    await seek.setValue('75.5')
    expect(media.element.currentTime).toBe(75.5)
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('1:15')
    expect(store.play).not.toHaveBeenCalled()
    expect(store.pause).not.toHaveBeenCalled()
    expect(store.reportPlaybackFailure).not.toHaveBeenCalled()
  })

  it.each(['NaN', 'Infinity', '-Infinity'])('ignores non-finite seek input %s even if a DOM value is forged', async (value) => {
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 200)
    media.element.currentTime = 40
    await media.trigger('loadedmetadata')
    const seek = wrapper.get<HTMLInputElement>('[data-player-seek]')
    // A browser range normally sanitises this; exercise the handler's boundary too.
    const inputValue = vi.spyOn(seek.element, 'value', 'get').mockReturnValue(value)
    await seek.trigger('input')
    inputValue.mockRestore()
    expect(media.element.currentTime).toBe(40)
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('0:40')
    expect(store.reportPlaybackFailure).not.toHaveBeenCalled()
  })

  it.each([[-25, 0], [250, 200]])('clamps out-of-range seek input %s to %s', async (input, expected) => {
    const wrapper = mount(PlayerBar, { props: { store: audioStoreStub() } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 200)
    await media.trigger('loadedmetadata')
    const seek = wrapper.get<HTMLInputElement>('[data-player-seek]')
    const inputValue = vi.spyOn(seek.element, 'value', 'get').mockReturnValue(String(input))
    await seek.trigger('input')
    inputValue.mockRestore()
    expect(media.element.currentTime).toBe(expected)
  })

  it.each([NaN, Infinity, -Infinity, 0, -5])('keeps unknown duration %s truthful and cannot seek it', async (value) => {
    const wrapper = mount(PlayerBar, { props: { store: audioStoreStub() } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, value)
    media.element.currentTime = 10
    await media.trigger('durationchange')
    expect(wrapper.get('[data-player-duration]').text()).toBe('--:--')
    const seek = wrapper.get<HTMLInputElement>('[data-player-seek]')
    expect(seek.element.disabled).toBe(true)
    const inputValue = vi.spyOn(seek.element, 'value', 'get').mockReturnValue('50')
    await seek.trigger('input')
    inputValue.mockRestore()
    expect(media.element.currentTime).toBe(10)
    expect(wrapper.text()).not.toMatch(/NaN|Infinity/)
  })

  it.each([NaN, Infinity, -Infinity, -3])('sanitises invalid media time %s instead of leaking it into the slider', async (value) => {
    const wrapper = mount(PlayerBar, { props: { store: audioStoreStub() } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 200)
    const time = vi.spyOn(media.element, 'currentTime', 'get').mockReturnValue(value)
    await media.trigger('timeupdate')
    time.mockRestore()
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('0:00')
    expect(wrapper.get<HTMLInputElement>('[data-player-seek]').element.value).toBe('0')
    expect(wrapper.text()).not.toMatch(/NaN|Infinity/)
  })

  it('clamps elapsed when duration shrinks and retains media progress while controls collapse', async () => {
    const wrapper = mount(PlayerBar, { props: { store: audioStoreStub(), compact: true } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    setDuration(media.element, 200)
    media.element.currentTime = 150
    await media.trigger('loadedmetadata')
    await wrapper.get('[data-player-collapse]').trigger('click')
    setDuration(media.element, 80)
    await media.trigger('durationchange')
    expect(wrapper.get('audio').element).toBe(media.element)
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('1:20')
    await wrapper.get('[data-player-collapse]').trigger('click')
    expect(wrapper.get('[data-player-duration]').text()).toBe('1:20')
    expect(wrapper.get<HTMLInputElement>('[data-player-seek]').element.value).toBe('80')
  })

  it('rejects events and seek from the old generation before and after the replacement element mounts', async () => {
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    const oldMedia = wrapper.get<HTMLAudioElement>('audio')
    setDuration(oldMedia.element, 200)
    oldMedia.element.currentTime = 30
    await oldMedia.trigger('loadedmetadata')
    const seek = wrapper.get<HTMLInputElement>('[data-player-seek]').element
    ;(store.playbackGeneration as Ref<number>).value += 1
    // No nextTick: the old element is still the template ref at this instant.
    oldMedia.element.dispatchEvent(new Event('timeupdate'))
    seek.value = '70'
    seek.dispatchEvent(new Event('input', { bubbles: true }))
    await wrapper.vm.$nextTick()
    const newMedia = wrapper.get<HTMLAudioElement>('audio')
    expect(newMedia.element).not.toBe(oldMedia.element)
    expect(oldMedia.element.currentTime).toBe(30)
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('0:00')
    expect(wrapper.get('[data-player-duration]').text()).toBe('--:--')
    setDuration(newMedia.element, 90)
    newMedia.element.currentTime = 5
    await newMedia.trigger('loadedmetadata')
    for (const event of ['timeupdate', 'loadedmetadata', 'durationchange']) {
      oldMedia.element.dispatchEvent(new Event(event))
    }
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('0:05')
    expect(wrapper.get('[data-player-duration]').text()).toBe('1:30')
  })

  it('resets progress on real source or track changes but not on queue reorder', async () => {
    const resolve = vi.fn(async (track: Track) => ({
      ok: true as const, providerId: 'r2', attempts: [],
      playable: { kind: 'audio' as const, url: 'https://media.invalid/' + track.id + '.ogg', mimeType: 'audio/ogg' },
    }))
    const store = createPlaybackStore({ resolve })
    const current = storeStub().currentTrack.value!
    const history: Track = { ...current, id: 'history', title: 'History' }
    const upcoming: Track = { ...current, id: 'upcoming', title: 'Upcoming' }
    await store.playNow(history)
    await store.playNow(current)
    store.enqueue(upcoming)
    const wrapper = mount(PlayerBar, { props: { store, compact: true } })
    const media = wrapper.get<HTMLAudioElement>('audio')
    const generation = store.playbackGeneration.value
    const activePlayable = store.playable.value
    setDuration(media.element, 200)
    media.element.currentTime = 30
    await media.trigger('loadedmetadata')
    expect(wrapper.get('[data-player-queue-count]').text()).toBe('1')
    expect(store.moveQueueItem(0, 2)).toBe(true)
    await wrapper.vm.$nextTick()
    expect(store.currentIndex.value).toBe(0)
    expect(wrapper.get('[data-player-queue-count]').text()).toBe('2')
    expect(wrapper.get('[data-audio-role="active"]').element).toBe(media.element)
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.currentTrack.value).toBe(current)
    expect(store.playable.value).toBe(activePlayable)
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('0:30')
    await store.playQueueIndex(1)
    await flushPromises()
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('0:00')
    expect(wrapper.get('[data-player-duration]').text()).toBe('--:--')
    expect(wrapper.get('audio').element).not.toBe(media.element)
    const replacement = wrapper.get<HTMLAudioElement>('audio')
    setDuration(replacement.element, 180)
    replacement.element.currentTime = 20
    await replacement.trigger('loadedmetadata')
    await store.setSourceOverride('r2')
    await flushPromises()
    expect(wrapper.get('[data-player-elapsed]').text()).toBe('0:00')
    expect(wrapper.get('[data-player-duration]').text()).toBe('--:--')
  })

  it('synchronises initial and changed native volume and unmutes to the previous nonzero volume', async () => {
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    await wrapper.vm.$nextTick()
    const media = wrapper.get<HTMLAudioElement>('audio').element
    expect(media.volume).toBe(0.5)
    const volume = wrapper.get<HTMLInputElement>('[aria-label="Volume"]')
    await volume.setValue('0.35')
    expect(store.volume.value).toBe(0.35)
    expect(media.volume).toBe(0.35)
    await wrapper.get('[aria-label="Mute"]').trigger('click')
    expect(store.volume.value).toBe(0)
    expect(media.volume).toBe(0)
    expect(volume.element.value).toBe('0')
    await wrapper.get('[aria-label="Unmute"]').trigger('click')
    expect(store.volume.value).toBe(0.35)
    expect(media.volume).toBe(0.35)
    await volume.setValue('0.2')
    await volume.setValue('0')
    await wrapper.get('[aria-label="Unmute"]').trigger('click')
    expect(media.volume).toBe(0.2)
    expect(store.play).not.toHaveBeenCalled()
    expect(store.pause).not.toHaveBeenCalled()
  })

  it('unmutes to the latest explicit volume even when mute arrives before the volume watcher flushes', async () => {
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    store.setVolume(0.3)
    wrapper.get<HTMLButtonElement>('[aria-label="Mute"]').element.click()
    await wrapper.vm.$nextTick()
    await wrapper.get('[aria-label="Unmute"]').trigger('click')
    expect(store.volume.value).toBe(0.3)
    expect(wrapper.get<HTMLAudioElement>('audio').element.volume).toBe(0.3)
  })

  it.each(['NaN', 'Infinity', '-Infinity'])('ignores non-finite volume input %s', async (value) => {
    const store = audioStoreStub()
    const wrapper = mount(PlayerBar, { props: { store } })
    const volume = wrapper.get<HTMLInputElement>('[aria-label="Volume"]')
    const inputValue = vi.spyOn(volume.element, 'value', 'get').mockReturnValue(value)
    await volume.trigger('input')
    inputValue.mockRestore()
    expect(store.setVolume).not.toHaveBeenCalled()
    expect(store.volume.value).toBe(0.5)
    expect(wrapper.get<HTMLAudioElement>('audio').element.volume).toBe(0.5)
  })

  it('preserves official playback and volume handling without inventing YouTube progress', async () => {
    const store = storeStub()
    store.playable = ref({ kind: 'youtube', videoId: 'abcdefghijk' })
    const youtubePlay = vi.fn()
    const youtubePause = vi.fn()
    const youtubeSetVolume = vi.fn()
    const FakeYouTube = defineComponent({
      emits: ['ready'],
      setup(_props, { emit, expose }) {
        expose({ play: youtubePlay, pause: youtubePause, setVolume: youtubeSetVolume })
        return () => h('button', { 'data-official-ready': '', onClick: () => emit('ready') })
      },
    })
    const wrapper = mount(PlayerBar, { props: { store, compact: true }, global: { stubs: { YouTubePlayer: FakeYouTube } } })
    const official = wrapper.get('[data-official-ready]').element
    await wrapper.get('[data-official-ready]').trigger('click')
    expect(youtubePlay).toHaveBeenCalledOnce()
    expect(youtubeSetVolume).toHaveBeenLastCalledWith(0.5)
    expect(wrapper.find('audio').exists()).toBe(false)
    expect(wrapper.find('[data-player-seek]').exists()).toBe(false)
    expect(wrapper.find('[data-player-elapsed]').exists()).toBe(false)
    expect(wrapper.find('[data-player-duration]').exists()).toBe(false)
    await wrapper.get('[aria-label="Volume"]').setValue('0.4')
    expect(youtubeSetVolume).toHaveBeenLastCalledWith(0.4)
    await wrapper.get('[aria-label="Mute"]').trigger('click')
    expect(youtubeSetVolume).toHaveBeenLastCalledWith(0)
    await wrapper.get('[aria-label="Unmute"]').trigger('click')
    expect(youtubeSetVolume).toHaveBeenLastCalledWith(0.4)
    await wrapper.get('[data-player-toggle-queue]').trigger('click')
    await wrapper.setProps({ queueOpen: true })
    expect(wrapper.get('[data-official-ready]').element).toBe(official)
    expect(wrapper.attributes('inert')).toBeUndefined()
    expect(wrapper.attributes('data-media-suspended')).toBe('false')
    expect(youtubePause).not.toHaveBeenCalled()
    expect(youtubePlay).toHaveBeenCalledOnce()
    expect(store.pause).not.toHaveBeenCalled()
  })

  it('exposes truthful queue open state independently of media suspension and counts only upcoming tracks', async () => {
    const store = audioStoreStub()
    const track = store.currentTrack.value!
    const queue = ref<Track[]>([{ ...track, id: 'history' }, track, { ...track, id: 'next' }, { ...track, id: 'later' }])
    store.queue = queue
    store.currentIndex = ref(1)
    const wrapper = mount(PlayerBar, { props: { store, compact: true, queueOpen: true } })
    const button = wrapper.get('[data-player-toggle-queue]')
    const media = wrapper.get('audio').element
    expect(button.attributes('aria-expanded')).toBe('true')
    expect(button.attributes('aria-controls')).toBe('workspace-queue-drawer')
    expect(button.get('[data-player-queue-count]').text()).toBe('2')
    expect(button.attributes('aria-label')).toBe('Queue · 2 upcoming')
    expect(wrapper.attributes('inert')).toBeUndefined()
    await button.trigger('click')
    expect(wrapper.emitted('toggle-queue')).toHaveLength(1)
    expect(wrapper.emitted('open-library')).toBeUndefined()
    await wrapper.setProps({ queueOpen: false, mediaSuspended: true })
    expect(button.attributes('aria-expanded')).toBe('false')
    await wrapper.setProps({ queueOpen: true })
    expect(button.attributes('aria-expanded')).toBe('true')
    queue.value = queue.value.slice(0, 2)
    await wrapper.vm.$nextTick()
    expect(button.get('[data-player-queue-count]').text()).toBe('0')
    expect(wrapper.get('audio').element).toBe(media)
    expect(store.play).not.toHaveBeenCalled()
    expect(store.pause).not.toHaveBeenCalled()
  })

  it('filters out not_mapped attempts and retired R2 failures from the main status line', async () => {
    const store = storeStub()
    store.activeProviderId = ref('')
    store.status = ref('error')
    const attempts = ref([
      { providerId: 'jellyfin', ok: false, code: 'not_mapped' as const, latencyMs: 0 },
      { providerId: 'r2', ok: false, code: 'unavailable' as const, latencyMs: 120 },
    ])
    store.attempts = attempts as never
    const wrapper = mount(PlayerBar, { props: { store, compact: true } })
    const status = wrapper.get('.player-bar__status')
    expect(status.text()).toBe('No enabled source is available')
    expect(status.text()).not.toContain('not mapped')
    expect(status.text()).not.toContain('R2')
    expect(status.text()).not.toContain('Jellyfin')

    // If an active mapped provider actually fails, it is truthfully included in status text
    attempts.value = [
      { providerId: 'jellyfin', ok: false, code: 'unavailable' as const, latencyMs: 100 },
      { providerId: 'r2', ok: false, code: 'unavailable' as const, latencyMs: 120 },
    ]
    await wrapper.vm.$nextTick()
    expect(status.text()).toContain('Jellyfin unavailable')
    expect(status.text()).not.toContain('R2')
  })

  it('keeps LX sub-source attempts out of the status line when a later LX source succeeds', async () => {
    const store = storeStub()
    store.activeProviderId = ref('lx')
    store.status = ref('playing')
    const attempts = ref([
      { providerId: 'lx', ok: false, code: 'timeout' as const, latencyMs: 900, sourceId: 'ku-lao', sourceName: '褲佬 SVIP' },
      { providerId: 'lx', ok: false, code: 'unavailable' as const, latencyMs: 400, sourceId: 'my-source', sourceName: 'My Source' },
      { providerId: 'lx', ok: true, latencyMs: 300, sourceId: 'other', sourceName: 'Other Source' },
      { providerId: 'lx', ok: true, latencyMs: 1200 },
    ])
    store.attempts = attempts as never
    const wrapper = mount(PlayerBar, { props: { store, compact: true } })
    const status = wrapper.get('.player-bar__status')
    expect(status.text()).not.toContain('timeout')
    expect(status.text()).toBe('Playing')
    expect(status.text()).not.toContain('LX Music')
  })

  it('renders exactly one LX Music failure fragment for a failed top-level LX attempt', async () => {
    const store = storeStub()
    store.activeProviderId = ref('')
    store.status = ref('error')
    const attempts = ref([
      { providerId: 'lx', ok: false, code: 'timeout' as const, latencyMs: 900, sourceId: 'ku-lao', sourceName: '褲佬 SVIP' },
      { providerId: 'lx', ok: false, code: 'unavailable' as const, latencyMs: 400, sourceId: 'my-source', sourceName: 'My Source' },
      { providerId: 'lx', ok: false, code: 'unavailable' as const, latencyMs: 1200 },
    ])
    store.attempts = attempts as never
    const wrapper = mount(PlayerBar, { props: { store, compact: true } })
    const status = wrapper.get('.player-bar__status')
    expect(status.text().match(/LX Music unavailable/g) ?? []).toHaveLength(1)
    expect(status.text()).toBe('LX Music unavailable · No enabled source is available')
  })

  describe('generic LX and strict manual override in PlayerBar UI', () => {
    it('displays LX Music in the production provider picker when LX is enabled and can resolve track without literal lx source entry', async () => {
      const lxProvider: AudioProvider = {
        id: 'lx',
        canResolve: (_track) => true,
        resolve: vi.fn().mockResolvedValue({
          kind: 'audio' as const,
          url: 'https://lx.example/audio.mp3',
          mimeType: 'audio/mpeg',
        }),
      }
      const jellyfinProvider: AudioProvider = {
        id: 'jellyfin',
        canResolve: (_track) => true,
        resolve: vi.fn().mockResolvedValue({
          kind: 'audio' as const,
          url: 'https://jellyfin.example/audio.mp3',
          mimeType: 'audio/mpeg',
        }),
      }
      const registry = new ProviderRegistry([
        { provider: lxProvider, enabled: true, priority: 1, timeoutMs: 100 },
        { provider: jellyfinProvider, enabled: true, priority: 2, timeoutMs: 100 },
      ])
      const store = createPlaybackStore({ registry })
      const track = {
        id: 'generic-track',
        title: 'Generic Track',
        aliases: {},
        games: ['genshin'],
        relationIds: [],
        tabs: ['focus'],
        workGroupId: 'wg',
        vocalStatus: 'instrumental',
        needsClassification: false,
        sources: [{ provider: 'jellyfin', externalId: 'jf-456' }],
      } as Track

      await store.playNow(track)
      const wrapper = mount(PlayerBar, { props: { store } })
      await flushPromises()

      const select = wrapper.get<HTMLSelectElement>('[aria-label="Playback source"]')
      const options = select.findAll('option')
      const optionValues = options.map((opt) => opt.element.value)
      const optionTexts = options.map((opt) => opt.text())

      expect(optionValues).toContain('lx')
      expect(optionTexts).toContain('LX Music')
    })

    it('sets sourceOverride to lx and resolves via LX when selecting LX in the picker', async () => {
      const lxProvider: AudioProvider = {
        id: 'lx',
        canResolve: (_track) => true,
        resolve: vi.fn().mockResolvedValue({
          kind: 'audio' as const,
          url: 'https://lx.example/audio.mp3',
          mimeType: 'audio/mpeg',
        }),
      }
      const jellyfinProvider: AudioProvider = {
        id: 'jellyfin',
        canResolve: (_track) => true,
        resolve: vi.fn().mockResolvedValue({
          kind: 'audio' as const,
          url: 'https://jellyfin.example/audio.mp3',
          mimeType: 'audio/mpeg',
        }),
      }
      const registry = new ProviderRegistry([
        { provider: lxProvider, enabled: true, priority: 1, timeoutMs: 100 },
        { provider: jellyfinProvider, enabled: true, priority: 2, timeoutMs: 100 },
      ])
      const store = createPlaybackStore({ registry })
      const track = {
        id: 'generic-track',
        title: 'Generic Track',
        aliases: {},
        games: ['genshin'],
        relationIds: [],
        tabs: ['focus'],
        workGroupId: 'wg',
        vocalStatus: 'instrumental',
        needsClassification: false,
        sources: [{ provider: 'jellyfin', externalId: 'jf-456' }],
      } as Track

      await store.playNow(track)
      const wrapper = mount(PlayerBar, { props: { store } })
      await flushPromises()

      const select = wrapper.get<HTMLSelectElement>('[aria-label="Playback source"]')
      await select.setValue('lx')
      await flushPromises()

      expect(store.sourceOverride.value).toBe('lx')
      expect(store.activeProviderId.value).toBe('lx')
      expect(store.status.value).toBe('ready')
      expect(lxProvider.resolve).toHaveBeenCalled()
    })

    it('halts a failed manual LX without Jellyfin and without changing the picker preference', async () => {
      // D16 = No, Property 30 (tasks 8.1, 8.4): a manual source runs alone; its failure halts on the
      // track and never starts the Jellyfin recovery.
      const lxProvider: AudioProvider = {
        id: 'lx',
        canResolve: (_track) => true,
        resolve: vi.fn().mockResolvedValue(null),
      }
      const jellyfinResolve = vi.fn().mockResolvedValue({
        kind: 'audio' as const,
        url: 'https://jellyfin.example/audio.mp3',
        mimeType: 'audio/mpeg',
      })
      const jellyfinProvider: AudioProvider = {
        id: 'jellyfin',
        canResolve: (_track) => true,
        resolve: jellyfinResolve,
      }
      const registry = new ProviderRegistry([
        { provider: lxProvider, enabled: true, priority: 1, timeoutMs: 100 },
        { provider: jellyfinProvider, enabled: true, priority: 2, timeoutMs: 100 },
      ])
      const store = createPlaybackStore({ registry })
      const track = {
        id: 'generic-track',
        title: 'Generic Track',
        aliases: {},
        games: ['genshin'],
        relationIds: [],
        tabs: ['focus'],
        workGroupId: 'wg',
        vocalStatus: 'instrumental',
        needsClassification: false,
        sources: [{ provider: 'jellyfin', externalId: 'jf-456' }],
      } as Track

      await store.playNow(track)
      expect(store.activeProviderId.value).toBe('jellyfin')
      jellyfinResolve.mockClear()

      const wrapper = mount(PlayerBar, { props: { store } })
      await flushPromises()

      const select = wrapper.get<HTMLSelectElement>('[aria-label="Playback source"]')
      await select.setValue('lx')
      await flushPromises()

      expect(store.sourceOverride.value).toBe('lx')
      expect(store.status.value).toBe('error')
      expect(store.activeProviderId.value).toBeUndefined()
      expect(store.currentTrack.value).toBe(track)
      expect(lxProvider.resolve).toHaveBeenCalled()
      expect(jellyfinResolve).not.toHaveBeenCalled()
      expect(select.element.value).toBe('lx')
      const statusText = wrapper.get('.player-bar__status').text()
      expect(statusText).toContain('LX Music unavailable')
    })
  })

  describe('audio buffering progress', () => {
    it('renders no buffer segments when buffered ranges are empty', async () => {
      const store = audioStoreStub()
      const wrapper = mount(PlayerBar, { props: { store } })
      const media = wrapper.get<HTMLAudioElement>('audio')
      setDuration(media.element, 100)
      setBuffered(media.element, [])
      await media.trigger('progress')
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('[data-player-buffer-segment]')).toHaveLength(0)
      expect(wrapper.get('[data-player-buffer]').attributes('data-buffered-extent')).toBeUndefined()
    })

    it('renders a single buffered segment matching start and end percentages', async () => {
      const store = audioStoreStub()
      const wrapper = mount(PlayerBar, { props: { store } })
      const media = wrapper.get<HTMLAudioElement>('audio')
      setDuration(media.element, 100)
      setBuffered(media.element, [[0, 45]])
      await media.trigger('progress')
      await wrapper.vm.$nextTick()

      const segments = wrapper.findAll('[data-player-buffer-segment]')
      expect(segments).toHaveLength(1)
      expect(segments[0].attributes('style')).toContain('left: 0%')
      expect(segments[0].attributes('style')).toContain('width: 45%')
      expect(wrapper.get('[data-player-buffer]').attributes('data-buffered-extent')).toBe('0.0%-45.0%')
    })

    it('renders disjoint buffered ranges with proportional percentages', async () => {
      const store = audioStoreStub()
      const wrapper = mount(PlayerBar, { props: { store } })
      const media = wrapper.get<HTMLAudioElement>('audio')
      setDuration(media.element, 200)
      setBuffered(media.element, [[0, 50], [100, 160]])
      await media.trigger('progress')
      await wrapper.vm.$nextTick()

      const segments = wrapper.findAll('[data-player-buffer-segment]')
      expect(segments).toHaveLength(2)
      expect(segments[0].attributes('style')).toContain('left: 0%')
      expect(segments[0].attributes('style')).toContain('width: 25%')
      expect(segments[1].attributes('style')).toContain('left: 50%')
      expect(segments[1].attributes('style')).toContain('width: 30%')
    })

    it('identifies the segment that encloses currentTime as current', async () => {
      const store = audioStoreStub()
      const wrapper = mount(PlayerBar, { props: { store } })
      const media = wrapper.get<HTMLAudioElement>('audio')
      setDuration(media.element, 100)
      media.element.currentTime = 65
      setBuffered(media.element, [[0, 30], [50, 80]])
      await media.trigger('loadedmetadata')
      await media.trigger('timeupdate')
      await media.trigger('progress')
      await wrapper.vm.$nextTick()

      const segments = wrapper.findAll('[data-player-buffer-segment]')
      expect(segments).toHaveLength(2)
      expect(segments[0].attributes('data-current')).toBeUndefined()
      expect(segments[1].attributes('data-current')).toBe('true')
      expect(wrapper.get('[data-player-buffer]').attributes('data-buffered-extent')).toBe('50.0%-80.0%')
      expect(wrapper.get('[data-player-played]').attributes('style')).toContain('--played-percent: 65')
    })

    it('updates current segment and extent when seeking into another range', async () => {
      const store = audioStoreStub()
      const wrapper = mount(PlayerBar, { props: { store } })
      const media = wrapper.get<HTMLAudioElement>('audio')
      setDuration(media.element, 100)
      media.element.currentTime = 15
      setBuffered(media.element, [[0, 30], [60, 90]])
      await media.trigger('loadedmetadata')
      await media.trigger('timeupdate')
      await media.trigger('progress')
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('[data-player-buffer-segment]')[0].attributes('data-current')).toBe('true')
      expect(wrapper.get('[data-player-buffer]').attributes('data-buffered-extent')).toBe('0.0%-30.0%')

      const seekInput = wrapper.get<HTMLInputElement>('[data-player-seek]')
      seekInput.element.value = '75'
      await seekInput.trigger('input')
      await media.trigger('timeupdate')
      await wrapper.vm.$nextTick()

      expect(media.element.currentTime).toBe(75)
      const segments = wrapper.findAll('[data-player-buffer-segment]')
      expect(segments[0].attributes('data-current')).toBeUndefined()
      expect(segments[1].attributes('data-current')).toBe('true')
      expect(wrapper.get('[data-player-buffer]').attributes('data-buffered-extent')).toBe('60.0%-90.0%')
      expect(wrapper.get('[data-player-played]').attributes('style')).toContain('--played-percent: 75')
    })

    it('resets buffer and played progress when source or playback generation changes', async () => {
      const store = audioStoreStub()
      const wrapper = mount(PlayerBar, { props: { store } })
      const media = wrapper.get<HTMLAudioElement>('audio')
      setDuration(media.element, 100)
      media.element.currentTime = 40
      setBuffered(media.element, [[0, 60]])
      await media.trigger('loadedmetadata')
      await media.trigger('timeupdate')
      await media.trigger('progress')
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('[data-player-buffer-segment]')).toHaveLength(1)
      expect(wrapper.get('[data-player-played]').attributes('style')).toContain('--played-percent: 40')

      ;(store.playbackGeneration as Ref<number>).value = 2
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('[data-player-buffer-segment]')).toHaveLength(0)
      expect(wrapper.get('[data-player-buffer]').attributes('data-buffered-extent')).toBeUndefined()
      expect(wrapper.get('[data-player-played]').attributes('style')).toContain('--played-percent: 0')
    })

    it('ignores progress and presentation events from the standby deck and switches buffer UI upon promotion', async () => {
      const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
      const resolve = vi.fn(async (track: Track) => ({
        ok: true as const,
        providerId: 'r2',
        attempts: [],
        playable: {
          kind: 'audio' as const,
          mimeType: 'audio/ogg',
          url: `https://media.invalid/${track.id}.ogg`,
        },
      }))
      const store = createPlaybackStore({ resolve })
      const track1: Track = {
        id: 'track-1', title: 'Track 1', aliases: {}, games: ['hsr'], relationIds: [],
        tabs: ['focus'], workGroupId: 'wg', vocalStatus: 'instrumental', needsClassification: false,
        sources: [{ provider: 'r2', externalId: 't1.ogg' }],
      }
      const track2: Track = {
        id: 'track-2', title: 'Track 2', aliases: {}, games: ['hsr'], relationIds: [],
        tabs: ['focus'], workGroupId: 'wg', vocalStatus: 'instrumental', needsClassification: false,
        sources: [{ provider: 'r2', externalId: 't2.ogg' }],
      }
      store.enqueue(track1)
      store.enqueue(track2)
      store.setPreloadPolicy('auto')
      await store.playQueueIndex(0)
      await flushPromises()

      const wrapper = mount(PlayerBar, { props: { store } })
      await flushPromises()

      const activeMedia = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
      setDuration(activeMedia.element, 100)
      setBuffered(activeMedia.element, [[0, 25]])
      await activeMedia.trigger('loadedmetadata')
      await activeMedia.trigger('progress')
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('[data-player-buffer-segment]')).toHaveLength(1)
      expect(wrapper.findAll('[data-player-buffer-segment]')[0].attributes('style')).toContain('width: 25%')

      // Force arming by entering lead window (remaining 15s <= 20s)
      activeMedia.element.currentTime = 85
      await activeMedia.trigger('timeupdate')
      await flushPromises()

      const standbyMedia = wrapper.find<HTMLAudioElement>('[data-audio-role="standby"]')
      expect(standbyMedia.exists()).toBe(true)
      if (standbyMedia.exists()) {
        setDuration(standbyMedia.element, 100)
        setBuffered(standbyMedia.element, [[0, 95]])
        await standbyMedia.trigger('progress')
        await wrapper.vm.$nextTick()

        // Active buffer must still reflect 25%, not standby's 95%
        expect(wrapper.findAll('[data-player-buffer-segment]')).toHaveLength(1)
        expect(wrapper.findAll('[data-player-buffer-segment]')[0].attributes('style')).toContain('width: 25%')

        // Now active track ends -> standby is promoted to active!
        await activeMedia.trigger('ended')
        await flushPromises()

        const newlyActiveMedia = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
        expect(newlyActiveMedia.element).toBe(standbyMedia.element)
        await newlyActiveMedia.trigger('loadedmetadata')
        await newlyActiveMedia.trigger('progress')
        await wrapper.vm.$nextTick()

        // Buffer UI must now switch to the promoted deck's 95% buffered progress
        expect(wrapper.findAll('[data-player-buffer-segment]')).toHaveLength(1)
        expect(wrapper.findAll('[data-player-buffer-segment]')[0].attributes('style')).toContain('width: 95%')
        expect(wrapper.get('[data-player-buffer]').attributes('data-buffered-extent')).toBe('0.0%-95.0%')
      }
      mediaPlay.mockRestore()
      wrapper.unmount()
      store.dispose()
    })

    it('does not render buffer segments when duration is unknown or zero', async () => {
      const store = audioStoreStub()
      const wrapper = mount(PlayerBar, { props: { store } })
      const media = wrapper.get<HTMLAudioElement>('audio')
      setDuration(media.element, 0)
      setBuffered(media.element, [[0, 50]])
      await media.trigger('progress')
      await wrapper.vm.$nextTick()

      expect(wrapper.findAll('[data-player-buffer-segment]')).toHaveLength(0)
      expect(wrapper.get('[data-player-buffer]').attributes('data-buffered-extent')).toBeUndefined()
    })

    it('renders 100% buffer width when media is fully buffered', async () => {
      const store = audioStoreStub()
      const wrapper = mount(PlayerBar, { props: { store } })
      const media = wrapper.get<HTMLAudioElement>('audio')
      setDuration(media.element, 120)
      setBuffered(media.element, [[0, 120]])
      await media.trigger('loadedmetadata')
      await media.trigger('progress')
      await wrapper.vm.$nextTick()

      const segments = wrapper.findAll('[data-player-buffer-segment]')
      expect(segments).toHaveLength(1)
      expect(segments[0].attributes('style')).toContain('left: 0%')
      expect(segments[0].attributes('style')).toContain('width: 100%')
      expect(wrapper.get('[data-player-buffer]').attributes('data-buffered-extent')).toBe('0.0%-100.0%')
    })

    it('keeps played progress independent from buffered progress', async () => {
      const store = audioStoreStub()
      const wrapper = mount(PlayerBar, { props: { store } })
      const media = wrapper.get<HTMLAudioElement>('audio')
      setDuration(media.element, 200)
      media.element.currentTime = 30
      setBuffered(media.element, [[0, 160]])
      await media.trigger('loadedmetadata')
      await media.trigger('timeupdate')
      await media.trigger('progress')
      await wrapper.vm.$nextTick()

      expect(wrapper.get('[data-player-played]').attributes('style')).toContain('--played-percent: 15')
      expect(wrapper.findAll('[data-player-buffer-segment]')[0].attributes('style')).toContain('width: 80%')

      media.element.currentTime = 50
      await media.trigger('timeupdate')
      await wrapper.vm.$nextTick()

      expect(wrapper.get('[data-player-played]').attributes('style')).toContain('--played-percent: 25')
      expect(wrapper.findAll('[data-player-buffer-segment]')[0].attributes('style')).toContain('width: 80%')
    })
  })

  describe('artwork presentation and quality metadata', () => {
    it('uses same-track Jellyfin artwork once after ChKSz image failure without changing playback', async () => {
      const store = audioStoreStub()
      const track = store.currentTrack.value!
      track.sources = [
        { provider: 'chksz', externalId: '12345' },
        { provider: 'jellyfin', externalId: '6213b704a0d954293110f4d561b0f614' },
      ]
      ;(store.activeProviderId as Ref<string | undefined>).value = 'chksz'
      ;(store.enabledProviderIds as Ref<readonly string[]>).value = ['chksz', 'jellyfin']
      const primary = '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fbroken.jpg'
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio', url: 'https://media.invalid/chksz.mp3', mimeType: 'audio/mpeg',
        metadata: { artworkUrl: primary, quality: { tier: 'lossless' } },
      }
      const response = new Response(JSON.stringify({
        url: '/api/providers/jellyfin/media/6213b704a0d954293110f4d561b0f614/abcdefghijklmnopqrstuvwxyz123456',
        mimeType: 'audio/flac',
        metadata: { artworkUrl: '/api/providers/jellyfin/artwork/6213b704a0d954293110f4d561b0f614' },
      }), { headers: { 'content-type': 'application/json' } })
      Object.defineProperty(response, 'url', { value: `${window.location.origin}/api/providers/jellyfin/resolve` })
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
      const wrapper = mount(PlayerBar, { props: { store } })
      await wrapper.get('[data-player-artwork-image]').trigger('error')
      await flushPromises()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toEqual({
        externalId: '6213b704a0d954293110f4d561b0f614',
      })
      expect(wrapper.get('[data-player-artwork-image]').attributes('src')).toContain('/api/providers/jellyfin/artwork/')
      await wrapper.get('[data-player-artwork-image]').trigger('error')
      await flushPromises()
      expect(wrapper.find('[data-player-artwork-fallback]').exists()).toBe(true)
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio', url: 'https://media.invalid/chksz.mp3', mimeType: 'audio/mpeg',
        metadata: { artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fupdated.jpg', quality: { tier: 'lossless' } },
      }
      await wrapper.vm.$nextTick()
      await wrapper.get('[data-player-artwork-image]').trigger('error')
      await flushPromises()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(store.activeProviderId.value).toBe('chksz')
      expect(store.playable.value?.metadata?.quality?.tier).toBe('lossless')
      expect(store.queue.value).toEqual([track])
      expect(store.setSourceOverride).not.toHaveBeenCalled()
    })

    it.each([
      ['no Jellyfin source', false, true],
      ['Jellyfin disabled', true, false],
    ])('does not resolve fallback with %s', async (_label, sourcePresent, enabled) => {
      const store = audioStoreStub()
      ;(store.activeProviderId as Ref<string | undefined>).value = 'chksz'
      store.currentTrack.value!.sources = [
        { provider: 'chksz', externalId: '12345' },
        ...(sourcePresent ? [{ provider: 'jellyfin', externalId: '6213b704a0d954293110f4d561b0f614' }] : []),
      ]
      ;(store.enabledProviderIds as Ref<readonly string[]>).value = enabled ? ['chksz', 'jellyfin'] : ['chksz']
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio', url: 'https://media.invalid/chksz.mp3', mimeType: 'audio/mpeg',
        metadata: { artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fbad.jpg' },
      }
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const wrapper = mount(PlayerBar, { props: { store } })
      await wrapper.get('[data-player-artwork-image]').trigger('error')
      await flushPromises()
      expect(wrapper.find('[data-player-artwork-fallback]').exists()).toBe(true)
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('does not resolve Jellyfin when ChKSz artwork succeeds', async () => {
      const store = audioStoreStub()
      ;(store.activeProviderId as Ref<string | undefined>).value = 'chksz'
      store.currentTrack.value!.sources = [
        { provider: 'chksz', externalId: '12345' },
        { provider: 'jellyfin', externalId: '6213b704a0d954293110f4d561b0f614' },
      ]
      ;(store.enabledProviderIds as Ref<readonly string[]>).value = ['chksz', 'jellyfin']
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio', url: 'https://media.invalid/chksz.mp3', mimeType: 'audio/mpeg',
        metadata: { artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fgood.jpg' },
      }
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      const wrapper = mount(PlayerBar, { props: { store } })
      await flushPromises()
      expect(wrapper.get('[data-player-artwork-image]').attributes('src')).toContain('chksz/artwork')
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('tries Jellyfin once when ChKSz has no artwork URL and ends at the generic fallback on network failure', async () => {
      const store = audioStoreStub()
      ;(store.activeProviderId as Ref<string | undefined>).value = 'chksz'
      store.currentTrack.value!.sources = [
        { provider: 'chksz', externalId: '12345' },
        { provider: 'jellyfin', externalId: '6213b704a0d954293110f4d561b0f614' },
      ]
      ;(store.enabledProviderIds as Ref<readonly string[]>).value = ['chksz', 'jellyfin']
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'))
      const wrapper = mount(PlayerBar, { props: { store } })
      await flushPromises()
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(wrapper.find('[data-player-artwork-fallback]').exists()).toBe(true)
      expect(store.activeProviderId.value).toBe('chksz')
    })
    it('renders real album artwork when artworkUrl is present and hides fallback', () => {
      const store = audioStoreStub()
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio',
        url: 'https://media.invalid/custom.ogg',
        mimeType: 'audio/ogg',
        metadata: {
          artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Ffixture-artwork.jpg',
        },
      }
      const wrapper = mount(PlayerBar, { props: { store } })

      const image = wrapper.find('[data-player-artwork-image]')
      expect(image.exists()).toBe(true)
      expect(image.attributes('src')).toBe('/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Ffixture-artwork.jpg')
      expect(image.attributes('alt')).toBe('Album artwork for Embers')
      expect(wrapper.find('[data-player-artwork-fallback]').exists()).toBe(false)
    })

    it('falls back to the icon and hides the broken image when artwork fails to load', async () => {
      const store = audioStoreStub()
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio',
        url: 'https://media.invalid/custom.ogg',
        mimeType: 'audio/ogg',
        metadata: {
          artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fmissing.jpg',
        },
      }
      const wrapper = mount(PlayerBar, { props: { store } })

      const image = wrapper.get('[data-player-artwork-image]')
      await image.trigger('error')

      expect(wrapper.find('[data-player-artwork-image]').exists()).toBe(false)
      expect(wrapper.find('[data-player-artwork-fallback]').exists()).toBe(true)
    })

    it('recovers artwork display when playback generation advances after an artwork failure', async () => {
      const store = audioStoreStub()
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio',
        url: 'https://media.invalid/track1.ogg',
        mimeType: 'audio/ogg',
        metadata: {
          artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fbroken.jpg',
        },
      }
      const wrapper = mount(PlayerBar, { props: { store } })
      expect(wrapper.find('[data-player-artwork-image]').exists()).toBe(true)

      await wrapper.get('[data-player-artwork-image]').trigger('error')
      expect(wrapper.find('[data-player-artwork-image]').exists()).toBe(false)
      expect(wrapper.find('[data-player-artwork-fallback]').exists()).toBe(true)

      ;(store.playbackGeneration as Ref<number>).value += 1
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio',
        url: 'https://media.invalid/track2.ogg',
        mimeType: 'audio/ogg',
        metadata: {
          artworkUrl: '/api/providers/jellyfin/artwork/jellyfin-track-2',
        },
      }
      await wrapper.vm.$nextTick()

      const restoredImage = wrapper.find('[data-player-artwork-image]')
      expect(restoredImage.exists()).toBe(true)
      expect(restoredImage.attributes('src')).toBe('/api/providers/jellyfin/artwork/jellyfin-track-2')
      expect(wrapper.find('[data-player-artwork-fallback]').exists()).toBe(false)
    })

    it('renders artwork in compact/collapsed mode with square artwork container', () => {
      const store = audioStoreStub()
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio',
        url: 'https://media.invalid/custom.ogg',
        mimeType: 'audio/ogg',
        metadata: {
          artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Ffixture.jpg',
        },
      }
      const wrapper = mount(PlayerBar, { props: { store, compact: true } })

      expect(wrapper.classes()).toContain('player-bar--collapsed')
      const artwork = wrapper.find('.player-bar__artwork')
      expect(artwork.exists()).toBe(true)
      const image = wrapper.find('[data-player-artwork-image]')
      expect(image.exists()).toBe(true)
      expect(image.attributes('src')).toBe('/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Ffixture.jpg')
    })

    it('renders fallback icon when artworkUrl is absent', () => {
      const store = audioStoreStub()
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio',
        url: 'https://media.invalid/custom.ogg',
        mimeType: 'audio/ogg',
      }
      const wrapper = mount(PlayerBar, { props: { store } })

      expect(wrapper.find('[data-player-artwork-image]').exists()).toBe(false)
      expect(wrapper.find('[data-player-artwork-fallback]').exists()).toBe(true)
    })

    it.each([
      [
        'FLAC · 24-bit · 96 kHz',
        { codec: 'FLAC', bitDepth: 24, sampleRate: 96000 },
        'FLAC · 24-bit · 96 kHz',
      ],
      [
        'FLAC · 44.1 kHz',
        { codec: 'FLAC', sampleRate: 44100 },
        'FLAC · 44.1 kHz',
      ],
      [
        'MP3 · 320 kbps',
        { codec: 'MP3', bitrate: 320000 },
        'MP3 · 320 kbps',
      ],
      [
        'Lossless tier',
        { tier: 'lossless' },
        'Lossless',
      ],
      [
        'Hi-Res tier',
        { tier: 'hires' },
        'Hi-Res',
      ],
      [
        'Standard tier',
        { tier: 'standard' },
        'Standard',
      ],
      [
        'Immersive tier (sky)',
        { tier: 'sky' },
        'Immersive',
      ],
    ])('displays actual playback quality %s without exposing provider names', (_label, quality, expectedText) => {
      const store = audioStoreStub()
      ;(store.activeProviderId as Ref<any>).value = 'jellyfin'
      ;(store.playable as Ref<Playable | null>).value = {
        kind: 'audio',
        url: 'https://media.invalid/custom.flac',
        mimeType: 'audio/flac',
        metadata: {
          quality,
        },
      }
      const wrapper = mount(PlayerBar, { props: { store } })

      const qualityElement = wrapper.get('[data-player-quality]')
      expect(qualityElement.text()).toBe(expectedText)
      expect(qualityElement.text()).not.toContain('Jellyfin')
      expect(qualityElement.text()).not.toContain('ChKSz')
      expect(qualityElement.text()).not.toContain('LX Music')

      const releaseElement = wrapper.get('[data-player-release-provider]')
      expect(releaseElement.text()).toBe(expectedText)
    })

    it('announces clean playing status without provider name', () => {
      const store = audioStoreStub()
      ;(store.activeProviderId as Ref<any>).value = 'chksz'
      ;(store.status as Ref<any>).value = 'playing'
      const wrapper = mount(PlayerBar, { props: { store } })

      const status = wrapper.get('.player-bar__status').text()
      expect(status).toBe('Playing')
      expect(status).not.toContain('ChKSz')
      expect(status).not.toContain('Playing from')
    })
  })
})

// Wave A verify-first checks (P95-03, P95-04). A pass on 8309e3a refutes the finding.
describe('PlayerBar verify first (Wave A)', () => {
  function stalledLxStore() {
    const track: Track = {
      id: 'verify-first', title: 'Verify first', aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'],
      workGroupId: 'wg', vocalStatus: 'instrumental', needsClassification: false,
      sources: [{ provider: 'lx', externalId: 'lx' }, { provider: 'gd-studio', externalId: 'netease:123:320' }],
    }
    const gd = vi.fn(async () => ({ kind: 'audio' as const, url: '/gd.mp3', mimeType: 'audio/mpeg' }))
    const lx = vi.fn(async () => ({ kind: 'audio' as const, url: '/lx.mp3', mimeType: 'audio/mpeg' }))
    const registry = new ProviderRegistry([
      { provider: { id: 'lx', resolve: lx }, enabled: true, priority: 1, timeoutMs: 300_000 },
      { provider: { id: 'gd-studio', resolve: gd }, enabled: true, priority: 2, timeoutMs: 100 },
    ])
    return { track, lx, gd, store: createPlaybackStore({ registry }) }
  }

  it('P95-03: a timer lease taken after a native pause does not call play() on release', async () => {
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const { store, track } = stalledVkeysStore()
    await store.playNow(track)
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      await flushPromises()
      const media = wrapper.get('[data-audio-role="active"]')
      await media.trigger('playing')
      // The OS pauses the element (not a user pause, not the end of the track).
      await media.trigger('pause')
      const playCount = mediaPlay.mock.calls.length
      const lease = playbackCommands.pauseForInterruption()
      lease?.resumeIfStillOwned()
      await flushPromises()
      expect(mediaPlay).toHaveBeenCalledTimes(playCount)
    } finally { wrapper.unmount(); store.dispose() }
  })

  it('P95-04: a 9 s stall timer delivered after 60 s three times with currentTime unchanged starts one recovery', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const { store, track, lx, gd } = stalledLxStore()
    lx.mockResolvedValueOnce({ kind: 'audio', url: '/lx.mp3', mimeType: 'audio/mpeg' })
      .mockImplementation(() => new Promise<never>(() => {}))
    await store.playNow(track)
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      await vi.advanceTimersByTimeAsync(0)
      const media = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
      await media.trigger('playing')
      expect(store.activeProviderId.value).toBe('lx')
      for (let firing = 0; firing < 3; firing += 1) {
        // The tab was throttled: the clock jumps 60 s, then the 9 s timer is finally delivered.
        vi.setSystemTime(Date.now() + 60_000)
        await vi.advanceTimersByTimeAsync(9_000)
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(media.element.currentTime).toBe(0)
      expect(lx).toHaveBeenCalledTimes(2)
      expect(gd).not.toHaveBeenCalled()
      expect(store.activeProviderId.value).toBe('lx')
    } finally { wrapper.unmount(); store.dispose() }
  })

  it('P95-04: a 9 s stall timer delivered after 60 s three times with currentTime unchanged renews each source once and exhausts the stalled chain', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    const { store, track, vkeys, gd } = stalledVkeysStore()
    await store.playNow(track)
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      await vi.advanceTimersByTimeAsync(0)
      const media = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]')
      await media.trigger('playing')
      expect(store.activeProviderId.value).toBe('vkeys')
      for (let firing = 0; firing < 3; firing += 1) {
        // The tab was throttled: the clock jumps 60 s, then the 9 s timer is finally delivered.
        vi.setSystemTime(Date.now() + 60_000)
        await vi.advanceTimersByTimeAsync(9_000)
        if (firing === 0) {
          expect(vkeys).toHaveBeenCalledTimes(2)
          expect(gd).not.toHaveBeenCalled()
        }

      }
      await vi.advanceTimersByTimeAsync(0)
      expect(media.element.currentTime).toBe(0)
      expect(vkeys).toHaveBeenCalledTimes(2)
      expect(gd).toHaveBeenCalledTimes(2)
      expect(store.activeProviderId.value).toBe('gd-studio')
      // Neither source made progress: the next normal deadline halts instead of looping.
      await vi.advanceTimersByTimeAsync(9_000)
      expect(vkeys).toHaveBeenCalledTimes(2)
      expect(gd).toHaveBeenCalledTimes(2)
      expect(store.status.value).toBe('error')
      expect(store.currentTrack.value).toBe(track)
      expect(store.pendingResumePosition.value).toBe(0)
    } finally { wrapper.unmount(); store.dispose() }
  })
})

describe('LX same-track artwork presentation',()=>{
 beforeEach(()=>vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{}))
 function lxStore(sources:Track['sources']=[{provider:'chksz',externalId:'2155423467'}]){
  const store=audioStoreStub();store.activeProviderId=ref('lx');store.enabledProviderIds=ref(['lx']);store.manualProviderIds=ref(['lx']);store.playbackIntent=ref('paused')
  ;(store.currentTrack as Ref<Track|undefined>).value={...store.currentTrack.value!,id:'lx-first',sources}
  return store
 }
 it('uses the exact NetEase binding through the LX proxy while Jellyfin is disabled and audio state stays unchanged',async()=>{
  const store=lxStore(),playable=store.playable.value,generation=store.playbackGeneration.value,queue=store.queue.value,resolveSpy=vi.spyOn(globalThis,'fetch');const wrapper=mount(PlayerBar,{props:{store}})
  const compact=mount(CompactPlayback,{props:{store}})
  await flushPromises();expect(wrapper.get('[data-player-artwork-image]').attributes('src')).toBe('/api/providers/lx/artwork/2155423467')
  expect(compact.get('.compact-playback__artwork img').attributes('src')).toBe('/api/providers/lx/artwork/2155423467')
  expect(store.playable.value).toBe(playable);expect(store.playbackGeneration.value).toBe(generation);expect(store.queue.value).toBe(queue);expect(store.activeProviderId.value).toBe('lx');expect(store.setSourceOverride).not.toHaveBeenCalled();expect(resolveSpy).not.toHaveBeenCalled();compact.unmount();wrapper.unmount()
 })
 it('accepts a wy LX binding without a ChKSz source',async()=>{
  const store=lxStore([{provider:'lx',externalId:'wy:2155423467:128k'}]);const wrapper=mount(PlayerBar,{props:{store}});await flushPromises();expect(wrapper.get('[data-player-artwork-image]').attributes('src')).toBe('/api/providers/lx/artwork/2155423467');wrapper.unmount()
 })
 it.each([
  {label:'non-NetEase platform',sources:[{provider:'lx',externalId:'tx:2155423467'}]},
  {label:'invalid wy id',sources:[{provider:'lx',externalId:'wy:../private'}]},
  {label:'Jellyfin-only binding',sources:[{provider:'jellyfin',externalId:'6213b704a0d954293110f4d561b0f614'}]},
 ])('does not guess cover identity for $label',async ({sources})=>{
  const wrapper=mount(PlayerBar,{props:{store:lxStore(sources)}});await flushPromises();expect(wrapper.find('[data-player-artwork-image]').exists()).toBe(false);wrapper.unmount()
 })
 it('refuses to use the LX proxy when LX is no longer enabled',async()=>{const store=lxStore();store.enabledProviderIds=ref([]);const wrapper=mount(PlayerBar,{props:{store}});await flushPromises();expect(wrapper.find('[data-player-artwork-image]').exists()).toBe(false);wrapper.unmount()})
 it('shows a fallback on image failure without switching or resolving audio',async()=>{
  const store=lxStore(),playable=store.playable.value,wrapper=mount(PlayerBar,{props:{store}});await flushPromises();await wrapper.get('[data-player-artwork-image]').trigger('error');await flushPromises();expect(wrapper.find('[data-player-artwork-fallback]').exists()).toBe(true);expect(store.playable.value).toBe(playable);expect(store.setSourceOverride).not.toHaveBeenCalled();wrapper.unmount()
 })
 it('ignores a previous track image error after a generation change',async()=>{
  const store=lxStore(),wrapper=mount(PlayerBar,{props:{store}});await flushPromises();const previous=wrapper.get<HTMLImageElement>('[data-player-artwork-image]').element
  ;(store.currentTrack as Ref<Track|undefined>).value={...store.currentTrack.value!,id:'lx-second',sources:[{provider:'chksz',externalId:'123456'}]};(store.playbackGeneration as Ref<number>).value++
  await wrapper.vm.$nextTick();previous.dispatchEvent(new Event('error'));await flushPromises();expect(wrapper.get('[data-player-artwork-image]').attributes('src')).toBe('/api/providers/lx/artwork/123456');wrapper.unmount()
 })
})


describe('independent GD Studio artwork presentation', () => {
  it.each([
    { label: 'canonical fallback', sources: [{ provider: 'chksz', externalId: '2155423467' }], expected: '/api/providers/gd-studio/artwork/2155423467' },
    { label: 'explicit ID takes priority', sources: [{ provider: 'chksz', externalId: '123456' }, { provider: 'gd-studio', externalId: 'netease:2155423467:320' }], expected: '/api/providers/gd-studio/artwork/2155423467' },
    { label: 'explicit non-NetEase source', sources: [{ provider: 'gd-studio', externalId: 'tencent:123456:320' }, { provider: 'chksz', externalId: '2155423467' }], expected: null },
    { label: 'invalid explicit source', sources: [{ provider: 'gd-studio', externalId: 'netease:../private' }, { provider: 'chksz', externalId: '2155423467' }], expected: null },
  ])('matches the resolved binding for $label', async ({ sources, expected }) => {
    const store = audioStoreStub()
    store.activeProviderId = ref('gd-studio')
    store.enabledProviderIds = ref(['gd-studio'])
    store.playbackIntent = ref('paused')
    ;(store.currentTrack as Ref<Track | undefined>).value = { ...store.currentTrack.value!, sources }
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      await flushPromises()
      const image = wrapper.find('[data-player-artwork-image]')
      if (expected) expect(image.attributes('src')).toBe(expected)
      else expect(image.exists()).toBe(false)
    } finally { wrapper.unmount() }
  })

  it('uses its own cover route with LX disabled and preserves audio state', async () => {
    const store = audioStoreStub()
    store.activeProviderId = ref('gd-studio')
    store.enabledProviderIds = ref(['gd-studio'])
    store.playbackIntent = ref('paused')
    ;(store.currentTrack as Ref<Track | undefined>).value = {
      ...store.currentTrack.value!,
      sources: [{ provider: 'gd-studio', externalId: 'netease:2155423467:320' }],
    }
    const playable = store.playable.value
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      await flushPromises()
      expect(wrapper.get('[data-player-artwork-image]').attributes('src')).toBe('/api/providers/gd-studio/artwork/2155423467')
      expect(store.playable.value).toBe(playable)
      expect(store.setSourceOverride).not.toHaveBeenCalled()
    } finally { wrapper.unmount() }
  })
})
