import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import {
  clearArtworkCache,
  fetchChkszArtwork,
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
    const value = placeholderArtwork('demo-zzz-study')
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
  it('accepts existing same-origin LX and GD artwork routes for canonical NetEase bindings',()=>{
    expect(isValidArtworkUrl('/api/providers/lx/artwork/9000000002')).toBe(true)
    expect(isValidArtworkUrl('/api/providers/gd-studio/artwork/9000000002')).toBe(true)
    expect(isValidArtworkUrl('https://evil.example/api/providers/lx/artwork/9000000002')).toBe(false)
    expect(isValidArtworkUrl('/api/providers/lx/artwork/9000000002?url=https://evil.example')).toBe(false)
    expect(isValidArtworkUrl('/api/providers/lx/artwork/not-a-number')).toBe(false)
    expect(isValidArtworkUrl('/api/providers/lx/artwork/123456789012345678901')).toBe(false)
  })
  it('accepts safe relative provider artwork URLs', () => {
    expect(
      isValidArtworkUrl('/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg'),
    ).toBe(true)
    expect(
      isValidArtworkUrl('/api/providers/jellyfin/artwork/6213b704a0d954293110f4d561b0f614'),
    ).toBe(false)
  })

  it('rejects external or unapproved endpoints', () => {
    expect(isValidArtworkUrl('https://malicious.site/image.png')).toBe(false)
    expect(isValidArtworkUrl('javascript:alert(1)')).toBe(false)
    expect(isValidArtworkUrl('')).toBe(false)
    expect(isValidArtworkUrl('   ')).toBe(false)
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

  it('skips retired Jellyfin artwork and preserves the LX to GD cover fallback', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const track = { ...trackWithJellyfin, sources: [
      { provider: 'jellyfin', externalId: 'retired-item' },
      { provider: 'chksz', externalId: '9000000002' },
    ] }
    const artwork = useArtwork('album:retired-jellyfin', track)
    expect(artwork.artworkUrl.value).toBe('/api/providers/lx/artwork/9000000002')
    artwork.onError()
    expect(artwork.artworkUrl.value).toBe('/api/providers/gd-studio/artwork/9000000002')
    artwork.onLoad()
    expect(artwork.isLoaded.value).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses a placeholder for a Jellyfin-only historical binding without resolving audio', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const artwork = useArtwork('album:retired-only', {
      ...trackWithJellyfin,
      sources: [{ provider: 'jellyfin', externalId: 'retired-item' }],
    })
    expect(artwork.artworkUrl.value).toBeUndefined()
    expect(artwork.hasFailed.value).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses key-free artwork routes despite a historical Jellyfin binding without resolving audio',()=>{
    const fetchSpy=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(null,{status:503}))
    const track={...trackWithJellyfin,sources:[{provider:'jellyfin',externalId:'jf-item-123'},{provider:'chksz',externalId:'9000000002'}]}
    const art=useArtwork('album:canonical',track)
    expect(art.artworkUrl.value).toBe('/api/providers/lx/artwork/9000000002')
    art.onError()
    expect(art.artworkUrl.value).toBe('/api/providers/gd-studio/artwork/9000000002')
    art.onLoad()
    expect(art.isLoaded.value).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    const cached=useArtwork('album:canonical',track)
    expect(cached.artworkUrl.value).toBe('/api/providers/gd-studio/artwork/9000000002')
  })

  it('resolves canonical NetEase and standalone GD bindings without an Owner ChKSz key',()=>{
    const fetchSpy=vi.spyOn(globalThis,'fetch')
    const netease=useArtwork('album:netease',{...trackWithChkszOnly,sources:[{provider:'chksz',externalId:'9000000002'}]})
    const gd=useArtwork('album:gd',{...trackWithChkszOnly,sources:[{provider:'gd-studio',externalId:'netease:9000000002:999'}]})
    expect(netease.artworkUrl.value).toBe('/api/providers/lx/artwork/9000000002')
    expect(gd.artworkUrl.value).toBe('/api/providers/gd-studio/artwork/9000000002')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('evicts a failed cached GD image before trying the remaining legacy fallback',async()=>{
    const url='/api/providers/chksz/artwork?url=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg'
    const fetchSpy=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({metadata:{artworkUrl:url}}))
    const track={...trackWithChkszOnly,sources:[{provider:'chksz',externalId:'9000000002'}]}
    const first=useArtwork('album:cached-gd',track)
    first.onError()
    first.onLoad()
    const cached=useArtwork('album:cached-gd',track)
    expect(cached.artworkUrl.value).toBe('/api/providers/gd-studio/artwork/9000000002')
    cached.onError()
    await new Promise(resolve=>setTimeout(resolve,10))
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(cached.artworkUrl.value).toBe(url)
  })

  it('resolves a legacy ChKSz binding without requesting retired Jellyfin artwork', async () => {
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

    const { artworkUrl, hasFailed, onLoad, isLoaded } = useArtwork(
      'album:Album One',
      trackWithJellyfin,
    )

    expect(artworkUrl.value).toBeUndefined()

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

  it('marks failed when the remaining legacy ChKSz artwork fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'unavailable' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const { artworkUrl, hasFailed } = useArtwork('album:Album One', trackWithJellyfin)
    expect(artworkUrl.value).toBeUndefined()

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
