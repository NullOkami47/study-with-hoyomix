export const LOCAL_LIBRARY_SCHEMA_VERSION = 2 as const
export const LOCAL_LIBRARY_LIMITS = {
  favourites: 10_000,
  playlists: 200,
  playlistTracks: 1_000,
  recentHistory: 100,
  playlistName: 80,
  canonicalId: 256,
} as const

export type LibraryJsonValue =
  | boolean
  | number
  | string
  | null
  | LibraryJsonValue[]
  | { [key: string]: LibraryJsonValue }

export interface LocalFavourite {
  trackId: string
  addedAt: string
}

export interface LocalPlaylist {
  id: string
  name: string
  trackIds: string[]
  createdAt: string
  updatedAt: string
}

export interface RecentHistoryRecord {
  id: string
  trackId: string
  playedAt: string
}

export interface LibraryPreferences {
  historyEnabled: boolean
  volume?: number
  locale?: 'zh-Hant' | 'zh-Hans' | 'en'
  lowPower?: boolean
  backgroundMode?: 'ambient' | 'still'
  lastSleepMinutes?: number
}

export type LibraryPreferenceKey = keyof LibraryPreferences

export interface LibraryExport {
  schemaVersion: typeof LOCAL_LIBRARY_SCHEMA_VERSION
  favourites: LocalFavourite[]
  playlists: LocalPlaylist[]
  preferences: LibraryPreferences
  recentHistory: RecentHistoryRecord[]
}

export interface PlaylistMergeConflict {
  id: string
  local: LocalPlaylist
  remote: LocalPlaylist
}

export interface PreferenceMergeConflict {
  key: LibraryPreferenceKey
  local: LibraryPreferences[LibraryPreferenceKey]
  remote: LibraryPreferences[LibraryPreferenceKey]
  resolution: 'local'
}

export interface HistoryMergeConflict {
  id: string
  local: RecentHistoryRecord
  remote: RecentHistoryRecord
  resolution: 'local'
}

export interface MergePreview {
  merged: LibraryExport
  addedFavouriteTrackIds: string[]
  addedPlaylistIds: string[]
  playlistConflicts: PlaylistMergeConflict[]
  preferenceConflicts: PreferenceMergeConflict[]
  historyConflicts: HistoryMergeConflict[]
  addedHistoryIds: string[]
}

export class LibraryValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'LibraryValidationError'
    this.path = path
  }
}

function fail(path: string, message: string): never {
  throw new LibraryValidationError(path, message)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key}`, 'is not allowed')
  }
  for (const key of allowed) {
    if (!(key in value)) fail(`${path}.${key}`, 'is required')
  }
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length > maximum) fail(path, `must contain at most ${maximum} entries`)
  return value
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  return value
}

const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const HISTORY_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u

export function parseCanonicalId(value: unknown, path = 'id'): string {
  const candidate = string(value, path)
  if (
    candidate.length > LOCAL_LIBRARY_LIMITS.canonicalId ||
    !CANONICAL_ID.test(candidate) ||
    URL_SCHEME.test(candidate)
  ) {
    fail(path, 'must be a canonical ID, not a URL, scheme, whitespace, or control data')
  }
  return candidate
}

function parseHistoryRecordId(value: unknown, path: string): string {
  const candidate = string(value, path)
  if (!HISTORY_RECORD_ID.test(candidate) || URL_SCHEME.test(candidate)) {
    fail(path, 'must be a bounded history record ID, not a URL, scheme, whitespace, or control data')
  }
  return candidate
}

function isoDate(value: unknown, path: string): string {
  const candidate = string(value, path)
  const date = new Date(candidate)
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== candidate) {
    fail(path, 'must be an exact ISO-8601 UTC timestamp')
  }
  return candidate
}

function playlistName(value: unknown, path: string): string {
  const candidate = string(value, path)
  if (
    candidate.length < 1 ||
    candidate.length > LOCAL_LIBRARY_LIMITS.playlistName ||
    candidate.trim() !== candidate ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    fail(path, `must be 1-${LOCAL_LIBRARY_LIMITS.playlistName} characters without controls`)
  }
  return candidate
}

function unique(values: readonly string[], path: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) fail(path, `contains duplicate ID ${value}`)
    seen.add(value)
  }
}

function parseFavourite(value: unknown, path: string): LocalFavourite {
  const candidate = record(value, path)
  exactKeys(candidate, ['trackId', 'addedAt'], path)
  return {
    trackId: parseCanonicalId(candidate.trackId, `${path}.trackId`),
    addedAt: isoDate(candidate.addedAt, `${path}.addedAt`),
  }
}

function parsePlaylist(value: unknown, path: string): LocalPlaylist {
  const candidate = record(value, path)
  exactKeys(candidate, ['id', 'name', 'trackIds', 'createdAt', 'updatedAt'], path)
  const trackIds = array(candidate.trackIds, `${path}.trackIds`, LOCAL_LIBRARY_LIMITS.playlistTracks)
    .map((trackId, index) => parseCanonicalId(trackId, `${path}.trackIds[${index}]`))
  unique(trackIds, `${path}.trackIds`)
  return {
    id: parseCanonicalId(candidate.id, `${path}.id`),
    name: playlistName(candidate.name, `${path}.name`),
    trackIds,
    createdAt: isoDate(candidate.createdAt, `${path}.createdAt`),
    updatedAt: isoDate(candidate.updatedAt, `${path}.updatedAt`),
  }
}

function parseHistory(value: unknown, path: string): RecentHistoryRecord {
  const candidate = record(value, path)
  exactKeys(candidate, ['id', 'trackId', 'playedAt'], path)
  return {
    id: parseHistoryRecordId(candidate.id, `${path}.id`),
    trackId: parseCanonicalId(candidate.trackId, `${path}.trackId`),
    playedAt: isoDate(candidate.playedAt, `${path}.playedAt`),
  }
}

const PREFERENCE_KEYS = [
  'historyEnabled',
  'volume',
  'locale',
  'lowPower',
  'backgroundMode',
  'lastSleepMinutes',
] as const satisfies readonly LibraryPreferenceKey[]

export function parseLibraryPreference(key: string, value: unknown, path = `preferences.${key}`): LibraryPreferences[LibraryPreferenceKey] {
  if (!PREFERENCE_KEYS.includes(key as LibraryPreferenceKey)) fail(path, 'is not an allowed local preference')
  if (key === 'historyEnabled' || key === 'lowPower') {
    if (typeof value !== 'boolean') fail(path, 'must be boolean')
    return value
  }
  if (key === 'volume') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(path, 'must be a finite number from 0 to 1')
    return value
  }
  if (key === 'locale') {
    if (value !== 'zh-Hant' && value !== 'zh-Hans' && value !== 'en') fail(path, 'must be a supported locale')
    return value
  }
  if (key === 'backgroundMode') {
    if (value !== 'ambient' && value !== 'still') fail(path, 'must be ambient or still')
    return value
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_440) {
    fail(path, 'must be a whole number from 1 to 1440')
  }
  return value
}

function parsePreferences(value: unknown, path: string): LibraryPreferences {
  const candidate = record(value, path)
  for (const key of Object.keys(candidate)) {
    if (!PREFERENCE_KEYS.includes(key as LibraryPreferenceKey)) fail(`${path}.${key}`, 'is not allowed')
  }
  if (!('historyEnabled' in candidate)) fail(`${path}.historyEnabled`, 'is required')
  const preferences: LibraryPreferences = {
    historyEnabled: parseLibraryPreference('historyEnabled', candidate.historyEnabled, `${path}.historyEnabled`) as boolean,
  }
  for (const key of PREFERENCE_KEYS) {
    if (key === 'historyEnabled' || !(key in candidate)) continue
    Object.assign(preferences, { [key]: parseLibraryPreference(key, candidate[key], `${path}.${key}`) })
  }
  return preferences
}

export function parseLibraryExport(value: unknown, path = 'library'): LibraryExport {
  const candidate = record(value, path)
  exactKeys(candidate, ['schemaVersion', 'favourites', 'playlists', 'preferences', 'recentHistory'], path)
  if (candidate.schemaVersion !== LOCAL_LIBRARY_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, `must equal ${LOCAL_LIBRARY_SCHEMA_VERSION}`)
  }
  const favourites = array(candidate.favourites, `${path}.favourites`, LOCAL_LIBRARY_LIMITS.favourites)
    .map((favourite, index) => parseFavourite(favourite, `${path}.favourites[${index}]`))
  const playlists = array(candidate.playlists, `${path}.playlists`, LOCAL_LIBRARY_LIMITS.playlists)
    .map((playlist, index) => parsePlaylist(playlist, `${path}.playlists[${index}]`))
  const recentHistory = array(candidate.recentHistory, `${path}.recentHistory`, LOCAL_LIBRARY_LIMITS.recentHistory)
    .map((history, index) => parseHistory(history, `${path}.recentHistory[${index}]`))
  unique(favourites.map(({ trackId }) => trackId), `${path}.favourites`)
  unique(playlists.map(({ id }) => id), `${path}.playlists`)
  unique(recentHistory.map(({ id }) => id), `${path}.recentHistory`)
  return {
    schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
    favourites,
    playlists,
    preferences: parsePreferences(candidate.preferences, `${path}.preferences`),
    recentHistory,
  }
}

export function createEmptyLocalLibrary(): LibraryExport {
  return {
    schemaVersion: LOCAL_LIBRARY_SCHEMA_VERSION,
    favourites: [],
    playlists: [],
    preferences: { historyEnabled: false },
    recentHistory: [],
  }
}
