import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, provide } from 'vue'
import { artworkPermissionsKey, createArtworkPermissions } from './artworkPermissions'
import { useArtwork } from './artwork'
import { sharedArtworkCache, createArtworkCache, type ArtworkResource } from './artworkCache'
import { png } from './test/artworkImages'
import type { Track } from '../catalog/types'
import { clearArtworkCache } from './artwork'

describe('artwork provider permissions', () => {
  it('removes a visible cached cover and refuses reacquisition after local and server revocation', async () => {
    let notify = () => {}, disabled = false
    const dispose = vi.fn()
    const permissions = createArtworkPermissions({ isDisabled: () => disabled, subscribe(fn) { notify = fn; return dispose } })
    const source = '/api/providers/lx/artwork/1', release = vi.fn()
    const acquire = vi.spyOn(sharedArtworkCache, 'acquire').mockReturnValue({ ready: Promise.resolve({ url: 'blob:http://localhost/known', sourceUrl: source, shared: true }), release })
    const view = defineComponent({ setup() {
      const art = useArtwork('one', undefined, { candidates: () => [source], player: true })
      return () => art.artworkUrl.value ? h('img', { src: art.artworkUrl.value }) : h('span')
    } })
    const wrapper = mount(defineComponent({ setup() { provide(artworkPermissionsKey, permissions); return () => h(view) } }))
    try {
      await flushPromises(); expect(wrapper.find('img').exists()).toBe(true)
      disabled = true; notify(); await flushPromises()
      expect(wrapper.find('img').exists()).toBe(false); expect(release).toHaveBeenCalledOnce()
      expect(acquire).toHaveBeenCalledOnce()
      permissions.update([{ id: 'lx', available: true, enabled: false }])
      disabled = false; notify(); await flushPromises()
      expect(wrapper.find('img').exists()).toBe(false); expect(acquire).toHaveBeenCalledOnce()
      expect(permissions.allows('/api/providers/gd-studio/artwork/1')).toBe(false)
    } finally { wrapper.unmount(); permissions.dispose(); acquire.mockRestore() }
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('does not publish a pending image after its provider permission is revoked', async () => {
    const permissions = createArtworkPermissions({ isDisabled: () => false, subscribe: () => () => {} })
    const source = '/api/providers/lx/artwork/23', released = vi.fn()
    let finished!: (value: ArtworkResource) => void, releaseCalls = 0
    const acquire = vi.spyOn(sharedArtworkCache, 'acquire').mockReturnValue({
      ready: new Promise(resolve => { finished = resolve }),
      release() { if (!releaseCalls++) released() },
    })
    const view = defineComponent({ setup() {
      const art = useArtwork('pending', undefined, { candidates: () => [source], player: true })
      return () => art.artworkUrl.value ? h('img', { src: art.artworkUrl.value }) : h('span')
    } })
    const wrapper = mount(defineComponent({ setup() { provide(artworkPermissionsKey, permissions); return () => h(view) } }))
    try {
      await flushPromises(); expect(acquire).toHaveBeenCalledOnce()
      permissions.update([{ id: 'lx', available: true, enabled: false }]); await flushPromises()
      expect(released).toHaveBeenCalledOnce()
      finished({ url: 'blob:http://localhost/late-private', sourceUrl: source, shared: true })
      await flushPromises()
      expect(wrapper.find('img').exists()).toBe(false); expect(acquire).toHaveBeenCalledOnce()
    } finally { wrapper.unmount(); await flushPromises(); permissions.dispose(); acquire.mockRestore() }
  })

  it('does not revoke a shared byte owner when a different authorised provider still displays it', async () => {
    const permissions = createArtworkPermissions({ isDisabled: () => false, subscribe: () => () => {} })
    permissions.update([{ id: 'lx', available: true, enabled: true }, { id: 'gd-studio', available: true, enabled: true }])
    const revoke = vi.fn(), create = vi.fn(() => 'blob:http://localhost/shared-album')
    const fetcher = vi.fn(async () => new Response(png(44), { headers: {
      'content-type': 'image/png', 'cache-control': 'public,max-age=3600',
    } }))
    const cache = createArtworkCache({ fetch: fetcher as typeof fetch, createObjectURL: create, revokeObjectURL: revoke,
      decode: async () => ({ naturalWidth: 16, naturalHeight: 16 }), releaseImage: () => {} })
    const acquire = vi.spyOn(sharedArtworkCache, 'acquire').mockImplementation(cache.acquire)
    const view = (provider: string) => defineComponent({ setup() {
      const art = useArtwork(provider, undefined, { candidates: () => ['/api/providers/' + provider + '/artwork/44'], player: true })
      return () => art.artworkUrl.value ? h('img', { 'data-provider': provider, src: art.artworkUrl.value }) : h('span')
    } })
    const lx = view('lx'), gd = view('gd-studio')
    const wrapper = mount(defineComponent({ setup() { provide(artworkPermissionsKey, permissions); return () => h('div', [h(lx), h(gd)]) } }))
    try {
      await vi.waitFor(() => expect(wrapper.findAll('img')).toHaveLength(2))
      expect(create).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledTimes(2)
      expect(wrapper.get('[data-provider="lx"]').attributes('src')).toBe(wrapper.get('[data-provider="gd-studio"]').attributes('src'))
      permissions.update([{ id: 'lx', available: true, enabled: false }, { id: 'gd-studio', available: true, enabled: true }])
      await flushPromises(); cache.clear()
      expect(wrapper.find('[data-provider="lx"]').exists()).toBe(false)
      expect(wrapper.get('[data-provider="gd-studio"]').attributes('src')).toBe('blob:http://localhost/shared-album')
      expect(revoke).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(2)
      wrapper.unmount(); await flushPromises()
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:http://localhost/shared-album')
    } finally { wrapper.unmount(); await flushPromises(); cache.clear(); permissions.dispose(); acquire.mockRestore() }
  })

  it('permits key-free artwork from public state without a playback registry', async () => {
    const permissions = createArtworkPermissions({ isDisabled: () => false, subscribe: () => () => {} })
    const source = '/api/providers/chksz/artwork?url=' + encodeURIComponent('https://p1.music.126.net/key-free.jpg')
    // The public artwork gate is independent of whether an audio key/registry exists.
    permissions.update([{ id: 'chksz', available: true, enabled: true }])
    const release = vi.fn(), acquire = vi.spyOn(sharedArtworkCache, 'acquire').mockReturnValue({
      ready: Promise.resolve({ url: 'blob:http://localhost/key-free', sourceUrl: source, shared: true }), release,
    })
    const view = defineComponent({ setup() {
      const art = useArtwork('key-free', undefined, { candidates: () => [source], player: true })
      return () => art.artworkUrl.value ? h('img', { src: art.artworkUrl.value }) : h('span')
    } })
    const wrapper = mount(defineComponent({ setup() { provide(artworkPermissionsKey, permissions); return () => h(view) } }))
    try {
      await flushPromises()
      expect(wrapper.get('img').attributes('src')).toBe('blob:http://localhost/key-free')
      expect(acquire).toHaveBeenCalledOnce()
      permissions.update([]); await flushPromises()
      expect(wrapper.find('img').exists()).toBe(false); expect(release).toHaveBeenCalledOnce()
    } finally { wrapper.unmount(); permissions.dispose(); acquire.mockRestore() }
  })

  it('revokes a displayed ChKSz metadata fallback even when canonical candidates stay empty', async () => {
    clearArtworkCache()
    const permissions = createArtworkPermissions({ isDisabled: () => false, subscribe: () => () => {} })
    permissions.update([{ id: 'chksz', available: true, enabled: true }])
    const source = '/api/providers/chksz/artwork?url=' + encodeURIComponent('https://p1.music.126.net/permission-fallback.jpg')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ metadata: { artworkUrl: source } }))
    const release = vi.fn(), acquire = vi.spyOn(sharedArtworkCache, 'acquire').mockReturnValue({
      ready: Promise.resolve({ url: 'blob:http://localhost/fallback', sourceUrl: source, shared: true }), release,
    })
    const track: Track = { id: 'permission-fallback', title: 'Fallback', aliases: {}, games: ['hsr'], relationIds: [], tabs: ['focus'],
      sources: [{ provider: 'chksz', externalId: '9923' }], workGroupId: 'fallback', needsClassification: false, vocalStatus: 'instrumental' }
    const view = defineComponent({ setup() {
      const art = useArtwork(track.id, track, { player: true })
      return () => art.artworkUrl.value ? h('img', { src: art.artworkUrl.value }) : h('span')
    } })
    const wrapper = mount(defineComponent({ setup() { provide(artworkPermissionsKey, permissions); return () => h(view) } }))
    try {
      await flushPromises()
      expect(wrapper.get('img').attributes('src')).toBe('blob:http://localhost/fallback')
      expect(fetcher).toHaveBeenCalledOnce(); expect(acquire).toHaveBeenCalledOnce()
      permissions.update([{ id: 'chksz', available: true, enabled: false }]); await flushPromises()
      expect(wrapper.find('img').exists()).toBe(false); expect(release).toHaveBeenCalledOnce()
      expect(fetcher).toHaveBeenCalledOnce(); expect(acquire).toHaveBeenCalledOnce()
    } finally { wrapper.unmount(); await flushPromises(); permissions.dispose(); acquire.mockRestore(); fetcher.mockRestore(); clearArtworkCache() }
  })
})
