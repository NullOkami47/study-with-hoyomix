// Wave A exploration (P96-01): media errors on the mounted PlayerBar reach the same terminal
// decision as the store paths, so playback continues on the next playable track. Cases Q and R
// come from the mounted-PlayerBar part of the 8309e3a audit probe `zz-audit-p96-01-probe.spec.ts`
// and assert design Properties 25 and 26. They fail on 8309e3a.
//
// Real store, real `resolveTrack`, production `loadRegistry` wiring, mounted PlayerBar.
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { ProviderRegistry, type ProviderRegistration } from './providers/registry'
import type { AudioProvider } from './providers/types'
import { createPlaybackStore, type PlaybackStore } from './store'

const sequential = { getItem: (key: string) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} }
const settle = async () => {
  for (let i = 0; i < 80; i += 1) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 80; i += 1) await Promise.resolve()
}
const makeTrack = (id: string, providers: string[]): Track => ({
  id, title: id, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: providers.map((provider) => ({ provider, externalId: `${provider}-${id}` })),
}) as unknown as Track
function provider(id: string, playable: (trackId: string, call: number) => boolean): AudioProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    id, calls,
    canResolve: (track: Track) => track.sources.some((source) => source.provider === id),
    resolve: vi.fn(async (track: Track) => {
      calls.push(track.id)
      if (!playable(track.id, calls.filter((c) => c === track.id).length)) throw new Error(`${id} cannot play ${track.id}`)
      return { kind: 'audio' as const, url: `https://media.invalid/${id}/${track.id}-${calls.length}.mp3`, mimeType: 'audio/mpeg' }
    }),
  } as unknown as AudioProvider & { calls: string[] }
}
const reg = (p: AudioProvider, priority: number): ProviderRegistration =>
  ({ provider: p, enabled: true, priority, timeoutMs: 100 }) as ProviderRegistration

/** A media element error as the browser reports it: `element.error` carries a MediaError. */
function attachMediaError(element: HTMLMediaElement): void {
  const proto = typeof MediaError === 'undefined' ? Object.prototype : MediaError.prototype
  const error = Object.create(proto, {
    code: { value: 2 /* MEDIA_ERR_NETWORK */ }, message: { value: 'network error' },
  }) as MediaError
  Object.defineProperty(element, 'error', { configurable: true, get: () => error })
}

beforeEach(() => {
  window.localStorage.setItem('hoyomix-player-shuffle-v1', 'false')
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

const activeAudio = (wrapper: ReturnType<typeof mount>, store: PlaybackStore) => {
  const playable = store.playable.value
  const url = playable?.kind === 'audio' ? playable.url : ''
  return wrapper.findAll('audio').map((w) => w.element as HTMLAudioElement).find((el) => el.getAttribute('src') === url)
}

/** LX plays `a` once (initial resolve) and then cannot renew it; it always plays `b`. */
async function mediaErrorScenario(aSources: string[], registrations: (lx: AudioProvider) => ProviderRegistration[], pauseFirst = false) {
  const lx = provider('lx', (id, call) => id !== 'a' || call === 1)
  const registry = new ProviderRegistry(registrations(lx))
  const store = createPlaybackStore({ loadRegistry: async () => registry, storage: sequential })
  store.reconcileUpcomingQueue([makeTrack('a', aSources), makeTrack('b', ['lx'])])
  const wrapper = mount(PlayerBar, { props: { store } })
  try {
    await store.playQueueIndex(0); await flushPromises(); await settle()
    const element = activeAudio(wrapper, store)
    expect(element, 'active deck element').toBeDefined()
    element!.dispatchEvent(new Event('playing'))
    await settle()
    if (pauseFirst) element!.dispatchEvent(new Event('pause'))
    attachMediaError(element!)
    element!.dispatchEvent(new Event('error'))
    await flushPromises(); await settle(); await flushPromises(); await settle()
    return { store: { current: store.currentTrack.value?.id, status: store.status.value }, lxCalls: [...lx.calls] }
  } finally { wrapper.unmount(); store.dispose() }
}

describe('P96-01 PlayerBar media-error paths continue playback (Properties 25, 26)', () => {
  it('Q a media error on a Jellyfin-mapped track whose renewal and Jellyfin recovery fail skips to the next track', async () => {
    const observed = await mediaErrorScenario(['lx', 'jellyfin'],
      (lx) => [reg(lx, 1), reg(provider('jellyfin', () => false), 2)])
    expect(observed.store.current).toBe('b')
    expect(observed.lxCalls).toContain('b')
  })

  it('R a media error (with a MediaError) delivered after a native pause event is handled and skips to the next track', async () => {
    const observed = await mediaErrorScenario(['lx'], (lx) => [reg(lx, 1)], true)
    expect(observed.store.current).toBe('b')
  })
})

// Preservation (Property 32, 3.18, task 7): holds on 8309e3a and must keep holding after the fix.
describe('Preservation: a PlayerBar media error that already skips (probe case P)', () => {
  it('P a media error on an LX-only track whose renewal fails advances with the same resolves', async () => {
    const observed = await mediaErrorScenario(['lx'], (lx) => [reg(lx, 1)])
    expect(observed.store.current).toBe('b')
    expect(observed.store.status).toBe('ready')
    // Initial resolve of a, one failed renewal of a, then b.
    expect(observed.lxCalls).toEqual(['a', 'a', 'b'])
  })
})
