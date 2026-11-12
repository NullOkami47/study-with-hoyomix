import { describe, expect, it, vi } from 'vitest'
import type { Track } from '../../catalog/types'
import type { LxSourceRecord, LxSourceRepository } from '../lx/types'
import type { LxGlobalSourceRepository } from '../lx/globalSourceRepository'
import type { LxRuntimeClient } from '../lx/runtime/client'
import type { ProviderAttempt } from './types'
import { createLxUserProvider as createProvider, mergeLxSourceChain, type LxUserProviderOptions } from './lxUser'

// H-01: returned media URLs are checked against the build's media-src. These cases exercise the
// source loop with fixture media hosts under example.com, so they inject a media list naming that
// family instead of relying on the build. lxCspBlocked.spec.ts covers the refusal itself.
const FIXTURE_CSP = { connect: [], media: ['https://*.example.com'] }
const createLxUserProvider = (options: LxUserProviderOptions = {}) =>
  createProvider({ cspSources: FIXTURE_CSP, ...options })

function createTrack(sources: Track['sources'], extra: Partial<Track> = {}): Track {
  return {
    id: 'track-test-1',
    title: 'Song of the Wind',
    aliases: {},
    games: ['genshin'],
    relationIds: [],
    tabs: ['focus'],
    workGroupId: 'wg-test',
    needsClassification: false,
    vocalStatus: 'instrumental',
    sources,
    ...extra,
  }
}

function createMockSource(id: string, name: string, priority: number, enabled = true): LxSourceRecord {
  return {
    id,
    name,
    sha256: `sha256-${id}`,
    enabled,
    priority,
    script: `// script for ${name}`,
    builtIn: id.startsWith('builtin'),
    importedAt: 1000,
    updatedAt: 1000,
  }
}

function createMockRepository(sources: LxSourceRecord[]): LxSourceRepository {
  return {
    list: vi.fn().mockResolvedValue(sources),
    get: vi.fn().mockImplementation(async (id: string) => sources.find((s) => s.id === id) ?? null),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    reorder: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    importScript: vi.fn(),
    importRemote: vi.fn(),
    refreshRemote: vi.fn(),
  }
}

describe('createLxUserProvider', () => {
  it('has provider id lx', () => {
    const provider = createLxUserProvider()
    expect(provider.id).toBe('lx')
  })

  describe('canResolve', () => {
    it('returns true when track has valid candidate bindings', () => {
      const provider = createLxUserProvider()
      const track = createTrack([{ provider: 'chksz', externalId: '123456' }])
      expect(provider.canResolve!(track)).toBe(true)
    })

    it('returns false when track has no valid candidate bindings', () => {
      const provider = createLxUserProvider()
      const track = createTrack([{ provider: 'jellyfin', externalId: 'jf-456' }])
      expect(provider.canResolve!(track)).toBe(false)
    })
  })

  describe('resolve', () => {
    it('returns null immediately if signal is aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      const provider = createLxUserProvider()
      const track = createTrack([{ provider: 'chksz', externalId: '123' }])
      const result = await provider.resolve(track, controller.signal)
      expect(result).toBeNull()
    })

    it('returns null if track has no candidates', async () => {
      const provider = createLxUserProvider()
      const track = createTrack([])
      const result = await provider.resolve(track, new AbortController().signal)
      expect(result).toBeNull()
    })

    it('returns null if repository has no enabled sources', async () => {
      const repo = createMockRepository([
        createMockSource('s1', 'Disabled Source', 10, false),
      ])
      const provider = createLxUserProvider({ sourceRepository: repo })
      const track = createTrack([{ provider: 'chksz', externalId: '123' }])
      const result = await provider.resolve(track, new AbortController().signal)
      expect(result).toBeNull()
    })

    it('executes sources in priority order and stops on first success', async () => {
      const source1 = createMockSource('s1', 'Source 1', 10, true)
      const source2 = createMockSource('s2', 'Source 2', 20, true)
      const repo = createMockRepository([source2, source1]) // Out of order in list

      const loadSource = vi.fn().mockImplementation(async (script: string) => {
        if (script.includes('Source 1')) {
          return { initedMeta: { sources: { wy: { qualitys: ['128k'] } } } }
        }
        return {}
      })

      const callMusicUrl = vi.fn().mockImplementation(async () => {
        return { url: 'https://media.example.com/audio.mp3' }
      })

      const dispose = vi.fn().mockResolvedValue(undefined)

      const mockClient: Partial<LxRuntimeClient> = {
        loadSource,
        callMusicUrl,
        dispose: dispose as any,
      }

      const provider = createLxUserProvider({
        sourceRepository: repo,
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
        qualityStore: { lxQuality: () => 'standard' },
      })

      const track = createTrack([{ provider: 'chksz', externalId: '123456' }])
      const result = await provider.resolve(track, new AbortController().signal)

      expect(result).toEqual({
        kind: 'audio',
        url: 'https://media.example.com/audio.mp3',
        mimeType: 'audio/mpeg',
      })

      // Loaded Source 1 first
      expect(loadSource).toHaveBeenCalledWith(source1.script)
      // Did NOT load Source 2 because Source 1 succeeded
      expect(loadSource).not.toHaveBeenCalledWith(source2.script)
      expect(dispose).toHaveBeenCalled()
    })

    it('passes MeloX-compatible musicInfo to callMusicUrl', async () => {
      const source = createMockSource('s1', 'Source 1', 10, true)
      const repo = createMockRepository([source])

      let capturedSongInfo: any = null
      let capturedQuality: string | null = null

      const mockClient: Partial<LxRuntimeClient> = {
        loadSource: vi.fn().mockResolvedValue({ initedMeta: undefined }),
        callMusicUrl: vi.fn().mockImplementation(async (_source, songInfo, quality) => {
          capturedSongInfo = songInfo
          capturedQuality = quality
          return { url: 'https://media.example.com/track.flac' }
        }),
        dispose: vi.fn().mockResolvedValue(undefined) as any,
      }

      const provider = createLxUserProvider({
        sourceRepository: repo,
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
        qualityStore: { lxQuality: () => 'lossless' },
      })

      const track = createTrack(
        [{ provider: 'lx-ikun', externalId: 'wy:song99:flac' }],
        { title: 'Golden Hall' } as any,
      )
      // add extra artist and album fields
      ;(track as any).artist = 'Yu-Peng Chen'
      ;(track as any).album = 'The Shimmering Voyage'

      const result = await provider.resolve(track, new AbortController().signal)

      expect(result).toEqual({
        kind: 'audio',
        url: 'https://media.example.com/track.flac',
        mimeType: 'audio/flac',
      })

      expect(capturedQuality).toBe('flac')
      expect(capturedSongInfo).toMatchObject({
        id: 'song99',
        songId: 'song99',
        songmid: 'song99',
        mid: 'song99',
        hash: 'song99',
        name: 'Golden Hall',
        title: 'Golden Hall',
        singer: 'Yu-Peng Chen',
        artist: 'Yu-Peng Chen',
        album: 'The Shimmering Voyage',
        source: 'wy',
        quality: 'flac',
      })
      // The MeloX self-reference is attached inside the guest by __lxDispatchMusicUrl, never on
      // the host-side payload. A cyclic object survives structured clone (which also drops the
      // non-enumerable toJSON escape hatch), and the worker's JSON size guard then rejects the
      // request outright — which would fail every musicUrl call for every source.
      expect(capturedSongInfo.musicInfo).toBeUndefined()
      expect(() => JSON.stringify(capturedSongInfo)).not.toThrow()
    })

    it('uses HOYO-MiX as default artist if track artist is missing', async () => {
      const source = createMockSource('s1', 'Source 1', 10, true)
      const repo = createMockRepository([source])

      let capturedSongInfo: any = null

      const mockClient: Partial<LxRuntimeClient> = {
        loadSource: vi.fn().mockResolvedValue({ initedMeta: undefined }),
        callMusicUrl: vi.fn().mockImplementation(async (_source, songInfo) => {
          capturedSongInfo = songInfo
          return { url: 'https://media.example.com/track.mp3' }
        }),
        dispose: vi.fn().mockResolvedValue(undefined) as any,
      }

      const provider = createLxUserProvider({
        sourceRepository: repo,
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
      })

      const track = createTrack([{ provider: 'chksz', externalId: '123' }])
      await provider.resolve(track, new AbortController().signal)

      expect(capturedSongInfo.singer).toBe('HOYO-MiX')
      expect(capturedSongInfo.artist).toBe('HOYO-MiX')
    })

    it('respects declared qualities from initedMeta and avoids requesting undeclared higher tier', async () => {
      const source = createMockSource('s1', 'Source 1', 10, true)
      const repo = createMockRepository([source])

      const requestedQualities: string[] = []

      const mockClient: Partial<LxRuntimeClient> = {
        loadSource: vi.fn().mockResolvedValue({
          initedMeta: {
            sources: {
              wy: { qualitys: ['128k', '320k'] }, // no 'flac' or 'flac24bit'
            },
          },
        }),
        callMusicUrl: vi.fn().mockImplementation(async (_source, _songInfo, quality) => {
          requestedQualities.push(quality)
          return { url: 'https://media.example.com/audio.mp3' }
        }),
        dispose: vi.fn().mockResolvedValue(undefined) as any,
      }

      const provider = createLxUserProvider({
        sourceRepository: repo,
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
        qualityStore: { lxQuality: () => 'hires' }, // user requested hires
      })

      const track = createTrack([{ provider: 'chksz', externalId: '123' }])
      await provider.resolve(track, new AbortController().signal)

      // Since source declared ['128k', '320k'], 'flac24bit' and 'flac' should NOT be requested
      expect(requestedQualities).toEqual(['320k'])
    })

    it('degrades within source through fallback chain when higher tier fails', async () => {
      const source = createMockSource('s1', 'Source 1', 10, true)
      const repo = createMockRepository([source])

      const requestedQualities: string[] = []

      const mockClient: Partial<LxRuntimeClient> = {
        loadSource: vi.fn().mockResolvedValue({
          initedMeta: {
            sources: {
              wy: { qualitys: ['128k', '320k', 'flac'] },
            },
          },
        }),
        callMusicUrl: vi.fn().mockImplementation(async (_source, _songInfo, quality) => {
          requestedQualities.push(quality)
          if (quality === 'flac') {
            return { url: undefined } // flac unavailable
          }
          if (quality === '320k') {
            return { url: 'https://media.example.com/audio_320k.mp3' }
          }
          return { url: undefined }
        }),
        dispose: vi.fn().mockResolvedValue(undefined) as any,
      }

      const provider = createLxUserProvider({
        sourceRepository: repo,
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
        qualityStore: { lxQuality: () => 'lossless' }, // ['flac', '320k', '128k']
      })

      const track = createTrack([{ provider: 'chksz', externalId: '123' }])
      const result = await provider.resolve(track, new AbortController().signal)

      expect(requestedQualities).toEqual(['flac', '320k'])
      expect(result).toEqual({
        kind: 'audio',
        url: 'https://media.example.com/audio_320k.mp3',
        mimeType: 'audio/mpeg',
      })
    })

    it('rejects media URLs that return non-empty requestHeaders and continues chain', async () => {
      const source1 = createMockSource('s1', 'Headers Required Source', 10, true)
      const source2 = createMockSource('s2', 'Clean URL Source', 20, true)
      const repo = createMockRepository([source1, source2])

      const attempts: ProviderAttempt[] = []

      const mockClient: Partial<LxRuntimeClient> = {
        loadSource: vi.fn().mockResolvedValue({ initedMeta: undefined }),
        callMusicUrl: vi.fn().mockImplementation(async (source, _songInfo, _quality) => {
          if (source1.script.includes('Headers Required')) {
            // Returns headers that <audio> cannot send
            return {
              url: 'https://protected.example.com/audio.mp3',
              requestHeaders: { 'User-Agent': 'CustomClient/1.0', Authorization: 'Bearer secret' },
            }
          }
          return {
            url: 'https://clean.example.com/audio.mp3',
          }
        }),
        dispose: vi.fn().mockResolvedValue(undefined) as any,
      }

      // Create separate clients or switch mock behavior per source load
      let currentScript = ''
      mockClient.loadSource = vi.fn().mockImplementation(async (script: string) => {
        currentScript = script
        return { initedMeta: undefined }
      })
      mockClient.callMusicUrl = vi.fn().mockImplementation(async () => {
        if (currentScript.includes('Headers Required')) {
          return {
            url: 'https://protected.example.com/audio.mp3',
            requestHeaders: { 'User-Agent': 'CustomClient/1.0', Authorization: 'Bearer secret' },
          }
        }
        return {
          url: 'https://clean.example.com/audio.mp3',
        }
      })

      const provider = createLxUserProvider({
        sourceRepository: repo,
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
        onSubAttempt: (attempt) => attempts.push(attempt),
      })

      const track = createTrack([{ provider: 'chksz', externalId: '123' }])
      const result = await provider.resolve(track, new AbortController().signal)

      // Protected URL must NOT be returned
      expect(result).toEqual({
        kind: 'audio',
        url: 'https://clean.example.com/audio.mp3',
        mimeType: 'audio/mpeg',
      })

      // Diagnostics check
      const rejectedAttempt = attempts.find((a) => a.sourceId === 's1')
      expect(rejectedAttempt).toMatchObject({
        providerId: 'lx',
        sourceId: 's1',
        sourceName: 'Headers Required Source',
        ok: false,
        code: 'invalid_response',
      })
      // Ensure no secrets leaked in attempt object
      expect(JSON.stringify(rejectedAttempt)).not.toContain('secret')
      expect(JSON.stringify(rejectedAttempt)).not.toContain('script')

      const successAttempt = attempts.find((a) => a.sourceId === 's2')
      expect(successAttempt).toMatchObject({
        providerId: 'lx',
        sourceId: 's2',
        sourceName: 'Clean URL Source',
        ok: true,
      })
    })

    it('maps the sandbox invalid_response refusal (M-11) to invalid_response and continues chain', async () => {
      const source1 = createMockSource('s1', 'Refused Source', 10, true)
      const source2 = createMockSource('s2', 'Clean URL Source', 20, true)
      const attempts: ProviderAttempt[] = []
      let currentScript = ''
      const mockClient: Partial<LxRuntimeClient> = {
        loadSource: vi.fn().mockImplementation(async (script: string) => {
          currentScript = script
          return { initedMeta: undefined }
        }),
        callMusicUrl: vi.fn().mockImplementation(async () => {
          if (currentScript.includes('Refused')) {
            throw new Error('invalid_response: plaintext http: media URL is not playable')
          }
          return { url: 'https://clean.example.com/audio.mp3' }
        }),
        dispose: vi.fn().mockResolvedValue(undefined) as any,
      }
      const provider = createLxUserProvider({
        sourceRepository: createMockRepository([source1, source2]),
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
        onSubAttempt: (attempt) => attempts.push(attempt),
      })

      const result = await provider.resolve(createTrack([{ provider: 'chksz', externalId: '123' }]), new AbortController().signal)

      expect(result).toMatchObject({ kind: 'audio', url: 'https://clean.example.com/audio.mp3' })
      expect(attempts.map((a) => [a.sourceId, a.code ?? 'ok'])).toEqual([['s1', 'invalid_response'], ['s2', 'ok']])
    })

    it('falls back to next source when loadSource or callMusicUrl fails', async () => {
      const source1 = createMockSource('s1', 'Broken Source', 10, true)
      const source2 = createMockSource('s2', 'Working Source', 20, true)
      const repo = createMockRepository([source1, source2])

      let currentScript = ''
      const mockClient: Partial<LxRuntimeClient> = {
        loadSource: vi.fn().mockImplementation(async (script: string) => {
          currentScript = script
          if (script.includes('Broken Source')) {
            throw new Error('Script syntax error')
          }
          return { initedMeta: undefined }
        }),
        callMusicUrl: vi.fn().mockImplementation(async () => {
          return { url: 'https://clean.example.com/audio.mp3' }
        }),
        dispose: vi.fn().mockResolvedValue(undefined) as any,
      }

      const attempts: ProviderAttempt[] = []
      const provider = createLxUserProvider({
        sourceRepository: repo,
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
        onSubAttempt: (attempt) => attempts.push(attempt),
      })

      const track = createTrack([{ provider: 'chksz', externalId: '123' }])
      const result = await provider.resolve(track, new AbortController().signal)

      expect(result).toEqual({
        kind: 'audio',
        url: 'https://clean.example.com/audio.mp3',
        mimeType: 'audio/mpeg',
      })

      expect(attempts).toEqual([
        expect.objectContaining({
          providerId: 'lx',
          sourceId: 's1',
          ok: false,
          code: 'unavailable',
        }),
        expect.objectContaining({
          providerId: 'lx',
          sourceId: 's2',
          ok: true,
        }),
      ])
    })

    it('returns null when all sources fail', async () => {
      const source1 = createMockSource('s1', 'Broken Source 1', 10, true)
      const source2 = createMockSource('s2', 'Broken Source 2', 20, true)
      const repo = createMockRepository([source1, source2])

      const mockClient: Partial<LxRuntimeClient> = {
        loadSource: vi.fn().mockResolvedValue({ initedMeta: undefined }),
        callMusicUrl: vi.fn().mockImplementation(async () => {
          throw new Error('LX call timed out after 4000ms')
        }),
        dispose: vi.fn().mockResolvedValue(undefined) as any,
      }

      const attempts: ProviderAttempt[] = []
      const provider = createLxUserProvider({
        sourceRepository: repo,
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
        onSubAttempt: (attempt) => attempts.push(attempt),
      })

      const track = createTrack([{ provider: 'chksz', externalId: '123' }])
      const result = await provider.resolve(track, new AbortController().signal)

      expect(result).toBeNull()
      expect(attempts).toHaveLength(2)
      expect(attempts[0]).toMatchObject({
        providerId: 'lx',
        sourceId: 's1',
        ok: false,
        code: 'timeout',
      })
      expect(attempts[1]).toMatchObject({
        providerId: 'lx',
        sourceId: 's2',
        ok: false,
        code: 'timeout',
      })
    })
  })

  describe('network-level lx.request failures (task 41.7)', () => {
    const attemptsFor = async (errors: string[]): Promise<ProviderAttempt[]> => {
      let call = 0
      const mockClient: Partial<LxRuntimeClient> = {
        loadSource: vi.fn().mockResolvedValue({ initedMeta: undefined }),
        callMusicUrl: vi.fn().mockImplementation(async () => {
          throw new Error(errors[Math.min(call++, errors.length - 1)])
        }),
        dispose: vi.fn().mockResolvedValue(undefined) as any,
      }
      const attempts: ProviderAttempt[] = []
      const provider = createLxUserProvider({
        sourceRepository: createMockRepository([createMockSource('s1', 'Only Source', 10, true)]),
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
        qualityStore: { lxQuality: () => 'high' },
        onSubAttempt: (attempt) => attempts.push(attempt),
      })
      expect(await provider.resolve(createTrack([{ provider: 'chksz', externalId: '123' }]), new AbortController().signal)).toBeNull()
      return attempts
    }

    it('marks a network_error refusal as a transient unavailable sub-source attempt', async () => {
      const attempts = await attemptsFor(['LX musicUrl rejected: network_error: Failed to fetch'])
      expect(attempts).toEqual([expect.objectContaining({ sourceId: 's1', ok: false, code: 'unavailable', transient: true })])
    })

    it('maps the sandbox request timeout to timeout without the transient marker', async () => {
      const attempts = await attemptsFor(['LX musicUrl rejected: HTTP request timed out after 4000ms'])
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ code: 'timeout' })
      expect(attempts[0].transient).toBeUndefined()
    })

    it('keeps a generic script failure permanent', async () => {
      const attempts = await attemptsFor(['LX musicUrl rejected: song not found'])
      expect(attempts[0]).toMatchObject({ code: 'unavailable' })
      expect(attempts[0].transient).toBeUndefined()
    })

    it('keeps an earlier csp_blocked sticky over a later network_error', async () => {
      const attempts = await attemptsFor([
        'LX musicUrl rejected: csp_blocked: https://x.example is not permitted',
        'LX musicUrl rejected: network_error: Failed to fetch',
      ])
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ code: 'csp_blocked' })
      expect(attempts[0].transient).toBeUndefined()
    })
  })

  /**
   * The deployment's CSP allows `media-src` only from `'self'`, the R2 origin and
   * `https://*.music.126.net`. Every bundled/candidate LX source currently resolves to plaintext
   * `http:` media, which the media element refuses before any bytes are fetched. These cases pin
   * the refusal to this boundary so the failure is reported truthfully and the loop moves on,
   * instead of surfacing as an opaque `unavailable` after the browser has already blocked it.
   */
  describe('media transport policy', () => {
    const resolveWith = async (
      urls: (string | undefined)[],
      extra: { mediaProbe?: (url: string) => Promise<boolean>; cspSources?: { connect: readonly string[]; media: readonly string[] } } = {},
    ) => {
      const sources = urls.map((_url, index) =>
        createMockSource(`s${index + 1}`, `Source ${index + 1}`, (index + 1) * 10, true),
      )
      const repo = createMockRepository(sources)
      let call = 0
      const mockClient: Partial<LxRuntimeClient> = {
        loadSource: vi.fn().mockResolvedValue({ initedMeta: undefined }),
        callMusicUrl: vi.fn().mockImplementation(async () => ({ url: urls[call++] })),
        dispose: vi.fn().mockResolvedValue(undefined) as any,
      }
      const attempts: ProviderAttempt[] = []
      const provider = createLxUserProvider({
        sourceRepository: repo,
        runtimeClientFactory: () => mockClient as LxRuntimeClient,
        qualityStore: { lxQuality: () => 'standard' },
        onSubAttempt: (attempt) => attempts.push(attempt),
        mediaProbe: extra.mediaProbe ?? (async () => true),
        ...(extra.cspSources ? { cspSources: extra.cspSources } : {}),
      })
      const track = createTrack([{ provider: 'chksz', externalId: '123' }])
      const result = await provider.resolve(track, new AbortController().signal)
      return { result, attempts }
    }

    it('still resolves HTTPS media (control group)', async () => {
      const { result, attempts } = await resolveWith(['https://secure.example.com/a.mp3'])
      expect(result).toEqual({
        kind: 'audio',
        url: 'https://secure.example.com/a.mp3',
        mimeType: 'audio/mpeg',
      })
      expect(attempts).toEqual([
        expect.objectContaining({ providerId: 'lx', sourceId: 's1', ok: true }),
      ])
    })

    it('reports a plaintext URL on a non-promotable host as media_insecure', async () => {
      const { result, attempts } = await resolveWith(['http://insecure.example.com/a.mp3'])
      expect(result).toBeNull()
      expect(attempts).toEqual([
        expect.objectContaining({ providerId: 'lx', sourceId: 's1', ok: false, code: 'media_insecure' }),
      ])
    })

    it('keeps trying later sources after an http-only source', async () => {
      const { result, attempts } = await resolveWith([
        'http://insecure.example.com/a.mp3',
        'https://secure.example.com/b.mp3',
      ])
      expect(result).toEqual({
        kind: 'audio',
        url: 'https://secure.example.com/b.mp3',
        mimeType: 'audio/mpeg',
      })
      expect(attempts).toEqual([
        expect.objectContaining({ providerId: 'lx', sourceId: 's1', ok: false, code: 'media_insecure' }),
        expect.objectContaining({ providerId: 'lx', sourceId: 's2', ok: true }),
      ])
    })

    it('promotes plaintext media on a trusted host to HTTPS once the probe confirms it plays', async () => {
      const probed: string[] = []
      const { result, attempts } = await resolveWith(
        ['http://m801.music.126.net/2026/signed/song.mp3?authSecret=abc&x=1'],
        {
          cspSources: { connect: [], media: ['https://*.music.126.net'] },
          mediaProbe: async (url) => {
            probed.push(url)
            return true
          },
        },
      )
      expect(probed).toEqual(['https://m801.music.126.net/2026/signed/song.mp3?authSecret=abc&x=1'])
      expect(result).toEqual({
        kind: 'audio',
        url: 'https://m801.music.126.net/2026/signed/song.mp3?authSecret=abc&x=1',
        mimeType: 'audio/mpeg',
      })
      expect(attempts).toEqual([
        expect.objectContaining({ providerId: 'lx', sourceId: 's1', ok: true }),
      ])
    })

    it('falls through to the next source when the promoted URL does not load', async () => {
      const { result, attempts } = await resolveWith(
        [
          'http://m801.music.126.net/dead/song.mp3',
          'https://secure.example.com/b.mp3',
        ],
        {
          cspSources: { connect: [], media: ['https://*.music.126.net', 'https://*.example.com'] },
          mediaProbe: async (url) => url === 'https://secure.example.com/b.mp3',
        },
      )
      expect(result).toEqual({
        kind: 'audio',
        url: 'https://secure.example.com/b.mp3',
        mimeType: 'audio/mpeg',
      })
      expect(attempts).toEqual([
        expect.objectContaining({ providerId: 'lx', sourceId: 's1', ok: false, code: 'media_insecure' }),
        expect.objectContaining({ providerId: 'lx', sourceId: 's2', ok: true }),
      ])
    })

    it('never promotes a host outside the trusted media family', async () => {
      const probed: string[] = []
      const { result } = await resolveWith(
        ['http://music.126.net.attacker.example/a.mp3', 'http://m801.music.126.net.evil.example/b.mp3'],
        {
          cspSources: { connect: [], media: ['https://*.music.126.net'] },
          mediaProbe: async (url) => {
            probed.push(url)
            return true
          },
        },
      )
      expect(result).toBeNull()
      expect(probed).toEqual([])
    })

    it('refuses non-http(s) schemes as well', async () => {
      const { result, attempts } = await resolveWith(['data:audio/mpeg;base64,AAAA'])
      expect(result).toBeNull()
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ providerId: 'lx', sourceId: 's1', ok: false })
    })

    it('never silently accepts http by widening the accepted set', async () => {
      // Every source yields http on a host that cannot be promoted: the aggregate outcome must be a
      // truthful failure, and each source must carry the precise code rather than a generic
      // 'unavailable'. Promotion is never a licence to play plaintext.
      const { result, attempts } = await resolveWith([
        'http://insecure.example.com/a.mp3',
        'http://insecure.example.com/b.mp3',
      ])
      expect(result).toBeNull()
      expect(attempts).toHaveLength(2)
      for (const attempt of attempts) {
        expect(attempt).toMatchObject({ ok: false, code: 'media_insecure' })
      }
    })
  })
})

it('does not execute custom LX scripts after withdrawal', async () => {
  localStorage.setItem('study-with-hoyomix:third-party-agreement:v1', 'withdrawn')
  const runtimeClientFactory = vi.fn()
  const provider = createLxUserProvider({ sourceRepository: createMockRepository([createMockSource('custom-1', 'Custom', 1)]), runtimeClientFactory })
  try {
    await expect(provider.resolve(createTrack([{ provider: 'chksz', externalId: '123456' }]), new AbortController().signal)).resolves.toBeNull()
    expect(runtimeClientFactory).not.toHaveBeenCalled()
  } finally { localStorage.clear() }
})

// The published global registry is a third input to the same chain. These cases exist because the
// feature's real risk is not the registry itself but the chain: an empty registry must leave the
// personal sources exactly as they were, and a populated one must not silently shadow a user's own
// decision.
describe('mergeLxSourceChain', () => {
  it('returns the personal chain unchanged when nothing is published', () => {
    const personal = [
      createMockSource('builtin-a', 'Built-in A', 10),
      createMockSource('user-b', 'User B', 20),
      createMockSource('builtin-c', 'Built-in C', 30),
    ]
    const merged = mergeLxSourceChain(personal, [])
    expect(merged.map((source) => source.id)).toEqual(['builtin-a', 'builtin-c', 'user-b'])
  })

  it('places a published source after the built-ins and before the user imports', () => {
    const personal = [createMockSource('builtin-a', 'Built-in A', 10), createMockSource('user-b', 'User B', 20)]
    const published = [{ ...createMockSource('global:c', 'Published C', 15), builtIn: false }]
    const merged = mergeLxSourceChain(personal, published)
    expect(merged.map((source) => source.id)).toEqual(['builtin-a', 'global:c', 'user-b'])
  })

  it('runs a script once even when the same digest is both imported and published', () => {
    const personal = [createMockSource('user-b', 'User B', 20)]
    const published = [{ ...personal[0]!, id: 'global:b' }]
    const merged = mergeLxSourceChain(personal, published)
    expect(merged).toHaveLength(1)
    // The published copy comes first in the chain, so it is the one that runs — same bytes either way.
    expect(merged[0]?.id).toBe('global:b')
  })

  it('lets a user disabling their own copy suppress the published copy of the same script', () => {
    const personal = [createMockSource('user-b', 'User B', 20, false)]
    const published = [{ ...personal[0]!, id: 'global:b', enabled: true }]
    expect(mergeLxSourceChain(personal, published)).toEqual([])
  })

  it('keeps a disabled published source out of the enabled set without touching the chain', () => {
    const published = [{ ...createMockSource('global:c', 'Published C', 15), enabled: false }]
    const merged = mergeLxSourceChain([], published)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.enabled).toBe(false)
  })

  it('orders published sources by their own priority', () => {
    const published = [
      { ...createMockSource('global:z', 'Z', 90), builtIn: false },
      { ...createMockSource('global:a', 'A', 5), builtIn: false },
    ]
    expect(mergeLxSourceChain([], published).map((source) => source.id)).toEqual(['global:a', 'global:z'])
  })
})

// The provider is where the registry actually has to work. An empty registry is the state every
// deployment starts in, so it must cost nothing but a cached request and must not change the result;
// a populated one must be used exactly like a personal source.
describe('createLxUserProvider with a global registry', () => {
  const globalRepository = (records: LxSourceRecord[] | (() => never)): LxGlobalSourceRepository => ({
    list: typeof records === 'function' ? records : async () => records,
    revision: () => 1,
    pendingApproval: () => [],
    invalidate: () => undefined,
  })

  const runtimeClient = (url: string) => {
    const loadSource = vi.fn().mockResolvedValue({ initedMeta: { sources: { wy: { qualitys: ['128k'] } } } })
    const callMusicUrl = vi.fn().mockResolvedValue({ url })
    return {
      client: { loadSource, callMusicUrl, dispose: vi.fn().mockResolvedValue(undefined) } as unknown as LxRuntimeClient,
      loadSource,
      callMusicUrl,
    }
  }

  it('resolves through the personal chain when the registry publishes nothing', async () => {
    const repo = createMockRepository([createMockSource('s1', 'Source 1', 10, true)])
    const { client, callMusicUrl } = runtimeClient('https://media.example.com/a.mp3')
    const provider = createLxUserProvider({
      sourceRepository: repo,
      globalSourceRepository: globalRepository([]),
      runtimeClientFactory: () => client,
      qualityStore: { lxQuality: () => 'standard' },
    })
    const result = await provider.resolve(createTrack([{ provider: 'chksz', externalId: '123456' }]), new AbortController().signal)
    expect(result).not.toBeNull()
    expect(callMusicUrl).toHaveBeenCalledTimes(1)
  })

  it('uses a published source when the user has none', async () => {
    const published: LxSourceRecord = {
      ...createMockSource('global:g1', 'Published', 5, true),
      builtIn: false,
    }
    const { client, callMusicUrl } = runtimeClient('https://media.example.com/b.mp3')
    const provider = createLxUserProvider({
      sourceRepository: createMockRepository([]),
      globalSourceRepository: globalRepository([published]),
      runtimeClientFactory: () => client,
      qualityStore: { lxQuality: () => 'standard' },
    })
    const result = await provider.resolve(createTrack([{ provider: 'chksz', externalId: '123456' }]), new AbortController().signal)
    expect(result).not.toBeNull()
    expect(callMusicUrl).toHaveBeenCalledTimes(1)
  })

  it('treats an unreachable registry as empty rather than failing the resolve', async () => {
    const repo = createMockRepository([createMockSource('s1', 'Source 1', 10, true)])
    const { client, callMusicUrl } = runtimeClient('https://media.example.com/c.mp3')
    const provider = createLxUserProvider({
      sourceRepository: repo,
      // The real repository swallows its own network errors and returns []; this is the harsher case,
      // where the failure escapes, to prove the provider does not depend on that detail.
      globalSourceRepository: globalRepository((() => {
        throw new Error('registry unavailable')
      }) as () => never),
      runtimeClientFactory: () => client,
      qualityStore: { lxQuality: () => 'standard' },
    })
    const result = await provider.resolve(createTrack([{ provider: 'chksz', externalId: '123456' }]), new AbortController().signal)
    // A broken registry must not take playback down with it.
    expect(result).not.toBeNull()
    expect(callMusicUrl).toHaveBeenCalledTimes(1)
  })
})

describe('aborted LX runtime lifecycle', () => {
  it.each(['load', 'musicUrl'] as const)(
    'immediately aborts the runtime while %s is pending and refuses stale success',
    async (stage) => {
      const controller = new AbortController()
      const source = createMockSource('builtin-test', 'Published test', 10)
      let finish!: (value: unknown) => void
      const pending = new Promise<unknown>((resolve) => { finish = resolve })
      const loadSource = vi.fn(() => stage === 'load' ? pending : Promise.resolve({}))
      const callMusicUrl = vi.fn(() => pending)
      const abort = vi.fn()
      const dispose = vi.fn().mockResolvedValue(undefined)
      const onSubAttempt = vi.fn()
      const provider = createLxUserProvider({
        sourceRepository: createMockRepository([source]),
        runtimeClientFactory: () => ({ loadSource, callMusicUrl, abort, dispose }) as unknown as LxRuntimeClient,
        onSubAttempt,
        qualityStore: { lxQuality: () => 'standard' },
      })
      const task = provider.resolve(createTrack([{ provider: 'chksz', externalId: '123456' }]), controller.signal)
      try {
        await vi.waitFor(() => expect(stage === 'load' ? loadSource : callMusicUrl).toHaveBeenCalled())
        controller.abort()
        expect(abort).toHaveBeenCalledTimes(1)
      } finally {
        finish(stage === 'load' ? {} : { url: 'https://media.example.com/stale.mp3' })
        await task
      }
      expect(await task).toBeNull()
      expect(onSubAttempt).not.toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
      expect(dispose).toHaveBeenCalledTimes(1)
    },
  )
})

describe('administrator-published source authority', () => {
  it.each(['disabled', 'registry unavailable'] as const)(
    'never restores the release-provided Kulao when %s',
    async (state) => {
      const factory = vi.fn(() => ({
        loadSource: vi.fn().mockResolvedValue({}),
        callMusicUrl: vi.fn().mockResolvedValue({ url: 'https://media.example.com/bypass.mp3' }),
        dispose: vi.fn().mockResolvedValue(undefined),
      }) as unknown as LxRuntimeClient)
      const globalSourceRepository: LxGlobalSourceRepository = {
        managesBundledSource: true,
        list: state === 'disabled' ? vi.fn().mockResolvedValue([]) : vi.fn().mockRejectedValue(new Error('offline')),
        revision: () => 2,
        pendingApproval: () => [],
        invalidate: () => {},
      }
      const provider = createLxUserProvider({
        sourceRepository: createMockRepository([createMockSource('builtin-kulao-svip', 'Kulao', 10)]),
        globalSourceRepository,
        runtimeClientFactory: factory,
        qualityStore: { lxQuality: () => 'standard' },
      })
      const signal = new AbortController().signal
      expect(await provider.resolve(createTrack([{ provider: 'chksz', externalId: '123456' }]), signal)).toBeNull()
      expect(factory).not.toHaveBeenCalled()
    },
  )
})
