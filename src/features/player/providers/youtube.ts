import type { Track } from '../../catalog/types'
import { ProviderResolveError, type AudioProvider } from './types'

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/

export function isYouTubeVideoId(value: string): boolean {
  return VIDEO_ID_PATTERN.test(value)
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('YouTube resolution aborted', 'AbortError')
}

export const youtubeProvider: AudioProvider = {
  id: 'youtube',
  async resolve(track: Track, signal: AbortSignal) {
    if (signal.aborted) throw abortReason(signal)

    const source = track.sources.find(({ provider }) => provider === 'youtube')
    if (!source) return null
    if (!isYouTubeVideoId(source.externalId)) {
      throw new ProviderResolveError('invalid_response')
    }

    return { kind: 'youtube', videoId: source.externalId }
  },
}
