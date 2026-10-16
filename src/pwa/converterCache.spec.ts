import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareConverterCache } from './converterCache'

const original = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
beforeEach(() => { vi.stubEnv('DEV', false) })
afterEach(() => {
  if (original) Object.defineProperty(navigator, 'serviceWorker', original)
  else Reflect.deleteProperty(navigator, 'serviceWorker')
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
const worker = (value: unknown) => Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value })

describe('first-visit converter cache control', () => {
  it('does not wait for a disabled PWA in development', async () => {
    vi.stubEnv('DEV', true)
    const ready = vi.fn()
    worker({ controller: null, get ready() { ready(); return new Promise(() => {}) } })
    await prepareConverterCache()
    expect(ready).not.toHaveBeenCalled()
  })
  it('uses the existing controller without messaging or waiting', async () => {
    const ready = vi.fn()
    worker({ controller: {}, get ready() { ready(); return Promise.resolve({}) } })
    await prepareConverterCache()
    expect(ready).not.toHaveBeenCalled()
  })
  it('requests control from the active worker and never activates a waiting update', async () => {
    const waiting = { postMessage: vi.fn() }
    const serviceWorker = new EventTarget() as EventTarget & { controller: unknown; ready: Promise<unknown> }
    const active = { postMessage: vi.fn((_message, ports: MessagePort[]) => {
      serviceWorker.controller = {}
      serviceWorker.dispatchEvent(new Event('controllerchange'))
      ports[0].postMessage({ controlled: true })
    }) }
    Object.assign(serviceWorker, { controller: null, ready: Promise.resolve({ active, waiting }) })
    worker(serviceWorker)
    await prepareConverterCache()
    expect(active.postMessage.mock.calls[0][0]).toEqual({ type: 'CLAIM_FOR_CHINESE_TITLE' })
    expect(waiting.postMessage).not.toHaveBeenCalled()
  })
  it('does not block dictionary loading indefinitely on an older worker', async () => {
    vi.useFakeTimers()
    worker(Object.assign(new EventTarget(), { controller: null, ready: new Promise(() => {}) }))
    const prepared = prepareConverterCache()
    const failed = expect(prepared).rejects.toThrow('controller unavailable')
    await vi.advanceTimersByTimeAsync(30_000)
    await failed
  })
})
