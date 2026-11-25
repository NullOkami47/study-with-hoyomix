import { beforeAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import { readCatalogueSnapshot } from '../catalogue/repository'
import { ingestManifest, readDiscoveryInbox, readCandidate, updateCandidate } from '../catalogue/discovery/repository'
import { stageCandidate } from '../catalogue/discovery/stageService'
import type { DiscoveryCandidate, DiscoveryAppend } from '../catalogue/discovery/types'
import {
  createGoogleSheetsClient,
  workbookFingerprint,
} from '../catalogue/googleSheets'
import { SHEET_HEADERS, exportWorkbook } from '../catalogue/staging'
let pem: string
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  pem =
    '-----BEGIN PRIVATE KEY-----\n' +
    Buffer.from(
      await crypto.subtle.exportKey('pkcs8', pair.privateKey),
    ).toString('base64') +
    '\n-----END PRIVATE KEY-----'
})
describe('safe Sheets append', () => {
  it('atomically appends string cells without replacing pending human rows or Instructions', async () => {
    const book = {
      Tracks: [SHEET_HEADERS.Tracks, ['human', 'keep me']],
      Sources: [SHEET_HEADERS.Sources],
      Aliases: [SHEET_HEADERS.Aliases],
      Instructions: [['instructions'], ['keep me']],
    }
    const writes: any[] = []
    const fetcher = vi.fn(async (input: any, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2'))
        return Response.json({
          access_token: 'test-append-token',
          expires_in: 3600,
        })
      if (url.includes('values:batchGet'))
        return Response.json({
          valueRanges: Object.entries(book).map(([k, v]) => ({
            range: k + '!A1:Z100',
            values: v,
          })),
        })
      if (url.includes('fields='))
        return Response.json({
          sheets: ['Tracks', 'Sources', 'Aliases'].map((title, sheetId) => ({
            properties: { title, sheetId },
          })),
        })
      writes.push(JSON.parse(String(init?.body)))
      return Response.json({ replies: [] })
    })
    const client = createGoogleSheetsClient(
      {
        CATALOGUE_SHEET_ID: 'append-fixture',
        GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL:
          'append@test.iam.gserviceaccount.com',
        GOOGLE_SHEETS_PRIVATE_KEY: pem,
      },
      { fetch: fetcher },
    )
    await client.append(
      { Tracks: [['new', '=SUM(A1)']], Sources: [], Aliases: [] },
      await workbookFingerprint(book),
    )
    expect(writes).toHaveLength(1)
    expect(writes[0].requests).toHaveLength(1)
    expect(writes[0].requests[0]).toEqual({
      appendCells: {
        sheetId: 0,
        rows: [
          {
            values: [
              { userEnteredValue: { stringValue: 'new' } },
              { userEnteredValue: { stringValue: '=SUM(A1)' } },
            ],
          },
        ],
        fields: 'userEnteredValue',
      },
    })
    expect(book.Tracks[1][1]).toBe('keep me')
  })
  it('refuses a stale workbook fingerprint before sending a mutation', async () => {
    const fetcher = vi.fn(async (input: any) =>
      String(input).includes('oauth2')
        ? Response.json({ access_token: 'test-stale-token', expires_in: 3600 })
        : Response.json({
            valueRanges: ['Tracks', 'Sources', 'Aliases', 'Instructions'].map(
              (tab) => ({
                range: tab + '!A1:Z100',
                values: [SHEET_HEADERS[tab as keyof typeof SHEET_HEADERS]],
              }),
            ),
          }),
    )
    const client = createGoogleSheetsClient(
      {
        CATALOGUE_SHEET_ID: 'stale-fixture',
        GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL:
          'stale@test.iam.gserviceaccount.com',
        GOOGLE_SHEETS_PRIVATE_KEY: pem,
      },
      { fetch: fetcher },
    )
    await expect(
      client.append({ Tracks: [['new']], Sources: [], Aliases: [] }, 'stale'),
    ).rejects.toThrow('stale_sheet')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('current catalogue scale', () => {
  it('reads a >2 MiB multi-thousand-row synthetic workbook envelope without failure', async () => {
    const trackCount = 3004
    const sourceCount = 6008
    const tracks = Array.from({ length: trackCount }, (_, i) => ({
      track_id: `synthetic-track-${i}`,
      title: `Synthetic Study Track ${i} (` + 'x'.repeat(420) + ')',
      album: `Synthetic Album ${i % 40}`,
      vocal_status: i % 3 === 0 ? 'vocal' : 'instrumental',
      work_group_id: `work-${i}`,
      review_status: 'reviewed',
    }))
    const sources = Array.from({ length: sourceCount }, (_, i) => ({
      source_row_id: `src-${i}`,
      track_id: `synthetic-track-${i % trackCount}`,
      provider: i % 2 === 0 ? 'chksz' : 'gd-studio',
      external_id: i % 2 === 0 ? String(9000000000 + i) : `netease:${9000000000 + i}`,
      metadata_json: '{"contentType":"audio/mpeg","rightsStatus":"public"}',
    }))
    const data = { tracks, sources, aliases: [] as Record<string, unknown>[] }
    const rows = {
      Tracks: data.tracks,
      Sources: data.sources,
      Aliases: data.aliases,
      Instructions: [],
    }
    const book = Object.fromEntries(
      Object.entries(SHEET_HEADERS).map(([tab, header]) => [
        tab,
        [
          header,
          ...rows[tab as keyof typeof rows].map(
            (row: Record<string, unknown>) =>
              header.map((k) =>
                row[k] === undefined || row[k] === null ? '' : String(row[k]),
              ),
          ),
        ],
      ]),
    )
    const body = JSON.stringify({
      valueRanges: Object.entries(book).map(([range, values]) => ({
        range: range + '!A1:Z40000',
        values,
      })),
    })
    expect(Buffer.byteLength(body)).toBeGreaterThan(2 * 1024 * 1024)
    const client = createGoogleSheetsClient(
      {
        CATALOGUE_SHEET_ID: 'scale-fixture',
        GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL:
          'scale@test.iam.gserviceaccount.com',
        GOOGLE_SHEETS_PRIVATE_KEY: pem,
      },
      {
        fetch: async (input) =>
          String(input).includes('oauth2')
            ? Response.json({ access_token: 'scale-token', expires_in: 3600 })
            : new Response(body, {
                headers: { 'content-type': 'application/json' },
              }),
      },
    )
    const result = await client.read()
    expect(result.Tracks).toHaveLength(data.tracks.length + 1)
    expect(result.Sources).toHaveLength(data.sources.length + 1)
  })
})

describe('definite Google rejection', () => {
  it('distinguishes HTTP 400 rejection from an unknown append outcome', async () => {
    const book = {
      Tracks: [SHEET_HEADERS.Tracks],
      Sources: [SHEET_HEADERS.Sources],
      Aliases: [SHEET_HEADERS.Aliases],
      Instructions: [SHEET_HEADERS.Instructions],
    }
    const client = createGoogleSheetsClient(
      {
        CATALOGUE_SHEET_ID: 'rejected-book',
        GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL:
          'reject@test.iam.gserviceaccount.com',
        GOOGLE_SHEETS_PRIVATE_KEY: pem,
      },
      {
        fetch: async (input) => {
          const u = String(input)
          if (u.includes('oauth2'))
            return Response.json({
              access_token: 'reject-token',
              expires_in: 3600,
            })
          if (u.includes('values:batchGet'))
            return Response.json({
              valueRanges: Object.entries(book).map(([k, values]) => ({
                range: k + '!A1:Z100',
                values,
              })),
            })
          if (u.includes('fields='))
            return Response.json({
              sheets: ['Tracks', 'Sources', 'Aliases'].map(
                (title, sheetId) => ({ properties: { title, sheetId } }),
              ),
            })
          return new Response(null, { status: 400 })
        },
      },
    )
    await expect(
      client.append(
        { Tracks: [['new']], Sources: [], Aliases: [] },
        await workbookFingerprint(book),
      ),
    ).rejects.toThrow('sheet_append_rejected')
  })
})

describe('metadata preflight rejection', () => {
  it.each([403, 429])(
    'never starts append after metadata HTTP %s',
    async (status) => {
      let posts = 0
      const book = {
        Tracks: [SHEET_HEADERS.Tracks],
        Sources: [SHEET_HEADERS.Sources],
        Aliases: [SHEET_HEADERS.Aliases],
        Instructions: [SHEET_HEADERS.Instructions],
      }
      const client = createGoogleSheetsClient(
        {
          CATALOGUE_SHEET_ID: 'preflight-' + status,
          GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL:
            'preflight@test.iam.gserviceaccount.com',
          GOOGLE_SHEETS_PRIVATE_KEY: pem,
        },
        {
          fetch: async (input, init) => {
            const u = String(input)
            if (u.includes('oauth2'))
              return Response.json({
                access_token: 'preflight-token',
                expires_in: 3600,
              })
            if (u.includes('values:batchGet'))
              return Response.json({
                valueRanges: Object.entries(book).map(([k, values]) => ({
                  range: k + '!A1:Z100',
                  values,
                })),
              })
            if (init?.method === 'POST') posts++
            return new Response(null, { status })
          },
        },
      )
      await expect(
        client.append(
          { Tracks: [['new']], Sources: [], Aliases: [] },
          await workbookFingerprint(book),
        ),
      ).rejects.toThrow(
        status === 429 ? 'sheet_rate_limited' : 'sheet_append_not_sent',
      )
      expect(posts).toBe(0)
    },
  )
})


describe('automation Sheets transport', () => {
  function automationClient(fetcher: typeof fetch) {
    return createGoogleSheetsClient({
      CATALOGUE_SHEET_ID: 'automation-transport-fixture',
      GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: 'automation@test.iam.gserviceaccount.com',
      GOOGLE_SHEETS_PRIVATE_KEY: pem,
    }, { fetch: fetcher })
  }

  it('reads a sentinel column so an added classification column cannot be hidden by the range', async () => {
    const ranges: string[] = []
    const client = automationClient(async (input) => {
      const url = String(input)
      if (url.includes('oauth2')) return Response.json({ access_token: 'automation-fixture-token', expires_in: 3600 })
      const range = decodeURIComponent(new URL(url).pathname.split('/values/')[1] ?? '')
      ranges.push(range)
      const row = Array.from({ length: 16 }, (_, i) => i === 15 ? 'external_id' : 'header-' + i)
      // Model Google values.get: cells outside the requested range are not returned.
      const width = range.includes('Suggestions') && range.includes(':P') ? 16 : 15
      return Response.json({ values: [row.slice(0, width)] })
    })
    await expect(client.readAutomation()).rejects.toThrow('sheets_unavailable')
    expect(ranges).toContain("'Suggestions'!A1:P5002")
  })

  it('reports absent tabs without creating tabs or sending writes', async () => {
    const methods: string[] = []
    const client = automationClient(async (input, init) => {
      if (String(input).includes('oauth2')) return Response.json({ access_token: 'automation-fixture-token', expires_in: 3600 })
      methods.push(init?.method ?? 'GET')
      return new Response(null, { status: 400 })
    })
    expect(await client.readAutomation()).toEqual({})
    expect(methods).toEqual(['GET', 'GET'])
  })

  it('appends automation text as literal cells in exactly one request', async () => {
    const writes: unknown[] = []
    const client = automationClient(async (input, init) => {
      const url = String(input)
      if (url.includes('oauth2')) return Response.json({ access_token: 'automation-fixture-token', expires_in: 3600 })
      if (url.includes('/values/')) return Response.json({ values: [] })
      if (url.includes('fields=')) return Response.json({ sheets: [{ properties: { title: 'Discoveries', sheetId: 7 } }] })
      writes.push(JSON.parse(String(init?.body)))
      return Response.json({ replies: [] })
    })
    await client.appendAutomation('Discoveries', [['video', '=IMPORTXML("untrusted")']])
    expect(writes).toEqual([{ requests: [{ appendCells: {
      sheetId: 7,
      rows: [{ values: [
        { userEnteredValue: { stringValue: 'video' } },
        { userEnteredValue: { stringValue: '=IMPORTXML("untrusted")' } },
      ] }],
      fields: 'userEnteredValue',
    } }] }])
  })
})


describe('automation append capacity', () => {
  it('refuses a full tab before sending the append POST', async () => {
    let appendPosts = 0
    const client = createGoogleSheetsClient({ CATALOGUE_SHEET_ID: 'full-tab-fixture', GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: 'full@test.iam.gserviceaccount.com', GOOGLE_SHEETS_PRIVATE_KEY: pem }, { fetch: async (input, init) => {
      const url = String(input)
      if (url.includes('oauth2')) return Response.json({ access_token: 'full-fixture-token', expires_in: 3600 })
      if (url.includes('/values/')) return Response.json({ values: Array.from({ length: 5001 }, () => ['existing']) })
      if (url.includes('fields=')) return Response.json({ sheets: [{ properties: { title: 'Discoveries', sheetId: 7 } }] })
      if (init?.method === 'POST') appendPosts++
      return Response.json({ replies: [] })
    } })
    await expect(client.appendAutomation('Discoveries', [['new']])).rejects.toThrow('automation_capacity')
    expect(appendPosts).toBe(0)
  })
})


describe('pending Sheets decimal ownership', () => {
  const clock = 1793923200000
  let fixture: Awaited<ReturnType<typeof catalogueDatabase>>
  let book: ReturnType<typeof exportWorkbook>
  let candidate: DiscoveryCandidate
  let append: ReturnType<typeof vi.fn<(plan: DiscoveryAppend) => Promise<void>>>
  beforeEach(async () => {
    fixture = await catalogueDatabase()
    const snapshot = await readCatalogueSnapshot(fixture.db)
    book = exportWorkbook(snapshot)
    await ingestManifest(fixture.db, {
      schemaVersion: 1, runId: 'pending-ownership',
      discoveries: [{
        videoId: 'abcdefghijk', title: 'New Dawn', album: 'New Album', games: ['genshin'],
        artistChannelId: 'UCAAAAAAAAAAAAAAAAAAAAAA', albumBrowseId: 'MPRE-album',
        evidence: ['https://music.youtube.com/watch?v=abcdefghijk'],
      }],
    }, snapshot, clock)
    candidate = (await readDiscoveryInbox(fixture.db)).candidates[0]
    append = vi.fn(async (plan: DiscoveryAppend) => {
      for (const tab of ['Tracks', 'Sources', 'Aliases'] as const) book[tab].push(...plan[tab])
    })
  })
  afterEach(async () => { await fixture?.dispose() })

  async function prepare(ownerProvider: string, ownerId: string, provider: string, externalId: string) {
    book.Sources.push(['human-pending-source', 'zzz-tiny-giant', ownerProvider, ownerId, 'audio', 'active', '1', 'unverified', 'Pending human source', 'Keep this proposal'])
    book.Aliases.push(['zzz-tiny-giant', 'en', 'Pending human alias'])
    candidate = await updateCandidate(fixture.db, {
      ...candidate,
      classificationReviewed: true,
      suggestion: { ...candidate.suggestion, vocal_status: 'vocal', uncertainties: [] },
      sources: [{ provider, externalId, status: 'valid', checkedAt: clock, confidence: 1, reason: 'resolver_audio_probe' }],
    }, candidate.revision, clock)
  }
  const stage = () => stageCandidate(fixture.db, { read: async () => structuredClone(book), append }, candidate, 1, () => clock)

  it.each([
    ['chksz', '9876543210', 'gd-studio', 'netease:09876543210'],
    ['lx-huibq', 'wy:09876543210:320k', 'chksz', '9876543210'],
    ['gd-studio', 'netease:01234567890123456789', 'lx-ikun', 'wy:1234567890123456789:flac'],
    ['chksz', '9876543210', 'gd-studio', 'netease:9876543210'],
  ])('rejects an alias owned by a pending %s row before any append', async (ownerProvider, ownerId, provider, externalId) => {
    await prepare(ownerProvider, ownerId, provider, externalId)
    const before = structuredClone(book)
    await expect.soft(stage()).rejects.toThrow('source_identity_conflict')
    expect.soft(append).not.toHaveBeenCalled()
    expect.soft(book).toEqual(before)
    expect(await readCandidate(fixture.db, candidate.id)).toEqual(candidate)
    expect(await fixture.db.prepare('SELECT count(*) AS n FROM catalogue_discovery_sheet_operations').first('n')).toBe(0)
    expect((await readCatalogueSnapshot(fixture.db)).revision).toBe(1)
  })

  it('allows a distinct 20-digit ID without altering the pending human row', async () => {
    await prepare('chksz', '12345678901234567890', 'gd-studio', 'netease:12345678901234567891')
    const pending = structuredClone(book.Sources.at(-1))
    const result = await stage()
    expect(result.stageState).toBe('staged')
    expect(append).toHaveBeenCalledTimes(1)
    expect(book.Sources).toContainEqual(pending)
    expect(book.Sources.find((row) => row[1] === candidate.trackId)?.[3]).toBe('netease:12345678901234567891')
    expect(book.Aliases).toContainEqual(['zzz-tiny-giant', 'en', 'Pending human alias'])
    expect((await readCatalogueSnapshot(fixture.db)).revision).toBe(1)
  })
})
