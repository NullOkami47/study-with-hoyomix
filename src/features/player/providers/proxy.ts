import type { Track, TrackSource } from '../../catalog/types'
import {
  ProviderResolveError,
  type AudioProvider,
  type AudioQualityMetadata,
  type Playable,
  type PlaybackPresentationMetadata,
} from './types'

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024

export interface ServerProxyProviderOptions {
  fetch?: typeof fetch
  validateExternalId?: (value: string) => boolean
  requestHeaders?: () => HeadersInit | undefined
  /**
   * Extra fields merged into the resolve request body alongside `externalId`.
   *
   * Providers whose Worker route accepts more than the shared `{ externalId }` shape supply their
   * additional keys here. The default is an empty object, so every other provider's body stays
   * byte-identical to what it has always sent.
   */
  requestBody?: () => Record<string, unknown>
}

interface ProxyAudioResponse {
  mimeType: string
  url: string
  metadata?: unknown
}

const SAFE_FAILURE_CODES = new Set<ProviderResolveError['code']>([
  'invalid_response',
  'rate_limited',
  'timeout',
  'unavailable',
  'credential_required',
  'invalid_credential',
  // Truthful ChKSz policy failures the Worker can now surface; without these the client would
  // discard the code and fall back to a generic 'unavailable'.
  'quota_exhausted',
  'forbidden',
  'not_found',
])

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Provider request aborted', 'AbortError')
}

function findSource(track: Track, providerId: string): TrackSource | undefined {
  return track.sources.find((source) => source.provider === providerId)
}

function isStableExternalId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u0020\u007f]/.test(value) &&
    !value.includes('://') &&
    !value.startsWith('//') &&
    !value.includes('\\')
  )
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function isPermittedApplicationUrl(url: URL): boolean {
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && isLocalDevelopmentHost(url.hostname))
  )
}

function currentApplicationOrigin(): URL {
  const origin = new URL(globalThis.location.origin)

  if (
    !isPermittedApplicationUrl(origin) ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  ) {
    throw new Error('Provider proxy requires the current secure application origin')
  }

  return origin
}

function responseLength(response: Response): number | null {
  const value = response.headers.get('content-length')
  if (value === null) return null

  const length = Number(value)
  return Number.isSafeInteger(length) && length >= 0 ? length : Number.POSITIVE_INFINITY
}

async function parseJsonResponse(response: Response, maxResponseBytes: number): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  const declaredLength = responseLength(response)
  if (
    contentType !== 'application/json' ||
    (declaredLength !== null && declaredLength > maxResponseBytes)
  ) {
    throw new ProviderResolveError('invalid_response')
  }

  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0

  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedBytes += value.byteLength
      if (receivedBytes > maxResponseBytes) {
        await reader.cancel()
        throw new ProviderResolveError('invalid_response')
      }
      chunks.push(value)
    }
  }

  const bytes = new Uint8Array(receivedBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ProviderResolveError('invalid_response')
  }
}

function parseQualityMetadata(value: unknown): AudioQualityMetadata | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const quality: AudioQualityMetadata = {}
  if (typeof raw.codec === 'string' && raw.codec.trim() !== '') quality.codec = raw.codec.trim().toLowerCase()
  if (typeof raw.container === 'string' && raw.container.trim() !== '') quality.container = raw.container.trim().toLowerCase()
  if (typeof raw.bitrate === 'number' && Number.isSafeInteger(raw.bitrate) && raw.bitrate > 0) quality.bitrate = raw.bitrate
  if (typeof raw.sampleRate === 'number' && Number.isSafeInteger(raw.sampleRate) && raw.sampleRate > 0) quality.sampleRate = raw.sampleRate
  if (typeof raw.bitDepth === 'number' && Number.isSafeInteger(raw.bitDepth) && raw.bitDepth > 0) quality.bitDepth = raw.bitDepth
  if (typeof raw.tier === 'string' && raw.tier.trim() !== '') quality.tier = raw.tier.trim().toLowerCase()
  return Object.keys(quality).length > 0 ? quality : undefined
}

function parseArtworkUrl(value: unknown, origin: URL): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const parsed = new URL(value, origin)
    if (parsed.protocol !== 'https:' && (parsed.protocol !== 'http:' || !isLocalDevelopmentHost(parsed.hostname))) {
      return undefined
    }
    if (parsed.username !== '' || parsed.password !== '') return undefined
    if (parsed.origin !== origin.origin) return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

function validatePlayable(
  value: unknown,
  origin: URL,
  mediaPathPrefix: string,
  externalId: string,
): Playable {
  if (typeof value !== 'object' || value === null) {
    throw new ProviderResolveError('invalid_response')
  }

  const response = value as Partial<ProxyAudioResponse>
  if (
    typeof response.url !== 'string' ||
    response.url.trim() === '' ||
    typeof response.mimeType !== 'string' ||
    !response.mimeType.toLowerCase().startsWith('audio/')
  ) {
    throw new ProviderResolveError('invalid_response')
  }

  const mediaPathPattern = new RegExp(
    `^${mediaPathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${encodeURIComponent(externalId)}/[A-Za-z0-9_-]{32}$`,
  )
  const mediaPath = response.url.startsWith(origin.origin)
    ? response.url.slice(origin.origin.length)
    : response.url
  if (!mediaPathPattern.test(mediaPath)) {
    throw new ProviderResolveError('invalid_response')
  }

  let playbackUrl: URL
  try {
    playbackUrl = new URL(response.url, origin)
  } catch {
    throw new ProviderResolveError('invalid_response')
  }

  if (
    !isPermittedApplicationUrl(playbackUrl) ||
    playbackUrl.origin !== origin.origin ||
    playbackUrl.username !== '' ||
    playbackUrl.password !== '' ||
    playbackUrl.hash !== '' || playbackUrl.search !== '' ||
    playbackUrl.pathname !== mediaPath ||
    (response.url !== mediaPath && response.url !== `${origin.origin}${mediaPath}`)
  ) {
    throw new ProviderResolveError('invalid_response')
  }

  let metadata: PlaybackPresentationMetadata | undefined
  if ('metadata' in response && typeof response.metadata === 'object' && response.metadata !== null) {
    const rawMeta = response.metadata as Record<string, unknown>
    const quality = parseQualityMetadata(rawMeta.quality)
    const artworkUrl = parseArtworkUrl(rawMeta.artworkUrl, origin)
    if (quality || artworkUrl) {
      metadata = {
        ...(quality ? { quality } : {}),
        ...(artworkUrl ? { artworkUrl } : {}),
      }
    }
  }

  return {
    kind: 'audio',
    mimeType: response.mimeType.toLowerCase(),
    url: playbackUrl.toString(),
    ...(metadata ? { metadata } : {}),
  }
}

async function parseFailureCode(response: Response): Promise<ProviderResolveError['code'] | null> {
  try {
    const value = await parseJsonResponse(response, DEFAULT_MAX_RESPONSE_BYTES)
    if (
      typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).length !== 1
    ) return null
    const code = (value as { error?: unknown }).error
    return typeof code === 'string' && SAFE_FAILURE_CODES.has(code as ProviderResolveError['code'])
      ? code as ProviderResolveError['code']
      : null
  } catch {
    return null
  }
}

async function proxyFetch(
  fetchImpl: typeof fetch,
  url: string,
  externalId: string,
  signal: AbortSignal,
  requestHeaders?: () => HeadersInit | undefined,
  extraBody?: () => Record<string, unknown>,
): Promise<Response> {
  try {
    const extraHeaders = requestHeaders?.()
    const headers: HeadersInit = extraHeaders
      ? new Headers(extraHeaders)
      : { 'content-type': 'application/json' }
    if (headers instanceof Headers) headers.set('content-type', 'application/json')
    return await fetchImpl(url, {
      body: JSON.stringify({ externalId, ...extraBody?.() }),
      headers,
      method: 'POST',
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw abortReason(signal)
    }
    throw new ProviderResolveError('unavailable')
  }
}

function validateFinalResponseUrl(response: Response, expectedUrl: string): void {
  if (response.url === '') throw new ProviderResolveError('invalid_response')

  let finalUrl: URL
  try {
    finalUrl = new URL(response.url)
  } catch {
    throw new ProviderResolveError('invalid_response')
  }

  if (finalUrl.toString() !== expectedUrl) {
    throw new ProviderResolveError('invalid_response')
  }
}

export function createServerProxyProvider(
  id: string,
  routeSegment: string,
  options: ServerProxyProviderOptions,
): AudioProvider {
  const origin = currentApplicationOrigin()
  const fetchImpl = options.fetch ?? fetch
  const resolvePath = `/api/providers/${routeSegment}/resolve`
  const mediaPathPrefix = `/api/providers/${routeSegment}/media/`
  const resolveUrl = new URL(resolvePath, origin).toString()

  return {
    id,
    async resolve(track: Track, signal: AbortSignal): Promise<Playable | null> {
      if (signal.aborted) throw abortReason(signal)

      const source = findSource(track, id)
      if (!source) return null
      const validByProvider = options.validateExternalId?.(source.externalId) ?? true
      if (!isStableExternalId(source.externalId) || !validByProvider) {
        throw new ProviderResolveError('invalid_response')
      }

      const response = await proxyFetch(
        fetchImpl,
        resolveUrl,
        source.externalId,
        signal,
        options.requestHeaders,
        options.requestBody,
      )
      validateFinalResponseUrl(response, resolveUrl)
      if (response.status === 404 || response.status === 410) return null
      if (response.status === 429) throw new ProviderResolveError('rate_limited')
      if (!response.ok) {
        const code = await parseFailureCode(response)
        throw new ProviderResolveError(code ?? (response.status === 504 ? 'timeout' : 'unavailable'))
      }

      const body = await parseJsonResponse(response, DEFAULT_MAX_RESPONSE_BYTES)
      return validatePlayable(body, origin, mediaPathPrefix, source.externalId)
    },
  }
}
