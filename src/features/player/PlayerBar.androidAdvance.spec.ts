// Task 41.2: bug condition exploration for the Android Chrome PWA report (2026-10-28): the
// "tap to resume" notice appears when playback advances to the next track by itself. These cases
// encode the expected behaviour (Requirements 2.41, 2.42) and are expected to FAIL on the unfixed
// code; the failure message carries the relevant playback log entries (task 41.1) so the code path
// that raised the notice can be read from the output.
//
// The harness (mounted PlayerBar, real store and registry, fake timers, a model of the browser's
// media policy) lives in `test/androidAdvanceHarness.ts` and is shared with the 41.3 preservation spec.
import { afterEach, describe, expect, it } from 'vitest'
import {
  flush, mediaActivation, mediaSessionHandler, resetAndroidAdvanceEnvironment, setVisibility, show,
  setupAndroidAdvance as setup,
} from './test/androidAdvanceHarness'

afterEach(resetAndroidAdvanceEnvironment)

/** The next track plays without any tap-to-resume notice at any point. */
function expectContinuesWithoutNotice(o: ReturnType<Awaited<ReturnType<typeof setup>>['outcome']>): void {
  expect(o.track, `advanced to the next track ${show(o)}`).toBe('b')
  expect(o.activeSrcTrack, `the active element plays the next track ${show(o)}`).toBe('b')
  expect(o.activeCurrentTime, `the next track progressed ${show(o)}`).toBeGreaterThan(0)
  expect(o.status, `status reached playing after progress ${show(o)}`).toBe('playing')
  expect(o.intent, show(o)).toBe('playing')
  expect(o.tapToResumeMax, `no tap-to-resume notice was ever shown ${show(o)}`).toBe(0)
  expect(o.tapToResumeAddedInLog, `no tap-to-resume notice in the playback log ${show(o)}`).toBe(0)
}

describe('Android Chrome PWA: automatic advance continues without tap-to-resume (task 41.2, Requirements 2.41, 2.42)', () => {
  it('case 1: hidden page, play() refused on a never-played element, allowed on the element that played', async () => {
    const h = await setup(mediaActivation, 'hidden')
    try {
      await h.endFirstTrack()
      await h.observe(20_000)
      expectContinuesWithoutNotice(h.outcome())
    } finally { h.dispose() }
  })

  // Variant of case 1 on a phone network: the element that played starts the next track from an
  // empty buffer (the preload went to the refused element), so its first progress takes 6 s.
  it('case 1b: hidden page, media activation model, and the swapped element needs 6 s to start', async () => {
    const h = await setup({ ...mediaActivation, startDelayMs: 6_000 }, 'hidden')
    try {
      await h.endFirstTrack()
      await h.observe(20_000)
      expectContinuesWithoutNotice(h.outcome())
    } finally { h.dispose() }
  })

  it('case 2: foreground page, same media activation model', async () => {
    const h = await setup(mediaActivation, 'visible')
    try {
      await h.endFirstTrack()
      await h.observe(20_000)
      expectContinuesWithoutNotice(h.outcome())
    } finally { h.dispose() }
  })

  it('case 3: slow start, the promoted element buffers for 8 s with network activity, then progresses', async () => {
    const h = await setup({ decide: () => 'resolve', startDelayMs: 8_000 }, 'visible')
    try {
      const resolvesBefore = h.resolvesOf('b')
      await h.endFirstTrack()
      const promotedDeck = h.active().dataset.audioDeck
      await h.observe(20_000)
      const o = h.outcome()
      expectContinuesWithoutNotice(o)
      expect(o.resolvesOfB, `no re-resolve of the next track ${show(o)}`).toBe(resolvesBefore)
      expect(o.ladderSteps, `no ladder step while the element is still loading ${show(o)}`).toEqual([])
      expect(o.activeDeck, `the promoted element kept playing ${show(o)}`).toBe(promotedDeck)
    } finally { h.dispose() }
  })

  // Cases 1b and 3 again under the HTML spec's promise timing (task 41.6, review PRRT_kwDOTzYk1s6xDs9d):
  // a real device keeps play() pending until playback starts, so the watchdog sees a pending, not a
  // resolved, play() while the element buffers.
  it('case 1b (pending play()): play() stays pending until the swapped element starts after 6 s', async () => {
    const h = await setup({ ...mediaActivation, startDelayMs: 6_000, pendingPlayUntilStart: true }, 'hidden')
    try {
      await h.endFirstTrack()
      await h.observe(20_000)
      expectContinuesWithoutNotice(h.outcome())
    } finally { h.dispose() }
  })

  it('case 3 (pending play()): play() stays pending while the promoted element buffers for 8 s', async () => {
    const h = await setup({ decide: () => 'resolve', startDelayMs: 8_000, pendingPlayUntilStart: true }, 'visible')
    try {
      const resolvesBefore = h.resolvesOf('b')
      await h.endFirstTrack()
      const promotedDeck = h.active().dataset.audioDeck
      await h.observe(20_000)
      const o = h.outcome()
      expectContinuesWithoutNotice(o)
      expect(o.resolvesOfB, `no re-resolve of the next track ${show(o)}`).toBe(resolvesBefore)
      expect(o.ladderSteps, `no ladder step while the element is still loading ${show(o)}`).toEqual([])
      expect(o.watchdogFires, `the watchdog extended while play() was pending ${show(o)}`).toContain('extend')
      expect(o.activeDeck, `the promoted element kept playing ${show(o)}`).toBe(promotedDeck)
    } finally { h.dispose() }
  })

  it('case 4: genuine refusal while hidden resumes by itself when the page becomes visible', async () => {
    const h = await setup({ decide: (_element, { visibility: page }) => page === 'visible' ? 'resolve' : 'reject' }, 'hidden')
    try {
      await h.endFirstTrack()
      await h.observe(20_000)
      const whileHidden = h.outcome()
      setVisibility('visible'); await flush()
      await h.observe(10_000)
      const o = h.outcome()
      expect(o.track, show(o)).toBe('b')
      expect(o.activeSrcTrack, `the next track plays after becoming visible, without a tap ${show(o)}`).toBe('b')
      expect(o.activeCurrentTime, `progress after becoming visible ${show(o)}`).toBeGreaterThan(0)
      expect(o.status, `status playing after the automatic resume ${show(o)}`).toBe('playing')
      expect(o.tapToResumeNow, `no tap-to-resume notice left after the automatic resume ${show(o)}`).toBe(0)
      expect(whileHidden.intent, show(whileHidden)).toBe('playing')
    } finally { h.dispose() }
  })

  it('case 5: a Media Session play action after a refusal resumes playback', async () => {
    let granted = false
    const h = await setup({ decide: () => granted ? 'resolve' : 'reject' }, 'hidden')
    try {
      await h.endFirstTrack()
      await h.observe(20_000)
      const handler = mediaSessionHandler(h.session, 'play')
      expect(handler, 'a Media Session play handler is registered').toBeTypeOf('function')
      // Chrome grants activation to a Media Session action (notification or lock-screen control).
      granted = true
      handler?.({ action: 'play' }); await flush()
      await h.observe(10_000)
      const o = h.outcome()
      expect(o.track, show(o)).toBe('b')
      expect(o.activeSrcTrack, show(o)).toBe('b')
      expect(o.activeCurrentTime, `progress after the Media Session play action ${show(o)}`).toBeGreaterThan(0)
      expect(o.status, show(o)).toBe('playing')
      expect(o.tapToResumeNow, `the notice is gone after the Media Session play action ${show(o)}`).toBe(0)
    } finally { h.dispose() }
  })
})
