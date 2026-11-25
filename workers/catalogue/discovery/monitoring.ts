import type { CatalogueEnv } from '../adminRoutes'
import { sheetsConfigured } from '../googleSheets'
import { SUGGESTION_STALE_MS, type CycleResult } from './automationCycle'
import type { DiscoveryMonitoring, DiscoveryRun } from './types'

export const SCANNER_STALE_MS = 7 * 24 * 60 * 60 * 1000

const present = (value: string | undefined) => Boolean(value?.trim())
const optIn = (value: string | undefined) => !present(value) ? 'missing' : value === 'enabled' ? 'enabled' : 'disabled'

/** Local configuration and durable observations only. Never probes an external account. */
export async function readDiscoveryMonitoring(
  env: CatalogueEnv,
  cycles: CycleResult[],
  latestRun: DiscoveryRun | undefined,
  channelsValid: boolean,
  now: number,
): Promise<DiscoveryMonitoring> {
  const [counts, published, failure] = await Promise.all([
    env.DB.prepare(`SELECT count(*) AS discovered,
      coalesce(sum(classification_reviewed),0) AS classified,
      coalesce(sum(CASE WHEN stage_state='pending' AND classification_reviewed=0 THEN 1 ELSE 0 END),0) AS waiting,
      min(CASE WHEN stage_state='pending' AND classification_reviewed=0 THEN created_at END) AS oldest
      FROM catalogue_discovery_candidates`).first<{ discovered: number; classified: number; waiting: number; oldest: number | null }>(),
    env.DB.prepare("SELECT count(*) AS published FROM catalogue_discovery_automation_stages WHERE status='published'").first<number>('published'),
    env.DB.prepare("SELECT run_id,created_at,summary_json FROM catalogue_discovery_runs WHERE json_extract(summary_json,'$.outcome')!='completed' ORDER BY created_at DESC,rowid DESC LIMIT 1")
      .first<{ run_id: string; created_at: number; summary_json: string }>(),
  ])
  const sheets = sheetsConfigured(env)
  const waiting = counts?.waiting ?? 0
  const oldestPendingAt = counts?.oldest ?? null
  const suggest = cycles[0]?.phases.find((phase) => phase.phase === 'suggest')
  // The cycle catch also uses `suggest` for lease/database failures before import.
  // Only row rejections and the importer's known transport/schema outcomes identify
  // a Suggestions failure. Other failures remain visible in the overall cycle.
  const importFailure = suggest && (suggest.failed > 0 || [
    'sheet_rate_limited', 'sheets_unavailable', 'suggestions_tab_missing', 'automation_sheet_contract',
  ].includes(suggest.outcome))
  const reason = importFailure ? suggest.outcome : null
  const state = !sheets ? 'unconfigured' : reason ? 'error'
    : oldestPendingAt !== null && now - oldestPendingAt > SUGGESTION_STALE_MS ? 'stale'
    : waiting ? 'waiting' : 'idle'
  const quotaPresent = [env.CATALOGUE_DISCOVERY_CF_ACCOUNT_ID, env.CATALOGUE_DISCOVERY_QUOTA_API_TOKEN].some(present)
  const quotaValid = /^[a-f0-9]{32}$/i.test(env.CATALOGUE_DISCOVERY_CF_ACCOUNT_ID ?? '') &&
    /^[\x21-\x7e]{1,1024}$/.test(env.CATALOGUE_DISCOVERY_QUOTA_API_TOKEN ?? '')
  return {
    configuration: {
      automation: optIn(env.CATALOGUE_DISCOVERY_AUTOMATION),
      autoPublish: optIn(env.CATALOGUE_DISCOVERY_AUTO_PUBLISH),
      channels: channelsValid ? 'configured' : present(env.CATALOGUE_DISCOVERY_CHANNEL_IDS) ? 'invalid' : 'missing',
      ingestion: !present(env.CATALOGUE_DISCOVERY_INGEST_TOKEN) ? 'missing'
        : env.CATALOGUE_DISCOVERY_INGEST_TOKEN!.trim().length >= 32 && env.CATALOGUE_DISCOVERY_INGEST_TOKEN!.trim().length <= 512 ? 'configured' : 'invalid',
      sheets: sheets ? 'configured' : [env.CATALOGUE_SHEET_ID, env.GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_SHEETS_PRIVATE_KEY].some(present) ? 'invalid' : 'missing',
      quota: quotaValid ? 'configured' : quotaPresent ? 'invalid' : 'missing',
    },
    // Neither Worker deployment triggers nor repository schedules are available from env.
    schedule: 'unverified',
    counts: { discovered: counts?.discovered ?? 0, classified: counts?.classified ?? 0, published: published ?? 0 },
    externalAi: { connection: 'unverified', state, waiting, oldestPendingAt, reason },
    scanner: {
      visibility: 'worker-records-only',
      lastRun: latestRun ?? null,
      lastFailure: failure ? { runId: failure.run_id, createdAt: failure.created_at, ...JSON.parse(failure.summary_json) } : null,
      ageMs: latestRun ? Math.max(0, now - latestRun.createdAt) : null,
      stale: latestRun ? now - latestRun.createdAt > SCANNER_STALE_MS : false,
    },
  }
}
