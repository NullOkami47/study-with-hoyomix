import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import PlayerBar from './PlayerBar.vue'
import { ProviderRegistry } from './providers/registry'
import { createPlaybackStore, type PlaybackStore } from './store'

let wrapper: VueWrapper
let store: PlaybackStore
const flush = async () => { for (let i=0;i<50;i++) await Promise.resolve(); await vi.advanceTimersByTimeAsync(0) }
const active = () => wrapper.get<HTMLAudioElement>('[data-audio-role="active"]').element
const track = (id: string) => ({ id, title:id, aliases:{}, games:['genshin'], relationIds:[], tabs:['focus'], workGroupId:'wg', vocalStatus:'instrumental', needsClassification:false, sources:[{provider:'lx',externalId:'wy:'+id+':320k'}]} as Track)
function media(element: HTMLAudioElement, position: number, bufferedEnd = 240) {
 Object.defineProperties(element, {
  paused:{configurable:true,value:false}, ended:{configurable:true,value:false}, duration:{configurable:true,value:240},
  readyState:{configurable:true,value:HTMLMediaElement.HAVE_FUTURE_DATA}, seeking:{configurable:true,value:false},
  buffered:{configurable:true,value:{length:1,start:()=>0,end:()=>bufferedEnd}},
  seekable:{configurable:true,value:{length:1,start:()=>0,end:()=>240}},
 })
 element.currentTime=position
}
async function setup() {
 const lx={id:'lx',canResolve:()=>true,resolve:vi.fn(async(t:Track)=>({kind:'audio' as const,url:'https://media.invalid/'+t.id+'.mp3',mimeType:'audio/mpeg'}))}
 store=createPlaybackStore({registry:new ProviderRegistry([{provider:lx,enabled:true,priority:1,timeoutMs:1000}]),storage:{getItem:k=>k==='hoyomix-player-shuffle-v1'?'false':null,setItem:()=>{}}})
 store.enqueue(track('a'));store.enqueue(track('b'));store.enqueue(track('c'))
 wrapper=mount(PlayerBar,{props:{store},attachTo:document.body})
 await store.playQueueIndex(0);await flush()
 const old=active();media(old,230);old.dispatchEvent(new Event('playing'));old.dispatchEvent(new Event('timeupdate'));await flush()
 store.setPreloadPolicy('auto');await store.armNextPreparation();await flush()
 const standby=wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element
 media(standby,0);Object.defineProperty(standby,'paused',{configurable:true,value:true});standby.dispatchEvent(new Event('canplay'));await flush()
 return {old,standby,lx}
}
function nearEnd(old: HTMLAudioElement) {old.currentTime=239;old.dispatchEvent(new Event('timeupdate'))}
beforeEach(()=>{
 vi.useFakeTimers()
 vi.spyOn(HTMLMediaElement.prototype,'play').mockImplementation(function(this:HTMLMediaElement){Object.defineProperty(this,'paused',{configurable:true,value:false});this.dispatchEvent(new Event('play'));return Promise.resolve()})
 vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(function(this:HTMLMediaElement){Object.defineProperty(this,'paused',{configurable:true,value:true})})
 vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{})
})
afterEach(()=>{wrapper?.unmount();store?.dispose();vi.restoreAllMocks();vi.useRealTimers()})

describe('prepared native audio warms silently before natural track end',()=>{
 it('starts silent preroll with an unmuted zero-volume native request',async()=>{
  const {old,standby}=await setup()
  const requests:Array<{muted:boolean;volume:number}>=[]
  standby.addEventListener('play',()=>requests.push({muted:standby.muted,volume:standby.volume}))
  nearEnd(old);await flush()
  expect(requests).toEqual([{muted:false,volume:0}])
  expect(standby.muted).toBe(false);expect(standby.volume).toBe(0)
  expect(old.volume).toBe(store.volume.value)
 })
 it('keeps preroll and its promoted rewind silent across listener volume changes',async()=>{
  const {old,standby}=await setup();nearEnd(old);await flush()
  store.setVolume(.3);await flush()
  expect(standby.volume).toBe(0);expect(old.volume).toBe(.3)
  standby.currentTime=.8;Object.defineProperty(standby,'seeking',{configurable:true,value:true})
  old.currentTime=240;Object.defineProperty(old,'ended',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));old.dispatchEvent(new Event('ended'));await flush()
  expect(active()).toBe(standby);expect(standby.currentTime).toBe(0)
  expect(standby.muted).toBe(false);expect(standby.volume).toBe(0)
  store.setVolume(.6);await flush();expect(standby.volume).toBe(0)
  Object.defineProperty(standby,'seeking',{configurable:true,value:false});standby.dispatchEvent(new Event('seeked'));await flush()
  expect(standby.volume).toBe(.6);expect(standby.muted).toBe(false)
 })
 it('does not reset a ready source that is already at the start before silent playback',async()=>{
  const {old,standby}=await setup()
  const seek=vi.spyOn(standby,'currentTime','set')
  nearEnd(old);await flush()
  expect(standby.paused).toBe(false);expect(standby.muted).toBe(false);expect(standby.volume).toBe(0)
  expect(seek).not.toHaveBeenCalled()
 })

 it('updates the preload hint without replacing a fresh standby element or source',async()=>{
  const {standby}=await setup();const prepared=store.preparedNext.value;const src=standby.getAttribute('src')
  store.setPreloadPolicy('metadata');await flush()
  expect(wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element).toBe(standby)
  expect(standby.preload).toBe('metadata');expect(standby.getAttribute('src')).toBe(src)
  expect(store.preparedNext.value).toBe(prepared)
  store.setPreloadPolicy('auto');await flush();expect(standby.preload).toBe('auto')
  expect(wrapper.get<HTMLAudioElement>('[data-audio-role="standby"]').element).toBe(standby)
 })

 it('starts the prepared element silently in the final window without changing active track or position',async()=>{
  const {old,standby}=await setup();const generation=store.playbackGeneration.value
  expect(standby.paused).toBe(true)
  nearEnd(old);await flush()
  expect(standby.paused).toBe(false);expect(standby.muted).toBe(false);expect(standby.volume).toBe(0)
  standby.currentTime=.5;standby.dispatchEvent(new Event('playing'));standby.dispatchEvent(new Event('timeupdate'));await flush()
  expect(standby.paused).toBe(false);expect(active()).toBe(old)
  expect(store.currentTrack.value?.id).toBe('a');expect(store.playbackGeneration.value).toBe(generation)
 })
 it('restores volume immediately when a zero-position preroll is promoted',async()=>{
  const {old,standby}=await setup();nearEnd(old);await flush()
  expect(standby.volume).toBe(0)
  old.currentTime=240;Object.defineProperty(old,'ended',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));old.dispatchEvent(new Event('ended'));await flush()
  expect(active()).toBe(standby);expect(standby.currentTime).toBe(0);expect(standby.muted).toBe(false)
  expect(standby.volume).toBe(store.volume.value)
 })
 it('rewinds the warmed element before restoring volume at natural promotion',async()=>{
  const {old,standby}=await setup();nearEnd(old);await flush();standby.currentTime=.8
  Object.defineProperty(standby,'seeking',{configurable:true,value:true})
  old.currentTime=240;Object.defineProperty(old,'ended',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));old.dispatchEvent(new Event('ended'));await flush()
  expect(active()).toBe(standby);expect(standby.currentTime).toBe(0);expect(standby.muted).toBe(false);expect(standby.volume).toBe(0)
  Object.defineProperty(standby,'seeking',{configurable:true,value:false});standby.dispatchEvent(new Event('seeked'));await flush()
  expect(standby.muted).toBe(false);expect(standby.volume).toBe(store.volume.value);expect(store.currentTrack.value?.id).toBe('b')
 })
 it.each(['listener pause','native pause','seek','stop'] as const)('stops the silent player on %s',async(reason)=>{
  const {old,standby}=await setup();nearEnd(old);await flush();expect(standby.paused).toBe(false)
  if(reason==='listener pause')store.pause()
  else if(reason==='native pause'){Object.defineProperty(old,'paused',{configurable:true,value:true});old.dispatchEvent(new Event('pause'))}
  else if(reason==='seek'){old.currentTime=100;old.dispatchEvent(new Event('seeking'))}
  else store.stop()
  await flush();expect(standby.paused).toBe(true)
 })
 it('bounds silent playback if the outgoing track stalls before ended',async()=>{
  const {old,standby}=await setup();nearEnd(old);await flush();expect(standby.paused).toBe(false)
  standby.currentTime=1.1
  await vi.advanceTimersByTimeAsync(3001);await flush()
  expect(standby.paused).toBe(true);expect(standby.currentTime).toBe(0)
 })
 it('resets silent progress on cancellation so a later manual advance starts at zero',async()=>{
  const {old,standby}=await setup();nearEnd(old);await flush();standby.currentTime=.6
  store.pause();await flush();expect(standby.currentTime).toBe(0)
  await store.next();await flush();expect(active().currentTime).toBe(0)
 })
 it('does not treat its own delayed preroll pause as an interruption after manual Next',async()=>{
  const {old,standby}=await setup();nearEnd(old);await flush();standby.currentTime=.5
  vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(function(this:HTMLMediaElement){
   const wasPlaying=!this.paused;Object.defineProperty(this,'paused',{configurable:true,value:true})
   if(wasPlaying)setTimeout(()=>this.dispatchEvent(new Event('pause')),0)
  })
  vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(function(this:HTMLMediaElement){Object.defineProperty(this,'paused',{configurable:true,value:false});this.dispatchEvent(new Event('play'));return new Promise<void>(()=>{})})
  await wrapper.get('[data-player-next]').trigger('click');await flush();expect(active()).toBe(standby)
  expect(store.status.value).not.toBe('paused')
  const count=vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
  await vi.advanceTimersByTimeAsync(5001);await flush()
  expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBeGreaterThan(count)
 })
 it('still honours a real native pause after consuming the cancelled-preroll pause',async()=>{
  const {old,standby}=await setup();nearEnd(old);await flush()
  vi.mocked(HTMLMediaElement.prototype.pause).mockImplementation(function(this:HTMLMediaElement){
   const wasPlaying=!this.paused;Object.defineProperty(this,'paused',{configurable:true,value:true})
   if(wasPlaying)setTimeout(()=>this.dispatchEvent(new Event('pause')),0)
  })
  await wrapper.get('[data-player-next]').trigger('click');await flush();expect(active()).toBe(standby)
  Object.defineProperty(standby,'paused',{configurable:true,value:true});standby.dispatchEvent(new Event('pause'));await flush()
  const count=vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length
  await vi.advanceTimersByTimeAsync(5001);await flush()
  expect(store.status.value).toBe('paused');expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(count)
 })
 it('recognises a completed rewind after pause and explicit Play even if seeked was lost',async()=>{
  const {old,standby}=await setup();nearEnd(old);await flush();standby.currentTime=.8
  Object.defineProperty(standby,'seeking',{configurable:true,value:true})
  old.currentTime=240;Object.defineProperty(old,'ended',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));old.dispatchEvent(new Event('ended'));await flush()
  expect(active()).toBe(standby);expect(standby.muted).toBe(false);expect(standby.volume).toBe(0)
  Object.defineProperty(standby,'seeking',{configurable:true,value:false})
  Object.defineProperty(standby,'paused',{configurable:true,value:true});standby.dispatchEvent(new Event('pause'));await flush()
  await wrapper.get('[data-player-play]').trigger('click');await flush()
  standby.currentTime=1;standby.dispatchEvent(new Event('playing'));standby.dispatchEvent(new Event('timeupdate'));await flush()
  expect(standby.muted).toBe(false)
 })
 it('reaches the bounded resume notice when the resumed rewind remains stuck with a fresh ticket',async()=>{
  const {old,standby,lx}=await setup();nearEnd(old);await flush();standby.currentTime=.8
  Object.defineProperty(standby,'seeking',{configurable:true,value:true})
  old.currentTime=240;Object.defineProperty(old,'ended',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));old.dispatchEvent(new Event('ended'));await flush()
  Object.defineProperty(standby,'paused',{configurable:true,value:true});standby.dispatchEvent(new Event('pause'));await flush()
  await wrapper.get('[data-player-play]').trigger('click');await flush()
  const calls=lx.resolve.mock.calls.length
  await vi.advanceTimersByTimeAsync(6000);await flush()
  expect(lx.resolve.mock.calls.length).toBe(calls)
  expect(store.status.value).toBe('paused')
  expect(store.playbackNotices.value.some(notice=>notice.kind==='tapToResume')).toBe(true)
  expect(wrapper.find('[data-player-notice-resume]').exists()).toBe(true)
 })
 it('accepts a delayed seeked after native playback has moved beyond the first frame',async()=>{
  const {old,standby}=await setup();nearEnd(old);await flush();standby.currentTime=.8
  Object.defineProperty(standby,'seeking',{configurable:true,value:true})
  old.currentTime=240;Object.defineProperty(old,'ended',{configurable:true,value:true});old.dispatchEvent(new Event('pause'));old.dispatchEvent(new Event('ended'));await flush()
  Object.defineProperty(standby,'seeking',{configurable:true,value:false});standby.currentTime=.6
  standby.dispatchEvent(new Event('seeked'));await flush()
  expect(standby.muted).toBe(false)
 })
 it('does not start an unready or stale preparation',async()=>{
  const {old,standby}=await setup();Object.defineProperty(standby,'readyState',{configurable:true,value:0});nearEnd(old);await flush();expect(standby.paused).toBe(true)
  Object.defineProperty(standby,'readyState',{configurable:true,value:3});vi.setSystemTime(Date.now()+121000);old.dispatchEvent(new Event('timeupdate'));await flush();expect(standby.paused).toBe(true)
 })
 it('makes only one rejected warmup attempt for a preparation',async()=>{
  const {old,standby}=await setup()
  const play=vi.mocked(HTMLMediaElement.prototype.play);play.mockRejectedValue(new DOMException('Gesture required','NotAllowedError'))
  const count=play.mock.calls.length;nearEnd(old);await flush();old.dispatchEvent(new Event('timeupdate'));await flush()
  expect(play).toHaveBeenCalledTimes(count+1);expect(standby.paused).toBe(true);expect(store.status.value).toBe('playing')
 })
})
