import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CANONICAL_PROVIDERS,
  configuredGdStudioMediaHostnames,
  configuredGdStudioOrigin,
  configuredHuanyinMediaHostnames,
  configuredHuanyinOrigin,
  configuredJellyfinApiToken,
  configuredJellyfinUserId,
  configuredJellyfinOrigin,
  configuredLxMediaHostnames,
  configuredLxOrigin,
  configuredLxRequestKey,
  configuredMetingMediaHostnames,
  configuredMetingOrigin,
  configuredResolverMediaHostnames,
  deploymentAvailable,
  deploymentAvailableProviderIds,
  readProviderStates,
  type CanonicalProviderId,
  type ProviderEnv,
  type ProviderState,
} from '../providers/config'
import type { D1Database } from '../env'

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

// Explicit seeds must win over any row the migration set already created for the same key:
// `0021_playback_provider_defaults_v2.sql` legitimately seeds `chksz`/`lx`/`jellyfin`, so a plain
// INSERT would collide with the canonical default this test means to override.
const seedProvider = (db: D1Database, id: string, enabled: number, priority: number) =>
  db.prepare(`INSERT OR REPLACE INTO provider_health
    (provider_key, enabled, priority, status, updated_at)
    VALUES (?, ?, ?, 'unknown', 0)`)
    .bind(id, enabled, priority).run()

const project = (states: ProviderState[]) => states
  .filter(({ id }) => id === 'chksz' || id === 'jellyfin')
  .map(({ id, adminEnabled, deploymentAvailable, effectiveEnabled, priority }) =>
    [id, adminEnabled, deploymentAvailable, effectiveEnabled, priority])

const applyMigrations = async (db: TestDatabase) => {
  const names = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .filter((name) => !name.endsWith('_provider_defaults.sql'))
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

describe('canonical playback provider configuration', () => {
  const miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'provider-config-test' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  })

  beforeAll(async () => {
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
  })

  afterAll(async () => {
    await miniflare.dispose()
  })

  it('uses literal canonical defaults and ascending priority order for missing rows', async () => {
    const states = await readProviderStates(database, providerEnv())

    expect(states.map(({ id, adminEnabled, priority }) => [id, adminEnabled, priority])).toEqual([
      ['chksz', true, 10],
      ['lx', true, 20],
      ['jellyfin', true, 30],
    ])
    expect(deploymentAvailableProviderIds(providerEnv())).toEqual(['chksz', 'lx'])
    expect(deploymentAvailableProviderIds(providerEnv({ CHKSZ_API_KEY: 'test-key' })))
      .toEqual(['chksz', 'lx'])
    expect(deploymentAvailableProviderIds(providerEnv({
      JELLYFIN_BASE_URL: 'https://jellyfin.example',
      JELLYFIN_API_TOKEN: 'valid-token',
      JELLYFIN_USER_ID: '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f',
    }))).toEqual(['chksz', 'lx', 'jellyfin'])
    expect(CANONICAL_PROVIDERS.map(({ id }) => id)).toEqual([
      'chksz', 'lx', 'jellyfin',
    ])
  })

  it('keeps LX structurally available client-side without operator env vars', () => {
    expect(deploymentAvailable('lx', providerEnv())).toBe(true)
    expect(deploymentAvailable('lx', providerEnv({
      LX_HUIBQ_API_BASE_URL: 'https://evil.example',
    }))).toBe(true)
  })

  it.each([
    ['lx-huibq', 'LX_HUIBQ'],
    ['lx-ikun', 'LX_IKUN'],
  ] as const)('requires complete independent operator configuration for %s', (providerId, prefix) => {
    const complete = providerEnv({
      [`${prefix}_API_BASE_URL`]: `https://${providerId}.example`,
      [`${prefix}_MEDIA_ALLOWED_HOSTNAMES`]: `${providerId}-media.example`,
      [`${prefix}_REQUEST_KEY`]: 'OPERATOR_KEY_SENTINEL',
    })

    expect(configuredLxOrigin(providerId, complete)).toBe(`https://${providerId}.example`)
    expect(configuredLxMediaHostnames(providerId, complete)).toEqual([`${providerId}-media.example`])
    expect(configuredLxRequestKey(providerId, complete)).toBe('OPERATOR_KEY_SENTINEL')
    expect(deploymentAvailable(providerId, complete)).toBe(true)

    for (const missing of [
      { [`${prefix}_API_BASE_URL`]: `https://${providerId}.example` },
      { [`${prefix}_MEDIA_ALLOWED_HOSTNAMES`]: `${providerId}-media.example` },
      { [`${prefix}_REQUEST_KEY`]: 'OPERATOR_KEY_SENTINEL' },
    ]) expect(deploymentAvailable(providerId, providerEnv(missing))).toBe(false)
  })

  it.each([
    ['http://resolver.example', 'media.example', 'key'],
    ['https://127.0.0.1', 'media.example', 'key'],
    ['https://resolver.example/path', 'media.example', 'key'],
    ['https://resolver.example', '*.example', 'key'],
    ['https://resolver.example', 'MEDIA.example', 'key'],
    ['https://resolver.example', 'media.example', ''],
    ['https://resolver.example', 'media.example', ' key '],
    ['https://resolver.example', 'media.example', `key\nvalue`],
  ])('rejects unsafe Huibq operator configuration', (origin, hostnames, requestKey) => {
    const env = providerEnv({
      LX_HUIBQ_API_BASE_URL: origin,
      LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES: hostnames,
      LX_HUIBQ_REQUEST_KEY: requestKey,
    })
    expect(deploymentAvailable('lx-huibq', env)).toBe(false)
  })

  it('redacts every LX operational setting from provider state', async () => {
    const states = await readProviderStates(database, providerEnv({
      LX_HUIBQ_API_BASE_URL: 'https://huibq-private.example',
      LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES: 'huibq-media-private.example',
      LX_HUIBQ_REQUEST_KEY: 'HUIBQ_PRIVATE_KEY_SENTINEL',
      LX_IKUN_API_BASE_URL: 'https://ikun-private.example',
      LX_IKUN_MEDIA_ALLOWED_HOSTNAMES: 'ikun-media-private.example',
      LX_IKUN_REQUEST_KEY: 'IKUN_PRIVATE_KEY_SENTINEL',
    }))
    const serialised = JSON.stringify(states)

    expect(states.map(({ id }) => id)).toEqual(['chksz', 'lx', 'jellyfin'])
    for (const secret of [
      'huibq-private.example', 'huibq-media-private.example', 'HUIBQ_PRIVATE_KEY_SENTINEL',
      'ikun-private.example', 'ikun-media-private.example', 'IKUN_PRIVATE_KEY_SENTINEL',
    ]) expect(serialised).not.toContain(secret)
  })

  it('derives global effective enablement from deployment availability and persisted Admin intent', async () => {
    await seedProvider(database, 'jellyfin', 1, 9)
    await seedProvider(database, 'chksz', 1, 4)

    const withoutKey = await readProviderStates(database, providerEnv())
    expect(project(withoutKey)).toEqual([
      ['chksz', true, true, true, 4],
      ['jellyfin', true, false, false, 9],
    ])

    const withKey = await readProviderStates(database, providerEnv({
      JELLYFIN_BASE_URL: 'https://jellyfin.example',
      JELLYFIN_API_TOKEN: 'valid-token',
      JELLYFIN_USER_ID: '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f',
    }))
    expect(project(withKey)).toEqual([
      ['chksz', true, true, true, 4],
      ['jellyfin', true, true, true, 9],
    ])

    await database.prepare('UPDATE provider_health SET enabled = 0 WHERE provider_key IN (?, ?)')
      .bind('jellyfin', 'chksz').run()
    await database.prepare("INSERT OR REPLACE INTO provider_health (provider_key, enabled, priority, status, updated_at) VALUES ('lx', 0, 20, 'unknown', 0)").run()
    const adminDisabled = await readProviderStates(database, providerEnv({
      JELLYFIN_BASE_URL: 'https://jellyfin.example',
      JELLYFIN_API_TOKEN: 'valid-token',
      JELLYFIN_USER_ID: '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f',
    }))
    expect(adminDisabled.filter(({ effectiveEnabled }) => effectiveEnabled).map(({ id }) => id)).toEqual([])
  })

  it('keeps the canonical default order after the real migration set is applied', async () => {
    // `readProviderStates` prefers a persisted row over the declared default, and the migration set
    // seeds `provider_health` rows for the retired provider set. The canonical order is therefore
    // only real if the migrations leave those rows canonical — a database that has run
    // `wrangler d1 migrations apply` is the only state a deployment ever sees.
    //
    // This applies EVERY migration, including the `*_provider_defaults.sql` seeds that the rest of
    // this file deliberately skips. Skipping them is what let a seeded `chksz(enabled = 0,
    // priority = 11)` row survive into production while every test stayed green.
    const migrated = new Miniflare({
      compatibilityDate: '2025-12-01',
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: { DB: 'provider-config-migrated-test' },
      d1Persist: false,
      log: new Log(LogLevel.NONE),
    })

    try {
      const db = await migrated.getD1Database('DB')
      const names = (await readdir(MIGRATIONS_DIRECTORY))
        .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
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

      const states = await readProviderStates(db, providerEnv({ DB: db }))
      expect(states.map(({ id, adminEnabled, priority }) => [id, adminEnabled, priority])).toEqual([
        ['chksz', true, 10],
        ['lx', true, 20],
        ['jellyfin', true, 30],
      ])
    } finally {
      await migrated.dispose()
    }
  })

  it('keeps the reviewed ChKSz integration deployment-available without an Owner key', () => {
    expect(deploymentAvailable('chksz', providerEnv({ CHKSZ_API_KEY: undefined }))).toBe(true)
  })

  it('keeps canonical client-only providers deployment-unavailable', () => {
    expect(['meting', 'qijie', 'gd-studio', 'jellyfin', 'lx-huanyin'].map((id) => [
      id,
      deploymentAvailable(id as CanonicalProviderId, providerEnv()),
    ])).toEqual([
      ['meting', false],
      ['qijie', false],
      ['gd-studio', false],
      ['jellyfin', false],
      ['lx-huanyin', false],
    ])
  })

  it('requires an explicit Worker-only Meting resolver origin and media allowlist', () => {
    const valid = providerEnv({
      METING_API_BASE_URL: 'https://meting.example',
      METING_MEDIA_ALLOWED_HOSTNAMES: 'cdn-a.example,cdn-b.example',
    })

    expect(configuredMetingOrigin(valid)).toBe('https://meting.example')
    expect(configuredMetingMediaHostnames(valid)).toEqual(['cdn-a.example', 'cdn-b.example'])
    expect(deploymentAvailable('meting', valid)).toBe(true)

    expect(configuredMetingOrigin(providerEnv())).toBeNull()
    expect(configuredMetingMediaHostnames(providerEnv())).toBeNull()
    expect(deploymentAvailable('meting', providerEnv({
      METING_API_BASE_URL: 'https://meting.example',
    }))).toBe(false)
    expect(deploymentAvailable('meting', providerEnv({
      METING_MEDIA_ALLOWED_HOSTNAMES: 'cdn.example',
    }))).toBe(false)
  })

  it.each([
    'http://meting.example',
    'https://user:password@meting.example',
    'https://meting.example:8443',
    'https://meting.example/api',
    'https://meting.example?token=secret',
    'https://meting.example#fragment',
    'https://*.example.com',
    'https://METING.example',
    'https://127.0.0.1',
    'https://[::1]',
    'https://meting.internal',
  ])('rejects unsafe or non-lowercase Meting resolver origin %s', (baseUrl) => {
    expect(configuredMetingOrigin(providerEnv({
      METING_API_BASE_URL: baseUrl,
    }))).toBeNull()
    expect(deploymentAvailable('meting', providerEnv({
      METING_API_BASE_URL: baseUrl,
      METING_MEDIA_ALLOWED_HOSTNAMES: 'cdn.example',
    }))).toBe(false)
  })

  it.each([
    '*.example.com',
    'cdn.example,cdn.example',
    'cdn.internal',
    '127.0.0.1',
    '[::1]',
    'CDN.example',
    'cdn.example:8443',
    'user:password@cdn.example',
    'cdn.example/path',
    'cdn.example?token=secret',
    'cdn.example#fragment',
  ])('rejects unsafe, duplicate, or non-lowercase Meting media hostname %s', (allowedHostnames) => {
    const env = providerEnv({
      METING_API_BASE_URL: 'https://meting.example/',
      METING_MEDIA_ALLOWED_HOSTNAMES: allowedHostnames,
    })
    expect(configuredMetingMediaHostnames(env)).toBeNull()
    expect(deploymentAvailable('meting', env)).toBe(false)
  })

  it('redacts Meting operational configuration from provider state output', async () => {
    const env = providerEnv({
      METING_API_BASE_URL: 'https://meting-private.example',
      METING_MEDIA_ALLOWED_HOSTNAMES: 'meting-media-private.example',
    })
    expect(deploymentAvailable('meting', env)).toBe(true)

    const states = await readProviderStates(database, env)
    expect(states.map(({ id }) => id)).toEqual(['chksz', 'lx', 'jellyfin'])
    expect(JSON.stringify(states)).not.toContain('meting-private.example')
    expect(JSON.stringify(states)).not.toContain('meting-media-private.example')
  })

  it('does not project historical Meting rows into canonical state', async () => {
    await seedProvider(database, 'public-meting', 1, 66)
    await seedProvider(database, 'meting-agent', 1, 67)

    const states = await readProviderStates(database, providerEnv())

    expect(states.map(({ id }) => id)).toEqual(['chksz', 'lx', 'jellyfin'])
    expect(states.map(({ id }) => id)).not.toContain('public-meting')
    expect(states.map(({ id }) => id)).not.toContain('meting-agent')
    expect(states.map(({ id }) => id)).not.toContain('meting')
    expect(await database.prepare(`
      SELECT enabled, priority FROM provider_health WHERE provider_key = 'public-meting'
    `).first()).toEqual({ enabled: 1, priority: 66 })
    expect(await database.prepare(`
      SELECT enabled, priority FROM provider_health WHERE provider_key = 'meting-agent'
    `).first()).toEqual({ enabled: 1, priority: 67 })
  })

  it('requires a strictly valid public R2 configuration before making R2 available', () => {
    expect(deploymentAvailable('r2', providerEnv({
      R2_BASE_URL: 'https://media.example/library/',
      R2_ALLOWED_HOSTNAMES: 'media.example,cdn.example',
    }))).toBe(true)
    expect(deploymentAvailable('r2', providerEnv({
      R2_BASE_URL: 'http://media.example/',
      R2_ALLOWED_HOSTNAMES: 'media.example',
    }))).toBe(false)
    expect(deploymentAvailable('r2', providerEnv({
      R2_BASE_URL: 'https://media.example/?token=secret',
      R2_ALLOWED_HOSTNAMES: 'media.example',
    }))).toBe(false)
    expect(deploymentAvailable('r2', providerEnv({
      R2_BASE_URL: 'https://media.example/',
      R2_ALLOWED_HOSTNAMES: ' , ',
    }))).toBe(false)
  })

  it.each([
    ['piped', 'PIPED_API_BASE_URL'],
    ['invidious', 'INVIDIOUS_API_BASE_URL'],
  ] as const)('requires a strictly valid public root origin for %s', (providerId, envKey) => {
    expect(deploymentAvailable(providerId, providerEnv({
      [envKey]: 'https://resolver.example',
    }))).toBe(true)
    expect(deploymentAvailable(providerId, providerEnv({
      [envKey]: 'https://resolver.example/',
    }))).toBe(true)

    for (const value of [
      'http://resolver.example',
      'https://user:password@resolver.example',
      'https://resolver.example:8443',
      'https://resolver.example:443',
      'https://resolver.example/api',
      'https://resolver.example/%2e',
      'https://resolver.example?token=secret',
      'https://resolver.example#fragment',
      'https://localhost',
      'https://resolver.internal',
      'https://127.0.0.1',
      'https://[::1]',
    ]) {
      expect(deploymentAvailable(providerId, providerEnv({ [envKey]: value }))).toBe(false)
    }
  })

  it('does not expose configured resolver origins in provider state public config', async () => {
    const env = providerEnv({
      PIPED_API_BASE_URL: 'https://piped.example',
      INVIDIOUS_API_BASE_URL: 'https://invidious.example',
    })
    expect(deploymentAvailable('piped', env)).toBe(true)
    expect(deploymentAvailable('invidious', env)).toBe(true)

    const states = await readProviderStates(database, env)
    expect(states.map(({ id }) => id)).toEqual(['chksz', 'lx', 'jellyfin'])
    expect(JSON.stringify(states)).not.toContain('piped.example')
    expect(JSON.stringify(states)).not.toContain('invidious.example')
  })

  it('accepts only validated operator-configured resolver media hostnames', () => {
    const valid = providerEnv({
      PIPED_API_BASE_URL: 'https://piped.example',
      PIPED_MEDIA_ALLOWED_HOSTNAMES: 'proxy.example,cdn.example',
    })

    expect(configuredResolverMediaHostnames('piped', valid)).toEqual([
      'piped.example',
      'proxy.example',
      'cdn.example',
    ])
    expect(deploymentAvailable('piped', valid)).toBe(true)
    expect(deploymentAvailable('piped', providerEnv({
      PIPED_API_BASE_URL: 'https://piped.example',
      PIPED_MEDIA_ALLOWED_HOSTNAMES: 'proxy.internal',
    }))).toBe(false)
  })

  it('preserves hostname normalisation and deduplication for existing providers', async () => {
    const env = providerEnv({
      R2_BASE_URL: 'https://media.example/',
      R2_ALLOWED_HOSTNAMES: 'MEDIA.example,CDN.example,cdn.example',
    })
    expect(deploymentAvailable('r2', env)).toBe(true)
    const r2States = await readProviderStates(database, env)
    expect(r2States.find(({ id }) => (id as string) === 'r2')).toBeUndefined()

    for (const [id, baseUrlKey, allowedHostnamesKey] of [
      ['piped', 'PIPED_API_BASE_URL', 'PIPED_MEDIA_ALLOWED_HOSTNAMES'],
      ['invidious', 'INVIDIOUS_API_BASE_URL', 'INVIDIOUS_MEDIA_ALLOWED_HOSTNAMES'],
    ] as const) {
      const env = providerEnv({
        [baseUrlKey]: `https://${id}.example`,
        [allowedHostnamesKey]: 'PROXY.example,proxy.example,CDN.example',
      })
      expect(configuredResolverMediaHostnames(id, env)).toEqual([
        `${id}.example`, 'proxy.example', 'cdn.example',
      ])
      expect(deploymentAvailable(id, env)).toBe(true)
    }
  })

  it.each([
    ['IPv4 literal', 'https://127.0.0.1/', '127.0.0.1'],
    ['IPv6 literal', 'https://[::1]/', '[::1]'],
    ['localhost subdomain', 'https://media.localhost/', 'media.localhost'],
    ['single-label internal host', 'https://internal/', 'internal'],
    ['private-style suffix', 'https://media.internal/', 'media.internal'],
    ['base hostname absent from allowlist', 'https://media.example/', 'cdn.example'],
  ])('rejects R2 %s before it becomes deployment-available', (_label, baseUrl, allowedHostnames) => {
    expect(deploymentAvailable('r2', providerEnv({
      R2_BASE_URL: baseUrl,
      R2_ALLOWED_HOSTNAMES: allowedHostnames,
    }))).toBe(false)
  })

  describe('jellyfin provider configuration', () => {
    it('requires JELLYFIN_BASE_URL, a non-empty valid JELLYFIN_API_TOKEN, and JELLYFIN_USER_ID', () => {
      const valid = providerEnv({
        JELLYFIN_BASE_URL: 'https://jellyfin.example',
        JELLYFIN_API_TOKEN: 'valid-jellyfin-token-12345',
        JELLYFIN_USER_ID: '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f',
      })
      expect(configuredJellyfinOrigin(valid)).toBe('https://jellyfin.example')
      expect(configuredJellyfinApiToken(valid)).toBe('valid-jellyfin-token-12345')
      expect(configuredJellyfinUserId(valid)).toBe('8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f')
      expect(deploymentAvailable('jellyfin', valid)).toBe(true)

      expect(configuredJellyfinOrigin(providerEnv())).toBeNull()
      expect(configuredJellyfinApiToken(providerEnv())).toBeNull()
      expect(configuredJellyfinUserId(providerEnv())).toBeNull()
      expect(deploymentAvailable('jellyfin', providerEnv())).toBe(false)

      // Each of the three is individually required: Jellyfin 12 cannot complete a metadata
      // lookup without explicit user context, so a partially configured deployment is
      // reported as unavailable rather than failing later with an upstream HTTP 400.
      expect(deploymentAvailable('jellyfin', providerEnv({
        JELLYFIN_BASE_URL: 'https://jellyfin.example',
        JELLYFIN_USER_ID: '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f',
      }))).toBe(false)
      expect(deploymentAvailable('jellyfin', providerEnv({
        JELLYFIN_API_TOKEN: 'valid-jellyfin-token-12345',
        JELLYFIN_USER_ID: '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f',
      }))).toBe(false)
      expect(deploymentAvailable('jellyfin', providerEnv({
        JELLYFIN_BASE_URL: 'https://jellyfin.example',
        JELLYFIN_API_TOKEN: 'valid-jellyfin-token-12345',
      }))).toBe(false)
    })

    it.each([
      ['example placeholder', 'replace-with-jellyfin-user-id'],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['non-hex characters', '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6g'],
      ['too short', '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6'],
      ['too long', '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6ff'],
      ['query suffix', '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f?x=1'],
      ['path traversal', '../8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f'],
    ])('rejects an invalid Jellyfin user ID (%s)', (_label, userId) => {
      const env = providerEnv({
        JELLYFIN_BASE_URL: 'https://jellyfin.example',
        JELLYFIN_API_TOKEN: 'valid-token',
        JELLYFIN_USER_ID: userId,
      })
      expect(configuredJellyfinUserId(env)).toBeNull()
      expect(deploymentAvailable('jellyfin', env)).toBe(false)
    })

    it.each([
      'http://jellyfin.example',
      'https://user:password@jellyfin.example',
      'https://jellyfin.example:8096',
      'https://jellyfin.example:8443',
      'https://jellyfin.example/web',
      'https://jellyfin.example?token=secret',
      'https://jellyfin.example#fragment',
      'https://*.example.com',
      'https://JELLYFIN.example',
      'https://127.0.0.1',
      'https://[::1]',
      'https://jellyfin.internal',
      'https://localhost',
    ])('rejects unsafe Jellyfin base origin %s', (baseUrl) => {
      const env = providerEnv({
        JELLYFIN_BASE_URL: baseUrl,
        JELLYFIN_API_TOKEN: 'valid-token',
        JELLYFIN_USER_ID: '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f',
      })
      expect(configuredJellyfinOrigin(env)).toBeNull()
      expect(deploymentAvailable('jellyfin', env)).toBe(false)
    })

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['leading/trailing whitespace', ' token '],
      ['newline in token', 'token\nvalue'],
      ['control chars in token', 'token\x00value'],
      ['over 256 characters', 'a'.repeat(257)],
    ])('rejects invalid Jellyfin API token (%s)', (_label, token) => {
      const env = providerEnv({
        JELLYFIN_BASE_URL: 'https://jellyfin.example',
        JELLYFIN_API_TOKEN: token,
        JELLYFIN_USER_ID: '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f',
      })
      expect(configuredJellyfinApiToken(env)).toBeNull()
      expect(deploymentAvailable('jellyfin', env)).toBe(false)
    })

    it('redacts Jellyfin API token, user ID, and base URL from provider state output', async () => {
      const states = await readProviderStates(database, providerEnv({
        JELLYFIN_BASE_URL: 'https://jellyfin-private.example',
        JELLYFIN_API_TOKEN: 'SUPER_SECRET_JELLYFIN_TOKEN',
        JELLYFIN_USER_ID: '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f',
      }))

      expect(states).toContainEqual(expect.objectContaining({
        id: 'jellyfin', deploymentAvailable: true, effectiveEnabled: false,
      }))
      const serialized = JSON.stringify(states)
      expect(serialized).not.toContain('SUPER_SECRET_JELLYFIN_TOKEN')
      expect(serialized).not.toContain('jellyfin-private.example')
      // The user ID is an identifier rather than a credential, but it is still not part of the
      // public provider config contract, so it must not be echoed through provider state.
      expect(serialized).not.toContain('8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f')
    })
  })

  describe('gd-studio provider configuration', () => {
    it('requires both GD_STUDIO_API_BASE_URL and GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES', () => {
      const valid = providerEnv({
        GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
        GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.gdstudio.xyz, cdn.gdstudio.xyz',
      })
      expect(configuredGdStudioOrigin(valid)).toBe('https://music-api.gdstudio.xyz')
      expect(configuredGdStudioMediaHostnames(valid)).toEqual(['media.gdstudio.xyz', 'cdn.gdstudio.xyz'])
      expect(deploymentAvailable('gd-studio', valid)).toBe(true)

      expect(configuredGdStudioOrigin(providerEnv())).toBeNull()
      expect(configuredGdStudioMediaHostnames(providerEnv())).toBeNull()
      expect(deploymentAvailable('gd-studio', providerEnv())).toBe(false)
      expect(deploymentAvailable('gd-studio', providerEnv({
        GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
      }))).toBe(false)
      expect(deploymentAvailable('gd-studio', providerEnv({
        GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.gdstudio.xyz',
      }))).toBe(false)
    })

    it.each([
      'http://music-api.gdstudio.xyz',
      'https://user:password@music-api.gdstudio.xyz',
      'https://music-api.gdstudio.xyz:8443',
      'https://music-api.gdstudio.xyz/api.php',
      'https://music-api.gdstudio.xyz?key=secret',
      'https://music-api.gdstudio.xyz#fragment',
      'https://*.gdstudio.xyz',
      'https://MUSIC-API.gdstudio.xyz',
      'https://127.0.0.1',
      'https://[::1]',
      'https://gdstudio.internal',
      'https://localhost',
    ])('rejects unsafe GD Studio base origin %s', (baseUrl) => {
      const env = providerEnv({
        GD_STUDIO_API_BASE_URL: baseUrl,
        GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.gdstudio.xyz',
      })
      expect(configuredGdStudioOrigin(env)).toBeNull()
      expect(deploymentAvailable('gd-studio', env)).toBe(false)
    })

    it.each([
      '*.gdstudio.xyz',
      'media.gdstudio.xyz,media.gdstudio.xyz',
      'media.internal',
      '127.0.0.1',
      '[::1]',
      'MEDIA.gdstudio.xyz',
      'media.gdstudio.xyz:8443',
      'user:password@media.gdstudio.xyz',
      'media.gdstudio.xyz/path',
      'media.gdstudio.xyz?token=secret',
      'media.gdstudio.xyz#fragment',
    ])('rejects unsafe, duplicate, or non-lowercase GD Studio media hostname %s', (allowedHostnames) => {
      const env = providerEnv({
        GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
        GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: allowedHostnames,
      })
      expect(configuredGdStudioMediaHostnames(env)).toBeNull()
      expect(deploymentAvailable('gd-studio', env)).toBe(false)
    })

    it('redacts GD Studio operational config from provider state output', async () => {
      const env = providerEnv({
        GD_STUDIO_API_BASE_URL: 'https://gd-private.example',
        GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'gd-media-private.example',
      })
      expect(deploymentAvailable('gd-studio', env)).toBe(true)

      const states = await readProviderStates(database, env)
      expect(states.map(({ id }) => id)).toEqual(['chksz', 'lx', 'jellyfin'])
      const serialized = JSON.stringify(states)
      expect(serialized).not.toContain('gd-private.example')
      expect(serialized).not.toContain('gd-media-private.example')
    })
  })

  describe('lx-huanyin provider configuration', () => {
    it('requires both HUANYIN_API_BASE_URL and HUANYIN_MEDIA_ALLOWED_HOSTNAMES', () => {
      const valid = providerEnv({
        HUANYIN_API_BASE_URL: 'https://music-dl.sayqz.com',
        HUANYIN_MEDIA_ALLOWED_HOSTNAMES: 'media.sayqz.com, cdn.sayqz.com',
      })
      expect(configuredHuanyinOrigin(valid)).toBe('https://music-dl.sayqz.com')
      expect(configuredHuanyinMediaHostnames(valid)).toEqual(['media.sayqz.com', 'cdn.sayqz.com'])
      expect(deploymentAvailable('lx-huanyin', valid)).toBe(true)

      expect(configuredHuanyinOrigin(providerEnv())).toBeNull()
      expect(configuredHuanyinMediaHostnames(providerEnv())).toBeNull()
      expect(deploymentAvailable('lx-huanyin', providerEnv())).toBe(false)
      expect(deploymentAvailable('lx-huanyin', providerEnv({
        HUANYIN_API_BASE_URL: 'https://music-dl.sayqz.com',
      }))).toBe(false)
      expect(deploymentAvailable('lx-huanyin', providerEnv({
        HUANYIN_MEDIA_ALLOWED_HOSTNAMES: 'media.sayqz.com',
      }))).toBe(false)
    })

    it.each([
      'http://music-dl.sayqz.com',
      'https://user:password@music-dl.sayqz.com',
      'https://music-dl.sayqz.com:8443',
      'https://music-dl.sayqz.com/api',
      'https://music-dl.sayqz.com?key=secret',
      'https://music-dl.sayqz.com#fragment',
      'https://*.sayqz.com',
      'https://MUSIC-DL.sayqz.com',
      'https://127.0.0.1',
      'https://[::1]',
      'https://huanyin.internal',
      'https://localhost',
    ])('rejects unsafe HuanYin base origin %s', (baseUrl) => {
      const env = providerEnv({
        HUANYIN_API_BASE_URL: baseUrl,
        HUANYIN_MEDIA_ALLOWED_HOSTNAMES: 'media.sayqz.com',
      })
      expect(configuredHuanyinOrigin(env)).toBeNull()
      expect(deploymentAvailable('lx-huanyin', env)).toBe(false)
    })

    it.each([
      '*.sayqz.com',
      'media.sayqz.com,media.sayqz.com',
      'media.internal',
      '127.0.0.1',
      '[::1]',
      'MEDIA.sayqz.com',
      'media.sayqz.com:8443',
      'user:password@media.sayqz.com',
      'media.sayqz.com/path',
      'media.sayqz.com?token=secret',
      'media.sayqz.com#fragment',
    ])('rejects unsafe, duplicate, or non-lowercase HuanYin media hostname %s', (allowedHostnames) => {
      const env = providerEnv({
        HUANYIN_API_BASE_URL: 'https://music-dl.sayqz.com',
        HUANYIN_MEDIA_ALLOWED_HOSTNAMES: allowedHostnames,
      })
      expect(configuredHuanyinMediaHostnames(env)).toBeNull()
      expect(deploymentAvailable('lx-huanyin', env)).toBe(false)
    })

    it('redacts HuanYin operational config from provider state output', async () => {
      const env = providerEnv({
        HUANYIN_API_BASE_URL: 'https://huanyin-private.example',
        HUANYIN_MEDIA_ALLOWED_HOSTNAMES: 'huanyin-media-private.example',
      })
      expect(deploymentAvailable('lx-huanyin', env)).toBe(true)

      const states = await readProviderStates(database, env)
      expect(states.map(({ id }) => id)).toEqual(['chksz', 'lx', 'jellyfin'])
      const serialized = JSON.stringify(states)
      expect(serialized).not.toContain('huanyin-private.example')
      expect(serialized).not.toContain('huanyin-media-private.example')
    })
  })
})
