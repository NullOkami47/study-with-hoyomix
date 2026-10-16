import { describe, expect, it, vi } from 'vitest'

import type { CanonicalProviderId } from '../providers/config'
import { createTransientMedia } from '../providers/transientMedia'

const PUBLIC_ORIGIN = 'https://study.example'
const EXTERNAL_ID = '1315196858'
const MEDIA_URL = 'https://media.example/audio?temporary=private'
const NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX'

class MemoryCache {
  readonly entries = new Map<string, {
    body: Uint8Array
    headers: Headers
    status: number
    statusText: string
  }>()

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const request = input instanceof Request ? input : new Request(input)
    const stored = this.entries.get(`${request.method} ${request.url}`)
    return stored
      ? new Response(stored.body.slice(), {
          headers: stored.headers,
          status: stored.status,
          statusText: stored.statusText,
        })
      : undefined
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const request = input instanceof Request ? input : new Request(input)
    this.entries.set(`${request.method} ${request.url}`, {
      body: new Uint8Array(await response.arrayBuffer()),
      headers: new Headers(response.headers),
      status: response.status,
      statusText: response.statusText,
    })
  }
}

const deterministicCrypto = {
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
    if (!(array instanceof Uint8Array)) throw new TypeError('Uint8Array required')
    array.forEach((_value, index) => { array[index] = index })
    return array as T
  },
} as unknown as Crypto

const exactMediaUrl = (value: unknown) => {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname === 'media.example'
      ? parsed
      : null
  } catch {
    return null
  }
}

const createSubject = (
  providerId: CanonicalProviderId,
  cache: MemoryCache,
  fetchImpl: typeof fetch,
  now: () => number,
) => createTransientMedia({
  externalIdPattern: /^[0-9]{1,20}$/,
  providerId,
  publicOrigin: PUBLIC_ORIGIN,
  validateUrl: exactMediaUrl,
}, {
  cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
  crypto: deterministicCrypto,
  fetch: fetchImpl,
  now,
})

const mediaPath = (providerId: CanonicalProviderId = 'chksz') =>
  `/api/providers/${providerId}/media/${EXTERNAL_ID}/${NONCE}`

const cachedTicket = (overrides: Record<string, unknown> = {}) => Response.json({
  providerId: 'chksz',
  externalId: EXTERNAL_ID,
  nonce: NONCE,
  validatedUrl: MEDIA_URL,
  mimeType: 'audio/mpeg',
  expiresAt: 31_000,
  ...overrides,
}, { headers: { 'cache-control': 'max-age=30' } })

const putTicket = (
  cache: MemoryCache,
  response: Response,
  providerId: CanonicalProviderId = 'chksz',
) => cache.put(
  new Request(`${PUBLIC_ORIGIN}${mediaPath(providerId)}`),
  response,
)

describe('security: transient media ticket boundaries', () => {
  it('returns an opaque same-origin path while keeping the validated upstream URL only in cache', async () => {
    const cache = new MemoryCache()
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const subject = createSubject('chksz', cache, fetchImpl, () => 1_000)

    const prepared = await subject.prepare({
      externalId: EXTERNAL_ID,
      mimeType: 'audio/mpeg',
      validatedUrl: new URL(MEDIA_URL),
    })

    expect(prepared).toEqual({ mimeType: 'audio/mpeg', url: mediaPath() })
    expect(JSON.stringify(prepared)).not.toContain('media.example')
    expect(JSON.stringify(prepared)).not.toContain('temporary')
    expect(cache.entries).toHaveLength(1)
    const storedResponse = await cache.match(new Request(`${PUBLIC_ORIGIN}${mediaPath()}`))
    const stored = await storedResponse?.json()
    expect(stored).toEqual({
      providerId: 'chksz',
      externalId: EXTERNAL_ID,
      nonce: NONCE,
      validatedUrl: MEDIA_URL,
      mimeType: 'audio/mpeg',
      expiresAt: 31_000,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not resolve a ticket prepared under a different provider cache namespace', async () => {
    const cache = new MemoryCache()
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const chksz = createSubject('chksz', cache, fetchImpl, () => 1_000)
    const meting = createSubject('meting', cache, fetchImpl, () => 1_000)
    await chksz.prepare({
      externalId: EXTERNAL_ID,
      mimeType: 'audio/mpeg',
      validatedUrl: new URL(MEDIA_URL),
    })

    const response = await meting.serve(
      new Request(`${PUBLIC_ORIGIN}${mediaPath('meting')}`),
      new URL(`${PUBLIC_ORIGIN}${mediaPath('meting')}`),
    )

    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({ error: 'preparation_expired' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['provider substitution', { providerId: 'meting' }, 502],
    ['external ID substitution', { externalId: '1315196859' }, 502],
    ['nonce substitution', { nonce: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }, 502],
    ['an extra ticket field', { attacker: true }, 502],
    ['an expired timestamp', { expiresAt: 1_000 }, 410],
    ['a timestamp beyond the 30-second lifetime', { expiresAt: 31_001 }, 502],
    ['a fractional timestamp', { expiresAt: 30_999.5 }, 502],
    ['an unsafe cached URL', { validatedUrl: 'https://attacker.example/audio' }, 502],
    ['a non-audio cached MIME', { mimeType: 'text/html' }, 502],
  ])('rejects %s before contacting upstream media', async (_label, overrides, status) => {
    const cache = new MemoryCache()
    await putTicket(cache, cachedTicket(overrides))
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const subject = createSubject('chksz', cache, fetchImpl, () => 1_000)
    const request = new Request(`${PUBLIC_ORIGIN}${mediaPath()}`)

    const response = await subject.serve(request, new URL(request.url))

    expect(response.status).toBe(status)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['a declared ticket larger than 1 KiB', new Response('{}', {
      headers: { 'content-length': '1025', 'content-type': 'application/json' },
    })],
    ['a streamed ticket larger than 1 KiB', new Response('x'.repeat(1_025), {
      headers: { 'content-type': 'application/json' },
    })],
  ])('rejects %s before parsing or contacting upstream media', async (_label, ticket) => {
    const cache = new MemoryCache()
    await putTicket(cache, ticket)
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const subject = createSubject('chksz', cache, fetchImpl, () => 1_000)
    const request = new Request(`${PUBLIC_ORIGIN}${mediaPath()}`)

    const response = await subject.serve(request, new URL(request.url))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'invalid_response' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('attaches upstream headers when configured without leaking to client response', async () => {
    const cache = new MemoryCache()
    await putTicket(cache, cachedTicket({ providerId: 'jellyfin' }), 'jellyfin')
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'audio/mpeg', 'content-length': '3' },
      status: 200,
    })) as unknown as typeof fetch

    const subject = createTransientMedia({
      externalIdPattern: /^[0-9]{1,20}$/,
      providerId: 'jellyfin',
      publicOrigin: PUBLIC_ORIGIN,
      validateUrl: exactMediaUrl,
      getUpstreamHeaders: () => ({
        'x-emby-token': 'secret-jellyfin-token',
        authorization: 'MediaBrowser Token="secret-jellyfin-token"',
      }),
    }, {
      cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
      crypto: deterministicCrypto,
      fetch: fetchImpl,
      now: () => 1_000,
    })

    const request = new Request(`${PUBLIC_ORIGIN}${mediaPath('jellyfin')}`)
    const response = await subject.serve(request, new URL(request.url))

    expect(response.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [calledUrl, calledInit] = (fetchImpl as any).mock.calls[0]
    expect(calledInit.headers.get('x-emby-token')).toBe('secret-jellyfin-token')
    expect(calledInit.headers.get('authorization')).toBe('MediaBrowser Token="secret-jellyfin-token"')

    // Verify secret is NOT in client response headers
    expect(response.headers.get('x-emby-token')).toBeNull()
    expect(response.headers.get('authorization')).toBeNull()
  })
})
