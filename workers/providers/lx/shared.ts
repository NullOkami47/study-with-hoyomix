import { readBoundedJsonResponse } from '../boundedJson'
import { parseConfiguredResolverOrigin } from '../config'
import { createTransientMedia } from '../transientMedia'
import type {
  TransientMediaDependencies,
  TransientMediaOptions,
} from '../transientMedia'
import type {
  LxMetadataResult,
  LxResolverDescriptor,
} from './types'

const METADATA_TIMEOUT_MS = 4_000
const MAX_METADATA_BYTES = 64 * 1024
const AUDIO_MIME_ESSENCE = /^audio\/[a-z0-9][a-z0-9!#$&^_.+-]*$/

export interface ResolveLxMetadataOptions {
  descriptor: LxResolverDescriptor
  configuredOrigin: string
  externalId: string
  fetch?: typeof fetch
  validateMediaUrl: (value: string) => URL | null
}

const isSafeDescriptorPattern = (pattern: RegExp): boolean =>
  !pattern.global && !pattern.sticky && !pattern.multiline

const isBoundedExternalId = (value: string): boolean =>
  /^[\x21-\x7e]{1,128}$/.test(value)

const ALLOWED_HEADER_NAMES = new Set([
  'accept',
  'content-type',
  'user-agent',
  'x-request-key',
])

const validatedHeaders = (value: Readonly<Record<string, string>> | undefined): Headers | null => {
  const headers = new Headers()
  let totalBytes = 0
  for (const [rawName, headerValue] of Object.entries(value ?? {})) {
    const name = rawName.toLowerCase()
    if (
      rawName !== name || !ALLOWED_HEADER_NAMES.has(name) ||
      !/^[\x20-\x7e]{1,512}$/.test(headerValue)
    ) return null
    totalBytes += name.length + headerValue.length
    if (totalBytes > 1_024) return null
    headers.set(name, headerValue)
  }
  return headers
}

const isExactResolverRequest = (url: URL, configuredOrigin: string): boolean => {
  const origin = parseConfiguredResolverOrigin(configuredOrigin)
  return origin !== null &&
    url.protocol === 'https:' &&
    url.origin === origin &&
    !url.username && !url.password && !url.hash &&
    ![...url.searchParams.keys()].some((key) =>
      /^(?:api[_-]?key|auth|authorization|cookie|secret|token)$/i.test(key))
}

export const resolveLxMetadata = async (
  options: ResolveLxMetadataOptions,
): Promise<LxMetadataResult> => {
  const { descriptor } = options
  if (
    !isSafeDescriptorPattern(descriptor.externalIdPattern) ||
    !isBoundedExternalId(options.externalId) ||
    !descriptor.externalIdPattern.test(options.externalId)
  ) return { ok: false, error: 'invalid_response' }

  const binding = descriptor.parseExternalId(options.externalId)
  if (!binding) return { ok: false, error: 'invalid_response' }

  let built
  try {
    built = descriptor.buildRequest({
      configuredOrigin: options.configuredOrigin,
      binding,
    })
  } catch {
    return { ok: false, error: 'invalid_response' }
  }
  if (!isExactResolverRequest(built.url, options.configuredOrigin)) {
    return { ok: false, error: 'invalid_response' }
  }
  const headers = validatedHeaders(built.headers)
  if (!headers) return { ok: false, error: 'invalid_response' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)
  try {
    const response = await (options.fetch ?? fetch)(built.url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status === 429) return { ok: false, error: 'rate_limited' }
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, error: 'invalid_response' }
    }
    if (!response.ok) return { ok: false, error: 'unavailable' }

    const aborted = new Promise<{ ok: false }>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve({ ok: false }), { once: true })
    })
    const parsed = await Promise.race([
      readBoundedJsonResponse(response, MAX_METADATA_BYTES),
      aborted,
    ])
    if (controller.signal.aborted) return { ok: false, error: 'timeout' }
    if (!parsed.ok) return { ok: false, error: 'invalid_response' }

    let metadata
    let mediaUrl
    try {
      metadata = descriptor.parseResponse(parsed.value, binding)
      if (!metadata) {
        return { ok: false, error: 'invalid_response' }
      }
      if ('error' in metadata) return { ok: false, error: metadata.error }
      if (!AUDIO_MIME_ESSENCE.test(metadata.mimeType)) {
        return { ok: false, error: 'invalid_response' }
      }
      mediaUrl = options.validateMediaUrl(metadata.url)
    } catch {
      return { ok: false, error: 'invalid_response' }
    }
    if (!mediaUrl) return { ok: false, error: 'invalid_response' }
    return { ok: true, mediaUrl, mimeType: metadata.mimeType }
  } catch {
    return { ok: false, error: controller.signal.aborted ? 'timeout' : 'unavailable' }
  } finally {
    clearTimeout(timeout)
  }
}

export const createLxTransientMedia = (
  options: Pick<TransientMediaOptions, 'publicOrigin' | 'validateUrl'> & {
    descriptor: LxResolverDescriptor
    isEffective: NonNullable<TransientMediaOptions['isEffective']>
  },
  dependencies: TransientMediaDependencies,
) => {
  if (!isSafeDescriptorPattern(options.descriptor.externalIdPattern)) {
    throw new TypeError('LX external ID pattern must be stateless')
  }
  return createTransientMedia({
    providerId: options.descriptor.providerId,
    externalIdPattern: options.descriptor.externalIdPattern,
    publicOrigin: options.publicOrigin,
    validateUrl: options.validateUrl,
    isEffective: options.isEffective,
  }, dependencies)
}
