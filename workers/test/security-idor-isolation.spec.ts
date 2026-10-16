import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { issueSession } from '../auth/session'
import type { Database } from '../db'
import worker from '../index'

const ORIGIN = 'https://study.example'
const NOW = 1_786_480_000_000

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

interface Env {
  DB: Database
  PUBLIC_ORIGIN: string
  SESSION_HMAC_SECRET: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
}

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

/**
 * IDOR and cross-user resource isolation.
 *
 * Structural invariant: no handler reads a caller-supplied user/owner/account
 * identifier from body, query, or path. Every operation scopes by the session
 * userId only. These cases pin that nothing leaks, mutates, or deletes across
 * the boundary, and that no spoofed field bypasses the session gate.
 */
describe('IDOR and cross-user resource isolation', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: Env
  let userAToken: string
  let userBToken: string

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `idor-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    env = {
      DB: database as unknown as Database,
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'idor-secret-value-for-tests',
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

  it('retires library merge even with a spoofed userId without changing either account', async () => {
    await database.prepare(`
      INSERT INTO favourites (user_id, track_id, created_at)
      VALUES ('user-a', 'track-owned-by-a', ?)
    `).bind(NOW).run()

    const response = await worker.fetch(
      request('/api/library/merge', userBToken, {
        method: 'POST',
        body: JSON.stringify({
          userId: 'user-a',
          favourites: { added: ['track-from-b'], removed: [] },
          playlists: [],
        }),
      }),
      env as never,
    )

    expect(response.status).toBe(410)
    const aFavourites = await database.prepare(
      'SELECT track_id FROM favourites WHERE user_id = ? ORDER BY track_id',
    ).bind('user-a').all<{ track_id: string }>()
    expect(aFavourites.results.map((row: { track_id: string }) => row.track_id)).toEqual([
      'track-owned-by-a',
    ])
    const bFavourites = await database.prepare(
      'SELECT track_id FROM favourites WHERE user_id = ?',
    ).bind('user-b').all()
    expect(bFavourites.results).toHaveLength(0)
  })

  it('scopes library reads by the session userId only', async () => {
    await database.prepare(`
      INSERT INTO favourites (user_id, track_id, created_at)
      VALUES ('user-a', 'track-a', ?), ('user-b', 'track-b', ?)
    `).bind(NOW, NOW).run()

    const response = await worker.fetch(request('/api/library', userAToken), env as never)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.favourites.map((f: { trackId: string }) => f.trackId)).toEqual(['track-a'])
  })

  it('retires listening history uploads even with a spoofed userId', async () => {
    const response = await worker.fetch(
      request('/api/history', userBToken, {
        method: 'POST',
        body: JSON.stringify({
          userId: 'user-a',
          trackId: 'spoofed-track',
          playedAt: NOW,
        }),
      }),
      env as never,
    )

    expect(response.status).toBe(410)
    const aHistory = await database.prepare(
      'SELECT COUNT(*) AS total FROM listening_history WHERE user_id = ?',
    ).bind('user-a').first<{ total: number }>()
    expect(aHistory?.total).toBe(0)
    expect(await database.prepare('SELECT COUNT(*) AS total FROM listening_history').first('total')).toBe(0)
  })

  it('scopes history reads by the session userId only', async () => {
    await database.prepare(`
      INSERT INTO listening_history (id, user_id, track_id, played_at)
      VALUES ('hist-a', 'user-a', 'track-a', ?), ('hist-b', 'user-b', 'track-b', ?)
    `).bind(NOW, NOW).run()

    const responseA = await worker.fetch(request('/api/history', userAToken), env as never)
    const responseB = await worker.fetch(request('/api/history', userBToken), env as never)

    expect(responseA.status).toBe(200)
    expect(responseB.status).toBe(200)
    const bodyA = await responseA.json()
    const bodyB = await responseB.json()
    expect(bodyA.recentHistory.map((entry: { trackId: string }) => entry.trackId)).toEqual(['track-a'])
    expect(bodyB.recentHistory.map((entry: { trackId: string }) => entry.trackId)).toEqual(['track-b'])
  })

  it('never clears history for another user via a spoofed userId in query', async () => {
    await database.prepare(`
      INSERT INTO listening_history (id, user_id, track_id, played_at)
      VALUES ('hist-a', 'user-a', 'track-a', ?), ('hist-b', 'user-b', 'track-b', ?)
    `).bind(NOW, NOW).run()

    const response = await worker.fetch(
      request('/api/history?userId=user-a', userBToken, { method: 'DELETE' }),
      env as never,
    )

    expect(response.status).toBeLessThan(500)
    const aHistory = await database.prepare(
      'SELECT COUNT(*) AS total FROM listening_history WHERE user_id = ?',
    ).bind('user-a').first<{ total: number }>()
    expect(aHistory?.total).toBe(1)
  })

  it('scopes provider preferences by the session userId only', async () => {
    await database.prepare(`
      INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
      VALUES ('user-a', '["chksz"]', ?), ('user-b', '["lx"]', ?)
    `).bind(NOW, NOW).run()

    const responseA = await worker.fetch(
      request('/api/account/provider-preferences', userAToken),
      env as never,
    )
    const responseB = await worker.fetch(
      request('/api/account/provider-preferences', userBToken),
      env as never,
    )

    expect(responseA.status).toBe(200)
    expect(responseB.status).toBe(200)
    expect(await responseA.json()).toEqual({ disabledProviderIds: ['chksz'] })
    expect(await responseB.json()).toEqual({ disabledProviderIds: ['lx'] })
  })

  it('never mutates provider preferences for another user via a spoofed userId', async () => {
    await database.prepare(`
      INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
      VALUES ('user-a', '["chksz"]', ?)
    `).bind(NOW).run()

    const response = await worker.fetch(
      request('/api/account/provider-preferences', userBToken, {
        method: 'PUT',
        body: JSON.stringify({ userId: 'user-a', disabledProviderIds: ['piped'] }),
      }),
      env as never,
    )

    expect([400, 422]).toContain(response.status)
    const aPrefs = await database.prepare(
      'SELECT disabled_provider_ids_json AS json FROM user_provider_preferences WHERE user_id = ?',
    ).bind('user-a').first<{ json: string }>()
    expect(aPrefs?.json).toBe('["chksz"]')
  })

  it('scopes focus sessions by the session userId only', async () => {
    await database.prepare(`
      INSERT INTO focus_sessions (user_id, id, schema_version, started_at, ended_at, planned_focus_seconds, actual_focus_seconds, status, phase, created_at)
      VALUES ('user-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, ?, ?, 60, 60, 'completed', 'focus', ?),
             ('user-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1, ?, ?, 120, 120, 'completed', 'focus', ?)
    `).bind(NOW - 60_000, NOW, NOW, NOW - 120_000, NOW, NOW).run()

    const responseA = await worker.fetch(
      request('/api/focus-sessions', userAToken),
      env as never,
    )
    const responseB = await worker.fetch(
      request('/api/focus-sessions', userBToken),
      env as never,
    )

    expect(responseA.status).toBe(200)
    expect(responseB.status).toBe(200)
    const bodyA = await responseA.json()
    const bodyB = await responseB.json()
    expect(bodyA.sessions).toHaveLength(1)
    expect(bodyB.sessions).toHaveLength(1)
    expect(bodyA.sessions[0].actualFocusSeconds).toBe(60)
    expect(bodyB.sessions[0].actualFocusSeconds).toBe(120)
  })

  it('never writes focus sessions for another user via a spoofed userId', async () => {
    const response = await worker.fetch(
      request('/api/focus-sessions', userBToken, {
        method: 'POST',
        body: JSON.stringify({
          userId: 'user-a',
          sessions: [{
            id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
            schemaVersion: 1,
            startedAt: NOW - 60_000,
            endedAt: NOW,
            plannedFocusSeconds: 60,
            actualFocusSeconds: 60,
            status: 'completed',
            phase: 'focus',
          }],
        }),
      }),
      env as never,
    )

    expect([400, 422]).toContain(response.status)
    const aFocus = await database.prepare(
      'SELECT COUNT(*) AS total FROM focus_sessions WHERE user_id = ?',
    ).bind('user-a').first<{ total: number }>()
    expect(aFocus?.total).toBe(0)
  })

  it('scopes background selection by the session userId only', async () => {
    await database.prepare(`
      INSERT INTO background_media (id, created_by, created_at, updated_at, status, published_at)
      VALUES ('bg-a', 'user-a', ?, ?, 'published', ?),
             ('bg-b', 'user-b', ?, ?, 'published', ?)
    `).bind(NOW, NOW, NOW, NOW, NOW, NOW).run()
    await database.prepare(`
      INSERT INTO user_background_selections (user_id, selection_json, auto_rotate, interval_seconds, updated_at)
      VALUES ('user-a', '["bg-a"]', 0, 30, ?), ('user-b', '["bg-b"]', 0, 30, ?)
    `).bind(NOW, NOW).run()

    const responseA = await worker.fetch(
      request('/api/account/background-selection', userAToken),
      env as never,
    )
    const responseB = await worker.fetch(
      request('/api/account/background-selection', userBToken),
      env as never,
    )

    expect(responseA.status).toBe(200)
    expect(responseB.status).toBe(200)
    const bodyA = await responseA.json()
    const bodyB = await responseB.json()
    expect(bodyA.selection.selectedIds).toEqual(['bg-a'])
    expect(bodyB.selection.selectedIds).toEqual(['bg-b'])
  })

  it('never mutates background selection for another user via a spoofed userId', async () => {
    await database.prepare(`
      INSERT INTO background_media (id, created_by, created_at, updated_at, status, published_at)
      VALUES ('bg-a', 'user-a', ?, ?, 'published', ?)
    `).bind(NOW, NOW, NOW).run()
    await database.prepare(`
      INSERT INTO user_background_selections (user_id, selection_json, auto_rotate, interval_seconds, updated_at)
      VALUES ('user-a', '["bg-a"]', 0, 30, ?)
    `).bind(NOW).run()

    const response = await worker.fetch(
      request('/api/account/background-selection', userBToken, {
        method: 'PUT',
        body: JSON.stringify({ userId: 'user-a', selection: [], autoRotate: false, intervalSeconds: 30 }),
      }),
      env as never,
    )

    expect([400, 422]).toContain(response.status)
    const aSelection = await database.prepare(
      'SELECT selection_json FROM user_background_selections WHERE user_id = ?',
    ).bind('user-a').first<{ selection_json: string }>()
    expect(aSelection?.selection_json).toBe('["bg-a"]')
  })
})
