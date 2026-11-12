/**
 * Debug log core (task 41.1, renamed by 41.8): a bounded, in-memory ring buffer of player, media,
 * page and error events that the listener can export for the developer. It is a diagnostic log,
 * not a listening history.
 *
 * Diagnostic only. Recording never throws and never changes playback. Every value is reduced to a
 * primitive, strings are bounded, and anything that looks like a URL is replaced by its origin plus
 * a short hash of its path, so query strings (media tickets, keys, tokens) never enter the buffer.
 * Bearer tokens, whole Authorization header values, cookie-like strings, `secret=value` pairs, JWTs, ChKSz keys and email addresses
 * are redacted as well, and a last generic pass hashes any other token that looks like credential
 * material (long letter-and-digit runs) to `[secret#<hash>]`. The global capture (errors, console, API calls, Service Worker) lives in
 * `debugLog.ts`, which also re-exports this module under the debug-log names.
 */

export const DEBUG_LOG_FORMAT = 'hoyomix-debug-log'
/** @deprecated Kept for 41.1 call sites; the document format is now {@link DEBUG_LOG_FORMAT}. */
export const PLAYBACK_LOG_FORMAT = DEBUG_LOG_FORMAT
export const PLAYBACK_LOG_VERSION = 1
export const PLAYBACK_LOG_CAPACITY = 500
export const PLAYBACK_LOG_SESSION_KEY = 'hoyomix.debugLog.v1'
/** The 41.1 sessionStorage key. Read once and removed, so a build upgrade keeps the old buffer. */
export const LEGACY_PLAYBACK_LOG_SESSION_KEY = 'hoyomix.playbackLog.v1'
const MAX_STRING_LENGTH = 200
/** Raw input is cut to this before redaction, so a huge string cannot make the patterns slow. */
const MAX_INPUT_LENGTH = 2_000
const MAX_FIELDS = 24

export type PlaybackLogValue = string | number | boolean | null
export interface PlaybackLogEntry {
  /** Wall-clock time, epoch milliseconds. */
  t: number
  /** `performance.now()` at record time (monotonic within one page load). */
  mono: number
  type: string
  [field: string]: PlaybackLogValue
}

export interface PlaybackLogEnvironment {
  build: Record<string, string> | null
  userAgent: string
  displayMode: 'standalone' | 'browser' | 'unknown'
  visibilityState: string
  /** The fields below are the 41.8 environment snapshot; `debugLog.ts` fills them at export. */
  standalone?: boolean | null
  locale?: string | null
  online?: boolean | null
  connection?: { effectiveType: string | null; downlink: number | null; saveData: boolean | null } | null
  deviceMemory?: number | null
  hardwareConcurrency?: number | null
  /** `performance.memory` (Chromium only), in MiB. */
  memory?: { usedJsHeapMiB: number; jsHeapLimitMiB: number } | null
  serviceWorker?: { supported: boolean; controller: boolean; controllerState: string | null } | null
  player?: Record<string, PlaybackLogValue | string[]> | null
}

export interface PlaybackLogDocument extends PlaybackLogEnvironment {
  format: typeof DEBUG_LOG_FORMAT
  version: typeof PLAYBACK_LOG_VERSION
  exportedAt: string
  entries: PlaybackLogEntry[]
}

export interface PlaybackLog {
  record(type: string, fields?: Record<string, unknown>): void
  snapshot(): PlaybackLogEntry[]
  clear(): void
  /** Entries restored from an earlier page (sessionStorage) go first, oldest dropped at capacity. */
  restore(entries: readonly unknown[]): number
  exportDocument(environment?: PlaybackLogEnvironment): PlaybackLogDocument
  exportJson(environment?: PlaybackLogEnvironment): string
  readonly capacity: number
}

export interface PlaybackLogOptions {
  capacity?: number
  now?: () => number
  mono?: () => number
}

/** FNV-1a, 32 bit, as 8 hex digits. Enough to tell paths apart in one log; not reversible in practice. */
export function shortHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The forms {@link redactMediaUrl} produces, which it returns unchanged so redaction is idempotent. */
const REDACTED_URL_PATTERN = /^(?:https?:\/\/(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?#[0-9a-f]{8}|[a-z][a-z0-9+.-]*:#redacted|url#[0-9a-f]{8})$/u

/**
 * A media URL as `origin#<path hash>`. Query string, fragment and credentials are dropped; a
 * non-network URL (blob:, data:) keeps only its scheme. An unparsable value is hashed whole.
 */
export function redactMediaUrl(value: string): string {
  // Already redacted (a restored entry, or a `src` from `describeMediaElement` being recorded):
  // hashing again would hash `/` and give every path the same value.
  if (REDACTED_URL_PATTERN.test(value)) return value
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.origin}#${shortHash(url.pathname)}`
    return `${url.protocol}#redacted`
  } catch {
    return `url#${shortHash(value)}`
  }
}

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu
const QUERY_PATTERN = /[?&][^\s=&]+=[^\s&]*/gu
const BEARER_PATTERN = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu
/**
 * An `Authorization` / `Proxy-Authorization` header or field, whatever the scheme (`Token x`,
 * `Digest username="u", response="r"`, a custom scheme). A quoted value is redacted whole; an
 * unquoted one runs to the end of the line or the next `;`, `,` or `}`, where a comma that starts
 * another `name=value` auth parameter (Digest, AWS) still belongs to the credential.
 */
const AUTHORIZATION_PATTERN = /(?<![\w-])(["']?)((?:proxy-)?authorization)\1(\s*[:=]\s*)(?!\s*\[redacted\])(?:"(?:[^"\\]|\\.)*(?:"|\\?$)|'(?:[^'\\]|\\.)*(?:'|\\?$)|(?:[^\r\n;,}"']|"(?:[^"\\\r\n]|\\.)*"?|,(?=[ \t]*[A-Za-z][\w-]*[ \t]*=))+)/giu
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/gu
/**
 * A ChKSz key as `isChkszApiKey` (src/shared/chksz.ts) accepts it: the `chksz_` prefix and any
 * non-empty printable latin-1 suffix of up to {@link CHKSZ_KEY_MAX_LENGTH} characters, which may
 * start with or contain spaces, quotes and delimiters (`chksz_;x`, `chksz_ x y`). So everything
 * after a `chksz_` prefix that is not a known code is credential material: it is redacted up to
 * the quote that opened the string just before `chksz_` (a JSON or quoted value) or, unquoted, up
 * to the end of the line, at most the key's maximum length.
 */
const CHKSZ_PREFIX_PATTERN = /(?<![A-Za-z0-9])chksz_/gu
const CHKSZ_KEY_MAX_LENGTH = 512
/** The candidate identifier after `chksz_`, as the known-code check reads it. */
const CHKSZ_IDENTIFIER_RUN = /^[^\s"'`<>,;&()[\]{}\\\u0000-\u001f\u007f\u0100-\uffff]*/u
/**
 * `chksz_*` identifiers the codebase itself emits (error codes and D1 table names), kept readable
 * so a log still names the failure. Derived from the string literals in src/ and workers/.
 */
const CHKSZ_KNOWN_IDENTIFIERS = new Set([
  'chksz_key_required',
  'chksz_dynamic_discoveries',
  'chksz_discovery_locks',
  'chksz_discovery_rate_events',
])
const CHKSZ_KNOWN_TABLES = new Set(['chksz_dynamic_discoveries', 'chksz_discovery_locks', 'chksz_discovery_rate_events'])
const CHKSZ_REDACTED = 'chksz_[redacted]'

function isKnownChkszIdentifier(run: string): boolean {
  // A known code may end a sentence or a label (`chksz_key_required.`, `chksz_key_required:`);
  // a table may be column-qualified.
  if (CHKSZ_KNOWN_IDENTIFIERS.has(run.replace(/[.:!?]+$/u, ''))) return true
  const dot = run.indexOf('.')
  return dot > 0 && CHKSZ_KNOWN_TABLES.has(run.slice(0, dot)) && /^\.[a-z_]+$/u.test(run.slice(dot))
}

/** Redact every ChKSz key in `text`, keeping the known codes and an already-redacted key. */
function redactChkszKeys(text: string): string {
  let result = ''
  let cursor = 0
  CHKSZ_PREFIX_PATTERN.lastIndex = 0
  for (let match = CHKSZ_PREFIX_PATTERN.exec(text); match; match = CHKSZ_PREFIX_PATTERN.exec(text)) {
    const start = match.index
    if (start < cursor) continue
    const suffixStart = start + match[0].length
    if (text.startsWith('[redacted]', suffixStart)) continue
    const run = (CHKSZ_IDENTIFIER_RUN.exec(text.slice(start)) ?? [''])[0]
    if (isKnownChkszIdentifier(run)) {
      CHKSZ_PREFIX_PATTERN.lastIndex = start + Math.max(run.length, match[0].length)
      continue
    }
    const opening = start > 0 ? text[start - 1] : ''
    const quote = opening === '"' || opening === "'" || opening === '`' ? opening : ''
    const limit = Math.min(text.length, suffixStart + CHKSZ_KEY_MAX_LENGTH)
    let end = suffixStart
    while (end < limit) {
      const char = text[end]
      if (char === '\n' || char === '\r') break
      if (quote && char === '\\' && end + 1 < limit) { end += 2; continue }
      if (quote && char === quote) break
      end += 1
    }
    result += text.slice(cursor, start) + CHKSZ_REDACTED
    cursor = Math.min(end, text.length)
    CHKSZ_PREFIX_PATTERN.lastIndex = Math.max(cursor, suffixStart)
  }
  return cursor === 0 ? text : result + text.slice(cursor)
}
/**
 * A `Cookie` / `Set-Cookie` header or field. The name may be quoted (`"set-cookie":`,
 * `'cookie':`); a quoted value is redacted whole up to its closing quote (attributes such as
 * `; HttpOnly` included), an unquoted one up to the end of the line.
 */
const COOKIE_HEADER_PATTERN = /(?<![A-Za-z0-9_])(["']?)(set-cookie|cookie)\1(\s*[:=]\s*)(?!\s*\[redacted\])(?:"(?:[^"\\]|\\.)*(?:"|\\?$)|'(?:[^'\\]|\\.)*(?:'|\\?$)|[^\r\n]*)/giu
/** Two or more `name=value` pairs joined by `;`, the shape of `document.cookie`. */
const COOKIE_LIST_PATTERN = /[\w.-]+=[^;\s]*(?:;\s*[\w.-]+=[^;\s]*)+/gu
/**
 * Secret-like names, as snake_case words. The single source for both the free-text
 * `name=value` redaction ({@link SECRET_PAIR_PATTERN}) and the structured-field check
 * ({@link isSecretFieldName}), so the two cannot drift. Each multi-word name also covers its
 * camelCase, kebab-case and run-together forms (`accessToken`, `access-token`, `accesstoken`).
 */
const SECRET_NAMES: readonly string[] = [
  'ticket', 'token', 'access_token', 'refresh_token', 'id_token', 'api_key', 'key', 'secret',
  'client_secret', 'password', 'passwd', 'session', 'session_id', 'sid', 'auth', 'authorization',
  'credential', 'signature', 'sig', 'cookie',
]
/** Structured field names that are never kept, beyond {@link SECRET_NAMES}: values that hold PII or raw payloads. */
const SECRET_FIELD_ONLY_NAMES: readonly string[] = ['cookies', 'credentials', 'email', 'headers', 'body']

/** Longest first, so a longer name is tried before a name it starts with. */
const SECRET_NAME_ALTERNATION = [...SECRET_NAMES]
  .sort((a, b) => b.length - a.length)
  .map((name) => name.split('_').join('[_-]?'))
  .join('|')
/**
 * `name=value` / `name: value` with a secret-like name. The name may be quoted (`"token":`,
 * `'apiKey':`) and the value may be a single- or double-quoted string, which is redacted whole
 * (escapes included, and up to the end of the input when the closing quote was truncated away).
 */
const SECRET_PAIR_PATTERN = new RegExp(
  String.raw`(?<![\w-])(["']?)(${SECRET_NAME_ALTERNATION})\1(\s*[:=]\s*)(?!\s*\[redacted\])(?:"(?:[^"\\]|\\.)*(?:"|\\?$)|'(?:[^'\\]|\\.)*(?:'|\\?$)|[^\s"',;&)}\]]+)`,
  'giu',
)

const SECRET_FIELD_WORDS: readonly (readonly string[])[] =
  [...SECRET_NAMES, ...SECRET_FIELD_ONLY_NAMES].map((name) => name.split('_'))

/** `accessToken`, `access-token`, `ACCESS_TOKEN`, `APIKey` -> lower-case words. */
function fieldNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
}

/**
 * Whether a structured field's value is never kept. A secret name matches as a run of whole words
 * of the normalised field name (or as one run-together word), so `x-api-key`, `clientSecret` and
 * `refresh_token` are secret while `providerId`, `sourceId`, `trackId` and `signal` stay readable.
 */
export function isSecretFieldName(name: string): boolean {
  const words = fieldNameWords(name)
  return SECRET_FIELD_WORDS.some((secret) => {
    if (secret.length > 1 && words.includes(secret.join(''))) return true
    for (let start = 0; start + secret.length <= words.length; start += 1) {
      if (secret.every((word, offset) => words[start + offset] === word)) return true
    }
    return false
  })
}

function redactSecretPair(match: string, quote: string, name: string, separator: string): string {
  const value = match.slice(quote.length * 2 + name.length + separator.length)
  const valueQuote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : ''
  return `${quote}${name}${quote}${separator}${valueQuote}[redacted]${valueQuote}`
}
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu

/**
 * Generic safeguard, the last pass of {@link sanitizeLogString}: a token that no named pattern
 * recognised but that looks like credential material is replaced by `[secret#<8 hex>]` (its
 * {@link shortHash}, so two mentions of one token still match). A token is a maximal run of
 * `[A-Za-z0-9_\-+/=.%~]` with leading and trailing punctuation set aside; it is credential-like
 * when it is at least 20 characters long and mixes letters and digits, or at least 32 characters
 * long. These stay readable, because they are what the log is for and carry no secret:
 * - UUIDs (track, version and generation ids) and pure hex of up to 40 digits (commit SHAs,
 *   Jellyfin item ids, hashes);
 * - the host of a redacted URL (`https://cdn-1.example.com#89abcdef`);
 * - dotted names, versions and paths whose parts are all short, such as user-agent product
 *   tokens (`Chrome/124.0.6367.82`), module paths and file names. Standard and URL-safe base64
 *   never contain a `.`, so this cannot exempt an encoded secret;
 * - words without digits whose parts are all short (`chksz_discovery_rate_events.created_at`,
 *   long error codes) and lower-case slugs (`zzz-ost-vol-2-some-title`);
 * - runs of fewer than six distinct characters (`xxxx…`, padding, rulers).
 * The markers the other passes write (`[redacted]`, `[email]`, `url#…`, `[secret#…]`) are below the
 * length threshold, so the pass is idempotent.
 */
const CREDENTIAL_RUN_PATTERN = /[A-Za-z0-9_\-+/=.%~]{20,}/gu
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SHORT_HEX_PATTERN = /^[0-9a-f]{1,40}$/iu
const REDACTED_HOST_PATTERN = /^\/\/[a-z0-9.-]+$/u
const REDACTED_HOST_TAIL_PATTERN = /^(?::\d{1,5})?#[0-9a-f]{8}/u
const LOWERCASE_SLUG_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/u
const MAX_READABLE_PART_LENGTH = 16
/** A run of fewer distinct characters (`xxxx…`, `0000…`, `-=-=…`) has no entropy to hide. */
const MIN_SECRET_DISTINCT_CHARACTERS = 6

function isReadableToken(core: string, hasDigit: boolean): boolean {
  if (UUID_PATTERN.test(core) || SHORT_HEX_PATTERN.test(core)) return true
  if (new Set(core).size < MIN_SECRET_DISTINCT_CHARACTERS) return true
  const partsShort = core.split(/[^A-Za-z0-9]+/u).every((part) => part.length <= MAX_READABLE_PART_LENGTH)
  if (!partsShort) return false
  return core.includes('.') || !hasDigit || LOWERCASE_SLUG_PATTERN.test(core)
}

function hashCredentialRun(run: string, offset: number, text: string): string {
  if (REDACTED_HOST_PATTERN.test(run) && REDACTED_HOST_TAIL_PATTERN.test(text.slice(offset + run.length))) return run
  const lead = /^[^A-Za-z0-9]*/u.exec(run)?.[0] ?? ''
  const core = run.slice(lead.length).replace(/[^A-Za-z0-9]+$/u, '')
  if (core.length < 20) return run
  const hasDigit = /[0-9]/u.test(core)
  if (core.length < 32 && !(hasDigit && /[A-Za-z]/u.test(core))) return run
  if (isReadableToken(core, hasDigit)) return run
  return `${lead}[secret#${shortHash(core)}]${run.slice(lead.length + core.length)}`
}

/**
 * Bound a string and redact secrets from it: URLs become origin plus path hash, a stray
 * `?key=value` is dropped, and bearer tokens, JWTs, ChKSz keys, cookies, `secret=value` pairs and
 * email addresses are replaced by a marker. Last, any remaining credential-like token is hashed
 * (see {@link CREDENTIAL_RUN_PATTERN}). Idempotent: sanitising the output again returns it unchanged.
 */
export function sanitizeLogString(value: string): string {
  const input = value.length > MAX_INPUT_LENGTH ? value.slice(0, MAX_INPUT_LENGTH) : value
  const headed = input
    .replace(URL_PATTERN, (match) => redactMediaUrl(match))
    .replace(BEARER_PATTERN, (_match, scheme: string) => `${scheme} [redacted]`)
    .replace(AUTHORIZATION_PATTERN, redactSecretPair)
    .replace(JWT_PATTERN, '[jwt]')
  const redacted = redactChkszKeys(headed)
    .replace(COOKIE_HEADER_PATTERN, redactSecretPair)
    .replace(QUERY_PATTERN, '')
    .replace(COOKIE_LIST_PATTERN, '[cookie]')
    .replace(SECRET_PAIR_PATTERN, redactSecretPair)
    .replace(EMAIL_PATTERN, '[email]')
  const bounded = redacted.length > MAX_STRING_LENGTH ? redacted.slice(0, MAX_STRING_LENGTH) : redacted
  // After the cut, so the token that ends the output is judged as it is written. A replaced
  // token (20+ characters) is longer than its marker, so the result stays within the bound.
  return bounded.replace(CREDENTIAL_RUN_PATTERN, hashCredentialRun)
}

function sanitizeValue(value: unknown, key?: string): PlaybackLogValue | undefined {
  if (value === null) return null
  if (key !== undefined && value !== undefined && isSecretFieldName(key)) return '[redacted]'
  if (typeof value === 'string') return sanitizeLogString(value)
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value)
    return Number.isInteger(value) ? value : Math.round(value * 1000) / 1000
  }
  return undefined
}

function sanitizeFields(fields: Record<string, unknown> | undefined): Record<string, PlaybackLogValue> {
  const result: Record<string, PlaybackLogValue> = {}
  if (!fields) return result
  let count = 0
  for (const [key, raw] of Object.entries(fields)) {
    if (count >= MAX_FIELDS) break
    if (key === 't' || key === 'mono' || key === 'type') continue
    const value = sanitizeValue(raw, key)
    if (value === undefined) continue
    result[key.slice(0, 40)] = value
    count += 1
  }
  return result
}

function defaultMono(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : 0
}

export interface EnvironmentExtras {
  /** The app's selected locale; the page language is used when omitted. */
  locale?: string
  /** A summary of the player state (see `summarizePlayer` in `debugLog.ts`). */
  player?: PlaybackLogEnvironment['player']
}

type ConnectionLike = { effectiveType?: unknown; downlink?: unknown; saveData?: unknown }
type NavigatorExtras = Navigator & {
  connection?: ConnectionLike
  deviceMemory?: unknown
  standalone?: unknown
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null

/** The export header, read from the running page. Safe outside a browser; every probe is optional. */
export function describePlaybackEnvironment(extras: EnvironmentExtras = {}): PlaybackLogEnvironment {
  let displayMode: PlaybackLogEnvironment['displayMode'] = 'unknown'
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      displayMode = window.matchMedia('(display-mode: standalone)').matches ? 'standalone' : 'browser'
    }
  } catch { /* Unknown display mode. */ }
  const nav = typeof navigator !== 'undefined' ? navigator as NavigatorExtras : undefined
  let connection: PlaybackLogEnvironment['connection'] = null
  try {
    const raw = nav?.connection
    if (raw && typeof raw === 'object') {
      connection = {
        effectiveType: typeof raw.effectiveType === 'string' ? sanitizeLogString(raw.effectiveType) : null,
        downlink: finiteOrNull(raw.downlink),
        saveData: typeof raw.saveData === 'boolean' ? raw.saveData : null,
      }
    }
  } catch { /* Not exposed. */ }
  let memory: PlaybackLogEnvironment['memory'] = null
  try {
    const raw = typeof performance !== 'undefined'
      ? (performance as Performance & { memory?: { usedJSHeapSize?: unknown; jsHeapSizeLimit?: unknown } }).memory
      : undefined
    const used = finiteOrNull(raw?.usedJSHeapSize)
    const limit = finiteOrNull(raw?.jsHeapSizeLimit)
    if (used !== null && limit !== null) {
      memory = { usedJsHeapMiB: Math.round(used / 1_048_576), jsHeapLimitMiB: Math.round(limit / 1_048_576) }
    }
  } catch { /* Not exposed. */ }
  let serviceWorker: PlaybackLogEnvironment['serviceWorker'] = null
  try {
    if (nav) {
      const container = 'serviceWorker' in nav ? nav.serviceWorker : undefined
      const controller = container?.controller ?? null
      serviceWorker = {
        supported: Boolean(container),
        controller: Boolean(controller),
        controllerState: controller && typeof controller.state === 'string' ? controller.state : null,
      }
    }
  } catch { /* Not exposed. */ }
  let locale: string | null = extras.locale ?? null
  try {
    if (!locale && typeof document !== 'undefined') locale = document.documentElement?.lang || null
    if (!locale && nav) locale = nav.language || null
  } catch { /* Unknown locale. */ }
  return {
    build: readBuildInfo(),
    userAgent: nav ? sanitizeLogString(String(nav.userAgent ?? '')) : '',
    displayMode,
    visibilityState: typeof document !== 'undefined' ? String(document.visibilityState ?? 'unknown') : 'unknown',
    standalone: nav && typeof nav.standalone === 'boolean' ? nav.standalone : displayMode === 'standalone',
    locale: locale ? sanitizeLogString(locale) : null,
    online: nav && typeof nav.onLine === 'boolean' ? nav.onLine : null,
    connection,
    deviceMemory: finiteOrNull(nav?.deviceMemory),
    hardwareConcurrency: finiteOrNull(nav?.hardwareConcurrency),
    memory,
    serviceWorker,
    player: extras.player ?? null,
  }
}

/** The build identity `src/main.js` publishes from the `build-*` meta tags. */
function readBuildInfo(): Record<string, string> | null {
  const info: Record<string, string> = {}
  try {
    const published = typeof window !== 'undefined'
      ? (window as Window & { __BUILD_INFO__?: Record<string, unknown> }).__BUILD_INFO__
      : undefined
    if (published && typeof published === 'object') {
      for (const key of ['commit', 'buildTime', 'environment']) {
        const value = published[key]
        if (typeof value === 'string' && value) info[key] = sanitizeLogString(value)
      }
    }
    if (!info.commit && typeof document !== 'undefined') {
      for (const [key, name] of [['commit', 'build-commit'], ['buildTime', 'build-time'], ['environment', 'build-env']]) {
        const value = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content')
        if (value) info[key] = sanitizeLogString(value)
      }
    }
  } catch { /* Build info is optional. */ }
  return Object.keys(info).length ? info : null
}

function isEntryLike(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.t === 'number' && typeof entry.mono === 'number' && typeof entry.type === 'string'
}

export function createPlaybackLog(options: PlaybackLogOptions = {}): PlaybackLog {
  const capacity = Math.max(1, Math.floor(options.capacity ?? PLAYBACK_LOG_CAPACITY))
  const now = options.now ?? Date.now
  const mono = options.mono ?? defaultMono
  let entries: PlaybackLogEntry[] = []

  function push(entry: PlaybackLogEntry): void {
    entries.push(entry)
    if (entries.length > capacity) entries.splice(0, entries.length - capacity)
  }

  const log: PlaybackLog = {
    capacity,
    record(type, fields) {
      try {
        push({ ...sanitizeFields(fields), t: now(), mono: Math.round(mono() * 10) / 10, type: sanitizeLogString(type) })
      } catch { /* Logging never affects playback. */ }
    },
    snapshot() {
      return entries.map((entry) => ({ ...entry }))
    },
    clear() {
      entries = []
    },
    restore(restored) {
      const accepted: PlaybackLogEntry[] = []
      for (const candidate of restored) {
        if (!isEntryLike(candidate)) continue
        accepted.push({
          ...sanitizeFields(candidate), t: candidate.t as number, mono: candidate.mono as number,
          type: sanitizeLogString(candidate.type as string), restored: true,
        })
      }
      entries = [...accepted, ...entries]
      if (entries.length > capacity) entries.splice(0, entries.length - capacity)
      return accepted.length
    },
    exportDocument(environment = describePlaybackEnvironment()) {
      return {
        format: DEBUG_LOG_FORMAT,
        version: PLAYBACK_LOG_VERSION,
        exportedAt: new Date(now()).toISOString(),
        ...environment,
        entries: log.snapshot(),
      }
    },
    exportJson(environment) {
      return JSON.stringify(log.exportDocument(environment), null, 1)
    },
  }
  return log
}

/** The app-wide log the player writes to and the diagnostics panel exports. */
export const playbackLog = createPlaybackLog()

export function recordPlayback(type: string, fields?: Record<string, unknown>): void {
  playbackLog.record(type, fields)
}

/** Snapshot of a media element for a log entry. */
export function describeMediaElement(element: HTMLMediaElement | null | undefined): Record<string, unknown> {
  if (!element) return { element: false }
  return {
    deck: element.dataset?.audioDeck ?? null,
    role: element.dataset?.audioRole ?? null,
    elementGen: element.dataset?.playbackGeneration ?? null,
    elementTrackId: element.dataset?.trackId ?? null,
    paused: element.paused,
    muted: element.muted,
    defaultMuted: element.defaultMuted,
    volume: element.volume,
    readyState: element.readyState,
    networkState: element.networkState,
    currentTime: Number.isFinite(element.currentTime) ? element.currentTime : null,
    errorCode: element.error?.code ?? null,
    src: srcOf(element),
  }
}

function srcOf(element: HTMLMediaElement): string | null {
  const raw = element.getAttribute?.('src') || element.currentSrc
  if (!raw) return null
  try {
    return redactMediaUrl(new URL(raw, typeof location !== 'undefined' ? location.href : undefined).href)
  } catch {
    return redactMediaUrl(raw)
  }
}

/** `hoyomix-debug-log-2026-10-28T12-34-56Z.json` */
export function playbackLogFileName(time: number = Date.now()): string {
  const stamp = new Date(time).toISOString().replace(/\.\d{3}Z$/u, 'Z').replace(/:/gu, '-')
  return `hoyomix-debug-log-${stamp}.json`
}

interface LifecycleTargets {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
  document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

let lifecycleInstalls = 0
let lifecycleUninstall: (() => void) | undefined

function defaultLifecycleTargets(): LifecycleTargets | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
  let storage: Storage | null = null
  try { storage = window.sessionStorage } catch { storage = null }
  return { window, document, storage }
}

/**
 * Record page lifecycle events (visibility, pagehide/pageshow, freeze/resume, online/offline,
 * focus/blur) into `log`, keep the buffer in sessionStorage on `pagehide` and restore it once.
 * Reference counted: the listeners stay until the last caller uninstalls.
 */
export function installPlaybackLogLifecycle(
  log: PlaybackLog = playbackLog,
  targets: LifecycleTargets | undefined = defaultLifecycleTargets(),
): () => void {
  if (!targets) return () => {}
  lifecycleInstalls += 1
  if (lifecycleInstalls === 1) lifecycleUninstall = attachLifecycle(log, targets)
  let released = false
  return () => {
    if (released) return
    released = true
    lifecycleInstalls -= 1
    if (lifecycleInstalls === 0) { lifecycleUninstall?.(); lifecycleUninstall = undefined }
  }
}

function attachLifecycle(log: PlaybackLog, targets: LifecycleTargets): () => void {
  const { window: win, document: doc, storage } = targets
  // The current key wins; the 41.1 key is read only when the current one is empty, and both are
  // removed so a buffer is restored at most once.
  for (const key of [PLAYBACK_LOG_SESSION_KEY, LEGACY_PLAYBACK_LOG_SESSION_KEY]) {
    try {
      const stored = storage?.getItem(key)
      if (!stored) continue
      storage?.removeItem(key)
      if (key === PLAYBACK_LOG_SESSION_KEY) storage?.removeItem(LEGACY_PLAYBACK_LOG_SESSION_KEY)
      const parsed: unknown = JSON.parse(stored)
      if (Array.isArray(parsed)) {
        const count = log.restore(parsed)
        if (count) log.record('log.restored', { count, legacy: key === LEGACY_PLAYBACK_LOG_SESSION_KEY })
      }
      break
    } catch { /* A corrupt or denied store starts a fresh log. */ }
  }
  const visibility = () => doc.visibilityState
  const handlers: Array<[Pick<Window, 'addEventListener' | 'removeEventListener'>, string, (event: Event) => void]> = [
    [doc, 'visibilitychange', () => log.record('page.visibilitychange', { visibility: visibility() })],
    [doc, 'freeze', () => log.record('page.freeze', { visibility: visibility() })],
    [doc, 'resume', () => log.record('page.resume', { visibility: visibility() })],
    [win, 'pageshow', (event) => log.record('page.pageshow', {
      persisted: (event as PageTransitionEvent).persisted ?? null, visibility: visibility(),
    })],
    [win, 'pagehide', (event) => {
      log.record('page.pagehide', { persisted: (event as PageTransitionEvent).persisted ?? null, visibility: visibility() })
      try { storage?.setItem(PLAYBACK_LOG_SESSION_KEY, JSON.stringify(log.snapshot())) } catch { /* Quota or denied. */ }
    }],
    [win, 'online', () => log.record('net.online')],
    [win, 'offline', () => log.record('net.offline')],
    [win, 'focus', () => log.record('page.focus', { visibility: visibility() })],
    [win, 'blur', () => log.record('page.blur', { visibility: visibility() })],
  ]
  for (const [target, type, handler] of handlers) target.addEventListener(type, handler)
  log.record('log.lifecycleInstalled', { visibility: visibility() })
  return () => {
    for (const [target, type, handler] of handlers) target.removeEventListener(type, handler)
  }
}
