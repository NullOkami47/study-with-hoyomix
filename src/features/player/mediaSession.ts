import { watchEffect } from 'vue'
import type { PlaybackStore } from './store'
import type { PlayerCommands } from './commands'
import { playbackPresentationFor } from './presentation'
import { recordPlayback } from './playbackLog'
import { sharedArtworkCache } from '../library/artworkCache'

/** Optional browser integration. Unsupported actions never prevent normal playback. */
export function registerPlaybackMediaSession(
  store: PlaybackStore,
  commands: PlayerCommands,
  title: () => string,
): () => void {
  if (typeof navigator === 'undefined' || !navigator.mediaSession) return () => {}
  const session = navigator.mediaSession
  const presentation = playbackPresentationFor(store)
  const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: () => commands.play(), pause: () => commands.pause(), stop: () => commands.stop(),
    previoustrack: () => commands.previous?.(), nexttrack: () => commands.next?.(),
    seekto: details => { if (presentation.canSeek.value && details.seekTime !== undefined) commands.seek?.(details.seekTime) },
    seekbackward: details => { if (presentation.canSeek.value) commands.seek?.(presentation.currentTime.value - (details.seekOffset ?? 10)) },
    seekforward: details => { if (presentation.canSeek.value) commands.seek?.(presentation.currentTime.value + (details.seekOffset ?? 10)) },
  }
  const installed: MediaSessionAction[] = []
  if (typeof session.setActionHandler === 'function') {
    for (const [action, handler] of Object.entries(handlers)) {
      // Task 41.1: every invocation is logged before the command runs.
      const logged: MediaSessionActionHandler = (details) => {
        recordPlayback('mediaSession.action', {
          action, seekTime: details?.seekTime ?? null, status: store.status?.value ?? null,
          intent: store.playbackIntent?.value ?? null,
          visibility: typeof document !== 'undefined' ? document.visibilityState : null,
        })
        handler(details)
      }
      try {
        session.setActionHandler(action as MediaSessionAction, logged)
        installed.push(action as MediaSessionAction)
      } catch { /* A browser may implement only some actions. */ }
    }
  }
  let metadataIdentity: string | undefined
  let releaseArtwork: (() => void) | undefined
  const stopMetadata = watchEffect(() => {
    const track = store.currentTrack.value
    const source = presentation.artworkSourceUrl.value
    // The source binding is permission/identity only. Never ask the OS to acquire it.
    const artwork = source ? presentation.artworkUrl.value : undefined
    const trackTitle = title()
    const identity = JSON.stringify([track?.id, trackTitle, track?.album ?? '', source, artwork])
    if (identity === metadataIdentity) return
    if (typeof MediaMetadata !== 'undefined') {
      const nextRelease = track && artwork ? sharedArtworkCache.retain(artwork) : undefined
      try {
        session.metadata = track ? new MediaMetadata({
          title: trackTitle, artist: 'HOYO-MiX', album: track.album ?? '',
          artwork: artwork && nextRelease ? [{ src: artwork }] : [],
        }) : null
        releaseArtwork?.()
        releaseArtwork = nextRelease
        metadataIdentity = identity
      } catch { nextRelease?.() /* Invalid or unsupported artwork must not affect audio. */ }
    }
  })
  let lastPublishedState: MediaSessionPlaybackState | undefined
  let lastPosition: {
    generation: number; status: string; state: MediaSessionPlaybackState
    duration: number; position: number; publishedAt: number
  } | undefined
  let positionCleared = false
  const stopPosition = watchEffect(() => {
    const duration = presentation.duration.value
    const position = presentation.currentTime.value
    const canSeek = presentation.canSeek.value
    const nativeStalled = presentation.nativeStalled.value
    const status = store.status.value
    const intent = store.playbackIntent.value
    const generation = store.playbackGeneration.value
    // This is the existing bounded prepared-handover owner, not a new session lifecycle.
    const starting = store.awaitingStart?.value?.generation === generation &&
      (status === 'ready' || status === 'buffering')
    const playbackState: MediaSessionPlaybackState = !store.playable.value || status === 'error' ? 'none'
      : intent === 'playing' && !nativeStalled && (status === 'playing' || starting) ? 'playing' : 'paused'
    if (playbackState !== lastPublishedState) {
      try {
        session.playbackState = playbackState
        lastPublishedState = playbackState
        recordPlayback('mediaSession.state', { state: playbackState, status })
      } catch { /* Optional browser state must not prevent a position update. */ }
    }
    if (typeof session.setPositionState !== 'function') return
    // Transient handover keeps the pause action available, but has no advancing native clock yet.
    // A real stalled event wins even while awaiting the first progress; never fake the rate.
    if (starting || nativeStalled || !canSeek || duration <= 0 || !Number.isFinite(duration) || !Number.isFinite(position)) {
      if (!positionCleared) {
        try {
          session.setPositionState()
          positionCleared = true
          lastPosition = undefined
        } catch { /* Optional position reset. */ }
      }
      return
    }
    const nextPosition = Math.min(duration, Math.max(0, position))
    const publishedAt = performance.now()
    if (lastPosition && lastPosition.generation === generation && lastPosition.status === status &&
      lastPosition.state === playbackState && lastPosition.duration === duration) {
      const elapsedMs = Math.max(0, publishedAt - lastPosition.publishedAt)
      if (playbackState === 'playing' && status === 'playing') {
        const expectedPosition = lastPosition.position + elapsedMs / 1000
        if (elapsedMs < 1000 && Math.abs(nextPosition - expectedPosition) < 1) return
      } else if (nextPosition === lastPosition.position) return
    }
    try {
      session.setPositionState({ duration, playbackRate: 1, position: nextPosition })
      lastPosition = { generation, status, state: playbackState, duration, position: nextPosition, publishedAt }
      positionCleared = false
    } catch { /* Position state is optional, including on browsers with Media Session. */ }
  })
  return () => {
    stopMetadata()
    stopPosition()
    for (const action of installed) {
      try { session.setActionHandler(action, null) } catch { /* Optional action. */ }
    }
    try {
      session.metadata = null
      session.playbackState = 'none'
      session.setPositionState?.()
    } catch { /* Optional implementation. */ }
    releaseArtwork?.()
    releaseArtwork = undefined
  }
}
