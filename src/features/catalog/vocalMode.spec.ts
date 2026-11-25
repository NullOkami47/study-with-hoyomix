import { describe, expect, it } from 'vitest'

import { CATALOG_FILTER_STORAGE_KEY_V1 as V1, CATALOG_FILTER_STORAGE_KEY_V2 as V2, createCatalogFilterState } from './filterState'
import type { GameId, Track } from './types'

const tracks: Track[] = [
  { id: 'g', title: 'Shared song', aliases: { 'zh-Hant': ['晨星'] }, games: ['genshin'], tabs: ['focus'], relationIds: ['event:shared'], vocalStatus: 'vocal' },
  { id: 'h', title: 'Shared anthem', aliases: { en: ['Dawn'] }, games: ['hsr'], tabs: [], relationIds: ['event:shared'], vocalStatus: 'vocal' },
  { id: 'z', title: 'Night song', aliases: {}, games: ['zzz'], tabs: ['sleep'], relationIds: [], vocalStatus: 'vocal' },
  { id: 'u', title: 'Shared uncertain', aliases: {}, games: ['hsr'], tabs: ['focus'], relationIds: ['event:shared'], vocalStatus: 'uncertain' },
  { id: 'i', title: 'Shared instrumental', aliases: {}, games: ['genshin'], tabs: ['focus'], relationIds: ['event:shared'], vocalStatus: 'instrumental' },
].map(track => ({ ...track, workGroupId: track.id, needsClassification: false, sources: [{ provider: 'lx', externalId: track.id }] })) as Track[]

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
}

describe('Vocal preference compatibility and intersections', () => {
  it.each([[], ['focus'], ['chat'], ['sleep', 'focus']].map(tabs => ({ tabs })))('migrates v1 tabs $tabs and persists a subsequent Vocal selection across reload', ({ tabs }) => {
    const saved = storage()
    const legacy = { search: 'Shared', games: [], tabs, relationIds: ['event:shared'], workGroupIds: [], classification: 'all' }
    saved.setItem(V1, JSON.stringify(legacy))
    const state = createCatalogFilterState(tracks, saved)
    expect(state.mode.value).toBe(tabs.length === 1 ? tabs[0] === 'chat' ? 'chill' : tabs[0] : null)
    state.setMode('vocal')
    const restored = createCatalogFilterState(tracks, saved)
    expect(restored.mode.value).toBe('vocal')
    expect(restored.games.value).toEqual(['genshin', 'hsr', 'zzz'])
    expect(restored.search.value).toBe('Shared')
    expect(restored.relationIds.value).toEqual(['event:shared'])
    expect(restored.filteredTracks.value.map(track => track.id)).toEqual(['g', 'h'])
    expect(JSON.parse(saved.getItem(V2)!)).toEqual({ search: 'Shared', games: ['genshin', 'hsr', 'zzz'], mode: 'vocal', relationIds: ['event:shared'] })
    expect(JSON.parse(saved.getItem(V1)!)).toEqual(legacy)
  })

  it('keeps saved Vocal preferences authoritative over stale v1 preferences', () => {
    const saved = storage()
    saved.setItem(V1, JSON.stringify({ search: '', games: [], tabs: ['focus'], relationIds: [], workGroupIds: [], classification: 'all' }))
    saved.setItem(V2, JSON.stringify({ search: 'Dawn', games: ['hsr'], mode: 'vocal', relationIds: [] }))
    const state = createCatalogFilterState(tracks, saved)
    expect(state.filteredTracks.value.map(track => track.id)).toEqual(['h'])
    expect(state.mode.value).toBe('vocal')
  })

  it('restores a saved vocal relation once the published catalogue arrives, preserving an empty search result', () => {
    const saved = storage()
    saved.setItem(V2, JSON.stringify({ search: 'missing', games: ['hsr'], mode: 'vocal', relationIds: ['event:published'] }))
    const state = createCatalogFilterState(tracks, saved)
    const published = { ...tracks[1], relationIds: ['event:published'] }
    state.replaceTracks([published])
    expect(state.mode.value).toBe('vocal')
    expect(state.relationIds.value).toEqual(['event:published'])
    expect(state.filteredTracks.value).toEqual([])
    state.setSearch('Dawn')
    expect(state.filteredTracks.value.map(track => track.id)).toEqual(['h'])
  })

  it('agrees with an independent oracle for every nonempty game subset, search and relation combination', () => {
    const games: GameId[] = ['genshin', 'hsr', 'zzz']
    let checked = 0
    for (let mask = 1; mask < 8; mask++) {
      const selected = games.filter((_, index) => mask & (1 << index))
      for (const search of ['', 'Shared', 'Dawn', '晨星', 'missing']) {
        for (const relation of [false, true]) {
          const state = createCatalogFilterState(tracks, storage())
          state.setMode('vocal')
          games.filter(game => !selected.includes(game)).forEach(game => state.toggleGame(game))
          state.setSearch(search)
          if (relation) state.toggleRelation('event:shared')
          const expected = tracks.filter(track => track.vocalStatus === 'vocal'
            && track.games.some(game => selected.includes(game))
            && (!relation || track.relationIds.includes('event:shared'))
            && [track.title, ...Object.values(track.aliases).flat()].some(name => name.toLowerCase().includes(search.toLowerCase())))
          expect(state.filteredTracks.value.map(track => track.id)).toEqual(expected.map(track => track.id))
          checked++
        }
      }
    }
    expect(checked).toBe(70)
    expect(tracks.map(track => track.tabs)).toEqual([['focus'], [], ['sleep'], ['focus'], ['focus']])
  })
})
