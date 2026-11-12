import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { GlassProbe } from './glassEnvironment'

const probe: GlassProbe = {
  backdrop: true, chromium: true, urlBackdrop: true, mobile: false, reducedMotion: false, reducedTransparency: false,
  contrastMore: false, forcedColors: false, cores: 8, memory: 8, saveData: false, slowUpdate: false, resizeObserver: true,
}
let currentProbe: GlassProbe = probe
// The wiring under test does not depend on the shipped defaults (glassEnvironment.spec.ts owns those).
let defaultOn: { desktop: boolean; mobile: boolean } | undefined = { desktop: true, mobile: true }

vi.mock('./glassEnvironment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./glassEnvironment')>()
  return {
    ...actual,
    REFRACTION_ENABLED: true,
    get REFRACTION_DEFAULT_ON() { return defaultOn ?? actual.REFRACTION_DEFAULT_ON },
    readGlassProbe: () => currentProbe,
  }
})

const { glassEnvironment } = await import('./glassEnvironment')
const { reloadRefractionPreference, setRefractionPreference } = await import('./refractionPreference')
const { glassHeroStates } = await import('./useGlassRefraction')
const { REFRACTION_TILE_SETS } = await import('./refractionTiles')
const GlassEnvironment = (await import('./GlassEnvironment.vue')).default

type Registry = Map<string, unknown>
const registry = () => glassHeroStates() as unknown as Registry
const root = document.documentElement

beforeEach(() => {
  currentProbe = probe
  defaultOn = { desktop: true, mobile: true }
  window.localStorage.clear()
  reloadRefractionPreference()
})

afterEach(() => {
  registry().clear()
  window.localStorage.clear()
  reloadRefractionPreference()
})

describe('GlassEnvironment', () => {
  it('resolves the environment and writes the root attributes on mount', () => {
    const wrapper = mount(GlassEnvironment)
    expect(root.dataset).toMatchObject({ glassBackdrop: 'supported', glassPower: 'normal', glassRefraction: 'svg', glassRefractionBuild: 'enabled' })
    expect(glassEnvironment.value?.refraction).toBe('svg')
    wrapper.unmount()
  })

  it('renders a filter only for heroes in phase resolved or ready', async () => {
    const wrapper = mount(GlassEnvironment, { attachTo: document.body })
    await nextTick()
    expect(wrapper.find('svg.lg-filter-defs').exists()).toBe(true)
    expect(wrapper.find('filter').exists()).toBe(false)
    const player = REFRACTION_TILE_SETS.find((set) => set.hero === 'player' && set.radius === 42)!
    registry().set('player', { phase: 'resolved', w: 480, h: 84, set: player })
    await nextTick()
    const filter = wrapper.get('#lg-refract-player')
    expect(filter.attributes()).toMatchObject({ x: '0', y: '0', width: '480', height: '84', filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })
    // A pill: four corners plus the top and bottom edges; no vertical edges.
    const images = filter.findAll('feImage')
    expect(images.map((image) => image.attributes('href'))).toEqual([
      '/glass/refraction/c-r42-b22-tl.png',
      '/glass/refraction/c-r42-b22-tr.png',
      '/glass/refraction/c-r42-b22-bl.png',
      '/glass/refraction/c-r42-b22-br.png',
      '/glass/refraction/e-b22-t.png',
      '/glass/refraction/e-b22-b.png',
    ])
    expect(images[1].attributes()).toMatchObject({ x: '438', y: '0', width: '42', height: '42' })
    expect(images[4].attributes()).toMatchObject({ x: '42', y: '0', width: '396', height: '22' })
    expect(filter.findAll('feMergeNode')).toHaveLength(7)
    expect(filter.get('feDisplacementMap').attributes()).toMatchObject({ scale: '56', in: 'SourceGraphic', in2: 'map' })
    expect(wrapper.find('[style]').exists()).toBe(false)
    registry().set('player', { phase: 'ready', w: 480, h: 315, set: REFRACTION_TILE_SETS.find((set) => set.hero === 'player' && set.radius === 40)! })
    await nextTick()
    expect(wrapper.get('#lg-refract-player').findAll('feImage')).toHaveLength(8)
    registry().set('player', { phase: 'idle' })
    await nextTick()
    expect(wrapper.find('filter').exists()).toBe(false)
    wrapper.unmount()
  })

  it('re-resolves when the stored preference changes, and drops the defs when refraction is off', async () => {
    const wrapper = mount(GlassEnvironment)
    setRefractionPreference(false)
    await nextTick()
    expect(root.dataset.glassRefraction).toBe('none')
    expect(wrapper.find('svg').exists()).toBe(false)
    setRefractionPreference(true)
    await nextTick()
    expect(root.dataset.glassRefraction).toBe('svg')
    wrapper.unmount()
  })

  it('passes the shipped defaults through: desktop starts off, Android on, a stored choice wins', () => {
    defaultOn = undefined
    let wrapper = mount(GlassEnvironment)
    expect(root.dataset.glassRefraction).toBe('none')
    wrapper.unmount()
    currentProbe = { ...probe, mobile: true }
    wrapper = mount(GlassEnvironment)
    expect(root.dataset.glassRefraction).toBe('svg')
    wrapper.unmount()
    currentProbe = probe
    setRefractionPreference(true)
    wrapper = mount(GlassEnvironment)
    expect(root.dataset.glassRefraction).toBe('svg')
    wrapper.unmount()
  })

  it('marks unsupported engines and low-power devices', () => {
    currentProbe = { ...probe, chromium: false, memory: 4 }
    const wrapper = mount(GlassEnvironment)
    expect(root.dataset).toMatchObject({ glassRefraction: 'none', glassPower: 'low' })
    wrapper.unmount()
  })

  it('clears every attribute and the shared state on unmount', () => {
    const wrapper = mount(GlassEnvironment)
    root.dataset.sceneTone = 'dark'
    wrapper.unmount()
    expect(glassEnvironment.value).toBeNull()
    for (const key of ['glassBackdrop', 'glassPower', 'glassRefraction', 'glassRefractionBuild', 'sceneTone']) {
      expect(root.dataset[key], key).toBeUndefined()
    }
  })
})
