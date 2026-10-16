/**
 * Music Library behaviour, with the queue-isolation contract as the centrepiece.
 *
 * The isolation tests use a **real** `createPlaybackStore`, not a mock, because the property
 * being protected is about the store's actual state: after browsing and searching, the queue
 * must hold exactly what the user explicitly asked for. A mock would only prove that this
 * component did not call it, which is a weaker claim.
 *
 * Playback itself is not exercised here — `playNow` would resolve a provider over the network.
 * The play *contract* (which track is handed to which store method) is asserted against a spy
 * instead, in its own block.
 */

import { mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import { createPlaybackStore, type PlaybackStore } from '../player/store'
import { LIBRARY_BROWSING_STORAGE_KEY } from './libraryBrowsingState'
import MusicLibrary from './MusicLibrary.vue'
import {
  FONTAINE_ALBUM,
  HAN_ALBUM,
  INSIDE_ALBUM,
  LIYUE_ALBUM,
  libraryFixtureTracks,
} from '../../test/fixtures/libraryCatalogue'

type LibraryPlayer = Pick<PlaybackStore, 'enqueue' | 'playNow' | 'playNext'>
type TestLocale = 'en' | 'zh-Hant'

const TRACKS = libraryFixtureTracks()
const byId = (id: string): Track => {
  const track = TRACKS.find((candidate) => candidate.id === id)
  if (!track) throw new Error(`fixture track missing: ${id}`)
  return track
}

function mountLibrary(
  player: LibraryPlayer = createPlaybackStore(),
  locale: TestLocale = 'en',
  tracks: Track[] = libraryFixtureTracks(),
) {
  return mount(MusicLibrary, { props: { tracks, player, locale } })
}

function trackRow(wrapper: VueWrapper, trackId: string) {
  return wrapper.get(`[data-track-row][data-track-id="${trackId}"]`)
}

function albumCard(wrapper: VueWrapper, title: string) {
  const card = wrapper
    .findAll('[data-album-card]')
    .find((candidate) => candidate.get('[data-album-title]').text() === title)
  if (!card) throw new Error(`album card not found: ${title}`)
  return card
}

const rowIds = (wrapper: VueWrapper, selector: string): (string | undefined)[] =>
  wrapper.findAll(`${selector} [data-track-row]`).map((row) => row.attributes('data-track-id'))

async function openGames(wrapper: VueWrapper) {
  await wrapper.get('[data-library-section="games"]').trigger('click')
}

async function openAlbums(wrapper: VueWrapper) {
  await wrapper.get('[data-library-section="albums"]').trigger('click')
}

async function search(wrapper: VueWrapper, value: string) {
  await wrapper.get('[data-music-library-search]').setValue(value)
}

/** A catalogue large enough to need more than one page of rows. */
function largeCatalogue(count: number): Track[] {
  return Array.from({ length: count }, (_, index): Track => ({
    id: `bulk-${index}`,
    title: `Bulk Track ${index}`,
    aliases: {},
    games: ['genshin'],
    relationIds: [],
    tabs: [],
    workGroupId: 'work-bulk',
    needsClassification: false,
    vocalStatus: 'instrumental',
    sources: [{ provider: 'jellyfin', externalId: `bulk-${index}` }],
    album: 'Bulk Album',
  }))
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('MusicLibrary — sections and grouping', () => {
  it('opens on All Tracks with every canonical track listed', () => {
    const wrapper = mountLibrary()

    expect(wrapper.get('[data-library-section="all"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-library-track-count]').text()).toBe('8 tracks')
    expect(wrapper.findAll('[data-library-tracks] [data-track-row]')).toHaveLength(8)
  })

  it('shows the three games with their album and track counts', async () => {
    const wrapper = mountLibrary()
    await openGames(wrapper)

    const cards = wrapper.findAll('[data-game-card]')
    expect(cards.map((card) => card.attributes('data-game-id'))).toEqual(['genshin', 'hsr', 'zzz'])
    expect(cards[0].get('[data-game-name]').text()).toBe('Genshin Impact')
    expect(cards[0].get('[data-game-counts]').text()).toBe('2 albums · 5 tracks')
    expect(cards[2].get('[data-game-name]').text()).toBe('Zenless Zone Zero')
  })

  it('shows only the selected game’s albums and tracks', async () => {
    const wrapper = mountLibrary()
    await openGames(wrapper)
    await wrapper.get('[data-game-id="hsr"] [data-game-open]').trigger('click')

    expect(wrapper.get('[data-active-game-name]').text()).toBe('Honkai: Star Rail')
    expect(wrapper.findAll('[data-game-albums] [data-album-card]')).toHaveLength(1)
    expect(wrapper.get('[data-game-albums] [data-album-title]').text()).toBe(INSIDE_ALBUM)
    expect(rowIds(wrapper, '[data-game-tracks]')).toEqual(['hsr-hope', 'hsr-sway'])
  })

  it('returns to the game list', async () => {
    const wrapper = mountLibrary()
    await openGames(wrapper)
    await wrapper.get('[data-game-id="genshin"] [data-game-open]').trigger('click')
    await wrapper.get('[data-library-back]').trigger('click')

    expect(wrapper.findAll('[data-game-card]')).toHaveLength(3)
  })

  it('lists every album as a card with its game and track count', async () => {
    const wrapper = mountLibrary()
    await openAlbums(wrapper)

    expect(wrapper.get('[data-library-album-count]').text()).toBe('4 albums')
    const fontaine = albumCard(wrapper, FONTAINE_ALBUM)
    expect(fontaine.get('[data-album-game]').text()).toBe('Genshin Impact')
    expect(fontaine.get('[data-album-count]').text()).toBe('2 tracks')

    expect(
      wrapper.findAll('[data-album-card]').map((card) => card.get('[data-album-title]').text()),
    ).toEqual([FONTAINE_ALBUM, LIYUE_ALBUM, INSIDE_ALBUM, HAN_ALBUM])
  })

  it('opens an album and lists exactly its tracks', async () => {
    const wrapper = mountLibrary()
    await openAlbums(wrapper)
    await albumCard(wrapper, LIYUE_ALBUM).get('[data-album-open]').trigger('click')

    expect(wrapper.get('[data-active-album-title]').text()).toBe(LIYUE_ALBUM)
    expect(wrapper.get('[data-active-album-counts]').text()).toContain('2 tracks')
    expect(rowIds(wrapper, '[data-album-tracks]')).toEqual([
      'genshin-liyue',
      'genshin-moon-in-ones-cup',
    ])
  })

  it('returns to the album grid', async () => {
    const wrapper = mountLibrary()
    await openAlbums(wrapper)
    await albumCard(wrapper, HAN_ALBUM).get('[data-album-open]').trigger('click')
    await wrapper.get('[data-library-back]').trigger('click')

    expect(wrapper.findAll('[data-album-card]')).toHaveLength(4)
  })

  it('keeps every canonical track discoverable through All Tracks and through its game', async () => {
    const wrapper = mountLibrary()
    const allIds = new Set(rowIds(wrapper, '[data-library-tracks]'))
    expect(allIds.size).toBe(8)

    const reachable = new Set<string | undefined>()
    await openGames(wrapper)
    for (const game of ['genshin', 'hsr', 'zzz']) {
      await wrapper.get(`[data-game-id="${game}"] [data-game-open]`).trigger('click')
      for (const id of rowIds(wrapper, '[data-game-tracks]')) reachable.add(id)
      await wrapper.get('[data-library-back]').trigger('click')
    }
    expect([...reachable].sort()).toEqual([...allIds].sort())
  })

  it('restores the remembered section from storage', () => {
    window.localStorage.setItem(
      LIBRARY_BROWSING_STORAGE_KEY,
      JSON.stringify({ section: 'albums', gameId: 'zzz', albumId: `zzz:${HAN_ALBUM}` }),
    )

    const wrapper = mountLibrary()

    expect(wrapper.get('[data-library-section="albums"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-active-album-title]').text()).toBe(HAN_ALBUM)
  })
})

describe('MusicLibrary — search', () => {
  it('searches the catalogue rather than the queue', async () => {
    const wrapper = mountLibrary()
    await search(wrapper, 'fontaine')

    expect(rowIds(wrapper, '[data-search-tracks]')).toEqual([
      'genshin-fontaine-daydream',
      'genshin-fontaine-nightfall',
    ])
  })

  it('structures results into tracks, albums and games', async () => {
    const wrapper = mountLibrary()
    await search(wrapper, 'genshin')

    expect(wrapper.find('[data-search-group="games"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-group="albums"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-group="tracks"]').exists()).toBe(true)
    expect(wrapper.get('[data-search-count="albums"]').text()).toContain('2')
  })

  it('omits empty categories rather than rendering them empty', async () => {
    const wrapper = mountLibrary()
    await search(wrapper, 'belleau')

    expect(wrapper.find('[data-search-group="albums"]').exists()).toBe(true)
    expect(wrapper.find('[data-search-group="games"]').exists()).toBe(false)
  })

  it('finds an album and can open it from the results', async () => {
    const wrapper = mountLibrary()
    await search(wrapper, 'inside')
    await albumCard(wrapper, INSIDE_ALBUM).get('[data-album-open]').trigger('click')

    expect(wrapper.get('[data-active-album-title]').text()).toBe(INSIDE_ALBUM)
  })

  it('finds a game and can open it from the results', async () => {
    const wrapper = mountLibrary()
    await search(wrapper, '絕區零')
    await wrapper.get('[data-search-games] [data-game-open]').trigger('click')

    expect(wrapper.get('[data-active-game-name]').text()).toBe('Zenless Zone Zero')
  })

  it('reports no matches without throwing', async () => {
    const wrapper = mountLibrary()
    await search(wrapper, 'zzzznotathing')

    expect(wrapper.get('[data-music-library-search-empty]').text()).toBe(
      'Nothing in the catalogue matches this search.',
    )
    expect(wrapper.find('[data-search-group="tracks"]').exists()).toBe(false)
  })

  it('returns to browsing when the query is cleared', async () => {
    const wrapper = mountLibrary()
    await search(wrapper, 'fontaine')
    await wrapper.get('[data-music-library-search-clear]').trigger('click')

    expect(wrapper.find('[data-music-library-search-summary]').exists()).toBe(false)
    expect(wrapper.get('[data-library-section="all"]').attributes('aria-pressed')).toBe('true')
  })

  it('treats a punctuation-only query as no query', async () => {
    const wrapper = mountLibrary()
    await search(wrapper, '!!!')

    expect(wrapper.find('[data-music-library-search-empty]').exists()).toBe(false)
    expect(wrapper.find('[data-library-panel="all"]').exists()).toBe(true)
  })

  it('finds a Han title from either script', async () => {
    const wrapper = mountLibrary()

    await search(wrapper, '輕漣')
    expect(rowIds(wrapper, '[data-search-tracks]')).toEqual(['genshin-la-vaguelette'])

    await search(wrapper, '轻涟')
    expect(rowIds(wrapper, '[data-search-tracks]')).toEqual(['genshin-la-vaguelette'])
  })

  it('prefers a reachable localised alias and keeps the canonical title visible', () => {
    const localised: Track = { ...byId('genshin-liyue'), aliases: { 'zh-Hant': ['璃月'] } }
    const wrapper = mountLibrary(createPlaybackStore(), 'zh-Hant', [localised])

    const row = wrapper.get('[data-track-row]')
    expect(row.get('[data-track-title]').text()).toBe('璃月')
    expect(row.get('[data-track-canonical]').text()).toBe('Liyue')
  })

  it('does not repeat the title when no reachable alias exists', async () => {
    const wrapper = mountLibrary(createPlaybackStore(), 'zh-Hant')
    await search(wrapper, 'fontaine daydream')

    const row = wrapper.get('[data-search-tracks] [data-track-row]')
    expect(row.get('[data-track-title]').text()).toBe('Fontaine Daydream')
    expect(row.find('[data-track-canonical]').exists()).toBe(false)
  })
})

describe('MusicLibrary — queue isolation', () => {
  it('adds exactly the requested track to an existing queue', async () => {
    const player = createPlaybackStore()
    player.enqueue(byId('hsr-sway'))
    const before = player.queue.value

    const wrapper = mountLibrary(player)
    await trackRow(wrapper, 'genshin-liyue').get('[data-track-enqueue]').trigger('click')

    expect(player.queue.value.map((track) => track.id)).toEqual(['hsr-sway', 'genshin-liyue'])
    // Appended, not replaced: the previously queued track is still the same object.
    expect(player.queue.value[0]).toBe(before[0])
  })

  it('adds one track per press and nothing else', async () => {
    const player = createPlaybackStore()
    const wrapper = mountLibrary(player)

    await trackRow(wrapper, 'genshin-liyue').get('[data-track-enqueue]').trigger('click')
    await trackRow(wrapper, 'zzz-tiny-giant').get('[data-track-enqueue]').trigger('click')

    expect(player.queue.value.map((track) => track.id)).toEqual(['genshin-liyue', 'zzz-tiny-giant'])
  })

  it('does not touch the queue when the search text changes', async () => {
    const player = createPlaybackStore()
    player.enqueue(byId('hsr-hope'))
    const before = player.queue.value

    const wrapper = mountLibrary(player)
    await search(wrapper, 'fontaine')
    await search(wrapper, 'genshin')
    await search(wrapper, '')
    await search(wrapper, '輕漣')

    expect(player.queue.value).toBe(before)
    expect(player.queue.value.map((track) => track.id)).toEqual(['hsr-hope'])
  })

  it('does not insert search results into the queue', async () => {
    const player = createPlaybackStore()
    const wrapper = mountLibrary(player)

    await search(wrapper, 'genshin')
    expect(wrapper.findAll('[data-search-tracks] [data-track-row]').length).toBeGreaterThan(1)
    expect(player.queue.value).toEqual([])

    await search(wrapper, 'a')
    expect(player.queue.value).toEqual([])
  })

  it('does not touch the queue when switching album or game', async () => {
    const player = createPlaybackStore()
    player.enqueue(byId('hsr-sway'))
    const before = player.queue.value

    const wrapper = mountLibrary(player)
    await openGames(wrapper)
    await wrapper.get('[data-game-id="genshin"] [data-game-open]').trigger('click')
    await openAlbums(wrapper)
    await albumCard(wrapper, FONTAINE_ALBUM).get('[data-album-open]').trigger('click')
    await wrapper.get('[data-library-back]').trigger('click')

    expect(player.queue.value).toBe(before)
    expect(player.queue.value.map((track) => track.id)).toEqual(['hsr-sway'])
  })

  it('does not touch the queue when switching sections', async () => {
    const player = createPlaybackStore()
    player.enqueue(byId('hsr-hope'))
    const before = player.queue.value

    const wrapper = mountLibrary(player)
    await openGames(wrapper)
    await openAlbums(wrapper)
    await wrapper.get('[data-library-section="all"]').trigger('click')

    expect(player.queue.value).toBe(before)
  })

  it('adds a queue entry from an album view without disturbing the open album', async () => {
    const player = createPlaybackStore()
    const wrapper = mountLibrary(player)

    await openAlbums(wrapper)
    await albumCard(wrapper, INSIDE_ALBUM).get('[data-album-open]').trigger('click')
    await trackRow(wrapper, 'hsr-sway').get('[data-track-enqueue]').trigger('click')

    expect(player.queue.value.map((track) => track.id)).toEqual(['hsr-sway'])
    expect(wrapper.get('[data-active-album-title]').text()).toBe(INSIDE_ALBUM)
  })
})

describe('MusicLibrary — play actions', () => {
  it('hands the exact track to the store for play, queue and play-next', async () => {
    const player = {
      playNow: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(),
      playNext: vi.fn(),
    }
    const wrapper = mountLibrary(player)
    const row = trackRow(wrapper, 'genshin-liyue')
    const expected = byId('genshin-liyue')

    await row.get('[data-track-play]').trigger('click')
    expect(player.playNow).toHaveBeenCalledTimes(1)
    expect(player.playNow).toHaveBeenCalledWith(expected)

    await row.get('[data-track-enqueue]').trigger('click')
    expect(player.enqueue).toHaveBeenCalledTimes(1)
    expect(player.enqueue).toHaveBeenCalledWith(expected)

    await row.get('[data-track-play-next]').trigger('click')
    expect(player.playNext).toHaveBeenCalledTimes(1)
    expect(player.playNext).toHaveBeenCalledWith(expected)
  })

  it('does not act on the player merely by rendering', () => {
    const player = {
      playNow: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(),
      playNext: vi.fn(),
    }
    mountLibrary(player)

    expect(player.playNow).not.toHaveBeenCalled()
    expect(player.enqueue).not.toHaveBeenCalled()
    expect(player.playNext).not.toHaveBeenCalled()
  })
})

describe('MusicLibrary — pagination', () => {
  it('renders one page of All Tracks and extends it on request', async () => {
    const wrapper = mountLibrary(createPlaybackStore(), 'en', largeCatalogue(100))

    expect(wrapper.findAll('[data-library-tracks] [data-track-row]')).toHaveLength(40)
    expect(wrapper.get('[data-library-track-count]').text()).toBe('100 tracks')

    await wrapper.get('[data-library-more-tracks]').trigger('click')
    expect(wrapper.findAll('[data-library-tracks] [data-track-row]')).toHaveLength(80)
  })

  it('reports the true match count while rendering one page of results', async () => {
    const wrapper = mountLibrary(createPlaybackStore(), 'en', largeCatalogue(100))
    await search(wrapper, 'bulk')

    expect(wrapper.get('[data-search-count="tracks"]').text()).toContain('100')
    expect(wrapper.findAll('[data-search-tracks] [data-track-row]')).toHaveLength(40)

    await wrapper.get('[data-search-more-tracks]').trigger('click')
    expect(wrapper.findAll('[data-search-tracks] [data-track-row]')).toHaveLength(80)
  })

  it('restarts at the first page when the query changes', async () => {
    const wrapper = mountLibrary(createPlaybackStore(), 'en', largeCatalogue(100))
    await search(wrapper, 'bulk')
    await wrapper.get('[data-search-more-tracks]').trigger('click')
    expect(wrapper.findAll('[data-search-tracks] [data-track-row]')).toHaveLength(80)

    await search(wrapper, 'bulk track')
    expect(wrapper.findAll('[data-search-tracks] [data-track-row]')).toHaveLength(40)
  })

  it('renders one page of an album that is larger than a page', async () => {
    const wrapper = mountLibrary(createPlaybackStore(), 'en', largeCatalogue(100))
    await openAlbums(wrapper)
    await wrapper.get('[data-album-open]').trigger('click')

    expect(wrapper.findAll('[data-album-tracks] [data-track-row]')).toHaveLength(40)
    await wrapper.get('[data-album-more-tracks]').trigger('click')
    expect(wrapper.findAll('[data-album-tracks] [data-track-row]')).toHaveLength(80)
  })
})

describe('MusicLibrary — accessibility', () => {
  it('gives the search field an accessible name', () => {
    const wrapper = mountLibrary()
    const input = wrapper.get('[data-music-library-search]')

    expect(input.element.closest('label')?.textContent).toContain('Search the music catalogue')
  })

  it('gives every control an accessible name', async () => {
    const wrapper = mountLibrary()
    await openAlbums(wrapper)
    await albumCard(wrapper, LIYUE_ALBUM).get('[data-album-open]').trigger('click')

    for (const button of wrapper.findAll('button')) {
      const name = button.attributes('aria-label') ?? button.text().trim()
      expect(name, `${button.html().slice(0, 80)} has no accessible name`).not.toBe('')
    }
  })

  it('marks the active section with aria-pressed and the others not', async () => {
    const wrapper = mountLibrary()
    expect(wrapper.get('[data-library-section="all"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-library-section="games"]').attributes('aria-pressed')).toBe('false')

    await openGames(wrapper)
    expect(wrapper.get('[data-library-section="all"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.get('[data-library-section="games"]').attributes('aria-pressed')).toBe('true')
  })

  it('names the section switcher group', () => {
    const wrapper = mountLibrary()
    expect(wrapper.get('.music-library__sections').attributes('aria-label')).toBe(
      'Music Library sections',
    )
  })

  it('labels each track action with the track it acts on', () => {
    const wrapper = mountLibrary()
    const row = trackRow(wrapper, 'genshin-liyue')

    expect(row.get('[data-track-play]').attributes('aria-label')).toBe('Play Liyue')
    expect(row.get('[data-track-enqueue]').attributes('aria-label')).toBe('Add Liyue to queue')
    expect(row.get('[data-track-play-next]').attributes('aria-label')).toBe('Play Liyue next')
  })

  it('hides decorative artwork from assistive technology', async () => {
    const wrapper = mountLibrary()
    await openAlbums(wrapper)

    const artwork = wrapper.findAll('[data-album-card] [aria-hidden="true"]')
    expect(artwork).toHaveLength(4)
    for (const node of artwork) {
      expect(node.attributes('style')).toContain('--artwork: linear-gradient')
    }
  })

  it('gives each album a different artwork gradient', async () => {
    const wrapper = mountLibrary()
    await openAlbums(wrapper)

    const gradients = wrapper
      .findAll('[data-album-card] [aria-hidden="true"]')
      .map((node) => node.attributes('style'))
    expect(new Set(gradients).size).toBe(4)
  })

  it('never presents a provider name as library information', async () => {
    // Which provider will eventually serve a track is an implementation detail. It must not
    // appear in the browser, on any surface, in any locale.
    //
    // `r2` is deliberately absent from this list: both characters are hex, so it can occur by
    // chance inside a Vue scope id (`data-v-…`) and the assertion would be flaky rather than
    // meaningful. Every longer provider id is unambiguous.
    const wrapper = mountLibrary()
    await openAlbums(wrapper)
    await wrapper.get('[data-album-open]').trigger('click')
    await search(wrapper, 'genshin')

    // Asset URLs (e.g. /api/providers/jellyfin/artwork/...) legitimately route to the existing
    // image proxy; the assertion guards against leaking provider identities into user-facing
    // library markup or text content.
    const html = wrapper.html().replace(/src="[^"]*"/g, '').toLowerCase()
    for (const provider of ['jellyfin', 'chksz', 'meting', 'invidious', 'piped']) {
      expect(html, `${provider} leaked into the library`).not.toContain(provider)
    }
  })
})
