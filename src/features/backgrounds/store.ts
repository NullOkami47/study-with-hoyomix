import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useAccountSession } from '../account/session'

import { safeLocalStorage } from '../../utils/safeStorage'
import { createBackgroundRepository } from './repository'
import { listStaticBackgrounds } from './catalogue'
import { readAvailabilityOverrides, readCachedOverrides, hiddenOverrideIds } from './overrides'
import {
  BACKGROUND_INTERVAL_VALUES,
  DEFAULT_BACKGROUND_INTERVAL_SECONDS,
  DEFAULT_BACKGROUND_PLAYBACK_MODE,
} from './types'
import type {
  BackgroundIntervalSeconds,
  BackgroundPlaybackMode,
  BackgroundQualityMode,
  BackgroundRepository,
  BackgroundSelection,
  PublicBackground,
} from './types'

export const BACKGROUND_SELECTION_STORAGE_KEY = 'study-with-hoyomix.background-selection'
const IMPLICIT_DEFAULT_STORAGE_KEY = 'study-with-hoyomix.background-implicit-default'
// Playback order has its own local key; account sync carries it in the strict
// UI preference envelope, separate from the BackgroundSelection payload.
export const BACKGROUND_PLAYBACK_STORAGE_KEY = 'study-with-hoyomix.background-playback'
export const BACKGROUND_QUALITY_STORAGE_KEY = 'study-with-hoyomix.background-quality'
export const MAX_SELECTED_BACKGROUNDS = 8
const VIDEO_FAILURE_POSTER_MS = 3_000
// Canonical choices and the shorter values older builds wrote are both
// accepted, so an existing preference survives an upgrade untouched.
const allowedIntervals: readonly BackgroundIntervalSeconds[] = BACKGROUND_INTERVAL_VALUES

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface PlaybackPolicy {
  lowPower: boolean
  reducedMotion: boolean
  saveData: boolean
}

interface BackgroundStoreOptions {
  repository?: BackgroundRepository
  storage?: StorageLike
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

export interface BackgroundStore {
  hydratingSelection: Ref<boolean>
  backgrounds: Ref<PublicBackground[]>
  selection: Ref<BackgroundSelection>
  current: ComputedRef<PublicBackground | null>
  /** Stable next target for paused preloading and manual/automatic switching. */
  next: ComputedRef<PublicBackground | null>
  playbackMode: Ref<BackgroundPlaybackMode>
  qualityMode: Ref<BackgroundQualityMode>
  usingPoster: ComputedRef<boolean>
  status: Ref<'idle' | 'loading' | 'ready' | 'unavailable'>
  error: Ref<'selection_limit' | null>
  syncStatus: Ref<'idle' | 'syncing' | 'complete' | 'failed'>
  load(): Promise<void>
  toggle(id: string, selected: boolean): boolean
  setAutoRotate(enabled: boolean): void
  setInterval(seconds: BackgroundIntervalSeconds): void
  setPlaybackMode(mode: BackgroundPlaybackMode): void
  setQualityMode(mode: BackgroundQualityMode): void
  setPlaybackPolicy(policy: PlaybackPolicy): void
  setVisible(visible: boolean): void
  nextBackground(): void
  onVideoEnded(): void
  onVideoError(): void
  /** Called when the preloaded next background fails so rotation skips it. */
  onPreloadError(id: string): void
  pullAuthenticated(): Promise<BackgroundSelection | null>
  applyAuthenticated(selection: BackgroundSelection): void
  pushAuthenticated(selection: BackgroundSelection): Promise<BackgroundSelection>
  syncAuthenticated(): Promise<boolean>
  destroy(): void
}

const defaultSelection = (): BackgroundSelection => ({
  selectedIds: [],
  autoRotate: true,
  intervalSeconds: DEFAULT_BACKGROUND_INTERVAL_SECONDS,
})

const readSelection = (storage?: StorageLike): BackgroundSelection => {
  if (!storage) return defaultSelection()
  try {
    const raw = storage.getItem(BACKGROUND_SELECTION_STORAGE_KEY)
    if (!raw) return defaultSelection()
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultSelection()
    const candidate = value as Partial<BackgroundSelection>
    return {
      selectedIds: Array.isArray(candidate.selectedIds)
        ? candidate.selectedIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_SELECTED_BACKGROUNDS)
        : [],
      autoRotate: typeof candidate.autoRotate === 'boolean' ? candidate.autoRotate : true,
      intervalSeconds: allowedIntervals.includes(candidate.intervalSeconds as BackgroundIntervalSeconds)
        ? candidate.intervalSeconds as BackgroundIntervalSeconds
        : DEFAULT_BACKGROUND_INTERVAL_SECONDS,
    }
  } catch {
    return defaultSelection()
  }
}

// No persisted preference means a new (or never-configured) user, so the
// first-use order is Random. Anything already stored keeps winning.
const defaultPlaybackMode: BackgroundPlaybackMode = DEFAULT_BACKGROUND_PLAYBACK_MODE

const readPlaybackMode = (storage?: StorageLike): BackgroundPlaybackMode => {
  if (!storage) return defaultPlaybackMode
  try {
    const raw = storage.getItem(BACKGROUND_PLAYBACK_STORAGE_KEY)
    if (!raw) return defaultPlaybackMode
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultPlaybackMode
    const mode = (value as { playbackMode?: unknown }).playbackMode
    return mode === 'random' || mode === 'sequential' ? mode : defaultPlaybackMode
  } catch {
    return defaultPlaybackMode
  }
}

export function sanitizeBackgroundSelection(ids: string[], backgrounds: PublicBackground[]): string[] {
  const available = new Set(backgrounds.filter(({ status }) => status === 'published').map(({ id }) => id))
  const result: string[] = []
  for (const id of ids) {
    if (!available.has(id) || result.includes(id)) continue
    result.push(id)
    if (result.length === MAX_SELECTED_BACKGROUNDS) break
  }
  return result
}

export function createBackgroundStore(options: BackgroundStoreOptions = {}): BackgroundStore {
  // Browser policy can throw on the localStorage property access itself, so the
  // shared safe wrapper is used instead of touching window directly here.
  const storage = options.storage ?? safeLocalStorage
  const repository = options.repository ?? createBackgroundRepository({ storage })
  const scheduleTimeout = options.setTimeout ?? setTimeout
  const cancelTimeout = options.clearTimeout ?? clearTimeout
  // Resolve shipped preferences immediately; a slow catalogue API must not
  // delay the first background. Custom repositories remain authoritative.
  //
  // The last verified administrator overrides are applied here, synchronously,
  // so a background that is known to be disabled is absent from the very first
  // render. If the catalogue request later fails, this list is what remains —
  // which is exactly why it must already respect those overrides.
  const cachedOverrides = options.repository ? null : readAvailabilityOverrides(storage)
  const backgrounds = ref<PublicBackground[]>(
    options.repository ? [] : listStaticBackgrounds(cachedOverrides ?? undefined),
  )
  const selection = ref<BackgroundSelection>(readSelection(storage))
  const hydratingSelection = ref(false)
  let implicitDefault = selection.value.selectedIds.length === 0
  try {
    if (selection.value.selectedIds.length === 1 && storage?.getItem(IMPLICIT_DEFAULT_STORAGE_KEY) === 'true') implicitDefault = true
  } catch { /* inaccessible storage leaves the in-memory default usable */ }
  const playbackMode = ref<BackgroundPlaybackMode>(readPlaybackMode(storage))
  const qualityMode = ref<BackgroundQualityMode>('auto')
  try {
    const saved = JSON.parse(storage?.getItem(BACKGROUND_QUALITY_STORAGE_KEY) ?? 'null')
    if (saved?.qualityMode === 'native' || saved?.qualityMode === '1440p') qualityMode.value = saved.qualityMode
  } catch { /* invalid or inaccessible preferences use smooth Auto playback */ }
  const currentId = ref<string | null>(selection.value.selectedIds[0] ?? null)
  const nextId = ref<string | null>(null)
  const status = ref<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const error = ref<'selection_limit' | null>(null)
  const syncStatus = ref<'idle' | 'syncing' | 'complete' | 'failed'>('idle')
  const visible = ref(true)
  const policy = ref<PlaybackPolicy>({ lowPower: false, reducedMotion: false, saveData: false })
  const failedVideoId = ref<string | null>(null)
  // Videos that failed this session are skipped by rotation so a bad file can
  // never stall the loop; any selection change gives them a fresh chance.
  const failedVideoIds = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let loadPromise: Promise<void> | undefined
  let destroyed = false
  let selectionRevision = 0
  const stopSelectionWatch = watch(selection, () => { if (!hydratingSelection.value) selectionRevision += 1 }, { deep: true, flush: 'sync' })

  const current = computed(() => backgrounds.value.find(({ id }) => id === currentId.value) ?? null)
  const next = computed(() => backgrounds.value.find(({ id }) => id === nextId.value) ?? null)
  const usingPoster = computed(() => current.value?.kind === 'video' && (
    policy.value.lowPower || policy.value.reducedMotion || policy.value.saveData || failedVideoId.value === current.value.id
  ))

  const persist = () => {
    try {
      storage?.setItem(BACKGROUND_SELECTION_STORAGE_KEY, JSON.stringify(selection.value))
      storage?.setItem(IMPLICIT_DEFAULT_STORAGE_KEY, String(implicitDefault))
    } catch { /* memory state remains */ }
  }

  const persistPlayback = () => {
    try { storage?.setItem(BACKGROUND_PLAYBACK_STORAGE_KEY, JSON.stringify({ playbackMode: playbackMode.value })) } catch { /* memory state remains */ }
  }

  const selectedBackgrounds = () => selection.value.selectedIds
    .map((id) => backgrounds.value.find((item) => item.id === id))
    .filter((item): item is PublicBackground => item !== undefined)

  // Rotation candidates: selected backgrounds minus the videos that already
  // failed in this session.
  const candidates = () => selectedBackgrounds()
    .filter((item) => item.kind !== 'video' || !failedVideoIds.has(item.id))

  const computeNextId = (): string | null => {
    const items = candidates()
    if (items.length === 0) return null
    if (!currentId.value) return items[0].id
    if (items.length === 1) {
      const catalogue = backgrounds.value.filter(item => item.status === 'published' && !failedVideoIds.has(item.id))
      const pool = catalogue.filter(item => item.id !== currentId.value)
      if (!pool.length) return null
      if (playbackMode.value === 'random') return pool[Math.floor(Math.random() * pool.length)].id
      const index = catalogue.findIndex(item => item.id === currentId.value)
      return catalogue[(index + 1) % catalogue.length].id
    }
    if (playbackMode.value === 'sequential') {
      items.sort((a, b) => backgrounds.value.indexOf(a) - backgrounds.value.indexOf(b))
      const index = items.findIndex(({ id }) => id === currentId.value)
      return items[(index < 0 ? 0 : index + 1) % items.length].id
    }
    // Random never repeats the background that is already on screen.
    const pool = items.filter(({ id }) => id !== currentId.value)
    return pool[Math.floor(Math.random() * pool.length)].id
  }

  const syncPending = () => { nextId.value = computeNextId() }

  const clearTimer = () => {
    if (timer !== undefined) cancelTimeout(timer)
    timer = undefined
  }

  const advance = (manual = false) => {
    const items = candidates()
    if (items.length === 0) {
      // Exhausting the playable rotation candidates must not remove the last
      // published scene's valid poster. Keep it until an explicit new choice.
      if (current.value?.kind === 'video' && current.value.posterUrl &&
        failedVideoId.value === current.value.id && selection.value.selectedIds.includes(current.value.id)) {
        nextId.value = null
        clearTimer()
        return
      }
      currentId.value = null
      nextId.value = null
      return
    }
    if ((!manual && !selection.value.autoRotate) || items.length === 1) {
      currentId.value = items[0].id
      syncPending()
      return
    }
    // Keep the chosen Random target stable until rotation.
    currentId.value = items.some(({ id }) => id === nextId.value)
      ? nextId.value
      : computeNextId() ?? items[0].id
    failedVideoId.value = null
    syncPending()
    reschedule()
  }

  const reschedule = (delayMs?: number) => {
    clearTimer()
    if (destroyed || !visible.value || !selection.value.autoRotate || candidates().length < 2 || !current.value) return
    // Videos loop internally, so the interval timer alone drives rotation and
    // the cadence is identical for image and video backgrounds.
    timer = scheduleTimeout(advance, delayMs ?? selection.value.intervalSeconds * 1_000)
  }

  const applySelection = (next: BackgroundSelection, preserveCurrent = false) => {
    const selectedIds = sanitizeBackgroundSelection(next.selectedIds, backgrounds.value)
    if (selectedIds.length === 0) {
      const fallback = backgrounds.value.find(item => item.kind === 'video' && item.status === 'published')
      if (fallback) selectedIds.push(fallback.id)
      implicitDefault = true
    }
    selection.value = {
      ...next,
      selectedIds,
    }
    if (!selection.value.selectedIds.includes(currentId.value ?? '')) {
      currentId.value = selection.value.selectedIds[0] ?? null
      failedVideoId.value = null
    }
    if (!selection.value.autoRotate && !preserveCurrent) currentId.value = selection.value.selectedIds[0] ?? null
    // A new selection deserves a fresh chance for files that failed earlier.
    failedVideoIds.clear()
    syncPending()
    persist()
    reschedule()
  }

  /**
   * A saved preference can name a background that no longer resolves: a purged
   * API row, a hand-edited or corrupted value, or a mis-cased shipped id.
   * Upload UUIDs are deliberately left alone while the shipped catalogue is the
   * only thing loaded (the API may still own them), but a value that is not even
   * shaped like an upload id can never resolve, so the scene falls back to a
   * playable default instead of rendering nothing.
   */
  const isUploadShapedId = (id: string): boolean => /^[0-9a-f-]{36}$/.test(id)

  const repairUnresolvableSelection = (allowUploadShaped: boolean) => {
    if (current.value !== null) return
    if (backgrounds.value.some((item) => item.id === currentId.value)) return
    if (!allowUploadShaped && currentId.value !== null && isUploadShapedId(currentId.value)) return
    const fallback = backgrounds.value.find((item) => item.status === 'published' && item.kind === 'video')
      ?? backgrounds.value.find((item) => item.status === 'published')
    if (!fallback) return
    currentId.value = fallback.id
    failedVideoId.value = null
    syncPending()
  }

  if (!options.repository) {
    // A cached override is verified knowledge, so a saved preference that names
    // a background the administrator disabled is dropped right here. This is
    // deliberately narrower than sanitising against the catalogue: upload UUIDs
    // are left untouched because the shipped manifest cannot speak for them.
    // Quarantine is temporary unknown availability, not an Admin decision.
    // Only verified restrictions may permanently remove saved choices.
    const hidden = hiddenOverrideIds(readCachedOverrides(storage))
    if (hidden.size > 0) {
      const remaining = selection.value.selectedIds.filter((id) => !hidden.has(id))
      if (remaining.length !== selection.value.selectedIds.length) {
        selection.value = { ...selection.value, selectedIds: remaining }
        if (currentId.value !== null && hidden.has(currentId.value)) currentId.value = remaining[0] ?? null
        persist()
      }
    }
    // Do not sanitise saved API IDs against the incomplete shipped catalogue.
    // Only an empty preference can be resolved before repository.list settles.
    if (selection.value.selectedIds.length === 0) {
      const fallback = backgrounds.value.find(item => item.status === 'published' && item.kind === 'video')
        ?? backgrounds.value.find(item => item.status === 'published')
      selection.value.selectedIds = fallback ? [fallback.id] : []
      currentId.value = fallback?.id ?? null
      persist()
    }
    repairUnresolvableSelection(false)
    syncPending()
    reschedule()
  }

  return {
    hydratingSelection,
    backgrounds,
    selection,
    current,
    next,
    playbackMode,
    qualityMode,
    usingPoster,
    status,
    error,
    syncStatus,
    async load() {
      if (loadPromise) return loadPromise
      const wasReady = status.value === 'ready'
      status.value = 'loading'
      loadPromise = repository.list().then((items) => {
        if (destroyed) return
        backgrounds.value = items.filter(({ status: itemStatus }) => itemStatus === 'published')
        // Catalogue refreshes validate availability; they must not cancel a
        // manual Next chosen while the request was still pending.
        const quarantined = !options.repository && readCachedOverrides(storage) === null && readAvailabilityOverrides(storage) !== null
        if (quarantined) {
          syncPending()
          repairUnresolvableSelection(true)
          reschedule()
        } else if (wasReady && current.value !== null && selection.value.selectedIds.length > 0 &&
          JSON.stringify(sanitizeBackgroundSelection(selection.value.selectedIds, backgrounds.value)) === JSON.stringify(selection.value.selectedIds)) {
          // A periodic availability refresh must not restart the rotation
          // deadline, retry failed media or reroll a valid preloaded target.
          if (!nextId.value || !backgrounds.value.some(item => item.id === nextId.value) || failedVideoIds.has(nextId.value)) syncPending()
        } else {
          hydratingSelection.value = true
          try { applySelection(selection.value, true) } finally { hydratingSelection.value = false }
        }
        status.value = 'ready'
      }).catch(() => {
        if (destroyed) return
        status.value = 'unavailable'
        // Offline: the shipped catalogue is all that is loaded, so guarantee a
        // playable scene. The repair is in-memory only — the stored preference
        // is left untouched so a later successful load can still restore it.
        repairUnresolvableSelection(true)
      }).finally(() => { loadPromise = undefined })
      return loadPromise
    },
    toggle(id, selected) {
      error.value = null
      if (!backgrounds.value.some((item) => item.id === id)) return false
      const ids = selection.value.selectedIds.filter((candidate) => candidate !== id)
      if (selected) {
        if (ids.length >= MAX_SELECTED_BACKGROUNDS) {
          error.value = 'selection_limit'
          return false
        }
        ids.push(id)
      }
      implicitDefault = false
      applySelection({ ...selection.value, selectedIds: ids })
      return true
    },
    setAutoRotate(enabled) {
      if (typeof enabled === 'boolean') applySelection({ ...selection.value, autoRotate: enabled })
    },
    setInterval(seconds) {
      // The selector only offers the canonical minute choices; the shorter
      // legacy values stay settable so a restored preference round-trips.
      if (allowedIntervals.includes(seconds)) applySelection({ ...selection.value, intervalSeconds: seconds })
    },
    setPlaybackMode(mode) {
      if (mode !== 'random' && mode !== 'sequential') return
      if (mode === playbackMode.value) return
      playbackMode.value = mode
      persistPlayback()
      syncPending()
      reschedule()
    },
    setQualityMode(mode) {
      if (mode !== 'auto' && mode !== 'native' && mode !== '1440p') return
      const changed = mode !== qualityMode.value
      qualityMode.value = mode
      // An explicit quality change gives a failed scene another chance. Healthy
      // playback keeps its existing deadline; only a failure timer is replaced.
      if (changed && failedVideoId.value !== null) {
        failedVideoId.value = null
        failedVideoIds.clear()
        reschedule()
      }
      try { storage?.setItem(BACKGROUND_QUALITY_STORAGE_KEY, JSON.stringify({ qualityMode: mode })) } catch { /* memory state remains */ }
    },
    setPlaybackPolicy(nextPolicy) {
      policy.value = { ...nextPolicy }
      reschedule()
    },
    setVisible(nextVisible) {
      visible.value = nextVisible
      reschedule()
    },
    nextBackground() {
      if (destroyed) return
      if (selection.value.selectedIds.length < 2) {
        const items = backgrounds.value.filter(item => item.status === 'published' && !failedVideoIds.has(item.id))
        const pool = items.filter(item => item.id !== currentId.value)
        if (!pool.length) return
        const index = items.findIndex(item => item.id === currentId.value)
        const target = pool.find(item => item.id === nextId.value) ?? (playbackMode.value === 'random'
          ? pool[Math.floor(Math.random() * pool.length)]
          : items[(index + 1) % items.length])
        implicitDefault = false
        applySelection({ ...selection.value, selectedIds: [target.id] })
      } else advance(true)
    },
    onVideoEnded() {
      // Videos loop internally, so rotation is timer driven; this stays as a
      // manual-advance hook for callers that still emit `ended`.
      if (!selection.value.autoRotate) return
      if (current.value?.kind === 'video' && !usingPoster.value) advance()
    },
    onVideoError() {
      if (current.value?.kind !== 'video') return
      const failed = current.value.id
      failedVideoId.value = failed
      failedVideoIds.add(failed)
      clearTimer()
      if (destroyed || !visible.value || !selection.value.autoRotate) return
      timer = scheduleTimeout(advance, VIDEO_FAILURE_POSTER_MS)
    },
    onPreloadError(id) {
      if (typeof id !== 'string' || !id) return
      failedVideoIds.add(id)
      if (nextId.value === id) syncPending()
    },
    async pullAuthenticated() {
      await this.load()
      if (status.value !== 'ready') throw new Error('backgrounds_unavailable')
      const quarantined = !options.repository && readCachedOverrides(storage) === null && readAvailabilityOverrides(storage) !== null
      if (quarantined) throw new Error('backgrounds_quarantined')
      const remote = await repository.getAccountSelection()
      // Another device may select a newly uploaded background. Unknown IDs are
      // not evidence of deletion and must never be sanitised and written back.
      if (remote && sanitizeBackgroundSelection(remote.selectedIds, backgrounds.value).length !== remote.selectedIds.length) throw new Error('backgrounds_unavailable')
      return remote
    },
    applyAuthenticated(remote) {
      // Never union account choices with local choices: deselection is intentional.
      implicitDefault = false
      if (status.value !== 'ready') {
        // Account cache may include uploaded IDs before the catalogue arrives.
        // Preserve them and the last displayable scene until availability settles.
        selection.value = { ...remote, selectedIds: [...remote.selectedIds] }
        const available = remote.selectedIds.find(id => backgrounds.value.some(item => item.id === id))
        if (available) currentId.value = available
        persist(); syncPending(); reschedule()
        return
      }
      applySelection(remote)
    },
    async pushAuthenticated(snapshot) {
      if (status.value !== 'ready') throw new Error('backgrounds_unavailable')
      const quarantined = !options.repository && readCachedOverrides(storage) === null && readAvailabilityOverrides(storage) !== null
      if (quarantined) throw new Error('backgrounds_quarantined')
      if (snapshot.selectedIds.length === 0 || sanitizeBackgroundSelection(snapshot.selectedIds, backgrounds.value).length !== snapshot.selectedIds.length) throw new Error('backgrounds_unavailable')
      return repository.saveAccountSelection(snapshot)
    },
    /** Compatibility pull alias. All writes belong to the workspace coordinator. */
    async syncAuthenticated() {
      if (syncStatus.value === 'syncing') return false
      syncStatus.value = 'syncing'
      const session = useAccountSession(), before = selectionRevision
      const user = session.userId.value, revision = session.revision.value
      try {
        const remote = await this.pullAuthenticated()
        if (destroyed || user !== session.userId.value || revision !== session.revision.value || before !== selectionRevision) throw new Error('background_selection_changed')
        if (remote) this.applyAuthenticated(remote)
        syncStatus.value = 'complete'
        return true
      } catch { syncStatus.value = 'failed'; return false }
    },
    destroy() {
      destroyed = true
      stopSelectionWatch()
      clearTimer()
    },
  }
}

let defaultStore: BackgroundStore | undefined

export function getDefaultBackgroundStore(): BackgroundStore {
  defaultStore ??= createBackgroundStore()
  return defaultStore
}
