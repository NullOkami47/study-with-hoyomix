import type { PlaybackPauseLease, PlayerCommands } from '../../player/commands'
import type { PomodoroControlEvent, PomodoroPhaseExpired } from './store'

export interface PomodoroWorkspaceEffectsOptions {
  playback: PlayerCommands
  playCompletionSound(): void
}

export interface PomodoroWorkspaceEffects {
  destroy(): void
  onControl(event: PomodoroControlEvent): void
  onPhaseExpired(event: PomodoroPhaseExpired): void
}

export interface CompletionToneAudioParam {
  setValueAtTime(value: number, startTime: number): void
  exponentialRampToValueAtTime(value: number, endTime: number): void
}

export interface CompletionToneOscillator {
  type: OscillatorType
  frequency: CompletionToneAudioParam
  connect(destination: unknown): unknown
  start(when?: number): void
  stop(when?: number): void
}

export interface CompletionToneGain {
  gain: CompletionToneAudioParam
  connect(destination: unknown): unknown
}

export interface CompletionToneAudioContext {
  currentTime: number
  state?: AudioContextState
  destination: unknown
  createOscillator(): CompletionToneOscillator
  createGain(): CompletionToneGain
  resume?(): Promise<void>
  close(): Promise<void>
}

export interface CompletionToneOptions {
  createAudioContext?(): CompletionToneAudioContext | undefined
  scheduleClose?(callback: () => void, delayMs: number): unknown
}

function defaultAudioContextFactory(): CompletionToneAudioContext | undefined {
  const audioGlobal = globalThis as typeof globalThis & {
    AudioContext?: new () => CompletionToneAudioContext
    webkitAudioContext?: new () => CompletionToneAudioContext
  }
  const AudioContextConstructor = audioGlobal.AudioContext ?? audioGlobal.webkitAudioContext
  return AudioContextConstructor ? new AudioContextConstructor() : undefined
}

export function playPomodoroCompletionSound(options: CompletionToneOptions = {}): void {
  const createAudioContext = options.createAudioContext ?? defaultAudioContextFactory
  const scheduleClose = options.scheduleClose ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))

  let context: CompletionToneAudioContext | undefined
  try {
    context = createAudioContext()
  } catch {
    return
  }
  if (!context) return

  const closeContext = () => {
    try {
      void context?.close().catch(() => undefined)
    } catch {
      // Closing a platform audio context is best-effort.
    }
  }
  const closeAfterTone = () => {
    try {
      scheduleClose(closeContext, 180)
    } catch {
      closeContext()
    }
  }
  const startTone = () => {
    try {
      const startTime = context.currentTime
      const stopTime = startTime + 0.12
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(880, startTime)
      gain.gain.setValueAtTime(0.0001, startTime)
      gain.gain.exponentialRampToValueAtTime(0.08, startTime + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, stopTime)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(startTime)
      oscillator.stop(stopTime)
    } catch {
      // Audio is a benign notification; timer and playback truth must continue.
    } finally {
      closeAfterTone()
    }
  }

  if (context.state === 'suspended' && context.resume) {
    try {
      void context.resume().then(startTone, closeAfterTone)
    } catch {
      closeAfterTone()
    }
    return
  }
  startTone()
}

export function createPomodoroWorkspaceEffects(
  options: PomodoroWorkspaceEffectsOptions,
): PomodoroWorkspaceEffects {
  let playbackPauseLease: PlaybackPauseLease | undefined

  function discardSettledLease(): void {
    if (playbackPauseLease?.isSettled()) playbackPauseLease = undefined
  }

  function cancelLease(): void {
    playbackPauseLease?.cancel()
    playbackPauseLease = undefined
  }

  function resumeLease(): void {
    playbackPauseLease?.resumeIfStillOwned()
    discardSettledLease()
  }

  function onPhaseExpired(event: PomodoroPhaseExpired): void {
    discardSettledLease()
    if (event.catchUpCapped) {
      cancelLease()
      return
    }
    if (!event.isLastInBatch) return

    if (event.nextPhase === 'focus') {
      resumeLease()
    } else if (event.pauseMusicDuringBreak) {
      playbackPauseLease ??= options.playback.pauseForInterruption()
    } else {
      cancelLease()
    }

    options.playCompletionSound()
  }

  function onControl(event: PomodoroControlEvent): void {
    if (event.type === 'reset' || (event.type === 'selectPhase' && event.phase === 'focus')) {
      resumeLease()
    }
  }

  return {
    destroy: cancelLease,
    onControl,
    onPhaseExpired,
  }
}
