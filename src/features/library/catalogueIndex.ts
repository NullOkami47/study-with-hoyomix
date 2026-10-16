/**
 * The Music Library's browsing index, derived once from the canonical catalogue.
 *
 * ## Why this exists
 *
 * The catalogue is a flat list of ~3000 tracks with no album or game structure on the
 * client: `album` arrives per track, and games are an array. Browsing needs the inverse —
 * "which tracks are in this album", "which albums are in this game" — and search needs the
 * searchable text of every track in a form that can be compared without re-deriving it on
 * every keystroke.
 *
 * Building it once per catalogue revision gives both, and it is the reason switching tabs,
 * typing a query, or adding a track to the queue never re-walks and re-normalises the whole
 * catalogue.
 *
 * ## What it is not
 *
 * It is not a second catalogue. It holds no field the catalogue does not, adds no identity,
 * and is rebuilt wholesale whenever `tracks` changes — the canonical `Track` objects are
 * referenced, not copied. Nothing here is persisted.
 *
 * ## Determinism
 *
 * Every collection is ordered by an explicit comparison on code units, never by
 * `localeCompare`, so the same catalogue always produces the same index regardless of the
 * host locale. Album and game ordering is therefore stable and diffable.
 */

import { translate, type Locale, type TranslationKey } from '../../i18n'
import { CANONICAL_GAME_IDS } from '../catalog/filterState'
import { normaliseSearchText } from '../catalog/searchText'
import type { GameId, Track } from '../catalog/types'

/** Locales whose labels are folded into the searchable text, so a Chinese label is findable. */
export const SEARCH_LOCALES: readonly Locale[] = ['en', 'zh-Hant', 'zh-Hans']

const GAME_LABEL_KEYS: Record<GameId, readonly TranslationKey[]> = {
  genshin: ['game.genshin', 'game.genshin.compact'],
  hsr: ['game.hsr', 'game.hsr.compact'],
  zzz: ['game.zzz', 'game.zzz.compact'],
}

/**
 * Separator for album identity. A colon is safe because the game half is drawn from a
 * closed set of four values, none of which contains one, so the pair can never collide —
 * even though album titles themselves do contain colons ("Honkai: Star Rail").
 */
const ALBUM_KEY_SEPARATOR = ':'

/**
 * The precomputed searchable text of one entity.
 *
 * `names` are the entity's own names (a track's canonical title plus every alias, in every
 * locale) and are what exact/prefix ranking is computed against. `album` is the track's
 * album title, kept separate so an album match can rank below a title match. `haystack` is
 * everything concatenated, for the substring pass.
 */
export interface SearchableFields {
  readonly names: readonly string[]
  readonly album: string
  readonly haystack: string
}

export interface AlbumEntry {
  /** Stable identity: game plus title, NUL-separated. Never rendered. */
  readonly id: string
  readonly title: string
  /** The album's game, or `null` for a track the catalogue has not classified. */
  readonly game: GameId | null
  readonly trackIds: readonly string[]
  readonly trackCount: number
  readonly representativeTrack?: Track
}

export interface GameEntry {
  readonly id: GameId
  readonly albumIds: readonly string[]
  readonly trackCount: number
}

export interface CatalogueIndex {
  readonly tracks: readonly Track[]
  readonly trackById: ReadonlyMap<string, Track>
  readonly albums: readonly AlbumEntry[]
  readonly albumById: ReadonlyMap<string, AlbumEntry>
  /** Album a track belongs to, or `undefined` when the catalogue stores no album for it. */
  readonly albumIdByTrackId: ReadonlyMap<string, string | undefined>
  readonly games: readonly GameEntry[]
  readonly trackIdsByGame: ReadonlyMap<GameId, readonly string[]>
  readonly trackSearch: ReadonlyMap<string, SearchableFields>
  readonly albumSearch: ReadonlyMap<string, SearchableFields>
  readonly gameSearch: ReadonlyMap<GameId, SearchableFields>
}

function albumKey(game: GameId | null, title: string): string {
  return `${game ?? 'none'}${ALBUM_KEY_SEPARATOR}${title}`
}

/** Every label the app can show for a game, across the search locales, full and compact. */
export function gameLabels(game: GameId): string[] {
  const labels: string[] = []
  for (const locale of SEARCH_LOCALES) {
    for (const key of GAME_LABEL_KEYS[game]) labels.push(translate(locale, key))
  }
  return labels
}

/** The label to show for a game in one interface language. */
export function gameLabel(game: GameId, locale: Locale): string {
  return translate(locale, GAME_LABEL_KEYS[game][0])
}

function normalised(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const folded = normaliseSearchText(value)
    if (folded.length === 0 || seen.has(folded)) continue
    seen.add(folded)
    result.push(folded)
  }
  return result
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Build the browsing index for a catalogue.
 *
 * A track is placed in an album only when the catalogue stores an album title for it.
 * Tracks without one stay reachable through All Tracks and through their game's track list,
 * which is what keeps every canonical track discoverable without inventing an album the
 * data does not contain.
 */
export function buildCatalogueIndex(tracks: readonly Track[]): CatalogueIndex {
  const trackById = new Map<string, Track>()
  const albumIdByTrackId = new Map<string, string | undefined>()
  const albumTrackIds = new Map<string, string[]>()
  const albumMeta = new Map<string, { title: string; game: GameId | null }>()
  const trackIdsByGame = new Map<GameId, string[]>()
  const albumIdsByGame = new Map<GameId, string[]>()
  const trackSearch = new Map<string, SearchableFields>()
  const albumSearch = new Map<string, SearchableFields>()
  const gameSearch = new Map<GameId, SearchableFields>()

  for (const game of CANONICAL_GAME_IDS) {
    trackIdsByGame.set(game, [])
    albumIdsByGame.set(game, [])
    const labels = normalised(gameLabels(game))
    gameSearch.set(game, { names: labels, album: '', haystack: labels.join('') })
  }

  for (const track of tracks) {
    trackById.set(track.id, track)

    for (const game of track.games) trackIdsByGame.get(game)?.push(track.id)

    const albumTitle = typeof track.album === 'string' && track.album.length > 0 ? track.album : undefined
    let albumId: string | undefined
    if (albumTitle !== undefined) {
      const game = track.games[0] ?? null
      albumId = albumKey(game, albumTitle)
      const existing = albumTrackIds.get(albumId)
      if (existing) {
        existing.push(track.id)
      } else {
        albumTrackIds.set(albumId, [track.id])
        albumMeta.set(albumId, { title: albumTitle, game })
        if (game !== null) albumIdsByGame.get(game)?.push(albumId)
      }
    }
    albumIdByTrackId.set(track.id, albumId)

    const names = normalised([track.title, ...Object.values(track.aliases).flat()])
    const album = normaliseSearchText(albumTitle ?? '')
    const games = normalised(track.games.flatMap(gameLabels))
    trackSearch.set(track.id, {
      names,
      album,
      haystack: [...names, album, ...games].join(''),
    })
  }

  const albums: AlbumEntry[] = [...albumTrackIds.entries()]
    .map(([id, trackIds]) => {
      const meta = albumMeta.get(id)!
      const representativeTrack = trackIds.length > 0 ? trackById.get(trackIds[0]!) : undefined
      return { id, title: meta.title, game: meta.game, trackIds, trackCount: trackIds.length, representativeTrack }
    })
    .sort((a, b) => compareCodeUnits(a.title, b.title) || compareCodeUnits(a.id, b.id))

  for (const album of albums) {
    const names = normalised([album.title])
    const games = album.game === null ? [] : normalised(gameLabels(album.game))
    albumSearch.set(album.id, { names, album: '', haystack: [...names, ...games].join('') })
  }

  const games: GameEntry[] = CANONICAL_GAME_IDS.map((id) => ({
    id,
    albumIds: albumIdsByGame.get(id) ?? [],
    trackCount: (trackIdsByGame.get(id) ?? []).length,
  }))

  return {
    tracks: [...tracks],
    trackById,
    albums,
    albumById: new Map(albums.map((album) => [album.id, album])),
    albumIdByTrackId,
    games,
    trackIdsByGame,
    trackSearch,
    albumSearch,
    gameSearch,
  }
}

/** Tracks of one album, in catalogue order. */
export function albumTracks(index: CatalogueIndex, albumId: string): Track[] {
  const album = index.albumById.get(albumId)
  if (!album) return []
  return album.trackIds.flatMap((id) => {
    const track = index.trackById.get(id)
    return track ? [track] : []
  })
}

/** Tracks of one game, in catalogue order. */
export function gameTracks(index: CatalogueIndex, game: GameId): Track[] {
  return (index.trackIdsByGame.get(game) ?? []).flatMap((id) => {
    const track = index.trackById.get(id)
    return track ? [track] : []
  })
}

/** Albums of one game, in index order. */
export function gameAlbums(index: CatalogueIndex, game: GameId): AlbumEntry[] {
  return (index.games.find((entry) => entry.id === game)?.albumIds ?? []).flatMap((id) => {
    const album = index.albumById.get(id)
    return album ? [album] : []
  })
}
