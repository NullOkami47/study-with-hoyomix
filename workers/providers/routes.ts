import {
  configuredGdStudioMediaHostnames,
  configuredGdStudioOrigin,
  configuredHuanyinMediaHostnames,
  configuredHuanyinOrigin,
  configuredJellyfinApiToken,
  configuredJellyfinOrigin,
  configuredJellyfinUserId,
  configuredLxMediaHostnames,
  configuredLxOrigin,
  configuredLxRequestKey,
  configuredMetingMediaHostnames,
  configuredMetingOrigin,
  configuredResolverMediaHostnames,
  configuredResolverOrigin,
  deploymentAvailable,
  readProviderStates,
  IMPLEMENTED_LX_PROVIDER_IDS,
  type CanonicalProviderId,
  type ImplementedLxProviderId,
  type PlaybackProviderId,
  type ProviderEnv,
} from './config'
import { readChkszOwnerFallbackEnabled, selectChkszCredential } from './chkszCredentials'
import {
  resolveGdStudioMetadata,
  GD_STUDIO_EXTERNAL_ID_PATTERN,
} from './gdStudio'
import type { GdStudioDiagnosticCode, GdStudioUpstreamMetadata } from './gdStudio'
import {
  resolveHuanyinMetadata,
  HUANYIN_EXTERNAL_ID_PATTERN,
} from './huanyin'
import { resolveInvidiousMetadata } from './invidious'
import {
  jellyfinAuthHeaders,
  parseJellyfinExternalId,
  resolveJellyfinMetadata,
  JELLYFIN_ITEM_ID_PATTERN,
} from './jellyfin'
import { createHuibqDescriptor } from './lx/huibq'
import { createIkunDescriptor } from './lx/ikun'
import { createLxTransientMedia, resolveLxMetadata } from './lx/shared'
import type { LxResolverDescriptor } from './lx/types'
import { resolveMetingMetadata } from './meting'
import { resolvePipedMetadata } from './piped'
import {
  createExactMediaUrlValidator,
  createResolverMediaUrlValidator,
} from './resolverMediaUrl'
import { automaticProviderEligible, cloudflareCountry } from './routing'
import { createTransientMedia } from './transientMedia'
import {
  CHKSZ_ID_PATTERN,
  CHKSZ_MAX_RESPONSE_BYTES,
  CHKSZ_MUSIC_ENDPOINT,
  chkszFailureCode,
  createChkszArtworkProxyUrl,
  resolveChkszRedirect,
  validateChkszArtworkUrl,
  validateChkszMediaUrl,
  validateChkszMetadata,
  validateChkszPlaybackMetadata,
  validateChkszResolveBody,
} from '../../src/shared/chksz'
import { isChkszDenied, type CanonicalMetadataInput } from '../../src/shared/chkszDiscovery'
import { discoverChkszTrack } from './chkszDiscoveryService'

export interface RuntimeProviderConfigResponse {
  version: 1
  providers: Array<{
    id: PlaybackProviderId
    available: boolean
    enabled: boolean
    automaticEligible: boolean
    priority: number
    config?: { baseUrl: string; allowedHostnames: string[] }
    userKeySupported?: true
    ownerFallbackAvailable?: boolean
  }>
}

export interface ProviderHandlerOptions {
  fetch?: typeof fetch
  cache?: Pick<Cache, 'match' | 'put'>
  crypto?: Crypto
  now?: () => number
}

interface WorkerCacheStorage extends CacheStorage {
  default: Cache
}

const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/
const METING_ID_PATTERN = /^(?:netease|tencent):[0-9]{1,20}$/
const MAX_RESOLVE_BODY_BYTES = 1024
// Shares the client-side ceiling so a response acceptable to one side is acceptable to both.
const MAX_METADATA_BYTES = CHKSZ_MAX_RESPONSE_BYTES
const METADATA_TIMEOUT_MS = 4_000
const ARTWORK_TIMEOUT_MS = 8_000
const MAX_ARTWORK_DIMENSION = 512
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024
const SAFE_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

function normaliseImageMime(value: string | null): string | null {
  const match = value?.match(/^\s*(image\/(?:jpeg|jpg|png|webp|gif))(?:\s*;\s*charset\s*=\s*[a-z0-9_-]+)?\s*$/i)
  const essence = match?.[1]?.toLowerCase()
  if (essence === 'image/jpg') return 'image/jpeg'
  return essence && SAFE_IMAGE_MIMES.has(essence) ? essence : null
}

async function readArtworkBytes(response: Response): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_ARTWORK_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  if (size === 0) return null
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}) => Response.json(body, {
  status,
  headers: { 'cache-control': 'no-store', ...extraHeaders },
})

// F5 — bounded, header-only upstream failure metadata observability for GD Studio.
//
// Extends the F3 structured log record with safe, flattened upstream header metadata when an
// upstream HTTP response was observed. Strictly allowlists server, cf-ray, cf-error-type,
// cf-error-origin, content-type, retry-after, and content-length. Never logs cookies,
// authorization, location targets, complete URLs, tokens, or response bodies.
const logGdStudioResolveFailure = (input: {
  stage: GdStudioDiagnosticCode
  code: GdStudioDiagnosticCode
  elapsedMs: number
  upstreamStatus?: number
  upstreamMetadata?: GdStudioUpstreamMetadata
}) => {
  try {
    console.warn(JSON.stringify({
      event: 'provider_resolve_failure',
      provider: 'gd-studio',
      stage: input.stage,
      code: input.code,
      ...(input.upstreamStatus !== undefined ? { upstreamStatus: input.upstreamStatus } : {}),
      elapsedMs: input.elapsedMs,
      ...(input.upstreamMetadata?.server !== undefined ? { upstreamServer: input.upstreamMetadata.server } : {}),
      ...(input.upstreamMetadata?.cfRay !== undefined ? { upstreamCfRay: input.upstreamMetadata.cfRay } : {}),
      ...(input.upstreamMetadata?.cfErrorType !== undefined ? { upstreamCfErrorType: input.upstreamMetadata.cfErrorType } : {}),
      ...(input.upstreamMetadata?.cfErrorOrigin !== undefined ? { upstreamCfErrorOrigin: input.upstreamMetadata.cfErrorOrigin } : {}),
      ...(input.upstreamMetadata?.contentType !== undefined ? { upstreamContentType: input.upstreamMetadata.contentType } : {}),
      ...(input.upstreamMetadata?.retryAfter !== undefined ? { upstreamRetryAfter: input.upstreamMetadata.retryAfter } : {}),
      ...(input.upstreamMetadata?.contentLength !== undefined ? { upstreamContentLength: input.upstreamMetadata.contentLength } : {}),
    }))
  } catch {
    // Observability must never affect the response path.
  }
}

const configuredPublicOrigin = (value: string): string | null => {
  try {
    const parsed = new URL(value)
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    if (
      parsed.origin !== value || parsed.username || parsed.password || parsed.pathname !== '/' ||
      parsed.search || parsed.hash ||
      (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
    ) return null
    return parsed.origin
  } catch {
    return null
  }
}

const hasExactJsonMime = (headers: Headers) =>
  headers.get('content-type')?.toLowerCase() === 'application/json'

const hasJsonMimeEssence = (headers: Headers) =>
  headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'

const declaredLengthIsValid = (headers: Headers, maximum: number) => {
  const value = headers.get('content-length')
  if (value === null) return true
  if (!/^[0-9]+$/.test(value)) return false
  const length = Number(value)
  return Number.isSafeInteger(length) && length <= maximum
}

type ParsedJson = { ok: true; value: unknown } | { ok: false }

const readBoundedJson = async (
  source: Pick<Request, 'body' | 'headers'> | Pick<Response, 'body' | 'headers'>,
  maximum: number,
): Promise<ParsedJson> => {
  if (!declaredLengthIsValid(source.headers, maximum)) return { ok: false }

  const reader = source.body?.getReader()
  if (!reader) return { ok: false }
  const chunks: Uint8Array[] = []
  let received = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maximum) {
        await reader.cancel()
        return { ok: false }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false }
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  } catch {
    return { ok: false }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const resolveExternalId = (value: unknown, pattern: RegExp): string | null => {
  if (!isObject(value) || Object.keys(value).length !== 1) return null
  return typeof value.externalId === 'string' && pattern.test(value.externalId)
    ? value.externalId
    : null
}

// ChKSz media-host and metadata validation live in src/shared/chksz.ts so the Worker
// resolver and the browser-direct provider cannot drift. Every protection that used to
// be implemented here is preserved there, verbatim or stronger.

export function createProviderHandler(
  env: ProviderEnv,
  options: ProviderHandlerOptions = {},
) {
  const dependencies = {
    crypto: options.crypto ?? globalThis.crypto,
    fetch: options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)),
    now: options.now ?? Date.now,
  }
  const cacheStorage = (globalThis as typeof globalThis & { caches?: WorkerCacheStorage }).caches
  const preparationCache = () => options.cache ?? cacheStorage?.default

  const readEffective = async (providerId: CanonicalProviderId): Promise<boolean | null> => {
    try {
      if (!deploymentAvailable(providerId, env)) return false
      const states = await readProviderStates(env.DB, env)
      const canonicalState = states.find(({ id }) => id === providerId)
      if (canonicalState) {
        return canonicalState.effectiveEnabled === true
      }
      const row = await env.DB.prepare('SELECT enabled FROM provider_health WHERE provider_key = ?')
        .bind(providerId).first<{ enabled: number }>()
      return row ? row.enabled === 1 : false
    } catch {
      return null
    }
  }

  const chkszTransientMedia = (publicOrigin: string) =>
    createTransientMedia({
      providerId: 'chksz',
      publicOrigin,
      externalIdPattern: CHKSZ_ID_PATTERN,
      requireMimeMatch: false,
      // The ChKSz CDN serves some higher tiers (`sky` among them) as
      // `application/octet-stream` even though the body is a valid FLAC stream. Accepting that
      // declaration is safe here only because the proxy independently re-identifies the container
      // from the leading bytes; a generic body that is not recognisable audio is still refused.
      allowGenericAudioTypes: true,
      validateUrl: (value, current) => current && typeof value === 'string'
        ? resolveChkszRedirect(value, current)
        : validateChkszMediaUrl(value),
      isEffective: async () =>
        await readEffective('chksz') === true,
    }, {
      cache: preparationCache(),
      crypto: dependencies.crypto,
      fetch: dependencies.fetch,
      now: dependencies.now,
    })

  const resolverTransientMedia = (
    providerId: 'invidious' | 'piped',
    publicOrigin: string,
    validateUrl: (value: unknown, current?: URL) => URL | null,
  ) => createTransientMedia({
    providerId,
    publicOrigin,
    externalIdPattern: YOUTUBE_ID_PATTERN,
    validateUrl,
    isEffective: async () => await readEffective(providerId) === true,
  }, {
    cache: preparationCache(),
    crypto: dependencies.crypto,
    fetch: dependencies.fetch,
    now: dependencies.now,
  })

  const configuredMetingPolicy = () => {
    const configuredOrigin = configuredMetingOrigin(env)
    const allowedHostnames = configuredMetingMediaHostnames(env)
    return configuredOrigin && allowedHostnames
      ? { configuredOrigin, validateUrl: createExactMediaUrlValidator(allowedHostnames) }
      : null
  }

  const metingTransientMedia = (publicOrigin: string) => createTransientMedia({
    providerId: 'meting',
    publicOrigin,
    externalIdPattern: METING_ID_PATTERN,
    validateUrl: (value, current) =>
      configuredMetingPolicy()?.validateUrl(value, current) ?? null,
    isEffective: async () => await readEffective('meting') === true,
  }, {
    cache: preparationCache(),
    crypto: dependencies.crypto,
    fetch: dependencies.fetch,
    now: dependencies.now,
  })

  const handleConfig = async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed' }, 405)
    }

    try {
      const states = await readProviderStates(env.DB, env)
      const country = cloudflareCountry(request)
      const ownerFallbackEnabled = await readChkszOwnerFallbackEnabled(env.DB)
      const ownerFallbackAvailable = ownerFallbackEnabled && Boolean(env.CHKSZ_API_KEY?.trim())
      const body: RuntimeProviderConfigResponse = {
        version: 1,
        providers: states
          .map((state) => ({
            id: state.id,
            available: state.deploymentAvailable,
            enabled: state.effectiveEnabled,
            automaticEligible: automaticProviderEligible(state, country),
            priority: state.priority,
            ...(state.publicConfig ? { config: state.publicConfig } : {}),
            ...(state.id === 'chksz' ? {
              userKeySupported: true as const,
              ownerFallbackAvailable,
            } : {}),
          }))
          .sort((left, right) => left.priority - right.priority),
      }
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json',
          },
        })
      }
      return json(body)
    } catch {
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 503,
          headers: {
            'cache-control': 'no-store',
            'content-type': 'application/json',
          },
        })
      }
      return json({ error: 'provider_config_unavailable' }, 503)
    }
  }

  const handleChkszDiscover = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (
      request.method !== 'POST' || !publicOrigin || url.origin !== publicOrigin || url.search ||
      request.headers.get('origin') !== publicOrigin || !hasExactJsonMime(request.headers)
    ) {
      return json({ error: 'invalid_response' }, request.method === 'POST' ? 400 : 405)
    }

    const parsedBody = await readBoundedJson(request, MAX_RESOLVE_BODY_BYTES)
    if (!parsedBody.ok || typeof parsedBody.value !== 'object' || parsedBody.value === null) {
      return json({ error: 'invalid_response' }, 400)
    }
    const body = parsedBody.value as Record<string, unknown>
    const rawTrackId = body.trackId
    if (typeof rawTrackId !== 'string' || !rawTrackId.trim() || rawTrackId.length > 256) {
      return json({ error: 'invalid_response' }, 400)
    }
    const trackId = rawTrackId.trim()

    const effective = await readEffective('chksz')
    if (!effective) return json({ error: 'unavailable' }, 503)

    const credential = await selectChkszCredential(
      request.headers,
      env.DB,
      () => env.CHKSZ_API_KEY,
    )
    if (!credential.ok) {
      return json(
        { error: credential.error },
        credential.error === 'invalid_credential' ? 400 : 503,
      )
    }

    const rawMeta = body.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : null
    let title = typeof rawMeta?.title === 'string' ? rawMeta.title.trim() : null
    let duration_s = typeof rawMeta?.duration_s === 'number' && Number.isFinite(rawMeta.duration_s) ? rawMeta.duration_s : null
    let vocalStatus = typeof rawMeta?.vocalStatus === 'string' ? rawMeta.vocalStatus : (typeof rawMeta?.vocal_status === 'string' ? rawMeta.vocal_status : null)
    let album = typeof rawMeta?.album === 'string' ? rawMeta.album : null
    let aliases: string[] = []
    if (Array.isArray(rawMeta?.aliases)) {
      aliases = (rawMeta.aliases as unknown[]).filter((a): a is string => typeof a === 'string')
    }

    if (!title) {
      try {
        const row = await env.DB.prepare('SELECT title, album, vocal_status AS vocalStatus FROM catalogue_tracks WHERE track_id = ?').bind(trackId).first<{ title: string; album: string | null; vocalStatus: string }>()
        if (row) {
          title = row.title
          if (!album) album = row.album
          if (!vocalStatus) vocalStatus = row.vocalStatus
        }
      } catch {}
    }

    if (!title) {
      return json({ error: 'invalid_response' }, 400)
    }

    const canonicalMeta: CanonicalMetadataInput = {
      title,
      duration_s,
      vocalStatus,
      album,
      aliases,
    }

    const result = await discoverChkszTrack(
      trackId,
      canonicalMeta,
      credential.apiKey,
      env.DB,
      { fetch: dependencies.fetch, now: dependencies.now },
    )

    if (result.ok) {
      return json({
        ok: true,
        externalId: result.externalId,
        confidence: result.confidence,
        source: result.source,
      })
    }

    if (result.error === 'rate_limited') {
      const headers: Record<string, string> = {}
      if (result.retryAfter) headers['retry-after'] = String(result.retryAfter)
      return json(
        { error: 'rate_limited', ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}) },
        429,
        headers,
      )
    }

    if (result.error === 'denylisted' || result.error === 'disabled') {
      return json({ error: 'unavailable' }, 403)
    }

    return json({ error: result.error }, 503)
  }

  const handleChkszResolve = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (
      request.method !== 'POST' || !publicOrigin || url.origin !== publicOrigin || url.search ||
      request.headers.get('origin') !== publicOrigin || !hasExactJsonMime(request.headers)
    ) {
      return json({ error: 'invalid_response' }, request.method === 'POST' ? 400 : 405)
    }

    const parsedBody = await readBoundedJson(request, MAX_RESOLVE_BODY_BYTES)
    // The owner-fallback request carries the user's selected quality. `validateChkszResolveBody`
    // owns the whole shape rule — closed key set, id pattern, exact seven-level whitelist — so the
    // Worker cannot drift from the browser provider's notion of a valid ChKSz level, and an
    // invalid level is refused here instead of being silently downgraded to `standard`.
    const resolvedBody = parsedBody.ok
      ? validateChkszResolveBody(parsedBody.value, CHKSZ_ID_PATTERN)
      : null
    if (!resolvedBody) return json({ error: 'invalid_response' }, 400)
    const { externalId, level } = resolvedBody

    const denied = isChkszDenied('', externalId)
    if (denied.blocked) return json({ error: 'unavailable' }, 403)

    const effective = await readEffective('chksz')

    if (!effective) return json({ error: 'unavailable' }, 503)
    const credential = await selectChkszCredential(
      request.headers,
      env.DB,
      () => env.CHKSZ_API_KEY,
    )
    if (!credential.ok) {
      return json(
        { error: credential.error },
        credential.error === 'invalid_credential' ? 400 : 503,
      )
    }
    const apiKey = credential.apiKey

    const upstreamUrl = new URL(CHKSZ_MUSIC_ENDPOINT)
    upstreamUrl.search = new URLSearchParams({
      id: externalId,
      apikey: apiKey,
      level,
    }).toString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)
    let audioUrl: URL | null = null

    try {
      const response = await dependencies.fetch(upstreamUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      })
      if (response.status !== 200) {
        // The same table the browser-direct path uses, so a 402 is never reported as a generic
        // outage by one side and truthfully by the other. 429 keeps its transport meaning; every
        // other upstream failure travels as 502 with the truthful code in the body, so the client
        // reads the code instead of mistaking a 404 for an absent mapping.
        const failure = chkszFailureCode(response.status) ?? 'invalid_response'
        return json({ error: failure }, response.status === 429 ? 429 : 502)
      }
      if (!hasJsonMimeEssence(response.headers)) {
        return json({ error: 'invalid_response' }, 502)
      }

      const parsedMetadata = await readBoundedJson(response, MAX_METADATA_BYTES)
      if (controller.signal.aborted) return json({ error: 'timeout' }, 504)
      const validatedPayload = parsedMetadata.ok
        ? validateChkszPlaybackMetadata(parsedMetadata.value, externalId, level)
        : null
      if (!validatedPayload) return json({ error: 'invalid_response' }, 502)
      audioUrl = validatedPayload.mediaUrl

      const cache = preparationCache()
      if (!cache) return json({ error: 'unavailable' }, 503)
      const prepared = await chkszTransientMedia(publicOrigin).prepare({
        externalId,
        validatedUrl: audioUrl,
        mimeType: 'audio/mpeg',
      })
      if (!prepared) return json({ error: 'unavailable' }, 503)

      const artworkProxyUrl = validatedPayload.artworkUrl
        ? createChkszArtworkProxyUrl(validatedPayload.artworkUrl)
        : null

      return json({
        ...prepared,
        metadata: {
          quality: {
            tier: validatedPayload.level,
            ...(validatedPayload.bitrate ? { bitrate: validatedPayload.bitrate } : {}),
          },
          ...(artworkProxyUrl ? { artworkUrl: artworkProxyUrl } : {}),
        },
      })
    } catch {
      return controller.signal.aborted
        ? json({ error: 'timeout' }, 504)
        : json({ error: 'unavailable' }, 502)
    } finally {
      clearTimeout(timeout)
    }
  }

  const handleChkszMedia = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (!publicOrigin) return json({ error: 'invalid_response' }, 400)
    return chkszTransientMedia(publicOrigin).serve(request, url)
  }

  const handleChkszArtwork = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (!publicOrigin || url.origin !== publicOrigin) {
      return json({ error: 'invalid_response' }, 400)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed' }, 405)
    }

    const targetUrlParam = url.searchParams.get('url')
    const validatedUrl = targetUrlParam ? validateChkszArtworkUrl(targetUrlParam) : null
    if (!validatedUrl) {
      return json({ error: 'invalid_response' }, 400)
    }

    // NetEase originals can exceed the artwork byte limit. Request a fixed cover
    // thumbnail without relaxing the host, MIME, timeout or response-size guards.
    validatedUrl.searchParams.set('param', `${MAX_ARTWORK_DIMENSION}y${MAX_ARTWORK_DIMENSION}`)

    if (await readEffective('chksz') !== true) return json({ error: 'unavailable' }, 503)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ARTWORK_TIMEOUT_MS)

    try {
      const response = await dependencies.fetch(validatedUrl.href, {
        method: request.method,
        headers: {
          accept: 'image/webp,image/jpeg,image/png,image/*',
        },
        referrerPolicy: 'no-referrer',
        redirect: 'manual',
        signal: controller.signal,
      })

      if (response.status === 404) {
        return json({ error: 'not_found' }, 404)
      }
      if (!response.ok) {
        return json({ error: 'unavailable' }, response.status === 429 ? 429 : 502)
      }

      const imageMime = normaliseImageMime(response.headers.get('content-type'))
      if (!imageMime) {
        return json({ error: 'invalid_response' }, 502)
      }

      const contentLength = response.headers.get('content-length')
      if (contentLength !== null) {
        const length = Number(contentLength)
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARTWORK_BYTES) {
          return json({ error: 'invalid_response' }, 502)
        }
      }

      const imageBytes = request.method === 'HEAD' ? null : await readArtworkBytes(response)
      if (controller.signal.aborted) return json({ error: 'timeout' }, 504)
      if (request.method === 'GET' && !imageBytes) return json({ error: 'invalid_response' }, 502)

      const headers = new Headers({
        'content-type': imageMime,
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
      })
      if (contentLength !== null) {
        headers.set('content-length', contentLength)
      }

      return new Response(imageBytes, {
        status: 200,
        headers,
      })
    } catch {
      return json({ error: controller.signal.aborted ? 'timeout' : 'unavailable' }, controller.signal.aborted ? 504 : 502)
    } finally {
      clearTimeout(timeout)
    }
  }

  const handleAudioResolverResolve = async (
    providerId: 'invidious' | 'piped',
    request: Request,
    url: URL,
  ): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (
      request.method !== 'POST' || !publicOrigin || url.origin !== publicOrigin || url.search ||
      request.headers.get('origin') !== publicOrigin || !hasExactJsonMime(request.headers)
    ) return json({ error: 'invalid_response' }, request.method === 'POST' ? 400 : 405)

    const parsedBody = await readBoundedJson(request, MAX_RESOLVE_BODY_BYTES)
    const externalId = parsedBody.ok
      ? resolveExternalId(parsedBody.value, YOUTUBE_ID_PATTERN)
      : null
    if (!externalId) return json({ error: 'invalid_response' }, 400)
    if (await readEffective(providerId) !== true) return json({ error: 'unavailable' }, 503)

    const configuredOrigin = configuredResolverOrigin(providerId, env)
    const allowedHostnames = configuredResolverMediaHostnames(providerId, env)
    if (!configuredOrigin || !allowedHostnames) return json({ error: 'unavailable' }, 503)
    const validateUrl = createResolverMediaUrlValidator({
      configuredOrigin,
      extraAllowedHostnames: allowedHostnames,
    })
    const metadata = providerId === 'piped'
      ? await resolvePipedMetadata({
        configuredOrigin,
        externalId,
        fetch: dependencies.fetch,
        validateMediaUrl: (value) => validateUrl(value),
      })
      : await resolveInvidiousMetadata({
        configuredOrigin,
        externalId,
        fetch: dependencies.fetch,
        validateMediaUrl: (value) => validateUrl(value),
      })
    if (!metadata.ok) {
      const status = metadata.error === 'rate_limited'
        ? 429
        : metadata.error === 'timeout' ? 504 : 502
      return json({ error: metadata.error }, status)
    }

    const prepared = await resolverTransientMedia(providerId, publicOrigin, validateUrl).prepare({
      externalId,
      validatedUrl: metadata.mediaUrl,
      mimeType: metadata.mimeType,
    })
    return prepared ? json(prepared) : json({ error: 'unavailable' }, 503)
  }

  const handleAudioResolverMedia = async (
    providerId: 'invidious' | 'piped',
    request: Request,
    url: URL,
  ): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    const configuredOrigin = configuredResolverOrigin(providerId, env)
    const allowedHostnames = configuredResolverMediaHostnames(providerId, env)
    if (!publicOrigin || !configuredOrigin || !allowedHostnames) {
      return json({ error: 'unavailable' }, 503)
    }
    const validateUrl = createResolverMediaUrlValidator({
      configuredOrigin,
      extraAllowedHostnames: allowedHostnames,
    })
    return resolverTransientMedia(providerId, publicOrigin, validateUrl).serve(request, url)
  }

  const handleMetingResolve = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (
      request.method !== 'POST' || !publicOrigin || url.origin !== publicOrigin || url.search ||
      request.headers.get('origin') !== publicOrigin || !hasExactJsonMime(request.headers)
    ) return json({ error: 'invalid_response' }, request.method === 'POST' ? 400 : 405)

    const parsedBody = await readBoundedJson(request, MAX_RESOLVE_BODY_BYTES)
    const externalId = parsedBody.ok
      ? resolveExternalId(parsedBody.value, METING_ID_PATTERN)
      : null
    if (!externalId) return json({ error: 'invalid_response' }, 400)
    if (await readEffective('meting') !== true) return json({ error: 'unavailable' }, 503)

    const policy = configuredMetingPolicy()
    if (!policy) return json({ error: 'unavailable' }, 503)
    const metadata = await resolveMetingMetadata({
      configuredOrigin: policy.configuredOrigin,
      externalId,
      fetch: dependencies.fetch,
      validateMediaUrl: (value) => policy.validateUrl(value),
    })
    if (!metadata.ok) {
      const status = metadata.error === 'rate_limited'
        ? 429
        : metadata.error === 'timeout' ? 504 : 502
      return json({ error: metadata.error }, status)
    }

    const prepared = await metingTransientMedia(publicOrigin).prepare({
      externalId,
      validatedUrl: metadata.mediaUrl,
      mimeType: metadata.mimeType,
    })
    return prepared ? json(prepared) : json({ error: 'unavailable' }, 503)
  }

  const handleMetingMedia = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (!publicOrigin) return json({ error: 'invalid_response' }, 400)
    return metingTransientMedia(publicOrigin).serve(request, url)
  }

  const configuredLxPolicy = (providerId: ImplementedLxProviderId): {
    configuredOrigin: string
    descriptor: LxResolverDescriptor
    validateUrl: (value: unknown, current?: URL) => URL | null
  } | null => {
    const configuredOrigin = configuredLxOrigin(providerId, env)
    const allowedHostnames = configuredLxMediaHostnames(providerId, env)
    const requestKey = configuredLxRequestKey(providerId, env)
    if (!configuredOrigin || !allowedHostnames?.length || !requestKey) return null

    let descriptor: LxResolverDescriptor
    try {
      descriptor = providerId === 'lx-huibq'
        ? createHuibqDescriptor(requestKey)
        : createIkunDescriptor(requestKey)
    } catch {
      return null
    }
    return {
      configuredOrigin,
      descriptor,
      validateUrl: createExactMediaUrlValidator(allowedHostnames),
    }
  }

  const lxTransientMedia = (
    publicOrigin: string,
    policy: NonNullable<ReturnType<typeof configuredLxPolicy>>,
  ) => createLxTransientMedia({
    descriptor: policy.descriptor,
    publicOrigin,
    validateUrl: policy.validateUrl,
    isEffective: async () => await readEffective(policy.descriptor.providerId) === true,
  }, {
    cache: preparationCache(),
    crypto: dependencies.crypto,
    fetch: dependencies.fetch,
    now: dependencies.now,
  })

  const handleLxResolve = async (
    providerId: ImplementedLxProviderId,
    request: Request,
    url: URL,
  ): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (
      request.method !== 'POST' || !publicOrigin || url.origin !== publicOrigin || url.search ||
      request.headers.get('origin') !== publicOrigin || !hasExactJsonMime(request.headers)
    ) return json({ error: 'invalid_response' }, request.method === 'POST' ? 400 : 405)

    const policy = configuredLxPolicy(providerId)
    const parsedBody = await readBoundedJson(request, MAX_RESOLVE_BODY_BYTES)
    const externalId = parsedBody.ok && policy
      ? resolveExternalId(parsedBody.value, policy.descriptor.externalIdPattern)
      : null
    if (!policy) return json({ error: 'unavailable' }, 503)
    if (!externalId) return json({ error: 'invalid_response' }, 400)
    if (await readEffective(providerId) !== true) return json({ error: 'unavailable' }, 503)

    const metadata = await resolveLxMetadata({
      descriptor: policy.descriptor,
      configuredOrigin: policy.configuredOrigin,
      externalId,
      fetch: dependencies.fetch,
      validateMediaUrl: (value) => policy.validateUrl(value),
    })
    if (!metadata.ok) {
      const status = metadata.error === 'rate_limited'
        ? 429
        : metadata.error === 'timeout' ? 504 : 502
      return json({ error: metadata.error }, status)
    }

    const prepared = await lxTransientMedia(publicOrigin, policy).prepare({
      externalId,
      validatedUrl: metadata.mediaUrl,
      mimeType: metadata.mimeType,
    })
    return prepared ? json(prepared) : json({ error: 'unavailable' }, 503)
  }

  const handleLxMedia = async (
    providerId: ImplementedLxProviderId,
    request: Request,
    url: URL,
  ): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    const policy = configuredLxPolicy(providerId)
    if (!publicOrigin || !policy) return json({ error: 'unavailable' }, 503)
    return lxTransientMedia(publicOrigin, policy).serve(request, url)
  }

  const configuredJellyfinPolicy = () => {
    const configuredOrigin = configuredJellyfinOrigin(env)
    const apiToken = configuredJellyfinApiToken(env)
    const userId = configuredJellyfinUserId(env)
    return configuredOrigin && apiToken && userId
      ? {
          configuredOrigin,
          apiToken,
          userId,
          validateUrl: createExactMediaUrlValidator([new URL(configuredOrigin).hostname]),
        }
      : null
  }

  const jellyfinTransientMedia = (publicOrigin: string) => {
    const policy = configuredJellyfinPolicy()
    return createTransientMedia({
      providerId: 'jellyfin',
      publicOrigin,
      externalIdPattern: JELLYFIN_ITEM_ID_PATTERN,
      validateUrl: (value, current) =>
        policy?.validateUrl(value, current) ?? null,
      isEffective: async () => await readEffective('jellyfin') === true,
      getUpstreamHeaders: (): HeadersInit => policy
        ? jellyfinAuthHeaders(policy.apiToken)
        : {},
    }, {
      cache: preparationCache(),
      crypto: dependencies.crypto,
      fetch: dependencies.fetch,
      now: dependencies.now,
    })
  }

  const handleJellyfinResolve = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (
      request.method !== 'POST' || !publicOrigin || url.origin !== publicOrigin || url.search ||
      request.headers.get('origin') !== publicOrigin || !hasExactJsonMime(request.headers)
    ) return json({ error: 'invalid_response' }, request.method === 'POST' ? 400 : 405)

    const parsedBody = await readBoundedJson(request, MAX_RESOLVE_BODY_BYTES)
    const externalId = parsedBody.ok
      ? resolveExternalId(parsedBody.value, JELLYFIN_ITEM_ID_PATTERN)
      : null
    if (!externalId) return json({ error: 'invalid_response' }, 400)
    if (await readEffective('jellyfin') !== true) return json({ error: 'unavailable' }, 503)

    const policy = configuredJellyfinPolicy()
    if (!policy) return json({ error: 'unavailable' }, 503)
    const metadata = await resolveJellyfinMetadata({
      configuredOrigin: policy.configuredOrigin,
      apiToken: policy.apiToken,
      userId: policy.userId,
      externalId,
      fetch: dependencies.fetch,
      validateMediaUrl: (value) => policy.validateUrl(value),
    })
    if (!metadata.ok) {
      const status = metadata.error === 'rate_limited'
        ? 429
        : metadata.error === 'timeout' ? 504 : 502
      // The upstream status is a non-sensitive discriminator: it lets an operator tell a rejected
      // credential from a missing user context or an absent item without ever seeing the token.
      return json(
        metadata.upstreamStatus !== undefined
          ? { error: metadata.error, upstreamStatus: metadata.upstreamStatus }
          : { error: metadata.error },
        status,
      )
    }
    const prepared = await jellyfinTransientMedia(publicOrigin).prepare({
      externalId,
      validatedUrl: metadata.mediaUrl,
      mimeType: metadata.mimeType,
    })
    if (!prepared) return json({ error: 'unavailable' }, 503)

    return json({
      ...prepared,
      metadata: {
        quality: metadata.quality,
        ...(metadata.hasArtwork && metadata.artworkId
          ? { artworkUrl: `/api/providers/jellyfin/artwork/${metadata.artworkId}` }
          : {}),
      },
    })
  }

  const handleJellyfinMedia = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (!publicOrigin) return json({ error: 'invalid_response' }, 400)
    return jellyfinTransientMedia(publicOrigin).serve(request, url)
  }

  const handleJellyfinArtwork = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (!publicOrigin || url.origin !== publicOrigin || url.search || url.hash) {
      return json({ error: 'invalid_response' }, 400)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed' }, 405)
    }

    const artworkPrefix = '/api/providers/jellyfin/artwork/'
    if (!url.pathname.startsWith(artworkPrefix)) {
      return json({ error: 'invalid_response' }, 400)
    }
    const rawId = url.pathname.slice(artworkPrefix.length)
    const itemId = parseJellyfinExternalId(rawId)
    if (!itemId) {
      return json({ error: 'invalid_response' }, 400)
    }

    if (await readEffective('jellyfin') !== true) return json({ error: 'unavailable' }, 503)

    const policy = configuredJellyfinPolicy()
    if (!policy) return json({ error: 'unavailable' }, 503)

    let upstreamArtworkUrl: URL
    try {
      upstreamArtworkUrl = new URL(`/Items/${itemId}/Images/Primary`, policy.configuredOrigin)
      upstreamArtworkUrl.searchParams.set('maxWidth', String(MAX_ARTWORK_DIMENSION))
      upstreamArtworkUrl.searchParams.set('maxHeight', String(MAX_ARTWORK_DIMENSION))
    } catch {
      return json({ error: 'unavailable' }, 503)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), ARTWORK_TIMEOUT_MS)

    try {
      const response = await dependencies.fetch(upstreamArtworkUrl.href, {
        method: request.method,
        headers: {
          accept: 'image/webp,image/jpeg,image/png,image/*',
          ...jellyfinAuthHeaders(policy.apiToken),
        },
        redirect: 'manual',
        signal: controller.signal,
      })

      if (response.status === 404) {
        return json({ error: 'not_found' }, 404)
      }
      if (!response.ok) {
        return json({ error: 'unavailable' }, response.status === 429 ? 429 : 502)
      }

      const imageMime = normaliseImageMime(response.headers.get('content-type'))
      if (!imageMime) {
        return json({ error: 'invalid_response' }, 502)
      }

      const contentLength = response.headers.get('content-length')
      if (contentLength !== null) {
        const length = Number(contentLength)
        if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARTWORK_BYTES) {
          return json({ error: 'invalid_response' }, 502)
        }
      }

      const imageBytes = request.method === 'HEAD' ? null : await readArtworkBytes(response)
      if (controller.signal.aborted) return json({ error: 'timeout' }, 504)
      if (request.method === 'GET' && !imageBytes) return json({ error: 'invalid_response' }, 502)

      const headers = new Headers({
        'content-type': imageMime,
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
      })
      if (contentLength !== null) {
        headers.set('content-length', contentLength)
      }

      return new Response(imageBytes, {
        status: 200,
        headers,
      })
    } catch {
      return json({ error: controller.signal.aborted ? 'timeout' : 'unavailable' }, controller.signal.aborted ? 504 : 502)
    } finally {
      clearTimeout(timeout)
    }
  }

  const configuredGdStudioPolicy = () => {
    const configuredOrigin = configuredGdStudioOrigin(env)
    const allowedHostnames = configuredGdStudioMediaHostnames(env)
    return configuredOrigin && allowedHostnames?.length
      ? {
          configuredOrigin,
          validateUrl: createExactMediaUrlValidator(allowedHostnames),
        }
      : null
  }

  const gdStudioTransientMedia = (publicOrigin: string) => createTransientMedia({
    providerId: 'gd-studio',
    publicOrigin,
    externalIdPattern: GD_STUDIO_EXTERNAL_ID_PATTERN,
    validateUrl: (value, current) =>
      configuredGdStudioPolicy()?.validateUrl(value, current) ?? null,
    isEffective: async () => await readEffective('gd-studio') === true,
  }, {
    cache: preparationCache(),
    crypto: dependencies.crypto,
    fetch: dependencies.fetch,
    now: dependencies.now,
  })

  const handleGdStudioResolve = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (
      request.method !== 'POST' || !publicOrigin || url.origin !== publicOrigin || url.search ||
      request.headers.get('origin') !== publicOrigin || !hasExactJsonMime(request.headers)
    ) return json({ error: 'invalid_response' }, request.method === 'POST' ? 400 : 405)

    const parsedBody = await readBoundedJson(request, MAX_RESOLVE_BODY_BYTES)
    const externalId = parsedBody.ok
      ? resolveExternalId(parsedBody.value, GD_STUDIO_EXTERNAL_ID_PATTERN)
      : null
    if (!externalId) return json({ error: 'invalid_response' }, 400)
    if (await readEffective('gd-studio') !== true) return json({ error: 'unavailable' }, 503)

    const policy = configuredGdStudioPolicy()
    if (!policy) return json({ error: 'unavailable' }, 503)
    const startedAt = dependencies.now()
    const metadata = await resolveGdStudioMetadata({
      configuredOrigin: policy.configuredOrigin,
      externalId,
      fetch: dependencies.fetch,
      validateMediaUrl: (value) => policy.validateUrl(value),
    })
    if (!metadata.ok) {
      const status = metadata.error === 'rate_limited'
        ? 429
        : metadata.error === 'timeout' ? 504 : 502
      logGdStudioResolveFailure({
        stage: metadata.diagnosticCode,
        code: metadata.diagnosticCode,
        elapsedMs: Math.max(0, Math.round(dependencies.now() - startedAt)),
        ...(metadata.upstreamStatus !== undefined
          ? { upstreamStatus: metadata.upstreamStatus }
          : {}),
        ...(metadata.upstreamMetadata !== undefined
          ? { upstreamMetadata: metadata.upstreamMetadata }
          : {}),
      })
      // Preserves the existing public envelope: same `error` category and same HTTP status.
      // `code` is an additive, finite discriminator that makes the failing boundary localisable.
      return json({ error: metadata.error, code: metadata.diagnosticCode }, status)
    }

    const prepared = await gdStudioTransientMedia(publicOrigin).prepare({
      externalId,
      validatedUrl: metadata.mediaUrl,
      mimeType: metadata.mimeType,
    })
    return prepared ? json(prepared) : json({ error: 'unavailable' }, 503)
  }

  const handleGdStudioMedia = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (!publicOrigin) return json({ error: 'invalid_response' }, 400)
    return gdStudioTransientMedia(publicOrigin).serve(request, url)
  }

  const configuredHuanyinPolicy = () => {
    const configuredOrigin = configuredHuanyinOrigin(env)
    const allowedHostnames = configuredHuanyinMediaHostnames(env)
    return configuredOrigin && allowedHostnames?.length
      ? {
          configuredOrigin,
          validateUrl: createExactMediaUrlValidator(allowedHostnames),
        }
      : null
  }

  const huanyinTransientMedia = (publicOrigin: string) => createTransientMedia({
    providerId: 'lx-huanyin',
    publicOrigin,
    externalIdPattern: HUANYIN_EXTERNAL_ID_PATTERN,
    validateUrl: (value, current) =>
      configuredHuanyinPolicy()?.validateUrl(value, current) ?? null,
    isEffective: async () => await readEffective('lx-huanyin') === true,
  }, {
    cache: preparationCache(),
    crypto: dependencies.crypto,
    fetch: dependencies.fetch,
    now: dependencies.now,
  })

  const handleHuanyinResolve = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (
      request.method !== 'POST' || !publicOrigin || url.origin !== publicOrigin || url.search ||
      request.headers.get('origin') !== publicOrigin || !hasExactJsonMime(request.headers)
    ) return json({ error: 'invalid_response' }, request.method === 'POST' ? 400 : 405)

    const parsedBody = await readBoundedJson(request, MAX_RESOLVE_BODY_BYTES)
    const externalId = parsedBody.ok
      ? resolveExternalId(parsedBody.value, HUANYIN_EXTERNAL_ID_PATTERN)
      : null
    if (!externalId) return json({ error: 'invalid_response' }, 400)
    if (await readEffective('lx-huanyin') !== true) return json({ error: 'unavailable' }, 503)

    const policy = configuredHuanyinPolicy()
    if (!policy) return json({ error: 'unavailable' }, 503)
    const metadata = await resolveHuanyinMetadata({
      configuredOrigin: policy.configuredOrigin,
      externalId,
      fetch: dependencies.fetch,
      validateMediaUrl: (value) => policy.validateUrl(value),
    })
    if (!metadata.ok) {
      const status = metadata.error === 'rate_limited'
        ? 429
        : metadata.error === 'timeout' ? 504 : 502
      return json({ error: metadata.error }, status)
    }

    const prepared = await huanyinTransientMedia(publicOrigin).prepare({
      externalId,
      validatedUrl: metadata.mediaUrl,
      mimeType: metadata.mimeType,
    })
    return prepared ? json(prepared) : json({ error: 'unavailable' }, 503)
  }

  const handleHuanyinMedia = async (request: Request, url: URL): Promise<Response> => {
    const publicOrigin = configuredPublicOrigin(env.PUBLIC_ORIGIN)
    if (!publicOrigin) return json({ error: 'invalid_response' }, 400)
    return huanyinTransientMedia(publicOrigin).serve(request, url)
  }

  const fetchHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (url.pathname === '/api/providers/config') return handleConfig(request)
    if (url.pathname === '/api/providers/chksz/discover') return handleChkszDiscover(request, url)
    if (url.pathname === '/api/providers/chksz/resolve') return handleChkszResolve(request, url)
    if (url.pathname.startsWith('/api/providers/chksz/media/')) return handleChkszMedia(request, url)
    if (url.pathname === '/api/providers/chksz/artwork') return handleChkszArtwork(request, url)
    if (url.pathname === '/api/providers/meting/resolve') return handleMetingResolve(request, url)
    if (url.pathname.startsWith('/api/providers/meting/media/')) {
      return handleMetingMedia(request, url)
    }
    if (url.pathname === '/api/providers/piped/resolve') {
      return handleAudioResolverResolve('piped', request, url)
    }
    if (url.pathname.startsWith('/api/providers/piped/media/')) {
      return handleAudioResolverMedia('piped', request, url)
    }
    if (url.pathname === '/api/providers/invidious/resolve') {
      return handleAudioResolverResolve('invidious', request, url)
    }
    if (url.pathname.startsWith('/api/providers/invidious/media/')) {
      return handleAudioResolverMedia('invidious', request, url)
    }
    if (url.pathname === '/api/providers/jellyfin/resolve') {
      return handleJellyfinResolve(request, url)
    }
    if (url.pathname.startsWith('/api/providers/jellyfin/media/')) {
      return handleJellyfinMedia(request, url)
    }
    if (url.pathname.startsWith('/api/providers/jellyfin/artwork/')) {
      return handleJellyfinArtwork(request, url)
    }
    if (url.pathname === '/api/providers/gd-studio/resolve') {
      return handleGdStudioResolve(request, url)
    }
    if (url.pathname.startsWith('/api/providers/gd-studio/media/')) {
      return handleGdStudioMedia(request, url)
    }
    if (url.pathname === '/api/providers/lx-huanyin/resolve') {
      return handleHuanyinResolve(request, url)
    }
    if (url.pathname.startsWith('/api/providers/lx-huanyin/media/')) {
      return handleHuanyinMedia(request, url)
    }
    for (const providerId of IMPLEMENTED_LX_PROVIDER_IDS) {
      if (url.pathname === `/api/providers/${providerId}/resolve`) {
        return handleLxResolve(providerId, request, url)
      }
      if (url.pathname.startsWith(`/api/providers/${providerId}/media/`)) {
        return handleLxMedia(providerId, request, url)
      }
    }
    return json({ error: 'not_found' }, 404)
  }

  return { fetch: fetchHandler }
}
