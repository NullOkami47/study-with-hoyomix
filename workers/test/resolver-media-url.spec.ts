import { describe, expect, it } from 'vitest'

import { createResolverMediaUrlValidator } from '../providers/resolverMediaUrl'

describe('resolver media URL policy', () => {
  const validate = createResolverMediaUrlValidator({
    configuredOrigin: 'https://resolver.example.invalid',
    extraAllowedHostnames: ['proxy.example.invalid'],
  })

  it.each([
    'https://resolver.example.invalid/videoplayback?token=temporary',
    'https://proxy.example.invalid/audio?token=temporary',
    'https://rr1---sn-example.googlevideo.com/videoplayback?token=temporary',
  ])('accepts an allowlisted public HTTPS media URL without exposing its query: %s', (value) => {
    expect(validate(value)?.toString()).toBe(value)
  })

  it.each([
    'http://resolver.example.invalid/audio',
    'https://user:password@resolver.example.invalid/audio',
    'https://resolver.example.invalid:8443/audio',
    'https://resolver.example.invalid:443/audio',
    'https://127.0.0.1/audio',
    'https://[::1]/audio',
    'https://media.internal/audio',
    'https://attacker.example/audio',
    'https://googlevideo.com.attacker.example/audio',
    'https://resolver.example.invalid/audio#fragment',
    'https:\\resolver.example.invalid\\audio',
    'https://resolver%2Eexample.invalid/audio',
  ])('rejects an unsafe or unallowlisted initial media URL: %s', (value) => {
    expect(validate(value)).toBeNull()
  })

  it('allows a relative redirect only when its resolved target remains permitted', () => {
    const current = new URL('https://proxy.example.invalid/start?token=temporary')

    expect(validate('/next?token=rotated', current)?.toString()).toBe(
      'https://proxy.example.invalid/next?token=rotated',
    )
    expect(validate('//attacker.example/next', current)).toBeNull()
    expect(validate('https://user@proxy.example.invalid/next', current)).toBeNull()
  })
})
