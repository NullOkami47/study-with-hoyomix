// The outbound policy for importing a source from a URL.
//
// The Admin API fetches a URL the Owner types in, so this is the SSRF boundary. Each test here
// names the destination it refuses and why: loopback, the private ranges, link-local (where cloud
// metadata lives), single-label names, IPv6 literals, and non-HTTPS schemes. The redirect tests are
// the other half: a redirect is refused rather than followed, because following it means the
// request has already been sent before the destination is known.

import { describe, expect, it } from 'vitest'
import {
  fetchScriptBounded,
  isBlockedHostname,
  isBlockedIpv4,
  validateOutboundScriptUrl,
} from '../lx/outbound'

const call = (url: string, init?: RequestInit) => fetchScriptBounded(url, { fetchImpl: (async () => new Response('x', init)) as unknown as typeof fetch })

describe('validateOutboundScriptUrl', () => {
  it('accepts a plain HTTPS .js URL', () => {
    const result = validateOutboundScriptUrl('https://dl.kstore.dev/download/7890/Hei+Music.js')
    expect(result.ok).toBe(true)
  })

  it.each([
    ['http://example.com/a.js', 'insecure_url'],
    ['ftp://example.com/a.js', 'insecure_url'],
    ['https://user:pass@example.com/a.js', 'invalid_url'],
    ['https://example.com:8443/a.js', 'invalid_url'],
    ['https://example.com/a.txt', 'invalid_url'],
  ])('refuses %s', (url, code) => {
    const result = validateOutboundScriptUrl(url)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe(code)
  })

  it.each([
    'https://localhost/a.js',
    'https://127.0.0.1/a.js',
    'https://169.254.169.254/latest/meta-data/a.js',
    'https://10.0.0.5/a.js',
    'https://192.168.1.1/a.js',
    'https://172.16.0.1/a.js',
    'https://100.64.0.1/a.js',
    'https://[::1]/a.js',
    'https://[fd00::1]/a.js',
    'https://metadata.google.internal/a.js',
    'https://intranet/a.js',
    'https://example.local/a.js',
    'https://2130706433/a.js',
  ])('refuses the internal destination %s', (url) => {
    const result = validateOutboundScriptUrl(url)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('blocked_host')
  })
})

describe('isBlockedIpv4', () => {
  it.each(['0.1.2.3', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.1.1', '192.168.0.1', '224.0.0.1', '255.255.255.255'])(
    'blocks %s',
    (address) => expect(isBlockedIpv4(address)).toBe(true),
  )

  it.each(['1.1.1.1', '8.8.8.8', '104.16.0.1', '172.32.0.1', '192.169.0.1'])('allows %s', (address) => {
    expect(isBlockedIpv4(address)).toBe(false)
  })
})

describe('isBlockedHostname', () => {
  it('blocks a trailing-dot loopback spelling', () => {
    expect(isBlockedHostname('localhost.')).toBe(true)
  })

  it('allows an ordinary public name', () => {
    expect(isBlockedHostname('dl.kstore.dev')).toBe(false)
  })
})

describe('fetchScriptBounded', () => {
  it('aborts and cancels a body that stalls after the headers arrive', async () => {
    let cancelled = false
    let signal: AbortSignal | null | undefined
    const result = await fetchScriptBounded('https://example.com/a.js', {
      timeoutMs: 20,
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        signal = init.signal
        return new Response(new ReadableStream({ cancel() { cancelled = true } }))
      }) as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('fetch_failed')
    expect(signal?.aborted).toBe(true)
    expect(cancelled).toBe(true)
  }, 500)

  it('refuses a redirect instead of following it', async () => {
    const result = await fetchScriptBounded('https://example.com/a.js', {
      fetchImpl: (async () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/x.js' } })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('redirect_refused')
  })

  it('refuses an opaque redirect', async () => {
    const opaque = { type: 'opaqueredirect', status: 0, ok: false, headers: new Headers() } as unknown as Response
    const result = await fetchScriptBounded('https://example.com/a.js', {
      fetchImpl: (async () => opaque) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('redirect_refused')
  })

  it('refuses a body over the cap declared in content-length', async () => {
    const result = await fetchScriptBounded('https://example.com/a.js', {
      fetchImpl: (async () => new Response('x', { status: 200, headers: { 'content-length': String(600 * 1024) } })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('too_large')
  })

  it('refuses a body over the cap even without content-length', async () => {
    const big = 'a'.repeat(600 * 1024)
    const result = await fetchScriptBounded('https://example.com/a.js', {
      fetchImpl: (async () => new Response(big, { status: 200 })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('too_large')
  })

  it('refuses a non-UTF-8 body', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd])
    const result = await fetchScriptBounded('https://example.com/a.js', {
      fetchImpl: (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('not_text')
  })

  it('reports a non-2xx status', async () => {
    const result = await fetchScriptBounded('https://example.com/a.js', {
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('fetch_failed')
  })

  it('aborts a request that never answers', async () => {
    const result = await fetchScriptBounded('https://example.com/a.js', {
      timeoutMs: 10,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('fetch_failed')
  })

  it('returns the script and its byte length on success', async () => {
    const result = await fetchScriptBounded('https://example.com/a.js', {
      fetchImpl: (async () => new Response('var a = 1', { status: 200 })) as unknown as typeof fetch,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.script).toBe('var a = 1')
      expect(result.byteLength).toBe(9)
    }
  })

  it('never sends credentials', async () => {
    let seen: RequestInit | undefined
    await fetchScriptBounded('https://example.com/a.js', {
      fetchImpl: ((_url: string, init: RequestInit) => {
        seen = init
        return Promise.resolve(new Response('var a = 1', { status: 200 }))
      }) as unknown as typeof fetch,
    })
    expect(seen?.credentials).toBe('omit')
    expect(seen?.redirect).toBe('manual')
  })
})
