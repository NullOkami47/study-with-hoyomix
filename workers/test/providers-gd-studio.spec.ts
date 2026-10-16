import { describe, expect, it, vi } from 'vitest'

import {
  parseGdStudioExternalId,
  resolveGdStudioMetadata,
} from '../providers/gdStudio'
import { createExactMediaUrlValidator } from '../providers/resolverMediaUrl'

const GD_STUDIO_ORIGIN = 'https://music-api.gdstudio.xyz'
const EXTERNAL_ID = 'netease:2100334024'
const EXTERNAL_ID_WITH_BR = 'netease:2100334024:320'
const MEDIA_URL = 'https://m701.music.126.net/audio/2100334024.mp3?token=ephemeral'

const validResponse = (overrides: Record<string, unknown> = {}) => ({
  url: MEDIA_URL,
  br: 320,
  size: 5983725,
  from: 'music.gdstudio.xyz',
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
  validateMediaUrl: (value: string) => URL | null = createExactMediaUrlValidator(['m701.music.126.net']),
) => resolveGdStudioMetadata({
  configuredOrigin: GD_STUDIO_ORIGIN,
  externalId,
  fetch: fetchImpl,
  validateMediaUrl,
})

describe('GD Studio external ID parser', () => {
  it.each([
    ['netease:2100334024', { source: 'netease', id: '2100334024' }],
    ['netease:2100334024:320', { source: 'netease', id: '2100334024', br: 320 }],
    ['netease:2100334024:128', { source: 'netease', id: '2100334024', br: 128 }],
    ['netease:2100334024:192', { source: 'netease', id: '2100334024', br: 192 }],
    ['netease:2100334024:740', { source: 'netease', id: '2100334024', br: 740 }],
    ['netease:2100334024:999', { source: 'netease', id: '2100334024', br: 999 }],
    ['tencent:001fNThf1S2PM9', { source: 'tencent', id: '001fNThf1S2PM9' }],
    ['tencent:001fNThf1S2PM9:320', { source: 'tencent', id: '001fNThf1S2PM9', br: 320 }],
    ['bilibili:BV1xx411c7mD', { source: 'bilibili', id: 'BV1xx411c7mD' }],
    ['kuwo:12345678', { source: 'kuwo', id: '12345678' }],
    ['joox:abc_123', { source: 'joox', id: 'abc_123' }],
  ] as const)('accepts valid bounded source:id[:br] mapping: %s', (input, expected) => {
    expect(parseGdStudioExternalId(input)).toEqual(expected)
  })

  it.each([
    '',
    '   ',
    ' netease:2100334024',
    'netease:2100334024 ',
    'NETEASE:2100334024',
    'unknown:2100334024',
    'netease:',
    'netease::320',
    'netease:2100334024:',
    'netease:2100334024:64', // unsupported bitrate
    'netease:2100334024:0',
    'netease:2100334024:abc',
    'netease:../2100334024',
    'netease:2100334024?types=url',
    'netease:2100334024#frag',
    'netease:2100334024/audio',
    'https://music-api.gdstudio.xyz/api.php?types=url&id=2100334024',
    'La Vaguelette',
    'netease:La Vaguelette',
    `netease:${'a'.repeat(65)}`, // oversized ID
  ])('rejects non-canonical or malformed external ID: %s', (input) => {
    expect(parseGdStudioExternalId(input)).toBeNull()
  })
})

describe('GD Studio metadata adapter', () => {
  it('makes one GET request with exact required parameters', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validResponse())) as unknown as typeof fetch
    const validateMediaUrl = vi.fn((value: string) => new URL(value))

    const result = await resolve(fetchImpl, EXTERNAL_ID_WITH_BR, validateMediaUrl)

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(MEDIA_URL),
      mimeType: 'audio/mpeg',
      br: 320,
      size: 5983725,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [calledUrl, calledInit] = (fetchImpl as any).mock.calls[0]
    const parsedUrl = new URL(calledUrl)
    expect(parsedUrl.origin).toBe(GD_STUDIO_ORIGIN)
    expect(parsedUrl.pathname).toBe('/api.php')
    expect(parsedUrl.searchParams.get('types')).toBe('url')
    expect(parsedUrl.searchParams.get('source')).toBe('netease')
    expect(parsedUrl.searchParams.get('id')).toBe('2100334024')
    expect(parsedUrl.searchParams.get('br')).toBe('320')
    expect(Array.from(parsedUrl.searchParams.keys()).sort()).toEqual(['br', 'id', 'source', 'types'])

    expect(calledInit.method).toBe('GET')
    expect(calledInit.redirect).toBe('manual')
    expect(calledInit.signal).toEqual(expect.any(AbortSignal))

    expect(validateMediaUrl).toHaveBeenCalledOnce()
    expect(validateMediaUrl).toHaveBeenCalledWith(MEDIA_URL)
  })

  it('omits br parameter when not present in external ID', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validResponse())) as unknown as typeof fetch

    const result = await resolve(fetchImpl, EXTERNAL_ID)

    expect(result.ok).toBe(true)
    const [calledUrl] = (fetchImpl as any).mock.calls[0]
    const parsedUrl = new URL(calledUrl)
    expect(parsedUrl.searchParams.has('br')).toBe(false)
    expect(parsedUrl.searchParams.get('types')).toBe('url')
    expect(parsedUrl.searchParams.get('source')).toBe('netease')
    expect(parsedUrl.searchParams.get('id')).toBe('2100334024')
  })

  it('detects flac mimeType from media URL pathname', async () => {
    const flacUrl = 'https://m701.music.126.net/audio/2100334024.flac'
    const fetchImpl = vi.fn(async () => jsonResponse(validResponse({ url: flacUrl }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl, EXTERNAL_ID, (val) => new URL(val))

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      mediaUrl: new URL(flacUrl),
      mimeType: 'audio/flac',
    }))
  })

  it('rejects invalid external ID before making an HTTP request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const result = await resolveGdStudioMetadata({
      configuredOrigin: GD_STUDIO_ORIGIN,
      externalId: 'invalid-format',
      fetch: fetchImpl,
      validateMediaUrl: () => null,
    })

    expect(result).toMatchObject({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an empty or missing url field in response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validResponse({ url: '' }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toMatchObject({ ok: false, error: 'unavailable' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects when validateMediaUrl returns null (unallowlisted host)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validResponse({
      url: 'https://evil.attacker.invalid/audio.mp3',
    }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl, EXTERNAL_ID, () => null)

    expect(result).toMatchObject({ ok: false, error: 'invalid_response' })
  })

  it('rejects declared response body larger than 64 KiB without reading it', async () => {
    const response = jsonResponse(validResponse(), {
      headers: { 'content-length': String(64 * 1024 + 1) },
    })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toMatchObject({ ok: false, error: 'invalid_response' })
    expect(response.bodyUsed).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects streamed response body larger than 64 KiB', async () => {
    const body = `${' '.repeat(64 * 1024)}${JSON.stringify(validResponse())}`
    const fetchImpl = vi.fn(async () => new Response(body, {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toMatchObject({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    ['non-JSON content-type', new Response(JSON.stringify(validResponse()), {
      headers: { 'content-type': 'text/html' },
    })],
    ['malformed JSON', new Response('{"url":"https://...', {
      headers: { 'content-type': 'application/json' },
    })],
    ['array response', jsonResponse([validResponse()])],
  ])('rejects %s without exposing body', async (_label, response) => {
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toMatchObject({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('maps 429 to rate_limited without reading or retrying', async () => {
    const response = new Response('rate limit', { status: 429 })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toMatchObject({ ok: false, error: 'rate_limited' })
    expect(response.bodyUsed).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects 3xx redirects without following', async () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: 'https://other.example.invalid/api.php' },
    })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toMatchObject({ ok: false, error: 'invalid_response' })
    expect(response.bodyUsed).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([400, 401, 403, 404, 500, 502, 503])('maps HTTP %s to unavailable', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('error detail', { status })) as unknown as typeof fetch

    const result = await resolve(fetchImpl)
    expect(result).toMatchObject({ ok: false, error: 'unavailable' })
    expect(fetchImpl).toHaveBeenCalledOnce()
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

      await expect(pending).resolves.toMatchObject({ ok: false, error: 'timeout' })
      expect(fetchImpl).toHaveBeenCalledOnce()
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
      expect(result).toMatchObject({ ok: false, error: 'unavailable' })
      expect(JSON.stringify(result)).not.toContain('ephemeral')
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
