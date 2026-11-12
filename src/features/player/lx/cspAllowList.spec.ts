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
    expect(isLxTargetAllowed('media', new URL('https://203.0.113.9:8443/a.mp3'), open, 'https://study.example')).toBe(true)
  })
  it('still blocks it without the scheme-source (control group) and never allows http:', () => {
    expect(isLxTargetAllowed('connect', target, BASE_LX_CSP_SOURCES, 'https://study.example')).toBe(false)
    expect(isLxTargetAllowed('media', new URL('http://never-listed.lx-fixture.example/a.mp3'), open, 'https://study.example')).toBe(false)
  })
})
