// Wave E exploration (task 17, L-15 prune / design Property 17). Encodes the expected behaviour, so
// it FAILS on the unfixed tree, which has no scheduled() handler and never prunes anything.
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import worker from '../index'
import { Log, LogLevel, Miniflare } from './miniflare-compat'

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const DAY = 24 * 60 * 60 * 1000
const hash = (seed: number) => `hmac-sha256:v1:${seed.toString(16).padStart(64, '0')}`

// Row kinds with an unambiguous expected outcome. Recently revoked sessions are deliberately not
// generated: whether they survive depends on the grace period, which the fix chooses.
type OAuthKind = 'expired' | 'live'
type SessionKind = 'expired' | 'revokedLongAgo' | 'live'

let miniflare: Miniflare
let database: TestDatabase

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: `maintenance-${crypto.randomUUID()}` },
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
  await database.prepare("INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES ('maint-user', 'Maint', 'user', 0, 0)").run()
})

afterAll(async () => {
  await miniflare?.dispose()
})

describe('scheduled maintenance prunes exactly the expired set (Property 17)', () => {
  it('exports a scheduled() handler', () => {
    expect(typeof (worker as { scheduled?: unknown }).scheduled).toBe('function')
  })

  it('deletes every expired oauth_flows row and expired/long-revoked session, and keeps every live row', async () => {
    let seed = 0
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ kind: fc.constantFrom<OAuthKind>('expired', 'live'), offset: fc.integer({ min: 1, max: 30 * DAY }) }), { maxLength: 25 }),
        fc.array(fc.record({ kind: fc.constantFrom<SessionKind>('expired', 'revokedLongAgo', 'live'), offset: fc.integer({ min: 1, max: 30 * DAY }) }), { maxLength: 25 }),
        async (flows, sessions) => {
          await database.batch([database.prepare('DELETE FROM oauth_flows'), database.prepare('DELETE FROM sessions')])
          const now = Date.now()
          const keepFlows = new Set<string>()
          const keepSessions = new Set<string>()
          const statements = []
          for (const flow of flows) {
            const stateHash = hash(++seed)
            // Expired flows are past expiry by `offset`; live flows expire `offset` into the future.
            const expiresAt = flow.kind === 'expired' ? now - flow.offset : now + DAY + flow.offset
            const createdAt = Math.max(0, expiresAt - 10 * 60 * 1000)
            if (flow.kind === 'live') keepFlows.add(stateHash)
            statements.push(database.prepare('INSERT INTO oauth_flows (state_hash, provider, intent, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, NULL)')
              .bind(stateHash, 'github', 'login', createdAt, expiresAt))
          }
          for (const session of sessions) {
            const id = `session-${++seed}`
            const tokenHash = hash(seed)
            // Outcomes far from any plausible grace period: a year past expiry or revocation.
            const expiresAt = session.kind === 'expired' ? now - 365 * DAY - session.offset : now + DAY + session.offset
            const revokedAt = session.kind === 'revokedLongAgo' ? now - 365 * DAY - session.offset : null
            const createdAt = Math.max(0, now - 400 * DAY - session.offset)
            if (session.kind === 'live') keepSessions.add(id)
            statements.push(database.prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .bind(id, 'maint-user', tokenHash, expiresAt, createdAt, createdAt, revokedAt))
          }
          if (statements.length) await database.batch(statements)

          const scheduled = (worker as { scheduled?: (...args: unknown[]) => Promise<void> }).scheduled
          expect(typeof scheduled, 'workers/index.ts exports no scheduled() handler').toBe('function')
          const pending: Promise<unknown>[] = []
          await scheduled!(
            { scheduledTime: now, cron: '17 * * * *', noRetry: () => {} },
            { DB: database },
            { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) }, passThroughOnException: () => {} },
          )
          await Promise.all(pending)

          const remainingFlows = ((await database.prepare('SELECT state_hash FROM oauth_flows').all()).results as { state_hash: string }[]).map((row) => row.state_hash)
          const remainingSessions = ((await database.prepare('SELECT id FROM sessions').all()).results as { id: string }[]).map((row) => row.id)
          expect(new Set(remainingFlows)).toEqual(keepFlows)
          expect(new Set(remainingSessions)).toEqual(keepSessions)
        },
      ),
      { numRuns: 15, endOnFailure: true },
    )
  })
})
