import { describe, expect, it } from 'vitest'
import type { Playable } from './providers/types'
import {
  formatBitrate,
  formatPlaybackQuality,
  formatSampleRate,
  formatTierLabel,
} from './qualityFormat'

const mockText = (key: string): string => {
  const map: Record<string, string> = {
    'player.qualityStandard': 'Standard',
    'player.qualityExhigh': 'High Quality',
    'player.qualityLossless': 'Lossless',
    'player.qualityHires': 'Hi-Res',
    'player.qualityJyeffect': 'HD Surround',
    'player.qualitySky': 'Immersive',
    'player.qualityJymaster': 'Master',
  }
  return map[key] ?? key
}

describe('qualityFormat', () => {
  describe('formatSampleRate', () => {
    it('formats sample rates in kHz and Hz', () => {
      expect(formatSampleRate(96000)).toBe('96 kHz')
      expect(formatSampleRate(44100)).toBe('44.1 kHz')
      expect(formatSampleRate(48000)).toBe('48 kHz')
      expect(formatSampleRate(88200)).toBe('88.2 kHz')
      expect(formatSampleRate(192000)).toBe('192 kHz')
      expect(formatSampleRate(800)).toBe('800 Hz')
    })
  })

  describe('formatBitrate', () => {
    it('formats bitrate in kbps', () => {
      expect(formatBitrate(320000)).toBe('320 kbps')
      expect(formatBitrate(128000)).toBe('128 kbps')
      expect(formatBitrate(256000)).toBe('256 kbps')
    })
  })

  describe('formatTierLabel', () => {
    it('translates known tier keys', () => {
      expect(formatTierLabel('standard', mockText)).toBe('Standard')
      expect(formatTierLabel('exhigh', mockText)).toBe('High Quality')
      expect(formatTierLabel('lossless', mockText)).toBe('Lossless')
      expect(formatTierLabel('hires', mockText)).toBe('Hi-Res')
      expect(formatTierLabel('jyeffect', mockText)).toBe('HD Surround')
      expect(formatTierLabel('sky', mockText)).toBe('Immersive')
      expect(formatTierLabel('jymaster', mockText)).toBe('Master')
    })
  })

  describe('formatPlaybackQuality', () => {
    it('returns empty string for null or undefined playable', () => {
      expect(formatPlaybackQuality(null, mockText)).toBe('')
      expect(formatPlaybackQuality(undefined, mockText)).toBe('')
    })

    it('formats FLAC 24-bit 96 kHz', () => {
      const playable: Playable = {
        kind: 'audio',
        url: 'https://example.com/audio.flac',
        mimeType: 'audio/flac',
        metadata: {
          quality: {
            codec: 'flac',
            bitDepth: 24,
            sampleRate: 96000,
          },
        },
      }
      expect(formatPlaybackQuality(playable, mockText)).toBe('FLAC · 24-bit · 96 kHz')
    })

    it('formats FLAC 44.1 kHz without bit depth', () => {
      const playable: Playable = {
        kind: 'audio',
        url: 'https://example.com/audio.flac',
        mimeType: 'audio/flac',
        metadata: {
          quality: {
            codec: 'flac',
            sampleRate: 44100,
          },
        },
      }
      expect(formatPlaybackQuality(playable, mockText)).toBe('FLAC · 44.1 kHz')
    })

    it('formats AAC with bitrate', () => {
      const playable: Playable = {
        kind: 'audio',
        url: 'https://example.com/audio.m4a',
        mimeType: 'audio/mp4',
        metadata: {
          quality: {
            codec: 'aac',
            bitrate: 256000,
          },
        },
      }
      expect(formatPlaybackQuality(playable, mockText)).toBe('AAC · 256 kbps')
    })

    it('formats MP3 with bitrate', () => {
      const playable: Playable = {
        kind: 'audio',
        url: 'https://example.com/audio.mp3',
        mimeType: 'audio/mpeg',
        metadata: {
          quality: {
            codec: 'mp3',
            bitrate: 320000,
          },
        },
      }
      expect(formatPlaybackQuality(playable, mockText)).toBe('MP3 · 320 kbps')
    })

    it('formats bitrate without codec (e.g. 320 kbps from ChKSz exhigh)', () => {
      const playable: Playable = {
        kind: 'audio',
        url: 'https://example.com/audio.mp3',
        mimeType: 'audio/mpeg',
        metadata: {
          quality: {
            tier: 'exhigh',
            bitrate: 320000,
          },
        },
      }
      expect(formatPlaybackQuality(playable, mockText)).toBe('320 kbps')
    })

    it('formats Lossless tier without detailed codec specs', () => {
      const playable: Playable = {
        kind: 'audio',
        url: 'https://example.com/audio.flac',
        mimeType: 'audio/flac',
        metadata: {
          quality: {
            tier: 'lossless',
          },
        },
      }
      expect(formatPlaybackQuality(playable, mockText)).toBe('Lossless')
    })

    it('formats Hi-Res tier without detailed codec specs', () => {
      const playable: Playable = {
        kind: 'audio',
        url: 'https://example.com/audio.flac',
        mimeType: 'audio/flac',
        metadata: {
          quality: {
            tier: 'hires',
          },
        },
      }
      expect(formatPlaybackQuality(playable, mockText)).toBe('Hi-Res')
    })

    it('formats Standard tier without bitrate', () => {
      const playable: Playable = {
        kind: 'audio',
        url: 'https://example.com/audio.mp3',
        mimeType: 'audio/mpeg',
        metadata: {
          quality: {
            tier: 'standard',
          },
        },
      }
      expect(formatPlaybackQuality(playable, mockText)).toBe('Standard')
    })

    it('formats YouTube playable as Standard', () => {
      const playable: Playable = {
        kind: 'youtube',
        videoId: 'dQw4w9WgXcQ',
      }
      expect(formatPlaybackQuality(playable, mockText)).toBe('Standard')
    })

    it('falls back to MIME type when metadata is absent', () => {
      const flac: Playable = {
        kind: 'audio',
        url: 'https://example.com/audio.flac',
        mimeType: 'audio/flac',
      }
      expect(formatPlaybackQuality(flac, mockText)).toBe('FLAC · Lossless')

      const mp3: Playable = {
        kind: 'audio',
        url: 'https://example.com/audio.mp3',
        mimeType: 'audio/mpeg',
      }
      expect(formatPlaybackQuality(mp3, mockText)).toBe('MP3')
    })
  })
})
