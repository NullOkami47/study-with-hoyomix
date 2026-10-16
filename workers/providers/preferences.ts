import type { Database } from '../db'
import { readBoundedJsonRequest } from './boundedJson'
import type { Env } from '../env'
import { findSession, readCookie, SESSION_COOKIE } from '../auth/session'

export type UserToggleableProviderId = 'chksz' | 'lx' | 'jellyfin'

/**
 * Canonical, ordered set of providers a user may disable for themselves.
 * Normal automatic providers are chksz, lx, and jellyfin.
 */
export const USER_TOGGLEABLE_PROVIDER_IDS: readonly UserToggleableProviderId[] =
  Object.freeze(['chksz', 'lx', 'jellyfin'] as const)

export const LEGACY_LX_IDS = [
  'lx-huibq',
  'lx-ikun',
  'lx-juhe',
  'lx-qdy',
  'lx-flower',
  'lx-lx',
  'lx-grass',
  'lx-sixyin',
] as const

const TOGGLEABLE_IDS = new Set<string>(USER_TOGGLEABLE_PROVIDER_IDS)
const CANONICAL_ORDER = new Map<string, number>(
  USER_TOGGLEABLE_PROVIDER_IDS.map((id, index) => [id, index]),
)
const MAX_REQUEST_BYTES = 4 * 1024

export interface UserProviderPreferences {
  disabledProviderIds: UserToggleableProviderId[]
}

export interface ProviderPreferencesEnv extends Env {
  PUBLIC_ORIGIN: string
  SESSION_HMAC_SECRET: string
}

export interface ProviderPreferencesRouteOptions {
  now?: () => number
  crypto?: Crypto
}

class ProviderPreferencesValidationError extends Error {
  constructor() {
    super('invalid_provider_preferences')
    this.name = 'ProviderPreferencesValidationError'
  }
}

const json = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { 'cache-control': 'no-store' },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const inCanonicalOrder = (
  ids: readonly UserToggleableProviderId[],
): UserToggleableProviderId[] =>
  [...ids].sort((left, right) =>
    (CANONICAL_ORDER.get(left) ?? 0) - (CANONICAL_ORDER.get(right) ?? 0))

/**
 * Pure helper to migrate legacy disabled provider IDs to the three-provider model:
 * 1. Old chksz disabled -> new chksz disabled.
 * 2. All 8 old LX IDs disabled -> new lx disabled.
 * 3. If not all 8 old LX IDs disabled -> new lx remains enabled.
 * 4. Jellyfin absent -> remains enabled (not disabled).
 * 5. Obsolete IDs (r2, meting, piped, invidious, gd-studio, qijie, etc.) -> dropped.
 * 6. Idempotent: migrating an already migrated array leaves it unchanged.
 */
export function migrateLegacyDisabledProviderIds(
  ids: readonly string[],
): UserToggleableProviderId[] {
  const set = new Set(ids)
  const result: UserToggleableProviderId[] = []

  if (set.has('chksz')) {
    result.push('chksz')
  }

  const allLegacyLxDisabled = LEGACY_LX_IDS.every((id) => set.has(id))
  if (set.has('lx') || allLegacyLxDisabled) {
    result.push('lx')
  }

  if (set.has('jellyfin')) {
    result.push('jellyfin')
  }

  return inCanonicalOrder(result)
}

/**
 * Accepts only `{"disabledProviderIds":[<canonical id>, ...]}` with no
 * duplicates, no unknown IDs, and no additional fields. Priorities,
 * credentials, endpoints, and health values are never part of this contract.
 */
export const parseUserProviderPreferences = (value: unknown): UserProviderPreferences => {
  if (!isRecord(value)) throw new ProviderPreferencesValidationError()
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'disabledProviderIds') {
    throw new ProviderPreferencesValidationError()
  }
  const ids = value.disabledProviderIds
  if (!Array.isArray(ids) || ids.length > USER_TOGGLEABLE_PROVIDER_IDS.length) {
    throw new ProviderPreferencesValidationError()
  }

  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || !TOGGLEABLE_IDS.has(id) || seen.has(id)) {
      throw new ProviderPreferencesValidationError()
    }
    seen.add(id)
  }
  return {
    disabledProviderIds: inCanonicalOrder(ids as UserToggleableProviderId[]),
  }
}

export const readUserProviderPreferences = async (
  database: Database,
  userId: string,
  now = Date.now(),
): Promise<UserProviderPreferences> => {
  const row = await database.prepare(`
    SELECT disabled_provider_ids_json AS disabledProviderIdsJson
    FROM user_provider_preferences WHERE user_id = ?
  `).bind(userId).first<{ disabledProviderIdsJson: string }>()

  if (!row) {
    return { disabledProviderIds: [] }
  }

  let rawIds: string[] = []
  try {
    const parsed = JSON.parse(row.disabledProviderIdsJson) as unknown
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) {
      rawIds = parsed
    }
  } catch {
    rawIds = []
  }

  const migrated = migrateLegacyDisabledProviderIds(rawIds)
  const canonicalJson = JSON.stringify(migrated)

  if (row.disabledProviderIdsJson !== canonicalJson) {
    await database.prepare(`
      UPDATE user_provider_preferences
      SET disabled_provider_ids_json = ?, updated_at = ?
      WHERE user_id = ?
    `).bind(canonicalJson, now, userId).run()
  }

  return {
    disabledProviderIds: migrated,
  }
}

export const writeUserProviderPreferences = async (
  database: Database,
  userId: string,
  preferences: UserProviderPreferences,
  now: number,
): Promise<UserProviderPreferences> => {
  await database.prepare(`
    INSERT INTO user_provider_preferences (user_id, disabled_provider_ids_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      disabled_provider_ids_json = excluded.disabled_provider_ids_json,
      updated_at = excluded.updated_at
  `).bind(userId, JSON.stringify(preferences.disabledProviderIds), now).run()
  return readUserProviderPreferences(database, userId)
}

const readBoundedBody = async (request: Request): Promise<unknown> => {
  try {
    return await readBoundedJsonRequest(request, MAX_REQUEST_BYTES)
  } catch {
    throw new ProviderPreferencesValidationError()
  }
}

export function createProviderPreferencesHandler(
  env: ProviderPreferencesEnv,
  options: ProviderPreferencesRouteOptions = {},
) {
  const cryptoApi = options.crypto ?? crypto
  const now = options.now ?? Date.now
  const origin = new URL(env.PUBLIC_ORIGIN).origin

  const authenticatedUserId = async (request: Request) => {
    const token = readCookie(request, SESSION_COOKIE)
    return (await findSession(env.DB, token, env.SESSION_HMAC_SECRET, now(), cryptoApi))
      ?.userId ?? null
  }

  const fetchHandler = async (request: Request): Promise<Response> => {
    const route = new URL(request.url).pathname
    if (route !== '/api/account/provider-preferences') {
      return json({ error: 'not_found' }, 404)
    }
    const isMutation = request.method !== 'GET' && request.method !== 'HEAD'
    if (isMutation && request.headers.get('origin') !== origin) {
      return json({ error: 'forbidden_origin' }, 403)
    }
    const userId = await authenticatedUserId(request)
    if (!userId) return json({ error: 'authentication_required' }, 401)

    try {
      if (request.method === 'GET') {
        return json(await readUserProviderPreferences(env.DB, userId, now()))
      }
      if (request.method === 'PUT') {
        const preferences = parseUserProviderPreferences(await readBoundedBody(request))
        return json(await writeUserProviderPreferences(env.DB, userId, preferences, now()))
      }
      return json({ error: 'method_not_allowed' }, 405)
    } catch (error) {
      if (error instanceof ProviderPreferencesValidationError) {
        return json({ error: 'invalid_provider_preferences' }, 400)
      }
      return json({ error: 'provider_preferences_unavailable' }, 500)
    }
  }

  return { fetch: fetchHandler }
}
