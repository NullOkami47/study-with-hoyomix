import { flushPromises } from '@vue/test-utils'
import { describe, it, expect, vi } from 'vitest'
import { createPlaybackStore } from './store'
import { ProviderRegistry } from './providers/registry'
import type { Track } from '../catalog/types'
import type { AudioProvider } from './providers/types'
const tracks = ['a','b'].map(id => ({id,title:id,games:[],sources:[{provider:'lx',externalId:id},{provider:'jellyfin',externalId:id}]} as unknown as Track))
const registration=(id:string,priority:number,enabled=true):any=>({enabled,priority,timeoutMs:1000,provider:{id,canResolve:()=>true,resolve:vi.fn(async()=>({kind:'audio' as const,url:'https://media.invalid/'+id,mimeType:'audio/mpeg'}))} satisfies AudioProvider})
const storage={getItem:(k:string)=>k.includes('shuffle')?'false':null,setItem:()=>{},removeItem:()=>{}}
describe('provider-aware preparation contract',()=>{
  it('does not touch a disabled Jellyfin binding while preparing the enabled next provider',async()=>{
    const jf=registration('jellyfin',1,false), lx=registration('lx',2)
    const store=createPlaybackStore({registry:new ProviderRegistry([jf,lx]),storage})
    store.reconcileUpcomingQueue(tracks); await store.playQueueIndex(0); store.setPreloadPolicy('auto'); await flushPromises()
    expect(jf.provider.resolve).not.toHaveBeenCalled()
    await store.armNextPreparation(); expect(store.preparedNext.value?.providerId).toBe('lx')
    await store.next(); expect(lx.provider.resolve).toHaveBeenCalledTimes(2); expect(jf.provider.resolve).not.toHaveBeenCalled(); store.dispose()
  })
  it('prepares and reuses the ordinary fallback chain after the priority provider fails',async()=>{
    const first=registration('lx',1); first.provider.resolve.mockResolvedValue(null)
    const second=registration('gd-studio',2)
    const store=createPlaybackStore({registry:new ProviderRegistry([first,second]),storage})
    store.reconcileUpcomingQueue(tracks); await store.playQueueIndex(0); store.setPreloadPolicy('auto')
    await store.armNextPreparation(); const prepared=store.preparedNext.value
    expect(prepared?.providerId).toBe('gd-studio')
    await store.next(); expect(store.preloadHandoff.value?.id).toBe(prepared?.id)
    expect(second.provider.resolve).toHaveBeenCalledTimes(2); store.dispose()
  })
  it('suppresses quota-consuming preparation on constrained networks and repeat-one',async()=>{
    const lx=registration('lx',1); const store=createPlaybackStore({registry:new ProviderRegistry([lx]),storage})
    store.reconcileUpcomingQueue(tracks); await store.playQueueIndex(0); store.setPreloadPolicy('metadata')
    await store.armNextPreparation(); expect(lx.provider.resolve).toHaveBeenCalledTimes(1)
    store.setPreloadPolicy('auto'); store.setRepeatMode('one'); await store.armNextPreparation()
    expect(lx.provider.resolve).toHaveBeenCalledTimes(1); store.dispose()
  })
  it('prepares the repeat-all wrap and preserves local transition preferences',async()=>{
    const lx=registration('lx',1); const store=createPlaybackStore({registry:new ProviderRegistry([lx]),storage})
    store.reconcileUpcomingQueue(tracks); await store.playQueueIndex(1); store.setRepeatMode('all'); store.setPreloadPolicy('auto')
    await store.armNextPreparation(); expect(store.preparedNext.value?.track.id).toBe('a')
    await store.advanceAfterEnded(); expect(lx.provider.resolve).toHaveBeenCalledTimes(2)
    expect(store.transitionMode.value).toBe('off'); store.setTransitionMode('smart'); store.setCrossfadeDuration(99)
    expect(store.crossfadeDuration.value).toBe(12); store.dispose()
  })
})


describe('pending preparation handoff', () => {
  it('awaits the in-flight next-track resolve once at natural handoff', async () => {
    let finish!: (value: {kind:'audio';url:string;mimeType:string}) => void
    const lx = registration('lx',1)
    lx.provider.resolve.mockImplementation((track: Track) => track.id === 'b'
      ? new Promise(resolve => {finish = resolve})
      : Promise.resolve({kind:'audio',url:'https://media.invalid/a',mimeType:'audio/mpeg'}))
    const store = createPlaybackStore({registry:new ProviderRegistry([lx]),storage})
    try {
      store.reconcileUpcomingQueue(tracks); await store.playQueueIndex(0); store.setPreloadPolicy('auto')
      const prepare = store.armNextPreparation(); await flushPromises()
      const next = store.next(); await flushPromises()
      expect(lx.provider.resolve).toHaveBeenCalledTimes(2)
      finish({kind:'audio',url:'https://media.invalid/b',mimeType:'audio/mpeg'})
      await Promise.all([prepare,next])
      expect(store.currentTrack.value?.id).toBe('b')
      expect(store.preloadHandoff.value).not.toBeNull()
      expect(lx.provider.resolve).toHaveBeenCalledTimes(2)
    } finally {store.dispose()}
  })
  it('does not apply an in-flight next after a newer queue choice', async () => {
    let finish!: (value: {kind:'audio';url:string;mimeType:string}) => void
    const lx = registration('lx',1)
    lx.provider.resolve.mockImplementation((track: Track) => track.id === 'b'
      ? new Promise(resolve => {finish = resolve})
      : Promise.resolve({kind:'audio',url:'https://media.invalid/'+track.id,mimeType:'audio/mpeg'}))
    const store = createPlaybackStore({registry:new ProviderRegistry([lx]),storage})
    try {
      store.reconcileUpcomingQueue([...tracks,{...tracks[0],id:'c'}]); await store.playQueueIndex(0); store.setPreloadPolicy('auto')
      const prepare = store.armNextPreparation(); await flushPromises(); const next = store.next()
      await store.playQueueIndex(2)
      finish({kind:'audio',url:'https://media.invalid/b',mimeType:'audio/mpeg'})
      await Promise.all([prepare,next])
      expect(store.currentTrack.value?.id).toBe('c')
    } finally {store.dispose()}
  })
})


it('a pause cancels queue advancement waiting on a slow preparation', async () => {
  let finish!: (value: {kind:'audio';url:string;mimeType:string}) => void
  const lx = registration('lx',1)
  lx.provider.resolve.mockImplementation((track: Track) => track.id === 'b'
    ? new Promise(resolve => {finish = resolve})
    : Promise.resolve({kind:'audio',url:'https://media.invalid/a',mimeType:'audio/mpeg'}))
  const store = createPlaybackStore({registry:new ProviderRegistry([lx]),storage})
  try {
    store.reconcileUpcomingQueue(tracks); await store.playQueueIndex(0); store.setPreloadPolicy('auto')
    const prepare = store.armNextPreparation(); await flushPromises()
    const next = store.next(); store.pause()
    finish({kind:'audio',url:'https://media.invalid/b',mimeType:'audio/mpeg'})
    await Promise.all([prepare,next])
    expect(store.currentTrack.value?.id).toBe('a')
    expect(store.playbackIntent.value).toBe('paused')
  } finally {store.dispose()}
})


it('an invalidated in-flight arm cannot restart itself after its abort settles', async () => {
  let finish!: (value: {kind:'audio';url:string;mimeType:string}) => void
  const lx = registration('lx', 1)
  lx.provider.resolve.mockImplementation((track: Track) => track.id === 'b'
    ? new Promise(resolve => {finish = resolve})
    : Promise.resolve({kind:'audio',url:'https://media.invalid/a',mimeType:'audio/mpeg'}))
  const store = createPlaybackStore({registry:new ProviderRegistry([lx]),storage})
  try {
    store.reconcileUpcomingQueue(tracks); await store.playQueueIndex(0); store.setPreloadPolicy('auto')
    const first = store.armNextPreparation(); await flushPromises()
    const second = store.armNextPreparation()
    store.invalidatePreload()
    finish({kind:'audio',url:'https://media.invalid/b',mimeType:'audio/mpeg'})
    await Promise.all([first,second])
    expect(lx.provider.resolve).toHaveBeenCalledTimes(2)
    expect(store.preparedNext.value).toBeNull()
  } finally {store.dispose()}
})


describe('reviewed preparation invalidation boundaries', () => {
  it('retains the same prepared track when repeat off changes to all away from the tail', async () => {
    const lx = registration('lx', 1)
    const store = createPlaybackStore({registry:new ProviderRegistry([lx]),storage})
    try {
      store.reconcileUpcomingQueue([...tracks, {...tracks[0],id:'c'}]); await store.playQueueIndex(0)
      store.setPreloadPolicy('auto'); await store.armNextPreparation()
      const id = store.preparedNext.value?.id
      store.setRepeatMode('all'); await store.armNextPreparation()
      expect(store.preparedNext.value?.id).toBe(id)
      expect(lx.provider.resolve).toHaveBeenCalledTimes(2)
      store.setRepeatMode('one'); expect(store.preparedNext.value).toBeNull()
    } finally {store.dispose()}
  })
  it('ignores empty, removed and invalid queue indices before touching playback', async () => {
    const store = createPlaybackStore({storage})
    try {
      for (const index of [0, -1, NaN, Infinity, .5]) await expect(store.playQueueIndex(index)).resolves.toBeUndefined()
      expect(store.currentIndex.value).toBe(-1)
      store.reconcileUpcomingQueue(tracks)
      store.removeQueueIndex(1)
      await expect(store.playQueueIndex(1)).resolves.toBeUndefined()
      expect(store.currentIndex.value).toBe(-1)
    } finally {store.dispose()}
  })
})
