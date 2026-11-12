// Wave A exploration (P95-02 residual, P96-02, P96-03): a failed same-position recovery continues
// the configured chain, Play after a failed recovery retries the chain on the same track, and a
// failing manual source keeps the track and the override. Cases come from the 8309e3a audit probe
// `zz-audit-8309e3a-probe.spec.ts` with their assertions inverted to the expected behaviour
// (design Properties 19, 25, 29 and 30). They fail on 8309e3a.
import { describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { publishPlaybackPresentation } from './presentation'
import { ProviderRegistry } from './providers/registry'
import { ProviderResolveError, type AudioProvider } from './providers/types'
import { createPlaybackStore, MEDIA_RENEWAL_INTERVAL_MS, type PlaybackStore } from './store'

const settle = async () => {
  for (let i = 0; i < 80; i += 1) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 80; i += 1) await Promise.resolve()
}
const makeTrack = (id: string, providers: string[]): Track => ({
  id, title: `${id}-title`, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: providers.map((provider) => ({ provider, externalId: `${provider}-${id}` })),
}) as unknown as Track

function failing(id: string): AudioProvider {
  return { id, canResolve: () => true, resolve: vi.fn(async () => { throw new Error(`${id} down`) }) } as AudioProvider
}
function working(id: string): AudioProvider {
  return { id, canResolve: () => true, resolve: vi.fn(async () => ({ kind: 'audio' as const, url: `https://media.invalid/${id}.mp3`, mimeType: 'audio/mpeg' })) } as AudioProvider
}
/** Plays a track on its first resolve only; every later resolve of that track fails. */
function onceThenFailing(id: string): AudioProvider {
  const seen = new Map<string, number>()
  return {
    id, canResolve: () => true,
    resolve: vi.fn(async (track: Track) => {
      const call = (seen.get(track.id) ?? 0) + 1
      seen.set(track.id, call)
      if (call > 1) throw new Error(`${id} down`)
      return { kind: 'audio' as const, url: `https://media.invalid/${id}-${track.id}.mp3`, mimeType: 'audio/mpeg' }
    }),
  } as unknown as AudioProvider
}
const resolvesFor = (p: AudioProvider, trackId: string) =>
  (p.resolve as ReturnType<typeof vi.fn>).mock.calls.filter(([track]) => (track as Track).id === trackId).length

interface NoticeView { kind: string; trackId?: string; source?: string }
const noticesOf = (store: PlaybackStore, kind: string): NoticeView[] =>
  ((store as unknown as { playbackNotices?: { value: NoticeView[] } }).playbackNotices?.value ?? [])
    .filter((notice) => notice.kind === kind)

describe('P95-02 residual: a failed recovery during a stall continues the chain (Properties 19, 25)', () => {
  it('resolves the remaining automatic provider at the saved position when the Jellyfin attempt fails', async () => {
    const chksz = working('chksz')
    const registry = new ProviderRegistry([
      { provider: working('lx'), enabled: true, priority: 1, timeoutMs: 100 },
      { provider: chksz, enabled: true, priority: 2, timeoutMs: 100 },
      { provider: failing('jellyfin'), enabled: true, priority: 3, timeoutMs: 100 },
    ])
    const store = createPlaybackStore({ registry })
    try {
      await store.playNow(makeTrack('t', ['lx', 'chksz', 'jellyfin']))
      const generation = store.playbackGeneration.value
      store.reportMediaState('playing', generation)
      store.reportMediaState('buffering', generation)
      await store.requestJellyfinFallback('lx', generation, 42, () => true); await settle()
      expect(store.status.value).not.toBe('error')
      expect(['ready', 'playing']).toContain(store.status.value)
      expect(store.currentTrack.value?.id).toBe('t')
      expect(store.activeProviderId.value).toBe('chksz')
      expect(store.pendingResumePosition.value).toBe(42)
      expect(chksz.resolve).toHaveBeenCalledTimes(1)
    } finally { store.dispose() }
  })
})

describe('P96-02 Play after a failed recovery retries the configured chain on the same track (Property 29)', () => {
  // `first` is the last track with Repeat Off, so the failed recovery itself halts on `first`
  // (3.17); Repeat All is then switched on, so a skip target exists when the listener presses Play.
  async function failedRecovery(lx: AudioProvider) {
    const registry = new ProviderRegistry([
      { provider: lx, enabled: true, priority: 1, timeoutMs: 100 },
      { provider: failing('jellyfin'), enabled: true, priority: 2, timeoutMs: 100 },
    ])
    const store = createPlaybackStore({ registry })
    store.enqueue(makeTrack('zero', ['lx', 'jellyfin'])); store.enqueue(makeTrack('first', ['lx', 'jellyfin']))
    await store.playQueueIndex(1)
    const generation = store.playbackGeneration.value
    store.reportMediaState('playing', generation)
    store.reportMediaState('buffering', generation)
    await store.requestJellyfinFallback('lx', generation, 42, () => true); await settle()
    expect(store.currentTrack.value?.id).toBe('first')
    expect(store.status.value).toBe('error')
    store.setRepeatMode('all')
    return store
  }

  it('resumes the same track at the saved position through the original provider', async () => {
    const lx = working('lx')
    const store = await failedRecovery(lx)
    try {
      const before = resolvesFor(lx, 'first')
      await store.play(); await settle()
      expect(store.currentTrack.value?.id).toBe('first')
      expect(resolvesFor(lx, 'first')).toBe(before + 1)
      expect(store.activeProviderId.value).toBe('lx')
      expect(['ready', 'playing']).toContain(store.status.value)
      expect(store.pendingResumePosition.value).toBe(42)
    } finally { store.dispose() }
  })

  it('stays on the track with a track-failed notice when the whole chain fails, never skipping', async () => {
    const store = await failedRecovery(onceThenFailing('lx'))
    try {
      await store.play(); await settle()
      expect(store.currentTrack.value?.id).toBe('first')
      expect(store.status.value).toBe('error')
      expect(noticesOf(store, 'trackFailed')).toHaveLength(1)
    } finally { store.dispose() }
  })
})

describe('P96-03 a failing manual source keeps the track and the override (Property 30)', () => {
  it('stays on the current track with the override, an error and a track-failed notice naming the source', async () => {
    const chksz = working('chksz')
    const registry = new ProviderRegistry([
      { provider: chksz, enabled: true, priority: 1, timeoutMs: 100 },
      { provider: failing('lx'), enabled: true, priority: 2, timeoutMs: 100 },
    ])
    const store = createPlaybackStore({ registry })
    try {
      store.enqueue(makeTrack('first', ['chksz', 'lx'])); store.enqueue(makeTrack('second', ['chksz', 'lx']))
      await store.playQueueIndex(0)
      expect(store.currentTrack.value?.id).toBe('first')
      const chkszCalls = (chksz.resolve as ReturnType<typeof vi.fn>).mock.calls.length
      await store.setSourceOverride('lx'); await settle()
      expect(store.currentTrack.value?.id).toBe('first')
      expect(store.sourceOverride.value).toBe('lx')
      expect(store.status.value).toBe('error')
      expect(chksz.resolve).toHaveBeenCalledTimes(chkszCalls)
      const failed = noticesOf(store, 'trackFailed')
      expect(failed).toHaveLength(1)
      expect(JSON.stringify(failed[0])).toContain('lx')
    } finally { store.dispose() }
  })
})

// ---------------------------------------------------------------------------------------------
// Preservation (Property 23 and 3.19, task 7). These cases hold on 8309e3a and must keep holding
// after the fix. They are kept apart from the fix-checking cases above.
// ---------------------------------------------------------------------------------------------

const resolveCalls = (p: AudioProvider) => (p.resolve as ReturnType<typeof vi.fn>).mock.calls.length
function credentialFailing(id: string, code: 'credential_required' | 'invalid_credential'): AudioProvider {
  return { id, canResolve: () => true, resolve: vi.fn(async () => { throw new ProviderResolveError(code) }) } as AudioProvider
}

describe('Preservation: same-position Jellyfin recovery outside the bug conditions (Property 23)', () => {
  it('recovers a still-stalled stream through a usable Jellyfin at the same position, once per track and provider', async () => {
    const jellyfin = working('jellyfin')
    const registry = new ProviderRegistry([
      { provider: working('lx'), enabled: true, priority: 1, timeoutMs: 100 },
      { provider: jellyfin, enabled: true, priority: 2, timeoutMs: 100 },
    ])
    const store = createPlaybackStore({ registry })
    try {
      await store.playNow(makeTrack('t', ['lx', 'jellyfin']))
      expect(store.activeProviderId.value).toBe('lx')
      const generation = store.playbackGeneration.value
      const session = store.listeningSessionId.value
      store.reportMediaState('playing', generation)
      store.reportMediaState('buffering', generation)
      // Two requests for the same stall: the one-shot attempt key lets only the first resolve.
      const [first, second] = await Promise.all([
        store.requestJellyfinFallback('lx', generation, 42, () => true),
        store.requestJellyfinFallback('lx', generation, 42, () => true),
      ])
      expect(first).toBe(true)
      expect(second).toBe(false)
      expect(resolveCalls(jellyfin)).toBe(1)
      expect(store.playbackGeneration.value).toBe(generation + 1)
      expect(store.pendingResumePosition.value).toBe(42)
      expect(store.activeProviderId.value).toBe('jellyfin')
      expect(store.status.value).toBe('ready')
      expect(store.currentTrack.value?.id).toBe('t')
      expect(store.listeningSessionId.value).toBe(session)
      // A repeated request for the old generation is ignored.
      expect(await store.requestJellyfinFallback('lx', generation, 42, () => true)).toBe(false)
      expect(resolveCalls(jellyfin)).toBe(1)
    } finally { store.dispose() }
  })

  it.each([
    ['Jellyfin disabled', false],
    ['Jellyfin enabled', true],
  ])('leaves a stream that resumed by itself alone (%s)', async (_label, jellyfinEnabled) => {
    const jellyfin = working('jellyfin')
    const registry = new ProviderRegistry([
      { provider: working('lx'), enabled: true, priority: 1, timeoutMs: 100 },
      { provider: jellyfin, enabled: jellyfinEnabled, priority: 2, timeoutMs: 100 },
    ])
    const store = createPlaybackStore({ registry })
    try {
      await store.playNow(makeTrack('t', ['lx', 'chksz', 'jellyfin']))
      const generation = store.playbackGeneration.value
      store.reportMediaState('playing', generation)
      store.reportMediaState('buffering', generation)
      expect(await store.requestJellyfinFallback('lx', generation, 42, () => false)).toBe(false)
      expect(store.status.value).toBe('buffering')
      expect(store.playbackIntent.value).toBe('playing')
      expect(store.playbackGeneration.value).toBe(generation)
      expect(store.activeProviderId.value).toBe('lx')
      expect(resolveCalls(jellyfin)).toBe(0)
    } finally { store.dispose() }
  })

  it.each(['credential_required', 'invalid_credential'] as const)(
    'stops a manual source that answers %s without any Jellyfin recovery, keeping the track and the override',
    async (code) => {
      const jellyfin = working('jellyfin')
      const registry = new ProviderRegistry([
        { provider: working('chksz'), enabled: true, priority: 1, timeoutMs: 100 },
        { provider: credentialFailing('lx', code), enabled: true, priority: 2, timeoutMs: 100 },
        { provider: jellyfin, enabled: true, priority: 3, timeoutMs: 100 },
      ])
      const store = createPlaybackStore({ registry })
      try {
        // A single-track queue: the 3.17 situation, so no skip is possible on F or F'.
        await store.playNow(makeTrack('t', ['chksz', 'lx', 'jellyfin']))
        expect(store.activeProviderId.value).toBe('chksz')
        await store.setSourceOverride('lx'); await settle()
        expect(store.currentTrack.value?.id).toBe('t')
        expect(store.sourceOverride.value).toBe('lx')
        expect(store.status.value).toBe('error')
        expect(resolveCalls(jellyfin)).toBe(0)
        expect(store.attempts.value).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: 'lx', ok: false, code })]))
      } finally { store.dispose() }
    },
  )

  it('does not let a native or OS interruption overwrite the listener intent', async () => {
    const registry = new ProviderRegistry([{ provider: working('lx'), enabled: true, priority: 1, timeoutMs: 100 }])
    const store = createPlaybackStore({ registry })
    try {
      await store.playNow(makeTrack('t', ['lx']))
      const generation = store.playbackGeneration.value
      store.reportMediaState('playing', generation)
      store.reportMediaState('paused', generation)
      expect(store.status.value).toBe('paused')
      expect(store.playbackIntent.value).toBe('playing')
      // Buffering or ready reports while natively paused do not hide the pause.
      store.reportMediaState('buffering', generation)
      store.reportMediaState('ready', generation)
      expect(store.status.value).toBe('paused')
      expect(store.playbackIntent.value).toBe('playing')
      store.reportMediaState('playing', generation)
      expect(store.status.value).toBe('playing')
      store.pause()
      expect(store.playbackIntent.value).toBe('paused')
    } finally { store.dispose() }
  })
})

describe('Preservation: media renewal through the same provider (3.19)', () => {
  it('renews an expired ticket once per 10 s through the same provider at the same position in the same session', async () => {
    let now = 5_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const lx = working('lx')
    const gd = working('gd-studio')
    const registry = new ProviderRegistry([
      { provider: lx, enabled: true, priority: 1, timeoutMs: 100 },
      { provider: gd, enabled: true, priority: 2, timeoutMs: 100 },
    ])
    const store = createPlaybackStore({ registry })
    try {
      store.enqueue(makeTrack('a', ['lx', 'gd-studio'])); store.enqueue(makeTrack('b', ['lx', 'gd-studio']))
      await store.playQueueIndex(0)
      let generation = store.playbackGeneration.value
      store.reportMediaState('playing', generation)
      const session = store.listeningSessionId.value
      publishPlaybackPresentation(store, { currentTime: 95, duration: 200, canSeek: true })
      expect(resolvesFor(lx, 'a')).toBe(1)

      expect(await store.renewMedia('lx', generation)).toBe(true)
      expect(resolvesFor(lx, 'a')).toBe(2)
      expect(store.playbackGeneration.value).toBe(generation + 1)
      expect(store.activeProviderId.value).toBe('lx')
      expect(store.pendingResumePosition.value).toBe(95)
      expect(store.currentIndex.value).toBe(0)
      expect(store.listeningSessionId.value).toBe(session)
      expect(store.status.value).toBe('ready')
      expect(resolveCalls(gd)).toBe(0)

      generation = store.playbackGeneration.value
      store.reportMediaState('playing', generation)
      store.reportProgress(95, generation)
      store.reportProgress(96, generation)
      now += MEDIA_RENEWAL_INTERVAL_MS / 2
      expect(await store.renewMedia('lx', generation)).toBe(false)
      expect(resolvesFor(lx, 'a')).toBe(2)
      now += MEDIA_RENEWAL_INTERVAL_MS / 2
      expect(await store.renewMedia('lx', generation)).toBe(true)
      expect(resolvesFor(lx, 'a')).toBe(3)
      expect(store.listeningSessionId.value).toBe(session)
      expect(resolveCalls(gd)).toBe(0)
    } finally { store.dispose(); clock.mockRestore() }
  })
})
