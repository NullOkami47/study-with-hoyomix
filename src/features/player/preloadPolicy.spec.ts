import { describe, expect, it } from 'vitest'

import { isNextTrackPreloadDue, NEXT_TRACK_PRELOAD_PROGRESS_RATIO, selectPreloadPolicy } from './preloadPolicy'

describe('next-track preload policy', () => {
  it('disables preload while offline', () => {
    expect(selectPreloadPolicy({ online: false, connection: { effectiveType: '4g', saveData: false } })).toBe('none')
    expect(selectPreloadPolicy({ online: false })).toBe('none')
  })

  it('uses metadata only when Save-Data is enabled', () => {
    expect(selectPreloadPolicy({ online: true, connection: { effectiveType: '4g', saveData: true } })).toBe('metadata')
    expect(selectPreloadPolicy({ online: true, connection: { saveData: true } })).toBe('metadata')
  })

  it.each(['slow-2g', '2g'])('uses metadata only on %s', (effectiveType) => {
    expect(selectPreloadPolicy({ online: true, connection: { effectiveType, saveData: false } })).toBe('metadata')
  })

  it('allows native auto preload on 3g unless Save-Data is enabled', () => {
    expect(selectPreloadPolicy({ online: true, connection: { effectiveType: '3g', saveData: false } })).toBe('auto')
    expect(selectPreloadPolicy({ online: true, connection: { effectiveType: '3g', saveData: true } })).toBe('metadata')
  })

  it('allows native auto preload on 4g', () => {
    expect(selectPreloadPolicy({ online: true, connection: { effectiveType: '4g', saveData: false } })).toBe('auto')
  })

  it('allows native auto preload when the Network Information API is unavailable', () => {
    expect(selectPreloadPolicy({ online: true })).toBe('auto')
  })

  it('allows native auto preload when effectiveType is absent', () => {
    expect(selectPreloadPolicy({ online: true, connection: {} })).toBe('auto')
    expect(selectPreloadPolicy({ online: true, connection: { saveData: false } })).toBe('auto')
  })

  it('allows native auto preload for unconstrained or unknown effective types', () => {
    expect(selectPreloadPolicy({ online: true, connection: { effectiveType: 'wifi', saveData: false } })).toBe('auto')
    expect(selectPreloadPolicy({ online: true, connection: { effectiveType: '5g', saveData: false } })).toBe('auto')
    expect(selectPreloadPolicy({ online: true, connection: { effectiveType: 'unknown', saveData: false } })).toBe('auto')
  })

  it('arms next-track preload once half of the current track has played', () => {
    expect(NEXT_TRACK_PRELOAD_PROGRESS_RATIO).toBe(0.5)
    expect(isNextTrackPreloadDue(10, 0)).toBe(false)
    expect(isNextTrackPreloadDue(10, Number.NaN)).toBe(false)
    expect(isNextTrackPreloadDue(Number.NaN, 200)).toBe(false)
    expect(isNextTrackPreloadDue(119.9, 240)).toBe(false)
    expect(isNextTrackPreloadDue(120, 240)).toBe(true)
    expect(isNextTrackPreloadDue(180, 240)).toBe(true)
  })
})
