/**
 * The unattended discovery cycle, against real Miniflare D1 and the real catalogue
 * publication path. The external boundary (Google Sheets, YouTube, NetEase, GD Studio)
 * is faked; D1, the resolver, the staging diff and the publisher are not.
 *
 * The behaviours that matter here are the ones that make unattended operation safe:
 * an agent cannot assert a playback source, a classification row is applied at most
 * once, a silent agent is reported instead of looking like a quiet week, and the
 * catalogue only moves when auto-publication is explicitly enabled.
 */
import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import { createCatalogueAdminHandler } from '../catalogue/adminRoutes'
import { createDiscoveryAdminHandler } from '../catalogue/discovery/routes'
import {
  runDiscoveryAutomationCycle,
  readAutomationCycles,
  SUGGESTION_STALE_MS,
} from '../catalogue/discovery/automationCycle'
import {
  DISCOVERY_SHEET_HEADERS,
  SUGGESTION_SHEET_HEADERS,
} from '../catalogue/discovery/automationRows'
import {
  readCatalogueSnapshot,
  readPublishedCatalogue,
} from '../catalogue/repository'
import { exportWorkbook } from '../catalogue/staging'
import { readCandidate, ingestManifest } from '../catalogue/discovery/repository'
import { candidateIdentity } from '../catalogue/discovery/model'
import type { Discovery } from '../catalogue/discovery/types'
import {
  DISCOVERY_CHANNEL,
  discoveryUpstream,
  discoveryCache,
} from './catalogue-discovery-fixture'

/** Existing upstream fixture plus the same read-only quota endpoint; never live fetch. */
function automationUpstream(): typeof fetch {
  const upstream = discoveryUpstream()
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin === 'https://api.cloudflare.com' && url.pathname === '/client/v4/graphql')
      return Response.json({ data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 0 } }] }] } } })
    return upstream(input, init)
  }
}
const origin = 'https://study.example'
const now = 1793923200000
const VIDEO = 'abcdefghijk'
const discovery: Discovery = {
  videoId: VIDEO,
  title: 'New Dawn',
  album: 'New Album',
  games: ['genshin'],
  artistChannelId: DISCOVERY_CHANNEL,
  albumBrowseId: 'MPRE-one',
  durationSeconds: 180,
  evidence: ['https://music.youtube.com/watch?v=' + VIDEO],
}

let fixture: Awaited<ReturnType<typeof catalogueDatabase>>
let env: any
let book: ReturnType<typeof exportWorkbook>
let automation: { Discoveries?: string[][]; Suggestions?: string[][] }
let clock: number

/** Records what the cycle appended, so a test can assert direction as well as content. */
let appended: Array<{ tab: string; rows: string[][] }>

const sheets = () => ({
  read: async () => structuredClone(book),
  write: async () => {},
  append: async (plan: any) => {
    for (const tab of ['Tracks', 'Sources', 'Aliases'] as const)
      book[tab].push(...plan[tab])
  },
  readAutomation: async () => structuredClone(automation),
  appendAutomation: async (tab: string, rows: string[][]) => {
    appended.push({ tab, rows })
    const current = (automation as any)[tab]
    if (current) current.push(...rows)
  },
})

const cycle = (overrides: Record<string, unknown> = {}) =>
  runDiscoveryAutomationCycle(
    { ...env, ...overrides } as any,
    {
      now: () => clock,
      sheets: sheets() as any,
      fetch: automationUpstream(),
      cache: discoveryCache(),
      quota: async (runtimeNow) => ({
        scope: 'account', utcDate: new Date(runtimeNow).toISOString().slice(0, 10),
        rowsWritten: 0, checkedAt: runtimeNow,
      }),
    },
  )

const phase = (result: Awaited<ReturnType<typeof cycle>>, name: string) =>
  result.phases.find((p) => p.phase === name)

/** Ingests the candidate through the real admin ingestion path. */
async function ingest() {
  const app = createDiscoveryAdminHandler(env, {
    now: () => now,
    sheets: sheets() as any,
    discovery: { fetch: automationUpstream(), cache: discoveryCache() },
  } as any)
  const cookie =
    '__Host-session=' +
    (
      await (
        await import('../auth/routes')
      )
        .createAuthHandler(env, { now: () => now })
        .issueSession('admin')
    ).token
  const response = await app.fetch(
    new Request(origin + '/api/admin/catalogue/discovery/import', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        schemaVersion: 1,
        runId: 'run-one',
        discoveries: [discovery],
      }),
    }),
  )
  expect(response.status).toBe(200)
}

/** A complete, valid agent classification row for the ingested candidate. */
const suggestionRow = (overrides: string[] = []) => {
  const row = [
    VIDEO,
    'genshin',
    'New Album',
    'work-new-dawn',
    'vocal',
    'TRUE',
    'FALSE',
    'FALSE',
    '',
    '{"zh-Hant":["新生"]}',
    'Official album listing',
    'https://music.youtube.com/watch?v=' + VIDEO,
    '1',
    '',
    'gemini-spark',
  ]
  overrides.forEach((value, index) => {
    if (value !== '\u0000') row[index] = value
  })
  return row
}

beforeEach(async () => {
  fixture = await catalogueDatabase()
  clock = now
  appended = []
  env = {
    DB: fixture.db,
    PUBLIC_ORIGIN: origin,
    SESSION_HMAC_SECRET: 'test-session-long-enough',
    CATALOGUE_DISCOVERY_CHANNEL_IDS: DISCOVERY_CHANNEL,
    CATALOGUE_SHEET_ID: 'test-sheet',
    GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: 'a@test.iam.gserviceaccount.com',
    GOOGLE_SHEETS_PRIVATE_KEY: '-----BEGIN PRIVATE KEY----- fixture',
    GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
    GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.fixture.example',
    CATALOGUE_DISCOVERY_AUTOMATION: 'enabled',
    CATALOGUE_DISCOVERY_CF_ACCOUNT_ID: 'a'.repeat(32),
    CATALOGUE_DISCOVERY_QUOTA_API_TOKEN: 'fixture-analytics',
  }
  await fixture.db
    .prepare(
      "INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES('admin','Admin','admin',1,1)",
    )
    .run()
  await fixture.db
    .prepare(
      "UPDATE provider_health SET enabled=1,updated_at=1 WHERE provider_key='gd-studio'",
    )
    .run()
  book = exportWorkbook(await readCatalogueSnapshot(fixture.db))
  automation = {
    Discoveries: [[...DISCOVERY_SHEET_HEADERS]],
    Suggestions: [[...SUGGESTION_SHEET_HEADERS]],
  }
})

afterEach(async () => {
  await fixture?.dispose()
})

describe('automation opt-in', () => {
  it('does nothing at all unless the environment opts in', async () => {
    await ingest()
    const result = await cycle({ CATALOGUE_DISCOVERY_AUTOMATION: undefined })
    expect(result.outcome).toBe('skipped')
    expect(result.phases).toEqual([])
    expect(appended).toEqual([])
    // Not even a cycle record: a disabled feature leaves no trace.
    expect(await readAutomationCycles(fixture.db)).toEqual([])
  })

  it('exports and classifies but never publishes while auto-publication is off', async () => {
    await ingest()
    const first = await cycle()
    expect(phase(first, 'publish')?.outcome).toBe('auto_publish_disabled')
    expect(first.publishedRevision).toBeNull()
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('1')
  })
})

describe('the round trip', () => {
  it('exports a candidate, applies the agent classification, stages and publishes', async () => {
    await ingest()

    // Cycle 1: nothing to classify yet, so the candidate is offered to the agent.
    const first = await cycle()
    expect(first.outcome).toBe('completed')
    expect(phase(first, 'export')?.processed).toBe(1)
    expect(appended).toHaveLength(1)
    expect(appended[0].tab).toBe('Discoveries')
    const exported = appended[0].rows[0]
    expect(exported[0]).toBe(VIDEO)
    // The verified NetEase ID is exported for a human to read...
    expect(exported[DISCOVERY_SHEET_HEADERS.indexOf('qualified_ids')]).toContain(
      'netease',
    )

    // The agent answers in the Suggestions tab.
    automation.Suggestions!.push(suggestionRow())

    // Cycle 2: the classification is applied, sources are re-verified and the row is staged.
    clock = now + 7 * 24 * 60 * 60 * 1000
    const second = await cycle()
    expect(phase(second, 'suggest')?.processed).toBe(1)
    expect(phase(second, 'stage')?.processed).toBe(1)
    expect(second.outcome).toBe('completed')
    // Staging is append-only into the existing workbook.
    expect(book.Tracks.some((r) => r[1] === 'New Dawn')).toBe(true)

    // Cycle 3: with auto-publication enabled, the staged row reaches the catalogue.
    clock = now + 14 * 24 * 60 * 60 * 1000
    const third = await cycle({ CATALOGUE_DISCOVERY_AUTO_PUBLISH: 'enabled' })
    expect(phase(third, 'publish')?.outcome).toBe('completed')
    const published = await readPublishedCatalogue(fixture.db)
    expect(published.revision).toBe('2')
    const track = published.tracks.find((t: any) => t.title === 'New Dawn')
    if (!track) throw new Error('published track missing')
    expect(track.tabs).toContain('focus')
    // Focus with vocals: the retired instrumental-only rule must not be reimposed.
    expect(track.vocalStatus).toBe('vocal')
  })

  it('records an automated publication with a null actor, never as a human approval', async () => {
    await ingest()
    await cycle()
    automation.Suggestions!.push(suggestionRow())
    clock = now + 7 * 24 * 60 * 60 * 1000
    await cycle()
    clock = now + 14 * 24 * 60 * 60 * 1000
    await cycle({ CATALOGUE_DISCOVERY_AUTO_PUBLISH: 'enabled' })

    const rows = await fixture.db
      .prepare(
        "SELECT actor_user_id, action FROM admin_audit_log WHERE action IN ('catalogue.publish','catalogue.review','catalogue.sync')",
      )
      .all<{ actor_user_id: string | null; action: string }>()
    expect(rows.results.length).toBeGreaterThan(0)
    // Every automated entry is attributable to automation, not to the admin user.
    for (const row of rows.results) expect(row.actor_user_id).toBeNull()
  })
})

describe('an agent cannot assert a playback source', () => {
  it('rejects the whole Suggestions tab when a source column is added', async () => {
    await ingest()
    await cycle()
    // An agent adding `external_id` must not be silently ignored.
    automation.Suggestions = [
      [...SUGGESTION_SHEET_HEADERS, 'external_id'],
      [...suggestionRow(), 'netease:111111'],
    ]
    clock = now + 7 * 24 * 60 * 60 * 1000
    const result = await cycle()
    expect(phase(result, 'suggest')?.outcome).toBe('automation_sheet_contract')
    expect(phase(result, 'suggest')?.processed).toBe(0)
  })

  it('binds only the server-qualified ID, ignoring any ID the sheet mentions', async () => {
    await ingest()
    await cycle()
    // The agent claims a different NetEase ID inside a free-text cell.
    automation.Suggestions!.push(
      suggestionRow([
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        'netease:999999999 is the right one',
      ]),
    )
    clock = now + 7 * 24 * 60 * 60 * 1000
    await cycle()
    clock = now + 14 * 24 * 60 * 60 * 1000
    await cycle({ CATALOGUE_DISCOVERY_AUTO_PUBLISH: 'enabled' })

    const sources = (await readCatalogueSnapshot(fixture.db)).sources
    const bound = sources.filter((s) => s.external_id.includes('999999999'))
    expect(bound).toEqual([])
    // The ID the server actually qualified is the one bound.
    expect(
      sources.some((s) => s.external_id.includes('9876543210')),
    ).toBe(true)
  })
})

describe('exactly-once processing', () => {
  it('does not re-export a candidate or reapply an unchanged classification row', async () => {
    await ingest()
    await cycle()
    expect(appended).toHaveLength(1)

    // A second cycle with no agent answer must not offer the same candidate again.
    clock = now + 7 * 24 * 60 * 60 * 1000
    const second = await cycle()
    expect(phase(second, 'export')?.processed).toBe(0)
    expect(appended).toHaveLength(1)

    automation.Suggestions!.push(suggestionRow())
    clock = now + 14 * 24 * 60 * 60 * 1000
    expect(phase(await cycle(), 'suggest')?.processed).toBe(1)
    // The identical row is not applied a second time.
    clock = now + 21 * 24 * 60 * 60 * 1000
    expect(phase(await cycle(), 'suggest')?.processed).toBe(0)
  })

  it('treats a corrected row as new work, but will not rewrite a candidate already staged', async () => {
    await ingest()
    await cycle()
    automation.Suggestions!.push(suggestionRow())
    clock = now + 7 * 24 * 60 * 60 * 1000
    await cycle()

    // The agent edits the row to fix a wrong tab. The content key changes, so the row is
    // picked up again rather than being ignored as already-seen.
    automation.Suggestions![1] = suggestionRow([
      '\u0000',
      '\u0000',
      '\u0000',
      '\u0000',
      '\u0000',
      'FALSE',
      'FALSE',
      'TRUE',
    ])
    clock = now + 14 * 24 * 60 * 60 * 1000
    const result = phase(await cycle(), 'suggest')

    // It is attempted, not silently dropped...
    expect(result?.failed).toBe(1)
    // ...but refused, because the candidate has already been staged for publication.
    // Re-opening a staged row from a sheet would let a late agent edit mutate a row a
    // human may already have approved; correcting it is an Admin action from here on.
    expect(result?.details[0]).toContain('candidate_not_pending')
    expect(result?.processed).toBe(0)
  })
})

describe('reporting instead of silence', () => {
  it('reports stale when the agent has not answered within the staleness window', async () => {
    await ingest()
    await cycle()
    clock = now + SUGGESTION_STALE_MS + 7 * 24 * 60 * 60 * 1000
    const result = await cycle()
    expect(result.outcome).toBe('stale')
    const history = await readAutomationCycles(fixture.db)
    expect(history[0].outcome).toBe('stale')
  })

  it('reports a missing Suggestions tab rather than treating it as an empty week', async () => {
    await ingest()
    automation = { Discoveries: [[...DISCOVERY_SHEET_HEADERS]] }
    const result = await cycle()
    expect(phase(result, 'suggest')?.outcome).toBe('suggestions_tab_missing')
  })

  it('reports each rejected classification row with its reason', async () => {
    await ingest()
    await cycle()
    // Confidence below 1 with no stated uncertainties is a contract violation.
    automation.Suggestions!.push(
      suggestionRow([
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '\u0000',
        '0.5',
        '',
      ]),
    )
    clock = now + 7 * 24 * 60 * 60 * 1000
    const result = await cycle()
    expect(phase(result, 'suggest')?.processed).toBe(0)
    expect(phase(result, 'suggest')?.failed).toBe(1)
    expect(phase(result, 'suggest')?.details).toContain(VIDEO + ':uncertain_without_uncertainties')
    expect(result.outcome).toBe('failed')
  })
})

describe('pacing and concurrency', () => {
  it('runs at most once per interval even though the trigger is hourly', async () => {
    await ingest()
    expect((await cycle()).outcome).toBe('completed')
    // An hour later the same cycle must not run again.
    clock = now + 60 * 60 * 1000
    const soon = await cycle()
    expect(soon.outcome).toBe('skipped')
    expect(appended).toHaveLength(1)
  })

  it('refuses to interleave two cycles against the same candidates', async () => {
    await ingest()
    await fixture.db
      .prepare(
        'INSERT INTO catalogue_discovery_locks(lock_key,owner,expires_at) VALUES(?,?,?)',
      )
      .bind('automation', 'someone-else', clock + 120000)
      .run()
    const result = await cycle()
    expect(result.outcome).toBe('skipped')
    expect(phase(result, 'suggest')?.outcome).toBe('discovery_busy')
  })
})

describe('existing guards still apply', () => {
  it('leaves a candidate pending when no provider can actually play it', async () => {
    await ingest()
    await cycle()
    automation.Suggestions!.push(suggestionRow())
    clock = now + 7 * 24 * 60 * 60 * 1000
    // Disable the only playable provider.
    await fixture.db
      .prepare(
        "UPDATE provider_health SET enabled=0,updated_at=1 WHERE provider_key='gd-studio'",
      )
      .run()
    const result = await cycle()
    expect(phase(result, 'stage')?.processed).toBe(0)
    expect(phase(result, 'stage')?.failed).toBe(1)
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('1')
  })

  it('fails closed when Google is unreachable, without advancing the catalogue', async () => {
    await ingest()
    const result = await runDiscoveryAutomationCycle(env as any, {
      now: () => clock,
      sheets: {
        ...sheets(),
        readAutomation: async () => {
          throw new Error('sheets_unavailable')
        },
      } as any,
      fetch: automationUpstream(),
      cache: discoveryCache(),
    })
    expect(phase(result, 'suggest')?.outcome).toBe('sheets_unavailable')
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('1')
  })
})


describe('manual automation trigger', () => {
  async function trigger(
    role: 'admin' | 'owner',
    suppliedSheets: Record<string, unknown> = sheets(),
    overrides: Record<string, unknown> = {},
  ) {
    await fixture.db.prepare('UPDATE users SET role=? WHERE id=?').bind(role, 'admin').run()
    const { createAuthHandler } = await import('../auth/routes')
    const cookie = '__Host-session=' + (await createAuthHandler(env, { now: () => clock }).issueSession('admin')).token
    const app = createDiscoveryAdminHandler({ ...env, ...overrides }, {
      now: () => clock,
      sheets: suppliedSheets as ReturnType<typeof sheets>,
      discovery: { fetch: automationUpstream(), cache: discoveryCache() },
    })
    return app.fetch(new Request(origin + '/api/admin/catalogue/discovery/automation/run', {
      method: 'POST',
      headers: { origin, cookie },
    }))
  }

  it('lets an owner run the real cycle while preserving the publication opt-in', async () => {
    await ingest()
    const response = await trigger('owner')
    expect(response.status).toBe(200)
    const result = await response.json() as Awaited<ReturnType<typeof cycle>>
    expect(phase(result, 'export')?.processed).toBe(1)
    expect(phase(result, 'publish')?.outcome).toBe('auto_publish_disabled')
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('1')
  })

  it('rejects a non-owner without starting a cycle', async () => {
    expect((await trigger('admin')).status).toBe(403)
    expect(await readAutomationCycles(fixture.db)).toEqual([])
  })

  it('keeps the environment opt-in mandatory for an owner', async () => {
    expect((await trigger('owner', sheets(), { CATALOGUE_DISCOVERY_AUTOMATION: undefined })).status).toBe(503)
    expect(await readAutomationCycles(fixture.db)).toEqual([])
  })

  it.each(['readAutomation', 'appendAutomation'] as const)(
    'rejects an unavailable %s capability before starting a cycle',
    async (missing) => {
      const incomplete = { ...sheets(), [missing]: undefined }
      const response = await trigger('owner', incomplete)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'sheets_unavailable' })
      expect(await readAutomationCycles(fixture.db)).toEqual([])
      expect(appended).toEqual([])
    },
  )
})


describe('durable unattended recovery', () => {
  it('preserves the agent evidence used for classification', async () => {
    await ingest(); await cycle()
    clock += 7 * 24 * 60 * 60 * 1000
    const row = suggestionRow()
    row[11] = 'https://example.org/official-album-notes'
    automation.Suggestions!.push(row)
    await cycle()
    const candidate = await readCandidate(fixture.db, await candidateIdentity(VIDEO))
    expect(candidate?.suggestion.evidence).toContain(row[11])
  })

  it('rolls a suggestion claim back when its candidate update fails', async () => {
    await ingest(); await cycle()
    clock += 7 * 24 * 60 * 60 * 1000
    automation.Suggestions!.push(suggestionRow())
    await fixture.db.prepare("CREATE TRIGGER stop_suggestion BEFORE UPDATE ON catalogue_discovery_candidates WHEN NEW.classification_reviewed=1 BEGIN SELECT RAISE(ABORT, 'injected_conflict'); END").run()
    const first = await cycle()
    expect(phase(first, 'suggest')?.failed).toBe(1)
    expect(await fixture.db.prepare("SELECT count(*) AS n FROM catalogue_discovery_automation_rows WHERE tab='Suggestions'").first('n')).toBe(0)
    await fixture.db.prepare('DROP TRIGGER stop_suggestion').run()
    clock += 7 * 24 * 60 * 60 * 1000
    expect(phase(await cycle(), 'suggest')?.processed).toBe(1)
  })

  it('reports stale candidates even when old unrelated Suggestions remain in the tab', async () => {
    await ingest()
    const secondVideo = 'bcdefghijkl'
    await ingestManifest(fixture.db, { schemaVersion: 1, runId: 'run-stale-two', discoveries: [{ ...discovery, videoId: secondVideo, title: 'Another Dawn', evidence: ['https://music.youtube.com/watch?v=' + secondVideo] }] }, await readCatalogueSnapshot(fixture.db), now)
    automation.Suggestions!.push(suggestionRow())
    await cycle()
    clock = now + SUGGESTION_STALE_MS + 7 * 24 * 60 * 60 * 1000
    expect((await cycle()).outcome).toBe('stale')
  })

  it('does not retry a lost Discoveries append before exact readback reconciliation', async () => {
    await ingest()
    let attempts = 0
    const lostSheets = {
      ...sheets(),
      appendAutomation: async () => { attempts += 1; throw new Error('automation_append_failed') },
    }
    const run = () => runDiscoveryAutomationCycle(env, { now: () => clock, sheets: lostSheets, fetch: automationUpstream(), cache: discoveryCache() })
    expect(phase(await run(), 'export')?.failed).toBe(1)
    clock += 7 * 24 * 60 * 60 * 1000
    const second = await run()
    expect(attempts).toBe(1)
    expect(phase(second, 'export')?.outcome).toBe('export_reconciliation_required')
    expect(second.outcome).toBe('failed')
  })

  it('reconciles an append that landed before its response was lost without sending again', async () => {
    await ingest()
    let attempts = 0
    const base = sheets()
    const lostSheets = {
      ...base,
      appendAutomation: async (tab: string, rows: string[][]) => {
        attempts += 1
        await base.appendAutomation(tab, rows)
        throw new Error('automation_append_failed')
      },
    }
    const run = () => runDiscoveryAutomationCycle(env, { now: () => clock, sheets: lostSheets, fetch: automationUpstream(), cache: discoveryCache() })
    await run()
    clock += 7 * 24 * 60 * 60 * 1000
    const second = await run()
    expect(attempts).toBe(1)
    expect(phase(second, 'export')?.outcome).toBe('completed')
  })

  it('reaches a later unexported candidate when the oldest twenty are already exported', async () => {
    const discoveries = Array.from({ length: 21 }, (_, index) => ({ ...discovery, videoId: 'video' + String(index).padStart(6, '0'), title: 'Release ' + index, evidence: ['https://music.youtube.com/watch?v=video' + String(index).padStart(6, '0')] }))
    await ingestManifest(fixture.db, { schemaVersion: 1, runId: 'run-queue', discoveries }, await readCatalogueSnapshot(fixture.db), now)
    const first = await cycle()
    expect(phase(first, 'export')?.processed).toBe(20)
    clock += 7 * 24 * 60 * 60 * 1000
    expect(phase(await cycle(), 'export')?.processed).toBe(1)
    expect(automation.Discoveries).toHaveLength(22)
  })
})


describe('cycle lease ownership', () => {
  it('stops before exporting when a slow source check outlives its lease', async () => {
    await ingest()
    let replaced = false
    const upstream = automationUpstream()
    const result = await runDiscoveryAutomationCycle(env, {
      now: () => clock,
      sheets: sheets(),
      cache: discoveryCache(),
      fetch: async (input, init) => {
        if (!replaced && !String(input).startsWith('https://api.cloudflare.com/')) {
          replaced = true
          clock += 121000
          await fixture.db.prepare("UPDATE catalogue_discovery_locks SET owner='successor',expires_at=? WHERE lock_key='automation'").bind(clock + 120000).run()
        }
        return upstream(input, init)
      },
    })
    expect(result.outcome).toBe('failed')
    expect(appended).toEqual([])
    expect(await fixture.db.prepare("SELECT owner FROM catalogue_discovery_locks WHERE lock_key='automation'").first('owner')).toBe('successor')
  })
})


describe('quota stops the cycle', () => {
  it('does not keep classifying or exporting after publication admission reports exhausted quota', async () => {
    await ingest()
    await cycle()
    automation.Suggestions!.push(suggestionRow())
    clock += 7 * 24 * 60 * 60 * 1000
    await cycle()
    let automationReads = 0
    const base = sheets()
    clock += 7 * 24 * 60 * 60 * 1000
    const result = await runDiscoveryAutomationCycle({ ...env, CATALOGUE_DISCOVERY_AUTO_PUBLISH: 'enabled' }, {
      now: () => clock,
      sheets: { ...base, readAutomation: async () => { automationReads += 1; return base.readAutomation() } },
      fetch: automationUpstream(), cache: discoveryCache(),
      quota: async (runtimeNow) => ({ scope: 'account', utcDate: new Date(runtimeNow).toISOString().slice(0, 10), rowsWritten: 99999, checkedAt: runtimeNow }),
    })
    expect(phase(result, 'publish')?.outcome).toBe('quota_exhausted')
    expect(result.phases).toHaveLength(1)
    expect(automationReads).toBe(0)
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('1')
  })
})


describe('final review regressions', () => {
  it('stops the entire cycle after the quota API returns HTTP 429', async () => {
    await ingest(); await cycle()
    automation.Suggestions!.push(suggestionRow())
    clock += 7 * 24 * 60 * 60 * 1000
    await cycle()
    clock += 7 * 24 * 60 * 60 * 1000
    let automationReads = 0, quotaCalls = 0
    const base = sheets(), upstream = automationUpstream()
    const result = await runDiscoveryAutomationCycle({ ...env, CATALOGUE_DISCOVERY_AUTO_PUBLISH: 'enabled', CATALOGUE_DISCOVERY_CF_ACCOUNT_ID: 'a'.repeat(32), CATALOGUE_DISCOVERY_QUOTA_API_TOKEN: 'fixture-analytics' }, {
      now: () => clock,
      sheets: { ...base, readAutomation: async () => { automationReads++; return base.readAutomation() } },
      fetch: async (input, init) => {
        if (String(input).startsWith('https://api.cloudflare.com/')) { quotaCalls++; return new Response(null, { status: 429 }) }
        return upstream(input, init)
      }, cache: discoveryCache(),
    })
    expect(result.phases).toHaveLength(1)
    expect(phase(result, 'publish')?.outcome).toBe('quota_rate_limited')
    expect(quotaCalls).toBe(1)
    expect(automationReads).toBe(0)
  })

  it('advances beyond permanently rejected suggestion rows on the next cycle', async () => {
    await ingest()
    const invalid = Array.from({ length: 20 }, (_, index) => {
      const row = suggestionRow(); row[0] = 'other' + String(index).padStart(6, '0'); return row
    })
    automation.Suggestions!.push(...invalid, suggestionRow())
    expect(phase(await cycle(), 'suggest')?.failed).toBe(20)
    clock += 7 * 24 * 60 * 60 * 1000
    expect(phase(await cycle(), 'suggest')?.processed).toBe(1)
  })

  it('refuses export into a full Discoveries tab before claiming or appending a row', async () => {
    await ingest()
    automation.Discoveries = [[...DISCOVERY_SHEET_HEADERS], ...Array.from({ length: 5000 }, (_, i) => [String(i)])]
    const result = await cycle()
    expect(phase(result, 'export')?.outcome).toBe('automation_capacity')
    expect(appended).toEqual([])
    expect(await fixture.db.prepare("SELECT count(*) AS n FROM catalogue_discovery_automation_rows WHERE tab='Discoveries'").first('n')).toBe(0)
  })

  it('requires the Discoveries header even for an empty tab', async () => {
    await ingest()
    automation.Discoveries = []
    const result = await cycle()
    expect(phase(result, 'export')?.outcome).toBe('discoveries_header_mismatch')
    expect(appended).toEqual([])
  })
})


/** Observe every attempted mutation while delegating to the real Miniflare D1. */
function observeCycleWrites(onWrite: (query: string) => void = () => {}) {
  const writes: string[] = []
  const metadata = new WeakMap<object, { raw: any; query: string }>()
  const observe = (query: string) => {
    if (/^\s*(?:SELECT|PRAGMA)\b/i.test(query)) return
    writes.push(query)
    onWrite(query)
  }
  const wrap = (raw: any, query: string): any => {
    const statement = {
      bind: (...values: unknown[]) => wrap(raw.bind(...values), query),
      run: async () => { observe(query); return raw.run() },
      all: async () => { observe(query); return raw.all() },
      first: async (...args: unknown[]) => { observe(query); return raw.first(...args) },
      raw: async (...args: unknown[]) => { observe(query); return raw.raw(...args) },
    }
    metadata.set(statement, { raw, query })
    return statement
  }
  const db = {
    prepare: (query: string) => wrap(fixture.db.prepare(query), query),
    batch: async (statements: object[]) => {
      const entries = statements.map((s) => metadata.get(s)!)
      for (const entry of entries) observe(entry.query)
      return fixture.db.batch(entries.map((entry) => entry.raw))
    },
  } as unknown as typeof fixture.db
  return { db, writes }
}
const availableQuota = async (runtimeNow: number) => ({
  scope: 'account' as const, utcDate: new Date(runtimeNow).toISOString().slice(0, 10),
  rowsWritten: 0, checkedAt: runtimeNow,
})
async function humanClassification(tabs: Array<'focus' | 'sleep' | 'chill'>) {
  const candidate = (await readCandidate(fixture.db, await candidateIdentity(VIDEO)))!
  const { createAuthHandler } = await import('../auth/routes')
  const cookie = '__Host-session=' + (await createAuthHandler(env, { now: () => clock }).issueSession('admin')).token
  const app = createDiscoveryAdminHandler(env, {
    now: () => clock, sheets: sheets(), discovery: { fetch: automationUpstream(), cache: discoveryCache() },
  })
  const response = await app.fetch(new Request(origin + '/api/admin/catalogue/discovery/' + candidate.id, {
    method: 'PATCH', headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: candidate.revision, reviewed: true, suggestion: {
      ...candidate.suggestion, album: 'Human-reviewed album', vocal_status: 'vocal',
      tabs, confidence: 1, uncertainties: [], reasons: ['Human listening review'],
    } }),
  }))
  expect(response.status).toBe(200)
  return (await response.json()) as typeof candidate
}

describe('S128 provenance and quota regressions', () => {
  it('keeps a human PATCH after export when a delayed AI reply arrives', async () => {
    await ingest(); await cycle()
    const human = await humanClassification(['sleep'])
    automation.Suggestions!.push(suggestionRow())
    clock += 7 * 24 * 60 * 60 * 1000
    const result = await cycle()
    const after = (await readCandidate(fixture.db, human.id))!
    expect(phase(result, 'suggest')?.processed).toBe(0)
    expect(phase(result, 'suggest')?.details.join(',')).toContain('stale_suggestion')
    expect(after.suggestion).toEqual(human.suggestion)
    expect(after.classificationReviewed).toBe(true)
  })

  it('keeps a human-reopened candidate when an older unprocessed reply arrives', async () => {
    await ingest(); await cycle()
    automation.Suggestions!.push(suggestionRow())
    clock += 7 * 24 * 60 * 60 * 1000
    await cycle()
    expect((await readCandidate(fixture.db, await candidateIdentity(VIDEO)))?.stageState).toBe('staged')
    const human = await humanClassification(['sleep'])
    expect(human.stageState).toBe('pending')
    const olderReply = suggestionRow(); olderReply[10] = 'Delayed alternate answer from the old export'
    automation.Suggestions![1] = olderReply
    clock += 7 * 24 * 60 * 60 * 1000
    const result = await cycle()
    expect(phase(result, 'suggest')?.processed).toBe(0)
    expect((await readCandidate(fixture.db, human.id))?.suggestion).toEqual(human.suggestion)
  })

  it.each(['legacy', 'absent'] as const)('refuses automatic approval from a %s unbound export', async (kind) => {
    await ingest(); await cycle()
    const id = await candidateIdentity(VIDEO)
    if (kind === 'legacy')
      await fixture.db.prepare("UPDATE catalogue_discovery_automation_rows SET payload_json=? WHERE tab='Discoveries' AND row_key=?")
        .bind(JSON.stringify(appended[0].rows[0]), id).run()
    else await fixture.db.prepare("DELETE FROM catalogue_discovery_automation_rows WHERE tab='Discoveries' AND row_key=?").bind(id).run()
    automation.Suggestions!.push(suggestionRow())
    clock += 7 * 24 * 60 * 60 * 1000
    const result = await cycle()
    expect(phase(result, 'suggest')?.processed).toBe(0)
    expect((await readCandidate(fixture.db, id))?.classificationReviewed).toBe(false)
    expect((await readPublishedCatalogue(fixture.db)).revision).toBe('1')
  })

  it.each([undefined, 'enabled'])('checks quota before any D1 write with auto-publication %s, including the next cycle', async (autoPublish) => {
    await ingest()
    const tracked = observeCycleWrites()
    const observedAtAdmission: number[] = []
    const quota = async (runtimeNow: number) => {
      observedAtAdmission.push(tracked.writes.length)
      return { ...await availableQuota(runtimeNow), rowsWritten: 99999 }
    }
    const run = () => runDiscoveryAutomationCycle({ ...env, DB: tracked.db, CATALOGUE_DISCOVERY_AUTO_PUBLISH: autoPublish }, {
      now: () => clock, sheets: sheets(), fetch: automationUpstream(), cache: discoveryCache(), quota,
    })
    const first = await run()
    clock += 60 * 60 * 1000
    const next = await run()
    expect(first.phases[0]?.outcome).toBe('quota_exhausted')
    expect(next.phases[0]?.outcome).toBe('quota_exhausted')
    expect(observedAtAdmission).toEqual([0, 0])
    expect(tracked.writes).toEqual([])
    expect(await readAutomationCycles(fixture.db)).toEqual([])
  })

  it('stops before lease/history writes when quota evidence is unavailable', async () => {
    const tracked = observeCycleWrites()
    const result = await runDiscoveryAutomationCycle({ ...env, DB: tracked.db }, {
      now: () => clock, sheets: sheets(), fetch: automationUpstream(), quota: async () => null,
    })
    expect(result.phases[0]?.outcome).toBe('quota_unavailable')
    expect(tracked.writes).toEqual([])
  })

  it('preserves a 10042 result without cleanup writes and admits the next cycle read-only', async () => {
    await ingest(); await cycle()
    automation.Suggestions!.push(suggestionRow())
    clock += 7 * 24 * 60 * 60 * 1000
    let exhausted = false
    const afterQuota: string[] = []
    const tracked = observeCycleWrites((query) => {
      if (exhausted) { afterQuota.push(query); throw new Error('cleanup must not replace the original quota result') }
      if (query.includes("VALUES('Suggestions',?,?)")) {
        exhausted = true
        throw new Error('D1_ERROR: quota exceeded 10042')
      }
    })
    const result = await runDiscoveryAutomationCycle({ ...env, DB: tracked.db }, {
      now: () => clock, sheets: sheets(), fetch: automationUpstream(), cache: discoveryCache(), quota: availableQuota,
    })
    expect(result.outcome).toBe('failed')
    expect(result.phases.at(-1)?.outcome).toContain('10042')
    expect(afterQuota).toEqual([])
    expect(await fixture.db.prepare("SELECT owner FROM catalogue_discovery_locks WHERE lock_key='automation'").first('owner')).toBeTruthy()
    const beforeNext = tracked.writes.length
    clock += 60 * 60 * 1000
    const next = await runDiscoveryAutomationCycle({ ...env, DB: tracked.db }, {
      now: () => clock, sheets: sheets(), fetch: automationUpstream(),
      quota: async (runtimeNow) => ({ ...await availableQuota(runtimeNow), rowsWritten: 100000 }),
    })
    expect(next.phases[0]?.outcome).toBe('quota_exhausted')
    expect(tracked.writes).toHaveLength(beforeNext)
  })
})


describe('Spec128 definite export rejection regression', () => {
  it('releases only its rejected export intent and can export on a later cycle after a definite 429', async () => {
    await ingest()
    let attempts = 0
    const base = sheets()
    const rejectedOnce = { ...base, appendAutomation: async (tab: string, rows: string[][]) => {
      attempts += 1
      if (attempts === 1) throw new Error('sheet_rate_limited')
      return base.appendAutomation(tab, rows)
    } }
    const run = () => runDiscoveryAutomationCycle(env, {
      now: () => clock, sheets: rejectedOnce, fetch: automationUpstream(), cache: discoveryCache(), quota: availableQuota,
    })
    const first = await run()
    expect(phase(first, 'export')?.outcome).toBe('sheet_rate_limited')
    expect(await fixture.db.prepare("SELECT count(*) AS n FROM catalogue_discovery_automation_rows WHERE tab='Discoveries'").first('n')).toBe(0)
    expect(attempts).toBe(1)
    clock += 7 * 24 * 60 * 60 * 1000
    const second = await run()
    expect(phase(second, 'export')?.processed).toBe(1)
    expect(attempts).toBe(2)
    expect(automation.Discoveries).toHaveLength(2)
  })
})


describe('S128 nested cleanup and claim ownership', () => {
  it('preserves a quota failure while acquiring the first cycle lease', async () => {
    const tracked = observeCycleWrites((query) => {
      if (query.includes('INSERT INTO catalogue_discovery_locks'))
        throw new Error('D1_ERROR: quota exceeded 10042 acquiring lease')
    })
    const result = await runDiscoveryAutomationCycle({ ...env, DB: tracked.db }, {
      now: () => clock, sheets: sheets(), fetch: automationUpstream(), quota: availableQuota,
    })
    expect(result.outcome).toBe('failed')
    expect(result.phases[0]?.outcome).toContain('10042 acquiring lease')
    expect(tracked.writes).toHaveLength(1)
  })

  it('blocks staging and cycle cleanup after the first D1 quota error', async () => {
    await ingest(); await cycle()
    automation.Suggestions!.push(suggestionRow())
    clock += 7 * 24 * 60 * 60 * 1000
    let exhausted = false
    const afterQuota: string[] = []
    const tracked = observeCycleWrites((query) => {
      if (exhausted) { afterQuota.push(query); throw new Error('unexpected write after quota') }
      if (query.includes('INSERT INTO catalogue_discovery_sheet_operations')) {
        exhausted = true
        throw new Error('D1_ERROR: quota exceeded 10042 during stage reservation')
      }
    })
    const result = await runDiscoveryAutomationCycle({ ...env, DB: tracked.db }, {
      now: () => clock, sheets: sheets(), fetch: automationUpstream(), cache: discoveryCache(), quota: availableQuota,
    })
    expect(exhausted).toBe(true)
    expect(result.outcome).toBe('failed')
    expect(result.phases.at(-1)?.outcome).toContain('10042 during stage reservation')
    expect(afterQuota).toEqual([])
    expect(await fixture.db.prepare("SELECT count(*) AS n FROM catalogue_discovery_locks WHERE lock_key IN ('automation','staging')").first('n')).toBe(2)
  })

  it('keeps a definite-rejection intent when its lease has passed to another owner', async () => {
    await ingest()
    let attempts = 0
    const guarded = { ...sheets(), appendAutomation: async () => {
      attempts += 1
      await fixture.db.prepare("UPDATE catalogue_discovery_locks SET owner='successor',expires_at=? WHERE lock_key='automation'").bind(clock + 120000).run()
      throw new Error('sheet_rate_limited')
    } }
    const result = await runDiscoveryAutomationCycle(env, {
      now: () => clock, sheets: guarded, fetch: automationUpstream(), cache: discoveryCache(), quota: availableQuota,
    })
    expect(result.outcome).toBe('failed')
    expect(attempts).toBe(1)
    expect(await fixture.db.prepare("SELECT count(*) AS n FROM catalogue_discovery_automation_rows WHERE tab='Discoveries'").first('n')).toBe(1)
    expect(await fixture.db.prepare("SELECT owner FROM catalogue_discovery_locks WHERE lock_key='automation'").first('owner')).toBe('successor')
  })
})
