import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createAuthHandler } from '../auth/routes'
import { createAdminHandler, type AdminEnv } from '../admin/routes'
import { createProviderHandler } from '../providers/routes'
import type { D1PreparedStatement, D1WriteValue } from '../env'

const ORIGIN = 'https://study.example'
const NOW = 1_787_030_400_000
// Synthetic Jellyfin user context. Jellyfin 12 requires explicit user context on the item
// metadata route, so this is part of a complete Jellyfin configuration.
const JELLYFIN_USER_ID = '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f'

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

describe('Admin operations', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: AdminEnv

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `admin-${crypto.randomUUID()}` },
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
    }
  })

  afterEach(async () => {
    await miniflare.dispose()
  })

  const authenticatedCookie = async (role: 'user' | 'moderator' | 'admin' | 'owner') => {
    const userId = `${role}-user`
    await database.prepare(`
      INSERT INTO users (id, display_name, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(userId, role, role, NOW, NOW).run()
    const issued = await createAuthHandler(env, { now: () => NOW }).issueSession(userId)
    return `__Host-session=${issued.token}`
  }

  const request = (path: string, cookie?: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (cookie) headers.set('cookie', cookie)
    return new Request(`${ORIGIN}${path}`, { ...init, headers })
  }

  it.each([
    [undefined, 401],
    ['user', 403],
    ['moderator', 403],
  ] as const)('denies Admin overview to %s', async (role, status) => {
    const cookie = role ? await authenticatedCookie(role) : undefined
    const response = await createAdminHandler(env, { now: () => NOW }).fetch(request('/api/admin/overview', cookie))
    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it.each(['admin', 'owner'] as const)('allows %s to read operational status without secret values', async (role) => {
    await database.prepare(`
      UPDATE provider_health
      SET enabled = 1, priority = 10, status = 'healthy', failure_class = NULL,
        latency_ms = 40, checked_at = ?, updated_at = ?
      WHERE provider_key = 'chksz'
    `).bind(NOW, NOW).run()
    const cookie = await authenticatedCookie(role)
    const response = await createAdminHandler(env, { now: () => NOW }).fetch(request('/api/admin/overview', cookie))
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'chksz',
        adminEnabled: true,
        deploymentAvailable: true,
        effectiveEnabled: true,
        automaticPolicy: 'direct',
        ownerKeyConfigured: false,
        ownerFallbackEnabled: false,
        ownerFallbackUsable: false,
      }),
      expect.objectContaining({
        key: 'lx',
        adminEnabled: true,
        deploymentAvailable: true,
        effectiveEnabled: true,
        automaticPolicy: 'direct',
      }),
      expect.objectContaining({
        key: 'jellyfin',
        adminEnabled: true,
        deploymentAvailable: false,
        effectiveEnabled: false,
        automaticPolicy: 'direct',
      }),
    ]))
    expect(JSON.stringify(body)).not.toContain('public-meting')
    expect(JSON.stringify(body)).not.toContain('meting-agent')
    expect(JSON.stringify(body)).not.toMatch(/secret|access[_-]?token|refresh[_-]?token|rawIp|temporaryUrl/i)
  })

  it('exposes exactly [chksz, lx, jellyfin] in priority order with default priorities 10, 20, 30', async () => {
    await database.prepare('DELETE FROM provider_health').run()
    const cookie = await authenticatedCookie('admin')
    const adminHandler = createAdminHandler(env, { now: () => NOW })
    const providerHandler = createProviderHandler(env, { now: () => NOW })

    const overviewRes = await adminHandler.fetch(request('/api/admin/overview', cookie))
    expect(overviewRes.status).toBe(200)
    const overviewBody = await overviewRes.json() as { providers: Array<{ key: string; priority: number; deploymentAvailable: boolean }> }
    expect(overviewBody.providers.map((p) => p.key)).toEqual(['chksz', 'lx', 'jellyfin'])
    expect(overviewBody.providers.map((p) => p.priority)).toEqual([10, 20, 30])
    expect(overviewBody.providers.find((p) => p.key === 'chksz')?.deploymentAvailable).toBe(true)
    expect(overviewBody.providers.find((p) => p.key === 'lx')?.deploymentAvailable).toBe(true)
    expect(overviewBody.providers.find((p) => p.key === 'jellyfin')?.deploymentAvailable).toBe(false)

    const configRes = await providerHandler.fetch(request('/api/providers/config'))
    expect(configRes.status).toBe(200)
    const configBody = await configRes.json() as { providers: Array<{ id: string; priority: number; available: boolean }> }
    expect(configBody.providers.map((p) => p.id)).toEqual(['chksz', 'lx', 'jellyfin'])
    expect(configBody.providers.map((p) => p.priority)).toEqual([10, 20, 30])
    expect(configBody.providers.find((p) => p.id === 'chksz')?.available).toBe(true)
    expect(configBody.providers.find((p) => p.id === 'lx')?.available).toBe(true)
    expect(configBody.providers.find((p) => p.id === 'jellyfin')?.available).toBe(false)
  })

  it('reflects deployment configuration for Jellyfin availability while LX remains client-available', async () => {
    await database.prepare('DELETE FROM provider_health').run()
    const cookie = await authenticatedCookie('admin')
    const jellyfinEnv = {
      ...env,
      JELLYFIN_BASE_URL: 'https://jellyfin.example',
      JELLYFIN_API_TOKEN: 'valid-token',
      JELLYFIN_USER_ID,
    }
    const adminHandler = createAdminHandler(jellyfinEnv, { now: () => NOW })
    const providerHandler = createProviderHandler(jellyfinEnv, { now: () => NOW })

    const overviewRes = await adminHandler.fetch(request('/api/admin/overview', cookie))
    const overviewBody = await overviewRes.json() as { providers: Array<{ key: string; deploymentAvailable: boolean }> }
    expect(overviewBody.providers.find((p) => p.key === 'jellyfin')?.deploymentAvailable).toBe(true)
    expect(overviewBody.providers.find((p) => p.key === 'lx')?.deploymentAvailable).toBe(true)

    const configRes = await providerHandler.fetch(request('/api/providers/config'))
    const configBody = await configRes.json() as { providers: Array<{ id: string; available: boolean }> }
    expect(configBody.providers.find((p) => p.id === 'jellyfin')?.available).toBe(true)
    expect(configBody.providers.find((p) => p.id === 'lx')?.available).toBe(true)
  })

  describe('PUT /api/admin/providers/order', () => {
    const orderRequest = (body: unknown, cookie?: string, origin: string | null = ORIGIN) => request(
      '/api/admin/providers/order',
      cookie,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify(body),
      },
    )

    it('updates priorities to 10, 20, 30 and records audit event provider.order.update for valid order', async () => {
      await database.prepare('DELETE FROM provider_health').run()
      const cookie = await authenticatedCookie('owner')
      const handler = createAdminHandler(env, { now: () => NOW })

      const res = await handler.fetch(orderRequest({ providerIds: ['jellyfin', 'chksz', 'lx'] }, cookie))
      expect(res.status).toBe(200)
      const body = await res.json() as { providers: Array<{ key: string; priority: number }> }
      expect(body.providers.map((p) => p.key)).toEqual(['jellyfin', 'chksz', 'lx'])
      expect(body.providers.map((p) => p.priority)).toEqual([10, 20, 30])

      const rows = await database.prepare(`
        SELECT provider_key AS providerKey, priority
        FROM provider_health
        WHERE provider_key IN ('chksz', 'lx', 'jellyfin')
        ORDER BY priority ASC
      `).all<{ providerKey: string; priority: number }>()
      expect(rows.results).toEqual([
        { providerKey: 'jellyfin', priority: 10 },
        { providerKey: 'chksz', priority: 20 },
        { providerKey: 'lx', priority: 30 },
      ])

      const audits = await database.prepare(`
        SELECT action, target_key AS targetKey, detail_json AS detailJson
        FROM admin_audit_log
        WHERE action = 'provider.order.update'
      `).all<{ action: string; targetKey: string; detailJson: string }>()
      expect(audits.results).toHaveLength(1)
      expect(audits.results[0]).toEqual({
        action: 'provider.order.update',
        targetKey: 'providers',
        detailJson: JSON.stringify({ providerIds: ['jellyfin', 'chksz', 'lx'] }),
      })

      const overviewRes = await handler.fetch(request('/api/admin/overview', cookie))
      const overviewBody = await overviewRes.json() as { providers: Array<{ key: string; priority: number }> }
      expect(overviewBody.providers.map((p) => p.key)).toEqual(['jellyfin', 'chksz', 'lx'])
      expect(overviewBody.providers.map((p) => p.priority)).toEqual([10, 20, 30])

      const providerHandler = createProviderHandler(env, { now: () => NOW })
      const configRes = await providerHandler.fetch(request('/api/providers/config'))
      const configBody = await configRes.json() as { providers: Array<{ id: string; priority: number }> }
      expect(configBody.providers.map((p) => p.id)).toEqual(['jellyfin', 'chksz', 'lx'])
      expect(configBody.providers.map((p) => p.priority)).toEqual([10, 20, 30])
    })

    it('rejects invalid orders with HTTP 400', async () => {
      const cookie = await authenticatedCookie('admin')
      const handler = createAdminHandler(env, { now: () => NOW })

      const invalidBodies = [
        { providerIds: ['chksz', 'lx', 'lx'] },
        { providerIds: ['chksz', 'lx'] },
        { providerIds: ['chksz', 'lx', 'meting'] },
        { providerIds: ['chksz', 'lx', 'jellyfin', 'meting'] },
        { providerIds: 'chksz,lx,jellyfin' },
        { providerIds: 123 },
        { providerIds: [] },
        { providerIds: ['chksz', 'lx', 'jellyfin', 'chksz'] },
        {},
        { other: ['chksz', 'lx', 'jellyfin'] },
      ]

      for (const body of invalidBodies) {
        const res = await handler.fetch(orderRequest(body, cookie))
        expect(res.status, `Expected 400 for ${JSON.stringify(body)}`).toBe(400)
      }
    })

    it('rejects non-admin roles and invalid mutation origins', async () => {
      const user = await authenticatedCookie('user')
      const admin = await authenticatedCookie('admin')
      const handler = createAdminHandler(env, { now: () => NOW })
      const validPayload = { providerIds: ['chksz', 'lx', 'jellyfin'] }

      expect((await handler.fetch(orderRequest(validPayload, user))).status).toBe(403)
      expect((await handler.fetch(request('/api/admin/providers/order', undefined, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify(validPayload),
      }))).status).toBe(401)
      expect((await handler.fetch(orderRequest(validPayload, admin, null))).status).toBe(403)
      expect((await handler.fetch(orderRequest(validPayload, admin, 'https://evil.example'))).status).toBe(403)
    })
  })

  it('treats missing or malformed ChKSz Owner fallback settings as OFF', async () => {
    const cookie = await authenticatedCookie('admin')
    const handler = createAdminHandler({ ...env, CHKSZ_API_KEY: 'OWNER_KEY_SENTINEL' }, { now: () => NOW })

    const missing = await handler.fetch(request('/api/admin/overview', cookie))
    expect((await missing.json() as { providers: Array<Record<string, unknown>> }).providers
      .find(({ key }) => key === 'chksz')).toMatchObject({
        ownerKeyConfigured: true,
        ownerFallbackEnabled: false,
        ownerFallbackUsable: false,
      })

    await database.prepare(`
      INSERT INTO admin_settings (setting_key, setting_json, updated_by, updated_at)
      VALUES ('provider.chksz.ownerKeyFallback', '{"enabled":"yes"}', NULL, ?)
    `).bind(NOW).run()
    const malformed = await handler.fetch(request('/api/admin/overview', cookie))
    const body = await malformed.json() as { providers: Array<Record<string, unknown>> }
    expect(body.providers.find(({ key }) => key === 'chksz')).toMatchObject({
      ownerKeyConfigured: true,
      ownerFallbackEnabled: false,
      ownerFallbackUsable: false,
    })
    expect(JSON.stringify(body)).not.toContain('OWNER_KEY_SENTINEL')
  })

  it.each(['admin', 'owner'] as const)('lets %s update ChKSz Owner fallback with an immutable safe audit', async (role) => {
    const cookie = await authenticatedCookie(role)
    const response = await createAdminHandler({ ...env, CHKSZ_API_KEY: 'OWNER_KEY_SENTINEL' }, { now: () => NOW })
      .fetch(request('/api/admin/providers/chksz/owner-fallback', cookie, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ enabled: true }),
      }))

    expect(response.status).toBe(200)
    const responseText = await response.text()
    expect(JSON.parse(responseText)).toEqual({
      ownerKeyConfigured: true,
      ownerFallbackEnabled: true,
      ownerFallbackUsable: true,
    })
    expect(await database.prepare(`
      SELECT setting_json AS settingJson, updated_by AS updatedBy
      FROM admin_settings WHERE setting_key = 'provider.chksz.ownerKeyFallback'
    `).first()).toEqual({ settingJson: '{"enabled":true}', updatedBy: `${role}-user` })
    const audits = await database.prepare(`
      SELECT action, target_key AS targetKey, detail_json AS detailJson
      FROM admin_audit_log
    `).all<{ action: string; targetKey: string; detailJson: string }>()
    expect(audits.results).toHaveLength(1)
    expect(audits.results[0]).toEqual({
      action: 'provider.chksz.owner-fallback.update',
      targetKey: 'provider:chksz',
      detailJson: '{"enabled":true}',
    })
    expect(responseText).not.toContain('OWNER_KEY_SENTINEL')
  })

  it('requires Admin authority, exact Origin, and an exact fallback mutation schema', async () => {
    const user = await authenticatedCookie('user')
    const admin = await authenticatedCookie('admin')
    const handler = createAdminHandler(env, { now: () => NOW })
    const mutation = (cookie: string, body: unknown, origin?: string) => handler.fetch(request(
      '/api/admin/providers/chksz/owner-fallback',
      cookie,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      },
    ))

    expect((await mutation(user, { enabled: true }, ORIGIN)).status).toBe(403)
    expect((await mutation(admin, { enabled: true })).status).toBe(403)
    expect((await mutation(admin, { enabled: true }, 'https://evil.example')).status).toBe(403)
    expect((await mutation(admin, { enabled: 'true' }, ORIGIN)).status).toBe(400)
    expect((await mutation(admin, { enabled: true, key: 'secret' }, ORIGIN)).status).toBe(400)
    expect(await database.prepare(`
      SELECT COUNT(*) AS count FROM admin_settings
      WHERE setting_key = 'provider.chksz.ownerKeyFallback'
    `).first()).toEqual({ count: 0 })
  })

  it('rejects non-canonical providers, invalid priorities, and missing or wrong mutation origins', async () => {
    const cookie = await authenticatedCookie('admin')
    const handler = createAdminHandler(env, { now: () => NOW })
    const patch = (path: string, body: unknown, origin?: string) => request(path, cookie, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    })

    expect((await handler.fetch(patch('/api/admin/providers/not-real', { enabled: true }, ORIGIN))).status).toBe(404)
    expect((await handler.fetch(patch('/api/admin/providers/youtube', { enabled: true }, ORIGIN))).status).toBe(404)
    expect((await handler.fetch(patch('/api/admin/providers/meting', { enabled: true }, ORIGIN))).status).toBe(404)
    expect((await handler.fetch(patch('/api/admin/providers/chksz', { priority: -1 }, ORIGIN))).status).toBe(400)
    expect((await handler.fetch(patch('/api/admin/providers/chksz', { enabled: true }))).status).toBe(403)
    expect((await handler.fetch(patch('/api/admin/providers/chksz', { enabled: true }, 'https://evil.example'))).status).toBe(403)
  })

  it('updates a provider and writes a sanitised append-only audit row in the same mutation', async () => {
    const cookie = await authenticatedCookie('owner')
    const response = await createAdminHandler(env, { now: () => NOW }).fetch(request('/api/admin/providers/chksz', cookie, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ enabled: true, priority: 7 }),
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      provider: {
        key: 'chksz',
        adminEnabled: true,
        deploymentAvailable: true,
        effectiveEnabled: true,
        priority: 7,
      },
    })
    const row = await database.prepare('SELECT action, target_key AS targetKey, detail_json AS detailJson FROM admin_audit_log').first<{
      action: string
      targetKey: string
      detailJson: string
    }>()
    expect(row).toMatchObject({ action: 'provider.update', targetKey: 'provider:chksz' })
    expect(JSON.parse(row?.detailJson ?? '{}')).toEqual({ enabled: true, priority: 7 })
    expect(row?.detailJson).not.toMatch(/secret|token|ip|url/i)
  })

  it('handles an operator-configured Jellyfin provider without exposing its origin or token', async () => {
    const cookie = await authenticatedCookie('owner')
    const response = await createAdminHandler({
      ...env,
      JELLYFIN_BASE_URL: 'https://jellyfin.example',
      JELLYFIN_API_TOKEN: 'JELLYFIN_SECRET_TOKEN',
      JELLYFIN_USER_ID,
    }, { now: () => NOW }).fetch(request('/api/admin/providers/jellyfin', cookie, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ enabled: true, priority: 7 }),
    }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      provider: {
        key: 'jellyfin',
        adminEnabled: true,
        deploymentAvailable: true,
        effectiveEnabled: true,
        priority: 7,
      },
    })
    expect(JSON.stringify(body)).not.toContain('JELLYFIN_SECRET_TOKEN')
  })

  const seedProviders = async (enabledKeys: string[] = []) => {
    const keys = ['chksz', 'lx', 'jellyfin']
    await database.batch(keys.map((key) => database.prepare(`
      INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at)
      VALUES (?, ?, ?, 'unknown', ?)
      ON CONFLICT(provider_key) DO UPDATE SET
        enabled = excluded.enabled,
        priority = excluded.priority,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).bind(key, enabledKeys.includes(key) ? 1 : 0, key === 'chksz' ? 10 : key === 'lx' ? 20 : 30, NOW)))
  }

  const jellyfinAvailableEnv = () => ({
    ...env,
    JELLYFIN_BASE_URL: 'https://jellyfin.example',
    JELLYFIN_API_TOKEN: 'valid-token',
    JELLYFIN_USER_ID: JELLYFIN_USER_ID,
  })

  const providerPatch = (key: string, body: unknown, cookie = 'owner-cookie') => request(
    `/api/admin/providers/${key}`,
    cookie,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body),
    },
  )

  const readProviderState = async (key: string) => database.prepare(
    'SELECT enabled FROM provider_health WHERE provider_key = ?',
  ).bind(key).first<{ enabled: number }>()

  const readAuditRows = async () => database.prepare(`
    SELECT action, target_key AS targetKey, detail_json AS detailJson
    FROM admin_audit_log
    ORDER BY created_at DESC, id DESC
  `).all<{ action: string; targetKey: string; detailJson: string }>().then(
    (result: { results?: { action: string; targetKey: string; detailJson: string }[] }) => result.results ?? [],
  )

  const createProviderStateReadBarrier = () => {
    let stateReads = 0
    let releaseReads: (() => void) | undefined
    const bothReadsComplete = new Promise<void>((resolve) => {
      releaseReads = resolve
    })

    const wrapDatabase = (beforeBatch?: () => Promise<void>): AdminEnv['DB'] => ({
      prepare(sql: string) {
        const statement = database.prepare(sql)
        const isInitialProviderStateRead = stateReads < 2 &&
          sql.includes('provider_key AS providerKey') &&
          sql.includes('FROM provider_health') &&
          !sql.includes('WHERE provider_key = ?')
        if (!isInitialProviderStateRead) return statement

        return {
          ...statement,
          async all() {
            const result = await statement.all()
            stateReads += 1
            if (stateReads === 2) releaseReads?.()
            await bothReadsComplete
            return result
          },
        } as D1PreparedStatement
      },
      async batch(statements: D1PreparedStatement[]) {
        if (beforeBatch) await beforeBatch()
        return database.batch(statements)
      },
    } as AdminEnv['DB'])

    return { wrapDatabase, stateReadCount: () => stateReads }
  }

  it('disables a non-last provider without global shutdown confirmation', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz', 'lx'])
    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(providerPatch('chksz', { enabled: false }, owner))

    expect(response.status).toBe(200)
    expect(await readProviderState('chksz')).toEqual({ enabled: 0 })
    const audits = await readAuditRows()
    expect(audits[0]?.action).toBe('provider.update')
  })

  it.each([
    { label: 'ChKSz', key: 'chksz', enabledKeys: ['chksz', 'lx'], otherKey: 'lx', otherPriority: 20, jellyfinAvailable: false },
    { label: 'LX', key: 'lx', enabledKeys: ['chksz', 'lx'], otherKey: 'chksz', otherPriority: 10, jellyfinAvailable: false },
    { label: 'Jellyfin', key: 'jellyfin', enabledKeys: ['jellyfin', 'lx'], otherKey: 'lx', otherPriority: 20, jellyfinAvailable: true },
  ] as const)('propagates a successful $label disable through persisted and public provider state', async ({
    key,
    enabledKeys,
    otherKey,
    otherPriority,
    jellyfinAvailable,
  }) => {
    const owner = await authenticatedCookie('owner')
    await seedProviders([...enabledKeys])
    const routeEnv = jellyfinAvailable ? jellyfinAvailableEnv() : env
    const response = await createAdminHandler(routeEnv, { now: () => NOW })
      .fetch(providerPatch(key, { enabled: false }, owner))

    expect(response.status).toBe(200)
    expect(await database.prepare(
      'SELECT enabled, priority FROM provider_health WHERE provider_key = ?',
    ).bind(key).first()).toEqual({ enabled: 0, priority: key === 'chksz' ? 10 : key === 'lx' ? 20 : 30 })
    expect(await database.prepare(
      'SELECT enabled, priority FROM provider_health WHERE provider_key = ?',
    ).bind(otherKey).first()).toEqual({ enabled: 1, priority: otherPriority })
    expect((await readAuditRows()).map((row: { action: string }) => row.action)).toEqual(['provider.update'])

    const configResponse = await createProviderHandler(routeEnv, { now: () => NOW })
      .fetch(request('/api/providers/config'))
    expect(configResponse.status).toBe(200)
    const config = await configResponse.json() as {
      providers: Array<{ id: string; available: boolean; enabled: boolean; priority: number }>
    }
    expect(config.providers.find((provider) => provider.id === key)).toMatchObject({
      id: key,
      available: true,
      enabled: false,
      priority: key === 'chksz' ? 10 : key === 'lx' ? 20 : 30,
    })
    expect(config.providers.find((provider) => provider.id === otherKey)).toMatchObject({
      id: otherKey,
      available: true,
      enabled: true,
      priority: otherPriority,
    })
  })

  it('returns a safe service-unavailable response when provider persistence fails', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz', 'lx'])
    const failingDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      async batch() {
        throw new Error('D1_ERROR 10042: quota exhausted; private SQL detail')
      },
    } as unknown as AdminEnv['DB']
    const response = await createAdminHandler({ ...env, DB: failingDatabase }, { now: () => NOW })
      .fetch(providerPatch('chksz', { enabled: false }, owner))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'provider_update_unavailable' })
    expect(await readProviderState('chksz')).toEqual({ enabled: 1 })
    expect(await readAuditRows()).toHaveLength(0)
  })

  it.each([
    ['without confirmation', { enabled: false }],
    ['with wrong confirmation', { enabled: false, confirmation: 'disable all playback', reason: 'maintenance' }],
    ['with an empty reason', { enabled: false, confirmation: 'DISABLE ALL PLAYBACK', reason: '' }],
    ['with a whitespace-only reason', { enabled: false, confirmation: 'DISABLE ALL PLAYBACK', reason: '   ' }],
    ['with an over-long reason', { enabled: false, confirmation: 'DISABLE ALL PLAYBACK', reason: 'x'.repeat(501) }],
  ] as const)('rejects disabling the last provider %s', async (_label, body) => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz'])
    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(providerPatch('chksz', body, owner))

    expect(response.status).toBe(400)
    expect(await readProviderState('chksz')).toEqual({ enabled: 1 })
    expect(await readAuditRows()).toHaveLength(0)
  })

  it('allows disabling the last provider only with exact confirmation and a bounded internal reason', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz'])
    const response = await createAdminHandler(env, { now: () => NOW }).fetch(providerPatch('chksz', {
      enabled: false,
      confirmation: 'DISABLE ALL PLAYBACK',
      reason: '  scheduled maintenance  ',
    }, owner))

    expect(response.status).toBe(200)
    expect(await readProviderState('chksz')).toEqual({ enabled: 0 })
    const audits = await readAuditRows()
    expect(audits[0]).toMatchObject({ action: 'provider.disable_all', targetKey: 'provider:chksz' })
    expect(JSON.parse(audits[0]?.detailJson ?? '{}')).toMatchObject({
      enabled: false,
      globalPlaybackShutdown: true,
      reason: 'scheduled maintenance',
    })
  })

  it('does not count an unavailable Jellyfin row as last-provider protection', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz', 'jellyfin'])
    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(providerPatch('chksz', { enabled: false }, owner))

    expect(response.status).toBe(400)
    expect(await readProviderState('chksz')).toEqual({ enabled: 1 })
    expect(await readAuditRows()).toHaveLength(0)
  })

  it('counts an effective configured Jellyfin row as last-provider protection', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz', 'jellyfin'])
    const response = await createAdminHandler(jellyfinAvailableEnv(), { now: () => NOW })
      .fetch(providerPatch('chksz', { enabled: false }, owner))

    expect(response.status).toBe(200)
    expect(await readProviderState('chksz')).toEqual({ enabled: 0 })
    expect(await readProviderState('jellyfin')).toEqual({ enabled: 1 })
  })

  it('does not count an invalid configured Jellyfin row as last-provider protection', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz', 'jellyfin'])
    const response = await createAdminHandler({
      ...env,
      JELLYFIN_BASE_URL: 'https://jellyfin.internal',
    }, { now: () => NOW }).fetch(providerPatch('chksz', { enabled: false }, owner))

    expect(response.status).toBe(400)
    expect(await readProviderState('chksz')).toEqual({ enabled: 1 })
    expect(await readAuditRows()).toHaveLength(0)
  })

  it('allows an explicit confirmed transition to zero effective providers', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz'])
    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(providerPatch('chksz', {
        enabled: false,
        confirmation: 'DISABLE ALL PLAYBACK',
        reason: 'planned provider maintenance',
      }, owner))

    expect(response.status).toBe(200)
    expect(await readProviderState('chksz')).toEqual({ enabled: 0 })
    expect((await readAuditRows())[0]).toMatchObject({ action: 'provider.disable_all' })
  })

  it('rejects enabling an unavailable provider without changing state or audit', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders([])
    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(providerPatch('jellyfin', { enabled: true }, owner))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'provider_unavailable' })
    expect(await readProviderState('jellyfin')).toEqual({ enabled: 0 })
    expect(await readAuditRows()).toHaveLength(0)
  })

  it('enables Jellyfin once its complete operator configuration validates', async () => {
    const owner = await authenticatedCookie('owner')
    const handler = createAdminHandler(jellyfinAvailableEnv(), { now: () => NOW })

    const response = await handler.fetch(providerPatch('jellyfin', { enabled: true }, owner))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      provider: {
        key: 'jellyfin',
        adminEnabled: true,
        deploymentAvailable: true,
        effectiveEnabled: true,
      },
    })
    expect(JSON.stringify(await readAuditRows())).not.toMatch(/valid-token/)
  })

  it('refuses to enable Jellyfin when only part of its configuration is present', async () => {
    const owner = await authenticatedCookie('owner')
    for (const partialEnv of [
      { ...env, JELLYFIN_BASE_URL: 'https://jellyfin.example' },
      { ...env, JELLYFIN_API_TOKEN: 'token' },
      // Jellyfin 12 cannot resolve a metadata lookup without user context, so a deployment
      // holding only the base URL and token is still incomplete.
      { ...env, JELLYFIN_BASE_URL: 'https://jellyfin.example', JELLYFIN_API_TOKEN: 'token' },
    ]) {
      const handler = createAdminHandler(partialEnv, { now: () => NOW })
      const response = await handler.fetch(providerPatch('jellyfin', { enabled: true }, owner))
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'provider_unavailable' })
    }
  })

  it('does not audit an already-disabled provider as another global shutdown', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz'])
    const handler = createAdminHandler(env, { now: () => NOW })
    const body = {
      enabled: false,
      confirmation: 'DISABLE ALL PLAYBACK',
      reason: 'scheduled maintenance',
    }

    expect((await handler.fetch(providerPatch('chksz', body, owner))).status).toBe(200)
    const repeatedHandler = createAdminHandler(env, { now: () => NOW + 1 })
    expect((await repeatedHandler.fetch(providerPatch('chksz', body, owner))).status).toBe(200)

    const audits = await readAuditRows()
    expect(audits.map((row: { action: string }) => row.action)).toEqual(['provider.disable_all'])
  })

  it('does not let an enabled noncanonical provider row bypass last-provider protection', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz'])
    await database.prepare(`
      INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at)
      VALUES ('some-garbage-row', 1, 99, 'unknown', ?)
    `).bind(NOW).run()

    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(providerPatch('chksz', { enabled: false }, owner))

    expect(response.status).toBe(400)
    expect(await readProviderState('chksz')).toEqual({ enabled: 1 })
    expect(await readProviderState('some-garbage-row')).toEqual({ enabled: 1 })
    expect(await readAuditRows()).toHaveLength(0)
  })

  it('does not let a stale priority-only PATCH re-enable a concurrently disabled provider', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz'])
    const barrier = createProviderStateReadBarrier()
    let releasePriorityBatch: (() => void) | undefined
    const waitForShutdown = new Promise<void>((resolve) => {
      releasePriorityBatch = resolve
    })
    const priorityHandler = createAdminHandler({
      ...env,
      DB: barrier.wrapDatabase(() => waitForShutdown),
    }, { now: () => NOW + 1 })
    const shutdownHandler = createAdminHandler({
      ...env,
      DB: barrier.wrapDatabase(),
    }, { now: () => NOW })

    const priorityResponsePromise = priorityHandler.fetch(providerPatch('chksz', { priority: 9 }, owner))
    const shutdownResponse = await shutdownHandler.fetch(providerPatch('chksz', {
      enabled: false,
      confirmation: 'DISABLE ALL PLAYBACK',
      reason: 'planned provider maintenance',
    }, owner))
    releasePriorityBatch?.()
    const priorityResponse = await priorityResponsePromise
    const provider = await database.prepare(
      'SELECT enabled, priority FROM provider_health WHERE provider_key = ?',
    ).bind('chksz').first<{ enabled: number; priority: number }>()

    expect(barrier.stateReadCount()).toBeGreaterThanOrEqual(2)
    expect(shutdownResponse.status).toBe(200)
    expect(priorityResponse.status).toBe(200)
    expect(provider).toEqual({ enabled: 0, priority: 9 })
  })

  it('fails closed instead of writing enabled during a priority-only PATCH with a missing row', async () => {
    const owner = await authenticatedCookie('owner')
    await database.prepare('DELETE FROM provider_health WHERE provider_key = ?').bind('chksz').run()

    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(providerPatch('chksz', { priority: 9 }, owner))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'provider_update_failed' })
    expect(await database.prepare(
      'SELECT enabled, priority FROM provider_health WHERE provider_key = ?',
    ).bind('chksz').first()).toBeNull()
    expect(await readAuditRows()).toHaveLength(0)
  })

  it('audits only one truthful shutdown for concurrent confirmed disables of the same provider', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz'])
    const barrier = createProviderStateReadBarrier()
    const handler = createAdminHandler({ ...env, DB: barrier.wrapDatabase() }, { now: () => NOW })
    const body = {
      enabled: false,
      confirmation: 'DISABLE ALL PLAYBACK',
      reason: 'planned provider maintenance',
    }

    const responses = await Promise.all([
      handler.fetch(providerPatch('chksz', body, owner)),
      handler.fetch(providerPatch('chksz', body, owner)),
    ])
    const shutdownAudits = (await readAuditRows())
      .filter((row: { action: string }) => row.action === 'provider.disable_all')

    expect(barrier.stateReadCount()).toBeGreaterThanOrEqual(2)
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(await readProviderState('chksz')).toEqual({ enabled: 0 })
    expect(shutdownAudits).toHaveLength(1)
  })

  it('serializes stale-read concurrent provider disables so one effective provider remains enabled', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders(['chksz', 'lx'])
    const barrier = createProviderStateReadBarrier()
    const handler = createAdminHandler({
      ...env,
      DB: barrier.wrapDatabase(),
    }, { now: () => NOW })

    const [chkszResponse, lxResponse] = await Promise.all([
      handler.fetch(providerPatch('chksz', { enabled: false }, owner)),
      handler.fetch(providerPatch('lx', { enabled: false }, owner)),
    ])
    const statuses = [chkszResponse.status, lxResponse.status].sort()
    const enabledRows = await database.prepare(`
      SELECT provider_key AS providerKey
      FROM provider_health
      WHERE enabled = 1
        AND provider_key IN ('chksz', 'lx')
    `).all<{ providerKey: string }>()

    expect(barrier.stateReadCount()).toBeGreaterThanOrEqual(2)
    expect(statuses).toEqual([200, 400])
    expect((enabledRows.results ?? []).length).toBeGreaterThanOrEqual(1)
    const shutdownAudits = (await readAuditRows())
      .filter((row: { action: string }) => row.action === 'provider.disable_all')
    expect(shutdownAudits).toHaveLength(0)
  })

  it('continues to allow re-enabling a provider normally', async () => {
    const owner = await authenticatedCookie('owner')
    await seedProviders()
    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(providerPatch('chksz', { enabled: true }, owner))

    expect(response.status).toBe(200)
    expect(await readProviderState('chksz')).toEqual({ enabled: 1 })
    const audits = await readAuditRows()
    expect(audits[0]?.action).toBe('provider.update')
  })

  it('exports every initial Owner audit row without a 5000-row cap or duplicates', async () => {
    const owner = await authenticatedCookie('owner')
    const total = 5_001
    for (let start = 0; start < total; start += 15) {
      const count = Math.min(15, total - start)
      const statement = database.prepare(`
        INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
        VALUES ${Array.from({ length: count }, () => '(?, ?, ?, ?, ?, ?)').join(', ')}
      `)
      const binds = Array.from({ length: count }, (_, index) => {
        const created = start + index
        return [
          `audit-${created.toString().padStart(4, '0')}`,
          'owner-user',
          'test.action',
          `target:${created}`,
          JSON.stringify({ index: created }),
          NOW - created,
        ] as const
      }).flat()
      await statement.bind(...binds).run()
    }

    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(request('/api/admin/audit/export', owner))
    expect(response.status).toBe(200)
    const body = await response.json() as {
      entries: unknown[]
      total: number
      exportedCount?: number
      complete?: boolean
      snapshotComplete?: boolean
      consistency?: string
      truncated?: boolean
      limit?: number
    }
    const ids = (body.entries as { id: string }[]).map((entry) => entry.id)
    const createdAt = (body.entries as { createdAt: number }[]).map((entry) => entry.createdAt)

    expect(body.entries).toHaveLength(total)
    expect(body.total).toBe(total)
    expect(body.exportedCount).toBe(total)
    expect(body.complete).toBe(false)
    expect(body.snapshotComplete).toBe(false)
    expect(body.consistency).toBe('append-aware-keyset')
    expect(body.truncated).toBeUndefined()
    expect(body.limit).toBeUndefined()
    expect(new Set(ids).size).toBe(total)
    expect([...createdAt]).toEqual([...createdAt].sort((left, right) => right - left))
  }, 90_000)

  it('keeps deterministic keyset export semantics when an audit row is appended between pages', async () => {
    const owner = await authenticatedCookie('owner')
    const total = 2_001
    for (let start = 0; start < total; start += 15) {
      const count = Math.min(15, total - start)
      const statement = database.prepare(`
        INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
        VALUES ${Array.from({ length: count }, () => '(?, ?, ?, ?, ?, ?)').join(', ')}
      `)
      const binds = Array.from({ length: count }, (_, index) => {
        const created = start + index
        return [
          `concurrent-${created.toString().padStart(4, '0')}`,
          'owner-user',
          'test.action',
          `target:${created}`,
          '{}',
          NOW - created,
        ] as const
      }).flat()
      await statement.bind(...binds).run()
    }

    let orderedAuditReads = 0
    const appendingDatabase: AdminEnv['DB'] = {
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (!sql.includes('ORDER BY created_at DESC, id DESC')) return statement
        orderedAuditReads += 1
        if (orderedAuditReads !== 2) return statement
        const append = database.prepare(`
          INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
          VALUES ('concurrent-append', 'owner-user', 'test.action', 'target:append', '{}', ?)
        `).bind(NOW + 1).run()
        return {
          bind(...values: D1WriteValue[]) {
            const bound = statement.bind(...values)
            return {
              async all() {
                await append
                return bound.all()
              },
            } as unknown as ReturnType<D1PreparedStatement['bind']>
          },
        } as unknown as D1PreparedStatement
      },
      batch: database.batch.bind(database),
    } as AdminEnv['DB']
    const response = await createAdminHandler({ ...env, DB: appendingDatabase }, { now: () => NOW })
      .fetch(request('/api/admin/audit/export', owner))
    const body = await response.json() as {
      entries: { id: string; createdAt: number }[]
      total: number
      snapshotComplete?: boolean
    }
    const ids = body.entries.map((entry) => entry.id)

    expect(response.status).toBe(200)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('concurrent-0000')
    expect(ids).toContain('concurrent-2000')
    expect(body.snapshotComplete).toBe(false)
  })

  it('preserves export filters and keeps export Owner-only', async () => {
    const admin = await authenticatedCookie('admin')
    const owner = await authenticatedCookie('owner')
    const handler = createAdminHandler(env, { now: () => NOW })
    const seed = async (id: string, action: string, createdAt: number) => {
      await database.prepare(`
        INSERT INTO admin_audit_log (id, actor_user_id, action, target_key, detail_json, created_at)
        VALUES (?, 'owner-user', ?, ?, '{}', ?)
      `).bind(id, action, `target:${id}`, createdAt).run()
    }
    await seed('filtered-1', 'notice.publish', NOW - 1)
    await seed('filtered-2', 'provider.update', NOW - 2)
    await seed('filtered-3', 'notice.publish', NOW - 3)

    const denied = await handler.fetch(request('/api/admin/audit/export', admin))
    const allowed = await handler.fetch(request('/api/admin/audit/export?action=notice.publish', owner))
    const body = await allowed.json() as { entries: { id: string }[]; total: number }

    expect(denied.status).toBe(403)
    expect(allowed.status).toBe(200)
    expect(body.entries.map((entry) => entry.id)).toEqual(['filtered-1', 'filtered-3'])
    expect(body.total).toBe(2)
  })

  const createNotice = (cookie: string, body: unknown) =>
    createAdminHandler(env, { now: () => NOW }).fetch(request('/api/admin/notices', cookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body),
    }))

  it('creates, lists, publishes, and archives a multi-language notice with audit and revisions', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await createNotice(cookie, {
      severity: 'warning',
      targeting: 'everyone',
      content: { 'zh-Hant': '系統維護中', en: 'Maintenance in progress' },
      startAt: null,
      endAt: null,
    })
    expect(created.status).toBe(201)
    const createdBody = await created.json() as { notice: { id: string; status: string; content: Record<string, string> } }
    expect(createdBody.notice).toMatchObject({ status: 'draft', severity: 'warning', targeting: 'everyone' })
    expect(createdBody.notice.content).toEqual({ 'zh-Hant': '系統維護中', en: 'Maintenance in progress' })

    const list = await createAdminHandler(env, { now: () => NOW }).fetch(request('/api/admin/notices', cookie))
    expect(list.status).toBe(200)
    expect((await list.json() as { notices: unknown[] }).notices).toHaveLength(1)

    const noticeId = createdBody.notice.id
    const published = await createAdminHandler(env, { now: () => NOW }).fetch(
      request(`/api/admin/notices/${noticeId}/publish`, cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
      }),
    )
    expect(published.status).toBe(200)
    expect((await published.json() as { notice: { status: string } }).notice.status).toBe('published')

    const publicList = await createAdminHandler(env, { now: () => NOW }).fetch(request('/api/notices'))
    expect(publicList.status).toBe(200)
    const publicBody = await publicList.json() as { notices: { severity: string; content: Record<string, string> }[] }
    expect(publicBody.notices).toHaveLength(1)
    expect(publicBody.notices[0]).toMatchObject({ severity: 'warning' })
    expect(publicBody.notices[0].content).toEqual({ 'zh-Hant': '系統維護中', en: 'Maintenance in progress' })

    const archived = await createAdminHandler(env, { now: () => NOW }).fetch(
      request(`/api/admin/notices/${noticeId}/archive`, cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
      }),
    )
    expect(archived.status).toBe(200)
    expect((await archived.json() as { notice: { status: string } }).notice.status).toBe('archived')

    const audit = await database.prepare("SELECT detail_json AS detailJson FROM admin_audit_log WHERE action = 'notice.publish'").first<{ detailJson: string }>()
    expect(audit).toBeTruthy()
    expect(audit?.detailJson).not.toMatch(/secret|token|ip/i)
  })

  it('rejects republishing a published notice without resetting its timestamp or adding a fake audit', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await createNotice(cookie, {
      severity: 'info',
      targeting: 'everyone',
      content: { en: 'Already published' },
      startAt: null,
      endAt: null,
    })
    const noticeId = (await created.json() as { notice: { id: string } }).notice.id
    const action = (now: number, actionName: 'publish' | 'archive') =>
      createAdminHandler(env, { now: () => now }).fetch(
        request(`/api/admin/notices/${noticeId}/${actionName}`, cookie, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
        }),
      )

    expect((await action(NOW, 'publish')).status).toBe(200)
    const duplicate = await action(NOW + 1_000, 'publish')
    expect(duplicate.status).toBe(409)
    const row = await database.prepare(`
      SELECT published_at AS publishedAt
      FROM admin_notices
      WHERE id = ?
    `).bind(noticeId).first<{ publishedAt: number }>()
    const publishAudits = await database.prepare(`
      SELECT COUNT(*) AS count
      FROM admin_audit_log
      WHERE action = 'notice.publish' AND target_key = ?
    `).bind(`notice:${noticeId}`).first<{ count: number }>()

    expect(row).toEqual({ publishedAt: NOW })
    expect(publishAudits?.count).toBe(1)

    expect((await action(NOW + 2_000, 'archive')).status).toBe(200)
    expect((await action(NOW + 3_000, 'publish')).status).toBe(409)
  })

  it('rejects oversized and non-JSON admin bodies before mutation', async () => {
    const cookie = await authenticatedCookie('admin')
    const handler = createAdminHandler(env, { now: () => NOW })
    const validBody = JSON.stringify({ enabled: true, priority: 7 })

    const wrongMime = await handler.fetch(request('/api/admin/providers/chksz', cookie, {
      method: 'PATCH',
      headers: { 'content-type': 'application/jsonp', origin: ORIGIN },
      body: validBody,
    }))
    const oversized = await handler.fetch(request('/api/admin/providers/chksz', cookie, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: `${' '.repeat(70 * 1024)}${validBody}`,
    }))

    expect(wrongMime.status).toBe(400)
    expect(oversized.status).toBe(400)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').first<number>('count')).toBe(0)
  })

  it('rejects invalid notice bodies, missing content, and wrong mutation origin', async () => {
    const cookie = await authenticatedCookie('admin')
    const handler = createAdminHandler(env, { now: () => NOW })
    const post = (body: unknown, origin?: string) => request('/api/admin/notices', cookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    })
    expect((await handler.fetch(post({ severity: 'info', targeting: 'everyone', content: {}, startAt: null, endAt: null }, ORIGIN))).status).toBe(400)
    expect((await handler.fetch(post({ severity: 'bad', targeting: 'everyone', content: { en: 'hi' }, startAt: null, endAt: null }, ORIGIN))).status).toBe(400)
    expect((await handler.fetch(post({ severity: 'info', targeting: 'bad', content: { en: 'hi' }, startAt: null, endAt: null }, ORIGIN))).status).toBe(400)
    expect((await handler.fetch(post({ severity: 'info', targeting: 'everyone', content: { en: 'hi' }, startAt: null, endAt: null }))).status).toBe(403)
    expect((await handler.fetch(post({ severity: 'info', targeting: 'everyone', content: { en: 'hi' }, startAt: null, endAt: null }, 'https://evil.example'))).status).toBe(403)
  })

  it('denies public notice list to non-admin paths and overview without secrets', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await createNotice(cookie, { severity: 'critical', targeting: 'admin', content: { en: 'Admin only' }, startAt: null, endAt: null })
    const noticeId = (await created.json() as { notice: { id: string } }).notice.id
    await createAdminHandler(env, { now: () => NOW }).fetch(
      request(`/api/admin/notices/${noticeId}/publish`, cookie, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN } }),
    )

    const overview = await createAdminHandler(env, { now: () => NOW }).fetch(request('/api/admin/overview', cookie))
    const overviewBody = await overview.json() as Record<string, unknown>
    expect(overviewBody).toHaveProperty('activeNoticeCount')
    expect(overviewBody).not.toHaveProperty('notice')
    expect(JSON.stringify(overviewBody)).not.toMatch(/secret|access[_-]?token|refresh[_-]?token|rawIp|temporaryUrl/i)
  })

  const createPublishedNotice = async (
    cookie: string,
    targeting: 'everyone' | 'authenticated' | 'anonymous' | 'admin',
    schedule: { startAt?: number | null; endAt?: number | null; severity?: 'info' | 'warning' | 'critical' } = {},
  ) => {
    const created = await createNotice(cookie, {
      severity: schedule.severity ?? 'info',
      targeting,
      content: { en: `${targeting} notice` },
      startAt: schedule.startAt ?? null,
      endAt: schedule.endAt ?? null,
    })
    expect(created.status).toBe(201)
    const notice = (await created.json() as { notice: { id: string } }).notice
    const published = await createAdminHandler(env, { now: () => NOW }).fetch(
      request(`/api/admin/notices/${notice.id}/publish`, cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
      }),
    )
    expect(published.status).toBe(200)
    return notice.id
  }

  const publicNoticeIds = async (cookie?: string) => {
    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(request('/api/notices', cookie))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.json() as { notices: { id: string }[] }
    return body.notices.map((notice) => notice.id)
  }

  it.each([
    ['anonymous viewer', undefined, ['everyone', 'anonymous']],
    ['ordinary authenticated viewer', 'user', ['everyone', 'authenticated']],
    ['admin viewer', 'admin', ['everyone', 'authenticated', 'admin']],
    ['owner viewer', 'owner', ['everyone', 'authenticated', 'admin']],
  ] as const)('returns only targeted notices to %s', async (_label, role, expected) => {
    const adminCookie = await authenticatedCookie('admin')
    const ids = {
      everyone: await createPublishedNotice(adminCookie, 'everyone'),
      authenticated: await createPublishedNotice(adminCookie, 'authenticated'),
      anonymous: await createPublishedNotice(adminCookie, 'anonymous'),
      admin: await createPublishedNotice(adminCookie, 'admin'),
    }
    const cookie = role === 'admin' ? adminCookie : role ? await authenticatedCookie(role) : undefined
    const visible = await publicNoticeIds(cookie)

    expect(visible).toHaveLength(expected.length)
    expect(visible).toEqual(expect.arrayContaining(expected.map((targeting) => ids[targeting])))
  })

  it('fails safe to anonymous targeting when optional session lookup fails', async () => {
    const adminCookie = await authenticatedCookie('admin')
    const ids = {
      everyone: await createPublishedNotice(adminCookie, 'everyone'),
      authenticated: await createPublishedNotice(adminCookie, 'authenticated'),
      anonymous: await createPublishedNotice(adminCookie, 'anonymous'),
      admin: await createPublishedNotice(adminCookie, 'admin'),
    }
    const failingSessionDatabase: AdminEnv['DB'] = {
      prepare(sql: string) {
        if (sql.toUpperCase().includes('FROM SESSIONS')) throw new Error('session lookup unavailable')
        return database.prepare(sql)
      },
      batch: database.batch.bind(database),
    } as AdminEnv['DB']
    const visible = await publicNoticeIds()
    const safeHandler = createAdminHandler({ ...env, DB: failingSessionDatabase }, { now: () => NOW })
    const response = await safeHandler.fetch(request('/api/notices', adminCookie))
    const body = await response.json() as { notices: { id: string }[] }

    expect(response.status).toBe(200)
    expect(body.notices.map((notice) => notice.id)).toEqual(expect.arrayContaining([ids.everyone, ids.anonymous]))
    expect(body.notices).toHaveLength(2)
    expect(visible).toEqual(expect.arrayContaining([ids.everyone, ids.anonymous]))
    expect(visible).toHaveLength(2)
  })

  it('keeps public notice schedule filtering and severity ordering', async () => {
    const adminCookie = await authenticatedCookie('admin')
    await createPublishedNotice(adminCookie, 'everyone', { severity: 'warning' })
    await createPublishedNotice(adminCookie, 'everyone', { severity: 'critical' })
    await createPublishedNotice(adminCookie, 'everyone', { severity: 'info' })
    await createPublishedNotice(adminCookie, 'everyone', { startAt: NOW + 1 })
    await createPublishedNotice(adminCookie, 'everyone', { endAt: NOW - 1 })

    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(request('/api/notices'))
    const body = await response.json() as { notices: { severity: string }[] }

    expect(body.notices.map((notice) => notice.severity)).toEqual(['critical', 'warning', 'info'])
  })

  it('counts only currently active published notices in Admin overview', async () => {
    const cookie = await authenticatedCookie('admin')
    const create = async (body: Record<string, unknown>) => {
      const response = await createNotice(cookie, {
        severity: 'info',
        targeting: 'everyone',
        content: { en: 'notice' },
        ...body,
      })
      expect(response.status).toBe(201)
      return (await response.json() as { notice: { id: string } }).notice.id
    }
    const noticeAction = async (id: string, action: 'publish' | 'archive') => {
      const response = await createAdminHandler(env, { now: () => NOW }).fetch(
        request(`/api/admin/notices/${id}/${action}`, cookie, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
        }),
      )
      expect(response.status).toBe(200)
    }
    await create({ startAt: null, endAt: null })
    const future = await create({ startAt: NOW + 1, endAt: null })
    const expired = await create({ startAt: null, endAt: NOW - 1 })
    const active = await create({ startAt: null, endAt: null })
    const openEnded = await create({ startAt: null, endAt: null })
    const archived = await create({ startAt: null, endAt: null })
    await noticeAction(future, 'publish')
    await noticeAction(expired, 'publish')
    await noticeAction(active, 'publish')
    await noticeAction(openEnded, 'publish')
    await noticeAction(archived, 'publish')
    await noticeAction(archived, 'archive')

    const response = await createAdminHandler(env, { now: () => NOW })
      .fetch(request('/api/admin/overview', cookie))
    const body = await response.json() as { activeNoticeCount: number }

    expect(body.activeNoticeCount).toBe(2)
  })

  it('exposes a stable non-sensitive revision identity for revision-aware dismissal', async () => {
    const cookie = await authenticatedCookie('admin')
    const created = await createNotice(cookie, {
      severity: 'info',
      targeting: 'everyone',
      content: { en: 'first' },
      startAt: null,
      endAt: null,
    })
    const notice = (await created.json() as { notice: { id: string; revisionId?: string } }).notice
    expect(typeof notice.revisionId).toBe('string')
    expect(notice.revisionId).toMatch(/^[0-9a-f-]{36}$/i)

    await createAdminHandler(env, { now: () => NOW }).fetch(
      request(`/api/admin/notices/${notice.id}/publish`, cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
      }),
    )
    const publicResponse = await createAdminHandler(env, { now: () => NOW }).fetch(request('/api/notices'))
    const publicBody = await publicResponse.json() as { notices: { id: string; revisionId?: string }[] }

    expect(publicBody.notices).toHaveLength(1)
    expect(publicBody.notices[0]?.id).toBe(notice.id)
    expect(typeof publicBody.notices[0]?.revisionId).toBe('string')
    expect(JSON.stringify(publicBody)).not.toMatch(/session|oauth|token|secret/i)
  })

  it('advances notice revision identity for every material change but not identical patches', async () => {
    const cookie = await authenticatedCookie('admin')
    const handler = createAdminHandler(env, { now: () => NOW })
    const created = await createNotice(cookie, {
      severity: 'info',
      targeting: 'everyone',
      content: { en: 'first' },
      startAt: null,
      endAt: null,
    })
    const notice = (await created.json() as { notice: { id: string; revisionId: string } }).notice
    await handler.fetch(request(`/api/admin/notices/${notice.id}/publish`, cookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
    }))
    const patch = async (body: Record<string, unknown>) => {
      const response = await handler.fetch(request(`/api/admin/notices/${notice.id}`, cookie, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify(body),
      }))
      expect(response.status).toBe(200)
      return (await response.json() as { notice: { revisionId: string } }).notice.revisionId
    }
    const revisionIds = [notice.revisionId]

    revisionIds.push(await patch({ content: { en: 'second' } }))
    revisionIds.push(await patch({ severity: 'critical' }))
    revisionIds.push(await patch({ targeting: 'authenticated' }))
    revisionIds.push(await patch({ startAt: NOW - 100 }))
    revisionIds.push(await patch({ endAt: NOW + 1_000 }))

    expect(new Set(revisionIds).size).toBe(revisionIds.length)
    const unchangedRevisionId = await patch({
      severity: 'critical',
      targeting: 'authenticated',
      content: { en: 'second' },
      startAt: NOW - 100,
      endAt: NOW + 1_000,
    })
    expect(unchangedRevisionId).toBe(revisionIds.at(-1))
    const revisionCount = await database.prepare(`
      SELECT COUNT(*) AS count
      FROM admin_notice_revisions
      WHERE notice_id = ?
    `).bind(notice.id).first<{ count: number }>()
    expect(revisionCount?.count).toBe(revisionIds.length)

    const publicResponse = await handler.fetch(request('/api/notices', cookie))
    const publicBody = await publicResponse.json() as { notices: { id: string; revisionId: string }[] }
    expect(publicBody.notices[0]).toMatchObject({
      id: notice.id,
      revisionId: unchangedRevisionId,
    })
  })
})
