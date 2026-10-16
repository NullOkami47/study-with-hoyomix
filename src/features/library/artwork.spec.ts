import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import {
  clearArtworkCache,
  fetchChkszArtwork,
  getJellyfinArtworkUrl,
  isValidArtworkUrl,
  placeholderArtwork,
  resolveChkszArtwork,
  useAlbumArtwork,
  useArtwork,
} from './artwork'
import type { AlbumEntry } from './catalogueIndex'

const trackWithJellyfin: Track = {
  id: 'track-1',
  title: 'Track One',
  aliases: {},
  games: ['genshin'],
  relationIds: [],
  tabs: ['focus'],
  workGroupId: 'wg-1',
  needsClassification: false,
  vocalStatus: 'instrumental',
  sources: [
    { provider: 'jellyfin', externalId: 'jf-item-123' },
    { provider: 'chksz', externalId: 'chksz-123' },
  ],
  album: 'Album One',
}

const trackWithChkszOnly: Track = {
  id: 'track-2',
  title: 'Track Two',
  aliases: {},
  games: ['hsr'],
  relationIds: [],
  tabs: ['chill'],
  workGroupId: 'wg-2',
  needsClassification: false,
  vocalStatus: 'vocal',
  sources: [{ provider: 'chksz', externalId: 'chksz-456' }],
  album: 'Album Two',
}

const trackWithNoArtworkSources: Track = {
  id: 'track-3',
  title: 'Track Three',
  aliases: {},
  games: ['zzz'],
  relationIds: [],
  tabs: ['sleep'],
  workGroupId: 'wg-3',
  needsClassification: false,
  vocalStatus: 'instrumental',
  sources: [{ provider: 'youtube', externalId: 'yt-789' }],
}

describe('placeholderArtwork', () => {
  it('is deterministic for the same seed', () => {
    expect(placeholderArtwork('genshin:Fountain of Belleau')).toBe(
      placeholderArtwork('genshin:Fountain of Belleau'),
    )
  })

  it('differs between identities', () => {
    expect(placeholderArtwork('genshin:album-a')).not.toBe(placeholderArtwork('genshin:album-b'))
    expect(placeholderArtwork('genshin:album-a')).not.toBe(placeholderArtwork('hsr:album-a'))
  })

  it('returns a usable CSS background rather than a bare colour', () => {
    const value = placeholderArtwork('zzz-tiny-giant')
    expect(value).toMatch(/^linear-gradient\(/)
    expect(value).toMatch(/hsl\(/)
  })

  it('handles an empty seed', () => {
    expect(placeholderArtwork('')).toMatch(/^linear-gradient\(/)
  })

  it('stays inside the hue circle for every seed', () => {
    for (const seed of ['a', 'b', 'album:x', '极限委托', 'INSIDE - EP']) {
      const hues = [...placeholderArtwork(seed).matchAll(/hsl\((\d+)/g)].map((match) =>
        Number(match[1]),
      )
      expect(hues).toHaveLength(2)
      for (const hue of hues) {
        expect(hue).toBeGreaterThanOrEqual(0)
        expect(hue).toBeLessThan(360)
      }
    }
  })
})

describe('isValidArtworkUrl', () => {
  it('accepts safe relative provider artwork URLs', () => {
    expect(
      isValidArtworkUrl('/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg'),
    ).toBe(true)
    expect(
      isValidArtworkUrl('/api/providers/jellyfin/artwork/6213b704a0d954293110f4d561b0f614'),
    ).toBe(true)
  })

  it('rejects external or unapproved endpoints', () => {
    expect(isValidArtworkUrl('https://malicious.site/image.png')).toBe(false)
    expect(isValidArtworkUrl('javascript:alert(1)')).toBe(false)
    expect(isValidArtworkUrl('')).toBe(false)
    expect(isValidArtworkUrl('   ')).toBe(false)
  })
})

describe('getJellyfinArtworkUrl', () => {
  it('constructs correct encoded URL for Jellyfin item artwork', () => {
    expect(getJellyfinArtworkUrl('item/123')).toBe('/api/providers/jellyfin/artwork/item%2F123')
  })
})

describe('Artwork resolution & useArtwork composable', () => {
  beforeEach(() => {
    clearArtworkCache()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    clearArtworkCache()
    vi.restoreAllMocks()
  })

  it('starts with Jellyfin candidate when track has Jellyfin source', () => {
    const { artworkUrl, isLoaded, hasFailed, onLoad } = useArtwork('album:Album One', trackWithJellyfin)

    expect(artworkUrl.value).toBe('/api/providers/jellyfin/artwork/jf-item-123')
    expect(isLoaded.value).toBe(false)
    expect(hasFailed.value).toBe(false)

    // Simulating successful image load
    onLoad()
    expect(isLoaded.value).toBe(true)
    expect(hasFailed.value).toBe(false)
  })

  it('falls back to ChKSz when Jellyfin candidate errors', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          metadata: {
            artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const { artworkUrl, hasFailed, onError, onLoad, isLoaded } = useArtwork(
      'album:Album One',
      trackWithJellyfin,
    )

    expect(artworkUrl.value).toBe('/api/providers/jellyfin/artwork/jf-item-123')

    // Simulate Jellyfin image load error (e.g. 404 from upstream Jellyfin item)
    onError()

    // Wait for async ChKSz resolve
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/providers/chksz/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ externalId: 'chksz-123', level: 'standard' }),
      }),
    )

    expect(artworkUrl.value).toBe(
      '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg',
    )
    expect(hasFailed.value).toBe(false)

    // Simulate successful ChKSz image load
    onLoad()
    expect(isLoaded.value).toBe(true)
  })

  it('marks failed and cleans up if both Jellyfin and ChKSz fail', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unavailable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const { artworkUrl, hasFailed, onError } = useArtwork('album:Album One', trackWithJellyfin)
    expect(artworkUrl.value).toBe('/api/providers/jellyfin/artwork/jf-item-123')

    // Trigger error on Jellyfin
    onError()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(hasFailed.value).toBe(true)
    expect(artworkUrl.value).toBeUndefined()
  })

  it('resolves ChKSz immediately when track has no Jellyfin source', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          metadata: {
            artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Ftrack2.jpg',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const { artworkUrl, hasFailed } = useArtwork('album:Album Two', trackWithChkszOnly)

    // While resolving
    expect(artworkUrl.value).toBeUndefined()

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(artworkUrl.value).toBe(
      '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Ftrack2.jpg',
    )
    expect(hasFailed.value).toBe(false)
  })

  it('marks failed immediately with zero network requests when track has no supported artwork sources', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const { artworkUrl, hasFailed } = useArtwork('track:track-3', trackWithNoArtworkSources)

    expect(artworkUrl.value).toBeUndefined()
    expect(hasFailed.value).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('memoises and shares artwork at album level', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          metadata: {
            artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fshared.jpg',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    // Album card resolves first
    const album: AlbumEntry = {
      id: 'hsr:Album Two',
      title: 'Album Two',
      game: 'hsr',
      trackIds: ['track-2'],
      trackCount: 1,
      representativeTrack: trackWithChkszOnly,
    }

    const cardArtwork = useAlbumArtwork(album)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(cardArtwork.artworkUrl.value).toBe(
      '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fshared.jpg',
    )
    cardArtwork.onLoad()

    // TrackRow in the same album opens later
    const rowArtwork = useArtwork('album:Album Two', trackWithChkszOnly)

    // It immediately reads from cache without any additional network call
    expect(rowArtwork.artworkUrl.value).toBe(
      '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fshared.jpg',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent in-flight ChKSz resolves for the same key', async () => {
    let resolveNetwork!: (value: Response) => void
    const networkPromise = new Promise<Response>((r) => {
      resolveNetwork = r
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(networkPromise)

    const p1 = resolveChkszArtwork('album:Shared', 'chksz-123')
    const p2 = resolveChkszArtwork('album:Shared', 'chksz-123')

    expect(fetchSpy).toHaveBeenCalledTimes(1)

    resolveNetwork(
      new Response(
        JSON.stringify({
          metadata: {
            artworkUrl: '/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fdedup.jpg',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe('/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fdedup.jpg')
    expect(r2).toBe(r1)
  })
})
