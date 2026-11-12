import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import { DISCOVERY_CHANNEL, discoveryCache, discoveryUpstream } from './catalogue-discovery-fixture'
import { readCatalogueSnapshot } from '../catalogue/repository'
import { exportWorkbook } from '../catalogue/staging'
import { saveImportBatch, readImportBatch } from '../catalogue/diff'
import { publishImportBatch } from '../catalogue/publish'
import { ingestManifest, readCandidate, updateCandidate } from '../catalogue/discovery/repository'
import { checkDiscoverySources } from '../catalogue/discovery/sources'
import { planDiscoveryAppend } from '../catalogue/discovery/staging'
import { stageCandidate } from '../catalogue/discovery/stageService'
import {
  recordAutomationStage, publishAutomationStaged, runtimePlayable,
  readAccountDailyD1Writes,
  type AutomationPublishOptions, type AutomationQuota,
} from '../catalogue/discovery/automationPublish'
import type { DiscoveryCandidate, DiscoveryAppend } from '../catalogue/discovery/types'
import type { Workbook } from '../catalogue/googleSheets'

const origin = 'https://study.example'
const stageTime = Date.parse('2026-11-06T00:00:00Z')
const freshQuota = async (nowMs: number): Promise<AutomationQuota> => ({
  scope: 'account', utcDate: new Date(nowMs).toISOString().slice(0, 10),
  rowsWritten: 100, checkedAt: nowMs,
})
let fixture: Awaited<ReturnType<typeof catalogueDatabase>>
let env: any
let book: Workbook
let clock: number
const sheets = () => ({
  read: async () => structuredClone(book),
  append: async (plan: DiscoveryAppend) => {
    for (const tab of ['Tracks', 'Sources', 'Aliases'] as const)
      book[tab].push(...structuredClone(plan[tab]))
  },
})
const publish = (options: AutomationPublishOptions = {}) => publishAutomationStaged(env, sheets(), {
  now: () => clock, fetch: discoveryUpstream(), cache: discoveryCache(), quota: freshQuota,
  ...options,
})
const ledger = (id: string) => fixture.db.prepare(
  'SELECT * FROM catalogue_discovery_automation_stages WHERE candidate_id=?',
).bind(id).first<any>()
const countBatches = () => fixture.db.prepare('SELECT count(*) AS n FROM catalogue_import_batches').first<number>('n')
async function ready(): Promise<DiscoveryCandidate> {
  await ingestManifest(fixture.db, {
    schemaVersion: 1, runId: 'run-one', discoveries: [{
      videoId: 'abcdefghijk', title: 'New Dawn', album: 'New Album', games: ['genshin'],
      artistChannelId: DISCOVERY_CHANNEL, albumBrowseId: 'MPRE-one', durationSeconds: 180,
      evidence: ['https://music.youtube.com/watch?v=abcdefghijk'],
    }],
  }, await readCatalogueSnapshot(fixture.db), clock)
  const row = await fixture.db.prepare('SELECT candidate_id FROM catalogue_discovery_candidates').first<{ candidate_id: string }>()
  const candidate = (await readCandidate(fixture.db, row!.candidate_id))!
  candidate.suggestion = {
    ...candidate.suggestion, games: ['genshin'], album: 'New Album', work_group_id: 'work-new-dawn',
    vocal_status: 'vocal', tabs: ['focus'], aliases: { 'zh-Hant': ['新生'] },
    relation_ids: [], confidence: 1, uncertainties: [], adapter: 'manual',
  }
  candidate.classificationReviewed = true
  candidate.conflicts = []
  candidate.sources = await checkDiscoverySources(candidate, env, new Request(origin), 'automation-fixture', {
    now: () => clock, fetch: discoveryUpstream(), cache: discoveryCache(),
  })
  expect(candidate.sources.some((s) => s.provider === 'gd-studio' && s.status === 'valid')).toBe(true)
  return updateCandidate(fixture.db, candidate, candidate.revision, clock)
}
async function staged() {
  const candidate = await ready()
  const snapshot = await readCatalogueSnapshot(fixture.db)
  const plan = planDiscoveryAppend([candidate], book, snapshot, clock)
  await recordAutomationStage(fixture.db, candidate, plan, clock)
  const current = await stageCandidate(fixture.db, sheets(), candidate, snapshot.revision, () => clock)
  return { candidate: current, plan }
}
beforeEach(async () => {
  fixture = await catalogueDatabase()
  clock = stageTime
  env = {
    DB: fixture.db, PUBLIC_ORIGIN: origin, SESSION_HMAC_SECRET: 'fixture-only-session-long-enough',
    GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
    GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.fixture.example',
    CATALOGUE_DISCOVERY_AUTOMATION: 'enabled', CATALOGUE_DISCOVERY_AUTO_PUBLISH: 'enabled',
  }
  await fixture.db.prepare("UPDATE provider_health SET enabled=1 WHERE provider_key='gd-studio'").run()
  book = exportWorkbook(await readCatalogueSnapshot(fixture.db))
})
afterEach(async () => { vi.restoreAllMocks(); await fixture?.dispose() })

describe('ledger-scoped discovery auto-publication (real Miniflare D1)', () => {
  it('publishes the exact candidate, including its null-confidence aliases, exactly once', async () => {
    const { candidate } = await staged()
    const before = (await readCatalogueSnapshot(fixture.db)).revision
    const result = await publish()
    expect(result.outcome.outcome).toBe('completed')
    expect(result.outcome.failed).toBe(0)
    expect(result.revision).toBe(before + 1)
    const snapshot = await readCatalogueSnapshot(fixture.db)
    expect(snapshot.aliases).toContainEqual({ track_id: candidate.trackId, locale: 'zh-Hant', alias: '新生' })
    const row = await ledger(candidate.id)
    expect(row.status).toBe('published')
    expect(row.published_revision).toBe(result.revision)
    const batch = (await readImportBatch(fixture.db, row.published_batch_id))!
    expect(batch.status).toBe('published')
    expect(batch.changes.find((c) => c.entityType === 'alias')).toMatchObject({ confidence: null, decision: 'approved' })
    const again = await publish()
    expect(again.revision).toBeNull()
    expect(await countBatches()).toBe(1)
    expect((await readCatalogueSnapshot(fixture.db)).revision).toBe(result.revision)
    await expect(recordAutomationStage(fixture.db, candidate, { Tracks: [], Sources: [], Aliases: [] }, clock))
      .rejects.toThrow('automation_stage_consumed')
  })

  it('does not approve unrelated high-confidence human changes or create a batch', async () => {
    const { candidate } = await staged()
    const existing = book.Tracks.find((r) => r[0] !== candidate.trackId && r[0] !== 'track_id')!
    existing[1] = 'Human title edit'
    existing[11] = '1'
    const result = await publish()
    expect(result.outcome.outcome).toBe('batch_requires_review')
    expect(result.revision).toBeNull()
    expect(await countBatches()).toBe(0)
    expect((await ledger(candidate.id)).status).toBe('recorded')
  })

  it.each(['provider', 'externalId', 'rights', 'track', 'alias'])('rejects a tampered %s cell', async (field) => {
    const { candidate } = await staged()
    const source = book.Sources.find((r) => r[1] === candidate.trackId && r[2] === 'gd-studio')!
    if (field === 'provider') { source[2] = 'r2'; source[3] = 'unapproved/file.mp3' }
    if (field === 'externalId') source[3] = 'netease:999999999'
    if (field === 'rights') source[7] = 'owner-authorised'
    if (field === 'track') book.Tracks.find((r) => r[0] === candidate.trackId)![1] = 'Different recording'
    if (field === 'alias') book.Aliases.find((r) => r[0] === candidate.trackId)![2] = 'Human alias'
    const result = await publish()
    expect(result.outcome.outcome).toBe('batch_requires_review')
    expect(await countBatches()).toBe(0)
  })

  it('does not publish a staged candidate with no automation ledger', async () => {
    const candidate = await ready()
    await stageCandidate(fixture.db, sheets(), candidate, (await readCatalogueSnapshot(fixture.db)).revision, () => clock)
    expect((await publish()).revision).toBeNull()
    expect(await countBatches()).toBe(0)
  })

  it('rejects arbitrary plans that do not come from the candidate server-qualified source IDs', async () => {
    const candidate = await ready()
    const snapshot = await readCatalogueSnapshot(fixture.db)
    const plan = planDiscoveryAppend([candidate], book, snapshot, clock)
    plan.Sources.find((r) => r[2] === 'gd-studio')![3] = 'netease:123456'
    await expect(recordAutomationStage(fixture.db, candidate, plan, clock)).rejects.toThrow()
    expect(await ledger(candidate.id)).toBeNull()
  })

  it('rechecks week-old sources and refuses a source that is now dead', async () => {
    const { candidate } = await staged()
    clock += 7 * 24 * 60 * 60 * 1000
    const upstream = discoveryUpstream()
    const network = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.hostname === 'media.fixture.example') return new Response(null, { status: 503 })
      return upstream(input, init)
    })
    const result = await publish({ fetch: network })
    expect(result.outcome.outcome).toBe('sources_unavailable')
    expect(result.revision).toBeNull()
    expect(await countBatches()).toBe(0)
    expect((await ledger(candidate.id)).status).toBe('recorded')
    expect(network).toHaveBeenCalled()
  })

  it('refuses a fresh replacement ID rather than silently rebinding the staged source', async () => {
    await staged()
    const upstream = discoveryUpstream()
    const network: typeof fetch = async (input, init) => {
      const response = await upstream(input, init)
      if (response.headers.get('content-type')?.includes('json')) {
        const body = (await response.text()).replaceAll('9876543210', '1234567890')
        return new Response(body, { headers: { 'content-type': 'application/json' } })
      }
      return response
    }
    expect((await publish({ fetch: network })).outcome.outcome).toBe('sources_unavailable')
    expect(await countBatches()).toBe(0)
  })

  it('requires effective runtime availability at publication', async () => {
    const { candidate } = await staged()
    expect(await runtimePlayable(env, candidate)).toBe(true)
    await fixture.db.prepare("UPDATE provider_health SET enabled=0 WHERE provider_key='gd-studio'").run()
    expect(await runtimePlayable(env, candidate)).toBe(false)
    expect((await publish()).revision).toBeNull()
    expect(await countBatches()).toBe(0)
  })

  it('does not make any external request or write a batch when quota configuration is missing', async () => {
    await staged()
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('network must not be used'))
    const result = await publish({ quota: undefined, fetch: network })
    expect(result.outcome.outcome).toBe('quota_unavailable')
    expect(result.outcome.failed).toBe(1)
    expect(network).not.toHaveBeenCalled()
    expect(await countBatches()).toBe(0)
  })

  it.each(['missing', 'exhausted', 'headroom', 'stale', 'future', 'wrongDay', 'database', 'NaN'])('fails closed for %s quota metrics', async (kind) => {
    await staged()
    const quota = vi.fn(async (nowMs: number) => {
      if (kind === 'missing') return null
      const value: any = await freshQuota(nowMs)
      if (kind === 'exhausted') value.rowsWritten = 100000
      if (kind === 'headroom') value.rowsWritten = 99499
      if (kind === 'stale') value.checkedAt -= 60001
      if (kind === 'future') value.checkedAt += 60001
      if (kind === 'wrongDay') value.utcDate = '2020-01-01'
      if (kind === 'database') value.scope = 'database'
      if (kind === 'NaN') value.rowsWritten = NaN
      return value
    })
    expect((await publish({ quota })).revision).toBeNull()
    expect(await countBatches()).toBe(0)
    expect(quota).toHaveBeenCalledTimes(1)
  })

  it('uses the real runtime UTC day for quota despite an injected historical candidate clock', async () => {
    await staged()
    const quota = vi.fn(freshQuota)
    const actualNow = Date.now()
    expect((await publish({ quota })).outcome.outcome).toBe('completed')
    expect(quota.mock.calls[0][0]).toBeGreaterThanOrEqual(actualNow)
  })

  it('rolls back publisher and ledger together when catalogue CAS loses', async () => {
    const { candidate } = await staged()
    const before = (await readCatalogueSnapshot(fixture.db)).revision
    const hook = vi.fn(async (statements) => {
      await fixture.db.prepare('UPDATE catalogue_state SET revision=revision+1 WHERE id=1').run()
      return statements
    })
    const result = await publish({ beforePublishBatch: hook })
    expect(result.revision).toBeNull()
    expect(hook).toHaveBeenCalledTimes(1)
    const snapshot = await readCatalogueSnapshot(fixture.db)
    expect(snapshot.revision).toBe(before + 1)
    expect(snapshot.tracks.some((t) => t.track_id === candidate.trackId)).toBe(false)
    expect((await ledger(candidate.id)).status).toBe('recorded')
    expect(await fixture.db.prepare("SELECT count(*) AS n FROM admin_audit_log WHERE action='catalogue.publish'").first<number>('n')).toBe(0)
    expect(result.outcome.failed).toBe(1)
    const approved = await fixture.db.prepare("SELECT count(*) AS n FROM catalogue_import_changes WHERE decision='approved'").first<number>('n')
    expect(approved).toBeGreaterThan(0)
    const again = await publish({ beforePublishBatch: hook })
    expect(again).toMatchObject({ revision: null, outcome: { outcome: 'stale_batch', failed: 1 } })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(await countBatches()).toBe(1)
    expect((await ledger(candidate.id)).status).toBe('recorded')
  })

  it('checks staged candidate CAS inside the publisher transaction', async () => {
    const { candidate } = await staged()
    const hook = vi.fn(async (statements) => {
      await updateCandidate(fixture.db, { ...candidate, stageState: 'pending' }, candidate.revision, clock)
      return statements
    })
    expect((await publish({ beforePublishBatch: hook })).revision).toBeNull()
    expect(hook).toHaveBeenCalledTimes(1)
    expect((await ledger(candidate.id)).status).toBe('recorded')
    expect((await readCatalogueSnapshot(fixture.db)).tracks.some((t) => t.track_id === candidate.trackId)).toBe(false)
  })

  it('does not duplicate a plan already published by a human', async () => {
    const { candidate } = await staged()
    const batch = await saveImportBatch(fixture.db, book, null, clock)
    await fixture.db.prepare("UPDATE catalogue_import_changes SET decision='approved' WHERE batch_id=?").bind(batch.batchId).run()
    await publishImportBatch(fixture.db, (await readImportBatch(fixture.db, batch.batchId))!, null, clock)
    expect((await publish()).revision).toBeNull()
    expect((await ledger(candidate.id)).status).toBe('superseded')
    expect(await countBatches()).toBe(1)
    expect((await publish()).revision).toBeNull()
    expect(await countBatches()).toBe(1)
  })

  it('rolls back publication when runtime policy is disabled at the final transaction boundary', async () => {
    const { candidate } = await staged()
    const hook = vi.fn(async (statements) => {
      await fixture.db.prepare("UPDATE provider_health SET enabled=0 WHERE provider_key='gd-studio'").run()
      return statements
    })
    const result = await publish({ beforePublishBatch: hook })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(result.revision).toBeNull()
    expect((await ledger(candidate.id)).status).toBe('recorded')
    expect((await readCatalogueSnapshot(fixture.db)).tracks.some((t) => t.track_id === candidate.trackId)).toBe(false)
  })

  it('rolls back all catalogue writes if a statement fails after the ledger is marked published', async () => {
    const { candidate } = await staged()
    const before = (await readCatalogueSnapshot(fixture.db)).revision
    const hook = vi.fn(async (statements) => [
      ...statements, fixture.db.prepare('INSERT INTO catalogue_state(id,revision) VALUES(1,0)'),
    ])
    expect((await publish({ beforePublishBatch: hook })).revision).toBeNull()
    expect(hook).toHaveBeenCalledTimes(1)
    expect((await ledger(candidate.id)).status).toBe('recorded')
    const snapshot = await readCatalogueSnapshot(fixture.db)
    expect(snapshot.revision).toBe(before)
    expect(snapshot.tracks.some((t) => t.track_id === candidate.trackId)).toBe(false)
    expect(await fixture.db.prepare("SELECT count(*) AS n FROM admin_audit_log WHERE action='catalogue.publish'").first<number>('n')).toBe(0)
  })
  it('requires enough quota for the conservative plan estimate as well as the 500-row reserve', async () => {
    await staged()
    const quota = async (nowMs: number) => ({ ...await freshQuota(nowMs), rowsWritten: 99000 })
    expect((await publish({ quota })).outcome.outcome).toBe('quota_exhausted')
    expect(await countBatches()).toBe(0)
  })

  it('uses the configured read-only GraphQL default, through a fake network boundary only', async () => {
    await staged()
    env.CATALOGUE_DISCOVERY_CF_ACCOUNT_ID = 'a'.repeat(32)
    env.CATALOGUE_DISCOVERY_QUOTA_API_TOKEN = 'fixture-only-analytics'
    const upstream = discoveryUpstream()
    const network = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input) === 'https://api.cloudflare.com/client/v4/graphql')
        return Response.json({ data: { viewer: { accounts: [
          { d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 100 } }] },
        ] } } })
      return upstream(input, init)
    })
    expect((await publish({ quota: undefined, fetch: network })).outcome.outcome).toBe('completed')
    expect(network.mock.calls.filter(([input]) => String(input).includes('api.cloudflare.com'))).toHaveLength(1)
  })

  it('rejects human workbook changes made while the sources are being rechecked', async () => {
    const { candidate } = await staged()
    const upstream = discoveryUpstream()
    const network: typeof fetch = async (input, init) => {
      book.Tracks.find((r) => r[0] !== candidate.trackId && r[0] !== 'track_id')![1] = 'Concurrent human edit'
      return upstream(input, init)
    }
    expect((await publish({ fetch: network })).outcome.outcome).toBe('batch_requires_review')
    expect(await countBatches()).toBe(0)
  })

  it('does not publish when a concurrent consumer removes its stage ledger at the transaction boundary', async () => {
    const { candidate } = await staged()
    const before = (await readCatalogueSnapshot(fixture.db)).revision
    const hook = vi.fn(async (statements) => {
      await fixture.db.prepare('DELETE FROM catalogue_discovery_automation_stages WHERE candidate_id=?').bind(candidate.id).run()
      return statements
    })
    expect((await publish({ beforePublishBatch: hook })).revision).toBeNull()
    expect(hook).toHaveBeenCalledTimes(1)
    expect((await readCatalogueSnapshot(fixture.db)).revision).toBe(before)
    expect((await readCatalogueSnapshot(fixture.db)).tracks.some((t) => t.track_id === candidate.trackId)).toBe(false)
  })

  it('keeps a recorded but uncertain append outside publication authority', async () => {
    const { candidate } = await staged()
    await updateCandidate(fixture.db, { ...candidate, stageState: 'uncertain' }, candidate.revision, clock)
    const network = vi.fn<typeof fetch>()
    expect((await publish({ fetch: network })).revision).toBeNull()
    expect(network).not.toHaveBeenCalled()
    expect(await countBatches()).toBe(0)
  })

  it('rejects more than 20 staged ledger candidates before any external request', async () => {
    const { candidate } = await staged()
    const statements = []
    for (let i = 1; i <= 20; i++) {
      const id = candidate.id + '-limit-' + i
      statements.push(fixture.db.prepare(`INSERT INTO catalogue_discovery_candidates
        SELECT ?,?,track_id,discovery_json,suggestion_json,classification_reviewed,sources_json,
          conflicts_json,revision,stage_state,created_at,updated_at
        FROM catalogue_discovery_candidates WHERE candidate_id=?`).bind(id, 'limit-video-' + i, candidate.id))
      statements.push(fixture.db.prepare(`INSERT INTO catalogue_discovery_automation_stages
        (candidate_id,candidate_revision,candidate_json,plan_json,base_revision,created_at,status)
        SELECT ?,candidate_revision,candidate_json,plan_json,base_revision,created_at,status
        FROM catalogue_discovery_automation_stages WHERE candidate_id=?`).bind(id, candidate.id))
    }
    await fixture.db.batch(statements)
    const network = vi.fn<typeof fetch>()
    expect((await publish({ fetch: network })).outcome.outcome).toBe('batch_requires_review')
    expect(network).not.toHaveBeenCalled()
    expect(await countBatches()).toBe(0)
  })

  it('rejects a combined ledger projection larger than 200 proposals before writing an import batch', async () => {
    let first = await ready()
    first = await updateCandidate(fixture.db, { ...first, suggestion: {
      ...first.suggestion, aliases: { en: Array.from({ length: 100 }, (_, i) => 'Alias ' + i) },
    } }, first.revision, clock)
    const snapshot = await readCatalogueSnapshot(fixture.db)
    const plan = planDiscoveryAppend([first], book, snapshot, clock)
    await recordAutomationStage(fixture.db, first, plan, clock)
    await stageCandidate(fixture.db, sheets(), first, snapshot.revision, () => clock)
    // A second server-qualified fixture candidate; the size gate runs before any source I/O.
    const second: DiscoveryCandidate = { ...first, id: 'hoyo-limit-second', trackId: 'hoyo-limit-second', revision: 1,
      discovery: { ...first.discovery, videoId: 'bcdefghijkl' },
      sources: first.sources.map((source) => ({ ...source,
        externalId: source.provider === 'youtube' ? 'bcdefghijkl' : source.externalId.replace('9876543210', '9876543211'),
      })),
    }
    await fixture.db.prepare(`INSERT INTO catalogue_discovery_candidates
      (candidate_id,video_id,track_id,discovery_json,suggestion_json,classification_reviewed,sources_json,
        conflicts_json,revision,stage_state,created_at,updated_at) VALUES(?,?,?,?,?,1,?,'[]',1,'pending',?,?)`)
      .bind(second.id, second.discovery.videoId, second.trackId, JSON.stringify(second.discovery),
        JSON.stringify(second.suggestion), JSON.stringify(second.sources), clock, clock).run()
    const secondPlan = planDiscoveryAppend([second], book, snapshot, clock)
    await recordAutomationStage(fixture.db, second, secondPlan, clock)
    // Stage the exact recorded append via D1's real lifecycle, then exceed only the combined publisher bound.
    for (const tab of ['Tracks', 'Sources', 'Aliases'] as const) book[tab].push(...structuredClone(secondPlan[tab]))
    await fixture.db.prepare("UPDATE catalogue_discovery_candidates SET stage_state='staged',revision=revision+2 WHERE candidate_id=?")
      .bind(second.id).run()
    const network = vi.fn<typeof fetch>()
    expect((await publish({ fetch: network })).outcome.outcome).toBe('staging_too_many_changes')
    expect(network).not.toHaveBeenCalled()
    expect(await countBatches()).toBe(0)
  })

  it('preserves nullable exact row intents and enforces valid JSON in the migration', async () => {
    await fixture.db.prepare("INSERT INTO catalogue_discovery_automation_rows(tab,row_key,created_at) VALUES('Discoveries','a',1)").run()
    expect(await fixture.db.prepare("SELECT payload_json FROM catalogue_discovery_automation_rows WHERE row_key='a'").first<string>('payload_json')).toBeNull()
    await fixture.db.prepare("UPDATE catalogue_discovery_automation_rows SET payload_json=? WHERE row_key='a'").bind('{"row":["exact"]}').run()
    await expect(fixture.db.prepare("UPDATE catalogue_discovery_automation_rows SET payload_json='invalid' WHERE row_key='a'").run()).rejects.toThrow()
  })
  it('does not retry an approved batch after an unknown publisher outcome', async () => {
    const { candidate } = await staged()
    const before = (await readCatalogueSnapshot(fixture.db)).revision
    const hook = vi.fn(async () => { throw new Error('fixture_unknown_publisher_outcome') })
    const first = await publish({ beforePublishBatch: hook })
    expect(first).toMatchObject({ revision: null, outcome: { outcome: 'publish_failed', failed: 1 } })
    expect((await ledger(candidate.id)).status).toBe('recorded')
    expect(await fixture.db.prepare("SELECT count(*) AS n FROM catalogue_import_changes WHERE decision='approved'").first<number>('n')).toBeGreaterThan(0)
    const again = await publish({ beforePublishBatch: hook })
    expect(again).toMatchObject({ revision: null, outcome: { outcome: 'batch_requires_review', failed: 1 } })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(await countBatches()).toBe(1)
    expect((await readCatalogueSnapshot(fixture.db)).revision).toBe(before)
    expect((await ledger(candidate.id)).status).toBe('recorded')
    expect(await fixture.db.prepare("SELECT count(*) AS n FROM admin_audit_log WHERE action='catalogue.publish'").first<number>('n')).toBe(0)
  })
  it('does not retry a quota/10042 failure', async () => {
    const { candidate } = await staged()
    const hook = vi.fn(async () => { throw new Error('D1_ERROR: quota exceeded (10042)') })
    const result = await publish({ beforePublishBatch: hook })
    expect(result.outcome.outcome).toBe('quota_exhausted')
    expect(hook).toHaveBeenCalledTimes(1)
    expect((await ledger(candidate.id)).status).toBe('recorded')
  })
})

describe('account-wide daily D1 analytics read-only boundary', () => {
  it('does not call fetch without complete quota configuration', async () => {
    const network = vi.fn<typeof fetch>()
    expect(await readAccountDailyD1Writes(env, { fetch: network })).toBeNull()
    expect(network).not.toHaveBeenCalled()
  })
  it('queries only the fixed GraphQL endpoint for today UTC across the account', async () => {
    const today = new Date(Date.now()).toISOString().slice(0, 10)
    const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { viewer: { accounts: [
      { d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 123 } }] },
    ] } } }))
    const metrics = await readAccountDailyD1Writes({ ...env,
      CATALOGUE_DISCOVERY_CF_ACCOUNT_ID: 'a'.repeat(32),
      CATALOGUE_DISCOVERY_QUOTA_API_TOKEN: 'fixture-analytics-read-only',
    }, { fetch: network })
    expect(metrics).toMatchObject({ scope: 'account', utcDate: today, rowsWritten: 123 })
    expect(network).toHaveBeenCalledTimes(1)
    const [url, init] = network.mock.calls[0]
    expect(String(url)).toBe('https://api.cloudflare.com/client/v4/graphql')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(init!.signal).toBeInstanceOf(AbortSignal)
    const payload = JSON.parse(String(init!.body))
    expect(payload.query).toContain('d1AnalyticsAdaptiveGroups')
    expect(payload.query).toContain('rowsWritten')
    expect(payload.query).not.toContain('databaseId')
    expect(payload.variables).toMatchObject({ start: today, end: today })
  })
  it.each([
    {}, { errors: [{ message: 'permission denied' }] },
    { data: { viewer: { accounts: [] } } },
    { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [] }] } } },
    { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: '1' } }] }] } } },
    { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 1 } }, { sum: { rowsWritten: 2 } }] }] } } },
  ])('rejects missing, invalid or ambiguous metrics without retrying', async (body) => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))
    expect(await readAccountDailyD1Writes({ ...env,
      CATALOGUE_DISCOVERY_CF_ACCOUNT_ID: 'a'.repeat(32), CATALOGUE_DISCOVERY_QUOTA_API_TOKEN: 'fixture',
    }, { fetch: network })).toBeNull()
    expect(network).toHaveBeenCalledTimes(1)
  })
  it.each([
    { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: -1 } }] }] } } },
    { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 0.5 } }] }] } } },
    { data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 1 } }] }, {}] } } },
    { errors: [{ message: 'partial' }], data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 1 } }] }] } } },
  ])('refuses non-integral, partial or ambiguous account metrics', async (body) => {
    const network = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body))
    expect(await readAccountDailyD1Writes({ ...env,
      CATALOGUE_DISCOVERY_CF_ACCOUNT_ID: 'a'.repeat(32), CATALOGUE_DISCOVERY_QUOTA_API_TOKEN: 'fixture',
    }, { fetch: network })).toBeNull()
    expect(network).toHaveBeenCalledTimes(1)
  })
  it.each(['oversized', 'redirect', 'timeout'])('fails closed without retrying %s responses', async (failure) => {
    const network = vi.fn<typeof fetch>(async () => {
      if (failure === 'timeout') throw new DOMException('fixture timeout', 'TimeoutError')
      if (failure === 'redirect') return Response.redirect('https://untrusted.example/metrics')
      return new Response('{"padding":"' + 'x'.repeat(32 * 1024) + '"}', { headers: { 'content-type': 'application/json' } })
    })
    expect(await readAccountDailyD1Writes({ ...env,
      CATALOGUE_DISCOVERY_CF_ACCOUNT_ID: 'a'.repeat(32), CATALOGUE_DISCOVERY_QUOTA_API_TOKEN: 'fixture',
    }, { fetch: network })).toBeNull()
    expect(network).toHaveBeenCalledTimes(1)
  })})

describe('Spec128 exact-plan and subsource policy regressions', () => {
  it('aborts the whole plan when a human rejects its alias after auto-approval', async () => {
    const { candidate } = await staged()
    const originalBatch = fixture.db.batch.bind(fixture.db)
    let injected = false
    const concurrentDb = {
      prepare: fixture.db.prepare.bind(fixture.db),
      batch: async (statements: any[]) => {
        const result = await originalBatch(statements)
        if (!injected) {
          const alias = await fixture.db.prepare("SELECT batch_id,change_id FROM catalogue_import_changes WHERE entity_type='alias' AND decision='approved'").first<{ batch_id: string; change_id: string }>()
          if (alias) {
            injected = true
            // Same atomic review mutation as the authenticated Admin decision path.
            await originalBatch([
              fixture.db.prepare('UPDATE catalogue_import_batches SET review_revision=review_revision+1 WHERE batch_id=?').bind(alias.batch_id),
              fixture.db.prepare("UPDATE catalogue_import_changes SET decision='rejected' WHERE batch_id=? AND change_id=?").bind(alias.batch_id, alias.change_id),
            ])
          }
        }
        return result
      },
    }
    const result = await publishAutomationStaged({ ...env, DB: concurrentDb } as typeof env, sheets(), {
      now: () => clock, fetch: discoveryUpstream(), cache: discoveryCache(), quota: freshQuota,
    })
    expect(injected).toBe(true)
    expect(result.revision).toBeNull()
    const snapshot = await readCatalogueSnapshot(fixture.db)
    expect(snapshot.revision).toBe(1)
    expect(snapshot.tracks.some((t) => t.track_id === candidate.trackId)).toBe(false)
    expect((await ledger(candidate.id)).status).toBe('recorded')
    expect(await fixture.db.prepare("SELECT count(*) AS n FROM catalogue_import_changes WHERE entity_type='alias' AND decision='rejected'").first('n')).toBe(1)
  })

  it('rolls back the exact plan when its only LX subsource is disabled at the terminal CAS', async () => {
    let candidate = await ready()
    candidate = await updateCandidate(fixture.db, { ...candidate, sources: [{
      provider: 'lx-huibq', externalId: 'wy:9876543210:320k', status: 'valid',
      reason: 'resolver_audio_probe', confidence: 0.95, checkedAt: clock,
    }] }, candidate.revision, clock)
    const snapshot = await readCatalogueSnapshot(fixture.db)
    const plan = planDiscoveryAppend([candidate], book, snapshot, clock)
    await recordAutomationStage(fixture.db, candidate, plan, clock)
    candidate = await stageCandidate(fixture.db, sheets(), candidate, snapshot.revision, () => clock)
    env.LX_HUIBQ_API_BASE_URL = 'https://lx.fixture.example'
    env.LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES = 'media.fixture.example'
    env.LX_HUIBQ_REQUEST_KEY = 'fixture-only'
    await fixture.db.prepare("UPDATE provider_health SET enabled=1 WHERE provider_key='lx-huibq'").run()
    const sources = await import('../catalogue/discovery/sources')
    vi.spyOn(sources, 'checkDiscoverySources').mockResolvedValue(candidate.sources)
    const hook = vi.fn(async (statements) => {
      await fixture.db.prepare("UPDATE provider_health SET enabled=0 WHERE provider_key='lx-huibq'").run()
      return statements
    })
    const result = await publish({ beforePublishBatch: hook })
    expect(hook).toHaveBeenCalledTimes(1)
    expect(result.revision).toBeNull()
    expect((await readCatalogueSnapshot(fixture.db)).revision).toBe(snapshot.revision)
    expect((await ledger(candidate.id)).status).toBe('recorded')
  })
})
