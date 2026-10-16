export const LX_MAX_SCRIPT_BYTES = 512 * 1024
export const LX_MAX_REMOTE_RESPONSE_BYTES = 512 * 1024

export interface LxSourceRecord {
  id: string
  name: string
  version?: string
  originUrl?: string
  sha256: string
  enabled: boolean
  priority: number
  script: string
  builtIn: boolean
  importedAt: number
  updatedAt: number
}

export interface LxScriptHeaderMeta {
  name?: string
  version?: string
  description?: string
}

export interface LxSourceRepositoryOptions {
  indexedDB?: IDBFactory
  databaseName?: string
  fetch?: typeof fetch
  now?: () => number
}

export interface LxSourceRepository {
  list(): Promise<LxSourceRecord[]>
  get(id: string): Promise<LxSourceRecord | null>
  setEnabled(id: string, enabled: boolean): Promise<void>
  reorder(customSourceIds: readonly string[]): Promise<void>
  delete(id: string): Promise<void>
  importScript(
    script: string,
    meta?: { name?: string; originUrl?: string; version?: string },
  ): Promise<LxSourceRecord>
  importRemote(url: string): Promise<LxSourceRecord>
  refreshRemote(id: string): Promise<LxSourceRecord>
}
