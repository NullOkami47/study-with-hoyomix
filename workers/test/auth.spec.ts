import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthHandler, type AuthEnv } from '../auth/routes'
const production = { publicOrigin: 'https://study.example' }

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

const createGoogleSigner = async () => {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey)
  const sign = async (claims: Record<string, unknown>) => {
    const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }))
    const payload = base64Url(JSON.stringify(claims))
    const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${payload}`))
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`
  }
  return { jwk: { ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }, sign }
}

describe('site authentication', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: AuthEnv

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `auth-${crypto.randomUUID()}` },
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
      OWNER_PROVIDER: 'github',
      OWNER_SUBJECT: '777',
    }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await miniflare.dispose()
  })

  const googleFixture = async (claims: Record<string, unknown> = {}) => {
    const signer = await createGoogleSigner()
    let nonce = ''
    const exchanges: URLSearchParams[] = []
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        exchanges.push(new URLSearchParams(String(init?.body)))
        return Response.json({ id_token: await signer.sign({
          iss: 'https://accounts.google.com', aud: 'google-client-id',
          exp: Math.floor(NOW / 1000) + 60, nonce, sub: 'google-subject', name: 'Google User', ...claims,
        }) })
      }
      if (String(input) === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [signer.jwk] })
      throw new Error('unexpected fixture request')
    })
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
    const begin = async (intent = 'login', sessionCookie = '') => {
      const start = await handler.fetch(requestWithCookie(`/api/auth/google/start?intent=${intent}`, sessionCookie))
      const location = new URL(start.headers.get('location')!)
      nonce = location.searchParams.get('nonce')!
      const path = `/api/auth/google/callback?code=fixture&state=${location.searchParams.get('state')}`
      const cookie = `__Host-oauth=${cookieValue(start, '__Host-oauth')}; ${sessionCookie}`
      return { location, callback: () => handler.fetch(requestWithCookie(path, cookie)) }
    }
    return { handler, begin, exchanges, providerFetch }
  }

  it.each([
    ['single audience', {}],
    ['multiple audiences with matching authorised party', { aud: ['google-client-id', 'other'], azp: 'google-client-id' }],
  ])('Google login verifies %s, exact callback and PKCE, and rejects replay', async (_label, claims) => {
    const fixture = await googleFixture(claims)
    const flow = await fixture.begin()
    const response = await flow.callback()
    expect(response.status).toBe(302)
    expect(fixture.exchanges[0].get('redirect_uri')).toBe(`${ORIGIN}/api/auth/google/callback`)
    const verifier = fixture.exchanges[0].get('code_verifier')!
    expect(Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url'))
      .toBe(flow.location.searchParams.get('code_challenge'))
    const session = await fixture.handler.fetch(requestWithCookie('/api/session', `__Host-session=${cookieValue(response, '__Host-session')}`))
    expect(await session.json()).toMatchObject({ user: { role: 'user' }, identities: ['google'] })
    expect((await flow.callback()).status).toBe(400)
    expect(fixture.exchanges).toHaveLength(1)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM users').first('count')).toBe(1)
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax; Path=/')
  })

  it('links Google to the existing GitHub/LINUX DO Owner, rotates sessions and retains the same Owner on re-login', async () => {
    await database.batch([
      database.prepare('INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind('existing-owner', 'Owner', 'owner', NOW, NOW),
      database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('owner-github', 'existing-owner', 'github', '777', NOW),
      database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('owner-linuxdo', 'existing-owner', 'linuxdo', 'linuxdo-owner', NOW),
    ])
    const fixture = await googleFixture()
    const issued = await fixture.handler.issueSession('existing-owner')
    const oldCookie = `__Host-session=${issued.token}`
    const linked = await (await fixture.begin('link', oldCookie)).callback()
    expect(linked.status).toBe(200)
    const rotated = `__Host-session=${cookieValue(linked, '__Host-session')}`
    expect(rotated).not.toBe(oldCookie)
    expect((await fixture.handler.fetch(requestWithCookie('/api/session', oldCookie))).status).toBe(401)
    expect(await (await fixture.handler.fetch(requestWithCookie('/api/session', rotated))).json()).toMatchObject({
      user: { id: 'existing-owner', role: 'owner' }, identities: ['github', 'google', 'linuxdo'],
    })
    expect((await fixture.handler.fetch(requestWithCookie('/api/logout', rotated, { method: 'POST' }))).status).toBe(204)
    expect((await fixture.handler.fetch(requestWithCookie('/api/session', rotated))).status).toBe(401)
    const login = await (await fixture.begin()).callback()
    expect(login.status).toBe(302)
    const session = await fixture.handler.fetch(requestWithCookie('/api/session', `__Host-session=${cookieValue(login, '__Host-session')}`))
    expect(await session.json()).toMatchObject({ user: { id: 'existing-owner', role: 'owner' } })
    expect(await database.prepare('SELECT COUNT(*) AS count FROM users').first('count')).toBe(1)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM auth_identities').first('count')).toBe(3)
  })

  it('rejects a Google callback identity already owned by another account without changing either account', async () => {
    await database.batch([
      database.prepare('INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind('owner', 'Owner', 'owner', NOW, NOW),
      database.prepare('INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind('other', 'Other', 'user', NOW, NOW),
      database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('github', 'owner', 'github', '777', NOW),
      database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('google', 'other', 'google', 'google-subject', NOW),
    ])
    const fixture = await googleFixture()
    const issued = await fixture.handler.issueSession('owner')
    const cookie = `__Host-session=${issued.token}`
    const response = await (await fixture.begin('link', cookie)).callback()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'collision' })
    expect((await fixture.handler.fetch(requestWithCookie('/api/session', cookie))).status).toBe(200)
    expect(await database.prepare("SELECT user_id FROM auth_identities WHERE provider='google'").first('user_id')).toBe('other')
    expect(await database.prepare('SELECT COUNT(*) AS count FROM auth_identities').first('count')).toBe(2)
  })

  it('new Google identities never bootstrap Owner or merge using email, name or another provider subject', async () => {
    env.OWNER_PROVIDER = 'google'
    env.OWNER_SUBJECT = '777'
    await database.batch([
      database.prepare('INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind('existing-owner', 'Owner', 'owner', NOW, NOW),
      database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('github', 'existing-owner', 'github', '777', NOW),
    ])
    const fixture = await googleFixture({ sub: '777', email: 'owner@example.com', name: 'Owner', role: 'owner', email_verified: true })
    expect((await (await fixture.begin()).callback()).status).toBe(302)
    expect(await database.prepare("SELECT role FROM users WHERE id='existing-owner'").first('role')).toBe('owner')
    expect(await database.prepare("SELECT role FROM users WHERE id != 'existing-owner'").first('role')).toBe('user')
    expect(await database.prepare('SELECT COUNT(*) AS count FROM users').first('count')).toBe(2)
  })

  it('redacts Google upstream errors from responses and application logs', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
    const handler = createAuthHandler(env, { now: () => NOW, fetch: async () => {
      throw new Error('private-token-and-client-secret-sentinel')
    } })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/google/start`))
    const state = new URL(start.headers.get('location')!).searchParams.get('state')
    const response = await handler.fetch(requestWithCookie(`/api/auth/google/callback?code=private-code&state=${state}`, `__Host-oauth=${cookieValue(start, '__Host-oauth')}`))
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('{"error":"oauth_callback_failed"}')
    expect(JSON.stringify([...response.headers])).not.toMatch(/private-|google-client-secret/)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
    expect(await database.prepare('SELECT COUNT(*) AS count FROM users').first('count')).toBe(0)
  })

  it('advertises only configured OAuth providers without exposing credentials', async () => {
    env.GOOGLE_CLIENT_ID = ''
    const response = await createAuthHandler(env).fetch(new Request(`${ORIGIN}/api/auth/providers`))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ providers: { github: true, google: false, linuxdo: false } })
  })

  it.each(['', 'fixture.apps.googleusercontent.com', undefined])('keeps Google discovery disabled without a secret for ID %s', async (clientId) => {
    env.GOOGLE_CLIENT_ID = clientId as string
    delete (env as Partial<AuthEnv>).GOOGLE_CLIENT_SECRET
    env.LINUXDO_CLIENT_ID = 'fixture-linuxdo'
    env.LINUXDO_CLIENT_SECRET = 'fixture-linuxdo-secret'
    const response = await createAuthHandler(env).fetch(new Request(`${ORIGIN}/api/auth/providers`))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ providers: { github: true, google: false, linuxdo: true } })
  })

  it.each(['', '   ', undefined])('rejects unconfigured OAuth starts before recording a flow (%s)', async (secret) => {
    env.GOOGLE_CLIENT_SECRET = secret as string
    const handler = createAuthHandler(env)
    const response = await handler.fetch(new Request(`${ORIGIN}/api/auth/google/start`))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'provider_unavailable' })
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await database.prepare('SELECT COUNT(*) AS count FROM oauth_flows').first('count')).toBe(0)
  })

  it('issues integrity-protected state, Google nonce, and S256 PKCE without offline access', async () => {
    const handler = createAuthHandler(env, { now: () => NOW })
    const response = await handler.fetch(new Request(`${ORIGIN}/api/auth/google/start`))

    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(location.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{32,}$/)
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(location.searchParams.get('scope')).toBe('openid profile')
    expect(location.searchParams.has('access_type')).toBe(false)
    expect(response.headers.get('set-cookie')).toContain('__Host-oauth=')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax; Path=/')
    const persistedFlow = await database.prepare('SELECT state_hash, provider, intent, consumed_at FROM oauth_flows').first<{
      state_hash: string
      provider: string
      intent: string
      consumed_at: number | null
    }>()
    expect(persistedFlow).toMatchObject({ provider: 'google', intent: 'login', consumed_at: null })
    expect(persistedFlow?.state_hash).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/)
    expect(persistedFlow?.state_hash).not.toContain(location.searchParams.get('state'))
    const flowColumns = await database.prepare('PRAGMA table_info(oauth_flows)').all<{ name: string }>()
    expect(flowColumns.results.map(({ name }: { name: string }) => name)).not.toEqual(expect.arrayContaining([
      'state', 'nonce', 'verifier', 'code', 'access_token', 'refresh_token',
    ]))
  })

  it('rejects a callback whose state does not match the protected flow', async () => {
    const handler = createAuthHandler(env, { now: () => NOW })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/github/start`))
    const flowCookie = `__Host-oauth=${cookieValue(start, '__Host-oauth')}`
    const response = await handler.fetch(requestWithCookie('/api/auth/github/callback?code=a&state=wrong', flowCookie))
    expect(response.status).toBe(400)
  })

  it.each([
    ['wrong audience', { aud: 'other-client', exp: Math.floor(NOW / 1000) + 60 }],
    ['expired token', { aud: 'google-client-id', exp: Math.floor(NOW / 1000) - 1 }],
    ['wrong issuer', { iss: 'https://attacker.invalid' }],
    ['wrong authorised party', { aud: ['google-client-id', 'other'], azp: 'other' }],
    ['missing authorised party for multiple audiences', { aud: ['google-client-id', 'other'] }],
    ['mixed audience types', { aud: ['google-client-id', 42], azp: 'google-client-id' }],
    ['mismatched single audience authorised party', { azp: 'other' }],
    ['empty subject', { sub: '' }],
    ['non-string subject', { sub: 777 }],
  ])('verifies Google signatures and rejects %s', async (_label, overrides) => {
    const signer = await createGoogleSigner()
    let nonce = ''
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({
          id_token: await signer.sign(Object.assign({
            iss: 'https://accounts.google.com',
            aud: 'google-client-id',
            exp: Math.floor(NOW / 1000) + 60,
            nonce,
            sub: 'google-subject',
            name: 'Google User',
          }, overrides)),
        })
      }
      if (url.includes('googleapis.com/oauth2/v3/certs')) return Response.json({ keys: [signer.jwk] })
      throw new Error(`unexpected provider request: ${url}`)
    })
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/google/start`))
    const location = new URL(start.headers.get('location') ?? '')
    nonce = location.searchParams.get('nonce') ?? ''
    const response = await handler.fetch(requestWithCookie(
      `/api/auth/google/callback?code=code&state=${location.searchParams.get('state')}`,
      `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
    ))
    expect(response.status).toBe(401)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM users').first<number>('count')).toBe(0)
  })

  it('rejects an alternate callback origin before consuming state or contacting Google', async () => {
    const providerFetch = vi.fn()
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/google/start`))
    const state = new URL(start.headers.get('location')!).searchParams.get('state')
    for (const origin of ['https://wrong.example', 'http://study.example']) {
      const response = await handler.fetch(new Request(`${origin}/api/auth/google/callback?code=fixture&state=${state}`, {
        headers: { cookie: `__Host-oauth=${cookieValue(start, '__Host-oauth')}` },
      }))
      expect(response.status).toBe(400)
      expect(await database.prepare('SELECT consumed_at FROM oauth_flows').first('consumed_at')).toBeNull()
    }
    expect(providerFetch).not.toHaveBeenCalled()
  })

  it('requires the Google nonce in the verified signed claims', async () => {
    const signer = await createGoogleSigner()
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return Response.json({ id_token: await signer.sign({ iss: 'accounts.google.com', aud: 'google-client-id', exp: Math.floor(NOW / 1000) + 60, nonce: 'wrong', sub: 'subject' }) })
      }
      return Response.json({ keys: [signer.jwk] })
    })
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/google/start`))
    const location = new URL(start.headers.get('location') ?? '')
    const response = await handler.fetch(requestWithCookie(
      `/api/auth/google/callback?code=code&state=${location.searchParams.get('state')}`,
      `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
    ))
    expect(response.status).toBe(401)
  })

  it('rejects a Google token whose signed payload was tampered with', async () => {
    const signer = await createGoogleSigner()
    let nonce = ''
    const signed = await signer.sign({
      iss: 'https://accounts.google.com', aud: 'google-client-id',
      exp: Math.floor(NOW / 1000) + 60, nonce: 'placeholder', sub: 'subject',
    })
    const [header, , signature] = signed.split('.')
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        const tamperedPayload = base64Url(JSON.stringify({
          iss: 'https://accounts.google.com', aud: 'google-client-id',
          exp: Math.floor(NOW / 1000) + 60, nonce, sub: 'subject',
        }))
        return Response.json({ id_token: `${header}.${tamperedPayload}.${signature}` })
      }
      return Response.json({ keys: [signer.jwk] })
    })
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/google/start`))
    const location = new URL(start.headers.get('location') ?? '')
    nonce = location.searchParams.get('nonce') ?? ''
    const response = await handler.fetch(requestWithCookie(
      `/api/auth/google/callback?code=code&state=${location.searchParams.get('state')}`,
      `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
    ))
    expect(response.status).toBe(401)
  })

  it('uses the GitHub numeric id, sends the PKCE verifier, then revokes and discards the callback token', async () => {
    let tokenRequestBody = ''
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('github.com/login/oauth/access_token')) {
        tokenRequestBody = String(init?.body)
        return Response.json({ access_token: 'temporary-provider-token', token_type: 'bearer' })
      }
      if (url === 'https://api.github.com/user') return Response.json({ id: 777, login: 'owner-login', email: 'ignored@example.com' })
      if (url.includes('/applications/github-client-id/token')) return new Response(null, { status: 204 })
      throw new Error(`unexpected provider request: ${url}`)
    })
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/github/start`))
    const location = new URL(start.headers.get('location') ?? '')
    const response = await handler.fetch(requestWithCookie(
      `/api/auth/github/callback?code=code&state=${location.searchParams.get('state')}`,
      `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
    ))

    expect(response.status).toBe(302)
    expect(tokenRequestBody).toMatch(/code_verifier=[A-Za-z0-9_-]{43}/)
    const identity = await database.prepare('SELECT provider_subject FROM auth_identities').first<{ provider_subject: string }>()
    expect(identity?.provider_subject).toBe('777')
    const persistedToken = await database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE sql LIKE '%temporary-provider-token%'").first<number>('count')
    expect(persistedToken).toBe(0)
    expect(providerFetch).toHaveBeenCalledWith(
      'https://api.github.com/applications/github-client-id/token',
      expect.objectContaining({ method: 'DELETE' }),
    )
    expect(response.headers.get('set-cookie')).not.toContain('temporary-provider-token')
    expect(response.headers.get('set-cookie')).toContain('__Host-oauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')
  })

  it('uses the canonical callback for GitHub authorisation and exchange, retaining the Owner identity across logout and login', async () => {
    env.PUBLIC_ORIGIN = production.publicOrigin
    const redirectUri = `${production.publicOrigin}/api/auth/github/callback`
    const exchanges: URLSearchParams[] = []
    const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://github.com/login/oauth/access_token') {
        exchanges.push(new URLSearchParams(String(init?.body)))
        return Response.json({ access_token: 'fixture-provider-token', token_type: 'bearer' })
      }
      if (url === 'https://api.github.com/user') return Response.json({ id: 777, login: 'existing-owner' })
      if (url === 'https://api.github.com/applications/github-client-id/token') return new Response(null, { status: 204 })
      throw new Error('unexpected fixture request')
    })
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
    let existingUserId: string | undefined
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = await handler.fetch(new Request(`${production.publicOrigin}/api/auth/github/start`))
      const location = new URL(start.headers.get('location') ?? '')
      expect(location.searchParams.get('redirect_uri')).toBe(redirectUri)
      expect(location.searchParams.get('code_challenge_method')).toBe('S256')
      const callback = await handler.fetch(new Request(`${redirectUri}?code=fixture&state=${location.searchParams.get('state')}`, {
        headers: { cookie: `__Host-oauth=${cookieValue(start, '__Host-oauth')}` },
      }))
      expect(callback.status).toBe(302)
      expect(exchanges[attempt].get('redirect_uri')).toBe(redirectUri)
      const cookie = `__Host-session=${cookieValue(callback, '__Host-session')}`
      const session = await handler.fetch(new Request(`${production.publicOrigin}/api/session`, { headers: { cookie } }))
      expect(session.status).toBe(200)
      const body = await session.json() as { user: { id: string; role: string } }
      expect(body.user.role).toBe('owner')
      if (existingUserId) expect(body.user.id).toBe(existingUserId)
      existingUserId = body.user.id
      const logout = await handler.fetch(new Request(`${production.publicOrigin}/api/logout`, { method: 'POST', headers: { cookie, origin: production.publicOrigin } }))
      expect(logout.status).toBe(204)
      expect((await handler.fetch(new Request(`${production.publicOrigin}/api/session`, { headers: { cookie } }))).status).toBe(401)
    }
    expect(await database.prepare('SELECT COUNT(*) AS count FROM users').first<number>('count')).toBe(1)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM auth_identities').first<number>('count')).toBe(1)
  })

  it('revokes the GitHub callback token even when the numeric identity request fails', async () => {
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('access_token')) return Response.json({ access_token: 'temporary', token_type: 'bearer' })
      if (url === 'https://api.github.com/user') {
        return Response.json(
          { error: 'UPSTREAM_SENTINEL temporary-provider-token' },
          { status: 503, headers: { 'set-cookie': 'upstream=private', location: 'https://internal.example/debug' } },
        )
      }
      if (url.includes('/applications/github-client-id/token')) return new Response(null, { status: 204 })
      throw new Error(`unexpected provider request: ${url}`)
    })
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/github/start`))
    const location = new URL(start.headers.get('location') ?? '')
    const response = await handler.fetch(requestWithCookie(
      `/api/auth/github/callback?code=code&state=${location.searchParams.get('state')}`,
      `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
    ))
    expect(response.status).toBe(401)
    expect(await response.clone().json()).toEqual({ error: 'oauth_callback_failed' })
    const exposedResponse = `${JSON.stringify([...response.headers])}\n${await response.text()}`
    expect(exposedResponse).not.toMatch(/UPSTREAM_SENTINEL|temporary-provider-token|internal\.example|upstream=private/)
    expect(providerFetch).toHaveBeenCalledWith(
      'https://api.github.com/applications/github-client-id/token',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('bootstraps Owner only from the exact configured provider subject and stores a keyed session hash for 90 days', async () => {
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('access_token')) return Response.json({ access_token: 'temporary', token_type: 'bearer' })
      if (url === 'https://api.github.com/user') return Response.json({ id: 777, login: 'owner-login' })
      return new Response(null, { status: 204 })
    })
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/github/start`))
    const location = new URL(start.headers.get('location') ?? '')
    const response = await handler.fetch(requestWithCookie(
      `/api/auth/github/callback?code=code&state=${location.searchParams.get('state')}`,
      `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
    ))

    const sessionCookie = response.headers.get('set-cookie') ?? ''
    expect(sessionCookie).toMatch(
      /__Host-session=[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=7776000(?:,|$)/,
    )
    const user = await database.prepare('SELECT role FROM users').first<{ role: string }>()
    expect(user?.role).toBe('owner')
    const session = await database.prepare('SELECT token_hash, expires_at FROM sessions').first<{ token_hash: string; expires_at: number }>()
    expect(session?.token_hash).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/)
    expect(session?.token_hash).not.toContain(cookieValue(response, '__Host-session'))
    expect(session?.expires_at).toBe(NOW + 90 * 24 * 60 * 60 * 1000)
  })

  it('links explicitly, rejects identity collisions, prevents last-identity unlink, and rotates the site session', async () => {
    const now = NOW
    await database.batch([
      database.prepare('INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').bind('user-a', 'A', 'user', now, now),
      database.prepare('INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').bind('user-b', 'B', 'user', now, now),
      database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('identity-a', 'user-a', 'google', 'google-a', now),
      database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('identity-b', 'user-b', 'github', '999', now),
    ])
    const handler = createAuthHandler(env, { now: () => NOW })
    const issued = await handler.issueSession('user-a')
    const oldCookie = `__Host-session=${issued.token}`

    const unlinkLast = await handler.fetch(requestWithCookie('/api/auth/google/unlink', oldCookie, { method: 'POST' }))
    expect(unlinkLast.status).toBe(409)

    const collision = await handler.linkIdentity(issued.token, { provider: 'github', subject: '999', displayName: 'Other' })
    expect(collision.status).toBe(409)

    const linked = await handler.linkIdentity(issued.token, { provider: 'github', subject: '888', displayName: 'A' })
    expect(linked.status).toBe(200)
    const newToken = cookieValue(linked, '__Host-session')
    expect(newToken).not.toBe(issued.token)
    expect((await handler.fetch(requestWithCookie('/api/session', oldCookie))).status).toBe(401)
    expect((await handler.fetch(requestWithCookie('/api/session', `__Host-session=${newToken}`))).status).toBe(200)

    const unlinked = await handler.fetch(requestWithCookie('/api/auth/google/unlink', `__Host-session=${newToken}`, { method: 'POST' }))
    expect(unlinked.status).toBe(200)
    expect((await handler.fetch(requestWithCookie('/api/session', `__Host-session=${newToken}`))).status).toBe(401)
    expect(cookieValue(unlinked, '__Host-session')).not.toBe(newToken)
  })

  it('rotates sessions after privilege changes and logout-all revokes every device', async () => {
    await database.prepare('INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .bind('user-a', 'A', 'user', NOW, NOW).run()
    const handler = createAuthHandler(env, { now: () => NOW })
    const deviceA = await handler.issueSession('user-a')
    const deviceB = await handler.issueSession('user-a')
    const rotated = await handler.rotateAfterPrivilegeChange(deviceA.token, 'admin')
    expect(rotated.status).toBe(200)
    expect((await handler.fetch(requestWithCookie('/api/session', `__Host-session=${deviceA.token}`))).status).toBe(401)
    const rotatedToken = cookieValue(rotated, '__Host-session')
    expect((await handler.fetch(requestWithCookie('/api/session', `__Host-session=${rotatedToken}`))).status).toBe(200)

    const logoutAll = await handler.fetch(requestWithCookie('/api/logout-all', `__Host-session=${rotatedToken}`, { method: 'POST' }))
    expect(logoutAll.status).toBe(204)
    expect((await handler.fetch(requestWithCookie('/api/session', `__Host-session=${rotatedToken}`))).status).toBe(401)
    expect((await handler.fetch(requestWithCookie('/api/session', `__Host-session=${deviceB.token}`))).status).toBe(401)
  })

  it.each([undefined, 'https://evil.study.example'])(
    'rejects cookie-authenticated state changes when Origin is %s',
    async (origin) => {
      await database.prepare('INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
        .bind('csrf-user', 'CSRF', 'user', NOW, NOW).run()
      const handler = createAuthHandler(env, { now: () => NOW })
      const issued = await handler.issueSession('csrf-user')
      const headers: Record<string, string> = {}
      if (origin) headers.origin = origin
      const response = await handler.fetch(requestWithCookie('/api/logout-all', `__Host-session=${issued.token}`, {
        method: 'POST',
        headers,
      }))
      expect(response.status).toBe(403)
      expect((await handler.fetch(requestWithCookie('/api/session', `__Host-session=${issued.token}`))).status).toBe(200)
    },
  )

  it('consumes a protected OAuth flow exactly once before provider exchange', async () => {
    let tokenCounter = 0
    const providerFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes('access_token')) return Response.json({ access_token: `temporary-${++tokenCounter}`, token_type: 'bearer' })
      if (url === 'https://api.github.com/user') return Response.json({ id: 777, login: 'replay-user' })
      if (url.includes('/applications/github-client-id/token')) return new Response(null, { status: 204 })
      throw new Error(`unexpected provider request: ${url}`)
    })
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/github/start`))
    const location = new URL(start.headers.get('location') ?? '')
    const cookie = `__Host-oauth=${cookieValue(start, '__Host-oauth')}`
    const callbackPath = `/api/auth/github/callback?code=code&state=${location.searchParams.get('state')}`

    const responses = await Promise.all([
      handler.fetch(requestWithCookie(callbackPath, cookie)),
      handler.fetch(requestWithCookie(callbackPath, cookie)),
    ])
    expect(responses.map(({ status }) => status).sort()).toEqual([302, 400])
    expect(providerFetch).toHaveBeenCalledTimes(3)
  })

  it('fails closed without creating identity or session if GitHub token revocation fails', async () => {
    const providerFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('access_token')) return Response.json({ access_token: 'still-live-token', token_type: 'bearer' })
      if (url === 'https://api.github.com/user') return Response.json({ id: 777, login: 'revoke-failure' })
      if (url.includes('/applications/github-client-id/token')) return new Response(null, { status: 503 })
      throw new Error(`unexpected provider request: ${url}`)
    })
    const handler = createAuthHandler(env, { now: () => NOW, fetch: providerFetch as typeof fetch })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/github/start`))
    const location = new URL(start.headers.get('location') ?? '')
    const response = await handler.fetch(requestWithCookie(
      `/api/auth/github/callback?code=code&state=${location.searchParams.get('state')}`,
      `__Host-oauth=${cookieValue(start, '__Host-oauth')}`,
    ))
    expect(response.status).toBe(401)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM users').first<number>('count')).toBe(0)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM auth_identities').first<number>('count')).toBe(0)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM sessions').first<number>('count')).toBe(0)
  })

  it('atomically retains one identity under concurrent unlink requests', async () => {
    await database.batch([
      database.prepare('INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind('unlink-user', 'Unlink', NOW, NOW),
      database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('unlink-google', 'unlink-user', 'google', 'google-sub', NOW),
      database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)').bind('unlink-github', 'unlink-user', 'github', '777', NOW),
    ])
    const handler = createAuthHandler(env, { now: () => NOW })
    const issued = await handler.issueSession('unlink-user')
    const cookie = `__Host-session=${issued.token}`
    const headers = { origin: ORIGIN }
    const responses = await Promise.all([
      handler.fetch(requestWithCookie('/api/auth/google/unlink', cookie, { method: 'POST', headers })),
      handler.fetch(requestWithCookie('/api/auth/github/unlink', cookie, { method: 'POST', headers })),
    ])
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409])
    expect(await database.prepare('SELECT COUNT(*) AS count FROM auth_identities WHERE user_id = ?').bind('unlink-user').first<number>('count')).toBe(1)
  })

  it('requests no GitHub OAuth scope and validates PUBLIC_ORIGIN as a canonical origin', async () => {
    const handler = createAuthHandler(env, { now: () => NOW })
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/github/start`))
    expect(new URL(start.headers.get('location') ?? '').searchParams.has('scope')).toBe(false)

    for (const invalidOrigin of ['http://study.example', 'https://user@study.example', 'https://study.example/path', 'https://study.example?query=1']) {
      expect(() => createAuthHandler({ ...env, PUBLIC_ORIGIN: invalidOrigin }, { now: () => NOW })).toThrow('invalid_public_origin')
    }
    expect(() => createAuthHandler({ ...env, PUBLIC_ORIGIN: 'http://localhost:4173' }, { now: () => NOW })).not.toThrow()
  })
})
