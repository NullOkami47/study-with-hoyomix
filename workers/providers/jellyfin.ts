import { readBoundedJsonResponse } from './boundedJson'
import type { ResolverMetadataError } from './resolverMetadata'

export type JellyfinMetadataError = ResolverMetadataError

export interface JellyfinAudioQuality {
  codec?: string
  container?: string
  bitrate?: number
  sampleRate?: number
  bitDepth?: number
}

export type JellyfinMetadataResult =
  | {
      ok: true
      mediaUrl: URL
      mimeType: string
      directPlay: boolean
      itemId: string
      container: string
      quality?: JellyfinAudioQuality
      hasArtwork?: boolean
      artworkId?: string
    }
  | { ok: false; error: JellyfinMetadataError; upstreamStatus?: number }

export interface JellyfinMetadataOptions {
  configuredOrigin: string
  apiToken: string
  userId: string
  externalId: string
  fetch?: typeof fetch
  validateMediaUrl?: (value: string) => URL | null
}

export const JELLYFIN_ITEM_ID_PATTERN =
  /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/

export const JELLYFIN_USER_ID_PATTERN = JELLYFIN_ITEM_ID_PATTERN

/**
 * Jellyfin 12 authenticates with `Authorization: MediaBrowser Token="…"` and rejects the legacy
 * `X-Emby-Token` header with HTTP 401. Every authenticated request — metadata resolution and the
 * streamed media proxy alike — must build its credentials through this one helper so the two
 * cannot drift apart, and so there is exactly one place to audit for header shape.
 *
 * The token is deliberately passed through the header only: it must never be placed in a URL,
 * a query string, a response body, or a log record.
 */
export const jellyfinAuthHeaders = (token: string): HeadersInit => ({
  authorization: `MediaBrowser Token="${token}"`,
})

const METADATA_TIMEOUT_MS = 4_000
const MAX_METADATA_BYTES = 64 * 1024

const AUDIO_CONTAINER_MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  wave: 'audio/wav',
  webm: 'audio/webm',
  weba: 'audio/webm',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseJellyfinExternalId = (value: string): string | null => {
  if (typeof value !== 'string') return null
  if (value.trim() !== value) return null
  if (!JELLYFIN_ITEM_ID_PATTERN.test(value)) return null
  return value.replace(/-/g, '').toLowerCase()
}

/**
 * Normalises a configured Jellyfin user ID. Jellyfin identifies users by GUID, so the accepted
 * shape is the same conservative allowlist as an item ID: 32 hex characters, optionally
 * hyphenated as a UUID. Anything else — including the example placeholder — is rejected so a
 * half-configured deployment reports as unavailable instead of issuing a request that is
 * guaranteed to return HTTP 400.
 */
export const parseJellyfinUserId = (value: string): string | null => {
  if (typeof value !== 'string') return null
  if (value.trim() !== value) return null
  if (!JELLYFIN_USER_ID_PATTERN.test(value)) return null
  return value.replace(/-/g, '').toLowerCase()
}

export const resolveJellyfinMetadata = async (
  options: JellyfinMetadataOptions,
): Promise<JellyfinMetadataResult> => {
  if (typeof options.apiToken !== 'string' || options.apiToken.trim().length === 0) {
    return { ok: false, error: 'unavailable' }
  }

  // Jellyfin 12 requires explicit user context on the single-item route: without `userId` the
  // same request that returns HTTP 200 with it returns HTTP 400.
  const userId = parseJellyfinUserId(options.userId)
  if (!userId) {
    return { ok: false, error: 'unavailable' }
  }

  const itemId = parseJellyfinExternalId(options.externalId)
  if (!itemId) {
    return { ok: false, error: 'invalid_response' }
  }

  let metadataUrl: URL
  let mediaUrl: URL
  try {
    metadataUrl = new URL(`/Items/${itemId}`, options.configuredOrigin)
    metadataUrl.searchParams.set('userId', userId)
    mediaUrl = new URL(`/Audio/${itemId}/stream?static=true`, options.configuredOrigin)
  } catch {
    return { ok: false, error: 'unavailable' }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS)

  try {
    const response = await (options.fetch ?? fetch)(metadataUrl.href, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...jellyfinAuthHeaders(options.apiToken),
      },
      redirect: 'manual',
      signal: controller.signal,
    })

    if (response.status === 429) {
      return { ok: false, error: 'rate_limited', upstreamStatus: response.status }
    }
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, error: 'invalid_response', upstreamStatus: response.status }
    }
    if (!response.ok) {
      // The numeric status is the only upstream detail surfaced. It is not sensitive on its own
      // and it is what distinguishes a credential rejection (401/403) from a missing user context
      // (400) or an absent item (404) — the three failures that were previously indistinguishable
      // behind a single `unavailable`. Headers, bodies, and the request URL are never included.
      return { ok: false, error: 'unavailable', upstreamStatus: response.status }
    }

    const parsed = await readBoundedJsonResponse(response, MAX_METADATA_BYTES)
    if (controller.signal.aborted) return { ok: false, error: 'timeout' }
    if (!parsed.ok) return { ok: false, error: 'invalid_response' }

    const body = parsed.value
    if (!isRecord(body)) return { ok: false, error: 'invalid_response' }

    if (
      typeof body.Id !== 'string' ||
      body.Id.replace(/-/g, '').toLowerCase() !== itemId
    ) {
      return { ok: false, error: 'invalid_response' }
    }

    if (body.Type !== 'Audio') return { ok: false, error: 'invalid_response' }
    if (typeof body.MediaType === 'string' && body.MediaType !== 'Audio') {
      return { ok: false, error: 'invalid_response' }
    }

    let container: string | undefined
    if (typeof body.Container === 'string' && body.Container.trim()) {
      container = body.Container.toLowerCase().trim()
    } else if (Array.isArray(body.MediaSources) && body.MediaSources.length > 0) {
      const firstSource = body.MediaSources[0]
      if (isRecord(firstSource) && typeof firstSource.Container === 'string') {
        container = firstSource.Container.toLowerCase().trim()
      }
    }

    if (!container || !AUDIO_CONTAINER_MIME_TYPES[container]) {
      return { ok: false, error: 'invalid_response' }
    }
    const mimeType = AUDIO_CONTAINER_MIME_TYPES[container]!

    let directPlay = true
    if (Array.isArray(body.MediaSources) && body.MediaSources.length > 0) {
      const firstSource = body.MediaSources[0]
      if (
        isRecord(firstSource) &&
        firstSource.SupportsDirectPlay === false &&
        firstSource.SupportsDirectStream === false
      ) {
        directPlay = false
      }
    }

    if (options.validateMediaUrl && !options.validateMediaUrl(mediaUrl.toString())) {
      return { ok: false, error: 'invalid_response' }
    }

    let audioStream: Record<string, unknown> | undefined
    if (Array.isArray(body.MediaStreams)) {
      audioStream = body.MediaStreams.find((s) => isRecord(s) && s.Type === 'Audio') as Record<string, unknown> | undefined
    }
    if (!audioStream && Array.isArray(body.MediaSources) && body.MediaSources.length > 0) {
      const firstSource = body.MediaSources[0]
      if (isRecord(firstSource) && Array.isArray(firstSource.MediaStreams)) {
        audioStream = firstSource.MediaStreams.find((s) => isRecord(s) && s.Type === 'Audio') as Record<string, unknown> | undefined
      }
    }

    let codec: string | undefined
    if (audioStream && typeof audioStream.Codec === 'string' && audioStream.Codec.trim()) {
      codec = audioStream.Codec.toLowerCase().trim()
    } else if (container) {
      codec = container
    }

    let sampleRate: number | undefined
    if (audioStream && typeof audioStream.SampleRate === 'number' && Number.isSafeInteger(audioStream.SampleRate) && audioStream.SampleRate > 0) {
      sampleRate = audioStream.SampleRate
    }

    let bitDepth: number | undefined
    if (audioStream && typeof audioStream.BitDepth === 'number' && Number.isSafeInteger(audioStream.BitDepth) && audioStream.BitDepth > 0) {
      bitDepth = audioStream.BitDepth
    }

    let bitrate: number | undefined
    if (audioStream && typeof audioStream.BitRate === 'number' && Number.isSafeInteger(audioStream.BitRate) && audioStream.BitRate > 0) {
      bitrate = audioStream.BitRate
    } else if (Array.isArray(body.MediaSources) && body.MediaSources.length > 0 && isRecord(body.MediaSources[0]) && typeof body.MediaSources[0].Bitrate === 'number' && Number.isSafeInteger(body.MediaSources[0].Bitrate) && body.MediaSources[0].Bitrate > 0) {
      bitrate = body.MediaSources[0].Bitrate
    } else if (typeof body.TotalBitrate === 'number' && Number.isSafeInteger(body.TotalBitrate) && body.TotalBitrate > 0) {
      bitrate = body.TotalBitrate
    }

    const quality: JellyfinAudioQuality = {
      ...(codec ? { codec } : {}),
      container,
      ...(sampleRate ? { sampleRate } : {}),
      ...(bitDepth ? { bitDepth } : {}),
      ...(bitrate ? { bitrate } : {}),
    }

    let hasArtwork = false
    let artworkId: string | undefined
    if (isRecord(body.ImageTags) && typeof body.ImageTags.Primary === 'string' && body.ImageTags.Primary.trim()) {
      hasArtwork = true
      artworkId = itemId
    } else if (typeof body.AlbumId === 'string' && typeof body.AlbumPrimaryImageTag === 'string' && body.AlbumPrimaryImageTag.trim()) {
      const albumIdNorm = parseJellyfinExternalId(body.AlbumId)
      if (albumIdNorm) {
        hasArtwork = true
        artworkId = albumIdNorm
      }
    } else if (body.HasPrimaryImage === true) {
      hasArtwork = true
      artworkId = itemId
    }

    return {
      ok: true,
      mediaUrl,
      mimeType,
      directPlay,
      itemId,
      container,
      quality,
      hasArtwork,
      ...(artworkId ? { artworkId } : {}),
    }
  } catch {
    return { ok: false, error: controller.signal.aborted ? 'timeout' : 'unavailable' }
  } finally {
    clearTimeout(timeout)
  }
}
