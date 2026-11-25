import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../catalog/types'
import { GdStudioBudget, getSharedGdStudioBudget, resetSharedGdStudioBudget } from '../gdStudio/budget'
import { createPlaybackQualityPreferencesStore } from '../qualityPreferences'
import { createPlaybackStore } from '../store'
import { createGdStudioProvider } from './gdStudio'
import { createServerProxyProvider } from './proxy'
import { ProviderRegistry } from './registry'

const ORIGIN = window.location.origin
const NONCE = 'abcdefghijklmnopqrstuvwxyzABCDEF'
const track = (sources: Track['sources']): Track => ({ id: 'canonical', title: 'Exact track', sources }) as Track
const at = (response: Response): Response => {
  Object.defineProperty(response, 'url', { value: ORIGIN + '/api/providers/gd-studio/resolve' })
  return response
}
const playableResponse = (externalId: string) => at(Response.json({
  url: '/api/providers/gd-studio/media/' + encodeURIComponent(externalId) + '/' + NONCE,
  mimeType: 'audio/mpeg',
}))
const budget = () => new GdStudioBudget({ channelName: null, storage: null })

afterEach(() => resetSharedGdStudioBudget())

describe('standalone official GD Studio provider', () => {
  it('derives an exact NetEase binding without changing the canonical track or executing LX', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(playableResponse('netease:2155423468:320'))
    const sourceTrack = track([{ provider: 'chksz', externalId: '2155423468' }])
    const snapshot = JSON.stringify(sourceTrack)
    const provider = createGdStudioProvider({ fetch: fetchImpl, budget: budget() })
    expect(provider.canResolve?.(sourceTrack)).toBe(true)
    const result = await provider.resolve(sourceTrack, new AbortController().signal)
    expect(fetchImpl).toHaveBeenCalledWith(ORIGIN + '/api/providers/gd-studio/resolve', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ externalId: 'netease:2155423468:320' }), redirect: 'error',
    }))
    expect(result?.kind).toBe('audio')
    expect(JSON.stringify(sourceTrack)).toBe(snapshot)
  })

  it('keeps an explicit GD Studio mapping ahead of a derived NetEase mapping', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(playableResponse('netease:42:128'))
    const provider = createGdStudioProvider({ fetch: fetchImpl, budget: budget() })
    await provider.resolve(track([
      { provider: 'chksz', externalId: '2155423468' },
      { provider: 'gd-studio', externalId: 'netease:42:128' },
    ]), new AbortController().signal)
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({ externalId: 'netease:42:128' })
  })

  it.each(['', 'not-a-number', '2155423468/trick', 'https://private.invalid/track'])('does not guess an invalid canonical NetEase binding: %s', async (id) => {
    const fetchImpl = vi.fn()
    const provider = createGdStudioProvider({ fetch: fetchImpl, budget: budget() })
    const invalid = track([{ provider: 'chksz', externalId: id }])
    expect(provider.canResolve?.(invalid)).toBe(false)
    expect(await provider.resolve(invalid, new AbortController().signal)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses the shared GD Studio request window, including requests already spent by LX', async () => {
    const shared = budget()
    for (let index = 0; index < 40; index++) expect(shared.tryAcquire().ok).toBe(true)
    const fetchImpl = vi.fn()
    const provider = createGdStudioProvider({ fetch: fetchImpl, budget: shared })
    await expect(provider.resolve(track([{ provider: 'chksz', externalId: '1' }]), new AbortController().signal))
      .rejects.toMatchObject({ code: 'rate_limited' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('defaults to the same page-wide budget used by LX network admissions', async () => {
    const shared = getSharedGdStudioBudget()
    for (let index = 0; index < 40; index++) expect(shared.tryAcquire().ok).toBe(true)
    const fetchImpl = vi.fn()
    const provider = createGdStudioProvider({ fetch: fetchImpl })
    await expect(provider.resolve(track([{ provider: 'chksz', externalId: '1' }]), new AbortController().signal))
      .rejects.toMatchObject({ code: 'rate_limited' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('honours upstream 429 Retry-After for later standalone or LX admissions', async () => {
    const shared = budget()
    const fetchImpl = vi.fn().mockResolvedValue(at(new Response('', { status: 429, headers: { 'retry-after': '60' } })))
    const provider = createGdStudioProvider({ fetch: fetchImpl, budget: shared })
    await expect(provider.resolve(track([{ provider: 'chksz', externalId: '1' }]), new AbortController().signal))
      .rejects.toMatchObject({ code: 'rate_limited' })
    expect(shared.tryAcquire()).toMatchObject({ ok: false, reason: 'backing_off' })
  })
})


it('sends each newly selected GD quality without rebuilding the provider or changing the track', async () => {
  const qualityStore = createPlaybackQualityPreferencesStore({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  const fetchImpl = vi.fn(async (_input, init) => playableResponse(JSON.parse(String(init?.body)).externalId))
  const provider = createGdStudioProvider({ fetch: fetchImpl, budget: budget(), qualityStore })
  const sourceTrack = track([{ provider: 'gd-studio', externalId: 'tencent:42:128' }])
  for (const quality of ['999', '740', '320', '192', '128', 'auto'] as const) {
    qualityStore.setGdStudioQuality(quality)
    await provider.resolve(sourceTrack, new AbortController().signal)
    expect(JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body))).toEqual({ externalId: `tencent:42:${quality === 'auto' ? '128' : quality}` })
  }
  expect(sourceTrack.sources[0]?.externalId).toBe('tencent:42:128')
})

describe('GD Studio effective ticket expiry', () => {
  const receivedAt = 1_800_000_000_000
  const sourceTrack = track([{ provider: 'gd-studio', externalId: 'netease:42:320' }])
  const responseWithExpiry = (expiresAt: unknown) => at(Response.json({
    url: '/api/providers/gd-studio/media/netease%3A42%3A320/' + NONCE,
    mimeType: 'audio/mpeg', expiresAt,
  }))

  it.each([receivedAt + 1, receivedAt + 45_000, receivedAt + 120_000])(
    'preserves the exact Worker deadline %s, including the maximum remaining lifetime', async expiresAt => {
      const provider = createGdStudioProvider({
        fetch: vi.fn(async () => responseWithExpiry(expiresAt)), budget: budget(), now: () => receivedAt,
      })
      expect(await provider.resolve(sourceTrack, new AbortController().signal))
        .toMatchObject({ kind: 'audio', expiresAt })
    },
  )

  it.each([
    null, true, '', String(receivedAt + 120_000), 0, -1, receivedAt - 1, receivedAt,
    receivedAt + 0.5, receivedAt + 120_001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
  ])('rejects a malformed, expired or overlong advertised deadline: %s', async expiresAt => {
    const provider = createGdStudioProvider({
      fetch: vi.fn(async () => responseWithExpiry(expiresAt)), budget: budget(), now: () => receivedAt,
    })
    await expect(provider.resolve(sourceTrack, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('accepts a legacy response without fabricating an upstream or ticket expiry', async () => {
    const provider = createGdStudioProvider({
      fetch: vi.fn(async () => playableResponse('netease:42:320')), budget: budget(), now: () => receivedAt,
    })
    const result = await provider.resolve(sourceTrack, new AbortController().signal)
    expect(result?.kind).toBe('audio')
    expect(result).not.toHaveProperty('expiresAt')
  })

  it('checks at response consumption, without rejecting a freshly minted ticket after a slow resolve', async () => {
    let now = receivedAt
    const provider = createGdStudioProvider({
      budget: budget(), now: () => now,
      fetch: vi.fn(async () => { now += 40_000; return responseWithExpiry(receivedAt + 160_000) }),
    })
    expect(await provider.resolve(sourceTrack, new AbortController().signal))
      .toMatchObject({ expiresAt: receivedAt + 160_000 })
  })

  it('rejects a ticket that expires while the resolve is in flight', async () => {
    let now = receivedAt
    const provider = createGdStudioProvider({
      budget: budget(), now: () => now,
      fetch: vi.fn(async () => { now += 30_000; return responseWithExpiry(receivedAt + 30_000) }),
    })
    await expect(provider.resolve(sourceTrack, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })
})

describe('GD Studio clock skew and relative TTL translation', () => {
  const clientEpoch = 1_800_000_000_000
  const externalId = 'netease:42:320'
  const mediaPath = '/api/providers/gd-studio/media/netease%3A42%3A320/' + NONCE
  const sourceTrack = track([{ provider: 'gd-studio', externalId }])

  const responsePayload = (payload: Record<string, unknown>, status = 200) => at(Response.json({
    url: mediaPath,
    mimeType: 'audio/mpeg',
    ...payload,
  }, { status }))

  it.each([-1_000, -5_000, -60_000])(
    'translates server ttlMs and issuedAt contracts when client clock is behind Worker (%i ms)',
    async (skewMs) => {
      // Client is behind Worker: clientNow = workerNow + skewMs (e.g. -60_000) => workerNow = clientNow - skewMs.
      const clientNow = clientEpoch
      const workerNow = clientNow - skewMs

      const withTtlProvider = createGdStudioProvider({
        budget: budget(),
        now: () => clientNow,
        fetch: vi.fn(async () => responsePayload({ expiresAt: workerNow + 120_000, ttlMs: 120_000 })),
      })
      expect(await withTtlProvider.resolve(sourceTrack, new AbortController().signal))
        .toMatchObject({ kind: 'audio', expiresAt: clientNow + 120_000 })

      const withIssuedAtProvider = createGdStudioProvider({
        budget: budget(),
        now: () => clientNow,
        fetch: vi.fn(async () => responsePayload({ issuedAt: workerNow, expiresAt: workerNow + 120_000 })),
      })
      expect(await withIssuedAtProvider.resolve(sourceTrack, new AbortController().signal))
        .toMatchObject({ kind: 'audio', expiresAt: clientNow + 120_000 })
    },
  )

  it.each([-1_000, -5_000, -60_000])(
    'never extends a short 45s ticket when client clock is behind Worker (%i ms)',
    async (skewMs) => {
      const clientNow = clientEpoch
      const workerNow = clientNow - skewMs
      const provider = createGdStudioProvider({
        budget: budget(),
        now: () => clientNow,
        fetch: vi.fn(async () => responsePayload({ expiresAt: workerNow + 45_000, ttlMs: 45_000 })),
      })
      expect(await provider.resolve(sourceTrack, new AbortController().signal))
        .toMatchObject({ kind: 'audio', expiresAt: clientNow + 45_000 })
    },
  )

  it.each([1_000, 5_000, 60_000])(
    'preserves full and short Worker lifetimes when client clock is ahead of Worker (%i ms)',
    async (skewMs) => {
      // Client is ahead of Worker: workerNow = clientNow - skewMs.
      const clientNow = clientEpoch
      const workerNow = clientNow - skewMs

      const fullProvider = createGdStudioProvider({
        budget: budget(),
        now: () => clientNow,
        fetch: vi.fn(async () => responsePayload({ expiresAt: workerNow + 120_000, ttlMs: 120_000 })),
      })
      expect(await fullProvider.resolve(sourceTrack, new AbortController().signal))
        .toMatchObject({ kind: 'audio', expiresAt: clientNow + 120_000 })

      // Without translation, clientNow > workerNow + 45_000 at +60_000 ms skew would falsely reject.
      const shortProvider = createGdStudioProvider({
        budget: budget(),
        now: () => clientNow,
        fetch: vi.fn(async () => responsePayload({ expiresAt: workerNow + 45_000, ttlMs: 45_000 })),
      })
      expect(await shortProvider.resolve(sourceTrack, new AbortController().signal))
        .toMatchObject({ kind: 'audio', expiresAt: clientNow + 45_000 })
    },
  )

  it.each([-60_000, 60_000])(
    'anchors conservative client-local deadline at request start under network and upstream delays (skew %i ms)',
    async (skewMs) => {
      const clientStart = clientEpoch
      let clientNow = clientStart
      const provider = createGdStudioProvider({
        budget: budget(),
        now: () => clientNow,
        fetch: vi.fn(async () => {
          // Upstream resolution takes 3_000 ms before minting, plus 500 ms response transit delay.
          clientNow += 3_000
          const workerIssuedAt = clientNow - skewMs
          clientNow += 500
          return responsePayload({ expiresAt: workerIssuedAt + 120_000, ttlMs: 120_000 })
        }),
      })
      const result = await provider.resolve(sourceTrack, new AbortController().signal)
      expect(result).toMatchObject({ kind: 'audio', expiresAt: clientStart + 120_000 })
      const workerDeadlineInClientClock = clientStart + 3_000 + 120_000
      expect(result?.expiresAt).toBeLessThanOrEqual(workerDeadlineInClientClock)
      expect(result!.expiresAt! - clientNow).toBe(116_500)
    },
  )

  it('rejects a ticket whose relative ttlMs elapses while the resolve response is in flight under negative skew', async () => {
    const clientStart = clientEpoch
    let clientNow = clientStart
    const skewMs = -60_000
    const provider = createGdStudioProvider({
      budget: budget(),
      now: () => clientNow,
      fetch: vi.fn(async () => {
        clientNow += 30_000
        const workerIssuedAt = clientNow - skewMs
        return responsePayload({ expiresAt: workerIssuedAt + 30_000, ttlMs: 30_000 })
      }),
    })
    await expect(provider.resolve(sourceTrack, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('uses Math.min(requestStartedAt, receivedAt) if the client clock steps backwards during resolve', async () => {
    const t0 = clientEpoch
    let calls = 0
    const provider = createGdStudioProvider({
      budget: budget(),
      now: () => (++calls <= 1 ? t0 + 10_000 : t0),
      fetch: vi.fn(async () => responsePayload({ expiresAt: t0 + 180_000, ttlMs: 120_000 })),
    })
    const result = await provider.resolve(sourceTrack, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'audio', expiresAt: t0 + 120_000 })
  })

  it.each([
    { expiresAt: clientEpoch + 120_000, ttlMs: 0 },
    { expiresAt: clientEpoch + 120_000, ttlMs: -1 },
    { issuedAt: clientEpoch, expiresAt: clientEpoch },
    { issuedAt: clientEpoch, expiresAt: clientEpoch - 1 },
  ])('rejects expired relative or issued-at ticket contracts: %j', async (payload) => {
    const provider = createGdStudioProvider({
      budget: budget(),
      now: () => clientEpoch,
      fetch: vi.fn(async () => responsePayload(payload)),
    })
    await expect(provider.resolve(sourceTrack, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it.each([
    null, true, false, '', '120000', 'undefined', 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1,
  ])('rejects malformed ttlMs value: %s', async (badTtl) => {
    const provider = createGdStudioProvider({
      budget: budget(),
      now: () => clientEpoch,
      fetch: vi.fn(async () => responsePayload({ expiresAt: clientEpoch + 120_000, ttlMs: badTtl })),
    })
    await expect(provider.resolve(sourceTrack, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it.each([
    null, true, false, '', 'undefined', String(clientEpoch), 0, -1, clientEpoch + 0.5,
    Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1,
  ])('rejects malformed issuedAt value: %s', async (badIssuedAt) => {
    const provider = createGdStudioProvider({
      budget: budget(),
      now: () => clientEpoch,
      fetch: vi.fn(async () => responsePayload({ issuedAt: badIssuedAt, expiresAt: clientEpoch + 120_000 })),
    })
    await expect(provider.resolve(sourceTrack, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it.each([
    { ttlMs: 60_000 },
    { issuedAt: clientEpoch },
    { expiresAt: 30_000, ttlMs: 60_000 },
  ])('rejects incomplete or inconsistent ttlMs/issuedAt payloads without expiresAt: %j', async (payload) => {
    const provider = createGdStudioProvider({
      budget: budget(),
      now: () => clientEpoch,
      fetch: vi.fn(async () => responsePayload(payload)),
    })
    await expect(provider.resolve(sourceTrack, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it.each([
    { expiresAt: clientEpoch + 120_001, ttlMs: 120_001 },
    { expiresAt: clientEpoch + 600_000, ttlMs: 600_000 },
    { expiresAt: clientEpoch + 600_000, ttlMs: Number.MAX_SAFE_INTEGER },
    { issuedAt: clientEpoch, expiresAt: clientEpoch + 120_001 },
    { issuedAt: clientEpoch, expiresAt: clientEpoch + 120_001, ttlMs: 120_000 },
    { issuedAt: clientEpoch, expiresAt: clientEpoch + 30_000, ttlMs: 60_000 },
  ])('rejects excessively long or forged lifetimes above 120s: %j', async (payload) => {
    const provider = createGdStudioProvider({
      budget: budget(),
      now: () => clientEpoch,
      fetch: vi.fn(async () => responsePayload(payload)),
    })
    await expect(provider.resolve(sourceTrack, new AbortController().signal))
      .rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('keeps ttlMs/issuedAt/expiresAt excluded for providers with includeExpiry disabled', async () => {
    const chkszResolveUrl = ORIGIN + '/api/providers/chksz/resolve'
    const chkszResponse = Response.json({
      url: '/api/providers/chksz/media/1315196858/' + NONCE,
      mimeType: 'audio/mpeg',
      expiresAt: 'ignored',
      ttlMs: 120_000,
      issuedAt: clientEpoch,
    })
    Object.defineProperty(chkszResponse, 'url', { value: chkszResolveUrl })
    const proxy = createServerProxyProvider('chksz', 'chksz', {
      fetch: vi.fn(async () => chkszResponse),
      includeExpiry: false,
      now: () => clientEpoch,
    })
    const result = await proxy.resolve(
      track([{ provider: 'chksz', externalId: '1315196858' }]),
      new AbortController().signal,
    )
    expect(result).toEqual({
      kind: 'audio',
      mimeType: 'audio/mpeg',
      url: ORIGIN + '/api/providers/chksz/media/1315196858/' + NONCE,
    })
    expect(result).not.toHaveProperty('expiresAt')
  })

  it.each([-60_000, 60_000])(
    'supports store handover, renewal and transient 503 retry under %i ms clock skew',
    async (skewMs) => {
      vi.useFakeTimers()
      vi.setSystemTime(clientEpoch)
      let store: ReturnType<typeof createPlaybackStore> | undefined
      let failNextWith503 = false
      let nonceCounter = 0
      const tracks: Track[] = ['t1', 't2', 't3'].map((id) => ({
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
      }))

      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { externalId: string }
        if (failNextWith503) {
          failNextWith503 = false
          return at(Response.json({ error: 'unavailable' }, { status: 503 }))
        }
        const workerNow = Date.now() - skewMs
        const nonce = String(++nonceCounter).padStart(32, 'a')
        return at(Response.json({
          url: '/api/providers/gd-studio/media/' + encodeURIComponent(body.externalId) + '/' + nonce,
          mimeType: 'audio/mpeg',
          expiresAt: workerNow + 120_000,
          ttlMs: 120_000,
        }))
      })

      try {
        const provider = createGdStudioProvider({
          fetch: fetchImpl,
          budget: budget(),
          now: () => Date.now(),
        })
        const registry = new ProviderRegistry([
          { provider, priority: 1, enabled: true, timeoutMs: 5_000 },
        ])
        store = createPlaybackStore({
          registry,
          storage: { getItem: () => null, setItem: () => {} },
        })
        store.setShuffle(false)
        store.reconcileUpcomingQueue(tracks)

        await store.playQueueIndex(0)
        expect(store.playable.value?.expiresAt).toBe(clientEpoch + 120_000)

        store.setPreloadPolicy('auto')
        await store.armNextPreparation()
        const prepared = store.preparedNext.value!
        expect(prepared.playable.expiresAt).toBe(clientEpoch + 120_000)

        vi.setSystemTime(clientEpoch + 90_000)
        expect(store.canHandoffPreparation(prepared.id)).toBe(true)

        // Adopt t2 at the exact 30 s handover boundary under skew, then let the 1 ms margin expire.
        await store.next()
        expect(store.currentTrack.value?.id).toBe('t2')
        expect(store.playable.value).toBe(prepared.playable)
        const gen2 = store.playbackGeneration.value

        // Expire handover margin by 1 ms and recover via reResolve.
        vi.setSystemTime(clientEpoch + 90_001)
        expect(await store.recoverHandover('reResolve', gen2)).toBe(true)
        const gen3 = store.playbackGeneration.value
        expect(gen3).toBe(gen2 + 1)
        expect(store.playable.value?.expiresAt).toBe(Date.now() + 120_000)

        // Also confirm prepared handover becomes unadoptable at +90_001 ms before next().
        const preparedAtTime = Date.now()
        await store.armNextPreparation()
        const prepared3 = store.preparedNext.value!
        expect(prepared3.playable.expiresAt).toBe(preparedAtTime + 120_000)
        vi.setSystemTime(preparedAtTime + 90_001)
        expect(store.canHandoffPreparation(prepared3.id)).toBe(false)

        // Simulate real forward playback progress on gen3 to clear awaitingStart and reset renewal budget.
        store.reportProgress(0.5, gen3)
        store.reportProgress(2.5, gen3)

        // Renew media with a transient HTTP 503 failure on the first attempt.
        failNextWith503 = true
        const pendingRenewal = store.renewMedia('gd-studio', gen3)
        await vi.advanceTimersByTimeAsync(1_500)
        expect(await pendingRenewal).toBe(true)
        const gen4 = store.playbackGeneration.value
        expect(gen4).toBe(gen3 + 1)
        expect(store.playable.value?.expiresAt).toBe(Date.now() + 120_000)

        // Advance past MEDIA_RENEWAL_INTERVAL_MS and report progress before testing an in-flight-expired renewal.
        vi.advanceTimersByTime(10_000)
        store.reportProgress(3.0, gen4)
        store.reportProgress(5.0, gen4)

        // Reject an in-flight-expired renewal ticket without advancing generation.
        const prevPlayable = store.playable.value
        fetchImpl.mockImplementationOnce(async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as { externalId: string }
          const workerIssuedAt = Date.now() - skewMs
          vi.setSystemTime(Date.now() + 30_000)
          const nonce = String(++nonceCounter).padStart(32, 'b')
          return at(Response.json({
            url: '/api/providers/gd-studio/media/' + encodeURIComponent(body.externalId) + '/' + nonce,
            mimeType: 'audio/mpeg',
            expiresAt: workerIssuedAt + 30_000,
            ttlMs: 30_000,
          }))
        })
        expect(await store.renewMedia('gd-studio', gen4)).toBe(false)
        expect(store.playbackGeneration.value).toBe(gen4)
        expect(store.playable.value).toBe(prevPlayable)
      } finally {
        store?.dispose()
        vi.useRealTimers()
      }
    },
  )
})

describe('GD Studio high-bitrate HTTP 502 step-down fallback', () => {
  const sourceTrack = track([{ provider: 'chksz', externalId: '2677073851' }])

  function makeQualityStore(quality: 'auto' | '128' | '192' | '320' | '740' | '999') {
    const store = createPlaybackQualityPreferencesStore({
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
    store.setGdStudioQuality(quality)
    return store
  }

  it('steps down from 999 -> 740 -> 320 when upstream bitrate returns HTTP 502 unavailable', async () => {
    const requested: string[] = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { externalId } = JSON.parse(String(init?.body)) as { externalId: string }
      requested.push(externalId)
      if (externalId.endsWith(':999') || externalId.endsWith(':740')) {
        return at(Response.json({ error: 'unavailable', code: 'gd_upstream_http' }, { status: 502 }))
      }
      return playableResponse(externalId)
    })

    const provider = createGdStudioProvider({
      fetch: fetchImpl,
      budget: budget(),
      qualityStore: makeQualityStore('999'),
    })
    const result = await provider.resolve(sourceTrack, new AbortController().signal)
    expect(result?.kind).toBe('audio')
    expect(requested).toEqual([
      'netease:2677073851:999',
      'netease:2677073851:740',
      'netease:2677073851:320',
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('steps down from 999 -> 740 when 740 succeeds without calling 320', async () => {
    const requested: string[] = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { externalId } = JSON.parse(String(init?.body)) as { externalId: string }
      requested.push(externalId)
      if (externalId.endsWith(':999')) {
        return at(Response.json({ error: 'unavailable', code: 'gd_upstream_http' }, { status: 502 }))
      }
      return playableResponse(externalId)
    })

    const provider = createGdStudioProvider({
      fetch: fetchImpl,
      budget: budget(),
      qualityStore: makeQualityStore('999'),
    })
    const result = await provider.resolve(sourceTrack, new AbortController().signal)
    expect(result?.kind).toBe('audio')
    expect(requested).toEqual(['netease:2677073851:999', 'netease:2677073851:740'])
  })

  it('steps down from 740 -> 320 when 740 returns HTTP 502 unavailable', async () => {
    const requested: string[] = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { externalId } = JSON.parse(String(init?.body)) as { externalId: string }
      requested.push(externalId)
      if (externalId.endsWith(':740')) {
        return at(Response.json({ error: 'unavailable', code: 'gd_upstream_http' }, { status: 502 }))
      }
      return playableResponse(externalId)
    })

    const provider = createGdStudioProvider({
      fetch: fetchImpl,
      budget: budget(),
      qualityStore: makeQualityStore('740'),
    })
    const result = await provider.resolve(sourceTrack, new AbortController().signal)
    expect(result?.kind).toBe('audio')
    expect(requested).toEqual(['netease:2677073851:740', 'netease:2677073851:320'])
  })

  it.each([
    { status: 503, body: { error: 'unavailable' }, code: 'unavailable' },
    { status: 429, body: { error: 'rate_limited' }, code: 'rate_limited' },
    { status: 504, body: { error: 'timeout' }, code: 'timeout' },
    { status: 502, body: { error: 'invalid_response' }, code: 'invalid_response' },
  ])('does not step down from 999 on status=$status error=$body.error', async ({ status, body, code }) => {
    const fetchImpl = vi.fn(async () => at(Response.json(body, { status })))
    const provider = createGdStudioProvider({
      fetch: fetchImpl,
      budget: budget(),
      qualityStore: makeQualityStore('999'),
    })
    await expect(provider.resolve(sourceTrack, new AbortController().signal))
      .rejects.toMatchObject({ code })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each(['auto', '320'] as const)('does not step down when quality is %s even on HTTP 502 unavailable', async quality => {
    const fetchImpl = vi.fn(async () => at(Response.json({ error: 'unavailable', code: 'gd_upstream_http' }, { status: 502 })))
    const provider = createGdStudioProvider({
      fetch: fetchImpl,
      budget: budget(),
      qualityStore: makeQualityStore(quality),
    })
    await expect(provider.resolve(sourceTrack, new AbortController().signal))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
