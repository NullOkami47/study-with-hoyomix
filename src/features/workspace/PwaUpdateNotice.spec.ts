import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { usePreferences } from '../../stores/preferences'
import { createPwaUpdateStatus } from '../../pwa/updateStatus'
import PwaUpdateNotice from './PwaUpdateNotice.vue'

describe('PwaUpdateNotice', () => {
  beforeEach(() => usePreferences().setLocale('en'))
  it('keeps offline readiness silent and offers controls for an available update', async () => {
    const status = createPwaUpdateStatus()
    const wrapper = mount(PwaUpdateNotice, { props: { status } })
    status.markOfflineReady(); await wrapper.vm.$nextTick()
    expect(status.state.value).toBe('offlineReady')
    expect(wrapper.find('[data-pwa-update-notice]').exists()).toBe(false)
    status.markNeedRefresh(); await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-pwa-update]').attributes('type')).toBe('button')
    expect(wrapper.get('[data-pwa-later]').element).toBeTruthy()
    await wrapper.get('[data-pwa-later]').trigger('click')
    expect(status.visible.value).toBe(false)
    status.markOfflineReady(); await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-pwa-update]').exists()).toBe(false)
    expect(wrapper.find('[data-pwa-update-notice]').exists()).toBe(false)
  })
})
