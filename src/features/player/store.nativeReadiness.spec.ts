import { expect, it } from 'vitest'
import { createPlaybackStore } from './store'
import { ProviderRegistry } from './providers/registry'
import type { Track } from '../catalog/types'

it('does not downgrade confirmed playback when canplay reports source readiness again', async () => {
  const provider = { id: 'lx', canResolve: () => true, resolve: async () => ({ kind: 'audio' as const,
    url: 'https://media.invalid/native-readiness.wav', mimeType: 'audio/wav' }) }
  const store = createPlaybackStore({ registry: new ProviderRegistry([{ provider, enabled: true, priority: 1, timeoutMs: 1000 }]),
    storage: { getItem: () => null, setItem() {} } })
  const track: Track = { id: 'ready', title: 'Ready', aliases: {}, games: ['hsr'], tabs: ['focus'],
    relationIds: [], workGroupId: 'ready', vocalStatus: 'instrumental', needsClassification: false, sources: [{ provider: 'lx', externalId: 'wy:1' }] }
  try {
    store.enqueue(track); await store.playQueueIndex(0)
    const generation = store.playbackGeneration.value
    expect(store.status.value).toBe('ready')
    store.reportMediaState('playing', generation)
    store.reportProgress(0.05, generation)
    store.reportMediaState('ready', generation)
    expect(store.status.value).toBe('playing')
    store.reportMediaState('buffering', generation)
    expect(store.status.value).toBe('buffering')
    store.pause(); store.reportMediaState('ready', generation)
    expect(store.playbackIntent.value).toBe('paused')
  } finally { store.dispose() }
})
