import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import type { Track } from './types'
import TrackList from './TrackList.vue'
import { usePreferences } from '../../stores/preferences'

const tracks: Track[] = [
  {
    id: 'original', title: 'Embers', aliases: {}, games: ['zzz'], relationIds: [], tabs: ['focus'],
    workGroupId: 'embers', vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }],
  },
  {
    id: 'live', title: 'Embers (Live)', aliases: {}, games: ['zzz'], relationIds: [], tabs: ['chill'],
    workGroupId: 'embers', vocalStatus: 'instrumental', needsClassification: true,
    sources: [{ provider: 'youtube', externalId: 'lmnopqrstuv' }],
  },
]

describe('TrackList', () => {
  it('shows grouped releases, classification status, and labelled queue actions', async () => {
    const wrapper = mount(TrackList, { props: { tracks } })

    expect(wrapper.findAll('[data-work-group]')).toHaveLength(1)
    expect(wrapper.get('[data-unclassified]').text()).toBe('Needs classification')

    await wrapper.get('[aria-label="Play Embers (Live) now"]').trigger('click')
    await wrapper.get('[aria-label="Add Embers to queue"]').trigger('click')
    expect(wrapper.emitted('play-now')?.[0]).toEqual([tracks[1]])
    expect(wrapper.emitted('enqueue')?.[0]).toEqual([tracks[0]])
  })

  it.each([
    ['zh-Hant', '曲目清單'],
    ['zh-Hans', '曲目列表'],
    ['en', 'Catalogue tracks'],
  ] as const)('localises its accessible name in %s', (locale, label) => {
    usePreferences().setLocale(locale)
    const wrapper = mount(TrackList, { props: { tracks } })

    expect(wrapper.get('section').attributes('aria-label')).toBe(label)
    usePreferences().setLocale('en')
  })
})
