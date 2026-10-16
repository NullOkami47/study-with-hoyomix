import { describe, expect, it } from 'vitest'

import type { Track } from '../catalog/types'

import {
  FONTAINE_ALBUM,
  HAN_ALBUM,
  INSIDE_ALBUM,
  LIYUE_ALBUM,
  libraryFixtureTracks,
} from '../../test/fixtures/libraryCatalogue'
import { buildCatalogueIndex } from './catalogueIndex'
import { isSearchEmpty, searchCatalogue, SEARCH_RANK } from './catalogueSearch'

const index = buildCatalogueIndex(libraryFixtureTracks())

const trackIds = (query: string) => searchCatalogue(index, query).tracks.map((hit) => hit.track.id)
const albumTitles = (query: string) => searchCatalogue(index, query).albums.map((hit) => hit.album.title)
const gameIds = (query: string) => searchCatalogue(index, query).games.map((hit) => hit.game.id)

describe('searchCatalogue — tracks', () => {
  it('finds a track by its canonical title', () => {
    expect(trackIds('Fontaine Daydream')).toContain('genshin-fontaine-daydream')
  })

  it('finds a track by a partial title', () => {
    expect(trackIds('fontaine')).toEqual([
      'genshin-fontaine-daydream',
      'genshin-fontaine-nightfall',
    ])
  })

  it('finds a track by the album it belongs to', () => {
    const hits = searchCatalogue(index, 'belleau').tracks
    expect(hits.map((hit) => hit.track.id)).toEqual([
      'genshin-fontaine-daydream',
      'genshin-fontaine-nightfall',
    ])
    for (const hit of hits) expect(hit.rank).toBe(SEARCH_RANK.album)
  })

  it('finds a track by the game it belongs to, ranked below a name match', () => {
    const hits = searchCatalogue(index, 'genshin').tracks
    const vaguelette = hits.find((hit) => hit.track.id === 'genshin-la-vaguelette')!
    expect(vaguelette.rank).toBe(SEARCH_RANK.game)

    // A track whose own name matches must outrank one matched only through its game.
    const liyue = searchCatalogue(index, 'liyue').tracks
    expect(liyue[0].track.id).toBe('genshin-liyue')
    expect(liyue[0].rank).toBe(SEARCH_RANK.exact)
  })

  it('ranks an exact name above a prefix, and a prefix above a substring', () => {
    const ranks = searchCatalogue(index, 'fontaine').tracks.map((hit) => hit.rank)
    expect(ranks).toEqual([SEARCH_RANK.prefix, SEARCH_RANK.contains])
  })
})

describe('searchCatalogue — albums and games', () => {
  it('finds an album by title', () => {
    expect(albumTitles('belleau')).toEqual([FONTAINE_ALBUM])
    expect(albumTitles('jade moon')).toEqual([LIYUE_ALBUM])
    expect(albumTitles('inside')).toEqual([INSIDE_ALBUM])
  })

  it('finds a game by its English label, its short label and its Chinese label', () => {
    expect(gameIds('Genshin Impact')).toEqual(['genshin'])
    expect(gameIds('ZZZ')).toEqual(['zzz'])
    expect(gameIds('hsr')).toEqual(['hsr'])
    expect(gameIds('原神')).toEqual(['genshin'])
    expect(gameIds('絕區零')).toEqual(['zzz'])
  })

  it('finds albums through their game', () => {
    const hits = searchCatalogue(index, '原神').albums
    expect(hits.map((hit) => hit.album.title)).toEqual([FONTAINE_ALBUM, LIYUE_ALBUM])
    for (const hit of hits) expect(hit.rank).toBe(SEARCH_RANK.album)
  })

  it('structures a broad query into tracks, albums and games at once', () => {
    const results = searchCatalogue(index, 'genshin')

    expect(results.tracks.length).toBeGreaterThan(0)
    expect(results.albums).toHaveLength(2)
    expect(results.games).toHaveLength(1)
    expect(results.total).toBe(results.tracks.length + results.albums.length + results.games.length)
  })

  it('orders games by canonical order when ranks tie', () => {
    // 'n' appears in every game's English label, so all three match at the same tier and
    // the order has to come from the canonical game list rather than from iteration order.
    const results = searchCatalogue(index, 'n')
    expect(results.games.map((hit) => hit.rank)).toEqual([2, 2, 2])
    expect(results.games.map((hit) => hit.game.id)).toEqual(['genshin', 'hsr', 'zzz'])
  })
})

describe('searchCatalogue — normalisation', () => {
  it('is case-insensitive', () => {
    expect(trackIds('FONTAINE DAYDREAM')).toEqual(trackIds('fontaine daydream'))
    expect(albumTitles('INSIDE')).toEqual(albumTitles('inside'))
  })

  it('normalises whitespace', () => {
    expect(trackIds('   fontaine    daydream  ')).toEqual(trackIds('fontaine daydream'))
  })

  it('tolerates punctuation differences', () => {
    const expected = ['genshin-moon-in-ones-cup']
    expect(trackIds("Moon in One's Cup")).toEqual(expected)
    expect(trackIds('moon in ones cup')).toEqual(expected)
    expect(trackIds('moon-in-ones-cup')).toEqual(expected)
  })

  it('strips diacritics', () => {
    expect(trackIds('vaguelette')).toEqual(['genshin-la-vaguelette'])
  })
})

describe('searchCatalogue — multilingual Han search', () => {
  it('finds a Simplified-stored title from a Traditional query', () => {
    // The catalogue stores 轻涟 under zh-CN; the user is on a zh-Hant interface and types 輕漣.
    expect(trackIds('輕漣')).toEqual(['genshin-la-vaguelette'])
    expect(searchCatalogue(index, '輕漣').tracks[0].rank).toBe(SEARCH_RANK.exact)
  })

  it('finds a Traditional-stored title from a Simplified query', () => {
    // The fixture stores 輕漣 under zh-TW as well, so this exercises the reverse direction.
    expect(trackIds('轻涟')).toEqual(['genshin-la-vaguelette'])
  })

  it('finds a Han-titled album and its tracks from either script', () => {
    expect(albumTitles('极限委托')).toEqual([HAN_ALBUM])
    expect(albumTitles('極限委託')).toEqual([HAN_ALBUM])
    expect(trackIds('極限委託')).toEqual(['zzz-tiny-giant'])
  })

  it('finds a track by its Han alias', () => {
    expect(trackIds('微小的巨人')).toEqual(['zzz-tiny-giant'])
    expect(trackIds('使一颗心免于哀伤')).toEqual(['hsr-hope'])
  })
})

describe('searchCatalogue — empty and missing cases', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['punctuation only', '!!! — ...'],
  ])('returns nothing for a %s query', (_label, query) => {
    const results = searchCatalogue(index, query)
    expect(results.tracks).toEqual([])
    expect(results.albums).toEqual([])
    expect(results.games).toEqual([])
    expect(results.total).toBe(0)
    expect(isSearchEmpty(results)).toBe(true)
  })

  it('returns nothing when nothing matches, without throwing', () => {
    const results = searchCatalogue(index, 'zzzznotathingatall')
    expect(results.total).toBe(0)
    expect(results.needle).toBe('zzzznotathingatall')
  })

  it('preserves the raw query alongside the normalised needle', () => {
    const results = searchCatalogue(index, '  Moon in One\'s Cup ')
    expect(results.query).toBe('  Moon in One\'s Cup ')
    expect(results.needle).toBe('mooninonescup')
  })
})

describe('searchCatalogue — determinism and purity', () => {
  it('returns the same order for the same query', () => {
    const first = trackIds('genshin')
    const second = trackIds('genshin')
    expect(second).toEqual(first)
  })

  it('does not mutate the index', () => {
    const before = index.tracks.map((track) => track.id)
    searchCatalogue(index, 'genshin')
    searchCatalogue(index, '輕漣')
    expect(index.tracks.map((track) => track.id)).toEqual(before)
  })
})

describe('searchCatalogue — cost at full catalogue size', () => {
  /**
   * A coarse guard, not a benchmark. The catalogue is ~3,000 tracks, and the property worth
   * protecting is that a keystroke does not re-normalise the catalogue: normalisation is done
   * once when the index is built, and a query is a single `includes` pass over precomputed
   * strings.
   *
   * The ceiling is ~50x the observed cost, so ordinary machine-to-machine variation cannot
   * trip it, while a regression that moved NFKD/folding back onto the query path — 150,000
   * normalisations for this loop instead of 3,004 — would blow through it.
   */
  it('answers many queries over a full-size catalogue without re-normalising it', () => {
    const bulk: Track[] = Array.from({ length: 3004 }, (_, position): Track => ({
      id: `bulk-${position}`,
      title: `Bulk Track ${position}`,
      aliases: { 'zh-CN': [`批量曲目${position}`] },
      games: ['genshin'],
      relationIds: [],
      tabs: [],
      workGroupId: 'work-bulk',
      needsClassification: false,
      vocalStatus: 'instrumental',
      sources: [{ provider: 'jellyfin', externalId: `bulk-${position}` }],
      album: `Bulk Album ${position % 40}`,
    }))

    const buildStarted = performance.now()
    const bulkIndex = buildCatalogueIndex(bulk)
    const buildMs = performance.now() - buildStarted

    const queries = ['fontaine', 'genshin', '批量曲目', 'bulk', 'a', 'zzz', '輕漣', 'bulk album 7']
    const searchStarted = performance.now()
    for (let iteration = 0; iteration < 50; iteration += 1) {
      searchCatalogue(bulkIndex, queries[iteration % queries.length])
    }
    const searchMs = performance.now() - searchStarted

    expect(bulkIndex.tracks).toHaveLength(3004)
    expect(buildMs, 'building the index for 3,004 tracks').toBeLessThan(5000)
    expect(searchMs, '50 queries over 3,004 tracks').toBeLessThan(2000)
  })
})
