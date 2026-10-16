import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from './miniflare-compat'
import { hashSessionToken } from '../auth/session'
import { presenceSummary, readPresenceVisitorBody, schedulePresenceAlarm, type PresenceNamespace } from '../presence'
import { applyApiSecurityHeaders } from '../index'

const origin = 'https://study.example'
const secret = 'test-session-secret-presence'
let runtime: Miniflare
let db: Awaited<ReturnType<Miniflare['getD1Database']>>
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['workers/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' })
  runtime = new Miniflare({ modules: true, script: bundle.outputFiles![0].text, compatibilityDate: '2025-12-01',
    durableObjects: { PRESENCE: { className: 'OnlinePresence', useSQLite: true } }, d1Databases: { DB: 'presence-test' },
    bindings: { PUBLIC_ORIGIN: origin, SESSION_HMAC_SECRET: secret } })
  db = await runtime.getD1Database('DB')
  await db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, deleted_at INTEGER);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT, expires_at INTEGER, revoked_at INTEGER);`)
})
afterAll(async () => { await runtime?.dispose() })

const visitor = 'a0000000-0000-4000-8000-000000000001'
async function connect(id = visitor, token = '', extra: Record<string, string> = {}) {
  const response = await runtime.dispatchFetch(`${origin}/api/presence`, { headers: {
    origin, upgrade: 'websocket', cookie: `__Host-presence=${id}; __Host-session=${token}`, ...extra,
  } })
  expect(response.status).toBe(101)
  const socket = response.webSocket!
  socket.accept()
  return socket
}
const next = (socket: Awaited<ReturnType<typeof connect>>, matches = (_value: { count: number; ownerOnline: boolean }) => true) => new Promise<{ count: number; ownerOnline: boolean }>((resolve) => {
  const handler = (event: { data: unknown }) => {
    if (event.data === 'pong') return
    const payload = JSON.parse(String(event.data))
    if (!matches(payload)) return
    socket.removeEventListener('message', handler)
    resolve(payload)
  }
  socket.addEventListener('message', handler)
})

describe('own-site Durable Object presence', () => {
  it('responds to heartbeat through the runtime and serves an explicit aggregate refresh', async () => {
    const socket = await connect()
    const pong = new Promise(resolve => {
      const handler = (event: { data: unknown }) => {
        if (event.data !== 'pong') return
        socket.removeEventListener('message', handler); resolve(event.data)
      }
      socket.addEventListener('message', handler)
    })
    socket.send('ping')
    expect(await pong).toBe('pong')
    const aggregate = next(socket); socket.send('refresh')
    expect(await aggregate).toEqual({ type: 'presence', count: 1, ownerOnline: false })
    socket.close()
  })
  it('does not postpone the existing cleanup alarm when visitors continuously join', async () => {
    let alarm: number | null = null
    const storage = { getAlarm: async () => alarm, setAlarm: async (time: number) => { alarm = time }, deleteAlarm: async () => { alarm = null } }
    await schedulePresenceAlarm(storage, 0)
    expect(alarm).toBe(90_000)
    for (let join = 5000; join < 30_000; join += 5000) await schedulePresenceAlarm(storage, join)
    expect(alarm).toBe(90_000)
  })
  it('rejects oversized visitor bodies, including streamed requests without Content-Length', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(101)) }, cancel() { cancelled = true } })
    const request = new Request(`${origin}/api/presence/visitor`, { method: 'POST', body, duplex: 'half' } as RequestInit)
    expect(await readPresenceVisitorBody(request)).toBeNull()
    expect(cancelled).toBe(true)
    const response = await runtime.dispatchFetch(`${origin}/api/presence/visitor`, { method: 'POST', headers: { origin }, body: 'x'.repeat(101) })
    expect(response.status).toBe(413)
  })
  it('preserves the actual 101 upgrade object in the security wrapper', () => {
    const upgrade = { status: 101, webSocket: {} } as unknown as Response
    expect(applyApiSecurityHeaders(upgrade)).toBe(upgrade)
  })
  it('rejects cross-origin upgrades and absent bootstrap identity', async () => {
    expect((await runtime.dispatchFetch(`${origin}/api/presence`, { headers: { origin: 'https://attacker.example', upgrade: 'websocket' } })).status).toBe(403)
    expect((await runtime.dispatchFetch(`${origin}/api/presence`, { headers: { origin, upgrade: 'websocket' } })).status).toBe(401)
  })
  it('bootstraps a shared random visitor cookie without a D1 read', async () => {
    const response = await runtime.dispatchFetch(`${origin}/api/presence/visitor`, { method: 'POST', headers: { origin }, body: visitor })
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain(`__Host-presence=${visitor}; HttpOnly; Secure; SameSite=Strict`)
  })
  it.each(['user', 'admin', 'owner'])('derives %s from the final account role, ignoring forged headers/messages', async (role) => {
    const hash = await hashSessionToken(role, secret, crypto)
    await db.prepare('INSERT INTO users (id, role) VALUES (?, ?)').bind(role, role).run()
    await db.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at) VALUES (?,?,?,?)').bind(role, role, hash, Date.now() + 600_000).run()
    const socket = await connect(visitor, role, { 'x-presence-identity': JSON.stringify({ owner: true }) })
    const result = next(socket)
    socket.send('refresh')
    expect((await result).ownerOnline).toBe(role === 'owner')
    socket.send('{"owner":true,"admin":true}')
    const summary = next(socket)
    const other = await connect(visitor, role)
    expect((await summary).count).toBe(1)
    other.close(); socket.close()
  })
  it('deduplicates anonymous tabs and removes the visitor only after the last disconnect', async () => {
    const first = await connect()
    const update = next(first)
    const second = await connect()
    expect(await update).toEqual({ type: 'presence', count: 1, ownerOnline: false })
    const disconnected = next(second)
    first.close()
    expect((await disconnected).count).toBe(1)
    second.close()
    const reconnect = await connect()
    const updateAgain = next(reconnect)
    const last = await connect()
    expect((await updateAgain).count).toBe(1)
    last.close(); reconnect.close()
  })
  it('filters expired connections and expired Owner leases without inventing a zero for unknown state', () => {
    const identity = { visitor, sessionHash: 'private', owner: true, expiresAt: 100, checkedAt: 0, lastSeen: 0 }
    expect(presenceSummary([identity], 101)).toEqual({ type: 'presence', count: 1, ownerOnline: false })
    expect(presenceSummary([identity], 90_001)).toEqual({ type: 'presence', count: 0, ownerOnline: false })
  })
  it('immediately clears revoked Owner sessions in every connected tab on revocation refresh', async () => {
    const socket = await connect(visitor, 'owner')
    const before = next(socket); socket.send('refresh')
    expect((await before).ownerOnline).toBe(true)
    await db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?').bind(Date.now(), 'owner').run()
    const namespace = await runtime.getDurableObjectNamespace('PRESENCE') as unknown as PresenceNamespace
    // Older broadcasts may already be in flight when revocation commits.
    const after = next(socket, (payload) => !payload.ownerOnline)
    await namespace.get(namespace.idFromName('study-with-hoyomix')).fetch(new Request('https://presence.internal/revalidate', { method: 'POST' }))
    expect((await after).ownerOnline).toBe(false)
    socket.close()
  })
})
