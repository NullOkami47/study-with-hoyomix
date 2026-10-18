import type { Database } from '../db'
import { parseSyncedUserPreferences } from '../../src/features/account/syncPreferences'
import { BACKGROUND_INTERVAL_VALUES } from '../../src/features/backgrounds/types'
import { readFocusSessions } from '../focus/repository'
import { readUserProviderPreferences } from '../providers/preferences'
import { previewLibraryMerge } from '../../src/features/library/localRepository'
import {
  createEmptyLocalLibrary,
  parseLibraryExport,
  type LibraryExport,
  type MergePreview,
  type RecentHistoryRecord,
} from '../../src/features/library/types'

export class LibraryOwnershipError extends Error {
  constructor(readonly resource: 'history' | 'playlist') {
    super(`${resource}_owned_by_another_account`)
    this.name = 'LibraryOwnershipError'
  }
}

class LibraryRevisionConflict extends Error {
  constructor() {
    super('library_revision_conflict')
    this.name = 'LibraryRevisionConflict'
  }
}

interface FavouriteRow { trackId: string; createdAt: number }
interface PlaylistRow { id: string; name: string; createdAt: number; updatedAt: number }
interface PlaylistTrackRow { playlistId: string; trackId: string; position: number }
interface HistoryRow { id: string; trackId: string; playedAt: number }
interface ReportRow {
  id: string
  canonicalTrackId: string
  kind: string
  currentValueJson: string
  proposedValueJson: string
  note: string | null
  status: string
  createdAt: number
  updatedAt: number
}

const iso = (value: number) => new Date(value).toISOString()

export async function readLibrary(database: Database, userId: string): Promise<LibraryExport> {
  const [favourites, playlists, tracks, history, user] = await Promise.all([
    database.prepare(`
      SELECT track_id AS trackId, created_at AS createdAt
      FROM favourites WHERE user_id = ? ORDER BY created_at, track_id
    `).bind(userId).all<FavouriteRow>(),
    database.prepare(`
      SELECT id, name, created_at AS createdAt, updated_at AS updatedAt
      FROM playlists WHERE user_id = ? AND visibility = 'private'
      ORDER BY created_at, id
    `).bind(userId).all<PlaylistRow>(),
    database.prepare(`
      SELECT playlist_tracks.playlist_id AS playlistId, playlist_tracks.track_id AS trackId,
        playlist_tracks.position
      FROM playlist_tracks
      JOIN playlists ON playlists.id = playlist_tracks.playlist_id
      WHERE playlists.user_id = ? AND playlists.visibility = 'private'
      ORDER BY playlist_tracks.playlist_id, playlist_tracks.position
    `).bind(userId).all<PlaylistTrackRow>(),
    database.prepare(`
      SELECT id, track_id AS trackId, played_at AS playedAt
      FROM listening_history WHERE user_id = ?
      ORDER BY played_at DESC, id DESC LIMIT 100
    `).bind(userId).all<HistoryRow>(),
    database.prepare('SELECT settings_json AS settingsJson FROM users WHERE id = ? AND deleted_at IS NULL')
      .bind(userId).first<{ settingsJson: string }>(),
  ])
  if (!user) throw new Error('account_not_found')
  const tracksByPlaylist = new Map<string, string[]>()
  for (const track of tracks.results) {
    const values = tracksByPlaylist.get(track.playlistId) ?? []
    values.push(track.trackId)
    tracksByPlaylist.set(track.playlistId, values)
  }
  const persistedPreferences = JSON.parse(user.settingsJson) as unknown
  const preferences = persistedPreferences && typeof persistedPreferences === 'object' && !Array.isArray(persistedPreferences)
    ? { historyEnabled: false, ...persistedPreferences }
    : persistedPreferences
  return parseLibraryExport({
    schemaVersion: 2,
    favourites: favourites.results.map((value) => ({ trackId: value.trackId, addedAt: iso(value.createdAt) })),
    playlists: playlists.results.map((value) => ({
      id: value.id,
      name: value.name,
      trackIds: tracksByPlaylist.get(value.id) ?? [],
      createdAt: iso(value.createdAt),
      updatedAt: iso(value.updatedAt),
    })),
    preferences,
    recentHistory: history.results.map((value) => ({ id: value.id, trackId: value.trackId, playedAt: iso(value.playedAt) })),
  }, 'persistedLibrary')
}

async function assertOwnedIds(
  database: Database,
  table: 'listening_history' | 'playlists',
  ids: readonly string[],
  userId: string,
): Promise<void> {
  for (const id of ids) {
    const owner = await database.prepare(`
      SELECT user_id AS userId${table === 'playlists' ? ', visibility' : ''} FROM ${table} WHERE id = ?
    `).bind(id).first<{ userId: string; visibility?: string }>()
    if (owner && owner.userId !== userId) {
      throw new LibraryOwnershipError(table === 'playlists' ? 'playlist' : 'history')
    }
    if (table === 'playlists' && owner && owner.visibility !== 'private') throw new LibraryOwnershipError('playlist')
  }
}

async function ensureSyncState(database: Database, userId: string): Promise<void> {
  await database.prepare('INSERT OR IGNORE INTO library_sync_state (user_id, revision) VALUES (?, 0)')
    .bind(userId).run()
}

async function currentRevision(database: Database, userId: string): Promise<number> {
  await ensureSyncState(database, userId)
  const revision = await database.prepare('SELECT revision FROM library_sync_state WHERE user_id = ?')
    .bind(userId).first<number>('revision')
  if (revision === null) throw new Error('account_not_found')
  return revision
}

async function readVersionedLibrary(database: Database, userId: string): Promise<{ library: LibraryExport; revision: number }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await currentRevision(database, userId)
    const library = await readLibrary(database, userId)
    const after = await currentRevision(database, userId)
    if (before === after) return { library, revision: before }
  }
  throw new LibraryRevisionConflict()
}

async function replaceLibraryAtRevision(
  database: Database,
  userId: string,
  value: unknown,
  expectedRevision: number,
): Promise<LibraryExport> {
  const library = parseLibraryExport(value)
  await assertOwnedIds(database, 'playlists', library.playlists.map(({ id }) => id), userId)
  await assertOwnedIds(database, 'listening_history', library.recentHistory.map(({ id }) => id), userId)

  const favourites = library.favourites.map(({ trackId, addedAt }) => ({ trackId, createdAt: Date.parse(addedAt) }))
  const playlists = library.playlists.map(({ id, name, createdAt, updatedAt }) => ({
    id, name, createdAt: Date.parse(createdAt), updatedAt: Date.parse(updatedAt),
  }))
  const playlistTracks = library.playlists.flatMap(({ id, trackIds, updatedAt }) =>
    trackIds.map((trackId, position) => ({ playlistId: id, trackId, position, addedAt: Date.parse(updatedAt) })))
  const history = library.recentHistory.map(({ id, trackId, playedAt }) => ({ id, trackId, playedAt: Date.parse(playedAt) }))

  const revisionExists = `EXISTS (
    SELECT 1 FROM library_sync_state WHERE user_id = ? AND revision = ?
  )`
  const results = await database.batch([
    database.prepare(`
      DELETE FROM playlist_tracks
      WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ? AND visibility = 'private')
        AND ${revisionExists}
    `).bind(userId, userId, expectedRevision),
    database.prepare(`
      DELETE FROM playlists WHERE user_id = ? AND visibility = 'private' AND ${revisionExists}
    `).bind(userId, userId, expectedRevision),
    database.prepare(`DELETE FROM favourites WHERE user_id = ? AND ${revisionExists}`)
      .bind(userId, userId, expectedRevision),
    database.prepare(`DELETE FROM listening_history WHERE user_id = ? AND ${revisionExists}`)
      .bind(userId, userId, expectedRevision),
    database.prepare(`
      UPDATE users SET settings_json = ? WHERE id = ? AND deleted_at IS NULL AND ${revisionExists}
    `).bind(JSON.stringify(library.preferences), userId, userId, expectedRevision),
    database.prepare(`
      INSERT INTO favourites (user_id, track_id, created_at)
      SELECT ?, json_extract(value, '$.trackId'), json_extract(value, '$.createdAt')
      FROM json_each(?) WHERE ${revisionExists}
    `).bind(userId, JSON.stringify(favourites), userId, expectedRevision),
    database.prepare(`
      INSERT INTO playlists (id, user_id, name, visibility, created_at, updated_at)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.name'), 'private',
        json_extract(value, '$.createdAt'), json_extract(value, '$.updatedAt')
      FROM json_each(?) WHERE ${revisionExists}
    `).bind(userId, JSON.stringify(playlists), userId, expectedRevision),
    database.prepare(`
      INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
      SELECT json_extract(value, '$.playlistId'), json_extract(value, '$.trackId'),
        json_extract(value, '$.position'), json_extract(value, '$.addedAt')
      FROM json_each(?) WHERE ${revisionExists}
    `).bind(JSON.stringify(playlistTracks), userId, expectedRevision),
    database.prepare(`
      INSERT INTO listening_history (id, user_id, track_id, played_at)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.trackId'),
        json_extract(value, '$.playedAt') FROM json_each(?) WHERE ${revisionExists}
    `).bind(userId, JSON.stringify(history), userId, expectedRevision),
    database.prepare(`
      UPDATE library_sync_state SET revision = revision + 1 WHERE user_id = ? AND revision = ?
    `).bind(userId, expectedRevision),
  ])
  if (results.at(-1)?.meta.changes !== 1) throw new LibraryRevisionConflict()
  return readLibrary(database, userId)
}

export async function replaceLibrary(database: Database, userId: string, value: unknown): Promise<LibraryExport> {
  return replaceLibraryAtRevision(database, userId, value, await currentRevision(database, userId))
}

const encoder = new TextEncoder()
const toHex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')

async function confirmationToken(
  userId: string,
  local: LibraryExport,
  remote: LibraryExport,
  revision: number,
  cryptoApi: Crypto,
): Promise<string> {
  const digest = await cryptoApi.subtle.digest('SHA-256', encoder.encode(JSON.stringify({ userId, local, remote, revision })))
  return `sha256:${toHex(digest)}`
}

export interface LibraryMergeEnvelope {
  confirmationToken: string
  preview: MergePreview
}

function normalisePersistedOrder(library: LibraryExport): LibraryExport {
  return parseLibraryExport({
    ...library,
    favourites: [...library.favourites].sort((left, right) =>
      left.addedAt.localeCompare(right.addedAt) || left.trackId.localeCompare(right.trackId)),
    playlists: [...library.playlists].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
    recentHistory: [...library.recentHistory].sort((left, right) =>
      right.playedAt.localeCompare(left.playedAt) || right.id.localeCompare(left.id)),
  }, 'mergedLibrary')
}

export async function previewRemoteMerge(
  database: Database,
  userId: string,
  localValue: unknown,
  cryptoApi: Crypto,
): Promise<LibraryMergeEnvelope> {
  return (await previewRemoteMergeState(database, userId, localValue, cryptoApi)).envelope
}

async function previewRemoteMergeState(
  database: Database,
  userId: string,
  localValue: unknown,
  cryptoApi: Crypto,
): Promise<{ envelope: LibraryMergeEnvelope; revision: number }> {
  const local = parseLibraryExport(localValue, 'localLibrary')
  const { library: remote, revision } = await readVersionedLibrary(database, userId)
  await assertOwnedIds(database, 'playlists', local.playlists.map(({ id }) => id), userId)
  await assertOwnedIds(database, 'listening_history', local.recentHistory.map(({ id }) => id), userId)
  const preview = previewLibraryMerge(local, remote)
  preview.merged = normalisePersistedOrder(preview.merged)
  return { revision, envelope: {
    confirmationToken: await confirmationToken(userId, local, remote, revision, cryptoApi),
    preview,
  } }
}

export async function confirmRemoteMerge(
  database: Database,
  userId: string,
  localValue: unknown,
  suppliedToken: string,
  cryptoApi: Crypto,
): Promise<LibraryExport | null> {
  const state = await previewRemoteMergeState(database, userId, localValue, cryptoApi)
  if (state.envelope.confirmationToken !== suppliedToken) return null
  try {
    return await replaceLibraryAtRevision(database, userId, state.envelope.preview.merged, state.revision)
  } catch (error) {
    if (error instanceof LibraryRevisionConflict) return null
    throw error
  }
}

export async function recordHistory(
  database: Database,
  userId: string,
  value: unknown,
): Promise<RecentHistoryRecord[]> {
  const library = parseLibraryExport({ ...createEmptyLocalLibrary(), recentHistory: [value] }, 'historyRequest')
  const record = library.recentHistory[0]!
  await assertOwnedIds(database, 'listening_history', [record.id], userId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = await currentRevision(database, userId)
    const results = await database.batch([
      database.prepare(`
        INSERT INTO listening_history (id, user_id, track_id, played_at)
        SELECT ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM library_sync_state WHERE user_id = ? AND revision = ?
        )
        ON CONFLICT(id) DO UPDATE SET track_id = excluded.track_id, played_at = excluded.played_at
        WHERE listening_history.user_id = excluded.user_id
      `).bind(record.id, userId, record.trackId, Date.parse(record.playedAt), userId, revision),
      database.prepare(`
        DELETE FROM listening_history WHERE user_id = ? AND id NOT IN (
          SELECT id FROM listening_history WHERE user_id = ? ORDER BY played_at DESC, id DESC LIMIT 100
        ) AND EXISTS (
          SELECT 1 FROM library_sync_state WHERE user_id = ? AND revision = ?
        )
      `).bind(userId, userId, userId, revision),
      database.prepare(`
        UPDATE library_sync_state SET revision = revision + 1 WHERE user_id = ? AND revision = ?
      `).bind(userId, revision),
    ])
    if (results.at(-1)?.meta.changes === 1) return (await readLibrary(database, userId)).recentHistory
  }
  throw new LibraryRevisionConflict()
}

export async function clearHistory(database: Database, userId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = await currentRevision(database, userId)
    const results = await database.batch([
      database.prepare(`
        DELETE FROM listening_history WHERE user_id = ? AND EXISTS (
          SELECT 1 FROM library_sync_state WHERE user_id = ? AND revision = ?
        )
      `).bind(userId, userId, revision),
      database.prepare(`
        UPDATE library_sync_state SET revision = revision + 1 WHERE user_id = ? AND revision = ?
      `).bind(userId, revision),
    ])
    if (results.at(-1)?.meta.changes === 1) return
  }
  throw new LibraryRevisionConflict()
}

export async function exportAccountData(database: Database, userId: string) {
  const library = await readLibrary(database, userId)
  const focusSessions = await readFocusSessions(database, userId)
  const providerPreferences = await readUserProviderPreferences(database, userId)
  const uiPreferences = await database.prepare(`
    SELECT preferences_json AS preferencesJson FROM user_ui_preferences WHERE user_id = ?
  `).bind(userId).first<{ preferencesJson: string }>()
  const background = await database.prepare(`
    SELECT selection_json AS selectionJson, auto_rotate AS autoRotate,
      interval_seconds AS intervalSeconds
    FROM user_background_selections WHERE user_id = ?
  `).bind(userId).first<{ selectionJson: string; autoRotate: number; intervalSeconds: number }>()
  const selectedIds: unknown = background ? JSON.parse(background.selectionJson) : null
  if (background && (!Array.isArray(selectedIds) || selectedIds.length > 8 ||
    !selectedIds.every(id => typeof id === 'string') ||
    ![0, 1].includes(background.autoRotate) ||
    !(BACKGROUND_INTERVAL_VALUES as readonly number[]).includes(background.intervalSeconds))) {
    throw new Error('invalid_background_selection')
  }
  const reports = await database.prepare(`
    SELECT id, canonical_track_id AS canonicalTrackId, kind, current_value_json AS currentValueJson,
      proposed_value_json AS proposedValueJson, note, status, created_at AS createdAt, updated_at AS updatedAt
    FROM catalog_reports WHERE reporter_user_id = ? ORDER BY created_at, id
  `).bind(userId).all<ReportRow>()
  return {
    schemaVersion: 1,
    favourites: library.favourites,
    focusSessions,
    playlists: library.playlists,
    preferences: library.preferences,
    providerPreferences,
    userUiPreferences: uiPreferences
      ? parseSyncedUserPreferences(JSON.parse(uiPreferences.preferencesJson))
      : null,
    backgroundSelection: background ? {
      selectedIds,
      autoRotate: background.autoRotate === 1,
      intervalSeconds: background.intervalSeconds,
    } : null,
    reports: reports.results.map((report) => ({
      id: report.id,
      canonicalTrackId: report.canonicalTrackId,
      kind: report.kind,
      currentValue: JSON.parse(report.currentValueJson) as unknown,
      proposedValue: JSON.parse(report.proposedValueJson) as unknown,
      note: report.note,
      status: report.status,
      createdAt: iso(report.createdAt),
      updatedAt: iso(report.updatedAt),
    })),
  }
}

export interface AvatarDeletionEvent {
  type: 'avatar.delete'
  userId: string
  objectKey: string
}

export async function deleteAccount(
  database: Database,
  userId: string,
  now: number,
  eventId: string,
): Promise<AvatarDeletionEvent | null> {
  const user = await database.prepare('SELECT avatar_url AS avatarUrl FROM users WHERE id = ? AND deleted_at IS NULL')
    .bind(userId).first<{ avatarUrl: string | null }>()
  if (!user) throw new Error('account_not_found')
  const objectKey = user.avatarUrl?.startsWith(`avatars/${userId}/`) ? user.avatarUrl : null
  const statements = [
    database.prepare(`
      UPDATE catalog_reports SET status = 'withdrawn', updated_at = ?
      WHERE reporter_user_id = ? AND status = 'pending'
    `).bind(now, userId),
    database.prepare(`
      UPDATE chat_reports SET status = 'withdrawn'
      WHERE reporter_user_id = ? AND status = 'pending'
    `).bind(userId),
    database.prepare(`
      DELETE FROM chat_message_versions
      WHERE message_id IN (SELECT id FROM chat_messages WHERE user_id = ?)
    `).bind(userId),
    database.prepare(`
      UPDATE moderation_actions SET reason = NULL
      WHERE target_user_id = ? OR actor_user_id = ?
        OR target_message_id IN (SELECT id FROM chat_messages WHERE user_id = ?)
    `).bind(userId, userId, userId),
    database.prepare(`
      UPDATE chat_reports SET reason = 'Report retained after account deletion', resolution_note = NULL
      WHERE reporter_user_id = ?
        OR message_id IN (SELECT id FROM chat_messages WHERE user_id = ?)
    `).bind(userId, userId),
    database.prepare(`
      UPDATE chat_messages SET user_id = NULL, author_display_name = 'Deleted user', coarse_location = NULL
      WHERE user_id = ?
    `).bind(userId),
  ]
  if (objectKey) {
    statements.push(database.prepare(`
      INSERT INTO account_deletion_events (id, user_id, event_type, object_key, created_at)
      VALUES (?, ?, 'avatar.delete', ?, ?)
    `).bind(eventId, userId, objectKey, now))
  }
  statements.push(database.prepare('DELETE FROM users WHERE id = ?').bind(userId))
  await database.batch(statements)
  return objectKey ? { type: 'avatar.delete', userId, objectKey } : null
}

export async function markAvatarDeletionProcessed(database: Database, eventId: string, processedAt: number): Promise<void> {
  await database.prepare(`
    UPDATE account_deletion_events SET processed_at = ? WHERE id = ? AND processed_at IS NULL
  `).bind(processedAt, eventId).run()
}
