// Original implementation for Study with HOYO-MiX (GPL-3.0). Convex-bezel displacement tiles for
// backdrop-filter refraction; not derived from liquid-glass-studio source.
//
// Drives `data-glass-refract="ready"` on a hero surface. The CSS hero rule is the only rule that uses
// `url(#lg-refract-…)`, and it requires `ready`, so a url() never points at a missing filter (an invalid
// reference would drop the whole backdrop filter, blur included).
//
// Phases (design-review F1):
//   idle      gate is none, or no tile set matches the box: no filter, no attribute
//   resolved  a set matched and every tile decoded: GlassEnvironment.vue renders the <filter>
//   ready     the <filter> for (w, h, set) is in the DOM: the attribute is written
//
// A hero whose own box is scrolled (the expanded phone player is a scroll container on short screens)
// holds `resolved`: the hero's inner tint is an absolutely positioned ::after, which would scroll with
// the content and leave the controls on the clear rim tint. Back at the top it becomes ready again.
import { nextTick, onBeforeUnmount, reactive, watch, type Ref } from 'vue'
import { glassEnvironment } from './glassEnvironment'
import { currentProfile, matchTileSet, tileUrls, type GlassHeroId, type TileSet } from './refractionTiles'

export type HeroState =
  | { phase: 'idle' }
  | { phase: 'resolved'; w: number; h: number; set: TileSet }
  | { phase: 'ready'; w: number; h: number; set: TileSet }

const registry = reactive(new Map<GlassHeroId, HeroState>())

/** Read-only view of the registered heroes, for GlassEnvironment.vue. */
export function glassHeroStates(): ReadonlyMap<GlassHeroId, HeroState> {
  return registry
}

export const RESIZE_DEBOUNCE_MS = 150

// Decoded sets, cached for the page lifetime so later resizes and re-enables only wait for nextTick.
// A rejected decode (CSP, 404, offline) is not cached, so the next resolution may try again.
const decodedSets = new Map<string, Promise<boolean>>()

function preload(set: TileSet): Promise<boolean> {
  const key = `${set.radius}-${set.bezel}`
  const cached = decodedSets.get(key)
  if (cached) return cached
  const pending = Promise.all(Object.values(tileUrls(set)).map((url) => {
    const image = new Image()
    image.src = url
    return image.decode()
  })).then(() => true, () => {
    decodedSets.delete(key)
    return false
  })
  decodedSets.set(key, pending)
  return pending
}

/** For tests: forget decoded sets. */
export function resetGlassRefractionCache(): void {
  decodedSets.clear()
}

export function useGlassRefraction(elementRef: Ref<HTMLElement | undefined | null>, id: GlassHeroId): void {
  let observer: ResizeObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let observed: HTMLElement | undefined
  let width = 0
  let height = 0
  let generation = 0

  function clearAttribute(): void {
    if (observed?.dataset.glassRefract !== undefined) delete observed.dataset.glassRefract
  }

  function scrolled(): boolean {
    return (observed?.scrollTop ?? 0) > 0
  }

  function teardown(): void {
    generation += 1
    observer?.disconnect()
    observer = undefined
    observed?.removeEventListener('scroll', onScroll)
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    clearAttribute()
    observed = undefined
    registry.delete(id)
  }

  async function resolve(): Promise<void> {
    const element = observed
    if (!element) return
    const current = ++generation
    const radius = Number.parseFloat(getComputedStyle(element).borderTopLeftRadius)
    const set = matchTileSet(id, currentProfile(), width, height, radius)
    if (!set) {
      clearAttribute()
      registry.set(id, { phase: 'idle' })
      return
    }
    const decoded = await preload(set)
    if (current !== generation) return
    if (!decoded) {
      clearAttribute()
      registry.set(id, { phase: 'idle' })
      return
    }
    registry.set(id, { phase: 'resolved', w: width, h: height, set })
    await nextTick()
    if (current !== generation) return
    if (!document.getElementById(`lg-refract-${id}`)) return
    // Scrolled: keep the filter rendered, so returning to the top needs no new decode.
    if (scrolled()) return
    registry.set(id, { phase: 'ready', w: width, h: height, set })
    element.dataset.glassRefract = 'ready'
  }

  function onScroll(): void {
    const state = registry.get(id)
    if (!state || state.phase === 'idle') return
    if (scrolled()) {
      if (state.phase !== 'ready') return
      clearAttribute()
      registry.set(id, { phase: 'resolved', w: state.w, h: state.h, set: state.set })
      return
    }
    // Back at the top. A pending resize resolves on its own.
    if (state.phase === 'resolved' && timer === undefined) void resolve()
  }

  function onResize(entries: ResizeObserverEntry[]): void {
    const entry = entries[entries.length - 1]
    const box = entry?.borderBoxSize?.[0]
    const rect = observed?.getBoundingClientRect()
    const nextWidth = Math.round(box ? box.inlineSize : rect?.width ?? 0)
    const nextHeight = Math.round(box ? box.blockSize : rect?.height ?? 0)
    const state = registry.get(id)
    if (nextWidth === width && nextHeight === height && state && state.phase !== 'idle') return
    width = nextWidth
    height = nextHeight
    // The attribute goes first, so the hero never uses a filter region from the old geometry.
    generation += 1
    clearAttribute()
    if (state && state.phase !== 'idle') registry.set(id, { phase: 'resolved', w: width, h: height, set: state.set })
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void resolve()
    }, RESIZE_DEBOUNCE_MS)
  }

  function start(element: HTMLElement): void {
    if (observed === element && observer) return
    teardown()
    observed = element
    width = 0
    height = 0
    registry.set(id, { phase: 'idle' })
    observer = new ResizeObserver(onResize)
    observer.observe(element, { box: 'border-box' })
    element.addEventListener('scroll', onScroll, { passive: true })
  }

  watch(
    [() => glassEnvironment.value?.refraction, elementRef],
    ([refraction, element]) => {
      if (refraction === 'svg' && element) start(element)
      else teardown()
    },
    { immediate: true, flush: 'post' },
  )

  onBeforeUnmount(teardown)
}
