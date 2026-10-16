import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import worker from '../index'
import { issueSession } from '../auth/session'
import type { LibraryEnv } from '../library/routes'

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
    await miniflare.dispose()
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
})
