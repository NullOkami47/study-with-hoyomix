import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthHandler, type AuthEnv } from '../auth/routes'
import {
  LINUXDO_AUTH_URL,
  LINUXDO_ISSUER,
  LINUXDO_JWKS_URL,
  LINUXDO_TOKEN_URL,
} from '../auth/linuxdo'

const ORIGIN = 'https://study.example'
const NOW = 1_786_480_000_000

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const applyMigrations = async (database: TestDatabase) => {
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(
      sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => database.prepare(statement)),
    )
  }
}

const cookieValue = (response: Response, name: string) => {
  const cookie = response.headers.get('set-cookie') ?? ''
  return cookie.match(new RegExp(`${name}=([^;]*)`))?.[1] ?? ''
}

const requestWithCookie = (path: string, cookie: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('cookie', cookie)
  if (init?.method === 'POST' && init.headers === undefined) headers.set('origin', ORIGIN)
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

const base64Url = (value: Uint8Array | string) => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return Buffer.from(bytes).toString('base64url')
}

const createLinuxDoSigner = async (kid = 'linuxdo-key-1') => {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey)
  const sign = async (claims: Record<string, unknown>, headerOverride?: Record<string, unknown>) => {
    const header = base64Url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...headerOverride }))
    const payload = base64Url(JSON.stringify(claims))
    const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${payload}`))
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`
  }
  return { jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, sign, pair }
}

describe('LINUX DO OIDC authentication', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: AuthEnv

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `auth-linuxdo-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    env = {
      DB: database,
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'session-secret-with-at-least-thirty-two-characters',
      OAUTH_STATE_SECRET: 'oauth-state-secret-with-at-least-32-characters',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GITHUB_CLIENT_ID: 'github-client-id',
      GITHUB_CLIENT_SECRET: 'github-client-secret',
      LINUXDO_CLIENT_ID: 'linuxdo-client-id',
      LINUXDO_CLIENT_SECRET: 'linuxdo-client-secret',
      OWNER_PROVIDER: 'github',
      OWNER_SUBJECT: '777',
    }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await miniflare.dispose()
  })

  describe('OIDC constants & discovery contract', () => {
    it('pins the verified discovery endpoints correctly', () => {
      expect(LINUXDO_ISSUER).toBe('https://connect.linux.do/')
      expect(LINUXDO_AUTH_URL).toBe('https://connect.linux.do/oauth2/authorize')
      expect(LINUXDO_TOKEN_URL).toBe('https://connect.linux.do/oauth2/token')
      expect(LINUXDO_JWKS_URL).toBe('https://connect.linux.do/.well-known/jwks.json')
    })
  })

  describe('provider availability', () => {
    it.each([
      ['no credentials', '', '', false],
      ['client id only', 'my-id', '', false],
      ['client secret only', '', 'my-secret', false],
      ['both configured', 'my-id', 'my-secret', true],
    ])('advertises linuxdo availability as %s (%s, %s -> %s)', async (_desc, clientId, clientSecret, expected) => {
      env.LINUXDO_CLIENT_ID = clientId
      env.LINUXDO_CLIENT_SECRET = clientSecret
      const handler = createAuthHandler(env)
      const res = await handler.fetch(new Request(`${ORIGIN}/api/auth/providers`))
      const body = await res.json() as { providers: { linuxdo: boolean } }
      expect(body.providers.linuxdo).toBe(expected)
    })

    it.each(['', '   ', undefined])('rejects unconfigured LINUX DO starts with 503 before recording a flow (%s)', async (secret) => {
      env.LINUXDO_CLIENT_SECRET = secret as string
      const handler = createAuthHandler(env)
      const response = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'provider_unavailable' })
      expect(response.headers.get('location')).toBeNull()
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(await database.prepare('SELECT COUNT(*) AS count FROM oauth_flows').first('count')).toBe(0)
    })
  })

  describe('start flow', () => {
    it('issues integrity-protected state, nonce, and S256 PKCE with openid profile scope', async () => {
      const handler = createAuthHandler(env, { now: () => NOW })
      const response = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))

      expect(response.status).toBe(302)
      const location = new URL(response.headers.get('location') ?? '')
      expect(location.origin + location.pathname).toBe('https://connect.linux.do/oauth2/authorize')
      expect(location.searchParams.get('client_id')).toBe('linuxdo-client-id')
      expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/linuxdo/callback`)
      expect(location.searchParams.get('response_type')).toBe('code')
      expect(location.searchParams.get('scope')).toBe('openid profile')
      expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{32,}$/)
      expect(location.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{32,}$/)
      expect(location.searchParams.get('code_challenge_method')).toBe('S256')
      expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(location.searchParams.has('access_type')).toBe(false)
      expect(location.searchParams.has('prompt')).toBe(false)

      expect(response.headers.get('set-cookie')).toContain('__Host-oauth=')
      expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax; Path=/')

      const persistedFlow = await database.prepare('SELECT state_hash, provider, intent, consumed_at FROM oauth_flows').first<{
        state_hash: string
        provider: string
        intent: string
        consumed_at: number | null
      }>()
      expect(persistedFlow).toMatchObject({ provider: 'linuxdo', intent: 'login', consumed_at: null })
      expect(persistedFlow?.state_hash).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/)
      expect(persistedFlow?.state_hash).not.toContain(location.searchParams.get('state'))
    })
  })

  describe('callback validation & failure modes', () => {
    it('rejects callback when state does not match cookie', async () => {
      const handler = createAuthHandler(env, { now: () => NOW })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const flowCookie = `__Host-oauth=${cookieValue(start, '__Host-oauth')}`
      const response = await handler.fetch(requestWithCookie('/api/auth/linuxdo/callback?code=abc&state=wrong', flowCookie))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_oauth_state' })
    })

    it('rejects callback when flow provider is mismatched', async () => {
      const handler = createAuthHandler(env, { now: () => NOW })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/github/start`))
      const flowCookie = `__Host-oauth=${cookieValue(start, '__Host-oauth')}`
      const location = new URL(start.headers.get('location') ?? '')
      const response = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=abc&state=${location.searchParams.get('state')}`,
        flowCookie,
      ))
      expect(response.status).toBe(400)
    })

    it('rejects replayed state on callback', async () => {
      const signer = await createLinuxDoSigner()
      const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          return Response.json({
            id_token: await signer.sign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: 'the-nonce',
              sub: 'sub-replay',
              name: 'Replay User',
            }),
          })
        }
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [signer.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const location = new URL(start.headers.get('location') ?? '')
      const cookie = `__Host-oauth=${cookieValue(start, '__Host-oauth')}`
      const callbackPath = `/api/auth/linuxdo/callback?code=code&state=${location.searchParams.get('state')}`

      // First callback succeeds
      // Need providerFetch to return token with matching nonce
      const originalFetch = providerFetch.getMockImplementation()!
      providerFetch.mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input) === LINUXDO_TOKEN_URL) {
          return Response.json({
            id_token: await signer.sign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: location.searchParams.get('nonce') ?? '',
              sub: 'sub-replay',
              name: 'Replay User',
            }),
          })
        }
        return originalFetch(input)
      })

      const first = await handler.fetch(requestWithCookie(callbackPath, cookie))
      expect(first.status).toBe(302)

      // Second callback with same state must fail
      const second = await handler.fetch(requestWithCookie(callbackPath, cookie))
      expect(second.status).toBe(400)
    })

    it.each([
      ['wrong issuer', { iss: 'https://evil-connect.linux.do/' }],
      ['issuer without trailing slash', { iss: 'https://connect.linux.do' }],
      ['wrong audience', { aud: 'different-client-id' }],
      ['non-string audience', { aud: 12345 }],
      ['array audience with non-string', { aud: [12345] }],
      ['expired ID token', { exp: Math.floor(NOW / 1000) - 10 }],
      ['future nbf ID token', { nbf: Math.floor(NOW / 1000) + 120 }],
      ['wrong nonce', { nonce: 'mismatched-nonce' }],
      ['empty sub', { sub: '' }],
      ['non-string sub', { sub: 12345 }],
      ['oversized sub', { sub: 'x'.repeat(256) }],
      ['mismatched azp with single audience', { azp: 'rogue-client-id' }],
      ['missing azp with multiple audiences', { aud: ['linuxdo-client-id', 'partner-client-id'], azp: undefined }],
      ['mismatched azp with multiple audiences', { aud: ['linuxdo-client-id', 'partner-client-id'], azp: 'rogue-client-id' }],
    ])('rejects invalid claim: %s', async (_label, claimOverrides) => {
      const signer = await createLinuxDoSigner()
      let startNonce = ''
      const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          return Response.json({
            id_token: await signer.sign(Object.assign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: startNonce,
              sub: 'valid-sub',
              name: 'Test User',
            }, claimOverrides)),
          })
        }
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [signer.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const location = new URL(start.headers.get('location') ?? '')
      startNonce = location.searchParams.get('nonce') ?? ''

      const response = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=code&state=${location.searchParams.get('state')}`,
        `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
      ))
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'oauth_callback_failed' })
      expect(await database.prepare('SELECT COUNT(*) AS count FROM users').first<number>('count')).toBe(0)
    })

    it('rejects tampered token signature or untrusted signing key', async () => {
      const trustedSigner = await createLinuxDoSigner('trusted-key')
      const attackerSigner = await createLinuxDoSigner('attacker-key')
      let startNonce = ''

      const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          // Attacker signed with their own key, using attacker kid
          return Response.json({
            id_token: await attackerSigner.sign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: startNonce,
              sub: 'attacker-sub',
            }),
          })
        }
        // JWKS only exposes trusted key
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [trustedSigner.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const location = new URL(start.headers.get('location') ?? '')
      startNonce = location.searchParams.get('nonce') ?? ''

      const response = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=code&state=${location.searchParams.get('state')}`,
        `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
      ))
      expect(response.status).toBe(401)
    })

    it('rejects signing key when JWK use is enc (encryption key)', async () => {
      const signer = await createLinuxDoSigner('enc-key')
      let startNonce = ''

      const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          return Response.json({
            id_token: await signer.sign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: startNonce,
              sub: 'valid-sub',
            }),
          })
        }
        if (url === LINUXDO_JWKS_URL) {
          return Response.json({ keys: [{ ...signer.jwk, use: 'enc' }] })
        }
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const location = new URL(start.headers.get('location') ?? '')
      startNonce = location.searchParams.get('nonce') ?? ''

      const response = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=code&state=${location.searchParams.get('state')}`,
        `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
      ))
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'oauth_callback_failed' })
    })

    it('validates azp when multiple audiences are present in ID token', async () => {
      const signer = await createLinuxDoSigner()
      let startNonce = ''

      const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          return Response.json({
            id_token: await signer.sign({
              iss: 'https://connect.linux.do/',
              aud: ['linuxdo-client-id', 'other-aud'],
              azp: 'linuxdo-client-id', // valid azp matches clientId
              exp: Math.floor(NOW / 1000) + 60,
              nonce: startNonce,
              sub: 'sub-multi-aud',
              name: 'Multi Aud User',
            }),
          })
        }
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [signer.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const location = new URL(start.headers.get('location') ?? '')
      startNonce = location.searchParams.get('nonce') ?? ''

      const response = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=code&state=${location.searchParams.get('state')}`,
        `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
      ))
      expect(response.status).toBe(302)
    })
  })

  describe('successful login, repeat login & profile claims', () => {
    it('creates user and identity on first login, disposes tokens, and creates session', async () => {
      const signer = await createLinuxDoSigner()
      let tokenRequestBody = ''

      const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          tokenRequestBody = String(init?.body)
          return Response.json({
            access_token: 'disposable-linuxdo-access-token',
            id_token: await signer.sign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: 'flow-nonce',
              sub: 'linuxdo-sub-1234',
              name: 'Linux Doer',
              username: 'linuxdoer',
              trust_level: 3,
            }),
          })
        }
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [signer.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const location = new URL(start.headers.get('location') ?? '')
      const startNonce = location.searchParams.get('nonce') ?? ''

      // Override mock to return the actual start nonce
      providerFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          tokenRequestBody = String(init?.body)
          return Response.json({
            access_token: 'disposable-linuxdo-access-token',
            id_token: await signer.sign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: startNonce,
              sub: 'linuxdo-sub-1234',
              name: 'Linux Doer',
              trust_level: 3,
            }),
          })
        }
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [signer.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const response = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=auth-code-123&state=${location.searchParams.get('state')}`,
        `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
      ))

      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(`${ORIGIN}/`)
      expect(tokenRequestBody).toContain('code_verifier=')
      expect(tokenRequestBody).toContain('grant_type=authorization_code')
      expect(tokenRequestBody).toContain('redirect_uri=https%3A%2F%2Fstudy.example%2Fapi%2Fauth%2Flinuxdo%2Fcallback')

      // Check user and identity created
      const user = await database.prepare('SELECT id, display_name, role FROM users').first<{ id: string; display_name: string; role: string }>()
      expect(user).toMatchObject({ display_name: 'Linux Doer', role: 'user' })

      const identity = await database.prepare('SELECT provider, provider_subject, user_id FROM auth_identities').first<{
        provider: string
        provider_subject: string
        user_id: string
      }>()
      expect(identity).toMatchObject({
        provider: 'linuxdo',
        provider_subject: 'linuxdo-sub-1234',
        user_id: user?.id,
      })

      // Verify no tokens in database
      const dbDump = await database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE sql LIKE '%disposable-linuxdo-access-token%'").first<number>('count')
      expect(dbDump).toBe(0)

      // Session issued
      const sessionToken = cookieValue(response, '__Host-session')
      expect(sessionToken).toBeTruthy()
      const session = await handler.fetch(new Request(`${ORIGIN}/api/session`, {
        headers: { cookie: `__Host-session=${sessionToken}` },
      }))
      expect(session.status).toBe(200)
      const sessionBody = await session.json() as { user: { displayName: string; role: string }; identities: string[] }
      expect(sessionBody.user.displayName).toBe('Linux Doer')
      expect(sessionBody.user.role).toBe('user')
      expect(sessionBody.identities).toEqual(['linuxdo'])
    })

    it('handles repeat login without duplicating user or identity', async () => {
      const signer = await createLinuxDoSigner()
      let startNonce = ''

      const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          return Response.json({
            id_token: await signer.sign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: startNonce,
              sub: 'linuxdo-sub-repeat',
              name: 'Repeat Doer',
            }),
          })
        }
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [signer.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })

      // Login 1
      const start1 = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const loc1 = new URL(start1.headers.get('location') ?? '')
      startNonce = loc1.searchParams.get('nonce') ?? ''
      const cb1 = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=code1&state=${loc1.searchParams.get('state')}`,
        `__Host-oauth=${cookieValue(start1, '__Host-oauth')}`,
      ))
      expect(cb1.status).toBe(302)

      // Login 2
      const start2 = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const loc2 = new URL(start2.headers.get('location') ?? '')
      startNonce = loc2.searchParams.get('nonce') ?? ''
      const cb2 = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=code2&state=${loc2.searchParams.get('state')}`,
        `__Host-oauth=${cookieValue(start2, '__Host-oauth')}`,
      ))
      expect(cb2.status).toBe(302)

      expect(await database.prepare('SELECT COUNT(*) AS count FROM users').first<number>('count')).toBe(1)
      expect(await database.prepare('SELECT COUNT(*) AS count FROM auth_identities').first<number>('count')).toBe(1)
    })

    it.each([
      ['name claim', { name: 'Alice Name', preferred_username: 'alice_pref', username: 'alice_usr' }, 'Alice Name'],
      ['preferred_username fallback', { preferred_username: 'bob_pref', username: 'bob_usr' }, 'bob_pref'],
      ['username fallback', { username: 'charlie_usr', login: 'charlie_log' }, 'charlie_usr'],
      ['login fallback', { login: 'dave_log' }, 'dave_log'],
      ['generic fallback', {}, 'LINUX DO user'],
    ])('resolves display name with precedence %s -> %s', async (_label, claims, expectedDisplay) => {
      const signer = await createLinuxDoSigner()
      let startNonce = ''

      const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          return Response.json({
            id_token: await signer.sign(Object.assign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: startNonce,
              sub: `sub-${Math.random()}`,
            }, claims)),
          })
        }
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [signer.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const loc = new URL(start.headers.get('location') ?? '')
      startNonce = loc.searchParams.get('nonce') ?? ''

      const cb = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=code&state=${loc.searchParams.get('state')}`,
        `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
      ))
      expect(cb.status).toBe(302)
      const user = await database.prepare('SELECT display_name FROM users ORDER BY created_at DESC LIMIT 1').first<{ display_name: string }>()
      expect(user?.display_name).toBe(expectedDisplay)
    })
  })

  describe('account linking and unlinking', () => {
    it('allows an existing GitHub user to link Linux DO, rejects duplicate provider link, and prevents last-identity unlink', async () => {
      const signer = await createLinuxDoSigner()
      let startNonce = ''

      const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          return Response.json({
            id_token: await signer.sign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: startNonce,
              sub: 'linuxdo-linked-sub',
              name: 'Linked LinuxDo',
            }),
          })
        }
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [signer.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })

      // Seed a user with github identity
      await database.batch([
        database.prepare('INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').bind('gh-user', 'GitHub User', 'user', NOW, NOW),
        database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('gh-ident', 'gh-user', 'github', 'gh-111', NOW),
      ])
      const issued = await handler.issueSession('gh-user')
      const sessionCookie = `__Host-session=${issued.token}`

      // Start link flow
      const linkStart = await handler.fetch(requestWithCookie('/api/auth/linuxdo/start?intent=link', sessionCookie))
      expect(linkStart.status).toBe(302)
      const loc = new URL(linkStart.headers.get('location') ?? '')
      startNonce = loc.searchParams.get('nonce') ?? ''
      const oauthCookie = `__Host-oauth=${cookieValue(linkStart, '__Host-oauth')}`

      // Complete link flow
      const linkCallback = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=code&state=${loc.searchParams.get('state')}`,
        `${sessionCookie}; ${oauthCookie}`,
      ))
      expect(linkCallback.status).toBe(200)

      // Verified 1 user with 2 identities
      const userCount = await database.prepare('SELECT COUNT(*) AS count FROM users').first<number>('count')
      expect(userCount).toBe(1)
      const idents = await database.prepare('SELECT provider FROM auth_identities WHERE user_id = ? ORDER BY provider').bind('gh-user').all<{ provider: string }>()
      expect(idents.results.map((r: { provider: string }) => r.provider)).toEqual(['github', 'linuxdo'])

      // Unlink linuxdo succeeds when github remains
      const rotatedSessionToken = cookieValue(linkCallback, '__Host-session')
      expect(rotatedSessionToken).toBeTruthy()

      // Attempting to link second linuxdo identity to the same user fails with provider_already_linked
      const dupLinkResult = await handler.linkIdentity(rotatedSessionToken, {
        provider: 'linuxdo',
        subject: 'second-linuxdo-sub',
        displayName: 'Second LinuxDo',
      })
      expect(dupLinkResult.status).toBe(409)
      expect(await dupLinkResult.json()).toEqual({ error: 'provider_already_linked' })

      // Attempting to link already-claimed linuxdo identity to a different user fails with collision
      await database.prepare('INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
        .bind('other-user', 'Other', 'user', NOW, NOW).run()
      const otherIssued = await handler.issueSession('other-user')
      const collisionResult = await handler.linkIdentity(otherIssued.token, {
        provider: 'linuxdo',
        subject: 'linuxdo-linked-sub',
        displayName: 'Collision',
      })
      expect(collisionResult.status).toBe(409)
      expect(await collisionResult.json()).toEqual({ error: 'collision' })

      // Unlink linuxdo succeeds when github remains
      const unlinkRes = await handler.fetch(requestWithCookie('/api/auth/linuxdo/unlink', `__Host-session=${rotatedSessionToken}`, { method: 'POST' }))
      expect(unlinkRes.status).toBe(200)

      const remainingIdents = await database.prepare('SELECT provider FROM auth_identities WHERE user_id = ?').bind('gh-user').all<{ provider: string }>()
      expect(remainingIdents.results.map((r: { provider: string }) => r.provider)).toEqual(['github'])

      // Unlinking the remaining (last) identity fails with 409 last_identity
      const finalSessionToken = cookieValue(unlinkRes, '__Host-session')
      const unlinkLast = await handler.fetch(requestWithCookie('/api/auth/github/unlink', `__Host-session=${finalSessionToken}`, { method: 'POST' }))
      expect(unlinkLast.status).toBe(409)
      expect(await unlinkLast.json()).toEqual({ error: 'last_identity' })
    })
  })

  describe('privilege isolation & RBAC', () => {
    it('does not grant Admin or Owner based on trust_level, username, or claims', async () => {
      const signer = await createLinuxDoSigner()
      let startNonce = ''

      const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          return Response.json({
            id_token: await signer.sign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: startNonce,
              sub: '777', // matches OWNER_SUBJECT, but provider is linuxdo not github!
              name: 'Owner Impersonator',
              username: 'owner',
              trust_level: 4, // maximum trust level
            }),
          })
        }
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [signer.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const loc = new URL(start.headers.get('location') ?? '')
      startNonce = loc.searchParams.get('nonce') ?? ''

      const response = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=code&state=${loc.searchParams.get('state')}`,
        `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
      ))
      expect(response.status).toBe(302)

      const user = await database.prepare('SELECT role FROM users').first<{ role: string }>()
      expect(user?.role).toBe('user') // Must remain 'user'!
    })
  })

  describe('no email-based auto-merging', () => {
    it('does not auto-merge accounts sharing the same email with an existing GitHub account', async () => {
      const signer = await createLinuxDoSigner()
      let startNonce = ''

      // Pre-existing GitHub user
      await database.batch([
        database.prepare('INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').bind('gh-user', 'GitHub User', 'user', NOW, NOW),
        database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('gh-ident', 'gh-user', 'github', 'gh-id-444', NOW),
      ])

      const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === LINUXDO_TOKEN_URL) {
          return Response.json({
            id_token: await signer.sign({
              iss: 'https://connect.linux.do/',
              aud: 'linuxdo-client-id',
              exp: Math.floor(NOW / 1000) + 60,
              nonce: startNonce,
              sub: 'linuxdo-sub-unique',
              email: 'shared@example.com',
              name: 'Separate LinuxDo User',
            }),
          })
        }
        if (url === LINUXDO_JWKS_URL) return Response.json({ keys: [signer.jwk] })
        throw new Error(`unexpected request: ${url}`)
      })

      const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
      const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/linuxdo/start`))
      const loc = new URL(start.headers.get('location') ?? '')
      startNonce = loc.searchParams.get('nonce') ?? ''

      const response = await handler.fetch(requestWithCookie(
        `/api/auth/linuxdo/callback?code=code&state=${loc.searchParams.get('state')}`,
        `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
      ))
      expect(response.status).toBe(302)

      // Must be 2 completely separate users!
      const users = await database.prepare('SELECT id, display_name FROM users').all<{ id: string; display_name: string }>()
      expect(users.results).toHaveLength(2)

      const identities = await database.prepare('SELECT user_id, provider FROM auth_identities').all<{ user_id: string; provider: string }>()
      expect(identities.results).toHaveLength(2)
      const userIds = new Set(identities.results.map((i: { user_id: string }) => i.user_id))
      expect(userIds.size).toBe(2)
    })
  })
})
