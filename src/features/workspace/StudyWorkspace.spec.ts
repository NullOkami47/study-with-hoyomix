import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, watch, type Ref } from 'vue'

import { resetAccountSession } from '../account/session'
import * as focusLocalRepository from '../focus/localRepository'
import type { FocusSessionRecord } from '../focus/types'
import type { CatalogFilterState } from '../catalog/filterState'
import type { Track } from '../catalog/types'
import { ProviderRegistry } from '../player/providers/registry'
import type { Playable } from '../player/providers/types'
import PlayerBar from '../player/PlayerBar.vue'
import { createRuntimeProviderRepository } from '../player/runtimeConfig'
import type { ProviderPreferencesStore } from '../player/providerPreferences'
import { getDefaultPlaybackQualityPreferencesStore } from '../player/qualityPreferences'
import type { PlaybackStore } from '../player/store'
import {
  POMODORO_STORAGE_KEY,
  PomodoroFocusQueueCapacityError,
  type PomodoroFocusQueueCapacityError as PomodoroFocusQueueCapacityErrorType,
} from '../timers/pomodoro/store'
import { usePreferences } from '../../stores/preferences'
import StudyWorkspace from './StudyWorkspace.vue'

const runtimeRepositoryMocks = vi.hoisted(() => ({
  load: vi.fn(async () => new ProviderRegistry([])),
  prefetch: vi.fn(() => new Promise<void>(() => undefined)),
}))

const remoteMocks = vi.hoisted(() => ({
  load: vi.fn(async (): Promise<{ revision: string; tracks: Track[] }> => {
    throw new Error('catalogue_unavailable')
  }),
}))
vi.mock('../catalog/remoteCatalog', () => ({ loadRemoteCatalog: remoteMocks.load }))

const catalogMocks = vi.hoisted(() => ({ tracks: [] as Track[] }))

const pomodoroHookMocks = vi.hoisted(() => ({
  onFocusSessionError: undefined as
    | ((error: PomodoroFocusQueueCapacityErrorType) => void)
    | undefined,
}))

// createPomodoroStore's deadline authority is the monotonic clock, which advances from
// performance.now() rather than Date.now(). Fake timers alone move the scheduled tick but
// never move that clock, so the workspace integration drives both explicitly.
const timerClockMocks = vi.hoisted(() => ({ now: 0 }))

vi.mock('../timers/clock', async () => {
  const actual = await vi.importActual<typeof import('../timers/clock')>('../timers/clock')
  return { ...actual, systemTimerClock: { now: () => timerClockMocks.now } }
})

vi.mock('../player/runtimeConfig', async () => {
  const actual = await vi.importActual<typeof import('../player/runtimeConfig')>('../player/runtimeConfig')
  return {
    ...actual,
    createRuntimeProviderRepository: vi.fn(() => runtimeRepositoryMocks),
  }
})

vi.mock('../catalog/runtimeCatalog', () => ({
  runtimeCatalog: vi.fn(() => ({ tracks: catalogMocks.tracks })),
}))

vi.mock('../timers/pomodoro/store', async () => {
  const actual = await vi.importActual<typeof import('../timers/pomodoro/store')>(
    '../timers/pomodoro/store',
  )
  return {
    ...actual,
    createPomodoroStore: (
      options: Parameters<typeof actual.createPomodoroStore>[0] = {},
    ) => {
      pomodoroHookMocks.onFocusSessionError = options.onFocusSessionError
      return actual.createPomodoroStore(options)
    },
  }
})

const workspaceStubs = {
  SceneBackdrop: {
    name: 'SceneBackdrop',
    props: ['mode', 'lowPower', 'store'],
    template: '<div data-scene-stub />',
  },
  YouTubePlayer: {
    name: 'YouTubePlayer',
    template: '<div data-youtube-player />',
    methods: {
      pause() {},
      play() {},
      setVolume() {},
    },
  },
  // Stubbed so the workspace suite never reaches the public notice endpoint.
  NoticeCentre: {
    name: 'NoticeCentre',
    props: ['store'],
    template: '<div data-notice-centre-stub />',
  },
}

const track: Track = {
  id: 'track-a',
  title: 'A New Day',
  aliases: {},
  games: ['hsr'],
  relationIds: [],
  tabs: ['focus'],
  workGroupId: 'work-a',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }],
}

const controlledCatalogue: Track[] = [
  {
    id: 'dawn-focus', title: 'Dawn Focus', aliases: {}, games: ['genshin'],
    relationIds: ['character:amber', 'event:shared'], tabs: ['focus'], workGroupId: 'dawn',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [
      { provider: 'jellyfin', externalId: 'dawn-focus.ogg' },
      { provider: 'r2', externalId: 'dawn-focus.ogg' },
    ],
  },
  {
    id: 'express-sleep', title: 'Express Sleep', aliases: {}, games: ['hsr'],
    relationIds: ['place:express', 'event:shared'], tabs: ['sleep'], workGroupId: 'rails',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [
      { provider: 'jellyfin', externalId: 'express-sleep.ogg' },
      { provider: 'r2', externalId: 'express-sleep.ogg' },
    ],
  },
  {
    id: 'hollow-chill', title: 'Hollow Chill', aliases: {}, games: ['zzz'],
    relationIds: ['npc:fairy', 'event:shared'], tabs: ['chill'], workGroupId: 'hollow',
    vocalStatus: 'uncertain', needsClassification: true,
    sources: [
      { provider: 'jellyfin', externalId: 'hollow-chill.ogg' },
      { provider: 'r2', externalId: 'hollow-chill.ogg' },
    ],
  },
  {
    id: 'harbour-sleep', title: 'Harbour Sleep', aliases: {}, games: ['genshin'],
    relationIds: ['place:harbour', 'event:shared'], tabs: ['sleep'], workGroupId: 'dawn',
    vocalStatus: 'instrumental', needsClassification: false,
    sources: [
      { provider: 'jellyfin', externalId: 'harbour-sleep.ogg' },
      { provider: 'r2', externalId: 'harbour-sleep.ogg' },
    ],
  },
]

const unmatchedTrack: Track = {
  id: 'unmatched-current', title: 'Unmatched Current', aliases: {}, games: ['hsr'],
  relationIds: [], tabs: ['chill'], workGroupId: 'outside-catalogue',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [
    { provider: 'jellyfin', externalId: 'unmatched-current.ogg' },
    { provider: 'r2', externalId: 'unmatched-current.ogg' },
  ],
}

function queueIds(player: PlaybackStore): string[] {
  return player.queue.value.map(({ id }) => id)
}

beforeEach(() => {
  vi.mocked(createRuntimeProviderRepository).mockClear()
  runtimeRepositoryMocks.prefetch.mockClear()
  remoteMocks.load.mockReset().mockRejectedValue(new Error('catalogue_unavailable'))
  window.localStorage.clear()
  window.localStorage.setItem('hoyomix-player-shuffle-v1', 'false')
  catalogMocks.tracks = controlledCatalogue
  runtimeRepositoryMocks.load.mockReset().mockResolvedValue(new ProviderRegistry([]))
  resetAccountSession()
  timerClockMocks.now = Date.parse('2026-08-25T08:00:00.000Z')
  pomodoroHookMocks.onFocusSessionError = undefined
  usePreferences().setLocale('en')
  usePreferences().backgroundMode.value = 'ambient'
  usePreferences().lowPower.value = false
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function seedPendingFocusCompletion(endedAt: number): void {
  window.localStorage.setItem(POMODORO_STORAGE_KEY, JSON.stringify({
    breakMinutes: 5,
    completedPomodoros: 1,
    cycleCount: 4,
    deadline: null,
    focusMinutes: 25,
    focusRun: null,
    longBreakMinutes: 10,
    pauseMusicDuringBreak: true,
    pendingFocusFinalizations: [{
      run: {
        id: '55555555-5555-4555-8555-555555555555',
        plannedFocusSeconds: 60,
        startedAt: endedAt - 60_000,
      },
      actualFocusSeconds: 60,
      endedAt,
      presentSummary: true,
      status: 'completed',
    }],
    phase: 'break',
    remainingSeconds: 300,
    status: 'idle',
  }))
}

function advanceFocusMinute(): void {
  timerClockMocks.now += 60_000
  vi.advanceTimersByTime(60_000)
}

/**
 * Every secondary tool lives in the Control Center, and the whole top bar is the way in.
 * Reaching one is two gestures: press the bar, then pick the category. Both helpers are
 * idempotent about opening, so a test may call them before each command.
 */
async function openControlCentre(wrapper: ReturnType<typeof mount>): Promise<void> {
  const hitArea = wrapper.get('[data-focus-control-centre]')
  if (hitArea.attributes('aria-expanded') !== 'true') await hitArea.trigger('click')
}

async function openSection(wrapper: ReturnType<typeof mount>, section: string): Promise<void> {
  await openControlCentre(wrapper)
  await wrapper.get(`[data-control-centre-nav="${section}"]`).trigger('click')
}

function closeControlCentre(wrapper: ReturnType<typeof mount>): Promise<void> {
  return wrapper.get('[data-overlay-sheet="control-centre"] [data-overlay-close]').trigger('click')
}

describe('StudyWorkspace', () => {
  it('does not publish a delayed anonymous Focus list after the authenticated scope has loaded', async () => {
    let finish!: (values: FocusSessionRecord[]) => void
    const pending = new Promise<FocusSessionRecord[]>(resolve => { finish = resolve })
    const original = focusLocalRepository.createFocusSessionRepository
    const factory = vi.spyOn(focusLocalRepository, 'createFocusSessionRepository').mockImplementation(options => {
      const repository = original(options)
      return options?.databaseName === focusLocalRepository.FOCUS_SESSION_DATABASE_NAME
        ? { ...repository, list: () => pending } : repository
    })
    vi.stubGlobal('fetch', vi.fn(async input => String(input) === '/api/session'
      ? Response.json({ user: { id: 'late-read-account' } }) : new Response(null, { status: 503 })))
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    try {
      await flushPromises(); await openSection(wrapper, 'calendar'); await flushPromises()
      expect(wrapper.find('[data-focus-calendar-empty]').exists()).toBe(true)
      const now = new Date().toISOString()
      finish([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', schemaVersion: 1, phase: 'focus', status: 'completed',
        startedAt: now, endedAt: now, createdAt: now, plannedFocusSeconds: 60, actualFocusSeconds: 60 }])
      await flushPromises()
      expect(wrapper.find('[data-focus-calendar-empty]').exists()).toBe(true)
    } finally { wrapper.unmount(); factory.mockRestore(); vi.unstubAllGlobals() }
  })
  it('replaces a three-track bundle with every matching remote track without resolving media', async () => {
    vi.stubEnv('VITE_ENABLE_DEMO_CATALOG', 'false')
    catalogMocks.tracks = controlledCatalogue.slice(0, 3)
    const remote = Array.from({ length: 3004 }, (_, index): Track => ({
      ...controlledCatalogue[0], id: `remote-${index}`, title: `Remote ${index}`,
    }))
    const resolve = vi.fn(async (): Promise<Playable> => ({ kind: 'youtube', videoId: 'abcdefghijk' }))
    runtimeRepositoryMocks.load.mockResolvedValue(new ProviderRegistry([{
      provider: { id: 'youtube', resolve }, enabled: true, priority: 1, timeoutMs: 100,
    }]))
    remoteMocks.load.mockResolvedValueOnce({ revision: '40', tracks: remote })
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    await flushPromises()
    expect(player.queue.value).toHaveLength(3004)
    expect(new Set(queueIds(player)).size).toBe(3004)
    expect(player.currentIndex.value).toBe(-1)
    expect(resolve).not.toHaveBeenCalled()
    await wrapper.get('[data-player-toggle-queue]').trigger('click')
    expect(wrapper.findAll('[data-queue-up-next]').length).toBeLessThan(40)
    wrapper.unmount()
  })

  it('restores remote-only structural filters while keeping search outside the queue', async () => {
    vi.stubEnv('VITE_ENABLE_DEMO_CATALOG', 'false')
    catalogMocks.tracks = controlledCatalogue.slice(0, 3)
    // The pre-upgrade six-key record: its retired classification/work-group values are
    // dropped on load and only the structural relation survives into the queue query.
    window.localStorage.setItem('study-with-hoyomix.catalog-filters.v2', JSON.stringify({
      search: 'not a title', games: ['hsr'], mode: 'focus', relationIds: ['event:remote'],
      workGroupIds: ['remote-work'], classification: 'all',
    }))
    const matching = Array.from({ length: 12 }, (_, index): Track => ({
      ...controlledCatalogue[0], id: `matched-${index}`, games: ['hsr'],
      relationIds: ['event:remote'], workGroupId: 'remote-work',
    }))
    remoteMocks.load.mockResolvedValueOnce({ revision: '41', tracks: [...matching, ...controlledCatalogue] })
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    await flushPromises()
    expect(queueIds(player)).toEqual(matching.map(({ id }) => id))
    const filters = wrapper.getComponent({ name: 'FocusBar' }).props('state') as CatalogFilterState
    expect(filters.filteredTracks.value).toEqual([])
    const before = player.queue.value
    filters.setSearch('matched')
    await nextTick()
    expect(player.queue.value).toBe(before)
    expect(player.currentIndex.value).toBe(-1)
    wrapper.unmount()
  })
  function pendingCatalogueWorkspace(tracks = controlledCatalogue.slice(0, 3)) {
    vi.stubEnv('VITE_ENABLE_DEMO_CATALOG', 'false')
    catalogMocks.tracks = tracks
    let deliver!: (catalogue: { revision: string; tracks: Track[] }) => void
    remoteMocks.load.mockImplementationOnce(() =>
      new Promise<{ revision: string; tracks: Track[] }>((resolve) => { deliver = resolve }))
    const resolve = vi.fn(async (track: Track): Promise<Playable> => ({
      kind: 'audio',
      url: 'https://media.invalid/' + track.sources[0].externalId,
      mimeType: 'audio/ogg',
    }))
    runtimeRepositoryMocks.load.mockResolvedValue(new ProviderRegistry([{
      provider: { id: 'jellyfin', resolve }, enabled: true, priority: 1, timeoutMs: 100,
    }]))
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    const replacement = tracks.map((track) => ({
      ...track, title: 'Published ' + track.title,
      sources: [{ provider: 'jellyfin', externalId: 'published-' + track.id + '.ogg' }],
    }))
    return { wrapper, player, resolve, replacement, deliver }
  }

  it('lists the bundled queue on initial hydration without provider resolution', async () => {
    const mediaPlay = vi.spyOn(HTMLMediaElement.prototype, 'play')
    const { wrapper, player, resolve } = pendingCatalogueWorkspace()
    await flushPromises()

    expect(player.queue.value[0]).toBe(controlledCatalogue[0])
    expect(player.currentIndex.value).toBe(-1)
    expect(player.currentTrack.value).toBeUndefined()
    expect(player.playbackIntent.value).toBe('paused')
    expect(player.status.value).toBe('idle')
    expect(player.playable.value).toBeNull()
    expect(resolve).not.toHaveBeenCalled()
    expect(mediaPlay).not.toHaveBeenCalled()

    mediaPlay.mockRestore()
    wrapper.unmount()
  })

  it('lists the first remote tracks when the bundled catalogue is empty without resolving', async () => {
    catalogMocks.tracks = []
    remoteMocks.load.mockResolvedValueOnce({ revision: 'remote', tracks: controlledCatalogue })

    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    await flushPromises()

    expect(queueIds(player)).toEqual(controlledCatalogue.map(({ id }) => id))
    expect(player.currentTrack.value).toBeUndefined()
    expect(player.currentIndex.value).toBe(-1)
    expect(player.playbackIntent.value).toBe('paused')
  })

  it('keeps a manually removed upcoming ID absent when the same-ID remote catalogue arrives', async () => {
    const { wrapper, player, resolve, replacement, deliver } = pendingCatalogueWorkspace()
    expect(queueIds(player)).toEqual(['dawn-focus', 'express-sleep', 'hollow-chill'])
    player.removeQueueIndex(1)

    deliver({ revision: '2', tracks: replacement })
    await flushPromises()

    expect(queueIds(player)).toEqual(['dawn-focus', 'hollow-chill'])
    expect(player.queue.value).toEqual([replacement[0], replacement[2]])
    expect(player.queue.value[0]).toBe(replacement[0])
    expect(player.queue.value[1]).toBe(replacement[2])
    expect(new Set(queueIds(player)).size).toBe(2)
    expect(player.currentIndex.value).toBe(-1)
    expect(player.currentTrack.value).toBeUndefined()
    expect(player.playbackGeneration.value).toBe(0)
    expect(player.playbackIntent.value).toBe('paused')
    expect(player.status.value).toBe('idle')
    wrapper.unmount()
  })

  it('keeps cleared upcoming empty through same-ID refresh without changing current playback', async () => {
    const { wrapper, player, resolve, replacement, deliver } = pendingCatalogueWorkspace()
    await player.playQueueIndex(0)
    await flushPromises()
    const current = player.currentTrack.value
    const playable = player.playable.value
    const generation = player.playbackGeneration.value
    player.clearUpcomingQueue()
    const resolveCount = resolve.mock.calls.length

    deliver({ revision: '2', tracks: replacement })
    await flushPromises()

    expect(queueIds(player)).toEqual(['dawn-focus'])
    expect(player.currentTrack.value).toBe(current)
    expect(player.playable.value).toBe(playable)
    expect(player.playbackGeneration.value).toBe(generation)
    expect(resolve).toHaveBeenCalledTimes(resolveCount)
    wrapper.unmount()
  })

  it('repopulates after replacement clears a selected relation filter', async () => {
    const { wrapper, player, replacement, deliver } = pendingCatalogueWorkspace()
    const filterState = wrapper.getComponent({ name: 'FocusBar' }).props('state') as CatalogFilterState
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-filter-relation="event:shared"]').trigger('click')
    expect(filterState.relationIds.value).toEqual(['event:shared'])
    player.clearUpcomingQueue()

    for (const [index, track] of replacement.entries()) {
      replacement[index] = {
        ...track,
        relationIds: track.relationIds.filter((id) => id !== 'event:shared'),
      }
    }
    deliver({ revision: '2', tracks: replacement })
    await flushPromises()

    expect(filterState.relationIds.value).toEqual([])
    expect(queueIds(player)).toEqual(['dawn-focus', 'express-sleep', 'hollow-chill'])
    wrapper.unmount()
  })

  it('allows a genuine effective filter change to repopulate only after refresh respected removal', async () => {
    const { wrapper, player, replacement, deliver } = pendingCatalogueWorkspace()
    player.removeQueueIndex(1)
    deliver({ revision: '2', tracks: replacement })
    await flushPromises()
    expect(queueIds(player)).toEqual(['dawn-focus', 'hollow-chill'])

    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-filter-tab="sleep"]').trigger('click')

    expect(queueIds(player)).toEqual(['express-sleep'])
    expect(player.queue.value[0]).toBe(replacement[1])
    expect(player.playbackGeneration.value).toBe(0)
    expect(player.playbackIntent.value).toBe('paused')
    wrapper.unmount()
  })

  it('removes newly non-matching queued data on refresh without appending another absent match', async () => {
    const { wrapper, player, resolve, replacement, deliver } = pendingCatalogueWorkspace(controlledCatalogue)
    await player.playQueueIndex(0)
    await flushPromises()
    const current = player.currentTrack.value
    const playable = player.playable.value
    const generation = player.playbackGeneration.value
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-filter-tab="sleep"]').trigger('click')
    expect(queueIds(player)).toEqual(['dawn-focus', 'express-sleep', 'harbour-sleep'])
    player.removeQueueIndex(2)
    replacement[1] = { ...replacement[1], tabs: ['chill'] }
    const resolveCount = resolve.mock.calls.length

    deliver({ revision: '2', tracks: replacement })
    await flushPromises()

    expect(queueIds(player)).toEqual(['dawn-focus'])
    expect(player.currentTrack.value).toBe(current)
    expect(player.playable.value).toBe(playable)
    expect(player.playbackGeneration.value).toBe(generation)
    expect(resolve).toHaveBeenCalledTimes(resolveCount)
    wrapper.unmount()
  })

  it('refreshes idle queued objects on a same-ID catalogue replacement exactly once', async () => {
    vi.stubEnv('VITE_ENABLE_DEMO_CATALOG', 'false')
    let deliver!: (catalogue: { revision: string; tracks: Track[] }) => void
    remoteMocks.load.mockImplementationOnce(() =>
      new Promise<{ revision: string; tracks: Track[] }>((resolve) => { deliver = resolve }))
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    const before = [...player.queue.value]
    expect(queueIds(player)).toEqual(controlledCatalogue.map((t) => t.id))
    const queueChanged = vi.fn()
    const stopWatching = watch(player.queue, queueChanged, { flush: 'sync' })
    const replacement = controlledCatalogue.map((t) => ({
      ...t, title: 'Published ' + t.title,
      sources: [{ provider: 'r2', externalId: 'published-' + t.id + '.ogg' }],
    }))
    deliver({ revision: '2', tracks: replacement })
    await flushPromises()
    expect(player.queue.value).toEqual(replacement)
    expect(player.queue.value[1]).not.toBe(before[1])
    expect(new Set(queueIds(player)).size).toBe(replacement.length)
    expect(queueChanged).toHaveBeenCalledOnce()
    expect(player.currentIndex.value).toBe(-1)
    expect(player.currentTrack.value).toBeUndefined()
    expect(player.playbackGeneration.value).toBe(0)
    expect(player.status.value).toBe('idle')
    expect(player.playable.value).toBeNull()
    // Unrelated renders and filter-panel disclosure must not undo manual removal.
    player.removeQueueIndex(1)
    queueChanged.mockClear()
    await wrapper.get('[data-player-toggle-queue]').trigger('click')
    await wrapper.get('[data-advanced-trigger]').trigger('click')
    expect(queueChanged).not.toHaveBeenCalled()
    expect(queueIds(player)).not.toContain(replacement[1].id)
    stopWatching()
    wrapper.unmount()
  })

  it.each(['next', 'ended'] as const)(
    'preserves playing generation on same-ID refresh and %s resolves the new upcoming source',
    async (advance) => {
      vi.stubEnv('VITE_ENABLE_DEMO_CATALOG', 'false')
      let deliver!: (catalogue: { revision: string; tracks: Track[] }) => void
      remoteMocks.load.mockImplementationOnce(() =>
        new Promise<{ revision: string; tracks: Track[] }>((resolve) => { deliver = resolve }))
      const resolve = vi.fn(async (track: Track): Promise<Playable> => ({
        kind: 'audio',
        url: 'https://media.invalid/' + track.sources[0].externalId,
        mimeType: 'audio/ogg',
      }))
      runtimeRepositoryMocks.load.mockResolvedValue(new ProviderRegistry([{
        provider: { id: 'r2', resolve }, enabled: true, priority: 1, timeoutMs: 100,
      }]))
      const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
      const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
      await player.playQueueIndex(0)
      await flushPromises()
      await wrapper.get('[data-audio-role="active"]').trigger('playing')
      const current = player.currentTrack.value
      const generation = player.playbackGeneration.value
      const playable = player.playable.value
      const attempts = player.attempts.value
      const currentResolveCount = resolve.mock.calls.filter(([track]) => track === current).length
      // Keep two matching manually reordered items, but leave B immediately after A.
      player.moveQueueItem(3, 2)
      const replacement = controlledCatalogue.map((t) => ({
        ...t, title: 'Published ' + t.title,
        sources: [{ provider: 'r2', externalId: 'published-' + t.id + '.ogg' }],
      }))
      deliver({ revision: '2', tracks: replacement })
      await flushPromises()
      expect(player.queue.value[1]).toEqual(replacement[1])
      expect(player.currentTrack.value).toBe(current)
      expect(player.playbackGeneration.value).toBe(generation)
      expect(player.playable.value).toBe(playable)
      expect(player.attempts.value).toBe(attempts)
      expect(player.playbackIntent.value).toBe('playing')
      expect(player.status.value).toBe('playing')
      expect(resolve.mock.calls.filter(([track]) => track === current)).toHaveLength(currentResolveCount)
      expect(queueIds(player)).toEqual(['dawn-focus', 'express-sleep', 'harbour-sleep', 'hollow-chill'])
      expect(new Set(queueIds(player)).size).toBe(4)
      await wrapper.get('[data-player-toggle-queue]').trigger('click')
      expect(wrapper.getComponent(PlayerBar).props('mediaSuspended')).toBe(false)
      expect(player.status.value).toBe('playing')
      expect(player.playbackGeneration.value).toBe(generation)
      if (advance === 'next') await player.next()
      else await wrapper.get('[data-audio-role="active"]').trigger('ended')
      await flushPromises()
      expect(player.currentTrack.value).toEqual(replacement[1])
      expect(player.playbackGeneration.value).toBe(generation + 1)
      expect(resolve.mock.calls.some(([track]) => track === replacement[1])).toBe(true)
      expect(player.playable.value).toMatchObject({
        kind: 'audio', url: 'https://media.invalid/published-express-sleep.ogg',
      })
    },
  )

  it('retains bundled tracks on API failure and reconciles on a valid remote replacement', async () => {
    vi.stubEnv('VITE_ENABLE_DEMO_CATALOG', 'false')
    const replacement = [{ ...catalogMocks.tracks[0], title: 'Published replacement' }]
    remoteMocks.load.mockResolvedValueOnce({ revision:'2', tracks:replacement } as never)
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    await flushPromises()
    expect(wrapper.getComponent(PlayerBar).props('store').queue.value[0].title).toBe('Published replacement')
    wrapper.unmount()
    const fallback = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    await flushPromises()
    expect(fallback.getComponent(PlayerBar).props('store').queue.value.map((t: Track) => t.id)).toEqual(catalogMocks.tracks.map(t => t.id))
    fallback.unmount(); vi.unstubAllEnvs()
  })

  it('starts one non-blocking provider prefetch while rendering local workspace features', () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    expect(createRuntimeProviderRepository).toHaveBeenCalledTimes(1)
    expect(runtimeRepositoryMocks.prefetch).toHaveBeenCalledTimes(1)
    expect(wrapper.get('main[data-workspace="cinematic"]').element).toBeTruthy()
    expect(wrapper.get('[data-focus-pomodoro-readout]').element).toBeTruthy()
    // The resting scene is the top bar and player. Chat and other secondary tools stay
    // behind the bar until the user opens them.
    expect(wrapper.get('[data-focus-control-centre]').element).toBeTruthy()
    expect(wrapper.find('[data-floating-chat]').exists()).toBe(false)
    expect(wrapper.find('[data-quick-actions]').exists()).toBe(false)
    expect(wrapper.find('[data-focus-tray]').exists()).toBe(false)
    expect(wrapper.find('[data-workspace-zone="quick-actions"]').exists()).toBe(false)
    expect(wrapper.find('[data-overlay-sheet="control-centre"]').exists()).toBe(false)
  })

  it('renders one scene-first main landmark without the inherited dashboard header', () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    expect(wrapper.get('main[data-workspace="cinematic"]').element).toBeTruthy()
    expect(wrapper.get('main').attributes('id')).toBe('app-content')
    expect(wrapper.find('.catalog-workspace').exists()).toBe(false)
    expect(wrapper.find('[data-testid="legacy-account-header"]').exists()).toBe(false)
  })

  it('provides named overlay zones and forwards persisted scene preferences', async () => {
    const wrapper = mount(StudyWorkspace, {
      slots: {
        focus: '<p data-focus-zone>Focus</p>',
        player: '<p data-player-zone>Player</p>',
        chat: '<p data-chat-zone>Chat</p>',
      },
      global: { stubs: workspaceStubs },
    })

    const backdrop = wrapper.getComponent({ name: 'SceneBackdrop' })
    expect(backdrop.props()).toMatchObject({ mode: 'ambient', lowPower: false })
    await openSection(wrapper, 'appearance')
    const settings = wrapper.getComponent({ name: 'SettingsSheet' })
    expect(settings.props('backgroundStore')).toBe(backdrop.props('store'))
    expect(wrapper.get('[data-workspace-zone="focus"] [data-focus-zone]').element).toBeTruthy()
    expect(wrapper.get('[data-workspace-zone="player"] [data-player-zone]').element).toBeTruthy()
    // The chat window is fixed to the viewport and places itself, so the chat slot is a
    // sibling of the zones rather than content inside one.
    expect(wrapper.get('[data-chat-zone]').element).toBeTruthy()
    expect(wrapper.find('[data-workspace-zone="chat"]').exists()).toBe(false)
  })

  it('does not replace ambient video with a still merely when Studio glass is selected', async () => {
    const preferences = usePreferences()
    preferences.setLowPower(false)
    preferences.setVisualStyle('studio')
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    await nextTick()
    expect(wrapper.getComponent({ name: 'SceneBackdrop' }).props('lowPower')).toBe(false)
    wrapper.unmount()
  })

  it('bridges the glass gray preference to both the WebGL canvas and the CSS fallback', async () => {
    const preferences = usePreferences()
    preferences.setVisualStyle('studio')
    preferences.setStudioGlassGray(40)
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    await nextTick()

    // One preference, two render paths: the shader prop and the custom property the
    // backdrop-filter fallback reads must never drift apart.
    const root = wrapper.get('main[data-workspace="cinematic"]').element as HTMLElement
    expect(root.style.getPropertyValue('--studio-glass-gray-strength')).toBe('0.4')
    expect(wrapper.getComponent({ name: 'StudioGlassCanvas' }).props('glassGray')).toBe(40)

    preferences.setStudioGlassGray(75)
    await nextTick()
    expect(root.style.getPropertyValue('--studio-glass-gray-strength')).toBe('0.75')
    expect(wrapper.getComponent({ name: 'StudioGlassCanvas' }).props('glassGray')).toBe(75)
    wrapper.unmount()
  })

  it('bridges the edge dispersion preference to the shader and the CSS fallback', async () => {
    const preferences = usePreferences()
    preferences.setVisualStyle('studio')
    preferences.setStudioEdge(40)
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    await nextTick()

    const root = wrapper.get('main[data-workspace="cinematic"]').element as HTMLElement
    expect(root.style.getPropertyValue('--studio-edge-strength')).toBe('0.4')
    expect(wrapper.getComponent({ name: 'StudioGlassCanvas' }).props('edge')).toBe(40)

    preferences.setStudioEdge(0)
    await nextTick()
    expect(root.style.getPropertyValue('--studio-edge-strength')).toBe('0')
    expect(wrapper.getComponent({ name: 'StudioGlassCanvas' }).props('edge')).toBe(0)
    wrapper.unmount()
  })

  it('shares one playback and library composition instead of mounting the legacy catalogue surface', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    expect(wrapper.find('.catalog-workspace').exists()).toBe(false)
    expect(wrapper.findAll('[data-player-compact]')).toHaveLength(1)
    expect(wrapper.findAll('[data-chat-availability]')).toHaveLength(0)

    await openSection(wrapper, 'library')

    // The Library is a panel inside the hub, not a second modal stacked on it.
    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-library-sheet]')).toHaveLength(1)
    // Opening another Settings section does not mount the chat window as a side effect.
    expect(wrapper.findAll('[data-chat-availability]')).toHaveLength(0)
    expect(wrapper.find('[data-floating-chat]').exists()).toBe(false)
  })

  it('opens each Settings category as one view onto the shared settings model', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    await openSection(wrapper, 'focus')
    expect(wrapper.findAll('[data-settings-sheet]')).toHaveLength(1)
    // A category renders exactly its own sections and drops the sheet's own index, so the
    // hub's rail is the only navigation.
    expect(wrapper.findAll('[data-settings-section]').map((section) => section.attributes('data-settings-section')))
      .toEqual(['pomodoro'])
    expect(wrapper.find('[data-settings-index]').exists()).toBe(false)

    await wrapper.get('[data-control-centre-nav="appearance"]').trigger('click')
    expect(wrapper.findAll('[data-settings-section]').map((section) => section.attributes('data-settings-section')))
      .toEqual(['language', 'appearance'])

    expect(wrapper.find('#app-locale').exists()).toBe(false)
    expect(wrapper.find('[data-testid="legacy-account-header"]').exists()).toBe(false)
  })

  it('keeps the chat hidden while Settings opens, changes, and closes', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    expect(wrapper.find('[data-floating-chat]').exists()).toBe(false)
    await openSection(wrapper, 'appearance')
    expect(wrapper.find('[data-floating-chat]').exists()).toBe(false)

    usePreferences().setLocale('zh-Hant')
    await nextTick()
    expect(wrapper.find('[data-floating-chat]').exists()).toBe(false)

    await closeControlCentre(wrapper)
    await flushPromises()
    expect(wrapper.find('[data-floating-chat]').exists()).toBe(false)
  })

  it('reaches every secondary tool the product has from the one hub', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    await openControlCentre(wrapper)

    const rail = wrapper.findAll('[data-control-centre-nav]').map((item) => item.attributes('data-control-centre-nav'))
    expect(rail).toEqual([
      'focus', 'calendar', 'library', 'music', 'chat',
      'account', 'appearance', 'application', 'about', 'privacy',
    ])

    // One active view at a time: picking a category replaces the panel rather than
    // stacking another section under it.
    for (const [section, selector] of [
      ['library', '[data-library-sheet]'],
      ['calendar', '[data-focus-calendar-list]'],
      ['chat', '[data-control-centre-chat]'],
      ['music', '[data-settings-section="playback"]'],
      ['privacy', '[data-settings-section="privacy"]'],
    ] as const) {
      await wrapper.get(`[data-control-centre-nav="${section}"]`).trigger('click')
      expect(wrapper.get(`[data-control-centre-panel] ${selector}`).element, section).toBeTruthy()
      expect(wrapper.get(`[data-control-centre-nav="${section}"]`).attributes('aria-current'), section).toBe('true')
      expect(wrapper.findAll('[role="dialog"]'), section).toHaveLength(1)
    }
  })

  it('keeps the unofficial notice in About without a first-visit popup', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    expect(wrapper.find('[data-fan-notice]').exists()).toBe(false)
    expect(wrapper.find('[data-fan-notice-visible]').exists()).toBe(false)
    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(0)

    await openSection(wrapper, 'about')
    expect(wrapper.get('[data-about-unofficial]').text()).toContain('unofficial')
    await openSection(wrapper, 'library')
    expect(wrapper.get('[data-control-centre-panel] [data-library-sheet]').element).toBeTruthy()

    expect(wrapper.find('[data-fan-notice]').exists()).toBe(false)
    expect(wrapper.get('[data-control-centre-panel] [data-library-sheet]').element).toBeTruthy()
  })

  it('captures constructor replay and presents one persisted Focus summary through the shared modal layer', async () => {
    seedPendingFocusCompletion(Date.now())
    const wrapper = mount(StudyWorkspace, {
      attachTo: document.body,
      global: { stubs: workspaceStubs },
    })
    await flushPromises()

    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1)
    expect(wrapper.get('[data-overlay-sheet="focus-summary"] h2').text()).toBe('Focus summary')
    expect(wrapper.get('[data-overlay-sheet="focus-summary"] [data-focus-summary-status]').text())
      .toContain('Completed')
    expect(wrapper.get('[data-focus-summary-duration]').text()).toContain('1m')
    expect(wrapper.getComponent(PlayerBar).props('mediaSuspended')).toBe(true)

    await wrapper.get('[data-overlay-sheet="focus-summary"] [data-overlay-close]').trigger('click')
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.getComponent(PlayerBar).props('mediaSuspended')).toBe(false)
    expect(wrapper.get('[data-focus-pomodoro-start]').element).toBe(document.activeElement)
  })

  it('returns Summary focus to the live Pomodoro control when completion replaces Settings', async () => {
    vi.useFakeTimers()
    const wrapper = mount(StudyWorkspace, {
      attachTo: document.body,
      global: { stubs: workspaceStubs },
    })

    await openSection(wrapper, 'focus')
    await wrapper.get('[data-settings-focus]').setValue('1')
    await closeControlCentre(wrapper)
    await wrapper.get('[data-focus-pomodoro-start]').trigger('click')
    await openSection(wrapper, 'focus')

    advanceFocusMinute()
    await flushPromises()
    expect(wrapper.get('[data-overlay-sheet="focus-summary"]').element).toBeTruthy()

    await wrapper.get('[data-overlay-sheet="focus-summary"]').trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    expect(wrapper.get('[data-focus-pomodoro-pause]').element).toBe(document.activeElement)
  })

  it('routes the Settings calendar link to the hub category rather than a second modal', async () => {
    const wrapper = mount(StudyWorkspace, {
      attachTo: document.body,
      global: { stubs: workspaceStubs },
    })

    await openSection(wrapper, 'focus')
    await wrapper.get('[data-testid="focus-open-calendar"]').trigger('click')

    // The same hub, on the category that answers the request. A category that launched a
    // further modal would not be a hub.
    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1)
    expect(wrapper.get('[data-control-centre-nav="calendar"]').attributes('aria-current')).toBe('true')
    expect(wrapper.get('[data-control-centre-panel] table caption').text()).toBe('Focus calendar')
    expect(wrapper.get('[data-control-centre-panel] ol[data-focus-calendar-list]').element).toBeTruthy()
    expect(wrapper.getComponent(PlayerBar).props('mediaSuspended')).toBe(true)

    await wrapper.get('[data-overlay-sheet="control-centre"]').trigger('keydown', { key: 'Escape' })
    await flushPromises()

    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    // Focus returns to the bar's activation surface, which opened the hub and is always
    // present, so it can never be left on a removed element.
    expect(wrapper.get('[data-focus-control-centre]').element).toBe(document.activeElement)
    expect(wrapper.getComponent(PlayerBar).props('mediaSuspended')).toBe(false)
  })

  it('surfaces recoverable and fatal queue capacity truth through Settings', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    pomodoroHookMocks.onFocusSessionError?.(
      new PomodoroFocusQueueCapacityError('pending_overflow'),
    )
    await openSection(wrapper, 'focus')
    expect(wrapper.get('[data-focus-history-status]').text()).toMatch(/recoverable/iu)

    pomodoroHookMocks.onFocusSessionError?.(
      new PomodoroFocusQueueCapacityError('overflow_full'),
    )
    await nextTick()
    const fatalStatus = wrapper.get('[data-focus-history-status]').text()
    expect(fatalStatus).toMatch(/fatal/iu)
    expect(fatalStatus).toContain('could not be retained')

    pomodoroHookMocks.onFocusSessionError?.(
      new PomodoroFocusQueueCapacityError('pending_overflow'),
    )
    await nextTick()
    expect(wrapper.get('[data-focus-history-status]').text()).toBe(fatalStatus)
  })

  it('toggles the QueueDrawer from the compact player without suspending media or opening modals', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    expect(wrapper.get('[data-player-toggle-queue]').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-queue-drawer]').exists()).toBe(false)
    expect(wrapper.getComponent(PlayerBar).props('mediaSuspended')).toBe(false)

    await wrapper.get('[data-player-toggle-queue]').trigger('click')

    expect(wrapper.get('[data-player-toggle-queue]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.get('[data-queue-drawer]').element).toBeTruthy()
    expect(wrapper.getComponent(PlayerBar).props('mediaSuspended')).toBe(false)
    expect(wrapper.find('#workspace-control-centre-sheet[data-overlay-sheet="control-centre"]').exists()).toBe(false)

    // And close it
    await wrapper.get('[data-queue-close]').trigger('click')
    expect(wrapper.get('[data-player-toggle-queue]').attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-queue-drawer]').exists()).toBe(false)
    expect(wrapper.getComponent(PlayerBar).props('mediaSuspended')).toBe(false)
  })

  it('keeps the Control Centre independently modal from the QueueDrawer', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    // Open Queue
    await wrapper.get('[data-player-toggle-queue]').trigger('click')

    // Open Control Centre
    await openSection(wrapper, 'privacy')

    expect(wrapper.get('[data-queue-drawer]').element).toBeTruthy()
    expect(wrapper.get('#workspace-control-centre-sheet[data-overlay-sheet="control-centre"]').element).toBeTruthy()
    expect(wrapper.getComponent(PlayerBar).props('mediaSuspended')).toBe(true)
  })

  it('starts with the exact default catalogue queued without preparing media', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    await flushPromises()

    expect(queueIds(player)).toEqual([
      'dawn-focus',
      'express-sleep',
      'hollow-chill',
      'harbour-sleep',
    ])
    expect(player.currentIndex.value).toBe(-1)
    expect(player.currentTrack.value).toBeUndefined()
    expect(player.playbackGeneration.value).toBe(0)
    expect(player.playbackIntent.value).toBe('paused')
    expect(player.status.value).toBe('idle')
    expect(player.playable.value).toBeNull()
  })

  it('reconciles exact upcoming tracks after game, mode, and advanced-filter changes', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore

    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-focus-game="hsr"]').trigger('click')
    expect(queueIds(player)).toEqual(['dawn-focus', 'hollow-chill', 'harbour-sleep'])

    await wrapper.get('[data-filter-tab="sleep"]').trigger('click')
    expect(queueIds(player)).toEqual(['harbour-sleep'])

    // Amber appears only on the focus track, which the sleep mode already excludes, so
    // this relation is an empty intersection reached through a live filter.
    await wrapper.get('[data-filter-relation="character:amber"]').trigger('click')
    expect(queueIds(player)).toEqual([])
    expect(player.currentTrack.value).toBeUndefined()
    expect(player.playbackGeneration.value).toBe(0)
    expect(player.status.value).toBe('idle')
  })

  it('repopulates after an actual filter change even when matching IDs and order stay the same', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore

    expect(player.removeQueueIndex(1)).toBe(true)
    expect(queueIds(player)).toEqual(['dawn-focus', 'hollow-chill', 'harbour-sleep'])

    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-filter-relation="event:shared"]').trigger('click')
    expect(queueIds(player)).toEqual([
      'dawn-focus',
      'hollow-chill',
      'harbour-sleep',
      'express-sleep',
    ])

    player.clearUpcomingQueue()
    expect(queueIds(player)).toEqual([])

    await wrapper.get('[data-filter-relation="event:shared"]').trigger('click')
    expect(queueIds(player)).toEqual([
      'dawn-focus',
      'express-sleep',
      'hollow-chill',
      'harbour-sleep',
    ])
  })

  it('preserves unmatched current playback and source selection while reconciling upcoming tracks', async () => {
    const playable: Playable = {
      kind: 'audio', url: 'https://media.invalid/unmatched-current.ogg', mimeType: 'audio/ogg',
    }
    runtimeRepositoryMocks.load.mockResolvedValue(new ProviderRegistry([{
      provider: { id: 'r2', resolve: vi.fn(async () => playable) },
      enabled: true,
      priority: 1,
      timeoutMs: 100,
    }]))
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    player.clearUpcomingQueue()
    await player.playNow(unmatchedTrack)
    await player.setSourceOverride('r2')
    player.reportMediaState('playing', player.playbackGeneration.value)

    const preserved = {
      attempts: player.attempts.value,
      generation: player.playbackGeneration.value,
      playable: player.playable.value,
      provider: player.activeProviderId.value,
      sourceOverride: player.sourceOverride.value,
      track: player.currentTrack.value,
    }

    await wrapper.get('[data-advanced-trigger]').trigger('click')
    await wrapper.get('[data-filter-tab="sleep"]').trigger('click')

    expect(queueIds(player)).toEqual(['unmatched-current', 'express-sleep', 'harbour-sleep'])
    expect(player.currentIndex.value).toBe(0)
    expect(player.currentTrack.value).toBe(preserved.track)
    expect(player.currentTrack.value?.id).toBe('unmatched-current')
    expect(player.queue.value.slice(player.currentIndex.value + 1).map(({ id }) => id)).not.toContain('unmatched-current')
    expect(player.playbackGeneration.value).toBe(preserved.generation)
    expect(player.activeProviderId.value).toBe(preserved.provider)
    expect(player.sourceOverride.value).toBe(preserved.sourceOverride)
    expect(player.playable.value).toBe(preserved.playable)
    expect(player.attempts.value).toBe(preserved.attempts)
    expect(player.playbackIntent.value).toBe('playing')
    expect(player.status.value).toBe('playing')
  })

  it('closes the hub synchronously when the Library panel starts a new playback generation', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    await openSection(wrapper, 'library')
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore

    const playback = player.playNow(track)
    await nextTick()

    // Choosing a track is a request to listen, not to keep reading the catalogue.
    expect(wrapper.find('[data-overlay-sheet="control-centre"]').exists()).toBe(false)
    await playback
  })

  it('keeps Playback open when a manual source change starts a new playing generation', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    await player.playNow(track)
    await openSection(wrapper, 'music')
    const playback = player.setSourceOverride('youtube')
    await nextTick()
    expect(wrapper.find('[data-overlay-sheet="control-centre"]').exists()).toBe(true)
    await playback
  })

  it('remembers the category within the session and reopens the hub where it was left', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    await openSection(wrapper, 'privacy')
    await closeControlCentre(wrapper)
    await openControlCentre(wrapper)

    expect(wrapper.get('[data-control-centre-nav="privacy"]').attributes('aria-current')).toBe('true')
    expect(wrapper.get('[data-control-centre-panel] [data-settings-section="privacy"]').element).toBeTruthy()
  })

  it('keeps the chat window as the one chat surface, closable and reopenable from the hub', async () => {
    const wrapper = mount(StudyWorkspace, {
      attachTo: document.body,
      global: { stubs: workspaceStubs },
    })

    // A fresh load keeps chat out of the resting scene.
    expect(wrapper.find('[data-floating-chat]').exists()).toBe(false)

    await openSection(wrapper, 'chat')
    expect(wrapper.find('[data-chat-window-state]').exists()).toBe(false)
    const openButton = wrapper.get('[data-control-centre-open-chat]')
    ;(openButton.element as HTMLButtonElement).focus()
    await openButton.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-floating-chat]').exists()).toBe(true)
    expect(wrapper.find('[data-overlay-sheet="control-centre"]').exists()).toBe(false)
    expect(wrapper.get('[data-focus-control-centre]').element).toBe(document.activeElement)

    await openSection(wrapper, 'chat')
    expect(wrapper.get('[data-chat-window-state]').text()).toBe('The chat window is open.')
    expect(wrapper.find('[data-control-centre-open-chat]').exists()).toBe(false)
    // One chat surface: the hub offers an action on the floating window rather than
    // mounting a second live chat inside itself.
    expect(wrapper.findAll('[data-chat-panel]')).toHaveLength(1)
    expect(wrapper.find('[data-control-centre-panel] [data-chat-panel]').exists()).toBe(false)

    // Focus lands on the window itself rather than on a control inside it, so the user
    // arrives at the top of the window and tabs in from there.
    await wrapper.get('[data-control-centre-focus-chat]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-overlay-sheet="control-centre"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-floating-chat]').element)

    // Closing hands focus to the bar's activation surface, which is always present and is
    // where the recovery path starts.
    await wrapper.get('[data-floating-chat-close]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-floating-chat]').exists()).toBe(false)
    expect(wrapper.get('[data-focus-control-centre]').element).toBe(document.activeElement)

    await openSection(wrapper, 'chat')
    expect(wrapper.find('[data-chat-window-state]').exists()).toBe(false)
    await wrapper.get('[data-control-centre-open-chat]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-floating-chat]').element).toBeTruthy()
    expect(wrapper.find('[data-overlay-sheet="control-centre"]').exists()).toBe(false)
    expect(wrapper.get('[data-focus-control-centre]').element).toBe(document.activeElement)
  })

  it('never mounts or marks official media active while any sheet owns the visual layer, then restores it on close', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const playerBar = wrapper.getComponent(PlayerBar)
    const player = playerBar.props('store') as PlaybackStore
    ;(player.playable as Ref<Playable | null>).value = { kind: 'youtube', videoId: 'abcdefghijk' }
    await nextTick()

    expect(wrapper.get('[data-workspace="cinematic"]').attributes('data-active-official-player')).toBe('true')
    const officialInstance = wrapper.get('[data-youtube-player]').element

    for (const section of ['focus', 'library', 'chat', 'application']) {
      await openSection(wrapper, section)

      expect(playerBar.props('mediaSuspended'), section).toBe(true)
      expect(wrapper.get('[data-workspace="cinematic"]').attributes('data-active-official-player'), section).toBe('false')
      expect(playerBar.attributes('inert'), section).toBe('true')
      expect(playerBar.attributes('aria-hidden'), section).toBe('true')
      expect(wrapper.get('[data-youtube-player]').element, section).toBe(officialInstance)

      await closeControlCentre(wrapper)

      expect(playerBar.props('mediaSuspended'), section).toBe(false)
      expect(wrapper.get('[data-workspace="cinematic"]').attributes('data-active-official-player'), section).toBe('true')
      expect(playerBar.attributes('inert'), section).toBeUndefined()
      expect(playerBar.attributes('aria-hidden'), section).toBeUndefined()
      expect(wrapper.get('[data-youtube-player]').element, section).toBe(officialInstance)
    }
  })

  it('gives playback and Settings the same provider-preference store', async () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    const options = vi.mocked(createRuntimeProviderRepository).mock.calls.at(-1)?.[0]
    const sharedStore = options?.providerPreferences
    expect(sharedStore).toBeDefined()
    expect(sharedStore!.revision()).toBe(0)
    expect(sharedStore!.isDisabled('lx-huibq')).toBe(false)

    await openSection(wrapper, 'music')
    const settings = wrapper.getComponent({ name: 'SettingsSheet' })

    expect(settings.props('providerPreferences')).toBe(sharedStore)
    expect(settings.props('providerRepository')).toBe(runtimeRepositoryMocks)
  })

  it('invalidates speculative preload when provider preferences change', () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    const invalidatePreload = vi.spyOn(player, 'invalidatePreload')
    const preferences = vi.mocked(createRuntimeProviderRepository).mock.calls.at(-1)?.[0]
      ?.providerPreferences as ProviderPreferencesStore

    // 'lx' is one of the three user-toggleable top-level providers. The legacy 'r2'
    // identity is still a custom runtime-provider fixture elsewhere in this suite, but
    // the preference store rejects it, so it would never notify.
    preferences.setDisabled('lx', true)

    expect(invalidatePreload).toHaveBeenCalledOnce()
  })

  it('invalidates speculative preload when the playback quality changes', () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    const invalidatePreload = vi.spyOn(player, 'invalidatePreload')

    // A prepared next track was resolved at the previous tier, so promoting it after a quality
    // change would play the old quality. The change must therefore drop the preparation; the
    // player re-arms it at the new tier once the active track is inside its lead window.
    const quality = getDefaultPlaybackQualityPreferencesStore()
    quality.setChkszQuality('lossless')

    expect(invalidatePreload).toHaveBeenCalledOnce()
  })

  it('mounts the public notice centre', () => {
    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })

    expect(wrapper.findComponent({ name: 'NoticeCentre' }).exists()).toBe(true)
  })

  it('updates runtime state to published and injects Jellyfin sources into player when /api/catalogue succeeds', async () => {
    vi.stubEnv('VITE_ENABLE_DEMO_CATALOG', 'false')
    catalogMocks.tracks = controlledCatalogue.slice(0, 3)
    let deliver!: (catalogue: { revision: string; tracks: Track[] }) => void
    remoteMocks.load.mockImplementationOnce(() =>
      new Promise<{ revision: string; tracks: Track[] }>((resolve) => { deliver = resolve }))
    const resolve = vi.fn(async (track: Track): Promise<Playable> => ({
      kind: 'audio',
      url: 'https://media.invalid/jellyfin/' + track.id,
      mimeType: 'audio/mpeg',
    }))
    runtimeRepositoryMocks.load.mockResolvedValue(new ProviderRegistry([{
      provider: { id: 'jellyfin', resolve }, enabled: true, priority: 1, timeoutMs: 100,
    }]))

    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    const player = wrapper.getComponent(PlayerBar).props('store') as PlaybackStore
    await nextTick()
    expect(wrapper.get('main').attributes('data-catalogue-status')).toBe('loading')

    const jellyfinReplacement: Track[] = catalogMocks.tracks.map((track) => ({
      ...track,
      sources: [
        { provider: 'jellyfin', externalId: `jf-${track.id}` },
        { provider: 'chksz', externalId: `chk-${track.id}` },
      ],
    }))

    deliver({ revision: '3', tracks: jellyfinReplacement })
    await flushPromises()

    expect(wrapper.get('main').attributes('data-catalogue-status')).toBe('published')
    expect(player.queue.value).toEqual(jellyfinReplacement)
    expect(player.queue.value[0].sources.some((s) => s.provider === 'jellyfin')).toBe(true)
    expect(player.queue.value[0].sources.some((s) => s.provider === 'r2')).toBe(false)
    wrapper.unmount()
  })

  it('transitions runtime state to fallback when /api/catalogue fetch fails', async () => {
    vi.stubEnv('VITE_ENABLE_DEMO_CATALOG', 'false')
    catalogMocks.tracks = controlledCatalogue.slice(0, 3)
    remoteMocks.load.mockRejectedValueOnce(new Error('catalogue_unavailable'))

    const wrapper = mount(StudyWorkspace, { global: { stubs: workspaceStubs } })
    await flushPromises()

    expect(wrapper.get('main').attributes('data-catalogue-status')).toBe('fallback')
    wrapper.unmount()
  })
})
