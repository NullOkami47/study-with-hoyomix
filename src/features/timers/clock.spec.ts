import { describe, expect, it } from 'vitest'

import { createMonotonicClock } from './clock'

describe('monotonic timer clock', () => {
  it('advances from a monotonic source even when the wall clock moves backwards', () => {
    let wallNow = 10_000
    let monotonicNow = 500
    const clock = createMonotonicClock({ wallNow: () => wallNow, monotonicNow: () => monotonicNow })

    expect(clock.now()).toBe(10_000)
    wallNow = 1_000
    monotonicNow = 1_250

    expect(clock.now()).toBe(10_750)
  })
})
