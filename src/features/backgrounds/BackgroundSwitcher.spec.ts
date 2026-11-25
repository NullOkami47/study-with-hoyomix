import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import BackgroundSwitcher from './BackgroundSwitcher.vue'
import { createBackgroundStore } from './store'
import { createPublicBackgrounds } from '../../test/fixtures/publicBackgrounds'

it('switches from the default scene with an accessible label and respects modal disabling', async () => {
  const choices = createPublicBackgrounds()
  const store = createBackgroundStore({ repository: { list: async () => choices, getAccountSelection: async () => null, saveAccountSelection: async s => s }, storage: { getItem: () => null, setItem: vi.fn() } })
  await store.load(); store.setPlaybackMode('sequential')
  const wrapper = mount(BackgroundSwitcher, { props: { store, locale: 'zh-Hant' } })
  expect(wrapper.get('button').text()).toBe('下一個背景')
  expect(wrapper.get('button').attributes('aria-label')).toBe('下一個背景')
  expect(store.current.value?.id).toBe(choices[0]!.id)
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(store.current.value?.id).toBe(choices[1]!.id)
  await wrapper.setProps({ inert: true })
  expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  wrapper.unmount(); store.destroy()
})
