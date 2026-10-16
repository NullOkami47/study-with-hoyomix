import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LEGACY_LX_IDS,
  PROVIDER_PREFERENCES_STORAGE_KEY,
  PROVIDER_PREFERENCES_STORAGE_KEY_V1,
  PROVIDER_PREFERENCES_ACCOUNT_KEY,
  USER_TOGGLEABLE_PROVIDER_IDS,
  createProviderPreferencesStore,
  migrateLegacyDisabledProviderIds,
} from './providerPreferences'

const ENDPOINT = new URL('/api/account/provider-preferences', window.location.origin).toString()

class MemoryStorage {
  readonly entries = new Map<string, string>()

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value)
  }

  removeItem(key: string): void {
    this.entries.delete(key)
  }
}

const jsonResponse = (body: unknown, status = 200): Response => {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
  Object.defineProperty(response, 'url', { configurable: true, value: ENDPOINT })
  return response
}

const stored = (storage: MemoryStorage): unknown => {
  const raw = storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY)
  return raw === null ? null : JSON.parse(raw) as unknown
}

describe('migrateLegacyDisabledProviderIds', () => {
  it('migrates old chksz disabled to new chksz disabled', () => {
    expect(migrateLegacyDisabledProviderIds(['chksz'])).toEqual(['chksz'])
  })

  it('migrates all 8 old LX IDs disabled to new lx disabled', () => {
    expect(migrateLegacyDisabledProviderIds(LEGACY_LX_IDS)).toEqual(['lx'])
  })

  it.each([
    ['1 old LX ID', ['lx-huibq']],
    ['2 old LX IDs', ['lx-huibq', 'lx-ikun']],
    ['7 old LX IDs', ['lx-huibq', 'lx-ikun', 'lx-juhe', 'lx-qdy', 'lx-flower', 'lx-lx', 'lx-grass']],
  ])('keeps lx enabled when not all 8 old LX IDs are disabled (%s)', (_label, ids) => {
    expect(migrateLegacyDisabledProviderIds(ids)).toEqual([])
  })

  it('keeps lx enabled and disables chksz when only some old LX IDs and chksz are disabled', () => {
    expect(migrateLegacyDisabledProviderIds(['chksz', 'lx-huibq', 'lx-ikun'])).toEqual(['chksz'])
  })

  it('disables both chksz and lx when all 8 old LX IDs and chksz are disabled', () => {
    expect(migrateLegacyDisabledProviderIds(['chksz', ...LEGACY_LX_IDS])).toEqual(['chksz', 'lx'])
  })

  it('keeps jellyfin enabled when absent', () => {
    expect(migrateLegacyDisabledProviderIds(['chksz'])).toEqual(['chksz'])
  })

  it('preserves jellyfin when present in input', () => {
    expect(migrateLegacyDisabledProviderIds(['jellyfin'])).toEqual(['jellyfin'])
  })

  it('drops obsolete IDs completely (r2, meting, piped, invidious, gd-studio, qijie, etc.)', () => {
    expect(migrateLegacyDisabledProviderIds([
      'r2', 'meting', 'piped', 'invidious', 'gd-studio', 'qijie', 'youtube', 'unknown',
    ])).toEqual([])
  })

  it('is idempotent: migrating already-migrated IDs leaves them unchanged', () => {
    expect(migrateLegacyDisabledProviderIds([])).toEqual([])
    expect(migrateLegacyDisabledProviderIds(['chksz'])).toEqual(['chksz'])
    expect(migrateLegacyDisabledProviderIds(['lx'])).toEqual(['lx'])
    expect(migrateLegacyDisabledProviderIds(['jellyfin'])).toEqual(['jellyfin'])
    expect(migrateLegacyDisabledProviderIds(['chksz', 'lx', 'jellyfin'])).toEqual(['chksz', 'lx', 'jellyfin'])
  })

  it('sorts the migrated result in canonical order', () => {
    expect(migrateLegacyDisabledProviderIds(['jellyfin', 'chksz', 'lx'])).toEqual(['chksz', 'lx', 'jellyfin'])
  })
})

describe('browser provider preference store', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = new MemoryStorage()
  })

  it('starts with nothing disabled', () => {
    const store = createProviderPreferencesStore({ storage })

    expect([...store.disabledProviderIds()]).toEqual([])
    expect(store.isDisabled('chksz')).toBe(false)
    expect(store.revision()).toBe(0)
  })

  it('disables a provider locally without requiring a sign-in', () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })

    store.setDisabled('lx', true)

    expect(store.isDisabled('lx')).toBe(true)
    expect([...store.disabledProviderIds()]).toEqual(['lx'])
    expect(stored(storage)).toEqual({ version: 2, disabledProviderIds: ['lx'] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('advances the revision only on an effective change', () => {
    const store = createProviderPreferencesStore({ storage })

    store.setDisabled('chksz', true)
    const afterDisable = store.revision()
    store.setDisabled('chksz', true)
    expect(store.revision()).toBe(afterDisable)

    store.setDisabled('chksz', false)
    expect(store.revision()).toBeGreaterThan(afterDisable)
    expect(store.isDisabled('chksz')).toBe(false)
  })

  it('keeps the stored selection in canonical order', () => {
    const store = createProviderPreferencesStore({ storage })

    store.setDisabled('jellyfin', true)
    store.setDisabled('chksz', true)
    store.setDisabled('lx', true)

    expect([...store.disabledProviderIds()]).toEqual(['chksz', 'lx', 'jellyfin'])
  })

  it('restores a valid persisted v2 selection', () => {
    storage.setItem(PROVIDER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 2,
      disabledProviderIds: ['jellyfin', 'chksz'],
    }))

    const store = createProviderPreferencesStore({ storage })

    expect([...store.disabledProviderIds()]).toEqual(['chksz', 'jellyfin'])
  })

  describe('v1 to v2 local storage migration', () => {
    it('reads v2 key first if present and ignores v1', () => {
      storage.setItem(PROVIDER_PREFERENCES_STORAGE_KEY, JSON.stringify({
        version: 2,
        disabledProviderIds: ['jellyfin'],
      }))
      storage.setItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1, JSON.stringify({
        version: 1,
        disabledProviderIds: ['chksz'],
      }))

      const store = createProviderPreferencesStore({ storage })

      expect([...store.disabledProviderIds()]).toEqual(['jellyfin'])
      expect(storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1)).not.toBeNull()
    })

    it('migrates v1 to v2 when v2 is missing, writes to v2, and removes v1 key', () => {
      storage.setItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1, JSON.stringify({
        version: 1,
        disabledProviderIds: ['chksz', 'piped', 'r2'],
      }))

      const store = createProviderPreferencesStore({ storage })

      expect([...store.disabledProviderIds()]).toEqual(['chksz'])
      expect(storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1)).toBeNull()
      expect(stored(storage)).toEqual({
        version: 2,
        disabledProviderIds: ['chksz'],
      })
    })

    it('migrates all 8 legacy LX IDs in v1 to lx in v2', () => {
      storage.setItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1, JSON.stringify({
        version: 1,
        disabledProviderIds: [...LEGACY_LX_IDS],
      }))

      const store = createProviderPreferencesStore({ storage })

      expect([...store.disabledProviderIds()]).toEqual(['lx'])
      expect(storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1)).toBeNull()
      expect(stored(storage)).toEqual({
        version: 2,
        disabledProviderIds: ['lx'],
      })
    })

    it('keeps lx enabled when fewer than 8 legacy LX IDs were disabled in v1', () => {
      storage.setItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1, JSON.stringify({
        version: 1,
        disabledProviderIds: ['lx-huibq', 'lx-ikun'],
      }))

      const store = createProviderPreferencesStore({ storage })

      expect([...store.disabledProviderIds()]).toEqual([])
      expect(storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1)).toBeNull()
      expect(stored(storage)).toEqual({
        version: 2,
        disabledProviderIds: [],
      })
    })

    it('removes corrupt v1 key when v1 is invalid JSON or wrong schema', () => {
      storage.setItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1, 'bad-json')

      const store = createProviderPreferencesStore({ storage })

      expect([...store.disabledProviderIds()]).toEqual([])
      expect(storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1)).toBeNull()
      expect(storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY)).toBeNull()
    })
  })

  it.each([
    ['malformed JSON', '{'],
    ['a bare array', JSON.stringify(['chksz'])],
    ['a null value', JSON.stringify(null)],
    ['an unsupported version', JSON.stringify({ version: 1, disabledProviderIds: ['chksz'] })],
    ['a missing field', JSON.stringify({ version: 2 })],
    ['an extra field', JSON.stringify({ version: 2, disabledProviderIds: [], priority: 3 })],
    ['a non-array selection', JSON.stringify({ version: 2, disabledProviderIds: 'chksz' })],
    ['a non-string member', JSON.stringify({ version: 2, disabledProviderIds: [3] })],
  ])('discards %s in local storage v2', (_label, raw) => {
    storage.setItem(PROVIDER_PREFERENCES_STORAGE_KEY, raw)

    const store = createProviderPreferencesStore({ storage })

    expect([...store.disabledProviderIds()]).toEqual([])
    expect(storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY)).toBeNull()
  })

  it('drops stale or unknown IDs while keeping valid ones in v2', () => {
    storage.setItem(PROVIDER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 2,
      disabledProviderIds: ['lx-unknown', 'chksz', 'youtube', 'qijie', 'gd-studio', 'chksz'],
    }))

    const store = createProviderPreferencesStore({ storage })

    expect([...store.disabledProviderIds()]).toEqual(['chksz'])
  })

  it.each([
    'r2', 'meting', 'piped', 'invidious', 'lx-huibq', 'lx-ikun', 'youtube', 'qijie', 'gd-studio', 'lx-unknown', '',
  ])('refuses to disable the non-toggleable ID %s', (id) => {
    const store = createProviderPreferencesStore({ storage })

    store.setDisabled(id, true)

    expect(store.isDisabled(id)).toBe(false)
    expect([...store.disabledProviderIds()]).toEqual([])
  })

  it('survives a storage that throws', () => {
    const hostile = {
      getItem() { throw new Error('denied') },
      setItem() { throw new Error('denied') },
      removeItem() { throw new Error('denied') },
    }
    const store = createProviderPreferencesStore({ storage: hostile })

    store.setDisabled('chksz', true)

    expect(store.isDisabled('chksz')).toBe(true)
  })

  it('fetches and adopts the account selection when signing in', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ disabledProviderIds: ['lx', 'jellyfin'] })) as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })

    await store.setSignedIn(true)

    expect([...store.disabledProviderIds()]).toEqual(['lx', 'jellyfin'])
    expect(fetchImpl).toHaveBeenCalledWith(ENDPOINT, expect.objectContaining({
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'error',
    }))
  })

  it('pushes a local selection to the account when signing in with local state', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PUT'
        ? jsonResponse({ disabledProviderIds: ['chksz'] })
        : jsonResponse({ disabledProviderIds: [] })) as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })
    store.setDisabled('chksz', true)

    await store.setSignedIn(true)

    expect([...store.disabledProviderIds()]).toEqual(['chksz'])
    const put = vi.mocked(fetchImpl).mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(put).toBeDefined()
    expect(put![1]?.body).toBe(JSON.stringify({ disabledProviderIds: ['chksz'] }))
  })

  it('merges local and remote selections when both exist', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PUT'
        ? jsonResponse({ disabledProviderIds: ['chksz', 'lx'] })
        : jsonResponse({ disabledProviderIds: ['chksz'] })) as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })
    store.setDisabled('lx', true)

    await store.setSignedIn(true)

    expect([...store.disabledProviderIds()]).toEqual(['chksz', 'lx'])
  })

  it('synchronises a later local change while signed in', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse({
        disabledProviderIds: init?.method === 'PUT' ? ['jellyfin'] : [],
      })) as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })
    await store.setSignedIn(true)

    store.setDisabled('jellyfin', true)
    await store.flush()

    const put = vi.mocked(fetchImpl).mock.calls.find(([, init]) => init?.method === 'PUT')
    expect(put![1]?.body).toBe(JSON.stringify({ disabledProviderIds: ['jellyfin'] }))
    expect(store.isDisabled('jellyfin')).toBe(true)
  })

  it('preserves valid local state when the remote read fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })
    store.setDisabled('lx', true)

    await expect(store.setSignedIn(true)).resolves.toBeUndefined()

    expect([...store.disabledProviderIds()]).toEqual(['lx'])
    expect(stored(storage)).toEqual({ version: 2, disabledProviderIds: ['lx'] })
  })

  it('preserves valid local state when the remote write fails', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'PUT'
        ? jsonResponse({ error: 'invalid_provider_preferences' }, 400)
        : jsonResponse({ disabledProviderIds: [] })) as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })
    await store.setSignedIn(true)

    store.setDisabled('jellyfin', true)
    await store.flush()

    expect([...store.disabledProviderIds()]).toEqual(['jellyfin'])
    expect(stored(storage)).toEqual({ version: 2, disabledProviderIds: ['jellyfin'] })
  })

  it.each([
    ['a non-JSON body', new Response('nope', { headers: { 'content-type': 'text/html' } })],
    ['a malformed envelope', new Response('{"nope":true}', { headers: { 'content-type': 'application/json' } })],
    ['an unknown member', new Response('{"disabledProviderIds":["lx-unknown"]}', { headers: { 'content-type': 'application/json' } })],
    ['a legacy member', new Response('{"disabledProviderIds":["piped"]}', { headers: { 'content-type': 'application/json' } })],
  ])('ignores %s from the account endpoint', async (_label, response) => {
    Object.defineProperty(response, 'url', { configurable: true, value: ENDPOINT })
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })
    store.setDisabled('chksz', true)

    await store.setSignedIn(true)

    expect([...store.disabledProviderIds()]).toEqual(['chksz'])
  })

  it('returns to local-only behaviour after signing out', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ disabledProviderIds: ['chksz'] })) as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })
    await store.setSignedIn(true)
    const callsAfterSignIn = vi.mocked(fetchImpl).mock.calls.length

    await store.setSignedIn(false)
    store.setDisabled('lx', true)
    await store.flush()

    expect(vi.mocked(fetchImpl).mock.calls.length).toBe(callsAfterSignIn)
    expect([...store.disabledProviderIds()]).toEqual(['chksz', 'lx'])
    expect(stored(storage)).toEqual({
      version: 2,
      disabledProviderIds: ['chksz', 'lx'],
    })
  })

  it('does not request account state while anonymous', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })

    store.setDisabled('chksz', true)
    await store.flush()
    await store.setSignedIn(false)

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('serialises only canonical provider IDs, never credentials or priorities', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse({
        disabledProviderIds: init?.method === 'PUT' ? ['chksz'] : [],
      })) as unknown as typeof fetch
    const store = createProviderPreferencesStore({ storage, fetch: fetchImpl })
    await store.setSignedIn(true)
    store.setDisabled('chksz', true)
    await store.flush()

    const serialised = JSON.stringify([
      ...vi.mocked(fetchImpl).mock.calls,
      storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY),
    ])
    expect(serialised).not.toMatch(/apikey|api_key|x-request-key|priority|MUSIC_U|baseUrl/i)
    expect(JSON.parse(storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY)!) as unknown)
      .toEqual({ version: 2, disabledProviderIds: ['chksz'] })
  })

  it('exposes the canonical toggleable set in stored priority order', () => {
    expect([...USER_TOGGLEABLE_PROVIDER_IDS]).toEqual([
      'chksz',
      'lx',
      'jellyfin',
    ])
  })

  it('notifies subscribers when the selection changes', () => {
    const store = createProviderPreferencesStore({ storage })
    const observed: number[] = []
    const unsubscribe = store.subscribe(() => observed.push(store.revision()))

    store.setDisabled('chksz', true)
    store.setDisabled('chksz', true)
    store.setDisabled('chksz', false)
    unsubscribe()
    store.setDisabled('lx', true)

    expect(observed).toHaveLength(2)
    expect(observed[1]).toBeGreaterThan(observed[0]!)
  })
})

it('adopts a remote re-enable on reload rather than re-uploading stale disabled providers', async () => {
  const memory = new Map<string, string>()
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value) }, removeItem: (key: string) => { memory.delete(key) } }
  let remote = ['lx']
  let puts = 0
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') puts += 1
    return Response.json({ disabledProviderIds: remote })
  }) as typeof fetch
  const first = createProviderPreferencesStore({ storage, fetch: fetcher })
  await first.setSignedIn(true, 'account-a')
  expect(first.isDisabled('lx')).toBe(true)
  remote = []
  const reloaded = createProviderPreferencesStore({ storage, fetch: fetcher })
  await reloaded.setSignedIn(true, 'account-a')
  expect(reloaded.isDisabled('lx')).toBe(false)
  expect(puts).toBe(0)
})

it('does not copy one account provider choices into a different account', async () => {
  const memory = new Map<string, string>()
  const storage = { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => { memory.set(key, value) }, removeItem: (key: string) => { memory.delete(key) } }
  let remote = ['lx']
  let puts = 0
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') puts += 1
    return Response.json({ disabledProviderIds: remote })
  }) as typeof fetch
  const store = createProviderPreferencesStore({ storage, fetch: fetcher })
  await store.setSignedIn(true, 'account-a')
  await store.setSignedIn(false)
  remote = ['jellyfin']
  await store.setSignedIn(true, 'account-b')
  expect([...store.disabledProviderIds()]).toEqual(['jellyfin'])
  expect(puts).toBe(0)
})

it('ignores a pending account read after logout without uploading anonymous edits', async () => {
  let finish!: (response: Response) => void
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
  const store = createProviderPreferencesStore({ storage: new MemoryStorage(), fetch: fetcher })
  const signingIn = store.setSignedIn(true, 'account-a')
  await Promise.resolve()
  await store.setSignedIn(false)
  store.setDisabled('jellyfin', true)
  finish(jsonResponse({ disabledProviderIds: ['lx'] }))
  await signingIn
  await store.flush()
  expect([...store.disabledProviderIds()]).toEqual(['jellyfin'])
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('ignores an earlier account read after switching accounts while it is pending', async () => {
  let finish!: (response: Response) => void
  const fetcher = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    .mockResolvedValue(jsonResponse({ disabledProviderIds: ['jellyfin'] }))
  const store = createProviderPreferencesStore({ storage: new MemoryStorage(), fetch: fetcher })
  const first = store.setSignedIn(true, 'account-a')
  await Promise.resolve()
  const second = store.setSignedIn(true, 'account-b')
  finish(jsonResponse({ disabledProviderIds: ['lx'] }))
  await Promise.all([first, second])
  expect([...store.disabledProviderIds()]).toEqual(['jellyfin'])
  expect(fetcher.mock.calls).toHaveLength(2)
})

it('does not overwrite a newer local edit with an in-flight write echo', async () => {
  let finish!: (response: Response) => void
  const fetcher = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ disabledProviderIds: [] }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse(JSON.parse(String(init?.body))))
  const store = createProviderPreferencesStore({ storage: new MemoryStorage(), fetch: fetcher })
  await store.setSignedIn(true, 'account-a')
  store.setDisabled('lx', true)
  await Promise.resolve()
  store.setDisabled('jellyfin', true)
  finish(jsonResponse({ disabledProviderIds: ['lx'] }))
  await store.flush()
  expect([...store.disabledProviderIds()]).toEqual(['lx', 'jellyfin'])
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toEqual({ disabledProviderIds: ['lx', 'jellyfin'] })
})

it('cancels queued account writes when the user signs out before they start', async () => {
  const fetcher = vi.fn(async () => jsonResponse({ disabledProviderIds: [] }))
  const store = createProviderPreferencesStore({ storage: new MemoryStorage(), fetch: fetcher })
  await store.setSignedIn(true, 'account-a')
  store.setDisabled('lx', true)
  await store.setSignedIn(false)
  await store.flush()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(store.isDisabled('lx')).toBe(true)
})

it('ignores a write response from the previous account after a switch', async () => {
  let finish!: (response: Response) => void
  const fetcher = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ disabledProviderIds: [] }))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    .mockResolvedValue(jsonResponse({ disabledProviderIds: ['jellyfin'] }))
  const store = createProviderPreferencesStore({ storage: new MemoryStorage(), fetch: fetcher })
  await store.setSignedIn(true, 'account-a')
  store.setDisabled('lx', true)
  await Promise.resolve()
  await store.setSignedIn(true, 'account-b')
  finish(jsonResponse({ disabledProviderIds: ['lx'] }))
  await Promise.resolve()
  await Promise.resolve()
  expect([...store.disabledProviderIds()]).toEqual(['jellyfin'])
  expect(fetcher.mock.calls).toHaveLength(3)
})

it('retains a deliberate re-enable made while the account read is pending', async () => {
  const storage = new MemoryStorage()
  let remote = ['lx']
  let finish!: (response: Response) => void
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') remote = JSON.parse(String(init.body)).disabledProviderIds
    return jsonResponse({ disabledProviderIds: remote })
  })
  const store = createProviderPreferencesStore({ storage, fetch: fetcher })
  await store.setSignedIn(true, 'account-a')
  await store.setSignedIn(false)
  fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
  const loading = store.setSignedIn(true, 'account-a')
  await Promise.resolve()
  store.setDisabled('lx', false)
  finish(jsonResponse({ disabledProviderIds: ['lx'] }))
  await loading
  expect([...store.disabledProviderIds()]).toEqual([])
  expect(remote).toEqual([])
})

it('never writes inherited local choices after the new account read fails', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(jsonResponse({ disabledProviderIds: ['lx'] }))
    .mockRejectedValue(new Error('offline'))
  const store = createProviderPreferencesStore({ storage: new MemoryStorage(), fetch: fetcher })
  await store.setSignedIn(true, 'account-a')
  await store.setSignedIn(true, 'account-b')
  store.setDisabled('jellyfin', true)
  await store.flush()
  expect(fetcher.mock.calls).toHaveLength(2)
})

it('keeps queued local edits when the same authenticated identity is published again', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    jsonResponse(init?.body ? JSON.parse(String(init.body)) : { disabledProviderIds: [] }))
  const store = createProviderPreferencesStore({ storage: new MemoryStorage(), fetch: fetcher })
  await store.setSignedIn(true, 'account-a')
  store.setDisabled('lx', true)
  await store.setSignedIn(true, 'account-a')
  await store.flush()
  expect(store.isDisabled('lx')).toBe(true)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls[1]?.[1]?.method).toBe('PUT')
})

it('merges first-login anonymous choices once while retaining the V2 local envelope', async () => {
  const storage = new MemoryStorage()
  let remote = ['lx']
  let writes = 0
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      writes += 1
      remote = JSON.parse(String(init.body)).disabledProviderIds
    }
    return jsonResponse({ disabledProviderIds: remote })
  })
  const store = createProviderPreferencesStore({ storage, fetch: fetcher })
  store.setDisabled('chksz', true)
  await store.setSignedIn(true, 'account-a')
  expect(remote).toEqual(['chksz', 'lx'])
  expect(writes).toBe(1)
  expect(storage.getItem(PROVIDER_PREFERENCES_ACCOUNT_KEY)).toBe('account-a')
  expect(stored(storage)).toEqual({ version: 2, disabledProviderIds: ['chksz', 'lx'] })

  await store.setSignedIn(false)
  store.setDisabled('jellyfin', true)
  remote = []
  await store.setSignedIn(true, 'account-a')
  expect([...store.disabledProviderIds()]).toEqual([])
  expect(writes).toBe(1)
})
