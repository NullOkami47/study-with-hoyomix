import type { D1Database, D1PreparedStatement, D1WriteValue } from '../env'
import type { ImportBatch, CatalogueSnapshot } from './types'
import { readCatalogueSnapshot, projectCatalogue } from './repository'
import { parseStaging, exportWorkbook } from './staging'
import { readImportBatch } from './diff'
import { projectImportChanges } from './projection'

async function verifiedOwnerR2Keys(
  db: D1Database,
  batch: ImportBatch,
  approved: ImportBatch['changes'],
): Promise<Set<string>> {
  const privileged = approved.filter(
    (change) => change.messages.length === 1 &&
      change.messages[0] === 'r2_owner_verification_required',
  )
  const keys = new Set<string>()
  for (const change of privileged) {
    const after = change.after
    if (
      change.entityType !== 'source' ||
      !after ||
      after.provider !== 'r2' ||
      typeof after.evidence !== 'string' ||
      !after.evidence.trim()
    ) throw new Error('publish_rejected')
    const verified = await db.prepare(
      "SELECT 1 AS verified FROM admin_audit_log WHERE action='catalogue.review.r2-owner-approve' AND target_key=? AND json_extract(detail_json,'$.batchId')=? AND json_extract(detail_json,'$.changeId')=? AND json_extract(detail_json,'$.sourceRowId')=? AND json_extract(detail_json,'$.evidence')=? LIMIT 1",
    ).bind(
      batch.batchId,
      batch.batchId,
      change.changeId,
      change.entityKey,
      after.evidence,
    ).first<number>('verified')
    if (verified !== 1) throw new Error('publish_rejected')
    keys.add(change.entityKey)
  }
  return keys
}

export async function publishImportBatch(
  db: D1Database,
  batch: ImportBatch,
  actor: string,
  now: number,
  beforeBatch?: (
    statements: D1PreparedStatement[],
  ) => D1PreparedStatement[] | Promise<D1PreparedStatement[]>,
): Promise<ImportBatch> {
  if (!['draft', 'validated'].includes(batch.status)) throw new Error('publish_rejected')
  const approved = batch.changes.filter((c) => c.decision === 'approved')
  if (
    !approved.length ||
    batch.changes.some((c) => c.validationState !== 'valid' && c.decision !== 'rejected')
  )
    throw new Error('publish_rejected')
  const original = await readCatalogueSnapshot(db)
  if (original.revision !== batch.baseRevision) throw new Error('stale_batch')
  if (approved.some((c) => c.validationState !== 'valid')) throw new Error('publish_rejected')
  const privilegedR2Keys = await verifiedOwnerR2Keys(db, batch, approved)
  const { projected, affected, newTracks, sourceIds } = projectImportChanges(original, approved, now)
  // Validate the actual approved projection. Only a specifically audited Owner R2
  // verification may remove its one known blocker; every other error remains fatal.
  const projectionErrors = parseStaging(exportWorkbook(projected), original).errors
  if (projectionErrors.some((error) =>
    error.entityType !== 'source' ||
    error.code !== 'r2_owner_verification_required' ||
    !privilegedR2Keys.has(error.key),
  )) throw new Error('publish_rejected')
  projectCatalogue(projected)
  const statements: D1PreparedStatement[] = []
  // A failed CAS writes 0, violating CHECK(revision>=1), aborting the entire D1 batch.
  // This protects cross-isolate publication AND decision changes after pre-reads.
  statements.push(
    db
      .prepare(
        "UPDATE catalogue_state SET revision=CASE WHEN revision=? AND EXISTS(SELECT 1 FROM catalogue_import_batches WHERE batch_id=? AND status IN ('draft','validated') AND review_revision=?) THEN revision+1 ELSE 0 END WHERE id=1",
      )
      .bind(batch.baseRevision, batch.batchId, batch.reviewRevision),
  )
  for (const id of affected) {
    const row = projected.tracks.find((t) => t.track_id === id)
    if (!row) throw new Error('publish_rejected')
    const fields = [
      'title',
      'album',
      'release_date',
      'vocal_status',
      'focus',
      'sleep',
      'chill',
      'work_group_id',
      'needs_classification',
      'metadata_confidence',
      'evidence',
      'notes',
    ] as const
    const values = fields.map((k) => row[k]) as D1WriteValue[]
    if (newTracks.has(id))
      statements.push(
        db
          .prepare(
            'INSERT INTO catalogue_tracks (track_id,' +
              fields.join(',') +
              ',revision,created_at,updated_at,published_at) VALUES (' +
              Array(fields.length + 5)
                .fill('?')
                .join(',') +
              ')',
          )
          .bind(id, ...values, 1, now, now, now),
      )
    else
      statements.push(
        db
          .prepare(
            'UPDATE catalogue_tracks SET ' +
              fields.map((k) => k + '=?').join(',') +
              ',revision=revision+1,updated_at=?,published_at=? WHERE track_id=?',
          )
          .bind(...values, now, now, id),
      )
    statements.push(
      db.prepare('DELETE FROM catalogue_track_games WHERE track_id=?').bind(id),
      db.prepare('DELETE FROM catalogue_track_relations WHERE track_id=?').bind(id),
    )
    projected.games
      .filter((g) => g.track_id === id)
      .forEach((g) =>
        statements.push(
          db.prepare('INSERT INTO catalogue_track_games VALUES (?,?)').bind(id, g.game),
        ),
      )
    projected.relations
      .filter((r) => r.track_id === id)
      .forEach((r) =>
        statements.push(
          db.prepare('INSERT INTO catalogue_track_relations VALUES (?,?)').bind(id, r.relation_id),
        ),
      )
  }
  for (const id of sourceIds) {
    const source = projected.sources.find((s) => s.source_row_id === id)!
    const fields = [
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
      'created_at',
      'updated_at',
    ] as const
    statements.push(
      db
        .prepare(
          'INSERT INTO catalogue_sources (' +
            fields.join(',') +
            ') VALUES (' +
            fields.map(() => '?').join(',') +
            ') ON CONFLICT(source_row_id) DO UPDATE SET ' +
            fields
              .filter((f) => !['source_row_id', 'track_id', 'created_at'].includes(f))
              .map((f) => f + '=excluded.' + f)
              .join(','),
        )
        .bind(...fields.map((f) => source[f])),
    )
  }
  for (const change of approved.filter((c) => c.entityType === 'alias')) {
    const a = change.after as unknown as CatalogueSnapshot['aliases'][number]
    statements.push(
      db
        .prepare('INSERT INTO catalogue_aliases VALUES (?,?,?)')
        .bind(a.track_id, a.locale, a.alias),
    )
  }
  statements.push(
    db
      .prepare(
        "UPDATE catalogue_import_batches SET status='published',published_at=?,updated_at=?,published_by=?,review_revision=review_revision+1 WHERE batch_id=?",
      )
      .bind(now, now, actor, batch.batchId),
  )
  statements.push(
    db
      .prepare(
        "INSERT INTO admin_audit_log (id,actor_user_id,action,target_key,detail_json,created_at) VALUES (?,?,'catalogue.publish',?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        actor,
        batch.batchId,
        JSON.stringify({
          batchId: batch.batchId,
          baseRevision: batch.baseRevision,
          summary: batch.summary,
          approved: approved.length,
          rejected: batch.changes.filter((c) => c.decision === 'rejected').length,
          changes: approved.map((c) => ({
            changeId: c.changeId,
            kind: c.kind,
            before: c.before,
            after: c.after,
          })),
        }),
        now,
      ),
  )
  await db.batch(beforeBatch ? await beforeBatch(statements) : statements)
  return (await readImportBatch(db, batch.batchId))!
}
