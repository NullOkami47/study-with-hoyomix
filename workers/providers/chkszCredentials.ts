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

type ChkszCredentialSelection =
  | { ok: true; apiKey: string; source: 'user' | 'owner' }
  | { ok: false; error: 'credential_required' | 'invalid_credential' }

export const selectChkszCredential = async (
  headers: Headers,
  database: D1Database,
  readOwnerKey: () => string | undefined,
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
  return ownerKey
    ? { ok: true, apiKey: ownerKey, source: 'owner' }
    : { ok: false, error: 'credential_required' }
}
