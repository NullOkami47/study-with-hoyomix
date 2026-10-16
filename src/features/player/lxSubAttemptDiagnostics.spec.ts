import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import type { LxSourceRecord } from './lx/types'
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
  sources: [{ provider: 'lx', externalId: 'wy:2100334024' }],
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

const BUILTIN = lxSource('synthetic-pinned-source', 'Synthetic Pinned Source', 1, '// builtin script')
const USER_SOURCE = lxSource('user-mine', 'My Source', 2, '// user script')

const lxSubAttempts = (attempts: readonly ProviderAttempt[]): ProviderAttempt[] =>
  attempts.filter((attempt) => attempt.providerId === 'lx' && attempt.sourceName !== undefined)

describe('LX sub-source attempts in playback diagnostics', () => {
  beforeEach(() => {
    lxMock.list.mockReset().mockResolvedValue([BUILTIN, USER_SOURCE])
    // The built-in source fails to load (a timeout), the user source loads but cannot produce
    // a playable URL: both must surface as distinct sub-attempt lines.
    lxMock.loadSource.mockReset().mockImplementation(async (script: string) => {
      if (script === BUILTIN.script) throw new Error('LX source load timed out')
      return { initedMeta: undefined }
    })
    lxMock.callMusicUrl.mockReset().mockRejectedValue(new Error('upstream refused'))
    lxMock.dispose.mockReset().mockResolvedValue(undefined)
  })

  it('surfaces one diagnostics entry per LX sub-source through store.attempts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(configResponse([
      { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 10 },
    ]))
    const repository = createRuntimeProviderRepository({ fetch: fetchImpl, now: () => 1_000 })
    const store = createPlaybackStore({ loadRegistry: repository.load })

    await store.playNow(lxTrack)

    // The real composite provider ran: its single top-level attempt is recorded.
    expect(store.attempts.value).toContainEqual(
      expect.objectContaining({ providerId: 'lx', ok: false, code: 'unavailable' }),
    )
    // ...and each of its sub-source attempts must appear as an additional entry.
    expect(lxSubAttempts(store.attempts.value)).toEqual([
      expect.objectContaining({
        providerId: 'lx', sourceId: BUILTIN.id, sourceName: 'Synthetic Pinned Source', ok: false, code: 'timeout',
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
    const repository = createRuntimeProviderRepository({ fetch: fetchImpl, now: () => 1_000 })
    const store = createPlaybackStore({ loadRegistry: repository.load })

    await store.playNow(lxTrack)
    expect(lxSubAttempts(store.attempts.value)).toHaveLength(2)

    await store.playNow(lxTrack)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(lxSubAttempts(store.attempts.value)).toEqual([
      expect.objectContaining({ sourceName: 'Synthetic Pinned Source', ok: false, code: 'timeout' }),
      expect.objectContaining({ sourceName: 'My Source', ok: false, code: 'unavailable' }),
    ])
  })

  it('keeps delivering sub-attempts when an unrelated sink-less load runs mid-resolution', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(configResponse([
      { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 10 },
    ]))
    const repository = createRuntimeProviderRepository({ fetch: fetchImpl, now: () => 1_000 })
    const store = createPlaybackStore({ loadRegistry: repository.load })

    // The repository holds one LX provider instance and relays its sub-attempts through a
    // single mutable sink, so a load that supplies no sink must not clear the sink the
    // in-flight resolution installed. `states()` is exactly such a load: the Control Centre's
    // settings sheet calls it whenever it mounts, which can happen while playback is resolving.
    let releaseSourceLoad: () => void = () => undefined
    const sourceLoadGate = new Promise<void>((resolve) => { releaseSourceLoad = resolve })
    lxMock.loadSource.mockImplementation(async (script: string) => {
      await sourceLoadGate
      if (script === BUILTIN.script) throw new Error('LX source load timed out')
      return { initedMeta: undefined }
    })

    const resolving = store.playNow(lxTrack)
    await repository.states()
    releaseSourceLoad()
    await resolving

    expect(lxSubAttempts(store.attempts.value)).toEqual([
      expect.objectContaining({ sourceId: BUILTIN.id, ok: false, code: 'timeout' }),
      expect.objectContaining({ sourceId: USER_SOURCE.id, ok: false, code: 'unavailable' }),
    ])
  })
})
