import type { D1Database, D1WriteValue } from '../env'
import type { GameId, TabId, VocalStatus } from '../../src/features/catalog/types'
import { canonicalId, validDate } from './validation'

/**
 * Admin catalogue browsing and editing.
 *
 * This is deliberately separate from the Google-Sheets proposal pipeline in `adminRoutes.ts`.
 * That pipeline reviews *deltas* pulled from a workbook; it can never browse or correct the
 * published catalogue itself, which left the admin unable to inspect the 3004 tracks the site
 * actually serves. These endpoints read the published rows directly and let an authorised admin
 * edit the same field set the proposal editor exposes (`ALLOWED_STRUCTURAL_FIELDS.track`).
 *
 * `focus` and `vocal_status` are validated independently: a focus track may be instrumental or
 * vocal, and 389 published rows are exactly that.
 */

/** Mirrors `ALLOWED_STRUCTURAL_FIELDS.track` — the metadata the catalogue architecture intends to be editable. */
export const ADMIN_EDITABLE_TRACK_FIELDS = [
  'title',
  'album',
  'release_date',
  'work_group_id',
  'vocal_status',
  'focus',
  'sleep',
  'chill',
  'needs_classification',
  'metadata_confidence',
  'evidence',
  'notes',
] as const
export type AdminEditableTrackField = (typeof ADMIN_EDITABLE_TRACK_FIELDS)[number]

const EDITABLE = new Set<string>(ADMIN_EDITABLE_TRACK_FIELDS)
const VOCAL_STATUSES = new Set<VocalStatus>(['instrumental', 'vocal', 'uncertain'])
const GAME_IDS = new Set<GameId>(['genshin', 'hsr', 'zzz'])
const TAB_IDS: TabId[] = ['focus', 'sleep', 'chill']
const MAX_TITLE = 500
const MAX_FREE_TEXT = 4000
export const MAX_ADMIN_TRACKS = 10001

export interface AdminTrackSummary {
  id: string
  title: string
  album: string | null
  releaseDate: string | null
  workGroupId: string
  vocalStatus: VocalStatus
  tabs: TabId[]
  games: GameId[]
  needsClassification: boolean
  updatedAt: number
}
export interface AdminTrackSource {
  sourceRowId: string
  provider: string
  externalId: string
  sourceType: string
  sourceStatus: string
  rightsStatus: string
  evidence: string | null
  notes: string | null
}
export interface AdminTrackDetail extends AdminTrackSummary {
  metadataConfidence: number | null
  evidence: string | null
  notes: string | null
  relations: string[]
  aliases: Record<string, string[]>
  sources: AdminTrackSource[]
}
export interface AdminCatalogueIndex {
  revision: number
  albums: string[]
  tracks: AdminTrackSummary[]
}
export type AdminTrackChanges = Record<string, string | number | null>
export type AdminTrackEditResult =
  | { ok: true; changes: AdminTrackChanges }
  | { ok: false; errors: string[] }

interface TrackRow {
  track_id: string
  title: string
  album: string | null
  release_date: string | null
  work_group_id: string
  vocal_status: VocalStatus
  focus: number
  sleep: number
  chill: number
  needs_classification: number
  metadata_confidence: number | null
  evidence: string | null
  notes: string | null
  updated_at: number
}
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null

const SUMMARY_COLUMNS =
  'track_id,title,album,release_date,work_group_id,vocal_status,focus,sleep,chill,needs_classification,updated_at'

function summarise(row: TrackRow, games: GameId[]): AdminTrackSummary {
  return {
    id: row.track_id,
    title: row.title,
    album: text(row.album),
    releaseDate: text(row.release_date),
    workGroupId: row.work_group_id,
    vocalStatus: row.vocal_status,
    tabs: TAB_IDS.filter((tab) => row[tab] === 1),
    games,
    needsClassification: row.needs_classification === 1,
    updatedAt: row.updated_at,
  }
}

export async function readAdminCatalogueRevision(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT revision FROM catalogue_state WHERE id=1').first<{
    revision: unknown
  }>()
  const revision = row?.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)
    throw new Error('catalogue_unavailable')
  return revision
}

export async function readAdminCatalogueIndex(db: D1Database): Promise<AdminCatalogueIndex> {
  const results = await db.batch([
    db.prepare('SELECT revision FROM catalogue_state WHERE id=1'),
    db.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM catalogue_tracks ORDER BY title COLLATE NOCASE, track_id LIMIT ${MAX_ADMIN_TRACKS}`,
    ),
    db.prepare('SELECT track_id,game FROM catalogue_track_games ORDER BY track_id,game LIMIT 100001'),
  ])
  if (results.some((r) => !r.success)) throw new Error('catalogue_unavailable')
  const revision = results[0].results[0]?.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)
    throw new Error('catalogue_unavailable')
  const rows = results[1].results as unknown as TrackRow[]
  if (rows.length >= MAX_ADMIN_TRACKS) throw new Error('catalogue_unavailable')

  const gamesByTrack = new Map<string, GameId[]>()
  for (const row of results[2].results as unknown as { track_id: string; game: string }[]) {
    if (!GAME_IDS.has(row.game as GameId)) continue
    const list = gamesByTrack.get(row.track_id) ?? []
    list.push(row.game as GameId)
    gamesByTrack.set(row.track_id, list)
  }

  const albums = new Set<string>()
  const tracks = rows.map((row) => {
    const summary = summarise(row, gamesByTrack.get(row.track_id) ?? [])
    if (summary.album) albums.add(summary.album)
    return summary
  })
  return { revision, albums: [...albums].sort((a, b) => a.localeCompare(b)), tracks }
}

export async function readAdminTrackDetail(
  db: D1Database,
  trackId: string,
): Promise<AdminTrackDetail | null> {
  const results = await db.batch([
    db.prepare(
      `SELECT ${SUMMARY_COLUMNS},metadata_confidence,evidence,notes FROM catalogue_tracks WHERE track_id=?`,
    ).bind(trackId),
    db.prepare('SELECT game FROM catalogue_track_games WHERE track_id=? ORDER BY game').bind(trackId),
    db.prepare(
      'SELECT relation_id FROM catalogue_track_relations WHERE track_id=? ORDER BY relation_id',
    ).bind(trackId),
    db.prepare('SELECT locale,alias FROM catalogue_aliases WHERE track_id=? ORDER BY locale,alias').bind(
      trackId,
    ),
    db.prepare(
      'SELECT source_row_id,provider,external_id,source_type,source_status,rights_status,evidence,notes FROM catalogue_sources WHERE track_id=? ORDER BY provider,external_id',
    ).bind(trackId),
  ])
  const row = results[0].results[0] as unknown as TrackRow | undefined
  if (!row) return null
  const games = (results[1].results as unknown as { game: string }[])
    .map((r) => r.game)
    .filter((game): game is GameId => GAME_IDS.has(game as GameId))
  const relations = (results[2].results as unknown as { relation_id: string }[]).map(
    (r) => r.relation_id,
  )
  const aliases: Record<string, string[]> = {}
  for (const alias of results[3].results as unknown as { locale: string; alias: string }[]) {
    ;(aliases[alias.locale] ??= []).push(alias.alias)
  }
  const sources = (results[4].results as unknown as {
    source_row_id: string
    provider: string
    external_id: string
    source_type: string
    source_status: string
    rights_status: string
    evidence: string | null
    notes: string | null
  }[]).map((s) => ({
    sourceRowId: s.source_row_id,
    provider: s.provider,
    externalId: s.external_id,
    sourceType: s.source_type,
    sourceStatus: s.source_status,
    rightsStatus: s.rights_status,
    evidence: text(s.evidence),
    notes: text(s.notes),
  }))
  return {
    ...summarise(row, games),
    metadataConfidence:
      typeof row.metadata_confidence === 'number' ? row.metadata_confidence : null,
    evidence: text(row.evidence),
    notes: text(row.notes),
    relations,
    aliases,
    sources,
  }
}

/**
 * Validates an admin track edit. Every field is checked on its own; in particular `focus` and
 * `vocal_status` are *not* cross-checked, because they are independent dimensions.
 */
export function validateAdminTrackEdit(input: unknown): AdminTrackEditResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return { ok: false, errors: ['invalid_request'] }
  const record = input as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0) return { ok: false, errors: ['empty_edit'] }
  const errors: string[] = []
  const changes: AdminTrackChanges = {}

  for (const key of keys) {
    if (!EDITABLE.has(key)) {
      errors.push(`unknown_field:${key}`)
      continue
    }
    const value = record[key]
    switch (key) {
      case 'title': {
        if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_TITLE) {
          errors.push('invalid_title')
          break
        }
        changes.title = value.trim()
        break
      }
      case 'album': {
        if (value === null) {
          changes.album = null
          break
        }
        if (typeof value !== 'string' || value.length > MAX_TITLE) {
          errors.push('invalid_album')
          break
        }
        changes.album = text(value)
        break
      }
      case 'release_date': {
        if (value === null || value === '') {
          changes.release_date = null
          break
        }
        if (typeof value !== 'string' || !validDate(value)) {
          errors.push('invalid_release_date')
          break
        }
        changes.release_date = value
        break
      }
      case 'work_group_id': {
        if (typeof value !== 'string' || !canonicalId(value)) {
          errors.push('invalid_work_group_id')
          break
        }
        changes.work_group_id = value
        break
      }
      case 'vocal_status': {
        if (typeof value !== 'string' || !VOCAL_STATUSES.has(value as VocalStatus)) {
          errors.push('invalid_vocal_status')
          break
        }
        changes.vocal_status = value
        break
      }
      case 'focus':
      case 'sleep':
      case 'chill':
      case 'needs_classification': {
        if (typeof value !== 'boolean') {
          errors.push(`invalid_${key}`)
          break
        }
        changes[key] = value ? 1 : 0
        break
      }
      case 'metadata_confidence': {
        if (value === null) {
          changes.metadata_confidence = null
          break
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
          errors.push('invalid_metadata_confidence')
          break
        }
        changes.metadata_confidence = value
        break
      }
      case 'evidence':
      case 'notes': {
        if (value === null) {
          changes[key] = null
          break
        }
        if (typeof value !== 'string' || value.length > MAX_FREE_TEXT) {
          errors.push(`invalid_${key}`)
          break
        }
        changes[key] = text(value)
        break
      }
    }
  }

  if (errors.length) return { ok: false, errors }
  if (Object.keys(changes).length === 0) return { ok: false, errors: ['empty_edit'] }
  return { ok: true, changes }
}

export type AdminTrackWriteResult = { status: 'ok' } | { status: 'stale' }

/**
 * Applies a validated edit and bumps `catalogue_state.revision` in the same D1 batch, so the
 * public catalogue's revision always tracks the rows it serves. A stale `expectedRevision` makes
 * the state guard write 0, which violates `CHECK(revision >= 1)` and aborts the whole batch —
 * including the audit insert — exactly like `publishImportBatch`.
 */
export async function applyAdminTrackEdit(
  db: D1Database,
  trackId: string,
  changes: AdminTrackChanges,
  expectedRevision: number,
  actorId: string,
  now: number,
): Promise<AdminTrackWriteResult> {
  const columns = Object.keys(changes)
  if (columns.length === 0 || columns.some((column) => !EDITABLE.has(column)))
    return { status: 'stale' }
  const values = columns.map((column) => changes[column]) as D1WriteValue[]
  try {
    await db.batch([
      db
        .prepare(
          'UPDATE catalogue_state SET revision=CASE WHEN revision=? AND EXISTS(SELECT 1 FROM catalogue_tracks WHERE track_id=?) THEN revision+1 ELSE 0 END WHERE id=1',
        )
        .bind(expectedRevision, trackId),
      db
        .prepare(
          `UPDATE catalogue_tracks SET ${columns.map((column) => column + '=?').join(',')},revision=revision+1,updated_at=?,published_at=? WHERE track_id=?`,
        )
        .bind(...values, now, now, trackId),
      db
        .prepare(
          "INSERT INTO admin_audit_log(id,actor_user_id,action,target_key,detail_json,created_at) VALUES (?,?,'catalogue.track.update',?,?,?)",
        )
        .bind(crypto.randomUUID(), actorId, trackId, JSON.stringify({ changes }), now),
    ])
    return { status: 'ok' }
  } catch {
    return { status: 'stale' }
  }
}
