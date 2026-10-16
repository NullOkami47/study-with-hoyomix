import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseCatalog } from './schema'

function validTrack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'track-a-new-day',
    title: 'A New Day',
    aliases: {
      'zh-Hant': ['新的一天'],
      'zh-Hans': ['新的一天'],
    },
    games: ['genshin', 'hsr'],
    relationIds: [],
    tabs: ['sleep', 'focus'],
    workGroupId: 'work-a-new-day',
    needsClassification: false,
    vocalStatus: 'instrumental',
    sources: [
      {
        provider: 'youtube',
        externalId: 'abcdefghijk',
        metadata: { channelId: 'UC-example' },
      },
    ],
    ...overrides,
  }
}

describe('parseCatalog', () => {
  it('keeps the checked-in sample catalogue inside the runtime contract', () => {
    const sampleCatalog = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src/features/catalog/catalog.sample.json'), 'utf8'),
    ) as unknown

    expect(parseCatalog(sampleCatalog)).toEqual([])
  })

  it('accepts valid multi-game and multi-tab tracks with empty relations', () => {
    const result = parseCatalog([validTrack()])

    expect(result).toEqual([validTrack()])
  })

  it('keeps tracks with missing taxonomy visible when explicitly marked for classification', () => {
    const incompleteTrack = validTrack({
      games: [],
      relationIds: [],
      tabs: [],
      needsClassification: true,
    })

    expect(parseCatalog([incompleteTrack])).toEqual([incompleteTrack])
  })

  it('rejects a missing needsClassification marker', () => {
    const track = validTrack()
    delete track.needsClassification

    expect(() => parseCatalog([track])).toThrow(/needsClassification/)
  })

  it('rejects duplicate mappings for the same provider on one track', () => {
    const track = validTrack({
      sources: [
        { provider: 'youtube', externalId: 'abcdefghijk' },
        { provider: 'youtube', externalId: 'lmnopqrstuv' },
      ],
    })

    expect(() => parseCatalog([track])).toThrow(/duplicate provider/i)
  })

  it('keeps one provider-neutral source list with shared YouTube IDs for both audio resolvers', () => {
    const sources = [
      { provider: 'r2', externalId: 'authorised/track.ogg' },
      { provider: 'piped', externalId: 'lm3t3myPspk' },
      { provider: 'invidious', externalId: 'lm3t3myPspk' },
      { provider: 'chksz', externalId: '3334421408' },
    ]

    expect(parseCatalog([validTrack({ sources })])[0]?.sources).toEqual(sources)
    expect(() => parseCatalog([validTrack({
      sources,
      chinaProvider: 'chksz',
      globalProvider: 'piped',
    })])).toThrow(/chinaProvider|globalProvider/)
  })

  it('keeps historical Meting source mappings valid catalogue data', () => {
    const sources = [
      { provider: 'public-meting', externalId: 'legacy-public-track' },
      { provider: 'meting-agent', externalId: 'legacy-agent-track' },
    ]

    expect(parseCatalog([validTrack({ sources })])[0]?.sources).toEqual(sources)
  })

  it.each([
    ['an unknown relation kind', ['region:mondstadt']],
    ['a relation without a kind', ['mondstadt']],
    ['a relation with an empty identifier', ['place:']],
  ])('rejects %s', (_case, relationIds) => {
    expect(() => parseCatalog([validTrack({ relationIds })])).toThrow(/relationIds/)
  })

  it('rejects a track without any provider mapping', () => {
    expect(() => parseCatalog([validTrack({ sources: [] })])).toThrow(/sources/)
  })

  it('rejects a track with no game unless it is marked for classification', () => {
    expect(() => parseCatalog([validTrack({ games: [], needsClassification: false })])).toThrow(
      /needsClassification/,
    )
  })

  it.each([
    ['game', { games: ['honkai-impact'] }],
    ['tab', { tabs: ['study'] }],
  ])('rejects an unknown %s enum value', (_dimension, overrides) => {
    expect(() => parseCatalog([validTrack(overrides)])).toThrow(/unknown/i)
  })

  it('rejects unknown fields instead of silently accepting a wider schema', () => {
    expect(() => parseCatalog([validTrack({ mediaUrl: 'https://example.com/audio.mp3' })])).toThrow(
      /mediaUrl/,
    )
  })

  it('treats tabs and vocalStatus as independent dimensions', () => {
    // Regression guard: `focus` and `vocalStatus` used to be coupled by a
    // `catalog_focus_requires_instrumental` rule that rejected real catalogue rows (389 tracks
    // are legitimately focus + vocal). Every legal combination must now parse.
    const combinations = [
      { vocalStatus: 'instrumental', tabs: ['focus'] },
      { vocalStatus: 'vocal', tabs: ['focus'] },
      { vocalStatus: 'uncertain', tabs: ['focus'] },
      { vocalStatus: 'instrumental', tabs: [] },
      { vocalStatus: 'vocal', tabs: [] },
      { vocalStatus: 'uncertain', tabs: [] },
      { vocalStatus: 'vocal', tabs: ['sleep', 'chill'] },
      { vocalStatus: 'instrumental', tabs: ['focus', 'sleep', 'chill'] },
    ]

    for (const combination of combinations) {
      const [track] = parseCatalog([validTrack(combination)])
      expect(track.vocalStatus).toBe(combination.vocalStatus)
      expect(track.tabs).toEqual(combination.tabs)
    }
  })

  it('still rejects an unknown vocalStatus regardless of the tabs it carries', () => {
    expect(() => parseCatalog([validTrack({ vocalStatus: 'lyrical', tabs: ['focus'] })])).toThrow(
      /vocalStatus/,
    )
    expect(() => parseCatalog([validTrack({ vocalStatus: 'lyrical', tabs: [] })])).toThrow(
      /vocalStatus/,
    )
  })

  it.each(['instrumental', 'vocal', 'uncertain'])('preserves explicit Focus eligibility with %s vocal status', (vocalStatus) => {
    const track = validTrack({ vocalStatus, tabs: ['focus', 'sleep'] })
    expect(parseCatalog([track])).toEqual([track])
  })

  it('does not infer Focus eligibility from vocal status', () => {
    const track = validTrack({ vocalStatus: 'instrumental', tabs: [] })
    expect(parseCatalog([track])[0].tabs).toEqual([])
    expect(() => parseCatalog([validTrack({ vocalStatus: 'invalid' })])).toThrow(/vocalStatus/)
  })

  it('accepts chill and rejects legacy chat', () => {
    expect(() => parseCatalog([validTrack({ tabs: ['chill'] })])).not.toThrow()
    expect(() => parseCatalog([validTrack({ tabs: ['chat'] })])).toThrow(/unknown/i)
  })

  it('accepts an album as optional display metadata and trims it', () => {
    const [track] = parseCatalog([
      validTrack({ album: '  Genshin Impact - Fountain of Belleau (Original Game Soundtrack)  ' }),
    ])

    expect(track.album).toBe('Genshin Impact - Fountain of Belleau (Original Game Soundtrack)')
  })

  it.each([
    ['absent', {}],
    ['null', { album: null }],
    ['blank', { album: '   ' }],
  ])('leaves album off the parsed track when it is %s', (_label, overrides) => {
    const [track] = parseCatalog([validTrack(overrides)])

    // Not merely undefined: the key must not be created at all, so a catalogue with no
    // album metadata stays structurally identical to the pre-album contract.
    expect(Object.hasOwn(track, 'album')).toBe(false)
  })

  it('rejects a non-string album rather than coercing it', () => {
    expect(() => parseCatalog([validTrack({ album: 42 })])).toThrow(/album/i)
    expect(() => parseCatalog([validTrack({ album: ['a'] })])).toThrow(/album/i)
  })
})
