import { afterEach, describe, expect, it, vi } from 'vitest'

import { createExactMediaUrlValidator } from '../providers/resolverMediaUrl'
import { createLxTransientMedia, resolveLxMetadata } from '../providers/lx/shared'
import type { LxResolverDescriptor } from '../providers/lx/types'

const MEDIA_URL = 'https://media.example/audio?token=temporary'

const descriptor: LxResolverDescriptor = {
  providerId: 'lx-huibq',
  externalIdPattern: /^kw:[A-Za-z0-9_-]{1,32}$/,
  parseExternalId(value) {
    const match = /^kw:([A-Za-z0-9_-]{1,32})$/.exec(value)
    return match ? { source: 'kw', id: match[1]!, quality: '320k' } : null
  },
  buildRequest({ configuredOrigin, binding }) {
    return {
      url: new URL(`/url/${binding.source}/${binding.id}/${binding.quality}`, configuredOrigin),
      headers: {
        accept: 'application/json',
        'x-request-key': 'PROTOCOL_KEY_SENTINEL',
      },
    }
  },
  parseResponse(value, binding) {
    if (
      typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      (value as Record<string, unknown>).source !== binding.source ||
      (value as Record<string, unknown>).id !== binding.id ||
      typeof (value as Record<string, unknown>).url !== 'string' ||
      (value as Record<string, unknown>).mimeType !== 'audio/mpeg'
    ) return null
    return {
      url: (value as Record<string, unknown>).url as string,
      mimeType: 'audio/mpeg',
    }
  },
}

const validBody = {
  source: 'kw',
  id: 'song_1',
  url: MEDIA_URL,
  mimeType: 'audio/mpeg',
}

const resolve = (fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) =>
  resolveLxMetadata({
    descriptor,
    configuredOrigin: 'https://resolver.example',
    externalId: 'kw:song_1',
    fetch: fetchImpl,
    validateMediaUrl: createExactMediaUrlValidator(['media.example']),
    ...overrides,
  })

class FakeCache {
  readonly entries = new Map<string, Response>()

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const request = input instanceof Request ? input : new Request(input)
    return this.entries.get(`${request.method} ${request.url}`)?.clone()
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const request = input instanceof Request ? input : new Request(input)
    this.entries.set(`${request.method} ${request.url}`, response.clone())
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('safe LX resolver primitive', () => {
  it('makes one finite manual-redirect request and validates the exact media host', async () => {
    const fetchImpl = vi.fn(async () => Response.json(validBody)) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({
      ok: true,
      mediaUrl: new URL(MEDIA_URL),
      mimeType: 'audio/mpeg',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(String(url)).toBe('https://resolver.example/url/kw/song_1/320k')
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(new Headers(init?.headers).get('x-request-key')).toBe('PROTOCOL_KEY_SENTINEL')
  })

  it.each([
    ['invalid external ID', { externalId: 'https://attacker.example/audio' }, 0],
    ['oversized external ID', { externalId: `kw:${'a'.repeat(129)}` }, 0],
    ['newline external ID', { externalId: 'kw:song\nother' }, 0],
    ['malformed schema', { response: Response.json({ url: MEDIA_URL }) }, 1],
    ['metadata redirect', { response: new Response(null, { status: 302, headers: { location: '/next' } }) }, 1],
    ['non-JSON response', { response: new Response('{}', { headers: { 'content-type': 'text/plain' } }) }, 1],
    ['malformed JSON', { response: new Response('{', { headers: { 'content-type': 'application/json' } }) }, 1],
    ['declared oversized JSON', { response: new Response('{}', { headers: { 'content-length': '65537', 'content-type': 'application/json' } }) }, 1],
    ['streamed oversized JSON', { response: new Response(`{"padding":"${'x'.repeat(65_537)}"}`, { headers: { 'content-type': 'application/json' } }) }, 1],
    ['unsafe media protocol', { response: Response.json({ ...validBody, url: 'http://media.example/audio' }) }, 1],
    ['unsafe media hostname', { response: Response.json({ ...validBody, url: 'https://attacker.example/audio' }) }, 1],
  ])('fails closed for %s', async (_label, fixture, calls) => {
    const response = 'response' in fixture ? fixture.response : Response.json(validBody)
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl, fixture)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).toHaveBeenCalledTimes(calls)
  })

  it.each([
    [429, 'rate_limited'],
    [403, 'unavailable'],
    [500, 'unavailable'],
  ] as const)('maps upstream %s without retry', async (status, error) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('preserves a finite adapter application-level failure without retry', async () => {
    const fetchImpl = vi.fn(async () => Response.json(validBody)) as unknown as typeof fetch
    const rateLimitedDescriptor: LxResolverDescriptor = {
      ...descriptor,
      parseResponse: () => ({ error: 'rate_limited' }),
    }

    await expect(resolve(fetchImpl, { descriptor: rateLimitedDescriptor })).resolves.toEqual({
      ok: false,
      error: 'rate_limited',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    'http://resolver.example',
    'https://user:password@resolver.example',
    'https://resolver.example:8443',
    'https://resolver.example/api',
    'https://resolver.example?token=secret',
    'https://resolver.example#fragment',
    'https://LOCALHOST',
    'https://127.0.0.1',
    'https://[::1]',
    'https://resolver.internal',
  ])('rejects unsafe resolver origin %s before fetch', async (configuredOrigin) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    await expect(resolve(fetchImpl, { configuredOrigin })).resolves.toEqual({
      ok: false,
      error: 'invalid_response',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps throwing schema and media validators to invalid_response', async () => {
    const fetchImpl = vi.fn(async () => Response.json(validBody)) as unknown as typeof fetch
    const throwingDescriptor = {
      ...descriptor,
      parseResponse() { throw new Error('unsafe body') },
    }

    await expect(resolve(fetchImpl, { descriptor: throwingDescriptor })).resolves.toEqual({
      ok: false,
      error: 'invalid_response',
    })
    await expect(resolve(fetchImpl, {
      validateMediaUrl() { throw new Error('unsafe URL') },
    })).resolves.toEqual({ ok: false, error: 'invalid_response' })
  })

  it('aborts a hung resolver at the four-second boundary', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
    )) as unknown as typeof fetch

    const pending = resolve(fetchImpl)
    await vi.advanceTimersByTimeAsync(4_000)

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('times out while a successful response body remains pending', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({
      pull() { return new Promise<void>(() => undefined) },
    }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

    const pending = resolve(fetchImpl)
    await vi.advanceTimersByTimeAsync(4_000)

    await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' })
  })

  it('creates only a same-origin transient ticket and keeps the media URL inside Cache API state', async () => {
    const cache = new FakeCache()
    let effective = true
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 206,
      headers: {
        'accept-ranges': 'bytes',
        'content-length': '1',
        'content-range': 'bytes 0-0/20',
        'content-type': 'audio/mpeg',
      },
    })) as unknown as typeof fetch
    const media = createLxTransientMedia({
      descriptor,
      publicOrigin: 'https://study.example',
      validateUrl: createExactMediaUrlValidator(['media.example']),
      isEffective: async () => effective,
    }, {
      cache: cache as unknown as Cache,
      crypto: {
        getRandomValues(bytes: Uint8Array) {
          bytes.forEach((_value, index) => { bytes[index] = index })
          return bytes
        },
      } as unknown as Crypto,
      fetch: fetchImpl,
      now: () => 1_000,
    })

    const prepared = await media.prepare({
      externalId: 'kw:song_1',
      validatedUrl: new URL(MEDIA_URL),
      mimeType: 'audio/mpeg',
    })

    expect(prepared).toEqual({
      mimeType: 'audio/mpeg',
      url: '/api/providers/lx-huibq/media/kw%3Asong_1/AAECAwQFBgcICQoLDA0ODxAREhMUFRYX',
    })
    expect(JSON.stringify(prepared)).not.toContain('media.example')
    expect([...cache.entries.values()]).toHaveLength(1)
    const ticketText = await [...cache.entries.values()][0]!.clone().text()
    expect(ticketText).toContain(MEDIA_URL)
    expect(ticketText).not.toContain('PROTOCOL_KEY_SENTINEL')
    expect(ticketText).not.toContain('resolver.example')

    effective = false
    const mediaUrl = new URL(prepared!.url, 'https://study.example')
    const disabled = await media.serve(new Request(mediaUrl, {
      headers: { range: 'bytes=0-0' },
    }), mediaUrl)
    expect(disabled.status).toBe(503)
    expect(fetchImpl).not.toHaveBeenCalled()

    effective = true
    const ranged = await media.serve(new Request(mediaUrl, {
      headers: { range: 'bytes=0-0' },
    }), mediaUrl)
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe('bytes 0-0/20')
    expect(new Headers(vi.mocked(fetchImpl).mock.calls[0]![1]?.headers).get('range')).toBe('bytes=0-0')
  })

  it('rejects a stateful descriptor pattern before constructing the ticket boundary', () => {
    expect(() => createLxTransientMedia({
      descriptor: { ...descriptor, externalIdPattern: /^kw:.+$/g },
      publicOrigin: 'https://study.example',
      validateUrl: createExactMediaUrlValidator(['media.example']),
      isEffective: async () => true,
    }, {
      cache: new FakeCache() as unknown as Cache,
      crypto: crypto,
      fetch,
      now: () => 1_000,
    })).toThrow('LX external ID pattern must be stateless')
  })
})
