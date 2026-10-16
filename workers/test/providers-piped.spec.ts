import { describe, expect, it, vi } from 'vitest'
import { resolvePipedMetadata } from '../providers/piped'

const PIPED_ORIGIN = 'https://resolver.example.invalid'
const VIDEO_ID = 'lm3t3myPspk'

const jsonResponse = (value: unknown, init: ResponseInit = {}) => new Response(
  JSON.stringify(value),
  {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  },
)

describe('Piped metadata adapter', () => {
  it('rejects an invalid YouTube ID before contacting the configured resolver', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const result = await resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: 'short',
      fetch: fetchImpl,
      validateMediaUrl: () => {
        throw new Error('validator must not run')
      },
    })

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves one validated audio-only stream through the configured origin', async () => {
    const temporaryUrl = 'https://media.example.invalid/audio'
    const fetchImpl = vi.fn(async () => jsonResponse({
      audioStreams: [{
        url: temporaryUrl,
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: 128_000,
        videoOnly: false,
      }],
    })) as unknown as typeof fetch
    const validateMediaUrl = vi.fn((value: string) => new URL(value))

    const result = await resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl,
    })

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(temporaryUrl),
      mimeType: 'audio/mp4',
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(
      `${PIPED_ORIGIN}/streams/${VIDEO_ID}`,
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    )
    expect(validateMediaUrl).toHaveBeenCalledOnce()
  })

  it('maps an upstream 429 to rate_limited without retrying', async () => {
    const fetchImpl = vi.fn(async () => new Response('private upstream error', {
      status: 429,
      headers: { 'content-type': 'text/plain' },
    })) as unknown as typeof fetch

    const result = await resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: () => null,
    })

    expect(result).toEqual({ ok: false, error: 'rate_limited' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('aborts one metadata request after the four-second timeout', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          setTimeout(() => resolve(jsonResponse({ audioStreams: [] })), 5_000)
        })) as unknown as typeof fetch

      const pending = resolvePipedMetadata({
        configuredOrigin: PIPED_ORIGIN,
        externalId: VIDEO_ID,
        fetch: fetchImpl,
        validateMediaUrl: () => null,
      })
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' })
      expect(fetchImpl).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a declared metadata body larger than 512 KiB without reading it', async () => {
    const body = JSON.stringify({
      audioStreams: [{
        url: 'https://media.example.invalid/audio',
        mimeType: 'audio/mp4',
        bitrate: 128_000,
      }],
    })
    const response = new Response(body, {
      headers: {
        'content-length': String(512 * 1024 + 1),
        'content-type': 'application/json',
      },
    })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    const result = await resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: (value) => new URL(value),
    })

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
    expect(response.bodyUsed).toBe(false)
  })

  it('rejects an actual metadata body larger than 512 KiB even without Content-Length', async () => {
    const body = `${' '.repeat(512 * 1024)}${JSON.stringify({
      audioStreams: [{
        url: 'https://media.example.invalid/audio',
        mimeType: 'audio/mp4',
        bitrate: 128_000,
      }],
    })}`
    const fetchImpl = vi.fn(async () => new Response(body, {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    await expect(resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: (value) => new URL(value),
    })).resolves.toEqual({ ok: false, error: 'invalid_response' })
  })

  it('rejects a valid-looking body with a non-JSON response MIME', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      audioStreams: [{
        url: 'https://media.example.invalid/audio',
        mimeType: 'audio/mp4',
        bitrate: 128_000,
      }],
    }), { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch

    await expect(resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: (value) => new URL(value),
    })).resolves.toEqual({ ok: false, error: 'invalid_response' })
  })

  it('classifies malformed JSON without exposing the upstream body', async () => {
    const sensitiveBody = '{"private":"must-not-escape"'
    const fetchImpl = vi.fn(async () => new Response(sensitiveBody, {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    const result = await resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: () => null,
    })

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
    expect(JSON.stringify(result)).not.toContain('must-not-escape')
  })

  it.each([
    ['a resolver redirect', new Response(null, {
      status: 302,
      headers: { location: 'https://other.example.invalid/streams/private' },
    }), 'invalid_response'],
    ['an upstream 403', new Response('private capability detail', { status: 403 }), 'unavailable'],
    ['an upstream 500', new Response('private server detail', { status: 500 }), 'unavailable'],
  ] as const)('maps %s without following or exposing it', async (_case, response, error) => {
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    const result = await resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: () => null,
    })

    expect(result).toEqual({ ok: false, error })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(JSON.stringify(result)).not.toMatch(/private|other\.example/)
  })

  it('maps a resolver network failure to unavailable without retrying', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('private network detail')
    }) as unknown as typeof fetch

    const result = await resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: () => null,
    })

    expect(result).toEqual({ ok: false, error: 'unavailable' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('selects the highest-bitrate MP4 audio before WebM and other audio formats', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      audioStreams: [
        { url: 'https://media.example.invalid/webm', mimeType: 'audio/webm', bitrate: 256_000 },
        {
          url: 'https://media.example.invalid/unsupported-mp4',
          mimeType: 'audio/mp4; codecs="ec-3"',
          codec: 'ec-3',
          bitrate: 512_000,
        },
        {
          url: 'https://media.example.invalid/video-only',
          mimeType: 'audio/mp4',
          bitrate: 999_000,
          videoOnly: true,
        },
        { url: 'https://media.example.invalid/mp4-low', mimeType: 'audio/mp4', bitrate: 64_000 },
        { url: 'https://media.example.invalid/ogg', mimeType: 'audio/ogg', bitrate: 320_000 },
        {
          url: 'https://media.example.invalid/mp4-high',
          mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          codec: 'mp4a.40.2',
          bitrate: 128_000,
        },
      ],
    })) as unknown as typeof fetch

    const result = await resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: (value) => new URL(value),
    })

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL('https://media.example.invalid/mp4-high'),
      mimeType: 'audio/mp4',
    })
  })

  it('prefers browser-playable Opus over a higher-bitrate unsupported MP4 codec', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      audioStreams: [
        {
          url: 'https://media.example.invalid/unsupported',
          mimeType: 'audio/mp4',
          codec: 'ec-3',
          bitrate: 512_000,
        },
        {
          url: 'https://media.example.invalid/opus',
          mimeType: 'audio/webm',
          codec: 'opus',
          bitrate: 128_000,
        },
      ],
    })) as unknown as typeof fetch

    const result = await resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: (value) => new URL(value),
    })

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL('https://media.example.invalid/opus'),
      mimeType: 'audio/webm',
    })
  })

  it('rejects collections without one structurally valid audio-only candidate', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      audioStreams: [
        { url: 'https://media.example.invalid/video', mimeType: 'video/mp4', bitrate: 128_000 },
        {
          url: 'https://media.example.invalid/video-only',
          mimeType: 'audio/mp4',
          bitrate: 128_000,
          videoOnly: true,
        },
        { url: 'https://media.example.invalid/bad-bitrate', mimeType: 'audio/mp4', bitrate: 'fast' },
        { url: 'https://media.example.invalid/unsafe', mimeType: 'audio/mp4', bitrate: 64_000 },
      ],
    })) as unknown as typeof fetch

    const result = await resolvePipedMetadata({
      configuredOrigin: PIPED_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: (value) => value.endsWith('/unsafe') ? null : new URL(value),
    })

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
  })
})
