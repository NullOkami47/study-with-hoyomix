import { describe, expect, it } from 'vitest'

import { automaticProviderEligible, cloudflareCountry } from '../providers/routing'
import type { ProviderState } from '../providers/config'

const providerState = (id: 'chksz' | 'vkeys', overrides: Partial<ProviderState> = {}): ProviderState => ({
  id,
  adminEnabled: true,
  deploymentAvailable: true,
  effectiveEnabled: true,
  priority: id === 'vkeys' ? 50 : 10,
  status: 'unknown',
  failureClass: null,
  latencyMs: null,
  checkedAt: null,
  updatedAt: 0,
  automaticPolicy: 'direct',
  ...overrides,
})

describe('ephemeral provider automatic eligibility', () => {
  describe.each(['chksz', 'vkeys'] as const)('%s', (id) => {
    it('allows an effective provider automatically globally', () => {
      const state = providerState(id)
      for (const country of ['CN', 'HK', 'US', undefined]) {
        expect(automaticProviderEligible(state, country)).toBe(true)
      }
    })

    it.each([
      ['Admin-disabled', { adminEnabled: false, effectiveEnabled: false }],
      ['deployment-unavailable', { deploymentAvailable: false, effectiveEnabled: false }],
    ])('does not re-enable or reprioritise an %s provider', (_case, overrides) => {
      const state = providerState(id, overrides)
      const before = { ...state }
      for (const country of ['CN', 'HK', 'US', undefined]) {
        expect(automaticProviderEligible(state, country)).toBe(false)
      }
      expect(state).toEqual(before)
    })

    it('never makes a manual-only provider automatic', () => {
      for (const country of ['CN', 'HK', 'US', undefined]) {
        expect(automaticProviderEligible(providerState(id, { automaticPolicy: 'never' }), country))
          .toBe(false)
      }
    })
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
