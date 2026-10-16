import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'

import {
  FOCUS_SESSION_DATABASE_NAME,
  FOCUS_SESSION_MEMORY_LIMIT,
  FocusSessionConflictError,
  FocusSessionStorageError,
  createFocusSessionRepository,
} from './localRepository'
import { FOCUS_SESSION_SCHEMA_VERSION, FocusValidationError } from './types'
import type { FocusSessionRecord } from './types'

const focusRecord = (overrides: Partial<FocusSessionRecord> = {}): FocusSessionRecord => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  schemaVersion: 1,
  startedAt: '2026-08-25T00:00:00.000Z',
  endedAt: '2026-08-25T00:05:00.000Z',
  plannedFocusSeconds: 300,
  actualFocusSeconds: 300,
  status: 'completed',
  phase: 'focus',
  createdAt: '2026-08-25T00:05:00.000Z',
  ...overrides,
})

function deniedIndexedDb(name = 'SecurityError'): IDBFactory {
  return {
    open() {
      throw new DOMException('Denied by browser policy', name)
    },
  } as unknown as IDBFactory
}

function createSwitchableFactory(): {
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

async function corruptPersistedRow(
  indexedDB: IDBFactory,
  databaseName: string,
  row: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(databaseName, FOCUS_SESSION_SCHEMA_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('sessions', 'readwrite')
      transaction.objectStore('sessions').put(row)
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}

async function readRawRows(indexedDB: IDBFactory, databaseName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, FOCUS_SESSION_SCHEMA_VERSION)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('sessions', 'readonly')
      const rowsRequest = transaction.objectStore('sessions').getAll()
      transaction.oncomplete = () => {
        database.close()
        resolve(rowsRequest.result)
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}

describe('focus session local repository', () => {
  it('uses a dedicated database, accepts exact duplicates and rejects divergent IDs', async () => {
    expect(FOCUS_SESSION_DATABASE_NAME).toBe('study-with-hoyomix-focus-history')
    const repository = createFocusSessionRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'focus-conflict',
    })
    const record = focusRecord()

    await expect(repository.recordIfAbsent(record)).resolves.toBe('inserted')
    await expect(repository.recordIfAbsent(structuredClone(record))).resolves.toBe('already-present')
    await expect(repository.recordIfAbsent({
      ...record,
      actualFocusSeconds: 299,
      status: 'interrupted',
    })).rejects.toMatchObject({
      name: 'FocusSessionConflictError',
      id: record.id,
    } satisfies Partial<FocusSessionConflictError>)
    await expect(repository.list()).resolves.toEqual([record])
  })

  it('treats equivalent normalised payloads as the same immutable record', async () => {
    const repository = createFocusSessionRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'focus-normalised-duplicate',
    })
    await repository.recordIfAbsent(focusRecord())

    await expect(repository.recordIfAbsent(focusRecord({
      id: '550E8400-E29B-41D4-A716-446655440000',
      startedAt: '2026-08-25T08:00:00+08:00',
      endedAt: '2026-08-25T08:05:00+08:00',
      createdAt: '2026-08-25T08:05:00+08:00',
    }))).resolves.toBe('already-present')
  })

  it('validates before persistence and never stores listening metadata', async () => {
    const repository = createFocusSessionRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'focus-input-validation',
    })

    await expect(repository.recordIfAbsent({
      ...focusRecord(),
      trackId: 'private-track',
    } as FocusSessionRecord)).rejects.toBeInstanceOf(FocusValidationError)
    await expect(repository.list()).resolves.toEqual([])
  })

  it('falls back to page memory only for classified IndexedDB denial', async () => {
    const repository = createFocusSessionRepository({ indexedDB: deniedIndexedDb() })

    await expect(repository.recordIfAbsent(focusRecord())).resolves.toBe('inserted')
    expect(repository.storageMode()).toBe('memory')
    await expect(repository.list()).resolves.toEqual([focusRecord()])
  })

  it('bounds page-memory history without evicting immutable records', async () => {
    const repository = createFocusSessionRepository({ indexedDB: deniedIndexedDb() })
    for (let index = 0; index < FOCUS_SESSION_MEMORY_LIMIT; index += 1) {
      await repository.recordIfAbsent(focusRecord({
        id: `550e8400-e29b-41d4-a716-${index.toString(16).padStart(12, '0')}`,
      }))
    }

    await expect(repository.recordIfAbsent(focusRecord({
      id: '550e8400-e29b-41d4-a716-ffffffffffff',
    }))).rejects.toMatchObject({
      name: 'FocusSessionStorageError',
      code: 'memory_limit',
    } satisfies Partial<FocusSessionStorageError>)
    expect(await repository.list()).toHaveLength(FOCUS_SESSION_MEMORY_LIMIT)
  }, 30_000)

  it('rejects unexpected open errors without claiming memory fallback', async () => {
    const brokenFactory = {
      open() {
        throw new TypeError('programming error')
      },
    } as unknown as IDBFactory
    const repository = createFocusSessionRepository({ indexedDB: brokenFactory })

    await expect(repository.list()).rejects.toMatchObject({
      name: 'FocusSessionStorageError',
      code: 'open_failed',
    } satisfies Partial<FocusSessionStorageError>)
    expect(repository.storageMode()).toBe('persistent')
  })

  it('keeps snapshots and listeners unchanged until a persistent commit succeeds', async () => {
    const { factory, failNextWriteWith } = createSwitchableFactory()
    const options = { indexedDB: factory, databaseName: 'focus-publication-order' }
    const repository = createFocusSessionRepository(options)
    const peer = createFocusSessionRepository(options)
    await Promise.all([repository.list(), peer.list()])
    const ownNotifications: FocusSessionRecord[][] = []
    const peerNotifications: FocusSessionRecord[][] = []
    repository.subscribe((sessions) => ownNotifications.push(sessions))
    peer.subscribe((sessions) => peerNotifications.push(sessions))

    failNextWriteWith(new TypeError('forced transaction failure'))
    await expect(repository.recordIfAbsent(focusRecord())).rejects.toMatchObject({
      name: 'FocusSessionStorageError',
      code: 'transaction_failed',
    } satisfies Partial<FocusSessionStorageError>)

    expect(await repository.list()).toEqual([])
    expect(await peer.list()).toEqual([])
    expect(ownNotifications).toEqual([[]])
    expect(peerNotifications).toEqual([[]])

    await expect(repository.recordIfAbsent(focusRecord())).resolves.toBe('inserted')
    expect(ownNotifications.at(-1)).toEqual([focusRecord()])
    expect(peerNotifications.at(-1)).toEqual([focusRecord()])
  })

  it.each(['SecurityError', 'QuotaExceededError'])(
    'retains the valid candidate in memory after a classified %s write denial',
    async (errorName) => {
      const { factory, failNextWriteWith } = createSwitchableFactory()
      const repository = createFocusSessionRepository({
        indexedDB: factory,
        databaseName: `focus-write-denial-${errorName}`,
      })
      await repository.list()
      failNextWriteWith(new DOMException('storage denied', errorName))

      await expect(repository.recordIfAbsent(focusRecord())).resolves.toBe('inserted')
      expect(repository.storageMode()).toBe('memory')
      expect(await repository.list()).toEqual([focusRecord()])
    },
  )

  it('serialises concurrent peer writes without lost records and publishes to both peers', async () => {
    const indexedDB = new IDBFactory()
    const options = { indexedDB, databaseName: 'focus-concurrent-peers' }
    const first = createFocusSessionRepository(options)
    const second = createFocusSessionRepository(options)
    await Promise.all([first.list(), second.list()])
    const firstObserved: string[][] = []
    const secondObserved: string[][] = []
    first.subscribe((sessions) => firstObserved.push(sessions.map(({ id }) => id)))
    second.subscribe((sessions) => secondObserved.push(sessions.map(({ id }) => id)))
    const earlier = focusRecord({
      id: '550e8400-e29b-41d4-a716-446655440001',
      startedAt: '2026-08-24T23:50:00.000Z',
      endedAt: '2026-08-24T23:55:00.000Z',
      createdAt: '2026-08-24T23:55:00.000Z',
    })

    await Promise.all([
      first.recordIfAbsent(focusRecord()),
      second.recordIfAbsent(earlier),
    ])

    const expectedIds = [focusRecord().id, earlier.id]
    expect((await first.list()).map(({ id }) => id)).toEqual(expectedIds)
    expect((await second.list()).map(({ id }) => id)).toEqual(expectedIds)
    expect(firstObserved.at(-1)).toEqual(expectedIds)
    expect(secondObserved.at(-1)).toEqual(expectedIds)
  })

  it('atomically rejects a concurrent divergent duplicate without overwriting the winner', async () => {
    const indexedDB = new IDBFactory()
    const options = { indexedDB, databaseName: 'focus-concurrent-conflict' }
    const first = createFocusSessionRepository(options)
    const second = createFocusSessionRepository(options)
    const winner = focusRecord()
    const divergent = focusRecord({ actualFocusSeconds: 17, status: 'interrupted' })

    const results = await Promise.allSettled([
      first.recordIfAbsent(winner),
      second.recordIfAbsent(divergent),
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find(({ status }) => status === 'rejected') as PromiseRejectedResult
    expect(rejection.reason).toBeInstanceOf(FocusSessionConflictError)
    expect(await first.list()).toEqual([winner])
  })

  it('returns deterministic detached lists and exports', async () => {
    const repository = createFocusSessionRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'focus-deterministic-export',
    })
    const sameEnd = focusRecord({
      id: '550e8400-e29b-41d4-a716-446655440002',
      startedAt: '2026-08-25T00:01:00.000Z',
    })
    await repository.recordIfAbsent(sameEnd)
    await repository.recordIfAbsent(focusRecord())

    const listed = await repository.list()
    expect(listed.map(({ id }) => id)).toEqual([focusRecord().id, sameEnd.id])
    const exported = await repository.exportFocusHistory()
    expect(exported).toEqual({ schemaVersion: 1, sessions: listed })

    listed[0]!.actualFocusSeconds = 1
    exported.sessions.length = 0
    expect(await repository.list()).toEqual([focusRecord(), sameEnd])
  })

  it('isolates listener exceptions, supports unsubscribe and clears only focus history', async () => {
    const repository = createFocusSessionRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'focus-listener-clear',
    })
    await repository.list()
    const observed: FocusSessionRecord[][] = []
    expect(() => repository.subscribe(() => { throw new Error('listener failed') })).not.toThrow()
    const unsubscribe = repository.subscribe((sessions) => observed.push(sessions))

    await repository.recordIfAbsent(focusRecord())
    expect(observed.at(-1)).toEqual([focusRecord()])
    unsubscribe()
    await repository.clear()

    expect(observed.at(-1)).toEqual([focusRecord()])
    await expect(repository.exportFocusHistory()).resolves.toEqual({
      schemaVersion: FOCUS_SESSION_SCHEMA_VERSION,
      sessions: [],
    })
  })

  it('rejects malformed persisted rows instead of returning partial history', async () => {
    const indexedDB = new IDBFactory()
    const databaseName = 'focus-corrupt-row'
    await createFocusSessionRepository({ indexedDB, databaseName }).list()
    await corruptPersistedRow(indexedDB, databaseName, {
      ...focusRecord(),
      provider: 'private-provider',
    })

    await expect(createFocusSessionRepository({ indexedDB, databaseName }).list())
      .rejects.toBeInstanceOf(FocusValidationError)
  })

  it('aborts an insert when an unrelated persisted row is malformed', async () => {
    const indexedDB = new IDBFactory()
    const databaseName = 'focus-corrupt-row-atomic-insert'
    const repository = createFocusSessionRepository({ indexedDB, databaseName })
    await repository.list()
    await corruptPersistedRow(indexedDB, databaseName, {
      ...focusRecord(),
      provider: 'private-provider',
    })
    const candidate = focusRecord({ id: '550e8400-e29b-41d4-a716-446655440001' })

    await expect(repository.recordIfAbsent(candidate)).rejects.toBeInstanceOf(FocusValidationError)
    const rawRows = await readRawRows(indexedDB, databaseName)
    expect(rawRows).toHaveLength(1)
    expect(rawRows).not.toContainEqual(expect.objectContaining({ id: candidate.id }))
  })
})
