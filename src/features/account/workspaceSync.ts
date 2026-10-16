import { ref, watch } from 'vue'
import type { Preferences } from '../../stores/preferences'
import { safeLocalStorage } from '../../utils/safeStorage'
import type { BackgroundStore } from '../backgrounds/store'
import type { createAccountFocusRepository } from '../focus/accountRepository'
import { createRemoteFocusSessionRepository } from '../focus/remoteRepository'
import type { FocusSessionRecord } from '../focus/types'
import { applyAccountPreferences, captureAccountPreferences, createAccountPreferencesRepository, type VolumeControls } from './accountPreferences'
import { automaticSyncStatus, createAutomaticSync, syncChannel } from './automaticSync'
import { useAccountSession } from './session'

export function createWorkspaceAccountSync(options: {
  preferences: Preferences; player: VolumeControls; backgrounds: BackgroundStore
  focus: ReturnType<typeof createAccountFocusRepository>
}) {
  const session = useAccountSession()
  const repository = createAccountPreferencesRepository()
  const remoteFocus = createRemoteFocusSessionRepository()
  const { preferences, player, backgrounds, focus } = options
  const sessions = ref<FocusSessionRecord[]>([])
  const unsubscribe = focus.repository.subscribe(values => { sessions.value = values })
  let knownFocusIds = new Set<string>()
  let destroyed = false
  const assertUser = (user: string | null) => {
    if (destroyed || !user || session.userId.value !== user) throw new Error('account_session_changed')
  }
  const scopedKey = (user: string | null) => 'study-with-hoyomix.account-workspace.' + encodeURIComponent(user ?? 'anonymous')
  const ownerKey = 'study-with-hoyomix.account-workspace-owner'
  let scope: string | null = null
  try { scope = safeLocalStorage.getItem(ownerKey) } catch { /* unknown globals are treated as anonymous */ }
  // Harmless UI values are cached separately too, so a new account with no remote
  // profile cannot inherit another account's last visible settings.
  const initialPreferences = captureAccountPreferences(preferences, player)
  const allowAnonymousAdoption = scope === null
  const defaults = { ...initialPreferences, locale: 'en' as const, volume: 1, visualStyle: 'cinematic' as const,
    backgroundMode: 'ambient' as const, studioBlur: 16, studioGlassGray: 26, studioEdge: 68, studyTipsEnabled: true }
  const anonymous = allowAnonymousAdoption ? initialPreferences : defaults
  const capture = () => ({ preferences: captureAccountPreferences(preferences, player),
    selection: JSON.parse(JSON.stringify(backgrounds.selection.value)), playbackMode: backgrounds.playbackMode.value,
    qualityMode: backgrounds.qualityMode.value })
  const stopScope = watch(session.userId, user => {
    try { safeLocalStorage.setItem(scopedKey(scope), JSON.stringify(capture())) } catch { /* local stores already persisted */ }
    let cached: ReturnType<typeof capture> | null = null
    try { cached = JSON.parse(safeLocalStorage.getItem(scopedKey(user)) ?? 'null') } catch { /* restore remotely */ }
    try {
      applyAccountPreferences(preferences, player, cached?.preferences ?? (scope === null && user !== null && allowAnonymousAdoption ? anonymous : defaults))
      if (cached) {
        backgrounds.applyAuthenticated(cached.selection)
        backgrounds.setPlaybackMode(cached.playbackMode)
        backgrounds.setQualityMode(cached.qualityMode)
      } else if (scope !== null) {
        backgrounds.applyAuthenticated({ selectedIds: ['zzz-belle-lofi-girl'], autoRotate: true, intervalSeconds: 1200 })
        backgrounds.setPlaybackMode('random')
        backgrounds.setQualityMode('auto')
      }
    } catch { /* Invalid cache never blocks remote restoration. */ }
    scope = user; knownFocusIds = new Set()
    try { if (user) safeLocalStorage.setItem(ownerKey, user); else safeLocalStorage.removeItem(ownerKey) } catch { /* local stores remain available */ }
  }, { immediate: true, flush: 'sync' })
  const coordinator = createAutomaticSync({ userId: session.userId, status: automaticSyncStatus, pendingStorage: safeLocalStorage, channels: [
    syncChannel({
      capture: () => ({ ...captureAccountPreferences(preferences, player), backgroundPlaybackMode: backgrounds.playbackMode.value, backgroundQualityMode: backgrounds.qualityMode.value }),
      load: () => repository.load(),
      apply: saved => {
        applyAccountPreferences(preferences, player, saved)
        if (saved.backgroundPlaybackMode !== undefined) backgrounds.setPlaybackMode(saved.backgroundPlaybackMode)
        if (saved.backgroundQualityMode !== undefined) backgrounds.setQualityMode(saved.backgroundQualityMode)
      },
      save: saved => repository.save(saved),
    }),
    syncChannel({
      isLocalChange: () => !backgrounds.hydratingSelection.value,
      capture: () => ({ selectedIds: [...backgrounds.selection.value.selectedIds],
        autoRotate: backgrounds.selection.value.autoRotate, intervalSeconds: backgrounds.selection.value.intervalSeconds }),
      load: () => backgrounds.pullAuthenticated(),
      apply: saved => backgrounds.applyAuthenticated(saved),
      save: saved => backgrounds.pushAuthenticated(saved),
    }),
    syncChannel({
      persistPending: false,
      capture: () => ({ sessions: sessions.value.map(record => ({ ...record })) }),
      async load() {
        const user = session.userId.value, local = focus.forUser(user)
        const values = await remoteFocus.load(); assertUser(user)
        // Validate all immutable collisions before inserting any records.
        const existing = new Map((await local.list()).map(record => [record.id, record]))
        assertUser(user)
        for (const record of values) {
          if (existing.has(record.id) && JSON.stringify(existing.get(record.id)) !== JSON.stringify(record)) throw new Error('focus_session_conflict')
        }
        for (const record of values) { assertUser(user); await local.recordIfAbsent(record) }
        assertUser(user)
        knownFocusIds = new Set(values.map(record => record.id))
        const localValues = await local.list(); assertUser(user)
        sessions.value = localValues
        return { sessions: values.map(record => ({ ...record })) }
      },
      apply() { /* The pull already merged immutable records into local storage. */ },
      async save(snapshot) {
        const user = session.userId.value
        const pending = snapshot.sessions.filter(record => !knownFocusIds.has(record.id))
        if (pending.length) await remoteFocus.merge(pending)
        assertUser(user)
        pending.forEach(record => knownFocusIds.add(record.id))
        return snapshot
      },
    }),
  ] })
  // A local record surviving an earlier offline run still needs an upload, even
  // when it was already present when the coordinator subscribed.
  const stopPersist = watch(capture, value => {
    try { safeLocalStorage.setItem(scopedKey(scope), JSON.stringify(value)) } catch { /* retain in-memory operation */ }
  }, { deep: true })
  let lastRefresh = 0
  async function refresh() {
    if (destroyed || document.visibilityState === 'hidden' || Date.now() - lastRefresh < 5000) return
    lastRefresh = Date.now()
    await session.refresh()
    if (!destroyed) coordinator.refresh()
  }
  const onVisible = () => { if (document.visibilityState !== 'hidden') void refresh() }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
  window.addEventListener('online', onVisible)
  const timer = setInterval(() => { void refresh() }, 60_000)
  void session.ensure()
  return {
    destroy() {
      destroyed = true; clearInterval(timer); coordinator.destroy(); unsubscribe(); stopScope(); stopPersist()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible); window.removeEventListener('online', onVisible)
    },
  }
}
