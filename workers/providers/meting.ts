import { readBoundedJsonResponse } from './boundedJson'
import type { ResolverMetadataError } from './resolverMetadata'

export interface MetingExternalIdBinding {
  server: 'netease' | 'tencent'
  id: string
}

export type MetingMetadataError = ResolverMetadataError

export type MetingMetadataResult =
  | { ok: true; mediaUrl: URL; mimeType: string }
  | { ok: false; error: MetingMetadataError }

export interface MetingMetadataOptions {
  configuredOrigin: string
  externalId: string
  fetch?: typeof fetch
  validateMediaUrl: (value: string) => URL | null
}

interface MetingMetadataResponse {
  server: 'netease' | 'tencent'
  id: string
  url: string
  mimeType: string
}

const METING_EXTERNAL_ID = /^(netease|tencent):([0-9]{1,20})$/
const METING_METADATA_KEYS = new Set(['server', 'id', 'url', 'mimeType'])
const AUDIO_MIME_ESSENCE = /^audio\/[a-z0-9][a-z0-9!#$&^_.+-]*$/
const METADATA_TIMEOUT_MS = 4_000
const MAX_METADATA_BYTES = 64 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readMetingMetadataResponse = (response: Response) =>
  readBoundedJsonResponse(response, MAX_METADATA_BYTES)

const parseMetadataResponse = (
  value: unknown,
  binding: MetingExternalIdBinding,
): MetingMetadataResponse | null => {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 4 || keys.some((key) => !METING_METADATA_KEYS.has(key))) return null
  if (
    value.server !== binding.server || value.id !== binding.id ||
    typeof value.url !== 'string' || typeof value.mimeType !== 'string' ||
    !AUDIO_MIME_ESSENCE.test(value.mimeType)
  ) return null
  return {
    server: binding.server,
    id: binding.id,
    url: value.url,
    mimeType: value.mimeType,
  }
}

export const parseMetingExternalId = (value: string): MetingExternalIdBinding | null => {
  const match = METING_EXTERNAL_ID.exec(value)
  if (!match) return null
  return {
    server: match[1] as MetingExternalIdBinding['server'],
    id: match[2],
  }
}

export const resolveMetingMetadata = async (
  options: MetingMetadataOptions,
): Promise<MetingMetadataResult> => {
  const binding = parseMetingExternalId(options.externalId)
  if (!binding) return { ok: false, error: 'invalid_response' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)
  try {
    const response = await (options.fetch ?? fetch)(options.configuredOrigin, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ server: binding.server, id: binding.id }),
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status === 429) return { ok: false, error: 'rate_limited' }
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, error: 'invalid_response' }
    }
    if (!response.ok) return { ok: false, error: 'unavailable' }

    const parsed = await readMetingMetadataResponse(response)
    if (controller.signal.aborted) return { ok: false, error: 'timeout' }
    if (!parsed.ok) return { ok: false, error: 'invalid_response' }

    const metadata = parseMetadataResponse(parsed.value, binding)
    if (!metadata) return { ok: false, error: 'invalid_response' }
    const mediaUrl = options.validateMediaUrl(metadata.url)
    if (!mediaUrl) return { ok: false, error: 'invalid_response' }
    return { ok: true, mediaUrl, mimeType: metadata.mimeType }
  } catch {
    return { ok: false, error: controller.signal.aborted ? 'timeout' : 'unavailable' }
  } finally {
    clearTimeout(timeout)
  }
}
