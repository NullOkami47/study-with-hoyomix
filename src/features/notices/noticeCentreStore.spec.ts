import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  NOTICE_DISMISSALS_STORAGE_KEY,
  createNoticeCentreStore,
  resolveNoticeText,
} from './noticeCentre'

interface MemoryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly map: Map<string, string>
}

const memoryStorage = (seed?: Record<string, string>): MemoryStorage => {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const notice = (overrides: Record<string, unknown> = {}) => ({
  id: 'notice-1',
  revisionId: 'rev-1',
  severity: 'info',
  targeting: 'everyone',
  content: { en: 'Scheduled maintenance tonight.' },
  startAt: null,
  endAt: null,
  publishedAt: 1_000,
  ...overrides,
})

const fetchReturning = (...bodies: unknown[]) => {
  const impl = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ notices: bodies }),
  )
  return impl as unknown as typeof fetch & { mock: typeof impl.mock }
}

describe('notice centre store', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('exposes no notices before a refresh completes', () => {
    const store = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage: memoryStorage() })
    expect(store.visibleNotices()).toEqual([])
  })

  it('reads active public notices from the public endpoint', async () => {
    const fetchImpl = fetchReturning(notice())
    const store = createNoticeCentreStore({ fetch: fetchImpl, storage: memoryStorage() })

    await store.refresh()

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [input, init] = fetchImpl.mock.calls[0]!
    expect(String(input)).toContain('/api/notices')
    expect(init?.method ?? 'GET').toBe('GET')
    expect(store.visibleNotices()).toEqual([{
      id: 'notice-1',
      revisionId: 'rev-1',
      severity: 'info',
      content: { en: 'Scheduled maintenance tonight.' },
    }])
  })

  it('sends credentials so targeted notices resolve against the session', async () => {
    const fetchImpl = fetchReturning(notice())
    const store = createNoticeCentreStore({ fetch: fetchImpl, storage: memoryStorage() })

    await store.refresh()

    const [, init] = fetchImpl.mock.calls[0]!
    expect(init?.credentials).toBe('same-origin')
  })

  it('never exposes administrative or targeting fields to the view layer', async () => {
    const store = createNoticeCentreStore({
      fetch: fetchReturning(notice({
        status: 'published',
        createdBy: 'admin-1',
        createdAt: 5,
        updatedAt: 6,
        archivedAt: null,
        targeting: 'authenticated',
      })),
      storage: memoryStorage(),
    })

    await store.refresh()

    const [entry] = store.visibleNotices()
    expect(Object.keys(entry!).sort()).toEqual(['content', 'id', 'revisionId', 'severity'])
    expect(JSON.stringify(store.visibleNotices())).not.toContain('admin-1')
    expect(JSON.stringify(store.visibleNotices())).not.toContain('published')
  })

  it('orders critical notices before warnings and warnings before info', async () => {
    const store = createNoticeCentreStore({
      fetch: fetchReturning(
        notice({ id: 'a', revisionId: 'ra', severity: 'info' }),
        notice({ id: 'b', revisionId: 'rb', severity: 'critical' }),
        notice({ id: 'c', revisionId: 'rc', severity: 'warning' }),
      ),
      storage: memoryStorage(),
    })

    await store.refresh()

    expect(store.visibleNotices().map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
  })

  it.each([
    ['a non-array notices member', { notices: 'nope' }],
    ['a missing notices member', {}],
    ['a bare array', [notice()]],
    ['null', null],
  ])('ignores %s', async (_label, body) => {
    const fetchImpl = vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch
    const store = createNoticeCentreStore({ fetch: fetchImpl, storage: memoryStorage() })

    await store.refresh()

    expect(store.visibleNotices()).toEqual([])
  })

  it.each([
    ['a missing id', { id: undefined }],
    ['a non-string id', { id: 7 }],
    ['a missing revisionId', { revisionId: undefined }],
    ['an unknown severity', { severity: 'fatal' }],
    ['non-record content', { content: 'text' }],
    ['no readable locale text', { content: {} }],
    ['non-string locale text', { content: { en: 12 } }],
  ])('drops a malformed notice with %s', async (_label, overrides) => {
    const store = createNoticeCentreStore({
      fetch: fetchReturning(notice(overrides), notice({ id: 'ok', revisionId: 'r-ok' })),
      storage: memoryStorage(),
    })

    await store.refresh()

    expect(store.visibleNotices().map((entry) => entry.id)).toEqual(['ok'])
  })

  it('drops notices whose window has not opened or has already closed', async () => {
    const store = createNoticeCentreStore({
      fetch: fetchReturning(
        notice({ id: 'future', revisionId: 'r-future', startAt: 9_000 }),
        notice({ id: 'expired', revisionId: 'r-expired', endAt: 1_500 }),
        notice({ id: 'active', revisionId: 'r-active', startAt: 1_000, endAt: 9_000 }),
      ),
      storage: memoryStorage(),
      now: () => 2_000,
    })

    await store.refresh()

    expect(store.visibleNotices().map((entry) => entry.id)).toEqual(['active'])
  })

  it('hides a dismissed revision and persists the dismissal', async () => {
    const storage = memoryStorage()
    const store = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage })

    await store.refresh()
    store.dismiss('rev-1')

    expect(store.visibleNotices()).toEqual([])
    expect(JSON.parse(storage.getItem(NOTICE_DISMISSALS_STORAGE_KEY)!)).toEqual({
      version: 1,
      dismissedRevisionIds: ['rev-1'],
    })
  })

  it('keeps dismissed active notices available in Settings', async () => {
    const store = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage: memoryStorage() })
    await store.refresh()
    store.dismiss('rev-1')
    expect(store.visibleNotices()).toEqual([])
    expect(store.allNotices().map(entry => entry.revisionId)).toEqual(['rev-1'])
  })

  it('notifies Settings subscribers when dismissed notice content changes', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ notices: [notice()] }))
      .mockResolvedValueOnce(jsonResponse({ notices: [notice({ content: { en: 'Updated.' } })] }))
    const store = createNoticeCentreStore({ fetch: fetchImpl as unknown as typeof fetch, storage: memoryStorage() })
    await store.refresh()
    store.dismiss('rev-1')
    const subscriber = vi.fn()
    store.subscribe(subscriber)
    await store.refresh()
    expect(store.visibleNotices()).toEqual([])
    expect(store.allNotices()[0]?.content.en).toBe('Updated.')
    expect(subscriber).toHaveBeenCalledOnce()
  })

  it('keeps a dismissal across store instances', async () => {
    const storage = memoryStorage()
    const first = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage })
    await first.refresh()
    first.dismiss('rev-1')

    const second = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage })
    await second.refresh()

    expect(second.visibleNotices()).toEqual([])
  })

  it('shows the notice again when the administrator publishes a new revision', async () => {
    const storage = memoryStorage()
    const first = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage })
    await first.refresh()
    first.dismiss('rev-1')

    const second = createNoticeCentreStore({
      fetch: fetchReturning(notice({ revisionId: 'rev-2', content: { en: 'Updated details.' } })),
      storage,
    })
    await second.refresh()

    expect(second.visibleNotices().map((entry) => entry.revisionId)).toEqual(['rev-2'])
  })

  it('removes an archived notice from the view on the next refresh', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ notices: [notice()] }))
      .mockResolvedValueOnce(jsonResponse({ notices: [] })) as unknown as typeof fetch
    const store = createNoticeCentreStore({ fetch: fetchImpl, storage: memoryStorage() })

    await store.refresh()
    expect(store.visibleNotices()).toHaveLength(1)

    await store.refresh()
    expect(store.visibleNotices()).toEqual([])
  })

  it('bounds stored dismissals and keeps the newest entries', async () => {
    const storage = memoryStorage()
    const store = createNoticeCentreStore({ fetch: fetchReturning(), storage })

    for (let index = 0; index < 70; index += 1) store.dismiss(`rev-${index}`)

    const stored = JSON.parse(storage.getItem(NOTICE_DISMISSALS_STORAGE_KEY)!) as {
      dismissedRevisionIds: string[]
    }
    expect(stored.dismissedRevisionIds).toHaveLength(50)
    expect(stored.dismissedRevisionIds).toContain('rev-69')
    expect(stored.dismissedRevisionIds).not.toContain('rev-0')
  })

  it('keeps a still-served notice dismissed after the cap evicts older entries', async () => {
    const storage = memoryStorage()
    const live = notice({ id: 'notice-live', revisionId: 'rev-live' })
    const store = createNoticeCentreStore({ fetch: fetchReturning(live), storage })

    await store.refresh()
    store.dismiss('rev-live')
    expect(store.visibleNotices()).toEqual([])

    // Dismissing well past the cap must not resurface a notice the endpoint is
    // still serving under the same revision.
    for (let index = 0; index < 70; index += 1) {
      store.dismiss(`rev-gone-${index}`)
      await store.refresh()
    }

    expect(store.visibleNotices()).toEqual([])
    const stored = JSON.parse(storage.getItem(NOTICE_DISMISSALS_STORAGE_KEY)!) as {
      dismissedRevisionIds: string[]
    }
    expect(stored.dismissedRevisionIds).toHaveLength(50)
    expect(stored.dismissedRevisionIds).toContain('rev-live')
    expect(stored.dismissedRevisionIds.at(-1)).toBe('rev-live')
  })

  it('evicts dismissals for notices that are no longer served before live ones', async () => {
    const storage = memoryStorage({
      [NOTICE_DISMISSALS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        dismissedRevisionIds: ['rev-live', 'rev-gone'],
      }),
    })
    const store = createNoticeCentreStore({
      fetch: fetchReturning(notice({ revisionId: 'rev-live' })),
      storage,
    })

    await store.refresh()

    const stored = JSON.parse(storage.getItem(NOTICE_DISMISSALS_STORAGE_KEY)!) as {
      dismissedRevisionIds: string[]
    }
    expect(stored.dismissedRevisionIds).toEqual(['rev-gone', 'rev-live'])
  })

  it('notifies Settings once when a dismissed live notice first loads but not for dismissal reordering', async () => {
    const storage = memoryStorage({
      [NOTICE_DISMISSALS_STORAGE_KEY]: JSON.stringify({
        version: 1,
        dismissedRevisionIds: ['rev-live', 'rev-gone'],
      }),
    })
    const store = createNoticeCentreStore({
      fetch: fetchReturning(notice({ revisionId: 'rev-live' })),
      storage,
    })
    const listener = vi.fn()
    store.subscribe(listener)

    await store.refresh()

    expect(store.visibleNotices()).toEqual([])
    expect(store.allNotices().map(entry => entry.revisionId)).toEqual(['rev-live'])
    expect(listener).toHaveBeenCalledOnce()
    listener.mockClear()
    await store.refresh()
    expect(listener).not.toHaveBeenCalled()
  })

  it('still reveals a new revision of a previously dismissed notice', async () => {
    const storage = memoryStorage()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ notices: [notice({ revisionId: 'rev-1' })] }))
      .mockResolvedValueOnce(jsonResponse({ notices: [notice({ revisionId: 'rev-2' })] })) as unknown as typeof fetch
    const store = createNoticeCentreStore({ fetch: fetchImpl, storage })

    await store.refresh()
    store.dismiss('rev-1')
    await store.refresh()

    expect(store.visibleNotices().map((entry) => entry.revisionId)).toEqual(['rev-2'])
    const stored = JSON.parse(storage.getItem(NOTICE_DISMISSALS_STORAGE_KEY)!) as {
      dismissedRevisionIds: string[]
    }
    expect(stored.dismissedRevisionIds).toEqual(['rev-1'])
  })

  it('ignores a dismissal for an implausible revision id', () => {
    const storage = memoryStorage()
    const store = createNoticeCentreStore({ fetch: fetchReturning(), storage })

    store.dismiss('')
    store.dismiss('x'.repeat(200))

    expect(storage.getItem(NOTICE_DISMISSALS_STORAGE_KEY)).toBeNull()
  })

  it.each([
    ['invalid JSON', 'not json'],
    ['an array', '[]'],
    ['a wrong version', '{"version":2,"dismissedRevisionIds":[]}'],
    ['a non-array member', '{"version":1,"dismissedRevisionIds":"rev-1"}'],
    ['an unexpected extra key', '{"version":1,"dismissedRevisionIds":[],"admin":true}'],
  ])('recovers from stored dismissals with %s', async (_label, raw) => {
    const storage = memoryStorage({ [NOTICE_DISMISSALS_STORAGE_KEY]: raw })
    const store = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage })

    await store.refresh()

    expect(store.visibleNotices().map((entry) => entry.id)).toEqual(['notice-1'])
  })

  it('drops non-string stored dismissals without discarding valid ones', async () => {
    const storage = memoryStorage({
      [NOTICE_DISMISSALS_STORAGE_KEY]: '{"version":1,"dismissedRevisionIds":[7,"rev-1"]}',
    })
    const store = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage })

    await store.refresh()

    expect(store.visibleNotices()).toEqual([])
  })

  it('survives storage that throws on every operation', async () => {
    const hostile = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    const store = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage: hostile })

    await store.refresh()
    expect(store.visibleNotices()).toHaveLength(1)

    expect(() => store.dismiss('rev-1')).not.toThrow()
    expect(store.visibleNotices()).toEqual([])
  })

  it.each([
    ['a rejected request', vi.fn(async () => { throw new Error('offline') })],
    ['a 500 response', vi.fn(async () => jsonResponse({ error: 'unavailable' }, 500))],
    ['a non-JSON response', vi.fn(async () => new Response('<html></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }))],
    ['unparseable JSON', vi.fn(async () => new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))],
  ])('stays silent after %s', async (_label, fetchImpl) => {
    const store = createNoticeCentreStore({
      fetch: fetchImpl as unknown as typeof fetch,
      storage: memoryStorage(),
    })

    await expect(store.refresh()).resolves.toBeUndefined()
    expect(store.visibleNotices()).toEqual([])
  })

  it('keeps the previous notices when a later refresh fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ notices: [notice()] }))
      .mockRejectedValueOnce(new Error('offline')) as unknown as typeof fetch
    const store = createNoticeCentreStore({ fetch: fetchImpl, storage: memoryStorage() })

    await store.refresh()
    await store.refresh()

    expect(store.visibleNotices().map((entry) => entry.id)).toEqual(['notice-1'])
  })

  it('notifies subscribers on refresh and dismissal and stops after unsubscribe', async () => {
    const store = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage: memoryStorage() })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    await store.refresh()
    expect(listener).toHaveBeenCalledTimes(1)

    store.dismiss('rev-1')
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    store.dismiss('rev-1')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('keeps working when a subscriber throws', async () => {
    const store = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage: memoryStorage() })
    store.subscribe(() => { throw new Error('subscriber') })
    const healthy = vi.fn()
    store.subscribe(healthy)

    await store.refresh()

    expect(healthy).toHaveBeenCalledOnce()
  })

  it('does not notify when a refresh produces no change', async () => {
    const store = createNoticeCentreStore({ fetch: fetchReturning(notice()), storage: memoryStorage() })
    await store.refresh()
    const listener = vi.fn()
    store.subscribe(listener)

    await store.refresh()

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('resolveNoticeText', () => {
  it('prefers the active locale', () => {
    expect(resolveNoticeText({ en: 'English', 'zh-Hant': '繁體', 'zh-Hans': '简体' }, 'zh-Hant'))
      .toBe('繁體')
  })

  it.each([
    ['zh-Hant falls back to zh-Hans', 'zh-Hant', { 'zh-Hans': '简体', en: 'English' }, '简体'],
    ['zh-Hans falls back to zh-Hant', 'zh-Hans', { 'zh-Hant': '繁體', en: 'English' }, '繁體'],
    ['en falls back to zh-Hans', 'en', { 'zh-Hans': '简体' }, '简体'],
    ['zh-Hant falls back to en when no Chinese text exists', 'zh-Hant', { en: 'English' }, 'English'],
  ] as const)('%s', (_label, locale, content, expected) => {
    expect(resolveNoticeText(content, locale)).toBe(expected)
  })

  it('returns null when no locale carries text', () => {
    expect(resolveNoticeText({}, 'en')).toBeNull()
  })
})

describe('notice eligibility changes', () => {
  it('clears session-specific notices immediately and ignores an old pending response', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn(async () => jsonResponse({ notices: [notice()] }))
    const store = createNoticeCentreStore({ fetch: fetcher, storage: memoryStorage() })
    await store.refresh()
    store.dismiss('rev-1')
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    const pending = store.refresh()
    store.invalidateSession()
    expect(store.allNotices()).toEqual([])
    finish(jsonResponse({ notices: [notice({ content: { en: 'Old account only' } })] }))
    await pending
    expect(store.allNotices()).toEqual([])
    await store.refresh()
    expect(store.allNotices()).toHaveLength(1)
    expect(store.visibleNotices()).toEqual([])
  })

  it('keeps a newer response when requests complete out of order', async () => {
    let finish!: (response: Response) => void
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
      .mockResolvedValueOnce(jsonResponse({ notices: [notice({ revisionId: 'new' })] }))
    const store = createNoticeCentreStore({ fetch: fetcher, storage: memoryStorage() })
    const old = store.refresh()
    await store.refresh()
    finish(jsonResponse({ notices: [notice({ revisionId: 'old' })] }))
    await old
    expect(store.allNotices().map(item => item.revisionId)).toEqual(['new'])
  })

  it('expires cached notices on access even when the next refresh fails', async () => {
    let now = 1_000
    const fetcher = vi.fn(async () => jsonResponse({ notices: [notice({ endAt: 2_000 })] }))
    const store = createNoticeCentreStore({ fetch: fetcher, now: () => now, storage: memoryStorage() })
    await store.refresh()
    now = 2_000
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await store.refresh()
    expect(store.allNotices()).toEqual([])
    expect(store.visibleNotices()).toEqual([])
  })

  it('notifies mounted subscribers at expiry without a network refresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const store = createNoticeCentreStore({
      fetch: fetchReturning(notice({ endAt: 2_000 })), storage: memoryStorage(),
    })
    await store.refresh()
    const seen: number[] = []
    const unsubscribe = store.subscribe(() => seen.push(store.allNotices().length))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen).toEqual([0])
    unsubscribe()
    vi.useRealTimers()
  })
})
