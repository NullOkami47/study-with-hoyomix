import {mount, type VueWrapper} from '@vue/test-utils'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {watch} from 'vue'
import type {Track} from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import {ProviderRegistry} from './providers/registry'
import {createPlaybackStore, type PlaybackStore} from './store'

const track = (id: string) => ({id, title: id, aliases: {}, games: ['genshin'], relationIds: [], tabs: ['focus'], workGroupId: 'wg', vocalStatus: 'instrumental', needsClassification: false,
  sources: [{provider: 'lx', externalId: `wy:${id}:320k`}, {provider: 'gd-studio', externalId: `netease:${id}:320`}],
}) as Track
let wrapper: VueWrapper
let store: PlaybackStore
const flush = async () => {for(let i=0;i<40;i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0); for(let i=0;i<40;i++) await Promise.resolve()}
const active = () => wrapper.get<HTMLAudioElement>('audio[data-audio-role="active"]').element
const pauseCalls = (element: HTMLAudioElement) => vi.mocked(HTMLMediaElement.prototype.pause).mock.contexts.filter(x=>x===element).length
function mediaAt(element: HTMLAudioElement, time: number, paused = false) {
  Object.defineProperties(element, {
    paused: {configurable: true, value: paused},
    duration: {configurable: true, value: 460},
    readyState: {configurable: true, value: HTMLMediaElement.HAVE_FUTURE_DATA},
    seekable: {configurable: true, value: {length: 1, start:()=>0, end:()=>460}},
  })
  element.currentTime=time
  element.dispatchEvent(new Event('loadedmetadata'))
  element.dispatchEvent(new Event('timeupdate'))
}
async function setup() {
  let call=0
  const lx={id:'lx',canResolve:()=>true,resolve:vi.fn(async()=>({kind:'audio' as const,url:`https://media.invalid/lx-${++call}.mp3`,mimeType:'audio/mpeg'}))}
  const gd={id:'gd-studio',canResolve:()=>true,resolve:vi.fn(async()=>({kind:'audio' as const,url:'https://media.invalid/gd.mp3',mimeType:'audio/mpeg'}))}
  store=createPlaybackStore({registry:new ProviderRegistry([{provider:lx,enabled:true,priority:1,timeoutMs:1000},{provider:gd,enabled:true,priority:2,timeoutMs:1000}]),storage:{getItem:k=>k==='hoyomix-player-shuffle-v1'?'false':null,setItem:()=>{}}})
  store.enqueue(track('a'));store.enqueue(track('b'))
  wrapper=mount(PlayerBar,{props:{store},attachTo:document.body})
  await store.playQueueIndex(0);await flush()
  const old=active();mediaAt(old,339);old.dispatchEvent(new Event('playing'));await flush()
  return {old,lx,gd}
}
async function renew() {expect(await store.renewMedia('lx',store.playbackGeneration.value)).toBe(true);await flush();return active()}
beforeEach(()=>{
 vi.useFakeTimers()
 vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue()
 vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{})
 vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{})
})
afterEach(()=>{wrapper?.unmount();store?.dispose();vi.restoreAllMocks();vi.useRealTimers()})

describe('same-track recovery keeps native audio continuity',()=>{
 it.each(['pause-before-resolve','pause-after-resolve'] as const)('retains a network-failed source through its error-induced pause (%s)',async(order)=>{
  const {old,lx}=await setup();const original=old.getAttribute('src');const pauses=pauseCalls(old)
  let resolve!:(value:{kind:'audio';url:string;mimeType:string})=>void
  lx.resolve.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
  Object.defineProperty(old,'error',{configurable:true,value:{code:2}})
  old.dispatchEvent(new Event('error'));await flush()
  if(order==='pause-before-resolve'){
   Object.defineProperty(old,'paused',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));await flush()
  }
  resolve({kind:'audio',url:'https://media.invalid/network-replacement.mp3',mimeType:'audio/mpeg'});await flush()
  if(order==='pause-after-resolve'){
   Object.defineProperty(old,'paused',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));await flush()
  }
  expect(active()).not.toBe(old)
  expect(old.getAttribute('src')).toBe(original)
  expect(pauseCalls(old)).toBe(pauses)
  expect(store.status.value).not.toBe('paused')
  const replacement=active();mediaAt(replacement,339,true);replacement.dispatchEvent(new Event('playing'));await flush()
  expect(old.getAttribute('src')).toBeNull()
  expect(store.pendingResumePosition.value).toBeUndefined()
 })

 it('still honours an explicit listener pause after the network-error pause',async()=>{
  const {old,lx}=await setup();const generation=store.playbackGeneration.value
  let resolve!:(value:{kind:'audio';url:string;mimeType:string})=>void
  lx.resolve.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
  Object.defineProperty(old,'error',{configurable:true,value:{code:2}});old.dispatchEvent(new Event('error'));await flush()
  Object.defineProperty(old,'paused',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));await flush()
  await wrapper.get('[data-player-play]').trigger('click');await flush()
  resolve({kind:'audio',url:'https://media.invalid/late-network.mp3',mimeType:'audio/mpeg'});await flush()
  expect(store.playbackIntent.value).toBe('paused')
  expect(store.playbackGeneration.value).toBe(generation)
  expect(old.getAttribute('src')).not.toBe('https://media.invalid/late-network.mp3')
 })

 it.each(['pending','rejected'] as const)('lets an explicit listener Play resume a cancelled renewal when native play is %s',async(nativePlay)=>{
  const {old,lx,gd}=await setup()
  let resolve!:(value:{kind:'audio';url:string;mimeType:string})=>void
  lx.resolve.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
  Object.defineProperty(old,'error',{configurable:true,value:{code:2}});old.dispatchEvent(new Event('error'));await flush()
  Object.defineProperty(old,'paused',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));await flush()
  old.dispatchEvent(new Event('pause'));await flush()
  expect(store.status.value).toBe('paused')
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function(this:HTMLMediaElement){
   if(this!==old)return Promise.resolve()
   Object.defineProperty(old,'paused',{configurable:true,value:false})
   Object.defineProperty(old,'readyState',{configurable:true,value:HTMLMediaElement.HAVE_CURRENT_DATA})
   old.dispatchEvent(new Event('play'))
   return nativePlay==='pending'?new Promise<void>(()=>{}):Promise.reject(new DOMException('Failed source','NotSupportedError'))
  })
  await wrapper.get('[data-player-play]').trigger('click');await flush()
  resolve({kind:'audio',url:'https://media.invalid/listener-renewal.mp3',mimeType:'audio/mpeg'});await flush()
  expect(store.playable.value).toEqual({kind:'audio',url:'https://media.invalid/listener-renewal.mp3',mimeType:'audio/mpeg'})
  expect(gd.resolve).not.toHaveBeenCalled()
  expect(store.playbackIntent.value).toBe('playing')
 })

 it('cancels an in-flight renewal on a second native pause after a network failure',async()=>{
  const {old,lx}=await setup();const generation=store.playbackGeneration.value
  let resolve!:(value:{kind:'audio';url:string;mimeType:string})=>void
  lx.resolve.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
  Object.defineProperty(old,'error',{configurable:true,value:{code:2}});old.dispatchEvent(new Event('error'));await flush()
  Object.defineProperty(old,'paused',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));await flush()
  old.dispatchEvent(new Event('pause'));await flush()
  const playCount=vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
  resolve({kind:'audio',url:'https://media.invalid/cancelled-network.mp3',mimeType:'audio/mpeg'});await flush()
  expect(store.playbackGeneration.value).toBe(generation)
  expect(store.status.value).toBe('paused')
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCount)
 })

 it('ignores a duplicate of the known network error after its cancelled renewal settles',async()=>{
  const {old,lx,gd}=await setup();const generation=store.playbackGeneration.value
  let resolve!:(value:{kind:'audio';url:string;mimeType:string})=>void
  lx.resolve.mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
  Object.defineProperty(old,'error',{configurable:true,value:{code:2}});old.dispatchEvent(new Event('error'));await flush()
  Object.defineProperty(old,'paused',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));await flush()
  old.dispatchEvent(new Event('pause'));await flush()
  resolve({kind:'audio',url:'https://media.invalid/cancelled-late.mp3',mimeType:'audio/mpeg'});await flush()
  old.dispatchEvent(new Event('error'));await flush()
  expect(gd.resolve).not.toHaveBeenCalled()
  expect(store.playbackGeneration.value).toBe(generation)
  expect(store.status.value).toBe('paused')
 })

 it('clears the failed source on a listener pause while the replacement is still loading',async()=>{
  const {old}=await setup()
  Object.defineProperty(old,'error',{configurable:true,value:{code:2}});old.dispatchEvent(new Event('error'));await flush()
  Object.defineProperty(old,'paused',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));await flush()
  expect(old.getAttribute('src')).not.toBeNull()
  await wrapper.get('[data-player-play]').trigger('click');await flush()
  expect(old.getAttribute('src')).toBeNull()
  expect(store.playbackIntent.value).toBe('paused')
 })

 it('does not reinterpret an earlier native pause as network-error continuity',async()=>{
  const {old}=await setup()
  Object.defineProperty(old,'paused',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));await flush()
  Object.defineProperty(old,'error',{configurable:true,value:{code:2}});old.dispatchEvent(new Event('error'));await flush()
  expect(old.getAttribute('src')).toBeNull()
 })

 it('keeps the outgoing source alive and audible until the replacement at the saved position starts',async()=>{
  const {old}=await setup();const original=old.getAttribute('src');const pauses=pauseCalls(old);const session=store.listeningSessionId.value
  const replacement=await renew()
  expect(replacement).not.toBe(old)
  expect(old.isConnected).toBe(true)
  expect(old.getAttribute('src')).toBe(original)
  expect(pauseCalls(old)).toBe(pauses)
  expect(old.muted).toBe(false)
  expect(replacement.preload).toBe('auto')
  expect(store.pendingResumePosition.value).toBe(339)
  mediaAt(replacement,339,true);await flush()
  expect(old.getAttribute('src')).toBe(original)
  replacement.dispatchEvent(new Event('playing'));await flush()
  expect(old.getAttribute('src')).toBeNull()
  expect(pauseCalls(old)).toBe(pauses+1)
  expect(store.currentTrack.value?.id).toBe('a')
  expect(store.listeningSessionId.value).toBe(session)
 })

 it.each(['listener pause','native pause','stop','next'] as const)('releases both native sources on %s during recovery',async(action)=>{
  const {old}=await setup();const replacement=await renew()
  expect(old.getAttribute('src')).not.toBeNull()
  if(action==='listener pause')await wrapper.get('[data-player-play]').trigger('click')
  else if(action==='native pause') {Object.defineProperty(old,'paused',{configurable:true,value:true});old.dispatchEvent(new Event('pause'))}
  else if(action==='stop')store.stop()
  else await store.next()
  await flush()
  expect(old.getAttribute('src')).toBeNull()
  if(action==='listener pause'||action==='native pause'){
   const plays=vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
   mediaAt(replacement,339,true);await flush()
   expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays)
   if(action==='native pause')expect(store.status.value).toBe('paused')
   else expect(store.playbackIntent.value).toBe('paused')
  }
 })

 it('keeps the original source through a failed replacement and frees it after provider fallback starts',async()=>{
  const {old,gd}=await setup();const original=old.getAttribute('src');const pauses=pauseCalls(old)
  const failed=await renew()
  expect(old.getAttribute('src')).toBe(original)
  Object.defineProperty(failed,'error',{configurable:true,value:{code:4}})
  failed.dispatchEvent(new Event('error'));await flush()
  expect(store.activeProviderId.value).toBe('gd-studio')
  expect(gd.resolve).toHaveBeenCalledTimes(1)
  expect(active()).not.toBe(old)
  expect(old.getAttribute('src')).toBe(original)
  expect(pauseCalls(old)).toBe(pauses)
  const fallback=active();mediaAt(fallback,339,true);fallback.dispatchEvent(new Event('playing'));await flush()
  expect(old.getAttribute('src')).toBeNull()
  expect(store.pendingResumePosition.value).toBeUndefined()
 })

 it('does not let next-track preparation overwrite the retained source',async()=>{
  const {old}=await setup();const original=old.getAttribute('src')
  await renew();await store.armNextPreparation();await flush()
  expect(old.getAttribute('src')).toBe(original)
  expect(active().dataset.trackId).toBe('a')
 })

 it('continues to synchronise mute and volume on the outgoing native element',async()=>{
  const {old}=await setup();await renew()
  expect(old.getAttribute('src')).not.toBeNull()
  store.setVolume(0);await flush();expect(old.volume).toBe(0)
  store.setVolume(.3);await flush();expect(old.volume).toBe(.3)
 })

 it('publishes no previous playable under the replacement generation while retaining its DOM source',async()=>{
  const {old}=await setup();const previous=store.playable.value;const leaked:number[]=[]
  const stop=watch(store.playbackGeneration,g=>{if(store.playable.value===previous)leaked.push(g)},{flush:'sync'})
  try{await renew();expect(leaked).toEqual([]);expect(old.getAttribute('src')).not.toBeNull()}finally{stop()}
 })
 it('releases the outgoing source at the loading bound even while replacement recovery is pending',async()=>{
  const {old}=await setup();await renew()
  expect(old.getAttribute('src')).not.toBeNull()
  await vi.advanceTimersByTimeAsync(20_001);await flush()
  expect(old.getAttribute('src')).toBeNull()
 })

 it('cleans up the retained source on unmount without a late playback attempt',async()=>{
  const {old}=await setup();await renew();expect(old.getAttribute('src')).not.toBeNull()
  wrapper.unmount();const plays=vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
  await vi.advanceTimersByTimeAsync(30_000)
  expect(old.getAttribute('src')).toBeNull()
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(plays)
 })

 it.each([false,true])('restores an already armed next-track deck after the replacement starts (outgoing ended=%s)',async(outgoingEnded)=>{
  const {old}=await setup();const replacement=await renew()
  store.setPreloadPolicy('auto');await store.armNextPreparation();await flush()
  const prepared=store.preparedNext.value
  expect(prepared?.track.id).toBe('b')
  expect(old.getAttribute('src')).not.toBeNull()
  if(outgoingEnded){Object.defineProperty(old,'ended',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));old.dispatchEvent(new Event('ended'));await flush()}
  mediaAt(replacement,339,true);replacement.dispatchEvent(new Event('playing'));await flush()
  expect(store.preparedNext.value).toBe(prepared)
  const standby=wrapper.get<HTMLAudioElement>('audio[data-audio-role="standby"]').element
  expect(standby.getAttribute('src')).toBe(prepared?.playable.url)
  expect(standby.muted).toBe(true)
  await store.next();await flush()
  expect(active()).toBe(standby)
  expect(store.currentTrack.value?.id).toBe('b')
 })

 it('honours a native pause on the incoming element while its play request is pending',async()=>{
  const {old}=await setup();const replacement=await renew()
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(()=>new Promise<void>(()=>{}))
  mediaAt(replacement,339,true);await flush()
  const playCount=vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
  expect(old.getAttribute('src')).not.toBeNull()
  replacement.dispatchEvent(new Event('pause'));await flush()
  expect(old.getAttribute('src')).toBeNull()
  expect(store.status.value).toBe('paused')
  expect(store.playbackIntent.value).toBe('playing')
  replacement.dispatchEvent(new Event('canplay'));replacement.dispatchEvent(new Event('timeupdate'));await flush()
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(playCount)
 })

})
