import { readFile, readdir } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import worker from '../index'
import type { ImplementedLxProviderId, ProviderEnv } from '../providers/config'

const MIGRATIONS_DIRECTORY = resolvePath(process.cwd(), 'migrations')
const NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX'
const HUIBQ_KEY = 'HUIBQ_REQUEST_KEY_SENTINEL'
const IKUN_KEY = 'IKUN_REQUEST_KEY_SENTINEL'
const HUIBQ_MEDIA_URL = 'https://huibq-media.example/audio?token=temporary'
const IKUN_MEDIA_URL = 'https://ikun-media.example/audio?token=temporary'

const LX_ENV = {
  LX_HUIBQ_API_BASE_URL: 'https://huibq.example',
  LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES: 'huibq-media.example',
  LX_HUIBQ_REQUEST_KEY: HUIBQ_KEY,
  LX_IKUN_API_BASE_URL: 'https://ikun.example',
  LX_IKUN_MEDIA_ALLOWED_HOSTNAMES: 'ikun-media.example',
  LX_IKUN_REQUEST_KEY: IKUN_KEY,
} as const

interface LxFixture {
  providerId: ImplementedLxProviderId
  externalId: string
  encodedId: string
  mediaUrl: string
  requestKey: string
  successBody: unknown
  expectedUpstreamUrl: string
  expectedMimeType: string
}

const HUIBQ: LxFixture = {
  providerId: 'lx-huibq',
  externalId: 'kw:ABC_def-123:320k',
  encodedId: 'kw%3AABC_def-123%3A320k',
  mediaUrl: HUIBQ_MEDIA_URL,
  requestKey: HUIBQ_KEY,
  successBody: { code: 0, url: HUIBQ_MEDIA_URL },
  expectedUpstreamUrl: 'https://huibq.example/url/kw/ABC_def-123/320k',
  expectedMimeType: 'audio/mpeg',
}

const IKUN: LxFixture = {
  providerId: 'lx-ikun',
  externalId: 'wy:123456:flac',
  encodedId: 'wy%3A123456%3Aflac',
  mediaUrl: IKUN_MEDIA_URL,
  requestKey: IKUN_KEY,
  successBody: { code: 200, url: IKUN_MEDIA_URL },
  expectedUpstreamUrl: 'https://ikun.example/url?source=wy&songId=123456&quality=flac',
  expectedMimeType: 'audio/flac',
}

const FIXTURES = [HUIBQ, IKUN] as const

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>
let database: TestDatabase

const providerEnv = (overrides: Partial<ProviderEnv> = {}): ProviderEnv => ({
  DB: database,
  PUBLIC_ORIGIN: 'https://study.example',
  SESSION_HMAC_SECRET: 'session-secret-at-least-thirty-two-bytes',
  OAUTH_STATE_SECRET: 'oauth-secret-at-least-thirty-two-bytes',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-client',
  GITHUB_CLIENT_SECRET: 'github-secret',
  ...LX_ENV,
  ...overrides,
})

const applyMigrations = async (db: TestDatabase) => {
  const names = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .filter((name) => !name.endsWith('_provider_defaults.sql'))
    .sort()
  for (const name of names) {
    const sql = await readFile(resolvePath(MIGRATIONS_DIRECTORY, name), 'utf8')
    await db.batch(sql.split(';').map((value) => value.trim()).filter(Boolean)
      .map((value) => db.prepare(value)))
  }
}

const seedProvider = (id: string, enabled = 1, priority = 3) => database.prepare(`
  INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at)
  VALUES (?, ?, ?, 'unknown', 0)
`).bind(id, enabled, priority).run()

class FakeCache {
  readonly entries = new Map<string, Response>()

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const request = input instanceof Request ? input.clone() : new Request(input)
    return this.entries.get(`${request.method} ${request.url}`)?.clone()
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const request = input instanceof Request ? input.clone() : new Request(input)
    this.entries.set(`${request.method} ${request.url}`, response.clone())
  }
}

const deterministicCrypto = {
  getRandomValues(bytes: Uint8Array) {
    bytes.forEach((_value, index) => { bytes[index] = index })
    return bytes
  },
} as unknown as Crypto

const resolveRequest = (
  providerId: string,
  externalId: string,
  overrides: {
    body?: BodyInit
    headers?: HeadersInit
    method?: string
    url?: string
  } = {},
) => new Request(
  overrides.url ?? `https://study.example/api/providers/${providerId}/resolve`,
  {
    body: overrides.method === 'GET' ? undefined : overrides.body ?? JSON.stringify({ externalId }),
    headers: overrides.headers ?? {
      'content-type': 'application/json',
      origin: 'https://study.example',
    },
    method: overrides.method ?? 'POST',
  },
)

const mediaPath = (providerId: string, encodedId: string, nonce = NONCE) =>
  `/api/providers/${providerId}/media/${encodedId}/${nonce}`

const createHandler = async (
  fetchImpl: typeof fetch,
  cache: FakeCache,
  env: Partial<ProviderEnv> = {},
) => {
  const { createProviderHandler } = await import('../providers/routes')
  return createProviderHandler(providerEnv(env), {
    cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
    crypto: deterministicCrypto,
    fetch: fetchImpl,
    now: () => 1_000,
  })
}

describe('audited LX provider routes', () => {
  const miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'lx-routes-test' },
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

  afterAll(async () => miniflare.dispose())

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'prepares one provider-bound same-origin %s media ticket',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async () => Response.json(fixture.successBody)) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      const response = await handler.fetch(resolveRequest(fixture.providerId, fixture.externalId))
      const body = await response.json() as { mimeType: string; url: string }

      expect(response.status).toBe(200)
      expect(body).toEqual({
        mimeType: fixture.expectedMimeType,
        url: mediaPath(fixture.providerId, fixture.encodedId),
      })
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toBe(fixture.expectedUpstreamUrl)
      const serialized = JSON.stringify(body)
      expect(serialized).not.toContain('temporary')
      expect(serialized).not.toContain(fixture.requestKey)
      expect(serialized).not.toContain('huibq-media.example')
      expect(serialized).not.toContain('ikun-media.example')
      expect(serialized).not.toContain('huibq.example')
      expect(serialized).not.toContain('ikun.example')
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'sends the %s request key only to the configured resolver origin',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async () => Response.json(fixture.successBody)) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      await handler.fetch(resolveRequest(fixture.providerId, fixture.externalId))

      const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
      expect(String(url)).not.toContain(fixture.requestKey)
      expect(new Headers(init?.headers).get('x-request-key')).toBe(fixture.requestKey)
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual' })

      const ticket = await [...cache.entries.values()][0]!.clone().text()
      expect(ticket).toContain(fixture.mediaUrl)
      expect(ticket).not.toContain(fixture.requestKey)
      expect(ticket).not.toContain('huibq.example')
      expect(ticket).not.toContain('ikun.example')
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'serves a validated %s Range request through the transient media path',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      let upstreamCall = 0
      const fetchImpl = vi.fn(async () => {
        upstreamCall += 1
        if (upstreamCall === 1) return Response.json(fixture.successBody)
        return new Response(new Uint8Array([1]), {
          status: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-length': '1',
            'content-range': 'bytes 0-0/20',
            'content-type': fixture.expectedMimeType,
          },
        })
      }) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      await handler.fetch(resolveRequest(fixture.providerId, fixture.externalId))
      const url = new URL(
        mediaPath(fixture.providerId, fixture.encodedId),
        'https://study.example',
      )
      const media = await handler.fetch(new Request(url, { headers: { range: 'bytes=0-0' } }))

      expect(media.status).toBe(206)
      expect(media.headers.get('content-range')).toBe('bytes 0-0/20')
      expect(media.headers.get('content-type')).toBe(fixture.expectedMimeType)
      expect(String(vi.mocked(fetchImpl).mock.calls[1]?.[0])).toBe(fixture.mediaUrl)
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'answers a %s HEAD media request without a body',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      let upstreamCall = 0
      const fetchImpl = vi.fn(async () => {
        upstreamCall += 1
        if (upstreamCall === 1) return Response.json(fixture.successBody)
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            'accept-ranges': 'bytes',
            'content-length': '3',
            'content-type': fixture.expectedMimeType,
          },
        })
      }) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      await handler.fetch(resolveRequest(fixture.providerId, fixture.externalId))
      const url = new URL(
        mediaPath(fixture.providerId, fixture.encodedId),
        'https://study.example',
      )
      const media = await handler.fetch(new Request(url, { method: 'HEAD' }))

      expect(media.status).toBe(200)
      expect(media.headers.get('content-type')).toBe(fixture.expectedMimeType)
      expect(await media.text()).toBe('')
    },
  )

  it.each([
    ['rate_limited', { code: 5 }, { code: 429 }, 429],
    ['unavailable', { code: 1 }, { code: 403 }, 502],
    ['invalid_response', { code: 6 }, { code: 999 }, 502],
  ] as const)(
    'maps an application %s failure to a bounded status without retrying',
    async (error, huibqBody, ikunBody, status) => {
      for (const [fixture, body] of [[HUIBQ, huibqBody], [IKUN, ikunBody]] as const) {
        await database.prepare('DELETE FROM provider_health').run()
        await seedProvider(fixture.providerId)
        const cache = new FakeCache()
        const fetchImpl = vi.fn(async () => Response.json(body)) as unknown as typeof fetch
        const handler = await createHandler(fetchImpl, cache)

        const response = await handler.fetch(
          resolveRequest(fixture.providerId, fixture.externalId),
        )

        expect(response.status).toBe(status)
        expect(await response.json()).toEqual({ error })
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(cache.entries.size).toBe(0)
      }
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'maps a hung %s resolver to timeout',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      let markFetchStarted!: () => void
      const fetchStarted = new Promise<void>((resolveStarted) => {
        markFetchStarted = resolveStarted
      })
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        markFetchStarted()
        return await new Promise<Response>((_resolveResponse, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      vi.useFakeTimers()
      try {
        const pending = handler.fetch(resolveRequest(fixture.providerId, fixture.externalId))
        await fetchStarted
        await vi.advanceTimersByTimeAsync(3_999)
        expect(fetchImpl).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(1)
        const response = await pending

        expect(response.status).toBe(504)
        expect(await response.json()).toEqual({ error: 'timeout' })
        expect(fetchImpl).toHaveBeenCalledOnce()
        expect(cache.entries.size).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'rejects an unallowlisted %s media host without preparing a ticket',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      const body = fixture.providerId === 'lx-huibq'
        ? { code: 0, url: 'https://attacker.example/audio' }
        : { code: 200, url: 'https://attacker.example/audio' }
      const fetchImpl = vi.fn(async () => Response.json(body)) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      const response = await handler.fetch(
        resolveRequest(fixture.providerId, fixture.externalId),
      )

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'invalid_response' })
      expect(cache.entries.size).toBe(0)
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'rejects a redirected %s resolver response without following it',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      const upstream = new Response('private redirect detail', {
        status: 302,
        headers: { location: 'https://attacker.example/audio' },
      })
      const fetchImpl = vi.fn(async () => upstream) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      const response = await handler.fetch(
        resolveRequest(fixture.providerId, fixture.externalId),
      )

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'invalid_response' })
      expect(upstream.bodyUsed).toBe(false)
      expect(fetchImpl).toHaveBeenCalledOnce()
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'refuses %s resolve when the provider is not effectively enabled',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId, 0)
      const cache = new FakeCache()
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      const response = await handler.fetch(
        resolveRequest(fixture.providerId, fixture.externalId),
      )

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'unavailable' })
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'refuses %s resolve when operator configuration is missing',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const missing = fixture.providerId === 'lx-huibq'
        ? { LX_HUIBQ_API_BASE_URL: undefined, LX_HUIBQ_REQUEST_KEY: undefined }
        : { LX_IKUN_API_BASE_URL: undefined, LX_IKUN_REQUEST_KEY: undefined }
      const handler = await createHandler(fetchImpl, cache, missing)

      const response = await handler.fetch(
        resolveRequest(fixture.providerId, fixture.externalId),
      )

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'unavailable' })
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['a foreign Origin', { headers: { 'content-type': 'application/json', origin: 'https://attacker.example' } }, 400],
    ['a missing Origin', { headers: { 'content-type': 'application/json' } }, 400],
    ['a non-exact JSON MIME', { headers: { 'content-type': 'application/json; charset=utf-8', origin: 'https://study.example' } }, 400],
    ['a GET method', { method: 'GET' }, 405],
    ['a query string', { url: 'https://study.example/api/providers/lx-huibq/resolve?debug=1' }, 400],
    ['a malformed body', { body: '{' }, 400],
    ['an extra body key', { body: JSON.stringify({ externalId: 'kw:ABC:320k', quality: '320k' }) }, 400],
    ['a non-canonical external ID', { body: JSON.stringify({ externalId: 'kw:ABC:flac' }) }, 400],
    ['an absolute URL external ID', { body: JSON.stringify({ externalId: 'https://attacker.example/a.mp3' }) }, 400],
    ['an operator request key in the body', { body: JSON.stringify({ externalId: `kw:ABC:320k`, requestKey: HUIBQ_KEY }) }, 400],
  ] as const)('fails closed for %s on an LX resolve request', async (_label, overrides, status) => {
    await seedProvider('lx-huibq')
    const cache = new FakeCache()
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const handler = await createHandler(fetchImpl, cache)

    const response = await handler.fetch(
      resolveRequest('lx-huibq', HUIBQ.externalId, overrides),
    )

    expect(response.status).toBe(status)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(cache.entries.size).toBe(0)
  })

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'rejects a %s media request whose external ID is not canonical',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      const url = new URL(
        mediaPath(fixture.providerId, encodeURIComponent('kw:ABC:flac24bitmaster')),
        'https://study.example',
      )
      const response = await handler.fetch(new Request(url))

      expect(response.status).toBe(400)
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'refuses an unprepared %s media ticket',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      const url = new URL(
        mediaPath(fixture.providerId, fixture.encodedId),
        'https://study.example',
      )
      const response = await handler.fetch(new Request(url))

      expect(response.status).toBe(410)
      expect(await response.json()).toEqual({ error: 'preparation_expired' })
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'stops serving a prepared %s ticket once the provider is disabled',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async () => Response.json(fixture.successBody)) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      await handler.fetch(resolveRequest(fixture.providerId, fixture.externalId))
      await database.prepare('UPDATE provider_health SET enabled = 0 WHERE provider_key = ?')
        .bind(fixture.providerId).run()

      const url = new URL(
        mediaPath(fixture.providerId, fixture.encodedId),
        'https://study.example',
      )
      const response = await handler.fetch(new Request(url))

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'unavailable' })
      expect(fetchImpl).toHaveBeenCalledOnce()
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'rejects an unsafe %s media redirect target',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      let upstreamCall = 0
      const fetchImpl = vi.fn(async () => {
        upstreamCall += 1
        if (upstreamCall === 1) return Response.json(fixture.successBody)
        return new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/audio' },
        })
      }) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      await handler.fetch(resolveRequest(fixture.providerId, fixture.externalId))
      const url = new URL(
        mediaPath(fixture.providerId, fixture.encodedId),
        'https://study.example',
      )
      const response = await handler.fetch(new Request(url))

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'invalid_response' })
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'rejects a non-audio %s upstream media MIME',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      let upstreamCall = 0
      const fetchImpl = vi.fn(async () => {
        upstreamCall += 1
        if (upstreamCall === 1) return Response.json(fixture.successBody)
        return new Response('<html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      await handler.fetch(resolveRequest(fixture.providerId, fixture.externalId))
      const url = new URL(
        mediaPath(fixture.providerId, fixture.encodedId),
        'https://study.example',
      )
      const response = await handler.fetch(new Request(url))

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ error: 'invalid_response' })
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'rejects an unsupported %s media method',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      const url = new URL(
        mediaPath(fixture.providerId, fixture.encodedId),
        'https://study.example',
      )
      const response = await handler.fetch(new Request(url, { method: 'POST' }))

      expect(response.status).toBe(405)
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'does not advertise %s as available while its route is unreachable',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async () => Response.json(fixture.successBody)) as unknown as typeof fetch
      const handler = await createHandler(fetchImpl, cache)

      const config = await handler.fetch(
        new Request('https://study.example/api/providers/config'),
      )
      const body = await config.json() as {
        providers: Array<{ id: string; available: boolean; enabled: boolean }>
      }
      const state = body.providers.find(({ id }) => id === fixture.providerId)
      expect(state).toBeUndefined()

      const resolved = await handler.fetch(
        resolveRequest(fixture.providerId, fixture.externalId),
      )
      expect(resolved.status).not.toBe(404)
    },
  )

  it.each(FIXTURES.map((fixture) => [fixture.providerId, fixture] as const))(
    'dispatches %s resolve and media paths from the Worker entrypoint',
    async (_providerId, fixture) => {
      await seedProvider(fixture.providerId)

      const resolved = await worker.fetch(
        resolveRequest(fixture.providerId, fixture.externalId),
        providerEnv() as never,
      )
      expect(resolved.status).not.toBe(404)

      const url = new URL(
        mediaPath(fixture.providerId, fixture.encodedId),
        'https://study.example',
      )
      const media = await worker.fetch(new Request(url), providerEnv() as never)
      expect(media.status).not.toBe(404)
    },
  )

  it('does not dispatch an unimplemented LX provider path', async () => {
    for (const providerId of ['lx-juhe', 'lx-qdy', 'lx-flower', 'lx-lx', 'lx-grass', 'lx-sixyin']) {
      const resolved = await worker.fetch(
        resolveRequest(providerId, 'kw:ABC:320k'),
        providerEnv() as never,
      )
      expect(resolved.status).toBe(404)
    }
  })
})
