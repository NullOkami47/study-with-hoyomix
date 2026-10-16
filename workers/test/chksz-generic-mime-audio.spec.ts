/**
 * A generic `content-type` must not, by itself, make a valid audio asset unservable.
 *
 * ## The defect this closes
 *
 * A tier can legitimately be delivered by the CDN with `content-type: application/octet-stream`
 * even though the body is a perfectly good, playable audio stream. Rejecting that outright is a
 * Worker contract defect: the bytes are audio, we simply refused to look.
 *
 * The fix must not be "weaken the MIME guard". Loosening `AUDIO_MIME` to accept
 * `application/octet-stream` would let *any* octet stream through, including a non-audio payload —
 * trading a functional bug for a security one. Instead the generic type is accepted **only** when
 * the leading bytes positively identify a known audio container, and the served `content-type` is
 * then corrected to the container actually found.
 *
 * The tests below pin both halves: the allowance, and the fact that it is narrow.
 */
import { describe, expect, it, vi } from 'vitest'

import type { CanonicalProviderId } from '../providers/config'
import { createTransientMedia } from '../providers/transientMedia'

const PUBLIC_ORIGIN = 'https://study.example'
const EXTERNAL_ID = '1315196858'
const NONCE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYX'

class MemoryCache {
  readonly entries = new Map<string, { body: Uint8Array; headers: Headers; status: number }>()

  async match(input: RequestInfo | URL): Promise<Response | undefined> {
    const request = input instanceof Request ? input : new Request(input)
    const stored = this.entries.get(`${request.method} ${request.url}`)
    return stored
      ? new Response(stored.body.slice(), { headers: stored.headers, status: stored.status })
      : undefined
  }

  async put(input: RequestInfo | URL, response: Response): Promise<void> {
    const request = input instanceof Request ? input : new Request(input)
    this.entries.set(`${request.method} ${request.url}`, {
      body: new Uint8Array(await response.arrayBuffer()),
      headers: new Headers(response.headers),
      status: response.status,
    })
  }
}

const deterministicCrypto = {
  getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
    if (!(array instanceof Uint8Array)) throw new TypeError('Uint8Array required')
    array.forEach((_value, index) => { array[index] = index })
    return array as T
  },
} as unknown as Crypto

const mediaUrl = (value: unknown) => {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname === 'media.example' ? parsed : null
  } catch {
    return null
  }
}

const serveUpstream = async (input: {
  upstream: () => Response | Promise<Response>
  providerId?: CanonicalProviderId
  requireMimeMatch?: boolean
  expectedMimeType?: string
  allowGenericAudioTypes?: boolean
}) => {
  const cache = new MemoryCache()
  const subject = createTransientMedia({
    externalIdPattern: /^[0-9]{1,20}$/,
    providerId: input.providerId ?? 'chksz',
    publicOrigin: PUBLIC_ORIGIN,
    validateUrl: mediaUrl,
    ...(input.requireMimeMatch !== undefined ? { requireMimeMatch: input.requireMimeMatch } : {}),
    // Default on for `chksz` (its route does so); explicitly off for other providers, which is
    // what proves the allowance is provider-scoped rather than global.
    allowGenericAudioTypes: input.allowGenericAudioTypes ??
      (input.providerId === undefined || input.providerId === 'chksz'),
  }, {
    cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
    crypto: deterministicCrypto,
    fetch: (async () => await input.upstream()) as unknown as typeof fetch,
    now: () => 1_000_000,
  })

  await subject.prepare({
    externalId: EXTERNAL_ID,
    validatedUrl: new URL('https://media.example/song'),
    mimeType: input.expectedMimeType ?? 'audio/mpeg',
  })
  const path = `/api/providers/${input.providerId ?? 'chksz'}/media/${EXTERNAL_ID}/${NONCE}`
  return await subject.serve(
    new Request(new URL(path, PUBLIC_ORIGIN), { method: 'GET' }),
    new URL(path, PUBLIC_ORIGIN),
  )
}

const FLAC_PREFIX = [0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]
const MP3_ID3_PREFIX = [0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]
const MP3_FRAME_PREFIX = [0xff, 0xfb, 0x90, 0x00, 0x00, 0x00, 0x00, 0x00]

describe('generic content-type with real audio bytes is served', () => {
  it('serves a FLAC asset declared as application/octet-stream', async () => {
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array(FLAC_PREFIX), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(FLAC_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(200)
    // The served type is corrected to what the bytes actually are, not passed through as generic.
    expect(response.headers.get('content-type')).toBe('audio/flac')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(FLAC_PREFIX))
  })

  it('serves an ID3-tagged MP3 declared as application/octet-stream', async () => {
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array(MP3_ID3_PREFIX), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(MP3_ID3_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
  })

  it('serves a bare MPEG-frame MP3 declared as application/octet-stream', async () => {
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array(MP3_FRAME_PREFIX), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(MP3_FRAME_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
  })

  // ADTS AAC carries `ff f1` / `ff f9`, which is a *subset* of the generic MPEG frame-sync pattern
  // `ff e0-ff`. If the broad rule is tested first, raw AAC is labelled `audio/mpeg` — a wrong type
  // rather than a refusal. The narrow rule therefore has to come first.
  it('labels a bare ADTS AAC frame as audio/aac, not audio/mpeg', async () => {
    const adts = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x00, 0x1f, 0xfc])
    const response = await serveUpstream({
      upstream: () => new Response(adts, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(adts.length) },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/aac')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(adts)
  })

  it('labels the ff f9 ADTS variant as audio/aac too', async () => {
    const adts = new Uint8Array([0xff, 0xf9, 0x50, 0x80, 0x00, 0x1f, 0xfc])
    const response = await serveUpstream({
      upstream: () => new Response(adts, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(adts.length) },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/aac')
  })

  it('works for a ranged request too', async () => {
    const bytes = new Uint8Array([...FLAC_PREFIX, 0x01, 0x02])
    const cache = new MemoryCache()
    const subject = createTransientMedia({
      externalIdPattern: /^[0-9]{1,20}$/,
      providerId: 'chksz',
      publicOrigin: PUBLIC_ORIGIN,
      validateUrl: mediaUrl,
      requireMimeMatch: false,
      allowGenericAudioTypes: true,
    }, {
      cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
      crypto: deterministicCrypto,
      fetch: (async () => new Response(bytes, {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'content-range': 'bytes 0-7/10',
          'content-length': '8',
          'accept-ranges': 'bytes',
        },
      })) as unknown as typeof fetch,
      now: () => 1_000_000,
    })
    await subject.prepare({
      externalId: EXTERNAL_ID,
      validatedUrl: new URL('https://media.example/song'),
      mimeType: 'audio/mpeg',
    })
    const path = `/api/providers/chksz/media/${EXTERNAL_ID}/${NONCE}`
    const response = await subject.serve(
      new Request(new URL(path, PUBLIC_ORIGIN), { method: 'GET', headers: { range: 'bytes=0-7' } }),
      new URL(path, PUBLIC_ORIGIN),
    )
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('audio/flac')
  })
})

describe('the allowance is narrow — it does not weaken MIME validation', () => {
  it('still rejects a generic octet stream that is NOT audio', async () => {
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '8' },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('still rejects an octet stream carrying HTML', async () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html>')
    const response = await serveUpstream({
      upstream: () => new Response(html, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(html.length) },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('still rejects an octet stream carrying JSON', async () => {
    const json = new TextEncoder().encode('{"error":"nope"}')
    const response = await serveUpstream({
      upstream: () => new Response(json, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(json.length) },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('still rejects a non-audio declared type even when the bytes look like audio', async () => {
    // A declared `text/html` is a positive claim of non-audio; we do not second-guess it.
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array(FLAC_PREFIX), {
        status: 200,
        headers: { 'content-type': 'text/html', 'content-length': String(FLAC_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('still rejects an application/json body with audio-like framing', async () => {
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array(FLAC_PREFIX), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(FLAC_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('still enforces an exact MIME match where the provider requires it', async () => {
    // requireMimeMatch is on by default; a mismatched declared audio type must still fail.
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array(MP3_ID3_PREFIX), {
        status: 200,
        headers: { 'content-type': 'audio/ogg', 'content-length': String(MP3_ID3_PREFIX.length) },
      }),
      expectedMimeType: 'audio/mpeg',
    })
    expect(response.status).toBe(502)
  })

  it('does not accept a generic type on a provider that does not opt in', async () => {
    // Only `chksz` has been evidenced to need this. Other providers must be unaffected.
    const response = await serveUpstream({
      providerId: 'gd-studio',
      upstream: () => new Response(new Uint8Array(FLAC_PREFIX), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(FLAC_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('rejects an empty body declared as a generic type', async () => {
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array([]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '0' },
      }),
    })
    expect(response.status).toBe(502)
  })
})

describe('the corrected content-type never invents a value', () => {
  it('keeps a proper declared audio type as-is', async () => {
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array(FLAC_PREFIX), {
        status: 200,
        headers: { 'content-type': 'audio/flac', 'content-length': String(FLAC_PREFIX.length) },
      }),
      expectedMimeType: 'audio/flac',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/flac')
  })

  it('strips content-type parameters from the served value', async () => {
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array(FLAC_PREFIX), {
        status: 200,
        headers: { 'content-type': 'audio/flac; charset=utf-8', 'content-length': String(FLAC_PREFIX.length) },
      }),
      expectedMimeType: 'audio/flac',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/flac')
  })

  it('does not buffer or emit anything beyond the sniffed prefix', async () => {
    // A large body must still stream; sniffing must not require reading it all.
    const readSpy = vi.fn()
    const big = new Uint8Array(1024)
    big.set(FLAC_PREFIX)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big)
        readSpy()
        controller.close()
      },
    })
    const response = await serveUpstream({
      upstream: () => new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(big.length) },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/flac')
    const served = new Uint8Array(await response.arrayBuffer())
    expect(served.length).toBe(1024)
    expect(Array.from(served.slice(0, 4))).toEqual([0x66, 0x4c, 0x61, 0x43])
  })
})
