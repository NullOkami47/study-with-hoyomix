/**
 * Task 15 — Admin-only ChKSz `/api/163_search` proxy.
 *
 * Owner-key-backed search must never be a generic public proxy. This module is the
 * single narrow facility that lets an authenticated operator (admin/owner session)
 * issue a bounded keyword search through the deployed owner `CHKSZ_API_KEY` without
 * ever exposing the key.
 *
 * Guarantees (each covered by `workers/test/security-chksz-search-proxy.spec.ts`):
 *
 * - authentication/authorisation: caller must already be an admin/owner; this module
 *   does not authenticate by itself, it only enforces the request shape and the
 *   upstream destination. Wiring in `workers/admin/routes.ts` performs the session check
 *   before delegating here.
 * - bounded keyword length: 1..80 chars after trim, no control characters.
 * - bounded result limit: 1..10, default 5. Never forwards the caller's limit verbatim
 *   beyond the ceiling; clamps are rejected (not silently coerced) so a caller bug is
 *   visible rather than silently reshaped.
 * - response-size limits: upstream body bounded to 64 KiB; request body bounded by
 *   `readBoundedJsonRequest` (64 KiB) at the route layer.
 * - rate limiting: per-admin in-memory sliding window, 20 requests/minute (matches the
 *   documented ChKSz family limit). Returns 429 with `Retry-After` when exceeded.
 * - timeout: 8s upstream abort; maps to 504.
 * - no key reflection: the key is appended to the upstream URL server-side only and is
 *   never copied into any response, error message, or audit detail.
 * - no secret logging: audit detail records keyword length and result count only;
 *   neither the key nor the full upstream URL is logged.
 * - no arbitrary upstream URL: destination is fixed to
 *   `https://api.chksz.com/api/163_search`; caller controls only keyword/limit/offset.
 * - fixed destination: query params are keyword/limit/offset/apikey only.
 *
 * The response `durationMs` unit is milliseconds, verified live on 2026-09-20:
 * local ffprobe 149.520979s vs candidate raw 149520 (delta <1ms) for NetEase id
 * 2100334024 (La vaguelette accompaniment). Evidence:
 * `docs/verification/task15-verified-joins.json`. Consumers compare seconds
 * against `durationMs / 1000` with the project's conservative tolerance.
 */

import { readBoundedJsonResponse } from './boundedJson'
import { parseChkszSearchResponse } from '../../src/shared/chkszSearch'

export const CHKSZ_SEARCH_UPSTREAM_ORIGIN = 'https://api.chksz.com'
export const CHKSZ_SEARCH_UPSTREAM_PATH = '/api/163_search'
export const CHKSZ_SEARCH_UPSTREAM_URL = `${CHKSZ_SEARCH_UPSTREAM_ORIGIN}${CHKSZ_SEARCH_UPSTREAM_PATH}`

export const CHKSZ_ADMIN_SEARCH_MAX_KEYWORD_LENGTH = 80
export const CHKSZ_ADMIN_SEARCH_DEFAULT_LIMIT = 5
export const CHKSZ_ADMIN_SEARCH_MAX_LIMIT = 10
export const CHKSZ_ADMIN_SEARCH_MAX_OFFSET = 200
export const CHKSZ_ADMIN_SEARCH_MAX_RESPONSE_BYTES = 64 * 1024
export const CHKSZ_ADMIN_SEARCH_TIMEOUT_MS = 8_000
/** Family-wide limit: 20 requests/minute. Enforced per admin user, per isolate. */
export const CHKSZ_ADMIN_SEARCH_RATE_LIMIT_PER_MINUTE = 20
export const CHKSZ_ADMIN_SEARCH_RATE_WINDOW_MS = 60_000

export type ChkszAdminSearchBody =
  | { ok: true; keyword: string; limit: number; offset: number }
  | { ok: false; error: string }

const hasControlChars = (value: string): boolean =>
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f]/.test(value)

/**
 * Validate the admin search request body. Closed key set: keyword, limit?, offset?.
 * Rejects (never coerces) out-of-range values so caller bugs are visible.
 */
export function validateChkszAdminSearchBody(value: unknown): ChkszAdminSearchBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'invalid_search_body' }
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (!keys.includes('keyword') || !keys.every((k) => ['keyword', 'limit', 'offset'].includes(k))) {
    return { ok: false, error: 'invalid_search_body' }
  }
  const rawKeyword = record.keyword
  if (typeof rawKeyword !== 'string') return { ok: false, error: 'invalid_keyword' }
  const keyword = rawKeyword.trim()
  if (keyword.length === 0 || keyword.length > CHKSZ_ADMIN_SEARCH_MAX_KEYWORD_LENGTH) {
    return { ok: false, error: 'invalid_keyword' }
  }
  if (hasControlChars(keyword)) return { ok: false, error: 'invalid_keyword' }

  let limit = CHKSZ_ADMIN_SEARCH_DEFAULT_LIMIT
  if (record.limit !== undefined) {
    if (!Number.isSafeInteger(record.limit) || (record.limit as number) < 1 || (record.limit as number) > CHKSZ_ADMIN_SEARCH_MAX_LIMIT) {
      return { ok: false, error: 'invalid_limit' }
    }
    limit = record.limit as number
  }
  let offset = 0
  if (record.offset !== undefined) {
    if (!Number.isSafeInteger(record.offset) || (record.offset as number) < 0 || (record.offset as number) > CHKSZ_ADMIN_SEARCH_MAX_OFFSET) {
      return { ok: false, error: 'invalid_offset' }
    }
    offset = record.offset as number
  }
  return { ok: true, keyword, limit, offset }
}

/** Build the fixed-destination upstream URL. The key is appended here only. */
export function buildChkszAdminSearchUpstreamUrl(
  keyword: string,
  limit: number,
  offset: number,
  apiKey: string,
): URL {
  const url = new URL(CHKSZ_SEARCH_UPSTREAM_URL)
  url.searchParams.set('keyword', keyword)
  url.searchParams.set('limit', String(limit))
  if (offset > 0) url.searchParams.set('offset', String(offset))
  url.searchParams.set('apikey', apiKey)
  return url
}

/** In-memory per-admin sliding-window rate limiter (per isolate). */
export class ChkszAdminSearchRateLimiter {
  private readonly hits = new Map<string, number[]>()
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxPerMinute: number = CHKSZ_ADMIN_SEARCH_RATE_LIMIT_PER_MINUTE,
  ) {}

  /** Returns null when allowed, or retry-after seconds when limited. */
  check(adminId: string): number | null {
    const t = this.now()
    const windowStart = t - CHKSZ_ADMIN_SEARCH_RATE_WINDOW_MS
    const prior = (this.hits.get(adminId) ?? []).filter((ts) => ts > windowStart)
    if (prior.length >= this.maxPerMinute) {
      const oldest = Math.min(...prior)
      const retryAfter = Math.max(1, Math.ceil((oldest + CHKSZ_ADMIN_SEARCH_RATE_WINDOW_MS - t) / 1000))
      this.hits.set(adminId, prior)
      return retryAfter
    }
    prior.push(t)
    this.hits.set(adminId, prior)
    return null
  }

  clear(): void {
    this.hits.clear()
  }
}

export interface ChkszAdminSearchDeps {
  fetch?: typeof fetch
  now?: () => number
  limiter?: ChkszAdminSearchRateLimiter
}

export interface ChkszAdminSearchResult {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
  auditDetail: Record<string, unknown>
}

/**
 * Execute an authorised admin search. The caller guarantees `adminId` is an
 * authenticated admin/owner and `ownerKey` is the trimmed deployed owner key.
 * Never includes the key in the result or audit detail.
 */
export async function executeChkszAdminSearch(
  adminId: string,
  body: { keyword: string; limit: number; offset: number },
  ownerKey: string,
  deps: ChkszAdminSearchDeps = {},
): Promise<ChkszAdminSearchResult> {
  const fetchImpl = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init))
  const limiter = deps.limiter ?? new ChkszAdminSearchRateLimiter(deps.now ?? Date.now)

  const limited = limiter.check(adminId)
  if (limited !== null) {
    return {
      status: 429,
      body: { error: 'rate_limited' },
      headers: { 'retry-after': String(limited) },
      auditDetail: { keywordLength: body.keyword.length, limit: body.limit, outcome: 'rate_limited' },
    }
  }

  const upstreamUrl = buildChkszAdminSearchUpstreamUrl(body.keyword, body.limit, body.offset, ownerKey)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CHKSZ_ADMIN_SEARCH_TIMEOUT_MS)
  try {
    let upstream: Response
    try {
      upstream = await fetchImpl(upstreamUrl, { method: 'GET', redirect: 'manual', signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          status: 504,
          body: { error: 'timeout' },
          auditDetail: { keywordLength: body.keyword.length, limit: body.limit, outcome: 'timeout' },
        }
      }
      return {
        status: 502,
        body: { error: 'unavailable' },
        auditDetail: { keywordLength: body.keyword.length, limit: body.limit, outcome: 'unavailable' },
      }
    } finally {
      clearTimeout(timeout)
    }

    if (upstream.status === 429) {
      const retryAfter = upstream.headers.get('retry-after')
      const headers: Record<string, string> = {}
      if (retryAfter && /^[0-9]{1,4}$/.test(retryAfter.trim())) {
        headers['retry-after'] = retryAfter.trim()
      }
      return {
        status: 429,
        body: { error: 'rate_limited' },
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        auditDetail: { keywordLength: body.keyword.length, limit: body.limit, outcome: 'upstream_rate_limited', upstreamStatus: 429 },
      }
    }
    if (upstream.status !== 200) {
      const failure = upstream.status === 401 ? 'upstream_unauthorised' : 'upstream_error'
      return {
        status: 502,
        body: { error: failure, upstreamStatus: upstream.status },
        auditDetail: { keywordLength: body.keyword.length, limit: body.limit, outcome: failure, upstreamStatus: upstream.status },
      }
    }
    const parsed = await readBoundedJsonResponse(upstream, CHKSZ_ADMIN_SEARCH_MAX_RESPONSE_BYTES)
    if (!parsed.ok) {
      return {
        status: 502,
        body: { error: 'invalid_response' },
        auditDetail: { keywordLength: body.keyword.length, limit: body.limit, outcome: 'invalid_response' },
      }
    }
    const normalised = parseChkszSearchResponse(parsed.value)
    if (!normalised) {
      return {
        status: 502,
        body: { error: 'invalid_response' },
        auditDetail: { keywordLength: body.keyword.length, limit: body.limit, outcome: 'invalid_response' },
      }
    }
    const candidates = normalised.candidates.slice(0, body.limit).map((c, index) => ({
      ...c,
      searchRank: index,
    }))
    return {
      status: 200,
      body: {
        candidates,
        total: normalised.total,
        // Live-verified milliseconds (2026-09-20, task15-verified-joins.json).
        durationUnit: 'live_verified_ms',
      },
      auditDetail: {
        keywordLength: body.keyword.length,
        limit: body.limit,
        offset: body.offset,
        outcome: 'ok',
        resultCount: candidates.length,
        total: normalised.total,
      },
    }
  } catch {
    clearTimeout(timeout)
    return {
      status: 502,
      body: { error: 'unavailable' },
      auditDetail: { keywordLength: body.keyword.length, limit: body.limit, outcome: 'unavailable' },
    }
  }
}
