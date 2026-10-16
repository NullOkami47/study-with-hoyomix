import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { issueSession } from '../auth/session'
import { createLibraryHandler, type LibraryEnv } from '../library/routes'
import { LOCAL_LIBRARY_SCHEMA_VERSION, type LibraryExport } from '../../src/features/library/types'

const ORIGIN = 'https://study.example'
const NOW = 1_786_480_000_000
const NOW_ISO = new Date(NOW).toISOString()
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

const emptyLibrary = (): LibraryExport => ({
  schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
  favourites: [],
  playlists: [],
  preferences: { historyEnabled: false },
  recentHistory: [],
})

const request = (path: string, token?: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (token) headers.set('cookie', `__Host-session=${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN)
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

describe('cross-device library routes', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: LibraryEnv
  let tokenA: string
  let tokenB: string
  let avatarEvents: Array<{ type: string; userId: string; objectKey: string }>

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `library-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    env = {
      DB: database,
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'session-secret-with-at-least-thirty-two-characters',
    }
    await database.batch([
      database.prepare(`
        INSERT INTO users (id, display_name, avatar_url, role, avatar_upload_disabled, created_at, updated_at)
        VALUES (?, ?, ?, 'user', 0, ?, ?)
      `).bind('user-a', 'Alice', 'avatars/user-a/hash.webp', NOW, NOW),
      database.prepare(`
        INSERT INTO users (id, display_name, role, avatar_upload_disabled, created_at, updated_at)
        VALUES (?, ?, 'user', 0, ?, ?)
      `).bind('user-b', 'Bob', NOW, NOW),
    ])
    tokenA = (await issueSession(database, 'user-a', env.SESSION_HMAC_SECRET, NOW, crypto)).token
    tokenB = (await issueSession(database, 'user-b', env.SESSION_HMAC_SECRET, NOW, crypto)).token
    avatarEvents = []
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await miniflare.dispose()
  })

  const handler = () => createLibraryHandler(env, {
    now: () => NOW,
    emitAvatarDeletion: async (event) => { avatarEvents.push(event) },
  })

  it.each([
    ['GET', '/api/library'],
    ['POST', '/api/library/merge'],
    ['POST', '/api/history'],
    ['GET', '/api/export'],
    ['POST', '/api/account/delete'],
  ])('requires a valid site session for %s %s', async (method, path) => {
    const response = await handler().fetch(request(path, undefined, {
      method,
      body: method === 'GET' ? undefined : JSON.stringify({}),
    }))
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'authentication_required' })
  })

  it.each(['/api/library/merge', '/api/history'])('retires authenticated POST %s without changing either account', async (path) => {
    await database.batch([
      database.prepare('INSERT INTO favourites VALUES (?, ?, ?)').bind('user-a', 'retained-favourite', NOW),
      database.prepare('INSERT INTO listening_history VALUES (?, ?, ?, ?)').bind('retained-a', 'user-a', 'retained-track', NOW),
      database.prepare('INSERT INTO listening_history VALUES (?, ?, ?, ?)').bind('retained-b', 'user-b', 'bob-track', NOW),
    ])
    const beforeA = await handler().fetch(request('/api/library', tokenA)).then(response => response.json())
    const beforeB = await handler().fetch(request('/api/library', tokenB)).then(response => response.json())
    const library = { ...emptyLibrary(), favourites: [{ trackId: 'new-track', addedAt: NOW_ISO }] }
    const bodies = path === '/api/library/merge'
      ? [{ library }, { library, confirmationToken: `sha256:${'0'.repeat(64)}` }]
      : [{ id: 'new-history', trackId: 'new-track', playedAt: NOW_ISO }]
    for (const body of bodies) {
      const response = await handler().fetch(request(path, tokenA, { method: 'POST', body: JSON.stringify(body) }))
      expect(response.status).toBe(410)
      expect(await response.json()).toEqual({ error: 'account_library_sync_retired' })
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect(await handler().fetch(request('/api/library', tokenA)).then(result => result.json())).toEqual(beforeA)
    expect(await handler().fetch(request('/api/library', tokenB)).then(result => result.json())).toEqual(beforeB)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM library_sync_state').first('count')).toBe(0)
  })

  it.each(['/api/library/merge', '/api/history'])('checks Origin before returning retirement for POST %s', async (path) => {
    for (const origin of [null, 'https://attacker.example', `${ORIGIN}.attacker.example`]) {
      const headers = new Headers({ cookie: `__Host-session=${tokenA}` })
      if (origin) headers.set('origin', origin)
      const response = await handler().fetch(new Request(`${ORIGIN}${path}`, { method: 'POST', headers }))
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden_origin' })
    }
  })

  it('preserves historical reads and allows deleting only the authenticated account history', async () => {
    await database.batch([
      database.prepare('INSERT INTO listening_history VALUES (?, ?, ?, ?)').bind('history-a', 'user-a', 'track-a', NOW),
      database.prepare('INSERT INTO listening_history VALUES (?, ?, ?, ?)').bind('history-b', 'user-b', 'track-b', NOW),
    ])
    expect(await handler().fetch(request('/api/history', tokenA)).then(response => response.json()))
      .toEqual({ recentHistory: [{ id: 'history-a', trackId: 'track-a', playedAt: NOW_ISO }] })
    expect((await handler().fetch(request('/api/history', tokenA, { method: 'DELETE' }))).status).toBe(204)
    expect(await database.prepare('SELECT id FROM listening_history ORDER BY id').all())
      .toMatchObject({ results: [{ id: 'history-b' }] })
  })

  it('exports only favourites, private playlists, benign settings, and the account reports', async () => {
    await database.batch([
      database.prepare('INSERT INTO favourites VALUES (?, ?, ?)').bind('user-a', 'track-a', NOW),
      database.prepare('INSERT INTO listening_history VALUES (?, ?, ?, ?)').bind('history-secret', 'user-a', 'private-listening', NOW),
      database.prepare(`
        INSERT INTO catalog_reports (
          id, reporter_user_id, canonical_track_id, kind, current_value_json,
          proposed_value_json, note, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).bind('report-a', 'user-a', 'track-a', 'metadata', '{"title":"old"}', '{"title":"new"}', 'helpful note', NOW, NOW),
      database.prepare(`
        INSERT INTO chat_messages (id, room_id, user_id, author_display_name, content, message_type, created_at, expires_at)
        VALUES (?, 'global', ?, ?, ?, 'text', ?, ?)
      `).bind('message-a', 'user-a', 'Alice', 'private chat content', NOW, NOW + 1_000),
      database.prepare(`
        INSERT INTO focus_sessions (
          user_id, id, schema_version, started_at, ended_at,
          planned_focus_seconds, actual_focus_seconds, status, phase, created_at
        ) VALUES (?, ?, 1, ?, ?, 1500, 1500, 'completed', 'focus', ?)
      `).bind('user-a', '550e8400-e29b-41d4-a716-446655440000', NOW, NOW + 1_500_000, NOW + 1_500_000),
      database.prepare(`
        INSERT INTO focus_sessions (
          user_id, id, schema_version, started_at, ended_at,
          planned_focus_seconds, actual_focus_seconds, status, phase, created_at
        ) VALUES (?, ?, 1, ?, ?, 1500, 1500, 'completed', 'focus', ?)
      `).bind('user-b', '550e8400-e29b-41d4-a716-446655440009', NOW, NOW + 1_500_000, NOW + 1_500_000),
    ])
    const response = await handler().fetch(request('/api/export', tokenA))
    expect(response.status).toBe(200)
    const exported = await response.json() as Record<string, unknown>
    expect(exported).toEqual({
      schemaVersion: 1,
      favourites: [{ trackId: 'track-a', addedAt: NOW_ISO }],
      focusSessions: [{
        id: '550e8400-e29b-41d4-a716-446655440000',
        schemaVersion: 1,
        startedAt: NOW_ISO,
        endedAt: new Date(NOW + 1_500_000).toISOString(),
        plannedFocusSeconds: 1_500,
        actualFocusSeconds: 1_500,
        status: 'completed',
        phase: 'focus',
        createdAt: new Date(NOW + 1_500_000).toISOString(),
      }],
      playlists: [],
      preferences: { historyEnabled: false },
      providerPreferences: { disabledProviderIds: [] },
      userUiPreferences: null,
      backgroundSelection: null,
      reports: [expect.objectContaining({ id: 'report-a', note: 'helpful note' })],
    })
    const serialised = JSON.stringify(exported)
    for (const excluded of ['private-listening', 'history-secret', 'private chat content', 'avatars/user-a', '__Host-session', 'provider_subject', tokenA, '550e8400-e29b-41d4-a716-446655440009']) {
      expect(serialised).not.toContain(excluded)
    }
  })

  it('exports a stored provider preference without any credential or endpoint', async () => {
    await database.prepare(`
      INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
      VALUES (?, ?, ?)
    `).bind('user-a', JSON.stringify(['chksz', 'lx']), NOW).run()

    const response = await handler().fetch(request('/api/export', tokenA))
    const exported = await response.json() as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(exported.providerPreferences).toEqual({
      disabledProviderIds: ['chksz', 'lx'],
    })
    expect(JSON.stringify(exported)).not.toMatch(/x-request-key|apikey|api_key|MUSIC_U|priority/i)
  })

  it.each(['/api/library/merge', '/api/history'])('returns retirement without parsing bodies for POST %s', async (path) => {
    for (const [contentType, body] of [
      ['text/plain', 'not JSON'],
      ['application/json', '{'],
      ['application/json', JSON.stringify({ padding: '界'.repeat(2_000_000) })],
    ]) {
      const response = await handler().fetch(request(path, tokenA, {
        method: 'POST', headers: { 'content-type': contentType! }, body,
      }))
      expect(response.status).toBe(410)
    }
    expect(await database.prepare('SELECT COUNT(*) AS count FROM listening_history').first('count')).toBe(0)
    expect(await database.prepare('SELECT COUNT(*) AS count FROM library_sync_state').first('count')).toBe(0)
  })

  it('deletes identities, profile and library while anonymising chat and withdrawing pending reports', async () => {
    await database.batch([
      database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind('identity-a', 'user-a', 'github', '1234', NOW),
      database.prepare('INSERT INTO favourites VALUES (?, ?, ?)').bind('user-a', 'track-a', NOW),
      database.prepare(`
        INSERT INTO playlists (id, user_id, name, visibility, created_at, updated_at)
        VALUES ('playlist-a', 'user-a', 'Private', 'private', ?, ?)
      `).bind(NOW, NOW),
      database.prepare('INSERT INTO playlist_tracks VALUES (?, ?, ?, ?)').bind('playlist-a', 'track-a', 0, NOW),
      database.prepare('INSERT INTO listening_history VALUES (?, ?, ?, ?)').bind('history-a', 'user-a', 'track-a', NOW),
      database.prepare(`
        INSERT INTO focus_sessions (
          user_id, id, schema_version, started_at, ended_at,
          planned_focus_seconds, actual_focus_seconds, status, phase, created_at
        ) VALUES (?, ?, 1, ?, ?, 1500, 1500, 'completed', 'focus', ?)
      `).bind('user-a', '550e8400-e29b-41d4-a716-446655440000', NOW, NOW + 1_500_000, NOW + 1_500_000),
      database.prepare(`
        INSERT INTO chat_messages (id, room_id, user_id, author_display_name, content, message_type, created_at, expires_at)
        VALUES ('message-a', 'global', 'user-a', 'Alice', 'retained content', 'text', ?, ?)
      `).bind(NOW, NOW + 1_000),
      database.prepare(`
        INSERT INTO catalog_reports (
          id, reporter_user_id, canonical_track_id, kind, current_value_json,
          proposed_value_json, status, created_at, updated_at
        ) VALUES ('catalog-report-a', 'user-a', 'track-a', 'metadata', '{}', '{}', 'pending', ?, ?)
      `).bind(NOW, NOW),
      database.prepare(`
        INSERT INTO chat_reports (id, reporter_user_id, message_id, reason, status, created_at)
        VALUES ('chat-report-a', 'user-a', 'message-a', 'reason', 'pending', ?)
      `).bind(NOW),
    ])

    const noConfirmation = await handler().fetch(request('/api/account/delete', tokenA, {
      method: 'POST', body: JSON.stringify({ confirmation: 'wrong' }),
    }))
    expect(noConfirmation.status).toBe(400)

    const response = await handler().fetch(request('/api/account/delete', tokenA, {
      method: 'POST', body: JSON.stringify({ confirmation: 'DELETE' }),
    }))
    expect(response.status).toBe(204)
    expect(avatarEvents).toEqual([{ type: 'avatar.delete', userId: 'user-a', objectKey: 'avatars/user-a/hash.webp' }])

    for (const table of ['users', 'auth_identities', 'sessions', 'favourites', 'playlists', 'playlist_tracks', 'listening_history', 'focus_sessions']) {
      const column = table === 'playlist_tracks' ? 'playlist_id' : table === 'auth_identities' || table === 'sessions' || table === 'favourites' || table === 'playlists' || table === 'listening_history' || table === 'focus_sessions' ? 'user_id' : 'id'
      const value = table === 'playlist_tracks' ? 'playlist-a' : 'user-a'
      expect(await database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).bind(value).first('count'), table).toBe(0)
    }
    expect(await database.prepare('SELECT user_id, author_display_name, content FROM chat_messages WHERE id = ?').bind('message-a').first()).toEqual({
      user_id: null, author_display_name: 'Deleted user', content: 'retained content',
    })
    expect(await database.prepare('SELECT reporter_user_id, status FROM catalog_reports WHERE id = ?').bind('catalog-report-a').first()).toEqual({ reporter_user_id: null, status: 'withdrawn' })
    expect(await database.prepare('SELECT reporter_user_id, status FROM chat_reports WHERE id = ?').bind('chat-report-a').first()).toEqual({ reporter_user_id: null, status: 'withdrawn' })
    expect(await handler().fetch(request('/api/library', tokenA)).then((result) => result.status)).toBe(401)
    expect(await handler().fetch(request('/api/library', tokenB)).then((result) => result.status)).toBe(200)
  })
})
