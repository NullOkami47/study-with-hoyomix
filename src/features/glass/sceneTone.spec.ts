import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  classifyTone,
  createSceneToneSampler,
  FIRST_SAMPLE_DELAY_MS,
  LOW_POWER_SAMPLE_INTERVAL_MS,
  p95Luma,
  SAMPLE_INTERVAL_MS,
  type SceneTone,
} from './sceneTone'

function grey(value: number, count = 336): Uint8ClampedArray {
  const data = new Uint8ClampedArray(count * 4)
  for (let index = 0; index < count; index += 1) data.set([value, value, value, 255], index * 4)
  return data
}

describe('p95Luma', () => {
  it('uses gamma-encoded values without linearisation', () => {
    expect(p95Luma(grey(77))).toBeCloseTo(77 / 255, 5)
    expect(p95Luma(grey(122))).toBeCloseTo(0.478, 3)
  })

  it('reports the 95th percentile, so a bright patch dominates', () => {
    const data = grey(20)
    for (let index = 0; index < 30; index += 1) data.set([250, 250, 250, 255], index * 4)
    expect(p95Luma(data)).toBeCloseTo(250 / 255, 5)
    const small = grey(20)
    for (let index = 0; index < 10; index += 1) small.set([250, 250, 250, 255], index * 4)
    expect(p95Luma(small)).toBeCloseTo(20 / 255, 5)
  })
})

describe('classifyTone', () => {
  it('applies the first sample immediately', () => {
    expect(classifyTone(0.1, null).tone).toBe('dark')
    expect(classifyTone(0.35, null).tone).toBe('mid')
    expect(classifyTone(0.6, null).tone).toBe('bright')
  })

  it('moves toward a brighter-safe tone on the first crossing sample', () => {
    expect(classifyTone(0.6, 'dark')).toMatchObject({ tone: 'bright', pendingCount: 0 })
    expect(classifyTone(0.35, 'dark')).toMatchObject({ tone: 'mid', pendingCount: 0 })
    expect(classifyTone(0.5, 'mid')).toMatchObject({ tone: 'bright', pendingCount: 0 })
  })

  it('needs two agreeing samples to move toward a darker tone', () => {
    const first = classifyTone(0.1, 'bright')
    expect(first).toMatchObject({ tone: 'bright', pendingCount: 1, pendingTone: 'dark' })
    expect(classifyTone(0.1, 'bright', first.pendingCount, first.pendingTone)).toMatchObject({ tone: 'dark', pendingCount: 0 })
    const mid = classifyTone(0.35, 'bright')
    expect(mid).toMatchObject({ tone: 'bright', pendingTone: 'mid' })
    // A disagreeing second sample restarts the count.
    expect(classifyTone(0.1, 'bright', mid.pendingCount, mid.pendingTone)).toMatchObject({ tone: 'bright', pendingCount: 1, pendingTone: 'dark' })
    const toDark = classifyTone(0.2, 'mid')
    expect(toDark).toMatchObject({ tone: 'mid', pendingCount: 1 })
    expect(classifyTone(0.2, 'mid', toDark.pendingCount, toDark.pendingTone).tone).toBe('dark')
  })

  it('holds inside the hysteresis bands', () => {
    expect(classifyTone(0.28, 'dark').tone).toBe('dark')
    expect(classifyTone(0.44, 'bright').tone).toBe('bright')
    expect(classifyTone(0.26, 'mid').tone).toBe('mid')
    expect(classifyTone(0.46, 'mid').tone).toBe('mid')
    // Returning to the current tone cancels a pending darker move.
    expect(classifyTone(0.6, 'bright', 1, 'dark')).toMatchObject({ tone: 'bright', pendingCount: 0, pendingTone: null })
  })
})

describe('createSceneToneSampler', () => {
  let luma = 200
  let drawImage: ReturnType<typeof vi.fn>
  let getImageData: ReturnType<typeof vi.fn>
  let createCanvas: Mock<() => { getContext: () => unknown }>
  let visibility: DocumentVisibilityState = 'visible'

  function scene(html: string): HTMLElement {
    document.body.innerHTML = `<div data-scene-backdrop>${html}</div>`
    return document.querySelector('[data-scene-backdrop]')!.firstElementChild as HTMLElement
  }

  function readyVideo(src: string, paused = false): HTMLVideoElement {
    const video = scene('<video data-background-active="true"></video>') as HTMLVideoElement
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 })
    Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => src })
    Object.defineProperty(video, 'paused', { configurable: true, get: () => paused })
    return video
  }

  function readyImage(src: string): HTMLImageElement {
    const image = scene('<img data-background-poster>') as HTMLImageElement
    Object.defineProperty(image, 'complete', { configurable: true, get: () => true })
    Object.defineProperty(image, 'naturalWidth', { configurable: true, get: () => 24 })
    Object.defineProperty(image, 'currentSrc', { configurable: true, get: () => src })
    return image
  }

  function tone(): SceneTone | undefined {
    return document.documentElement.dataset.sceneTone as SceneTone | undefined
  }

  beforeEach(() => {
    vi.useFakeTimers()
    luma = 200
    visibility = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    drawImage = vi.fn()
    getImageData = vi.fn(() => ({ data: grey(luma) }))
    createCanvas = vi.fn(() => ({ getContext: (): unknown => ({ drawImage, getImageData }) }))
  })

  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    delete document.documentElement.dataset.sceneTone
    delete (document as { visibilityState?: unknown }).visibilityState
  })

  it('samples first at 600 ms and then every 2.5 s, writing the tone only on change', () => {
    readyVideo('/backgrounds/a.mp4')
    const sampler = createSceneToneSampler({ createCanvas })
    sampler.start()
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS - 1)
    expect(drawImage).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(drawImage).toHaveBeenCalledTimes(1)
    expect(tone()).toBe('bright')
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 3)
    expect(sampler.stats.timer).toBe(4)
    expect(sampler.stats.event).toBe(0)
    sampler.stop()
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 3)
    expect(sampler.stats.timer).toBe(4)
  })

  it('uses a 5 s cadence under low power', () => {
    readyVideo('/backgrounds/a.mp4')
    const sampler = createSceneToneSampler({ createCanvas, lowPower: true })
    sampler.start()
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS + LOW_POWER_SAMPLE_INTERVAL_MS * 2)
    expect(sampler.stats.timer).toBe(3)
    sampler.stop()
  })

  it('stops sampling while the tab is hidden and resumes when visible', () => {
    readyVideo('/backgrounds/a.mp4')
    const sampler = createSceneToneSampler({ createCanvas })
    sampler.start()
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS)
    expect(getImageData).toHaveBeenCalledTimes(1)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 4)
    expect(getImageData).toHaveBeenCalledTimes(1)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS)
    expect(getImageData).toHaveBeenCalledTimes(2)
    sampler.stop()
  })

  it('skips a paused video whose time has not changed', () => {
    readyVideo('/backgrounds/a.mp4', true)
    const sampler = createSceneToneSampler({ createCanvas })
    sampler.start()
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS + SAMPLE_INTERVAL_MS * 3)
    expect(getImageData).toHaveBeenCalledTimes(1)
    sampler.stop()
  })

  it('never draws a cross-origin source and resumes on the next same-origin source', () => {
    readyVideo('https://media.example.com/scene.mp4')
    const sampler = createSceneToneSampler({ createCanvas })
    sampler.start()
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS + SAMPLE_INTERVAL_MS * 2)
    expect(drawImage).not.toHaveBeenCalled()
    expect(tone()).toBe('bright')
    luma = 10
    readyVideo('/backgrounds/dark.mp4')
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
    expect(drawImage).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
    expect(tone()).toBe('dark')
    sampler.stop()
  })

  it('recreates the canvas after a SecurityError and marks that source unsampleable', () => {
    readyVideo('/backgrounds/a.mp4')
    getImageData.mockImplementationOnce(() => { throw new DOMException('tainted', 'SecurityError') })
    const sampler = createSceneToneSampler({ createCanvas })
    sampler.start()
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS)
    expect(tone()).toBe('bright')
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
    expect(drawImage).toHaveBeenCalledTimes(1)
    readyVideo('/backgrounds/b.mp4')
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
    expect(createCanvas).toHaveBeenCalledTimes(2)
    expect(getImageData).toHaveBeenCalledTimes(2)
    sampler.stop()
  })

  it('stops with the bright tone when no 2D context exists', () => {
    readyVideo('/backgrounds/a.mp4')
    const sampler = createSceneToneSampler({ createCanvas: () => ({ getContext: () => null }) })
    sampler.start()
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS + SAMPLE_INTERVAL_MS * 4)
    expect(tone()).toBe('bright')
    expect(sampler.stats.timer).toBe(0)
    sampler.stop()
  })

  it('skips a frame that is not ready yet', () => {
    readyVideo('/backgrounds/a.mp4')
    drawImage.mockImplementationOnce(() => { throw new DOMException('no frame', 'InvalidStateError') })
    const sampler = createSceneToneSampler({ createCanvas })
    sampler.start()
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS)
    expect(getImageData).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS)
    expect(getImageData).toHaveBeenCalledTimes(1)
    sampler.stop()
  })

  it('samples a still image once per src, and immediately on its load event', () => {
    const image = readyImage('/backgrounds/poster.jpg')
    const sampler = createSceneToneSampler({ createCanvas })
    sampler.start()
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS + SAMPLE_INTERVAL_MS * 4)
    expect(getImageData).toHaveBeenCalledTimes(1)
    Object.defineProperty(image, 'currentSrc', { configurable: true, get: () => '/backgrounds/poster-2.jpg' })
    image.dispatchEvent(new Event('load'))
    expect(getImageData).toHaveBeenCalledTimes(2)
    expect(sampler.stats).toEqual({ timer: 1, event: 1 })
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 2)
    expect(getImageData).toHaveBeenCalledTimes(2)
    sampler.stop()
  })

  it('counts a loadeddata sample as event-driven', () => {
    const video = readyVideo('/backgrounds/a.mp4')
    const sampler = createSceneToneSampler({ createCanvas })
    sampler.start()
    video.dispatchEvent(new Event('loadeddata'))
    expect(sampler.stats).toEqual({ timer: 0, event: 1 })
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS)
    expect(sampler.stats).toEqual({ timer: 1, event: 1 })
    sampler.stop()
  })

  it('does not sample under prefers-reduced-transparency', () => {
    readyVideo('/backgrounds/a.mp4')
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query.includes('reduced-transparency'), media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }) as MediaQueryList))
    const sampler = createSceneToneSampler({ createCanvas })
    sampler.start()
    vi.advanceTimersByTime(FIRST_SAMPLE_DELAY_MS + SAMPLE_INTERVAL_MS * 2)
    expect(drawImage).not.toHaveBeenCalled()
    sampler.stop()
    vi.unstubAllGlobals()
  })
})
