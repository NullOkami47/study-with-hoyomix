import { describe, expect, it, vi } from 'vitest'

import { deploymentAvailable } from '../providers/config'
import {
  jellyfinAuthHeaders,
  parseJellyfinExternalId,
  parseJellyfinUserId,
  resolveJellyfinMetadata,
} from '../providers/jellyfin'

const JELLYFIN_ORIGIN = 'https://jellyfin.example.invalid'
const API_TOKEN = 'secret-jellyfin-token-xyz-12345'
const ITEM_ID = '1234abcda0d954293110f4d561b0f614'
const ITEM_ID_HYPHENATED = '1234abcd-a0d9-5429-3110-f4d561b0f614'
const USER_ID = '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f'
const EXPECTED_MEDIA_URL = `${JELLYFIN_ORIGIN}/Audio/${ITEM_ID}/stream?static=true`
// Jellyfin 12 requires the modern `Authorization: MediaBrowser Token="…"` form and rejects the
// legacy `X-Emby-Token` header (observed: HTTP 401 on a real Jellyfin 12.0.0 server).
const DEPRECATED_AUTH_HEADERS = ['x-emby-token', 'x-mediabrowser-token'] as const

const validAudioMetadata = (overrides: Record<string, unknown> = {}) => ({
  Id: ITEM_ID,
  Name: 'La Vaguelette',
  Type: 'Audio',
  MediaType: 'Audio',
  Container: 'mp3',
  MediaSources: [
    {
      Id: ITEM_ID,
      Container: 'mp3',
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: false,
    },
  ],
  ...overrides,
})

const jsonResponse = (value: unknown, init: ResponseInit = {}) => new Response(
  JSON.stringify(value),
  {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  },
)

const resolve = (
  fetchImpl: typeof fetch,
  externalId: string = ITEM_ID,
  validateMediaUrl: (value: string) => URL | null = (value) => new URL(value),
) => resolveJellyfinMetadata({
  configuredOrigin: JELLYFIN_ORIGIN,
  apiToken: API_TOKEN,
  userId: USER_ID,
  externalId,
  fetch: fetchImpl,
  validateMediaUrl,
})

describe('Jellyfin external ID parser', () => {
  it.each([
    ['1234abcda0d954293110f4d561b0f614', '1234abcda0d954293110f4d561b0f614'],
    ['1234ABCDA0D954293110F4D561B0F614', '1234abcda0d954293110f4d561b0f614'],
    ['1234abcd-a0d9-5429-3110-f4d561b0f614', '1234abcda0d954293110f4d561b0f614'],
    ['1234ABCD-A0D9-5429-3110-F4D561B0F614', '1234abcda0d954293110f4d561b0f614'],
    ['00000000000000000000000000000001', '00000000000000000000000000000001'],
  ] as const)('accepts canonical GUID/UUID external ID: %s -> %s', (input, expected) => {
    expect(parseJellyfinExternalId(input)).toBe(expected)
  })

  it.each([
    '',
    '   ',
    ' 1234abcda0d954293110f4d561b0f614',
    '1234abcda0d954293110f4d561b0f614 ',
    '1234abcda0d954293110f4d561b0f61g', // invalid hex
    '1234abcd-a0d9-5429-3110-f4d561b0f61g',
    '1234abcda0d954293110f4d561b0f61', // 31 chars
    '1234abcda0d954293110f4d561b0f6140', // 33 chars
    '1234abcd-a0d9-5429-3110', // partial
    '../1234abcda0d954293110f4d561b0f614',
    '1234abcda0d954293110f4d561b0f614/stream',
    '1234abcda0d954293110f4d561b0f614?static=true',
    'https://jellyfin.example.invalid/Items/1234abcda0d954293110f4d561b0f614',
    'La Vaguelette',
    'zzz-tiny-giant',
  ])('rejects non-canonical or malformed external ID: %s', (input) => {
    expect(parseJellyfinExternalId(input)).toBeNull()
  })
})

describe('Jellyfin metadata adapter', () => {
  it('makes one bounded GET to /Items/{itemId} and returns direct play audio result', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata())) as unknown as typeof fetch
    const validateMediaUrl = vi.fn((value: string) => new URL(value))

    const result = await resolve(fetchImpl, ITEM_ID, validateMediaUrl)

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(EXPECTED_MEDIA_URL),
      mimeType: 'audio/mpeg',
      directPlay: true,
      itemId: ITEM_ID,
      container: 'mp3',
      quality: { codec: 'mp3', container: 'mp3' },
      hasArtwork: false,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [calledUrl, calledInit] = (fetchImpl as any).mock.calls[0]
    expect(calledUrl).toBe(`${JELLYFIN_ORIGIN}/Items/${ITEM_ID}?userId=${USER_ID}`)
    expect(calledInit.method).toBe('GET')
    expect(calledInit.redirect).toBe('manual')
    expect(calledInit.signal).toEqual(expect.any(AbortSignal))

    // Token must only appear in authentication headers, NEVER in query string or URL
    expect(calledUrl).not.toContain(API_TOKEN)
    expect(calledInit.headers['authorization']).toBe(`MediaBrowser Token="${API_TOKEN}"`)
    // Jellyfin 12 rejects the legacy header form outright, so it must not be sent at all.
    for (const header of DEPRECATED_AUTH_HEADERS) {
      expect(calledInit.headers[header]).toBeUndefined()
    }
    expect(calledInit.headers['accept']).toBe('application/json')

    // Result mediaUrl must NOT contain token
    expect(result.ok && result.mediaUrl.searchParams.get('api_key')).toBeNull()
    expect(result.ok && result.mediaUrl.searchParams.get('token')).toBeNull()
    expect(result.ok && result.mediaUrl.toString()).not.toContain(API_TOKEN)

    expect(validateMediaUrl).toHaveBeenCalledOnce()
    expect(validateMediaUrl).toHaveBeenCalledWith(EXPECTED_MEDIA_URL)
  })

  it('accepts hyphenated external ID and normalizes it for upstream requests', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata())) as unknown as typeof fetch

    const result = await resolve(fetchImpl, ITEM_ID_HYPHENATED)

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(EXPECTED_MEDIA_URL),
      mimeType: 'audio/mpeg',
      directPlay: true,
      itemId: ITEM_ID,
      container: 'mp3',
      quality: { codec: 'mp3', container: 'mp3' },
      hasArtwork: false,
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      `${JELLYFIN_ORIGIN}/Items/${ITEM_ID}?userId=${USER_ID}`,
      expect.anything(),
    )
  })

  it('correctly maps FLAC container to audio/flac', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata({
      Container: 'flac',
      MediaSources: [{ Id: ITEM_ID, Container: 'flac', SupportsDirectPlay: true }],
    }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(EXPECTED_MEDIA_URL),
      mimeType: 'audio/flac',
      directPlay: true,
      itemId: ITEM_ID,
      container: 'flac',
      quality: { codec: 'flac', container: 'flac' },
      hasArtwork: false,
    })
  })

  it('flags directPlay as false when Jellyfin reports transcoding is required', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata({
      MediaSources: [{
        Id: ITEM_ID,
        Container: 'mp3',
        SupportsDirectPlay: false,
        SupportsDirectStream: false,
        SupportsTranscoding: true,
      }],
    }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toEqual({
      ok: true,
      mediaUrl: new URL(EXPECTED_MEDIA_URL),
      mimeType: 'audio/mpeg',
      directPlay: false,
      itemId: ITEM_ID,
      container: 'mp3',
      quality: { codec: 'mp3', container: 'mp3' },
      hasArtwork: false,
    })
  })

  it('extracts full audio quality metadata for Hi-Res FLAC (24-bit, 96 kHz)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata({
      Container: 'flac',
      MediaSources: [
        {
          Id: ITEM_ID,
          Container: 'flac',
          SupportsDirectPlay: true,
          MediaStreams: [
            {
              Type: 'Audio',
              Codec: 'flac',
              BitDepth: 24,
              SampleRate: 96000,
              BitRate: 2800000,
            },
          ],
        },
      ],
    }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toMatchObject({
      ok: true,
      container: 'flac',
      quality: {
        codec: 'flac',
        container: 'flac',
        bitDepth: 24,
        sampleRate: 96000,
        bitrate: 2800000,
      },
    })
  })

  it('extracts partial audio quality metadata (FLAC, 44.1 kHz, no bit depth)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata({
      Container: 'flac',
      MediaStreams: [
        {
          Type: 'Audio',
          Codec: 'flac',
          SampleRate: 44100,
        },
      ],
    }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toMatchObject({
      ok: true,
      quality: {
        codec: 'flac',
        container: 'flac',
        sampleRate: 44100,
      },
    })
    expect((result as any).quality.bitDepth).toBeUndefined()
    expect((result as any).quality.bitrate).toBeUndefined()
  })

  it('extracts AAC audio quality with bitrate (256 kbps)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata({
      Container: 'aac',
      MediaSources: [
        {
          Id: ITEM_ID,
          Container: 'aac',
          SupportsDirectPlay: true,
          MediaStreams: [
            {
              Type: 'Audio',
              Codec: 'aac',
              BitRate: 256000,
              SampleRate: 48000,
            },
          ],
        },
      ],
    }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toMatchObject({
      ok: true,
      quality: {
        codec: 'aac',
        container: 'aac',
        bitrate: 256000,
        sampleRate: 48000,
      },
    })
  })

  it('detects artwork when ImageTags.Primary is present on the item', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata({
      ImageTags: { Primary: 'tag-12345' },
    }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toMatchObject({
      ok: true,
      hasArtwork: true,
      artworkId: ITEM_ID,
    })
  })

  it('detects artwork when AlbumPrimaryImageTag and AlbumId are present', async () => {
    const albumGuid = '12345678-1234-1234-1234-123456789012'
    const albumNormalized = '12345678123412341234123456789012'
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata({
      AlbumId: albumGuid,
      AlbumPrimaryImageTag: 'album-tag-abc',
    }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toMatchObject({
      ok: true,
      hasArtwork: true,
      artworkId: albumNormalized,
    })
  })

  it('detects artwork when HasPrimaryImage is true', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata({
      HasPrimaryImage: true,
    }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toMatchObject({
      ok: true,
      hasArtwork: true,
      artworkId: ITEM_ID,
    })
  })

  it('reports hasArtwork as false when no image tags exist', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata({
      ImageTags: {},
    }))) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toMatchObject({
      ok: true,
      hasArtwork: false,
    })
    expect((result as any).artworkId).toBeUndefined()
  })

  it('rejects an invalid external ID before making an HTTP request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const result = await resolveJellyfinMetadata({
      configuredOrigin: JELLYFIN_ORIGIN,
      apiToken: API_TOKEN,
      userId: USER_ID,
      externalId: 'invalid-id-format',
      fetch: fetchImpl,
    })

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an empty API token before making an HTTP request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const result = await resolveJellyfinMetadata({
      configuredOrigin: JELLYFIN_ORIGIN,
      apiToken: '   ',
      userId: USER_ID,
      externalId: ITEM_ID,
      fetch: fetchImpl,
    })

    expect(result).toEqual({ ok: false, error: 'unavailable' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['video', validAudioMetadata({ Type: 'Video', MediaType: 'Video' })],
    ['movie', validAudioMetadata({ Type: 'Movie' })],
    ['folder', validAudioMetadata({ Type: 'Folder', MediaType: null })],
    ['album', validAudioMetadata({ Type: 'MusicAlbum' })],
    ['unsupported container', validAudioMetadata({ Container: 'mkv' })],
    ['missing container', validAudioMetadata({ Container: null, MediaSources: [] })],
  ])('rejects non-audio or incompatible item type: %s', async (_label, body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects a response whose Id does not match requested itemId', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata({
      Id: '11111111222233334444555566667777',
    }))) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects a declared metadata body larger than 64 KiB without reading it', async () => {
    const response = jsonResponse(validAudioMetadata(), {
      headers: { 'content-length': String(64 * 1024 + 1) },
    })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(response.bodyUsed).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects a streamed metadata body larger than 64 KiB', async () => {
    const body = `${' '.repeat(64 * 1024)}${JSON.stringify(validAudioMetadata())}`
    const fetchImpl = vi.fn(async () => new Response(body, {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([
    ['a non-JSON response MIME', new Response(JSON.stringify(validAudioMetadata()), {
      headers: { 'content-type': 'text/html' },
    })],
    ['malformed JSON', new Response('{"Id":"1234abcda0d954293110f4d561b0f614"', {
      headers: { 'content-type': 'application/json' },
    })],
  ])('rejects %s without exposing secrets or body content', async (_label, response) => {
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('maps 429 to rate_limited without reading or retrying', async () => {
    const response = new Response('rate limit detail', { status: 429 })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toMatchObject({ ok: false, error: 'rate_limited' })
    expect(response.bodyUsed).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('rejects 3xx redirects without following, reading, or retrying', async () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: 'https://evil.example.invalid/Items' },
    })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch

    await expect(resolve(fetchImpl)).resolves.toMatchObject({ ok: false, error: 'invalid_response' })
    expect(response.bodyUsed).toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it.each([401, 403, 404, 500, 502, 503])('maps HTTP %s to unavailable', async (status) => {
    const fetchImpl = vi.fn(async () => new Response('error detail', { status })) as unknown as typeof fetch

    const result = await resolve(fetchImpl)
    expect(result).toMatchObject({ ok: false, error: 'unavailable' })
    // The numeric upstream status is surfaced as a non-sensitive discriminator so an operator
    // can distinguish a rejected credential from a missing item without ever seeing the token.
    expect(result.ok === false && result.upstreamStatus).toBe(status)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('aborts metadata request after four seconds', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((resolveResponse, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('abort', 'AbortError'))
          })
          setTimeout(() => resolveResponse(jsonResponse(validAudioMetadata())), 5_000)
        })) as unknown as typeof fetch

      const pending = resolve(fetchImpl)
      await vi.advanceTimersByTimeAsync(4_000)

      await expect(pending).resolves.toEqual({ ok: false, error: 'timeout' })
      expect(fetchImpl).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not log tokens, raw responses, or exceptions on failure', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]
    try {
      const fetchImpl = vi.fn(async () => {
        throw new Error(`network failure with secret ${API_TOKEN}`)
      }) as unknown as typeof fetch

      const result = await resolve(fetchImpl)
      expect(result).toEqual({ ok: false, error: 'unavailable' })
      expect(JSON.stringify(result)).not.toContain(API_TOKEN)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('rejects when validateMediaUrl returns null', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata())) as unknown as typeof fetch

    const result = await resolve(fetchImpl, ITEM_ID, () => null)

    expect(result).toEqual({ ok: false, error: 'invalid_response' })
  })
})

// Jellyfin 12 changed the authenticated request contract in two ways that the previous
// implementation got wrong against a real server:
//   1. `X-Emby-Token` is rejected (HTTP 401); only `Authorization: MediaBrowser Token="…"` works.
//   2. `GET /Items/{id}` without an explicit `userId` returns HTTP 400; the same request with
//      `?userId=<id>` returns HTTP 200. `GET /Items?Ids=<id>` also works, but the single-item
//      route is retained because it returns the full MediaSources projection the resolver needs.
describe('Jellyfin 12 authentication contract', () => {
  it('builds the modern authorization header and never a deprecated equivalent', () => {
    const headers = new Headers(jellyfinAuthHeaders(API_TOKEN))

    expect(headers.get('authorization')).toBe(`MediaBrowser Token="${API_TOKEN}"`)
    for (const header of DEPRECATED_AUTH_HEADERS) {
      expect(headers.get(header)).toBeNull()
    }
    // The token must never be duplicated into a query-string style header either.
    expect(headers.get('accept')).toBeNull()
  })

  it('quotes the token exactly once so a malformed server directive cannot be injected', () => {
    const hostile = 'abc"def, Client="evil'
    const headers = new Headers(jellyfinAuthHeaders(hostile))

    // The value is passed through verbatim; the caller is responsible for the allowlist that
    // keeps such a token out of the system in the first place. This test pins the shape so a
    // future refactor cannot silently start escaping or splitting the directive.
    expect(headers.get('authorization')).toBe(`MediaBrowser Token="${hostile}"`)
  })

  it('does not attach user context to the auth header builder', () => {
    const headers = new Headers(jellyfinAuthHeaders(API_TOKEN))

    expect([...headers.keys()].sort()).toEqual(['authorization'])
    expect(headers.get('authorization')).not.toContain(USER_ID)
  })
})

describe('Jellyfin 12 user context', () => {
  it('includes the configured userId on the metadata item lookup', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata())) as unknown as typeof fetch

    await resolve(fetchImpl)

    const [calledUrl] = (fetchImpl as any).mock.calls[0]
    const url = new URL(calledUrl)
    expect(url.pathname).toBe(`/Items/${ITEM_ID}`)
    expect(url.searchParams.get('userId')).toBe(USER_ID)
  })

  it('URL-encodes the userId and keeps it out of the media stream URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(validAudioMetadata())) as unknown as typeof fetch

    const result = await resolve(fetchImpl)

    expect(result.ok).toBe(true)
    const [calledUrl] = (fetchImpl as any).mock.calls[0]
    expect(calledUrl).not.toContain('#')
    expect(new URL(calledUrl).searchParams.get('userId')).toBe(USER_ID)
    // The media stream deliberately carries no user context: Jellyfin authorises it by the
    // token alone, and the repository proxies it so no credential reaches the browser.
    expect(result.ok && result.mediaUrl.searchParams.get('userId')).toBeNull()
  })

  it('rejects a request with no user context before making an HTTP request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const result = await resolveJellyfinMetadata({
      configuredOrigin: JELLYFIN_ORIGIN,
      apiToken: API_TOKEN,
      userId: '',
      externalId: ITEM_ID,
      fetch: fetchImpl,
    })

    expect(result).toEqual({ ok: false, error: 'unavailable' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps an upstream 400 from a missing user context to invalid_response', async () => {
    // Mirrors the observed real-server behaviour: no userId yields `HTTP 400 Error processing
    // request.` The resolver must surface a truthful category rather than a generic outage.
    const fetchImpl = vi.fn(async () => new Response('Error processing request.', {
      status: 400,
      headers: { 'content-type': 'text/plain' },
    })) as unknown as typeof fetch

    const result = await resolve(fetchImpl)
    expect(result.ok).toBe(false)
  })
})

describe('Jellyfin user ID parsing', () => {
  it.each([
    ['8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f', '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f'],
    ['8F2C1D4E5A6B7C8D9E0F1A2B3C4D5E6F', '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f'],
    ['8f2c1d4e-5a6b-7c8d-9e0f-1a2b3c4d5e6f', '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f'],
  ] as const)('accepts canonical Jellyfin GUID/UUID user ID: %s -> %s', (input, expected) => {
    expect(parseJellyfinUserId(input)).toBe(expected)
  })

  it.each([
    '',
    '   ',
    'replace-with-jellyfin-user-id',
    '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6',
    '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6ff',
    '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6g',
    '../8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f',
    '8f2c1d4e5a6b7c8d9e0f1a2b3c4d5e6f?x=1',
    'admin',
  ])('rejects a non-canonical or placeholder user ID: %s', (input) => {
    expect(parseJellyfinUserId(input)).toBeNull()
  })
})

// The resolver cannot complete a metadata lookup without user context on Jellyfin 12, so a
// deployment that supplies only an origin and a token is not actually available.
describe('Jellyfin deployment availability requires user context', () => {
  // `deploymentAvailable` reads only the Jellyfin fields, so the envelope is narrowed to those
  // keys rather than standing up the full auth/catalogue environment this suite does not need.
  const envWith = (overrides: Partial<Record<
    'JELLYFIN_BASE_URL' | 'JELLYFIN_API_TOKEN' | 'JELLYFIN_USER_ID',
    string
  >>) => overrides as unknown as Parameters<typeof deploymentAvailable>[1]

  const complete = {
    JELLYFIN_BASE_URL: JELLYFIN_ORIGIN,
    JELLYFIN_API_TOKEN: API_TOKEN,
    JELLYFIN_USER_ID: USER_ID,
  }

  it('requires origin, token, and user ID together', () => {
    expect(deploymentAvailable('jellyfin', envWith(complete))).toBe(true)
    expect(deploymentAvailable('jellyfin', envWith({
      JELLYFIN_BASE_URL: JELLYFIN_ORIGIN,
      JELLYFIN_API_TOKEN: API_TOKEN,
    }))).toBe(false)
    expect(deploymentAvailable('jellyfin', envWith({
      ...complete,
      JELLYFIN_USER_ID: '',
    }))).toBe(false)
    expect(deploymentAvailable('jellyfin', envWith({
      ...complete,
      JELLYFIN_USER_ID: 'not-a-guid',
    }))).toBe(false)
    expect(deploymentAvailable('jellyfin', envWith({
      JELLYFIN_BASE_URL: JELLYFIN_ORIGIN,
      JELLYFIN_USER_ID: USER_ID,
    }))).toBe(false)
    expect(deploymentAvailable('jellyfin', envWith({
      JELLYFIN_API_TOKEN: API_TOKEN,
      JELLYFIN_USER_ID: USER_ID,
    }))).toBe(false)
  })

  it('does not treat the placeholder example value as availability', () => {
    expect(deploymentAvailable('jellyfin', envWith({
      ...complete,
      JELLYFIN_USER_ID: 'replace-with-jellyfin-user-id',
    }))).toBe(false)
  })
})
