import { readBoundedJsonResponse } from './boundedJson'

export type ResolverMetadataError =
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'invalid_response'

export type ResolverMetadataFetchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: ResolverMetadataError }

const METADATA_TIMEOUT_MS = 4_000
const MAX_METADATA_BYTES = 512 * 1024

export const fetchResolverMetadata = async (
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<ResolverMetadataFetchResult> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
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
    return parsed.ok
      ? { ok: true, value: parsed.value }
      : { ok: false, error: 'invalid_response' }
  } catch {
    return { ok: false, error: controller.signal.aborted ? 'timeout' : 'unavailable' }
  } finally {
    clearTimeout(timeout)
  }
}
