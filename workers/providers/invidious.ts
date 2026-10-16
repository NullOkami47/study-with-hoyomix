import { selectBrowserAudio, type AudioCandidateDescriptor } from './audioSelection'
import { fetchResolverMetadata, type ResolverMetadataError } from './resolverMetadata'

export type InvidiousMetadataError = ResolverMetadataError

export type InvidiousMetadataResult =
  | { ok: true; mediaUrl: URL; mimeType: string }
  | { ok: false; error: InvidiousMetadataError }

export interface InvidiousMetadataOptions {
  configuredOrigin: string
  externalId: string
  fetch?: typeof fetch
  validateMediaUrl: (value: string) => URL | null
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseBitrate = (value: unknown): number | null => {
  if (typeof value === 'string' && !/^[0-9]+$/.test(value)) return null
  const bitrate = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  return Number.isSafeInteger(bitrate) && bitrate >= 0 ? bitrate : null
}

export const resolveInvidiousMetadata = async (
  options: InvidiousMetadataOptions,
): Promise<InvidiousMetadataResult> => {
  if (!YOUTUBE_ID.test(options.externalId)) {
    return { ok: false, error: 'invalid_response' }
  }

  let endpoint: string
  try {
    endpoint = new URL(
      `/api/v1/videos/${options.externalId}?local=true`,
      options.configuredOrigin,
    ).toString()
  } catch {
    return { ok: false, error: 'unavailable' }
  }

  const metadata = await fetchResolverMetadata(endpoint, options.fetch ?? fetch)
  if (!metadata.ok) return metadata
  try {
    if (!isRecord(metadata.value) || !Array.isArray(metadata.value.adaptiveFormats)) {
      return { ok: false, error: 'invalid_response' }
    }

    const candidates: AudioCandidateDescriptor[] = []
    for (const candidate of metadata.value.adaptiveFormats) {
      if (
        !isRecord(candidate) || typeof candidate.url !== 'string' ||
        typeof candidate.type !== 'string'
      ) continue
      const bitrate = parseBitrate(candidate.bitrate)
      if (bitrate === null) continue
      candidates.push({
        bitrate,
        codec: typeof candidate.encoding === 'string' ? candidate.encoding : undefined,
        mimeType: candidate.type,
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
