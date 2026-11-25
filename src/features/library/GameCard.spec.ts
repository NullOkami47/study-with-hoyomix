import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import { artworkBlob, mockValidatedArtwork, verifiedArtwork } from '../../test/artworkLeaseFixture'
import { libraryFixtureTracks } from '../../test/fixtures/libraryCatalogue'
import { clearArtworkCache } from './artwork'
import { buildCatalogueIndex, type GameEntry } from './catalogueIndex'
import GameCard from './GameCard.vue'

function gameFor(tracks: Track[], id: GameEntry['id'] = 'genshin'): GameEntry {
  return buildCatalogueIndex(tracks).games.find((game) => game.id === id)!
}

const representative: Track = {
  ...libraryFixtureTracks()[0]!,
  sources: [
    { provider: 'jellyfin', externalId: 'jf-game-cover' },
    { provider: 'chksz', externalId: '2155423468' },
  ],
}

let cache: ReturnType<typeof mockValidatedArtwork>

beforeEach(() => {
  clearArtworkCache()
  vi.restoreAllMocks()
  cache = mockValidatedArtwork()
})
afterEach(async () => {
  await flushPromises()
  clearArtworkCache()
  vi.restoreAllMocks()
})

describe('GameCard artwork', () => {
  it.each([
    ['genshin', '/api/providers/lx/artwork/100001'],
    ['hsr', '/api/providers/lx/artwork/100006'],
    ['zzz', '/api/providers/lx/artwork/100008'],
  ] as const)('renders existing catalogue artwork for %s without resolving audio', async (id, expectedUrl) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const wrapper = mount(GameCard, {
      props: { game: gameFor(libraryFixtureTracks(), id), locale: 'en' },
    })
    expect(wrapper.find('[data-game-artwork]').exists()).toBe(false)
    await flushPromises()

    const image = wrapper.get('[data-game-artwork]')
    expect(cache.acquire).toHaveBeenCalledWith(expectedUrl, { pin: false })
    expect(image.attributes('src')).toBe(artworkBlob(expectedUrl))
    expect(image.attributes('loading')).toBe('lazy')
    expect(image.attributes('decoding')).toBe('async')
    expect(image.attributes('alt')).toBe('')
    expect(wrapper.get('.game-card__artwork').attributes('aria-hidden')).toBe('true')
    expect(image.classes()).toContain('is-loaded')
    expect(fetchSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each([
    ['GD Studio', { provider: 'gd-studio', externalId: 'netease:2155423468:320' }, '/api/providers/gd-studio/artwork/2155423468'],
    ['NetEase', { provider: 'chksz', externalId: '2155423468' }, '/api/providers/lx/artwork/2155423468'],
  ] as const)('uses a later %s-capable track when the first track is YouTube-only', async (_label, source, expectedUrl) => {
    const tracks = [
      { ...representative, id: 'genshin-youtube-first', sources: [{ provider: 'youtube', externalId: 'youtube-only' }] },
      { ...representative, id: 'genshin-artwork-second', sources: [source] },
    ]
    const wrapper = mount(GameCard, {
      props: { game: gameFor(tracks), locale: 'en' },
    })
    await flushPromises()

    expect(wrapper.get('[data-game-artwork]').attributes('src')).toBe(artworkBlob(expectedUrl))
    wrapper.unmount()
  })

  it('reveals loaded artwork and keeps the existing browse action and counts', async () => {
    const game = gameFor(libraryFixtureTracks())
    const wrapper = mount(GameCard, { props: { game, locale: 'zh-Hant' } })
    await flushPromises()
    const image = wrapper.get('[data-game-artwork]')

    await image.trigger('load')
    expect(image.classes()).toContain('is-loaded')
    expect(wrapper.get('[data-game-name]').text()).toBe('原神')
    expect(wrapper.get('[data-game-counts]').text()).toContain('5')
    await wrapper.get('[data-game-open]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([[game]])
    wrapper.unmount()
  })

  it('uses LX then GD artwork directly despite a historical Jellyfin binding', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const wrapper = mount(GameCard, {
      props: { game: gameFor([representative]), locale: 'en' },
    })
    await flushPromises()

    expect(wrapper.get('[data-game-artwork]').attributes('src')).toBe(artworkBlob('/api/providers/lx/artwork/2155423468'))
    await wrapper.get('[data-game-artwork]').trigger('error')
    await flushPromises()
    expect(cache.invalidate).toHaveBeenCalledWith('/api/providers/lx/artwork/2155423468')
    const image = wrapper.get('[data-game-artwork]')
    expect(image.attributes('src')).toBe(artworkBlob('/api/providers/gd-studio/artwork/2155423468'))
    await image.trigger('load')
    expect(image.classes()).toContain('is-loaded')
    expect(cache.acquire.mock.calls.every(([url]) => !url.includes('jellyfin'))).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('removes a broken image while preserving the gradient and browse action', async () => {
    const track: Track = {
      ...representative,
      sources: [{ provider: 'gd-studio', externalId: 'netease:123456:320' }],
    }
    const game = gameFor([track])
    const wrapper = mount(GameCard, { props: { game, locale: 'en' } })
    const fallback = wrapper.get('.game-card__artwork').attributes('style')
    await flushPromises()

    await wrapper.get('[data-game-artwork]').trigger('error')
    await flushPromises()
    await wrapper.get('[data-game-artwork]').trigger('error')
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('.game-card__artwork').attributes('style')).toBe(fallback)
    expect(fallback).toContain('--artwork: linear-gradient')
    await wrapper.get('[data-game-open]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([[game]])
    wrapper.unmount()
  })

  it('does not reuse another game’s loaded artwork when a card is updated', async () => {
    const tracks = libraryFixtureTracks()
    const wrapper = mount(GameCard, {
      props: { game: gameFor(tracks), locale: 'en' },
    })
    await flushPromises()
    const genshinImage = wrapper.get('[data-game-artwork]')
    expect(genshinImage.attributes('src')).toBe(artworkBlob('/api/providers/lx/artwork/100001'))
    expect(genshinImage.classes()).toContain('is-loaded')

    let resolveNext!: (value: ReturnType<typeof verifiedArtwork>) => void
    const releaseNext = vi.fn()
    cache.acquire.mockImplementationOnce(() => ({
      ready: new Promise((resolve) => { resolveNext = resolve }),
      release: releaseNext,
    }))

    await wrapper.setProps({ game: gameFor(tracks, 'hsr') })
    await flushPromises()
    expect(wrapper.get('[data-game-artwork]').attributes('src')).not.toBe(artworkBlob('/api/providers/lx/artwork/100006'))

    resolveNext(verifiedArtwork('/api/providers/lx/artwork/100006'))
    await flushPromises()
    const hsrImage = wrapper.get('[data-game-artwork]')
    expect(hsrImage.element).not.toBe(genshinImage.element)
    expect(hsrImage.attributes('src')).toBe(artworkBlob('/api/providers/lx/artwork/100006'))
    expect(hsrImage.classes()).toContain('is-loaded')
    wrapper.unmount()
    await flushPromises()
    expect(releaseNext).toHaveBeenCalledOnce()
  })

  it('tries a replacement catalogue image after the previous representative failed', async () => {
    const oldTrack: Track = { ...representative, sources: [{ provider: 'gd-studio', externalId: 'netease:123456:320' }] }
    const newTrack: Track = { ...oldTrack, id: 'genshin-new-cover', sources: [{ provider: 'gd-studio', externalId: 'netease:234567:320' }] }
    const wrapper = mount(GameCard, {
      props: { game: gameFor([oldTrack]), locale: 'en' },
    })
    await flushPromises()
    await wrapper.get('[data-game-artwork]').trigger('error')
    await flushPromises()
    await wrapper.get('[data-game-artwork]').trigger('error')
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)

    await wrapper.setProps({ game: gameFor([newTrack]) })
    await flushPromises()
    expect(wrapper.get('[data-game-artwork]').attributes('src')).toBe(artworkBlob('/api/providers/gd-studio/artwork/234567'))
    wrapper.unmount()
  })

  it('keeps a decorative fallback without requesting unavailable artwork', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    for (const tracks of [[], [{ ...representative, sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }] }], [{ ...representative, sources: [{ provider: 'jellyfin', externalId: 'retired-only' }] }]]) {
      const wrapper = mount(GameCard, {
        props: { game: gameFor(tracks), locale: 'en' },
      })
      expect(wrapper.find('img').exists()).toBe(false)
      expect(wrapper.get('.game-card__artwork').attributes('style')).toContain('--artwork: linear-gradient')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
