import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import type { LxSourceRecord } from './lx/types'
import type { ProviderAttempt } from './providers/types'
import { ProviderRegistry } from './providers/registry'
import { playbackLog } from './playbackLog'
import { resolveTrack, type ResolveResult } from './resolver'
import { createRuntimeProviderRepository } from './runtimeConfig'
import { createPlaybackStore } from './store'

type LoadControl = {
  resolve: (value: { initedMeta?: unknown }) => void
  reject: (error: Error) => void
}
const runtime = vi.hoisted(() => ({ loads: [] as LoadControl[] }))

vi.mock('./lx/sourceRepository', () => ({
  getDefaultLxSourceRepository: () => ({
    list: async (): Promise<LxSourceRecord[]> => [{
      id: 'builtin-example', name: 'Example', builtIn: true, script: '// example',
      enabled: true, priority: 1, sha256: 'hash', importedAt: 1, updatedAt: 1,
    }],
  }),
}))

vi.mock('./lx/runtime/client', () => ({
  LxRuntimeClient: class {
    private pending: LoadControl | undefined

    loadSource(): Promise<{ initedMeta?: unknown }> {
      return new Promise((resolve, reject) => {
        this.pending = { resolve, reject }
        runtime.loads.push(this.pending)
      })
    }

    abort(): void {
      this.pending?.reject(new Error('LX resolution aborted'))
    }

    async dispose(): Promise<void> {}
    async callMusicUrl(): Promise<never> { throw new Error('Unexpected musicUrl call') }
  },
}))

const sequentialStorage = {
  getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null,
  setItem: () => undefined,
}
const track = (id: string): Track => ({
  id, title: id, aliases: {}, games: ['zzz'], relationIds: [], tabs: ['focus'], workGroupId: 'work',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'lx', externalId: 'wy:123456' }],
})
const playableResult = (): ResolveResult => ({
  ok: true, providerId: 'lx',
  playable: { kind: 'audio', url: 'https://media.example.com/initial.mp3', mimeType: 'audio/mpeg' },
  attempts: [{ providerId: 'lx', ok: true, latencyMs: 1 }],
})

function runtimeRepository() {
  const configUrl = new URL('/api/providers/config', window.location.origin).toString()
  const response = new Response(JSON.stringify({
    version: 1,
    providers: [{ id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 10 }],
  }), { headers: { 'content-type': 'application/json' } })
  Object.defineProperties(response, { redirected: { value: false }, url: { value: configUrl } })
  return createRuntimeProviderRepository({
    fetch: vi.fn<typeof fetch>().mockImplementation(async () => {
      const current = response.clone()
      Object.defineProperties(current, { redirected: { value: false }, url: { value: configUrl } })
      return current
    }), now: () => 1000,
    globalSourceRepository: {
      list: async () => [], revision: () => 0, pendingApproval: () => [], invalidate: () => undefined,
    },
  })
}

const sourceAttempts = (attempts: readonly ProviderAttempt[]) => attempts.filter(a => a.sourceId !== undefined)

beforeEach(() => {
  runtime.loads.length = 0
  playbackLog.clear()
})

describe('LX resolution attempt isolation', () => {
  it('keeps cancelled A load failures out of B and preserves B transient retry', async () => {
    const repository = runtimeRepository()
    const store = createPlaybackStore({ loadRegistry: repository.load, storage: sequentialStorage })
    store.reconcileUpcomingQueue([track('A'), track('B')])
    const first = store.playQueueIndex(0)
    let second: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(runtime.loads).toHaveLength(1))
      second = store.playQueueIndex(1)
      await vi.waitFor(() => expect(runtime.loads).toHaveLength(2))
      runtime.loads[1].reject(new Error('B source load timed out'))
      await second
      expect(store.currentTrack.value?.id).toBe('B')
      expect(sourceAttempts(store.latestAttempts.value)).toEqual([
        expect.objectContaining({ sourceId: 'builtin-example', code: 'timeout' }),
      ])
      expect(playbackLog.snapshot()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'resolve.attempt', trackId: 'A', sourceId: 'builtin-example', code: 'unavailable' }),
        expect.objectContaining({ type: 'resolve.attempt', trackId: 'B', sourceId: 'builtin-example', code: 'timeout' }),
        expect.objectContaining({ type: 'store.failCurrent', trackId: 'B', outcome: 'waiting' }),
      ]))
    } finally {
      store.dispose()
      await Promise.all([first, second])
    }
  })

  it('separates overlapping armed preload and current-track renewal on a cached registry', async () => {
    const repository = runtimeRepository()
    let calls = 0
    const store = createPlaybackStore({
      loadRegistry: repository.load, storage: sequentialStorage,
      resolve: (current, registry, options) => ++calls === 1
        ? Promise.resolve(playableResult())
        : resolveTrack(current, registry, options),
    })
    store.reconcileUpcomingQueue([track('A'), track('B')])
    let preparation: Promise<void> | undefined
    let renewal: Promise<boolean> | undefined
    try {
      await store.playQueueIndex(0)
      store.setPreloadPolicy('auto')
      preparation = store.armNextPreparation()
      await vi.waitFor(() => expect(runtime.loads).toHaveLength(1))
      renewal = store.renewMedia('lx', store.playbackGeneration.value)
      await vi.waitFor(() => expect(runtime.loads).toHaveLength(2))
      runtime.loads[0].reject(new Error('B preload timed out'))
      await preparation
      runtime.loads[1].reject(new Error('A renewal timed out'))
      expect(await renewal).toBe(false)
      expect(sourceAttempts(store.latestAttempts.value)).toHaveLength(1)
      expect(playbackLog.snapshot().filter(e => e.type === 'preparation.attempt' && e.sourceId === 'builtin-example'))
        .toEqual([expect.objectContaining({ trackId: 'B', code: 'timeout' })])
      expect(playbackLog.snapshot().filter(e => e.type === 'resolve.attempt' && e.origin === 'renewal' && e.sourceId === 'builtin-example'))
        .toEqual([expect.objectContaining({ trackId: 'A', code: 'timeout' })])
      expect(await repository.load()).toBe(await repository.load())
    } finally {
      store.dispose()
      await Promise.all([preparation, renewal])
    }
  })

  it('retains every prepared-track source attempt in the debug log without duplicating outer attempts', async () => {
    const registry = new ProviderRegistry([{
      provider: { id: 'lx', resolve: async () => null }, enabled: true, priority: 1, timeoutMs: 1000,
    }])
    const subAttempt: ProviderAttempt = {
      providerId: 'lx', sourceId: 'prep-sub', sourceName: 'Prepared source', ok: false, code: 'timeout', latencyMs: 1,
    }
    const store = createPlaybackStore({
      loadRegistry: async () => registry,
      storage: sequentialStorage,
      resolve: async (current, _registry, options) => {
        if (current.id === 'B') options?.onAttempt?.(subAttempt)
        const result = playableResult()
        options?.onAttempt?.(result.attempts[0])
        return result
      },
    })
    store.reconcileUpcomingQueue([track('A'), track('B')])
    try {
      await store.playQueueIndex(0)
      store.setPreloadPolicy('auto')
      await store.armNextPreparation()
      expect(store.preparedNext.value?.attempts).toContainEqual(subAttempt)
      expect(playbackLog.snapshot().filter(e => e.type === 'preparation.attempt' && e.trackId === 'B')).toEqual([
        expect.objectContaining({ sourceId: 'prep-sub', code: 'timeout', speculative: false }),
        expect.objectContaining({ sourceId: null, ok: true, speculative: false }),
      ])
    } finally { store.dispose() }
  })
})
