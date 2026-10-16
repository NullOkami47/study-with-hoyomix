import { watch, type Ref } from 'vue'
import { safeLocalStorage } from '../../utils/safeStorage'
import { createFocusSessionRepository, FOCUS_SESSION_DATABASE_NAME, type FocusSessionRepository } from './localRepository'
import type { FocusSessionRecord } from './types'

const OWNERS_KEY = 'study-with-hoyomix.focus-run-owners.v1'
/** Existing unowned history remains anonymous; it is never adopted by an account. */
export function createAccountFocusRepository(userId: Readonly<Ref<string | null>>) {
  const repositories = new Map<string | null, FocusSessionRepository>()
  const listeners = new Set<(sessions: FocusSessionRecord[]) => void>()
  const owners = new Map<string, string | null>()
  try {
    const saved: unknown = JSON.parse(safeLocalStorage.getItem(OWNERS_KEY) ?? '{}')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, user] of Object.entries(saved)) if (user === null || typeof user === 'string') owners.set(id, user)
    }
  } catch { /* Unknown runs stay anonymous. */ }
  const forUser = (user: string | null) => {
    let repository = repositories.get(user)
    if (!repository) {
      repository = createFocusSessionRepository({ databaseName: user === null
        ? FOCUS_SESSION_DATABASE_NAME : `${FOCUS_SESSION_DATABASE_NAME}.account.${encodeURIComponent(user)}` })
      repositories.set(user, repository)
    }
    return repository
  }
  let stopSubscription = () => {}
  let epoch = 0
  const stopIdentity = watch(userId, user => {
    const token = ++epoch
    stopSubscription()
    const selected = forUser(user)
    for (const listener of listeners) listener([])
    stopSubscription = selected.subscribe(values => { if (token === epoch) listeners.forEach(listener => listener(values)) })
    void selected.list().then(values => { if (token === epoch) listeners.forEach(listener => listener(values)) }).catch(() => {})
  }, { immediate: true, flush: 'sync' })
  const repository: FocusSessionRepository = {
    recordIfAbsent: record => forUser(userId.value).recordIfAbsent(record),
    list: () => forUser(userId.value).list(),
    exportFocusHistory: () => forUser(userId.value).exportFocusHistory(),
    clear: () => forUser(userId.value).clear(),
    storageMode: () => forUser(userId.value).storageMode(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    repository, forUser,
    timerRepository: { ...repository, recordIfAbsent: (record: FocusSessionRecord) =>
      forUser(owners.get(record.id) ?? null).recordIfAbsent(record) },
    claimRun(id: string) {
      if (owners.has(id)) return
      owners.set(id, userId.value)
      // If persistence fails, reject before a run can acquire an ambiguous owner.
      safeLocalStorage.setItem(OWNERS_KEY, JSON.stringify(Object.fromEntries(owners)))
    },
    ownsCurrentRun(id: string) { return (owners.get(id) ?? null) === userId.value },
    destroy() { epoch++; stopIdentity(); stopSubscription(); listeners.clear() },
  }
}
