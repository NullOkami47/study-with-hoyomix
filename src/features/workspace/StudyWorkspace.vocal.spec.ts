import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { usePreferences } from '../../stores/preferences'
import { CATALOG_FILTER_STORAGE_KEY_V2, type CatalogFilterState } from '../catalog/filterState'
import type { Track } from '../catalog/types'
import { ProviderRegistry } from '../player/providers/registry'
import type { PlaybackStore } from '../player/store'
import type { RuntimeProviderRepository } from '../player/runtimeConfig'
import FocusBar from './FocusBar.vue'
import StudyWorkspace from './StudyWorkspace.vue'

const fixtures = vi.hoisted(() => ({
  tracks: [] as Track[],
  remote: vi.fn(async (): Promise<{ revision: string; tracks: Track[] }> => { throw new Error('catalogue_unavailable') }),
}))
vi.mock('../catalog/runtimeCatalog', () => ({ runtimeCatalog: () => ({ mode: 'production', tracks: fixtures.tracks }) }))
vi.mock('../catalog/remoteCatalog', () => ({ loadRemoteCatalog: fixtures.remote }))
vi.mock('../player/runtimeConfig', async () => {
  const actual = await vi.importActual<typeof import('../player/runtimeConfig')>('../player/runtimeConfig')
  return { ...actual, createRuntimeProviderRepository: (): RuntimeProviderRepository => {
    const registry = new ProviderRegistry([{ provider: { id: 'lx', resolve: async (track: Track) => ({
      kind: 'audio', url: `https://media.invalid/${track.id}.mp3`, mimeType: 'audio/mpeg',
    }) }, enabled: true, priority: 1, timeoutMs: 1000 }])
    let snapshot: ProviderRegistry | undefined
    const load = async () => { snapshot = registry; return registry }
    return {
      prefetch: async () => {}, load, peek: () => snapshot,
      loadPlayback: load, peekPlayback: () => snapshot, states: async () => [],
      subscribeStates: () => () => {},
    }
  } }
})

const tracks: Track[] = [
  { id: 'old-bgm', title: 'BGM', games: ['hsr'], tabs: ['focus'], vocalStatus: 'instrumental' },
  { id: 'song-a', title: 'Song A', games: ['genshin'], tabs: ['sleep'], vocalStatus: 'vocal' },
  { id: 'song-b', title: 'Song B', games: ['hsr'], tabs: [], vocalStatus: 'vocal' },
  { id: 'unknown', title: 'Song Unknown', games: ['zzz'], tabs: [], vocalStatus: 'uncertain' },
  { id: 'song-c', title: 'Song C', games: ['zzz'], tabs: ['focus'], vocalStatus: 'vocal' },
].map(track => ({ ...track, aliases: {}, relationIds: [], workGroupId: track.id, needsClassification: false,
  sources: [{ provider: 'lx', externalId: track.id }],
})) as Track[]
const ids = (player: PlaybackStore) => player.queue.value.map(track => track.id)

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('hoyomix-player-shuffle-v1', 'false')
  usePreferences().setLocale('en')
  fixtures.tracks = tracks
  fixtures.remote.mockReset().mockRejectedValue(new Error('catalogue_unavailable'))
})

function setup() {
  const wrapper = mount(StudyWorkspace, { global: { stubs: {
    SceneBackdrop: true, NoticeCentre: true, ControlCentre: true,
    PlayerBar: { name: 'PlayerBar', props: ['store'], template: '<div />' },
  } } })
  const player = wrapper.getComponent({ name: 'PlayerBar' }).props('store') as PlaybackStore
  const state = wrapper.getComponent(FocusBar).props('state') as CatalogFilterState
  return { wrapper, player, state }
}

describe('Workspace Vocal queue wiring', () => {
  it('preserves active playback on entering Vocal, then uses only vocal upcoming tracks', async () => {
    const { wrapper, player } = setup()
    await player.playQueueIndex(0)
    player.reportMediaState('playing', player.playbackGeneration.value)
    expect(player.playable.value).toMatchObject({ kind: 'audio', url: 'https://media.invalid/old-bgm.mp3' })
    expect(player.status.value).toBe('playing')
    const active = { track: player.currentTrack.value, playable: player.playable.value, generation: player.playbackGeneration.value, session: player.listeningSessionId.value }
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-filter-tab="vocal"]').trigger('click')
    expect(ids(player)).toEqual(['old-bgm', 'song-a', 'song-b', 'song-c'])
    expect(player.currentTrack.value).toBe(active.track)
    expect(player.playable.value).toBe(active.playable)
    expect(player.playbackGeneration.value).toBe(active.generation)
    expect(player.listeningSessionId.value).toBe(active.session)
    expect(player.playbackIntent.value).toBe('playing')
    expect(player.status.value).toBe('playing')
    await player.next()
    expect(player.currentTrack.value?.id).toBe('song-a')
    await player.next()
    expect(player.currentTrack.value?.id).toBe('song-b')
    await player.previous()
    expect(player.currentTrack.value?.id).toBe('song-a')
    wrapper.unmount()
  })

  it('keeps search out of the queue and preserves manual exclusions until a structural filter changes', async () => {
    const { wrapper, player, state } = setup()
    state.setMode('vocal')
    await nextTick()
    player.removeQueueIndex(1)
    expect(ids(player)).toEqual(['song-a', 'song-c'])
    state.setSearch('missing')
    await nextTick()
    expect(state.filteredTracks.value).toEqual([])
    expect(ids(player)).toEqual(['song-a', 'song-c'])
    state.setSearch('Song A')
    await nextTick()
    expect(state.filteredTracks.value.map(track => track.id)).toEqual(['song-a'])
    expect(ids(player)).toEqual(['song-a', 'song-c'])
    state.toggleGame('genshin')
    await nextTick()
    expect(ids(player)).toEqual(['song-c', 'song-b'])
    state.setMode(null)
    await nextTick()
    expect(ids(player)).toEqual(['song-c', 'song-b', 'old-bgm', 'unknown'])
    wrapper.unmount()
  })

  it('restores saved Vocal mode before queue creation and refreshes only upcoming published matches', async () => {
    localStorage.setItem(CATALOG_FILTER_STORAGE_KEY_V2, JSON.stringify({ search: 'missing', games: ['hsr'], mode: 'vocal', relationIds: [] }))
    let publish!: (value: { revision: string; tracks: Track[] }) => void
    fixtures.remote.mockImplementationOnce(() => new Promise(resolve => { publish = resolve }))
    const { wrapper, player, state } = setup()
    expect(ids(player)).toEqual(['song-b'])
    expect(player.playbackGeneration.value).toBe(0)
    await player.next()
    const active = player.currentTrack.value
    const generation = player.playbackGeneration.value
    const added = { ...tracks[2], id: 'new-vocal' }
    publish({ revision: '2', tracks: [...tracks.map(track => track.id === 'song-b' ? { ...track, vocalStatus: 'uncertain' as const } : track), added] })
    await flushPromises()
    expect(wrapper.attributes('data-catalogue-status')).toBe('published')
    expect(state.mode.value).toBe('vocal')
    expect(state.filteredTracks.value).toEqual([])
    expect(player.currentTrack.value).toBe(active)
    expect(player.playbackGeneration.value).toBe(generation)
    expect(ids(player)).toEqual(['song-b', 'new-vocal'])
    wrapper.unmount()
  })
})
