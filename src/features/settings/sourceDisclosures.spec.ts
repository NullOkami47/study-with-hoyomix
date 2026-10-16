import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ChkszInfo from './ChkszInfo.vue'
import ThirdPartyAgreement from './ThirdPartyAgreement.vue'
import { translate, type Locale } from '../../i18n'

describe('source disclosures', () => {
  it.each<Locale>(['zh-Hant', 'zh-Hans', 'en'])('discloses the query exposure boundary before acceptance and in help (%s)', async (locale) => {
    const agreement = mount(ThirdPartyAgreement, { props: { locale, pending: true, accepted: false } })
    const info = mount(ChkszInfo, { props: { locale } })
    await info.get('button').trigger('click')
    for (const text of [agreement.get('[data-agreement-content]').text(), info.get('[role="dialog"]').text()]) {
      for (const boundary of ['api.chksz.com', 'apikey', 'HTTPS', 'Network', 'no-store', 'no-referrer', 'x-chksz-api-key']) {
        expect(text).toContain(boundary)
      }
    }
    const notice = translate(locale, 'settings.playback.chkszDevtoolsNotice')
    expect(notice).toContain('apikey')
    expect(notice).toContain('Network')
    expect(notice).toContain('HTTPS')
    expect(agreement.get('[data-agreement-accept]').attributes('disabled')).toBeDefined()
    expect(agreement.emitted('accept')).toBeUndefined()
    agreement.unmount()
    info.unmount()
  })
  it('opens ChKSz information by click only and closes on Escape/outside', async () => {
    const wrapper = mount(ChkszInfo, { props: { locale: 'en' }, attachTo: document.body })
    await wrapper.get('button').trigger('mouseenter')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('[role="dialog"]').text()).toContain('memory')
    expect(wrapper.get('a').attributes('href')).toBe('https://api.chksz.com/')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    await wrapper.get('button').trigger('click')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('requires explicit acceptance and permits withdrawal', async () => {
    const wrapper = mount(ThirdPartyAgreement, { props: { locale: 'en', pending: true, accepted: false } })
    expect(wrapper.get('[data-agreement-content]').text()).toContain('copyright')
    expect(wrapper.get('[data-agreement-accept]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-agreement-check]').setValue(true)
    await wrapper.get('[data-agreement-accept]').trigger('click')
    expect(wrapper.emitted('accept')).toHaveLength(1)
    await wrapper.setProps({ accepted: true, pending: false })
    await wrapper.get('[data-agreement-withdraw]').trigger('click')
    expect(wrapper.emitted('withdraw')).toHaveLength(1)
    wrapper.unmount()
  })
})
