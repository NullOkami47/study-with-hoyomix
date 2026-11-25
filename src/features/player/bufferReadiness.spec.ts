import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectBuffer, waitForBuffer } from './bufferReadiness'

const media = (ranges: number[][], readyState = 4) => ({
  readyState, currentTime: 0, duration: 60,
  buffered: { length: ranges.length, start: (i: number) => ranges[i][0], end: (i: number) => ranges[i][1] },
})

afterEach(() => { vi.useRealTimers() })

describe('native preparation readiness', () => {
  it('does not mistake a resolved URL or canplay for fetched audio', () => {
    expect(inspectBuffer(null, 5).ready).toBe(false)
    expect(inspectBuffer(media([]), 5).ready).toBe(false)
    expect(inspectBuffer(media([[4, 40]]), 5).ready).toBe(false)
    expect(inspectBuffer(media([[0, 2]]), 5).ready).toBe(false)
    expect(inspectBuffer(media([[0, 8]], 1), 5).ready).toBe(false)
    expect(inspectBuffer(media([[0, 8]], 2), 5).ready).toBe(false)
  })

  it('requires a contiguous range at the play position and caps the target at the remaining duration', () => {
    expect(inspectBuffer(media([[0, 8], [20, 40]]), 5)).toEqual({ ready: true, bufferedSeconds: 8, totalBufferedSeconds: 28 })
    expect(inspectBuffer({ ...media([[0, 60]]), currentTime: 57 }, 5).ready).toBe(true)
    expect(inspectBuffer(media([[0, 2], [2.1, 10]]), 5).ready).toBe(false)
    expect(inspectBuffer({ ...media([[0, 60]]), currentTime: 60 }, 5).ready).toBe(false)
  })

  it('fails closed for invalid playback positions and buffering measurements', () => {
    expect(inspectBuffer({ ...media([[0, 8]]), currentTime: NaN }, 5).ready).toBe(false)
    expect(inspectBuffer({ ...media([[0, 8]]), currentTime: Infinity }, 5).ready).toBe(false)
    expect(inspectBuffer(media([[NaN, 8], [3, 2], [0, Infinity]]), 5)).toEqual({ ready: false, bufferedSeconds: 0, totalBufferedSeconds: 0 })
    const broken = { ...media([[0, 8]]) }
    broken.buffered.end = () => { throw new Error('range changed') }
    expect(inspectBuffer(broken, 5)).toEqual({ ready: false, bufferedSeconds: 0, totalBufferedSeconds: 0 })
  })

  it('waits only for measured readiness and does not fetch or reload media', async () => {
    vi.useFakeTimers()
    const element = { ...media([]), load: vi.fn(), fetch: vi.fn() }
    const result = waitForBuffer(element, 2, () => true)
    await vi.advanceTimersByTimeAsync(100)
    element.buffered = media([[0, 5]]).buffered
    await vi.advanceTimersByTimeAsync(50)
    expect(await result).toBe(true)
    expect(element.load).not.toHaveBeenCalled()
    expect(element.fetch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects stale work even when the media is ready', async () => {
    vi.useFakeTimers()
    expect(await waitForBuffer(media([[0, 8]]), 2, () => false)).toBe(false)
    let current = true
    const element = media([])
    const result = waitForBuffer(element, 2, () => current)
    current = false
    element.buffered = media([[0, 8]]).buffered
    await vi.advanceTimersByTimeAsync(50)
    expect(await result).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops after the default timeout', async () => {
    vi.useFakeTimers()
    const result = waitForBuffer(media([]), 2, () => true)
    await vi.advanceTimersByTimeAsync(600)
    expect(await result).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([NaN, Infinity])('keeps a non-finite timeout (%s) bounded', async timeout => {
    vi.useFakeTimers()
    const result = waitForBuffer(media([]), 2, () => true, timeout)
    await vi.advanceTimersByTimeAsync(650)
    expect(vi.getTimerCount()).toBe(0)
    expect(await result).toBe(false)
  })
})
