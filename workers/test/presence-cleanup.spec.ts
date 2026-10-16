import { afterEach, expect, it, vi } from 'vitest'
import { OnlinePresence, presenceRoute, type PresenceEnv, type PresenceIdentity } from '../presence'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

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
  const env = { PUBLIC_ORIGIN: 'https://study.example', DB: { prepare: () => { throw new Error('unexpected D1 access') } },
    PRESENCE: { idFromName: () => 'room', get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) } } as unknown as PresenceEnv
  const id = 'a0000000-0000-4000-8000-000000000001'
  expect((await presenceRoute(new Request('https://study.example/api/presence/visitor', {
    method: 'POST', headers: { origin: 'https://study.example' }, body: id }), env)).status).toBe(204)
  expect((await presenceRoute(new Request('https://study.example/api/presence', {
    headers: { origin: 'https://study.example', upgrade: 'websocket', cookie: `__Host-presence=${id}` } }), env)).status).toBe(204)
  const f = fixture([{ ...visitor, lastSeen: 60_000 }], 0, env)
  f.room.webSocketMessage(f.sockets[0] as never, 'refresh')
  f.room.webSocketMessage(f.sockets[0] as never, '{"owner":true}')
  await f.room.alarm()
  expect(f.messages).toHaveLength(1)
  expect(JSON.parse(f.messages[0])).toMatchObject({ count: 1, ownerOnline: false })
})
