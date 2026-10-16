import { parseLxScriptHeader } from './header'
import {
  LX_MAX_REMOTE_RESPONSE_BYTES,
  LX_MAX_SCRIPT_BYTES,
  type LxSourceRecord,
  type LxSourceRepository,
  type LxSourceRepositoryOptions,
} from './types'

export const LX_DATABASE_NAME = 'study-with-hoyomix:lx-sources:v1'
export const LX_STORE_SOURCES = 'lx_sources'

export async function computeSha256(content: string | Uint8Array): Promise<string> {
  const data = typeof content === 'string' ? new TextEncoder().encode(content) : content
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
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
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(LX_STORE_SOURCES)) {
          db.createObjectStore(LX_STORE_SOURCES, { keyPath: 'id' })
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
        reject(request.error ?? new Error('IndexedDB open failed'))
      }
      request.onblocked = () => {
        if (settled) return
        settled = true
        reject(new Error('IndexedDB upgrade was blocked'))
      }
    } catch (error) {
      reject(error)
    }
  })
}

export function createLxSourceRepository(
  options?: LxSourceRepositoryOptions,
): LxSourceRepository {
  const databaseName = options?.databaseName ?? LX_DATABASE_NAME
  const now = options?.now ?? (() => Date.now())

  let memoryOnly = false
  let loaded = false
  let memoryRecords = new Map<string, LxSourceRecord>()

  function resolveIdb(): IDBFactory | undefined {
    if (options && 'indexedDB' in options) return options.indexedDB
    if (typeof indexedDB !== 'undefined') return indexedDB
    return undefined
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return

    const idb = resolveIdb()
    if (!idb) {
      memoryOnly = true
      loaded = true
      return
    }

    try {
      const db = await openDatabase(idb, databaseName)
      try {
        const tx = db.transaction(LX_STORE_SOURCES, 'readwrite')
        const store = tx.objectStore(LX_STORE_SOURCES)
        const stored = ((await requestResult(store.getAll())) as LxSourceRecord[]) || []
        memoryRecords = new Map(stored.map((r) => [r.id, r]))

        await transactionComplete(tx)
        loaded = true
      } finally {
        db.close()
      }
    } catch {
      memoryOnly = true
      loaded = true
    }
  }

  async function readAllRecords(): Promise<LxSourceRecord[]> {
    if (memoryOnly) {
      return Array.from(memoryRecords.values())
    }

    const idb = resolveIdb()
    if (!idb) return Array.from(memoryRecords.values())

    try {
      const db = await openDatabase(idb, databaseName)
      try {
        const tx = db.transaction(LX_STORE_SOURCES, 'readonly')
        const store = tx.objectStore(LX_STORE_SOURCES)
        const stored = ((await requestResult(store.getAll())) as LxSourceRecord[]) || []
        await transactionComplete(tx)
        memoryRecords = new Map(stored.map((r) => [r.id, r]))
        return stored
      } finally {
        db.close()
      }
    } catch {
      memoryOnly = true
      return Array.from(memoryRecords.values())
    }
  }

  async function persistRecord(record: LxSourceRecord): Promise<void> {
    memoryRecords.set(record.id, record)
    if (memoryOnly) return

    const idb = resolveIdb()
    if (!idb) return

    try {
      const db = await openDatabase(idb, databaseName)
      try {
        const tx = db.transaction(LX_STORE_SOURCES, 'readwrite')
        const store = tx.objectStore(LX_STORE_SOURCES)
        store.put(record)
        await transactionComplete(tx)
      } finally {
        db.close()
      }
    } catch {
      memoryOnly = true
    }
  }

  async function persistRecords(records: LxSourceRecord[]): Promise<void> {
    for (const r of records) memoryRecords.set(r.id, r)
    if (memoryOnly) return

    const idb = resolveIdb()
    if (!idb) return

    try {
      const db = await openDatabase(idb, databaseName)
      try {
        const tx = db.transaction(LX_STORE_SOURCES, 'readwrite')
        const store = tx.objectStore(LX_STORE_SOURCES)
        for (const r of records) {
          store.put(r)
        }
        await transactionComplete(tx)
      } finally {
        db.close()
      }
    } catch {
      memoryOnly = true
    }
  }

  async function removeRecord(id: string): Promise<void> {
    memoryRecords.delete(id)
    if (memoryOnly) return

    const idb = resolveIdb()
    if (!idb) return

    try {
      const db = await openDatabase(idb, databaseName)
      try {
        const tx = db.transaction(LX_STORE_SOURCES, 'readwrite')
        const store = tx.objectStore(LX_STORE_SOURCES)
        store.delete(id)
        await transactionComplete(tx)
      } finally {
        db.close()
      }
    } catch {
      memoryOnly = true
    }
  }

  let operation = Promise.resolve()
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = operation.then(async () => {
      await ensureLoaded()
      return action()
    })
    operation = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async function fetchRemoteScript(url: string): Promise<string> {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new Error(`Invalid URL: ${url}`)
    }

    if (parsedUrl.protocol !== 'https:') {
      throw new Error('Only HTTPS URLs are allowed')
    }

    const fetcher = options?.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined)
    if (!fetcher) {
      throw new Error('Fetch API is not available')
    }

    const response = await fetcher(url, {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    })

    if (!response.ok) {
      throw new Error(
        `Failed to fetch remote source: HTTP ${response.status} ${response.statusText}`,
      )
    }

    const contentType = response.headers?.get('content-type')?.toLowerCase() ?? ''
    if (contentType.includes('text/html')) {
      throw new Error('Remote URL returned HTML instead of a JavaScript source')
    }

    const contentLengthHeader = response.headers?.get('content-length')
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10)
      if (!isNaN(contentLength) && contentLength > LX_MAX_REMOTE_RESPONSE_BYTES) {
        throw new Error(
          `Remote source exceeds maximum allowed size of ${LX_MAX_REMOTE_RESPONSE_BYTES} bytes`,
        )
      }
    }

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > LX_MAX_REMOTE_RESPONSE_BYTES) {
      throw new Error(
        `Remote source exceeds maximum allowed size of ${LX_MAX_REMOTE_RESPONSE_BYTES} bytes`,
      )
    }

    return new TextDecoder('utf-8').decode(arrayBuffer)
  }

  const repository: LxSourceRepository = {
    list() {
      return enqueue(async () => {
        const records = await readAllRecords()
        records.sort((left, right) => left.priority - right.priority)
        return structuredClone(records)
      })
    },

    get(id: string) {
      return enqueue(async () => {
        const records = await readAllRecords()
        const found = records.find((r) => r.id === id)
        return found ? structuredClone(found) : null
      })
    },

    setEnabled(id: string, enabled: boolean) {
      return enqueue(async () => {
        const records = await readAllRecords()
        const record = records.find((r) => r.id === id)
        if (!record) {
          throw new Error(`LX source not found: ${id}`)
        }
        record.enabled = enabled
        record.updatedAt = now()
        await persistRecord(record)
      })
    },

    reorder(customSourceIds: readonly string[]) {
      return enqueue(async () => {
        const uniqueIds = new Set(customSourceIds)
        if (uniqueIds.size !== customSourceIds.length) {
          throw new Error('Duplicate source IDs in reorder list')
        }

        const allRecords = await readAllRecords()
        if (allRecords.some((record) => record.builtIn && customSourceIds.includes(record.id))) {
          throw new Error('Built-in source cannot be reordered')
        }
        const customMap = new Map(allRecords.filter((r) => !r.builtIn).map((r) => [r.id, r]))

        for (const id of customSourceIds) {
          if (!customMap.has(id)) {
            throw new Error(`Unknown source ID in reorder list: ${id}`)
          }
        }

        // Ordered custom records: specified ones first, then any unmentioned custom sources
        const orderedCustom: LxSourceRecord[] = []
        for (const id of customSourceIds) {
          orderedCustom.push(customMap.get(id)!)
          customMap.delete(id)
        }
        for (const remaining of customMap.values()) {
          orderedCustom.push(remaining)
        }

        const timestamp = now()
        const toPersist: LxSourceRecord[] = []

        orderedCustom.forEach((record, index) => {
          const newPriority = (index + 2) * 10
          if (record.priority !== newPriority) {
            record.priority = newPriority
            record.updatedAt = timestamp
            toPersist.push(record)
          }
        })

        if (toPersist.length > 0) {
          await persistRecords(toPersist)
        }
      })
    },

    delete(id: string) {
      return enqueue(async () => {
        const allRecords = await readAllRecords()
        const record = allRecords.find((r) => r.id === id)
        if (!record) return
        if (record.builtIn) {
          throw new Error('Built-in source cannot be deleted')
        }

        await removeRecord(id)

        // Normalize remaining custom sources
        const remainingCustom = allRecords
          .filter((r) => !r.builtIn && r.id !== id)
          .sort((left, right) => left.priority - right.priority)

        const timestamp = now()
        const toPersist: LxSourceRecord[] = []
        remainingCustom.forEach((custom, index) => {
          const newPriority = (index + 2) * 10
          if (custom.priority !== newPriority) {
            custom.priority = newPriority
            custom.updatedAt = timestamp
            toPersist.push(custom)
          }
        })

        if (toPersist.length > 0) {
          await persistRecords(toPersist)
        }
      })
    },

    importScript(
      script: string,
      meta?: { name?: string; originUrl?: string; version?: string },
    ) {
      return enqueue(async () => {
        const scriptBytes = new TextEncoder().encode(script)
        if (scriptBytes.byteLength > LX_MAX_SCRIPT_BYTES) {
          throw new Error(
            `Script exceeds maximum allowed size of ${LX_MAX_SCRIPT_BYTES} bytes`,
          )
        }

        const sha256 = await computeSha256(scriptBytes)
        const headerMeta = parseLxScriptHeader(script)

        const name = meta?.name?.trim() || headerMeta.name?.trim() || 'Custom Source'
        const version = meta?.version?.trim() || headerMeta.version?.trim() || undefined
        const originUrl = meta?.originUrl?.trim() || undefined

        const id =
          'custom-' +
          (typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2) + Date.now().toString(36))

        const allRecords = await readAllRecords()
        const maxPriority = allRecords.reduce((max, r) => Math.max(max, r.priority), 10)
        const priority = maxPriority + 10

        const timestamp = now()
        const record: LxSourceRecord = {
          id,
          name,
          version,
          originUrl,
          sha256,
          enabled: true,
          priority,
          script,
          builtIn: false,
          importedAt: timestamp,
          updatedAt: timestamp,
        }

        await persistRecord(record)
        return structuredClone(record)
      })
    },

    importRemote(url: string) {
      return enqueue(async () => {
        const script = await fetchRemoteScript(url)
        const scriptBytes = new TextEncoder().encode(script)
        if (scriptBytes.byteLength > LX_MAX_SCRIPT_BYTES) {
          throw new Error(
            `Script exceeds maximum allowed size of ${LX_MAX_SCRIPT_BYTES} bytes`,
          )
        }

        const sha256 = await computeSha256(scriptBytes)
        const headerMeta = parseLxScriptHeader(script)

        const name = headerMeta.name?.trim() || 'Remote Source'
        const version = headerMeta.version?.trim() || undefined

        const id =
          'custom-' +
          (typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2) + Date.now().toString(36))

        const allRecords = await readAllRecords()
        const maxPriority = allRecords.reduce((max, r) => Math.max(max, r.priority), 10)
        const priority = maxPriority + 10

        const timestamp = now()
        const record: LxSourceRecord = {
          id,
          name,
          version,
          originUrl: url,
          sha256,
          enabled: true,
          priority,
          script,
          builtIn: false,
          importedAt: timestamp,
          updatedAt: timestamp,
        }

        await persistRecord(record)
        return structuredClone(record)
      })
    },

    refreshRemote(id: string) {
      return enqueue(async () => {
        const allRecords = await readAllRecords()
        const record = allRecords.find((r) => r.id === id)
        if (!record) {
          throw new Error(`LX source not found: ${id}`)
        }

        if (!record.originUrl) {
          throw new Error(`LX source ${id} has no origin URL to refresh`)
        }

        const script = await fetchRemoteScript(record.originUrl)
        const scriptBytes = new TextEncoder().encode(script)
        if (scriptBytes.byteLength > LX_MAX_SCRIPT_BYTES) {
          throw new Error(
            `Script exceeds maximum allowed size of ${LX_MAX_SCRIPT_BYTES} bytes`,
          )
        }

        const sha256 = await computeSha256(scriptBytes)
        const headerMeta = parseLxScriptHeader(script)

        if (headerMeta.name) record.name = headerMeta.name
        if (headerMeta.version) record.version = headerMeta.version
        record.script = script
        record.sha256 = sha256
        record.updatedAt = now()

        await persistRecord(record)
        return structuredClone(record)
      })
    },
  }

  return repository
}

let defaultLxSourceRepository: LxSourceRepository | undefined

export function getDefaultLxSourceRepository(): LxSourceRepository {
  defaultLxSourceRepository ??= createLxSourceRepository()
  return defaultLxSourceRepository
}
