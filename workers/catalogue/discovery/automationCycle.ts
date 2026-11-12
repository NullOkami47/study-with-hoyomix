/**
 * Unattended weekly discovery cycle.
 *
 * The cycle is deliberately split into phases that each fail closed and record why, so a
 * quiet week is distinguishable from a broken one. Phase order per run:
 *
 *   1. `publish`   — reviewed-and-staged candidates from earlier runs reach D1.
 *   2. `suggest`   — classification rows written by the external agent are imported.
 *   3. `stage`     — candidates whose classification is now complete append to staging.
 *   4. `export`    — newly checked candidates are offered to the agent.
 *
 * Phase 1 runs first so the previous week's agreed work lands even if this week's upstream
 * is down. The agent only ever supplies classification fields: provider source IDs are
 * discovered and verified by `checkDiscoverySources`, never accepted from the sheet.
 *
 * Nothing here weakens an existing guard. Staging still goes through `stageCandidate`,
 * publication still goes through `saveImportBatch`/`publishImportBatch` with their CAS
 * checks, and `planDiscoveryAppend` still demands a verified runtime source. The cycle's
 * only new authority is acting without an admin session, recorded as a null audit actor.
 */
import type { D1Database } from '../../env'
import type { CatalogueEnv } from '../adminRoutes'
import {
  sheetsConfigured,
  createGoogleSheetsClient,
  type AutomationTab,
  AUTOMATION_LIMITS,
} from '../googleSheets'
import { readCatalogueSnapshot } from '../repository'
import { checkDiscoverySources } from './sources'
import { stageCandidate } from './stageService'
import { planDiscoveryAppend } from './staging'
import {
  publishAutomationStaged, recordAutomationStage, runtimePlayable,
  admitDiscoveryCycleWrites, type AutomationPublishOptions,
} from './automationPublish'
import { validateSuggestion, platformIdentity } from './model'
import {
  readCandidate,
  updateCandidate,
  acquireDiscoveryLease,
  releaseDiscoveryLease,
  stopDiscoveryWritesOnQuota,
} from './repository'
import {
  DISCOVERY_SHEET_HEADERS,
  SUGGESTION_SHEET_HEADERS,
  discoveryExportRow,
  discoveryExportIntent, readDiscoveryExportIntent, discoveryIntentRow,
  type DiscoveryExportIntent,
  headerMatches,
  parseSuggestionRows,
  type ParsedSuggestionRow,
} from './automationRows'
import type { DiscoveryCandidate } from './types'

/** Hard ceiling per phase. Live CPU/subrequest compatibility still needs deployment validation. */
const PHASE_LIMIT = 20
// Conservative allowance for the bounded non-publication phases and their indexes/ledgers.
const CYCLE_WRITE_RESERVE = 10_000
/**
 * Rate-limiter identity for provider searches made without an admin session.
 * `checkDiscoverySources` passes its actor to the ChKSz admin-search limiter, which hashes
 * it into a bucket key, so this must be a stable non-empty string rather than null: the
 * automation then shares one bucket instead of evading the limit with a fresh identity per
 * cycle. It is not a user ID and never reaches `users` or the audit actor column.
 */
const AUTOMATION_LIMITER_IDENTITY = 'catalogue-discovery-automation'
/**
 * A cycle that finds no agent activity for this long is reported as `stale`. Spark silently
 * not running is the expected failure of a UI-driven agent schedule, so it must surface as
 * an explicit state rather than as an indefinite run of successful no-op cycles.
 */
export const SUGGESTION_STALE_MS = 14 * 24 * 60 * 60 * 1000

export type PhaseName = 'publish' | 'suggest' | 'stage' | 'export'

export interface PhaseOutcome {
  phase: PhaseName
  processed: number
  failed: number
  outcome: string
  details: string[]
}

export interface CycleResult {
  cycleId: string
  startedAt: number
  phases: PhaseOutcome[]
  outcome: 'completed' | 'skipped' | 'failed' | 'stale'
  publishedRevision: number | null
}

export interface AutomationSheets {
  read: ReturnType<typeof createGoogleSheetsClient>['read']
  readAutomation: ReturnType<typeof createGoogleSheetsClient>['readAutomation']
  appendAutomation: ReturnType<
    typeof createGoogleSheetsClient
  >['appendAutomation']
  append?: ReturnType<typeof createGoogleSheetsClient>['append']
}

export interface CycleOptions {
  now?: () => number
  fetch?: typeof fetch
  sheets?: AutomationSheets
  cache?: Pick<Cache, 'match' | 'put'>
  /** Runs regardless of the weekly cadence, for an explicit operator-triggered cycle. */
  force?: boolean
  /** Overrides the cadence. Present for tests and for a deliberately different schedule. */
  interval?: number
  /** @internal Test-only publication transaction boundary. */
  beforePublishBatch?: AutomationPublishOptions['beforePublishBatch']
  /** Test-only quota seam. Production reads account-wide Cloudflare analytics. */
  quota?: AutomationPublishOptions['quota']
}

const reason = (error: unknown) =>
  error instanceof Error && error.message ? error.message : 'unknown_error'
const quotaStopped = (error: unknown) => /quota|10042/i.test(reason(error))

/** Automation is opt-in per environment and never implied by the discovery feature itself. */
export function automationEnabled(env: CatalogueEnv): boolean {
  return env.CATALOGUE_DISCOVERY_AUTOMATION === 'enabled'
}

/**
 * Auto-publication is a second, separate opt-in. With automation on but this off, the cycle
 * still discovers, classifies and stages; the catalogue only changes when an admin publishes.
 */
export function autoPublishEnabled(env: CatalogueEnv): boolean {
  return env.CATALOGUE_DISCOVERY_AUTO_PUBLISH === 'enabled'
}

async function recordedRow(
  db: D1Database,
  tab: AutomationTab,
  key: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      'SELECT 1 AS present FROM catalogue_discovery_automation_rows WHERE tab=? AND row_key=?',
    )
    .bind(tab, key)
    .first<number>('present')
  return row === 1
}

/**
 * Returns true when this exact (tab, key) was newly claimed. The primary key makes the
 * claim atomic, so a retried or concurrent cycle cannot export or import the same row twice.
 */
async function claimRow(
  db: D1Database,
  tab: AutomationTab,
  key: string,
  now: number,
  payload?: DiscoveryExportIntent,
): Promise<boolean> {
  const result = await db
    .prepare(
      'INSERT OR IGNORE INTO catalogue_discovery_automation_rows(tab,row_key,created_at,payload_json) VALUES(?,?,?,?)',
    )
    .bind(tab, key, now, payload ? JSON.stringify(payload) : null)
    .run()
  return result.meta.changes === 1
}

/**
 * Phase 2. Imports classification rows the agent wrote to `Suggestions`.
 *
 * A row is applied only if it validates against the same `validateSuggestion` contract the
 * Admin import path uses. The suggestion's own `adapter` is forced to the automation adapter
 * so the catalogue records who classified it, and `classificationReviewed` stays false until
 * this function explicitly sets it, which it does only because the operator turned automation
 * on. Source checks are cleared because classification changes the title/album/vocal inputs
 * that source matching depends on.
 */
async function importSuggestions(
  db: D1Database,
  sheets: AutomationSheets,
  now: () => number,
  assertLease: () => Promise<void>,
): Promise<{ outcome: PhaseOutcome }> {
  const details: string[] = []
  let processed = 0
  let failed = 0
  let book: Awaited<ReturnType<AutomationSheets['readAutomation']>>
  try {
    book = await sheets.readAutomation()
  } catch (error) {
    return {
      outcome: {
        phase: 'suggest',
        processed: 0,
        failed: 0,
        outcome: reason(error),
        details,
      },
    }
  }
  const rows = book.Suggestions
  if (!rows)
    return {
      outcome: {
        phase: 'suggest',
        processed: 0,
        failed: 0,
        outcome: 'suggestions_tab_missing',
        details,
      },
    }
  // The header is checked inside parseSuggestionRows, which throws
  // `automation_sheet_contract`. Checking it twice here only produced a second error code
  // for one condition, so the single parser vocabulary is the one that surfaces.
  let parsed: ParsedSuggestionRow[]
  let rejected: Array<{ videoId: string; reason: string }>
  try {
    const result = await parseSuggestionRows(rows)
    parsed = result.accepted
    rejected = result.rejected
  } catch (error) {
    return {
      outcome: {
        phase: 'suggest',
        processed: 0,
        failed: 0,
        outcome: reason(error),
        details,
      },
    }
  }
  failed += rejected.length
  for (const row of rejected.slice(0, 10)) details.push(row.videoId + ':' + row.reason)
  const pending: ParsedSuggestionRow[] = []
  for (const row of parsed) {
    if (await recordedRow(db, 'Suggestions', row.rowKey)) continue
    pending.push(row)
    if (pending.length >= PHASE_LIMIT) break
  }
  for (const row of pending) {
    await assertLease()
    try {
      const candidate = await readCandidate(db, row.candidateId)
      if (!candidate) throw new Error('unknown_candidate')
      if (candidate.stageState !== 'pending')
        throw new Error('candidate_not_pending')
      const exportPayload = await db.prepare(
        "SELECT payload_json FROM catalogue_discovery_automation_rows WHERE tab='Discoveries' AND row_key=?",
      ).bind(candidate.id).first<string | null>('payload_json')
      const intent = readDiscoveryExportIntent(exportPayload)
      if (!intent || intent.row[0] !== candidate.discovery.videoId || intent.row[1] !== candidate.id ||
        intent.row[2] !== candidate.trackId || intent.candidateRevision !== candidate.revision ||
        candidate.classificationReviewed) throw new Error('stale_suggestion')
      const exported = book.Discoveries?.slice(1).filter((row) => row[1] === candidate.id) ?? []
      if (!headerMatches(book.Discoveries?.[0], DISCOVERY_SHEET_HEADERS) || exported.length !== 1 ||
        intent.row.some((value, i) => value !== (exported[0][i] ?? '')))
        throw new Error('export_reconciliation_required')
      const suggestion = validateSuggestion({
        ...row.fields,
        work_group_id:
          row.fields.work_group_id ?? candidate.suggestion.work_group_id,
        evidence: row.fields.evidence,
        adapter: row.adapter,
      })
      // The content claim and candidate CAS commit together. A lost update or D1
      // failure cannot consume the row and hide it from every later cycle.
      await db.batch([
        db.prepare(
          "INSERT INTO catalogue_discovery_automation_rows(tab,row_key,created_at) VALUES('Suggestions',?,?)",
        ).bind(row.rowKey, now()),
        db.prepare(
          "UPDATE catalogue_discovery_candidates SET suggestion_json=?,classification_reviewed=1,sources_json='[]',revision=CASE WHEN revision=? AND stage_state='pending' AND classification_reviewed=0 AND EXISTS(SELECT 1 FROM catalogue_discovery_automation_rows WHERE tab='Discoveries' AND row_key=? AND payload_json=?) THEN revision+1 ELSE 0 END,updated_at=? WHERE candidate_id=?",
        ).bind(JSON.stringify(suggestion), intent.candidateRevision, candidate.id, exportPayload, now(), candidate.id),
      ])
      processed += 1
    } catch (error) {
      if (quotaStopped(error)) throw error
      // Permanent validation/state rejections are remembered by content, allowing
      // later rows to reach the bounded phase on the next cycle. A corrected row
      // has a new key; a transient CAS/D1 failure remains retryable and unclaimed.
      if (['unknown_candidate', 'candidate_not_pending', 'stale_suggestion', 'invalid_classification', 'unsafe_discovery'].includes(reason(error)))
        await db.prepare(
          "INSERT OR IGNORE INTO catalogue_discovery_automation_rows(tab,row_key,created_at,payload_json) VALUES('Suggestions',?,?,?)",
        ).bind(row.rowKey, now(), JSON.stringify({ rejected: reason(error) })).run()
      failed += 1
      if (details.length < 10)
        details.push(row.candidateId + ':' + reason(error))
    }
  }
  return {
    outcome: {
      phase: 'suggest',
      processed,
      failed,
      outcome: failed && !processed ? 'all_rejected' : 'completed',
      details,
    },
  }
}

/**
 * Phase 3. Stages candidates whose classification is complete and whose sources verify.
 *
 * Source checking happens here rather than being trusted from an earlier run: a provider ID
 * that resolved last week can be dead this week, and `planDiscoveryAppend` enforces a TTL on
 * the check anyway. A candidate that cannot reach a playable provider is left pending, which
 * is the designed resting state for a track with no usable source.
 */
async function stageReadyCandidates(
  env: CatalogueEnv,
  sheets: AutomationSheets,
  request: Request,
  now: () => number,
  fetcher: typeof fetch,
  cache: Pick<Cache, 'match' | 'put'> | undefined,
  assertLease: () => Promise<void>,
): Promise<PhaseOutcome> {
  const details: string[] = []
  let processed = 0
  let failed = 0
  const rows = await env.DB.prepare(
    "SELECT candidate_id FROM catalogue_discovery_candidates WHERE stage_state='pending' AND classification_reviewed=1 ORDER BY updated_at ASC,candidate_id ASC LIMIT ?",
  )
    .bind(PHASE_LIMIT)
    .all<{ candidate_id: string }>()
  for (const { candidate_id: id } of rows.results ?? []) {
    await assertLease()
    try {
      let candidate = await readCandidate(env.DB, id)
      if (!candidate) continue
      if (candidate.suggestion.vocal_status === 'uncertain')
        throw new Error('classification_incomplete')
      if (candidate.suggestion.uncertainties.length)
        throw new Error('classification_uncertain')
      // `checkDiscoverySources` uses this only as a hashed rate-limiter key for the ChKSz
      // admin search, so the cycle needs a stable non-empty identity. It is deliberately
      // not a user ID: it grants no session and never reaches an audit actor column.
      const checked = await checkDiscoverySources(
        candidate,
        env,
        request,
        AUTOMATION_LIMITER_IDENTITY,
        { fetch: fetcher, now, cache },
      )
      await assertLease()
      const snapshot = await readCatalogueSnapshot(env.DB)
      // Reuses the Admin path's cross-track identity guard: a verified ID already owned by
      // another track is a conflict, never a silent rebinding.
      const conflicts = checked
        .filter((s) => s.status === 'valid')
        .flatMap((s) => {
          const owner = snapshot.sources.find(
            (p) =>
              platformIdentity(p.provider, p.external_id) !== null &&
              platformIdentity(p.provider, p.external_id) ===
                platformIdentity(s.provider, s.externalId),
          )
          return owner && owner.track_id !== candidate!.trackId
            ? ['source_owned_by:' + owner.track_id]
            : []
        })
      candidate = await updateCandidate(
        env.DB,
        {
          ...candidate,
          conflicts: [...new Set([...candidate.conflicts, ...conflicts])],
          sources: checked,
          stageState: 'pending',
        },
        candidate.revision,
        now(),
      )
      if (candidate.conflicts.length) throw new Error('identity_conflict')
      if (!(await runtimePlayable(env, candidate)))
        throw new Error('runtime_source_required')
      const plan = planDiscoveryAppend([candidate], await sheets.read(), snapshot, now())
      await assertLease()
      await recordAutomationStage(env.DB, candidate, plan, now())
      await stageCandidate(
        env.DB,
        sheets,
        candidate,
        snapshot.revision,
        now,
      )
      processed += 1
    } catch (error) {
      if (reason(error) === 'discovery_busy' || quotaStopped(error)) throw error
      failed += 1
      if (details.length < 10) details.push(id + ':' + reason(error))
      // Rotate blocked candidates behind untouched work rather than selecting the
      // same oldest twenty forever. An uncertain staging intent remains untouched.
      await env.DB.prepare(
        "UPDATE catalogue_discovery_candidates SET updated_at=? WHERE candidate_id=? AND stage_state='pending'",
      ).bind(now(), id).run()
    }
  }
  return {
    phase: 'stage',
    processed,
    failed,
    outcome: failed && !processed ? 'all_failed' : 'completed',
    details,
  }
}

/**
 * Phase 4. Qualifies each new candidate's playback sources, then offers it to the agent.
 *
 * Qualification happens here, before the export, so the exported row can show which provider
 * IDs the server itself matched and resolved. Those cells are informational: the import path
 * never reads a source ID back out of the sheet, and the staging phase re-qualifies anyway
 * because a resolvable ID can die between cycles.
 *
 * A candidate whose sources cannot be qualified is still exported. Classification does not
 * depend on having a playable source, and a track with no usable source is meant to rest as a
 * candidate rather than disappear from the agent's view.
 */
async function exportDiscoveries(
  db: D1Database,
  env: CatalogueEnv,
  sheets: AutomationSheets,
  request: Request,
  now: () => number,
  cycleId: string,
  leaseOwner: string,
  fetcher: typeof fetch,
  cache: Pick<Cache, 'match' | 'put'> | undefined,
  assertLease: () => Promise<void>,
): Promise<PhaseOutcome> {
  const details: string[] = []
  let book: Awaited<ReturnType<AutomationSheets['readAutomation']>>
  try {
    book = await sheets.readAutomation()
  } catch (error) {
    return {
      phase: 'export',
      processed: 0,
      failed: 0,
      outcome: reason(error),
      details,
    }
  }
  const existing = book.Discoveries
  if (!existing)
    return {
      phase: 'export',
      processed: 0,
      failed: 0,
      outcome: 'discoveries_tab_missing',
      details,
    }
  if (!headerMatches(existing[0], DISCOVERY_SHEET_HEADERS))
    return {
      phase: 'export',
      processed: 0,
      failed: 0,
      outcome: 'discoveries_header_mismatch',
      details,
    }
  // Retained claims are exact append intents. An unknown response is reconciled by
  // reading the same rows, never by appending again. Duplicate or changed rows block.
  const intents = await db.prepare(
    "SELECT r.row_key,r.payload_json FROM catalogue_discovery_automation_rows r JOIN catalogue_discovery_candidates c ON c.candidate_id=r.row_key WHERE r.tab='Discoveries' AND r.payload_json IS NOT NULL AND c.stage_state='pending' AND c.classification_reviewed=0 LIMIT 5001",
  ).all<{ row_key: string; payload_json: string }>()
  const unresolved = (intents.results ?? []).filter((intent) => {
    const expected = discoveryIntentRow(intent.payload_json)
    const matches = existing.slice(1).filter((row) => row[1] === intent.row_key)
    return !expected || matches.length !== 1 || expected.some((value, i) => value !== (matches[0][i] ?? ''))
  })
  if (unresolved.length || (intents.results?.length ?? 0) > 5000)
    return {
      phase: 'export', processed: 0, failed: unresolved.length || 1,
      outcome: 'export_reconciliation_required',
      details: unresolved.slice(0, 10).map((intent) => intent.row_key),
    }
  const rows = await db
    .prepare(
      "SELECT c.candidate_id FROM catalogue_discovery_candidates c WHERE c.stage_state='pending' AND c.classification_reviewed=0 AND NOT EXISTS(SELECT 1 FROM catalogue_discovery_automation_rows r WHERE r.tab='Discoveries' AND r.row_key=c.candidate_id) ORDER BY c.created_at ASC,c.candidate_id ASC LIMIT ?",
    )
    .bind(PHASE_LIMIT)
    .all<{ candidate_id: string }>()
  const planned: { key: string; row: string[]; intent: DiscoveryExportIntent }[] = []
  let qualificationFailures = 0
  for (const { candidate_id: id } of rows.results ?? []) {
    await assertLease()
    let candidate = await readCandidate(db, id)
    if (!candidate) continue
    if (await recordedRow(db, 'Discoveries', candidate.id)) continue
    // Qualify before exporting so the row shows the IDs the server matched. A provider or
    // network failure must not block classification, so the candidate is exported with
    // whatever was qualified, and the staging phase qualifies again later regardless.
    try {
      const checked = await checkDiscoverySources(
        candidate,
        env,
        request,
        AUTOMATION_LIMITER_IDENTITY,
        { fetch: fetcher, now, cache },
      )
      await assertLease()
      candidate = await updateCandidate(
        db,
        { ...candidate, sources: checked, stageState: 'pending' },
        candidate.revision,
        now(),
      )
    } catch (error) {
      if (reason(error) === 'discovery_busy' || quotaStopped(error)) throw error
      qualificationFailures += 1
      if (details.length < 10) details.push(id + ':' + reason(error))
    }
    const row = discoveryExportRow(candidate, cycleId, now())
    planned.push({ key: candidate.id, row, intent: discoveryExportIntent(candidate, row) })
  }
  if (!planned.length)
    return {
      phase: 'export',
      processed: 0,
      failed: qualificationFailures,
      outcome: 'completed',
      details,
    }
  if (existing.length + planned.length > AUTOMATION_LIMITS.Discoveries.rows)
    return { phase: 'export', processed: 0, failed: planned.length, outcome: 'automation_capacity', details: [] }
  await assertLease()
  const claimed: typeof planned = []
  for (const item of planned)
    if (await claimRow(db, 'Discoveries', item.key, now(), item.intent)) claimed.push(item)
  if (!claimed.length)
    return {
      phase: 'export',
      processed: 0,
      failed: qualificationFailures,
      outcome: 'completed',
      details,
    }
  try {
    await sheets.appendAutomation(
      'Discoveries',
      claimed.map((item) => item.row),
    )
  } catch (error) {
    // Only explicit no-write errors may release our exact intent, under the still-owned lease.
    if (['sheet_rate_limited', 'sheet_append_rejected', 'sheet_append_not_sent', 'automation_capacity', 'automation_invalid'].includes(reason(error))) {
      await assertLease()
      const released = await db.batch(claimed.map((item) => db.prepare(
        "DELETE FROM catalogue_discovery_automation_rows WHERE tab='Discoveries' AND row_key=? AND payload_json=? AND EXISTS(SELECT 1 FROM catalogue_discovery_locks WHERE lock_key='automation' AND owner=? AND expires_at>=?)",
      ).bind(item.key, JSON.stringify(item.intent), leaseOwner, now())))
      if (released.some((result) => result.meta.changes !== 1)) throw new Error('discovery_busy')
    }
    // Preserve the exact intent after an unknown result. The next cycle only reads
    // it back; it cannot accidentally send the same append a second time.
    return {
      phase: 'export',
      processed: 0,
      failed: claimed.length,
      outcome: reason(error),
      details,
    }
  }
  return {
    phase: 'export',
    processed: claimed.length,
    failed: qualificationFailures,
    outcome: 'completed',
    details,
  }
}

/**
 * Runs one full cycle under a lease, so an overlapping schedule tick or a manual trigger
 * cannot interleave two cycles against the same candidates.
 */
export async function runDiscoveryAutomationCycle(
  env: CatalogueEnv,
  options: CycleOptions = {},
): Promise<CycleResult> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const cycleId = crypto.randomUUID()
  const base: CycleResult = {
    cycleId,
    startedAt,
    phases: [],
    outcome: 'skipped',
    publishedRevision: null,
  }
  if (!automationEnabled(env))
    return { ...base, phases: [], outcome: 'skipped' }
  // The Cron Trigger fires hourly for unrelated maintenance, so the cycle paces itself to
  // its own interval. A skipped tick is not recorded, so it cannot push the next real cycle
  // out. `force` is for an explicit operator-triggered run, which ignores the cadence.
  if (!options.force && !(await dueForCycle(env.DB, startedAt, options.interval)))
    return {
      ...base,
      outcome: 'skipped',
      phases: [
        {
          phase: 'suggest',
          processed: 0,
          failed: 0,
          outcome: 'not_due',
          details: [],
        },
      ],
    }
  // Admission precedes every lease/history/classification write, even with publication off.
  try {
    await admitDiscoveryCycleWrites(env, options, CYCLE_WRITE_RESERVE)
  } catch (error) {
    return { ...base, outcome: 'failed', phases: [{ phase: 'publish', processed: 0, failed: 1,
      outcome: ['quota_exhausted', 'quota_rate_limited'].includes(reason(error)) ? reason(error) : 'quota_unavailable', details: [] }] }
  }
  let quotaFailure: unknown
  env = { ...env, DB: stopDiscoveryWritesOnQuota(env.DB, (error) => { quotaFailure ??= error }) }
  if (!sheetsConfigured(env)) {
    const result: CycleResult = {
      ...base,
      outcome: 'failed',
      phases: [
        {
          phase: 'suggest',
          processed: 0,
          failed: 0,
          outcome: 'sheets_unavailable',
          details: [],
        },
      ],
    }
    await recordCycle(env.DB, result, now())
    return result
  }
  const sheets = options.sheets ?? createGoogleSheetsClient(env)
  const fetcher = options.fetch ?? globalThis.fetch
  // checkDiscoverySources derives provider URLs from the public origin, exactly as the
  // Admin path does; it never receives an admin session.
  const request = new Request(new URL('/', env.PUBLIC_ORIGIN).toString())
  const owner = crypto.randomUUID()
  try {
    await acquireDiscoveryLease(env.DB, 'automation', owner, startedAt)
  } catch (error) {
    if (quotaFailure || quotaStopped(error))
      return { ...base, outcome: 'failed', phases: [{ phase: 'suggest', processed: 0, failed: 1,
        outcome: reason(quotaFailure ?? error), details: [] }] }
    return {
      ...base,
      outcome: 'skipped',
      phases: [
        {
          phase: 'suggest',
          processed: 0,
          failed: 0,
          outcome: 'discovery_busy',
          details: [],
        },
      ],
    }
  }
  const assertLease = async () => {
    const at = now()
    const renewed = await env.DB.prepare(
      "UPDATE catalogue_discovery_locks SET expires_at=? WHERE lock_key='automation' AND owner=? AND expires_at>=?",
    ).bind(at + 120000, owner, at).run()
    if (renewed.meta.changes !== 1) throw new Error('discovery_busy')
  }
  const phases: PhaseOutcome[] = []
  let publishedRevision: number | null = null
  try {
    await assertLease()
    // A competing cycle may have finished between the first due check and lease acquisition.
    if (!options.force && !(await dueForCycle(env.DB, startedAt, options.interval)))
      return { ...base, outcome: 'skipped', phases: [{ phase: 'suggest', processed: 0, failed: 0, outcome: 'not_due', details: [] }] }
    const published = await publishAutomationStaged(env, sheets, {
      now, fetch: fetcher, cache: options.cache, quota: options.quota, cycleWriteReserve: CYCLE_WRITE_RESERVE,
      beforePublishBatch: async (statements) => {
        await assertLease()
        return options.beforePublishBatch ? options.beforePublishBatch(statements) : statements
      },
    })
    phases.push(published.outcome)
    publishedRevision = published.revision
    if (quotaFailure || ['quota_exhausted', 'quota_rate_limited', 'quota_unavailable'].includes(published.outcome.outcome)) {
      quotaFailure ??= new Error(published.outcome.outcome)
      return { ...base, phases, outcome: 'failed', publishedRevision }
    }
    await assertLease()
    const imported = await importSuggestions(env.DB, sheets, now, assertLease)
    phases.push(imported.outcome)
    phases.push(
      await stageReadyCandidates(
        env,
        sheets,
        request,
        now,
        fetcher,
        options.cache,
        assertLease,
      ),
    )
    phases.push(
      await exportDiscoveries(
        env.DB,
        env,
        sheets,
        request,
        now,
        cycleId,
        owner,
        fetcher,
        options.cache,
        assertLease,
      ),
    )
    const stale = await suggestionsStale(env.DB, now())
    const failed = phases.some((phase) => phase.failed > 0 || ![
      'completed', 'auto_publish_disabled', 'nothing_approvable', 'already_published',
    ].includes(phase.outcome))
    const result: CycleResult = {
      cycleId,
      startedAt,
      phases,
      outcome: stale ? 'stale' : failed ? 'failed' : 'completed',
      publishedRevision,
    }
    await recordCycle(env.DB, result, now())
    return result
  } catch (error) {
    if (quotaStopped(error)) quotaFailure ??= error
    const result: CycleResult = {
      cycleId,
      startedAt,
      phases: [
        ...phases,
        {
          phase: 'suggest',
          processed: 0,
          failed: 0,
          outcome: reason(quotaFailure ?? error),
          details: [],
        },
      ],
      outcome: 'failed',
      publishedRevision,
    }
    if (!quotaFailure) await recordCycle(env.DB, result, now())
    return result
  } finally {
    if (!quotaFailure) await releaseDiscoveryLease(env.DB, 'automation', owner)
  }
}

/**
 * True when the agent has not supplied a classification row for longer than the staleness
 * window while candidates were waiting. Reported so an agent schedule that quietly stopped
 * is visible instead of looking like an uneventful week.
 */
async function suggestionsStale(
  db: D1Database,
  now: number,
): Promise<boolean> {
  const waiting = await db
    .prepare(
      "SELECT min(created_at) AS oldest FROM catalogue_discovery_candidates WHERE stage_state='pending' AND classification_reviewed=0",
    )
    .first<number | null>('oldest')
  return waiting !== null && waiting !== undefined
    ? now - waiting > SUGGESTION_STALE_MS
    : false
}

async function recordCycle(
  db: D1Database,
  result: CycleResult,
  now: number,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO catalogue_discovery_automation_cycles(cycle_id,started_at,finished_at,outcome,phases_json,published_revision) VALUES(?,?,?,?,?,?)',
    )
    .bind(
      result.cycleId,
      result.startedAt,
      now,
      result.outcome,
      JSON.stringify(result.phases),
      result.publishedRevision,
    )
    .run()
}

/**
 * The cadence the operator asked for. The Worker's Cron Trigger fires hourly for unrelated
 * maintenance, so the cycle paces itself against its own recorded history rather than
 * running on every tick. A cycle that ended in `skipped` does not count as a run, otherwise
 * a transient lease collision would silently push the next real cycle out by a full week.
 */
export const CYCLE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

export async function dueForCycle(
  db: D1Database,
  now: number,
  interval = CYCLE_INTERVAL_MS,
): Promise<boolean> {
  const last = await db
    .prepare(
      "SELECT max(started_at) AS last FROM catalogue_discovery_automation_cycles WHERE outcome!='skipped'",
    )
    .first<number | null>('last')
  return last === null || last === undefined || now - last >= interval
}

export async function readAutomationCycles(
  db: D1Database,
  limit = 20,
): Promise<CycleResult[]> {
  const rows = await db
    .prepare(
      'SELECT * FROM catalogue_discovery_automation_cycles ORDER BY started_at DESC,rowid DESC LIMIT ?',
    )
    .bind(Math.min(Math.max(limit, 1), 50))
    .all<{
      cycle_id: string
      started_at: number
      outcome: CycleResult['outcome']
      phases_json: string
      published_revision: number | null
    }>()
  return (rows.results ?? []).map((r) => ({
    cycleId: r.cycle_id,
    startedAt: r.started_at,
    outcome: r.outcome,
    phases: JSON.parse(r.phases_json),
    publishedRevision: r.published_revision,
  }))
}
