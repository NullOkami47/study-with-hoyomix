import { readBoundedJsonResponseDetailed } from './boundedJson'
import type { ResolverMetadataError } from './resolverMetadata'

export type GdStudioMetadataError = ResolverMetadataError

// F3 — bounded, production-safe failure observability.
//
// Before F3, materially different adapter branches collapsed onto the same externally visible
// `unavailable` / HTTP 502, so a failing request could not be localised from the response alone.
// Every externally visible code corresponds to exactly one boundary documented below. The set is
// finite and stable; codes are never derived from user input, URLs, or response bodies.
export const GD_STUDIO_DIAGNOSTIC_CODES = [
  'gd_request_invalid', // local binding/URL construction failed; no upstream request made
  'gd_upstream_fetch', // fetch promise rejected for a non-timeout transport reason
  'gd_upstream_http', // upstream returned an unexpected non-success, non-429, non-redirect status
  'gd_upstream_redirect', // upstream returned a redirect, which the finite contract does not follow
  'gd_upstream_body', // headers received but the bounded body could not be consumed
  'gd_upstream_json', // bounded body was read but is not valid/acceptable JSON structure
  'gd_missing_media_url', // accepted 2xx response carried no usable url field
  'gd_media_url_policy', // media URL was supplied but rejected by the security validator
  'gd_timeout', // the bounded metadata deadline was reached
  'gd_rate_limited', // upstream 429
] as const

export type GdStudioDiagnosticCode = (typeof GD_STUDIO_DIAGNOSTIC_CODES)[number]

export interface GdStudioExternalIdBinding {
  source: string
  id: string
  br?: number
}

// F5 — bounded, header-only upstream failure metadata observability.
//
// Captured strictly from a fixed allowlist of safe response headers with deterministic length
// bounds. Never contains cookies, authorization, location/redirect targets, complete URLs,
// request queries, or response bodies.
export interface GdStudioUpstreamMetadata {
  server?: string
  cfRay?: string
  cfErrorType?: string
  cfErrorOrigin?: string
  contentType?: string
  retryAfter?: string
  contentLength?: number
}

export type GdStudioMetadataResult =
  | {
      ok: true
      mediaUrl: URL
      mimeType: string
      br?: number
      size?: number
    }
  | {
      ok: false
      error: GdStudioMetadataError
      diagnosticCode: GdStudioDiagnosticCode
      // Present only when the boundary necessarily observed an upstream HTTP status. Recorded so
      // the caller can log it as a structured number; it is never interpolated into a code.
      upstreamStatus?: number
      // F5: bounded, header-only metadata for non-success upstream HTTP responses.
      upstreamMetadata?: GdStudioUpstreamMetadata
    }


export interface GdStudioMetadataOptions {
  configuredOrigin: string
  externalId: string
  fetch?: typeof fetch
  validateMediaUrl: (value: string) => URL | null
}

export const GD_STUDIO_ALLOWED_SOURCES = new Set([
  'netease',
  'tencent',
  'kuwo',
  'bilibili',
  'joox',
  'apple',
  'ytmusic',
  'spotify',
  'tidal',
  'qobuz',
])

export const GD_STUDIO_ALLOWED_BITRATES = new Set([128, 192, 320, 740, 999])

export const GD_STUDIO_EXTERNAL_ID_PATTERN =
  /^[a-z0-9-]+:[a-zA-Z0-9_-]{1,64}(?::(?:128|192|320|740|999))?$/

const METADATA_TIMEOUT_MS = 4_000
const MAX_METADATA_BYTES = 64 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseGdStudioExternalId = (value: string): GdStudioExternalIdBinding | null => {
  if (typeof value !== 'string') return null
  if (value.trim() !== value) return null
  const parts = value.split(':')
  if (parts.length !== 2 && parts.length !== 3) return null

  const [source, id, brStr] = parts
  if (!source || !GD_STUDIO_ALLOWED_SOURCES.has(source)) return null
  if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null

  let br: number | undefined
  if (parts.length === 3) {
    if (!brStr || !/^[0-9]+$/.test(brStr)) return null
    const parsedBr = Number(brStr)
    if (!GD_STUDIO_ALLOWED_BITRATES.has(parsedBr)) return null
    br = parsedBr
  }

  return {
    source,
    id,
    ...(br !== undefined ? { br } : {}),
  }
}

const parseBoundedHeader = (headers: Headers, name: string, maxLength: number): string | undefined => {
  const raw = headers.get(name)
  if (raw === null) return undefined
  const value = raw.trim()
  if (value.length === 0 || value.length > maxLength) return undefined
  return value
}

const parseSafeContentLength = (headers: Headers): number | undefined => {
  const value = headers.get('content-length')
  if (value === null) return undefined
  if (!/^[0-9]+$/.test(value)) return undefined
  const length = Number(value)
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined
}

export const safeGdStudioUpstreamMetadata = (
  response: Response,
): GdStudioUpstreamMetadata | undefined => {
  try {
    const headers = response.headers
    const server = parseBoundedHeader(headers, 'server', 128)
    const cfRay = parseBoundedHeader(headers, 'cf-ray', 128)
    const cfErrorType = parseBoundedHeader(headers, 'cf-error-type', 128)
    const cfErrorOrigin = parseBoundedHeader(headers, 'cf-error-origin', 128)
    const contentType = parseBoundedHeader(headers, 'content-type', 128)
    const retryAfter = parseBoundedHeader(headers, 'retry-after', 64)
    const contentLength = parseSafeContentLength(headers)

    const metadata: GdStudioUpstreamMetadata = {
      ...(server !== undefined ? { server } : {}),
      ...(cfRay !== undefined ? { cfRay } : {}),
      ...(cfErrorType !== undefined ? { cfErrorType } : {}),
      ...(cfErrorOrigin !== undefined ? { cfErrorOrigin } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      ...(contentLength !== undefined ? { contentLength } : {}),
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined
  } catch {
    return undefined
  }
}

export const resolveGdStudioMetadata = async (
  options: GdStudioMetadataOptions,
): Promise<GdStudioMetadataResult> => {
  const binding = parseGdStudioExternalId(options.externalId)
  if (!binding) return { ok: false, error: 'invalid_response', diagnosticCode: 'gd_request_invalid' }

  let requestUrl: URL
  try {
    requestUrl = new URL('/api.php', options.configuredOrigin)
    requestUrl.searchParams.set('types', 'url')
    requestUrl.searchParams.set('source', binding.source)
    requestUrl.searchParams.set('id', binding.id)
    if (binding.br) requestUrl.searchParams.set('br', String(binding.br))
  } catch {
    return { ok: false, error: 'unavailable', diagnosticCode: 'gd_request_invalid' }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)

  try {
    const response = await (options.fetch ?? fetch)(requestUrl.href, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    })

    if (response.status === 429) {
      const upstreamMetadata = safeGdStudioUpstreamMetadata(response)
      return {
        ok: false,
        error: 'rate_limited',
        diagnosticCode: 'gd_rate_limited',
        upstreamStatus: response.status,
        ...(upstreamMetadata ? { upstreamMetadata } : {}),
      }
    }
    if (response.status >= 300 && response.status < 400) {
      const upstreamMetadata = safeGdStudioUpstreamMetadata(response)
      return {
        ok: false,
        error: 'invalid_response',
        diagnosticCode: 'gd_upstream_redirect',
        upstreamStatus: response.status,
        ...(upstreamMetadata ? { upstreamMetadata } : {}),
      }
    }
    if (!response.ok) {
      const upstreamMetadata = safeGdStudioUpstreamMetadata(response)
      return {
        ok: false,
        error: 'unavailable',
        diagnosticCode: 'gd_upstream_http',
        upstreamStatus: response.status,
        ...(upstreamMetadata ? { upstreamMetadata } : {}),
      }
    }


    const parsed = await readBoundedJsonResponseDetailed(response, MAX_METADATA_BYTES)
    if (controller.signal.aborted) return { ok: false, error: 'timeout', diagnosticCode: 'gd_timeout' }
    if (!parsed.ok) {
      return {
        ok: false,
        error: 'invalid_response',
        diagnosticCode: parsed.reason === 'invalid_json' ? 'gd_upstream_json' : 'gd_upstream_body',
      }
    }

    const body = parsed.value
    if (!isRecord(body)) return { ok: false, error: 'invalid_response', diagnosticCode: 'gd_upstream_json' }

    if (typeof body.url !== 'string' || body.url.trim() === '') {
      // Materially different from gd_upstream_http: the upstream answered successfully but the
      // accepted response carried no usable media URL. Conflating the two is what made the
      // earlier audit unable to localise the failure from a 502 alone.
      return { ok: false, error: 'unavailable', diagnosticCode: 'gd_missing_media_url' }
    }

    const mediaUrl = options.validateMediaUrl(body.url)
    if (!mediaUrl) return { ok: false, error: 'invalid_response', diagnosticCode: 'gd_media_url_policy' }

    let mimeType = 'audio/mpeg'
    const pathname = mediaUrl.pathname.toLowerCase()
    if (pathname.endsWith('.flac')) {
      mimeType = 'audio/flac'
    } else if (pathname.endsWith('.m4a') || pathname.endsWith('.mp4')) {
      mimeType = 'audio/mp4'
    } else if (pathname.endsWith('.ogg') || pathname.endsWith('.oga') || pathname.endsWith('.opus')) {
      mimeType = 'audio/ogg'
    } else if (pathname.endsWith('.wav')) {
      mimeType = 'audio/wav'
    }

    const br = typeof body.br === 'number' && Number.isSafeInteger(body.br) && body.br > 0
      ? body.br
      : undefined
    const size = typeof body.size === 'number' && Number.isSafeInteger(body.size) && body.size > 0
      ? body.size
      : undefined

    return {
      ok: true,
      mediaUrl,
      mimeType,
      ...(br !== undefined ? { br } : {}),
      ...(size !== undefined ? { size } : {}),
    }
  } catch {
    // A deadline that fired is reported as a timeout regardless of whether it interrupted the
    // initial fetch or the subsequent body read. Any other rejection is a transport failure.
    return controller.signal.aborted
      ? { ok: false, error: 'timeout', diagnosticCode: 'gd_timeout' }
      : { ok: false, error: 'unavailable', diagnosticCode: 'gd_upstream_fetch' }
  } finally {
    clearTimeout(timeout)
  }
}
