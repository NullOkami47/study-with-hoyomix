import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { Miniflare } from './miniflare-compat'
import { hashSessionToken } from '../auth/session'
import { issuePresenceVisitor, presenceSummary, readPresenceVisitorBody, schedulePresenceAlarm, type PresenceNamespace } from '../presence'
import { applyApiSecurityHeaders } from '../index'

const origin = 'https://study.example'
const secret = 'test-session-secret-presence'
let runtime: Miniflare
let db: Awaited<ReturnType<Miniflare['getD1Database']>>
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['workers/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' })
  runtime = new Miniflare({ modules: true, script: bundle.outputFiles![0].text, compatibilityDate: '2025-12-01',
    durableObjects: { PRESENCE: { className: 'OnlinePresence', useSQLite: true } }, d1Databases: { DB: 'presence-test' },
    // PRESENCE_SECRET (decision D5) is a fixture value; the Worker signs visitor IDs with it.
    bindings: { PUBLIC_ORIGIN: origin, SESSION_HMAC_SECRET: secret, PRESENCE_SECRET: 'presence-secret-with-at-least-thirty-two-characters' } })
  db = await runtime.getD1Database('DB')
  await db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, deleted_at INTEGER);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT, token_hash TEXT, expires_at INTEGER, revoked_at INTEGER);`)
  // M-07 (deliberate test change): the shared visitor is the token the server issued, no longer
  // a fixed client-chosen UUID, which the fixed upgrade rejects with 401 visitor_invalid.
  const issued = await runtime.dispatchFetch(`${origin}/api/presence/visitor`, { method: 'POST', headers: { origin } })
  visitor = (issued.headers.get('set-cookie') ?? '').match(/^__Host-presence=([^;]+)/)?.[1] ?? ''
})
afterAll(async () => { await runtime?.dispose() })

type Socket = NonNullable<Awaited<ReturnType<Miniflare['dispatchFetch']>>['webSocket']>
const clientChosenVisitor = 'a0000000-0000-4000-8000-000000000001'
let visitor = ''
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
    // M-07 (deliberate test change): the body used to become the visitor ID. The fixed route
    // ignores it and issues `<server-random uuid>.<HMAC>` with the same cookie attributes.
    const response = await runtime.dispatchFetch(`${origin}/api/presence/visitor`, { method: 'POST', headers: { origin }, body: clientChosenVisitor })
    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const header = response.headers.get('set-cookie') ?? ''
    expect(header).toMatch(/^__Host-presence=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=86400$/)
    expect(header).not.toContain(clientChosenVisitor)
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
    const other = await connect(visitor, role)
    // M-07 (deliberate test change): a second tab of the same visitor no longer triggers a
    // broadcast (the aggregate is unchanged and broadcasts are coalesced), so read it explicitly.
    const summary = next(socket); socket.send('refresh')
    expect((await summary).count).toBe(1)
    other.close(); socket.close()
  })
  it('deduplicates anonymous tabs and removes the visitor only after the last disconnect', async () => {
    // M-07 (deliberate test change): the aggregate is read with `refresh` instead of waiting for a
    // per-connect/per-close broadcast, which the fix only sends when the aggregate changes.
    const read = (socket: Socket) => { const result = next(socket); socket.send('refresh'); return result }
    const first = await connect()
    const second = await connect()
    expect(await read(first)).toEqual({ type: 'presence', count: 1, ownerOnline: false })
    first.close()
    expect((await read(second)).count).toBe(1)
    second.close()
    const reconnect = await connect()
    const last = await connect()
    expect((await read(reconnect)).count).toBe(1)
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

// Wave F exploration (task 21, design Property 9, M-07, decision D5). Expected to FAIL on the
// unfixed tree: visitor IDs are client-chosen and presence has no per-visitor socket cap.
describe('M-07 signed presence identities and connection caps (Property 9)', () => {
  const upgrade = (cookie: string) => runtime.dispatchFetch(`${origin}/api/presence`, {
    headers: { origin, upgrade: 'websocket', cookie },
  })
  const issuedVisitorCookie = async () => {
    const response = await runtime.dispatchFetch(`${origin}/api/presence/visitor`, { method: 'POST', headers: { origin } })
    expect(response.status).toBeLessThan(300)
    const value = (response.headers.get('set-cookie') ?? '').match(/__Host-presence=([^;]+)/)?.[1] ?? ''
    expect(value).not.toBe('')
    return `__Host-presence=${value}`
  }
  it('rejects 10 client-minted visitor IDs with 401 visitor_invalid', async () => {
    const statuses: number[] = []
    const bodies: string[] = []
    const opened: Socket[] = []
    for (let index = 0; index < 10; index++) {
      const minted = `b0000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
      const response = await upgrade(`__Host-presence=${minted}`)
      statuses.push(response.status)
      if (response.webSocket) { response.webSocket.accept(); opened.push(response.webSocket) }
      else bodies.push(await response.text())
    }
    let count: number | null = null
    if (opened.length) {
      const aggregate = next(opened[0])
      opened[0].send('refresh')
      count = (await aggregate).count
    }
    for (const socket of opened) socket.close()
    expect(statuses, `statuses=${statuses.join(',')} presenceCount=${count}`).toEqual(Array(10).fill(401))
    for (const body of bodies) expect(JSON.parse(body)).toEqual({ error: 'visitor_invalid' })
  })
  it('does not adopt a client-supplied visitor ID at bootstrap', async () => {
    const minted = 'c0000000-0000-4000-8000-00000000000c'
    const response = await runtime.dispatchFetch(`${origin}/api/presence/visitor`, { method: 'POST', headers: { origin }, body: minted })
    expect(response.headers.get('set-cookie') ?? '').not.toContain(minted)
  })
  it('rejects a forged signature, a token signed with another key and a bare issued ID', async () => {
    const [id, signature] = (await issuedVisitorCookie()).slice('__Host-presence='.length).split('.')
    const forged = `${id}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
    const otherKey = await issuePresenceVisitor('another-fixture-presence-secret-of-enough-length', id)
    for (const value of [forged, otherKey, id]) {
      const response = await upgrade(`__Host-presence=${value}`)
      expect(response.status, value).toBe(401)
      expect(await response.json()).toEqual({ error: 'visitor_invalid' })
    }
  })
  it('rejects the sixth concurrent socket for one server-issued visitor with 429 connection_limit', async () => {
    const cookie = await issuedVisitorCookie()
    const opened: Socket[] = []
    const statuses: number[] = []
    let sixth: Awaited<ReturnType<typeof upgrade>> | null = null
    try {
      for (let index = 0; index < 6; index++) {
        const response = await upgrade(cookie)
        statuses.push(response.status)
        if (response.webSocket) { response.webSocket.accept(); opened.push(response.webSocket) }
        if (index === 5) sixth = response
      }
      expect(statuses.slice(0, 5), `statuses=${statuses.join(',')}`).toEqual(Array(5).fill(101))
      expect(sixth!.status, `statuses=${statuses.join(',')}`).toBe(429)
      expect(await sixth!.json()).toEqual({ error: 'connection_limit' })
    } finally {
      for (const socket of opened) socket.close()
    }
  })
})
