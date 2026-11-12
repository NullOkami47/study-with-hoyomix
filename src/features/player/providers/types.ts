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

export type Playable = (
  | { kind: 'audio'; url: string; mimeType: string; metadata?: PlaybackPresentationMetadata }
  | { kind: 'youtube'; videoId: string; metadata?: PlaybackPresentationMetadata }
) & {
  /** Effective URL/ticket deadline in Unix epoch milliseconds; absent retains legacy validity. */
  expiresAt?: number
}

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
  // H-01: the target origin is outside this deployment's CSP (connect-src or media-src), so it was
  // refused before any network use. A non-credential failure: the chain continues.
  | 'csp_blocked'
  // The browser never obtained a readable response for any of the source's requests: CORS refused
  // it, CSP refused it, or the connection failed. Distinct from `unavailable` because it is a
  // property of the source's endpoints, not a transient outage.
  | 'transport_blocked'
  // The upstreams answered, but with 4xx/5xx only. Distinct from `invalid_response`, where the
  // payload came back and was unusable.
  | 'http_error'
  // The source returned media this deployment cannot play because it is plaintext `http:` on a host
  // that is not eligible for HTTPS promotion. Distinct from `csp_blocked`, which is about the
  // origin not being listed at all.
  | 'media_insecure'

/** Diagnostics belonging to one provider invocation, including composite sub-source attempts. */
export interface ProviderResolveContext {
  onSubAttempt?: (attempt: ProviderAttempt) => void
}

export interface AudioProvider {
  id: string
  canResolve?(track: Track): boolean
  resolve(track: Track, signal: AbortSignal, context?: ProviderResolveContext): Promise<Playable | null>
}

export interface ProviderAttempt {
  providerId: string
  ok: boolean
  latencyMs: number
  code?: ResolveFailureCode
  sourceId?: string
  sourceName?: string
  /**
   * Set only when the failure was a dropped request or a server-side (5xx) outage rather than an
   * answer about the track (task 41.7). Such a failure may succeed on a retry; `code` is unchanged.
   */
  transient?: true
}

export class ProviderResolveError extends Error {
  readonly code: ResolveFailureCode
  /** See {@link ProviderAttempt.transient}; an own property only when set. */
  declare readonly transient?: true

  constructor(code: ResolveFailureCode, options: { transient?: boolean } = {}) {
    super(`Provider resolution failed: ${code}`)
    this.name = 'ProviderResolveError'
    this.code = code
    if (options.transient) Object.defineProperty(this, 'transient', { value: true, enumerable: false })
  }
}
