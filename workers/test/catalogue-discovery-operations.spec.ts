import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import { createAuthHandler } from '../auth/routes'
import { createDiscoveryAdminHandler } from '../catalogue/discovery/routes'
import { ingestManifest } from '../catalogue/discovery/repository'
import { readCatalogueSnapshot } from '../catalogue/repository'
import { SUGGESTION_STALE_MS, runDiscoveryAutomationCycle } from '../catalogue/discovery/automationCycle'
import { SCANNER_STALE_MS } from '../catalogue/discovery/monitoring'
import { DISCOVERY_CHANNEL } from './catalogue-discovery-fixture'

const origin = 'https://study.example'
const now = Date.UTC(2026, 10, 15)
let fixture: Awaited<ReturnType<typeof catalogueDatabase>>
let env: any
let cookie: string
const upstream = vi.fn<typeof fetch>()
beforeEach(async () => {
  fixture = await catalogueDatabase()
  env = { DB: fixture.db, PUBLIC_ORIGIN: origin, SESSION_HMAC_SECRET: 'test-session-long-enough' }
  await fixture.db.prepare("INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES('operator','Operator','owner',1,1)").run()
  cookie = '__Host-session=' + (await createAuthHandler(env, { now: () => now }).issueSession('operator')).token
  upstream.mockReset()
})
afterEach(async () => fixture?.dispose())
const request = (method = 'GET', path = '', authenticated = true, requestOrigin = origin) => new Request(origin + '/api/admin/catalogue/discovery' + path, {
  method, headers: { origin: requestOrigin, ...(authenticated ? { cookie } : {}) },
})
const handler = () => createDiscoveryAdminHandler(env, { now: () => now, fetch: upstream })
const status = async () => {
  const response = await handler().fetch(request())
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  return response.json() as Promise<any>
}
async function cycle(outcome = 'completed', phases: unknown[] = [], at = now - 1000) {
  await fixture.db.prepare('INSERT INTO catalogue_discovery_automation_cycles VALUES(?,?,?,?,?,?)')
    .bind('cycle-' + at, at, at + 100, outcome, JSON.stringify(phases), null).run()
}
async function candidates(count = 1, at = now - 1000) {
  await ingestManifest(fixture.db, { schemaVersion: 1, runId: 'ops-fixture', discoveries: Array.from({ length: count }, (_, i) => ({
    videoId: String(i).padStart(11, '0'), title: 'New track ' + i, album: 'New album', games: ['genshin'],
    artistChannelId: DISCOVERY_CHANNEL, albumBrowseId: 'MPRE-ops', evidence: ['https://music.youtube.com/browse/MPRE-ops'],
  })) }, await readCatalogueSnapshot(fixture.db), at)
}
function configureSheets() {
  Object.assign(env, { CATALOGUE_SHEET_ID: 'test-sheet', GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: 'a@test.iam.gserviceaccount.com', GOOGLE_SHEETS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY----- fixture' })
}

describe('read-only discovery operations', () => {
  it('reports absent configuration and unknown live schedules without contacting providers or Sheets', async () => {
    const database = env.DB
    env.DB = new Proxy(database, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        expect(sql.trim()).toMatch(/^SELECT\b/i)
        return database.prepare(sql)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    const value = await status()
    expect(value.automation).toMatchObject({ enabled: false, autoPublish: false, canRun: false, cycles: [] })
    expect(value.monitoring.configuration).toEqual({ automation: 'missing', autoPublish: 'missing', channels: 'missing', ingestion: 'missing', sheets: 'missing', quota: 'missing' })
    expect(value.monitoring.schedule).toBe('unverified')
    expect(value.monitoring.externalAi).toMatchObject({ connection: 'unverified', state: 'unconfigured', waiting: 0, oldestPendingAt: null })
    expect(value.monitoring.scanner).toMatchObject({ visibility: 'worker-records-only', lastRun: null, lastFailure: null, ageMs: null, stale: false })
    expect(value.monitoring.counts).toEqual({ discovered: 0, classified: 0, published: 0 })
    expect(upstream).not.toHaveBeenCalled()
  })
  it('keeps disabled history visible and distinguishes disabled and partial invalid settings from missing ones', async () => {
    env.CATALOGUE_DISCOVERY_AUTOMATION = 'disabled'
    env.CATALOGUE_DISCOVERY_AUTO_PUBLISH = 'true'
    env.CATALOGUE_DISCOVERY_CHANNEL_IDS = 'invalid'
    env.CATALOGUE_SHEET_ID = 'partial-sheet'
    env.CATALOGUE_DISCOVERY_CF_ACCOUNT_ID = 'invalid'
    await cycle('failed', [{ phase: 'suggest', processed: 0, failed: 0, outcome: 'sheets_unavailable', details: [] }])
    const value = await status()
    expect(value.monitoring.configuration).toMatchObject({ automation: 'disabled', autoPublish: 'disabled', channels: 'invalid', sheets: 'invalid', quota: 'invalid' })
    expect(value.automation.cycles).toHaveLength(1)
    expect(value.automation.cycles[0].finishedAt).toBe(now - 900)
    expect(value.automation.canRun).toBe(false)
  })
  it('counts the whole inbox, not the first 50, and exposes stale classification without claiming an AI connection', async () => {
    configureSheets()
    await candidates(60, now - SUGGESTION_STALE_MS - 1)
    await fixture.db.prepare('UPDATE catalogue_discovery_candidates SET classification_reviewed=1 WHERE candidate_id IN (SELECT candidate_id FROM catalogue_discovery_candidates LIMIT 3)').run()
    const value = await status()
    expect(value.candidates).toHaveLength(50)
    expect(value.monitoring.counts).toEqual({ discovered: 60, classified: 3, published: 0 })
    expect(value.monitoring.externalAi).toMatchObject({ state: 'stale', waiting: 57, connection: 'unverified', oldestPendingAt: now - SUGGESTION_STALE_MS - 1 })
    expect(value.monitoring.scanner).toMatchObject({ ageMs: SUGGESTION_STALE_MS + 1, stale: true })
  })
  it('shows waiting until the existing fourteen-day boundary, and a suggest read failure even when failed is zero', async () => {
    configureSheets()
    await candidates(1, now - SUGGESTION_STALE_MS)
    expect((await status()).monitoring.externalAi.state).toBe('waiting')
    await cycle('failed', [{ phase: 'suggest', processed: 0, failed: 0, outcome: 'sheet_rate_limited', details: [] }])
    expect((await status()).monitoring.externalAi).toMatchObject({ state: 'error', reason: 'sheet_rate_limited', waiting: 1 })
    expect(upstream).not.toHaveBeenCalled()
  })
  it('does not interpret a source or publication failure as an external AI error', async () => {
    configureSheets()
    await candidates()
    await cycle('failed', [{ phase: 'suggest', processed: 0, failed: 0, outcome: 'completed', details: [] }, { phase: 'stage', processed: 0, failed: 1, outcome: 'all_failed', details: ['runtime_source_required'] }])
    expect((await status()).monitoring.externalAi.state).toBe('waiting')
  })
  it('keeps a lease failure before Suggestions access at cycle level', async () => {
    configureSheets()
    await candidates()
    env.CATALOGUE_DISCOVERY_AUTOMATION = 'enabled'
    let calls = 0
    const readAutomation = vi.fn()
    const result = await runDiscoveryAutomationCycle(env, {
      force: true,
      now: () => calls++ === 0 ? now : now + 120001,
      quota: async (at) => ({ scope: 'account', utcDate: new Date(at).toISOString().slice(0, 10), rowsWritten: 0, checkedAt: at }),
      sheets: { read: vi.fn(), readAutomation, appendAutomation: vi.fn() },
    })
    expect(result).toMatchObject({ outcome: 'failed', phases: [{ phase: 'suggest', outcome: 'discovery_busy' }] })
    expect(readAutomation).not.toHaveBeenCalled()
    const value = await status()
    expect(value.automation.cycles[0].outcome).toBe('failed')
    expect(value.monitoring.externalAi).toMatchObject({ state: 'waiting', reason: null, connection: 'unverified' })
  })
  it('keeps the latest scanner failure visible after more than thirty subsequent successful imports', async () => {
    const summary = (outcome: string) => JSON.stringify({ outcome, discovered: 0, added: 0, repeated: 0 })
    await fixture.db.prepare('INSERT INTO catalogue_discovery_runs VALUES(?,?,?,?)').bind('failure', 'failed', summary('discovery_rate_limited'), now - SCANNER_STALE_MS - 1).run()
    await fixture.db.batch(Array.from({ length: 31 }, (_, i) => fixture.db.prepare('INSERT INTO catalogue_discovery_runs VALUES(?,?,?,?)').bind('success-' + i, 'hash', summary('completed'), now - i)))
    const value = await status()
    expect(value.runs).toHaveLength(30)
    expect(value.monitoring.scanner).toMatchObject({ lastRun: { runId: 'success-0' }, lastFailure: { runId: 'failure', outcome: 'discovery_rate_limited' }, ageMs: 0, stale: false })
  })
  it('keeps the weekly scanner fresh up to seven days even with daily Worker cycles', async () => {
    const week = 7 * 24 * 60 * 60 * 1000
    await candidates(1, now - week)
    expect((await status()).monitoring.scanner).toMatchObject({ ageMs: week, stale: false })
    await fixture.db.prepare('UPDATE catalogue_discovery_runs SET created_at=? WHERE run_id=?').bind(now - week - 1, 'ops-fixture').run()
    expect((await status()).monitoring.scanner.stale).toBe(true)
  })
  it('retains authentication, owner-only Run Now, opt-in and same-origin guards', async () => {
    expect((await handler().fetch(request('GET', '', false))).status).toBe(401)
    expect((await handler().fetch(request('POST', '/automation/run'))).status).toBe(503)
    env.CATALOGUE_DISCOVERY_AUTOMATION = 'enabled'
    expect((await status()).automation.canRun).toBe(true)
    await fixture.db.prepare("UPDATE users SET role='admin' WHERE id='operator'").run()
    expect((await status()).automation.canRun).toBe(false)
    expect((await handler().fetch(request('POST', '/automation/run'))).status).toBe(403)
    expect((await handler().fetch(request('POST', '/automation/run', true, 'https://other.example'))).status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })
  it('keeps Run Now quota admission closed without recording a synthetic success or contacting Sheets', async () => {
    env.CATALOGUE_DISCOVERY_AUTOMATION = 'enabled'
    const response = await handler().fetch(request('POST', '/automation/run'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ outcome: 'failed', phases: [{ phase: 'publish', failed: 1, outcome: 'quota_unavailable' }] })
    expect((await status()).automation.cycles).toEqual([])
    expect(await fixture.db.prepare('SELECT count(*) AS n FROM catalogue_discovery_locks').first('n')).toBe(0)
    expect(upstream).not.toHaveBeenCalled()
  })
  it('exposes valid local configuration without disclosing or verifying credential values', async () => {
    configureSheets()
    Object.assign(env, { CATALOGUE_DISCOVERY_CF_ACCOUNT_ID: 'a'.repeat(32), CATALOGUE_DISCOVERY_QUOTA_API_TOKEN: 'fixture-quota-secret', CATALOGUE_DISCOVERY_INGEST_TOKEN: 'i'.repeat(32), CATALOGUE_DISCOVERY_CHANNEL_IDS: DISCOVERY_CHANNEL })
    const value = await status()
    expect(value.monitoring.configuration).toMatchObject({ sheets: 'configured', quota: 'configured', ingestion: 'configured', channels: 'configured' })
    expect(value.monitoring.externalAi).toMatchObject({ connection: 'unverified', state: 'idle' })
    const serial = JSON.stringify(value)
    for (const credential of [env.GOOGLE_SHEETS_PRIVATE_KEY, env.CATALOGUE_DISCOVERY_QUOTA_API_TOKEN, env.CATALOGUE_DISCOVERY_INGEST_TOKEN]) expect(serial).not.toContain(credential)
    expect(upstream).not.toHaveBeenCalled()
  })
})
