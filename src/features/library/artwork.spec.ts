import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { effectScope, type EffectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { artworkBlob, mockValidatedArtwork } from '../../test/artworkLeaseFixture'
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
  it('accepts existing same-origin LX and GD artwork routes for canonical NetEase bindings',()=>{
    expect(isValidArtworkUrl('/api/providers/lx/artwork/2155423468')).toBe(true)
    expect(isValidArtworkUrl('/api/providers/gd-studio/artwork/2155423468')).toBe(true)
    expect(isValidArtworkUrl('https://evil.example/api/providers/lx/artwork/2155423468')).toBe(false)
    expect(isValidArtworkUrl('/api/providers/lx/artwork/2155423468?url=https://evil.example')).toBe(false)
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
  let cache: ReturnType<typeof mockValidatedArtwork>
  const scopes: EffectScope[] = []
  const artwork = (...args: Parameters<typeof useArtwork>) => {
    const scope = effectScope(); scopes.push(scope)
    return scope.run(() => useArtwork(...args))!
  }
  beforeEach(() => { clearArtworkCache(); vi.restoreAllMocks(); cache = mockValidatedArtwork() })
  afterEach(async () => {
    for (const scope of scopes.splice(0)) scope.stop()
    await flushPromises(); clearArtworkCache(); vi.restoreAllMocks()
  })
  const legacy = '/api/providers/chksz/artwork?url=' + encodeURIComponent('https://p1.music.126.net/cover.jpg')
  const lx = '/api/providers/lx/artwork/2155423468', gd = '/api/providers/gd-studio/artwork/2155423468'
  const canonical = { ...trackWithJellyfin, sources: [
    { provider: 'jellyfin', externalId: 'retired-item' }, { provider: 'chksz', externalId: '2155423468' },
  ] }

  it('skips retired Jellyfin artwork and preserves the LX to GD cover fallback', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const art = artwork('album:retired-jellyfin', canonical)
    await flushPromises(); expect(art.artworkUrl.value).toBe(artworkBlob(lx))
    art.onError(); await flushPromises()
    expect(cache.invalidate).toHaveBeenCalledWith(lx)
    expect(art.artworkUrl.value).toBe(artworkBlob(gd)); expect(art.sourceUrl.value).toBe(gd)
    expect(art.isLoaded.value).toBe(true); expect(fetchSpy).not.toHaveBeenCalled()
    expect(cache.acquire.mock.calls.every(([url]) => !url.includes('jellyfin'))).toBe(true)
  })

  it('uses a placeholder for a Jellyfin-only historical binding without resolving audio', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const art = artwork('album:retired-only', { ...trackWithJellyfin, sources: [{ provider: 'jellyfin', externalId: 'retired-item' }] })
    expect(art.artworkUrl.value).toBeUndefined(); expect(art.hasFailed.value).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled(); expect(cache.acquire).not.toHaveBeenCalled()
  })

  it('uses key-free artwork routes despite a historical Jellyfin binding without resolving audio', async () => {
    cache.rejected.add(lx)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const art = artwork('album:canonical', canonical); await flushPromises()
    expect(art.artworkUrl.value).toBe(artworkBlob(gd)); expect(art.isLoaded.value).toBe(true)
    const cached = artwork('album:canonical', canonical); await flushPromises()
    expect(cached.artworkUrl.value).toBe(art.artworkUrl.value); expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('resolves canonical NetEase and standalone GD bindings without an Owner ChKSz key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const netease = artwork('album:netease', { ...trackWithChkszOnly, sources: [{ provider: 'chksz', externalId: '2155423468' }] })
    const studio = artwork('album:gd', { ...trackWithChkszOnly, sources: [{ provider: 'gd-studio', externalId: 'netease:2155423468:999' }] })
    await flushPromises()
    expect(netease.artworkUrl.value).toBe(artworkBlob(lx)); expect(studio.artworkUrl.value).toBe(artworkBlob(gd))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('evicts a failed cached GD image before trying the remaining legacy fallback', async () => {
    cache.rejected.add(lx)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ metadata: { artworkUrl: legacy } }))
    const first = artwork('album:cached-gd', canonical); await flushPromises()
    expect(first.artworkUrl.value).toBe(artworkBlob(gd))
    first.onError(); await flushPromises()
    expect(cache.invalidate).toHaveBeenCalledWith(gd)
    expect(fetchSpy).toHaveBeenCalledOnce(); expect(first.artworkUrl.value).toBe(artworkBlob(legacy))
  })

  it('resolves a legacy ChKSz binding without requesting retired Jellyfin artwork', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ metadata: { artworkUrl: legacy } }))
    const art = artwork('album:Album One', trackWithJellyfin)
    expect(art.artworkUrl.value).toBeUndefined(); await flushPromises()
    expect(fetchSpy).toHaveBeenCalledWith('/api/providers/chksz/resolve', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ externalId: 'chksz-123', level: 'standard' }),
    }))
    expect(art.artworkUrl.value).toBe(artworkBlob(legacy)); expect(art.sourceUrl.value).toBe(legacy)
    expect(art.hasFailed.value).toBe(false); expect(art.isLoaded.value).toBe(true)
  })

  it('marks failed when the remaining legacy ChKSz artwork fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 502 }))
    const art = artwork('album:Album One', trackWithJellyfin); await flushPromises()
    expect(art.hasFailed.value).toBe(true); expect(art.artworkUrl.value).toBeUndefined()
  })

  it('resolves ChKSz immediately when track has no Jellyfin source', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ metadata: { artworkUrl: legacy } }))
    const art = artwork('album:Album Two', trackWithChkszOnly)
    expect(art.artworkUrl.value).toBeUndefined(); await flushPromises()
    expect(art.artworkUrl.value).toBe(artworkBlob(legacy)); expect(art.hasFailed.value).toBe(false)
  })

  it('marks failed immediately with zero network requests when track has no supported artwork sources', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const art = artwork('track:track-3', trackWithNoArtworkSources)
    expect(art.artworkUrl.value).toBeUndefined(); expect(art.hasFailed.value).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled(); expect(cache.acquire).not.toHaveBeenCalled()
  })

  it('memoises and shares artwork at album level', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ metadata: { artworkUrl: legacy } }))
    const album: AlbumEntry = { id: 'hsr:Album Two', title: 'Album Two', game: 'hsr', trackIds: ['track-2'],
      trackCount: 1, representativeTrack: trackWithChkszOnly }
    const scope = effectScope(); scopes.push(scope)
    const card = scope.run(() => useAlbumArtwork(album))!; await flushPromises()
    expect(card.artworkUrl.value).toBe(artworkBlob(legacy))
    const row = artwork('album:hsr:Album Two', trackWithChkszOnly); await flushPromises()
    expect(row.artworkUrl.value).toBe(card.artworkUrl.value); expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent in-flight ChKSz resolves for the same key', async () => {
    let finish!: (value: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(resolve => { finish = resolve }))
    const first = resolveChkszArtwork('album:Shared', 'chksz-123'), second = resolveChkszArtwork('album:Shared', 'chksz-123')
    await Promise.resolve(); expect(fetchSpy).toHaveBeenCalledOnce()
    finish(Response.json({ metadata: { artworkUrl: legacy } }))
    expect(await first).toBe(legacy); expect(await second).toBe(legacy)
  })

  it('uses validated acquisition without Image.decode and rejects arbitrary external candidates', async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode')
    Reflect.deleteProperty(HTMLImageElement.prototype, 'decode')
    try {
      const art = artwork('without-decode', canonical); await flushPromises()
      expect(art.artworkUrl.value).toBe(artworkBlob(lx)); expect(art.isLoaded.value).toBe(true)
      const calls = cache.acquire.mock.calls.length
      const rejected = artwork('external', trackWithNoArtworkSources, { candidates: ['https://evil.invalid/image.png'] })
      await flushPromises(); expect(rejected.artworkUrl.value).toBeUndefined(); expect(rejected.hasFailed.value).toBe(true)
      expect(cache.acquire).toHaveBeenCalledTimes(calls)
    } finally { if (original) Object.defineProperty(HTMLImageElement.prototype, 'decode', original) }
  })
})
