import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { loadChineseTitleConverter } from './displayTitle'
import CatalogSearchPanel from './CatalogSearchPanel.vue'
import type { Track } from './types'

const track = (id: string, title: string, aliases: Record<string, string[]> = {}): Track => ({
  id, title, aliases, games: ['genshin'], relationIds: [], tabs: [], workGroupId: 'group',
  needsClassification: false, vocalStatus: 'instrumental', sources: [],
})
const tracks = [track('a', 'Dawn Winery', { 'zh-Hant': ['晨曦酒莊'] }), track('b', 'Moonlight'), track('c', 'Dawn Chorus')]

function setup(catalogue = tracks, locale: 'en' | 'zh-Hant' | 'zh-Hans' = 'en') {
  const player = { playNow: vi.fn(async () => {}), enqueue: vi.fn() }
  const wrapper = mount(CatalogSearchPanel, { props: { tracks: catalogue, player, locale } })
  return { wrapper, player }
}

describe('CatalogSearchPanel', () => {
  it('updates generated script presentation while search actions retain canonical tracks', async () => {
    await loadChineseTitleConverter()
    const original = track('la-vaguelette', 'La vaguelette', { 'zh-Hans': ['轻涟'] })
    const snapshot = JSON.stringify(original)
    const { wrapper, player } = setup([original], 'zh-Hant')
    await wrapper.get('[data-catalog-search-input]').setValue('轻涟')
    expect(wrapper.get('.catalog-search__title').text()).toBe('輕漣')
    await wrapper.setProps({ locale: 'zh-Hans' })
    expect(wrapper.get('.catalog-search__title').text()).toBe('轻涟')
    await wrapper.get('[data-search-enqueue]').trigger('click')
    expect(player.enqueue).toHaveBeenCalledWith(original)
    expect(JSON.stringify(original)).toBe(snapshot)
    wrapper.unmount()
  })
  it('shows a prompt before searching and does not call player actions while typing', async () => {
    const { wrapper, player } = setup()
    expect(wrapper.find('[data-catalog-search-result]').exists()).toBe(false)
    expect(wrapper.get('[data-catalog-search-prompt]').text()).toContain('Search')
    await wrapper.get('[data-catalog-search-input]').setValue('Dawn')
    expect(wrapper.findAll('[data-catalog-search-result]')).toHaveLength(2)
    expect(player.enqueue).not.toHaveBeenCalled()
    expect(player.playNow).not.toHaveBeenCalled()
  })

  it('finds canonical and localised aliases, displaying the locale title', async () => {
    const { wrapper } = setup(tracks, 'zh-Hant')
    await wrapper.get('[data-catalog-search-input]').setValue('酒莊')
    expect(wrapper.get('[data-catalog-search-result]').text()).toContain('晨曦酒莊')
    expect(wrapper.get('[data-catalog-search-result]').text()).toContain('Dawn Winery')
    await wrapper.get('[data-catalog-search-input]').setValue('Moon')
    expect(wrapper.get('[data-catalog-search-result]').text()).toContain('Moonlight')
  })

  it('reports no matches and invokes actions only on explicit clicks', async () => {
    const { wrapper, player } = setup()
    await wrapper.get('[data-catalog-search-input]').setValue('absent')
    expect(wrapper.get('[data-catalog-search-empty]').element).toBeTruthy()
    await wrapper.get('[data-catalog-search-input]').setValue('Moon')
    await wrapper.get('[data-search-enqueue]').trigger('click')
    expect(player.enqueue).toHaveBeenCalledWith(tracks[1])
    expect(player.playNow).not.toHaveBeenCalled()
    await wrapper.get('[data-search-play]').trigger('click')
    expect(player.playNow).toHaveBeenCalledWith(tracks[1])
  })

  it('searches all 3004 tracks but renders only 40 until asked for more', async () => {
    const many = Array.from({ length: 3004 }, (_, index) => track(`track-${index}`, `Song ${index}`))
    const { wrapper } = setup(many)
    await wrapper.get('[data-catalog-search-input]').setValue('Song')
    expect(wrapper.get('[data-catalog-search-count]').text()).toContain('3004')
    expect(wrapper.findAll('[data-catalog-search-result]')).toHaveLength(40)
    await wrapper.get('[data-search-show-more]').trigger('click')
    expect(wrapper.findAll('[data-catalog-search-result]')).toHaveLength(80)
  })
})
