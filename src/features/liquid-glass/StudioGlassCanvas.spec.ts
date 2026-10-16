import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  instances: [] as any[],
  mutationObservers: [] as any[],
  resizeObservers: [] as any[],
  motionListeners: new Set<(event: MediaQueryListEvent) => void>(),
  motionMatches: false,
  throwConstructor: false,
  throwRender: false,
  textureCreationFails: false,
  hostSize: { width: 100, height: 50 },
  imageSources: [] as string[],
}))

vi.mock('./renderer/MultiPassRenderer', () => {
  class MockRenderer {
    readonly sceneTexture = { kind: 'scene-texture' }
    readonly gl = {
      createTexture: vi.fn(() => mocks.textureCreationFails ? null : this.sceneTexture),
      bindTexture: vi.fn(),
      texImage2D: vi.fn(),
      texParameteri: vi.fn(),
      pixelStorei: vi.fn(),
      deleteTexture: vi.fn(),
      TEXTURE_2D: 1,
      RGBA: 2,
      UNSIGNED_BYTE: 3,
      LINEAR: 4,
      CLAMP_TO_EDGE: 5,
      UNPACK_FLIP_Y_WEBGL: 6,
      TEXTURE_MIN_FILTER: 7,
      TEXTURE_MAG_FILTER: 8,
      TEXTURE_WRAP_S: 9,
      TEXTURE_WRAP_T: 10,
    }
    readonly setUniforms = vi.fn()
    readonly render = vi.fn(() => {
      if (mocks.throwRender) throw new Error('render failed')
    })
    readonly resize = vi.fn()
    readonly dispose = vi.fn()
    readonly getGL = vi.fn(() => this.gl)

    constructor(_canvas: HTMLCanvasElement, public readonly configs: any[]) {
      if (mocks.throwConstructor) throw new Error('shader compile failed')
      mocks.instances.push(this)
    }
  }

  return {
    MultiPassRenderer: MockRenderer,
    computeGaussianKernelByRadius: (radius: number) => Array.from({ length: radius + 1 }, () => 1 / (radius * 2 + 1)),
  }
})

import StudioGlassCanvas from './StudioGlassCanvas.vue'
import { DEFAULT_STUDIO_EDGE, DEFAULT_STUDIO_GLASS_GRAY, MAX_STUDIO_GLASS_GRAY } from '../../stores/preferences'
import { STUDIO_OPTICS, studioEdgeDispersion } from './studioOptics'

class TestImage {
  naturalWidth = 468
  naturalHeight = 201
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  set src(value: string) {
    mocks.imageSources.push(value)
    queueMicrotask(() => this.onload?.())
  }
}

class TestResizeObserver {
  disconnect = vi.fn()
  observe = vi.fn()
  constructor(public readonly callback: ResizeObserverCallback) {
    mocks.resizeObservers.push(this)
  }
}

class TestMutationObserver {
  disconnect = vi.fn()
  observe = vi.fn()
  constructor(public readonly callback: MutationCallback) {
    mocks.mutationObservers.push(this)
  }
}

function setDocumentVisibility(hidden: boolean): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' })
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
}

function installBrowserBoundaries(): void {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 })
  setDocumentVisibility(false)
  vi.stubGlobal('Image', TestImage)
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('MutationObserver', TestMutationObserver)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 101))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    get matches() { return mocks.motionMatches },
    media: query,
    onchange: null,
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'change' && typeof listener === 'function') mocks.motionListeners.add(listener as (event: MediaQueryListEvent) => void)
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'change' && typeof listener === 'function') mocks.motionListeners.delete(listener as (event: MediaQueryListEvent) => void)
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as MediaQueryList)))
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('studio-glass-canvas')) {
      const { width, height } = mocks.hostSize
      return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }
    }
    // `data-rect="left,top,width,height"` lets a test place a surface precisely,
    // which is how off-canvas positions are expressed.
    const explicit = this.dataset.rect?.split(',').map(Number)
    if (explicit?.length === 4 && explicit.every((value) => Number.isFinite(value))) {
      const [left, top, width, height] = explicit as [number, number, number, number]
      return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) }
    }
    if (this.matches('.focus-bar, .player-bar, .chat-window, .overlay-sheet, .settings-sheet__section, [data-advanced-filters]')) {
      const index = Number(this.dataset.testIndex ?? '0')
      const left = 4 + index * 3
      return { x: left, y: 5, left, top: 5, right: left + 20, bottom: 20, width: 20, height: 15, toJSON: () => ({}) }
    }
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
  })
}

/**
 * The resting workspace, laid out so the surfaces do not overlap.
 *
 * The positions matter now: the canvas gives an overlapped region to the frontmost surface
 * alone, because one distance field cannot express two layers. A fixture that stacked
 * every surface at the same place would therefore be testing the overlap rule rather than
 * the collection it is meant to exercise. The host rect mock is 100x50, so these are a top
 * bar, a player below it, a chat window beside the player, and the filters popover under
 * the bar -- the real arrangement, at the fixture's scale.
 *
 * The settings cards are inside the hub's scrolling panel, which is where they really live
 * and which is why they are CSS glass rather than canvas surfaces.
 */
function installSemanticSurfaces(): void {
  document.body.innerHTML = `
    <div class="focus-bar" data-rect="4,1,44,10" style="border-radius: 12px"></div>
    <div class="player-bar surface-glass" data-rect="4,40,44,9" style="border-radius: 12px"></div>
    <div class="chat-window surface-glass" data-rect="60,30,36,18" style="border-radius: 12px"></div>
    <div class="overlay-sheet surface-glass" data-rect="52,1,44,20" style="border-radius: 12px">
      <div data-control-centre-panel style="overflow: auto">
        ${Array.from({ length: 8 }, (_, index) => `<section class="settings-sheet__section surface-glass" data-rect="53,${2 + index * 3},40,2" data-test-index="${index + 4}" style="border-radius: 8px"></section>`).join('')}
      </div>
    </div>
    <section data-advanced-filters data-rect="4,14,44,12" data-test-index="12" style="border-radius: 10px"></section>
    <div class="surface-glass" data-unmanaged-glass style="border-radius: 12px"></div>
  `
}

beforeEach(() => {
  mocks.instances.length = 0
  mocks.mutationObservers.length = 0
  mocks.resizeObservers.length = 0
  mocks.motionListeners.clear()
  mocks.motionMatches = false
  mocks.throwConstructor = false
  mocks.throwRender = false
  mocks.textureCreationFails = false
  mocks.hostSize = { width: 100, height: 50 }
  mocks.imageSources.length = 0
  installBrowserBoundaries()
  installSemanticSurfaces()
})

afterEach(() => {
  document.body.innerHTML = ''
  Reflect.deleteProperty(document, 'hidden')
  Reflect.deleteProperty(document, 'visibilityState')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete document.documentElement.dataset.studioGlass
})

describe('StudioGlassCanvas', () => {
  it('binds the scene texture to the production shader and manages every semantic glass surface', async () => {
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 18 } })
    await flushPromises()
    await nextTick()

    const renderer = mocks.instances[0]
    expect(renderer).toBeTruthy()
    expect(renderer.configs.map((config: any) => ({ name: config.name, inputs: config.inputs, outputToScreen: config.outputToScreen }))).toEqual([
      { name: 'bgPass', inputs: undefined, outputToScreen: undefined },
      { name: 'vBlurPass', inputs: { u_prevPassTexture: 'bgPass' }, outputToScreen: undefined },
      { name: 'hBlurPass', inputs: { u_prevPassTexture: 'vBlurPass' }, outputToScreen: undefined },
      { name: 'mainPass', inputs: { u_blurredBg: 'hBlurPass', u_bg: 'bgPass' }, outputToScreen: true },
    ])
    expect(renderer.resize).toHaveBeenCalledWith(200, 100)
    expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({
      u_blurRadius: 18,
      u_dpr: 2,
      u_sceneTexture: renderer.sceneTexture,
      u_shapeCount: 4,
    }))
    expect(renderer.setUniforms.mock.lastCall?.[0].u_blurWeights).toHaveLength(19)
    expect(document.documentElement.dataset.studioGlass).toBe('active')

    // The Control Centre is one CSS page, so the overlay is not a shader surface.
    for (const element of document.querySelectorAll<HTMLElement>('.focus-bar, .player-bar, .chat-window, [data-advanced-filters]')) {
      expect(element.dataset.studioGlassRendered).toBe('true')
    }
    expect(document.querySelector<HTMLElement>('.overlay-sheet')?.dataset.studioGlassRendered).toBeUndefined()
    // The settings cards are nested inside the hub's scrolling panel. They keep their own
    // CSS glass, which is what gives the panel its separate rectangular sections: a card
    // handed to the canvas contributes nothing to the field yet is still told to drop its
    // fallback, which is what flattened the panel.
    for (const element of document.querySelectorAll<HTMLElement>('.settings-sheet__section')) {
      expect(element.dataset.studioGlassRendered).toBeUndefined()
    }
    expect(document.querySelector<HTMLElement>('[data-unmanaged-glass]')?.dataset.studioGlassRendered).toBeUndefined()

    wrapper.unmount()
    expect(renderer.gl.deleteTexture).toHaveBeenCalledTimes(1)
    expect(renderer.dispose).toHaveBeenCalledTimes(1)
    expect(document.documentElement.dataset.studioGlass).toBeUndefined()
    expect(document.querySelector('[data-studio-glass-rendered]')).toBeNull()
  })

  it('rebuilds the blur kernel and renders a fresh frame when the setting changes', async () => {
    let scheduledFrame: FrameRequestCallback | undefined
    vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
      scheduledFrame = callback
      return 101
    })
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16 } })
    await flushPromises()

    const renderer = mocks.instances[0]
    renderer.setUniforms.mockClear()
    await wrapper.setProps({ blurRadius: 22 })
    await nextTick()
    expect(scheduledFrame).toBeTypeOf('function')

    scheduledFrame?.(0)
    expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({ u_blurRadius: 22 }))
    expect(renderer.setUniforms.mock.lastCall?.[0].u_blurWeights).toHaveLength(23)
    wrapper.unmount()
  })

  it('normalises the gray tint preference into the shader uniform', async () => {
    let scheduledFrame: FrameRequestCallback | undefined
    vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
      scheduledFrame = callback
      return 102
    })
    // Omitting the prop must land on the shared default rather than a bare glass.
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16 } })
    await flushPromises()

    const renderer = mocks.instances[0]
    expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({
      u_glassGray: DEFAULT_STUDIO_GLASS_GRAY / MAX_STUDIO_GLASS_GRAY,
    }))

    // The shader works in 0..1; the preference is a 0..100 percentage.
    renderer.setUniforms.mockClear()
    await wrapper.setProps({ glassGray: 60 })
    await nextTick()
    scheduledFrame?.(0)
    expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({ u_glassGray: 0.6 }))

    // Out-of-range and non-finite values clamp instead of poisoning the uniform.
    renderer.setUniforms.mockClear()
    await wrapper.setProps({ glassGray: 480 })
    await nextTick()
    scheduledFrame?.(0)
    expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({ u_glassGray: 1 }))

    renderer.setUniforms.mockClear()
    await wrapper.setProps({ glassGray: Number.NaN })
    await nextTick()
    scheduledFrame?.(0)
    expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({
      u_glassGray: DEFAULT_STUDIO_GLASS_GRAY / MAX_STUDIO_GLASS_GRAY,
    }))
    wrapper.unmount()
  })

  it('maps the edge slider onto dispersion and can turn the rim off', async () => {
    let scheduledFrame: FrameRequestCallback | undefined
    vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
      scheduledFrame = callback
      return 103
    })
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16 } })
    await flushPromises()

    const renderer = mocks.instances[0]
    expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({
      u_refDispersion: studioEdgeDispersion(DEFAULT_STUDIO_EDGE),
    }))

    renderer.setUniforms.mockClear()
    await wrapper.setProps({ edge: 0 })
    await nextTick()
    scheduledFrame?.(0)
    expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({ u_refDispersion: 0 }))

    renderer.setUniforms.mockClear()
    await wrapper.setProps({ edge: 100 })
    await nextTick()
    scheduledFrame?.(0)
    expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({
      u_refDispersion: STUDIO_OPTICS.dispersionCeiling,
    }))

    renderer.setUniforms.mockClear()
    await wrapper.setProps({ edge: Number.NaN })
    await nextTick()
    scheduledFrame?.(0)
    expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({
      u_refDispersion: studioEdgeDispersion(DEFAULT_STUDIO_EDGE),
    }))
    wrapper.unmount()
  })

  it('samples the visible backdrop so the fringe follows that picture', async () => {
    document.body.insertAdjacentHTML('afterbegin', '<div data-scene-backdrop><img src="/api/backgrounds/lamp/media" alt=""></div>')
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16 } })
    await flushPromises()
    await flushPromises()
    expect(mocks.imageSources.at(-1)).toBe('/api/backgrounds/lamp/media')
    expect(mocks.imageSources).not.toContain('/scenes/quiet-study-room.png')
    wrapper.unmount()
  })

  it('uses CSS glass for live video before playback without allocating a second scene renderer', async () => {
    document.body.insertAdjacentHTML('afterbegin', '<div data-scene-backdrop><video src="/backgrounds/scene.mp4"></video></div>')
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false } })
    await flushPromises()
    expect(document.documentElement.dataset.studioGlass).toBeUndefined()
    expect(mocks.instances).toHaveLength(0)
    expect(wrapper.find('canvas').exists()).toBe(false)
    wrapper.unmount()
  })
  it('releases GPU resources for video and restores static optics after switching back', async () => {
    document.body.insertAdjacentHTML('afterbegin', '<div data-scene-backdrop><img src="/poster.jpg"></div>')
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false } })
    await flushPromises()
    expect(mocks.instances).toHaveLength(1)
    const first = mocks.instances[0]
    const backdrop = document.querySelector('[data-scene-backdrop]')!
    backdrop.innerHTML = '<video src="/video.mp4"></video>'
    for (const observer of mocks.mutationObservers) observer.callback([], observer as unknown as MutationObserver)
    await flushPromises()
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(wrapper.find('canvas').exists()).toBe(false)
    expect(document.documentElement.dataset.studioGlass).toBeUndefined()
    backdrop.innerHTML = '<img src="/poster.jpg">'
    for (const observer of mocks.mutationObservers) observer.callback([], observer as unknown as MutationObserver)
    await flushPromises()
    expect(mocks.instances).toHaveLength(2)
    expect(wrapper.find('canvas').exists()).toBe(true)
    expect(document.documentElement.dataset.studioGlass).toBe('active')
    wrapper.unmount()
  })

  it('supersamples the glass when the display ratio is only 1', async () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16 } })
    await flushPromises()

    const renderer = mocks.instances[0]
    expect(renderer.resize).toHaveBeenCalledWith(200, 100)
    expect(renderer.setUniforms).toHaveBeenCalledWith(expect.objectContaining({ u_dpr: 2 }))
    wrapper.unmount()
  })

  it('reduces render density for low-power and prefers-reduced-motion without losing the glass effect', async () => {
    mocks.motionMatches = true
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    const renderer = mocks.instances[0]
    expect(renderer.resize).toHaveBeenCalledWith(100, 50)
    expect(renderer.setUniforms).toHaveBeenCalledWith(expect.objectContaining({ u_dpr: 1 }))
    expect(document.documentElement.dataset.studioGlass).toBe('active')

    mocks.motionMatches = false
    for (const listener of mocks.motionListeners) listener({ matches: false } as MediaQueryListEvent)
    await nextTick()
    expect(renderer.resize).toHaveBeenLastCalledWith(200, 100)

    await wrapper.setProps({ lowPower: true })
    await nextTick()
    expect(renderer.resize).toHaveBeenLastCalledWith(100, 50)
    wrapper.unmount()
  })

  it('pauses scheduled rendering while the tab is hidden and resumes when visible', async () => {
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    mocks.resizeObservers[0].callback([], mocks.resizeObservers[0])
    expect(vi.mocked(requestAnimationFrame)).toHaveBeenCalledTimes(1)

    setDocumentVisibility(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalledWith(101)

    setDocumentVisibility(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(vi.mocked(requestAnimationFrame)).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('uses the latest blur kernel when a hidden tab becomes visible', async () => {
    let callback: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((next: FrameRequestCallback) => { callback = next; return 202 }))
    setDocumentVisibility(true)

    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16 } })
    await flushPromises()
    expect(document.documentElement.dataset.studioGlass).toBeUndefined()

    await wrapper.setProps({ blurRadius: 24 })
    await nextTick()
    expect(callback).toBeUndefined()

    setDocumentVisibility(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(callback).toBeTruthy()
    callback?.(0)
    expect(document.documentElement.dataset.studioGlass).toBe('active')
    expect(mocks.instances[0].setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({ u_blurRadius: 24 }))
    expect(mocks.instances[0].setUniforms.mock.lastCall?.[0].u_blurWeights).toHaveLength(25)
    wrapper.unmount()
  })

  it('rerenders after ResizeObserver and releases browser observers on unmount', async () => {
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    const renderer = mocks.instances[0]
    mocks.resizeObservers[0].callback([], mocks.resizeObservers[0])
    expect(renderer.resize).toHaveBeenLastCalledWith(200, 100)
    expect(vi.mocked(requestAnimationFrame)).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    expect(mocks.resizeObservers[0].disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.mutationObservers[0].disconnect).toHaveBeenCalledTimes(1)
    expect(mocks.motionListeners.size).toBe(0)
  })

  it('falls back to CSS material when renderer construction or shader linking fails', async () => {
    mocks.throwConstructor = true
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(document.documentElement.dataset.studioGlass).toBeUndefined()
    expect(document.querySelector('[data-studio-glass-rendered]')).toBeNull()
    expect(mocks.instances).toHaveLength(0)
    wrapper.unmount()
  })

  it('falls back safely if the scene texture cannot be allocated', async () => {
    mocks.textureCreationFails = true
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(document.documentElement.dataset.studioGlass).toBeUndefined()
    expect(mocks.instances[0].dispose).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-studio-glass-rendered]')).toBeNull()
    wrapper.unmount()
  })

  describe('off-canvas surface filtering', () => {
    // The host rect mock is 100x50 at the origin. A culled surface must be far
    // enough out that its drop shadow cannot tint a single canvas pixel, so the
    // fixtures below sit well beyond the component's derived safety margin.
    async function mountWith(markup: string) {
      document.body.innerHTML = markup
      const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16 } })
      await flushPromises()
      await nextTick()
      return { wrapper, renderer: mocks.instances[0] }
    }
    const surface = (id: string, rect: string) =>
      `<div id="${id}" class="player-bar surface-glass" data-rect="${rect}" style="border-radius: 12px"></div>`

    it.each([
      ['fully above the canvas', '10,-900,40,30'],
      ['fully below the canvas', '10,900,40,30'],
      ['fully left of the canvas', '-900,10,40,30'],
      ['fully right of the canvas', '900,10,40,30'],
    ])('excludes a surface that is %s', async (_label, rect) => {
      const { wrapper, renderer } = await mountWith(surface('inside', '10,10,40,30') + surface('outside', rect))

      expect(renderer.setUniforms.mock.lastCall?.[0].u_shapeCount).toBe(1)
      expect(document.getElementById('inside')?.dataset.studioGlassRendered).toBe('true')
      expect(document.getElementById('outside')?.dataset.studioGlassRendered).toBeUndefined()
      wrapper.unmount()
    })

    it('includes a surface that only partially intersects the canvas', async () => {
      const { wrapper, renderer } = await mountWith(surface('straddling', '-20,-20,40,30'))

      expect(renderer.setUniforms.mock.lastCall?.[0].u_shapeCount).toBe(1)
      expect(document.getElementById('straddling')?.dataset.studioGlassRendered).toBe('true')
      wrapper.unmount()
    })

    it('includes a surface fully inside the canvas', async () => {
      const { wrapper, renderer } = await mountWith(surface('inside', '10,10,40,30'))

      expect(renderer.setUniforms.mock.lastCall?.[0].u_shapeCount).toBe(1)
      expect(document.getElementById('inside')?.dataset.studioGlassRendered).toBe('true')
      wrapper.unmount()
    })

    it('keeps a just-outside surface whose shadow still bleeds onto the canvas', async () => {
      // Sits below the canvas but within shadow reach: culling it here would
      // visibly drop a shadow gradient, so it must survive the filter.
      const { wrapper, renderer } = await mountWith(surface('shadow-caster', '10,60,40,30'))

      expect(renderer.setUniforms.mock.lastCall?.[0].u_shapeCount).toBe(1)
      expect(document.getElementById('shadow-caster')?.dataset.studioGlassRendered).toBe('true')
      wrapper.unmount()
    })

    it('preserves DOM order and fills the shape cap with visible surfaces only', async () => {
      const markup = [
        surface('off-1', '10,-900,40,30'),
        ...Array.from({ length: 18 }, (_, index) => surface(`on-${index}`, `${index},10,40,30`)),
        surface('off-2', '900,10,40,30'),
      ].join('')
      const { wrapper, renderer } = await mountWith(markup)

      const uniforms = renderer.setUniforms.mock.lastCall?.[0]
      expect(uniforms.u_shapeCount).toBe(16)
      // The first sixteen on-canvas surfaces in DOM order, and nothing else.
      const rendered = [...document.querySelectorAll<HTMLElement>('[data-studio-glass-rendered="true"]')].map((element) => element.id)
      expect(rendered).toEqual(Array.from({ length: 16 }, (_, index) => `on-${index}`))
      // Centres follow the same order: x grows by one CSS pixel per surface.
      const centres = Array.from({ length: 16 }, (_, index) => uniforms.u_shapeCenters[index * 2])
      expect(centres).toEqual(Array.from({ length: 16 }, (_, index) => (index + 20) * 2))
      wrapper.unmount()
    })
  })

  describe('unchanged-frame suppression', () => {
    // A MutationObserver notification is cheap; a four-pass software-GL frame is
    // not. These tests pin the rule that only pixel-relevant change reaches the GPU.
    let frames: FrameRequestCallback[]

    function harness() {
      frames = []
      vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
    }
    function runFrames(): number {
      const pending = frames.splice(0, frames.length)
      pending.forEach((frame) => frame(0))
      return pending.length
    }
    async function mounted(markup?: string) {
      if (markup !== undefined) document.body.innerHTML = markup
      harness()
      const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16 } })
      await flushPromises()
      await nextTick()
      runFrames()
      const renderer = mocks.instances[0]
      renderer.render.mockClear()
      return { wrapper, renderer }
    }
    function notifyMutation(): void {
      mocks.mutationObservers[0].callback([], mocks.mutationObservers[0])
    }
    const panel = (id: string, rect: string) =>
      `<div id="${id}" class="player-bar surface-glass" data-rect="${rect}" style="border-radius: 12px"></div>`

    it('renders the first frame once the scene is ready', async () => {
      harness()
      document.body.innerHTML = panel('a', '10,10,40,20')
      const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16 } })
      await flushPromises()
      await nextTick()

      const renderer = mocks.instances[0]
      expect(renderer.render).toHaveBeenCalledTimes(1)
      expect(document.documentElement.dataset.studioGlass).toBe('active')
      wrapper.unmount()
    })

    it('does not reach the GPU when a mutation changes no pixel-relevant state', async () => {
      const { wrapper, renderer } = await mounted(panel('a', '10,10,40,20'))

      notifyMutation()
      notifyMutation()
      const scheduled = runFrames()

      expect(scheduled).toBeGreaterThan(0)
      expect(renderer.render).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('does not reach the GPU when a new surface reproduces the previous geometry', async () => {
      const { wrapper, renderer } = await mounted(panel('a', '10,10,40,20'))

      document.getElementById('a')?.remove()
      document.body.innerHTML += panel('b', '10,10,40,20')
      notifyMutation()
      runFrames()

      expect(renderer.render).not.toHaveBeenCalled()
      // The replacement surface still owns the rendered marker.
      expect(document.getElementById('b')?.dataset.studioGlassRendered).toBe('true')
      wrapper.unmount()
    })

    it.each([
      ['a visible surface moves', () => document.getElementById('a')?.setAttribute('data-rect', '30,10,40,20')],
      ['a visible surface resizes', () => document.getElementById('a')?.setAttribute('data-rect', '10,10,60,20')],
      ['a visible surface is added', () => { document.body.innerHTML += '<div id="c" class="player-bar surface-glass" data-rect="60,10,20,20" style="border-radius: 12px"></div>' }],
      ['a visible surface is removed', () => document.getElementById('a')?.remove()],
    ])('renders exactly one frame when %s', async (_label, mutate) => {
      const { wrapper, renderer } = await mounted(panel('a', '10,10,40,20'))

      mutate()
      notifyMutation()
      notifyMutation()
      runFrames()

      expect(renderer.render).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('renders when the blur preference changes', async () => {
      const { wrapper, renderer } = await mounted(panel('a', '10,10,40,20'))

      await wrapper.setProps({ blurRadius: 22 })
      await nextTick()
      runFrames()

      expect(renderer.render).toHaveBeenCalledTimes(1)
      expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({ u_blurRadius: 22 }))
      wrapper.unmount()
    })

    it('renders when the gray tint preference changes', async () => {
      const { wrapper, renderer } = await mounted(panel('a', '10,10,40,20'))

      await wrapper.setProps({ glassGray: 70 })
      await nextTick()
      runFrames()

      expect(renderer.render).toHaveBeenCalledTimes(1)
      expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({ u_glassGray: 0.7 }))
      wrapper.unmount()
    })

    it('still skips the GPU when the gray tint is reassigned to the same value', async () => {
      const { wrapper, renderer } = await mounted(panel('a', '10,10,40,20'))

      await wrapper.setProps({ glassGray: 70 })
      await nextTick()
      runFrames()
      renderer.render.mockClear()

      // A no-op preference write must not cost a four-pass frame.
      await wrapper.setProps({ glassGray: 70 })
      await nextTick()
      notifyMutation()
      runFrames()

      expect(renderer.render).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('renders when the effective DPR changes', async () => {
      const { wrapper, renderer } = await mounted(panel('a', '10,10,40,20'))

      await wrapper.setProps({ lowPower: true })
      await nextTick()
      runFrames()

      expect(renderer.render).toHaveBeenCalledTimes(1)
      expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({ u_dpr: 1 }))
      wrapper.unmount()
    })

    it('renders when the canvas is resized', async () => {
      const { wrapper, renderer } = await mounted(panel('a', '10,10,40,20'))

      mocks.hostSize = { width: 200, height: 120 }
      mocks.resizeObservers[0].callback([], mocks.resizeObservers[0])
      runFrames()

      expect(renderer.resize).toHaveBeenLastCalledWith(400, 240)
      expect(renderer.render).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('still coalesces repeated mutations into a single frame', async () => {
      const { wrapper, renderer } = await mounted(panel('a', '10,10,40,20'))

      document.getElementById('a')?.setAttribute('data-rect', '30,10,40,20')
      for (let index = 0; index < 5; index += 1) notifyMutation()

      expect(frames).toHaveLength(1)
      runFrames()
      expect(renderer.render).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })
  })

  describe('scroll invalidation', () => {
    // Scrolling a container moves its surfaces without mutating any attribute or
    // resizing the host, so neither observer fires. Verified in Chrome: an element's
    // non-bubbling `scroll` still reaches a capture-phase listener at `window`, which
    // is the only boundary that sees every scroller without per-container wiring.
    let frames: FrameRequestCallback[]

    function harness() {
      frames = []
      vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
    }
    function runFrames(): number {
      const pending = frames.splice(0, frames.length)
      pending.forEach((frame) => frame(0))
      return pending.length
    }
    async function mounted(markup: string, props: Record<string, unknown> = {}) {
      document.body.innerHTML = markup
      harness()
      const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16, ...props } })
      await flushPromises()
      await nextTick()
      runFrames()
      const renderer = mocks.instances[0]
      renderer.render.mockClear()
      renderer.setUniforms.mockClear()
      return { wrapper, renderer }
    }
    /**
     * A top-level surface inside a container that scrolls but does not clip it.
     *
     * It used to be a settings card inside an `overflow: auto` panel, which the canvas now
     * declines outright -- a surface it cannot clip is a surface it must not paint. What
     * these tests are actually about is the invalidation path: a scroll moves geometry
     * without mutating an attribute or resizing the host, so neither observer fires and
     * the collected rects go stale unless the capture-phase listener re-collects them.
     * That path is unchanged, and it is still the only thing keeping a scrolled layout
     * honest, so it keeps its coverage with a surface the canvas will accept.
     */
    const scroller = (inner: string) => `<div id="scroller">${inner}</div>`
    const panel = (id: string, rect: string) =>
      `<div id="${id}" class="player-bar surface-glass" data-rect="${rect}" style="border-radius: 12px"></div>`
    const scrollBy = (id = 'scroller') => document.getElementById(id)?.dispatchEvent(new Event('scroll'))

    it('re-collects shape geometry after a container scrolls', async () => {
      const { wrapper, renderer } = await mounted(scroller(panel('a', '10,10,40,20')))

      // The surface rides up as the scroller scrolls down.
      document.getElementById('a')?.setAttribute('data-rect', '10,-5,40,20')
      scrollBy()
      runFrames()

      expect(renderer.render).toHaveBeenCalledTimes(1)
      // y is flipped into GL space: (hostHeight - (bottom - hostTop)) * dpr, + h/2.
      expect(renderer.setUniforms.mock.lastCall?.[0].u_shapeCenters[1]).toBe(90)
      wrapper.unmount()
    })

    it('represents a surface that scrolls in from off-canvas', async () => {
      const { wrapper, renderer } = await mounted(scroller(panel('below', '10,900,40,30')))
      expect(document.getElementById('below')?.dataset.studioGlassRendered).toBeUndefined()

      document.getElementById('below')?.setAttribute('data-rect', '10,100,40,30')
      scrollBy()
      runFrames()

      expect(renderer.setUniforms.mock.lastCall?.[0].u_shapeCount).toBe(1)
      expect(document.getElementById('below')?.dataset.studioGlassRendered).toBe('true')
      wrapper.unmount()
    })

    it('drops a surface that scrolls out past the shadow margin', async () => {
      const { wrapper, renderer } = await mounted(scroller(panel('a', '10,10,40,20')))
      expect(document.getElementById('a')?.dataset.studioGlassRendered).toBe('true')

      document.getElementById('a')?.setAttribute('data-rect', '10,-900,40,20')
      scrollBy()
      runFrames()

      expect(renderer.setUniforms.mock.lastCall?.[0].u_shapeCount).toBe(0)
      expect(document.getElementById('a')?.dataset.studioGlassRendered).toBeUndefined()
      wrapper.unmount()
    })

    it('coalesces a burst of scroll events into one frame', async () => {
      const { wrapper, renderer } = await mounted(scroller(panel('a', '10,10,40,20')))

      document.getElementById('a')?.setAttribute('data-rect', '10,-5,40,20')
      for (let index = 0; index < 8; index += 1) scrollBy()

      expect(frames).toHaveLength(1)
      runFrames()
      expect(renderer.render).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('suppresses the GPU when a scroll moves nothing pixel-relevant', async () => {
      const { wrapper, renderer } = await mounted(scroller(panel('a', '10,10,40,20')))

      scrollBy()
      expect(runFrames()).toBeGreaterThan(0)

      expect(renderer.render).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('does not re-arm itself, so scrolling cannot spin a render loop', async () => {
      const { wrapper } = await mounted(scroller(panel('a', '10,10,40,20')))

      document.getElementById('a')?.setAttribute('data-rect', '10,-5,40,20')
      scrollBy()
      runFrames()

      // A frame that finished must leave nothing queued behind it.
      expect(frames).toHaveLength(0)
      wrapper.unmount()
    })

    it('observes window-level scrolling as well as inner containers', async () => {
      const { wrapper, renderer } = await mounted(scroller(panel('a', '10,10,40,20')))

      document.getElementById('a')?.setAttribute('data-rect', '10,-5,40,20')
      window.dispatchEvent(new Event('scroll'))
      runFrames()

      expect(renderer.render).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('stops listening for scroll once unmounted', async () => {
      const { wrapper } = await mounted(scroller(panel('a', '10,10,40,20')))

      wrapper.unmount()
      frames.length = 0
      document.getElementById('a')?.setAttribute('data-rect', '10,-5,40,20')
      scrollBy()

      expect(frames).toHaveLength(0)
    })

    it('keeps reduced-motion and low-power density while invalidating on scroll', async () => {
      mocks.motionMatches = true
      const { wrapper, renderer } = await mounted(scroller(panel('a', '10,10,40,20')), { lowPower: true })

      document.getElementById('a')?.setAttribute('data-rect', '10,-5,40,20')
      scrollBy()
      runFrames()

      expect(renderer.render).toHaveBeenCalledTimes(1)
      expect(renderer.setUniforms).toHaveBeenLastCalledWith(expect.objectContaining({ u_dpr: 1 }))
      wrapper.unmount()
    })
  })

  /**
   * One distance field cannot express two layers. Every surface it unions belongs to the
   * same silhouette, so a modal that overlaps the workspace does not sit *above* the top
   * bar and the player -- it fuses with them, and the seams turn into the concave fillets
   * that were reported as "one strange irregular polygon".
   *
   * The field therefore carries one layer: the frontmost surface over any given region.
   * Surfaces it covers keep their CSS glass, which is a first-class material in this
   * project rather than a degraded path, and they are behind a dimmed backdrop anyway.
   * This costs no additional render pass and strictly lowers the shape count.
   */
  describe('surface ownership', () => {
    let frames: FrameRequestCallback[]
    async function mountWith(markup: string) {
      document.body.innerHTML = markup
      frames = []
      vi.mocked(requestAnimationFrame).mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
      const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false, blurRadius: 16 } })
      await flushPromises()
      await nextTick()
      return { wrapper, renderer: mocks.instances[0] }
    }
    // Scheduling only ever queues a frame, so a test that changes the DOM has to let the
    // frame land before asking what the canvas decided.
    async function settle(): Promise<void> {
      mocks.mutationObservers[0]?.callback([], mocks.mutationObservers[0] as unknown as MutationObserver)
      frames.splice(0, frames.length).forEach((frame) => frame(0))
      await nextTick()
    }
    const rendered = () =>
      [...document.querySelectorAll<HTMLElement>('[data-studio-glass-rendered="true"]')].map((element) => element.id)

    it('does not paint the settings hub as a second shader page', async () => {
      const { wrapper, renderer } = await mountWith(`
        <div id="bar" class="focus-bar" data-rect="10,2,80,12" style="border-radius: 12px"></div>
        <div id="player" class="player-bar surface-glass" data-rect="10,36,80,12" style="border-radius: 12px"></div>
        <div id="hub" class="overlay-sheet surface-glass" data-rect="5,1,90,48" style="border-radius: 20px"></div>
      `)

      expect(rendered().sort()).toEqual(['bar', 'player'])
      expect(document.getElementById('hub')?.dataset.studioGlassRendered).toBeUndefined()
      expect(renderer.setUniforms.mock.lastCall?.[0].u_shapeCount).toBe(2)
      wrapper.unmount()
    })

    it('keeps a workspace surface the hub does not reach', async () => {
      const { wrapper, renderer } = await mountWith(`
        <div id="bar" class="focus-bar" data-rect="10,2,80,10" style="border-radius: 12px"></div>
        <div id="hub" class="overlay-sheet surface-glass" data-rect="10,20,80,28" style="border-radius: 20px"></div>
      `)

      expect(rendered()).toEqual(['bar'])
      expect(document.getElementById('hub')?.dataset.studioGlassRendered).toBeUndefined()
      expect(renderer.setUniforms.mock.lastCall?.[0].u_shapeCount).toBe(1)
      wrapper.unmount()
    })

    it('lets the frontmost of two workspace surfaces own an overlap', async () => {
      // The chat window is the one surface a user can drag anywhere, so it can be put
      // over the player. It is in front of the player, so it owns the shared region.
      const { wrapper } = await mountWith(`
        <div id="player" class="player-bar surface-glass" data-rect="10,30,80,18" style="border-radius: 12px"></div>
        <div id="chat" class="chat-window surface-glass" data-rect="40,24,50,20" style="border-radius: 16px"></div>
      `)

      expect(rendered()).toEqual(['chat'])
      wrapper.unmount()
    })

    /**
     * The settings cards live two levels inside the hub's scrolling panel, and the canvas
     * paints the whole viewport with no knowledge of that clip. Scroll one out of view and
     * the DOM clips it while its glass keeps rendering, which is how glass came to appear
     * outside the hub. They are also invisible when they *are* in view: a card inset within
     * the hub is further from every edge than the hub itself, so a union always prefers the
     * hub's field and the card contributes nothing -- while still being told to drop its CSS
     * glass, which is what flattened the panel.
     *
     * So the canvas takes only surfaces it can honour: the clip belongs to whoever owns the
     * scroller, and nested cards stay CSS glass. Enforced structurally rather than by
     * selector, so a future surface cannot reintroduce the defect by being added to the list.
     */
    it('declines a surface clipped by a scrolling ancestor', async () => {
      const { wrapper, renderer } = await mountWith(`
        <div id="hub" class="overlay-sheet surface-glass" data-rect="5,5,90,40" style="border-radius: 20px">
          <div id="panel" style="overflow: auto">
            <div id="card" class="settings-sheet__section surface-glass" data-rect="10,10,70,14" style="border-radius: 12px"></div>
          </div>
        </div>
      `)

      expect(rendered()).toEqual([])
      expect(document.getElementById('hub')?.dataset.studioGlassRendered).toBeUndefined()
      expect(renderer.setUniforms.mock.lastCall?.[0].u_shapeCount).toBe(0)
      expect(document.getElementById('card')?.dataset.studioGlassRendered).toBeUndefined()
      wrapper.unmount()
    })

    it('declines it whichever overflow axis is clipped, and for a hidden ancestor too', async () => {
      for (const overflow of ['auto', 'scroll', 'hidden', 'overflow-y: auto', 'overflow-x: scroll']) {
        const style = overflow.includes(':') ? overflow : `overflow: ${overflow}`
        const { wrapper } = await mountWith(`
          <div id="scroller" style="${style}">
            <div id="card" class="player-bar surface-glass" data-rect="10,10,70,14" style="border-radius: 12px"></div>
          </div>
        `)

        expect(document.getElementById('card')?.dataset.studioGlassRendered).toBeUndefined()
        wrapper.unmount()
      }
    })

    it('still accepts a surface whose own box is the scroller', async () => {
      // Advanced Filters scrolls its own content. Its own rect is already its visible
      // box, so nothing outside it is ever painted and it needs no external clip.
      const { wrapper } = await mountWith(`
        <section id="filters" data-advanced-filters data-rect="10,10,70,30" style="overflow: auto; border-radius: 12px"></section>
      `)

      expect(rendered()).toEqual(['filters'])
      wrapper.unmount()
    })

    it('leaves no stale rendered flag on a surface that stops qualifying', async () => {
      const { wrapper } = await mountWith(`
        <div id="player" class="player-bar surface-glass" data-rect="10,30,80,16" style="border-radius: 12px"></div>
      `)
      expect(rendered()).toEqual(['player'])

      // The hub is a CSS page, not a shader layer, so it must not strip the player.
      document.body.insertAdjacentHTML('afterbegin', '<div id="hub" class="overlay-sheet surface-glass" data-rect="5,5,90,44" style="border-radius: 20px"></div>')
      await settle()

      expect(document.getElementById('player')?.dataset.studioGlassRendered).toBe('true')
      expect(document.getElementById('hub')?.dataset.studioGlassRendered).toBeUndefined()
      wrapper.unmount()
    })
  })

  it('falls back to CSS material and stops scheduling after a render failure', async () => {
    mocks.throwRender = true
    const wrapper = mount(StudioGlassCanvas, { props: { lowPower: false } })
    await flushPromises()

    expect(document.documentElement.dataset.studioGlass).toBeUndefined()
    expect(mocks.instances[0].dispose).toHaveBeenCalledTimes(1)
    expect(vi.mocked(requestAnimationFrame)).not.toHaveBeenCalled()
    expect(document.querySelector('[data-studio-glass-rendered]')).toBeNull()
    wrapper.unmount()
  })
})
