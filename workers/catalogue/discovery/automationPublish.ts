/** Exact append intents are the only unattended publication authority. */
import type { D1Database, D1PreparedStatement } from '../../env'
import type { CatalogueEnv } from '../adminRoutes'
import type { Workbook } from '../googleSheets'
import type { CatalogueSnapshot, Proposal, ImportBatch } from '../types'
import { exportWorkbook, parseStaging, SHEET_HEADERS } from '../staging'
import { diffStaging, saveImportBatch, readImportBatch } from '../diff'
import { publishImportBatch } from '../publish'
import { readCatalogueSnapshot, projectCatalogue } from '../repository'
import { projectImportChanges } from '../projection'
import { readBoundedJsonResponse } from '../../providers/boundedJson'
import { readProviderStates, deploymentAvailable } from '../../providers/config'
import { readChkszOwnerFallbackEnabled } from '../../providers/chkszCredentials'
import { validSourceId } from '../validation'
import { checkDiscoverySources as recheckDiscoverySources } from './sources'
import { readCandidate } from './repository'
import { planDiscoveryAppend, SOURCE_CHECK_TTL_MS } from './staging'
import type { DiscoveryCandidate, DiscoveryAppend } from './types'

export interface AutomationQuota {
  scope: 'account'
  /** Today's UTC calendar date, YYYY-MM-DD. */
  utcDate: string
  /** Account-wide daily rows written, including index maintenance. */
  rowsWritten: number
  /** Observation time: Unix epoch milliseconds, never seconds or an ISO string. */
  checkedAt: number
}
export interface AutomationPublishOptions {
  /** Candidate/source/publication timestamps only. Never changes the quota's UTC day. */
  now?: () => number
  fetch?: typeof fetch
  cache?: Pick<Cache, 'match' | 'put'>
  /** Test seam. The argument is the real runtime Date.now(), in epoch milliseconds. */
  quota?: (nowMs: number) => Promise<AutomationQuota | null>
  /** @internal Called after adding the ledger guards and writes to the publisher batch. */
  beforePublishBatch?: Parameters<typeof publishImportBatch>[4]
  /** Non-publication writes still planned by the admitted cycle. */
  cycleWriteReserve?: number
}
export interface AutomationPublishResult {
  outcome: { phase: 'publish'; processed: number; failed: number; outcome: string; details: string[] }
  revision: number | null
}
/** Local extension until the owning thread extends CatalogueEnv. No credential discovery. */
export type AutomationPublishEnv = CatalogueEnv & {
  CATALOGUE_DISCOVERY_CF_ACCOUNT_ID?: string
  /** Account Analytics Read only. Never log this value or attach it to an error. */
  CATALOGUE_DISCOVERY_QUOTA_API_TOKEN?: string
}
export const AUTOMATION_D1_DAILY_CAP = 100_000
export const AUTOMATION_QUOTA_FRESH_MS = 60_000
const HEADROOM = 500
const CANDIDATE_LIMIT = 20
const PROPOSAL_LIMIT = 200
const tabs = ['Tracks', 'Sources', 'Aliases'] as const
const qualifiedProviders = new Set(['youtube', 'gd-studio', 'chksz', 'meting', 'lx-huibq', 'lx-ikun'])
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10)
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const rowKey = (row: string[]) => JSON.stringify(row)
const hasRows = (plan: DiscoveryAppend) => tabs.some((tab) => plan[tab].length > 0)

/**
 * Schema evidence: official D1 metrics-analytics (2026-11-06), its account-wide
 * aggregate example, and the installed Wrangler getD1MetricsOverviewQuery's
 * d1AnalyticsAdaptiveGroups.sum.rowsWritten. Deliberately omit dimensions and
 * databaseId: one aggregate covers the whole account, not only the bound DB.
 * No schema introspection, alternate endpoint, credential fallback or retry.
 */
export async function readAccountDailyD1Writes(
  env: AutomationPublishEnv,
  options: Pick<AutomationPublishOptions, 'fetch'> = {},
): Promise<AutomationQuota | null> {
  const account = env.CATALOGUE_DISCOVERY_CF_ACCOUNT_ID
  const token = env.CATALOGUE_DISCOVERY_QUOTA_API_TOKEN
  if (!account || !/^[a-f0-9]{32}$/i.test(account) || !token || !/^[\x21-\x7e]{1,1024}$/.test(token))
    return null
  const checkedAt = Date.now()
  const date = utcDay(checkedAt)
  try {
    const response = await (options.fetch ?? fetch)('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({
        query: `query DiscoveryDailyD1Writes($accountTag: string!, $start: Date!, $end: Date!) {
          viewer { accounts(filter: { accountTag: $accountTag }) {
            d1AnalyticsAdaptiveGroups(limit: 2, filter: { date_geq: $start, date_leq: $end }) {
              sum { rowsWritten }
            }
          } }
        }`,
        variables: { accountTag: account, start: date, end: date },
      }),
    })
    if (response.status === 429) {
      await response.body?.cancel()
      throw new Error('quota_rate_limited')
    }
    if (!response.ok || response.redirected) { await response.body?.cancel(); return null }
    const parsed = await readBoundedJsonResponse(response, 32 * 1024)
    if (!parsed.ok || !record(parsed.value)) return null
    const value = parsed.value
    if (value.errors != null && (!Array.isArray(value.errors) || value.errors.length)) return null
    const data = value.data
    if (!record(data) || !record(data.viewer) || !Array.isArray(data.viewer.accounts) || data.viewer.accounts.length !== 1)
      return null
    const accountResult = data.viewer.accounts[0]
    if (!record(accountResult) || !Array.isArray(accountResult.d1AnalyticsAdaptiveGroups) || accountResult.d1AnalyticsAdaptiveGroups.length !== 1)
      return null
    const aggregate = accountResult.d1AnalyticsAdaptiveGroups[0]
    if (!record(aggregate) || !record(aggregate.sum)) return null
    const written = aggregate.sum.rowsWritten
    if (typeof written !== 'number' || !Number.isSafeInteger(written) || written < 0) return null
    const result: AutomationQuota = { scope: 'account', utcDate: date, rowsWritten: written, checkedAt }
    return quotaFresh(result, Date.now()) ? result : null
  } catch (error) {
    if (error instanceof Error && error.message === 'quota_rate_limited') throw error
    return null
  }
}
function quotaFresh(value: AutomationQuota | null, runtimeNow: number): value is AutomationQuota {
  return !!value && value.scope === 'account' && value.utcDate === utcDay(runtimeNow) &&
    Number.isSafeInteger(value.rowsWritten) && value.rowsWritten >= 0 &&
    Number.isSafeInteger(value.checkedAt) && value.checkedAt >= 0 &&
    runtimeNow >= value.checkedAt && runtimeNow - value.checkedAt <= AUTOMATION_QUOTA_FRESH_MS
}
function requireQuota(value: AutomationQuota | null, estimate: number) {
  if (!quotaFresh(value, Date.now())) throw new Error('quota_unavailable')
  if (AUTOMATION_D1_DAILY_CAP - value.rowsWritten - estimate <= HEADROOM)
    throw new Error('quota_exhausted')
}


/** Read-only admission, also required when a cycle will only classify/stage/export. */
export async function admitDiscoveryCycleWrites(
  env: AutomationPublishEnv, options: Pick<AutomationPublishOptions, 'fetch' | 'quota'>, estimate: number,
): Promise<void> {
  const quota = options.quota ? await options.quota(Date.now()) : await readAccountDailyD1Writes(env, options)
  requireQuota(quota, estimate)
}

/** Callers must supply freshly checked sources; this checks effective runtime policy. */
export async function runtimePlayable(env: CatalogueEnv, candidate: DiscoveryCandidate): Promise<boolean> {
  return (await runtimeProviders(env, candidate)).length > 0
}
type RuntimeProvider = 'gd-studio' | 'chksz' | 'lx-huibq' | 'lx-ikun'
async function runtimeProviders(env: CatalogueEnv, candidate: DiscoveryCandidate): Promise<RuntimeProvider[]> {
  const states = await readProviderStates(env.DB, env)
  const enabled = (provider: string) => states.some((s) => s.id === provider && s.effectiveEnabled)
  const valid = (provider: string) => candidate.sources.some((s) => s.provider === provider &&
    s.status === 'valid' && s.confidence >= 0.9 && validSourceId(s.provider, s.externalId))
  const available: RuntimeProvider[] = []
  if (enabled('gd-studio') && valid('gd-studio')) available.push('gd-studio')
  if (enabled('chksz') && valid('chksz') && env.CHKSZ_API_KEY && await readChkszOwnerFallbackEnabled(env.DB)) available.push('chksz')
  if (enabled('lx')) for (const provider of ['lx-huibq', 'lx-ikun'] as const) {
    if (!valid(provider) || !deploymentAvailable(provider, env)) continue
    const row = await env.DB.prepare('SELECT enabled FROM provider_health WHERE provider_key=?')
      .bind(provider).first<{ enabled: number }>()
    if (row?.enabled === 1) available.push(provider)
  }
  return available
}
/** Fixed identifiers only. Recheck mutable admin policy inside the D1 transaction. */
function runtimePredicate(providers: RuntimeProvider[] | undefined): string {
  if (!providers) return '1'
  if (!providers.length) return '0'
  return providers.map((provider) => {
    if (provider === 'lx-huibq' || provider === 'lx-ikun')
      return `(COALESCE((SELECT enabled FROM provider_health WHERE provider_key='lx'),1)=1
        AND EXISTS(SELECT 1 FROM provider_health WHERE provider_key='${provider}' AND enabled=1))`
    const enabled = `COALESCE((SELECT enabled FROM provider_health WHERE provider_key='${provider}'),1)=1`
    return provider === 'chksz' ? `(${enabled} AND EXISTS(SELECT 1 FROM admin_settings
      WHERE setting_key='provider.chksz.ownerKeyFallback' AND json_valid(setting_json)
      AND json_type(setting_json,'$.enabled')='true'
      AND (SELECT count(*) FROM json_each(setting_json))=1))` : `(${enabled})`
  }).join(' OR ')
}

/** Lifecycle revisions/times change while staging, classification and source evidence must not. */
function candidatePayload(c: DiscoveryCandidate): string {
  return JSON.stringify({
    id: c.id, trackId: c.trackId, discovery: c.discovery, suggestion: c.suggestion,
    classificationReviewed: c.classificationReviewed, sources: c.sources, conflicts: c.conflicts,
  })
}
function readPlan(value: unknown): DiscoveryAppend {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'Aliases,Sources,Tracks')
    throw new Error('automation_stage_invalid')
  let count = 0
  for (const tab of tabs) {
    const rows = value[tab]
    if (!Array.isArray(rows)) throw new Error('automation_stage_invalid')
    count += rows.length
    if (count > PROPOSAL_LIMIT) throw new Error('staging_too_many_changes')
    for (const row of rows)
      if (!Array.isArray(row) || row.length !== SHEET_HEADERS[tab].length ||
        row.some((v) => typeof v !== 'string' || v.length > 4000))
        throw new Error('automation_stage_invalid')
    if (new Set(rows.map(rowKey)).size !== rows.length) throw new Error('automation_stage_invalid')
  }
  if (JSON.stringify(value).length > 256 * 1024) throw new Error('automation_stage_invalid')
  return value as unknown as DiscoveryAppend
}
function appendPlan(book: Workbook, plan: DiscoveryAppend) {
  for (const tab of tabs) book[tab].push(...structuredClone(plan[tab]))
}
function assertCandidate(c: DiscoveryCandidate) {
  if (!c.classificationReviewed || c.conflicts.length || c.suggestion.uncertainties.length ||
    c.suggestion.vocal_status === 'uncertain' || !Number.isFinite(c.suggestion.confidence) || c.suggestion.confidence < 0.9)
    throw new Error('candidate_not_ready')
}
function validatePlan(c: DiscoveryCandidate, plan: DiscoveryAppend, snapshot: CatalogueSnapshot, now: number) {
  assertCandidate(c)
  const allowed = planDiscoveryAppend([c], exportWorkbook(snapshot), snapshot, now)
  for (const tab of tabs) {
    const rows = new Set(allowed[tab].map(rowKey))
    if (plan[tab].some((row) => !rows.has(rowKey(row)))) throw new Error('automation_stage_invalid')
  }
  for (const row of plan.Sources)
    if (!qualifiedProviders.has(row[2]) || row[1] !== c.trackId ||
      !c.sources.some((s) => s.provider === row[2] && s.externalId === row[3] && s.status === 'valid' &&
        s.confidence >= 0.9 && now >= s.checkedAt && now - s.checkedAt <= SOURCE_CHECK_TTL_MS))
      throw new Error('automation_stage_invalid')
  const projected = exportWorkbook(snapshot)
  appendPlan(projected, plan)
  const parsed = parseStaging(projected, snapshot)
  if (parsed.errors.length) throw new Error('automation_stage_invalid')
  const changes = diffStaging(parsed, snapshot)
  if (changes.some((p) => p.validationState !== 'valid' || !['new_track', 'new_source', 'new_alias'].includes(p.kind)))
    throw new Error('automation_stage_invalid')
}
interface StageRow {
  candidate_id: string
  candidate_revision: number
  candidate_json: string
  plan_json: string
  base_revision: number
  created_at: number
  status: 'recorded' | 'published' | 'superseded'
}

/**
 * Persist before stageCandidate, immediately after the fresh source/playable gate.
 * Re-recording cannot replace a consumed plan. A failed/unknown append grants no
 * authority until stageCandidate (or its exact reconciliation) reaches staged.
 */
export async function recordAutomationStage(
  db: D1Database, candidate: DiscoveryCandidate, input: DiscoveryAppend, now: number,
): Promise<void> {
  const prior = await db.prepare('SELECT * FROM catalogue_discovery_automation_stages WHERE candidate_id=?')
    .bind(candidate.id).first<StageRow>()
  if (prior && prior.status !== 'recorded') throw new Error('automation_stage_consumed')
  const current = await readCandidate(db, candidate.id)
  if (!current || current.stageState !== 'pending' || current.revision !== candidate.revision ||
    candidatePayload(current) !== candidatePayload(candidate)) throw new Error('stale_candidate')
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('automation_stage_invalid')
  const plan = readPlan(input)
  const snapshot = await readCatalogueSnapshot(db)
  validatePlan(current, plan, snapshot, now)
  const payload = candidatePayload(current), serial = JSON.stringify(plan)
  if (prior && prior.candidate_revision === current.revision && prior.candidate_json === payload &&
    prior.plan_json === serial && prior.base_revision === snapshot.revision) return
  const result = await db.prepare(`
    INSERT INTO catalogue_discovery_automation_stages
      (candidate_id,candidate_revision,candidate_json,plan_json,base_revision,created_at,status)
    SELECT ?,?,?,?,?,?,'recorded' WHERE
      EXISTS(SELECT 1 FROM catalogue_discovery_candidates WHERE candidate_id=? AND revision=? AND stage_state='pending')
      AND EXISTS(SELECT 1 FROM catalogue_state WHERE id=1 AND revision=?)
      AND NOT EXISTS(SELECT 1 FROM catalogue_discovery_sheet_operations WHERE candidate_id=?)
    ON CONFLICT(candidate_id) DO UPDATE SET
      candidate_revision=excluded.candidate_revision,candidate_json=excluded.candidate_json,
      plan_json=excluded.plan_json,base_revision=excluded.base_revision,created_at=excluded.created_at
    WHERE catalogue_discovery_automation_stages.status='recorded'
  `).bind(current.id, current.revision, payload, serial, snapshot.revision, now,
    current.id, current.revision, snapshot.revision, current.id).run()
  if (result.meta.changes !== 1) throw new Error('stale_candidate')
}

/** Ignore display row order/trailing empty cells, but never normalise authored cells. */
function canonicalRows(rows: string[][], columns: number): string[] {
  return rows.slice(1).filter((row) => row.some((cell) => cell !== '')).map((row) =>
    JSON.stringify(Array.from({ length: columns }, (_, i) => row[i] ?? ''))).sort()
}
function sameWorkbook(actual: Workbook, expected: Workbook): boolean {
  return tabs.every((tab) => same(actual[tab][0], expected[tab][0]) &&
    same(canonicalRows(actual[tab], SHEET_HEADERS[tab].length), canonicalRows(expected[tab], SHEET_HEADERS[tab].length)))
}
function proposalsKey(changes: Proposal[]): string {
  return JSON.stringify(changes.map((p) => JSON.stringify([
    p.entityType, p.entityKey, p.kind, p.before, p.after, p.confidence, p.messages, p.validationState,
  ])).sort())
}
function checkedProposals(book: Workbook, snapshot: CatalogueSnapshot): Proposal[] {
  const parsed = parseStaging(book, snapshot)
  if (parsed.errors.length) throw new Error('batch_requires_review')
  return diffStaging(parsed, snapshot)
}
function alreadyPresent(plan: DiscoveryAppend, book: Workbook): boolean {
  return tabs.every((tab) => plan[tab].every((row) =>
    book[tab].slice(1).filter((actual) => same(actual, row)).length === 1))
}
/** Includes import/review/audit/ledger writes, index maintenance and relation rewrites. */
function conservativeWrites(snapshot: CatalogueSnapshot, proposals: Proposal[], candidates: number): number {
  const tracks = new Set(proposals.map((p) => p.entityType === 'track' ? p.entityKey : String(p.after?.track_id)))
  const relations = [...snapshot.games, ...snapshot.relations].filter((r) => tracks.has(r.track_id)).length +
    proposals.reduce((n, p) => n + (Array.isArray(p.after?.games) ? p.after.games.length : 0) +
      (Array.isArray(p.after?.relations) ? p.after.relations.length : 0), 0)
  return 512 + 64 * (proposals.length + candidates) + 8 * relations
}
interface EligibleStage { row: StageRow; candidate: DiscoveryCandidate; plan: DiscoveryAppend; playable?: RuntimeProvider[] }
/** A missing/consumed ledger or changed candidate MUST abort, including after pre-reads. */
function stageGuards(db: D1Database, stages: EligibleStage[]): D1PreparedStatement[] {
  return stages.map(({ row, candidate: c, playable }) => db.prepare(`
    UPDATE catalogue_state SET revision=CASE WHEN
      EXISTS(SELECT 1 FROM catalogue_discovery_automation_stages WHERE candidate_id=? AND status='recorded'
        AND candidate_revision=? AND candidate_json=? AND plan_json=? AND base_revision=?)
      AND EXISTS(SELECT 1 FROM catalogue_discovery_candidates WHERE candidate_id=? AND revision=?
        AND stage_state='staged' AND track_id=? AND discovery_json=? AND suggestion_json=?
        AND sources_json=? AND conflicts_json=? AND classification_reviewed=1)
      AND (${runtimePredicate(playable)})
      THEN revision ELSE 0 END WHERE id=1
  `).bind(row.candidate_id, row.candidate_revision, row.candidate_json, row.plan_json, row.base_revision,
    c.id, c.revision, c.trackId, JSON.stringify(c.discovery), JSON.stringify(c.suggestion),
    JSON.stringify(c.sources), JSON.stringify(c.conflicts)))
}
/** Do not reuse a provider ticket cached by an earlier stage/cycle as fresh evidence. */
function freshProbeCache(backing?: Pick<Cache, 'match' | 'put'>): Pick<Cache, 'match' | 'put'> {
  const written = new Map<string, Response>()
  const key = (request: RequestInfo | URL) => request instanceof Request ? request.url : String(request)
  return {
    async match(request) { return written.get(key(request))?.clone() },
    async put(request, response) {
      written.set(key(request), response.clone())
      if (backing) await backing.put(request, response)
    },
  } as Pick<Cache, 'match' | 'put'>
}

export async function publishAutomationStaged(
  env: AutomationPublishEnv,
  sheets: { read(): Promise<Workbook> },
  options: AutomationPublishOptions = {},
): Promise<AutomationPublishResult> {
  const benign = new Set(['completed', 'auto_publish_disabled', 'nothing_approvable', 'already_published'])
  const result = (outcome: string, processed = 0, revision: number | null = null): AutomationPublishResult => ({
    outcome: { phase: 'publish', processed, failed: benign.has(outcome) ? 0 : 1, outcome, details: [] }, revision,
  })
  if (env.CATALOGUE_DISCOVERY_AUTOMATION !== 'enabled' || env.CATALOGUE_DISCOVERY_AUTO_PUBLISH !== 'enabled')
    return result('auto_publish_disabled')
  const now = options.now ?? Date.now
  try {
    const rows = await env.DB.prepare(`SELECT s.* FROM catalogue_discovery_automation_stages s
      JOIN catalogue_discovery_candidates c ON c.candidate_id=s.candidate_id
      WHERE s.status='recorded' AND c.stage_state='staged' ORDER BY s.created_at,s.candidate_id LIMIT ?`)
      .bind(CANDIDATE_LIMIT + 1).all<StageRow>()
    if (!rows.results.length) return result('nothing_approvable')
    if (rows.results.length > CANDIDATE_LIMIT) return result('batch_requires_review')
    const snapshot = await readCatalogueSnapshot(env.DB)
    const base = exportWorkbook(snapshot)
    const expected = structuredClone(base)
    const stages: EligibleStage[] = []
    for (const row of rows.results) {
      const candidate = await readCandidate(env.DB, row.candidate_id)
      const plan = readPlan(JSON.parse(row.plan_json))
      if (!candidate || candidate.stageState !== 'staged' ||
        candidate.revision !== row.candidate_revision + (hasRows(plan) ? 2 : 1) ||
        candidatePayload(candidate) !== row.candidate_json) throw new Error('batch_requires_review')
      assertCandidate(candidate)
      stages.push({ row, candidate, plan })
    }
    const consumed = stages.filter(({ plan }) => alreadyPresent(plan, base))
    if (consumed.length && consumed.length !== stages.length) return result('batch_requires_review')
    if (!consumed.length) {
      for (const { row, candidate, plan } of stages) {
        if (row.base_revision !== snapshot.revision) throw new Error('stale_batch')
        validatePlan(candidate, plan, snapshot, row.created_at)
        appendPlan(expected, plan)
      }
    }
    const proposals = checkedProposals(expected, snapshot)
    if (proposals.length > PROPOSAL_LIMIT) throw new Error('staging_too_many_changes')
    if (!consumed.length) {
      const actual = await sheets.read()
      const actualProposals = checkedProposals(actual, snapshot)
      if (!sameWorkbook(actual, expected) || proposalsKey(actualProposals) !== proposalsKey(proposals) ||
        proposals.some((p) => !['new_track', 'new_source', 'new_alias'].includes(p.kind)))
        return result('batch_requires_review')
      // Exercise the same projection/validation as the publisher before any import write.
      const { projected } = projectImportChanges(snapshot, proposals, now())
      if (parseStaging(exportWorkbook(projected), snapshot).errors.length) throw new Error('batch_requires_review')
      projectCatalogue(projected)
    }
    const reserve = options.cycleWriteReserve ?? 0
    if (!Number.isSafeInteger(reserve) || reserve < 0) throw new Error('quota_unavailable')
    const estimate = conservativeWrites(snapshot, proposals, stages.length) + reserve
    const quota = options.quota
      ? await options.quota(Date.now())
      : await readAccountDailyD1Writes(env, { fetch: options.fetch })
    requireQuota(quota, estimate)
    if (consumed.length) {
      await env.DB.batch([
        env.DB.prepare('UPDATE catalogue_state SET revision=CASE WHEN revision=? THEN revision ELSE 0 END WHERE id=1').bind(snapshot.revision),
        ...stageGuards(env.DB, stages),
        ...stages.map(({ row }) => env.DB.prepare("UPDATE catalogue_discovery_automation_stages SET status='superseded' WHERE candidate_id=?")
          .bind(row.candidate_id)),
      ])
      return result('already_published')
    }
    if (!proposals.length) return result('nothing_approvable')
    const cache = freshProbeCache(options.cache)
    const request = new Request(new URL('/api/admin/catalogue/discovery/automation', env.PUBLIC_ORIGIN))
    for (const stage of stages) {
      const { candidate, plan } = stage
      const checked = await recheckDiscoverySources(candidate, env, request, 'catalogue-discovery-automation', {
        fetch: options.fetch, now, cache,
      })
      const checkedAt = now()
      for (const row of plan.Sources)
        if (!checked.some((s) => s.provider === row[2] && s.externalId === row[3] && s.status === 'valid' &&
          s.confidence >= 0.9 && checkedAt >= s.checkedAt && checkedAt - s.checkedAt <= SOURCE_CHECK_TTL_MS))
          throw new Error('sources_unavailable')
      // A new verified search hit does not authorise a different runtime source ID.
      const exactSources = checked.filter((s) => plan.Sources.some((row) => row[2] === s.provider && row[3] === s.externalId) ||
        snapshot.sources.some((row) => row.track_id === candidate.trackId && row.source_status === 'active' &&
          row.provider === s.provider && row.external_id === s.externalId))
      stage.playable = await runtimeProviders(env, { ...candidate, sources: exactSources })
      if (!stage.playable.length) throw new Error('runtime_source_required')
    }
    const finalBook = await sheets.read()
    if (!sameWorkbook(finalBook, expected) || proposalsKey(checkedProposals(finalBook, snapshot)) !== proposalsKey(proposals))
      throw new Error('batch_requires_review')
    requireQuota(quota, estimate)
    const batch = await saveImportBatch(env.DB, expected, null, now())
    const owner = await env.DB.prepare('SELECT created_by FROM catalogue_import_batches WHERE batch_id=?')
      .bind(batch.batchId).first<{ created_by: string | null }>()
    if (batch.baseRevision !== snapshot.revision || !['draft', 'validated'].includes(batch.status) ||
      owner?.created_by !== null || batch.changes.some((p) => p.decision !== 'pending' || p.validationState !== 'valid') ||
      proposalsKey(batch.changes) !== proposalsKey(proposals)) throw new Error('batch_requires_review')
    await approveExactBatch(env.DB, batch, stages, now())
    const reviewed = await readImportBatch(env.DB, batch.batchId)
    if (!reviewed || reviewed.reviewRevision !== batch.reviewRevision + 1 ||
      reviewed.baseRevision !== batch.baseRevision ||
      !['draft', 'validated'].includes(reviewed.status) ||
      reviewed.changes.some((p) => p.decision !== 'approved' || p.validationState !== 'valid') ||
      proposalsKey(reviewed.changes) !== proposalsKey(batch.changes))
      throw new Error('batch_requires_review')
    await publishImportBatch(env.DB, reviewed, null, now(), async (statements) => {
      requireQuota(quota, estimate)
      const atomic = [
        ...stageGuards(env.DB, stages),
        ...statements,
        ...stages.map(({ row }) => env.DB.prepare(`UPDATE catalogue_discovery_automation_stages SET
          status='published',published_batch_id=?,published_revision=?,published_at=? WHERE candidate_id=?`)
          .bind(reviewed.batchId, snapshot.revision + 1, now(), row.candidate_id)),
      ]
      const complete = options.beforePublishBatch ? await options.beforePublishBatch(atomic) : atomic
      requireQuota(quota, estimate)
      return complete
    })
    return result('completed', proposals.length, snapshot.revision + 1)
  } catch (error) {
    // Error text may contain upstream content. Only expose fixed reason codes.
    const message = error instanceof Error ? error.message : ''
    if (message === 'quota_rate_limited') return result('quota_rate_limited')
    if (/quota|10042/i.test(message) && !message.includes('quota_unavailable')) return result('quota_exhausted')
    const safe = new Set(['quota_unavailable', 'batch_requires_review', 'stale_batch', 'sources_unavailable',
      'runtime_source_required', 'staging_too_many_changes', 'candidate_not_ready'])
    return result(safe.has(message) ? message : 'publish_failed')
  }
}
async function approveExactBatch(db: D1Database, batch: ImportBatch, stages: EligibleStage[], now: number) {
  await db.batch([
    ...stageGuards(db, stages),
    db.prepare(`UPDATE catalogue_import_batches SET review_revision=CASE WHEN
      status IN ('draft','validated') AND review_revision=? AND
      EXISTS(SELECT 1 FROM catalogue_state WHERE id=1 AND revision=?)
      THEN review_revision+1 ELSE 0 END,updated_at=? WHERE batch_id=?`)
      .bind(batch.reviewRevision, batch.baseRevision, now, batch.batchId),
    ...batch.changes.map((p) => db.prepare("UPDATE catalogue_import_changes SET decision='approved' WHERE batch_id=? AND change_id=?")
      .bind(batch.batchId, p.changeId)),
    db.prepare(`INSERT INTO admin_audit_log(id,actor_user_id,action,target_key,detail_json,created_at)
      VALUES(?,NULL,'catalogue.review',?,?,?)`).bind(crypto.randomUUID(), batch.batchId, JSON.stringify({
        automation: 'discovery-cycle', stagedCandidates: stages.map(({ row }) => row.candidate_id),
        decisions: batch.changes.map((p) => ({ id: p.changeId, decision: 'approved' })),
      }), now),
  ])
}