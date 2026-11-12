// Task 41.3: preservation tests for the Android Chrome PWA automatic-advance fix (task 41.4).
// Observation first: each case encodes what the UNFIXED code does for inputs outside the bug
// condition, and MUST PASS both before and after the fix (Requirements 3.1, 3.3).
//
// The 41.4 fix changes only: the 5 s handover watchdog while the element is loading with network
// activity; removal of the tap-to-resume notice once playback progresses; automatic start retries
// on visibility, page resume, focus, online, pointerdown/keydown and Media Session play, plus a
// bounded backoff while visible; and starting the next track on the element that already played.
// None of these inputs below meet those conditions, or the assertions only pin the end state so
// a bounded retry stays allowed.
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  flush, makeTrack, mediaSessionHandler, resetAndroidAdvanceEnvironment, setVisibility, show,
  setupAndroidAdvance as setup, type AndroidAdvanceHarness, type BrowserModel,
} from './test/androidAdvanceHarness'

afterEach(resetAndroidAdvanceEnvironment)

const allow: BrowserModel = { decide: () => 'resolve' }
/** A browser that honours `pause()` and seeks (the opt-in part of the shared model). */
const allowRealistic: BrowserModel = { decide: () => 'resolve', honourPauseAndSeek: true }

/** Automatic advance a -> b where b starts at once on the promoted element; returns that deck. */
async function advanceAndPlay(h: AndroidAdvanceHarness, ms = 5_000): Promise<string | undefined> {
  await h.endFirstTrack()
  const promoted = h.active().dataset.audioDeck
  await h.observe(ms)
  return promoted
}

function expectPlayingWithoutNotice(o: ReturnType<AndroidAdvanceHarness['outcome']>, track: string): void {
  expect(o.track, show(o)).toBe(track)
  expect(o.activeSrcTrack, `the active element plays ${track} ${show(o)}`).toBe(track)
  expect(o.activeCurrentTime, `progress ${show(o)}`).toBeGreaterThan(0)
  expect(o.status, show(o)).toBe('playing')
  expect(o.intent, show(o)).toBe('playing')
  expect(o.tapToResumeMax, `no tap-to-resume notice ${show(o)}`).toBe(0)
  expect(o.tapToResumeAddedInLog, `no tap-to-resume notice in the log ${show(o)}`).toBe(0)
}

/** Every page event the 41.4 fix may use to retry a start. */
async function firePageRetryEvents(): Promise<void> {
  setVisibility('hidden'); await flush()
  setVisibility('visible'); await flush()
  document.dispatchEvent(new Event('resume')); await flush()
  window.dispatchEvent(new Event('pageshow')); await flush()
  window.dispatchEvent(new Event('focus')); await flush()
  window.dispatchEvent(new Event('online')); await flush()
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); await flush()
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true })); await flush()
}

describe('Android automatic advance: preservation (task 41.3, Requirements 3.1, 3.3)', () => {
  describe('1. foreground automatic advance where the promoted element starts quickly', () => {
    it('plays the next track on the promoted (preloaded) element: no ladder step, notice or extra resolve', async () => {
      const h = await setup(allow, 'visible')
      try {
        const resolvesBefore = h.resolvesOf('b')
        const promoted = await advanceAndPlay(h, 10_000)
        const o = h.outcome()
        expectPlayingWithoutNotice(o, 'b')
        expect(o.activeDeck, `the promoted element plays ${show(o)}`).toBe(promoted)
        expect(o.activeIsFirst, `not the element that played a ${show(o)}`).toBe(false)
        expect(o.ladderSteps, show(o)).toEqual([])
        expect(o.resolvesOfB, `no extra resolve of b ${show(o)}`).toBe(resolvesBefore)
      } finally { h.dispose() }
    })

    it('property: any start delay under 4 s in the foreground never produces a notice or ladder step', async () => {
      await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 3_999 }), async (startDelayMs) => {
        const h = await setup({ decide: () => 'resolve', startDelayMs }, 'visible')
        try {
          const resolvesBefore = h.resolvesOf('b')
          const promoted = await advanceAndPlay(h, 12_000)
          const o = h.outcome()
          expectPlayingWithoutNotice(o, 'b')
          expect(o.activeDeck, show(o)).toBe(promoted)
          expect(o.ladderSteps, show(o)).toEqual([])
          expect(o.resolvesOfB, show(o)).toBe(resolvesBefore)
        } finally { h.dispose(); resetAndroidAdvanceEnvironment() }
      }), { numRuns: 8, seed: 4103, endOnFailure: true })
    }, 120_000)
  })

  it('2. a Media Session play action after a refusal resumes playback', async () => {
    let granted = false
    const h = await setup({ decide: () => granted ? 'resolve' : 'reject' }, 'hidden')
    try {
      await h.endFirstTrack()
      await h.observe(20_000)
      expect(h.outcome().tapToResumeNow, show(h.outcome())).toBe(1)
      const handler = mediaSessionHandler(h.session, 'play')
      expect(handler, 'a Media Session play handler is registered').toBeTypeOf('function')
      granted = true
      handler?.({ action: 'play' }); await flush()
      await h.observe(10_000)
      const o = h.outcome()
      expect(o.track, show(o)).toBe('b')
      expect(o.activeSrcTrack, show(o)).toBe('b')
      expect(o.activeCurrentTime, show(o)).toBeGreaterThan(0)
      expect(o.status, show(o)).toBe('playing')
      expect(o.tapToResumeNow, `the notice is gone ${show(o)}`).toBe(0)
    } finally { h.dispose() }
  })

  describe('3. a user pause is never undone by an automatic retry', () => {
    it('pause while the next track is still starting: page events do not call play() or start playback', async () => {
      const h = await setup({ ...allowRealistic, startDelayMs: 3_000 }, 'visible')
      try {
        await h.endFirstTrack()
        await h.observe(1_000)
        await h.wrapper.get('[data-player-play]').trigger('click'); await flush()
        expect(h.store.playbackIntent.value, show(h.outcome())).toBe('paused')
        const callsAtPause = h.playCalls.length
        await firePageRetryEvents()
        await h.observe(30_000)
        await firePageRetryEvents()
        await h.observe(30_000)
        const o = h.outcome()
        expect(o.playCalls.length, `no play() after the user paused ${show(o)}`).toBe(callsAtPause)
        expect(o.intent, show(o)).toBe('paused')
        expect(o.status, show(o)).not.toBe('playing')
        expect(o.activeCurrentTime, `the paused element did not progress ${show(o)}`).toBe(0)
        expect(o.tapToResumeMax, show(o)).toBe(0)
      } finally { h.dispose() }
    })

    it('pause after the next track progressed: page events do not call play() or resume playback', async () => {
      const h = await setup(allowRealistic, 'visible')
      try {
        await advanceAndPlay(h, 5_000)
        expect(h.store.status.value, show(h.outcome())).toBe('playing')
        await h.wrapper.get('[data-player-play]').trigger('click'); await flush()
        await h.observe(1_000)
        const paused = h.outcome()
        expect(paused.intent, show(paused)).toBe('paused')
        expect(paused.status, show(paused)).toBe('paused')
        const callsAtPause = h.playCalls.length
        const positionAtPause = h.active().currentTime
        await firePageRetryEvents()
        await h.observe(30_000)
        await firePageRetryEvents()
        await h.observe(30_000)
        const o = h.outcome()
        expect(o.playCalls.length, `no play() after the user paused ${show(o)}`).toBe(callsAtPause)
        expect(o.intent, show(o)).toBe('paused')
        expect(o.status, show(o)).toBe('paused')
        expect(o.activeCurrentTime, show(o)).toBe(positionAtPause)
        expect(o.track, show(o)).toBe('b')
        expect(o.tapToResumeMax, show(o)).toBe(0)
      } finally { h.dispose() }
    })
  })

  describe('4. a genuine permanent failure still ends via the existing paths', () => {
    it('media error code 4 on every load of b: failCurrent moves on, play() stays bounded', async () => {
      const h = await setup({ decide: () => 'resolve', mediaErrorCode: (src) => src.includes('/jellyfin/b-') ? 4 : undefined }, 'visible')
      try {
        await h.endFirstTrack()
        await h.observe(60_000)
        const o = h.outcome()
        expect(o.failCurrentOutcomes, `failCurrent decided ${show(o)}`).toContain('skipped')
        expect(o.noticeKinds, show(o)).toContain('skipped')
        expect(o.track, `moved on from b ${show(o)}`).not.toBe('b')
        expect(o.playCalls.filter((call) => call.src?.includes('/jellyfin/b-')).length, `bounded play() of b ${show(o)}`).toBeLessThanOrEqual(20)
        expect(o.playCalls.length, show(o)).toBeLessThanOrEqual(20)
      } finally { h.dispose() }
    })

    it('every play() refused (NotAllowedError) in the foreground with no progress: the notice is shown, play() bounded', async () => {
      const h = await setup({ decide: () => 'reject' }, 'visible')
      try {
        await h.endFirstTrack()
        await h.observe(60_000)
        const o = h.outcome()
        expect(o.tapToResumeNow, `the tap-to-resume notice is shown ${show(o)}`).toBe(1)
        expect(o.track, show(o)).toBe('b')
        expect(o.status, show(o)).not.toBe('playing')
        expect(o.intent, show(o)).toBe('playing')
        expect(o.activeCurrentTime, show(o)).toBe(0)
        expect(o.playCalls.length, `bounded play() calls over 60 s ${show(o)}`).toBeLessThanOrEqual(20)
      } finally { h.dispose() }
    })

    it('every play() failing with NotSupportedError: failCurrent skips, then the queue is unplayable', async () => {
      const h = await setup({ decide: () => 'reject', rejectWith: 'NotSupportedError' }, 'visible')
      try {
        await h.endFirstTrack()
        await h.observe(60_000)
        const o = h.outcome()
        expect(o.failCurrentOutcomes, show(o)).toContain('skipped')
        expect(o.failCurrentOutcomes.at(-1), show(o)).toBe('halted')
        expect(o.noticeKinds, show(o)).toContain('queueUnplayable')
        expect(o.status, show(o)).toBe('error')
        expect(o.tapToResumeMax, show(o)).toBe(0)
        expect(o.playCalls.length, show(o)).toBeLessThanOrEqual(20)
      } finally { h.dispose() }
    })
  })

  describe('5. listener commands during playback are unchanged', () => {
    it('Next: plays the following track without a notice', async () => {
      const h = await setup(allow, 'visible')
      try {
        await advanceAndPlay(h)
        await h.wrapper.get('[data-player-next]').trigger('click'); await flush()
        await h.observe(5_000)
        expectPlayingWithoutNotice(h.outcome(), 'c')
      } finally { h.dispose() }
    })

    it('Play Now: plays the chosen track without a notice', async () => {
      const h = await setup(allow, 'visible')
      try {
        await advanceAndPlay(h)
        await h.store.playNow(makeTrack('x')); await flush()
        await h.observe(5_000)
        expectPlayingWithoutNotice(h.outcome(), 'x')
      } finally { h.dispose() }
    })

    it('seek during playback: moves the position and keeps playing the same track', async () => {
      const h = await setup(allowRealistic, 'visible')
      try {
        await advanceAndPlay(h)
        const seek = h.wrapper.get<HTMLInputElement>('[data-player-seek]')
        seek.element.value = '100'
        await seek.trigger('input'); await flush()
        expect(h.active().currentTime, show(h.outcome())).toBe(100)
        await h.observe(5_000)
        const o = h.outcome()
        expectPlayingWithoutNotice(o, 'b')
        expect(o.activeCurrentTime, `progress continues after the seek ${show(o)}`).toBeGreaterThanOrEqual(100)
        expect(o.ladderSteps, show(o)).toEqual([])
      } finally { h.dispose() }
    })

    it('repeat one: the ended track plays again without a notice', async () => {
      const h = await setup(allow, 'visible')
      try {
        h.store.setRepeatMode('one')
        await h.endFirstTrack()
        await h.observe(10_000)
        expectPlayingWithoutNotice(h.outcome(), 'a')
      } finally { h.dispose() }
    })
  })

  it('6. tapping Play on the notice resumes and removes the notice', async () => {
    let granted = false
    const h = await setup({ decide: () => granted ? 'resolve' : 'reject' }, 'visible')
    try {
      await h.endFirstTrack()
      await h.observe(60_000)
      expect(h.outcome().tapToResumeNow, show(h.outcome())).toBe(1)
      granted = true
      await h.wrapper.get('[data-player-notice-resume]').trigger('click'); await flush()
      expect(h.outcome().tapToResumeNow, `store.play() removed the notice ${show(h.outcome())}`).toBe(0)
      await h.observe(10_000)
      const o = h.outcome()
      expect(o.track, show(o)).toBe('b')
      expect(o.activeSrcTrack, show(o)).toBe('b')
      expect(o.activeCurrentTime, show(o)).toBeGreaterThan(0)
      expect(o.status, show(o)).toBe('playing')
      expect(o.tapToResumeNow, show(o)).toBe(0)
    } finally { h.dispose() }
  })
})
