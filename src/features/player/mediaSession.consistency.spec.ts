import { afterEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import type { PlaybackStore, PlaybackStatus } from './store'
import type { PlayerCommands } from './commands'
import { publishPlaybackPresentation } from './presentation'
import { registerPlaybackMediaSession } from './mediaSession'

let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); dispose = undefined; Reflect.deleteProperty(navigator, 'mediaSession'); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture(statusValue: PlaybackStatus = 'playing') {
  const status = ref(statusValue), intent = ref<'playing' | 'paused'>('playing'), generation = ref(1)
  const awaiting = ref<{ generation: number; startPosition: number }>()
  const playable = ref<unknown>({ kind: 'audio' })
  const store = { currentTrack: ref({ id: 'session', album: 'Album' }), playable, status,
    playbackIntent: intent, playbackGeneration: generation, awaitingStart: awaiting } as unknown as PlaybackStore
  const states = vi.fn(), positions = vi.fn(), metadata = vi.fn(), actions = vi.fn()
  let currentState = 'none', time = 0
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  const session = { setActionHandler: actions, setPositionState: positions,
    get playbackState() { return currentState }, set playbackState(value: string) { currentState = value; states(value) },
    set metadata(value: unknown) { metadata(value) },
  }
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
  vi.stubGlobal('MediaMetadata', class { constructor(readonly value: MediaMetadataInit) {} })
  const commands: PlayerCommands = { isPlaying: () => intent.value === 'playing', play: vi.fn(), pause: vi.fn(),
    pauseForInterruption: () => undefined, stop: vi.fn(), previous: vi.fn(), next: vi.fn(), seek: vi.fn() }
  let snapshot = { currentTime: 10, duration: 120, canSeek: true, nativeStalled: false }
  const publish = async (values: Partial<typeof snapshot> = {}) => { snapshot = { ...snapshot, ...values }; publishPlaybackPresentation(store, snapshot); await nextTick() }
  publishPlaybackPresentation(store, snapshot)
  const scope = effectScope(), unregister = scope.run(() => registerPlaybackMediaSession(store, commands, () => 'Session'))!
  dispose = () => { unregister(); scope.stop() }
  const advance = (milliseconds: number) => { time += milliseconds }
  const reset = () => { states.mockClear(); positions.mockClear(); metadata.mockClear(); actions.mockClear() }
  return { status, intent, generation, awaiting, playable, session, commands, states, positions, metadata, actions, publish, advance, reset }
}

it.each(['ready', 'buffering'] as const)('retains a current bounded %s handover without an advancing position or metadata reset', async status => {
  const f = fixture(); f.reset()
  f.generation.value++
  f.awaiting.value = { generation: f.generation.value, startPosition: 0 }
  f.status.value = status
  await f.publish({ currentTime: 0 })
  expect(f.session.playbackState).toBe('playing')
  expect(f.states).not.toHaveBeenCalled()
  expect(f.positions).toHaveBeenCalledExactlyOnceWith()
  expect(f.metadata).not.toHaveBeenCalled(); expect(f.actions).not.toHaveBeenCalled()
  await f.publish({ currentTime: 0.1 }); await f.publish({ currentTime: 0.2 })
  expect(f.positions).toHaveBeenCalledTimes(1)
})

it('makes a real stalled fact authoritative during awaitingStart and restores position on native progress', async () => {
  const f = fixture('buffering')
  f.awaiting.value = { generation: 1, startPosition: 10 }
  await f.publish({ nativeStalled: true })
  expect(f.session.playbackState).toBe('paused')
  expect(f.positions.mock.calls.at(-1)).toEqual([])
  f.awaiting.value = undefined; f.status.value = 'playing'
  await f.publish({ currentTime: 10.25, nativeStalled: false })
  expect(f.session.playbackState).toBe('playing')
  expect(f.positions.mock.calls.at(-1)?.[0]).toMatchObject({ position: 10.25, playbackRate: 1 })
})

it('honours native pause despite play intent and a remaining awaitingStart owner', async () => {
  const f = fixture(); f.awaiting.value = { generation: 1, startPosition: 10 }
  f.status.value = 'paused'; await nextTick()
  expect(f.session.playbackState).toBe('paused')
  expect(f.commands.play).not.toHaveBeenCalled(); expect(f.commands.pause).not.toHaveBeenCalled()
})

it('honours explicit pause before a native pause event arrives', async () => {
  const f = fixture(); f.intent.value = 'paused'; await nextTick()
  expect(f.status.value).toBe('playing')
  expect(f.session.playbackState).toBe('paused')
})

it('does not treat ordinary buffering or stale awaitingStart as a continuous session', async () => {
  const f = fixture(); f.status.value = 'buffering'; await nextTick()
  expect(f.session.playbackState).toBe('paused')
  f.status.value = 'ready'; f.awaiting.value = { generation: 0, startPosition: 0 }; await nextTick()
  expect(f.session.playbackState).toBe('paused')
})

it('dedupes playbackState and throttles ordinary native-playing progress to one second', async () => {
  const f = fixture(); f.reset()
  for (let sample = 1; sample <= 4; sample++) { f.advance(250); await f.publish({ currentTime: 10 + sample / 4 }) }
  expect(f.states).not.toHaveBeenCalled()
  expect(f.positions).toHaveBeenCalledExactlyOnceWith({ duration: 120, position: 11, playbackRate: 1 })
})

it('immediately anchors seek jumps, changed duration, paused state and a new generation', async () => {
  const f = fixture(); f.reset(); f.advance(50)
  await f.publish({ currentTime: 70 }); expect(f.positions).toHaveBeenLastCalledWith({ duration: 120, position: 70, playbackRate: 1 })
  await f.publish({ duration: 150 }); expect(f.positions).toHaveBeenLastCalledWith({ duration: 150, position: 70, playbackRate: 1 })
  f.status.value = 'paused'; await nextTick(); expect(f.session.playbackState).toBe('paused')
  f.reset(); f.generation.value++; await nextTick()
  expect(f.states).not.toHaveBeenCalled(); expect(f.positions).toHaveBeenCalledTimes(1)
})

it('dedupes an invalid position reset and preserves the eight installed actions until disposal', async () => {
  const f = fixture(); expect(f.actions).toHaveBeenCalledTimes(8); f.reset()
  await f.publish({ canSeek: false })
  await f.publish({ currentTime: 20 }); await f.publish({ currentTime: 30 })
  expect(f.positions).toHaveBeenCalledExactlyOnceWith(); expect(f.states).not.toHaveBeenCalled()
  expect(f.actions).not.toHaveBeenCalled(); expect(f.metadata).not.toHaveBeenCalled()
  dispose!(); dispose = undefined
  expect(f.actions).toHaveBeenCalledTimes(8)
  expect(f.session.playbackState).toBe('none'); expect(f.metadata).toHaveBeenLastCalledWith(null)
  expect(f.positions.mock.calls.at(-1)).toEqual([])
})

it('attempts optional position publication even if the playbackState setter rejects', async () => {
  const f = fixture(); f.reset()
  Object.defineProperty(f.session, 'playbackState', { configurable: true, get: () => 'none', set() { throw new Error('restricted') } })
  f.status.value = 'paused'; await nextTick()
  expect(f.positions).toHaveBeenCalledTimes(1)
})
