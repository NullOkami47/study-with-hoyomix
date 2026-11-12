import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
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
    { provider: 'chksz', externalId: '9000000002' },
  ],
}

beforeEach(() => clearArtworkCache())
afterEach(() => vi.restoreAllMocks())

describe('GameCard artwork', () => {
  it.each([
    ['genshin', '/api/providers/lx/artwork/100001'],
    ['hsr', '/api/providers/lx/artwork/100006'],
    ['zzz', '/api/providers/lx/artwork/100008'],
  ] as const)('renders existing catalogue artwork for %s without resolving audio', (id, expectedUrl) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const wrapper = mount(GameCard, {
      props: { game: gameFor(libraryFixtureTracks(), id), locale: 'en' },
    })
    const image = wrapper.get('[data-game-artwork]')

    expect(image.attributes('src')).toBe(expectedUrl)
    expect(image.attributes('loading')).toBe('lazy')
    expect(image.attributes('decoding')).toBe('async')
    expect(image.attributes('alt')).toBe('')
    expect(wrapper.get('.game-card__artwork').attributes('aria-hidden')).toBe('true')
    expect(image.classes()).not.toContain('is-loaded')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['GD Studio', { provider: 'gd-studio', externalId: 'netease:9000000002:320' }, '/api/providers/gd-studio/artwork/9000000002'],
    ['NetEase', { provider: 'chksz', externalId: '9000000002' }, '/api/providers/lx/artwork/9000000002'],
  ] as const)('uses a later %s-capable track when the first track is YouTube-only', (_label, source, expectedUrl) => {
    const tracks = [
      { ...representative, id: 'genshin-youtube-first', sources: [{ provider: 'youtube', externalId: 'youtube-only' }] },
      { ...representative, id: 'genshin-artwork-second', sources: [source] },
    ]
    const wrapper = mount(GameCard, {
      props: { game: gameFor(tracks), locale: 'en' },
    })

    expect(wrapper.get('[data-game-artwork]').attributes('src')).toBe(expectedUrl)
  })

  it('reveals loaded artwork and keeps the existing browse action and counts', async () => {
    const game = gameFor(libraryFixtureTracks())
    const wrapper = mount(GameCard, { props: { game, locale: 'zh-Hant' } })
    const image = wrapper.get('[data-game-artwork]')

    await image.trigger('load')
    expect(image.classes()).toContain('is-loaded')
    expect(wrapper.get('[data-game-name]').text()).toBe('原神')
    expect(wrapper.get('[data-game-counts]').text()).toContain('5')
    await wrapper.get('[data-game-open]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([[game]])
  })

  it('uses LX then GD artwork directly despite a historical Jellyfin binding', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const wrapper = mount(GameCard, {
      props: { game: gameFor([representative]), locale: 'en' },
    })

    expect(wrapper.get('[data-game-artwork]').attributes('src')).toBe('/api/providers/lx/artwork/9000000002')
    await wrapper.get('[data-game-artwork]').trigger('error')
    const image = wrapper.get('[data-game-artwork]')
    expect(image.attributes('src')).toBe('/api/providers/gd-studio/artwork/9000000002')
    await image.trigger('load')
    expect(image.classes()).toContain('is-loaded')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('removes a broken image while preserving the gradient and browse action', async () => {
    const track: Track = {
      ...representative,
      sources: [{ provider: 'gd-studio', externalId: 'netease:123456:320' }],
    }
    const game = gameFor([track])
    const wrapper = mount(GameCard, { props: { game, locale: 'en' } })
    const fallback = wrapper.get('.game-card__artwork').attributes('style')

    await wrapper.get('[data-game-artwork]').trigger('error')
    await wrapper.get('[data-game-artwork]').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.get('.game-card__artwork').attributes('style')).toBe(fallback)
    expect(fallback).toContain('--artwork: linear-gradient')
    await wrapper.get('[data-game-open]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([[game]])
  })

  it('does not reuse another game’s loaded artwork when a card is updated', async () => {
    const tracks = libraryFixtureTracks()
    const wrapper = mount(GameCard, {
      props: { game: gameFor(tracks), locale: 'en' },
    })
    await wrapper.get('[data-game-artwork]').trigger('load')

    await wrapper.setProps({ game: gameFor(tracks, 'hsr') })
    const image = wrapper.get('[data-game-artwork]')
    expect(image.attributes('src')).toBe('/api/providers/lx/artwork/100006')
    expect(image.classes()).not.toContain('is-loaded')
  })

  it('tries a replacement catalogue image after the previous representative failed', async () => {
    const oldTrack: Track = { ...representative, sources: [{ provider: 'gd-studio', externalId: 'netease:123456:320' }] }
    const newTrack: Track = { ...oldTrack, id: 'genshin-new-cover', sources: [{ provider: 'gd-studio', externalId: 'netease:234567:320' }] }
    const wrapper = mount(GameCard, {
      props: { game: gameFor([oldTrack]), locale: 'en' },
    })
    await wrapper.get('[data-game-artwork]').trigger('error')
    await wrapper.get('[data-game-artwork]').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)

    await wrapper.setProps({ game: gameFor([newTrack]) })
    expect(wrapper.get('[data-game-artwork]').attributes('src')).toBe('/api/providers/gd-studio/artwork/234567')
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
