import {
  isStorageDenied,
  safeLocalStorage,
  type SafeStorage,
} from '../../utils/safeStorage'
import type { PomodoroFocusSessionFinalized } from '../timers/pomodoro/store'
import {
  FocusSessionConflictError,
  type FocusSessionRepository,
} from './localRepository'
import {
  FocusValidationError,
  parseFocusSessionRecord,
  type FocusSessionRecord,
} from './types'

export const FOCUS_POMODORO_OUTBOX_STORAGE_KEY =
  'study-with-hoyomix.focus-pomodoro-outbox.v1'
export const MAX_FOCUS_OUTBOX_RECORDS = 1_024

export class FocusOutboxCapacityError extends Error {
  constructor() {
    super(`Focus outbox is limited to ${MAX_FOCUS_OUTBOX_RECORDS} unacknowledged records`)
    this.name = 'FocusOutboxCapacityError'
  }
}

export class FocusOutboxStorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'FocusOutboxStorageError'
    if (options && 'cause' in options) (this as Error & { cause?: unknown }).cause = options.cause
  }
}

interface FocusOutboxEntry {
  presentSummary: boolean
  record: FocusSessionRecord
}

interface PageOutboxState {
  entries: FocusOutboxEntry[]
}

const pageOutboxStates = new WeakMap<object, PageOutboxState>()

function pageOutboxStateFor(storage: SafeStorage): PageOutboxState {
  const existing = pageOutboxStates.get(storage)
  if (existing) return existing
  const created: PageOutboxState = { entries: [] }
  pageOutboxStates.set(storage, created)
  return created
}

export interface PomodoroFocusRecorderOptions {
  repository: FocusSessionRepository
  storage?: SafeStorage
  now?: () => number
  onSummary?: (record: FocusSessionRecord) => void
  onError?: (error: unknown) => void
}

export interface PomodoroFocusRecorder {
  destroy(): void
  onFinalized(event: PomodoroFocusSessionFinalized): boolean
  replay(): void
}

type OutboxMode = 'persistent' | 'memory' | 'blocked'

const EVENT_KEYS = new Set([
  'run',
  'endedAt',
  'actualFocusSeconds',
  'status',
  'presentSummary',
])
const RUN_KEYS = new Set(['id', 'startedAt', 'plannedFocusSeconds'])
const OUTBOX_ENTRY_KEYS = new Set(['record', 'presentSummary'])

function exactObject(value: unknown, keys: Set<string>, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FocusValidationError(path, 'must be an object')
  }
  const candidate = value as Record<string, unknown>
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string' || !keys.has(key)) {
      throw new FocusValidationError(path, `contains unknown field ${String(key)}`)
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
      throw new FocusValidationError(`${path}.${key}`, 'is required')
    }
  }
  return candidate
}

function safeInteger(value: unknown, path: string, positive = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    (positive && value <= 0)
  ) throw new FocusValidationError(path, positive ? 'must be a positive safe integer' : 'must be a safe integer')
  return value
}

function instant(milliseconds: number, path: string): string {
  try {
    return new Date(milliseconds).toISOString()
  } catch (error) {
    throw new FocusValidationError(path, `must be a valid epoch millisecond (${String(error)})`)
  }
}

function eventToEntry(
  value: PomodoroFocusSessionFinalized,
): FocusOutboxEntry {
  const event = exactObject(value, EVENT_KEYS, 'focusFinalization')
  const run = exactObject(event.run, RUN_KEYS, 'focusFinalization.run')
  const startedAt = safeInteger(run.startedAt, 'focusFinalization.run.startedAt')
  const endedAt = safeInteger(event.endedAt, 'focusFinalization.endedAt')
  const plannedFocusSeconds = safeInteger(
    run.plannedFocusSeconds,
    'focusFinalization.run.plannedFocusSeconds',
    true,
  )
  const actualFocusSeconds = safeInteger(
    event.actualFocusSeconds,
    'focusFinalization.actualFocusSeconds',
    true,
  )
  if (event.status !== 'completed' && event.status !== 'interrupted') {
    throw new FocusValidationError(
      'focusFinalization.status',
      'must be completed or interrupted',
    )
  }
  if (typeof event.presentSummary !== 'boolean') {
    throw new FocusValidationError('focusFinalization.presentSummary', 'must be a boolean')
  }

  return {
    presentSummary: event.presentSummary,
    record: parseFocusSessionRecord({
      id: run.id,
      schemaVersion: 1,
      startedAt: instant(startedAt, 'focusFinalization.run.startedAt'),
      endedAt: instant(endedAt, 'focusFinalization.endedAt'),
      plannedFocusSeconds,
      actualFocusSeconds,
      status: event.status,
      phase: 'focus',
      createdAt: instant(endedAt, 'focusFinalization.endedAt'),
    }, 'focusFinalization.record'),
  }
}

function parseOutboxEntry(value: unknown, index: number): FocusOutboxEntry {
  const path = `focusOutbox[${index}]`
  const candidate = exactObject(value, OUTBOX_ENTRY_KEYS, path)
  if (typeof candidate.presentSummary !== 'boolean') {
    throw new FocusValidationError(`${path}.presentSummary`, 'must be a boolean')
  }
  return {
    presentSummary: candidate.presentSummary,
    record: parseFocusSessionRecord(candidate.record, `${path}.record`),
  }
}

function parseOutbox(raw: string): FocusOutboxEntry[] {
  const value = JSON.parse(raw) as unknown
  if (!Array.isArray(value)) throw new FocusValidationError('focusOutbox', 'must be an array')
  if (value.length > MAX_FOCUS_OUTBOX_RECORDS) throw new FocusOutboxCapacityError()
  const entries = value.map(parseOutboxEntry)
  const ids = new Set<string>()
  for (const { record } of entries) {
    if (ids.has(record.id)) {
      throw new FocusValidationError('focusOutbox', `contains duplicate id ${record.id}`)
    }
    ids.add(record.id)
  }
  return entries
}

function recordsMatchWithoutCreatedAt(
  left: FocusSessionRecord,
  right: FocusSessionRecord,
): boolean {
  return (
    left.id === right.id &&
    left.schemaVersion === right.schemaVersion &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.plannedFocusSeconds === right.plannedFocusSeconds &&
    left.actualFocusSeconds === right.actualFocusSeconds &&
    left.status === right.status &&
    left.phase === right.phase
  )
}

function entriesEqual(left: FocusOutboxEntry, right: FocusOutboxEntry): boolean {
  return left.presentSummary === right.presentSummary &&
    recordsMatchWithoutCreatedAt(left.record, right.record) &&
    left.record.createdAt === right.record.createdAt
}

function mergeOutboxes(
  persisted: FocusOutboxEntry[],
  pageEntries: FocusOutboxEntry[],
): FocusOutboxEntry[] {
  const merged = [...persisted]
  for (const entry of pageEntries) {
    const existing = merged.find(({ record }) => record.id === entry.record.id)
    if (!existing) {
      if (merged.length >= MAX_FOCUS_OUTBOX_RECORDS) throw new FocusOutboxCapacityError()
      merged.push(entry)
      continue
    }
    if (!entriesEqual(existing, entry)) throw new FocusSessionConflictError(entry.record.id)
  }
  return merged
}

export function createPomodoroFocusRecorder(
  options: PomodoroFocusRecorderOptions,
): PomodoroFocusRecorder {
  const storage = options.storage ?? safeLocalStorage
  let mode: OutboxMode = 'persistent'
  let destroyed = false
  let replaying = false
  let replayRequested = false
  const pageState = pageOutboxStateFor(storage)
  let outbox = [...pageState.entries]
  let shouldPersistPageEntries = outbox.length > 0

  function report(error: unknown): void {
    if (destroyed) return
    try { options.onError?.(error) } catch { /* Error reporters cannot affect recording. */ }
  }

  try {
    const raw = storage.getItem(FOCUS_POMODORO_OUTBOX_STORAGE_KEY)
    if (raw) outbox = mergeOutboxes(parseOutbox(raw), outbox)
    pageState.entries = [...outbox]
  } catch (error) {
    report(error)
    if (isStorageDenied(error)) mode = 'memory'
    else mode = 'blocked'
  }

  function switchToMemory(error: unknown, next: FocusOutboxEntry[]): true {
    mode = 'memory'
    outbox = next
    pageState.entries = [...next]
    report(error)
    return true
  }

  function writeOutbox(next: FocusOutboxEntry[]): boolean {
    if (next.length > MAX_FOCUS_OUTBOX_RECORDS) {
      report(new FocusOutboxCapacityError())
      return false
    }
    if (mode === 'memory') {
      outbox = next
      pageState.entries = [...next]
      return true
    }
    if (mode === 'blocked') return false

    const serialized = JSON.stringify(next)
    try {
      storage.setItem(FOCUS_POMODORO_OUTBOX_STORAGE_KEY, serialized)
      if (storage.getItem(FOCUS_POMODORO_OUTBOX_STORAGE_KEY) !== serialized) {
        return switchToMemory(
          new FocusOutboxStorageError('Focus outbox write could not be verified'),
          next,
        )
      }
      outbox = next
      pageState.entries = [...next]
      return true
    } catch (error) {
      if (isStorageDenied(error)) return switchToMemory(error, next)
      report(new FocusOutboxStorageError('Focus outbox write failed', { cause: error }))
      return false
    }
  }

  async function drain(): Promise<void> {
    const recorded = new Map<string, FocusOutboxEntry>()
    for (const entry of [...outbox]) {
      if (destroyed) return
      try {
        const outcome = await options.repository.recordIfAbsent(entry.record)
        if (outcome !== 'inserted' && outcome !== 'already-present') {
          throw new Error(`Unexpected Focus repository outcome: ${String(outcome)}`)
        }
        recorded.set(entry.record.id, entry)
      } catch (error) {
        report(error)
      }
    }
    if (destroyed || recorded.size === 0) return

    const removed: FocusOutboxEntry[] = []
    const remaining = outbox.filter((entry) => {
      const persisted = recorded.get(entry.record.id)
      if (!persisted || !entriesEqual(entry, persisted)) return true
      removed.push(entry)
      return false
    })
    if (removed.length === 0 || !writeOutbox(remaining)) return
    for (const entry of removed) {
      if (!entry.presentSummary) continue
      try { options.onSummary?.(entry.record) } catch (error) { report(error) }
    }
  }

  function replay(): void {
    if (destroyed) return
    if (replaying) {
      replayRequested = true
      return
    }
    replaying = true
    void drain().finally(() => {
      replaying = false
      if (!replayRequested || destroyed) return
      replayRequested = false
      replay()
    })
  }

  function onFinalized(event: PomodoroFocusSessionFinalized): boolean {
    if (destroyed) return false
    try {
      const entry = eventToEntry(event)
      const existing = outbox.find(({ record }) => record.id === entry.record.id)
      if (existing) {
        if (
          existing.presentSummary !== entry.presentSummary ||
          !recordsMatchWithoutCreatedAt(existing.record, entry.record)
        ) {
          report(new FocusSessionConflictError(entry.record.id))
          return false
        }
        replay()
        return true
      }
      if (outbox.length >= MAX_FOCUS_OUTBOX_RECORDS) {
        report(new FocusOutboxCapacityError())
        replay()
        return false
      }
      if (!writeOutbox([...outbox, entry])) return false
      replay()
      return true
    } catch (error) {
      report(error)
      return false
    }
  }

  const recorder: PomodoroFocusRecorder = {
    destroy() {
      destroyed = true
    },
    onFinalized,
    replay,
  }

  if (mode === 'persistent' && shouldPersistPageEntries) {
    shouldPersistPageEntries = false
    writeOutbox(outbox)
  }
  replay()
  return recorder
}
