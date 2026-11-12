import { describe, it, expect, vi } from 'vitest'
import { watch } from 'vue'
import type { Track } from '../catalog/types'
import { createPlaybackStore } from './store'
import type { ResolveOptions, ResolveResult } from './resolver'
import { ProviderRegistry } from './providers/registry'

const track = (id: string) => ({ id, title: id, sources: [{ provider: 'lx', externalId: 'wy:123456' }] }) as Track
const registry = new ProviderRegistry([
  { provider: { id: 'lx', resolve: async () => null }, enabled: true, priority: 1, timeoutMs: 1000 },
])
const storage = () => ({ getItem: () => null, setItem: () => {} })
const result = (name: string): ResolveResult => ({
  ok: true,
  providerId: 'lx',
  playable: { kind: 'audio', url: 'https://media.example.com/' + name + '.mp3', mimeType: 'audio/mpeg' },
  attempts: [{ providerId: 'lx', sourceId: name, sourceName: name, ok: true, latencyMs: 1 }],
})

describe('current-track resolution lifecycle', () => {
  it.each(['queue switch', 'stop', 'dispose'])(
    'aborts an in-flight resolution immediately on %s',
    async (action) => {
      let entered = false
      let signal: AbortSignal | undefined
      let finish!: (value: ResolveResult) => void
      const pending = new Promise<ResolveResult>((resolve) => { finish = resolve })
      const store = createPlaybackStore({
        registry,
        storage: storage(),
        resolve: async (current, _registry, options?: ResolveOptions) => {
          if (current.id === 'first') {
            entered = true
            signal = options?.signal
            return pending
          }
          return result('second')
        },
      })
      store.enqueue(track('first'))
      store.enqueue(track('second'))
      const first = store.playQueueIndex(0)
      try {
        await vi.waitFor(() => expect(entered).toBe(true))
        if (action === 'queue switch') await store.playQueueIndex(1)
        else if (action === 'stop') store.stop()
        else store.dispose()
        expect(signal?.aborted).toBe(true)
      } finally {
        finish(result('stale'))
        await first
        store.dispose()
      }
    },
  )

  it('replaces the visible trace when this track renews', async () => {
    let call = 0
    const store = createPlaybackStore({
      registry,
      resolve: async () => result(++call === 1 ? 'old' : 'new'),
      storage: storage(),
    })
    try {
      store.enqueue(track('first'))
      await store.playQueueIndex(0)
      expect(store.latestAttempts.value.map((attempt) => attempt.sourceName)).toEqual(['old'])
      expect(await store.renewMedia('lx', store.playbackGeneration.value)).toBe(true)
      expect(store.latestAttempts.value.map((attempt) => attempt.sourceName)).toEqual(['new'])
    } finally {
      store.dispose()
    }
  })

  it('does not expose next-track attempts until the prepared track becomes current', async () => {
    const store = createPlaybackStore({ registry, resolve: async (current) => result(current.id), storage: storage() })
    try {
      store.enqueue(track('first'))
      store.enqueue(track('second'))
      await store.playQueueIndex(0)
      store.setPreloadPolicy('auto')
      await store.armNextPreparation()
      expect(store.preparedNext.value?.track.id).toBe('second')
      expect(store.latestAttempts.value.map((attempt) => attempt.sourceName)).toEqual(['first'])
      await store.playQueueIndex(1)
      expect(store.latestAttempts.value.map((attempt) => attempt.sourceName)).toEqual(['second'])
    } finally {
      store.dispose()
    }
  })
  it('never exposes the previous playable under the next resolution generation to synchronous observers', async () => {
    let calls = 0
    const store = createPlaybackStore({ registry, storage: storage(), resolve: async () => result(++calls === 1 ? 'old' : 'fresh') })
    let stop = () => {}
    try {
      store.enqueue(track('first'))
      await store.playQueueIndex(0)
      const previous = store.playable.value
      const stalePublications: number[] = []
      const observedStates: unknown[] = []
      stop = watch(store.playbackGeneration, generation => {
        if (store.playable.value === previous) stalePublications.push(generation)
        observedStates.push({ status: store.status.value, playable: store.playable.value, providerId: store.activeProviderId.value })
      }, { flush: 'sync' })
      await store.setSourceOverride('lx')
      expect(stalePublications).toEqual([])
      expect(observedStates).toEqual([{ status: 'resolving', playable: null, providerId: undefined }])
      expect(store.playable.value).toEqual({ kind: 'audio', url: 'https://media.example.com/fresh.mp3', mimeType: 'audio/mpeg' })
    } finally { stop(); store.dispose() }
  })

})
