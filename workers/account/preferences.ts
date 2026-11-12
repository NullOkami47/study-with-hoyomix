import type { Env } from '../env'
import { findSession, readCookie, SESSION_COOKIE } from '../auth/session'
import { readBoundedJsonRequest } from '../providers/boundedJson'
import { parseSyncedUserPreferences, type SyncedUserPreferences } from '../../src/features/account/syncPreferences'

export interface AccountPreferencesEnv extends Env {
  PUBLIC_ORIGIN: string
  SESSION_HMAC_SECRET: string
}

const json = (value: unknown, status = 200, etag?: string) => Response.json(value, {
  status,
  headers: { 'cache-control': 'no-store', ...(etag ? { etag } : {}) },
})

/**
 * L-24 (D9): the strict precondition rules, `428 precondition_required` for a PUT without
 * If-Match and `412` for a stale one, wait for a release after every client sends If-Match.
 * Until then a missing If-Match is an unconditional write and a stale one stays `409`, which
 * cached (prompt-mode PWA) clients already retry as a conflict. Keep this `false` in this release.
 */
export const REQUIRE_PREFERENCES_IF_MATCH = false

/** The row-less state has its own entity tag; a revision is the row's `updated_at`. */
const ABSENT = 'absent'
/** A quoted strong entity tag (RFC 9110 section 8.8.3). */
const entityTag = (revision: number | typeof ABSENT) => `"${revision}"`
/**
 * Parses If-Match. Quoted strong tags are the format this Worker sends; bare values are what
 * older Workers sent and what clients cached from them, so both are accepted. Cloudflare weakens
 * a strong ETag to `W/"<n>"` on compressed responses and clients echo what they received, so a
 * weak tag is accepted too: it is compared by its revision exactly like the strong form (If-Match
 * on a state-changing request is stricter than weak comparison, but the tag value is the same row
 * version, and a stale value still fails the revision check). Lists and `*` stay invalid.
 */
const parseIfMatch = (header: string | null): string | null | undefined => {
  if (header === null) return null
  const match = /^(?:(?:W\/)?"(absent|\d{1,16})"|(absent|\d{1,16}))$/u.exec(header.trim())
  return match ? (match[1] ?? match[2]) : undefined
}

export interface AccountPreferencesOptions {
  /** Defaults to REQUIRE_PREFERENCES_IF_MATCH; tests turn it on to check the later release. */
  requireIfMatch?: boolean
}

export function createAccountPreferencesHandler(
  env: AccountPreferencesEnv,
  { requireIfMatch = REQUIRE_PREFERENCES_IF_MATCH }: AccountPreferencesOptions = {},
) {
  return {
    async fetch(request: Request): Promise<Response> {
      const method = request.method
      if (method !== 'GET' && method !== 'PUT') return json({ error: 'method_not_allowed' }, 405)
      if (method === 'PUT' && request.headers.get('origin') !== new URL(env.PUBLIC_ORIGIN).origin) {
        return json({ error: 'forbidden_origin' }, 403)
      }
      const userId = (await findSession(env.DB, readCookie(request, SESSION_COOKIE),
        env.SESSION_HMAC_SECRET, Date.now(), crypto))?.userId
      if (!userId) return json({ error: 'authentication_required' }, 401)
      const expectedUserId = request.headers.get('x-account-user-id')
      if (expectedUserId !== null && expectedUserId !== userId) {
        return json({ error: 'account_session_changed' }, 409)
      }
      // Prompt-mode PWA updates can leave a v1 page using the current Worker.
      // The retired value is a false wire shim only; it is never stored again.
      const schema = request.headers.get('x-account-preferences-schema')
      if (schema !== null && schema !== '2') return json({ error: 'unsupported_preferences_schema' }, 400)
      const legacy = schema === null
      const project = (value: SyncedUserPreferences) => {
        if (!legacy) return value
        const { backgroundPlaybackMode, backgroundQualityMode, ...base } = value
        return { ...base, lowPower: false }
      }
      if (method === 'GET') {
        try {
          const row = await env.DB.prepare(
            'SELECT preferences_json AS preferencesJson, updated_at AS updatedAt FROM user_ui_preferences WHERE user_id = ?',
          ).bind(userId).first<{ preferencesJson: string; updatedAt: number }>()
          return json({ preferences: row ? project(parseSyncedUserPreferences(JSON.parse(row.preferencesJson))) : null }, 200, entityTag(row ? row.updatedAt : ABSENT))
        } catch {
          return json({ error: 'account_preferences_unavailable' }, 500)
        }
      }
      let preferences
      try {
        const payload: unknown = await readBoundedJsonRequest(request, 4096)
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).length !== 1 ||
          !Object.prototype.hasOwnProperty.call(payload, 'preferences')) {
          return json({ error: 'invalid_account_preferences' }, 400)
        }
        preferences = parseSyncedUserPreferences((payload as { preferences: unknown }).preferences)
        const supplied = (payload as { preferences: Record<string, unknown> }).preferences
        if (legacy && (Object.keys(supplied).length !== 9 || typeof supplied.lowPower !== 'boolean')) {
          return json({ error: 'invalid_account_preferences' }, 400)
        }
      } catch {
        return json({ error: 'invalid_account_preferences' }, 400)
      }
      try {
        const expected = parseIfMatch(request.headers.get('if-match'))
        if (expected === undefined) return json({ error: 'invalid_revision' }, 400)
        if (expected === null && requireIfMatch) return json({ error: 'precondition_required' }, 428)
        const nextRevision = Math.max(Date.now(), Number(expected === 'absent' ? 0 : expected) + 1)
        const result = await env.DB.prepare(`
          INSERT INTO user_ui_preferences (user_id, preferences_json, updated_at)
          SELECT ?, ?, ?
          WHERE ? IS NULL OR ? = 'absent' OR EXISTS (
            SELECT 1 FROM user_ui_preferences WHERE user_id = ? AND updated_at = CAST(? AS INTEGER)
          )
          ON CONFLICT(user_id) DO UPDATE SET
            preferences_json = CASE WHEN ? THEN
              json_patch(json_patch(excluded.preferences_json,
                CASE WHEN json_type(user_ui_preferences.preferences_json, '$.backgroundPlaybackMode') IS NULL THEN '{}'
                ELSE json_object('backgroundPlaybackMode', json_extract(user_ui_preferences.preferences_json, '$.backgroundPlaybackMode')) END),
                CASE WHEN json_type(user_ui_preferences.preferences_json, '$.backgroundQualityMode') IS NULL THEN '{}'
                ELSE json_object('backgroundQualityMode', json_extract(user_ui_preferences.preferences_json, '$.backgroundQualityMode')) END)
              ELSE excluded.preferences_json END,
            updated_at = MAX(excluded.updated_at, user_ui_preferences.updated_at + 1)
          WHERE ? IS NULL OR (? <> 'absent' AND user_ui_preferences.updated_at = CAST(? AS INTEGER))
          RETURNING updated_at AS updatedAt
        `).bind(userId, JSON.stringify(preferences), nextRevision, expected, expected, userId, expected, legacy ? 1 : 0, expected, expected, expected).first<{ updatedAt: number }>()
        if (!result) return json({ error: 'account_preferences_conflict' }, requireIfMatch ? 412 : 409)
        return json({ preferences: project(preferences) }, 200, entityTag(result.updatedAt))
      } catch {
        return json({ error: 'account_preferences_unavailable' }, 500)
      }
    },
  }
}
