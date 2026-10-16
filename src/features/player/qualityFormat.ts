import type { TranslationKey } from '../../i18n'
import type { Playable, AudioQualityMetadata } from './providers/types'

export type QualityTranslationKey =
  | 'player.qualityStandard'
  | 'player.qualityExhigh'
  | 'player.qualityLossless'
  | 'player.qualityHires'
  | 'player.qualityJyeffect'
  | 'player.qualitySky'
  | 'player.qualityJymaster'

export type I18nFormatter = (key: QualityTranslationKey, params?: Record<string, string | number>) => string

export function formatSampleRate(sampleRate: number): string {
  if (sampleRate >= 1000) {
    const khz = sampleRate / 1000
    // e.g. 44.1 kHz, 96 kHz, 48 kHz, 88.2 kHz, 192 kHz
    const formatted = Number.isInteger(khz) ? khz.toString() : khz.toFixed(1).replace(/\.0$/, '')
    return `${formatted} kHz`
  }
  return `${sampleRate} Hz`
}

export function formatBitrate(bitrate: number): string {
  const kbps = Math.round(bitrate / 1000)
  return `${kbps} kbps`
}

export function formatTierLabel(tier: string, text: I18nFormatter): string {
  const normalized = tier.toLowerCase().trim()
  switch (normalized) {
    case 'standard':
      return text('player.qualityStandard')
    case 'higher':
    case 'exhigh':
      return text('player.qualityExhigh')
    case 'lossless':
      return text('player.qualityLossless')
    case 'hires':
      return text('player.qualityHires')
    case 'jyeffect':
      return text('player.qualityJyeffect')
    case 'sky':
      return text('player.qualitySky')
    case 'jymaster':
      return text('player.qualityJymaster')
    default:
      return normalized
  }
}

/**
 * Formats user-facing playback quality information from Playable metadata.
 *
 * Produces clean, audiophile-accurate strings such as:
 * - `FLAC · 24-bit · 96 kHz`
 * - `FLAC · 44.1 kHz`
 * - `AAC · 256 kbps`
 * - `320 kbps`
 * - `Lossless`
 * - `Hi-Res`
 * - `Standard`
 */
export function formatPlaybackQuality(
  playable: Playable | null | undefined,
  text: I18nFormatter = (key) => key,
): string {
  if (!playable) return ''

  if (playable.kind === 'youtube') {
    return text('player.qualityStandard')
  }

  const meta = playable.metadata?.quality

  if (meta?.codec) {
    const codecUpper = meta.codec.toUpperCase()
    const parts: string[] = [codecUpper]

    if (meta.codec.toLowerCase() === 'flac') {
      if (meta.bitDepth) {
        parts.push(`${meta.bitDepth}-bit`)
      }
      if (meta.sampleRate) {
        parts.push(formatSampleRate(meta.sampleRate))
      } else if (meta.bitrate) {
        parts.push(formatBitrate(meta.bitrate))
      }
      return parts.join(' · ')
    }

    // For lossy or other codecs (AAC, MP3, OPUS, VORBIS, etc.)
    if (meta.bitDepth && meta.bitDepth > 16) {
      parts.push(`${meta.bitDepth}-bit`)
    }
    if (meta.sampleRate && meta.sampleRate > 48000) {
      parts.push(formatSampleRate(meta.sampleRate))
    }
    if (meta.bitrate) {
      parts.push(formatBitrate(meta.bitrate))
    }
    return parts.join(' · ')
  }

  // Codec not provided, but technical audio stream specs present
  if (meta?.sampleRate || meta?.bitDepth) {
    const parts: string[] = []
    if (meta.tier === 'lossless' || meta.tier === 'hires') {
      parts.push(formatTierLabel(meta.tier, text))
    }
    if (meta.bitDepth) {
      parts.push(`${meta.bitDepth}-bit`)
    }
    if (meta.sampleRate) {
      parts.push(formatSampleRate(meta.sampleRate))
    }
    if (parts.length > 0) return parts.join(' · ')
  }

  // Tier / bitrate only (e.g. streaming tiers from ChKSz)
  if (meta?.tier === 'lossless') {
    return text('player.qualityLossless')
  }
  if (meta?.tier === 'hires') {
    return text('player.qualityHires')
  }
  if (meta?.bitrate) {
    return formatBitrate(meta.bitrate)
  }
  if (meta?.tier) {
    return formatTierLabel(meta.tier, text)
  }

  // Fallback to MIME type
  if (playable.mimeType === 'audio/flac') {
    return `FLAC · ${text('player.qualityLossless')}`
  }
  if (playable.mimeType === 'audio/mpeg' || playable.mimeType === 'audio/mp3') {
    return 'MP3'
  }
  if (playable.mimeType === 'audio/mp4' || playable.mimeType === 'audio/aac') {
    return 'AAC'
  }

  return text('player.qualityStandard')
}
