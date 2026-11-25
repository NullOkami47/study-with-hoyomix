// Wave E exploration (task 17, H-03 / design Property 5). Encodes the expected behaviour, so it
// FAILS on the unfixed tree, which re-runs the full six-query catalogue read on every GET and
// emits no ETag (so a conditional GET can never be answered with 304).
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { readPublishedCatalogue } from '../catalogue/repository'
import app from '../index'
import { catalogueDatabase } from './catalogue-fixture'

type Fixture = Awaited<ReturnType<typeof catalogueDatabase>>
type Database = Fixture['db']

let fixture: Fixture
const prepared: string[] = []

/** Forwards to the real binding and records every statement the route prepares. */
const countingProxy = (db: Database, statements = prepared): Database => new Proxy(db, {
  get(target, property, receiver) {
    if (property === 'prepare') {
      return (sql: string) => {
        statements.push(sql)
        return target.prepare(sql)
      }
    }
    const value = Reflect.get(target, property, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  },
})

describe('public catalogue cache origin isolation', () => {
  let other: Fixture
  beforeAll(async () => {
    other = await catalogueDatabase()
    await other.db.prepare("UPDATE catalogue_tracks SET title = 'Other catalogue'").run()
  })
  afterAll(async () => { await other?.dispose() })
  beforeEach(async () => {
    vi.resetModules()
    await fixture.db.prepare('UPDATE catalogue_state SET revision = 11 WHERE id = 1').run()
    await other.db.prepare('UPDATE catalogue_state SET revision = 11 WHERE id = 1').run()
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const request = (origin: string, headers: Record<string, string> = {}) =>
    new Request(`${origin}/api/catalogue`, { headers })
  const projection = async (db: Database) => JSON.stringify(await readPublishedCatalogue(db))
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    return { promise, resolve }
  }

  it('isolates two real databases at revision 11 and keeps same-origin memo and 304', async () => {
    const { cataloguePublicResponse: route } = await import('../catalogue/publicRoutes')
    const expected = [await projection(fixture.db), await projection(other.db)]
    expect(expected[0]).not.toBe(expected[1])
    for (const [index, db] of [fixture.db, other.db].entries()) {
      const statements: string[] = []
      const counted = countingProxy(db, statements)
      const origin = `https://catalogue-${index}.example`
      const first = await route(request(origin), counted)
      const etag = first.headers.get('etag')!
      expect(await first.text()).toBe(expected[index])
      expect(await (await route(request(origin), counted)).text()).toBe(expected[index])
      const conditional = await route(request(origin, { 'if-none-match': etag }), counted)
      expect(conditional.status).toBe(304)
      expect(await conditional.text()).toBe('')
      expect(statements.filter((sql) => /FROM\s+catalogue_tracks\b/iu.test(sql))).toHaveLength(1)
    }
  })

  it('ignores poisoned v1 entries and shares only origin-scoped v2 edge entries across cold modules', async () => {
    const entries = new Map<string, Response>([
      ['https://catalogue.internal/v1/11', new Response(await projection(other.db), {
        headers: { etag: '"fixture-poison"' },
      })],
    ])
    const match = vi.fn(async (key: string) => entries.get(key)?.clone())
    const put = vi.fn(async (key: string, response: Response) => {
      entries.set(key, response.clone())
    })
    vi.stubGlobal('caches', { default: { match, put } })
    const origins = ['https://production.example', 'https://rehearsal.example:8443']
    for (const [index, db] of [fixture.db, other.db].entries()) {
      vi.resetModules()
      const { cataloguePublicResponse: route } = await import('../catalogue/publicRoutes')
      expect(await (await route(request(origins[index]), db)).text()).toBe(await projection(db))
      expect(entries.has(`https://catalogue.internal/v2/${encodeURIComponent(origins[index])}/11`)).toBe(true)
    }
    vi.resetModules()
    const { cataloguePublicResponse: coldRoute } = await import('../catalogue/publicRoutes')
    const statements: string[] = []
    expect(await (await coldRoute(request(origins[0]), countingProxy(fixture.db, statements))).text())
      .toBe(await projection(fixture.db))
    expect(statements.filter((sql) => /FROM\s+catalogue_tracks\b/iu.test(sql))).toHaveLength(0)
    expect(match.mock.calls.every(([key]) => key.startsWith('https://catalogue.internal/v2/'))).toBe(true)
    expect(put).toHaveBeenCalledTimes(2)
    expect([...entries.values()].slice(1).every((response) =>
      response.headers.get('cache-control') === 'public, max-age=86400')).toBe(true)
  })

  it('coalesces concurrent same-origin reads but never joins another origin pending read', async () => {
    const { cataloguePublicResponse: route } = await import('../catalogue/publicRoutes')
    const entered = deferred(), release = deferred()
    const revisionEntered = deferred(), releaseRevision = deferred()
    let batches = 0
    let revisions = 0
    const blocked = new Proxy(fixture.db, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => {
          const statement = target.prepare(sql)
          return new Proxy(statement, {
            get(target, property) {
              if (property === 'first') return async () => {
                const row = await target.first()
                if (++revisions === 2) { revisionEntered.resolve(); await releaseRevision.promise }
                return row
              }
              const value = Reflect.get(target, property)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        }
        if (property === 'batch') return async (...args: Parameters<Database['batch']>) => {
          batches++
          entered.resolve()
          await release.promise
          return target.batch(...args)
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const first = route(request('https://pending-a.example'), blocked)
    await entered.promise
    const same = route(request('https://pending-a.example'), blocked)
    await revisionEntered.promise
    const different = route(request('https://pending-b.example'), other.db)
    // A stalled first scope must not block the other scope. Release even on failure.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        different,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cross-origin pending joined')), 2000) }),
      ])
      expect(await response.text()).toBe(await projection(other.db))
      // B has settled while A's second one-row read is paused. Let that read finish and
      // drain its microtasks before releasing A's batch: A/B/A must still share one read.
      releaseRevision.resolve()
      await new Promise<void>((resolve) => setImmediate(resolve))
    } finally {
      clearTimeout(timer)
      releaseRevision.resolve()
      release.resolve()
      await Promise.allSettled([first, same, different])
    }
    expect(await (await first).text()).toBe(await projection(fixture.db))
    expect(await (await same).text()).toBe(await projection(fixture.db))
    expect(batches).toBe(1)
  })

  it('drops settled pending reads and retains only one completed catalogue across origins', async () => {
    const { cataloguePublicResponse: route } = await import('../catalogue/publicRoutes')
    const statements: string[][] = [[], []]
    const databases = [countingProxy(fixture.db, statements[0]), countingProxy(other.db, statements[1])]
    const expected = [await projection(fixture.db), await projection(other.db)]
    for (const index of [0, 1, 0]) {
      const response = await route(request(`https://settled-${index}.example`), databases[index])
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(expected[index])
    }
    // Returning to evicted A must read again, not retain a settled Promise or a second memo.
    expect(statements.map((queries) => queries.filter((sql) => /FROM\s+catalogue_tracks\b/iu.test(sql)).length))
      .toEqual([2, 1])
  })

  it.each(['throws', 'rejects'])('cleans up a batch that %s so the same origin and revision can retry', async (failure) => {
    const { cataloguePublicResponse: route } = await import('../catalogue/publicRoutes')
    let batches = 0
    const flaky = new Proxy(fixture.db, {
      get(target, property) {
        if (property === 'batch') return (...args: Parameters<Database['batch']>) => {
          if (++batches === 1) {
            const error = new Error('private database failure')
            if (failure === 'throws') throw error
            return Promise.reject(error)
          }
          return target.batch(...args)
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const origin = 'https://retry.example'
    const failed = await route(request(origin), flaky)
    expect(failed.status).toBe(503)
    expect(failed.headers.get('cache-control')).toBe('no-store')
    expect(await failed.json()).toEqual({ error: 'catalogue_unavailable' })
    const expected = await projection(fixture.db)
    for (let index = 0; index < 2; index++) {
      const response = await route(request(origin), flaky)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(expected)
    }
    expect(batches).toBe(2)
  })

  it('does not let a higher revision from another origin prevent memoising this origin', async () => {
    const { cataloguePublicResponse: route } = await import('../catalogue/publicRoutes')
    await fixture.db.prepare('UPDATE catalogue_state SET revision = 100 WHERE id = 1').run()
    await route(request('https://high-revision.example'), fixture.db)
    const statements: string[] = []
    const counted = countingProxy(other.db, statements)
    for (let i = 0; i < 2; i++) {
      expect(await (await route(request('https://low-revision.example'), counted)).text())
        .toBe(await projection(other.db))
    }
    expect(statements.filter((sql) => /FROM\s+catalogue_tracks\b/iu.test(sql))).toHaveLength(1)
  })

  it('keeps the newer same-origin snapshot when an older in-flight revision finishes later', async () => {
    const { cataloguePublicResponse: route } = await import('../catalogue/publicRoutes')
    const entered = deferred(), release = deferred()
    let batches = 0
    const delayed = new Proxy(fixture.db, {
      get(target, property) {
        if (property === 'batch') return async (...args: Parameters<Database['batch']>) => {
          batches++
          const snapshot = await target.batch(...args)
          if (batches === 1) { entered.resolve(); await release.promise }
          return snapshot
        }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const origin = 'https://revision-race.example'
    const older = route(request(origin), delayed)
    await entered.promise
    try {
      await fixture.db.prepare('UPDATE catalogue_state SET revision = 12 WHERE id = 1').run()
      const newer = await route(request(origin), delayed)
      expect((await newer.json()).revision).toBe('12')
    } finally { release.resolve(); await older }
    expect((await (await older).json()).revision).toBe('11')
    expect((await (await route(request(origin), delayed)).json()).revision).toBe('12')
    expect(batches).toBe(2)
  })
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
