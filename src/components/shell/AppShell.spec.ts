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
  it('retains the skip link, locale-derived language, and global renderer without a dashboard bar', () => {
    const wrapper = mount(AppShell, {
      slots: { default: '<main id="app-content">Workspace</main>' },
      global: { stubs: { LiquidGlassCanvas: { template: '<div data-liquid-glass-canvas />' } } },
    })

    expect(wrapper.attributes('lang')).toBe('zh-Hant')
    expect(wrapper.get('.app-shell__skip-link').attributes('href')).toBe('#app-content')
    expect(wrapper.get('[data-liquid-glass-canvas]').element).toBeTruthy()
    expect(wrapper.find('header').exists()).toBe(false)
    expect(wrapper.find('nav').exists()).toBe(false)
    expect(wrapper.find('#app-locale').exists()).toBe(false)
    expect(wrapper.find('[data-testid="legacy-account-header"]').exists()).toBe(false)
    expect(wrapper.findAll('main')).toHaveLength(1)
  })
})
