export type PreloadPolicy = 'none' | 'metadata' | 'auto'
export type NextTrackPreloadPolicy = PreloadPolicy

/**
 * Fraction of the active track's duration that must be played before preparing the next track.
 *
 * Starting at 50% gives multi-provider fallback chains enough time to resolve and buffer before
 * the current track ends, while keeping typical tracks within the Worker's 120 s transient-media
 * ticket lifetime (`TICKET_TTL_MS` / `PREPARATION_VALIDITY_MS`).
 */
export const NEXT_TRACK_PRELOAD_PROGRESS_RATIO = 0.5

/**
 * Legacy lead-time constant retained for compatibility; active preloading is triggered by
 * {@link isNextTrackPreloadDue} at 50% progress.
 */
export const NEXT_TRACK_PRELOAD_LEAD_SECONDS = 60

export function isNextTrackPreloadDue(currentTime: number, duration: number): boolean {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return false
  return currentTime >= duration * NEXT_TRACK_PRELOAD_PROGRESS_RATIO
}

export interface NetworkConnectionSnapshot {
  effectiveType?: string
  saveData?: boolean
}

export interface PreloadPolicySnapshot {
  online: boolean
  connection?: NetworkConnectionSnapshot
}

export function selectPreloadPolicy(snapshot: PreloadPolicySnapshot): NextTrackPreloadPolicy {
  if (!snapshot.online) return 'none'
  if (snapshot.connection?.saveData === true) return 'metadata'
  const effectiveType = snapshot.connection?.effectiveType
  if (effectiveType === 'slow-2g' || effectiveType === '2g') {
    return 'metadata'
  }
  return 'auto'
}
