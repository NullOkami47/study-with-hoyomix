// H-01 (D1 = B): the operator LX allow-list and the CSP source matching that mirrors it.
//
// One module serves both sides of the same decision. `vite.config.ts` validates
// `LX_ALLOWED_ORIGINS` here and appends the result to `connect-src` and `media-src`; the client
// receives the exact emitted `connect-src`/`media-src` source lists as a build-time constant and
// matches LX targets against them with `cspSourcesAllow`, so a request or media URL the document
// policy would refuse fails early with `csp_blocked` instead of reaching the browser.
import { CHKSZ_API_ORIGIN, CHKSZ_MEDIA_HOST_SUFFIX, isPermittedMusicHostname } from './chksz'

/** The `connect-src` and `media-src` source expressions a build emits, in emitted order. */
export interface LxCspSources {
  readonly connect: readonly string[]
  readonly media: readonly string[]
}

/**
 * The lists a build emits with no deployment input (no R2 origin, no analytics, no public origin,
 * no LX origins). Used when no build constant is defined (Vitest, auxiliary harness builds), so a
 * missing constant is the narrowest policy rather than an open one.
 * `responsePolicy.spec.ts` pins this equal to `lxCspSourcesFor({})`.
 */
export const BASE_LX_CSP_SOURCES: LxCspSources = Object.freeze({
  connect: Object.freeze(["'self'", CHKSZ_API_ORIGIN]),
  media: Object.freeze(["'self'", `https://*${CHKSZ_MEDIA_HOST_SUFFIX}`]),
})

export class LxAllowedOriginsError extends Error {
  constructor(readonly problem: string) {
    // Never echoes the value: the rule and the entry position are enough to fix it.
    super(`LX_ALLOWED_ORIGINS ${problem}`)
    this.name = 'LxAllowedOriginsError'
  }
}

// Lower-case LDH label. Upper case is normalised before matching, so it is accepted.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
const RAW_CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/u
/** The one reserved wildcard entry: the `https:` scheme-source (Owner decision: allow all HTTPS). */
export const LX_ALLOW_ALL_HTTPS = 'https:'
const ENTRY_RULE = 'must be an exact HTTPS origin (https://host or https://*.host) or the single reserved ' +
  'entry `https:` (no other bare scheme, global wildcard, path, port, credentials, query or fragment)'

/**
 * Validates one entry and returns its canonical CSP source expression, or null.
 *
 * Accepted: `https://host` and `https://*.host`, where host has at least two LDH labels and a
 * non-numeric top-level label (so IP literals are refused), and `*` may only be the whole leftmost
 * label (the one-subdomain-label wildcard of design option B). Everything else is refused: `*`,
 * `https://*`, `*.com`, other schemes, ports, userinfo, paths (including a trailing `/`), query and
 * fragment. The one exception is exactly `https:` (any case): the scheme-source that lets every
 * HTTPS origin through. It is the only bare scheme accepted.
 */
export function parseLxAllowedOrigin(entry: string): string | null {
  if (RAW_CONTROL_CHARACTER.test(entry) || entry.includes('\\')) return null
  const lower = entry.toLowerCase()
  if (lower === LX_ALLOW_ALL_HTTPS) return LX_ALLOW_ALL_HTTPS
  if (!lower.startsWith('https://')) return null
  const host = lower.slice('https://'.length)
  if (!host || /[/?#@:\[\]%]/u.test(host)) return null
  const labels = host.split('.')
  const wildcard = labels[0] === '*'
  const named = wildcard ? labels.slice(1) : labels
  if (named.length < 2 || !named.every((label) => LABEL.test(label))) return null
  if (/^[0-9]+$/u.test(named[named.length - 1])) return null
  return `https://${host}`
}

/**
 * Parses the comma- and/or whitespace-separated `LX_ALLOWED_ORIGINS` value. Empty means "no LX
 * origins". Throws `LxAllowedOriginsError` on the first invalid entry; duplicates collapse.
 */
export function parseLxAllowedOrigins(raw: string | undefined): string[] {
  const entries = (raw ?? '').split(/[\s,]+/u).filter(Boolean)
  const origins: string[] = []
  entries.forEach((entry, index) => {
    const origin = parseLxAllowedOrigin(entry)
    if (!origin) throw new LxAllowedOriginsError(`entry ${index + 1} ${ENTRY_RULE}`)
    if (!origins.includes(origin)) origins.push(origin)
  })
  return origins
}

/**
 * CSP source matching for the expressions a build emits: `'self'`, `https://host` and
 * `https://*.suffix`. Any other expression (e.g. the `wss:` presence origin) never matches an
 * `https:` target. Like CSP, a source without a port matches only the scheme's default port, a
 * wildcard matches one or more leading labels but not the bare suffix, and the path is ignored.
 */
export function cspSourceAllows(source: string, target: URL, selfOrigin?: string): boolean {
  if (source === "'self'") return Boolean(selfOrigin) && target.origin === selfOrigin
  // Scheme-source: matches every HTTPS host, IP literal and port, as a browser does for `https:`.
  if (source === LX_ALLOW_ALL_HTTPS) return target.protocol === 'https:'
  if (!source.startsWith('https://') || target.protocol !== 'https:' || target.port !== '') return false
  const host = source.slice('https://'.length)
  // CSP3 host-source matching refuses IP literals except 127.0.0.1. Merely adding a
  // public IP (e.g. HYW's API) to a source list cannot make a browser permit it.
  // Keep 'self' above separate: its origin matching can legitimately involve an IP.
  // https://www.w3.org/TR/CSP3/#match-hosts
  if (host.startsWith('[') || (/^\d+(?:\.\d+){3}$/u.test(host) && host !== '127.0.0.1')) return false
  const hostname = target.hostname.toLowerCase()
  if (host.startsWith('*.')) {
    const suffix = host.slice(1)
    return hostname.length > suffix.length && hostname.endsWith(suffix)
  }
  return hostname === host
}

export function cspSourcesAllow(sources: readonly string[], target: URL, selfOrigin?: string): boolean {
  return sources.some((source) => cspSourceAllows(source, target, selfOrigin))
}

/** The stable prefix of every LX policy refusal; `lxUser.ts` maps it to the `csp_blocked` code. */
export const LX_CSP_BLOCKED = 'csp_blocked'

/**
 * Promotes a plaintext media URL to HTTPS, but only for hosts this deployment already trusts for
 * media.
 *
 * Several real LX sources hand back `http://…music.126.net/…` signed URLs. On an HTTPS page those
 * can never play (mixed content, and `media-src` lists only `https:` sources), so before this the
 * provider had to reject them and the track fell through to another source or to Jellyfin. The
 * same CDN answers the identical path over TLS — measured on live and dead URLs alike: when the
 * `http:` form returns 206 the `https:` form returns 206, and when it fails the `https:` form fails
 * too — so the scheme, not the host or the signature, was the whole problem.
 *
 * The rule is deliberately narrow, because "rewrite the scheme of an arbitrary URL" is a policy
 * bypass waiting to happen:
 *   - only `http:` → `https:`; every other scheme and every already-HTTPS URL returns `null`
 *   - only hosts `isPermittedMusicHostname` accepts (`*.music.126.net`), the same validator that
 *     guards ChKSZ media — one list, not two
 *   - no credentials, no explicit port, no fragment; the path, the signed path segments and the
 *     whole query string are preserved byte for byte
 *   - an IP literal can never match, because the validator requires LDH labels under the suffix
 *
 * Callers must still verify the promoted URL plays before using it; this only says it is worth
 * trying.
 */
export function upgradeLxMediaUrlToHttps(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:') return null
  if (parsed.username || parsed.password || parsed.port || parsed.hash) return null
  if (!isPermittedMusicHostname(parsed.hostname)) return null

  const upgraded = new URL(parsed.toString())
  upgraded.protocol = 'https:'
  // `URL` normalises an `http:` origin's default port away and keeps path/query untouched.
  return upgraded.toString()
}
