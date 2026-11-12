import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import worker from '../index'
import { issueSession, SESSION_LIFETIME_MS } from '../auth/session'
import { createLibraryHandler, type LibraryEnv } from '../library/routes'

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

const request = (path: string, token?: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (token) headers.set('cookie', `__Host-session=${token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN)
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

describe('export and account deletion isolation', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: LibraryEnv
  let userAToken: string
  let userBToken: string

  beforeEach(async () => {
    // Sessions and direct Worker requests share a deterministic clock; real timers stay active.
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `export-delete-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    env = {
      DB: database as unknown as LibraryEnv['DB'],
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'export-delete-secret',
    }
    for (const id of ['user-a', 'user-b']) {
      await database.prepare(`
        INSERT INTO users (id, display_name, role, created_at, updated_at)
        VALUES (?, ?, 'user', ?, ?)
      `).bind(id, id, NOW, NOW).run()
      await database.prepare('INSERT INTO library_sync_state (user_id, revision) VALUES (?, 0)')
        .bind(id).run()
    }
    userAToken = (await issueSession(env.DB, 'user-a', env.SESSION_HMAC_SECRET, NOW, crypto)).token
    userBToken = (await issueSession(env.DB, 'user-b', env.SESSION_HMAC_SECRET, NOW, crypto)).token
  })

  afterEach(async () => {
    try { await miniflare.dispose() } finally { vi.restoreAllMocks() }
  })

  it('rejects an expired session before exporting account data', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW + SESSION_LIFETIME_MS + 1)
    const response = await worker.fetch(request('/api/export', userAToken), env as never)

    expect(response.status).toBe(401)
    expect(await database.prepare('SELECT COUNT(*) AS total FROM users').first<{ total: number }>())
      .toEqual({ total: 2 })
  })

  it('exports only the authenticated user data across all library tables', async () => {
    await database.prepare(`
      INSERT INTO favourites (user_id, track_id, created_at)
      VALUES ('user-a', 'fav-a', ?), ('user-b', 'fav-b', ?)
    `).bind(NOW, NOW).run()
    await database.prepare(`
      INSERT INTO playlists (id, user_id, name, visibility, created_at, updated_at)
      VALUES ('pl-a', 'user-a', 'Playlist A', 'private', ?, ?),
             ('pl-b', 'user-b', 'Playlist B', 'private', ?, ?)
    `).bind(NOW, NOW, NOW, NOW).run()
    await database.prepare(`
      INSERT INTO listening_history (id, user_id, track_id, played_at)
      VALUES ('hist-a', 'user-a', 'track-a', ?), ('hist-b', 'user-b', 'track-b', ?)
    `).bind(NOW, NOW).run()
    await database.prepare(`
      INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
      VALUES ('user-a', '["chksz"]', ?), ('user-b', '["lx"]', ?)
    `).bind(NOW, NOW).run()

    const responseA = await worker.fetch(request('/api/export', userAToken), env as never)
    const responseB = await worker.fetch(request('/api/export', userBToken), env as never)

    expect(responseA.status).toBe(200)
    expect(responseB.status).toBe(200)
    const exportA = await responseA.json()
    const exportB = await responseB.json()

    expect(exportA.favourites.map((f: { trackId: string }) => f.trackId)).toEqual(['fav-a'])
    expect(exportB.favourites.map((f: { trackId: string }) => f.trackId)).toEqual(['fav-b'])
    expect(exportA.playlists.map((p: { id: string }) => p.id)).toEqual(['pl-a'])
    expect(exportB.playlists.map((p: { id: string }) => p.id)).toEqual(['pl-b'])
    expect(exportA.providerPreferences.disabledProviderIds).toEqual(['chksz'])
    expect(exportB.providerPreferences.disabledProviderIds).toEqual(['lx'])

    expect(JSON.stringify(exportA)).not.toContain('user-b')
    expect(JSON.stringify(exportA)).not.toContain('fav-b')
    expect(JSON.stringify(exportA)).not.toContain('pl-b')
    expect(JSON.stringify(exportB)).not.toContain('user-a')
  })

  it('deletes only the authenticated user data and preserves other accounts', async () => {
    await database.prepare(`
      INSERT INTO favourites (user_id, track_id, created_at)
      VALUES ('user-a', 'fav-a', ?), ('user-b', 'fav-b', ?)
    `).bind(NOW, NOW).run()
    await database.prepare(`
      INSERT INTO playlists (id, user_id, name, visibility, created_at, updated_at)
      VALUES ('pl-a', 'user-a', 'Playlist A', 'private', ?, ?),
             ('pl-b', 'user-b', 'Playlist B', 'private', ?, ?)
    `).bind(NOW, NOW, NOW, NOW).run()
    await database.prepare(`
      INSERT INTO listening_history (id, user_id, track_id, played_at)
      VALUES ('hist-a', 'user-a', 'track-a', ?), ('hist-b', 'user-b', 'track-b', ?)
    `).bind(NOW, NOW).run()
    await database.prepare(`
      INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
      VALUES ('user-a', '["chksz"]', ?), ('user-b', '["piped"]', ?)
    `).bind(NOW, NOW).run()
    await database.prepare(`
      INSERT INTO focus_sessions (user_id, id, schema_version, started_at, ended_at, planned_focus_seconds, actual_focus_seconds, status, phase, created_at)
      VALUES ('user-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, ?, ?, 60, 60, 'completed', 'focus', ?),
             ('user-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1, ?, ?, 60, 60, 'completed', 'focus', ?)
    `).bind(NOW, NOW + 60000, NOW, NOW, NOW + 60000, NOW).run()
    await database.prepare(`
      INSERT INTO user_background_selections (user_id, selection_json, auto_rotate, interval_seconds, updated_at)
      VALUES ('user-a', '["bg-a"]', 1, 30, ?), ('user-b', '["bg-b"]', 1, 30, ?)
    `).bind(NOW, NOW).run()

    const response = await worker.fetch(
      request('/api/account/delete', userAToken, {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'DELETE' }),
      }),
      env as never,
    )

    expect(response.status).toBe(204)

    const userARemains = await database.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?')
      .bind('user-a').first<{ total: number }>()
    const userBRemains = await database.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?')
      .bind('user-b').first<{ total: number }>()
    expect(userARemains?.total).toBe(0)
    expect(userBRemains?.total).toBe(1)

    const tables = [
      'favourites', 'playlists', 'listening_history', 'user_provider_preferences',
      'focus_sessions', 'user_background_selections', 'sessions', 'library_sync_state',
    ]
    for (const table of tables) {
      const aCount = await database.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ?`)
        .bind('user-a').first<{ total: number }>()
      const bCount = await database.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ?`)
        .bind('user-b').first<{ total: number }>()
      expect(aCount?.total).toBe(0)
      expect(bCount?.total).toBeGreaterThan(0)
    }
  })

  it('rejects account deletion without the exact confirmation string', async () => {
    const noBody = await worker.fetch(
      request('/api/account/delete', userAToken, { method: 'POST', body: JSON.stringify({}) }),
      env as never,
    )
    const wrongConfirmation = await worker.fetch(
      request('/api/account/delete', userAToken, {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'delete' }),
      }),
      env as never,
    )

    expect(noBody.status).toBe(400)
    expect(wrongConfirmation.status).toBe(400)
    const userARemains = await database.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?')
      .bind('user-a').first<{ total: number }>()
    expect(userARemains?.total).toBe(1)
  })

  it('never leaks cross-user identifiers or data in exported JSON structure', async () => {
    await database.prepare(`
      INSERT INTO favourites (user_id, track_id, created_at)
      VALUES ('user-a', 'fav-a', ?), ('user-b', 'fav-b', ?)
    `).bind(NOW, NOW).run()

    const response = await worker.fetch(request('/api/export', userAToken), env as never)
    const exported = await response.json()
    const serialized = JSON.stringify(exported)

    expect(serialized).not.toContain('user-b')
    expect(serialized).not.toContain('fav-b')
  })

  // Wave G exploration (task 25). L-15 (D8 = stop emitting): the Worker has no avatar storage
  // binding, so deleting an account must not leave an outbox row that nothing will ever process.
  it('L-15: creates no account_deletion_events row when no avatar storage binding exists', async () => {
    await database.prepare('UPDATE users SET avatar_url = ? WHERE id = ?')
      .bind('avatars/user-a/avatar.webp', 'user-a').run()
    const response = await worker.fetch(request('/api/account/delete', userAToken, {
      method: 'POST', body: JSON.stringify({ confirmation: 'DELETE' }),
    }), env as never)
    expect(response.status).toBe(204)
    expect(await database.prepare('SELECT COUNT(*) AS total FROM users WHERE id = ?').bind('user-a').first('total')).toBe(0)
    expect(await database.prepare('SELECT COUNT(*) AS total FROM account_deletion_events').first('total')).toBe(0)
  })

  // L-15: `sessions.last_seen_at` is written during authentication, at most once per hour.
  it('L-15: records sessions.last_seen_at on authentication at most once per hour', async () => {
    const HOUR = 60 * 60 * 1000
    let clock = NOW + 2 * HOUR
    const handler = createLibraryHandler(env, { now: () => clock })
    const lastSeen = () => database.prepare('SELECT last_seen_at AS lastSeenAt FROM sessions WHERE user_id = ?')
      .bind('user-a').first<number>('lastSeenAt')
    expect(await lastSeen()).toBe(NOW)
    expect((await handler.fetch(request('/api/library', userAToken))).status).toBe(200)
    expect(await lastSeen()).toBe(NOW + 2 * HOUR)
    clock = NOW + 2 * HOUR + 59 * 60 * 1000
    expect((await handler.fetch(request('/api/library', userAToken))).status).toBe(200)
    expect(await lastSeen()).toBe(NOW + 2 * HOUR)
    clock = NOW + 3 * HOUR + 60 * 1000
    expect((await handler.fetch(request('/api/library', userAToken))).status).toBe(200)
    expect(await lastSeen()).toBe(NOW + 3 * HOUR + 60 * 1000)
  })

  // L-21 (D7 = delete content, include chat in the export).
  const seedChat = async () => {
    const now = Date.now()
    const expires = now + 29 * 24 * 60 * 60 * 1000
    await database.prepare(`
      INSERT INTO chat_messages (id, user_id, author_display_name, content, message_type, created_at, expires_at)
      VALUES ('chat-a', 'user-a', 'user-a', 'wave-g private message from a', 'text', ?, ?),
             ('chat-b', 'user-b', 'user-b', 'wave-g message from b', 'text', ?, ?)
    `).bind(now, expires, now, expires).run()
    await database.prepare(`
      INSERT INTO chat_message_versions (id, message_id, editor_user_id, original_content, created_at, expires_at)
      VALUES ('version-a', 'chat-a', 'user-a', 'wave-g earlier draft from a', ?, ?)
    `).bind(now, expires).run()
  }

  it('L-21: tombstones the deleted user chat content and edit history', async () => {
    await seedChat()
    const response = await worker.fetch(request('/api/account/delete', userAToken, {
      method: 'POST', body: JSON.stringify({ confirmation: 'DELETE' }),
    }), env as never)
    expect(response.status).toBe(204)
    const messages = (await database.prepare('SELECT content FROM chat_messages').all<{ content: string }>()).results
    const versions = (await database.prepare('SELECT original_content AS content FROM chat_message_versions').all<{ content: string }>()).results
    const retained = JSON.stringify([...messages, ...versions])
    expect(retained).not.toContain('private message from a')
    expect(retained).not.toContain('earlier draft from a')
    expect(retained).toContain('wave-g message from b')
  })

  it('L-21: includes the user own chat messages, and nobody else, in the export', async () => {
    await seedChat()
    const response = await worker.fetch(request('/api/export', userAToken), env as never)
    expect(response.status).toBe(200)
    const serialized = JSON.stringify(await response.json())
    expect(serialized).toContain('chat-a')
    expect(serialized).toContain('wave-g private message from a')
    expect(serialized).not.toContain('chat-b')
    expect(serialized).not.toContain('wave-g message from b')
  })
})
