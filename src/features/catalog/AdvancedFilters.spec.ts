import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import { createCatalogFilterState } from './filterState'
import type { Track } from './types'
import AdvancedFilters from './AdvancedFilters.vue'
import CatalogFilters from './CatalogFilters.vue'

const tracks: Track[] = [
  { id: 'dawn', title: 'Dawn Winery', aliases: {}, games: ['genshin'], relationIds: ['character:diluc', 'npc:ella', 'place:mondstadt', 'faction:knights', 'event:lantern-rite'], tabs: ['sleep', 'focus'], workGroupId: 'dawn-work', vocalStatus: 'instrumental', needsClassification: false, sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }] },
  { id: 'sixth', title: 'Sixth Street', aliases: {}, games: ['zzz'], relationIds: [], tabs: ['chill'], workGroupId: 'sixth-work', vocalStatus: 'instrumental', needsClassification: true, sources: [{ provider: 'youtube', externalId: '0123456789_' }] },
]

const memoryStorage = () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} })

const modeTracks: Track[] = ([
  ['genshin-focus', 'genshin', 'focus'],
  ['genshin-chill', 'genshin', 'chill'],
  ['hsr-focus', 'hsr', 'focus'],
  ['zzz-focus', 'zzz', 'focus'],
  ['zzz-sleep', 'zzz', 'sleep'],
] as const).map(([id, game, tab]) => ({
  id, title: id, aliases: {}, games: [game], relationIds: [], tabs: [tab],
  workGroupId: `work-${id}`, vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'youtube' as const, externalId: `${id}-video` }],
}))

describe('AdvancedFilters mode row', () => {
  it('presents the modes as All, Chill, Focus, Sleep without a queue-linked search field', () => {
    const state = createCatalogFilterState(modeTracks, memoryStorage())
    const wrapper = mount(AdvancedFilters, { props: { id: 'advanced-filters', state, tracks: modeTracks } })

    expect(wrapper.findAll('[data-filter-tab]').map((button) => button.attributes('data-filter-tab')))
      .toEqual(['all', 'chill', 'focus', 'sleep'])

    expect(wrapper.find('input[type="search"]').exists()).toBe(false)
    expect(wrapper.get('[data-advanced-tabs]').element).toBeTruthy()
  })

  it('defaults to an All modes selection to explain the unrestricted mode state', async () => {
    const state = createCatalogFilterState(modeTracks, memoryStorage())
    const wrapper = mount(AdvancedFilters, { props: { id: 'advanced-filters', state, tracks: modeTracks } })

    expect(wrapper.get('[data-filter-tab="all"]').attributes('aria-pressed')).toBe('true')

    await wrapper.get('[data-filter-tab="focus"]').trigger('click')
    expect(wrapper.get('[data-filter-tab="all"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.get('[data-filter-tab="focus"]').attributes('aria-pressed')).toBe('true')
  })


  it.each([{ catalog: [] as Track[] }, { catalog: tracks.map(track => ({ ...track, tabs: [] })) }])('keeps All and every mode reachable even without tagged tracks (%#)', async ({ catalog }) => {
    const state = createCatalogFilterState(catalog, memoryStorage())
    state.setMode('focus')
    const wrapper = mount(AdvancedFilters, { props: { id: 'advanced-filters', state, tracks: catalog } })
    expect(wrapper.findAll('[data-filter-tab]').map(button => button.attributes('data-filter-tab')))
      .toEqual(['all', 'chill', 'focus', 'sleep'])
    expect(wrapper.get('[data-filter-tab="focus"]').attributes('aria-pressed')).toBe('true')
    expect(state.filteredTracks.value).toEqual([])
    await wrapper.get('[data-filter-tab="all"]').trigger('click')
    expect(state.mode.value).toBeNull()
    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(catalog.map(({ id }) => id))
    wrapper.unmount()
  })

  it('shares one single selection bidirectionally with catalogue controls and preserves game filtering', async () => {
    const state = createCatalogFilterState(modeTracks, memoryStorage())
    const advanced = mount(AdvancedFilters, { props: { id: 'advanced-filters', state, tracks: modeTracks } })
    const catalog = mount(CatalogFilters, { props: { state, tracks: modeTracks } })

    await catalog.get('[data-filter-game="hsr"]').trigger('click')
    await catalog.get('[data-filter-tab="sleep"]').trigger('click')
    expect(advanced.get('[data-filter-tab="sleep"]').attributes('aria-pressed')).toBe('true')
    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['zzz-sleep'])

    await advanced.get('[data-filter-tab="focus"]').trigger('click')
    expect(catalog.get('[data-filter-tab="focus"]').attributes('aria-pressed')).toBe('true')
    expect(catalog.get('[data-filter-tab="sleep"]').attributes('aria-pressed')).toBe('false')
    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['genshin-focus', 'zzz-focus'])
    await advanced.get('[data-filter-tab="focus"]').trigger('click')
    expect(state.mode.value).toBe('focus')

    await advanced.get('[data-filter-tab="all"]').trigger('click')
    expect(catalog.get('[data-filter-tab="all"]').attributes('aria-pressed')).toBe('true')
    expect(state.games.value).toEqual(['genshin', 'zzz'])
    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['genshin-focus', 'genshin-chill', 'zzz-focus', 'zzz-sleep'])
    expect(advanced.findAll('[data-filter-tab][aria-pressed="true"]')).toHaveLength(1)
    expect(catalog.findAll('[data-filter-tab][aria-pressed="true"]')).toHaveLength(1)
    advanced.unmount()
    catalog.unmount()
  })

  it('intersects the top-bar game union with the single mode', async () => {
    const state = createCatalogFilterState(modeTracks, memoryStorage())
    const wrapper = mount(AdvancedFilters, { props: { id: 'advanced-filters', state, tracks: modeTracks } })

    // (Genshin OR ZZZ) AND (Focus)
    state.toggleGame('hsr')
    await wrapper.get('[data-filter-tab="focus"]').trigger('click')

    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['genshin-focus', 'zzz-focus'])
    expect(wrapper.find('[data-filter-result-count]').exists()).toBe(false)
  })
})

describe('AdvancedFilters', () => {
  it('never renders the retired classification and work-group filters', () => {
    const state = createCatalogFilterState(tracks, memoryStorage())
    const wrapper = mount(AdvancedFilters, { props: { id: 'filters', state, tracks } })

    expect(wrapper.find('[data-classification]').exists()).toBe(false)
    expect(wrapper.find('[data-work-group]').exists()).toBe(false)
    expect(wrapper.find('[data-work-groups-unavailable]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Classification')
    expect(wrapper.text()).not.toContain('Work groups')
    // The retired labels must not survive as dead localisation references either.
    expect(wrapper.html()).not.toContain('catalog.classification')
    expect(wrapper.html()).not.toContain('catalog.workGroups')
  })

  it('keeps the remaining games, modes, and relations filters rendered', () => {
    const state = createCatalogFilterState(tracks, memoryStorage())
    const wrapper = mount(AdvancedFilters, { props: { id: 'filters', state, tracks } })

    expect(wrapper.get('[data-filter-games]').element).toBeTruthy()
    expect(wrapper.get('[data-advanced-tabs]').element).toBeTruthy()
    expect(wrapper.findAll('[data-filter-tab]').map((button) => button.attributes('data-filter-tab')))
      .toEqual(['all', 'chill', 'focus', 'sleep'])
    expect(wrapper.findAll('[data-focus-game]').map((button) => button.attributes('data-focus-game')))
      .toEqual(['genshin', 'hsr', 'zzz'])
    expect(wrapper.get('[data-relation-kind="character"]').text()).toContain('Diluc')
    expect(wrapper.find('[data-relations-unavailable]').exists()).toBe(false)
    expect(wrapper.find('[data-filter-result-count]').exists()).toBe(false)
  })

  it.each([
    ['normal', tracks],
    ['no relations', tracks.map((track) => ({ ...track, relationIds: [] }))],
  ])('never renders blank fieldsets: %s', (_name, catalog) => {
    const state = createCatalogFilterState(catalog as Track[], memoryStorage())
    const wrapper = mount(AdvancedFilters, { props: { id: 'filters', state, tracks: catalog as Track[] } })

    expect(wrapper.find('[data-relations-unavailable]').exists()).toBe(false)
    expect([...wrapper.element.querySelectorAll('fieldset')].every((fieldset) => fieldset.querySelector('button'))).toBe(true)
  })

  it('limits large option lists and permits searching all options', async () => {
    const catalog = Array.from({ length: 120 }, (_, index) => ({
      ...tracks[0]!, id: `track-${index}`, relationIds: [`place:place-${index}`],
    }))
    const state = createCatalogFilterState(catalog, memoryStorage())
    const wrapper = mount(AdvancedFilters, { props: { id: 'filters', state, tracks: catalog } })
    expect(wrapper.findAll('[data-filter-relation]')).toHaveLength(40)
    await wrapper.get('input[type="search"]').setValue('Place 119')
    expect(wrapper.get('[data-filter-relation="place:place-119"]').element).toBeTruthy()
    await wrapper.get('input[type="search"]').setValue('')
    await wrapper.get('[data-filter-more-options]').trigger('click')
    expect(wrapper.findAll('[data-filter-relation]')).toHaveLength(80)
  })

  it('reveals Clear all only for live filters and restores the default state', async () => {
    const state = createCatalogFilterState(tracks, memoryStorage())
    const wrapper = mount(AdvancedFilters, { props: { id: 'advanced-filters', state, tracks } })
    expect(wrapper.find('[data-filter-clear-all]').exists()).toBe(false)

    await wrapper.get('[data-focus-game="hsr"]').trigger('click')
    await wrapper.get('[data-filter-tab="focus"]').trigger('click')
    await wrapper.get('[data-filter-relation="character:diluc"]').trigger('click')
    expect(wrapper.find('[data-filter-clear-all]').exists()).toBe(true)

    await wrapper.get('[data-filter-clear-all]').trigger('click')
    expect(state.games.value).toHaveLength(3)
    expect(state.mode.value).toBeNull()
    expect(state.search.value).toBe('')
    expect(state.relationIds.value).toEqual([])
    expect(wrapper.find('[data-filter-clear-all]').exists()).toBe(false)
  })

  it('derives relation options from canonical metadata', async () => {
    const state = createCatalogFilterState(tracks, memoryStorage())
    const wrapper = mount(AdvancedFilters, { props: { id: 'advanced-filters', state, tracks } })

    expect(wrapper.get('[data-advanced-tabs]').text()).toContain('Sleep')
    expect(wrapper.get('[data-relation-kind="character"]').text()).toContain('Diluc')
    expect(wrapper.get('[data-relation-kind="npc"]').text()).toContain('Ella')
    expect(wrapper.get('[data-relation-kind="place"]').text()).toContain('Mondstadt')
    expect(wrapper.get('[data-relation-kind="faction"]').text()).toContain('Knights')
    expect(wrapper.get('[data-relation-kind="event"]').text()).toContain('Lantern Rite')

    await wrapper.get('[data-filter-relation="character:diluc"]').trigger('click')
    expect(wrapper.find('[data-advanced-filters]').exists()).toBe(true)
    expect(wrapper.find('[data-filter-result-count]').exists()).toBe(false)
  })

  /**
   * Regression guard for requirement 7: a stale persisted record must not inflate the
   * active-filter count. Only the live dimensions can make Clear all appear, and the
   * retired values are dropped before the panel renders.
   */
  it('counts only live filters when a retired record is restored', async () => {
    const retired = JSON.stringify({
      search: '', games: ['hsr'], mode: 'focus', relationIds: [],
      workGroupIds: ['dawn-work'], classification: 'classified',
    })
    const state = createCatalogFilterState(modeTracks, {
      getItem: () => retired,
      setItem: () => {},
      removeItem: () => {},
    })
    const wrapper = mount(AdvancedFilters, { props: { id: 'advanced-filters', state, tracks: modeTracks } })

    // Game + mode are active; the retired classification/work group are not counted and
    // are not rendered.
    expect(wrapper.find('[data-filter-clear-all]').exists()).toBe(true)
    expect(wrapper.find('[data-classification]').exists()).toBe(false)
    expect(wrapper.find('[data-work-group]').exists()).toBe(false)

    await wrapper.get('[data-filter-clear-all]').trigger('click')
    expect([...state.games.value].sort()).toEqual(['genshin', 'hsr', 'zzz'])
    expect(state.mode.value).toBeNull()
    expect(state.filteredTracks.value).toHaveLength(modeTracks.length)
    expect(wrapper.find('[data-filter-clear-all]').exists()).toBe(false)
  })
})
