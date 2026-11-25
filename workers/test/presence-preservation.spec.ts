// Wave F preservation (task 22, design Property 2 / Property 9 preservation clause, requirement
// 3.5). Observation-first: every expectation below was observed on the unfixed tree (3a30d77) and
// must still hold after M-07 signs visitor IDs (D5), caps sockets and coalesces broadcasts.
//
// Inputs stay outside the M-07 bug clause: every visitor ID is the one the server issued from
// POST /api/presence/visitor (its format is NOT asserted, because D5 changes it), each visitor has
// at most three tabs (cap 5) and the population is tiny (cap 2000). Aggregates are read through the
// explicit `refresh` message, not by waiting for a broadcast, because the fix may coalesce those.
import fc from 'fast-check'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { OnlinePresence, presenceSummary, type PresenceEnv, type PresenceIdentity } from '../presence'
import { Miniflare } from './miniflare-compat'

const origin = 'https://study.example'
const STALE_MS = 90_000
const OWNER_RECHECK_MS = 300_000

type Socket = NonNullable<Awaited<ReturnType<Miniflare['dispatchFetch']>>['webSocket']>

describe('presence counts distinct server-issued visitors and drops them on their last disconnect (3.5)', () => {
  let runtime: Miniflare
  beforeAll(async () => {
    const bundle = await build({ entryPoints: ['workers/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' })
    runtime = new Miniflare({
      modules: true, script: bundle.outputFiles![0].text, compatibilityDate: '2025-12-01',
      durableObjects: { PRESENCE: { className: 'OnlinePresence', useSQLite: true } },
      d1Databases: { DB: `presence-preservation-${crypto.randomUUID()}` },
      // PRESENCE_SECRET is unused by the unfixed Worker; the fixed one needs it to issue IDs.
      bindings: { PUBLIC_ORIGIN: origin, SESSION_HMAC_SECRET: 'presence-preservation-session-secret', PRESENCE_SECRET: 'presence-secret-with-at-least-thirty-two-characters' },
    })
    const db = await runtime.getD1Database('DB')
    await db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, deleted_at INTEGER);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT, expires_at INTEGER, revoked_at INTEGER);`)
  })
  afterAll(async () => { await runtime?.dispose() })

  const issueVisitor = async () => {
    const response = await runtime.dispatchFetch(`${origin}/api/presence/visitor`, { method: 'POST', headers: { origin } })
    expect(response.status).toBe(204)
    const header = response.headers.get('set-cookie') ?? ''
    expect(header).toMatch(/^__Host-presence=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=86400$/u)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return header.match(/^__Host-presence=([^;]+)/u)![1]
  }
  const connect = async (visitor: string) => {
    const response = await runtime.dispatchFetch(`${origin}/api/presence`, {
      headers: { origin, upgrade: 'websocket', cookie: `__Host-presence=${visitor}` },
    })
    expect(response.status).toBe(101)
    const socket = response.webSocket!
    socket.accept()
    return socket
  }
  const refresh = (socket: Socket) => new Promise<{ type: string; count: number; ownerOnline: boolean }>((resolve) => {
    const handler = (event: { data: unknown }) => {
      if (event.data === 'pong') return
      const payload = JSON.parse(String(event.data))
      socket.removeEventListener('message', handler)
      resolve(payload)
    }
    socket.addEventListener('message', handler)
    socket.send('refresh')
  })
  /** Closes travel to the object asynchronously; poll the aggregate until it settles. */
  const settledCount = async (socket: Socket, expected: number) => {
    let last = -1
    for (let attempt = 0; attempt < 100; attempt++) {
      const summary = await refresh(socket)
      expect(summary.type).toBe('presence')
      expect(summary.ownerOnline).toBe(false)
      last = summary.count
      if (last === expected) return last
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return last
  }

  it('reports the number of distinct visitors with a live tab, however their tabs are spread', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ tabs: fc.integer({ min: 1, max: 3 }), leaves: fc.boolean() }), { minLength: 1, maxLength: 4 }),
        async (layout) => {
          const visitors = await Promise.all(layout.map(() => issueVisitor()))
          // Distinct bootstraps without a prior cookie yield distinct identities.
          expect(new Set(visitors).size).toBe(visitors.length)
          const tabs: Socket[][] = []
          for (const [index, { tabs: count }] of layout.entries()) {
            tabs.push([])
            for (let tab = 0; tab < count; tab++) tabs[index].push(await connect(visitors[index]))
          }
          const all = tabs.flat()
          try {
            expect(await settledCount(all[0], layout.length), JSON.stringify(layout)).toBe(layout.length)
            // Closing all but one tab of a visitor keeps that visitor counted.
            for (const [index, { tabs: count }] of layout.entries()) {
              for (let tab = 1; tab < count; tab++) tabs[index][tab].close()
              tabs[index] = tabs[index].slice(0, 1)
            }
            const observer = tabs[0][0]
            expect(await settledCount(observer, layout.length), JSON.stringify(layout)).toBe(layout.length)
            // Closing a visitor's last tab removes exactly that visitor (the observer stays).
            let remaining = layout.length
            for (const [index, { leaves }] of layout.entries()) {
              if (index === 0 || !leaves) continue
              tabs[index][0].close()
              tabs[index] = []
              remaining--
            }
            expect(await settledCount(observer, remaining), JSON.stringify(layout)).toBe(remaining)
          } finally {
            for (const socket of tabs.flat()) { try { socket.close() } catch { /* closed */ } }
            // Let the closes land so the next run starts from an empty room.
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
        },
      ),
      { numRuns: 8, endOnFailure: true },
    )
  })

  it('keeps a server-issued visitor cookie stable when the browser re-bootstraps with it', async () => {
    const visitor = await issueVisitor()
    const again = await runtime.dispatchFetch(`${origin}/api/presence/visitor`, {
      method: 'POST', headers: { origin, cookie: `__Host-presence=${visitor}` },
    })
    expect(again.status).toBe(204)
    expect(again.headers.get('set-cookie')).toMatch(new RegExp(`^__Host-presence=${visitor.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')};`, 'u'))
  })
})

describe('presence Owner verification fails closed and never writes D1 (3.5)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  const NOW = 1_000_000

  type Mode = 'owner' | 'user' | 'missing' | 'throws'
  const database = (mode: Mode, writes: string[], reads: string[]) => ({
    prepare(sql: string) {
      if (mode === 'throws') throw new Error('database unavailable')
      if (!/^\s*SELECT/iu.test(sql)) writes.push(sql)
      return {
        bind: (...binds: unknown[]) => ({
          first: async () => { reads.push(String(binds[0])); return mode === 'owner' ? { role: 'owner', expiresAt: NOW + 600_000 } : mode === 'user' ? { role: 'user', expiresAt: NOW + 600_000 } : null },
          run: async () => { writes.push(sql); return {} },
          all: async () => { writes.push(sql); return { results: [] } },
        }),
      }
    },
    batch: async () => { writes.push('batch'); return [] },
    exec: async () => { writes.push('exec'); return {} },
  })

  const identity = fc.record({
    visitor: fc.constantFrom('v1', 'v2', 'v3', 'v4'),
    sessionHash: fc.constantFrom('', 's1', 's2'),
    owner: fc.boolean(),
    // Lease relative to now: expired, at now, or still valid.
    expiresIn: fc.constantFrom(-1, 0, 1, 60_000, 600_000),
    // Last Owner check: due for the five-minute recheck or not.
    checkedAgo: fc.constantFrom(0, 1_000, OWNER_RECHECK_MS - 1, OWNER_RECHECK_MS, OWNER_RECHECK_MS + 5_000),
    // Heartbeat age: fresh or stale.
    seenAgo: fc.constantFrom(0, 30_000, STALE_MS - 1, STALE_MS, STALE_MS + 1),
  })

  it('re-verifies only due Owner leases, drops the Owner flag unless D1 confirms it, and performs no D1 write', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(identity, { minLength: 1, maxLength: 6 }), fc.constantFrom<Mode>('owner', 'user', 'missing', 'throws'), async (generated, mode) => {
        vi.useFakeTimers(); vi.setSystemTime(NOW)
        vi.stubGlobal('WebSocketRequestResponsePair', class { constructor(public request: string, public response: string) {} })
        const writes: string[] = []
        const reads: string[] = []
        const closed: Array<number | undefined> = []
        const sockets = generated.map((item) => {
          let attachment: PresenceIdentity = {
            visitor: item.visitor, sessionHash: item.sessionHash, owner: item.owner,
            expiresAt: NOW + item.expiresIn, checkedAt: NOW - item.checkedAgo, lastSeen: NOW - item.seenAgo,
          }
          return {
            readyState: 1,
            deserializeAttachment: () => attachment,
            serializeAttachment: (next: PresenceIdentity) => { attachment = next },
            send: () => {},
            close(code?: number) { this.readyState = 3; closed.push(code) },
          }
        })
        let alarm: number | null = null
        const state = {
          acceptWebSocket: () => {}, getWebSockets: () => sockets, setWebSocketAutoResponse: () => {},
          getWebSocketAutoResponseTimestamp: () => null,
          storage: { getAlarm: async () => alarm, setAlarm: async (value: number) => { alarm = value }, deleteAlarm: async () => { alarm = null } },
        }
        const env = { DB: database(mode, writes, reads) } as unknown as PresenceEnv
        await new OnlinePresence(state as never, env).alarm()

        for (const [index, item] of generated.entries()) {
          const after = sockets[index].deserializeAttachment()
          const label = `${JSON.stringify(item)} mode=${mode}`
          if (item.seenAgo >= STALE_MS) {
            // Stale sockets are closed, not re-verified.
            expect(sockets[index].readyState, label).toBe(3)
            continue
          }
          expect(sockets[index].readyState, label).toBe(1)
          const due = item.owner && (item.expiresIn <= 0 || item.checkedAgo >= OWNER_RECHECK_MS)
          if (!due) {
            expect(after.owner, label).toBe(item.owner)
            continue
          }
          // A due Owner keeps the flag only when the lease is live and D1 says the role is owner.
          expect(after.owner, label).toBe(item.expiresIn > 0 && item.sessionHash !== '' && mode === 'owner')
          expect(after.checkedAt, label).toBe(NOW)
        }
        expect(closed.every((code) => code === 1001)).toBe(true)
        expect(writes, `mode=${mode}`).toEqual([])
        // Reads are deduplicated per session hash.
        expect(new Set(reads).size).toBe(reads.length)
        vi.useRealTimers(); vi.unstubAllGlobals()
      }),
      { numRuns: 60 },
    )
  })

  it('summarises distinct live visitors and a live Owner exactly', () => {
    fc.assert(
      fc.property(fc.array(identity, { maxLength: 8 }), (generated) => {
        const identities: PresenceIdentity[] = generated.map((item) => ({
          visitor: item.visitor, sessionHash: item.sessionHash, owner: item.owner,
          expiresAt: NOW + item.expiresIn, checkedAt: NOW - item.checkedAgo, lastSeen: NOW - item.seenAgo,
        }))
        const live = identities.filter((item) => NOW - item.lastSeen < STALE_MS)
        expect(presenceSummary(identities, NOW)).toEqual({
          type: 'presence',
          count: new Set(live.map((item) => item.visitor)).size,
          ownerOnline: live.some((item) => item.owner && item.expiresAt > NOW),
        })
      }),
      { numRuns: 200 },
    )
  })
})
