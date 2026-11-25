import { describe, expect, it } from 'vitest'
import {
  classifyDeterministically,
  parseDiscoveryManifest,
  validateSuggestion,
  candidateIdentity,
  identityConflicts,
  platformIdentity,
} from '../catalogue/discovery/model'
import { exportWorkbook } from '../catalogue/staging'
import { planDiscoveryAppend } from '../catalogue/discovery/staging'
import type { CatalogueSnapshot } from '../catalogue/types'
const discovery = {
  videoId: 'abcdefghijk',
  title: 'New Dawn',
  album: 'Genshin Impact — New Album',
  games: ['genshin'],
  artistChannelId: 'UCAAAAAAAAAAAAAAAAAAAAAA',
  albumBrowseId: 'MPRE-album',
  durationSeconds: 180,
  evidence: ['https://music.youtube.com/watch?v=abcdefghijk'],
}
const snapshot: CatalogueSnapshot = {
  revision: 4,
  tracks: [],
  sources: [],
  aliases: [],
  games: [],
  relations: [],
}
describe('discovery identity and classification', () => {
  it('keeps canonical identity separate from provider external ID and stable across runs', async () => {
    const a = await candidateIdentity(discovery.videoId)
    expect(a).toMatch(/^hoyo-[a-f0-9]{32}$/)
    expect(a).not.toContain(discovery.videoId)
    expect(await candidateIdentity(discovery.videoId)).toBe(a)
  })
  it('rejects invented IDs, hidden credentials, signed media and unbounded payloads', () => {
    expect(
      parseDiscoveryManifest({
        schemaVersion: 1,
        runId: 'run-one',
        discoveries: [discovery],
      }).discoveries,
    ).toHaveLength(1)
    for (const invalid of [
      { ...discovery, videoId: 'bad' },
      { ...discovery, cookies: 'secret' },
      {
        ...discovery,
        evidence: ['https://x.example/song?X-Amz-Signature=secret'],
      },
      { ...discovery, games: ['unknown'] },
    ])
      expect(() =>
        parseDiscoveryManifest({
          schemaVersion: 1,
          runId: 'run-one',
          discoveries: [invalid],
        }),
      ).toThrow()
    expect(() =>
      parseDiscoveryManifest({
        schemaVersion: 1,
        runId: 'run-one',
        discoveries: Array(101).fill(discovery),
      }),
    ).toThrow()
  })
  it('does not infer listening categories, vocals or relations from a title', () => {
    const s = classifyDeterministically(discovery as any, 'hoyo-test')
    expect(s.tabs).toEqual([])
    expect(s.vocal_status).toBe('uncertain')
    expect(s.relation_ids).toEqual([])
    expect(s.uncertainties).toContain('listening_review_required')
  })
  it('accepts vocal Focus but never trusts unknown fields or out-of-range confidence', () => {
    const s = {
      ...classifyDeterministically(discovery as any, 'hoyo-test'),
      vocal_status: 'vocal',
      tabs: ['focus'],
      confidence: 0.93,
      uncertainties: [],
    }
    expect(validateSuggestion(s).tabs).toEqual(['focus'])
    expect(() => validateSuggestion({ ...s, confidence: 2 })).toThrow()
    expect(() =>
      validateSuggestion({ ...s, rights_status: 'owner-authorised' }),
    ).toThrow()
  })
  it('flags same recording across platforms and keeps alternate versions distinct', () => {
    const prior = {
      ...snapshot,
      tracks: [
        {
          track_id: 'existing',
          title: 'New Dawn',
          album: discovery.album,
        } as any,
      ],
    }
    expect(identityConflicts(discovery as any, prior)).toEqual([
      'possible_existing_recording:existing',
    ])
    expect(
      identityConflicts(
        { ...discovery, title: 'New Dawn (Live)' } as any,
        prior,
      ),
    ).toEqual([])
  })
})
describe('append-only discovery staging plan', () => {
  it('preserves pending human cells and skips repeat candidate/source/alias keys', async () => {
    const trackId = await candidateIdentity(discovery.videoId)
    const suggestion = {
      ...classifyDeterministically(discovery as any, trackId),
      vocal_status: 'vocal',
      tabs: ['focus'],
      uncertainties: [],
    }
    const candidate = {
      id: trackId,
      trackId,
      discovery,
      suggestion,
      classificationReviewed: true,
      sources: [
        {
          provider: 'gd-studio',
          externalId: 'netease:9876543210',
          status: 'valid',
          checkedAt: 1000,
          reason: 'resolver_audio_probe',
          confidence: 1,
        },
      ],
      conflicts: [],
      revision: 1,
      stageState: 'pending',
      createdAt: 1000,
      updatedAt: 1000,
    } as any
    const book = exportWorkbook(snapshot)
    book.Tracks.push(['human-pending', 'Keep my unsaved proposal'])
    const original = JSON.stringify(book)
    const plan = planDiscoveryAppend([candidate], book, snapshot, 1000)
    expect(plan.Tracks).toHaveLength(1)
    expect(plan.Sources).toHaveLength(1)
    expect(plan.Tracks[0][0]).toBe(trackId)
    expect(plan.Tracks[0][8]).toBe('TRUE')
    expect(plan.Tracks[0][12]).toBe('reviewed')
    expect(JSON.stringify(book)).toBe(original)
    book.Tracks.push(...plan.Tracks)
    book.Sources.push(...plan.Sources)
    book.Aliases.push(...plan.Aliases)
    expect(planDiscoveryAppend([candidate], book, snapshot, 1000)).toEqual({
      Tracks: [],
      Sources: [],
      Aliases: [],
    })
  })
  it('keeps a YouTube-only discovery as a candidate because the live runtime has no YouTube provider', async () => {
    const trackId = await candidateIdentity(discovery.videoId)
    const c = {
      id: trackId,
      trackId,
      discovery,
      suggestion: {
        ...classifyDeterministically(discovery as any, trackId),
        vocal_status: 'vocal',
        uncertainties: [],
      },
      classificationReviewed: true,
      sources: [
        {
          provider: 'youtube',
          externalId: discovery.videoId,
          status: 'valid',
          checkedAt: 1000,
          confidence: 1,
        },
      ],
      conflicts: [],
    } as any
    expect(() =>
      planDiscoveryAppend([c], exportWorkbook(snapshot), snapshot, 1000),
    ).toThrow('runtime_source_required')
  })
  it('does not create a second canonical recording when another resolver already owns the same NetEase ID', async () => {
    const trackId = await candidateIdentity(discovery.videoId)
    const c = {
      id: trackId,
      trackId,
      discovery,
      suggestion: {
        ...classifyDeterministically(discovery as any, trackId),
        vocal_status: 'vocal',
        uncertainties: [],
      },
      classificationReviewed: true,
      sources: [
        {
          provider: 'gd-studio',
          externalId: 'netease:9876543210',
          status: 'valid',
          checkedAt: 1000,
          confidence: 1,
        },
      ],
      conflicts: [],
    } as any
    const live = {
      ...snapshot,
      sources: [
        {
          source_row_id: 'existing-source',
          track_id: 'existing-track',
          provider: 'chksz',
          external_id: '9876543210',
        },
      ],
    } as any
    expect(() =>
      planDiscoveryAppend([c], exportWorkbook(snapshot), live, 1000),
    ).toThrow('source_identity_conflict')
  })
  it('does not stage a song without a fresh source or human classification', async () => {
    const trackId = await candidateIdentity(discovery.videoId)
    const c = {
      id: trackId,
      trackId,
      discovery,
      suggestion: classifyDeterministically(discovery as any, trackId),
      classificationReviewed: false,
      sources: [],
      conflicts: [],
      revision: 1,
      stageState: 'pending',
    } as any
    expect(() =>
      planDiscoveryAppend([c], exportWorkbook(snapshot), snapshot, 1000),
    ).toThrow('candidate_not_ready')
  })
})

describe('pending source state protection', () => {
  it('never marks staging successful when an existing human source row is disabled', async () => {
    const trackId = await candidateIdentity(discovery.videoId)
    const c = {
      id: trackId,
      trackId,
      discovery,
      suggestion: {
        ...classifyDeterministically(discovery as any, trackId),
        vocal_status: 'vocal',
        uncertainties: [],
      },
      classificationReviewed: true,
      sources: [
        {
          provider: 'gd-studio',
          externalId: 'netease:9876543210',
          status: 'valid',
          checkedAt: 1000,
          confidence: 1,
        },
      ],
      conflicts: [],
    } as any
    const book = exportWorkbook(snapshot)
    book.Sources.push([
      'existing',
      trackId,
      'gd-studio',
      'netease:9876543210',
      'audio',
      'disabled',
    ])
    expect(() => planDiscoveryAppend([c], book, snapshot, 1000)).toThrow(
      'source_disabled_in_staging',
    )
  })
})


describe('decimal platform ownership', () => {
  it.each([
    ['netease', '01234567890123456789'],
    ['chksz', '01234567890123456789'],
    ['gd-studio', 'netease:01234567890123456789:320'],
    ['meting', 'netease:01234567890123456789'],
    ['lx-huibq', 'wy:01234567890123456789:320k'],
    ['lx-ikun', 'wy:01234567890123456789:flac'],
  ])('canonicalises leading zeros for %s without rewriting the binding', (provider, externalId) => {
    expect(platformIdentity(provider, externalId)).toBe('netease:1234567890123456789')
  })

  it('keeps adjacent 20-digit identities distinct and leaves other platforms intact', () => {
    expect(platformIdentity('chksz', '12345678901234567890')).toBe('netease:12345678901234567890')
    expect(platformIdentity('lx-huibq', 'wy:12345678901234567891:320k')).toBe('netease:12345678901234567891')
    expect(platformIdentity('youtube', '00123456789')).toBe('youtube:00123456789')
    expect(platformIdentity('lx-huibq', 'tx:001abc:320k')).toBe('tencent:001abc')
  })

  function readySource(provider: string, externalId: string) {
    const trackId = 'hoyo-ownership-candidate'
    return {
      id: trackId, trackId, discovery,
      suggestion: {
        ...classifyDeterministically(discovery as any, trackId),
        vocal_status: 'vocal', uncertainties: [],
      },
      classificationReviewed: true,
      sources: [{ provider, externalId, status: 'valid', checkedAt: 1000, confidence: 1 }],
      conflicts: [],
    } as any
  }

  it.each([
    ['chksz', '9876543210', 'gd-studio', 'netease:09876543210'],
    ['lx-huibq', 'wy:09876543210:320k', 'chksz', '9876543210'],
    ['gd-studio', 'netease:01234567890123456789', 'lx-ikun', 'wy:1234567890123456789:flac'],
  ])('blocks a published %s owner through a different resolver alias', (ownerProvider, ownerId, provider, externalId) => {
    const live = {
      ...snapshot,
      sources: [{ source_row_id: 'owned-source', track_id: 'existing-track', provider: ownerProvider, external_id: ownerId }],
    } as any
    const book = exportWorkbook(snapshot)
    const before = structuredClone(book)
    expect(() => planDiscoveryAppend([readySource(provider, externalId)], book, live, 1000))
      .toThrow('source_identity_conflict')
    expect(book).toEqual(before)
  })

  it('permits distinct 20-digit recordings while preserving the exact proposed binding', () => {
    const live = {
      ...snapshot,
      sources: [{ source_row_id: 'owned-source', track_id: 'existing-track', provider: 'chksz', external_id: '12345678901234567890' }],
    } as any
    const externalId = 'netease:12345678901234567891'
    const plan = planDiscoveryAppend([readySource('gd-studio', externalId)], exportWorkbook(snapshot), live, 1000)
    expect(plan.Sources).toHaveLength(1)
    expect(plan.Sources[0][3]).toBe(externalId)
  })

  it('permits a cross-resolver alias owned by the same canonical track and preserves its leading zeros', () => {
    const c = readySource('gd-studio', 'netease:09876543210')
    const live = {
      ...snapshot,
      sources: [{ source_row_id: 'owned-source', track_id: c.trackId, provider: 'chksz', external_id: '9876543210' }],
    } as any
    const plan = planDiscoveryAppend([c], exportWorkbook(snapshot), live, 1000)
    expect(plan.Sources).toHaveLength(1)
    expect(plan.Sources[0][3]).toBe('netease:09876543210')
  })
})
