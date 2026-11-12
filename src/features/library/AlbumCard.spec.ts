import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import AlbumCard from './AlbumCard.vue'
import { clearArtworkCache } from './artwork'
import type { AlbumEntry } from './catalogueIndex'

const sampleAlbum: AlbumEntry = {
  id: 'genshin:The Stellar Moments',
  title: 'The Stellar Moments',
  game: 'genshin',
  trackIds: ['track-1', 'track-2'],
  trackCount: 2,
  representativeTrack: {
    id: 'track-1',
    title: 'Dawn Winery',
    aliases: {},
    games: ['genshin'],
    relationIds: [],
    tabs: ['focus'],
    workGroupId: 'wg-1',
    needsClassification: false,
    vocalStatus: 'instrumental',
    sources: [{ provider: 'jellyfin', externalId: 'jf-stellar' }, { provider: 'chksz', externalId: '9000000002' }],
    album: 'The Stellar Moments',
  },
}

describe('AlbumCard', () => {
  beforeEach(() => {
    clearArtworkCache()
  })

  it('renders album title, game, track count and gradient background', () => {
    const wrapper = mount(AlbumCard, {
      props: { album: sampleAlbum, locale: 'en' },
    })

    expect(wrapper.get('[data-album-title]').text()).toBe('The Stellar Moments')
    expect(wrapper.get('[data-album-game]').text()).toContain('Genshin')
    expect(wrapper.get('[data-album-count]').text()).toContain('2')
    expect(wrapper.get('.album-card__artwork').attributes('style')).toContain('--artwork: linear-gradient')
  })

  it('renders real artwork image when track source has artwork', async () => {
    const wrapper = mount(AlbumCard, {
      props: { album: sampleAlbum, locale: 'en' },
    })

    const img = wrapper.find('[data-album-artwork]')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/api/providers/lx/artwork/9000000002')
    expect(img.classes()).not.toContain('is-loaded')

    // Simulate load
    await img.trigger('load')
    expect(img.classes()).toContain('is-loaded')
  })

  it('shows a provider-owned cover when Jellyfin is unavailable but the canonical NetEase binding exists',async()=>{
    const album={...sampleAlbum,representativeTrack:{...sampleAlbum.representativeTrack!,sources:[
      {provider:'jellyfin',externalId:'jf-unavailable'}, {provider:'chksz',externalId:'9000000002'},
    ]}}
    const wrapper=mount(AlbumCard,{props:{album,locale:'en'}})
    expect(wrapper.get('[data-album-artwork]').attributes('src')).toBe('/api/providers/lx/artwork/9000000002')
    await wrapper.get('[data-album-artwork]').trigger('load')
    expect(wrapper.get('[data-album-artwork]').classes()).toContain('is-loaded')
    expect(wrapper.get('[data-album-artwork]').attributes('loading')).toBe('lazy')
    wrapper.unmount()
  })

  it('uses the gradient immediately when only a retired Jellyfin binding remains', async () => {
    const failingAlbum: AlbumEntry = {
      ...sampleAlbum,
      id: 'zzz:Failing Album',
      title: 'Failing Album',
      representativeTrack: {
        ...sampleAlbum.representativeTrack!,
        sources: [{ provider: 'jellyfin', externalId: 'jf-bad' }],
      },
    }

    const wrapper = mount(AlbumCard, {
      props: { album: failingAlbum, locale: 'en' },
    })

    expect(wrapper.find('[data-album-artwork]').exists()).toBe(false)
    expect(wrapper.get('.album-card__artwork').attributes('style')).toContain('--artwork: linear-gradient')
  })

  it('emits open event when clicked', async () => {
    const wrapper = mount(AlbumCard, {
      props: { album: sampleAlbum, locale: 'en' },
    })

    await wrapper.get('[data-album-open]').trigger('click')
    expect(wrapper.emitted('open')).toBeTruthy()
    expect(wrapper.emitted('open')![0]).toEqual([sampleAlbum])
  })
})
