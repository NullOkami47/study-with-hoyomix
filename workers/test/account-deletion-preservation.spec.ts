// Wave E preservation (task 18, design Property 2, requirement 3.11). Observation-first: every
// expectation below was observed on the unfixed tree (ee34b3b). Wave E changes what happens AFTER a
// successful deletion (the chat /revalidate moves into ctx.waitUntil and becomes targeted, and the
// L-15 prune starts deleting expired sessions), so the deletion itself must stay exactly this:
// one batch, cascades, withdrawn pending reports and anonymised chat rows, other accounts untouched.
// The avatar outbox row (account_deletion_events) is not asserted: D8 changes it in Wave G.
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { issueSession } from '../auth/session'
import worker from '../index'
import { Log, LogLevel, Miniflare } from './miniflare-compat'

const ORIGIN = 'https://study.example'
const SECRET = 'account-deletion-preservation-secret'
type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

let miniflare: Miniflare
let database: TestDatabase
let run = 0

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: `account-deletion-preservation-${crypto.randomUUID()}` },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  })
  database = await miniflare.getD1Database('DB')
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(sql.split(';').map((statement) => statement.trim()).filter(Boolean).map((statement) => database.prepare(statement)))
  }
})

afterAll(async () => {
  await miniflare?.dispose()
})

const env = () => ({ DB: database, PUBLIC_ORIGIN: ORIGIN, SESSION_HMAC_SECRET: SECRET })
// Called with the (env, ctx) shape the fixed entry point takes (design Shared Infrastructure 3).
const send = async (path: string, token: string, init: RequestInit = {}) => {
  const pending: Promise<unknown>[] = []
  const headers = new Headers({ accept: 'application/json', cookie: `__Host-session=${token}` })
  if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  const response = await (worker.fetch as (...args: unknown[]) => Promise<Response>)(
    new Request(`${ORIGIN}${path}`, { ...init, headers }),
    env(),
    { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) }, passThroughOnException: () => {} },
  )
  await Promise.allSettled(pending)
  return response
}

const rows = async (sql: string, ...binds: unknown[]) => (await database.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results
const total = async (sql: string, ...binds: unknown[]) => (await database.prepare(sql).bind(...binds).first<{ total: number }>())!.total

/** Every row that belongs to, or points at, `userId`, as a stable string. */
const footprint = async (userId: string, messageIds: string[]) => JSON.stringify({
  user: await rows('SELECT * FROM users WHERE id = ?', userId),
  identities: await rows('SELECT * FROM auth_identities WHERE user_id = ? ORDER BY id', userId),
  sessions: await rows('SELECT * FROM sessions WHERE user_id = ? ORDER BY id', userId),
  blocks: await rows('SELECT * FROM user_blocks WHERE blocking_user_id = ? OR blocked_user_id = ? ORDER BY blocking_user_id, blocked_user_id', userId, userId),
  messages: await rows(`SELECT * FROM chat_messages WHERE id IN (${messageIds.map(() => '?').join(',') || "''"}) ORDER BY id`, ...messageIds),
  versions: await rows(`SELECT * FROM chat_message_versions WHERE message_id IN (${messageIds.map(() => '?').join(',') || "''"}) ORDER BY id`, ...messageIds),
})

describe('account deletion keeps its cascade, report and chat-anonymisation semantics (requirement 3.11)', () => {
  const scenario = fc.record({
    providers: fc.subarray(['google', 'github', 'linuxdo'] as const, { minLength: 1 }),
    extraSessions: fc.integer({ min: 0, max: 2 }),
    blocksOther: fc.boolean(),
    blockedByOther: fc.boolean(),
    uiPreferences: fc.boolean(),
    providerPreferences: fc.boolean(),
    banned: fc.boolean(),
    catalogReports: fc.array(fc.constantFrom('pending', 'accepted', 'rejected'), { maxLength: 3 }),
    messages: fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 3 }),
    reportsOtherMessage: fc.option(fc.constantFrom('pending', 'resolved', 'rejected'), { nil: null }),
    reportedByOther: fc.boolean(),
  })

  it('deletes the account in one step, cascades its private rows, withdraws its pending reports and anonymises its chat rows', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (plan) => {
        run++
        const now = Date.now()
        const x = `delete-me-${run}`
        const y = `keep-me-${run}`
        const statements = [
          database.prepare("INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?), (?, ?, 'user', ?, ?)")
            .bind(x, x, now, now, y, y, now, now),
          database.prepare('INSERT INTO library_sync_state (user_id, revision) VALUES (?, 0), (?, 0)').bind(x, y),
          ...plan.providers.map((provider) => database.prepare('INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, ?, ?, ?)')
            .bind(crypto.randomUUID(), x, provider, `${x}-${provider}`, now)),
          database.prepare("INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at) VALUES (?, ?, 'github', ?, ?)")
            .bind(crypto.randomUUID(), y, `${y}-github`, now),
        ]
        if (plan.blocksOther) statements.push(database.prepare('INSERT INTO user_blocks (blocking_user_id, blocked_user_id, created_at) VALUES (?, ?, ?)').bind(x, y, now))
        if (plan.blockedByOther) statements.push(database.prepare('INSERT INTO user_blocks (blocking_user_id, blocked_user_id, created_at) VALUES (?, ?, ?)').bind(y, x, now))
        if (plan.uiPreferences) statements.push(database.prepare("INSERT INTO user_ui_preferences (user_id, preferences_json, updated_at) VALUES (?, '{}', ?)").bind(x, now))
        if (plan.providerPreferences) statements.push(database.prepare("INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at) VALUES (?, '[\"chksz\"]', ?)").bind(x, now))
        if (plan.banned) statements.push(database.prepare("INSERT INTO chat_bans (id, user_id, actor_user_id, reason, created_at) VALUES (?, ?, ?, 'r', ?)").bind(crypto.randomUUID(), x, y, now))
        const catalogReportIds = plan.catalogReports.map((status, index) => {
          const id = `${x}-catalog-${index}`
          statements.push(database.prepare(`INSERT INTO catalog_reports (id, reporter_user_id, canonical_track_id, kind, current_value_json, proposed_value_json, status, created_at, updated_at)
            VALUES (?, ?, ?, 'metadata', '{}', '{}', ?, ?, ?)`).bind(id, x, `track-${index}`, status, now, now))
          return { id, status }
        })
        const ownMessages = plan.messages.map((versions, index) => {
          const id = `${x}-message-${index}`
          statements.push(database.prepare(`INSERT INTO chat_messages (id, user_id, author_display_name, content, coarse_location, created_at, expires_at)
            VALUES (?, ?, ?, ?, 'JP', ?, ?)`).bind(id, x, x, `hello ${index}`, now, now + 86_400_000))
          for (let version = 0; version < versions; version++) {
            statements.push(database.prepare('INSERT INTO chat_message_versions (id, message_id, editor_user_id, original_content, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
              .bind(crypto.randomUUID(), id, x, `original ${version}`, now, now + 86_400_000))
          }
          return id
        })
        const otherMessage = `${y}-message`
        statements.push(database.prepare(`INSERT INTO chat_messages (id, user_id, author_display_name, content, coarse_location, created_at, expires_at)
          VALUES (?, ?, ?, 'kept', 'TW', ?, ?)`).bind(otherMessage, y, y, now, now + 86_400_000))
        statements.push(database.prepare('INSERT INTO chat_message_versions (id, message_id, editor_user_id, original_content, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(crypto.randomUUID(), otherMessage, y, 'kept original', now, now + 86_400_000))
        const ownReport = `${x}-chat-report`
        if (plan.reportsOtherMessage) {
          statements.push(database.prepare(`INSERT INTO chat_reports (id, reporter_user_id, message_id, reason, status, resolution_note, created_at)
            VALUES (?, ?, ?, 'spam', ?, 'note', ?)`).bind(ownReport, x, otherMessage, plan.reportsOtherMessage, now))
        }
        const reportAgainst = `${y}-chat-report`
        if (plan.reportedByOther && ownMessages.length) {
          statements.push(database.prepare(`INSERT INTO chat_reports (id, reporter_user_id, message_id, reason, status, resolution_note, created_at)
            VALUES (?, ?, ?, 'abuse', 'pending', 'note', ?)`).bind(reportAgainst, y, ownMessages[0], now))
        }
        await database.batch(statements)
        const token = (await issueSession(database as never, x, SECRET, now, crypto)).token
        for (let extra = 0; extra < plan.extraSessions; extra++) await issueSession(database as never, x, SECRET, now, crypto)
        const otherToken = (await issueSession(database as never, y, SECRET, now, crypto)).token
        const otherBefore = await footprint(y, [otherMessage])

        const response = await send('/api/account/delete', token, { method: 'POST', body: JSON.stringify({ confirmation: 'DELETE' }) })
        expect(response.status).toBe(204)

        // The account and everything private to it is gone.
        expect(await total('SELECT COUNT(*) AS total FROM users WHERE id = ?', x)).toBe(0)
        for (const table of ['auth_identities', 'sessions', 'user_ui_preferences', 'user_provider_preferences', 'chat_bans', 'library_sync_state']) {
          expect(await total(`SELECT COUNT(*) AS total FROM ${table} WHERE user_id = ?`, x), table).toBe(0)
        }
        expect(await total('SELECT COUNT(*) AS total FROM user_blocks WHERE blocking_user_id = ? OR blocked_user_id = ?', x, x)).toBe(0)
        // Its catalogue reports survive without a reporter; only the pending ones are withdrawn.
        for (const report of catalogReportIds) {
          const [row] = await rows('SELECT reporter_user_id, status FROM catalog_reports WHERE id = ?', report.id)
          expect(row).toEqual({ reporter_user_id: null, status: report.status === 'pending' ? 'withdrawn' : report.status })
        }
        // Its chat messages survive anonymised, without their private edit history.
        for (const id of ownMessages) {
          const [row] = await rows('SELECT user_id, author_display_name, coarse_location FROM chat_messages WHERE id = ?', id)
          expect(row).toEqual({ user_id: null, author_display_name: 'Deleted user', coarse_location: null })
          expect(await total('SELECT COUNT(*) AS total FROM chat_message_versions WHERE message_id = ?', id)).toBe(0)
        }
        // Chat reports it filed are withdrawn if pending and scrubbed either way; reports about it are scrubbed, not withdrawn.
        if (plan.reportsOtherMessage) {
          const [row] = await rows('SELECT reporter_user_id, status, reason, resolution_note FROM chat_reports WHERE id = ?', ownReport)
          expect(row).toEqual({
            reporter_user_id: null,
            status: plan.reportsOtherMessage === 'pending' ? 'withdrawn' : plan.reportsOtherMessage,
            reason: 'Report retained after account deletion',
            resolution_note: null,
          })
        }
        if (plan.reportedByOther && ownMessages.length) {
          const [row] = await rows('SELECT reporter_user_id, status, reason, resolution_note FROM chat_reports WHERE id = ?', reportAgainst)
          expect(row).toEqual({ reporter_user_id: y, status: 'pending', reason: 'Report retained after account deletion', resolution_note: null })
        }
        // The other account is untouched apart from the blocks that pointed at the deleted one.
        const otherAfter = JSON.parse(await footprint(y, [otherMessage])) as Record<string, unknown>
        const expectedOther = JSON.parse(otherBefore) as Record<string, unknown[]>
        expectedOther.blocks = []
        expect(otherAfter).toEqual(expectedOther)
        // The deleted session is dead; the other account's session still works.
        expect((await send('/api/session', token)).status).toBe(401)
        expect((await send('/api/session', otherToken)).status).toBe(200)
      }),
      { numRuns: 25, endOnFailure: true },
    )
  })

  it('refuses deletion without the exact confirmation and changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.constantFrom('delete', 'DELETE ', ' DELETE', 'Delete', ''), fc.string({ maxLength: 10 }).filter((value) => value !== 'DELETE')), async (confirmation) => {
        run++
        const now = Date.now()
        const x = `kept-${run}`
        await database.batch([
          database.prepare("INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)").bind(x, x, now, now),
          database.prepare('INSERT INTO library_sync_state (user_id, revision) VALUES (?, 0)').bind(x),
        ])
        const token = (await issueSession(database as never, x, SECRET, now, crypto)).token
        const before = await footprint(x, [])
        const response = await send('/api/account/delete', token, { method: 'POST', body: JSON.stringify({ confirmation }) })
        expect(response.status).toBe(400)
        expect(await footprint(x, [])).toBe(before)
      }),
      { numRuns: 10, endOnFailure: true },
    )
  })
})
