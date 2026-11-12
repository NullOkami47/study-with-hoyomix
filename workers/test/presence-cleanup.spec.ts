import fc from 'fast-check'
import { afterEach, expect, it, vi } from 'vitest'
import { issuePresenceVisitor, OnlinePresence, PRESENCE_BROADCAST_INTERVAL_MS, presenceRoute, verifyPresenceVisitor, type PresenceEnv, type PresenceIdentity } from '../presence'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const FIXTURE_PRESENCE_SECRET = 'fixture-presence-secret-with-at-least-32-characters'

function fixture(identities: PresenceIdentity[], autoSeen = 0, env = {} as PresenceEnv) {
  vi.useFakeTimers(); vi.setSystemTime(60_000)
  vi.stubGlobal('WebSocketRequestResponsePair', class { constructor(public request: string, public response: string) {} })
  const messages: string[] = []
  const closed: number[] = []
  const sockets = identities.map(identity => ({ readyState: 1, deserializeAttachment: () => identity,
    serializeAttachment: (next: PresenceIdentity) => { identity = next }, send: (value: string) => messages.push(value),
    close(code?: number) { this.readyState = 2; closed.push(code ?? 1000) } }))
  let alarm: number | null = null
  let pair: unknown
  const state = { acceptWebSocket: () => {}, getWebSockets: () => sockets,
    setWebSocketAutoResponse: (value: unknown) => { pair = value },
    getWebSocketAutoResponseTimestamp: () => autoSeen ? new Date(autoSeen) : null,
    storage: { getAlarm: async () => alarm, setAlarm: async (value: number) => { alarm = value }, deleteAlarm: async () => { alarm = null } } }
  const room = new OnlinePresence(state as never, env)
  return { room, state, sockets, messages, closed, alarm: () => alarm, pair: () => pair }
}
const visitor = { visitor: 'local', sessionHash: '', owner: false, expiresAt: 0, checkedAt: 0, lastSeen: 0 }

it('configures a hibernation auto-response on construction', () => {
  const f = fixture([])
  expect(f.pair()).toMatchObject({ request: 'ping', response: 'pong' })
})
it('uses the runtime heartbeat timestamp after reconstruction without rewriting attachments', async () => {
  const f = fixture([{ ...visitor }], 50_000)
  vi.setSystemTime(100_000)
  await f.room.alarm()
  expect(f.closed).toEqual([])
  expect(f.sockets[0].deserializeAttachment().lastSeen).toBe(0)
  expect(f.alarm()).toBe(140_000)
  expect(f.messages).toEqual([])
})
it('closes stale sockets once and removes the alarm even if close handshake is still pending', async () => {
  const f = fixture([{ ...visitor }])
  await f.state.storage.setAlarm(60_000)
  vi.setSystemTime(90_000)
  await f.room.alarm()
  expect(f.closed).toEqual([1001])
  expect(f.alarm()).toBeNull()
  await f.room.alarm()
  expect(f.closed).toEqual([1001])
})
it('schedules exact Owner expiry sooner than the next stale deadline and fails closed at expiry', async () => {
  const f = fixture([{ ...visitor, owner: true, expiresAt: 70_000, checkedAt: 60_000, lastSeen: 60_000 }])
  await f.room.alarm()
  expect(f.alarm()).toBe(70_000)
  vi.setSystemTime(70_000)
  await f.room.alarm()
  expect(JSON.parse(f.messages[f.messages.length - 1])).toMatchObject({ ownerOnline: false })
  expect(f.alarm()).toBe(150_000)
})

it('bounds periodic Owner revalidation to five minutes and deduplicates the session read', async () => {
  let reads = 0
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => { reads++; return { role: 'user', expiresAt: 900_000 } } }) }) } } as unknown as PresenceEnv
  const owner = { ...visitor, owner: true, sessionHash: 'same-session', checkedAt: 60_000, expiresAt: 900_000, lastSeen: 60_000 }
  const f = fixture([owner, { ...owner }], 350_000, env)
  vi.setSystemTime(350_000)
  await f.room.alarm()
  expect(f.alarm()).toBe(360_000)
  vi.setSystemTime(360_000)
  await f.room.alarm()
  expect(reads).toBe(1)
  expect(f.sockets.every(socket => !socket.deserializeAttachment().owner)).toBe(true)
  expect(JSON.parse(f.messages[0])).toMatchObject({ count: 1, ownerOnline: false })
})

it('fails closed when periodic Owner verification cannot read the database', async () => {
  const env = { DB: { prepare: () => { throw new Error('database unavailable') } } } as unknown as PresenceEnv
  const f = fixture([{ ...visitor, owner: true, sessionHash: 'session', expiresAt: 900_000 }], 350_000, env)
  vi.setSystemTime(360_000)
  await f.room.alarm()
  expect(f.sockets[0].deserializeAttachment().owner).toBe(false)
})

it('performs no D1 read or write for anonymous bootstrap, upgrade, heartbeat cleanup or refresh', async () => {
  const env = { PUBLIC_ORIGIN: 'https://study.example', PRESENCE_SECRET: FIXTURE_PRESENCE_SECRET, DB: { prepare: () => { throw new Error('unexpected D1 access') } },
    PRESENCE: { idFromName: () => 'room', get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) } } as unknown as PresenceEnv
  // M-07 (deliberate test change): the upgrade presents the server-issued signed token instead of
  // a client-chosen UUID; the fixed route needs a PRESENCE_SECRET binding (fixture value) to issue it.
  const bootstrap = await presenceRoute(new Request('https://study.example/api/presence/visitor', {
    method: 'POST', headers: { origin: 'https://study.example' } }), env)
  expect(bootstrap.status).toBe(204)
  const token = (bootstrap.headers.get('set-cookie') ?? '').match(/^__Host-presence=([^;]+)/)![1]
  expect((await presenceRoute(new Request('https://study.example/api/presence', {
    headers: { origin: 'https://study.example', upgrade: 'websocket', cookie: `__Host-presence=${token}` } }), env)).status).toBe(204)
  const f = fixture([{ ...visitor, lastSeen: 60_000 }], 0, env)
  f.room.webSocketMessage(f.sockets[0] as never, 'refresh')
  f.room.webSocketMessage(f.sockets[0] as never, '{"owner":true}')
  await f.room.alarm()
  expect(f.messages).toHaveLength(1)
  expect(JSON.parse(f.messages[0])).toMatchObject({ count: 1, ownerOnline: false })
})

// Wave F exploration (task 21, design Property 9, M-07). Expected to FAIL on the unfixed tree:
// OnlinePresence accepts every socket, so the 2001st connection is admitted and fanned out to all.
it('M-07: rejects the 2001st presence socket with 429 connection_limit before accepting it', async () => {
  const identities = Array.from({ length: 2000 }, (_, index) => ({
    ...visitor, visitor: `d${index.toString(16).padStart(35, '0')}`, lastSeen: 60_000,
  }))
  const f = fixture(identities, 0, {} as PresenceEnv)
  let accepted = 0
  f.state.acceptWebSocket = () => { accepted++ }
  const NativeResponse = globalThis.Response
  // Node's Response refuses status 101; this stand-in lets the unfixed upgrade path complete so
  // the counterexample is the admitted socket rather than a RangeError.
  class UpgradeTolerantResponse extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
      if (init?.status === 101) {
        super(null, { status: 200 })
        Object.defineProperty(this, 'status', { value: 101 })
      } else super(body, init)
    }
  }
  vi.stubGlobal('Response', UpgradeTolerantResponse)
  vi.stubGlobal('WebSocketPair', class {
    0 = {}
    1 = { readyState: 1, serializeAttachment() {}, deserializeAttachment: () => ({ ...visitor, visitor: 'newcomer', lastSeen: 60_000 }), send() {}, close() {} }
  })
  const identity = { ...visitor, visitor: 'e0000000-0000-4000-8000-000000002001', checkedAt: 60_000, lastSeen: 60_000 }
  const response = await f.room.fetch(new Request('https://presence.internal/connect', {
    headers: { upgrade: 'websocket', 'x-presence-identity': JSON.stringify(identity) },
  }))
  expect(response.status, `accepted=${accepted} broadcastFrames=${f.messages.length}`).toBe(429)
  expect(await response.json()).toEqual({ error: 'connection_limit' })
  expect(accepted).toBe(0)
  expect(f.messages).toHaveLength(0)
})

// M-07 fix checks (design Property 9, decision D5).
it('M-07: bootstrap and upgrade return 503 presence_unavailable while PRESENCE_SECRET is missing or blank', async () => {
  for (const secret of [undefined, '', '   ']) {
    const env = { PUBLIC_ORIGIN: 'https://study.example', PRESENCE_SECRET: secret, DB: { prepare: () => { throw new Error('unexpected D1 access') } },
      PRESENCE: { idFromName: () => 'room', get: () => ({ fetch: async () => { throw new Error('unexpected object call') } }) } } as unknown as PresenceEnv
    const bootstrap = await presenceRoute(new Request('https://study.example/api/presence/visitor', { method: 'POST', headers: { origin: 'https://study.example' } }), env)
    expect(bootstrap.status).toBe(503)
    expect(bootstrap.headers.get('set-cookie')).toBeNull()
    expect(await bootstrap.json()).toEqual({ error: 'presence_unavailable' })
    const upgrade = await presenceRoute(new Request('https://study.example/api/presence', {
      headers: { origin: 'https://study.example', upgrade: 'websocket', cookie: `__Host-presence=${await issuePresenceVisitor(FIXTURE_PRESENCE_SECRET)}` } }), env)
    expect(upgrade.status).toBe(503)
  }
})

/** **Validates: Requirements 2.7** (Property 9: only server-signed visitor IDs are accepted). */
it('M-07: an issued token verifies to its ID and every altered or foreign-key token is rejected', async () => {
  const hex = '0123456789abcdef'.split('')
  const uuid = fc.tuple(...[8, 4, 4, 4, 12].map(length => fc.array(fc.constantFrom(...hex), { minLength: length, maxLength: length }).map(chars => chars.join(''))))
    .map(parts => parts.join('-'))
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.'.split('')
  await fc.assert(fc.asyncProperty(uuid, fc.string({ minLength: 1, maxLength: 64 }), fc.nat(), fc.constantFrom(...alphabet), async (id, other, position, replacement) => {
    const token = await issuePresenceVisitor(FIXTURE_PRESENCE_SECRET, id)
    expect(token).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/)
    expect(await verifyPresenceVisitor(token, FIXTURE_PRESENCE_SECRET)).toBe(id)
    const index = position % token.length
    const altered = token.slice(0, index) + replacement + token.slice(index + 1)
    if (altered !== token) expect(await verifyPresenceVisitor(altered, FIXTURE_PRESENCE_SECRET)).toBeNull()
    expect(await verifyPresenceVisitor(id, FIXTURE_PRESENCE_SECRET)).toBeNull()
    if (other.trim() && other !== FIXTURE_PRESENCE_SECRET) expect(await verifyPresenceVisitor(token, other)).toBeNull()
  }), { numRuns: 100 })
})

it('M-07: connects send an aggregate frame only on change and at most once per interval; refresh answers at once', async () => {
  const f = fixture([])
  const frames = new Map<string, string[]>()
  const accepted: unknown[] = []
  ;(f.state as { acceptWebSocket: (socket: unknown) => void }).acceptWebSocket = (socket) => { accepted.push(socket); f.sockets.push(socket as never) }
  const NativeResponse = globalThis.Response
  class UpgradeTolerantResponse extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
      if (init?.status === 101) { super(null, { status: 200 }); Object.defineProperty(this, 'status', { value: 101 }) } else super(body, init)
    }
  }
  vi.stubGlobal('Response', UpgradeTolerantResponse)
  let label = ''
  vi.stubGlobal('WebSocketPair', class {
    0 = {}
    1 = (() => {
      const own: string[] = []; frames.set(label, own)
      let attachment: PresenceIdentity
      return { readyState: 1, serializeAttachment(next: PresenceIdentity) { attachment = next }, deserializeAttachment: () => attachment,
        send: (value: string) => own.push(value), close() { this.readyState = 3 } }
    })()
  })
  const connect = async (name: string, visitorId: string) => {
    label = name
    const identity = { ...visitor, visitor: visitorId, checkedAt: Date.now(), lastSeen: Date.now() }
    return f.room.fetch(new Request('https://presence.internal/connect', { headers: { upgrade: 'websocket', 'x-presence-identity': JSON.stringify(identity) } }))
  }
  const count = (name: string) => frames.get(name)!.map(frame => JSON.parse(frame).count)
  expect((await connect('a', 'visitor-a')).status).toBe(101)
  expect((await connect('b', 'visitor-b')).status).toBe(101)
  expect((await connect('c', 'visitor-c')).status).toBe(101)
  // Only the first change is sent immediately; the next two are deferred to one alarm.
  expect(count('a')).toEqual([1])
  expect(count('b')).toEqual([])
  expect(f.alarm()).toBe(60_000 + PRESENCE_BROADCAST_INTERVAL_MS)
  vi.setSystemTime(60_000 + PRESENCE_BROADCAST_INTERVAL_MS)
  await f.room.alarm()
  expect(count('a')).toEqual([1, 3])
  expect(count('b')).toEqual([3])
  expect(count('c')).toEqual([3])
  // Another tab of a counted visitor leaves the aggregate unchanged: no frame at all.
  vi.setSystemTime(65_000)
  expect((await connect('a2', 'visitor-a')).status).toBe(101)
  expect(count('a')).toEqual([1, 3])
  expect(count('a2')).toEqual([])
  // The explicit refresh is answered immediately, independent of coalescing.
  f.room.webSocketMessage(f.sockets[f.sockets.length - 1] as never, 'refresh')
  expect(count('a2')).toEqual([3])
  expect(accepted).toHaveLength(4)
  // A deferred change that reverts before the flush still corrects a tab that refreshed meanwhile.
  expect((await connect('d', 'visitor-d')).status).toBe(101)
  expect(count('a')).toEqual([1, 3, 4])
  vi.setSystemTime(65_100)
  expect((await connect('e', 'visitor-e')).status).toBe(101)
  f.room.webSocketMessage(f.sockets[0] as never, 'refresh')
  expect(count('a')).toEqual([1, 3, 4, 5])
  vi.setSystemTime(65_200)
  await f.room.webSocketClose(f.sockets[f.sockets.length - 1] as never)
  vi.setSystemTime(66_000)
  await f.room.alarm()
  expect(count('a')).toEqual([1, 3, 4, 5, 4])
})
