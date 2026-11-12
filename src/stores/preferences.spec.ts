
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { timeBudget } from '../../scripts/ci-runner-budget.mjs'
import { PREFERENCES_STORAGE_KEY } from './preferences'

// One controller per test. afterEach aborts it, so a loop abandoned by a timeout
// stops at its next iteration instead of writing localStorage into the next test.
let currentTest = new AbortController()

beforeEach(() => {
  currentTest = new AbortController()
  vi.restoreAllMocks()
  vi.resetModules()
  window.localStorage.clear()
})

afterEach(() => {
  currentTest.abort()
})

describe('preferences', () => {
  it('persists only the explicit UI preference allowlist, including bounded Studio blur', async () => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      backgroundMode: 'video',
      locale: 'fr',
      lowPower: 'yes',
      oauthToken: 'must-not-survive',
      providerUrl: 'https://example.invalid/audio',
      studioBlur: 200,
    }))
    const { usePreferences } = await import('./preferences')
    const preferences = usePreferences()

    preferences.setLocale('zh-Hant')
    preferences.setLowPower(true)
    preferences.setBackgroundMode('still')
    preferences.setVisualStyle('studio')
    preferences.setStudioBlur(20)
    preferences.setLocale('fr' as never)
    preferences.setLowPower('yes' as never)
    preferences.setBackgroundMode('video' as never)
    preferences.setVisualStyle('neon' as never)
    preferences.setStudioBlur(200)
    preferences.setStudioBlur(10.5)
    preferences.setStudioGlassGray(45)
    preferences.setStudioGlassGray(101)
    preferences.setStudioGlassGray(-1)
    preferences.setStudioGlassGray(45.5)
    preferences.setStudioGlassGray('40' as never)
    preferences.setStudioEdge(80)
    preferences.setStudioEdge(101)
    preferences.setStudioEdge(-1)
    preferences.setStudioEdge(80.5)
    preferences.setStudioEdge('40' as never)

    expect(preferences.locale.value).toBe('zh-Hant')
    expect(preferences.lowPower.value).toBe(false)
    expect(preferences.backgroundMode.value).toBe('still')
    expect(preferences.visualStyle.value).toBe('studio')
    expect(preferences.studioBlur.value).toBe(20)
    expect(preferences.studioGlassGray.value).toBe(45)
    expect(preferences.studioEdge.value).toBe(80)
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{}')).toEqual({
      locale: 'zh-Hant',
      backgroundMode: 'still',
      visualStyle: 'studio',
      studioBlur: 20,
      studioGlassGray: 45,
      studioEdge: 80,
      studyTipsEnabled: true,
    })
  })

  it('persists only the local study-tip toggle and stable dismissal identifiers', async () => {
    const { usePreferences } = await import('./preferences')
    const preferences = usePreferences()
    expect(preferences.studyTipsEnabled.value).toBe(true)
    preferences.dismissStudyTip('pace')
    preferences.setStudyTipsEnabled(false)
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? '{}')).toMatchObject({
      studyTipsEnabled: false,
      dismissedStudyTipId: 'pace',
    })
    preferences.setStudyTipsEnabled(true)
    expect(preferences.dismissedStudyTipId.value).toBeUndefined()
  })

  it('rehydrates persisted Studio appearance preferences on a fresh module load', async () => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      locale: 'zh-Hant',
      lowPower: false,
      backgroundMode: 'ambient',
      visualStyle: 'studio',
      studioBlur: 22,
      studioGlassGray: 12,
      studioEdge: 40,
    }))

    const { usePreferences } = await import('./preferences')

    expect(usePreferences().visualStyle.value).toBe('studio')
    expect(usePreferences().studioBlur.value).toBe(22)
    expect(usePreferences().studioGlassGray.value).toBe(12)
    expect(usePreferences().studioEdge.value).toBe(40)
  })

  // Both bounds tests re-import the module graph seven times (resetModules discards Vue
  // as well), so their cost scales with machine load rather than with the assertions. On a
  // shared runner under the full suite the 5s default expired mid-loop; the abandoned loop
  // then kept writing localStorage into the next test and made it read a default. The loops
  // now stop once afterEach aborts the test, and the raised budget applies only on the
  // self-hosted runner (CI_RUNNER_PROFILE, P95-06), so a genuine hang elsewhere fails fast.
  it('gives the glass gray tint a tasteful default and rejects out-of-range stored values', async () => {
    const { signal } = currentTest
    const fresh = await import('./preferences')
    // A first visit, and an install that predates the preference, both land on the
    // shared default rather than on a colourless glass.
    expect(fresh.usePreferences().studioGlassGray.value).toBe(fresh.DEFAULT_STUDIO_GLASS_GRAY)
    expect(fresh.DEFAULT_STUDIO_GLASS_GRAY).toBeGreaterThanOrEqual(20)
    expect(fresh.DEFAULT_STUDIO_GLASS_GRAY).toBeLessThanOrEqual(30)

    for (const rejected of [140, -5, 26.5, '26', null, {}]) {
      if (signal.aborted) return
      vi.resetModules()
      window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ studioGlassGray: rejected }))
      const { usePreferences, DEFAULT_STUDIO_GLASS_GRAY } = await import('./preferences')
      expect(usePreferences().studioGlassGray.value).toBe(DEFAULT_STUDIO_GLASS_GRAY)
    }

    // The documented bounds themselves must survive a round trip.
    for (const accepted of [0, 100]) {
      if (signal.aborted) return
      vi.resetModules()
      window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ studioGlassGray: accepted }))
      const { usePreferences } = await import('./preferences')
      expect(usePreferences().studioGlassGray.value).toBe(accepted)
    }
  }, timeBudget('preferencesModuleReload'))

  it('gives edge dispersion a visible default and rejects out-of-range stored values', async () => {
    const { signal } = currentTest
    const fresh = await import('./preferences')
    expect(fresh.usePreferences().studioEdge.value).toBe(fresh.DEFAULT_STUDIO_EDGE)
    expect(fresh.DEFAULT_STUDIO_EDGE).toBeGreaterThanOrEqual(64)
    expect(fresh.DEFAULT_STUDIO_EDGE).toBeLessThanOrEqual(72)

    for (const rejected of [140, -5, 68.5, '68', null, {}]) {
      if (signal.aborted) return
      vi.resetModules()
      window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ studioEdge: rejected }))
      const { usePreferences, DEFAULT_STUDIO_EDGE } = await import('./preferences')
      expect(usePreferences().studioEdge.value).toBe(DEFAULT_STUDIO_EDGE)
    }

    for (const accepted of [0, 100]) {
      if (signal.aborted) return
      vi.resetModules()
      window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({ studioEdge: accepted }))
      const { usePreferences } = await import('./preferences')
      expect(usePreferences().studioEdge.value).toBe(accepted)
    }
  }, timeBudget('preferencesModuleReload'))

  it('keeps a chosen glass gray tint across a fresh module load', async () => {
    const first = await import('./preferences')
    first.usePreferences().setStudioGlassGray(64)

    vi.resetModules()
    const { usePreferences } = await import('./preferences')
    expect(usePreferences().studioGlassGray.value).toBe(64)
  })

  it('keeps valid changes in memory without throwing when storage policy denies writes', async () => {
    const { usePreferences } = await import('./preferences')
    const preferences = usePreferences()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError')
    })

    expect(() => preferences.setLowPower(true)).not.toThrow()
    expect(() => preferences.setBackgroundMode('still')).not.toThrow()
    expect(() => preferences.setVisualStyle('studio')).not.toThrow()
    expect(() => preferences.setStudioBlur(24)).not.toThrow()
    expect(() => preferences.setStudioGlassGray(38)).not.toThrow()
    expect(() => preferences.setStudioEdge(72)).not.toThrow()
    expect(preferences.lowPower.value).toBe(false)
    expect(preferences.backgroundMode.value).toBe('still')
    expect(preferences.visualStyle.value).toBe('studio')
    expect(preferences.studioBlur.value).toBe(24)
    expect(preferences.studioGlassGray.value).toBe(38)
    expect(preferences.studioEdge.value).toBe(72)
  })
})
