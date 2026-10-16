<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  DEFAULT_STUDIO_BLUR, DEFAULT_STUDIO_EDGE, DEFAULT_STUDIO_GLASS_GRAY, MAX_STUDIO_BLUR, MAX_STUDIO_EDGE, MAX_STUDIO_GLASS_GRAY,
  MIN_STUDIO_BLUR, MIN_STUDIO_EDGE, MIN_STUDIO_GLASS_GRAY,
} from '../../stores/preferences'
import { MultiPassRenderer, computeGaussianKernelByRadius } from './renderer/MultiPassRenderer'
import { studioVertexShader } from './shaders/studio-vertex.glsl'
import { studioFragmentBgShader } from './shaders/studio-fragment-bg.glsl'
import { studioFragmentBgVblurShader } from './shaders/studio-fragment-bg-vblur.glsl'
import { studioFragmentBgHblurShader } from './shaders/studio-fragment-bg-hblur.glsl'
import { studioFragmentMainShader } from './shaders/studio-fragment-main.glsl'
import { studioCornerRadiusCss, studioEdgeDispersion } from './studioOptics'

const props = withDefaults(defineProps<{ blurRadius?: number; glassGray?: number; edge?: number; lowPower: boolean; plate?: boolean }>(), {
  blurRadius: DEFAULT_STUDIO_BLUR,
  glassGray: DEFAULT_STUDIO_GLASS_GRAY,
  edge: DEFAULT_STUDIO_EDGE,
  plate: false,
})
const host = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const animatedBackdrop = ref(!!document.querySelector('[data-scene-backdrop] video'))
let renderer: MultiPassRenderer | null = null
let rendererCanvas: HTMLCanvasElement | null = null
let raf: number | null = null
let disposed = false
let resizeObserver: ResizeObserver | null = null
let mutationObserver: MutationObserver | null = null
let motionQuery: MediaQueryList | null = null
let reducedMotion = false
let sceneTexture: WebGLTexture | null = null
let sceneImage: HTMLImageElement | null = null
let sceneReady = false
let loadedSceneKey = ''
let backdropObserver: MutationObserver | null = null
// Identifies the scene texture's contents. The texture object is opaque, so a
// counter stands in for it when deciding whether a frame would change pixels.
let sceneVersion = 0
let renderedSignature: string | null = null
const sceneTextureSize = { x: 1, y: 1 }
const renderedSurfaces = new Set<HTMLElement>()
const MAX_SHAPES = 16
const MAX_RENDER_DPR = 2
// Shadow uniforms live here rather than inline in the uniform payload so the
// off-canvas cull margin below is derived from the same numbers the shader uses.
const SHADOW_EXPAND = 25
const SHADOW_FACTOR = 0.15
const SHADOW_POSITION: [number, number] = [0, 10]
// studio-fragment-bg.glsl computes shadow = exp(-|sdf| / SHADOW_EXPAND) * 0.6 * SHADOW_FACTOR
// in CSS pixels, so a surface stops contributing once that term falls below one
// 8-bit step. Solving 0.6 * SHADOW_FACTOR * exp(-d / SHADOW_EXPAND) < 1/255 gives the
// distance past which a surface provably cannot tint a single canvas pixel. The blur
// radius widens where that shadow lands, so it is added too, and the whole thing is
// doubled to stay clear of the smin() merge softening.
//
// SHADOW_POSITION is included for the same margin even though the shader declares
// u_shadowPosition without reading it, so the offset is not applied to anything. That
// dead contract is a deliberate, documented decision rather than an oversight -- see
// the header of studio-fragment-bg.glsl.ts. Budgeting for it keeps the margin correct
// if the shader ever starts honouring the offset, and erring wide by 10px only ever
// keeps a surface that could have been culled, so the safe direction is also the cheap
// one. Do not drop this term to tighten the margin; the saving is not worth the risk.
const SHADOW_REACH = SHADOW_EXPAND * Math.log(0.6 * SHADOW_FACTOR * 255)
const OFFSCREEN_MARGIN = Math.ceil((SHADOW_REACH + MAX_STUDIO_BLUR + Math.abs(SHADOW_POSITION[1])) * 2)
const normaliseBlurRadius = (value: number): number => Math.min(MAX_STUDIO_BLUR, Math.max(MIN_STUDIO_BLUR, Math.round(value)))
// The shader takes a 0..1 fraction, so the percentage preference is clamped to its
// declared bounds here rather than trusting the caller.
const normaliseGlassGray = (value: number): number => (
  Math.min(MAX_STUDIO_GLASS_GRAY, Math.max(MIN_STUDIO_GLASS_GRAY, Number.isFinite(value) ? value : DEFAULT_STUDIO_GLASS_GRAY)) / MAX_STUDIO_GLASS_GRAY
)
const normaliseEdge = (value: number): number => (
  studioEdgeDispersion(Number.isFinite(value)
    ? Math.min(MAX_STUDIO_EDGE, Math.max(MIN_STUDIO_EDGE, value))
    : DEFAULT_STUDIO_EDGE)
)
let activeBlurRadius = normaliseBlurRadius(props.blurRadius)
let activeGlassGray = normaliseGlassGray(props.glassGray)
let activeEdgeDispersion = normaliseEdge(props.edge)
let blurWeights = computeGaussianKernelByRadius(activeBlurRadius)
/**
 * The top-level semantic surfaces, each with the layer it occupies.
 *
 * The ranks mirror the --layer-workspace-* tokens in tokens.css, because that is already
 * the product's statement about what sits in front of what. They are duplicated here
 * rather than read from CSS per frame: resolving five custom properties on every surface
 * on every frame would cost more than the whole cull it feeds.
 *
 * `.settings-sheet__section` is deliberately absent. Those cards are nested inside the
 * hub's scrolling panel, and a card inset within the hub is further from every edge than
 * the hub itself, so a union always prefers the hub's field and the card contributes
 * nothing visible -- while still being told to drop its CSS fallback, which is what
 * flattened the panel into one unstructured sheet. They are CSS glass, which is what
 * gives the panel its several clear rectangular sections.
 *
 * The chat window replaced the fixed chat panel, so the glass surface moved with the
 * rounded corner it owns: the window is the surface now, and the availability content
 * inside it carries none. The centred Control Center is an .overlay-sheet, so it is
 * already covered by the entry that serves the edge-anchored sheets.
 */
const STUDIO_SURFACE_LAYERS: { selector: string; rank: number }[] = [
  // The Control Centre stays a CSS page. A shader copy of that sheet is a second
  // glass page sitting under the real settings.
  { selector: '[data-advanced-filters]', rank: 20 },
  { selector: '.queue-drawer.liquid-popover, .focus-bar__sleep-popover.liquid-popover', rank: 8 },
  { selector: '.focus-bar', rank: 4 },
  { selector: '.chat-window.surface-glass, .chat-window.liquid-popover', rank: 3 },
  { selector: '.player-bar.surface-glass, .player-bar.liquid-shell', rank: 2 },
]
const STUDIO_SURFACE_SELECTOR = STUDIO_SURFACE_LAYERS.map(({ selector }) => selector).join(', ')
type GlassShape = { element: HTMLElement; x: number; y: number; w: number; h: number; radius: number }
type Candidate = { element: HTMLElement; rect: DOMRect; rank: number }

function isHidden(): boolean { return document.hidden || document.visibilityState === 'hidden' }
function renderDpr(): number {
  if (props.lowPower || reducedMotion) return 1
  // A 100% Windows display reports a device ratio of 1. Sampling the curve at
  // that ratio leaves a one-pixel stair. Floor the glass buffer at MAX_RENDER_DPR
  // so the analytic edge is supersampled, then let CSS scale it back down.
  return Math.min(MAX_RENDER_DPR, Math.max(window.devicePixelRatio || 1, MAX_RENDER_DPR))
}
function setStudioGlassActive(active: boolean): void {
  // A plate is one surface inside a dialog. It must not switch the workspace renderer off.
  if (props.plate) return
  if (active) document.documentElement.dataset.studioGlass = 'active'
  else if (document.documentElement.dataset.studioGlass === 'active') delete document.documentElement.dataset.studioGlass
}
function updateRenderedSurfaces(elements: HTMLElement[]): void {
  const next = new Set(elements)
  for (const element of renderedSurfaces) if (!next.has(element)) delete element.dataset.studioGlassRendered
  for (const element of next) element.dataset.studioGlassRendered = 'true'
  renderedSurfaces.clear(); next.forEach((element) => renderedSurfaces.add(element))
}
function clearRenderedSurfaces(): void {
  for (const element of renderedSurfaces) delete element.dataset.studioGlassRendered
  renderedSurfaces.clear()
}
function configureTexture(gl: WebGL2RenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}
function loadSceneTexture(gl: WebGL2RenderingContext): void {
  sceneTexture = gl.createTexture()
  if (!sceneTexture) { disableRenderer(); return }
  gl.bindTexture(gl.TEXTURE_2D, sceneTexture)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([40, 50, 70, 255]))
  configureTexture(gl)
  // A neutral texture is valid while the actual selected backdrop loads.
  // Never seed the glass with the site's former room artwork.
  sceneReady = true
  const image = new Image(); sceneImage = image
  image.onload = () => {
    if (disposed || renderer?.getGL() !== gl || sceneImage !== image || !sceneTexture) return
    gl.bindTexture(gl.TEXTURE_2D, sceneTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    configureTexture(gl)
    sceneTextureSize.x = image.naturalWidth; sceneTextureSize.y = image.naturalHeight; sceneReady = true
    sceneVersion += 1
    renderFrame()
  }
  image.onerror = () => {
    if (disposed || sceneImage !== image) return
    disableRenderer()
  }
  loadedSceneKey = ''
  syncSceneSource()
}
function sameScene(left: string, right: string): boolean {
  if (left === right) return true
  try {
    return new URL(left, window.location.href).href === new URL(right, window.location.href).href
  } catch {
    return false
  }
}
function syncBackdropKind(): void {
  animatedBackdrop.value = !!document.querySelector('[data-scene-backdrop] video')
}
function watchBackdrop(): void {
  if (backdropObserver || typeof MutationObserver !== 'function') return
  const node = document.querySelector('[data-scene-backdrop]')
  if (!node) return
  syncBackdropKind()
  backdropObserver = new MutationObserver(() => { syncBackdropKind(); scheduleRender() })
  backdropObserver.observe(node, { attributes: true, childList: true, subtree: true, attributeFilter: ['src', 'class'] })
}
function syncSceneSource(): void {
  const gl = renderer?.getGL()
  if (!gl || !sceneTexture) return
  watchBackdrop()
  // The real video remains the only animated scene. CSS glass follows it without
  // copying frames into a second full-screen, four-pass, supersampled renderer.
  if (document.querySelector('[data-scene-backdrop] video')) { syncBackdropKind(); disableRenderer(); return }
  const image = document.querySelector<HTMLImageElement>('[data-scene-backdrop] img')
  const url = image?.currentSrc || image?.getAttribute('src') || ''
  if (!url || !sceneImage || sameScene(url, loadedSceneKey)) return
  loadedSceneKey = url
  sceneImage.src = url
}
// Scrolled-out settings sections keep their real layout rects, so without this a
// surface nobody can see still consumes one of the MAX_SHAPES slots and one branch
// of the per-fragment SDF loop.
function intersectsCanvas(rect: DOMRect, hostRect: DOMRect): boolean {
  return rect.right > hostRect.left - OFFSCREEN_MARGIN
    && rect.left < hostRect.right + OFFSCREEN_MARGIN
    && rect.bottom > hostRect.top - OFFSCREEN_MARGIN
    && rect.top < hostRect.bottom + OFFSCREEN_MARGIN
}
function clips(value: string): boolean { return value === 'auto' || value === 'scroll' || value === 'hidden' }
// The longhands and the shorthand, because the two disagree about which is populated:
// a browser expands `overflow: auto` into both axes, while jsdom leaves the longhands
// empty and reports only what was authored. Reading all three is correct in both.
function clipsAnyAxis(style: CSSStyleDeclaration): boolean {
  return clips(style.overflowX) || clips(style.overflowY) || clips(style.overflow)
}
/**
 * Whether a clipping ancestor cuts this surface somewhere the canvas would still paint it.
 *
 * The canvas covers its host and knows nothing about DOM clipping, so a surface inside a
 * scroller is painted at its layout position whether or not that position is still
 * visible: the DOM clips the card and the glass carries on, which is how glass came to
 * appear outside the Control Center as its panel scrolled.
 *
 * An ancestor that also contains the host is not a problem, and that distinction is what
 * makes this usable at all -- `.study-workspace` is `overflow: hidden` and is an ancestor
 * of every surface here, but the host is inside it too, so its clip bounds the canvas
 * equally and nothing can escape through it. Only a clip *between* the surface and the
 * host can be escaped, and then only where it actually cuts: Advanced Filters sits inside
 * an `overflow: hidden` popover that is sized to hold it, so nothing is ever cut there.
 *
 * Declining is the whole fix. Propagating a per-shape clip rectangle into the shader would
 * mean a second uniform array, a per-fragment test against it in every pass, and a
 * meaning for "clipped" that the merge in the field cannot express anyway. Nothing the
 * product renders needs it, so the smaller architecture is also the correct one.
 */
function isCutByClipAncestor(element: HTMLElement, rect: DOMRect): boolean {
  const canvasHost = host.value
  if (!canvasHost) return false
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent.contains(canvasHost)) continue
    if (!clipsAnyAxis(window.getComputedStyle(parent))) continue
    const clip = parent.getBoundingClientRect()
    // One pixel of tolerance: sub-pixel layout puts a fitted child a hair past its
    // parent's rounded edge often enough that a zero threshold would reject surfaces
    // nothing actually cuts.
    if (rect.top < clip.top - 1 || rect.bottom > clip.bottom + 1
      || rect.left < clip.left - 1 || rect.right > clip.right + 1) return true
  }
  return false
}
function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}
function collectPlateShape(): GlassShape[] {
  const plate = host.value
  const parent = plate?.parentElement
  if (!plate || !parent) return []
  const rect = plate.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return []
  const dpr = renderDpr()
  const specified = Number.parseFloat(getComputedStyle(parent).borderRadius)
  const radius = studioCornerRadiusCss(Number.isFinite(specified) ? specified : Number.NaN, rect.width, rect.height)
  return [{ element: parent, x: 0, y: 0, w: rect.width * dpr, h: rect.height * dpr, radius: radius * dpr }]
}
function collectGlassShapes(): GlassShape[] {
  if (props.plate) return collectPlateShape()
  if (!host.value) return []
  const hostRect = host.value.getBoundingClientRect(); const dpr = renderDpr()
  const candidates: Candidate[] = []
  for (const { selector, rank } of STUDIO_SURFACE_LAYERS) {
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      const rect = element.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2) return
      if (!intersectsCanvas(rect, hostRect)) return
      if (isCutByClipAncestor(element, rect)) return
      candidates.push({ element, rank, rect })
    })
  }
  /**
   * One distance field carries one layer.
   *
   * A union has no concept of in front: every shape it takes belongs to the same
   * silhouette, so a modal that overlaps the top bar does not cover it, it fuses with it,
   * and the seams become the concave fillets the surfaces were reported to collapse into.
   * The field therefore takes the frontmost surface over any region and leaves the ones it
   * covers to their CSS glass -- a first-class material here, not a degraded path, and
   * behind a dimmed backdrop in the case that matters.
   *
   * The cost is one rectangle overlap test per pair of surfaces. There are at most a
   * handful, it runs on the CPU beside the geometry collection that is already happening,
   * and it strictly lowers the shape count -- so it removes work from the per-fragment SDF
   * loop rather than adding a pass. Nothing about the render graph changes.
   */
  const owned = candidates.filter((candidate) => !candidates.some(
    (other) => other.rank > candidate.rank && overlaps(candidate.rect, other.rect),
  ))
  // DOM order within a layer, and layers back to front, so a stable shape order keeps the
  // pixel signature comparable between frames that changed nothing.
  owned.sort((a, b) => (a.rank - b.rank) || (a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1))
  return owned.slice(0, MAX_SHAPES).map(({ element, rect }) => {
    const parsedRadius = Number.parseFloat(window.getComputedStyle(element).borderRadius)
    const radius = studioCornerRadiusCss(Number.isFinite(parsedRadius) ? parsedRadius : Number.NaN, rect.width, rect.height)
    return { element, x: (rect.left - hostRect.left) * dpr, y: (hostRect.height - (rect.bottom - hostRect.top)) * dpr,
      w: rect.width * dpr, h: rect.height * dpr, radius: radius * dpr }
  })
}
// Derived from the uniform payload itself rather than a hand-listed set of fields,
// so a uniform added later takes part automatically instead of being silently
// ignored. Anything opaque that is not the scene texture yields null, which forces
// a render: unknown state must never be mistaken for unchanged state.
function pixelSignature(uniforms: Record<string, unknown>): string | null {
  const parts = [`scene:${sceneVersion}`]
  for (const name of Object.keys(uniforms).sort()) {
    const value = uniforms[name]
    if (value === sceneTexture) continue
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') parts.push(`${name}:${String(value)}`)
    else if (Array.isArray(value) || value instanceof Float32Array) parts.push(`${name}:${Array.from(value as ArrayLike<number>).join(',')}`)
    else return null
  }
  return parts.join('|')
}
function renderFrame(): boolean {
  if (!renderer || !canvasRef.value || !sceneTexture || isHidden()) return false
  syncSceneSource()
  if (!sceneReady) return false
  const dpr = renderDpr(); const shapes = collectGlassShapes(); const shapeCount = Math.min(shapes.length, MAX_SHAPES)
  const centers = new Float32Array(MAX_SHAPES * 2); const sizes = new Float32Array(MAX_SHAPES * 2)
  const radii = new Float32Array(MAX_SHAPES); const roundness = new Float32Array(MAX_SHAPES)
  for (let index = 0; index < MAX_SHAPES; index += 1) {
    const shape = shapes[index]
    if (shape) { centers[index * 2] = shape.x + shape.w / 2; centers[index * 2 + 1] = shape.y + shape.h / 2
      sizes[index * 2] = shape.w; sizes[index * 2 + 1] = shape.h; radii[index] = shape.radius }
    roundness[index] = 4
  }
  try {
    const uniforms: Record<string, unknown> = {
      u_resolution: [canvasRef.value.width, canvasRef.value.height], u_dpr: dpr,
      u_shapeCount: shapeCount, u_shapeCenters: centers, u_shapeSizes: sizes, u_shapeRadius: radii, u_shapeRoundness: roundness,
      u_shadowExpand: SHADOW_EXPAND, u_shadowFactor: SHADOW_FACTOR, u_shadowPosition: SHADOW_POSITION,
      u_blurRadius: activeBlurRadius, u_blurWeights: blurWeights, u_tint: [1, 1, 1, 0],
      u_glassGray: activeGlassGray,
      u_refThickness: 20, u_refFactor: 1.4, u_refDispersion: activeEdgeDispersion, u_refFresnelRange: 30, u_refFresnelFactor: 0.2,
      u_refFresnelHardness: 0.2, u_glareRange: 30, u_glareConvergence: 0.5, u_glareOppositeFactor: 0.8,
      u_glareFactor: 0.9, u_glareHardness: 0.2, u_glareAngle: -45 * Math.PI / 180, u_blurEdge: 1,
      STEP: 9,
      u_sceneTexture: sceneTexture, u_sceneTextureSize: [sceneTextureSize.x, sceneTextureSize.y],
    }
    // Surface bookkeeping is cheap and tracks element identity, which the signature
    // deliberately ignores, so it runs whether or not the GPU is asked to redraw.
    updateRenderedSurfaces(shapes.slice(0, shapeCount).map(({ element }) => element)); setStudioGlassActive(true)
    const signature = pixelSignature(uniforms)
    if (signature !== null && signature === renderedSignature) return true
    renderer.setUniforms(uniforms); renderer.render(); renderedSignature = signature
  } catch { disableRenderer(); return false }
  return true
}
function scheduleRender(): void {
  if (raf !== null || !renderer || isHidden()) return
  raf = requestAnimationFrame(() => { raf = null; renderFrame() })
}
function cancelScheduledRender(): void { if (raf !== null) { cancelAnimationFrame(raf); raf = null } }
function resize(): void {
  if (!renderer || !host.value || !canvasRef.value) return
  const rect = host.value.getBoundingClientRect(); const dpr = renderDpr()
  const width = Math.max(1, Math.round(rect.width * dpr)); const height = Math.max(1, Math.round(rect.height * dpr))
  if (canvasRef.value.width !== width) canvasRef.value.width = width
  if (canvasRef.value.height !== height) canvasRef.value.height = height
  renderer.resize(width, height)
}
function releaseRenderer(): void {
  rendererCanvas?.removeEventListener('webglcontextlost', onContextLost); rendererCanvas = null
  const currentRenderer = renderer; renderer = null; const gl = currentRenderer?.getGL()
  try { if (gl && sceneTexture) gl.deleteTexture(sceneTexture) } catch { /* context may be lost */ }
  sceneTexture = null; sceneReady = false; sceneTextureSize.x = 1; sceneTextureSize.y = 1
  // Fresh GL resources share none of the retired frame's state, so the next frame
  // must draw rather than compare against it.
  renderedSignature = null
  try { currentRenderer?.dispose() } catch { /* CSS fallback remains available */ }
}
function releaseBackdrop(): void {
  backdropObserver?.disconnect(); backdropObserver = null
}
function disableRenderer(): void {
  cancelScheduledRender(); setStudioGlassActive(false); clearRenderedSurfaces()
  if (sceneImage) { sceneImage.onload = null; sceneImage.onerror = null; sceneImage = null }
  loadedSceneKey = ''
  releaseRenderer()
}
function onVisibilityChange(): void { if (isHidden()) cancelScheduledRender(); else scheduleRender() }
// Scrolling a container moves the surfaces inside it without mutating an attribute
// or resizing the host, so neither observer fires and the collected geometry goes
// stale: surfaces that scrolled off keep their slots while surfaces that scrolled in
// are missing. A `scroll` event does not bubble, but it does still travel the capture
// path (verified in Chrome for both a real wheel and a programmatic scrollTop), so one
// capture-phase listener at `window` sees every scroller without per-container wiring
// or a permanent animation loop. It is passive so it can never delay a scroll, and it
// only schedules: RAF coalescing keeps a burst to one frame, and the pixel signature
// still drops the frame if the scroll moved nothing the shader can see.
function onScroll(): void { scheduleRender() }
function onContextLost(event: Event): void { event.preventDefault(); disableRenderer() }
function onReducedMotionChange(event?: MediaQueryListEvent): void {
  reducedMotion = event?.matches ?? motionQuery?.matches ?? false; resize(); scheduleRender()
}
watch(() => props.lowPower, () => { resize(); scheduleRender() })
watch(() => props.blurRadius, (value) => {
  activeBlurRadius = normaliseBlurRadius(value)
  blurWeights = computeGaussianKernelByRadius(activeBlurRadius)
  scheduleRender()
})
// u_glassGray joins the uniform payload, so the pixel signature picks the change up
// on its own: an altered tint redraws, an unchanged one still skips the frame.
watch(() => props.glassGray, (value) => {
  activeGlassGray = normaliseGlassGray(value)
  scheduleRender()
})
watch(() => props.edge, (value) => {
  activeEdgeDispersion = normaliseEdge(value)
  scheduleRender()
})

function initialiseRenderer(): void {
  if (disposed || renderer || animatedBackdrop.value || !canvasRef.value) return
  rendererCanvas = canvasRef.value
  rendererCanvas.addEventListener('webglcontextlost', onContextLost)
  try {
    renderer = new MultiPassRenderer(canvasRef.value, [
      { name: 'bgPass', shader: { vertex: studioVertexShader, fragment: studioFragmentBgShader } },
      { name: 'vBlurPass', shader: { vertex: studioVertexShader, fragment: studioFragmentBgVblurShader }, inputs: { u_prevPassTexture: 'bgPass' } },
      { name: 'hBlurPass', shader: { vertex: studioVertexShader, fragment: studioFragmentBgHblurShader }, inputs: { u_prevPassTexture: 'vBlurPass' } },
      { name: 'mainPass', shader: { vertex: studioVertexShader, fragment: studioFragmentMainShader }, inputs: { u_blurredBg: 'hBlurPass', u_bg: 'bgPass' }, outputToScreen: true },
    ])
  } catch { disableRenderer(); return }
  const gl = renderer.getGL(); if (!gl) { disableRenderer(); return }
  loadSceneTexture(gl); if (!renderer) return; resize(); renderFrame()
}
watch(animatedBackdrop, (animated) => { if (animated) disableRenderer(); else initialiseRenderer() }, { flush: 'post' })

onMounted(() => {
  if (!host.value) return
  setStudioGlassActive(false); clearRenderedSurfaces()
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })
  try {
    motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
    reducedMotion = motionQuery?.matches ?? false
    motionQuery?.addEventListener?.('change', onReducedMotionChange)
  } catch { motionQuery = null; reducedMotion = false }
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => { resize(); scheduleRender() }); resizeObserver.observe(host.value)
  }
  if (typeof MutationObserver === 'function' && host.value.parentElement) {
    mutationObserver = new MutationObserver(() => scheduleRender())
    mutationObserver.observe(host.value.parentElement, { attributes: true, attributeFilter: ['aria-expanded', 'class', 'hidden', 'style'], childList: true, subtree: true })
  }
  watchBackdrop(); initialiseRenderer()
})

onBeforeUnmount(() => {
  disposed = true; cancelScheduledRender(); resizeObserver?.disconnect(); resizeObserver = null
  mutationObserver?.disconnect(); mutationObserver = null; releaseBackdrop(); motionQuery?.removeEventListener?.('change', onReducedMotionChange); motionQuery = null
  document.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('scroll', onScroll, { capture: true })
  canvasRef.value?.removeEventListener('webglcontextlost', onContextLost); disableRenderer()
})
</script>

<template>
  <div ref="host" class="studio-glass-canvas" :class="{ 'studio-glass-canvas--plate': plate }" data-studio-glass-canvas aria-hidden="true">
    <canvas v-if="!animatedBackdrop" ref="canvasRef" aria-hidden="true" />
  </div>
</template>

<style scoped src="./StudioGlassCanvas.css"></style>
