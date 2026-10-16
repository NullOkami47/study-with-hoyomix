import { describe, expect, it, vi } from 'vitest'

import {
  parseMetingExternalId,
  resolveMetingMetadata,
} from '../providers/meting'
import {
  createExactMediaUrlValidator,
  createResolverMediaUrlValidator,
} from '../providers/resolverMediaUrl'

const METING_ORIGIN = 'https://meting.example.invalid/'
const EXTERNAL_ID = 'netease:123456789'
const MEDIA_URL = 'https://media.example.invalid/audio?id=temporary'

const metadata = (overrides: Record<string, unknown> = {}) => ({
  server: 'netease',
  id: '123456789',
  url: MEDIA_URL,
  mimeType: 'audio/mpeg',
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
  validateMediaUrl: (value: string) => URL | null =
    createExactMediaUrlValidator(['media.example.invalid']),
) => resolveMetingMetadata({
  configuredOrigin: METING_ORIGIN,
  externalId: EXTERNAL_ID,
  fetch: fetchImpl,
  validateMediaUrl,
})

describe('Meting external ID parser', () => {
  it.each([
    ['netease:1', { server: 'netease', id: '1' }],
    ['netease:123456789', { server: 'netease', id: '123456789' }],
    ['tencent:12345678901234567890', { server: 'tencent', id: '12345678901234567890' }],
  ] as const)('accepts a canonical track binding: %s', (value, expected) => {
    expect(parseMetingExternalId(value)).toEqual(expected)
  })

  it.each([
    '',
    'kuwo:333',
    'netease:',
    'netease:123456789012345678901',
    'netease: 123',
    ' netease:123',
    'netease:+123',
    'netease:-123',
    'netease:123.0',
    'NETEASE:123',
    'https://meting.example.invalid/?id=123',
    'playlist:123',
  ])('rejects a non-canonical binding without interpretation: %s', (value) => {
    expect(parseMetingExternalId(value)).toBeNull()
  })
})

describe('Meting exact media URL policy', () => {
  const validate = createExactMediaUrlValidator([
    'media.example.invalid',
    'second.example.invalid',
  ])

  it.each([
    'https://media.example.invalid/audio?token=temporary',
    'https://second.example.invalid/audio',
  ])('accepts a public HTTPS URL on an exact allowlist member: %s', (value) => {
    expect(validate(value)?.toString()).toBe(value)
  })

  it.each([
    'http://media.example.invalid/audio',
    'https://user:password@media.example.invalid/audio',
    'https://media.example.invalid:8443/audio',
    'https://media.example.invalid:443/audio',
    'https://media.example.invalid/audio#fragment',
    'https://127.0.0.1/audio',
    'https://[::1]/audio',
    'https://localhost/audio',
    'https://media.internal/audio',
    'https://attacker.example/audio',
    'https://sub.media.example.invalid/audio',
    'https://media.example.invalid.attacker.example/audio',
    'https://rr1---sn-example.googlevideo.com/videoplayback',
    'https://googlevideo.com/videoplayback',
    'https://meting.example.invalid/audio',
    'https:\\media.example.invalid\\audio',
    'https://media%2Eexample.invalid/audio',
  ])('rejects an unsafe, implicit, or non-exact media authority: %s', (value) => {
    expect(validate(value)).toBeNull()
  })

  it('does not grant wildcard or invalid allowlist entries any authority', () => {
    const validateInvalid = createExactMediaUrlValidator([
      '*.example.invalid',
      'MEDIA.example.invalid',
      'localhost',
      '127.0.0.1',
    ])

    expect(validateInvalid('https://media.example.invalid/audio')).toBeNull()
    expect(validateInvalid('https://localhost/audio')).toBeNull()
  })

  it('permits a relative redirect only when the exact target host remains allowlisted', () => {
    const current = new URL('https://media.example.invalid/start?token=temporary')

    expect(validate('/next?token=rotated', current)?.toString()).toBe(
      'https://media.example.invalid/next?token=rotated',
    )
    expect(validate('//sub.media.example.invalid/next', current)).toBeNull()
    expect(validate('//googlevideo.com/next', current)).toBeNull()
    expect(validate('https://user@media.example.invalid/next', current)).toBeNull()
  })

  it('leaves the Piped/Invidious configured-origin and googlevideo policy unchanged', () => {
    const validateResolver = createResolverMediaUrlValidator({
      configuredOrigin: 'https://resolver.example.invalid',
      extraAllowedHostnames: ['proxy.example.invalid'],
    })

    expect(validateResolver('https://resolver.example.invalid/audio')).not.toBeNull()
    expect(validateResolver('https://proxy.example.invalid/audio')).not.toBeNull()
    expect(validateResolver('https://rr1---sn-example.googlevideo.com/videoplayback')).not.toBeNull()
    expect(validateResolver('https://attacker.example/audio')).toBeNull()
  })
})

describe('Meting metadata adapter', () => {
  it('makes one exact POST and returns only the requested validated four-key response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadata())) as unknown as typeof fetch
    const validateMediaUrl = vi.fn((value: string) => new URL(value))

    const result = await resolve(fetchImpl, validateMediaUrl)

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(MEDIA_URL),
      mimeType: 'audio/mpeg',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(METING_ORIGIN, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{"server":"netease","id":"123456789"}',
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    })
    expect(validateMediaUrl).toHaveBeenCalledOnce()
    expect(validateMediaUrl).toHaveBeenCalledWith(MEDIA_URL)
  })

  it('rejects an invalid external ID before making a request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const result = await resolveMetingMetadata({
      configuredOrigin: METING_ORIGIN,
      externalId: 'kuwo:333',
      fetch: fetchImpl,
      validateMediaUrl: () => {
        throw new Error('validator must not run')
      },
    })

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['an extra key', metadata({ extra: true })],
    ['a missing key', { server: 'netease', id: '123456789', url: MEDIA_URL }],
    ['a missing binding', { url: MEDIA_URL, mimeType: 'audio/mpeg' }],
    ['an array', [metadata()]],
    ['a null body', null],
    ['a non-string URL', metadata({ url: 123 })],
    ['a non-string MIME', metadata({ mimeType: null })],
  ])('rejects %s instead of widening the four-key contract', async (_label, body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    ['server', metadata({ server: 'tencent' })],
    ['id', metadata({ id: '987654321' })],
  ])('rejects a response whose %s does not match the requested binding', async (_label, body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    'text/html',
    'Audio/mpeg',
    'audio/MPEG',
    'audio/mpeg; charset=utf-8',
    'audio/',
    'audio/*',
    ' audio/mpeg',
  ])('rejects a non-lowercase or parameterised audio MIME essence: %s', async (mimeType) => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadata({ mimeType }))) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
  })

  it.each([
    'http://media.example.invalid/audio',
    'https://user:password@media.example.invalid/audio',
    'https://media.example.invalid:8443/audio',
    'https://media.example.invalid/audio#fragment',
    'https://127.0.0.1/audio',
    'https://media.internal/audio',
    'https://attacker.example/audio',
    'https://sub.media.example.invalid/audio',
    'https://googlevideo.com/videoplayback',
    'https://meting.example.invalid/audio',
    '/relative/audio',
  ])('rejects an unsafe or unallowlisted direct media URL: %s', async (url) => {
    const fetchImpl = vi.fn(async () => jsonResponse(metadata({ url }))) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
  })

  it('rejects a declared metadata body larger than 64 KiB without reading it', async () => {
    const response = jsonResponse(metadata(), {
      headers: { 'content-length': String(64 * 1024 + 1) },
    })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(response.bodyUsed).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects a streamed metadata body larger than 64 KiB', async () => {
    const body = `${' '.repeat(64 * 1024)}${JSON.stringify(metadata())}`
    const fetchImpl = vi.fn(async () => new Response(body, {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    ['a non-JSON response MIME', new Response(JSON.stringify(metadata()), {
      headers: { 'content-type': 'text/html' },
    })],
    ['malformed JSON', new Response('{"server":"netease","private":"must-not-escape"', {
      headers: { 'content-type': 'application/json' },
    })],
  ])('rejects %s without exposing the response body', async (_label, response) => {
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
    expect(JSON.stringify(result)).not.toContain('must-not-escape')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('maps 429 to rate_limited without reading or retrying', async () => {
    const response = new Response('private rate-limit detail', { status: 429 })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'rate_limited' })
    expect(response.bodyUsed).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects an unsafe redirect without following, reading, or retrying', async () => {
    const response = new Response('private redirect detail', {
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
    })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(response.bodyUsed).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    ['an upstream 500', async () => new Response('private upstream detail', { status: 500 })],
    ['a network failure', async () => { throw new Error('private network detail') }],
  ] as const)('maps %s to unavailable without retrying or exposing details', async (_label, outcome) => {
    const fetchImpl = vi.fn(outcome) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toEqual({ ok: false, error: 'unavailable' })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('aborts one metadata request after four seconds', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolveResponse, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('private abort detail', 'AbortError'))
          })
          setTimeout(() => resolveResponse(jsonResponse(metadata())), 5_000)
        })) as unknown as typeof fetch

      const pending = resolve(fetchImpl)
      await vi.advanceTimersByTimeAsync(4_000)

      await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' })
      expect(fetchImpl).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps an abort while reading a pending response body to timeout without logging', async () => {
    vi.useFakeTimers()
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]
    try {
      let response: Response | undefined
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal
        if (!signal) throw new Error('expected request signal')
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener('abort', () => {
              controller.error(new DOMException(
                `private streamed abort detail ${MEDIA_URL}`,
                'AbortError',
              ))
            }, { once: true })
          },
        })
        response = new Response(body, {
          headers: { 'content-type': 'application/json' },
        })
        return response
      }) as unknown as typeof fetch

      const pending = resolve(fetchImpl)
      await vi.advanceTimersByTimeAsync(4_000)

      await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' })
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(response?.bodyUsed).toBe(true)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('does not log raw bodies, URLs, or exceptions on failure', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]
    try {
      const fetchImpl = vi.fn(async () => {
        throw new Error(`private exception ${MEDIA_URL}`)
      }) as unknown as typeof fetch

      await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'unavailable' })
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
