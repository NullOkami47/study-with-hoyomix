import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureEnergy, planSmartMix, startPassiveEnergySampling } from './smartMix'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const energy = (rms: number, length = 12) => Array.from({ length }, () => ({ rms, peak: rms }))

describe('deterministic lightweight Smart Mix', () => {
  it('measures controlled PCM without mutating it', () => {
    const pcm = new Float32Array([.5, -.5, .5, -.5])
    expect(measureEnergy(pcm)).toEqual({ rms: .5, peak: .5 })
    expect([...pcm]).toEqual([.5, -.5, .5, -.5])
    expect(measureEnergy(new Float32Array([-2, 2]))).toEqual({ rms: 1, peak: 1 })
    expect(measureEnergy(new Float32Array(4096))).toEqual({ rms: 0, peak: 0 })
  })

  it('rejects empty, oversized and non-finite PCM', () => {
    for (const pcm of [new Float32Array(), new Float32Array(4097), new Float32Array([NaN]), new Float32Array([Infinity])]) {
      expect(measureEnergy(pcm)).toBeUndefined()
    }
  })

  it('plans quiet, energetic and ordinary overlaps deterministically without changing samples', () => {
    const cases = [
      { rms: 0, seconds: 3, reason: 'quiet-outro' },
      { rms: .3, seconds: 3.75, reason: 'high-energy' },
      { rms: .08, seconds: 5, reason: 'measured-energy' },
    ]
    for (const { rms, seconds, reason } of cases) {
      const samples = Object.freeze(energy(rms).map(sample => Object.freeze(sample)))
      const first = planSmartMix(5, 180, samples)
      expect(first).toEqual({ durationSeconds: seconds, leadSeconds: seconds, reason, analysed: true })
      expect(planSmartMix(5, 180, samples)).toEqual(first)
      expect(samples).toEqual(energy(rms))
    }
  })

  it('requires four valid samples and ignores history outside the last twelve', () => {
    expect(planSmartMix(5, 180, energy(0, 3))).toMatchObject({ durationSeconds: 5, reason: 'analysis-unavailable', analysed: false })
    expect(planSmartMix(5, 180, [...energy(0, 20), ...energy(.3)])).toEqual(planSmartMix(5, 180, energy(.3)))
    expect(planSmartMix(5, 180, [...energy(0, 4), ...energy(NaN)])).toMatchObject({ reason: 'analysis-unavailable', analysed: false })
  })

  it('does not classify invalid peak or impossible energy as measured silence', () => {
    for (const invalid of [{ rms: 0, peak: NaN }, { rms: 0, peak: Infinity }, { rms: .5, peak: .1 }, { rms: 0, peak: -1 }, { rms: 0, peak: 2 }]) {
      expect(planSmartMix(5, 180, Array.from({ length: 4 }, () => invalid))).toMatchObject({ reason: 'analysis-unavailable', analysed: false })
    }
  })

  it('bounds configuration and short-track planning without requiring analysis', () => {
    expect(planSmartMix(5, 180)).toMatchObject({ durationSeconds: 5, reason: 'analysis-unavailable', analysed: false })
    expect(planSmartMix(8, 180, energy(.3))).toMatchObject({ durationSeconds: 6, reason: 'high-energy' })
    expect(planSmartMix(12, 12)).toMatchObject({ durationSeconds: 3, reason: 'short-track' })
    expect(planSmartMix(12, .1).durationSeconds).toBeLessThanOrEqual(.1)
    expect(planSmartMix(NaN, NaN).durationSeconds).toBe(5)
    expect(planSmartMix(Infinity, Infinity).durationSeconds).toBe(5)
    expect(planSmartMix(-1, 180).durationSeconds).toBe(2)
  })
})

function captureFixture(initialTrack = true, resumeResult?: Promise<void>) {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const element = document.createElement('audio')
  element.src = location.origin + '/fixture.wav'
  element.volume = .37
  element.muted = true
  element.playbackRate = 1.25
  let paused = false
  Object.defineProperty(element, 'paused', { get: () => paused })
  const play = vi.spyOn(element, 'play')
  const pause = vi.spyOn(element, 'pause').mockImplementation(() => {})
  const load = vi.spyOn(element, 'load').mockImplementation(() => {})
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const track = { kind: 'audio', readyState: 'live', muted: false, enabled: true, stop: vi.fn() }
  let tracks: MediaStreamTrack[] = initialTrack ? [track as unknown as MediaStreamTrack] : []
  const stream = Object.assign(new EventTarget(), {
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  })
  const capture = vi.fn(() => stream)
  Object.defineProperty(element, 'captureStream', { value: capture, configurable: true })
  const removeListener = vi.spyOn(stream, 'removeEventListener')
  const analyse = vi.fn((samples: Float32Array) => samples.fill(.25))
  const analyser = { fftSize: 0, getFloatTimeDomainData: analyse, connect: vi.fn(), disconnect: vi.fn() }
  const source = { connect: vi.fn(), disconnect: vi.fn() }
  const contexts: FakeContext[] = []
  class FakeContext extends EventTarget {
    state: AudioContextState = 'suspended'
    destination = {}
    createAnalyser = vi.fn(() => analyser)
    createMediaStreamSource = vi.fn(() => source)
    createMediaElementSource = vi.fn()
    resume = vi.fn(async () => { if (resumeResult) return resumeResult; this.state = 'running' })
    close = vi.fn(async () => { this.state = 'closed' })
    constructor() { super(); contexts.push(this) }
  }
  vi.stubGlobal('AudioContext', FakeContext)
  const onSample = vi.fn(), onState = vi.fn()
  return {
    element, stream, track, capture, removeListener, contexts, source, analyser, analyse, onSample, onState,
    visibility, fetch, play, pause, load,
    setPaused: (value: boolean) => { paused = value },
    publish: () => { tracks = [track as unknown as MediaStreamTrack]; stream.dispatchEvent(new Event('addtrack')) },
    start: () => startPassiveEnergySampling(element, onSample, onState),
  }
}

describe('passive capture lifecycle', () => {
  it('waits for an asynchronous audio track, samples 512 values at 250ms and preserves all media settings', async () => {
    const f = captureFixture(false)
    const stop = f.start()
    expect(f.onState.mock.calls).toEqual([['awaiting-track']])
    expect(f.contexts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.onSample).not.toHaveBeenCalled()
    f.publish(); f.publish()
    await vi.advanceTimersByTimeAsync(249)
    expect(f.onSample).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(751)
    expect(f.contexts).toHaveLength(1)
    expect(f.onSample).toHaveBeenCalledTimes(4)
    expect(f.onSample.mock.calls[0][0]).toEqual({ rms: .25, peak: .25 })
    expect(f.analyser.fftSize).toBe(512)
    expect(f.analyse.mock.calls.every(([pcm]) => pcm.length === 512)).toBe(true)
    expect(f.onState.mock.calls).toEqual([['awaiting-track'], ['sampling']])
    expect(f.source.connect).toHaveBeenCalledWith(f.analyser)
    expect(f.analyser.connect).not.toHaveBeenCalled()
    expect(f.contexts[0].createMediaElementSource).not.toHaveBeenCalled()
    expect(f.element.volume).toBe(.37)
    expect(f.element.muted).toBe(true)
    expect(f.element.playbackRate).toBe(1.25)
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.play).not.toHaveBeenCalled()
    expect(f.pause).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
    stop(); stop()
    f.publish()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.onSample).toHaveBeenCalledTimes(4)
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.source.disconnect).toHaveBeenCalledTimes(1)
    expect(f.analyser.disconnect).toHaveBeenCalledTimes(1)
    expect(f.contexts[0].close).toHaveBeenCalledTimes(1)
    expect(f.removeListener).toHaveBeenCalledWith('addtrack', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('handles an already available track without waiting for addtrack', async () => {
    const f = captureFixture()
    const stop = f.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(f.onSample).toHaveBeenCalledOnce()
    stop()
  })

  it.each(['muted', 'disabled', 'ended'] as const)('does not interpret a %s captured track as silence', async kind => {
    const f = captureFixture()
    const stop = f.start()
    await vi.advanceTimersByTimeAsync(0)
    if (kind === 'muted') f.track.muted = true
    if (kind === 'disabled') f.track.enabled = false
    if (kind === 'ended') f.track.readyState = 'ended'
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.analyse).not.toHaveBeenCalled()
    expect(f.onSample).not.toHaveBeenCalled()
    stop()
  })

  it('skips paused media and resumes measurement without changing playback', async () => {
    const f = captureFixture()
    const stop = f.start()
    f.setPaused(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(f.analyse).not.toHaveBeenCalled()
    f.setPaused(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(f.onSample).toHaveBeenCalledOnce()
    stop()
  })

  it('releases resources immediately on backgrounding', async () => {
    const f = captureFixture()
    f.start()
    await vi.advanceTimersByTimeAsync(250)
    f.visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.contexts[0].close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.onSample).toHaveBeenCalledOnce()
  })

  it('does not create a capture or context when the page is already hidden', () => {
    const f = captureFixture()
    f.visibility.mockReturnValue('hidden')
    f.start()()
    expect(f.capture).not.toHaveBeenCalled()
    expect(f.contexts).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up when a running context becomes suspended', async () => {
    const f = captureFixture()
    f.start()
    await vi.advanceTimersByTimeAsync(250)
    f.contexts[0].state = 'suspended'
    f.contexts[0].dispatchEvent(new Event('statechange'))
    expect(f.onState).toHaveBeenLastCalledWith('suspended')
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.contexts[0].close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a resume rejection after cancellation', async () => {
    let reject!: (reason: Error) => void
    const resume = new Promise<void>((_, rejectPromise) => { reject = rejectPromise })
    const f = captureFixture(true, resume)
    const stop = f.start()
    stop()
    reject(new Error('cancelled'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.onState.mock.calls).toEqual([['awaiting-track']])
    expect(f.contexts[0].close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds a pending resume promise and ignores its late completion', async () => {
    let resolve!: () => void
    const resume = new Promise<void>(done => { resolve = done })
    const f = captureFixture(true, resume)
    f.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.onState).toHaveBeenLastCalledWith('unavailable')
    expect(f.contexts[0].close).toHaveBeenCalledOnce()
    resolve()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.onSample).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a rejected resume and releases its graph', async () => {
    const resume = Promise.reject(new Error('resume denied'))
    const f = captureFixture(true, resume)
    f.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.onState).toHaveBeenLastCalledWith('unavailable')
    expect(f.contexts[0].close).toHaveBeenCalledOnce()
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds trackless capture to 30 seconds and reports unavailable', async () => {
    const f = captureFixture(false)
    f.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.onState).toHaveBeenLastCalledWith('unavailable')
    expect(f.removeListener).toHaveBeenCalledWith('addtrack', expect.any(Function))
    f.publish()
    expect(f.contexts).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds active sampling to 30 seconds and releases the context and tracks', async () => {
    const f = captureFixture()
    f.start()
    await vi.advanceTimersByTimeAsync(30_000)
    const count = f.onSample.mock.calls.length
    expect(count).toBeGreaterThan(0)
    expect(count).toBeLessThanOrEqual(120)
    expect(f.contexts[0].close).toHaveBeenCalledOnce()
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.onSample).toHaveBeenCalledTimes(count)
  })

  it('fails closed and cleans up after analyser failures', async () => {
    const f = captureFixture()
    f.analyse.mockImplementation(() => { throw new Error('analysis denied') })
    f.start()
    await vi.advanceTimersByTimeAsync(250)
    expect(f.onState).toHaveBeenLastCalledWith('unavailable')
    expect(f.onSample).not.toHaveBeenCalled()
    expect(f.contexts[0].close).toHaveBeenCalledOnce()
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('continues releasing resources if one disconnect throws', async () => {
    const f = captureFixture()
    const stop = f.start()
    await vi.advanceTimersByTimeAsync(0)
    f.source.disconnect.mockImplementation(() => { throw new Error('already detached') })
    expect(stop).not.toThrow()
    expect(f.analyser.disconnect).toHaveBeenCalledOnce()
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.contexts[0].close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['cross-origin', 'capture-missing', 'context-missing'] as const)('keeps %s analysis unavailable without network or playback changes', kind => {
    const f = captureFixture()
    if (kind === 'cross-origin') f.element.src = 'https://other.invalid/audio.mp3'
    if (kind === 'capture-missing') Object.defineProperty(f.element, 'captureStream', { value: undefined })
    if (kind === 'context-missing') vi.stubGlobal('AudioContext', undefined)
    f.start()()
    expect(f.onState).toHaveBeenCalledWith('unsupported')
    expect(f.capture).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
    expect(f.contexts).toHaveLength(0)
    expect(f.element.volume).toBe(.37)
    expect(f.element.muted).toBe(true)
    expect(f.pause).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
  })
})
