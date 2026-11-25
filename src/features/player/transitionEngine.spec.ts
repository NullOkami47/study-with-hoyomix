import { describe, expect, it } from 'vitest'
import { boundedOverlapDuration, fadeGains, isTransitionMode, supportsNativeVolumeControl, transitionDuration } from './transitionEngine'

describe('bounded transition envelope', () => {
  it('keeps exact endpoints and peak-safe combined user volume', () => {
    expect(fadeGains(0, .7)).toEqual([.7, 0])
    expect(fadeGains(1, .7)).toEqual([0, .7])
    for (const volume of [0, .01, .4, .8, 1]) {
      let previousOutgoing = volume, previousIncoming = 0
      for (let i = 0; i <= 1000; i++) {
        const [outgoing, incoming] = fadeGains(i / 1000, volume)
        expect(outgoing + incoming).toBeCloseTo(volume, 14)
        expect(outgoing).toBeGreaterThanOrEqual(0)
        expect(incoming).toBeGreaterThanOrEqual(0)
        expect(outgoing).toBeLessThanOrEqual(previousOutgoing)
        expect(incoming).toBeGreaterThanOrEqual(previousIncoming)
        previousOutgoing = outgoing
        previousIncoming = incoming
      }
    }
    expect(fadeGains(.5, 0)).toEqual([0, 0])
    expect(fadeGains(.5, .8)[0]).toBeCloseTo(.4)
  })

  it('clamps progress and volume without producing a non-finite or negative gain', () => {
    for (const progress of [-100, 0, .25, .5, 1, 100, NaN, Infinity, -Infinity]) {
      for (const volume of [-1, 0, .37, 1, 2, NaN, Infinity, -Infinity]) {
        const first = fadeGains(progress, volume)
        expect(fadeGains(progress, volume)).toEqual(first)
        expect(first.every(gain => Number.isFinite(gain) && gain >= 0 && gain <= 1)).toBe(true)
        expect(first[0] + first[1]).toBeCloseTo(Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0)
      }
    }
    expect(fadeGains(-1, .7)).toEqual([.7, 0])
    expect(fadeGains(2, .7)).toEqual([0, .7])
  })

  it('bounds invalid, automatic and manual durations', () => {
    expect(transitionDuration(NaN)).toBe(5)
    expect(transitionDuration(Infinity)).toBe(5)
    expect(transitionDuration(100)).toBe(12)
    expect(transitionDuration(-1)).toBe(2)
    expect(transitionDuration(5, true)).toBe(1.5)
    expect(transitionDuration(NaN, true)).toBe(1.5)
    expect(transitionDuration(100, true)).toBe(1.5)
  })

  it('accepts only explicit supported transition modes', () => {
    for (const mode of ['off', 'crossfade', 'smart']) expect(isTransitionMode(mode)).toBe(true)
    for (const mode of ['', 'Smart', null, undefined, {}, 1, 'jellyfin']) expect(isTransitionMode(mode)).toBe(false)
  })
})

describe('native volume capability probe', () => {
  it.each([false, true])('restores the original volume and muted=%s after probing', originallyMuted => {
    let volume = .37
    let muted = originallyMuted
    const volumeWrites: number[] = []
    const muteWrites: boolean[] = []
    const element = {
      get volume() { return volume },
      set volume(value: number) {
        expect(muted).toBe(true)
        volumeWrites.push(value)
        volume = value
      },
      get muted() { return muted },
      set muted(value: boolean) { muteWrites.push(value); muted = value },
      paused: true,
      play: () => { throw new Error('must not play') },
      load: () => { throw new Error('must not load') },
      get src() { return 'https://media.invalid/incoming.mp3' },
      set src(_value: string) { throw new Error('must not change src') },
    }

    expect(supportsNativeVolumeControl(element)).toBe(true)
    expect(volumeWrites).toEqual([0, .5, .37])
    expect(muteWrites).toEqual([true, originallyMuted])
    expect(element.volume).toBe(.37)
    expect(element.muted).toBe(originallyMuted)
    expect(element.src).toBe('https://media.invalid/incoming.mp3')
  })

  it.each([0, .37, 1])('rejects an ignored volume setter initially at %s', originalVolume => {
    const element = {
      get volume() { return originalVolume },
      set volume(_value: number) {},
      muted: false,
      paused: true,
    }

    expect(supportsNativeVolumeControl(element)).toBe(false)
    expect(element.volume).toBe(originalVolume)
    expect(element.muted).toBe(false)
  })

  it('requires a correct mid-volume readback as well as a working zero', () => {
    let volume = .37
    const element = {
      get volume() { return volume },
      set volume(value: number) { volume = value === .5 ? 1 : value },
      muted: false,
      paused: true,
    }

    expect(supportsNativeVolumeControl(element)).toBe(false)
    expect(element.volume).toBe(.37)
    expect(element.muted).toBe(false)
  })

  it('restores both properties when a probe setter changes volume and throws', () => {
    let volume = .37
    const element = {
      get volume() { return volume },
      set volume(value: number) {
        volume = value
        if (value === .5) throw new Error('volume setter failed')
      },
      muted: false,
      paused: true,
    }

    expect(supportsNativeVolumeControl(element)).toBe(false)
    expect(element.volume).toBe(.37)
    expect(element.muted).toBe(false)
  })

  it('restores both properties when probe readback throws', () => {
    let volume = .37
    const element = {
      get volume() {
        if (volume === .5) throw new Error('volume readback failed')
        return volume
      },
      set volume(value: number) { volume = value },
      muted: true,
      paused: true,
    }

    expect(supportsNativeVolumeControl(element)).toBe(false)
    expect(element.volume).toBe(.37)
    expect(element.muted).toBe(true)
  })

  it('still restores mute state when restoring volume throws', () => {
    let volume = .37
    const element = {
      get volume() { return volume },
      set volume(value: number) {
        volume = value
        if (value === .37) throw new Error('volume restoration failed')
      },
      muted: false,
      paused: true,
    }

    expect(supportsNativeVolumeControl(element)).toBe(false)
    expect(element.volume).toBe(.37)
    expect(element.muted).toBe(false)
  })

  it('does not change volume when muting is ignored', () => {
    let volumeWrites = 0
    const element = {
      get volume() { return .37 },
      set volume(_value: number) { volumeWrites++ },
      get muted() { return false },
      set muted(_value: boolean) {},
      paused: true,
    }

    expect(supportsNativeVolumeControl(element)).toBe(false)
    expect(volumeWrites).toBe(0)
    expect(element.muted).toBe(false)
  })

  it('restores mute state after a muting setter changes it and throws', () => {
    let muted = false
    const element = {
      get volume() { return .37 },
      set volume(_value: number) { throw new Error('must not probe before muting') },
      get muted() { return muted },
      set muted(value: boolean) {
        muted = value
        if (value) throw new Error('muting failed')
      },
      paused: true,
    }

    expect(supportsNativeVolumeControl(element)).toBe(false)
    expect(element.volume).toBe(.37)
    expect(element.muted).toBe(false)
  })

  it('does not read or write volume or mute state on playing media', () => {
    const element = {
      get volume(): number { throw new Error('must not read active volume') },
      set volume(_value: number) { throw new Error('must not write active volume') },
      get muted(): boolean { throw new Error('must not read active mute state') },
      set muted(_value: boolean) { throw new Error('must not write active mute state') },
      paused: false,
    }

    expect(supportsNativeVolumeControl(element)).toBe(false)
  })
})

describe('safe overlap duration', () => {
  it('caps the fade by outgoing slack and half of the incoming track', () => {
    expect(boundedOverlapDuration(5, 10, 30)).toBe(5)
    expect(boundedOverlapDuration(5, 4, 30)).toBeCloseTo(3.9)
    expect(boundedOverlapDuration(12, 10, 2)).toBe(1)
    expect(boundedOverlapDuration(1.5, .6, .8)).toBe(.4)
  })

  it('accepts the minimum overlap at each limiting boundary', () => {
    expect(boundedOverlapDuration(.25, 10, 30)).toBe(.25)
    expect(boundedOverlapDuration(5, .35, 30)).toBe(.25)
    expect(boundedOverlapDuration(5, 10, .5)).toBe(.25)
  })

  it.each([NaN, Infinity, -Infinity, -1, 0])('refuses %s in any duration input', invalid => {
    expect(boundedOverlapDuration(invalid, 10, 10)).toBe(0)
    expect(boundedOverlapDuration(5, invalid, 10)).toBe(0)
    expect(boundedOverlapDuration(5, 10, invalid)).toBe(0)
  })

  it('returns zero instead of extending an unusably short overlap', () => {
    expect(boundedOverlapDuration(.249, 10, 10)).toBe(0)
    expect(boundedOverlapDuration(5, .349, 10)).toBe(0)
    expect(boundedOverlapDuration(5, 10, .499)).toBe(0)
    expect(boundedOverlapDuration(5, .1, 10)).toBe(0)
  })
})
