// The outbound policy for fetching a candidate LX script.
//
// The Admin API fetches a script from a URL the Owner types in. That makes it a server-side request
// forgery surface: without a policy, `https://127.0.0.1/…js` or `https://169.254.169.254/…js` would
// be a request the Worker makes on the Owner's behalf, from Cloudflare's network. So the policy is
// positive rather than negative — a URL is refused unless it is a plain HTTPS URL on a public name —
// and it is applied to the *first* URL and to every redirect, because a redirect is exactly how a
// public-looking URL becomes an internal one.
//
// Redirects are refused outright rather than followed and re-checked. Following means the Worker
// has already sent the request before the destination is known; refusing means the only request that
// is ever made is the one that was validated. A `.js` file behind a redirect is not worth the
// surface.
//
// The body is read through a `ReadableStream` with a hard cap, so a response that lies about (or
// omits) `content-length` cannot make the Worker buffer an unbounded payload.

/** The same bound the sandbox enforces on a script it is asked to load. */
export const LX_MAX_SCRIPT_BYTES = 512 * 1024

/** A source that has not answered in this long is not a source the Owner wants to publish. */
export const LX_FETCH_TIMEOUT_MS = 10_000

export type OutboundRejectionCode =
  | 'invalid_url'
  | 'insecure_url'
  | 'blocked_host'
  | 'redirect_refused'
  | 'too_large'
  | 'not_text'
  | 'fetch_failed'

export interface OutboundRejection {
  code: OutboundRejectionCode
  message: string
}

export type OutboundResult =
  | { ok: true; script: string; finalUrl: string; byteLength: number }
  | { ok: false; rejection: OutboundRejection }

/**
 * IPv4 ranges that are not "somewhere on the public internet": this host, the local network, the
 * carrier-grade NAT range, link-local (which is where cloud metadata services live), documentation
 * and benchmarking ranges, multicast and reserved space.
 */
const IPV4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

const ipv4ToInt = (address: string): number | null => {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

/** True for a dotted-quad address inside a range that must never be fetched. */
export function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToInt(address)
  if (value === null) return false
  return IPV4_BLOCKED.some(([base, bits]) => {
    const baseValue = ipv4ToInt(base)
    if (baseValue === null) return false
    const size = 2 ** (32 - bits)
    return value >= baseValue && value < baseValue + size
  })
}

/** Names that only ever resolve to this machine, a private network, or a metadata service. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'metadata.azure.internal',
])

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.intranet', '.lan', '.corp']

/**
 * True when a hostname must not be fetched.
 *
 * Deliberately strict about anything that is not an ordinary dotted DNS name:
 *   * a bracketed IPv6 literal is refused outright — no legitimate `.js` source is served from one,
 *     and refusing the whole class is simpler to audit than enumerating the private prefixes;
 *   * a single-label name (`intranet`, `metadata`) is refused, because it can only resolve through
 *     local search domains;
 *   * an all-numeric last label (`127.0.0.1`, `2130706433`, `0x7f.0.0.1`) is refused, which covers
 *     the decimal, octal and hexadecimal spellings of a loopback address.
 */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '')
  if (!host) return true
  if (host.startsWith('[') || host.includes(':')) return true
  if (BLOCKED_HOSTNAMES.has(host)) return true
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  if (!host.includes('.')) return true
  const labels = host.split('.')
  const last = labels[labels.length - 1] ?? ''
  if (/^\d+$/u.test(last) || /^0x[0-9a-f]+$/u.test(last)) return true
  if (labels.some((label) => label === '' || label.length > 63)) return true
  return isBlockedIpv4(host)
}

/**
 * Validates a URL for outbound fetching: HTTPS, default port, no credentials, public host, and a
 * `.js` path. Returns the parsed URL so the caller does not re-parse (and cannot disagree).
 */
export function validateOutboundScriptUrl(raw: unknown): { ok: true; url: URL } | { ok: false; rejection: OutboundRejection } {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, rejection: { code: 'invalid_url', message: 'Source URL is required' } }
  }
  const value = raw.trim()
  if (value.length > 2048) {
    return { ok: false, rejection: { code: 'invalid_url', message: 'Source URL is too long' } }
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, rejection: { code: 'invalid_url', message: 'Source URL is not a valid URL' } }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, rejection: { code: 'insecure_url', message: 'Source URL must be HTTPS' } }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, rejection: { code: 'invalid_url', message: 'Source URL must not carry credentials' } }
  }
  if (parsed.port) {
    return { ok: false, rejection: { code: 'invalid_url', message: 'Source URL must use the default HTTPS port' } }
  }
  if (!parsed.pathname.toLowerCase().endsWith('.js')) {
    return { ok: false, rejection: { code: 'invalid_url', message: 'Source URL must point at a .js file' } }
  }
  if (isBlockedHostname(parsed.hostname)) {
    return {
      ok: false,
      rejection: { code: 'blocked_host', message: `Source host ${parsed.hostname} is not a public destination` },
    }
  }
  return { ok: true, url: parsed }
}

/**
 * Reads a response body with a hard cap.
 *
 * `content-length` is checked first because it is free, but it is not trusted: the stream is read
 * chunk by chunk and abandoned the moment the cap is exceeded, so an absent or dishonest header
 * cannot be used to allocate an unbounded buffer.
 */
async function readBounded(response: Response, limit: number, signal: AbortSignal): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; rejection: OutboundRejection }> {
  const declared = response.headers.get('content-length')
  if (declared) {
    const length = Number.parseInt(declared, 10)
    if (Number.isFinite(length) && length > limit) {
      return { ok: false, rejection: { code: 'too_large', message: `Source is ${length} bytes, over the ${limit} byte limit` } }
    }
  }

  if (!response.body) return { ok: true, bytes: new Uint8Array(0) }

  const reader = response.body.getReader()
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw new Error('Source body deadline exceeded')
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        return { ok: false, rejection: { code: 'too_large', message: `Source is over the ${limit} byte limit` } }
      }
      chunks.push(value)
    }
  } catch (error: unknown) {
    return {
      ok: false,
      rejection: { code: 'fetch_failed', message: `The source body could not be read: ${error instanceof Error ? error.message : String(error)}` },
    }
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}

export interface FetchScriptOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
}

/**
 * Fetches a candidate script under the outbound policy.
 *
 * Every failure is a named refusal, never an exception: the Admin API turns the code into an HTTP
 * status and the Owner sees why the import did not happen.
 */
export async function fetchScriptBounded(rawUrl: string, options: FetchScriptOptions = {}): Promise<OutboundResult> {
  const validated = validateOutboundScriptUrl(rawUrl)
  if (!validated.ok) return validated

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? LX_FETCH_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? LX_MAX_SCRIPT_BYTES

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let response: Response
    try {
      response = await fetchImpl(validated.url.toString(), {
        method: 'GET',
        // Not `follow`: the destination of a redirect is never validated before the request is made.
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
        headers: { accept: 'application/javascript, text/javascript, */*' },
      })
    } catch (error: unknown) {
      const aborted = error instanceof Error && error.name === 'AbortError'
      return {
        ok: false,
        rejection: {
          code: 'fetch_failed',
          message: aborted ? `The source did not answer within ${timeoutMs} ms` : `Could not fetch the source: ${error instanceof Error ? error.message : String(error)}`,
        },
      }
    }

    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      return {
        ok: false,
        rejection: {
          code: 'redirect_refused',
          message: 'The source answered with a redirect; publish the final HTTPS URL instead',
        },
      }
    }

    if (!response.ok) {
      return { ok: false, rejection: { code: 'fetch_failed', message: `Source responded with HTTP ${response.status}` } }
    }

    const bounded = await readBounded(response, maxBytes, controller.signal)
    if (!bounded.ok) return bounded

    let script: string
    try {
      script = new TextDecoder('utf-8', { fatal: true }).decode(bounded.bytes)
    } catch {
      return { ok: false, rejection: { code: 'not_text', message: 'Source is not valid UTF-8 text' } }
    }

    return { ok: true, script, finalUrl: response.url || validated.url.toString(), byteLength: bounded.bytes.byteLength }
  } finally {
    clearTimeout(timer)
  }
}
