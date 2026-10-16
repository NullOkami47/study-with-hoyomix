import { computed, readonly, ref, shallowRef, type ComputedRef, type Ref } from 'vue'

import { CatalogRepository } from './repository'
import type { GameId, TabId, Track } from './types'
import { safeLocalStorage, type SafeStorage } from '../../utils/safeStorage'

export const CATALOG_FILTER_STORAGE_KEY_V2 = 'study-with-hoyomix.catalog-filters.v2'
export const CATALOG_FILTER_STORAGE_KEY_V1 = 'study-with-hoyomix.catalog-filters.v1'
export type MusicMode = TabId | null

/**
 * Every game the catalogue knows, in top-bar order. A first visit selects all of
 * them so the pressed state of the three top-bar buttons always describes what the
 * query actually restricts. The repository reads an empty game list as "no game
 * restriction", so an empty selection and a full one return the same tracks while
 * showing opposite pressed states; the full selection is the honest one to present.
 */
export const CANONICAL_GAME_IDS: readonly GameId[] = ['genshin', 'hsr', 'zzz']

/**
 * The user-selectable filter dimensions. `classification` and `workGroupIds` were
 * retired as user-facing filters; the underlying `Track.workGroupId` /
 * `Track.needsClassification` catalogue metadata is still produced, validated and
 * consumed by the catalogue pipeline, so only the filter dimension is gone here.
 */
export interface CatalogFilterState {
  search: Readonly<Ref<string>>
  games: Readonly<Ref<readonly GameId[]>>
  mode: Readonly<Ref<MusicMode>>
  relationIds: Readonly<Ref<readonly string[]>>
  filteredTracks: ComputedRef<Track[]>
  replaceTracks(tracks: Track[]): void
  setSearch(search: string): void
  toggleGame(game: GameId): void
  setMode(mode: MusicMode): void
  toggleRelation(relationId: string): void
}

interface FilterSnapshot {
  search: string
  games: GameId[]
  mode: MusicMode
  relationIds: string[]
}

interface StoredSnapshot {
  migrated: boolean
  snapshot: FilterSnapshot
}

interface ValidatedSnapshot {
  serialized: string
  snapshot: FilterSnapshot
}

const gameIds = new Set<GameId>(['genshin', 'hsr', 'zzz'])
const tabIds = new Set<TabId>(['sleep', 'focus', 'chill'])
const legacyTabIds = new Set(['sleep', 'focus', 'chat'])
const snapshotKeys = ['search', 'games', 'mode', 'relationIds']
/**
 * The v2 record written before the classification and work-group filters were retired.
 * Such a record is still read, but its two retired dimensions are dropped instead of
 * validated: the remaining preferences survive the upgrade, no phantom active filter is
 * reported, and the next write persists the current four-key shape.
 */
const retiredSnapshotKeys = ['search', 'games', 'mode', 'relationIds', 'workGroupIds', 'classification']
const legacySnapshotKeys = ['search', 'games', 'tabs', 'relationIds', 'workGroupIds', 'classification']
const controlCharacters = /[\u0000-\u001F\u007F]/u
const MAX_RAW_LENGTH = 32_768
const MAX_SEARCH_LENGTH = 256
const MAX_OPTION_LENGTH = 256

function initialSnapshot(): FilterSnapshot {
  return { search: '', games: [...CANONICAL_GAME_IDS], mode: null, relationIds: [] }
}

/**
 * Migrates a v1 snapshot written before games defaulted to all three. Such a
 * snapshot stores `games: []`, which left every top-bar button unpressed while the
 * query still returned every game. Canonicalising to the full selection preserves
 * exactly the tracks those users already saw and makes the buttons tell the truth.
 *
 * This changes only games. A null music mode remains unrestricted; modes must
 * never be inferred from the selected games or from available track tags.
 */
function canonicaliseGames(snapshot: FilterSnapshot): FilterSnapshot {
  return snapshot.games.length > 0 ? snapshot : { ...snapshot, games: [...CANONICAL_GAME_IDS] }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
}

function isExactSnapshotShape(value: unknown, keys: readonly string[] = snapshotKeys): value is Record<string, unknown> {
  return isPlainObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isSelection(value: unknown, allowed: ReadonlySet<string>, maximum: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maximum
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_OPTION_LENGTH && allowed.has(item))
    && new Set(value).size === value.length
}

function validateSnapshot(value: unknown, relationIds: ReadonlySet<string>): FilterSnapshot | undefined {
  if (!isExactSnapshotShape(value)) return undefined
  if (typeof value.search !== 'string' || value.search.length > MAX_SEARCH_LENGTH || controlCharacters.test(value.search)) return undefined
  if (!isSelection(value.games, gameIds, gameIds.size)) return undefined
  if (value.mode !== null && !tabIds.has(value.mode as TabId)) return undefined
  if (!isSelection(value.relationIds, relationIds, MAX_OPTION_LENGTH)) return undefined

  return {
    search: value.search,
    games: [...value.games] as GameId[],
    mode: value.mode as MusicMode,
    relationIds: [...value.relationIds],
  }
}

function validateCandidate(value: unknown, relationIds: ReadonlySet<string>): ValidatedSnapshot | undefined {
  const snapshot = validateSnapshot(value, relationIds)
  if (!snapshot) return undefined
  const serialized = JSON.stringify(snapshot)
  return serialized.length <= MAX_RAW_LENGTH ? { snapshot, serialized } : undefined
}

/**
 * Reads a current-shape v2 record, or the retired shape written before classification
 * and work groups were removed. Only the four retained dimensions are validated; the
 * retired values are discarded so an old record degrades to exactly the filters the
 * user can still see and change.
 */
function readV2Snapshot(value: unknown, relationIds: ReadonlySet<string>): StoredSnapshot | undefined {
  const current = validateSnapshot(value, relationIds)
  if (current) return { migrated: false, snapshot: current }
  if (!isExactSnapshotShape(value, retiredSnapshotKeys)) return undefined

  const retained = validateSnapshot({
    search: value.search,
    games: value.games,
    mode: value.mode,
    relationIds: value.relationIds,
  }, relationIds)
  return retained ? { migrated: true, snapshot: retained } : undefined
}

/** Validate the complete old shape before converting only its music-mode field. */
function migrateV1Snapshot(value: unknown, relationIds: ReadonlySet<string>): StoredSnapshot | undefined {
  if (!isExactSnapshotShape(value, legacySnapshotKeys)) return undefined
  if (!isSelection(value.tabs, legacyTabIds, legacyTabIds.size)) return undefined
  const [tab] = value.tabs
  const mode = value.tabs.length === 1 ? (tab === 'chat' ? 'chill' : tab) : null
  const snapshot = validateSnapshot({
    search: value.search,
    games: value.games,
    mode,
    relationIds: value.relationIds,
  }, relationIds)
  return snapshot ? { migrated: true, snapshot } : undefined
}

/**
 * A present v2 record is authoritative, even if invalid: never revive stale v1
 * preferences after v2 corruption. Only an absent v2 permits a validated v1
 * migration. Invalid data stays untouched and the whole state uses safe defaults.
 */
function readSnapshot(
  storage: SafeStorage,
  relationIds: ReadonlySet<string>
): { migrated: boolean; valid: boolean; snapshot: FilterSnapshot } {
  const fallback = { migrated: false, valid: false, snapshot: initialSnapshot() }
  try {
    const rawV2 = storage.getItem(CATALOG_FILTER_STORAGE_KEY_V2)
    const fromV1 = rawV2 === null
    const raw = fromV1 ? storage.getItem(CATALOG_FILTER_STORAGE_KEY_V1) : rawV2
    if (raw === null || raw.length > MAX_RAW_LENGTH) return fallback

    const parsed: unknown = JSON.parse(raw)
    const stored = fromV1
      ? migrateV1Snapshot(parsed, relationIds)
      : readV2Snapshot(parsed, relationIds)
    if (!stored) return fallback

    const canonical = canonicaliseGames(stored.snapshot)
    // Filling legacy empty games grows the serialised record. Recheck the entire
    // candidate so restored refs, query results and persistence cannot disagree.
    const validated = validateCandidate(canonical, relationIds)
    if (!validated) return fallback
    return { migrated: stored.migrated || canonical !== stored.snapshot, valid: true, snapshot: validated.snapshot }
  } catch {
    return fallback
  }
}

function toggled<T extends string>(selected: T[], value: T): T[] {
  return selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]
}

export function createCatalogFilterState(tracks: Track[], storage: SafeStorage = safeLocalStorage): CatalogFilterState {
  const relationOptionIds = new Set(tracks.flatMap((track) => track.relationIds))
  const { migrated, snapshot: initial } = readSnapshot(storage, relationOptionIds)
  const repository = shallowRef(new CatalogRepository(tracks))
  const search = ref(initial.search)
  const games = ref<GameId[]>(initial.games)
  const mode = ref<MusicMode>(initial.mode)
  const relationIds = ref(initial.relationIds)
  let userEditedBeforeReplacement = false

  function currentCandidate(): ValidatedSnapshot | undefined {
    return validateCandidate({
      search: search.value,
      games: games.value,
      mode: mode.value,
      relationIds: relationIds.value,
    }, relationOptionIds)
  }

  function persist(serialized: string): void {
    try {
      storage.setItem(CATALOG_FILTER_STORAGE_KEY_V2, serialized)
    } catch {
      // Storage is optional; filtering remains memory-only when any write fails.
    }
  }

  function apply(candidate: unknown): void {
    const validated = validateCandidate(candidate, relationOptionIds)
    if (!validated) return
    const { snapshot } = validated
    search.value = snapshot.search
    games.value = snapshot.games
    mode.value = snapshot.mode
    relationIds.value = snapshot.relationIds
    persist(validated.serialized)
  }

  // A canonicalised legacy record is written back once, so the next visit reads a
  // snapshot that already agrees with the pressed state it will render.
  if (migrated) {
    const canonical = currentCandidate()
    if (canonical) persist(canonical.serialized)
  }

  const filteredTracks = computed(() => {
    const { mode, ...query } = currentCandidate()?.snapshot ?? initialSnapshot()
    return repository.value.query({ ...query, tabs: mode ? [mode] : [] })
  })

  function update(updateSnapshot: (snapshot: FilterSnapshot) => FilterSnapshot): void {
    const candidate = currentCandidate()
    if (candidate) {
      userEditedBeforeReplacement = true
      apply(updateSnapshot(candidate.snapshot))
    }
  }

  return {
    search: readonly(search), games: readonly(games), mode: readonly(mode), relationIds: readonly(relationIds), filteredTracks,
    replaceTracks: (nextTracks) => {
      const nextRepository = new CatalogRepository(nextTracks)
      const previous = currentCandidate()?.snapshot ?? initialSnapshot()
      relationOptionIds.clear()
      for (const track of nextTracks) {
        track.relationIds.forEach(id => relationOptionIds.add(id))
      }
      // A bundled catalogue may omit a saved relation that exists in the published
      // catalogue. Revalidate the original persisted snapshot against the complete
      // option set before replacing it, unless the listener edited filters.
      const saved = readSnapshot(storage, relationOptionIds)
      const restored = !userEditedBeforeReplacement && saved.valid ? saved.snapshot : previous
      apply({ ...restored, relationIds: restored.relationIds.filter(id => relationOptionIds.has(id)) })
      repository.value = nextRepository
    },
    setSearch: (value) => update((snapshot) => ({ ...snapshot, search: value })),
    // Clearing the last game is refused rather than silently widened back to every
    // game: an empty selection shows three unpressed buttons above an unfiltered
    // track list, which reads as "nothing included" while including everything.
    toggleGame: (game) => {
      if (!gameIds.has(game)) return
      if (games.value.length === 1 && games.value[0] === game) return
      update((snapshot) => ({ ...snapshot, games: toggled(snapshot.games, game) }))
    },
    setMode: (value) => { if (value === null || tabIds.has(value)) update((snapshot) => ({ ...snapshot, mode: value })) },
    toggleRelation: (relationId) => { if (relationOptionIds.has(relationId)) update((snapshot) => ({ ...snapshot, relationIds: toggled(snapshot.relationIds, relationId) })) },
  }
}
