// Wave F preservation (task 22, design Property 2 / Property 11 preservation clause, requirement
// 3.2). Observation-first: every expectation below was observed on the unfixed tree (3a30d77) and
// must still hold after M-09 turns the link-completion, link-collision and callback-catch branches
// into redirects.
//
// Inputs stay outside the M-09 bug clause: only `intent=login` callbacks that succeed, and
// callbacks rejected by the state/provider/lifetime/single-use checks (`invalid_oauth_state`),
// which M-09 does not touch. Link callbacks and provider-exchange failures are not used here.
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { webcrypto } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAuthHandler, type AuthEnv } from '../auth/routes'
import { issueSession } from '../auth/session'
import { Log, LogLevel, Miniflare } from './miniflare-compat'

const ORIGIN = 'https://study.example'
const T0 = 1_787_000_000_000
const LIFETIME_MS = 10 * 60 * 1000
const SESSION_MAX_AGE = 90 * 24 * 60 * 60
const CLEARED_FLOW = '__Host-oauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'

type Provider = 'github' | 'google' | 'linuxdo'
type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const TOKEN_URL: Record<Provider, string> = {
  github: 'https://github.com/login/oauth/access_token',
  google: 'https://oauth2.googleapis.com/token',
  linuxdo: 'https://connect.linux.do/oauth2/token',
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

const cookieValue = (response: Response, name: string) =>
  response.headers.getSetCookie().map((cookie) => cookie.match(new RegExp(`^${name}=([^;]*)`))?.[1]).find((value) => value !== undefined)

const count = async (database: TestDatabase, sql: string, ...binds: unknown[]) =>
  (await database.prepare(sql).bind(...binds).first<{ total: number }>())!.total

describe('OAuth login redirect, cookies and invalid_oauth_state are unchanged (3.2)', () => {
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
      d1Databases: { DB: `oauth-login-preservation-${crypto.randomUUID()}` },
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
  afterAll(async () => { await miniflare?.dispose() })

  /** A provider double that answers the token exchange for `subject`. */
  const providerDouble = (provider: Provider, subject: string, clock: () => number, nonce: () => string) => {
    const exchanges: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === TOKEN_URL[provider]) {
        exchanges.push(url)
        if (provider === 'github') return Response.json({ access_token: `provider-token-${subject}`, token_type: 'bearer' })
        const signer = provider === 'google' ? google : linuxdo
        const claims = provider === 'google'
          ? { iss: 'https://accounts.google.com', aud: env.GOOGLE_CLIENT_ID }
          : { iss: 'https://connect.linux.do/', aud: env.LINUXDO_CLIENT_ID }
        return Response.json({ id_token: await signer.sign({ ...claims, exp: Math.floor(clock() / 1000) + 300, nonce: nonce(), sub: subject, name: `User ${subject}` }) })
      }
      if (url === 'https://api.github.com/user') return Response.json({ id: Number(subject), login: `user-${subject}` })
      if (url === `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`) return new Response(null, { status: 204 })
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [google.jwk] })
      if (url === 'https://connect.linux.do/.well-known/jwks.json') return Response.json({ keys: [linuxdo.jwk] })
      throw new Error(`unexpected provider request ${url}`)
    }) as typeof fetch
    return { fetchImpl, exchanges }
  }

  const startLogin = async (handler: ReturnType<typeof createAuthHandler>, provider: Provider, ip: string, cookie = '') => {
    const start = await handler.fetch(new Request(`${ORIGIN}/api/auth/${provider}/start`, {
      headers: { 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}) },
    }))
    expect(start.status).toBe(302)
    const location = new URL(start.headers.get('location')!)
    return { state: location.searchParams.get('state')!, nonce: location.searchParams.get('nonce') ?? '', flow: cookieValue(start, '__Host-oauth')! }
  }

  it('redirects a successful login to PUBLIC_ORIGIN/ with the hardened session cookie, rotating any prior session', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Provider>('github', 'google', 'linuxdo'),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: LIFETIME_MS - 1 }),
        async (provider, returning, signedIn, delayMs) => {
          run++
          let clock = T0 + run * 3 * LIFETIME_MS
          const subject = String(70_000 + run)
          let nonce = ''
          const { fetchImpl, exchanges } = providerDouble(provider, subject, () => clock, () => nonce)
          const handler = createAuthHandler(env, { now: () => clock, fetch: fetchImpl, crypto })
          const ip = `198.18.${run % 250}.1`

          // A returning account already owns this provider identity.
          let existingUser: string | undefined
          if (returning) {
            existingUser = `returning-${run}`
            await database.prepare("INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)").bind(existingUser, existingUser, clock, clock).run()
            await database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)')
              .bind(crypto.randomUUID(), existingUser, provider, subject, clock).run()
          }
          // A browser that is already signed in (as some other account) logs in again.
          let prior: { token: string; id: string } | undefined
          if (signedIn) {
            const other = `prior-${run}`
            await database.prepare("INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)").bind(other, other, clock, clock).run()
            const issued = await issueSession(database as never, other, env.SESSION_HMAC_SECRET, clock, crypto)
            prior = { token: issued.token, id: issued.record.id }
          }
          const priorCookie = prior ? `__Host-session=${prior.token}` : ''
          const started = await startLogin(handler, provider, ip, priorCookie)
          nonce = started.nonce
          clock += delayMs
          const users = await count(database, 'SELECT COUNT(*) AS total FROM users')

          const response = await handler.fetch(new Request(`${ORIGIN}/api/auth/${provider}/callback?code=code-${run}&state=${started.state}`, {
            headers: { 'cf-connecting-ip': ip, cookie: [`__Host-oauth=${started.flow}`, priorCookie].filter(Boolean).join('; ') },
          }))
          const label = `${provider} returning=${returning} signedIn=${signedIn} delay=${delayMs}`
          expect(response.status, label).toBe(302)
          expect(response.headers.get('location'), label).toBe(`${ORIGIN}/`)
          expect(response.headers.get('cache-control')).toBe('no-store')
          expect(await response.text()).toBe('')
          const token = cookieValue(response, '__Host-session')!
          expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
          expect(response.headers.getSetCookie()).toEqual([
            `__Host-session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`,
            CLEARED_FLOW,
          ])
          expect(exchanges).toHaveLength(1)

          const session = await handler.fetch(new Request(`${ORIGIN}/api/session`, { headers: { cookie: `__Host-session=${token}` } }))
          expect(session.status).toBe(200)
          const body = await session.json() as { user: { id: string } }
          if (returning) {
            expect(body.user.id).toBe(existingUser)
            expect(await count(database, 'SELECT COUNT(*) AS total FROM users')).toBe(users)
          } else {
            expect(await count(database, 'SELECT COUNT(*) AS total FROM users')).toBe(users + 1)
          }
          if (prior) {
            const row = await database.prepare('SELECT revoked_at AS revokedAt FROM sessions WHERE id = ?').bind(prior.id).first<{ revokedAt: number | null }>()
            expect(row?.revokedAt, label).toBe(clock)
          }
        },
      ),
      { numRuns: 18, endOnFailure: true },
    )
  })

  type Rejection = 'state' | 'provider' | 'expired' | 'future' | 'missing_code' | 'missing_state' | 'replay'

  it('answers state, provider, lifetime and replay failures with 400 invalid_oauth_state before contacting the provider', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Provider>('github', 'google', 'linuxdo'),
        fc.constantFrom<Rejection>('state', 'provider', 'expired', 'future', 'missing_code', 'missing_state', 'replay'),
        fc.integer({ min: 1, max: LIFETIME_MS }),
        async (provider, rejection, offset) => {
          run++
          let clock = T0 + run * 3 * LIFETIME_MS
          const subject = String(90_000 + run)
          let nonce = ''
          const { fetchImpl, exchanges } = providerDouble(provider, subject, () => clock, () => nonce)
          const handler = createAuthHandler(env, { now: () => clock, fetch: fetchImpl, crypto })
          const ip = `198.19.${run % 250}.1`
          const started = await startLogin(handler, provider, ip)
          nonce = started.nonce
          const callback = (target: Provider, query: string) => handler.fetch(new Request(`${ORIGIN}/api/auth/${target}/callback?${query}`, {
            headers: { 'cf-connecting-ip': ip, cookie: `__Host-oauth=${started.flow}` },
          }))
          const valid = `code=code-${run}&state=${started.state}`
          if (rejection === 'replay') {
            clock += 1
            expect((await callback(provider, valid)).status).toBe(302)
            exchanges.length = 0
          }
          const sessions = await count(database, 'SELECT COUNT(*) AS total FROM sessions')
          const flipped = `${started.state.slice(0, -1)}${started.state.endsWith('A') ? 'B' : 'A'}`
          const other: Provider = provider === 'github' ? 'google' : 'github'
          if (rejection === 'expired') clock += LIFETIME_MS + offset
          if (rejection === 'future') clock -= offset
          const response = rejection === 'state' ? await callback(provider, `code=code-${run}&state=${flipped}`)
            : rejection === 'provider' ? await callback(other, valid)
              : rejection === 'missing_code' ? await callback(provider, `state=${started.state}`)
                : rejection === 'missing_state' ? await callback(provider, `code=code-${run}`)
                  : await callback(provider, valid)
          const label = `${provider} ${rejection} offset=${offset}`
          expect(response.status, label).toBe(400)
          expect(await response.json(), label).toEqual({ error: 'invalid_oauth_state' })
          expect(response.headers.get('location'), label).toBeNull()
          expect(response.headers.getSetCookie(), label).toEqual([CLEARED_FLOW])
          expect(exchanges, label).toHaveLength(0)
          expect(await count(database, 'SELECT COUNT(*) AS total FROM sessions'), label).toBe(sessions)
        },
      ),
      { numRuns: 28, endOnFailure: true },
    )
  })
})
