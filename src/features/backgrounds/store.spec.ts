import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createBackgroundStore, BACKGROUND_PLAYBACK_STORAGE_KEY, BACKGROUND_SELECTION_STORAGE_KEY, sanitizeBackgroundSelection } from './store'
import { BACKGROUND_OVERRIDES_STORAGE_KEY } from './overrides'
import type { BackgroundRepository, PublicBackground } from './types'

const background = (id: string, kind: 'image' | 'video' = 'image'): PublicBackground => ({
  id,
  revision: 1,
  status: 'published',
  kind,
  contentType: kind === 'image' ? 'image/png' : 'video/mp4',
  byteSize: 100,
  width: 1920,
  height: 1080,
  durationMs: kind === 'video' ? 10_000 : null,
  mediaUrl: `/api/backgrounds/${id}/media`,
  posterUrl: kind === 'video' ? `/api/backgrounds/${id}/poster` : null,
  rightsStatus: 'not-reviewed',
  createdAt: 1,
  updatedAt: 1,
  publishedAt: 1,
  archivedAt: null,
})

const memoryStorage = (initial?: string, playback?: string) => {
  const values = new Map<string, string>()
  if (initial) values.set('study-with-hoyomix.background-selection', initial)
  if (playback) values.set(BACKGROUND_PLAYBACK_STORAGE_KEY, playback)
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, next: string) => { values.set(key, next) }),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
  }
}

const repository = (items: PublicBackground[]): BackgroundRepository => ({
  list: vi.fn().mockResolvedValue(items),
  getAccountSelection: vi.fn().mockResolvedValue(null),
  saveAccountSelection: vi.fn(async (selection) => selection),
})

describe('background selection sanitising', () => {
  it('keeps unique published IDs in order and bounds them to eight', () => {
    const items = Array.from({ length: 10 }, (_, index) => background(`background-${index}`))
    expect(sanitizeBackgroundSelection([
      'background-0', 'missing', 'background-0',
      ...items.slice(1).map(({ id }) => id),
    ], items)).toEqual(items.slice(0, 8).map(({ id }) => id))
  })
})

describe('background rotation store', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('starts without media before the operator supplies a catalogue', () => {
    const store = createBackgroundStore({ storage: memoryStorage() })
    expect(store.current.value).toBeNull()
    expect(store.backgrounds.value).toEqual([])
    expect(store.selection.value.selectedIds).toEqual([])
    store.destroy()
  })

  it('keeps empty local choices empty after an empty published catalogue', async () => {
    const storage = memoryStorage()
    const store = createBackgroundStore({ repository: repository([]), storage })
    await store.load()
    expect(store.current.value).toBeNull()
    expect(store.next.value).toBeNull()
    expect(store.selection.value.selectedIds).toEqual([])
    store.destroy()
  })

  it('chooses an available original scene without privileging a removed asset ID', async () => {
    const store = createBackgroundStore({
      repository: repository([background('original-scene', 'video'), background('zzz-belle-lofi-girl', 'video')]),
      storage: memoryStorage(),
    })
    await store.load()
    expect(store.current.value?.id).toBe('original-scene')
    expect(store.selection.value.selectedIds).toEqual(['original-scene'])
    store.destroy()
  })

  it('manually advances selected catalogue order even with automatic rotation off', async () => {
    const store = createBackgroundStore({ repository: repository(['a', 'b', 'c'].map(id => background(id, 'video'))), storage: memoryStorage(JSON.stringify({ selectedIds: ['b', 'a'], autoRotate: false, intervalSeconds: 15 })) })
    await store.load(); store.setPlaybackMode('sequential')
    store.nextBackground()
    expect(store.current.value?.id).toBe('a')
    expect(store.selection.value.selectedIds).toEqual(['b', 'a'])
    expect(store.selection.value.autoRotate).toBe(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(store.current.value?.id).toBe('a')
    store.destroy()
  })

  it('lets a single selected scene browse the catalogue without enabling rotation', async () => {
    const store = createBackgroundStore({ repository: repository(['a', 'b'].map(id => background(id, 'video'))), storage: memoryStorage(JSON.stringify({ selectedIds: ['a'], autoRotate: false, intervalSeconds: 15 })) })
    await store.load(); store.nextBackground()
    expect(store.current.value?.id).toBe('b')
    expect(store.selection.value.selectedIds).toEqual(['b'])
    store.destroy()
  })

  it('keeps a manual target when a late catalogue refresh resolves with automatic rotation off', async () => {
    const items = ['a', 'b'].map(id => background(id, 'video'))
    const repo = repository(items)
    const store = createBackgroundStore({repository:repo,storage:memoryStorage(JSON.stringify({selectedIds:['a','b'],autoRotate:false,intervalSeconds:1200}))})
    await store.load();store.setPlaybackMode('sequential')
    let resolveList!: (items: PublicBackground[]) => void
    vi.mocked(repo.list).mockImplementationOnce(()=>new Promise<PublicBackground[]>(resolve=>{resolveList=resolve}))
    const refreshing = store.load()
    store.nextBackground()
    expect(store.current.value?.id).toBe('b')
    resolveList(items);await refreshing
    expect(store.current.value?.id).toBe('b')
    expect(store.next.value?.id).toBe('a')
    expect(store.selection.value.selectedIds).toEqual(['a','b'])
    store.destroy()
  })

  it('persists Auto/native quality independently without resetting rotation', async () => {
    const storage = memoryStorage(JSON.stringify({ selectedIds: ['a', 'b'], autoRotate: true, intervalSeconds: 15 }))
    const repo = repository([background('a', 'video'), background('b', 'video')])
    const store = createBackgroundStore({ repository: repo, storage })
    await store.load(); store.setPlaybackMode('sequential')
    expect(store.qualityMode.value).toBe('auto')
    await vi.advanceTimersByTimeAsync(10_000)
    store.setQualityMode('native')
    const restored = createBackgroundStore({ repository: repo, storage })
    expect(restored.qualityMode.value).toBe('native')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.current.value?.id).toBe('b')
    expect(store.selection.value.selectedIds).toEqual(['a', 'b'])
    store.onVideoError()
    expect(store.usingPoster.value).toBe(true)
    store.setQualityMode('auto')
    expect(store.usingPoster.value).toBe(false)
    store.destroy(); restored.destroy()
  })
  it('restores the 1440p preference without moving the rotation deadline', async () => {
    const storage = memoryStorage(JSON.stringify({ selectedIds: ['a', 'b'], autoRotate: true, intervalSeconds: 15 }))
    const repo = repository([background('a', 'video'), background('b', 'video')])
    const store = createBackgroundStore({ repository: repo, storage })
    await store.load(); store.setPlaybackMode('sequential')
    await vi.advanceTimersByTimeAsync(10_000)
    store.setQualityMode('1440p')
    const restored = createBackgroundStore({ repository: repo, storage })
    expect(restored.qualityMode.value).toBe('1440p')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.current.value?.id).toBe('b')
    store.destroy(); restored.destroy()
  })

  it('selects a default video for first visits and empty stored selections', async () => {
    for (const initial of [undefined, JSON.stringify({ selectedIds: [], autoRotate: true, intervalSeconds: 1200 })]) {
      const store = createBackgroundStore({ repository: repository([background('image'), background('zzz-urban-stroll-anby-billy', 'video')]), storage: memoryStorage(initial) })
      await store.load()
      expect(store.current.value?.id).toBe('zzz-urban-stroll-anby-billy')
      expect(store.selection.value.selectedIds).toEqual(['zzz-urban-stroll-anby-billy'])
      store.destroy()
    }
  })

  it('does not discard stored API IDs while the shipped catalogue starts before API load', async () => {
    const item = background('remote', 'video')
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ backgrounds: [item] })))
    const storage = memoryStorage(JSON.stringify({ selectedIds: ['remote'], autoRotate: true, intervalSeconds: 1200 }))
    const store = createBackgroundStore({ storage })
    try {
      expect(store.selection.value.selectedIds).toEqual(['remote'])
      await store.load()
      expect(store.current.value?.id).toBe('remote')
    } finally { store.destroy(); fetcher.mockRestore() }
  })

  it('restores rotation and interval with saved background videos on a fresh device', async () => {
    const saved = { selectedIds: ['remote'], autoRotate: false, intervalSeconds: 600 as const }
    const repo = repository([background('zzz-belle-lofi-girl', 'video'), background('remote', 'video')])
    vi.mocked(repo.getAccountSelection).mockResolvedValue(saved)
    const store = createBackgroundStore({ repository: repo, storage: memoryStorage() })
    await store.syncAuthenticated()
    expect(store.selection.value).toEqual(saved)
    expect(repo.saveAccountSelection).not.toHaveBeenCalled()
    store.destroy()
  })

  it('restores eight account choices without an implicit default deleting the eighth', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `remote-${i}`)
    const repo = repository([background('zzz-urban-stroll-anby-billy', 'video'), ...ids.map(id => background(id))])
    vi.mocked(repo.getAccountSelection).mockResolvedValue({ selectedIds: ids, autoRotate: true, intervalSeconds: 1200 })
    const store = createBackgroundStore({ repository: repo, storage: memoryStorage() })
    await store.load(); await store.syncAuthenticated()
    expect(store.selection.value.selectedIds).toEqual(ids)
    expect(repo.saveAccountSelection).not.toHaveBeenCalled()
    store.destroy()
  })

  it('keeps the default implicit across a reload before restoring a full account selection', async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `remote-${i}`)
    const repo = repository([background('zzz-urban-stroll-anby-billy', 'video'), ...ids.map(id => background(id))])
    const storage = memoryStorage()
    const first = createBackgroundStore({ repository: repo, storage })
    await first.load(); first.destroy()
    vi.mocked(repo.getAccountSelection).mockResolvedValue({ selectedIds: ids, autoRotate: true, intervalSeconds: 1200 })
    const reloaded = createBackgroundStore({ repository: repo, storage })
    await reloaded.syncAuthenticated()
    expect(reloaded.selection.value.selectedIds).toEqual(ids)
    reloaded.destroy()
  })

  it('advances to the queued random background without drawing a different target', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const store = createBackgroundStore({
      repository: repository([background('a', 'video'), background('b', 'video'), background('c', 'video')]),
      storage: memoryStorage(JSON.stringify({ selectedIds: ['a', 'b', 'c'], autoRotate: true, intervalSeconds: 15 })),
    })
    try {
      await store.load()
      expect(store.next.value?.id).toBe('b')
      random.mockReturnValue(0.99)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(store.current.value?.id).toBe('b')
    } finally {
      store.destroy()
      random.mockRestore()
    }
  })

  it('rotates sequentially in catalogue order even when choices were selected backwards', async () => {
    const store = createBackgroundStore({
      repository: repository([background('a'), background('b'), background('c')]),
      storage: memoryStorage(JSON.stringify({ selectedIds: ['c', 'b', 'a'], autoRotate: true, intervalSeconds: 15 })),
    })
    try {
      store.setPlaybackMode('sequential')
      await store.load()
      expect(store.current.value?.id).toBe('c')
      expect(store.next.value?.id).toBe('a')
      await vi.advanceTimersByTimeAsync(15_000)
      expect(store.current.value?.id).toBe('a')
      expect(store.next.value?.id).toBe('b')
    } finally { store.destroy() }
  })

  it('rotates image and video backgrounds by interval without immediately repeating', async () => {
    const items = [background('a'), background('b', 'video'), background('c')]
    const store = createBackgroundStore({
      repository: repository(items),
      storage: memoryStorage(JSON.stringify({ selectedIds: ['a', 'b', 'c'], autoRotate: true, intervalSeconds: 15 })),
    })
    // The first-use default is Random, so an order-sensitive scenario asks for
    // the ordered mode the way a user would.
    store.setPlaybackMode('sequential')
    await store.load()
    expect(store.current.value?.id).toBe('a')
    // The next background is always queued one slot ahead for preloading.
    expect(store.next.value?.id).toBe('b')
    await vi.advanceTimersByTimeAsync(15_000)
    // Videos loop internally, so the interval alone moves the rotation on.
    expect(store.current.value?.id).toBe('b')
    expect(store.next.value?.id).toBe('c')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.current.value?.id).toBe('c')
    expect(store.next.value?.id).toBe('a')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.current.value?.id).toBe('a')
    store.destroy()
  })

  it('queues the next background for every mode and keeps random from repeating', async () => {
    const items = [background('a'), background('b', 'video'), background('c')]
    const storage = memoryStorage(JSON.stringify({ selectedIds: ['a', 'b', 'c'], autoRotate: true, intervalSeconds: 15 }))
    const store = createBackgroundStore({ repository: repository(items), storage })
    await store.load()
    store.setPlaybackMode('random')
    expect(store.playbackMode.value).toBe('random')
    for (let step = 0; step < 24; step += 1) {
      expect(store.next.value).not.toBeNull()
      expect(store.next.value?.id).not.toBe(store.current.value?.id)
      await vi.advanceTimersByTimeAsync(15_000)
    }
    expect(storage.setItem).toHaveBeenCalled()
    store.setPlaybackMode('sequential')
    expect(store.playbackMode.value).toBe('sequential')
    store.destroy()
  })

  it('starts a first-time user on Random order with a twenty-minute rotation', async () => {
    const store = createBackgroundStore({
      repository: repository([background('a'), background('b')]),
      storage: memoryStorage(),
    })
    await store.load()
    expect(store.playbackMode.value).toBe('random')
    expect(store.selection.value).toEqual({ selectedIds: [], autoRotate: true, intervalSeconds: 1_200 })
    // The default is only a starting point; an explicit choice always wins.
    store.setPlaybackMode('sequential')
    expect(store.playbackMode.value).toBe('sequential')
    store.destroy()
  })

  it('keeps a stored order and an older interval, and writes a canonical value once chosen', async () => {
    const storage = memoryStorage(
      JSON.stringify({ selectedIds: ['a', 'b'], autoRotate: true, intervalSeconds: 300 }),
      JSON.stringify({ playbackMode: 'sequential' }),
    )
    const store = createBackgroundStore({ repository: repository([background('a'), background('b')]), storage })
    await store.load()
    expect(store.selection.value.intervalSeconds).toBe(300)
    expect(store.playbackMode.value).toBe('sequential')

    store.setInterval(600)
    expect(store.selection.value.intervalSeconds).toBe(600)
    expect(JSON.parse(storage.getItem(BACKGROUND_SELECTION_STORAGE_KEY) ?? '{}')).toMatchObject({ intervalSeconds: 600 })
    store.destroy()
  })

  it('falls back to the twenty-minute default when the stored interval is unknown', () => {
    const store = createBackgroundStore({
      repository: repository([background('a')]),
      storage: memoryStorage(JSON.stringify({ selectedIds: ['a'], autoRotate: true, intervalSeconds: 45 })),
    })
    expect(store.selection.value.intervalSeconds).toBe(1_200)
    store.destroy()
  })

  it('restores the stored playback mode and skips a background that fails to preload', async () => {
    const items = [background('a'), background('b', 'video'), background('c', 'video')]
    const storage = memoryStorage(
      JSON.stringify({ selectedIds: ['a', 'b', 'c'], autoRotate: true, intervalSeconds: 15 }),
      JSON.stringify({ playbackMode: 'random' }),
    )
    const store = createBackgroundStore({ repository: repository(items), storage })
    expect(store.playbackMode.value).toBe('random')
    await store.load()
    expect(store.next.value?.id).not.toBe('a')
    const queued = store.next.value?.id
    expect(queued).not.toBeNull()
    store.onPreloadError(queued as string)
    expect(store.next.value?.id).not.toBe(queued)
    expect(store.next.value?.id).not.toBeNull()
    store.destroy()
  })

  it('stops rotating once the remaining selected background has failed', async () => {
    const store = createBackgroundStore({
      repository: repository([background('video', 'video'), background('image')]),
      storage: memoryStorage(JSON.stringify({ selectedIds: ['video', 'image'], autoRotate: true, intervalSeconds: 15 })),
    })
    await store.load()
    store.onVideoError()
    expect(store.current.value?.id).toBe('video')
    await vi.advanceTimersByTimeAsync(3_000)
    // The broken video is skipped, so the poster fallback advances once and the
    // rotation rests on the only background that still loads.
    expect(store.current.value?.id).toBe('image')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.current.value?.id).toBe('image')
    expect(store.selection.value.selectedIds).toEqual(['video', 'image'])
    store.destroy()
  })

  it('uses the first selected background without rotation when auto-rotate is disabled', async () => {
    const store = createBackgroundStore({
      repository: repository([background('a'), background('b')]),
      storage: memoryStorage(JSON.stringify({ selectedIds: ['a', 'b'], autoRotate: false, intervalSeconds: 15 })),
    })
    await store.load()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.current.value?.id).toBe('a')
    store.destroy()
  })

  it('treats video as a timed poster under low-power, reduced-motion, or Save-Data policy', async () => {
    const store = createBackgroundStore({
      repository: repository([background('video', 'video'), background('image')]),
      storage: memoryStorage(JSON.stringify({ selectedIds: ['video', 'image'], autoRotate: true, intervalSeconds: 15 })),
    })
    await store.load()
    store.setPlaybackPolicy({ lowPower: true, reducedMotion: false, saveData: false })
    expect(store.usingPoster.value).toBe(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.current.value?.id).toBe('image')
    store.destroy()
  })

  it('pauses internal rotation while hidden and resumes without changing Pomodoro state', async () => {
    const store = createBackgroundStore({
      repository: repository([background('a'), background('b')]),
      storage: memoryStorage(JSON.stringify({ selectedIds: ['a', 'b'], autoRotate: true, intervalSeconds: 15 })),
    })
    await store.load()
    store.setVisible(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.current.value?.id).toBe('a')
    store.setVisible(true)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.current.value?.id).toBe('b')
    store.destroy()
  })

  it('shows a failed video poster before advancing', async () => {
    const store = createBackgroundStore({
      repository: repository([background('video', 'video'), background('image')]),
      storage: memoryStorage(JSON.stringify({ selectedIds: ['video', 'image'], autoRotate: true, intervalSeconds: 15 })),
    })
    await store.load()
    store.onVideoError()
    expect(store.usingPoster.value).toBe(true)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(store.current.value?.id).toBe('video')
    await vi.advanceTimersByTimeAsync(1)
    expect(store.current.value?.id).toBe('image')
    store.destroy()
  })

  it('removes missing or archived IDs on reload and falls back to the default scene', async () => {
    const storage = memoryStorage(JSON.stringify({
      selectedIds: ['missing'], autoRotate: true, intervalSeconds: 30,
    }))
    const store = createBackgroundStore({ repository: repository([]), storage })
    await store.load()
    expect(store.selection.value.selectedIds).toEqual([])
    expect(store.current.value).toBeNull()
    expect(storage.setItem).toHaveBeenCalled()
    store.destroy()
  })

  it('rejects a ninth selection and leaves local choices unchanged', async () => {
    const items = Array.from({ length: 9 }, (_, index) => background(`background-${index}`))
    const store = createBackgroundStore({ repository: repository(items), storage: memoryStorage() })
    await store.load()
    for (const item of items.slice(0, 8)) expect(store.toggle(item.id, true)).toBe(true)
    expect(store.toggle(items[8].id, true)).toBe(false)
    expect(store.selection.value.selectedIds).toHaveLength(8)
    expect(store.error.value).toBe('selection_limit')
    store.destroy()
  })

  it('still builds when browser policy denies the localStorage getter', async () => {
    // Safari private browsing and blocked-cookie modes throw on the property
    // access itself, not only on getItem, so construction must survive it.
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Storage denied', 'SecurityError') },
    })
    try {
      const store = createBackgroundStore({ repository: repository([background('a')]) })
      await store.load()
      expect(store.selection.value.selectedIds).toEqual([])
      expect(store.toggle('a', true)).toBe(true)
      expect(store.selection.value.selectedIds).toEqual(['a'])
      store.destroy()
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original)
      else Reflect.deleteProperty(window, 'localStorage')
    }
  })

  it('keeps local state usable when authenticated sync fails', async () => {
    const repo = repository([background('a')])
    vi.mocked(repo.getAccountSelection).mockRejectedValue(new Error('network'))
    const store = createBackgroundStore({ repository: repo, storage: memoryStorage() })
    await store.load()
    store.toggle('a', true)
    await expect(store.syncAuthenticated()).resolves.toBe(false)
    expect(store.selection.value.selectedIds).toEqual(['a'])
    expect(store.syncStatus.value).toBe('failed')
    store.destroy()
  })
})

it('keeps newer local background choices when a save response arrives late', async () => {
  const repo = repository([background('a', 'video'), background('b', 'video')])
  const store = createBackgroundStore({ repository: repo, storage: memoryStorage(JSON.stringify({ selectedIds: ['a'], autoRotate: true, intervalSeconds: 1200 })) })
  await store.load()
  let finish!: (value: typeof store.selection.value) => void
  vi.mocked(repo.saveAccountSelection).mockImplementation(() => new Promise<typeof store.selection.value>(resolve => { finish = resolve }))
  const sync = store.pushAuthenticated({ ...store.selection.value, selectedIds: [...store.selection.value.selectedIds] })
  await vi.waitFor(() => expect(repo.saveAccountSelection).toHaveBeenCalledOnce())
  const old = { ...store.selection.value, selectedIds: [...store.selection.value.selectedIds] }
  store.toggle('b', true)
  store.setAutoRotate(false)
  finish(old)
  await sync
  expect(store.selection.value.selectedIds).toEqual(['a', 'b'])
  expect(store.selection.value.autoRotate).toBe(false)
  store.destroy()
})

it('refuses to sync background selections while availability overrides are quarantined', async () => {
  const selectedIds = ['zzz-urban-stroll-anby-billy', 'zzz-urban-stroll-koleda-ben']
  const saved = JSON.stringify({ selectedIds, autoRotate: false, intervalSeconds: 1200 })
  const storage = memoryStorage(saved)
  storage.getItem = vi.fn((key: string) => {
    if (key === BACKGROUND_SELECTION_STORAGE_KEY) return saved
    if (key === BACKGROUND_OVERRIDES_STORAGE_KEY) return '{corrupted'
    return null
  })
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/backgrounds/overrides') {
      return new Response(JSON.stringify({ overrides: [{ id: 'zzz-urban-stroll-anby-billy', status: 'invalid-status' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/api/backgrounds') {
      return new Response(JSON.stringify({ backgrounds: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === '/api/account/background-selection') {
      return new Response(JSON.stringify({ selection: { selectedIds, autoRotate: false, intervalSeconds: 1200 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
  try {
    const store = createBackgroundStore({ storage })
    await store.load()
    const syncResult = await store.syncAuthenticated()
    expect(syncResult).toBe(false)
    expect(store.syncStatus.value).toBe('failed')
    expect(store.selection.value.selectedIds).toEqual(selectedIds)
    expect(fetcher).not.toHaveBeenCalledWith('/api/account/background-selection', expect.objectContaining({ method: 'PUT' }))
  } finally {
    vi.unstubAllGlobals()
  }
})
