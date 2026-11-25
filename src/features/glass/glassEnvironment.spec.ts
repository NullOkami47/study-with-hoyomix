import { afterEach, describe, expect, it } from 'vitest'
import {
  applyGlassEnvironment,
  clearGlassEnvironment,
  glassEnvironment,
  isChromiumEngine,
  readGlassProbe,
  REFRACTION_DEFAULT_ON,
  REFRACTION_ENABLED,
  resolveGlassEnvironment,
  useGlassRefractionSetting,
  type GlassConfig,
  type GlassProbe,
} from './glassEnvironment'
import { refractionPreference, reloadRefractionPreference } from './refractionPreference'

const desktopChromium: GlassProbe = {
  backdrop: true,
  chromium: true,
  urlBackdrop: true,
  mobile: false,
  reducedMotion: false,
  reducedTransparency: false,
  contrastMore: false,
  forcedColors: false,
  cores: 8,
  memory: 8,
  saveData: false,
  slowUpdate: false,
  resizeObserver: true,
}
const androidChromium: GlassProbe = { ...desktopChromium, mobile: true, cores: 8, memory: 8 }
const config: GlassConfig = { enabled: true, defaultOn: { desktop: true, mobile: true }, stored: null }

function resolve(probe: Partial<GlassProbe>, overrides: Partial<GlassConfig> = {}) {
  return resolveGlassEnvironment({ ...desktopChromium, ...probe }, { ...config, ...overrides })
}

afterEach(() => {
  glassEnvironment.value = null
  window.localStorage.clear()
  reloadRefractionPreference()
  clearGlassEnvironment()
})

describe('resolveGlassEnvironment', () => {
  it('ships with the build gate open, desktop off by default (AC-12 outcome) and Android on', () => {
    expect(REFRACTION_ENABLED).toBe(true)
    expect(REFRACTION_DEFAULT_ON).toEqual({ desktop: false, mobile: true })
    const shipped = { ...config, defaultOn: REFRACTION_DEFAULT_ON }
    expect(resolveGlassEnvironment(desktopChromium, shipped)).toMatchObject({ supported: true, autoOff: false, checked: false, refraction: 'none' })
    expect(resolveGlassEnvironment(desktopChromium, { ...shipped, stored: 'on' })).toMatchObject({ checked: true, refraction: 'svg' })
    expect(resolveGlassEnvironment(androidChromium, shipped)).toMatchObject({ supported: true, checked: true, refraction: 'svg' })
  })

  it('turns refraction on for desktop and Android Chromium', () => {
    expect(resolve({})).toMatchObject({ supported: true, checked: true, refraction: 'svg', power: 'normal', backdrop: 'supported' })
    expect(resolveGlassEnvironment(androidChromium, config)).toMatchObject({ supported: true, checked: true, refraction: 'svg' })
  })

  it('treats Samsung Internet on Android as Chromium', () => {
    const samsung = 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36'
    const chromium = isChromiumEngine([{ brand: 'Not A(Brand' }, { brand: 'Chromium' }, { brand: 'Samsung Internet' }], samsung)
    expect(chromium).toBe(true)
    expect(resolve({ chromium, mobile: true })).toMatchObject({ refraction: 'svg' })
  })

  it('reports non-Chromium engines, iPhone-UA Chromium and missing features as unsupported', () => {
    expect(resolve({ chromium: false })).toMatchObject({ supported: false, checked: false, refraction: 'none' })
    expect(resolve({ urlBackdrop: false })).toMatchObject({ supported: false, refraction: 'none' })
    expect(resolve({ resizeObserver: false })).toMatchObject({ supported: false, refraction: 'none' })
    expect(resolve({ backdrop: false })).toMatchObject({ supported: false, refraction: 'none', backdrop: 'none' })
    expect(resolve({}, { enabled: false })).toMatchObject({ supported: false, enabled: false, refraction: 'none' })
  })

  it('switches the default off for each low-end or preference trigger', () => {
    for (const probe of [
      { reducedTransparency: true },
      { saveData: true },
      { memory: 2 },
      { mobile: true, cores: 4 },
    ] satisfies Partial<GlassProbe>[]) {
      expect(resolve(probe), JSON.stringify(probe)).toMatchObject({ supported: true, autoOff: true, checked: false, refraction: 'none' })
    }
    expect(resolve({ cores: 4 })).toMatchObject({ autoOff: false, checked: true, power: 'low' })
  })

  it('lets a stored choice override the automatic default in both directions', () => {
    expect(resolve({ saveData: true }, { stored: 'on' })).toMatchObject({ checked: true, refraction: 'svg' })
    expect(resolve({}, { stored: 'off' })).toMatchObject({ checked: false, refraction: 'none' })
    expect(resolveGlassEnvironment(androidChromium, { ...config, defaultOn: { desktop: true, mobile: false } })).toMatchObject({ checked: false })
    expect(resolveGlassEnvironment(androidChromium, { ...config, defaultOn: { desktop: true, mobile: false }, stored: 'on' })).toMatchObject({ checked: true })
  })

  it('hard-blocks refraction under increased contrast and forced colours', () => {
    expect(resolve({ contrastMore: true }, { stored: 'on' })).toMatchObject({ blockedBy: 'contrast', checked: false, refraction: 'none' })
    expect(resolve({ forcedColors: true }, { stored: 'on' })).toMatchObject({ blockedBy: 'contrast', checked: false })
  })

  it('hard-blocks reduced transparency even when a user stored on', () => {
    for (const stored of ['on', 'off', null] as const) {
      expect(resolve({ reducedTransparency: true }, { stored })).toMatchObject({ blockedBy: 'transparency', checked: false, refraction: 'none', stored })
    }
  })

  it('does not block refraction under reduced motion', () => {
    expect(resolve({ reducedMotion: true })).toMatchObject({ checked: true, refraction: 'svg' })
  })

  it('derives the low-power blur column independently of refraction', () => {
    expect(resolve({ memory: 4 }).power).toBe('low')
    expect(resolve({ slowUpdate: true }).power).toBe('low')
    expect(resolve({ saveData: true }).power).toBe('low')
    expect(resolve({ cores: 6, memory: 8 }).power).toBe('normal')
    expect(resolve({ cores: undefined, memory: undefined }).power).toBe('normal')
  })
})

describe('glass environment attributes', () => {
  it('writes and clears the root attributes', () => {
    const root = document.createElement('html')
    applyGlassEnvironment(resolve({ memory: 4 }), root)
    expect(root.dataset).toMatchObject({ glassBackdrop: 'supported', glassPower: 'low', glassRefraction: 'svg', glassRefractionBuild: 'enabled' })
    applyGlassEnvironment(resolve({}, { enabled: false }), root)
    expect(root.dataset.glassRefractionBuild).toBe('disabled')
    clearGlassEnvironment(root)
    expect(Object.keys(root.dataset)).toEqual([])
  })

  it('recognises a Chromium engine by its UA-CH brand and a Chrome token', () => {
    const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    const edge = `${chrome} Edg/124.0.0.0`
    const headless = chrome.replace('Chrome/', 'HeadlessChrome/')
    expect(isChromiumEngine([{ brand: 'Chromium' }, { brand: 'Google Chrome' }], chrome)).toBe(true)
    expect(isChromiumEngine([{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }], edge)).toBe(true)
    expect(isChromiumEngine([{ brand: 'Chromium' }], headless)).toBe(true)
    // No Chromium brand: Safari and Firefox expose none, and a brand list without Chromium is not enough.
    expect(isChromiumEngine(undefined, chrome)).toBe(false)
    expect(isChromiumEngine([], chrome)).toBe(false)
    expect(isChromiumEngine([{ brand: 'Google Chrome' }], chrome)).toBe(false)
    // iOS: every engine is WebKit. Chrome on iPhone sends CriOS/ and no Chrome/ token.
    const crios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1'
    const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
    expect(isChromiumEngine([{ brand: 'Chromium' }], crios)).toBe(false)
    expect(isChromiumEngine([{ brand: 'Chromium' }], safari)).toBe(false)
  })

  it('reads a safe probe in jsdom', () => {
    const probe = readGlassProbe()
    expect(probe.chromium).toBe(false)
    expect(typeof probe.backdrop).toBe('boolean')
    expect(probe.saveData).toBe(false)
  })
})

describe('useGlassRefractionSetting', () => {
  it('is hidden until the environment is mounted, and while the build gate is off', () => {
    const setting = useGlassRefractionSetting()
    expect(setting.visible.value).toBe(false)
    glassEnvironment.value = resolve({})
    expect(setting.visible.value).toBe(REFRACTION_ENABLED)
    expect(setting.checked.value).toBe(true)
    expect(setting.hintKey.value).toBeNull()
  })

  it('selects the hint for every reason', () => {
    const setting = useGlassRefractionSetting()
    glassEnvironment.value = resolve({ chromium: false, contrastMore: true })
    expect(setting.hintKey.value).toBe('settings.appearance.refractionUnsupported')
    glassEnvironment.value = resolve({ forcedColors: true })
    expect(setting.hintKey.value).toBe('settings.appearance.refractionHighContrast')
    glassEnvironment.value = resolve({ saveData: true })
    expect(setting.hintKey.value).toBe('settings.appearance.refractionSaver')
    refractionPreference.value = 'on'
    expect(setting.hintKey.value).toBeNull()
  })

  it('stores the choice through setEnabled', () => {
    const setting = useGlassRefractionSetting()
    setting.setEnabled(false)
    expect(refractionPreference.value).toBe('off')
    expect(window.localStorage.getItem('study-with-hoyomix.glass-refraction')).toBe('off')
    setting.setEnabled(true)
    expect(refractionPreference.value).toBe('on')
  })
})
