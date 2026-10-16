import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import {
  readPublishedCatalogue,
  readCatalogueSnapshot,
  projectCatalogue,
} from '../catalogue/repository'
import { cataloguePublicResponse } from '../catalogue/publicRoutes'
import app from '../index'
import { parseCatalog } from '../../src/features/catalog/schema'
import { readFileSync } from 'node:fs'
import type { Track } from '../../src/features/catalog/types'
const seed = JSON.parse(
  readFileSync('workers/test/catalogue-seed.json', 'utf8'),
) as Track[]
describe('public D1 catalogue', () => {
  let fixture: Awaited<ReturnType<typeof catalogueDatabase>>
  beforeAll(async () => {
    fixture = await catalogueDatabase()
  })
  afterAll(async () => {
    await fixture?.dispose()
  })
  it('reconstructs exact seed from bounded batch queries', async () => {
    const result = await readPublishedCatalogue(fixture.db)
    expect(result.revision).toBe('1')
    // The original migration intentionally seeds unclassified modes. Bundled
    // fallback modes can later be explicitly classified without rewriting it.
    expect(parseCatalog(result.tracks)).toEqual(
      seed.map((track) => ({ ...track, tabs: [] })).sort((a, b) => a.id.localeCompare(b.id)),
    )
  })
  it('never exposes private fields and applies API security/cache headers', async () => {
    await fixture.db
      .prepare(
        "UPDATE catalogue_tracks SET notes='private-note',evidence='internal-evidence',metadata_confidence=0.9",
      )
      .run()
    const response = await app.fetch(new Request('https://study.example/api/catalogue'), {
      DB: fixture.db,
    } as any)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('public')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    const text = await response.text()
    expect(text).not.toMatch(/private-note|internal-evidence|confidence|created_by|decision/)
  })
  it('rejects mutations without reading the database', async () => {
    const response = await cataloguePublicResponse(
      new Request('https://study.example/api/catalogue', { method: 'POST' }),
      {} as any,
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
  })
  it('omits malformed/private source metadata without crashing', async () => {
    await fixture.db
      .prepare('UPDATE catalogue_sources SET metadata_json=? WHERE track_id=?')
      .bind(JSON.stringify({ contentType: 'audio/mpeg', secret: 'never-public' }), seed[0].id)
      .run()
    let result = await readPublishedCatalogue(fixture.db)
    expect(JSON.stringify(result.tracks)).not.toContain('never-public')
    await fixture.db
      .prepare("UPDATE catalogue_sources SET metadata_json='broken' WHERE track_id=?")
      .bind(seed[0].id)
      .run()
    result = await readPublishedCatalogue(fixture.db)
    expect(result.tracks).toHaveLength(3)
  })
  it('refuses a published projection larger than the browser safety bound', async () => {
    const snapshot = await readCatalogueSnapshot(fixture.db)
    snapshot.aliases = Array.from({ length: 25000 }, (_, index) => ({
      track_id: seed[1].id,
      locale: 'en',
      alias: 'x'.repeat(500) + index,
    }))
    expect(() => projectCatalogue(snapshot)).toThrow('catalogue_unavailable')
  })
  it('returns bounded non-sensitive failure with no-store when D1 is unavailable', async () => {
    const response = await cataloguePublicResponse(
      new Request('https://study.example/api/catalogue'),
      {
        batch: () => {
          throw new Error('credentials must not leak')
        },
      } as any,
    )
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).not.toContain('credentials')
  })

  it('projects the stored album so the Music Library can group by release', async () => {
    await fixture.db
      .prepare('UPDATE catalogue_tracks SET album=? WHERE track_id=?')
      .bind('INSIDE - EP', seed[2].id)
      .run()

    const result = await readPublishedCatalogue(fixture.db)

    expect(result.tracks.find((track) => track.id === seed[2].id)?.album).toBe('INSIDE - EP')
    // The other rows still have a NULL album, and must come back with no album key at all
    // rather than a null one — the client groups on presence, not on truthiness.
    expect(Object.hasOwn(result.tracks.find((track) => track.id === seed[0].id)!, 'album')).toBe(false)
  })
})
