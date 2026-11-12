import type { D1Database } from '../env'

export const CHKSZ_OWNER_FALLBACK_SETTING = 'provider.chksz.ownerKeyFallback'
export const CHKSZ_USER_KEY_HEADER = 'x-chksz-api-key'

const USER_KEY_MAX_LENGTH = 512

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const readChkszOwnerFallbackEnabled = async (database: D1Database): Promise<boolean> => {
  const row = await database.prepare(`
    SELECT setting_json AS settingJson
    FROM admin_settings
    WHERE setting_key = ?
  `).bind(CHKSZ_OWNER_FALLBACK_SETTING).first<{ settingJson: string }>()
  if (!row) return false
  try {
    const parsed = JSON.parse(row.settingJson) as unknown
    return isRecord(parsed) && parsed.enabled === true && Object.keys(parsed).length === 1
  } catch {
    return false
  }
}

export type ChkszCredentialSelection =
  | { ok: true; apiKey: string; source: 'user' }
  /** `userId` is the signed-in account the owner key is spent for (M-05, decision D4). */
  | { ok: true; apiKey: string; source: 'owner'; userId: string }
  | { ok: false; error: 'credential_required' | 'invalid_credential' | 'chksz_key_required' }

/**
 * Picks the ChKSz credential for one request.
 *
 * - A user key (`x-chksz-api-key`) is always the caller's own and needs no session.
 * - The owner key is spent only when the admin opt-in is on, the key is configured, AND the
 *   request carries a valid session (D4). `Origin` alone is not proof of a browser.
 * - Fallback off or no owner key: `credential_required` (signing in would not help).
 * - Fallback usable but no session: `chksz_key_required`; the client treats it as "next provider".
 */
export const selectChkszCredential = async (
  headers: Headers,
  database: D1Database,
  readOwnerKey: () => string | undefined,
  readSessionUserId: () => Promise<string | null>,
): Promise<ChkszCredentialSelection> => {
  const rawUserKey = headers.get(CHKSZ_USER_KEY_HEADER)
  if (rawUserKey !== null) {
    const apiKey = rawUserKey.trim()
    if (
      apiKey.length === 0 || apiKey.length > USER_KEY_MAX_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(apiKey)
    ) return { ok: false, error: 'invalid_credential' }
    return { ok: true, apiKey, source: 'user' }
  }

  if (!await readChkszOwnerFallbackEnabled(database)) {
    return { ok: false, error: 'credential_required' }
  }
  const ownerKey = readOwnerKey()?.trim()
  if (!ownerKey) return { ok: false, error: 'credential_required' }
  let userId: string | null
  try {
    userId = await readSessionUserId()
  } catch {
    // A failed session lookup fails closed: no owner key without a proven session.
    userId = null
  }
  return userId
    ? { ok: true, apiKey: ownerKey, source: 'owner', userId }
    : { ok: false, error: 'chksz_key_required' }
}
