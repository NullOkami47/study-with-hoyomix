import {
  LOCAL_LIBRARY_LIMITS,
  parseCanonicalId,
  parseLibraryExport,
  parseLibraryPreference,
  type HistoryMergeConflict,
  type LibraryExport,
  type LibraryPreferenceKey,
  type LocalPlaylist,
  type MergePreview,
  type PlaylistMergeConflict,
  type PreferenceMergeConflict,
  type RecentHistoryRecord,
} from './types'

export interface RemoteMergeEnvelope {
  confirmationToken: string
  preview: MergePreview
}

export interface RemoteLibraryRepository {
  load(): Promise<LibraryExport>
  previewMerge(local: LibraryExport): Promise<RemoteMergeEnvelope>
  confirmMerge(local: LibraryExport, confirmationToken: string): Promise<LibraryExport>
  recordHistory(record: RecentHistoryRecord): Promise<RecentHistoryRecord[]>
  clearHistory(): Promise<void>
  exportAccountData(): Promise<unknown>
  deleteAccount(): Promise<void>
}

export interface RemoteLibraryRepositoryOptions {
  fetch?: typeof fetch
}

const record = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: invalid object`)
  return value as Record<string, unknown>
}

const exact = (value: Record<string, unknown>, keys: readonly string[], path: string) => {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))) {
    throw new Error(`${path}: invalid shape`)
  }
}

const boundedArray = (value: unknown, maximum: number, path: string): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${path}: invalid array`)
  return value
}

const playlist = (value: unknown, path: string): LocalPlaylist => parseLibraryExport({
  schemaVersion: 2,
  favourites: [],
  playlists: [value],
  preferences: { historyEnabled: false },
  recentHistory: [],
}, path).playlists[0]!

const history = (value: unknown, path: string): RecentHistoryRecord => parseLibraryExport({
  schemaVersion: 2,
  favourites: [],
  playlists: [],
  preferences: { historyEnabled: false },
  recentHistory: [value],
}, path).recentHistory[0]!

function parseMergePreview(value: unknown): MergePreview {
  const candidate = record(value, 'mergePreview')
  exact(candidate, [
    'merged', 'addedFavouriteTrackIds', 'addedPlaylistIds', 'playlistConflicts',
    'preferenceConflicts', 'historyConflicts', 'addedHistoryIds',
  ], 'mergePreview')
  const parseIds = (input: unknown, maximum: number, path: string) =>
    boundedArray(input, maximum, path).map((id, index) => parseCanonicalId(id, `${path}[${index}]`))
  const playlistConflicts = boundedArray(candidate.playlistConflicts, LOCAL_LIBRARY_LIMITS.playlists, 'playlistConflicts')
    .map((value, index): PlaylistMergeConflict => {
      const conflict = record(value, `playlistConflicts[${index}]`)
      exact(conflict, ['id', 'local', 'remote'], `playlistConflicts[${index}]`)
      return {
        id: parseCanonicalId(conflict.id, `playlistConflicts[${index}].id`),
        local: playlist(conflict.local, `playlistConflicts[${index}].local`),
        remote: playlist(conflict.remote, `playlistConflicts[${index}].remote`),
      }
    })
  const preferenceConflicts = boundedArray(candidate.preferenceConflicts, 6, 'preferenceConflicts')
    .map((value, index): PreferenceMergeConflict => {
      const conflict = record(value, `preferenceConflicts[${index}]`)
      exact(conflict, ['key', 'local', 'remote', 'resolution'], `preferenceConflicts[${index}]`)
      if (typeof conflict.key !== 'string' || conflict.resolution !== 'local') throw new Error('invalid preference conflict')
      return {
        key: conflict.key as LibraryPreferenceKey,
        local: parseLibraryPreference(conflict.key, conflict.local),
        remote: parseLibraryPreference(conflict.key, conflict.remote),
        resolution: 'local',
      }
    })
  const historyConflicts = boundedArray(candidate.historyConflicts, LOCAL_LIBRARY_LIMITS.recentHistory, 'historyConflicts')
    .map((value, index): HistoryMergeConflict => {
      const conflict = record(value, `historyConflicts[${index}]`)
      exact(conflict, ['id', 'local', 'remote', 'resolution'], `historyConflicts[${index}]`)
      if (typeof conflict.id !== 'string' || conflict.resolution !== 'local') throw new Error('invalid history conflict')
      const local = history(conflict.local, `historyConflicts[${index}].local`)
      const remote = history(conflict.remote, `historyConflicts[${index}].remote`)
      if (local.id !== conflict.id || remote.id !== conflict.id) throw new Error('history conflict id mismatch')
      return { id: conflict.id, local, remote, resolution: 'local' }
    })
  return {
    merged: parseLibraryExport(candidate.merged, 'mergePreview.merged'),
    addedFavouriteTrackIds: parseIds(candidate.addedFavouriteTrackIds, LOCAL_LIBRARY_LIMITS.favourites, 'addedFavouriteTrackIds'),
    addedPlaylistIds: parseIds(candidate.addedPlaylistIds, LOCAL_LIBRARY_LIMITS.playlists, 'addedPlaylistIds'),
    playlistConflicts,
    preferenceConflicts,
    historyConflicts,
    addedHistoryIds: boundedArray(candidate.addedHistoryIds, LOCAL_LIBRARY_LIMITS.recentHistory, 'addedHistoryIds')
      .map((id, index) => {
        if (typeof id !== 'string' || id.length < 1 || id.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
          throw new Error(`addedHistoryIds[${index}]: invalid id`)
        }
        return id
      }),
  }
}

async function body(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`remote_library_${response.status}`)
  return response.json()
}

export function createRemoteLibraryRepository(options: RemoteLibraryRepositoryOptions = {}): RemoteLibraryRepository {
  const fetcher = options.fetch ?? fetch
  const request = (path: string, init?: RequestInit) => fetcher(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    ...init,
  })
  return {
    async load() {
      return parseLibraryExport(await body(await request('/api/library')), 'remoteLibrary')
    },
    async previewMerge(local) {
      const response = record(await body(await request('/api/library/merge', {
        method: 'POST', body: JSON.stringify({ library: parseLibraryExport(local) }),
      })), 'mergeEnvelope')
      exact(response, ['confirmationToken', 'preview'], 'mergeEnvelope')
      if (typeof response.confirmationToken !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(response.confirmationToken)) {
        throw new Error('invalid confirmation token')
      }
      return structuredClone({ confirmationToken: response.confirmationToken, preview: parseMergePreview(response.preview) })
    },
    async confirmMerge(local, confirmationToken) {
      if (!/^sha256:[0-9a-f]{64}$/u.test(confirmationToken)) throw new Error('invalid confirmation token')
      const response = record(await body(await request('/api/library/merge', {
        method: 'POST', body: JSON.stringify({ library: parseLibraryExport(local), confirmationToken }),
      })), 'mergeResult')
      exact(response, ['library'], 'mergeResult')
      return parseLibraryExport(response.library, 'remoteLibrary')
    },
    async recordHistory(value) {
      const valid = history(value, 'historyRecord')
      const response = record(await body(await request('/api/history', {
        method: 'POST', body: JSON.stringify(valid),
      })), 'historyResult')
      exact(response, ['recentHistory'], 'historyResult')
      return boundedArray(response.recentHistory, LOCAL_LIBRARY_LIMITS.recentHistory, 'recentHistory')
        .map((entry, index) => history(entry, `recentHistory[${index}]`))
    },
    async clearHistory() {
      const response = await request('/api/history', { method: 'DELETE' })
      if (!response.ok) throw new Error(`remote_library_${response.status}`)
    },
    async exportAccountData() {
      return body(await request('/api/export'))
    },
    async deleteAccount() {
      const response = await request('/api/account/delete', {
        method: 'POST', body: JSON.stringify({ confirmation: 'DELETE' }),
      })
      if (!response.ok) throw new Error(`remote_library_${response.status}`)
    },
  }
}

let defaultRemoteRepository: RemoteLibraryRepository | undefined
export function getDefaultRemoteLibraryRepository(): RemoteLibraryRepository {
  defaultRemoteRepository ??= createRemoteLibraryRepository()
  return defaultRemoteRepository
}
