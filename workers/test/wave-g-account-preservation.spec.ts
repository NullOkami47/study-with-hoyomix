// Wave G preservation (task 26, Property 2; requirements 3.11 and the L-15/L-21/L-24 neighbours).
// Observation-first: every expectation was observed on the unfixed tree (8c23f12). Inputs stay
// outside the Wave G bug conditions:
// - L-21 changes the deleted user's chat CONTENT and adds chat to the export, so neither is
//   asserted; other accounts' rows, the anonymised metadata and the non-chat cascade are.
// - L-15 stops the outbox row when no avatar storage binding exists; here a binding
//   (emitAvatarDeletion) is always supplied.
// - L-24 changes the ETag format and the stale status (409 today, 412 in design Property 16), so
//   revisions are read from D1 rather than parsed from the ETag, and a stale If-Match is accepted
//   as 409 or 412. The row must be unchanged either way.
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createAccountPreferencesHandler } from '../account/preferences'
import { issueSession } from '../auth/session'
import worker from '../index'
import { createLibraryHandler, type LibraryEnv } from '../library/routes'
import { Log, LogLevel, Miniflare } from './miniflare-compat'

const ORIGIN = 'https://study.example'
const SECRET = 'wave-g-account-preservation-secret-at-least-32'
type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

let miniflare: Miniflare
let database: TestDatabase
let run = 0

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: '2025-12-01', modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: `wave-g-account-preservation-${crypto.randomUUID()}` },
    d1Persist: false, log: new Log(LogLevel.NONE),
  })
  database = await miniflare.getD1Database('DB')
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(sql.split(';').map((s) => s.trim()).filter(Boolean).map((s) => database.prepare(s)))
  }
})
afterAll(async () => { await miniflare?.dispose() })

const env = (): LibraryEnv => ({ DB: database as never, PUBLIC_ORIGIN: ORIGIN, SESSION_HMAC_SECRET: SECRET })
const request = (path: string, token: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  headers.set('cookie', `__Host-session=${token}`)
  if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}
const send = async (path: string, token: string, init: RequestInit = {}) => {
  const pending: Promise<unknown>[] = []
  const response = await (worker.fetch as (...args: unknown[]) => Promise<Response>)(request(path, token, init), env(),
    { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) }, passThroughOnException: () => {} })
  await Promise.allSettled(pending)
  return response
}
const rows = async (sql: string, ...binds: unknown[]) => (await database.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results
const createUser = async (id: string, avatarUrl: string | null = null) => {
  const now = Date.now()
  await database.batch([
    database.prepare("INSERT INTO users (id, display_name, avatar_url, role, created_at, updated_at) VALUES (?, ?, ?, 'user', ?, ?)").bind(id, id, avatarUrl, now, now),
    database.prepare('INSERT INTO library_sync_state (user_id, revision) VALUES (?, 0)').bind(id),
  ])
  return (await issueSession(database as never, id, SECRET, now, crypto)).token
}

const PRIVATE_TABLES = ['favourites', 'playlists', 'listening_history', 'focus_sessions', 'user_background_selections',
  'user_ui_preferences', 'user_provider_preferences', 'sessions', 'library_sync_state', 'auth_identities'] as const

/** Seeds the non-chat private rows of one account; every flag adds one table's row. */
const seedPrivate = async (userId: string, plan: Record<string, boolean>, now: number) => {
  const statements = [database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(`${userId}-identity`, userId, 'github', `${userId}-subject`, now)]
  if (plan.favourite) statements.push(database.prepare('INSERT INTO favourites (user_id, track_id, created_at) VALUES (?, ?, ?)').bind(userId, `${userId}-fav`, now))
  if (plan.playlist) {
    statements.push(database.prepare("INSERT INTO playlists (id, user_id, name, visibility, created_at, updated_at) VALUES (?, ?, 'P', 'private', ?, ?)").bind(`${userId}-pl`, userId, now, now))
    statements.push(database.prepare('INSERT INTO playlist_tracks VALUES (?, ?, ?, ?)').bind(`${userId}-pl`, 'track-x', 0, now))
  }
  if (plan.history) statements.push(database.prepare('INSERT INTO listening_history (id, user_id, track_id, played_at) VALUES (?, ?, ?, ?)').bind(`${userId}-hist`, userId, 'track-x', now))
  if (plan.focus) statements.push(database.prepare(`INSERT INTO focus_sessions (user_id, id, schema_version, started_at, ended_at, planned_focus_seconds, actual_focus_seconds, status, phase, created_at)
    VALUES (?, ?, 1, ?, ?, 60, 60, 'completed', 'focus', ?)`).bind(userId, crypto.randomUUID(), now, now + 60_000, now))
  if (plan.background) statements.push(database.prepare("INSERT INTO user_background_selections (user_id, selection_json, auto_rotate, interval_seconds, updated_at) VALUES (?, '[\"bg\"]', 1, 30, ?)").bind(userId, now))
  if (plan.ui) statements.push(database.prepare("INSERT INTO user_ui_preferences (user_id, preferences_json, updated_at) VALUES (?, '{}', ?)").bind(userId, now))
  if (plan.provider) statements.push(database.prepare("INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at) VALUES (?, '[\"chksz\"]', ?)").bind(userId, now))
  await database.batch(statements)
}
const footprint = async (userId: string) => JSON.stringify({
  user: await rows('SELECT * FROM users WHERE id = ?', userId),
  ...Object.fromEntries(await Promise.all(PRIVATE_TABLES.map(async (table) => [table, await rows(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY 1, 2`, userId)]))),
  playlistTracks: await rows('SELECT pt.* FROM playlist_tracks pt JOIN playlists p ON p.id = pt.playlist_id WHERE p.user_id = ? ORDER BY 1, 2', userId),
  messages: await rows('SELECT * FROM chat_messages WHERE user_id = ? ORDER BY id', userId),
  versions: await rows('SELECT v.* FROM chat_message_versions v JOIN chat_messages m ON m.id = v.message_id WHERE m.user_id = ? ORDER BY v.id', userId),
})

describe('Wave G: account deletion cascade and anonymisation stay as they are (3.11, L-21 neighbours)', () => {
  const flags = fc.record({ favourite: fc.boolean(), playlist: fc.boolean(), history: fc.boolean(), focus: fc.boolean(), background: fc.boolean(), ui: fc.boolean(), provider: fc.boolean() })
  const scenario = fc.record({
    mine: flags, theirs: flags,
    myMessages: fc.array(fc.record({ type: fc.constantFrom('text', 'sticker'), versions: fc.integer({ min: 0, max: 2 }), deleted: fc.boolean() }), { maxLength: 3 }),
    theirMessages: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 3 }),
  })

  it("leaves other accounts' chat and data byte-identical, anonymises the deleted user's chat metadata and removes the non-chat rows", async () => {
    await fc.assert(fc.asyncProperty(scenario, async (plan) => {
      run++
      const now = Date.now()
      const x = `wg-delete-${run}`
      const y = `wg-keep-${run}`
      const tokenX = await createUser(x)
      const tokenY = await createUser(y)
      await seedPrivate(x, plan.mine, now)
      await seedPrivate(y, plan.theirs, now)
      const statements: ReturnType<TestDatabase['prepare']>[] = []
      const insertMessage = (id: string, user: string, type: string, deletedAt: number | null) => database.prepare(`INSERT INTO chat_messages
        (id, user_id, author_display_name, content, message_type, sticker_id, coarse_location, created_at, updated_at, deleted_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'JP', ?, ?, ?, ?)`).bind(id, user, user, type === 'text' ? `text of ${id}` : '', type, type === 'sticker' ? 'tea' : null, now, now, deletedAt, now + 86_400_000)
      const version = (messageId: string, user: string, index: number) => database.prepare('INSERT INTO chat_message_versions (id, message_id, editor_user_id, original_content, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(`${messageId}-v${index}`, messageId, user, `draft ${index} of ${messageId}`, now, now + 86_400_000)
      const mine = plan.myMessages.map((message, index) => {
        const id = `${x}-m${index}`
        statements.push(insertMessage(id, x, message.type, message.deleted ? now : null))
        for (let v = 0; v < message.versions; v++) statements.push(version(id, x, v))
        return { id, ...message }
      })
      plan.theirMessages.forEach((versions, index) => {
        const id = `${y}-m${index}`
        statements.push(insertMessage(id, y, 'text', null))
        for (let v = 0; v < versions; v++) statements.push(version(id, y, v))
      })
      if (statements.length) await database.batch(statements)
      const myMeta = await rows(`SELECT id, room_id, message_type, sticker_id, track_id, created_at, updated_at, deleted_at, expires_at FROM chat_messages WHERE user_id = ? ORDER BY id`, x)
      const otherBefore = await footprint(y)
      const otherExportBefore = await (await send('/api/export', tokenY)).json()

      expect((await send('/api/account/delete', tokenX, { method: 'POST', body: JSON.stringify({ confirmation: 'DELETE' }) })).status).toBe(204)

      expect(await rows('SELECT id FROM users WHERE id = ?', x)).toEqual([])
      for (const table of PRIVATE_TABLES) expect(await rows(`SELECT * FROM ${table} WHERE user_id = ?`, x), table).toEqual([])
      expect(await rows('SELECT * FROM playlist_tracks WHERE playlist_id = ?', `${x}-pl`)).toEqual([])
      // The deleted user's messages remain as anonymised rows with unchanged metadata (content is L-21's).
      const after = await rows(`SELECT id, room_id, message_type, sticker_id, track_id, created_at, updated_at, deleted_at, expires_at,
        user_id, author_display_name, coarse_location FROM chat_messages WHERE id IN (${mine.map(() => '?').join(',') || "''"}) ORDER BY id`, ...mine.map((m) => m.id))
      expect(after).toEqual(myMeta.map((row: Record<string, unknown>) => ({ ...row, user_id: null, author_display_name: 'Deleted user', coarse_location: null })))
      expect(await rows(`SELECT id FROM chat_message_versions WHERE message_id IN (${mine.map(() => '?').join(',') || "''"})`, ...mine.map((m) => m.id))).toEqual([])
      // Nothing that belongs to the other account moved, including its messages, versions and export.
      expect(await footprint(y)).toBe(otherBefore)
      expect(await (await send('/api/export', tokenY)).json()).toEqual(otherExportBefore)
      expect((await send('/api/session', tokenX)).status).toBe(401)
      expect((await send('/api/session', tokenY)).status).toBe(200)
    }), { numRuns: 15, endOnFailure: true })
  }, 240_000)
})

describe('Wave G: account deletion with an avatar storage binding still records the event (L-15 neighbour)', () => {
  const NOW = 1_786_480_000_000
  it.each([
    ['the binding succeeds', true],
    ['the binding fails', false],
  ] as const)('records the avatar.delete outbox row when %s', async (_label, succeeds) => {
    run++
    const userId = `wg-avatar-${run}`
    const objectKey = `avatars/${userId}/avatar.webp`
    const token = await createUser(userId, objectKey)
    const emitted: unknown[] = []
    const handler = createLibraryHandler(env(), {
      now: () => NOW,
      emitAvatarDeletion: async (event) => { emitted.push(event); if (!succeeds) throw new Error('fixture storage failure') },
    })
    const response = await handler.fetch(request('/api/account/delete', token, { method: 'POST', body: JSON.stringify({ confirmation: 'DELETE' }) }))
    expect(response.status).toBe(204)
    expect(emitted).toEqual([{ type: 'avatar.delete', userId, objectKey }])
    expect(await rows('SELECT user_id, event_type, object_key, created_at, processed_at FROM account_deletion_events WHERE user_id = ?', userId))
      .toEqual([{ user_id: userId, event_type: 'avatar.delete', object_key: objectKey, created_at: NOW, processed_at: succeeds ? NOW : null }])
    expect(await rows('SELECT id FROM users WHERE id = ?', userId)).toEqual([])
  })

  it('emits nothing for an avatar URL outside the account avatar prefix', async () => {
    run++
    const userId = `wg-foreign-avatar-${run}`
    const token = await createUser(userId, 'https://avatars.example/someone-else.png')
    const emitted: unknown[] = []
    const handler = createLibraryHandler(env(), { emitAvatarDeletion: async (event) => { emitted.push(event) } })
    expect((await handler.fetch(request('/api/account/delete', token, { method: 'POST', body: JSON.stringify({ confirmation: 'DELETE' }) }))).status).toBe(204)
    expect(emitted).toEqual([])
    expect(await rows('SELECT id FROM account_deletion_events WHERE user_id = ?', userId)).toEqual([])
  })
})

describe('Wave G: preference writes keep their revision semantics (L-24 neighbours)', () => {
  const PREFERENCES = {
    locale: 'zh-Hant', volume: 0.35, backgroundMode: 'still',
    visualStyle: 'studio', studioBlur: 12, studioGlassGray: 45, studioEdge: 65,
    studyTipsEnabled: false, backgroundPlaybackMode: 'random', backgroundQualityMode: 'auto',
  }
  const variant = fc.record({ volume: fc.constantFrom(0, 0.35, 0.5, 1), studyTipsEnabled: fc.boolean() })
    .map((change) => ({ ...PREFERENCES, ...change }))
  /** match = the current revision (or `absent` before the first write), stale = any other revision, none = no If-Match. */
  const operation = fc.record({
    kind: fc.constantFrom('match', 'match', 'stale', 'none'),
    preferences: variant,
    staleRevision: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  })

  it('accepts a matching If-Match and no If-Match, rejects a stale one without writing, and serves the latest value', async () => {
    await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 6 }), async (operations) => {
      run++
      const userId = `wg-prefs-${run}`
      const token = await createUser(userId)
      const handler = createAccountPreferencesHandler(env())
      const prefsRequest = (init: RequestInit = {}) => {
        const headers = new Headers(init.headers)
        headers.set('x-account-preferences-schema', '2')
        headers.set('cookie', `__Host-session=${token}`)
        if (init.method === 'PUT') { headers.set('origin', ORIGIN); headers.set('content-type', 'application/json') }
        return new Request(`${ORIGIN}/api/account/ui-preferences`, { ...init, headers })
      }
      const stored = () => database.prepare('SELECT preferences_json AS json, updated_at AS revision FROM user_ui_preferences WHERE user_id = ?')
        .bind(userId).first<{ json: string; revision: number }>()
      let latest: typeof PREFERENCES | null = null
      for (const op of operations) {
        const before = await stored()
        const ifMatch = op.kind === 'none' ? null
          : op.kind === 'match' ? (before ? String(before.revision) : 'absent')
            : String(op.staleRevision === before?.revision ? op.staleRevision + 1 : op.staleRevision)
        const response = await handler.fetch(prefsRequest({
          method: 'PUT', body: JSON.stringify({ preferences: op.preferences }),
          ...(ifMatch === null ? {} : { headers: { 'if-match': ifMatch } }),
        }))
        const after = await stored()
        if (op.kind === 'stale') {
          // Observed 409 on the unfixed tree; design Property 16 allows the fix to return 412.
          expect([409, 412]).toContain(response.status)
          expect(after).toEqual(before)
        } else {
          expect(response.status).toBe(200)
          expect(await response.json()).toEqual({ preferences: op.preferences })
          expect(response.headers.get('etag')).toBeTruthy()
          expect(after!.revision).toBeGreaterThan(before?.revision ?? -1)
          latest = op.preferences
        }
        const read = await handler.fetch(prefsRequest())
        expect(read.status).toBe(200)
        expect(read.headers.get('etag')).toBeTruthy()
        expect(await read.json()).toEqual({ preferences: latest })
      }
    }), { numRuns: 15, endOnFailure: true })
  }, 240_000)
})
