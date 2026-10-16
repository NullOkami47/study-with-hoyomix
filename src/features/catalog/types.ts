export type GameId = 'genshin' | 'hsr' | 'zzz'

export type TabId = 'sleep' | 'focus' | 'chill'

export type VocalStatus = 'instrumental' | 'vocal' | 'uncertain'

export type RelationKind = 'place' | 'character' | 'npc' | 'faction' | 'event'

export interface TrackSource {
  provider: string
  externalId: string
  metadata?: Record<string, string>
}

export interface Track {
  id: string
  title: string
  aliases: Record<string, string[]>
  games: GameId[]
  relationIds: string[]
  tabs: TabId[]
  workGroupId: string
  needsClassification: boolean
  vocalStatus: VocalStatus
  sources: TrackSource[]
  /**
   * Release album title, taken from `catalogue_tracks.album`.
   *
   * Display-only grouping metadata for the Music Library. It is never used for
   * identity, provider binding or playback: `id` remains the only key the queue and
   * the resolver know about. Optional because the column is nullable and because the
   * bundled production slice predates it — a track without an album still browses.
   */
  album?: string
}

/**
 * Query dimensions the catalogue browser actually restricts on. `workGroupId` and
 * `needsClassification` remain catalogue metadata on `Track`; they are no longer
 * queryable because neither is a user-facing filter any more.
 */
export interface CatalogQuery {
  search?: string
  games?: GameId[]
  relationIds?: string[]
  tabs?: TabId[]
}
