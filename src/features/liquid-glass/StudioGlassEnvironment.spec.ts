import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { glassEnvironment } from '../glass/glassEnvironment'
import { refractionPreference } from '../glass/refractionPreference'
import StudioGlassEnvironment from './StudioGlassEnvironment.vue'

const mocks = vi.hoisted(() => ({ create: vi.fn(), destroy: vi.fn(), setEdge: vi.fn(), probe: vi.fn() }))
vi.mock('./studioNativeRenderer', () => ({ createStudioNativeRenderer: mocks.create }))
vi.mock('../glass/glassEnvironment', async original => ({ ...await original<typeof import('../glass/glassEnvironment')>(), readGlassProbe: mocks.probe }))
const chromium = { backdrop: true, chromium: true, urlBackdrop: true, mobile: false, reducedMotion: false, reducedTransparency: false, contrastMore: false, forcedColors: false, cores: 8, memory: 8, saveData: false, slowUpdate: false, resizeObserver: true }
let wrapper: ReturnType<typeof mount> | undefined
beforeEach(() => {
  vi.clearAllMocks(); mocks.probe.mockReturnValue({ ...chromium }); mocks.create.mockReturnValue({ destroy: mocks.destroy, setEdge: mocks.setEdge })
  refractionPreference.value = 'on'
  vi.stubGlobal('matchMedia', vi.fn(() => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})
afterEach(() => { wrapper?.unmount(); wrapper=undefined; refractionPreference.value=null; vi.unstubAllGlobals() })
describe('Studio environment owner', () => {
  it('has no wrapper and starts one native engine; edge0 does not restart it', async () => {
    wrapper=mount(StudioGlassEnvironment)
    expect(wrapper.find('div, canvas, video').exists()).toBe(false)
    expect(mocks.create).toHaveBeenCalledOnce()
    await wrapper.setProps({ edge: 0 })
    expect(mocks.setEdge).toHaveBeenLastCalledWith(0)
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(glassEnvironment.value?.checked).toBe(true)
  })
  it('obeys the shared desktop default and explicit disable', async () => {
    refractionPreference.value=null; wrapper=mount(StudioGlassEnvironment)
    expect(mocks.create).not.toHaveBeenCalled()
    refractionPreference.value='on'; await nextTick(); expect(mocks.create).toHaveBeenCalledOnce()
    await wrapper.setProps({ enabled:false }); expect(mocks.destroy).toHaveBeenCalledOnce()
    expect(glassEnvironment.value?.refraction).toBe('none')
  })
  it.each([{ chromium:false }, { forcedColors:true }, { contrastMore:true }, { backdrop:false }])('keeps native CSS fallback for %j', probe => {
    mocks.probe.mockReturnValue({ ...chromium,...probe }); wrapper=mount(StudioGlassEnvironment)
    expect(mocks.create).not.toHaveBeenCalled(); expect(document.documentElement.dataset.studioGlassEngine).toBe('native-css')
  })
  it('reduced motion does not introduce an animation loop or change resolver policy', () => {
    mocks.probe.mockReturnValue({ ...chromium,reducedMotion:true }); wrapper=mount(StudioGlassEnvironment)
    expect(mocks.create).toHaveBeenCalledOnce()
  })
  it('reports unsupported rather than SVG when MutationObserver is absent', () => {
    vi.stubGlobal('MutationObserver', undefined); wrapper = mount(StudioGlassEnvironment)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(glassEnvironment.value).toMatchObject({ supported: false, checked: false, refraction: 'none' })
    expect(document.documentElement.dataset.studioGlassEngine).toBe('native-css')
  })
  it('contains startup failure and does not retry on every resize', async () => {
    mocks.create.mockImplementationOnce(() => { throw new Error('native optics unavailable') })
    expect(() => { wrapper = mount(StudioGlassEnvironment) }).not.toThrow()
    window.dispatchEvent(new Event('resize')); await nextTick()
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(glassEnvironment.value).toMatchObject({ supported: false, checked: false, refraction: 'none' })
    expect(document.documentElement.dataset.studioGlassEngine).toBe('native-css')
  })
  it('publishes current preference vars and restores pre-existing values on unmount', () => {
    document.documentElement.style.setProperty('--studio-blur','7px')
    wrapper=mount(StudioGlassEnvironment,{props:{blurRadius:20,glassGray:40,edge:0}})
    expect(document.documentElement.style.getPropertyValue('--studio-blur')).toBe('20px')
    expect(document.documentElement.style.getPropertyValue('--studio-gray')).toBe('0.4')
    wrapper.unmount(); wrapper=undefined
    expect(document.documentElement.style.getPropertyValue('--studio-blur')).toBe('7px')
    expect(document.documentElement.style.getPropertyValue('--studio-gray')).toBe('')
    expect(glassEnvironment.value).toBeNull(); expect(document.documentElement.dataset.studioGlassEngine).toBeUndefined()
    document.documentElement.style.removeProperty('--studio-blur')
  })
})
