import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import worker from '../index'
import type { ProviderEnv } from '../providers/config'

const PUBLIC_ORIGIN = 'https://study.example'
const CHKSZ_KEY = 'test-secret-chksz-api-key'
const JELLYFIN_TOKEN = 'test-secret-jellyfin-token'
const JELLYFIN_USER = '0123456789abcdef0123456789abcdef'
const JELLYFIN_ORIGIN = 'https://jellyfin.example'
const VALID_JELLYFIN_ID = '1234abcda0d954293110f4d561b0f614'
const VALID_CHKSZ_ARTWORK_URL = 'https://p1.music.126.net/valid-artwork.jpg'

const createMockDb = (providerOverrides: Record<string, { enabled?: number }> = {}) => ({
  prepare: (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      all: async () => ({
        results: Object.entries(providerOverrides).map(([key, val]) => ({
          providerKey: key,
          enabled: val.enabled ?? 1,
          priority: 10,
          status: 'healthy' as const,
          failureClass: null,
          latencyMs: null,
          checkedAt: null,
          updatedAt: 0,
        })),
      }),
      first: async () => null,
      run: async () => ({}),
    }),
    all: async () => ({
      results: Object.entries(providerOverrides).map(([key, val]) => ({
        providerKey: key,
        enabled: val.enabled ?? 1,
        priority: 10,
        status: 'healthy' as const,
        failureClass: null,
        latencyMs: null,
        checkedAt: null,
        updatedAt: 0,
      })),
    }),
    first: async () => null,
    run: async () => ({}),
  }),
})

const createTestEnv = (overrides: Partial<ProviderEnv> = {}): ProviderEnv => ({
  PUBLIC_ORIGIN,
  SESSION_HMAC_SECRET: 'session-secret-at-least-thirty-two-bytes',
  OAUTH_STATE_SECRET: 'oauth-secret-at-least-thirty-two-bytes',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-client',
  GITHUB_CLIENT_SECRET: 'github-secret',
  CHKSZ_API_KEY: CHKSZ_KEY,
  JELLYFIN_BASE_URL: JELLYFIN_ORIGIN,
  JELLYFIN_API_TOKEN: JELLYFIN_TOKEN,
  JELLYFIN_USER_ID: JELLYFIN_USER,
  DB: createMockDb({
    chksz: { enabled: 1 },
    jellyfin: { enabled: 1 },
  }) as never,
  ...overrides,
})

describe('Top-level Worker provider artwork proxy ingress routing', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it.each([
    ['chksz', `/api/providers/chksz/artwork?url=${encodeURIComponent(VALID_CHKSZ_ARTWORK_URL)}`],
    ['jellyfin', `/api/providers/jellyfin/artwork/${VALID_JELLYFIN_ID}`],
  ])('%s artwork waits beyond metadata timeout but aborts at artwork timeout', async (_provider, path) => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const pending = worker.fetch(new Request(`${PUBLIC_ORIGIN}${path}`), createTestEnv())
    for (let i = 0; i < 20 && fetchSpy.mock.calls.length === 0; i++) await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4_001)
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(3_999)
    const response = await pending
    expect(response.status).toBe(504)
  })

  it('accepts ChKSz artwork arriving after four seconds but before eight seconds', async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn(() => new Promise<Response>(resolve => {
      setTimeout(() => resolve(new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        headers: { 'content-type': 'image/jpg' },
      })), 6_000)
    }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const pending = worker.fetch(new Request(
      `${PUBLIC_ORIGIN}/api/providers/chksz/artwork?url=${encodeURIComponent(VALID_CHKSZ_ARTWORK_URL)}`,
    ), createTestEnv())
    for (let i = 0; i < 20 && fetchSpy.mock.calls.length === 0; i++) await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(6_000)
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
  })

  it('keeps ChKSz metadata resolution on the four-second timeout', async () => {
    vi.useFakeTimers()
    const fetchSpy = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const pending = worker.fetch(new Request(`${PUBLIC_ORIGIN}/api/providers/chksz/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN, 'x-chksz-api-key': CHKSZ_KEY },
      body: JSON.stringify({ externalId: '1315196858', level: 'standard' }),
    }), createTestEnv())
    for (let i = 0; i < 30 && fetchSpy.mock.calls.length === 0; i++) await Promise.resolve()
    expect(fetchSpy).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4_000)
    expect((await pending).status).toBe(504)
  })

  describe('ChKSz artwork proxy ingress', () => {
    const sampleJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])

    it.each(['GET', 'HEAD'])('requests a bounded thumbnail for an oversized original with %s', async (method) => {
      const original = new URL(VALID_CHKSZ_ARTWORK_URL)
      original.searchParams.set('param', '4000y4000')
      original.searchParams.set('v', 'cover-revision')
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const thumbnail = new URL(String(input)).searchParams.get('param') === '512y512'
        return new Response(method === 'HEAD' ? null : sampleJpeg, {
          headers: {
            'content-type': 'image/jpg; charset=UTF-8',
            'content-length': String(thumbnail ? sampleJpeg.length : 17_600_336),
          },
        })
      })
      globalThis.fetch = fetchSpy as unknown as typeof fetch
      const response = await worker.fetch(new Request(
        `${PUBLIC_ORIGIN}/api/providers/chksz/artwork?url=${encodeURIComponent(original.href)}`,
        { method },
      ), createTestEnv())
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/jpeg')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(fetchSpy).toHaveBeenCalledOnce()
      const requested = new URL(String(fetchSpy.mock.calls[0]![0]))
      expect(requested.origin).toBe(original.origin)
      expect(requested.pathname).toBe(original.pathname)
      expect(requested.searchParams.getAll('param')).toEqual(['512y512'])
      expect(requested.searchParams.get('v')).toBe('cover-revision')
      if (method === 'HEAD') expect(response.body).toBeNull()
      else expect(new Uint8Array(await response.arrayBuffer())).toEqual(sampleJpeg)
    })

    it.each([
      ['image/jpeg', 200, 'image/jpeg'],
      ['image/jpg', 200, 'image/jpeg'],
      ['image/jpg; charset=UTF-8', 200, 'image/jpeg'],
      ['image/png', 200, 'image/png'],
      ['image/webp', 200, 'image/webp'],
      ['image/gif', 200, 'image/gif'],
      ['text/html', 502, null],
      ['application/json', 502, null],
      ['application/octet-stream', 502, null],
      ['image/svg+xml', 502, null],
      ['image/unknown', 502, null],
      [null, 502, null],
    ])('normalises or rejects upstream MIME %s', async (mime, status, canonical) => {
      globalThis.fetch = vi.fn(async () => new Response(sampleJpeg, {
        headers: mime ? { 'content-type': mime } : {},
      })) as unknown as typeof fetch
      const response = await worker.fetch(new Request(
        `${PUBLIC_ORIGIN}/api/providers/chksz/artwork?url=${encodeURIComponent(VALID_CHKSZ_ARTWORK_URL)}`,
      ), createTestEnv())
      expect(response.status).toBe(status)
      if (canonical) expect(response.headers.get('content-type')).toBe(canonical)
    })

    it('canonicalises image/jpg for HEAD', async () => {
      globalThis.fetch = vi.fn(async () => new Response(null, {
        headers: { 'content-type': 'image/jpg; charset=UTF-8' },
      })) as unknown as typeof fetch
      const response = await worker.fetch(new Request(
        `${PUBLIC_ORIGIN}/api/providers/chksz/artwork?url=${encodeURIComponent(VALID_CHKSZ_ARTWORK_URL)}`,
        { method: 'HEAD' },
      ), createTestEnv())
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/jpeg')
      expect(response.body).toBeNull()
    })

    it('rejects oversized image bytes when upstream omits Content-Length', async () => {
      globalThis.fetch = vi.fn(async () => new Response(new Uint8Array(5 * 1024 * 1024 + 1), {
        headers: { 'content-type': 'image/jpeg' },
      })) as unknown as typeof fetch
      const response = await worker.fetch(new Request(
        `${PUBLIC_ORIGIN}/api/providers/chksz/artwork?url=${encodeURIComponent(VALID_CHKSZ_ARTWORK_URL)}`,
      ), createTestEnv())
      expect(response.status).toBe(502)
    })

    it('routes /api/providers/chksz/artwork to provider handler and streams image with security headers', async () => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`${VALID_CHKSZ_ARTWORK_URL}?param=512y512`)
        expect(init?.method).toBe('GET')
        expect(init?.redirect).toBe('manual')
        return new Response(sampleJpeg, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(sampleJpeg.byteLength),
          },
        })
      })
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/chksz/artwork?url=${encodeURIComponent(VALID_CHKSZ_ARTWORK_URL)}`, {
        method: 'GET',
      })

      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/jpeg')
      expect(response.headers.get('content-length')).toBe(String(sampleJpeg.byteLength))
      expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')

      const bodyBytes = new Uint8Array(await response.arrayBuffer())
      expect(bodyBytes).toEqual(sampleJpeg)
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('supports HEAD method cleanly with 200 and no body', async () => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`${VALID_CHKSZ_ARTWORK_URL}?param=512y512`)
        expect(init?.method).toBe('HEAD')
        return new Response(null, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': '1024',
          },
        })
      })
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/chksz/artwork?url=${encodeURIComponent(VALID_CHKSZ_ARTWORK_URL)}`, {
        method: 'HEAD',
      })

      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/jpeg')
      expect(response.headers.get('content-length')).toBe('1024')
      expect(response.body).toBeNull()
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('rejects unsupported methods with 405 method_not_allowed from provider handler', async () => {
      const fetchSpy = vi.fn()
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const request = new Request(`${PUBLIC_ORIGIN}/api/providers/chksz/artwork?url=${encodeURIComponent(VALID_CHKSZ_ARTWORK_URL)}`, {
          method,
        })
        const response = await worker.fetch(request, env)
        expect(response.status).toBe(405)
        expect(await response.json()).toEqual({ error: 'method_not_allowed' })
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('reaches provider handler and validates missing or invalid url parameters with 400', async () => {
      const env = createTestEnv()

      // Missing url param
      const missingParamReq = new Request(`${PUBLIC_ORIGIN}/api/providers/chksz/artwork`)
      const missingRes = await worker.fetch(missingParamReq, env)
      expect(missingRes.status).toBe(400)
      expect(await missingRes.json()).toEqual({ error: 'invalid_response' })

      // Hostile / unapproved domain
      const untrustedReq = new Request(`${PUBLIC_ORIGIN}/api/providers/chksz/artwork?url=https://attacker.example/pic.jpg`)
      const untrustedRes = await worker.fetch(untrustedReq, env)
      expect(untrustedRes.status).toBe(400)
      expect(await untrustedRes.json()).toEqual({ error: 'invalid_response' })
    })

    it('does not leak upstream credentials or sensitive headers to the client', async () => {
      const fetchSpy = vi.fn(async () => new Response(sampleJpeg, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'set-cookie': 'session=secret-cookie',
          authorization: 'Bearer secret-upstream-auth',
          server: 'private-upstream-server',
        },
      }))
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/chksz/artwork?url=${encodeURIComponent(VALID_CHKSZ_ARTWORK_URL)}`)
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
      const allHeaders = JSON.stringify([...response.headers.entries()])
      expect(allHeaders).not.toContain(CHKSZ_KEY)
      expect(allHeaders).not.toContain('secret-cookie')
      expect(allHeaders).not.toContain('secret-upstream-auth')
      expect(allHeaders).not.toContain('private-upstream-server')
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(response.headers.get('authorization')).toBeNull()
    })
  })

  describe('Jellyfin artwork proxy ingress', () => {
    const samplePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    it.each(['GET', 'HEAD'])('bounds both item and album artwork dimensions with %s', async (method) => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        const requested = new URL(String(input))
        const bounded = requested.searchParams.get('maxWidth') === '512' &&
          requested.searchParams.get('maxHeight') === '512'
        return new Response(method === 'HEAD' ? null : samplePng, {
          headers: {
            'content-type': 'image/png',
            'content-length': String(bounded ? samplePng.length : 17_600_336),
          },
        })
      })
      globalThis.fetch = fetchSpy as unknown as typeof fetch
      for (const imageId of [VALID_JELLYFIN_ID, '0123456789abcdef0123456789abcdef']) {
        const response = await worker.fetch(new Request(
          `${PUBLIC_ORIGIN}/api/providers/jellyfin/artwork/${imageId}`, { method },
        ), createTestEnv())
        expect(response.status).toBe(200)
        const requested = new URL(String(fetchSpy.mock.calls.at(-1)![0]))
        expect(requested.origin).toBe(JELLYFIN_ORIGIN)
        expect(requested.pathname).toBe(`/Items/${imageId}/Images/Primary`)
        expect([...requested.searchParams.entries()]).toEqual([
          ['maxWidth', '512'], ['maxHeight', '512'],
        ])
        if (method === 'HEAD') expect(response.body).toBeNull()
        else expect(new Uint8Array(await response.arrayBuffer())).toEqual(samplePng)
      }
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('routes /api/providers/jellyfin/artwork/<valid-id> to provider handler and streams image', async () => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`${JELLYFIN_ORIGIN}/Items/${VALID_JELLYFIN_ID}/Images/Primary?maxWidth=512&maxHeight=512`)
        expect(init?.method).toBe('GET')
        const headers = new Headers(init?.headers)
        expect(headers.get('authorization')).toBe(`MediaBrowser Token="${JELLYFIN_TOKEN}"`)
        return new Response(samplePng, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(samplePng.byteLength),
          },
        })
      })
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/jellyfin/artwork/${VALID_JELLYFIN_ID}`)

      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('content-length')).toBe(String(samplePng.byteLength))
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')

      const bodyBytes = new Uint8Array(await response.arrayBuffer())
      expect(bodyBytes).toEqual(samplePng)
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('accepts canonical hyphenated UUID format for item ID', async () => {
      const hyphenatedId = '1234abcd-a0d9-5429-3110-f4d561b0f614'
      const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe(`${JELLYFIN_ORIGIN}/Items/${VALID_JELLYFIN_ID}/Images/Primary?maxWidth=512&maxHeight=512`)
        return new Response(samplePng, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      })
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/jellyfin/artwork/${hyphenatedId}`)

      const response = await worker.fetch(request, env)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('supports HEAD method cleanly with 200 and no body', async () => {
      const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(`${JELLYFIN_ORIGIN}/Items/${VALID_JELLYFIN_ID}/Images/Primary?maxWidth=512&maxHeight=512`)
        expect(init?.method).toBe('HEAD')
        return new Response(null, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': '2048',
          },
        })
      })
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/jellyfin/artwork/${VALID_JELLYFIN_ID}`, {
        method: 'HEAD',
      })

      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(response.headers.get('content-length')).toBe('2048')
      expect(response.body).toBeNull()
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('rejects unsupported methods with 405 method_not_allowed from provider handler', async () => {
      const fetchSpy = vi.fn()
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const request = new Request(`${PUBLIC_ORIGIN}/api/providers/jellyfin/artwork/${VALID_JELLYFIN_ID}`, {
          method,
        })
        const response = await worker.fetch(request, env)
        expect(response.status).toBe(405)
        expect(await response.json()).toEqual({ error: 'method_not_allowed' })
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('reaches provider handler and returns 400 for invalid item IDs', async () => {
      const env = createTestEnv()
      for (const badId of ['not-a-hex-id', '123', 'a'.repeat(33), '..%2Fpasswd']) {
        const request = new Request(`${PUBLIC_ORIGIN}/api/providers/jellyfin/artwork/${badId}`)
        const response = await worker.fetch(request, env)
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_response' })
      }
    })

    it('reaches provider handler and returns 404 when upstream image is not found', async () => {
      const fetchSpy = vi.fn(async () => new Response('Not found', { status: 404 }))
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/jellyfin/artwork/${VALID_JELLYFIN_ID}`)
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    })

    it('does not leak Jellyfin API token or upstream URL to the client', async () => {
      const fetchSpy = vi.fn(async () => new Response(samplePng, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'set-cookie': 'jellyfin-session=token',
        },
      }))
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/jellyfin/artwork/${VALID_JELLYFIN_ID}`)
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
      const allHeaders = JSON.stringify([...response.headers.entries()])
      expect(allHeaders).not.toContain(JELLYFIN_TOKEN)
      expect(allHeaders).not.toContain(JELLYFIN_ORIGIN)
      expect(response.headers.get('authorization')).toBeNull()
      expect(response.headers.get('set-cookie')).toBeNull()
    })
  })

  describe('Existing routing regression coverage', () => {
    it('preserves /api/providers/config routing unchanged', async () => {
      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/config`)
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
      const body = await response.json() as Record<string, unknown>
      expect(body.version).toBe(1)
      expect(Array.isArray(body.providers)).toBe(true)
    })

    it('preserves /api/providers/chksz/discover routing unchanged', async () => {
      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/chksz/discover`, {
        method: 'POST',
        headers: {
          origin: PUBLIC_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      })
      const response = await worker.fetch(request, env)

      // Reaches provider handler which returns 400 for invalid body, not auth 404
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_response' })
    })

    it('preserves /api/providers/:providerId/resolve routing unchanged', async () => {
      const env = createTestEnv()
      for (const providerId of ['chksz', 'jellyfin', 'meting']) {
        const request = new Request(`${PUBLIC_ORIGIN}/api/providers/${providerId}/resolve`, {
          method: 'POST',
          headers: {
            origin: PUBLIC_ORIGIN,
            'content-type': 'application/json',
          },
          body: JSON.stringify({}),
        })
        const response = await worker.fetch(request, env)

        // Reaches provider handler which returns 400 for invalid body, not auth 404
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_response' })
      }
    })

    it('preserves /api/providers/:providerId/media/... routing unchanged', async () => {
      const env = createTestEnv()
      for (const providerId of ['chksz', 'jellyfin', 'meting']) {
        const request = new Request(`${PUBLIC_ORIGIN}/api/providers/${providerId}/media/bad-external-id/AAECAwQFBgcICQoLDA0ODxAREhMUFRYX`, {
          method: 'GET',
        })
        const response = await worker.fetch(request, env)

        // Reaches provider handler which returns 400 for invalid external ID, not auth 404
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_response' })
      }
    })

    it('preserves auth and catalogue fallback routing', async () => {
      const env = createTestEnv()

      // Auth endpoint
      const sessionReq = new Request(`${PUBLIC_ORIGIN}/api/session`)
      const sessionRes = await worker.fetch(sessionReq, env)
      expect(sessionRes.status).toBe(401)
      expect(await sessionRes.json()).toEqual({ user: null })

      // Unknown API route falls through to auth handler (404)
      const unknownReq = new Request(`${PUBLIC_ORIGIN}/api/some-unregistered-endpoint`)
      const unknownRes = await worker.fetch(unknownReq, env)
      expect(unknownRes.status).toBe(404)
      expect(await unknownRes.json()).toEqual({ error: 'not_found' })
    })
  })

  describe('Unrelated provider paths isolation', () => {
    it('does not route unrelated /api/providers paths into createProviderHandler', async () => {
      const env = createTestEnv()
      const unrelatedPaths = [
        '/api/providers',
        '/api/providers/',
        '/api/providers/unknown',
        '/api/providers/chksz/unrelated',
        '/api/providers/jellyfin/unrelated',
        '/api/providers/chksz/artwork/extra',
        '/api/providers/jellyfin/artwork', // lacks trailing slash / item-id
      ]

      for (const path of unrelatedPaths) {
        const request = new Request(`${PUBLIC_ORIGIN}${path}`)
        const response = await worker.fetch(request, env)
        // All unrelated paths fall through to auth handler which returns 404
        expect(response.status, `Expected 404 for unrelated path: ${path}`).toBe(404)
        expect(await response.json()).toEqual({ error: 'not_found' })
      }
    })
  })

  describe('Same-origin artwork contract and CSP conformance', () => {
    it('decorates proxied artwork responses with strict API security headers without weakening CSP', async () => {
      const sampleWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46])
      const fetchSpy = vi.fn(async () => new Response(sampleWebp, {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      }))
      globalThis.fetch = fetchSpy as unknown as typeof fetch

      const env = createTestEnv()
      const request = new Request(`${PUBLIC_ORIGIN}/api/providers/jellyfin/artwork/${VALID_JELLYFIN_ID}`)
      const response = await worker.fetch(request, env)

      expect(response.status).toBe(200)
      // Same-origin response served directly from the Worker host:
      // Enables client browser to consume artwork via same-origin <img> src matching 'self'
      expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    })
  })
})
