import type { Database } from '../db'

export const SESSION_COOKIE = '__Host-session'
export const SESSION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000

const encoder = new TextEncoder()

const toHex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')

const tokenBytes = (cryptoApi: Crypto) => {
  const bytes = new Uint8Array(32)
  cryptoApi.getRandomValues(bytes)
  return bytes
}

const base64Url = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export const hashSessionToken = async (token: string, secret: string, cryptoApi: Crypto) => {
  const key = await cryptoApi.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return `hmac-sha256:v1:${toHex(await cryptoApi.subtle.sign('HMAC', key, encoder.encode(token)))}`
}

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_LIFETIME_MS / 1000}`

export const expiredSessionCookie = () =>
  `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`

export interface SessionRecord {
  id: string
  userId: string
  tokenHash: string
  expiresAt: number
}

export const issueSession = async (
  database: Database,
  userId: string,
  secret: string,
  now: number,
  cryptoApi: Crypto,
) => {
  const token = base64Url(tokenBytes(cryptoApi))
  const record: SessionRecord = {
    id: cryptoApi.randomUUID(),
    userId,
    tokenHash: await hashSessionToken(token, secret, cryptoApi),
    expiresAt: now + SESSION_LIFETIME_MS,
  }
  await database.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(record.id, userId, record.tokenHash, record.expiresAt, now, now).run()
  return { token, record }
}

export const findSession = async (
  database: Database,
  token: string,
  secret: string,
  now: number,
  cryptoApi: Crypto,
) => {
  if (!token) return null
  const tokenHash = await hashSessionToken(token, secret, cryptoApi)
  return database.prepare(`
    SELECT sessions.id, sessions.user_id AS userId, users.display_name AS displayName,
      users.avatar_url AS avatarUrl, users.role
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL
      AND sessions.expires_at > ? AND users.deleted_at IS NULL
  `).bind(tokenHash, now).first<{
    id: string
    userId: string
    displayName: string
    avatarUrl: string | null
    role: 'user' | 'moderator' | 'admin' | 'owner'
  }>()
}

export const revokeSession = async (database: Database, sessionId: string, now: number) => {
  await database.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(now, sessionId).run()
}

export const revokeAllSessions = async (database: Database, userId: string, now: number) => {
  await database.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(now, userId).run()
}

export const readCookie = (request: Request, name: string) => {
  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return ''
}
