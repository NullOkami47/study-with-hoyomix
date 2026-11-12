// Original implementation for Study with HOYO-MiX (GPL-3.0).
//
// Scene tone sampling for the cinematic glass. One 24x14 drawImage + getImageData every 2.5 s (5 s on
// low-power devices) classifies the scene behind the glass as dark, mid or bright, and writes
// `html[data-scene-tone]`. glass.css maps the tone to tint, brightness and sheen.
//
// Readability timing (design-review F3): moves toward a denser, brighter-safe material apply on the
// first sample that crosses a threshold; moves toward a lighter material need two agreeing samples.
// The residual worst case after a dark-to-bright cut is therefore one sample interval (2.5 s, or 5 s
// under low power) plus the 600 ms tint transition.
//
// Accepted (F10): on the two hero surfaces in `[data-glass-refract="ready"]`, the backdrop-filter list
// contains `url()`, which does not interpolate, so their brightness step on a tone change is discrete.
// Their tint still fades through `background-color`.
//
// Cross-origin media is never drawn (the canvas never becomes tainted and `crossorigin` is not added to
// the video); such scenes stay on the bright tone, which is the safe default. Nothing is logged.

export type SceneTone = 'dark' | 'mid' | 'bright'
/**
 * Off: design risk R2 applied. AC-13 allows 4 ms of main thread per sample on a 4x-throttled phone.
 * Measured on the iPhone-size config at 4x: the first sample took 368-445 ms (it landed in the load
 * window and drove the Lighthouse TBT regression) and later samples 4.6-22.6 ms, so a longer interval
 * cannot pass. The tone therefore stays on the bright defaults (the denser, always-legible material),
 * and GlassEnvironment.vue starts no sampler. The sampler and its tests stay for a cheaper source.
 */
export const SCENE_TONE_SAMPLING_ENABLED = false

export const TONE_THRESHOLDS = Object.freeze({
  enterDark: 0.24,
  leaveDark: 0.30,
  enterBright: 0.48,
  leaveBright: 0.42,
})

export const SAMPLE_WIDTH = 24
export const SAMPLE_HEIGHT = 14
export const FIRST_SAMPLE_DELAY_MS = 600
export const SAMPLE_INTERVAL_MS = 2500
export const LOW_POWER_SAMPLE_INTERVAL_MS = 5000

const RANK: Record<SceneTone, number> = { dark: 0, mid: 1, bright: 2 }

/** 95th percentile of gamma-encoded luma, (0.2126 R + 0.7152 G + 0.0722 B) / 255, over RGBA pixels. */
export function p95Luma(data: ArrayLike<number>): number {
  const count = Math.floor(data.length / 4)
  if (count === 0) return 1
  const values = new Float64Array(count)
  for (let index = 0; index < count; index += 1) {
    const offset = index * 4
    values[index] = (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) / 255
  }
  values.sort()
  return values[Math.min(count - 1, Math.ceil(0.95 * count) - 1)]
}

function candidateTone(p95: number, previous: SceneTone | null): SceneTone {
  const t = TONE_THRESHOLDS
  if (previous === 'dark') {
    if (p95 <= t.leaveDark) return 'dark'
    return p95 > t.enterBright ? 'bright' : 'mid'
  }
  if (previous === 'bright') {
    if (p95 >= t.leaveBright) return 'bright'
    return p95 < t.enterDark ? 'dark' : 'mid'
  }
  if (p95 < t.enterDark) return 'dark'
  if (p95 > t.enterBright) return 'bright'
  return 'mid'
}

export interface ToneDecision {
  tone: SceneTone
  pendingCount: number
  pendingTone: SceneTone | null
}

/**
 * Pure hysteresis. The first sample applies immediately. A move toward a brighter-safe tone
 * (dark -> mid -> bright) applies on the first crossing sample; a move toward a darker tone needs two
 * consecutive samples that agree on the same darker tone.
 */
export function classifyTone(p95: number, previous: SceneTone | null, pendingCount = 0, pendingTone: SceneTone | null = null): ToneDecision {
  const candidate = candidateTone(p95, previous)
  if (previous === null || RANK[candidate] > RANK[previous]) return { tone: candidate, pendingCount: 0, pendingTone: null }
  if (candidate === previous) return { tone: previous, pendingCount: 0, pendingTone: null }
  const count = pendingTone === candidate ? pendingCount + 1 : 1
  if (count >= 2) return { tone: candidate, pendingCount: 0, pendingTone: null }
  return { tone: previous, pendingCount: count, pendingTone: candidate }
}

type Context2D = Pick<CanvasRenderingContext2D, 'drawImage' | 'getImageData'>
interface SampleCanvas { getContext(type: '2d', options?: CanvasRenderingContext2DSettings): unknown }

export interface SceneToneSamplerOptions {
  root?: HTMLElement
  lowPower?: boolean
  /** Test seam: creates the 24x14 canvas. */
  createCanvas?: () => SampleCanvas | null
}

export interface SceneToneSamplerStats {
  /** Samples drawn by the timer chain (including the first sample at 600 ms). */
  timer: number
  /** Samples drawn immediately because the source changed or a `loadeddata` / `load` event fired. */
  event: number
}

export interface SceneToneSampler {
  start(): void
  stop(): void
  readonly running: boolean
  readonly stats: SceneToneSamplerStats
}

function defaultCanvas(): SampleCanvas | null {
  try {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(SAMPLE_WIDTH, SAMPLE_HEIGHT)
    const canvas = document.createElement('canvas')
    canvas.width = SAMPLE_WIDTH
    canvas.height = SAMPLE_HEIGHT
    return canvas
  } catch {
    return null
  }
}

function reducedTransparency(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-transparency: reduce)').matches
  } catch {
    return false
  }
}

type SceneSource = { element: HTMLVideoElement | HTMLImageElement; src: string; video: boolean }

function activeSource(): SceneSource | null {
  const video = document.querySelector<HTMLVideoElement>('[data-scene-backdrop] video[data-background-active="true"]')
  if (video && video.readyState >= 2) return { element: video, src: video.currentSrc || video.src, video: true }
  const image = document.querySelector<HTMLImageElement>('[data-scene-backdrop] img[data-background-poster]')
  if (image && image.complete && image.naturalWidth > 0) return { element: image, src: image.currentSrc || image.src, video: false }
  return null
}

function sameOrigin(src: string): boolean {
  try {
    return new URL(src, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

export function createSceneToneSampler(options: SceneToneSamplerOptions = {}): SceneToneSampler {
  const root = options.root ?? document.documentElement
  const interval = options.lowPower ? LOW_POWER_SAMPLE_INTERVAL_MS : SAMPLE_INTERVAL_MS
  const createCanvas = options.createCanvas ?? defaultCanvas
  const stats: SceneToneSamplerStats = { timer: 0, event: 0 }
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let context: Context2D | null | undefined
  let tone: SceneTone | null = null
  let pendingCount = 0
  let pendingTone: SceneTone | null = null
  let lastKey = ''
  let lastVideoTime = Number.NaN
  let sampledImageKey = ''
  const unsampleable = new Set<string>()
  let haltedKey: string | null = null
  let stopped = false

  function writeTone(next: SceneTone): void {
    tone = next
    if (root.dataset.sceneTone !== next) root.dataset.sceneTone = next
  }

  function ensureContext(): Context2D | null {
    if (context !== undefined) return context
    const canvas = createCanvas()
    // No `willReadFrequently`: that forces a CPU canvas, so drawImage() must first read the whole decoded
    // video frame back from the GPU (40-100 ms per sample on a 4x-throttled phone). On the default
    // accelerated canvas the scale-down stays on the GPU and only 24x14 pixels are read back (~5 ms).
    const created = canvas ? canvas.getContext('2d') as Context2D | null : null
    context = created ?? null
    return context
  }

  function schedule(delay: number): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!running || stopped || document.visibilityState === 'hidden') return
    timer = setTimeout(() => {
      timer = undefined
      sample('timer')
      schedule(interval)
    }, delay)
  }

  function sample(reason: 'timer' | 'event'): void {
    if (!running || stopped || document.visibilityState === 'hidden' || reducedTransparency()) return
    const source = activeSource()
    if (!source) return
    const key = `${source.video ? 'v' : 'i'}:${source.src}`
    const changed = key !== lastKey
    if (changed) {
      lastKey = key
      lastVideoTime = Number.NaN
      if (haltedKey !== null && haltedKey !== key) haltedKey = null
    }
    if (haltedKey === key) return
    if (!sameOrigin(source.src) || unsampleable.has(key)) {
      writeTone('bright')
      return
    }
    if (source.video) {
      const video = source.element as HTMLVideoElement
      if (!changed && video.paused && video.currentTime === lastVideoTime) return
    } else if (sampledImageKey === key) {
      return
    }
    const ctx = ensureContext()
    if (!ctx) {
      // No 2D canvas (jsdom, very old browsers): the bright defaults stay, and the sampler stops.
      writeTone('bright')
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      return
    }
    let measured = false
    try {
      performance.mark?.('lg-tone-sample-start')
      measured = true
    } catch {
      measured = false
    }
    try {
      try {
        ctx.drawImage(source.element, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT)
      } catch (error) {
        if ((error as DOMException)?.name === 'InvalidStateError') return
        throw error
      }
      if (reason === 'timer') stats.timer += 1
      else stats.event += 1
      const pixels = ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data
      if (source.video) lastVideoTime = (source.element as HTMLVideoElement).currentTime
      else sampledImageKey = key
      const decision = classifyTone(p95Luma(pixels), tone, pendingCount, pendingTone)
      pendingCount = decision.pendingCount
      pendingTone = decision.pendingTone
      writeTone(decision.tone)
    } catch (error) {
      if ((error as DOMException)?.name === 'SecurityError') {
        // Should be unreachable behind the origin guard (e.g. a same-origin URL that redirected).
        context = undefined
        unsampleable.add(key)
      } else {
        haltedKey = key
      }
      writeTone('bright')
    } finally {
      if (measured) {
        try {
          performance.measure?.('lg-tone-sample', 'lg-tone-sample-start')
        } catch {
          // Measurement is diagnostic only.
        }
      }
    }
  }

  function onMediaEvent(event: Event): void {
    const target = event.target
    if (!(target instanceof Element) || !target.closest('[data-scene-backdrop]')) return
    const source = activeSource()
    if (!source || source.element !== target) return
    sample('event')
  }

  function onVisibility(): void {
    if (document.visibilityState === 'hidden') {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      return
    }
    schedule(FIRST_SAMPLE_DELAY_MS)
  }

  return {
    get running() {
      return running
    },
    stats,
    start() {
      if (running) return
      running = true
      stopped = false
      document.addEventListener('visibilitychange', onVisibility)
      document.addEventListener('loadeddata', onMediaEvent, true)
      document.addEventListener('load', onMediaEvent, true)
      schedule(FIRST_SAMPLE_DELAY_MS)
    },
    stop() {
      if (!running) return
      running = false
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('loadeddata', onMediaEvent, true)
      document.removeEventListener('load', onMediaEvent, true)
    },
  }
}
