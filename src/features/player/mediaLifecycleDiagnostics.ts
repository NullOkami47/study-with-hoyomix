import { recordPlayback, redactMediaUrl } from './playbackLog'

// Diagnostic identity only. Weak ownership cannot retain a discarded audio element.
const identities = new WeakMap<HTMLMediaElement, { id: number; source: string; revision: number }>()
let nextId = 0

/** A bounded snapshot, never a conclusion about who caused a native event. */
export function recordMediaLifecycle(
  type: string,
  element: HTMLMediaElement | null | undefined,
  context: Record<string, unknown>,
): void {
  if (!element) return
  try {
    const source = element.getAttribute('src') ?? ''
    let identity = identities.get(element)
    if (!identity) {
      identity = { id: ++nextId, source, revision: source ? 1 : 0 }
      identities.set(element, identity)
    } else if (identity.source !== source) {
      identity.source = source
      identity.revision++
    }
    const ranges: string[] = []
    for (let i = 0; i < Math.min(element.buffered.length, 3); i++) {
      ranges.push(`${Math.round(element.buffered.start(i) * 1000) / 1000}-${Math.round(element.buffered.end(i) * 1000) / 1000}`)
    }
    recordPlayback(type, {
      ...context, elementId: identity.id, sourceRevision: identity.revision,
      deck: element.dataset.audioDeck ?? null, elementGen: element.dataset.playbackGeneration ?? null,
      currentTime: element.currentTime, readyState: element.readyState, networkState: element.networkState,
      paused: element.paused, ended: element.ended, muted: element.muted, volume: element.volume,
      buffered: ranges.join(';'), errorCode: element.error?.code ?? null,
      src: source ? redactMediaUrl(source) : null,
    })
  } catch { /* A diagnostic failure must not affect transport or event handling. */ }
}
