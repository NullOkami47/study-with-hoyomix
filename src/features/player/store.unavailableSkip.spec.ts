// Wave A exploration (P96-01, P96-04): every terminal playback failure reaches one decision,
// the same-position chain first and then a bounded, announced skip. The cases come from the
// 8309e3a audit probe `zz-audit-p96-01-probe.spec.ts` (store cases D, G, H, I, J, K, M) and
// assert the expected behaviour of design Properties 25, 26, 27 and 28. They fail on 8309e3a.
//
// Real `createPlaybackStore`, the real `resolveTrack`, and the production wiring that
// StudyWorkspace uses (`loadRegistry` only, never a static registry).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { ProviderRegistry, type ProviderRegistration } from './providers/registry'
import type { AudioProvider } from './providers/types'
import { createPlaybackStore, MAX_RECENT_FAILURES, MAX_UNAVAILABLE_SKIPS, type PlaybackStore } from './store'
import { publishPlaybackPresentation } from './presentation'

const sequential = { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} }
const settle = async () => {
  for (let i = 0; i < 80; i += 1) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 80; i += 1) await Promise.resolve()
}
const settleFake = async () => {
  for (let i = 0; i < 80; i += 1) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 80; i += 1) await Promise.resolve()
}

const titleOf = (id: string) => `${id}-title`
const makeTrack = (id: string, providers: string[]): Track => ({
  id, title: titleOf(id), aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: providers.map((provider) => ({ provider, externalId: `${provider}-${id}` })),
}) as unknown as Track

/** A provider that plays only the listed track IDs and throws for everything else. */
function provider(id: string, playable: (trackId: string, call: number) => boolean): AudioProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    id, calls,
    canResolve: (track: Track) => track.sources.some((source) => source.provider === id),
    resolve: vi.fn(async (track: Track) => {
      calls.push(track.id)
      if (!playable(track.id, calls.filter((c) => c === track.id).length)) throw new Error(`${id} cannot play ${track.id}`)
      return { kind: 'audio' as const, url: `https://media.invalid/${id}/${track.id}-${calls.length}.mp3`, mimeType: 'audio/mpeg' }
    }),
  } as unknown as AudioProvider & { calls: string[] }
}
const reg = (p: AudioProvider, priority: number, extra: Partial<ProviderRegistration> = {}): ProviderRegistration =>
  ({ provider: p, enabled: true, priority, timeoutMs: 100, ...extra }) as ProviderRegistration

function productionStore(registrations: ProviderRegistration[], tracks: Track[], load?: () => Promise<ProviderRegistry>) {
  const registry = new ProviderRegistry(registrations)
  const store = createPlaybackStore({ loadRegistry: load ?? (async () => registry), storage: sequential })
  store.reconcileUpcomingQueue(tracks)
  return store
}

// The notice and diagnostics surface added by Wave A (design store item 11). Read through a
// narrow view so these specs compile before and after the fix.
interface NoticeView { kind: string; trackId?: string; title?: string; source?: string }
interface RecentFailureView { trackId?: string; title?: string; origin?: string; attempts?: readonly unknown[] }
const notices = (store: PlaybackStore): NoticeView[] =>
  (store as unknown as { playbackNotices?: { value: NoticeView[] } }).playbackNotices?.value ?? []
const noticesOf = (store: PlaybackStore, kind: string) => notices(store).filter((notice) => notice.kind === kind)
const recentFailures = (store: PlaybackStore): RecentFailureView[] =>
  (store as unknown as { recentFailures?: { value: RecentFailureView[] } }).recentFailures?.value ?? []
const names = (entry: object, id: string) => JSON.stringify(entry).includes(titleOf(id)) || (entry as { trackId?: string }).trackId === id

beforeEach(() => { window.localStorage.setItem('hoyomix-player-shuffle-v1', 'false') })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('P96-01 terminal failures continue the chain or skip (Properties 25, 26)', () => {
  it('D Play Now of a track outside the filtered queue skips to the first playable track after the return index', async () => {
    const lx = provider('lx', (id) => id !== 'x')
    const store = productionStore([reg(lx, 1)], ['a', 'b'].map((id) => makeTrack(id, ['lx'])))
    try {
      await store.playQueueIndex(0)
      store.reportMediaState('playing', store.playbackGeneration.value)
      await store.playNow(makeTrack('x', ['lx'])); await settle()
      expect(store.queue.value.map(({ id }) => id)).toEqual(['a', 'b', 'x'])
      expect(store.currentTrack.value?.id).toBe('b')
    } finally { store.dispose() }
  })

  it('G a failed same-position Jellyfin recovery exhausts the chain and skips to the next track', async () => {
    const lx = provider('lx', (id, call) => id !== 'a' || call === 1)
    const jellyfin = provider('jellyfin', () => false)
    const store = productionStore([reg(lx, 1), reg(jellyfin, 2)], [makeTrack('a', ['lx', 'jellyfin']), makeTrack('b', ['lx'])])
    try {
      await store.playQueueIndex(0)
      const generation = store.playbackGeneration.value
      store.reportMediaState('playing', generation)
      store.reportMediaState('buffering', generation)
      await store.requestJellyfinFallback('lx', generation, 42, () => true); await settle()
      expect(store.currentTrack.value?.id).toBe('b')
      expect(lx.calls).toContain('b')
    } finally { store.dispose() }
  })

  it('H a stall with Jellyfin disabled in the refreshed registry skips instead of stopping (P95-02 path)', async () => {
    const lx = provider('lx', () => true)
    const store = productionStore([reg(lx, 1), reg(provider('jellyfin', () => true), 2, { enabled: false })],
      [makeTrack('a', ['lx', 'jellyfin']), makeTrack('b', ['lx'])])
    try {
      await store.playQueueIndex(0)
      const generation = store.playbackGeneration.value
      store.reportMediaState('playing', generation)
      store.reportMediaState('buffering', generation)
      await store.requestJellyfinFallback('lx', generation, 42, () => true); await settle()
      expect(store.currentTrack.value?.id).toBe('b')
    } finally { store.dispose() }
  })

  it('I a Jellyfin recovery URL that then fails to load skips to the next track', async () => {
    const lx = provider('lx', (id, call) => id !== 'a' || call === 1)
    const jellyfin = provider('jellyfin', () => true)
    const store = productionStore([reg(lx, 1), reg(jellyfin, 2)], [makeTrack('a', ['lx', 'jellyfin']), makeTrack('b', ['lx'])])
    try {
      await store.playQueueIndex(0)
      let generation = store.playbackGeneration.value
      store.reportMediaState('playing', generation)
      await store.requestJellyfinFallback('lx', generation, 42, () => true); await settle()
      expect(store.activeProviderId.value).toBe('jellyfin')
      generation = store.playbackGeneration.value
      await store.reportPlaybackFailure('jellyfin', generation); await settle()
      expect(store.currentTrack.value?.id).toBe('b')
      expect(store.pendingResumePosition.value).toBeUndefined()
    } finally { store.dispose() }
  })

  it('J1 a registry that fails before its first load is retried after 1 s and then resolves normally', async () => {
    vi.useFakeTimers()
    const registry = new ProviderRegistry([reg(provider('lx', () => true), 1)])
    let loads = 0
    const store = productionStore([], ['a', 'b'].map((id) => makeTrack(id, ['lx'])), async () => {
      loads += 1
      if (loads === 1) throw new Error('config 503')
      return registry
    })
    try {
      await store.playQueueIndex(0); await settleFake()
      await vi.advanceTimersByTimeAsync(1_000); await settleFake()
      expect(loads).toBeGreaterThanOrEqual(2)
      expect(store.currentTrack.value?.id).toBe('a')
      expect(store.status.value).toBe('ready')
      expect(store.activeProviderId.value).toBe('lx')
    } finally { store.dispose() }
  })

  it('J2 a registry that never loads is retried after 1 s, 3 s and 9 s, then shows sources-unavailable without skipping', async () => {
    vi.useFakeTimers()
    let loads = 0
    const store = productionStore([], ['a', 'b'].map((id) => makeTrack(id, ['lx'])), async () => {
      loads += 1
      throw new Error('config 503')
    })
    try {
      await store.playQueueIndex(0); await settleFake()
      for (const delay of [1_000, 3_000, 9_000]) { await vi.advanceTimersByTimeAsync(delay); await settleFake() }
      await vi.advanceTimersByTimeAsync(30_000); await settleFake()
      expect(loads).toBeGreaterThanOrEqual(4)
      expect(store.currentTrack.value?.id).toBe('a')
      expect(noticesOf(store, 'sourcesUnavailable')).toHaveLength(1)
      expect(noticesOf(store, 'skipped')).toHaveLength(0)
    } finally { store.dispose() }
  })

  it('K offline at the moment of failure waits without skipping, then retries the same track once on online', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const lx = provider('lx', (id) => id !== 'a')
    const store = productionStore([reg(lx, 1)], ['a', 'b'].map((id) => makeTrack(id, ['lx'])))
    try {
      await store.playQueueIndex(0); await settle()
      expect(store.currentTrack.value?.id).toBe('a')
      expect(noticesOf(store, 'waitingForNetwork')).toHaveLength(1)
      online.mockReturnValue(true); window.dispatchEvent(new Event('online')); await settle(); await settle()
      expect(lx.calls.filter((id) => id === 'a')).toHaveLength(2)
      expect(store.currentTrack.value?.id).toBe('b')
    } finally { store.dispose() }
  })
})

describe('P96-01 the skip run is bounded and ends with one terminal notice (Property 27)', () => {
  it('M every track unavailable with Repeat All stops within one pass with one queue-unplayable notice', async () => {
    const lx = provider('lx', () => false)
    const tracks = ['a', 'b', 'c', 'd'].map((id) => makeTrack(id, ['lx']))
    const store = productionStore([reg(lx, 1)], tracks)
    try {
      store.setRepeatMode('all')
      await store.playQueueIndex(0); await settle(); await settle()
      expect(lx.calls.length).toBeLessThanOrEqual(tracks.length)
      expect(store.status.value).toBe('error')
      expect(noticesOf(store, 'queueUnplayable')).toHaveLength(1)
    } finally { store.dispose() }
  })

  it('all unavailable with Repeat All, each track reporting playing and then failing, stays within min(MAX_UNAVAILABLE_SKIPS, n - 1) skips', async () => {
    const lx = provider('lx', () => true)
    const tracks = ['a', 'b', 'c', 'd'].map((id) => makeTrack(id, ['lx']))
    const store = productionStore([reg(lx, 1)], tracks)
    const bound = Math.min(MAX_UNAVAILABLE_SKIPS, tracks.length - 1)
    try {
      store.setRepeatMode('all')
      await store.playQueueIndex(0); await settle()
      let skips = 0
      for (let round = 0; round < 3 * tracks.length + MAX_UNAVAILABLE_SKIPS; round += 1) {
        if (store.status.value !== 'ready' && store.status.value !== 'playing') break
        const before = store.currentIndex.value
        const generation = store.playbackGeneration.value
        // `playing` without any currentTime progress is not progress (D31).
        store.reportMediaState('playing', generation)
        await store.reportPlaybackFailure('lx', generation); await settle()
        if (store.currentIndex.value !== before) skips += 1
      }
      expect(skips).toBeLessThanOrEqual(bound)
      expect(store.status.value).toBe('error')
      expect(noticesOf(store, 'queueUnplayable')).toHaveLength(1)
    } finally { store.dispose() }
  })
})

describe('P96-04 every automatic skip is announced and keeps its evidence (Property 28)', () => {
  it('adds one skip notice naming the skipped track and a recent-failures entry kept after the next track starts', async () => {
    const lx = provider('lx', (id) => id !== 'b')
    const store = productionStore([reg(lx, 1)], ['a', 'b', 'c'].map((id) => makeTrack(id, ['lx'])))
    try {
      await store.playQueueIndex(0)
      store.reportMediaState('playing', store.playbackGeneration.value)
      // The listener's own Next into `b` is not announced; the automatic skip past `b` is.
      await store.next(); await settle()
      expect(store.currentTrack.value?.id).toBe('c')
      expect(store.status.value).toBe('ready')
      const skipped = noticesOf(store, 'skipped')
      expect(skipped).toHaveLength(1)
      expect(names(skipped[0]!, 'b')).toBe(true)
      const failure = recentFailures(store).find((entry) => names(entry, 'b'))
      expect(failure, 'recent-failures entry for the skipped track').toBeDefined()
      expect(failure!.attempts?.length ?? 0).toBeGreaterThan(0)
    } finally { store.dispose() }
  })
})

// ---------------------------------------------------------------------------------------------
// Preservation (Property 32, 3.17 and 3.18, task 7). These cases hold on 8309e3a and must keep
// holding after the fix: same queue position, status, active provider, resolve count and
// override. Notices are deliberately not asserted here, because the skip notice and the
// recent-failures entry (Property 28) are the only effects the fix is allowed to add.
// ---------------------------------------------------------------------------------------------

/** Settles until the store stops moving (skips run through microtasks and resolver timers). */
async function settleAll(store: PlaybackStore, p: { calls: string[] }) {
  const state = () => `${store.currentIndex.value}:${store.status.value}:${p.calls.length}`
  // Microtask rounds first (fast), then one macrotask settle to catch anything timer-driven.
  let quiet = 0
  for (let round = 0; round < 60 && quiet < 3; round += 1) {
    const before = state()
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
    quiet = state() === before ? quiet + 1 : 0
  }
  // setImmediate instead of setTimeout(0): on Windows a 0 ms timer can wait a full timer tick.
  await new Promise<void>((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)))
  for (let i = 0; i < 80; i += 1) await Promise.resolve()
}

describe('Preservation: skips that already work (3.18, probe cases A, B, C, F, N)', () => {
  it('A an initial play of a track with no mapped provider advances to the next track', async () => {
    const chksz = provider('chksz', () => true)
    const store = productionStore([reg(chksz, 1)], [makeTrack('a', ['gd-studio']), makeTrack('b', ['chksz'])])
    try {
      await store.playQueueIndex(0); await settleAll(store, chksz)
      expect(store.currentTrack.value?.id).toBe('b')
      expect(store.status.value).toBe('ready')
      expect(store.activeProviderId.value).toBe('chksz')
      expect(chksz.calls).toEqual(['b'])
    } finally { store.dispose() }
  })

  it('B a catalogue track with zero sources advances to the next track', async () => {
    const chksz = provider('chksz', () => true)
    const store = productionStore([reg(chksz, 1)], [makeTrack('a', []), makeTrack('b', ['chksz'])])
    try {
      await store.playQueueIndex(0); await settleAll(store, chksz)
      expect(store.currentTrack.value?.id).toBe('b')
      expect(store.status.value).toBe('ready')
      expect(chksz.calls).toEqual(['b'])
    } finally { store.dispose() }
  })

  it('C next() into a track whose only provider throws advances and clears the manual override', async () => {
    const lx = provider('lx', (id) => id !== 'b')
    const store = productionStore([reg(lx, 1)], ['a', 'b', 'c'].map((id) => makeTrack(id, ['lx'])))
    try {
      await store.playQueueIndex(0)
      await store.setSourceOverride('lx'); await settleAll(store, lx)
      expect(store.sourceOverride.value).toBe('lx')
      await store.next(); await settleAll(store, lx)
      expect(store.currentTrack.value?.id).toBe('c')
      expect(store.status.value).toBe('ready')
      expect(store.activeProviderId.value).toBe('lx')
      expect(store.sourceOverride.value).toBeUndefined()
      expect(lx.calls).toEqual(['a', 'a', 'b', 'c'])
    } finally { store.dispose() }
  })

  it('F a runtime provider failure with no other provider advances to the next track', async () => {
    const lx = provider('lx', (id, call) => id !== 'a' || call === 1)
    const store = productionStore([reg(lx, 1)], ['a', 'b'].map((id) => makeTrack(id, ['lx'])))
    try {
      await store.playQueueIndex(0)
      store.reportMediaState('playing', store.playbackGeneration.value)
      await store.reportPlaybackFailure('lx', store.playbackGeneration.value); await settleAll(store, lx)
      expect(store.currentTrack.value?.id).toBe('b')
      expect(store.status.value).toBe('ready')
      expect(lx.calls).toEqual(['a', 'b'])
    } finally { store.dispose() }
  })

  it('N a prepared-only unavailable track stays put, and Play then advances', async () => {
    const lx = provider('lx', (id) => id !== 'a')
    const store = productionStore([reg(lx, 1)], ['a', 'b'].map((id) => makeTrack(id, ['lx'])))
    try {
      await store.prepareQueueIndex(0); await settleAll(store, lx)
      expect(store.currentTrack.value?.id).toBe('a')
      expect(store.status.value).toBe('error')
      expect(store.playbackIntent.value).toBe('paused')
      await store.play(); await settleAll(store, lx)
      expect(store.currentTrack.value?.id).toBe('b')
      expect(store.status.value).toBe('ready')
      expect(lx.calls).toEqual(['a', 'a', 'b'])
    } finally { store.dispose() }
  })
})

describe('Preservation: unplayable tracks that must not skip (3.17, probe cases E, L)', () => {
  it('E a single-track queue stays on the track with status error', async () => {
    const lx = provider('lx', () => false)
    const store = productionStore([reg(lx, 1)], [makeTrack('a', ['lx'])])
    try {
      await store.playQueueIndex(0); await settleAll(store, lx)
      expect(store.currentTrack.value?.id).toBe('a')
      expect(store.status.value).toBe('error')
      expect(lx.calls).toEqual(['a'])
    } finally { store.dispose() }
  })

  it('L the last track with Repeat Off stays on the track with status error', async () => {
    const lx = provider('lx', (id) => id !== 'b')
    const store = productionStore([reg(lx, 1)], ['a', 'b'].map((id) => makeTrack(id, ['lx'])))
    try {
      await store.playQueueIndex(1); await settleAll(store, lx)
      expect(store.currentTrack.value?.id).toBe('b')
      expect(store.status.value).toBe('error')
      expect(lx.calls).toEqual(['b'])
    } finally { store.dispose() }
  })
})

type Situation = 'select' | 'prepared' | 'preparedThenPlay' | 'runtime' | 'pausedRuntime' | 'noProvider'
type Repeat = 'off' | 'all' | 'one'
interface QueueCase { n: number; repeat: Repeat; unplayable: ReadonlySet<number>; start: number; situation: Situation }
interface QueueOutcome { index: number; status: string; provider: string | null; resolves: number; override: string | null; intent: string }

/**
 * The 8309e3a decision, written out: from a failed current track, step to the next index (Repeat
 * All wraps, Repeat One does not), at most min(MAX_UNAVAILABLE_SKIPS, n - 1) times, and stop on
 * the first playable track or with status `error` on the last failed one.
 */
function skipRun(c: QueueCase, from: number, resolves: number, playable: (index: number) => boolean): QueueOutcome {
  let index = from
  let skips = 0
  for (;;) {
    const target = index + 1 < c.n ? index + 1 : c.repeat === 'all' && c.n > 1 ? 0 : -1
    if (target < 0 || skips >= Math.min(MAX_UNAVAILABLE_SKIPS, c.n - 1)) {
      return { index, status: 'error', provider: null, resolves, override: null, intent: 'playing' }
    }
    skips += 1; index = target; resolves += 1
    if (playable(index)) return { index, status: 'ready', provider: 'lx', resolves, override: null, intent: 'playing' }
  }
}

function expectedOutcome(c: QueueCase): QueueOutcome {
  const playable = (index: number) => !c.unplayable.has(index)
  const stay = (status: string, resolves: number, intent: string): QueueOutcome =>
    ({ index: c.start, status, provider: status === 'ready' ? 'lx' : null, resolves, override: null, intent })
  switch (c.situation) {
    case 'noProvider': return stay('error', 0, 'playing')
    case 'prepared': return stay(playable(c.start) ? 'ready' : 'error', 1, 'paused')
    case 'select': return playable(c.start) ? stay('ready', 1, 'playing') : skipRun(c, c.start, 1, playable)
    case 'preparedThenPlay':
      return playable(c.start) ? stay('ready', 1, 'playing') : skipRun(c, c.start, 2, playable)
    // The current track played once and then failed; the re-resolve excludes the failed provider,
    // so it costs no provider call, and that track cannot play again.
    case 'runtime': return skipRun(c, c.start, 1, (index) => playable(index) && index !== c.start)
    case 'pausedRuntime': return stay('error', 1, 'paused')
  }
}

async function observeOutcome(c: QueueCase): Promise<QueueOutcome> {
  const ids = Array.from({ length: c.n }, (_, index) => `q${index}`)
  const runtime = c.situation === 'runtime' || c.situation === 'pausedRuntime'
  const lx = provider('lx', (id, call) => {
    const index = ids.indexOf(id)
    if (c.unplayable.has(index)) return false
    return !(runtime && index === c.start && call > 1)
  })
  const store = productionStore([reg(lx, 1, c.situation === 'noProvider' ? { enabled: false } : {})],
    ids.map((id) => makeTrack(id, ['lx'])))
  try {
    store.setRepeatMode(c.repeat)
    if (c.situation === 'prepared' || c.situation === 'preparedThenPlay') {
      await store.prepareQueueIndex(c.start); await settleAll(store, lx)
      if (c.situation === 'preparedThenPlay') { await store.play(); await settleAll(store, lx) }
    } else {
      await store.playQueueIndex(c.start); await settleAll(store, lx)
    }
    if (runtime) {
      const generation = store.playbackGeneration.value
      store.reportMediaState('playing', generation)
      if (c.situation === 'pausedRuntime') { store.pause(); store.reportMediaState('paused', generation) }
      await store.reportPlaybackFailure('lx', generation); await settleAll(store, lx)
    }
    return {
      index: store.currentIndex.value, status: store.status.value, provider: store.activeProviderId.value ?? null,
      resolves: lx.calls.length, override: store.sourceOverride.value ?? null, intent: store.playbackIntent.value,
    }
  } finally { store.dispose() }
}

function* queueCases(): Generator<QueueCase> {
  for (let n = 1; n <= 5; n += 1) {
    for (const repeat of ['off', 'all', 'one'] as const) {
      for (let mask = 0; mask < 1 << n; mask += 1) {
        const unplayable = new Set(Array.from({ length: n }, (_, index) => index).filter((index) => (mask & (1 << index)) !== 0))
        for (let start = 0; start < n; start += 1) {
          for (const situation of ['select', 'prepared', 'preparedThenPlay', 'runtime', 'pausedRuntime', 'noProvider'] as const) {
            // Runtime failures need a current track that played first.
            if ((situation === 'runtime' || situation === 'pausedRuntime') && unplayable.has(start)) continue
            yield { n, repeat, unplayable, start, situation }
          }
        }
      }
    }
  }
}

describe('Preservation: queues of length 1-5 x repeat mode x unplayable subsets (Property 32)', () => {
  it('keeps the queue position, status, active provider, resolve count and override of 8309e3a', async () => {
    const mismatches: string[] = []
    let cases = 0
    for (const c of queueCases()) {
      cases += 1
      const expected = expectedOutcome(c)
      const actual = await observeOutcome(c)
      if (JSON.stringify(actual) !== JSON.stringify(expected) && mismatches.length < 5) {
        mismatches.push(JSON.stringify({ case: { ...c, unplayable: [...c.unplayable] }, expected, actual }))
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([])
    expect(cases).toBeGreaterThan(2_000)
  }, 300_000)
})

// Task 8.6 (D31, P96-04): presented progress, not a `playing` report, ends a skip run; the notice
// and recent-failures lists stay bounded and dismissible.
describe('D31 skip-run reset on presented progress and the bounded notice lists (task 8.6)', () => {
  async function playThenFail(store: PlaybackStore, times: readonly number[]): Promise<boolean> {
    const before = store.currentIndex.value
    const generation = store.playbackGeneration.value
    store.reportMediaState('playing', generation)
    for (const currentTime of times) publishPlaybackPresentation(store, { currentTime, duration: 120, canSeek: true })
    await store.reportPlaybackFailure('lx', generation); await settle()
    return store.currentIndex.value !== before
  }

  it('resets the run after PLAYBACK_PROGRESS_RESET_SECONDS of progress, keeping at most MAX_RECENT_FAILURES entries', async () => {
    const lx = provider('lx', () => true)
    const store = productionStore([reg(lx, 1)], ['a', 'b', 'c', 'd'].map((id) => makeTrack(id, ['lx'])))
    try {
      store.setRepeatMode('all')
      await store.playQueueIndex(0); await settle()
      let skips = 0
      for (let round = 0; round < MAX_RECENT_FAILURES + 2; round += 1) {
        if (await playThenFail(store, [0, 0.5, 1, 1.5, 2, 2.5])) skips += 1
      }
      expect(skips).toBe(MAX_RECENT_FAILURES + 2)
      expect(noticesOf(store, 'queueUnplayable')).toHaveLength(0)
      expect(noticesOf(store, 'skipped')).toHaveLength(MAX_RECENT_FAILURES + 2)
      expect(recentFailures(store)).toHaveLength(MAX_RECENT_FAILURES)

      const [first] = store.playbackNotices.value
      store.dismissNotice(first!.id)
      expect(store.playbackNotices.value.some(({ id }) => id === first!.id)).toBe(false)
      expect(store.playbackNotices.value).toHaveLength(MAX_RECENT_FAILURES + 1)
    } finally { store.dispose() }
  })

  it('does not count a seek or resume jump as progress, so the run stays bounded', async () => {
    const lx = provider('lx', () => true)
    const tracks = ['a', 'b', 'c', 'd'].map((id) => makeTrack(id, ['lx']))
    const store = productionStore([reg(lx, 1)], tracks)
    try {
      store.setRepeatMode('all')
      await store.playQueueIndex(0); await settle()
      let skips = 0
      for (let round = 0; round < 2 * tracks.length; round += 1) {
        if (store.status.value !== 'ready' && store.status.value !== 'playing') break
        if (await playThenFail(store, [0, 42, 42.5])) skips += 1
      }
      expect(skips).toBe(Math.min(MAX_UNAVAILABLE_SKIPS, tracks.length - 1))
      expect(noticesOf(store, 'queueUnplayable')).toHaveLength(1)
    } finally { store.dispose() }
  })
})
