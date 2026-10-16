import type { CanonicalProviderId } from './config'
import { AUDIO_CONTAINER_MIME, mimeEssence } from './audioContainer'
import type { AudioContainer } from './audioContainer'

const TICKET_TTL_MS = 30_000
const MAX_TICKET_BYTES = 1024
const AUDIO_MIME = /^audio\/[a-z0-9!#$&^_.+-]+$/
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const NONCE_PATTERN = '[A-Za-z0-9_-]{32}'

export interface TransientMediaOptions {
  providerId: CanonicalProviderId
  publicOrigin: string
  externalIdPattern: RegExp
  validateUrl: (value: unknown, current?: URL) => URL | null
  isEffective?: () => Promise<boolean>
  requireMimeMatch?: boolean
  /**
   * Opt in to accepting a generic `application/octet-stream` declaration **when, and only when**
   * the leading bytes positively identify a known audio container.
   *
   * Off unless a provider has been evidenced to need it: the ChKSz CDN serves some higher tiers
   * as `application/octet-stream` despite the body being valid FLAC. Providers that declare proper
   * audio types keep the strict `audio/*` requirement.
   */
  allowGenericAudioTypes?: boolean
  getUpstreamHeaders?: (input: { externalId: string; url: URL }) => HeadersInit | Promise<HeadersInit>
}

export interface TransientMediaDependencies {
  cache?: Pick<Cache, 'match' | 'put'>
  crypto: Crypto
  fetch: typeof fetch
  now: () => number
}

export interface PreparedMediaInput {
  externalId: string
  validatedUrl: URL
  mimeType: string
}

const randomNonce = (cryptoApi: Crypto) => {
  const bytes = cryptoApi.getRandomValues(new Uint8Array(24))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

type RequestedByteRange =
  | { kind: 'closed'; start: bigint; end: bigint }
  | { kind: 'open'; start: bigint }
  | { kind: 'suffix'; length: bigint }

interface SatisfiedContentRange {
  start: bigint
  end: bigint
  total: bigint | null
}

const parseRequestedRange = (value: string): RequestedByteRange | null => {
  const positional = /^bytes=([0-9]+)-([0-9]*)$/.exec(value)
  if (positional) {
    const start = BigInt(positional[1]!)
    if (positional[2] === '') return { kind: 'open', start }
    const end = BigInt(positional[2]!)
    return start <= end ? { kind: 'closed', start, end } : null
  }

  const suffix = /^bytes=-([0-9]+)$/.exec(value)
  if (!suffix) return null
  const length = BigInt(suffix[1]!)
  return length > 0n ? { kind: 'suffix', length } : null
}

const parseContentRange = (value: string): SatisfiedContentRange | null => {
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+|\*)$/.exec(value)
  if (!match) return null
  const start = BigInt(match[1]!)
  const end = BigInt(match[2]!)
  const total = match[3] === '*' ? null : BigInt(match[3]!)
  if (start > end || (total !== null && end >= total)) return null
  return { start, end, total }
}

const contentRangeAnswersRequest = (
  contentRange: SatisfiedContentRange,
  requested: RequestedByteRange,
) => {
  const { start, end, total } = contentRange
  switch (requested.kind) {
    case 'closed': {
      if (start !== requested.start) return false
      const expectedEnd = total !== null && requested.end >= total
        ? total - 1n
        : requested.end
      return end === expectedEnd
    }
    case 'open':
      return start === requested.start && (total === null || end === total - 1n)
    case 'suffix': {
      if (total === null) return false
      const expectedStart = requested.length >= total ? 0n : total - requested.length
      return start === expectedStart && end === total - 1n
    }
  }
}

/**
 * Identify an audio container from its leading bytes, and return a response whose body still
 * contains **all** the original bytes.
 *
 * Returns the container name (never bytes or a byte sequence) plus a replacement `Response` whose
 * body is the prefix followed by the untouched remainder. Callers must use the returned response
 * body for serving; the original body is consumed by this call.
 *
 * The read is bounded to the first chunk. Streams are chained rather than buffered, so a large
 * asset is not held in memory: the prefix is replayed, then the rest is piped through.
 *
 * Recognises the containers this deployment can legitimately serve:
 * - `flac`  — `fLaC` magic
 * - `mp3`   — `ID3` tag, or a bare MPEG audio frame sync
 * - `ogg`, `wav`, `m4a`, `aac`, `ape`, `wma` — other plausible audio
 * - `unknown` — anything else, including a truncated or non-audio prefix
 *
 * A `null` container means the prefix could not be read; the response is returned unread.
 */
const sniffAudioContainer = async (
  response: Response,
): Promise<{ container: AudioContainer | null; response: Response }> => {
  if (!response.body) return { container: null, response }
  try {
    const reader = response.body.getReader()
    const first = await reader.read()
    if (first.done || !first.value || first.value.length === 0) {
      try { await reader.cancel() } catch { /* ignore */ }
      return { container: null, response }
    }
    const prefix = first.value

    // Re-attach the consumed prefix ahead of the remaining stream so nothing is lost.
    const remainder = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) controller.close()
          else controller.enqueue(next.value)
        } catch (error) {
          controller.error(error)
        }
      },
      cancel(reason) { return reader.cancel(reason) },
    })
    const replay = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix)
        controller.close()
      },
    })
    const restoredBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        const pump = async (stream: ReadableStream<Uint8Array>) => {
          const r = stream.getReader()
          while (true) {
            const { done, value } = await r.read()
            if (done) break
            controller.enqueue(value)
          }
        }
        try {
          await pump(replay)
          await pump(remainder)
          controller.close()
        } catch (error) {
          controller.error(error)
        }
      },
    })
    const restored = new Response(restoredBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })

    const ascii = (offset: number, length: number): string => {
      if (prefix.length < offset + length) return ''
      let out = ''
      for (let i = offset; i < offset + length; i += 1) out += String.fromCharCode(prefix[i]!)
      return out
    }

    if (ascii(0, 4) === 'fLaC') return { container: 'flac', response: restored }
    if (ascii(0, 3) === 'ID3') return { container: 'mp3', response: restored }
    if (ascii(0, 4) === 'OggS') return { container: 'ogg', response: restored }
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { container: 'wav', response: restored }
    if (ascii(4, 4) === 'ftyp') return { container: 'm4a', response: restored }
    if (ascii(0, 4) === 'MAC ') return { container: 'ape', response: restored }
    if (ascii(0, 4) === 'wmap') return { container: 'wma', response: restored }
    const b0 = prefix[0]
    const b1 = prefix[1]
    // A bare ADTS AAC frame. Checked *before* the generic MPEG frame sync below, because the ADTS
    // sync word is a subset of that pattern: testing the broad rule first would classify raw AAC
    // as `mp3` and label it `audio/mpeg`. AAC is a niche container here, so the tier whose bytes
    // this sniffer exists to recognise is unaffected — this only keeps the remaining branches
    // honest rather than advertising a container the order made unreachable.
    if (b0 === 0xff && (b1 === 0xf1 || b1 === 0xf9)) {
      return { container: 'aac', response: restored }
    }
    // A bare MPEG-1/2/2.5 audio frame: 11 bits of frame sync.
    if (b0 !== undefined && b1 !== undefined && b0 === 0xff && (b1 & 0xe0) === 0xe0) {
      return { container: 'mp3', response: restored }
    }

    return { container: 'unknown', response: restored }
  } catch {
    // Anything thrown past the point where the prefix was consumed must not be reported as "the
    // response is fine, we just could not name it": by then the original body is partially read,
    // so handing it back would be handing back a disturbed stream. Returning the container slot as
    // `null` keeps the caller's reject path (a `null` container never maps to a MIME), and the
    // response returned here is deliberately an empty one rather than the withered original.
    return { container: null, response: new Response(null, { status: response.status }) }
  }
}

/**
 * A `content-type` the CDN may send when it has no useful type for a perfectly valid audio asset.
 *
 * Only ever accepted together with positive byte-level evidence: see `safeMediaHeaders` and
 * `allowGenericAudioTypes`.
 */
const GENERIC_OCTET_MIME = 'application/octet-stream'

/**
 * Result of the response-header policy check.
 *
 * Returns the *specific* guard that rejected the response, rather than collapsing the two
 * remaining policies (declared-length, range contract) into a single boolean. The MIME decision
 * is deliberately **not** part of this type: it is made earlier, in `resolveAudioMime`. The public
 * response is unchanged either way.
 */
type SafeMediaHeadersResult =
  | { ok: true; headers: Headers }
  | { ok: false; reason: 'content_length_rejected' | 'range_contract_rejected' }

/**
 * Resolve the effective audio MIME type for a response, or `null` when it cannot be trusted.
 *
 * Three cases:
 *
 * 1. A declared `audio/*` type is authoritative — subject to the provider's exact-match rule.
 * 2. A declared **generic** type (`application/octet-stream`) is accepted *only* when the leading
 *    bytes positively identify a known audio container, in which case the returned type is the
 *    container's real type. This is the case the CDN produces for some higher tiers.
 * 3. Anything else — a declared non-audio type, or a generic type whose bytes are not recognisable
 *    audio — is rejected.
 *
 * The allowance is deliberately keyed on **identifying the bytes**, never on loosening the
 * `audio/*` pattern. Accepting a generic type on the strength of its header alone would admit any
 * payload; requiring recognisable audio framing keeps the guard meaningful while no longer
 * refusing a valid asset over a header the CDN omitted.
 *
 * `sniff` is called at most once and only in case 2, so the common paths never read the body.
 */
const resolveAudioMime = async (
  declaredMimeType: string | undefined,
  expectedMimeType: string,
  requireMimeMatch: boolean,
  allowGenericAudio: boolean,
  sniff: () => Promise<AudioContainer | null>,
): Promise<string | null> => {
  if (declaredMimeType && AUDIO_MIME.test(declaredMimeType)) {
    if (requireMimeMatch && declaredMimeType !== expectedMimeType) return null
    return declaredMimeType
  }
  if (!allowGenericAudio || declaredMimeType !== GENERIC_OCTET_MIME) return null

  const container = await sniff()
  const corrected = container ? AUDIO_CONTAINER_MIME[container] : undefined
  return corrected ?? null
}

/**
 * Derive the served response headers from the upstream ones.
 *
 * The MIME type is an **input**, not something decided here: `resolveAudioMime` has already
 * settled it (and rejected the response when it could not). This function owns only the
 * declared-length and range-contract policies. It deliberately takes no `expectedMimeType` /
 * `requireMimeMatch` parameters — accepting them would suggest a MIME guard lives here, and the
 * next change to this function would then be made under a false assumption.
 */
const safeMediaHeaders = (
  upstream: Headers,
  status: number,
  requestedRange: RequestedByteRange | null,
  resolvedMimeType: string,
): SafeMediaHeadersResult => {
  const mimeType = resolvedMimeType

  const contentLength = upstream.get('content-length')
  const contentRange = upstream.get('content-range')
  const acceptRanges = upstream.get('accept-ranges')
  if (
    (contentLength !== null && !/^[0-9]+$/.test(contentLength)) ||
    (acceptRanges !== null && acceptRanges.toLowerCase() !== 'bytes')
  ) return { ok: false, reason: 'content_length_rejected' }

  if (status === 200) {
    if (contentRange !== null) return { ok: false, reason: 'range_contract_rejected' }
  } else {
    if (!requestedRange || contentRange === null) {
      return { ok: false, reason: 'range_contract_rejected' }
    }
    const satisfiedRange = parseContentRange(contentRange)
    if (!satisfiedRange || !contentRangeAnswersRequest(satisfiedRange, requestedRange)) {
      return { ok: false, reason: 'range_contract_rejected' }
    }
    if (
      contentLength !== null &&
      BigInt(contentLength) !== satisfiedRange.end - satisfiedRange.start + 1n
    ) return { ok: false, reason: 'range_contract_rejected' }
  }

  const headers = new Headers({ 'cache-control': 'no-store', 'content-type': mimeType })
  if (contentLength !== null) headers.set('content-length', contentLength)
  if (contentRange !== null) headers.set('content-range', contentRange)
  if (acceptRanges !== null) headers.set('accept-ranges', 'bytes')
  return { ok: true, headers }
}

const requestJson = (request: Request, body: unknown, status: number) => {
  if (request.method !== 'HEAD') return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
  return new Response(null, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
    },
  })
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readBoundedTicket = async (response: Response): Promise<unknown | null> => {
  if (response.headers.get('content-type')?.toLowerCase() !== 'application/json') return null
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_TICKET_BYTES)) {
    return null
  }

  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_TICKET_BYTES) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

export const createTransientMedia = (
  options: TransientMediaOptions,
  dependencies: TransientMediaDependencies,
) => {
  const prepare = async (input: PreparedMediaInput): Promise<{ mimeType: string; url: string } | null> => {
    const canonicalUrl = options.validateUrl(input.validatedUrl.toString())
    if (
      !options.externalIdPattern.test(input.externalId) ||
      !AUDIO_MIME.test(input.mimeType) ||
      !canonicalUrl
    ) return null

    let nonce: string
    if (!dependencies.cache) return null
    try {
      nonce = randomNonce(dependencies.crypto)
    } catch {
      return null
    }

    const encodedExternalId = encodeURIComponent(input.externalId)
    const mediaPath = `/api/providers/${options.providerId}/media/${encodedExternalId}/${nonce}`
    try {
      await dependencies.cache.put(
        new Request(new URL(mediaPath, options.publicOrigin), { method: 'GET' }),
        new Response(JSON.stringify({
          providerId: options.providerId,
          externalId: input.externalId,
          nonce,
          validatedUrl: canonicalUrl.toString(),
          mimeType: input.mimeType,
          expiresAt: dependencies.now() + TICKET_TTL_MS,
        }), {
          headers: {
            'cache-control': 'max-age=30',
            'content-type': 'application/json',
          },
        }),
      )
    } catch {
      return null
    }

    return { mimeType: input.mimeType, url: mediaPath }
  }

  const mediaPath = new RegExp(
    `^/api/providers/${options.providerId}/media/([^/]+)/(${NONCE_PATTERN})$`,
  )

  const serve = async (request: Request, url: URL): Promise<Response> => {
    if (
      url.origin !== options.publicOrigin || url.username || url.password || url.search || url.hash
    ) {
      return requestJson(request, { error: 'invalid_response' }, 400)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json({ error: 'method_not_allowed' }, {
        status: 405,
        headers: { 'cache-control': 'no-store' },
      })
    }

    const match = mediaPath.exec(url.pathname)
    const encodedExternalId = match?.[1]
    const nonce = match?.[2]
    if (!encodedExternalId || !nonce) {
      return requestJson(request, { error: 'invalid_response' }, 400)
    }
    let externalId: string
    try {
      externalId = decodeURIComponent(encodedExternalId)
    } catch {
      return requestJson(request, { error: 'invalid_response' }, 400)
    }
    if (
      encodeURIComponent(externalId) !== encodedExternalId ||
      !options.externalIdPattern.test(externalId)
    ) {
      return requestJson(request, { error: 'invalid_response' }, 400)
    }

    if (options.isEffective) {
      try {
        if (!await options.isEffective()) {
          return requestJson(request, { error: 'unavailable' }, 503)
        }
      } catch {
        return requestJson(request, { error: 'unavailable' }, 503)
      }
    }
    if (!dependencies.cache) return requestJson(request, { error: 'unavailable' }, 503)

    const cacheKey = new Request(new URL(url.pathname, options.publicOrigin), { method: 'GET' })
    let cached: Response | undefined
    try {
      cached = await dependencies.cache.match(cacheKey)
    } catch {
      return requestJson(request, { error: 'unavailable' }, 503)
    }
    if (!cached) return requestJson(request, { error: 'preparation_expired' }, 410)

    const ticket = await readBoundedTicket(cached)
    if (
      !isObject(ticket) || Object.keys(ticket).length !== 6 ||
      ticket.providerId !== options.providerId || ticket.externalId !== externalId ||
      typeof ticket.nonce !== 'string' || ticket.nonce !== nonce ||
      typeof ticket.validatedUrl !== 'string' || typeof ticket.mimeType !== 'string' ||
      !AUDIO_MIME.test(ticket.mimeType) ||
      typeof ticket.expiresAt !== 'number' || !Number.isSafeInteger(ticket.expiresAt)
    ) return requestJson(request, { error: 'invalid_response' }, 502)
    const remainingTtl = ticket.expiresAt - dependencies.now()
    if (remainingTtl <= 0) {
      return requestJson(request, { error: 'preparation_expired' }, 410)
    }
    if (remainingTtl > TICKET_TTL_MS) {
      return requestJson(request, { error: 'invalid_response' }, 502)
    }

    const initialUrl = options.validateUrl(ticket.validatedUrl)
    if (!initialUrl) return requestJson(request, { error: 'invalid_response' }, 502)
    let currentUrl: URL = initialUrl

    const range = request.headers.get('range')
    const requestedRange = range === null ? null : parseRequestedRange(range)
    if (range !== null && !requestedRange) {
      return requestJson(request, { error: 'invalid_response' }, 400)
    }
    const upstreamHeaders = new Headers()
    if (range !== null) upstreamHeaders.set('range', range)
    if (options.getUpstreamHeaders) {
      try {
        const extra = await options.getUpstreamHeaders({ externalId, url: currentUrl })
        if (extra) {
          const extraHeaders = new Headers(extra)
          for (const [key, val] of extraHeaders.entries()) {
            if (!upstreamHeaders.has(key)) {
              upstreamHeaders.set(key, val)
            }
          }
        }
      } catch {
        return requestJson(request, { error: 'unavailable' }, 502)
      }
    }

    let redirectsFollowed = 0
    let upstream: Response
    while (true) {
      try {
        upstream = await dependencies.fetch(currentUrl, {
          headers: upstreamHeaders,
          method: request.method,
          redirect: 'manual',
        })
      } catch {
        return requestJson(request, { error: 'unavailable' }, 502)
      }

      if (!REDIRECT_STATUSES.has(upstream.status)) break
      if (redirectsFollowed >= 2) {
        return requestJson(request, { error: 'invalid_response' }, 502)
      }
      const location = upstream.headers.get('location')
      const redirectedUrl: URL | null = location
        ? options.validateUrl(location, currentUrl)
        : null
      if (!redirectedUrl) return requestJson(request, { error: 'invalid_response' }, 502)
      currentUrl = redirectedUrl
      redirectsFollowed += 1
    }

    if (upstream.status !== 200 && upstream.status !== 206) {
      return requestJson(request, { error: 'invalid_response' }, 502)
    }
    // Resolve the effective audio type. A generic declaration is only trusted when the leading
    // bytes identify a known container; the sniffer runs at most once and only in that case, and
    // returns a response whose body still carries every original byte.
    const declaredMimeType = mimeEssence(upstream.headers.get('content-type'))
    let servableResponse = upstream
    const resolvedMimeType = await resolveAudioMime(
      declaredMimeType,
      ticket.mimeType,
      options.requireMimeMatch !== false,
      options.allowGenericAudioTypes === true,
      async () => {
        const sniffed = await sniffAudioContainer(upstream)
        servableResponse = sniffed.response
        return sniffed.container
      },
    )
    if (resolvedMimeType === null) {
      return requestJson(request, { error: 'invalid_response' }, 502)
    }
    const headerResult = safeMediaHeaders(
      upstream.headers,
      upstream.status,
      requestedRange,
      resolvedMimeType,
    )
    if (!headerResult.ok) {
      return requestJson(request, { error: 'invalid_response' }, 502)
    }

    return new Response(request.method === 'HEAD' ? null : servableResponse.body, {
      status: servableResponse.status,
      headers: headerResult.headers,
    })
  }

  return { prepare, serve }
}
