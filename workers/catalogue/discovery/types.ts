import type {
  GameId,
  VocalStatus,
  TabId,
} from '../../../src/features/catalog/types'
export interface Discovery {
  videoId: string
  title: string
  album: string
  games: GameId[]
  artistChannelId: string
  albumBrowseId: string
  releaseDate?: string
  durationSeconds?: number
  evidence: string[]
}
export interface DiscoveryManifest {
  schemaVersion: 1
  runId: string
  discoveries: Discovery[]
}
export interface ClassificationSuggestion {
  games: GameId[]
  album: string
  aliases: Record<string, string[]>
  relation_ids: string[]
  work_group_id: string
  vocal_status: VocalStatus
  tabs: TabId[]
  evidence: string[]
  reasons: string[]
  confidence: number
  uncertainties: string[]
  adapter: 'deterministic' | 'gemini-spark' | 'meta-muse' | 'manual'
}
export interface SourceCheck {
  provider: string
  externalId: string
  status:
    | 'valid'
    | 'invalid'
    | 'unavailable'
    | 'unverified'
    | 'permission_required'
    | 'rate_limited'
  checkedAt: number
  confidence: number
  reason: string
}
export interface DiscoveryCandidate {
  id: string
  trackId: string
  discovery: Discovery
  suggestion: ClassificationSuggestion
  classificationReviewed: boolean
  sources: SourceCheck[]
  conflicts: string[]
  revision: number
  stageState: 'pending' | 'staged' | 'uncertain'
  createdAt: number
  updatedAt: number
}
export interface DiscoveryRun {
  runId: string
  createdAt: number
  discovered: number
  added: number
  repeated: number
  outcome: string
}
export interface DiscoveryStatus {
  nextCursor?: string | null
  candidates: DiscoveryCandidate[]
  runs: DiscoveryRun[]
  configured: boolean
  sheetsConfigured: boolean
  ingestionConfigured: boolean
  channelIds: string[]
  adapters: { id: string; available: boolean; mode: string }[]
  catalogueRevision: number
  /**
   * Unattended cycle state. `cycles` is empty when automation is off, so the Admin view can
   * distinguish "never enabled" from "enabled but the agent has gone quiet".
   */
  automation: {
    enabled: boolean
    autoPublish: boolean
    cycles: Array<{
      cycleId: string
      startedAt: number
      outcome: 'completed' | 'skipped' | 'failed' | 'stale'
      publishedRevision: number | null
      phases: Array<{
        phase: string
        processed: number
        failed: number
        outcome: string
        details: string[]
      }>
    }>
  }
}
export type DiscoveryAppend = Record<
  'Tracks' | 'Sources' | 'Aliases',
  string[][]
>
