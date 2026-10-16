/**
 * Persisted browsing position for the Music Library.
 *
 * Remembers which section the user was in and, where it is meaningful, which game and album
 * they had open — so reopening the hub returns them to their place rather than to the top of
 * the catalogue. That is the whole of it: the queue is not here (it has its own store), and
 * the search query is deliberately not persisted, because a query is a momentary intent and
 * restoring one on a later visit would present a filtered catalogue the user did not ask for.
 *
 * Storage is fail-closed in both directions, matching `filterState` and `safeStorage`:
 * a value that does not validate is discarded rather than repaired, and an unavailable
 * `localStorage` degrades to in-memory state without throwing.
 */

import { ref, type Ref } from 'vue'

import { safeLocalStorage, type SafeStorage } from '../../utils/safeStorage'
import { CANONICAL_GAME_IDS } from '../catalog/filterState'
import type { GameId } from '../catalog/types'

export const LIBRARY_BROWSING_STORAGE_KEY = 'study-with-hoyomix.music-library.v1'

/** Sections of the Music Library, in tab order. */
export const LIBRARY_SECTIONS = ['all', 'games', 'albums'] as const

export type LibrarySection = (typeof LIBRARY_SECTIONS)[number]

export interface LibraryBrowsingSnapshot {
  section: LibrarySection
  gameId: GameId | null
  albumId: string | null
}

export interface LibraryBrowsingState {
  readonly section: Readonly<Ref<LibrarySection>>
  readonly gameId: Readonly<Ref<GameId | null>>
  readonly albumId: Readonly<Ref<string | null>>
  setSection(section: LibrarySection): void
  setGame(gameId: GameId | null): void
  setAlbum(albumId: string | null): void
}

/** Album ids are `game:title`; titles are bounded by the catalogue's own 500-char limit. */
const MAX_ID_LENGTH = 512
const controlCharacters = /[\u0000-\u001F\u007F]/u
const gameIds = new Set<string>(CANONICAL_GAME_IDS)

const DEFAULT_SNAPSHOT: LibraryBrowsingSnapshot = { section: 'all', gameId: null, albumId: null }

function isSection(value: unknown): value is LibrarySection {
  return typeof value === 'string' && (LIBRARY_SECTIONS as readonly string[]).includes(value)
}

function isGameId(value: unknown): value is GameId {
  return typeof value === 'string' && gameIds.has(value)
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !controlCharacters.test(value)
  )
}

/**
 * Validate a stored snapshot, discarding the whole record if any field is unusable.
 *
 * Each field is validated on its own terms; there are no cross-field rules. The three are
 * genuinely independent positions — which tab, which game, which album — and a rule such as
 * "an album requires a game" would reject a perfectly usable record for the one album whose
 * tracks the catalogue has not classified, for no benefit.
 *
 * Whole-record rejection rather than field-by-field repair: a partially valid record means
 * the writer was not this version, and guessing which half to keep is how a stale album id
 * ends up pointing at a different album.
 */
export function parseBrowsingSnapshot(value: unknown): LibraryBrowsingSnapshot | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (!isSection(candidate.section)) return undefined
  if (candidate.gameId !== null && candidate.gameId !== undefined && !isGameId(candidate.gameId)) {
    return undefined
  }
  if (
    candidate.albumId !== null &&
    candidate.albumId !== undefined &&
    !isIdentifier(candidate.albumId)
  ) {
    return undefined
  }

  return {
    section: candidate.section,
    gameId: (candidate.gameId ?? null) as GameId | null,
    albumId: (candidate.albumId ?? null) as string | null,
  }
}

function readSnapshot(storage: SafeStorage): LibraryBrowsingSnapshot | undefined {
  try {
    const raw = storage.getItem(LIBRARY_BROWSING_STORAGE_KEY)
    if (!raw) return undefined
    return parseBrowsingSnapshot(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export function createLibraryBrowsingState(
  storage: SafeStorage = safeLocalStorage,
): LibraryBrowsingState {
  const stored = readSnapshot(storage) ?? DEFAULT_SNAPSHOT

  const section = ref<LibrarySection>(stored.section)
  const gameId = ref<GameId | null>(stored.gameId)
  const albumId = ref<string | null>(stored.albumId)

  function persist(): void {
    try {
      storage.setItem(
        LIBRARY_BROWSING_STORAGE_KEY,
        JSON.stringify({
          section: section.value,
          gameId: gameId.value,
          albumId: albumId.value,
        } satisfies LibraryBrowsingSnapshot),
      )
    } catch {
      // Storage can be denied by browser policy; browsing state stays in memory.
    }
  }

  function setSection(next: LibrarySection): void {
    if (!isSection(next) || next === section.value) return
    section.value = next
    persist()
  }

  function setGame(next: GameId | null): void {
    if (next !== null && !isGameId(next)) return
    if (next === gameId.value) return
    gameId.value = next
    persist()
  }

  function setAlbum(next: string | null): void {
    if (next !== null && !isIdentifier(next)) return
    if (next === albumId.value) return
    albumId.value = next
    persist()
  }

  return { section, gameId, albumId, setSection, setGame, setAlbum }
}
