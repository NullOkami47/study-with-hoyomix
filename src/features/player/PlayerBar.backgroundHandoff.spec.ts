// Regression coverage for prepared background handoff. The mounted PlayerBar/store
// are real; native media methods are controlled for event ordering. This is not
// physical-device or OS background-policy acceptance.
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { ProviderRegistry } from './providers/registry'
import { createPlaybackStore, type PlaybackStore } from './store'

let wrapper: VueWrapper | undefined
let store: PlaybackStore | undefined
let inEndedCallback = false
const requests: Array<{ element: HTMLMediaElement; src: string | null; inEndedCallback: boolean }> = []
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0) }
const track = (id: string): Track => ({ id, title:id, aliases:{}, games:['genshin'], relationIds:[], tabs:['focus'], workGroupId:'wg', vocalStatus:'instrumental', needsClassification:false, sources:[{provider:'lx',externalId:'wy:'+id+':320k'}] }) as Track
const active = () => wrapper!.get<HTMLAudioElement>('audio[data-audio-role="active"]').element
function ready(audio: HTMLAudioElement, time: number, paused: boolean) {
  Object.defineProperties(audio, {
    duration:{configurable:true,value:240},readyState:{configurable:true,value:4},
    paused:{configurable:true,value:paused},ended:{configurable:true,value:false},seeking:{configurable:true,value:false},
    buffered:{configurable:true,value:{length:1,start:()=>0,end:()=>240}},
    seekable:{configurable:true,value:{length:1,start:()=>0,end:()=>240}},
  })
  audio.currentTime=time
}
async function setup(startIndex=0) {
  const resolve=vi.fn(async(t:Track)=>({kind:'audio' as const,url:'https://media.invalid/'+t.id+'.mp3',mimeType:'audio/mpeg'}))
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
  vi.useFakeTimers();requests.length=0;inEndedCallback=false
  vi.spyOn(HTMLMediaElement.prototype,'play').mockImplementation(function(this:HTMLMediaElement){
    requests.push({element:this,src:this.getAttribute('src'),inEndedCallback})
    Object.defineProperty(this,'paused',{configurable:true,value:false});this.dispatchEvent(new Event('play'));return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(function(this:HTMLMediaElement){Object.defineProperty(this,'paused',{configurable:true,value:true})})
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{})
})
afterEach(()=>{wrapper?.unmount();store?.dispose();wrapper=undefined;store=undefined;Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(document,'hidden');Reflect.deleteProperty(navigator,'maxTouchPoints');vi.restoreAllMocks();vi.useRealTimers()})

describe('prepared background native handoff',()=>{
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
    const {old}=await setup()
    const propertyWrite=vi.spyOn(old,'src','set')
    naturalEnd(old);await flush()
    expect(active()).toBe(old)
    expect(old.getAttribute('src')).toBe('https://media.invalid/b.mp3')
    expect(propertyWrite).not.toHaveBeenCalled()
  })
  it('preserves normal native Pause after the same-element request',async()=>{
    const {old}=await setup();naturalEnd(old);await flush()
    const current=active();expect(current).toBe(old)
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
  it('retains the active HTMLAudioElement across prepared background handoff',async()=>{
    const {old,resolve}=await setup();naturalEnd(old);await flush()
    expect(store!.currentTrack.value?.id).toBe('b')
    expect(resolve.mock.calls.filter(([t])=>t.id==='b')).toHaveLength(1)
    expect(active()===old).toBe(true)
  })
  it('does not start a silent standby while the page is hidden',async()=>{
    const {old,standby}=await setup();const before=requests.length
    old.currentTime=239;old.dispatchEvent(new Event('timeupdate'));await flush()
    expect(active()).toBe(old)
    expect(store!.currentTrack.value?.id).toBe('a')
    expect(requests.slice(before).filter(r=>r.element===standby)).toHaveLength(0)
  })
  it('reuses the active element and requests play synchronously at the repeat-all wrap',async()=>{
    const {old,resolve}=await setup(2);const calls=resolve.mock.calls.length
    naturalEnd(old);await flush()
    expect(store!.currentTrack.value?.id).toBe('a');expect(active()).toBe(old)
    expect(requests.find(r=>r.src==='https://media.invalid/a.mp3')?.inEndedCallback).toBe(true)
    expect(resolve).toHaveBeenCalledTimes(calls)
  })

})
