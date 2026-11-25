import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransientMedia } from '../providers/transientMedia'

const origin = 'https://study.example'
const upstreamUrl = 'https://media.example/song.flac?token=PRIVATE_TOKEN'
const header = 'x-hoyomix-media-failure'
const epoch = 1_800_000_000_000
const audio = () => new Response(new Uint8Array([102, 76, 97, 67, 0, 0, 0, 0]), {
  headers: { 'content-type': 'audio/flac', 'content-length': '8', [header]: upstreamUrl },
})

async function fixture() {
  let now = epoch
  let enabled = true
  const entries = new Map<string, Response>()
  const fetch = vi.fn(async () => audio())
  const cache = {
    match: async (request: Request) => entries.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => { entries.set(request.url, response.clone()) },
  }
  const media = createTransientMedia({
    providerId: 'gd-studio', publicOrigin: origin, externalIdPattern: /^track$/,
    isEffective: async () => enabled, reconcileMislabelledAudioTypes: true,
    validateUrl: value => {
      if (typeof value !== 'string') return null
      try {
        const url = new URL(value)
        return url.protocol === 'https:' && url.hostname === 'media.example' ? url : null
      } catch { return null }
    },
  }, { cache, fetch, now: () => now, crypto: globalThis.crypto })
  const prepared = await media.prepare({ externalId: 'track', validatedUrl: new URL(upstreamUrl), mimeType: 'audio/flac' })
  if (!prepared) throw new Error('fixture preparation failed')
  const url = new URL(prepared.url, origin)
  return {
    entries, fetch, cache, url, setAge: (age: number) => { now = epoch + age },
    disable: () => { enabled = false },
    serve: (method = 'GET', headers: HeadersInit = {}) => media.serve(new Request(url, { method, headers }), url),
  }
}

async function expectFailure(response: Response, status: number, error: string | null, reason: string, nonce: string) {
  expect(response.status).toBe(status)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-type')).toBe('application/json')
  expect(response.headers.get(header)).toBe(reason)
  if (error === null) expect(response.body).toBeNull()
  const body = await response.text()
  expect(body).toBe(error === null ? '' : JSON.stringify({ error }))
  const publicData = JSON.stringify([...response.headers]) + body
  for (const secret of [origin, upstreamUrl, 'PRIVATE_TOKEN', nonce]) expect(publicData).not.toContain(secret)
}

afterEach(() => vi.restoreAllMocks())

describe('transient media finite failure header', () => {
  it.each(['GET', 'HEAD'])('distinguishes an early cache miss from an elapsed deadline for %s', async method => {
    const missing = await fixture()
    missing.setAge(59_425)
    missing.entries.clear()
    await expectFailure(await missing.serve(method), 410, method === 'HEAD' ? null : 'preparation_expired', 'ticket-cache-miss', missing.url.pathname.split('/').at(-1)!)
    expect(missing.fetch).not.toHaveBeenCalled()

    const expired = await fixture()
    expired.setAge(120_000)
    await expectFailure(await expired.serve(method), 410, method === 'HEAD' ? null : 'preparation_expired', 'ticket-expired', expired.url.pathname.split('/').at(-1)!)
    expect(expired.fetch).not.toHaveBeenCalled()
  })

  it.each(['GET', 'HEAD'])('does not mark success or reflect an upstream diagnostic header for %s', async method => {
    const f = await fixture()
    f.setAge(119_999)
    const response = await f.serve(method)
    expect(response.status).toBe(200)
    expect(response.headers.get(header)).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect((await response.arrayBuffer()).byteLength).toBe(method === 'HEAD' ? 0 : 8)
  })

  it.each([401, 403, 404, 410, 416, 429, 500, 503])('classifies upstream status %s without changing the public 502 envelope', async status => {
    const f = await fixture()
    f.fetch.mockResolvedValue(new Response(upstreamUrl, { status, headers: { [header]: upstreamUrl } }))
    await expectFailure(await f.serve(), 502, 'invalid_response', 'upstream-status', f.url.pathname.split('/').at(-1)!)
  })

  it('keeps transport failures distinct and never logs private exception messages', async () => {
    const spies = ['log', 'warn', 'error'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}))
    const f = await fixture()
    f.fetch.mockRejectedValue(new Error(upstreamUrl))
    await expectFailure(await f.serve(), 502, 'unavailable', 'upstream-unavailable', f.url.pathname.split('/').at(-1)!)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('classifies a malformed upstream range before inspecting its bytes', async () => {
    const f = await fixture()
    f.fetch.mockResolvedValue(new Response(new Uint8Array(4), {
      status: 206, headers: { 'content-type': 'audio/flac', 'content-range': 'bytes 0-3/8', 'content-length': '4' },
    }))
    await expectFailure(await f.serve('GET', { range: 'bytes=4-' }), 502, 'invalid_response', 'range-contract-rejected', f.url.pathname.split('/').at(-1)!)
  })

  it('classifies a malformed client Range while preserving the 400 error envelope', async () => {
    const f = await fixture()
    await expectFailure(await f.serve('GET', { range: 'bytes=0-1,4-5' }), 400, 'invalid_response', 'range-contract-rejected', f.url.pathname.split('/').at(-1)!)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('classifies an invalid Content-Length independently of MIME', async () => {
    const f = await fixture()
    f.fetch.mockResolvedValue(new Response('invalid', { headers: { 'content-type': 'audio/flac', 'content-length': '-1' } }))
    await expectFailure(await f.serve(), 502, 'invalid_response', 'content-length-rejected', f.url.pathname.split('/').at(-1)!)
  })

  it.each(['GET', 'HEAD'])('keeps rejecting unverifiable GD MIME on a nonzero Range or HEAD (%s)', async method => {
    const f = await fixture()
    f.fetch.mockResolvedValue(new Response(method === 'HEAD' ? null : new Uint8Array(4), {
      status: method === 'HEAD' ? 200 : 206,
      headers: { 'content-type': 'audio/mpeg', 'content-length': '4',
        ...(method === 'HEAD' ? {} : { 'content-range': 'bytes 4-7/8' }) },
    }))
    await expectFailure(await f.serve(method, method === 'HEAD' ? {} : { range: 'bytes=4-' }), 502, method === 'HEAD' ? null : 'invalid_response', 'mime-rejected', f.url.pathname.split('/').at(-1)!)
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })

  it('classifies non-audio payloads without reflecting MIME, body or supplied headers', async () => {
    const f = await fixture()
    f.fetch.mockResolvedValue(new Response(upstreamUrl, { headers: { 'content-type': 'text/html', [header]: upstreamUrl } }))
    await expectFailure(await f.serve(), 502, 'invalid_response', 'mime-rejected', f.url.pathname.split('/').at(-1)!)
  })

  it('reports elapsed expiry after awaiting upstream headers', async () => {
    const f = await fixture()
    f.fetch.mockImplementation(async () => { f.setAge(120_000); return audio() })
    await expectFailure(await f.serve(), 410, 'preparation_expired', 'ticket-expired', f.url.pathname.split('/').at(-1)!)
  })

  it('reports elapsed expiry after reading the MIME prefix', async () => {
    const f = await fixture()
    f.fetch.mockImplementation(async () => new Response(new ReadableStream({ pull(controller) {
      f.setAge(120_000)
      controller.enqueue(new Uint8Array([102, 76, 97, 67, 0, 0, 0, 0]))
      controller.close()
    } }, { highWaterMark: 0 }), { headers: { 'content-type': 'audio/mpeg' } }))
    await expectFailure(await f.serve(), 410, 'preparation_expired', 'ticket-expired', f.url.pathname.split('/').at(-1)!)
  })

  it('preserves provider-disable enforcement before cache lookup', async () => {
    const f = await fixture()
    f.disable()
    f.entries.clear()
    await expectFailure(await f.serve(), 503, 'unavailable', 'provider-unavailable', f.url.pathname.split('/').at(-1)!)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('keeps cache read errors separate from cache misses', async () => {
    const f = await fixture()
    vi.spyOn(f.cache, 'match').mockRejectedValue(new Error(upstreamUrl))
    await expectFailure(await f.serve(), 503, 'unavailable', 'ticket-cache-unavailable', f.url.pathname.split('/').at(-1)!)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('rejects corrupt cached tickets without releasing their contents', async () => {
    const f = await fixture()
    f.entries.set(f.url.href, Response.json({ url: upstreamUrl }))
    await expectFailure(await f.serve(), 502, 'invalid_response', 'ticket-invalid', f.url.pathname.split('/').at(-1)!)
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('rejects unsafe upstream redirects without reflecting Location', async () => {
    const f = await fixture()
    f.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://unsafe.example/?token=PRIVATE_TOKEN' } }))
    await expectFailure(await f.serve(), 502, 'invalid_response', 'upstream-redirect-rejected', f.url.pathname.split('/').at(-1)!)
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
})
