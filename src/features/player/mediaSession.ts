import { watchEffect } from 'vue'
import type { PlaybackStore } from './store'
import type { PlayerCommands } from './commands'
import { playbackPresentationFor } from './presentation'

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
      try {
        session.setActionHandler(action as MediaSessionAction, handler)
        installed.push(action as MediaSessionAction)
      } catch { /* A browser may implement only some actions. */ }
    }
  }
  const stopMetadata = watchEffect(() => {
    const track = store.currentTrack.value
    const artwork = presentation.artworkUrl.value
    const trackTitle = title()
    if (typeof MediaMetadata !== 'undefined') {
      try {
        session.metadata = track ? new MediaMetadata({
          title: trackTitle, artist: 'HOYO-MiX', album: track.album ?? '',
          artwork: artwork ? [{ src: artwork }] : [],
        }) : null
      } catch { /* Invalid or unsupported artwork must not affect audio. */ }
    }
  })
  const stopPosition = watchEffect(() => {
    const duration = presentation.duration.value
    const position = presentation.currentTime.value
    const canSeek = presentation.canSeek.value
    const status = store.status.value
    try {
      // The OS can extrapolate progress while playing. Buffering must freeze it.
      session.playbackState = status === 'playing' ? 'playing'
        : store.playable.value && status !== 'error' ? 'paused' : 'none'
      if (typeof session.setPositionState === 'function') {
        if (canSeek && duration > 0 && Number.isFinite(duration) && Number.isFinite(position)) {
          session.setPositionState({ duration, playbackRate: 1, position: Math.min(duration, Math.max(0, position)) })
        } else session.setPositionState()
      }
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
  }
}
