vi.mock('./staticDefinitions', async () => import('../../test/fixtures/staticBackgrounds'))
import { flushPromises, mount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import BackgroundSwitcher from './BackgroundSwitcher.vue'
import { createBackgroundStore } from './store'
import { listStaticBackgrounds } from './catalogue'

it('switches from the default scene with an accessible label and respects modal disabling', async () => {
  const store = createBackgroundStore({ repository: { list: async () => listStaticBackgrounds(), getAccountSelection: async () => null, saveAccountSelection: async s => s }, storage: { getItem: () => null, setItem: vi.fn() } })
  await store.load(); store.setPlaybackMode('sequential')
  const wrapper = mount(BackgroundSwitcher, { props: { store, locale: 'zh-Hant' } })
  expect(wrapper.get('button').text()).toBe('下一個背景')
  expect(wrapper.get('button').attributes('aria-label')).toBe('下一個背景')
  expect(store.current.value?.id).toBe('zzz-belle-lofi-girl')
  await wrapper.get('button').trigger('click'); await flushPromises()
  expect(store.current.value?.id).not.toBe('zzz-belle-lofi-girl')
  await wrapper.setProps({ inert: true })
  expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  wrapper.unmount(); store.destroy()
})
