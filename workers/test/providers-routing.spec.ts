import { describe, expect, it } from 'vitest'

import { automaticProviderEligible, cloudflareCountry } from '../providers/routing'
import type { ProviderState } from '../providers/config'

const chksz = (overrides: Partial<ProviderState> = {}): ProviderState => ({
  id: 'chksz',
  adminEnabled: true,
  deploymentAvailable: true,
  effectiveEnabled: true,
  priority: 20,
  status: 'unknown',
  failureClass: null,
  latencyMs: null,
  checkedAt: null,
  updatedAt: 0,
  automaticPolicy: 'direct',
  ...overrides,
})

describe('ephemeral provider automatic eligibility', () => {
  it('allows effective ChKSz automatically globally', () => {
    const state = chksz()

    expect(automaticProviderEligible(state, 'CN')).toBe(true)
    expect(automaticProviderEligible(state, 'HK')).toBe(true)
    expect(automaticProviderEligible(state, 'US')).toBe(true)
    expect(automaticProviderEligible(state, undefined)).toBe(true)
  })

  it.each([
    ['Admin-disabled', { adminEnabled: false, effectiveEnabled: false }],
    ['deployment-unavailable', { deploymentAvailable: false, effectiveEnabled: false }],
  ])('does not re-enable or reprioritise %s ChKSz', (_case, overrides) => {
    expect(automaticProviderEligible(chksz(overrides), 'CN')).toBe(false)
    expect(automaticProviderEligible(chksz(overrides), 'HK')).toBe(false)
  })

  it('never makes a manual-only provider automatic', () => {
    expect(automaticProviderEligible({ ...chksz(), automaticPolicy: 'never' }, 'CN')).toBe(false)
    expect(automaticProviderEligible({ ...chksz(), automaticPolicy: 'never' }, undefined)).toBe(false)
  })

  it('reads only the Worker request cf.country property', () => {
    const request = new Request('https://study.example/api/providers/config', {
      headers: {
        'cf-ipcountry': 'CN',
        country: 'CN',
        'x-country': 'CN',
      },
    })
    Object.defineProperty(request, 'cf', { value: { country: 'CN' } })

    expect(cloudflareCountry(request)).toBe('CN')
  })

  it('does not trust spoofable country headers when cf metadata is missing', () => {
    const request = new Request('https://study.example/api/providers/config?country=CN', {
      headers: { 'cf-ipcountry': 'CN', country: 'CN', 'x-country': 'CN' },
    })

    expect(cloudflareCountry(request)).toBeUndefined()
  })
})
