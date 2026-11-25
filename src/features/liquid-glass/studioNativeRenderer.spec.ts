import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStudioNativeRenderer, MAX_STUDIO_SURFACES } from './studioNativeRenderer'

let stop: (() => void) | undefined
let resolveImages: (() => void)[]
let rejectImages: (() => void)[]
let observers: { callback: ResizeObserverCallback; observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[]
let sources: string[]
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function surface(attribute = 'data-studio-glass-surface', parent = document.body) {
  const element = document.createElement('section')
  element.setAttribute(attribute, '')
  element.style.cssText = 'position:relative;border-top-left-radius:32px;z-index:1'
  element.getBoundingClientRect = () => ({ x: 20, y: 20, left: 20, top: 20, right: 620, bottom: 420, width: 600, height: 400, toJSON: () => ({}) })
  parent.append(element)
  return element
}
function start(edge = 68) {
  const renderer = createStudioNativeRenderer(edge); stop = renderer.destroy; return renderer
}
async function decodeAll() { for (const resolve of resolveImages.splice(0)) resolve(); await flush() }
beforeEach(() => {
  vi.useFakeTimers(); resolveImages = []; rejectImages = []; sources = []; observers = []
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.stubGlobal('Image', class {
    set src(value: string) { sources.push(value) }
    decode() { return new Promise<void>((resolve, reject) => { resolveImages.push(resolve); rejectImages.push(() => reject(new Error('decode blocked'))) }) }
  })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { observers.push({ callback, observe: this.observe, unobserve: this.unobserve, disconnect: this.disconnect }) }
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn()
  })
})
afterEach(() => { stop?.(); stop = undefined; document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('single Studio native backdrop renderer', () => {
  it('waits for same-origin tile decoding before enabling a live backdrop overlay', async () => {
    const element = surface('data-glass-hero'); start()
    expect(element.dataset.studioGlassReady).toBeUndefined()
    expect(element.querySelector('.studio-native-glass-overlay')?.getAttribute('aria-hidden')).toBe('true')
    expect(sources.length).toBe(8)
    expect(sources.every(src => src.startsWith('/glass/refraction/') && !src.includes(':'))).toBe(true)
    await decodeAll()
    expect(element.dataset.studioGlassReady).toBe('true')
    expect(document.querySelectorAll('feImage')).toHaveLength(8)
    expect(document.querySelectorAll('feDisplacementMap')).toHaveLength(1)
    expect(document.querySelector('feFuncR')?.getAttribute('intercept')).toBe(String(-1 / 510))
    expect(document.querySelector('canvas, video, iframe')).toBeNull()
  })
  it('keeps the ready overlay and decoded map on unchanged resize notifications', async () => {
    const element = surface('data-glass-hero'); start(); await decodeAll()
    const overlay = element.querySelector<HTMLElement>('.studio-native-glass-overlay')!
    const filter = document.querySelector('filter')!
    const images = [...filter.querySelectorAll('feImage')]
    for (let tick = 0; tick < 5; tick++) {
      observers[0]!.callback([{ target: element, contentRect: element.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], {} as ResizeObserver)
      expect(element.dataset.studioGlassReady).toBe('true')
      expect(overlay.hidden).toBe(false)
      await vi.advanceTimersByTimeAsync(100)
    }
    expect([...filter.querySelectorAll('feImage')]).toEqual(images)
    expect(sources).toHaveLength(8)
  })
  it('invalidates a genuinely resized box and builds only its current geometry', async () => {
    const element = surface(); start(); await decodeAll()
    const overlay = element.querySelector<HTMLElement>('.studio-native-glass-overlay')!
    const original = element.getBoundingClientRect()
    element.getBoundingClientRect = () => ({ ...original, width: 480, right: 500 })
    observers[0]!.callback([{ target: element, contentRect: element.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], {} as ResizeObserver)
    expect(overlay.hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(100); await decodeAll()
    expect(element.dataset.studioGlassReady).toBe('true')
    expect(document.querySelector('filter')!.getAttribute('width')).toBe('480')
    expect(sources).toHaveLength(8)
  })
  it('does not revive a pending map after resizing beyond supported geometry', async () => {
    const element = surface(); start()
    const original = element.getBoundingClientRect()
    const overlay = element.querySelector<HTMLElement>('.studio-native-glass-overlay')!
    const filter = document.querySelector('filter')!
    element.getBoundingClientRect = () => ({ ...original, width: 5000, right: 5020 })
    observers[0]!.callback([{ target: element, contentRect: element.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], {} as ResizeObserver)
    await vi.advanceTimersByTimeAsync(100)
    await decodeAll()
    expect(element.dataset.studioGlassReady).toBeUndefined()
    expect(overlay.hidden).toBe(true)
    expect(filter.querySelectorAll('feImage')).toHaveLength(0)
    // Returning to a valid size uses the cached tiles and a fresh generation.
    element.getBoundingClientRect = () => ({ ...original, width: 480, right: 500 })
    observers[0]!.callback([{ target: element, contentRect: element.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], {} as ResizeObserver)
    await vi.advanceTimersByTimeAsync(100); await flush()
    expect(element.dataset.studioGlassReady).toBe('true')
    expect(filter.getAttribute('width')).toBe('480')
    expect(sources).toHaveLength(8)
  })
  it('bounds the observer/surface count and excludes nested shells', async () => {
    const outer = surface(); const inner = surface('data-studio-glass-surface', outer)
    for (let i=0;i<12;i++) surface()
    start(); await decodeAll()
    expect(observers[0]!.observe).toHaveBeenCalledTimes(MAX_STUDIO_SURFACES)
    expect(document.querySelectorAll('[data-studio-glass-ready]')).toHaveLength(MAX_STUDIO_SURFACES)
    expect(inner.dataset.studioGlassReady).toBeUndefined()
    expect(sources.length).toBe(8) // shared tile decode, not 6 x 8
  })
  it('does not animate, capture media, or restart at Edge=0', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame'); const element = surface(); const renderer = start()
    await decodeAll(); const filter = document.querySelector('filter')
    renderer.setEdge(0); expect(document.querySelector('feDisplacementMap')?.getAttribute('scale')).toBe('0')
    renderer.setEdge(100); expect(document.querySelector('feDisplacementMap')?.getAttribute('scale')).toBe('64')
    expect(document.querySelector('filter')).toBe(filter)
    expect(raf).not.toHaveBeenCalled(); expect(observers).toHaveLength(1)
    expect(element.dataset.studioGlassReady).toBe('true')
  })
  it('gives an overflowing popover its own optical shell without double-filtering nested content', async () => {
    const hero = surface('data-glass-hero')
    const popup = surface('data-test-popup', hero)
    popup.className = 'focus-bar__advanced-popover liquid-popover'
    popup.getBoundingClientRect = () => ({ x: 20, y: 428, left: 20, top: 428, right: 420, bottom: 628, width: 400, height: 200, toJSON: () => ({}) })
    const content = surface('data-advanced-filters', popup)
    content.getBoundingClientRect = popup.getBoundingClientRect
    start(); await decodeAll()
    expect(hero.dataset.studioGlassReady).toBe('true')
    expect(popup.dataset.studioGlassReady).toBe('true')
    expect(content.dataset.studioGlassReady).toBeUndefined()
    expect(observers[0]!.observe).toHaveBeenCalledTimes(2)
  })
  it('keeps native CSS on decode/CSP failure and never retries in a resize loop', async () => {
    const element = surface(); const renderer = start()
    rejectImages.forEach(reject => reject()); await flush()
    expect(element.dataset.studioGlassReady).toBeUndefined()
    renderer.refresh(); renderer.refresh()
    expect(sources).toHaveLength(8)
    expect(document.querySelectorAll('feImage')).toHaveLength(0)
  })
  it('cannot activate a removed/unmounted surface after delayed decode', async () => {
    const element = surface(); start(); stop?.(); await decodeAll()
    expect(element.dataset.studioGlassReady).toBeUndefined()
    expect(document.querySelector('[data-studio-optics-owned]')).toBeNull()
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce()
  })
  it('restores CSS while a surface scrolls and releases hidden-page resources', async () => {
    const element = surface(); const renderer = start(); await decodeAll()
    element.scrollTop = 12; renderer.refresh()
    expect(element.dataset.studioGlassReady).toBeUndefined()
    element.scrollTop = 0; renderer.refresh(); await flush()
    expect(element.dataset.studioGlassReady).toBe('true')
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.querySelector('filter')).toBeNull()
    expect(element.querySelector('.studio-native-glass-overlay')).toBeNull()
  })
  it('discovers dialog insertion, removes detached records and cleans pending work', async () => {
    start(); const dialog = surface(); await flush(); await vi.advanceTimersByTimeAsync(100); await decodeAll()
    expect(dialog.dataset.studioGlassReady).toBe('true')
    dialog.remove(); await flush(); await vi.advanceTimersByTimeAsync(100)
    expect(document.querySelector('filter')).toBeNull()
    window.dispatchEvent(new Event('resize')); stop?.(); expect(vi.getTimerCount()).toBe(0)
  })
  it('discovers a surface when its non-surface ancestor is revealed again', async () => {
    const parent = document.createElement('div'); parent.hidden = true; document.body.append(parent)
    const element = surface('data-studio-glass-surface', parent); start()
    parent.hidden = false; await flush(); await vi.advanceTimersByTimeAsync(100); await decodeAll()
    expect(element.dataset.studioGlassReady).toBe('true')
    parent.hidden = true; await flush(); await vi.advanceTimersByTimeAsync(100)
    expect(element.dataset.studioGlassReady).toBeUndefined()
    parent.hidden = false; await flush(); await vi.advanceTimersByTimeAsync(100); await flush()
    expect(element.dataset.studioGlassReady).toBe('true')
  })
  it('drops a scrolled overlay synchronously instead of moving it through the content', async () => {
    const element = surface(); start(); await decodeAll()
    element.scrollTop = 12; element.dispatchEvent(new Event('scroll'))
    expect(element.dataset.studioGlassReady).toBeUndefined()
    expect(element.querySelector<HTMLElement>('.studio-native-glass-overlay')!.hidden).toBe(true)
  })
  it.each(['attribute', 'class'])('releases the existing record after its last %s selector is removed', async mode => {
    const element = surface()
    if (mode === 'class') { element.removeAttribute('data-studio-glass-surface'); element.className = 'overlay-sheet' }
    start(); await decodeAll()
    if (mode === 'attribute') element.removeAttribute('data-studio-glass-surface')
    else element.className = 'plain-sheet'
    await flush(); await vi.advanceTimersByTimeAsync(100)
    expect(element.dataset.studioGlassReady).toBeUndefined()
    expect(element.querySelector('.studio-native-glass-overlay')).toBeNull()
    expect(document.querySelector('filter')).toBeNull()
    expect(observers[0]!.unobserve).toHaveBeenCalledWith(element)
  })
  it('discovers a surface after an opacity entrance finishes without a DOM mutation', async () => {
    const element = surface(); element.style.opacity = '0'; start()
    // Model a CSS transition: the computed value changes, but the DOM attribute
    // need not change when @starting-style finishes.
    const style = getComputedStyle(element)
    vi.spyOn(window, 'getComputedStyle').mockImplementation(target => target === element ? { ...style, position: 'relative', opacity: '1', borderTopLeftRadius: '32px' } as CSSStyleDeclaration : style)
    const event = new Event('transitionend', { bubbles: true })
    Object.defineProperty(event, 'propertyName', { value: 'opacity' }); element.dispatchEvent(event)
    await flush(); await vi.advanceTimersByTimeAsync(100); await decodeAll()
    expect(element.dataset.studioGlassReady).toBe('true')
  })
  it('cleans partially initialised resources when an observer rejects startup', () => {
    vi.stubGlobal('MutationObserver', class { observe() { throw new Error('observer unavailable') } disconnect() {} })
    expect(() => start()).toThrow('observer unavailable')
    expect(document.querySelector('[data-studio-optics-owned]')).toBeNull()
    expect(observers[0]!.disconnect).toHaveBeenCalledOnce()
  })
  it('does not modify host layout or include hidden, static or offscreen boxes', async () => {
    const hidden = surface(); hidden.hidden = true
    const unpositioned = surface(); unpositioned.style.position = 'static'
    const outside = surface(); outside.getBoundingClientRect = () => ({ width: 100, height: 100, left: -300, right: -200, top: 0, bottom: 100 } as DOMRect)
    const element = surface(); const style = element.getAttribute('style'); start(); await decodeAll()
    expect(document.querySelectorAll('filter')).toHaveLength(1)
    expect(element.getAttribute('style')).toBe(style)
  })
})
