import { describe, expect, it, vi } from 'vitest'

import { resolveInvidiousMetadata } from '../providers/invidious'

const INVIDIOUS_ORIGIN = 'https://resolver.example.invalid'
const VIDEO_ID = 'kdV4K17KqAE'

const jsonResponse = (value: unknown, init: ResponseInit = {}) => new Response(
  JSON.stringify(value),
  {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  },
)

describe('Invidious metadata adapter', () => {
  it('rejects an invalid YouTube ID before contacting the configured resolver', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const result = await resolveInvidiousMetadata({
      configuredOrigin: INVIDIOUS_ORIGIN,
      externalId: 'short',
      fetch: fetchImpl,
      validateMediaUrl: () => {
        throw new Error('validator must not run')
      },
    })

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('resolves one adaptive audio-only format through local Invidious media proxying', async () => {
    const temporaryUrl = 'https://resolver.example.invalid/videoplayback?token=temporary'
    const fetchImpl = vi.fn(async () => jsonResponse({
      adaptiveFormats: [{
        url: temporaryUrl,
        type: 'audio/mp4; codecs="mp4a.40.2"',
        bitrate: '128000',
        audioQuality: 'AUDIO_QUALITY_MEDIUM',
      }],
      formatStreams: [{
        url: 'https://resolver.example.invalid/video',
        type: 'video/mp4',
      }],
    })) as unknown as typeof fetch
    const validateMediaUrl = vi.fn((value: string) => new URL(value))

    const result = await resolveInvidiousMetadata({
      configuredOrigin: INVIDIOUS_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl,
    })

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(temporaryUrl),
      mimeType: 'audio/mp4',
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      `${INVIDIOUS_ORIGIN}/api/v1/videos/${VIDEO_ID}?local=true`,
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(validateMediaUrl).toHaveBeenCalledOnce()
  })

  it('maps 429 without retry and maps redirects as invalid', async () => {
    for (const [response, error] of [
      [new Response('private', { status: 429 }), 'rate_limited'],
      [new Response(null, {
        status: 302,
        headers: { location: 'https://other.example.invalid/private' },
      }), 'invalid_response'],
    ] as const) {
      const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch
      const result = await resolveInvidiousMetadata({
        configuredOrigin: INVIDIOUS_ORIGIN,
        externalId: VIDEO_ID,
        fetch: fetchImpl,
        validateMediaUrl: () => null,
      })

      expect(result).toEqual({ ok: false, error })
      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(JSON.stringify(result)).not.toMatch(/private|other\.example/)
    }
  })

  it.each([403, 404, 500])('maps upstream HTTP %s to unavailable', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('private detail', { status })) as unknown as typeof fetch

    await expect(resolveInvidiousMetadata({
      configuredOrigin: INVIDIOUS_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: () => null,
    })).resolves.toEqual({ ok: false, error: 'unavailable' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('maps a resolver network failure to unavailable without retrying', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('private network detail')
    }) as unknown as typeof fetch

    const result = await resolveInvidiousMetadata({
      configuredOrigin: INVIDIOUS_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: () => null,
    })

    expect(result).toEqual({ ok: false, error: 'unavailable' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('aborts one metadata request after four seconds', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          setTimeout(() => resolve(jsonResponse({ adaptiveFormats: [] })), 5_000)
        })) as unknown as typeof fetch
      const pending = resolveInvidiousMetadata({
        configuredOrigin: INVIDIOUS_ORIGIN,
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

  it.each([
    ['declared oversize', new Response('{}', {
      headers: {
        'content-length': String(512 * 1024 + 1),
        'content-type': 'application/json',
      },
    })],
    ['actual oversize', new Response(`${' '.repeat(512 * 1024)}{"adaptiveFormats":[]}`, {
      headers: { 'content-type': 'application/json' },
    })],
    ['non-JSON MIME', new Response('{"adaptiveFormats":[]}', {
      headers: { 'content-type': 'text/html' },
    })],
    ['malformed JSON', new Response('{"private":"must-not-escape"', {
      headers: { 'content-type': 'application/json' },
    })],
  ])('rejects %s metadata as invalid_response', async (_case, response) => {
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch
    const result = await resolveInvidiousMetadata({
      configuredOrigin: INVIDIOUS_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: () => null,
    })

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
    expect(JSON.stringify(result)).not.toContain('must-not-escape')
  })

  it('uses adaptiveFormats only and selects highest-bitrate MP4 before WebM', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      adaptiveFormats: [
        { url: 'https://resolver.example.invalid/webm', type: 'audio/webm', bitrate: '256000' },
        {
          url: 'https://resolver.example.invalid/unsupported-mp4',
          type: 'audio/mp4; codecs="ec-3"',
          encoding: 'ec-3',
          bitrate: '512000',
        },
        { url: 'https://resolver.example.invalid/video', type: 'video/mp4', bitrate: '999000' },
        { url: 'https://resolver.example.invalid/mp4-low', type: 'audio/mp4', bitrate: '64000' },
        {
          url: 'https://resolver.example.invalid/mp4-high',
          type: 'audio/mp4; codecs="mp4a.40.2"',
          encoding: 'mp4a.40.2',
          bitrate: '128000',
        },
      ],
      formatStreams: [{
        url: 'https://resolver.example.invalid/muxed',
        type: 'audio/mp4',
        bitrate: '999999',
      }],
    })) as unknown as typeof fetch

    const result = await resolveInvidiousMetadata({
      configuredOrigin: INVIDIOUS_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: (value) => new URL(value),
    })

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL('https://resolver.example.invalid/mp4-high'),
      mimeType: 'audio/mp4',
    })
  })

  it('prefers browser-playable Opus over a higher-bitrate unsupported MP4 codec', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      adaptiveFormats: [
        {
          url: 'https://resolver.example.invalid/unsupported',
          type: 'audio/mp4',
          encoding: 'ec-3',
          bitrate: '512000',
        },
        {
          url: 'https://resolver.example.invalid/opus',
          type: 'audio/webm; codecs="opus"',
          encoding: 'opus',
          bitrate: '128000',
        },
      ],
    })) as unknown as typeof fetch

    const result = await resolveInvidiousMetadata({
      configuredOrigin: INVIDIOUS_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: (value) => new URL(value),
    })

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL('https://resolver.example.invalid/opus'),
      mimeType: 'audio/webm',
    })
  })

  it('rejects non-audio, malformed bitrate, and unsafe adaptive formats', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      adaptiveFormats: [
        { url: 'https://resolver.example.invalid/video', type: 'video/mp4', bitrate: '128000' },
        { url: 'https://resolver.example.invalid/bad', type: 'audio/mp4', bitrate: 'fast' },
        { url: 'https://resolver.example.invalid/unsafe', type: 'audio/mp4', bitrate: '64000' },
      ],
    })) as unknown as typeof fetch

    const result = await resolveInvidiousMetadata({
      configuredOrigin: INVIDIOUS_ORIGIN,
      externalId: VIDEO_ID,
      fetch: fetchImpl,
      validateMediaUrl: (value) => value.endsWith('/unsafe') ? null : new URL(value),
    })

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
  })
})
