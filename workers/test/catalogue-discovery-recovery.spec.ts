import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { catalogueDatabase } from './catalogue-fixture'
import { readCatalogueSnapshot } from '../catalogue/repository'
import { exportWorkbook } from '../catalogue/staging'
import {
  ingestManifest,
  readDiscoveryInbox,
  updateCandidate,
  readCandidate,
  acquireDiscoveryLease,
  releaseDiscoveryLease,
} from '../catalogue/discovery/repository'
import { stageCandidate } from '../catalogue/discovery/stageService'
import type {
  DiscoveryCandidate,
  DiscoveryAppend,
} from '../catalogue/discovery/types'
const now = 1793923200000
let f: Awaited<ReturnType<typeof catalogueDatabase>>,
  c: DiscoveryCandidate,
  book: ReturnType<typeof exportWorkbook>
beforeEach(async () => {
  f = await catalogueDatabase()
  const snapshot = await readCatalogueSnapshot(f.db)
  book = exportWorkbook(snapshot)
  await ingestManifest(
    f.db,
    {
      schemaVersion: 1,
      runId: 'recovery',
      discoveries: [
        {
          videoId: 'abcdefghijk',
          title: 'New Dawn',
          album: 'Album',
          games: ['genshin'],
          artistChannelId: 'UCAAAAAAAAAAAAAAAAAAAAAA',
          albumBrowseId: 'MPREb_album',
          evidence: ['https://music.youtube.com/watch?v=abcdefghijk'],
        },
      ],
    },
    snapshot,
    now,
  )
  c = (await readDiscoveryInbox(f.db)).candidates[0]
  c = await updateCandidate(
    f.db,
    {
      ...c,
      classificationReviewed: true,
      suggestion: {
        ...c.suggestion,
        vocal_status: 'vocal',
        tabs: ['focus'],
        uncertainties: [],
      },
      sources: [
        {
          provider: 'gd-studio',
          externalId: 'netease:1234',
          status: 'valid',
          reason: 'resolver_audio_probe',
          checkedAt: now,
          confidence: 0.95,
        },
      ],
    },
    c.revision,
    now,
  )
})
afterEach(async () => {
  await f?.dispose()
})
const apply = (plan: DiscoveryAppend) => {
  for (const tab of ['Tracks', 'Sources', 'Aliases'] as const)
    book[tab].push(...plan[tab])
}
describe('durable discovery staging recovery', () => {
  it('reconciles a lost Google response without issuing the append twice', async () => {
    const append = vi.fn(async (plan: DiscoveryAppend) => {
      apply(plan)
      throw new Error('sheet_append_uncertain')
    })
    const sheets = { read: async () => structuredClone(book), append }
    await expect(stageCandidate(f.db, sheets, c, 1, () => now)).rejects.toThrow(
      'sheet_append_uncertain',
    )
    c = (await readCandidate(f.db, c.id))!
    expect(c.stageState).toBe('uncertain')
    await expect(stageCandidate(f.db, sheets, c, 1, () => now)).rejects.toThrow(
      'sheet_reconciliation_required',
    )
    const recovered = await stageCandidate(f.db, sheets, c, 1, () => now, true)
    expect(recovered.stageState).toBe('staged')
    expect(append).toHaveBeenCalledTimes(1)
    expect(book.Tracks.filter((row) => row[0] === c.trackId)).toHaveLength(1)
  })
  it('does not retry when an uncertain append has no confirmed rows', async () => {
    const append = vi.fn(async () => {
      throw new Error('sheet_append_uncertain')
    })
    const sheets = { read: async () => structuredClone(book), append }
    await expect(
      stageCandidate(f.db, sheets, c, 1, () => now),
    ).rejects.toThrow()
    c = (await readCandidate(f.db, c.id))!
    await expect(
      stageCandidate(f.db, sheets, c, 1, () => now, true),
    ).rejects.toThrow('sheet_reconciliation_required')
    expect(append).toHaveBeenCalledTimes(1)
  })
  it('blocks simultaneous staging writers and stale catalogue revisions before Google mutation', async () => {
    const append = vi.fn(async () => {})
    const sheets = { read: async () => structuredClone(book), append }
    await acquireDiscoveryLease(f.db, 'staging', 'other-request', now)
    await expect(stageCandidate(f.db, sheets, c, 1, () => now)).rejects.toThrow(
      'discovery_busy',
    )
    await releaseDiscoveryLease(f.db, 'staging', 'other-request')
    await expect(stageCandidate(f.db, sheets, c, 2, () => now)).rejects.toThrow(
      'stale_catalogue',
    )
    expect(append).not.toHaveBeenCalled()
  })
  it('detects concurrent human staging rows instead of overwriting them', async () => {
    book.Tracks.push([c.trackId, 'Human pending revision'])
    const append = vi.fn(async () => {})
    await expect(
      stageCandidate(
        f.db,
        { read: async () => structuredClone(book), append },
        c,
        1,
        () => now,
      ),
    ).rejects.toThrow('staging_identity_conflict')
    expect(append).not.toHaveBeenCalled()
    expect(book.Tracks.at(-1)?.[1]).toBe('Human pending revision')
  })
})

describe('definitely unsent append recovery', () => {
  it.each([
    'sheet_append_not_sent',
    'sheet_rate_limited',
    'sheet_append_rejected',
  ])(
    'returns to pending for %s without keeping an uncertain intent',
    async (code) => {
      await expect(
        stageCandidate(
          f.db,
          {
            read: async () => structuredClone(book),
            append: async () => {
              throw new Error(code)
            },
          },
          c,
          1,
          () => now,
        ),
      ).rejects.toThrow(code)
      expect((await readCandidate(f.db, c.id))?.stageState).toBe('pending')
      expect(
        await f.db
          .prepare(
            'SELECT count(*) AS n FROM catalogue_discovery_sheet_operations',
          )
          .first<number>('n'),
      ).toBe(0)
    },
  )
})
