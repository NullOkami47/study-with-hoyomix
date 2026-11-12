import { detectVersionMarkers } from '../../src/shared/versionSignature'
import type { ResolverMetadataError } from './resolverMetadata'

export interface VkeysIdentity {
  trackId: string
  neteaseId: string
  title: string
  titleAliases: string[]
  artists: string[]
  durationSeconds: number
  tencentMid?: string
  versionMarkers?: string[]
}

export type VkeysMetadataResult =
  | { ok: true; mediaUrl: URL; mimeType: 'audio/mpeg'; expiresAt?: number }
  | { ok: false; error: ResolverMetadataError }

export interface VkeysMetadataOptions {
  identity: VkeysIdentity
  fetch: typeof fetch
  signal?: AbortSignal
  /** Epoch milliseconds; sampled after the upstream link has resolved. */
  now?: () => number
}

const API_ROOT = 'https://api.vkeys.cn/music/tencent/'
const METADATA_TIMEOUT_MS = 8_000
const MAX_METADATA_BYTES = 128 * 1024
const UPSTREAM_EXPIRY_MARGIN_MS = 30_000
const validMid = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() === value && /^[a-zA-Z0-9]{1,64}$/.test(value)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const numeric = (value: unknown): number =>
  typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN

const artistSet = (values: string[]): Set<string> =>
  new Set(values.flatMap(value => value.split('/').map(artist => artist.trim())))

const matchesIdentity = (song: Record<string, unknown>, identity: VkeysIdentity): boolean => {
  if (typeof song.title !== 'string' || typeof song.singer !== 'string') return false
  const titles = [identity.title, ...identity.titleAliases].map(title => title.trim())
  const expected = artistSet(identity.artists)
  const actual = artistSet([song.singer])
  const seconds = numeric(song.interval)
  const expectedVersions = new Set([...detectVersionMarkers(identity.title), ...(identity.versionMarkers ?? [])])
  const actualVersions = detectVersionMarkers(song.title)
  return titles.includes(song.title.trim())
    && actualVersions.length === expectedVersions.size && actualVersions.every(marker => expectedVersions.has(marker))
    && actual.size === expected.size && !actual.has('')
    && [...actual].every(artist => expected.has(artist))
    && Number.isFinite(seconds) && seconds > 0
    && Math.abs(seconds - identity.durationSeconds) <= 3
    && (song.type === undefined || numeric(song.type) === 0)
}

// Apply this validator again to every media redirect target in the audio proxy.
// Metadata requests never follow redirects; this adapter does not fetch media.
export const validateVkeysMediaUrl = (value: string): URL | null => {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\#]/.test(value)) return null
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1]
  if (!authority || authority.includes('@')) return null
  try {
    const url = new URL(value)
    const host = url.hostname
    if (url.username || url.password || url.hash || url.port) return null
    if (host !== 'stream.qqmusic.qq.com' && !host.endsWith('.stream.qqmusic.qq.com')) return null
    if (!host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
    if (url.protocol === 'http:') url.protocol = 'https:'
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

class MetadataFailure extends Error {
  constructor(readonly error: ResolverMetadataError) {
    super(error)
  }
}

// Only explicit decimal UNIX seconds carry expiry evidence. Never infer a lifetime
// from a vkey, an unrelated timestamp, or the local media-ticket TTL.
const explicitExpiry = (url: URL, now: () => number): number | undefined => {
  const values = [...url.searchParams.getAll('expire'), ...url.searchParams.getAll('expires')]
  if (!values.length) return undefined
  let expiresAt = Infinity
  for (const value of values) {
    if (!value || /[^0-9]/.test(value)) throw new MetadataFailure('invalid_response')
    const milliseconds = Number(value) * 1000
    if (!Number.isSafeInteger(milliseconds)) throw new MetadataFailure('invalid_response')
    expiresAt = Math.min(expiresAt, milliseconds)
  }
  const currentTime = now()
  if (!Number.isFinite(currentTime)) throw new MetadataFailure('invalid_response')
  if (expiresAt <= currentTime + UPSTREAM_EXPIRY_MARGIN_MS) throw new MetadataFailure('unavailable')
  return expiresAt
}

export const resolveVkeysMetadata = async (
  options: VkeysMetadataOptions,
): Promise<VkeysMetadataResult> => {
  if (options.signal?.aborted) return { ok: false, error: 'timeout' }
  const { identity } = options
  if (!identity || typeof identity.title !== 'string' || !identity.title.trim()
    || !Array.isArray(identity.titleAliases) || !identity.titleAliases.every(title => typeof title === 'string' && title.trim())
    || !Array.isArray(identity.artists) || !identity.artists.length
    || !identity.artists.every(artist => typeof artist === 'string' && artist.trim())
    || artistSet(identity.artists).has('')
    || !Number.isFinite(identity.durationSeconds) || identity.durationSeconds <= 0
    || (identity.versionMarkers !== undefined && (!Array.isArray(identity.versionMarkers)
      || !identity.versionMarkers.every(marker => typeof marker === 'string' && marker.trim())))
    || (identity.tencentMid !== undefined && !validMid(identity.tencentMid))) {
    return { ok: false, error: 'invalid_response' }
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, METADATA_TIMEOUT_MS)
  const checkAbort = () => {
    if (controller.signal.aborted) throw new MetadataFailure('timeout')
  }
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new MetadataFailure('timeout'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })

  let cancelOwnedBody: (() => void) | undefined
  const get = async (path: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    checkAbort()
    const url = new URL(path, API_ROOT)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const response = await options.fetch(url.href, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    })
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let consumed = false
    let cancelled = false
    const cancel = () => {
      if (consumed || cancelled) return
      cancelled = true
      // A hanging/rejected upstream cancellation cannot delay an error or timeout.
      try { void (reader ? reader.cancel() : response.body?.cancel())?.catch(() => {}) } catch { /* already closed */ }
    }
    cancelOwnedBody = cancel
    try {
      // Even a fetch that ignores abort and resolves after the deadline still owns a body.
      checkAbort()
      if (response.status === 429) throw new MetadataFailure('rate_limited')
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw new MetadataFailure('invalid_response')
      if (!response.ok) throw new MetadataFailure('unavailable')
      const length = response.headers.get('content-length')
      if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
        || (length !== null && (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_METADATA_BYTES))) {
        throw new MetadataFailure('invalid_response')
      }
      reader = response.body?.getReader()
      if (!reader) throw new MetadataFailure('invalid_response')
      let body: unknown
      try {
        const chunks: Uint8Array[] = []
        let received = 0
        while (true) {
          const { done, value } = await reader.read()
          checkAbort()
          if (done) { consumed = true; break }
          received += value.byteLength
          if (received > MAX_METADATA_BYTES) throw new MetadataFailure('invalid_response')
          chunks.push(value)
        }
        const bytes = new Uint8Array(received)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
        body = JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        throw new MetadataFailure('invalid_response')
      }
      if (!isRecord(body)) throw new MetadataFailure('invalid_response')
      if (body.code === 429) throw new MetadataFailure('rate_limited')
      if (body.code === 403) throw new MetadataFailure('unavailable')
      if (body.code !== 0 && body.code !== 200) throw new MetadataFailure('invalid_response')
      if (!isRecord(body.data)) throw new MetadataFailure('invalid_response')
      return body.data
    } finally {
      cancel()
      reader?.releaseLock()
      if (cancelOwnedBody === cancel) cancelOwnedBody = undefined
    }
  }

  const resolve = async (): Promise<VkeysMetadataResult> => {
    let mid = identity.tencentMid
    if (mid === undefined) {
      const search = await get('search/song', { keyword: identity.title, page: '1', limit: '10' })
      if (!Array.isArray(search.list) || search.list.length > 10 || !search.list.every(isRecord)) {
        throw new MetadataFailure('invalid_response')
      }
      const candidates = search.list.filter(song => matchesIdentity(song, identity))
      if (candidates.some(song => !validMid(song.songMID))) {
        throw new MetadataFailure('invalid_response')
      }
      const mids = [...new Set(candidates.map(song => song.songMID as string))]
      if (mids.length !== 1) throw new MetadataFailure('unavailable')
      mid = mids[0]!
    }
    const info = await get('song/info', { mid, type: '0' })
    if (info.songMID !== mid || !matchesIdentity(info, identity)) throw new MetadataFailure('invalid_response')
    if (info.pay !== '免费') throw new MetadataFailure('unavailable')
    if (!Array.isArray(info.qualityInfo)) throw new MetadataFailure('invalid_response')
    if (!info.qualityInfo.some(quality => isRecord(quality) && numeric(quality.type) === 6
      && Number.isFinite(numeric(quality.size)) && numeric(quality.size) > 0)) {
      throw new MetadataFailure('unavailable')
    }
    const link = await get('song/link', { mid, type: '0', quality: '6' })
    if (link.songMID !== mid || typeof link.url !== 'string') throw new MetadataFailure('invalid_response')
    const mediaUrl = validateVkeysMediaUrl(link.url)
    if (!mediaUrl) throw new MetadataFailure('invalid_response')
    const expiresAt = explicitExpiry(mediaUrl, options.now ?? Date.now)
    return { ok: true, mediaUrl, mimeType: 'audio/mpeg', ...(expiresAt === undefined ? {} : { expiresAt }) }
  }

  let succeeded = false
  try {
    // Racing the complete pipeline also bounds bodies/fetch mocks that ignore abort signals.
    const result = await Promise.race([resolve(), aborted])
    succeeded = result.ok
    return result
  } catch (error) {
    return { ok: false, error: controller.signal.aborted ? 'timeout'
      : error instanceof MetadataFailure ? error.error : 'unavailable' }
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onAbort)
    if (!succeeded) {
      controller.abort()
      cancelOwnedBody?.()
    }
  }
}
