import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../../catalog/types'
import { chkszLevel, validateChkszMetadata } from '../../../shared/chksz'
import { RUNTIME_DENYLIST } from '../../../shared/chkszDiscovery'
import { ProviderResolveError, type ResolveFailureCode } from './types'
import { createChkszProvider } from './chksz'

const USER_KEY = 'chksz_test_0123456789abcdef'
const EXTERNAL_ID = '3334421408'
const MEDIA_URL = 'https://m801.music.126.net/20260913/abc123/xyz.mp3'
const TICKET = 'a'.repeat(32)

const track = (sources: Track['sources'] = [{ provider: 'chksz', externalId: EXTERNAL_ID }]): Track => ({
  id: 'zzz-tiny-giant',
  title: 'Tiny Giant',
  aliases: {},
  games: ['zzz'],
  relationIds: [],
  tabs: ['chill'],
  workGroupId: 'zzz',
  needsClassification: false,
  vocalStatus: 'instrumental',
  sources,
})

const credentialStore = (key: string | null) => ({ key: () => key })

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const metadataBody = (overrides: Record<string, unknown> = {}) => ({
  code: 200,
  data: { id: Number(EXTERNAL_ID), level: 'standard', url: MEDIA_URL, ...overrides },
})

const abortSignal = () => new AbortController().signal

const RESOLVE_URL = new URL('/api/providers/chksz/resolve', globalThis.location.origin).toString()

/** The server-proxy provider validates the final response URL, so the mock must carry it. */
const proxyResponse = (body: unknown): Response => {
  const response = jsonResponse(body)
  Object.defineProperty(response, 'url', { value: RESOLVE_URL })
  return response
}

const proxyMediaBody = () => ({
  url: `/api/providers/chksz/media/${EXTERNAL_ID}/${TICKET}`,
  mimeType: 'audio/mpeg',
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createChkszProvider — A. direct user-key path', () => {
  it('requests the exact ChKSz endpoint with id, standard level, json and the user key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadataBody()))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      ownerFallbackAvailable: false,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), abortSignal())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [requestUrl] = fetchImpl.mock.calls[0] as unknown as [string]
    const url = new URL(requestUrl)
    expect(url.origin).toBe('https://api.chksz.com')
    expect(url.pathname).toBe('/api/163_music')
    expect(url.searchParams.get('id')).toBe(EXTERNAL_ID)
    expect(url.searchParams.get('level')).toBe('standard')
    expect(url.searchParams.get('type')).toBe('json')
    expect(url.searchParams.get('apikey')).toBe(USER_KEY)
    expect([...url.searchParams.keys()].sort()).toEqual(['apikey', 'id', 'level', 'type'])
  })

  it('uses a credential-free, redirect-refusing, no-store fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadataBody()))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      ownerFallbackAvailable: false,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), abortSignal())

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('GET')
    expect(init.cache).toBe('no-store')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
    expect(init.referrerPolicy).toBe('no-referrer')
    const headers = new Headers(init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('x-chksz-api-key')).toBeNull()
    expect(headers.get('cookie')).toBeNull()
  })

  it('never contacts the same-origin ChKSz proxy when a user key exists', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadataBody()))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      ownerFallbackAvailable: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), abortSignal())

    for (const call of fetchImpl.mock.calls) {
      expect(String((call as unknown as [string])[0])).not.toContain('/api/providers/chksz')
    }
  })

  it('returns the validated media URL as a direct audio playable', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadataBody()))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.resolve(track(), abortSignal())).resolves.toEqual({
      kind: 'audio',
      url: MEDIA_URL,
      mimeType: 'audio/mpeg',
      metadata: {
        quality: {
          tier: 'standard',
        },
      },
    })
  })

  it('returns same-origin artwork proxy URL when upstream metadata includes valid picUrl', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadataBody({
      picUrl: 'https://p1.music.126.net/fixture-artwork.jpg',
    })))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const playable = await provider.resolve(track(), abortSignal())
    expect(playable?.metadata?.artworkUrl).toBe(
      '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Ffixture-artwork.jpg',
    )
    expect(playable?.metadata?.artworkUrl).not.toContain(USER_KEY)
  })

  it('omits artworkUrl when upstream metadata has invalid or unsafe picUrl', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadataBody({
      picUrl: 'https://attacker.com/malicious.jpg',
    })))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const playable = await provider.resolve(track(), abortSignal())
    expect(playable?.metadata?.artworkUrl).toBeUndefined()
  })

  it('returns null when the track has no ChKSz source', async () => {
    const fetchImpl = vi.fn()
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.resolve(track([{ provider: 'r2', externalId: 'x' }]), abortSignal()))
      .resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps the canonical provider id', () => {
    const provider = createChkszProvider({ credentialStore: credentialStore(USER_KEY) })
    expect(provider.id).toBe('chksz')
  })
})

describe('createChkszProvider — B. owner fallback path', () => {
  it('uses the existing Worker resolver when there is no user key', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/providers/chksz/resolve')) return proxyResponse(proxyMediaBody())
      throw new Error(`unexpected request: ${url}`)
    })

    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const playable = await provider.resolve(track(), abortSignal())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const requestUrl = String((fetchImpl.mock.calls[0] as unknown as [string])[0])
    expect(new URL(requestUrl).pathname).toBe('/api/providers/chksz/resolve')
    expect(requestUrl).not.toContain('api.chksz.com')
    expect(playable).toEqual({
      kind: 'audio',
      url: expect.stringContaining(`/api/providers/chksz/media/${EXTERNAL_ID}/`),
      mimeType: 'audio/mpeg',
    })
  })

  it('never sends the user key to the Worker when falling back', async () => {
    const fetchImpl = vi.fn(async () => proxyResponse(proxyMediaBody()))

    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), abortSignal())

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('x-chksz-api-key')).toBeNull()
    expect(JSON.stringify(init)).not.toContain(USER_KEY)
  })

  // The Worker cannot honour a quality it was never told. These tests pin the client half of the
  // owner-fallback contract: the selected ChKSz preference is what travels, and it is the ChKSz
  // preference rather than the LX quality.
  it.each([
    ['jymaster'],
    ['sky'],
    ['jyeffect'],
    ['hires'],
    ['lossless'],
    ['exhigh'],
    ['standard'],
  ] as const)('sends the selected ChKSz quality %s to the Worker on the owner-fallback path', async (quality) => {
    const fetchImpl = vi.fn(async () => proxyResponse(proxyMediaBody()))

    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      qualityStore: { chkszQuality: () => quality },
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), abortSignal())

    const [requestUrl, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(requestUrl).pathname).toBe('/api/providers/chksz/resolve')
    expect(JSON.parse(String(init.body))).toEqual({
      externalId: EXTERNAL_ID,
      level: quality,
    })
  })

  it('sends exactly the two permitted resolve keys and nothing else', async () => {
    const fetchImpl = vi.fn(async () => proxyResponse(proxyMediaBody()))

    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      qualityStore: { chkszQuality: () => 'jymaster' },
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), abortSignal())

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual(['externalId', 'level'])
  })

  it('derives the fallback level from the ChKSz preference, not the LX quality', async () => {
    const fetchImpl = vi.fn(async () => proxyResponse(proxyMediaBody()))
    const chkszQuality = vi.fn(() => 'jymaster' as const)

    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      qualityStore: { chkszQuality },
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), abortSignal())

    expect(chkszQuality).toHaveBeenCalledTimes(1)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { level: string }
    expect(body.level).toBe('jymaster')
    // LX-only tiers and LX-only names must never appear on the ChKSz request.
    for (const lxOnly of ['high', '128k', '320k', 'flac']) {
      expect(body.level).not.toBe(lxOnly)
    }
  })

  it('does not route the owner-fallback request through the ChKSz upstream endpoint', async () => {
    const fetchImpl = vi.fn(async () => proxyResponse(proxyMediaBody()))

    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      qualityStore: { chkszQuality: () => 'sky' },
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), abortSignal())

    const [requestUrl] = fetchImpl.mock.calls[0] as unknown as [string]
    expect(String(requestUrl)).not.toContain('api.chksz.com')
  })

  const fallbackFailure = (body: unknown, status: number) => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const response = jsonResponse(body, status)
      Object.defineProperty(response, 'url', { value: url })
      return response
    })
    return createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })
  }

  // The Worker reports every non-429 upstream failure as 502 with the truthful code in the body,
  // so the client must not flatten 402/403/404 into a generic outage.
  it.each([
    ['invalid_response'],
    ['invalid_credential'],
    ['quota_exhausted'],
    ['forbidden'],
    ['not_found'],
  ])('surfaces the Worker fallback code %s truthfully', async (code) => {
    await expect(fallbackFailure({ error: code }, 502).resolve(track(), abortSignal()))
      .rejects.toMatchObject({ code })
  })

  it('maps a Worker 429 to rate_limited regardless of body', async () => {
    await expect(fallbackFailure({ error: 'rate_limited' }, 429).resolve(track(), abortSignal()))
      .rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('ignores an unrecognised Worker failure code rather than trusting it', async () => {
    await expect(fallbackFailure({ error: 'made_up_code' }, 502).resolve(track(), abortSignal()))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('surfaces same-origin artwork proxy URL from Worker resolve response', async () => {
    const proxyUrl = '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fserver-cover.jpg'
    const fetchImpl = vi.fn(async () => proxyResponse({
      ...proxyMediaBody(),
      metadata: {
        artworkUrl: proxyUrl,
      },
    }))

    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const playable = await provider.resolve(track(), abortSignal())
    expect(playable?.metadata?.artworkUrl).toBe(`${globalThis.location.origin}${proxyUrl}`)
  })

  it('rejects external non-same-origin artwork URLs returned by Worker proxy', async () => {
    const fetchImpl = vi.fn(async () => proxyResponse({
      ...proxyMediaBody(),
      metadata: {
        artworkUrl: 'https://attacker.com/evil.jpg',
      },
    }))

    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const playable = await provider.resolve(track(), abortSignal())
    expect(playable?.metadata?.artworkUrl).toBeUndefined()
  })
})

describe('createChkszProvider — C. no credential and no fallback', () => {
  it('fails with credential_required and issues no request', async () => {
    const fetchImpl = vi.fn()
    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: false,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.resolve(track(), abortSignal())).rejects.toMatchObject({
      code: 'credential_required',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('createChkszProvider — D. metadata security', () => {
  const rejects = async (body: unknown) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.resolve(track(), abortSignal())).rejects.toMatchObject({
      code: 'invalid_response',
    })
  }

  it('rejects a mismatched returned id', async () => {
    await rejects(metadataBody({ id: 999 }))
  })

  it('rejects a non-standard level', async () => {
    await rejects(metadataBody({ level: 'lossless' }))
  })

  it('rejects off-policy media URLs', async () => {
    for (const url of [
      'http://m801.music.126.net/x.mp3',
      'https://music.126.net/x.mp3',
      'https://m801.music.126.net.evil.example/x.mp3',
      'https://user:pass@m801.music.126.net/x.mp3',
      'https://m801.music.126.net:8443/x.mp3',
      'https://M801.MUSIC.126.NET/x.mp3',
      'https://xn--m801.music.126.net/x.mp3',
      'not a url',
    ]) {
      await rejects(metadataBody({ url }))
    }
  })
})

describe('createChkszProvider — E. error mapping', () => {
  const codeFor = async (status: number): Promise<ResolveFailureCode | undefined> => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'x' }, status))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })
    try {
      await provider.resolve(track(), abortSignal())
      return undefined
    } catch (error) {
      return error instanceof ProviderResolveError ? error.code : undefined
    }
  }

  it.each([
    [400, 'invalid_response'],
    [401, 'invalid_credential'],
    [402, 'quota_exhausted'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, expected) => {
    expect(await codeFor(status)).toBe(expected)
  })

  it('never collapses 402, 403 or 404 into unavailable', async () => {
    expect(await codeFor(402)).toBe('quota_exhausted')
    expect(await codeFor(403)).toBe('forbidden')
    expect(await codeFor(404)).toBe('not_found')
  })

  it('maps malformed JSON to invalid_response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.resolve(track(), abortSignal())).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('maps a non-JSON content type to invalid_response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.resolve(track(), abortSignal())).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('rejects an oversized declared response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(128 * 1024) },
      }))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.resolve(track(), abortSignal())).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })

  it('maps a transport failure to unavailable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down')
    })
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.resolve(track(), abortSignal())).rejects.toMatchObject({
      code: 'unavailable',
      transient: true,
    })
  })

  it('marks a direct 5xx outage transient and keeps every 4xx answer permanent (task 41.6)', async () => {
    const errorFor = async (status: number): Promise<ProviderResolveError> => {
      const provider = createChkszProvider({
        credentialStore: credentialStore(USER_KEY),
        fetch: vi.fn(async () => jsonResponse({ error: 'x' }, status)) as unknown as typeof fetch,
      })
      const error = await provider.resolve(track(), abortSignal()).catch((caught: unknown) => caught)
      expect(error, String(status)).toBeInstanceOf(ProviderResolveError)
      return error as ProviderResolveError
    }
    for (const status of [500, 502, 503, 504]) {
      expect(await errorFor(status), String(status)).toMatchObject({ code: 'unavailable', transient: true })
    }
    for (const status of [400, 401, 402, 403, 404, 410, 429]) {
      expect((await errorFor(status)).transient, String(status)).toBeUndefined()
    }
  })

  it('propagates an aborted signal instead of mapping it to unavailable', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.resolve(track(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('issues exactly one request per resolve and never retries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'x' }, 429))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.resolve(track(), abortSignal())).rejects.toMatchObject({
      code: 'rate_limited',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('createChkszProvider — F. credential secrecy', () => {
  it('keeps the key out of thrown errors', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'x' }, 401))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const error = await provider.resolve(track(), abortSignal()).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ProviderResolveError)
    expect((error as Error).message).not.toContain(USER_KEY)
    expect(String(error)).not.toContain(USER_KEY)
    expect(JSON.stringify((error as Error).message)).not.toContain('apikey')
  })

  it('keeps the key out of a transport-failure error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`failed for ${USER_KEY}`)
    })
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const error = await provider.resolve(track(), abortSignal()).catch((thrown: unknown) => thrown)
    expect(String(error)).not.toContain(USER_KEY)
  })
})

describe('chkszLevel', () => {
  it('maps standard to standard', () => {
    expect(chkszLevel('standard')).toBe('standard')
  })

  it('maps exhigh to exhigh', () => {
    expect(chkszLevel('exhigh')).toBe('exhigh')
  })

  it('maps lossless to lossless', () => {
    expect(chkszLevel('lossless')).toBe('lossless')
  })

  it('maps hires to hires', () => {
    expect(chkszLevel('hires')).toBe('hires')
  })

  it('maps jyeffect to jyeffect', () => {
    expect(chkszLevel('jyeffect')).toBe('jyeffect')
  })

  it('maps sky to sky', () => {
    expect(chkszLevel('sky')).toBe('sky')
  })

  it('maps jymaster to jymaster', () => {
    expect(chkszLevel('jymaster')).toBe('jymaster')
  })

  it('maps legacy high to exhigh', () => {
    expect(chkszLevel('high')).toBe('exhigh')
  })
})

describe('createChkszProvider — canResolve', () => {
  it('returns true for a track with a valid numeric chksz source', () => {
    const provider = createChkszProvider()
    expect(provider.canResolve?.(track())).toBe(true)
  })

  it('returns false for a track with no chksz source', () => {
    const provider = createChkszProvider()
    expect(provider.canResolve?.(track([{ provider: 'jellyfin', externalId: '123' }]))).toBe(false)
  })

  it('returns false for a track with an empty sources array', () => {
    const provider = createChkszProvider()
    expect(provider.canResolve?.(track([]))).toBe(false)
  })

  it('returns false for a non-numeric chksz externalId', () => {
    const provider = createChkszProvider()
    expect(provider.canResolve?.(track([{ provider: 'chksz', externalId: 'not-a-number' }]))).toBe(false)
  })

  it('returns false for an empty string chksz externalId', () => {
    const provider = createChkszProvider()
    expect(provider.canResolve?.(track([{ provider: 'chksz', externalId: '' }]))).toBe(false)
  })
})

describe('createChkszProvider — quality preferences injection', () => {
  it('defaults to standard level when qualityStore is omitted', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadataBody()))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), abortSignal())

    const [requestUrl] = fetchImpl.mock.calls[0] as unknown as [string]
    const url = new URL(requestUrl)
    expect(url.searchParams.get('level')).toBe('standard')
  })

  it.each([
    ['standard', 'standard'],
    ['exhigh', 'exhigh'],
    ['lossless', 'lossless'],
    ['hires', 'hires'],
    ['jyeffect', 'jyeffect'],
    ['sky', 'sky'],
    ['jymaster', 'jymaster'],
  ] as const)('requests level %s as %s from qualityStore and accepts matching response', async (quality, expectedLevel) => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(metadataBody({ level: expectedLevel })))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      qualityStore: { chkszQuality: () => quality },
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const playable = await provider.resolve(track(), abortSignal())

    const [requestUrl] = fetchImpl.mock.calls[0] as unknown as [string]
    const url = new URL(requestUrl)
    expect(url.searchParams.get('level')).toBe(expectedLevel)
    expect(playable).toEqual({
      kind: 'audio',
      url: MEDIA_URL,
      mimeType: 'audio/mpeg',
      metadata: {
        quality: {
          tier: expectedLevel,
        },
      },
    })
  })

  it('rejects a response whose level does not match the requested level', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadataBody({ level: 'standard' })))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      qualityStore: { chkszQuality: () => 'exhigh' },
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.resolve(track(), abortSignal())).rejects.toMatchObject({
      code: 'invalid_response',
    })
  })
})

describe('validateChkszMetadata with requestedLevel', () => {
  it('accepts matching requested level for all ChKSz tiers', () => {
    for (const level of ['standard', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'jymaster']) {
      const body = metadataBody({ level })
      const url = validateChkszMetadata(body, EXTERNAL_ID, level)
      expect(url?.toString()).toBe(MEDIA_URL)
    }
  })

  it('rejects when response level does not match requested level', () => {
    const body = metadataBody({ level: 'standard' })
    expect(validateChkszMetadata(body, EXTERNAL_ID, 'exhigh')).toBeNull()
  })

  it('requires an explicit requested level rather than defaulting to standard', () => {
    // The parameter is no longer optional. Omitting it used to mean "assume standard", which is
    // exactly how an upstream response at the wrong tier could be accepted unnoticed.
    const body = metadataBody({ level: 'standard' })
    expect(validateChkszMetadata(body, EXTERNAL_ID, 'standard')?.toString()).toBe(MEDIA_URL)
    const exhighBody = metadataBody({ level: 'exhigh' })
    expect(validateChkszMetadata(exhighBody, EXTERNAL_ID, 'standard')).toBeNull()
  })
})

// Guard rails for the owner-fallback change: it must not disturb the already-qualified BYOK path,
// and it must not leak a ChKSz-only tier into LX.
describe('createChkszProvider — owner fallback does not disturb the BYOK path', () => {
  it.each([
    'standard', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'jymaster',
  ] as const)('still sends %s directly to api.chksz.com when a user key exists', async (quality) => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadataBody({ level: quality })))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      ownerFallbackAvailable: true,
      qualityStore: { chkszQuality: () => quality },
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const playable = await provider.resolve(track(), abortSignal())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [requestUrl] = fetchImpl.mock.calls[0] as unknown as [string]
    const url = new URL(requestUrl)
    // Direct upstream, never the same-origin Worker resolve endpoint.
    expect(url.origin).toBe('https://api.chksz.com')
    expect(url.pathname).toBe('/api/163_music')
    expect(url.searchParams.get('level')).toBe(quality)
    expect(url.searchParams.get('apikey')).toBe(USER_KEY)
    expect(playable).toEqual({
      kind: 'audio',
      url: MEDIA_URL,
      mimeType: 'audio/mpeg',
      metadata: {
        quality: {
          tier: quality,
        },
      },
    })
  })

  it('prefers the direct path over the Worker fallback even when both are available', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      expect(url).not.toContain('/api/providers/chksz/resolve')
      return jsonResponse(metadataBody({ level: 'sky' }))
    })
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      ownerFallbackAvailable: true,
      qualityStore: { chkszQuality: () => 'sky' },
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), abortSignal())
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('createChkszProvider — dynamic catalogue-wide discovery', () => {
  const dynamicTrack = (id = 'zzz-custom-track', title = 'Custom Track'): Track => ({
    id,
    title,
    aliases: { zh: ['测试曲目'] },
    games: ['zzz'],
    relationIds: [],
    tabs: ['chill'],
    workGroupId: 'zzz',
    needsClassification: false,
    vocalStatus: 'instrumental',
    sources: [{ provider: 'jellyfin', externalId: 'jf_123' }],
  })

  it('canResolve returns true for unmapped track when dynamicDiscovery is enabled with user key', () => {
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      dynamicDiscovery: true,
    })
    expect(provider.canResolve?.(dynamicTrack())).toBe(true)
  })

  it('canResolve returns true for unmapped track when dynamicDiscovery is enabled with owner fallback', () => {
    const provider = createChkszProvider({
      ownerFallbackAvailable: true,
      dynamicDiscovery: true,
    })
    expect(provider.canResolve?.(dynamicTrack())).toBe(true)
  })

  it('canResolve returns false for unmapped track when dynamicDiscovery is enabled without credentials or fallback', () => {
    const provider = createChkszProvider({
      dynamicDiscovery: true,
    })
    expect(provider.canResolve?.(dynamicTrack())).toBe(false)
  })

  it('canResolve returns false for denylisted static source and true for authorized source', () => {
    const provider = createChkszProvider()
    const deniedTrack: Track = {
      ...dynamicTrack('genshin-la-vaguelette', 'La vaguelette'),
      sources: [{ provider: 'chksz', externalId: '2100372359' }],
    }
    expect(provider.canResolve?.(deniedTrack)).toBe(false)

    const authorizedTrack: Track = {
      ...dynamicTrack('genshin-la-vaguelette', 'La vaguelette'),
      sources: [{ provider: 'chksz', externalId: '2100334024' }],
    }
    expect(provider.canResolve?.(authorizedTrack)).toBe(true)
  })

  it('performs dynamic discovery and resolves direct via user key', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/providers/chksz/discover')) {
        expect(init?.method).toBe('POST')
        const headers = new Headers(init?.headers)
        expect(headers.get('x-chksz-api-key')).toBe(USER_KEY)
        const body = JSON.parse(String(init?.body))
        expect(body.trackId).toBe('zzz-custom-track')
        expect(body.metadata.title).toBe('Custom Track')
        return jsonResponse({ ok: true, externalId: EXTERNAL_ID, confidence: 'EXACT', source: 'dynamic_search' })
      }
      if (url.includes('api.chksz.com')) {
        return jsonResponse(metadataBody())
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      dynamicDiscovery: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const playable = await provider.resolve(dynamicTrack(), abortSignal())
    expect(playable).toEqual({
      kind: 'audio',
      url: MEDIA_URL,
      mimeType: 'audio/mpeg',
      metadata: {
        quality: {
          tier: 'standard',
        },
      },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('performs dynamic discovery and resolves via owner fallback when user key absent', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/providers/chksz/discover')) {
        return jsonResponse({ ok: true, externalId: EXTERNAL_ID, confidence: 'HIGH_CONFIDENCE', source: 'dynamic_search' })
      }
      if (url.includes('/api/providers/chksz/resolve')) {
        return proxyResponse(proxyMediaBody())
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })

    const provider = createChkszProvider({
      ownerFallbackAvailable: true,
      dynamicDiscovery: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const playable = await provider.resolve(dynamicTrack(), abortSignal())
    expect(playable).toEqual({
      kind: 'audio',
      url: new URL(`/api/providers/chksz/media/${EXTERNAL_ID}/${TICKET}`, globalThis.location.origin).toString(),
      mimeType: 'audio/mpeg',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('propagates rate_limited when discover endpoint returns 429', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'rate_limited' }, 429))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      dynamicDiscovery: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.resolve(dynamicTrack(), abortSignal())).rejects.toMatchObject({
      code: 'rate_limited',
    })
  })

  it('propagates unavailable when discover endpoint returns negative cache (503)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'no_match' }, 503))
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      dynamicDiscovery: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.resolve(dynamicTrack(), abortSignal())).rejects.toMatchObject({
      code: 'unavailable',
    })
  })

  it('blocks discovered ID if the track and external ID pair is in runtime denylist', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, externalId: '2100372359', confidence: 'EXACT', source: 'dynamic_search' }),
    )
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      dynamicDiscovery: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const laVagueletteTrack = dynamicTrack('genshin-la-vaguelette', 'La vaguelette')
    await expect(provider.resolve(laVagueletteTrack, abortSignal())).rejects.toMatchObject({
      code: 'unavailable',
    })
  })

  it('canResolve returns false for demo sample tracks starting with sample-', () => {
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      dynamicDiscovery: true,
    })
    expect(provider.canResolve?.(dynamicTrack('sample-hsr-track', 'Sample Track'))).toBe(false)
  })

  it('runtime denylist TS constant carries versioned structure', () => {
    expect(typeof RUNTIME_DENYLIST.schema_version).toBe('number')
    expect(typeof RUNTIME_DENYLIST.matcher_version).toBe('string')
    expect(RUNTIME_DENYLIST.matcher_version).toBe('chksz-identity-v1')
    expect(Array.isArray(RUNTIME_DENYLIST.entries)).toBe(true)
  })
})


it('does not transmit a personal Key when its agreement version is obsolete', async () => {
  localStorage.setItem('study-with-hoyomix:third-party-agreement:v1', '0.9')
  const fetchImpl = vi.fn(async () => jsonResponse(metadataBody()))
  const provider = createChkszProvider({ credentialStore: credentialStore(USER_KEY), ownerFallbackAvailable: false, fetch: fetchImpl })
  try {
    await expect(provider.resolve(track(), abortSignal())).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  } finally { localStorage.clear() }
})

// M-05 / D4: the Worker spends the owner key only for a signed-in session and otherwise answers
// `401 {"error":"chksz_key_required"}`. That is not the listener's credential failing, so the
// client reports a non-credential failure and the resolver moves on to the next provider.
describe('createChkszProvider — owner fallback without a session (chksz_key_required)', () => {
  const keyRequired = () => jsonResponse({ error: 'chksz_key_required' }, 401)

  it('maps a Worker resolve 401 chksz_key_required to unavailable, not a credential failure', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const response = keyRequired()
      Object.defineProperty(response, 'url', { value: String(input) })
      return response
    })
    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await expect(provider.resolve(track(), abortSignal())).rejects.toMatchObject({ code: 'unavailable' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('maps a discovery 401 chksz_key_required to unavailable without calling resolve', async () => {
    const fetchImpl = vi.fn(async () => keyRequired())
    const provider = createChkszProvider({
      ownerFallbackAvailable: true,
      dynamicDiscovery: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })
    const unmapped = { ...track([{ provider: 'jellyfin', externalId: 'jf_123' }]), id: 'zzz-unmapped-track' }
    await expect(provider.resolve(unmapped, abortSignal())).rejects.toMatchObject({ code: 'unavailable' })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(String((fetchImpl.mock.calls[0] as unknown as [string])[0])).toContain('/api/providers/chksz/discover')
  })

  it('lets the resolver continue to the next provider after chksz_key_required', async () => {
    const { ProviderRegistry } = await import('./registry')
    const { resolveTrack } = await import('../resolver')
    const chkszFetch = vi.fn(async (input: RequestInfo | URL) => {
      const response = keyRequired()
      Object.defineProperty(response, 'url', { value: String(input) })
      return response
    })
    const next = {
      id: 'jellyfin',
      resolve: vi.fn(async () => ({ kind: 'audio' as const, url: 'https://media.example/next.mp3', mimeType: 'audio/mpeg' })),
    }
    const registry = new ProviderRegistry([
      {
        provider: createChkszProvider({
          credentialStore: credentialStore(null),
          ownerFallbackAvailable: true,
          fetch: chkszFetch as unknown as typeof fetch,
        }),
        enabled: true,
        priority: 1,
        timeoutMs: 1_000,
      },
      { provider: next, enabled: true, priority: 2, timeoutMs: 1_000 },
    ])
    const result = await resolveTrack(
      track([{ provider: 'chksz', externalId: EXTERNAL_ID }, { provider: 'jellyfin', externalId: 'jf_123' }]),
      registry,
    )
    expect(result).toMatchObject({ ok: true, providerId: 'jellyfin' })
    expect(result.attempts[0]).toMatchObject({ providerId: 'chksz', ok: false, code: 'unavailable' })
    expect(chkszFetch).toHaveBeenCalledOnce()
    expect(next.resolve).toHaveBeenCalledOnce()
  })
})
