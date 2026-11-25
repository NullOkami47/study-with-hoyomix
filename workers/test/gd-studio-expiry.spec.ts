import { describe, expect, it, vi } from 'vitest'
import { createProviderHandler } from '../providers/routes'
import type { ProviderEnv } from '../providers/config'
import type { Track } from '../../src/features/catalog/types'
import { GdStudioBudget } from '../../src/features/player/gdStudio/budget'
import { createGdStudioProvider } from '../../src/features/player/providers/gdStudio'

const origin = 'https://study.example'
const env = {
  PUBLIC_ORIGIN: origin,
  GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
  GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'm701.music.126.net',
  DB: { prepare: () => ({ all: async () => ({ results: [
    { providerKey: 'gd-studio', enabled: 1, priority: 40, status: 'unknown', updatedAt: 0 },
  ] }) }) },
} as unknown as ProviderEnv

describe('GD Studio Worker ticket deadline', () => {
  it.each(['', '?expires=1&token=PRIVATE_UPSTREAM_TOKEN'])('returns the minted cache deadline without guessing upstream expiry (%s)', async suffix => {
    let now = 1_800_000_000_000
    const entries = new Map<string, Response>()
    const cache = {
      match: async (request: Request) => entries.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        entries.set(request.url, response.clone())
        now += 2_000 // Cache latency must not restart the minted lifetime.
      },
    }
    const fetch = vi.fn(async () => {
      now += 5_000 // Mint only after metadata resolution, not at request start.
      return Response.json({ url: 'https://m701.music.126.net/audio.mp3' + suffix })
    })
    const handler = createProviderHandler(env, { cache, fetch, now: () => now })
    const response = await handler.fetch(new Request(origin + '/api/providers/gd-studio/resolve', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ externalId: 'netease:42:320' }),
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const prepared = await response.json() as { url: string; mimeType: string; expiresAt: number; ttlMs?: number }
    expect(prepared).toEqual({
      url: expect.stringMatching(/^\/api\/providers\/gd-studio\/media\/netease%3A42%3A320\/[A-Za-z0-9_-]{32}$/),
      mimeType: 'audio/mpeg', expiresAt: 1_800_000_125_000, ttlMs: 118_000,
    })
    const stored = await entries.get(origin + prepared.url)!.clone().json() as { expiresAt: number }
    expect(prepared.expiresAt).toBe(stored.expiresAt)
    expect(JSON.stringify(prepared)).not.toMatch(/m701|PRIVATE_UPSTREAM_TOKEN|expires=/)
    now = 1_800_000_125_000
    const expired = await handler.fetch(new Request(origin + prepared.url))
    expect(expired.status).toBe(410)
    expect(await expired.json()).toEqual({ error: 'preparation_expired' })
    expect(expired.headers.get('x-hoyomix-media-failure')).toBe('ticket-expired')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('emits ttlMs = 120_000 when cache write adds zero latency', async () => {
    const now = 1_800_000_000_000
    const entries = new Map<string, Response>()
    const cache = {
      match: async (request: Request) => entries.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => { entries.set(request.url, response.clone()) },
    }
    const fetch = vi.fn(async () => Response.json({ url: 'https://m701.music.126.net/audio.mp3' }))
    const handler = createProviderHandler(env, { cache, fetch, now: () => now })
    const response = await handler.fetch(new Request(origin + '/api/providers/gd-studio/resolve', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ externalId: 'netease:42:320' }),
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      url: expect.stringMatching(/^\/api\/providers\/gd-studio\/media\/netease%3A42%3A320\/[A-Za-z0-9_-]{32}$/),
      mimeType: 'audio/mpeg', expiresAt: now + 120_000, ttlMs: 120_000,
    })
  })

  it('fails closed with 503 if cache latency exhausts the ticket before issuance', async () => {
    let now = 1_800_000_000_000
    const entries = new Map<string, Response>()
    const cache = {
      match: async (request: Request) => entries.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        entries.set(request.url, response.clone())
        now += 120_000
      },
    }
    const fetch = vi.fn(async () => Response.json({ url: 'https://m701.music.126.net/audio.mp3' }))
    const handler = createProviderHandler(env, { cache, fetch, now: () => now })
    const response = await handler.fetch(new Request(origin + '/api/providers/gd-studio/resolve', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ externalId: 'netease:42:320' }),
    }))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'unavailable' })
  })

  it.each([-60_000, -5_000, -1_000, 0, 1_000, 5_000, 60_000])(
    'preserves end-to-end client/Worker ticket validity across %i ms clock skew without extending Worker expiry',
    async (skewMs) => {
      // clientNow = workerNow + skewMs (e.g. -60_000 means client clock lags Worker by 60 s).
      let workerNow = 1_800_000_000_000
      const entries = new Map<string, Response>()
      const cache = {
        match: async (request: Request) => entries.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          entries.set(request.url, response.clone())
          workerNow += 200
        },
      }
      const upstreamFetch = vi.fn(async () => {
        workerNow += 1_500
        return Response.json({ url: 'https://m701.music.126.net/audio.mp3' })
      })
      const handler = createProviderHandler(env, { cache, fetch: upstreamFetch, now: () => workerNow })

      vi.stubGlobal('location', { origin })
      try {
        let transitDelayMs = 0
        const clientNow = () => workerNow + skewMs + transitDelayMs
        const clientFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = new Request(String(input), init)
          if (!req.headers.has('origin')) req.headers.set('origin', origin)
          const response = await handler.fetch(req)
          transitDelayMs += 300
          Object.defineProperty(response, 'url', { value: origin + '/api/providers/gd-studio/resolve' })
          return response
        })
        const provider = createGdStudioProvider({
          fetch: clientFetch,
          budget: new GdStudioBudget({ channelName: null, storage: null }),
          now: clientNow,
        })
        const sourceTrack = {
          id: 't-skew',
          title: 'Skew Track',
          sources: [{ provider: 'gd-studio', externalId: 'netease:42:320' }],
        } as Track

        const playable = await provider.resolve(sourceTrack, new AbortController().signal)
        expect(playable).not.toBeNull()
        if (!playable || playable.kind !== 'audio') throw new Error('expected audio playable')

        const clientEnd = clientNow()
        const mediaPath = new URL(playable.url).pathname
        const stored = await entries.get(origin + mediaPath)!.clone().json() as { expiresAt: number }
        const workerExpiryInClientClock = stored.expiresAt + skewMs

        expect(Number.isSafeInteger(playable.expiresAt)).toBe(true)
        expect(playable.expiresAt).toBeGreaterThanOrEqual(clientEnd + 110_000)
        // Client deadline must never outlive the Worker's true cached expiry in client clock units.
        expect(playable.expiresAt).toBeLessThanOrEqual(workerExpiryInClientClock)

        // Worker media route still enforces its own authoritative 120s cache expiry.
        workerNow = stored.expiresAt
        const expired = await handler.fetch(new Request(playable.url))
        expect(expired.status).toBe(410)
        expect(expired.headers.get('x-hoyomix-media-failure')).toBe('ticket-expired')
      } finally {
        vi.unstubAllGlobals()
      }
    },
  )
})
