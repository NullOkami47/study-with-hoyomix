import { readBoundedJsonResponse } from './boundedJson'
import type { ResolverMetadataError } from './resolverMetadata'

export type HuanyinMetadataError = ResolverMetadataError

export interface HuanyinExternalIdBinding {
  source: string
  id: string
  quality?: string
}

export type HuanyinMetadataResult =
  | { ok: true; mediaUrl: URL; mimeType: string }
  | { ok: false; error: HuanyinMetadataError }

export interface HuanyinMetadataOptions {
  configuredOrigin: string
  externalId: string
  fetch?: typeof fetch
  validateMediaUrl: (value: string) => URL | null
}

export const HUANYIN_ALLOWED_SOURCES = new Set([
  'netease',
  'kuwo',
  'qq',
  'tencent',
  'migu',
])

export const HUANYIN_ALLOWED_QUALITIES = new Set([
  '128k',
  '320k',
  'flac',
  'flac24bit',
])

export const HUANYIN_EXTERNAL_ID_PATTERN =
  /^[a-z0-9-]+:[a-zA-Z0-9_-]{1,64}(?::(?:128k|320k|flac|flac24bit))?$/

const METADATA_TIMEOUT_MS = 4_000
const MAX_METADATA_BYTES = 64 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseHuanyinExternalId = (value: string): HuanyinExternalIdBinding | null => {
  if (typeof value !== 'string') return null
  if (value.trim() !== value) return null
  const parts = value.split(':')
  if (parts.length !== 2 && parts.length !== 3) return null

  const [source, id, quality] = parts
  if (!source || !HUANYIN_ALLOWED_SOURCES.has(source)) return null
  if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return null

  if (parts.length === 3) {
    if (!quality || !HUANYIN_ALLOWED_QUALITIES.has(quality)) return null
  }

  return {
    source,
    id,
    ...(quality ? { quality } : {}),
  }
}

export const resolveHuanyinMetadata = async (
  options: HuanyinMetadataOptions,
): Promise<HuanyinMetadataResult> => {
  const binding = parseHuanyinExternalId(options.externalId)
  if (!binding) return { ok: false, error: 'invalid_response' }

  let requestUrl: URL
  try {
    requestUrl = new URL('/api/', options.configuredOrigin)
    requestUrl.searchParams.set('type', 'url')
    requestUrl.searchParams.set('source', binding.source)
    requestUrl.searchParams.set('id', binding.id)
    if (binding.quality) requestUrl.searchParams.set('br', binding.quality)
  } catch {
    return { ok: false, error: 'unavailable' }
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

    if (response.status === 429) return { ok: false, error: 'rate_limited' }
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, error: 'invalid_response' }
    }
    if (!response.ok) return { ok: false, error: 'unavailable' }

    const parsed = await readBoundedJsonResponse(response, MAX_METADATA_BYTES)
    if (controller.signal.aborted) return { ok: false, error: 'timeout' }
    if (!parsed.ok) return { ok: false, error: 'invalid_response' }

    const body = parsed.value
    if (!isRecord(body)) return { ok: false, error: 'invalid_response' }

    if (typeof body.code === 'number' && body.code !== 200) {
      if (body.code === 429) return { ok: false, error: 'rate_limited' }
      return { ok: false, error: 'unavailable' }
    }

    let rawUrl: unknown = body.url
    if (!rawUrl && isRecord(body.data)) {
      rawUrl = body.data.url
    }
    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      return { ok: false, error: 'unavailable' }
    }

    const mediaUrl = options.validateMediaUrl(rawUrl)
    if (!mediaUrl) return { ok: false, error: 'invalid_response' }

    let mimeType = 'audio/mpeg'
    const pathname = mediaUrl.pathname.toLowerCase()
    if (
      binding.quality === 'flac' ||
      binding.quality === 'flac24bit' ||
      pathname.endsWith('.flac')
    ) {
      mimeType = 'audio/flac'
    } else if (pathname.endsWith('.m4a') || pathname.endsWith('.mp4')) {
      mimeType = 'audio/mp4'
    } else if (pathname.endsWith('.ogg') || pathname.endsWith('.opus')) {
      mimeType = 'audio/ogg'
    } else if (pathname.endsWith('.wav')) {
      mimeType = 'audio/wav'
    }

    return { ok: true, mediaUrl, mimeType }
  } catch {
    return { ok: false, error: controller.signal.aborted ? 'timeout' : 'unavailable' }
  } finally {
    clearTimeout(timeout)
  }
}
