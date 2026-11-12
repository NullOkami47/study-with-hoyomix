import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import type { LxSourceRecord } from './lx/types'
import type { LxGlobalSourceRepository } from './lx/globalSourceRepository'
import type { ProviderAttempt } from './providers/types'
import { createPlaybackStore } from './store'
import { createRuntimeProviderRepository } from './runtimeConfig'

/**
 * End-to-end wiring proof for spec §11 sub-source diagnostics.
 *
 * The LX source repository and the QuickJS runtime client are mocked at the module boundary so
 * the *default* `createLxUserProvider()` factory inside `createRuntimeProviderRepository` runs
 * for real — the relay under test is the production one, not a test stand-in. Everything else
 * (repository, store, resolver, composite LX provider) is the shipped implementation.
 */
const lxMock = vi.hoisted(() => ({
  list: vi.fn(),
  loadSource: vi.fn(),
  callMusicUrl: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('./lx/sourceRepository', () => ({
  getDefaultLxSourceRepository: () => ({
    list: lxMock.list,
    get: vi.fn(),
    setEnabled: vi.fn(),
    reorder: vi.fn(),
    delete: vi.fn(),
    importScript: vi.fn(),
    importRemote: vi.fn(),
    refreshRemote: vi.fn(),
  }),
}))

vi.mock('./lx/runtime/client', () => ({
  LxRuntimeClient: class {
    loadSource = lxMock.loadSource
    callMusicUrl = lxMock.callMusicUrl
    dispose = lxMock.dispose
  },
}))

const CONFIG_URL = new URL('/api/providers/config', window.location.origin).toString()

function configResponse(providers: unknown[]): Response {
  const response = new Response(JSON.stringify({ version: 1, providers }), {
    headers: { 'content-type': 'application/json' },
  })
  Object.defineProperties(response, {
    redirected: { configurable: true, value: false },
    url: { configurable: true, value: CONFIG_URL },
  })
  return response
}

const lxTrack: Track = {
  id: 'track-lx-sub',
  title: 'A New Day',
  aliases: {},
  games: ['zzz'],
  relationIds: [],
  tabs: ['focus'],
  workGroupId: 'work-lx-sub',
  vocalStatus: 'instrumental',
  needsClassification: false,
  sources: [{ provider: 'lx', externalId: 'wy:9000000001' }],
}

function lxSource(id: string, name: string, priority: number, script: string): LxSourceRecord {
  return {
    id,
    name,
    sha256: `sha256-${id}`,
    enabled: true,
    priority,
    script,
    builtIn: id.startsWith('builtin'),
    importedAt: 1_000,
    updatedAt: 1_000,
  }
}

const BUILTIN = lxSource('builtin-kulao-svip', '褲佬 SVIP', 1, '// builtin script')
const USER_SOURCE = lxSource('user-mine', 'My Source', 2, '// user script')
const MANAGED_KULAO = lxSource('global:builtin-kulao-svip', '褲佬 SVIP', 1, '// managed script')
const globalSourceRepository: LxGlobalSourceRepository = {
  managesBundledSource: true,
  list: async () => [MANAGED_KULAO],
  revision: () => 1,
  pendingApproval: () => [],
  invalidate: () => undefined,
}

const lxSubAttempts = (attempts: readonly ProviderAttempt[]): ProviderAttempt[] =>
  attempts.filter((attempt) => attempt.providerId === 'lx' && attempt.sourceName !== undefined)

describe('LX sub-source attempts in playback diagnostics', () => {
  beforeEach(() => {
    lxMock.list.mockReset().mockResolvedValue([BUILTIN, USER_SOURCE])
    // The legacy local copy remains stored but is suppressed by the authoritative registry.
    // The administrator-published source times out, while the user source loads but cannot produce
    // a playable URL: both must surface as distinct sub-attempt lines.
    lxMock.loadSource.mockReset().mockImplementation(async (script: string) => {
      if (script === MANAGED_KULAO.script) throw new Error('LX source load timed out')
      return { initedMeta: undefined }
    })
    lxMock.callMusicUrl.mockReset().mockRejectedValue(new Error('upstream refused'))
    lxMock.dispose.mockReset().mockResolvedValue(undefined)
  })

  it('surfaces one diagnostics entry per LX sub-source through store.attempts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(configResponse([
      { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 10 },
    ]))
    const repository = createRuntimeProviderRepository({ fetch: fetchImpl, now: () => 1_000, globalSourceRepository })
    const store = createPlaybackStore({ loadRegistry: repository.load })

    await store.playNow(lxTrack)

    // The real composite provider ran: its single top-level attempt is recorded.
    expect(store.attempts.value).toContainEqual(
      expect.objectContaining({ providerId: 'lx', ok: false, code: 'unavailable' }),
    )
    // ...and each of its sub-source attempts must appear as an additional entry.
    expect(lxSubAttempts(store.attempts.value)).toEqual([
      expect.objectContaining({
        providerId: 'lx', sourceId: MANAGED_KULAO.id, sourceName: '褲佬 SVIP', ok: false, code: 'timeout',
      }),
      expect.objectContaining({
        providerId: 'lx', sourceId: USER_SOURCE.id, sourceName: 'My Source', ok: false, code: 'unavailable',
      }),
    ])
  })

  it('still delivers sub-attempts to a second resolution served from the cached registry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(configResponse([
      { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 10 },
    ]))
    // A frozen clock keeps the second load inside the five-second TTL, so the cached registry —
    // and therefore the cached LX provider instance — is reused.
    const repository = createRuntimeProviderRepository({ fetch: fetchImpl, now: () => 1_000, globalSourceRepository })
    const store = createPlaybackStore({ loadRegistry: repository.load })

    await store.playNow(lxTrack)
    expect(lxSubAttempts(store.attempts.value)).toHaveLength(2)

    await store.playNow(lxTrack)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(lxSubAttempts(store.attempts.value)).toEqual([
      expect.objectContaining({ sourceName: '褲佬 SVIP', ok: false, code: 'timeout' }),
      expect.objectContaining({ sourceName: 'My Source', ok: false, code: 'unavailable' }),
    ])
  })

  it('keeps delivering sub-attempts when an unrelated config load runs mid-resolution', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(configResponse([
      { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 10 },
    ]))
    const repository = createRuntimeProviderRepository({ fetch: fetchImpl, now: () => 1_000, globalSourceRepository })
    const store = createPlaybackStore({ loadRegistry: repository.load })

    // The repository reuses its LX provider, while the resolver owns this invocation's
    // sub-attempt context. An unrelated `states()` load must not affect that context: the
    // Control Centre's settings sheet can request state while playback is still resolving.
    let releaseSourceLoad: () => void = () => undefined
    const sourceLoadGate = new Promise<void>((resolve) => { releaseSourceLoad = resolve })
    lxMock.loadSource.mockImplementation(async (script: string) => {
      await sourceLoadGate
      if (script === MANAGED_KULAO.script) throw new Error('LX source load timed out')
      return { initedMeta: undefined }
    })

    const resolving = store.playNow(lxTrack)
    await repository.states()
    releaseSourceLoad()
    await resolving

    expect(lxSubAttempts(store.attempts.value)).toEqual([
      expect.objectContaining({ sourceId: MANAGED_KULAO.id, ok: false, code: 'timeout' }),
      expect.objectContaining({ sourceId: USER_SOURCE.id, ok: false, code: 'unavailable' }),
    ])
  })
})
