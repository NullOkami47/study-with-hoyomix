// L-15 prune (Wave E): the per-run row budget and the session grace period of runMaintenance.
// Property 17 itself is checked through scheduled() in maintenance.spec.ts.
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MAINTENANCE_ROW_BUDGET, runMaintenance, SESSION_RETENTION_GRACE_MS } from '../maintenance'
import { Log, LogLevel, Miniflare } from './miniflare-compat'

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const NOW = 1_786_480_000_000
const hash = (seed: number) => `hmac-sha256:v1:${seed.toString(16).padStart(64, '0')}`

let miniflare: Miniflare
let database: TestDatabase
let seed = 0

const insertFlows = (count: number, expiresAt: number, consumedAt: number | null = null) => database.batch(
  Array.from({ length: count }, () => database.prepare('INSERT INTO oauth_flows (state_hash, provider, intent, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(hash(++seed), 'github', 'login', expiresAt - 600_000, expiresAt, consumedAt)),
)
const insertSession = (id: string, expiresAt: number, revokedAt: number | null) => database.prepare(
  'INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
).bind(id, 'budget-user', hash(++seed), expiresAt, 0, 0, revokedAt).run()
const count = async (table: 'oauth_flows' | 'sessions') =>
  (await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>())!.count

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: `maintenance-budget-${crypto.randomUUID()}` },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  })
  database = await miniflare.getD1Database('DB')
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(sql.split(';').map((statement) => statement.trim()).filter(Boolean)
      .map((statement) => database.prepare(statement)))
  }
  await database.prepare("INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES ('budget-user', 'Budget', 'user', 0, 0)").run()
})

afterAll(async () => {
  await miniflare?.dispose()
})

beforeEach(async () => {
  await database.batch([database.prepare('DELETE FROM oauth_flows'), database.prepare('DELETE FROM sessions')])
})

describe('runMaintenance', () => {
  it('deletes at most the row budget per run, oauth_flows first, and resumes on the next run', async () => {
    expect(MAINTENANCE_ROW_BUDGET).toBe(200)
    await insertFlows(150, NOW - 1)
    await insertFlows(100, NOW - 60_000, NOW - 120_000) // consumed, then expired
    for (let index = 0; index < 10; index++) await insertSession(`dead-${index}`, NOW - SESSION_RETENTION_GRACE_MS - 1, null)

    expect(await runMaintenance(database as never, NOW)).toEqual({ oauthFlowsDeleted: 200, sessionsDeleted: 0, accountDeletionEventsDeleted: 0 })
    expect(await count('oauth_flows')).toBe(50)
    expect(await runMaintenance(database as never, NOW)).toEqual({ oauthFlowsDeleted: 50, sessionsDeleted: 10, accountDeletionEventsDeleted: 0 })
    expect(await runMaintenance(database as never, NOW)).toEqual({ oauthFlowsDeleted: 0, sessionsDeleted: 0, accountDeletionEventsDeleted: 0 })
    expect(await count('oauth_flows')).toBe(0)
    expect(await count('sessions')).toBe(0)
  })

  it('keeps unexpired flows and sessions that stopped working within the grace period', async () => {
    await insertFlows(3, NOW)          // expires exactly now: not yet past expiry
    await insertFlows(2, NOW + 1)
    await insertSession('live', NOW + 1, null)
    await insertSession('expired-recently', NOW - SESSION_RETENTION_GRACE_MS + 1, null)
    await insertSession('revoked-recently', NOW + 1, NOW - SESSION_RETENTION_GRACE_MS + 1)
    await insertSession('expired-long-ago', NOW - SESSION_RETENTION_GRACE_MS - 1, null)
    await insertSession('revoked-long-ago', NOW + 1, NOW - SESSION_RETENTION_GRACE_MS - 1)

    expect(await runMaintenance(database as never, NOW)).toEqual({ oauthFlowsDeleted: 0, sessionsDeleted: 2, accountDeletionEventsDeleted: 0 })
    expect(await count('oauth_flows')).toBe(5)
    const remaining = ((await database.prepare('SELECT id FROM sessions ORDER BY id').all()).results as { id: string }[]).map(({ id }) => id)
    expect(remaining).toEqual(['expired-recently', 'live', 'revoked-recently'])
  })

  // L-15 (D8 = stop emitting): rows nothing can process are drained after oauth_flows and
  // sessions, inside the same row budget. With an avatar storage binding only processed rows go.
  it('drains account_deletion_events last, within the shared budget', async () => {
    const insertEvents = (count: number, processedAt: number | null) => database.batch(
      Array.from({ length: count }, () => database.prepare('INSERT INTO account_deletion_events (id, user_id, event_type, object_key, created_at, processed_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(`event-${++seed}`, 'gone-user', 'avatar.delete', 'avatars/gone-user/a.webp', 0, processedAt)),
    )
    await database.prepare('DELETE FROM account_deletion_events').run()
    await insertFlows(150, NOW - 1)
    for (let index = 0; index < 30; index++) await insertSession(`drain-${index}`, NOW - SESSION_RETENTION_GRACE_MS - 1, null)
    await insertEvents(40, null)
    await insertEvents(5, NOW)
    expect(await runMaintenance(database as never, NOW)).toEqual({ oauthFlowsDeleted: 150, sessionsDeleted: 30, accountDeletionEventsDeleted: 20 })
    expect(await runMaintenance(database as never, NOW, { avatarStorage: true })).toEqual({ oauthFlowsDeleted: 0, sessionsDeleted: 0, accountDeletionEventsDeleted: 5 })
    // The binding keeps unprocessed rows for its consumer; without one they are drained too.
    expect(await database.prepare('SELECT COUNT(*) AS count FROM account_deletion_events WHERE processed_at IS NULL').first<number>('count')).toBe(20)
    expect(await runMaintenance(database as never, NOW)).toEqual({ oauthFlowsDeleted: 0, sessionsDeleted: 0, accountDeletionEventsDeleted: 20 })
    expect(await database.prepare('SELECT COUNT(*) AS count FROM account_deletion_events').first<number>('count')).toBe(0)
  })

  it('rejects an invalid budget', async () => {
    await expect(runMaintenance(database as never, NOW, { rowBudget: 0 })).rejects.toThrow('invalid_maintenance_budget')
  })
})
