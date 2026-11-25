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
export interface DiscoveryMonitoring {
  configuration: {
    automation: 'missing' | 'disabled' | 'enabled'
    autoPublish: 'missing' | 'disabled' | 'enabled'
    channels: 'missing' | 'invalid' | 'configured'
    ingestion: 'missing' | 'invalid' | 'configured'
    sheets: 'missing' | 'invalid' | 'configured'
    quota: 'missing' | 'invalid' | 'configured'
  }
  schedule: 'unverified'
  counts: { discovered: number; classified: number; published: number }
  externalAi: {
    connection: 'unverified'
    state: 'unconfigured' | 'waiting' | 'stale' | 'error' | 'idle'
    waiting: number
    oldestPendingAt: number | null
    reason: string | null
  }
  scanner: {
    visibility: 'worker-records-only'
    lastRun: DiscoveryRun | null
    lastFailure: DiscoveryRun | null
    ageMs: number | null
    stale: boolean
  }
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
  monitoring: DiscoveryMonitoring
  /**
   * Durable history remains visible when automation is disabled.
   */
  automation: {
    enabled: boolean
    autoPublish: boolean
    canRun: boolean
    cycles: Array<{
      cycleId: string
      startedAt: number
      finishedAt?: number
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
