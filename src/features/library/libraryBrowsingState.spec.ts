import { describe, expect, it, vi } from 'vitest'

import type { SafeStorage } from '../../utils/safeStorage'
import {
  createLibraryBrowsingState,
  LIBRARY_BROWSING_STORAGE_KEY,
  parseBrowsingSnapshot,
} from './libraryBrowsingState'

function memoryStorage(initial?: string): SafeStorage & { value: () => string | null } {
  let stored: string | null = initial ?? null
  return {
    getItem: (key) => (key === LIBRARY_BROWSING_STORAGE_KEY ? stored : null),
    setItem: (key, value) => {
      if (key === LIBRARY_BROWSING_STORAGE_KEY) stored = value
    },
    removeItem: (key) => {
      if (key === LIBRARY_BROWSING_STORAGE_KEY) stored = null
    },
    value: () => stored,
  }
}

const ALBUM = 'genshin:Genshin Impact - Fountain of Belleau (Original Game Soundtrack)'

describe('library browsing state', () => {
  it('starts on All Tracks with nothing open', () => {
    const state = createLibraryBrowsingState(memoryStorage())
    expect(state.section.value).toBe('all')
    expect(state.gameId.value).toBeNull()
    expect(state.albumId.value).toBeNull()
  })

  it('remembers the section, game and album across sessions', () => {
    const storage = memoryStorage()
    const first = createLibraryBrowsingState(storage)
    first.setSection('albums')
    first.setGame('genshin')
    first.setAlbum(ALBUM)

    const restored = createLibraryBrowsingState(storage)
    expect(restored.section.value).toBe('albums')
    expect(restored.gameId.value).toBe('genshin')
    expect(restored.albumId.value).toBe(ALBUM)
  })

  it('does not persist the search query', () => {
    const storage = memoryStorage()
    const state = createLibraryBrowsingState(storage)
    state.setSection('games')
    state.setGame('hsr')

    // The stored record is exactly these three keys — a query would have to appear here to
    // survive a reload, which is the property being asserted.
    expect(JSON.parse(storage.value()!)).toEqual({
      section: 'games',
      gameId: 'hsr',
      albumId: null,
    })
  })

  it('remembers each position independently', () => {
    const state = createLibraryBrowsingState(memoryStorage())
    state.setSection('albums')
    state.setGame('genshin')
    state.setAlbum(ALBUM)

    // Switching tab, game or album must not silently discard the others: the three are
    // separate positions, and each tab is expected to remember where it was left.
    state.setGame('hsr')
    expect(state.albumId.value).toBe(ALBUM)
    expect(state.section.value).toBe('albums')

    state.setSection('all')
    expect(state.gameId.value).toBe('hsr')
    expect(state.albumId.value).toBe(ALBUM)
  })

  it('ignores unknown values instead of storing them', () => {
    const state = createLibraryBrowsingState(memoryStorage())
    state.setSection('nope' as never)
    state.setGame('honkai-impact' as never)
    state.setAlbum('')

    expect(state.section.value).toBe('all')
    expect(state.gameId.value).toBeNull()
    expect(state.albumId.value).toBeNull()
  })
})

describe('parseBrowsingSnapshot', () => {
  it('accepts a well-formed record', () => {
    expect(parseBrowsingSnapshot({ section: 'albums', gameId: 'zzz', albumId: 'zzz:极限委托' })).toEqual({
      section: 'albums',
      gameId: 'zzz',
      albumId: 'zzz:极限委托',
    })
  })

  it('accepts an album whose tracks the catalogue has not classified', () => {
    // Possible whenever a track has no game. The album is real even though no game is set.
    expect(parseBrowsingSnapshot({ section: 'albums', gameId: null, albumId: 'none:Unclassified' })).toEqual({
      section: 'albums',
      gameId: null,
      albumId: 'none:Unclassified',
    })
  })

  it('accepts a record that omits the optional positions', () => {
    expect(parseBrowsingSnapshot({ section: 'all' })).toEqual({
      section: 'all',
      gameId: null,
      albumId: null,
    })
  })

  it.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['a missing section', { gameId: null, albumId: null }],
    ['an unknown section', { section: 'queue', gameId: null, albumId: null }],
    ['an unknown game', { section: 'games', gameId: 'honkai', albumId: null }],
    ['a non-string album', { section: 'albums', gameId: 'genshin', albumId: 7 }],
    ['an empty album id', { section: 'albums', gameId: 'genshin', albumId: '' }],
    ['a control character in the album id', { section: 'albums', gameId: 'genshin', albumId: 'a\u0000b' }],
    ['an over-long album id', { section: 'albums', gameId: 'genshin', albumId: 'x'.repeat(513) }],
  ])('rejects %s', (_label, value) => {
    expect(parseBrowsingSnapshot(value)).toBeUndefined()
  })

  it('rejects a corrupt stored record and falls back to the default', () => {
    const state = createLibraryBrowsingState(memoryStorage('{ not json'))
    expect(state.section.value).toBe('all')
    expect(state.gameId.value).toBeNull()
  })

  it('rejects a stored record that is valid JSON but not a valid snapshot', () => {
    const state = createLibraryBrowsingState(memoryStorage(JSON.stringify({ section: 'queue' })))
    expect(state.section.value).toBe('all')
  })
})

describe('library browsing state — storage failure', () => {
  it('keeps working in memory when storage is denied', () => {
    const denied: SafeStorage = {
      getItem: () => {
        throw Object.assign(new Error('denied'), { name: 'SecurityError' })
      },
      setItem: () => {
        throw Object.assign(new Error('denied'), { name: 'SecurityError' })
      },
      removeItem: vi.fn(),
    }

    const state = createLibraryBrowsingState(denied)
    expect(() => state.setSection('albums')).not.toThrow()
    expect(state.section.value).toBe('albums')
  })

  it('does not throw when the writer rejects the value', () => {
    const failing: SafeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
      removeItem: vi.fn(),
    }

    const state = createLibraryBrowsingState(failing)
    expect(() => state.setGame('genshin')).not.toThrow()
    expect(state.gameId.value).toBe('genshin')
  })
})
