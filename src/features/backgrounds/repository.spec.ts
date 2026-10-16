vi.mock('./staticDefinitions', async () => import('../../test/fixtures/staticBackgrounds'))
import { describe, expect, it, vi } from 'vitest'

import { listStaticBackgrounds } from './catalogue'
import { BACKGROUND_OVERRIDES_STORAGE_KEY } from './overrides'
import { createBackgroundRepository } from './repository'
import { createBackgroundStore, BACKGROUND_SELECTION_STORAGE_KEY } from './store'
import type { PublicBackground } from './types'

const apiRow = (id: string): PublicBackground => ({
  id,
  revision: 1,
  status: 'published',
  kind: 'image',
  contentType: 'image/png',
  byteSize: 10,
  width: 64,
  height: 64,
  durationMs: null,
  mediaUrl: `/api/backgrounds/${id}/media`,
  posterUrl: null,
  rightsStatus: 'not-reviewed',
  createdAt: 1,
  updatedAt: 1,
  publishedAt: 1,
  archivedAt: null,
})

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

/** Minimal in-memory storage so cache behaviour can be asserted directly. */
const memoryStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
  }
}

const DISABLED = 'zzz-astra-yao'

describe('background repository catalogue merge', () => {
  it('syncs shipped video IDs together with published API IDs', async () => {
    const shipped = listStaticBackgrounds()[0].id
    const selection = { selectedIds: [shipped, '11111111-1111-4111-8111-111111111111'], autoRotate: true, intervalSeconds: 1200 as const }
    let submitted: unknown
    const fetcher = vi.fn(async (_url, init) => {
      submitted = JSON.parse(init.body)
      return jsonResponse({ selection: submitted })
    })
    const repository = createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch })
    expect(await repository.saveAccountSelection(selection)).toEqual(selection)
    expect(submitted).toEqual(selection)
  })
  it('returns published API rows together with the shipped catalogue', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ backgrounds: [apiRow('api-one')] }))
    const repository = createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch })

    const rows = await repository.list()

    expect(rows.map(({ id }) => id)).toEqual(['api-one', ...listStaticBackgrounds().map(({ id }) => id)])
    expect(fetcher).toHaveBeenCalledWith('/api/backgrounds', expect.objectContaining({ credentials: 'same-origin' }))
  })

  it('rejects an unavailable published API instead of claiming a complete catalogue', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'))
    const repository = createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch })

    await expect(repository.list()).rejects.toThrow('offline')
  })

  it('rejects a malformed published payload instead of sanitising preferences against it', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ backgrounds: 'not-a-list' }))
    const repository = createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch })

    await expect(repository.list()).rejects.toThrow('background_invalid_response')
  })

  it('preserves saved API selection and refuses account writes while the catalogue is unavailable', async () => {
    const selection = {selectedIds:['11111111-1111-4111-8111-111111111111'],autoRotate:true,intervalSeconds:1200 as const}
    const original = JSON.stringify(selection)
    const storage = new Map([[BACKGROUND_SELECTION_STORAGE_KEY,original]])
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'))
    const store = createBackgroundStore({repository:createBackgroundRepository({fetch:fetcher}),storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value)}}})
    await store.load()
    expect(store.selection.value).toEqual(selection)
    expect(storage.get(BACKGROUND_SELECTION_STORAGE_KEY)).toBe(original)
    expect(await store.syncAuthenticated()).toBe(false)
    expect(fetcher.mock.calls.every(([url])=>url==='/api/backgrounds')).toBe(true)
    expect(storage.get(BACKGROUND_SELECTION_STORAGE_KEY)).toBe(original)
    store.destroy()
  })
})

describe('background overrides never fail open', () => {
  it('restores a cached-disabled background after an explicit valid published response', async () => {
    const storage = memoryStorage({ [BACKGROUND_OVERRIDES_STORAGE_KEY]: JSON.stringify({ version: 1, overrides: [{ id: DISABLED, status: 'archived' }] }) })
    const fetcher = vi.fn(async (url: string) => jsonResponse(url === '/api/backgrounds/overrides'
      ? { overrides: [{ id: DISABLED, status: 'published', title: null, game: null, collection: null, displayOrder: null, updatedAt: 10 }] }
      : { backgrounds: [] }))
    expect((await createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch, storage }).list()).map(item => item.id)).toContain(DISABLED)
    expect(JSON.parse(storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)!).overrides[0].status).toBe('published')
  })

  it.each([
    { overrides: [{ id: 'zzz-ellen-joe', status: 'published' }, { id: DISABLED, status: 7 }] },
    { overrides: [{ id: 'zzz-ellen-joe', status: 'published' }, { id: DISABLED, status: 'invalid' }] },
    { overrides: [{ id: DISABLED, status: 'archived' }, { id: DISABLED, status: 'published' }] },
    { overrides: [{ id: DISABLED, status: 'published', title: false }] },
  ])('preserves the verified disable and exact cache after a poisoned partial response: %j', async (malformed) => {
    const storage = memoryStorage()
    let payload: unknown = { overrides: [{ id: DISABLED, status: 'archived' }] }
    const fetcher = vi.fn(async (url: string) => jsonResponse(url === '/api/backgrounds/overrides' ? payload : { backgrounds: [] }))
    const repository = createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch, storage })
    expect((await repository.list()).map(item => item.id)).not.toContain(DISABLED)
    const verified = storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)
    payload = malformed
    expect((await repository.list()).map(item => item.id)).not.toContain(DISABLED)
    expect(storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe(verified)
    // A new repository on reload must still see the original restriction.
    expect((await createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch, storage }).list()).map(item => item.id)).not.toContain(DISABLED)
    payload = { overrides: [] }
    expect((await repository.list()).map(item => item.id)).toContain(DISABLED)
    expect(storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe(JSON.stringify({ version: 1, overrides: [] }))
  })

  it.each(['http', 'json', 'network'])('preserves cached decisions after %s failure', async (failure) => {
    const original = JSON.stringify({ version: 1, overrides: [{ id: DISABLED, status: 'tombstoned' }] })
    const storage = memoryStorage({ [BACKGROUND_OVERRIDES_STORAGE_KEY]: original })
    const fetcher = vi.fn(async (url: string) => {
      if (url !== '/api/backgrounds/overrides') return jsonResponse({ backgrounds: [] })
      if (failure === 'network') throw new Error('offline')
      return new Response(failure === 'json' ? '{' : '', { status: failure === 'http' ? 503 : 200 })
    })
    expect((await createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch, storage }).list()).map(item => item.id)).not.toContain(DISABLED)
    expect(storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe(original)
  })

  it('applies a verified override and hides the disabled shipped background', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/backgrounds/overrides'
      ? jsonResponse({ overrides: [{ id: DISABLED, status: 'archived' }] })
      : jsonResponse({ backgrounds: [] }))
    const repository = createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch })

    const rows = await repository.list()

    expect(rows.map(({ id }) => id)).not.toContain(DISABLED)
    expect(rows).toHaveLength(listStaticBackgrounds().length - 1)
  })

  it('keeps honouring the last verified overrides when the endpoint later fails', async () => {
    const storage = memoryStorage()
    let overridesReachable = true
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/backgrounds/overrides') {
        if (!overridesReachable) throw new Error('offline')
        return jsonResponse({ overrides: [{ id: DISABLED, status: 'archived' }] })
      }
      return jsonResponse({ backgrounds: [] })
    })
    const repository = createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch, storage })

    expect((await repository.list()).map(({ id }) => id)).not.toContain(DISABLED)
    expect(storage.map.has(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe(true)

    // A transient failure must not resurrect the administrator's decision.
    overridesReachable = false
    expect((await repository.list()).map(({ id }) => id)).not.toContain(DISABLED)
  })

  it('treats a malformed overrides payload as a failure instead of caching a clean bill of health', async () => {
    const storage = memoryStorage()
    const fetcher = vi.fn(async (url: string) => url === '/api/backgrounds/overrides'
      ? jsonResponse({ notOverrides: true })
      : jsonResponse({ backgrounds: [] }))
    const repository = createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch, storage })

    await repository.list()

    expect(storage.map.has(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe(false)
  })

  it('records an empty verified response so later failures stay fail-closed', async () => {
    const storage = memoryStorage()
    const fetcher = vi.fn(async (url: string) => url === '/api/backgrounds/overrides'
      ? jsonResponse({ overrides: [] })
      : jsonResponse({ backgrounds: [] }))
    const repository = createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch, storage })

    await repository.list()

    expect(storage.map.get(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe(JSON.stringify({ version: 1, overrides: [] }))
  })

  it('carries administrator metadata from the public API into the merged catalogue', async () => {
    const fetcher = vi.fn(async (url: string) => url === '/api/backgrounds/overrides'
      ? jsonResponse({ overrides: [] })
      : jsonResponse({
        backgrounds: [{
          ...apiRow('11111111-1111-4111-8111-111111111111'),
          title: 'Night Shift Study',
          game: 'genshin',
          collection: 'study-room',
          displayOrder: 4,
        }],
      }))
    const repository = createBackgroundRepository({ fetch: fetcher as unknown as typeof fetch })

    const rows = await repository.list()

    expect(rows[0]).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Night Shift Study',
      game: 'genshin',
      collection: 'study-room',
      displayOrder: 4,
    })
  })
})

describe('store availability before the first request resolves', () => {
  const disabledCache = JSON.stringify({ version: 1, overrides: [{ id: DISABLED, status: 'archived' }] })

  it.each(['sequential', 'random'] as const)('keeps cached restrictions through pending, malformed and offline reloads in %s rotation', async (mode) => {
    const original = JSON.stringify({ version: 1, overrides: [{ id: DISABLED, status: 'tombstoned' }] })
    localStorage.setItem(BACKGROUND_OVERRIDES_STORAGE_KEY, original)
    localStorage.setItem(BACKGROUND_SELECTION_STORAGE_KEY, JSON.stringify({ selectedIds: [DISABLED, 'zzz-qingyi', 'zzz-ellen-joe'], autoRotate: true, intervalSeconds: 1200 }))
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== '/api/backgrounds/overrides') return jsonResponse({ backgrounds: [] })
      await pending
      return jsonResponse({ overrides: [{ id: 'zzz-ellen-joe', status: 'published' }, { id: DISABLED, status: 7 }] })
    }))
    const store = createBackgroundStore()
    try {
      store.setPlaybackMode(mode)
      const loading = store.load()
      expect(store.backgrounds.value.map(item => item.id)).not.toContain(DISABLED)
      expect(store.selection.value.selectedIds).not.toContain(DISABLED)
      expect(store.current.value?.id).not.toBe(DISABLED)
      release()
      await loading
      expect(localStorage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe(original)
      for (let step = 0; step < 12; step++) {
        store.nextBackground()
        expect(store.current.value?.id).not.toBe(DISABLED)
        expect(store.next.value?.id).not.toBe(DISABLED)
      }
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
      const reloaded = createBackgroundStore()
      try {
        expect(reloaded.backgrounds.value.map(item => item.id)).not.toContain(DISABLED)
        await reloaded.load()
        expect(reloaded.status.value).toBe('unavailable')
        expect(reloaded.current.value?.id).not.toBe(DISABLED)
        expect(reloaded.next.value?.id).not.toBe(DISABLED)
      } finally { reloaded.destroy() }
    } finally {
      release()
      store.destroy()
      localStorage.clear()
      vi.unstubAllGlobals()
    }
  })

  it.each([
    '{broken',
    JSON.stringify({ version: 2, overrides: [{ id: DISABLED, status: 'archived' }] }),
    JSON.stringify({ version: 1, overrides: [{ id: DISABLED, status: 'archived' }, { id: 'bad', status: 'oops' }] }),
  ])('quarantines shipped backgrounds when an existing override cache cannot be trusted: %s', async (cache) => {
    const storage = memoryStorage({ [BACKGROUND_OVERRIDES_STORAGE_KEY]: cache })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const store = createBackgroundStore({ storage })
    try {
      expect(store.backgrounds.value).toEqual([])
      await store.load()
      expect(store.status.value).toBe('unavailable')
      expect(store.backgrounds.value).toEqual([])
      expect(store.current.value).toBeNull()
      expect(store.next.value).toBeNull()
      expect(storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe(cache)
    } finally { store.destroy(); vi.unstubAllGlobals() }
  })

  it('keeps a corrupt cache quarantined on malformed HTTP and recovers only on a valid empty snapshot', async () => {
    const storage = memoryStorage({ [BACKGROUND_OVERRIDES_STORAGE_KEY]: '{broken' })
    let payload: unknown = { overrides: [{ id: DISABLED, status: 'invalid' }] }
    const fetcher = vi.fn(async (url: string) => jsonResponse(url === '/api/backgrounds/overrides' ? payload : { backgrounds: [] }))
    const repository = createBackgroundRepository({ storage, fetch: fetcher as unknown as typeof fetch })
    expect(await repository.list()).toEqual([])
    expect(storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe('{broken')
    payload = { overrides: [] }
    expect((await repository.list()).map(item => item.id)).toContain(DISABLED)
    expect(storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe(JSON.stringify({ version: 1, overrides: [] }))
  })

  it('preserves saved shipped choices throughout quarantine and restores their order after a valid snapshot', async () => {
    const selectedIds = ['zzz-qingyi', 'zzz-ellen-joe']
    const saved = JSON.stringify({ selectedIds, autoRotate: true, intervalSeconds: 1200 })
    const storage = memoryStorage({ [BACKGROUND_OVERRIDES_STORAGE_KEY]: '{broken', [BACKGROUND_SELECTION_STORAGE_KEY]: saved })
    let valid = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/backgrounds/overrides'
      ? valid ? jsonResponse({ overrides: [] }) : jsonResponse({ overrides: [{ id: DISABLED, status: 'invalid' }] })
      : jsonResponse({ backgrounds: [] })))
    const store = createBackgroundStore({ storage })
    try {
      expect(storage.getItem(BACKGROUND_SELECTION_STORAGE_KEY)).toBe(saved)
      expect(store.current.value).toBeNull()
      await store.load()
      expect(storage.getItem(BACKGROUND_SELECTION_STORAGE_KEY)).toBe(saved)
      valid = true
      await store.load()
      expect(storage.getItem(BACKGROUND_OVERRIDES_STORAGE_KEY)).toBe(JSON.stringify({ version: 1, overrides: [] }))
      expect(store.selection.value.selectedIds).toEqual(selectedIds)
      expect(store.current.value?.id).toBe(selectedIds[0])
    } finally { store.destroy(); vi.unstubAllGlobals() }
  })

  it('seeds the shipped catalogue from the cached overrides so a disabled clip never renders', () => {
    const storage = memoryStorage({ [BACKGROUND_OVERRIDES_STORAGE_KEY]: disabledCache })
    const store = createBackgroundStore({ storage })

    expect(store.backgrounds.value.map(({ id }) => id)).not.toContain(DISABLED)
    expect(store.backgrounds.value.length).toBe(listStaticBackgrounds().length - 1)
    store.destroy()
  })

  it('repairs a saved preference that names a cached-disabled background before any request settles', () => {
    const storage = memoryStorage({
      [BACKGROUND_OVERRIDES_STORAGE_KEY]: disabledCache,
      [BACKGROUND_SELECTION_STORAGE_KEY]: JSON.stringify({ selectedIds: [DISABLED], autoRotate: true, intervalSeconds: 1200 }),
    })
    const store = createBackgroundStore({ storage })

    expect(store.backgrounds.value.map(({ id }) => id)).not.toContain(DISABLED)
    expect(store.selection.value.selectedIds).not.toContain(DISABLED)
    expect(store.current.value).not.toBeNull()
    expect(store.current.value?.id).not.toBe(DISABLED)
    store.destroy()
  })

  it('keeps a disabled clip out of rotation after a failed catalogue load', async () => {
    const storage = memoryStorage({ [BACKGROUND_OVERRIDES_STORAGE_KEY]: disabledCache })
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    const store = createBackgroundStore({ storage })
    try {
      await store.load()

      expect(store.status.value).toBe('unavailable')
      expect(store.backgrounds.value.length).toBeGreaterThan(0)
      expect(store.backgrounds.value.map(({ id }) => id)).not.toContain(DISABLED)
      expect(store.current.value?.id).not.toBe(DISABLED)
      expect(store.next.value?.id).not.toBe(DISABLED)
    } finally {
      vi.unstubAllGlobals()
      store.destroy()
    }
  })
})
