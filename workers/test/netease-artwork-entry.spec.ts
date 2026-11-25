import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../index'

const ORIGIN = 'https://study.example'
const ID = '2155423467'
afterEach(() => vi.unstubAllGlobals())

describe('NetEase artwork routes through the shipped Worker entrypoint', () => {
  it.each(['lx', 'gd-studio'])('routes %s artwork to its independent provider handler', async (providerId) => {
    const rows = [{ providerKey: providerId, enabled: 1, priority: 20, status: 'unknown', updatedAt: 0 }]
    const DB = { prepare: () => ({ all: async () => ({ results: rows }), bind: () => ({ first: async () => null }) }) }
    const upstream = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, songs: [{ id: Number(ID), album: { picUrl: 'https://p2.music.126.net/cover.jpg' } }] }), { headers: { 'content-type': 'text/plain;charset=UTF-8' } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'content-type': 'image/jpeg' } }))
    vi.stubGlobal('fetch', upstream)
    const env = { DB, PUBLIC_ORIGIN: ORIGIN, GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz', GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'm701.music.126.net' }
    const response = await worker.fetch(new Request(ORIGIN + '/api/providers/' + providerId + '/artwork/' + ID), env as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/jpeg')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(upstream).toHaveBeenCalledTimes(2)
  })

  describe.each(['lx', 'gd-studio'])('%s public artwork response policy', providerId => {
    const env = () => {
      const rows = [{ providerKey: providerId, enabled: 1, priority: 20, status: 'unknown', updatedAt: 0 }]
      const DB = { prepare: () => ({ all: async () => ({ results: rows }), bind: () => ({ first: async () => null }) }) }
      return { DB, PUBLIC_ORIGIN: ORIGIN, GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz', GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'm701.music.126.net' }
    }
    const metadata = () => new Response(JSON.stringify({
      code: 200, songs: [{ id: Number(ID), album: { picUrl: 'https://p2.music.126.net/cover.jpg' } }],
    }), { headers: { 'content-type': 'text/plain;charset=UTF-8' } })
    const bytes = new Uint8Array([255, 216, 255, 217])

    it.each([
      ['private', { 'cache-control': 'private, max-age=3600' }],
      ['private fields', { 'cache-control': 'public, PRIVATE = "content-type, etag", max-age=3600' }],
      ['no-store', { 'cache-control': 'public, No-Store, max-age=3600' }],
      ['no-cache', { 'cache-control': 'public, no-cache="set-cookie", max-age=3600' }],
      ['legacy no-cache', { pragma: 'no-cache' }],
      ['cookie', { 'set-cookie': 'session=private' }],
      ['legacy cookie', { 'set-cookie2': 'session=private' }],
      ['cookie variant', { vary: 'Cookie' }],
      ['authorisation variant', { vary: 'Accept-Encoding, Authorization' }],
      ['wildcard variant', { vary: '*' }],
      ['unknown variant', { vary: 'X-Private-User' }],
    ] satisfies [string, Record<string, string>][])('rejects %s artwork before consuming private bytes', async (_label, sensitiveHeaders) => {
      for (const method of ['GET', 'HEAD']) {
        const cancel = vi.fn()
        const upstreamImage = new Response(method === 'HEAD' ? null : new ReadableStream({
          start(controller) { controller.enqueue(bytes) },
          cancel,
        }), { headers: { 'content-type': 'image/jpeg', ...sensitiveHeaders } })
        const upstream = vi.fn<typeof fetch>()
          .mockResolvedValueOnce(metadata())
          .mockResolvedValueOnce(upstreamImage)
        vi.stubGlobal('fetch', upstream)
        const response = await worker.fetch(new Request(
          ORIGIN + '/api/providers/' + providerId + '/artwork/' + ID, { method },
        ), env() as never)
        expect(response.status).toBe(502)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('set-cookie')).toBeNull()
        expect(response.headers.get('set-cookie2')).toBeNull()
        expect(await response.json()).toEqual({ error: 'invalid_response' })
        expect(upstream).toHaveBeenCalledTimes(2)
        if (method === 'GET') expect(cancel).toHaveBeenCalledOnce()
      }
    })

    it.each([
      ['absent policy', {}],
      ['public', { 'cache-control': 'public, max-age=3600' }],
      ['encoding variant', { vary: 'Accept-Encoding' }],
    ] satisfies [string, Record<string, string>][])('retains public CDN compatibility for %s', async (_label, headers) => {
      vi.stubGlobal('fetch', vi.fn<typeof fetch>()
        .mockResolvedValueOnce(metadata())
        .mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'image/jpeg', ...headers } })))
      const response = await worker.fetch(new Request(
        ORIGIN + '/api/providers/' + providerId + '/artwork/' + ID,
      ), env() as never)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    })
  })
})
