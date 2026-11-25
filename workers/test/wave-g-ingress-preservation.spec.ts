// Wave G preservation (task 26, Property 2; L-17 and L-23 neighbours). Observation-first: observed on
// the unfixed tree (8c23f12). L-17 moves the trusted proxy origins from tracked config and literals
// to BACKEND_ORIGIN / PROXY_FRONTEND_ORIGIN, and L-23 drops the chat country badge for proxied
// requests. Outside those conditions nothing may change:
// - a direct request (no proxy credential) is passed through as the same object, for any API route;
// - a proxied request with the currently valid pair, when the env supplies that same pair, is still
//   authenticated, rewritten to the public origin and stripped of the credential;
// - a direct chat request keeps its Cloudflare country badge.
// The proxied chat country is L-23's and is not asserted.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { chatRoute } from '../chat/routes'
import { authenticateProxyIngress, isAuthenticatedProxyRequest } from '../proxyIngress'
import { cloudflareCountry } from '../providers/routing'

const backend = 'https://app.example.workers.dev'
const publicOrigin = 'https://preview.example.vercel.app'
const secret = 'test-only-proxy-secret-0123456789abcdef'
/** The env carries the pair the unfixed ingress hard-codes, so it authenticates on both trees. */
const env = {
  PUBLIC_ORIGIN: publicOrigin, API_PROXY_SECRET: secret,
  BACKEND_ORIGIN: backend, PROXY_FRONTEND_ORIGIN: publicOrigin,
  SESSION_HMAC_SECRET: 'test-session', OAUTH_STATE_SECRET: 'test-oauth',
  DB: { prepare() { throw new Error('Unexpected database access') } } as never,
}

const segment = fc.stringMatching(/^[a-z0-9-]{1,12}$/u)
const apiPath = fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => `/api/${parts.join('/')}`)
const query = fc.option(fc.array(fc.tuple(segment, fc.string({ maxLength: 8 })), { maxLength: 3 }), { nil: undefined })
  .map((pairs) => pairs && pairs.length ? `?${new URLSearchParams(pairs).toString()}` : '')
const method = fc.constantFrom('GET', 'POST', 'PUT', 'PATCH', 'DELETE')
const body = fc.string({ maxLength: 40 })

describe('Wave G: direct requests are untouched by the ingress (L-17 neighbour)', () => {
  it('returns the very same Request for any direct API call, whatever its origin, headers or body', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom(backend, publicOrigin, 'https://other.example'), apiPath, query, method, body, fc.option(fc.webUrl(), { nil: undefined }),
      async (host, path, search, verb, payload, browserOrigin) => {
        const headers: Record<string, string> = { 'x-forwarded-host': 'attacker.example' }
        if (browserOrigin) headers.origin = new URL(browserOrigin).origin
        const request = new Request(`${host}${path}${search}`, { method: verb, headers, ...(verb === 'GET' ? {} : { body: payload }) })
        const result = await authenticateProxyIngress(request, env)
        expect(result).toBe(request)
        expect(isAuthenticatedProxyRequest(result as Request)).toBe(false)
      }), { numRuns: 60 })
  })

  it('keeps the Cloudflare country badge on a direct chat request', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom('US', 'JP', 'TW', 'DE', 'CN'), async (country) => {
      let forwarded: Request | undefined
      const CHAT = { idFromName: () => 'global', get: () => ({ fetch: async (inner: Request) => { forwarded = inner; return new Response('{}') } }) }
      const direct = new Request(`${publicOrigin}/api/chat`)
      Object.defineProperty(direct, 'cf', { value: { country } })
      expect(cloudflareCountry(direct)).toBe(country)
      expect((await chatRoute(direct, { ...env, CHAT } as never)).status).toBe(200)
      expect(JSON.parse(forwarded!.headers.get('x-chat-identity')!).country).toBe(country)
    }), { numRuns: 5 })
  })
})

describe('Wave G: proxied requests with the valid pair stay authenticated (L-17 neighbour)', () => {
  it('rewrites to the public origin, keeps method, query, body and browser headers, and consumes the credential', async () => {
    await fc.assert(fc.asyncProperty(apiPath, query, method, body, fc.constantFrom(publicOrigin, 'https://evil.example'), async (path, search, verb, payload, browserOrigin) => {
      const incoming = await authenticateProxyIngress(new Request(`${backend}${path}${search}`, {
        method: verb,
        headers: { 'x-hoyomix-proxy-secret': secret, origin: browserOrigin, cookie: '__Host-session=test-only', range: 'bytes=0-0' },
        ...(verb === 'GET' ? {} : { body: payload }),
      }), env)
      expect(incoming).toBeInstanceOf(Request)
      const request = incoming as Request
      expect(isAuthenticatedProxyRequest(request)).toBe(true)
      expect(request.url).toBe(`${publicOrigin}${path}${search}`)
      expect(request.method).toBe(verb)
      if (verb !== 'GET') expect(await request.text()).toBe(payload)
      expect(request.headers.get('origin')).toBe(browserOrigin)
      expect(request.headers.get('cookie')).toBe('__Host-session=test-only')
      expect(request.headers.get('range')).toBe('bytes=0-0')
      expect(request.headers.has('x-hoyomix-proxy-secret')).toBe(false)
      // A proxied request never carries the proxy's egress country (unchanged before L-23).
      Object.defineProperty(request, 'cf', { value: { country: 'US' } })
      expect(cloudflareCountry(request)).toBeUndefined()
    }), { numRuns: 60 })
  })

  it('still refuses a wrong credential, a non-API path or an untrusted upstream with 403', async () => {
    await fc.assert(fc.asyncProperty(fc.oneof(
      fc.record({ host: fc.constant(backend), path: apiPath, credential: fc.stringMatching(/^[A-Za-z0-9_-]{32,64}$/u).filter((value) => value !== secret) }),
      fc.record({ host: fc.constant(backend), path: segment.map((s) => `/${s}`), credential: fc.constant(secret) }),
      fc.record({ host: fc.constant('https://attacker.example'), path: apiPath, credential: fc.constant(secret) }),
    ), async ({ host, path, credential }) => {
      const result = await authenticateProxyIngress(new Request(`${host}${path}`, { headers: { 'x-hoyomix-proxy-secret': credential } }), env)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(403)
      expect((result as Response).headers.get('cache-control')).toBe('no-store')
    }), { numRuns: 40 })
  })
})
