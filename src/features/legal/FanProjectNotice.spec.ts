import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import { usePreferences } from '../../stores/preferences'
import { createFanProjectNoticeStore } from './fanProjectNotice'
import type { SafeStorage } from '../../utils/safeStorage'
import FanProjectNotice from './FanProjectNotice.vue'

const memoryStorage = (): SafeStorage => {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

const mountNotice = () => {
  const store = createFanProjectNoticeStore({ storage: memoryStorage() })
  return { store, wrapper: mount(FanProjectNotice, { props: { store } }) }
}

describe('FanProjectNotice', () => {
  beforeEach(() => usePreferences().setLocale('en'))

  it('states the three things a reader has to be told', () => {
    const { wrapper } = mountNotice()
    const text = wrapper.text()
    expect(text).toContain('unofficial')
    expect(text).toContain('not affiliated with HoYoverse')
    expect(text).toContain('not endorsed')
    expect(text).toContain('respective owners')
  })

  it('points at About for licence detail rather than restating a licence', () => {
    expect(mountNotice().wrapper.text()).toContain('About')
  })

  it('closes on dismissal and does not come back', async () => {
    const { store, wrapper } = mountNotice()
    await wrapper.get('[data-fan-notice-dismiss]').trigger('click')
    expect(store.visible.value).toBe(false)
    expect(wrapper.find('[data-fan-notice]').exists()).toBe(false)
  })

  it('is a labelled landmark with a heading, not an unnamed box', () => {
    const { wrapper } = mountNotice()
    const region = wrapper.get('[data-fan-notice]')
    expect(region.attributes('role')).toBe('region')
    expect(region.attributes('aria-labelledby')).toBeTruthy()
    const heading = wrapper.get('h2')
    expect(heading.attributes('id')).toBe(region.attributes('aria-labelledby'))
    expect(heading.text().length).toBeGreaterThan(0)
  })

  it('offers exactly one control, and it is a real button', () => {
    const { wrapper } = mountNotice()
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]!.attributes('type')).toBe('button')
    expect(buttons[0]!.text().length).toBeGreaterThan(0)
  })

  it('does not trap the reader: no dialog role, no modal, no focus capture', () => {
    const region = mountNotice().wrapper.get('[data-fan-notice]')
    expect(region.attributes('role')).not.toBe('dialog')
    expect(region.attributes('role')).not.toBe('alertdialog')
    expect(region.attributes('aria-modal')).toBeUndefined()
  })

  it('renders in each locale from the catalogue, with no English left showing', async () => {
    const { wrapper } = mountNotice()
    for (const [locale, expected] of [['zh-Hant', '非官方粉絲專案'], ['zh-Hans', '非官方粉丝项目']] as const) {
      usePreferences().setLocale(locale)
      await wrapper.vm.$nextTick()
      expect(wrapper.text()).toContain(expected)
      expect(wrapper.text()).not.toContain('unofficial fan project')
    }
  })

  it('hides itself when the store is already dismissed', async () => {
    const { store, wrapper } = mountNotice()
    store.dismiss()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-fan-notice]').exists()).toBe(false)
  })
})
