import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptAgreement, AGREEMENT_STORAGE_KEY, allowsConfiguredSources, hasCurrentAgreement, THIRD_PARTY_AGREEMENT_VERSION, withdrawAgreement } from './thirdPartyAgreement'
beforeEach(() => localStorage.clear())
describe('versioned source consent', () => {
  it('keeps existing configuration available while new activation still requires explicit acceptance', () => {
    expect(allowsConfiguredSources()).toBe(true)
    expect(hasCurrentAgreement()).toBe(false)
  })
  it('permits accepted current version and blocks withdrawal or stale versions', () => {
    acceptAgreement()
    expect(hasCurrentAgreement()).toBe(true)
    expect(localStorage.getItem(AGREEMENT_STORAGE_KEY)).toBe(THIRD_PARTY_AGREEMENT_VERSION)
    localStorage.setItem(AGREEMENT_STORAGE_KEY, '0.9')
    expect(allowsConfiguredSources()).toBe(false)
    withdrawAgreement()
    expect(allowsConfiguredSources()).toBe(false)
  })
  it('keeps a memory refusal when persistence fails and fails closed on unreadable receipts', () => {
    acceptAgreement()
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable') })
    expect(() => withdrawAgreement()).toThrow()
    expect(allowsConfiguredSources()).toBe(false)
    write.mockRestore()
    acceptAgreement()
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable') })
    expect(allowsConfiguredSources()).toBe(false)
    read.mockRestore()
  })
})
