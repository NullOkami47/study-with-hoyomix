import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import PlayerBar from './PlayerBar.vue'
import { createPlaybackStore } from './store'
import { playbackCommands } from './commands'
import { createSleepTimerStore } from '../timers/sleep/store'
import { ProviderRegistry } from './providers/registry'
import type { Track } from '../catalog/types'
const track = (id: string): Track => ({
  id, title: id, aliases: {}, games: ['genshin'], tabs: ['focus'],
  sources: [{ provider: 'lx', externalId: id }, { provider: 'jellyfin', externalId: id }],
  relationIds: [], workGroupId: 'g', vocalStatus: 'instrumental', needsClassification: false,
})
const flush = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await nextTick()
}
const media = (element: HTMLAudioElement, buffered = 30) => {
  Object.defineProperties(element, {
    duration: { configurable: true, value: 30 },
    readyState: { configurable: true, value: 4 },
    buffered: { configurable: true, value: { length: buffered ? 1 : 0, start: () => 0, end: () => buffered } },
    seekable: { configurable: true, value: { length: 1, start: () => 0, end: () => 30 } },
  })
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
async function setup(buffered = 30) {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  const resolver = vi.fn(async (track: Track) => ({
    kind: 'audio' as const, url: 'https://media.invalid/' + track.id + '.mp3', mimeType: 'audio/mpeg',
  }))
  const jf = vi.fn(async () => null)
  const registry = new ProviderRegistry([
    { provider: { id: 'lx', resolve: resolver }, enabled: true, priority: 1, timeoutMs: 1000 },
    { provider: { id: 'jellyfin', resolve: jf }, enabled: false, priority: 0, timeoutMs: 1000 },
  ])
  const store = createPlaybackStore({
    registry, storage: { getItem: key => key.includes('shuffle') ? 'false' : null, setItem: () => {} },
  })
  store.setTransitionMode('crossfade')
  store.reconcileUpcomingQueue(['a', 'b', 'c'].map(track))
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false })
    this.dispatchEvent(new Event('play'))
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    if (this.paused) return
    Object.defineProperty(this, 'paused', { configurable: true, value: true })
    this.dispatchEvent(new Event('pause'))
  })
  const wrapper = mount(PlayerBar, { props: { store } })
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; wrapper.unmount() } }
  await store.playQueueIndex(0)
  await flush()
  const first = wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
  media(first)
  first.currentTime = 10
  first.dispatchEvent(new Event('timeupdate'))
  await flush()
  const standby = wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element
  media(standby, buffered)
  standby.dispatchEvent(new Event('progress'))
  await flush()
  return { store, wrapper, first, standby, resolver, play, jf, unmount, close: () => { unmount(); store.dispose() } }
}
describe('authorised two-deck transitions',()=>{
  it('counts rapid Next requests from the pending target rather than the stale current index', async () => {
    const t = await setup(0)
    try {
      playbackCommands.next?.(); await flush()
      playbackCommands.next?.(); await flush()
      await vi.advanceTimersByTimeAsync(650); await flush()
      expect(t.store.currentTrack.value?.id).toBe('c')
      expect(t.jf).not.toHaveBeenCalled()
    } finally {t.close()}
  })
  it('counts rapid Previous requests while preparing an earlier track', async () => {
    const t = await setup()
    try {
      await t.store.playQueueIndex(2); await flush()
      const current = t.wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
      media(current)
      playbackCommands.previous?.(); await flush()
      playbackCommands.previous?.(); await flush()
      await vi.advanceTimersByTimeAsync(650); await flush()
      expect(t.store.currentTrack.value?.id).toBe('a')
    } finally {t.close()}
  })
  it('does not prepare an override result that the next automatic selection must discard', async () => {
    const t = await setup()
    try {
      await t.store.setSourceOverride('lx'); await flush()
      const before = t.resolver.mock.calls.filter(([track]) => track.id === 'b').length
      playbackCommands.next?.(); await flush()
      await vi.advanceTimersByTimeAsync(650); await flush()
      expect(t.store.currentTrack.value?.id).toBe('b')
      expect(t.resolver.mock.calls.filter(([track]) => track.id === 'b')).toHaveLength(before + 1)
    } finally {t.close()}
  })
  it('keeps an incoming deck muted when native volume cannot be controlled', async () => {
    const t = await setup()
    try {
      Object.defineProperty(t.standby, 'volume', {configurable:true,get:()=>1,set:()=>{}})
      t.first.currentTime = 26; t.first.dispatchEvent(new Event('timeupdate')); await flush()
      expect(t.store.currentTrack.value?.id).toBe('a')
      expect(t.standby.paused).toBe(true)
      expect(t.standby.muted).toBe(true)
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
    } finally {t.close()}
  })
  it('bounds overlap by the incoming duration so a short track reaches user volume', async () => {
    const t = await setup()
    try {
      t.store.setCrossfadeDuration(12)
      media(t.standby, 2)
      Object.defineProperty(t.standby, 'duration', {configurable:true,value:2})
      t.first.currentTime = 18; t.first.dispatchEvent(new Event('timeupdate')); await flush()
      expect(t.store.currentTrack.value?.id).toBe('a')
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
      t.first.currentTime = 28.95; t.first.dispatchEvent(new Event('timeupdate')); await flush()
      expect(t.store.currentTrack.value?.id).toBe('b')
      await vi.advanceTimersByTimeAsync(1050); await flush()
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
      expect(t.standby.volume).toBe(t.store.volume.value)
    } finally {t.close()}
  })

  it('cancels a pending manual switch when a seek command changes the current position', async () => {
    const t = await setup(0)
    try {
      playbackCommands.next?.()
      await flush()
      playbackCommands.seek?.(5)
      media(t.standby)
      await vi.advanceTimersByTimeAsync(100)
      await flush()
      expect(t.store.currentTrack.value?.id).toBe('a')
      expect(t.first.currentTime).toBe(5)
      expect(t.standby.paused).toBe(true)
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
    } finally { t.close() }
  })

  it('ends overlap synchronously when the listener seeks through the shared controls', async () => {
    const t = await setup()
    try {
      t.first.currentTime = 26
      t.first.dispatchEvent(new Event('timeupdate'))
      await flush()
      playbackCommands.seek?.(8)
      expect(t.first.paused).toBe(true)
      expect(t.standby.currentTime).toBe(8)
      await flush()
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
      expect(t.standby.volume).toBe(t.store.volume.value)
    } finally { t.close() }
  })

  it('pauses a delayed incoming play even after its component has unmounted', async () => {
    const t = await setup()
    try {
      let accept!: () => void
      t.play.mockImplementationOnce(function (this: HTMLMediaElement) {
        return new Promise<void>(resolve => { accept = () => {
          Object.defineProperty(this, 'paused', { configurable: true, value: false })
          resolve()
        } })
      })
      playbackCommands.next?.()
      await flush()
      t.unmount()
      accept()
      await flush()
      expect(t.standby.paused).toBe(true)
      expect(t.standby.hasAttribute('src')).toBe(false)
      expect(t.first.paused).toBe(true)
      expect(t.store.currentTrack.value?.id).toBe('a')
      expect(t.jf).not.toHaveBeenCalled()
    } finally { t.close() }
  })

  it('honours a headphone pause while the manual target is still buffering', async () => {
    const t = await setup(0)
    try {
      const renew = vi.spyOn(t.store, 'renewMedia')
      playbackCommands.next?.()
      await flush()
      t.first.pause()
      media(t.standby)
      await vi.advanceTimersByTimeAsync(650)
      await flush()
      expect(t.store.currentTrack.value?.id).toBe('a')
      expect(t.first.paused).toBe(true)
      expect(t.standby.paused).toBe(true)
      expect(playbackCommands.pauseForInterruption()).toBeUndefined()
      expect(renew).not.toHaveBeenCalled()
      expect(t.jf).not.toHaveBeenCalled()
    } finally { t.close() }
  })

  it('does not commit a delayed incoming play after a newer queue selection', async () => {
    const t = await setup()
    try {
      let accept!: () => void
      t.play.mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve }))
      playbackCommands.next?.()
      await flush()
      await t.store.playQueueIndex(2)
      await flush()
      accept()
      await flush()
      const active = t.wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
      expect(t.store.currentTrack.value?.id).toBe('c')
      expect(active.paused).toBe(false)
      expect(t.wrapper.findAll('audio').filter(deck => !deck.element.paused && !deck.element.muted)).toHaveLength(1)
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
      expect(t.jf).not.toHaveBeenCalled()
    } finally { t.close() }
  })

  it('renews the active source at the same position after a media error during overlap', async () => {
    const t = await setup()
    try {
      t.first.currentTime = 26
      t.first.dispatchEvent(new Event('timeupdate'))
      await flush()
      t.standby.currentTime = 7
      t.standby.dispatchEvent(new Event('timeupdate'))
      await flush()
      const failure = vi.spyOn(t.store, 'reportPlaybackFailure')
      t.resolver.mockResolvedValueOnce({ kind: 'audio', url: 'https://media.invalid/renewed-b.mp3', mimeType: 'audio/mpeg' })
      Object.defineProperty(t.standby, 'error', { configurable: true, value: { code: 2 } })
      t.standby.dispatchEvent(new Event('error'))
      await flush()
      const renewed = t.wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
      expect(renewed.getAttribute('src')).toBe('https://media.invalid/renewed-b.mp3')
      expect(t.store.currentTrack.value?.id).toBe('b')
      expect(t.store.pendingResumePosition.value).toBe(7)
      media(renewed)
      renewed.dispatchEvent(new Event('loadedmetadata'))
      renewed.dispatchEvent(new Event('seeked'))
      await flush()
      expect(renewed.currentTime).toBe(7)
      expect(t.store.pendingResumePosition.value).toBeUndefined()
      expect(failure).not.toHaveBeenCalled()
      expect(t.jf).not.toHaveBeenCalled()
      expect(t.wrapper.findAll('audio').filter(deck => !deck.element.paused && !deck.element.muted)).toHaveLength(1)
    } finally { t.close() }
  })

  it.each(['pause', 'next'] as const)('runs overlap MediaError recovery only while still owned, cancelling on %s', async command => {
    const t = await setup()
    let finishRenewal: ((renewed: boolean) => void) | undefined
    try {
      t.first.currentTime = 26
      t.first.dispatchEvent(new Event('timeupdate'))
      await flush()
      const generation = t.store.playbackGeneration.value
      const failure = vi.spyOn(t.store, 'reportPlaybackFailure')
      const renew = vi.spyOn(t.store, 'renewMedia').mockImplementation(() => new Promise(resolve => { finishRenewal = resolve }))
      Object.defineProperty(t.standby, 'error', { configurable: true, value: { code: 2 } })
      t.standby.dispatchEvent(new Event('error'))
      await flush()
      const stillNeeded = renew.mock.calls[0]?.[2]
      expect(renew).toHaveBeenCalledTimes(1)
      expect(renew).toHaveBeenCalledWith('lx', generation, stillNeeded)
      expect(stillNeeded?.()).toBe(true)
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
      expect(t.first.paused).toBe(true)

      if (command === 'pause') playbackCommands.pause()
      else playbackCommands.next?.()
      expect(stillNeeded?.()).toBe(false)
      await flush()
      if (command === 'next') { await vi.advanceTimersByTimeAsync(650); await flush() }
      const selected = t.store.playable.value
      const selectedGeneration = t.store.playbackGeneration.value
      // A late failed renewal must not fall through into provider recovery after cancellation.
      finishRenewal!(false)
      await flush()
      expect(stillNeeded?.()).toBe(false)
      expect(failure).not.toHaveBeenCalled()
      expect(t.store.currentTrack.value?.id).toBe(command === 'pause' ? 'b' : 'c')
      expect(t.store.playbackIntent.value).toBe(command === 'pause' ? 'paused' : 'playing')
      expect(t.store.playbackGeneration.value).toBe(selectedGeneration)
      expect(t.store.playable.value).toBe(selected)
    } finally { finishRenewal?.(false); t.close() }
  })

  it('runs active-provider recovery for an actual MediaError during overlap', async () => {
    const t = await setup()
    try {
      t.first.currentTime = 26; t.first.dispatchEvent(new Event('timeupdate')); await flush()
      let settle!: (renewed: boolean) => void
      const renew = vi.spyOn(t.store, 'renewMedia').mockImplementation(() => new Promise<boolean>(resolve => { settle = resolve }))
      Object.defineProperty(t.standby, 'error', {configurable:true,value:{code:2}})
      t.standby.dispatchEvent(new Event('error')); await flush()
      expect(renew).toHaveBeenCalledTimes(1)
      const [providerId, generation, stillNeeded] = renew.mock.calls[0]
      expect(providerId).toBe('lx')
      expect(generation).toBe(t.store.playbackGeneration.value)
      expect(stillNeeded?.()).toBe(true)
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
      expect(t.first.paused).toBe(true)
      t.store.pause()
      expect(stillNeeded?.()).toBe(false)
      await t.store.play()
      expect(stillNeeded?.()).toBe(false)
      settle(true); await flush()
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
      expect(t.first.paused).toBe(true)
    } finally {t.close()}
  })


  it('finishes the gain envelope before a late outgoing track reaches its end', async () => {
    const t = await setup()
    try {
      t.first.currentTime = 28
      t.first.dispatchEvent(new Event('timeupdate'))
      await flush()
      await vi.advanceTimersByTimeAsync(1950)
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
      expect(t.standby.volume).toBe(t.store.volume.value)
    } finally { t.close() }
  })
  it('uses a short manual Next fade and waits briefly for Previous buffering', async () => {
    const t = await setup()
    try {
      playbackCommands.next?.(); await flush()
      expect(t.store.currentTrack.value?.id).toBe('b')
      await vi.advanceTimersByTimeAsync(1550); await flush()
      playbackCommands.previous?.(); await flush()
      const previous = t.wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element
      expect(t.store.currentTrack.value?.id).toBe('b')
      media(previous)
      await vi.advanceTimersByTimeAsync(50); await flush()
      expect(t.store.currentTrack.value?.id).toBe('a')
      expect(t.wrapper.attributes('data-transition-active')).toBe('true')
      await vi.advanceTimersByTimeAsync(1550)
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
    } finally { t.close() }
  })
  it('sleep expiry stops both decks and no pending fade restarts them', async () => {
    const t = await setup()
    let now = 0
    const timer = createSleepTimerStore({ player: playbackCommands, autoTick: false, clock: { now: () => now },
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
    try {
      timer.start()
      t.first.currentTime = 26; t.first.dispatchEvent(new Event('timeupdate')); await flush()
      now = 15 * 60_000; timer.tick(); await flush()
      await vi.advanceTimersByTimeAsync(6000)
      expect(timer.status.value).toBe('expired')
      expect(t.first.paused).toBe(true); expect(t.standby.paused).toBe(true)
      expect(t.store.playbackIntent.value).toBe('paused')
    } finally { timer.destroy(); t.close() }
  })
  it('invalidates a delayed incoming play after pause and keeps its late event inaudible', async () => {
    const t = await setup()
    try {
      let accept!: () => void
      t.play.mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve }))
      playbackCommands.next?.(); await flush()
      playbackCommands.pause(); accept(); await flush()
      t.standby.dispatchEvent(new Event('play')); await flush()
      expect(t.store.currentTrack.value?.id).toBe('a')
      expect(t.store.playbackIntent.value).toBe('paused')
      expect(t.standby.paused).toBe(true)
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
    } finally { t.close() }
  })
  it('a failed standby fetch is discarded without a retry loop or active interruption', async () => {
    const t = await setup()
    try {
      const calls = t.resolver.mock.calls.length
      Object.defineProperty(t.standby, 'error', { configurable: true, value: { code: 4 } })
      t.standby.dispatchEvent(new Event('error')); await flush()
      for (let i = 0; i < 4; i++) { t.first.dispatchEvent(new Event('timeupdate')); await flush() }
      expect(t.store.preparedNext.value).toBeNull()
      expect(t.resolver.mock.calls.length).toBe(calls)
      expect(t.first.paused).toBe(false)
      await t.store.next(); await flush()
      expect(t.store.currentTrack.value?.id).toBe('b')
      expect(t.resolver.mock.calls.filter(([v]) => v.id === 'b')).toHaveLength(2)
    } finally { t.close() }
  })
  it('promotes the buffered element without a second resolve or source change and fades safely',async()=>{
    const t=await setup();try{
      const url=t.standby.getAttribute('src');t.first.currentTime=25.1;t.first.dispatchEvent(new Event('timeupdate'));await flush()
      expect(t.store.currentTrack.value?.id).toBe('b');expect(t.wrapper.get('[data-audio-role="active"]').element).toBe(t.standby)
      expect(t.standby.getAttribute('src')).toBe(url);expect(t.first.paused).toBe(false)
      expect(t.wrapper.attributes('data-transition-active')).toBe('true')
      await vi.advanceTimersByTimeAsync(2500);await flush()
      expect(t.first.volume).toBeGreaterThan(0);expect(t.standby.volume).toBeGreaterThan(0)
      expect(t.first.volume+t.standby.volume).toBeCloseTo(t.store.volume.value)
      t.store.setVolume(0);await flush();expect(t.first.volume+t.standby.volume).toBe(0)
      t.store.setVolume(.4);await flush();await vi.advanceTimersByTimeAsync(2600);await flush()
      expect(t.first.paused).toBe(true);expect(t.standby.volume).toBe(.4)
      expect(t.wrapper.attributes('data-transition-active')).toBe('false')
      expect(t.resolver.mock.calls.filter(([v])=>v.id==='b')).toHaveLength(1);expect(t.jf).not.toHaveBeenCalled()
    }finally{t.close()}
  })
  it('does not overlap on a URL or readyState without buffered audio',async()=>{
    const t=await setup(0);try{t.first.currentTime=26;t.first.dispatchEvent(new Event('timeupdate'));await flush();expect(t.store.currentTrack.value?.id).toBe('a');expect(t.wrapper.attributes('data-transition-active')).toBe('false')}finally{t.close()}
  })
  it.each(['pause','seek','background','native-pause','stop'])('cleans overlap on %s',async(action)=>{
    const t=await setup();try{
      t.first.currentTime=26;t.first.dispatchEvent(new Event('timeupdate'));await flush();expect(t.store.currentTrack.value?.id).toBe('b')
      if(action==='pause') (t.wrapper.vm as unknown as {pause():void}).pause()
      if(action==='stop') (t.wrapper.vm as unknown as {stop():void}).stop()
      if(action==='seek') t.standby.dispatchEvent(new Event('seeking'))
      if(action==='background'){Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))}
      if(action==='native-pause') t.standby.pause()
      await flush();expect(t.wrapper.attributes('data-transition-active')).toBe('false');expect(t.first.paused).toBe(true)
      if(['pause','stop','native-pause'].includes(action))expect(t.standby.paused).toBe(true)
    }finally{t.close()}
  })
  it('leaves the outgoing track alone when autoplay rejects the incoming deck',async()=>{
    const t=await setup();try{
      t.play.mockImplementationOnce(()=>Promise.reject(new DOMException('blocked','NotAllowedError')))
      t.first.currentTime=26;t.first.dispatchEvent(new Event('timeupdate'));await flush()
      expect(t.store.currentTrack.value?.id).toBe('a');expect(t.first.paused).toBe(false);expect(t.standby.paused).toBe(true)
    }finally{t.close()}
  })
})
