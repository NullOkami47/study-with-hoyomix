import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCatalogFilterState } from '../catalog/filterState'
import type { Track } from '../catalog/types'
import { createPomodoroStore } from '../timers/pomodoro/store'
import FocusBar from './FocusBar.vue'
import { createSleepTimerStore } from '../timers/sleep/store'

const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const sleepStore = () => createSleepTimerStore({ autoTick: false, clock: { now: () => 0 }, storage, player: { pause() {}, stop() {} } })


const tracks: Track[] = [
  { id: 'dawn', title: 'Dawn Winery', aliases: {}, games: ['genshin'], relationIds: ['character:diluc'], tabs: ['focus'], workGroupId: 'dawn-work', vocalStatus: 'instrumental', needsClassification: false, sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }] },
  { id: 'sixth', title: 'Sixth Street', aliases: {}, games: ['zzz'], relationIds: ['place:new-eridu'], tabs: ['sleep'], workGroupId: 'sixth-work', vocalStatus: 'instrumental', needsClassification: true, sources: [{ provider: 'youtube', externalId: '0123456789_' }] },
]

function mountBar(
  pomodoroStore = createPomodoroStore({ autoTick: false, clock: { now: () => 0 }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }),
  options: { modalOpen?: boolean; tracks?: Track[] } = {},
) {
  const catalogue = options.tracks ?? tracks
  const state = createCatalogFilterState(catalogue, { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  return mount(FocusBar, {
    attachTo: document.body,
    props: {
      state,
      tracks: catalogue,
      pomodoroStore,
      sleepTimerStore: sleepStore(),
      modalOpen: options.modalOpen ?? false,
      clock: { now: () => 0, formatLocalTime: () => '08:15' },
    },
  })
}

afterEach(() => { document.body.innerHTML = '' })

describe('FocusBar shared filters and independent sleep session', () => {
  it('keeps secondary scene controls yielded while switching between timer disclosures', async () => {
    const wrapper = mountBar()
    await wrapper.get('[data-phase-trigger]').trigger('click')
    expect(wrapper.emitted('toggle-popover')).toEqual([[true]])
    await wrapper.get('[data-phase-select="sleep"]').trigger('click')
    expect(wrapper.emitted('toggle-popover')).toEqual([[true]])
    await wrapper.get('[data-sleep-trigger]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('toggle-popover')).toEqual([[true], [false]])
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    expect(wrapper.emitted('toggle-popover')?.at(-1)).toEqual([true])
    await wrapper.setProps({ modalOpen: true })
    expect(wrapper.emitted('toggle-popover')?.at(-1)).toEqual([false])
    wrapper.unmount()
  })

  it('marks active filters on the compact trigger without coupling them to the timer phase', async () => {
    const wrapper = mountBar()
    const trigger = wrapper.get('[data-advanced-trigger]')
    expect(trigger.attributes('data-filter-active')).toBe('false')
    wrapper.props('pomodoroStore').selectPhase('break')
    await nextTick()
    expect(trigger.attributes('data-filter-active')).toBe('false')
    wrapper.props('state').setMode('sleep')
    await nextTick()
    expect(trigger.attributes('data-filter-active')).toBe('true')
    expect(trigger.attributes('aria-label')).toContain('Sleep')
    wrapper.props('state').setMode(null)
    wrapper.props('state').setSearch('Dawn')
    await nextTick()
    expect(trigger.attributes('data-filter-active')).toBe('true')
    wrapper.props('state').setSearch('')
    wrapper.props('state').toggleGame('genshin')
    await nextTick()
    expect(trigger.attributes('data-filter-active')).toBe('true')
    wrapper.unmount()
  })

  it('names the exact selected games and advanced filters without bare counts', async () => {
    const wrapper = mountBar()
    const state = wrapper.props('state')
    const visible = () => wrapper.get('[data-focus-filter-summary]').text()
    const accessible = () => wrapper.get('[data-advanced-trigger]').attributes('aria-label')
    const check = () => {
      expect(visible()).not.toMatch(/(?:^|·\s*)\+\d+\b/u)
      expect(wrapper.get('[data-advanced-trigger]').attributes('title')).toBe(accessible())
    }

    expect(visible()).toBe('All games')
    check()
    state.toggleGame('genshin')
    state.toggleGame('zzz')
    await nextTick()
    expect(visible()).toBe('Honkai: Star Rail')
    expect(accessible()).not.toContain('Genshin Impact')
    check()

    state.toggleGame('genshin')
    await nextTick()
    expect(visible()).toBe('Honkai: Star Rail · Genshin Impact')
    check()

    state.toggleGame('zzz')
    state.setMode('focus')
    await nextTick()
    expect(visible()).toBe('All games · Focus')
    check()

    state.toggleRelation('character:diluc')
    await nextTick()
    expect(accessible()).toContain('Character: Diluc')
    check()
    state.toggleRelation('place:new-eridu')
    await nextTick()
    expect(accessible()).toContain('Place: New Eridu')
    check()
    state.setSearch('Dawn')
    await nextTick()
    expect(accessible()).toContain('Search active')
    expect(visible()).toBe('All games · Focus · 3 more')
    expect(accessible()).toBe('Filters: All games · Focus · Character: Diluc · Place: New Eridu · Search active')
    check()
  })

  /**
   * Requirement 7: a user upgrading from the old filter model keeps two live filters,
   * not four. The stale classification and work-group values are dropped before the
   * summary is built, so they cannot appear as chips or inflate the count.
   */
  it('reports only live filters when a retired record is restored', async () => {
    const retired = JSON.stringify({
      search: '', games: ['hsr'], mode: null, relationIds: ['character:diluc'],
      workGroupIds: ['dawn-work'], classification: 'classified',
    })
    const state = createCatalogFilterState(tracks, { getItem: () => retired, setItem: () => {}, removeItem: () => {} })
    const wrapper = mount(FocusBar, {
      attachTo: document.body,
      props: {
        state,
        tracks,
        pomodoroStore: createPomodoroStore({ autoTick: false, clock: { now: () => 0 }, storage }),
        sleepTimerStore: sleepStore(),
        modalOpen: false,
        clock: { now: () => 0, formatLocalTime: () => '08:15' },
      },
    })

    const accessible = wrapper.get('[data-advanced-trigger]').attributes('aria-label')!
    expect(accessible).toContain('Honkai: Star Rail')
    expect(accessible).toContain('Character: Diluc')
    expect(accessible).not.toContain('Classified')
    expect(accessible).not.toContain('Dawn Work')
    // Exactly two active dimensions: the game and the relation.
    expect(accessible.split(' · ')).toHaveLength(2)
    expect(wrapper.findAll('[data-classification]')).toHaveLength(0)
    expect(wrapper.findAll('[data-work-group]')).toHaveLength(0)
  })

  async function chooseSleep(wrapper: ReturnType<typeof mountBar>) {
    await wrapper.get('[data-phase-trigger]').trigger('click')
    expect(wrapper.findAll('[data-phase-menu] button').map((button) => button.text())).toEqual(['Focus', 'Short break', 'Long break', 'Sleep timer'])
    await wrapper.get('[data-phase-select="sleep"]').trigger('click')
  }

  it('keeps all four music choices in Filters, independently of timer selection', async () => {
    const wrapper = mountBar()
    const state = wrapper.props('state')
    expect(wrapper.findAll('[data-focus-mode]')).toHaveLength(0)
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    expect(wrapper.findAll('[data-filter-tab]').map((button) => button.text())).toEqual(['All modes', 'Chill', 'Focus', 'Sleep'])
    await wrapper.get('[data-filter-tab="sleep"]').trigger('click')
    expect(state.mode.value).toBe('sleep')
    expect(state.filteredTracks.value.map((track) => track.id)).toEqual(['sixth'])
    expect(wrapper.get('[data-focus-filter-summary]').text()).toContain('Sleep')
    await wrapper.get('[data-filter-tab="focus"]').trigger('click')
    expect(wrapper.get('[data-focus-filter-summary]').text()).toContain('Focus')
    expect(state.filteredTracks.value.map((track) => track.id)).toEqual(['dawn'])
    await chooseSleep(wrapper)
    expect(state.mode.value).toBe('focus')
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-filter-tab="chill"]').trigger('click')
    expect(state.filteredTracks.value).toEqual([])
    expect(wrapper.get('[data-phase-trigger]').text()).toBe('Sleep timer')
    await wrapper.get('[data-filter-tab="all"]').trigger('click')
    expect(state.mode.value).toBeNull()
    expect(state.filteredTracks.value.map((track) => track.id)).toEqual(['dawn', 'sixth'])
    expect(wrapper.emitted('open-control-centre')).toBeUndefined()
  })

  it('keeps every mode reachable with unclassified tracks and reflects external game changes', async () => {
    const unclassified: Track[] = tracks.map((track) => ({ ...track, tabs: [], vocalStatus: 'uncertain' }))
    const wrapper = mountBar(undefined, { tracks: unclassified })
    const state = wrapper.props('state')
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    expect(wrapper.findAll('[data-filter-tab]')).toHaveLength(4)
    await wrapper.get('[data-filter-tab="focus"]').trigger('click')
    expect(state.filteredTracks.value).toEqual([])
    await wrapper.get('[data-filter-tab="all"]').trigger('click')
    expect(state.filteredTracks.value).toHaveLength(2)
    state.toggleGame('hsr')
    await nextTick()
    expect(wrapper.get('[data-focus-game="hsr"]').attributes('aria-pressed')).toBe('false')
    await wrapper.get('[data-focus-game="zzz"]').trigger('click')
    await wrapper.get('[data-focus-game="genshin"]').trigger('click')
    expect(state.games.value).toEqual(['genshin'])
    expect(state.filteredTracks.value.map((track) => track.id)).toEqual(['dawn'])
  })

  it('runs presets/custom/start/pause/resume/cancel on the injected sleep store without cancelling a running Pomodoro', async () => {
    const wrapper = mountBar()
    const pomodoro = wrapper.props('pomodoroStore')
    const sleep = wrapper.props('sleepTimerStore')
    pomodoro.start()
    const remaining = pomodoro.remainingSeconds.value
    await chooseSleep(wrapper)
    expect(sleep.status.value).toBe('idle')
    expect(wrapper.find('[data-focus-pomodoro-start]').exists()).toBe(false)
    expect(wrapper.find('[data-focus-pomodoro-pause]').exists()).toBe(false)
    expect(wrapper.find('[data-focus-pomodoro-reset]').exists()).toBe(false)
    const presets = wrapper.findAll('[data-testid="sleep-preset"]')
    expect(presets.map((button) => button.text())).toEqual(['15', '30', '45', '60', '90'])
    for (const preset of presets) {
      await preset.trigger('click')
      expect(sleep.selectedMinutes.value).toBe(Number(preset.text()))
    }
    await wrapper.get('[data-testid="sleep-custom"]').setValue('7')
    expect(sleep.selectedMinutes.value).toBe(7)
    await wrapper.get('[data-testid="sleep-start"]').trigger('click')
    expect(sleep.status.value).toBe('running')
    expect(wrapper.get('[data-focus-sleep-readout]').text()).toBe('07:00')
    const action = (label: string) => wrapper.findAll('[data-sleep-panel] button').find((button) => button.text() === label)!
    await action('Pause sleep timer').trigger('click')
    expect(sleep.status.value).toBe('paused')
    await action('Resume sleep timer').trigger('click')
    expect(sleep.status.value).toBe('running')
    await action('Cancel sleep timer').trigger('click')
    expect(sleep.status.value).toBe('idle')
    expect(pomodoro.phase.value).toBe('focus')
    expect(pomodoro.status.value).toBe('running')
    expect(pomodoro.remainingSeconds.value).toBe(remaining)
  })

  it('returns from Sleep to the running Pomodoro surface without changing phases or cancelling either timer', async () => {
    const wrapper = mountBar()
    const pomodoro = wrapper.props('pomodoroStore')
    const sleep = wrapper.props('sleepTimerStore')
    pomodoro.start()
    const remaining = pomodoro.remainingSeconds.value
    await chooseSleep(wrapper)
    await wrapper.get('[data-testid="sleep-start"]').trigger('click')

    await wrapper.get('[data-phase-trigger]').trigger('click')
    expect(wrapper.get('[data-phase-select="focus"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-phase-select="break"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-phase-select="longBreak"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-phase-select="focus"]').trigger('click')

    expect(pomodoro.phase.value).toBe('focus')
    expect(pomodoro.status.value).toBe('running')
    expect(pomodoro.remainingSeconds.value).toBe(remaining)
    expect(sleep.status.value).toBe('running')
    expect(wrapper.find('[data-sleep-panel]').exists()).toBe(false)
    await wrapper.get('[data-focus-pomodoro-pause]').trigger('click')
    expect(pomodoro.status.value).toBe('paused')
    expect(sleep.status.value).toBe('running')
  })

  it('selects Focus/Short/Long without cancelling sleep and preserves the shared store across panel unmounts', async () => {
    const wrapper = mountBar()
    const sleep = wrapper.props('sleepTimerStore')
    await chooseSleep(wrapper)
    await wrapper.get('[data-testid="sleep-start"]').trigger('click')
    for (const [phase, seconds] of [['break', 300], ['longBreak', 600], ['focus', 1500]] as const) {
      await wrapper.get('[data-phase-trigger]').trigger('click')
      await wrapper.get(`[data-phase-select="${phase}"]`).trigger('click')
      expect(wrapper.props('pomodoroStore').phase.value).toBe(phase)
      expect(wrapper.props('pomodoroStore').remainingSeconds.value).toBe(seconds)
      expect(sleep.status.value).toBe('running')
      expect(wrapper.find('[data-sleep-panel]').exists()).toBe(false)
    }
    await chooseSleep(wrapper)
    expect(wrapper.get('[data-testid="sleep-status"]').text()).toBe('15:00')
    wrapper.unmount()
    sleep.pause()
    expect(sleep.status.value).toBe('paused')
    sleep.resume()
    expect(sleep.status.value).toBe('running')
  })

  it('isolates sleep panel padding/header, restores focus on Escape and closes on outside click', async () => {
    const wrapper = mountBar()
    await chooseSleep(wrapper)
    await wrapper.get('[data-sleep-panel]').trigger('click')
    await wrapper.get('[data-sleep-panel] header').trigger('click')
    expect(wrapper.emitted('open-control-centre')).toBeUndefined()
    const trigger = wrapper.get('[data-sleep-trigger]')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(trigger.attributes('aria-controls')).toBe(wrapper.get('[data-sleep-panel]').attributes('id'))
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    wrapper.get('[data-testid="sleep-custom"]').element.dispatchEvent(event)
    await nextTick()
    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.find('[data-sleep-panel]').exists()).toBe(false)
    expect(document.activeElement).toBe(trigger.element)
    await trigger.trigger('click')
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.find('[data-sleep-panel]').exists()).toBe(false)
    expect(wrapper.props('sleepTimerStore').status.value).toBe('idle')
  })

  it('discloses only the current non-modal panel and never steals modal Escape or focus', async () => {
    const wrapper = mountBar()
    await chooseSleep(wrapper)
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    expect(wrapper.find('[data-sleep-panel]').exists()).toBe(false)
    await wrapper.get('[data-phase-trigger]').trigger('click')
    expect(wrapper.find('[data-advanced-filters]').exists()).toBe(false)
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.find('[data-phase-menu]').exists()).toBe(false)
    await wrapper.get('[data-sleep-trigger]').trigger('click')
    const modalControl = document.createElement('button')
    document.body.append(modalControl)
    modalControl.focus()
    await wrapper.setProps({ modalOpen: true })
    expect(wrapper.find('[data-sleep-panel]').exists()).toBe(false)
    expect(document.activeElement).toBe(modalControl)
    await wrapper.get('[data-sleep-trigger]').trigger('click')
    await wrapper.get('[data-phase-trigger]').trigger('click')
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-focus-control-centre]').trigger('click')
    expect(wrapper.find('[data-sleep-panel], [data-phase-menu], [data-advanced-filters]').exists()).toBe(false)
    expect(wrapper.emitted('open-control-centre')).toBeUndefined()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    wrapper.element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('FocusBar', () => {
  it('keeps all three games selected on first visit inside the disclosed panel', async () => {
    const wrapper = mountBar()

    expect(wrapper.findAll('[data-focus-game]')).toHaveLength(0)
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    expect(wrapper.get('[data-focus-game="genshin"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-focus-game="hsr"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-focus-game="zzz"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-focus-local-clock]').text()).toBe('08:15')
    expect(wrapper.get('[data-focus-online]').text()).toBe('Presence unavailable')
  })

  it('keeps multiple game selections active independently and refuses to clear the last one', async () => {
    const wrapper = mountBar()
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    const genshin = wrapper.get('[data-focus-game="genshin"]')
    const hsr = wrapper.get('[data-focus-game="hsr"]')
    const zzz = wrapper.get('[data-focus-game="zzz"]')

    await hsr.trigger('click')

    expect(genshin.attributes('aria-pressed')).toBe('true')
    expect(hsr.attributes('aria-pressed')).toBe('false')
    expect(zzz.attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-focus-filter-summary]').text()).toContain('Genshin Impact')

    await zzz.trigger('click')
    expect(genshin.attributes('aria-pressed')).toBe('true')
    expect(zzz.attributes('aria-pressed')).toBe('false')

    await genshin.trigger('click')
    expect(genshin.attributes('aria-pressed')).toBe('true')
  })
  it('uses only a compact Pomodoro readout and phase commands in the top bar', () => {
    const wrapper = mountBar()

    expect(wrapper.get('[data-focus-pomodoro-readout]').text()).toBe('25:00')
    expect(wrapper.find('[data-focus-pomodoro-start]').exists()).toBe(true)
    expect(wrapper.find('[data-focus-pomodoro-reset]').exists()).toBe(true)
    expect(wrapper.find('input[type="number"]').exists()).toBe(false)
    expect(wrapper.get('[data-phase-trigger]').attributes('aria-expanded')).toBe('false')
  })

  it('renders the current phase in the phase pill and an accessible phase-change label', async () => {
    const store = createPomodoroStore({ autoTick: false, clock: { now: () => 0 }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
    const wrapper = mountBar(store)
    const trigger = wrapper.get('[data-phase-trigger]')

    expect(trigger.text()).toBe('Focus')
    expect(trigger.attributes('aria-label')).toBe('Change current phase: Focus')
    store.selectPhase('break')
    await nextTick()

    expect(trigger.text()).toBe('Short break')
    expect(trigger.attributes('aria-label')).toBe('Change current phase: Short break')
  })

  it('selects an idle phase through the compact phase menu, then closes and returns focus', async () => {
    const store = createPomodoroStore({ autoTick: false, clock: { now: () => 0 }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
    const wrapper = mountBar(store)
    const trigger = wrapper.get('[data-phase-trigger]')

    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-phase-menu]').attributes('id')).toBe(trigger.attributes('aria-controls'))
    await wrapper.get('[data-phase-select="break"]').trigger('click')
    await nextTick()

    expect(store.phase.value).toBe('break')
    expect(store.remainingSeconds.value).toBe(5 * 60)
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger.element)
  })

  it('disables phase commands while the timer is running', async () => {
    const store = createPomodoroStore({ autoTick: false, clock: { now: () => 0 }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
    const wrapper = mountBar(store)

    await wrapper.get('[data-focus-pomodoro-start]').trigger('click')
    await wrapper.get('[data-phase-trigger]').trigger('click')

    expect(wrapper.get('[data-phase-select="break"]').attributes('disabled')).toBeDefined()
  })

  it('closes an open phase menu from Escape on its trigger without swallowing closed-state Escape', async () => {
    const wrapper = mountBar()
    const root = wrapper.get('.focus-bar')
    const trigger = wrapper.get('[data-phase-trigger]')
    const bubbled = vi.fn()
    document.addEventListener('keydown', bubbled)
    ;(trigger.element as HTMLElement).focus()

    await trigger.trigger('click')
    expect(document.activeElement).toBe(trigger.element)
    expect(trigger.attributes('aria-expanded')).toBe('true')

    const openedEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    trigger.element.dispatchEvent(openedEscape)
    await nextTick()
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger.element)
    expect(bubbled).not.toHaveBeenCalled()

    const closedEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    root.element.dispatchEvent(closedEscape)
    expect(bubbled).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', bubbled)
  })

  it('opens advanced filters with correct aria contract, closes on Escape, and returns focus to its trigger', async () => {
    const wrapper = mountBar()
    const trigger = wrapper.get('[data-advanced-trigger]')

    await trigger.trigger('click')
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-advanced-filters]').attributes('id')).toBe(trigger.attributes('aria-controls'))

    await trigger.trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger.element)
  })

  it('closes the surface on an outside click and removes its document listener on unmount', async () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const wrapper = mountBar()

    await wrapper.get('[data-advanced-trigger]').trigger('click')
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.find('[data-advanced-filters]').exists()).toBe(false)

    wrapper.unmount()
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    removeSpy.mockRestore()
  })

  it('closes from its explicit control and returns focus to the trigger', async () => {
    const wrapper = mountBar()
    const trigger = wrapper.get('[data-advanced-trigger]')

    await trigger.trigger('click')
    await wrapper.get('[data-advanced-close]').trigger('click')
    await nextTick()

    expect(trigger.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger.element)
  })
})

/**
 * The bar itself is the way into the Control Center. These cover the boundary that makes
 * that safe: the surface opens the hub, every control on it keeps its own action, and
 * neither ever fires the other.
 */
describe('FocusBar as the Control Center opener', () => {
  const store = () => createPomodoroStore({ autoTick: false, clock: { now: () => 0 }, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })

  it('carries no permanent settings, library, or overflow control on the scene', () => {
    const wrapper = mountBar()

    expect(wrapper.find('[data-focus-tray-trigger]').exists()).toBe(false)
    expect(wrapper.find('[data-focus-tray]').exists()).toBe(false)
    expect(wrapper.find('[data-quick-action]').exists()).toBe(false)
    // Only timer controls and one filter affordance remain on the bar.
    const labels = wrapper.findAll('.focus-bar__toolbar button').map((button) => button.attributes('aria-label') ?? button.text())
    expect(labels).toEqual([
      'Change current phase: Focus', 'Start', 'Reset',
      'Filters: All games',
    ])
  })

  it('keeps full game names in the disclosed filter panel', async () => {
    const wrapper = mountBar()
    await wrapper.get('[data-advanced-trigger]').trigger('click')

    for (const [game, full] of [
      ['genshin', 'Genshin Impact'],
      ['hsr', 'Honkai: Star Rail'],
      ['zzz', 'Zenless Zone Zero'],
    ] as const) {
      const button = wrapper.get(`[data-focus-game="${game}"]`)
      expect(button.text()).toBe(full)
      expect(button.attributes('aria-pressed')).toBe('true')
    }
  })

  it('opens the Control Center from a full-surface activation button behind the toolbar', async () => {
    const wrapper = mountBar()
    const hitArea = wrapper.get('[data-focus-control-centre]')

    // A real button, so Enter and Space activate it and assistive technology announces
    // it, and a sibling rather than a wrapper, so no control is nested inside it.
    expect(hitArea.element.tagName).toBe('BUTTON')
    expect(hitArea.attributes('type')).toBe('button')
    expect(hitArea.attributes('aria-label')).toBe('Open Settings')
    expect(hitArea.attributes('aria-expanded')).toBe('false')
    expect(hitArea.element.querySelector('button')).toBeNull()
    expect(hitArea.element.closest('button')).toBe(hitArea.element)

    await hitArea.trigger('click')
    expect(wrapper.emitted('open-control-centre')).toHaveLength(1)
  })

  it('reports the hub state on the opener so a returning user sees what it controls', async () => {
    const wrapper = mountBar(store(), { modalOpen: true })

    expect(wrapper.get('[data-focus-control-centre]').attributes('aria-expanded')).toBe('true')
    await wrapper.setProps({ modalOpen: false })
    expect(wrapper.get('[data-focus-control-centre]').attributes('aria-expanded')).toBe('false')
  })

  it('opens the Control Center from non-interactive regions of the bar', async () => {
    const wrapper = mountBar()

    await wrapper.get('.focus-bar').trigger('click')
    await wrapper.get('[data-focus-local-clock]').trigger('click')
    await wrapper.get('[data-focus-pomodoro-readout]').trigger('click')
    await wrapper.get('[data-focus-online]').trigger('click')

    expect(wrapper.emitted('open-control-centre')).toHaveLength(4)
  })

  it('never opens the Control Center from a control that owns its own action', async () => {
    const wrapper = mountBar()

    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-focus-game="hsr"]').trigger('click')
    await wrapper.get('[data-focus-pomodoro-start]').trigger('click')
    await wrapper.get('[data-focus-pomodoro-reset]').trigger('click')
    await wrapper.get('[data-phase-trigger]').trigger('click')
    await wrapper.get('[data-phase-select="break"]').trigger('click')

    expect(wrapper.emitted('open-control-centre')).toBeUndefined()
  })

  it('opens only Advanced Filters from the chevron, and closes it on a second press', async () => {
    const wrapper = mountBar()
    const chevron = wrapper.get('[data-advanced-trigger]')

    await chevron.trigger('click')
    expect(wrapper.find('[data-advanced-filters]').exists()).toBe(true)
    expect(wrapper.emitted('open-control-centre')).toBeUndefined()

    await chevron.trigger('click')
    expect(wrapper.find('[data-advanced-filters]').exists()).toBe(false)
    expect(wrapper.emitted('open-control-centre')).toBeUndefined()
  })

  it('keeps a press inside the disclosed filter panel out of the bar contract', async () => {
    const wrapper = mountBar()

    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-advanced-filters]').trigger('click')

    expect(wrapper.find('[data-advanced-filters]').exists()).toBe(true)
    expect(wrapper.emitted('open-control-centre')).toBeUndefined()
  })

  it('closes Advanced Filters on Escape without reopening the hub', async () => {
    const wrapper = mountBar()
    const chevron = wrapper.get('[data-advanced-trigger]')

    await chevron.trigger('click')
    await chevron.trigger('keydown', { key: 'Escape' })
    await nextTick()

    expect(wrapper.find('[data-advanced-filters]').exists()).toBe(false)
    expect(document.activeElement).toBe(chevron.element)
    expect(wrapper.emitted('open-control-centre')).toBeUndefined()
  })

  it('stands down while the hub owns the screen', async () => {
    const wrapper = mountBar()

    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-phase-trigger]').trigger('click')
    await wrapper.setProps({ modalOpen: true })

    // The modal is the topmost layer: its own Escape and outside-click handling owns
    // dismissal, so the bar's surfaces close rather than sit behind it.
    expect(wrapper.find('[data-advanced-filters]').exists()).toBe(false)
    expect(wrapper.find('[data-phase-menu]').exists()).toBe(false)

    await wrapper.get('.focus-bar').trigger('click')
    await wrapper.get('[data-focus-local-clock]').trigger('click')
    expect(wrapper.emitted('open-control-centre')).toBeUndefined()
  })
})
