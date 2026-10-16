import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createPomodoroWorkspaceEffects,
  playPomodoroCompletionSound,
  type CompletionToneAudioContext,
} from './workspaceEffects'
import { createPomodoroStore, type PomodoroPhaseExpired } from './store'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function createToneContext(overrides: Partial<CompletionToneAudioContext> = {}) {
  const frequency = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  }
  const gainParam = {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  }
  const oscillator = {
    type: 'sine' as OscillatorType,
    frequency,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
  const gain = { gain: gainParam, connect: vi.fn() }
  const context: CompletionToneAudioContext = {
    currentTime: 4,
    state: 'running',
    destination: {},
    createOscillator: vi.fn(() => oscillator),
    createGain: vi.fn(() => gain),
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  }
  return { context, oscillator, gain }
}

describe('Pomodoro workspace effects', () => {
  it('pauses and resumes only for one final, non-capped break cycle and emits one tone per transition', () => {
    let settled = false
    const cancel = vi.fn(() => { settled = true })
    const resumeIfStillOwned = vi.fn(() => { settled = true })
    const playback = {
      isPlaying: vi.fn(() => true),
      pause: vi.fn(),
      pauseForInterruption: vi.fn(() => ({ cancel, isSettled: () => settled, resumeIfStillOwned })),
      play: vi.fn(),
      stop: vi.fn(),
    }
    const tone = vi.fn()
    const effects = createPomodoroWorkspaceEffects({ playback, playCompletionSound: tone })
    const event: PomodoroPhaseExpired = {
      durationSeconds: 1_500,
      phase: 'focus',
      expiredAt: 1_000,
      nextPhase: 'break',
      isLastInBatch: true,
      catchUpCapped: false,
      pauseMusicDuringBreak: true,
    }

    effects.onPhaseExpired({ ...event, isLastInBatch: false })
    expect(playback.pauseForInterruption).not.toHaveBeenCalled()
    expect(tone).not.toHaveBeenCalled()

    effects.onPhaseExpired(event)
    expect(playback.pauseForInterruption).toHaveBeenCalledTimes(1)
    expect(tone).toHaveBeenCalledTimes(1)

    effects.onPhaseExpired({ ...event, phase: 'break', nextPhase: 'focus', expiredAt: 301_000 })
    expect(resumeIfStillOwned).toHaveBeenCalledTimes(1)
    expect(tone).toHaveBeenCalledTimes(2)

    effects.onPhaseExpired({ ...event, pauseMusicDuringBreak: false })
    effects.onPhaseExpired({ ...event, phase: 'break', nextPhase: 'focus', expiredAt: 301_000 })
    expect(playback.pauseForInterruption).toHaveBeenCalledTimes(1)
    expect(resumeIfStillOwned).toHaveBeenCalledTimes(1)
    expect(tone).toHaveBeenCalledTimes(4)
  })

  it('keeps one lease across a catch-up batch and resumes it on the next final focus transition', () => {
    let now = 0
    let settled = false
    const lease = {
      cancel: vi.fn(() => { settled = true }),
      isSettled: () => settled,
      resumeIfStillOwned: vi.fn(() => { settled = true }),
    }
    const playback = {
      isPlaying: vi.fn(() => true),
      pause: vi.fn(),
      pauseForInterruption: vi.fn(() => lease),
      play: vi.fn(),
      stop: vi.fn(),
    }
    const tone = vi.fn()
    const effects = createPomodoroWorkspaceEffects({ playback, playCompletionSound: tone })
    const store = createPomodoroStore({
      autoTick: false,
      breakMinutes: 1,
      clock: { now: () => now },
      cycleCount: 12,
      focusMinutes: 1,
      longBreakMinutes: 1,
      onControl: effects.onControl,
      onPhaseExpired: effects.onPhaseExpired,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })

    store.start()
    now = 60_000
    store.tick()
    now = 180_000
    store.tick()

    expect(playback.pauseForInterruption).toHaveBeenCalledOnce()
    expect(lease.resumeIfStillOwned).not.toHaveBeenCalled()
    expect(tone).toHaveBeenCalledTimes(2)

    now = 240_000
    store.tick()
    expect(lease.resumeIfStillOwned).toHaveBeenCalledOnce()
    expect(tone).toHaveBeenCalledTimes(3)
    store.destroy()
  })

  it.each(['reset', 'select-focus'] as const)('resumes an active break lease once on %s through real store control callbacks', (control) => {
    let now = 0
    let settled = false
    const lease = {
      cancel: vi.fn(() => { settled = true }),
      isSettled: () => settled,
      resumeIfStillOwned: vi.fn(() => { settled = true }),
    }
    const playback = {
      isPlaying: vi.fn(() => true), pause: vi.fn(),
      pauseForInterruption: vi.fn(() => lease), play: vi.fn(), stop: vi.fn(),
    }
    const effects = createPomodoroWorkspaceEffects({ playback, playCompletionSound: vi.fn() })
    const store = createPomodoroStore({
      autoTick: false,
      clock: { now: () => now },
      focusMinutes: 1,
      onControl: effects.onControl,
      onPhaseExpired: effects.onPhaseExpired,
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    })
    store.start()
    now = 60_000
    store.tick()

    if (control === 'reset') store.reset()
    else {
      store.pause()
      store.selectPhase('longBreak')
      expect(lease.resumeIfStillOwned).not.toHaveBeenCalled()
      store.selectPhase('focus')
    }

    expect(lease.resumeIfStillOwned).toHaveBeenCalledOnce()
    store.destroy()
  })

  it('cancels an active lease on capped catch-up or workspace destroy and never resumes it later', () => {
    let settled = false
    const lease = {
      cancel: vi.fn(() => { settled = true }),
      isSettled: () => settled,
      resumeIfStillOwned: vi.fn(),
    }
    const playback = {
      isPlaying: vi.fn(() => true), pause: vi.fn(),
      pauseForInterruption: vi.fn(() => lease), play: vi.fn(), stop: vi.fn(),
    }
    const effects = createPomodoroWorkspaceEffects({ playback, playCompletionSound: vi.fn() })
    const breakEvent: PomodoroPhaseExpired = {
      catchUpCapped: false,
      durationSeconds: 60,
      expiredAt: 60_000,
      isLastInBatch: true,
      nextPhase: 'break',
      pauseMusicDuringBreak: true,
      phase: 'focus',
    }
    effects.onPhaseExpired(breakEvent)
    effects.onPhaseExpired({ ...breakEvent, catchUpCapped: true })
    effects.onPhaseExpired({ ...breakEvent, phase: 'break', nextPhase: 'focus' })

    expect(lease.cancel).toHaveBeenCalledOnce()
    expect(lease.resumeIfStillOwned).not.toHaveBeenCalled()

    settled = false
    effects.onPhaseExpired(breakEvent)
    effects.destroy()
    expect(lease.cancel).toHaveBeenCalledTimes(2)
  })

  it('creates one short oscillator tone lazily and closes its context through the injected clock', () => {
    const { context, oscillator } = createToneContext()
    const scheduleClose = vi.fn((callback: () => void) => callback())

    playPomodoroCompletionSound({ createAudioContext: () => context, scheduleClose })

    expect(context.createOscillator).toHaveBeenCalledTimes(1)
    expect(oscillator.start).toHaveBeenCalledOnce()
    expect(oscillator.stop).toHaveBeenCalledWith(4.12)
    expect(scheduleClose).toHaveBeenCalledWith(expect.any(Function), 180)
    expect(context.close).toHaveBeenCalledOnce()
  })

  it('swallows AudioContext construction, resume, and oscillator start failures and still closes created contexts', async () => {
    expect(() => playPomodoroCompletionSound({
      createAudioContext: () => { throw new Error('constructor denied') },
    })).not.toThrow()

    const rejectedResume = createToneContext({
      state: 'suspended',
      resume: vi.fn(async () => { throw new Error('resume denied') }),
    })
    expect(() => playPomodoroCompletionSound({
      createAudioContext: () => rejectedResume.context,
      scheduleClose: (callback) => callback(),
    })).not.toThrow()
    await vi.waitFor(() => {
      expect(rejectedResume.context.close).toHaveBeenCalledOnce()
    })

    const failedStart = createToneContext()
    failedStart.oscillator.start.mockImplementation(() => { throw new Error('start denied') })
    expect(() => playPomodoroCompletionSound({
      createAudioContext: () => failedStart.context,
      scheduleClose: (callback) => callback(),
    })).not.toThrow()
    expect(failedStart.context.close).toHaveBeenCalledOnce()
  })
})
