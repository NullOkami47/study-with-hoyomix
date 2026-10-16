import { useAccountSession } from '../account/session'
import { BACKGROUND_BUCKET_ORIGIN, listStaticBackgrounds } from './catalogue'
import { safeLocalStorage } from '../../utils/safeStorage'
import {
  parseOverrides,
  readAvailabilityOverrides,
  writeCachedOverrides,
  type BackgroundOverrides,
  type OverrideStorage,
} from './overrides'
import { BACKGROUND_INTERVAL_VALUES } from './types'
import type {
  BackgroundIntervalSeconds,
  BackgroundRepository,
  BackgroundSelection,
  PublicBackground,
} from './types'

interface RepositoryOptions {
  fetch?: typeof fetch
  origin?: string
  /** Where verified overrides are cached for offline availability checks. */
  storage?: OverrideStorage
}

// Canonical choices plus the values earlier builds stored: an account payload
// written by either version must keep parsing.
const intervals: readonly BackgroundIntervalSeconds[] = BACKGROUND_INTERVAL_VALUES

const parseSelection = (value: unknown): BackgroundSelection | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<BackgroundSelection>
  if (!Array.isArray(candidate.selectedIds) || candidate.selectedIds.length > 8 ||
    !candidate.selectedIds.every((id) => typeof id === 'string') ||
    typeof candidate.autoRotate !== 'boolean' ||
    !intervals.includes(candidate.intervalSeconds as BackgroundIntervalSeconds)) return null
  return {
    selectedIds: [...new Set(candidate.selectedIds)],
    autoRotate: candidate.autoRotate,
    intervalSeconds: candidate.intervalSeconds as BackgroundIntervalSeconds,
  }
}

/**
 * Media may be served three ways: the worker's same-origin upload route
 * (`/api/backgrounds/...`), a same-origin shipped static asset
 * (`/backgrounds/...`), or an absolute URL on the project's R2 bucket origin.
 * Anything else (a foreign host, a data/blob URL, a relative path) is rejected.
 */
const isAcceptedMediaUrl = (url: string): boolean =>
  url.startsWith('/api/backgrounds/') ||
  url.startsWith('/backgrounds/') ||
  url.startsWith(`${BACKGROUND_BUCKET_ORIGIN}/`)

const parseBackground = (value: unknown): PublicBackground | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<PublicBackground>
  if (typeof candidate.id !== 'string' || candidate.status !== 'published' ||
    (candidate.kind !== 'image' && candidate.kind !== 'video') ||
    typeof candidate.mediaUrl !== 'string' || !isAcceptedMediaUrl(candidate.mediaUrl) ||
    (candidate.posterUrl !== null && candidate.posterUrl !== undefined &&
      (typeof candidate.posterUrl !== 'string' || !isAcceptedMediaUrl(candidate.posterUrl))) ||
    typeof candidate.width !== 'number' || typeof candidate.height !== 'number' ||
    typeof candidate.revision !== 'number') return null
  return candidate as PublicBackground
}

/** Concatenate with first-occurrence-wins de-duplication by id. */
const mergeById = (...groups: PublicBackground[][]): PublicBackground[] => {
  const seen = new Set<string>()
  const result: PublicBackground[] = []
  for (const item of groups.flat()) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    result.push(item)
  }
  return result
}

const readJson = async (response: Response): Promise<unknown> => {
  if (!response.ok) throw new Error(`background_${response.status}`)
  return response.json() as Promise<unknown>
}

/**
 * Resolve the shipped-background overrides without ever failing open.
 *
 * A successful response is authoritative AND is cached, so a later failed
 * request can still honour it. When the endpoint is unreachable the last
 * verified answer is reused, which is what stops a background the
 * administrator disabled from reappearing because one request failed. Only
 * when nothing has ever been verified is an empty map used — a genuine
 * "unknown", not an assumption that everything is available.
 *
 * A malformed payload is treated as a failure rather than as "nothing is
 * disabled", so a broken response can never be cached as a clean bill of
 * health either.
 */
const fetchOverrides = async (
  fetcher: typeof fetch,
  storage: OverrideStorage | undefined,
): Promise<BackgroundOverrides> => {
  try {
    const response = await fetcher('/api/backgrounds/overrides', {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`background_overrides_${response.status}`)
    const payload: unknown = await response.json()
    const overrides = parseOverrides(payload)
    if (overrides === null) throw new Error('background_overrides_invalid_response')
    writeCachedOverrides(storage, overrides)
    return overrides
  } catch {
    return readAvailabilityOverrides(storage) ?? new Map()
  }
}

export function createBackgroundRepository(options: RepositoryOptions = {}): BackgroundRepository {
  const fetcher = options.fetch ?? fetch
  const origin = options.origin ?? (typeof window === 'undefined' ? 'https://localhost' : window.location.origin)
  const storage = options.storage ?? safeLocalStorage
  let revision: string | null = null
  let revisionUser: string | null = null
  const accountHeaders = (): Record<string, string> => {
    const user = useAccountSession().userId.value
    if (revisionUser !== user) { revision = null; revisionUser = user }
    return user ? { 'x-account-user-id': user } : {}
  }
  return {
    async list() {
      // The store already holds the shipped catalogue for immediate playback.
      // An incomplete API catalogue must reject: treating it as authoritative
      // would sanitise saved server IDs and could erase account preferences.
      const value = await readJson(await fetcher('/api/backgrounds', {
        credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json' },
      }))
      const rows = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { backgrounds?: unknown }).backgrounds
        : undefined
      if (!Array.isArray(rows)) throw new Error('background_invalid_response')
      const published = rows.map(parseBackground).filter((row): row is PublicBackground => row !== null)
      // Overrides are read only after the required catalogue succeeds, so an
      // offline `/api/backgrounds` still rejects without a second doomed call.
      // They are applied to the shipped manifest so a disabled clip is absent
      // from the very first render, not merely after a second round trip.
      const overrides = await fetchOverrides(fetcher, storage)
      const shipped = listStaticBackgrounds(overrides)
      return mergeById(published, shipped)
    },
    async getAccountSelection() {
      const response = await fetcher('/api/account/background-selection', {
        credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json', ...accountHeaders() },
      })
      if (response.status === 401) throw new Error('background_401')
      const value = await readJson(response)
      const selection = value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { selection?: unknown }).selection
        : undefined
      const parsed = parseSelection(selection)
      if (!parsed) throw new Error('background_invalid_response')
      revision = response.headers.get('etag')
      return parsed.selectedIds.length === 0 ? null : parsed
    },
    async saveAccountSelection(selection) {
      // The Worker validates both shipped static IDs and published uploaded IDs.
      // Send the complete ordered selection for cross-device restoration.
      const response = await fetcher('/api/account/background-selection', {
        method: 'PUT',
        credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', origin, ...accountHeaders(), ...(revision ? { 'if-match': revision } : {}) },
        body: JSON.stringify(selection),
      })
      const value = await readJson(response)
      const parsed = parseSelection(value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { selection?: unknown }).selection
        : undefined)
      if (!parsed) throw new Error('background_invalid_response')
      revision = response.headers.get('etag')
      return parsed
    },
  }
}
