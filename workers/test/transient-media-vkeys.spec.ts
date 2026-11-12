import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransientMedia } from '../providers/transientMedia'
import type { PreparedMediaInput, TransientMediaOptions } from '../providers/transientMedia'

const ORIGIN = 'https://study.example'
const MEDIA_URL = 'https://media.example/song.mp3?resource=one'
const FORM_MIME = 'application/x-www-form-urlencoded'
const MP3 = new Uint8Array(834)
MP3.set([0xff, 0xfb, 0x90, 0x64])
MP3.set([0xff, 0xfb, 0x90, 0x64], 417)
const TAGGED_MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, ...MP3])
const PREFIX = new Uint8Array(4096)
PREFIX.set(MP3)
const MIDDLE = new Uint8Array([1, 2, 3, 4])

const trackedResponse = (
  bytes: Uint8Array,
  status = 200,
  headers: HeadersInit = {},
) => {
  const cancel = vi.fn()
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(bytes) },
    cancel,
  }, { highWaterMark: 0 }), {
    status,
    headers: { 'content-type': FORM_MIME, etag: '"representation-one"', ...Object.fromEntries(new Headers(headers)) },
  })
  return { response, cancel }
}

const seekResponse = () => trackedResponse(MIDDLE, 206, {
  'content-range': 'bytes 4096-4099/4100',
  'content-length': '4',
})
const prefixResponse = () => trackedResponse(PREFIX, 206, {
  'content-range': 'bytes 0-4095/4100',
  'content-length': '4096',
})

const setup = (overrides: Partial<TransientMediaOptions> = {}) => {
  let now = 1_000
  let stored: { body: string; headers: Headers; key: string } | undefined
  const cache = {
    match: vi.fn(async (request: Request) => stored?.key === request.url
      ? new Response(stored.body, { headers: stored.headers }) : undefined),
    put: vi.fn(async (request: Request, response: Response) => {
      stored = { body: await response.text(), headers: new Headers(response.headers), key: request.url }
    }),
  }
  const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected upstream fetch'))
  const validateUrl = vi.fn((value: unknown, current?: URL) => {
    if (typeof value !== 'string') return null
    try {
      const url = new URL(value, current)
      return url.protocol === 'https:' && url.hostname === 'media.example'
        && !url.username && !url.password && !url.port && !url.hash ? url : null
    } catch { return null }
  })
  const subject = createTransientMedia({
    providerId: 'vkeys', publicOrigin: ORIGIN, externalIdPattern: /^[0-9]+$/,
    validateUrl, allowFormEncodedAudio: true, ...overrides,
  }, {
    cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(1) } as unknown as Crypto,
    fetch: fetchImpl, now: () => now,
  })
  const prepare = (input: Partial<PreparedMediaInput> = {}) => subject.prepare({
    externalId: '123', mimeType: 'audio/mpeg', validatedUrl: new URL(MEDIA_URL), ...input,
  })
  const serve = async (init: RequestInit = {}) => {
    if (!stored) throw new Error('Prepare a ticket first')
    const request = new Request(stored.key, init)
    return subject.serve(request, new URL(request.url))
  }
  return {
    cache, fetchImpl, validateUrl, prepare, serve,
    setNow: (value: number) => { now = value },
    stored: () => stored!,
  }
}

afterEach(() => vi.useRealTimers())

describe('transient media: upstream expiry', () => {
  it.each([
    [undefined, 121_000, 'max-age=120'],
    [81_000, 51_000, 'max-age=50'],
    [181_000, 121_000, 'max-age=120'],
    [31_500, 1_500, 'max-age=0'],
  ])('caps the ticket for upstream expiry %s', async (expiresAt, expected, cacheControl) => {
    const subject = setup()
    expect(await subject.prepare({ expiresAt })).not.toBeNull()
    expect(JSON.parse(subject.stored().body).expiresAt).toBe(expected)
    expect(subject.stored().headers.get('cache-control')).toBe(cacheControl)
    expect(subject.fetchImpl).not.toHaveBeenCalled()
  })

  it.each([0, 1_000, 30_999, 31_000, NaN, Infinity, -Infinity, 81_000.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unusable upstream expiry %s before caching', async expiresAt => {
      const subject = setup()
      expect(await subject.prepare({ expiresAt })).toBeNull()
      expect(subject.cache.put).not.toHaveBeenCalled()
      expect(subject.fetchImpl).not.toHaveBeenCalled()
    },
  )

  it.each([51_000, 81_000])('never fetches a stale URL at %s even if cache retains the ticket', async now => {
    const subject = setup()
    await subject.prepare({ expiresAt: 81_000 })
    subject.setNow(now)
    const response = await subject.serve()
    expect(response.status).toBe(410)
    expect(await response.json()).toEqual({ error: 'preparation_expired' })
    expect(subject.fetchImpl).not.toHaveBeenCalled()
  })

  it('preserves the default 120-second expiry', async () => {
    const subject = setup()
    await subject.prepare()
    subject.setNow(121_000)
    expect((await subject.serve()).status).toBe(410)
    expect(subject.fetchImpl).not.toHaveBeenCalled()
  })
})

describe('transient media: Vkeys form MIME opt-in', () => {
  it.each([
    { allowFormEncodedAudio: undefined },
    { allowFormEncodedAudio: false },
    { allowFormEncodedAudio: false, allowGenericAudioTypes: true, requireMimeMatch: false },
  ])('does not enable form MIME through other allowances: %j', async options => {
    const subject = setup(options)
    const upstream = trackedResponse(MP3)
    subject.fetchImpl.mockResolvedValueOnce(upstream.response)
    await subject.prepare()
    expect((await subject.serve()).status).toBe(502)
    expect(upstream.cancel).toHaveBeenCalledOnce()
  })

  it.each([MP3, TAGGED_MP3])('serves verified full MP3 bytes without losing the prefix', async bytes => {
    const subject = setup()
    subject.fetchImpl.mockResolvedValueOnce(new Response(bytes, {
      headers: { 'content-type': FORM_MIME, 'content-length': String(bytes.length) },
    }))
    await subject.prepare()
    const response = await subject.serve()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(subject.fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    ['HTML', new TextEncoder().encode('<html>denied</html>')],
    ['form', new TextEncoder().encode('song=123&error=denied')],
    ['ID3 form field', new TextEncoder().encode('ID3=not-an-mp3')],
    ['random bytes', new Uint8Array([1, 2, 3, 4, 5])],
    ['invalid MPEG sync', new Uint8Array([0xff, 0xff, 0xff, 0xff])],
    ['truncated ID3', new Uint8Array([0x49, 0x44, 0x33])],
    ['ID3 without audio', TAGGED_MP3.subarray(0, 10)],
    ['ID3 followed by AAC', new Uint8Array([...TAGGED_MP3.subarray(0, 10), 0xff, 0xf1, 0x50, 0x80])],
    ['ID3 followed by FLAC', new Uint8Array([...TAGGED_MP3.subarray(0, 10), ...new TextEncoder().encode('fLaC0000')])],
    ['MPEG layer II', new Uint8Array([0xff, 0xfd, 0x90, 0x64])],
    ['ADTS AAC', new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0, 0])],
    ['CRC ADTS AAC', new Uint8Array([0xff, 0xf0, 0x50, 0x80, 0, 0, 0])],
    ['FLAC', new TextEncoder().encode('fLaC0000')],
    ['Ogg', new TextEncoder().encode('OggS0000')],
    ['WAV', new TextEncoder().encode('RIFF0000WAVE')],
    ['M4A', new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])],
    ['APE', new TextEncoder().encode('MAC 0000')],
    ['WMA', new TextEncoder().encode('wmap0000')],
  ])('rejects %s even with both MIME allowances', async (_label, bytes) => {
    const subject = setup({ allowGenericAudioTypes: true })
    const upstream = trackedResponse(bytes as Uint8Array)
    subject.fetchImpl.mockResolvedValueOnce(upstream.response)
    await subject.prepare()
    expect((await subject.serve()).status).toBe(502)
    expect(upstream.cancel).toHaveBeenCalledOnce()
  })

  it.each(['text/html', 'text/plain', 'application/x-www-form-urlencoded-extra', 'application/octet-stream'])(
    'does not widen other MIME types: %s', async mime => {
      const subject = setup()
      const upstream = trackedResponse(MP3, 200, { 'content-type': mime })
      subject.fetchImpl.mockResolvedValueOnce(upstream.response)
      await subject.prepare()
      expect((await subject.serve()).status).toBe(502)
      expect(upstream.cancel).toHaveBeenCalledOnce()
    },
  )

  it('preserves the strict declared audio MIME match', async () => {
    const subject = setup()
    subject.fetchImpl.mockResolvedValueOnce(new Response(MP3, { headers: { 'content-type': 'audio/flac' } }))
    await subject.prepare()
    expect((await subject.serve()).status).toBe(502)
  })

  it('passes client cancellation through the replayed MP3 prefix', async () => {
    const subject = setup()
    const upstream = trackedResponse(MP3)
    subject.fetchImpl.mockResolvedValueOnce(upstream.response)
    await subject.prepare()
    const response = await subject.serve()
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    expect((await reader.read()).value).toEqual(MP3)
    await reader.cancel()
    expect(upstream.cancel).toHaveBeenCalledOnce()
  })
})

describe('transient media: independently verified seek ranges', () => {
  it.each(['bytes=4096-4099', 'bytes=4096-', 'bytes=-4'])(
    'verifies the same URL prefix before serving %s', async range => {
      const subject = setup({ getUpstreamHeaders: () => ({ referer: 'https://player.example/', 'user-agent': 'media-test' }) })
      const actual = seekResponse()
      const prefix = prefixResponse()
      subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix.response)
      await subject.prepare()
      const response = await subject.serve({ headers: { range, cookie: 'browser-only', authorization: 'browser-only' } })
      expect(response.status).toBe(206)
      expect(response.headers.get('content-type')).toBe('audio/mpeg')
      expect(response.headers.get('content-range')).toBe('bytes 4096-4099/4100')
      expect(response.headers.get('content-length')).toBe('4')
      const reader = response.body!.getReader()
      expect((await reader.read()).value).toEqual(MIDDLE)
      await reader.cancel()
      expect(actual.cancel).toHaveBeenCalledOnce()
      expect(prefix.cancel).toHaveBeenCalledOnce()
      expect(subject.fetchImpl).toHaveBeenCalledTimes(2)
      for (const [index, [url, init]] of subject.fetchImpl.mock.calls.entries()) {
        expect(String(url)).toBe(MEDIA_URL)
        expect(init?.redirect).toBe('manual')
        expect(init?.method).toBe('GET')
        expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
          range: index === 0 ? range : 'bytes=0-4095',
          ...(index === 0 ? {} : { 'if-match': '"representation-one"' }),
          referer: 'https://player.example/', 'user-agent': 'media-test',
        })
      }
      expect(subject.validateUrl.mock.calls.filter(([url]) => url === MEDIA_URL).length).toBeGreaterThanOrEqual(3)
    },
  )

  it.each([
    [206, 'bytes=0-833', 'bytes 0-833/834'],
    [206, 'bytes=-9999', 'bytes 0-833/834'],
    [200, 'bytes=4096-', null],
  ])('sniffs responses that actually start at zero (%s, %s)', async (status, range, contentRange) => {
    const subject = setup()
    const headers = new Headers({ 'content-type': FORM_MIME, 'content-length': '834' })
    if (contentRange) headers.set('content-range', contentRange)
    subject.fetchImpl.mockResolvedValueOnce(new Response(MP3, { status, headers }))
    await subject.prepare()
    const response = await subject.serve({ headers: { range } })
    expect(response.status).toBe(status)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3)
    expect(subject.fetchImpl).toHaveBeenCalledOnce()
  })

  it('verifies HEAD through a bounded GET and releases both responses', async () => {
    const subject = setup()
    const actual = seekResponse()
    const prefix = prefixResponse()
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix.response)
    await subject.prepare()
    const response = await subject.serve({ method: 'HEAD', headers: { range: 'bytes=4096-' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(await response.text()).toBe('')
    expect(subject.fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['HEAD', 'GET'])
    expect(actual.cancel).toHaveBeenCalledOnce()
    expect(prefix.cancel).toHaveBeenCalledOnce()
  })

  it.each([
    ['wrong start', 206, { 'content-range': 'bytes 1-4096/4100', 'content-length': '4096' }],
    ['wrong end', 206, { 'content-range': 'bytes 0-8191/9000', 'content-length': '8192' }],
    ['missing range', 206, {}],
    ['wrong length', 206, { 'content-range': 'bytes 0-4095/4100', 'content-length': '4' }],
    ['range on 200', 200, { 'content-range': 'bytes 0-4095/4100' }],
    ['cross-host redirect', 302, { location: 'https://other.example/song.mp3' }],
    ['same-host redirect', 302, { location: '/different.mp3' }],
    ['upstream error', 403, {}],
  ] as const)('fails closed on prefix %s and cancels both bodies', async (_label, status, headers) => {
    const subject = setup()
    const actual = seekResponse()
    const prefix = trackedResponse(PREFIX, status, headers)
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix.response)
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(subject.fetchImpl).toHaveBeenCalledTimes(2)
    expect(actual.cancel).toHaveBeenCalledOnce()
    expect(prefix.cancel).toHaveBeenCalledOnce()
  })

  it('accepts a prefix server ignoring Range without reading the full body', async () => {
    const subject = setup()
    const actual = seekResponse()
    const prefix = trackedResponse(PREFIX, 200, { 'content-length': '4100' })
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix.response)
    await subject.prepare()
    const response = await subject.serve({ headers: { range: 'bytes=4096-' } })
    expect(response.status).toBe(206)
    expect(prefix.cancel).toHaveBeenCalledOnce()
    await response.body!.cancel()
  })

  it('does not trust an audio/mpeg prefix declaration without MP3 bytes', async () => {
    const subject = setup()
    const actual = seekResponse()
    const prefix = trackedResponse(new TextEncoder().encode('<html>denied</html>'), 200, { 'content-type': 'audio/mpeg' })
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix.response)
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(prefix.cancel).toHaveBeenCalledOnce()
    expect(actual.cancel).toHaveBeenCalledOnce()
  })

  it('never follows a cross-host redirect on the actual range', async () => {
    const subject = setup()
    const redirect = trackedResponse(MP3, 302, { location: 'https://other.example/song.mp3' })
    subject.fetchImpl.mockResolvedValueOnce(redirect.response)
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(subject.fetchImpl).toHaveBeenCalledOnce()
    expect(redirect.cancel).toHaveBeenCalledOnce()
  })

  it('verifies the final validated URL after a permitted actual redirect', async () => {
    const subject = setup()
    const redirect = trackedResponse(MP3, 302, { location: '/other.mp3?resource=two' })
    const actual = seekResponse()
    const prefix = prefixResponse()
    subject.fetchImpl.mockResolvedValueOnce(redirect.response)
      .mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix.response)
    await subject.prepare()
    const response = await subject.serve({ headers: { range: 'bytes=4096-' } })
    expect(response.status).toBe(206)
    expect(subject.fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      MEDIA_URL, 'https://media.example/other.mp3?resource=two', 'https://media.example/other.mp3?resource=two',
    ])
    expect(redirect.cancel).toHaveBeenCalledOnce()
    expect(prefix.cancel).toHaveBeenCalledOnce()
    await response.body!.cancel()
  })

  it('rejects a wrong actual Content-Range before prefix verification', async () => {
    const subject = setup()
    const actual = trackedResponse(MIDDLE, 206, { 'content-range': 'bytes 4000-4003/4100' })
    subject.fetchImpl.mockResolvedValueOnce(actual.response)
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(subject.fetchImpl).toHaveBeenCalledOnce()
    expect(actual.cancel).toHaveBeenCalledOnce()
  })

  it('never reuses verification for a later response', async () => {
    const subject = setup()
    subject.fetchImpl.mockResolvedValueOnce(seekResponse().response).mockResolvedValueOnce(prefixResponse().response)
    await subject.prepare()
    const first = await subject.serve({ headers: { range: 'bytes=4096-' } })
    expect(first.status).toBe(206)
    await first.body!.cancel()
    const second = seekResponse()
    const invalid = trackedResponse(new TextEncoder().encode('error=expired'))
    subject.fetchImpl.mockResolvedValueOnce(second.response).mockResolvedValueOnce(invalid.response)
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(subject.fetchImpl).toHaveBeenCalledTimes(4)
    expect(second.cancel).toHaveBeenCalledOnce()
    expect(invalid.cancel).toHaveBeenCalledOnce()
  })

  it.each(['fetch', 'body'] as const)('bounds stalled prefix %s verification to five seconds', async stage => {
    vi.useFakeTimers()
    const subject = setup()
    const actual = seekResponse()
    const cancel = vi.fn()
    const prefix = new Response(new ReadableStream({ cancel }), { headers: { 'content-type': FORM_MIME, etag: '"representation-one"', 'content-length': '4100' } })
    subject.fetchImpl.mockResolvedValueOnce(actual.response)
    let release: ((response: Response) => void) | undefined
    if (stage === 'fetch') subject.fetchImpl.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    else subject.fetchImpl.mockResolvedValueOnce(prefix)
    await subject.prepare()
    const pending = subject.serve({ headers: { range: 'bytes=4096-' } })
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).status).toBe(502)
    expect(subject.fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)
    expect(actual.cancel).toHaveBeenCalledOnce()
    if (release) release(prefix)
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not serve a ticket that expires during prefix verification', async () => {
    const subject = setup()
    const actual = seekResponse()
    const prefix = prefixResponse()
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockImplementationOnce(async () => {
      subject.setNow(51_000)
      return prefix.response
    })
    await subject.prepare({ expiresAt: 81_000 })
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(410)
    expect(actual.cancel).toHaveBeenCalledOnce()
    expect(prefix.cancel).toHaveBeenCalledOnce()
  })
  it.each([false, true])('bounds a stalled form prefix read (range zero: %s)', async rangeZero => {
    vi.useFakeTimers()
    const subject = setup()
    const cancel = vi.fn()
    const headers = new Headers({ 'content-type': FORM_MIME })
    if (rangeZero) headers.set('content-range', 'bytes 0-833/834')
    subject.fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
      status: rangeZero ? 206 : 200, headers,
    }))
    await subject.prepare()
    let response: Response | undefined
    const pending = subject.serve(rangeZero ? { headers: { range: 'bytes=0-833' } } : {})
      .then(value => { response = value })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(response?.status).toBe(502)
    await pending
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks expiry again after awaiting upstream headers', async () => {
    const subject = setup({ getUpstreamHeaders: async () => {
      subject.setNow(51_000)
      return {}
    } })
    await subject.prepare({ expiresAt: 81_000 })
    expect((await subject.serve()).status).toBe(410)
    expect(subject.fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['HTML MIME', MP3, 'text/html'],
    ['FLAC form body', new TextEncoder().encode('fLaC0000'), FORM_MIME],
    ['empty body', new Uint8Array(), FORM_MIME],
  ])('rejects prefix %s without forwarding the actual range', async (_label, bytes, mime) => {
    const subject = setup()
    const actual = seekResponse()
    const prefix = trackedResponse(bytes as Uint8Array, 200, { 'content-type': mime as string })
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix.response)
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(actual.cancel).toHaveBeenCalledOnce()
    expect(prefix.cancel).toHaveBeenCalledOnce()
  })

  it('fails closed when the prefix URL no longer passes revalidation', async () => {
    const subject = setup()
    const actual = seekResponse()
    subject.fetchImpl.mockImplementationOnce(async () => {
      subject.validateUrl.mockReturnValueOnce(null)
      return actual.response
    })
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(subject.fetchImpl).toHaveBeenCalledOnce()
    expect(actual.cancel).toHaveBeenCalledOnce()
  })

  it('fails closed and clears its deadline when the prefix fetch rejects', async () => {
    vi.useFakeTimers()
    const subject = setup()
    const actual = seekResponse()
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockRejectedValueOnce(new Error('Upstream unavailable'))
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(actual.cancel).toHaveBeenCalledOnce()
    expect(subject.fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a prefix chunk exceeding the 4096-byte cap', async () => {
    const subject = setup()
    const actual = seekResponse()
    const oversized = new Uint8Array(4097)
    oversized.set(MP3)
    const prefix = trackedResponse(oversized)
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix.response)
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(actual.cancel).toHaveBeenCalledOnce()
    expect(prefix.cancel).toHaveBeenCalledOnce()
  })

  it('cancels a verified prefix without reading another chunk', async () => {
    const subject = setup()
    const actual = seekResponse()
    const pull = vi.fn()
    const cancel = vi.fn()
    const prefix = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(PREFIX) },
      pull,
      cancel,
    }, { highWaterMark: 0 }), { headers: { 'content-type': FORM_MIME, etag: '"representation-one"', 'content-length': '4100' } })
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix)
    await subject.prepare()
    const response = await subject.serve({ headers: { range: 'bytes=4096-' } })
    expect(response.status).toBe(206)
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    await response.body!.cancel()
  })

})

const chunkedMp3Response = (chunks: Uint8Array[], headers: HeadersInit = {}) => {
  const state = { reads: 0, bytes: 0, cancellations: [] as unknown[] }
  let index = 0
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      state.reads += 1
      const chunk = chunks[index++]
      if (chunk === undefined) controller.close()
      else { state.bytes += chunk.length; controller.enqueue(chunk) }
    },
    cancel(reason) { state.cancellations.push(reason) },
  }, { highWaterMark: 0 }), { headers: { 'content-type': FORM_MIME, ...Object.fromEntries(new Headers(headers)) } })
  return { response, state }
}
const id3Frame = (tagSize: number) => {
  const bytes = new Uint8Array(10 + tagSize + 4)
  bytes.set([0x49, 0x44, 0x33, 4, 0, 0, (tagSize >>> 21) & 127, (tagSize >>> 14) & 127, (tagSize >>> 7) & 127, tagSize & 127])
  bytes.set([0xff, 0xfb, 0x90, 0x64], 10 + tagSize)
  return bytes
}

describe('Vkeys shared-helper merge regressions', () => {
  it.each([undefined, 81_000, 181_000])('exposes exactly the stored expiry to opted-in clients (%s)', async expiresAt => {
    const subject = setup({ includeExpiry: true })
    const prepared = await subject.prepare({ expiresAt })
    expect(prepared).toHaveProperty('expiresAt', expiresAt === 81_000 ? 51_000 : 121_000)
    expect(prepared?.expiresAt).toBe(JSON.parse(subject.stored().body).expiresAt)
  })

  it.each([
    ['bare Layer III', new Uint8Array([0xff, 0xfb, 0x90, 0x64])],
    ['ID3 and Layer III', id3Frame(24)],
    ['maximum bounded ID3 and frame', id3Frame(4082)],
  ])('recognises chunked %s and replays the complete stream', async (_name, bytes) => {
    const subject = setup()
    const { response: upstream } = chunkedMp3Response([...bytes].map(byte => new Uint8Array([byte])))
    subject.fetchImpl.mockResolvedValueOnce(upstream)
    await subject.prepare()
    const response = await subject.serve()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(upstream.body!.locked).toBe(false)
  })

  it('does not fetch the unread tail after a split MP3 header and propagates client cancellation', async () => {
    const subject = setup()
    const { response: upstream, state } = chunkedMp3Response([
      new Uint8Array([0xff]), new Uint8Array([0xfb, 0x90, 0x64]),
      ...Array.from({ length: 64 }, () => new Uint8Array(16384)),
    ])
    subject.fetchImpl.mockResolvedValueOnce(upstream)
    await subject.prepare()
    const response = await subject.serve()
    expect(response.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.bytes).toBe(4)
    await response.body!.cancel('seek elsewhere')
    expect(state.cancellations).toEqual(['seek elsewhere'])
    expect(upstream.body!.locked).toBe(false)
  })

  it('rejects an ID3 frame outside the 4096-byte budget without reading its tail', async () => {
    const subject = setup()
    const bytes = id3Frame(4083)
    const { response, state } = chunkedMp3Response([bytes.subarray(0, 10), bytes.subarray(10, 4096), bytes.subarray(4096)])
    subject.fetchImpl.mockResolvedValueOnce(response)
    await subject.prepare()
    expect((await subject.serve()).status).toBe(502)
    expect(state.bytes).toBeLessThanOrEqual(4096)
    expect(state.cancellations).toHaveLength(1)
  })

  it('keeps one five-second deadline across chunked ID3 collection and hanging cancellation', async () => {
    vi.useFakeTimers()
    const subject = setup()
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    let reads = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        reads += 1
        if (reads === 1) controller.enqueue(id3Frame(24).subarray(0, 10))
        else await new Promise<void>(() => {})
      }, cancel,
    }, { highWaterMark: 0 })
    const upstream = new Response(stream, { headers: { 'content-type': FORM_MIME } })
    subject.fetchImpl.mockResolvedValueOnce(upstream)
    await subject.prepare()
    let response: Response | undefined
    const pending = subject.serve().then(value => { response = value })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(response).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(response?.status).toBe(502)
    expect(cancel).toHaveBeenCalledOnce()
    expect(upstream.body!.locked).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('verifies a chunked independent prefix without fetching its unneeded remainder', async () => {
    const subject = setup()
    const actual = seekResponse()
    const { response: prefix, state } = chunkedMp3Response([
      new Uint8Array([0xff]), new Uint8Array([0xfb, 0x90, 0x64]), new Uint8Array(4092),
    ], { etag: '"representation-one"', 'content-length': '4100' })
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix)
    await subject.prepare()
    const response = await subject.serve({ headers: { range: 'bytes=4096-' } })
    expect(response.status).toBe(206)
    expect(state.bytes).toBe(4)
    expect(state.cancellations).toHaveLength(1)
    expect(new Headers(subject.fetchImpl.mock.calls[1]?.[1]?.headers).get('if-match')).toBe('"representation-one"')
    await response.body!.cancel()
  })
})

describe('Vkeys prefix representation binding', () => {
  it.each([
    ['different strong ETag', '"different"', '4100'],
    ['weak ETag', 'W/"representation-one"', '4100'],
    ['missing ETag', null, '4100'],
    ['different total', '"representation-one"', '9000'],
    ['unknown total', '"representation-one"', '*'],
  ])('rejects %s instead of labelling unrelated HTML as MP3', async (_name, etag, total) => {
    const subject = setup()
    const html = new TextEncoder().encode('<html>expired</html>')
    const end = 4096 + html.length - 1
    const actual = trackedResponse(html, 206, { 'content-range': 'bytes 4096-' + end + '/4100' })
    // Use a total large enough for the HTML fragment, independently of the prefix total.
    actual.response.headers.set('content-range', 'bytes 4096-' + end + '/5000')
    const prefix = trackedResponse(PREFIX, 206, { 'content-range': 'bytes 0-4095/' + (total === '4100' ? '5000' : total), 'content-length': '4096' })
    if (etag === null) prefix.response.headers.delete('etag')
    else prefix.response.headers.set('etag', etag)
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix.response)
    await subject.prepare()
    const response = await subject.serve({ headers: { range: 'bytes=4096-' + end } })
    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(actual.cancel).toHaveBeenCalledOnce()
    expect(prefix.cancel).toHaveBeenCalledOnce()
  })

  it.each([null, 'W/"representation-one"', 'unquoted', '"one", "two"'])('requires a single strong actual ETag before prefix fetch: %s', async etag => {
    const subject = setup()
    const actual = seekResponse()
    if (etag === null) actual.response.headers.delete('etag')
    else actual.response.headers.set('etag', etag)
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefixResponse().response)
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(subject.fetchImpl).toHaveBeenCalledOnce()
    expect(actual.cancel).toHaveBeenCalledOnce()
  })

  it('rejects a full prefix response whose length differs from the actual representation', async () => {
    const subject = setup()
    const actual = seekResponse()
    const prefix = trackedResponse(PREFIX, 200, { 'content-length': '9000' })
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefix.response)
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-' } })).status).toBe(502)
    expect(actual.cancel).toHaveBeenCalledOnce()
    expect(prefix.cancel).toHaveBeenCalledOnce()
  })
})


describe('Vkeys prefix deadline and representation edge cases', () => {
  it('shares the five-second budget between independent fetch and later header chunks', async () => {
    vi.useFakeTimers()
    const subject = setup()
    const actual = seekResponse()
    const prefixCancel = vi.fn()
    let reads = 0
    const prefix = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++reads === 1) controller.enqueue(new Uint8Array([0xff]))
        else return new Promise<void>(() => {})
      }, cancel: prefixCancel,
    }, { highWaterMark: 0 }), { headers: { 'content-type': FORM_MIME, etag: '"representation-one"', 'content-length': '4100' } })
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 3_000))
      return prefix
    })
    await subject.prepare()
    let response: Response | undefined
    const pending = subject.serve({ headers: { range: 'bytes=4096-' } }).then(value => { response = value })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(response).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(response?.status).toBe(502)
    expect(prefixCancel).toHaveBeenCalledOnce()
    expect(actual.cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects and releases a stream error during split MP3 collection', async () => {
    const subject = setup()
    let reads = 0
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++reads === 1) controller.enqueue(new Uint8Array([0xff]))
        else controller.error(new Error('split header unavailable'))
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': FORM_MIME } })
    subject.fetchImpl.mockResolvedValueOnce(upstream)
    await subject.prepare()
    expect((await subject.serve()).status).toBe(502)
    expect(upstream.body!.locked).toBe(false)
  })

  it('rejects ID3-tagged AAC even when the tag and frame arrive in separate chunks', async () => {
    const subject = setup()
    const { response, state } = chunkedMp3Response([
      TAGGED_MP3.subarray(0, 3), TAGGED_MP3.subarray(3, 10), new Uint8Array([0xff, 0xf1, 0x50, 0x80]),
    ])
    subject.fetchImpl.mockResolvedValueOnce(response)
    await subject.prepare()
    expect((await subject.serve()).status).toBe(502)
    expect(state.cancellations).toHaveLength(1)
  })

  it('does not accept a valid MPEG header beyond a fragmented form prefix', async () => {
    const subject = setup()
    const { response, state } = chunkedMp3Response([
      new TextEncoder().encode('so'), new TextEncoder().encode('ng='), MP3,
    ])
    subject.fetchImpl.mockResolvedValueOnce(response)
    await subject.prepare()
    expect((await subject.serve()).status).toBe(502)
    expect(state.bytes).toBe(5)
    expect(state.cancellations).toHaveLength(1)
  })

  it('requires a known actual total before independent prefix verification', async () => {
    const subject = setup()
    const actual = seekResponse()
    actual.response.headers.set('content-range', 'bytes 4096-4099/*')
    subject.fetchImpl.mockResolvedValueOnce(actual.response).mockResolvedValueOnce(prefixResponse().response)
    await subject.prepare()
    expect((await subject.serve({ headers: { range: 'bytes=4096-4099' } })).status).toBe(502)
    expect(subject.fetchImpl).toHaveBeenCalledOnce()
    expect(actual.cancel).toHaveBeenCalledOnce()
  })

  it('rejects an unversioned full HEAD response before fetching a prefix', async () => {
    const subject = setup()
    subject.fetchImpl.mockResolvedValueOnce(new Response(null, { headers: { 'content-type': FORM_MIME, 'content-length': '4100' } }))
    await subject.prepare()
    const response = await subject.serve({ method: 'HEAD' })
    expect(response.status).toBe(502)
    expect(await response.text()).toBe('')
    expect(subject.fetchImpl).toHaveBeenCalledOnce()
  })

  it('serves a full HEAD only after checking the same ETag and total on the prefix', async () => {
    const subject = setup()
    const prefix = prefixResponse()
    subject.fetchImpl.mockResolvedValueOnce(new Response(null, { headers: { 'content-type': FORM_MIME, etag: '"representation-one"', 'content-length': '4100' } }))
      .mockResolvedValueOnce(prefix.response)
    await subject.prepare()
    const response = await subject.serve({ method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(response.headers.get('content-length')).toBe('4100')
    expect(prefix.cancel).toHaveBeenCalledOnce()
  })
})
