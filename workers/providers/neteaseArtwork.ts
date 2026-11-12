import { CHKSZ_ID_PATTERN, validateChkszArtworkUrl } from '../../src/shared/chksz'
import { readBoundedJsonResponse, type BoundedJsonResult } from './boundedJson'
import {
  ARTWORK_TIMEOUT_MS,
  MAX_ARTWORK_BYTES,
  MAX_ARTWORK_DIMENSION,
  normaliseImageMime,
  readArtworkBytes,
} from './artworkIngress'

const MAX_ARTWORK_METADATA_BYTES = 1024 * 1024
const METADATA_MIME = /^\s*(?:application\/json|text\/plain)(?:\s*;\s*charset\s*=\s*(?:[a-z0-9_-]+|"[a-z0-9_-]+"))?\s*$/i

async function readNeteaseArtworkMetadata(response: Response): Promise<BoundedJsonResult> {
  // This fixed NetEase endpoint labels its JSON body text/plain;charset=UTF-8. Keep that
  // exception local; the shared reader and all other provider MIME policies remain unchanged.
  if (!METADATA_MIME.test(response.headers.get('content-type') ?? '')) return { ok: false }
  const headers = new Headers(response.headers)
  headers.set('content-type', 'application/json')
  // Reuse the original body stream once; no clone or unbounded text/JSON read is introduced.
  return readBoundedJsonResponse(new Response(response.body, { headers }), MAX_ARTWORK_METADATA_BYTES)
}
const json = (error: string, status: number) => Response.json({ error }, {
  status,
  headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' },
})

interface NeteaseArtworkOptions {
  providerId: 'lx' | 'gd-studio'
  publicOrigin: string | null
  isEnabled: () => Promise<boolean>
  fetch: typeof fetch
}

function exactSongArtwork(value: unknown, id: string): { url?: URL; status: number } {
  if (!value || typeof value !== 'object') return { status: 502 }
  const body = value as { code?: unknown; songs?: unknown }
  if (body.code !== 200 || !Array.isArray(body.songs)) return { status: 502 }
  const matches = body.songs.filter((song: unknown) => {
    if (!song || typeof song !== 'object') return false
    const candidate = (song as { id?: unknown }).id
    return (typeof candidate === 'string' || typeof candidate === 'number' && Number.isSafeInteger(candidate)) && String(candidate) === id
  })
  if (!matches.length) return { status: 404 }
  if (matches.length !== 1) return { status: 502 }
  const album = (matches[0] as { album?: unknown }).album
  if (!album || typeof album !== 'object') return { status: 404 }
  const picUrl = (album as { picUrl?: unknown }).picUrl
  if (picUrl === undefined || picUrl === null || picUrl === '') return { status: 404 }
  const url = validateChkszArtworkUrl(picUrl)
  return url ? { url, status: 200 } : { status: 502 }
}

/**
 * Provider-owned artwork transport. The client supplies only a canonical NetEase song binding, never
 * an upstream image URL. Metadata is fetched from one fixed origin and its song id must match
 * exactly; neither title nor album text is used as identity. No other provider is consulted.
 */
export function createNeteaseArtworkHandler(options: NeteaseArtworkOptions) {
  const prefix = `/api/providers/${options.providerId}/artwork/`
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (!options.publicOrigin || url.origin !== options.publicOrigin || url.search || url.hash || !url.pathname.startsWith(prefix)) return json('invalid_response', 400)
    const id = url.pathname.slice(prefix.length)
    if (!CHKSZ_ID_PATTERN.test(id)) return json('invalid_response', 400)
    if (request.method !== 'GET' && request.method !== 'HEAD') return json('method_not_allowed', 405)
    try {
      if (await options.isEnabled() !== true) return json('unavailable', 503)
    } catch { return json('unavailable', 503) }

    const controller = new AbortController()
    const abort = () => controller.abort()
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    const timeout = setTimeout(abort, ARTWORK_TIMEOUT_MS)
    try {
      const endpoint = new URL('https://music.163.com/api/song/detail/')
      endpoint.searchParams.set('id', id)
      endpoint.searchParams.set('ids', `[${id}]`)
      const metadataResponse = await options.fetch(endpoint.href, {
        method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal,
      })
      if (controller.signal.aborted) return json('timeout', 504)
      if (metadataResponse.status === 429) return json('rate_limited', 429)
      if (!metadataResponse.ok) return json('invalid_response', 502)
      const metadata = await readNeteaseArtworkMetadata(metadataResponse)
      if (controller.signal.aborted) return json('timeout', 504)
      if (!metadata.ok) return json('invalid_response', 502)
      const selected = exactSongArtwork(metadata.value, id)
      if (!selected.url) return json(selected.status === 404 ? 'not_found' : 'invalid_response', selected.status)
      selected.url.searchParams.set('param', `${MAX_ARTWORK_DIMENSION}y${MAX_ARTWORK_DIMENSION}`)
      const image = await options.fetch(selected.url.href, {
        method: request.method,
        headers: { accept: 'image/webp,image/jpeg,image/png,image/gif' },
        redirect: 'manual', signal: controller.signal,
      })
      if (controller.signal.aborted) return json('timeout', 504)
      if (image.status === 404) return json('not_found', 404)
      if (image.status === 429) return json('rate_limited', 429)
      if (!image.ok) return json('invalid_response', 502)
      const mime = normaliseImageMime(image.headers.get('content-type'))
      if (!mime) return json('invalid_response', 502)
      const length = image.headers.get('content-length')
      if (length !== null && (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_ARTWORK_BYTES)) return json('invalid_response', 502)
      const bytes = request.method === 'HEAD' ? null : await readArtworkBytes(image)
      if (controller.signal.aborted) return json('timeout', 504)
      if (request.method === 'GET' && !bytes) return json('invalid_response', 502)
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': mime,
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          ...(length === null ? {} : { 'content-length': length }),
        },
      })
    } catch { return json(controller.signal.aborted ? 'timeout' : 'unavailable', controller.signal.aborted ? 504 : 502) }
    finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort) }
  }
}
