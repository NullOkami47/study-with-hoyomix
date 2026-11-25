import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import { LxRuntimeClient } from './lx/runtime/client'
import type { LxWorkerRequest, LxWorkerResponse } from './lx/runtime/protocol'
import type { LxSourceRecord, LxSourceRepository } from './lx/types'
import type { LxQuality } from './qualityPreferences'
import { createLxUserProvider } from './providers/lxUser'
import { ProviderRegistry } from './providers/registry'
import { playbackLog } from './playbackLog'
import { createPlaybackStore, failuresAreTransient, TRANSIENT_RETRY_DELAYS_MS } from './store'
import { resolveTrack } from './resolver'
import type { ProviderAttempt } from './providers/types'

/** Real client/RPC cancellation, with a guest that stalls at a chosen request boundary. */
class DeadlineWorker implements Partial<Worker> {
  onmessage: ((event: MessageEvent<LxWorkerResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  readonly requests: LxWorkerRequest[] = []
  terminated = false

  constructor(private readonly pendingPhase?: 'load' | 'musicUrl' | 'musicUrlAfterCsp') {}

  postMessage(value: unknown): void {
    const request = value as LxWorkerRequest
    this.requests.push(request)
    if (request.type === this.pendingPhase) return
    const cspThenDeadline = this.pendingPhase === 'musicUrlAfterCsp' && request.type === 'musicUrl'
    if (cspThenDeadline && this.requests.filter(call => call.type === 'musicUrl').length > 1) return
    const response: LxWorkerResponse = request.type === 'load'
      ? { type: 'load_result', id: request.id, success: true }
      : { type: 'musicUrl_result', id: request.id, success: true, url: cspThenDeadline ? 'https://blocked.invalid/refused.mp3' : 'https://media.example.com/retried.mp3' }
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.({ data: response } as MessageEvent<LxWorkerResponse>)
    })
  }

  terminate(): void { this.terminated = true }
}

const source: LxSourceRecord = {
  id: 'builtin-deadline', name: 'Deadline source', script: '// fixture', sha256: 'fixture',
  builtIn: true, enabled: true, priority: 1, importedAt: 0, updatedAt: 0,
}
const sourceRepository: LxSourceRepository = {
  list: async () => [source], get: async () => source,
  setEnabled: async () => undefined, reorder: async () => undefined, delete: async () => undefined,
  importScript: async () => source, importRemote: async () => source, refreshRemote: async () => source,
}
const track = (id: string): Track => ({
  id, title: id, aliases: {}, games: ['zzz'], relationIds: [], tabs: ['focus'], workGroupId: 'work',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'lx', externalId: 'wy:123456' }],
})
const microtasks = async () => { for (let count = 0; count < 30; count += 1) await Promise.resolve() }

afterEach(() => { vi.useRealTimers() })

describe('LX registry deadline classification', () => {
  it.each([
    ['load', 'standard'],
    ['musicUrl', 'standard'],
    ['musicUrl', 'high'],
  ] as const)('retains timeout source evidence and retries after a real registry deadline in %s (%s)', async (phase, quality: LxQuality) => {
    vi.useFakeTimers()
    playbackLog.clear()
    const workers: DeadlineWorker[] = []
    const provider = createLxUserProvider({
      sourceRepository, qualityStore: { lxQuality: () => quality },
      cspSources: { connect: [], media: ['https://media.example.com'] },
      runtimeClientFactory: () => new LxRuntimeClient({
        workerFactory: () => {
          const worker = new DeadlineWorker(workers.length === 0 ? phase : undefined)
          workers.push(worker)
          return worker as unknown as Worker
        },
      }),
    })
    const registry = new ProviderRegistry([{ provider, enabled: true, priority: 1, timeoutMs: 100 }])
    const store = createPlaybackStore({
      registry,
      storage: { getItem: (key) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => undefined },
    })
    store.reconcileUpcomingQueue([track('A'), track('B')])
    const resolving = store.playQueueIndex(0)
    try {
      await microtasks()
      expect(workers).toHaveLength(1)
      expect(workers[0].requests.at(-1)?.type).toBe(phase)
      // This invokes the resolver's timer and AbortController, not a mocked timeout rejection.
      await vi.advanceTimersByTimeAsync(100)
      await resolving
      expect(workers[0].terminated).toBe(true)
      const attempts = playbackLog.snapshot().filter(event => event.type === 'resolve.attempt' && event.trackId === 'A')
      expect(attempts).toEqual([
        expect.objectContaining({ sourceId: source.id, code: 'timeout', ok: false }),
        expect.objectContaining({ sourceId: null, code: 'timeout', ok: false }),
      ])
      expect(store.currentTrack.value?.id).toBe('A')
      expect(playbackLog.snapshot()).toContainEqual(expect.objectContaining({ type: 'failCurrent.transientRetry', trackId: 'A', retry: 1 }))
      await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_DELAYS_MS[0])
      await microtasks()
      expect(workers).toHaveLength(2)
      expect(store.currentTrack.value?.id).toBe('A')
      expect(store.status.value).toBe('ready')
      expect(store.latestAttempts.value).toEqual([
        expect.objectContaining({ sourceId: source.id, ok: true }),
        expect.objectContaining({ providerId: 'lx', ok: true }),
      ])
      expect(store.latestAttempts.value.at(-1)).not.toHaveProperty('sourceId')
      expect(store.recentFailures.value).toEqual([])
    } finally {
      store.dispose()
      await resolving
    }
  })
})

it('keeps an earlier CSP refusal permanent when a later quality tier hits the registry deadline', async () => {
  vi.useFakeTimers()
  const worker = new DeadlineWorker('musicUrlAfterCsp')
  const client = new LxRuntimeClient({ workerFactory: () => worker as unknown as Worker })
  const provider = createLxUserProvider({
    sourceRepository, qualityStore: { lxQuality: () => 'high' },
    cspSources: { connect: [], media: ['https://media.example.com'] },
    runtimeClientFactory: () => client,
  })
  const registry = new ProviderRegistry([{ provider, enabled: true, priority: 1, timeoutMs: 100 }])
  const attempts: ProviderAttempt[] = []
  const resolving = resolveTrack(track('A'), registry, { onAttempt: attempt => attempts.push(attempt) })
  try {
    await microtasks()
    expect(worker.requests.filter(request => request.type === 'musicUrl')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(100)
    await resolving
    expect(attempts.map(attempt => attempt.code)).toEqual(['csp_blocked', 'timeout'])
    expect(failuresAreTransient(attempts)).toBe(false)
    expect(worker.terminated).toBe(true)
  } finally {
    await client.dispose()
    await resolving
  }
})
