import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REFRACTION_PREFERENCE_KEY,
  refractionPreference,
  reloadRefractionPreference,
  setRefractionPreference,
} from './refractionPreference'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
  reloadRefractionPreference()
})

describe('refraction preference', () => {
  it('round-trips on and off through localStorage', () => {
    setRefractionPreference(false)
    expect(window.localStorage.getItem(REFRACTION_PREFERENCE_KEY)).toBe('off')
    expect(refractionPreference.value).toBe('off')
    setRefractionPreference(true)
    expect(window.localStorage.getItem(REFRACTION_PREFERENCE_KEY)).toBe('on')
    reloadRefractionPreference()
    expect(refractionPreference.value).toBe('on')
  })

  it('treats an absent or invalid stored value as automatic', () => {
    reloadRefractionPreference()
    expect(refractionPreference.value).toBeNull()
    window.localStorage.setItem(REFRACTION_PREFERENCE_KEY, 'maybe')
    reloadRefractionPreference()
    expect(refractionPreference.value).toBeNull()
  })

  it('reads automatic when getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    reloadRefractionPreference()
    expect(refractionPreference.value).toBeNull()
  })

  it('keeps the in-memory choice when setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    setRefractionPreference(true)
    expect(refractionPreference.value).toBe('on')
  })

  it('ignores a non-boolean argument', () => {
    setRefractionPreference(true)
    setRefractionPreference('off' as unknown as boolean)
    setRefractionPreference(undefined as unknown as boolean)
    expect(refractionPreference.value).toBe('on')
  })
})
