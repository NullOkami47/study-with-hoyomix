import { describe, expect, it, vi } from 'vitest'

import type { Track } from '../../catalog/types'
import { createHuibqProvider, createIkunProvider } from './lx'
import { ProviderResolveError } from './types'

const APP_ORIGIN = window.location.origin
const PREPARATION_NONCE = 'abcdefghijklmnopqrstuvwxyzABCDEF'
const HUIBQ_KEY = 'HUIBQ_REQUEST_KEY_SENTINEL'

function trackWithSource(provider: string, externalId: string): Track {
  return {
    id: 'track-lx',
    title: 'LX Track',
    aliases: {},
    games: ['hsr'],
    relationIds: [],
    tabs: ['focus'],
    workGroupId: 'work-lx',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider, externalId }],
  }
}

function responseJson(body: Record<string, unknown>, status = 200): Response {
  const text = JSON.stringify(body)
  return new Response(text, {
    status,
    headers: {
      'content-length': String(new TextEncoder().encode(text).byteLength),
      'content-type': 'application/json',
    },
  })
}

function responseAt(response: Response, url: string): Response {
  const result = response.clone()
  Object.defineProperty(result, 'url', { configurable: true, value: url })
  return result
}

function stubFetch(response: Response): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) =>
    responseAt(response, String(input)),
  ) as unknown as typeof fetch
}

function expectFailureCode(promise: Promise<unknown>, code: ProviderResolveError['code']) {
  return expect(promise).rejects.toMatchObject({ name: 'ProviderResolveError', code })
}

const FIXTURES = [
  {
    providerId: 'lx-huibq' as const,
    create: createHuibqProvider,
    externalId: 'kw:ABC_def-123:320k',
    encodedId: 'kw%3AABC_def-123%3A320k',
    mimeType: 'audio/mpeg',
    accepted: [
      'kw:ABC_def-123:320k',
      'kg:123456:128k',
      'tx:ABC:320k',
      'wy:123456:128k',
      'mg:123456:320k',
    ],
    rejected: [
      'git:ABC:320k',
      'kw:ABC:flac',
      'kw:ABC:hires',
      'kw::320k',
      'kw:ABC:320k:extra',
      'kw:../ABC:320k',
      'kw:ABC 123:320k',
      'KW:ABC:320k',
      'https://attacker.example/audio.mp3',
      'netease:123456',
      `kw:${'a'.repeat(97)}:320k`,
    ],
  },
  {
    providerId: 'lx-ikun' as const,
    create: createIkunProvider,
    externalId: 'wy:123456:flac',
    encodedId: 'wy%3A123456%3Aflac',
    mimeType: 'audio/flac',
    accepted: [
      'kw:ABC_def-123:hires',
      'wy:123456:master',
      'wy:123456:atmos',
      'git:ABC123:flac',
      'kw:ABC:128k',
    ],
    rejected: [
      'git:ABC123:hires',
      'git:ABC123:master',
      'kw:ABC123:atmos',
      'kw:ABC123:master',
      'kg:ABC123:320k',
      'tx:ABC123:320k',
      'mg:ABC123:320k',
      'wy:https://attacker.example:320k',
      'wy:ABC:opus',
      `wy:${'a'.repeat(97)}:320k`,
    ],
  },
] as const

describe.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
  '%s server-proxy adapter contract',
  (providerId, fixture) => {
    const resolveUrl = `${APP_ORIGIN}/api/providers/${providerId}/resolve`
    const mediaPath = `/api/providers/${providerId}/media/${fixture.encodedId}/${PREPARATION_NONCE}`
    const playbackUrl = `${APP_ORIGIN}${mediaPath}`

    it('posts only the canonical external ID to the same-origin resolve route', async () => {
      const fetchImpl = stubFetch(responseJson({ mimeType: fixture.mimeType, url: mediaPath }))

      await expect(
        fixture.create({ fetch: fetchImpl }).resolve(
          trackWithSource(providerId, fixture.externalId),
          new AbortController().signal,
        ),
      ).resolves.toEqual({ kind: 'audio', mimeType: fixture.mimeType, url: playbackUrl })

      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(fetchImpl).toHaveBeenCalledWith(resolveUrl, expect.objectContaining({
        body: JSON.stringify({ externalId: fixture.externalId }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        redirect: 'error',
      }))
    })

    it('never sends an operator request key or resolver origin', async () => {
      const fetchImpl = stubFetch(responseJson({ mimeType: fixture.mimeType, url: mediaPath }))

      await fixture.create({ fetch: fetchImpl }).resolve(
        trackWithSource(providerId, fixture.externalId),
        new AbortController().signal,
      )

      const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
      const serialized = `${String(url)} ${JSON.stringify(init?.body)} ${JSON.stringify([...new Headers(init?.headers as HeadersInit)])}`
      expect(serialized).not.toContain(HUIBQ_KEY)
      expect(serialized).not.toContain('x-request-key')
      expect(serialized).not.toContain('huibq.example')
      expect(serialized).not.toContain('ikun.example')
    })

    it.each(fixture.accepted)('accepts a canonical binding: %s', async (externalId) => {
      const encoded = encodeURIComponent(externalId)
      const url = `/api/providers/${providerId}/media/${encoded}/${PREPARATION_NONCE}`
      const fetchImpl = stubFetch(responseJson({ mimeType: fixture.mimeType, url }))

      await expect(
        fixture.create({ fetch: fetchImpl }).resolve(
          trackWithSource(providerId, externalId),
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ kind: 'audio' })
      expect(fetchImpl).toHaveBeenCalledOnce()
    })

    it.each(fixture.rejected)(
      'rejects a non-canonical binding before contacting the resolver: %s',
      async (externalId) => {
        const fetchImpl = vi.fn() as unknown as typeof fetch

        await expectFailureCode(
          fixture.create({ fetch: fetchImpl }).resolve(
            trackWithSource(providerId, externalId),
            new AbortController().signal,
          ),
          'invalid_response',
        )
        expect(fetchImpl).not.toHaveBeenCalled()
      },
    )

    it.each([
      `${APP_ORIGIN}/api/providers/${providerId}/media/${fixture.externalId}/${PREPARATION_NONCE}`,
      `${APP_ORIGIN}/api/providers/${providerId}/media/${encodeURIComponent(fixture.encodedId)}/${PREPARATION_NONCE}`,
      'https://media.operator.example/direct.mp3',
      `${APP_ORIGIN}/api/providers/meting/media/${fixture.encodedId}/${PREPARATION_NONCE}`,
    ])('rejects a non-canonical or external media URL: %s', async (url) => {
      await expectFailureCode(
        fixture.create({
          fetch: stubFetch(responseJson({ mimeType: fixture.mimeType, url })),
        }).resolve(
          trackWithSource(providerId, fixture.externalId),
          new AbortController().signal,
        ),
        'invalid_response',
      )
    })

    it('returns null when the track has no mapping for this provider', async () => {
      const fetchImpl = vi.fn() as unknown as typeof fetch

      await expect(
        fixture.create({ fetch: fetchImpl }).resolve(
          trackWithSource('r2', 'other-track'),
          new AbortController().signal,
        ),
      ).resolves.toBeNull()
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('maps a rate-limited resolver response without retrying', async () => {
      const fetchImpl = stubFetch(responseJson({ error: 'rate_limited' }, 429))

      await expectFailureCode(
        fixture.create({ fetch: fetchImpl }).resolve(
          trackWithSource(providerId, fixture.externalId),
          new AbortController().signal,
        ),
        'rate_limited',
      )
      expect(fetchImpl).toHaveBeenCalledOnce()
    })

    it('maps an unavailable resolver response without retrying', async () => {
      const fetchImpl = stubFetch(responseJson({ error: 'unavailable' }, 503))

      await expectFailureCode(
        fixture.create({ fetch: fetchImpl }).resolve(
          trackWithSource(providerId, fixture.externalId),
          new AbortController().signal,
        ),
        'unavailable',
      )
      expect(fetchImpl).toHaveBeenCalledOnce()
    })

    it('exposes the canonical provider ID', () => {
      expect(fixture.create({}).id).toBe(providerId)
    })
  },
)
