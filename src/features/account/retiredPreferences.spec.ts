import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { usePreferences } from '../../stores/preferences'
import { captureAccountPreferences } from './accountPreferences'
import { parseSyncedUserPreferences } from './syncPreferences'

describe('retired low power preference', () => {
  it('cannot enable the retired preference and excludes it from uploads', () => {
    const preferences = usePreferences()
    preferences.setLowPower(true)
    expect(preferences.lowPower.value).toBe(false)
    expect(captureAccountPreferences(preferences, { volume: ref(.5), setVolume() {} })).not.toHaveProperty('lowPower')
  })
  it('reads old account records and normalises only the retired field', () => {
    const current = captureAccountPreferences(usePreferences(), { volume: ref(.7), setVolume() {} })
    expect(parseSyncedUserPreferences({ ...current, lowPower: true })).toEqual(current)
  })
})
