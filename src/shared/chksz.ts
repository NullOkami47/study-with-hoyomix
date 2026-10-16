/**
 * The single ChKSz validation policy, shared by the browser provider and the
 * Cloudflare Worker resolver.
 *
 * Browser-safe and dependency-free by construction: no secrets, no environment
 * access, no storage access. The Worker and the client must never drift into
 * different rules about what counts as a valid ChKSz response or media URL.
 *
 * Extracted from `workers/providers/routes.ts`. Every protection present there is
 * preserved; the only strengthening is that an empty redirect location is treated
 * as invalid rather than as a self-redirect.
 */

export const CHKSZ_API_ORIGIN = 'https://api.chksz.com'
export const CHKSZ_MUSIC_ENDPOINT = `${CHKSZ_API_ORIGIN}/api/163_music`
export const CHKSZ_MEDIA_HOST_SUFFIX = '.music.126.net'
export const CHKSZ_ID_PATTERN = /^[0-9]{1,20}$/
export const CHKSZ_LEVEL = 'standard'
export const CHKSZ_KEY_PREFIX = 'chksz_'

export const CHKSZ_QUALITIES = [
  'standard',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'jymaster',
] as const

export type ChkszQuality = typeof CHKSZ_QUALITIES[number]

export function isChkszQuality(value: unknown): value is ChkszQuality {
  return typeof value === 'string' && (CHKSZ_QUALITIES as readonly string[]).includes(value)
}

/**
 * The accepted body of the Worker owner-fallback resolve request.
 *
 * `level` is optional so an already-deployed client that posts only `{ externalId }` keeps
 * working; a missing level resolves at the historical `standard`. A level that *is* supplied
 * must be one of the seven ChKSz tiers — an unrecognised value is a client contract violation
 * and must be rejected, never quietly downgraded to `standard`.
 *
 * The permitted key set is closed. This request authorises spending the Owner credential, so an
 * unexpected key is refused rather than ignored: that keeps the body from being used as a channel
 * for credential overrides or upstream redirection, and it keeps the contract explicit.
 */
export type ChkszResolveBody = {
  externalId: string
  level: ChkszQuality
}

/**
 * Validate a parsed owner-fallback resolve body.
 *
 * Returns the effective `{ externalId, level }`, or `null` when the body is not a plain object,
 * carries a key outside `externalId`/`level`, fails the id pattern, or supplies a level that is
 * not a ChKSz quality. `CHKSZ_ID_PATTERN` is deliberately not re-declared here: the caller passes
 * its own pattern so this module stays the single source of the *shape* rule while the id rule
 * remains shared.
 */
export function validateChkszResolveBody(
  value: unknown,
  idPattern: RegExp = CHKSZ_ID_PATTERN,
): ChkszResolveBody | null {
  if (!isObject(value)) return null

  for (const key of Object.keys(value)) {
    if (key !== 'externalId' && key !== 'level') return null
  }

  const { externalId, level } = value as { externalId?: unknown; level?: unknown }
  if (typeof externalId !== 'string' || !idPattern.test(externalId)) return null

  // An omitted level is the documented backward-compatible default. An explicitly supplied value
  // — including `null` — is validated rather than defaulted, so a bad tier cannot be masked.
  if (level === undefined) return { externalId, level: CHKSZ_LEVEL }
  if (!isChkszQuality(level)) return null

  return { externalId, level }
}

export function chkszLevel(quality: ChkszQuality | 'high'): ChkszQuality {
  switch (quality) {
    case 'standard': return 'standard'
    case 'high':
    case 'exhigh': return 'exhigh'
    case 'lossless': return 'lossless'
    case 'hires': return 'hires'
    case 'jyeffect': return 'jyeffect'
    case 'sky': return 'sky'
    case 'jymaster': return 'jymaster'
  }
}

/** Bounded response parsing ceiling for the ChKSz metadata body. */
export const CHKSZ_MAX_RESPONSE_BYTES = 64 * 1024

/** Maximum accepted API key length; matches the credential store and the Worker. */
export const CHKSZ_KEY_MAX_LENGTH = 512

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const ABSOLUTE_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(?:[/?#]|$)/
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const NETWORK_PATH = /^\/\/([^/?#]*)(?:[/?#]|$)/
const UNSAFE_URL_CHARACTERS = /[\u0000-\u0020\u007f\\]/
const UNSAFE_REDIRECT_CHARACTERS = /[^\u0021-\u007e]/

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The failure codes a ChKSz HTTP status can truthfully produce. Deliberately a local union rather
 * than the player's `ResolveFailureCode`, so this module stays free of feature-layer imports; every
 * member is also a member of `ResolveFailureCode`.
 */
export type ChkszFailureCode =
  | 'invalid_response'
  | 'invalid_credential'
  | 'quota_exhausted'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'unavailable'

/**
 * Map an upstream HTTP status to the truthful failure code, or `null` for 200.
 *
 * Both the browser-direct path and the Worker fallback use this table, so a 402 cannot be reported
 * as a generic outage by one and truthfully by the other. 402, 403 and 404 keep their own meaning.
 */
export function chkszFailureCode(status: number): ChkszFailureCode | null {
  if (status === 200) return null
  switch (status) {
    case 400: return 'invalid_response'
    case 401: return 'invalid_credential'
    case 402: return 'quota_exhausted'
    case 403: return 'forbidden'
    case 404: return 'not_found'
    case 429: return 'rate_limited'
    case 503: return 'unavailable'
    default:
      if (status >= 500) return 'unavailable'
      if (status >= 400) return 'invalid_response'
      return 'invalid_response'
  }
}

/** A NetEase track id as ChKSz accepts it. */
export function isChkszExternalId(value: unknown): value is string {
  return typeof value === 'string' && CHKSZ_ID_PATTERN.test(value)
}

/**
 * The owner-provided contract fixes the key prefix. No narrower suffix alphabet is
 * assumed, because the supplied documentation does not establish one: only
 * non-empty, length-bounded, trimmed, header/ByteString-safe, `chksz_`-prefixed
 * with a non-empty suffix. Keys are never normalised or silently altered.
 */
export function isChkszApiKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > CHKSZ_KEY_MAX_LENGTH) return false
  if (value !== value.trim()) return false
  // Header/ByteString safety: no control characters, no characters above latin-1.
  if (/[\u0000-\u001f\u007f]|[^\x00-\xff]/.test(value)) return false
  if (!value.startsWith(CHKSZ_KEY_PREFIX)) return false
  return value.length > CHKSZ_KEY_PREFIX.length
}

/**
 * HTTPS only, lowercase, a real subdomain, and the exact `.music.126.net` suffix
 * with valid DNS labels and no punycode.
 */
export function isPermittedMusicHostname(hostname: string): boolean {
  if (
    hostname.length > 253 || hostname !== hostname.toLowerCase() ||
    !hostname.endsWith(CHKSZ_MEDIA_HOST_SUFFIX)
  ) return false

  const subdomain = hostname.slice(0, -CHKSZ_MEDIA_HOST_SUFFIX.length)
  if (!subdomain) return false
  return hostname.split('.').every((label) =>
    label !== '' && !label.startsWith('xn--') && DNS_LABEL.test(label))
}

const isPermittedRawAuthority = (authority: string) =>
  authority !== '' && !authority.includes('%') && !authority.includes('@') &&
  !authority.includes(':') && !authority.includes('\\') &&
  isPermittedMusicHostname(authority)

const validateParsedAudioUrl = (parsed: URL, rawAuthority?: string): URL | null => {
  if (
    parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash ||
    !isPermittedMusicHostname(parsed.hostname) ||
    (rawAuthority !== undefined && (parsed.hostname !== rawAuthority || parsed.host !== rawAuthority))
  ) return null
  return parsed
}

/** An absolute HTTPS media URL on a permitted host, or `null`. */
export function validateChkszMediaUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || UNSAFE_URL_CHARACTERS.test(value)) return null

  const raw = ABSOLUTE_URL.exec(value)
  if (!raw || raw[1]!.toLowerCase() !== 'https' || !isPermittedRawAuthority(raw[2]!)) return null

  try {
    return validateParsedAudioUrl(new URL(value), raw[2]!)
  } catch {
    return null
  }
}

/**
 * Resolve a redirect target against the same policy. Absolute, protocol-relative
 * and relative locations are supported; anything off-policy yields `null`.
 */
export function resolveChkszRedirect(location: string, current: URL): URL | null {
  if (location === '') return null
  if (UNSAFE_REDIRECT_CHARACTERS.test(location) || location.includes('\\')) return null
  if (URL_SCHEME.test(location)) return validateChkszMediaUrl(location)

  if (location.startsWith('//')) {
    const raw = NETWORK_PATH.exec(location)
    if (!raw || !isPermittedRawAuthority(raw[1]!)) return null
    try {
      return validateParsedAudioUrl(new URL(`${current.protocol}${location}`), raw[1]!)
    } catch {
      return null
    }
  }

  try {
    return validateParsedAudioUrl(new URL(location, current))
  } catch {
    return null
  }
}

/**
 * Validate an artwork URL from ChKSz metadata.
 *
 * Enforces:
 * - string, no control characters or spaces
 * - HTTPS protocol only
 * - no credentials (username/password), port, or hash
 * - hostname must strictly satisfy isPermittedMusicHostname (*.music.126.net)
 * - query must not contain apikey or sensitive parameters
 */
export function validateChkszArtworkUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || UNSAFE_URL_CHARACTERS.test(value)) return null

  const raw = ABSOLUTE_URL.exec(value)
  if (!raw || raw[1]!.toLowerCase() !== 'https' || !isPermittedRawAuthority(raw[2]!)) return null

  try {
    const parsed = new URL(value)
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash ||
      !isPermittedMusicHostname(parsed.hostname) ||
      parsed.searchParams.has('apikey') ||
      parsed.searchParams.has('api_key')
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export const CHKSZ_ARTWORK_PROXY_PATH = '/api/providers/chksz/artwork'

/**
 * Builds the safe same-origin proxy URL for a validated ChKSz artwork URL.
 * Returns null if the URL fails validation or contains unsafe parameters.
 */
export function createChkszArtworkProxyUrl(upstreamUrl: string | URL): string | null {
  const candidate = typeof upstreamUrl === 'string' ? upstreamUrl : upstreamUrl.toString()
  const validated = validateChkszArtworkUrl(candidate)
  if (!validated) return null
  return `${CHKSZ_ARTWORK_PROXY_PATH}?url=${encodeURIComponent(validated.toString())}`
}

export interface ValidatedChkszPlaybackPayload {
  mediaUrl: URL
  level: ChkszQuality
  bitrate?: number
  artworkUrl?: string
}

/**
 * Validate the HTTP-200 ChKSz metadata body and extract validated presentation and playback fields.
 *
 * Verifies the requested external id and level, extracts the media URL, and safely extracts
 * available quality properties (bitrate in bps) and validated artwork URL.
 */
export function validateChkszPlaybackMetadata(
  value: unknown,
  requestedId: string,
  requestedLevel: string,
): ValidatedChkszPlaybackPayload | null {
  if (!isObject(value) || value.code !== 200 || !isObject(value.data)) return null
  const data = value.data
  if (
    typeof data.id !== 'number' || !Number.isSafeInteger(data.id) ||
    String(data.id) !== requestedId || typeof data.level !== 'string' ||
    data.level !== requestedLevel || !isChkszQuality(data.level) ||
    typeof data.url !== 'string'
  ) return null

  const mediaUrl = validateChkszMediaUrl(data.url)
  if (!mediaUrl) return null

  const bitrate = typeof data.br === 'number' && Number.isSafeInteger(data.br) && data.br > 0
    ? data.br
    : undefined

  const validatedArtwork = typeof data.picUrl === 'string'
    ? validateChkszArtworkUrl(data.picUrl)
    : null

  return {
    mediaUrl,
    level: data.level,
    ...(bitrate !== undefined ? { bitrate } : {}),
    ...(validatedArtwork !== null ? { artworkUrl: validatedArtwork.toString() } : {}),
  }
}

/**
 * Validate the HTTP-200 ChKSz metadata body against the requested external id and level.
 * Unrelated extra metadata is ignored. Returns the validated media URL or `null`.
 *
 * `requestedLevel` is required rather than defaulted. It used to default to `standard`, which is
 * exactly the shape of the defect this contract closes: a caller that forgot to pass the level
 * silently accepted an upstream response at the wrong tier. Requiring it makes that omission a
 * compile error instead of a quiet downgrade.
 */
export function validateChkszMetadata(
  value: unknown,
  requestedId: string,
  requestedLevel: string,
): URL | null {
  return validateChkszPlaybackMetadata(value, requestedId, requestedLevel)?.mediaUrl ?? null
}
