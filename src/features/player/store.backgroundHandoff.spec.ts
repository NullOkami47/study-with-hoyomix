import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import { ProviderRegistry } from './providers/registry'
import { createPlaybackStore, type PlaybackStore } from './store'
const stores: PlaybackStore[]=[]
const tracks=['a','b','c'].map(id=>({id,title:id,aliases:{},games:[],relationIds:[],tabs:[],workGroupId:'test',vocalStatus:'instrumental',needsClassification:false,sources:[{provider:'lx',externalId:'wy:'+id+':320k'}]}) as Track)
async function setup(dynamic=false) {
  const resolve=vi.fn(async(t:Track)=>({kind:'audio' as const,url:'https://media.invalid/'+t.id+'.mp3',mimeType:'audio/mpeg'}))
  const provider={id:'lx',canResolve:()=>true,resolve}
  const registry=new ProviderRegistry([{provider,enabled:true,priority:1,timeoutMs:1000}])
  let current: ProviderRegistry|undefined=registry
  const loadRegistry=vi.fn(async()=>current??registry)
  const peekRegistry=vi.fn(()=>current)
  const store=createPlaybackStore({...(dynamic?{loadRegistry,peekRegistry}:{registry}),storage:{getItem:k=>k==='hoyomix-player-shuffle-v1'?'false':null,setItem:()=>{}}})
  stores.push(store);for(const t of tracks)store.enqueue(t)
  await store.playQueueIndex(0);store.setPreloadPolicy('auto');await store.armNextPreparation()
  expect(store.preparedNext.value?.track).toBe(tracks[1])
  return {store,resolve,loadRegistry,peekRegistry,registry,change:(r:ProviderRegistry|undefined)=>{current=r}}
}
beforeEach(()=>vi.useFakeTimers())
afterEach(()=>{for(const s of stores.splice(0))s.dispose();vi.useRealTimers()})
describe('prepared synchronous natural advance',()=>{
  it('adopts once with no new resolve or asynchronous registry load',async()=>{
    const s=await setup(true);const prepared=s.store.preparedNext.value!;const generation=s.store.playbackGeneration.value;const loads=s.loadRegistry.mock.calls.length;const resolves=s.resolve.mock.calls.length
    expect(s.store.tryAdvancePreparedAfterEnded(generation)).toBe(true)
    expect(s.store.currentTrack.value).toBe(tracks[1]);expect(s.store.playable.value).toBe(prepared.playable)
    expect(s.store.playbackGeneration.value).toBe(generation+1)
    expect(s.loadRegistry).toHaveBeenCalledTimes(loads);expect(s.resolve).toHaveBeenCalledTimes(resolves)
    expect(s.store.tryAdvancePreparedAfterEnded(generation)).toBe(false)
  })
  it('refuses missing or changed registry snapshots without moving the queue',async()=>{
    const s=await setup(true);const generation=s.store.playbackGeneration.value
    s.change(undefined);expect(s.store.tryAdvancePreparedAfterEnded(generation)).toBe(false)
    expect(s.store.currentTrack.value).toBe(tracks[0])
    s.change(new ProviderRegistry([]));expect(s.store.tryAdvancePreparedAfterEnded(generation)).toBe(false)
    expect(s.store.currentTrack.value).toBe(tracks[0])
  })
  it('refuses an expired prepared URL and leaves normal fresh resolution available',async()=>{
    const {store}=await setup();const generation=store.playbackGeneration.value
    vi.setSystemTime(Date.now()+121000)
    expect(store.tryAdvancePreparedAfterEnded(generation)).toBe(false)
    expect(store.currentTrack.value).toBe(tracks[0]);await store.next();expect(store.currentTrack.value).toBe(tracks[1])
  })
  it.each(['pause','stop'] as const)('cannot override explicit %s',async command=>{
    const {store}=await setup();const generation=store.playbackGeneration.value
    store[command]();expect(store.tryAdvancePreparedAfterEnded(generation)).toBe(false)
    expect(store.playbackIntent.value).toBe('paused')
  })
  it('does not bypass repeat-one playback or a cancelled preparation',async()=>{
    const {store}=await setup();const generation=store.playbackGeneration.value
    store.setRepeatMode('one');expect(store.tryAdvancePreparedAfterEnded(generation)).toBe(false)
    store.setRepeatMode('off');store.invalidatePreload();expect(store.tryAdvancePreparedAfterEnded(generation)).toBe(false)
  })
  it('cannot adopt a different upcoming queue item under an old preparation',async()=>{
    const {store}=await setup();const generation=store.playbackGeneration.value
    store.moveQueueItem(2,1);expect(store.tryAdvancePreparedAfterEnded(generation)).toBe(false)
    expect(store.currentTrack.value).toBe(tracks[0])
  })
  it('cannot override a listener queue selection waiting for registry validation',async()=>{
    const s=await setup(true);const generation=s.store.playbackGeneration.value
    let complete!:(registry:ProviderRegistry)=>void
    s.loadRegistry.mockImplementationOnce(()=>new Promise(r=>{complete=r}))
    const next=s.store.next()
    expect(s.store.tryAdvancePreparedAfterEnded(generation)).toBe(false)
    s.store.pause();complete(s.registry);await next
    expect(s.store.currentTrack.value).toBe(tracks[0]);expect(s.store.playbackIntent.value).toBe('paused')
  })

  it('prepares and synchronously adopts the first track after repeat-all reaches the queue tail',async()=>{
    const {store,resolve}=await setup();store.setRepeatMode('all');await store.playQueueIndex(2)
    await store.armNextPreparation()
    expect(store.preparedNext.value?.track).toBe(tracks[0])
    const generation=store.playbackGeneration.value,prepared=store.preparedNext.value!,calls=resolve.mock.calls.length
    expect(store.tryAdvancePreparedAfterEnded(generation)).toBe(true)
    expect(store.currentTrack.value).toBe(tracks[0]);expect(store.playable.value).toBe(prepared.playable)
    expect(resolve).toHaveBeenCalledTimes(calls)
  })
  it('discards a prepared wrap when repeat-all is turned off',async()=>{
    const {store}=await setup();store.setRepeatMode('all');await store.playQueueIndex(2);await store.armNextPreparation()
    expect(store.preparedNext.value?.track).toBe(tracks[0])
    const generation=store.playbackGeneration.value;store.setRepeatMode('off')
    expect(store.preparedNext.value).toBeNull();expect(store.tryAdvancePreparedAfterEnded(generation)).toBe(false)
    expect(store.currentTrack.value).toBe(tracks[2])
  })
  it('does not publish a late wrap preparation after repeat-all is turned off',async()=>{
    const {store,resolve}=await setup();store.setRepeatMode('all');await store.playQueueIndex(2)
    let complete!:(value:{kind:'audio';url:string;mimeType:string})=>void
    resolve.mockImplementationOnce(()=>new Promise(r=>{complete=r}))
    const preparing=store.armNextPreparation();for(let i=0;i<30;i++)await Promise.resolve()
    expect(complete).toBeTypeOf('function')
    store.setRepeatMode('off');complete({kind:'audio',url:'https://media.invalid/a.mp3',mimeType:'audio/mpeg'});await preparing
    expect(store.preparedNext.value).toBeNull();expect(store.currentTrack.value).toBe(tracks[2])
  })

})
