import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import worker from '../index'
import type { D1Database } from '../env'
import type { ProviderEnv } from '../providers/config'

const MIGRATIONS_DIRECTORY = resolve(process.cwd(), 'migrations')
const VIDEO_ID = 'lm3t3myPspk'
const NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX'
const METING_EXTERNAL_ID = 'netease:123456789'
const METING_ENCODED_ID = 'netease%3A123456789'
const METING_MEDIA_URL = 'https://media.example/audio?token=temporary'
const METING_ENV = {
  METING_API_BASE_URL: 'https://meting.example',
  METING_MEDIA_ALLOWED_HOSTNAMES: 'media.example,redirect.example',
} as const

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

const applyMigrations = async (db: TestDatabase) => {
  const names = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .filter((name) => !name.endsWith('_provider_defaults.sql'))
    .sort()
  for (const name of names) {
    const sql = await readFile(resolve(MIGRATIONS_DIRECTORY, name), 'utf8')
    await db.batch(sql.split(';').map((value) => value.trim()).filter(Boolean)
      .map((value) => db.prepare(value)))
  }
}

const seedProvider = (id: string, enabled = 1, priority = 7) => database.prepare(`
  INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at)
  VALUES (?, ?, ?, 'unknown', 0)
`).bind(id, enabled, priority).run()

class FakeCache {
  readonly entries = new Map<string, Response>()
  readonly matchCalls: Request[] = []
  readonly putCalls: Request[] = []
  failPut: unknown = null

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const request = input instanceof Request ? input.clone() : new Request(input)
    this.matchCalls.push(request)
    return this.entries.get(`${request.method} ${request.url}`)?.clone()
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const request = input instanceof Request ? input.clone() : new Request(input)
    this.putCalls.push(request)
    if (this.failPut) throw this.failPut
    this.entries.set(`${request.method} ${request.url}`, response.clone())
  }
}

const deterministicCrypto = {
  getRandomValues(bytes: Uint8Array) {
    bytes.forEach((_value, index) => { bytes[index] = index })
    return bytes
  },
} as unknown as Crypto

const resolveRequest = (provider: 'invidious' | 'piped', externalId = VIDEO_ID) => new Request(
  `https://study.example/api/providers/${provider}/resolve`,
  {
    body: JSON.stringify({ externalId }),
    headers: { 'content-type': 'application/json', origin: 'https://study.example' },
    method: 'POST',
  },
)

const jsonResponse = (value: unknown, status = 200) => Response.json(value, { status })

const metingResolveRequest = (
  body: BodyInit = JSON.stringify({ externalId: METING_EXTERNAL_ID }),
  headers: HeadersInit = {
    'content-type': 'application/json',
    origin: 'https://study.example',
  },
  url = 'https://study.example/api/providers/meting/resolve',
) => new Request(url, { body, headers, method: 'POST' })

const metingMetadata = (overrides: Record<string, unknown> = {}) => ({
  server: 'netease',
  id: '123456789',
  url: METING_MEDIA_URL,
  mimeType: 'audio/mpeg',
  ...overrides,
})

const metingMediaPath = (encodedId = METING_ENCODED_ID, suffix = '') =>
  `/api/providers/meting/media/${encodedId}/${NONCE}${suffix}`

describe('same-origin soundtrack audio provider routes', () => {
  const miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'audio-provider-routes-test' },
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

  it.each([
    ['piped', {
      PIPED_API_BASE_URL: 'https://piped.example',
      PIPED_MEDIA_ALLOWED_HOSTNAMES: 'proxy.example',
    }, {
      audioStreams: [{
        url: 'https://proxy.example/audio?token=temporary',
        mimeType: 'audio/mp4',
        bitrate: 128_000,
        videoOnly: false,
      }],
    }, 'https://piped.example/streams/lm3t3myPspk'],
    ['invidious', {
      INVIDIOUS_API_BASE_URL: 'https://invidious.example',
    }, {
      adaptiveFormats: [{
        url: 'https://invidious.example/videoplayback?token=temporary',
        type: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: '128000',
      }],
    }, 'https://invidious.example/api/v1/videos/lm3t3myPspk?local=true'],
  ] as const)(
    'prepares one provider/ID-bound same-origin %s media ticket',
    async (provider, envOverrides, upstreamBody, expectedUpstreamUrl) => {
      await seedProvider(provider, 1, provider === 'piped' ? 7 : 8)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async () => jsonResponse(upstreamBody)) as unknown as typeof fetch
      const { createProviderHandler } = await import('../providers/routes')
      const handler = createProviderHandler(providerEnv(envOverrides), {
        cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        crypto: deterministicCrypto,
        fetch: fetchImpl,
        now: () => 1_000,
      })

      const response = await handler.fetch(resolveRequest(provider))
      const body = await response.json() as { mimeType: string; url: string }

      expect(response.status).toBe(200)
      expect(body).toEqual({
        mimeType: 'audio/mp4',
        url: `/api/providers/${provider}/media/${VIDEO_ID}/${NONCE}`,
      })
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(String(vi.mocked(fetchImpl).mock.calls[0]?.[0])).toBe(expectedUpstreamUrl)
      expect(JSON.stringify(body)).not.toMatch(/temporary|piped\.example|invidious\.example|proxy\.example/)
      const cached = cache.entries.get(
        `GET https://study.example/api/providers/${provider}/media/${VIDEO_ID}/${NONCE}`,
      )
      expect(await cached?.json()).toMatchObject({
        providerId: provider,
        externalId: VIDEO_ID,
        nonce: NONCE,
        mimeType: 'audio/mp4',
        expiresAt: 31_000,
      })
    },
  )

  it.each([
    ['piped', {
      PIPED_API_BASE_URL: 'https://piped.example',
      PIPED_MEDIA_ALLOWED_HOSTNAMES: 'proxy.example',
    }, {
      audioStreams: [{
        url: 'https://proxy.example/audio?token=temporary',
        mimeType: 'audio/mp4',
        bitrate: 128_000,
      }],
    }, 'https://proxy.example/audio?token=temporary'],
    ['invidious', { INVIDIOUS_API_BASE_URL: 'https://invidious.example' }, {
      adaptiveFormats: [{
        url: 'https://invidious.example/videoplayback?token=temporary',
        type: 'audio/mp4',
        bitrate: '128000',
      }],
    }, 'https://invidious.example/videoplayback?token=temporary'],
  ] as const)(
    'rejects %s media when its response MIME differs from the selected format',
    async (provider, envOverrides, upstreamBody, upstreamMediaUrl) => {
      await seedProvider(provider, 1, provider === 'piped' ? 7 : 8)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
        String(input) === upstreamMediaUrl
          ? new Response('audio', { headers: { 'content-type': 'audio/webm' } })
          : jsonResponse(upstreamBody)) as unknown as typeof fetch
      const { createProviderHandler } = await import('../providers/routes')
      const handler = createProviderHandler(providerEnv(envOverrides), {
        cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        crypto: deterministicCrypto,
        fetch: fetchImpl,
        now: () => 1_000,
      })
      const prepared = await handler.fetch(resolveRequest(provider))
      const { url } = await prepared.json() as { url: string }

      const media = await handler.fetch(new Request(`https://study.example${url}`))

      expect(prepared.status).toBe(200)
      expect(media.status).toBe(502)
      expect(await media.json()).toEqual({ error: 'invalid_response' })
    },
  )

  it.each(['piped', 'invidious'] as const)(
    'rejects malformed %s request input before any upstream call',
    async (provider) => {
      await seedProvider(provider, 1, provider === 'piped' ? 7 : 8)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { createProviderHandler } = await import('../providers/routes')
      const handler = createProviderHandler(providerEnv(provider === 'piped'
        ? { PIPED_API_BASE_URL: 'https://piped.example' }
        : { INVIDIOUS_API_BASE_URL: 'https://invidious.example' }), { fetch: fetchImpl })

      for (const request of [
        resolveRequest(provider, 'too-short'),
        new Request(`https://study.example/api/providers/${provider}/resolve`, {
          body: JSON.stringify({ externalId: VIDEO_ID, url: 'https://attacker.example' }),
          headers: { 'content-type': 'application/json', origin: 'https://study.example' },
          method: 'POST',
        }),
        new Request(`https://study.example/api/providers/${provider}/resolve`, {
          body: JSON.stringify({ externalId: VIDEO_ID }),
          headers: { 'content-type': 'text/plain', origin: 'https://study.example' },
          method: 'POST',
        }),
        new Request(`https://study.example/api/providers/${provider}/resolve`, {
          body: `${' '.repeat(1_025)}${JSON.stringify({ externalId: VIDEO_ID })}`,
          headers: { 'content-type': 'application/json', origin: 'https://study.example' },
          method: 'POST',
        }),
      ]) {
        const response = await handler.fetch(request)
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid_response' })
      }
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each(['piped', 'invidious'] as const)(
    'routes %s before the authentication fallback at the top-level Worker seam',
    async (provider) => {
      const response = await worker.fetch(
        resolveRequest(provider, 'too-short'),
        providerEnv(provider === 'piped'
          ? { PIPED_API_BASE_URL: 'https://piped.example' }
          : { INVIDIOUS_API_BASE_URL: 'https://invidious.example' }),
      )

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_response' })
    },
  )

  it.each(['piped', 'invidious'] as const)(
    'does not contact %s when deployment config or Admin enablement is absent',
    async (provider) => {
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { createProviderHandler } = await import('../providers/routes')
      const configuredEnv = provider === 'piped'
        ? { PIPED_API_BASE_URL: 'https://piped.example' }
        : { INVIDIOUS_API_BASE_URL: 'https://invidious.example' }

      await seedProvider(provider, 0, provider === 'piped' ? 7 : 8)
      const adminDisabled = await createProviderHandler(
        providerEnv(configuredEnv),
        { fetch: fetchImpl },
      ).fetch(resolveRequest(provider))
      await database.prepare('DELETE FROM provider_health').run()
      await seedProvider(provider, 1, provider === 'piped' ? 7 : 8)
      const deploymentUnavailable = await createProviderHandler(
        providerEnv(),
        { fetch: fetchImpl },
      ).fetch(resolveRequest(provider))

      expect(adminDisabled.status).toBe(503)
      expect(deploymentUnavailable.status).toBe(503)
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['piped', { PIPED_API_BASE_URL: 'https://piped.example' }],
    ['invidious', { INVIDIOUS_API_BASE_URL: 'https://invidious.example' }],
  ] as const)('rejects unsafe %s media URLs without disclosure', async (provider, envOverrides) => {
    await seedProvider(provider, 1, provider === 'piped' ? 7 : 8)
    const { createProviderHandler } = await import('../providers/routes')
    for (const unsafeUrl of [
      'https://user:password@resolver.example.invalid/audio',
      'https://127.0.0.1/audio',
      'https://attacker.example/audio',
    ]) {
      const upstreamBody = provider === 'piped'
        ? { audioStreams: [{ url: unsafeUrl, mimeType: 'audio/mp4', bitrate: 128_000 }] }
        : { adaptiveFormats: [{ url: unsafeUrl, type: 'audio/mp4', bitrate: '128000' }] }
      const fetchImpl = vi.fn(async () => jsonResponse(upstreamBody)) as unknown as typeof fetch
      const response = await createProviderHandler(providerEnv(envOverrides), {
        cache: new FakeCache() as unknown as Pick<Cache, 'match' | 'put'>,
        crypto: deterministicCrypto,
        fetch: fetchImpl,
        now: () => 1_000,
      }).fetch(resolveRequest(provider))
      const body = await response.json()

      expect(response.status).toBe(502)
      expect(body).toEqual({ error: 'invalid_response' })
      expect(JSON.stringify(body)).not.toContain(unsafeUrl)
      expect(fetchImpl).toHaveBeenCalledOnce()
    }
  })

  it.each([
    ['piped', {
      PIPED_API_BASE_URL: 'https://piped.example',
      PIPED_MEDIA_ALLOWED_HOSTNAMES: 'proxy.example',
    }, {
      audioStreams: [{
        url: 'https://proxy.example/audio?token=temporary',
        mimeType: 'audio/mp4',
        bitrate: 128_000,
      }],
    }, 'https://proxy.example/audio?token=temporary'],
    ['invidious', { INVIDIOUS_API_BASE_URL: 'https://invidious.example' }, {
      adaptiveFormats: [{
        url: 'https://invidious.example/videoplayback?token=temporary',
        type: 'audio/mp4',
        bitrate: '128000',
      }],
    }, 'https://invidious.example/videoplayback?token=temporary'],
  ] as const)(
    'proxies bounded %s Range media without leaking upstream headers or URL',
    async (provider, envOverrides, upstreamBody, upstreamMediaUrl) => {
      await seedProvider(provider, 1, provider === 'piped' ? 7 : 8)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
        String(input) === upstreamMediaUrl
          ? new Response(new Uint8Array([0]), {
            status: 206,
            headers: {
              'accept-ranges': 'bytes',
              'content-length': '1',
              'content-range': 'bytes 0-0/20',
              'content-type': 'audio/mp4',
              location: 'https://must-not-reach-browser.example/private',
              server: 'private-upstream',
              'set-cookie': 'private-cookie',
            },
          })
          : jsonResponse(upstreamBody)) as unknown as typeof fetch
      const { createProviderHandler } = await import('../providers/routes')
      const handler = createProviderHandler(providerEnv(envOverrides), {
        cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        crypto: deterministicCrypto,
        fetch: fetchImpl,
        now: () => 1_000,
      })
      const prepared = await handler.fetch(resolveRequest(provider))
      const { url } = await prepared.json() as { url: string }
      const media = await handler.fetch(new Request(`https://study.example${url}`, {
        headers: { authorization: 'browser-private', cookie: 'browser-private', range: 'bytes=0-0' },
      }))

      expect(prepared.status).toBe(200)
      expect(media.status).toBe(206)
      expect([...media.headers.entries()]).toEqual([
        ['accept-ranges', 'bytes'],
        ['cache-control', 'no-store'],
        ['content-length', '1'],
        ['content-range', 'bytes 0-0/20'],
        ['content-type', 'audio/mp4'],
      ])
      expect((await media.arrayBuffer()).byteLength).toBe(1)
      const [, mediaInit] = vi.mocked(fetchImpl).mock.calls[1]!
      expect([...new Headers(mediaInit?.headers).entries()]).toEqual([['range', 'bytes=0-0']])
      expect(JSON.stringify([...media.headers])).not.toMatch(/temporary|private|cookie|location|server/)
    },
  )

  it.each(['piped', 'invidious'] as const)(
    'rejects malformed %s media ticket paths before cache or upstream access',
    async (provider) => {
      await seedProvider(provider, 1, provider === 'piped' ? 7 : 8)
      const envOverrides = provider === 'piped'
        ? { PIPED_API_BASE_URL: 'https://piped.example' }
        : { INVIDIOUS_API_BASE_URL: 'https://invidious.example' }
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { createProviderHandler } = await import('../providers/routes')
      const handler = createProviderHandler(providerEnv(envOverrides), {
        cache: new FakeCache() as unknown as Pick<Cache, 'match' | 'put'>,
        fetch: fetchImpl,
      })

      for (const path of [
        `/api/providers/${provider}/media/${VIDEO_ID}/short`,
        `/api/providers/${provider}/media/${VIDEO_ID}/${NONCE}/extra`,
        `/api/providers/${provider}/media/${VIDEO_ID}/${NONCE}?token=confusion`,
        `/api/providers/${provider}/media/zeDsSQir8CM/${NONCE}`,
      ]) {
        const response = await handler.fetch(new Request(`https://study.example${path}`))
        expect([400, 410]).toContain(response.status)
      }
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  describe('same-origin Meting resolve and transient media', () => {
    const createMetingHandler = async (
      fetchImpl: typeof fetch,
      cache = new FakeCache(),
      envOverrides: Partial<ProviderEnv> = METING_ENV,
      now: () => number = () => 1_000,
    ) => {
      const { createProviderHandler } = await import('../providers/routes')
      return {
        cache,
        handler: createProviderHandler(providerEnv(envOverrides), {
          cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
          crypto: deterministicCrypto,
          fetch: fetchImpl,
          now,
        }),
      }
    }

    const prepareMeting = async (
      fetchImpl: typeof fetch,
      cache = new FakeCache(),
      now: () => number = () => 1_000,
    ) => {
      await seedProvider('meting', 1, 9)
      const created = await createMetingHandler(fetchImpl, cache, METING_ENV, now)
      const response = await created.handler.fetch(metingResolveRequest())
      return { ...created, response }
    }

    const cacheMetingTicket = async (
      cache: FakeCache,
      overrides: Record<string, unknown> = {},
      path = metingMediaPath(),
    ) => cache.put(
      new Request(`https://study.example${path}`, { method: 'GET' }),
      Response.json({
        providerId: 'meting',
        externalId: METING_EXTERNAL_ID,
        nonce: NONCE,
        validatedUrl: METING_MEDIA_URL,
        mimeType: 'audio/mpeg',
        expiresAt: 31_000,
        ...overrides,
      }, { headers: { 'cache-control': 'max-age=30' } }),
    )

    it('prepares one encoded ID-bound ticket without exposing either upstream URL', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse(metingMetadata())) as unknown as typeof fetch
      const { cache, response } = await prepareMeting(fetchImpl)
      const body = await response.json() as { mimeType: string; url: string }

      expect(response.status).toBe(200)
      expect(body).toEqual({
        mimeType: 'audio/mpeg',
        url: `/api/providers/meting/media/${METING_ENCODED_ID}/${NONCE}`,
      })
      expect(JSON.stringify(body)).not.toMatch(/meting\.example|media\.example|temporary|token/)
      expect(fetchImpl).toHaveBeenCalledOnce()
      const [upstreamUrl, init] = vi.mocked(fetchImpl).mock.calls[0]!
      expect(String(upstreamUrl)).toBe('https://meting.example')
      expect(init).toMatchObject({
        body: '{"server":"netease","id":"123456789"}',
        method: 'POST',
        redirect: 'manual',
      })
      expect([...new Headers(init?.headers).entries()]).toEqual([
        ['accept', 'application/json'],
        ['content-type', 'application/json'],
      ])
      expect(cache.putCalls.map(({ url }) => url)).toEqual([
        `https://study.example/api/providers/meting/media/${METING_ENCODED_ID}/${NONCE}`,
      ])
      const ticket = await cache.entries.get(`GET https://study.example${body.url}`)?.json()
      expect(ticket).toEqual({
        providerId: 'meting',
        externalId: METING_EXTERNAL_ID,
        nonce: NONCE,
        validatedUrl: METING_MEDIA_URL,
        mimeType: 'audio/mpeg',
        expiresAt: 31_000,
      })
    })

    it.each([
      ['missing Origin', JSON.stringify({ externalId: METING_EXTERNAL_ID }), { 'content-type': 'application/json' }, 'https://study.example/api/providers/meting/resolve'],
      ['cross-origin Origin', JSON.stringify({ externalId: METING_EXTERNAL_ID }), { 'content-type': 'application/json', origin: 'https://attacker.example' }, 'https://study.example/api/providers/meting/resolve'],
      ['aliased request origin', JSON.stringify({ externalId: METING_EXTERNAL_ID }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://alias.example/api/providers/meting/resolve'],
      ['JSON parameters', JSON.stringify({ externalId: METING_EXTERNAL_ID }), { 'content-type': 'application/json; charset=utf-8', origin: 'https://study.example' }, 'https://study.example/api/providers/meting/resolve'],
      ['a query', JSON.stringify({ externalId: METING_EXTERNAL_ID }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/meting/resolve?url=private'],
      ['an extra body key', JSON.stringify({ externalId: METING_EXTERNAL_ID, url: METING_MEDIA_URL }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/meting/resolve'],
      ['malformed JSON', '{', { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/meting/resolve'],
      ['a URL ID', JSON.stringify({ externalId: 'https://media.example/audio' }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/meting/resolve'],
      ['an unsupported server', JSON.stringify({ externalId: 'kugou:123456789' }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/meting/resolve'],
      ['an encoded request ID', JSON.stringify({ externalId: METING_ENCODED_ID }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/meting/resolve'],
      ['an overlong ID', JSON.stringify({ externalId: 'tencent:123456789012345678901' }), { 'content-type': 'application/json', origin: 'https://study.example' }, 'https://study.example/api/providers/meting/resolve'],
    ])('rejects %s before resolver, cache, or media access', async (_label, body, headers, url) => {
      await seedProvider('meting', 1, 9)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { cache, handler } = await createMetingHandler(fetchImpl)
      const response = await handler.fetch(metingResolveRequest(body, headers, url))

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_response' })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(cache.putCalls).toHaveLength(0)
    })

    it('fails closed before resolver access when configuration or current Admin state is unavailable', async () => {
      const fetchImpl = vi.fn() as unknown as typeof fetch
      await seedProvider('meting', 1, 9)
      const missingConfig = await createMetingHandler(fetchImpl, new FakeCache(), {})
      const unavailable = await missingConfig.handler.fetch(metingResolveRequest())
      await database.prepare('DELETE FROM provider_health').run()
      await seedProvider('meting', 0, 9)
      const disabled = await createMetingHandler(fetchImpl)
      const disabledResponse = await disabled.handler.fetch(metingResolveRequest())

      expect(unavailable.status).toBe(503)
      expect(disabledResponse.status).toBe(503)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('fails resolve closed when the 30-second ticket cannot be committed', async () => {
      const cache = new FakeCache()
      cache.failPut = new Error(`${METING_MEDIA_URL} must stay private`)
      const fetchImpl = vi.fn(async () => jsonResponse(metingMetadata())) as unknown as typeof fetch
      const consoleSpies = ['debug', 'error', 'info', 'log', 'warn'].map((name) =>
        vi.spyOn(console, name as 'log').mockImplementation(() => undefined))
      try {
        const { response } = await prepareMeting(fetchImpl, cache)
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: 'unavailable' })
        consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled())
      } finally {
        consoleSpies.forEach((spy) => spy.mockRestore())
      }
    })

    it.each([
      ['a non-GET/HEAD method', metingMediaPath(), 'POST'],
      ['a non-canonical request origin', metingMediaPath(), 'GET', 'https://alias.example'],
      ['a query-bearing path', metingMediaPath(METING_ENCODED_ID, '?url=private'), 'GET'],
      ['a fragment-bearing path', metingMediaPath(METING_ENCODED_ID, '#private'), 'GET'],
      ['a raw-colon path', metingMediaPath('netease:123456789'), 'GET'],
      ['a double-encoded path', metingMediaPath('netease%253A123456789'), 'GET'],
      ['a malformed trailing percent', metingMediaPath('netease%'), 'GET'],
      ['a malformed percent escape', metingMediaPath('netease%ZZ123'), 'GET'],
    ])('rejects %s before revealing absent Meting config', async (
      _label,
      path,
      method,
      origin = 'https://study.example',
    ) => {
      const cache = new FakeCache()
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { handler } = await createMetingHandler(fetchImpl, cache, {})
      const response = await handler.fetch(new Request(`${origin}${path}`, { method }))

      expect(response.status).toBe(method === 'POST' ? 405 : 400)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(cache.matchCalls).toHaveLength(0)
    })

    it('returns unavailable for a canonical media request with absent config before cache access', async () => {
      const cache = new FakeCache()
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { handler } = await createMetingHandler(fetchImpl, cache, {})
      const response = await handler.fetch(new Request(
        `https://study.example${metingMediaPath()}`,
      ))

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'unavailable' })
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(cache.matchCalls).toHaveLength(0)
    })

    it.each([
      ['raw colon', 'netease:123456789', ''],
      ['double encoding', 'netease%253A123456789', ''],
      ['encoded slash', 'netease%2F123456789', ''],
      ['canonical path query', METING_ENCODED_ID, '?url=https://attacker.example'],
      ['raw-colon path query', 'netease:123456789', '?url=https://attacker.example'],
      ['double-encoded path query', 'netease%253A123456789', '?url=https://attacker.example'],
      ['encoded-slash path query', 'netease%2F123456789', '?url=https://attacker.example'],
      ['malformed trailing percent', 'netease%', ''],
      ['malformed percent escape', 'netease%ZZ123', ''],
      ['extra path segment', METING_ENCODED_ID, '/extra'],
    ])('rejects a Meting ticket path with %s before cache or upstream access', async (_label, encodedId, suffix) => {
      await seedProvider('meting', 1, 9)
      const cache = new FakeCache()
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { handler } = await createMetingHandler(fetchImpl, cache)
      const response = await handler.fetch(new Request(
        `https://study.example${metingMediaPath(encodedId, suffix)}`,
      ))

      expect(response.status).toBe(400)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(cache.matchCalls).toHaveLength(0)
    })

    it('accepts one canonical decode/re-encode and strips browser credentials and upstream headers', async () => {
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async () => new Response(new Uint8Array([0]), {
        status: 206,
        headers: {
          'accept-ranges': 'bytes',
          'content-length': '1',
          'content-range': 'bytes 0-0/20',
          'content-type': 'audio/mpeg',
          location: 'https://must-not-reach-browser.example/private',
          server: 'private-upstream',
          'set-cookie': 'private-cookie',
        },
      })) as unknown as typeof fetch
      await seedProvider('meting', 1, 9)
      await cacheMetingTicket(cache)
      const { handler } = await createMetingHandler(fetchImpl, cache)
      const response = await handler.fetch(new Request(
        `https://study.example${metingMediaPath()}`,
        { headers: { authorization: 'browser-private', cookie: 'browser-private', range: 'bytes=0-0' } },
      ))

      expect(response.status).toBe(206)
      expect([...response.headers.entries()]).toEqual([
        ['accept-ranges', 'bytes'],
        ['cache-control', 'no-store'],
        ['content-length', '1'],
        ['content-range', 'bytes 0-0/20'],
        ['content-type', 'audio/mpeg'],
      ])
      const [, init] = vi.mocked(fetchImpl).mock.calls[0]!
      expect([...new Headers(init?.headers).entries()]).toEqual([['range', 'bytes=0-0']])
    })

    it('rejects expired, ID-mismatched, and nonce-mismatched tickets without contacting media', async () => {
      await seedProvider('meting', 1, 9)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const expiredCache = new FakeCache()
      await cacheMetingTicket(expiredCache, { expiresAt: 1_000 })
      const expiredHandler = await createMetingHandler(fetchImpl, expiredCache)
      const expired = await expiredHandler.handler.fetch(new Request(
        `https://study.example${metingMediaPath()}`,
      ))
      const mismatchedCache = new FakeCache()
      await cacheMetingTicket(mismatchedCache, { externalId: 'tencent:123456789' })
      const mismatchedHandler = await createMetingHandler(fetchImpl, mismatchedCache)
      const mismatched = await mismatchedHandler.handler.fetch(new Request(
        `https://study.example${metingMediaPath()}`,
      ))
      const mismatchedNonceCache = new FakeCache()
      await cacheMetingTicket(mismatchedNonceCache, {
        nonce: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      })
      const mismatchedNonceHandler = await createMetingHandler(fetchImpl, mismatchedNonceCache)
      const mismatchedNonce = await mismatchedNonceHandler.handler.fetch(new Request(
        `https://study.example${metingMediaPath()}`,
      ))

      expect(expired.status).toBe(410)
      expect(mismatched.status).toBe(502)
      expect(mismatchedNonce.status).toBe(502)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it.each([
      ['malformed request Range', 'bytes=1-0', new Response('unused'), 400],
      ['mismatched Content-Range', 'bytes=0-0', new Response(new Uint8Array([0]), {
        status: 206,
        headers: { 'content-length': '1', 'content-range': 'bytes 1-1/20', 'content-type': 'audio/mpeg' },
      }), 502],
      ['ticket MIME mismatch', null, new Response('audio', { headers: { 'content-type': 'audio/ogg' } }), 502],
    ])('rejects %s', async (_label, range, upstream, expectedStatus) => {
      await seedProvider('meting', 1, 9)
      const cache = new FakeCache()
      await cacheMetingTicket(cache)
      const fetchImpl = vi.fn(async () => upstream) as unknown as typeof fetch
      const { handler } = await createMetingHandler(fetchImpl, cache)
      const headers = range ? { range } : undefined
      const response = await handler.fetch(new Request(
        `https://study.example${metingMediaPath()}`,
        { headers },
      ))

      expect(response.status).toBe(expectedStatus)
      expect(await response.json()).toEqual({ error: 'invalid_response' })
      expect(fetchImpl).toHaveBeenCalledTimes(range === 'bytes=1-0' ? 0 : 1)
    })

    it('allows two exact-host redirects and rejects both an unallowlisted hop and a third hop', async () => {
      await seedProvider('meting', 1, 9)
      const allowedCache = new FakeCache()
      await cacheMetingTicket(allowedCache)
      const allowedResponses = [
        new Response(null, { status: 302, headers: { location: 'https://redirect.example/one' } }),
        new Response(null, { status: 307, headers: { location: '/final' } }),
        new Response('audio', { headers: { 'content-type': 'audio/mpeg' } }),
      ]
      const allowedFetch = vi.fn(async () => allowedResponses.shift()!) as unknown as typeof fetch
      const allowedHandler = await createMetingHandler(allowedFetch, allowedCache)
      const allowed = await allowedHandler.handler.fetch(new Request(
        `https://study.example${metingMediaPath()}`,
      ))

      const rejectedCache = new FakeCache()
      await cacheMetingTicket(rejectedCache)
      const rejectedFetch = vi.fn(async () => new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/audio' },
      })) as unknown as typeof fetch
      const rejectedHandler = await createMetingHandler(rejectedFetch, rejectedCache)
      const rejected = await rejectedHandler.handler.fetch(new Request(
        `https://study.example${metingMediaPath()}`,
      ))

      const thirdCache = new FakeCache()
      await cacheMetingTicket(thirdCache)
      const thirdFetch = vi.fn(async () => new Response(null, {
        status: 302,
        headers: { location: '/another' },
      })) as unknown as typeof fetch
      const thirdHandler = await createMetingHandler(thirdFetch, thirdCache)
      const third = await thirdHandler.handler.fetch(new Request(
        `https://study.example${metingMediaPath()}`,
      ))

      expect(allowed.status).toBe(200)
      expect(allowedFetch).toHaveBeenCalledTimes(3)
      expect(rejected.status).toBe(502)
      expect(rejectedFetch).toHaveBeenCalledOnce()
      expect(third.status).toBe(502)
      expect(thirdFetch).toHaveBeenCalledTimes(3)
    })

    it('rechecks current effective state before cache or media access', async () => {
      const cache = new FakeCache()
      await cacheMetingTicket(cache)
      await seedProvider('meting', 0, 9)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const { handler } = await createMetingHandler(fetchImpl, cache)
      const response = await handler.fetch(new Request(
        `https://study.example${metingMediaPath()}`,
      ))

      expect(response.status).toBe(503)
      expect(fetchImpl).not.toHaveBeenCalled()
      expect(cache.matchCalls).toHaveLength(0)
    })
  })

  describe('Jellyfin audio provider route integration', () => {
    const JELLYFIN_ITEM_ID = '1234abcda0d954293110f4d561b0f614'
    const JELLYFIN_TOKEN = 'secret-jellyfin-token-xyz'
    const JELLYFIN_USER_ID = '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f'
    const JELLYFIN_ENV = {
      JELLYFIN_BASE_URL: 'https://jellyfin.example',
      JELLYFIN_API_TOKEN: JELLYFIN_TOKEN,
      JELLYFIN_USER_ID,
    } as const

    const createJellyfinHandler = async (
      fetchImpl: typeof fetch,
      cache = new FakeCache(),
      envOverrides: Partial<ProviderEnv> = JELLYFIN_ENV,
      now: () => number = () => 1_000,
    ) => {
      const { createProviderHandler } = await import('../providers/routes')
      const env = providerEnv(envOverrides)
      const handler = createProviderHandler(env, {
        cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        crypto: deterministicCrypto,
        fetch: fetchImpl,
        now,
      })
      return {
        cache,
        handler,
        env,
        fetch: (request: Request) => handler.fetch(request),
      }
    }

    it('prepares one same-origin ticket and sends auth headers to upstream media fetch', async () => {
      await seedProvider('jellyfin', 1, 1)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = String(input)
        if (urlStr.includes('/Items/')) {
          return jsonResponse({
            Id: JELLYFIN_ITEM_ID,
            Type: 'Audio',
            MediaType: 'Audio',
            Container: 'mp3',
            MediaSources: [{ Id: JELLYFIN_ITEM_ID, Container: 'mp3', SupportsDirectPlay: true }],
          })
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            'content-type': 'audio/mpeg',
            'content-length': '3',
            'accept-ranges': 'bytes',
          },
        })
      }) as unknown as typeof fetch

      const created = await createJellyfinHandler(fetchImpl, cache)
      const resolveRes = await created.fetch(new Request('https://study.example/api/providers/jellyfin/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://study.example' },
        body: JSON.stringify({ externalId: JELLYFIN_ITEM_ID }),
      }))

      expect(resolveRes.status).toBe(200)
      const resolveBody = await resolveRes.json() as { mimeType: string; url: string }
      expect(resolveBody.mimeType).toBe('audio/mpeg')
      expect(resolveBody.url).toContain(`/api/providers/jellyfin/media/${JELLYFIN_ITEM_ID}/`)
      expect(JSON.stringify(resolveBody)).not.toContain(JELLYFIN_TOKEN)
      expect(JSON.stringify(resolveBody)).not.toContain('jellyfin.example')

      // Serve media ticket
      const mediaRes = await created.fetch(new Request(`https://study.example${resolveBody.url}`, {
        method: 'GET',
      }))
      expect(mediaRes.status).toBe(200)
      expect(mediaRes.headers.get('content-type')).toBe('audio/mpeg')
      expect(mediaRes.headers.get('x-emby-token')).toBeNull()
      expect(mediaRes.headers.get('authorization')).toBeNull()

      // Upstream calls
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      const [, mediaInit] = vi.mocked(fetchImpl).mock.calls[1]!
      const mediaReqHeaders = new Headers(mediaInit?.headers)
      // Jellyfin 12 accepts only the modern authorization form; the legacy header would 401.
      expect(mediaReqHeaders.get('authorization')).toBe(`MediaBrowser Token="${JELLYFIN_TOKEN}"`)
      expect(mediaReqHeaders.get('x-emby-token')).toBeNull()
      expect(mediaReqHeaders.get('x-mediabrowser-token')).toBeNull()
    })

    it('rejects invalid external ID or unconfigured provider', async () => {
      await seedProvider('jellyfin', 1, 1)
      const fetchImpl = vi.fn() as unknown as typeof fetch
      const created = await createJellyfinHandler(fetchImpl)

      const badId = await created.fetch(new Request('https://study.example/api/providers/jellyfin/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://study.example' },
        body: JSON.stringify({ externalId: 'not-a-uuid' }),
      }))
      expect(badId.status).toBe(400)

      const unconfigured = await createJellyfinHandler(fetchImpl, new FakeCache(), {})
      const unconfRes = await unconfigured.fetch(new Request('https://study.example/api/providers/jellyfin/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://study.example' },
        body: JSON.stringify({ externalId: JELLYFIN_ITEM_ID }),
      }))
      expect(unconfRes.status).toBe(503)
    })
  })

  describe('GD Studio audio provider route integration', () => {
    const GD_STUDIO_EXTERNAL_ID = 'netease:2100334024:320'
    const GD_STUDIO_ENV = {
      GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
      GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'm701.music.126.net',
    } as const

    const createGdStudioHandler = async (
      fetchImpl: typeof fetch,
      cache = new FakeCache(),
      envOverrides: Partial<ProviderEnv> = GD_STUDIO_ENV,
      now: () => number = () => 1_000,
    ) => {
      const { createProviderHandler } = await import('../providers/routes')
      const env = providerEnv(envOverrides)
      const handler = createProviderHandler(env, {
        cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        crypto: deterministicCrypto,
        fetch: fetchImpl,
        now,
      })
      return {
        cache,
        handler,
        env,
        fetch: (request: Request) => handler.fetch(request),
      }
    }

    it('prepares same-origin ticket for valid resolve request', async () => {
      await seedProvider('gd-studio', 1, 3)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = String(input)
        if (urlStr.includes('api.php')) {
          return jsonResponse({
            url: 'https://m701.music.126.net/audio/2100334024.mp3',
            br: 320,
            size: 5000,
          })
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '3', 'accept-ranges': 'bytes' },
        })
      }) as unknown as typeof fetch

      const created = await createGdStudioHandler(fetchImpl, cache)
      const resolveRes = await created.fetch(new Request('https://study.example/api/providers/gd-studio/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://study.example' },
        body: JSON.stringify({ externalId: GD_STUDIO_EXTERNAL_ID }),
      }))

      expect(resolveRes.status).toBe(200)
      const resolveBody = await resolveRes.json() as { mimeType: string; url: string }
      expect(resolveBody.mimeType).toBe('audio/mpeg')
      expect(resolveBody.url).toContain('/api/providers/gd-studio/media/')

      const mediaRes = await created.fetch(new Request(`https://study.example${resolveBody.url}`, {
        method: 'GET',
      }))
      expect(mediaRes.status).toBe(200)
      expect(mediaRes.headers.get('content-type')).toBe('audio/mpeg')
    })

    it('supports multiple observed media hostnames (m701 and m801)', async () => {
      await seedProvider('gd-studio', 1, 3)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = String(input)
        if (urlStr.includes('api.php')) {
          return jsonResponse({
            url: 'https://m801.music.126.net/audio/3334421408.mp3',
            br: 320,
            size: 7100,
          })
        }
        return new Response(new Uint8Array([4, 5, 6]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '3', 'accept-ranges': 'bytes' },
        })
      }) as unknown as typeof fetch

      const created = await createGdStudioHandler(fetchImpl, cache, {
        GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
        GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'm701.music.126.net, m801.music.126.net',
      })
      const resolveRes = await created.fetch(new Request('https://study.example/api/providers/gd-studio/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://study.example' },
        body: JSON.stringify({ externalId: 'netease:3334421408:320' }),
      }))

      expect(resolveRes.status).toBe(200)
      const resolveBody = await resolveRes.json() as { mimeType: string; url: string }
      expect(resolveBody.mimeType).toBe('audio/mpeg')

      const mediaRes = await created.fetch(new Request(`https://study.example${resolveBody.url}`, {
        method: 'GET',
      }))
      expect(mediaRes.status).toBe(200)
      expect(mediaRes.headers.get('content-type')).toBe('audio/mpeg')
    })
  })

  describe('HuanYin audio provider route integration', () => {
    const HUANYIN_EXTERNAL_ID = 'netease:2100334024:320k'
    const HUANYIN_ENV = {
      HUANYIN_API_BASE_URL: 'https://music-dl.example',
      HUANYIN_MEDIA_ALLOWED_HOSTNAMES: 'media.example',
    } as const

    const createHuanyinHandler = async (
      fetchImpl: typeof fetch,
      cache = new FakeCache(),
      envOverrides: Partial<ProviderEnv> = HUANYIN_ENV,
      now: () => number = () => 1_000,
    ) => {
      const { createProviderHandler } = await import('../providers/routes')
      const env = providerEnv(envOverrides)
      const handler = createProviderHandler(env, {
        cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
        crypto: deterministicCrypto,
        fetch: fetchImpl,
        now,
      })
      return {
        cache,
        handler,
        env,
        fetch: (request: Request) => handler.fetch(request),
      }
    }

    it('prepares same-origin ticket for valid resolve request', async () => {
      await seedProvider('lx-huanyin', 1, 4)
      const cache = new FakeCache()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const urlStr = String(input)
        if (urlStr.includes('/api/')) {
          return jsonResponse({
            code: 200,
            url: 'https://media.example/audio/2100334024.mp3',
          })
        }
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '3', 'accept-ranges': 'bytes' },
        })
      }) as unknown as typeof fetch

      const created = await createHuanyinHandler(fetchImpl, cache)
      const resolveRes = await created.fetch(new Request('https://study.example/api/providers/lx-huanyin/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://study.example' },
        body: JSON.stringify({ externalId: HUANYIN_EXTERNAL_ID }),
      }))

      expect(resolveRes.status).toBe(200)
      const resolveBody = await resolveRes.json() as { mimeType: string; url: string }
      expect(resolveBody.mimeType).toBe('audio/mpeg')
      expect(resolveBody.url).toContain('/api/providers/lx-huanyin/media/')
    })
  })
})
