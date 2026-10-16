export type PreloadPolicy = 'none' | 'metadata' | 'auto'
export type NextTrackPreloadPolicy = PreloadPolicy

/**
 * How close to the end of the active track the next track is prepared, in seconds.
 *
 * Two constraints set this value, and they pull in the same direction:
 *
 * 1. A resolved media URL is a Worker-minted transient ticket with a 30 second lifetime that is
 *    **not** refreshed on use (`workers/providers/transientMedia.ts`). Resolving much earlier than
 *    this would produce a URL that has already expired by the time the track is promoted.
 * 2. The browser needs some of the next track's bytes before it is asked to play, otherwise the
 *    promotion trades a provider round trip for a buffering stall.
 *
 * 20 s satisfies both: comfortably inside the ticket lifetime, and long enough for a useful amount
 * of the next track to be fetched on an ordinary connection.
 */
export const NEXT_TRACK_PRELOAD_LEAD_SECONDS = 20

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
  if (effectiveType === 'slow-2g' || effectiveType === '2g' || effectiveType === '3g') {
    return 'metadata'
  }
  return 'auto'
}
