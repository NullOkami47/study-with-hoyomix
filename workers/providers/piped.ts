import { selectBrowserAudio, type AudioCandidateDescriptor } from './audioSelection'
import { fetchResolverMetadata, type ResolverMetadataError } from './resolverMetadata'

export type PipedMetadataError = ResolverMetadataError

export type PipedMetadataResult =
  | { ok: true; mediaUrl: URL; mimeType: string }
  | { ok: false; error: PipedMetadataError }

export interface PipedMetadataOptions {
  configuredOrigin: string
  externalId: string
  fetch?: typeof fetch
  validateMediaUrl: (value: string) => URL | null
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const resolvePipedMetadata = async (
  options: PipedMetadataOptions,
): Promise<PipedMetadataResult> => {
  if (!YOUTUBE_ID.test(options.externalId)) {
    return { ok: false, error: 'invalid_response' }
  }

  let endpoint: string
  try {
    endpoint = new URL(`/streams/${options.externalId}`, options.configuredOrigin).href
  } catch {
    return { ok: false, error: 'unavailable' }
  }

  const metadata = await fetchResolverMetadata(endpoint, options.fetch ?? fetch)
  if (!metadata.ok) return metadata
  try {
    const body = metadata.value
    if (!isRecord(body) || !Array.isArray(body.audioStreams)) {
      return { ok: false, error: 'invalid_response' }
    }

    const candidates: AudioCandidateDescriptor[] = []
    for (const candidate of body.audioStreams) {
      if (
        !isRecord(candidate) || candidate.videoOnly === true ||
        typeof candidate.url !== 'string' || typeof candidate.mimeType !== 'string' ||
        !Number.isSafeInteger(candidate.bitrate) ||
        Number(candidate.bitrate) < 0
      ) {
        continue
      }
      candidates.push({
        bitrate: Number(candidate.bitrate),
        codec: typeof candidate.codec === 'string' ? candidate.codec : undefined,
        mimeType: candidate.mimeType,
        url: candidate.url,
      })
    }
    const selected = selectBrowserAudio(candidates, options.validateMediaUrl)
    if (selected) {
      return { ok: true, mediaUrl: selected.mediaUrl, mimeType: selected.mimeType }
    }
    return { ok: false, error: 'invalid_response' }
  } catch {
    return { ok: false, error: 'invalid_response' }
  }
}
