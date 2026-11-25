import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmTransitionStart } from './transitionStart'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
function fixture() {
  const element = document.createElement('audio')
  element.src = 'https://media.invalid/prepared.mp3'
  Object.defineProperties(element, {
    paused: { configurable: true, value: false },
    ended: { configurable: true, value: false },
    readyState: { configurable: true, value: 4 },
  })
  const controller = new AbortController()
  const requestPlay = vi.fn(async () => {})
  const removed = vi.spyOn(element, 'removeEventListener')
  const start = () => confirmTransitionStart(element, requestPlay, controller.signal)
  return { element, controller, requestPlay, removed, start }
}

describe('foreground transition start confirmation', () => {
  it('keeps the outgoing track until both native playing and play permission are confirmed', async () => {
    const f = fixture()
    let settled = false
    const pending = f.start().then(() => { settled = true })
    await Promise.resolve(); await Promise.resolve()
    expect(settled).toBe(false)
    f.element.dispatchEvent(new Event('playing'))
    await pending
    expect(settled).toBe(true)
    expect(f.requestPlay).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.removed).toHaveBeenCalledWith('playing', expect.any(Function))
  })

  it('accepts a synchronous playing event only once the pending play promise settles', async () => {
    const f = fixture()
    let accept!: () => void
    f.requestPlay.mockImplementation(() => {
      f.element.dispatchEvent(new Event('playing'))
      return new Promise(resolve => { accept = resolve })
    })
    let settled = false
    const pending = f.start().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    accept(); await pending
    expect(settled).toBe(true)
  })

  it.each(['pause', 'error', 'source-change'] as const)('does not accept %s between playing and play promise settlement', async action => {
    const f = fixture()
    let accept!: () => void
    f.requestPlay.mockImplementation(() => new Promise(resolve => { accept = resolve }))
    const pending = f.start()
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    f.element.dispatchEvent(new Event('playing'))
    if (action === 'pause') Object.defineProperty(f.element, 'paused', { value: true })
    if (action === 'error') Object.defineProperty(f.element, 'error', { value: { code: 4 } })
    if (action === 'source-change') f.element.src = 'https://media.invalid/different.mp3'
    accept(); await rejected
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels immediately and removes listeners when Pause/Stop invalidates the candidate', async () => {
    const f = fixture()
    const rejected = expect(f.start()).rejects.toMatchObject({ name: 'AbortError' })
    f.controller.abort()
    await rejected
    f.element.dispatchEvent(new Event('playing'))
    expect(f.removed).toHaveBeenCalledWith('error', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not call play for a candidate already cancelled', async () => {
    const f = fixture(); f.controller.abort()
    await expect(f.start()).rejects.toMatchObject({ name: 'AbortError' })
    expect(f.requestPlay).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds an unconfirmed start and preserves the actual autoplay rejection', async () => {
    const f = fixture()
    const rejected = expect(f.start()).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(1500)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    const denied = new DOMException('Denied', 'NotAllowedError')
    f.requestPlay.mockRejectedValue(denied)
    await expect(f.start()).rejects.toBe(denied)
    expect(vi.getTimerCount()).toBe(0)
  })
})
