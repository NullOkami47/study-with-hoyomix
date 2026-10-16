import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuthHandler } from '../auth/routes'
import { createAdminHandler, type AdminEnv } from '../admin/routes'
import { ChkszAdminSearchRateLimiter } from '../providers/chkszSearchProxy'

const ORIGIN = 'https://study.example'
const NOW = 1_787_030_400_000
const OWNER_KEY = 'owner-key-sentinel-must-never-leak'

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const applyMigrations = async (database: TestDatabase) => {
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((v) => v.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(
      sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => database.prepare(s)),
    )
  }
}

const upstreamSearchBody = (songs: unknown[] = [], total: number | null = 0) => ({
  code: 200,
  msg: 'success',
  data: { songs, total },
})

const upstreamJson = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

describe('Admin ChKSz search proxy (owner-key, bounded)', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: AdminEnv

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `chksz-search-${crypto.randomUUID()}` },
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
      CHKSZ_API_KEY: OWNER_KEY,
    }
  })

  afterEach(async () => {
    await miniflare.dispose()
  })

  const authenticatedCookie = async (role: 'user' | 'admin' | 'owner') => {
    const userId = `${role}-user`
    await database.prepare(`
      INSERT INTO users (id, display_name, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, role, role, NOW, NOW).run()
    const issued = await createAuthHandler(env, { now: () => NOW }).issueSession(userId)
    return `__Host-session=${issued.token}`
  }

  const enableOwnerFallback = async (userId: string | null = null) => {
    await database.prepare(`
      INSERT INTO admin_settings (setting_key, setting_json, updated_by, updated_at)
      VALUES ('provider.chksz.ownerKeyFallback', '{"enabled":true}', ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_json = excluded.setting_json
    `).bind(userId, NOW).run()
  }

  const searchRequest = (
    body: unknown,
    cookie?: string,
    init: RequestInit = {},
  ) => {
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    headers.set('origin', ORIGIN)
    if (cookie) headers.set('cookie', cookie)
    return new Request(`${ORIGIN}/api/admin/providers/chksz/search`, {
      ...init,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  }

  const handlerWithFetch = (fetchImpl: typeof fetch, limiter?: ChkszAdminSearchRateLimiter) =>
    createAdminHandler(env, { now: () => NOW, fetch: fetchImpl, chkszSearchLimiter: limiter })

  it('denies unauthenticated and non-admin callers', async () => {
    const fetchImpl = async () => upstreamJson(upstreamSearchBody())
    const handler = handlerWithFetch(fetchImpl as typeof fetch)
    expect((await handler.fetch(searchRequest({ keyword: 'test' }))).status).toBe(401)
    const userCookie = await authenticatedCookie('user')
    expect((await handler.fetch(searchRequest({ keyword: 'test' }, userCookie))).status).toBe(403)
  })

  it('rejects wrong method and wrong origin', async () => {
    const fetchImpl = async () => upstreamJson(upstreamSearchBody())
    const adminCookie = await authenticatedCookie('admin')
    const handler = handlerWithFetch(fetchImpl as typeof fetch)
    const getReq = new Request(`${ORIGIN}/api/admin/providers/chksz/search`, {
      method: 'GET',
      headers: { cookie: adminCookie },
    })
    // GET is not a mutation so the origin guard does not apply; the route itself rejects it.
    expect((await handler.fetch(getReq)).status).toBe(405)
    const badOrigin = new Request(`${ORIGIN}/api/admin/providers/chksz/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: adminCookie },
      body: JSON.stringify({ keyword: 'test' }),
    })
    expect((await handler.fetch(badOrigin)).status).toBe(403)
  })

  it('validates keyword/limit/offset bounds without coercion', async () => {
    const calls: string[] = []
    const fetchImpl = async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return upstreamJson(upstreamSearchBody())
    }
    await enableOwnerFallback()
    const adminCookie = await authenticatedCookie('admin')
    const handler = handlerWithFetch(fetchImpl as typeof fetch)
    for (const bad of [
      { keyword: '' },
      { keyword: '   ' },
      { keyword: 'x'.repeat(81) },
      { keyword: 'bad\u0000key' },
      { keyword: 'ok', limit: 0 },
      { keyword: 'ok', limit: 11 },
      { keyword: 'ok', limit: 1.5 },
      { keyword: 'ok', offset: -1 },
      { keyword: 'ok', offset: 201 },
      { keyword: 'ok', unexpected: 1 },
      { limit: 5 },
    ]) {
      const res = await handler.fetch(searchRequest(bad, adminCookie))
      expect(res.status).toBe(400)
    }
    expect(calls).toHaveLength(0)
  })

  it('requires owner key and explicit fallback opt-in', async () => {
    const fetchImpl = async () => upstreamJson(upstreamSearchBody())
    const adminCookie = await authenticatedCookie('admin')
    // Fallback disabled -> 503, no upstream call.
    let calls = 0
    const counting = async () => {
      calls += 1
      return upstreamJson(upstreamSearchBody())
    }
    const disabled = handlerWithFetch(counting as typeof fetch)
    expect((await disabled.fetch(searchRequest({ keyword: 'test' }, adminCookie))).status).toBe(503)
    expect(calls).toBe(0)
    // No key -> 503.
    await enableOwnerFallback()
    const noKeyEnv = { ...env, CHKSZ_API_KEY: '' }
    const noKeyHandler = createAdminHandler(noKeyEnv, { now: () => NOW, fetch: counting as typeof fetch })
    expect((await noKeyHandler.fetch(searchRequest({ keyword: 'test' }, adminCookie))).status).toBe(503)
    expect(calls).toBe(0)
    void fetchImpl
  })

  it('proxies to the fixed upstream destination and never reflects the key', async () => {
    await enableOwnerFallback()
    const adminCookie = await authenticatedCookie('admin')
    const seen: string[] = []
    const fetchImpl = async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return upstreamJson(upstreamSearchBody([
        { id: 1315196858, name: '海底', artists: '一支榴莲', album: '独', picUrl: '', duration: 234000 },
      ], 100))
    }
    const handler = handlerWithFetch(fetchImpl as typeof fetch)
    const res = await handler.fetch(searchRequest({ keyword: '海底', limit: 5 }, adminCookie))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body.durationUnit).toBe('live_verified_ms')
    expect(seen).toHaveLength(1)
    const url = new URL(seen[0]!)
    expect(url.origin + url.pathname).toBe('https://api.chksz.com/api/163_search')
    expect(url.searchParams.get('keyword')).toBe('海底')
    expect(url.searchParams.get('limit')).toBe('5')
    // Key travels upstream only; response and audit must not contain it.
    expect(JSON.stringify(body)).not.toContain(OWNER_KEY)
    const audit = await database.prepare(
      `SELECT detail_json AS detail FROM admin_audit_log WHERE action = 'provider.chksz.search' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ detail: string }>()
    expect(audit).not.toBeNull()
    expect(audit!.detail).not.toContain(OWNER_KEY)
    expect(audit!.detail).toContain('keywordLength')
  })

  it('enforces per-admin rate limiting with Retry-After', async () => {
    await enableOwnerFallback()
    const adminCookie = await authenticatedCookie('admin')
    const fetchImpl = async () => upstreamJson(upstreamSearchBody())
    const limiter = new ChkszAdminSearchRateLimiter(() => NOW, 2)
    const handler = handlerWithFetch(fetchImpl as typeof fetch, limiter)
    expect((await handler.fetch(searchRequest({ keyword: 'a' }, adminCookie))).status).toBe(200)
    expect((await handler.fetch(searchRequest({ keyword: 'b' }, adminCookie))).status).toBe(200)
    const limited = await handler.fetch(searchRequest({ keyword: 'c' }, adminCookie))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^[0-9]+$/)
    expect(JSON.stringify(await limited.json())).not.toContain(OWNER_KEY)
  })

  it('propagates upstream 429 and surfaces upstream failure without key material', async () => {
    await enableOwnerFallback()
    const adminCookie = await authenticatedCookie('admin')
    const limited = handlerWithFetch((async () =>
      new Response('{}', { status: 429, headers: { 'retry-after': '7' } })) as typeof fetch)
    const res = await limited.fetch(searchRequest({ keyword: 'test' }, adminCookie))
    expect(res.status).toBe(429)
    expect(JSON.stringify(await res.json())).not.toContain(OWNER_KEY)

    const failing = handlerWithFetch((async () =>
      upstreamJson({ code: 401, msg: 'apikey 无效或已失效' }, 401)) as typeof fetch)
    const res2 = await failing.fetch(searchRequest({ keyword: 'test' }, adminCookie))
    expect(res2.status).toBe(502)
    expect(JSON.stringify(await res2.json())).not.toContain(OWNER_KEY)
  })

  it('bounds the upstream body and maps timeout to 504', async () => {
    await enableOwnerFallback()
    const adminCookie = await authenticatedCookie('admin')
    const huge = handlerWithFetch((async () =>
      new Response(JSON.stringify({ code: 200, msg: 'x', data: { songs: [{ id: 1, name: 'x'.repeat(70000) }], total: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch)
    expect((await huge.fetch(searchRequest({ keyword: 'test' }, adminCookie))).status).toBe(502)

    const hanging = handlerWithFetch((async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise<void>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
      return upstreamJson(upstreamSearchBody())
    }) as typeof fetch)
    expect((await hanging.fetch(searchRequest({ keyword: 'test' }, adminCookie))).status).toBe(504)
  })
})
