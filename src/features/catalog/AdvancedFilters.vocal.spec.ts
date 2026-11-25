import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { usePreferences } from '../../stores/preferences'
import AdvancedFilters from './AdvancedFilters.vue'
import { createCatalogFilterState } from './filterState'
import type { Track } from './types'

const tracks: Track[] = [
  { id: 'song-a', title: 'Song A', games: ['hsr'], relationIds: ['event:a'], vocalStatus: 'vocal' },
  { id: 'song-b', title: 'Song B', games: ['zzz'], relationIds: ['event:b'], vocalStatus: 'vocal' },
  { id: 'bgm', title: 'BGM', games: ['hsr'], relationIds: ['event:empty'], vocalStatus: 'uncertain' },
].map(track => ({ ...track, aliases: {}, tabs: [], workGroupId: track.id, needsClassification: false, sources: [{ provider: 'lx', externalId: track.id }] })) as Track[]

function setup() {
  usePreferences().setLocale('en')
  const state = createCatalogFilterState(tracks, { getItem: () => null, setItem() {}, removeItem() {} })
  const wrapper = mount(AdvancedFilters, { props: { id: 'vocal-filters', state, tracks } })
  return { state, wrapper }
}

describe('Vocal structural result feedback', () => {
  it('counts vocal matches under the selected relation and games, independently of catalogue search', async () => {
    const { state, wrapper } = setup()
    state.setSearch('missing')
    await wrapper.get('[data-filter-relation="event:a"]').trigger('click')
    expect(wrapper.get('[data-filter-tab="vocal"]').attributes('aria-label')).toBe('Vocal (1)')
    expect(wrapper.get('[data-filter-tab-count="vocal"]').text()).toBe('(1)')
    await wrapper.get('[data-filter-tab="vocal"]').trigger('click')
    expect(wrapper.get('[data-vocal-results]').text()).toBe('1 tracks')
    expect(state.filteredTracks.value).toEqual([])
    await wrapper.get('[data-focus-game="hsr"]').trigger('click')
    expect(wrapper.get('[data-filter-tab-count="vocal"]').text()).toBe('(0)')
    expect(wrapper.get('[data-vocal-results]').text()).toBe('No tracks match these filters.')
  })

  it('announces zero matches and clears back to All without changing track tags', async () => {
    const { state, wrapper } = setup()
    await wrapper.get('[data-filter-tab="vocal"]').trigger('click')
    await wrapper.get('[data-filter-relation="event:empty"]').trigger('click')
    const result = wrapper.get('[data-vocal-results]')
    expect(result.attributes('role')).toBe('status')
    expect(result.attributes('aria-atomic')).toBe('true')
    expect(result.text()).toBe('No tracks match these filters.')
    expect(state.filteredTracks.value).toEqual([])
    await wrapper.get('[data-filter-clear-all]').trigger('click')
    expect(wrapper.find('[data-vocal-results]').exists()).toBe(false)
    expect(wrapper.get('[data-filter-tab="all"]').attributes('aria-pressed')).toBe('true')
    expect(state.filteredTracks.value).toHaveLength(3)
    expect(tracks.map(track => track.tabs)).toEqual([[], [], []])
  })
})
