export type PreloadPolicy = 'none' | 'metadata' | 'auto'
export type NextTrackPreloadPolicy = PreloadPolicy

/**
 * How close to the end of the active track the next track is prepared, in seconds.
 *
 * Two constraints set this value:
 *
 * 1. A resolved media URL is a Worker-minted transient ticket with a 120 second lifetime that is
 *    **not** refreshed on use (`workers/providers/transientMedia.ts`), and a preparation is reused
 *    for at most `PREPARATION_VALIDITY_MS` (100 s). The lead must stay inside that window, or the
 *    prepared URL would already be stale when the track is promoted.
 * 2. The browser needs the next track's bytes before it is asked to play, otherwise the promotion
 *    trades a provider round trip for a buffering stall. A longer lead gives slow or mobile
 *    connections time to fetch most of the next track while the current one is still playing.
 *
 * 60 s leaves 40 s of margin under the reuse window and is long enough to buffer a typical track
 * on an ordinary mobile connection.
 */
export const NEXT_TRACK_PRELOAD_LEAD_SECONDS = 60

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
