import { describe, expect, it } from 'vitest'

import {
  BASE_LX_CSP_SOURCES,
  LX_CSP_BLOCKED,
  cspSourceAllows,
  cspSourcesAllow,
  isPublicHttpsTarget,
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
  it('matches public HTTPS targets (host, public IP, port) and blocks private/loopback/internal targets under https:', () => {
    expect(cspSourceAllows('https:', new URL('https://103.79.184.97:8443/x'))).toBe(true)
    expect(cspSourceAllows('https:', new URL('https://1.1.1.1:8443/a.mp3'))).toBe(true)
    expect(cspSourceAllows('https:', new URL('https://anything.example.org/x'))).toBe(true)
    expect(cspSourceAllows('https:', new URL('https://[2606:4700:4700::1111]/'))).toBe(true)
    expect(cspSourceAllows('https:', new URL('http://anything.example.org/x'))).toBe(false)
    expect(cspSourceAllows('https:', new URL('wss://anything.example.org/x'))).toBe(false)

    for (const blocked of [
      'https://127.0.0.1/api',
      'https://127.255.0.1/api',
      'https://10.0.0.1/api',
      'https://172.16.0.1/api',
      'https://172.31.255.254/api',
      'https://192.168.1.1/api',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.1/api',
      'https://0.0.0.0/api',
      'https://224.0.0.1/api',
      'https://255.255.255.255/api',
      'https://[::1]/api',
      'https://[::]/api',
      'https://[fc00::1]/api',
      'https://[fd12:3456::1]/api',
      'https://[fe80::1]/api',
      'https://[ff02::1]/api',
      'https://[::ffff:127.0.0.1]/api',
      'https://[::ffff:10.0.0.1]/api',
      'https://[::ffff:192.168.1.1]/api',
      'https://[::ffff:169.254.169.254]/api',
      'https://localhost/api',
      'https://sub.localhost/api',
      'https://localhost.localdomain/api',
      'https://intranet/api',
      'https://printer.local/api',
      'https://db.internal/api',
      'https://nas.lan/api',
      'https://git.corp/api',
      'https://router.home.arpa/api',
      'https://user:pass@example.com/api',
      'https://user:@example.com/api',
      'https://:pass@example.com/api',
      'https://[2002:7f00:0001::]/api',
      'https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/api',
      'https://[64:ff9b::127.0.0.1]/api',
      'https://[64:ff9b::169.254.169.254]/api',
      'https://[64:ff9b:1::10.0.0.1]/api',
      'https://[::ffff:0:127.0.0.1]/api',
      'https://[100::1]/api',
    ]) {
      expect(isPublicHttpsTarget(new URL(blocked)), blocked).toBe(false)
      expect(cspSourceAllows('https:', new URL(blocked)), blocked).toBe(false)
    }

    // Explicit selfOrigin is still allowed even if hosted on loopback/local, unless userinfo is embedded.
    expect(isPublicHttpsTarget(new URL('https://127.0.0.1:8443/api'), 'https://127.0.0.1:8443')).toBe(true)
    expect(cspSourceAllows('https:', new URL('https://127.0.0.1:8443/api'), 'https://127.0.0.1:8443')).toBe(true)
    expect(isPublicHttpsTarget(new URL('https://user:pass@127.0.0.1:8443/api'), 'https://127.0.0.1:8443')).toBe(false)
    expect(cspSourceAllows('https:', new URL('https://user:pass@127.0.0.1:8443/api'), 'https://127.0.0.1:8443')).toBe(false)
  })
  it.each([
    '192.0.2.1', '198.51.100.1', '203.0.113.1', '192.88.99.1',
    '[2001:db8::1]', '[3fff:fff::1]', '[::ffff:101:101]', '[::101:101]',
    '[2001:2::1]', '[4000::1]', 'home.arpa',
  ])('refuses special-use address or name %s as a scheme-source target', (hostname) => {
    const target = new URL(`https://${hostname}`)
    expect(isPublicHttpsTarget(target)).toBe(false)
    expect(cspSourcesAllow(['https:'], target)).toBe(false)
  })
  it('promotes reviewed public HTTPS-capable music CDN suffixes and refuses lookalikes/bare roots', () => {
    for (const [raw, expected] of [
      ['http://sycdn.kuwo.cn/resource/n1/123.mp3?sig=abc', 'https://sycdn.kuwo.cn/resource/n1/123.mp3?sig=abc'],
      ['http://fs.ios.kugou.com/2026/song.flac?k=1', 'https://fs.ios.kugou.com/2026/song.flac?k=1'],
      ['http://isure.stream.qqmusic.qq.com/M500.mp3?guid=1', 'https://isure.stream.qqmusic.qq.com/M500.mp3?guid=1'],
      ['http://aqqmusic.tc.qq.com/amobile.music.tc.qq.com/song.mp3?vkey=1', 'https://aqqmusic.tc.qq.com/amobile.music.tc.qq.com/song.mp3?vkey=1'],
      ['http://freetyst.nf.migu.cn/public/product.mp3?ms=1', 'https://freetyst.nf.migu.cn/public/product.mp3?ms=1'],
    ] as const) {
      expect(upgradeLxMediaUrlToHttps(raw), raw).toBe(expected)
    }

    for (const refused of [
      'http://kuwo.cn/a.mp3',
      'http://music.126.net/a.mp3',
      'http://kuwo.cn.attacker.example/a.mp3',
      'http://tc.qq.com.evil.example/a.mp3',
      'http://localhost/a.mp3',
      'http://192.168.1.1/a.mp3',
      'http://sycdn.kuwo.cn:8080/a.mp3',
      'http://user:pass@sycdn.kuwo.cn/a.mp3',
      'http://sycdn.kuwo.cn/a.mp3#frag',
    ]) {
      expect(upgradeLxMediaUrlToHttps(refused), refused).toBeNull()
    }
  })
  it('keeps the base policy narrow: it does not contain https:', () => {
    expect(BASE_LX_CSP_SOURCES.connect).not.toContain('https:')
    expect(BASE_LX_CSP_SOURCES.media).not.toContain('https:')
  })
})