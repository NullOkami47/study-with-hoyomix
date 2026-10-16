import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import StudyTipCard from './StudyTipCard.vue'

describe('StudyTipCard', () => {
  it('renders a real dismiss button and emits without closing a parent surface', async () => {
    const wrapper = mount(StudyTipCard, { props: { tip: { id: 'pace', title: 'Start gently', body: 'Choose one small next step, then begin.' } } })
    expect(wrapper.get('[data-study-tip]').text()).toContain('Start gently')
    await wrapper.get('[data-study-tip-dismiss]').trigger('click')
    expect(wrapper.emitted('dismiss')).toEqual([[]])
  })
})
