// H-01 (D1 = B): the operator LX allow-list and the CSP source matching that mirrors it.
//
// One module serves both sides of the same decision. `vite.config.ts` validates
// `LX_ALLOWED_ORIGINS` here and appends the result to `connect-src` and `media-src`; the client
// receives the exact emitted `connect-src`/`media-src` source lists as a build-time constant and
// matches LX targets against them with `cspSourcesAllow`, so a request or media URL the document
// policy would refuse fails early with `csp_blocked` instead of reaching the browser.
import { isBlockedIpv4 } from './publicAddress'
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

const CLIENT_BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'home.arpa',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'metadata.azure.internal',
])

const CLIENT_BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.corp',
  '.home.arpa',
  '.intranet',
  '.home',
  '.private',
  '.localdomain',
] as const

// URL.hostname already canonicalises IPv6, including dotted IPv4 tails. Outside the
// global-unicast prefix this also excludes mapped, compatible and translation forms.
const isPublicIpv6 = (bracketed: string): boolean => {
  const [firstHex, secondHex, thirdHex] = bracketed.slice(1, -1).split(':')
  const first = Number.parseInt(firstHex || '0', 16)
  const second = Number.parseInt(secondHex || '0', 16)
  const third = Number.parseInt(thirdHex || '0', 16)
  if ((first & 0xe000) !== 0x2000 || first === 0x2002) return false // global unicast, excluding 6to4
  if (first === 0x3fff && second < 0x1000) return false // documentation /20
  if (first !== 0x2001) return true
  return second !== 0 && second !== 0x0db8 && // Teredo and documentation
    !(second === 2 && third === 0) && // benchmarking /48
    (second & 0xfff0) !== 0x10 && (second & 0xfff0) !== 0x20 // ORCHID identifiers
}

/**
 * Initial-URL guard enforced when `LX_ALLOW_ALL_HTTPS` (`'https:'`) is active.
 * Permits credential-free HTTPS `selfOrigin`, and blocks private/loopback/link-local/
 * CGNAT/reserved IPv4, special-use and IPv4-embedded IPv6, `localhost`,
 * single-label hosts, and internal suffixes while permitting public HTTPS hosts & public IPv4.
 * This is a lexical check: it does not resolve DNS or inspect native media redirects.
 */
export function isPublicHttpsTarget(url: URL, selfOrigin?: string): boolean {
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (selfOrigin && url.origin === selfOrigin) return true

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (!hostname) return false

  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return isPublicIpv6(hostname)
  }
  if (hostname.includes(':')) return false
  if (CLIENT_BLOCKED_HOSTNAMES.has(hostname)) return false
  if (CLIENT_BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false
  if (!hostname.includes('.')) return false

  if (/^\d+(?:\.\d+){3}$/u.test(hostname)) {
    return !isBlockedIpv4(hostname)
  }

  const labels = hostname.split('.')
  const last = labels[labels.length - 1] ?? ''
  if (/^\d+$/u.test(last) || /^0x[0-9a-f]+$/iu.test(last)) return false
  return labels.every((label) => LABEL.test(label))
}

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
  // Scheme-source: matches public HTTPS hosts, public IP literals and ports, while blocking
  // loopback/private/link-local/CGNAT/internal targets (except explicit selfOrigin).
  if (source === LX_ALLOW_ALL_HTTPS) return isPublicHttpsTarget(target, selfOrigin)
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
  // In scheme mode the public-target decision governs the entire directive, including 'self'.
  if (sources.includes(LX_ALLOW_ALL_HTTPS)) return isPublicHttpsTarget(target, selfOrigin)
  return sources.some((source) => cspSourceAllows(source, target, selfOrigin))
}

/** The stable prefix of every LX policy refusal; `lxUser.ts` maps it to the `csp_blocked` code. */
export const LX_CSP_BLOCKED = 'csp_blocked'

/**
 * Reviewed public HTTPS-capable music CDN suffixes observed in real LX sources whose plaintext
 * `http:` URLs may be promoted to `https:` before `<audio>` probe verification.
 */
export const LX_PROMOTABLE_MEDIA_HOST_SUFFIXES: readonly string[] = Object.freeze([
  CHKSZ_MEDIA_HOST_SUFFIX,
  '.kuwo.cn',
  '.kugou.com',
  '.qqmusic.qq.com',
  '.tc.qq.com',
  '.migu.cn',
])

export function isPromotableLxMediaHostname(hostname: string): boolean {
  if (hostname.length > 253 || hostname !== hostname.toLowerCase()) return false
  const matchedSuffix = LX_PROMOTABLE_MEDIA_HOST_SUFFIXES.find(
    (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
  )
  if (!matchedSuffix) return false
  return hostname.split('.').every((label) =>
    label !== '' && !label.startsWith('xn--') && LABEL.test(label))
}

/**
 * Promotes a plaintext media URL to HTTPS, but only for reviewed public HTTPS-capable music CDN
 * suffixes.
 *
 * The rule is deliberately narrow, because "rewrite the scheme of an arbitrary URL" is a policy
 * bypass waiting to happen:
 *   - only `http:` → `https:`; every other scheme and every already-HTTPS URL returns `null`
 *   - only hosts accepted by `isPermittedMusicHostname` or `isPromotableLxMediaHostname`
 *     (non-punycode public LDH subdomains under the reviewed music CDN suffixes)
 *   - no credentials, no explicit port, no fragment; the path, the signed path segments and the
 *     whole query string are preserved byte for byte
 *   - an IP literal or private/internal host can never match
 *
 * Callers must still gate the promoted URL against `media-src` (`isLxTargetAllowed`) and verify
 * playability via `mediaProbe` before committing to it.
 */
export function upgradeLxMediaUrlToHttps(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  if (RAW_CONTROL_CHARACTER.test(raw) || raw.includes('\\')) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:') return null
  if (parsed.username || parsed.password || parsed.port || parsed.hash) return null
  if (!isPermittedMusicHostname(parsed.hostname) && !isPromotableLxMediaHostname(parsed.hostname)) return null

  const upgraded = new URL(parsed.toString())
  upgraded.protocol = 'https:'
  // `URL` normalises an `http:` origin's default port away and keeps path/query untouched.
  return upgraded.toString()
}
