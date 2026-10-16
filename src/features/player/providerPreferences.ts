export const PROVIDER_PREFERENCES_STORAGE_KEY_V1 = 'study-with-hoyomix:provider-preferences:v1'
export const PROVIDER_PREFERENCES_STORAGE_KEY = 'study-with-hoyomix:provider-preferences:v2'
export const PROVIDER_PREFERENCES_ACCOUNT_KEY = 'study-with-hoyomix:provider-preferences:account:v1'

const ENDPOINT = '/api/account/provider-preferences'

/**
 * Top-level playback providers a user may disable for themselves.
 * Normal automatic providers are chksz, lx, and jellyfin.
 * This list mirrors the Worker's `USER_TOGGLEABLE_PROVIDER_IDS`.
 */
export const USER_TOGGLEABLE_PROVIDER_IDS = [
  'chksz',
  'lx',
  'jellyfin',
] as const

export type UserToggleableProviderId = typeof USER_TOGGLEABLE_PROVIDER_IDS[number]

export const LEGACY_LX_IDS = [
  'lx-huibq',
  'lx-ikun',
  'lx-juhe',
  'lx-qdy',
  'lx-flower',
  'lx-lx',
  'lx-grass',
  'lx-sixyin',
] as const

const TOGGLEABLE_IDS = new Set<string>(USER_TOGGLEABLE_PROVIDER_IDS)
const CANONICAL_ORDER = new Map<string, number>(
  USER_TOGGLEABLE_PROVIDER_IDS.map((id, index) => [id, index]),
)

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ProviderPreferencesStore {
  disabledProviderIds(): ReadonlySet<string>
  isDisabled(id: string): boolean
  revision(): number
  setDisabled(id: string, disabled: boolean): void
  setSignedIn(signedIn: boolean, accountId?: string): Promise<void>
  subscribe(listener: () => void): () => void
  flush(): Promise<void>
}

export interface ProviderPreferencesStoreOptions {
  fetch?: typeof fetch
  storage?: StorageLike
}

const defaultStorage = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

const inCanonicalOrder = (ids: Iterable<string>): UserToggleableProviderId[] =>
  [...ids]
    .filter((id): id is UserToggleableProviderId => TOGGLEABLE_IDS.has(id))
    .sort((left, right) =>
      (CANONICAL_ORDER.get(left) ?? 0) - (CANONICAL_ORDER.get(right) ?? 0))

/**
 * Pure helper to migrate legacy disabled provider IDs to the three-provider model:
 * 1. Old chksz disabled -> new chksz disabled.
 * 2. All 8 old LX IDs disabled -> new lx disabled.
 * 3. If not all 8 old LX IDs disabled -> new lx remains enabled.
 * 4. Jellyfin absent -> remains enabled (not disabled).
 * 5. Obsolete IDs (r2, meting, piped, invidious, gd-studio, qijie, etc.) -> dropped.
 * 6. Idempotent: migrating an already migrated array leaves it unchanged.
 */
export function migrateLegacyDisabledProviderIds(
  ids: readonly string[],
): UserToggleableProviderId[] {
  const set = new Set(ids)
  const result: UserToggleableProviderId[] = []

  if (set.has('chksz')) {
    result.push('chksz')
  }

  const allLegacyLxDisabled = LEGACY_LX_IDS.every((id) => set.has(id))
  if (set.has('lx') || allLegacyLxDisabled) {
    result.push('lx')
  }

  if (set.has('jellyfin')) {
    result.push('jellyfin')
  }

  return inCanonicalOrder(result)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Reads the exact `{disabledProviderIds: string[]}` envelope the Worker
 * returns. Any other shape, or any unknown member, is rejected so remote state
 * can never widen the local contract.
 */
const parseRemoteSelection = (value: unknown): UserToggleableProviderId[] | null => {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'disabledProviderIds') return null
  const ids = value.disabledProviderIds
  if (!Array.isArray(ids) || ids.length > USER_TOGGLEABLE_PROVIDER_IDS.length) return null

  const selection = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || !TOGGLEABLE_IDS.has(id) || selection.has(id)) return null
    selection.add(id)
  }
  return inCanonicalOrder(selection)
}

const parseLocalSelectionV2 = (raw: string): UserToggleableProviderId[] | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const keys = Object.keys(parsed)
  if (
    keys.length !== 2 || parsed.version !== 2 ||
    !Object.prototype.hasOwnProperty.call(parsed, 'disabledProviderIds')
  ) return null
  const ids = parsed.disabledProviderIds
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return null
  return inCanonicalOrder(ids as string[])
}

const parseLocalSelectionV1 = (raw: string): string[] | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const keys = Object.keys(parsed)
  if (
    keys.length !== 2 || parsed.version !== 1 ||
    !Object.prototype.hasOwnProperty.call(parsed, 'disabledProviderIds')
  ) return null
  const ids = parsed.disabledProviderIds
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return null
  return ids as string[]
}

const isJsonResponse = (response: Response): boolean =>
  response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
    'application/json'

export function createProviderPreferencesStore(
  options: ProviderPreferencesStoreOptions = {},
): ProviderPreferencesStore {
  const storage = options.storage ?? defaultStorage()
  const fetchImpl = options.fetch
  const endpoint = new URL(ENDPOINT, globalThis.location.origin).toString()
  const listeners = new Set<() => void>()

  let disabled = new Set<UserToggleableProviderId>()
  let currentRevision = 0
  let signedIn = false
  let accountId: string | undefined
  let hasAccountAssociation = false
  let accountReady = false
  let sessionGeneration = 0
  let editRevision = 0
  const localEdits = new Map<UserToggleableProviderId, { disabled: boolean; revision: number }>()
  let pending: Promise<void> = Promise.resolve()

  try {
    // A marker, even a malformed one, must never make an old account's choices
    // look like first-visit anonymous data eligible for upload to another account.
    hasAccountAssociation = storage?.getItem(PROVIDER_PREFERENCES_ACCOUNT_KEY) != null
  } catch { /* Storage may be unavailable; this page still tracks its association. */ }

  const rememberAccount = (): void => {
    if (!accountId) return
    hasAccountAssociation = true
    try { storage?.setItem(PROVIDER_PREFERENCES_ACCOUNT_KEY, accountId) } catch { /* advisory persistence */ }
  }

  const readLocal = (): void => {
    if (!storage) return
    let rawV2: string | null = null
    try {
      rawV2 = storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY)
    } catch {
      return
    }

    if (rawV2 !== null) {
      const selection = parseLocalSelectionV2(rawV2)
      if (selection === null) {
        try { storage.removeItem(PROVIDER_PREFERENCES_STORAGE_KEY) } catch { /* unavailable */ }
        return
      }
      disabled = new Set(selection)
      return
    }

    let rawV1: string | null = null
    try {
      rawV1 = storage.getItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1)
    } catch {
      return
    }

    if (rawV1 !== null) {
      const v1Selection = parseLocalSelectionV1(rawV1)
      if (v1Selection === null) {
        try { storage.removeItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1) } catch { /* unavailable */ }
        return
      }
      const migrated = migrateLegacyDisabledProviderIds(v1Selection)
      disabled = new Set(migrated)
      writeLocal()
      try { storage.removeItem(PROVIDER_PREFERENCES_STORAGE_KEY_V1) } catch { /* unavailable */ }
    }
  }

  const writeLocal = (): void => {
    if (!storage) return
    try {
      storage.setItem(PROVIDER_PREFERENCES_STORAGE_KEY, JSON.stringify({
        version: 2,
        disabledProviderIds: inCanonicalOrder(disabled),
      }))
    } catch {
      /* Local persistence is advisory; the in-memory selection still applies. */
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

  const applySelection = (selection: readonly UserToggleableProviderId[]): void => {
    const next = new Set(selection)
    const changed = next.size !== disabled.size ||
      [...next].some((id) => !disabled.has(id))
    disabled = next
    writeLocal()
    if (changed) notify()
  }

  const request = async (init: RequestInit): Promise<unknown | null> => {
    const call = fetchImpl ?? fetch
    try {
      const response = await call(endpoint, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
        redirect: 'error',
        ...init,
      })
      if (!response.ok || !isJsonResponse(response)) return null
      return await response.json() as unknown
    } catch {
      return null
    }
  }

  const pushSelection = async (generation: number): Promise<void> => {
    if (!signedIn || !accountReady || generation !== sessionGeneration) return
    const revision = editRevision
    const body = JSON.stringify({ disabledProviderIds: inCanonicalOrder(disabled) })
    const remote = parseRemoteSelection(await request({ method: 'PUT', body }))
    if (!signedIn || generation !== sessionGeneration || !remote) return
    rememberAccount()
    if (revision === editRevision) applySelection(remote)
  }

  const enqueue = (work: () => Promise<void>): Promise<void> => {
    pending = pending.then(work, work)
    return pending
  }

  readLocal()

  return {
    disabledProviderIds: () => new Set(inCanonicalOrder(disabled)),
    isDisabled: (id) => disabled.has(id as UserToggleableProviderId),
    revision: () => currentRevision,

    setDisabled(id, shouldDisable) {
      if (!TOGGLEABLE_IDS.has(id)) return
      const providerId = id as UserToggleableProviderId
      if (disabled.has(providerId) === shouldDisable) return
      if (shouldDisable) disabled.add(providerId)
      else disabled.delete(providerId)
      editRevision += 1
      localEdits.set(providerId, { disabled: shouldDisable, revision: editRevision })
      writeLocal()
      notify()
      const generation = sessionGeneration
      if (signedIn && accountReady) void enqueue(() => pushSelection(generation))
    },

    async setSignedIn(nextSignedIn, nextAccountId) {
      // Re-publishing the same resolved identity is not a fresh login. In
      // particular it must not cancel edits already queued for that account.
      if (nextSignedIn && signedIn && nextAccountId === accountId && accountReady) {
        await pending
        return
      }
      const generation = ++sessionGeneration
      signedIn = nextSignedIn
      accountId = nextSignedIn ? nextAccountId : undefined
      accountReady = false
      // A slow request for an old account cannot block the new account's queue.
      pending = Promise.resolve()
      if (!nextSignedIn) return
      const revision = editRevision
      const local = inCanonicalOrder(disabled)
      const mergeAnonymous = !nextAccountId || !hasAccountAssociation
      await enqueue(async () => {
        if (!signedIn || generation !== sessionGeneration) return
        const remote = parseRemoteSelection(await request({ method: 'GET' }))
        if (!signedIn || generation !== sessionGeneration || !remote) return
        const selection = new Set(mergeAnonymous ? [...remote, ...local] : remote)
        // Apply only deliberate edits made while this account read was pending.
        // A re-enable is a removal, so union alone cannot preserve that action.
        for (const [id, edit] of localEdits) {
          if (edit.revision <= revision) continue
          if (edit.disabled) selection.add(id)
          else selection.delete(id)
        }
        const merged = inCanonicalOrder(selection)
        accountReady = true
        applySelection(merged)
        if (merged.length !== remote.length || merged.some((id, index) => remote[index] !== id)) {
          await pushSelection(generation)
        } else rememberAccount()
      })
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    flush: () => enqueue(async () => undefined),
  }
}

let defaultStore: ProviderPreferencesStore | undefined

export const getDefaultProviderPreferencesStore = (): ProviderPreferencesStore => {
  defaultStore ??= createProviderPreferencesStore()
  return defaultStore
}
