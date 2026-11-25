import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, nextTick, ref } from 'vue'
import { glassEnvironment, resolveGlassEnvironment, type GlassProbe } from './glassEnvironment'
import { glassHeroStates, RESIZE_DEBOUNCE_MS, resetGlassRefractionCache, useGlassRefraction } from './useGlassRefraction'

const probe: GlassProbe = {
  backdrop: true, chromium: true, urlBackdrop: true, mobile: false, reducedMotion: false, reducedTransparency: false,
  contrastMore: false, forcedColors: false, cores: 8, memory: 8, saveData: false, slowUpdate: false, resizeObserver: true,
}
const svg = () => resolveGlassEnvironment(probe, { enabled: true, defaultOn: { desktop: true, mobile: true }, stored: null })
const none = () => resolveGlassEnvironment(probe, { enabled: true, defaultOn: { desktop: true, mobile: true }, stored: 'off' })

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  disconnected = false
  target?: Element
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(target: Element) {
    this.target = target
  }
  disconnect() {
    this.disconnected = true
  }
  emit(width: number, height: number) {
    this.callback([{ borderBoxSize: [{ inlineSize: width, blockSize: height }] } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

let decode: () => Promise<void>
let images = 0

const Hero = defineComponent({
  setup() {
    const root = ref<HTMLElement>()
    useGlassRefraction(root, 'focus')
    return () => h('section', { ref: root, 'data-glass-hero': 'focus', style: 'border-top-left-radius: 26px' })
  },
})
// Stands in for GlassEnvironment.vue: renders the filter for phase resolved or ready.
const Defs = defineComponent({
  setup() {
    const state = computed(() => glassHeroStates().get('focus'))
    return () => (state.value && state.value.phase !== 'idle'
      ? h('svg', [h('filter', { id: 'lg-refract-focus', 'data-width': state.value.w })])
      : h('span'))
  },
})

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeResizeObserver.instances = []
  images = 0
  decode = () => Promise.resolve()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  vi.stubGlobal('Image', class {
    src = ''
    constructor() {
      images += 1
    }
    decode() {
      return decode()
    }
  })
  resetGlassRefractionCache()
})

afterEach(() => {
  glassEnvironment.value = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function mountHero(withDefs = true) {
  return mount(defineComponent({ render: () => h('div', [h(Hero), withDefs ? h(Defs) : null]) }), { attachTo: document.body })
}

function heroElement(): HTMLElement {
  return document.querySelector('[data-glass-hero="focus"]') as HTMLElement
}

/** jsdom does not scroll: set scrollTop and fire the event the browser would. */
function scrollTo(element: HTMLElement, top: number): void {
  Object.defineProperty(element, 'scrollTop', { configurable: true, get: () => top })
  element.dispatchEvent(new Event('scroll'))
}

async function reachReady(observer: FakeResizeObserver, width = 544, height = 52): Promise<void> {
  observer.emit(width, height)
  vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS)
  await settle()
}

describe('useGlassRefraction', () => {
  it('holds no observer, timer or attribute while the gate is off', async () => {
    glassEnvironment.value = none()
    mountHero()
    await settle()
    expect(FakeResizeObserver.instances).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(heroElement().dataset.glassRefract).toBeUndefined()
    expect(glassHeroStates().has('focus')).toBe(false)
  })

  it('writes ready only once the filter for the matched set is in the DOM', async () => {
    glassEnvironment.value = svg()
    mountHero()
    await settle()
    const [observer] = FakeResizeObserver.instances
    expect(observer.target).toBe(heroElement())
    await reachReady(observer)
    expect(document.getElementById('lg-refract-focus')).not.toBeNull()
    expect(heroElement().dataset.glassRefract).toBe('ready')
    expect(glassHeroStates().get('focus')).toMatchObject({ phase: 'ready', w: 544, h: 52, set: { radius: 26, bezel: 16 } })
    expect(images).toBe(8)
  })

  it('stays resolved, without the attribute, when no filter node is rendered', async () => {
    glassEnvironment.value = svg()
    mountHero(false)
    await settle()
    await reachReady(FakeResizeObserver.instances[0])
    expect(glassHeroStates().get('focus')?.phase).toBe('resolved')
    expect(heroElement().dataset.glassRefract).toBeUndefined()
  })

  it('never becomes ready when a tile decode is rejected', async () => {
    decode = () => Promise.reject(new Error('blocked'))
    glassEnvironment.value = svg()
    mountHero()
    await settle()
    await reachReady(FakeResizeObserver.instances[0])
    expect(glassHeroStates().get('focus')?.phase).toBe('idle')
    expect(heroElement().dataset.glassRefract).toBeUndefined()
    expect(document.getElementById('lg-refract-focus')).toBeNull()
  })

  it('keeps plain blur for a box that matches no tile set', async () => {
    glassEnvironment.value = svg()
    mountHero()
    await settle()
    // A 40 px tall bar clamps the 26 px radius to 20 px, which no focus set matches.
    await reachReady(FakeResizeObserver.instances[0], 544, 40)
    expect(glassHeroStates().get('focus')?.phase).toBe('idle')
    expect(heroElement().dataset.glassRefract).toBeUndefined()
  })

  it('removes ready during a resize and restores it with the new geometry', async () => {
    glassEnvironment.value = svg()
    mountHero()
    await settle()
    const [observer] = FakeResizeObserver.instances
    await reachReady(observer)
    observer.emit(600, 52)
    expect(heroElement().dataset.glassRefract).toBeUndefined()
    vi.advanceTimersByTime(RESIZE_DEBOUNCE_MS)
    await settle()
    expect(heroElement().dataset.glassRefract).toBe('ready')
    expect(glassHeroStates().get('focus')).toMatchObject({ phase: 'ready', w: 600 })
  })

  it('disconnects when the gate turns off and returns to ready without new decodes', async () => {
    glassEnvironment.value = svg()
    mountHero()
    await settle()
    const [observer] = FakeResizeObserver.instances
    await reachReady(observer)
    expect(images).toBe(8)
    glassEnvironment.value = none()
    await settle()
    expect(observer.disconnected).toBe(true)
    expect(heroElement().dataset.glassRefract).toBeUndefined()
    expect(glassHeroStates().has('focus')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    glassEnvironment.value = svg()
    await settle()
    await reachReady(FakeResizeObserver.instances[1])
    expect(heroElement().dataset.glassRefract).toBe('ready')
    expect(images).toBe(8)
  })

  it('holds resolved while its own box is scrolled and returns to ready at the top', async () => {
    glassEnvironment.value = svg()
    mountHero()
    await settle()
    await reachReady(FakeResizeObserver.instances[0])
    expect(heroElement().dataset.glassRefract).toBe('ready')
    scrollTo(heroElement(), 60)
    expect(heroElement().dataset.glassRefract).toBeUndefined()
    expect(glassHeroStates().get('focus')).toMatchObject({ phase: 'resolved', w: 544, h: 52 })
    // The filter stays rendered, so the way back needs no decode.
    await settle()
    expect(document.getElementById('lg-refract-focus')).not.toBeNull()
    scrollTo(heroElement(), 0)
    await settle()
    expect(heroElement().dataset.glassRefract).toBe('ready')
    expect(images).toBe(8)
  })

  it('never writes ready while the box is scrolled', async () => {
    glassEnvironment.value = svg()
    mountHero()
    await settle()
    scrollTo(heroElement(), 30)
    await reachReady(FakeResizeObserver.instances[0])
    expect(glassHeroStates().get('focus')?.phase).toBe('resolved')
    expect(heroElement().dataset.glassRefract).toBeUndefined()
    scrollTo(heroElement(), 0)
    await settle()
    expect(heroElement().dataset.glassRefract).toBe('ready')
  })

  it('cleans up on unmount', async () => {
    glassEnvironment.value = svg()
    const wrapper = mountHero()
    await settle()
    const [observer] = FakeResizeObserver.instances
    await reachReady(observer)
    const element = heroElement()
    const removed = vi.spyOn(element, 'removeEventListener')
    wrapper.unmount()
    expect(observer.disconnected).toBe(true)
    expect(glassHeroStates().has('focus')).toBe(false)
    expect(removed).toHaveBeenCalledWith('scroll', expect.any(Function))
  })
})
