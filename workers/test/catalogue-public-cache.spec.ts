// Wave E exploration (task 17, H-03 / design Property 5). Encodes the expected behaviour, so it
// FAILS on the unfixed tree, which re-runs the full six-query catalogue read on every GET and
// emits no ETag (so a conditional GET can never be answered with 304).
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readPublishedCatalogue } from '../catalogue/repository'
import app from '../index'
import { catalogueDatabase } from './catalogue-fixture'

type Fixture = Awaited<ReturnType<typeof catalogueDatabase>>
type Database = Fixture['db']

let fixture: Fixture
const prepared: string[] = []

/** Forwards to the real binding and records every statement the route prepares. */
const countingProxy = (db: Database): Database => new Proxy(db, {
  get(target, property, receiver) {
    if (property === 'prepare') {
      return (sql: string) => {
        prepared.push(sql)
        return target.prepare(sql)
      }
    }
    const value = Reflect.get(target, property, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

const fullReads = () => prepared.filter((sql) => /FROM\s+catalogue_tracks\b/iu.test(sql)).length
const selects = () => prepared.filter((sql) => /^\s*SELECT\b/iu.test(sql)).length

const get = async (headers: Record<string, string> = {}) => {
  const pending: Promise<unknown>[] = []
  // Called with the (env, ctx) shape the fixed entry point takes (design Shared Infrastructure 3).
  const response = await (app.fetch as (...args: unknown[]) => Promise<Response>)(
    new Request('https://study.example/api/catalogue', { headers }),
    { DB: countingProxy(fixture.db) },
    { waitUntil: (promise: Promise<unknown>) => { pending.push(promise) }, passThroughOnException: () => {} },
  )
  const body = await response.text()
  await Promise.allSettled(pending)
  return { status: response.status, etag: response.headers.get('etag'), body }
}

const fresh = async () => JSON.stringify(await readPublishedCatalogue(fixture.db))
const isStrongEtag = (value: string | null) => value !== null && /^"[!#-~]+"$/u.test(value)

beforeAll(async () => {
  fixture = await catalogueDatabase()
})

afterAll(async () => {
  await fixture?.dispose()
})

describe('public catalogue is served from a revision-keyed cache (Property 5)', () => {
  it('runs at most one full read for two GETs at one revision and answers a matching conditional GET with 304', async () => {
    // A revision no other test has used, so nothing is memoised for it yet.
    await fixture.db.prepare('UPDATE catalogue_state SET revision = revision + 1 WHERE id = 1').run()
    prepared.length = 0
    const first = await get()
    const second = await get()
    // Counted for the two plain GETs only, before the conditional request.
    const twoGetFullReads = fullReads()
    const twoGetSelects = selects()
    const conditional = await get({ 'if-none-match': first.etag ?? '"missing-etag"' })
    const expected = await fresh()
    expect({
      fullReads: twoGetFullReads,
      selects: twoGetSelects,
      firstStatus: first.status,
      secondStatus: second.status,
      bodiesEqualFreshProjection: first.body === expected && second.body === expected,
      strongEtag: isStrongEtag(first.etag),
      stableEtag: first.etag !== null && first.etag === second.etag,
      conditionalStatus: conditional.status,
      conditionalBody: conditional.body,
    }).toEqual({
      fullReads: 1,
      selects: expect.any(Number),
      firstStatus: 200,
      secondStatus: 200,
      bodiesEqualFreshProjection: true,
      strongEtag: true,
      stableEtag: true,
      conditionalStatus: 304,
      conditionalBody: '',
    })
  })

  it('for any sequence of GETs, conditional GETs and publishes: fresh bodies, stable strong ETags, 304s and at most one full read per revision', async () => {
    type Operation = 'get' | 'conditional' | 'publish'
    const readsPerRevision = new Map<string, number>()
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom<Operation>('get', 'conditional', 'publish'), { minLength: 2, maxLength: 8 }), async (operations) => {
        const etags = new Map<string, string>()
        for (const operation of operations) {
          if (operation === 'publish') {
            await fixture.db.prepare('UPDATE catalogue_state SET revision = revision + 1 WHERE id = 1').run()
            continue
          }
          const expected = await fresh()
          const revision = (JSON.parse(expected) as { revision: string }).revision
          const before = fullReads()
          if (operation === 'conditional' && etags.has(revision)) {
            const response = await get({ 'if-none-match': etags.get(revision)! })
            expect(response.status).toBe(304)
            expect(response.body).toBe('')
            expect(response.etag).toBe(etags.get(revision))
          } else {
            const response = await get()
            expect(response.status).toBe(200)
            expect(response.body).toBe(expected)
            expect(isStrongEtag(response.etag), `ETag ${String(response.etag)}`).toBe(true)
            if (etags.has(revision)) expect(response.etag).toBe(etags.get(revision))
            etags.set(revision, response.etag!)
          }
          readsPerRevision.set(revision, (readsPerRevision.get(revision) ?? 0) + fullReads() - before)
          expect(readsPerRevision.get(revision), `full reads at revision ${revision}`).toBeLessThanOrEqual(1)
        }
      }),
      { numRuns: 20, endOnFailure: true },
    )
  })
})
