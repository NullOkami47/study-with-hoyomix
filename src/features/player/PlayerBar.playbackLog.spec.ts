// Task 41.1: the playback event log records an automatic handover in enough detail to tell which
// deck was promoted, whether that element had ever played, how `play()` ended and which ladder step
// followed. Logging only: the behaviour itself is covered by PlayerBar.handover.spec.ts.
//
// Mounted PlayerBar, real store, real `ProviderRegistry`, real `resolveTrack`.
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { ProviderRegistry, type ProviderRegistration } from './providers/registry'
import type { AudioProvider } from './providers/types'
import { createPlaybackStore } from './store'
import { playbackLog, type PlaybackLogEntry } from './playbackLog'

const sequential = { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} }
const micro = async () => { for (let i = 0; i < 60; i += 1) await Promise.resolve() }
const flush = async () => { await micro(); await vi.advanceTimersByTimeAsync(0); await micro() }
const makeTrack = (id: string): Track => ({
  id, title: id, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'jellyfin', externalId: `jf-${id}` }],
}) as unknown as Track
const jellyfin = (): AudioProvider => ({
  id: 'jellyfin',
  canResolve: () => true,
  resolve: vi.fn(async (track: Track) => ({
    kind: 'audio' as const,
    url: `https://media.invalid/jellyfin/${track.id}.mp3?ticket=TICKET-SECRET&api_key=KEY-SECRET`,
    mimeType: 'audio/mpeg',
  })),
}) as unknown as AudioProvider
const reg = (p: AudioProvider): ProviderRegistration => ({ provider: p, enabled: true, priority: 1, timeoutMs: 100 }) as ProviderRegistration
function setDuration(media: HTMLAudioElement, value: number): void {
  Object.defineProperty(media, 'duration', { configurable: true, value })
  Object.defineProperty(media, 'seekable', { configurable: true, value: { length: 1, start: () => 0, end: () => value } })
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('playback event log on an automatic handover (task 41.1)', () => {
  it('records the promotion, the never-played target, the refused play() and the ladder', async () => {
    vi.useFakeTimers()
    playbackLog.clear()
    const registry = new ProviderRegistry([reg(jellyfin())])
    const store = createPlaybackStore({ loadRegistry: async () => registry, storage: sequential })
    store.reconcileUpcomingQueue([makeTrack('a'), makeTrack('b')])
    let refuse = false
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => {
      if (refuse) throw new DOMException('play() requires a user gesture', 'NotAllowedError')
    })
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
    const wrapper = mount(PlayerBar, { props: { store } })
    try {
      await store.playQueueIndex(0); await flush()
      const first = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
      first.dispatchEvent(new Event('playing')); await flush()
      setDuration(first, 240)
      first.currentTime = 225
      first.dispatchEvent(new Event('loadedmetadata'))
      first.dispatchEvent(new Event('timeupdate')); await flush()
      expect(wrapper.find('[data-audio-role="standby"]').exists()).toBe(true)

      refuse = true
      first.currentTime = 240
      Object.defineProperty(first, 'ended', { configurable: true, value: true })
      first.dispatchEvent(new Event('pause'))
      first.dispatchEvent(new Event('ended')); await flush()
      for (let t = 0; t < 20_000; t += 1_000) { await vi.advanceTimersByTimeAsync(1_000); await micro() }

      const entries = playbackLog.snapshot()
      const of = (type: string): PlaybackLogEntry[] => entries.filter((entry) => entry.type === type)
      const firstDeck = first.dataset.audioDeck

      expect(of('media.playing').some((entry) => entry.deck === firstDeck && entry.everPlayed === true)).toBe(true)
      expect(of('advance.auto')[0]).toMatchObject({ trackId: 'a', repeatMode: 'off' })
      expect(of('queue.start').at(-1)).toMatchObject({ trackId: 'b', reusedPreparation: true, providerId: 'jellyfin' })
      const promote = of('handover.promote')[0]
      expect(promote).toMatchObject({ trackId: 'b', fromDeck: Number(firstDeck), targetEverPlayed: false })
      expect(promote.toDeck).not.toBe(Number(firstDeck))
      expect(of('play.rejected').some((entry) => entry.name === 'NotAllowedError' && entry.everPlayed === false)).toBe(true)
      expect(of('handover.refused')[0]).toMatchObject({ reason: 'NotAllowedError', step: 'promoted' })
      expect(of('handover.ladder').map((entry) => entry.step)[0]).toBe('srcSwap')
      expect(of('store.recoverHandover.result')[0]).toMatchObject({ step: 'srcSwap' })
      const swap = of('handover.srcSwap')[0]
      if (swap?.ok) expect(swap.targetEverPlayed).toBe(true)
      // The tap-to-resume notice, if raised, is logged at its raise site and in the store.
      const raised = of('notice.tapToResume.raise')
      const added = of('notice.add').filter((entry) => entry.kind === 'tapToResume')
      expect(raised.length > 0).toBe(added.length > 0)

      const json = playbackLog.exportJson()
      expect(json).not.toContain('TICKET-SECRET')
      expect(json).not.toContain('KEY-SECRET')
      expect(json).toContain('https://media.invalid#')
    } finally {
      wrapper.unmount(); store.dispose(); vi.useRealTimers()
    }
  })
})
