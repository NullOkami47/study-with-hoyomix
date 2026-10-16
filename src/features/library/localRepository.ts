import type {
  LibraryExport,
  LibraryPreferenceKey,
  LocalPlaylist,
  MergePreview,
} from './types'
import {
  createEmptyLocalLibrary,
  LibraryValidationError,
  LOCAL_LIBRARY_SCHEMA_VERSION,
  LOCAL_LIBRARY_LIMITS,
  parseCanonicalId,
  parseLibraryExport,
  parseLibraryPreference,
} from './types'

export { LibraryValidationError, LOCAL_LIBRARY_SCHEMA_VERSION } from './types'
export const LOCAL_LIBRARY_DATABASE_NAME = 'study-with-hoyomix-library'

const STORE_FAVOURITES = 'favourites'
const STORE_PLAYLISTS = 'playlists'
const STORE_PREFERENCES = 'preferences'
const STORE_HISTORY = 'recentHistory'
const STORE_NAMES = [STORE_FAVOURITES, STORE_PLAYLISTS, STORE_PREFERENCES, STORE_HISTORY]

interface StoredPreference {
  key: string
  value: unknown
}

export interface LocalLibraryRepositoryOptions {
  indexedDB?: IDBFactory
  databaseName?: string
  now?: () => string
}

export type LocalLibraryStorageMode = 'persistent' | 'memory'
export type LibraryStorageErrorCode = 'open_failed' | 'transaction_failed' | 'upgrade_blocked'

export class LibraryStorageError extends Error {
  readonly code: LibraryStorageErrorCode

  constructor(code: LibraryStorageErrorCode, message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'LibraryStorageError'
    this.code = code
    if (options && 'cause' in options) (this as Error & { cause?: unknown }).cause = options.cause
  }
}

export interface LocalLibraryRepository {
  addFavourite(trackId: string): Promise<void>
  removeFavourite(trackId: string): Promise<void>
  createPlaylist(input: { id: string; name: string }): Promise<void>
  deletePlaylist(id: string): Promise<void>
  setPlaylistOrder(id: string, trackIds: readonly string[]): Promise<void>
  setPreference(key: string, value: unknown): Promise<void>
  setHistoryEnabled(enabled: boolean): Promise<void>
  recordRecent(trackId: string): Promise<boolean>
  clearHistory(): Promise<void>
  replaceWithLibraryIfUnchanged(expected: unknown, replacement: unknown): Promise<boolean>
  exportLocalLibrary(): Promise<LibraryExport>
  mergeLocalLibrary(remote: unknown): MergePreview
  subscribe(listener: (library: LibraryExport) => void): () => void
  storageMode(): LocalLibraryStorageMode
  destroy(): void
}

interface RepositoryCoordinatorMember {
  assign(library: LibraryExport): boolean
  notify(): void
}

interface RepositoryCoordinator {
  members: Set<RepositoryCoordinatorMember>
  operation: Promise<void>
  pendingOperations: number
  deleteIfUnused(): void
}

const repositoryCoordinators = new WeakMap<object, Map<string, RepositoryCoordinator>>()

function coordinatorFor(indexedDB: IDBFactory | undefined, databaseName: string): RepositoryCoordinator | undefined {
  if (!indexedDB) return undefined
  let databases = repositoryCoordinators.get(indexedDB)
  if (!databases) {
    databases = new Map()
    repositoryCoordinators.set(indexedDB, databases)
  }
  let coordinator = databases.get(databaseName)
  if (!coordinator) {
    const created: RepositoryCoordinator = {
      members: new Set(),
      operation: Promise.resolve(),
      pendingOperations: 0,
      deleteIfUnused() {
        if (
          created.members.size === 0 &&
          created.pendingOperations === 0 &&
          databases?.get(databaseName) === created
        ) databases.delete(databaseName)
      },
    }
    coordinator = created
    databases.set(databaseName, coordinator)
  }
  return coordinator
}

function leaveCoordinator(
  coordinator: RepositoryCoordinator | undefined,
  member: RepositoryCoordinatorMember,
): void {
  if (!coordinator) return
  coordinator.members.delete(member)
  coordinator.deleteIfUnused()
}

function runExclusive<T>(coordinator: RepositoryCoordinator, action: () => Promise<T>): Promise<T> {
  const result = coordinator.operation.then(action, action)
  coordinator.pendingOperations += 1
  const settled = result.then(
    (value) => {
      coordinator.pendingOperations -= 1
      coordinator.deleteIfUnused()
      return value
    },
    (error: unknown) => {
      coordinator.pendingOperations -= 1
      coordinator.deleteIfUnused()
      throw error
    },
  )
  coordinator.operation = settled.then(() => undefined, () => undefined)
  return settled
}

function cloneLibrary(library: LibraryExport): LibraryExport {
  return parseLibraryExport(structuredClone(library))
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
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function createStores(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(STORE_FAVOURITES)) {
    database.createObjectStore(STORE_FAVOURITES, { keyPath: 'trackId' })
  }
  if (!database.objectStoreNames.contains(STORE_PLAYLISTS)) {
    database.createObjectStore(STORE_PLAYLISTS, { keyPath: 'id' })
  }
  if (!database.objectStoreNames.contains(STORE_PREFERENCES)) {
    database.createObjectStore(STORE_PREFERENCES, { keyPath: 'key' })
  }
  if (!database.objectStoreNames.contains(STORE_HISTORY)) {
    database.createObjectStore(STORE_HISTORY, { keyPath: 'id' })
  }
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

function openDatabase(indexedDB: IDBFactory | undefined, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new DOMException('IndexedDB is unavailable', 'SecurityError'))
      return
    }
    let settled = false
    try {
      const request = indexedDB.open(databaseName, LOCAL_LIBRARY_SCHEMA_VERSION)
      request.onupgradeneeded = () => {
        try {
          createStores(request.result)
        } catch (error) {
          settled = true
          try { request.transaction?.abort() } catch { /* The original upgrade failure is authoritative. */ }
          reject(new LibraryStorageError('transaction_failed', 'IndexedDB schema upgrade failed', { cause: error }))
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
        reject(
          isIndexedDbUnavailable(error)
            ? error
            : new LibraryStorageError('open_failed', 'IndexedDB open failed', { cause: error }),
        )
      }
      request.onblocked = () => {
        if (settled) return
        settled = true
        reject(new LibraryStorageError('upgrade_blocked', 'IndexedDB upgrade was blocked'))
      }
    } catch (error) {
      reject(
        isIndexedDbUnavailable(error)
          ? error
          : new LibraryStorageError('open_failed', 'IndexedDB open failed', { cause: error }),
      )
    }
  })
}

async function readExport(database: IDBDatabase): Promise<LibraryExport> {
  try {
    const transaction = database.transaction(STORE_NAMES, 'readonly')
    const favouritesRequest = transaction.objectStore(STORE_FAVOURITES).getAll()
    const playlistsRequest = transaction.objectStore(STORE_PLAYLISTS).getAll()
    const preferencesRequest = transaction.objectStore(STORE_PREFERENCES).getAll()
    const historyRequest = transaction.objectStore(STORE_HISTORY).getAll()
    const [favourites, playlists, storedPreferences, recentHistory] = await Promise.all([
      requestResult(favouritesRequest),
      requestResult(playlistsRequest),
      requestResult(preferencesRequest as IDBRequest<StoredPreference[]>),
      requestResult(historyRequest),
      transactionComplete(transaction),
    ])
    const preferences: Record<string, unknown> = { historyEnabled: false }
    for (const preference of storedPreferences) preferences[preference.key] = preference.value

    return parseLibraryExport({
      schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
      favourites,
      playlists,
      preferences,
      recentHistory,
    }, 'persistedLibrary')
  } catch (error) {
    if (
      isIndexedDbUnavailable(error) ||
      error instanceof LibraryStorageError ||
      error instanceof LibraryValidationError
    ) throw error
    throw new LibraryStorageError('transaction_failed', 'IndexedDB read transaction failed', { cause: error })
  }
}

async function writeExport(database: IDBDatabase, library: LibraryExport): Promise<void> {
  try {
    library = parseLibraryExport(library)
    const transaction = database.transaction(STORE_NAMES, 'readwrite')
    for (const storeName of STORE_NAMES) transaction.objectStore(storeName).clear()
    for (const favourite of library.favourites) transaction.objectStore(STORE_FAVOURITES).put(favourite)
    for (const playlist of library.playlists) transaction.objectStore(STORE_PLAYLISTS).put(playlist)
    for (const [key, value] of Object.entries(library.preferences)) {
      transaction.objectStore(STORE_PREFERENCES).put({ key, value } satisfies StoredPreference)
    }
    for (const history of library.recentHistory) transaction.objectStore(STORE_HISTORY).put(history)
    await transactionComplete(transaction)
  } catch (error) {
    if (
      isIndexedDbUnavailable(error) ||
      error instanceof LibraryStorageError ||
      error instanceof LibraryValidationError
    ) throw error
    throw new LibraryStorageError('transaction_failed', 'IndexedDB write transaction failed', { cause: error })
  }
}

function uniqueTrackIds(trackIds: readonly string[]): string[] {
  return [...new Set(trackIds.map((trackId, index) => parseCanonicalId(trackId, `trackIds[${index}]`)))]
}

let historyIdSequence = 0

function createHistoryRecordId(): string {
  historyIdSequence += 1
  const sequence = historyIdSequence.toString(36).padStart(10, '0')
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `history-${uuid}-${sequence}`
  const random = Math.random().toString(36).slice(2, 14).padEnd(12, '0')
  return `history-${random}-${sequence}`
}

function playlistsDiffer(left: LocalPlaylist, right: LocalPlaylist): boolean {
  return (
    left.name !== right.name ||
    left.trackIds.length !== right.trackIds.length ||
    left.trackIds.some((trackId, index) => trackId !== right.trackIds[index])
  )
}

function historyRecordsDiffer(
  left: LibraryExport['recentHistory'][number],
  right: LibraryExport['recentHistory'][number],
): boolean {
  return left.trackId !== right.trackId || left.playedAt !== right.playedAt
}

export function previewLibraryMerge(local: LibraryExport, remote: unknown): MergePreview {
  local = parseLibraryExport(local, 'localLibrary')
  const parsedRemote = parseLibraryExport(remote, 'remoteLibrary')
  const localFavouriteIds = new Set(local.favourites.map(({ trackId }) => trackId))
  const addedFavouriteTrackIds = parsedRemote.favourites
    .map(({ trackId }) => trackId)
    .filter((trackId) => !localFavouriteIds.has(trackId))
    .sort()
  const favourites = [...local.favourites]
  for (const favourite of parsedRemote.favourites) {
    if (!localFavouriteIds.has(favourite.trackId)) {
      favourites.push(structuredClone(favourite))
      localFavouriteIds.add(favourite.trackId)
    }
  }
  favourites.sort((left, right) => left.trackId.localeCompare(right.trackId))

  const localPlaylists = new Map(local.playlists.map((playlist) => [playlist.id, playlist]))
  const addedPlaylistIds: string[] = []
  const playlistConflicts: MergePreview['playlistConflicts'] = []
  const playlists = local.playlists.map((playlist) => structuredClone(playlist))
  for (const remotePlaylist of parsedRemote.playlists) {
    const localPlaylist = localPlaylists.get(remotePlaylist.id)
    if (!localPlaylist) {
      addedPlaylistIds.push(remotePlaylist.id)
      playlists.push(structuredClone(remotePlaylist))
    } else if (playlistsDiffer(localPlaylist, remotePlaylist)) {
      playlistConflicts.push({
        id: remotePlaylist.id,
        local: structuredClone(localPlaylist),
        remote: structuredClone(remotePlaylist),
      })
    }
  }
  playlists.sort((left, right) => left.id.localeCompare(right.id))
  addedPlaylistIds.sort()
  playlistConflicts.sort((left, right) => left.id.localeCompare(right.id))

  const preferenceConflicts: MergePreview['preferenceConflicts'] = []
  const localPreferenceKeys = Object.keys(local.preferences).sort() as LibraryPreferenceKey[]
  for (const key of localPreferenceKeys) {
    if (key in parsedRemote.preferences && local.preferences[key] !== parsedRemote.preferences[key]) {
      preferenceConflicts.push({
        key,
        local: structuredClone(local.preferences[key]),
        remote: structuredClone(parsedRemote.preferences[key]),
        resolution: 'local',
      })
    }
  }

  const localHistoryById = new Map(local.recentHistory.map((history) => [history.id, history]))
  const remoteAddedHistoryIds = new Set<string>()
  const historyConflicts: MergePreview['historyConflicts'] = []
  const recentHistory = local.recentHistory.map((history) => structuredClone(history))
  for (const history of parsedRemote.recentHistory) {
    const localHistory = localHistoryById.get(history.id)
    if (!localHistory) {
      remoteAddedHistoryIds.add(history.id)
      recentHistory.push(structuredClone(history))
    } else if (historyRecordsDiffer(localHistory, history)) {
      historyConflicts.push({
        id: history.id,
        local: structuredClone(localHistory),
        remote: structuredClone(history),
        resolution: 'local',
      })
    }
  }
  recentHistory.sort(
    (left, right) => right.playedAt.localeCompare(left.playedAt) || left.id.localeCompare(right.id),
  )
  recentHistory.splice(LOCAL_LIBRARY_LIMITS.recentHistory)
  historyConflicts.sort((left, right) => left.id.localeCompare(right.id))
  const addedHistoryIds = recentHistory
    .map(({ id }) => id)
    .filter((id) => remoteAddedHistoryIds.has(id))
    .sort()

  const merged = parseLibraryExport({
    schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
    favourites,
    playlists,
    preferences: { ...parsedRemote.preferences, ...local.preferences },
    recentHistory,
  }, 'mergedLibrary')

  return {
    merged,
    addedFavouriteTrackIds,
    addedPlaylistIds,
    playlistConflicts,
    preferenceConflicts,
    historyConflicts,
    addedHistoryIds,
  }
}

export function createLocalLibraryRepository(
  options: LocalLibraryRepositoryOptions = {},
): LocalLibraryRepository {
  const indexedDB = options.indexedDB ?? globalThis.indexedDB
  const databaseName = options.databaseName ?? LOCAL_LIBRARY_DATABASE_NAME
  const now = options.now ?? (() => new Date().toISOString())
  let snapshot = createEmptyLocalLibrary()
  let loaded = false
  let memoryOnly = !indexedDB
  let operation = Promise.resolve()
  let destroyed = false
  const listeners = new Set<(library: LibraryExport) => void>()
  const coordinator = coordinatorFor(indexedDB, databaseName)
  let coordinatorJoined = false

  function notifyListeners(): void {
    for (const listener of listeners) {
      try { listener(cloneLibrary(snapshot)) } catch { /* Subscribers cannot affect repository truth. */ }
    }
  }

  const coordinatorMember: RepositoryCoordinatorMember = {
    assign(library) {
      if (destroyed || memoryOnly) return false
      snapshot = cloneLibrary(library)
      loaded = true
      return true
    },
    notify: notifyListeners,
  }

  function leave(): void {
    if (!coordinatorJoined) return
    leaveCoordinator(coordinator, coordinatorMember)
    coordinatorJoined = false
  }

  if (coordinator) {
    coordinator.members.add(coordinatorMember)
    coordinatorJoined = true
  }

  async function load(): Promise<LibraryExport> {
    if (loaded) return snapshot
    if (memoryOnly) {
      loaded = true
      return snapshot
    }
    try {
      const database = await openDatabase(indexedDB, databaseName)
      try {
        snapshot = await readExport(database)
        loaded = true
      } finally {
        database.close()
      }
    } catch (error) {
      if (!isIndexedDbUnavailable(error)) throw error
      memoryOnly = true
      loaded = true
      leave()
    }
    return snapshot
  }

  function mutateMemory(change: (library: LibraryExport) => void): void {
    const draft = cloneLibrary(snapshot)
    change(draft)
    snapshot = parseLibraryExport(draft)
    loaded = true
    notifyListeners()
  }

  async function mutatePersistent(change: (library: LibraryExport) => void): Promise<void> {
    if (!coordinator) {
      mutateMemory(change)
      return
    }
    await runExclusive(coordinator, async () => {
      let database: IDBDatabase | undefined
      let candidate: LibraryExport | undefined
      try {
        database = await openDatabase(indexedDB, databaseName)
        const latest = await readExport(database)
        const draft = cloneLibrary(latest)
        change(draft)
        candidate = parseLibraryExport(draft)
        await writeExport(database, candidate)
        snapshot = candidate
        loaded = true
        const assignedPeers: RepositoryCoordinatorMember[] = []
        for (const member of coordinator.members) {
          if (member !== coordinatorMember && member.assign(candidate)) assignedPeers.push(member)
        }
        notifyListeners()
        for (const member of assignedPeers) member.notify()
      } catch (error) {
        if (!isIndexedDbUnavailable(error)) throw error
        memoryOnly = true
        leave()
        if (candidate) {
          snapshot = candidate
          loaded = true
          notifyListeners()
        } else {
          mutateMemory(change)
        }
      } finally {
        database?.close()
      }
    })
  }

  function mutate(change: (library: LibraryExport) => void): Promise<void> {
    const next = operation.then(async () => {
      if (destroyed) throw new Error('Local library repository has been destroyed')
      await load()
      if (memoryOnly) mutateMemory(change)
      else await mutatePersistent(change)
    })
    operation = next.catch(() => undefined)
    return next
  }

  const repository: LocalLibraryRepository = {
    async addFavourite(trackId) {
      const canonicalTrackId = parseCanonicalId(trackId, 'trackId')
      await mutate((library) => {
        if (library.favourites.some((favourite) => favourite.trackId === canonicalTrackId)) return
        library.favourites.push({ trackId: canonicalTrackId, addedAt: now() })
        library.favourites.sort((left, right) => left.trackId.localeCompare(right.trackId))
      })
    },
    async removeFavourite(trackId) {
      const canonicalTrackId = parseCanonicalId(trackId, 'trackId')
      await mutate((library) => {
        library.favourites = library.favourites.filter((favourite) => favourite.trackId !== canonicalTrackId)
      })
    },
    async createPlaylist({ id, name }) {
      const playlistId = parseCanonicalId(id, 'playlist.id')
      const timestamp = now()
      const candidate = parseLibraryExport({
        ...createEmptyLocalLibrary(),
        playlists: [{ id: playlistId, name, trackIds: [], createdAt: timestamp, updatedAt: timestamp }],
      }).playlists[0]!
      await mutate((library) => {
        if (library.playlists.some((playlist) => playlist.id === playlistId)) return
        library.playlists.push(candidate)
        library.playlists.sort((left, right) => left.id.localeCompare(right.id))
      })
    },
    async deletePlaylist(id) {
      const playlistId = parseCanonicalId(id, 'playlist.id')
      await mutate((library) => {
        library.playlists = library.playlists.filter((playlist) => playlist.id !== playlistId)
      })
    },
    async setPlaylistOrder(id, trackIds) {
      const playlistId = parseCanonicalId(id, 'playlist.id')
      if (trackIds.length > LOCAL_LIBRARY_LIMITS.playlistTracks) {
        throw new LibraryValidationError('trackIds', `must contain at most ${LOCAL_LIBRARY_LIMITS.playlistTracks} entries`)
      }
      const orderedTrackIds = uniqueTrackIds(trackIds)
      await mutate((library) => {
        const playlist = library.playlists.find((candidate) => candidate.id === playlistId)
        if (!playlist) return
        playlist.trackIds = orderedTrackIds
        playlist.updatedAt = now()
      })
    },
    async setPreference(key, value) {
      const parsedValue = parseLibraryPreference(key, value)
      await mutate((library) => {
        Object.assign(library.preferences, { [key as LibraryPreferenceKey]: parsedValue })
      })
    },
    setHistoryEnabled(enabled) {
      return repository.setPreference('historyEnabled', enabled)
    },
    async recordRecent(trackId) {
      const canonicalTrackId = parseCanonicalId(trackId, 'trackId')
      let stored = false
      await mutate((library) => {
        if (!library.preferences.historyEnabled) return
        const playedAt = now()
        const id = createHistoryRecordId()
        library.recentHistory.push({ id, trackId: canonicalTrackId, playedAt })
        library.recentHistory.sort(
          (left, right) =>
            right.playedAt.localeCompare(left.playedAt) || left.id.localeCompare(right.id),
        )
        library.recentHistory = library.recentHistory.slice(0, LOCAL_LIBRARY_LIMITS.recentHistory)
        stored = true
      })
      return stored
    },
    clearHistory() {
      return mutate((library) => {
        library.recentHistory = []
      })
    },
    async replaceWithLibraryIfUnchanged(expectedValue, replacementValue) {
      const expected = parseLibraryExport(expectedValue, 'expectedLibrary')
      const replacement = parseLibraryExport(replacementValue, 'replacementLibrary')
      let replaced = false
      await mutate((library) => {
        if (JSON.stringify(library) !== JSON.stringify(expected)) return
        library.schemaVersion = replacement.schemaVersion
        library.favourites = structuredClone(replacement.favourites)
        library.playlists = structuredClone(replacement.playlists)
        library.preferences = structuredClone(replacement.preferences)
        library.recentHistory = structuredClone(replacement.recentHistory)
        replaced = true
      })
      return replaced
    },
    async exportLocalLibrary() {
      await operation
      await load()
      return parseLibraryExport(snapshot)
    },
    mergeLocalLibrary(remote) {
      if (!loaded) {
        throw new Error('Load local library before creating a merge preview')
      }
      return previewLibraryMerge(snapshot, remote)
    },
    subscribe(listener) {
      listeners.add(listener)
      if (loaded) {
        try { listener(cloneLibrary(snapshot)) } catch { /* Immediate delivery is isolated too. */ }
      }
      return () => listeners.delete(listener)
    },
    storageMode() {
      return memoryOnly ? 'memory' : 'persistent'
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      listeners.clear()
      leave()
    },
  }

  return repository
}

const defaultRepository = createLocalLibraryRepository()

export function getDefaultLocalLibraryRepository(): LocalLibraryRepository {
  return defaultRepository
}

export function exportLocalLibrary(): Promise<LibraryExport> {
  return defaultRepository.exportLocalLibrary()
}

export function mergeLocalLibrary(remote: unknown): MergePreview {
  return defaultRepository.mergeLocalLibrary(remote)
}
