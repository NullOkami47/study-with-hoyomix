/**
 * Catalogue search — a pure query over a prebuilt {@link CatalogueIndex}.
 *
 * ## Shape of the result
 *
 * Results are grouped by entity type rather than flattened into one list, so "Fontaine"
 * can answer with games, albums and tracks as three labelled sections. Each section is
 * ranked independently; empty sections are simply empty, and the caller decides whether to
 * render them.
 *
 * ## Ranking
 *
 * A hit's rank is the best (lowest) tier it reaches:
 *
 * | tier | tracks                              | albums            | games |
 * |------|-------------------------------------|-------------------|-------|
 * | 0    | title/alias is the whole query       | title is the query | label is the query |
 * | 1    | title/alias starts with the query    | title starts with  | label starts with |
 * | 2    | title/alias contains the query       | title contains     | label contains |
 * | 3    | album title contains the query       | game label matches | — |
 * | 4    | game label matches                   | —                  | — |
 *
 * Tracks rank their own names above their album, and their album above their game, so a
 * query that names a track never buries it under the thousands of tracks that merely share
 * its game. Within a tier, order is by canonical title then id — never by locale — so the
 * same query returns the same order in every interface language.
 *
 * ## Cost
 *
 * One pass over the index per query, comparing already-normalised strings with `includes`.
 * Nothing is re-normalised here and nothing is fetched: the catalogue is already in memory,
 * so there is no reason to debounce or to touch D1, and adding either would only add
 * latency. Rendering is bounded by the caller's pagination, not by capping this result —
 * the counts have to stay truthful.
 */

import { normaliseSearchText } from '../catalog/searchText'
import type { Track } from '../catalog/types'
import type { AlbumEntry, CatalogueIndex, GameEntry, SearchableFields } from './catalogueIndex'

/** Rank tiers. Exported so tests and the UI can reason about ordering without magic numbers. */
export const SEARCH_RANK = {
  /** The query is the whole name. */
  exact: 0,
  /** A name starts with the query. */
  prefix: 1,
  /** A name contains the query. */
  contains: 2,
  /** The track's album contains the query. */
  album: 3,
  /** The entity's game label contains the query. */
  game: 4,
} as const

const NO_MATCH = Number.POSITIVE_INFINITY

export interface TrackHit {
  readonly track: Track
  readonly rank: number
}

export interface AlbumHit {
  readonly album: AlbumEntry
  readonly rank: number
}

export interface GameHit {
  readonly game: GameEntry
  readonly rank: number
}

export interface CatalogueSearchResults {
  /** The raw query as typed. */
  readonly query: string
  /** The normalised query actually compared. Empty when the query had no searchable characters. */
  readonly needle: string
  readonly tracks: readonly TrackHit[]
  readonly albums: readonly AlbumHit[]
  readonly games: readonly GameHit[]
  /** Sum of all three sections. */
  readonly total: number
}

const EMPTY_RESULTS: CatalogueSearchResults = {
  query: '',
  needle: '',
  tracks: [],
  albums: [],
  games: [],
  total: 0,
}

/**
 * Best tier reached by a name field.
 *
 * Returns as soon as an exact hit is found: nothing can outrank tier `exact`.
 */
function rankNames(
  needle: string,
  names: readonly string[],
  ranks: { exact: number; prefix: number; contains: number },
): number {
  let best = NO_MATCH
  for (const name of names) {
    if (name === needle) return ranks.exact
    if (name.startsWith(needle)) best = Math.min(best, ranks.prefix)
    else if (name.includes(needle)) best = Math.min(best, ranks.contains)
  }
  return best
}

function rankTrack(needle: string, fields: SearchableFields): number {
  const byName = rankNames(needle, fields.names, {
    exact: SEARCH_RANK.exact,
    prefix: SEARCH_RANK.prefix,
    contains: SEARCH_RANK.contains,
  })
  if (byName !== NO_MATCH) return byName
  if (fields.album.length > 0 && fields.album.includes(needle)) return SEARCH_RANK.album
  if (fields.haystack.includes(needle)) return SEARCH_RANK.game
  return NO_MATCH
}

function rankAlbum(needle: string, fields: SearchableFields): number {
  const byName = rankNames(needle, fields.names, {
    exact: SEARCH_RANK.exact,
    prefix: SEARCH_RANK.prefix,
    contains: SEARCH_RANK.contains,
  })
  if (byName !== NO_MATCH) return byName
  if (fields.haystack.includes(needle)) return SEARCH_RANK.album
  return NO_MATCH
}

function rankGame(needle: string, fields: SearchableFields): number {
  return rankNames(needle, fields.names, {
    exact: SEARCH_RANK.exact,
    prefix: SEARCH_RANK.prefix,
    contains: SEARCH_RANK.contains,
  })
}

function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Search the catalogue index.
 *
 * A query that normalises to nothing — empty, whitespace, or punctuation only — returns no
 * results rather than everything, so an accidental `-` does not dump the catalogue.
 */
export function searchCatalogue(index: CatalogueIndex, query: string): CatalogueSearchResults {
  const needle = normaliseSearchText(query)
  if (needle.length === 0) {
    return query === EMPTY_RESULTS.query ? EMPTY_RESULTS : { ...EMPTY_RESULTS, query }
  }

  const tracks: TrackHit[] = []
  for (const track of index.tracks) {
    const fields = index.trackSearch.get(track.id)
    if (!fields) continue
    const rank = rankTrack(needle, fields)
    if (rank !== NO_MATCH) tracks.push({ track, rank })
  }
  tracks.sort(
    (a, b) =>
      a.rank - b.rank ||
      compareCodeUnits(a.track.title, b.track.title) ||
      compareCodeUnits(a.track.id, b.track.id),
  )

  const albums: AlbumHit[] = []
  for (const album of index.albums) {
    const fields = index.albumSearch.get(album.id)
    if (!fields) continue
    const rank = rankAlbum(needle, fields)
    if (rank !== NO_MATCH) albums.push({ album, rank })
  }
  albums.sort(
    (a, b) =>
      a.rank - b.rank ||
      compareCodeUnits(a.album.title, b.album.title) ||
      compareCodeUnits(a.album.id, b.album.id),
  )

  const games: GameHit[] = []
  for (const game of index.games) {
    const fields = index.gameSearch.get(game.id)
    if (!fields) continue
    const rank = rankGame(needle, fields)
    if (rank !== NO_MATCH) games.push({ game, rank })
  }
  // `Array.prototype.sort` is stable, so equal ranks keep the canonical game order the
  // index produced rather than being reordered arbitrarily.
  games.sort((a, b) => a.rank - b.rank)

  return {
    query,
    needle,
    tracks,
    albums,
    games,
    total: tracks.length + albums.length + games.length,
  }
}

/** Whether a result set has nothing to show. */
export function isSearchEmpty(results: CatalogueSearchResults): boolean {
  return results.total === 0
}
