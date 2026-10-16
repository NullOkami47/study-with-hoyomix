import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import { usePreferences } from '../../stores/preferences'
import ChatAvailability from './ChatAvailability.vue'

describe('ChatAvailability', () => {
  beforeEach(() => usePreferences().setLocale('en'))

  it('states that community chat is unavailable without simulating a conversation', () => {
    const wrapper = mount(ChatAvailability)

    expect(wrapper.get('[data-chat-availability]').text()).toContain('Community chat is coming later')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('[data-chat-message]').exists()).toBe(false)
    expect(wrapper.find('[data-chat-send]').exists()).toBe(false)
    expect(wrapper.find('[data-chat-presence]').exists()).toBe(false)
  })

  it('carries no chrome of its own, because the floating window owns it', () => {
    const wrapper = mount(ChatAvailability)

    // The window supplies the title, the close control and the glass surface. A second
    // heading or a collapse chevron here would duplicate a control the window already
    // has, which is the confusion the floating design set out to remove.
    expect(wrapper.find('h2').exists()).toBe(false)
    expect(wrapper.find('[data-chat-collapse]').exists()).toBe(false)
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.get('[data-chat-availability]').classes()).not.toContain('surface-glass')
  })
})
