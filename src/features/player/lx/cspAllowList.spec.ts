import { describe, expect, it } from 'vitest'
import { BASE_LX_CSP_SOURCES } from '../../../shared/lxCspPolicy'
import { isLxTargetAllowed } from './cspAllowList'

// Owner decision: with LX_ALLOWED_ORIGINS=https: the build emits https: in connect-src and media-src,
// and the client check (which fails early with csp_blocked) must agree with that policy.
describe('client LX CSP check with the https: scheme-source', () => {
  const open = { connect: [...BASE_LX_CSP_SOURCES.connect, 'https:'], media: [...BASE_LX_CSP_SOURCES.media, 'https:'] }
  const target = new URL('https://never-listed.lx-fixture.example/api/url?id=1')
  it('allows a previously non-listed HTTPS origin in both kinds', () => {
    expect(isLxTargetAllowed('connect', target, open, 'https://study.example')).toBe(true)
    expect(isLxTargetAllowed('media', new URL('https://1.1.1.1:8443/a.mp3'), open, 'https://study.example')).toBe(true)
  })
  it('applies public HTTPS policy to the whole list, in either source order', () => {
    const local = new URL('https://library.internal')
    const self = new URL('https://library.internal')
    self.username = 'fixture'
    for (const kind of ['connect', 'media'] as const) {
      for (const list of [[local.origin, "'self'", 'https:'], ['https:', "'self'", local.origin]]) {
        const policy = { connect: list, media: list }
        expect(isLxTargetAllowed(kind, local, policy, 'https://study.example')).toBe(false)
        expect(isLxTargetAllowed(kind, self, policy, self.origin)).toBe(false)
        expect(isLxTargetAllowed(kind, local, policy, local.origin)).toBe(true)
      }
      const narrow = { connect: [local.origin], media: [local.origin] }
      expect(isLxTargetAllowed(kind, local, narrow, 'https://study.example')).toBe(true)
    }
  })
  it('still blocks it without the scheme-source (control group) and never allows http:', () => {
    expect(isLxTargetAllowed('connect', target, BASE_LX_CSP_SOURCES, 'https://study.example')).toBe(false)
    expect(isLxTargetAllowed('media', new URL('http://never-listed.lx-fixture.example/a.mp3'), open, 'https://study.example')).toBe(false)
  })
})
