import { transitionDuration } from './transitionEngine'
export interface EnergySample { rms: number; peak: number }
export function measureEnergy(samples: Float32Array): EnergySample | undefined {
  if (!samples.length || samples.length > 4096) return undefined
  let energy = 0, peak = 0
  for (const value of samples) {
    if (!Number.isFinite(value)) return undefined
    const bounded = Math.min(1, Math.abs(value))
    energy += bounded * bounded
    peak = Math.max(peak, bounded)
  }
  return { rms: Math.sqrt(energy / samples.length), peak }
}
export type MixReason = 'quiet-outro' | 'high-energy' | 'measured-energy' | 'short-track' | 'analysis-unavailable'
export function planSmartMix(configured: number, duration: number, samples: readonly EnergySample[] = []) {
  const base = transitionDuration(configured)
  const valid = samples.slice(-12).filter(s => Number.isFinite(s.rms) && s.rms >= 0 && s.rms <= 1 &&
    Number.isFinite(s.peak) && s.peak >= s.rms && s.peak <= 1)
  let seconds = base, reason: MixReason = 'analysis-unavailable'
  if (valid.length >= 4) {
    const recent = valid.slice(-4)
    const rms = recent.reduce((sum, sample) => sum + sample.rms, 0) / recent.length
    if (recent.every(sample => sample.rms < .015)) { seconds = Math.max(2, base * .6); reason = 'quiet-outro' }
    else if (rms > .2) { seconds = Math.max(2, base * .75); reason = 'high-energy' }
    else reason = 'measured-energy'
  }
  if (Number.isFinite(duration) && duration > 0 && duration / 4 < seconds) {
    seconds = duration / 4; reason = 'short-track'
  }
  return { durationSeconds: seconds, leadSeconds: seconds, reason, analysed: valid.length >= 4 }
}

export type EnergySamplingState = 'unsupported' | 'awaiting-track' | 'sampling' | 'suspended' | 'unavailable'

/** Capture the playing element without rerouting its output or fetching media. Some browsers
 * publish capture tracks asynchronously, so wait for addtrack instead of caching a false failure. */
export function startPassiveEnergySampling(
  element: HTMLAudioElement,
  onSample: (sample: EnergySample) => void,
  onState: (state: EnergySamplingState) => void = () => {},
): () => void {
  type Capturable = HTMLAudioElement & { captureStream?: () => MediaStream }
  let context: AudioContext | undefined
  let stream: MediaStream | undefined
  let source: MediaStreamAudioSourceNode | undefined
  let analyser: AnalyserNode | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let sourceTracks: ReturnType<MediaStream['getAudioTracks']> = []
  const capturedTracks = new Set<MediaStreamTrack>()
  let cancelled = false
  let reportedSampling = false

  const rememberTracks = () => {
    stream?.getTracks().forEach(track => capturedTracks.add(track))
  }
  const stop = () => {
    if (cancelled) return
    cancelled = true
    if (timer !== undefined) clearInterval(timer)
    if (deadline !== undefined) clearTimeout(deadline)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    stream?.removeEventListener('addtrack', attach)
    context?.removeEventListener('statechange', onContextStateChange)
    // Release each resource independently: an already detached node must not leak the rest.
    try { source?.disconnect() } catch { /* The graph may already have been closed. */ }
    try { analyser?.disconnect() } catch { /* Continue releasing captured tracks. */ }
    try { rememberTracks() } catch { /* Retain tracks observed before the stream became unavailable. */ }
    capturedTracks.forEach(track => {
      try { track.stop() } catch { /* One failed stop must not retain other tracks. */ }
    })
    try {
      if (context && context.state !== 'closed') void context.close().catch(() => {})
    } catch { /* Playback uses the original media element and remains independent. */ }
  }
  const finish = (state: EnergySamplingState) => {
    if (cancelled) return
    // Withdraw callbacks and release resources before reporting a terminal state.
    stop()
    onState(state)
  }
  const unavailable = () => finish('unavailable')
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') unavailable()
  }
  const onContextStateChange = () => {
    if (!cancelled && timer !== undefined && context?.state !== 'running') {
      finish(context?.state === 'suspended' ? 'suspended' : 'unavailable')
    }
  }
  const attach = () => {
    if (cancelled) return
    try {
      rememberTracks()
      if (source || !stream?.getAudioTracks().length) return
      sourceTracks = stream.getAudioTracks()
      context = new AudioContext()
      context.addEventListener('statechange', onContextStateChange)
      analyser = context.createAnalyser()
      analyser.fftSize = 512
      source = context.createMediaStreamSource(stream)
      source.connect(analyser)
      const samples = new Float32Array(512)
      void context.resume().then(() => {
        if (cancelled) return
        if (context?.state !== 'running') { finish('suspended'); return }
        timer = setInterval(() => {
          if (cancelled) return
          if (document.visibilityState === 'hidden') { unavailable(); return }
          if (context?.state !== 'running') { onContextStateChange(); return }
          if (element.paused) return
          try {
            const tracks = stream!.getAudioTracks()
            // Disabled/muted tracks produce synthetic silence. Removed source tracks must
            // not be mistaken for a quiet outro when another live track is published.
            if (!sourceTracks.every(track => tracks.includes(track) && track.readyState === 'live' &&
                !track.muted && track.enabled !== false)) return
            analyser!.getFloatTimeDomainData(samples)
            const result = measureEnergy(samples)
            if (result) {
              if (!reportedSampling) { reportedSampling = true; onState('sampling') }
              if (!cancelled) onSample(result)
            }
          } catch { unavailable() }
        }, 250)
      }).catch(unavailable)
    } catch { unavailable() }
  }
  try {
    if (new URL(element.currentSrc || element.src, window.location.href).origin !== window.location.origin ||
        typeof AudioContext === 'undefined' || typeof (element as Capturable).captureStream !== 'function') {
      finish('unsupported')
      return stop
    }
    if (document.visibilityState === 'hidden') {
      unavailable()
      return stop
    }
    stream = (element as Capturable).captureStream!()
    rememberTracks()
    stream.addEventListener('addtrack', attach)
    document.addEventListener('visibilitychange', onVisibilityChange)
    // Bound suspended resume promises and trackless captures as well as active sampling.
    deadline = setTimeout(() => { if (reportedSampling) stop(); else unavailable() }, 30_000)
    onState('awaiting-track')
    attach()
  } catch { unavailable() }
  return stop
}
