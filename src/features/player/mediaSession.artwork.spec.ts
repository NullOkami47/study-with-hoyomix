import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { effectScope, nextTick, ref, type Ref } from 'vue'
import { createPlaybackStore } from './store'
import type { Playable } from './providers/types'
import PlayerBar from './PlayerBar.vue'
import { clearArtworkCache } from '../library/artwork'
import { sharedArtworkCache } from '../library/artworkCache'
import { artworkBlob, mockValidatedArtwork, verifiedArtwork } from '../../test/artworkLeaseFixture'
import type { Track } from '../catalog/types'
import { playbackCommands } from './commands'
import { publishPlaybackPresentation } from './presentation'
import { registerPlaybackMediaSession } from './mediaSession'

afterEach(() => { clearArtworkCache(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, 'mediaSession') })
it('deduplicates native artwork metadata across progress, equal track objects and audio generations', async () => {
  const cache = mockValidatedArtwork(), one = '/api/providers/lx/artwork/1', two = '/api/providers/lx/artwork/2'
  cache.resources.set(one, verifiedArtwork(one)); cache.resources.set(two, verifiedArtwork(two))
  const writes: unknown[] = []
  const session = { setActionHandler: vi.fn(), setPositionState: vi.fn(), playbackState: 'none',
    set metadata(value: unknown) { writes.push(value) } }
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
  vi.stubGlobal('MediaMetadata', class { constructor(public value: MediaMetadataInit) {} })
  const store = createPlaybackStore()
  const track: Track = { id: 'a', title: 'A', album: 'Album', aliases: {}, games: ['hsr'], relationIds: [], tabs: ['focus'],
    workGroupId: 'a', needsClassification: false, vocalStatus: 'instrumental', sources: [] }
  store.currentTrack = ref(track)
  publishPlaybackPresentation(store, { currentTime: 0, duration: 100, canSeek: true, artworkUrl: artworkBlob(one), artworkSourceUrl: one })
  const scope = effectScope()
  const dispose = scope.run(() => registerPlaybackMediaSession(store, playbackCommands, () => store.currentTrack.value?.title || ''))!
  const count = writes.length, oldRelease = cache.metadataReleases.get(artworkBlob(one))!
  for (let i = 1; i <= 4; i++) {
    publishPlaybackPresentation(store, { currentTime: i, duration: 100, canSeek: true, artworkUrl: artworkBlob(one), artworkSourceUrl: one })
    ;(store.currentTrack as Ref<Track | undefined>).value = { ...track }
    ;(store.playbackGeneration as Ref<number>).value++
    await nextTick()
  }
  expect(writes).toHaveLength(count); expect(cache.retain).toHaveBeenCalledOnce(); expect(oldRelease).not.toHaveBeenCalled()
  publishPlaybackPresentation(store, { currentTime: 5, duration: 100, canSeek: true, artworkUrl: artworkBlob(two), artworkSourceUrl: two })
  await nextTick()
  expect(writes).toHaveLength(count + 1); expect(oldRelease).toHaveBeenCalledOnce()
  expect(writes.at(-1)).toMatchObject({ value: { artwork: [{ src: artworkBlob(two) }] } })
  const nextRelease = cache.metadataReleases.get(artworkBlob(two))!
  dispose(); scope.stop(); store.dispose(); expect(nextRelease).toHaveBeenCalledOnce()
})

it.each(['/api/providers/lx/artwork/1', 'https://evil.invalid/cover.png', 'blob:http://localhost/unregistered'])('never publishes an unregistered artwork URL to the OS: %s', async url => {
  const writes: MediaMetadataInit[] = [], retain = vi.spyOn(sharedArtworkCache, 'retain').mockReturnValue(undefined)
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: {
    setActionHandler: vi.fn(), setPositionState: vi.fn(), playbackState: 'none',
    set metadata(value: { value: MediaMetadataInit } | null) { if (value) writes.push(value.value) },
  } })
  vi.stubGlobal('MediaMetadata', class { constructor(public value: MediaMetadataInit) {} })
  const store = createPlaybackStore()
  store.currentTrack = ref<Track>({ id: 'unregistered', title: 'Unregistered', album: 'Album', aliases: {}, games: ['hsr'],
    relationIds: [], tabs: ['focus'], workGroupId: 'a', needsClassification: false, vocalStatus: 'instrumental', sources: [] })
  publishPlaybackPresentation(store, { currentTime: 0, duration: 100, canSeek: true, artworkUrl: url,
    artworkSourceUrl: '/api/providers/lx/artwork/1' })
  const scope = effectScope(), dispose = scope.run(() => registerPlaybackMediaSession(store, playbackCommands, () => 'Unregistered'))!
  expect(writes.at(-1)?.artwork).toEqual([]); expect(retain).toHaveBeenCalledWith(url)
  dispose(); scope.stop(); store.dispose()
})

function mountedArtworkPlayer(artworkUrl='/api/providers/lx/artwork/1', provider='lx') {
  const writes:Array<MediaMetadataInit|null>=[]
  Object.defineProperty(navigator,'mediaSession',{configurable:true,value:{
    setActionHandler:vi.fn(),setPositionState:vi.fn(),playbackState:'none',
    set metadata(value:{value:MediaMetadataInit}|null){writes.push(value?.value??null)},
  }})
  vi.stubGlobal('MediaMetadata',class{constructor(public value:MediaMetadataInit){}})
  vi.spyOn(HTMLMediaElement.prototype,'load').mockImplementation(()=>{})
  vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{})
  const originalDecode=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'decode')
  Object.defineProperty(HTMLImageElement.prototype,'decode',{configurable:true,value:async()=>{}})
  const store=createPlaybackStore()
  store.currentTrack=ref<Track>({id:'artwork-owner',title:'Artwork owner',album:'Album',aliases:{},games:['hsr'],
    relationIds:[],tabs:['focus'],workGroupId:'artwork-owner',needsClassification:false,vocalStatus:'instrumental',
    sources:[{provider:'lx',externalId:'wy:1:128k'},{provider:'gd-studio',externalId:'netease:2:320'}]})
  store.activeProviderId=ref(provider)
  store.enabledProviderIds=ref(['lx','gd-studio','chksz'])
  store.playbackIntent=ref<'paused'>('paused')
  store.status=ref<'paused'>('paused')
  store.playable=ref<Playable|null>({kind:'audio',url:'/artwork-fixture.mp3',mimeType:'audio/mpeg',metadata:{artworkUrl}})
  const wrapper=mount(PlayerBar,{props:{store}})
  return {store,wrapper,writes,dispose(){
    wrapper.unmount();store.dispose()
    if(originalDecode)Object.defineProperty(HTMLImageElement.prototype,'decode',originalDecode)
    else Reflect.deleteProperty(HTMLImageElement.prototype,'decode')
  }}
}

it('removes a cached ChKSz cover when its own provider is disabled without changing audio', async () => {
  const cache = mockValidatedArtwork()
  const source = '/api/providers/chksz/artwork?url=' + encodeURIComponent('https://p1.music.126.net/cover.jpg')
  const f = mountedArtworkPlayer(source, 'chksz')
  try {
    await flushPromises()
    expect(f.wrapper.get('[data-player-artwork-image]').attributes('src')).toBe(artworkBlob(source))
    const playable = f.store.playable.value
    ;(f.store.enabledProviderIds as Ref<string[]>).value = ['lx', 'gd-studio']
    await flushPromises()
    expect(f.wrapper.find('[data-player-artwork-image]').exists()).toBe(false)
    expect(f.writes.at(-1)?.artwork).toEqual([])
    expect(f.store.playable.value).toBe(playable)
    expect(cache.releases.get(source)).toHaveBeenCalledOnce()
    expect(cache.metadataReleases.get(artworkBlob(source))).toHaveBeenCalledOnce()
  } finally { f.dispose(); await flushPromises() }
})

it('keeps mounted PlayerBar metadata and its validated Blob owner across same-track resolving', async () => {
  const cache = mockValidatedArtwork(), url = '/api/providers/lx/artwork/1'
  const f = mountedArtworkPlayer()
  try {
    await flushPromises()
    expect(f.writes.at(-1)?.artwork).toEqual([{ src: artworkBlob(url) }])
    const count = f.writes.length, image = f.wrapper.get('[data-player-artwork-image]').element
    const release = cache.releases.get(url)!, metadataRelease = cache.metadataReleases.get(artworkBlob(url))!
    for (const status of ['resolving', 'paused'] as const) {
      ;(f.store.status as Ref<string>).value = status; await flushPromises()
      expect(f.wrapper.get('[data-player-artwork-image]').element).toBe(image)
      expect(f.writes.at(-1)?.artwork).toEqual([{ src: artworkBlob(url) }])
    }
    expect(f.writes).toHaveLength(count); expect(cache.acquire).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled(); expect(metadataRelease).not.toHaveBeenCalled()
  } finally { f.dispose(); await flushPromises() }
  expect(cache.releases.get(url)).toHaveBeenCalledOnce()
  expect(cache.metadataReleases.get(artworkBlob(url))).toHaveBeenCalledOnce()
})

it('rejects a no-store response without displaying it or passing its HTTP URL to MediaSession', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('private image', {
    status: 200, headers: { 'cache-control': 'no-store', 'content-type': 'image/png' },
  }))
  const f = mountedArtworkPlayer()
  try {
    await flushPromises()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(f.wrapper.find('[data-player-artwork-image]').exists()).toBe(false)
    expect(f.writes.at(-1)?.artwork).toEqual([])
    expect(sharedArtworkCache.snapshot().assets).toBe(0)
  } finally { f.dispose(); await flushPromises() }
})

it('revokes the retained LX MediaSession cover after GD replacement failure and LX disablement', async () => {
  const cache = mockValidatedArtwork(), old = '/api/providers/lx/artwork/1', replacement = '/api/providers/gd-studio/artwork/2'
  cache.rejected.add(replacement)
  const f = mountedArtworkPlayer()
  try {
    await flushPromises()
    const release = cache.releases.get(old)!
    expect(f.writes.at(-1)?.artwork).toEqual([{ src: artworkBlob(old) }])
    ;(f.store.activeProviderId as Ref<string>).value = 'gd-studio'
    ;(f.store.playable as Ref<unknown>).value = { kind: 'audio', url: '/gd-artwork-fixture.mp3', mimeType: 'audio/mpeg', metadata: { artworkUrl: replacement } }
    await flushPromises()
    expect(f.wrapper.get('[data-player-artwork-image]').attributes('src')).toBe(artworkBlob(old))
    expect(f.writes.at(-1)?.artwork).toEqual([{ src: artworkBlob(old) }]); expect(release).not.toHaveBeenCalled()
    const metadataRelease = cache.metadataReleases.get(artworkBlob(old))!, playable = f.store.playable.value
    ;(f.store.enabledProviderIds as Ref<string[]>).value = ['gd-studio']; await flushPromises()
    expect(f.store.playable.value).toBe(playable); expect(f.store.activeProviderId.value).toBe('gd-studio')
    expect(f.writes.at(-1)?.artwork).toEqual([]); expect(f.wrapper.find('[data-player-artwork-image]').exists()).toBe(false)
    expect(release).toHaveBeenCalledOnce(); expect(metadataRelease).toHaveBeenCalledOnce()
    expect(cache.acquire).toHaveBeenCalledTimes(2)
  } finally { f.dispose(); await flushPromises() }
})

it('keeps a newly decoded GD cover when the original LX provider is disabled', async () => {
  const cache = mockValidatedArtwork(), old = '/api/providers/lx/artwork/1', replacement = '/api/providers/gd-studio/artwork/2'
  const f = mountedArtworkPlayer()
  try {
    await flushPromises()
    const oldRelease = cache.releases.get(old)!
    ;(f.store.activeProviderId as Ref<string>).value = 'gd-studio'
    ;(f.store.playable as Ref<Playable | null>).value = { kind: 'audio', url: '/gd-artwork-fixture.mp3', mimeType: 'audio/mpeg', metadata: { artworkUrl: replacement } }
    await flushPromises()
    expect(f.writes.at(-1)?.artwork).toEqual([{ src: artworkBlob(replacement) }]); expect(oldRelease).toHaveBeenCalledOnce()
    const count = f.writes.length, newRelease = cache.releases.get(replacement)!
    ;(f.store.enabledProviderIds as Ref<string[]>).value = ['gd-studio']; await flushPromises()
    expect(f.writes).toHaveLength(count); expect(f.wrapper.get('[data-player-artwork-image]').attributes('src')).toBe(artworkBlob(replacement))
    expect(newRelease).not.toHaveBeenCalled(); expect(cache.acquire).toHaveBeenCalledTimes(2)
  } finally { f.dispose(); await flushPromises() }
  expect(cache.releases.get(replacement)).toHaveBeenCalledOnce()
  expect(cache.metadataReleases.get(artworkBlob(replacement))).toHaveBeenCalledOnce()
})


it('retains the same shared cover for the new canonical track through a later source-resolution gap', async () => {
  const cache = mockValidatedArtwork(), source = '/api/providers/lx/artwork/1'
  const f = mountedArtworkPlayer(source)
  try {
    await flushPromises()
    const image = f.wrapper.get('[data-player-artwork-image]').element
    ;(f.store.currentTrack as Ref<Track>).value = { ...f.store.currentTrack.value!, id: 'shared-album-next', title: 'Next' }
    await flushPromises()
    expect(f.wrapper.get('[data-player-artwork-image]').element).toBe(image)
    ;(f.store.playable as Ref<Playable | null>).value = null
    ;(f.store.status as Ref<string>).value = 'error'
    await flushPromises()
    expect(f.wrapper.get('[data-player-artwork-image]').element).toBe(image)
    expect(f.writes.at(-1)?.artwork).toEqual([{ src: artworkBlob(source) }])
    expect(cache.acquire).toHaveBeenCalledOnce()
  } finally { f.dispose(); await flushPromises() }
})

it('revokes an artwork provider independently of the active audio provider', async () => {
  const cache = mockValidatedArtwork(), source = '/api/providers/lx/artwork/1'
  const f = mountedArtworkPlayer(source, 'gd-studio')
  try {
    await flushPromises()
    expect(f.wrapper.get('[data-player-artwork-image]').attributes('src')).toBe(artworkBlob(source))
    const playable = f.store.playable.value
    ;(f.store.enabledProviderIds as Ref<string[]>).value = ['gd-studio']
    await flushPromises()
    expect(f.wrapper.find('[data-player-artwork-image]').exists()).toBe(false)
    expect(f.writes.at(-1)?.artwork).toEqual([])
    expect(cache.releases.get(source)).toHaveBeenCalledOnce()
    expect(f.store.playable.value).toBe(playable)
    expect(f.store.activeProviderId.value).toBe('gd-studio')
  } finally { f.dispose(); await flushPromises() }
})

it('restores a permitted current-track cover after remount during a nonplaying resolving gap', async () => {
  const cache = mockValidatedArtwork(), source = '/api/providers/lx/artwork/1'
  const f = mountedArtworkPlayer(source)
  let remounted: ReturnType<typeof mount> | undefined
  try {
    await flushPromises()
    const blob = f.wrapper.get('[data-player-artwork-image]').attributes('src')
    ;(f.store.status as Ref<string>).value = 'playing'; await flushPromises()
    ;(f.store.playable as Ref<Playable | null>).value = null
    ;(f.store.status as Ref<string>).value = 'resolving'
    await flushPromises()
    expect(f.wrapper.get('[data-player-artwork-image]').attributes('src')).toBe(blob)
    f.wrapper.unmount(); await flushPromises()
    remounted = mount(PlayerBar, { props: { store: f.store } }); await flushPromises()
    expect(remounted.get('[data-player-artwork-image]').attributes('src')).toBe(blob)
    expect(f.writes.at(-1)?.artwork).toEqual([{ src: blob }])
    expect(cache.acquire.mock.calls.every(([url]) => url === source)).toBe(true)
  } finally { remounted?.unmount(); f.dispose(); await flushPromises() }
})
