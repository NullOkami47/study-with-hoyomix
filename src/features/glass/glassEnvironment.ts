import { computed, shallowRef, type ComputedRef } from 'vue'
import type { TranslationKey } from '../../i18n'
import { refractionPreference, setRefractionPreference, type RefractionChoice } from './refractionPreference'

/**
 * Build-level kill switch for the hero edge refraction. When false the settings switch is hidden, no
 * filter is rendered and no tile is fetched; the refraction e2e cases skip through
 * `html[data-glass-refraction-build="disabled"]`.
 *
 * Studio uses one native SVG backdrop pass from same-origin tiles. Its material
 * and optical strength are owned by StudioGlassEnvironment and studioSvgOptics;
 * unsupported engines retain native CSS without scene readback.
 */
export const REFRACTION_ENABLED = true

/**
 * Default for a user who never touched the switch (subject to the automatic low-end rule below).
 *
 * Preserve the inherited desktop-off/mobile-on policy. Historical #108 AC-12
 * numbers describe another material, not this renderer. Desktop viewport/touch
 * emulation is not physical Android GPU, battery or thermal evidence.
 */
export const REFRACTION_DEFAULT_ON: Readonly<{ desktop: boolean; mobile: boolean }> = Object.freeze({ desktop: false, mobile: true })

export interface GlassProbe {
  /** `backdrop-filter` or `-webkit-backdrop-filter` is supported. */
  backdrop: boolean
  /** A Chromium engine (UA-CH brand plus a `Chrome/` token): desktop and Android. */
  chromium: boolean
  /** `backdrop-filter: url(#…)` parses. Necessary, not sufficient (hence `chromium`). */
  urlBackdrop: boolean
  mobile: boolean
  reducedMotion: boolean
  reducedTransparency: boolean
  contrastMore: boolean
  forcedColors: boolean
  cores?: number
  memory?: number
  saveData: boolean
  slowUpdate: boolean
  resizeObserver: boolean
}

export interface GlassConfig {
  enabled: boolean
  defaultOn: { desktop: boolean; mobile: boolean }
  stored: RefractionChoice | null
}

export interface GlassEnvironment {
  backdrop: 'supported' | 'none'
  power: 'normal' | 'low'
  enabled: boolean
  supported: boolean
  blockedBy: 'contrast' | 'transparency' | null
  autoOff: boolean
  stored: RefractionChoice | null
  checked: boolean
  refraction: 'svg' | 'none'
  mobile: boolean
  reducedTransparency: boolean
}

function atMost(value: number | undefined, limit: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value <= limit
}

export function resolveGlassEnvironment(probe: GlassProbe, config: GlassConfig): GlassEnvironment {
  const power = atMost(probe.cores, 4) || atMost(probe.memory, 4) || probe.saveData || probe.slowUpdate ? 'low' : 'normal'
  const supported = config.enabled && probe.backdrop && probe.chromium && probe.urlBackdrop && probe.resizeObserver
  const blockedBy = probe.contrastMore || probe.forcedColors ? 'contrast' : probe.reducedTransparency ? 'transparency' : null
  const autoOff = probe.reducedTransparency || probe.saveData || atMost(probe.memory, 2) || (probe.mobile && atMost(probe.cores, 4))
  const defaultOn = !autoOff && config.defaultOn[probe.mobile ? 'mobile' : 'desktop']
  const wanted = config.stored === 'on' || (config.stored === null && defaultOn)
  const checked = supported && blockedBy === null && wanted
  return {
    backdrop: probe.backdrop ? 'supported' : 'none',
    power,
    enabled: config.enabled,
    supported,
    blockedBy,
    autoOff,
    stored: config.stored,
    checked,
    refraction: checked ? 'svg' : 'none',
    mobile: probe.mobile,
    reducedTransparency: probe.reducedTransparency,
  }
}

export const GLASS_MEDIA_QUERIES = Object.freeze({
  reducedMotion: '(prefers-reduced-motion: reduce)',
  reducedTransparency: '(prefers-reduced-transparency: reduce)',
  contrastMore: '(prefers-contrast: more)',
  forcedColors: '(forced-colors: active)',
  coarse: '(pointer: coarse)',
  slowUpdate: '(update: slow)',
})

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

function media(query: string): boolean {
  return safe(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches, false)
}

function supports(property: string, value: string): boolean {
  return safe(() => typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports(property, value), false)
}

interface NavigatorHints {
  userAgentData?: { brands?: { brand: string }[]; mobile?: boolean }
  deviceMemory?: number
  connection?: { saveData?: boolean }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * A Chromium engine: a `Chromium` UA-CH brand (Chrome, Edge, Samsung Internet, WebView all send it)
 * and a `Chrome/` token. `HeadlessChrome/` (automation) is Chromium too; iOS browsers send `CriOS/` or
 * no Chrome token, and Safari and Firefox expose no UA-CH brands.
 */
export function isChromiumEngine(brands: readonly { brand: string }[] | undefined, userAgent: string): boolean {
  const chromiumBrand = Array.isArray(brands) && brands.some((entry) => entry?.brand === 'Chromium')
  return chromiumBrand && /\b(?:Headless)?(?:Chrome|Chromium)\/\d+/.test(userAgent)
}

export function readGlassProbe(): GlassProbe {
  const nav = safe(() => navigator as Navigator & NavigatorHints, undefined)
  return {
    backdrop: supports('backdrop-filter', 'blur(1px)') || supports('-webkit-backdrop-filter', 'blur(1px)'),
    chromium: safe(() => isChromiumEngine(nav?.userAgentData?.brands, nav?.userAgent ?? ''), false),
    urlBackdrop: supports('backdrop-filter', 'url(#lg)'),
    mobile: safe(() => nav?.userAgentData?.mobile === true, false) || media(GLASS_MEDIA_QUERIES.coarse),
    reducedMotion: media(GLASS_MEDIA_QUERIES.reducedMotion),
    reducedTransparency: media(GLASS_MEDIA_QUERIES.reducedTransparency),
    contrastMore: media(GLASS_MEDIA_QUERIES.contrastMore),
    forcedColors: media(GLASS_MEDIA_QUERIES.forcedColors),
    cores: safe(() => numberOrUndefined(nav?.hardwareConcurrency), undefined),
    memory: safe(() => numberOrUndefined(nav?.deviceMemory), undefined),
    saveData: safe(() => nav?.connection?.saveData === true, false),
    slowUpdate: media(GLASS_MEDIA_QUERIES.slowUpdate),
    resizeObserver: safe(() => typeof ResizeObserver === 'function', false),
  }
}

export function applyGlassEnvironment(env: GlassEnvironment, root: HTMLElement = document.documentElement): void {
  root.dataset.glassBackdrop = env.backdrop
  root.dataset.glassPower = env.power
  root.dataset.glassRefraction = env.refraction
  root.dataset.glassRefractionBuild = env.enabled ? 'enabled' : 'disabled'
}

export function clearGlassEnvironment(root: HTMLElement = document.documentElement): void {
  delete root.dataset.glassBackdrop
  delete root.dataset.glassPower
  delete root.dataset.glassRefraction
  delete root.dataset.glassRefractionBuild
}

/** The resolved environment while StudioGlassEnvironment.vue is mounted, otherwise null. */
export const glassEnvironment = shallowRef<GlassEnvironment | null>(null)

export type RefractionHintKey = Extract<TranslationKey,
  'settings.appearance.refractionTransparency' | 'settings.appearance.refractionUnsupported' | 'settings.appearance.refractionHighContrast' | 'settings.appearance.refractionSaver'>

export interface GlassRefractionSetting {
  visible: ComputedRef<boolean>
  supported: ComputedRef<boolean>
  blockedBy: ComputedRef<'contrast' | 'transparency' | null>
  autoOff: ComputedRef<boolean>
  checked: ComputedRef<boolean>
  hintKey: ComputedRef<RefractionHintKey | null>
  setEnabled: (on: boolean) => void
}

/** State for the settings-sheet "Glass refraction" switch. */
export function useGlassRefractionSetting(): GlassRefractionSetting {
  const supported = computed(() => glassEnvironment.value?.supported === true)
  const blockedBy = computed(() => glassEnvironment.value?.blockedBy ?? null)
  const autoOff = computed(() => glassEnvironment.value?.autoOff === true)
  return {
    visible: computed(() => glassEnvironment.value !== null && REFRACTION_ENABLED),
    supported,
    blockedBy,
    autoOff,
    checked: computed(() => glassEnvironment.value?.checked === true),
    hintKey: computed<RefractionHintKey | null>(() => {
      if (!supported.value) return 'settings.appearance.refractionUnsupported'
      if (blockedBy.value === 'transparency') return 'settings.appearance.refractionTransparency'
      if (blockedBy.value !== null) return 'settings.appearance.refractionHighContrast'
      if (autoOff.value && refractionPreference.value === null) return 'settings.appearance.refractionSaver'
      return null
    }),
    // GlassEnvironment.vue watches the stored preference and re-resolves.
    setEnabled: (on: boolean) => setRefractionPreference(on),
  }
}
