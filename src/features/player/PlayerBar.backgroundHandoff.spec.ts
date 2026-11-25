// Regression coverage for prepared background handoff. The mounted PlayerBar/store
// are real; native media methods are controlled for event ordering. This is not
// physical-device or OS background-policy acceptance.
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { ProviderRegistry } from './providers/registry'
import { createPlaybackStore, type PlaybackStore } from './store'
import { playbackCommands } from './commands'
import { playbackLog } from './playbackLog'

let wrapper: VueWrapper | undefined
let store: PlaybackStore | undefined
let inEndedCallback = false
const requests: Array<{ element: HTMLMediaElement; src: string | null; inEndedCallback: boolean }> = []
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0) }
const track = (id: string): Track => ({ id, title:id, aliases:{}, games:['genshin'], relationIds:[], tabs:['focus'], workGroupId:'wg', vocalStatus:'instrumental', needsClassification:false, sources:[{provider:'lx',externalId:'wy:'+id+':320k'}] }) as Track
const active = () => wrapper!.get<HTMLAudioElement>('audio[data-audio-role="active"]').element
const loads = (element: HTMLMediaElement) => vi.mocked(HTMLMediaElement.prototype.load).mock.contexts.filter(context=>context===element).length
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function ready(audio: HTMLAudioElement, time: number, paused: boolean) {
  Object.defineProperties(audio, {
    duration:{configurable:true,value:240},readyState:{configurable:true,value:4},
    paused:{configurable:true,value:paused},ended:{configurable:true,value:false},seeking:{configurable:true,value:false},
    buffered:{configurable:true,value:{length:1,start:()=>0,end:()=>240}},
    seekable:{configurable:true,value:{length:1,start:()=>0,end:()=>240}},
  })
  audio.currentTime=time
}
async function setup(startIndex=0, query='') {
  const resolve=vi.fn(async(t:Track)=>({kind:'audio' as const,url:'https://media.invalid/'+t.id+'.mp3'+query,mimeType:'audio/mpeg'}))
  const provider={id:'lx',canResolve:()=>true,resolve}
  store=createPlaybackStore({registry:new ProviderRegistry([{provider,enabled:true,priority:1,timeoutMs:1000}]),storage:{getItem:k=>k==='hoyomix-player-shuffle-v1'?'false':null,setItem:()=>{}}})
  store.enqueue(track('a'));store.enqueue(track('b'));store.enqueue(track('c'))
  wrapper=mount(PlayerBar,{props:{store},attachTo:document.body})
  if(startIndex===2)store.setRepeatMode('all')
  await store.playQueueIndex(startIndex);await flush()
  const old=active();ready(old,230,false);old.dispatchEvent(new Event('playing'));old.dispatchEvent(new Event('timeupdate'));await flush()
  store.setPreloadPolicy('auto');await store.armNextPreparation();await flush()
  expect(store.preparedNext.value?.track.id).toBe(startIndex===2?'a':'b')
  const standby=wrapper.get<HTMLAudioElement>('audio[data-audio-role="standby"]').element
  ready(standby,0,true);standby.dispatchEvent(new Event('canplay'));await flush()
  expect(store.preparedNext.value?.armed).toBe(true)
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})
  Object.defineProperty(document,'hidden',{configurable:true,value:true})
  document.dispatchEvent(new Event('visibilitychange'))
  return {old,standby,resolve}
}
function naturalEnd(old: HTMLAudioElement) {
  old.currentTime=240
  Object.defineProperty(old,'ended',{configurable:true,value:true})
  Object.defineProperty(old,'paused',{configurable:true,value:true})
  old.dispatchEvent(new Event('pause'))
  inEndedCallback=true
  try { old.dispatchEvent(new Event('ended')) } finally { inEndedCallback=false }
}
beforeEach(()=>{
  vi.useFakeTimers();requests.length=0;inEndedCallback=false;playbackLog.clear()
  vi.spyOn(HTMLMediaElement.prototype,'play').mockImplementation(function(this:HTMLMediaElement){
    requests.push({element:this,src:this.getAttribute('src'),inEndedCallback})
    Object.defineProperty(this,'paused',{configurable:true,value:false});this.dispatchEvent(new Event('play'));return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(function(this:HTMLMediaElement){Object.defineProperty(this,'paused',{configurable:true,value:true})})
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{})
})
afterEach(()=>{wrapper?.unmount();store?.dispose();wrapper=undefined;store=undefined;Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(document,'hidden');Reflect.deleteProperty(navigator,'maxTouchPoints');vi.restoreAllMocks();vi.useRealTimers()})

describe('prepared background native handoff',()=>{
  it('distinguishes a fully buffered native pause after cold natural handover from application pause requests', async () => {
    const { old } = await setup()
    store!.setTransitionMode('off')
    store!.setPreloadPolicy('none')
    store!.invalidatePreload()
    await flush()
    playbackLog.clear()
    naturalEnd(old); await flush()
    const current = active()
    expect(current).not.toBe(old)
    ready(current, .879832, false)
    current.dispatchEvent(new Event('playing')); current.dispatchEvent(new Event('timeupdate')); await flush()
    const beforePause = playbackLog.snapshot().length
    Object.defineProperty(current, 'paused', { configurable: true, value: true })
    current.dispatchEvent(new Event('pause')); await flush()
    const pauseEvent = playbackLog.snapshot().slice(beforePause).find(e => e.type === 'media.native.pause')
    expect(pauseEvent).toMatchObject({ intent: 'playing', paused: true, readyState: 4,
      currentTime: .88, buffered: '0-240', active: true, elementGen: String(store!.playbackGeneration.value) })
    expect(pauseEvent?.elementId).toEqual(expect.any(Number))
    const appPauses = playbackLog.snapshot().slice(beforePause).filter(e => e.type === 'media.app.pause' && e.elementId === pauseEvent?.elementId)
    expect(appPauses).toHaveLength(0)
    expect(store!.playbackIntent.value).toBe('playing')
    expect(store!.status.value).toBe('paused')
    const plays = requests.length
    await vi.advanceTimersByTimeAsync(6000); await flush()
    expect(requests).toHaveLength(plays)
    playbackCommands.play(); await flush()
    ready(current, 1, false); current.dispatchEvent(new Event('playing')); current.dispatchEvent(new Event('timeupdate')); await flush()
    expect(store!.status.value).toBe('playing')
  })

  it('records explicit Pause separately and retains element identity across native events', async () => {
    const { old } = await setup()
    naturalEnd(old); await flush()
    const current = active()
    ready(current, .5, false); current.dispatchEvent(new Event('playing')); await flush()
    playbackLog.clear()
    playbackCommands.pause(); await flush()
    current.dispatchEvent(new Event('pause')); await flush()
    const entries = playbackLog.snapshot()
    const request = entries.find(e => e.type === 'media.app.pause' && e.active === true)
    const event = entries.find(e => e.type === 'media.native.pause' && e.active === true)
    expect(request).toMatchObject({ site: 'pause-media', intent: 'paused' })
    expect(event?.elementId).toBe(request?.elementId)
    expect(event?.sourceRevision).toBe(request?.sourceRevision)
    expect(store!.playbackIntent.value).toBe('paused')
  })

  it.each([
    'Mozilla/5.0 (Linux; Android 17) AppleWebKit/537.36 Chrome/157.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 Version/27.2 Mobile Safari/604.1',
  ])('preserves the activated mobile background path and holds the prepared buffer until progress: %s', async userAgent => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    const {old,standby,resolve}=await setup()
    const loadCount=loads(standby)
    naturalEnd(old);await flush()
    expect(active()).toBe(old)
    expect(standby.isConnected).toBe(true)
    expect(standby.getAttribute('src')).toBe('https://media.invalid/b.mp3')
    expect(loads(standby)).toBe(loadCount)
    expect(resolve.mock.calls.filter(([t])=>t.id==='b')).toHaveLength(1)
    ready(old,.5,false);old.dispatchEvent(new Event('playing'));old.dispatchEvent(new Event('timeupdate'));await flush()
    expect(standby.hasAttribute('src')).toBe(false)
    expect(store!.currentTrack.value?.id).toBe('b')
    expect(store!.status.value).toBe('playing')
  })

  it('keeps foreground preroll on desktop Chromium', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36')
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    Object.defineProperty(navigator, 'maxTouchPoints', {configurable:true, value:5})
    const {old,standby}=await setup()
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
    Object.defineProperty(document,'hidden',{configurable:true,value:false})
    document.dispatchEvent(new Event('visibilitychange'));await flush()
    const before=requests.length
    old.currentTime=239;old.dispatchEvent(new Event('timeupdate'));await flush()
    expect(requests.slice(before).filter(r=>r.element===standby)).toHaveLength(1)
    expect(standby.volume).toBe(0)
  })

  it('promotes the preloaded foreground iPad deck without a preroll or second resolution', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.2 Safari/605.1.15')
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    Object.defineProperty(navigator, 'maxTouchPoints', {configurable:true, value:5})
    const {old,standby,resolve}=await setup()
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
    Object.defineProperty(document,'hidden',{configurable:true,value:false})
    document.dispatchEvent(new Event('visibilitychange'));await flush()
    const before=requests.length
    old.currentTime=239;old.dispatchEvent(new Event('timeupdate'));await flush()
    expect(requests.slice(before).filter(r=>r.element===standby)).toHaveLength(0)
    naturalEnd(old);await flush()
    expect(active()).toBe(standby)
    expect(store!.currentTrack.value?.id).toBe('b')
    expect(resolve.mock.calls.filter(([t])=>t.id==='b')).toHaveLength(1)
    expect(requests.slice(before).filter(r=>r.element===standby)).toHaveLength(1)
    expect(standby.duration).toBe(240)
  })

  it.each([
    { name: 'iPad desktop mode', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/27.2 Safari/605.1.15', platform: 'MacIntel', touchPoints: 5 },
    { name: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 Version/27.2 Mobile Safari/604.1', platform: 'iPhone', touchPoints: 5 },
  ])('never starts volume-zero foreground preroll on $name', async ({userAgent, platform, touchPoints}) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    Object.defineProperty(navigator, 'maxTouchPoints', {configurable:true, value:touchPoints})
    const {old,standby}=await setup()
    Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
    Object.defineProperty(document,'hidden',{configurable:true,value:false})
    document.dispatchEvent(new Event('visibilitychange'));await flush()
    const before=requests.length
    old.currentTime=239;old.dispatchEvent(new Event('timeupdate'));await flush()
    expect(store!.preparedNext.value?.armed).toBe(true)
    expect(standby.getAttribute('src')).toBe('https://media.invalid/b.mp3')
    expect(requests.slice(before).filter(r=>r.element===standby)).toHaveLength(0)
    expect(standby.paused).toBe(true)
    expect(store!.currentTrack.value?.id).toBe('a')
  })

  it('does not interpret a queued old pause as an interruption while the new source is playing',async()=>{
    const {old}=await setup();naturalEnd(old);await flush()
    const current=active();ready(current,0,false)
    current.dispatchEvent(new Event('pause'));await flush()
    expect(current.paused).toBe(false)
    expect(store!.status.value).not.toBe('paused')
  })
  it('does not reset src again through the render after the native request',async()=>{
    const {old,standby}=await setup()
    const propertyWrite=vi.spyOn(standby,'src','set')
    const attributeWrite=vi.spyOn(standby,'setAttribute')
    const loadCount=loads(standby)
    naturalEnd(old);await flush()
    expect(active()).toBe(standby)
    expect(standby.getAttribute('src')).toBe('https://media.invalid/b.mp3')
    expect(propertyWrite).not.toHaveBeenCalled()
    expect(attributeWrite.mock.calls.filter(([name])=>name==='src')).toHaveLength(0)
    expect(loads(standby)).toBe(loadCount)
    expect(standby.buffered.end(0)).toBe(240)
  })
  it('preserves normal native Pause after the prepared element request',async()=>{
    const {old,standby}=await setup();naturalEnd(old);await flush()
    const current=active();expect(current).toBe(standby)
    ready(current,1,false);current.dispatchEvent(new Event('playing'));current.dispatchEvent(new Event('timeupdate'));await flush()
    Object.defineProperty(current,'paused',{configurable:true,value:true});current.dispatchEvent(new Event('pause'));await flush()
    const count=requests.length;await vi.advanceTimersByTimeAsync(6000);await flush()
    expect(store!.status.value).toBe('paused');expect(requests).toHaveLength(count)
  })
  it('does not issue a duplicate post-render play after the synchronous request',async()=>{
    const {old}=await setup();naturalEnd(old);await flush()
    expect(requests.filter(r=>r.src==='https://media.invalid/b.mp3')).toHaveLength(1)
  })
  it('requests next play before the native ended listener returns',async()=>{
    const {old,resolve}=await setup();naturalEnd(old);await flush()
    const next=requests.find(r=>r.src==='https://media.invalid/b.mp3')
    expect(next,'next source must have reached native play').toBeDefined()
    expect(resolve.mock.calls.filter(([t])=>t.id==='b')).toHaveLength(1)
    expect(next!.inEndedCallback).toBe(true)
  })
  it('promotes the prepared element and retains the previous element until progress',async()=>{
    const {old,standby,resolve}=await setup();naturalEnd(old);await flush()
    expect(store!.currentTrack.value?.id).toBe('b')
    expect(resolve.mock.calls.filter(([t])=>t.id==='b')).toHaveLength(1)
    expect(active()).toBe(standby)
    expect(old.isConnected).toBe(true)
    expect(old.dataset.audioRole).toBe('retained')
    expect(old.getAttribute('src')).toBe('https://media.invalid/a.mp3')
    standby.currentTime=.5;standby.dispatchEvent(new Event('timeupdate'));await flush()
    expect(old.hasAttribute('src')).toBe(false)
    expect(old.isConnected).toBe(false)
  })
  it('does not start a silent standby while the page is hidden',async()=>{
    const {old,standby}=await setup();const before=requests.length
    old.currentTime=239;old.dispatchEvent(new Event('timeupdate'));await flush()
    expect(active()).toBe(old)
    expect(store!.currentTrack.value?.id).toBe('a')
    expect(requests.slice(before).filter(r=>r.element===standby)).toHaveLength(0)
  })
  it('reuses the prepared element and requests play synchronously at the repeat-all wrap',async()=>{
    const {old,standby,resolve}=await setup(2);const calls=resolve.mock.calls.length
    naturalEnd(old);await flush()
    expect(store!.currentTrack.value?.id).toBe('a');expect(active()).toBe(standby)
    expect(requests.find(r=>r.src==='https://media.invalid/a.mp3')?.inEndedCallback).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(calls)
  })

  it('uses the previous element once after real autoplay refusal, preserving prepared data until progress',async()=>{
    const {old,standby}=await setup()
    const starting=deferred(),fallback=deferred()
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(starting.promise).mockReturnValueOnce(fallback.promise)
    const loadCount=loads(standby)
    naturalEnd(old);await flush()
    expect(active()).toBe(standby)
    starting.reject(new DOMException('gesture required','NotAllowedError'));await flush()
    await vi.advanceTimersByTimeAsync(300);await flush()
    expect(active()).toBe(old)
    expect(old.getAttribute('src')).toBe('https://media.invalid/b.mp3')
    expect(standby.isConnected).toBe(true)
    expect(standby.getAttribute('src')).toBe('https://media.invalid/b.mp3')
    expect(loads(standby)).toBe(loadCount)
    ready(old,.5,false);fallback.resolve();old.dispatchEvent(new Event('playing'));old.dispatchEvent(new Event('timeupdate'));await flush()
    expect(standby.hasAttribute('src')).toBe(false)
    expect(standby.isConnected).toBe(false)
    expect(store!.status.value).toBe('playing')
  })

  it.each(['AbortError','timeout'])('does not use the old element as an autoplay fallback for %s',async(reason)=>{
    const {old,standby}=await setup()
    const starting=deferred();vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(starting.promise)
    const oldSource=vi.spyOn(old,'setAttribute')
    naturalEnd(old);await flush()
    if(reason==='AbortError')starting.reject(new DOMException('interrupted','AbortError'))
    await vi.advanceTimersByTimeAsync(12_000);await flush()
    expect(active()).toBe(standby)
    expect(oldSource.mock.calls.filter(([name,value])=>name==='src' && value==='https://media.invalid/b.mp3')).toHaveLength(0)
    expect(store!.currentTrack.value?.id).toBe('b')
    expect(store!.playbackNotices.value.filter(n=>n.kind==='tapToResume')).toHaveLength(1)
  })

  it('does not loop when both prepared and retained elements reject autoplay',async()=>{
    const {old,standby}=await setup()
    const played:HTMLMediaElement[]=[]
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function(this:HTMLMediaElement){
      played.push(this);return Promise.reject(new DOMException('gesture required','NotAllowedError'))
    })
    naturalEnd(old);await vi.advanceTimersByTimeAsync(30_000);await flush()
    expect(played).toEqual([standby,old])
    expect(store!.playbackNotices.value.filter(n=>n.kind==='tapToResume')).toHaveLength(1)
  })

  it.each(['pause','stop'] as const)('honours %s while a prepared play is pending, including late native success',async(command)=>{
    const {old,standby}=await setup()
    const starting=deferred();vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(starting.promise)
    naturalEnd(old);await flush()
    playbackCommands[command]();await flush()
    Object.defineProperty(standby,'paused',{configurable:true,value:false})
    starting.resolve();await flush()
    expect(standby.paused).toBe(true)
    expect(store!.playbackIntent.value).toBe('paused')
    await vi.advanceTimersByTimeAsync(12_000);await flush()
    expect(store!.playbackNotices.value.filter(n=>n.kind==='tapToResume')).toHaveLength(0)
  })

  it('ignores delayed old ended/pause/abort events after promotion',async()=>{
    const {old,standby}=await setup();naturalEnd(old);await flush()
    const generation=store!.playbackGeneration.value
    for(const name of ['ended','pause','abort'])old.dispatchEvent(new Event(name))
    await flush()
    expect(active()).toBe(standby)
    expect(store!.playbackGeneration.value).toBe(generation)
    expect(store!.currentTrack.value?.id).toBe('b')
    expect(store!.status.value).not.toBe('paused')
  })

  it('ignores an old ended event queued on the reloaded autoplay fallback element',async()=>{
    const {old,standby}=await setup()
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('gesture required','NotAllowedError'))
    naturalEnd(old);await vi.advanceTimersByTimeAsync(300);await flush()
    expect(active()).toBe(old)
    // A real src replacement resets ended before events from the old resource drain.
    ready(old,0,false)
    const generation=store!.playbackGeneration.value
    old.dispatchEvent(new Event('ended'));old.dispatchEvent(new Event('pause'));old.dispatchEvent(new Event('abort'));await flush()
    expect(active()).toBe(old)
    expect(store!.playbackGeneration.value).toBe(generation)
    expect(store!.currentTrack.value?.id).toBe('b')
    expect(standby.hasAttribute('src')).toBe(true)
  })

  it.each(['pause','stop'] as const)('cancels autoplay fallback if %s arrives during its store acknowledgement',async(command)=>{
    const {old,standby}=await setup()
    const gate=deferred()
    const recover=store!.recoverHandover
    vi.spyOn(store!,'recoverHandover').mockImplementation(async(step,generation)=>{
      const result=await recover(step,generation)
      if(step==='srcSwap')await gate.promise
      return result
    })
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('gesture required','NotAllowedError'))
    naturalEnd(old);await vi.advanceTimersByTimeAsync(300);await flush()
    playbackCommands[command]();gate.resolve();await flush()
    expect(store!.playbackIntent.value).toBe('paused')
    expect(old.getAttribute('src')).not.toBe('https://media.invalid/b.mp3')
    expect(standby.paused).toBe(true)
    expect(store!.playbackNotices.value.filter(n=>n.kind==='tapToResume')).toHaveLength(0)
  })

  it('keeps the newest command playing when an older play promise settles on that same element',async()=>{
    const {old,standby}=await setup()
    const starting=deferred();vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(starting.promise)
    naturalEnd(old);await flush()
    playbackCommands.pause();playbackCommands.play();await flush()
    expect(standby.paused).toBe(false)
    starting.resolve();await flush()
    expect(standby.paused).toBe(false)
    expect(store!.playbackIntent.value).toBe('playing')
  })

  it('keeps a valid native start playing after seeking the same promoted source', async () => {
    const {old,standby}=await setup()
    const starting=deferred();vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(starting.promise)
    naturalEnd(old);await flush()
    ready(standby,3,false)
    standby.dispatchEvent(new Event('seeking'));standby.dispatchEvent(new Event('seeked'));await flush()
    starting.resolve();await flush()
    expect(active()).toBe(standby)
    expect(standby.paused).toBe(false)
    expect(store!.playbackIntent.value).toBe('playing')
  })

  it('does not clear a preserved prepared buffer when a later preparation is armed during fallback',async()=>{
    const {old,standby}=await setup()
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('gesture required','NotAllowedError'))
    naturalEnd(old);await vi.advanceTimersByTimeAsync(300);await flush()
    await store!.armNextPreparation();await flush()
    expect(store!.preparedNext.value?.track.id).toBe('c')
    expect(standby.getAttribute('src')).toBe('https://media.invalid/b.mp3')
    ready(old,.5,false);old.dispatchEvent(new Event('timeupdate'));await flush()
    expect(wrapper!.get<HTMLAudioElement>('audio[data-audio-role="standby"]').element.getAttribute('src')).toBe('https://media.invalid/c.mp3')
  })

  it('cannot synchronously adopt a preparation with an insufficient ticket margin',async()=>{
    const {old,resolve}=await setup()
    vi.setSystemTime(Date.now()+95_000)
    naturalEnd(old)
    expect(requests.filter(r=>r.src==='https://media.invalid/b.mp3' && r.inEndedCallback)).toHaveLength(0)
    await flush()
    expect(resolve.mock.calls.filter(([t])=>t.id==='b')).toHaveLength(2)
    expect(playbackLog.snapshot().filter(e=>e.type==='queue.start').at(-1)?.reusedPreparation).toBe(false)
  })

  it('honours a native interruption even if the pending prepared play later fulfils',async()=>{
    const {old,standby}=await setup()
    const starting=deferred();vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(starting.promise)
    naturalEnd(old);await flush()
    standby.dispatchEvent(new Event('pause'));await flush()
    Object.defineProperty(standby,'paused',{configurable:true,value:false})
    starting.resolve();await flush()
    expect(standby.paused).toBe(true)
    expect(store!.status.value).toBe('paused')
  })

  it('cancels a pending fallback on store Pause even when store Play immediately follows',async()=>{
    const {old,standby}=await setup()
    const gate=deferred()
    const recover=store!.recoverHandover
    vi.spyOn(store!,'recoverHandover').mockImplementation(async(step,generation)=>{
      const result=await recover(step,generation)
      if(step==='srcSwap')await gate.promise
      return result
    })
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('gesture required','NotAllowedError'))
    naturalEnd(old);await vi.advanceTimersByTimeAsync(300);await flush()
    store!.pause();void store!.play();gate.resolve();await flush()
    expect(active()).toBe(standby)
    expect(old.hasAttribute('src')).toBe(false)
  })

  it('keeps the prepared buffer while the failed autoplay fallback renews the same track',async()=>{
    const {old,standby,resolve}=await setup()
    const fallback=deferred()
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new DOMException('gesture required','NotAllowedError')).mockReturnValueOnce(fallback.promise)
    naturalEnd(old);await vi.advanceTimersByTimeAsync(300);await flush()
    expect(active()).toBe(old)
    ready(old,0,true)
    const loadCount=loads(standby)
    resolve.mockResolvedValueOnce({kind:'audio',url:'https://media.invalid/b-renewed.mp3',mimeType:'audio/mpeg'})
    vi.setSystemTime(Date.now()+95_000)
    await vi.advanceTimersByTimeAsync(5_000);await flush()
    expect(store!.currentTrack.value?.id).toBe('b')
    expect(resolve.mock.calls.filter(([t])=>t.id==='b')).toHaveLength(2)
    expect(standby.getAttribute('src')).toBe('https://media.invalid/b.mp3')
    expect(loads(standby)).toBe(loadCount)
    expect(active().getAttribute('src')).toBe('https://media.invalid/b-renewed.mp3')
    const renewed=active();ready(renewed,.5,false);renewed.dispatchEvent(new Event('timeupdate'));await flush()
    expect(standby.hasAttribute('src')).toBe(false)
  })

  it('does not let a late rejection from a superseded handover affect a newer track',async()=>{
    const {old,standby}=await setup()
    const starting=deferred();vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(starting.promise)
    naturalEnd(old);await flush()
    await store!.playQueueIndex(2);await flush()
    const current=active(),generation=store!.playbackGeneration.value
    starting.reject(new DOMException('late gesture refusal','NotAllowedError'));await vi.advanceTimersByTimeAsync(300);await flush()
    expect(active()).toBe(current)
    expect(store!.playbackGeneration.value).toBe(generation)
    expect(store!.currentTrack.value?.id).toBe('c')
    expect(standby.isConnected).toBe(false)
  })

  it('performs consecutive prepared handovers without retained deck leaks',async()=>{
    let {old,standby}=await setup()
    for(const nextId of ['b','c']){
      const loadCount=loads(standby)
      naturalEnd(old);await flush()
      expect(active()).toBe(standby)
      expect(store!.currentTrack.value?.id).toBe(nextId)
      expect(loads(standby)).toBe(loadCount)
      ready(standby,1,false);standby.dispatchEvent(new Event('playing'));standby.dispatchEvent(new Event('timeupdate'));await flush()
      expect(wrapper!.findAll('audio[data-audio-role="retained"]')).toHaveLength(0)
      expect(old.hasAttribute('src')).toBe(false)
      expect(old.isConnected).toBe(false)
      if(nextId==='b'){
        old=standby;old.currentTime=230;old.dispatchEvent(new Event('timeupdate'));await store!.armNextPreparation();await flush()
        standby=wrapper!.get<HTMLAudioElement>('audio[data-audio-role="standby"]').element;ready(standby,0,true)
      }
    }
    expect(wrapper!.findAll('audio')).toHaveLength(1)
  })

  it('logs buffer, element identity and start duration without exposing source credentials',async()=>{
    const {old,standby}=await setup(0,'?token=private-media-credential')
    naturalEnd(old);await flush()
    standby.currentTime=.5;standby.dispatchEvent(new Event('timeupdate'));await flush()
    const promotion=playbackLog.snapshot().find(e=>e.type==='handover.promote')
    expect(promotion).toMatchObject({bufferedSeconds:240,reusedElement:true})
    expect(promotion?.src).toMatch(/^https:\/\/media.invalid#[0-9a-f]{8}$/)
    expect(playbackLog.exportJson()).not.toContain('private-media-credential')
    expect(playbackLog.snapshot().some(e=>e.type==='preparation.playback-start' && typeof e.latencyMs==='number')).toBe(true)
  })

})
