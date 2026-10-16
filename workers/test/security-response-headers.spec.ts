import { describe, expect, it } from 'vitest'

import { applyApiSecurityHeaders } from '../index'

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

describe('API response security headers', () => {
  it.each([
    ['JSON error', Response.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } })],
    ['OAuth redirect', new Response(null, { status: 302, headers: { location: 'https://study.example/', 'set-cookie': '__Host-session=value; Secure; HttpOnly' } })],
    ['media stream', new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' } })],
  ] as const)('decorates a %s without changing its response contract', async (_label, original) => {
    const expectedBody = new Uint8Array(await original.clone().arrayBuffer())
    const secured = applyApiSecurityHeaders(original)

    expect(secured.status).toBe(original.status)
    expect(new Uint8Array(await secured.arrayBuffer())).toEqual(expectedBody)
    expect(secured.headers.get('x-content-type-options')).toBe('nosniff')
    expect(secured.headers.get('referrer-policy')).toBe('no-referrer')
    expect(secured.headers.get('content-security-policy')).toBe(API_CSP)
    for (const header of ['cache-control', 'content-type', 'location', 'set-cookie', 'accept-ranges']) {
      expect(secured.headers.get(header), header).toBe(original.headers.get(header))
    }
  })
})
