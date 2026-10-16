/**
 * Administrator availability overrides for shipped static backgrounds.
 *
 * Shipped media are files bundled with the app, so an administrator can never
 * delete them — instead `GET /api/backgrounds/overrides` reports a status per
 * shipped id (`published`, `archived` or `tombstoned`). Everything in this
 * module exists to answer one question safely: *may this shipped background be
 * shown?*
 *
 * The dangerous answer is "we could not ask, so assume yes". That is a
 * fail-open: a disabled background silently returns to the gallery whenever the
 * overrides endpoint hiccups. The safe answer is to keep the last verified
 * answer, which is why a successful response is cached and reused when the
 * endpoint is unreachable. A background that is known to be disabled therefore
 * stays hidden across transient API failures, page reloads, saved preferences
 * and rotation.
 *
 * First-ever offline use with no cache has no verified knowledge of
 * remote decisions: callers keep shipped defaults available without blocking
 * application startup. Only a fully valid response can establish that knowledge.
 */

import { STATIC_BACKGROUND_IDS } from './staticDefinitions'

export interface BackgroundOverride {
  id: string
  status: 'published' | 'archived' | 'tombstoned'
  title?: string | null
  game?: string | null
  collection?: string | null
  displayOrder?: number | null
  updatedAt?: number
}

export type BackgroundOverrides = Map<string, BackgroundOverride>

/** Versioned so a future schema change can never be read as today's shape. */
export const BACKGROUND_OVERRIDES_STORAGE_KEY = 'study-with-hoyomix.background-overrides.v1'

export interface OverrideStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate atomically: `null` is failure, while an empty map is authoritative.
 * Historical slugs remain valid even after their shipped definition disappears;
 * retain them so catalogue changes cannot invalidate other cached restrictions.
 * Unknown fields are ignored for additive API compatibility. All supported
 * fields are checked without repairing malformed values.
 */
export const parseOverrides = (value: unknown): BackgroundOverrides | null => {
  const overrides: BackgroundOverrides = new Map()
  if (!isRecord(value)) return null
  const rows = value.overrides
  if (!Array.isArray(rows)) return null
  for (const row of rows) {
    if (!isRecord(row) || typeof row.id !== 'string' || row.id.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.id) || overrides.has(row.id) ||
      (row.status !== 'published' && row.status !== 'archived' && row.status !== 'tombstoned')) return null
    const override: BackgroundOverride = { id: row.id, status: row.status }
    for (const key of ['title', 'game', 'collection'] as const) {
      if (!(key in row)) continue
      const field = row[key]
      if (field !== null && (typeof field !== 'string' || field.trim().length === 0 ||
        field.length > (key === 'title' ? 120 : 64))) return null
      override[key] = field as string | null
    }
    if ('displayOrder' in row) {
      const field = row.displayOrder
      if (field !== null && (typeof field !== 'number' || !Number.isInteger(field) || field < 0)) return null
      override.displayOrder = field as number | null
    }
    if ('updatedAt' in row) {
      const field = row.updatedAt
      if (typeof field !== 'number' || !Number.isInteger(field) || field < 0) return null
      override.updatedAt = field
    }
    overrides.set(override.id, override)
  }
  return overrides
}

/** True when an override removes the background from every public surface. */
export const isOverrideHidden = (override: BackgroundOverride | undefined): boolean =>
  override?.status === 'archived' || override?.status === 'tombstoned'

/**
 * Ids the last verified response marked unavailable. This is the only thing the
 * browser can assert locally about administrator availability, so it is what
 * saved preferences and rotation are checked against before any request runs.
 */
export const hiddenOverrideIds = (overrides: BackgroundOverrides | null): Set<string> => {
  const hidden = new Set<string>()
  if (!overrides) return hidden
  for (const [id, override] of overrides) {
    if (isOverrideHidden(override)) hidden.add(id)
  }
  return hidden
}

/**
 * Apply an override to a shipped entry. Returns null when the administrator has
 * disabled it; otherwise metadata fields are replaced only where the override
 * supplies a non-null value, so untouched fields keep their shipped defaults.
 */
export const applyOverride = <T extends { id: string }>(
  entry: T,
  override: BackgroundOverride | undefined,
): T | null => {
  if (!override) return entry
  if (isOverrideHidden(override)) return null
  const next = { ...entry } as T & {
    title?: string
    game?: string
    collection?: string
    displayOrder?: number
  }
  if (override.title != null) next.title = override.title
  if (override.game != null) next.game = override.game
  if (override.collection != null) next.collection = override.collection
  if (override.displayOrder != null) next.displayOrder = override.displayOrder
  return next
}

/**
 * Read the last verified overrides.
 *
 * Returns `null` — not an empty map — when nothing has ever been verified, so
 * callers can tell "the administrator disabled nothing" apart from "we have
 * never successfully asked". Conflating the two is exactly the fail-open that
 * lets a disabled background reappear.
 */
export const readCachedOverrides = (storage?: OverrideStorage): BackgroundOverrides | null => {
  if (!storage) return null
  try {
    const raw = storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== 1) return null
    return parseOverrides(parsed)
  } catch {
    return null
  }
}

/**
 * A missing cache is first-use unknown. An existing but invalid cache may have
 * contained a disable decision, so quarantine shipped media until a complete
 * valid HTTP snapshot replaces it. Never repair or overwrite that evidence.
 */
export const readAvailabilityOverrides = (storage?: OverrideStorage): BackgroundOverrides | null => {
  const verified = readCachedOverrides(storage)
  if (verified || !storage) return verified
  try {
    if (storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY) === null) return null
  } catch {
    // Storage access failure also prevents proving that no restrictions exist.
  }
  return new Map(STATIC_BACKGROUND_IDS.map(id => [id, { id, status: 'archived' as const }]))
}

/** Persist a verified overrides response so a later failure can still honour it. */
export const writeCachedOverrides = (storage: OverrideStorage | undefined, overrides: BackgroundOverrides): void => {
  if (!storage) return
  try {
    storage.setItem(BACKGROUND_OVERRIDES_STORAGE_KEY, JSON.stringify({
      version: 1,
      overrides: [...overrides.values()],
    }))
  } catch { /* an unavailable cache only costs the offline fallback */ }
}
