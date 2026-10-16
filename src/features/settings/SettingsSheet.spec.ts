import { flushPromises, mount } from '@vue/test-utils'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createLocalLibraryRepository } from '../library/localRepository'
import { createFocusSessionRepository } from '../focus/localRepository'
import { createPlaybackStore } from '../player/store'
import { createChkszCredentialStore, type ChkszCredentialStore } from '../player/chkszCredentialStore'
import {
  createProviderPreferencesStore,
  type ProviderPreferencesStore,
} from '../player/providerPreferences'
import {
  CHKSZ_QUALITIES,
  LX_QUALITIES,
  createPlaybackQualityPreferencesStore,
  type PlaybackQualityPreferencesStore,
} from '../player/qualityPreferences'
import { createLxSourceRepository } from '../player/lx/sourceRepository'
import type { LxSourceRepository } from '../player/lx/types'
import type { PublicProviderState } from '../player/runtimeConfig'
import { createPomodoroStore } from '../timers/pomodoro/store'
import { createBackgroundStore } from '../backgrounds/store'
import { resetAccountSession } from '../account/session'
import type { SettingsSectionId } from './sections'
import { PREFERENCES_STORAGE_KEY, usePreferences } from '../../stores/preferences'
import SettingsSheet from './SettingsSheet.vue'

const cleanups: Array<() => void> = []

beforeEach(() => {
  window.localStorage.clear()
  // The session is shared across the app, so it outlives a component. Without this a test
  // that signs in would hand the next one an authenticated user it never asked for.
  resetAccountSession()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: false,
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
})

function mountSettings(
  focusHistoryStatus?: 'storage_error' | 'pending_overflow' | 'overflow_full',
  chkszCredentials?: ChkszCredentialStore,
  providerOptions: {
    providerPreferences?: ProviderPreferencesStore
    providerStates?: PublicProviderState[]
    qualityPreferences?: PlaybackQualityPreferencesStore
    lxSourceRepository?: LxSourceRepository
  } = {},
  // The Control Center renders one category at a time, so a section list is how a test
  // reproduces what a user actually sees. Omitted means every section, as before.
  sections?: SettingsSectionId[],
) {
  const preferences = usePreferences()
  preferences.setLocale('en')
  preferences.setLowPower(false)
  preferences.setBackgroundMode('ambient')
  preferences.setVisualStyle('cinematic')
  preferences.setStudioBlur(16)
  preferences.setStudyTipsEnabled(true)
  let currentTime = 0
  const pomodoroStore = createPomodoroStore({
    autoTick: false,
    clock: { now: () => currentTime },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  })
  const player = createPlaybackStore({ storage: { getItem: () => null, setItem: () => {} } })
  const library = createLocalLibraryRepository({ databaseName: `settings-${crypto.randomUUID()}` })
  const focusRepository = createFocusSessionRepository()
  const backgroundStore = createBackgroundStore({
    repository: {
      list: vi.fn().mockResolvedValue([]),
      getAccountSelection: vi.fn().mockResolvedValue(null),
      saveAccountSelection: vi.fn(async (selection) => selection),
    },
    storage: { getItem: () => null, setItem: () => undefined },
  })
  // A fresh real repository per mount, so one test's imported sources never leak into the
  // next. IndexedDB itself is faked; the repository, hashing and validation are real.
  const lxSourceRepository = providerOptions.lxSourceRepository ?? createLxSourceRepository({
    indexedDB: new IDBFactory(),
    databaseName: `settings-lx-${crypto.randomUUID()}`,
  })
  // The sheet re-reads this on mount and whenever the document becomes visible, so a
  // test can model an Admin changing the provider state mid-session by swapping the
  // resolved value and dispatching a visibilitychange.
  const providerStatesMock = vi.fn().mockResolvedValue(providerOptions.providerStates ?? [])
  const wrapper = mount(SettingsSheet, {
    props: {
      preferences,
      pomodoroStore,
      player,
      library,
      focusRepository,
      focusHistoryStatus,
      backgroundStore,
      chkszCredentials,
      providerPreferences: providerOptions.providerPreferences,
      qualityPreferences: providerOptions.qualityPreferences,
      lxSourceRepository,
      providerRepository: { states: providerStatesMock },
      sections,
    },
  })
  cleanups.push(() => {
    wrapper.unmount()
    pomodoroStore.destroy()
    library.destroy()
    backgroundStore.destroy()
  })
  return {
    wrapper,
    preferences,
    pomodoroStore,
    player,
    library,
    focusRepository,
    backgroundStore,
    lxSourceRepository,
    providerStatesMock,
    setProviderStates(states: PublicProviderState[]) {
      providerStatesMock.mockResolvedValue(states)
    },
    advancePomodoro(milliseconds: number) {
      currentTime += milliseconds
      pomodoroStore.tick()
    },
  }
}

/**
 * Authoritative `GET /api/providers/config` state with every canonical provider
 * available and enabled. LX-only surfaces are gated on the server reporting LX as
 * both, so any test that expects an LX control must mount with this.
 */
const allProvidersEnabled = (): PublicProviderState[] => ([
  { id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 10 },
  { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 20 },
  { id: 'jellyfin', available: true, enabled: true, automaticEligible: true, priority: 30 },
])

/** The same state with LX turned off by the administrator, as `enabled: false`. */
const providersWithLxDisabled = (): PublicProviderState[] =>
  allProvidersEnabled().map((state) =>
    state.id === 'lx' ? { ...state, enabled: false, automaticEligible: false } : state)

describe('SettingsSheet', () => {
  it('saves a masked ChKSz key session-only by default and clears it explicitly', async () => {
    const credentials = createChkszCredentialStore({ storage: window.localStorage })
    const { wrapper } = mountSettings(undefined, credentials)
    await flushPromises()

    const field = wrapper.get('[data-settings-chksz-key]')
    expect(field.attributes('type')).toBe('password')
    expect((wrapper.get('[data-settings-chksz-remember]').element as HTMLInputElement).checked).toBe(false)
    await field.setValue('chksz_USER_KEY_SENTINEL')
    await wrapper.get('[data-settings-chksz]').trigger('submit')
    await wrapper.get('[data-agreement-check]').setValue(true)
    await wrapper.get('[data-agreement-accept]').trigger('click')
    await flushPromises()
    expect(credentials.key()).toBe('chksz_USER_KEY_SENTINEL')
    expect(credentials.remember()).toBe(false)
    expect(window.localStorage.getItem('study-with-hoyomix:chksz-credential:v1')).toBeNull()
    expect(wrapper.get('[data-settings-chksz-status]').text()).toContain('session')

    await wrapper.get('[data-settings-chksz-clear]').trigger('click')
    expect(credentials.key()).toBeNull()
    expect((field.element as HTMLInputElement).value).toBe('')
  })

  it('rejects an API key containing unsupported characters with specific localized guidance and without modifying credentials', async () => {
    const credentials = createChkszCredentialStore({ storage: window.localStorage })
    credentials.setKey('chksz_EXISTING_VALID_KEY', false)
    const { wrapper } = mountSettings(undefined, credentials)
    await flushPromises()

    const field = wrapper.get('[data-settings-chksz-key]')
    await field.setValue('abc\u200Bdef')
    await wrapper.get('[data-settings-chksz]').trigger('submit')

    // Stored credential must NOT be modified
    expect(credentials.key()).toBe('chksz_EXISTING_VALID_KEY')
    const statusText = wrapper.get('[data-settings-chksz-status]').text()
    expect(statusText).toBe('The API key contains unsupported characters. Paste only the raw API key.')
    expect(statusText).not.toContain('saved')
    expect(statusText).not.toContain('abc')
  })

  it('rejects an empty API key without modifying credentials', async () => {
    const credentials = createChkszCredentialStore({ storage: window.localStorage })
    const { wrapper } = mountSettings(undefined, credentials)
    await flushPromises()

    const field = wrapper.get('[data-settings-chksz-key]')
    await field.setValue('   ')
    await wrapper.get('[data-settings-chksz]').trigger('submit')

    expect(credentials.key()).toBeNull()
    expect(wrapper.get('[data-settings-chksz-status]').text()).toBe('Enter a valid ChKSz API key.')
  })

  it('distinguishes direct playback credentials from server-assisted discovery', async () => {
    const { wrapper } = mountSettings()
    await flushPromises()

    const form = wrapper.get('[data-settings-chksz]')
    const disclosure = form.text()
    expect(disclosure).toContain('api.chksz.com')
    expect(disclosure).toMatch(/discovery may send it to this site/iu)
    expect(disclosure).toMatch(/Remember/u)
    expect(form.find('[data-settings-chksz-devtools-notice]').exists()).toBe(true)
    expect(form.get('[data-settings-chksz-devtools-notice]').text()).toMatch(/DevTools/iu)
    // The disclosure describes handling only, never a value.
    expect(disclosure).not.toMatch(/chksz_[A-Za-z0-9]/u)
  })

  it('explains the required chksz_ prefix without echoing the entered value', async () => {
    const credentials = createChkszCredentialStore({ storage: window.localStorage })
    const { wrapper } = mountSettings(undefined, credentials)
    await flushPromises()

    await wrapper.get('[data-settings-chksz-key]').setValue('abc123')
    await wrapper.get('[data-settings-chksz]').trigger('submit')

    const status = wrapper.get('[data-settings-chksz-status]').text()
    expect(status).toBe('ChKSz API keys begin with chksz_.')
    expect(status).not.toContain('abc123')
    expect(credentials.key()).toBeNull()
  })
  it('makes every ordinary settings area reachable from one labelled surface even when accounts are unavailable', async () => {
    const { wrapper } = mountSettings()
    await flushPromises()

    expect(wrapper.findAll('[data-settings-section]').map((section) => section.attributes('data-settings-section'))).toEqual([
      'language', 'appearance', 'pomodoro', 'playback', 'library', 'account', 'application', 'about', 'privacy',
    ])
    expect(wrapper.findAll('[data-settings-index] a')).toHaveLength(9)
    expect(wrapper.get('[data-account-section] [role="status"]').text()).toContain('unavailable')
    expect(wrapper.get('[data-settings-section="pomodoro"] input').element).toBeTruthy()
    expect(wrapper.get('[data-settings-section="pomodoro"] [data-focus-history-controls]').element)
      .toBeTruthy()
    expect(wrapper.get('[data-settings-section="playback"] input[type="range"]').element).toBeTruthy()
    expect(wrapper.get('[data-settings-section="library"] input[type="checkbox"]').element).toBeTruthy()
    expect(wrapper.get('[data-settings-section="appearance"] [data-background-gallery]').element).toBeTruthy()
    expect(wrapper.find('[data-background-sync]').exists()).toBe(false)
  })

  it('hides Liquid Glass controls until that style is selected', async () => {
    const { wrapper } = mountSettings()
    expect(wrapper.find('[data-settings-studio-blur]').exists()).toBe(false)
    expect(wrapper.find('[data-settings-studio-glass-gray]').exists()).toBe(false)
    expect(wrapper.find('[data-settings-studio-edge]').exists()).toBe(false)

    await wrapper.get('[data-settings-visual-style]').setValue('studio')
    expect(wrapper.find('[data-settings-studio-blur]').exists()).toBe(true)
    expect(wrapper.find('[data-settings-studio-glass-gray]').exists()).toBe(true)
    expect(wrapper.find('[data-settings-studio-edge]').exists()).toBe(true)

    await wrapper.get('[data-settings-visual-style]').setValue('cinematic')
    expect(wrapper.find('[data-settings-studio-blur]').exists()).toBe(false)
    expect(wrapper.find('[data-settings-studio-edge]').exists()).toBe(false)
  })

  it('writes settings through the injected production contracts rather than parallel state', async () => {
    const { wrapper, preferences, pomodoroStore, player, library } = mountSettings()
    await flushPromises()

    await wrapper.get('[data-settings-locale]').setValue('zh-Hant')
    expect(wrapper.find('[data-settings-low-power]').exists()).toBe(false)
    expect(wrapper.find('[data-settings-reduced-motion]').exists()).toBe(false)
    await wrapper.get('[data-settings-background]').setValue('still')
    await wrapper.get('[data-settings-visual-style]').setValue('studio')
    await wrapper.get('[data-settings-studio-blur]').setValue('22')
    await wrapper.get('[data-settings-studio-glass-gray]').setValue('58')
    await wrapper.get('[data-settings-studio-edge]').setValue('80')
    await wrapper.get('[data-settings-focus]').setValue('30')
    await wrapper.get('[data-settings-short-break]').setValue('7')
    await wrapper.get('[data-settings-long-break]').setValue('20')
    await wrapper.get('[data-settings-cycles]').setValue('3')
    await wrapper.get('[data-settings-pause-music]').setValue(false)
    await wrapper.get('[data-settings-focus-behaviour]').setValue('pauseWhenHidden')
    await wrapper.get('[data-settings-volume]').setValue('0.4')
    await wrapper.get('[data-settings-history]').setValue(true)
    await wrapper.get('[data-settings-study-tips]').setValue(false)
    await flushPromises()

    expect(preferences.locale.value).toBe('zh-Hant')
    expect(preferences.lowPower.value).toBe(false)
    expect(preferences.backgroundMode.value).toBe('still')
    expect(preferences.visualStyle.value).toBe('studio')
    expect(preferences.studioBlur.value).toBe(22)
    expect(preferences.studioGlassGray.value).toBe(58)
    expect(preferences.studioEdge.value).toBe(80)
    expect(wrapper.get('[data-settings-studio-glass-gray-output]').text()).toBe('58%')
    expect(wrapper.get('[data-settings-studio-edge-output]').text()).toBe('80%')
    expect(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)).toContain('"visualStyle":"studio"')
    expect(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)).toContain('"studioBlur":22')
    expect(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)).toContain('"studioGlassGray":58')
    expect(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)).toContain('"studioEdge":80')
    expect(pomodoroStore.focusMinutes.value).toBe(30)
    expect(pomodoroStore.breakMinutes.value).toBe(7)
    expect(pomodoroStore.longBreakMinutes.value).toBe(20)
    expect(pomodoroStore.cycleCount.value).toBe(3)
    expect(pomodoroStore.pauseMusicDuringBreak.value).toBe(false)
    expect(pomodoroStore.focusBehaviour.value).toBe('pauseWhenHidden')
    expect(player.volume.value).toBe(0.4)
    expect((await library.exportLocalLibrary()).preferences.historyEnabled).toBe(true)
    expect(preferences.studyTipsEnabled.value).toBe(false)
  })

  it('routes favourites, playlists, queue, and per-track source work to the shared Library sheet', async () => {
    const { wrapper } = mountSettings()

    await wrapper.get('[data-settings-open-library]').trigger('click')

    expect(wrapper.emitted('open-library')).toHaveLength(1)
  })

  it('reaches About from the index and states licence, lineage and unresolved provenance', () => {
    const { wrapper } = mountSettings()

    // Persistently reachable: the index entry is what the dismissed first-visit notice points at.
    expect(wrapper.get('[data-settings-index] a[href="#settings-about"]').text()).toBe('About this project')
    const about = wrapper.get('[data-settings-section="about"]')
    expect(about.get('h3').text()).toBe('About this project')
    expect(about.findAll('h4').map((heading) => heading.text()))
      .toEqual(['Licence', 'Source and attribution', 'Music and artwork'])
    expect(about.get('[data-about-licence]').text()).toContain('GPL-3.0')
    expect(about.get('[data-about-lineage]').text()).toContain('StudyWithMiku')
    expect(about.get('[data-about-liquid-glass]').text()).toContain('MIT License')
    expect(about.get('[data-about-unofficial]').text()).toContain('not affiliated with HoYoverse')
    expect(about.get('[data-about-identity]').text()).toContain('Study with HOYO-MiX')
    expect(about.findAll('a').map(link => link.attributes('href'))).toContain('https://github.com/shshouse/StudyWithMiku')
    for (const link of about.findAll('a')) {
      expect(link.attributes('target')).toBe('_blank')
      expect(link.attributes('rel')).toBe('noopener noreferrer')
      expect(link.text()).toContain('opens in a new tab')
    }
    expect(about.get('[data-about-provenance-open]').text()).toContain('not reviewed')
  })

  it('reaches Privacy from the index and describes the implemented data behaviour', () => {
    const { wrapper } = mountSettings()

    expect(wrapper.get('[data-settings-index] a[href="#settings-privacy"]').text()).toBe('Privacy')
    const privacy = wrapper.get('[data-settings-section="privacy"]')
    expect(privacy.get('h3').text()).toBe('Privacy')
    expect(privacy.findAll('h4').map((heading) => heading.text()))
      .toEqual(['On this device', 'Signing in', 'Automatic synchronisation', 'Music providers', 'Your data', 'Analytics and service logs'])
    expect(privacy.get('[data-privacy-account]').text()).toContain('public email')
    expect(privacy.get('[data-privacy-session]').text()).toContain('90 days')
    expect(privacy.get('[data-privacy-provider-key]').text()).toContain('never synced to your account')
    expect(privacy.get('[data-privacy-operator-keys]').text()).toContain('not your credential')
    expect(privacy.get('[data-privacy-media-urls]').text()).toContain('not saved as part of your account data')
    expect(privacy.get('[data-privacy-analytics-state]').text()).toContain('no analytics script')
    expect(privacy.get('[data-privacy-analytics]').text()).toContain('logs')
    expect(privacy.get('[data-privacy-provider-sync]').text()).toContain('automatically')
    // Application now includes the public announcement list as an additional surface.
    const application = wrapper.get('[data-settings-section="application"]')
    expect(application.find('[data-settings-notice-history]').exists()).toBe(true)
    expect(application.text()).toContain('All currently published announcements')
  })

  it('discloses enabled analytics when the built page contains the configured tag', () => {
    const script = document.createElement('script')
    script.dataset.websiteId = 'test-configured-analytics'
    document.head.append(script)
    try {
      const { wrapper } = mountSettings(undefined, undefined, {}, ['privacy'])
      const state = wrapper.get('[data-privacy-analytics-state]')
      expect(state.attributes('data-analytics-enabled')).toBe('true')
      expect(state.text()).toContain('An analytics script is enabled')
      expect(state.text()).not.toContain('no analytics script')
    } finally {
      script.remove()
    }
  })

  it('routes the local Focus calendar from the existing Pomodoro settings section', async () => {
    const { wrapper } = mountSettings('pending_overflow')

    expect(wrapper.findAll('[data-settings-section]')).toHaveLength(9)
    expect(wrapper.get('[data-focus-history-status]').text()).toMatch(/recoverable/iu)
    await wrapper.get('[data-testid="focus-open-calendar"]').trigger('click')

    expect(wrapper.emitted('open-calendar')).toHaveLength(1)
  })

  /**
   * A category is rendered on its own, so the sync controls cannot depend on the account
   * view being mounted beside them. It used to: the signed-in flag arrived as an event from
   * AccountMenu, which the Control Center only mounts in the Account category, so a signed-in
   * user who opened Appearance was shown the anonymous gallery and could not sync at all.
   */
  it('does not reintroduce manual sync in categories rendered without Account', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') {
        return new Response(JSON.stringify({
          user: { id: 'user-1', displayName: 'Reader', avatarUrl: null, role: 'user' },
          identities: ['google'],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchImpl)

    for (const [section, control] of [
      ['appearance', '[data-background-sync]'],
      ['pomodoro', '[data-testid="focus-sync"]'],
    ] as const) {
      resetAccountSession()
      const { wrapper } = mountSettings(undefined, undefined, {}, [section])
      await flushPromises()

      expect(wrapper.findAll('[data-account-section]'), section).toHaveLength(0)
      expect(wrapper.find(control).exists(), section).toBe(false)
      cleanups.pop()?.()
    }
  })

  it('keeps manual sync absent before and after authenticated logout', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') {
        return new Response(JSON.stringify({
          user: { id: 'user-1', displayName: 'Reader', avatarUrl: null, role: 'user' },
          identities: ['google'],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(null, { status: 204 })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const { wrapper } = mountSettings()
    await flushPromises()

    expect(wrapper.find('[data-testid="focus-sync"]').exists()).toBe(false)
    expect(wrapper.find('[data-background-sync]').exists()).toBe(false)

    await wrapper.get('[data-account-section] .account-menu__actions button').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="focus-sync"]').exists()).toBe(false)
    expect(wrapper.find('[data-background-sync]').exists()).toBe(false)
    expect(fetchImpl).toHaveBeenCalledWith('/api/logout', { method: 'POST' })
  })

  it('does not create a second Focus sync lifecycle inside Settings', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') {
        return new Response(JSON.stringify({
          user: { id: 'user-1', displayName: 'Reader', avatarUrl: null, role: 'user' },
          identities: ['google'],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(null, { status: 500 })
    })
    vi.stubGlobal('fetch', fetchImpl)
    const { wrapper, pomodoroStore, advancePomodoro } = mountSettings()
    await flushPromises()
    pomodoroStore.setFocusMinutes(1)
    pomodoroStore.start()

    advancePomodoro(60_000)
    await flushPromises()

    expect(wrapper.find('[data-testid="focus-sync"]').exists()).toBe(false)
    expect(fetchImpl.mock.calls.filter(([input]) => String(input) === '/api/focus-sessions')).toEqual([])
  })

  describe('Playback provider surface', () => {
    const state = (
      id: string,
      overrides: Partial<PublicProviderState> = {},
    ): PublicProviderState => ({
      id: id as PublicProviderState['id'],
      available: true,
      enabled: true,
      automaticEligible: true,
      priority: 1,
      ...overrides,
    })

    const allAvailable = allProvidersEnabled

    const RETIRED_PROVIDER_IDS = [
      'r2', 'meting', 'piped', 'invidious', 'gd-studio', 'qijie', 'huanyin',
      'lx-huibq', 'lx-ikun', 'lx-juhe', 'lx-qdy', 'lx-flower', 'lx-lx', 'lx-grass', 'lx-sixyin',
    ]

    it('lists exactly the three top-level providers in canonical automatic order', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: allAvailable(),
      })
      await flushPromises()

      const rows = wrapper.findAll('[data-settings-source]')
      expect(rows.map((row) => row.attributes('data-settings-source')))
        .toEqual(['chksz', 'lx', 'jellyfin'])
      expect(rows.map((row) => row.get('span').text()))
        .toEqual(['ChKSz BYOK', 'LX Music', 'Jellyfin'])
    })

    it('no longer offers a retired legacy provider or an individual LX endpoint', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: allAvailable(),
      })
      await flushPromises()

      for (const id of RETIRED_PROVIDER_IDS) {
        expect(wrapper.find(`[data-settings-source="${id}"]`).exists(), id).toBe(false)
      }
      const surface = wrapper.get('[data-settings-section="playback"]').text()
      for (const label of ['Meting', 'Piped', 'Invidious', 'LX-Huibq', 'LX-QDY', 'LX-SixYin']) {
        expect(surface, label).not.toContain(label)
      }
    })

    it('explains that the administrator owns provider order and that users only opt out', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: allAvailable(),
      })
      await flushPromises()

      expect(wrapper.get('[data-settings-provider-order]').text())
        .toMatch(/administrator/iu)
      const limits = wrapper.get('[data-settings-provider-limits]').text()
      expect(limits).toMatch(/cannot reorder/iu)
      expect(limits).toMatch(/cannot turn on/iu)
      expect(limits).toMatch(/disabled by the administrator|administrator has disabled/iu)
    })

    it('never exposes a reorder or priority control to the user', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: allAvailable(),
      })
      await flushPromises()

      const sources = wrapper.get('[data-settings-automatic-sources]')
      expect(sources.findAll('input[type="number"]')).toHaveLength(0)
      expect(sources.findAll('select')).toHaveLength(0)
      expect(sources.findAll('button')).toHaveLength(0)
      expect(sources.text()).not.toMatch(/priority/iu)
    })

    it('starts checked and disables a provider through the shared store', async () => {
      const providerPreferences = createProviderPreferencesStore({
        storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      })
      const { wrapper } = mountSettings(undefined, undefined, {
        providerPreferences,
        providerStates: allAvailable(),
      })
      await flushPromises()

      const toggle = wrapper.get('[data-settings-source="lx"] input')
      expect((toggle.element as HTMLInputElement).checked).toBe(true)

      await toggle.setValue(false)

      expect(providerPreferences.isDisabled('lx')).toBe(true)
      expect((wrapper.get('[data-settings-source="lx"] input').element as HTMLInputElement).checked)
        .toBe(false)
    })

    it('re-enables a provider the user previously disabled', async () => {
      const providerPreferences = createProviderPreferencesStore({
        storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      })
      providerPreferences.setDisabled('jellyfin', true)
      const { wrapper } = mountSettings(undefined, undefined, {
        providerPreferences,
        providerStates: allAvailable(),
      })
      await flushPromises()

      const toggle = wrapper.get('[data-settings-source="jellyfin"] input')
      expect((toggle.element as HTMLInputElement).checked).toBe(false)

      await toggle.setValue(true)

      expect(providerPreferences.isDisabled('jellyfin')).toBe(false)
    })

    it('shows an unavailable provider truthfully and refuses to toggle it', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: [
          state('chksz'),
          state('jellyfin', { available: false, enabled: false, automaticEligible: false }),
        ],
      })
      await flushPromises()

      const row = wrapper.get('[data-settings-source="jellyfin"]')
      expect(row.get('[data-settings-source-state]').attributes('data-settings-source-state'))
        .toBe('unavailable')
      expect(row.text()).toMatch(/unavailable/iu)
      expect((row.get('input').element as HTMLInputElement).disabled).toBe(true)
    })

    it('distinguishes an administrator-disabled provider from an unavailable one', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: [
          state('chksz'),
          state('jellyfin', { enabled: false, automaticEligible: false }),
        ],
      })
      await flushPromises()

      const row = wrapper.get('[data-settings-source="jellyfin"]')
      expect(row.get('[data-settings-source-state]').attributes('data-settings-source-state'))
        .toBe('admin-disabled')
      expect((row.get('input').element as HTMLInputElement).disabled).toBe(false)
    })

    it('treats every remaining provider as unavailable when server state cannot be read', async () => {
      const { wrapper } = mountSettings(undefined, undefined, { providerStates: [] })
      await flushPromises()

      // LX is gated on the authoritative state and fails closed, so an unreadable
      // configuration removes it. ChKSz and Jellyfin keep their truthful, disabled rows.
      expect(wrapper.findAll('[data-settings-source]').map((row) => row.attributes('data-settings-source')))
        .toEqual(['chksz', 'jellyfin'])
      const rows = wrapper.findAll('[data-settings-source] input')
      expect(rows).toHaveLength(2)
      expect(rows.every((row) => (row.element as HTMLInputElement).disabled)).toBe(true)
    })

    it('describes local-only scope while anonymous', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: allAvailable(),
      })
      await flushPromises()

      expect(wrapper.get('[data-settings-automatic-sources-scope]').text())
        .toMatch(/this browser only/iu)
    })

    it('keeps the ChKSz key form separate from the provider toggles', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: allAvailable(),
      })
      await flushPromises()

      expect(wrapper.get('[data-settings-automatic-sources]').find('[data-settings-chksz-key]').exists())
        .toBe(false)
      expect(wrapper.get('[data-settings-chksz]').find('[data-settings-source]').exists()).toBe(false)
    })

    it('offers no Jellyfin credential or token field', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: allAvailable(),
      })
      await flushPromises()

      // The only secret field in Playback is the ChKSz key, and it lives in its own form.
      const playback = wrapper.get('[data-settings-section="playback"]')
      expect(playback.findAll('input[type="password"]')).toHaveLength(1)
      expect(wrapper.get('[data-settings-chksz]').find('input[type="password"]').exists()).toBe(true)

      const jellyfin = wrapper.get('[data-settings-source="jellyfin"]')
      expect(jellyfin.findAll('input')).toHaveLength(1)
      expect(jellyfin.find('input[type="checkbox"]').exists()).toBe(true)
    })
  })

  describe('Playback quality', () => {
    const qualityOptions = (wrapper: ReturnType<typeof mountSettings>['wrapper'], id: string): string[] =>
      wrapper.get(`[data-settings-${id}-quality]`).findAll('option').map((option) => option.text())

    const qualityValues = (wrapper: ReturnType<typeof mountSettings>['wrapper'], id: string): string[] =>
      wrapper.get(`[data-settings-${id}-quality]`).findAll('option').map((option) => (option.element as HTMLOptionElement).value)

    it('exposes exactly seven native quality options for ChKSz and four for LX with correct values and labels', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: allProvidersEnabled(),
      })
      await flushPromises()

      expect(qualityValues(wrapper, 'chksz')).toEqual([...CHKSZ_QUALITIES])
      expect(qualityOptions(wrapper, 'chksz')).toEqual([
        'Standard',
        'Extreme High',
        'Lossless',
        'Hi-Res',
        'JY Effect',
        'Sky',
        'JY Master',
      ])

      expect(qualityValues(wrapper, 'lx')).toEqual([...LX_QUALITIES])
      expect(qualityOptions(wrapper, 'lx')).toEqual(['Standard', 'High', 'Lossless', 'Hi-Res'])

      expect(qualityValues(wrapper, 'lx')).not.toContain('exhigh')
      expect(qualityValues(wrapper, 'lx')).not.toContain('jyeffect')
      expect(qualityValues(wrapper, 'lx')).not.toContain('sky')
      expect(qualityValues(wrapper, 'lx')).not.toContain('jymaster')
      expect(qualityValues(wrapper, 'chksz')).not.toContain('high')
    })

    it('localizes quality options correctly for zh-Hant and zh-Hans', async () => {
      const { wrapper, preferences } = mountSettings(undefined, undefined, {
        providerStates: allProvidersEnabled(),
      })
      await flushPromises()

      preferences.setLocale('zh-Hant')
      await flushPromises()
      expect(qualityOptions(wrapper, 'chksz')).toEqual([
        '標準',
        '極高音質',
        '無損',
        'Hi-Res',
        'JY Effect',
        'Sky',
        'JY Master',
      ])
      expect(qualityOptions(wrapper, 'lx')).toEqual(['標準', '高音質', '無損', 'Hi-Res'])

      preferences.setLocale('zh-Hans')
      await flushPromises()
      expect(qualityOptions(wrapper, 'chksz')).toEqual([
        '标准',
        '极高音质',
        '无损',
        'Hi-Res',
        'JY Effect',
        'Sky',
        'JY Master',
      ])
      expect(qualityOptions(wrapper, 'lx')).toEqual(['标准', '高音质', '无损', 'Hi-Res'])
    })

    it('shows the stored quality and writes a ChKSz change through the shared store', async () => {
      const qualityPreferences = createPlaybackQualityPreferencesStore({
        storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      })
      qualityPreferences.setChkszQuality('lossless')
      const { wrapper } = mountSettings(undefined, undefined, { qualityPreferences })
      await flushPromises()

      const select = wrapper.get('[data-settings-chksz-quality]')
      expect((select.element as HTMLSelectElement).value).toBe('lossless')

      await select.setValue('jymaster')

      expect(qualityPreferences.chkszQuality()).toBe('jymaster')
      expect((wrapper.get('[data-settings-chksz-quality]').element as HTMLSelectElement).value)
        .toBe('jymaster')
    })

    it('writes an LX change through the shared store without touching ChKSz', async () => {
      const qualityPreferences = createPlaybackQualityPreferencesStore({
        storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      })
      const { wrapper } = mountSettings(undefined, undefined, {
        qualityPreferences,
        providerStates: allProvidersEnabled(),
      })
      await flushPromises()

      await wrapper.get('[data-settings-lx-quality]').setValue('high')

      expect(qualityPreferences.lxQuality()).toBe('high')
      expect(qualityPreferences.chkszQuality()).toBe('standard')
      expect((wrapper.get('[data-settings-lx-quality]').element as HTMLSelectElement).value).toBe('high')
    })

    it('keeps the quality selectors inside the Playback section, not the provider toggles', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: allProvidersEnabled(),
      })
      await flushPromises()

      const sources = wrapper.get('[data-settings-automatic-sources]')
      expect(sources.find('[data-settings-chksz-quality]').exists()).toBe(false)
      expect(sources.find('[data-settings-lx-quality]').exists()).toBe(false)
      expect(wrapper.find('[data-settings-section="playback"] [data-settings-chksz-quality]').exists())
        .toBe(true)
    })

    it('hands the injected LX source repository and the active locale to the source manager', async () => {
      const lxSourceRepository = createLxSourceRepository({
        indexedDB: new IDBFactory(),
        databaseName: `settings-lx-${crypto.randomUUID()}`,
      })
      const { wrapper } = mountSettings(undefined, undefined, {
        lxSourceRepository,
        providerStates: allProvidersEnabled(),
      })
      await flushPromises()

      const lx = wrapper.get('[data-settings-lx]')
      expect(lx.find('[data-settings-lx-quality]').exists()).toBe(true)
      expect(lx.find('[data-lx-source-manager]').exists()).toBe(true)
      expect(wrapper.get('[data-settings-automatic-sources]').find('[data-lx-source-manager]').exists())
        .toBe(false)

      // The manager writes through the repository this sheet was given, not a private one.
      await wrapper.get('[data-lx-import-paste]').setValue(`
/**
 * @name Sheet Source
 */
const sheet = 1;`)
      await wrapper.get('[data-lx-import-paste-submit]').trigger('click')
      await wrapper.get('[data-agreement-check]').setValue(true)
      await wrapper.get('[data-agreement-accept]').trigger('click')
      for (let index = 0; index < 6; index += 1) {
        await flushPromises()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect((await lxSourceRepository.list()).map((record) => record.name))
        .toEqual(['Sheet Source'])

      await wrapper.get('[data-settings-locale]').setValue('zh-Hant')
      expect(wrapper.getComponent({ name: 'LxSourceManager' }).props('locale')).toBe('zh-Hant')
    })
  })

  /**
   * LX Music is not ready for the public release, so when the Admin has it off nothing
   * LX-shaped may exist in user settings at all: no toggle, no quality selector, no source
   * manager, and no explanatory copy or empty section. The gate reads the authoritative
   * server state only -- never a stored preference or a stale cache -- and it fails closed,
   * so a configuration that cannot be read hides LX rather than reviving it. Re-enabling
   * restores the controls without discarding anything the user had saved.
   */
  describe('LX availability gate', () => {
    type Wrapper = ReturnType<typeof mountSettings>['wrapper']

    const lxSurface = (wrapper: Wrapper) => ({
      toggle: wrapper.find('[data-settings-source="lx"]').exists(),
      block: wrapper.find('[data-settings-lx]').exists(),
      quality: wrapper.find('[data-settings-lx-quality]').exists(),
      manager: wrapper.find('[data-lx-source-manager]').exists(),
    })

    const hidden = { toggle: false, block: false, quality: false, manager: false }

    it('removes every LX control when the administrator has LX off', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: providersWithLxDisabled(),
      })
      await flushPromises()

      expect(lxSurface(wrapper)).toEqual(hidden)
      // No empty LX section, heading or status message is left behind, and no LX name
      // leaks into the Playback copy.
      expect(wrapper.find('[data-settings-section="playback"]').text()).not.toMatch(/\bLX\b/u)
      expect(wrapper.html()).not.toContain('data-settings-lx')
      // ChKSz and Jellyfin are deliberately unaffected.
      expect(wrapper.find('[data-settings-source="chksz"]').exists()).toBe(true)
      expect(wrapper.find('[data-settings-source="jellyfin"]').exists()).toBe(true)
    })

    it('shows the LX controls when the administrator has LX on', async () => {
      const { wrapper } = mountSettings(undefined, undefined, {
        providerStates: allProvidersEnabled(),
      })
      await flushPromises()

      expect(lxSurface(wrapper)).toEqual({ toggle: true, block: true, quality: true, manager: true })
      expect(wrapper.get('[data-settings-source="lx"]').text()).toContain('LX Music')
    })

    it('fails closed when the provider configuration is unreadable', async () => {
      const { wrapper } = mountSettings(undefined, undefined, { providerStates: [] })
      await flushPromises()

      expect(lxSurface(wrapper)).toEqual(hidden)
    })

    it('fails closed when the configuration request rejects', async () => {
      const { wrapper, providerStatesMock } = mountSettings(undefined, undefined, {
        providerStates: allProvidersEnabled(),
      })
      await flushPromises()
      expect(lxSurface(wrapper).block).toBe(true)

      providerStatesMock.mockRejectedValue(new Error('offline'))
      document.dispatchEvent(new Event('visibilitychange'))
      await flushPromises()

      expect(lxSurface(wrapper)).toEqual(hidden)
    })

    it('follows an administrator change made while the session is open (off -> on -> off)', async () => {
      const { wrapper, setProviderStates } = mountSettings(undefined, undefined, {
        providerStates: providersWithLxDisabled(),
      })
      await flushPromises()
      expect(lxSurface(wrapper).block).toBe(false)

      setProviderStates(allProvidersEnabled())
      document.dispatchEvent(new Event('visibilitychange'))
      await flushPromises()
      expect(lxSurface(wrapper)).toEqual({ toggle: true, block: true, quality: true, manager: true })

      setProviderStates(providersWithLxDisabled())
      document.dispatchEvent(new Event('visibilitychange'))
      await flushPromises()
      expect(lxSurface(wrapper)).toEqual(hidden)
    })

    it('keeps saved LX preferences across a disabled period', async () => {
      const qualityPreferences = createPlaybackQualityPreferencesStore({
        storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      })
      qualityPreferences.setLxQuality('hires')
      const { wrapper, setProviderStates } = mountSettings(undefined, undefined, {
        qualityPreferences,
        providerStates: providersWithLxDisabled(),
      })
      await flushPromises()

      expect(lxSurface(wrapper).block).toBe(false)
      expect(qualityPreferences.lxQuality()).toBe('hires')

      setProviderStates(allProvidersEnabled())
      document.dispatchEvent(new Event('visibilitychange'))
      await flushPromises()

      expect((wrapper.get('[data-settings-lx-quality]').element as HTMLSelectElement).value).toBe('hires')
      expect(qualityPreferences.lxQuality()).toBe('hires')
    })

    it('hides LX identically for an anonymous and a signed-in user', async () => {
      const disabledStates = providersWithLxDisabled()

      const { wrapper: anonymous } = mountSettings(undefined, undefined, {
        providerStates: disabledStates,
      })
      await flushPromises()
      expect(lxSurface(anonymous)).toEqual(hidden)
      cleanups.pop()?.()

      resetAccountSession()
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
        String(input) === '/api/session'
          ? new Response(JSON.stringify({
            user: { id: 'user-1', displayName: 'Reader', avatarUrl: null, role: 'user' },
            identities: ['google'],
          }), { status: 200, headers: { 'content-type': 'application/json' } })
          : new Response(null, { status: 204 })))
      const { wrapper: signedIn } = mountSettings(undefined, undefined, {
        providerStates: disabledStates,
      })
      await flushPromises()

      expect(lxSurface(signedIn)).toEqual(hidden)
    })

    it('does not resurrect LX from a stored user preference', async () => {
      // A preference can only ever exclude a provider, so a stored selection that does not
      // disable LX must not bring it back while the administrator has it off.
      const providerPreferences = createProviderPreferencesStore({
        storage: {
          getItem: (key: string) =>
            (key.endsWith('provider-preferences:v2')
              ? JSON.stringify({ version: 2, disabledProviderIds: [] })
              : null),
          setItem: () => undefined,
          removeItem: () => undefined,
        },
      })
      expect(providerPreferences.isDisabled('lx')).toBe(false)

      const { wrapper } = mountSettings(undefined, undefined, {
        providerPreferences,
        providerStates: providersWithLxDisabled(),
      })
      await flushPromises()

      expect(lxSurface(wrapper)).toEqual(hidden)
    })
  })
})

it('defers a personal Key until explicit consent and withdraws it without disabling Jellyfin', async () => {
  const credentials = createChkszCredentialStore({ storage: window.localStorage })
  const { wrapper } = mountSettings(undefined, credentials, { providerStates: allProvidersEnabled() })
  await flushPromises()
  await wrapper.get('[data-settings-chksz-key]').setValue('chksz_CONSENT_TEST')
  await wrapper.get('[data-settings-chksz]').trigger('submit')
  expect(credentials.key()).toBeNull()
  await wrapper.get('[data-agreement-check]').setValue(true)
  await wrapper.get('[data-agreement-accept]').trigger('click')
  await flushPromises()
  expect(credentials.key()).toBe('chksz_CONSENT_TEST')
  await wrapper.get('[data-agreement-withdraw]').trigger('click')
  await flushPromises()
  expect(credentials.key()).toBeNull()
  expect((wrapper.get('[data-settings-source="jellyfin"] input').element as HTMLInputElement).checked).toBe(true)
})

it('cancels a deliberate Key activation without retaining the Key', async () => {
  const credentials = createChkszCredentialStore({ storage: window.localStorage })
  const { wrapper } = mountSettings(undefined, credentials)
  document.body.append(wrapper.element)
  await flushPromises()
  await wrapper.get('[data-settings-chksz-key]').setValue('chksz_CANCEL_TEST')
  const opener = wrapper.get('[data-settings-chksz-save]').element as HTMLButtonElement
  opener.focus()
  await wrapper.get('[data-settings-chksz]').trigger('submit')
  await flushPromises()
  expect(document.activeElement).toBe(wrapper.get('[data-agreement-check]').element)
  await wrapper.get('[data-agreement-cancel]').trigger('click')
  await flushPromises()
  expect(document.activeElement).toBe(opener)
  expect(credentials.key()).toBeNull()
  expect(localStorage.getItem('study-with-hoyomix:third-party-agreement:v1')).toBeNull()
  wrapper.element.remove()
})
