import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import WorkGroup from './WorkGroup.vue'

describe('WorkGroup', () => {
  it('groups every official release version under one canonical work', () => {
    const wrapper = mount(WorkGroup, {
      props: {
        tracks: [
          { id: 'original', title: 'Embers', needsClassification: false },
          { id: 'live', title: 'Embers (Live)', needsClassification: false },
        ],
      },
    })

    expect(wrapper.get('h3').text()).toBe('Embers')
    expect(wrapper.findAll('[data-track-version]')).toHaveLength(2)
    expect(wrapper.text()).toContain('Embers (Live)')
  })
})
