import { describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import { createChkszCredentialStore } from './chkszCredentialStore'
import { createChkszProvider } from './providers/chksz'
import { createRuntimeProviderRepository } from './runtimeConfig'

/**
 * ChKSz resolution consumes real quota: 20 requests/minute and, by default, 50 free requests per
 * day. These tests exist to prove that ordinary UI activity consumes none of it, and that only an
 * actual playback resolve does.
 */

const USER_KEY = 'chksz_quota_test_key'
const EXTERNAL_ID = '3334421408'
const MEDIA_URL = 'https://m801.music.126.net/20260913/abc/xyz.mp3'

const track = (id = EXTERNAL_ID, provider = 'chksz'): Track => ({
  id: 'zzz-tiny-giant',
  title: 'Tiny Giant',
  aliases: {},
  games: ['zzz'],
  relationIds: [],
  tabs: ['chill'],
  workGroupId: 'zzz',
  needsClassification: false,
  vocalStatus: 'instrumental',
  sources: [{ provider, externalId: id }],
})

const metadataResponse = (status = 200, body?: unknown): Response =>
  new Response(JSON.stringify(body ?? {
    code: 200,
    data: { id: Number(EXTERNAL_ID), level: 'standard', url: MEDIA_URL },
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const providerConfigBody = () => ({
  version: 1,
  providers: [
    {
      id: 'r2',
      available: true,
      enabled: true,
      automaticEligible: true,
      priority: 1,
      config: { baseUrl: 'https://media.example.com/audio/', allowedHostnames: ['media.example.com'] },
    },
    {
      id: 'chksz',
      available: true,
      enabled: true,
      automaticEligible: true,
      priority: 10,
      userKeySupported: true,
      ownerFallbackAvailable: true,
    },
  ],
})

/** Records every outbound URL so ChKSz traffic can be counted exactly. */
const recordingFetch = (chkszResponse: () => Response = () => metadataResponse()) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('api.chksz.com')) return chkszResponse()
    if (url.includes('/api/providers/config')) {
      return new Response(JSON.stringify(providerConfigBody()), {
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  })

const chkszCalls = (fetchImpl: ReturnType<typeof recordingFetch>): string[] =>
  fetchImpl.mock.calls
    .map((call) => String((call as unknown as [string])[0]))
    .filter((url) => url.includes('api.chksz.com'))

const credentialStore = (key: string | null) => ({ key: () => key, revision: () => 0 })

const runtimeRepository = (fetchImpl: typeof fetch, key: string | null) =>
  createRuntimeProviderRepository({
    fetch: fetchImpl,
    chkszCredentials: credentialStore(key) as never,
    providerPreferences: { isDisabled: () => false, revision: () => 0 },
  })

const signal = () => new AbortController().signal

describe('ChKSz quota safety — no speculative consumption', () => {
  it('issues zero ChKSz requests when the runtime provider config loads and refreshes', async () => {
    const fetchImpl = recordingFetch()
    const repository = runtimeRepository(fetchImpl as unknown as typeof fetch, USER_KEY)

    await repository.load()
    await repository.load({ forceRefresh: true })
    await repository.prefetch()
    await repository.states()

    expect(chkszCalls(fetchImpl)).toHaveLength(0)
  })

  it('issues zero ChKSz requests when the provider registry is built and queried', async () => {
    const fetchImpl = recordingFetch()
    const repository = runtimeRepository(fetchImpl as unknown as typeof fetch, USER_KEY)

    const registry = await repository.load()
    registry.enabled()
    registry.enabled('chksz')
    registry.selectable()

    expect(chkszCalls(fetchImpl)).toHaveLength(0)
  })

  it('issues zero ChKSz requests when Settings reads the credential store', () => {
    const fetchImpl = recordingFetch()
    const store = createChkszCredentialStore({
      storage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    })

    store.key()
    store.remember()
    store.revision()

    expect(chkszCalls(fetchImpl)).toHaveLength(0)
  })

  it('issues zero ChKSz requests when a track is inspected or a queue is hydrated', () => {
    const fetchImpl = recordingFetch()
    const queue = [track(), track('2100334024'), track('2155423468')]

    // Hydration reads mapping metadata only; nothing resolves until playback asks.
    const hydrated = queue.flatMap((entry) => entry.sources.map((source) => source.provider))
    expect(hydrated).toEqual(['chksz', 'chksz', 'chksz'])
    expect(chkszCalls(fetchImpl)).toHaveLength(0)
  })

  it('issues zero ChKSz requests for catalogue-style filtering over the same tracks', () => {
    const fetchImpl = recordingFetch()
    const catalogue = [track(), track('1'), track('2', 'r2')]

    const filtered = catalogue.filter((entry) =>
      entry.tabs.includes('chill') && entry.sources.some((source) => source.provider === 'chksz'))

    expect(filtered.length).toBeGreaterThan(0)
    expect(chkszCalls(fetchImpl)).toHaveLength(0)
  })

  it('issues zero ChKSz requests while the provider exists but is never resolved', () => {
    const fetchImpl = recordingFetch()
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      ownerFallbackAvailable: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    expect(provider.id).toBe('chksz')
    expect(chkszCalls(fetchImpl)).toHaveLength(0)
  })
})

describe('ChKSz quota safety — explicit playback only', () => {
  it('issues exactly one request for one explicit playback resolve', async () => {
    const fetchImpl = recordingFetch()
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), signal())

    expect(chkszCalls(fetchImpl)).toHaveLength(1)
  })

  it('issues exactly one further request for one explicit user retry', async () => {
    const fetchImpl = recordingFetch()
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), signal())
    await provider.resolve(track(), signal())

    expect(chkszCalls(fetchImpl)).toHaveLength(2)
  })

  it.each([400, 401, 402, 403, 429, 503])(
    'never retries automatically after HTTP %i',
    async (status) => {
      const fetchImpl = recordingFetch(() => metadataResponse(status, { error: 'x' }))
      const provider = createChkszProvider({
        credentialStore: credentialStore(USER_KEY),
        fetch: fetchImpl as unknown as typeof fetch,
      })

      await expect(provider.resolve(track(), signal())).rejects.toBeInstanceOf(Error)

      expect(chkszCalls(fetchImpl)).toHaveLength(1)
    },
  )

  it('never retries automatically after a transport failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down')
    })
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.resolve(track(), signal())).rejects.toBeInstanceOf(Error)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not poll: a second resolve never happens without a second explicit call', async () => {
    const fetchImpl = recordingFetch()
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), signal())
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(chkszCalls(fetchImpl)).toHaveLength(1)
  })

  it('issues no ChKSz request when the track has no ChKSz mapping', async () => {
    const fetchImpl = recordingFetch()
    const provider = createChkszProvider({
      credentialStore: credentialStore(USER_KEY),
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.resolve(track('x', 'r2'), signal())).resolves.toBeNull()

    expect(chkszCalls(fetchImpl)).toHaveLength(0)
  })

  it('issues no direct ChKSz request when resolving through the owner fallback', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.includes('/api/providers/chksz/resolve')) {
        throw new Error(`unexpected request: ${url}`)
      }
      const response = new Response(JSON.stringify({
        url: `/api/providers/chksz/media/${EXTERNAL_ID}/${'a'.repeat(32)}`,
        mimeType: 'audio/mpeg',
      }), { status: 200, headers: { 'content-type': 'application/json' } })
      Object.defineProperty(response, 'url', { value: url })
      return response
    })
    const provider = createChkszProvider({
      credentialStore: credentialStore(null),
      ownerFallbackAvailable: true,
      fetch: fetchImpl as unknown as typeof fetch,
    })

    await provider.resolve(track(), signal())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(chkszCalls(fetchImpl as never)).toHaveLength(0)
  })
})
