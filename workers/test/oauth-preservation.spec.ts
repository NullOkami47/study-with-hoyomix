// Wave E preservation (task 18, design Properties 2 and 4, requirement 3.2). Observation-first:
// every expectation below was observed on the unfixed tree (ee34b3b) and must still hold after
// H-04 moves the oauth_flows write from start to callback and rate-limits start.
//
// Deliberately NOT asserted here, because Wave E or a later wave changes them on purpose:
// - when or how many oauth_flows rows exist (H-04 moves the write to the callback);
// - the exact status/body of a rejected callback (M-09, Wave F, replaces the JSON errors);
// - the link-success response shape (M-09).
// A rejection is therefore observed as "no session issued, no account change, flow cookie cleared".
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAuthHandler, type AuthEnv } from '../auth/routes'
import { hashSessionToken, issueSession } from '../auth/session'
import { Log, LogLevel, Miniflare } from './miniflare-compat'

const ORIGIN = 'https://study.example'
const T0 = 1_786_480_000_000
const LIFETIME_MS = 10 * 60 * 1000
const SESSION_MAX_AGE = 90 * 24 * 60 * 60

type Provider = 'github' | 'google' | 'linuxdo'
type Tamper = 'none' | 'state' | 'cookie' | 'provider' | 'nonce'
type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const TOKEN_URL: Record<Provider, string> = {
  github: 'https://github.com/login/oauth/access_token',
  google: 'https://oauth2.googleapis.com/token',
  linuxdo: 'https://connect.linux.do/oauth2/token',
}
const AUTHORIZE: Record<Provider, string> = {
  github: 'https://github.com/login/oauth/authorize',
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
  linuxdo: 'https://connect.linux.do/oauth2/authorize',
}

const base64Url = (value: Uint8Array | string) =>
  Buffer.from(typeof value === 'string' ? new TextEncoder().encode(value) : value).toString('base64url')

const createSigner = async (kid: string) => {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey)
  const sign = async (claims: Record<string, unknown>) => {
    const header = base64Url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
    const payload = base64Url(JSON.stringify(claims))
    const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${payload}`))
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`
  }
  return { jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, sign }
}

/** Every Set-Cookie value of a response, split correctly. */
const setCookies = (response: Response) => response.headers.getSetCookie()
const cookieValue = (response: Response, name: string) =>
  setCookies(response).map((cookie) => cookie.match(new RegExp(`^${name}=([^;]*)`))?.[1]).find((value) => value !== undefined)

const count = async (database: TestDatabase, sql: string, ...binds: unknown[]) =>
  (await database.prepare(sql).bind(...binds).first<{ total: number }>())!.total

describe('OAuth login and link stay PKCE-bound, nonce-bound, sealed, single-use and time-limited (Property 4)', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: AuthEnv
  let google: Awaited<ReturnType<typeof createSigner>>
  let linuxdo: Awaited<ReturnType<typeof createSigner>>
  let run = 0

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `oauth-preservation-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    const directory = resolve(process.cwd(), 'migrations')
    for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
      const sql = await readFile(resolve(directory, name), 'utf8')
      await database.batch(sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => database.prepare(statement)))
    }
    env = {
      DB: database as never,
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'session-secret-with-at-least-thirty-two-characters',
      OAUTH_STATE_SECRET: 'oauth-state-secret-with-at-least-32-characters',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      GITHUB_CLIENT_ID: 'github-client-id',
      GITHUB_CLIENT_SECRET: 'github-client-secret',
      LINUXDO_CLIENT_ID: 'linuxdo-client-id',
      LINUXDO_CLIENT_SECRET: 'linuxdo-client-secret',
    }
    google = await createSigner('google-key')
    linuxdo = await createSigner('linuxdo-key')
  })

  afterAll(async () => {
    await miniflare?.dispose()
  })

  const scenario = fc.record({
    provider: fc.constantFrom<Provider>('github', 'google', 'linuxdo'),
    intent: fc.constantFrom<'login' | 'link'>('login', 'link'),
    // The boundary values are always in play: accepted strictly before the 10-minute lifetime.
    delayMs: fc.oneof(
      fc.constantFrom(0, 1, LIFETIME_MS - 1, LIFETIME_MS, LIFETIME_MS + 1),
      fc.integer({ min: 0, max: 2 * LIFETIME_MS }),
    ),
    tamper: fc.constantFrom<Tamper>('none', 'none', 'state', 'cookie', 'provider', 'nonce'),
  })

  it('accepts exactly the untampered callback inside the lifetime, once, and issues a hardened HMAC-stored session', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ provider, intent, delayMs, tamper }) => {
        run++
        let clock = T0 + run * 3 * LIFETIME_MS
        const started = clock
        const subject = String(10_000 + run)
        const exchanges: URLSearchParams[] = []
        let authorizeNonce = ''
        const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input)
          if (url === TOKEN_URL[provider]) {
            exchanges.push(new URLSearchParams(String(init?.body)))
            if (provider === 'github') return Response.json({ access_token: `provider-token-${run}`, token_type: 'bearer' })
            const nonce = tamper === 'nonce' ? `${authorizeNonce}-wrong` : authorizeNonce
            const signer = provider === 'google' ? google : linuxdo
            const claims = provider === 'google'
              ? { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID }
              : { iss: 'https://connect.linux.do/', aud: env.LINUXDO_CLIENT_ID }
            return Response.json({ id_token: await signer.sign({ ...claims, exp: Math.floor(clock / 1000) + 300, nonce, sub: subject, name: `User ${run}` }) })
          }
          if (url === 'https://api.github.com/user') return Response.json({ id: Number(subject), login: `user-${run}` })
          if (url === `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`) return new Response(null, { status: 204 })
          if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [google.jwk] })
          if (url === 'https://connect.linux.do/.well-known/jwks.json') return Response.json({ keys: [linuxdo.jwk] })
          throw new Error(`unexpected provider request ${url}`)
        }) as typeof fetch
        const handler = createAuthHandler(env, { now: () => clock, fetch: providerFetch, crypto })
        // A distinct client address per run keeps a per-IP start limiter (H-04) out of the way.
        const ip = `198.51.100.${run % 250}`

        // A link starts from an existing signed-in account that does not yet have this provider.
        let sessionCookie = ''
        let linkUserId: string | undefined
        if (intent === 'link') {
          linkUserId = `link-owner-${run}`
          await database.prepare("INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)")
            .bind(linkUserId, linkUserId, clock, clock).run()
          const other: Provider = provider === 'github' ? 'google' : 'github'
          await database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)')
            .bind(crypto.randomUUID(), linkUserId, other, `existing-${run}`, clock).run()
          sessionCookie = `__Host-session=${(await issueSession(database as never, linkUserId, env.SESSION_HMAC_SECRET, clock, crypto)).token}`
        }

        // --- start ---------------------------------------------------------------------------
        const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/${provider}/start?intent=${intent}`, {
          headers: { 'cf-connecting-ip': ip, ...(sessionCookie ? { cookie: sessionCookie } : {}) },
        }))
        expect(start.status).toBe(302)
        expect(start.headers.get('cache-control')).toBe('no-store')
        const location = new URL(start.headers.get('location')!)
        expect(`${location.origin}${location.pathname}`).toBe(AUTHORIZE[provider])
        const state = location.searchParams.get('state')!
        const challenge = location.searchParams.get('code_challenge')!
        expect(location.searchParams.get('response_type')).toBe('code')
        expect(location.searchParams.get('code_challenge_method')).toBe('S256')
        expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/${provider}/callback`)
        expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u)
        expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u)
        authorizeNonce = location.searchParams.get('nonce') ?? ''
        if (provider === 'github') expect(location.searchParams.has('nonce')).toBe(false)
        else expect(authorizeNonce).toMatch(/^[A-Za-z0-9_-]{43}$/u)
        const flowCookie = setCookies(start).find((cookie) => cookie.startsWith('__Host-oauth='))!
        expect(flowCookie).toMatch(/^__Host-oauth=[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/u)
        const sealed = cookieValue(start, '__Host-oauth')!
        // The flow (state, nonce, verifier) is sealed, not readable from the cookie.
        expect(sealed).not.toContain(state)
        if (authorizeNonce) expect(sealed).not.toContain(authorizeNonce)
        expect(cookieValue(start, '__Host-session')).toBeUndefined()
        expect(exchanges).toHaveLength(0)

        // --- callback ------------------------------------------------------------------------
        clock = started + delayMs
        const callbackProvider: Provider = tamper === 'provider' ? (provider === 'github' ? 'google' : 'github') : provider
        const callbackState = tamper === 'state' ? `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}` : state
        const cookie = tamper === 'cookie' ? `${sealed.slice(0, 20)}${sealed[20] === 'A' ? 'B' : 'A'}${sealed.slice(21)}` : sealed
        const callbackRequest = () => new Request(
          `${ORIGIN}/api/auth/${callbackProvider}/callback?code=code-${run}&state=${encodeURIComponent(callbackState)}`,
          { headers: { 'cf-connecting-ip': ip, cookie: [`__Host-oauth=${cookie}`, sessionCookie].filter(Boolean).join('; ') } },
        )
        const before = {
          users: await count(database, 'SELECT COUNT(*) AS total FROM users'),
          identities: await count(database, 'SELECT COUNT(*) AS total FROM auth_identities'),
          sessions: await count(database, 'SELECT COUNT(*) AS total FROM sessions'),
        }
        const effectiveTamper: Tamper = provider === 'github' && tamper === 'nonce' ? 'none' : tamper
        const accepted = effectiveTamper === 'none' && delayMs < LIFETIME_MS
        const response = await handler.fetch(callbackRequest())
        const token = cookieValue(response, '__Host-session')
        // The flow cookie is always cleared by the callback, accepted or not.
        expect(setCookies(response)).toContain('__Host-oauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0')

        if (accepted) {
          expect(response.status, `accepted ${provider}/${intent}`).toBeLessThan(400)
          expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
          expect(setCookies(response)).toContain(`__Host-session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`)
          if (intent === 'login') expect(response.headers.get('location')).toBe(`${ORIGIN}/`)
          // PKCE S256: exactly one exchange, carrying the verifier whose SHA-256 is the challenge.
          expect(exchanges).toHaveLength(1)
          const verifier = exchanges[0].get('code_verifier')!
          expect(base64Url(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).toBe(challenge)
          expect(exchanges[0].get('code')).toBe(`code-${run}`)
          expect(exchanges[0].get('redirect_uri')).toBe(`${ORIGIN}/api/auth/${provider}/callback`)
          // The session row stores only the HMAC of the token.
          const tokenHash = await hashSessionToken(token!, env.SESSION_HMAC_SECRET, crypto)
          const row = await database.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(tokenHash).first<Record<string, unknown>>()
          expect(row).not.toBeNull()
          expect(Object.values(row!).map(String)).not.toContain(token)
          expect(row!.expires_at).toBe(clock + SESSION_MAX_AGE * 1000)
          // The issued session belongs to the right account and carries the provider identity.
          const session = await handler.fetch(new Request(`${ORIGIN}/api/session`, { headers: { cookie: `__Host-session=${token}` } }))
          const body = await session.json() as { user: { id: string }; identities: string[] }
          expect(body.identities).toContain(provider)
          if (intent === 'link') {
            expect(body.user.id).toBe(linkUserId)
            expect(await count(database, 'SELECT COUNT(*) AS total FROM users')).toBe(before.users)
          } else {
            expect(await count(database, 'SELECT COUNT(*) AS total FROM users')).toBe(before.users + 1)
          }
          expect(await count(database, 'SELECT COUNT(*) AS total FROM auth_identities')).toBe(before.identities + 1)
        } else {
          expect(token ?? '', `rejected ${provider}/${intent} tamper=${tamper} delay=${delayMs}`).toBe('')
          expect(await count(database, 'SELECT COUNT(*) AS total FROM users')).toBe(before.users)
          expect(await count(database, 'SELECT COUNT(*) AS total FROM auth_identities')).toBe(before.identities)
          expect(await count(database, 'SELECT COUNT(*) AS total FROM sessions')).toBe(before.sessions)
          // State, cookie, provider and expiry failures are refused before contacting the provider.
          if (effectiveTamper !== 'nonce') expect(exchanges).toHaveLength(0)
        }
      }),
      { numRuns: 40, endOnFailure: true },
    )
  })

  it('never accepts the same state twice, even inside the lifetime and with the new session attached', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Provider>('github', 'google', 'linuxdo'),
        fc.integer({ min: 0, max: LIFETIME_MS - 2 }),
        fc.integer({ min: 1, max: 3 }),
        async (provider, delayMs, replays) => {
          run++
          let clock = T0 + run * 3 * LIFETIME_MS
          const started = clock
          const subject = String(50_000 + run)
          let exchanges = 0
          let authorizeNonce = ''
          const providerFetch = (async (input: RequestInfo | URL) => {
            const url = String(input)
            if (url === TOKEN_URL[provider]) {
              exchanges++
              if (provider === 'github') return Response.json({ access_token: `provider-token-${run}`, token_type: 'bearer' })
              const signer = provider === 'google' ? google : linuxdo
              const claims = provider === 'google'
                ? { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID }
                : { iss: 'https://connect.linux.do/', aud: env.LINUXDO_CLIENT_ID }
              return Response.json({ id_token: await signer.sign({ ...claims, exp: Math.floor(clock / 1000) + 300, nonce: authorizeNonce, sub: subject }) })
            }
            if (url === 'https://api.github.com/user') return Response.json({ id: Number(subject), login: `user-${run}` })
            if (url === `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`) return new Response(null, { status: 204 })
            if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [google.jwk] })
            if (url === 'https://connect.linux.do/.well-known/jwks.json') return Response.json({ keys: [linuxdo.jwk] })
            throw new Error(`unexpected provider request ${url}`)
          }) as typeof fetch
          const handler = createAuthHandler(env, { now: () => clock, fetch: providerFetch, crypto })
          const ip = `192.0.2.${run % 250}`
          const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/${provider}/start`, { headers: { 'cf-connecting-ip': ip } }))
          const location = new URL(start.headers.get('location')!)
          authorizeNonce = location.searchParams.get('nonce') ?? ''
          const path = `${ORIGIN}/api/auth/${provider}/callback?code=code-${run}&state=${location.searchParams.get('state')}`
          const flow = `__Host-oauth=${cookieValue(start, '__Host-oauth')}`
          clock = started + delayMs
          const first = await handler.fetch(new Request(path, { headers: { 'cf-connecting-ip': ip, cookie: flow } }))
          const token = cookieValue(first, '__Host-session')
          expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
          const sessions = await count(database, 'SELECT COUNT(*) AS total FROM sessions')
          for (let replay = 0; replay < replays; replay++) {
            clock++
            const cookie = replay % 2 === 0 ? flow : `${flow}; __Host-session=${token}`
            const again = await handler.fetch(new Request(path, { headers: { 'cf-connecting-ip': ip, cookie } }))
            expect(cookieValue(again, '__Host-session') ?? '', `replay ${replay + 1}`).toBe('')
          }
          expect(exchanges).toBe(1)
          expect(await count(database, 'SELECT COUNT(*) AS total FROM sessions')).toBe(sessions)
          // The first session is still the valid one; a replay neither revoked nor replaced it.
          const session = await handler.fetch(new Request(`${ORIGIN}/api/session`, { headers: { cookie: `__Host-session=${token}` } }))
          expect(session.status).toBe(200)
        },
      ),
      { numRuns: 15, endOnFailure: true },
    )
  })

  it('refuses to complete a link under a different signed-in account than the one that started it', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<Provider>('github', 'google', 'linuxdo'), fc.boolean(), async (provider, signedOut) => {
        run++
        const clock = T0 + run * 3 * LIFETIME_MS
        const providerFetch = (async () => { throw new Error('the provider must not decide this case') }) as unknown as typeof fetch
        const handler = createAuthHandler(env, { now: () => clock, fetch: providerFetch, crypto })
        const tokens: string[] = []
        for (const suffix of ['a', 'b']) {
          const id = `link-${run}-${suffix}`
          await database.prepare("INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)")
            .bind(id, id, clock, clock).run()
          tokens.push((await issueSession(database as never, id, env.SESSION_HMAC_SECRET, clock, crypto)).token)
        }
        const ip = `203.0.113.${run % 250}`
        const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/${provider}/start?intent=link`, {
          headers: { 'cf-connecting-ip': ip, cookie: `__Host-session=${tokens[0]}` },
        }))
        expect(start.status).toBe(302)
        const state = new URL(start.headers.get('location')!).searchParams.get('state')
        const flow = `__Host-oauth=${cookieValue(start, '__Host-oauth')}`
        const before = await count(database, 'SELECT COUNT(*) AS total FROM auth_identities')
        const response = await handler.fetch(new Request(`${ORIGIN}/api/auth/${provider}/callback?code=c&state=${state}`, {
          headers: { 'cf-connecting-ip': ip, cookie: signedOut ? flow : `${flow}; __Host-session=${tokens[1]}` },
        }))
        expect(cookieValue(response, '__Host-session') ?? '').toBe('')
        expect(await count(database, 'SELECT COUNT(*) AS total FROM auth_identities')).toBe(before)
      }),
      { numRuns: 6, endOnFailure: true },
    )
  })

  it('refuses an anonymous link start and never seals a flow for it', async () => {
    run++
    const handler = createAuthHandler(env, { now: () => T0, crypto })
    for (const provider of ['github', 'google', 'linuxdo'] as const) {
      const response = await handler.fetch(new Request(`${ORIGIN}/api/auth/${provider}/start?intent=link`, { headers: { 'cf-connecting-ip': `203.0.113.${run % 250}` } }))
      expect(response.status).toBe(401)
      expect(cookieValue(response, '__Host-oauth')).toBeUndefined()
    }
  })
})
