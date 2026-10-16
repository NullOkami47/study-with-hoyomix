import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetAccountSession } from '../account/session'
import { createBackgroundStore } from '../backgrounds/store'
import { createFocusSessionRepository } from '../focus/localRepository'
import { createLocalLibraryRepository } from '../library/localRepository'
import { createPlaybackStore } from '../player/store'
import { createProviderPreferencesStore } from '../player/providerPreferences'
import { createPomodoroStore } from '../timers/pomodoro/store'
import { usePreferences } from '../../stores/preferences'
import type { Track } from '../catalog/types'
import type { PublicProviderState } from '../player/runtimeConfig'
import ControlCentre, { type ControlCentreSection } from './ControlCentre.vue'

const cleanups: Array<() => void> = []

/**
 * The hub is exercised with every provider effective, so the Music category renders the
 * full playback surface. LX-specific headings only exist while the Admin reports LX as
 * enabled, so a test that asserts the heading hierarchy must mount with this state.
 */
const ALL_PROVIDERS_ENABLED: PublicProviderState[] = [
  { id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 10 },
  { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 20 },
  { id: 'jellyfin', available: true, enabled: true, automaticEligible: true, priority: 30 },
]

const tracks: Track[] = [{
  id: 'dawn',
  title: 'Dawn Winery',
  aliases: {},
  games: ['genshin'],
  relationIds: [],
  tabs: ['focus'],
  workGroupId: 'dawn-work',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }],
}]

beforeEach(() => {
  window.localStorage.clear()
  resetAccountSession()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query === '(min-width: 48rem)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })))
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function mountHub(section: ControlCentreSection = 'focus', chatOpen = false, mobile = false) {
  if (mobile) vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
  const preferences = usePreferences()
  preferences.setLocale('en')
  preferences.setVisualStyle('cinematic')
  const pomodoroStore = createPomodoroStore({
    autoTick: false,
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
  const player = createPlaybackStore({ storage: { getItem: () => null, setItem: () => {} } })
  const library = createLocalLibraryRepository({ databaseName: `hub-${crypto.randomUUID()}` })
  const focusRepository = createFocusSessionRepository()
  const backgroundStore = createBackgroundStore({
    repository: {
      list: vi.fn().mockResolvedValue([]),
      getAccountSelection: vi.fn().mockResolvedValue(null),
      saveAccountSelection: vi.fn(async (selection) => selection),
    },
    storage: { getItem: () => null, setItem: () => undefined },
  })
  const wrapper = mount(ControlCentre, {
    attachTo: document.body,
    props: {
      open: true,
      section,
      preferences,
      pomodoroStore,
      player,
      library,
      focusRepository,
      backgroundStore,
      providerPreferences: createProviderPreferencesStore(),
      providerRepository: { states: vi.fn().mockResolvedValue(ALL_PROVIDERS_ENABLED) },
      tracks,
      focusSessions: [],
      timeZone: 'UTC',
      chatOpen,
    },
  })
  cleanups.push(() => {
    wrapper.unmount()
    pomodoroStore.destroy()
    library.destroy()
    backgroundStore.destroy()
  })
  return wrapper
}

describe('ControlCentre', () => {
  it('offers shared playback at the top without a duplicate catalogue search', async () => {
    const wrapper = mountHub('music')
    await flushPromises()
    expect(wrapper.find('[data-catalog-search]').exists()).toBe(false)
    const compact = wrapper.get('[data-compact-playback]')
    const settings = wrapper.get('[data-settings-section="playback"]')
    expect(compact.element.compareDocumentPosition(settings.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(compact.find('audio').exists()).toBe(false)
  })
  it('presents one centred modal with a title, a close control, and a labelled rail', async () => {
    const wrapper = mountHub()
    await flushPromises()

    const sheet = wrapper.get('[data-overlay-sheet="control-centre"]')
    expect(sheet.attributes('data-overlay-variant')).toBe('centre')
    expect(sheet.attributes('role')).toBe('dialog')
    expect(sheet.attributes('aria-modal')).toBe('true')
    const labelledBy = sheet.attributes('aria-labelledby')!
    expect(wrapper.get(`#${labelledBy}`).text()).toBe('Settings')
    expect(wrapper.get('[data-overlay-close]').attributes('aria-label')).toBe('Close panel')
    expect(wrapper.get('[data-control-centre-rail]').attributes('aria-label')).toBe('Settings sections')
    expect(wrapper.get('[data-control-centre-rail]').element.tagName).toBe('NAV')
    // Presentational backdrop; the sheet's capture-phase listeners are what make it modal.
    expect(wrapper.get('[data-overlay-backdrop]').attributes('aria-hidden')).toBe('true')
  })

  it('groups every desktop destination in the intended order', async () => {
    const wrapper = mountHub()
    await flushPromises()

    const rail = wrapper.findAll('[data-control-centre-desktop] [data-control-centre-nav]')
    expect(rail.map((item) => item.attributes('data-control-centre-nav'))).toEqual([
      'focus', 'calendar', 'library', 'music', 'chat',
      'account', 'appearance', 'application', 'about', 'privacy',
    ])
    expect(rail.map((item) => item.text())).toEqual([
      'Focus', 'Calendar', 'Library', 'Playback', 'Chat',
      'Account and sync', 'Appearance', 'Application', 'About', 'Privacy',
    ])
    expect(wrapper.findAll('[data-control-centre-group]').map((group) => [
      group.attributes('data-control-centre-group'),
      group.findAll('[data-control-centre-nav]').map((item) => item.attributes('data-control-centre-nav')),
    ])).toEqual([
      ['study', ['focus', 'calendar']],
      ['music', ['library', 'music']],
      ['social', ['chat']],
      ['settings', ['account', 'appearance', 'application']],
    ])
    expect(wrapper.findAll('[data-control-centre-footer] [data-control-centre-nav]').map((item) => item.attributes('data-control-centre-nav')))
      .toEqual(['about', 'privacy'])
    // Localised through the project's own i18n rather than transcribed from a reference.
    for (const item of rail) {
      expect(item.element.tagName).toBe('BUTTON')
      expect(item.attributes('aria-controls')).toBe(wrapper.get('[data-control-centre-panel]').attributes('id'))
    }
  })

  it('shows four primary mobile destinations and discloses all six secondary destinations', async () => {
    const wrapper = mountHub('focus', false, true)
    await flushPromises()

    expect(wrapper.findAll('[data-control-centre-mobile-primary] [data-control-centre-nav]').map((item) => item.attributes('data-control-centre-nav')))
      .toEqual(['focus', 'library', 'music', 'calendar'])
    const more = wrapper.get('[data-control-centre-more]')
    expect(more.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-control-centre-mobile-secondary]').exists()).toBe(false)
    await more.trigger('click')
    expect(more.attributes('aria-expanded')).toBe('true')
    expect(wrapper.findAll('[data-control-centre-mobile-secondary] [data-control-centre-nav]').map((item) => item.attributes('data-control-centre-nav')))
      .toEqual(['chat', 'account', 'appearance', 'application', 'about', 'privacy'])
    for (const id of ['chat', 'account', 'appearance', 'application', 'about', 'privacy']) {
      await wrapper.get(`[data-control-centre-mobile-secondary] [data-control-centre-nav="${id}"]`).trigger('click')
    }
    expect(wrapper.emitted('select')).toEqual([['chat'], ['account'], ['appearance'], ['application'], ['about'], ['privacy']])
  })

  it('marks More and its selected secondary destination as current without changing sections', async () => {
    const wrapper = mountHub('appearance', false, true)
    await flushPromises()

    const more = wrapper.get('[data-control-centre-more]')
    expect(more.attributes('aria-current')).toBe('true')
    expect(more.attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-control-centre-mobile-secondary] [data-control-centre-nav="appearance"]').attributes('aria-current'))
      .toBe('true')
    expect(wrapper.get('[data-control-centre-panel]').attributes('aria-label')).toBe('Appearance')
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('marks only the active category and renders only its panel', async () => {
    const wrapper = mountHub('library')
    await flushPromises()

    const current = wrapper.findAll('[data-control-centre-desktop] [data-control-centre-nav][aria-current="true"]')
    expect(current).toHaveLength(1)
    expect(current[0]?.attributes('data-control-centre-nav')).toBe('library')

    // One active view: the Library panel is here and no other category's content is.
    expect(wrapper.get('[data-control-centre-panel] [data-library-sheet]').element).toBeTruthy()
    expect(wrapper.find('[data-focus-calendar-list]').exists()).toBe(false)
    expect(wrapper.find('[data-control-centre-chat]').exists()).toBe(false)
    expect(wrapper.findAll('[data-settings-section]').map((section) => section.attributes('data-settings-section')))
      .toEqual(['library'])
  })

  it('requests a category change rather than owning which one is active', async () => {
    const wrapper = mountHub()
    await flushPromises()

    await wrapper.get('[data-control-centre-desktop] [data-control-centre-nav="privacy"]').trigger('click')

    expect(wrapper.emitted('select')).toEqual([['privacy']])
    // The section is a prop, so the workspace remains the single owner of the state that
    // outlives this modal.
    expect(wrapper.get('[data-control-centre-desktop] [data-control-centre-nav="focus"]').attributes('aria-current')).toBe('true')
  })

  it('renders each category as a view onto the shared settings model', async () => {
    for (const [section, expected] of [
      ['focus', ['pomodoro']],
      ['music', ['playback']],
      ['account', ['account']],
      ['appearance', ['language', 'appearance']],
      ['application', ['application']],
      ['about', ['about']],
      ['privacy', ['privacy']],
    ] as const) {
      const wrapper = mountHub(section)
      await flushPromises()

      expect(wrapper.findAll('[data-settings-section]').map((item) => item.attributes('data-settings-section')), section)
        .toEqual([...expected])
      // A category is a view, so the sheet's own index would be a second navigation.
      expect(wrapper.find('[data-settings-index]').exists(), section).toBe(false)
      expect(wrapper.get('[data-settings-sheet]').attributes('data-settings-scoped'), section).toBe('true')
      cleanups.pop()?.()
    }
  })

  it('owns playback diagnostics only in Music', async () => {
    for (const [section, expected] of [
      ['music', true],
      ['library', false],
      ['focus', false],
    ] as const) {
      const wrapper = mountHub(section)
      await flushPromises()

      expect(wrapper.find('[data-playback-diagnostics]').exists(), section).toBe(expected)
      if (section === 'music') {
        expect(wrapper.find('[data-settings-section="playback"]').exists()).toBe(true)
      }
      cleanups.pop()?.()
    }
  })

  it('renders playback settings before diagnostics with a semantic heading hierarchy', async () => {
    const wrapper = mountHub('music')
    await flushPromises()

    const panel = wrapper.get('[data-control-centre-panel]')
    const playbackSettings = panel.get('[data-settings-section="playback"]')
    const diagnostics = panel.get('[data-playback-diagnostics]')

    expect(playbackSettings.element.compareDocumentPosition(diagnostics.element)
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(panel.findAll('h3, h4').map((heading) => [heading.element.tagName, heading.text()])).toEqual([
      ['H3', 'No track selected'],
      ['H3', 'Music and playback'],
      ['H4', 'ChKSz API key'],
      ['H4', 'LX Music sources'],
      ['H3', 'Playback source'],
    ])
  })

  it('embeds Library and the calendar instead of launching a second modal', async () => {
    for (const [section, selector] of [
      ['library', '[data-library-sheet]'],
      ['calendar', 'table'],
    ] as const) {
      const wrapper = mountHub(section)
      await flushPromises()

      expect(wrapper.findAll('[role="dialog"]'), section).toHaveLength(1)
      expect(wrapper.get(`[data-control-centre-panel] ${selector}`).element, section).toBeTruthy()
      cleanups.pop()?.()
    }
  })

  it('offers the closed chat window a way back without mounting a second live chat', async () => {
    const wrapper = mountHub('chat', false)
    await flushPromises()

    expect(wrapper.find('[data-chat-window-state]').exists()).toBe(false)
    expect(wrapper.find('[data-control-centre-focus-chat]').exists()).toBe(false)
    await wrapper.get('[data-control-centre-open-chat]').trigger('click')
    expect(wrapper.emitted('open-chat')).toHaveLength(1)
    expect(wrapper.findAll('[data-chat-availability]')).toHaveLength(1)
  })

  it('offers to focus the open chat window rather than to open a second one', async () => {
    const wrapper = mountHub('chat', true)
    await flushPromises()

    expect(wrapper.get('[data-chat-window-state]').attributes('role')).toBe('status')
    expect(wrapper.find('[data-control-centre-open-chat]').exists()).toBe(false)
    await wrapper.get('[data-control-centre-focus-chat]').trigger('click')
    expect(wrapper.emitted('focus-chat')).toHaveLength(1)
  })

  it('starts each panel at its top rather than inheriting the last one\'s scroll', async () => {
    const wrapper = mountHub()
    await flushPromises()

    const panel = wrapper.get('[data-control-centre-panel]')
    panel.element.scrollTop = 240
    await wrapper.setProps({ section: 'privacy' })
    await flushPromises()

    expect(panel.element.scrollTop).toBe(0)
    expect(panel.attributes('role')).toBe('region')
    // A real tab stop, not tabindex="-1". The panel is the hub's scroll container, and
    // Privacy and About are prose with no focusable descendant to scroll it by, so at "-1" a
    // keyboard-only user could not reach the rest of either category. Proven in a browser at
    // tests/e2e-accessibility/accessibility.spec.ts, where axe reports the "-1" version as
    // scrollable-region-focusable.
    expect(panel.attributes('tabindex')).toBe('0')
  })

  /**
   * A panel command that switches category unmounts the button that was pressed -- Focus
   * offers "open calendar", and that is exactly what it does. Focus then falls outside the
   * hub, where the sheet no longer sees Escape and the keyboard user is stuck in a modal
   * they cannot close. Rescued to the panel; and only when it was genuinely lost, so a rail
   * press keeps focus on the rail item the user is arrowing through.
   */
  it('rescues focus to the panel when a category switch unmounts the focused control', async () => {
    const wrapper = mountHub('focus')
    await flushPromises()

    const command = wrapper.get('[data-testid="focus-open-calendar"]')
    ;(command.element as HTMLElement).focus()
    expect(document.activeElement).toBe(command.element)

    await wrapper.setProps({ section: 'calendar' })
    await flushPromises()

    const panel = wrapper.get('[data-control-centre-panel]')
    expect(document.activeElement).toBe(panel.element)

    // A rail press, by contrast, leaves focus where the user put it.
    const rail = wrapper.get('[data-control-centre-desktop] [data-control-centre-nav="privacy"]')
    ;(rail.element as HTMLElement).focus()
    await wrapper.setProps({ section: 'privacy' })
    await flushPromises()
    expect(document.activeElement).toBe(rail.element)
  })

  it('closes from its own control and lets the workspace own the open state', async () => {
    const wrapper = mountHub()
    await flushPromises()

    await wrapper.get('[data-overlay-close]').trigger('click')

    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.get('[data-overlay-sheet="control-centre"]').element).toBeTruthy()
  })

  it('returns focus to More when its focused secondary control is removed', async () => {
    const wrapper = mountHub('appearance', false, true)
    await flushPromises()
    const item = wrapper.get('[data-control-centre-nav="appearance"]')
    ;(item.element as HTMLElement).focus()
    await wrapper.get('[data-control-centre-more]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-control-centre-mobile-secondary]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-control-centre-more]').element)
    expect(wrapper.get('[data-control-centre-more]').attributes('aria-current')).toBe('true')
  })
})
