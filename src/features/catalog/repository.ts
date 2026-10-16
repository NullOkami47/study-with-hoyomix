import type { CatalogQuery, GameId, TabId, Track } from './types'

type TrackIndex<Key extends string> = Map<Key, Set<string>>

function addToIndex<Key extends string>(index: TrackIndex<Key>, key: Key, trackId: string): void {
  const indexedIds = index.get(key)
  if (indexedIds) {
    indexedIds.add(trackId)
  } else {
    index.set(key, new Set([trackId]))
  }
}

function normaliseSearchTerm(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

function matchingAny<Key extends string>(index: TrackIndex<Key>, keys: Key[]): Set<string> | null {
  if (keys.length === 0) return null

  const result = new Set<string>()
  for (const key of keys) {
    for (const trackId of index.get(key) ?? []) result.add(trackId)
  }
  return result
}

function intersect(candidateIds: Set<string>, matchingIds: Set<string> | null): void {
  if (matchingIds === null) return
  for (const id of candidateIds) {
    if (!matchingIds.has(id)) candidateIds.delete(id)
  }
}

export class CatalogRepository {
  private readonly tracks: Track[]
  private readonly gameIndex: TrackIndex<GameId> = new Map()
  private readonly relationIndex: TrackIndex<string> = new Map()
  private readonly tabIndex: TrackIndex<TabId> = new Map()
  private readonly searchIndex = new Map<string, string>()

  constructor(tracks: Track[]) {
    this.tracks = [...tracks]

    for (const track of tracks) {
      for (const game of track.games) addToIndex(this.gameIndex, game, track.id)
      for (const relationId of track.relationIds) {
        addToIndex(this.relationIndex, relationId, track.id)
      }
      for (const tab of track.tabs) addToIndex(this.tabIndex, tab, track.id)

      this.searchIndex.set(
        track.id,
        normaliseSearchTerm(
          [track.title, ...Object.values(track.aliases).flat()].join('\n'),
        ),
      )
    }
  }

  query(query: CatalogQuery = {}): Track[] {
    const candidateIds = new Set(this.tracks.map((track) => track.id))

    intersect(candidateIds, matchingAny(this.gameIndex, query.games ?? []))
    intersect(candidateIds, matchingAny(this.relationIndex, query.relationIds ?? []))
    intersect(candidateIds, matchingAny(this.tabIndex, query.tabs ?? []))

    const search = normaliseSearchTerm(query.search ?? '')
    if (search.length > 0) {
      for (const id of candidateIds) {
        if (!this.searchIndex.get(id)?.includes(search)) candidateIds.delete(id)
      }
    }

    return this.tracks.filter((track) => candidateIds.has(track.id))
  }
}
