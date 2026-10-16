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

export function createAccountPreferencesHandler(env: AccountPreferencesEnv) {
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
          return json({ preferences: row ? project(parseSyncedUserPreferences(JSON.parse(row.preferencesJson))) : null }, 200, row ? String(row.updatedAt) : "absent")
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
        const expected = request.headers.get('if-match')
        if (expected !== null && expected !== 'absent' && !/^\d{1,16}$/.test(expected)) return json({ error: 'invalid_revision' }, 400)
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
        if (!result) return json({ error: 'account_preferences_conflict' }, 409)
        return json({ preferences: project(preferences) }, 200, String(result.updatedAt))
      } catch {
        return json({ error: 'account_preferences_unavailable' }, 500)
      }
    },
  }
}
