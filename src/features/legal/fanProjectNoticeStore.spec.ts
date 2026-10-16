import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SafeStorage } from '../../utils/safeStorage'
import { createFanProjectNoticeStore, FAN_PROJECT_NOTICE_STORAGE_KEY } from './fanProjectNotice'

interface MemoryStorage extends SafeStorage {
  map: Map<string, string>
}

const memoryStorage = (seed: Record<string, string> = {}): MemoryStorage => {
  const map = new Map<string, string>(Object.entries(seed))
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

const dismissed = () => ({ [FAN_PROJECT_NOTICE_STORAGE_KEY]: JSON.stringify({ version: 1, dismissed: true }) })

describe('fan project notice store', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows the notice on a first visit', () => {
    expect(createFanProjectNoticeStore({ storage: memoryStorage() }).visible.value).toBe(true)
  })

  it('stays dismissed for a returning visitor on the same device', () => {
    expect(createFanProjectNoticeStore({ storage: memoryStorage(dismissed()) }).visible.value).toBe(false)
  })

  it('hides immediately when dismissed', () => {
    const store = createFanProjectNoticeStore({ storage: memoryStorage() })
    store.dismiss()
    expect(store.visible.value).toBe(false)
  })

  it('records the dismissal locally: one key, no network call', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const storage = memoryStorage()
    createFanProjectNoticeStore({ storage }).dismiss()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect([...storage.map.keys()]).toEqual([FAN_PROJECT_NOTICE_STORAGE_KEY])
  })

  it('shows again on a different device, because dismissal is not account-synced', () => {
    const deviceOne = memoryStorage()
    createFanProjectNoticeStore({ storage: deviceOne }).dismiss()
    const deviceTwo = memoryStorage()
    expect(createFanProjectNoticeStore({ storage: deviceTwo }).visible.value).toBe(true)
  })

  it('survives storage the browser has denied, without throwing', () => {
    const denied: SafeStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    }
    const store = createFanProjectNoticeStore({ storage: denied })
    expect(store.visible.value).toBe(true)
    expect(() => store.dismiss()).not.toThrow()
    expect(store.visible.value).toBe(false)
  })

  it('ignores malformed stored values and shows the notice again', () => {
    const malformed = [
      'not json',
      'null',
      '[]',
      '"dismissed"',
      '{"version":1}',
      '{"version":2,"dismissed":true}',
      '{"version":1,"dismissed":true,"userId":"u_1"}',
    ]
    for (const raw of malformed) {
      const store = createFanProjectNoticeStore({
        storage: memoryStorage({ [FAN_PROJECT_NOTICE_STORAGE_KEY]: raw }),
      })
      expect(store.visible.value, `malformed value rejected: ${raw}`).toBe(true)
    }
  })

  it('does not gate usage: nothing about the notice reports a blocked state', () => {
    const store = createFanProjectNoticeStore({ storage: memoryStorage() })
    expect(Object.keys(store).sort()).toEqual(['dismiss', 'visible'])
  })
})
