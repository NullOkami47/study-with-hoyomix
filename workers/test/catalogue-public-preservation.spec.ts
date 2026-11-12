// Wave E preservation (task 18, design Property 2 and the Property 5 body-equality clause,
// requirement 3.4). Observation-first: every expectation below was observed on the unfixed tree
// (ee34b3b) and must still hold after H-03 adds the revision-keyed cache, the strong ETag and 304.
//
// Every catalogue change below is published the way production publishes one: together with a
// revision bump. A change without a bump is not a supported publication, so it is not generated.
// Not asserted, because H-03 changes them on purpose: ETag/304 behaviour and how many reads run.
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readPublishedCatalogue } from '../catalogue/repository'
import app from '../index'
import { catalogueDatabase } from './catalogue-fixture'

type Fixture = Awaited<ReturnType<typeof catalogueDatabase>>

const ALLOWED_METADATA_KEYS = ['contentType', 'rightsStatus', 'ownerMappingConfirmedAt', 'server', 'type', 'quality', 'bitrate']
const PRIVATE_METADATA_KEYS = ['secret', 'apiKey', 'notes', 'evidence', 'internalUrl']
const TEN_MIB = 10 * 1024 * 1024

let fixture: Fixture
let sources: { source_row_id: string; track_id: string; provider: string; external_id: string }[] = []
let trackIds: string[] = []

// Called with the (env, ctx) shape the fixed entry point takes (design Shared Infrastructure 3).
const get = async (db: unknown = fixture.db) => {
  const pending: Promise<unknown>[] = []
  const response = await (app.fetch as (...args: unknown[]) => Promise<Response>)(
    new Request('https://study.example/api/catalogue'),
    { DB: db },
    { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) }, passThroughOnException: () => {} },
  )
  const body = await response.text()
  await Promise.allSettled(pending)
  return { response, body }
}

const publish = () => fixture.db.prepare('UPDATE catalogue_state SET revision = revision + 1 WHERE id = 1').run()
const revision = async () => (await fixture.db.prepare('SELECT revision FROM catalogue_state WHERE id = 1').first<{ revision: number }>())!.revision

/** What the route must serve for the current revision: the fresh projection, or 503 when it fails. */
const oracle = async (): Promise<{ ok: true; body: string } | { ok: false }> => {
  try {
    return { ok: true, body: JSON.stringify(await readPublishedCatalogue(fixture.db)) }
  } catch {
    return { ok: false }
  }
}

const expectUnavailable = async ({ response, body }: Awaited<ReturnType<typeof get>>) => {
  expect(response.status).toBe(503)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(JSON.parse(body)).toEqual({ error: 'catalogue_unavailable' })
}

beforeAll(async () => {
  fixture = await catalogueDatabase()
  sources = (await fixture.db.prepare('SELECT source_row_id, track_id, provider, external_id FROM catalogue_sources ORDER BY track_id, provider').all<typeof sources[number]>()).results
  trackIds = (await fixture.db.prepare('SELECT track_id FROM catalogue_tracks ORDER BY track_id').all<{ track_id: string }>()).results.map((row: { track_id: string }) => row.track_id)
})

afterAll(async () => {
  await fixture?.dispose()
})

describe('public catalogue contract is unchanged (requirement 3.4)', () => {
  const metadataValue = fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.constant('x'.repeat(513)),
    fc.integer().map((value) => value as unknown),
    fc.constant(null as unknown),
  )
  const metadata = fc.oneof(
    fc.dictionary(fc.constantFrom(...ALLOWED_METADATA_KEYS, ...PRIVATE_METADATA_KEYS), metadataValue, { maxKeys: 6 })
      .map((value) => JSON.stringify(value)),
    fc.constantFrom('broken', '[]', 'null', '{}'),
  )

  it('serves exactly JSON.stringify(readPublishedCatalogue(db)) with { revision, tracks }, active sources and allow-listed metadata only, or 503 catalogue_unavailable', async () => {
    let served = 0
    let unavailable = 0
    await fc.assert(
      fc.asyncProperty(
        // Mostly active, so both a publishable catalogue and one with a source-less track come up.
        fc.array(fc.record({ active: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }), metadata }), { minLength: sources.length, maxLength: sources.length }),
        fc.array(fc.option(fc.string({ minLength: 0, maxLength: 30 }), { nil: null }), { minLength: trackIds.length, maxLength: trackIds.length }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: trackIds.length - 1 }), fc.constantFrom('en', 'zh-Hans', 'ja'), fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,20}$/u)), { maxLength: 4 }),
        async (sourceStates, albums, aliases) => {
          // One publication: the generated catalogue state plus a revision bump.
          const statements = [
            ...sources.map((source, index) => fixture.db.prepare('UPDATE catalogue_sources SET source_status = ?, metadata_json = ? WHERE source_row_id = ?')
              .bind(sourceStates[index].active ? 'active' : 'disabled', sourceStates[index].metadata, source.source_row_id)),
            ...trackIds.map((id, index) => fixture.db.prepare('UPDATE catalogue_tracks SET album = ? WHERE track_id = ?').bind(albums[index], id)),
            fixture.db.prepare("DELETE FROM catalogue_aliases WHERE alias LIKE 'gen:%'"),
            ...aliases.map(([track, locale, alias]) => fixture.db.prepare('INSERT OR IGNORE INTO catalogue_aliases (track_id, locale, alias) VALUES (?, ?, ?)')
              .bind(trackIds[track], locale, `gen:${alias}`)),
            fixture.db.prepare('UPDATE catalogue_state SET revision = revision + 1 WHERE id = 1'),
          ]
          await fixture.db.batch(statements)
          const current = await revision()

          const served1 = await get()
          const expected = await oracle()
          if (!expected.ok) {
            unavailable++
            await expectUnavailable(served1)
            return
          }
          served++
          const { response, body } = served1
          expect(response.status).toBe(200)
          expect(response.headers.get('content-type')).toContain('application/json')
          expect(response.headers.get('cache-control')).toContain('public')
          expect(response.headers.get('x-content-type-options')).toBe('nosniff')
          expect(body).toBe(expected.body)
          const parsed = JSON.parse(body) as { revision: string; tracks: { id: string; sources: { provider: string; externalId: string; metadata: Record<string, unknown> }[] }[] }
          expect(Object.keys(parsed)).toEqual(['revision', 'tracks'])
          expect(parsed.revision).toBe(String(current))
          for (const track of parsed.tracks) {
            const active = sources.filter((source, index) => source.track_id === track.id && sourceStates[index].active)
            expect(track.sources.map(({ provider, externalId }) => ({ provider, externalId })))
              .toEqual(active.map(({ provider, external_id }) => ({ provider, externalId: external_id })))
            for (const source of track.sources) {
              for (const [key, value] of Object.entries(source.metadata)) {
                expect(ALLOWED_METADATA_KEYS).toContain(key)
                expect(typeof value).toBe('string')
                expect((value as string).length).toBeLessThanOrEqual(512)
              }
            }
          }
          expect(body).not.toMatch(/never-public|internalUrl|apiKey/u)
          expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(TEN_MIB)
          // A second read of the same revision serves the same bytes.
          const again = await get()
          expect(again.response.status).toBe(200)
          expect(again.body).toBe(body)
        },
      ),
      { numRuns: 30, endOnFailure: true },
    )
    // Both outcomes of the contract were exercised (a track with no active source is unpublishable).
    expect(served).toBeGreaterThan(0)
    expect(unavailable).toBeGreaterThan(0)
  })

  it('refuses a projection over 10 MiB with 503 and serves the catalogue again once a smaller one is published', async () => {
    await fixture.db.batch([
      fixture.db.prepare("UPDATE catalogue_sources SET source_status = 'active', metadata_json = '{}'"),
      fixture.db.prepare("DELETE FROM catalogue_aliases WHERE alias LIKE 'gen:%'"),
    ])
    const chunk = 'y'.repeat(512 * 1024)
    const statements = Array.from({ length: 21 }, (_, index) =>
      fixture.db.prepare('INSERT INTO catalogue_aliases (track_id, locale, alias) VALUES (?, ?, ?)').bind(trackIds[index % trackIds.length], 'en', `big:${index}:${chunk}`))
    await fixture.db.batch([...statements, fixture.db.prepare('UPDATE catalogue_state SET revision = revision + 1 WHERE id = 1')])
    expect((await oracle()).ok).toBe(false)
    await expectUnavailable(await get())

    await fixture.db.batch([fixture.db.prepare("DELETE FROM catalogue_aliases WHERE alias LIKE 'big:%'"), fixture.db.prepare('UPDATE catalogue_state SET revision = revision + 1 WHERE id = 1')])
    const expected = await oracle()
    expect(expected.ok).toBe(true)
    const { response, body } = await get()
    expect(response.status).toBe(200)
    expect(body).toBe((expected as { body: string }).body)
  })

  it('answers 503 no-store without leaking the error when D1 fails, and never serves that failure afterwards', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('batch-throws', 'batch-rejects', 'batch-unsuccessful', 'batch-short'), async (failure) => {
        // A revision nothing has been served for yet, so the failing read is the first one.
        await publish()
        const broken = new Proxy(fixture.db, {
          get(target, property, receiver) {
            if (property === 'batch') {
              return async (statements: unknown[]) => {
                if (failure === 'batch-throws') throw new Error('credentials-must-not-leak')
                if (failure === 'batch-rejects') return Promise.reject(new Error('credentials-must-not-leak'))
                const results = await target.batch(statements as never)
                if (failure === 'batch-unsuccessful') return results.map((result: Record<string, unknown>) => ({ ...result, success: false }))
                return results.slice(0, 3)
              }
            }
            const value = Reflect.get(target, property, receiver)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        const failed = await get(broken)
        await expectUnavailable(failed)
        expect(failed.body).not.toContain('credentials')
        // The same revision, now readable: the earlier failure is not what gets served.
        const expected = await oracle()
        expect(expected.ok).toBe(true)
        const healthy = await get()
        expect(healthy.response.status).toBe(200)
        expect(healthy.body).toBe((expected as { body: string }).body)
      }),
      { numRuns: 8, endOnFailure: true },
    )
  })

  it('still refuses every non-GET method with 405 and Allow: GET', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await (app.fetch as (...args: unknown[]) => Promise<Response>)(
        new Request('https://study.example/api/catalogue', { method, headers: { origin: 'https://study.example' } }),
        { DB: fixture.db },
        { waitUntil: () => {}, passThroughOnException: () => {} },
      )
      expect(response.status, method).toBe(405)
      expect(response.headers.get('allow')).toBe('GET')
    }
  })
})
