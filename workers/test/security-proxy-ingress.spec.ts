import { describe, expect, it } from 'vitest'
import worker from '../index'
import { authenticateProxyIngress } from '../proxyIngress'
import { automaticProviderEligible, cloudflareCountry } from '../providers/routing'
import { chatRoute } from '../chat/routes'

const backend = 'https://app.example.workers.dev'
const publicOrigin = 'https://preview.example.vercel.app'
const secret = 'test-only-proxy-secret-0123456789abcdef'
const env = {
  PUBLIC_ORIGIN: publicOrigin, API_PROXY_SECRET: secret,
  SESSION_HMAC_SECRET: 'test-session', OAUTH_STATE_SECRET: 'test-oauth',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
  GITHUB_CLIENT_ID: 'test-github', GITHUB_CLIENT_SECRET: 'test-github-secret',
  DB: { prepare() { throw new Error('Unexpected database access') } } as never,
}
// L-17 (deliberate): the ingress trusts only the origins configured in env, so the pre-existing cases
// below supply the pair the ingress used to hard-code. `env` alone has no pair (fail-closed case).
const configuredEnv = { ...env, BACKEND_ORIGIN: backend, PROXY_FRONTEND_ORIGIN: publicOrigin }

describe('authenticated fixed upstream ingress', () => {
  it('does not treat proxy egress country as the browser country', async () => {
    const direct = new Request(`${backend}/api/providers/config`)
    Object.defineProperty(direct, 'cf', { value: { country: 'CN' } })
    expect(cloudflareCountry(direct)).toBe('CN')
    const proxied = await authenticateProxyIngress(new Request(`${backend}/api/providers/config`, {
      headers: { 'x-hoyomix-proxy-secret': secret },
    }), configuredEnv) as Request
    Object.defineProperty(proxied, 'cf', { value: { country: 'CN' } })
    expect(cloudflareCountry(proxied)).toBeUndefined()
    expect(automaticProviderEligible({ effectiveEnabled: true, automaticPolicy: 'direct' }, cloudflareCountry(proxied))).toBe(true)
    expect(automaticProviderEligible({ effectiveEnabled: true, automaticPolicy: 'direct' }, cloudflareCountry(direct))).toBe(true)
  })
  it('authenticates before routing and rejects incorrect proxy credentials', async () => {
    const response = await worker.fetch(new Request(`${backend}/api/session`, {
      headers: { 'x-hoyomix-proxy-secret': 'incorrect' },
    }), configuredEnv)
    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).not.toContain(secret)
  })

  it('retains the original hostile browser Origin after proxy authentication', async () => {
    const response = await worker.fetch(new Request(`${backend}/api/logout-all`, {
      method: 'POST', headers: { 'x-hoyomix-proxy-secret': secret, origin: 'https://evil.example' },
    }), configuredEnv)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden_origin' })
  })

  it('passes authenticated ingress to strict resolver origin validation without changing body', async () => {
    const response = await worker.fetch(new Request(`${backend}/api/providers/chksz/resolve`, {
      method: 'POST', body: JSON.stringify({ externalId: '12345' }),
      headers: { 'x-hoyomix-proxy-secret': secret, origin: publicOrigin, 'content-type': 'application/json' },
    }), configuredEnv)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'unavailable' })
  })

  it.each([
    [backend, undefined],
    ['https://attacker.example', secret],
  ])('rejects proxy credentials when configuration or upstream is not trusted', async (origin, configuredSecret) => {
    const response = await worker.fetch(new Request(`${origin}/api/session`, {
      headers: { 'x-hoyomix-proxy-secret': secret },
    }), { ...configuredEnv, API_PROXY_SECRET: configuredSecret })
    expect(response.status).toBe(403)
  })

  it('keeps direct unauthenticated session reads available without trusting forwarded headers', async () => {
    const response = await worker.fetch(new Request(`${backend}/api/session`, {
      headers: { 'x-forwarded-host': 'attacker.example' },
    }), configuredEnv)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ user: null })
  })

  it('preserves encoded query, method, body, cookie and browser Origin but consumes the proxy credential', async () => {
    const incoming = await authenticateProxyIngress(new Request(`${backend}/api/library?x=a%2Fb&x=2`, {
      method: 'PUT', body: '{"library":[]}',
      headers: { 'x-hoyomix-proxy-secret': secret, origin: publicOrigin,
        cookie: '__Host-session=test-only', 'content-type': 'application/json', range: 'bytes=0-0' },
    }), configuredEnv)
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
      }), configuredEnv)
      expect(result).toBeInstanceOf(Response)
      expect((result as Response).status).toBe(403)
    },
  )

  it('does not authenticate non-API URLs or another configured public origin', async () => {
    for (const [path, origin] of [['/', publicOrigin], ['/api/session', 'https://other.example']]) {
      const result = await authenticateProxyIngress(new Request(`${backend}${path}`, {
        headers: { 'x-hoyomix-proxy-secret': secret },
      }), { ...configuredEnv, PUBLIC_ORIGIN: origin })
      expect((result as Response).status).toBe(403)
    }
  })

  it('passes direct Workers.dev traffic without a proxy credential or URL rewrite', async () => {
    const workersDevOrigin = 'https://app.example.workers.dev'
    const request = new Request(`${workersDevOrigin}/api/providers/config`, {
      headers: { origin: workersDevOrigin },
    })
    const result = await authenticateProxyIngress(request, {
      ...configuredEnv,
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

// Wave G exploration (task 25). L-17: the trusted proxy origins come from BACKEND_ORIGIN and
// PROXY_FRONTEND_ORIGIN (the env-driven ingress public already has), not from tracked config.
describe('Wave G: env-driven proxy ingress (L-17) and proxied chat location (L-23)', () => {
  const envBackend = 'https://backend.wave-g.example'
  const envFrontend = 'https://frontend.wave-g.example'
  const envDriven = { ...env, PUBLIC_ORIGIN: envFrontend, BACKEND_ORIGIN: envBackend, PROXY_FRONTEND_ORIGIN: envFrontend }

  it('L-17: authenticates the proxy origins configured in BACKEND_ORIGIN and PROXY_FRONTEND_ORIGIN', async () => {
    const result = await authenticateProxyIngress(new Request(`${envBackend}/api/session`, {
      headers: { 'x-hoyomix-proxy-secret': secret },
    }), envDriven as never)
    expect(result).toBeInstanceOf(Request)
    expect((result as Request).url).toBe(`${envFrontend}/api/session`)
    expect((result as Request).headers.has('x-hoyomix-proxy-secret')).toBe(false)
  })

  it('L-17: fails closed when the proxy origins are not configured', async () => {
    const result = await authenticateProxyIngress(new Request(`${backend}/api/session`, {
      headers: { 'x-hoyomix-proxy-secret': secret },
    }), env)
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
  })

  // L-23 (Wave C: no Vercel-fronted PUBLIC_ORIGIN, so the fix is to omit the badge in proxied
  // mode). The CHAT namespace below only records what chatRoute forwards to the Durable Object.
  const chatIdentityFor = async (request: Request) => {
    let forwarded: Request | undefined
    const CHAT = {
      idFromName: () => 'global',
      get: () => ({ fetch: async (inner: Request) => { forwarded = inner; return new Response('{}') } }),
    }
    const response = await chatRoute(request, { ...envDriven, CHAT } as never)
    expect(response.status).toBe(200)
    return JSON.parse(forwarded!.headers.get('x-chat-identity')!) as { country: string | null }
  }

  // The configured pair equals the origins the unfixed ingress hard-codes, so this case
  // authenticates on both trees and isolates the country decision from L-17.
  it('L-23: omits the chat country badge for an authenticated proxied request', async () => {
    const proxyEnv = { ...env, BACKEND_ORIGIN: backend, PROXY_FRONTEND_ORIGIN: publicOrigin }
    const proxied = await authenticateProxyIngress(new Request(`${backend}/api/chat`, {
      headers: { 'x-hoyomix-proxy-secret': secret },
    }), proxyEnv as never)
    expect(proxied).toBeInstanceOf(Request)
    Object.defineProperty(proxied, 'cf', { value: { country: 'US' } })
    expect((await chatIdentityFor(proxied as Request)).country).toBeNull()
  })

  it('L-23 control: keeps the Cloudflare country badge for direct requests', async () => {
    const direct = new Request(`${envFrontend}/api/chat`)
    Object.defineProperty(direct, 'cf', { value: { country: 'US' } })
    expect((await chatIdentityFor(direct)).country).toBe('US')
  })
})
