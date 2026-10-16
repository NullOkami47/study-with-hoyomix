import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

import PomodoroTimer from './PomodoroTimer.vue'
import { createPomodoroStore } from './store'

describe('focused Pomodoro controls', () => {
  it('keeps duration and cycle settings out of the compact focus-bar presentation', () => {
    const store = createPomodoroStore({ autoTick: false })
    const wrapper = mount(PomodoroTimer, { props: { store } })

    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.find('.pomodoro-timer__settings').exists()).toBe(false)
  })

  it('delegates start, pause, resume, and reset to the supplied store', async () => {
    const store = createPomodoroStore({ autoTick: false, focusMinutes: 1 })
    const wrapper = mount(PomodoroTimer, { props: { store } })

    await wrapper.get('[data-testid="pomodoro-start"]').trigger('click')
    expect(store.status.value).toBe('running')
    await wrapper.get('[data-testid="pomodoro-pause"]').trigger('click')
    expect(store.status.value).toBe('paused')
    await wrapper.get('[data-testid="pomodoro-resume"]').trigger('click')
    expect(store.status.value).toBe('running')
    await wrapper.get('[data-testid="pomodoro-reset"]').trigger('click')
    expect(store.status.value).toBe('idle')
  })

  it('renders the same running store after a route-level unmount and remount', async () => {
    let now = 0
    const store = createPomodoroStore({ clock: { now: () => now }, autoTick: false, focusMinutes: 1 })
    const firstRoute = mount(PomodoroTimer, { props: { store } })
    await firstRoute.get('[data-testid="pomodoro-start"]').trigger('click')
    firstRoute.unmount()

    now = 12_000
    store.tick()
    const nextRoute = mount(PomodoroTimer, { props: { store } })

    expect(nextRoute.get('[data-testid="pomodoro-readout"]').text()).toBe('00:48')
    expect(store.status.value).toBe('running')
  })
})
