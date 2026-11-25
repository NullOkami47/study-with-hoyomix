import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { PlaybackStore } from './store'
import { playbackCommands } from './commands'
import { publishPlaybackPresentation } from './presentation'
import { registerPlaybackMediaSession } from './mediaSession'

afterEach(() => { Reflect.deleteProperty(navigator, 'mediaSession'); vi.restoreAllMocks() })
it.each(['intent', 'generation'] as const)('publishes only semantic changes for the real %s input', async change => {
  const writes = vi.fn(), position = vi.fn()
  let state = 'none'
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: {
    setActionHandler() {}, setPositionState: position,
    get playbackState() { return state }, set playbackState(value: string) { state = value; writes(value) },
  } })
  const intent = ref('playing'), generation = ref(1)
  const store = { currentTrack: ref(), playable: ref({ kind: 'audio' }), status: ref('playing'),
    playbackIntent: intent, playbackGeneration: generation } as unknown as PlaybackStore
  publishPlaybackPresentation(store, { currentTime: 1, duration: 16, canSeek: true })
  const scope = effectScope()
  const dispose = scope.run(() => registerPlaybackMediaSession(store, playbackCommands, () => ''))!
  try {
    writes.mockClear(); position.mockClear()
    if (change === 'intent') intent.value = 'paused'
    else generation.value++
    await nextTick()
    if (change === 'intent') expect(writes).toHaveBeenCalledExactlyOnceWith('paused')
    else expect(writes).not.toHaveBeenCalled()
    expect(position).toHaveBeenCalledTimes(1)
  } finally { dispose(); scope.stop() }
})
