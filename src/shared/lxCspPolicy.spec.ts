import { describe, expect, it } from 'vitest'

import {
  BASE_LX_CSP_SOURCES,
  LX_CSP_BLOCKED,
  cspSourceAllows,
  cspSourcesAllow,
  parseLxAllowedOrigin,
  parseLxAllowedOrigins,
} from './lxCspPolicy'
import { upgradeLxMediaUrlToHttps } from './lxCspPolicy'

describe('LX CSP policy', () => {
  it('keeps the base policy at the narrowest setting', () => {
    expect(BASE_LX_CSP_SOURCES.connect).toEqual(["'self'", 'https://api.chksz.com'])
    expect(BASE_LX_CSP_SOURCES.media).toEqual(["'self'", 'https://*.music.126.net'])
  })

  it('accepts only exact HTTPS origins with at least two labels', () => {
    expect(parseLxAllowedOrigin('https://api.example.com')).toBe('https://api.example.com')
    expect(parseLxAllowedOrigin('https://*.example.com')).toBe('https://*.example.com')
    expect(parseLxAllowedOrigin('*')).toBeNull()
    expect(parseLxAllowedOrigin('https://')).toBeNull()
    expect(parseLxAllowedOrigin('https://example.com/path')).toBeNull()
    expect(parseLxAllowedOrigin('https://example.com:8443')).toBeNull()
    expect(parseLxAllowedOrigin('https://user:pass@example.com')).toBeNull()
    expect(parseLxAllowedOrigin('http://example.com')).toBeNull()
    expect(parseLxAllowedOrigin('https://127.0.0.1')).toBeNull()
    expect(parseLxAllowedOrigin('https://localhost')).toBeNull()
  })

  it('collapses duplicates and reports the position of the first invalid entry', () => {
    expect(parseLxAllowedOrigins('https://a.example.com, https://a.example.com')).toEqual(['https://a.example.com'])
    expect(() => parseLxAllowedOrigins('https://a.example.com, nope')).toThrow(/entry 2/u)
  })

  it('matches CSP source expressions the way the browser does', () => {
    const target = new URL('https://m801.music.126.net/a.mp3')
    expect(cspSourceAllows('https://*.music.126.net', target)).toBe(true)
    expect(cspSourceAllows('https://music.126.net', target)).toBe(false)
    expect(cspSourceAllows("'self'", target)).toBe(false)
    expect(cspSourceAllows("'self'", target, 'https://app.example.com')).toBe(false)
    expect(cspSourcesAllow(['https://*.music.126.net'], target)).toBe(true)
  })

  it('exposes a stable refusal prefix', () => {
    expect(LX_CSP_BLOCKED).toBe('csp_blocked')
  })

  it('does not mistake an IP host source for browser permission to contact HYW', () => {
    const target = new URL('https://103.79.184.97/api/music/url')
    expect(parseLxAllowedOrigin(target.origin)).toBeNull()
    expect(cspSourcesAllow([target.origin], target)).toBe(false)
    expect(cspSourceAllows('https://[2001:db8::1]', new URL('https://[2001:db8::1]/'))).toBe(false)
    // CSP self-origin matching is separate from explicit host-source matching.
    expect(cspSourceAllows("'self'", target, target.origin)).toBe(true)
    expect(cspSourceAllows('https://127.0.0.1', new URL('https://127.0.0.1/'))).toBe(true)
  })
})

describe('LX media HTTPS promotion', () => {
  it('promotes a plaintext URL on a trusted media host and keeps the signed path intact', () => {
    const out = upgradeLxMediaUrlToHttps('http://m801.music.126.net/2026/signed/song.mp3?authSecret=abc&x=1')
    expect(out).toBe('https://m801.music.126.net/2026/signed/song.mp3?authSecret=abc&x=1')
  })

  it('refuses to promote a host outside the trusted family', () => {
    expect(upgradeLxMediaUrlToHttps('http://music.126.net.attacker.example/a.mp3')).toBeNull()
    expect(upgradeLxMediaUrlToHttps('http://m801.music.126.net.evil.example/a.mp3')).toBeNull()
    expect(upgradeLxMediaUrlToHttps('http://example.com/a.mp3')).toBeNull()
    expect(upgradeLxMediaUrlToHttps('http://127.0.0.1/a.mp3')).toBeNull()
    expect(upgradeLxMediaUrlToHttps('http://[::1]/a.mp3')).toBeNull()
  })

  it('refuses to promote anything that is not plaintext HTTP', () => {
    expect(upgradeLxMediaUrlToHttps('https://m801.music.126.net/a.mp3')).toBeNull()
    expect(upgradeLxMediaUrlToHttps('data:audio/mpeg;base64,AAAA')).toBeNull()
    expect(upgradeLxMediaUrlToHttps('file:///etc/passwd')).toBeNull()
    expect(upgradeLxMediaUrlToHttps('javascript:alert(1)')).toBeNull()
    expect(upgradeLxMediaUrlToHttps('not a url')).toBeNull()
    expect(upgradeLxMediaUrlToHttps(undefined)).toBeNull()
  })

  it('refuses credentials, an explicit port and a fragment', () => {
    expect(upgradeLxMediaUrlToHttps('http://user:pass@m801.music.126.net/a.mp3')).toBeNull()
    expect(upgradeLxMediaUrlToHttps('http://m801.music.126.net:8080/a.mp3')).toBeNull()
    expect(upgradeLxMediaUrlToHttps('http://m801.music.126.net/a.mp3#frag')).toBeNull()
  })

  it('promotes a punycode host out of the trusted family', () => {
    expect(upgradeLxMediaUrlToHttps('http://xn--e1afmkfd.xn--fiqs8s/a.mp3')).toBeNull()
  })
})

describe('LX CSP policy: allow-all scheme-source (Owner decision)', () => {
  it('accepts exactly https: as the one reserved wildcard entry, canonicalised', () => {
    expect(parseLxAllowedOrigin('https:')).toBe('https:')
    expect(parseLxAllowedOrigin('HTTPS:')).toBe('https:')
    expect(parseLxAllowedOrigins('https://a.example.com, https:, HTTPS:')).toEqual(['https://a.example.com', 'https:'])
    for (const entry of ['*', 'https://*', 'https://*.com', 'http:', 'wss:', 'ws:', 'https:/', 'https:443', 'https: x']) {
      expect(parseLxAllowedOrigin(entry), entry).toBeNull()
    }
  })
  it('matches any HTTPS target (host, IP literal, port) and no other scheme', () => {
    expect(cspSourceAllows('https:', new URL('https://103.79.184.97:8443/x'))).toBe(true)
    expect(cspSourceAllows('https:', new URL('https://anything.example.org/x'))).toBe(true)
    expect(cspSourceAllows('https:', new URL('https://[2001:db8::1]/'))).toBe(true)
    expect(cspSourceAllows('https:', new URL('http://anything.example.org/x'))).toBe(false)
    expect(cspSourceAllows('https:', new URL('wss://anything.example.org/x'))).toBe(false)
  })
  it('keeps the base policy narrow: it does not contain https:', () => {
    expect(BASE_LX_CSP_SOURCES.connect).not.toContain('https:')
    expect(BASE_LX_CSP_SOURCES.media).not.toContain('https:')
  })
})