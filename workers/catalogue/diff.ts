import type { D1Database } from '../env'
import type { CatalogueSnapshot, StagingData, Proposal, ImportBatch, ChangeKind } from './types'
import type { Workbook } from './googleSheets'
import { readCatalogueSnapshot } from './repository'
import { parseStaging } from './staging'
const pick = (object: object, keys: string[]) =>
  Object.fromEntries(keys.map((key) => [key, (object as Record<string, unknown>)[key]]))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const metadataKeys = [
  'track_id',
  'title',
  'album',
  'release_date',
  'work_group_id',
  'games',
  'relations',
  'metadata_confidence',
  'evidence',
  'notes',
]
const classificationKeys = [
  'track_id',
  'vocal_status',
  'focus',
  'sleep',
  'chill',
  'needs_classification',
]
const sourceKeys = [
  'source_row_id',
  'track_id',
  'provider',
  'external_id',
  'source_type',
  'source_status',
  'source_confidence',
  'rights_status',
  'metadata_json',
  'evidence',
  'notes',
]
export function diffStaging(staged: StagingData, published: CatalogueSnapshot): Proposal[] {
  const changes: Proposal[] = []
  function add(
    entityType: Proposal['entityType'],
    entityKey: string,
    kind: ChangeKind,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    confidence: number | null,
    messages: string[] = [],
    state: Proposal['validationState'] = 'valid',
  ) {
    changes.push({
      changeId: 'change-' + changes.length,
      entityType,
      entityKey,
      kind,
      before,
      after,
      confidence:
        confidence !== null && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
          ? confidence
          : null,
      messages,
      validationState: state,
      decision: 'pending',
    })
  }
  const invalid = new Set(staged.errors.map((e) => e.entityType + ':' + e.key))
  for (const t of staged.tracks) {
    if (invalid.has('track:' + t.track_id)) continue
    const previous = published.tracks.find((p) => p.track_id === t.track_id)
    if (!previous) {
      add('track', t.track_id, 'new_track', null, { ...t }, t.metadata_confidence)
      continue
    }
    const before = {
      ...previous,
      games: published.games.filter((g) => g.track_id === t.track_id).map((g) => g.game),
      relations: published.relations
        .filter((r) => r.track_id === t.track_id)
        .map((r) => r.relation_id),
    }
    for (const [kind, keys] of [
      ['metadata_change', metadataKeys],
      ['classification_change', classificationKeys],
    ] as const) {
      const old = pick(before, keys),
        next = pick(t, keys)
      if (!same(old, next)) add('track', t.track_id, kind, old, next, t.metadata_confidence)
    }
  }
  const privilegedR2Keys = new Set<string>()
  for (const s of staged.sources) {
    const sourceErrors = staged.errors.filter(
      (error) => error.entityType === 'source' && error.key === s.source_row_id,
    )
    const privilegedR2Candidate =
      sourceErrors.length === 1 && sourceErrors[0].code === 'r2_owner_verification_required'
    if (invalid.has('source:' + s.source_row_id) && !privilegedR2Candidate) continue
    if (privilegedR2Candidate) privilegedR2Keys.add(s.source_row_id)
    const previous = published.sources.find((p) => p.source_row_id === s.source_row_id)
    const old = previous ? pick(previous, sourceKeys) : null,
      next = pick(s, sourceKeys)
    if (!same(old, next))
      add(
        'source',
        s.source_row_id,
        previous ? 'source_change' : 'new_source',
        old,
        next,
        s.source_confidence,
        sourceErrors.map((error) => error.code),
        privilegedR2Candidate ? 'error' : 'valid',
      )
  }
  for (const a of staged.aliases) {
    const key = a.track_id + ':' + a.locale + ':' + a.alias
    if (invalid.has('alias:' + key)) continue
    if (
      !published.aliases.some(
        (p) => p.track_id === a.track_id && p.locale === a.locale && p.alias === a.alias,
      )
    )
      add('alias', key, 'new_alias', null, { ...a }, null)
  }
  const errors = new Map<string, typeof staged.errors>()
  for (const e of staged.errors) {
    const key = e.entityType + ':' + e.key
    const list = errors.get(key) ?? []
    list.push(e)
    errors.set(key, list)
  }
  for (const list of errors.values()) {
    const first = list[0]
    if (first.entityType === 'source' && privilegedR2Keys.has(first.key)) continue
    const conflict = list.some((e) => e.conflict)
    add(
      first.entityType,
      first.key,
      conflict ? 'conflict' : 'validation_error',
      null,
      null,
      null,
      list.map((e) => e.code),
      conflict ? 'conflict' : 'error',
    )
  }
  return changes
}
interface BatchRow {
  batch_id: string
  status: ImportBatch['status']
  base_revision: number
  review_revision: number
  created_at: number
  updated_at: number
  published_at: number | null
  summary_json: string
}
interface ChangeRow {
  change_id: string
  entity_type: Proposal['entityType']
  entity_key: string
  kind: ChangeKind
  before_json: string | null
  after_json: string | null
  validation_state: Proposal['validationState']
  validation_messages_json: string
  confidence: number | null
  decision: Proposal['decision']
}
export async function readImportBatch(db: D1Database, id: string): Promise<ImportBatch | null> {
  const results = await db.batch([
    db.prepare('SELECT * FROM catalogue_import_batches WHERE batch_id=?').bind(id),
    db.prepare('SELECT * FROM catalogue_import_changes WHERE batch_id=? ORDER BY rowid').bind(id),
  ])
  const row = results[0].results[0] as unknown as BatchRow | undefined
  if (!row) return null
  return {
    batchId: row.batch_id,
    status: row.status,
    baseRevision: row.base_revision,
    reviewRevision: row.review_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    summary: JSON.parse(row.summary_json),
    changes: (results[1].results as unknown as ChangeRow[]).map((c) => ({
      changeId: c.change_id,
      entityType: c.entity_type,
      entityKey: c.entity_key,
      kind: c.kind,
      before: c.before_json ? JSON.parse(c.before_json) : null,
      after: c.after_json ? JSON.parse(c.after_json) : null,
      validationState: c.validation_state,
      messages: JSON.parse(c.validation_messages_json),
      confidence: c.confidence,
      decision: c.decision,
    })),
  }
}
const syncAuditStatement = (
  db: D1Database,
  actor: string,
  batchId: string,
  summary: ImportBatch['summary'],
  now: number,
) => db.prepare(
  "INSERT INTO admin_audit_log(id,actor_user_id,action,target_key,detail_json,created_at) VALUES (?,?,'catalogue.sync',?,?,?)",
).bind(
  crypto.randomUUID(),
  actor,
  batchId,
  JSON.stringify({ batchId, summary }),
  now,
)

export async function saveImportBatch(
  db: D1Database,
  workbook: Workbook,
  actor: string,
  now: number,
  options: { resync?: boolean } = {},
): Promise<ImportBatch> {
  const snapshot = await readCatalogueSnapshot(db),
    staged = parseStaging(workbook, snapshot),
    proposals = diffStaging(staged, snapshot)
  if (proposals.length > 200) throw new Error('staging_too_many_changes')
  const payload = JSON.stringify(workbook),
    hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))),
      (n) => n.toString(16).padStart(2, '0'),
    ).join('')
  const existing = await db
    .prepare(
      'SELECT batch_id,status FROM catalogue_import_batches WHERE snapshot_hash=? AND base_revision=? ORDER BY created_at DESC LIMIT 1',
    )
    .bind(hash, snapshot.revision)
    .first<{ batch_id: string; status: string }>()
  if (existing && (['draft', 'validated'].includes(existing.status) || !options.resync)) {
    const batch = (await readImportBatch(db, existing.batch_id))!
    await syncAuditStatement(db, actor, batch.batchId, batch.summary, now).run()
    return batch
  }
  const id = crypto.randomUUID(),
    summary: Partial<Record<ChangeKind, number>> = {}
  proposals.forEach((p) => {
    summary[p.kind] = (summary[p.kind] ?? 0) + 1
  })
  const statements = [
    db
      .prepare(
        'INSERT INTO catalogue_import_batches (batch_id,status,snapshot_hash,snapshot_json,summary_json,base_revision,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        id,
        staged.errors.length ? 'draft' : 'validated',
        hash,
        payload,
        JSON.stringify(summary),
        snapshot.revision,
        now,
        now,
        actor,
      ),
    ...proposals.map((p) =>
      db
        .prepare(
          'INSERT INTO catalogue_import_changes (change_id,batch_id,entity_type,entity_key,kind,before_json,after_json,validation_state,validation_messages_json,confidence,decision) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          crypto.randomUUID(),
          id,
          p.entityType,
          p.entityKey,
          p.kind,
          p.before ? JSON.stringify(p.before) : null,
          p.after ? JSON.stringify(p.after) : null,
          p.validationState,
          JSON.stringify(p.messages),
          p.confidence,
          'pending',
        ),
    ),
    syncAuditStatement(db, actor, id, summary, now),
  ]
  try {
    await db.batch(statements)
  } catch (error) {
    const winner = await db
      .prepare(
        "SELECT batch_id FROM catalogue_import_batches WHERE snapshot_hash=? AND base_revision=? AND status IN ('draft','validated')",
      )
      .bind(hash, snapshot.revision)
      .first<{ batch_id: string }>()
    if (winner) {
      const batch = (await readImportBatch(db, winner.batch_id))!
      await syncAuditStatement(db, actor, batch.batchId, batch.summary, now).run()
      return batch
    }
    throw error
  }
  return (await readImportBatch(db, id))!
}
