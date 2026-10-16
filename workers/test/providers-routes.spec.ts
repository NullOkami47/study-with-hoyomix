import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import worker from '../index'
import type { D1Database } from '../env'
import type { ProviderEnv } from '../providers/config'
import { createProviderHandler } from '../providers/routes'

const MIGRATIONS_DIRECTORY = resolve(process.cwd(), 'migrations')

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>

let database: TestDatabase

const providerEnv = (overrides: Partial<ProviderEnv> = {}): ProviderEnv => ({
  DB: database,
  PUBLIC_ORIGIN: 'https://study.example',
  SESSION_HMAC_SECRET: 'session-secret-at-least-thirty-two-bytes',
  OAUTH_STATE_SECRET: 'oauth-secret-at-least-thirty-two-bytes',
  GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-client', GITHUB_CLIENT_SECRET: 'github-secret',
  ...overrides,
})

const seedProvider = (db: D1Database, id: string, enabled: number, priority: number) =>
  db.prepare(`INSERT INTO provider_health
    (provider_key, enabled, priority, status, updated_at)
    VALUES (?, ?, ?, 'unknown', 0)`)
    .bind(id, enabled, priority).run()

const applyMigrations = async (db: TestDatabase) => {
  const names = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .filter((name) => name !== '0009_playback_provider_defaults.sql')
    .sort()

  for (const name of names) {
    const sql = await readFile(resolve(MIGRATIONS_DIRECTORY, name), 'utf8')
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => db.prepare(statement))
    await db.batch(statements)
  }
}

const request = (method = 'GET') => new Request('https://study.example/api/providers/config', { method })

const requestWithCountry = (country: string) => {
  const value = request()
  Object.defineProperty(value, 'cf', { value: { country } })
  return value
}

const CHKSZ_ID = '1315196858'
const CHKSZ_KEY = 'test-chksz-key-must-stay-private'
const CHKSZ_USER_KEY = 'USER_KEY_SENTINEL'
const CHKSZ_TEMPORARY_URL = 'https://m801.music.126.net/temporary-audio'
const CHKSZ_NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX'

const officialChkszResponse = (overrides: Record<string, unknown> = {}) => ({
  code: 200,
  msg: 'success',
  data: {
    id: 1315196858,
    url: CHKSZ_TEMPORARY_URL,
    br: 128000,
    level: 'standard',
    size: 1234,
    md5: 'fixture-md5',
    name: 'fixture',
    artist: 'fixture',
    album: 'fixture',
    picUrl: 'https://p1.music.126.net/fixture',
    ...overrides,
  },
})

const upstreamJson = (
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
})

const resolveRequest = (
  body: BodyInit = JSON.stringify({ externalId: CHKSZ_ID }),
  headers: HeadersInit = {
    'content-type': 'application/json',
    origin: 'https://study.example',
  },
  url = 'https://study.example/api/providers/chksz/resolve',
) => new Request(url, { body, headers, method: 'POST' })

const mediaUrl = (id = CHKSZ_ID, nonce = CHKSZ_NONCE) =>
  `https://study.example/api/providers/chksz/media/${id}/${nonce}`

const mediaRequest = (
  method = 'GET',
  headers: HeadersInit = {},
  id = CHKSZ_ID,
  nonce = CHKSZ_NONCE,
  suffix = '',
) => new Request(`${mediaUrl(id, nonce)}${suffix}`, { headers, method })

class FakePreparationCache {
  readonly entries = new Map<string, Response>()
  readonly matchCalls: Request[] = []
  readonly putCalls: Array<{ request: Request; response: Response }> = []
  failMatch: unknown = null
  failPut: unknown = null

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const request = input instanceof Request ? input.clone() : new Request(input)
    this.matchCalls.push(request)
    if (this.failMatch) throw this.failMatch
    return this.entries.get(`${request.method} ${request.url}`)?.clone()
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const request = input instanceof Request ? input.clone() : new Request(input)
    this.putCalls.push({ request, response: response.clone() })
    if (this.failPut) throw this.failPut
    this.entries.set(`${request.method} ${request.url}`, response.clone())
  }

  clear(): void {
    this.entries.clear()
  }
}

const deterministicCrypto = () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.forEach((_value, index) => { bytes[index] = index })
    return bytes
  })
  return {
    crypto: { getRandomValues } as unknown as Crypto,
    getRandomValues,
  }
}

const noSensitiveData = async (response: Response) => {
  const serialised = `${JSON.stringify([...response.headers])}\n${await response.clone().text()}`
  expect(serialised).not.toContain(CHKSZ_KEY)
  expect(serialised).not.toContain(CHKSZ_USER_KEY)
  expect(serialised).not.toContain(CHKSZ_TEMPORARY_URL)
  expect(serialised).not.toContain('api.chksz.com')
}

describe('public runtime provider configuration', () => {
  const miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'provider-routes-test' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  })

  beforeAll(async () => {
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
  })

  beforeEach(async () => {
    await database.prepare('DELETE FROM provider_health').run()
  })

  afterAll(async () => {
    await miniflare.dispose()
  })

  it('returns every canonical state with effective enablement and only public R2 configuration', async () => {
    await seedProvider(database, 'youtube', 0, 9)
    await seedProvider(database, 'r2', 1, 4)
    await seedProvider(database, 'qijie', 1, 8)
    await seedProvider(database, 'chksz', 1, 3)
    const { createProviderHandler } = await import('../providers/routes')
    const response = await createProviderHandler(providerEnv({
      R2_BASE_URL: 'https://media.example/',
      R2_ALLOWED_HOSTNAMES: 'media.example',
      PIPED_API_BASE_URL: 'https://piped.example',
      INVIDIOUS_API_BASE_URL: 'https://invidious.example',
      CHKSZ_API_KEY: 'test-secret-value',
    })).fetch(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual({
      version: 1,
      providers: [
        {
          id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 3,
          userKeySupported: true, ownerFallbackAvailable: false,
        },
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 20 },
        { id: 'jellyfin', available: false, enabled: false, automaticEligible: false, priority: 30 },
      ],
    })
    expect(JSON.stringify(body)).not.toContain('test-secret-value')
    expect(JSON.stringify(body)).not.toMatch(/piped\.example|invidious\.example/)
    expect(JSON.stringify(body)).not.toMatch(/apikey|api\.chksz\.com|temporary/i)
  })

  it('projects only safe ChKSz credential capability when Owner fallback is usable', async () => {
    await seedProvider(database, 'chksz', 1, 11)
    await database.prepare(`
      INSERT INTO admin_settings (setting_key, setting_json, updated_by, updated_at)
      VALUES ('provider.chksz.ownerKeyFallback', '{"enabled":true}', NULL, 0)
    `).run()
    const { createProviderHandler } = await import('../providers/routes')
    const response = await createProviderHandler(providerEnv({ CHKSZ_API_KEY: 'OWNER_KEY_SENTINEL' }))
      .fetch(requestWithCountry('CN'))
    const body = await response.json() as { providers: Array<Record<string, unknown>> }

    expect(body.providers.find(({ id }) => id === 'chksz')).toMatchObject({
      id: 'chksz',
      userKeySupported: true,
      ownerFallbackAvailable: true,
      automaticEligible: true,
    })
    expect(JSON.stringify(body)).not.toContain('OWNER_KEY_SENTINEL')
  })

  it('projects the approved direct-audio order for trusted CN without mutating stored priorities', async () => {
    await seedProvider(database, 'r2', 1, 1)
    await seedProvider(database, 'meting', 1, 2)
    await seedProvider(database, 'chksz', 1, 11)
    await seedProvider(database, 'piped', 1, 12)
    await seedProvider(database, 'invidious', 1, 13)
    const before = await database.prepare(`
      SELECT provider_key AS providerKey, priority
      FROM provider_health
      ORDER BY provider_key
    `).all<{ providerKey: string; priority: number }>()
    const { createProviderHandler } = await import('../providers/routes')
    const response = await createProviderHandler(providerEnv({
      R2_BASE_URL: 'https://media.example/',
      R2_ALLOWED_HOSTNAMES: 'media.example',
      PIPED_API_BASE_URL: 'https://piped.example',
      INVIDIOUS_API_BASE_URL: 'https://invidious.example',
      METING_API_BASE_URL: 'https://meting.example',
      METING_MEDIA_ALLOWED_HOSTNAMES: 'meting-media.example',
      CHKSZ_API_KEY: CHKSZ_KEY,
    })).fetch(requestWithCountry('CN'))
    const body = await response.json() as {
      providers: Array<{ id: string; enabled: boolean; automaticEligible: boolean; priority: number }>
    }

    expect(body.providers
      .filter(({ automaticEligible }) => automaticEligible)
      .sort((left, right) => left.priority - right.priority)
      .map(({ id, enabled, priority }) => [id, enabled, priority]),
    ).toEqual([
      ['chksz', true, 11],
      ['lx', true, 20],
    ])
    expect(JSON.stringify(body)).not.toMatch(/country|CN/)
    expect((await database.prepare(`
      SELECT provider_key AS providerKey, priority
      FROM provider_health
      ORDER BY provider_key
    `).all()).results).toEqual(before.results)
  })

  it('ignores spoofable country headers and query parameters', async () => {
    await seedProvider(database, 'chksz', 1, 20)
    const { createProviderHandler } = await import('../providers/routes')
    const response = await createProviderHandler(providerEnv({ CHKSZ_API_KEY: CHKSZ_KEY })).fetch(
      new Request('https://study.example/api/providers/config?country=CN', {
        headers: { 'cf-ipcountry': 'CN', country: 'CN', 'x-country': 'CN' },
      }),
    )
    const body = await response.json() as {
      providers: Array<{ id: string; automaticEligible: boolean; priority: number }>
    }

    expect(body.providers.find(({ id }) => id === 'chksz')?.priority).toBe(20)
    expect(body.providers.find(({ id }) => id === 'chksz')?.automaticEligible).toBe(true)
  })

  it('routes the anonymous config endpoint before the authentication fallback', async () => {
    const response = await worker.fetch(request(), providerEnv())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ version: 1 })
  })

  it('returns the same successful headers without a body for HEAD', async () => {
    const { createProviderHandler } = await import('../providers/routes')
    const response = await createProviderHandler(providerEnv()).fetch(request('HEAD'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('')
  })

  it('rejects methods other than GET and HEAD', async () => {
    const { createProviderHandler } = await import('../providers/routes')
    const response = await createProviderHandler(providerEnv()).fetch(request('POST'))

    expect(response.status).toBe(405)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('fails closed with a bounded response when provider state cannot be read', async () => {
    const failingDatabase = {
      prepare: () => ({
        all: async () => { throw new Error('database detail must stay private') },
      }),
    } as unknown as D1Database
    const { createProviderHandler } = await import('../providers/routes')
    const response = await createProviderHandler(providerEnv({ DB: failingDatabase })).fetch(request())
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body).toEqual({ error: 'provider_config_unavailable' })
    expect(body).not.toHaveProperty('providers')
    expect(JSON.stringify(body)).not.toContain('database detail')
  })

  it.each([
    ['https://127.0.0.1/', '127.0.0.1'],
    ['https://[::1]/', '[::1]'],
    ['https://media.localhost/', 'media.localhost'],
    ['https://internal/', 'internal'],
    ['https://media.internal/', 'media.internal'],
    ['https://media.example/', 'cdn.example'],
  ])('does not expose an unsafe R2 endpoint from %s', async (baseUrl, allowedHostnames) => {
    await seedProvider(database, 'r2', 1, 1)
    const { createProviderHandler } = await import('../providers/routes')
    const response = await createProviderHandler(providerEnv({
      R2_BASE_URL: baseUrl,
      R2_ALLOWED_HOSTNAMES: allowedHostnames,
    })).fetch(request())
    const body = await response.json() as {
      providers: Array<{ id: string; available: boolean; enabled: boolean; config?: unknown }>
    }
    const r2 = body.providers.find((provider) => provider.id === 'r2')

    expect(response.status).toBe(200)
    expect(r2).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain(new URL(baseUrl).hostname)
  })

  describe('secure ChKSz resolve preparation', () => {
    beforeEach(async () => {
      await database.prepare('DELETE FROM admin_audit_log').run()
      await database.prepare(`
        DELETE FROM admin_settings WHERE setting_key = 'provider.chksz.ownerKeyFallback'
      `).run()
    })

    const createHandler = async (
      fetchImpl: typeof fetch,
      cache = new FakePreparationCache(),
      envOverrides: Partial<ProviderEnv> = { CHKSZ_API_KEY: CHKSZ_KEY },
      now: () => number = () => 1_000,
    ) => {
      await setOwnerFallback(true)
      const { createProviderHandler } = await import('../providers/routes')
      const nonce = deterministicCrypto()
      const options = {
        cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        crypto: nonce.crypto,
        fetch: fetchImpl,
        now,
      }
      return {
        cache,
        handler: createProviderHandler(providerEnv(envOverrides), options),
        nonce,
      }
    }

    const setOwnerFallback = async (enabled: boolean) => database.prepare(`
      INSERT INTO admin_settings (setting_key, setting_json, updated_by, updated_at)
      VALUES ('provider.chksz.ownerKeyFallback', ?, NULL, 0)
      ON CONFLICT(setting_key) DO UPDATE SET setting_json = excluded.setting_json
    `).bind(JSON.stringify({ enabled })).run()

    const resolveWithUserKey = (key = CHKSZ_USER_KEY) => resolveRequest(
      JSON.stringify({ externalId: CHKSZ_ID }),
      {
        'content-type': 'application/json',
        origin: 'https://study.example',
        'x-chksz-api-key': key,
      },
    )

    it('does not read or use the Owner key while fallback is OFF', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      await setOwnerFallback(false)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const env = providerEnv()
      const ownerKeyRead = vi.fn(() => CHKSZ_KEY)
      Object.defineProperty(env, 'CHKSZ_API_KEY', { configurable: true, get: ownerKeyRead })
      const { createProviderHandler } = await import('../providers/routes')
      const response = await createProviderHandler(env, { fetch: fetchImpl }).fetch(resolveRequest())

      expect(response.status).toBe(503)
      expect(await response.clone().json()).toEqual({ error: 'credential_required' })
      expect(ownerKeyRead).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()
      await noSensitiveData(response)
    })

    it('uses a bounded user key first without reading the configured Owner key', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      await setOwnerFallback(true)
      const fetchImpl = vi.fn(async () => upstreamJson(officialChkszResponse())) as unknown as typeof fetch
      const env = providerEnv()
      const ownerKeyRead = vi.fn(() => CHKSZ_KEY)
      Object.defineProperty(env, 'CHKSZ_API_KEY', { configurable: true, get: ownerKeyRead })
      const { createProviderHandler } = await import('../providers/routes')
      const cache = new FakePreparationCache()
      const handler = createProviderHandler(env, {
        cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        crypto: deterministicCrypto().crypto,
        fetch: fetchImpl,
        now: () => 1_000,
      })
      const response = await handler.fetch(resolveWithUserKey())

      expect(response.status).toBe(200)
      expect(ownerKeyRead).not.toHaveBeenCalled()
      const upstreamUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]))
      expect(upstreamUrl.searchParams.get('apikey')).toBe(CHKSZ_USER_KEY)
      expect(await response.clone().text()).not.toContain(CHKSZ_USER_KEY)
      expect(await cache.putCalls[0]?.response.clone().text()).not.toContain(CHKSZ_USER_KEY)
      expect(await cache.putCalls[0]?.response.clone().text()).not.toContain(CHKSZ_KEY)
      await noSensitiveData(response)
    })

    it('uses the Owner key only when fallback is enabled and no user key exists', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      await setOwnerFallback(true)
      const fetchImpl = vi.fn(async () => upstreamJson(officialChkszResponse())) as unknown as typeof fetch
      const { handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest())

      expect(response.status).toBe(200)
      const upstreamUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]))
      expect(upstreamUrl.searchParams.get('apikey')).toBe(CHKSZ_KEY)
      await noSensitiveData(response)
    })

    it.each(['', '   ', 'x'.repeat(513)])('rejects an invalid user key before upstream access', async (key) => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveWithUserKey(key))

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_credential' })
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it.each([
      ['a missing deployment key', undefined],
      ['a whitespace-only deployment key', '   '],
    ])('fails closed without an upstream request for %s', async (_label, key) => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { handler } = await createHandler(fetchImpl, undefined, { CHKSZ_API_KEY: key })
      const response = await handler.fetch(resolveRequest())

      expect(response.status).toBe(503)
      expect(await response.clone().json()).toEqual({ error: 'credential_required' })
      expect(fetchImpl).not.toHaveBeenCalled()
      await noSensitiveData(response)
    })

    it('rechecks Admin enablement before spending a ChKSz metadata call', async () => {
      await seedProvider(database, 'chksz', 0, 20)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest())

      expect(response.status).toBe(503)
      expect(await response.clone().json()).toEqual({ error: 'unavailable' })
      expect(fetchImpl).not.toHaveBeenCalled()
      await noSensitiveData(response)
    })

    it.each([
      ['missing Origin', JSON.stringify({ externalId: CHKSZ_ID }), { 'content-type': 'application/json' }, 'https://study.example/api/providers/chksz/resolve'],
      ['cross-origin Origin', JSON.stringify({ externalId: CHKSZ_ID }), { 'content-type': 'application/json', origin: 'https://attacker.example' }, 'https://study.example/api/providers/chksz/resolve'],
      ['aliased request origin', JSON.stringify({ externalId: CHKSZ_ID }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://alias.example/api/providers/chksz/resolve'],
      ['JSON parameters', JSON.stringify({ externalId: CHKSZ_ID }), { 'content-type': 'application/json; charset=utf-8', origin: 'https://study.example' }, 'https://study.example/api/providers/chksz/resolve'],
      ['non-JSON MIME', JSON.stringify({ externalId: CHKSZ_ID }), { 'content-type': 'text/plain', origin: 'https://study.example' }, 'https://study.example/api/providers/chksz/resolve'],
      ['an extra property', JSON.stringify({ externalId: CHKSZ_ID, url: CHKSZ_TEMPORARY_URL }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/chksz/resolve'],
      ['a missing property', '{}', { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/chksz/resolve'],
      ['a non-string ID', JSON.stringify({ externalId: 1315196858 }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/chksz/resolve'],
      ['a non-numeric ID', JSON.stringify({ externalId: '1315196858a' }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/chksz/resolve'],
      ['an overlong numeric ID', JSON.stringify({ externalId: '123456789012345678901' }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/chksz/resolve'],
      ['an oversized actual body', `${' '.repeat(1_025)}${JSON.stringify({ externalId: CHKSZ_ID })}`, { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/chksz/resolve'],
      ['an oversized declared body', JSON.stringify({ externalId: CHKSZ_ID }), { 'content-length': '1025', 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/chksz/resolve'],
    ])('rejects %s before any upstream request', async (_label, body, headers, url) => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest(body, headers, url))

      expect(response.status).toBe(400)
      expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
      expect(fetchImpl).not.toHaveBeenCalled()
      await noSensitiveData(response)
    })

    // The Owner-fallback resolve contract must carry the user's selected ChKSz level. Every test
    // below pins one half of that contract: the accepted request shape, the level that reaches
    // upstream, and the failure modes that must not silently downgrade to `standard`.
    describe('Owner-fallback quality contract', () => {
      const CHKSZ_LEVELS = [
        'standard', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'jymaster',
      ] as const

      const resolveWithLevel = (body: unknown) => resolveRequest(
        JSON.stringify(body),
        { 'content-type': 'application/json', origin: 'https://study.example' },
      )

      // A. Every selectable level must be accepted and forwarded byte-for-byte.
      it.each(CHKSZ_LEVELS)('forwards the selected level %s to ChKSz unchanged', async (level) => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn(async () => upstreamJson(
          officialChkszResponse({ level }),
        )) as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        const response = await handler.fetch(resolveWithLevel({ externalId: CHKSZ_ID, level }))

        expect(response.status).toBe(200)
        expect(fetchImpl).toHaveBeenCalledOnce()
        const upstreamUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]))
        expect(upstreamUrl.origin + upstreamUrl.pathname).toBe('https://api.chksz.com/api/163_music')
        expect(upstreamUrl.searchParams.get('level')).toBe(level)
        await noSensitiveData(response)
      })

      // B. The previous behaviour hardcoded `standard`. These are the exact tiers that used to be
      // silently downgraded, so each one asserts the downgrade is gone rather than merely absent.
      it.each(['jymaster', 'sky', 'jyeffect'] as const)(
        'never reports %s as the upstream level when a different tier was requested',
        async (level) => {
          await seedProvider(database, 'chksz', 1, 20)
          await setOwnerFallback(true)
          const fetchImpl = vi.fn(async () => upstreamJson(
            officialChkszResponse({ level }),
          )) as unknown as typeof fetch
          const { handler } = await createHandler(fetchImpl)
          const response = await handler.fetch(resolveWithLevel({ externalId: CHKSZ_ID, level }))

          expect(response.status).toBe(200)
          const upstreamUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]))
          expect(upstreamUrl.searchParams.get('level')).toBe(level)
          expect(upstreamUrl.searchParams.get('level')).not.toBe('standard')
          await noSensitiveData(response)
        },
      )

      // C. A supplied level outside the ChKSz set is a client contract violation, not a hint to
      // fall back. It must be rejected before any credential is spent.
      it.each([
        'high', 'ultra', 'master', 'flac', '320k', '128k', '', 'STANDARD', 'Standard',
        'jymaster ', ' jymaster',
      ])('rejects the invalid supplied level %j without an upstream request', async (level) => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        const response = await handler.fetch(resolveWithLevel({ externalId: CHKSZ_ID, level }))

        expect(response.status).toBe(400)
        expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
        expect(fetchImpl).not.toHaveBeenCalled()
        await noSensitiveData(response)
      })

      it.each([
        ['a null level', null],
        ['a numeric level', 320],
        ['a boolean level', true],
        ['an object level', { level: 'sky' }],
        ['an array level', ['sky']],
      ])('rejects %s without an upstream request', async (_label, level) => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        const response = await handler.fetch(resolveWithLevel({ externalId: CHKSZ_ID, level }))

        expect(response.status).toBe(400)
        expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
        expect(fetchImpl).not.toHaveBeenCalled()
      })

      // D. The strict body contract predates this change and must survive it: the level is a new
      // permitted key, not a licence to accept arbitrary keys.
      it.each([
        ['an unknown key alongside a valid level', { externalId: CHKSZ_ID, level: 'lossless', unexpected: true }],
        ['an unknown key alongside a valid level (foo)', { externalId: CHKSZ_ID, level: 'lossless', foo: 'bar' }],
        ['an attempted credential override', { externalId: CHKSZ_ID, level: 'sky', apikey: 'attacker-key' }],
        ['an attempted credential override (apiKey)', { externalId: CHKSZ_ID, apiKey: 'attacker-key' }],
        ['an attempted upstream redirect', { externalId: CHKSZ_ID, level: 'sky', url: 'https://attacker.example/audio' }],
        ['a level-only body', { level: 'hires' }],
      ])('still rejects %s', async (_label, body) => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        const response = await handler.fetch(resolveWithLevel(body))

        expect(response.status).toBe(400)
        expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
        expect(fetchImpl).not.toHaveBeenCalled()
        await noSensitiveData(response)
      })

      // E. Backward compatibility is deliberate, not incidental: older clients send only
      // `{ externalId }`, and that must keep resolving at the historical `standard` level.
      it('keeps the missing-level body resolving at standard for older clients', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn(async () => upstreamJson(
          officialChkszResponse({ level: 'standard' }),
        )) as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        const response = await handler.fetch(resolveRequest())

        expect(response.status).toBe(200)
        const upstreamUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]))
        expect(upstreamUrl.searchParams.get('level')).toBe('standard')
        await noSensitiveData(response)
      })

      it('treats an explicit null level as invalid rather than as an omitted one', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        const response = await handler.fetch(resolveWithLevel({ externalId: CHKSZ_ID, level: null }))

        // An explicit `null` survives JSON serialisation, unlike `undefined`. It is a supplied
        // value that is not a ChKSz level, so it must be rejected rather than defaulted.
        expect(response.status).toBe(400)
        expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
        expect(fetchImpl).not.toHaveBeenCalled()
      })

      it('rejects an upstream response whose level does not match the requested level', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn(async () => upstreamJson(
          officialChkszResponse({ level: 'standard' }),
        )) as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        const response = await handler.fetch(resolveWithLevel({ externalId: CHKSZ_ID, level: 'jymaster' }))

        expect(response.status).toBe(502)
        expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
        await noSensitiveData(response)
      })

      it('keeps the owner key and the selected level out of the error body for the new failure modes', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn(async () => upstreamJson(
          officialChkszResponse({ level: 'standard' }),
        )) as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        const response = await handler.fetch(resolveWithLevel({ externalId: CHKSZ_ID, level: 'jymaster' }))
        const text = await response.clone().text()

        expect(response.status).toBe(502)
        expect(text).not.toContain(CHKSZ_KEY)
        expect(text).not.toContain('jymaster')
        expect(text).not.toContain('api.chksz.com')
        await noSensitiveData(response)
      })

      // The level is now a client-controlled value that reaches the upstream URL. These assertions
      // pin that it cannot become an injection point and that it cannot displace the credential.
      it('keeps the upstream request fixed to the ChKSz endpoint with exactly three parameters', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn(async () => upstreamJson(
          officialChkszResponse({ level: 'jymaster' }),
        )) as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        await handler.fetch(resolveWithLevel({ externalId: CHKSZ_ID, level: 'jymaster' }))

        const upstreamUrl = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]))
        expect(upstreamUrl.origin).toBe('https://api.chksz.com')
        expect(upstreamUrl.pathname).toBe('/api/163_music')
        expect(upstreamUrl.searchParams.get('apikey')).toBe(CHKSZ_KEY)
        expect([...upstreamUrl.searchParams.keys()].sort()).toEqual(['apikey', 'id', 'level'])
        // No client-supplied value can reach any other upstream parameter or the host.
        for (const key of upstreamUrl.searchParams.keys()) {
          expect(upstreamUrl.searchParams.get(key)).not.toContain('://')
        }
      })

      it('ignores a client attempt to override the credential or the upstream target', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn(async () => upstreamJson(officialChkszResponse())) as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)

        for (const body of [
          { externalId: CHKSZ_ID, level: 'sky', apikey: 'attacker-key' },
          { externalId: CHKSZ_ID, level: 'sky', apiKey: 'attacker-key' },
          { externalId: CHKSZ_ID, level: 'sky', url: 'https://attacker.example/x.mp3' },
          { externalId: CHKSZ_ID, level: 'sky', host: 'attacker.example' },
          { externalId: CHKSZ_ID, level: 'sky', level_override: 'jymaster' },
        ]) {
          const response = await handler.fetch(resolveWithLevel(body))
          expect(response.status).toBe(400)
        }
        // Every one of those was refused before spending a credential.
        expect(fetchImpl).not.toHaveBeenCalled()
      })

      it('never reflects the owner key even when the level is the requested one', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        await setOwnerFallback(true)
        const fetchImpl = vi.fn(async () => upstreamJson(
          officialChkszResponse({ level: 'hires' }),
        )) as unknown as typeof fetch
        const { cache, handler } = await createHandler(fetchImpl)
        const response = await handler.fetch(resolveWithLevel({ externalId: CHKSZ_ID, level: 'hires' }))
        const text = await response.clone().text()

        expect(response.status).toBe(200)
        expect(text).not.toContain(CHKSZ_KEY)
        expect(text).not.toContain('api.chksz.com')
        expect(text).not.toContain(CHKSZ_TEMPORARY_URL)
        const cachedBody = await cache.putCalls[0]!.response.json() as Record<string, unknown>
        expect(cachedBody).not.toHaveProperty('level')
        expect(JSON.stringify(cachedBody)).not.toContain(CHKSZ_KEY)
        await noSensitiveData(response)
      })
    })

    it('accepts the full official standard-level fixture and caches only the required preparation fields', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn(async () => upstreamJson(officialChkszResponse())) as unknown as typeof fetch
      const { cache, handler, nonce } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest())
      const body = await response.clone().json() as { mimeType: string; url: string }

      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(body).toEqual({
        mimeType: 'audio/mpeg',
        url: expect.stringMatching(`^/api/providers/chksz/media/${CHKSZ_ID}/[A-Za-z0-9_-]{32}$`),
        metadata: {
          quality: {
            tier: 'standard',
            bitrate: 128000,
          },
          artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Ffixture',
        },
      })
      expect(fetchImpl).toHaveBeenCalledOnce()
      const [upstreamUrl, init] = vi.mocked(fetchImpl).mock.calls[0]!
      const parsedUpstream = new URL(String(upstreamUrl))
      expect(`${parsedUpstream.origin}${parsedUpstream.pathname}`).toBe('https://api.chksz.com/api/163_music')
      expect([...parsedUpstream.searchParams.entries()]).toEqual([
        ['id', CHKSZ_ID],
        ['apikey', CHKSZ_KEY],
        ['level', 'standard'],
      ])
      expect(parsedUpstream.searchParams.get('level')).not.toBe('jymaster')
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(nonce.getRandomValues).toHaveBeenCalledOnce()
      expect(nonce.getRandomValues.mock.calls[0]?.[0]).toHaveLength(24)
      expect(cache.putCalls).toHaveLength(1)
      const cached = cache.putCalls[0]!
      expect(cached.request.method).toBe('GET')
      expect(cached.request.url).toBe(`https://study.example${body.url}`)
      expect(cached.response.headers.get('cache-control')).toBe('max-age=30')
      expect(cached.response.headers.get('content-type')).toContain('application/json')
      const cachedBody = await cached.response.json()
      expect(cachedBody).toEqual({
        providerId: 'chksz',
        externalId: CHKSZ_ID,
        nonce: CHKSZ_NONCE,
        validatedUrl: CHKSZ_TEMPORARY_URL,
        mimeType: 'audio/mpeg',
        expiresAt: 31_000,
      })
      expect(JSON.stringify(cachedBody)).not.toContain('fixture-md5')
      expect(JSON.stringify(cachedBody)).not.toContain('p1.music.126.net')
      expect(JSON.stringify(body)).not.toMatch(/fixture-md5|"picUrl"|\bbr\b|"size"/)
      const audits = await database.prepare('SELECT detail_json AS detailJson FROM admin_audit_log').all<{ detailJson: string }>()
      expect(JSON.stringify(audits.results)).not.toContain(CHKSZ_KEY)
      expect(JSON.stringify(audits.results)).not.toContain(CHKSZ_TEMPORARY_URL)
      await noSensitiveData(response)
    })

    it('accepts the current ChKSz parameterised JSON response MIME', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn(async () => upstreamJson(
        officialChkszResponse(),
        200,
        { 'content-type': 'application/json; charset=utf-8' },
      )) as unknown as typeof fetch
      const { cache, handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest())

      expect(response.status).toBe(200)
      expect(await response.clone().json()).toEqual({
        mimeType: 'audio/mpeg',
        url: expect.stringMatching(`^/api/providers/chksz/media/${CHKSZ_ID}/[A-Za-z0-9_-]{32}$`),
        metadata: {
          quality: {
            tier: 'standard',
            bitrate: 128000,
          },
          artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Ffixture',
        },
      })
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(cache.putCalls).toHaveLength(1)
      await noSensitiveData(response)
    })

    it('accepts only the required success subset while ignoring unknown root and data fields', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn(async () => upstreamJson({
        code: 200,
        futureRootField: { mustNotPersist: true },
        data: {
          id: 1315196858,
          level: 'standard',
          url: CHKSZ_TEMPORARY_URL,
          futureDataField: 'must-not-persist',
        },
      })) as unknown as typeof fetch
      const { cache, handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest())
      const body = await response.clone().json()

      expect(response.status).toBe(200)
      expect(body).toEqual({
        mimeType: 'audio/mpeg',
        url: expect.stringMatching(`^/api/providers/chksz/media/${CHKSZ_ID}/`),
        metadata: {
          quality: {
            tier: 'standard',
          },
        },
      })
      const cachedBody = await cache.putCalls[0]!.response.json()
      expect(cachedBody).toEqual({
        providerId: 'chksz',
        externalId: CHKSZ_ID,
        nonce: CHKSZ_NONCE,
        validatedUrl: CHKSZ_TEMPORARY_URL,
        mimeType: 'audio/mpeg',
        expiresAt: 31_000,
      })
      expect(JSON.stringify(body)).not.toContain('future')
      expect(JSON.stringify(cachedBody)).not.toContain('must-not-persist')
      await noSensitiveData(response)
    })

    it('maps ChKSz 429 before parsing any untrusted body', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn(async () => new Response(
        `${CHKSZ_KEY} ${CHKSZ_TEMPORARY_URL}`,
        { status: 429, headers: { 'content-type': 'text/plain' } },
      )) as unknown as typeof fetch
      const { handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest())

      expect(response.status).toBe(429)
      expect(await response.clone().json()).toEqual({ error: 'rate_limited' })
      expect(fetchImpl).toHaveBeenCalledOnce()
      await noSensitiveData(response)
    })

    it.each([
      [400, 'invalid_response'],
      [401, 'invalid_credential'],
      [402, 'quota_exhausted'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ])(
      'maps an upstream %i to the truthful %s code instead of collapsing it',
      async (status, code) => {
        await seedProvider(database, 'chksz', 1, 20)
        const fetchImpl = vi.fn(async () => new Response('', { status })) as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        const response = await handler.fetch(resolveRequest())

        // 429 keeps its transport meaning; every other upstream failure travels as 502 carrying
        // the truthful code, so the client reads the code rather than treating 404 as no mapping.
        expect(response.status).toBe(502)
        expect(await response.clone().json()).toEqual({ error: code })
        expect(fetchImpl).toHaveBeenCalledOnce()
        await noSensitiveData(response)
      },
    )

    it.each([
      ['invalid JSON', new Response(`{${CHKSZ_KEY}`, { headers: { 'content-type': 'application/json' } })],
      ['non-JSON MIME', upstreamJson(officialChkszResponse(), 200, { 'content-type': 'text/html; charset=utf-8' })],
      ['an oversized declared body', upstreamJson(officialChkszResponse(), 200, { 'content-length': String(64 * 1024 + 1) })],
      ['an oversized actual body', new Response(JSON.stringify({ ...officialChkszResponse(), padding: 'x'.repeat(64 * 1024) }), { headers: { 'content-type': 'application/json' } })],
      ['a missing code', upstreamJson({ data: officialChkszResponse().data })],
      ['a string code', upstreamJson({ ...officialChkszResponse(), code: '200' })],
      ['a non-success code', upstreamJson({ ...officialChkszResponse(), code: 500 })],
      ['a missing data object', upstreamJson({ code: 200 })],
      ['an array data value', upstreamJson({ code: 200, data: [] })],
      ['a missing ID', upstreamJson(officialChkszResponse({ id: undefined }))],
      ['a string ID', upstreamJson(officialChkszResponse({ id: CHKSZ_ID }))],
      ['a fractional ID', upstreamJson(officialChkszResponse({ id: 1315196858.5 }))],
      ['a mismatched ID', upstreamJson(officialChkszResponse({ id: 1315196859 }))],
      ['a missing level', upstreamJson(officialChkszResponse({ level: undefined }))],
      ['a numeric level', upstreamJson(officialChkszResponse({ level: 1 }))],
      ['a non-standard level', upstreamJson(officialChkszResponse({ level: 'jymaster' }))],
      ['a missing URL', upstreamJson(officialChkszResponse({ url: undefined }))],
      ['a non-string URL', upstreamJson(officialChkszResponse({ url: 123 }))],
      ['a redirected metadata response', new Response(null, { status: 302, headers: { location: CHKSZ_TEMPORARY_URL } })],
    ])('rejects %s as an invalid upstream response without disclosure', async (_label, upstreamResponse) => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn(async () => upstreamResponse) as unknown as typeof fetch
      const { handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest())

      expect(response.status).toBe(502)
      expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
      expect(fetchImpl).toHaveBeenCalledOnce()
      await noSensitiveData(response)
    })

    it('rejects an unsafe numeric ID even when its rounded value string matches the request', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      const unsafeId = '9007199254740992'
      const fetchImpl = vi.fn(async () => upstreamJson(officialChkszResponse({
        id: Number(unsafeId),
      }))) as unknown as typeof fetch
      const { handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest(
        JSON.stringify({ externalId: unsafeId }),
      ))

      expect(response.status).toBe(502)
      expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
      expect(fetchImpl).toHaveBeenCalledOnce()
      await noSensitiveData(response)
    })

    it.each([
      ['non-HTTPS', 'http://m801.music.126.net/audio'],
      ['credentials', 'https://user:password@m801.music.126.net/audio'],
      ['an explicit non-default port', 'https://m801.music.126.net:8443/audio'],
      ['an explicit default port', 'https://m801.music.126.net:443/audio'],
      ['a mixed-case scheme with an explicit default port', 'HtTpS://m801.music.126.net:443/audio'],
      ['a percent-encoded hostname', 'https://m801%2Emusic.126.net/audio'],
      ['a backslash authority', 'https:\\\\m801.music.126.net\\audio'],
      ['the exact base hostname', 'https://music.126.net/audio'],
      ['a leading empty hostname label', 'https://.music.126.net/audio'],
      ['a double-dot hostname label', 'https://m801..music.126.net/audio'],
      ['a trailing-dot hostname', 'https://m801.music.126.net./audio'],
      ['an unrelated hostname', 'https://attacker.example/audio'],
      ['a deceptive suffix', 'https://m801.music.126.net.attacker.example/audio'],
      ['an IPv6 authority', 'https://[::1]/audio'],
      ['a Unicode IDNA hostname', 'https://café.music.126.net/audio'],
      ['a punycode hostname label', 'https://xn--caf-dma.music.126.net/audio'],
      ['a fragment', 'https://m801.music.126.net/audio#fragment'],
      ['an upper-case hostname', 'https://M801.music.126.net/audio'],
    ])('rejects an upstream URL with %s', async (_label, upstreamUrl) => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn(async () => upstreamJson(officialChkszResponse({ url: upstreamUrl }))) as unknown as typeof fetch
      const { handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest())

      expect(response.status).toBe(502)
      expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
      expect(fetchImpl).toHaveBeenCalledOnce()
      await noSensitiveData(response)
    })

    it('accepts a mixed-case HTTPS scheme when the raw authority is otherwise canonical', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      const acceptedUrl = 'HtTpS://m801.music.126.net/audio'
      const fetchImpl = vi.fn(async () => upstreamJson(officialChkszResponse({ url: acceptedUrl }))) as unknown as typeof fetch
      const { cache, handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest())

      expect(response.status).toBe(200)
      expect(cache.putCalls).toHaveLength(1)
      expect(await cache.putCalls[0]!.response.json()).toEqual({
        providerId: 'chksz',
        externalId: CHKSZ_ID,
        nonce: CHKSZ_NONCE,
        validatedUrl: 'https://m801.music.126.net/audio',
        mimeType: 'audio/mpeg',
        expiresAt: 31_000,
      })
      await noSensitiveData(response)
    })

    it.each([
      ['a network failure', new Error(`${CHKSZ_KEY} ${CHKSZ_TEMPORARY_URL}`), 502, 'unavailable'],
      ['an upstream 5xx response', upstreamJson({ secret: CHKSZ_KEY }, 503), 502, 'unavailable'],
    ])('maps %s to a bounded unavailable response', async (_label, outcome, status, error) => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn(async () => {
        if (outcome instanceof Error) throw outcome
        return outcome
      }) as unknown as typeof fetch
      const { handler } = await createHandler(fetchImpl)
      const response = await handler.fetch(resolveRequest())

      expect(response.status).toBe(status)
      expect(await response.clone().json()).toEqual({ error })
      expect(fetchImpl).toHaveBeenCalledOnce()
      await noSensitiveData(response)
    })

    it('aborts the bounded metadata call after 4 seconds without disclosing its request', async () => {
      vi.useFakeTimers()
      try {
        await seedProvider(database, 'chksz', 1, 20)
        let markFetchStarted!: () => void
        const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve })
        const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          markFetchStarted()
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
          })
        }) as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl)
        const pending = handler.fetch(resolveRequest())

        await fetchStarted
        await vi.advanceTimersByTimeAsync(3_999)
        expect(fetchImpl).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(1)
        const response = await pending

        expect(response.status).toBe(504)
        expect(await response.clone().json()).toEqual({ error: 'timeout' })
        await noSensitiveData(response)
      } finally {
        vi.useRealTimers()
      }
    })

    it('fails closed when cache preparation cannot be committed and never logs the caught detail', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      const fetchImpl = vi.fn(async () => upstreamJson(officialChkszResponse())) as unknown as typeof fetch
      const cache = new FakePreparationCache()
      cache.failPut = new Error(`${CHKSZ_KEY} ${CHKSZ_TEMPORARY_URL}`)
      const consoleSpies = ['debug', 'error', 'info', 'log', 'warn'].map((name) =>
        vi.spyOn(console, name as 'log').mockImplementation(() => undefined))
      try {
        const { handler } = await createHandler(fetchImpl, cache)
        const response = await handler.fetch(resolveRequest())

        expect(response.status).toBe(503)
        expect(await response.clone().json()).toEqual({ error: 'unavailable' })
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(cache.putCalls).toHaveLength(1)
        consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled())
        await noSensitiveData(response)
      } finally {
        consoleSpies.forEach((spy) => spy.mockRestore())
      }
    })

    it('routes ChKSz requests before the authentication fallback', async () => {
      await seedProvider(database, 'chksz', 1, 20)
      const response = await worker.fetch(resolveRequest(), providerEnv({ CHKSZ_API_KEY: undefined }))

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'credential_required' })
    })

    describe('prepared media streaming', () => {
      it('rejects a cached preparation after its explicit 30-second expiry', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        let currentTime = 1_000
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
          String(input).startsWith('https://api.chksz.com/')
            ? upstreamJson(officialChkszResponse())
            : new Response('audio', { headers: { 'content-type': 'audio/mpeg' } })) as unknown as typeof fetch
        const { handler } = await createHandler(
          fetchImpl,
          new FakePreparationCache(),
          { CHKSZ_API_KEY: CHKSZ_KEY },
          () => currentTime,
        )
        const prepared = await handler.fetch(resolveRequest())
        const { url } = await prepared.json() as { url: string }
        currentTime = 31_001

        const response = await handler.fetch(new Request(`https://study.example${url}`))

        expect(prepared.status).toBe(200)
        expect(response.status).toBe(410)
        expect(await response.json()).toEqual({ error: 'preparation_expired' })
        expect(fetchImpl).toHaveBeenCalledOnce()
      })

      const cacheMetadata = async (
        cache: FakePreparationCache,
        validatedUrl = CHKSZ_TEMPORARY_URL,
        id = CHKSZ_ID,
        pathId = CHKSZ_ID,
        nonce = CHKSZ_NONCE,
        headers: HeadersInit = { 'cache-control': 'max-age=30', 'content-type': 'application/json' },
      ) => {
        await cache.put(
          new Request(mediaUrl(pathId, nonce), { method: 'GET' }),
          new Response(JSON.stringify({
            providerId: 'chksz',
            externalId: id,
            nonce,
            validatedUrl,
            mimeType: 'audio/mpeg',
            expiresAt: 31_000,
          }), { headers }),
        )
      }

      const enabledMediaHandler = async (
        fetchImpl: typeof fetch,
        cache = new FakePreparationCache(),
        envOverrides: Partial<ProviderEnv> = { CHKSZ_API_KEY: CHKSZ_KEY },
      ) => {
        await seedProvider(database, 'chksz', 1, 20)
        return createHandler(fetchImpl, cache, envOverrides)
      }

      const audioResponse = (
        status: 200 | 206,
        headers: Record<string, string>,
        bodyLength: number,
      ) => new Response(new Uint8Array(bodyLength), {
        status,
        headers: { 'content-type': 'audio/mpeg', ...headers },
      })

      it('serves a prepared ticket without requiring either API key again', async () => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn(async () => audioResponse(200, { 'content-length': '4' }, 4)) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache, { CHKSZ_API_KEY: undefined })
        const response = await handler.fetch(mediaRequest())

        expect(response.status).toBe(200)
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(cache.matchCalls).toHaveLength(1)
        await noSensitiveData(response)
      })

      it('rechecks Admin enablement at media time before reading cache or fetching the CDN', async () => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        await seedProvider(database, 'chksz', 0, 20)
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await createHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest())

        expect(response.status).toBe(503)
        expect(fetchImpl).not.toHaveBeenCalled()
        expect(cache.matchCalls).toHaveLength(0)
        await noSensitiveData(response)
      })

      it.each([
        ['a non-numeric ID', 'abc', CHKSZ_NONCE, ''],
        ['an overlong ID', '123456789012345678901', CHKSZ_NONCE, ''],
        ['a short nonce', CHKSZ_ID, 'short', ''],
        ['a padded nonce', CHKSZ_ID, `${CHKSZ_NONCE}=`, ''],
        ['a nonce with a slash', CHKSZ_ID, `${CHKSZ_NONCE.slice(0, -1)}/`, ''],
        ['a query string', CHKSZ_ID, CHKSZ_NONCE, '?url=https://attacker.example'],
        ['an extra path segment', CHKSZ_ID, CHKSZ_NONCE, '/extra'],
      ])('rejects a media path containing %s before cache access', async (_label, id, nonce, suffix) => {
        const cache = new FakePreparationCache()
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest('GET', {}, id, nonce, suffix))

        expect(response.status).toBe(400)
        expect(fetchImpl).not.toHaveBeenCalled()
        expect(cache.matchCalls).toHaveLength(0)
        await noSensitiveData(response)
      })

      it('rejects a media request received on a non-canonical request origin', async () => {
        const cache = new FakePreparationCache()
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const request = new Request(mediaUrl().replace('study.example', 'alias.example'))
        const response = await handler.fetch(request)

        expect(response.status).toBe(400)
        expect(fetchImpl).not.toHaveBeenCalled()
        expect(cache.matchCalls).toHaveLength(0)
      })

      it('allows only GET and HEAD on prepared media', async () => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest('POST'))

        expect(response.status).toBe(405)
        expect(fetchImpl).not.toHaveBeenCalled()
        expect(cache.matchCalls).toHaveLength(0)
      })

      it('returns 410 for a cache miss without issuing a replacement metadata call', async () => {
        const cache = new FakePreparationCache()
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest())

        expect(response.status).toBe(410)
        expect(await response.clone().json()).toEqual({ error: 'preparation_expired' })
        expect(fetchImpl).not.toHaveBeenCalled()
        expect(cache.matchCalls).toHaveLength(1)
        expect(cache.matchCalls[0]?.method).toBe('GET')
        expect(cache.matchCalls[0]?.url).toBe(mediaUrl())
        await noSensitiveData(response)
      })

      it('fails closed on cache access failure without issuing an upstream request', async () => {
        const cache = new FakePreparationCache()
        cache.failMatch = new Error(`${CHKSZ_KEY} ${CHKSZ_TEMPORARY_URL}`)
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest())

        expect(response.status).toBe(503)
        expect(await response.clone().json()).toEqual({ error: 'unavailable' })
        expect(fetchImpl).not.toHaveBeenCalled()
        await noSensitiveData(response)
      })

      it.each([
        ['a mismatched cached ID', CHKSZ_TEMPORARY_URL, '1315196859', { 'cache-control': 'max-age=30', 'content-type': 'application/json' }],
        ['an unsafe cached URL', 'https://attacker.example/audio', CHKSZ_ID, { 'cache-control': 'max-age=30', 'content-type': 'application/json' }],
        ['a non-JSON cache entry', CHKSZ_TEMPORARY_URL, CHKSZ_ID, { 'cache-control': 'max-age=30', 'content-type': 'text/plain' }],
      ])('rejects %s before fetching media', async (_label, cachedUrl, cachedId, headers) => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache, cachedUrl, cachedId, CHKSZ_ID, CHKSZ_NONCE, headers)
        const fetchImpl = vi.fn() as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest())

        expect(response.status).toBe(502)
        expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
        expect(fetchImpl).not.toHaveBeenCalled()
        await noSensitiveData(response)
      })

      it.each([
        'bytes=100-199,300-399',
        'bytes=-',
        'bytes= 100-199',
        'bytes=100 -199',
        'Bytes=100-199',
        'bytes=200-100',
        'bytes=-0',
      ])('rejects malformed or multi-range input before CDN fetch: %s', async (range) => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn(async () => audioResponse(200, {}, 0)) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest('GET', { range }))

        expect(response.status).toBe(400)
        expect(fetchImpl).not.toHaveBeenCalled()
        await noSensitiveData(response)
      })

      it.each([
        ['bytes=100-199', 'bytes 100-199/1000', '100', 100],
        ['bytes=100-', 'bytes 100-999/1000', '900', 900],
        ['bytes=-200', 'bytes 800-999/1000', '200', 200],
        ['bytes=9007199254740993-9007199254740994', 'bytes 9007199254740993-9007199254740994/9007199254740995', '2', 2],
      ])(
        'forwards exactly one safe Range header: %s',
        async (range, contentRange, contentLength, bodyLength) => {
          const cache = new FakePreparationCache()
          await cacheMetadata(cache)
          const fetchImpl = vi.fn(async () => audioResponse(206, {
              'accept-ranges': 'bytes',
              'content-length': contentLength,
              'content-range': contentRange,
              'set-cookie': 'private=cookie',
              server: 'private-upstream',
              'x-upstream-url': CHKSZ_TEMPORARY_URL,
            }, bodyLength)) as unknown as typeof fetch
          const { handler } = await enabledMediaHandler(fetchImpl, cache)
          const response = await handler.fetch(mediaRequest('GET', { range }))

          expect(response.status).toBe(206)
          expect((await response.clone().arrayBuffer()).byteLength).toBe(bodyLength)
          expect(fetchImpl).toHaveBeenCalledOnce()
          const [cdnUrl, init] = vi.mocked(fetchImpl).mock.calls[0]!
          expect(String(cdnUrl)).toBe(CHKSZ_TEMPORARY_URL)
          expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })
          expect([...new Headers(init?.headers).entries()]).toEqual([['range', range]])
          expect([...response.headers.entries()]).toEqual([
            ['accept-ranges', 'bytes'],
            ['cache-control', 'no-store'],
            ['content-length', contentLength],
            ['content-range', contentRange],
            ['content-type', 'audio/mpeg'],
          ])
          await noSensitiveData(response)
        },
      )

      it.each([
        ['206 without a request Range', null, 206, { 'content-length': '100', 'content-range': 'bytes 0-99/1000' }, 100],
        ['206 without Content-Range', 'bytes=100-199', 206, { 'content-length': '100' }, 100],
        ['an unsatisfied Content-Range', 'bytes=100-199', 206, { 'content-range': 'bytes */*' }, 0],
        ['a reversed Content-Range', 'bytes=100-199', 206, { 'content-length': '100', 'content-range': 'bytes 199-100/1000' }, 100],
        ['an out-of-total Content-Range', 'bytes=900-1000', 206, { 'content-length': '101', 'content-range': 'bytes 900-1000/1000' }, 101],
        ['an unrelated Content-Range', 'bytes=100-199', 206, { 'content-length': '100', 'content-range': 'bytes 200-299/1000' }, 100],
        ['a mismatched Content-Length', 'bytes=100-199', 206, { 'content-length': '99', 'content-range': 'bytes 100-199/1000' }, 99],
        ['an incomplete closed interval', 'bytes=100-199', 206, { 'content-length': '51', 'content-range': 'bytes 100-150/1000' }, 51],
        ['an unknown-total suffix response', 'bytes=-200', 206, { 'content-length': '200', 'content-range': 'bytes 800-999/*' }, 200],
        ['a wrong suffix interval', 'bytes=-200', 206, { 'content-length': '200', 'content-range': 'bytes 700-899/1000' }, 200],
        ['a BigInt-unrelated interval', 'bytes=9007199254740993-9007199254740994', 206, { 'content-length': '2', 'content-range': 'bytes 9007199254740992-9007199254740993/9007199254740995' }, 2],
        ['Content-Range on a 200 without request Range', null, 200, { 'content-length': '100', 'content-range': 'bytes 0-99/1000' }, 100],
        ['Content-Range on a 200 that ignored Range', 'bytes=100-199', 200, { 'content-length': '100', 'content-range': 'bytes 100-199/1000' }, 100],
      ])('rejects inconsistent partial semantics: %s', async (
        _label,
        range,
        status,
        headers,
        bodyLength,
      ) => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn(async () => audioResponse(
          status as 200 | 206,
          headers,
          bodyLength,
        )) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest('GET', range ? { range } : {}))

        expect(response.status).toBe(502)
        expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
        expect(fetchImpl).toHaveBeenCalledOnce()
        await noSensitiveData(response)
      })

      it('permits an upstream 200 to ignore a valid forwarded Range only without Content-Range', async () => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn(async () => audioResponse(200, { 'content-length': '5' }, 5)) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest('GET', { range: 'bytes=100-199' }))

        expect(response.status).toBe(200)
        expect((await response.arrayBuffer()).byteLength).toBe(5)
        const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
        expect(new Headers(init?.headers).get('range')).toBe('bytes=100-199')
        expect(response.headers.get('content-range')).toBeNull()
      })

      it('streams a 200 audio response without forwarding ambient request headers', async () => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn(async () => new Response('audio', {
          headers: { 'content-length': '5', 'content-type': 'audio/mpeg' },
        })) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest('GET', {
          authorization: 'private-browser-value',
          cookie: 'private-browser-cookie',
        }))

        expect(response.status).toBe(200)
        expect(await response.clone().text()).toBe('audio')
        const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
        expect([...new Headers(init?.headers).entries()]).toEqual([])
        expect(response.headers.get('cache-control')).toBe('no-store')
        await noSensitiveData(response)
      })

      it('preserves the existing ChKSz audio-family contract across MIME subtypes', async () => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn(async () => new Response('audio', {
          headers: { 'content-length': '5', 'content-type': 'audio/ogg' },
        })) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)

        const response = await handler.fetch(mediaRequest())

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('audio/ogg')
        expect(await response.text()).toBe('audio')
        expect(fetchImpl).toHaveBeenCalledOnce()
      })

      it('uses upstream HEAD and returns the safe headers with a null body', async () => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn(async () => new Response('body-must-not-survive', {
          headers: { 'content-length': '20', 'content-type': 'audio/mpeg', server: 'private' },
        })) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest('HEAD'))

        expect(response.status).toBe(200)
        expect(await response.text()).toBe('')
        const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
        expect(init).toMatchObject({ method: 'HEAD', redirect: 'manual' })
        expect(response.headers.get('content-type')).toBe('audio/mpeg')
        expect(response.headers.get('server')).toBeNull()
      })

      it('follows at most two allowlisted manual redirects and revalidates each Location', async () => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const responses = [
          new Response(null, { status: 302, headers: { location: '//m802.music.126.net/redirect-one' } }),
          new Response(null, { status: 307, headers: { location: '/final' } }),
          new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }),
        ]
        const fetchImpl = vi.fn(async () => responses.shift()!) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest())

        expect(response.status).toBe(200)
        expect(fetchImpl).toHaveBeenCalledTimes(3)
        expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
          CHKSZ_TEMPORARY_URL,
          'https://m802.music.126.net/redirect-one',
          'https://m802.music.126.net/final',
        ])
        vi.mocked(fetchImpl).mock.calls.forEach(([, init]) =>
          expect(init?.redirect).toBe('manual'))
      })

      it.each([
        ['a missing Location', null],
        ['non-HTTPS Location', 'http://m802.music.126.net/audio'],
        ['credentials in Location', 'https://user:password@m802.music.126.net/audio'],
        ['an explicit port in Location', 'https://m802.music.126.net:8443/audio'],
        ['an explicit default port in Location', 'https://m802.music.126.net:443/audio'],
        ['a mixed-case scheme with an explicit default port', 'HtTpS://m802.music.126.net:443/audio'],
        ['an encoded hostname with a mixed-case scheme', 'HtTpS://m802%2Emusic.126.net/audio'],
        ['a backslash network path', '\\\\m802.music.126.net\\audio'],
        ['a scheme-relative explicit default port', '//m802.music.126.net:443/audio'],
        ['the exact base hostname in Location', 'https://music.126.net/audio'],
        ['a leading empty hostname label', 'https://.music.126.net/audio'],
        ['a double-dot hostname label', 'https://m802..music.126.net/audio'],
        ['a trailing-dot hostname', 'https://m802.music.126.net./audio'],
        ['an unrelated hostname in Location', 'https://attacker.example/audio'],
        ['a deceptive hostname suffix', 'https://m802.music.126.net.attacker.example/audio'],
        ['a scheme-relative unrelated hostname', '//attacker.example/audio'],
        ['an IPv6 authority', 'https://[::1]/audio'],
        ['a Unicode IDNA hostname', 'https://café.music.126.net/audio'],
        ['a punycode hostname label', 'https://xn--caf-dma.music.126.net/audio'],
        ['a fragment in Location', 'https://m802.music.126.net/audio#fragment'],
      ])('rejects a redirect with %s without fetching the target', async (_label, location) => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const headers = new Headers()
        if (location) headers.set('location', location)
        const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers })) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest())

        expect(response.status).toBe(502)
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
        await noSensitiveData(response)
      })

      it('rejects a third redirect without issuing a fourth CDN request', async () => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn(async () => new Response(null, {
          status: 302,
          headers: { location: '/another' },
        })) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest())

        expect(response.status).toBe(502)
        expect(fetchImpl).toHaveBeenCalledTimes(3)
        expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
        await noSensitiveData(response)
      })

      it.each([
        ['a non-audio MIME', new Response('html', { headers: { 'content-type': 'text/html' } })],
        ['a missing MIME', new Response('unknown')],
        ['an unsupported status', new Response(null, { status: 416 })],
      ])('rejects media with %s', async (_label, upstreamResponse) => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn(async () => upstreamResponse) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const response = await handler.fetch(mediaRequest())

        expect(response.status).toBe(502)
        expect(await response.clone().json()).toEqual({ error: 'invalid_response' })
        await noSensitiveData(response)
      })

      it('maps a CDN network failure to a bounded unavailable response without logging detail', async () => {
        const cache = new FakePreparationCache()
        await cacheMetadata(cache)
        const fetchImpl = vi.fn(async () => {
          throw new Error(`${CHKSZ_KEY} ${CHKSZ_TEMPORARY_URL}`)
        }) as unknown as typeof fetch
        const consoleSpies = ['debug', 'error', 'info', 'log', 'warn'].map((name) =>
          vi.spyOn(console, name as 'log').mockImplementation(() => undefined))
        try {
          const { handler } = await enabledMediaHandler(fetchImpl, cache)
          const response = await handler.fetch(mediaRequest())

          expect(response.status).toBe(502)
          expect(await response.clone().json()).toEqual({ error: 'unavailable' })
          consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled())
          await noSensitiveData(response)
        } finally {
          consoleSpies.forEach((spy) => spy.mockRestore())
        }
      })

      it('contains a media cache miss after preparation without making a second ChKSz call', async () => {
        const cache = new FakePreparationCache()
        const fetchImpl = vi.fn(async () => upstreamJson(officialChkszResponse())) as unknown as typeof fetch
        const { handler } = await enabledMediaHandler(fetchImpl, cache)
        const prepared = await handler.fetch(resolveRequest())
        const body = await prepared.json() as { url: string }
        cache.clear()

        const response = await handler.fetch(new Request(`https://study.example${body.url}`))

        expect(prepared.status).toBe(200)
        expect(response.status).toBe(410)
        expect(fetchImpl).toHaveBeenCalledOnce()
        await noSensitiveData(response)
      })

      it('routes media before the authentication fallback', async () => {
        const response = await worker.fetch(mediaRequest(), providerEnv({ CHKSZ_API_KEY: undefined }))

        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: 'unavailable' })
      })
    })
  })

  it('routes Meting resolve and media paths before the authentication fallback', async () => {
    const resolveResponse = await worker.fetch(new Request(
      'https://study.example/api/providers/meting/resolve',
      {
        body: JSON.stringify({ externalId: 'not-a-meting-id' }),
        headers: { 'content-type': 'application/json', origin: 'https://study.example' },
        method: 'POST',
      },
    ), providerEnv())
    const mediaResponse = await worker.fetch(new Request(
      `https://study.example/api/providers/meting/media/netease:123456789/${CHKSZ_NONCE}`,
    ), providerEnv({
      METING_API_BASE_URL: 'https://meting.example',
      METING_MEDIA_ALLOWED_HOSTNAMES: 'media.example',
    }))

    expect(resolveResponse.status).toBe(400)
    expect(await resolveResponse.json()).toEqual({ error: 'invalid_response' })
    expect(mediaResponse.status).toBe(400)
    expect(await mediaResponse.json()).toEqual({ error: 'invalid_response' })
  })

  it('routes Jellyfin, GD Studio, and HuanYin resolve and media paths before authentication fallback', async () => {
    for (const id of ['jellyfin', 'gd-studio', 'lx-huanyin'] as const) {
      const resolveResponse = await worker.fetch(new Request(
        `https://study.example/api/providers/${id}/resolve`,
        {
          body: JSON.stringify({ externalId: 'not-a-valid-id' }),
          headers: { 'content-type': 'application/json', origin: 'https://study.example' },
          method: 'POST',
        },
      ), providerEnv())
      const mediaResponse = await worker.fetch(new Request(
        `https://study.example/api/providers/${id}/media/invalid-id/${CHKSZ_NONCE}`,
      ), providerEnv())

      expect(resolveResponse.status).toBe(400)
      expect(await resolveResponse.json()).toEqual({ error: 'invalid_response' })
      expect(mediaResponse.status).toBe(400)
      expect(await mediaResponse.json()).toEqual({ error: 'invalid_response' })
    }
  })

  describe('artwork proxy routes', () => {
    describe('ChKSz artwork proxy', () => {
      it('rejects missing or invalid url query parameters', async () => {
        const handler = createProviderHandler(providerEnv())
        for (const target of [
          'https://study.example/api/providers/chksz/artwork',
          'https://study.example/api/providers/chksz/artwork?url=https://attacker.com/malicious.jpg',
          'https://study.example/api/providers/chksz/artwork?url=http://169.254.169.254/latest/meta-data',
          'https://study.example/api/providers/chksz/artwork?url=javascript:alert(1)',
        ]) {
          const response = await handler.fetch(new Request(target, { method: 'GET' }))
          expect(response.status).toBe(400)
          expect(await response.json()).toEqual({ error: 'invalid_response' })
        }
      })

      it('rejects methods other than GET and HEAD', async () => {
        const handler = createProviderHandler(providerEnv())
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/chksz/artwork?url=https://p1.music.126.net/fixture.jpg',
          { method: 'POST' },
        ))
        expect(response.status).toBe(405)
        expect(await response.json()).toEqual({ error: 'method_not_allowed' })
      })

      it('fetches and streams valid artwork with security headers', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        const sampleImage = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
        const fetchImpl = vi.fn(async () => new Response(sampleImage, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': '4',
          },
        })) as unknown as typeof fetch

        const handler = createProviderHandler(providerEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/chksz/artwork?url=https://p1.music.126.net/fixture.jpg',
        ))

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/jpeg')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(sampleImage)
      })

      it('rejects non-image MIME types from upstream', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        const fetchImpl = vi.fn(async () => new Response('<script>evil()</script>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch

        const handler = createProviderHandler(providerEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/chksz/artwork?url=https://p1.music.126.net/fixture.jpg',
        ))

        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: 'invalid_response' })
      })

      it('rejects oversized artwork exceeding limit', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        const fetchImpl = vi.fn(async () => new Response('large', {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': '6000000',
          },
        })) as unknown as typeof fetch

        const handler = createProviderHandler(providerEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/chksz/artwork?url=https://p1.music.126.net/fixture.jpg',
        ))

        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: 'invalid_response' })
      })

      it('returns 404 when upstream image returns 404', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch

        const handler = createProviderHandler(providerEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/chksz/artwork?url=https://p1.music.126.net/fixture.jpg',
        ))

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'not_found' })
      })

      it('returns 503 when chksz provider is disabled', async () => {
        await seedProvider(database, 'chksz', 0, 20)
        const handler = createProviderHandler(providerEnv())
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/chksz/artwork?url=https://p1.music.126.net/fixture.jpg',
        ))

        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: 'unavailable' })
      })

      it('passes referrerPolicy no-referrer to upstream fetch options', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        let capturedInit: RequestInit | undefined
        const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          capturedInit = init
          return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          })
        }) as unknown as typeof fetch

        const handler = createProviderHandler(providerEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/chksz/artwork?url=https://p1.music.126.net/fixture.jpg',
        ))

        expect(response.status).toBe(200)
        expect(capturedInit?.referrerPolicy).toBe('no-referrer')
      })

      it('answers HEAD requests cleanly with 200 and no body', async () => {
        await seedProvider(database, 'chksz', 1, 20)
        const fetchImpl = vi.fn(async () => new Response(null, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': '1234',
          },
        })) as unknown as typeof fetch

        const handler = createProviderHandler(providerEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/chksz/artwork?url=https://p1.music.126.net/fixture.jpg',
          { method: 'HEAD' },
        ))

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/jpeg')
        expect(response.headers.get('content-length')).toBe('1234')
        expect(response.headers.get('cache-control')).toBe('public, max-age=86400')
        expect(response.body).toBeNull()
      })
    })

    describe('Jellyfin artwork proxy', () => {
      const jellyfinEnv = (overrides: Partial<ProviderEnv> = {}) => providerEnv({
        JELLYFIN_BASE_URL: 'https://jellyfin.example',
        JELLYFIN_API_TOKEN: 'secret-jellyfin-token',
        JELLYFIN_USER_ID: '0123456789abcdef0123456789abcdef',
        ...overrides,
      })

      it('rejects invalid or path-traversal external IDs', async () => {
        const handler = createProviderHandler(jellyfinEnv())
        for (const badId of ['..%2Fetc%2Fpasswd', 'not-hex', '123', 'a'.repeat(33)]) {
          const response = await handler.fetch(new Request(
            `https://study.example/api/providers/jellyfin/artwork/${badId}`,
          ))
          expect(response.status).toBe(400)
          expect(await response.json()).toEqual({ error: 'invalid_response' })
        }
      })

      it('rejects query parameters or hash on the artwork URL', async () => {
        const handler = createProviderHandler(jellyfinEnv())
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/jellyfin/artwork/0123456789abcdef0123456789abcdef?foo=bar',
        ))
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_response' })
      })

      it('fetches primary image from Jellyfin origin with auth headers and without leaking credentials', async () => {
        await seedProvider(database, 'jellyfin', 1, 30)
        const sampleImage = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
        const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          expect(String(input)).toBe('https://jellyfin.example/Items/0123456789abcdef0123456789abcdef/Images/Primary?maxWidth=512&maxHeight=512')
          const headers = new Headers(init?.headers)
          expect(headers.get('authorization')).toBe('MediaBrowser Token="secret-jellyfin-token"')
          return new Response(sampleImage, {
            status: 200,
            headers: {
              'content-type': 'image/png',
              'content-length': '4',
            },
          })
        }) as unknown as typeof fetch

        const handler = createProviderHandler(jellyfinEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/jellyfin/artwork/0123456789abcdef0123456789abcdef',
        ))

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(sampleImage)

        // Verify no credentials leaked to client
        const serializedHeaders = JSON.stringify([...response.headers])
        expect(serializedHeaders).not.toContain('secret-jellyfin-token')
        expect(serializedHeaders).not.toContain('https://jellyfin.example')
      })

      it('returns 404 when item image is not found upstream', async () => {
        await seedProvider(database, 'jellyfin', 1, 30)
        const fetchImpl = vi.fn(async () => new Response('Item not found', { status: 404 })) as unknown as typeof fetch

        const handler = createProviderHandler(jellyfinEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/jellyfin/artwork/0123456789abcdef0123456789abcdef',
        ))

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({ error: 'not_found' })
      })

      it('returns 503 when jellyfin provider is disabled', async () => {
        await seedProvider(database, 'jellyfin', 0, 30)
        const handler = createProviderHandler(jellyfinEnv())
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/jellyfin/artwork/0123456789abcdef0123456789abcdef',
        ))

        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: 'unavailable' })
      })

      it('answers HEAD requests cleanly with 200 and no body', async () => {
        await seedProvider(database, 'jellyfin', 1, 30)
        const fetchImpl = vi.fn(async () => new Response(null, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': '5678',
          },
        })) as unknown as typeof fetch

        const handler = createProviderHandler(jellyfinEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/jellyfin/artwork/0123456789abcdef0123456789abcdef',
          { method: 'HEAD' },
        ))

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(response.headers.get('content-length')).toBe('5678')
        expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
        expect(response.body).toBeNull()
      })

      it('rejects non-image MIME types from upstream Jellyfin', async () => {
        await seedProvider(database, 'jellyfin', 1, 30)
        const fetchImpl = vi.fn(async () => new Response('<html>not an image</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })) as unknown as typeof fetch

        const handler = createProviderHandler(jellyfinEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/jellyfin/artwork/0123456789abcdef0123456789abcdef',
        ))

        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: 'invalid_response' })
      })

      it('rejects oversized artwork exceeding limit from upstream Jellyfin', async () => {
        await seedProvider(database, 'jellyfin', 1, 30)
        const fetchImpl = vi.fn(async () => new Response('large', {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': '6000000',
          },
        })) as unknown as typeof fetch

        const handler = createProviderHandler(jellyfinEnv(), { fetch: fetchImpl })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/jellyfin/artwork/0123456789abcdef0123456789abcdef',
        ))

        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: 'invalid_response' })
      })
    })

    describe('Jellyfin resolve artwork metadata', () => {
      const jellyfinEnv = (overrides: Partial<ProviderEnv> = {}) => providerEnv({
        JELLYFIN_BASE_URL: 'https://jellyfin.example',
        JELLYFIN_API_TOKEN: 'secret-jellyfin-token',
        JELLYFIN_USER_ID: '0123456789abcdef0123456789abcdef',
        ...overrides,
      })

      it('returns same-origin artworkUrl when resolving Jellyfin item with primary image', async () => {
        await seedProvider(database, 'jellyfin', 1, 30)
        const jellyfinItemId = '0123456789abcdef0123456789abcdef'
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
          const urlStr = String(input)
          if (urlStr.includes(`/Items/${jellyfinItemId}`)) {
            return new Response(JSON.stringify({
              Id: jellyfinItemId,
              Type: 'Audio',
              MediaType: 'Audio',
              Container: 'flac',
              ImageTags: { Primary: 'tag-primary-1' },
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response('not found', { status: 404 })
        }) as unknown as typeof fetch

        const cache = new FakePreparationCache()
        const handler = createProviderHandler(jellyfinEnv(), {
          fetch: fetchImpl,
          cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/jellyfin/resolve',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'https://study.example',
            },
            body: JSON.stringify({ externalId: jellyfinItemId }),
          },
        ))

        expect(response.status).toBe(200)
        const data = await response.json() as any
        expect(data.metadata.artworkUrl).toBe(`/api/providers/jellyfin/artwork/${jellyfinItemId}`)
      })

      it('returns album artworkUrl when item only has album image', async () => {
        await seedProvider(database, 'jellyfin', 1, 30)
        const jellyfinItemId = '0123456789abcdef0123456789abcdef'
        const albumId = 'fedcba9876543210fedcba9876543210'
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
          const urlStr = String(input)
          if (urlStr.includes(`/Items/${jellyfinItemId}`)) {
            return new Response(JSON.stringify({
              Id: jellyfinItemId,
              Type: 'Audio',
              MediaType: 'Audio',
              Container: 'flac',
              AlbumId: albumId,
              AlbumPrimaryImageTag: 'album-tag-1',
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response('not found', { status: 404 })
        }) as unknown as typeof fetch

        const cache = new FakePreparationCache()
        const handler = createProviderHandler(jellyfinEnv(), {
          fetch: fetchImpl,
          cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/jellyfin/resolve',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'https://study.example',
            },
            body: JSON.stringify({ externalId: jellyfinItemId }),
          },
        ))

        expect(response.status).toBe(200)
        const data = await response.json() as any
        expect(data.metadata.artworkUrl).toBe(`/api/providers/jellyfin/artwork/${albumId}`)
      })

      it('omits artworkUrl when item has no primary or album image', async () => {
        await seedProvider(database, 'jellyfin', 1, 30)
        const jellyfinItemId = '0123456789abcdef0123456789abcdef'
        const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
          const urlStr = String(input)
          if (urlStr.includes(`/Items/${jellyfinItemId}`)) {
            return new Response(JSON.stringify({
              Id: jellyfinItemId,
              Type: 'Audio',
              MediaType: 'Audio',
              Container: 'flac',
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response('not found', { status: 404 })
        }) as unknown as typeof fetch

        const cache = new FakePreparationCache()
        const handler = createProviderHandler(jellyfinEnv(), {
          fetch: fetchImpl,
          cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        })
        const response = await handler.fetch(new Request(
          'https://study.example/api/providers/jellyfin/resolve',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'https://study.example',
            },
            body: JSON.stringify({ externalId: jellyfinItemId }),
          },
        ))

        expect(response.status).toBe(200)
        const data = await response.json() as any
        expect(data.metadata.artworkUrl).toBeUndefined()
      })
    })
  })


  // F3 — bounded GD Studio failure observability, exercised through the real route so the
  // public envelope (error + HTTP status) and the additive discriminator are asserted together.
  describe('GD Studio resolve failure diagnostics', () => {
    const gdRequest = () => new Request('https://study.example/api/providers/gd-studio/resolve', {
      body: JSON.stringify({ externalId: 'netease:2100334024:320' }),
      headers: { 'content-type': 'application/json', origin: 'https://study.example' },
      method: 'POST',
    })

    const gdEnv = (fetchImpl: typeof fetch) => ({
      GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
      GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'm701.music.126.net',
    }) as unknown as Partial<ProviderEnv>

    const dispatchWithFetch = async (fetchImpl: typeof fetch) => {
      // GD must be effective-enabled or the route short-circuits at 503 before the adapter runs.
      // Idempotent so a test may dispatch more than once within a single case.
      await database.prepare('DELETE FROM provider_health WHERE provider_key = ?')
        .bind('gd-studio').run()
      await seedProvider(database, 'gd-studio', 1, 2)
      const handler = createProviderHandler(
        providerEnv(gdEnv(fetchImpl)),
        { fetch: fetchImpl },
      )
      return handler.fetch(gdRequest())
    }

    it('keeps error=unavailable / HTTP 502 but adds code=gd_upstream_http for an upstream 503', async () => {
      const fetchImpl = vi.fn(async () => new Response('upstream detail', { status: 503 })) as unknown as typeof fetch

      const response = await dispatchWithFetch(fetchImpl)

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'unavailable', code: 'gd_upstream_http' })
    })

    it('keeps error=unavailable / HTTP 502 but adds code=gd_missing_media_url when the 200 body has no url', async () => {
      const fetchImpl = vi.fn(async () => new Response(
        JSON.stringify({ br: 320, size: 123456, from: 'netease' }),
        { headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch

      const response = await dispatchWithFetch(fetchImpl)

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'unavailable', code: 'gd_missing_media_url' })
    })

    it('distinguishes the two 502 boundaries end-to-end without changing status or error', async () => {
      const httpError = await dispatchWithFetch(
        vi.fn(async () => new Response('x', { status: 503 })) as unknown as typeof fetch,
      )
      const missingUrl = await dispatchWithFetch(
        vi.fn(async () => new Response(JSON.stringify({ from: 'netease' }), {
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      )

      expect(httpError.status).toBe(502)
      expect(missingUrl.status).toBe(502)
      const a = await httpError.json() as Record<string, unknown>
      const b = await missingUrl.json() as Record<string, unknown>
      expect(a.error).toBe('unavailable')
      expect(b.error).toBe('unavailable')
      expect(a.code).not.toBe(b.code)
    })

    it('emits a bounded structured log record carrying no URL, token, or body', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const fetchImpl = vi.fn(async () => new Response(
          JSON.stringify({
            url: 'https://evil.attacker.invalid/audio.mp3?token=super-secret-token',
            from: 'netease',
          }),
          { headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch

        const response = await dispatchWithFetch(fetchImpl)
        expect(response.status).toBe(502)

        expect(warn).toHaveBeenCalled()
        const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
        expect(logged).toContain('provider_resolve_failure')
        expect(logged).toContain('gd-studio')
        expect(logged).not.toContain('super-secret-token')
        expect(logged).not.toContain('evil.attacker.invalid')
        expect(logged).not.toContain('token=')
        expect(logged).not.toContain('netease:2100334024')
        expect(logged).not.toMatch(/https?:\/\//)

        const record = JSON.parse(warn.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(record).toMatchObject({
          event: 'provider_resolve_failure',
          provider: 'gd-studio',
          code: 'gd_media_url_policy',
        })
        expect(typeof record.elapsedMs).toBe('number')
        expect(Object.keys(record).sort()).toEqual(
          ['code', 'elapsedMs', 'event', 'provider', 'stage'],
        )
      } finally {
        warn.mockRestore()
      }
    })

    it('preserves rate-limit semantics: HTTP 429 with code=gd_rate_limited', async () => {
      const fetchImpl = vi.fn(async () => new Response('rate limit', { status: 429 })) as unknown as typeof fetch

      const response = await dispatchWithFetch(fetchImpl)

      expect(response.status).toBe(429)
      expect(await response.json()).toEqual({ error: 'rate_limited', code: 'gd_rate_limited' })
    })

    it('F5 Test C: keeps public response unchanged for upstream 520 without leaking metadata to client', async () => {
      const fetchImpl = vi.fn(async () => new Response('unknown error', {
        status: 520,
        headers: {
          server: 'cloudflare',
          'cf-ray': 'public-guard-ray-DFW',
          'cf-error-type': 'origin_down',
          'cf-error-origin': 'gd-backend',
          'content-type': 'text/html',
          'content-length': '512',
        },
      })) as unknown as typeof fetch

      const response = await dispatchWithFetch(fetchImpl)

      expect(response.status).toBe(502)
      const body = await response.json() as Record<string, unknown>
      expect(body).toEqual({ error: 'unavailable', code: 'gd_upstream_http' })
      expect(body.server).toBeUndefined()
      expect(body.cfRay).toBeUndefined()
      expect(body.upstreamMetadata).toBeUndefined()
      expect(body.upstreamServer).toBeUndefined()
      expect(body.upstreamCfRay).toBeUndefined()
    })

    it('F5: emits flattened safe upstream metadata in structured logs while strictly omitting secrets', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const fetchImpl = vi.fn(async () => new Response('unknown error', {
          status: 520,
          headers: {
            server: 'cloudflare',
            'cf-ray': 'a3bd-test-ray-DFW',
            'cf-error-type': 'origin_unreachable',
            'cf-error-origin': 'gd-origin',
            'content-type': 'text/html; charset=UTF-8',
            'content-length': '256',
            'set-cookie': 'session=ROUTE_SECRET_COOKIE',
            authorization: 'Bearer ROUTE_SECRET_AUTH',
            location: 'https://example.invalid/?token=ROUTE_SECRET_TOKEN',
            'x-custom-secret': 'ROUTE_SECRET_HEADER',
          },
        })) as unknown as typeof fetch

        const response = await dispatchWithFetch(fetchImpl)
        expect(response.status).toBe(502)

        expect(warn).toHaveBeenCalled()
        const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
        expect(logged).not.toContain('ROUTE_SECRET')

        const record = JSON.parse(warn.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(record).toMatchObject({
          event: 'provider_resolve_failure',
          provider: 'gd-studio',
          stage: 'gd_upstream_http',
          code: 'gd_upstream_http',
          upstreamStatus: 520,
          upstreamServer: 'cloudflare',
          upstreamCfRay: 'a3bd-test-ray-DFW',
          upstreamCfErrorType: 'origin_unreachable',
          upstreamCfErrorOrigin: 'gd-origin',
          upstreamContentType: 'text/html; charset=UTF-8',
          upstreamContentLength: 256,
        })
      } finally {
        warn.mockRestore()
      }
    })
  })
})
