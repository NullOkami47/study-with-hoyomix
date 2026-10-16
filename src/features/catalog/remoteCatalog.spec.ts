import { describe, it, expect, vi } from 'vitest'
import type { Track } from './types'

// Original metadata-only fixture, independent of the public empty catalogue.
const seed: Track[] = ['one', 'two', 'three'].map((id, index): Track => ({
  id: `synthetic-${id}`, title: `Tiny synthetic ${id}`, aliases: {},
  games: [(['genshin', 'hsr', 'zzz'] as const)[index]], relationIds: [],
  tabs: ['focus'], workGroupId: `synthetic-work-${id}`,
  needsClassification: false, vocalStatus: 'instrumental',
  sources: [{ provider: 'r2', externalId: `synthetic/${id}.ogg` }],
}))
import { loadRemoteCatalog } from './remoteCatalog'
import { createCatalogFilterState } from './filterState'
import { parseCatalog } from './schema'
import { nextTick } from 'vue'
describe('published remote catalogue', () => {
  it('fetches only the same-origin endpoint and strictly parses the payload', async () => {
    const fetcher = vi.fn(async () => Response.json({ revision: '1', tracks: seed }))
    expect(await loadRemoteCatalog(fetcher)).toEqual({ revision: '1', tracks: seed })
    expect(fetcher).toHaveBeenCalledWith(
      '/api/catalogue',
      expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }),
    )
  })
  it.each([
    { revision: '1', tracks: [] },
    { revision: '1', tracks: seed, secret: 'no' },
    // An unknown tab id is still rejected. (`tabs` and `vocalStatus` are independent, so a
    // `focus` track with a non-instrumental vocal status is valid and no longer a rejection case.)
    { revision: '1', tracks: [{ ...seed[0], tabs: ['study'] }] },
    // An unknown vocalStatus is still rejected, even when the track also carries `focus`.
    { revision: '1', tracks: [{ ...seed[0], vocalStatus: 'invalid', tabs: ['focus'] }] },
    { tracks: seed },
    null,
  ])('rejects malformed or unsafe data: %j', async (payload) => {
    await expect(loadRemoteCatalog(async () => Response.json(payload))).rejects.toThrow(
      'catalogue_unavailable',
    )
  })
  it('rejects failed and oversized responses without reflecting private errors', async () => {
    await expect(
      loadRemoteCatalog(async () => new Response('secret', { status: 503 })),
    ).rejects.toThrow('catalogue_unavailable')
    await expect(
      loadRemoteCatalog(
        async () =>
          new Response('{}', {
            headers: { 'content-type': 'application/json', 'content-length': '99999999' },
          }),
      ),
    ).rejects.toThrow('catalogue_unavailable')
  })
  it('replaces query data/options but preserves valid filters and exact source mappings', async () => {
    const tracks = parseCatalog(seed)
    const state = createCatalogFilterState(tracks, {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
    state.setSearch('Tiny')
    const replacement = [
      { ...tracks[0], relationIds: ['place:new'], title: 'Tiny revised' },
    ]
    const old = JSON.stringify(tracks)
    state.replaceTracks(replacement)
    await nextTick()
    expect(state.search.value).toBe('Tiny')
    expect(state.filteredTracks.value).toEqual(replacement)
    // The replacement catalogue introduces the relation, which becomes selectable and
    // filtering against the fresh option set rather than the stale one.
    state.toggleRelation('place:new')
    expect(state.relationIds.value).toEqual(['place:new'])
    expect(state.filteredTracks.value).toEqual(replacement)
    expect(JSON.stringify(tracks)).toBe(old)
    expect(state.filteredTracks.value[0].sources).toEqual(tracks[0].sources)
  })

  it('loads Jellyfin sources from /api/catalogue and ensures they supersede stale R2-only data in player', async () => {
    const staleStaticTracks = parseCatalog(seed)
    // Verify stale static fixture only has r2
    expect(staleStaticTracks.every((t) => t.sources.every((s) => s.provider === 'r2'))).toBe(true)

    // Remote D1 catalogue response with Jellyfin primary and ChKSz fallback
    const remoteTracksPayload = [
      {
        ...seed[0],
        sources: [
          {
            provider: 'jellyfin',
            externalId: '11111111111111111111111111111111',
            metadata: { contentType: 'audio/mpeg', rightsStatus: 'not-reviewed' },
          },
          { provider: 'chksz', externalId: '101', metadata: {} },
        ],
      },
      {
        ...seed[1],
        sources: [
          {
            provider: 'jellyfin',
            externalId: '22222222222222222222222222222222',
            metadata: { contentType: 'audio/mpeg', rightsStatus: 'not-reviewed' },
          },
          { provider: 'chksz', externalId: '102', metadata: {} },
        ],
      },
      {
        ...seed[2],
        sources: [
          {
            provider: 'jellyfin',
            externalId: '33333333333333333333333333333333',
            metadata: { contentType: 'audio/mpeg', rightsStatus: 'not-reviewed' },
          },
          { provider: 'chksz', externalId: '103', metadata: {} },
        ],
      },
    ]

    const fetcher = vi.fn(async () => Response.json({ revision: '3', tracks: remoteTracksPayload }))
    const loaded = await loadRemoteCatalog(fetcher)

    expect(loaded.revision).toBe('3')
    expect(loaded.tracks).toHaveLength(3)
    // Preserves existing track metadata
    expect(loaded.tracks.map((t) => t.id)).toEqual(staleStaticTracks.map((t) => t.id))
    expect(loaded.tracks.map((t) => t.title)).toEqual(staleStaticTracks.map((t) => t.title))
    expect(loaded.tracks.map((t) => t.games)).toEqual(staleStaticTracks.map((t) => t.games))
    expect(loaded.tracks.map((t) => t.workGroupId)).toEqual(staleStaticTracks.map((t) => t.workGroupId))

    // Jellyfin sources are present and R2 is absent
    for (const track of loaded.tracks) {
      const providers = track.sources.map((s) => s.provider)
      expect(providers).toContain('jellyfin')
      expect(providers).toContain('chksz')
      expect(providers).not.toContain('r2')
    }

    // Now verify filter state replacement
    const state = createCatalogFilterState(staleStaticTracks)
    state.replaceTracks(loaded.tracks)
    await nextTick()

    // The active tracks in filter state are now the remote tracks with Jellyfin
    const activeFirstTrack = state.filteredTracks.value[0]
    expect(activeFirstTrack.sources.some((s) => s.provider === 'jellyfin')).toBe(true)
    expect(activeFirstTrack.sources.some((s) => s.provider === 'r2')).toBe(false)
  })

  it('fails closed when catalogue fetch returns non-200, allowing caller to handle explicitly rather than silently pretending stale data is current', async () => {
    const fetcher = vi.fn(async () => new Response('Internal Server Error', { status: 500 }))
    await expect(loadRemoteCatalog(fetcher)).rejects.toThrow('catalogue_unavailable')
  })
})
