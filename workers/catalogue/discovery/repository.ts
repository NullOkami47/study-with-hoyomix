import type { D1Database, D1PreparedStatement } from '../../env'
import type { CatalogueSnapshot } from '../types'
import {
  candidateIdentity,
  classifyDeterministically,
  digest,
  identityConflicts,
} from './model'
import type {
  DiscoveryCandidate,
  DiscoveryManifest,
  DiscoveryRun,
} from './types'
interface CandidateRow {
  candidate_id: string
  track_id: string
  discovery_json: string
  suggestion_json: string
  classification_reviewed: number
  sources_json: string
  conflicts_json: string
  revision: number
  stage_state: DiscoveryCandidate['stageState']
  created_at: number
  updated_at: number
}
const project = (r: CandidateRow): DiscoveryCandidate => ({
  id: r.candidate_id,
  trackId: r.track_id,
  discovery: JSON.parse(r.discovery_json),
  suggestion: JSON.parse(r.suggestion_json),
  classificationReviewed: r.classification_reviewed === 1,
  sources: JSON.parse(r.sources_json),
  conflicts: JSON.parse(r.conflicts_json),
  revision: r.revision,
  stageState: r.stage_state,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})
export async function readCandidate(
  db: D1Database,
  id: string,
): Promise<DiscoveryCandidate | null> {
  const r = await db
    .prepare(
      'SELECT * FROM catalogue_discovery_candidates WHERE candidate_id=?',
    )
    .bind(id)
    .first<CandidateRow>()
  return r ? project(r) : null
}
export async function readDiscoveryInbox(
  db: D1Database,
  cursor?: string,
): Promise<{
  candidates: DiscoveryCandidate[]
  runs: DiscoveryRun[]
  nextCursor: string | null
}> {
  let statement = db.prepare(
    'SELECT * FROM catalogue_discovery_candidates ORDER BY created_at DESC,candidate_id DESC LIMIT 51',
  )
  if (cursor) {
    const match = /^([0-9]{1,16}):(hoyo-[a-z0-9_-]{1,120})$/.exec(cursor)
    if (!match) throw new Error('invalid_cursor')
    statement = db
      .prepare(
        'SELECT * FROM catalogue_discovery_candidates WHERE created_at<? OR (created_at=? AND candidate_id<?) ORDER BY created_at DESC,candidate_id DESC LIMIT 51',
      )
      .bind(Number(match[1]), Number(match[1]), match[2])
  }
  const [c, r] = await db.batch<any>([
    statement,
    db.prepare(
      'SELECT * FROM catalogue_discovery_runs ORDER BY created_at DESC,rowid DESC LIMIT 30',
    ),
  ])
  const rows = c.results.slice(0, 50) as CandidateRow[]
  const last = rows.at(-1)
  return {
    candidates: rows.map(project),
    runs: r.results.map((v: any) => ({
      runId: v.run_id,
      createdAt: v.created_at,
      ...JSON.parse(v.summary_json),
    })),
    nextCursor:
      c.results.length > 50 && last
        ? last.created_at + ':' + last.candidate_id
        : null,
  }
}
export async function ingestManifest(
  db: D1Database,
  manifest: DiscoveryManifest,
  snapshot: CatalogueSnapshot,
  now: number,
): Promise<DiscoveryRun> {
  const lease = crypto.randomUUID()
  await acquireDiscoveryLease(db, 'ingest', lease, now)
  try {
    const hash = await digest(JSON.stringify(manifest))
    const existing = await db
      .prepare('SELECT * FROM catalogue_discovery_runs WHERE run_id=?')
      .bind(manifest.runId)
      .first<any>()
    if (existing) {
      if (existing.manifest_hash !== hash) throw new Error('run_id_conflict')
      return {
        runId: manifest.runId,
        createdAt: existing.created_at,
        ...JSON.parse(existing.summary_json),
      }
    }
    const statements: D1PreparedStatement[] = []
    let added = 0
    const count = await db
      .prepare('SELECT count(*) AS n FROM catalogue_discovery_candidates')
      .first<number>('n')
    if ((count ?? 0) > 5000) throw new Error('discovery_capacity')
    for (const d of manifest.discoveries) {
      const id = await candidateIdentity(d.videoId)
      const prior = await readCandidate(db, id)
      if (prior) continue
      const exact = snapshot.sources.find(
        (s) =>
          ['youtube', 'piped', 'invidious'].includes(s.provider) &&
          s.external_id === d.videoId,
      )
      const trackId = exact?.track_id ?? id
      const suggestion = classifyDeterministically(d, trackId)
      const conflicts = exact ? [] : identityConflicts(d, snapshot)
      statements.push(
        db
          .prepare(
            'INSERT OR IGNORE INTO catalogue_discovery_candidates(candidate_id,video_id,track_id,discovery_json,suggestion_json,conflicts_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
          )
          .bind(
            id,
            d.videoId,
            trackId,
            JSON.stringify(d),
            JSON.stringify(suggestion),
            JSON.stringify(conflicts),
            now,
            now,
          ),
      )
      added++
    }
    const summary = {
      discovered: manifest.discoveries.length,
      added,
      repeated: manifest.discoveries.length - added,
      outcome: 'completed',
    }
    statements.push(
      db
        .prepare(
          'INSERT INTO catalogue_discovery_runs(run_id,manifest_hash,summary_json,created_at) VALUES(?,?,?,?)',
        )
        .bind(manifest.runId, hash, JSON.stringify(summary), now),
    )
    if ((count ?? 0) + added > 5000) throw new Error('discovery_capacity')
    await db.batch(statements)
    return { runId: manifest.runId, createdAt: now, ...summary }
  } finally {
    await releaseDiscoveryLease(db, 'ingest', lease)
  }
}
export async function updateCandidate(
  db: D1Database,
  c: DiscoveryCandidate,
  expected: number,
  now: number,
): Promise<DiscoveryCandidate> {
  const result = await db
    .prepare(
      'UPDATE catalogue_discovery_candidates SET track_id=?,suggestion_json=?,classification_reviewed=?,sources_json=?,conflicts_json=?,stage_state=?,revision=revision+1,updated_at=? WHERE candidate_id=? AND revision=?',
    )
    .bind(
      c.trackId,
      JSON.stringify(c.suggestion),
      Number(c.classificationReviewed),
      JSON.stringify(c.sources),
      JSON.stringify(c.conflicts),
      c.stageState,
      now,
      c.id,
      expected,
    )
    .run()
  if (result.meta.changes !== 1) throw new Error('stale_candidate')
  return (await readCandidate(db, c.id))!
}
export async function updateCandidatesAtomically(
  db: D1Database,
  updates: Array<{ candidate: DiscoveryCandidate; expected: number }>,
  now: number,
): Promise<void> {
  if (!updates.length) return
  await db.batch(
    updates.map(({ candidate: c, expected }) =>
      db
        .prepare(
          "UPDATE catalogue_discovery_candidates SET suggestion_json=?,classification_reviewed=?,sources_json=?,conflicts_json=?,stage_state=?,revision=CASE WHEN revision=? AND stage_state!='uncertain' THEN revision+1 ELSE 0 END,updated_at=? WHERE candidate_id=?",
        )
        .bind(
          JSON.stringify(c.suggestion),
          Number(c.classificationReviewed),
          JSON.stringify(c.sources),
          JSON.stringify(c.conflicts),
          c.stageState,
          expected,
          now,
          c.id,
        ),
    ),
  )
}
export async function acquireDiscoveryLease(
  db: D1Database,
  key: string,
  owner: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO catalogue_discovery_locks(lock_key,owner,expires_at) VALUES(?,?,?) ON CONFLICT(lock_key) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE catalogue_discovery_locks.expires_at<?',
    )
    .bind(key, owner, now + 120000, now)
    .run()
  const held = await db
    .prepare('SELECT owner FROM catalogue_discovery_locks WHERE lock_key=?')
    .bind(key)
    .first<string>('owner')
  if (held !== owner) throw new Error('discovery_busy')
}
export async function releaseDiscoveryLease(
  db: D1Database,
  key: string,
  owner: string,
): Promise<void> {
  await db
    .prepare(
      'DELETE FROM catalogue_discovery_locks WHERE lock_key=? AND owner=?',
    )
    .bind(key, owner)
    .run()
}


/** Once this cycle observes exhausted D1, nested finally blocks must not write again. */
export function stopDiscoveryWritesOnQuota(db: D1Database, onQuota: (error: unknown) => void): D1Database {
  let stopped: unknown
  const statements = new WeakMap<object, { raw: D1PreparedStatement; query: string }>()
  const readOnly = (query: string) => /^\s*(?:SELECT|PRAGMA)\b/i.test(query)
  const call = async <T>(mutation: boolean, operation: () => Promise<T>): Promise<T> => {
    if (mutation && stopped) throw stopped
    try { return await operation() } catch (error) {
      if (error instanceof Error && /quota|10042/i.test(error.message)) {
        stopped = error
        onQuota(error)
      }
      throw error
    }
  }
  const wrap = (raw: D1PreparedStatement, query: string): D1PreparedStatement => {
    const statement: D1PreparedStatement = {
      bind: (...values) => wrap(raw.bind(...values), query),
      first: ((column?: string) => call(!readOnly(query), () => column === undefined ? raw.first() : raw.first(column))) as D1PreparedStatement['first'],
      run: () => call(!readOnly(query), () => raw.run()),
      all: () => call(!readOnly(query), () => raw.all()),
      raw: ((options?: { columnNames?: boolean }) => call(!readOnly(query), () => raw.raw(options as { columnNames: true }))) as D1PreparedStatement['raw'],
    }
    statements.set(statement, { raw, query })
    return statement
  }
  return {
    prepare: (query) => wrap(db.prepare(query), query),
    batch: (batch) => {
      const entries = batch.map((statement) => statements.get(statement))
      return call(entries.some((entry) => !entry || !readOnly(entry.query)), () =>
        db.batch(batch.map((statement, index) => entries[index]?.raw ?? statement)))
    },
    exec: (query) => call(true, () => db.exec(query)),
  }
}
