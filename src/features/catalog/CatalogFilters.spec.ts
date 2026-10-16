import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { Track } from './types'
import CatalogFilters from './CatalogFilters.vue'
import { usePreferences } from '../../stores/preferences'

const tracks: Track[] = [
  {
    id: 'dawn',
    title: 'Dawn Winery',
    aliases: { 'zh-Hant': ['晨曦酒莊'] },
    games: ['genshin'],
    relationIds: ['place:mondstadt'],
    tabs: ['sleep', 'focus'],
    workGroupId: 'dawn-work',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }],
  },
  {
    id: 'express',
    title: 'Astral Express',
    aliases: {},
    games: ['hsr'],
    relationIds: ['faction:astral-express'],
    tabs: ['chill'],
    workGroupId: 'express-work',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'youtube', externalId: 'lmnopqrstuv' }],
  },
  {
    id: 'sixth',
    title: 'Sixth Street',
    aliases: {},
    games: ['zzz'],
    relationIds: ['place:new-eridu'],
    tabs: ['focus'],
    workGroupId: 'sixth-work',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'youtube', externalId: '0123456789_' }],
  },
]

function latestIds(wrapper: ReturnType<typeof mount>): string[] {
  const emissions = wrapper.emitted('filtered') ?? []
  return (emissions.at(-1)?.[0] as Track[]).map(({ id }) => id)
}

describe('CatalogFilters', () => {
  it('combines selections in one dimension with OR semantics', async () => {
    const wrapper = mount(CatalogFilters, { props: { tracks } })

    // Every game starts selected, so narrowing to "Genshin OR ZZZ" clears HSR.
    await wrapper.get('[data-filter-game="hsr"]').trigger('click')

    expect(latestIds(wrapper)).toEqual(['dawn', 'sixth'])
  })

  it('combines selected dimensions with AND semantics', async () => {
    const wrapper = mount(CatalogFilters, { props: { tracks } })

    await wrapper.get('[data-filter-game="hsr"]').trigger('click')
    await wrapper.get('[data-filter-game="zzz"]').trigger('click')
    await wrapper.get('[data-filter-tab="chill"]').trigger('click')

    // Genshin AND Chill: the only Chill track is HSR's, so the intersection is empty.
    expect(latestIds(wrapper)).toEqual([])
  })

  it('finds a canonical track through a non-displayed alias', async () => {
    const wrapper = mount(CatalogFilters, { props: { tracks } })

    await wrapper.get('input[type="search"]').setValue('晨曦')

    expect(latestIds(wrapper)).toEqual(['dawn'])
    expect(wrapper.text()).not.toContain('晨曦酒莊')
  })

  it('renders Task 5 controls in the selected Traditional Chinese locale', () => {
    usePreferences().setLocale('zh-Hant')
    const wrapper = mount(CatalogFilters, { props: { tracks } })

    expect(wrapper.get('h2').text()).toBe('尋找你的聆聽空間')
    expect(wrapper.get('input[type="search"]').attributes('placeholder')).toBe('曲名或多語別名')
    usePreferences().setLocale('en')
  })

  it.each([
    ['zh-Hant', '地點：Mondstadt'],
    ['zh-Hans', '地点：Mondstadt'],
    ['en', 'Place: Mondstadt'],
  ] as const)('renders a friendly translated relation label in %s', (locale, label) => {
    usePreferences().setLocale(locale)
    const wrapper = mount(CatalogFilters, { props: { tracks: [tracks[0]!] } })

    expect(wrapper.get('[data-filter-relation="place:mondstadt"]').text()).toBe(label)
    expect(wrapper.text()).not.toContain('place:')
    usePreferences().setLocale('en')
  })
})
