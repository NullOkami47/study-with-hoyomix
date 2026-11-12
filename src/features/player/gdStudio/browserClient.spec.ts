import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GD_STUDIO_API_ORIGIN, GdStudioBudget } from './budget'
import { resolveGdStudioUrl, resetGdStudioInFlight } from './browserClient'

const CSP = { connect: ["'self'", GD_STUDIO_API_ORIGIN], media: ["'self'", 'https://*.music.126.net'] } as const
const AUDIO_URL = 'https://m801.music.126.net/2026/signed/song.mp3?authSecret=abc'

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('the browser-direct GD Studio resolver', () => {
  beforeEach(() => {
    resetGdStudioInFlight()
  })

  it('asks the API from the browser and returns the CDN URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ url: AUDIO_URL, br: 320 }))
    const result = await resolveGdStudioUrl({
      id: '9000000003',
      br: 320,
      fetch: fetchMock as unknown as typeof fetch,
      cspSources: { connect: [...CSP.connect], media: [...CSP.media] },
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.url).toBe(AUDIO_URL)
      expect(result.bitrate).toBe(320)
      expect(result.fromDedup).toBe(false)
    }
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe(`${GD_STUDIO_API_ORIGIN}/api.php?types=url&source=netease&id=9000000003&br=320`)
  })

  it('refuses a request the deployment CSP does not allow before any network use', async () => {
    const fetchMock = vi.fn()
    const result = await resolveGdStudioUrl({
      id: '1',
      fetch: fetchMock as unknown as typeof fetch,
      cspSources: { connect: ["'self'"], media: [...CSP.media] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('csp_blocked')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shares one in-flight request between concurrent callers', async () => {
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return jsonResponse({ url: AUDIO_URL, br: 320 })
    })
    const [first, second] = await Promise.all([
      resolveGdStudioUrl({ id: '42', fetch: fetchMock as unknown as typeof fetch, cspSources: { connect: [...CSP.connect], media: [...CSP.media] } }),
      resolveGdStudioUrl({ id: '42', fetch: fetchMock as unknown as typeof fetch, cspSources: { connect: [...CSP.connect], media: [...CSP.media] } }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first.ok && second.ok).toBe(true)
    if (first.ok && second.ok) {
      expect(first.fromDedup).toBe(false)
      expect(second.fromDedup).toBe(true)
    }
  })

  it('spends budget on a request and on a failed one alike', async () => {
    let clock = 0
    const budget = new GdStudioBudget({ limit: 2, windowMs: 60_000, channelName: null, now: () => clock })
    const fetchMock = vi.fn(async () => new Response('nope', { status: 500 }))

    await resolveGdStudioUrl({ id: '1', budget, fetch: fetchMock as unknown as typeof fetch, cspSources: { connect: [...CSP.connect], media: [...CSP.media] } })
    expect(budget.remaining(1)).toBe(1)

    await resolveGdStudioUrl({ id: '2', budget, fetch: fetchMock as unknown as typeof fetch, cspSources: { connect: [...CSP.connect], media: [...CSP.media] } })
    expect(budget.remaining(2)).toBe(0)

    const refused = await resolveGdStudioUrl({ id: '3', budget, fetch: fetchMock as unknown as typeof fetch, cspSources: { connect: [...CSP.connect], media: [...CSP.media] } })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.failure).toBe('budget_exhausted')
    // A refused request was never sent, so it costs nothing.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('backs off on a 429 and reports it as rate_limited', async () => {
    let clock = 0
    const budget = new GdStudioBudget({ limit: 10, windowMs: 60_000, channelName: null, now: () => clock })
    const fetchMock = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }))

    const result = await resolveGdStudioUrl({ id: '1', budget, fetch: fetchMock as unknown as typeof fetch, cspSources: { connect: [...CSP.connect], media: [...CSP.media] } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.failure).toBe('rate_limited')
      expect(result.retryAfterMs).toBe(30_000)
    }

    // The next request is refused locally, before any network use.
    clock = 1_000
    const next = await resolveGdStudioUrl({ id: '2', budget, fetch: fetchMock as unknown as typeof fetch, cspSources: { connect: [...CSP.connect], media: [...CSP.media] } })
    expect(next.ok).toBe(false)
    if (!next.ok) expect(next.failure).toBe('backing_off')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a plaintext URL the media element could never play', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ url: 'http://m801.music.126.net/a.mp3', br: 320 }))
    const result = await resolveGdStudioUrl({
      id: '1',
      fetch: fetchMock as unknown as typeof fetch,
      cspSources: { connect: [...CSP.connect], media: [...CSP.media] },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.failure).toBe('invalid_response')
  })

  it('does not follow a redirect', async () => {
    const fetchMock = vi.fn(async (_url, init: RequestInit) => {
      expect(init.redirect).toBe('error')
      return jsonResponse({ url: AUDIO_URL })
    })
    await resolveGdStudioUrl({ id: '1', fetch: fetchMock as unknown as typeof fetch, cspSources: { connect: [...CSP.connect], media: [...CSP.media] } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
