import type { Track } from '../../catalog/types'

export interface AudioQualityMetadata {
  codec?: string
  container?: string
  bitrate?: number
  sampleRate?: number
  bitDepth?: number
  tier?: string
}

export interface PlaybackPresentationMetadata {
  quality?: AudioQualityMetadata
  artworkUrl?: string
}

export type Playable =
  | { kind: 'audio'; url: string; mimeType: string; metadata?: PlaybackPresentationMetadata }
  | { kind: 'youtube'; videoId: string; metadata?: PlaybackPresentationMetadata }

export type ResolveFailureCode =
  | 'not_mapped'
  | 'unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'invalid_response'
  | 'credential_required'
  | 'invalid_credential'
  // Truthful ChKSz policy failures. These must never be collapsed into
  // 'unavailable': each one tells the listener something different and actionable.
  | 'quota_exhausted'
  | 'forbidden'
  | 'not_found'

export interface AudioProvider {
  id: string
  canResolve?(track: Track): boolean
  resolve(track: Track, signal: AbortSignal): Promise<Playable | null>
}

export interface ProviderAttempt {
  providerId: string
  ok: boolean
  latencyMs: number
  code?: ResolveFailureCode
  sourceId?: string
  sourceName?: string
}

export class ProviderResolveError extends Error {
  readonly code: ResolveFailureCode

  constructor(code: ResolveFailureCode) {
    super(`Provider resolution failed: ${code}`)
    this.name = 'ProviderResolveError'
    this.code = code
  }
}
