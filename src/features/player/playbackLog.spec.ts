import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LEGACY_PLAYBACK_LOG_SESSION_KEY,
  PLAYBACK_LOG_FORMAT,
  PLAYBACK_LOG_SESSION_KEY,
  createPlaybackLog,
  describeMediaElement,
  installPlaybackLogLifecycle,
  playbackLogFileName,
  redactMediaUrl,
  sanitizeLogString,
} from './playbackLog'

const environment = {
  build: { commit: 'abc1234' },
  userAgent: 'test-agent',
  displayMode: 'standalone' as const,
  visibilityState: 'hidden',
}

/**
 * A base64url credential of 24 to 64 characters, as the generic safeguard defines one: it mixes
 * letters (an upper-case one and a non-hex one, so it is neither a lower-case slug nor hex) with
 * digits, and its core without edge punctuation is at least 20 characters long.
 */
const credentialToken = fc.stringMatching(/^[A-Za-z0-9_-]{24,64}$/u).filter((token) =>
  /[A-Z]/u.test(token) && /[0-9]/u.test(token) && /[g-zG-Z]/u.test(token)
  && token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, '').length >= 20)
/** A hex digest longer than a commit SHA (41 to 64 digits) with at least one letter. */
const hexDigest = fc.stringMatching(/^[0-9a-f]{41,64}$/u).filter((token) => /[a-f]/u.test(token))

describe('playback log ring buffer', () => {
  it('records entries with wall-clock and monotonic time and drops the oldest at capacity', () => {
    let clock = 1_000
    let mono = 10
    const log = createPlaybackLog({ capacity: 3, now: () => clock, mono: () => mono })
    for (let index = 0; index < 5; index += 1) {
      clock += 1
      mono += 0.5
      log.record('event', { index })
    }
    const entries = log.snapshot()
    expect(entries.map((entry) => entry.index)).toEqual([2, 3, 4])
    expect(entries[0]).toEqual({ t: 1_003, mono: 11.5, type: 'event', index: 2 })
  })

  it('keeps only primitive fields and never lets a field overwrite t, mono or type', () => {
    const log = createPlaybackLog({ now: () => 5, mono: () => 1 })
    log.record('media.pause', {
      t: 99, type: 'spoof', paused: true, readyState: 4, nested: { secret: 'x' }, fn: () => 1,
      missing: undefined, nothing: null, ratio: 1 / 3, infinite: Number.POSITIVE_INFINITY,
    })
    expect(log.snapshot()).toEqual([{
      t: 5, mono: 1, type: 'media.pause', paused: true, readyState: 4, nothing: null, ratio: 0.333, infinite: 'Infinity',
    }])
  })

  it('returns copies from snapshot and empties on clear', () => {
    const log = createPlaybackLog()
    log.record('a')
    const first = log.snapshot()
    first[0].type = 'changed'
    expect(log.snapshot()[0].type).toBe('a')
    log.clear()
    expect(log.snapshot()).toEqual([])
  })

  it('never holds more than its capacity and always keeps the newest entries', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 120 }), (capacity, count) => {
      const log = createPlaybackLog({ capacity })
      for (let index = 0; index < count; index += 1) log.record('e', { index })
      const indices = log.snapshot().map((entry) => entry.index)
      const expected = Array.from({ length: Math.min(capacity, count) }, (_, offset) => count - Math.min(capacity, count) + offset)
      expect(indices).toEqual(expected)
    }))
  })
})

describe('playback log redaction', () => {
  const ticketUrl = 'https://app.example.com/api/media/chksz/stream.mp3?ticket=TICKET-SECRET-123&apikey=APIKEY-SECRET-456#frag'

  it('reduces a media URL to its origin and a short path hash', () => {
    const redacted = redactMediaUrl(ticketUrl)
    expect(redacted).toMatch(/^https:\/\/app\.example\.com#[0-9a-f]{8}$/u)
    expect(redactMediaUrl('https://app.example.com/api/media/chksz/stream.mp3')).toBe(redacted)
    expect(redactMediaUrl('https://app.example.com/api/media/other.mp3')).not.toBe(redacted)
    expect(redactMediaUrl('blob:https://app.example.com/1234')).toBe('blob:#redacted')
  })

  it('leaves an already-redacted URL unchanged', () => {
    const a = redactMediaUrl('https://media.example:8443/a.mp3?ticket=T')
    const b = redactMediaUrl('https://media.example:8443/b.mp3?ticket=T')
    expect(a).not.toBe(b)
    for (const redacted of [a, b, 'blob:#redacted', 'url#0123abcd', 'https://[::1]#89abcdef']) {
      expect(redactMediaUrl(redacted)).toBe(redacted)
      expect(sanitizeLogString(redacted)).toBe(redacted)
      expect(sanitizeLogString(`failed ${redacted} now`)).toBe(`failed ${redacted} now`)
    }
    // Something that only resembles the form is still redacted.
    expect(redactMediaUrl('https://user:secret#0123abcd')).not.toContain('secret')
  })

  it('sanitises a URL-bearing string idempotently', () => {
    fc.assert(fc.property(
      fc.webUrl({ withQueryParameters: true, withFragments: true }),
      // Extra text, a credential-like token, a readable id or a key, beside the URL.
      fc.oneof(
        fc.stringMatching(/^[A-Za-z0-9 ._:/+=~%-]{0,40}$/u),
        credentialToken,
        hexDigest,
        fc.uuid(),
        fc.stringMatching(/^chksz_[A-Za-z0-9 ;,._-]{1,30}$/u),
      ),
      fc.constantFrom(
        (u: string) => u,
        (u: string, x: string) => `play() failed for ${u} (retry) ${x}`,
        (u: string, x: string) => `{"src":"${u}","note":"${x}"}`,
        (u: string, x: string) => `${x}.${u}`,
      ),
      (url, extra, wrap) => {
        const once = sanitizeLogString(wrap(url, extra))
        expect(sanitizeLogString(once)).toBe(once)
      },
    ))
  })

  it('hashes a remaining credential-like token and keeps readable ids (task 41.6)', () => {
    const token = 'Zx81QbT0p9LmN3sKfW2vR7yU'
    const hashed = sanitizeLogString(`upstream said ${token} (expired)`)
    expect(hashed).toMatch(/^upstream said \[secret#[0-9a-f]{8}\] \(expired\)$/u)
    expect(sanitizeLogString(`again: "${token}".`)).toContain(hashed.slice(14, 31))
    expect(sanitizeLogString(`b64 ${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODkw'}== tail`)).toMatch(/^b64 \[secret#[0-9a-f]{8}\]== tail$/u)
    expect(sanitizeLogString('sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'))
      .toMatch(/^sha256 \[secret#[0-9a-f]{8}\]$/u)
    const readable = [
      'track 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b generation 3',
      'commit 4b825dc642cb6eb9a060e54bf8d69288fbee4904',
      'item 0123456789abcdef0123456789abcdef',
      'NotAllowedError: play() failed because the user didn\'t interact with the document first.',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240305.019.A1) Chrome/124.0.6367.82 Mobile Safari/537.36',
      'error chksz_key_required',
      'UNIQUE constraint failed: chksz_discovery_rate_events.created_at',
      'provider_qualification_not_accepted_yet',
      'track zzz-ost-vol-2-the-proxy-network-theme',
      'at src/features/player/PlayerBar.androidAdvance.vue:120',
      'hoyomix-debug-log-2026-10-28T12-34-56Z.json',
      'https://media-cdn-01.region-2.example.com#89abcdef',
      'providerId lx sourceId src-1 code timeout',
    ]
    for (const text of readable) expect(sanitizeLogString(text), text).toBe(text)
  })

  it('never lets a credential-like token through, whatever punctuation surrounds it', () => {
    const punctuation = fc.stringMatching(/^[\s"'`()[\]{}<>,;:!?|#*=./+~%-]{0,4}$/u)
    fc.assert(fc.property(
      fc.oneof(credentialToken, hexDigest),
      punctuation,
      punctuation,
      (token, before, after) => {
        const input = `${before}${token}${after}`
        const once = sanitizeLogString(input)
        expect(once).not.toContain(token)
        expect(sanitizeLogString(once)).toBe(once)
      },
    ))
  })

  it('keeps distinct path hashes when a buffer is restored', () => {
    const first = createPlaybackLog()
    first.record('media.loadstart', { src: 'https://cdn.example/a.mp3?ticket=1' })
    first.record('media.loadstart', { src: 'https://cdn.example/b.mp3?ticket=1' })
    first.record('media.state', describeMediaElement(Object.assign(document.createElement('audio'), { src: 'https://cdn.example/a.mp3' })))
    const kept = first.snapshot()
    expect(kept[0].src).not.toBe(kept[1].src)
    expect(kept[2].src).toBe(kept[0].src)
    const second = createPlaybackLog()
    second.restore(JSON.parse(JSON.stringify(kept)))
    expect(second.snapshot().map((entry) => entry.src)).toEqual(kept.map((entry) => entry.src))
  })

  it('redacts URLs and query parameters embedded in any string field', () => {
    const message = `play() failed for ${ticketUrl} see https://goo.gl/xX8pDD`
    const sanitized = sanitizeLogString(message)
    expect(sanitized).not.toContain('ticket')
    expect(sanitized).not.toContain('SECRET')
    expect(sanitized).toContain('https://app.example.com#')
    expect(sanitizeLogString('/api/media?token=abc&key=def')).toBe('/api/media')
  })

  it('never exports a ticket or api key from a URL with ?ticket=...&apikey=...', () => {
    const log = createPlaybackLog()
    log.record('media.error', { src: ticketUrl, message: `failed ${ticketUrl}` })
    log.record(`type ${ticketUrl}`, { [`k`]: ticketUrl })
    const json = log.exportJson(environment)
    expect(json).not.toContain('TICKET-SECRET-123')
    expect(json).not.toContain('APIKEY-SECRET-456')
    expect(json).not.toContain('ticket=')
    expect(json).not.toContain('apikey')
    expect(json).toContain('https://app.example.com#')
  })

  it('never lets a query value through, whatever the value', () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[A-Za-z0-9_-]{6,24}$/u),
      fc.constantFrom('ticket', 'apikey', 'token', 'key', 'sig'),
      (secret, name) => {
        const log = createPlaybackLog()
        log.record('media.loadstart', { src: `https://host.example/path/a.flac?${name}=${secret}`, note: `x?${name}=${secret}` })
        expect(log.exportJson(environment)).not.toContain(`=${secret}`)
      },
    ))
  })
  it('redacts every ChKSz key the credential contract accepts, however short or digit-free', () => {
    for (const key of ['chksz_a', 'chksz_abcdefgh', 'chksz_AbCdEfGh', 'chksz_MiXeD.case~Key-_', 'chksz_1']) {
      // Unquoted, a key may contain spaces, so the rest of the line is redacted with it.
      expect(sanitizeLogString(`key ${key} rejected\nnext line`), key).toBe('key chksz_[redacted]\nnext line')
    }
    expect(sanitizeLogString('{"apiKey":"chksz_abcdefgh"}')).not.toContain('abcdefgh')
    expect(sanitizeLogString('["chksz_a","chksz_b"]')).toBe('["chksz_[redacted]","chksz_[redacted]"]')
    expect(sanitizeLogString('POST https://api.example/v1?key=chksz_abcdefgh failed')).not.toContain('abcdefgh')
    expect(sanitizeLogString('/resolve?x=1&key=chksz_abcdefgh')).not.toContain('abcdefgh')
    expect(sanitizeLogString('X-API-Key=chksz_q;next')).not.toContain('chksz_q')
  })
  it('keeps the chksz_* codes and table names the codebase emits readable', () => {
    for (const code of ['chksz_key_required', 'chksz_dynamic_discoveries', 'chksz_discovery_locks', 'chksz_discovery_rate_events']) {
      expect(sanitizeLogString(`error ${code}`)).toBe(`error ${code}`)
      expect(sanitizeLogString(`{"error":"${code}"}`)).toBe(`{"error":"${code}"}`)
    }
    expect(sanitizeLogString('failed: chksz_key_required.')).toBe('failed: chksz_key_required.')
    expect(sanitizeLogString('UNIQUE constraint failed: chksz_discovery_locks.lock_key'))
      .toBe('UNIQUE constraint failed: chksz_discovery_locks.lock_key')
    // A key that merely starts with a known code is still a key.
    expect(sanitizeLogString('chksz_key_required0')).toBe('chksz_[redacted]')
    // Redaction is stable when a restored entry is sanitised again.
    expect(sanitizeLogString(sanitizeLogString('key chksz_abc'))).toBe('key chksz_[redacted]')
  })
  it('redacts a ChKSz key whose suffix starts with a delimiter, a space or a quote (task 41.6)', () => {
    expect(sanitizeLogString('key chksz_;SECRET')).toBe('key chksz_[redacted]')
    expect(sanitizeLogString('key chksz_ SECRET tail\nAccept: */*')).toBe('key chksz_[redacted]\nAccept: */*')
    expect(sanitizeLogString('key chksz_"SECRET')).toBe('key chksz_[redacted]')
    expect(sanitizeLogString('{"value":"chksz_;SECRET","ok":1}')).toBe('{"value":"chksz_[redacted]","ok":1}')
    expect(sanitizeLogString('{"apiKey":"chksz_;SECRET","ok":1}')).not.toContain('SECRET')
    expect(sanitizeLogString('{"k":"chksz_ a \\"SECRET\\" b","ok":1}')).toBe('{"k":"chksz_[redacted]","ok":1}')
    expect(sanitizeLogString("{'k': 'chksz_,SECRET', 'ok': 1}")).toBe("{'k': 'chksz_[redacted]', 'ok': 1}")
    // A key that merely follows a known code is still redacted, and the code stays readable.
    expect(sanitizeLogString('chksz_key_required: chksz_ SECRET')).toBe('chksz_key_required: chksz_[redacted]')
    expect(sanitizeLogString('{"error":"chksz_key_required","k":"chksz_;SECRET"}'))
      .toBe('{"error":"chksz_key_required","k":"chksz_[redacted]"}')
    for (const input of ['key chksz_;SECRET', '{"apiKey":"chksz_;SECRET"}', 'chksz_ SECRET tail']) {
      const once = sanitizeLogString(input)
      expect(once).not.toContain('SECRET')
      expect(sanitizeLogString(once)).toBe(once)
    }
  })
  it('redacts secret pairs with quoted names and quoted values', () => {
    expect(sanitizeLogString('{"token":"SECRET"}')).toBe('{"token":"[redacted]"}')
    expect(sanitizeLogString('{"password":"hunter2"}')).toBe('{"password":"[redacted]"}')
    expect(sanitizeLogString("{'apiKey': 'x'}")).toBe("{'apiKey': '[redacted]'}")
    expect(sanitizeLogString('{ "secret" :  "two words, here" , "ok": 1}')).toBe('{ "secret" :  "[redacted]" , "ok": 1}')
    expect(sanitizeLogString('{"Authorization":"Basic-ish \\"quoted\\" value"}')).not.toMatch(/quoted|value/u)
    expect(sanitizeLogString("{'sid':42}")).toBe("{'sid':[redacted]}")
    expect(sanitizeLogString('password=hunter2 next')).toBe('password=[redacted] next')
    expect(sanitizeLogString("token='abc def'")).toBe("token='[redacted]'")
    // A value cut off by truncation is still redacted to the end.
    expect(sanitizeLogString('{"token":"SECRET-WITHOUT-CLOSING')).toBe('{"token":"[redacted]"')
    // Non-secret names stay readable.
    expect(sanitizeLogString('{"status":"failed","code":"timeout"}')).toBe('{"status":"failed","code":"timeout"}')
  })
  it('redacts cookie headers with quoted names, whole to the closing quote (task 41.6)', () => {
    expect(sanitizeLogString('{"set-cookie":"__Host-session=SECRET; HttpOnly; Secure","ok":1}'))
      .toBe('{"set-cookie":"[redacted]","ok":1}')
    expect(sanitizeLogString("{'cookie': 'a=SECRET', 'ok': 1}")).toBe("{'cookie': '[redacted]', 'ok': 1}")
    expect(sanitizeLogString('{"Set-Cookie" : "id=SECRET\\"x; Path=/"}')).toBe('{"Set-Cookie" : "[redacted]"}')
    expect(sanitizeLogString('Set-Cookie: __Host-session=SECRET; HttpOnly\nAccept: */*')).toBe('Set-Cookie: [redacted]\nAccept: */*')
    expect(sanitizeLogString("cookie='a=SECRET")).toBe("cookie='[redacted]'")
    expect(sanitizeLogString('{"authorization":"Token SECRET","Proxy-Authorization":"Basic SECRET2"}'))
      .toBe('{"authorization":"[redacted]","Proxy-Authorization":"[redacted]"}')
    for (const input of ['{"set-cookie":"__Host-session=SECRET; HttpOnly; Secure"}', "'cookie': 'a=SECRET'"]) {
      const once = sanitizeLogString(input)
      expect(once).not.toContain('SECRET')
      expect(sanitizeLogString(once)).toBe(once)
    }
  })
  it('never lets a cookie value through under a quoted or unquoted header name', () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[A-Za-z0-9]{6,20}$/u),
      fc.constantFrom('cookie', 'Cookie', 'set-cookie', 'Set-Cookie'),
      fc.constantFrom(
        (n: string, v: string) => JSON.stringify({ [n]: v, ok: 1 }),
        (n: string, v: string) => `{'${n}': '${v}', 'ok': 1}`,
        (n: string, v: string) => `res\n${n}: ${v}\nAccept: */*`,
      ),
      (secret, name, wrap) => {
        fc.pre(!wrap(name, '').includes(secret) && !'[redacted]'.includes(secret))
        expect(sanitizeLogString(wrap(name, `__Host-s=${secret}; HttpOnly; Secure`))).not.toContain(secret)
      },
    ))
  })
  it('redacts the whole Authorization / Proxy-Authorization value, whatever the scheme', () => {
    expect(sanitizeLogString('authorization: Token SECRET')).toBe('authorization: [redacted]')
    expect(sanitizeLogString('Authorization: Bearer abc.def SECRET2')).toBe('Authorization: [redacted]')
    expect(sanitizeLogString('Proxy-Authorization: Basic dXNlcjpwYXNz trailing')).toBe('Proxy-Authorization: [redacted]')
    const digest = 'Authorization: Digest username="alice", realm="r@x", nonce="N0NCE", uri="/a", response="RESP123", opaque="OPQ"'
    expect(sanitizeLogString(digest)).toBe('Authorization: [redacted]')
    expect(sanitizeLogString('{"authorization":"Token SECRET","ok":1}')).toBe('{"authorization":"[redacted]","ok":1}')
    expect(sanitizeLogString("{'Proxy-Authorization': 'Custom a b c'}")).toBe("{'Proxy-Authorization': '[redacted]'}")
    expect(sanitizeLogString('{authorization: Token SECRET, ok: 1}')).toBe('{authorization: [redacted], ok: 1}')
    expect(sanitizeLogString('authorization=Token SECRET; theme=dark')).not.toContain('SECRET')
    const headers = 'GET /x\nAuthorization: Token SECRET more\nAccept: audio/*\nProxy-Authorization: Negotiate TOKEN2'
    expect(sanitizeLogString(headers)).toBe('GET /x\nAuthorization: [redacted]\nAccept: audio/*\nProxy-Authorization: [redacted]')
    // Stable when a restored entry is sanitised again.
    expect(sanitizeLogString(sanitizeLogString(digest))).toBe('Authorization: [redacted]')
  })
  it('never lets any part of an Authorization value through', () => {
    fc.assert(fc.property(
      fc.constantFrom('Token', 'Digest', 'Negotiate', 'AWS4-HMAC-SHA256', 'Custom'),
      fc.stringMatching(/^[A-Za-z0-9]{6,20}$/u),
      fc.constantFrom('authorization', 'Authorization', 'Proxy-Authorization'),
      fc.constantFrom(
        (n: string, v: string) => `req failed\n${n}: ${v}\nAccept: */*`,
        (n: string, v: string) => JSON.stringify({ [n]: v, ok: 1 }),
        (n: string, v: string) => `${n}=${v}; a=b`,
      ),
      (scheme, secret, name, wrap) => {
        fc.pre(!'[redacted]'.includes(secret) && !wrap(name, '').includes(secret))
        const value = scheme === 'Digest' ? `Digest username="u", nonce="n", response="${secret}"` : `${scheme} x ${secret}`
        expect(sanitizeLogString(wrap(name, value))).not.toContain(secret)
      },
    ))
  })
  it('never lets a quoted secret value through', () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[A-Za-z0-9 ._:/+-]{4,24}$/u),
      fc.constantFrom('token', 'password', 'apiKey', 'api_key', 'secret', 'ticket'),
      fc.constantFrom('"', "'"),
      fc.constantFrom(':', ': ', ' : ', '='),
      (secret, name, quote, separator) => {
        fc.pre(secret.trim().length >= 4 && !`${name}[redacted]`.toLowerCase().includes(secret.toLowerCase()))
        const input = `{${quote}${name}${quote}${separator}${quote}${secret}${quote}}`
        expect(sanitizeLogString(input)).not.toContain(secret)
      },
    ))
  })
  it('never lets a contract-valid ChKSz key through', () => {
    fc.assert(fc.property(
      // Spaces and delimiters included: the contract accepts any printable latin-1 suffix.
      fc.stringMatching(/^[A-Za-z0-9._~ ;,&()<>-]{1,40}$/u).filter((s) => s.trim() === s),
      fc.constantFrom((k: string) => `key ${k} rejected`, (k: string) => `{"k":"${k}"}`, (k: string) => `'${k}'`, (k: string) => `(${k})`),
      (suffix, wrap) => {
        const key = `chksz_${suffix}`
        // A known code followed by more text reads as the code; a real key never starts with one.
        fc.pre(!['chksz_key_required', 'chksz_dynamic_discoveries', 'chksz_discovery_locks', 'chksz_discovery_rate_events']
          .some((code) => key.startsWith(code)))
        expect(sanitizeLogString(wrap(key))).not.toContain(key)
      },
    ))
  })

  it('describes a media element with its redacted source and state', () => {
    const element = document.createElement('audio')
    element.dataset.audioDeck = '1'
    element.dataset.audioRole = 'standby'
    element.setAttribute('src', ticketUrl)
    const described = describeMediaElement(element)
    expect(described).toMatchObject({ deck: '1', role: 'standby', paused: true, readyState: 0, errorCode: null })
    expect(described).toMatchObject({ muted: false, defaultMuted: false, volume: 1 })
    element.muted = true
    element.volume = 0.35
    expect(describeMediaElement(element)).toMatchObject({ muted: true, defaultMuted: false, volume: 0.35 })
    expect(String(described.src)).toMatch(/^https:\/\/app\.example\.com#[0-9a-f]{8}$/u)
    expect(describeMediaElement(null)).toEqual({ element: false })
  })
})

describe('structured secret field names (task 41.6)', () => {
  const SECRET_FIELD_NAMES = [
    'access_token', 'accessToken', 'access-token', 'accesstoken', 'id_token', 'idToken',
    'refresh_token', 'refreshToken', 'client_secret', 'clientSecret', 'client-secret',
    'signature', 'sig', 'apikey', 'api_key', 'apiKey', 'api-key', 'APIKey', 'x-api-key',
    'password', 'passwd', 'secret', 'token', 'auth', 'authorization', 'Authorization', 'cookie',
    'session', 'sessionId', 'session_id', 'sid', 'ticket', 'key', 'credential', 'credentials',
    'email', 'headers', 'body',
  ]
  const READABLE_FIELD_NAMES = ['providerId', 'sourceId', 'trackId', 'signal', 'keyframe', 'author', 'designation', 'k', 'origin']

  it.each(SECRET_FIELD_NAMES)('redacts the structured field %s', (name) => {
    const log = createPlaybackLog()
    log.record('x', { [name]: 'v4lue-123' })
    expect(log.snapshot()[0][name]).toBe('[redacted]')
  })

  it.each(READABLE_FIELD_NAMES)('keeps the non-secret field %s readable', (name) => {
    const log = createPlaybackLog()
    log.record('x', { [name]: 'plain-value' })
    expect(log.snapshot()[0][name]).toBe('plain-value')
  })

  it('a name redacted in free text is also redacted as a structured field (one shared list)', () => {
    const forms = (snake: string) => {
      const words = snake.split('_')
      return [snake, words.join('-'), words.join(''), words[0] + words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join('')]
    }
    const names = ['ticket', 'token', 'access_token', 'refresh_token', 'id_token', 'api_key', 'key', 'secret',
      'client_secret', 'password', 'passwd', 'session', 'session_id', 'sid', 'auth', 'authorization',
      'credential', 'signature', 'sig']
    fc.assert(fc.property(fc.constantFrom(...names.flatMap(forms)), (name) => {
      expect(sanitizeLogString(`${name}=v4lue-123`)).toBe(`${name}=[redacted]`)
      const log = createPlaybackLog()
      log.record('x', { [name]: 'v4lue-123' })
      expect(log.snapshot()[0][name]).toBe('[redacted]')
    }))
  })
})

describe('playback log export', () => {
  it('exports the documented JSON document', () => {
    const log = createPlaybackLog({ now: () => Date.UTC(2026, 9, 28, 12, 34, 56) })
    log.record('play.rejected', { name: 'NotAllowedError' })
    const parsed = JSON.parse(log.exportJson(environment))
    expect(parsed).toEqual({
      format: PLAYBACK_LOG_FORMAT,
      version: 1,
      exportedAt: '2026-10-28T12:34:56.000Z',
      build: { commit: 'abc1234' },
      userAgent: 'test-agent',
      displayMode: 'standalone',
      visibilityState: 'hidden',
      entries: [expect.objectContaining({ type: 'play.rejected', name: 'NotAllowedError', t: Date.UTC(2026, 9, 28, 12, 34, 56) })],
    })
  })

  it('reads the page environment when none is given', () => {
    const parsed = JSON.parse(createPlaybackLog().exportJson())
    expect(parsed.format).toBe(PLAYBACK_LOG_FORMAT)
    expect(['standalone', 'browser', 'unknown']).toContain(parsed.displayMode)
    expect(typeof parsed.userAgent).toBe('string')
    expect(parsed.visibilityState).toBe(document.visibilityState)
  })

  it('names the file with a filesystem-safe timestamp', () => {
    // Renamed by task 41.8: the export is a debug log, not a listening history.
    expect(playbackLogFileName(Date.UTC(2026, 9, 28, 1, 2, 3, 456))).toBe('hoyomix-debug-log-2026-10-28T01-02-03Z.json')
    expect(PLAYBACK_LOG_FORMAT).toBe('hoyomix-debug-log')
  })
})

describe('playback log lifecycle', () => {
  let uninstall: (() => void) | undefined
  afterEach(() => { uninstall?.(); uninstall = undefined })

  function targets(storage: Map<string, string>) {
    return {
      window: new EventTarget() as unknown as Window,
      document: Object.assign(new EventTarget(), { visibilityState: 'visible' }) as unknown as Document,
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value) },
        removeItem: (key: string) => { storage.delete(key) },
      },
    }
  }

  it('records page events, keeps the buffer on pagehide and restores it once', () => {
    const storage = new Map<string, string>()
    const first = createPlaybackLog()
    const pageA = targets(storage)
    uninstall = installPlaybackLogLifecycle(first, pageA)
    pageA.document.dispatchEvent(new Event('visibilitychange'))
    pageA.document.dispatchEvent(new Event('freeze'))
    pageA.window.dispatchEvent(new Event('offline'))
    pageA.window.dispatchEvent(new Event('pagehide'))
    expect(first.snapshot().map((entry) => entry.type)).toEqual([
      'log.lifecycleInstalled', 'page.visibilitychange', 'page.freeze', 'net.offline', 'page.pagehide',
    ])
    expect(storage.has(PLAYBACK_LOG_SESSION_KEY)).toBe(true)
    uninstall()
    uninstall = undefined

    pageA.window.dispatchEvent(new Event('online'))
    expect(first.snapshot().some((entry) => entry.type === 'net.online')).toBe(false)

    const second = createPlaybackLog()
    uninstall = installPlaybackLogLifecycle(second, targets(storage))
    const types = second.snapshot().map((entry) => entry.type)
    expect(types.slice(0, 5)).toEqual(['log.lifecycleInstalled', 'page.visibilitychange', 'page.freeze', 'net.offline', 'page.pagehide'])
    expect(second.snapshot()[0].restored).toBe(true)
    expect(types.slice(5)).toEqual(['log.restored', 'log.lifecycleInstalled'])
    expect(storage.has(PLAYBACK_LOG_SESSION_KEY)).toBe(false)
  })

  it('restores a buffer kept under the 41.1 key once and removes it', () => {
    const kept = [{ t: 1, mono: 2, type: 'media.pause' }]
    const storage = new Map([[LEGACY_PLAYBACK_LOG_SESSION_KEY, JSON.stringify(kept)]])
    const log = createPlaybackLog()
    uninstall = installPlaybackLogLifecycle(log, targets(storage))
    const entries = log.snapshot()
    expect(entries[0]).toMatchObject({ type: 'media.pause', restored: true })
    expect(entries[1]).toMatchObject({ type: 'log.restored', count: 1, legacy: true })
    expect(storage.has(LEGACY_PLAYBACK_LOG_SESSION_KEY)).toBe(false)
    expect(PLAYBACK_LOG_SESSION_KEY).not.toBe(LEGACY_PLAYBACK_LOG_SESSION_KEY)
  })

  it('ignores a corrupt stored buffer', () => {
    const storage = new Map([[PLAYBACK_LOG_SESSION_KEY, '{not json']])
    const log = createPlaybackLog()
    uninstall = installPlaybackLogLifecycle(log, targets(storage))
    expect(log.snapshot().map((entry) => entry.type)).toEqual(['log.lifecycleInstalled'])
  })
})
