export interface TimerClock {
  now(): number
}

export interface MonotonicClockSources {
  wallNow?: () => number
  monotonicNow?: () => number
}

export function createMonotonicClock(sources: MonotonicClockSources = {}): TimerClock {
  const wallNow = sources.wallNow ?? (() => Date.now())
  const monotonicNow = sources.monotonicNow ?? (() => (
    typeof performance === 'undefined' ? Date.now() : performance.now()
  ))
  const wallAnchor = wallNow()
  const monotonicAnchor = monotonicNow()
  let last = wallAnchor

  return {
    now() {
      const current = wallAnchor + Math.max(0, monotonicNow() - monotonicAnchor)
      last = Math.max(last, current)
      return last
    },
  }
}

export const systemTimerClock = createMonotonicClock()
