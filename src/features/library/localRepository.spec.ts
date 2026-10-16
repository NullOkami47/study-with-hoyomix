import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'

import {
  LibraryStorageError,
  LibraryValidationError,
  LOCAL_LIBRARY_SCHEMA_VERSION,
  createLocalLibraryRepository,
  exportLocalLibrary,
  getDefaultLocalLibraryRepository,
  mergeLocalLibrary,
  previewLibraryMerge,
} from './localRepository'
import type { LibraryExport } from './types'

function createEmptyRemote(): LibraryExport {
  return {
    schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
    favourites: [],
    playlists: [],
    preferences: { historyEnabled: false },
    recentHistory: [],
  }
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

function createWriteBarrierFactory(): {
  factory: IDBFactory
  pauseNextWrite(): { entered: Promise<void>; release(): void }
} {
  const actual = new IDBFactory()
  let barrier: {
    enter(): void
    release: Promise<void>
  } | undefined

  const factory = {
    open(name: string, version?: number) {
      const request = actual.open(name, version)
      if (!barrier) return request
      const activeBarrier = barrier
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
                if (mode !== 'readwrite' || barrier !== activeBarrier) {
                  return target.transaction(storeNames, mode, options)
                }
                barrier = undefined
                const operations: Array<
                  | { kind: 'clear'; storeName: string }
                  | { kind: 'put'; storeName: string; value: unknown }
                > = []
                const transaction: Record<string, unknown> = {
                  error: null,
                  objectStore(storeName: string) {
                    return {
                      clear() {
                        operations.push({ kind: 'clear', storeName })
                      },
                      put(value: unknown) {
                        operations.push({ kind: 'put', storeName, value: structuredClone(value) })
                      },
                    }
                  },
                }
                activeBarrier.enter()
                void activeBarrier.release.then(() => {
                  const persisted = target.transaction(storeNames, 'readwrite', options)
                  for (const operation of operations) {
                    const store = persisted.objectStore(operation.storeName)
                    if (operation.kind === 'clear') store.clear()
                    else store.put(operation.value)
                  }
                  persisted.oncomplete = () => (transaction.oncomplete as (() => void) | undefined)?.()
                  persisted.onerror = () => {
                    transaction.error = persisted.error
                    ;(transaction.onerror as (() => void) | undefined)?.()
                  }
                  persisted.onabort = () => {
                    transaction.error = persisted.error
                    ;(transaction.onabort as (() => void) | undefined)?.()
                  }
                })
                return transaction as unknown as IDBTransaction
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
    pauseNextWrite() {
      let enter: () => void = () => {}
      let release: () => void = () => {}
      const entered = new Promise<void>((resolve) => { enter = resolve })
      const released = new Promise<void>((resolve) => { release = resolve })
      barrier = { enter, release: released }
      return { entered, release }
    },
  }
}

function openLegacyDatabase(indexedDB: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('favourites', { keyPath: 'trackId' })
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('favourites', 'readwrite')
      transaction.objectStore('favourites').put({ trackId: 'track-legacy', addedAt: '2026-08-01T00:00:00.000Z' })
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
    }
  })
}

describe('local library repository', () => {
  it('[blocker 1] keeps every observable truth unchanged when a persistent write fails', async () => {
    const { factory, failNextWriteWith } = createSwitchableFactory()
    const databaseName = 'failed-write-publication-order'
    const options = {
      indexedDB: factory,
      databaseName,
      now: () => '2026-08-12T00:00:00.000Z',
    }
    const repository = createLocalLibraryRepository(options)
    const peer = createLocalLibraryRepository(options)
    const before = await repository.exportLocalLibrary()
    await peer.exportLocalLibrary()
    const repositoryNotifications: LibraryExport[] = []
    const peerNotifications: LibraryExport[] = []
    repository.subscribe((library) => repositoryNotifications.push(library))
    peer.subscribe((library) => peerNotifications.push(library))

    failNextWriteWith(new TypeError('forced non-fallback write failure'))
    await expect(repository.addFavourite('failed-candidate')).rejects.toMatchObject({
      name: 'LibraryStorageError',
      code: 'transaction_failed',
    } satisfies Partial<LibraryStorageError>)

    expect(await repository.exportLocalLibrary()).toEqual(before)
    expect(await peer.exportLocalLibrary()).toEqual(before)
    expect(repositoryNotifications).toEqual([before])
    expect(peerNotifications).toEqual([before])
    expect(await createLocalLibraryRepository(options).exportLocalLibrary()).toEqual(before)

    await repository.addFavourite('later-success')
    const recovered = await repository.exportLocalLibrary()
    expect(recovered.favourites.map(({ trackId }) => trackId)).toEqual(['later-success'])
    expect(await peer.exportLocalLibrary()).toEqual(recovered)
  })

  it.each(['SecurityError', 'QuotaExceededError'])(
    'accepts a candidate as session memory truth when a write fails with classified %s',
    async (errorName) => {
      const { factory, failNextWriteWith } = createSwitchableFactory()
      const repository = createLocalLibraryRepository({
        indexedDB: factory,
        databaseName: `classified-write-fallback-${errorName}`,
        now: () => '2026-08-12T00:01:00.000Z',
      })
      await repository.exportLocalLibrary()

      failNextWriteWith(new DOMException('storage denied', errorName))
      await expect(repository.addFavourite('memory-candidate')).resolves.toBeUndefined()

      expect(repository.storageMode()).toBe('memory')
      expect((await repository.exportLocalLibrary()).favourites.map(({ trackId }) => trackId)).toEqual([
        'memory-candidate',
      ])
    },
  )

  it('accepts a candidate as session memory truth when IndexedDB is missing', async () => {
    const repository = createLocalLibraryRepository({
      databaseName: 'missing-indexeddb-fallback',
      now: () => '2026-08-12T00:02:00.000Z',
    })

    await repository.addFavourite('memory-without-indexeddb')

    expect(repository.storageMode()).toBe('memory')
    expect((await repository.exportLocalLibrary()).favourites.map(({ trackId }) => trackId)).toEqual([
      'memory-without-indexeddb',
    ])
  })

  it('[blocker 2] serialises concurrent favourite mutations across repository peers', async () => {
    const indexedDB = new IDBFactory()
    const databaseName = 'concurrent-favourites'
    const first = createLocalLibraryRepository({
      indexedDB,
      databaseName,
      now: () => '2026-08-12T01:00:00.000Z',
    })
    const second = createLocalLibraryRepository({
      indexedDB,
      databaseName,
      now: () => '2026-08-12T01:01:00.000Z',
    })
    await Promise.all([first.exportLocalLibrary(), second.exportLocalLibrary()])
    const firstNotifications: string[][] = []
    const secondNotifications: string[][] = []
    first.subscribe((library) => firstNotifications.push(library.favourites.map(({ trackId }) => trackId)))
    second.subscribe((library) => secondNotifications.push(library.favourites.map(({ trackId }) => trackId)))

    await Promise.all([
      first.addFavourite('track-a'),
      second.addFavourite('track-b'),
    ])

    for (const library of [
      await first.exportLocalLibrary(),
      await second.exportLocalLibrary(),
      await createLocalLibraryRepository({ indexedDB, databaseName }).exportLocalLibrary(),
    ]) {
      expect(library.favourites.map(({ trackId }) => trackId)).toEqual(['track-a', 'track-b'])
    }
    expect(firstNotifications.at(-1)).toEqual(['track-a', 'track-b'])
    expect(secondNotifications.at(-1)).toEqual(['track-a', 'track-b'])
  })

  it('[blocker 2] serialises concurrent playlist mutations across repository peers', async () => {
    const indexedDB = new IDBFactory()
    const databaseName = 'concurrent-playlists'
    const first = createLocalLibraryRepository({ indexedDB, databaseName, now: () => '2026-08-12T01:02:00.000Z' })
    const second = createLocalLibraryRepository({ indexedDB, databaseName, now: () => '2026-08-12T01:03:00.000Z' })
    await Promise.all([first.exportLocalLibrary(), second.exportLocalLibrary()])
    const firstNotifications: string[][] = []
    const secondNotifications: string[][] = []
    first.subscribe((library) => firstNotifications.push(library.playlists.map(({ id }) => id)))
    second.subscribe((library) => secondNotifications.push(library.playlists.map(({ id }) => id)))

    await Promise.all([
      first.createPlaylist({ id: 'playlist-a', name: 'First' }),
      second.createPlaylist({ id: 'playlist-b', name: 'Second' }),
    ])

    for (const library of [
      await first.exportLocalLibrary(),
      await second.exportLocalLibrary(),
      await createLocalLibraryRepository({ indexedDB, databaseName }).exportLocalLibrary(),
    ]) {
      expect(library.playlists.map(({ id }) => id)).toEqual(['playlist-a', 'playlist-b'])
    }
    expect(firstNotifications.at(-1)).toEqual(['playlist-a', 'playlist-b'])
    expect(secondNotifications.at(-1)).toEqual(['playlist-a', 'playlist-b'])
  })

  it('atomically refuses a merge replacement when a peer changed the previewed snapshot', async () => {
    const indexedDB = new IDBFactory()
    const options = { indexedDB, databaseName: 'conditional-merge-replacement', now: () => '2026-08-12T01:03:30.000Z' }
    const mergeConsumer = createLocalLibraryRepository(options)
    const activePanel = createLocalLibraryRepository(options)
    const expected = await mergeConsumer.exportLocalLibrary()
    await activePanel.addFavourite('after-preview')

    const staleReplacement = { ...expected, favourites: [{ trackId: 'remote-only', addedAt: '2026-08-12T01:03:00.000Z' }] }
    await expect(mergeConsumer.replaceWithLibraryIfUnchanged(expected, staleReplacement)).resolves.toBe(false)
    expect((await mergeConsumer.exportLocalLibrary()).favourites.map(({ trackId }) => trackId)).toEqual(['after-preview'])

    const current = await mergeConsumer.exportLocalLibrary()
    const freshReplacement = {
      ...current,
      favourites: [...current.favourites, { trackId: 'remote-only', addedAt: '2026-08-12T01:03:00.000Z' }],
    }
    await expect(mergeConsumer.replaceWithLibraryIfUnchanged(current, freshReplacement)).resolves.toBe(true)
    expect((await activePanel.exportLocalLibrary()).favourites.map(({ trackId }) => trackId)).toEqual([
      'after-preview', 'remote-only',
    ])
  })

  it('[blocker 2] releases coordinator membership when a repository is destroyed', async () => {
    const indexedDB = new IDBFactory()
    const options = { indexedDB, databaseName: 'coordinator-lifecycle' }
    const first = createLocalLibraryRepository(options)
    const second = createLocalLibraryRepository(options)
    await Promise.all([first.exportLocalLibrary(), second.exportLocalLibrary()])
    const firstNotifications: LibraryExport[] = []
    first.subscribe((library) => firstNotifications.push(library))
    const beforeDestroy = firstNotifications.length

    first.destroy()
    await second.addFavourite('after-destroy')

    expect(firstNotifications).toHaveLength(beforeDestroy)
  })

  it('[fix round 1] keeps one coordinator while a destroyed repository finishes an already-started mutation', async () => {
    const { factory, pauseNextWrite } = createWriteBarrierFactory()
    const databaseName = 'coordinator-active-destroy'
    const first = createLocalLibraryRepository({
      indexedDB: factory,
      databaseName,
      now: () => '2026-08-12T01:04:00.000Z',
    })
    await first.exportLocalLibrary()
    const barrier = pauseNextWrite()

    const alreadyStarted = first.addFavourite('from-destroyed-repository')
    await barrier.entered
    first.destroy()
    const second = createLocalLibraryRepository({
      indexedDB: factory,
      databaseName,
      now: () => '2026-08-12T01:05:00.000Z',
    })
    await second.exportLocalLibrary()
    const secondPublications: string[][] = []
    second.subscribe((library) => {
      secondPublications.push(library.favourites.map(({ trackId }) => trackId))
    })
    const laterMutation = second.addFavourite('from-new-repository')
    barrier.release()

    await expect(alreadyStarted).resolves.toBeUndefined()
    expect(secondPublications).toContainEqual(['from-destroyed-repository'])
    await expect(laterMutation).resolves.toBeUndefined()
    const expected = ['from-destroyed-repository', 'from-new-repository']
    expect((await second.exportLocalLibrary()).favourites.map(({ trackId }) => trackId)).toEqual(expected)
    expect((await createLocalLibraryRepository({ indexedDB: factory, databaseName }).exportLocalLibrary())
      .favourites.map(({ trackId }) => trackId)).toEqual(expected)
  })

  it('[fix round 1] assigns every peer snapshot before any successful publication subscriber runs', async () => {
    const indexedDB = new IDBFactory()
    const options = { indexedDB, databaseName: 'atomic-peer-publication', now: () => '2026-08-12T01:06:00.000Z' }
    const source = createLocalLibraryRepository(options)
    const firstPeer = createLocalLibraryRepository(options)
    const laterPeer = createLocalLibraryRepository(options)
    await Promise.all([
      source.exportLocalLibrary(),
      firstPeer.exportLocalLibrary(),
      laterPeer.exportLocalLibrary(),
    ])
    let sourceObservedPeer: string[] | undefined
    let peerObservedLaterPeer: string[] | undefined
    source.subscribe((library) => {
      if (!library.favourites.some(({ trackId }) => trackId === 'atomic-track')) return
      sourceObservedPeer = firstPeer.mergeLocalLibrary(createEmptyRemote()).merged.favourites
        .map(({ trackId }) => trackId)
    })
    firstPeer.subscribe((library) => {
      if (!library.favourites.some(({ trackId }) => trackId === 'atomic-track')) return
      peerObservedLaterPeer = laterPeer.mergeLocalLibrary(createEmptyRemote()).merged.favourites
        .map(({ trackId }) => trackId)
    })

    await source.addFavourite('atomic-track')

    expect(sourceObservedPeer).toEqual(['atomic-track'])
    expect(peerObservedLaterPeer).toEqual(['atomic-track'])
  })

  describe('[blocker 3] history record IDs are independent from canonical track IDs', () => {
    it('accepts the minimum valid canonical track ID everywhere', async () => {
      const repository = createLocalLibraryRepository({
        indexedDB: new IDBFactory(),
        databaseName: 'history-minimum-track-id',
        now: () => '2026-08-12T02:00:00.000Z',
      })
      await repository.addFavourite('a')
      await repository.createPlaylist({ id: 'p', name: 'Minimum' })
      await repository.setPlaylistOrder('p', ['a'])
      await repository.setHistoryEnabled(true)

      await expect(repository.recordRecent('a')).resolves.toBe(true)
      expect((await repository.exportLocalLibrary()).recentHistory[0]?.trackId).toBe('a')
    })

    it('accepts an exactly 256-character track ID everywhere including history', async () => {
      const trackId = `a${'b'.repeat(255)}`
      const repository = createLocalLibraryRepository({
        indexedDB: new IDBFactory(),
        databaseName: 'history-maximum-track-id',
        now: () => '2026-08-12T02:01:00.000Z',
      })
      await repository.addFavourite(trackId)
      await repository.createPlaylist({ id: 'maximum', name: 'Maximum' })
      await repository.setPlaylistOrder('maximum', [trackId])
      await repository.setHistoryEnabled(true)

      await expect(repository.recordRecent(trackId)).resolves.toBe(true)
      const library = await repository.exportLocalLibrary()
      expect(library.favourites[0]?.trackId).toBe(trackId)
      expect(library.playlists[0]?.trackIds).toEqual([trackId])
      expect(library.recentHistory[0]?.trackId).toBe(trackId)
    })

    it('rejects a 257-character track ID everywhere including history', async () => {
      const trackId = `a${'b'.repeat(256)}`
      const repository = createLocalLibraryRepository({
        indexedDB: new IDBFactory(),
        databaseName: 'history-oversized-track-id',
      })
      await repository.createPlaylist({ id: 'oversized', name: 'Oversized' })
      await repository.setHistoryEnabled(true)

      await expect(repository.addFavourite(trackId)).rejects.toBeInstanceOf(LibraryValidationError)
      await expect(repository.setPlaylistOrder('oversized', [trackId])).rejects.toBeInstanceOf(LibraryValidationError)
      await expect(repository.recordRecent(trackId)).rejects.toBeInstanceOf(LibraryValidationError)
    })

    it('records repeated plays of the same track at the same timestamp without collision', async () => {
      const repository = createLocalLibraryRepository({
        indexedDB: new IDBFactory(),
        databaseName: 'history-same-time-same-track',
        now: () => '2026-08-12T02:02:00.000Z',
      })
      await repository.setHistoryEnabled(true)

      await expect(repository.recordRecent('same-track')).resolves.toBe(true)
      await expect(repository.recordRecent('same-track')).resolves.toBe(true)

      const history = (await repository.exportLocalLibrary()).recentHistory
      expect(history).toHaveLength(2)
      expect(new Set(history.map(({ id }) => id))).toHaveLength(2)
      expect(history.every(({ trackId, playedAt }) => (
        trackId === 'same-track' && playedAt === '2026-08-12T02:02:00.000Z'
      ))).toBe(true)
    })
  })

  it('rejects an unexpected IndexedDB open TypeError without claiming memory fallback', async () => {
    const brokenFactory = {
      open() {
        throw new TypeError('programming error')
      },
    } as unknown as IDBFactory
    const repository = createLocalLibraryRepository({ indexedDB: brokenFactory, databaseName: 'open-type-error' })

    await expect(repository.exportLocalLibrary()).rejects.toMatchObject({
      name: 'LibraryStorageError',
      code: 'open_failed',
    } satisfies Partial<LibraryStorageError>)
    expect(repository.storageMode()).toBe('persistent')
  })

  it('rejects an unexpected transaction TypeError without resolving a fake success', async () => {
    const database = {
      close() {},
      objectStoreNames: { contains: () => true },
      transaction() {
        throw new TypeError('transaction programming error')
      },
    }
    const factory = {
      open() {
        const request: Record<string, unknown> = { result: database, error: null }
        queueMicrotask(() => (request.onsuccess as (() => void) | undefined)?.())
        return request
      },
    } as unknown as IDBFactory
    const repository = createLocalLibraryRepository({ indexedDB: factory, databaseName: 'transaction-type-error' })

    await expect(repository.exportLocalLibrary()).rejects.toMatchObject({
      name: 'LibraryStorageError',
      code: 'transaction_failed',
    } satisfies Partial<LibraryStorageError>)
    expect(repository.storageMode()).toBe('persistent')
  })

  it('reports a blocked upgrade and closes a database that succeeds after rejection', async () => {
    let closed = false
    const database = { close: () => { closed = true } }
    const factory = {
      open() {
        const request: Record<string, unknown> = { result: database, error: null }
        queueMicrotask(() => {
          ;(request.onblocked as (() => void) | undefined)?.()
          ;(request.onsuccess as (() => void) | undefined)?.()
        })
        return request
      },
    } as unknown as IDBFactory
    const repository = createLocalLibraryRepository({ indexedDB: factory, databaseName: 'blocked-upgrade' })

    await expect(repository.exportLocalLibrary()).rejects.toMatchObject({
      name: 'LibraryStorageError',
      code: 'upgrade_blocked',
    } satisfies Partial<LibraryStorageError>)
    await Promise.resolve()
    expect(closed).toBe(true)
    expect(repository.storageMode()).toBe('persistent')
  })
  it('upgrades a legacy database without losing favourites', async () => {
    const indexedDB = new IDBFactory()
    const databaseName = 'library-schema-upgrade'
    await openLegacyDatabase(indexedDB, databaseName)

    const repository = createLocalLibraryRepository({ indexedDB, databaseName })
    const library = await repository.exportLocalLibrary()

    expect(LOCAL_LIBRARY_SCHEMA_VERSION).toBe(2)
    expect(library.favourites).toEqual([
      { trackId: 'track-legacy', addedAt: '2026-08-01T00:00:00.000Z' },
    ])
    expect(library.playlists).toEqual([])
    expect(library.preferences).toEqual({ historyEnabled: false })
    expect(library.recentHistory).toEqual([])
  })

  it('deduplicates favourites by canonical track ID', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-favourite-dedup',
      now: () => '2026-08-11T00:00:00.000Z',
    })

    await repository.addFavourite('track-a')
    await repository.addFavourite('track-a')

    expect((await repository.exportLocalLibrary()).favourites).toEqual([
      { trackId: 'track-a', addedAt: '2026-08-11T00:00:00.000Z' },
    ])
  })

  it('exports preferences while keeping recent history opt-in', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-export',
      now: () => '2026-08-11T01:00:00.000Z',
    })

    await repository.setPreference('volume', 0.4)
    expect(await repository.recordRecent('track-private')).toBe(false)
    await repository.setHistoryEnabled(true)
    expect(await repository.recordRecent('track-kept')).toBe(true)

    const exported = await repository.exportLocalLibrary()
    expect(exported.preferences).toEqual({ historyEnabled: true, volume: 0.4 })
    expect(exported.recentHistory).toHaveLength(1)
    expect(exported.recentHistory[0]).toMatchObject({
      trackId: 'track-kept',
      playedAt: '2026-08-11T01:00:00.000Z',
    })
    expect(exported.recentHistory[0]?.id).toMatch(/^history-[A-Za-z0-9-]+$/u)
  })

  it('clears optional recent history without removing the opt-in preference', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-clear-history',
      now: () => '2026-08-11T02:00:00.000Z',
    })
    await repository.setHistoryEnabled(true)
    await repository.recordRecent('track-a')

    await repository.clearHistory()

    const exported = await repository.exportLocalLibrary()
    expect(exported.preferences.historyEnabled).toBe(true)
    expect(exported.recentHistory).toEqual([])
  })

  it('preserves explicit playlist ordering and removes duplicate track IDs', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-playlist-order',
      now: () => '2026-08-11T03:00:00.000Z',
    })
    await repository.createPlaylist({ id: 'focus', name: 'Focus' })
    await repository.setPlaylistOrder('focus', ['track-b', 'track-a', 'track-b'])

    expect((await repository.exportLocalLibrary()).playlists).toEqual([
      {
        id: 'focus',
        name: 'Focus',
        trackIds: ['track-b', 'track-a'],
        createdAt: '2026-08-11T03:00:00.000Z',
        updatedAt: '2026-08-11T03:00:00.000Z',
      },
    ])
  })

  it('previews a deterministic merge without writing to the local repository', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-merge-preview',
      now: () => '2026-08-11T04:00:00.000Z',
    })
    await repository.addFavourite('track-local')
    await repository.createPlaylist({ id: 'same', name: 'Local list' })
    await repository.setPlaylistOrder('same', ['track-local'])
    const before = await repository.exportLocalLibrary()
    const remote: LibraryExport = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [
        { trackId: 'track-local', addedAt: '2026-08-10T00:00:00.000Z' },
        { trackId: 'track-remote', addedAt: '2026-08-10T01:00:00.000Z' },
      ],
      playlists: [
        {
          id: 'same',
          name: 'Remote list',
          trackIds: ['track-remote'],
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T01:00:00.000Z',
        },
        {
          id: 'remote-only',
          name: 'Remote only',
          trackIds: ['track-remote'],
          createdAt: '2026-08-10T02:00:00.000Z',
          updatedAt: '2026-08-10T02:00:00.000Z',
        },
      ],
      preferences: { historyEnabled: false },
      recentHistory: [],
    }

    const preview = repository.mergeLocalLibrary(remote)

    expect(preview.addedFavouriteTrackIds).toEqual(['track-remote'])
    expect(preview.addedPlaylistIds).toEqual(['remote-only'])
    expect(preview.playlistConflicts.map(({ id }) => id)).toEqual(['same'])
    expect(preview.merged.favourites.map(({ trackId }) => trackId)).toEqual([
      'track-local',
      'track-remote',
    ])
    expect(await repository.exportLocalLibrary()).toEqual(before)
  })

  it('exports the required top-level mergeLocalLibrary(remote) contract', async () => {
    const remote: LibraryExport = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [],
      playlists: [],
      preferences: { historyEnabled: false },
      recentHistory: [],
    }

    await exportLocalLibrary()
    expect(mergeLocalLibrary(remote).merged.schemaVersion).toBe(LOCAL_LIBRARY_SCHEMA_VERSION)
  })

  it('falls back to an in-memory anonymous library when IndexedDB is denied', async () => {
    const deniedFactory = {
      open() {
        throw new DOMException('Denied by browser policy', 'SecurityError')
      },
    } as unknown as IDBFactory
    const repository = createLocalLibraryRepository({
      indexedDB: deniedFactory,
      databaseName: 'library-denied',
      now: () => '2026-08-11T05:00:00.000Z',
    })

    await expect(repository.addFavourite('track-memory')).resolves.toBeUndefined()
    expect((await repository.exportLocalLibrary()).favourites.map(({ trackId }) => trackId)).toEqual([
      'track-memory',
    ])
  })

  it('retains only the latest 100 opted-in history records', async () => {
    let minute = 0
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-history-limit',
      now: () => new Date(Date.UTC(2026, 7, 11, 6) + minute++ * 60_000).toISOString(),
    })
    await repository.setHistoryEnabled(true)

    for (let index = 0; index < 101; index += 1) {
      await repository.recordRecent(`track-${index}`)
    }

    const history = (await repository.exportLocalLibrary()).recentHistory
    expect(history).toHaveLength(100)
    expect(history.some(({ trackId }) => trackId === 'track-0')).toBe(false)
    expect(history.some(({ trackId }) => trackId === 'track-100')).toBe(true)
  })

  it('rejects URL-shaped and whitespace-bearing values instead of persisting them as canonical IDs', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-invalid-ids',
    })

    await expect(repository.addFavourite('https://example.com/audio.mp3')).rejects.toBeInstanceOf(LibraryValidationError)
    await expect(repository.addFavourite('track with spaces')).rejects.toBeInstanceOf(LibraryValidationError)
    await expect(repository.addFavourite('javascript:alert(1)')).rejects.toBeInstanceOf(LibraryValidationError)
    await expect(repository.addFavourite('data:text/plain,track')).rejects.toBeInstanceOf(LibraryValidationError)
    await expect(repository.addFavourite('track\u0000id')).rejects.toBeInstanceOf(LibraryValidationError)
    await expect(repository.createPlaylist({ id: 'https://example.com/list', name: 'Remote' })).rejects.toBeInstanceOf(LibraryValidationError)

    const exported = await repository.exportLocalLibrary()
    expect(exported.favourites).toEqual([])
    expect(exported.playlists).toEqual([])
  })

  it('fails closed before hydration and includes legacy local data after hydration', async () => {
    const indexedDB = new IDBFactory()
    const databaseName = 'library-merge-hydration'
    await openLegacyDatabase(indexedDB, databaseName)
    const repository = createLocalLibraryRepository({ indexedDB, databaseName })
    const remote: LibraryExport = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [],
      playlists: [],
      preferences: { historyEnabled: false },
      recentHistory: [],
    }

    expect(() => repository.mergeLocalLibrary(remote)).toThrow(/load local library/i)
    await repository.exportLocalLibrary()

    expect(repository.mergeLocalLibrary(remote).merged.favourites.map(({ trackId }) => trackId)).toEqual([
      'track-legacy',
    ])
  })

  it('rejects malformed remote URLs instead of silently normalising a merge preview', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'library-merge-validation',
    })
    await repository.exportLocalLibrary()
    const remote: LibraryExport = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [
        { trackId: 'track-valid', addedAt: '2026-08-11T00:00:00.000Z' },
        { trackId: 'track-valid', addedAt: '2026-08-11T01:00:00.000Z' },
        { trackId: 'https://example.com/audio', addedAt: '2026-08-11T02:00:00.000Z' },
      ],
      playlists: [
        {
          id: 'playlist-valid',
          name: 'Remote',
          trackIds: ['track-valid', 'https://example.com/audio', 'track-valid'],
          createdAt: '2026-08-11T00:00:00.000Z',
          updatedAt: '2026-08-11T00:00:00.000Z',
        },
      ],
      preferences: { historyEnabled: false },
      recentHistory: [],
    }

    expect(() => repository.mergeLocalLibrary(remote)).toThrow(LibraryValidationError)
  })

  it.each([null, {}, { schemaVersion: 1 }])('rejects a non-v2 remote export: %j', async (remote) => {
    const repository = createLocalLibraryRepository({ indexedDB: new IDBFactory(), databaseName: `invalid-remote-${String(remote)}` })
    await repository.exportLocalLibrary()

    expect(() => repository.mergeLocalLibrary(remote)).toThrow(LibraryValidationError)
  })

  it('rejects invalid dates, unknown fields, oversized collections and playlist names', async () => {
    const repository = createLocalLibraryRepository({ indexedDB: new IDBFactory(), databaseName: 'invalid-bounds' })
    await repository.exportLocalLibrary()
    const base = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [],
      playlists: [],
      preferences: { historyEnabled: false },
      recentHistory: [],
    }

    expect(() => repository.mergeLocalLibrary({ ...base, favourites: [{ trackId: 'track', addedAt: 'not-a-date' }] })).toThrow(LibraryValidationError)
    expect(() => repository.mergeLocalLibrary({ ...base, unexpected: true })).toThrow(LibraryValidationError)
    expect(() => repository.mergeLocalLibrary({ ...base, favourites: Array.from({ length: 10_001 }, (_, index) => ({ trackId: `track-${index}`, addedAt: '2026-08-11T00:00:00.000Z' })) })).toThrow(LibraryValidationError)
    await expect(repository.createPlaylist({ id: 'playlist-long', name: 'a'.repeat(81) })).rejects.toBeInstanceOf(LibraryValidationError)
    await expect(repository.createPlaylist({ id: 'playlist-control', name: 'bad\u0000name' })).rejects.toBeInstanceOf(LibraryValidationError)
  })

  it('rejects sensitive or unknown preference keys from mutations and merge input', async () => {
    const repository = createLocalLibraryRepository({ indexedDB: new IDBFactory(), databaseName: 'invalid-preferences' })
    await repository.exportLocalLibrary()
    await expect(repository.setPreference('oauthToken', 'secret')).rejects.toBeInstanceOf(LibraryValidationError)
    await expect(repository.setPreference('providerTemporaryUrl', 'https://example.com/temp')).rejects.toBeInstanceOf(LibraryValidationError)

    expect(() => repository.mergeLocalLibrary({
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [],
      playlists: [],
      preferences: { historyEnabled: false, oauthToken: 'secret' },
      recentHistory: [],
    })).toThrow(LibraryValidationError)
  })

  it('rejects a corrupted persisted row rather than exporting partial data', async () => {
    const indexedDB = new IDBFactory()
    const databaseName = 'corrupted-persisted-row'
    await createLocalLibraryRepository({ indexedDB, databaseName }).exportLocalLibrary()
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, LOCAL_LIBRARY_SCHEMA_VERSION)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const database = request.result
        const transaction = database.transaction('favourites', 'readwrite')
        transaction.objectStore('favourites').put({ trackId: 'track-corrupted' })
        transaction.oncomplete = () => { database.close(); resolve() }
        transaction.onerror = () => reject(transaction.error)
      }
    })

    const repository = createLocalLibraryRepository({ indexedDB, databaseName })
    await expect(repository.exportLocalLibrary()).rejects.toBeInstanceOf(LibraryValidationError)
  })

  it('isolates subscriber exceptions from mutations, other listeners and immediate delivery', async () => {
    const repository = createLocalLibraryRepository({
      indexedDB: new IDBFactory(),
      databaseName: 'subscriber-isolation',
      now: () => '2026-08-11T09:00:00.000Z',
    })
    await repository.exportLocalLibrary()
    const received: string[][] = []

    expect(() => repository.subscribe(() => { throw new Error('listener failed') })).not.toThrow()
    repository.subscribe((library) => received.push(library.favourites.map(({ trackId }) => trackId)))

    await expect(repository.addFavourite('track-safe')).resolves.toBeUndefined()
    expect(received.at(-1)).toEqual(['track-safe'])
    expect((await repository.exportLocalLibrary()).favourites.map(({ trackId }) => trackId)).toEqual(['track-safe'])
  })

  it('invalidates another repository instance sharing the same IndexedDB database', async () => {
    const indexedDB = new IDBFactory()
    const options = { indexedDB, databaseName: 'cross-repository-sync', now: () => '2026-08-11T10:00:00.000Z' }
    const first = createLocalLibraryRepository(options)
    const second = createLocalLibraryRepository(options)
    await Promise.all([first.exportLocalLibrary(), second.exportLocalLibrary()])
    const observed: string[][] = []
    second.subscribe((library) => observed.push(library.favourites.map(({ trackId }) => trackId)))

    await first.addFavourite('track-shared')

    expect((await second.exportLocalLibrary()).favourites.map(({ trackId }) => trackId)).toEqual(['track-shared'])
    expect(observed.at(-1)).toEqual(['track-shared'])
  })

  it('uses one shared repository for top-level application contracts', () => {
    expect(getDefaultLocalLibraryRepository()).toBe(getDefaultLocalLibraryRepository())
  })

  it('reports deterministic local-precedence preference and history conflicts', () => {
    const local: LibraryExport = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [],
      playlists: [],
      preferences: { historyEnabled: true, locale: 'en' },
      recentHistory: [
        {
          id: 'history-conflict',
          trackId: 'track-local',
          playedAt: '2026-08-11T12:00:00.000Z',
        },
      ],
    }
    const remote: LibraryExport = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [],
      playlists: [],
      preferences: { historyEnabled: false, locale: 'zh-Hant', volume: 0.35 },
      recentHistory: [
        {
          id: 'history-conflict',
          trackId: 'track-remote',
          playedAt: '2026-08-10T12:00:00.000Z',
        },
      ],
    }

    const preview = previewLibraryMerge(local, remote)

    expect(preview.merged.preferences).toEqual({ historyEnabled: true, locale: 'en', volume: 0.35 })
    expect(preview.preferenceConflicts).toEqual([
      { key: 'historyEnabled', local: true, remote: false, resolution: 'local' },
      { key: 'locale', local: 'en', remote: 'zh-Hant', resolution: 'local' },
    ])
    expect(preview.merged.recentHistory).toEqual(local.recentHistory)
    expect(preview.historyConflicts).toEqual([
      {
        id: 'history-conflict',
        local: local.recentHistory[0],
        remote: remote.recentHistory[0],
        resolution: 'local',
      },
    ])
  })

  it('reports added history IDs only for remote records retained after the 100-record cap', () => {
    const localHistory = Array.from({ length: 99 }, (_, index) => ({
      id: `local-${index}`,
      trackId: `track-local-${index}`,
      playedAt: new Date(Date.UTC(2026, 7, 11, 12) - index * 60_000).toISOString(),
    }))
    const local: LibraryExport = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [],
      playlists: [],
      preferences: { historyEnabled: false },
      recentHistory: localHistory,
    }
    const remote: LibraryExport = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [],
      playlists: [],
      preferences: { historyEnabled: false },
      recentHistory: [
        {
          id: 'remote-new',
          trackId: 'track-remote-new',
          playedAt: '2026-08-11T13:00:00.000Z',
        },
        {
          id: 'remote-expired',
          trackId: 'track-remote-expired',
          playedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    }

    const preview = previewLibraryMerge(local, remote)

    expect(preview.merged.recentHistory).toHaveLength(100)
    expect(preview.merged.recentHistory.some(({ id }) => id === 'remote-new')).toBe(true)
    expect(preview.merged.recentHistory.some(({ id }) => id === 'remote-expired')).toBe(false)
    expect(preview.addedHistoryIds).toEqual(['remote-new'])
  })

  it('keeps merge preview pure and returns detached local and remote values', () => {
    const local: LibraryExport = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [{ trackId: 'track-local', addedAt: '2026-08-11T00:00:00.000Z' }],
      playlists: [],
      preferences: { historyEnabled: true },
      recentHistory: [],
    }
    const remote: LibraryExport = {
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites: [{ trackId: 'track-remote', addedAt: '2026-08-10T00:00:00.000Z' }],
      playlists: [],
      preferences: { historyEnabled: false },
      recentHistory: [],
    }
    const beforeLocal = structuredClone(local)
    const beforeRemote = structuredClone(remote)

    const preview = previewLibraryMerge(local, remote)
    preview.merged.favourites[0]!.trackId = 'track-mutated'
    preview.preferenceConflicts[0]!.local = false

    expect(local).toEqual(beforeLocal)
    expect(remote).toEqual(beforeRemote)
  })
})
