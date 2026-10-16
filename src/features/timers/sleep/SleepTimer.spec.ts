import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import SleepTimer from './SleepTimer.vue'

describe('sleep timer controls', () => {
  it('uses its standalone section heading but defers naming to Settings when embedded', () => {
    const player = { pause: vi.fn(), stop: vi.fn() }
    const standalone = mount(SleepTimer, { props: { player } })
    const embedded = mount(SleepTimer, { props: { player, embedded: true } })

    expect(standalone.get('section').element).toBeTruthy()
    expect(standalone.get('h2').text()).toBe('Sleep timer')
    expect(embedded.find('section').exists()).toBe(false)
    expect(embedded.find('h2').exists()).toBe(false)
    expect(embedded.get('[data-sleep-timer-embedded]').element).toBeTruthy()
  })

  it('offers every required preset plus a custom duration and persists the selection', async () => {
    const wrapper = mount(SleepTimer, { props: { player: { pause: vi.fn(), stop: vi.fn() } } })

    expect(wrapper.findAll('[data-testid="sleep-preset"]').map((button) => button.text())).toEqual(['15', '30', '45', '60', '90'])
    await wrapper.get('[data-testid="sleep-custom"]').setValue('7')
    await wrapper.get('[data-testid="sleep-start"]').trigger('click')

    expect(wrapper.get('[data-testid="sleep-status"]').text()).toContain('07:00')
  })
})
