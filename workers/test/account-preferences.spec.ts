import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { issueSession } from '../auth/session'
import { createAccountPreferencesHandler, type AccountPreferencesEnv } from '../account/preferences'
import { createLibraryHandler } from '../library/routes'
import { parseSyncedUserPreferences as parseV1Preferences } from './fixtures/synced-user-preferences-v1'

const ORIGIN = 'https://study.example'
const ROUTE = `${ORIGIN}/api/account/ui-preferences`
const PREFERENCES = {
  locale: 'zh-Hant', volume: 0.35, backgroundMode: 'still',
  visualStyle: 'studio', studioBlur: 12, studioGlassGray: 45, studioEdge: 65,
  studyTipsEnabled: false, backgroundPlaybackMode: 'random', backgroundQualityMode: 'auto',
}
type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

describe('account workspace preferences on D1', () => {
  let miniflare: Miniflare
  let database: TestDatabase
  let env: AccountPreferencesEnv
  let tokenA: string
  let tokenB: string
  let handler: ReturnType<typeof createAccountPreferencesHandler>

  beforeEach(async () => {
    miniflare = new Miniflare({
      compatibilityDate: '2025-12-01', modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: `account-preferences-${crypto.randomUUID()}` },
      d1Persist: false, log: new Log(LogLevel.NONE),
    })
    database = await miniflare.getD1Database('DB')
    const directory = resolve(process.cwd(), 'migrations')
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(resolve(directory, name), 'utf8')
      await database.batch(sql.split(';').map(statement => statement.trim()).filter(Boolean)
        .map(statement => database.prepare(statement)))
    }
    env = { DB: database, PUBLIC_ORIGIN: ORIGIN, SESSION_HMAC_SECRET: 'workspace-preferences-test-session-secret-32' }
    const now = Date.now()
    for (const userId of ['user-a', 'user-b']) {
      await database.prepare("INSERT INTO users (id, display_name, role, created_at, updated_at) VALUES (?, ?, 'user', ?, ?)")
        .bind(userId, userId, now, now).run()
    }
    tokenA = (await issueSession(database, 'user-a', env.SESSION_HMAC_SECRET, now, crypto)).token
    tokenB = (await issueSession(database, 'user-b', env.SESSION_HMAC_SECRET, now, crypto)).token
    handler = createAccountPreferencesHandler(env)
  })

  afterEach(async () => { await miniflare.dispose() })

  const request = (token?: string, init: RequestInit = {}, legacy = false) => {
    const headers = new Headers(init.headers)
    if (!legacy && !headers.has('x-account-preferences-schema')) headers.set('x-account-preferences-schema', '2')
    if (token) headers.set('cookie', `__Host-session=${token}`)
    if (init.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json')
    if (init.method === 'PUT' && !headers.has('origin')) headers.set('origin', ORIGIN)
    return new Request(ROUTE, { ...init, headers })
  }
  const put = (preferences: unknown, token = tokenA) => handler.fetch(request(token, {
    method: 'PUT', body: JSON.stringify({ preferences }),
  }))
  const rowCount = () => database.prepare('SELECT COUNT(*) AS total FROM user_ui_preferences').first<number>('total')

  it('requires a live account session for both reads and writes', async () => {
    for (const token of [undefined, 'invalid-session']) {
      expect((await handler.fetch(request(token))).status).toBe(401)
      expect((await handler.fetch(request(token, { method: 'PUT', body: JSON.stringify({ preferences: PREFERENCES }) }))).status).toBe(401)
    }
    expect(await rowCount()).toBe(0)
  })

  it('requires exact Origin for writes before authenticating or storing', async () => {
    for (const origin of [null, 'https://attacker.example', `${ORIGIN}.attacker.example`]) {
      const headers = new Headers({ cookie: `__Host-session=${tokenA}`, 'content-type': 'application/json' })
      if (origin) headers.set('origin', origin)
      const response = await handler.fetch(new Request(ROUTE, {
        method: 'PUT', headers, body: JSON.stringify({ preferences: PREFERENCES }),
      }))
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden_origin' })
    }
    expect(await rowCount()).toBe(0)
  })

  it('rejects a stale account fence before reading or overwriting the current cookie account', async () => {
    await put(PREFERENCES, tokenB)
    for (const method of ['GET', 'PUT']) {
      const response = await handler.fetch(request(tokenB, {
        method, headers: { 'x-account-user-id': 'user-a' },
        body: method === 'PUT' ? JSON.stringify({ preferences: { ...PREFERENCES, volume: 0.9 } }) : undefined,
      }))
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'account_session_changed' })
    }
    expect(await handler.fetch(request(tokenB)).then(response => response.json())).toEqual({ preferences: PREFERENCES })
    expect(await handler.fetch(request(tokenA)).then(response => response.json())).toEqual({ preferences: null })
    expect(await rowCount()).toBe(1)
    const matching = await handler.fetch(request(tokenB, { headers: { 'x-account-user-id': 'user-b' } }))
    expect(matching.status).toBe(200)
    expect(await matching.json()).toEqual({ preferences: PREFERENCES })
  })

  it('returns null without creating a preference row on an initial read', async () => {
    const response = await handler.fetch(request(tokenA))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ preferences: null })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await rowCount()).toBe(0)
  })

  it('reads legacy deployed records while discarding only lowPower', async () => {
    const { backgroundPlaybackMode, backgroundQualityMode, ...old } = PREFERENCES
    await database.prepare('INSERT INTO user_ui_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, ?)')
      .bind('user-a', JSON.stringify({ ...old, lowPower: true }), 100).run()
    expect(await handler.fetch(request(tokenA)).then(r => r.json())).toEqual({ preferences: old })
  })

  it('keeps old PWA GET and PUT responses readable by the frozen v1 client without persisting lowPower', async () => {
    await put({ ...PREFERENCES, backgroundPlaybackMode: 'sequential', backgroundQualityMode: 'native' })
    const read = await handler.fetch(request(tokenA, {}, true))
    const saved = parseV1Preferences((await read.json()).preferences)
    expect(saved.lowPower).toBe(false)
    expect(saved).not.toHaveProperty('backgroundQualityMode')
    const write = await handler.fetch(request(tokenA, { method: 'PUT', body: JSON.stringify({ preferences: { ...saved, lowPower: true, volume: .6 } }) }, true))
    expect(write.status).toBe(200)
    expect(parseV1Preferences((await write.json()).preferences)).toMatchObject({ volume: .6, lowPower: false })
    const modern = await handler.fetch(request(tokenA)).then(r => r.json())
    expect(modern.preferences).toEqual({ ...PREFERENCES, volume: .6, backgroundPlaybackMode: 'sequential', backgroundQualityMode: 'native' })
    const stored = await database.prepare('SELECT preferences_json AS value FROM user_ui_preferences WHERE user_id = ?').bind('user-a').first<string>('value')
    expect(JSON.parse(stored!)).not.toHaveProperty('lowPower')
  })

  it('projects old D1 records for a still-running v1 page', async () => {
    const { backgroundPlaybackMode, backgroundQualityMode, ...base } = PREFERENCES
    await database.prepare('INSERT INTO user_ui_preferences (user_id, preferences_json, updated_at) VALUES (?, ?, ?)')
      .bind('user-a', JSON.stringify({ ...base, lowPower: true }), 100).run()
    const response = await handler.fetch(request(tokenA, {}, true))
    expect(parseV1Preferences((await response.json()).preferences)).toEqual({ ...base, lowPower: false })
  })

  it('allows first creation from v1 while rejecting payloads outside its frozen contract', async () => {
    const { backgroundPlaybackMode, backgroundQualityMode, ...base } = PREFERENCES
    expect(await handler.fetch(request(tokenA, {}, true)).then(r => r.json())).toEqual({ preferences: null })
    const created = await handler.fetch(request(tokenA, { method: 'PUT', body: JSON.stringify({ preferences: { ...base, lowPower: true } }) }, true))
    expect(created.status).toBe(200)
    expect(parseV1Preferences((await created.json()).preferences)).toEqual({ ...base, lowPower: false })
    for (const preferences of [base, { ...base, lowPower: false, backgroundQualityMode: 'native' }, { ...base, lowPower: false, apiKey: 'rejected' }]) {
      expect((await handler.fetch(request(tokenA, { method: 'PUT', body: JSON.stringify({ preferences }) }, true))).status).toBe(400)
    }
    expect(await handler.fetch(request(tokenA)).then(r => r.json())).toEqual({ preferences: base })
  })

  it('atomically preserves extensions changed by v2 immediately before a legacy write executes', async () => {
    await put(PREFERENCES)
    let intercepted = false
    const interleaved = new Proxy(database, { get(target, key) {
      if (key !== 'prepare') return Reflect.get(target, key, target)
      return (sql: string) => {
        const statement = target.prepare(sql)
        if (!sql.includes('INSERT INTO user_ui_preferences')) return statement
        return { bind: (...values: unknown[]) => {
          const bound = statement.bind(...values)
          const advance = async () => {
            intercepted = true
            expect((await put({ ...PREFERENCES, backgroundPlaybackMode: 'sequential', backgroundQualityMode: 'native' })).status).toBe(200)
          }
          return {
            run: async () => { await advance(); return bound.run() },
            first: async () => { await advance(); return bound.first() },
          }
        } }
      }
    } })
    const { backgroundPlaybackMode, backgroundQualityMode, ...base } = PREFERENCES
    const response = await createAccountPreferencesHandler({ ...env, DB: interleaved }).fetch(request(tokenA, {
      method: 'PUT', body: JSON.stringify({ preferences: { ...base, lowPower: false, volume: .9 } }),
    }, true))
    expect(intercepted).toBe(true)
    expect(response.status).toBe(200)
    expect(parseV1Preferences((await response.json()).preferences).volume).toBe(.9)
    expect(await handler.fetch(request(tokenA)).then(r => r.json())).toEqual({ preferences: {
      ...PREFERENCES, volume: .9, backgroundPlaybackMode: 'sequential', backgroundQualityMode: 'native',
    } })
  })

  it('rejects an unknown explicit wire schema without writing preferences', async () => {
    for (const method of ['GET', 'PUT']) {
      const response = await handler.fetch(request(tokenA, { method, headers: { 'x-account-preferences-schema': '3' },
        body: method === 'PUT' ? JSON.stringify({ preferences: PREFERENCES }) : undefined }))
      expect(response.status).toBe(400)
    }
    expect(await rowCount()).toBe(0)
  })

  it('advances legacy revisions within one millisecond so a stale v2 CAS still fails', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const first = await put(PREFERENCES)
      const oldRevision = first.headers.get('etag')!
      const { backgroundPlaybackMode, backgroundQualityMode, ...base } = PREFERENCES
      const legacy = await handler.fetch(request(tokenA, { method: 'PUT', body: JSON.stringify({ preferences: { ...base, lowPower: true, volume: .7 } }) }, true))
      expect(legacy.status).toBe(200)
      expect(Number(legacy.headers.get('etag'))).toBeGreaterThan(Number(oldRevision))
      const stale = await handler.fetch(request(tokenA, { method: 'PUT', headers: { 'if-match': oldRevision }, body: JSON.stringify({ preferences: PREFERENCES }) }))
      expect(stale.status).toBe(409)
    } finally { clock.mockRestore() }
  })

  it('rejects stale writes and concurrent creation without overwriting either account', async () => {
    const initial = await handler.fetch(request(tokenA))
    const absent = initial.headers.get('etag')!
    expect(absent).toBe('absent')
    const first = await handler.fetch(request(tokenA, { method: 'PUT', headers: { 'if-match': absent }, body: JSON.stringify({ preferences: PREFERENCES }) }))
    expect(first.status).toBe(200)
    const stale = await handler.fetch(request(tokenA, { method: 'PUT', headers: { 'if-match': absent }, body: JSON.stringify({ preferences: { ...PREFERENCES, volume: .1 } }) }))
    expect(stale.status).toBe(409)
    const accepted = await handler.fetch(request(tokenA, { method: 'PUT', headers: { 'if-match': first.headers.get('etag')! }, body: JSON.stringify({ preferences: { ...PREFERENCES, volume: .8 } }) }))
    expect(accepted.status).toBe(200)
    expect(await handler.fetch(request(tokenA)).then(r => r.json())).toEqual({ preferences: { ...PREFERENCES, volume: .8 } })
    expect(await handler.fetch(request(tokenB)).then(r => r.json())).toEqual({ preferences: null })
  })

  it('round-trips current preferences across independent sessions while isolating accounts', async () => {
    expect((await put(PREFERENCES)).status).toBe(200)
    const secondDevice = (await issueSession(database, 'user-a', env.SESSION_HMAC_SECRET, Date.now(), crypto)).token
    expect(await createAccountPreferencesHandler(env).fetch(request(secondDevice)).then(response => response.json()))
      .toEqual({ preferences: PREFERENCES })
    expect(await handler.fetch(request(tokenB)).then(response => response.json())).toEqual({ preferences: null })
    const bob = { ...PREFERENCES, locale: 'en', volume: 0.8 }
    expect((await put(bob, tokenB)).status).toBe(200)
    expect((await put({ ...PREFERENCES, volume: 0.2 })).status).toBe(200)
    expect(await handler.fetch(request(tokenB)).then(response => response.json())).toEqual({ preferences: bob })
    expect(await handler.fetch(request(tokenA)).then(response => response.json())).toEqual({ preferences: { ...PREFERENCES, volume: 0.2 } })
    expect(await rowCount()).toBe(2)
    expect(await database.prepare('SELECT settings_json AS settings FROM users WHERE id = ?').bind('user-a').first('settings'))
      .toBe('{}')
  })

  it.each([
    ['missing field', { ...PREFERENCES, studyTipsEnabled: undefined }],
    ['unknown key', { ...PREFERENCES, playerQueue: [] }],
    ['credential', { ...PREFERENCES, apiKey: 'do-not-store' }],
    ['LX script', { ...PREFERENCES, lxScript: 'do-not-store' }],
    ['session token', { ...PREFERENCES, sessionToken: 'do-not-store' }],
    ['invalid locale', { ...PREFERENCES, locale: 'zh-TW' }],
    ['negative volume', { ...PREFERENCES, volume: -0.1 }],
    ['excessive volume', { ...PREFERENCES, volume: 1.1 }],
    ['string boolean', { ...PREFERENCES, lowPower: 'true' }],
    ['invalid background mode', { ...PREFERENCES, backgroundMode: 'video' }],
    ['invalid visual style', { ...PREFERENCES, visualStyle: 'unknown' }],
    ['fractional blur', { ...PREFERENCES, studioBlur: 4.5 }],
    ['out of range blur', { ...PREFERENCES, studioBlur: 25 }],
    ['out of range gray', { ...PREFERENCES, studioGlassGray: -1 }],
    ['out of range edge', { ...PREFERENCES, studioEdge: 101 }],
    ['null preferences', null],
    ['array preferences', []],
  ])('rejects %s and preserves previously saved settings', async (_label, preferences) => {
    await put(PREFERENCES)
    const response = await put(preferences)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid_account_preferences' })
    expect(await handler.fetch(request(tokenA)).then(response => response.json())).toEqual({ preferences: PREFERENCES })
    expect(await rowCount()).toBe(1)
  })

  it('rejects malformed, oversized, non-JSON and invalid envelope bodies without writes', async () => {
    for (const body of ['{', JSON.stringify({ padding: '界'.repeat(2_000) }),
      JSON.stringify({ preferences: PREFERENCES, userId: 'user-b' }), '[]', 'null', '{}']) {
      const response = await handler.fetch(request(tokenA, { method: 'PUT', body }))
      expect(response.status).toBe(400)
    }
    const wrongMime = await handler.fetch(request(tokenA, {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ preferences: PREFERENCES }),
    }))
    expect(wrongMime.status).toBe(400)
    expect(await rowCount()).toBe(0)
  })

  it('exports the validated workspace preference and preserves legacy export fields', async () => {
    await put(PREFERENCES)
    await put({ ...PREFERENCES, locale: 'en' }, tokenB)
    await database.prepare('INSERT INTO favourites VALUES (?, ?, ?)').bind('user-a', 'legacy-favourite', 1_786_480_000_000).run()
    const response = await createLibraryHandler(env).fetch(new Request(`${ORIGIN}/api/export`, {
      headers: { cookie: `__Host-session=${tokenA}` },
    }))
    expect(response.status).toBe(200)
    const exported = await response.json() as Record<string, unknown>
    expect(exported.userUiPreferences).toEqual(PREFERENCES)
    expect(exported).toMatchObject({
      favourites: [{ trackId: 'legacy-favourite', addedAt: '2026-08-11T20:26:40.000Z' }],
      focusSessions: [], playlists: [], preferences: { historyEnabled: false },
      providerPreferences: { disabledProviderIds: [] }, reports: [],
    })
    expect(JSON.stringify(exported)).not.toContain(tokenA)
  })

  it('exports null when no workspace preference was saved', async () => {
    const response = await createLibraryHandler(env).fetch(new Request(`${ORIGIN}/api/export`, {
      headers: { cookie: `__Host-session=${tokenA}` },
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveProperty('userUiPreferences', null)
  })

  it('exports only this account background IDs and rotation settings alongside disabled providers', async () => {
    await database.batch([
      database.prepare('INSERT INTO user_background_selections VALUES (?, ?, ?, ?, ?)')
        .bind('user-a', '["zzz-urban-stroll-anby-billy","550e8400-e29b-41d4-a716-446655440000"]', 1, 1200, Date.now()),
      database.prepare('INSERT INTO user_background_selections VALUES (?, ?, ?, ?, ?)')
        .bind('user-b', '["another-account-background"]', 0, 600, Date.now()),
      database.prepare('INSERT INTO user_provider_preferences VALUES (?, ?, ?)')
        .bind('user-a', '["chksz","lx"]', Date.now()),
    ])
    const response = await createLibraryHandler(env).fetch(new Request(`${ORIGIN}/api/export`, {
      headers: { cookie: `__Host-session=${tokenA}` },
    }))
    expect(response.status).toBe(200)
    const exported = await response.json() as Record<string, unknown>
    expect(exported.backgroundSelection).toEqual({
      selectedIds: ['zzz-urban-stroll-anby-billy', '550e8400-e29b-41d4-a716-446655440000'],
      autoRotate: true, intervalSeconds: 1200,
    })
    expect(exported.providerPreferences).toEqual({ disabledProviderIds: ['chksz', 'lx'] })
    expect(JSON.stringify(exported)).not.toContain('another-account-background')
  })

  it('refuses to export malformed stored preferences including secret fields', async () => {
    await database.prepare('INSERT INTO user_ui_preferences VALUES (?, ?, ?)')
      .bind('user-a', JSON.stringify({ ...PREFERENCES, apiKey: 'must-not-export' }), Date.now()).run()
    const response = await createLibraryHandler(env).fetch(new Request(`${ORIGIN}/api/export`, {
      headers: { cookie: `__Host-session=${tokenA}` },
    }))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('must-not-export')
  })

  it('refuses to export unexpected object fields in a corrupt background selection', async () => {
    await database.prepare('INSERT INTO user_background_selections VALUES (?, ?, ?, ?, ?)')
      .bind('user-a', '[{"apiKey":"must-not-export"}]', 1, 1200, Date.now()).run()
    const response = await createLibraryHandler(env).fetch(new Request(`${ORIGIN}/api/export`, {
      headers: { cookie: `__Host-session=${tokenA}` },
    }))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('must-not-export')
  })

  it('cascades account deletion to workspace preferences without touching another account', async () => {
    await put(PREFERENCES)
    await put({ ...PREFERENCES, locale: 'en' }, tokenB)
    const response = await createLibraryHandler(env).fetch(new Request(`${ORIGIN}/api/account/delete`, {
      method: 'POST', headers: { cookie: `__Host-session=${tokenA}`, origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE' }),
    }))
    expect(response.status).toBe(204)
    expect(await database.prepare('SELECT user_id FROM user_ui_preferences').all())
      .toMatchObject({ results: [{ user_id: 'user-b' }] })
    expect((await handler.fetch(request(tokenA))).status).toBe(401)
    expect(await handler.fetch(request(tokenB)).then(response => response.json()))
      .toEqual({ preferences: { ...PREFERENCES, locale: 'en' } })
  })
})
