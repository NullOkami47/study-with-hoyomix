import type { AuthEnv } from './auth/routes'
import { hashSessionToken, readCookie, SESSION_COOKIE } from './auth/session'

const VISITOR_COOKIE = '__Host-presence'
const STALE_MS = 90_000
const OWNER_RECHECK_MS = 300_000
// Connection caps mirror community chat (M-07): per visitor and per object.
export const PRESENCE_MAX_SOCKETS_PER_VISITOR = 5
export const PRESENCE_MAX_SOCKETS = 2000
// Aggregate broadcasts are sent only on change and at most once per interval.
export const PRESENCE_BROADCAST_INTERVAL_MS = 1000
export interface PresenceNamespace { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
export interface PresenceEnv extends AuthEnv {
  PRESENCE?: PresenceNamespace
  /** HMAC key for server-issued visitor tokens (decision D5). Set only as a Worker secret. */
  PRESENCE_SECRET?: string
}
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

// Visitor token (M-07, D5): `<uuid>.<base64url(HMAC-SHA256(PRESENCE_SECRET, "presence:v1:" + uuid))>`,
// 80 cookie-safe characters. The UUID is always server-random; the browser never chooses it.
const TOKEN_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/
const TOKEN_CONTEXT = 'presence:v1:'
let signingKey: { secret: string; key: Promise<CryptoKey> } | undefined
const presenceKey = (secret: string) => {
  if (signingKey?.secret !== secret) {
    signingKey = { secret, key: crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) }
  }
  return signingKey.key
}
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0))
/** A missing or blank secret means presence is unavailable; unsigned IDs are never issued. */
export const presenceSecret = (env: Pick<PresenceEnv, 'PRESENCE_SECRET'>) => env.PRESENCE_SECRET?.trim() ? env.PRESENCE_SECRET : ''

export async function issuePresenceVisitor(secret: string, id: string = crypto.randomUUID()): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await presenceKey(secret), new TextEncoder().encode(TOKEN_CONTEXT + id))
  return `${id}.${base64url(new Uint8Array(signature))}`
}

/** Returns the visitor ID for a valid server-issued token, otherwise null. The MAC check is constant-time. */
export async function verifyPresenceVisitor(token: string, secret: string): Promise<string | null> {
  const match = TOKEN_PATTERN.exec(token)
  if (!match || !secret) return null
  let signature: Uint8Array
  try { signature = fromBase64url(match[2]) } catch { return null }
  if (signature.byteLength !== 32 || base64url(signature) !== match[2]) return null
  const valid = await crypto.subtle.verify('HMAC', await presenceKey(secret), signature, new TextEncoder().encode(TOKEN_CONTEXT + match[1]))
  return valid ? match[1] : null
}

const noStore = { 'cache-control': 'no-store' }
const unavailable = () => Response.json({ error: 'presence_unavailable' }, { status: 503, headers: noStore })
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
  if (!env.PRESENCE) return unavailable()
  // Fail closed for bootstrap and upgrade alike: without the key no identity can be issued or verified.
  const secret = presenceSecret(env)
  if (!secret) return unavailable()
  if (url.pathname === '/api/presence/visitor') {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const prior = readCookie(request, VISITOR_COOKIE)
    // The body is bounded but ignored: a client-supplied ID is never adopted (M-07).
    if (await readPresenceVisitorBody(request) === null) return new Response(null, { status: 413 })
    // A valid issued token stays stable; a forged, unsigned (pre-M-07) or stale-key token is replaced.
    const token = await verifyPresenceVisitor(prior, secret) ? prior : await issuePresenceVisitor(secret)
    return new Response(null, { status: 204, headers: { ...noStore, 'set-cookie': `${VISITOR_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400` } })
  }
  if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
  const visitor = await verifyPresenceVisitor(readCookie(request, VISITOR_COOKIE), secret)
  if (!visitor) return Response.json({ error: 'visitor_invalid' }, { status: 401, headers: noStore })
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
  // Coalescing state is in memory only. A pending frame is flushed by the alarm well before the
  // object could hibernate; after reconstruction the next change is always sent.
  private lastSent: string | null = null
  private lastSentAt = -Infinity
  private pendingAt: number | null = null
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
    if (!identities.length) { this.pendingAt = null; await this.state.storage.deleteAlarm(); return }
    const next = Math.min(this.pendingAt ?? Infinity, ...identities.map(identity => Math.min(identity.lastSeen + STALE_MS,
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
    // Caps are checked before accepting, so a rejected attempt costs no socket and no frame.
    const live = this.active()
    if (live.length >= PRESENCE_MAX_SOCKETS ||
      live.filter(socket => this.identity(socket).visitor === identity.visitor).length >= PRESENCE_MAX_SOCKETS_PER_VISITOR) {
      return Response.json({ error: 'connection_limit' }, { status: 429, headers: noStore })
    }
    const pair = new WebSocketPair()
    this.state.acceptWebSocket(pair[1])
    pair[1].serializeAttachment(identity)
    this.publish()
    await this.schedule()
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
  }
  webSocketMessage(socket: PresenceSocket, message: string | ArrayBuffer): void {
    // Heartbeats are handled by the runtime without waking this object. Refresh
    // requests only read the aggregate; they cannot renew a lease or claim a role.
    if (message !== 'refresh') return
    const payload = JSON.stringify(presenceSummary(this.active().map(item => this.identity(item)), Date.now()))
    // This tab now holds a value newer than the last broadcast; if the aggregate reverts before the
    // deferred frame, the next publish must still send it rather than treat it as unchanged.
    if (payload !== this.lastSent) this.lastSent = null
    socket.send(payload)
  }
  async webSocketClose(socket: PresenceSocket): Promise<void> { socket.close(); this.publish(socket); await this.schedule(socket) }
  async webSocketError(socket: PresenceSocket): Promise<void> { socket.close(1011, 'Connection failed'); this.publish(socket); await this.schedule(socket) }
  /**
   * Coalesced broadcast (M-07): the aggregate is sent only when it differs from the last frame,
   * and at most once per PRESENCE_BROADCAST_INTERVAL_MS. A change inside the interval is deferred
   * to the alarm (see schedule()), which recomputes the then-current aggregate.
   */
  private publish(exclude?: PresenceSocket): void {
    const now = Date.now()
    const sockets = this.active(exclude)
    const payload = JSON.stringify(presenceSummary(sockets.map(socket => this.identity(socket)), now))
    if (payload === this.lastSent) { this.pendingAt = null; return }
    if (now - this.lastSentAt < PRESENCE_BROADCAST_INTERVAL_MS) { this.pendingAt = this.lastSentAt + PRESENCE_BROADCAST_INTERVAL_MS; return }
    this.lastSent = payload; this.lastSentAt = now; this.pendingAt = null
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
    if (changed || this.pendingAt !== null) this.publish()
    await this.schedule()
  }
}
