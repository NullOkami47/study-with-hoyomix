import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import { createAuthHandler } from '../auth/routes'
import { createCatalogueAdminHandler, type CatalogueEnv } from '../catalogue/adminRoutes'
import { projectCatalogue, readCatalogueSnapshot } from '../catalogue/repository'

/**
 * Covers the direct catalogue browser/editor API. The workbook proposal pipeline is covered by
 * `catalogue-admin.spec.ts`; these endpoints are what lets an admin actually see and correct the
 * published catalogue rather than only reviewing Sheet deltas.
 */
const origin = 'https://study.example',
  now = 1788739200000
let fixture: Awaited<ReturnType<typeof catalogueDatabase>>, env: CatalogueEnv, cookie: string
const sheets = { read: vi.fn(), write: vi.fn(async () => {}) }

beforeEach(async () => {
  fixture = await catalogueDatabase()
  env = {
    DB: fixture.db,
    PUBLIC_ORIGIN: origin,
    SESSION_HMAC_SECRET: 'catalogue-test-session-secret-long-enough',
    OAUTH_STATE_SECRET: 'test',
    GOOGLE_CLIENT_ID: 'test',
    GOOGLE_CLIENT_SECRET: 'test',
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
  }
  await fixture.db
    .prepare("INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES('admin','Admin','admin',1,1)")
    .run()
  cookie = '__Host-session=' + (await createAuthHandler(env, { now: () => now }).issueSession('admin')).token
})
afterEach(async () => {
  await fixture?.dispose()
})
function request(path: string, method = 'GET', body?: unknown, withCookie: boolean | string = true) {
  const requestCookie = typeof withCookie === 'string' ? withCookie : withCookie ? cookie : undefined
  return new Request(origin + '/api/admin/catalogue' + path, {
    method,
    headers: {
      origin,
      'content-type': 'application/json',
      ...(requestCookie ? { cookie: requestCookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
const handler = () => createCatalogueAdminHandler(env, { now: () => now, sheets })

const trackRow = (id: string) =>
  fixture.db
    .prepare('SELECT focus,sleep,chill,vocal_status,title,needs_classification FROM catalogue_tracks WHERE track_id=?')
    .bind(id)
    .first<{ focus: number; sleep: number; chill: number; vocal_status: string; title: string; needs_classification: number }>()

const revision = () =>
  fixture.db.prepare('SELECT revision FROM catalogue_state WHERE id=1').first<number>('revision')

describe('admin catalogue track browser', () => {
  it('requires an authenticated admin before reading or writing anything', async () => {
    expect((await handler().fetch(request('/tracks', 'GET', undefined, false))).status).toBe(401)
    expect(
      (await handler().fetch(request('/tracks/demo-zzz-study', 'GET', undefined, false))).status,
    ).toBe(401)
    expect(
      (
        await handler().fetch(
          request('/tracks/demo-zzz-study', 'PATCH', { changes: { title: 'x' }, expectedRevision: 1 }, false),
        )
      ).status,
    ).toBe(401)
    expect(await trackRow('demo-zzz-study')).toMatchObject({ title: 'Demo ZZZ Study' })
  })

  it('rejects a mutation whose origin is not the public origin', async () => {
    const response = await handler().fetch(
      new Request(origin + '/api/admin/catalogue/tracks/demo-zzz-study', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ changes: { title: 'x' }, expectedRevision: 1 }),
      }),
    )
    expect(response.status).toBe(403)
    expect(await trackRow('demo-zzz-study')).toMatchObject({ title: 'Demo ZZZ Study' })
  })

  it('lists the whole catalogue with games, tabs, albums and the current revision', async () => {
    const response = await handler().fetch(request('/tracks'))
    expect(response.status).toBe(200)
    const index = (await response.json()) as {
      revision: number
      albums: string[]
      tracks: { id: string; games: string[]; tabs: string[]; vocalStatus: string }[]
    }
    expect(index.revision).toBe(1)
    expect(index.tracks.map((t) => t.id).sort()).toEqual([
      'demo-genshin-study',
      'demo-hsr-study',
      'demo-zzz-study',
    ])
    expect(index.tracks.find((t) => t.id === 'demo-zzz-study')?.games).toEqual(['zzz'])
    expect(index.tracks.every((t) => t.vocalStatus === 'uncertain')).toBe(true)
  })

  it('returns a single track detail and 404s an unknown track', async () => {
    const response = await handler().fetch(request('/tracks/demo-zzz-study'))
    expect(response.status).toBe(200)
    const detail = (await response.json()) as {
      id: string
      title: string
      tabs: string[]
      sources: { provider: string }[]
      aliases: Record<string, string[]>
    }
    expect(detail).toMatchObject({ id: 'demo-zzz-study', title: 'Demo ZZZ Study', tabs: [] })
    expect(detail.sources.map((s) => s.provider)).toEqual(['r2'])
    expect(detail.aliases).toEqual({})
    expect((await handler().fetch(request('/tracks/not-a-track'))).status).toBe(404)
  })

  it('accepts focus=true with vocal_status=vocal and persists it to D1 and the public catalogue', async () => {
    // Regression guard for the removed `catalog_focus_requires_instrumental` coupling. 389
    // published rows are exactly this shape, so the admin must be able to save it.
    const response = await handler().fetch(
      request('/tracks/demo-zzz-study', 'PATCH', {
        changes: { focus: true, vocal_status: 'vocal' },
        expectedRevision: 1,
      }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      revision: number
      track: { tabs: string[]; vocalStatus: string }
    }
    expect(body.revision).toBe(2)
    expect(body.track.tabs).toEqual(['focus'])
    expect(body.track.vocalStatus).toBe('vocal')

    expect(await trackRow('demo-zzz-study')).toMatchObject({ focus: 1, vocal_status: 'vocal' })
    expect(await revision()).toBe(2)

    // The public projection must still serve the edited catalogue.
    const published = projectCatalogue(await readCatalogueSnapshot(fixture.db))
    const edited = published.tracks.find((t) => t.id === 'demo-zzz-study')
    expect(edited?.tabs).toEqual(['focus'])
    expect(edited?.vocalStatus).toBe('vocal')
  })

  it('still rejects malformed or out-of-contract edits', async () => {
    const cases: Record<string, unknown>[] = [
      { focus: 'yes' },
      { focus: 2 },
      { vocal_status: 'lyrical' },
      { title: '' },
      { title: 'x'.repeat(501) },
      { work_group_id: 'Not Canonical' },
      { release_date: '2026-02-31' },
      { metadata_confidence: 2 },
      { track_id: 'another-track' },
      { unexpected: 'injected' },
    ]
    for (const changes of cases) {
      const response = await handler().fetch(
        request('/tracks/demo-zzz-study', 'PATCH', { changes, expectedRevision: 1 }),
      )
      expect(response.status, JSON.stringify(changes)).toBe(400)
    }
    expect(await revision()).toBe(1)
    expect(await trackRow('demo-zzz-study')).toMatchObject({
      focus: 0,
      vocal_status: 'uncertain',
      title: 'Demo ZZZ Study',
    })
  })

  it('rejects a stale revision without mutating anything', async () => {
    const response = await handler().fetch(
      request('/tracks/demo-zzz-study', 'PATCH', {
        changes: { title: 'Should not apply' },
        expectedRevision: 99,
      }),
    )
    expect(response.status).toBe(409)
    expect(await trackRow('demo-zzz-study')).toMatchObject({ title: 'Demo ZZZ Study' })
    expect(await revision()).toBe(1)
  })

  it('records an audit entry for every accepted edit', async () => {
    await handler().fetch(
      request('/tracks/demo-zzz-study', 'PATCH', {
        changes: { title: 'Renamed' },
        expectedRevision: 1,
      }),
    )
    const audit = await fixture.db
      .prepare("SELECT actor_user_id,target_key,detail_json FROM admin_audit_log WHERE action='catalogue.track.update'")
      .first<{ actor_user_id: string; target_key: string; detail_json: string }>()
    expect(audit).toMatchObject({ actor_user_id: 'admin', target_key: 'demo-zzz-study' })
    expect(JSON.parse(audit!.detail_json)).toEqual({ changes: { title: 'Renamed' } })
  })

  it('rolls the whole edit back when the audit insert fails', async () => {
    await fixture.db
      .prepare(
        "CREATE TRIGGER fail_track_audit BEFORE INSERT ON admin_audit_log WHEN NEW.action='catalogue.track.update' BEGIN SELECT RAISE(ABORT, 'audit failed'); END",
      )
      .run()
    const response = await handler().fetch(
      request('/tracks/demo-zzz-study', 'PATCH', {
        changes: { title: 'Must roll back' },
        expectedRevision: 1,
      }),
    )
    expect(response.status).toBe(409)
    expect(await trackRow('demo-zzz-study')).toMatchObject({ title: 'Demo ZZZ Study' })
    expect(await revision()).toBe(1)
  })

  it('rejects malformed request envelopes', async () => {
    const cases: unknown[] = [
      { changes: { title: 'x' } },
      { changes: { title: 'x' }, expectedRevision: 0 },
      { changes: { title: 'x' }, expectedRevision: 1, extra: true },
      { changes: [], expectedRevision: 1 },
      { changes: {}, expectedRevision: 1 },
    ]
    for (const body of cases) {
      const response = await handler().fetch(request('/tracks/demo-zzz-study', 'PATCH', body))
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
  })
})
