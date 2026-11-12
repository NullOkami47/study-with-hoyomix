// Wave A exploration (P96-06, P96-05 code half, P95-04 handover part): after an automatic advance
// to a preloaded track whose new deck does not make progress, the player shows the starting state
// (never Pause at 0:00), keeps Media Session out of `playing` until progress, and runs a ladder
// step or shows one tap-to-resume notice (design Property 36). Converted from the 8309e3a audit
// probe `zz-audit-p96-06-probe.spec.ts`. H1a, H1b, H2a, H3, H4, H5 and H7 fail on 8309e3a; H8 is a
// recorded observation. The NotAllowedError case at the end covers Property 31 (notice part).
//
// Mounted PlayerBar, real store, real `ProviderRegistry` with `loadRegistry` wiring, real `resolveTrack`.
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { ProviderRegistry, type ProviderRegistration } from './providers/registry'
import type { AudioProvider } from './providers/types'
import { createPlaybackStore, type PlaybackStore } from './store'

describe.each(['lx', 'vkeys'] as const)('%s handover preservation', primaryProvider => {
const sequential = { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} }
const micro = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve() }
const flush = async () => { await micro(); await vi.advanceTimersByTimeAsync(0); await micro() }
const makeTrack = (id: string): Track => ({
  id, title: id, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: primaryProvider, externalId: `vk-${id}` }, { provider: 'gd-studio', externalId: `gd-${id}` }],
}) as unknown as Track
function provider(id: string): AudioProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    id, calls,
    canResolve: (track: Track) => track.sources.some((source) => source.provider === id),
    resolve: vi.fn(async (track: Track) => {
      calls.push(track.id)
      return { kind: 'audio' as const, url: `https://media.invalid/${id}/${track.id}-${calls.length}.mp3`, mimeType: 'audio/mpeg' }
    }),
  } as unknown as AudioProvider & { calls: string[] }
}
const reg = (p: AudioProvider, priority: number): ProviderRegistration =>
  ({ provider: p, enabled: true, priority, timeoutMs: 100 }) as ProviderRegistration
function setDuration(media: HTMLAudioElement, value: number): void {
  Object.defineProperty(media, 'duration', { configurable: true, value })
  Object.defineProperty(media, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => value } })
}
function installMediaSession(): { playbackState: string } {
  const session = { metadata: null, playbackState: 'none', setPositionState: vi.fn(), setActionHandler: vi.fn() }
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
  return session
}

interface NoticeView { kind: string }
const noticesOf = (store: PlaybackStore, kind: string): NoticeView[] =>
  ((store as unknown as { playbackNotices?: { value: NoticeView[] } }).playbackNotices?.value ?? [])
    .filter((notice) => notice.kind === kind)

type PlayImpl = (element: HTMLMediaElement) => Promise<void>
interface Scenario {
  order: 'primary-first' | 'gd-first'
  handoverPlay: PlayImpl
  /** Called right after promotion, with the promoted element (e.g. dispatch 'playing'). */
  afterPromotion?: (element: HTMLAudioElement) => void
  standbyReadyState?: number
  throttled?: boolean
}
const notAllowed: PlayImpl = async () => { throw new DOMException('play() requires a user gesture', 'NotAllowedError') }
const aborted: PlayImpl = async () => { throw new DOMException('interrupted', 'AbortError') }
const pending: PlayImpl = () => new Promise<void>(() => {})
const resolvedNoEvents: PlayImpl = async () => {}
const OBSERVE_MS = 45_000

async function runHandover(scenario: Scenario) {
  vi.useFakeTimers()
  const session = installMediaSession()
  const primary = provider(primaryProvider)
  const gd = provider('gd-studio')
  const registry = new ProviderRegistry(scenario.order === 'primary-first'
    ? [reg(primary, 1), reg(gd, 2)] : [reg(gd, 1), reg(primary, 2)])
  const store: PlaybackStore = createPlaybackStore({ loadRegistry: async () => registry, storage: sequential })
  store.reconcileUpcomingQueue([makeTrack('a'), makeTrack('b')])
  const playCalls: { element: HTMLMediaElement; phase: string }[] = []
  let phase = 'initial'
  let impl: PlayImpl = resolvedNoEvents
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    playCalls.push({ element: this, phase }); return impl(this)
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const wrapper = mount(PlayerBar, { props: { store } })
  try {
    // 1. Track a plays (user gesture) and reaches the preload lead window.
    await store.playQueueIndex(0); await flush()
    const first = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
    first.dispatchEvent(new Event('playing')); await flush()
    setDuration(first, 240)
    first.currentTime = 225
    first.dispatchEvent(new Event('loadedmetadata'))
    first.dispatchEvent(new Event('timeupdate')); await flush()
    const standbyWrapper = wrapper.find<HTMLAudioElement>('[data-audio-role="standby"]')
    expect(standbyWrapper.exists(), 'next track preloaded into the standby deck').toBe(true)
    const standby = standbyWrapper.element
    if (scenario.standbyReadyState !== undefined) {
      Object.defineProperty(standby, 'readyState', { configurable: true, value: scenario.standbyReadyState })
    }
    const resolvesBefore = { primary: primary.calls.length, gd: gd.calls.length }
    // 2. Automatic end of track a (spec order: timeupdate, pause, ended).
    impl = scenario.handoverPlay; phase = 'handover'
    first.currentTime = 240
    Object.defineProperty(first, 'ended', { configurable: true, value: true })
    first.dispatchEvent(new Event('pause'))
    first.dispatchEvent(new Event('ended')); await flush()
    const promoted = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
    const promotedStandby = promoted === standby
    scenario.afterPromotion?.(promoted); await flush()
    // 3. Observe for 45 s (optionally with throttled timers that always fire late).
    for (let t = 0; t < OBSERVE_MS; t += 1_000) {
      if (scenario.throttled && t % 5_000 === 0) vi.setSystemTime(Date.now() + 30_000)
      await vi.advanceTimersByTimeAsync(1_000); await micro()
    }
    const playButton = wrapper.find('[data-player-play]')
    const handoverPlays = playCalls.filter((c) => c.phase === 'handover')
    const newResolves = [...primary.calls.slice(resolvesBefore.primary), ...gd.calls.slice(resolvesBefore.gd)]
    // Ladder step (a): play() on the element that played `a`; step (b): a same-position re-resolve of `b`.
    const ladderStep = handoverPlays.some((c) => c.element === first) || newResolves.includes('b')
    return {
      promotedStandby,
      status: store.status.value,
      intent: store.playbackIntent.value,
      track: store.currentTrack.value?.id,
      transportLabel: playButton.exists() ? playButton.attributes('aria-label') : undefined,
      mediaSessionState: session.playbackState,
      handoverPlayCalls: handoverPlays.length,
      newResolves,
      ladderStep,
      tapToResumeNotices: noticesOf(store, 'tapToResume').length,
      currentTime: promoted.currentTime,
    }
  } finally {
    wrapper.unmount(); store.dispose(); vi.useRealTimers()
  }
}

afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'mediaSession')
})

/** Property 36: the new deck never made progress, so the player must say so or recover. */
const expectStartsRecoversOrSaysSo = (o: Awaited<ReturnType<typeof runHandover>>) => {
  const seen = `(observed ${JSON.stringify(o)})`
  expect(o.promotedStandby, `the preloaded standby deck was promoted ${seen}`).toBe(true)
  expect(o.track, `still on the track that was handed over to ${seen}`).toBe('b')
  expect(o.transportLabel, `starting state instead of Pause at 0:00 ${seen}`).not.toBe('Pause')
  expect(o.mediaSessionState, `Media Session is not playing before progress ${seen}`).not.toBe('playing')
  expect(o.ladderStep || (o.tapToResumeNotices === 1 && o.intent === 'playing'),
    `ladder step or one tap-to-resume notice with intent playing ${seen}`).toBe(true)
}

describe('P96-06 automatic handover to a preloaded deck that does not start (Property 36)', () => {
  it('H1a new deck play() rejects NotAllowedError (primary provider active)', async () => {
    expectStartsRecoversOrSaysSo(await runHandover({ order: 'primary-first', handoverPlay: notAllowed }))
  })
  it('H1b new deck play() rejects NotAllowedError (GD Studio active, primary provider recovery available)', async () => {
    expectStartsRecoversOrSaysSo(await runHandover({ order: 'gd-first', handoverPlay: notAllowed }))
  })
  it('H2a new deck play() never settles, no media events (primary provider active)', async () => {
    expectStartsRecoversOrSaysSo(await runHandover({ order: 'primary-first', handoverPlay: pending }))
  })
  it('H3 play() resolves and "playing" fires, but no timeupdate progress (primary provider active)', async () => {
    expectStartsRecoversOrSaysSo(await runHandover({
      order: 'primary-first', handoverPlay: resolvedNoEvents,
      afterPromotion: (el) => el.dispatchEvent(new Event('playing')),
    }))
  })
  it('H4 play() resolves, element stays paused with buffered data (preloaded, GD Studio active)', async () => {
    expectStartsRecoversOrSaysSo(await runHandover({ order: 'gd-first', handoverPlay: resolvedNoEvents, standbyReadyState: 4 }))
  })
  it('H5 play() never settles, timers always fire late (throttled, GD Studio active) [P95-04]', async () => {
    expectStartsRecoversOrSaysSo(await runHandover({ order: 'gd-first', handoverPlay: pending, throttled: true }))
  })
  it('H7 new deck play() rejects AbortError (primary provider active)', async () => {
    expectStartsRecoversOrSaysSo(await runHandover({ order: 'primary-first', handoverPlay: aborted }))
  })

  // Recorded observation, not a behaviour assertion: with the default order (GD Studio first) the promoted
  // preloaded deck uses the first provider; primary provider is active only when it comes first or the
  // earlier providers are disabled. The only check is that the handover produced an active provider.
  it('H8 default order (GD Studio first): which provider does the promoted preloaded deck use? [observation]', async () => {
    vi.useFakeTimers()
    const primary = provider(primaryProvider); const gd = provider('gd-studio')
    const registry = new ProviderRegistry([reg(gd, 1), reg(primary, 2)])
    const store = createPlaybackStore({ loadRegistry: async () => registry, storage: sequential })
    store.reconcileUpcomingQueue(['a', 'b'].map((id) => ({ ...makeTrack(id), sources: [
      { provider: 'lx', externalId: `lx-${id}` }, { provider: 'gd-studio', externalId: `netease:${id}:320` },
    ] })))
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      await store.playQueueIndex(0); await flush(); await vi.advanceTimersByTimeAsync(500); await flush()
      const first = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
      first.dispatchEvent(new Event('playing'))
      setDuration(first, 120) // a 2-minute track: lead window starts 60 s in, inside the 100 s reuse window
      for (let second = 1; second <= 61; second += 1) {
        first.currentTime = second
        first.dispatchEvent(new Event('timeupdate'))
        await vi.advanceTimersByTimeAsync(1_000); await flush()
      }
      await store.next(); await flush()
      expect(store.activeProviderId.value).toBeDefined()
    } finally { wrapper.unmount(); store.dispose(); vi.useRealTimers() }
  })
})

describe('P96-05 code half: a refused start is visible (Property 31, notice part)', () => {
  it('adds one tap-to-resume notice when play() rejects with NotAllowedError while the intent is playing', async () => {
    vi.useFakeTimers()
    const gd = provider('gd-studio')
    const registry = new ProviderRegistry([reg(gd, 1)])
    const store = createPlaybackStore({ loadRegistry: async () => registry, storage: sequential })
    store.reconcileUpcomingQueue([makeTrack('a'), makeTrack('b')])
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { return notAllowed(this) })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      await store.playQueueIndex(0); await flush(); await vi.advanceTimersByTimeAsync(1_000); await flush()
      expect(store.currentTrack.value?.id).toBe('a')
      expect(store.playable.value?.kind).toBe('audio')
      expect(store.status.value).toBe('paused')
      expect(noticesOf(store, 'tapToResume')).toHaveLength(1)
    } finally { wrapper.unmount(); store.dispose(); vi.useRealTimers() }
  })
})

// ---------------------------------------------------------------------------------------------
// Preservation (Property 37, clauses 3.21 and 3.22, task 7). These cases hold on 8309e3a and must
// keep holding after the fix. They assert queue position, active element, resolve count, renewal
// count and final status, and never the transport label, which the fix changes to the starting
// state until the first progress.
// ---------------------------------------------------------------------------------------------

const allNotices = (store: PlaybackStore): unknown[] =>
  (store as unknown as { playbackNotices?: { value: unknown[] } }).playbackNotices?.value ?? []

interface HandoverContext {
  store: PlaybackStore
  first: HTMLAudioElement
  promoted: HTMLAudioElement
  active: () => HTMLAudioElement
}
interface PreservedScenario {
  order: 'primary-first' | 'gd-first'
  handoverPlay: PlayImpl
  /** Runs once the next track is armed and before track `a` ends (for example, to age the preparation). */
  beforeEnd?: (first: HTMLAudioElement) => Promise<void>
  /** Runs right after the automatic advance, with the promoted element. */
  afterPromotion?: (ctx: HandoverContext) => void
  /** Runs once per observed second. */
  onTick?: (ctx: HandoverContext, second: number) => void
  observeMs?: number
}

async function runPreservedHandover(scenario: PreservedScenario) {
  vi.useFakeTimers()
  installMediaSession()
  const primary = provider(primaryProvider)
  const gd = provider('gd-studio')
  const registry = new ProviderRegistry(scenario.order === 'primary-first'
    ? [reg(primary, 1), reg(gd, 2)] : [reg(gd, 1), reg(primary, 2)])
  const store: PlaybackStore = createPlaybackStore({ loadRegistry: async () => registry, storage: sequential })
  store.reconcileUpcomingQueue([makeTrack('a'), makeTrack('b')])
  const playCalls: { element: HTMLMediaElement; phase: string }[] = []
  let phase = 'initial'
  let impl: PlayImpl = resolvedNoEvents
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    playCalls.push({ element: this, phase }); return impl(this)
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const wrapper = mount(PlayerBar, { props: { store } })
  try {
    await store.playQueueIndex(0); await flush()
    const first = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
    first.dispatchEvent(new Event('playing')); await flush()
    setDuration(first, 240)
    first.currentTime = 225
    first.dispatchEvent(new Event('loadedmetadata'))
    first.dispatchEvent(new Event('timeupdate')); await flush()
    const standbyWrapper = wrapper.find<HTMLAudioElement>('[data-audio-role="standby"]')
    expect(standbyWrapper.exists(), 'next track preloaded into the standby deck').toBe(true)
    const standby = standbyWrapper.element
    const preparedUrl = standby.getAttribute('src')
    await scenario.beforeEnd?.(first)
    const resolvesBefore = { primary: primary.calls.length, gd: gd.calls.length }
    const firstSrcBeforeEnd = first.getAttribute('src')
    impl = scenario.handoverPlay; phase = 'handover'
    first.currentTime = 240
    Object.defineProperty(first, 'ended', { configurable: true, value: true })
    first.dispatchEvent(new Event('pause'))
    first.dispatchEvent(new Event('ended')); await flush()
    const active = () => wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
    const promoted = active()
    const ctx: HandoverContext = { store, first, promoted, active }
    const promotedStandby = promoted === standby
    const firstSrcAfterPromotion = first.getAttribute('src')
    scenario.afterPromotion?.(ctx); await flush()
    const observeMs = scenario.observeMs ?? OBSERVE_MS
    for (let t = 0; t < observeMs; t += 1_000) {
      scenario.onTick?.(ctx, t / 1_000)
      await vi.advanceTimersByTimeAsync(1_000); await micro()
    }
    const handoverPlays = playCalls.filter((c) => c.phase === 'handover')
    const end = active()
    return {
      promotedStandby,
      preparedUrlPromoted: promoted.getAttribute('src') === preparedUrl,
      activeIsPromoted: end === promoted,
      activeIsFirst: end === first,
      activeSrc: end.getAttribute('src'),
      firstSrcBeforeEnd,
      firstSrcAfterPromotion,
      index: store.currentIndex.value,
      track: store.currentTrack.value?.id,
      status: store.status.value,
      intent: store.playbackIntent.value,
      provider: store.activeProviderId.value,
      newResolves: { primary: primary.calls.slice(resolvesBefore.primary), gd: gd.calls.slice(resolvesBefore.gd) },
      handoverPlaysOnFirst: handoverPlays.filter((c) => c.element === first).length,
      handoverPlaysOnPromoted: handoverPlays.filter((c) => c.element === promoted).length,
      notices: allNotices(store).length,
      tapToResumeNotices: noticesOf(store, 'tapToResume').length,
    }
  } finally {
    wrapper.unmount(); store.dispose(); vi.useRealTimers()
  }
}

/** The promoted deck reports `playing` and then advances by one second per observed second. */
const progresses = (ctx: HandoverContext, second: number) => {
  const element = ctx.active()
  if (second === 0) element.dispatchEvent(new Event('playing'))
  element.currentTime = second + 1
  element.dispatchEvent(new Event('timeupdate'))
}

describe('Preservation: handovers that start, pauses and renewals (Property 37)', () => {
  it.each(['primary-first', 'gd-first'] as const)(
    'reuses the promoted deck with no second resolve when the new deck starts and advances (%s)',
    async (order) => {
      const o = await runPreservedHandover({ order, handoverPlay: resolvedNoEvents, onTick: progresses })
      const seen = `(observed ${JSON.stringify(o)})`
      expect(o.promotedStandby, seen).toBe(true)
      expect(o.preparedUrlPromoted, seen).toBe(true)
      expect(o.activeIsPromoted, seen).toBe(true)
      expect(o.newResolves, seen).toEqual({ primary: [], gd: [] })
      expect(o.handoverPlaysOnFirst, seen).toBe(0)
      // The outgoing deck still held `a` until the advance, and was cleared by the promotion.
      expect(o.firstSrcBeforeEnd, seen).toContain('/a-')
      expect(o.firstSrcAfterPromotion, seen).toBeNull()
      expect(o.index, seen).toBe(1)
      expect(o.track, seen).toBe('b')
      expect(o.status, seen).toBe('playing')
      expect(o.intent, seen).toBe('playing')
      expect(o.notices, seen).toBe(0)
    },
  )

  it('re-resolves a preparation older than the 100 s reuse window instead of promoting it', async () => {
    const o = await runPreservedHandover({
      order: 'primary-first', handoverPlay: resolvedNoEvents, onTick: progresses,
      beforeEnd: async (first) => {
        // Track `a` keeps playing (with progress) for 101 s inside the lead window.
        for (let second = 1; second <= 101; second += 1) {
          first.currentTime = 225 + second * 0.1
          first.dispatchEvent(new Event('timeupdate'))
          await vi.advanceTimersByTimeAsync(1_000); await micro()
        }
      },
    })
    const seen = `(observed ${JSON.stringify(o)})`
    expect(o.preparedUrlPromoted, seen).toBe(false)
    expect(o.newResolves, seen).toEqual({ primary: ['b'], gd: [] })
    expect(o.activeSrc, seen).toMatch(new RegExp('/' + primaryProvider + '/b-'))
    expect(o.index, seen).toBe(1)
    expect(o.track, seen).toBe('b')
    expect(o.status, seen).toBe('playing')
    expect(o.notices, seen).toBe(0)
  })

  it.each(['primary-first', 'gd-first'] as const)(
    'honours a listener pause right after the handover with no notice and no ladder step (%s)',
    async (order) => {
      const o = await runPreservedHandover({
        order, handoverPlay: resolvedNoEvents,
        afterPromotion: ({ store, promoted }) => { store.pause(); promoted.dispatchEvent(new Event('pause')) },
      })
      const seen = `(observed ${JSON.stringify(o)})`
      expect(o.activeIsPromoted, seen).toBe(true)
      expect(o.newResolves, seen).toEqual({ primary: [], gd: [] })
      expect(o.handoverPlaysOnFirst, seen).toBe(0)
      expect(o.index, seen).toBe(1)
      expect(o.intent, seen).toBe('paused')
      expect(o.status, seen).toBe('paused')
      expect(o.notices, seen).toBe(0)
    },
  )

  it.each(['primary-first', 'gd-first'] as const)(
    'honours a native pause right after the handover with no notice and no ladder step (%s)',
    async (order) => {
      const o = await runPreservedHandover({
        order, handoverPlay: resolvedNoEvents,
        afterPromotion: ({ promoted }) => { promoted.dispatchEvent(new Event('pause')) },
      })
      const seen = `(observed ${JSON.stringify(o)})`
      expect(o.activeIsPromoted, seen).toBe(true)
      expect(o.newResolves, seen).toEqual({ primary: [], gd: [] })
      expect(o.handoverPlaysOnFirst, seen).toBe(0)
      expect(o.index, seen).toBe(1)
      expect(o.intent, seen).toBe('playing')
      expect(o.status, seen).toBe('paused')
      expect(o.notices, seen).toBe(0)
    },
  )

  it('renews an expired promoted URL once through the same provider when an error arrives before progress', async () => {
    const o = await runPreservedHandover({
      order: 'primary-first', handoverPlay: resolvedNoEvents,
      afterPromotion: ({ promoted }) => { promoted.dispatchEvent(new Event('error')) },
      // The renewed deck starts and advances.
      onTick: progresses,
    })
    const seen = `(observed ${JSON.stringify(o)})`
    expect(o.promotedStandby, seen).toBe(true)
    expect(o.newResolves, seen).toEqual({ primary: ['b'], gd: [] })
    expect(o.activeIsPromoted, seen).toBe(false)
    expect(o.activeSrc, seen).toMatch(new RegExp('/' + primaryProvider + '/b-'))
    expect(o.index, seen).toBe(1)
    expect(o.track, seen).toBe('b')
    expect(o.provider, seen).toBe(primaryProvider)
    expect(o.status, seen).toBe('playing')
    expect(o.intent, seen).toBe('playing')
    expect(o.tapToResumeNotices, seen).toBe(0)
  })

  // Probe controls kept from `zz-audit-p96-06-probe.spec.ts`: on 8309e3a a recovery runs (H2b: the
  // bounded handover watchdog recovers the missing start; H6: `renewMedia` re-resolves
  // `b` on the other element). They keep the probe's assertion: the player recovers or says so,
  // and never shows a playing state with no recovery.
  const expectRecoveredOrNotice = (o: Awaited<ReturnType<typeof runPreservedHandover>>) => {
    const seen = `(observed ${JSON.stringify(o)})`
    const recovered = o.newResolves.primary.length + o.newResolves.gd.length > 0 || o.handoverPlaysOnFirst > 0
    expect(o.promotedStandby, seen).toBe(true)
    expect(o.track, seen).toBe('b')
    expect(o.intent, seen).toBe('playing')
    expect(recovered || o.tapToResumeNotices === 1, `recovery attempted or one tap-to-resume notice ${seen}`).toBe(true)
    expect(o.status, seen).not.toBe('error')
  }
  it('H2b new deck play() never settles (GD Studio active) [control: watchdog armed]', async () => {
    expectRecoveredOrNotice(await runPreservedHandover({ order: 'gd-first', handoverPlay: pending }))
  })
  it('H6 promoted URL expired: error event before any progress (primary provider active) [control: renewMedia]', async () => {
    expectRecoveredOrNotice(await runPreservedHandover({
      order: 'primary-first', handoverPlay: pending, observeMs: 6_000,
      afterPromotion: ({ promoted }) => { promoted.dispatchEvent(new Event('error')) },
    }))
  })
})

// Task 8.7a: the handover watchdog and the retained previous element do not outlive the handover.
describe('P96-06 the handover check is released on a track change and on unmount', () => {
  async function startPendingHandover() {
    vi.useFakeTimers()
    installMediaSession()
    const registry = new ProviderRegistry([reg(provider(primaryProvider), 1), reg(provider('gd-studio'), 2)])
    const store = createPlaybackStore({ loadRegistry: async () => registry, storage: sequential })
    store.reconcileUpcomingQueue([makeTrack('a'), makeTrack('b')])
    let impl: PlayImpl = resolvedNoEvents
    const plays = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) { return impl(this) })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const wrapper = mount(PlayerBar, { props: { store } })
    await store.playQueueIndex(0); await flush()
    const first = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
    first.dispatchEvent(new Event('playing')); await flush()
    setDuration(first, 240)
    first.currentTime = 225
    first.dispatchEvent(new Event('loadedmetadata'))
    first.dispatchEvent(new Event('timeupdate')); await flush()
    impl = pending
    first.currentTime = 240
    Object.defineProperty(first, 'ended', { configurable: true, value: true })
    first.dispatchEvent(new Event('pause'))
    first.dispatchEvent(new Event('ended')); await flush()
    expect(store.currentTrack.value?.id).toBe('b')
    expect(wrapper.find('[data-audio-role="retained"]').exists(), 'previous element kept for step (a)').toBe(true)
    expect(wrapper.get('[data-player-play]').attributes('aria-label')).toBe('Starting playback')
    return { store, wrapper, plays }
  }

  it('a track change during the starting state clears the watchdog and the retained element', async () => {
    const { store, wrapper, plays } = await startPendingHandover()
    try {
      await store.previous(); await flush()
      expect(store.currentTrack.value?.id).toBe('a')
      expect(wrapper.find('[data-audio-role="retained"]').exists()).toBe(false)
      const playsAfterChange = plays.mock.calls.length
      const current = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
      current.dispatchEvent(new Event('playing'))
      // The returned track plays; only the superseded handover must remain cancelled.
      for (let second = 1; second <= 45; second += 1) {
        current.currentTime = second
        current.dispatchEvent(new Event('timeupdate'))
        await vi.advanceTimersByTimeAsync(1_000); await micro()
      }
      expect(plays.mock.calls.length, 'no ladder step after the track change').toBe(playsAfterChange)
      expect(noticesOf(store, 'tapToResume')).toHaveLength(0)
    } finally { wrapper.unmount(); store.dispose(); vi.useRealTimers() }
  })

  it('an unmount during the starting state leaves no ladder step behind', async () => {
    const { store, wrapper, plays } = await startPendingHandover()
    try {
      wrapper.unmount()
      const playsAtUnmount = plays.mock.calls.length
      await vi.advanceTimersByTimeAsync(45_000); await micro()
      expect(plays.mock.calls.length).toBe(playsAtUnmount)
      expect(noticesOf(store, 'tapToResume')).toHaveLength(0)
    } finally { store.dispose(); vi.useRealTimers() }
  })
})
})
