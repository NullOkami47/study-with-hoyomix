import { describe, expect, it, vi } from 'vitest'
import type { Track } from '../../catalog/types'
import { createVkeysProvider } from './vkeys'
import { createServerProxyProvider } from './proxy'

const ORIGIN = window.location.origin
const RESOLVE_URL = ORIGIN + '/api/providers/vkeys/resolve'
const TICKET = 'abcdefghijklmnopqrstuvwxyzABCDEF'
const track = (sources: Track['sources'], id = 'canonical-song'): Track => ({
  id, title: 'Exact track', aliases: {}, games: ['genshin'], relationIds: [],
  tabs: ['focus'], workGroupId: 'work', vocalStatus: 'instrumental', needsClassification: false, sources,
})
const mappedTrack = () => track([{ provider: 'chksz', externalId: '9000000002' }])
const at = (response: Response, url = RESOLVE_URL): Response => {
  Object.defineProperty(response, 'url', { value: url })
  return response
}
const playableResponse = (id = 'canonical-song', ticket = TICKET) => at(Response.json({
  url: '/api/providers/vkeys/media/' + id + '/' + ticket, mimeType: 'audio/mpeg',
}))

describe('standalone Vkeys provider', () => {
  it.each([
    [{ provider: 'chksz', externalId: '9000000002' }],
    [{ provider: 'vkeys', externalId: 'canonical-song' }],
    [{ provider: 'vkeys', externalId: 'another-song' }, { provider: 'chksz', externalId: '42' }],
  ] as Track['sources'][])('derives only the canonical track ID from eligible sources: %j', async (...sources) => {
    const fetchImpl = vi.fn().mockResolvedValue(playableResponse())
    const sourceTrack = track(sources)
    const snapshot = JSON.stringify(sourceTrack)
    sourceTrack.sources.forEach(Object.freeze)
    Object.freeze(sourceTrack.sources)
    Object.freeze(sourceTrack)
    const provider = createVkeysProvider({ fetch: fetchImpl })
    expect(provider.id).toBe('vkeys')
    expect(provider.canResolve?.(sourceTrack)).toBe(true)
    const signal = new AbortController().signal
    expect(await provider.resolve(sourceTrack, signal)).toEqual({
      kind: 'audio', url: ORIGIN + '/api/providers/vkeys/media/canonical-song/' + TICKET, mimeType: 'audio/mpeg',
    })
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(RESOLVE_URL, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ externalId: sourceTrack.id }), redirect: 'error', signal,
    }))
    expect(JSON.stringify(sourceTrack)).toBe(snapshot)
  })

  it.each(['0', 'a', 'a'.repeat(128)])('accepts a canonical slug at the valid boundary: %s', async (id) => {
    const fetchImpl = vi.fn().mockResolvedValue(playableResponse(id))
    const provider = createVkeysProvider({ fetch: fetchImpl })
    const sourceTrack = track([{ provider: 'vkeys', externalId: id }], id)
    expect(provider.canResolve?.(sourceTrack)).toBe(true)
    expect((await provider.resolve(sourceTrack, new AbortController().signal))?.kind).toBe('audio')
  })

  it.each(['', '-leading', 'Uppercase', 'a_b', 'a/b', 'a%2fb', 'a b', 'a\n', 'a\r', 'a'.repeat(129), '歌曲', 'https://example.test/track'])(
    'rejects an invalid canonical ID before fetching: %j', async (id) => {
      const fetchImpl = vi.fn()
      const provider = createVkeysProvider({ fetch: fetchImpl })
      const sourceTrack = track([{ provider: 'chksz', externalId: '42' }], id)
      expect(provider.canResolve?.(sourceTrack)).toBe(false)
      await expect(provider.resolve(sourceTrack, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' })
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each([
    [],
    [{ provider: 'vkeys', externalId: 'another-song' }],
    [{ provider: 'vkeys', externalId: '42' }],
    [{ provider: 'chksz', externalId: '' }],
    [{ provider: 'chksz', externalId: 'not-a-number' }],
    [{ provider: 'chksz', externalId: '1'.repeat(21) }],
    [{ provider: 'chksz', externalId: '42\n' }],
    [{ provider: 'chksz', externalId: '42/trick' }],
    [{ provider: 'lx', externalId: '42', metadata: { title: 'Exact track', externalId: '9000000002' } }],
    [{ provider: 'gd-studio', externalId: 'netease:42:320' }],
  ] as Track['sources'][])('does not guess identity from other sources or metadata: %j', async (...sources) => {
    const fetchImpl = vi.fn()
    const provider = createVkeysProvider({ fetch: fetchImpl })
    const sourceTrack = track(sources)
    expect(provider.canResolve?.(sourceTrack)).toBe(false)
    expect(await provider.resolve(sourceTrack, new AbortController().signal)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a missing canonical identity before fetching', async () => {
    const fetchImpl = vi.fn()
    const provider = createVkeysProvider({ fetch: fetchImpl })
    const sourceTrack = { ...mappedTrack(), id: undefined } as unknown as Track
    expect(provider.canResolve?.(sourceTrack)).toBe(false)
    await expect(provider.resolve(sourceTrack, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps the derived source request-local when the next track has no mapping', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(playableResponse())
    const provider = createVkeysProvider({ fetch: fetchImpl })
    await provider.resolve(mappedTrack(), new AbortController().signal)
    expect(await provider.resolve(track([]), new AbortController().signal)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([404, 410])('returns null for unmapped or expired tickets (%s)', async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue(at(Response.json({ error: 'not_mapped' }, { status })))
    const provider = createVkeysProvider({ fetch: fetchImpl })
    expect(await provider.resolve(mappedTrack(), new AbortController().signal)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('requests a fresh ticket after expiry instead of retaining a failed or previous result', async () => {
    const nextTicket = 'ZYXWVUTSRQPONMLKJIHGFEDCBAabcdef'
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(playableResponse())
      .mockResolvedValueOnce(at(new Response(null, { status: 410 })))
      .mockResolvedValueOnce(playableResponse('canonical-song', nextTicket))
    const provider = createVkeysProvider({ fetch: fetchImpl })
    const signal = new AbortController().signal
    expect(await provider.resolve(mappedTrack(), signal)).toMatchObject({ url: expect.stringContaining(TICKET) })
    expect(await provider.resolve(mappedTrack(), signal)).toBeNull()
    expect(await provider.resolve(mappedTrack(), signal)).toMatchObject({ url: expect.stringContaining(nextTicket) })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it.each([
    [429, 'rate_limited'], [504, 'timeout'], [503, 'unavailable'], [502, 'invalid_response'],
  ] as const)('preserves the shared proxy error for status %s', async (status, code) => {
    const fetchImpl = vi.fn().mockResolvedValue(at(Response.json({ error: code }, { status })))
    const provider = createVkeysProvider({ fetch: fetchImpl })
    await expect(provider.resolve(mappedTrack(), new AbortController().signal)).rejects.toMatchObject({ code })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('preserves a transient network failure without retrying', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('network unavailable'))
    const provider = createVkeysProvider({ fetch: fetchImpl })
    await expect(provider.resolve(mappedTrack(), new AbortController().signal)).rejects.toMatchObject({
      code: 'unavailable', transient: true,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    'https://untrusted.example/audio.mp3',
    '/api/providers/vkeys/media/another-song/' + TICKET,
    '/api/providers/vkeys/media/canonical-song/short',
    '/api/providers/vkeys/media/canonical-song/' + TICKET + '?url=untrusted',
    '/api/providers/gd-studio/media/canonical-song/' + TICKET,
  ])('rejects an unsafe or mismatched media ticket: %s', async (url) => {
    const fetchImpl = vi.fn().mockResolvedValue(at(Response.json({ url, mimeType: 'audio/mpeg' })))
    const provider = createVkeysProvider({ fetch: fetchImpl })
    await expect(provider.resolve(mappedTrack(), new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it.each([
    ['null body', () => at(Response.json(null))],
    ['invalid JSON', () => at(new Response('{', { headers: { 'content-type': 'application/json' } }))],
    ['wrong response origin', () => at(Response.json({}), 'https://other.example/api/providers/vkeys/resolve')],
  ] as const)('rejects %s', async (_case, response) => {
    const provider = createVkeysProvider({ fetch: vi.fn().mockResolvedValue(response()) })
    await expect(provider.resolve(mappedTrack(), new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('preserves a pre-aborted signal without making a request', async () => {
    const fetchImpl = vi.fn()
    const provider = createVkeysProvider({ fetch: fetchImpl })
    const controller = new AbortController()
    const reason = new DOMException('cancelled', 'AbortError')
    controller.abort(reason)
    await expect(provider.resolve(mappedTrack(), controller.signal)).rejects.toBe(reason)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('passes cancellation through to an in-flight proxy request', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const provider = createVkeysProvider({ fetch: fetchImpl })
    const controller = new AbortController()
    const pending = provider.resolve(mappedTrack(), controller.signal)
    const reason = new DOMException('cancelled', 'AbortError')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe('Vkeys prepared expiry propagation', () => {
  it('returns the server epoch-millisecond expiry without recomputing a new lifetime', async () => {
    const expiresAt = Date.now() + 30_000
    const response = playableResponse()
    const body = await response.json()
    const provider = createVkeysProvider({ fetch: vi.fn().mockResolvedValue(at(Response.json({ ...body, expiresAt }))) })
    expect(await provider.resolve(mappedTrack(), new AbortController().signal)).toMatchObject({ kind: 'audio', expiresAt })
  })

  it.each([null, '1800000030000', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects malformed optional expiry %j', async expiresAt => {
    const body = await playableResponse().json()
    const provider = createVkeysProvider({ fetch: vi.fn().mockResolvedValue(at(Response.json({ ...body, expiresAt }))) })
    await expect(provider.resolve(mappedTrack(), new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('does not attach a stale response expiry to a different concurrent resolution', async () => {
    const expiries = { first: Date.now() + 30_000, second: Date.now() + 90_000 }
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const id = JSON.parse(String(init?.body)).externalId as keyof typeof expiries
      if (id === 'first') await new Promise(resolve => setTimeout(resolve, 5))
      const body = await playableResponse(id).json()
      return at(Response.json({ ...body, expiresAt: expiries[id] }))
    })
    const provider = createVkeysProvider({ fetch: fetchImpl })
    const resolve = (id: keyof typeof expiries) => provider.resolve(track([{ provider: 'vkeys', externalId: id }], id), new AbortController().signal)
    const [first, second] = await Promise.all([resolve('first'), resolve('second')])
    expect(first).toMatchObject({ expiresAt: expiries.first })
    expect(second).toMatchObject({ expiresAt: expiries.second })
  })
})


describe('expiry opt-in preserves legacy proxy semantics', () => {
  it.each([undefined, false])('keeps expiry out of providers without opt-in (%s)', async includeExpiry => {
    const body = await playableResponse().json()
    const proxy = createServerProxyProvider('vkeys', 'vkeys', {
      fetch: vi.fn().mockResolvedValue(at(Response.json({ ...body, expiresAt: 'legacy-ignored-value' }))),
      ...(includeExpiry === undefined ? {} : { includeExpiry }),
    })
    const result = await proxy.resolve(track([{ provider: 'vkeys', externalId: 'canonical-song' }]), new AbortController().signal)
    expect(result).toEqual({ kind: 'audio', url: ORIGIN + body.url, mimeType: 'audio/mpeg' })
    expect(result).not.toHaveProperty('expiresAt')
  })
})
