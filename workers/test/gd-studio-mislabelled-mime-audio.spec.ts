/**
 * A *concrete but wrong* `content-type` must not make a valid audio asset unservable.
 *
 * ## The defect this closes
 *
 * GD Studio lossless / Hi-Res metadata returns a `.flac` media path, so the Worker prepares a
 * ticket whose expected type is `audio/flac`. The upstream body is genuine FLAC (`fLaC` magic),
 * but the CDN labels the HTTP response `audio/mpeg; charset=UTF-8`. The default strict MIME guard
 * (`requireMimeMatch`) then rejects the response — expected `audio/flac` ≠ declared `audio/mpeg` —
 * and the media route returns `502 {"error":"invalid_response"}` instead of playable audio. The
 * player sees `errorCode=4 / Format error`, 0 s, and auto-skips.
 *
 * This is distinct from the ChKSz generic-type case (`application/octet-stream`): there the
 * upstream declares *no* useful type, here it declares a *wrong* audio type. Both are resolved the
 * same safe way — identify the container from the leading bytes and serve its real type — but each
 * provider opts into exactly the allowance it has been evidenced to need.
 *
 * The fix must not be "turn off `requireMimeMatch`" or "trust the declared/expected label without
 * looking at the bytes". The tests below pin the allowance *and* that it stays narrow: the served
 * type is whatever the bytes prove the container to be, and anything the bytes do not positively
 * confirm as a known audio container is still refused.
 */
import { describe, expect, it } from 'vitest'

import type { CanonicalProviderId } from '../providers/config'
import { createTransientMedia } from '../providers/transientMedia'

const PUBLIC_ORIGIN = 'https://study.example'
const EXTERNAL_ID = 'netease:2756018749:999'
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

/**
 * Mirrors the GD Studio route configuration: strict `requireMimeMatch` (default), no generic-type
 * allowance, and `reconcileMislabelledAudioTypes` opted in. `providerId` / flags are overridable so
 * the tests can also prove the allowance is provider-scoped.
 */
const serveUpstream = async (input: {
  upstream: () => Response | Promise<Response>
  providerId?: CanonicalProviderId
  requireMimeMatch?: boolean
  expectedMimeType?: string
  allowGenericAudioTypes?: boolean
  reconcileMislabelledAudioTypes?: boolean
  range?: string
  method?: 'GET' | 'HEAD'
}) => {
  const cache = new MemoryCache()
  const providerId = input.providerId ?? 'gd-studio'
  const subject = createTransientMedia({
    externalIdPattern: /^netease:[0-9]+(?::(?:128|192|320|740|999))?$/,
    providerId,
    publicOrigin: PUBLIC_ORIGIN,
    validateUrl: mediaUrl,
    ...(input.requireMimeMatch !== undefined ? { requireMimeMatch: input.requireMimeMatch } : {}),
    ...(input.allowGenericAudioTypes !== undefined
      ? { allowGenericAudioTypes: input.allowGenericAudioTypes }
      : {}),
    // Default on for `gd-studio` (its route does so); overridable so a provider that does NOT opt
    // in can be shown to keep the strict reject.
    reconcileMislabelledAudioTypes: input.reconcileMislabelledAudioTypes ??
      (input.providerId === undefined || input.providerId === 'gd-studio'),
  }, {
    cache: cache as unknown as Pick<Cache, 'match' | 'put'>,
    crypto: deterministicCrypto,
    fetch: (async () => await input.upstream()) as unknown as typeof fetch,
    now: () => 1_000_000,
  })

  await subject.prepare({
    externalId: EXTERNAL_ID,
    validatedUrl: new URL('https://media.example/song.flac'),
    mimeType: input.expectedMimeType ?? 'audio/flac',
  })
  const path = `/api/providers/${providerId}/media/${encodeURIComponent(EXTERNAL_ID)}/${NONCE}`
  const headers: Record<string, string> = {}
  if (input.range !== undefined) headers.range = input.range
  return await subject.serve(
    new Request(new URL(path, PUBLIC_ORIGIN), { method: input.method ?? 'GET', headers }),
    new URL(path, PUBLIC_ORIGIN),
  )
}

// A real FLAC stream opens with the `fLaC` magic; this is the recorded GD Studio Hi-Res prefix.
const FLAC_PREFIX = [0x66, 0x4c, 0x61, 0x43, 0x00, 0x00, 0x00, 0x22]
const MP3_ID3_PREFIX = [0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]
const MISLABELLED_FLAC = 'audio/mpeg; charset=UTF-8'

describe('GD Studio: a mislabelled audio type is reconciled from the bytes', () => {
  it('serves a real FLAC body that the CDN labelled audio/mpeg (the reported bug)', async () => {
    const body = new Uint8Array([...FLAC_PREFIX, 0x11, 0x22])
    const response = await serveUpstream({
      upstream: () => new Response(body, {
        status: 200,
        headers: { 'content-type': MISLABELLED_FLAC, 'content-length': String(body.length) },
      }),
    })
    expect(response.status).toBe(200)
    // Served as what the bytes actually are, not the wrong declared type and not the expected one.
    expect(response.headers.get('content-type')).toBe('audio/flac')
    // The audio bytes are preserved exactly — reconciliation only corrects the label.
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
  })

  it('reconciles a ranged first chunk (bytes=0-) that carries the container header', async () => {
    const body = new Uint8Array(FLAC_PREFIX)
    const response = await serveUpstream({
      range: 'bytes=0-7',
      upstream: () => new Response(body, {
        status: 206,
        headers: {
          'content-type': MISLABELLED_FLAC,
          'content-range': `bytes 0-7/18054862`,
          'content-length': String(body.length),
          'accept-ranges': 'bytes',
        },
      }),
    })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('audio/flac')
    expect(response.headers.get('content-range')).toBe('bytes 0-7/18054862')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body)
  })

  it('still corrects to the true container even when the bytes disagree with BOTH labels', async () => {
    // Ticket expected audio/flac (from the .flac path), CDN declared audio/mpeg, bytes are MP3.
    // We trust neither label: the served type is the real container.
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array(MP3_ID3_PREFIX), {
        status: 200,
        headers: { 'content-type': MISLABELLED_FLAC, 'content-length': String(MP3_ID3_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
  })
})

describe('GD Studio reconciliation stays narrow', () => {
  it('rejects a mislabelled body whose bytes are not a known audio container', async () => {
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]), {
        status: 200,
        headers: { 'content-type': MISLABELLED_FLAC, 'content-length': '8' },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('rejects an HTML payload that the CDN mislabelled as audio', async () => {
    const html = new TextEncoder().encode('<!DOCTYPE html><html>')
    const response = await serveUpstream({
      upstream: () => new Response(html, {
        status: 200,
        headers: { 'content-type': MISLABELLED_FLAC, 'content-length': String(html.length) },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('rejects a JSON error body that the CDN mislabelled as audio', async () => {
    const json = new TextEncoder().encode('{"error":"invalid_response"}')
    const response = await serveUpstream({
      upstream: () => new Response(json, {
        status: 200,
        headers: { 'content-type': MISLABELLED_FLAC, 'content-length': String(json.length) },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('rejects a non-audio declared type even when the bytes look like audio', async () => {
    // A declared `text/html` is a positive claim of non-audio; reconciliation is only for a wrong
    // *audio* label, never for widening the guard to non-audio declarations.
    const response = await serveUpstream({
      upstream: () => new Response(new Uint8Array(FLAC_PREFIX), {
        status: 200,
        headers: { 'content-type': 'text/html', 'content-length': String(FLAC_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('rejects a mid-stream range with no container header (cannot verify the bytes)', async () => {
    // A non-zero range typically carries no container framing, so the bytes cannot be confirmed.
    // The safe boundary is to refuse rather than trust the ticket's label unverified — the same
    // limitation the generic-type path already lives with.
    const chunk = new Uint8Array([0x44, 0x55, 0x66, 0x77, 0x88, 0x99])
    const response = await serveUpstream({
      range: 'bytes=500000-500005',
      upstream: () => new Response(chunk, {
        status: 206,
        headers: {
          'content-type': MISLABELLED_FLAC,
          'content-range': 'bytes 500000-500005/18054862',
          'content-length': String(chunk.length),
          'accept-ranges': 'bytes',
        },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('rejects a HEAD request (no body to verify)', async () => {
    const response = await serveUpstream({
      method: 'HEAD',
      upstream: () => new Response(null, {
        status: 200,
        headers: { 'content-type': MISLABELLED_FLAC, 'content-length': '18054862' },
      }),
    })
    expect(response.status).toBe(502)
  })

  it('does not reconcile for a provider that has not opted in', async () => {
    // Only GD Studio has been evidenced to need this. A provider without the opt-in keeps the
    // strict reject for a mismatched declared audio type.
    const response = await serveUpstream({
      providerId: 'lx-huanyin',
      reconcileMislabelledAudioTypes: false,
      upstream: () => new Response(new Uint8Array(FLAC_PREFIX), {
        status: 200,
        headers: { 'content-type': MISLABELLED_FLAC, 'content-length': String(FLAC_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(502)
  })
})

describe('GD Studio reconciliation does not disturb the matching paths', () => {
  it('passes a correctly-labelled FLAC straight through (320 → no reconciliation needed)', async () => {
    const response = await serveUpstream({
      expectedMimeType: 'audio/flac',
      upstream: () => new Response(new Uint8Array(FLAC_PREFIX), {
        status: 200,
        headers: { 'content-type': 'audio/flac', 'content-length': String(FLAC_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/flac')
  })

  it('passes a correctly-labelled MP3 straight through', async () => {
    const response = await serveUpstream({
      expectedMimeType: 'audio/mpeg',
      upstream: () => new Response(new Uint8Array(MP3_ID3_PREFIX), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(MP3_ID3_PREFIX.length) },
      }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/mpeg')
  })
})

/** A pull-controlled upstream makes unintended downloading and missing cancellation observable. */
const trackedStream = (chunks: Uint8Array[], cancelError?: Error) => {
  const state = { pulls: 0, bytes: 0, cancellations: [] as unknown[] }
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1
      const chunk = chunks[index++]
      if (chunk === undefined) controller.close()
      else {
        state.bytes += chunk.byteLength
        controller.enqueue(chunk)
      }
    },
    cancel(reason) {
      state.cancellations.push(reason)
      if (cancelError) throw cancelError
    },
  }, { highWaterMark: 0 })
  return { body, state }
}
const settleStream = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const longTail = () => Array.from({ length: 64 }, () => new Uint8Array(16 * 1024))

describe('GD Studio bounded sniffing and stream ownership', () => {
  it('does not download the unread audio tail while waiting for a consumer', async () => {
    const { body, state } = trackedStream([new Uint8Array(FLAC_PREFIX), ...longTail()])
    const response = await serveUpstream({ upstream: () => new Response(body, { headers: { 'content-type': MISLABELLED_FLAC } }) })
    try {
      expect(response.status).toBe(200)
      await settleStream()
      expect(state.bytes).toBe(8)
      expect(state.pulls).toBe(1)
    } finally {
      await response.body?.cancel()
    }
  })

  it('cancels a rejected MIME body without downloading its unread tail', async () => {
    const { body, state } = trackedStream([new TextEncoder().encode('<html>error!'), ...longTail()])
    const response = await serveUpstream({ upstream: () => new Response(body, { headers: { 'content-type': MISLABELLED_FLAC } }) })
    expect(response.status).toBe(502)
    await settleStream()
    expect(state.cancellations).toHaveLength(1)
    expect(state.bytes).toBe(12)
  })

  it.each([
    ['wrong range', { 'content-range': 'bytes 1-8/100', 'content-length': '8' }],
    ['wrong length', { 'content-range': 'bytes 0-7/100', 'content-length': '7' }],
  ])('rejects and cancels %s before reading any audio bytes', async (_name, headers) => {
    const { body, state } = trackedStream([new Uint8Array(FLAC_PREFIX), ...longTail()])
    const response = await serveUpstream({
      range: 'bytes=0-7',
      upstream: () => new Response(body, { status: 206, headers: { 'content-type': MISLABELLED_FLAC, ...headers } }),
    })
    expect(response.status).toBe(502)
    await settleStream()
    expect(state.bytes).toBe(0)
    expect(state.cancellations).toHaveLength(1)
  })

  it('cancels a disallowed MIME declaration without reading its body', async () => {
    const { body, state } = trackedStream([new Uint8Array(FLAC_PREFIX), ...longTail()])
    const response = await serveUpstream({ upstream: () => new Response(body, { headers: { 'content-type': 'text/html' } }) })
    expect(response.status).toBe(502)
    expect(state.bytes).toBe(0)
    expect(state.cancellations).toHaveLength(1)
  })

  it('passes client cancellation through to the original upstream reader', async () => {
    const { body, state } = trackedStream([new Uint8Array(FLAC_PREFIX), ...longTail()])
    const upstream = new Response(body, { headers: { 'content-type': MISLABELLED_FLAC } })
    const response = await serveUpstream({ upstream: () => upstream })
    expect(response.status).toBe(200)
    await response.body!.cancel('player stopped')
    await settleStream()
    expect(state.cancellations).toEqual(['player stopped'])
    expect(state.bytes).toBe(8)
    expect(upstream.body!.locked).toBe(false)
  })

  it('cancels the upstream even while a downstream read is pending', async () => {
    let releasePull!: () => void
    const holdPull = new Promise<void>(resolve => { releasePull = resolve })
    let pulls = 0
    let cancelled = false
    const reasons: unknown[] = []
    const upstream = new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (++pulls === 1) controller.enqueue(new Uint8Array(FLAC_PREFIX))
        else {
          await holdPull
          if (!cancelled) controller.close()
        }
      },
      cancel(reason) { cancelled = true; reasons.push(reason) },
    }, { highWaterMark: 0 }), { headers: { 'content-type': MISLABELLED_FLAC } })
    const response = await serveUpstream({ upstream: () => upstream })
    const reader = response.body!.getReader()
    try {
      expect((await reader.read()).value).toEqual(new Uint8Array(FLAC_PREFIX))
      const pending = reader.read()
      await settleStream()
      await reader.cancel('seek interrupted')
      expect(await pending).toEqual({ done: true, value: undefined })
      expect(reasons).toEqual(['seek interrupted'])
      expect(upstream.body!.locked).toBe(false)
    } finally {
      releasePull()
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  })

  it('still returns a closed rejection when upstream cancellation throws', async () => {
    const { body, state } = trackedStream([new TextEncoder().encode('<html>error!'), ...longTail()], new Error('cancel failed'))
    const response = await serveUpstream({ upstream: () => new Response(body, { headers: { 'content-type': MISLABELLED_FLAC } }) })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'invalid_response' })
    expect(state.cancellations).toHaveLength(1)
  })

  it('rejects a prefix read error and releases the upstream reader', async () => {
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error('prefix unavailable')) },
    }, { highWaterMark: 0 }), { headers: { 'content-type': MISLABELLED_FLAC } })
    const response = await serveUpstream({ upstream: () => upstream })
    expect(response.status).toBe(502)
    expect(upstream.body!.locked).toBe(false)
  })

  it('propagates a tail read error instead of silently truncating audio and releases the reader', async () => {
    let pulls = 0
    const upstream = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulls === 1) controller.enqueue(new Uint8Array(FLAC_PREFIX))
        else controller.error(new Error('tail unavailable'))
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': MISLABELLED_FLAC } })
    const response = await serveUpstream({ upstream: () => upstream })
    expect(response.status).toBe(200)
    await expect(response.arrayBuffer()).rejects.toThrow('tail unavailable')
    expect(upstream.body!.locked).toBe(false)
  })

  it('stops looking for a header after a bounded prefix rather than searching the audio tail', async () => {
    const { body, state } = trackedStream([new Uint8Array(12), new Uint8Array(FLAC_PREFIX), ...longTail()])
    const response = await serveUpstream({ upstream: () => new Response(body, { headers: { 'content-type': MISLABELLED_FLAC } }) })
    expect(response.status).toBe(502)
    expect(state.bytes).toBe(12)
    expect(state.cancellations).toHaveLength(1)
  })

  it('bounds reads even when the upstream produces empty chunks before a header', async () => {
    const { body, state } = trackedStream([...Array.from({ length: 100 }, () => new Uint8Array()), new Uint8Array(FLAC_PREFIX)])
    const response = await serveUpstream({ upstream: () => new Response(body, { headers: { 'content-type': MISLABELLED_FLAC } }) })
    expect(response.status).toBe(502)
    expect(state.pulls).toBeLessThanOrEqual(16)
    expect(state.cancellations).toHaveLength(1)
  })
})

describe('GD Studio header boundaries', () => {
  it.each([
    ['FLAC magic', FLAC_PREFIX],
    ['frame sync', [0xff, 0xf8, 0, 0, 0, 0]],
  ])('rejects non-zero ranges containing fake %s without sniffing the fragment', async (_name, prefix) => {
    const bytes = new Uint8Array(prefix)
    const { body, state } = trackedStream([bytes])
    const end = 500000 + bytes.length - 1
    const response = await serveUpstream({
      range: 'bytes=500000-' + end,
      upstream: () => new Response(body, {
        status: 206,
        headers: {
          'content-type': MISLABELLED_FLAC,
          'content-range': 'bytes 500000-' + end + '/18054862',
          'content-length': String(bytes.length),
        },
      }),
    })
    expect(response.status).toBe(502)
    expect(state.bytes).toBe(0)
    expect(state.cancellations).toHaveLength(1)
  })

  it('keeps correctly labelled non-zero byte ranges functional', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const response = await serveUpstream({
      range: 'bytes=100-103',
      upstream: () => new Response(bytes, {
        status: 206,
        headers: { 'content-type': 'audio/flac', 'content-range': 'bytes 100-103/200', 'content-length': '4' },
      }),
    })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-type')).toBe('audio/flac')
    expect(response.headers.get('content-range')).toBe('bytes 100-103/200')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  it.each([
    ['FLAC', 'audio/flac', FLAC_PREFIX],
    ['WAVE', 'audio/wav', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]],
    ['MP4', 'audio/mp4', [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]],
    ['ID3', 'audio/mpeg', MP3_ID3_PREFIX],
  ])('recognises a split %s header and replays every original byte', async (_name, mime, bytes) => {
    const expected = new Uint8Array(bytes)
    const { body } = trackedStream([...expected].map(byte => new Uint8Array([byte])))
    const response = await serveUpstream({
      upstream: () => new Response(body, { headers: { 'content-type': MISLABELLED_FLAC, 'content-length': String(expected.length) } }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(mime)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected)
  })

  it('tolerates a few empty chunks while collecting a split header', async () => {
    const { body } = trackedStream([new Uint8Array(), new Uint8Array([0x66]), new Uint8Array(), new Uint8Array(FLAC_PREFIX.slice(1))])
    const response = await serveUpstream({ upstream: () => new Response(body, { headers: { 'content-type': MISLABELLED_FLAC } }) })
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(FLAC_PREFIX))
  })

  it('rejects an actually truncated split FLAC header', async () => {
    const { body } = trackedStream([new Uint8Array([0x66]), new Uint8Array([0x4c, 0x61])])
    const response = await serveUpstream({ upstream: () => new Response(body, { headers: { 'content-type': MISLABELLED_FLAC } }) })
    expect(response.status).toBe(502)
  })
})
