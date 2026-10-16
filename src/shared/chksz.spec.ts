import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  CHKSZ_API_ORIGIN,
  CHKSZ_ARTWORK_PROXY_PATH,
  CHKSZ_ID_PATTERN,
  CHKSZ_KEY_PREFIX,
  CHKSZ_LEVEL,
  CHKSZ_MEDIA_HOST_SUFFIX,
  CHKSZ_MUSIC_ENDPOINT,
  CHKSZ_QUALITIES,
  chkszFailureCode,
  chkszLevel,
  createChkszArtworkProxyUrl,
  isChkszApiKey,
  isChkszExternalId,
  isChkszQuality,
  isPermittedMusicHostname,
  resolveChkszRedirect,
  validateChkszArtworkUrl,
  validateChkszMediaUrl,
  validateChkszMetadata,
  validateChkszPlaybackMetadata,
  validateChkszResolveBody,
} from './chksz'

const VALID_MEDIA_URL = 'https://m801.music.126.net/20260913/abc123/xyz.mp3'
const REQUESTED_ID = '3334421408'

const metadata = (overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}) => ({
  code: 200,
  data: {
    id: Number(REQUESTED_ID),
    level: 'standard',
    url: VALID_MEDIA_URL,
    ...dataOverrides,
  },
  ...overrides,
})

describe('ChKSz constants', () => {
  it('pins the documented API origin and endpoint', () => {
    expect(CHKSZ_API_ORIGIN).toBe('https://api.chksz.com')
    expect(CHKSZ_MUSIC_ENDPOINT).toBe('https://api.chksz.com/api/163_music')
  })

  it('pins the media host suffix, level and key prefix', () => {
    expect(CHKSZ_MEDIA_HOST_SUFFIX).toBe('.music.126.net')
    expect(CHKSZ_LEVEL).toBe('standard')
    expect(CHKSZ_KEY_PREFIX).toBe('chksz_')
  })

  it('defines the seven supported ChKSz quality levels in order', () => {
    expect(CHKSZ_QUALITIES).toEqual([
      'standard',
      'exhigh',
      'lossless',
      'hires',
      'jyeffect',
      'sky',
      'jymaster',
    ])
  })

  it('contains no environment or secret access', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/shared/chksz.ts'), 'utf8')
    expect(source).not.toMatch(/import\.meta\.env/)
    expect(source).not.toMatch(/process\.env/)
    expect(source).not.toMatch(/localStorage|sessionStorage/)
  })
})

describe('isChkszQuality and chkszLevel', () => {
  it('validates each supported quality and rejects unknown values', () => {
    for (const quality of CHKSZ_QUALITIES) {
      expect(isChkszQuality(quality)).toBe(true)
    }
    expect(isChkszQuality('high')).toBe(false)
    expect(isChkszQuality('128k')).toBe(false)
    expect(isChkszQuality('')).toBe(false)
    expect(isChkszQuality(null)).toBe(false)
  })

  it('maps each of the seven quality tiers to its exact API level string', () => {
    for (const quality of CHKSZ_QUALITIES) {
      expect(chkszLevel(quality)).toBe(quality)
    }
  })

  it('maps legacy high to exhigh', () => {
    expect(chkszLevel('high')).toBe('exhigh')
  })
})

describe('isChkszExternalId', () => {
  it('accepts numeric NetEase track ids up to 20 digits', () => {
    for (const value of ['1', '3334421408', '2100334024', '2155423468', '1'.repeat(20)]) {
      expect(isChkszExternalId(value)).toBe(true)
    }
  })

  it('rejects non-numeric, empty, overlong and non-string ids', () => {
    for (const value of ['', 'abc', '12a', '-1', '1.5', '1'.repeat(21), ' 1', '1 ', null, 42, undefined]) {
      expect(isChkszExternalId(value)).toBe(false)
    }
  })

  it('exposes a pattern consistent with the predicate', () => {
    expect(CHKSZ_ID_PATTERN.test('3334421408')).toBe(true)
    expect(CHKSZ_ID_PATTERN.test('3334421408x')).toBe(false)
  })
})

describe('isChkszApiKey', () => {
  it('accepts keys with the documented chksz_ prefix and a non-empty suffix', () => {
    expect(isChkszApiKey('chksz_abcDEF123-_.~')).toBe(true)
    expect(isChkszApiKey('chksz_1')).toBe(true)
  })

  it('rejects keys without the prefix or with an empty suffix', () => {
    for (const value of ['chksz_', 'abc', 'CHKSZ_abc', 'chksz', ' chksz_abc', 'chksz_abc ']) {
      expect(isChkszApiKey(value)).toBe(false)
    }
  })

  it('rejects empty, overlong, control-character and non-latin1 keys', () => {
    expect(isChkszApiKey('')).toBe(false)
    expect(isChkszApiKey(`chksz_${'a'.repeat(507)}`)).toBe(false)
    expect(isChkszApiKey(`chksz_${'a'.repeat(506)}`)).toBe(true)
    expect(isChkszApiKey('chksz_ab\ncd')).toBe(false)
    expect(isChkszApiKey('chksz_ab\u007fcd')).toBe(false)
    expect(isChkszApiKey('chksz_\u20ac')).toBe(false)
    expect(isChkszApiKey(null)).toBe(false)
    expect(isChkszApiKey(42)).toBe(false)
  })
})

describe('isPermittedMusicHostname', () => {
  it('accepts lowercase DNS hosts under the music.126.net suffix', () => {
    for (const host of ['m801.music.126.net', 'm1.music.126.net', 'a-b.music.126.net']) {
      expect(isPermittedMusicHostname(host)).toBe(true)
    }
  })

  it('rejects the bare suffix, empty subdomain and unrelated suffixes', () => {
    for (const host of [
      'music.126.net',
      '.music.126.net',
      'm801.music.126.net.evil.example',
      'evil-music.126.net',
      'm801.music.126.net.',
      '',
    ]) {
      expect(isPermittedMusicHostname(host)).toBe(false)
    }
  })

  it('rejects uppercase, punycode, empty labels and non-DNS characters', () => {
    for (const host of [
      'M801.MUSIC.126.NET',
      'm801.Music.126.net',
      'xn--m801.music.126.net',
      'm801..music.126.net',
      'm801_music.126.net',
      '-m801.music.126.net',
      'm801-.music.126.net',
      'm801.music.126.net:443',
    ]) {
      expect(isPermittedMusicHostname(host)).toBe(false)
    }
  })
})

describe('validateChkszMediaUrl', () => {
  it('accepts a well-formed HTTPS media URL on a permitted host', () => {
    const url = validateChkszMediaUrl(VALID_MEDIA_URL)
    expect(url).toBeInstanceOf(URL)
    expect(url?.hostname).toBe('m801.music.126.net')
  })

  it('rejects non-HTTPS schemes', () => {
    expect(validateChkszMediaUrl('http://m801.music.126.net/x.mp3')).toBeNull()
    expect(validateChkszMediaUrl('ftp://m801.music.126.net/x.mp3')).toBeNull()
    expect(validateChkszMediaUrl('//m801.music.126.net/x.mp3')).toBeNull()
  })

  it('rejects credentials, explicit ports, fragments and empty values', () => {
    expect(validateChkszMediaUrl('https://user:pass@m801.music.126.net/x.mp3')).toBeNull()
    expect(validateChkszMediaUrl('https://user@m801.music.126.net/x.mp3')).toBeNull()
    expect(validateChkszMediaUrl('https://m801.music.126.net:8443/x.mp3')).toBeNull()
    expect(validateChkszMediaUrl('https://m801.music.126.net/x.mp3#frag')).toBeNull()
    expect(validateChkszMediaUrl('')).toBeNull()
  })

  it('rejects malicious suffixes, uppercase hosts and punycode hosts', () => {
    expect(validateChkszMediaUrl('https://m801.music.126.net.evil.example/x.mp3')).toBeNull()
    expect(validateChkszMediaUrl('https://music.126.net/x.mp3')).toBeNull()
    expect(validateChkszMediaUrl('https://M801.MUSIC.126.NET/x.mp3')).toBeNull()
    expect(validateChkszMediaUrl('https://xn--m801.music.126.net/x.mp3')).toBeNull()
  })

  it('rejects malformed values, control characters and non-strings', () => {
    expect(validateChkszMediaUrl('not a url')).toBeNull()
    expect(validateChkszMediaUrl('https://m801.music.126.net/a b.mp3')).toBeNull()
    expect(validateChkszMediaUrl('https://m801.music.126.net\\x.mp3')).toBeNull()
    expect(validateChkszMediaUrl(null)).toBeNull()
    expect(validateChkszMediaUrl(123)).toBeNull()
    expect(validateChkszMediaUrl({})).toBeNull()
  })
})

describe('resolveChkszRedirect', () => {
  const current = new URL(VALID_MEDIA_URL)

  it('accepts absolute and protocol-relative permitted locations', () => {
    expect(resolveChkszRedirect(VALID_MEDIA_URL, current)?.hostname).toBe('m801.music.126.net')
    expect(resolveChkszRedirect('//m802.music.126.net/y.mp3', current)?.hostname)
      .toBe('m802.music.126.net')
    expect(resolveChkszRedirect('/z.mp3', current)?.hostname).toBe('m801.music.126.net')
  })

  it('rejects off-policy redirect targets', () => {
    expect(resolveChkszRedirect('https://evil.example/x.mp3', current)).toBeNull()
    expect(resolveChkszRedirect('http://m801.music.126.net/x.mp3', current)).toBeNull()
    expect(resolveChkszRedirect('//m801.music.126.net.evil.example/x.mp3', current)).toBeNull()
    expect(resolveChkszRedirect('//user@m801.music.126.net/x.mp3', current)).toBeNull()
    expect(resolveChkszRedirect('https://m801.music.126.net:8443/x.mp3', current)).toBeNull()
    expect(resolveChkszRedirect('', current)).toBeNull()
  })
})

describe('chkszFailureCode', () => {
  it.each([
    [400, 'invalid_response'],
    [401, 'invalid_credential'],
    [402, 'quota_exhausted'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [504, 'unavailable'],
  ])('maps HTTP %i to %s', (status, expected) => {
    expect(chkszFailureCode(status)).toBe(expected)
  })

  it('returns null for 200 so success is never a failure code', () => {
    expect(chkszFailureCode(200)).toBeNull()
  })

  it('never collapses 402, 403 or 404 into unavailable', () => {
    expect(chkszFailureCode(402)).toBe('quota_exhausted')
    expect(chkszFailureCode(403)).toBe('forbidden')
    expect(chkszFailureCode(404)).toBe('not_found')
  })

  it('treats an unexpected 4xx as a request failure rather than an outage', () => {
    for (const status of [405, 409, 418, 451]) {
      expect(chkszFailureCode(status)).toBe('invalid_response')
    }
  })
})

describe('validateChkszMetadata', () => {
  it('accepts the documented HTTP-200 body contract', () => {
    const url = validateChkszMetadata(metadata(), REQUESTED_ID, CHKSZ_LEVEL)
    expect(url).toBeInstanceOf(URL)
    expect(url?.toString()).toBe(VALID_MEDIA_URL)
  })

  it('ignores unrelated extra metadata safely', () => {
    const url = validateChkszMetadata(
      metadata({ extra: 'ignored' }, { album: 'x', duration: 12345, fee: 0 }),
      REQUESTED_ID,
      CHKSZ_LEVEL,
    )
    expect(url).toBeInstanceOf(URL)
  })

  it('rejects a mismatched returned id', () => {
    expect(validateChkszMetadata(metadata({}, { id: 999 }), REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
  })

  it('rejects a returned level that does not match the requested standard level', () => {
    for (const level of ['lossless', 'hires', 'exhigh', 'jymaster', 'standard ']) {
      expect(validateChkszMetadata(metadata({}, { level }), REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
    }
  })

  it('accepts all seven ChKSz quality levels when matching requested level', () => {
    for (const level of CHKSZ_QUALITIES) {
      const url = validateChkszMetadata(metadata({}, { level }), REQUESTED_ID, level)
      expect(url).toBeInstanceOf(URL)
      expect(url?.toString()).toBe(VALID_MEDIA_URL)
    }
  })

  it('rejects mismatched returned levels for any tier', () => {
    expect(validateChkszMetadata(metadata({}, { level: 'exhigh' }), REQUESTED_ID, 'standard')).toBeNull()
    expect(validateChkszMetadata(metadata({}, { level: 'standard' }), REQUESTED_ID, 'exhigh')).toBeNull()
    expect(validateChkszMetadata(metadata({}, { level: 'jymaster' }), REQUESTED_ID, 'sky')).toBeNull()
  })

  it('rejects a non-200 code or a missing data object', () => {
    expect(validateChkszMetadata(metadata({ code: 404 }), REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
    expect(validateChkszMetadata({ code: 200 }, REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
    expect(validateChkszMetadata({ code: 200, data: null }, REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
  })

  it('rejects an off-policy media URL inside otherwise valid metadata', () => {
    for (const url of [
      'http://m801.music.126.net/x.mp3',
      'https://music.126.net/x.mp3',
      'https://m801.music.126.net.evil.example/x.mp3',
      'https://user:pass@m801.music.126.net/x.mp3',
      'https://m801.music.126.net:8443/x.mp3',
      'https://xn--m801.music.126.net/x.mp3',
    ]) {
      expect(validateChkszMetadata(metadata({}, { url }), REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
    }
  })

  it('rejects a non-string url, a non-integer id and non-object bodies', () => {
    expect(validateChkszMetadata(metadata({}, { url: 123 }), REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
    expect(validateChkszMetadata(metadata({}, { id: '3334421408' }), REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
    expect(validateChkszMetadata(null, REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
    expect(validateChkszMetadata('x', REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
    expect(validateChkszMetadata([], REQUESTED_ID, CHKSZ_LEVEL)).toBeNull()
  })
})

// The owner-fallback resolve body is the one place the browser tells the Worker which ChKSz tier
// to spend the Owner credential on. Both the browser provider and the Worker import this function,
// so these tests define the contract for both ends at once.
describe('validateChkszResolveBody', () => {
  it('accepts the exact two-key body for every ChKSz level', () => {
    for (const level of CHKSZ_QUALITIES) {
      expect(validateChkszResolveBody({ externalId: REQUESTED_ID, level })).toEqual({
        externalId: REQUESTED_ID,
        level,
      })
    }
  })

  it('defaults an omitted level to standard for older clients', () => {
    expect(validateChkszResolveBody({ externalId: REQUESTED_ID })).toEqual({
      externalId: REQUESTED_ID,
      level: 'standard',
    })
  })

  it('rejects any key outside externalId and level', () => {
    for (const extra of [
      { url: 'https://attacker.example/x.mp3' },
      { apikey: 'attacker' },
      { apiKey: 'attacker' },
      { level2: 'sky' },
      { unexpected: true },
      { foo: 'bar' },
    ]) {
      expect(validateChkszResolveBody({ externalId: REQUESTED_ID, level: 'lossless', ...extra }))
        .toBeNull()
    }
  })

  it('rejects an invalid supplied level instead of downgrading it', () => {
    for (const level of ['high', 'ultra', 'master', 'flac', '320k', '128k', '', 'STANDARD', 'sky ']) {
      expect(validateChkszResolveBody({ externalId: REQUESTED_ID, level })).toBeNull()
    }
  })

  it('rejects a supplied level that is not a string', () => {
    for (const level of [null, 320, true, ['sky'], { level: 'sky' }]) {
      expect(validateChkszResolveBody({ externalId: REQUESTED_ID, level })).toBeNull()
    }
  })

  it('preserves the externalId pattern and type rules', () => {
    expect(validateChkszResolveBody({ externalId: 3334421408, level: 'sky' })).toBeNull()
    expect(validateChkszResolveBody({ externalId: '3334421408a', level: 'sky' })).toBeNull()
    expect(validateChkszResolveBody({ externalId: '1'.repeat(21), level: 'sky' })).toBeNull()
    expect(validateChkszResolveBody({ externalId: '', level: 'sky' })).toBeNull()
    expect(validateChkszResolveBody({ level: 'sky' })).toBeNull()
    expect(validateChkszResolveBody({ externalId: '3334421408', level: 'sky' }, /^abc$/)).toBeNull()
  })

  it('rejects non-object bodies', () => {
    for (const value of [null, undefined, 'sky', 42, [], true]) {
      expect(validateChkszResolveBody(value)).toBeNull()
    }
  })

  it('returns a fresh object rather than the caller body', () => {
    const input = { externalId: REQUESTED_ID, level: 'sky' }
    const result = validateChkszResolveBody(input)
    expect(result).not.toBe(input)
    expect(result).toEqual(input)
  })
})

describe('validateChkszArtworkUrl', () => {
  it('accepts HTTPS URLs on permitted music hostnames', () => {
    const valid = 'https://p1.music.126.net/abc123/cover.jpg'
    expect(validateChkszArtworkUrl(valid)?.toString()).toBe(valid)
    const valid2 = 'https://p2.music.126.net/xyz/image.png'
    expect(validateChkszArtworkUrl(valid2)?.toString()).toBe(valid2)
  })

  it('rejects non-HTTPS URLs', () => {
    expect(validateChkszArtworkUrl('http://p1.music.126.net/cover.jpg')).toBeNull()
    expect(validateChkszArtworkUrl('ftp://p1.music.126.net/cover.jpg')).toBeNull()
    expect(validateChkszArtworkUrl('javascript:alert(1)')).toBeNull()
  })

  it('rejects foreign hostnames and internal IP addresses', () => {
    expect(validateChkszArtworkUrl('https://attacker.example/cover.jpg')).toBeNull()
    expect(validateChkszArtworkUrl('https://127.0.0.1/cover.jpg')).toBeNull()
    expect(validateChkszArtworkUrl('https://music.126.net.attacker.example/cover.jpg')).toBeNull()
    expect(validateChkszArtworkUrl('https://music.126.net/cover.jpg')).toBeNull() // must have subdomain
  })

  it('rejects URLs containing credentials, ports, or hash', () => {
    expect(validateChkszArtworkUrl('https://user:pass@p1.music.126.net/cover.jpg')).toBeNull()
    expect(validateChkszArtworkUrl('https://p1.music.126.net:8443/cover.jpg')).toBeNull()
    expect(validateChkszArtworkUrl('https://p1.music.126.net/cover.jpg#hash')).toBeNull()
  })

  it('rejects URLs leaking API keys', () => {
    expect(validateChkszArtworkUrl('https://p1.music.126.net/cover.jpg?apikey=secret')).toBeNull()
    expect(validateChkszArtworkUrl('https://p1.music.126.net/cover.jpg?api_key=secret')).toBeNull()
  })

  it('rejects non-string or malformed inputs', () => {
    expect(validateChkszArtworkUrl(null)).toBeNull()
    expect(validateChkszArtworkUrl(undefined)).toBeNull()
    expect(validateChkszArtworkUrl(123)).toBeNull()
    expect(validateChkszArtworkUrl('')).toBeNull()
    expect(validateChkszArtworkUrl('   ')).toBeNull()
    expect(validateChkszArtworkUrl('https://p1.music.126.net/foo bar')).toBeNull()
  })
})

describe('validateChkszPlaybackMetadata', () => {
  it('extracts media URL, level, bitrate and artwork when present', () => {
    const payload = metadata({}, {
      br: 320000,
      level: 'exhigh',
      picUrl: 'https://p1.music.126.net/cover.jpg',
    })
    const result = validateChkszPlaybackMetadata(payload, REQUESTED_ID, 'exhigh')
    expect(result).toEqual({
      mediaUrl: new URL(VALID_MEDIA_URL),
      level: 'exhigh',
      bitrate: 320000,
      artworkUrl: 'https://p1.music.126.net/cover.jpg',
    })
  })

  it('handles absent optional artwork and bitrate gracefully', () => {
    const payload = metadata({}, { level: 'standard' })
    const result = validateChkszPlaybackMetadata(payload, REQUESTED_ID, 'standard')
    expect(result).toEqual({
      mediaUrl: new URL(VALID_MEDIA_URL),
      level: 'standard',
    })
    expect(result?.bitrate).toBeUndefined()
    expect(result?.artworkUrl).toBeUndefined()
  })

  it('rejects unsafe artwork URLs while keeping valid playback or returns null on malformed metadata', () => {
    const payloadWithBadArtwork = metadata({}, {
      level: 'lossless',
      picUrl: 'https://attacker.com/evil.jpg',
    })
    const result = validateChkszPlaybackMetadata(payloadWithBadArtwork, REQUESTED_ID, 'lossless')
    expect(result?.mediaUrl.toString()).toBe(VALID_MEDIA_URL)
    expect(result?.artworkUrl).toBeUndefined()
  })

  it('rejects mismatched requested level', () => {
    const payload = metadata({}, { level: 'exhigh' })
    expect(validateChkszPlaybackMetadata(payload, REQUESTED_ID, 'standard')).toBeNull()
  })
})

describe('createChkszArtworkProxyUrl', () => {
  it('constructs a safe same-origin proxy URL from a valid NetEase artwork URL string', () => {
    const upstream = 'https://p1.music.126.net/fixture-cover.jpg'
    const proxyUrl = createChkszArtworkProxyUrl(upstream)
    expect(proxyUrl).toBe(`${CHKSZ_ARTWORK_PROXY_PATH}?url=https%3A%2F%2Fp1.music.126.net%2Ffixture-cover.jpg`)
  })

  it('constructs a safe same-origin proxy URL from a URL object', () => {
    const upstream = new URL('https://p2.music.126.net/foo/bar.png')
    const proxyUrl = createChkszArtworkProxyUrl(upstream)
    expect(proxyUrl).toBe(`${CHKSZ_ARTWORK_PROXY_PATH}?url=https%3A%2F%2Fp2.music.126.net%2Ffoo%2Fbar.png`)
  })

  it('preserves query parameters on the upstream URL if safe', () => {
    const upstream = 'https://p1.music.126.net/cover.jpg?param=300y300'
    const proxyUrl = createChkszArtworkProxyUrl(upstream)
    expect(proxyUrl).toBe(`${CHKSZ_ARTWORK_PROXY_PATH}?url=https%3A%2F%2Fp1.music.126.net%2Fcover.jpg%3Fparam%3D300y300`)
  })

  it('rejects upstream URLs containing API keys or credentials', () => {
    expect(createChkszArtworkProxyUrl('https://p1.music.126.net/cover.jpg?apikey=secret')).toBeNull()
    expect(createChkszArtworkProxyUrl('https://p1.music.126.net/cover.jpg?api_key=secret')).toBeNull()
    expect(createChkszArtworkProxyUrl('https://user:pass@p1.music.126.net/cover.jpg')).toBeNull()
  })

  it('rejects non-music domains, IP addresses, and insecure schemes', () => {
    expect(createChkszArtworkProxyUrl('https://attacker.com/evil.jpg')).toBeNull()
    expect(createChkszArtworkProxyUrl('http://p1.music.126.net/cover.jpg')).toBeNull()
    expect(createChkszArtworkProxyUrl('http://169.254.169.254/latest/meta-data')).toBeNull()
    expect(createChkszArtworkProxyUrl('javascript:alert(1)')).toBeNull()
  })

  it('returns null for empty or invalid inputs', () => {
    expect(createChkszArtworkProxyUrl('')).toBeNull()
    expect(createChkszArtworkProxyUrl('not a url')).toBeNull()
  })
})
