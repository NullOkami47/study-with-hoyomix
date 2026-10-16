import { describe, expect, it, vi } from 'vitest'

import { playbackCommands, registerPlayerCommands, type PlayerCommands } from './commands'

function commands(label: string): PlayerCommands & {
  cancelLease: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resumeLease: ReturnType<typeof vi.fn>
  settleLease(): void
} {
  let settled = false
  const cancelLease = vi.fn(() => { settled = true })
  const resumeLease = vi.fn()
  return {
    isPlaying: () => true,
    pause: vi.fn(),
    pauseForInterruption: vi.fn(() => ({
      cancel: cancelLease,
      isSettled: () => settled,
      resumeIfStillOwned: resumeLease,
    })),
    play: vi.fn(),
    stop: vi.fn(),
    label,
    cancelLease,
    resumeLease,
    settleLease: () => { settled = true },
  } as PlayerCommands & {
    cancelLease: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    resumeLease: ReturnType<typeof vi.fn>
    settleLease(): void
  }
}

describe('playback command ownership', () => {
  it('restores the previous mounted player when the newest registration unmounts', () => {
    const first = commands('first')
    const second = commands('second')
    const unregisterFirst = registerPlayerCommands(first)
    const unregisterSecond = registerPlayerCommands(second)

    playbackCommands.pause()
    unregisterSecond()
    playbackCommands.pause()
    unregisterFirst()

    expect(second.pause).toHaveBeenCalledTimes(1)
    expect(first.pause).toHaveBeenCalledTimes(1)
  })

  it('does not disturb the active player when an older registration unmounts first', () => {
    const first = commands('first')
    const second = commands('second')
    const unregisterFirst = registerPlayerCommands(first)
    const unregisterSecond = registerPlayerCommands(second)

    unregisterFirst()
    playbackCommands.pause()
    unregisterSecond()

    expect(first.pause).not.toHaveBeenCalled()
    expect(second.pause).toHaveBeenCalledTimes(1)
  })

  it('lets an interruption lease resume only while its original player registration remains active', () => {
    const first = commands('first')
    const second = commands('second')
    const unregisterFirst = registerPlayerCommands(first)
    const lease = playbackCommands.pauseForInterruption()
    const unregisterSecond = registerPlayerCommands(second)

    expect(first.cancelLease).toHaveBeenCalledOnce()
    lease?.resumeIfStillOwned()
    unregisterSecond()
    lease?.resumeIfStillOwned()
    unregisterFirst()

    expect(first.resumeLease).not.toHaveBeenCalled()
    expect(second.resumeLease).not.toHaveBeenCalled()
  })

  it('removes an externally settled raw lease from registration tracking when the proxy observes settlement', () => {
    const first = commands('first')
    const second = commands('second')
    const unregisterFirst = registerPlayerCommands(first)
    const lease = playbackCommands.pauseForInterruption()

    first.settleLease()
    expect(lease?.isSettled()).toBe(true)

    const unregisterSecond = registerPlayerCommands(second)
    unregisterSecond()
    unregisterFirst()

    expect(first.cancelLease).not.toHaveBeenCalled()
  })
})
