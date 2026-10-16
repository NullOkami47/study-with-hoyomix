import type { Database } from '../db'
import {
  FOCUS_SESSION_SCHEMA_VERSION,
  parseFocusSessionRecord,
  type FocusSessionRecord,
} from '../../src/features/focus/types'

export const MAX_FOCUS_SESSIONS_PER_REQUEST = 512

export class FocusSessionConflictError extends Error {
  readonly id: string

  constructor(id: string) {
    super(`Focus session ${id} conflicts with the immutable stored record`)
    this.name = 'FocusSessionConflictError'
    this.id = id
  }
}

export interface FocusMergeResult {
  insertedIds: string[]
  duplicateIds: string[]
}

interface FocusSessionRow {
  id: string
  schemaVersion: number
  startedAt: number
  endedAt: number
  plannedFocusSeconds: number
  actualFocusSeconds: number
  status: string
  phase: string
  createdAt: number
}

const SELECT_COLUMNS = `
  id, schema_version AS schemaVersion, started_at AS startedAt, ended_at AS endedAt,
  planned_focus_seconds AS plannedFocusSeconds, actual_focus_seconds AS actualFocusSeconds,
  status, phase, created_at AS createdAt
`

function rowToRecord(row: FocusSessionRow, path: string): FocusSessionRecord {
  return parseFocusSessionRecord({
    id: row.id,
    schemaVersion: row.schemaVersion,
    startedAt: new Date(row.startedAt).toISOString(),
    endedAt: new Date(row.endedAt).toISOString(),
    plannedFocusSeconds: row.plannedFocusSeconds,
    actualFocusSeconds: row.actualFocusSeconds,
    status: row.status,
    phase: row.phase,
    createdAt: new Date(row.createdAt).toISOString(),
  }, path)
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

export async function readFocusSessions(
  database: Database,
  userId: string,
): Promise<FocusSessionRecord[]> {
  const rows = await database.prepare(`
    SELECT ${SELECT_COLUMNS} FROM focus_sessions
    WHERE user_id = ? ORDER BY ended_at, id
  `).bind(userId).all<FocusSessionRow>()
  return rows.results.map((row, index) => rowToRecord(row, `focusSessions[${index}]`))
}

/** Immutable IDs make a stable, account-scoped keyset without an offset scan. */
export async function readFocusSessionsPage(
  database: Database,
  userId: string,
  limit: number,
  after = '',
): Promise<{ sessions: FocusSessionRecord[]; nextCursor: string | null }> {
  const rows = await database.prepare(`
    SELECT ${SELECT_COLUMNS} FROM focus_sessions
    WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?
  `).bind(userId, after, limit + 1).all<FocusSessionRow>()
  const sessions = rows.results.slice(0, limit)
    .map((row, index) => rowToRecord(row, `focusSessions[${index}]`))
  return { sessions, nextCursor: rows.results.length > limit ? sessions.at(-1)!.id : null }
}

/**
 * Merges immutable focus sessions by session ID. An exact duplicate is a safe no-op; a
 * divergent record sharing an ID is a conflict that never overwrites the stored truth.
 * Nothing is written unless every supplied record is acceptable.
 */
export async function mergeFocusSessions(
  database: Database,
  userId: string,
  sessions: readonly FocusSessionRecord[],
): Promise<FocusMergeResult> {
  return mergeFocusSessionsAttempt(database, userId, sessions, 2)
}

async function mergeFocusSessionsAttempt(
  database: Database,
  userId: string,
  sessions: readonly FocusSessionRecord[],
  retries: number,
): Promise<FocusMergeResult> {
  const unique = new Map<string, FocusSessionRecord>()
  for (const session of sessions) {
    const existing = unique.get(session.id)
    if (!existing) {
      unique.set(session.id, session)
      continue
    }
    if (!recordsEqual(existing, session)) throw new FocusSessionConflictError(session.id)
  }
  if (unique.size === 0) return { insertedIds: [], duplicateIds: [] }

  const stored = new Map<string, FocusSessionRecord>()
  for (const record of await readFocusSessions(database, userId)) stored.set(record.id, record)

  const insertedIds: string[] = []
  const duplicateIds: string[] = []
  const statements = []
  for (const session of unique.values()) {
    const existing = stored.get(session.id)
    if (existing) {
      if (!recordsEqual(existing, session)) throw new FocusSessionConflictError(session.id)
      duplicateIds.push(session.id)
      continue
    }
    insertedIds.push(session.id)
    statements.push(database.prepare(`
      INSERT INTO focus_sessions (
        user_id, id, schema_version, started_at, ended_at,
        planned_focus_seconds, actual_focus_seconds, status, phase, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId,
      session.id,
      FOCUS_SESSION_SCHEMA_VERSION,
      Date.parse(session.startedAt),
      Date.parse(session.endedAt),
      session.plannedFocusSeconds,
      session.actualFocusSeconds,
      session.status,
      session.phase,
      Date.parse(session.createdAt),
    ))
  }
  if (statements.length > 0) {
    try {
      await database.batch(statements)
    } catch (error) {
      // Another device may insert the same immutable ID after the read above.
      // D1 rolls back the failed batch; re-read and compare before a bounded retry.
      // Other failures (including quota errors) must propagate without retries.
      if (retries > 0 && error instanceof Error &&
        /UNIQUE constraint failed: focus_sessions\.user_id, focus_sessions\.id/u.test(error.message)) {
        return mergeFocusSessionsAttempt(database, userId, sessions, retries - 1)
      }
      throw error
    }
  }
  return { insertedIds, duplicateIds }
}
