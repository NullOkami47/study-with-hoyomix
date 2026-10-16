
import { computed, ref, type Ref } from 'vue'

import { isLocale, resolveLocale, type Locale } from '../i18n'

export const PREFERENCES_STORAGE_KEY = 'study-with-hoyomix.ui-preferences'
export const DEFAULT_STUDIO_BLUR = 16
export const MIN_STUDIO_BLUR = 4
export const MAX_STUDIO_BLUR = 24
/**
 * Percentage of the strongest allowed neutral-grey wash over the Studio glass.
 * The default is deliberately mild: it takes the blue cast off the material
 * without darkening the scene behind it.
 */
export const DEFAULT_STUDIO_GLASS_GRAY = 26
export const MIN_STUDIO_GLASS_GRAY = 0
export const MAX_STUDIO_GLASS_GRAY = 100
/**
 * Percentage of the strongest edge dispersion. The default is high enough for
 * the rim to read as glass, and 0 is the off position.
 */
export const DEFAULT_STUDIO_EDGE = 68
export const MIN_STUDIO_EDGE = 0
export const MAX_STUDIO_EDGE = 100

export type BackgroundMode = 'ambient' | 'still'
export type VisualStyle = 'cinematic' | 'studio'
export type StudyTipId = 'pace' | 'reset' | 'environment'

interface StoredPreferences {
  locale: Locale
  backgroundMode: BackgroundMode
  visualStyle: VisualStyle
  studioBlur: number
  studioGlassGray: number
  studioEdge: number
  studyTipsEnabled: boolean
  dismissedStudyTipId?: StudyTipId
}

export interface Preferences {
  locale: Ref<Locale>
  lowPower: Ref<boolean>
  backgroundMode: Ref<BackgroundMode>
  visualStyle: Ref<VisualStyle>
  studioBlur: Ref<number>
  studioGlassGray: Ref<number>
  studioEdge: Ref<number>
  studyTipsEnabled: Ref<boolean>
  dismissedStudyTipId: Ref<StudyTipId | undefined>
  setLocale: (locale: Locale) => void
  setLowPower: (enabled: boolean) => void
  setBackgroundMode: (mode: BackgroundMode) => void
  setVisualStyle: (style: VisualStyle) => void
  setStudioBlur: (radius: number) => void
  setStudioGlassGray: (percentage: number) => void
  setStudioEdge: (percentage: number) => void
  setStudyTipsEnabled: (enabled: boolean) => void
  dismissStudyTip: (id: StudyTipId) => void
}

function browserLanguage(): string {
  return typeof navigator === 'undefined' ? 'en' : navigator.language
}

function validStudioBlur(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= MIN_STUDIO_BLUR && Number(value) <= MAX_STUDIO_BLUR
}

function validStudioGlassGray(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= MIN_STUDIO_GLASS_GRAY && Number(value) <= MAX_STUDIO_GLASS_GRAY
}

function validStudioEdge(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= MIN_STUDIO_EDGE && Number(value) <= MAX_STUDIO_EDGE
}

function readPreferences(): Partial<StoredPreferences> {
  if (typeof window === 'undefined') return {}

  try {
    const value = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
    if (!value) return {}

    const stored: unknown = JSON.parse(value)
    if (!stored || typeof stored !== 'object') return {}

    const candidate = stored as Partial<StoredPreferences>
    return {
      locale: isLocale(candidate.locale) ? candidate.locale : undefined,
      backgroundMode:
        candidate.backgroundMode === 'ambient' || candidate.backgroundMode === 'still'
          ? candidate.backgroundMode
          : undefined,
      visualStyle:
        candidate.visualStyle === 'cinematic' || candidate.visualStyle === 'studio'
          ? candidate.visualStyle
          : undefined,
      studioBlur: validStudioBlur(candidate.studioBlur) ? candidate.studioBlur : undefined,
      studioGlassGray: validStudioGlassGray(candidate.studioGlassGray) ? candidate.studioGlassGray : undefined,
      studioEdge: validStudioEdge(candidate.studioEdge) ? candidate.studioEdge : undefined,
      studyTipsEnabled: typeof candidate.studyTipsEnabled === 'boolean' ? candidate.studyTipsEnabled : undefined,
      dismissedStudyTipId: candidate.dismissedStudyTipId === 'pace' || candidate.dismissedStudyTipId === 'reset' || candidate.dismissedStudyTipId === 'environment' ? candidate.dismissedStudyTipId : undefined,
    }
  } catch {
    return {}
  }
}

const stored = readPreferences()
const locale = ref<Locale>(resolveLocale(browserLanguage(), stored.locale))
// Compatibility seam for older callers. The retired setting is never enabled.
const lowPower = computed({ get: () => false, set: (_value: boolean) => {} })
const backgroundMode = ref<BackgroundMode>(stored.backgroundMode ?? 'ambient')
const visualStyle = ref<VisualStyle>(stored.visualStyle ?? 'cinematic')
const studioBlur = ref(stored.studioBlur ?? DEFAULT_STUDIO_BLUR)
// Installations that predate this preference receive the default rather than 0,
// so the material looks the same on their next visit as on a fresh one.
const studioGlassGray = ref(stored.studioGlassGray ?? DEFAULT_STUDIO_GLASS_GRAY)
const studioEdge = ref(stored.studioEdge ?? DEFAULT_STUDIO_EDGE)
const studyTipsEnabled = ref(stored.studyTipsEnabled ?? true)
const dismissedStudyTipId = ref<StudyTipId | undefined>(stored.dismissedStudyTipId)

function persistPreferences(): void {
  if (typeof window === 'undefined') return

  try {
    const preferences: StoredPreferences = {
      locale: locale.value,
      backgroundMode: backgroundMode.value,
      visualStyle: visualStyle.value,
      studioBlur: studioBlur.value,
      studioGlassGray: studioGlassGray.value,
      studioEdge: studioEdge.value,
      studyTipsEnabled: studyTipsEnabled.value,
      dismissedStudyTipId: dismissedStudyTipId.value,
    }
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Storage can be unavailable under browser policy; preferences remain in memory.
  }
}

function setLocale(nextLocale: Locale): void {
  if (!isLocale(nextLocale)) return
  locale.value = nextLocale
  persistPreferences()
}

function setLowPower(enabled: boolean): void {
  // Retired: accept old callers without restoring or persisting the field.
  void enabled
  persistPreferences()
}

function setBackgroundMode(mode: BackgroundMode): void {
  if (mode !== 'ambient' && mode !== 'still') return
  backgroundMode.value = mode
  persistPreferences()
}

function setVisualStyle(style: VisualStyle): void {
  if (style !== 'cinematic' && style !== 'studio') return
  visualStyle.value = style
  persistPreferences()
}

function setStudioBlur(radius: number): void {
  if (!validStudioBlur(radius)) return
  studioBlur.value = radius
  persistPreferences()
}

function setStudioGlassGray(percentage: number): void {
  if (!validStudioGlassGray(percentage)) return
  studioGlassGray.value = percentage
  persistPreferences()
}

function setStudioEdge(percentage: number): void {
  if (!validStudioEdge(percentage)) return
  studioEdge.value = percentage
  persistPreferences()
}

function setStudyTipsEnabled(enabled: boolean): void {
  if (typeof enabled !== 'boolean') return
  studyTipsEnabled.value = enabled
  if (enabled) dismissedStudyTipId.value = undefined
  persistPreferences()
}

function dismissStudyTip(id: StudyTipId): void {
  if (id !== 'pace' && id !== 'reset' && id !== 'environment') return
  dismissedStudyTipId.value = id
  persistPreferences()
}

const preferences: Preferences = {
  locale,
  lowPower,
  backgroundMode,
  visualStyle,
  studioBlur,
  studioGlassGray,
  studioEdge,
  studyTipsEnabled,
  dismissedStudyTipId,
  setLocale,
  setLowPower,
  setBackgroundMode,
  setVisualStyle,
  setStudioBlur,
  setStudioGlassGray,
  setStudioEdge,
  setStudyTipsEnabled,
  dismissStudyTip,
}

export function usePreferences(): Preferences {
  return preferences
}

// Normalise legacy records without discarding unrelated supported values.
persistPreferences()
