export type TransitionMode = 'off' | 'crossfade' | 'smart'
export const isTransitionMode = (value: unknown): value is TransitionMode => value === 'off' || value === 'crossfade' || value === 'smart'
export function transitionDuration(seconds: number, manual = false): number {
  const bounded = Number.isFinite(seconds) ? Math.min(12, Math.max(2, seconds)) : 5
  return manual ? Math.min(1.5, bounded) : bounded
}
/** Probe only a paused incoming deck, keeping every volume write muted. */
export function supportsNativeVolumeControl(element: Pick<HTMLMediaElement, 'volume' | 'muted' | 'paused'>): boolean {
  let originalVolume: number
  let originallyMuted: boolean
  try {
    if (!element.paused) return false
    originalVolume = element.volume
    originallyMuted = element.muted
  } catch { return false }
  if (!Number.isFinite(originalVolume) || originalVolume < 0 || originalVolume > 1) return false

  let supported = false
  let volumeTouched = false
  try {
    element.muted = true
    if (element.muted && element.paused) {
      volumeTouched = true
      element.volume = 0
      if (element.volume === 0) {
        element.volume = .5
        supported = element.volume === .5
      }
    }
  } catch { /* An ignored or throwing native property cannot support a safe fade. */ }
  finally {
    if (volumeTouched) {
      try {
        element.volume = originalVolume
        if (element.volume !== originalVolume) supported = false
      } catch { supported = false }
    }
    // A failed volume restoration must not prevent restoring the original mute state.
    try {
      element.muted = originallyMuted
      if (element.muted !== originallyMuted) supported = false
    } catch { supported = false }
  }
  return supported
}

/** Leave an outgoing safety margin and at least half the incoming track at full volume. */
export function boundedOverlapDuration(requestedSeconds: number, outgoingRemaining: number, incomingRemaining: number): number {
  if (!Number.isFinite(requestedSeconds) || !Number.isFinite(outgoingRemaining) || !Number.isFinite(incomingRemaining) ||
      requestedSeconds < .25 || outgoingRemaining < .35 || incomingRemaining < .5) return 0
  // Check the minimum before subtraction so .35 - .1 rounding cannot reject a .25s overlap.
  return Math.max(.25, Math.min(requestedSeconds, outgoingRemaining - .1, incomingRemaining / 2))
}
/** Equal-power-shaped curve with conservative peak headroom. Normalising the pair prevents
 * correlated full-scale signals from exceeding the listener's volume; endpoints stay continuous. */
export function fadeGains(progress: number, volume: number): [number, number] {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
  const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0
  if (p === 0) return [v, 0]
  if (p === 1) return [0, v]
  const a = Math.cos(p * Math.PI / 2), b = Math.sin(p * Math.PI / 2)
  return [v * a / (a + b), v * b / (a + b)]
}
