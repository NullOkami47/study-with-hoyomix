import type { Track } from '../../catalog/types'
import { ProviderResolveError, type AudioProvider, type Playable } from './types'

export interface R2ProviderOptions {
  baseUrl: string
  allowedHostnames: readonly string[]
  fetch?: typeof fetch
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('R2 request aborted', 'AbortError')
}

function requireBaseUrl(value: string, allowedHostnames: readonly string[]): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !allowedHostnames.includes(url.hostname)
  ) {
    throw new Error('R2 base URL must use an allowlisted HTTPS hostname')
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function objectUrl(baseUrl: URL, externalId: string): URL {
  let decoded: string
  try {
    decoded = decodeURIComponent(externalId)
  } catch {
    throw new ProviderResolveError('invalid_response')
  }

  const segments = decoded.split('/')
  if (
    decoded.trim() === '' ||
    decoded.startsWith('/') ||
    decoded.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ProviderResolveError('invalid_response')
  }

  return new URL(segments.map(encodeURIComponent).join('/'), baseUrl)
}

function audioMimeType(response: Response): string | null {
  const value = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return value?.startsWith('audio/') ? value : null
}

function checkStatus(response: Response): 'ok' | 'missing' {
  if (response.status === 404 || response.status === 410) return 'missing'
  if (response.status === 429) throw new ProviderResolveError('rate_limited')
  if (!response.ok) throw new ProviderResolveError('unavailable')
  return 'ok'
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  try {
    const response = await fetchImpl(url, { ...init, cache: 'no-store', redirect: 'error', signal })
    if (response.url === '') throw new ProviderResolveError('invalid_response')

    let finalUrl: URL
    try {
      finalUrl = new URL(response.url)
    } catch {
      throw new ProviderResolveError('invalid_response')
    }
    if (finalUrl.toString() !== url) throw new ProviderResolveError('invalid_response')
    return response
  } catch (error) {
    if (error instanceof ProviderResolveError) throw error
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw abortReason(signal)
    }
    throw new ProviderResolveError('unavailable')
  }
}

export function createR2Provider(options: R2ProviderOptions): AudioProvider {
  if (options.allowedHostnames.length === 0) {
    throw new Error('R2 hostname allowlist cannot be empty')
  }

  const baseUrl = requireBaseUrl(options.baseUrl, options.allowedHostnames)
  const fetchImpl = options.fetch ?? fetch

  return {
    id: 'r2',
    async resolve(track: Track, signal: AbortSignal): Promise<Playable | null> {
      if (signal.aborted) throw abortReason(signal)

      const source = track.sources.find(({ provider }) => provider === 'r2')
      if (!source) return null

      const url = objectUrl(baseUrl, source.externalId)
      const head = await request(fetchImpl, url.toString(), { method: 'HEAD' }, signal)
      if (checkStatus(head) === 'missing') return null

      const headMimeType = audioMimeType(head)
      if (head.headers.get('accept-ranges')?.toLowerCase() === 'bytes') {
        if (!headMimeType) throw new ProviderResolveError('invalid_response')
        return { kind: 'audio', mimeType: headMimeType, url: url.toString() }
      }

      const range = await request(
        fetchImpl,
        url.toString(),
        { headers: { Range: 'bytes=0-0' }, method: 'GET' },
        signal,
      )
      if (checkStatus(range) === 'missing') return null

      const contentRange = range.headers.get('content-range')
      const rangeMimeType = audioMimeType(range) ?? headMimeType
      if (range.status !== 206 || !contentRange?.startsWith('bytes 0-0/') || !rangeMimeType) {
        throw new ProviderResolveError('invalid_response')
      }

      return { kind: 'audio', mimeType: rangeMimeType, url: url.toString() }
    },
  }
}
