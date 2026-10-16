import { describe, expect, it, vi } from 'vitest'

import {
  parseHuanyinExternalId,
  resolveHuanyinMetadata,
} from '../providers/huanyin'
import { createExactMediaUrlValidator } from '../providers/resolverMediaUrl'

const HUANYIN_ORIGIN = 'https://music-dl.example.invalid'
const EXTERNAL_ID = 'netease:2100334024'
const EXTERNAL_ID_WITH_QUALITY = 'netease:2100334024:320k'
const MEDIA_URL = 'https://media.example.invalid/audio/2100334024.mp3'

const validResponse = (overrides: Record<string, unknown> = {}) => ({
  code: 200,
  url: MEDIA_URL,
  ...overrides,
})

const jsonResponse = (value: unknown, init: ResponseInit = {}) => new Response(
  JSON.stringify(value),
  {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  },
)

const resolve = (
  fetchImpl: typeof fetch,
  externalId: string = EXTERNAL_ID,
  validateMediaUrl: (value: string) => URL | null = createExactMediaUrlValidator(['media.example.invalid']),
) => resolveHuanyinMetadata({
  configuredOrigin: HUANYIN_ORIGIN,
  externalId,
  fetch: fetchImpl,
  validateMediaUrl,
})

describe('HuanYin external ID parser', () => {
  it.each([
    ['netease:2100334024', { source: 'netease', id: '2100334024' }],
    ['netease:2100334024:128k', { source: 'netease', id: '2100334024', quality: '128k' }],
    ['netease:2100334024:320k', { source: 'netease', id: '2100334024', quality: '320k' }],
    ['netease:2100334024:flac', { source: 'netease', id: '2100334024', quality: 'flac' }],
    ['netease:2100334024:flac24bit', { source: 'netease', id: '2100334024', quality: 'flac24bit' }],
    ['kuwo:12345678', { source: 'kuwo', id: '12345678' }],
    ['qq:001fNThf1S2PM9', { source: 'qq', id: '001fNThf1S2PM9' }],
    ['tencent:001fNThf1S2PM9', { source: 'tencent', id: '001fNThf1S2PM9' }],
    ['migu:60054701923', { source: 'migu', id: '60054701923' }],
  ] as const)('accepts valid source:id[:quality] mapping: %s', (input, expected) => {
    expect(parseHuanyinExternalId(input)).toEqual(expected)
  })

  it.each([
    '',
    '   ',
    ' netease:2100334024',
    'netease:2100334024 ',
    'NETEASE:2100334024',
    'unknown:2100334024',
    'netease:',
    'netease::320k',
    'netease:2100334024:',
    'netease:2100334024:64k',
    'netease:2100334024:hires',
    'netease:../2100334024',
    'netease:2100334024?type=url',
    'netease:2100334024#frag',
    'https://music-dl.sayqz.com/api/?id=2100334024',
    'La Vaguelette',
    `netease:${'a'.repeat(65)}`,
  ])('rejects non-canonical or malformed external ID: %s', (input) => {
    expect(parseHuanyinExternalId(input)).toBeNull()
  })
})

describe('HuanYin metadata adapter', () => {
  it('makes one GET request with exact required parameters', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validResponse())) as unknown as typeof fetch
    const validateMediaUrl = vi.fn((value: string) => new URL(value))

    const result = await resolve(fetchImpl, EXTERNAL_ID_WITH_QUALITY, validateMediaUrl)

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(MEDIA_URL),
      mimeType: 'audio/mpeg',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [calledUrl, calledInit] = (fetchImpl as any).mock.calls[0]
    const parsedUrl = new URL(calledUrl)
    expect(parsedUrl.origin).toBe(HUANYIN_ORIGIN)
    expect(parsedUrl.pathname).toBe('/api/')
    expect(parsedUrl.searchParams.get('type')).toBe('url')
    expect(parsedUrl.searchParams.get('source')).toBe('netease')
    expect(parsedUrl.searchParams.get('id')).toBe('2100334024')
    expect(parsedUrl.searchParams.get('br')).toBe('320k')

    expect(calledInit.method).toBe('GET')
    expect(calledInit.redirect).toBe('manual')
    expect(calledInit.signal).toEqual(expect.any(AbortSignal))

    expect(validateMediaUrl).toHaveBeenCalledOnce()
    expect(validateMediaUrl).toHaveBeenCalledWith(MEDIA_URL)
  })

  it('accepts nested data.url response shape', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 200,
      data: { url: MEDIA_URL },
    })) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(MEDIA_URL),
      mimeType: 'audio/mpeg',
    })
  })

  it('detects flac mimeType for flac quality', async () => {
    const flacUrl = 'https://media.example.invalid/audio/2100334024.flac'
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 200,
      url: flacUrl,
    })) as unknown as typeof fetch

    const result = await resolve(fetchImpl, 'netease:2100334024:flac')

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(flacUrl),
      mimeType: 'audio/flac',
    })
  })

  it('rejects invalid external ID before making an HTTP request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const result = await resolveHuanyinMetadata({
      configuredOrigin: HUANYIN_ORIGIN,
      externalId: 'invalid-format',
      fetch: fetchImpl,
      validateMediaUrl: () => null,
    })

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects empty or missing URL in response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 200, url: '' })) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toEqual({ ok: false, error: 'unavailable' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects unallowlisted media URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      code: 200,
      url: 'https://untrusted.attacker.invalid/audio.mp3',
    })) as unknown as typeof fetch

    const result = await resolve(fetchImpl, EXTERNAL_ID, () => null)

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
  })

  it('rejects declared response body larger than 64 KiB', async () => {
    const response = jsonResponse(validResponse(), {
      headers: { 'content-length': String(64 * 1024 + 1) },
    })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(response.bodyUsed).toBe(false)
  })

  it.each([
    ['non-JSON content-type', new Response(JSON.stringify(validResponse()), {
      headers: { 'content-type': 'text/html' },
    })],
    ['malformed JSON', new Response('{"code":200,', {
      headers: { 'content-type': 'application/json' },
    })],
    ['array response', jsonResponse([validResponse()])],
  ])('rejects %s without leaking body', async (_label, response) => {
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
  })

  it('maps 429 to rate_limited', async () => {
    const response = new Response('rate limit', { status: 429 })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'rate_limited' })
  })

  it('rejects 3xx redirects', async () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: 'https://other.example.invalid/api' },
    })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
  })

  it.each([400, 401, 403, 404, 500, 502, 503])('maps HTTP %s to unavailable', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('error', { status })) as unknown as typeof fetch

    const result = await resolve(fetchImpl)
    expect(result).toEqual({ ok: false, error: 'unavailable' })
  })

  it('aborts after four seconds', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolveResponse, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('abort', 'AbortError'))
          })
          setTimeout(() => resolveResponse(jsonResponse(validResponse())), 5_000)
        })) as unknown as typeof fetch

      const pending = resolve(fetchImpl)
      await vi.advanceTimersByTimeAsync(4_000)

      await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not log raw URLs or exception details on failure', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]
    try {
      const fetchImpl = vi.fn(async () => {
        throw new Error(`private error with url ${MEDIA_URL}`)
      }) as unknown as typeof fetch

      const result = await resolve(fetchImpl)
      expect(result).toEqual({ ok: false, error: 'unavailable' })
      expect(JSON.stringify(result)).not.toContain(MEDIA_URL)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
