import { describe, expect, it, vi } from 'vitest'
import type { Track } from '../../catalog/types'
import type { LxSourceRecord, LxSourceRepository } from '../lx/types'
import type { LxRuntimeClient } from '../lx/runtime/client'
import type { ProviderAttempt } from './types'
import { createLxUserProvider } from './lxUser'

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

  /**
   * The deployment's CSP allows `media-src` only from `'self'`, the R2 origin and
   * `https://*.music.126.net`. Every bundled/candidate LX source currently resolves to plaintext
   * `http:` media, which the media element refuses before any bytes are fetched. These cases pin
   * the refusal to this boundary so the failure is reported truthfully and the loop moves on,
   * instead of surfacing as an opaque `unavailable` after the browser has already blocked it.
   */
  describe('media transport policy', () => {
    const resolveWith = async (urls: (string | undefined)[]) => {
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

    it('refuses plaintext http media and reports the source as invalid_response', async () => {
      const { result, attempts } = await resolveWith(['http://insecure.example.com/a.mp3'])
      expect(result).toBeNull()
      expect(attempts).toEqual([
        expect.objectContaining({ providerId: 'lx', sourceId: 's1', ok: false, code: 'invalid_response' }),
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
        expect.objectContaining({ providerId: 'lx', sourceId: 's1', ok: false, code: 'invalid_response' }),
        expect.objectContaining({ providerId: 'lx', sourceId: 's2', ok: true }),
      ])
    })

    it('refuses non-http(s) schemes as well', async () => {
      const { result, attempts } = await resolveWith(['data:audio/mpeg;base64,AAAA'])
      expect(result).toBeNull()
      expect(attempts).toHaveLength(1)
      expect(attempts[0]).toMatchObject({ providerId: 'lx', sourceId: 's1', ok: false })
    })

    it('never silently accepts http by widening the accepted set', async () => {
      // Every source yields http: the aggregate outcome must be a truthful failure, and each
      // source must carry the precise code rather than a generic 'unavailable'.
      const { result, attempts } = await resolveWith([
        'http://insecure.example.com/a.mp3',
        'http://insecure.example.com/b.mp3',
      ])
      expect(result).toBeNull()
      expect(attempts).toHaveLength(2)
      for (const attempt of attempts) {
        expect(attempt).toMatchObject({ ok: false, code: 'invalid_response' })
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
