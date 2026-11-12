// Original native-compositor renderer (GPL-3.0). No upstream source or runtime.
import { buildStudioTiles } from './studioDisplacement'
import { studioSvgRefractionScale } from './studioSvgOptics'

export const MAX_STUDIO_SURFACES = 6
export const STUDIO_SURFACE_SELECTOR = '[data-glass-hero], [data-studio-glass-surface], .overlay-sheet, [data-advanced-filters], .chat-window.liquid-popover, .chat-window.surface-glass, .queue-drawer.liquid-popover, .focus-bar__sleep-popover.liquid-popover, .focus-bar__advanced-popover.liquid-popover'
const NS = 'http://www.w3.org/2000/svg'
let serial = 0
type Surface = { element: HTMLElement; overlay: HTMLDivElement; filter: SVGFilterElement; displacement: SVGFEDisplacementMapElement; key: string; generation: number; ready: boolean }

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const node = document.createElementNS(NS, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

/** One owner, six observed boxes, one event-coalescing timer; no frame loop. */
export function createStudioNativeRenderer(edge = 68) {
  const records = new Map<HTMLElement, Surface>()
  const root = svg('svg', { 'aria-hidden': 'true', focusable: 'false', 'data-studio-optics-owned': '', 'data-studio-filter-defs': '', width: 0, height: 0 })
  root.style.position = 'absolute'; root.style.pointerEvents = 'none'
  const defs = svg('defs', {}); root.append(defs)
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let scale = studioSvgRefractionScale(edge)
  // At most 36 same-origin tiny tiles per renderer lifetime. Failures are retained
  // until the owner is restarted: resize storms cannot become a network retry loop.
  const decoded = new Map<string, Promise<boolean>>()
  function preload(url: string) {
    let pending = decoded.get(url)
    if (!pending) {
      const image = new Image(); image.src = url
      pending = image.decode().then(() => true, () => false)
      decoded.set(url, pending)
    }
    return pending
  }
  const resize = new ResizeObserver(entries => {
    for (const entry of entries) {
      const record = records.get(entry.target as HTMLElement)
      // Notifications include the initial observation and subpixel layout noise.
      // Only invalidate when the optical geometry actually changes.
      if (record) measure(record)
    }
    schedule()
  })

  function clearReady(record: Surface) {
    record.ready = false
    record.overlay.style.backdropFilter = 'none'
    record.overlay.style.setProperty('-webkit-backdrop-filter', 'none')
    record.overlay.hidden = true
    delete record.element.dataset.studioGlassReady
  }
  function remove(element: HTMLElement) {
    const record = records.get(element)
    if (!record) return
    record.generation++; clearReady(record)
    resize.unobserve(element); record.overlay.remove(); record.filter.remove(); records.delete(element)
  }
  function add(element: HTMLElement) {
    const id = `studio-native-${++serial}`
    const filter = svg('filter', { id, x: 0, y: 0, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })
    // A byte value of 128 is 128/255, not 0.5. Remove its half-step bias so a
    // neutral centre is identity even at high Edge settings.
    const transfer = svg('feComponentTransfer', { in: 'raw-map', result: 'map' })
    for (const channel of ['feFuncR', 'feFuncG'] as const) transfer.append(svg(channel, { type: 'linear', slope: 1, intercept: -1 / 510 }))
    const displacement = svg('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G' })
    filter.append(transfer, displacement); defs.append(filter)
    const overlay = document.createElement('div')
    overlay.className = 'studio-native-glass-overlay'
    overlay.dataset.studioOpticsOwned = ''; overlay.setAttribute('aria-hidden', 'true')
    overlay.hidden = true; element.prepend(overlay)
    const record: Surface = { element, overlay, filter, displacement, key: '', generation: 0, ready: false }
    records.set(element, record); resize.observe(element)
    return record
  }
  function eligible(element: HTMLElement) {
    if (!element.isConnected || element.hidden || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    const style = getComputedStyle(element)
    // Overlay follows the existing positioned box. Never mutate host layout.
    if (style.position === 'static' || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    const rect = element.getBoundingClientRect()
    return rect.width >= 24 && rect.height >= 24 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
  }
  function measure(record: Surface) {
    const { element } = record
    if (element.scrollTop !== 0 || element.scrollLeft !== 0) { record.generation++; record.key = ''; clearReady(record); return }
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const width = element.clientWidth || Math.round(rect.width), height = element.clientHeight || Math.round(rect.height)
    const parsed = parseFloat(style.borderTopLeftRadius) || 0
    const radius = style.borderTopLeftRadius.includes('%') ? Math.min(width, height) * parsed / 100 : parsed
    const geometry = buildStudioTiles(width, height, radius)
    if (!geometry) { record.generation++; record.key = ''; clearReady(record); return }
    const key = `${width}:${height}:${geometry.radius}`
    if (record.key === key) return
    record.key = key; clearReady(record)
    const generation = ++record.generation
    // CSP/decode failure leaves native CSS untouched. Never install a dangling URL.
    void Promise.all(geometry.tiles.map(tile => preload(tile.href))).then(success => {
      if (success.some(value => !value)) return
      if (stopped || !element.isConnected || record.generation !== generation || records.get(element) !== record) return
      record.filter.setAttribute('width', String(width)); record.filter.setAttribute('height', String(height))
      for (const old of record.filter.querySelectorAll('feFlood, feImage, feMerge')) old.remove()
      const flood = svg('feFlood', { 'flood-color': 'rgb(128,128,128)', result: 'neutral' })
      const images = geometry.tiles.map(tile => svg('feImage', { href: tile.href, x: tile.x, y: tile.y, width: tile.width, height: tile.height, preserveAspectRatio: 'none', result: tile.key }))
      const merge = svg('feMerge', { result: 'raw-map' }); merge.append(svg('feMergeNode', { in: 'neutral' }))
      for (const tile of geometry.tiles) merge.append(svg('feMergeNode', { in: tile.key }))
      record.filter.prepend(flood, ...images, merge)
      record.overlay.style.borderRadius = `${geometry.radius}px`
      record.overlay.style.setProperty('--studio-native-filter', `url(#${record.filter.id})`)
      record.overlay.style.backdropFilter = `blur(var(--studio-native-blur, 1.5px)) url(#${record.filter.id})`
      record.overlay.style.setProperty('-webkit-backdrop-filter', record.overlay.style.backdropFilter)
      record.overlay.hidden = false; record.ready = true; element.dataset.studioGlassReady = 'true'
    }).catch(() => { /* CSS fallback; no retry loop on CSP or allocation failure. */ })
  }
  function refresh() {
    if (stopped) return
    if (document.hidden) { for (const element of [...records.keys()]) remove(element); return }
    const selected: HTMLElement[] = []
    // Prefer outer semantic shells. A popover can be a DOM descendant but sit
    // wholly outside its parent's painted box; it needs its own optical shell.
    // Overlapping nested settings/chat controls remain CSS-only.
    for (const element of document.querySelectorAll<HTMLElement>(STUDIO_SURFACE_SELECTOR)) {
      if (selected.length >= MAX_STUDIO_SURFACES) break
      if (!eligible(element)) continue
      const box = element.getBoundingClientRect()
      if (selected.some(parent => {
        if (!parent.contains(element)) return false
        const outer = parent.getBoundingClientRect()
        return box.left < outer.right && box.right > outer.left && box.top < outer.bottom && box.bottom > outer.top
      })) continue
      selected.push(element)
    }
    for (const element of [...records.keys()]) if (!selected.includes(element)) remove(element)
    for (const element of selected) measure(records.get(element) ?? add(element))
  }
  function schedule() {
    if (stopped || timer !== undefined) return
    timer = setTimeout(() => { timer = undefined; refresh() }, 100)
  }
  function onScroll(event: Event) {
    const record = records.get(event.target as HTMLElement)
    if (record && (record.element.scrollTop !== 0 || record.element.scrollLeft !== 0)) {
      record.generation++; record.key = ''; clearReady(record)
    }
    schedule()
  }
  function onTransition(event: Event) {
    const target = event.target
    if (target instanceof HTMLElement && (target.matches(STUDIO_SURFACE_SELECTOR) || target.querySelector(STUDIO_SURFACE_SELECTOR))) schedule()
  }
  const mutations = new MutationObserver(entries => {
    if (entries.some(entry => {
      const target = entry.target instanceof Element ? entry.target : entry.target.parentElement
      if (target?.closest('[data-studio-optics-owned]')) return false
      if (entry.type === 'attributes') return records.has(target as HTMLElement) || target?.matches(STUDIO_SURFACE_SELECTOR) || target?.querySelector(STUDIO_SURFACE_SELECTOR)
      return [...entry.addedNodes, ...entry.removedNodes].some(node => node instanceof Element && !node.hasAttribute('data-studio-optics-owned') && (node.matches(STUDIO_SURFACE_SELECTOR) || node.querySelector(STUDIO_SURFACE_SELECTOR)))
    })) schedule()
  })
  function destroy() {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    resize.disconnect(); mutations.disconnect()
    window.removeEventListener('resize', schedule); window.removeEventListener('scroll', onScroll, true)
    document.removeEventListener('visibilitychange', refresh)
    document.removeEventListener('transitionend', onTransition)
    document.removeEventListener('transitioncancel', onTransition)
    document.removeEventListener('animationend', onTransition)
    for (const element of [...records.keys()]) remove(element)
    root.remove()
  }
  try {
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'aria-hidden', 'data-studio-glass-surface', 'data-glass-hero'] })
    document.body.append(root)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    document.addEventListener('visibilitychange', refresh)
    document.addEventListener('transitionend', onTransition)
    document.addEventListener('transitioncancel', onTransition)
    document.addEventListener('animationend', onTransition)
    refresh()
  } catch (error) { destroy(); throw error }
  return {
    refresh,
    setEdge(value: number) { scale = studioSvgRefractionScale(value); for (const record of records.values()) record.displacement.setAttribute('scale', String(scale)) },
    destroy,
  }
}
