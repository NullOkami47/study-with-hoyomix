import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { issueSession } from '../auth/session'
import {
  LEGACY_LX_IDS,
  USER_TOGGLEABLE_PROVIDER_IDS,
  createProviderPreferencesHandler,
  type ProviderPreferencesEnv,
} from '../providers/preferences'
import { exportAccountData } from '../library/repository'
import type { Database } from '../db'

const ORIGIN = 'https://study.example'
const NOW = 1_786_480_000_000
const ROUTE = '/api/account/provider-preferences'

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

const request = (token?: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (token) headers.set('cookie', `__Host-session=${token}`)
  if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
  if (init.method && init.method !== 'GET') headers.set('origin', ORIGIN)
  return new Request(`${ORIGIN}${ROUTE}`, { ...init, headers })
}

describe('authenticated user provider preferences', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: ProviderPreferencesEnv
  let tokenA: string
  let tokenB: string
  let handler: { fetch(request: Request): Promise<Response> }

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `provider-preferences-${crypto.randomUUID()}` },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    env = {
      DB: database as unknown as ProviderPreferencesEnv['DB'],
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_HMAC_SECRET: 'provider-preferences-secret-value-for-tests',
    }
    for (const id of ['user-a', 'user-b']) {
      await database.prepare(`
        INSERT INTO users (id, display_name, role, created_at, updated_at)
        VALUES (?, ?, 'user', ?, ?)
      `).bind(id, id, NOW, NOW).run()
      await database.prepare('INSERT INTO library_sync_state (user_id, revision) VALUES (?, 0)')
        .bind(id).run()
    }
    tokenA = (await issueSession(env.DB, 'user-a', env.SESSION_HMAC_SECRET, NOW, crypto)).token
    tokenB = (await issueSession(env.DB, 'user-b', env.SESSION_HMAC_SECRET, NOW, crypto)).token
    handler = createProviderPreferencesHandler(env, { now: () => NOW })
  })

  afterEach(async () => {
    await miniflare.dispose()
  })

  const put = (body: unknown, token?: string) => handler.fetch(request(token, {
    method: 'PUT',
    body: JSON.stringify(body),
  }))

  it('exposes only canonical user-toggleable provider IDs', () => {
    expect([...USER_TOGGLEABLE_PROVIDER_IDS]).toEqual([
      'chksz',
      'lx',
      'jellyfin',
    ])
  })

  it('requires authentication for reading and writing', async () => {
    expect((await handler.fetch(request())).status).toBe(401)
    expect((await put({ disabledProviderIds: [] })).status).toBe(401)
  })

  it('rejects a mutation without the exact application Origin', async () => {
    const response = await handler.fetch(new Request(`${ORIGIN}${ROUTE}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: `__Host-session=${tokenA}`,
        origin: 'https://attacker.example',
      },
      body: JSON.stringify({ disabledProviderIds: ['chksz'] }),
    }))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'forbidden_origin' })
    expect(await database.prepare('SELECT COUNT(*) AS total FROM user_provider_preferences')
      .first<number>('total')).toBe(0)
  })

  it('returns an empty preference for an account with no stored row', async () => {
    const response = await handler.fetch(request(tokenA))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ disabledProviderIds: [] })
  })

  it('persists and reads back a canonical selection in canonical order', async () => {
    const written = await put({ disabledProviderIds: ['jellyfin', 'lx'] }, tokenA)

    expect(written.status).toBe(200)
    expect(await written.json()).toEqual({ disabledProviderIds: ['lx', 'jellyfin'] })

    const read = await handler.fetch(request(tokenA))
    expect(await read.json()).toEqual({ disabledProviderIds: ['lx', 'jellyfin'] })
  })

  it('keeps one row per account and replaces the previous selection', async () => {
    await put({ disabledProviderIds: ['chksz'] }, tokenA)
    await put({ disabledProviderIds: ['jellyfin', 'lx'] }, tokenA)

    const read = await handler.fetch(request(tokenA))
    expect(await read.json()).toEqual({ disabledProviderIds: ['lx', 'jellyfin'] })
    expect(await database.prepare(
      'SELECT COUNT(*) AS total FROM user_provider_preferences WHERE user_id = ?',
    ).bind('user-a').first<number>('total')).toBe(1)
  })

  it('clears the selection with an empty array', async () => {
    await put({ disabledProviderIds: ['chksz'] }, tokenA)
    const cleared = await put({ disabledProviderIds: [] }, tokenA)

    expect(cleared.status).toBe(200)
    expect(await cleared.json()).toEqual({ disabledProviderIds: [] })
    expect(await handler.fetch(request(tokenA)).then((value) => value.json()))
      .toEqual({ disabledProviderIds: [] })
  })

  it('isolates one account preference from another', async () => {
    await put({ disabledProviderIds: ['chksz'] }, tokenA)

    expect(await handler.fetch(request(tokenB)).then((value) => value.json()))
      .toEqual({ disabledProviderIds: [] })
  })

  it.each([
    ['a missing field', {}],
    ['an extra field', { disabledProviderIds: [], priority: 3 }],
    ['a non-array value', { disabledProviderIds: 'chksz' }],
    ['a nested object', { disabledProviderIds: [{ id: 'chksz' }] }],
    ['a non-string member', { disabledProviderIds: [3] }],
    ['a duplicate member', { disabledProviderIds: ['chksz', 'chksz'] }],
    ['an unknown provider', { disabledProviderIds: ['lx-unknown'] }],
    ['a non-canonical case', { disabledProviderIds: ['ChKSz'] }],
    ['a legacy provider r2', { disabledProviderIds: ['r2'] }],
    ['a legacy provider meting', { disabledProviderIds: ['meting'] }],
    ['a legacy provider piped', { disabledProviderIds: ['piped'] }],
    ['a legacy provider invidious', { disabledProviderIds: ['invidious'] }],
    ['a legacy lx provider lx-huibq', { disabledProviderIds: ['lx-huibq'] }],
    ['a legacy lx provider lx-sixyin', { disabledProviderIds: ['lx-sixyin'] }],
    ['a manual-only provider', { disabledProviderIds: ['youtube'] }],
    ['an inert legacy provider', { disabledProviderIds: ['qijie'] }],
    ['an inert legacy provider', { disabledProviderIds: ['gd-studio'] }],
    ['a credential field', { disabledProviderIds: [], chkszApiKey: 'must-not-persist' }],
    ['a resolver URL field', { disabledProviderIds: [], baseUrl: 'https://attacker.example' }],
    ['a health field', { disabledProviderIds: [], status: 'healthy' }],
    ['an array body', ['chksz']],
    ['a null body', null],
    ['a string body', 'chksz'],
  ])('rejects %s without persisting anything', async (_label, body) => {
    const response = await put(body, tokenA)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_provider_preferences' })
    expect(await database.prepare('SELECT COUNT(*) AS total FROM user_provider_preferences')
      .first<number>('total')).toBe(0)
  })

  it('rejects a payload larger than the bounded limit', async () => {
    const response = await put({
      disabledProviderIds: ['chksz'],
      padding: 'x'.repeat(8 * 1024),
    }, tokenA)

    expect(response.status).toBe(400)
    expect(await database.prepare('SELECT COUNT(*) AS total FROM user_provider_preferences')
      .first<number>('total')).toBe(0)
  })

  it('rejects a valid JSON preference submitted with a non-JSON media type', async () => {
    const response = await handler.fetch(request(tokenA, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ disabledProviderIds: ['chksz'] }),
    }))

    expect(response.status).toBe(400)
    expect(await database.prepare('SELECT COUNT(*) AS total FROM user_provider_preferences')
      .first<number>('total')).toBe(0)
  })

  it('rejects malformed JSON', async () => {
    const response = await handler.fetch(request(tokenA, { method: 'PUT', body: '{' }))

    expect(response.status).toBe(400)
  })

  it('accepts the complete user-toggleable set', async () => {
    const response = await put(
      { disabledProviderIds: [...USER_TOGGLEABLE_PROVIDER_IDS] },
      tokenA,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      disabledProviderIds: [...USER_TOGGLEABLE_PROVIDER_IDS],
    })
  })

  it.each(['POST', 'PATCH', 'DELETE'])('rejects the unsupported method %s', async (method) => {
    const response = await handler.fetch(request(tokenA, {
      method,
      body: JSON.stringify({ disabledProviderIds: [] }),
    }))

    expect(response.status).toBe(405)
  })

  it('never persists a raw resolver URL, request key, or credential', async () => {
    await put({ disabledProviderIds: ['chksz', 'lx'] }, tokenA)

    const stored = await database.prepare(
      'SELECT disabled_provider_ids_json AS json FROM user_provider_preferences WHERE user_id = ?',
    ).bind('user-a').first<{ json: string }>()

    expect(stored?.json).toBe(JSON.stringify(['chksz', 'lx']))
    expect(stored?.json).not.toMatch(/http|key|token|cookie|priority/i)
  })

  it('removes the preference row when the account is deleted', async () => {
    await put({ disabledProviderIds: ['chksz'] }, tokenA)
    await database.prepare('PRAGMA foreign_keys = ON').run()
    await database.prepare('DELETE FROM users WHERE id = ?').bind('user-a').run()

    expect(await database.prepare(
      'SELECT COUNT(*) AS total FROM user_provider_preferences WHERE user_id = ?',
    ).bind('user-a').first<number>('total')).toBe(0)
  })

  it('includes the non-sensitive preference in the account export', async () => {
    await put({ disabledProviderIds: ['lx', 'chksz'] }, tokenA)

    const exported = await exportAccountData(database as unknown as Database, 'user-a')

    expect(exported.providerPreferences).toEqual({
      disabledProviderIds: ['chksz', 'lx'],
    })
    expect(JSON.stringify(exported)).not.toMatch(/x-request-key|apikey|api_key|MUSIC_U/i)
  })

  it('exports an empty preference when nothing is stored', async () => {
    const exported = await exportAccountData(database as unknown as Database, 'user-a')

    expect(exported.providerPreferences).toEqual({ disabledProviderIds: [] })
  })

  describe('legacy stored D1 preference migration on GET', () => {
    it('migrates legacy stored array with old chksz, piped, r2 to new chksz and writes back to D1', async () => {
      const oldUpdatedAt = NOW - 5000
      await database.prepare(`
        INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
        VALUES (?, ?, ?)
      `).bind('user-a', JSON.stringify(['chksz', 'piped', 'r2']), oldUpdatedAt).run()

      const response = await handler.fetch(request(tokenA))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ disabledProviderIds: ['chksz'] })

      const row = await database.prepare(`
        SELECT disabled_provider_ids_json AS json, updated_at AS updatedAt
        FROM user_provider_preferences WHERE user_id = ?
      `).bind('user-a').first<{ json: string; updatedAt: number }>()

      expect(row?.json).toBe(JSON.stringify(['chksz']))
      expect(row?.updatedAt).toBe(NOW)
    })

    it('migrates all 8 legacy LX IDs to new lx disabled and writes back to D1', async () => {
      await database.prepare(`
        INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
        VALUES (?, ?, ?)
      `).bind('user-a', JSON.stringify([...LEGACY_LX_IDS]), NOW - 1000).run()

      const response = await handler.fetch(request(tokenA))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ disabledProviderIds: ['lx'] })

      const row = await database.prepare(`
        SELECT disabled_provider_ids_json AS json
        FROM user_provider_preferences WHERE user_id = ?
      `).bind('user-a').first<{ json: string }>()

      expect(row?.json).toBe(JSON.stringify(['lx']))
    })

    it('keeps lx enabled when fewer than 8 legacy LX IDs were disabled', async () => {
      await database.prepare(`
        INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
        VALUES (?, ?, ?)
      `).bind('user-a', JSON.stringify(['lx-huibq', 'lx-ikun']), NOW - 1000).run()

      const response = await handler.fetch(request(tokenA))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ disabledProviderIds: [] })

      const row = await database.prepare(`
        SELECT disabled_provider_ids_json AS json
        FROM user_provider_preferences WHERE user_id = ?
      `).bind('user-a').first<{ json: string }>()

      expect(row?.json).toBe(JSON.stringify([]))
    })

    it('does not write back to D1 when stored preferences are already canonical and migrated', async () => {
      const existingUpdatedAt = NOW - 10_000
      await database.prepare(`
        INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
        VALUES (?, ?, ?)
      `).bind('user-a', JSON.stringify(['chksz', 'lx']), existingUpdatedAt).run()

      const response = await handler.fetch(request(tokenA))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ disabledProviderIds: ['chksz', 'lx'] })

      const row = await database.prepare(`
        SELECT updated_at AS updatedAt
        FROM user_provider_preferences WHERE user_id = ?
      `).bind('user-a').first<{ updatedAt: number }>()

      expect(row?.updatedAt).toBe(existingUpdatedAt)
    })

    it('migrates unrecognised stored JSON array to empty array and cleans up D1 row', async () => {
      await database.prepare(`
        INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
        VALUES (?, ?, ?)
      `).bind('user-a', JSON.stringify(['bad-id', 'invalid-id']), NOW - 1000).run()

      const response = await handler.fetch(request(tokenA))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ disabledProviderIds: [] })

      const row = await database.prepare(`
        SELECT disabled_provider_ids_json AS json
        FROM user_provider_preferences WHERE user_id = ?
      `).bind('user-a').first<{ json: string }>()

      expect(row?.json).toBe(JSON.stringify([]))
    })
  })
})
