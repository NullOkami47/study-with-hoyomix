import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePreferences } from '../../stores/preferences'
import AppShell from './AppShell.vue'

beforeEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  const preferences = usePreferences()
  preferences.setLocale('zh-Hant')
  preferences.setLowPower(false)
  preferences.setBackgroundMode('ambient')
  preferences.setVisualStyle('cinematic')
})

describe('AppShell', () => {
  it('restores the original Cinematic renderer without mounting Studio optics', () => {
    const wrapper = mount(AppShell, {
      slots: { default: '<main id="app-content">Workspace</main>' },
      global: { stubs: { StudioGlassEnvironment: { template: '<div data-glass-environment />' }, LiquidGlassCanvas: { template: '<div data-liquid-glass-canvas />' } } },
    })

    expect(wrapper.attributes('lang')).toBe('zh-Hant')
    expect(wrapper.get('.app-shell__skip-link').attributes('href')).toBe('#app-content')
    expect(wrapper.find('[data-glass-environment]').exists()).toBe(false)
    expect(wrapper.find('[data-liquid-glass-canvas]').exists()).toBe(true)
    expect(wrapper.find('.liquid-glass').exists()).toBe(false)
    expect(wrapper.find('header').exists()).toBe(false)
    expect(wrapper.find('nav').exists()).toBe(false)
    expect(wrapper.find('#app-locale').exists()).toBe(false)
    expect(wrapper.find('[data-testid="legacy-account-header"]').exists()).toBe(false)
    expect(wrapper.findAll('main')).toHaveLength(1)
    wrapper.unmount()
  })

  it('isolates the Studio environment from the Cinematic renderer across switches', async () => {
    const stubs = { StudioGlassEnvironment: { template: '<div data-glass-environment />' }, LiquidGlassCanvas: { template: '<div data-liquid-glass-canvas />' } }
    const preferences = usePreferences()
    preferences.setVisualStyle('studio')
    const wrapper = mount(AppShell, { slots: { default: '<main id="app-content">Workspace</main>' }, global: { stubs } })
    expect(wrapper.find('[data-glass-environment]').exists()).toBe(true)
    expect(wrapper.find('[data-liquid-glass-canvas]').exists()).toBe(false)
    expect(document.documentElement.dataset.theme).toBe('studio')
    preferences.setVisualStyle('cinematic')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-glass-environment]').exists()).toBe(false)
    expect(wrapper.find('[data-liquid-glass-canvas]').exists()).toBe(true)
    wrapper.unmount()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })
})
