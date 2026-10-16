import type { AuthEnv } from './auth/routes'
import { hashSessionToken, readCookie, SESSION_COOKIE } from './auth/session'

const VISITOR_COOKIE = '__Host-presence'
const STALE_MS = 90_000
const OWNER_RECHECK_MS = 300_000
export interface PresenceNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
export interface PresenceEnv extends AuthEnv { PRESENCE?: PresenceNamespace }
export interface PresenceIdentity { visitor: string; sessionHash: string; owner: boolean; expiresAt: number; checkedAt: number; lastSeen: number }
interface PresenceSocket extends WebSocket { serializeAttachment(value: PresenceIdentity): void; deserializeAttachment(): PresenceIdentity }
interface PresenceState {
  acceptWebSocket(socket: WebSocket): void
  getWebSockets(): PresenceSocket[]
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void
  getWebSocketAutoResponseTimestamp(socket: WebSocket): Date | null
  storage: { getAlarm(): Promise<number | null>; setAlarm(time: number): Promise<void>; deleteAlarm(): Promise<void> }
}
declare class WebSocketRequestResponsePair { constructor(request: string, response: string) }
export async function schedulePresenceAlarm(storage: PresenceState['storage'], now: number, next = now + STALE_MS): Promise<void> {
  const pending = await storage.getAlarm()
  if (pending === null || pending <= now || pending > next) await storage.setAlarm(next)
}
declare const WebSocketPair: { new(): { 0: WebSocket; 1: PresenceSocket } }

export const presenceOwner = async (env: PresenceEnv, sessionHash: string, now: number) => {
  if (!sessionHash) return null
  return env.DB.prepare(`SELECT sessions.expires_at AS expiresAt, users.role FROM sessions
    JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?
    AND sessions.revoked_at IS NULL AND sessions.expires_at > ? AND users.deleted_at IS NULL`)
    .bind(sessionHash, now).first<{ role: string; expiresAt: number }>()
}

export const presenceSummary = (identities: PresenceIdentity[], now: number) => ({
  type: 'presence' as const,
  count: new Set(identities.filter((item) => now - item.lastSeen < STALE_MS).map((item) => item.visitor)).size,
  ownerOnline: identities.some((item) => now - item.lastSeen < STALE_MS && item.owner && item.expiresAt > now),
})

const room = (env: PresenceEnv) => env.PRESENCE?.get(env.PRESENCE.idFromName('study-with-hoyomix'))
export async function readPresenceVisitorBody(request: Request): Promise<string | null> {
  const length = Number(request.headers.get('content-length'))
  if (Number.isFinite(length) && length > 100) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 100) { await reader.cancel(); return null }
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(bytes)
  } finally { reader.releaseLock() }
}

export const presenceRoute = async (request: Request, env: PresenceEnv): Promise<Response> => {
  const url = new URL(request.url)
  if (request.headers.get('origin') !== env.PUBLIC_ORIGIN || url.origin !== env.PUBLIC_ORIGIN) return new Response(null, { status: 403 })
  if (!env.PRESENCE) return Response.json({ error: 'presence_unavailable' }, { status: 503 })
  if (url.pathname === '/api/presence/visitor') {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const prior = readCookie(request, VISITOR_COOKIE)
    const supplied = await readPresenceVisitorBody(request)
    if (supplied === null) return new Response(null, { status: 413 })
    const visitor = /^[a-f0-9-]{36}$/.test(prior) ? prior : /^[a-f0-9-]{36}$/.test(supplied) ? supplied : crypto.randomUUID()
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'set-cookie': `${VISITOR_COOKIE}=${visitor}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400` } })
  }
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
  const visitor = readCookie(request, VISITOR_COOKIE)
  if (!/^[a-f0-9-]{36}$/.test(visitor)) return new Response(null, { status: 401 })
  const token = readCookie(request, SESSION_COOKIE)
  const sessionHash = token ? await hashSessionToken(token, env.SESSION_HMAC_SECRET, crypto) : ''
  const now = Date.now()
  const account = await presenceOwner(env, sessionHash, now)
  const identity: PresenceIdentity = { visitor, sessionHash, owner: account?.role === 'owner', expiresAt: account?.expiresAt ?? 0, checkedAt: now, lastSeen: now }
  // Construct a fresh internal request: no client-supplied identity headers survive.
  return room(env)!.fetch(new Request('https://presence.internal/connect', { headers: { upgrade: 'websocket', 'x-presence-identity': JSON.stringify(identity) } }))
}

/** Only transient socket attachments and one alarm are persisted. Never writes D1. */
export class OnlinePresence {
  constructor(private state: PresenceState, private env: PresenceEnv) {
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }
  private identity(socket: PresenceSocket): PresenceIdentity {
    const identity = socket.deserializeAttachment()
    return { ...identity, lastSeen: Math.max(identity.lastSeen, this.state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0) }
  }
  private active(exclude?: PresenceSocket): PresenceSocket[] {
    const now = Date.now()
    return this.state.getWebSockets().filter(socket => socket !== exclude && socket.readyState === 1 && now - this.identity(socket).lastSeen < STALE_MS)
  }
  private async schedule(exclude?: PresenceSocket): Promise<void> {
    const now = Date.now()
    const identities = this.active(exclude).map(socket => this.identity(socket))
    if (!identities.length) { await this.state.storage.deleteAlarm(); return }
    const next = Math.min(...identities.map(identity => Math.min(identity.lastSeen + STALE_MS,
      identity.owner ? Math.min(identity.expiresAt, identity.checkedAt + OWNER_RECHECK_MS) : Infinity)))
    await schedulePresenceAlarm(this.state.storage, now, Math.max(now + 1, next))
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/revalidate') {
      for (const socket of this.state.getWebSockets()) {
        const identity = socket.deserializeAttachment()
        if (identity.owner) socket.serializeAttachment({ ...identity, checkedAt: 0 })
      }
      await this.alarm()
      return new Response(null, { status: 204 })
    }
    const identity = JSON.parse(request.headers.get('x-presence-identity')!) as PresenceIdentity
    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1])
    pair[1].serializeAttachment(identity)
    this.broadcast()
    await this.schedule()
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
  }
  webSocketMessage(socket: PresenceSocket, message: string | ArrayBuffer): void {
    // Heartbeats are handled by the runtime without waking this object. Refresh
    // requests only read the aggregate; they cannot renew a lease or claim a role.
    if (message !== 'refresh') return
    socket.send(JSON.stringify(presenceSummary(this.active().map(item => this.identity(item)), Date.now())))
  }
  async webSocketClose(socket: PresenceSocket): Promise<void> { socket.close(); this.broadcast(socket); await this.schedule(socket) }
  async webSocketError(socket: PresenceSocket): Promise<void> { socket.close(1011, 'Connection failed'); this.broadcast(socket); await this.schedule(socket) }
  private broadcast(exclude?: PresenceSocket): void {
    const sockets = this.active(exclude)
    const payload = JSON.stringify(presenceSummary(sockets.map(socket => this.identity(socket)), Date.now()))
    for (const socket of sockets) { try { socket.send(payload) } catch { socket.close() } }
  }
  async alarm(): Promise<void> {
    const now = Date.now()
    let changed = false
    const checked = new Map<string, Awaited<ReturnType<typeof presenceOwner>>>()
    for (const socket of this.state.getWebSockets()) {
      if (socket.readyState !== 1) continue
      const identity = this.identity(socket)
      if (now - identity.lastSeen >= STALE_MS) { socket.close(1001, 'Heartbeat expired'); changed = true; continue }
      if (identity.owner && (identity.expiresAt <= now || now - identity.checkedAt >= OWNER_RECHECK_MS)) {
        let account = null
        if (identity.expiresAt > now) {
          try {
            if (!checked.has(identity.sessionHash)) checked.set(identity.sessionHash, await presenceOwner(this.env, identity.sessionHash, now))
            account = checked.get(identity.sessionHash) ?? null
          } catch { /* Fail closed: do not keep displaying an unverified Owner. */ }
        }
        socket.serializeAttachment({ ...identity, owner: account?.role === 'owner', expiresAt: account?.expiresAt ?? 0, checkedAt: now })
        changed ||= identity.owner !== (account?.role === 'owner')
      }
    }
    if (changed) this.broadcast()
    await this.schedule()
  }
}
