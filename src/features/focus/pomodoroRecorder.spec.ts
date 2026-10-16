import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'

import {
  FOCUS_POMODORO_OUTBOX_STORAGE_KEY,
  MAX_FOCUS_OUTBOX_RECORDS,
  createPomodoroFocusRecorder,
} from './pomodoroRecorder'
import {
  FocusSessionConflictError,
  createFocusSessionRepository,
} from './localRepository'
import type { FocusSessionRecord } from './types'
import {
  createPomodoroStore,
  POMODORO_STORAGE_KEY,
  type PomodoroFocusSessionFinalized,
} from '../timers/pomodoro/store'

interface FocusOutboxEntry {
  presentSummary: boolean
  record: FocusSessionRecord
}

function memoryStorage() {
  const values = new Map<string, string>()
  const writes: Array<{ key: string; value: string }> = []
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push({ key, value })
      values.set(key, value)
    },
    removeItem: (key: string) => { values.delete(key) },
    values,
    writes,
  }
}

function focusEvent(
  overrides: Partial<PomodoroFocusSessionFinalized> = {},
): PomodoroFocusSessionFinalized {
  return {
    run: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      plannedFocusSeconds: 60,
      startedAt: 0,
    },
    actualFocusSeconds: 60,
    endedAt: 60_000,
    presentSummary: true,
    status: 'completed',
    ...overrides,
  }
}

function focusRecord(overrides: Partial<FocusSessionRecord> = {}): FocusSessionRecord {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    schemaVersion: 1,
    startedAt: '1970-01-01T00:00:00.000Z',
    endedAt: '1970-01-01T00:01:00.000Z',
    plannedFocusSeconds: 60,
    actualFocusSeconds: 60,
    status: 'completed',
    phase: 'focus',
    createdAt: '1970-01-01T00:01:00.000Z',
    ...overrides,
  }
}

function readOutbox(storage: ReturnType<typeof memoryStorage>): FocusOutboxEntry[] {
  return JSON.parse(
    storage.values.get(FOCUS_POMODORO_OUTBOX_STORAGE_KEY) ?? '[]',
  ) as FocusOutboxEntry[]
}

function readPendingFinalizations(storage: ReturnType<typeof memoryStorage>): unknown[] {
  const snapshot = JSON.parse(
    storage.values.get(POMODORO_STORAGE_KEY) ?? '{}',
  ) as { pendingFocusFinalizations?: unknown[] }
  return snapshot.pendingFocusFinalizations ?? []
}

let databaseSequence = 0
function realRepository() {
  databaseSequence += 1
  return createFocusSessionRepository({
    indexedDB: new IDBFactory(),
    databaseName: `pomodoro-recorder-spec-${databaseSequence}`,
  })
}

function createFailNextWriteFactory(): {
  factory: IDBFactory
  failNextWriteWith(error: Error): void
} {
  const actual = new IDBFactory()
  let nextError: Error | undefined
  const factory = {
    open(name: string, version?: number) {
      const request = actual.open(name, version)
      if (!nextError) return request
      const writeError = nextError
      nextError = undefined
      const wrapped: Record<string, unknown> = { error: null }
      request.onerror = () => {
        wrapped.error = request.error
        ;(wrapped.onerror as (() => void) | undefined)?.()
      }
      request.onblocked = () => (wrapped.onblocked as (() => void) | undefined)?.()
      request.onsuccess = () => {
        const database = new Proxy(request.result, {
          get(target, property) {
            if (property === 'transaction') {
              return (
                storeNames: string | string[],
                mode?: IDBTransactionMode,
                options?: IDBTransactionOptions,
              ) => {
                if (mode === 'readwrite') throw writeError
                return target.transaction(storeNames, mode, options)
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        wrapped.result = database
        ;(wrapped.onsuccess as (() => void) | undefined)?.()
      }
      return wrapped as unknown as IDBOpenDBRequest
    },
  } as IDBFactory
  return {
    factory,
    failNextWriteWith(error) {
      nextError = error
    },
  }
}

describe('pomodoro focus recorder', () => {
  it('validates and writes a canonical Focus outbox row synchronously before asynchronous recording', async () => {
    const storage = memoryStorage()
    const repository = realRepository()
    const onSummary = vi.fn()
    const recorder = createPomodoroFocusRecorder({
      repository,
      storage,
      now: () => 61_000,
      onSummary,
    })

    expect(recorder.onFinalized(focusEvent())).toBe(true)
    expect(readOutbox(storage)).toEqual([{
      presentSummary: true,
      record: focusRecord(),
    }])

    await vi.waitFor(async () => {
      expect(await repository.list()).toEqual([focusRecord()])
      expect(readOutbox(storage)).toEqual([])
      expect(onSummary).toHaveBeenCalledWith(focusRecord())
    })
  })

  it('persists the timer snapshot, then the Focus outbox, then the timer acknowledgement', () => {
    let now = 0
    const storage = memoryStorage()
    const recorder = createPomodoroFocusRecorder({
      repository: realRepository(),
      storage,
      now: () => now,
    })
    const store = createPomodoroStore({
      autoTick: false,
      breakMinutes: 1,
      clock: { now: () => now },
      focusMinutes: 1,
      onFocusSessionFinalized: recorder.onFinalized,
      storage,
    })
    store.start()
    storage.writes.length = 0

    now = 60_000
    store.tick()

    expect(storage.writes.slice(0, 3).map(({ key }) => key)).toEqual([
      POMODORO_STORAGE_KEY,
      FOCUS_POMODORO_OUTBOX_STORAGE_KEY,
      POMODORO_STORAGE_KEY,
    ])
    expect((JSON.parse(storage.writes[0].value) as {
      pendingFocusFinalizations: unknown[]
    }).pendingFocusFinalizations).toHaveLength(1)
    expect(JSON.parse(storage.writes[1].value)).toHaveLength(1)
    expect((JSON.parse(storage.writes[2].value) as {
      pendingFocusFinalizations: unknown[]
    }).pendingFocusFinalizations).toEqual([])
  })

  it('replays a crash-persisted timer handoff through the outbox with no loss or duplicate', async () => {
    let now = 0
    const storage = memoryStorage()
    const repository = realRepository()
    const first = createPomodoroStore({
      autoTick: false,
      breakMinutes: 1,
      clock: { now: () => now },
      focusMinutes: 1,
      onFocusSessionFinalized: () => false,
      storage,
    })
    first.start()
    now = 60_000
    first.tick()
    first.destroy()
    expect(readPendingFinalizations(storage)).toHaveLength(1)

    const recorder = createPomodoroFocusRecorder({
      repository,
      storage,
      now: () => now,
    })
    const recovered = createPomodoroStore({
      autoTick: false,
      clock: { now: () => now },
      onFocusSessionFinalized: recorder.onFinalized,
      storage,
    })

    expect(readPendingFinalizations(storage)).toEqual([])
    expect(readOutbox(storage)).toHaveLength(1)
    recorder.replay()
    recovered.tick()

    await vi.waitFor(async () => {
      expect(await repository.list()).toHaveLength(1)
      expect(readOutbox(storage)).toEqual([])
    })

    const secondRecorder = createPomodoroFocusRecorder({ repository, storage, now: () => now })
    secondRecorder.replay()
    await vi.waitFor(async () => {
      expect(await repository.list()).toHaveLength(1)
    })
  })

  it('reuses endedAt as createdAt when a failed timer acknowledgement replays after the outbox drained', async () => {
    let now = 0
    const storage = memoryStorage()
    const repository = realRepository()
    const firstRecorder = createPomodoroFocusRecorder({
      repository,
      storage,
      now: () => 61_000,
    })
    const firstStore = createPomodoroStore({
      autoTick: false,
      breakMinutes: 1,
      clock: { now: () => now },
      focusMinutes: 1,
      onFocusSessionFinalized: firstRecorder.onFinalized,
      storage,
    })
    firstStore.start()
    const firstRunId = (JSON.parse(
      storage.values.get(POMODORO_STORAGE_KEY) ?? '{}',
    ) as { focusRun: { id: string } }).focusRun.id

    const setItem = storage.setItem
    let denyTimerAcknowledgement = true
    storage.setItem = (key, value) => {
      const pending = key === POMODORO_STORAGE_KEY
        ? (JSON.parse(value) as { pendingFocusFinalizations?: unknown[] }).pendingFocusFinalizations
        : undefined
      if (denyTimerAcknowledgement && key === POMODORO_STORAGE_KEY && pending?.length === 0) {
        denyTimerAcknowledgement = false
        throw new DOMException('Simulated crash boundary', 'SecurityError')
      }
      setItem(key, value)
    }

    now = 60_000
    firstStore.tick()
    await vi.waitFor(async () => {
      expect(await repository.list()).toEqual([focusRecord({
        id: firstRunId,
        createdAt: '1970-01-01T00:01:00.000Z',
      })])
      expect(readOutbox(storage)).toEqual([])
    })
    expect(readPendingFinalizations(storage)).toHaveLength(1)
    firstStore.destroy()
    firstRecorder.destroy()

    const replayErrors = vi.fn()
    const secondRecorder = createPomodoroFocusRecorder({
      repository,
      storage,
      now: () => 120_000,
      onError: replayErrors,
    })
    createPomodoroStore({
      autoTick: false,
      clock: { now: () => now },
      onFocusSessionFinalized: secondRecorder.onFinalized,
      storage,
    })

    await vi.waitFor(async () => {
      expect(await repository.list()).toHaveLength(1)
      expect(readOutbox(storage)).toEqual([])
      expect(readPendingFinalizations(storage)).toEqual([])
    })
    expect(replayErrors).not.toHaveBeenCalledWith(expect.any(FocusSessionConflictError))
  })

  it('removes an already-present equivalent replay without inserting a duplicate', async () => {
    const storage = memoryStorage()
    const repository = realRepository()
    await repository.recordIfAbsent(focusRecord())
    storage.setItem(FOCUS_POMODORO_OUTBOX_STORAGE_KEY, JSON.stringify([{
      presentSummary: false,
      record: focusRecord(),
    }]))

    const recorder = createPomodoroFocusRecorder({ repository, storage })
    recorder.replay()

    await vi.waitFor(async () => {
      expect(await repository.list()).toEqual([focusRecord()])
      expect(readOutbox(storage)).toEqual([])
    })
  })

  it('keeps a divergent immutable conflict queued and surfaces the typed error', async () => {
    let now = 0
    const storage = memoryStorage()
    const repository = realRepository()
    const onError = vi.fn()
    const onSummary = vi.fn()
    const recorder = createPomodoroFocusRecorder({
      repository,
      storage,
      now: () => now,
      onError,
      onSummary,
    })
    const store = createPomodoroStore({
      autoTick: false,
      breakMinutes: 1,
      clock: { now: () => now },
      focusMinutes: 1,
      onFocusSessionFinalized: recorder.onFinalized,
      storage,
    })
    store.start()
    const startedSnapshot = JSON.parse(
      storage.values.get(POMODORO_STORAGE_KEY) ?? '{}',
    ) as { focusRun: { id: string } }
    await repository.recordIfAbsent(focusRecord({
      id: startedSnapshot.focusRun.id,
      endedAt: '1970-01-01T00:02:00.000Z',
      plannedFocusSeconds: 120,
      actualFocusSeconds: 120,
    }))

    now = 60_000
    store.tick()

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(expect.any(FocusSessionConflictError))
    })
    expect(store.phase.value).toBe('break')
    expect(store.status.value).toBe('running')
    expect(readPendingFinalizations(storage)).toEqual([])
    expect(readOutbox(storage)).toHaveLength(1)
    expect(onSummary).not.toHaveBeenCalled()
    expect(await repository.list()).toHaveLength(1)
  })

  it('rejects malformed lifecycle input synchronously without acknowledging or writing it', () => {
    const storage = memoryStorage()
    const onError = vi.fn()
    const recorder = createPomodoroFocusRecorder({
      repository: realRepository(),
      storage,
      onError,
    })
    const malformed = focusEvent({
      run: { ...focusEvent().run, id: 'not-a-uuid' },
    })

    expect(recorder.onFinalized(malformed)).toBe(false)
    expect(readOutbox(storage)).toEqual([])
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: 'FocusValidationError' }))
  })

  it('falls back to a bounded page-memory outbox when localStorage is denied without blocking the timer', async () => {
    let now = 0
    const deniedStorage = {
      getItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      setItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      removeItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
    }
    const repository = realRepository()
    const onError = vi.fn()
    const recorder = createPomodoroFocusRecorder({
      repository,
      storage: deniedStorage,
      now: () => now,
      onError,
    })
    const store = createPomodoroStore({
      autoTick: false,
      breakMinutes: 1,
      clock: { now: () => now },
      focusMinutes: 1,
      onFocusSessionFinalized: recorder.onFinalized,
      storage: deniedStorage,
    })

    store.start()
    now = 60_000
    expect(() => store.tick()).not.toThrow()

    await vi.waitFor(async () => {
      expect(await repository.list()).toHaveLength(1)
    })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: 'SecurityError' }))
  })

  it('keeps a denied-storage outbox across destroy and recreates handlers before retrying a repository failure', async () => {
    const storage = {
      getItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      setItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
      removeItem: vi.fn(() => { throw new DOMException('Blocked', 'SecurityError') }),
    }
    const switchable = createFailNextWriteFactory()
    databaseSequence += 1
    const repository = createFocusSessionRepository({
      indexedDB: switchable.factory,
      databaseName: `pomodoro-recorder-spec-${databaseSequence}`,
    })
    await repository.list()
    switchable.failNextWriteWith(new Error('transient repository failure'))
    const firstErrors = vi.fn()
    const firstSummary = vi.fn()
    const first = createPomodoroFocusRecorder({
      repository,
      storage,
      onError: firstErrors,
      onSummary: firstSummary,
    })

    expect(first.onFinalized(focusEvent())).toBe(true)
    await vi.waitFor(() => {
      expect(firstErrors).toHaveBeenCalledWith(expect.objectContaining({
        name: 'FocusSessionStorageError',
      }))
    })
    expect(await repository.list()).toEqual([])
    first.destroy()

    const secondErrors = vi.fn()
    const secondSummary = vi.fn()
    createPomodoroFocusRecorder({
      repository,
      storage,
      onError: secondErrors,
      onSummary: secondSummary,
    })

    await vi.waitFor(async () => {
      expect(await repository.list()).toHaveLength(1)
      expect(secondSummary).toHaveBeenCalledTimes(1)
    })
    expect(firstSummary).not.toHaveBeenCalled()
  })

  it('never evicts an unacknowledged outbox row when the 1,024-record bound is full', () => {
    const storage = memoryStorage()
    const rows = Array.from({ length: MAX_FOCUS_OUTBOX_RECORDS }, (_, index) => ({
      presentSummary: false,
      record: focusRecord({
        id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      }),
    }))
    storage.setItem(FOCUS_POMODORO_OUTBOX_STORAGE_KEY, JSON.stringify(rows))
    const onError = vi.fn()
    const recorder = createPomodoroFocusRecorder({
      repository: realRepository(),
      storage,
      onError,
    })

    expect(recorder.onFinalized(focusEvent({
      run: { ...focusEvent().run, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    }))).toBe(false)
    expect(readOutbox(storage)).toHaveLength(1_024)
    expect(readOutbox(storage).map(({ record }) => record.id)).not.toContain(
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
    )
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      name: 'FocusOutboxCapacityError',
    }))
    recorder.destroy()
  })
})
