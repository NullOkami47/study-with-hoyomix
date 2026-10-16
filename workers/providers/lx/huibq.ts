import type { ResolverMetadataError } from '../resolverMetadata'
import type {
  LxExternalIdBinding,
  LxResolverDescriptor,
} from './types'

const EXTERNAL_ID_PATTERN = /^(?:kw|kg|tx|wy|mg):[A-Za-z0-9_-]{1,96}:(?:128k|320k)$/
const REQUEST_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key))

const parseBinding = (value: string): LxExternalIdBinding | null => {
  if (!EXTERNAL_ID_PATTERN.test(value)) return null
  const [source, id, quality] = value.split(':')
  return source && id && quality ? { source, id, quality } : null
}

export const classifyHuibqResponseError = (
  value: unknown,
): ResolverMetadataError | null => {
  if (!isRecord(value) || typeof value.code !== 'number') return 'invalid_response'
  if (value.code === 0) {
    return hasOnlyKeys(value, ['code', 'url']) && typeof value.url === 'string'
      ? null
      : 'invalid_response'
  }
  if (
    !hasOnlyKeys(value, ['code', 'msg']) ||
    ('msg' in value && typeof value.msg !== 'string')
  ) return 'invalid_response'
  if (value.code === 5) return 'rate_limited'
  if (value.code === 1 || value.code === 2 || value.code === 4) return 'unavailable'
  return 'invalid_response'
}

export const createHuibqDescriptor = (requestKey: string): LxResolverDescriptor => {
  if (!REQUEST_KEY_PATTERN.test(requestKey)) {
    throw new TypeError('Huibq request key must be printable and bounded')
  }

  return {
    providerId: 'lx-huibq',
    externalIdPattern: EXTERNAL_ID_PATTERN,
    parseExternalId: parseBinding,
    buildRequest({ configuredOrigin, binding }) {
      const url = new URL('/url/', configuredOrigin)
      url.pathname = `/url/${encodeURIComponent(binding.source)}/${encodeURIComponent(binding.id)}/${encodeURIComponent(binding.quality)}`
      return {
        url,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-request-key': requestKey,
        },
      }
    },
    parseResponse(value) {
      const error = classifyHuibqResponseError(value)
      if (error !== null) return error === 'invalid_response' ? null : { error }
      if (!isRecord(value)) return null
      return {
        url: value.url as string,
        mimeType: 'audio/mpeg',
      }
    },
  }
}
