import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { ProviderRegistry, type ProviderRegistration } from './providers/registry'
import { ProviderResolveError, type AudioProvider, type Playable, type ProviderResolveContext } from './providers/types'
import { resolveTrack } from './resolver'
import {
  createPlaybackStore,
  HANDOVER_TICKET_MARGIN_MS,
  MEDIA_TICKET_TTL_MS,
  type PlaybackStore,
} from './store'

const stores: PlaybackStore[] = []
const tracks = ['a', 'b', 'c'].map((id): Track => ({
  id, title: id, aliases: {}, games: [], relationIds: [], tabs: [], workGroupId: 'test',
  needsClassification: false, vocalStatus: 'instrumental',
  // GD's canResolve uses the catalogue's shared mapping, rather than its own provider binding.
  sources: [{ provider: 'chksz', externalId: `netease-${id}` }, { provider: 'lx', externalId: `wy:${id}` }],
}))
const audio = (providerId: string, track: Track, call: number): Playable => ({
  kind: 'audio', url: `https://media.invalid/${providerId}/${track.id}.mp3?call=${call}`,
  mimeType: 'audio/mpeg', metadata: { quality: { codec: 'mp3', bitrate: 320_000 } },
})

async function setup(options: { gdNextSucceeds?: boolean; lxFails?: boolean } = {}) {
  const gdResolve = vi.fn(async (track: Track, _signal: AbortSignal): Promise<Playable | null> => {
    if (track.id !== 'a' && !options.gdNextSucceeds) throw new ProviderResolveError('http_error')
    return audio('gd-studio', track, gdResolve.mock.calls.filter(([item]) => item === track).length)
  })
  const lxResolve = vi.fn(async (
    track: Track, _signal: AbortSignal, context?: ProviderResolveContext,
  ): Promise<Playable | null> => {
    context?.onSubAttempt?.({ providerId: 'lx', sourceId: 'first-lx-source', ok: false, code: 'unavailable', latencyMs: 1 })
    return options.lxFails ? null : audio('lx', track, lxResolve.mock.calls.filter(([item]) => item === track).length)
  })
  const gd: AudioProvider = {
    id: 'gd-studio', canResolve: (track) => track.sources.some(({ provider }) => provider === 'chksz'), resolve: gdResolve,
  }
  const lx: AudioProvider = {
    id: 'lx', canResolve: (track) => track.sources.some(({ provider }) => provider === 'lx'), resolve: lxResolve,
  }
  let registrations: ProviderRegistration[] = [
    { provider: gd, enabled: true, priority: 5, timeoutMs: 1000 },
    { provider: lx, enabled: true, priority: 10, timeoutMs: 1000 },
  ]
  let registry = new ProviderRegistry(registrations)
  const loadRegistry = vi.fn(async () => registry)
  const store = createPlaybackStore({
    loadRegistry, resolve: resolveTrack,
    storage: { getItem: (key) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} },
  })
  stores.push(store)
  store.reconcileUpcomingQueue(tracks)
  await store.prepareQueueIndex(0)
  store.setPreloadPolicy('auto')
  await flushPromises()
  const change = (providerId: string, patch: Partial<ProviderRegistration>) => {
    registrations = registrations.map((registration) => registration.provider.id === providerId
      ? { ...registration, ...patch } : registration)
    registry = new ProviderRegistry(registrations)
  }
  return { store, gd, lx, gdResolve, lxResolve, loadRegistry, change, registry: () => registry }
}

const callsFor = (resolve: { mock: { calls: readonly (readonly [Track, ...unknown[]])[] } }, id: string) =>
  resolve.mock.calls.filter(([track]) => track.id === id).length

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  vi.useRealTimers()
})

describe('armed preparation follows the automatic resolver fallback chain', () => {
  it.each([['metadata','auto'],['auto','metadata']] as const)('retains a ready fallback when preload hint changes from %s to %s', async (from,to) => {
    const { store, gdResolve, lxResolve } = await setup({ gdNextSucceeds: true })
    // Resolve and load-fallback under auto before changing the native preload hint.
    await store.play()
    await store.armNextPreparation()
    store.rejectNextPreparation(store.preparedNext.value!.id)
    await flushPromises()
    const prepared = store.preparedNext.value
    expect(prepared?.providerId).toBe('lx')
    store.setPreloadPolicy(from)
    await flushPromises()
    expect(store.preparedNext.value).toBe(prepared)
    store.setPreloadPolicy(to)
    await flushPromises()
    expect(store.preparedNext.value).toBe(prepared)
    await store.armNextPreparation()
    await store.next()
    expect(store.preloadHandoff.value?.id).toBe(prepared?.id)
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(lxResolve, 'b')).toBe(1)
  })

  it('does not start media fallback after a native pause even while intent remains playing', async () => {
    const {store,lxResolve}=await setup({gdNextSucceeds:true});await store.play();await store.armNextPreparation()
    store.reportMediaState('paused',store.playbackGeneration.value)
    expect(store.playbackIntent.value).toBe('playing')
    store.rejectNextPreparation(store.preparedNext.value!.id);await flushPromises()
    expect(lxResolve).not.toHaveBeenCalled();expect(store.preparedNext.value).toBeNull()
  })
  it('aborts a pending media fallback on native pause and cannot revive it on resume', async () => {
    const {store,lxResolve}=await setup({gdNextSucceeds:true});await store.play();await store.armNextPreparation()
    let finish!:(value:Playable|null)=>void;let signal!:AbortSignal
    lxResolve.mockImplementationOnce((_track,s)=>{signal=s;return new Promise(resolve=>{finish=resolve})})
    store.rejectNextPreparation(store.preparedNext.value!.id);await flushPromises()
    store.reportMediaState('paused',store.playbackGeneration.value);expect(signal.aborted).toBe(true)
    await store.play();store.reportMediaState('playing',store.playbackGeneration.value)
    finish(audio('lx',tracks[1]!,99));await flushPromises();expect(store.preparedNext.value).toBeNull()
  })
  it('aborts the remaining resolver chain on explicit Pause before another provider spends quota', async () => {
    const {store,lxResolve,loadRegistry,registry}=await setup({gdNextSucceeds:true});await store.play();await store.armNextPreparation()
    const third=vi.fn(async(track:Track)=>audio('chksz',track,1))
    loadRegistry.mockResolvedValue(new ProviderRegistry([...registry().enabled(),{provider:{id:'chksz',canResolve:()=>true,resolve:third},enabled:true,priority:15,timeoutMs:1000}]))
    let finish!:(value:Playable|null)=>void;let signal!:AbortSignal
    lxResolve.mockImplementationOnce((_track,s)=>{signal=s;return new Promise(resolve=>{finish=resolve})})
    store.rejectNextPreparation(store.preparedNext.value!.id);await flushPromises();store.pause()
    expect(signal.aborted).toBe(true);finish(null);await flushPromises()
    expect(third).not.toHaveBeenCalled();expect(store.preparedNext.value).toBeNull()
  })

  it('prepares a remaining automatic provider after the resolved standby media fails', async () => {
    const {store,gdResolve,lxResolve}=await setup({gdNextSucceeds:true});await store.play();await store.armNextPreparation()
    const generation=store.playbackGeneration.value,current=store.playable.value,failed=store.preparedNext.value!
    expect(failed.providerId).toBe('gd-studio');store.rejectNextPreparation(failed.id);await flushPromises()
    const replacement=store.preparedNext.value;expect(replacement?.providerId).toBe('lx')
    expect(store.playable.value).toBe(current);expect(store.playbackGeneration.value).toBe(generation)
    expect(callsFor(gdResolve,'b')).toBe(1);expect(callsFor(lxResolve,'b')).toBe(1)
    await store.next();expect(store.preloadHandoff.value?.id).toBe(replacement?.id)
    expect(store.activeProviderId.value).toBe('lx');expect(callsFor(lxResolve,'b')).toBe(1)
  })
  it('exhausts each provider once without restarting on progress or stale errors', async () => {
    const {store,gdResolve,lxResolve}=await setup({gdNextSucceeds:true});await store.play();await store.armNextPreparation()
    const failed=store.preparedNext.value!;store.rejectNextPreparation(failed.id);store.rejectNextPreparation(failed.id);await flushPromises()
    expect(store.preparedNext.value?.providerId).toBe('lx');store.rejectNextPreparation(store.preparedNext.value!.id);await flushPromises()
    for(let i=0;i<5;i++)await store.armNextPreparation()
    expect(store.preparedNext.value).toBeNull();expect(callsFor(gdResolve,'b')).toBe(1);expect(callsFor(lxResolve,'b')).toBe(1)
  })
  it('does not retry an earlier resolver failure when a later standby media fails', async () => {
    const {store,gdResolve,lxResolve}=await setup();await store.play();await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('lx');store.rejectNextPreparation(store.preparedNext.value!.id);await flushPromises()
    await store.armNextPreparation();expect(store.preparedNext.value).toBeNull()
    expect(callsFor(gdResolve,'b')).toBe(1);expect(callsFor(lxResolve,'b')).toBe(1)
  })
  it('preserves strict manual source selection after standby media failure', async () => {
    const {store,lxResolve}=await setup({gdNextSucceeds:true});await store.setSourceOverride('gd-studio');await store.play();await store.armNextPreparation()
    store.rejectNextPreparation(store.preparedNext.value!.id);await flushPromises();await store.armNextPreparation()
    expect(store.preparedNext.value).toBeNull();expect(lxResolve).not.toHaveBeenCalled()
  })
  it.each(['pause','pause and resume','stop','next','override'] as const)('discards delayed standby fallback after %s', async (action) => {
    const {store,lxResolve}=await setup({gdNextSucceeds:true});await store.play();await store.armNextPreparation()
    let finish!:(value:Playable|null)=>void
    lxResolve.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
    store.rejectNextPreparation(store.preparedNext.value!.id);await flushPromises()
    expect(finish).toBeTypeOf('function')
    if(action==='pause')store.pause();else if(action==='pause and resume'){store.pause();await store.play()}else if(action==='stop')store.stop();else if(action==='next')await store.next();else await store.setSourceOverride('gd-studio')
    finish(audio('lx',tracks[1]!,99));await flushPromises()
    expect(store.preparedNext.value?.playable.url ?? '').not.toContain('call=99')
  })

  it.each(['auto', 'metadata'] as const)('adopts the same fresh GD-to-LX preparation under %s without another resolve', async (policy) => {
    const { store, gdResolve, lxResolve } = await setup()
    await flushPromises()
    // Neither GD nor LX resolves before the lead window is armed.
    expect(callsFor(gdResolve, 'b')).toBe(0)
    expect(lxResolve).not.toHaveBeenCalled()

    await store.armNextPreparation()
    const prepared = store.preparedNext.value
    expect(prepared?.track).toBe(tracks[1])
    expect(prepared?.providerId).toBe('lx')
    expect(prepared?.armed).toBe(true)
    expect(prepared?.playable.metadata?.quality?.bitrate).toBe(320_000)
    expect(prepared?.attempts).toMatchObject([
      { providerId: 'gd-studio', ok: false, code: 'http_error' },
      { providerId: 'lx', sourceId: 'first-lx-source', ok: false, code: 'unavailable' },
      { providerId: 'lx', ok: true },
    ])
    // A constrained hint can keep a ready source, but cannot start a new resolve.
    store.setPreloadPolicy(policy)
    await flushPromises()
    await store.armNextPreparation()
    expect(store.preparedNext.value).toBe(prepared)
    await store.next()
    expect(store.preloadHandoff.value?.id).toBe(prepared?.id)
    expect(store.playable.value).toBe(prepared?.playable)
    expect(store.activeProviderId.value).toBe('lx')
    expect(store.latestAttempts.value).toEqual(prepared?.attempts)
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(lxResolve, 'b')).toBe(1)
    expect(callsFor(gdResolve, 'c')).toBe(0)
    expect(callsFor(lxResolve, 'c')).toBe(0)
  })

  it('keeps in-flight GD failure and LX sub-attempts private until promotion', async () => {
    const { store, lxResolve } = await setup()
    const activePlayable = store.playable.value
    const activeAttempts = [...store.attempts.value]
    const activeLatest = [...store.latestAttempts.value]
    const generation = store.playbackGeneration.value
    let finish!: (value: Playable) => void
    lxResolve.mockImplementationOnce(async (_track, _signal, context) => {
      context?.onSubAttempt?.({ providerId: 'lx', sourceId: 'pending-lx', ok: false, code: 'unavailable', latencyMs: 1 })
      return new Promise<Playable>((settle) => { finish = settle })
    })
    const arming = store.armNextPreparation()
    await flushPromises()
    expect(callsFor(lxResolve, 'b')).toBe(1)
    expect(store.attempts.value).toEqual(activeAttempts)
    expect(store.latestAttempts.value).toEqual(activeLatest)
    expect(store.playable.value).toBe(activePlayable)
    expect(store.currentTrack.value).toBe(tracks[0])
    expect(store.playbackGeneration.value).toBe(generation)
    expect(store.status.value).toBe('ready')
    finish(audio('lx', tracks[1], 1))
    await arming
    expect(store.latestAttempts.value).toEqual(activeLatest)
    expect(store.attempts.value).toEqual(activeAttempts)
    await store.next()
    expect(store.latestAttempts.value).toMatchObject([
      { providerId: 'gd-studio', ok: false, code: 'http_error' },
      { providerId: 'lx', sourceId: 'pending-lx', ok: false },
      { providerId: 'lx', ok: true },
    ])
  })

  it.each([false, true])('runs just one chain per track/generation when exhausted=%s despite repeated progress', async (lxFails) => {
    const { store, gdResolve, lxResolve } = await setup({ lxFails })
    const activeAttempts = [...store.attempts.value]
    await Promise.all(Array.from({ length: 8 }, () => store.armNextPreparation()))
    for (let i = 0; i < 8; i += 1) await store.armNextPreparation()
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(lxResolve, 'b')).toBe(1)
    expect(store.preparedNext.value?.providerId ?? null).toBe(lxFails ? null : 'lx')
    expect(store.attempts.value).toEqual(activeAttempts)
    expect(store.latestAttempts.value).toEqual(activeAttempts)
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(store.recentFailures.value).toEqual([])
    expect(store.playbackNotices.value).toEqual([])
  })

  it('does not re-arm a failed standby load on progress, but permits a new playback generation', async () => {
    const { store, gdResolve, lxResolve } = await setup()
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('lx')
    store.rejectNextPreparation(store.preparedNext.value!.id)
    await store.armNextPreparation()
    expect(store.preparedNext.value).toBeNull()
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(lxResolve, 'b')).toBe(1)
    await store.prepareQueueIndex(0)
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('lx')
    expect(callsFor(gdResolve, 'b')).toBe(2)
    expect(callsFor(lxResolve, 'b')).toBe(2)
  })

  it('keeps a manual GD override strict when GD fails although LX is playable', async () => {
    const { store, gdResolve, lxResolve } = await setup()
    await store.setSourceOverride('gd-studio')
    const activeAttempts = [...store.attempts.value]
    await store.armNextPreparation()
    await store.armNextPreparation()
    expect(store.preparedNext.value).toBeNull()
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(lxResolve).not.toHaveBeenCalled()
    expect(store.attempts.value).toEqual(activeAttempts)
    expect(store.latestAttempts.value).toEqual(activeAttempts)
    expect(store.sourceOverride.value).toBe('gd-studio')
  })

  it('allows an eligible manual-only LX override but discards it when Next returns to automatic mode', async () => {
    const { store, change, lxResolve } = await setup({ gdNextSucceeds: true })
    change('lx', { automaticEligible: false })
    await store.setSourceOverride('lx')
    await store.armNextPreparation()
    const prepared = store.preparedNext.value
    expect(prepared?.providerId).toBe('lx')
    await store.next()
    expect(store.sourceOverride.value).toBeUndefined()
    expect(store.preloadHandoff.value).toBeNull()
    expect(store.playable.value).not.toBe(prepared?.playable)
    expect(store.activeProviderId.value).toBe('gd-studio')
    expect(callsFor(lxResolve, 'b')).toBe(1)
  })

  it('discards an automatic fallback immediately when the source override changes', async () => {
    const { store, lxResolve } = await setup()
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('lx')
    await store.setSourceOverride('gd-studio')
    expect(store.preparedNext.value).toBeNull()
    await store.armNextPreparation()
    expect(store.preparedNext.value).toBeNull()
    expect(callsFor(lxResolve, 'b')).toBe(1)
  })

  it.each(['priority order', 'priority value', 'timeout', 'provider instance', 'preferred disabled'] as const)(
    'does not adopt a fallback after %s changes, even without an invalidation notification', async (changeKind) => {
      const { store, change, lx, gdResolve, lxResolve } = await setup()
      await store.armNextPreparation()
      const prepared = store.preparedNext.value
      expect(prepared?.providerId).toBe('lx')
      if (changeKind === 'priority order') change('lx', { priority: 1 })
      if (changeKind === 'priority value') change('gd-studio', { priority: 6 })
      if (changeKind === 'timeout') change('gd-studio', { timeoutMs: 2000 })
      if (changeKind === 'provider instance') change('lx', { provider: { ...lx } })
      if (changeKind === 'preferred disabled') change('gd-studio', { enabled: false })
      await store.next()
      expect(store.preloadHandoff.value).toBeNull()
      expect(store.playable.value).not.toBe(prepared?.playable)
      expect(store.activeProviderId.value).toBe('lx')
      expect(callsFor(lxResolve, 'b')).toBe(2)
      expect(callsFor(gdResolve, 'b')).toBe(['priority order', 'preferred disabled'].includes(changeKind) ? 1 : 2)
    },
  )

  it.each(['disabled', 'manual only', 'ineligible'] as const)('refuses to promote LX after it becomes %s', async (changeKind) => {
    const { store, change, lx, gdResolve, lxResolve } = await setup()
    await store.armNextPreparation()
    const prepared = store.preparedNext.value
    expect(prepared?.providerId).toBe('lx')
    if (changeKind === 'disabled') change('lx', { enabled: false })
    if (changeKind === 'manual only') change('lx', { automaticEligible: false })
    if (changeKind === 'ineligible') change('lx', { provider: { ...lx, canResolve: () => false } })
    await store.next()
    expect(store.preloadHandoff.value).toBeNull()
    expect(store.playable.value).not.toBe(prepared?.playable)
    expect(store.activeProviderId.value).not.toBe('lx')
    expect(callsFor(gdResolve, 'b')).toBe(2)
    expect(callsFor(lxResolve, 'b')).toBe(1)
  })

  it('validates the full selection config even when the originally preferred provider succeeded', async () => {
    const { store, change, gdResolve } = await setup({ gdNextSucceeds: true })
    await store.armNextPreparation()
    const prepared = store.preparedNext.value
    expect(prepared?.providerId).toBe('gd-studio')
    change('lx', { enabled: false })
    await store.next()
    expect(store.preloadHandoff.value).toBeNull()
    expect(store.playable.value).not.toBe(prepared?.playable)
    expect(callsFor(gdResolve, 'b')).toBe(2)
  })

  it('discards a mismatching preparation on another arm call without starting a repeated chain', async () => {
    const { store, change, gdResolve, lxResolve } = await setup()
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('lx')
    change('lx', { priority: 1 })
    await store.armNextPreparation()
    expect(store.preparedNext.value).toBeNull()
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(lxResolve, 'b')).toBe(1)
    // The explicit preference event permits one preparation under the changed config.
    store.invalidatePreload()
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('lx')
    expect(callsFor(lxResolve, 'b')).toBe(2)
  })

  it.each([91_000, 101_000])('re-resolves a fallback aged %i ms instead of promoting an unsafe ticket', async (age) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
    const { store, gdResolve, lxResolve } = await setup()
    await store.armNextPreparation()
    const prepared = store.preparedNext.value
    expect(prepared?.providerId).toBe('lx')
    vi.setSystemTime(Date.now() + age)
    await store.next()
    expect(store.preloadHandoff.value).toBeNull()
    expect(store.playable.value).not.toBe(prepared?.playable)
    expect(callsFor(gdResolve, 'b')).toBe(2)
    expect(callsFor(lxResolve, 'b')).toBe(2)
  })

  it('ignores a late preparation after preferences invalidate its in-flight fallback', async () => {
    const { store, lxResolve } = await setup()
    let finish!: (value: Playable) => void
    lxResolve.mockImplementationOnce(async () => new Promise<Playable>((settle) => { finish = settle }))
    const arming = store.armNextPreparation()
    await flushPromises()
    expect(callsFor(lxResolve, 'b')).toBe(1)
    store.invalidatePreload()
    finish(audio('lx', tracks[1], 1))
    await arming
    expect(store.preparedNext.value).toBeNull()
    expect(store.latestAttempts.value).toMatchObject([{ providerId: 'gd-studio', ok: true }])
  })

  it.each(['stop', 'source override', 'pause'] as const)('abandons adoption if %s supersedes registry validation', async (changeKind) => {
    const { store, loadRegistry, registry } = await setup()
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('lx')
    let finish!: (registry: ProviderRegistry) => void
    loadRegistry.mockImplementationOnce(async () => new Promise<ProviderRegistry>((settle) => { finish = settle }))
    const advancing = store.next()
    expect(store.currentTrack.value).toBe(tracks[0])
    if (changeKind === 'stop') store.stop()
    else if (changeKind === 'pause') store.pause()
    else await store.setSourceOverride('gd-studio')
    finish(registry())
    await advancing
    expect(store.currentTrack.value).toBe(changeKind === 'stop' ? undefined : tracks[0])
    expect(store.preloadHandoff.value).toBeNull()
    expect(store.activeProviderId.value).toBe(changeKind === 'stop' ? undefined : 'gd-studio')
    if (changeKind === 'pause') expect(store.playbackIntent.value).toBe('paused')
  })

  it('resolves fresh if the registry cannot be validated at adoption', async () => {
    const { store, loadRegistry, gdResolve, lxResolve } = await setup()
    await store.armNextPreparation()
    const prepared = store.preparedNext.value
    expect(prepared?.providerId).toBe('lx')
    loadRegistry.mockRejectedValueOnce(new Error('registry unavailable'))
    await store.next()
    expect(store.preloadHandoff.value).toBeNull()
    expect(store.playable.value).not.toBe(prepared?.playable)
    expect(callsFor(gdResolve, 'b')).toBe(2)
    expect(callsFor(lxResolve, 'b')).toBe(2)
  })

  it('refuses an injected success for a disabled provider even when it is the first declared binding', async () => {
    const { change, loadRegistry } = await setup()
    const lxTracks = tracks.map((track) => ({ ...track, sources: track.sources.filter(({ provider }) => provider === 'lx') }))
    const store = createPlaybackStore({
      loadRegistry,
      resolve: async (track, registry, options) => track.id === 'b'
        ? { ok: true, providerId: 'lx', playable: audio('lx', track, 1), attempts: [] }
        : resolveTrack(track, registry, options),
      storage: { getItem: () => 'false', setItem: () => {} },
    })
    stores.push(store)
    store.reconcileUpcomingQueue(lxTracks)
    await store.prepareQueueIndex(0)
    change('lx', { enabled: false })
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    expect(store.preparedNext.value).toBeNull()
  })

  it('does not adopt an unverified fallback returned without its preferred-provider failure', async () => {
    const { registry } = await setup()
    const store = createPlaybackStore({
      registry: registry(),
      resolve: async (track, providers, options) => track.id === 'b'
        ? { ok: true, providerId: 'lx', playable: audio('lx', track, 1), attempts: [{ providerId: 'lx', ok: true, latencyMs: 0 }] }
        : resolveTrack(track, providers, options),
      storage: { getItem: () => 'false', setItem: () => {} },
    })
    stores.push(store)
    store.reconcileUpcomingQueue(tracks)
    await store.prepareQueueIndex(0)
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    expect(store.preparedNext.value).toBeNull()
  })
  it('applies rapid next/previous commands to the pending selected queue position', async () => {
    const { store, loadRegistry, registry } = await setup()
    await store.armNextPreparation()
    let finish!: (value: ProviderRegistry) => void
    loadRegistry.mockImplementationOnce(async () => new Promise<ProviderRegistry>(resolve => { finish = resolve }))
    const firstNext = store.next()
    const previous = store.previous()
    const finalNext = store.next()
    finish(registry())
    await Promise.all([firstNext, previous, finalNext])
    expect(store.currentTrack.value).toBe(tracks[1])
    expect(store.currentIndex.value).toBe(1)
  })

  it('continues a rapid next/previous/next from an already playing second track to the third track', async () => {
    const { store, loadRegistry, registry } = await setup()
    await store.playQueueIndex(1)
    await store.armNextPreparation()
    let finish!: (value: ProviderRegistry) => void
    loadRegistry.mockImplementationOnce(async () => new Promise<ProviderRegistry>(resolve => { finish = resolve }))
    const firstNext = store.next()
    const previous = store.previous()
    const finalNext = store.next()
    finish(registry())
    await Promise.all([firstNext, previous, finalNext])
    expect(store.currentTrack.value).toBe(tracks[2])
    expect(store.currentIndex.value).toBe(2)
  })

  it('keeps falling back across 4 providers (resolve + standby media failures) until 1 succeeds, then stops cleanly when exhausted', async () => {
    const multiTracks: Track[] = ['a', 'b'].map((id) => ({
      id, title: id, aliases: {}, games: [], relationIds: [], tabs: [], workGroupId: 'test',
      needsClassification: false, vocalStatus: 'instrumental',
      sources: [
        { provider: 'lx', externalId: `wy:${id}` },
        { provider: 'chksz', externalId: `netease-${id}` },
        { provider: 'vkeys', externalId: id },
      ],
    }))
    const lxResolve = vi.fn(async (track: Track): Promise<Playable | null> =>
      track.id === 'a' ? audio('lx', track, 1) : null)
    const gdResolve = vi.fn(async (track: Track): Promise<Playable | null> =>
      audio('gd-studio', track, gdResolve.mock.calls.length))
    const vkeysResolve = vi.fn(async (track: Track): Promise<Playable | null> =>
      audio('vkeys', track, vkeysResolve.mock.calls.length))
    const chkszResolve = vi.fn(async (track: Track): Promise<Playable | null> =>
      audio('chksz', track, chkszResolve.mock.calls.length))
    const registry = new ProviderRegistry([
      { provider: { id: 'lx', canResolve: () => true, resolve: lxResolve }, enabled: true, priority: 1, timeoutMs: 1000 },
      { provider: { id: 'gd-studio', canResolve: () => true, resolve: gdResolve }, enabled: true, priority: 2, timeoutMs: 1000 },
      { provider: { id: 'vkeys', canResolve: () => true, resolve: vkeysResolve }, enabled: true, priority: 3, timeoutMs: 1000 },
      { provider: { id: 'chksz', canResolve: () => true, resolve: chkszResolve }, enabled: true, priority: 4, timeoutMs: 1000 },
    ])
    const store = createPlaybackStore({
      registry, resolve: resolveTrack,
      storage: { getItem: (key) => key === 'hoyomix-player-shuffle-v1' ? 'false' : null, setItem: () => {} },
    })
    stores.push(store)
    store.reconcileUpcomingQueue(multiTracks)
    await store.playQueueIndex(0)
    store.setPreloadPolicy('auto')
    await store.armNextPreparation()
    // Provider 1 (lx) failed resolve -> Provider 2 (gd-studio) prepared
    expect(store.preparedNext.value?.providerId).toBe('gd-studio')
    // Provider 2 fails standby media -> Provider 3 (vkeys) prepared
    store.rejectNextPreparation(store.preparedNext.value!.id)
    await flushPromises()
    expect(store.preparedNext.value?.providerId).toBe('vkeys')
    // Provider 3 fails standby media -> Provider 4 (chksz) prepared
    store.rejectNextPreparation(store.preparedNext.value!.id)
    await flushPromises()
    expect(store.preparedNext.value?.providerId).toBe('chksz')
    const prepared = store.preparedNext.value!
    await store.next()
    expect(store.preloadHandoff.value?.id).toBe(prepared.id)
    expect(store.activeProviderId.value).toBe('chksz')
    expect(callsFor(lxResolve, 'b')).toBe(1)
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(vkeysResolve, 'b')).toBe(1)
    expect(callsFor(chkszResolve, 'b')).toBe(1)
  })

  it('resumes fallback from untried providers after seek or pause/resume interrupts standby fallback', async () => {
    const { store, gdResolve, lxResolve, loadRegistry, registry } = await setup({ gdNextSucceeds: true })
    const thirdResolve = vi.fn(async (track: Track) => audio('vkeys', track, 1))
    loadRegistry.mockResolvedValue(new ProviderRegistry([
      ...registry().enabled(),
      { provider: { id: 'vkeys', canResolve: () => true, resolve: thirdResolve }, enabled: true, priority: 15, timeoutMs: 1000 },
    ]))
    await store.play()
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('gd-studio')
    // Standby media fails while paused -> queued for fallback instead of permanently locked
    store.pause()
    store.rejectNextPreparation(store.preparedNext.value!.id)
    await flushPromises()
    expect(lxResolve).not.toHaveBeenCalled()
    expect(store.preparedNext.value).toBeNull()
    // Resuming playback and firing progress resumes from lx without retrying gd-studio
    await store.play()
    store.reportMediaState('playing', store.playbackGeneration.value)
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('lx')
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(lxResolve, 'b')).toBe(1)
    // Now seek interrupts an in-flight vkeys fallback after lx standby media fails
    let finishVkeys!: (value: Playable) => void
    thirdResolve.mockImplementationOnce(() => new Promise<Playable>((resolve) => { finishVkeys = resolve }))
    store.rejectNextPreparation(store.preparedNext.value!.id)
    await flushPromises()
    store.reportProgress(80, store.playbackGeneration.value, true)
    finishVkeys(audio('vkeys', tracks[1]!, 99))
    await flushPromises()
    expect(store.preparedNext.value).toBeNull()
    // Subsequent progress resumes vkeys without retrying gd-studio or lx
    thirdResolve.mockImplementationOnce(async (track: Track) => audio('vkeys', track, 2))
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('vkeys')
    expect(store.preparedNext.value?.playable.url).toContain('call=2')
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(lxResolve, 'b')).toBe(1)
    expect(callsFor(thirdResolve, 'b')).toBe(2)
  })

  it('does not let a slow failing first provider age out the fallback provider ticket', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
    const { store, gdResolve, lxResolve } = await setup()
    let failGd!: (reason: Error) => void
    gdResolve.mockImplementationOnce(() => new Promise((_resolve, reject) => { failGd = reject }))
    const arming = store.armNextPreparation()
    await flushPromises()
    // First provider takes 55 s before failing
    vi.setSystemTime(Date.now() + 55_000)
    failGd(new ProviderResolveError('timeout'))
    await arming
    const prepared = store.preparedNext.value
    expect(prepared?.providerId).toBe('lx')
    // 60 s after fallback resolved (115 s since chain started, but only 60 s since lx began),
    // lx's fresh 120 s ticket still has 60 s (> 30 s margin) left and is promoted without re-resolving.
    vi.setSystemTime(Date.now() + 60_000)
    await store.next()
    expect(store.preloadHandoff.value?.id).toBe(prepared?.id)
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(lxResolve, 'b')).toBe(1)
  })

  it('re-prepares a stale >90s preparation on progress without retrying earlier failed providers', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-26T00:00:00Z'))
    const { store, gdResolve, lxResolve } = await setup({ gdNextSucceeds: false })
    await store.playQueueIndex(0)
    store.reportMediaState('playing', store.playbackGeneration.value)
    await store.armNextPreparation()
    const firstPrepared = store.preparedNext.value!
    expect(firstPrepared.providerId).toBe('lx')

    // Exceed the 90 s handover ticket margin while a >3 min track continues playing past 50%.
    vi.setSystemTime(Date.now() + (MEDIA_TICKET_TTL_MS - HANDOVER_TICKET_MARGIN_MS) + 1)
    await store.armNextPreparation()
    const refreshed = store.preparedNext.value!
    expect(refreshed.providerId).toBe('lx')
    expect(refreshed.id).not.toBe(firstPrepared.id)
    // Failed gd-studio stays excluded, while lx is refreshed once.
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(lxResolve, 'b')).toBe(2)

    await store.next()
    expect(store.preloadHandoff.value?.id).toBe(refreshed.id)
    expect(callsFor(lxResolve, 'b')).toBe(2)
  })

  it('awaits and promotes an in-flight media fallback when advancing to that track', async () => {
    const { store, gdResolve, lxResolve } = await setup({ gdNextSucceeds: true })
    await store.playQueueIndex(0)
    store.reportMediaState('playing', store.playbackGeneration.value)
    await store.armNextPreparation()
    expect(store.preparedNext.value?.providerId).toBe('gd-studio')

    let finishLx!: (value: Playable) => void
    lxResolve.mockImplementationOnce(() => new Promise<Playable>((resolve) => { finishLx = resolve }))
    store.rejectNextPreparation(store.preparedNext.value!.id)
    await flushPromises()
    expect(callsFor(lxResolve, 'b')).toBe(1)

    const nextCall = store.next()
    await flushPromises()
    finishLx(audio('lx', tracks[1]!, 1))
    await nextCall
    expect(store.currentTrack.value).toBe(tracks[1])
    expect(store.preloadHandoff.value?.providerId).toBe('lx')
    expect(store.activeProviderId.value).toBe('lx')
    expect(callsFor(gdResolve, 'b')).toBe(1)
    expect(callsFor(lxResolve, 'b')).toBe(1)
  })

})
