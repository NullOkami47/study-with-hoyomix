import type { Track, GameId, VocalStatus } from '../../src/features/catalog/types'
export interface PublishedCatalogue {
  revision: string
  tracks: Track[]
}
export interface TrackRow {
  track_id: string
  title: string
  album: string | null
  release_date: string | null
  vocal_status: VocalStatus
  focus: number
  sleep: number
  chill: number
  work_group_id: string
  needs_classification: number
  metadata_confidence: number | null
  evidence: string | null
  notes: string | null
  revision: number
  created_at: number
  updated_at: number
  published_at: number
}
export interface SourceRow {
  source_row_id: string
  track_id: string
  provider: string
  external_id: string
  source_type: string
  source_status: 'active' | 'disabled'
  source_confidence: number | null
  rights_status: string
  metadata_json: string
  evidence: string | null
  notes: string | null
  created_at: number
  updated_at: number
}
export interface CatalogueSnapshot {
  revision: number
  tracks: TrackRow[]
  sources: SourceRow[]
  games: { track_id: string; game: GameId }[]
  relations: { track_id: string; relation_id: string }[]
  aliases: { track_id: string; locale: string; alias: string }[]
}

export type ChangeKind =
  | 'new_track'
  | 'metadata_change'
  | 'classification_change'
  | 'new_source'
  | 'source_change'
  | 'new_alias'
  | 'conflict'
  | 'validation_error'
export type Decision = 'pending' | 'approved' | 'rejected'
export interface Proposal {
  changeId: string
  entityType: 'track' | 'source' | 'alias' | 'validation'
  entityKey: string
  kind: ChangeKind
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  validationState: 'valid' | 'error' | 'conflict'
  messages: string[]
  confidence: number | null
  decision: Decision
}
export interface ImportBatch {
  batchId: string
  status: 'draft' | 'validated' | 'published' | 'rejected'
  baseRevision: number
  reviewRevision: number
  createdAt: number
  updatedAt: number
  publishedAt: number | null
  summary: Partial<Record<ChangeKind, number>>
  changes: Proposal[]
}
export interface StagedTrack {
  track_id: string
  title: string
  album: string | null
  release_date: string | null
  work_group_id: string
  games: GameId[]
  relations: string[]
  vocal_status: VocalStatus
  focus: number
  sleep: number
  chill: number
  needs_classification: number
  metadata_confidence: number | null
  evidence: string | null
  notes: string | null
}
export type StagedSource = Omit<SourceRow, 'created_at' | 'updated_at'>
export interface StageError {
  entityType: 'track' | 'source' | 'alias' | 'validation'
  key: string
  code: string
  conflict?: boolean
}
export interface StagingData {
  tracks: StagedTrack[]
  sources: StagedSource[]
  aliases: CatalogueSnapshot['aliases']
  errors: StageError[]
}
