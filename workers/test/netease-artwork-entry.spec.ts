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
})
