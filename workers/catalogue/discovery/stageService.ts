import type { D1Database } from '../../env'
import type { Workbook, createGoogleSheetsClient } from '../googleSheets'
import { workbookFingerprint } from '../googleSheets'
import { readCatalogueSnapshot } from '../repository'
import { parseStaging } from '../staging'
import { diffStaging } from '../diff'
import { planDiscoveryAppend } from './staging'
import {
  acquireDiscoveryLease,
  releaseDiscoveryLease,
  readCandidate,
  updateCandidate,
} from './repository'
import type { DiscoveryCandidate, DiscoveryAppend } from './types'
type Sheets = Pick<ReturnType<typeof createGoogleSheetsClient>, 'read'> &
  Partial<Pick<ReturnType<typeof createGoogleSheetsClient>, 'append'>>
const tabs = ['Tracks', 'Sources', 'Aliases'] as const
export function appendedRowsPresent(
  plan: DiscoveryAppend,
  book: Workbook,
): boolean {
  for (const tab of tabs)
    for (const row of plan[tab]) {
      const identity = (r: string[]) =>
        tab === 'Aliases' ? r.slice(0, 3).join('\u001f') : r[0]
      const matches = book[tab]
        .slice(1)
        .filter((r) => identity(r) === identity(row))
      if (
        matches.length !== 1 ||
        row.some((value, i) => value !== (matches[0][i] ?? ''))
      )
        return false
    }
  return true
}
export async function stageCandidate(
  db: D1Database,
  sheets: Sheets,
  c: DiscoveryCandidate,
  expectedCatalogueRevision: number,
  clock: () => number,
  reconcile = false,
): Promise<DiscoveryCandidate> {
  const owner = crypto.randomUUID()
  await acquireDiscoveryLease(db, 'staging', owner, clock())
  try {
    const current = await readCandidate(db, c.id)
    if (!current || current.revision !== c.revision)
      throw new Error('stale_candidate')
    if (reconcile) {
      if (current.stageState !== 'uncertain')
        throw new Error('candidate_not_uncertain')
      const intent = await db
        .prepare(
          'SELECT plan_json FROM catalogue_discovery_sheet_operations WHERE candidate_id=?',
        )
        .bind(c.id)
        .first<string>('plan_json')
      if (!intent) throw new Error('sheet_reconciliation_required')
      const book = await sheets.read()
      if (!appendedRowsPresent(JSON.parse(intent), book))
        throw new Error('sheet_reconciliation_required')
      const result = await updateCandidate(
        db,
        { ...current, stageState: 'staged' },
        current.revision,
        clock(),
      )
      await db
        .prepare(
          'DELETE FROM catalogue_discovery_sheet_operations WHERE candidate_id=?',
        )
        .bind(c.id)
        .run()
      return result
    }
    if (current.stageState === 'uncertain')
      throw new Error('sheet_reconciliation_required')
    const snapshot = await readCatalogueSnapshot(db)
    if (snapshot.revision !== expectedCatalogueRevision)
      throw new Error('stale_catalogue')
    const book = await sheets.read()
    const plan = planDiscoveryAppend([current], book, snapshot, clock())
    const projected = structuredClone(book)
    for (const tab of tabs) projected[tab].push(...plan[tab])
    if (diffStaging(parseStaging(projected, snapshot), snapshot).length > 200)
      throw new Error('staging_too_many_changes')
    const fingerprint = await workbookFingerprint(book)
    if ((await readCatalogueSnapshot(db)).revision !== snapshot.revision)
      throw new Error('stale_catalogue')
    if (!tabs.some((t) => plan[t].length))
      return updateCandidate(
        db,
        { ...current, stageState: 'staged' },
        current.revision,
        clock(),
      )
    if (!sheets.append) throw new Error('sheets_unavailable')
    // Commit intent + candidate reservation together before touching Google. Other edits cannot invalidate this append.
    await db.batch([
      db
        .prepare(
          "UPDATE catalogue_discovery_candidates SET stage_state='uncertain',revision=CASE WHEN revision=? AND stage_state!='uncertain' THEN revision+1 ELSE 0 END,updated_at=? WHERE candidate_id=?",
        )
        .bind(current.revision, clock(), c.id),
      db
        .prepare(
          'INSERT INTO catalogue_discovery_sheet_operations(candidate_id,plan_json,base_revision,created_at) VALUES(?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET plan_json=excluded.plan_json,base_revision=excluded.base_revision,created_at=excluded.created_at',
        )
        .bind(c.id, JSON.stringify(plan), snapshot.revision, clock()),
    ])
    const reserved = (await readCandidate(db, c.id))!
    try {
      await sheets.append(plan, fingerprint)
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'stale_sheet',
          'staging_invalid',
          'sheets_unavailable',
          'sheet_append_rejected',
          'sheet_rate_limited',
          'sheet_append_not_sent',
        ].includes(error.message)
      ) {
        await updateCandidate(
          db,
          { ...reserved, stageState: 'pending' },
          reserved.revision,
          clock(),
        )
        await db
          .prepare(
            'DELETE FROM catalogue_discovery_sheet_operations WHERE candidate_id=?',
          )
          .bind(c.id)
          .run()
        throw error
      }
      throw new Error('sheet_append_uncertain')
    }
    if (!appendedRowsPresent(plan, await sheets.read()))
      throw new Error('sheet_reconciliation_required')
    const result = await updateCandidate(
      db,
      { ...reserved, stageState: 'staged' },
      reserved.revision,
      clock(),
    )
    await db
      .prepare(
        'DELETE FROM catalogue_discovery_sheet_operations WHERE candidate_id=?',
      )
      .bind(c.id)
      .run()
    return result
  } finally {
    await releaseDiscoveryLease(db, 'staging', owner)
  }
}
