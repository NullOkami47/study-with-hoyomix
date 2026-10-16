/**
 * Shared types, constants, and safety utilities for ChKSz dynamic discovery.
 *
 * Adheres to the strict safety requirements:
 * - Negative caching with defined TTLs per confidence class
 * - Matcher versioning pinned to 'chksz-identity-v1'
 * - Source-controlled runtime deny-list enforcement
 * - Canonical metadata fingerprinting
 * - Central rate limit ceiling: <= 15 searches/minute
 */

export const CHKSZ_MATCHER_VERSION = 'chksz-identity-v1'

export const CHKSZ_DISCOVERY_CONFIDENCE = Object.freeze({
  EXACT: 'EXACT',
  HIGH_CONFIDENCE: 'HIGH_CONFIDENCE',
  AMBIGUOUS: 'AMBIGUOUS',
  NO_MATCH: 'NO_MATCH',
  CONFLICT: 'CONFLICT',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
} as const)

export type ChkszConfidenceClass =
  (typeof CHKSZ_DISCOVERY_CONFIDENCE)[keyof typeof CHKSZ_DISCOVERY_CONFIDENCE]

export type ChkszDiscoveryStatus = 'active' | 'rejected' | 'error'

/**
 * Negative and active cache TTLs (milliseconds).
 * - NO_MATCH: 7 days
 * - AMBIGUOUS: 30 days
 * - CONFLICT: 90 days
 * - UPSTREAM_ERROR: 15 minutes
 * - EXACT / HIGH_CONFIDENCE: 180 days
 */
export const CHKSZ_CACHE_TTL_MS = Object.freeze({
  NO_MATCH: 7 * 24 * 60 * 60 * 1000,
  AMBIGUOUS: 30 * 24 * 60 * 60 * 1000,
  CONFLICT: 90 * 24 * 60 * 60 * 1000,
  UPSTREAM_ERROR: 15 * 60 * 1000,
  ACTIVE: 180 * 24 * 60 * 60 * 1000,
} as const)

export interface ChkszDiscoveryRecord {
  canonicalTrackId: string
  provider: 'chksz'
  providerExternalId: string | null
  matchConfidence: ChkszConfidenceClass
  matcherVersion: string
  canonicalMetadataFingerprint: string
  evidenceJson: string
  discoveredAt: number
  lastVerifiedAt: number
  status: ChkszDiscoveryStatus
  failureReason: string | null
  expiresAt: number
}

export interface ChkszRuntimeDenylistEntry {
  canonical_track_id: string
  provider_external_id: string
  reason?: string
}

export interface ChkszRuntimeDenylist {
  schema_version: number
  provider: string
  matcher_version: string
  global_blocked_external_ids: string[]
  entries: ChkszRuntimeDenylistEntry[]
}

export const RUNTIME_DENYLIST: ChkszRuntimeDenylist = Object.freeze({
  schema_version: 1,
  provider: 'chksz',
  matcher_version: 'chksz-identity-v1',
  global_blocked_external_ids: [],
  entries: [
    {
      canonical_track_id: 'genshin-la-vaguelette',
      provider_external_id: '2100372359',
      reason:
        'Known ambiguous/wrong identity for the French vocal (譚維維 credit, 148042ms). Explicitly must not be bound to the French vocal.',
    },
    {
      canonical_track_id: 'zzz-phaethon-s-melody',
      provider_external_id: '2604006840',
      reason:
        'Dead/stale NetEase track ID; actual playable remix track is standard NetEase song 3335346767.',
    },
    {
      canonical_track_id: 'zzz-angel-loading-instrumental',
      provider_external_id: '2664977508',
      reason:
        'Vocal version of Angel Loading; canonical track is instrumental (NetEase song 3355612825).',
    },
    {
      canonical_track_id: 'zzz-tiny-giant',
      provider_external_id: '2155423468',
      reason:
        'Historical cross-binding incident: 2155423468 is Hope Is the Thing With Feathers, not Tiny Giant.',
    },
    {
      canonical_track_id: 'hsr-hope-is-the-thing-with-feathers',
      provider_external_id: '3334421408',
      reason:
        'Historical cross-binding incident: 3334421408 is Tiny Giant, not Hope Is the Thing With Feathers.',
    },
    {
      canonical_track_id: 'zzz-tiny-giant-instrumental',
      provider_external_id: '2155423468',
      reason: 'Hope vocal identity must never bind to the Tiny Giant instrumental.',
    },
    {
      canonical_track_id: 'hsr-hope-is-the-thing-with-feathers-instrumental',
      provider_external_id: '3334421408',
      reason: 'Tiny Giant vocal identity must never bind to the Hope instrumental.',
    },
    {
      canonical_track_id: 'zzz-shining-promise-in-the-sky-of-dawn',
      provider_external_id: '1997387229',
      reason: 'Unrelated NetEase identity: Get it now by Storm Cruisers from Night Sky (155742ms), not File 90.',
    },
    {
      canonical_track_id: 'zzz-shining-promise-in-the-sky-of-dawn',
      provider_external_id: '2691982296',
      reason: 'Japanese vocal sibling on the same release (track 1); File 90 is the distinct English vocal (track 2, 2691982297).',
    },
  ],
})

export interface DenyCheckResult {
  blocked: boolean
  reason?: string
}

/**
 * Check whether a canonical track or canonical track + external ID pair is forbidden
 * by the runtime deny-list.
 */
export function isChkszDenied(
  canonicalTrackId: string,
  externalId?: string | null,
  customDenylist: ChkszRuntimeDenylist = RUNTIME_DENYLIST,
): DenyCheckResult {
  if (!customDenylist) return { blocked: false }

  const idStr = externalId != null ? String(externalId).trim() : null

  if (idStr && Array.isArray(customDenylist.global_blocked_external_ids)) {
    if (customDenylist.global_blocked_external_ids.includes(idStr)) {
      return { blocked: true, reason: 'global_blocked_external_id' }
    }
  }

  const entries = Array.isArray(customDenylist.entries) ? customDenylist.entries : []
  for (const entry of entries) {
    if (entry.canonical_track_id !== canonicalTrackId) continue
    if (!entry.provider_external_id || entry.provider_external_id === '*') {
      return { blocked: true, reason: entry.reason || 'denylisted_track' }
    }
    if (idStr === null) {
      continue
    }
    if (String(entry.provider_external_id) === idStr) {
      return { blocked: true, reason: entry.reason || 'denylisted_pair' }
    }
  }

  return { blocked: false }
}

export interface CanonicalMetadataInput {
  title: string
  duration_s?: number | null
  vocalStatus?: string | null
  vocal_status?: string | null
  album?: string | null
  aliases?: Array<string | { alias: string }> | null
}

/**
 * Produce a deterministic canonical metadata fingerprint string.
 * When canonical title, duration, vocal status, or aliases change, the fingerprint
 * changes, triggering revalidation.
 */
export function computeCanonicalMetadataFingerprint(input: CanonicalMetadataInput): string {
  const normTitle = String(input.title ?? '').trim().toLowerCase()
  const vocal = String(input.vocalStatus ?? input.vocal_status ?? 'uncertain').trim().toLowerCase()
  const duration = input.duration_s != null && Number.isFinite(input.duration_s)
    ? input.duration_s.toFixed(3)
    : 'none'
  const album = String(input.album ?? '').trim().toLowerCase()
  const rawAliases = input.aliases ?? []
  const aliasStrings = rawAliases
    .map((a) => (typeof a === 'string' ? a : a?.alias))
    .filter((a): a is string => Boolean(a && a.trim()))
    .map((a) => a.trim().toLowerCase())
    .sort()

  const raw = `${normTitle}|${vocal}|${duration}|${album}|${aliasStrings.join(',')}`
  // DJB2 hash for compact deterministic fingerprint in all JS runtimes
  let hash = 5381
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(i)
    hash |= 0
  }
  return `fp_${CHKSZ_MATCHER_VERSION}_${(hash >>> 0).toString(16)}`
}

/**
 * Determine cache TTL in milliseconds for a confidence class.
 */
export function getChkszCacheTtlMs(confidence: ChkszConfidenceClass): number {
  switch (confidence) {
    case 'EXACT':
    case 'HIGH_CONFIDENCE':
      return CHKSZ_CACHE_TTL_MS.ACTIVE
    case 'NO_MATCH':
      return CHKSZ_CACHE_TTL_MS.NO_MATCH
    case 'AMBIGUOUS':
      return CHKSZ_CACHE_TTL_MS.AMBIGUOUS
    case 'CONFLICT':
      return CHKSZ_CACHE_TTL_MS.CONFLICT
    case 'UPSTREAM_ERROR':
      return CHKSZ_CACHE_TTL_MS.UPSTREAM_ERROR
  }
}
