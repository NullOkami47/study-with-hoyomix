import type { D1Database } from '../env'
import {
  CHKSZ_DISCOVERY_CONFIDENCE,
  CHKSZ_MATCHER_VERSION,
  computeCanonicalMetadataFingerprint,
  getChkszCacheTtlMs,
  isChkszDenied,
  RUNTIME_DENYLIST,
  type CanonicalMetadataInput,
  type ChkszConfidenceClass,
  type ChkszDiscoveryRecord,
} from '../../src/shared/chkszDiscovery'
import { classifyCandidates } from '../../src/shared/chkszMatcher'
import { parseChkszSearchResponse } from '../../src/shared/chkszSearch'
import {
  buildChkszAdminSearchUpstreamUrl,
  CHKSZ_ADMIN_SEARCH_MAX_RESPONSE_BYTES,
  CHKSZ_ADMIN_SEARCH_TIMEOUT_MS,
} from './chkszSearchProxy'
import { readBoundedJsonResponse } from './boundedJson'
import {
  acquireChkszLock,
  checkAndConsumeChkszGlobalRateSlot,
  getChkszDiscovery,
  putChkszDiscovery,
  readStaticChkszSource,
  releaseChkszLock,
  updateChkszDiscovery,
} from './chkszDiscoveryStore'

/** Internal rate limit ceiling: 15 searches/minute (under the hard 20 RPM ceiling). */
export const CHKSZ_DYNAMIC_DISCOVERY_RATE_LIMIT_PER_MINUTE = 15
export const CHKSZ_DYNAMIC_DISCOVERY_WINDOW_MS = 60_000

/**
 * Sliding window rate limiter for runtime dynamic searches across the isolate.
 */
export class ChkszDynamicDiscoveryRateLimiter {
  private readonly hits: number[] = []

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxPerMinute: number = CHKSZ_DYNAMIC_DISCOVERY_RATE_LIMIT_PER_MINUTE,
  ) {}

  check(): number | null {
    const t = this.now()
    const windowStart = t - CHKSZ_DYNAMIC_DISCOVERY_WINDOW_MS
    while (this.hits.length > 0 && this.hits[0] <= windowStart) {
      this.hits.shift()
    }
    if (this.hits.length >= this.maxPerMinute) {
      const oldest = this.hits[0]
      const retryAfter = Math.max(1, Math.ceil((oldest + CHKSZ_DYNAMIC_DISCOVERY_WINDOW_MS - t) / 1000))
      return retryAfter
    }
    this.hits.push(t)
    return null
  }

  clear(): void {
    this.hits.length = 0
  }
}

export const defaultDiscoveryRateLimiter = new ChkszDynamicDiscoveryRateLimiter()

export interface ChkszDiscoveryResultSuccess {
  ok: true
  externalId: string
  confidence: ChkszConfidenceClass
  source: 'static' | 'cache' | 'search'
}

export interface ChkszDiscoveryResultFailure {
  ok: false
  error: string
  retryAfter?: number
  source?: 'static' | 'negative_cache' | 'search' | 'rate_limiter' | 'guard'
}

export type ChkszDiscoveryResult =
  | ChkszDiscoveryResultSuccess
  | ChkszDiscoveryResultFailure

export interface ChkszDiscoveryServiceDeps {
  fetch?: typeof fetch
  now?: () => number
  rateLimiter?: ChkszDynamicDiscoveryRateLimiter
}

// In-flight coalescing map per isolate
const inFlightSearches = new Map<string, Promise<ChkszDiscoveryResult>>()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function formatDiscoveryRecordResult(
  record: ChkszDiscoveryRecord,
): ChkszDiscoveryResult {
  if (record.status === 'active' && record.providerExternalId) {
    return {
      ok: true,
      externalId: record.providerExternalId,
      confidence: record.matchConfidence,
      source: 'cache',
    }
  }
  if (record.status === 'rejected') {
    return {
      ok: false,
      error: record.matchConfidence.toLowerCase(),
      source: 'negative_cache',
    }
  }
  return {
    ok: false,
    error: 'upstream_error',
    source: 'negative_cache',
  }
}

/**
 * Return a cached result only when its matcher and canonical metadata still match.
 * Stale rows are invalidated in place (never deleted); deny-listed cached pairs are
 * demoted to a negative row before the guard response is returned.
 */
async function readValidatedCacheResult(
  db: D1Database,
  trackId: string,
  now: number,
  fingerprint: string,
): Promise<ChkszDiscoveryResult | null> {
  const cached = await getChkszDiscovery(db, trackId, now)
  if (!cached) return null

  if (
    cached.matcherVersion !== CHKSZ_MATCHER_VERSION ||
    cached.canonicalMetadataFingerprint !== fingerprint
  ) {
    const invalidated: ChkszDiscoveryRecord = {
      ...cached,
      providerExternalId: null,
      matchConfidence: CHKSZ_DISCOVERY_CONFIDENCE.UPSTREAM_ERROR,
      matcherVersion: CHKSZ_MATCHER_VERSION,
      canonicalMetadataFingerprint: fingerprint,
      evidenceJson: JSON.stringify({
        reason: 'cache_identity_stale',
        previousMatcherVersion: cached.matcherVersion,
        previousCanonicalMetadataFingerprint: cached.canonicalMetadataFingerprint,
      }),
      lastVerifiedAt: now,
      status: 'error',
      failureReason: 'cache_identity_stale',
      // Expire the invalidated row immediately so this request can perform one fresh search.
      expiresAt: now,
    }
    try {
      await updateChkszDiscovery(db, invalidated)
    } catch {}
    return null
  }

  if (cached.status === 'active' && cached.providerExternalId) {
    const denied = isChkszDenied(trackId, cached.providerExternalId)
    if (denied.blocked) {
      const rejected: ChkszDiscoveryRecord = {
        ...cached,
        providerExternalId: null,
        matchConfidence: CHKSZ_DISCOVERY_CONFIDENCE.CONFLICT,
        evidenceJson: JSON.stringify({
          reason: 'denylisted_cached_identity',
          previousProviderExternalId: cached.providerExternalId,
          denylistReason: denied.reason ?? 'denylisted_pair',
        }),
        status: 'rejected',
        failureReason: 'denylisted_cached_identity',
        expiresAt: now + getChkszCacheTtlMs(CHKSZ_DISCOVERY_CONFIDENCE.CONFLICT),
      }
      try {
        await updateChkszDiscovery(db, rejected)
      } catch {}
      return { ok: false, error: 'denylisted', source: 'guard' }
    }
  }

  return formatDiscoveryRecordResult(cached)
}

/**
 * Discover a provider external ID for a canonical HOYO-MiX track.
 *
 * Precedence:
 * 1. Static verified binding in `catalogue_sources`
 * 2. Runtime Deny-List verification
 * 3. Persistent dynamic cache in D1 (`chksz_dynamic_discoveries`)
 * 4. Cross-isolate track lock and global D1 rate limit check (<= 15 RPM deployment-wide)
 * 5. Fresh upstream search (only if cache miss and rate limit budget permits)
 */
export async function discoverChkszTrack(
  trackId: string,
  canonicalMetadata: CanonicalMetadataInput,
  apiKey: string,
  db: D1Database,
  deps: ChkszDiscoveryServiceDeps = {},
): Promise<ChkszDiscoveryResult> {
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const limiter = deps.rateLimiter ?? defaultDiscoveryRateLimiter

  // 1. Static verified binding check (editorial catalogue truth always takes precedence)
  try {
    const staticRow = await readStaticChkszSource(db, trackId)
    if (staticRow) {
      if (staticRow.sourceStatus === 'disabled') {
        return { ok: false, error: 'disabled', source: 'static' }
      }
      const denied = isChkszDenied(trackId, staticRow.externalId)
      if (denied.blocked) {
        return { ok: false, error: 'denylisted', source: 'static' }
      }
      return {
        ok: true,
        externalId: staticRow.externalId,
        confidence: CHKSZ_DISCOVERY_CONFIDENCE.EXACT,
        source: 'static',
      }
    }
  } catch {
    // If DB check fails, proceed to fallback logic
  }

  // 2. Deny-list check for track
  const trackDenial = isChkszDenied(trackId)
  if (trackDenial.blocked) {
    return { ok: false, error: 'denylisted', source: 'guard' }
  }

  // 3. Persistent dynamic cache check
  const fingerprint = computeCanonicalMetadataFingerprint(canonicalMetadata)
  const currentTime = now()
  try {
    const cachedResult = await readValidatedCacheResult(db, trackId, currentTime, fingerprint)
    if (cachedResult) return cachedResult
  } catch {
    // If D1 read fails, continue to fresh search
  }

  // 4. Request coalescing: reuse in-flight search for the same canonical track within this isolate
  const existingInFlight = inFlightSearches.get(trackId)
  if (existingInFlight) {
    return existingInFlight
  }

  const searchPromise = (async (): Promise<ChkszDiscoveryResult> => {
    // Fast isolate-local rate limit check
    const rateLimited = limiter.check()
    if (rateLimited !== null) {
      return {
        ok: false,
        error: 'rate_limited',
        retryAfter: rateLimited,
        source: 'rate_limiter',
      }
    }

    // Cross-isolate distributed lock for this track
    const trackOwnerId = crypto.randomUUID()
    const trackLockKey = `track:${trackId}`
    const trackLockTtlMs = 15_000

    let trackLockAcquired = await acquireChkszLock(
      db,
      trackLockKey,
      trackOwnerId,
      trackLockTtlMs,
      now(),
    )

    if (!trackLockAcquired) {
      // Another isolate is performing discovery for this track.
      // Poll D1 for the result without duplicating upstream calls.
      for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(350)
        const pollTime = now()
        const cachedResult = await readValidatedCacheResult(db, trackId, pollTime, fingerprint)
        if (cachedResult) return cachedResult
        trackLockAcquired = await acquireChkszLock(
          db,
          trackLockKey,
          trackOwnerId,
          trackLockTtlMs,
          pollTime,
        )
        if (trackLockAcquired) break
      }

      if (!trackLockAcquired) {
        return {
          ok: false,
          error: 'rate_limited',
          retryAfter: 2,
          source: 'rate_limiter',
        }
      }
    }

    try {
      // Re-check D1 cache with lock held
      const lockedCacheResult = await readValidatedCacheResult(db, trackId, now(), fingerprint)
      if (lockedCacheResult) return lockedCacheResult

      // Check global deployment-wide rate slot in D1 (<= 15 RPM rolling window)
      const globalSlot = await checkAndConsumeChkszGlobalRateSlot(
        db,
        now(),
        CHKSZ_DYNAMIC_DISCOVERY_RATE_LIMIT_PER_MINUTE,
      )
      if (!globalSlot.allowed) {
        return {
          ok: false,
          error: 'rate_limited',
          retryAfter: globalSlot.retryAfter,
          source: 'rate_limiter',
        }
      }

      // Upstream search call
      const keyword = canonicalMetadata.title.trim()
      const upstreamUrl = buildChkszAdminSearchUpstreamUrl(keyword, 5, 0, apiKey)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), CHKSZ_ADMIN_SEARCH_TIMEOUT_MS)

      let response: Response
      try {
        response = await fetchImpl(upstreamUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
        })
      } catch {
        clearTimeout(timeout)
        // Upstream timeout or network error: cache with short TTL (15 min)
        const errorRecord: ChkszDiscoveryRecord = {
          canonicalTrackId: trackId,
          provider: 'chksz',
          providerExternalId: null,
          matchConfidence: CHKSZ_DISCOVERY_CONFIDENCE.UPSTREAM_ERROR,
          matcherVersion: CHKSZ_MATCHER_VERSION,
          canonicalMetadataFingerprint: fingerprint,
          evidenceJson: JSON.stringify({
            error: controller.signal.aborted ? 'timeout' : 'network_error',
          }),
          discoveredAt: currentTime,
          lastVerifiedAt: currentTime,
          status: 'error',
          failureReason: controller.signal.aborted ? 'timeout' : 'unavailable',
          expiresAt: currentTime + getChkszCacheTtlMs(CHKSZ_DISCOVERY_CONFIDENCE.UPSTREAM_ERROR),
        }
        try {
          await putChkszDiscovery(db, errorRecord)
        } catch {}
        return { ok: false, error: 'upstream_error', source: 'search' }
      } finally {
        clearTimeout(timeout)
      }

      if (response.status === 429) {
        return { ok: false, error: 'rate_limited', source: 'search' }
      }
      if (response.status === 402) {
        return { ok: false, error: 'quota_exhausted', source: 'search' }
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: 'invalid_credential', source: 'search' }
      }
      if (response.status !== 200) {
        const errorRecord: ChkszDiscoveryRecord = {
          canonicalTrackId: trackId,
          provider: 'chksz',
          providerExternalId: null,
          matchConfidence: CHKSZ_DISCOVERY_CONFIDENCE.UPSTREAM_ERROR,
          matcherVersion: CHKSZ_MATCHER_VERSION,
          canonicalMetadataFingerprint: fingerprint,
          evidenceJson: JSON.stringify({ upstreamStatus: response.status }),
          discoveredAt: currentTime,
          lastVerifiedAt: currentTime,
          status: 'error',
          failureReason: `upstream_status_${response.status}`,
          expiresAt: currentTime + getChkszCacheTtlMs(CHKSZ_DISCOVERY_CONFIDENCE.UPSTREAM_ERROR),
        }
        try {
          await putChkszDiscovery(db, errorRecord)
        } catch {}
        return { ok: false, error: 'upstream_error', source: 'search' }
      }

      const parsed = await readBoundedJsonResponse(response, CHKSZ_ADMIN_SEARCH_MAX_RESPONSE_BYTES)
      if (!parsed.ok) {
        return { ok: false, error: 'invalid_response', source: 'search' }
      }

      const normalised = parseChkszSearchResponse(parsed.value)
      if (!normalised) {
        return { ok: false, error: 'invalid_response', source: 'search' }
      }

      const candidates = normalised.candidates.map((c, index) => ({
        ...c,
        searchRank: index,
      }))

      const matchResult = classifyCandidates(
        {
          track_id: trackId,
          title: canonicalMetadata.title,
          duration_s: canonicalMetadata.duration_s,
          vocal_status: canonicalMetadata.vocalStatus ?? canonicalMetadata.vocal_status,
          album: canonicalMetadata.album,
          aliases: canonicalMetadata.aliases,
        },
        candidates,
        { denylist: RUNTIME_DENYLIST },
      )

      // Only EXACT is runtime-active; HIGH_CONFIDENCE requires manual editorial verification
      const isAccepted =
        matchResult.confidence === CHKSZ_DISCOVERY_CONFIDENCE.EXACT &&
        matchResult.accepted_external_id !== null

      const recordStatus = isAccepted ? 'active' : 'rejected'
      const ttlMs = getChkszCacheTtlMs(matchResult.confidence)
      const discoveryRecord: ChkszDiscoveryRecord = {
        canonicalTrackId: trackId,
        provider: 'chksz',
        providerExternalId: matchResult.accepted_external_id,
        matchConfidence: matchResult.confidence,
        matcherVersion: CHKSZ_MATCHER_VERSION,
        canonicalMetadataFingerprint: fingerprint,
        evidenceJson: JSON.stringify(
          matchResult.accepted?.evidence ?? { reason: matchResult.reason },
        ),
        discoveredAt: currentTime,
        lastVerifiedAt: currentTime,
        status: recordStatus,
        failureReason: isAccepted ? null : matchResult.reason,
        expiresAt: currentTime + ttlMs,
      }

      try {
        await putChkszDiscovery(db, discoveryRecord)
      } catch {}

      if (isAccepted && matchResult.accepted_external_id) {
        return {
          ok: true,
          externalId: matchResult.accepted_external_id,
          confidence: matchResult.confidence,
          source: 'search',
        }
      }

      return {
        ok: false,
        error: matchResult.confidence.toLowerCase(),
        source: 'search',
      }
    } finally {
      await releaseChkszLock(db, trackLockKey, trackOwnerId)
    }
  })()

  inFlightSearches.set(trackId, searchPromise)
  try {
    return await searchPromise
  } finally {
    inFlightSearches.delete(trackId)
  }
}
