// Shared harness for the Android Chrome PWA automatic-advance specs (task 41): the bug condition
// exploration (`PlayerBar.androidAdvance.spec.ts`, 41.2) and the preservation spec
// (`PlayerBar.androidAdvance.preservation.spec.ts`, 41.3).
//
// Mounted PlayerBar, real store, real `ProviderRegistry`, real `resolveTrack`, fake timers. Only
// `HTMLMediaElement.prototype.play/pause/load` are replaced, by a model of the browser's media
// policy; media events are dispatched by a small per-second driver.
import { mount, type VueWrapper } from '@vue/test-utils'
import { expect, vi } from 'vitest'
import type { Track } from '../../catalog/types'
import PlayerBar from '../PlayerBar.vue'
import { ProviderRegistry, type ProviderRegistration } from '../providers/registry'
import type { AudioProvider } from '../providers/types'
import { createPlaybackStore, type PlaybackStore } from '../store'
import { playbackLog, type PlaybackLogEntry } from '../playbackLog'

const sequential = { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} }
export const micro = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve() }
export const flush = async () => { await micro(); await vi.advanceTimersByTimeAsync(0); await micro() }
export const makeTrack = (id: string): Track => ({
  id, title: id, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'jellyfin', externalId: `jf-${id}` }],
}) as unknown as Track
function jellyfinProvider(): AudioProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    id: 'jellyfin', calls,
    canResolve: () => true,
    resolve: vi.fn(async (track: Track) => {
      calls.push(track.id)
      return { kind: 'audio' as const, url: `https://media.invalid/jellyfin/${track.id}-${calls.length}.mp3`, mimeType: 'audio/mpeg' }
    }),
  } as unknown as AudioProvider & { calls: string[] }
}
const reg = (p: AudioProvider): ProviderRegistration => ({ provider: p, enabled: true, priority: 1, timeoutMs: 100 }) as ProviderRegistration
function setDuration(media: HTMLAudioElement, value: number): void {
  Object.defineProperty(media, 'duration', { configurable: true, value })
  Object.defineProperty(media, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => value } })
}

export type Visibility = 'visible' | 'hidden'
let visibility: Visibility = 'visible'
export function setVisibility(next: Visibility): void {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange'))
}
function installVisibility(): void {
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' })
}

export interface FakeSession {
  playbackState: string
  setActionHandler: ReturnType<typeof vi.fn>
  setPositionState: ReturnType<typeof vi.fn>
  metadata: unknown
}
function installMediaSession(): FakeSession {
  const session: FakeSession = { metadata: null, playbackState: 'none', setPositionState: vi.fn(), setActionHandler: vi.fn() }
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
  return session
}
export function mediaSessionHandler(session: FakeSession, action: string): ((details?: unknown) => void) | undefined {
  const calls = session.setActionHandler.mock.calls.filter(([name]) => name === action)
  return calls.at(-1)?.[1] as ((details?: unknown) => void) | undefined
}

/** Restores the prototype spies, real timers and the page globals the harness replaced. */
export function resetAndroidAdvanceEnvironment(): void {
  vi.restoreAllMocks(); vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'mediaSession')
  Reflect.deleteProperty(document, 'visibilityState')
  Reflect.deleteProperty(document, 'hidden')
}

/**
 * The browser model. `decide` says whether `play()` on an element resolves. A resolved `play()`
 * starts a load of the element's current `src`; the driver makes that load progress once
 * `startDelayMs` has passed since it began (a new `src` on the same element starts over).
 *
 * Opt-in parts (off by default, so the exploration spec sees the original model):
 * - `rejectWith`: the DOMException name of a refused `play()` (default `NotAllowedError`).
 * - `honourPauseAndSeek`: `pause()` stops the load's progress and fires `pause`; progress
 *   continues from the element's `currentTime`, so a seek moves the playback position.
 * - `mediaErrorCode`: when it returns a code for a ready load, the element reports that
 *   `MediaError` code and fires `error` once per load instead of progressing.
 * - `pendingPlayUntilStart`: the HTML spec's promise timing. An allowed `play()` stays pending
 *   until its load fires `playing` (the first progress); a new load or `src` on the element and an
 *   honoured `pause()` reject it with `AbortError`, and a code-4 error with `NotSupportedError`.
 *   Off, an allowed `play()` resolves at once (the original model).
 */
export interface BrowserModel {
  decide: (element: HTMLMediaElement, ctx: { played: boolean; visibility: Visibility }) => 'resolve' | 'reject'
  startDelayMs?: number
  rejectWith?: string
  honourPauseAndSeek?: boolean
  mediaErrorCode?: (src: string) => number | undefined
  pendingPlayUntilStart?: boolean
}
interface PlayWaiter { resolve: () => void; reject: (error: DOMException) => void }
interface Load {
  src: string; startedAt: number; position: number; playingSent: boolean; waitingSent: boolean; paused: boolean; errorSent: boolean
  /** `play()` promises still pending on this load (`pendingPlayUntilStart`). */
  waiters: PlayWaiter[]
}
function settleWaiters(load: Load | undefined, error?: DOMException): void {
  if (!load) return
  const waiters = load.waiters.splice(0)
  for (const waiter of waiters) {
    if (error) waiter.reject(error)
    else waiter.resolve()
  }
}
export interface PlayCall { deck: string | undefined; src: string | null; outcome: string; visibility: Visibility; at: number }

/** Log entries kept in the failure message: the advance, the handover ladder, play() and notices. */
const NOTICE_LOG_TYPES = /^(advance\.|queue\.start|handover\.|play\.|notice\.|store\.recoverHandover|store\.failCurrent|mediaSession\.action|page\.|deck\.)/

export async function setupAndroidAdvance(model: BrowserModel, initialVisibility: Visibility = 'visible') {
  vi.useFakeTimers()
  playbackLog.clear()
  installVisibility()
  const session = installMediaSession()
  const provider = jellyfinProvider()
  const registry = new ProviderRegistry([reg(provider)])
  const store: PlaybackStore = createPlaybackStore({ loadRegistry: async () => registry, storage: sequential })
  store.reconcileUpcomingQueue([makeTrack('a'), makeTrack('b'), makeTrack('c'), makeTrack('d')])
  const played = new WeakSet<HTMLMediaElement>()
  const loads = new Map<HTMLMediaElement, Load>()
  const playCalls: PlayCall[] = []
  // Track `a` starts from the listener's Play (a user gesture); the model applies after that.
  let modelActive = false
  const abortError = () => new DOMException('The play() request was interrupted by a new load request.', 'AbortError')
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function (this: HTMLMediaElement) {
    const outcome = modelActive ? model.decide(this, { played: played.has(this), visibility }) : 'resolve'
    playCalls.push({ deck: this.dataset.audioDeck, src: this.getAttribute('src'), outcome, visibility, at: Date.now() })
    if (outcome === 'reject') throw new DOMException('play() was refused', model.rejectWith ?? 'NotAllowedError')
    const src = this.getAttribute('src') ?? ''
    const load = loads.get(this)
    if (!load || load.src !== src) {
      settleWaiters(load, abortError())
      loads.set(this, { src, startedAt: Date.now(), position: 0, playingSent: false, waitingSent: false, paused: false, errorSent: false, waiters: [] })
      // A new load: the element is no longer the ended element of the previous track.
      Reflect.deleteProperty(this, 'ended')
      Reflect.deleteProperty(this, 'error')
      Object.defineProperty(this, 'networkState', { configurable: true, value: HTMLMediaElement.NETWORK_LOADING })
    } else if (model.honourPauseAndSeek && load.paused) {
      load.paused = false
      load.playingSent = false
    }
    // Track `a`'s gesture start keeps the immediate model; the harness drives its playback itself.
    const current = loads.get(this)
    if (!modelActive || !model.pendingPlayUntilStart || !current || current.playingSent) return
    await new Promise<void>((resolve, reject) => { current.waiters.push({ resolve, reject }) })
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    if (!model.honourPauseAndSeek) return
    const load = loads.get(this)
    if (!load || load.paused || load.src !== this.getAttribute('src')) return
    load.paused = true
    settleWaiters(load, new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'))
    queueMicrotask(() => this.dispatchEvent(new Event('pause')))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (this: HTMLMediaElement) {
    // The load algorithm aborts the play() promises of the replaced resource.
    const load = loads.get(this)
    if (load && load.src !== this.getAttribute('src')) settleWaiters(load, abortError())
  })
  const wrapper: VueWrapper = mount(PlayerBar, { props: { store } })
  const active = () => wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
  /** No active element once the store has no playable (for example after a halted `failCurrent`). */
  const activeOrNull = (): HTMLAudioElement | null => {
    const found = wrapper.find<HTMLAudioElement>('[data-audio-role="active"]')
    return found.exists() ? found.element : null
  }

  /** Track `a` plays in the foreground after the listener's Play, then reaches its preload window. */
  await store.playQueueIndex(0); await flush()
  const first = active()
  played.add(first)
  first.dispatchEvent(new Event('playing')); await flush()
  loads.set(first, { src: first.getAttribute('src') ?? '', startedAt: Date.now(), position: 225, playingSent: true, waitingSent: false, paused: false, errorSent: false, waiters: [] })
  setDuration(first, 240)
  first.currentTime = 225
  first.dispatchEvent(new Event('loadedmetadata'))
  first.dispatchEvent(new Event('timeupdate')); await flush()
  expect(wrapper.find('[data-audio-role="standby"]').exists(), 'next track preloaded into the standby deck').toBe(true)
  expect(playCalls.map((call) => call.outcome), 'track a started on the listener gesture').toEqual(['resolve'])
  modelActive = true
  if (initialVisibility === 'hidden') { setVisibility('hidden'); await flush() }

  const noticeSeen = { max: 0 }
  const notices = () => ((store as unknown as { playbackNotices?: { value: { kind: string }[] } }).playbackNotices?.value ?? [])
  const tapNotices = () => notices().filter((notice) => notice.kind === 'tapToResume').length
  const resolvesOf = (id: string) => provider.calls.filter((call) => call === id).length

  /** One second of the browser: the active element progresses once its load is ready, else buffers. */
  async function tick(): Promise<void> {
    const element = activeOrNull()
    const load = element ? loads.get(element) : undefined
    const src = element?.getAttribute('src')
    if (element && load && load.src === src && !element.ended && !(model.honourPauseAndSeek && load.paused)) {
      const errorCode = model.mediaErrorCode?.(load.src)
      if (Date.now() - load.startedAt >= (model.startDelayMs ?? 0) && errorCode !== undefined) {
        if (!load.errorSent) {
          load.errorSent = true
          Object.defineProperty(element, 'error', { configurable: true, value: { code: errorCode, message: '' } })
          element.dispatchEvent(new Event('error'))
          // The media source failure steps reject pending play() promises; other errors leave them.
          if (errorCode === 4) settleWaiters(load, new DOMException('The element has no supported sources.', 'NotSupportedError'))
        }
      } else if (Date.now() - load.startedAt >= (model.startDelayMs ?? 0)) {
        if (!load.playingSent) {
          load.playingSent = true
          played.add(element)
          Object.defineProperty(element, 'networkState', { configurable: true, value: HTMLMediaElement.NETWORK_IDLE })
          setDuration(element, 240)
          element.dispatchEvent(new Event('playing'))
          // `playing` resolves the pending play() promises (HTML: "notify about playing").
          settleWaiters(load)
        }
        if (model.honourPauseAndSeek) load.position = element.currentTime
        load.position += 1
        element.currentTime = load.position
        element.dispatchEvent(new Event('timeupdate'))
      } else if (!load.waitingSent) {
        load.waitingSent = true
        element.dispatchEvent(new Event('waiting'))
        element.dispatchEvent(new Event('stalled'))
      }
    }
    await vi.advanceTimersByTimeAsync(1_000); await micro()
    noticeSeen.max = Math.max(noticeSeen.max, tapNotices())
  }
  async function observe(ms: number): Promise<void> { for (let t = 0; t < ms; t += 1_000) await tick() }

  /** The automatic end of track `a` (spec order: timeupdate, pause, ended). */
  async function endFirstTrack(): Promise<void> {
    first.currentTime = 240
    Object.defineProperty(first, 'ended', { configurable: true, value: true })
    first.dispatchEvent(new Event('timeupdate'))
    first.dispatchEvent(new Event('pause'))
    first.dispatchEvent(new Event('ended')); await flush()
  }

  function outcome() {
    const entries = playbackLog.snapshot()
    const of = (type: string): PlaybackLogEntry[] => entries.filter((entry) => entry.type === type)
    const element = activeOrNull()
    const trace = entries.filter((entry) => NOTICE_LOG_TYPES.test(entry.type)).map((entry) => {
      const { t: _t, mono: _mono, ...rest } = entry
      return rest
    }).slice(-80)
    return {
      track: store.currentTrack.value?.id,
      status: store.status.value,
      intent: store.playbackIntent.value,
      activeDeck: element?.dataset.audioDeck,
      activeIsFirst: element === first,
      activeSrcTrack: /\/jellyfin\/([a-z])-/.exec(element?.getAttribute('src') ?? '')?.[1] ?? null,
      activeCurrentTime: element?.currentTime ?? null,
      tapToResumeNow: tapNotices(),
      tapToResumeMax: noticeSeen.max,
      tapToResumeAddedInLog: of('notice.add').filter((entry) => entry.kind === 'tapToResume').length,
      tapToResumeRaiseSites: of('notice.tapToResume.raise').map((entry) => entry.site),
      noticeKinds: notices().map((notice) => notice.kind),
      ladderSteps: of('handover.ladder').map((entry) => entry.step),
      watchdogFires: of('handover.watchdog.fire').map((entry) => entry.decision),
      failCurrentOutcomes: of('store.failCurrent').map((entry) => entry.outcome),
      resolvesOfB: resolvesOf('b'),
      mediaSessionState: session.playbackState,
      playCalls,
      trace,
    }
  }

  return { store, wrapper, session, provider, first, active, observe, endFirstTrack, outcome, resolvesOf, playCalls, tapNotices,
    dispose: () => { wrapper.unmount(); store.dispose(); vi.useRealTimers() } }
}

export type AndroidAdvanceHarness = Awaited<ReturnType<typeof setupAndroidAdvance>>
export type AndroidAdvanceOutcome = ReturnType<AndroidAdvanceHarness['outcome']>

/** Chrome Android: `play()` without a gesture is allowed only on an element that already played. */
export const mediaActivation: BrowserModel = { decide: (_element, { played }) => played ? 'resolve' : 'reject' }

export const show = (o: unknown) => `\n(observed ${JSON.stringify(o, null, 1)})`
