import { describe, expect, it, vi } from 'vitest'

import type { Track } from '../../catalog/types'
import { createChkszProvider } from './chksz'
import { createGdStudioProvider } from './gdStudio'
import { createHuanyinProvider } from './huanyin'
import { createInvidiousProvider } from './invidious'
import { createJellyfinProvider } from './jellyfin'
import { createMetingProvider } from './meting'
import { createMetingAgentProvider } from './metingAgent'
import { createPipedProvider } from './piped'
import { createPublicMetingProvider } from './publicMeting'
import { createQijieProvider } from './qijie'
import { createR2Provider } from './r2'
import { ProviderResolveError, type AudioProvider } from './types'
import { youtubeProvider } from './youtube'

const APP_ORIGIN = window.location.origin
const R2_ORIGIN = 'https://media.study.example'
const PREPARATION_NONCE = 'abcdefghijklmnopqrstuvwxyzABCDEF'

function trackWithSource(provider: string, externalId = 'stable-track-id'): Track {
  return {
    id: 'track-contract',
    title: 'Contract Track',
    aliases: {},
    games: ['hsr'],
    relationIds: [],
    tabs: ['focus'],
    workGroupId: 'work-contract',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [{ provider, externalId }],
  }
}

function responseJson(body: Record<string, unknown>, status = 200): Response {
  const text = JSON.stringify(body)
  return new Response(text, {
    status,
    headers: {
      'content-length': String(new TextEncoder().encode(text).byteLength),
      'content-type': 'application/json',
    },
  })
}

function responseAt(response: Response, url: string): Response {
  const result = response.clone()
  Object.defineProperty(result, 'url', { configurable: true, value: url })
  return result
}

function stubFetch(response: Response, finalUrl?: string): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) =>
    responseAt(response, finalUrl ?? String(input)),
  ) as unknown as typeof fetch
}

function pendingFetch(): typeof fetch {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => reject(signal.reason ?? new DOMException('cancelled', 'AbortError')),
        { once: true },
      )
    })
  }) as unknown as typeof fetch
}

function expectFailureCode(promise: Promise<unknown>, code: ProviderResolveError['code']) {
  return expect(promise).rejects.toMatchObject({
    name: 'ProviderResolveError',
    code,
  })
}

interface ProxyFixture {
  id: string
  route: string
  create(fetchImpl: typeof fetch): AudioProvider
}

const proxyFixtures: ProxyFixture[] = [
  {
    id: 'qijie',
    route: '/api/providers/qijie/resolve',
    create: (fetchImpl) => createQijieProvider({ fetch: fetchImpl }),
  },
  {
    id: 'meting-agent',
    route: '/api/providers/meting-agent/resolve',
    create: (fetchImpl) =>
      createMetingAgentProvider({ fetch: fetchImpl }),
  },
  {
    id: 'gd-studio',
    route: '/api/providers/gd-studio/resolve',
    create: (fetchImpl) => createGdStudioProvider({ fetch: fetchImpl }),
  },
  {
    id: 'public-meting',
    route: '/api/providers/public-meting/resolve',
    create: (fetchImpl) =>
      createPublicMetingProvider({ fetch: fetchImpl }),
  },
  {
    id: 'jellyfin',
    route: '/api/providers/jellyfin/resolve',
    create: (fetchImpl) => createJellyfinProvider({ fetch: fetchImpl }),
  },
  {
    id: 'lx-huanyin',
    route: '/api/providers/lx-huanyin/resolve',
    create: (fetchImpl) => createHuanyinProvider({ fetch: fetchImpl }),
  },
]

describe('ChKSz hybrid adapter contract', () => {
  const resolveUrl = `${APP_ORIGIN}/api/providers/chksz/resolve`
  const externalId = '1315196858'
  // No user key, but the deployment offers an owner fallback: the Worker path is retained.
  const ownerFallback = {
    credentialStore: { key: () => null },
    ownerFallbackAvailable: true,
  }

  it.each(['1', '12345678901234567890'])(
    'posts the accepted numeric ChKSz mapping only to its same-origin resolve endpoint when falling back: %s',
    async (externalId) => {
      const playbackUrl = `${APP_ORIGIN}/api/providers/chksz/media/${externalId}/${PREPARATION_NONCE}`
      const fetchImpl = stubFetch(responseJson({ mimeType: 'audio/mpeg', url: playbackUrl }))

      await expect(
        createChkszProvider({ ...ownerFallback, fetch: fetchImpl }).resolve(
          trackWithSource('chksz', externalId),
          new AbortController().signal,
        ),
      ).resolves.toEqual({ kind: 'audio', mimeType: 'audio/mpeg', url: playbackUrl })

      expect(fetchImpl).toHaveBeenCalledOnce()
      expect(fetchImpl).toHaveBeenCalledWith(resolveUrl, expect.objectContaining({
        // The owner-fallback request carries the selected ChKSz level, so the Worker can spend the
        // Owner credential on the tier the user actually picked. With no quality store injected the
        // preference resolves to its default, `standard`.
        body: JSON.stringify({ externalId, level: 'standard' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        redirect: 'error',
      }))
      expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([resolveUrl])
    },
  )

  // The shared proxy provider gained an opt-in `requestBody` hook for ChKSz. Every other provider
  // relies on its default, so this pins that adding the hook did not change their request bodies:
  // they still send exactly one key, `externalId`, and never a ChKSz level.
  it.each(proxyFixtures.map((fixture) => [fixture.id, fixture] as const))(
    'keeps the %s resolve body limited to externalId',
    async (_id, fixture) => {
      const expectedUrl = `${APP_ORIGIN}${fixture.route}`
      const playbackUrl = `${APP_ORIGIN}${fixture.route.replace('/resolve', '/media')}/source-id/${PREPARATION_NONCE}`
      const fetchImpl = stubFetch(responseJson({ mimeType: 'audio/mpeg', url: playbackUrl }))

      await fixture.create(fetchImpl)
        .resolve(trackWithSource(fixture.id), new AbortController().signal)
        .catch(() => null)

      const calls = vi.mocked(fetchImpl).mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[0]?.[0])).toBe(expectedUrl)
      const sent = JSON.parse(String((calls[0]?.[1] as RequestInit)?.body)) as Record<string, unknown>
      expect(Object.keys(sent)).toEqual(['externalId'])
    },
  )

  it('returns null when the track has no ChKSz mapping', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    await expect(
      createChkszProvider({ ...ownerFallback, fetch: fetchImpl }).resolve(
        trackWithSource('youtube', 'abcdefghijk'),
        new AbortController().signal,
      ),
    ).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    '',
    ' 1315196858',
    '1315196858 ',
    '-1',
    '1.5',
    '1315196858a',
    '123456789012345678901',
    'https://upstream.example/temporary-audio',
  ])(
    'rejects a non-numeric ChKSz mapping before it reaches the proxy: %s',
    async (externalId) => {
      const fetchImpl = vi.fn() as unknown as typeof fetch

      await expectFailureCode(
        createChkszProvider({ ...ownerFallback, fetch: fetchImpl }).resolve(
          trackWithSource('chksz', externalId),
          new AbortController().signal,
        ),
        'invalid_response',
      )
      expect(fetchImpl).not.toHaveBeenCalled()
    },
  )

  it('converts a same-origin ChKSz rate limit into a typed resolver failure', async () => {
    await expectFailureCode(
      createChkszProvider({
        ...ownerFallback,
        fetch: stubFetch(new Response(null, { status: 429 })),
      }).resolve(
        trackWithSource('chksz', '1315196858'),
        new AbortController().signal,
      ),
      'rate_limited',
    )
  })

  it('requires a credential when there is neither a user key nor an owner fallback', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    await expectFailureCode(
      createChkszProvider({
        credentialStore: { key: () => null },
        ownerFallbackAvailable: false,
        fetch: fetchImpl,
      }).resolve(trackWithSource('chksz', externalId), new AbortController().signal),
      'credential_required',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sends a user key to api.chksz.com and never to the same-origin proxy', async () => {
    const fetchImpl = stubFetch(responseJson({
      code: 200,
      data: {
        id: Number(externalId),
        level: 'standard',
        url: 'https://m801.music.126.net/20260913/abc/xyz.mp3',
      },
    }))

    const playable = await createChkszProvider({
      fetch: fetchImpl,
      credentialStore: { key: () => 'chksz_USER_KEY_SENTINEL' },
      ownerFallbackAvailable: true,
    }).resolve(trackWithSource('chksz', externalId), new AbortController().signal)

    expect(playable).toEqual({
      kind: 'audio',
      mimeType: 'audio/mpeg',
      url: 'https://m801.music.126.net/20260913/abc/xyz.mp3',
      metadata: {
        quality: {
          tier: 'standard',
        },
      },
    })

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(String(url)).toContain('https://api.chksz.com/api/163_music')
    expect(String(url)).not.toContain('/api/providers/chksz')
    // The dedicated header is gone: the key must never reach our own backend.
    expect(new Headers(init?.headers).get('x-chksz-api-key')).toBeNull()
    expect(String(init?.body)).not.toContain('chksz_USER_KEY_SENTINEL')
  })
})

describe('canonical Meting server-proxy adapter contract', () => {
  const resolveUrl = `${APP_ORIGIN}/api/providers/meting/resolve`
  const externalId = 'netease:123456789'
  const playbackUrl = `${APP_ORIGIN}/api/providers/meting/media/netease%3A123456789/${PREPARATION_NONCE}`

  it('resolves an accepted mapping only through the canonical same-origin ticket route', async () => {
    const fetchImpl = stubFetch(responseJson({ mimeType: 'audio/mpeg', url: playbackUrl }))

    await expect(
      createMetingProvider({ fetch: fetchImpl }).resolve(
        trackWithSource('meting', externalId),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'audio', mimeType: 'audio/mpeg', url: playbackUrl })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(resolveUrl, expect.objectContaining({
      body: JSON.stringify({ externalId }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      redirect: 'error',
    }))
  })

  it('resolves an accepted Tencent mapping through its once-encoded same-origin ticket route', async () => {
    const tencentExternalId = 'tencent:987654321'
    const tencentPlaybackUrl = `${APP_ORIGIN}/api/providers/meting/media/tencent%3A987654321/${PREPARATION_NONCE}`
    const fetchImpl = stubFetch(responseJson({ mimeType: 'audio/mpeg', url: tencentPlaybackUrl }))

    await expect(
      createMetingProvider({ fetch: fetchImpl }).resolve(
        trackWithSource('meting', tencentExternalId),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'audio', mimeType: 'audio/mpeg', url: tencentPlaybackUrl })

    expect(fetchImpl).toHaveBeenCalledWith(resolveUrl, expect.objectContaining({
      body: JSON.stringify({ externalId: tencentExternalId }),
      method: 'POST',
      redirect: 'error',
    }))
  })

  it.each([
    'netease:123456789012345678901',
    'tencent:123456789012345678901',
    'netease:',
    'netease:-1',
    'netease:123 456',
    'spotify:123456789',
    'https://operator.example/resolve',
    'netease:123/456',
  ])('rejects an invalid Meting mapping before contacting the resolver: %s', async (mapping) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    await expectFailureCode(
      createMetingProvider({ fetch: fetchImpl }).resolve(
        trackWithSource('meting', mapping),
        new AbortController().signal,
      ),
      'invalid_response',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    `${APP_ORIGIN}/api/providers/meting/media/netease:123456789/${PREPARATION_NONCE}`,
    `${APP_ORIGIN}/api/providers/meting/media/netease%253A123456789/${PREPARATION_NONCE}`,
    `${APP_ORIGIN}/api/providers/meting/media/netease%2F123456789/${PREPARATION_NONCE}`,
    'https://media.operator.example/direct.mp3',
  ])('rejects a non-canonical or external Meting media URL: %s', async (url) => {
    await expectFailureCode(
      createMetingProvider({ fetch: stubFetch(responseJson({ mimeType: 'audio/mpeg', url })) }).resolve(
        trackWithSource('meting', externalId),
        new AbortController().signal,
      ),
      'invalid_response',
    )
  })
})

describe.each([
  ['piped', createPipedProvider],
  ['invidious', createInvidiousProvider],
] as const)('%s audio resolver client contract', (providerId, createProvider) => {
  const externalId = 'lm3t3myPspk'
  const resolveUrl = `${APP_ORIGIN}/api/providers/${providerId}/resolve`
  const mediaPath = `/api/providers/${providerId}/media/${externalId}/${PREPARATION_NONCE}`
  const playbackUrl = `${APP_ORIGIN}${mediaPath}`

  it('posts an exact YouTube ID only to the same-origin resolve route', async () => {
    const fetchImpl = stubFetch(responseJson({ mimeType: 'audio/webm', url: mediaPath }))

    await expect(
      createProvider({ fetch: fetchImpl }).resolve(
        trackWithSource(providerId, externalId),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'audio', mimeType: 'audio/webm', url: playbackUrl })
    expect(fetchImpl).toHaveBeenCalledWith(resolveUrl, expect.objectContaining({
      body: JSON.stringify({ externalId }),
      method: 'POST',
      redirect: 'error',
    }))
    expect(JSON.stringify(vi.mocked(fetchImpl).mock.calls)).not.toContain('googlevideo')
  })

  it.each([
    '',
    'too-short',
    'abcdefghijkl',
    'https://youtu.be/lm3t3myPspk',
    'lm3t3myPsp?',
  ])('rejects a malformed YouTube ID before contacting the Worker: %s', async (value) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    await expectFailureCode(
      createProvider({ fetch: fetchImpl }).resolve(
        trackWithSource(providerId, value),
        new AbortController().signal,
      ),
      'invalid_response',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    `/api/providers/${providerId}/media/kdV4K17KqAE/${PREPARATION_NONCE}`,
    `/api/providers/${providerId}/media/${externalId}/short`,
    `/api/providers/${providerId}/media/${externalId}/${PREPARATION_NONCE}/extra`,
    `/api/providers/${providerId}/media/${externalId}/${PREPARATION_NONCE}?download=1`,
    `/api/providers/${providerId}/media/${externalId}/extra/%2e%2e/${PREPARATION_NONCE}`,
  ])('rejects a media preparation that is not exactly bound to the request: %s', async (url) => {
    await expectFailureCode(
      createProvider({ fetch: stubFetch(responseJson({ mimeType: 'audio/webm', url })) }).resolve(
        trackWithSource(providerId, externalId),
        new AbortController().signal,
      ),
      'invalid_response',
    )
  })

  it.each([
    ['timeout', 504],
    ['invalid_response', 502],
    ['unavailable', 503],
    ['rate_limited', 429],
  ] as const)('preserves the safe Worker %s failure class', async (code, status) => {
    await expectFailureCode(
      createProvider({ fetch: stubFetch(responseJson({ error: code }, status)) }).resolve(
        trackWithSource(providerId, externalId),
        new AbortController().signal,
      ),
      code,
    )
  })
})

describe('R2 provider contract', () => {
  function provider(fetchImpl: typeof fetch): AudioProvider {
    return createR2Provider({
      baseUrl: `${R2_ORIGIN}/audio/`,
      allowedHostnames: ['media.study.example'],
      fetch: fetchImpl,
    })
  }

  it('bypasses the HTTP cache for R2 HEAD validation', async () => {
    const fetchImpl = stubFetch(
      new Response(null, {
        status: 200,
        headers: {
          'accept-ranges': 'bytes',
          'content-length': '4096',
          'content-type': 'audio/ogg',
        },
      }),
    )

    await expect(
      provider(fetchImpl).resolve(trackWithSource('r2', 'demo/authorised-v1.ogg'), new AbortController().signal),
    ).resolves.toEqual({
      kind: 'audio',
      mimeType: 'audio/ogg',
      url: `${R2_ORIGIN}/audio/demo/authorised-v1.ogg`,
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      `${R2_ORIGIN}/audio/demo/authorised-v1.ogg`,
      expect.objectContaining({ cache: 'no-store', method: 'HEAD', redirect: 'error' }),
    )
  })

  it('bypasses the HTTP cache for both HEAD and one-byte Range validation', async () => {
    const responses = [
      new Response(null, {
          status: 200,
          headers: { 'content-length': '4096', 'content-type': 'audio/mpeg' },
        }),
      new Response(new Uint8Array([0]), {
          status: 206,
          headers: {
            'content-range': 'bytes 0-0/4096',
            'content-type': 'audio/mpeg',
          },
        }),
    ]
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const response = responses.shift()
      if (!response) throw new Error('Unexpected request')
      return responseAt(response, String(input))
    }) as unknown as typeof fetch

    await expect(
      provider(fetchImpl).resolve(trackWithSource('r2', 'demo-v2.mp3'), new AbortController().signal),
    ).resolves.toMatchObject({ kind: 'audio', mimeType: 'audio/mpeg' })

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      `${R2_ORIGIN}/audio/demo-v2.mp3`,
      expect.objectContaining({ cache: 'no-store', method: 'HEAD', redirect: 'error' }),
    )
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      `${R2_ORIGIN}/audio/demo-v2.mp3`,
      expect.objectContaining({
        cache: 'no-store',
        headers: { Range: 'bytes=0-0' },
        method: 'GET',
        redirect: 'error',
      }),
    )
  })

  it('returns null for a missing object', async () => {
    await expect(
      provider(stubFetch(new Response(null, { status: 404 }))).resolve(
        trackWithSource('r2'),
        new AbortController().signal,
      ),
    ).resolves.toBeNull()
  })

  it('honours caller aborts without translating them into provider failures', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(
      provider(vi.fn() as unknown as typeof fetch).resolve(trackWithSource('r2'), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('aborts an in-flight pending R2 request', async () => {
    const controller = new AbortController()
    const resolution = provider(pendingFetch()).resolve(trackWithSource('r2'), controller.signal)
    await Promise.resolve()

    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(resolution).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects empty or redirected final response URLs and never follows redirect status responses', async () => {
    const objectUrl = `${R2_ORIGIN}/audio/stable-track-id`

    await expectFailureCode(
      provider(stubFetch(new Response(null, {
        status: 200,
        headers: { 'accept-ranges': 'bytes', 'content-type': 'audio/mpeg' },
      }), '')).resolve(trackWithSource('r2'), new AbortController().signal),
      'invalid_response',
    )
    await expectFailureCode(
      provider(stubFetch(new Response(null, {
        status: 200,
        headers: { 'accept-ranges': 'bytes', 'content-type': 'audio/mpeg' },
      }), 'https://attacker.example/audio.mp3')).resolve(
        trackWithSource('r2'),
        new AbortController().signal,
      ),
      'invalid_response',
    )

    const redirectFetch = stubFetch(
      new Response(null, {
        status: 307,
        headers: { location: 'https://attacker.example/collect' },
      }),
      objectUrl,
    )
    await expectFailureCode(
      provider(redirectFetch).resolve(trackWithSource('r2'), new AbortController().signal),
      'unavailable',
    )
    expect(redirectFetch).toHaveBeenCalledOnce()
    expect(redirectFetch).toHaveBeenCalledWith(
      objectUrl,
      expect.objectContaining({ redirect: 'error' }),
    )
  })

  it('rejects non-audio response MIME types', async () => {
    const fetchImpl = stubFetch(
      new Response(null, {
        status: 200,
        headers: {
          'accept-ranges': 'bytes',
          'content-length': '32',
          'content-type': 'text/html',
        },
      }),
    )

    await expectFailureCode(
      provider(fetchImpl).resolve(trackWithSource('r2'), new AbortController().signal),
      'invalid_response',
    )
  })

  it('rejects a missing or unsafe stable object key', async () => {
    const r2Provider = provider(vi.fn() as unknown as typeof fetch)

    await expectFailureCode(
      r2Provider.resolve(trackWithSource('r2', ''), new AbortController().signal),
      'invalid_response',
    )
    await expectFailureCode(
      r2Provider.resolve(trackWithSource('r2', '../secret.mp3'), new AbortController().signal),
      'invalid_response',
    )
  })

  it('returns a typed rate-limit failure', async () => {
    await expectFailureCode(
      provider(stubFetch(new Response(null, { status: 429 }))).resolve(
        trackWithSource('r2'),
        new AbortController().signal,
      ),
      'rate_limited',
    )
  })

  it('rejects non-HTTPS or non-allowlisted R2 hosts before making a request', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    expect(() =>
      createR2Provider({
        baseUrl: 'http://media.study.example/audio/',
        allowedHostnames: ['media.study.example'],
        fetch: fetchImpl,
      }),
    ).toThrow()
    expect(() =>
      createR2Provider({
        baseUrl: 'https://untrusted.example/audio/',
        allowedHostnames: ['media.study.example'],
        fetch: fetchImpl,
      }),
    ).toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe.each(proxyFixtures)('$id server-proxy adapter contract', ({ id, route, create }) => {
  const playbackUrl = `${APP_ORIGIN}${route.replace(
    '/resolve',
    `/media/stable-track-id/${PREPARATION_NONCE}`,
  )}`

  it('returns only a validated same-origin proxy audio URL', async () => {
    const fetchImpl = stubFetch(responseJson({ mimeType: 'audio/mpeg', url: playbackUrl }))

    await expect(
      create(fetchImpl).resolve(trackWithSource(id), new AbortController().signal),
    ).resolves.toEqual({ kind: 'audio', mimeType: 'audio/mpeg', url: playbackUrl })

    const [requestUrl, requestInit] = vi.mocked(fetchImpl).mock.calls[0] ?? []
    expect(requestUrl).toBe(`${APP_ORIGIN}${route}`)
    expect(requestInit).toMatchObject({
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      redirect: 'error',
    })
    expect(String(requestInit?.body)).toContain('stable-track-id')
    expect(String(requestInit?.body)).not.toContain('http')
  })

  it('returns null for a proxy 404', async () => {
    await expect(
      create(stubFetch(new Response(null, { status: 404 }))).resolve(
        trackWithSource(id),
        new AbortController().signal,
      ),
    ).resolves.toBeNull()
  })

  it('returns null when the track has no mapping for this provider', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(
      create(fetchImpl).resolve(trackWithSource('unmapped-provider'), new AbortController().signal),
    ).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('honours caller aborts without starting a request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(create(fetchImpl).resolve(trackWithSource(id), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('aborts an in-flight pending proxy request', async () => {
    const controller = new AbortController()
    const resolution = create(pendingFetch()).resolve(trackWithSource(id), controller.signal)
    await Promise.resolve()

    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(resolution).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects invalid audio MIME from the public response contract', async () => {
    await expectFailureCode(
      create(stubFetch(responseJson({ mimeType: 'text/html', url: playbackUrl }))).resolve(
        trackWithSource(id),
        new AbortController().signal,
      ),
      'invalid_response',
    )
  })

  it('rejects a response with no playable URL', async () => {
    await expectFailureCode(
      create(stubFetch(responseJson({ mimeType: 'audio/mpeg' }))).resolve(
        trackWithSource(id),
        new AbortController().signal,
      ),
      'invalid_response',
    )
  })

  it('rejects provider URLs in source mappings before contacting the proxy', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    await expectFailureCode(
      create(fetchImpl).resolve(
        trackWithSource(id, 'https://provider.example/media-id'),
        new AbortController().signal,
      ),
      'invalid_response',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns a typed rate-limit failure', async () => {
    await expectFailureCode(
      create(stubFetch(new Response(null, { status: 429 }))).resolve(
        trackWithSource(id),
        new AbortController().signal,
      ),
      'rate_limited',
    )
  })

  it('rejects oversized, non-JSON, insecure, external, or cross-provider response URLs', async () => {
    const oversized = new Response('{}', {
      status: 200,
      headers: { 'content-length': '65537', 'content-type': 'application/json' },
    })
    const invalidResponses = [
      oversized,
      new Response('not json', { headers: { 'content-type': 'text/plain' } }),
      responseJson({
        mimeType: 'audio/mpeg',
        url: `http://study.example${route.replace(
          '/resolve',
          `/media/stable-track-id/${PREPARATION_NONCE}`,
        )}`,
      }),
      responseJson({ mimeType: 'audio/mpeg', url: 'https://provider.example/stream.mp3' }),
      responseJson({
        mimeType: 'audio/mpeg',
        url: `${APP_ORIGIN}/api/providers/a-different-provider/media/token`,
      }),
    ]

    for (const response of invalidResponses) {
      await expectFailureCode(
        create(stubFetch(response)).resolve(trackWithSource(id), new AbortController().signal),
        'invalid_response',
      )
    }
  })

  it('ignores caller attempts to self-authorise a different proxy origin', async () => {
    const response = responseJson({ mimeType: 'audio/mpeg', url: playbackUrl })
    const fetchImpl = stubFetch(response)
    const factories = {
      qijie: createQijieProvider,
      'meting-agent': createMetingAgentProvider,
      'gd-studio': createGdStudioProvider,
      'public-meting': createPublicMetingProvider,
      jellyfin: createJellyfinProvider,
      'lx-huanyin': createHuanyinProvider,
    }
    const factory = factories[id as keyof typeof factories]
    const provider = factory({
      fetch: fetchImpl,
      proxyOrigin: 'https://attacker.example',
    } as never)

    await provider.resolve(trackWithSource(id), new AbortController().signal)
    expect(fetchImpl).toHaveBeenCalledWith(`${APP_ORIGIN}${route}`, expect.any(Object))
  })

  it('rejects empty or redirected final response URLs and never follows 308 responses', async () => {
    await expectFailureCode(
      create(stubFetch(responseJson({ mimeType: 'audio/mpeg', url: playbackUrl }), '')).resolve(
        trackWithSource(id),
        new AbortController().signal,
      ),
      'invalid_response',
    )
    await expectFailureCode(
      create(
        stubFetch(
          responseJson({ mimeType: 'audio/mpeg', url: playbackUrl }),
          'https://attacker.example/resolve',
        ),
      ).resolve(trackWithSource(id), new AbortController().signal),
      'invalid_response',
    )

    const redirectFetch = stubFetch(
      new Response(null, {
        status: 308,
        headers: { location: 'https://attacker.example/collect' },
      }),
      `${APP_ORIGIN}${route}`,
    )
    await expectFailureCode(
      create(redirectFetch).resolve(trackWithSource(id), new AbortController().signal),
      'unavailable',
    )
    expect(redirectFetch).toHaveBeenCalledOnce()
    expect(redirectFetch).toHaveBeenCalledWith(
      `${APP_ORIGIN}${route}`,
      expect.objectContaining({ redirect: 'error' }),
    )
  })
})

describe('server-proxy application origin policy', () => {
  const fetchImpl = vi.fn() as unknown as typeof fetch

  function createAtOrigin(origin: string): () => AudioProvider {
    return () => {
      const originalLocation = globalThis.location
      vi.stubGlobal('location', { origin })
      try {
        return createQijieProvider({ fetch: fetchImpl })
      } finally {
        vi.stubGlobal('location', originalLocation)
      }
    }
  }

  it.each([
    'https://study.example',
    'https://localhost:8443',
    'http://localhost:3000',
    'http://127.0.0.1:4173',
    'http://[::1]:8080',
  ])('allows an HTTPS origin or explicit local HTTP development origin: %s', (origin) => {
    expect(createAtOrigin(origin)).not.toThrow()
  })

  it.each([
    'ftp://localhost',
    'ftp://127.0.0.1',
    'ftp://[::1]',
    'http://study.example',
  ])('rejects a non-HTTP(S) local or non-local insecure origin: %s', (origin) => {
    expect(createAtOrigin(origin)).toThrow()
  })
})

describe('YouTube provider contract', () => {
  it('maps only an official videoId and never returns a media URL', async () => {
    await expect(
      youtubeProvider.resolve(
        trackWithSource('youtube', 'abcdefghijk'),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'youtube', videoId: 'abcdefghijk' })
  })

  it('returns null for an absent mapping', async () => {
    await expect(
      youtubeProvider.resolve(trackWithSource('r2'), new AbortController().signal),
    ).resolves.toBeNull()
  })

  it.each(['', 'https://youtu.be/abcdefghijk', 'too-short', 'abcdefghijkl'])(
    'rejects a missing or malformed videoId: %s',
    async (externalId) => {
      await expectFailureCode(
        youtubeProvider.resolve(
          trackWithSource('youtube', externalId),
          new AbortController().signal,
        ),
        'invalid_response',
      )
    },
  )

  it('honours caller aborts without attempting availability network probes', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(
      youtubeProvider.resolve(trackWithSource('youtube', 'abcdefghijk'), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not have a network timeout because videoId resolution is synchronous and local', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await youtubeProvider.resolve(
      trackWithSource('youtube', 'abcdefghijk'),
      new AbortController().signal,
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
