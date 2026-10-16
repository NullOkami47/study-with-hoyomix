import type { FocusHistoryExport, FocusSessionRecord } from './types'
import {
  FOCUS_SESSION_SCHEMA_VERSION,
  FocusValidationError,
  parseFocusSessionRecord,
} from './types'

export { FOCUS_SESSION_SCHEMA_VERSION, FocusValidationError } from './types'

export const FOCUS_SESSION_DATABASE_NAME = 'study-with-hoyomix-focus-history'
export const FOCUS_SESSION_MEMORY_LIMIT = 1_024

const STORE_SESSIONS = 'sessions'

export type FocusSessionStorageMode = 'persistent' | 'memory'
export type FocusSessionStorageErrorCode =
  | 'open_failed'
  | 'transaction_failed'
  | 'upgrade_blocked'
  | 'memory_limit'

export class FocusSessionConflictError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`Focus session ${id} conflicts with the immutable stored record`)
    this.name = 'FocusSessionConflictError'
    this.id = id
  }
}

export class FocusSessionStorageError extends Error {
  readonly code: FocusSessionStorageErrorCode

  constructor(
    code: FocusSessionStorageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message)
    this.name = 'FocusSessionStorageError'
    this.code = code
    if (options && 'cause' in options) (this as Error & { cause?: unknown }).cause = options.cause
  }
}

export interface FocusSessionRepositoryOptions {
  indexedDB?: IDBFactory
  databaseName?: string
}

export interface FocusSessionRepository {
  recordIfAbsent(record: FocusSessionRecord): Promise<'inserted' | 'already-present'>
  list(): Promise<FocusSessionRecord[]>
  exportFocusHistory(): Promise<FocusHistoryExport>
  clear(): Promise<void>
  subscribe(listener: (sessions: FocusSessionRecord[]) => void): () => void
  storageMode(): FocusSessionStorageMode
}

interface RepositoryCoordinatorMember {
  assign(sessions: FocusSessionRecord[]): boolean
  notify(): void
}

interface RepositoryCoordinator {
  members: Set<RepositoryCoordinatorMember>
  operation: Promise<void>
}

const repositoryCoordinators = new WeakMap<object, Map<string, RepositoryCoordinator>>()

function coordinatorFor(
  indexedDB: IDBFactory | undefined,
  databaseName: string,
): RepositoryCoordinator | undefined {
  if (!indexedDB) return undefined
  let databases = repositoryCoordinators.get(indexedDB)
  if (!databases) {
    databases = new Map()
    repositoryCoordinators.set(indexedDB, databases)
  }
  let coordinator = databases.get(databaseName)
  if (!coordinator) {
    coordinator = { members: new Set(), operation: Promise.resolve() }
    databases.set(databaseName, coordinator)
  }
  return coordinator
}

function runExclusive<T>(coordinator: RepositoryCoordinator, action: () => Promise<T>): Promise<T> {
  const result = coordinator.operation.then(action, action)
  coordinator.operation = result.then(() => undefined, () => undefined)
  return result
}

function isIndexedDbUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; name?: unknown }
  return (
    candidate.name === 'SecurityError' ||
    candidate.name === 'QuotaExceededError' ||
    candidate.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    candidate.code === 18 ||
    candidate.code === 22 ||
    candidate.code === 1014
  )
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(
      transaction.error ?? new Error('IndexedDB transaction failed'),
    )
    transaction.onabort = () => reject(
      transaction.error ?? new Error('IndexedDB transaction aborted'),
    )
  })
}

function openDatabase(
  indexedDB: IDBFactory | undefined,
  databaseName: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new DOMException('IndexedDB is unavailable', 'SecurityError'))
      return
    }
    let settled = false
    try {
      const request = indexedDB.open(databaseName, FOCUS_SESSION_SCHEMA_VERSION)
      request.onupgradeneeded = () => {
        try {
          if (!request.result.objectStoreNames.contains(STORE_SESSIONS)) {
            request.result.createObjectStore(STORE_SESSIONS, { keyPath: 'id' })
          }
        } catch (error) {
          settled = true
          try { request.transaction?.abort() } catch { /* Preserve the upgrade failure. */ }
          reject(new FocusSessionStorageError(
            'transaction_failed',
            'Focus history schema upgrade failed',
            { cause: error },
          ))
        }
      }
      request.onsuccess = () => {
        if (settled) {
          request.result.close()
          return
        }
        settled = true
        resolve(request.result)
      }
      request.onerror = () => {
        if (settled) return
        settled = true
        const error = request.error ?? new Error('IndexedDB open failed')
        reject(isIndexedDbUnavailable(error)
          ? error
          : new FocusSessionStorageError(
            'open_failed',
            'Focus history database open failed',
            { cause: error },
          ))
      }
      request.onblocked = () => {
        if (settled) return
        settled = true
        reject(new FocusSessionStorageError(
          'upgrade_blocked',
          'Focus history database upgrade was blocked',
        ))
      }
    } catch (error) {
      reject(isIndexedDbUnavailable(error)
        ? error
        : new FocusSessionStorageError(
          'open_failed',
          'Focus history database open failed',
          { cause: error },
        ))
    }
  })
}

function sortSessions(sessions: FocusSessionRecord[]): FocusSessionRecord[] {
  return sessions.sort(
    (left, right) => right.endedAt.localeCompare(left.endedAt) || left.id.localeCompare(right.id),
  )
}

function parseSessions(rows: unknown[], path = 'persistedSessions'): FocusSessionRecord[] {
  return sortSessions(rows.map((row, index) => parseFocusSessionRecord(row, `${path}[${index}]`)))
}

function cloneSessions(sessions: FocusSessionRecord[]): FocusSessionRecord[] {
  return sessions.map((session, index) => parseFocusSessionRecord(session, `sessions[${index}]`))
}

function recordsEqual(left: FocusSessionRecord, right: FocusSessionRecord): boolean {
  return (
    left.id === right.id &&
    left.schemaVersion === right.schemaVersion &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.plannedFocusSeconds === right.plannedFocusSeconds &&
    left.actualFocusSeconds === right.actualFocusSeconds &&
    left.status === right.status &&
    left.phase === right.phase &&
    left.createdAt === right.createdAt
  )
}

function wrapTransactionError(error: unknown, message: string): never {
  if (
    isIndexedDbUnavailable(error) ||
    error instanceof FocusSessionStorageError ||
    error instanceof FocusValidationError ||
    error instanceof FocusSessionConflictError
  ) throw error
  throw new FocusSessionStorageError('transaction_failed', message, { cause: error })
}

async function readSessions(database: IDBDatabase): Promise<FocusSessionRecord[]> {
  try {
    const transaction = database.transaction(STORE_SESSIONS, 'readonly')
    const completion = transactionComplete(transaction)
    const rows = await requestResult(transaction.objectStore(STORE_SESSIONS).getAll())
    await completion
    return parseSessions(rows)
  } catch (error) {
    return wrapTransactionError(error, 'Focus history read transaction failed')
  }
}

async function recordPersistently(
  database: IDBDatabase,
  record: FocusSessionRecord,
): Promise<
  | { result: 'already-present' }
  | { result: 'inserted'; sessions: FocusSessionRecord[] }
> {
  try {
    const transaction = database.transaction(STORE_SESSIONS, 'readwrite')
    const completion = transactionComplete(transaction)
    const store = transaction.objectStore(STORE_SESSIONS)
    const storedRows = await requestResult(store.getAll())
    let sessions: FocusSessionRecord[]
    try {
      sessions = parseSessions(storedRows)
    } catch (error) {
      try { transaction.abort() } catch { /* A completed read has nothing left to abort. */ }
      await completion.catch(() => undefined)
      throw error
    }
    const existing = sessions.find(({ id }) => id === record.id)
    if (existing) {
      await completion
      if (!recordsEqual(existing, record)) throw new FocusSessionConflictError(record.id)
      return { result: 'already-present' }
    }

    const nextSessions = sortSessions([...sessions, record])
    await Promise.all([requestResult(store.add(record)), completion])
    return { result: 'inserted', sessions: nextSessions }
  } catch (error) {
    return wrapTransactionError(error, 'Focus history write transaction failed')
  }
}

async function clearPersistently(database: IDBDatabase): Promise<void> {
  try {
    const transaction = database.transaction(STORE_SESSIONS, 'readwrite')
    const completion = transactionComplete(transaction)
    await requestResult(transaction.objectStore(STORE_SESSIONS).clear())
    await completion
  } catch (error) {
    wrapTransactionError(error, 'Focus history clear transaction failed')
  }
}

export function createFocusSessionRepository(
  options: FocusSessionRepositoryOptions = {},
): FocusSessionRepository {
  const indexedDB = options.indexedDB ?? globalThis.indexedDB
  const databaseName = options.databaseName ?? FOCUS_SESSION_DATABASE_NAME
  let snapshot: FocusSessionRecord[] = []
  let loaded = false
  let memoryOnly = !indexedDB
  let operation = Promise.resolve()
  const listeners = new Set<(sessions: FocusSessionRecord[]) => void>()
  const coordinator = coordinatorFor(indexedDB, databaseName)

  function notifyListeners(): void {
    for (const listener of listeners) {
      try { listener(cloneSessions(snapshot)) } catch { /* Listener errors cannot affect storage. */ }
    }
  }

  const coordinatorMember: RepositoryCoordinatorMember = {
    assign(sessions) {
      if (memoryOnly) return false
      snapshot = cloneSessions(sessions)
      loaded = true
      return true
    },
    notify: notifyListeners,
  }
  coordinator?.members.add(coordinatorMember)

  function switchToMemory(): void {
    if (memoryOnly) return
    memoryOnly = true
    loaded = true
    coordinator?.members.delete(coordinatorMember)
  }

  function publishPersistent(sessions: FocusSessionRecord[]): void {
    snapshot = cloneSessions(sessions)
    loaded = true
    if (!coordinator) {
      notifyListeners()
      return
    }
    const assignedPeers: RepositoryCoordinatorMember[] = []
    for (const member of coordinator.members) {
      if (member !== coordinatorMember && member.assign(sessions)) assignedPeers.push(member)
    }
    notifyListeners()
    for (const member of assignedPeers) member.notify()
  }

  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = operation.then(action, action)
    operation = result.then(() => undefined, () => undefined)
    return result
  }

  async function loadPersistent(): Promise<void> {
    let database: IDBDatabase | undefined
    try {
      database = await openDatabase(indexedDB, databaseName)
      snapshot = await readSessions(database)
      loaded = true
    } finally {
      database?.close()
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return
    if (memoryOnly) {
      loaded = true
      return
    }
    try {
      if (coordinator) await runExclusive(coordinator, loadPersistent)
      else await loadPersistent()
    } catch (error) {
      if (!isIndexedDbUnavailable(error)) throw error
      switchToMemory()
    }
  }

  function recordInMemory(record: FocusSessionRecord): 'inserted' | 'already-present' {
    const existing = snapshot.find(({ id }) => id === record.id)
    if (existing) {
      if (!recordsEqual(existing, record)) throw new FocusSessionConflictError(record.id)
      return 'already-present'
    }
    if (snapshot.length >= FOCUS_SESSION_MEMORY_LIMIT) {
      throw new FocusSessionStorageError(
        'memory_limit',
        `Page-memory focus history is limited to ${FOCUS_SESSION_MEMORY_LIMIT} records`,
      )
    }
    snapshot = sortSessions([...cloneSessions(snapshot), record])
    loaded = true
    notifyListeners()
    return 'inserted'
  }

  async function refreshPersistent(): Promise<void> {
    let database: IDBDatabase | undefined
    try {
      database = await openDatabase(indexedDB, databaseName)
      snapshot = await readSessions(database)
      loaded = true
    } finally {
      database?.close()
    }
  }

  const repository: FocusSessionRepository = {
    async recordIfAbsent(value) {
      const record = parseFocusSessionRecord(value, 'record')
      return enqueue(async () => {
        await ensureLoaded()
        if (memoryOnly) return recordInMemory(record)
        if (!coordinator) return recordInMemory(record)

        try {
          return await runExclusive(coordinator, async () => {
            let database: IDBDatabase | undefined
            try {
              database = await openDatabase(indexedDB, databaseName)
              const outcome = await recordPersistently(database, record)
              if (outcome.result === 'inserted') publishPersistent(outcome.sessions)
              return outcome.result
            } finally {
              database?.close()
            }
          })
        } catch (error) {
          if (!isIndexedDbUnavailable(error)) throw error
          switchToMemory()
          return recordInMemory(record)
        }
      })
    },
    list() {
      return enqueue(async () => {
        await ensureLoaded()
        if (!memoryOnly && coordinator) {
          try {
            await runExclusive(coordinator, refreshPersistent)
          } catch (error) {
            if (!isIndexedDbUnavailable(error)) throw error
            switchToMemory()
          }
        }
        return cloneSessions(snapshot)
      })
    },
    async exportFocusHistory() {
      return {
        schemaVersion: FOCUS_SESSION_SCHEMA_VERSION,
        sessions: await repository.list(),
      }
    },
    clear() {
      return enqueue(async () => {
        await ensureLoaded()
        if (memoryOnly || !coordinator) {
          snapshot = []
          loaded = true
          notifyListeners()
          return
        }

        try {
          await runExclusive(coordinator, async () => {
            let database: IDBDatabase | undefined
            try {
              database = await openDatabase(indexedDB, databaseName)
              await clearPersistently(database)
              publishPersistent([])
            } finally {
              database?.close()
            }
          })
        } catch (error) {
          if (!isIndexedDbUnavailable(error)) throw error
          switchToMemory()
          snapshot = []
          notifyListeners()
        }
      })
    },
    subscribe(listener) {
      listeners.add(listener)
      if (loaded) {
        try { listener(cloneSessions(snapshot)) } catch { /* Immediate delivery is isolated too. */ }
      }
      return () => listeners.delete(listener)
    },
    storageMode() {
      return memoryOnly ? 'memory' : 'persistent'
    },
  }

  return repository
}
