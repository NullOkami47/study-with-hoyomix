import { describe, expect, it, vi } from 'vitest'

import { createSleepTimerStore, SLEEP_STORAGE_KEY } from './store'

class FakeClock {
  constructor(private value = 0) {}
  now(): number { return this.value }
  advance(milliseconds: number): void { this.value += milliseconds }
}

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    values,
  }
}

describe('sleep timer store', () => {
  it('persists preset and custom duration settings separately from Pomodoro state', () => {
    const storage = memoryStorage()
    const store = createSleepTimerStore({ storage, player: { pause() {}, stop() {} }, autoTick: false })

    store.selectDuration(45)
    store.setCustomDuration(7)
    store.selectDuration(7)

    const snapshot = JSON.parse(storage.values.get(SLEEP_STORAGE_KEY)!)
    expect(snapshot.selectedMinutes).toBe(7)
    expect(snapshot.customMinutes).toBe(7)
    expect(snapshot).not.toHaveProperty('phase')
  })

  it('recovers a running sleep timer after reload', () => {
    const clock = new FakeClock(1_000)
    const storage = memoryStorage()
    const player = { pause: vi.fn(), stop: vi.fn() }
    const first = createSleepTimerStore({ clock, storage, player, autoTick: false })
    first.selectDuration(15)
    first.start()
    clock.advance(60_000)

    const recovered = createSleepTimerStore({ clock, storage, player, autoTick: false })
    expect(recovered.status.value).toBe('running')
    expect(recovered.remainingSeconds.value).toBe(14 * 60)
  })

  it('pauses and stops playback exactly once when tab throttling reaches expiry', () => {
    const clock = new FakeClock()
    const player = { pause: vi.fn(), stop: vi.fn() }
    const store = createSleepTimerStore({ clock, storage: memoryStorage(), player, autoTick: false })
    store.selectDuration(15)
    store.start()

    clock.advance(15 * 60_000)
    store.tick()
    store.tick()

    expect(store.status.value).toBe('expired')
    expect(store.remainingSeconds.value).toBe(0)
    expect(player.pause).not.toHaveBeenCalled()
    expect(player.stop).toHaveBeenCalledTimes(1)
  })

  it('fails closed when persisted running state has no deadline', () => {
    const storage = memoryStorage()
    storage.values.set(SLEEP_STORAGE_KEY, JSON.stringify({
      customMinutes: 15, deadline: null, remainingSeconds: 300, selectedMinutes: 15, status: 'running',
    }))
    const store = createSleepTimerStore({ storage, player: { pause() {}, stop() {} }, autoTick: false })

    expect(store.status.value).toBe('paused')
    expect(store.remainingSeconds.value).toBe(300)
  })

  it('keeps anonymous timing usable when injected storage is denied', () => {
    const storage = {
      getItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      setItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      removeItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
    }

    expect(() => createSleepTimerStore({ storage, player: { pause() {}, stop() {} }, autoTick: false })).not.toThrow()
  })
})
