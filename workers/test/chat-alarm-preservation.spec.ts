// Wave F preservation (task 22, design Property 2 / Property 10 preservation clause). Observation-
// first: every expectation below was observed on the unfixed tree (3a30d77) and must still hold
// after M-08 replaces the 30-second heartbeat with the 300 s sweep (D13) and stops the alarm from
// broadcasting presence (D24).
//
// Deliberately NOT asserted: the exact next-alarm time when only sockets keep the room awake (30 s
// today, the sweep interval after M-08) and whether the alarm sends a presence frame. What stays:
// due retention is pruned by the alarm and announced, the next alarm never lands after the next
// retention deadline, an idle alarm keeps the retention generation and writes nothing, an empty
// room cancels its alarm, and the participant aggregate (via /revalidate) is computed as before.
import { readFile, readdir } from 'node:fs/promises'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { issueSession } from '../auth/session'
import { ChatRoom } from '../chat/ChatRoom'
import type { ChatIdentity } from '../chat/protocol'
import { Log, LogLevel, Miniflare } from './miniflare-compat'

const now = Date.parse('2026-10-27T00:00:00Z')
const secret = 'chat-alarm-preservation-secret-thirty-two-chars'
type Role = 'user' | 'moderator' | 'admin' | 'owner'
const USERS: Array<{ id: string; role: Role }> = [
  { id: 'alice', role: 'user' }, { id: 'mona', role: 'moderator' }, { id: 'bob', role: 'admin' }, { id: 'carol', role: 'owner' },
]

let runtime: Miniflare
let db: Awaited<ReturnType<Miniflare['getD1Database']>>
const sessionHashes = new Map<string, string>()

beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2025-12-01',
    d1Databases: { DB: `chat-alarm-preservation-${crypto.randomUUID()}` },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  })
  db = await runtime.getD1Database('DB')
  for (const file of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    await db.batch((await readFile(`migrations/${file}`, 'utf8')).split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => db.prepare(sql)))
  }
  for (const user of USERS) {
    await db.prepare('INSERT INTO users(id,display_name,role,created_at,updated_at)VALUES(?,?,?,?,?)').bind(user.id, user.id, user.role, now, now).run()
    sessionHashes.set(user.id, (await issueSession(db as never, user.id, secret, now, crypto)).record.tokenHash)
  }
})
afterAll(async () => { await runtime?.dispose() })

beforeEach(async () => {
  await db.prepare('DELETE FROM chat_messages').run()
  await db.prepare("UPDATE chat_retention_state SET message_count=0,floor_created_at=NULL,floor_id=NULL").run()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  vi.stubGlobal('WebSocketRequestResponsePair', class { constructor(public request: string, public response: string) {} })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const resetRoom = async () => {
  await db.prepare('DELETE FROM chat_messages').run()
  await db.prepare("UPDATE chat_retention_state SET message_count=0,floor_created_at=NULL,floor_id=NULL").run()
}

const insert = async (id: string, expires: number) => {
  await db.prepare("INSERT INTO chat_messages(id,user_id,author_display_name,content,coarse_location,created_at,expires_at)VALUES(?,'alice','Alice','text','TW',?,?)")
    .bind(id, now - 1000, expires).run()
  await db.prepare('UPDATE chat_retention_state SET message_count=message_count+1').run()
}

/** A ChatRoom over fake hibernation state with any number of sockets. */
function fixture(identities: ChatIdentity[], database: unknown = db) {
  let alarm: number | null = null
  const durable = new Map<string, unknown>()
  const operations = { puts: 0, setAlarm: 0, deleteAlarm: 0 }
  const sockets = identities.map((initial) => {
    let attachment = initial
    const events: Record<string, unknown>[] = []
    return {
      events,
      readyState: 1,
      deserializeAttachment: () => attachment,
      serializeAttachment: (value: ChatIdentity) => { attachment = value },
      send: (value: string) => { events.push(JSON.parse(value)) },
      close(this: { readyState: number }) { this.readyState = 3 },
    }
  })
  const state = {
    acceptWebSocket: () => {},
    getWebSockets: () => sockets,
    setWebSocketAutoResponse: () => {},
    getWebSocketAutoResponseTimestamp: () => new Date(Date.now()),
    storage: {
      get: async <T>(key: string) => durable.get(key) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        operations.puts++
        for (const [k, v] of typeof key === 'string' ? [[key, value] as const] : Object.entries(key)) durable.set(k, v)
      },
      getAlarm: async () => alarm,
      setAlarm: async (value: number) => { operations.setAlarm++; alarm = value },
      deleteAlarm: async () => { operations.deleteAlarm++; alarm = null },
    },
  }
  const env = { DB: database, PUBLIC_ORIGIN: 'https://study.example', SESSION_HMAC_SECRET: secret }
  return { room: () => new ChatRoom(state as never, env as never), sockets, durable, operations, alarm: () => alarm }
}

const viewerIdentity = (choice: { user: string | null; visitor: string; deltas: boolean }): ChatIdentity => {
  const user = USERS.find((candidate) => candidate.id === choice.user)
  return {
    sessionHash: user ? sessionHashes.get(user.id)! : '',
    visitor: choice.visitor,
    country: 'TW',
    seenAt: now,
    viewerKey: user ? `${user.id}:${user.role}` : '',
    ...(choice.deltas ? { deltas: true } : {}),
  } as ChatIdentity
}
const socketChoice = fc.record({
  user: fc.constantFrom<string | null>(null, null, 'alice', 'mona', 'bob', 'carol'),
  visitor: fc.constantFrom('v1', 'v2', 'v3'),
  deltas: fc.boolean(),
})

describe('chat alarm still prunes due retention and respects the retention deadline', () => {
  it('removes every expired message, keeps the rest, announces the prune and schedules no later than the next expiry', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.array(fc.integer({ min: 60_000, max: 3_600_000 }), { maxLength: 3 }),
        fc.array(socketChoice, { maxLength: 3 }),
        async (expired, futureOffsets, choices) => {
          await resetRoom()
          for (let index = 0; index < expired; index++) await insert(`expired-${index}`, now - 1 - index)
          for (const [index, offset] of futureOffsets.entries()) await insert(`future-${index}`, now + offset)
          const f = fixture(choices.map(viewerIdentity))
          await f.room().alarm()

          const rows = (await db.prepare('SELECT id FROM chat_messages ORDER BY id').all<{ id: string }>()).results as Array<{ id: string }>
          const remaining = rows.map((row) => row.id)
          expect(remaining).toEqual(futureOffsets.map((_, index) => `future-${index}`).sort())
          for (const [index, socket] of f.sockets.entries()) {
            const announcement = choices[index].deltas ? { type: 'pruned' } : { type: 'reset' }
            expect(socket.events, JSON.stringify(choices[index])).toContainEqual(announcement)
          }
          const next = f.alarm()
          if (futureOffsets.length) {
            expect(next).not.toBeNull()
            expect(next!).toBeGreaterThan(now)
            expect(next!).toBeLessThanOrEqual(now + Math.min(...futureOffsets))
          } else if (choices.length) {
            expect(next).not.toBeNull()
            expect(next!).toBeGreaterThan(now)
          } else {
            expect(next).toBeNull()
          }
        },
      ),
      { numRuns: 12, endOnFailure: true },
    )
  })

  it('an alarm with nothing due keeps the retention generation, writes no storage key and runs no D1 batch', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 60_000, max: 86_400_000 }), { maxLength: 3 }),
        fc.array(socketChoice, { maxLength: 3 }),
        async (futureOffsets, choices) => {
          await resetRoom()
          for (const [index, offset] of futureOffsets.entries()) await insert(`idle-${index}`, now + offset)
          let batches = 0
          const counted = {
            prepare: (sql: string) => db.prepare(sql),
            batch: (statements: Parameters<typeof db.batch>[0]) => { batches++; return db.batch(statements) },
            exec: (sql: string) => db.exec(sql),
          }
          const f = fixture(choices.map(viewerIdentity), counted)
          const generation = f.durable.get('retention-attempt')
          await f.room().alarm()
          expect(f.durable.get('retention-attempt')).toEqual(generation)
          expect(f.operations.puts).toBe(0)
          expect(batches).toBe(0)
          expect((await db.prepare('SELECT COUNT(*) AS count FROM chat_messages').first<{ count: number }>())!.count).toBe(futureOffsets.length)
          for (const socket of f.sockets) {
            expect(socket.events.filter((event) => event.type === 'pruned' || event.type === 'reset')).toEqual([])
          }
          const next = f.alarm()
          if (!futureOffsets.length && !choices.length) {
            expect(next).toBeNull()
          } else {
            expect(next).not.toBeNull()
            expect(next!).toBeGreaterThan(now)
            if (futureOffsets.length) expect(next!).toBeLessThanOrEqual(now + Math.min(...futureOffsets))
          }
        },
      ),
      { numRuns: 12, endOnFailure: true },
    )
  })
})

describe('chat participant aggregate is unchanged', () => {
  it('/revalidate reports distinct people, Owner presence and admin presence over the live sockets', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(socketChoice, { minLength: 1, maxLength: 6 }), async (choices) => {
        const f = fixture(choices.map(viewerIdentity))
        const response = await f.room().fetch(new Request('https://chat.internal/revalidate', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'logout' }),
        }))
        expect(response.status).toBe(200)
        const people = new Set(choices.map((choice) => (choice.user ? `user:${choice.user}` : `visitor:${choice.visitor}`)))
        const roles = choices.map((choice) => USERS.find((user) => user.id === choice.user)?.role)
        const expected = {
          type: 'presence',
          participants: people.size,
          ownerOnline: roles.includes('owner'),
          adminOnline: roles.includes('admin') || roles.includes('owner'),
        }
        for (const socket of f.sockets) {
          const frames = socket.events.filter((event) => event.type === 'presence')
          expect(frames, JSON.stringify(choices)).toEqual([expected])
          // Unchanged viewers get no viewer/reset traffic from a revalidation.
          expect(socket.events.filter((event) => event.type === 'viewer' || event.type === 'reset')).toEqual([])
        }
      }),
      { numRuns: 30 },
    )
  })
})
