import { describe, expect, it, vi } from 'vitest'

import { createPomodoroStore, POMODORO_STORAGE_KEY } from './store'

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

interface PersistedFocusFinalization {
  run: {
    id: string
    plannedFocusSeconds: number
    startedAt: number
  }
  actualFocusSeconds: number
  endedAt: number
  presentSummary: boolean
  status: 'completed' | 'interrupted'
}

interface PersistedPomodoroSnapshot {
  focusBehaviour: 'continue' | 'pauseWhenHidden'
  focusRun: PersistedFocusFinalization['run'] | null
  pendingFocusFinalizations: PersistedFocusFinalization[]
  phase: 'focus' | 'break' | 'longBreak'
  remainingSeconds: number
  status: 'idle' | 'running' | 'paused'
}

function readSnapshot(storage: ReturnType<typeof memoryStorage>): PersistedPomodoroSnapshot {
  return JSON.parse(
    storage.values.get(POMODORO_STORAGE_KEY) ?? '{}',
  ) as PersistedPomodoroSnapshot
}

describe('pomodoro store', () => {
  it('persists an independent long-break duration and uses it for the long-break phase', () => {
    const storage = memoryStorage()
    const store = createPomodoroStore({
      storage,
      autoTick: false,
      focusMinutes: 25,
      breakMinutes: 5,
      longBreakMinutes: 18,
    })

    store.setLongBreakMinutes(20)
    store.selectPhase('longBreak')

    expect(store.longBreakMinutes.value).toBe(20)
    expect(store.remainingSeconds.value).toBe(1_200)
    expect(JSON.parse(storage.values.get(POMODORO_STORAGE_KEY) ?? '{}').longBreakMinutes).toBe(20)
  })

  it('migrates a legacy snapshot by deriving the missing long break from its short break', () => {
    const storage = memoryStorage()
    storage.values.set(POMODORO_STORAGE_KEY, JSON.stringify({
      breakMinutes: 7, completedPomodoros: 0, cycleCount: 4, deadline: null,
      focusMinutes: 25, phase: 'longBreak', remainingSeconds: 840, status: 'idle',
    }))

    const store = createPomodoroStore({ storage, autoTick: false })

    expect(store.longBreakMinutes.value).toBe(14)
    expect(store.pauseMusicDuringBreak.value).toBe(true)
    expect(JSON.parse(storage.values.get(POMODORO_STORAGE_KEY) ?? '{}').longBreakMinutes).toBe(14)
    expect(JSON.parse(storage.values.get(POMODORO_STORAGE_KEY) ?? '{}').pauseMusicDuringBreak).toBe(true)
    expect(readSnapshot(storage).focusRun).toBeNull()
    expect(readSnapshot(storage).pendingFocusFinalizations).toEqual([])
  })

  it('persists the benign pause-music-during-break setting through its explicit setter', () => {
    const storage = memoryStorage()
    const store = createPomodoroStore({ storage, autoTick: false })

    store.setPauseMusicDuringBreak(false)

    expect(store.pauseMusicDuringBreak.value).toBe(false)
    expect(JSON.parse(storage.values.get(POMODORO_STORAGE_KEY) ?? '{}').pauseMusicDuringBreak).toBe(false)
  })

  it('starts, pauses, and resumes from the deadline rather than render ticks', () => {
    const clock = new FakeClock(1_000)
    const store = createPomodoroStore({ clock, storage: memoryStorage(), autoTick: false, focusMinutes: 1, breakMinutes: 1 })

    store.start()
    clock.advance(20_000)
    store.pause()
    expect(store.remainingSeconds.value).toBe(40)

    clock.advance(30_000)
    store.tick()
    expect(store.remainingSeconds.value).toBe(40)

    store.resume()
    clock.advance(39_000)
    store.tick()
    expect(store.remainingSeconds.value).toBe(1)
  })

  it('recovers an active session after reload using persisted deadline state', () => {
    const clock = new FakeClock(5_000)
    const storage = memoryStorage()
    const first = createPomodoroStore({ clock, storage, autoTick: false, focusMinutes: 1, breakMinutes: 1 })
    first.start()
    clock.advance(21_000)

    const recovered = createPomodoroStore({ clock, storage, autoTick: false })

    expect(recovered.status.value).toBe('running')
    expect(recovered.remainingSeconds.value).toBe(39)
    expect(storage.values.has(POMODORO_STORAGE_KEY)).toBe(true)
  })

  it('reports the expired phase duration while recovering an overdue session', () => {
    const clock = new FakeClock(61_000)
    const storage = memoryStorage()
    const expired = vi.fn()
    storage.values.set(POMODORO_STORAGE_KEY, JSON.stringify({
      breakMinutes: 1, completedPomodoros: 0, cycleCount: 4, deadline: 60_000,
      focusMinutes: 1, phase: 'focus', remainingSeconds: 60, status: 'running',
    }))

    createPomodoroStore({ clock, storage, autoTick: false, onPhaseExpired: expired })

    expect(expired).toHaveBeenCalledWith({
      catchUpCapped: false,
      durationSeconds: 60,
      expiredAt: 60_000,
      isLastInBatch: true,
      nextPhase: 'break',
      pauseMusicDuringBreak: true,
      phase: 'focus',
    })
  })

  it('survives a route-level component change because state is independent of rendering', () => {
    const clock = new FakeClock()
    const store = createPomodoroStore({ clock, storage: memoryStorage(), autoTick: false, focusMinutes: 1 })
    store.start()

    clock.advance(12_000)
    store.tick()

    expect(store.status.value).toBe('running')
    expect(store.remainingSeconds.value).toBe(48)
  })

  it('cancels an automatic tick with its owning scheduler exactly once', () => {
    const clock = new FakeClock()
    const handle = 17 as unknown as ReturnType<typeof setTimeout>
    const timers = {
      clearTimeout: vi.fn(),
      setTimeout: vi.fn(() => handle),
    }
    const store = createPomodoroStore({
      clock,
      storage: memoryStorage(),
      timers,
      focusMinutes: 1,
    })

    store.start()
    try {
      expect(timers.setTimeout).toHaveBeenCalledTimes(1)
    } finally {
      store.destroy()
    }
    store.destroy()

    expect(timers.clearTimeout).toHaveBeenCalledTimes(1)
    expect(timers.clearTimeout).toHaveBeenCalledWith(handle)
  })

  it('catches up after tab throttling and expires phases at the exact deadline', () => {
    const clock = new FakeClock()
    const expired = vi.fn()
    const store = createPomodoroStore({
      clock,
      storage: memoryStorage(),
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      onPhaseExpired: expired,
    })
    store.start()

    clock.advance(60_000)
    store.tick()
    expect(store.phase.value).toBe('break')
    expect(store.completedPomodoros.value).toBe(1)
    expect(store.remainingSeconds.value).toBe(60)
    expect(expired).toHaveBeenCalledTimes(1)

    clock.advance(120_000)
    store.tick()
    expect(store.phase.value).toBe('break')
    expect(store.completedPomodoros.value).toBe(2)
    expect(store.remainingSeconds.value).toBe(60)
    expect(expired).toHaveBeenCalledTimes(3)
  })

  it('marks only the final transition in a multi-phase catch-up batch', () => {
    const clock = new FakeClock()
    const expired = vi.fn()
    const store = createPomodoroStore({
      clock,
      storage: memoryStorage(),
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      onPhaseExpired: expired,
    })
    store.start()

    clock.advance(180_000)
    store.tick()

    expect(expired.mock.calls.map(([event]) => ({
      isLastInBatch: event.isLastInBatch,
      nextPhase: event.nextPhase,
      phase: event.phase,
    }))).toEqual([
      { isLastInBatch: false, nextPhase: 'break', phase: 'focus' },
      { isLastInBatch: false, nextPhase: 'focus', phase: 'break' },
      { isLastInBatch: true, nextPhase: 'break', phase: 'focus' },
    ])
  })

  it('fails closed after a large catch-up cap without scheduling another side-effect batch', () => {
    const clock = new FakeClock()
    const expired = vi.fn()
    const store = createPomodoroStore({
      clock,
      storage: memoryStorage(),
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      onPhaseExpired: expired,
    })
    store.start()

    // Four one-minute focus/break pairs end in a two-minute long break:
    // 1,126 minutes therefore crosses 1,001 phase boundaries.
    clock.advance(1_126 * 60_000)
    store.tick()
    store.tick()

    expect(store.completedPomodoros.value).toBe(500)
    expect(store.phase.value).toBe('focus')
    expect(store.status.value).toBe('paused')
    expect(store.remainingSeconds.value).toBe(60)
    expect(expired).toHaveBeenCalledTimes(1_000)
    expect(expired.mock.calls.filter(([event]) => event.isLastInBatch)).toHaveLength(1)
    expect(expired.mock.lastCall?.[0]).toMatchObject({
      catchUpCapped: true,
      isLastInBatch: true,
      nextPhase: 'focus',
    })
  })

  it('fails closed when persisted running state has no deadline', () => {
    const storage = memoryStorage()
    storage.values.set(POMODORO_STORAGE_KEY, JSON.stringify({
      breakMinutes: 5, completedPomodoros: 0, cycleCount: 4, deadline: null,
      focusMinutes: 25, phase: 'focus', remainingSeconds: 900, status: 'running',
    }))

    const store = createPomodoroStore({ storage, autoTick: false })

    expect(store.status.value).toBe('paused')
    expect(store.remainingSeconds.value).toBe(900)
  })

  it('keeps anonymous timing usable when injected storage is denied', () => {
    const storage = {
      getItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      setItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      removeItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
    }

    expect(() => createPomodoroStore({ storage, autoTick: false })).not.toThrow()
  })

  it('selects an idle or paused phase with its phase duration and a cleared deadline', () => {
    const storage = memoryStorage()
    const store = createPomodoroStore({ storage, autoTick: false, focusMinutes: 1, breakMinutes: 2 })

    store.selectPhase('longBreak')

    expect(store.status.value).toBe('idle')
    expect(store.phase.value).toBe('longBreak')
    expect(store.remainingSeconds.value).toBe(240)
    expect(JSON.parse(storage.values.get(POMODORO_STORAGE_KEY) ?? '{}')).toMatchObject({
      deadline: null,
      phase: 'longBreak',
      remainingSeconds: 240,
      status: 'idle',
    })
  })

  it('does not change phase while a timer is running', () => {
    const store = createPomodoroStore({ storage: memoryStorage(), autoTick: false, focusMinutes: 1, breakMinutes: 2 })
    store.start()

    store.selectPhase('break')

    expect(store.status.value).toBe('running')
    expect(store.phase.value).toBe('focus')
    expect(store.remainingSeconds.value).toBe(60)
  })

  it('reports only accepted reset and manual phase controls through the typed lifecycle seam', () => {
    const onControl = vi.fn()
    const store = createPomodoroStore({
      storage: memoryStorage(),
      autoTick: false,
      onControl,
    })

    store.reset()
    store.selectPhase('longBreak')
    store.start()
    store.selectPhase('break')

    expect(onControl.mock.calls).toEqual([
      [{ type: 'reset' }],
      [{ type: 'selectPhase', phase: 'longBreak' }],
    ])
  })

  it('persists one stable focus run through pause, reload, and resume before finalising a true interruption once', () => {
    const clock = new FakeClock()
    const storage = memoryStorage()
    const finalized = vi.fn((_event: PersistedFocusFinalization) => true)
    const first = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      focusMinutes: 1,
      onFocusSessionFinalized: finalized,
    })

    first.start()
    const startedRun = readSnapshot(storage).focusRun
    expect(startedRun).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
      plannedFocusSeconds: 60,
      startedAt: 0,
    })

    clock.advance(20_000)
    first.pause()
    expect(readSnapshot(storage).focusRun).toEqual(startedRun)
    first.destroy()

    clock.advance(300_000)
    const recovered = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      onFocusSessionFinalized: finalized,
    })
    expect(readSnapshot(storage).focusRun).toEqual(startedRun)

    recovered.resume()
    clock.advance(10_000)
    recovered.reset()

    expect(finalized).toHaveBeenCalledTimes(1)
    expect(finalized).toHaveBeenCalledWith({
      actualFocusSeconds: 30,
      endedAt: 330_000,
      presentSummary: true,
      run: startedRun,
      status: 'interrupted',
    })
    expect(readSnapshot(storage).focusRun).toBeNull()
    expect(readSnapshot(storage).pendingFocusFinalizations).toEqual([])
  })

  it('synchronises a running focus deadline before reset so unrendered elapsed time is not lost', () => {
    const clock = new FakeClock(1_000)
    const finalized = vi.fn((_event: PersistedFocusFinalization) => true)
    const store = createPomodoroStore({
      clock,
      storage: memoryStorage(),
      autoTick: false,
      focusMinutes: 1,
      onFocusSessionFinalized: finalized,
    })

    store.start()
    clock.advance(15_000)
    store.reset()

    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      actualFocusSeconds: 15,
      endedAt: 16_000,
      status: 'interrupted',
    }))
  })

  it('finalises a paused focus select-away but fabricates nothing for zero elapsed, break, or idle controls', () => {
    const clock = new FakeClock()
    const storage = memoryStorage()
    const finalized = vi.fn(() => true)
    const store = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      onFocusSessionFinalized: finalized,
    })

    store.start()
    store.reset()
    store.selectPhase('break')
    store.start()
    store.reset()
    store.start()
    store.pause()
    store.selectPhase('longBreak')
    store.reset()
    expect(finalized).not.toHaveBeenCalled()

    store.start()
    clock.advance(12_000)
    store.pause()
    store.selectPhase('break')

    expect(finalized).toHaveBeenCalledTimes(1)
    expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
      actualFocusSeconds: 12,
      presentSummary: true,
      status: 'interrupted',
    }))
  })

  it('records every completed focus in catch-up and presents only the chronologically last completion', () => {
    const clock = new FakeClock()
    const storage = memoryStorage()
    const finalized = vi.fn((_event: PersistedFocusFinalization) => true)
    const store = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      longBreakMinutes: 1,
      onFocusSessionFinalized: finalized,
    })

    store.start()
    clock.advance(300_000)
    store.tick()

    const completed = finalized.mock.calls.map(([event]) => event)
    expect(completed).toHaveLength(3)
    expect(completed.map((event) => event.endedAt)).toEqual([60_000, 180_000, 300_000])
    expect(completed.map((event) => event.run.startedAt)).toEqual([0, 120_000, 240_000])
    expect(completed.map((event) => event.presentSummary)).toEqual([false, false, true])
    expect(new Set(completed.map((event) => event.run.id)).size).toBe(3)
  })

  it('marks the last completed focus for summary even when a later break transition ends the batch', () => {
    const clock = new FakeClock()
    const finalized = vi.fn((_event: PersistedFocusFinalization) => true)
    const store = createPomodoroStore({
      clock,
      storage: memoryStorage(),
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      longBreakMinutes: 1,
      onFocusSessionFinalized: finalized,
    })

    store.start()
    clock.advance(240_000)
    store.tick()

    expect(finalized.mock.calls.map(([event]) => ({
      endedAt: event.endedAt,
      presentSummary: event.presentSummary,
    }))).toEqual([
      { endedAt: 60_000, presentSummary: false },
      { endedAt: 180_000, presentSummary: true },
    ])
  })

  it('persists the completed next state before callback delivery and acknowledges in a second snapshot', () => {
    const clock = new FakeClock()
    const storage = memoryStorage()
    let pendingWasDurableAtDelivery = false
    const finalized = vi.fn((event: PersistedFocusFinalization) => {
      const snapshot = readSnapshot(storage)
      pendingWasDurableAtDelivery = snapshot.phase === 'break' &&
        snapshot.pendingFocusFinalizations.some(({ run }) => run.id === event.run.id)
      return true
    })
    const store = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      onFocusSessionFinalized: finalized,
    })

    store.start()
    clock.advance(60_000)
    store.tick()

    expect(pendingWasDurableAtDelivery).toBe(true)
    expect(readSnapshot(storage).pendingFocusFinalizations).toEqual([])
  })

  it('replays a persisted unacknowledged finalisation on hydration without delivering it twice', () => {
    const clock = new FakeClock()
    const storage = memoryStorage()
    const first = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      onFocusSessionFinalized: () => false,
    })
    first.start()
    clock.advance(60_000)
    first.tick()
    first.destroy()
    expect(readSnapshot(storage).pendingFocusFinalizations).toHaveLength(1)

    const replayed = vi.fn(() => true)
    const recovered = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      onFocusSessionFinalized: replayed,
    })
    recovered.tick()

    expect(replayed).toHaveBeenCalledTimes(1)
    expect(readSnapshot(storage).pendingFocusFinalizations).toEqual([])
  })

  it('keeps a legacy partial paused focus untracked through resume, reset, and expiry', () => {
    const clock = new FakeClock(20_000)
    const storage = memoryStorage()
    const finalized = vi.fn((_event: PersistedFocusFinalization) => true)
    const legacyPartialSnapshot = () => JSON.stringify({
      breakMinutes: 1,
      completedPomodoros: 0,
      cycleCount: 4,
      deadline: null,
      focusMinutes: 1,
      focusRun: null,
      longBreakMinutes: 1,
      pauseMusicDuringBreak: true,
      pendingFocusFinalizations: [],
      phase: 'focus',
      remainingSeconds: 40,
      status: 'paused',
    })
    storage.values.set(POMODORO_STORAGE_KEY, legacyPartialSnapshot())
    const resetStore = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      onFocusSessionFinalized: finalized,
    })

    resetStore.resume()
    expect(readSnapshot(storage).focusRun).toBeNull()
    resetStore.reset()
    expect(finalized).not.toHaveBeenCalled()

    storage.values.set(POMODORO_STORAGE_KEY, legacyPartialSnapshot())
    const expiryStore = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      onFocusSessionFinalized: finalized,
    })
    expiryStore.resume()
    clock.advance(40_000)
    expiryStore.tick()

    expect(finalized).not.toHaveBeenCalled()
    expect(expiryStore.phase.value).toBe('break')
  })

  it('does not create a pending history backlog when no lifecycle listener is installed', () => {
    const clock = new FakeClock()
    const storage = memoryStorage()
    const store = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      longBreakMinutes: 1,
    })

    store.start()
    clock.advance(300_000)
    store.tick()

    expect(readSnapshot(storage).pendingFocusFinalizations).toEqual([])
  })

  it('keeps callback-false pending work across denied-storage store recreation', () => {
    const clock = new FakeClock()
    const storage = {
      getItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      setItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      removeItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
    }
    const firstDelivery = vi.fn((_event: PersistedFocusFinalization) => false)
    const first = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      onFocusSessionFinalized: firstDelivery,
    })
    first.start()
    clock.advance(60_000)
    first.tick()
    first.destroy()
    expect(firstDelivery).toHaveBeenCalled()

    const replayed: PersistedFocusFinalization[] = []
    const second = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      onFocusSessionFinalized: (event) => {
        replayed.push(event)
        return true
      },
    })
    second.destroy()

    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toEqual(firstDelivery.mock.calls[0][0])
    const thirdDelivery = vi.fn((_event: PersistedFocusFinalization) => true)
    createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      onFocusSessionFinalized: thirdDelivery,
    })
    expect(thirdDelivery).not.toHaveBeenCalled()
  })

  it('hands a saturated new finalisation directly to the callback without evicting old pending rows', () => {
    const clock = new FakeClock(10_000)
    const storage = memoryStorage()
    const activeRun = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      plannedFocusSeconds: 60,
      startedAt: 0,
    }
    const pendingFocusFinalizations = Array.from({ length: 1_024 }, (_, index) => ({
      run: {
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        plannedFocusSeconds: 60,
        startedAt: index * 1_000,
      },
      actualFocusSeconds: 60,
      endedAt: index * 1_000 + 60_000,
      presentSummary: false,
      status: 'completed',
    }))
    storage.values.set(POMODORO_STORAGE_KEY, JSON.stringify({
      breakMinutes: 1, completedPomodoros: 0, cycleCount: 4, deadline: null,
      focusMinutes: 1, focusRun: activeRun, longBreakMinutes: 1,
      pauseMusicDuringBreak: true, pendingFocusFinalizations, phase: 'focus',
      remainingSeconds: 50, status: 'paused',
    }))
    const errors = vi.fn()
    const delivered: PersistedFocusFinalization[] = []
    const store = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      onFocusSessionError: errors,
      onFocusSessionFinalized: (event) => {
        delivered.push(event)
        return event.run.id === activeRun.id
      },
    })

    store.reset()

    expect(delivered.some(({ run }) => run.id === activeRun.id)).toBe(true)
    expect(readSnapshot(storage).pendingFocusFinalizations).toHaveLength(1_024)
    expect(errors).not.toHaveBeenCalled()
  })

  it('retains a callback-false saturated event in page overflow and replays it after recreation', () => {
    const clock = new FakeClock(10_000)
    const storage = memoryStorage()
    const activeRun = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      plannedFocusSeconds: 60,
      startedAt: 0,
    }
    const pendingFocusFinalizations = Array.from({ length: 1_024 }, (_, index) => ({
      run: {
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        plannedFocusSeconds: 60,
        startedAt: index * 1_000,
      },
      actualFocusSeconds: 60,
      endedAt: index * 1_000 + 60_000,
      presentSummary: false,
      status: 'completed',
    }))
    storage.values.set(POMODORO_STORAGE_KEY, JSON.stringify({
      breakMinutes: 1, completedPomodoros: 0, cycleCount: 4, deadline: null,
      focusMinutes: 1, focusRun: activeRun, longBreakMinutes: 1,
      pauseMusicDuringBreak: true, pendingFocusFinalizations, phase: 'focus',
      remainingSeconds: 50, status: 'paused',
    }))
    const errors = vi.fn()
    const first = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      onFocusSessionError: errors,
      onFocusSessionFinalized: () => false,
    })
    first.reset()
    first.destroy()

    expect(errors).toHaveBeenCalledWith(expect.objectContaining({
      code: 'pending_overflow',
      fatal: false,
      name: 'PomodoroFocusQueueCapacityError',
    }))
    const replayed: PersistedFocusFinalization[] = []
    createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      onFocusSessionFinalized: (event) => {
        replayed.push(event)
        return true
      },
    })

    expect(replayed).toHaveLength(1_025)
    expect(replayed.at(-1)?.run.id).toBe(activeRun.id)
    expect(readSnapshot(storage).pendingFocusFinalizations).toEqual([])
  })

  it('preserves the oldest 1,024 overflow rows and emits a fatal typed signal when both queues are full', () => {
    const clock = new FakeClock(10_000)
    const storage = memoryStorage()
    const activeRun = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      plannedFocusSeconds: 60,
      startedAt: 0,
    }
    const pendingFocusFinalizations = Array.from({ length: 1_024 }, (_, index) => ({
      run: {
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        plannedFocusSeconds: 60,
        startedAt: index * 1_000,
      },
      actualFocusSeconds: 60,
      endedAt: index * 1_000 + 60_000,
      presentSummary: false,
      status: 'completed',
    }))
    storage.values.set(POMODORO_STORAGE_KEY, JSON.stringify({
      breakMinutes: 1, completedPomodoros: 0, cycleCount: 12, deadline: null,
      focusMinutes: 1, focusRun: activeRun, longBreakMinutes: 1,
      pauseMusicDuringBreak: true, pendingFocusFinalizations, phase: 'focus',
      remainingSeconds: 50, status: 'paused',
    }))
    let acknowledge = false
    const acknowledgedIds = new Set<string>()
    const errors = vi.fn()
    const store = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      longBreakMinutes: 1,
      cycleCount: 12,
      onFocusSessionError: errors,
      onFocusSessionFinalized: (event) => {
        if (acknowledge) acknowledgedIds.add(event.run.id)
        return acknowledge
      },
    })

    store.reset()
    store.start()
    clock.advance(1_001 * 60_000)
    store.tick()
    store.resume()
    clock.advance(1_001 * 60_000)
    store.tick()
    store.resume()
    clock.advance(47 * 60_000)
    store.tick()

    expect(errors.mock.calls.filter(([error]) => error.code === 'pending_overflow')).toHaveLength(1_024)
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({
      code: 'overflow_full',
      fatal: true,
      name: 'PomodoroFocusQueueCapacityError',
    }))
    expect(readSnapshot(storage).pendingFocusFinalizations).toHaveLength(1_024)

    acknowledge = true
    store.pause()
    expect(acknowledgedIds.size).toBe(2_048)
    expect(readSnapshot(storage).pendingFocusFinalizations).toEqual([])
  })

  it('replays a full pending queue before appending a newly interrupted focus', () => {
    const clock = new FakeClock(10_000)
    const storage = memoryStorage()
    const activeRun = {
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      plannedFocusSeconds: 60,
      startedAt: 0,
    }
    const pendingFocusFinalizations = Array.from({ length: 1_024 }, (_, index) => ({
      run: {
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        plannedFocusSeconds: 60,
        startedAt: index * 1_000,
      },
      actualFocusSeconds: 60,
      endedAt: index * 1_000 + 60_000,
      presentSummary: false,
      status: 'completed',
    }))
    storage.values.set(POMODORO_STORAGE_KEY, JSON.stringify({
      breakMinutes: 1,
      completedPomodoros: 0,
      cycleCount: 4,
      deadline: null,
      focusMinutes: 1,
      focusRun: activeRun,
      longBreakMinutes: 1,
      pauseMusicDuringBreak: true,
      pendingFocusFinalizations,
      phase: 'focus',
      remainingSeconds: 50,
      status: 'paused',
    }))
    let acknowledge = false
    const delivered: PersistedFocusFinalization[] = []
    const store = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      onFocusSessionFinalized: (event) => {
        delivered.push(event)
        return acknowledge
      },
    })
    expect(delivered).toHaveLength(1_024)
    delivered.length = 0
    acknowledge = true

    store.reset()

    expect(delivered).toHaveLength(1_025)
    expect(delivered.some(({ run }) => run.id === activeRun.id)).toBe(true)
    expect(readSnapshot(storage).pendingFocusFinalizations).toEqual([])
  })

  it('caps catch-up at processed focus expiries without creating a synthetic future focus run', () => {
    const clock = new FakeClock()
    const storage = memoryStorage()
    const finalized = vi.fn(() => false)
    const store = createPomodoroStore({
      clock,
      storage,
      autoTick: false,
      focusMinutes: 1,
      breakMinutes: 1,
      longBreakMinutes: 1,
      cycleCount: 12,
      onFocusSessionFinalized: finalized,
    })

    store.start()
    clock.advance(1_001 * 60_000)
    store.tick()
    store.tick()

    const snapshot = readSnapshot(storage)
    expect(finalized).toHaveBeenCalledTimes(500)
    expect(snapshot.pendingFocusFinalizations).toHaveLength(500)
    expect(snapshot.pendingFocusFinalizations.filter(({ presentSummary }) => presentSummary)).toHaveLength(1)
    expect(snapshot.focusRun).toBeNull()
    expect(snapshot.phase).toBe('focus')
    expect(snapshot.status).toBe('paused')
    expect(snapshot.remainingSeconds).toBe(60)
  })

  it('defaults, persists, and rehydrates the exact focus behaviour enum', () => {
    const storage = memoryStorage()
    const first = createPomodoroStore({ storage, autoTick: false })
    expect(first.focusBehaviour.value).toBe('continue')
    first.setFocusBehaviour('pauseWhenHidden')
    expect(first.focusBehaviour.value).toBe('pauseWhenHidden')
    expect(readSnapshot(storage).focusBehaviour).toBe('pauseWhenHidden')
    first.destroy()

    const recovered = createPomodoroStore({ storage, autoTick: false })
    expect(recovered.focusBehaviour.value).toBe('pauseWhenHidden')
    recovered.destroy()
  })
})
