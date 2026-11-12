/**
 * Observe-only trace of the account sync pipeline for the debug log. Entries carry enum strings,
 * booleans and integers only: never a user id, e-mail, token, header, ETag value, request or
 * response body, preference value, background id or focus record. A trace write can never throw
 * into, or change the behaviour of, the sync code.
 */
import { playbackLog, shortHash } from '../player/debugLog'

export type SyncErrorClass =
  | `http_${number}` | 'timeout' | 'network' | 'invalid_response' | 'invalid_preferences' | 'account_changed'
  | 'backgrounds_unavailable' | 'backgrounds_quarantined' | 'focus_conflict' | 'storage' | 'other'

export interface ClassifiedSyncError {
  errorClass: SyncErrorClass
  httpStatus: number | null
}

const STATUS = /(?:http_|_)(\d{3})(?:\b|$)/u

/** Maps a thrown value to a fixed class. The message is read only to match known codes, never kept. */
export function classifySyncError(error: unknown): ClassifiedSyncError {
  // DOMException is not an Error in every realm, so read name and message structurally.
  const record = typeof error === 'object' && error !== null ? error as { name?: unknown; message?: unknown } : {}
  const name = typeof record.name === 'string' ? record.name : ''
  const message = typeof record.message === 'string' ? record.message : typeof error === 'string' ? error : ''
  const status = Number(STATUS.exec(message)?.[1])
  if (Number.isInteger(status) && status >= 100 && status <= 599) return { errorClass: `http_${status}`, httpStatus: status }
  if (name === 'TimeoutError' || name === 'AbortError') return { errorClass: 'timeout', httpStatus: null }
  if (/_invalid_response$/u.test(message) || message === 'session_invalid_response') return { errorClass: 'invalid_response', httpStatus: null }
  if (message === 'invalid_synced_user_preferences') return { errorClass: 'invalid_preferences', httpStatus: null }
  if (message === 'account_session_changed' || message === 'focus_session_account_changed') return { errorClass: 'account_changed', httpStatus: null }
  if (message === 'backgrounds_unavailable') return { errorClass: 'backgrounds_unavailable', httpStatus: null }
  if (message === 'backgrounds_quarantined') return { errorClass: 'backgrounds_quarantined', httpStatus: null }
  if (message === 'focus_session_conflict') return { errorClass: 'focus_conflict', httpStatus: null }
  if (name === 'QuotaExceededError' || name === 'SecurityError' || name === 'NotFoundError' || name === 'InvalidStateError') return { errorClass: 'storage', httpStatus: null }
  if (name === 'TypeError') return { errorClass: 'network', httpStatus: null }
  return { errorClass: 'other', httpStatus: null }
}

/** Records `sync.*` into the debug log. `type` is prefixed when it is not already. */
export function traceSync(type: string, fields: Record<string, unknown> = {}): void {
  try {
    playbackLog.record(type.startsWith('sync.') ? type : `sync.${type}`, fields)
  } catch { /* Tracing never affects sync. */ }
}

/** A short, non-reversible tag for correlating entries without recording the account id. */
export const traceUserTag = (userId: string | null): string | null => {
  try { return userId ? shortHash(userId) : null } catch { return null }
}
