interface NativeRequestTiming extends PerformanceEntry {
  responseStatus?: number
  workerStart?: number
}

/** Native media errors do not expose HTTP responses. Observe existing timing only; never probe. */
export function describeMediaFailure(
  element: HTMLMediaElement,
  timeline: Pick<Performance, 'getEntriesByName'> = performance,
) {
  const classification = ({ 1: 'aborted', 2: 'network', 3: 'decode', 4: 'source-or-response' } as Record<number, string>)[element.error?.code ?? 0] ?? 'unknown'
  let status: number | null = null
  let requestDurationMs: number | null = null
  let serviceWorkerTiming: boolean | null = null
  try {
    const raw = element.getAttribute('src') || element.currentSrc
    if (raw) {
      const source = new URL(raw, location.href).href
      const entries = timeline.getEntriesByName(source, 'resource') as NativeRequestTiming[]
      const last = entries.reduce<NativeRequestTiming | undefined>((latest, entry) =>
        !latest || entry.startTime > latest.startTime ? entry : latest, undefined)
      if (last) {
        if (Number.isInteger(last.responseStatus) && last.responseStatus! >= 100 && last.responseStatus! <= 599) status = last.responseStatus!
        if (Number.isFinite(last.duration) && last.duration >= 0) requestDurationMs = Math.round(last.duration)
        if (typeof last.workerStart === 'number' && Number.isFinite(last.workerStart)) serviceWorkerTiming = last.workerStart > 0
      }
    }
  } catch { /* Resource Timing is optional and its absence establishes no cause. */ }
  return { classification, status, requestDurationMs, serviceWorkerTiming }
}
