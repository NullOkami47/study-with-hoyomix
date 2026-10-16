import { describe, expect, it, vi } from 'vitest'

import { resolveGdStudioMetadata } from '../providers/gdStudio'
import { createExactMediaUrlValidator } from '../providers/resolverMediaUrl'

// F3 — bounded GD Studio failure observability.
//
// The previous GD incident (see docs/verification/2026-09-16-gd-studio-502-investigation.md)
// could not be localised from the returned HTTP status alone, because materially different
// adapter branches collapsed onto the same externally visible `unavailable` / HTTP 502.
//
// These tests pin each real branch to its own finite diagnostic code, so a future reviewer can
// read `code` and know which boundary fired without guessing. They deliberately do NOT assert
// anything about the unreproduced original incident, and do not claim it was root-caused.

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

// Only the diagnostic discriminator is asserted here; the pre-existing error category and HTTP
// status are covered by the preservation tests further down and by the route-level specs.
const codeOf = async (result: unknown) => (result as { diagnosticCode?: string }).diagnosticCode

describe('GD Studio failure diagnostics (F3)', () => {
  describe('RED→GREEN: distinct boundaries must yield distinct codes', () => {
    it('Case A: upstream non-2xx yields gd_upstream_http', async () => {
      const fetchImpl = vi.fn(async () => new Response('error detail', { status: 503 })) as unknown as typeof fetch

      const result = await resolve(fetchImpl)

      expect(result).toMatchObject({ ok: false, error: 'unavailable' })
      expect(await codeOf(result)).toBe('gd_upstream_http')
    })

    it('Case B: HTTP 200 with no usable url yields gd_missing_media_url, not gd_upstream_http', async () => {
      // This is the exact ambiguity that caused the earlier audit to mislocalise the failure:
      // a well-formed 2xx response lacking `url` produced the same 502 / `unavailable` as a
      // genuine upstream HTTP error.
      const fetchImpl = vi.fn(async () => jsonResponse({
        br: 320,
        size: 123456,
        from: 'netease',
      })) as unknown as typeof fetch

      const result = await resolve(fetchImpl)

      expect(result).toMatchObject({ ok: false, error: 'unavailable' })
      expect(await codeOf(result)).toBe('gd_missing_media_url')
      expect(await codeOf(result)).not.toBe('gd_upstream_http')
    })

    it('distinguishes Case A from Case B by code while error/status stay identical', async () => {
      const httpError = await resolve(
        vi.fn(async () => new Response('x', { status: 503 })) as unknown as typeof fetch,
      )
      const missingUrl = await resolve(
        vi.fn(async () => jsonResponse({ br: 320, size: 1, from: 'netease' })) as unknown as typeof fetch,
      )

      expect(httpError).toMatchObject({ ok: false, error: 'unavailable' })
      expect(missingUrl).toMatchObject({ ok: false, error: 'unavailable' })
      expect(await codeOf(httpError)).not.toBe(await codeOf(missingUrl))
    })

    it('Case C: malformed JSON yields gd_upstream_json', async () => {
      const fetchImpl = vi.fn(async () => new Response('{"url":"https://...', {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

      const result = await resolve(fetchImpl)

      expect(await codeOf(result)).toBe('gd_upstream_json')
    })

    it('Case C2: a JSON array (structurally invalid) yields gd_upstream_json', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse([validResponse()])) as unknown as typeof fetch

      expect(await codeOf(await resolve(fetchImpl))).toBe('gd_upstream_json')
    })

    it('Case D: media URL rejected by policy yields gd_media_url_policy', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(validResponse({
        url: 'https://evil.attacker.invalid/audio.mp3',
      }))) as unknown as typeof fetch

      const result = await resolve(fetchImpl, EXTERNAL_ID, () => null)

      expect(result).toMatchObject({ ok: false, error: 'invalid_response' })
      expect(await codeOf(result)).toBe('gd_media_url_policy')
    })

    it('Case E: fetch rejection yields gd_upstream_fetch', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('network failure')
      }) as unknown as typeof fetch

      const result = await resolve(fetchImpl)

      expect(result).toMatchObject({ ok: false, error: 'unavailable' })
      expect(await codeOf(result)).toBe('gd_upstream_fetch')
    })

    it('Case F: upstream 429 yields gd_rate_limited', async () => {
      const fetchImpl = vi.fn(async () => new Response('rate limit', { status: 429 })) as unknown as typeof fetch

      const result = await resolve(fetchImpl)

      expect(result).toMatchObject({ ok: false, error: 'rate_limited' })
      expect(await codeOf(result)).toBe('gd_rate_limited')
    })

    it('Case G: no response before the deadline yields gd_timeout', async () => {
      vi.useFakeTimers()
      try {
        const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolveResponse, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('abort', 'AbortError'))
            })
          })) as unknown as typeof fetch

        const pending = resolve(fetchImpl)
        await vi.advanceTimersByTimeAsync(4_000)

        const result = await pending
        expect(result).toMatchObject({ ok: false, error: 'timeout' })
        expect(await codeOf(result)).toBe('gd_timeout')
      } finally {
        vi.useRealTimers()
      }
    })

    it('Case H: redirect when redirects are not accepted yields gd_upstream_redirect', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, {
        status: 302,
        headers: { location: 'https://other.example.invalid/api.php' },
      })) as unknown as typeof fetch

      const result = await resolve(fetchImpl)

      expect(await codeOf(result)).toBe('gd_upstream_redirect')
    })

    it('reports a pre-fetch request/binding failure as gd_request_invalid', async () => {
      const fetchImpl = vi.fn() as unknown as typeof fetch

      const result = await resolve(fetchImpl, 'invalid-format')

      expect(result).toMatchObject({ ok: false, error: 'invalid_response' })
      expect(await codeOf(result)).toBe('gd_request_invalid')
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('reports a non-JSON content-type body as gd_upstream_body', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(validResponse()), {
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch

      expect(await codeOf(await resolve(fetchImpl))).toBe('gd_upstream_body')
    })

    it('reports an over-cap declared body as gd_upstream_body', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(validResponse(), {
        headers: { 'content-length': String(64 * 1024 + 1) },
      })) as unknown as typeof fetch

      expect(await codeOf(await resolve(fetchImpl))).toBe('gd_upstream_body')
    })
  })

  describe('characterization: existing error categories and behaviour are preserved', () => {
    // These pass before F3 too. They exist so the new diagnostic field cannot silently
    // redefine the public error category or the fail-closed behaviour.
    it.each([
      ['invalid external ID', 'invalid-format', 'invalid_response'],
      ['empty url field', EXTERNAL_ID, 'unavailable'],
    ])('preserves error category for %s', async (_label, externalId, expectedError) => {
      const fetchImpl = vi.fn(async () => jsonResponse(validResponse({ url: '' }))) as unknown as typeof fetch

      const result = await resolve(fetchImpl, externalId as string, () => null)

      expect(result).toMatchObject({ ok: false, error: expectedError })
    })

    it.each([400, 401, 403, 404, 500, 502, 503])(
      'still maps HTTP %s to unavailable',
      async (status) => {
        const fetchImpl = vi.fn(async () => new Response('e', { status })) as unknown as typeof fetch

        expect(await resolve(fetchImpl)).toMatchObject({ ok: false, error: 'unavailable' })
      },
    )

    it('still returns ok: true with mediaUrl/mimeType on the healthy path', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(validResponse())) as unknown as typeof fetch

      const result = await resolve(fetchImpl, EXTERNAL_ID_WITH_BR)

      expect(result).toMatchObject({
        ok: true,
        mediaUrl: new URL(MEDIA_URL),
        mimeType: 'audio/mpeg',
        br: 320,
        size: 5983725,
      })
      expect(await codeOf(result)).toBeUndefined()
    })

    it('Case H (body-abort safety): a deadline expiry during body streaming stays timeout', async () => {
      // F1 established the implementation already classified this correctly. This test is a
      // preservation guard, not a new feature: it must pass both before and after F3.
      vi.useFakeTimers()
      try {
        const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"url":"https://m701.music.126.net/'))
              init?.signal?.addEventListener('abort', () => {
                controller.error(new DOMException('abort', 'AbortError'))
              })
            },
          })
          return Promise.resolve(new Response(stream, {
            headers: { 'content-type': 'application/json' },
          }))
        }) as unknown as typeof fetch

        const pending = resolve(fetchImpl)
        await vi.advanceTimersByTimeAsync(4_000)

        const result = await pending
        expect(result).toMatchObject({ ok: false, error: 'timeout' })
        expect(await codeOf(result)).toBe('gd_timeout')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('safety: every emitted code is a finite, non-derived literal', () => {
    it('emits only codes from the documented finite set across all failure branches', async () => {
      const documented = new Set([
        'gd_request_invalid',
        'gd_upstream_fetch',
        'gd_upstream_http',
        'gd_upstream_redirect',
        'gd_upstream_body',
        'gd_upstream_json',
        'gd_missing_media_url',
        'gd_media_url_policy',
        'gd_timeout',
        'gd_rate_limited',
      ])

      const scenarios: Array<() => Promise<unknown>> = [
        () => resolve(vi.fn() as unknown as typeof fetch, 'invalid-format'),
        () => resolve(vi.fn(async () => { throw new TypeError('x') }) as unknown as typeof fetch),
        () => resolve(vi.fn(async () => new Response('x', { status: 503 })) as unknown as typeof fetch),
        () => resolve(vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://a.invalid/' } })) as unknown as typeof fetch),
        () => resolve(vi.fn(async () => new Response('x', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch),
        () => resolve(vi.fn(async () => new Response('{', { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch),
        () => resolve(vi.fn(async () => jsonResponse({ from: 'netease' })) as unknown as typeof fetch),
        () => resolve(vi.fn(async () => jsonResponse(validResponse())) as unknown as typeof fetch, EXTERNAL_ID, () => null),
        () => resolve(vi.fn(async () => new Response('x', { status: 429 })) as unknown as typeof fetch),
      ]

      for (const scenario of scenarios) {
        const code = await codeOf(await scenario())
        expect(code).toBeDefined()
        expect(documented.has(code as string)).toBe(true)
      }
    })

    it('never leaks the media URL, token, or raw body into the diagnostic code', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(validResponse({
        url: 'https://evil.attacker.invalid/audio.mp3?token=super-secret-token',
      }))) as unknown as typeof fetch

      const result = await resolve(fetchImpl, EXTERNAL_ID, () => null)
      const serialized = JSON.stringify(result)

      expect(serialized).not.toContain('super-secret-token')
      expect(serialized).not.toContain('evil.attacker.invalid')
      expect(serialized).not.toContain('token=')
      expect(serialized).not.toMatch(/https?:\/\//)
    })
  })

  describe('F5 — upstream failure response metadata observability', () => {
    it('Test A: attaches safe allowlisted metadata for upstream 520 / non-2xx failure', async () => {
      const fetchImpl = vi.fn(async () => new Response('upstream error', {
        status: 520,
        headers: {
          server: 'cloudflare',
          'cf-ray': 'abc123-DFW',
          'cf-error-type': 'example',
          'cf-error-origin': 'origin',
          'content-type': 'text/html; charset=UTF-8',
          'content-length': '123',
        },
      })) as unknown as typeof fetch

      const result = await resolve(fetchImpl)

      expect(result).toMatchObject({
        ok: false,
        error: 'unavailable',
        diagnosticCode: 'gd_upstream_http',
        upstreamStatus: 520,
      })
      const failure = result as {
        upstreamMetadata?: {
          server?: string
          cfRay?: string
          cfErrorType?: string
          cfErrorOrigin?: string
          contentType?: string
          retryAfter?: string
          contentLength?: number
        }
      }
      expect(failure.upstreamMetadata).toBeDefined()
      expect(failure.upstreamMetadata).toEqual({
        server: 'cloudflare',
        cfRay: 'abc123-DFW',
        cfErrorType: 'example',
        cfErrorOrigin: 'origin',
        contentType: 'text/html; charset=UTF-8',
        contentLength: 123,
      })
    })

    it('Test B: strictly excludes unsafe headers and request/body data from upstreamMetadata', async () => {
      const fetchImpl = vi.fn(async () => new Response('error detail body SHOULD_NEVER_APPEAR_BODY', {
        status: 503,
        headers: {
          server: 'cloudflare',
          'cf-ray': 'safe-ray-id',
          'set-cookie': 'session=SHOULD_NEVER_APPEAR_COOKIE',
          authorization: 'Bearer SHOULD_NEVER_APPEAR_AUTH',
          'proxy-authorization': 'Basic SHOULD_NEVER_APPEAR_PROXY',
          'www-authenticate': 'Basic realm="SHOULD_NEVER_APPEAR_REALM"',
          location: 'https://example.invalid/secret?token=SHOULD_NEVER_APPEAR_LOC',
          'x-secret-token': 'SHOULD_NEVER_APPEAR_TOKEN',
          'x-arbitrary-header': 'SHOULD_NEVER_APPEAR_HEADER',
        },
      })) as unknown as typeof fetch

      const result = await resolve(fetchImpl)
      expect(result.ok).toBe(false)
      const failure = result as { upstreamMetadata?: Record<string, unknown> }
      expect(failure.upstreamMetadata).toBeDefined()
      expect(failure.upstreamMetadata).toEqual({
        server: 'cloudflare',
        cfRay: 'safe-ray-id',
        contentType: 'text/plain;charset=UTF-8',
      })

      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('SHOULD_NEVER_APPEAR')
    })

    it('Test D: attaches safe metadata for rate-limited 429 including retry-after', async () => {
      const fetchImpl = vi.fn(async () => new Response('rate limit', {
        status: 429,
        headers: {
          server: 'cloudflare',
          'cf-ray': 'rate-ray-id',
          'retry-after': '120',
          'content-type': 'application/json',
        },
      })) as unknown as typeof fetch

      const result = await resolve(fetchImpl)
      expect(result).toMatchObject({
        ok: false,
        error: 'rate_limited',
        diagnosticCode: 'gd_rate_limited',
        upstreamStatus: 429,
      })
      const failure = result as { upstreamMetadata?: Record<string, unknown> }
      expect(failure.upstreamMetadata).toEqual({
        server: 'cloudflare',
        cfRay: 'rate-ray-id',
        retryAfter: '120',
        contentType: 'application/json',
      })
    })

    it('Test E: attaches safe metadata for redirect without leaking location header', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, {
        status: 302,
        headers: {
          server: 'cloudflare',
          'cf-ray': 'redirect-ray-id',
          location: 'https://example.test/private?token=SECRET_REDIRECT_TOKEN',
        },
      })) as unknown as typeof fetch

      const result = await resolve(fetchImpl)
      expect(result).toMatchObject({
        ok: false,
        error: 'invalid_response',
        diagnosticCode: 'gd_upstream_redirect',
        upstreamStatus: 302,
      })
      const failure = result as { upstreamMetadata?: Record<string, unknown> }
      expect(failure.upstreamMetadata).toEqual({
        server: 'cloudflare',
        cfRay: 'redirect-ray-id',
      })

      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('SECRET_REDIRECT_TOKEN')
      expect(serialized).not.toContain('location')
      expect(serialized).not.toContain('https://example.test')
    })

    it('Test F: omits oversized allowlisted header values', async () => {
      const fetchImpl = vi.fn(async () => new Response('error', {
        status: 503,
        headers: {
          server: 'x'.repeat(129), // >128 limit -> omitted
          'cf-ray': 'valid-cf-ray',
          'cf-error-type': 'y'.repeat(129), // >128 limit -> omitted
          'cf-error-origin': 'z'.repeat(129), // >128 limit -> omitted
          'content-type': 'c'.repeat(129), // >128 limit -> omitted
          'retry-after': 'r'.repeat(65), // >64 limit -> omitted
        },
      })) as unknown as typeof fetch

      const result = await resolve(fetchImpl)
      expect(result.ok).toBe(false)
      const failure = result as { upstreamMetadata?: Record<string, unknown> }
      expect(failure.upstreamMetadata).toEqual({
        cfRay: 'valid-cf-ray',
      })
    })

    it('Test G: handles content-length strictly (omits malformed, parses valid safe integer)', async () => {
      const malformedValues = ['-1', 'abc', '1e9', '999999999999999999999999', '12.34', '']

      for (const val of malformedValues) {
        const fetchImpl = vi.fn(async () => new Response('err', {
          status: 503,
          headers: {
            server: 'cloudflare',
            'content-length': val,
          },
        })) as unknown as typeof fetch

        const result = await resolve(fetchImpl)
        const failure = result as { upstreamMetadata?: Record<string, unknown> }
        expect(failure.upstreamMetadata?.contentLength).toBeUndefined()
      }

      const validFetch = vi.fn(async () => new Response('err', {
        status: 503,
        headers: {
          server: 'cloudflare',
          'content-length': '4096',
        },
      })) as unknown as typeof fetch

      const validResult = await resolve(validFetch)
      const validFailure = validResult as { upstreamMetadata?: Record<string, unknown> }
      expect(validFailure.upstreamMetadata?.contentLength).toBe(4096)
    })

    it('Test H: no-response failures do not manufacture upstream metadata', async () => {
      // 1. Invalid request ID (rejected before fetch)
      const invalidIdResult = await resolve(vi.fn() as unknown as typeof fetch, 'invalid-format')
      expect(invalidIdResult).toMatchObject({ ok: false, diagnosticCode: 'gd_request_invalid' })
      expect((invalidIdResult as { upstreamMetadata?: unknown }).upstreamMetadata).toBeUndefined()

      // 2. Fetch network rejection
      const networkError = vi.fn(async () => { throw new TypeError('Network connection reset') }) as unknown as typeof fetch
      const fetchErrorResult = await resolve(networkError)
      expect(fetchErrorResult).toMatchObject({ ok: false, diagnosticCode: 'gd_upstream_fetch' })
      expect((fetchErrorResult as { upstreamMetadata?: unknown }).upstreamMetadata).toBeUndefined()

      // 3. Timeout before response
      vi.useFakeTimers()
      try {
        const timeoutFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('abort', 'AbortError')))
        })) as unknown as typeof fetch

        const pending = resolve(timeoutFetch)
        await vi.advanceTimersByTimeAsync(4_000)
        const timeoutResult = await pending
        expect(timeoutResult).toMatchObject({ ok: false, diagnosticCode: 'gd_timeout' })
        expect((timeoutResult as { upstreamMetadata?: unknown }).upstreamMetadata).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
