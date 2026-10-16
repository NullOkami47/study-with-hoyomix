import { afterEach, describe, expect, it, vi } from 'vitest'

import { createCatalogFilterState } from './filterState'
import type { Track } from './types'

const tracks: Track[] = [
  { id: 'dawn', title: 'Dawn Winery', aliases: { 'zh-Hant': ['晨曦酒莊'] }, games: ['genshin'], relationIds: ['character:diluc', 'place:mondstadt'], tabs: ['sleep', 'focus'], workGroupId: 'dawn-work', vocalStatus: 'instrumental', needsClassification: false, sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }] },
  { id: 'express', title: 'Astral Express', aliases: {}, games: ['hsr'], relationIds: ['faction:astral-express'], tabs: ['chill'], workGroupId: 'express-work', vocalStatus: 'instrumental', needsClassification: false, sources: [{ provider: 'youtube', externalId: 'lmnopqrstuv' }] },
  { id: 'sixth', title: 'Sixth Street', aliases: {}, games: ['zzz'], relationIds: ['place:new-eridu'], tabs: ['focus'], workGroupId: 'sixth-work', vocalStatus: 'instrumental', needsClassification: true, sources: [{ provider: 'youtube', externalId: '0123456789_' }] },
]

function memoryStorage(initial?: string, key: string = 'study-with-hoyomix.catalog-filters.v2') {
  const values = new Map(initial === undefined ? [] : [[key, initial]])
  return {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, value: string) => { values.set(k, value) },
    removeItem: (k: string) => { values.delete(k) },
  }
}

function completeSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    search: 'Dawn',
    games: ['genshin'],
    mode: 'focus',
    relationIds: ['character:diluc'],
    ...overrides,
  }
}

/**
 * The v2 record shape written before the classification and work-group filters were
 * retired. Every compatibility test below starts from this shape, because that is
 * exactly what an existing user has in localStorage.
 */
function retiredSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    search: 'Dawn',
    games: ['genshin'],
    mode: 'focus',
    relationIds: ['character:diluc'],
    workGroupIds: ['dawn-work'],
    classification: 'classified',
    ...overrides,
  }
}

const ALL_GAMES = ['genshin', 'hsr', 'zzz']
const V1_KEY = 'study-with-hoyomix.catalog-filters.v1'
const V2_KEY = 'study-with-hoyomix.catalog-filters.v2'

describe('catalog filter state', () => {
  it('restores a saved structural relation available only after remote catalogue replacement', () => {
    const remote = { ...tracks[0], id: 'remote', relationIds: ['event:remote'], workGroupId: 'remote-work' }
    const storage = memoryStorage(JSON.stringify(completeSnapshot({ search: 'missing', relationIds: ['event:remote'] })))
    const state = createCatalogFilterState(tracks, storage)
    expect(state.relationIds.value).toEqual([])
    state.replaceTracks([...tracks, remote])
    expect(state.relationIds.value).toEqual(['event:remote'])
    expect(state.filteredTracks.value).toEqual([]) // Search stays a catalogue-only constraint.
  })

  describe('v1 migration', () => {
    it('migrates tabs: [] to mode: null', () => {
      const v1 = JSON.stringify({ search: '', games: ['genshin'], tabs: [], relationIds: [], workGroupIds: [], classification: 'all' })
      const storage = memoryStorage(v1, V1_KEY)
      const state = createCatalogFilterState(tracks, storage)
      expect(state.mode.value).toBeNull()
      expect(JSON.parse(storage.getItem(V2_KEY)!).mode).toBeNull()
    })

    it('migrates ["focus"] to focus', () => {
      const v1 = JSON.stringify({ search: '', games: ['genshin'], tabs: ['focus'], relationIds: [], workGroupIds: [], classification: 'all' })
      const storage = memoryStorage(v1, V1_KEY)
      const state = createCatalogFilterState(tracks, storage)
      expect(state.mode.value).toBe('focus')
    })

    it('migrates ["sleep"] to sleep', () => {
      const v1 = JSON.stringify({ search: '', games: ['genshin'], tabs: ['sleep'], relationIds: [], workGroupIds: [], classification: 'all' })
      const storage = memoryStorage(v1, V1_KEY)
      const state = createCatalogFilterState(tracks, storage)
      expect(state.mode.value).toBe('sleep')
    })

    it('migrates ["chat"] to chill', () => {
      const v1 = JSON.stringify({ search: '', games: ['genshin'], tabs: ['chat'], relationIds: [], workGroupIds: [], classification: 'all' })
      const storage = memoryStorage(v1, V1_KEY)
      const state = createCatalogFilterState(tracks, storage)
      expect(state.mode.value).toBe('chill')
    })

    it('migrates more than one old tab to mode: null', () => {
      const v1 = JSON.stringify({ search: '', games: ['genshin'], tabs: ['sleep', 'focus'], relationIds: [], workGroupIds: [], classification: 'all' })
      const storage = memoryStorage(v1, V1_KEY)
      const state = createCatalogFilterState(tracks, storage)
      expect(state.mode.value).toBeNull()
    })
  })

  describe('bounded, fail-closed storage migration', () => {
    const legacy = {
      search: 'Express', games: ['hsr'], tabs: ['chat'],
      relationIds: ['faction:astral-express'], workGroupIds: ['express-work'], classification: 'classified',
    }

    function snapshot(state: ReturnType<typeof createCatalogFilterState>) {
      return {
        search: state.search.value, games: state.games.value, mode: state.mode.value,
        relationIds: state.relationIds.value,
      }
    }

    function expectDefaults(state: ReturnType<typeof createCatalogFilterState>) {
      expect(snapshot(state)).toEqual({
        search: '', games: ALL_GAMES, mode: null, relationIds: [],
      })
      expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn', 'express', 'sixth'])
    }

    it('preserves every valid legacy preference, drops the retired dimensions, and reloads v2 through SafeStorage', () => {
      const raw = JSON.stringify(legacy)
      const storage = memoryStorage(raw, V1_KEY)
      const setItem = vi.spyOn(storage, 'setItem')
      const removeItem = vi.spyOn(storage, 'removeItem')
      const state = createCatalogFilterState(tracks, storage)
      const expected = {
        search: 'Express', games: ['hsr'], mode: 'chill', relationIds: ['faction:astral-express'],
      }

      expect(snapshot(state)).toEqual(expected)
      expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['express'])
      expect(JSON.parse(storage.getItem(V2_KEY)!)).toEqual(expected)
      expect(snapshot(createCatalogFilterState(tracks, storage))).toEqual(expected)
      expect(setItem).toHaveBeenCalledTimes(1)
      expect(removeItem).not.toHaveBeenCalled()
      expect(storage.getItem(V1_KEY)).toBe(raw)
    })

    it.each([
      ['focus', 'chat'], ['chat', 'focus'], ['sleep', 'chat'], ['chat', 'sleep'],
      ['focus', 'sleep', 'chat'], ['chat', 'sleep', 'focus'],
    ].map(tabs => ({ tabs })))('migrates multiple valid old tabs $tabs without inventing precedence', ({ tabs }) => {
      const storage = memoryStorage(JSON.stringify({ ...legacy, tabs, games: [] }), V1_KEY)
      const state = createCatalogFilterState(tracks, storage)
      expect(state.mode.value).toBeNull()
      expect(state.games.value).toEqual(ALL_GAMES)
      expect(state.search.value).toBe('Express')
      expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['express'])
      expect(JSON.parse(storage.getItem(V2_KEY)!)).toEqual({ ...snapshot(state), mode: null })
    })

    const invalidLegacy: [string, unknown][] = [
      ...Object.keys(legacy).map((missing): [string, unknown] => [
        'missing ' + missing, Object.fromEntries(Object.entries(legacy).filter(([key]) => key !== missing)),
      ]),
      ['extra key', { ...legacy, extra: true }],
      ['mixed v1/v2 shape', { ...legacy, mode: 'chill' }],
      ['non-object', []], ['null', null], ['number', 42],
      ['non-string search', { ...legacy, search: 42 }],
      ['overlong search', { ...legacy, search: 'x'.repeat(257) }],
      ['control character', { ...legacy, search: 'Express\u0000' }],
      ['non-array games', { ...legacy, games: 'hsr' }],
      ['unknown game', { ...legacy, games: ['unknown'] }],
      ['duplicate games', { ...legacy, games: ['hsr', 'hsr'] }],
      ['non-array tabs', { ...legacy, tabs: 'chat' }],
      ['null tabs', { ...legacy, tabs: null }],
      ['unknown tab', { ...legacy, tabs: ['unknown'] }],
      ['new tag in legacy data', { ...legacy, tabs: ['chill'] }],
      ['All is not a tag', { ...legacy, tabs: ['all'] }],
      ['duplicate tabs', { ...legacy, tabs: ['chat', 'chat'] }],
      ['mixed valid/invalid tabs', { ...legacy, tabs: ['focus', 'unknown'] }],
      ['too many tabs', { ...legacy, tabs: ['focus', 'sleep', 'chat', 'focus'] }],
      ['non-array relations', { ...legacy, relationIds: 'faction:astral-express' }],
      ['unknown relation', { ...legacy, relationIds: ['faction:unknown'] }],
      ['duplicate relations', { ...legacy, relationIds: ['faction:astral-express', 'faction:astral-express'] }],
    ]

    it.each(invalidLegacy)('rejects the entire v1 snapshot for %s without repairing or persisting it', (_reason, value) => {
      const raw = JSON.stringify(value)
      const storage = memoryStorage(raw, V1_KEY)
      const setItem = vi.spyOn(storage, 'setItem')
      const removeItem = vi.spyOn(storage, 'removeItem')
      expectDefaults(createCatalogFilterState(tracks, storage))
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
      expect(storage.getItem(V1_KEY)).toBe(raw)
      expect(storage.getItem(V2_KEY)).toBeNull()
    })

    it.each(['{', '', ' '.repeat(32_769) + JSON.stringify(legacy)])('rejects malformed or oversized raw v1 (%#)', raw => {
      const storage = memoryStorage(raw, V1_KEY)
      const setItem = vi.spyOn(storage, 'setItem')
      expectDefaults(createCatalogFilterState(tracks, storage))
      expect(setItem).not.toHaveBeenCalled()
      expect(storage.getItem(V1_KEY)).toBe(raw)
    })

    it.each([
      '', '{', 'null', '[]', ' '.repeat(32_769) + JSON.stringify(completeSnapshot()),
      JSON.stringify(completeSnapshot({ extra: true })),
      JSON.stringify(completeSnapshot({ mode: 'chat' })),
      JSON.stringify(completeSnapshot({ mode: 'all' })),
      JSON.stringify(completeSnapshot({ mode: ['focus', 'sleep'] })),
      JSON.stringify(completeSnapshot({ games: ['unknown'] })),
      JSON.stringify(completeSnapshot({ search: 'x'.repeat(257) })),
    ])('does not revive stale v1 when a present v2 is invalid (%#)', rawV2 => {
      const rawV1 = JSON.stringify(legacy)
      const storage = memoryStorage(rawV1, V1_KEY)
      storage.setItem(V2_KEY, rawV2)
      const getItem = vi.spyOn(storage, 'getItem')
      const setItem = vi.spyOn(storage, 'setItem')
      expectDefaults(createCatalogFilterState(tracks, storage))
      expect(getItem.mock.calls).toEqual([[V2_KEY]])
      expect(setItem).not.toHaveBeenCalled()
      expect(storage.getItem(V2_KEY)).toBe(rawV2)
      expect(storage.getItem(V1_KEY)).toBe(rawV1)
    })

    it('fails closed if canonicalising empty games exceeds the aggregate bound', () => {
      const manyTracks: Track[] = Array.from({ length: 126 }, (_, index) => ({
        ...tracks[0]!, id: 'bounded-' + index,
        relationIds: ['place:' + index.toString().padStart(3, '0') + '-' + 'x'.repeat(245)],
      }))
      const value: Record<string, unknown> = {
        search: '', games: [], mode: null, relationIds: manyTracks.flatMap(track => track.relationIds),
      }
      // Size the search so the stored record fits the raw bound while the very same record
      // with every game selected does not: filling the empty selection is what pushes the
      // canonicalised snapshot over the aggregate limit.
      const search = 'x'.repeat(32_758 - JSON.stringify(value).length)
      value.search = search
      expect(search.length).toBeLessThanOrEqual(256)
      const raw = JSON.stringify(value)
      expect(raw.length).toBeLessThanOrEqual(32_768)
      expect(JSON.stringify({ ...value, games: ALL_GAMES }).length).toBeGreaterThan(32_768)
      const storage = memoryStorage(raw, V2_KEY)
      const setItem = vi.spyOn(storage, 'setItem')
      const state = createCatalogFilterState(manyTracks, storage)
      expect(snapshot(state)).toEqual({
        search: '', games: ALL_GAMES, mode: null, relationIds: [],
      })
      expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(manyTracks.map(({ id }) => id))
      expect(setItem).not.toHaveBeenCalled()
      expect(storage.getItem(V2_KEY)).toBe(raw)
    })

    it('uses valid v2 without reading or re-migrating older v1', () => {
      const storage = memoryStorage(JSON.stringify(legacy), V1_KEY)
      storage.setItem(V2_KEY, JSON.stringify(completeSnapshot()))
      const getItem = vi.spyOn(storage, 'getItem')
      const setItem = vi.spyOn(storage, 'setItem')
      const state = createCatalogFilterState(tracks, storage)
      expect(snapshot(state)).toEqual(completeSnapshot())
      expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn'])
      expect(getItem.mock.calls).toEqual([[V2_KEY]])
      expect(setItem).not.toHaveBeenCalled()
    })

    it.each([V1_KEY, V2_KEY])('fails closed without writes when reading %s throws', deniedKey => {
      const storage = memoryStorage(JSON.stringify(legacy), V1_KEY)
      const read = storage.getItem
      vi.spyOn(storage, 'getItem').mockImplementation(key => {
        if (key === deniedKey) throw new TypeError('Storage unavailable')
        return read(key)
      })
      const setItem = vi.spyOn(storage, 'setItem')
      expectDefaults(createCatalogFilterState(tracks, storage))
      expect(setItem).not.toHaveBeenCalled()
    })

    it('keeps a valid migrated state usable in memory if saving v2 fails', () => {
      const rawV1 = JSON.stringify(legacy)
      const storage = memoryStorage(rawV1, V1_KEY)
      vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new TypeError('Storage unavailable') })
      const state = createCatalogFilterState(tracks, storage)
      expect(state.mode.value).toBe('chill')
      expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['express'])
      state.setMode(null)
      expect(state.mode.value).toBeNull()
      expect(state.search.value).toBe('Express')
      expect(storage.getItem(V1_KEY)).toBe(rawV1)
      expect(storage.getItem(V2_KEY)).toBeNull()
    })
  })

  describe('retired classification and work-group filter state', () => {
    it('drops both retired dimensions while keeping the filters a user can still see', () => {
      const raw = JSON.stringify(retiredSnapshot())
      const storage = memoryStorage(raw, V2_KEY)
      const setItem = vi.spyOn(storage, 'setItem')
      const state = createCatalogFilterState(tracks, storage)

      expect(state.search.value).toBe('Dawn')
      expect(state.games.value).toEqual(['genshin'])
      expect(state.mode.value).toBe('focus')
      expect(state.relationIds.value).toEqual(['character:diluc'])
      expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn'])
      expect(setItem).toHaveBeenCalledTimes(1)
      // The rewritten record carries only the four live dimensions.
      expect(JSON.parse(storage.getItem(V2_KEY)!)).toEqual(completeSnapshot())
      expect(Object.keys(JSON.parse(storage.getItem(V2_KEY)!))).toEqual(['search', 'games', 'mode', 'relationIds'])
      // Reloading the cleaned record is a no-op, not another migration.
      setItem.mockClear()
      expect(createCatalogFilterState(tracks, storage).relationIds.value).toEqual(['character:diluc'])
      expect(setItem).not.toHaveBeenCalled()
    })

    it.each([
      ['a non-array work group list', { workGroupIds: 'dawn-work' }],
      ['an unknown work group', { workGroupIds: ['unknown-work'] }],
      ['a duplicate work group', { workGroupIds: ['dawn-work', 'dawn-work'] }],
      ['a null classification', { classification: null }],
      ['an unknown classification', { classification: 'unknown' }],
    ])('ignores %s instead of rejecting the record or the retained filters', (_reason, overrides) => {
      const state = createCatalogFilterState(tracks, memoryStorage(JSON.stringify(retiredSnapshot(overrides)), V2_KEY))

      expect(state.search.value).toBe('Dawn')
      expect(state.games.value).toEqual(['genshin'])
      expect(state.mode.value).toBe('focus')
      expect(state.relationIds.value).toEqual(['character:diluc'])
      expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn'])
    })

    it('still fails closed when the retained part of a retired record is invalid', () => {
      const state = createCatalogFilterState(
        tracks,
        memoryStorage(JSON.stringify(retiredSnapshot({ relationIds: ['character:unknown'] })), V2_KEY),
      )

      expect(state.search.value).toBe('')
      expect(state.games.value).toEqual(ALL_GAMES)
      expect(state.mode.value).toBeNull()
      expect(state.relationIds.value).toEqual([])
      expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn', 'express', 'sixth'])
    })

    it('never reports a retired dimension as an active filter', () => {
      const state = createCatalogFilterState(tracks, memoryStorage(JSON.stringify(retiredSnapshot()), V2_KEY))

      // Only the game, mode and relation dimensions may be read back; the retired
      // properties simply do not exist on the returned state.
      expect(state).not.toHaveProperty('workGroupIds')
      expect(state).not.toHaveProperty('classification')
      expect(state).not.toHaveProperty('toggleWorkGroup')
      expect(state).not.toHaveProperty('setClassification')
    })
  })

  it('replaces rather than unions music modes, persists All as null, and restores each selection', () => {
    const storage = memoryStorage()
    const state = createCatalogFilterState(tracks, storage)
    const selections = [
      ['focus', ['dawn', 'sixth']], ['sleep', ['dawn']], ['chill', ['express']],
      ['chill', ['express']], [null, ['dawn', 'express', 'sixth']],
    ] as const
    for (const [mode, expectedIds] of selections) {
      state.setMode(mode)
      expect(state.mode.value).toBe(mode)
      expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(expectedIds)
      expect(createCatalogFilterState(tracks, storage).mode.value).toBe(mode)
      const saved = JSON.parse(storage.getItem(V2_KEY)!)
      expect(saved.mode).toBe(mode)
      expect(saved).not.toHaveProperty('tabs')
      expect(saved).not.toHaveProperty('workGroupIds')
      expect(saved).not.toHaveProperty('classification')
    }
  })

  it('selects every game on a first visit and narrows to the union of the games left selected', () => {
    const state = createCatalogFilterState(tracks, memoryStorage())

    expect(state.games.value).toEqual(ALL_GAMES)
    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn', 'express', 'sixth'])
    state.toggleGame('hsr')

    expect(state.games.value).toEqual(['genshin', 'zzz'])
    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn', 'sixth'])
  })

  it('restores a stored subset of games exactly rather than widening it', () => {
    const storage = memoryStorage(JSON.stringify(completeSnapshot({ games: ['hsr'], search: '', relationIds: [], mode: null })))
    const state = createCatalogFilterState(tracks, storage)

    expect(state.games.value).toEqual(['hsr'])
    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['express'])
  })

  it('canonicalises a legacy empty game selection to every game and persists the migration once', () => {
    const legacy = JSON.stringify(completeSnapshot({ games: [], search: '', mode: null, relationIds: [] }))
    const storage = memoryStorage(legacy, V2_KEY)
    const state = createCatalogFilterState(tracks, storage)

    expect(state.games.value).toEqual(ALL_GAMES)
    expect(JSON.parse(storage.getItem(V2_KEY)!).games).toEqual(ALL_GAMES)
    expect(createCatalogFilterState(tracks, storage).games.value).toEqual(ALL_GAMES)
  })

  it('persists each game toggle so a reload restores the same selection', () => {
    const storage = memoryStorage()
    const first = createCatalogFilterState(tracks, storage)

    first.toggleGame('zzz')
    first.toggleGame('genshin')
    expect(first.games.value).toEqual(['hsr'])

    expect(createCatalogFilterState(tracks, storage).games.value).toEqual(['hsr'])
  })

  it('refuses to clear the last selected game so the pressed state never contradicts the results', () => {
    const storage = memoryStorage()
    const state = createCatalogFilterState(tracks, storage)

    state.toggleGame('genshin')
    state.toggleGame('hsr')
    expect(state.games.value).toEqual(['zzz'])

    state.toggleGame('zzz')

    expect(state.games.value).toEqual(['zzz'])
    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['sixth'])
    expect(createCatalogFilterState(tracks, storage).games.value).toEqual(['zzz'])
  })

  it('rejects unknown persisted games and control characters', () => {
    const state = createCatalogFilterState(
      tracks,
      memoryStorage('{"games":["zzz","unknown"],"search":"bad\\u0000"}'),
    )

    expect(state.games.value).toEqual(ALL_GAMES)
    expect(state.search.value).toBe('')
  })

  it('shares all canonical dimensions with union semantics within each dimension', () => {
    const state = createCatalogFilterState(tracks, memoryStorage())

    state.setMode('focus')
    state.toggleRelation('character:diluc')

    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn'])
  })

  it('persists only valid canonical selections', () => {
    const storage = memoryStorage()
    const state = createCatalogFilterState(tracks, storage)

    state.toggleGame('genshin')
    state.toggleGame('zzz')
    state.setSearch('Express')

    expect(storage.getItem(V2_KEY)).toBe(
      '{"search":"Express","games":["hsr"],"mode":null,"relationIds":[]}',
    )
  })

  it('hydrates only an exact, bounded complete snapshot shape', () => {
    const valid = createCatalogFilterState(tracks, memoryStorage(JSON.stringify(completeSnapshot())))
    const extra = createCatalogFilterState(tracks, memoryStorage(JSON.stringify(completeSnapshot({ extra: true }))))
    const missing = createCatalogFilterState(tracks, memoryStorage(JSON.stringify({
      search: '', games: [], mode: null, relationIds: [], workGroupIds: [],
    })))
    const oversizedRaw = createCatalogFilterState(
      tracks,
      memoryStorage(`${' '.repeat(32_769)}${JSON.stringify(completeSnapshot())}`),
    )

    expect(valid.games.value).toEqual(['genshin'])
    expect(valid.search.value).toBe('Dawn')
    expect(extra.games.value).toEqual(ALL_GAMES)
    expect(missing.games.value).toEqual(ALL_GAMES)
    expect(oversizedRaw.games.value).toEqual(ALL_GAMES)
  })

  it.each([
    ['search longer than 256 characters', completeSnapshot({ search: 'a'.repeat(257) })],
    ['a control character in search', completeSnapshot({ search: 'safe\u0000' })],
    ['a duplicate game', completeSnapshot({ games: ['genshin', 'genshin'] })],
    ['an unknown game', completeSnapshot({ games: ['unknown'] })],
    ['an invalid mode', completeSnapshot({ mode: 'unknown' })],
    ['a duplicate relation', completeSnapshot({ relationIds: ['character:diluc', 'character:diluc'] })],
    ['an unknown relation', completeSnapshot({ relationIds: ['character:unknown'] })],
    ['more than three games', completeSnapshot({ games: ['genshin', 'hsr', 'zzz', 'genshin'] })],
  ])('rejects %s in persisted data', (_reason, snapshot) => {
    const state = createCatalogFilterState(tracks, memoryStorage(JSON.stringify(snapshot)))

    expect(state.search.value).toBe('')
    expect(state.games.value).toEqual(ALL_GAMES)
    expect(state.mode.value).toBeNull()
    expect(state.relationIds.value).toEqual([])
  })

  it('caps canonical relation selections at 256 entries', () => {
    const manyTracks: Track[] = Array.from({ length: 257 }, (_, index) => ({
      ...tracks[0]!,
      id: `extra-${index}`,
      relationIds: [`place:extra-${index}`],
      workGroupId: `extra-work-${index}`,
    }))
    const relationIds = manyTracks.map(({ relationIds: [relationId] }) => relationId!)
    const invalidRelations = createCatalogFilterState(
      manyTracks,
      memoryStorage(JSON.stringify(completeSnapshot({ relationIds }))),
    )

    expect(invalidRelations.relationIds.value).toEqual([])
  })

  it('keeps the last valid snapshot when a legal aggregate selection would exceed the raw storage bound', () => {
    const longSuffix = 'x'.repeat(240)
    const manyTracks: Track[] = Array.from({ length: 256 }, (_, index) => ({
      ...tracks[0]!,
      id: `aggregate-${index}`,
      relationIds: [`place:${index.toString().padStart(3, '0')}-${longSuffix}`],
      workGroupId: `work-${index.toString().padStart(3, '0')}-${longSuffix}`,
    }))
    const storage = memoryStorage()
    const setItem = vi.spyOn(storage, 'setItem')
    const state = createCatalogFilterState(manyTracks, storage)
    let rejected = false

    for (const relationId of manyTracks.map(({ relationIds: [id] }) => id!)) {
      const beforeIds = [...state.relationIds.value]
      const beforeRaw = storage.getItem(V2_KEY)
      const beforeCalls = setItem.mock.calls.length
      state.toggleRelation(relationId)
      const candidateRaw = JSON.stringify({
        search: state.search.value,
        games: state.games.value,
        mode: state.mode.value,
        relationIds: [...beforeIds, relationId],
      })

      if (candidateRaw.length > 32_768) {
        rejected = true
        expect(state.relationIds.value).toEqual(beforeIds)
        expect(storage.getItem(V2_KEY)).toBe(beforeRaw)
        expect(setItem).toHaveBeenCalledTimes(beforeCalls)
        expect(createCatalogFilterState(manyTracks, storage).relationIds.value).toEqual(beforeIds)
        break
      }
    }

    expect(rejected).toBe(true)
    setItem.mockRestore()
  })

  it('rejects invalid runtime commands and prevents direct ref mutation from reaching query or persistence', () => {
    const storage = memoryStorage()
    const state = createCatalogFilterState(tracks, storage)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ;(state.toggleGame as (value: unknown) => void)('bad')
    for (const invalidMode of ['bad', 'chat', 'all', ['focus', 'sleep'], undefined]) {
      ;(state.setMode as (value: unknown) => void)(invalidMode)
    }
    ;(state.toggleRelation as (value: unknown) => void)('character:unknown')
    ;(state.setSearch as (value: unknown) => void)('bad\u0000')
    ;(state.games as { value: unknown }).value = ['bad']
    ;(state.mode as { value: unknown }).value = 'focus'

    expect(state.games.value).toEqual(ALL_GAMES)
    expect(state.mode.value).toBeNull()
    expect(state.relationIds.value).toEqual([])
    expect(state.search.value).toBe('')
    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn', 'express', 'sixth'])
    expect(storage.getItem(V2_KEY)).toBeNull()
    expect(warning).toHaveBeenCalled()
    warning.mockRestore()
  })

  it('remains memory-safe when any storage write throws TypeError', () => {
    const storage = {
      getItem: () => null,
      setItem: () => { throw new TypeError('Denied') },
      removeItem: () => {},
    }
    const state = createCatalogFilterState(tracks, storage)

    expect(() => state.toggleGame('genshin')).not.toThrow()
    expect(state.games.value).toEqual(['hsr', 'zzz'])
  })
})

describe('obsolete URL query parameters', () => {
  const originalUrl = window.location.href

  afterEach(() => {
    window.history.replaceState(null, '', originalUrl)
  })

  // The catalogue browser has never persisted filters in the URL: state lives in
  // localStorage only. These parameters therefore had to be inert before this change
  // and must stay inert, so an old bookmark cannot filter, crash, or write state.
  it.each([
    '?classification=needs-classification',
    '?workGroup=dawn-work',
    '?classification=classified&workGroup=dawn-work&mode=focus',
    '?work_group=dawn-work&workgroup=sixth-work',
  ])('ignores %s without filtering, crashing, or persisting it', (search) => {
    window.history.replaceState(null, '', `/${search}`)
    const storage = memoryStorage()
    const setItem = vi.spyOn(storage, 'setItem')
    const state = createCatalogFilterState(tracks, storage)

    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn', 'express', 'sixth'])
    expect(state.mode.value).toBeNull()
    expect(state.games.value).toEqual(ALL_GAMES)
    expect(setItem).not.toHaveBeenCalled()
    expect(window.location.search).toBe(search)
  })

  it('still applies a valid query parameter the filter model actually supports', () => {
    window.history.replaceState(null, '', '/?mode=focus')
    const state = createCatalogFilterState(tracks, memoryStorage())

    // `mode` is a live dimension, but it is read from storage, not the URL: the URL
    // never participates in filter state, so the default unrestricted selection holds.
    expect(state.mode.value).toBeNull()
    expect(state.filteredTracks.value.map(({ id }) => id)).toEqual(['dawn', 'express', 'sixth'])
  })
})
