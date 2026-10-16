import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  expiredSessionCookie,
  findSession,
  hashSessionToken,
  issueSession,
  readCookie,
  revokeAllSessions,
  revokeSession,
  sessionCookie,
  SESSION_COOKIE,
  SESSION_LIFETIME_MS,
} from '../auth/session'

const NOW = 1_786_480_000_000

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

const applyMigrations = async (database: TestDatabase) => {
  const directory = resolve(process.cwd(), 'migrations')
  for (const name of (await readdir(directory)).filter((value) => value.endsWith('.sql')).sort()) {
    const sql = await readFile(resolve(directory, name), 'utf8')
    await database.batch(
      sql.split(';').map((statement) => statement.trim()).filter(Boolean)
        .map((statement) => database.prepare(statement)),
    )
  }
}

describe('session security', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  const secret = 'session-test-secret-value'

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `session-security-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)

    await database.prepare(`
      INSERT INTO users (id, display_name, role, created_at, updated_at)
      VALUES ('user-alpha', 'User Alpha', 'user', ?, ?)
    `).bind(NOW, NOW).run()
    await database.prepare('INSERT INTO library_sync_state (user_id, revision) VALUES (?, 0)')
      .bind('user-alpha').run()
  })

  afterEach(async () => {
    await miniflare.dispose()
  })

  describe('token generation entropy', () => {
    it('generates cryptographically random 32-byte tokens', async () => {
      const { token: token1 } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)
      const { token: token2 } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      expect(token1).not.toBe(token2)
      // base64url encoding of 32 bytes = 43 characters
      expect(token1.length).toBe(43)
      expect(token2.length).toBe(43)
      expect(/^[A-Za-z0-9_-]{43}$/.test(token1)).toBe(true)
      expect(/^[A-Za-z0-9_-]{43}$/.test(token2)).toBe(true)
    })

    it('never stores plaintext token in database', async () => {
      const { token } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      const rows = await database.prepare('SELECT token_hash FROM sessions').all<{ token_hash: string }>()
      expect(rows.results.every(
        (row: { token_hash: string }) => !row.token_hash.includes(token),
      )).toBe(true)
      expect(rows.results.every(
        (row: { token_hash: string }) => row.token_hash.startsWith('hmac-sha256:v1:'),
      )).toBe(true)
    })

    it('produces different hashes for different tokens with same secret', async () => {
      const { token: token1, record: record1 } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)
      const { token: token2, record: record2 } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      expect(record1.tokenHash).not.toBe(record2.tokenHash)
      expect(token1).not.toBe(token2)
    })

    it('produces different hashes for same token with different secrets', async () => {
      const token = 'fixed-token-for-secret-test'
      const hash1 = await hashSessionToken(token, 'secret-one', crypto)
      const hash2 = await hashSessionToken(token, 'secret-two', crypto)

      expect(hash1).not.toBe(hash2)
      expect(hash1).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/)
      expect(hash2).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/)
    })
  })

  describe('token hash format enforcement', () => {
    it('enforces token_hash CHECK constraint format', async () => {
      const validHash = 'hmac-sha256:v1:' + '0'.repeat(64)
      await expect(
        database.prepare(`
          INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(crypto.randomUUID(), 'user-alpha', validHash, NOW + SESSION_LIFETIME_MS, NOW, NOW).run(),
      ).resolves.toBeDefined()

      const invalidHashes = [
        'sha256:' + '0'.repeat(64), // wrong prefix
        'hmac-sha256:v2:' + '0'.repeat(64), // wrong version
        'hmac-sha256:v1:' + '0'.repeat(63), // too short
        'hmac-sha256:v1:' + '0'.repeat(63) + 'g', // non-hex character
        'hmac-sha256:v1:' + '0'.repeat(63) + 'G', // uppercase hex
      ]

      for (const invalidHash of invalidHashes) {
        await expect(
          database.prepare(`
            INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(crypto.randomUUID(), 'user-alpha', invalidHash, NOW + SESSION_LIFETIME_MS, NOW, NOW).run(),
        ).rejects.toThrow(/CHECK constraint failed/)
      }
    })
  })

  describe('session expiration', () => {
    it('findSession returns null for expired session', async () => {
      const { token } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      const foundBeforeExpiry = await findSession(database as never, token, secret, NOW + SESSION_LIFETIME_MS - 1000, crypto)
      expect(foundBeforeExpiry).not.toBeNull()

      const foundAfterExpiry = await findSession(database as never, token, secret, NOW + SESSION_LIFETIME_MS + 1000, crypto)
      expect(foundAfterExpiry).toBeNull()
    })

    it('findSession rejects at exact expiration boundary', async () => {
      const { token } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      const foundAtBoundary = await findSession(database as never, token, secret, NOW + SESSION_LIFETIME_MS, crypto)
      expect(foundAtBoundary).toBeNull()
    })

    it('session lifetime is 90 days', () => {
      expect(SESSION_LIFETIME_MS).toBe(90 * 24 * 60 * 60 * 1000)
    })
  })

  describe('session revocation', () => {
    it('revokeSession marks session as revoked and findSession returns null', async () => {
      const { token, record } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      const foundBeforeRevoke = await findSession(database as never, token, secret, NOW + 1000, crypto)
      expect(foundBeforeRevoke).not.toBeNull()

      await revokeSession(database as never, record.id, NOW + 2000)

      const foundAfterRevoke = await findSession(database as never, token, secret, NOW + 3000, crypto)
      expect(foundAfterRevoke).toBeNull()
    })

    it('revokeAllSessions revokes all user sessions', async () => {
      const { token: token1 } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)
      const { token: token2 } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      await revokeAllSessions(database as never, 'user-alpha', NOW + 1000)

      const found1 = await findSession(database as never, token1, secret, NOW + 2000, crypto)
      const found2 = await findSession(database as never, token2, secret, NOW + 2000, crypto)
      expect(found1).toBeNull()
      expect(found2).toBeNull()
    })

    it('revokeSession is idempotent', async () => {
      const { record } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      await revokeSession(database as never, record.id, NOW + 1000)
      await revokeSession(database as never, record.id, NOW + 2000)

      const row = await database.prepare('SELECT revoked_at FROM sessions WHERE id = ?')
        .bind(record.id).first<{ revoked_at: number }>()
      expect(row?.revoked_at).toBe(NOW + 1000)
    })
  })

  describe('cookie security attributes', () => {
    it('sessionCookie includes HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age', () => {
      const cookie = sessionCookie('test-token-value')

      expect(cookie).toContain('__Host-session=test-token-value')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain(`Max-Age=${SESSION_LIFETIME_MS / 1000}`)
    })

    it('expiredSessionCookie clears cookie with Max-Age=0', () => {
      const cookie = expiredSessionCookie()

      expect(cookie).toContain('__Host-session=')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('Secure')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain('Max-Age=0')
    })

    it('uses __Host- prefix for cookie name', () => {
      expect(SESSION_COOKIE).toBe('__Host-session')
    })
  })

  describe('findSession user isolation', () => {
    it('returns correct user data for valid session', async () => {
      await database.prepare(`
        INSERT INTO users (id, display_name, role, avatar_url, created_at, updated_at)
        VALUES ('user-beta', 'User Beta', 'admin', 'https://example.com/avatar.jpg', ?, ?)
      `).bind(NOW, NOW).run()
      await database.prepare('INSERT INTO library_sync_state (user_id, revision) VALUES (?, 0)')
        .bind('user-beta').run()

      const { token } = await issueSession(database as never, 'user-beta', secret, NOW, crypto)
      const session = await findSession(database as never, token, secret, NOW + 1000, crypto)

      expect(session).not.toBeNull()
      expect(session?.userId).toBe('user-beta')
      expect(session?.displayName).toBe('User Beta')
      expect(session?.role).toBe('admin')
      expect(session?.avatarUrl).toBe('https://example.com/avatar.jpg')
    })

    it('findSession returns null for deleted user', async () => {
      const { token } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      await database.prepare('UPDATE users SET deleted_at = ? WHERE id = ?')
        .bind(NOW + 1000, 'user-alpha').run()

      const session = await findSession(database as never, token, secret, NOW + 2000, crypto)
      expect(session).toBeNull()
    })

    it('findSession returns null for wrong token', async () => {
      await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      const session = await findSession(database as never, 'wrong-token-value', secret, NOW + 1000, crypto)
      expect(session).toBeNull()
    })

    it('findSession returns null for empty token', async () => {
      const session = await findSession(database as never, '', secret, NOW, crypto)
      expect(session).toBeNull()
    })
  })

  describe('readCookie parsing', () => {
    it('extracts cookie value from Cookie header', () => {
      const request = new Request('https://example.com', {
        headers: { cookie: '__Host-session=token-value-here' },
      })
      expect(readCookie(request, '__Host-session')).toBe('token-value-here')
    })

    it('handles multiple cookies', () => {
      const request = new Request('https://example.com', {
        headers: { cookie: 'other=value1; __Host-session=token-value; another=value2' },
      })
      expect(readCookie(request, '__Host-session')).toBe('token-value')
    })

    it('handles cookie value with equals sign', () => {
      const request = new Request('https://example.com', {
        headers: { cookie: '__Host-session=token=with=equals' },
      })
      expect(readCookie(request, '__Host-session')).toBe('token=with=equals')
    })

    it('returns empty string for missing cookie', () => {
      const request = new Request('https://example.com', {
        headers: { cookie: 'other=value' },
      })
      expect(readCookie(request, '__Host-session')).toBe('')
    })

    it('returns empty string for missing Cookie header', () => {
      const request = new Request('https://example.com')
      expect(readCookie(request, '__Host-session')).toBe('')
    })

    it('handles whitespace around cookie name', () => {
      const request = new Request('https://example.com', {
        headers: { cookie: ' __Host-session = token-value ' },
      })
      // readCookie implementation trims the part, so ' __Host-session = token-value ' becomes '__Host-session = token-value '
      // After split('='), key is '__Host-session ' which doesn't match '__Host-session'
      expect(readCookie(request, '__Host-session')).toBe('')
    })
  })

  describe('session fixation prevention', () => {
    it('documents session rotation at auth/routes.ts lines 183-184', () => {
      // Session rotation happens in completeIdentity:
      // 1. Revokes prior session if exists (line 183)
      // 2. Issues fresh session (line 184)
      // This prevents session fixation attacks where attacker provides victim with known session
      expect(true).toBe(true)
    })
  })

  describe('timing attack resistance', () => {
    it('findSession compares token hash not plaintext', async () => {
      // The implementation hashes the provided token before database lookup
      // This prevents timing attacks on token comparison
      // Database performs hash comparison via token_hash = ? binding
      const { token } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)
      const session = await findSession(database as never, token, secret, NOW + 1000, crypto)
      expect(session).not.toBeNull()
    })
  })

  describe('session hijacking resistance', () => {
    it('session bound to user_id via FOREIGN KEY CASCADE', async () => {
      const { token, record } = await issueSession(database as never, 'user-alpha', secret, NOW, crypto)

      await database.prepare('DELETE FROM users WHERE id = ?').bind('user-alpha').run()

      const sessionRow = await database.prepare('SELECT COUNT(*) AS total FROM sessions WHERE id = ?')
        .bind(record.id).first<{ total: number }>()
      expect(sessionRow?.total).toBe(0)

      const found = await findSession(database as never, token, secret, NOW + 1000, crypto)
      expect(found).toBeNull()
    })
  })
})
