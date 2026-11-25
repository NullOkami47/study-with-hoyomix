import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, watch } from 'vue'
import { useArtwork, clearArtworkCache } from './artwork'
import { sharedArtworkCache, type ArtworkLease } from './artworkCache'
import { artworkBlob, verifiedArtwork } from '../../test/artworkLeaseFixture'
import type { Track } from '../catalog/types'

const originalDecode=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'decode')
beforeEach(()=>Object.defineProperty(HTMLImageElement.prototype,'decode',{configurable:true,value:async()=>{}}))
afterEach(()=>{
  clearArtworkCache();vi.restoreAllMocks();vi.useRealTimers()
  if(originalDecode)Object.defineProperty(HTMLImageElement.prototype,'decode',originalDecode)
  else Reflect.deleteProperty(HTMLImageElement.prototype,'decode')
})
const track=ref<Track>({id:'a',title:'A',aliases:{},games:['hsr'],relationIds:[],tabs:['focus'],sources:[],
  workGroupId:'a',needsClassification:false,vocalStatus:'instrumental'})
function fixture(player=true,initialSource='/api/providers/lx/artwork/1'){
  const source=ref(initialSource),key=ref('a'),waiting=ref(false)
  let art!:ReturnType<typeof useArtwork>
  const component=defineComponent({setup(){
    art=useArtwork(key,track,{player,candidates:()=>source.value?[source.value]:[],waiting})
    return()=>h('span',{ref:art.element},art.artworkUrl.value?[h('img',{key:art.artworkUrl.value,src:art.artworkUrl.value,
      'data-artwork-identity':art.identity.value,onLoad:art.onLoad,onError:art.onError})]:[])
  }})
  return {wrapper:mount(component),source,key,waiting,get art(){return art}}
}
it('keeps the validated owner and source through waiting-only changes', async () => {
  const release = vi.fn(), source = '/api/providers/lx/artwork/1'
  const acquire = vi.spyOn(sharedArtworkCache, 'acquire').mockReturnValue({ ready: Promise.resolve(verifiedArtwork(source)), release })
  const f = fixture(true, source)
  try {
    await flushPromises(); const image = f.wrapper.get('img').element
    const sources: Array<string | undefined> = []
    const stop = watch(f.art.sourceUrl, value => sources.push(value), { flush: 'sync' })
    try {
      for (const waiting of [true, false]) {
        f.waiting.value = waiting; await flushPromises()
        expect(f.art.sourceUrl.value).toBe(source); expect(f.art.artworkUrl.value).toBe(artworkBlob(source))
        expect(f.wrapper.get('img').element).toBe(image)
      }
      expect(sources).toEqual([]); expect(acquire).toHaveBeenCalledOnce(); expect(release).not.toHaveBeenCalled()
    } finally { stop() }
  } finally { f.wrapper.unmount(); await flushPromises() }
  expect(release).toHaveBeenCalledOnce()
})
it('retains the outgoing owner through a no-candidate resolving gap and rejects obsolete events',async()=>{
  const releases=[vi.fn(),vi.fn()]
  let finish!: (v:{url:string;sourceUrl:string;shared:boolean})=>void
  const acquire=vi.spyOn(sharedArtworkCache,'acquire').mockReturnValueOnce({
    ready:Promise.resolve(verifiedArtwork('/api/providers/lx/artwork/1')),release:releases[0],
  }).mockReturnValueOnce({ready:new Promise(r=>{finish=r}),release:releases[1]})
  const f=fixture();await flushPromises();const old=f.wrapper.get('img')
  f.waiting.value=true;f.key.value='b';f.source.value='';await flushPromises()
  expect(f.wrapper.get('img').element).toBe(old.element)
  expect(f.art.sourceUrl.value).toBeUndefined();expect(releases[0]).not.toHaveBeenCalled()
  f.source.value='/api/providers/lx/artwork/2';await flushPromises()
  expect(releases[0]).not.toHaveBeenCalled()
  finish(verifiedArtwork(f.source.value));await flushPromises()
  expect(releases[0]).toHaveBeenCalledOnce()
  const image=f.wrapper.get('img').element
  old.element.dispatchEvent(new Event('error'));await flushPromises()
  expect(f.wrapper.get('img').element).toBe(image);expect(acquire).toHaveBeenCalledTimes(2)
  f.wrapper.unmount();await flushPromises();expect(releases[1]).toHaveBeenCalledOnce()
})
it.each(['empty-gap','pending-replacement'])('keeps permitted outgoing pixels across a track-aware %s',async mode=>{
  const oldUrl='/api/providers/lx/artwork/1',newUrl='/api/providers/lx/artwork/2'
  const oldRelease=vi.fn(),newRelease=vi.fn()
  let finish!:(value:{url:string;sourceUrl:string;shared:boolean})=>void
  vi.spyOn(sharedArtworkCache,'acquire').mockReturnValueOnce({
    ready:Promise.resolve(verifiedArtwork(oldUrl)),release:oldRelease,
  }).mockReturnValueOnce({ready:new Promise(resolve=>{finish=resolve}),release:newRelease})
  const key=ref('a'),candidate=ref(oldUrl),waiting=ref(false),allowed=ref(true)
  let art!:ReturnType<typeof useArtwork>
  const wrapper=mount(defineComponent({setup(){
    art=useArtwork(key,()=>({...track.value,id:key.value}),{player:true,candidates:()=>candidate.value?[candidate.value]:[],waiting,
      retainedSource:()=>key.value==='a'&&allowed.value?oldUrl:undefined,
      retainedDisplaySource:()=>allowed.value?oldUrl:undefined,
    })
    return()=>h('span',art.artworkUrl.value?h('img',{src:art.artworkUrl.value}):[])
  }}))
  try {
    await flushPromises()
    const image=wrapper.get('img').element
    key.value='b';waiting.value=true;candidate.value=mode==='empty-gap'?'':newUrl
    await flushPromises()
    expect(wrapper.get('img').element).toBe(image)
    expect(art.sourceUrl.value).toBeUndefined()
    expect(oldRelease).not.toHaveBeenCalled()
    if(mode==='empty-gap'){candidate.value=newUrl;await flushPromises()}
    expect(oldRelease).not.toHaveBeenCalled()
    finish(verifiedArtwork(newUrl));await flushPromises()
    expect(art.sourceUrl.value).toBe(newUrl)
    expect(oldRelease).toHaveBeenCalledOnce()
  } finally {wrapper.unmount();await flushPromises()}
  expect(newRelease).toHaveBeenCalledOnce()
})
it('does not acquire offscreen Library images until visible and keeps concurrency in the shared owner',async()=>{
  let visible!:()=>void
  const disconnect=vi.fn()
  vi.stubGlobal('IntersectionObserver',class{constructor(fn:(v:{isIntersecting:boolean}[])=>void){visible=()=>fn([{isIntersecting:true}])}
    observe=vi.fn();disconnect=disconnect})
  const acquire=vi.spyOn(sharedArtworkCache,'acquire').mockReturnValue({
    ready:Promise.resolve(verifiedArtwork('/api/providers/lx/artwork/1')),release:vi.fn(),
  })
  const f=fixture(false);expect(acquire).not.toHaveBeenCalled();visible();await flushPromises()
  expect(acquire).toHaveBeenCalledOnce();expect(acquire).toHaveBeenCalledWith(f.source.value,{pin:false})
  expect(f.art.isLoaded.value).toBe(true);f.wrapper.unmount();vi.unstubAllGlobals()
})
it('rejects signed and external candidates without native display', async () => {
  const acquire = vi.spyOn(sharedArtworkCache, 'acquire').mockReturnValue({ ready: Promise.resolve(null), release: vi.fn() })
  const fetcher = vi.spyOn(globalThis, 'fetch')
  const f = fixture()
  await flushPromises()
  const calls = acquire.mock.calls.length
  try {
    for (const url of ['/api/providers/chksz/artwork?url=' + encodeURIComponent('https://p1.music.126.net/a.jpg?signature=secret'),
      'https://evil.invalid/cover.png']) {
      f.source.value = url; await flushPromises()
      expect(f.wrapper.find('img').exists()).toBe(false)
      expect(f.art.hasFailed.value).toBe(true); expect(f.art.sourceUrl.value).toBeUndefined()
      track.value = { ...track.value }; await flushPromises()
      expect(f.wrapper.find('img').exists()).toBe(false)
    }
    expect(acquire).toHaveBeenCalledTimes(calls); expect(fetcher).not.toHaveBeenCalled()
  } finally { f.wrapper.unmount(); await flushPromises() }
})
it('normalises a legacy NetEase binding and displays only its validated Blob', async () => {
  const canonical = '/api/providers/gd-studio/artwork/111', release = vi.fn()
  const acquire = vi.spyOn(sharedArtworkCache, 'acquire').mockReturnValue({ ready: Promise.resolve(verifiedArtwork(canonical)), release })
  const f = fixture(true, '/api/providers/gd-studio/artwork/netease%3A111%3A320')
  try {
    await flushPromises()
    expect(acquire).toHaveBeenCalledExactlyOnceWith(canonical, { pin: true })
    expect(f.art.sourceUrl.value).toBe(canonical)
    expect(f.wrapper.get('img').attributes('src')).toBe(artworkBlob(canonical))
    expect(f.art.isLoaded.value).toBe(true)
  } finally { f.wrapper.unmount(); await flushPromises() }
  expect(release).toHaveBeenCalledOnce()
})
it('keeps outgoing pixels during validation then rejects a private replacement without native bypass', async () => {
  const old = '/api/providers/lx/artwork/1', release = vi.fn(), rejectedRelease = vi.fn()
  let finish!: (value: null) => void
  const acquire = vi.spyOn(sharedArtworkCache, 'acquire').mockReturnValueOnce({
    ready: Promise.resolve(verifiedArtwork(old)), release,
  }).mockReturnValueOnce({ ready: new Promise(resolve => { finish = resolve }), release: rejectedRelease })
  const f = fixture(); await flushPromises(); const image = f.wrapper.get('img').element
  f.source.value = '/api/providers/lx/artwork/900'; await flushPromises()
  expect(f.wrapper.get('img').element).toBe(image); expect(release).not.toHaveBeenCalled()
  expect(f.art.sourceUrl.value).toBeUndefined()
  finish(null); await flushPromises()
  expect(f.wrapper.find('img').exists()).toBe(false); expect(f.art.hasFailed.value).toBe(true)
  expect(release).toHaveBeenCalledOnce(); expect(rejectedRelease).toHaveBeenCalledOnce()
  expect(acquire).toHaveBeenCalledTimes(2)
  f.wrapper.unmount(); await flushPromises()
})
it('preserves a proven same-track permitted cover if its replacement exhausts candidates',async()=>{
  vi.spyOn(sharedArtworkCache,'acquire').mockImplementation(url=>({
    ready:Promise.resolve(url.endsWith('/1')?verifiedArtwork(url):null),release:vi.fn(),
  }))
  const fallback=ref('/api/providers/lx/artwork/1'),source=ref(fallback.value)
  let art!:ReturnType<typeof useArtwork>
  const component=defineComponent({setup(){
    art=useArtwork('a',track,{player:true,candidates:()=>[source.value],retainedSource:fallback})
    return()=>h('img',{src:art.artworkUrl.value})
  }})
  const wrapper=mount(component);await flushPromises()
  source.value='/api/providers/lx/artwork/2';await flushPromises()
  expect(art.artworkUrl.value).toBe(artworkBlob(fallback.value))
  expect(art.sourceUrl.value).toBe(fallback.value)
  expect(art.hasFailed.value).toBe(false);wrapper.unmount()
})
it('revokes a retained cover when permission changes with the failed primary candidate unchanged',async()=>{
  const release=vi.fn(),old='/api/providers/lx/artwork/1',replacement='/api/providers/gd-studio/artwork/2'
  const acquire=vi.spyOn(sharedArtworkCache,'acquire').mockImplementation(url=>({
    ready:Promise.resolve(url===old?verifiedArtwork(url):null),release:url===old?release:vi.fn(),
  }))
  const retained=ref<string|undefined>(old),source=ref(old)
  let art!:ReturnType<typeof useArtwork>
  const wrapper=mount(defineComponent({setup(){
    art=useArtwork('a',track,{player:true,candidates:()=>[source.value],retainedSource:retained})
    return()=>h('img',{src:art.artworkUrl.value})
  }}))
  try {
    await flushPromises();source.value=replacement;await flushPromises()
    expect(art.sourceUrl.value).toBe(old)
    expect(release).not.toHaveBeenCalled()
    retained.value=undefined;await flushPromises()
    expect(source.value).toBe(replacement)
    expect(art.sourceUrl.value).toBeUndefined()
    expect(art.artworkUrl.value).toBeUndefined()
    expect(art.isLoaded.value).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    expect(acquire).toHaveBeenCalledTimes(2)
  } finally { wrapper.unmount();await flushPromises() }
})
it('revokes outgoing retained pixels without restarting a pending replacement',async()=>{
  const old='/api/providers/lx/artwork/1',replacement='/api/providers/gd-studio/artwork/2'
  const oldRelease=vi.fn(),newRelease=vi.fn()
  let finish!:(value:{url:string;sourceUrl:string;shared:boolean})=>void
  const acquire=vi.spyOn(sharedArtworkCache,'acquire').mockReturnValueOnce({
    ready:Promise.resolve(verifiedArtwork(old)),release:oldRelease,
  }).mockReturnValueOnce({ready:new Promise(resolve=>{finish=resolve}),release:newRelease})
  const retained=ref<string|undefined>(old),source=ref(old)
  let art!:ReturnType<typeof useArtwork>
  const wrapper=mount(defineComponent({setup(){
    art=useArtwork('a',track,{player:true,candidates:()=>[source.value],retainedSource:retained})
    return()=>h('img',{src:art.artworkUrl.value})
  }}))
  try {
    await flushPromises();source.value=replacement;await flushPromises()
    expect(art.artworkUrl.value).toBe(artworkBlob(old))
    retained.value=undefined;await flushPromises()
    expect(art.artworkUrl.value).toBeUndefined()
    expect(art.sourceUrl.value).toBeUndefined()
    expect(oldRelease).toHaveBeenCalledOnce()
    expect(newRelease).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledTimes(2)
    finish(verifiedArtwork(replacement));await flushPromises()
    expect(art.sourceUrl.value).toBe(replacement)
    expect(art.isLoaded.value).toBe(true)
  } finally { wrapper.unmount();await flushPromises() }
  expect(newRelease).toHaveBeenCalledOnce()
})
it('keeps the existing ChKSz metadata fallback when both canonical artwork routes fail', async () => {
  const url='/api/providers/chksz/artwork?url='+encodeURIComponent('https://p1.music.126.net/fallback.jpg')
  const fetcher=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({metadata:{artworkUrl:url}}))
  vi.spyOn(sharedArtworkCache,'acquire').mockImplementation(source=>({
    ready:Promise.resolve(source===url?verifiedArtwork(url):null),release:vi.fn(),
  }))
  const libraryTrack={...track.value,id:'fallback-track',sources:[{provider:'chksz',externalId:'123456'}]}
  let art!:ReturnType<typeof useArtwork>
  const component=defineComponent({setup(){
    art=useArtwork('fallback-cover',()=>libraryTrack)
    return()=>h('span',{ref:art.element},art.artworkUrl.value?[h('img',{src:art.artworkUrl.value})]:[])
  }})
  vi.stubGlobal('IntersectionObserver',undefined)
  const wrapper=mount(component)
  try {
    await flushPromises()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({externalId:'123456',level:'standard'})
    expect(art.artworkUrl.value).toBe(artworkBlob(url))
    expect(art.isLoaded.value).toBe(true)
  } finally { wrapper.unmount();vi.unstubAllGlobals() }
})
it('keeps the visible previous Blob alive beyond the old timeout while replacement remains pending',async()=>{
  vi.useFakeTimers()
  const release=vi.fn()
  vi.spyOn(sharedArtworkCache,'acquire').mockReturnValueOnce({
    ready:Promise.resolve(verifiedArtwork('/api/providers/lx/artwork/1')),release,
  }).mockReturnValue({ready:new Promise(()=>{}),release:vi.fn()} as ArtworkLease)
  const f=fixture();await flushPromises()
  f.source.value='/api/providers/lx/artwork/2';await flushPromises()
  expect(release).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(15000)
  expect(release).not.toHaveBeenCalled();expect(f.wrapper.get('img').attributes('src')).toBe(artworkBlob('/api/providers/lx/artwork/1'))
  f.wrapper.unmount();await flushPromises();expect(release).toHaveBeenCalledOnce()
})
