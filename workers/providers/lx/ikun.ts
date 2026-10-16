import type { ResolverMetadataError } from '../resolverMetadata'
import type {
  LxExternalIdBinding,
  LxResolverDescriptor,
} from './types'

const EXTERNAL_ID_PATTERN = /^(?:kw|wy|git):[A-Za-z0-9_-]{1,96}:(?:128k|320k|flac|flac24bit|hires|atmos|master)$/
const REQUEST_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/
const SOURCE_QUALITIES: Readonly<Record<string, ReadonlySet<string>>> = {
  kw: new Set(['128k', '320k', 'flac', 'flac24bit', 'hires']),
  wy: new Set(['128k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'master']),
  git: new Set(['128k', '320k', 'flac']),
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key))

const parseBinding = (value: string): LxExternalIdBinding | null => {
  if (!EXTERNAL_ID_PATTERN.test(value)) return null
  const [source, id, quality] = value.split(':')
  if (!source || !id || !quality || !SOURCE_QUALITIES[source]?.has(quality)) return null
  return { source, id, quality }
}

const mimeTypeForQuality = (quality: string): string =>
  quality === '128k' || quality === '320k' ? 'audio/mpeg' : 'audio/flac'

export const classifyIkunResponseError = (
  value: unknown,
): ResolverMetadataError | null => {
  if (!isRecord(value) || typeof value.code !== 'number') return 'invalid_response'
  if (value.code === 200) {
    return hasOnlyKeys(value, ['code', 'url']) && typeof value.url === 'string'
      ? null
      : 'invalid_response'
  }
  if (
    !hasOnlyKeys(value, ['code', 'message']) ||
    ('message' in value && typeof value.message !== 'string')
  ) return 'invalid_response'
  if (value.code === 429) return 'rate_limited'
  if (value.code === 403 || value.code === 500) return 'unavailable'
  return 'invalid_response'
}

export const createIkunDescriptor = (requestKey: string): LxResolverDescriptor => {
  if (!REQUEST_KEY_PATTERN.test(requestKey)) {
    throw new TypeError('ikun request key must be printable and bounded')
  }

  return {
    providerId: 'lx-ikun',
    externalIdPattern: EXTERNAL_ID_PATTERN,
    parseExternalId: parseBinding,
    buildRequest({ configuredOrigin, binding }) {
      const url = new URL('/url', configuredOrigin)
      url.searchParams.set('source', binding.source)
      url.searchParams.set('songId', binding.id)
      url.searchParams.set('quality', binding.quality)
      return {
        url,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-request-key': requestKey,
        },
      }
    },
    parseResponse(value, binding) {
      const error = classifyIkunResponseError(value)
      if (error !== null) return error === 'invalid_response' ? null : { error }
      if (!isRecord(value)) return null
      return {
        url: value.url as string,
        mimeType: mimeTypeForQuality(binding.quality),
      }
    },
  }
}
