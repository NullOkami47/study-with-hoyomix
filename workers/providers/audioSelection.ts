const AUDIO_MIME = /^audio\/[a-z0-9!#$&^_.+-]+$/
const UNSUPPORTED_CODEC = /(?:^|[^a-z0-9])(?:ac-?3|eac-?3|ec-?3|dts)(?:[^a-z0-9]|$)/

export interface AudioCandidateDescriptor {
  bitrate: number
  codec?: string
  mimeType: string
  url: string
}

export interface SelectedAudioCandidate {
  bitrate: number
  mediaUrl: URL
  mimeType: string
}

const mimeEssence = (value: string): string | null => {
  const essence = value.split(';', 1)[0]?.trim().toLowerCase()
  return essence && AUDIO_MIME.test(essence) ? essence : null
}

const codecPreference = (mimeType: string, rawMimeType: string, codec?: string): number | null => {
  const hint = `${rawMimeType};${codec ?? ''}`.toLowerCase()
  if (UNSUPPORTED_CODEC.test(hint)) return null
  if (mimeType === 'audio/mp4' && /(?:mp4a|aac)/.test(hint)) return 0
  if ((mimeType === 'audio/webm' || mimeType === 'audio/ogg') && /opus/.test(hint)) return 1
  if (mimeType === 'audio/mpeg' || /(?:^|[^a-z0-9])mp3(?:[^a-z0-9]|$)/.test(hint)) return 2
  if (mimeType === 'audio/mp4') return 3
  if (mimeType === 'audio/webm') return 4
  return 5
}

export const selectBrowserAudio = (
  values: readonly AudioCandidateDescriptor[],
  validateMediaUrl: (value: string) => URL | null,
): SelectedAudioCandidate | null => {
  const candidates: Array<SelectedAudioCandidate & { preference: number }> = []
  for (const value of values) {
    if (!Number.isSafeInteger(value.bitrate) || value.bitrate < 0) continue
    const mimeType = mimeEssence(value.mimeType)
    if (!mimeType) continue
    const preference = codecPreference(mimeType, value.mimeType, value.codec)
    if (preference === null) continue
    let mediaUrl: URL | null
    try {
      mediaUrl = validateMediaUrl(value.url)
    } catch {
      mediaUrl = null
    }
    if (mediaUrl) candidates.push({
      bitrate: value.bitrate,
      mediaUrl,
      mimeType,
      preference,
    })
  }

  candidates.sort((left, right) =>
    left.preference - right.preference ||
    right.bitrate - left.bitrate ||
    left.mediaUrl.toString().localeCompare(right.mediaUrl.toString()))
  const selected = candidates[0]
  return selected
    ? { bitrate: selected.bitrate, mediaUrl: selected.mediaUrl, mimeType: selected.mimeType }
    : null
}
