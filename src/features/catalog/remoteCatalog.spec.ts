import { describe, it, expect, vi } from 'vitest'
import { loadRemoteCatalog } from './remoteCatalog'
import { createCatalogFilterState } from './filterState'
import { parseCatalog } from './schema'
import { nextTick } from 'vue'
import type { Track } from './types'

// Test data stays separate from the intentionally empty public production catalogue.
const seed: Track[] = (['genshin', 'hsr', 'zzz'] as const).map((game, index) => ({
  id: `fixture-${game}`,
  title: index === 0 ? 'Tiny test one' : `Test ${index + 1}`,
  aliases: {},
  games: [game],
  relationIds: index === 0 ? ['place:fixture-one'] : [],
  tabs: ['focus'],
  workGroupId: `fixture-group-${index}`,
  needsClassification: false,
  vocalStatus: 'instrumental',
  sources: [{ provider: 'lx', externalId: `fixture-stale-${index}` }],
}))

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

  it('replaces stale mappings with published GD and LX sources without changing track identity', async () => {
    const staleTracks = parseCatalog(seed)
    const original = JSON.stringify(staleTracks)
    const remoteTracksPayload = seed.map((track, index) => ({
      ...track,
      sources: [
        { provider: 'gd-studio', externalId: `fixture-gd-${index}`, metadata: { quality: 'standard' } },
        { provider: 'lx', externalId: `fixture-lx-${index}`, metadata: {} },
      ],
    }))
    const fetcher = vi.fn(async () => Response.json({ revision: '3', tracks: remoteTracksPayload }))
    const loaded = await loadRemoteCatalog(fetcher)

    expect(loaded.revision).toBe('3')
    expect(loaded.tracks).toHaveLength(3)
    expect(loaded.tracks).toEqual(remoteTracksPayload)
    for (const [index, track] of loaded.tracks.entries()) {
      expect({ ...track, sources: staleTracks[index].sources }).toEqual(staleTracks[index])
      expect(track.sources.map((source) => source.provider)).toEqual(['gd-studio', 'lx'])
      expect(track.sources.map((source) => source.externalId)).not.toContain(
        staleTracks[index].sources[0].externalId,
      )
    }

    const state = createCatalogFilterState(staleTracks, {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    })
    state.replaceTracks(loaded.tracks)
    await nextTick()

    expect(state.filteredTracks.value).toEqual(loaded.tracks)
    expect(JSON.stringify(staleTracks)).toBe(original)
  })

  it('fails closed when catalogue fetch returns non-200, allowing caller to handle explicitly rather than silently pretending stale data is current', async () => {
    const fetcher = vi.fn(async () => new Response('Internal Server Error', { status: 500 }))
    await expect(loadRemoteCatalog(fetcher)).rejects.toThrow('catalogue_unavailable')
  })
})
