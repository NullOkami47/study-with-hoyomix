import type { CanonicalProviderId } from './config'
import { AUDIO_CONTAINER_MIME, mimeEssence } from './audioContainer'
import type { AudioContainer } from './audioContainer'

/**
 * A ticket must outlive the player's next-track lead window (60 s) and its preparation reuse
 * window (100 s, `PREPARATION_VALIDITY_MS`), so a track prepared early can still be promoted.
 * The URL stays an unguessable same-origin nonce and every request still checks `isEffective`,
 * so disabling a provider takes effect immediately regardless of the remaining lifetime.
 */
export const TICKET_TTL_MS = 120_000
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
  /**
   * Opt in to reconciling a *concrete but wrong* `audio/*` declaration against the leading bytes,
   * **when, and only when** those bytes positively identify a known audio container — in which case
   * the served type is corrected to the container actually found.
   *
   * Distinct from {@link allowGenericAudioTypes}: that covers an upstream that declares *no* useful
   * type (`application/octet-stream`); this covers one that declares the *wrong* audio type. GD
   * Studio lossless / Hi-Res metadata yields a `.flac` media path (expected `audio/flac`), but the
   * CDN labels the HTTP response `audio/mpeg` over a genuine `fLaC` body. Under the strict
   * `requireMimeMatch` guard the expected/declared mismatch would otherwise refuse a valid asset.
   *
   * Off unless a provider has been evidenced to need it. The allowance never widens `AUDIO_MIME`
   * and never trusts a label: it is keyed entirely on identifying the bytes, so a non-audio or
   * unrecognisable body (and, unavoidably, any request whose bytes carry no container header, such
   * as a non-zero range or a HEAD) still keeps the strict reject.
   */
  reconcileMislabelledAudioTypes?: boolean
  /** Vkeys/QQ CDN only: accept a form MIME declaration after independently verifying MP3 bytes. */
  allowFormEncodedAudio?: boolean
  /** Expose the effective cached ticket deadline to clients which consume it. */
  includeExpiry?: boolean
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
  /** Upstream URL expiry in epoch milliseconds, when known. */
  expiresAt?: number
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

const cancelResponse = (response: Response | undefined) => {
  // Cancellation must not hold a failure response open if an upstream cancellation hangs.
  void response?.body?.cancel().catch(() => { /* already closed or errored */ })
}

// Twelve bytes cover the longest supported signature (RIFF/WAVE). Empty transport chunks
// also consume a read budget, so an upstream cannot keep prefix collection running forever.
const MAX_AUDIO_PREFIX_BYTES = 12
const MAX_AUDIO_PREFIX_READS = 16

const identifyAudioContainer = (prefix: Uint8Array): AudioContainer => {
  const ascii = (offset: number, length: number): string => {
    if (prefix.length < offset + length) return ''
    let out = ''
    for (let i = offset; i < offset + length; i += 1) out += String.fromCharCode(prefix[i]!)
    return out
  }

  if (ascii(0, 4) === 'fLaC') return 'flac'
  if (ascii(0, 3) === 'ID3') return 'mp3'
  if (ascii(0, 4) === 'OggS') return 'ogg'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav'
  if (ascii(4, 4) === 'ftyp') return 'm4a'
  if (ascii(0, 4) === 'MAC ') return 'ape'
  if (ascii(0, 4) === 'wmap') return 'wma'
  const b0 = prefix[0]
  const b1 = prefix[1]
  // A bare ADTS AAC frame. Checked *before* the generic MPEG frame sync below, because the ADTS
  // sync word is a subset of that pattern: testing the broad rule first would classify raw AAC
  // as `mp3` and label it `audio/mpeg`. AAC is a niche container here, so the tier whose bytes
  // this sniffer exists to recognise is unaffected — this only keeps the remaining branches
  // honest rather than advertising a container the order made unreachable.
  if (b0 === 0xff && (b1 === 0xf1 || b1 === 0xf9)) {
    return 'aac'
  }
  // A bare MPEG-1/2/2.5 audio frame: 11 bits of frame sync.
  if (b0 !== undefined && b1 !== undefined && b0 === 0xff && (b1 & 0xe0) === 0xe0) {
    return 'mp3'
  }

  return 'unknown'
}

const MAX_MP3_PREFIX_BYTES = 4096
const MAX_MP3_PREFIX_READS = MAX_MP3_PREFIX_BYTES + 16

/** undefined means more bytes are needed; unknown is a definite rejection. */
const identifyMp3Prefix = (prefix: Uint8Array): AudioContainer | undefined => {
  if (prefix.length < 4) return undefined
  let frameOffset = 0
  if (prefix[0] === 0x49 && prefix[1] === 0x44 && prefix[2] === 0x33) {
    if (prefix.length < 10) return undefined
    const version = prefix[3]!
    const flags = prefix[5]!
    if (version < 2 || version > 4 || prefix[4] === 0xff ||
      (flags & (version === 2 ? 0x3f : version === 3 ? 0x1f : 0x0f)) !== 0 ||
      !prefix.subarray(6, 10).every(byte => byte < 0x80)) return 'unknown'
    const tagSize = prefix.subarray(6, 10).reduce((size, byte) => size * 128 + byte, 0)
    frameOffset = 10 + tagSize + (version === 4 && (flags & 0x10) !== 0 ? 10 : 0)
    if (frameOffset + 4 > MAX_MP3_PREFIX_BYTES) return 'unknown'
  }
  if (prefix.length < frameOffset + 4) return undefined
  const b1 = prefix[frameOffset + 1]!
  const b2 = prefix[frameOffset + 2]!
  const frame = prefix[frameOffset] === 0xff && (b1 & 0xe0) === 0xe0
    && (b1 & 0x18) !== 0x08 && (b1 & 0x06) === 0x02
    && (b2 & 0xf0) !== 0 && (b2 & 0xf0) !== 0xf0 && (b2 & 0x0c) !== 0x0c
    && (prefix[frameOffset + 3]! & 0x03) !== 0x02
  return frame ? 'mp3' : 'unknown'
}

/**
 * Inspect a bounded prefix and replay bytes only on downstream demand. Generic containers keep
 * their 12-byte / 16-read policy. Vkeys form MIME requires a complete ID3 tag (if present) and
 * a strict Layer III header within 4096 bytes and one five-second deadline. Neither path scans
 * the remaining media. Original chunks are retained for replay, including the final chunk's
 * uninspected tail; its size remains controlled by the transport.
 */
const sniffAudioContainer = async (
  response: Response,
  mp3Only = false,
  signal?: AbortSignal,
  maxReadBytes?: number,
): Promise<{ container: AudioContainer | null; response: Response }> => {
  if (!response.body) return { container: null, response }
  const deadline = mp3Only && !signal ? new AbortController() : undefined
  const readSignal = signal ?? deadline?.signal
  const timer = deadline ? setTimeout(() => deadline.abort(), PREFIX_TIMEOUT_MS) : undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let released = false
  let cancelled = false
  const release = () => {
    if (reader && !released) {
      released = true
      reader.releaseLock()
    }
  }
  const cancel = async (reason?: unknown) => {
    if (released || cancelled) return
    cancelled = true
    // Closing the stream settles pending reads immediately. Do not wait for a remote cancel
    // implementation that may never resolve, especially at the five-second deadline.
    try { void reader?.cancel(reason).catch(() => {}) } catch { /* cleanup is best effort */ }
    finally { release() }
  }
  const abortRead = () => { void cancel(readSignal?.reason) }
  try {
    reader = response.body.getReader()
    readSignal?.addEventListener('abort', abortRead, { once: true })
    if (readSignal?.aborted) {
      await cancel(readSignal.reason)
      return { container: null, response: new Response(null, { status: response.status }) }
    }
    const upstreamReader = reader
    const prefix = new Uint8Array(mp3Only ? MAX_MP3_PREFIX_BYTES : MAX_AUDIO_PREFIX_BYTES)
    const replay: Uint8Array[] = []
    let used = 0
    let received = 0
    const maxReads = mp3Only ? MAX_MP3_PREFIX_READS : MAX_AUDIO_PREFIX_READS
    let container: AudioContainer = 'unknown'
    for (let reads = 0; reads < maxReads && used < prefix.length; reads += 1) {
      const next = await upstreamReader.read()
      if (cancelled || next.done) break
      received += next.value.byteLength
      if (maxReadBytes !== undefined && received > maxReadBytes) break
      if (next.value.byteLength === 0) continue
      replay.push(next.value)
      const copied = Math.min(next.value.byteLength, prefix.length - used)
      prefix.set(next.value.subarray(0, copied), used)
      used += copied
      const identified = mp3Only ? identifyMp3Prefix(prefix.subarray(0, used)) : identifyAudioContainer(prefix.subarray(0, used))
      container = identified ?? 'unknown'
      if (mp3Only ? identified !== undefined : container !== 'unknown') break
    }
    if (cancelled || container === 'unknown') {
      await cancel()
      return { container, response: new Response(null, { status: response.status }) }
    }

    const restoredBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (cancelled) return
        try {
          const chunk = replay.shift()
          if (chunk) {
            controller.enqueue(chunk)
            return
          }
          const next = await upstreamReader.read()
          // Cancellation may have resolved an in-flight read; the controller is already closed.
          if (cancelled) return
          if (next.done) {
            release()
            controller.close()
          } else controller.enqueue(next.value)
        } catch (error) {
          if (cancelled) return
          await cancel(error)
          controller.error(error)
        }
      },
      cancel(reason) {
        replay.length = 0
        return cancel(reason)
      },
    }, { highWaterMark: 0 })
    return {
      container,
      response: new Response(restoredBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
    }
  } catch (error) {
    await cancel(error)
    return { container: null, response: new Response(null, { status: response.status }) }
  } finally {
    clearTimeout(timer)
    readSignal?.removeEventListener('abort', abortRead)
  }
}

/**
 * A `content-type` the CDN may send when it has no useful type for a perfectly valid audio asset.
 *
 * Only ever accepted together with positive byte-level evidence: see `safeMediaHeaders` and
 * `allowGenericAudioTypes`.
 */
const GENERIC_OCTET_MIME = 'application/octet-stream'
const FORM_ENCODED_MIME = 'application/x-www-form-urlencoded'
const PREFIX_TIMEOUT_MS = 5_000
const UPSTREAM_EXPIRY_MARGIN_MS = 30_000

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
 * Four cases:
 *
 * 1. A declared `audio/*` type is authoritative — subject to the provider's exact-match rule.
 * 2. A declared **generic** type (`application/octet-stream`) is accepted *only* when the leading
 *    bytes positively identify a known audio container, in which case the returned type is the
 *    container's real type. This is the case the CDN produces for some higher tiers.
 * 3. The separate Vkeys form-MIME opt-in accepts only independently verified MP3 bytes.
 * 4. Everything else is rejected.
 *
 * The allowance is deliberately keyed on **identifying the bytes**, never on loosening the
 * `audio/*` pattern. Accepting a generic type on the strength of its header alone would admit any
 * payload; requiring recognisable audio framing keeps the guard meaningful while no longer
 * refusing a valid asset over a header the CDN omitted.
 *
 * `sniff` is called at most once and only in cases 2 and 3; declared audio types never read the body.
 */
const resolveAudioMime = async (
  declaredMimeType: string | undefined,
  expectedMimeType: string,
  requireMimeMatch: boolean,
  allowGenericAudio: boolean,
  reconcileMislabelled: boolean,
  allowFormEncodedAudio: boolean,
  sniff: () => Promise<AudioContainer | null>,
): Promise<string | null> => {
  const sniffContainerMime = async (): Promise<string | null> => {
    const container = await sniff()
    const corrected = container ? AUDIO_CONTAINER_MIME[container] : undefined
    return corrected ?? null
  }

  if (declaredMimeType && AUDIO_MIME.test(declaredMimeType)) {
    if (requireMimeMatch && declaredMimeType !== expectedMimeType) {
      // A concrete but wrong audio label. Trust neither the declared nor the expected type: only
      // the bytes decide, and only when they name a known container. Otherwise keep the reject.
      return reconcileMislabelled ? await sniffContainerMime() : null
    }
    return declaredMimeType
  }
  if (allowFormEncodedAudio && declaredMimeType === FORM_ENCODED_MIME) {
    return await sniff() === 'mp3' ? 'audio/mpeg' : null
  }
  if (!allowGenericAudio || declaredMimeType !== GENERIC_OCTET_MIME) return null

  return await sniffContainerMime()
}

/**
 * Derive the served response headers from the upstream ones.
 *
 * The MIME type is an **input**, not something decided here. The caller validates this contract
 * before sniffing, then replaces only content-type with the accepted MIME. This function owns
 * only the declared-length and range-contract policies. It deliberately takes no `expectedMimeType` /
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
  if (response.headers.get('content-type')?.toLowerCase() !== 'application/json') {
    cancelResponse(response)
    return null
  }
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > MAX_TICKET_BYTES)) {
    cancelResponse(response)
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
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  } finally {
    void reader.cancel().catch(() => { /* ignore */ })
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

/** Independent prefix evidence must describe the same immutable representation. */
const mediaRepresentation = (response: Response): { etag: string; total: bigint } | null => {
  const etag = response.headers.get('etag')
  if (!etag || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) return null
  const contentLength = response.headers.get('content-length')
  const total = response.status === 206
    ? parseContentRange(response.headers.get('content-range') ?? '')?.total
    : contentLength !== null && /^[0-9]+$/.test(contentLength) ? BigInt(contentLength) : null
  return total !== null && total !== undefined && total > 0n ? { etag, total } : null
}

export const createTransientMedia = (
  options: TransientMediaOptions,
  dependencies: TransientMediaDependencies,
) => {
  const verifyMp3Prefix = async (url: URL, upstreamHeaders: Headers, actual: Response): Promise<boolean> => {
    const representation = mediaRepresentation(actual)
    if (!representation) return false
    // Revalidate the exact final URL; never carry evidence across a redirect or another request.
    const validated = options.validateUrl(url.href)
    if (!validated || validated.href !== url.href) return false
    const headers = new Headers(upstreamHeaders)
    headers.set('range', 'bytes=0-4095')
    headers.set('if-match', representation.etag)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(() => {
        controller.abort()
        resolve(false)
      }, PREFIX_TIMEOUT_MS)
    })
    const verification = (async () => {
      let response: Response | undefined
      try {
        response = await dependencies.fetch(validated, {
          method: 'GET', headers, redirect: 'manual', signal: controller.signal,
        })
        if (controller.signal.aborted || response.redirected
          || (response.status !== 200 && response.status !== 206)) return false
        const prefixRepresentation = mediaRepresentation(response)
        if (!prefixRepresentation || prefixRepresentation.etag !== representation.etag ||
          prefixRepresentation.total !== representation.total) return false
        const mime = mimeEssence(response.headers.get('content-type'))
        if (mime !== FORM_ENCODED_MIME && mime !== 'audio/mpeg') return false
        if (!safeMediaHeaders(response.headers, response.status,
          { kind: 'closed', start: 0n, end: 4095n }, 'audio/mpeg').ok) return false
        const sniffed = await sniffAudioContainer(response, true, controller.signal, 4096)
        response = sniffed.response
        return !controller.signal.aborted && sniffed.container === 'mp3'
      } catch {
        return false
      } finally {
        cancelResponse(response)
      }
    })()
    try {
      return await Promise.race([verification, timeout])
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  const prepare = async (input: PreparedMediaInput): Promise<{ mimeType: string; url: string; expiresAt?: number } | null> => {
    const canonicalUrl = options.validateUrl(input.validatedUrl.toString())
    if (
      !options.externalIdPattern.test(input.externalId) ||
      !AUDIO_MIME.test(input.mimeType) ||
      !canonicalUrl
    ) return null

    const now = dependencies.now()
    if (input.expiresAt !== undefined && !Number.isSafeInteger(input.expiresAt)) return null
    const expiresAt = Math.min(now + TICKET_TTL_MS,
      input.expiresAt === undefined ? Infinity : input.expiresAt - UPSTREAM_EXPIRY_MARGIN_MS)
    if (expiresAt <= now) return null

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
          expiresAt,
        }), {
          headers: {
            'cache-control': `max-age=${Math.floor((expiresAt - now) / 1000)}`,
            'content-type': 'application/json',
          },
        }),
      )
    } catch {
      return null
    }

    return { mimeType: input.mimeType, url: mediaPath, ...(options.includeExpiry ? { expiresAt } : {}) }
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
      if (ticket.expiresAt <= dependencies.now()) {
        return requestJson(request, { error: 'preparation_expired' }, 410)
      }
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
      cancelResponse(upstream)
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

    let servableResponse = upstream
    const reject = (expired = false) => {
      cancelResponse(servableResponse)
      return requestJson(request,
        { error: expired ? 'preparation_expired' : 'invalid_response' }, expired ? 410 : 502)
    }
    if (ticket.expiresAt <= dependencies.now()) return reject(true)
    if (upstream.status !== 200 && upstream.status !== 206) return reject()

    // Check the actual range before interpreting any bytes, including suffix ranges and servers
    // ignoring Range with a full 200. Only responses starting at zero can identify their container.
    const headerResult = safeMediaHeaders(upstream.headers, upstream.status, requestedRange, ticket.mimeType)
    if (!headerResult.ok) return reject()
    const declaredMimeType = mimeEssence(upstream.headers.get('content-type'))
    const servedRange = parseContentRange(upstream.headers.get('content-range') ?? '')
    const resolvedMimeType = await resolveAudioMime(
      declaredMimeType,
      ticket.mimeType,
      options.requireMimeMatch !== false,
      options.allowGenericAudioTypes === true,
      options.reconcileMislabelledAudioTypes === true,
      options.allowFormEncodedAudio === true,
      async () => {
        const formEncoded = declaredMimeType === FORM_ENCODED_MIME
        if (formEncoded && (request.method === 'HEAD' || (servedRange && servedRange.start > 0n))) {
          return await verifyMp3Prefix(currentUrl, upstreamHeaders, upstream) ? 'mp3' : null
        }
        if (!formEncoded && (request.method === 'HEAD' || (servedRange && servedRange.start !== 0n))) return null
        const sniffed = await sniffAudioContainer(upstream, formEncoded)
        servableResponse = sniffed.response
        return sniffed.container
      },
    )
    if (ticket.expiresAt <= dependencies.now()) return reject(true)
    if (resolvedMimeType === null) return reject()
    headerResult.headers.set('content-type', resolvedMimeType)

    if (request.method === 'HEAD') cancelResponse(servableResponse)
    return new Response(request.method === 'HEAD' ? null : servableResponse.body, {
      status: servableResponse.status,
      headers: headerResult.headers,
    })
  }

  return { prepare, serve }
}
