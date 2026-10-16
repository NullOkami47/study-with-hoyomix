import { describe, expect, it } from 'vitest'
import worker from '../index'
import { authenticateProxyIngress } from '../proxyIngress'
import { automaticProviderEligible, cloudflareCountry } from '../providers/routing'

const backend = 'https://backend.example.invalid'
const publicOrigin = 'https://frontend.example.invalid'
const secret = 'test-only-proxy-secret-0123456789abcdef'
const env = {
  PUBLIC_ORIGIN: publicOrigin, API_PROXY_SECRET: secret,
  BACKEND_ORIGIN: backend, PROXY_FRONTEND_ORIGIN: publicOrigin,
  SESSION_HMAC_SECRET: 'test-session', OAUTH_STATE_SECRET: 'test-oauth',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
  GITHUB_CLIENT_ID: 'test-github', GITHUB_CLIENT_SECRET: 'test-github-secret',
  DB: { prepare() { throw new Error('Unexpected database access') } } as never,
}

describe('authenticated fixed upstream ingress', () => {
  it('does not treat proxy egress country as the browser country', async () => {
    const direct = new Request(`${backend}/api/providers/config`)
    Object.defineProperty(direct, 'cf', { value: { country: 'CN' } })
    expect(cloudflareCountry(direct)).toBe('CN')
    const proxied = await authenticateProxyIngress(new Request(`${backend}/api/providers/config`, {
      headers: { 'x-hoyomix-proxy-secret': secret },
    }), env) as Request
    Object.defineProperty(proxied, 'cf', { value: { country: 'CN' } })
    expect(cloudflareCountry(proxied)).toBeUndefined()
    expect(automaticProviderEligible({ effectiveEnabled: true, automaticPolicy: 'direct' }, cloudflareCountry(proxied))).toBe(true)
    expect(automaticProviderEligible({ effectiveEnabled: true, automaticPolicy: 'direct' }, cloudflareCountry(direct))).toBe(true)
  })
  it('authenticates before routing and rejects incorrect proxy credentials', async () => {
    const response = await worker.fetch(new Request(`${backend}/api/session`, {
      headers: { 'x-hoyomix-proxy-secret': 'incorrect' },
    }), env)
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).not.toContain(secret)
  })

  it('retains the original hostile browser Origin after proxy authentication', async () => {
    const response = await worker.fetch(new Request(`${backend}/api/logout-all`, {
      method: 'POST', headers: { 'x-hoyomix-proxy-secret': secret, origin: 'https://evil.example' },
    }), env)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden_origin' })
  })

  it('passes authenticated ingress to strict resolver origin validation without changing body', async () => {
    const response = await worker.fetch(new Request(`${backend}/api/providers/chksz/resolve`, {
      method: 'POST', body: JSON.stringify({ externalId: '12345' }),
      headers: { 'x-hoyomix-proxy-secret': secret, origin: publicOrigin, 'content-type': 'application/json' },
    }), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'unavailable' })
  })

  it.each([
    [backend, undefined],
    ['https://attacker.example', secret],
  ])('rejects proxy credentials when configuration or upstream is not trusted', async (origin, configuredSecret) => {
    const response = await worker.fetch(new Request(`${origin}/api/session`, {
      headers: { 'x-hoyomix-proxy-secret': secret },
    }), { ...env, API_PROXY_SECRET: configuredSecret })
    expect(response.status).toBe(403)
  })

  it.each([undefined, '', 'http://backend.example.invalid', 'https://backend.example.invalid/path'])('rejects unconfigured or invalid backend origins', async (origin) => {
    const result = await authenticateProxyIngress(new Request(backend + '/api/session', {
      headers: { 'x-hoyomix-proxy-secret': secret },
    }), { ...env, BACKEND_ORIGIN: origin })
    expect((result as Response).status).toBe(403)
  })

  it.each([undefined, '', 'http://frontend.example.invalid', 'https://frontend.example.invalid/path'])('rejects unconfigured or invalid frontend origins', async (origin) => {
    const result = await authenticateProxyIngress(new Request(backend + '/api/session', {
      headers: { 'x-hoyomix-proxy-secret': secret },
    }), { ...env, PROXY_FRONTEND_ORIGIN: origin })
    expect((result as Response).status).toBe(403)
  })
  it('keeps direct unauthenticated session reads available without trusting forwarded headers', async () => {
    const response = await worker.fetch(new Request(`${backend}/api/session`, {
      headers: { 'x-forwarded-host': 'attacker.example' },
    }), env)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ user: null })
  })

  it('preserves encoded query, method, body, cookie and browser Origin but consumes the proxy credential', async () => {
    const incoming = await authenticateProxyIngress(new Request(`${backend}/api/library?x=a%2Fb&x=2`, {
      method: 'PUT', body: '{"library":[]}',
      headers: { 'x-hoyomix-proxy-secret': secret, origin: publicOrigin,
        cookie: '__Host-session=test-only', 'content-type': 'application/json', range: 'bytes=0-0' },
    }), env)
    expect(incoming).toBeInstanceOf(Request)
    const request = incoming as Request
    expect(request.url).toBe(`${publicOrigin}/api/library?x=a%2Fb&x=2`)
    expect(request.method).toBe('PUT')
    expect(await request.text()).toBe('{"library":[]}')
    expect(request.headers.get('origin')).toBe(publicOrigin)
    expect(request.headers.get('cookie')).toBe('__Host-session=test-only')
    expect(request.headers.get('range')).toBe('bytes=0-0')
    expect(request.headers.has('x-hoyomix-proxy-secret')).toBe(false)
  })

  it.each(['', 'test-only-proxy-secret-0123456789abcdeg', 'x'.repeat(257)])(
    'fails closed for empty, same-length incorrect, or oversized credentials', async (credential) => {
      const result = await authenticateProxyIngress(new Request(`${backend}/api/session`, {
        headers: { 'x-hoyomix-proxy-secret': credential },
      }), env)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(403)
    },
  )

  it('does not authenticate non-API URLs or another configured public origin', async () => {
    for (const [path, origin] of [['/', publicOrigin], ['/api/session', 'https://other.example']]) {
      const result = await authenticateProxyIngress(new Request(`${backend}${path}`, {
        headers: { 'x-hoyomix-proxy-secret': secret },
      }), { ...env, PUBLIC_ORIGIN: origin })
      expect((result as Response).status).toBe(403)
    }
  })

  it('passes direct Workers.dev traffic without a proxy credential or URL rewrite', async () => {
    const workersDevOrigin = 'https://backend.example.invalid'
    const request = new Request(`${workersDevOrigin}/api/providers/config`, {
      headers: { origin: workersDevOrigin },
    })
    const result = await authenticateProxyIngress(request, {
      ...env,
      PUBLIC_ORIGIN: workersDevOrigin,
      API_PROXY_SECRET: undefined,
    })

    expect(result).toBe(request)
    expect(result).toBeInstanceOf(Request)
    expect((result as Request).url).toBe(`${workersDevOrigin}/api/providers/config`)
    expect((result as Request).headers.get('origin')).toBe(workersDevOrigin)
    expect((result as Request).headers.has('x-hoyomix-proxy-secret')).toBe(false)
  })
})
