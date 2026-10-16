import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { issueSession } from '../auth/session'
import { createFocusHandler, type FocusEnv } from '../focus/routes'
import { MAX_FOCUS_SESSIONS_PER_REQUEST } from '../focus/repository'
import type { FocusSessionRecord } from '../../src/features/focus/types'
import { createFocusSessionRepository } from '../../src/features/focus/localRepository'
import { createRemoteFocusSessionRepository, syncFocusSessionsAcrossDevices } from '../../src/features/focus/remoteRepository'
import { deriveFocusStatistics } from '../../src/features/focus/statistics'

const ORIGIN = 'https://study.example'
const NOW = 1_786_480_000_000
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

const focusRecord = (overrides: Partial<FocusSessionRecord> = {}): FocusSessionRecord => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  schemaVersion: 1,
  startedAt: '2026-08-25T00:00:00.000Z',
  endedAt: '2026-08-25T00:25:00.000Z',
  plannedFocusSeconds: 1_500,
  actualFocusSeconds: 1_500,
  status: 'completed',
  phase: 'focus',
  createdAt: '2026-08-25T00:25:00.000Z',
  ...overrides,
})

const request = (path: string, token?: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (token) headers.set('cookie', `__Host-session=${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN)
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

describe('authenticated focus session routes', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: FocusEnv
  let tokenA: string
  let tokenB: string
  let handler: { fetch(request: Request): Promise<Response> }

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `focus-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    env = {
      DB: database as unknown as FocusEnv['DB'],
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'focus-session-secret-value-for-tests',
    }
    for (const id of ['user-a', 'user-b']) {
      await database.prepare(`
        INSERT INTO users (id, display_name, role, created_at, updated_at)
        VALUES (?, ?, 'user', ?, ?)
      `).bind(id, id, NOW, NOW).run()
    }
    tokenA = (await issueSession(env.DB, 'user-a', env.SESSION_HMAC_SECRET, NOW, crypto)).token
    tokenB = (await issueSession(env.DB, 'user-b', env.SESSION_HMAC_SECRET, NOW, crypto)).token
    handler = createFocusHandler(env, { now: () => NOW })
  })

  afterEach(async () => {
    await miniflare.dispose()
  })

  const post = (sessions: unknown, token?: string) => handler.fetch(request('/api/focus-sessions', token, {
    method: 'POST',
    body: JSON.stringify({ sessions }),
  }))

  it('requires authentication for both reading and merging', async () => {
    expect((await handler.fetch(request('/api/focus-sessions'))).status).toBe(401)
    expect((await post([focusRecord()])).status).toBe(401)
  })

  it('rejects a changed authenticated identity before reading or writing Focus history', async () => {
    for (const init of [
      { headers: { 'x-account-user-id': 'user-b' } },
      { method: 'POST', headers: { 'x-account-user-id': 'user-b' }, body: JSON.stringify({ sessions: [focusRecord()] }) },
    ]) {
      const response = await handler.fetch(request('/api/focus-sessions', tokenA, init))
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'focus_session_account_changed' })
    }
    const stored = await database.prepare('SELECT COUNT(*) AS total FROM focus_sessions').first<{ total: number }>()
    expect(stored?.total).toBe(0)
  })

  it('paginates more than 512 immutable records without leaking another account', async () => {
    // Preserve the underlying local D1 failure when a bounded batch is rejected;
    // the application deliberately returns only a non-sensitive operation error.
    const databaseFailures: string[] = []
    const observedDatabase = new Proxy(env.DB, {
      get(target, property) {
        const member = Reflect.get(target, property)
        if (property === 'batch') return async (...args: unknown[]) => {
          try { return await member.apply(target, args) }
          catch (error) {
            databaseFailures.push(error instanceof Error ? error.stack ?? error.message : String(error))
            throw error
          }
        }
        return typeof member === 'function' ? member.bind(target) : member
      },
    })
    handler = createFocusHandler({ ...env, DB: observedDatabase }, { now: () => NOW })
    const sessions = Array.from({ length: 513 }, (_, index) => focusRecord({
      id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
    }))
    const upload = await post(sessions.slice(0, 512), tokenA)
    expect(upload.status, JSON.stringify({ response: await upload.text(), databaseFailures })).toBe(200)
    expect((await post(sessions.slice(512), tokenA)).status).toBe(200)
    expect((await post([focusRecord()], tokenB)).status).toBe(200)
    const first = await handler.fetch(request('/api/focus-sessions?limit=512', tokenA))
    expect(first.status).toBe(200)
    const page = await first.json() as { sessions: FocusSessionRecord[]; nextCursor: string | null }
    expect(page.sessions).toEqual(sessions.slice(0, 512))
    expect(page.nextCursor).toBe(sessions[511]!.id)
    const last = await handler.fetch(request(`/api/focus-sessions?limit=512&after=${page.nextCursor}`, tokenA))
    expect(await last.json()).toEqual({ sessions: sessions.slice(512), nextCursor: null })
  })

  it.each(['limit=0', 'limit=513', 'limit=abc', 'limit=1&after=invalid', 'after=550e8400-e29b-41d4-a716-446655440000'])
    ('rejects invalid pagination parameters: %s', async query => {
      const response = await handler.fetch(request(`/api/focus-sessions?${query}`, tokenA))
      expect(response.status).toBe(400)
    })

  it('rejects a cross-origin mutation before touching the database', async () => {
    const response = await handler.fetch(new Request(`${ORIGIN}/api/focus-sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
        cookie: `__Host-session=${tokenA}`,
      },
      body: JSON.stringify({ sessions: [focusRecord()] }),
    }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'forbidden_origin' })
    const stored = await database.prepare('SELECT COUNT(*) AS total FROM focus_sessions').first<{ total: number }>()
    expect(stored?.total).toBe(0)
  })

  it('inserts unseen records, accepts an exact duplicate, and rejects a divergent same ID', async () => {
    const record = focusRecord()
    const first = await post([record], tokenA)
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual({ insertedIds: [record.id], duplicateIds: [] })

    const second = await post([record], tokenA)
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toEqual({ insertedIds: [], duplicateIds: [record.id] })

    // A completed record must report actual equal to planned, so a shortened completed
    // payload is rejected by the schema before the immutable merge ever sees it.
    const invalid = await post([{ ...record, actualFocusSeconds: 2 }], tokenA)
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ error: 'invalid_focus_session' })

    const divergent = await post(
      [{ ...record, status: 'interrupted', actualFocusSeconds: 2 }],
      tokenA,
    )
    expect(divergent.status).toBe(409)
    await expect(divergent.json()).resolves.toEqual({ error: 'focus_session_conflict', id: record.id })

    const stored = await database.prepare(
      'SELECT actual_focus_seconds AS actual FROM focus_sessions WHERE user_id = ? AND id = ?',
    ).bind('user-a', record.id).first<{ actual: number }>()
    expect(stored?.actual).toBe(1_500)
  })

  it('rejects a divergent pair inside one batch without inserting anything', async () => {
    const record = focusRecord()
    const response = await post([record, { ...record, status: 'interrupted', actualFocusSeconds: 900 }], tokenA)

    expect(response.status).toBe(409)
    const stored = await database.prepare('SELECT COUNT(*) AS total FROM focus_sessions').first<{ total: number }>()
    expect(stored?.total).toBe(0)
  })

  it('handles simultaneous immutable duplicate uploads idempotently', async () => {
    const responses = await Promise.all([post([focusRecord()], tokenA), post([focusRecord()], tokenA)])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    const stored = await database.prepare('SELECT COUNT(*) AS total FROM focus_sessions').first<{ total: number }>()
    expect(stored?.total).toBe(1)
  })

  it('reports a simultaneous divergent immutable upload as a conflict', async () => {
    const responses = await Promise.all([
      post([focusRecord()], tokenA),
      post([focusRecord({ status: 'interrupted', actualFocusSeconds: 600 })], tokenA),
    ])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const stored = await database.prepare('SELECT COUNT(*) AS total FROM focus_sessions').first<{ total: number }>()
    expect(stored?.total).toBe(1)
  })

  it('synchronises two independent local histories through authenticated paged D1 routes', async () => {
    const first = createFocusSessionRepository()
    const second = createFocusSessionRepository()
    const firstSessions = Array.from({ length: 513 }, (_, index) => focusRecord({
      id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`,
    }))
    for (const session of firstSessions) await first.recordIfAbsent(session)
    const interrupted = focusRecord({ status: 'interrupted', actualFocusSeconds: 600 })
    await second.recordIfAbsent(interrupted)
    const remote = createRemoteFocusSessionRepository({
      fetch: async (path, init) => handler.fetch(request(String(path), tokenA, init)),
    })
    await syncFocusSessionsAcrossDevices(first, remote)
    await syncFocusSessionsAcrossDevices(second, remote)
    await syncFocusSessionsAcrossDevices(first, remote)
    const firstHistory = await first.list()
    const secondHistory = await second.list()
    expect(firstHistory).toEqual(secondHistory)
    expect(firstHistory).toHaveLength(514)
    const statistics = deriveFocusStatistics(firstHistory, { now: '2026-08-25T03:00:00.000Z', timeZone: 'UTC' })
    expect(statistics.completedSessionCount).toBe(513)
    expect(statistics.today.sessionCount).toBe(514)
    expect(statistics.totalFocusSeconds).toBe(513 * 1500 + 600)
    const otherAccount = await handler.fetch(request('/api/focus-sessions?limit=512', tokenB))
    expect(await otherAccount.json()).toEqual({ sessions: [], nextCursor: null })
  })

  it('returns every stored record for the owner in ended order and never another account', async () => {
    const early = focusRecord({
      id: '550e8400-e29b-41d4-a716-446655440001',
      startedAt: '2026-08-24T00:00:00.000Z',
      endedAt: '2026-08-24T00:25:00.000Z',
      createdAt: '2026-08-24T00:25:00.000Z',
    })
    const late = focusRecord()
    expect((await post([late, early], tokenA)).status).toBe(200)
    expect((await post([focusRecord({ id: '550e8400-e29b-41d4-a716-446655440002' })], tokenB)).status).toBe(200)

    const response = await handler.fetch(request('/api/focus-sessions', tokenA))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ sessions: [early, late] })
  })

  it('stores no listening, track, provider, or media field even when one is supplied', async () => {
    const response = await post([{ ...focusRecord(), trackId: 'private-track' }], tokenA)

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_focus_session' })
    const columns = await database.prepare("SELECT name FROM pragma_table_info('focus_sessions')")
      .all<{ name: string }>()
    expect(columns.results.map((column: { name: string }) => column.name).sort()).toEqual([
      'actual_focus_seconds',
      'created_at',
      'ended_at',
      'id',
      'phase',
      'planned_focus_seconds',
      'schema_version',
      'started_at',
      'status',
      'user_id',
    ])
  })

  it('rejects an inexact request envelope and a non-focus phase', async () => {
    const extraKey = await handler.fetch(request('/api/focus-sessions', tokenA, {
      method: 'POST',
      body: JSON.stringify({ sessions: [focusRecord()], totalFocusSeconds: 1_500 }),
    }))
    expect(extraKey.status).toBe(400)

    const missing = await handler.fetch(request('/api/focus-sessions', tokenA, {
      method: 'POST',
      body: JSON.stringify({}),
    }))
    expect(missing.status).toBe(400)

    expect((await post(focusRecord(), tokenA)).status).toBe(400)
    expect((await post([{ ...focusRecord(), phase: 'break' }], tokenA)).status).toBe(400)
  })

  it('rejects non-JSON and byte-oversized focus bodies', async () => {
    const valid = JSON.stringify({ sessions: [focusRecord()] })
    const wrongMime = await handler.fetch(request('/api/focus-sessions', tokenA, {
      method: 'POST', headers: { 'content-type': 'application/jsonp' }, body: valid,
    }))
    const oversizedUnicode = await handler.fetch(request('/api/focus-sessions', tokenA, {
      method: 'POST',
      body: JSON.stringify({ sessions: [], padding: '界'.repeat(180_000) }),
    }))

    expect(wrongMime.status).toBe(400)
    expect(oversizedUnicode.status).toBe(400)
  })

  it('caps the batch size instead of accepting an unbounded upload', async () => {
    const sessions = Array.from({ length: MAX_FOCUS_SESSIONS_PER_REQUEST + 1 }, (_unused, index) => focusRecord({
      id: `550e8400-e29b-41d4-a716-${(446655440000 + index).toString().padStart(12, '0')}`,
    }))

    const response = await post(sessions, tokenA)

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual({ error: 'focus_session_batch_too_large' })
  })

  it('rejects an unsupported method on the focus route', async () => {
    const response = await handler.fetch(request('/api/focus-sessions', tokenA, { method: 'DELETE' }))

    expect(response.status).toBe(404)
  })
})
