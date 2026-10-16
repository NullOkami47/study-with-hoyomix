import {
  CHKSZ_QUALITIES,
  isChkszQuality,
  type ChkszQuality,
} from '../../shared/chksz'

export {
  CHKSZ_QUALITIES,
  isChkszQuality,
  type ChkszQuality,
}

export const LX_QUALITIES = ['standard', 'high', 'lossless', 'hires'] as const
export type LxQuality = typeof LX_QUALITIES[number]

export const PLAYBACK_QUALITY_STORAGE_KEY = 'study-with-hoyomix:playback-quality:v1'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface PlaybackQualityPreferencesEnvelope {
  version: 1
  chksz: ChkszQuality
  lx: LxQuality
}

export interface PlaybackQualityPreferencesStore {
  chkszQuality(): ChkszQuality
  setChkszQuality(quality: ChkszQuality): void
  lxQuality(): LxQuality
  setLxQuality(quality: LxQuality): void
  revision(): number
  subscribe(listener: () => void): () => void
}

export interface PlaybackQualityPreferencesStoreOptions {
  storage?: StorageLike
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const isLxQuality = (value: unknown): value is LxQuality =>
  typeof value === 'string' && (LX_QUALITIES as readonly string[]).includes(value)

const defaultStorage = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export function createPlaybackQualityPreferencesStore(
  options: PlaybackQualityPreferencesStoreOptions = {},
): PlaybackQualityPreferencesStore {
  const storage = options.storage ?? defaultStorage()
  let chksz: ChkszQuality = 'standard'
  let lx: LxQuality = 'standard'
  let currentRevision = 0
  const listeners = new Set<() => void>()

  const writeLocal = (): void => {
    if (!storage) return
    try {
      const payload: PlaybackQualityPreferencesEnvelope = {
        version: 1,
        chksz,
        lx,
      }
      storage.setItem(PLAYBACK_QUALITY_STORAGE_KEY, JSON.stringify(payload))
    } catch {
      /* Local persistence is advisory; in-memory state still applies. */
    }
  }

  const readLocal = (): void => {
    if (!storage) return
    let raw: string | null = null
    try {
      raw = storage.getItem(PLAYBACK_QUALITY_STORAGE_KEY)
    } catch {
      return
    }
    if (raw === null) return

    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isRecord(parsed) || parsed.version !== 1) {
        try { storage.removeItem(PLAYBACK_QUALITY_STORAGE_KEY) } catch { /* ignore */ }
        return
      }
      let migrated = false
      if (parsed.chksz === 'high') {
        chksz = 'exhigh'
        migrated = true
      } else if (isChkszQuality(parsed.chksz)) {
        chksz = parsed.chksz
      }
      if (isLxQuality(parsed.lx)) {
        lx = parsed.lx
      }
      if (migrated) {
        writeLocal()
      }
    } catch {
      try { storage.removeItem(PLAYBACK_QUALITY_STORAGE_KEY) } catch { /* ignore */ }
    }
  }

  const notify = (): void => {
    currentRevision += 1
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* A failing subscriber must not break preference updates. */
      }
    }
  }

  readLocal()

  return {
    chkszQuality: () => chksz,
    setChkszQuality(quality: ChkszQuality) {
      if (!isChkszQuality(quality) || quality === chksz) return
      chksz = quality
      writeLocal()
      notify()
    },
    lxQuality: () => lx,
    setLxQuality(quality: LxQuality) {
      if (!isLxQuality(quality) || quality === lx) return
      lx = quality
      writeLocal()
      notify()
    },
    revision: () => currentRevision,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

let defaultStore: PlaybackQualityPreferencesStore | undefined

export const getDefaultPlaybackQualityPreferencesStore = (): PlaybackQualityPreferencesStore => {
  defaultStore ??= createPlaybackQualityPreferencesStore()
  return defaultStore
}
