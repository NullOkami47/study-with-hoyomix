/**
 * The ChKSz `/api/163_search` discovery contract, shared by any caller that needs to turn a
 * keyword into candidate NetEase track ids.
 *
 * Browser-safe and dependency-free by construction, mirroring `./chksz.ts`: no secrets, no
 * environment access, no storage access. The endpoint itself is credential-gated with the same
 * `apikey` parameter as `163_music`, but this module never handles a key — the caller owns the
 * credential and this module owns only the *shape* of the exchange.
 *
 * Contract provenance: established empirically in Task 15 Phase 9. The path, methods, parameter
 * names and gate behaviour were confirmed by live probe; the response body shape is taken from
 * the vendor reference and is marked accordingly below. See
 * `the original development notes`.
 */

import { CHKSZ_API_ORIGIN } from './chksz'

export const CHKSZ_SEARCH_ENDPOINT = `${CHKSZ_API_ORIGIN}/api/163_search`

/** Documented default page size. Not a hard ceiling — the endpoint documents `limit` as optional. */
export const CHKSZ_SEARCH_DEFAULT_LIMIT = 100

/**
 * The largest `limit` this project will ever request in one call.
 *
 * The documented default is 100 and the endpoint accepts a larger `limit`, but the family-wide
 * rate limit is 20 requests/minute, so a sweep that asks for more per call is trading a single
 * large response for a smaller number of permitted requests. 100 keeps the request count and the
 * response size both predictable, and matches the documented default so behaviour does not change
 * if the default ever shifts.
 */
export const CHKSZ_SEARCH_MAX_LIMIT = 100

/** A parsed candidate from the search endpoint, normalised to the fields qualification needs. */
export type ChkszSearchCandidate = {
  /** NetEase track id, usable directly as `163_music`'s `id`. */
  id: string
  /** Track title, in the upstream's own language. */
  name: string
  /**
   * Artist display string.
   *
   * The reference documents `artists` as a single string here while documenting
   * `163_playlist`'s artist field as `ar: [{ name }]`. The two shapes disagree, so parsing
   * accepts either and normalises to one joined string rather than assuming the first.
   */
  artists: string
  /** Album name, or `''` when absent. */
  album: string
  /**
   * Duration in **milliseconds**, or `null` when the field is absent or unparseable.
   *
   * Unit verified live on 2026-09-20: local ffprobe 149.520979s vs candidate raw
   * 149520 (delta <1ms) for NetEase id 2100334024. Evidence:
   * `the original development notes`. `null` is still returned for a
   * missing/unparseable field so a duration comparison refuses to run instead of
   * silently comparing against a guessed value.
   */
  durationMs: number | null
  /** Cover art URL, or `''` when absent. */
  picUrl: string
}

export type ChkszSearchResult =
  | { ok: true; candidates: ChkszSearchCandidate[]; total: number | null }
  | { ok: false; reason: ChkszSearchFailureReason; message: string }

/**
 * Why a search exchange did not produce candidates.
 *
 * `credential_absent` and `credential_invalid` are separated deliberately: the endpoint returns
 * `401` for both, and the only thing that distinguishes them is the `msg` text. Collapsing them
 * would make an operator with a revoked key indistinguishable from one who never configured a key.
 */
export type ChkszSearchFailureReason =
  | 'credential_absent'
  | 'credential_invalid'
  | 'rate_limited'
  | 'forbidden'
  | 'invalid_response'
  | 'unavailable'

/** The two gate messages the endpoint is known to emit. Matched exactly, not loosely. */
const MESSAGE_CREDENTIAL_ABSENT = '缺少 apikey 参数'
const MESSAGE_CREDENTIAL_INVALID = 'apikey 无效或已失效'

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Build a `163_search` URL.
 *
 * The returned URL is what the caller fetches. `apikey` is appended by the caller, not here, so
 * this module can stay free of credential handling.
 *
 * `limit` is clamped to `CHKSZ_SEARCH_MAX_LIMIT` rather than rejected, because a caller asking
 * for more results than the project is willing to request in one call is making a sizing
 * decision, not a contract violation. A non-integer or negative `offset` is rejected, because
 * silently coercing it would turn a caller bug into a wrong page of results.
 */
export function buildChkszSearchUrl(
  keyword: string,
  options: { limit?: number; offset?: number } = {},
): URL | null {
  const trimmed = typeof keyword === 'string' ? keyword.trim() : ''
  if (trimmed.length === 0) return null

  const { limit, offset } = options

  let effectiveLimit = CHKSZ_SEARCH_DEFAULT_LIMIT
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit <= 0) return null
    effectiveLimit = Math.min(limit, CHKSZ_SEARCH_MAX_LIMIT)
  }

  let effectiveOffset = 0
  if (offset !== undefined) {
    if (!Number.isSafeInteger(offset) || offset < 0) return null
    effectiveOffset = offset
  }

  const url = new URL(CHKSZ_SEARCH_ENDPOINT)
  url.searchParams.set('keyword', trimmed)
  url.searchParams.set('limit', String(effectiveLimit))
  if (effectiveOffset > 0) url.searchParams.set('offset', String(effectiveOffset))
  return url
}

/**
 * Classify a non-200 response.
 *
 * Every failure on this endpoint is a `401`, so the status alone cannot distinguish an absent
 * credential from a rejected one. When the body carries a gate message, that message is
 * authoritative; when it does not, the classification falls back to the status code and is
 * deliberately conservative.
 */
export function classifyChkszSearchFailure(
  status: number,
  body: unknown,
): ChkszSearchFailureReason {
  const message = isObject(body) && typeof body.msg === 'string' ? body.msg : ''

  if (status === 401 || status === 403) {
    if (message.includes(MESSAGE_CREDENTIAL_INVALID)) return 'credential_invalid'
    if (message.includes(MESSAGE_CREDENTIAL_ABSENT)) return 'credential_absent'
    // A 401 with no recognisable gate message is still a credential problem, but which one is
    // unknown. Reporting `credential_absent` would send an operator to configure a key that may
    // already exist, so the safer default is the one that says "a credential was refused".
    return status === 401 ? 'credential_invalid' : 'forbidden'
  }

  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'unavailable'
  return 'invalid_response'
}

/**
 * Read the artist display string from a candidate.
 *
 * Accepts a bare string (the documented shape for this endpoint) or an array of strings, an
 * array of `{ name }` objects (the shape the same vendor documents for `163_playlist`), or any
 * mixture. Unknown entries are dropped rather than stringified into `[object Object]`, which
 * would otherwise survive into a title comparison as a plausible-looking token.
 */
function readArtists(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''

  const names: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.trim()) names.push(entry.trim())
    } else if (isObject(entry) && typeof entry.name === 'string' && entry.name.trim()) {
      names.push(entry.name.trim())
    }
  }
  return names.join(', ')
}

/**
 * Validate and normalise a `200` search body.
 *
 * Returns `null` when the envelope is not a successful search response. Individual malformed
 * candidates are dropped rather than failing the whole page: one bad entry in a page of 100
 * should not discard the other 99, and a dropped candidate can never be mistaken for a match.
 *
 * An id is required and must be a positive safe integer, because it becomes `163_music`'s `id`.
 * A candidate with no usable id cannot be resolved and is therefore not a candidate at all.
 */
export function parseChkszSearchResponse(
  value: unknown,
): { candidates: ChkszSearchCandidate[]; total: number | null } | null {
  if (!isObject(value) || value.code !== 200 || !isObject(value.data)) return null

  const songs = value.data.songs
  if (!Array.isArray(songs)) return null

  const candidates: ChkszSearchCandidate[] = []
  for (const song of songs) {
    if (!isObject(song)) continue

    const rawId = song.id
    if (typeof rawId !== 'number' || !Number.isSafeInteger(rawId) || rawId <= 0) continue

    const name = typeof song.name === 'string' ? song.name.trim() : ''
    if (name.length === 0) continue

    const rawDuration = song.duration
    const durationMs =
      typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration > 0
        ? Math.round(rawDuration)
        : null

    candidates.push({
      id: String(rawId),
      name,
      artists: readArtists(song.artists),
      album: typeof song.album === 'string' ? song.album.trim() : '',
      durationMs,
      picUrl: typeof song.picUrl === 'string' ? song.picUrl.trim() : '',
    })
  }

  const rawTotal = value.data.total
  const total =
    typeof rawTotal === 'number' && Number.isSafeInteger(rawTotal) && rawTotal >= 0
      ? rawTotal
      : null

  return { candidates, total }
}

/** Convenience wrapper: turn a status-plus-body pair into the discriminated result. */
export function interpretChkszSearchResponse(
  status: number,
  body: unknown,
): ChkszSearchResult {
  if (status === 200) {
    const parsed = parseChkszSearchResponse(body)
    if (!parsed) {
      return { ok: false, reason: 'invalid_response', message: 'unrecognised search envelope' }
    }
    return { ok: true, candidates: parsed.candidates, total: parsed.total }
  }

  const reason = classifyChkszSearchFailure(status, body)
  const message = isObject(body) && typeof body.msg === 'string' ? body.msg : `HTTP ${status}`
  return { ok: false, reason, message }
}
