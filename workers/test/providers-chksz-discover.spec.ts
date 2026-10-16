import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Log, LogLevel, Miniflare } from './miniflare-compat'
import type { D1Database } from '../env'
import type { ProviderEnv } from '../providers/config'
import { createProviderHandler } from '../providers/routes'
import { discoverChkszTrack } from '../providers/chkszDiscoveryService'

const MIGRATIONS_DIRECTORY = resolve(process.cwd(), 'migrations')

const applyMigrations = async (db: D1Database) => {
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

const PUBLIC_ORIGIN = 'https://study.example'
const OWNER_KEY = 'owner-test-chksz-key'
const USER_KEY = 'user-test-chksz-key-1234'

const providerEnv = (overrides: Partial<ProviderEnv> = {}): ProviderEnv => ({
  DB: database,
  PUBLIC_ORIGIN,
  CHKSZ_API_KEY: OWNER_KEY,
  SESSION_HMAC_SECRET: 'session-secret-at-least-thirty-two-bytes',
  OAUTH_STATE_SECRET: 'oauth-secret-at-least-thirty-two-bytes',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GITHUB_CLIENT_ID: 'github-client',
  GITHUB_CLIENT_SECRET: 'github-secret',
  ...overrides,
})

let database: D1Database
let miniflare: Miniflare

const discoverRequest = (
  body: unknown,
  headers: Record<string, string> = {},
  origin = PUBLIC_ORIGIN,
  method = 'POST',
) => {
  const allHeaders: Record<string, string> = {
    'content-type': 'application/json',
    origin,
    ...headers,
  }
  return new Request(`${PUBLIC_ORIGIN}/api/providers/chksz/discover`, {
    method,
    headers: allHeaders,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('POST /api/providers/chksz/discover', () => {
  miniflare = new Miniflare({
    compatibilityDate: '2025-12-01',
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: 'chksz-discover-test' },
    d1Persist: false,
    log: new Log(LogLevel.NONE),
  })

  beforeAll(async () => {
    database = await miniflare.getD1Database('DB')
    await applyMigrations(database)
    await database.prepare(`INSERT INTO provider_health (provider_key, enabled, priority, status, updated_at) VALUES ('chksz', 1, 10, 'unknown', 0)`).run()
    await database.prepare(`INSERT INTO admin_settings (setting_key, setting_json, updated_at) VALUES ('provider.chksz.ownerKeyFallback', '{"enabled":true}', 0)`).run()
  })

  beforeEach(async () => {
    await database.prepare('DELETE FROM chksz_dynamic_discoveries').run()
    await database.prepare('DELETE FROM chksz_discovery_locks').run()
    await database.prepare('DELETE FROM chksz_discovery_rate_events').run()
  })

  afterAll(async () => {
    await miniflare.dispose()
  })

  it('rejects non-POST methods with 405', async () => {
    const handler = createProviderHandler(providerEnv())
    const response = await handler.fetch(
      new Request(`${PUBLIC_ORIGIN}/api/providers/chksz/discover`, { method: 'GET' }),
    )
    expect(response.status).toBe(405)
  })

  it('rejects cross-origin requests with 400', async () => {
    const handler = createProviderHandler(providerEnv())
    const response = await handler.fetch(
      discoverRequest({ trackId: 'test-track' }, {}, 'https://attacker.example'),
    )
    expect(response.status).toBe(400)
  })

  it('rejects request with missing title when track not in catalogue_tracks', async () => {
    const handler = createProviderHandler(providerEnv())
    const response = await handler.fetch(
      discoverRequest({ trackId: 'nonexistent-track', metadata: {} }),
    )
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: string }
    expect(body.error).toBe('invalid_response')
  })

  it('performs dynamic search, writes active discovery to D1, and caches subsequent calls', async () => {
    const searchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://api.chksz.com')
      expect(url.pathname).toBe('/api/163_search')
      expect(url.searchParams.get('keyword')).toBe('Test Song')
      expect(url.searchParams.get('apikey')).toBe(OWNER_KEY)

      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            songs: [
              {
                id: 123456789,
                name: 'Test Song',
                artists: 'HOYO-MiX',
                album: 'Test Album',
                duration: 180000,
              },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })

    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })

    // First call: cache miss, runs search, stores in D1
    const res1 = await handler.fetch(
      discoverRequest({
        trackId: 'test-track-1',
        metadata: {
          title: 'Test Song',
          vocalStatus: 'uncertain',
          duration_s: 180,
        },
      }),
    )

    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as { ok: boolean; externalId: string; confidence: string; source: string }
    expect(body1.ok).toBe(true)
    expect(body1.externalId).toBe('123456789')
    expect(body1.confidence).toBe('EXACT')
    expect(body1.source).toBe('search')
    expect(searchMock).toHaveBeenCalledTimes(1)

    // Verify D1 row
    const row = await database
      .prepare('SELECT * FROM chksz_dynamic_discoveries WHERE canonical_track_id = ?')
      .bind('test-track-1')
      .first<{ provider_external_id: string; status: string; match_confidence: string }>()
    expect(row).toBeDefined()
    expect(row?.provider_external_id).toBe('123456789')
    expect(row?.status).toBe('active')
    expect(row?.match_confidence).toBe('EXACT')

    // Second call: cache hit, zero upstream requests!
    const res2 = await handler.fetch(
      discoverRequest({
        trackId: 'test-track-1',
        metadata: {
          title: 'Test Song',
          vocalStatus: 'uncertain',
          duration_s: 180,
        },
      }),
    )

    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as { ok: boolean; externalId: string; confidence: string; source: string }
    expect(body2.ok).toBe(true)
    expect(body2.externalId).toBe('123456789')
    expect(body2.source).toBe('cache')
    expect(searchMock).toHaveBeenCalledTimes(1) // Still 1!
  })

  it('uses user key when x-chksz-api-key is supplied', async () => {
    const searchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('apikey')).toBe(USER_KEY)
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            songs: [{ id: 987654321, name: 'User Key Song', artists: 'HOYO-MiX', duration: 120000 }],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })

    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })
    const res = await handler.fetch(
      discoverRequest(
        { trackId: 'user-track', metadata: { title: 'User Key Song', vocalStatus: 'uncertain', duration_s: 120 } },
        { 'x-chksz-api-key': USER_KEY },
      ),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; externalId: string }
    expect(body.externalId).toBe('987654321')
    expect(searchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses discovery for denylisted pair', async () => {
    const searchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: {
            songs: [
              {
                id: 2100334024, // Denylisted for genshin-la-vaguelette
                name: 'La vaguelette',
                artists: 'HOYO-MiX',
                duration: 149520,
              },
            ],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )

    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })
    const res = await handler.fetch(
      discoverRequest({
        trackId: 'genshin-la-vaguelette',
        metadata: { title: 'La vaguelette', vocalStatus: 'vocal' },
      }),
    )

    // Should return 503 unavailable because candidate 2100334024 is denylisted
    expect(res.status).toBe(503)
  })

  it('records negative cache and returns 503 for no-match', async () => {
    const searchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          data: { songs: [] },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )

    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })
    const res = await handler.fetch(
      discoverRequest({
        trackId: 'unmatched-track',
        metadata: { title: 'Totally Nonexistent Song', vocalStatus: 'instrumental' },
      }),
    )

    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('no_match')

    // Verify negative cache in D1
    const row = await database
      .prepare('SELECT * FROM chksz_dynamic_discoveries WHERE canonical_track_id = ?')
      .bind('unmatched-track')
      .first<{ status: string; match_confidence: string; failure_reason: string }>()
    expect(row).toBeDefined()
    expect(row?.status).toBe('rejected')
    expect(row?.match_confidence).toBe('NO_MATCH')

    // Second request hits negative cache without upstream fetch
    const res2 = await handler.fetch(
      discoverRequest({
        trackId: 'unmatched-track',
        metadata: { title: 'Totally Nonexistent Song', vocalStatus: 'instrumental' },
      }),
    )
    expect(res2.status).toBe(503)
    expect(searchMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent in-flight discoveries for the same track into 1 fetch', async () => {
    let callCount = 0
    const searchMock = vi.fn(async () => {
      callCount++
      await new Promise((r) => setTimeout(r, 50))
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            songs: [{ id: 555666777, name: 'Concurrent Song', artists: 'HOYO-MiX', duration: 60000 }],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })

    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })

    const [p1, p2, p3] = await Promise.all([
      handler.fetch(discoverRequest({ trackId: 'concurrent-track', metadata: { title: 'Concurrent Song', vocalStatus: 'uncertain', duration_s: 60 } })),
      handler.fetch(discoverRequest({ trackId: 'concurrent-track', metadata: { title: 'Concurrent Song', vocalStatus: 'uncertain', duration_s: 60 } })),
      handler.fetch(discoverRequest({ trackId: 'concurrent-track', metadata: { title: 'Concurrent Song', vocalStatus: 'uncertain', duration_s: 60 } })),
    ])

    expect(p1.status).toBe(200)
    expect(p2.status).toBe(200)
    expect(p3.status).toBe(200)
    expect(callCount).toBe(1)
  })

  it('enforces D1 global rate limit when 15 events occur within 60s, returning 429 with retry-after', async () => {
    const searchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            songs: [{ id: 111222333, name: 'Rate Safe Song', artists: 'HOYO-MiX', duration: 120000 }],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })

    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })

    // Seed 15 rate events in D1 directly within the past 30 seconds
    const now = Date.now()
    for (let i = 0; i < 15; i++) {
      await database
        .prepare('INSERT INTO chksz_discovery_rate_events (created_at) VALUES (?)')
        .bind(now - (15 - i) * 1000)
        .run()
    }

    // Next request should hit global D1 rate limiter
    const res = await handler.fetch(
      discoverRequest({
        trackId: 'rate-limited-track',
        metadata: { title: 'Rate Safe Song', vocalStatus: 'uncertain', duration_s: 120 },
      }),
    )

    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: string; retryAfter?: number }
    expect(body.error).toBe('rate_limited')
    expect(body.retryAfter).toBeGreaterThan(0)
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfter))
    expect(searchMock).toHaveBeenCalledTimes(0)
  })

  it('coalesces cross-isolate searches via track lock and D1 cache polling without duplicate upstream fetch', async () => {
    const searchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            songs: [{ id: 999888777, name: 'Cross Isolate Song', artists: 'HOYO-MiX', duration: 90000 }],
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })

    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })

    // Simulate another isolate acquiring the track lock for 'cross-isolate-track'
    const otherOwner = 'other-isolate-owner-id'
    const now = Date.now()
    await database
      .prepare('INSERT INTO chksz_discovery_locks (lock_key, owner_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind('track:cross-isolate-track', otherOwner, now, now + 10_000)
      .run()

    // Simulate that other isolate completing and writing to D1 after 400ms
    setTimeout(async () => {
      await database
        .prepare(`
          INSERT INTO chksz_dynamic_discoveries (
            canonical_track_id, provider, provider_external_id, match_confidence, matcher_version,
            canonical_metadata_fingerprint, evidence_json, discovered_at, last_verified_at,
            status, failure_reason, expires_at
          ) VALUES (?, 'chksz', '999888777', 'EXACT', 'chksz-identity-v1', 'fp_chksz-identity-v1_a02e7dd7', '{}', ?, ?, 'active', NULL, ?)
        `)
        .bind('cross-isolate-track', now, now, now + 100_000)
        .run()
      // Release lock
      await database
        .prepare('DELETE FROM chksz_discovery_locks WHERE lock_key = ?')
        .bind('track:cross-isolate-track')
        .run()
    }, 400)

    // Current isolate's request should poll D1, pick up the record, and succeed without making an upstream fetch!
    const res = await handler.fetch(
      discoverRequest({
        trackId: 'cross-isolate-track',
        metadata: { title: 'Cross Isolate Song', vocalStatus: 'uncertain', duration_s: 90 },
      }),
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; externalId: string; source: string }
    expect(body.ok).toBe(true)
    expect(body.externalId).toBe('999888777')
    expect(body.source).toBe('cache')
    expect(searchMock).toHaveBeenCalledTimes(0)
  })

  it('rejects HIGH_CONFIDENCE matches from runtime active use (fails closed to 503)', async () => {
    // Return a candidate that only reaches HIGH_CONFIDENCE (e.g. acceptable duration, not exact/near)
    const searchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            songs: [{ id: 444333222, name: 'High Conf Song', artists: 'HOYO-MiX', duration: 101800 }], // 1.8s delta -> acceptable duration
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })

    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })
    const res = await handler.fetch(
      discoverRequest({
        trackId: 'high-conf-track',
        metadata: { title: 'High Conf Song', vocalStatus: 'uncertain', duration_s: 100 },
      }),
    )

    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('high_confidence')

    // Verify D1 row status is 'rejected'
    const row = await database
      .prepare('SELECT status, match_confidence FROM chksz_dynamic_discoveries WHERE canonical_track_id = ?')
      .bind('high-conf-track')
      .first<{ status: string; match_confidence: string }>()
    expect(row?.status).toBe('rejected')
    expect(row?.match_confidence).toBe('HIGH_CONFIDENCE')
  })

  it('does not return a cached File 90 ID after that provider pair is deny-listed', async () => {
    const trackId = 'zzz-shining-promise-in-the-sky-of-dawn'
    const now = Date.now()
    await database.prepare("INSERT INTO chksz_dynamic_discoveries (canonical_track_id, provider, provider_external_id, match_confidence, matcher_version, canonical_metadata_fingerprint, evidence_json, discovered_at, last_verified_at, status, failure_reason, expires_at) VALUES (?, 'chksz', '1997387229', 'EXACT', 'chksz-identity-v1', ?, '{}', ?, ?, 'active', NULL, ?)").bind(trackId, 'fp_chksz-identity-v1_988e0d37', now - 1000, now - 1000, now + 60_000).run()

    const before = await database.prepare("SELECT rowid AS rowId, last_verified_at AS lastVerifiedAt FROM chksz_dynamic_discoveries WHERE canonical_track_id = ?").bind(trackId).first<{ rowId: number; lastVerifiedAt: number }>()
    const searchMock = vi.fn(async () => new Response('{}'))
    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })
    const response = await handler.fetch(discoverRequest({
      trackId,
      metadata: { title: 'Shining Promise in the Sky of Dawn', vocalStatus: 'vocal', aliases: [] },
    }))

    expect(response.status).toBe(403)
    expect(searchMock).toHaveBeenCalledTimes(0)
    const row = await database.prepare("SELECT rowid AS rowId, last_verified_at AS lastVerifiedAt, provider_external_id, match_confidence, status, failure_reason FROM chksz_dynamic_discoveries WHERE canonical_track_id = ?").bind(trackId).first<{ rowId: number; lastVerifiedAt: number; provider_external_id: string | null; match_confidence: string; status: string; failure_reason: string | null }>()
    expect(row).toBeDefined()
    expect(row?.rowId).toBe(before?.rowId)
    expect(row?.lastVerifiedAt).toBe(before?.lastVerifiedAt)
    expect(row?.provider_external_id).toBeNull()
    expect(row?.match_confidence).toBe('CONFLICT')
    expect(row?.status).toBe('rejected')
    expect(row?.failure_reason).toBe('denylisted_cached_identity')
  })

  it('serves the independently verified File 90 cache when its current-client fingerprint matches', async () => {
    const trackId = 'zzz-shining-promise-in-the-sky-of-dawn'
    const now = Date.now()
    await database.prepare("INSERT INTO chksz_dynamic_discoveries (canonical_track_id, provider, provider_external_id, match_confidence, matcher_version, canonical_metadata_fingerprint, evidence_json, discovered_at, last_verified_at, status, failure_reason, expires_at) VALUES (?, 'chksz', '2691982297', 'EXACT', 'chksz-identity-v1', 'fp_chksz-identity-v1_988e0d37', '{\"identity_audit\":\"verified\"}', ?, ?, 'active', NULL, ?)").bind(trackId, now - 1000, now, now + 60_000).run()

    const searchMock = vi.fn(async () => new Response('{}'))
    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })
    const response = await handler.fetch(discoverRequest({
      trackId,
      metadata: { title: 'Shining Promise in the Sky of Dawn', vocalStatus: 'vocal', aliases: [] },
    }))

    expect(response.status).toBe(200)
    const body = await response.json() as { externalId: string; confidence: string; source: string }
    expect(body).toEqual({ ok: true, externalId: '2691982297', confidence: 'EXACT', source: 'cache' })
    expect(searchMock).toHaveBeenCalledTimes(0)
  })

  it('revalidates a File 90 cache fingerprint that predates the current client metadata', async () => {
    const trackId = 'zzz-shining-promise-in-the-sky-of-dawn'
    const now = Date.now()
    await database.prepare("INSERT INTO chksz_dynamic_discoveries (canonical_track_id, provider, provider_external_id, match_confidence, matcher_version, canonical_metadata_fingerprint, evidence_json, discovered_at, last_verified_at, status, failure_reason, expires_at) VALUES (?, 'chksz', '2691982297', 'EXACT', 'chksz-identity-v1', ?, '{}', ?, ?, 'active', NULL, ?)").bind(trackId, 'fp_chksz-identity-v1_cde206cc', now - 1000, now - 1000, now + 60_000).run()

    const before = await database.prepare("SELECT rowid AS rowId FROM chksz_dynamic_discoveries WHERE canonical_track_id = ?").bind(trackId).first<{ rowId: number }>()
    const searchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 200,
      data: { songs: [{
        id: 2691982297,
        name: 'Shining Promise in the Sky of Dawn',
        artists: '三Z-STUDIO/HOYO-MiX',
        album: '绝区零-拂晓之空 闪耀之誓',
        duration: 210_596,
      }] },
    }), { headers: { 'content-type': 'application/json' } }))
    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })
    const response = await handler.fetch(discoverRequest({
      trackId,
      metadata: { title: 'Shining Promise in the Sky of Dawn', vocalStatus: 'vocal', aliases: [] },
    }))

    expect(response.status).toBe(503)
    const body = await response.json() as { error: string }
    expect(body.error).toBe('high_confidence')
    expect(searchMock).toHaveBeenCalledTimes(1)
    const row = await database.prepare("SELECT rowid AS rowId, provider_external_id, match_confidence, matcher_version, canonical_metadata_fingerprint, status FROM chksz_dynamic_discoveries WHERE canonical_track_id = ?").bind(trackId).first<{ rowId: number; provider_external_id: string | null; match_confidence: string; matcher_version: string; canonical_metadata_fingerprint: string; status: string }>()
    expect(row?.rowId).toBe(before?.rowId)
    expect(row?.provider_external_id).toBe('2691982297')
    expect(row?.match_confidence).toBe('HIGH_CONFIDENCE')
    expect(row?.matcher_version).toBe('chksz-identity-v1')
    expect(row?.canonical_metadata_fingerprint).not.toBe('fp_chksz-identity-v1_cde206cc')
    expect(row?.status).toBe('rejected')
  })

  it('revalidates a cached match produced by a different matcher version', async () => {
    const now = Date.now()
    await database.prepare("INSERT INTO chksz_dynamic_discoveries (canonical_track_id, provider, provider_external_id, match_confidence, matcher_version, canonical_metadata_fingerprint, evidence_json, discovered_at, last_verified_at, status, failure_reason, expires_at) VALUES ('old-matcher-cache-track', 'chksz', '999888777', 'EXACT', 'chksz-identity-v0', ?, '{}', ?, ?, 'active', NULL, ?)").bind('fp_chksz-identity-v1_3ba539e9', now - 1000, now - 1000, now + 60_000).run()

    const searchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 200,
      data: { songs: [{ id: 123456789, name: 'Versioned Cache Song', artists: 'HOYO-MiX', duration: 120_000 }] },
    }), { headers: { 'content-type': 'application/json' } }))
    const handler = createProviderHandler(providerEnv(), { fetch: searchMock as unknown as typeof fetch })
    const response = await handler.fetch(discoverRequest({
      trackId: 'old-matcher-cache-track',
      metadata: { title: 'Versioned Cache Song', vocalStatus: 'uncertain', duration_s: 120, aliases: [] },
    }))

    expect(response.status).toBe(200)
    const body = await response.json() as { externalId: string; source: string }
    expect(body.externalId).toBe('123456789')
    expect(body.source).toBe('search')
    expect(searchMock).toHaveBeenCalledTimes(1)
    const row = await database.prepare("SELECT provider_external_id, matcher_version, canonical_metadata_fingerprint FROM chksz_dynamic_discoveries WHERE canonical_track_id = ?").bind('old-matcher-cache-track').first<{ provider_external_id: string; matcher_version: string; canonical_metadata_fingerprint: string }>()
    expect(row?.provider_external_id).toBe('123456789')
    expect(row?.matcher_version).toBe('chksz-identity-v1')
    expect(row?.canonical_metadata_fingerprint).toBe('fp_chksz-identity-v1_3ba539e9')
  })

  it('keeps a verified static ChKSz source ahead of a conflicting dynamic cache row', async () => {
    const now = Date.now()
    await database.prepare("INSERT INTO catalogue_tracks (track_id, title, album, release_date, vocal_status, work_group_id, created_at, updated_at, published_at) VALUES ('static-precedence-track', 'Static Priority Song', 'Static Album', NULL, 'vocal', 'static-priority-group', ?, ?, ?)").bind(now, now, now).run()
    await database.prepare("INSERT INTO catalogue_sources (source_row_id, track_id, provider, external_id, rights_status, created_at, updated_at) VALUES ('static-precedence-chksz', 'static-precedence-track', 'chksz', '111222333', 'verified', ?, ?)").bind(now, now).run()
    await database.prepare("INSERT INTO chksz_dynamic_discoveries (canonical_track_id, provider, provider_external_id, match_confidence, matcher_version, canonical_metadata_fingerprint, evidence_json, discovered_at, last_verified_at, status, failure_reason, expires_at) VALUES ('static-precedence-track', 'chksz', '999888777', 'EXACT', 'chksz-identity-v1', 'current-fingerprint', '{}', ?, ?, 'active', NULL, ?)").bind(now - 1000, now - 1000, now + 60_000).run()

    const searchMock = vi.fn(async () => new Response('{}'))
    const result = await discoverChkszTrack(
      'static-precedence-track',
      { title: 'Static Priority Song', vocalStatus: 'vocal', duration_s: 120, album: 'Static Album' },
      OWNER_KEY,
      database,
      { fetch: searchMock as unknown as typeof fetch },
    )

    expect(result).toEqual({ ok: true, externalId: '111222333', confidence: 'EXACT', source: 'static' })
    expect(searchMock).toHaveBeenCalledTimes(0)
  })

})
