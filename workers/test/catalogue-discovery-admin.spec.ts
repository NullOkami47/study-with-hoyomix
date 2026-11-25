import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { readCandidate, updateCandidate } from '../catalogue/discovery/repository'
import type { DiscoveryAppend } from '../catalogue/discovery/types'
import { catalogueDatabase } from './catalogue-fixture'
import { createAuthHandler } from '../auth/routes'
import { createCatalogueAdminHandler } from '../catalogue/adminRoutes'
import { createDiscoveryIngestHandler } from '../catalogue/discovery/routes'
import {
  readCatalogueSnapshot,
  readPublishedCatalogue,
} from '../catalogue/repository'
import { exportWorkbook } from '../catalogue/staging'
import {
  DISCOVERY_CHANNEL,
  discoveryUpstream,
  discoveryCache,
} from './catalogue-discovery-fixture'
import type { ImportBatch } from '../catalogue/types'
const origin = 'https://study.example',
  now = 1793923200000
const discovery = {
  videoId: 'abcdefghijk',
  title: 'New Dawn',
  album: 'New Album',
  games: ['genshin'],
  artistChannelId: DISCOVERY_CHANNEL,
  albumBrowseId: 'MPRE-one',
  durationSeconds: 180,
  evidence: ['https://music.youtube.com/watch?v=abcdefghijk'],
}
let fixture: Awaited<ReturnType<typeof catalogueDatabase>>,
  env: any,
  cookie: string,
  book: ReturnType<typeof exportWorkbook>,
  app: ReturnType<typeof createCatalogueAdminHandler>
let append: ReturnType<typeof vi.fn<(plan: DiscoveryAppend) => Promise<void>>>
const req = (
  path: string,
  method = 'GET',
  body?: unknown,
  authenticated = true,
) =>
  new Request(origin + '/api/admin/catalogue/discovery' + path, {
    method,
    headers: {
      origin,
      'content-type': 'application/json',
      ...(authenticated ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
beforeEach(async () => {
  fixture = await catalogueDatabase()
  env = {
    DB: fixture.db,
    PUBLIC_ORIGIN: origin,
    SESSION_HMAC_SECRET: 'test-session-long-enough',
    CATALOGUE_DISCOVERY_CHANNEL_IDS: DISCOVERY_CHANNEL,
    CATALOGUE_DISCOVERY_INGEST_TOKEN: 'test-ingest-token-is-32-characters-long',
    CATALOGUE_SHEET_ID: 'test-sheet',
    GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: 'a@test.iam.gserviceaccount.com',
    GOOGLE_SHEETS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY----- fixture',
    GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
    GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.fixture.example',
  }
  await fixture.db
    .prepare(
      "INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES('admin','Admin','admin',1,1)",
    )
    .run()
  await fixture.db
    .prepare(
      "UPDATE provider_health SET enabled=1,updated_at=1 WHERE provider_key='gd-studio'",
    )
    .run()
  cookie =
    '__Host-session=' +
    (await createAuthHandler(env, { now: () => now }).issueSession('admin'))
      .token
  book = exportWorkbook(await readCatalogueSnapshot(fixture.db))
  append = vi.fn(async (plan: DiscoveryAppend) => {
    for (const tab of ['Tracks', 'Sources', 'Aliases'] as const)
      book[tab].push(...plan[tab])
  })
  app = createCatalogueAdminHandler(env, {
    now: () => now,
    sheets: {
      read: async () => structuredClone(book),
      write: async () => {},
      append,
    },
    discovery: { fetch: discoveryUpstream(), cache: discoveryCache() },
  } as any)
})
afterEach(async () => {
  await fixture?.dispose()
})
async function ingest(runId = 'run-one') {
  return app.fetch(
    req('/import', 'POST', {
      schemaVersion: 1,
      runId,
      discoveries: [discovery],
    }),
  )
}
describe('candidate inbox authorisation and identity', () => {
  it('requires Admin for review and restricts scanner token to ingestion', async () => {
    expect((await app.fetch(req('', 'GET', undefined, false))).status).toBe(401)
    const h = createDiscoveryIngestHandler(env, { now: () => now })
    const r = await h.fetch(
      new Request(origin + '/api/catalogue/discovery/runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + env.CATALOGUE_DISCOVERY_INGEST_TOKEN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: 1,
          runId: 'run-one',
          discoveries: [discovery],
        }),
      }),
    )
    expect(r.status).toBe(200)
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('1')
    expect(
      (
        await app.fetch(
          req('/import', 'POST', {
            schemaVersion: 1,
            runId: 'bad-channel',
            discoveries: [{ ...discovery, artistChannelId: 'UC-untrusted' }],
          }),
        )
      ).status,
    ).toBe(400)
  })
  it('keeps repeat scans idempotent and refuses changed payload reuse', async () => {
    expect((await ingest()).status).toBe(200)
    expect((await ingest()).status).toBe(200)
    expect((await ingest('run-two')).status).toBe(200)
    const status: any = await (await app.fetch(req(''))).json()
    expect(status.candidates).toHaveLength(1)
    expect(status.runs).toHaveLength(2)
    expect(status.runs.find((r: any) => r.runId === 'run-two').added).toBe(0)
    const reuse = await app.fetch(
      req('/import', 'POST', {
        schemaVersion: 1,
        runId: 'run-one',
        discoveries: [],
      }),
    )
    expect(reuse.status).toBe(409)
  })
  it('records successful empty scans without touching published rows', async () => {
    const r = await app.fetch(
      req('/import', 'POST', {
        schemaVersion: 1,
        runId: 'run-empty',
        discoveries: [],
      }),
    )
    expect(r.status).toBe(200)
    expect((await readPublishedCatalogue(fixture.db)).tracks).toHaveLength(3)
  })
})
describe('reviewed discovery to actual test D1', () => {
  it('stages append-only then publishes through the existing Admin CAS flow', async () => {
    await ingest()
    let status: any = await (await app.fetch(req(''))).json()
    let c = status.candidates[0]
    expect(
      (
        await app.fetch(
          req('/' + c.id + '/stage', 'POST', {
            revision: c.revision,
            expectedCatalogueRevision: 1,
          }),
        )
      ).status,
    ).toBe(409)
    let r = await app.fetch(
      req('/' + c.id, 'PATCH', {
        revision: c.revision,
        suggestion: {
          ...c.suggestion,
          vocal_status: 'vocal',
          tabs: ['focus'],
          uncertainties: [],
          adapter: 'manual',
        },
        reviewed: true,
      }),
    )
    expect(r.status).toBe(200)
    c = await r.json()
    r = await app.fetch(
      req('/' + c.id + '/check', 'POST', { revision: c.revision }),
    )
    expect(r.status).toBe(200)
    c = await r.json()
    expect(c.sources.find((s: any) => s.provider === 'youtube').status).toBe(
      'valid',
    )
    expect(
      c.sources.find((s: any) => s.provider === 'gd-studio'),
    ).toMatchObject({ status: 'valid' })
    const existing = book.Tracks[1][1]
    r = await app.fetch(
      req('/' + c.id + '/stage', 'POST', {
        revision: c.revision,
        expectedCatalogueRevision: 1,
      }),
    )
    expect(r.status).toBe(200)
    expect(book.Tracks[1][1]).toBe(existing)
    expect((await readPublishedCatalogue(fixture.db)).tracks).toHaveLength(3)
    const adminReq = (path: string, body: unknown) =>
      new Request(origin + '/api/admin/catalogue' + path, {
        method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    let batch: ImportBatch = await (
      await app.fetch(adminReq('/sync', {}))
    ).json()
    expect(batch.changes.some((x) => x.kind === 'new_track')).toBe(true)
    for (const change of batch.changes) {
      const response = await app.fetch(
        new Request(
          origin +
            '/api/admin/catalogue/batches/' +
            batch.batchId +
            '/changes/' +
            change.changeId,
          {
            method: 'PATCH',
            headers: { origin, cookie, 'content-type': 'application/json' },
            body: JSON.stringify({
              decision: 'approved',
              reviewRevision: batch.reviewRevision,
            }),
          },
        ),
      )
      expect(response.status).toBe(200)
      batch = await response.json()
    }
    const published = await app.fetch(
      adminReq('/batches/' + batch.batchId + '/publish', {
        reviewRevision: batch.reviewRevision,
      }),
    )
    expect(published.status).toBe(200)
    const catalogue = await readPublishedCatalogue(fixture.db)
    expect(catalogue.revision).toBe('2')
    expect(catalogue.tracks.find((t) => t.id === c.trackId)).toMatchObject({
      title: 'New Dawn',
      vocalStatus: 'vocal',
      tabs: ['focus'],
      sources: expect.arrayContaining([
        {
          provider: 'gd-studio',
          externalId: 'netease:9876543210',
          metadata: {},
        },
        { provider: 'youtube', externalId: 'abcdefghijk', metadata: {} },
      ]),
    })
    expect(
      (
        await app.fetch(
          adminReq('/batches/' + batch.batchId + '/publish', {
            reviewRevision: batch.reviewRevision,
          }),
        )
      ).status,
    ).toBe(409)
  })
  it('invalidates source checks after classification edits and rejects stale checks', async () => {
    await ingest()
    let status: any = await (await app.fetch(req(''))).json()
    let c = status.candidates[0]
    c = await (
      await app.fetch(
        req('/' + c.id + '/check', 'POST', { revision: c.revision }),
      )
    ).json()
    expect(c.sources.length).toBeGreaterThan(0)
    const old = c.revision
    c = await (
      await app.fetch(
        req('/' + c.id, 'PATCH', {
          revision: c.revision,
          suggestion: { ...c.suggestion, album: 'Changed Album' },
          reviewed: true,
        }),
      )
    ).json()
    expect(c.sources).toEqual([])
    expect(
      (await app.fetch(req('/' + c.id + '/check', 'POST', { revision: old })))
        .status,
    ).toBe(409)
  })
  it('requires a fresh revision for AI suggestions and never imports them as human-approved', async () => {
    await ingest()
    const status: any = await (await app.fetch(req(''))).json()
    const c = status.candidates[0]
    const { adapter, ...fields } = c.suggestion
    const payload = {
      schemaVersion: 1,
      adapter: 'gemini-spark',
      suggestions: [
        { videoId: c.discovery.videoId, revision: c.revision, ...fields },
      ],
    }
    expect((await app.fetch(req('/suggestions', 'POST', payload))).status).toBe(
      200,
    )
    expect((await app.fetch(req('/suggestions', 'POST', payload))).status).toBe(
      409,
    )
    const after: any = await (await app.fetch(req(''))).json()
    expect(after.candidates[0].classificationReviewed).toBe(false)
  })
  it('rejects stale classification CAS before changing candidate data', async () => {
    await ingest()
    const status: any = await (await app.fetch(req(''))).json()
    const c = status.candidates[0]
    const payload = {
      revision: c.revision,
      suggestion: {
        ...c.suggestion,
        vocal_status: 'vocal',
        tabs: ['focus'],
        uncertainties: [],
      },
      reviewed: true,
    }
    expect((await app.fetch(req('/' + c.id, 'PATCH', payload))).status).toBe(
      200,
    )
    expect((await app.fetch(req('/' + c.id, 'PATCH', payload))).status).toBe(
      409,
    )
  })
})

describe('discovery inbox pagination', () => {
  it('keeps every candidate reachable across pages and by exact GET', async () => {
    await ingest()
    const template = ((await (await app.fetch(req(''))).json()) as any)
      .candidates[0]
    await fixture.db.batch(
      Array.from({ length: 202 }, (_, i) =>
        fixture.db
          .prepare(
            'INSERT INTO catalogue_discovery_candidates(candidate_id,video_id,track_id,discovery_json,suggestion_json,created_at,updated_at)VALUES(?,?,?,?,?,?,?)',
          )
          .bind(
            'hoyo-' + String(i).padStart(32, '0'),
            'video-' + i,
            'hoyo-' + i,
            JSON.stringify(template.discovery),
            JSON.stringify(template.suggestion),
            now - i - 1,
            now - i - 1,
          ),
      ),
    )
    let path = ''
    const ids = new Set<string>()
    do {
      const response: any = await (await app.fetch(req(path))).json()
      response.candidates.forEach((c: any) => ids.add(c.id))
      path = response.nextCursor
        ? '?cursor=' + encodeURIComponent(response.nextCursor)
        : ''
    } while (path)
    expect(ids.size).toBe(203)
    const oldest = 'hoyo-' + String(201).padStart(32, '0')
    expect((await app.fetch(req('/' + oldest))).status).toBe(200)
  })
})


describe('manual stage LX policy', () => {
  const policies = [
    { policy: 'child disabled after check', parent: true, child: false, configured: true, allowed: false },
    { policy: 'parent disabled', parent: false, child: true, configured: true, allowed: false },
    { policy: 'both enabled', parent: true, child: true, configured: true, allowed: true },
    { policy: 'missing deployment key', parent: true, child: true, configured: false, allowed: false },
  ]
  it.each(['lx-huibq', 'lx-ikun'].flatMap((provider) => policies.map((policy) => ({ provider, ...policy }))))(
    '$provider with $policy enforces current policy after a fresh source check',
    async ({ provider, parent, child, configured, allowed }) => {
      env.LX_HUIBQ_API_BASE_URL = 'https://lx.fixture.example'
      env.LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES = 'media.fixture.example'
      env.LX_HUIBQ_REQUEST_KEY = 'fixture-only'
      env.LX_IKUN_API_BASE_URL = 'https://lx.fixture.example'
      env.LX_IKUN_MEDIA_ALLOWED_HOSTNAMES = 'media.fixture.example'
      env.LX_IKUN_REQUEST_KEY = 'fixture-only'
      await fixture.db.prepare("UPDATE provider_health SET enabled=1 WHERE provider_key IN ('lx', ?)").bind(provider).run()
      await ingest()
      const status: any = await (await app.fetch(req(''))).json()
      let c = status.candidates[0]
      c = await updateCandidate(fixture.db, {
        ...c,
        classificationReviewed: true,
        suggestion: { ...c.suggestion, vocal_status: 'vocal', tabs: ['focus'], uncertainties: [] },
        sources: [{ provider, externalId: 'wy:9876543210:320k', status: 'valid', reason: 'resolver_audio_probe', checkedAt: now - 1000, confidence: 0.95 }],
      }, c.revision, now)
      // The recorded successful check remains fresh when Admin changes the policy.
      await fixture.db.prepare("UPDATE provider_health SET enabled=? WHERE provider_key='lx'").bind(parent ? 1 : 0).run()
      await fixture.db.prepare('UPDATE provider_health SET enabled=? WHERE provider_key=?').bind(child ? 1 : 0, provider).run()
      if (!configured) delete env[provider === 'lx-huibq' ? 'LX_HUIBQ_REQUEST_KEY' : 'LX_IKUN_REQUEST_KEY']
      const before = structuredClone(book)
      const response = await app.fetch(req('/' + c.id + '/stage', 'POST', { revision: c.revision, expectedCatalogueRevision: 1 }))
      if (allowed) {
        expect(response.status).toBe(200)
        expect((await response.json() as any).stageState).toBe('staged')
        expect(append).toHaveBeenCalledTimes(1)
        expect(book.Sources.filter((row) => row[1] === c.trackId)).toEqual([
          expect.arrayContaining([c.trackId, provider, 'wy:9876543210:320k']),
        ])
      } else {
        expect.soft(response.status).toBe(409)
        expect.soft(await response.json()).toEqual({ error: 'runtime_source_required' })
        expect.soft(append).not.toHaveBeenCalled()
        expect.soft(book).toEqual(before)
        expect(await readCandidate(fixture.db, c.id)).toEqual(c)
        expect(await fixture.db.prepare('SELECT count(*) AS n FROM catalogue_discovery_sheet_operations').first('n')).toBe(0)
      }
      expect((await readCatalogueSnapshot(fixture.db)).revision).toBe(1)
    },
  )
})

describe('source-check decimal ownership', () => {
  it.each([
    ['09876543210', ['source_owned_by:demo-zzz-study']],
    ['9876543210', ['source_owned_by:demo-zzz-study']],
    ['9876543211', []],
  ])('checks published ownership for GD NetEase %s', async (externalId, expectedConflicts) => {
    await fixture.db.prepare("INSERT INTO catalogue_sources (source_row_id,track_id,provider,external_id,created_at,updated_at) VALUES('existing-chksz','demo-zzz-study','chksz','9876543210',1,1)").run()
    const upstream = discoveryUpstream()
    app = createCatalogueAdminHandler(env, {
      now: () => now,
      discovery: {
        cache: discoveryCache(),
        fetch: async (input, init) => {
          const response = await upstream(input, init)
          const url = new URL(input instanceof Request ? input.url : String(input))
          if (url.hostname === 'music.163.com' && url.pathname === '/api/search/get')
            return new Response(null, { status: 503 })
          if (url.hostname === 'music-api.gdstudio.xyz' && url.searchParams.get('types') === 'search') {
            const value = await response.json() as any
            value[0].id = externalId
            return Response.json(value)
          }
          return response
        },
      },
    })
    await ingest()
    const status: any = await (await app.fetch(req(''))).json()
    const c = status.candidates[0]
    const response = await app.fetch(req('/' + c.id + '/check', 'POST', { revision: c.revision }))
    expect(response.status).toBe(200)
    const checked = await response.json() as any
    expect(checked.sources).toContainEqual(expect.objectContaining({ provider: 'gd-studio', externalId: 'netease:' + externalId, status: 'valid' }))
    expect(checked.conflicts).toEqual(expectedConflicts)
    expect(append).not.toHaveBeenCalled()
  })
})
