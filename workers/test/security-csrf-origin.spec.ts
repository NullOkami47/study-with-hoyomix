import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import worker from '../index'
import { issueSession } from '../auth/session'

const ORIGIN = 'https://study.example'
const NOW = 1_787_030_400_000

/**
 * Every value here is a cross-origin or ambiguous `Origin` that a browser could
 * attach to a forged request while still sending the `__Host-session` cookie.
 * `null` means the header is absent, which is what a form post from an opaque
 * origin looks like.
 */
const HOSTILE_ORIGINS: readonly (string | null)[] = [
  null,
  'null',
  'https://evil.example',
  'https://study.example.evil.example',
  'https://study.example@evil.example',
  'https://study.example:8443',
  'http://study.example',
  'https://STUDY.example',
  'https://study.example/',
  '',
]

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

/**
 * A whole-database fingerprint. A refused mutation must leave this byte
 * identical, which is a stronger claim than checking the one table the route
 * would have touched: it also catches an audit row or a revision row written
 * before the refusal.
 */
const snapshot = async (database: TestDatabase): Promise<string> => {
  const tables = await database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\'
    ORDER BY name
  `).all<{ name: string }>()
  const parts: string[] = []
  for (const { name } of tables.results) {
    const rows = await database.prepare(`SELECT * FROM "${name}"`).all()
    const serialised = (rows.results as Record<string, unknown>[])
      .map((row) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
      .sort()
    parts.push(`${name}:${JSON.stringify(serialised)}`)
  }
  return parts.join('\n')
}

interface Mutation {
  readonly label: string
  readonly method: string
  readonly path: string
  readonly actor: 'user' | 'admin'
  readonly body?: unknown
}

const NOTICE_ID = '9f1d6b6c-7c2e-4a5a-9f3d-2b7a6c5d4e3f'
const BACKGROUND_ID = '4c9a7f2e-3d61-4b8a-9c5e-1f2a3b4c5d6e'

const MUTATIONS: readonly Mutation[] = [
  { label: 'logout', method: 'POST', path: '/api/logout', actor: 'user' },
  { label: 'logout-all', method: 'POST', path: '/api/logout-all', actor: 'user' },
  { label: 'unlink google', method: 'POST', path: '/api/auth/google/unlink', actor: 'user' },
  { label: 'unlink github', method: 'POST', path: '/api/auth/github/unlink', actor: 'user' },
  {
    label: 'library merge',
    method: 'POST',
    path: '/api/library/merge',
    actor: 'user',
    body: { library: { favourites: [], playlists: [], recentHistory: [] } },
  },
  {
    label: 'record history',
    method: 'POST',
    path: '/api/history',
    actor: 'user',
    body: { id: 'h-1', trackId: 'youtube:aaaaaaaaaaa', playedAt: NOW },
  },
  { label: 'clear history', method: 'DELETE', path: '/api/history', actor: 'user' },
  {
    label: 'account delete',
    method: 'POST',
    path: '/api/account/delete',
    actor: 'user',
    body: { confirmation: 'DELETE' },
  },
  {
    label: 'focus sync',
    method: 'POST',
    path: '/api/focus-sessions',
    actor: 'user',
    body: { sessions: [] },
  },
  {
    label: 'provider preferences',
    method: 'PUT',
    path: '/api/account/provider-preferences',
    actor: 'user',
    body: { disabledProviderIds: ['chksz'] },
  },
  {
    label: 'background selection',
    method: 'PUT',
    path: '/api/account/background-selection',
    actor: 'user',
    body: { backgroundIds: [] },
  },
  {
    label: 'provider toggle',
    method: 'PATCH',
    path: '/api/admin/providers/chksz',
    actor: 'admin',
    body: { enabled: false },
  },
  {
    label: 'chksz owner fallback',
    method: 'PUT',
    path: '/api/admin/providers/chksz/owner-fallback',
    actor: 'admin',
    body: { enabled: true },
  },
  {
    label: 'notice create',
    method: 'POST',
    path: '/api/admin/notices',
    actor: 'admin',
    body: {
      severity: 'info',
      targeting: 'everyone',
      content: { en: { title: 'T', body: 'B' } },
      startAt: null,
      endAt: null,
    },
  },
  {
    label: 'notice patch',
    method: 'PATCH',
    path: `/api/admin/notices/${NOTICE_ID}`,
    actor: 'admin',
    body: { severity: 'warning' },
  },
  { label: 'notice publish', method: 'POST', path: `/api/admin/notices/${NOTICE_ID}/publish`, actor: 'admin' },
  { label: 'notice archive', method: 'POST', path: `/api/admin/notices/${NOTICE_ID}/archive`, actor: 'admin' },
  { label: 'background upload', method: 'POST', path: '/api/admin/backgrounds/uploads', actor: 'admin' },
  { label: 'background replace', method: 'POST', path: `/api/admin/backgrounds/${BACKGROUND_ID}/replace`, actor: 'admin' },
  { label: 'background publish', method: 'POST', path: `/api/admin/backgrounds/${BACKGROUND_ID}/publish`, actor: 'admin' },
  { label: 'background archive', method: 'POST', path: `/api/admin/backgrounds/${BACKGROUND_ID}/archive`, actor: 'admin' },
  { label: 'background restore', method: 'POST', path: `/api/admin/backgrounds/${BACKGROUND_ID}/restore`, actor: 'admin' },
  { label: 'background purge', method: 'DELETE', path: `/api/admin/backgrounds/${BACKGROUND_ID}/purge`, actor: 'admin' },
]

describe('CSRF and Origin enforcement across the cookie-authenticated surface', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: Record<string, unknown>
  let userCookie: string
  let adminCookie: string

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `security-csrf-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    env = {
      DB: database,
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'session-secret-with-at-least-thirty-two-characters',
      OAUTH_STATE_SECRET: 'oauth-state-secret-with-at-least-32-characters',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CLIENT_SECRET: 'TEST-google-client-secret',
      GITHUB_CLIENT_ID: 'github-client-id',
      GITHUB_CLIENT_SECRET: 'TEST-github-client-secret',
    }

    for (const [id, role] of [['user-a', 'user'], ['admin-a', 'owner']] as const) {
      await database.prepare(`
        INSERT INTO users (id, display_name, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(id, id, role, NOW, NOW).run()
      await database.prepare('INSERT INTO library_sync_state (user_id, revision) VALUES (?, 0)')
        .bind(id).run()
    }
    for (const [provider, subject] of [['google', 'google-subject-a'], ['github', '90001']] as const) {
      await database.prepare(`
        INSERT INTO auth_identities (id, user_id, provider, provider_subject, created_at)
        VALUES (?, 'user-a', ?, ?, ?)
      `).bind(crypto.randomUUID(), provider, subject, NOW).run()
    }

    const secret = env.SESSION_HMAC_SECRET as string
    userCookie = `__Host-session=${(await issueSession(database as never, 'user-a', secret, NOW, crypto)).token}`
    adminCookie = `__Host-session=${(await issueSession(database as never, 'admin-a', secret, NOW, crypto)).token}`
  })

  afterEach(async () => {
    await miniflare.dispose()
  })

  const send = (mutation: Mutation, origin: string | null, cookie: string) => {
    const headers = new Headers({ accept: 'application/json', cookie })
    if (origin !== null) headers.set('origin', origin)
    const body = mutation.body === undefined ? undefined : JSON.stringify(mutation.body)
    if (body !== undefined) headers.set('content-type', 'application/json')
    return worker.fetch(
      new Request(`${ORIGIN}${mutation.path}`, { method: mutation.method, headers, body }),
      env as never,
    )
  }

  const cookieFor = (mutation: Mutation) => mutation.actor === 'admin' ? adminCookie : userCookie

  it.each(MUTATIONS.map((mutation) => [mutation.label, mutation] as const))(
    'refuses %s from every hostile Origin without changing any row',
    async (_label, mutation) => {
      const before = await snapshot(database)
      for (const origin of HOSTILE_ORIGINS) {
        const name = origin === null ? '(absent)' : origin || '(empty)'
        const response = await send(mutation, origin, cookieFor(mutation))

        expect(response.status, `${mutation.label} with Origin ${name}`).toBe(403)
        expect(await response.json()).toEqual({ error: 'forbidden_origin' })
        expect(response.headers.get('cache-control')).toBe('no-store')
      }
      expect(await snapshot(database)).toBe(before)
    },
  )

  it.each(MUTATIONS.map((mutation) => [mutation.label, mutation] as const))(
    'lets %s past the Origin gate when the Origin is the exact application origin',
    async (_label, mutation) => {
      const response = await send(mutation, ORIGIN, cookieFor(mutation))

      expect(response.status).not.toBe(403)
    },
  )

  /**
   * The OAuth callback is a top-level browser navigation, so a hostile page can
   * always cause the GET without controlling `Origin`. Its anti-CSRF mechanism
   * is the sealed `__Host-oauth` flow cookie plus the one-time `oauth_flows`
   * row, not the Origin header. These cases pin that the exemption is safe
   * rather than merely present.
   */
  it.each(['google', 'github'] as const)(
    'refuses a %s callback that carries no sealed flow, whatever the Origin',
    async (provider) => {
      const before = await snapshot(database)
      for (const origin of HOSTILE_ORIGINS) {
        const headers = new Headers({ accept: 'application/json' })
        if (origin !== null) headers.set('origin', origin)
        const response = await worker.fetch(
          new Request(
            `${ORIGIN}/api/auth/${provider}/callback?code=forged-code&state=forged-state`,
            { headers },
          ),
          env as never,
        )

        expect([400, 401]).toContain(response.status)
        expect(await response.json()).toEqual({
          error: expect.stringMatching(/^(?:invalid_oauth_state|oauth_callback_failed)$/),
        })
        expect(response.headers.get('set-cookie') ?? '').not.toMatch(/__Host-session=[^;]/)
      }
      expect(await snapshot(database)).toBe(before)
    },
  )

  it('never issues a session from an unauthenticated read, whatever the Origin', async () => {
    const before = await snapshot(database)
    for (const origin of HOSTILE_ORIGINS) {
      const headers = new Headers({ accept: 'application/json' })
      if (origin !== null) headers.set('origin', origin)
      const response = await worker.fetch(
        new Request(`${ORIGIN}/api/session`, { headers }),
        env as never,
      )

      expect(response.headers.get('set-cookie') ?? '').not.toMatch(/__Host-session=[^;]/)
      expect(response.status).toBeLessThan(500)
    }
    expect(await snapshot(database)).toBe(before)
  })

  /**
   * The auth handler is the fallback branch of the Worker dispatch table, so an
   * unmatched path must not reach a mutation. This pins that no auth path other
   * than the three the gate enumerates is a state-changing POST.
   */
  it('has no unguarded state-changing auth path outside the enumerated gate', async () => {
    const before = await snapshot(database)
    for (const path of [
      '/api/session',
      '/api/auth/google/start',
      '/api/auth/github/start',
      '/api/auth/google/callback',
      '/api/auth/github/callback',
      '/api/unknown',
    ]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await worker.fetch(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: { accept: 'application/json', cookie: userCookie, origin: 'https://evil.example' },
          }),
          env as never,
        )

        expect(response.status, `${method} ${path}`).toBeGreaterThanOrEqual(400)
      }
    }
    expect(await snapshot(database)).toBe(before)
  })
})
