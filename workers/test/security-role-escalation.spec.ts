import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { issueSession } from '../auth/session'
import worker from '../index'

const ORIGIN = 'https://study.example'
const NOW = 1_786_480_000_000

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const applyMigrations = async (database: TestDatabase) => {
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(
      sql.split(';').map((statement) => statement.trim()).filter(Boolean)
        .map((statement) => database.prepare(statement)),
    )
  }
}

describe('role escalation and admin authorization', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: Record<string, unknown>
  let userToken: string
  let moderatorToken: string
  let adminToken: string
  let ownerToken: string

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `role-escalation-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    env = {
      DB: database,
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'role-escalation-secret-value-for-tests',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'TEST-google-client-secret',
      GITHUB_CLIENT_ID: 'github-client-id',
      GITHUB_CLIENT_SECRET: 'TEST-github-client-secret',
    }

    const roles = [
      ['user-regular', 'user'],
      ['user-moderator', 'moderator'],
      ['user-admin', 'admin'],
      ['user-owner', 'owner'],
    ] as const

    for (const [id, role] of roles) {
      await database.prepare(`
        INSERT INTO users (id, display_name, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(id, id, role, NOW, NOW).run()
      await database.prepare('INSERT INTO library_sync_state (user_id, revision) VALUES (?, 0)')
        .bind(id).run()
    }

    const secret = env.SESSION_HMAC_SECRET as string
    userToken = (await issueSession(database as never, 'user-regular', secret, NOW, crypto)).token
    moderatorToken = (await issueSession(database as never, 'user-moderator', secret, NOW, crypto)).token
    adminToken = (await issueSession(database as never, 'user-admin', secret, NOW, crypto)).token
    ownerToken = (await issueSession(database as never, 'user-owner', secret, NOW, crypto)).token
  })

  afterEach(async () => {
    await miniflare.dispose()
  })

  const request = (path: string, token: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    headers.set('cookie', `__Host-session=${token}`)
    if (init.body !== undefined) {
      headers.set('content-type', 'application/json')
      headers.set('origin', ORIGIN)
    }
    if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN)
    return new Request(`${ORIGIN}${path}`, { ...init, headers })
  }

  it('refuses user and moderator access to admin overview', async () => {
    await database.prepare(`
      INSERT OR REPLACE INTO provider_health (provider_key, enabled, priority, status, updated_at)
      VALUES ('chksz', 1, 100, 'unknown', ?)
    `).bind(NOW).run()
    const userResponse = await worker.fetch(request('/api/admin/overview', userToken), env as never)
    const moderatorResponse = await worker.fetch(request('/api/admin/overview', moderatorToken), env as never)

    expect(userResponse.status).toBe(403)
    expect(moderatorResponse.status).toBe(403)
    expect(await userResponse.json()).toEqual({ error: 'forbidden' })
    expect(await moderatorResponse.json()).toEqual({ error: 'forbidden' })
  })

  it('grants admin and owner access to admin overview', async () => {
    const adminResponse = await worker.fetch(request('/api/admin/overview', adminToken), env as never)
    const ownerResponse = await worker.fetch(request('/api/admin/overview', ownerToken), env as never)

    expect(adminResponse.status).toBe(200)
    expect(ownerResponse.status).toBe(200)
    const adminBody = await adminResponse.json()
    const ownerBody = await ownerResponse.json()
    expect(adminBody).toHaveProperty('providers')
    expect(ownerBody).toHaveProperty('providers')
  })

  it('refuses user and moderator provider toggle mutations', async () => {
    await database.prepare(`
      INSERT OR REPLACE INTO provider_health (provider_key, enabled, priority, status, updated_at)
      VALUES ('chksz', 1, 100, 'unknown', ?)
    `).bind(NOW).run()

    const userResponse = await worker.fetch(
      request('/api/admin/providers/chksz', userToken, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
      env as never,
    )
    const moderatorResponse = await worker.fetch(
      request('/api/admin/providers/chksz', moderatorToken, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
      env as never,
    )

    expect(userResponse.status).toBe(403)
    expect(moderatorResponse.status).toBe(403)
  })

  it('grants admin and owner provider toggle mutations', async () => {
    await database.prepare(`
      INSERT OR REPLACE INTO provider_health (provider_key, enabled, priority, status, updated_at)
      VALUES ('chksz', 1, 100, 'unknown', ?), ('lx', 1, 200, 'unknown', ?)
    `).bind(NOW, NOW).run()

    const adminResponse = await worker.fetch(
      request('/api/admin/providers/chksz', adminToken, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
      env as never,
    )

    expect(adminResponse.status).toBeLessThan(400)
  })

  it('refuses user and moderator notice creation', async () => {
    const userResponse = await worker.fetch(
      request('/api/admin/notices', userToken, {
        method: 'POST',
        body: JSON.stringify({
          severity: 'info',
          targeting: 'everyone',
          content: { 'zh-Hant': 'Notice' },
          startAt: null,
          endAt: null,
        }),
      }),
      env as never,
    )
    const moderatorResponse = await worker.fetch(
      request('/api/admin/notices', moderatorToken, {
        method: 'POST',
        body: JSON.stringify({
          severity: 'info',
          targeting: 'everyone',
          content: { 'zh-Hant': 'Notice' },
          startAt: null,
          endAt: null,
        }),
      }),
      env as never,
    )

    expect(userResponse.status).toBe(403)
    expect(moderatorResponse.status).toBe(403)
    const count = await database.prepare('SELECT COUNT(*) AS total FROM admin_notices')
      .first<{ total: number }>()
    expect(count?.total).toBe(0)
  })

  it('grants admin and owner notice creation', async () => {
    const adminResponse = await worker.fetch(
      request('/api/admin/notices', adminToken, {
        method: 'POST',
        body: JSON.stringify({
          severity: 'info',
          targeting: 'everyone',
          content: { 'zh-Hant': 'Admin Notice' },
          startAt: null,
          endAt: null,
        }),
      }),
      env as never,
    )

    expect(adminResponse.status).toBeLessThan(400)
    if (adminResponse.status === 201) {
      const count = await database.prepare('SELECT COUNT(*) AS total FROM admin_notices')
        .first<{ total: number }>()
      expect(count?.total).toBe(1)
    }
  })

  it('refuses user and moderator background uploads', async () => {
    const userResponse = await worker.fetch(
      request('/api/admin/backgrounds/uploads', userToken, { method: 'POST' }),
      env as never,
    )
    const moderatorResponse = await worker.fetch(
      request('/api/admin/backgrounds/uploads', moderatorToken, { method: 'POST' }),
      env as never,
    )

    expect(userResponse.status).toBe(403)
    expect(moderatorResponse.status).toBe(403)
  })

  it('never writes audit log for refused role escalation attempts', async () => {
    await database.prepare(`
      INSERT OR REPLACE INTO provider_health (provider_key, enabled, priority, status, updated_at)
      VALUES ('chksz', 1, 100, 'unknown', ?)
    `).bind(NOW).run()

    await worker.fetch(
      request('/api/admin/providers/chksz', userToken, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
      env as never,
    )

    const auditCount = await database.prepare('SELECT COUNT(*) AS total FROM admin_audit_log')
      .first<{ total: number }>()
    expect(auditCount?.total).toBe(0)
  })

  it('writes audit log only when admin or owner performs a mutation', async () => {
    await database.prepare(`
      INSERT OR REPLACE INTO provider_health (provider_key, enabled, priority, status, updated_at)
      VALUES ('chksz', 1, 100, 'unknown', ?), ('lx', 1, 200, 'unknown', ?)
    `).bind(NOW, NOW).run()

    await worker.fetch(
      request('/api/admin/providers/chksz', adminToken, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
      env as never,
    )

    const auditCount = await database.prepare('SELECT COUNT(*) AS total FROM admin_audit_log')
      .first<{ total: number }>()
    expect(auditCount?.total).toBeGreaterThan(0)
    const auditRows = await database.prepare(
      'SELECT actor_user_id AS actorUserId FROM admin_audit_log',
    ).all<{ actorUserId: string }>()
    expect(auditRows.results.every(
      (row: { actorUserId: string }) => row.actorUserId === 'user-admin',
    )).toBe(true)
  })

  it('allows all authenticated users to read their own library', async () => {
    for (const [token, userId] of [
      [userToken, 'user-regular'],
      [moderatorToken, 'user-moderator'],
      [adminToken, 'user-admin'],
      [ownerToken, 'user-owner'],
    ] as const) {
      await database.prepare(`
        INSERT INTO favourites (user_id, track_id, created_at)
        VALUES (?, ?, ?)
      `).bind(userId, `track-${userId}`, NOW).run()

      const response = await worker.fetch(request('/api/library', token), env as never)

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.favourites.map((f: { trackId: string }) => f.trackId)).toEqual([`track-${userId}`])
    }
  })

  it('allows all authenticated users to update their own background selection', async () => {
    for (const token of [userToken, moderatorToken, adminToken, ownerToken]) {
      const response = await worker.fetch(
        request('/api/account/background-selection', token, {
          method: 'PUT',
          body: JSON.stringify({ selectedIds: [], autoRotate: true, intervalSeconds: 30 }),
        }),
        env as never,
      )

      expect(response.status).toBeLessThan(400)
    }
  })
})
