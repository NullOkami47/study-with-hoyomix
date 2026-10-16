import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import App from '../../App.vue'

beforeEach(() => {
  vi.resetModules()
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

it('mounts the cinematic workspace as the product root', async () => {
  const wrapper = mount(App)
  await flushPromises()

  expect(wrapper.findAll('.app-shell')).toHaveLength(1)
  expect(wrapper.findAll('main#app-content[data-workspace="cinematic"]')).toHaveLength(1)
  // No banner landmark: the inherited dashboard header is gone. A <header> scoped inside
  // a section is that section's own heading area rather than a page header, which is what
  // the chat window's drag handle is.
  const banners = wrapper.findAll('header')
    .filter((header) => header.element.closest('section, article, aside, nav, main') === null)
  expect(banners).toHaveLength(0)
  expect(wrapper.findAll('.catalog-workspace')).toHaveLength(0)
  expect(wrapper.findAll('[data-scene-backdrop]')).toHaveLength(1)
  // The resting scene is the top bar and player. Chat remains available from Settings
  // without being mounted over the artwork on a fresh load.
  expect(wrapper.findAll('[data-workspace-zone]').map((zone) => zone.attributes('data-workspace-zone')))
    .toEqual(['focus', 'player'])
  expect(wrapper.findAll('[data-floating-chat]')).toHaveLength(0)
  expect(wrapper.get('.app-shell__skip-link').attributes('href')).toBe('#app-content')
})
