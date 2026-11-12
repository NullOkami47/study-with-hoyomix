import { describe, expect, it, vi } from 'vitest'

import { parseCatalog } from '../catalog/schema'
import { ProviderRegistry } from './providers/registry'
import { resolveTrack } from './resolver'
import { CANONICAL_PROVIDER_IDS, createRuntimeProviderRepository, isProviderEnabled } from './runtimeConfig'
import { LX_INIT_TIMEOUT_MS, LX_RESOLVE_TIMEOUT_MS, LX_RPC_GRACE_MS } from './lx/runtime/protocol'
import { MEDIA_PROBE_TIMEOUT_MS } from './mediaProbe'
import type { AudioProvider } from './providers/types'

const CONFIG_URL = new URL('/api/providers/config', window.location.origin).toString()

const responseAt = (response: Response, url = CONFIG_URL, redirected = false): Response => {
  Object.defineProperties(response, {
    redirected: { configurable: true, value: redirected },
    url: { configurable: true, value: url },
  })
  return response
}

const configResponse = (providers: unknown[], init: ResponseInit = {}, url = CONFIG_URL) =>
  responseAt(
    new Response(
      JSON.stringify({
        version: 1,
        providers: providers.map((provider) =>
          typeof provider === 'object' && provider !== null && !Array.isArray(provider) &&
          !Object.prototype.hasOwnProperty.call(provider, 'automaticEligible')
            ? { automaticEligible: true, ...provider }
            : provider),
      }),
      {
        ...init,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/json',
          ...init.headers,
        },
      },
    ),
    url,
  )

const jsonResponse = (body: unknown): Response => responseAt(new Response(
  JSON.stringify(body),
  { headers: { 'content-type': 'application/json' } },
))

const textResponse = (body: string, contentType = 'application/json'): Response => responseAt(
  new Response(body, { headers: { 'content-type': contentType } }),
)

const repoIds = (registry: ProviderRegistry) =>
  registry.enabled().map(({ provider }) => provider.id)

const selectableIds = (registry: ProviderRegistry) =>
  registry.selectable().map(({ provider }) => provider.id)

describe('runtime provider repository', () => {
  it('uses server effective state and priority for canonical providers', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'jellyfin', available: true, enabled: true, automaticEligible: true, priority: 10 },
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 30 },
        {
          id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 20,
          userKeySupported: true, ownerFallbackAvailable: true,
        },
      ])),
      now: () => 1_000,
    })

    const registry = await repository.load()
    expect(repoIds(registry)).toEqual(['chksz', 'lx'])
    expect(selectableIds(registry)).toEqual(['chksz', 'lx'])
  })

  it.each([
    ['chksz', ['lx', 'gd-studio']],
    ['lx', ['chksz', 'gd-studio']],
    ['gd-studio', ['chksz', 'lx']],
  ] as const)('does not select Admin-disabled %s in the runtime registry', async (disabledId, expectedIds) => {
    const configuredProviders = [
      {
        id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 10,
        userKeySupported: true, ownerFallbackAvailable: false,
      },
      { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 20 },
      { id: 'gd-studio', available: true, enabled: true, automaticEligible: true, priority: 30 },
    ].map((provider) => provider.id === disabledId ? { ...provider, enabled: false } : provider)
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse(configuredProviders)),
      chkszCredentials: {
        key: () => 'test_user_key',
        revision: () => 0,
      },
      providerPreferences: {
        isDisabled: () => false,
        revision: () => 0,
      },
      lxProviderFactory: () => ({ id: 'lx', resolve: async () => null }),
    })

    expect(repoIds(await repository.load())).toEqual(expectedIds)
  })

  it('omits disabled and deployment-unavailable providers', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'gd-studio', available: true, enabled: false, priority: 10 },
        { id: 'lx', available: false, enabled: true, priority: 20 },
      ])),
    })

    expect(repoIds(await repository.load())).toEqual([])
  })

  it('strictly obeys server/admin priority even when a valid ChKSz user key exists', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'gd-studio', available: true, enabled: true, automaticEligible: true, priority: 10 },
        {
          id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 20,
          userKeySupported: true, ownerFallbackAvailable: false,
        },
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 30 },
      ])),
      chkszCredentials: {
        key: () => 'chksz_valid_personal_key_123',
        revision: () => 1,
      },
    })

    const registry = await repository.load()
    expect(repoIds(registry)).toEqual(['gd-studio', 'chksz', 'lx'])
  })

  it('instantiates the default lx composite provider with canResolve', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 10 },
      ])),
    })

    const registry = await repository.load()
    const lxReg = registry.enabled().find((r) => r.provider.id === 'lx')
    expect(lxReg).toBeDefined()
    expect(lxReg?.provider.id).toBe('lx')
    expect(typeof lxReg?.provider.canResolve).toBe('function')
  })

  it('uses custom lxProviderFactory when provided', async () => {
    const customProvider: AudioProvider = {
      id: 'lx',
      canResolve: () => true,
      resolve: async () => null,
    }
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 10 },
      ])),
      lxProviderFactory: () => customProvider,
    })

    const registry = await repository.load()
    const lxReg = registry.enabled().find((r) => r.provider.id === 'lx')
    expect(lxReg?.provider).toBe(customProvider)
  })

  it.each([
    'meting',
    'piped',
    'lx-huibq',
    'lx-ikun',
    'invidious',
    'qijie',
    'r2',
    'youtube',
    'lx-huanyin',
  ])('fails closed and does not register removed legacy provider %s', async (legacyId) => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: legacyId, available: true, enabled: true, automaticEligible: true, priority: 10 },
      ])),
    })

    expect(repoIds(await repository.load())).toEqual([])
  })

  it('never registers or resolves historical legacy catalogue sources', async () => {
    const [track] = parseCatalog([{
      id: 'legacy-meting-track',
      title: 'Legacy Meting track',
      aliases: {},
      games: ['genshin'],
      relationIds: [],
      tabs: ['focus'],
      workGroupId: 'legacy-meting-work',
      vocalStatus: 'instrumental',
      needsClassification: false,
      sources: [
        { provider: 'public-meting', externalId: 'legacy-public-track' },
        { provider: 'meting-agent', externalId: 'legacy-agent-track' },
      ],
    }])
    const fetcher = vi.fn()
      .mockResolvedValueOnce(configResponse([
        { id: 'public-meting', available: true, enabled: true, priority: 6 },
      ]))
    const proxyFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseAt(new Response('{}')))
    try {
      const repository = createRuntimeProviderRepository({ fetch: fetcher })
      const registry = await repository.load()
      const result = await resolveTrack(track!, registry)

      expect({ ids: repoIds(registry), result, configCalls: fetcher.mock.calls.length, proxyCalls: proxyFetch.mock.calls.length }).toEqual({
        ids: [],
        result: { ok: false, code: 'exhausted', attempts: [] },
        configCalls: 1,
        proxyCalls: 0,
      })
    } finally {
      proxyFetch.mockRestore()
    }
  })

  it.each([
    ['CN + user key', true, false, 'chksz_USER_KEY_SENTINEL', ['chksz'], ['chksz']],
    ['CN + usable Owner fallback', true, true, null, ['chksz'], ['chksz']],
    ['CN + no credential', true, false, null, [], []],
    ['non-CN + manual user key', false, false, 'chksz_USER_KEY_SENTINEL', [], ['chksz']],
  ] as const)(
    'applies ChKSz credential eligibility for %s',
    async (_label, automaticEligible, ownerFallbackAvailable, userKey, automaticIds, manualIds) => {
      const repository = createRuntimeProviderRepository({
        chkszCredentials: { key: () => userKey, revision: () => 0 },
        fetch: vi.fn().mockResolvedValue(configResponse([{
          id: 'chksz',
          available: true,
          enabled: true,
          automaticEligible,
          priority: 11,
          userKeySupported: true,
          ownerFallbackAvailable,
        }])),
      })

      const registry = await repository.load()
      expect(repoIds(registry)).toEqual(automaticIds)
      expect(selectableIds(registry)).toEqual(manualIds)
      expect(registry.enabled('chksz').map(({ provider }) => provider.id)).toEqual(manualIds)
    },
  )

  it('uses a successful cached registry only within the exact five-second TTL', async () => {
    let now = 1_000
    const fetcher = vi.fn()
      .mockResolvedValueOnce(configResponse([
        { id: 'gd-studio', available: true, enabled: true, priority: 2 },
      ]))
      .mockResolvedValueOnce(configResponse([]))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => now })

    expect(selectableIds(await repository.load())).toEqual(['gd-studio'])
    now += 4_999
    expect(selectableIds(await repository.load())).toEqual(['gd-studio'])
    now += 1
    expect(repoIds(await repository.load())).toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('fails closed after five seconds when refresh is unavailable', async () => {
    let now = 1_000
    const fetcher = vi.fn()
      .mockResolvedValueOnce(configResponse([
        { id: 'gd-studio', available: true, enabled: true, priority: 2 },
      ]))
      .mockRejectedValueOnce(new Error('offline'))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => now })

    expect(selectableIds(await repository.load())).toEqual(['gd-studio'])
    now += 5_001
    expect(repoIds(await repository.load())).toEqual([])
  })

  it('forces a refresh inside the TTL and replaces stale state on failure', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(configResponse([
        { id: 'gd-studio', available: true, enabled: true, priority: 2 },
      ]))
      .mockRejectedValueOnce(new Error('backend unavailable'))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => 1_000 })

    expect(selectableIds(await repository.load())).toEqual(['gd-studio'])
    expect(repoIds(await repository.load({ forceRefresh: true }))).toEqual([])
    expect(repoIds(await repository.load())).toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent loads into one in-flight request', async () => {
    let complete: ((response: Response) => void) | undefined
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve }))
    const repository = createRuntimeProviderRepository({ fetch: fetcher })

    const first = repository.load()
    const second = repository.load({ forceRefresh: true })
    complete?.(configResponse([
      { id: 'gd-studio', available: true, enabled: true, priority: 2 },
    ]))

    expect(selectableIds(await first)).toEqual(['gd-studio'])
    expect(await second).toBe(await first)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('requests only the same-origin config endpoint and rejects redirected responses', async () => {
    const response = responseAt(configResponse([
      { id: 'gd-studio', available: true, enabled: true, priority: 2 },
    ]), CONFIG_URL, true)
    const fetcher = vi.fn().mockResolvedValue(response)
    const repository = createRuntimeProviderRepository({ fetch: fetcher })

    expect(repoIds(await repository.load())).toEqual([])
    expect(fetcher).toHaveBeenCalledWith(CONFIG_URL, expect.objectContaining({
      cache: 'no-store',
      method: 'GET',
      redirect: 'error',
    }))
  })

  it.each([
    ['an empty final URL', ''],
    ['a different origin', 'https://other.example/api/providers/config'],
    ['a query string', `${CONFIG_URL}?cache=stale`],
    ['a fragment', `${CONFIG_URL}#redirected`],
    ['a different path', new URL('/api/providers/other', window.location.origin).toString()],
  ])('rejects %s even when the response is not marked redirected', async (_case, responseUrl) => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'gd-studio', available: true, enabled: true, priority: 2 },
      ], {}, responseUrl)),
    })

    expect(repoIds(await repository.load())).toEqual([])
  })

  it.each([
    ['an unavailable status', configResponse([], { status: 503 })],
    ['a non-JSON MIME type', configResponse([], { headers: { 'content-type': 'text/html' } })],
    ['non-JSON content', textResponse('<html>')],
    ['an unsupported version', jsonResponse({ version: 2, providers: [] })],
    ['extra root keys', jsonResponse({ version: 1, providers: [], secret: 'nope' })],
    ['unknown provider IDs', configResponse([{ id: 'custom', available: true, enabled: true, priority: 1 }])],
    ['legacy public Meting provider IDs', configResponse([{ id: 'public-meting', available: false, enabled: false, priority: 6 }])],
    ['legacy Meting agent provider IDs', configResponse([{ id: 'meting-agent', available: false, enabled: false, priority: 4 }])],
    ['non-boolean state', configResponse([{ id: 'gd-studio', available: 1, enabled: true, priority: 2 }])],
    ['out-of-range priority', configResponse([{ id: 'gd-studio', available: true, enabled: true, priority: 1_001 }])],
    ['fractional priority', configResponse([{ id: 'gd-studio', available: true, enabled: true, priority: 1.5 }])],
    ['extra provider keys', configResponse([{ id: 'gd-studio', available: true, enabled: true, priority: 2, endpoint: 'https://evil.example/' }])],
    ['duplicate provider IDs', configResponse([
      { id: 'gd-studio', available: true, enabled: true, priority: 2 },
      { id: 'gd-studio', available: true, enabled: true, priority: 3 },
    ])],
    ['unsupported provider config', configResponse([
      {
        id: 'gd-studio', available: true, enabled: true, priority: 2,
        config: { baseUrl: 'https://media.example/', allowedHostnames: ['media.example'] },
      },
    ])],
    ['unsupported ChKSz config leakage', configResponse([
      {
        id: 'chksz', available: true, enabled: true, priority: 10,
        userKeySupported: true, ownerFallbackAvailable: true,
        config: { baseUrl: 'https://media.example/' },
      },
    ])],
  ])('fails closed for %s', async (_case, response) => {
    const repository = createRuntimeProviderRepository({ fetch: vi.fn().mockResolvedValue(response) })

    expect(repoIds(await repository.load())).toEqual([])
  })

  it('prefetch absorbs repository failures without blocking its caller', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockRejectedValue(new Error('offline')),
    })

    await expect(repository.prefetch()).resolves.toBeUndefined()
    expect(repoIds(await repository.load())).toEqual([])
  })

  it('allows injecting a custom lxProviderFactory', async () => {
    const customLxProvider: AudioProvider = {
      id: 'lx',
      canResolve: () => true,
      resolve: vi.fn().mockResolvedValue(null),
    }
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 10 },
      ])),
      lxProviderFactory: () => customLxProvider,
    })

    const registry = await repository.load()
    const registrations = registry.enabled()
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.provider).toBe(customLxProvider)
  })

  it('falls back to default stub lx provider returning null when lxProviderFactory is omitted', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 10 },
      ])),
    })

    const registry = await repository.load()
    const registrations = registry.enabled()
    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.provider.id).toBe('lx')
    const signal = new AbortController().signal
    const dummyTrack = { id: 't1', title: 'T1', aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'w1', vocalStatus: 'instrumental', needsClassification: false, sources: [] } as never
    await expect(registrations[0]?.provider.resolve(dummyTrack, signal)).resolves.toBeNull()
  })

  it('returns public provider states in order', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'jellyfin', available: true, enabled: true, automaticEligible: true, priority: 10 },
        { id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 20, userKeySupported: true, ownerFallbackAvailable: true },
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 30 },
      ])),
    })

    const states = await repository.states()
    expect(states).toEqual([
      { id: 'jellyfin', available: true, enabled: true, automaticEligible: true, priority: 10 },
      { id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 20 },
      { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 30 },
    ])
  })
})

describe('user provider preferences in the runtime registry', () => {
  const fullChain = [
    {
      id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 10,
      userKeySupported: true, ownerFallbackAvailable: true,
    },
    { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 20 },
    { id: 'gd-studio', available: true, enabled: true, automaticEligible: true, priority: 30 },
  ]

  const preferenceStore = (disabled: string[] = []) => {
    const ids = new Set(disabled)
    let revision = 0
    return {
      disabledProviderIds: () => new Set(ids),
      isDisabled: (id: string) => ids.has(id),
      revision: () => revision,
      setDisabled(id: string, disable: boolean) {
        if (ids.has(id) === disable) return
        if (disable) ids.add(id)
        else ids.delete(id)
        revision += 1
      },
    }
  }

  it('excludes a user-disabled provider from the registry', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse(fullChain)),
      providerPreferences: preferenceStore(['lx']),
    })

    expect(repoIds(await repository.load())).toEqual(['chksz', 'gd-studio'])
  })

  it('excludes a user-disabled provider from manual selection as well', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse(fullChain)),
      providerPreferences: preferenceStore(['chksz', 'gd-studio']),
    })

    const registry = await repository.load()
    expect(selectableIds(registry)).toEqual(['lx'])
  })

  it('cannot resurrect a deployment-unavailable provider', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'gd-studio', available: false, enabled: true, automaticEligible: true, priority: 10 },
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 20 },
      ])),
      providerPreferences: preferenceStore([]),
    })

    expect(repoIds(await repository.load())).toEqual(['lx'])
  })

  it('cannot resurrect an Admin-disabled provider', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        { id: 'lx', available: true, enabled: false, automaticEligible: true, priority: 20 },
        { id: 'gd-studio', available: true, enabled: true, automaticEligible: true, priority: 30 },
      ])),
      providerPreferences: preferenceStore([]),
    })

    expect(repoIds(await repository.load())).toEqual(['gd-studio'])
  })

  it('keeps ChKSz out of Automatic when the server says it is not eligible', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        {
          id: 'chksz', available: true, enabled: true, automaticEligible: false, priority: 10,
          userKeySupported: true, ownerFallbackAvailable: true,
        },
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 20 },
      ])),
      providerPreferences: preferenceStore([]),
    })

    const registry = await repository.load()
    expect(repoIds(registry)).toEqual(['lx'])
    expect(selectableIds(registry)).toEqual(['chksz', 'lx'])
  })

  it('excludes a user-disabled ChKSz even when it is CN-eligible and credentialed', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([
        {
          id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 10,
          userKeySupported: true, ownerFallbackAvailable: true,
        },
        { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 20 },
      ])),
      providerPreferences: preferenceStore(['chksz']),
    })

    expect(repoIds(await repository.load())).toEqual(['lx'])
  })

  it('rebuilds the registry at the next resolution boundary after a local toggle', async () => {
    const preferences = preferenceStore([])
    const fetchImpl = vi.fn().mockResolvedValue(configResponse(fullChain))
    const repository = createRuntimeProviderRepository({
      fetch: fetchImpl,
      now: () => 1_000,
      providerPreferences: preferences,
    })

    expect(repoIds(await repository.load())).toContain('lx')
    preferences.setDisabled('lx', true)

    // Still inside the five-second server-config TTL: the preference change alone
    // must invalidate the cached registry.
    expect(repoIds(await repository.load())).not.toContain('lx')
  })

  it('reuses the cached registry when no preference changed', async () => {
    const preferences = preferenceStore([])
    const fetchImpl = vi.fn().mockResolvedValue(configResponse(fullChain))
    const repository = createRuntimeProviderRepository({
      fetch: fetchImpl,
      now: () => 1_000,
      providerPreferences: preferences,
    })

    await repository.load()
    await repository.load()

    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('resolves through the next eligible provider when the preferred one is disabled', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse(fullChain)),
      providerPreferences: preferenceStore(['chksz']),
    })

    expect(repoIds(await repository.load())).toEqual(['lx', 'gd-studio'])
  })

  it('produces an empty registry when the user disables everything eligible', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse(fullChain)),
      providerPreferences: preferenceStore(['chksz', 'lx', 'gd-studio']),
    })

    expect(repoIds(await repository.load())).toEqual([])
  })
})

describe('ordered provider registry and ChKSz user key behavior', () => {
  const threeProviderChain = [
    { id: 'gd-studio', available: true, enabled: true, automaticEligible: true, priority: 10 },
    {
      id: 'chksz',
      available: true,
      enabled: true,
      automaticEligible: true,
      priority: 20,
      userKeySupported: true,
      ownerFallbackAvailable: false,
    },
    { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 30 },
  ]

  it('registry order strictly obeys server/admin priority even when a valid ChKSz user key exists', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse(threeProviderChain)),
      chkszCredentials: {
        key: () => 'chksz_valid_personal_key_123',
        revision: () => 1,
      },
    })

    const registry = await repository.load()
    expect(repoIds(registry)).toEqual(['gd-studio', 'chksz', 'lx'])
  })

  it('omits ChKSz when no local key exists and owner fallback is not available', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse(threeProviderChain)),
      chkszCredentials: {
        key: () => null,
        revision: () => 0,
      },
    })

    const registry = await repository.load()
    expect(repoIds(registry)).toEqual(['gd-studio', 'lx'])
  })

  it('includes ChKSz at its exact server priority when owner fallback is available without local key', async () => {
    const chainWithOwnerFallback = [
      threeProviderChain[0],
      { ...threeProviderChain[1], ownerFallbackAvailable: true },
      threeProviderChain[2],
    ]
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse(chainWithOwnerFallback)),
      chkszCredentials: {
        key: () => null,
        revision: () => 0,
      },
    })

    const registry = await repository.load()
    expect(repoIds(registry)).toEqual(['gd-studio', 'chksz', 'lx'])
  })

  it('updates credential eligibility immediately on local key revision without promoting priority', async () => {
    let key: string | null = null
    let revision = 0
    const fetchImpl = vi.fn().mockResolvedValue(configResponse(threeProviderChain))
    const repository = createRuntimeProviderRepository({
      fetch: fetchImpl,
      now: () => 1_000,
      chkszCredentials: {
        key: () => key,
        revision: () => revision,
      },
    })

    const initialRegistry = await repository.load()
    // No key + no owner fallback -> chksz excluded
    expect(repoIds(initialRegistry)).toEqual(['gd-studio', 'lx'])

    // User adds a valid key locally
    key = 'chksz_user_added_key'
    revision = 1

    // Within 5s TTL, fetch should not be called again, chksz is now eligible but strictly at server priority (10 < 20 < 30)
    const updatedRegistry = await repository.load()
    expect(repoIds(updatedRegistry)).toEqual(['gd-studio', 'chksz', 'lx'])
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('respects user provider exclusions for chksz and cannot resurrect server-disabled providers', async () => {
    const chainWithDisabled = [
      threeProviderChain[0],
      threeProviderChain[1],
      { id: 'lx', available: true, enabled: false, automaticEligible: true, priority: 30 },
    ]
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse(chainWithDisabled)),
      chkszCredentials: {
        key: () => 'chksz_valid_personal_key_123',
        revision: () => 1,
      },
      providerPreferences: {
        isDisabled: (id: string) => id === 'chksz',
        revision: () => 0,
      },
    })

    const registry = await repository.load()
    // chksz excluded by user, lx disabled by server
    expect(repoIds(registry)).toEqual(['gd-studio'])
    expect(selectableIds(registry)).not.toContain('chksz')
    expect(selectableIds(registry)).not.toContain('lx')
  })
})

/**
 * LX Music is not ready for the public release. Hiding its controls is only half the
 * requirement: an Admin-disabled LX must also be excluded from automatic resolution and
 * fallback, and neither a stored preference nor an imported script may bring it back.
 * The registry is the single gate -- a provider that is not registered cannot be resolved
 * even by an explicit per-track source override, and `isProviderEnabled` is the one
 * predicate the registry and the settings surface both read.
 */
describe('LX public-release gating', () => {
  const lxTrack = () => parseCatalog([{
    id: 'lx-only-track',
    title: 'LX-only track',
    aliases: {},
    games: ['genshin'],
    relationIds: [],
    tabs: ['focus'],
    workGroupId: 'lx-only-work',
    vocalStatus: 'instrumental',
    needsClassification: false,
    sources: [{ provider: 'lx', externalId: 'lx-external-id' }],
  }])[0]!

  const lxConfig = (lx: { available: boolean; enabled: boolean }) => configResponse([
    { id: 'lx', ...lx, automaticEligible: lx.available && lx.enabled, priority: 10 },
  ])

  it('is the single, fail-closed definition of an effective provider', () => {
    const row = (available: boolean, enabled: boolean) => ({
      id: 'lx' as const, available, enabled, automaticEligible: available && enabled, priority: 10,
    })

    expect(isProviderEnabled([row(true, true)], 'lx')).toBe(true)
    expect(isProviderEnabled([row(true, false)], 'lx')).toBe(false)
    expect(isProviderEnabled([row(false, true)], 'lx')).toBe(false)
    expect(isProviderEnabled([], 'lx')).toBe(false)
    expect(isProviderEnabled([{ ...row(true, true), id: 'chksz' }], 'lx')).toBe(false)
  })

  it('excludes Admin-disabled LX from automatic resolution and never attempts it', async () => {
    const resolve = vi.fn(async () => null)
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(lxConfig({ available: true, enabled: false })),
      lxProviderFactory: () => ({ id: 'lx', canResolve: () => true, resolve }),
    })

    const registry = await repository.load()
    const result = await resolveTrack(lxTrack(), registry)

    expect(result).toEqual({ ok: false, code: 'exhausted', attempts: [] })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('ignores an explicit per-track source override for a disabled LX', async () => {
    const resolve = vi.fn(async () => null)
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(lxConfig({ available: true, enabled: false })),
      lxProviderFactory: () => ({ id: 'lx', canResolve: () => true, resolve }),
    })

    const registry = await repository.load()
    const result = await resolveTrack(lxTrack(), registry, { sourceOverride: 'lx' })

    expect(result).toEqual({ ok: false, code: 'exhausted', attempts: [] })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('cannot be resurrected by a user preference that leaves LX enabled', async () => {
    const resolve = vi.fn(async () => null)
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(lxConfig({ available: true, enabled: false })),
      // A preference excludes providers; it must never be able to include one.
      providerPreferences: { isDisabled: () => false, revision: () => 0 },
      lxProviderFactory: () => ({ id: 'lx', canResolve: () => true, resolve }),
    })

    const registry = await repository.load()
    expect(repoIds(registry)).toEqual([])
    expect((await resolveTrack(lxTrack(), registry)).ok).toBe(false)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('resolves through LX again once the administrator enables it', async () => {
    const resolve = vi.fn(async () => ({
      kind: 'audio' as const,
      url: 'https://cdn.example/lx-track.mp3',
      mimeType: 'audio/mpeg',
    }))
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(lxConfig({ available: true, enabled: true })),
      lxProviderFactory: () => ({ id: 'lx', canResolve: () => true, resolve }),
    })

    const registry = await repository.load()
    const result = await resolveTrack(lxTrack(), registry)

    expect(result).toMatchObject({ ok: true, providerId: 'lx' })
    expect(resolve).toHaveBeenCalledTimes(1)
  })
})

describe('ChKSz selected quality reaches the upstream request', () => {
  const CHKSZ_EXTERNAL_ID = '9000000003'
  const CHKSZ_MEDIA_URL = 'https://m801.music.126.net/20260913/abc123/xyz.mp3'

  const [qualityTrack] = parseCatalog([{
    id: 'demo-zzz-study',
    title: 'Demo ZZZ Study',
    aliases: {},
    games: ['zzz'],
    relationIds: [],
    tabs: ['chill'],
    workGroupId: 'zzz',
    vocalStatus: 'instrumental',
    needsClassification: false,
    sources: [{ provider: 'chksz', externalId: CHKSZ_EXTERNAL_ID }],
  }])

  // The runtime repository does not forward its own `fetch` into the ChKSz provider, so the
  // browser-direct upstream call is observable only on the global fetch.
  const spyOnUpstream = (): { urls: URL[]; restore: () => void } => {
    const urls: URL[] = []
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      urls.push(url)
      // Echo the requested level so a valid metadata body is returned for whichever level the
      // provider actually asked for: the only thing under test is the outbound request.
      const level = url.searchParams.get('level') ?? 'standard'
      return new Response(
        JSON.stringify({
          code: 200,
          data: { id: Number(CHKSZ_EXTERNAL_ID), level, url: CHKSZ_MEDIA_URL },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    })
    return { urls, restore: () => spy.mockRestore() }
  }

  it.each([
    ['exhigh', 'exhigh'],
    ['hires', 'hires'],
  ] as const)(
    'sends the user-selected %s quality upstream as %s',
    async (quality, expectedLevel) => {
      const upstream = spyOnUpstream()
      try {
        const repository = createRuntimeProviderRepository({
          fetch: vi.fn(async () => configResponse([{
            id: 'chksz',
            available: true,
            enabled: true,
            automaticEligible: true,
            priority: 10,
            userKeySupported: true,
            ownerFallbackAvailable: false,
          }])),
          chkszCredentials: {
            key: () => 'chksz_valid_personal_key_123',
            revision: () => 1,
          },
          qualityStore: { chkszQuality: () => quality },
        })

        const registry = await repository.load()
        const registration = registry.enabled().find((entry) => entry.provider.id === 'chksz')
        expect(registration).toBeDefined()

        await registration!.provider.resolve(qualityTrack!, new AbortController().signal)

        expect(upstream.urls).toHaveLength(1)
        expect(upstream.urls[0]!.origin).toBe('https://api.chksz.com')
        expect(upstream.urls[0]!.searchParams.get('level')).toBe(expectedLevel)
      } finally {
        upstream.restore()
      }
    },
  )
})


it('restores the standalone GD Studio adapter independently of LX and honours its own user exclusion', async () => {
  const providers = [{ id: 'gd-studio', available: true, enabled: true, automaticEligible: true, priority: 40 }]
  const repository = createRuntimeProviderRepository({ fetch: vi.fn().mockResolvedValue(configResponse(providers)), now: () => 1_000 })
  const registry = await repository.load()
  expect(repoIds(registry)).toEqual(['gd-studio'])
  const canonical = { id: 'gd-song', sources: [{ provider: 'chksz', externalId: '9000000002' }] } as never
  expect(registry.enabled()[0]?.provider.canResolve?.(canonical)).toBe(true)
  const excluded = createRuntimeProviderRepository({
    fetch: vi.fn().mockResolvedValue(configResponse(providers)), now: () => 1_000,
    providerPreferences: { isDisabled: (id) => id === 'gd-studio', revision: () => 1 },
  })
  expect(repoIds(await excluded.load())).toEqual([])
})


it('forwards live GD Studio quality preferences through the production runtime registry', async () => {
  let quality = '999' as '999' | '128'
  const mediaFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { externalId } = JSON.parse(String(init?.body)) as { externalId: string }
    return responseAt(Response.json({
      url: `/api/providers/gd-studio/media/${encodeURIComponent(externalId)}/abcdefghijklmnopqrstuvwxyzABCDEF`,
      mimeType: 'audio/mpeg',
    }), window.location.origin + '/api/providers/gd-studio/resolve')
  })
  vi.stubGlobal('fetch', mediaFetch)
  try {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([{ id: 'gd-studio', available: true, enabled: true, priority: 40 }])),
      qualityStore: { chkszQuality: () => 'standard', gdStudioQuality: () => quality },
    })
    const provider = (await repository.load()).enabled()[0]!.provider
    const track = { id: 'gd-quality', sources: [{ provider: 'chksz', externalId: '9000000002' }] } as never
    for (const selected of ['999', '128'] as const) {
      quality = selected
      await provider.resolve(track, new AbortController().signal)
      expect(JSON.parse(String(mediaFetch.mock.calls.at(-1)?.[1]?.body))).toEqual({ externalId: `netease:9000000002:${selected}` })
    }
  } finally {
    vi.unstubAllGlobals()
  }
})

it('keeps provider identities after an unchanged server refresh so fresh fallback preparations remain reusable', async () => {
  let now = 1_000
  let priority = 10
  let preferenceRevision = 0
  const fetchConfig = vi.fn(async () => configResponse([
    { id: 'lx', available: true, enabled: true, automaticEligible: true, priority },
  ]))
  const lxProviderFactory = vi.fn((): AudioProvider => ({ id: 'lx', canResolve: () => true, resolve: async () => null }))
  const repository = createRuntimeProviderRepository({
    fetch: fetchConfig, now: () => now, lxProviderFactory,
    providerPreferences: { isDisabled: () => false, revision: () => preferenceRevision },
  })
  const first = await repository.load()
  now += 5_001
  const refreshed = await repository.load()
  expect(fetchConfig).toHaveBeenCalledTimes(2)
  expect(refreshed).toBe(first)
  expect(lxProviderFactory).toHaveBeenCalledTimes(1)

  // A deliberate force refresh must still renew provider instances for a failed active source.
  const forced = await repository.load({ forceRefresh: true })
  expect(forced).not.toBe(first)
  expect(lxProviderFactory).toHaveBeenCalledTimes(2)
  now += 5_001
  priority = 11
  const changed = await repository.load()
  expect(changed).not.toBe(forced)
  expect(changed.enabled()[0]?.priority).toBe(11)
  now += 5_001
  preferenceRevision++
  const preferencesChanged = await repository.load()
  expect(preferencesChanged).not.toBe(changed)
})

describe('Vkeys runtime registration', () => {
  const defaultProviders = [
    { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 20 },
    { id: 'gd-studio', available: true, enabled: true, automaticEligible: true, priority: 40 },
  ]
  const vkeysRow = { id: 'vkeys', available: true, enabled: true, automaticEligible: true, priority: 50 }
  const preferences = { isDisabled: () => false, revision: () => 0 }

  it('appends Vkeys to the canonical provider IDs', () => {
    expect(CANONICAL_PROVIDER_IDS.at(-1)).toBe('vkeys')
  })

  it('gives Vkeys ten seconds while preserving the LX deadline and LX/GD order', async () => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([...defaultProviders, vkeysRow])),
      providerPreferences: preferences,
    })
    const registry = await repository.load()
    expect(registry.enabled().map(({ provider, timeoutMs }) => [provider.id, timeoutMs])).toEqual([
      ['lx', LX_INIT_TIMEOUT_MS + LX_RESOLVE_TIMEOUT_MS + MEDIA_PROBE_TIMEOUT_MS + LX_RPC_GRACE_MS],
      ['gd-studio', 4_000], ['vkeys', 10_000],
    ])
    expect(isProviderEnabled(await repository.states(), 'vkeys')).toBe(true)
    const provider = registry.enabled().find(({ provider }) => provider.id === 'vkeys')!.provider
    const canonical = { id: 'canonical-song', sources: [{ provider: 'chksz', externalId: '42' }] } as never
    expect(provider.canResolve?.(canonical)).toBe(true)
    expect(provider.canResolve?.({ id: 'canonical-song', sources: [] } as never)).toBe(false)
  })

  it.each([
    ['absent', []],
    ['unavailable', [{ ...vkeysRow, available: false }]],
    ['disabled', [{ ...vkeysRow, enabled: false }]],
    ['unavailable and disabled', [{ ...vkeysRow, available: false, enabled: false }]],
  ])('never enables Vkeys when its public row is %s', async (_case, rows) => {
    const repository = createRuntimeProviderRepository({
      fetch: vi.fn().mockResolvedValue(configResponse([...defaultProviders, ...rows])),
      providerPreferences: preferences,
    })
    const registry = await repository.load()
    expect(repoIds(registry)).toEqual(['lx', 'gd-studio'])
    expect(selectableIds(registry)).toEqual(['lx', 'gd-studio'])
    expect(registry.enabled('vkeys')).toEqual([])
    expect(isProviderEnabled(await repository.states(), 'vkeys')).toBe(false)
  })

  it('honours Vkeys automatic eligibility and its own user exclusion', async () => {
    const fetcher = vi.fn(async () => configResponse([
      ...defaultProviders, { ...vkeysRow, automaticEligible: false },
    ]))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, providerPreferences: preferences })
    const registry = await repository.load()
    expect(repoIds(registry)).toEqual(['lx', 'gd-studio'])
    expect(selectableIds(registry)).toEqual(['lx', 'gd-studio', 'vkeys'])
    expect(registry.enabled('vkeys')[0]?.timeoutMs).toBe(10_000)
    const excluded = createRuntimeProviderRepository({
      fetch: fetcher,
      providerPreferences: { isDisabled: (id) => id === 'vkeys', revision: () => 1 },
    })
    expect(selectableIds(await excluded.load())).toEqual(['lx', 'gd-studio'])
  })

  it('drops Vkeys when a refreshed public configuration omits its row', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(configResponse([...defaultProviders, vkeysRow]))
      .mockResolvedValueOnce(configResponse(defaultProviders))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, providerPreferences: preferences })
    expect(repoIds(await repository.load())).toEqual(['lx', 'gd-studio', 'vkeys'])
    expect(repoIds(await repository.load({ forceRefresh: true }))).toEqual(['lx', 'gd-studio'])
  })
})
