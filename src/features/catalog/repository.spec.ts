import { describe, expect, it } from 'vitest'

import { CatalogRepository } from './repository'
import type { Track } from './types'

const tracks: Track[] = [
  {
    id: 'dawn-winery',
    title: 'Dawn Winery Theme',
    aliases: { 'zh-Hant': ['晨曦酒莊'], ja: ['アカツキワイナリー'] },
    games: ['genshin', 'hsr'],
    relationIds: ['place:mondstadt', 'faction:knights-of-favonius'],
    tabs: ['sleep', 'focus'],
    workGroupId: 'work-dawn-winery',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'youtube', externalId: 'dawn-video' }],
  },
  {
    id: 'astral-express',
    title: 'The Astral Express',
    aliases: { 'zh-Hant': ['星穹列車'] },
    games: ['hsr'],
    relationIds: ['faction:astral-express'],
    tabs: ['chill'],
    workGroupId: 'work-astral-express',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'youtube', externalId: 'astral-video' }],
  },
  {
    id: 'sixth-street',
    title: 'Sixth Street',
    aliases: { 'zh-Hant': ['六分街'] },
    games: ['zzz'],
    relationIds: ['place:new-eridu'],
    tabs: ['focus'],
    workGroupId: 'work-sixth-street',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'youtube', externalId: 'sixth-video' }],
  },
  {
    id: 'unclassified',
    title: 'Untitled Demo',
    aliases: {},
    games: [],
    relationIds: [],
    tabs: [],
    workGroupId: 'work-unclassified',
    vocalStatus: 'instrumental', needsClassification: true,
    sources: [{ provider: 'r2', externalId: 'demo/untitled.ogg' }],
  },
]

function ids(results: Track[]): string[] {
  return results.map((track) => track.id)
}

describe('CatalogRepository', () => {
  const repository = new CatalogRepository(tracks)

  it('searches canonical titles case-insensitively', () => {
    expect(ids(repository.query({ search: '  ASTRAL  ' }))).toEqual(['astral-express'])
  })

  it('searches every non-displayed multilingual alias', () => {
    expect(ids(repository.query({ search: '晨曦' }))).toEqual(['dawn-winery'])
  })

  it('uses OR semantics for selected games', () => {
    expect(ids(repository.query({ games: ['genshin', 'zzz'] }))).toEqual([
      'dawn-winery',
      'sixth-street',
    ])
  })

  it('uses OR semantics for selected relations', () => {
    expect(
      ids(
        repository.query({
          relationIds: ['faction:astral-express', 'place:new-eridu'],
        }),
      ),
    ).toEqual(['astral-express', 'sixth-street'])
  })

  it('uses OR semantics for selected tabs', () => {
    expect(ids(repository.query({ tabs: ['sleep', 'chill'] }))).toEqual([
      'dawn-winery',
      'astral-express',
    ])
  })

  it('uses AND semantics between search, game, relation, and tab dimensions', () => {
    expect(
      ids(
        repository.query({
          search: '酒莊',
          games: ['genshin'],
          relationIds: ['place:mondstadt'],
          tabs: ['focus'],
        }),
      ),
    ).toEqual(['dawn-winery'])

    expect(
      repository.query({
        games: ['genshin'],
        relationIds: ['faction:astral-express'],
      }),
    ).toEqual([])
  })

  it('returns all tracks in catalogue order when filters are empty', () => {
    expect(ids(repository.query({ games: [], relationIds: [], tabs: [] }))).toEqual([
      'dawn-winery',
      'astral-express',
      'sixth-street',
      'unclassified',
    ])
  })
})

/**
 * Every track below carries exactly one game and exactly one mode, so each of the
 * three plausible wrong readings changes the result set:
 *   (game OR game) AND (mode OR mode)  — correct
 *   game OR (game AND mode)            — would leak the excluded modes of one game
 *   game AND game                      — would return nothing
 */
const booleanTracks: Track[] = ([
  ['genshin-focus', 'genshin', 'focus'],
  ['genshin-chat', 'genshin', 'chill'],
  ['genshin-sleep', 'genshin', 'sleep'],
  ['hsr-focus', 'hsr', 'focus'],
  ['hsr-sleep', 'hsr', 'sleep'],
  ['zzz-focus', 'zzz', 'focus'],
  ['zzz-chat', 'zzz', 'chill'],
] as const).map(([id, game, tab]) => ({
  id,
  title: id,
  aliases: {},
  games: [game],
  relationIds: [],
  tabs: [tab],
  workGroupId: `work-${id}`,
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'youtube' as const, externalId: `${id}-video` }],
}))

describe('game and mode boolean composition', () => {
  const repository = new CatalogRepository(booleanTracks)

  it('reads (Genshin OR ZZZ) AND (Focus) as an intersection of two unions', () => {
    const results = ids(repository.query({ games: ['genshin', 'zzz'], tabs: ['focus'] }))

    expect(results).toEqual(['genshin-focus', 'zzz-focus'])
    expect(results).not.toContain('genshin-chat')
    expect(results).not.toContain('genshin-sleep')
    expect(results).not.toContain('hsr-focus')
  })

  it('reads (Genshin OR HSR) AND (Chill OR Sleep) across both multi-select groups', () => {
    const results = ids(repository.query({ games: ['genshin', 'hsr'], tabs: ['chill', 'sleep'] }))

    expect(results).toEqual(['genshin-chat', 'genshin-sleep', 'hsr-sleep'])
    expect(results).not.toContain('genshin-focus')
    expect(results).not.toContain('hsr-focus')
    expect(results).not.toContain('zzz-chat')
  })

  it('treats an empty mode selection as any mode while still restricting games', () => {
    expect(ids(repository.query({ games: ['zzz'], tabs: [] }))).toEqual(['zzz-focus', 'zzz-chat'])
  })

  it('adds search as a further AND condition over the game and mode intersection', () => {
    expect(ids(repository.query({ games: ['genshin', 'zzz'], tabs: ['focus'], search: 'zzz' }))).toEqual(['zzz-focus'])
  })
})
