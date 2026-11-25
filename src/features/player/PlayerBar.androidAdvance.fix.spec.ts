// Task 41.4: the decisions the Android automatic-advance fix adds, on the shared 41.2/41.3 harness:
// the bounded loading extension of the handover watchdog, the automatic resume on page events
// (logged with the event name, keeping the notice until progress) and the notice auto-clear.
import { afterEach, describe, expect, it } from 'vitest'
import { playbackLog } from './playbackLog'
import {
  flush, micro, resetAndroidAdvanceEnvironment, setVisibility, show, setupAndroidAdvance as setup,
} from './test/androidAdvanceHarness'

afterEach(resetAndroidAdvanceEnvironment)

const logOf = (type: string) => playbackLog.snapshot().filter((entry) => entry.type === type)

describe('Android automatic advance fix (task 41.4, Requirements 2.41, 2.42)', () => {
  it('a load that never progresses extends the watchdog only up to the bound, then runs the ladder', async () => {
    const h = await setup({ decide: () => 'resolve', startDelayMs: 600_000 }, 'visible')
    try {
      await h.endFirstTrack()
      await h.observe(15_000)
      const early = h.outcome()
      expect(early.ladderSteps, `no ladder step inside the loading bound ${show(early)}`).toEqual([])
      expect(early.watchdogFires.length, show(early)).toBeGreaterThanOrEqual(2)
      expect(early.watchdogFires.every((decision) => decision === 'extend'), show(early)).toBe(true)
      await h.observe(15_000)
      const o = h.outcome()
      expect(o.ladderSteps.slice(0, 1), `the ladder runs once the bound is reached ${show(o)}`).toEqual(['srcSwap'])
      expect(o.tapToResumeRaiseSites, `a stuck load still ends in the notice ${show(o)}`).toEqual(['handoverLadder'])
      expect(logOf('handover.watchdog.extend').every((entry) => Number(entry.elapsedMs) < 20_000), show(o)).toBe(true)
    } finally { h.dispose() }
  })

  it('a refused automatic resume keeps the notice; a later focus resumes and progress clears the notice', async () => {
    let granted = false
    const h = await setup({ decide: () => granted ? 'resolve' : 'reject' }, 'hidden')
    try {
      await h.endFirstTrack()
      await h.observe(5_000)
      document.dispatchEvent(new Event('pointerdown')); await flush()
      await h.observe(2_000)
      const refused = h.outcome()
      expect(logOf('autoResume.trigger').map((entry) => entry.trigger), show(refused)).toContain('pointerdown')
      expect(logOf('autoResume.outcome').map((entry) => entry.outcome), show(refused)).toEqual(['refused'])
      expect(refused.tapToResumeNow, `the notice stays after a refused automatic attempt ${show(refused)}`).toBe(1)
      expect(refused.tapToResumeAddedInLog, `the notice is not raised again ${show(refused)}`).toBe(1)

      granted = true
      window.dispatchEvent(new Event('focus')); await flush()
      await h.observe(5_000)
      const o = h.outcome()
      expect(o.status, show(o)).toBe('playing')
      expect(o.activeCurrentTime, show(o)).toBeGreaterThan(0)
      expect(o.tapToResumeNow, `progress cleared the notice ${show(o)}`).toBe(0)
      expect(logOf('notice.autoClear'), show(o)).toHaveLength(1)
    } finally { h.dispose() }
  })

  it('pending play() model: a slow automatic resume reports pending after the settle bound, then progress clears the notice', async () => {
    let granted = false
    const h = await setup({ decide: () => granted ? 'resolve' : 'reject', startDelayMs: 8_000, pendingPlayUntilStart: true }, 'hidden')
    try {
      await h.endFirstTrack()
      await h.observe(5_000)
      expect(h.tapNotices(), 'the refusal raised the notice').toBe(1)
      granted = true
      window.dispatchEvent(new Event('focus')); await flush()
      await h.observe(6_000)
      const pending = h.outcome()
      expect(logOf('autoResume.outcome').map((entry) => entry.outcome), show(pending)).toContain('pending')
      expect(pending.tapToResumeNow, `the notice stays while play() is pending ${show(pending)}`).toBe(1)
      expect(pending.tapToResumeAddedInLog, `the notice is not raised again ${show(pending)}`).toBe(1)
      await h.observe(6_000)
      const o = h.outcome()
      expect(o.status, show(o)).toBe('playing')
      expect(o.activeCurrentTime, show(o)).toBeGreaterThan(0)
      expect(o.tapToResumeNow, `progress cleared the notice ${show(o)}`).toBe(0)
    } finally { h.dispose() }
  })

  it('AbortError model: an aborted automatic resume is refused, the backoff retries and progress clears the notice', async () => {
    let granted = false
    const h = await setup({ decide: () => granted ? 'resolve' : 'reject', rejectWith: 'AbortError' }, 'visible')
    try {
      await h.endFirstTrack()
      await h.observe(7_500)
      const aborted = h.outcome()
      expect(h.tapNotices(), `the aborted handover ended in the notice ${show(aborted)}`).toBe(1)
      const refusedOutcomes = logOf('autoResume.outcome').map((entry) => entry.outcome)
      expect(logOf('autoResume.attempt').every((entry) => entry.trigger === 'backoff'), show(aborted)).toBe(true)
      expect(refusedOutcomes.length, `an automatic attempt ran ${show(aborted)}`).toBeGreaterThanOrEqual(1)
      expect(refusedOutcomes.every((outcome) => outcome === 'refused'), `an AbortError is not accepted ${show(aborted)}`).toBe(true)
      expect(logOf('autoResume.backoff'), `each refused attempt schedules the next retry ${show(aborted)}`).toHaveLength(refusedOutcomes.length + 1)
      expect(aborted.tapToResumeNow, `the notice stays ${show(aborted)}`).toBe(1)
      expect(aborted.tapToResumeAddedInLog, `the notice is not raised again ${show(aborted)}`).toBe(1)

      granted = true
      await h.observe(20_000)
      const o = h.outcome()
      expect(logOf('autoResume.outcome').map((entry) => entry.outcome), show(o)).toEqual([...refusedOutcomes, 'accepted'])
      expect(h.playCalls.filter((call) => call.at >= Date.now() - 60_000).length, `bounded retries ${show(o)}`).toBeLessThanOrEqual(20)
      expect(o.status, show(o)).toBe('playing')
      expect(o.activeCurrentTime, show(o)).toBeGreaterThan(0)
      expect(o.tapToResumeNow, `progress cleared the notice ${show(o)}`).toBe(0)
      expect(o.tapToResumeAddedInLog, show(o)).toBe(1)
    } finally { h.dispose() }
  })

  it('no automatic resume after unmount', async () => {
    const h = await setup({ decide: () => 'reject' }, 'hidden')
    await h.endFirstTrack()
    await h.observe(5_000)
    expect(h.tapNotices()).toBe(1)
    h.dispose()
    const calls = h.playCalls.length
    setVisibility('visible'); await micro()
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('pointerdown')); await micro()
    expect(h.playCalls.length, 'listeners removed on unmount').toBe(calls)
  })
})
