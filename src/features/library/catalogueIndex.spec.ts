import { describe, expect, it } from 'vitest'

import type { Track } from '../catalog/types'
import {
  FONTAINE_ALBUM,
  HAN_ALBUM,
  INSIDE_ALBUM,
  LIBRARY_FIXTURE_IDS,
  LIYUE_ALBUM,
  libraryFixtureTracks,
} from '../../test/fixtures/libraryCatalogue'
import {
  albumTracks,
  buildCatalogueIndex,
  gameAlbums,
  gameTracks,
} from './catalogueIndex'

const index = buildCatalogueIndex(libraryFixtureTracks())

describe('buildCatalogueIndex — album grouping', () => {
  it('groups tracks by the album the catalogue stores', () => {
    expect(index.albums.map((album) => album.title)).toEqual([
      FONTAINE_ALBUM,
      LIYUE_ALBUM,
      INSIDE_ALBUM,
      HAN_ALBUM,
    ])
    expect(index.albums.map((album) => album.trackCount)).toEqual([2, 2, 2, 1])
  })

  it('records the album’s game', () => {
    expect(index.albumById.get(`genshin:${FONTAINE_ALBUM}`)?.game).toBe('genshin')
    expect(index.albumById.get(`hsr:${INSIDE_ALBUM}`)?.game).toBe('hsr')
    expect(index.albumById.get(`zzz:${HAN_ALBUM}`)?.game).toBe('zzz')
  })

  it('keeps album identity separate from the album title', () => {
    // Two games may release albums with the same title; they must not be merged, or one
    // game's track list would leak into the other's album.
    const shared: Track[] = [
      {
        id: 'genshin-shared',
        title: 'Shared Song',
        aliases: {},
        games: ['genshin'],
        relationIds: [],
        tabs: [],
        workGroupId: 'work-shared',
        needsClassification: false,
        vocalStatus: 'instrumental',
        sources: [{ provider: 'jellyfin', externalId: 'a' }],
        album: 'Greatest Hits',
      },
      {
        id: 'hsr-shared',
        title: 'Shared Song',
        aliases: {},
        games: ['hsr'],
        relationIds: [],
        tabs: [],
        workGroupId: 'work-shared',
        needsClassification: false,
        vocalStatus: 'instrumental',
        sources: [{ provider: 'jellyfin', externalId: 'b' }],
        album: 'Greatest Hits',
      },
    ]

    const sharedIndex = buildCatalogueIndex(shared)

    expect(sharedIndex.albums).toHaveLength(2)
    expect(sharedIndex.albums.map((album) => album.game)).toEqual(['genshin', 'hsr'])
    expect(albumTracks(sharedIndex, 'genshin:Greatest Hits').map((track) => track.id)).toEqual([
      'genshin-shared',
    ])
    expect(albumTracks(sharedIndex, 'hsr:Greatest Hits').map((track) => track.id)).toEqual([
      'hsr-shared',
    ])
  })

  it('returns an album’s tracks in catalogue order', () => {
    expect(albumTracks(index, `genshin:${FONTAINE_ALBUM}`).map((track) => track.id)).toEqual([
      'genshin-fontaine-daydream',
      'genshin-fontaine-nightfall',
    ])
    expect(albumTracks(index, `hsr:${INSIDE_ALBUM}`).map((track) => track.id)).toEqual([
      'hsr-hope',
      'hsr-sway',
    ])
  })

  it('returns nothing for an album id it does not know', () => {
    expect(albumTracks(index, 'genshin:No Such Album')).toEqual([])
  })
})

describe('buildCatalogueIndex — game grouping', () => {
  it('groups tracks by game in catalogue order', () => {
    expect(gameTracks(index, 'genshin').map((track) => track.id)).toEqual([
      'genshin-fontaine-daydream',
      'genshin-fontaine-nightfall',
      'genshin-liyue',
      'genshin-moon-in-ones-cup',
      'genshin-la-vaguelette',
    ])
    expect(gameTracks(index, 'hsr').map((track) => track.id)).toEqual(['hsr-hope', 'hsr-sway'])
    expect(gameTracks(index, 'zzz').map((track) => track.id)).toEqual(['zzz-tiny-giant'])
  })

  it('lists the games in canonical order with their counts', () => {
    expect(index.games.map((game) => game.id)).toEqual(['genshin', 'hsr', 'zzz'])
    expect(index.games.map((game) => game.trackCount)).toEqual([5, 2, 1])
  })

  it('lists each game’s albums', () => {
    expect(gameAlbums(index, 'genshin').map((album) => album.title)).toEqual([
      FONTAINE_ALBUM,
      LIYUE_ALBUM,
    ])
    expect(gameAlbums(index, 'hsr').map((album) => album.title)).toEqual([INSIDE_ALBUM])
    expect(gameAlbums(index, 'zzz').map((album) => album.title)).toEqual([HAN_ALBUM])
  })
})

describe('buildCatalogueIndex — discoverability', () => {
  it('keeps every canonical track in All Tracks, in catalogue order', () => {
    expect(index.tracks.map((track) => track.id)).toEqual([...LIBRARY_FIXTURE_IDS])
  })

  it('keeps every canonical track reachable through its game', () => {
    const reachable = new Set<string>()
    for (const game of index.games) for (const track of gameTracks(index, game.id)) reachable.add(track.id)

    expect([...reachable].sort()).toEqual([...LIBRARY_FIXTURE_IDS].sort())
  })

  it('keeps every track with an album reachable through that album', () => {
    const reachable = new Set<string>()
    for (const album of index.albums) for (const track of albumTracks(index, album.id)) reachable.add(track.id)

    const withAlbum = libraryFixtureTracks()
      .filter((track) => track.album !== undefined)
      .map((track) => track.id)

    expect([...reachable].sort()).toEqual([...withAlbum].sort())
  })

  it('leaves a track without an album out of every album, but in the catalogue', () => {
    // The catalogue stores no album for this track, so there is no album to open. It must
    // still be browsable, which is why it stays in All Tracks and in its game.
    expect(index.albumIdByTrackId.get('genshin-la-vaguelette')).toBeUndefined()
    expect(index.tracks.some((track) => track.id === 'genshin-la-vaguelette')).toBe(true)
    expect(gameTracks(index, 'genshin').some((track) => track.id === 'genshin-la-vaguelette')).toBe(
      true,
    )
  })
})

describe('buildCatalogueIndex — determinism and search fields', () => {
  it('produces the same order for the same catalogue', () => {
    const rebuilt = buildCatalogueIndex(libraryFixtureTracks())
    expect(rebuilt.albums.map((album) => album.id)).toEqual(index.albums.map((album) => album.id))
    expect(rebuilt.games.map((game) => game.id)).toEqual(index.games.map((game) => game.id))
  })

  it('precomputes searchable fields for every track, album and game', () => {
    for (const track of index.tracks) expect(index.trackSearch.has(track.id)).toBe(true)
    for (const album of index.albums) expect(index.albumSearch.has(album.id)).toBe(true)
    for (const game of index.games) expect(index.gameSearch.has(game.id)).toBe(true)
  })

  it('folds a track’s aliases into its searchable names', () => {
    const fields = index.trackSearch.get('genshin-la-vaguelette')!
    // Stored as zh-CN (Simplified) and zh-TW (Traditional); both must be present, and both
    // must already be folded so a query in either script matches.
    expect(fields.names).toContain('轻涟')
    expect(fields.names).not.toContain('輕漣')
  })

  it('folds a track’s album and game labels into its haystack', () => {
    const fields = index.trackSearch.get('zzz-tiny-giant')!
    expect(fields.album).toBe('极限委托')
    expect(fields.haystack).toContain('极限委托')
    expect(fields.haystack).toContain('绝区零')
  })

  it('handles an empty catalogue without inventing structure', () => {
    const empty = buildCatalogueIndex([])
    expect(empty.tracks).toEqual([])
    expect(empty.albums).toEqual([])
    expect(empty.games.map((game) => game.trackCount)).toEqual([0, 0, 0])
    expect(empty.trackSearch.size).toBe(0)
  })
})
