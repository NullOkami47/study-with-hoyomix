// The static scanner that decides what a candidate script "needs".
//
// These tests exist because the first implementation got two real cases wrong on a real script:
// a documentation URL in a comment, and a `Referer` header value, were both counted as network
// destinations. The consequence was not cosmetic — the registry parked a working source in
// `pending_network_approval` and never published it.
//
// The rule under test is narrow on purpose: only a string literal can be a destination, a URL in a
// comment is documentation, and a URL that is the value of a header key is data the script sends.

import { describe, expect, it } from 'vitest'
import { analyseLxScript, screenLxScript } from '../lx/globalSources'
import { isHeaderValue, scanScript } from '../lx/scriptScan'

describe('scanScript', () => {
  it('separates string literals from comments and code', () => {
    const scan = scanScript(`const a = 'one'; // two\n/* three */ const b = "four"`)
    expect(scan.literals.map((literal) => literal.value)).toEqual(['one', 'four'])
  })

  it('does not treat a // inside a string as a comment', () => {
    const scan = scanScript(`const url = 'https://example.com/a.js'`)
    expect(scan.literals.map((literal) => literal.value)).toEqual(['https://example.com/a.js'])
  })

  it('keeps an escaped quote inside a literal', () => {
    const scan = scanScript(String.raw`const s = 'it\'s here'`)
    expect(scan.literals[0]?.value).toBe(String.raw`it\'s here`)
  })

  it('stops an unterminated single-quoted string at the newline instead of swallowing the file', () => {
    const scan = scanScript(`const a = 'oops\nconst b = 'kept'`)
    expect(scan.literals.map((literal) => literal.value)).toContain('kept')
  })

  it('reads a template literal as one literal', () => {
    const scan = scanScript('const t = `https://example.com/x.js`')
    expect(scan.literals.map((literal) => literal.value)).toEqual(['https://example.com/x.js'])
  })

  it('detects a NUL byte', () => {
    expect(scanScript('a\u0000b').hasNul).toBe(true)
    expect(scanScript('ab').hasNul).toBe(false)
  })
})

describe('isHeaderValue', () => {
  it('recognises a quoted header key', () => {
    expect(isHeaderValue("headers: { 'Referer': ")).toBe(true)
    expect(isHeaderValue('headers: { "Origin": ')).toBe(true)
    expect(isHeaderValue('headers: { origin: ')).toBe(true)
  })

  it('does not recognise an ordinary property', () => {
    expect(isHeaderValue('headers: { url: ')).toBe(false)
    expect(isHeaderValue('const target = ')).toBe(false)
  })
})

describe('analyseLxScript', () => {
  it('does not mistake Cookie labels inside log strings for credential assignments', () => {
    const script = `console.log('[Tencent] Cookie: ' + (configured ? 'configured' : 'not configured'))`
    expect(analyseLxScript(script).credentialKeys).toEqual([])
  })
  it('still refuses real quoted and commented credential assignments without exposing values', () => {
    for (const script of [`const token /* comment */ = 'private-value-example'`, `const headers = {'Cookie': 'private-value-example'}`]) {
      const result=screenLxScript(script)
      expect(result?.code).toBe('embedded_credentials')
      expect(result?.message).not.toContain('private-value-example')
    }
  })
  it('does not let a quote in a regular expression hide a later credential', () => {
    expect(screenLxScript(`const re = /'/; const token = "private-value-example";`)?.code).toBe('embedded_credentials')
  })
  it('screens credentials in template literals and interpolation expressions', () => {
    for (const script of ['const token = `private-value-example`;', 'const message = `${({token: "private-value-example"})}`;']) {
      expect(screenLxScript(script)?.code).toBe('embedded_credentials')
    }
  })
  it('refuses malformed tokens without exposing the parser error or embedded value', () => {
    const rejection=screenLxScript(`const token = 'private-value-example`)
    expect(rejection?.code).toBe('not_javascript')
    expect(rejection?.message).not.toContain('private-value-example')
  })

  it('ignores a URL in a line comment', () => {
    const analysis = analyseLxScript('// 参考文档: https://docs.example.invalid/music-source/\nconst x = 1')
    expect(analysis.httpsOrigins).toEqual([])
    expect(analysis.headerOrigins).toEqual([])
  })

  it('ignores a URL in a block comment', () => {
    const analysis = analyseLxScript('/* see https://docs.example.com/page */\nconst x = 1')
    expect(analysis.httpsOrigins).toEqual([])
  })

  it('reports a Referer value as a header origin, not a destination', () => {
    const script = `fetch(url, { headers: { 'Referer': 'https://referer.example.invalid/' } })`
    const analysis = analyseLxScript(script)
    expect(analysis.httpsOrigins).toEqual([])
    expect(analysis.headerOrigins).toEqual(['https://referer.example.invalid'])
  })

  it('still reports a real destination', () => {
    const script = `const api = 'https://api.example.com/v1/song'`
    const analysis = analyseLxScript(script)
    expect(analysis.httpsOrigins).toEqual(['https://api.example.com'])
    expect(analysis.headerOrigins).toEqual([])
  })

  it('sorts and de-duplicates', () => {
    const script = `a('https://b.example.com/x'); b('https://a.example.com/y'); c('https://b.example.com/z')`
    expect(analyseLxScript(script).httpsOrigins).toEqual(['https://a.example.com', 'https://b.example.com'])
  })

  it('does not treat a plaintext URL in a comment as a plaintext origin', () => {
    const analysis = analyseLxScript('// legacy endpoint was http://old.example.com/api\nconst x = 1')
    expect(analysis.plaintextOrigins).toEqual([])
    expect(screenLxScript('// legacy endpoint was http://old.example.com/api\nconst x = 1')).toBeNull()
  })

  it('still refuses a plaintext destination in code', () => {
    const rejection = screenLxScript(`const api = 'http://old.example.com/api'`)
    expect(rejection?.code).toBe('plaintext_origin')
  })

  it('refuses literal URL credentials before storage, even with digest disclosure', () => {
    const fixture = new URL('https://music.example/song')
    fixture.username = 'fixture-listener'
    fixture.password = 'fixture-secret'
    const script = `const endpoint = ${JSON.stringify(fixture.href)}`
    const analysis = analyseLxScript(script)
    expect(analysis.httpsOrigins).toEqual([fixture.origin])
    const rejection = screenLxScript(script, { allowEmbeddedCredentials: true })
    expect(rejection?.code).toBe('embedded_credentials')
    const report = JSON.stringify({ analysis, rejection })
    expect(report).not.toContain(fixture.username)
    expect(report).not.toContain(fixture.password)
    expect(screenLxScript(`// documentation: ${fixture.href}\nconst ready = true`)).toBeNull()
    expect(screenLxScript('const apiKey = "disclosed-fixture"', { allowEmbeddedCredentials: true })).toBeNull()
  })

  it('does not read a credential out of a comment', () => {
    const analysis = analyseLxScript(`// example: token: 'abcdefghijklmnop'\nconst x = 1`)
    expect(analysis.credentialKeys).toEqual([])
  })

  it.each(['(', ')', "'", '`', '"', '<', '>', ' ', '\t', '\n'])(
    'does not truncate a literal URL credential at %j', (punctuation) => {
      const endpoint = 'https://listener.example' + punctuation + 'account:fixture-secret@cdn.example/api'
      expect(new URL(endpoint).password).toBeTruthy()
      const script = 'const endpoint = ' + JSON.stringify(endpoint)
      const analysis = analyseLxScript(script)
      expect(analysis.credentialKeys).toContain('url_userinfo')
      for (const allowEmbeddedCredentials of [false, true]) {
        const rejection = screenLxScript(script, { allowEmbeddedCredentials })
        expect(rejection?.code).toBe('embedded_credentials')
        expect(JSON.stringify({ analysis, rejection })).not.toContain('fixture-secret')
      }
    },
  )

  it('keeps URL path/query email values and documentation comments distinct from userinfo', () => {
    expect(screenLxScript('const url = "https://cdn.example/a(user@example)/track?email=person@example"')).toBeNull()
    expect(screenLxScript('// https://account:fixture-secret@cdn.example/api\nconst ready = true')).toBeNull()
  })

  it.each([
    'https:///listener:fixture-secret@cdn.example/api',
    'https:////listener:fixture-secret@cdn.example/api',
    'https:/listener:fixture-secret@cdn.example/api',
    'https:listener:fixture-secret@cdn.example/api',
    'https:\\listener:fixture-secret@cdn.example/api',
    'https:/' + String.fromCharCode(92) + 'listener:fixture-secret@cdn.example/api',
    'htt' + String.fromCharCode(9) + 'ps://listener:fixture-secret@cdn.example/api',
  ])('screens WHATWG-normalised authority in %j', (endpoint) => {
    // Keep this a real URL parser case, not merely a suspicious-looking string.
    expect(new URL(endpoint).password).toBe('fixture-secret')
    const script = 'const endpoint = ' + JSON.stringify(endpoint)
    expect(analyseLxScript(script).credentialKeys).toContain('url_userinfo')
    expect(screenLxScript(script, { allowEmbeddedCredentials: true })?.code).toBe('embedded_credentials')
  })

  it('still reads a credential out of code', () => {
    const rejection = screenLxScript(`const apiKey = 'abcdefghijklmnop'`)
    expect(rejection?.code).toBe('embedded_credentials')
  })

  it('refuses a script containing a NUL byte', () => {
    expect(screenLxScript('var a\u0000b')?.code).toBe('not_javascript')
  })

  it('reads the header name and version', () => {
    const analysis = analyseLxScript('/**\n * @name Sample Music\n * @version v1.0.0\n */\nvar a = 1')
    expect(analysis.name).toBe('Sample Music')
    expect(analysis.version).toBe('v1.0.0')
  })
})
