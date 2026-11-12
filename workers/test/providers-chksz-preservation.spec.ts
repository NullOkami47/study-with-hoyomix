// Wave F preservation (task 22, design Property 2 / Property 8 preservation clause, requirements
// 3.8 and 3.9). Observation-first: every expectation below was observed on the unfixed tree
// (3a30d77) and must still hold after M-05 (owner key only with a session, per-session and per-IP
// limits, D4) and M-06 (shared admin search limiter).
//
// Inputs stay outside both bug clauses: every owner-key request carries a valid session, each
// session and each client address is used for at most four requests (ChKSz contract: 20/min),
// and every admin issues at most four searches (limit CHKSZ_ADMIN_SEARCH_RATE_LIMIT_PER_MINUTE).
// Handlers are built fresh per request, as worker.fetch does.
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { RUNTIME_DENYLIST } from '../../src/shared/chkszDiscovery'
import { issueSession } from '../auth/session'
import type { ProviderEnv } from '../providers/config'
import { CHKSZ_ADMIN_SEARCH_RATE_LIMIT_PER_MINUTE } from '../providers/chkszSearchProxy'
import { createProviderHandler } from '../providers/routes'
import worker from '../index'
import { Log, LogLevel, Miniflare } from './miniflare-compat'

const ORIGIN = 'https://study.example'
const OWNER_KEY = 'owner-key-preservation-sentinel'
const SESSION_SECRET = 'session-secret-at-least-thirty-two-bytes'
const CHKSZ_ID = '1315196858'
const TEMPORARY_URL = 'https://m801.music.126.net/temporary-audio'
const NOW = Date.now()

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>
let miniflare: Miniflare
let database: TestDatabase
let sequence = 0

const env = (overrides: Partial<ProviderEnv> = {}): ProviderEnv => ({
  DB: database as never,
  PUBLIC_ORIGIN: ORIGIN,
  SESSION_HMAC_SECRET: SESSION_SECRET,
  OAUTH_STATE_SECRET: 'oauth-secret-at-least-thirty-two-bytes',
  GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-client', GITHUB_CLIENT_SECRET: 'github-secret',
  CHKSZ_API_KEY: OWNER_KEY,
  ...overrides,
})

class PreparationCache {
  readonly entries = new Map<string, Response>()
  async match(input: RequestInfo | URL) {
    const request = input instanceof Request ? input : new Request(input)
    return this.entries.get(`${request.method} ${request.url}`)?.clone()
  }
  async put(input: RequestInfo | URL, response: Response) {
    const request = input instanceof Request ? input : new Request(input)
    this.entries.set(`${request.method} ${request.url}`, response.clone())
  }
}

const upstreamJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const chkszMusic = () => upstreamJson({
  code: 200, msg: 'success',
  data: { id: Number(CHKSZ_ID), url: TEMPORARY_URL, br: 128000, level: 'standard', size: 1234, md5: 'md5', name: 'n', artist: 'a', album: 'b', picUrl: 'https://p1.music.126.net/x' },
})

const setOwnerFallback = (enabled: boolean) => database.prepare(`
  INSERT INTO admin_settings (setting_key, setting_json, updated_by, updated_at)
  VALUES ('provider.chksz.ownerKeyFallback', ?, NULL, 0)
  ON CONFLICT(setting_key) DO UPDATE SET setting_json = excluded.setting_json
`).bind(JSON.stringify({ enabled })).run()

const signedIn = async (role: 'user' | 'moderator' | 'admin' | 'owner' = 'user', issuedAt = NOW) => {
  const userId = `pres-${role}-${++sequence}`
  await database.prepare('INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(userId, userId, role, issuedAt, issuedAt).run()
  const issued = await issueSession(database as never, userId, SESSION_SECRET, issuedAt, crypto)
  return { userId, cookie: `__Host-session=${issued.token}` }
}

const freshHandler = (fetchImpl: typeof fetch, overrides: Partial<ProviderEnv> = {}) => createProviderHandler(env(overrides), {
  cache: new PreparationCache() as unknown as Pick<Cache, 'match' | 'put'>,
  crypto: { getRandomValues: (bytes: Uint8Array) => { bytes.forEach((_, index) => { bytes[index] = index }); return bytes } } as unknown as Crypto,
  fetch: fetchImpl,
  now: () => NOW,
})

const resolveRequest = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/providers/chksz/resolve`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
  body: JSON.stringify({ externalId: CHKSZ_ID }),
})
const discoverRequest = (body: unknown, headers: Record<string, string>) => new Request(`${ORIGIN}/api/providers/chksz/discover`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
  body: JSON.stringify(body),
})

const noSecrets = async (response: Response, ...secrets: string[]) => {
  const serialised = `${JSON.stringify([...response.headers])}\n${await response.clone().text()}`
  for (const secret of [OWNER_KEY, TEMPORARY_URL, 'api.chksz.com', ...secrets]) expect(serialised).not.toContain(secret)
}

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: `chksz-preservation-${crypto.randomUUID()}` },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  })
  database = await miniflare.getD1Database('DB')
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(value))
    .filter((value) => value !== '0009_playback_provider_defaults.sql').sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => database.prepare(statement)))
  }
  await database.prepare("INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at) VALUES ('chksz', 1, 20, 'unknown', 0)").run()
})
afterAll(async () => { await miniflare?.dispose() })

const userKey = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/u)

describe('ChKSz resolve credential routing is unchanged for signed-in and user-key callers (3.8)', () => {
  it('uses the owner key for a signed-in caller without a user key, under the limit, on every fresh handler', async () => {
    await setOwnerFallback(true)
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async (requests) => {
        const { cookie } = await signedIn('user')
        const ip = `203.0.113.${++sequence % 250}`
        for (let index = 0; index < requests; index++) {
          const upstream: string[] = []
          const fetchImpl = vi.fn(async (input: RequestInfo | URL) => { upstream.push(String(input)); return chkszMusic() }) as unknown as typeof fetch
          const response = await freshHandler(fetchImpl).fetch(resolveRequest({ cookie, 'cf-connecting-ip': ip }))
          expect(response.status, `request ${index + 1}/${requests}`).toBe(200)
          expect(upstream).toHaveLength(1)
          const url = new URL(upstream[0])
          expect(url.origin).toBe('https://api.chksz.com')
          expect(url.searchParams.get('apikey')).toBe(OWNER_KEY)
          expect(url.searchParams.get('id')).toBe(CHKSZ_ID)
          const body = await response.clone().json() as { metadata?: unknown }
          expect(body.metadata).toBeDefined()
          await noSecrets(response)
        }
      }),
      { numRuns: 6, endOnFailure: true },
    )
  })

  it('sends a valid user key upstream instead of the owner key, with or without a session', async () => {
    await setOwnerFallback(true)
    await fc.assert(
      fc.asyncProperty(userKey, fc.boolean(), async (key, withSession) => {
        const headers: Record<string, string> = { 'x-chksz-api-key': key, 'cf-connecting-ip': `198.51.100.${++sequence % 250}` }
        if (withSession) headers.cookie = (await signedIn('user')).cookie
        const ownerRead = vi.fn(() => OWNER_KEY)
        const upstream: string[] = []
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => { upstream.push(String(input)); return chkszMusic() }) as unknown as typeof fetch
        const handlerEnv = env()
        Object.defineProperty(handlerEnv, 'CHKSZ_API_KEY', { configurable: true, get: ownerRead })
        const handler = createProviderHandler(handlerEnv, {
          cache: new PreparationCache() as unknown as Pick<Cache, 'match' | 'put'>,
          crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) } as unknown as Crypto,
          fetch: fetchImpl,
          now: () => NOW,
        })
        const response = await handler.fetch(resolveRequest(headers))
        expect(response.status, `withSession=${withSession}`).toBe(200)
        expect(upstream).toHaveLength(1)
        expect(new URL(upstream[0]).searchParams.get('apikey')).toBe(key)
        expect(ownerRead).not.toHaveBeenCalled()
        await noSecrets(response, ...(key.length >= 8 ? [key] : []))
      }),
      { numRuns: 12, endOnFailure: true },
    )
  })

  it('refuses an invalid user key with 400 invalid_credential before upstream access, even when signed in', async () => {
    await setOwnerFallback(true)
    const { cookie } = await signedIn('user')
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('', '   ', 'x'.repeat(513), 'bad\u0001key', 'tab\u007fkey'), async (key) => {
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const response = await freshHandler(fetchImpl).fetch(resolveRequest({ cookie, 'x-chksz-api-key': key }))
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_credential' })
        expect(fetchImpl).not.toHaveBeenCalled()
      }),
      { numRuns: 5 },
    )
  })

  it('keeps 503 credential_required for a signed-in caller while owner fallback is OFF', async () => {
    await setOwnerFallback(false)
    try {
      const { cookie } = await signedIn('user')
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const response = await freshHandler(fetchImpl).fetch(resolveRequest({ cookie }))
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'credential_required' })
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      await setOwnerFallback(true)
    }
  })
})

describe('ChKSz discover with a session keeps owner-key search, the cache and the deny-list (3.8)', () => {
  const search = (songs: unknown[]) => upstreamJson({ code: 200, data: { songs } })
  const resetDiscovery = async () => {
    await database.prepare('DELETE FROM chksz_dynamic_discoveries').run()
    await database.prepare('DELETE FROM chksz_discovery_locks').run()
    await database.prepare('DELETE FROM chksz_discovery_rate_events').run()
  }

  it('finds an exact match with the owner key once, then serves the cached binding without upstream access', async () => {
    await setOwnerFallback(true)
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100_000_000, max: 999_999_999 }),
        fc.stringMatching(/^[A-Z][a-z]{2,10}( [A-Z][a-z]{2,10}){0,2}$/u),
        fc.integer({ min: 60, max: 400 }),
        async (id, title, seconds) => {
          await resetDiscovery()
          const { cookie } = await signedIn('user')
          const trackId = `pres-discover-${++sequence}`
          const keys: Array<string | null> = []
          const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
            const url = new URL(String(input))
            keys.push(url.searchParams.get('apikey'))
            expect(url.origin + url.pathname).toBe('https://api.chksz.com/api/163_search')
            expect(url.searchParams.get('keyword')).toBe(title)
            return search([{ id, name: title, artists: 'HOYO-MiX', album: 'Album', duration: seconds * 1000 }])
          }) as unknown as typeof fetch
          const body = { trackId, metadata: { title, vocalStatus: 'uncertain', duration_s: seconds } }
          const headers = { cookie, 'cf-connecting-ip': `192.0.2.${sequence % 250}` }
          const first = await freshHandler(fetchImpl).fetch(discoverRequest(body, headers))
          expect(first.status).toBe(200)
          expect(await first.json()).toEqual({ ok: true, externalId: String(id), confidence: 'EXACT', source: 'search' })
          expect(keys).toEqual([OWNER_KEY])
          const second = await freshHandler(fetchImpl).fetch(discoverRequest(body, headers))
          expect(second.status).toBe(200)
          expect(await second.json()).toMatchObject({ ok: true, externalId: String(id), source: 'cache' })
          expect(keys).toHaveLength(1)
        },
      ),
      { numRuns: 6, endOnFailure: true },
    )
  })

  it('never binds a deny-listed (track, external ID) pair, whatever the search returns', async () => {
    await setOwnerFallback(true)
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...RUNTIME_DENYLIST.entries), fc.boolean(), async (entry, useUserKey) => {
        await resetDiscovery()
        const { cookie } = await signedIn('user')
        const fetchImpl = vi.fn(async () => search([
          { id: Number(entry.provider_external_id), name: 'Denied Title', artists: 'HOYO-MiX', duration: 150_000 },
        ])) as unknown as typeof fetch
        const headers: Record<string, string> = { cookie, 'cf-connecting-ip': `192.0.2.${++sequence % 250}` }
        if (useUserKey) headers['x-chksz-api-key'] = 'user-key-for-denylist-check'
        const response = await freshHandler(fetchImpl).fetch(discoverRequest({
          trackId: entry.canonical_track_id,
          metadata: { title: 'Denied Title', vocalStatus: 'uncertain', duration_s: 150 },
        }, headers))
        const label = `${entry.canonical_track_id}/${entry.provider_external_id} userKey=${useUserKey}`
        expect(response.status, label).not.toBe(200)
        expect(JSON.stringify(await response.json()), label).not.toContain(entry.provider_external_id)
        const bound = await database.prepare(`SELECT COUNT(*) AS total FROM chksz_dynamic_discoveries
          WHERE canonical_track_id = ? AND provider_external_id = ? AND status = 'active'`)
          .bind(entry.canonical_track_id, entry.provider_external_id).first<{ total: number }>()
        expect(bound!.total, label).toBe(0)
      }),
      { numRuns: 12, endOnFailure: true },
    )
  })
})

describe('admin ChKSz search through worker.fetch keeps role checks and normal-rate results (3.9)', () => {
  const searchRequest = (keyword: string, cookie?: string) => new Request(`${ORIGIN}/api/admin/providers/chksz/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ keyword, limit: 5 }),
  })

  it('serves admins and owners below the limit, refuses users and moderators with 403 and anonymous callers with 401', async () => {
    await setOwnerFallback(true)
    expect(CHKSZ_ADMIN_SEARCH_RATE_LIMIT_PER_MINUTE).toBeGreaterThan(4)
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'anonymous' | 'user' | 'moderator' | 'admin' | 'owner'>('anonymous', 'user', 'moderator', 'admin', 'owner'),
        fc.array(fc.stringMatching(/^[a-z]{1,12}$/u), { minLength: 1, maxLength: 4 }),
        async (role, keywords) => {
          const caller = role === 'anonymous' ? null : await signedIn(role, Date.now())
          const upstream: string[] = []
          vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
            upstream.push(String(input))
            return upstreamJson({ code: 200, msg: 'success', data: { songs: [{ id: 1315196858, name: 'n', artists: 'a', album: 'b', picUrl: '', duration: 1000 }], total: 1 } })
          })
          try {
            const audits = async () => caller
              ? (await database.prepare("SELECT COUNT(*) AS total FROM admin_audit_log WHERE action = 'provider.chksz.search' AND actor_user_id = ?").bind(caller.userId).first<{ total: number }>())!.total
              : 0
            for (const keyword of keywords) {
              const response = await worker.fetch(searchRequest(keyword, caller?.cookie), env() as never)
              const label = `${role} ${keyword}`
              if (role === 'admin' || role === 'owner') {
                expect(response.status, label).toBe(200)
                expect(response.headers.get('cache-control')).toBe('no-store')
                const body = await response.json() as Record<string, unknown>
                expect(body.durationUnit).toBe('live_verified_ms')
                expect(JSON.stringify(body)).not.toContain(OWNER_KEY)
              } else {
                expect(response.status, label).toBe(role === 'anonymous' ? 401 : 403)
              }
            }
            if (role === 'admin' || role === 'owner') {
              expect(upstream).toHaveLength(keywords.length)
              for (const [index, url] of upstream.entries()) {
                const parsed = new URL(url)
                expect(parsed.origin + parsed.pathname).toBe('https://api.chksz.com/api/163_search')
                expect(parsed.searchParams.get('keyword')).toBe(keywords[index])
              }
              expect(await audits()).toBe(keywords.length)
            } else {
              expect(upstream).toHaveLength(0)
              expect(await audits()).toBe(0)
            }
          } finally {
            vi.unstubAllGlobals()
          }
        },
      ),
      { numRuns: 15, endOnFailure: true },
    )
  })
})
