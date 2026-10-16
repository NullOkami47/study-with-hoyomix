import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CHKSZ_QUALITIES,
  LX_QUALITIES,
  PLAYBACK_QUALITY_STORAGE_KEY,
  createPlaybackQualityPreferencesStore,
  getDefaultPlaybackQualityPreferencesStore,
  type ChkszQuality,
  type LxQuality,
  type StorageLike,
} from './qualityPreferences'

const memoryStorage = (initial: Record<string, string> = {}): StorageLike => {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('qualityPreferences — CHKSZ_QUALITIES and LX_QUALITIES', () => {
  it('defines the seven supported ChKSz quality levels in order', () => {
    expect(CHKSZ_QUALITIES).toEqual<readonly string[]>([
      'standard',
      'exhigh',
      'lossless',
      'hires',
      'jyeffect',
      'sky',
      'jymaster',
    ])
    expect(CHKSZ_QUALITIES).toHaveLength(7)
    // The LX-shaped values must never appear in the ChKSz contract.
    expect(CHKSZ_QUALITIES as readonly string[]).not.toContain('high')
    expect(CHKSZ_QUALITIES as readonly string[]).not.toContain('128k')
    expect(CHKSZ_QUALITIES as readonly string[]).not.toContain('320k')
    expect(CHKSZ_QUALITIES as readonly string[]).not.toContain('flac')
    expect(CHKSZ_QUALITIES as readonly string[]).not.toContain('flac24bit')
  })

  it('defines the four supported LX audio qualities in ascending order', () => {
    expect(LX_QUALITIES).toEqual<readonly string[]>([
      'standard',
      'high',
      'lossless',
      'hires',
    ])
    // The two provider contracts stay distinct; no ChKSz-only level reaches LX.
    expect(LX_QUALITIES as readonly string[]).not.toContain('exhigh')
    expect(LX_QUALITIES as readonly string[]).not.toContain('jyeffect')
    expect(LX_QUALITIES as readonly string[]).not.toContain('sky')
    expect(LX_QUALITIES as readonly string[]).not.toContain('jymaster')
  })
})

describe('createPlaybackQualityPreferencesStore — defaults and initial state', () => {
  it('defaults both chksz and lx qualities to standard when storage is empty', () => {
    const storage = memoryStorage()
    const store = createPlaybackQualityPreferencesStore({ storage })

    expect(store.chkszQuality()).toBe('standard')
    expect(store.lxQuality()).toBe('standard')
    expect(store.revision()).toBe(0)
  })

  it('defaults to standard when no storage is available', () => {
    const store = createPlaybackQualityPreferencesStore({ storage: undefined })

    expect(store.chkszQuality()).toBe('standard')
    expect(store.lxQuality()).toBe('standard')
    expect(store.revision()).toBe(0)
  })
})

describe('createPlaybackQualityPreferencesStore — reading persisted state', () => {
  it('loads valid persisted quality preferences from storage for all ChKSz tiers', () => {
    for (const quality of CHKSZ_QUALITIES) {
      const storage = memoryStorage({
        [PLAYBACK_QUALITY_STORAGE_KEY]: JSON.stringify({
          version: 1,
          chksz: quality,
          lx: 'lossless',
        }),
      })
      const store = createPlaybackQualityPreferencesStore({ storage })

      expect(store.chkszQuality()).toBe(quality)
      expect(store.lxQuality()).toBe('lossless')
      expect(store.revision()).toBe(0)
    }
  })

  it('migrates legacy chksz high to exhigh without modifying lx high', () => {
    const storage = memoryStorage({
      [PLAYBACK_QUALITY_STORAGE_KEY]: JSON.stringify({
        version: 1,
        chksz: 'high',
        lx: 'high',
      }),
    })
    const store = createPlaybackQualityPreferencesStore({ storage })

    expect(store.chkszQuality()).toBe('exhigh')
    expect(store.lxQuality()).toBe('high')
    expect(storage.setItem).toHaveBeenCalledWith(
      PLAYBACK_QUALITY_STORAGE_KEY,
      JSON.stringify({ version: 1, chksz: 'exhigh', lx: 'high' }),
    )
  })

  it('falls back to defaults and purges storage when version is unsupported', () => {
    const storage = memoryStorage({
      [PLAYBACK_QUALITY_STORAGE_KEY]: JSON.stringify({
        version: 2,
        chksz: 'lossless',
        lx: 'hires',
      }),
    })
    const store = createPlaybackQualityPreferencesStore({ storage })

    expect(store.chkszQuality()).toBe('standard')
    expect(store.lxQuality()).toBe('standard')
    expect(storage.removeItem).toHaveBeenCalledWith(PLAYBACK_QUALITY_STORAGE_KEY)
  })

  it('falls back to defaults and purges storage when JSON is malformed', () => {
    const storage = memoryStorage({
      [PLAYBACK_QUALITY_STORAGE_KEY]: '{not json',
    })
    const store = createPlaybackQualityPreferencesStore({ storage })

    expect(store.chkszQuality()).toBe('standard')
    expect(store.lxQuality()).toBe('standard')
    expect(storage.removeItem).toHaveBeenCalledWith(PLAYBACK_QUALITY_STORAGE_KEY)
  })

  it('falls back to defaults and purges storage when envelope is not an object', () => {
    const storage = memoryStorage({
      [PLAYBACK_QUALITY_STORAGE_KEY]: JSON.stringify('standard'),
    })
    const store = createPlaybackQualityPreferencesStore({ storage })

    expect(store.chkszQuality()).toBe('standard')
    expect(store.lxQuality()).toBe('standard')
    expect(storage.removeItem).toHaveBeenCalledWith(PLAYBACK_QUALITY_STORAGE_KEY)
  })

  it('falls back individual malformed qualities to standard without widening enum', () => {
    const storage = memoryStorage({
      [PLAYBACK_QUALITY_STORAGE_KEY]: JSON.stringify({
        version: 1,
        chksz: 'super_ultra',
        lx: 'hires',
      }),
    })
    const store = createPlaybackQualityPreferencesStore({ storage })

    expect(store.chkszQuality()).toBe('standard')
    expect(store.lxQuality()).toBe('hires')
  })

  it('does not leak ChKSz quality values into LX Music preferences', () => {
    const storage = memoryStorage({
      [PLAYBACK_QUALITY_STORAGE_KEY]: JSON.stringify({
        version: 1,
        chksz: 'jymaster',
        lx: 'jymaster',
      }),
    })
    const store = createPlaybackQualityPreferencesStore({ storage })

    expect(store.chkszQuality()).toBe('jymaster')
    expect(store.lxQuality()).toBe('standard')
  })
})

describe('createPlaybackQualityPreferencesStore — setting qualities and persistence', () => {
  it('updates chksz quality, increments revision, and persists envelope', () => {
    const storage = memoryStorage()
    const store = createPlaybackQualityPreferencesStore({ storage })

    store.setChkszQuality('exhigh')

    expect(store.chkszQuality()).toBe('exhigh')
    expect(store.lxQuality()).toBe('standard')
    expect(store.revision()).toBe(1)
    expect(storage.setItem).toHaveBeenCalledWith(
      PLAYBACK_QUALITY_STORAGE_KEY,
      JSON.stringify({ version: 1, chksz: 'exhigh', lx: 'standard' }),
    )
  })

  it('updates lx quality, increments revision, and persists envelope', () => {
    const storage = memoryStorage()
    const store = createPlaybackQualityPreferencesStore({ storage })

    store.setLxQuality('lossless')

    expect(store.chkszQuality()).toBe('standard')
    expect(store.lxQuality()).toBe('lossless')
    expect(store.revision()).toBe(1)
    expect(storage.setItem).toHaveBeenCalledWith(
      PLAYBACK_QUALITY_STORAGE_KEY,
      JSON.stringify({ version: 1, chksz: 'standard', lx: 'lossless' }),
    )
  })

  it('supports all seven quality tiers for ChKSz', () => {
    const storage = memoryStorage()
    const store = createPlaybackQualityPreferencesStore({ storage })

    for (const quality of CHKSZ_QUALITIES) {
      store.setChkszQuality(quality)
      expect(store.chkszQuality()).toBe(quality)
    }
  })

  it('supports all four quality tiers for LX Music', () => {
    const storage = memoryStorage()
    const store = createPlaybackQualityPreferencesStore({ storage })

    for (const quality of LX_QUALITIES) {
      store.setLxQuality(quality)
      expect(store.lxQuality()).toBe(quality)
    }
  })

  it('ignores setting the same quality (no-op)', () => {
    const storage = memoryStorage()
    const store = createPlaybackQualityPreferencesStore({ storage })

    store.setChkszQuality('standard')

    expect(store.revision()).toBe(0)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('ignores invalid quality values and does not widen enum', () => {
    const storage = memoryStorage()
    const store = createPlaybackQualityPreferencesStore({ storage })

    store.setChkszQuality('high' as unknown as ChkszQuality)
    store.setChkszQuality('invalid' as unknown as ChkszQuality)
    store.setLxQuality('ultra' as unknown as LxQuality)
    store.setLxQuality('exhigh' as unknown as LxQuality)

    expect(store.chkszQuality()).toBe('standard')
    expect(store.lxQuality()).toBe('standard')
    expect(store.revision()).toBe(0)
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})

describe('createPlaybackQualityPreferencesStore — subscriptions', () => {
  it('notifies subscribers on chksz quality changes', () => {
    const store = createPlaybackQualityPreferencesStore({ storage: memoryStorage() })
    const listener = vi.fn()
    store.subscribe(listener)

    store.setChkszQuality('jymaster')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers on lx quality changes', () => {
    const store = createPlaybackQualityPreferencesStore({ storage: memoryStorage() })
    const listener = vi.fn()
    store.subscribe(listener)

    store.setLxQuality('hires')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying when unsubscribed', () => {
    const store = createPlaybackQualityPreferencesStore({ storage: memoryStorage() })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    unsubscribe()
    store.setChkszQuality('lossless')

    expect(listener).not.toHaveBeenCalled()
  })

  it('survives subscriber throwing without affecting other listeners or updates', () => {
    const store = createPlaybackQualityPreferencesStore({ storage: memoryStorage() })
    const failingListener = vi.fn(() => {
      throw new Error('listener failure')
    })
    const goodListener = vi.fn()

    store.subscribe(failingListener)
    store.subscribe(goodListener)

    store.setChkszQuality('sky')

    expect(goodListener).toHaveBeenCalledTimes(1)
    expect(store.chkszQuality()).toBe('sky')
  })
})

describe('getDefaultPlaybackQualityPreferencesStore', () => {
  it('returns a singleton store', () => {
    const first = getDefaultPlaybackQualityPreferencesStore()
    const second = getDefaultPlaybackQualityPreferencesStore()
    expect(first).toBe(second)
  })
})

// The two quality sets are independent axes. Carrying a ChKSz level through the Worker
// owner-fallback contract must not widen the LX chain or let a ChKSz-only tier persist as an
// LX preference.
describe('ChKSz and LX quality sets stay independent', () => {
  it('keeps exactly four LX qualities', () => {
    expect([...LX_QUALITIES]).toEqual(['standard', 'high', 'lossless', 'hires'])
  })

  it('never admits a ChKSz-only tier into LX', () => {
    for (const chkszOnly of ['exhigh', 'jyeffect', 'sky', 'jymaster']) {
      expect(LX_QUALITIES as readonly string[]).not.toContain(chkszOnly)
    }
  })

  it('keeps exactly seven ChKSz qualities', () => {
    expect([...CHKSZ_QUALITIES]).toEqual([
      'standard', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'jymaster',
    ])
  })

  it('does not let an LX-only tier be stored as a ChKSz preference', () => {
    const store = createPlaybackQualityPreferencesStore({ storage: memoryStorage() })
    for (const lxOnly of ['high', '128k', '320k', 'flac']) {
      store.setChkszQuality(lxOnly as ChkszQuality)
      expect(store.chkszQuality()).toBe('standard')
    }
  })

  it('does not let a ChKSz-only tier be stored as an LX preference', () => {
    const store = createPlaybackQualityPreferencesStore({ storage: memoryStorage() })
    for (const chkszOnly of ['exhigh', 'jyeffect', 'sky', 'jymaster']) {
      store.setLxQuality(chkszOnly as LxQuality)
      expect(store.lxQuality()).toBe('standard')
    }
  })

  it('persists the two axes independently', () => {
    const store = createPlaybackQualityPreferencesStore({ storage: memoryStorage() })
    store.setChkszQuality('jymaster')
    store.setLxQuality('lossless')

    expect(store.chkszQuality()).toBe('jymaster')
    expect(store.lxQuality()).toBe('lossless')
  })
})
