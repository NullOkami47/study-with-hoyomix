import type { Locale } from '../../i18n'

export const NOTICE_DISMISSALS_STORAGE_KEY = 'study-with-hoyomix:notice-dismissals:v1'

const ENDPOINT = '/api/notices'

/** Bounded dismissal history: enough for real notice volume, small in storage. */
const MAX_DISMISSALS = 50
const MAX_REVISION_ID_LENGTH = 128

export type NoticeSeverity = 'info' | 'warning' | 'critical'

/** Locale text of one notice. Mirrors the Worker's public `content` map. */
export type NoticeContent = Partial<Record<Locale, string>>

/**
 * The only notice fields the view layer receives. Administrative fields
 * (`status`, `createdBy`, `targeting`, timestamps) are deliberately absent so
 * they cannot reach the DOM even if the endpoint were to widen later.
 */
export interface VisibleNotice {
  id: string
  revisionId: string
  severity: NoticeSeverity
  content: NoticeContent
}

// Eligibility metadata stays outside the public view model.
const noticeExpiries = new WeakMap<VisibleNotice, number>()

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface NoticeCentreStore {
  visibleNotices(): readonly VisibleNotice[]
  /** Active published notices, including revisions already dismissed from banners. */
  allNotices(): readonly VisibleNotice[]
  dismiss(revisionId: string): void
  refresh(): Promise<void>
  invalidateSession(): void
  subscribe(listener: () => void): () => void
}

export interface NoticeCentreStoreOptions {
  fetch?: typeof fetch
  storage?: StorageLike
  now?: () => number
}

/** Severity ordering used for display: the most urgent notice comes first. */
const SEVERITY_RANK: Record<NoticeSeverity, number> = { critical: 0, warning: 1, info: 2 }

const LOCALE_FALLBACKS: Record<Locale, readonly Locale[]> = {
  'zh-Hant': ['zh-Hant', 'zh-Hans', 'en'],
  'zh-Hans': ['zh-Hans', 'zh-Hant', 'en'],
  en: ['en', 'zh-Hans', 'zh-Hant'],
}

const KNOWN_LOCALES: readonly Locale[] = ['zh-Hant', 'zh-Hans', 'en']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSeverity = (value: unknown): value is NoticeSeverity =>
  value === 'info' || value === 'warning' || value === 'critical'

/**
 * Picks the notice text for the active locale, falling back through the other
 * locales so a notice authored in one language still reaches every reader.
 */
export function resolveNoticeText(content: NoticeContent, locale: Locale): string | null {
  for (const candidate of LOCALE_FALLBACKS[locale]) {
    const text = content[candidate]
    if (typeof text === 'string' && text.length > 0) return text
  }
  return null
}

/** Reads the public notice shape, keeping only displayable fields. */
const parseNotice = (value: unknown, nowMs: number): VisibleNotice | null => {
  if (!isRecord(value)) return null
  const { id, revisionId, severity, content, startAt, endAt } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof revisionId !== 'string' || revisionId.length === 0) return null
  if (!isSeverity(severity)) return null
  if (!isRecord(content)) return null

  const text: NoticeContent = {}
  for (const locale of KNOWN_LOCALES) {
    const entry = content[locale]
    if (entry === undefined) continue
    if (typeof entry !== 'string') return null
    if (entry.length > 0) text[locale] = entry
  }
  if (Object.keys(text).length === 0) return null

  // The Worker already filters the active window; re-check so a stale or
  // replayed response cannot surface a notice outside its schedule.
  if (startAt !== null && startAt !== undefined) {
    if (typeof startAt !== 'number' || !Number.isFinite(startAt) || startAt > nowMs) return null
  }
  if (endAt !== null && endAt !== undefined) {
    if (typeof endAt !== 'number' || !Number.isFinite(endAt) || endAt <= nowMs) return null
  }

  const notice: VisibleNotice = { id, revisionId, severity, content: text }
  if (typeof endAt === 'number') noticeExpiries.set(notice, endAt)
  return notice
}

const parseNoticesResponse = (value: unknown, nowMs: number): VisibleNotice[] | null => {
  if (!isRecord(value)) return null
  const { notices } = value
  if (!Array.isArray(notices)) return null
  const parsed: VisibleNotice[] = []
  for (const entry of notices) {
    const notice = parseNotice(entry, nowMs)
    if (notice !== null) parsed.push(notice)
  }
  return parsed.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity])
}

/**
 * Stored dismissals are advisory: a malformed record is discarded rather than
 * blocking notices, and unknown members are rejected so the shape cannot widen.
 */
const parseDismissals = (raw: string): string[] | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 2 || parsed.version !== 1) return null
  if (!Object.prototype.hasOwnProperty.call(parsed, 'dismissedRevisionIds')) return null
  const ids = parsed.dismissedRevisionIds
  if (!Array.isArray(ids)) return null
  return ids.filter((id): id is string => typeof id === 'string').slice(-MAX_DISMISSALS)
}

const isJsonResponse = (response: Response): boolean =>
  response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
    'application/json'

const defaultStorage = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

const sameNotices = (left: readonly VisibleNotice[], right: readonly VisibleNotice[]): boolean =>
  left.length === right.length &&
  left.every((entry, index) => {
    const other = right[index]!
    return entry.id === other.id && entry.revisionId === other.revisionId &&
      entry.severity === other.severity &&
      JSON.stringify(entry.content) === JSON.stringify(other.content)
  })

export function createNoticeCentreStore(
  options: NoticeCentreStoreOptions = {},
): NoticeCentreStore {
  const storage = options.storage ?? defaultStorage()
  const fetchImpl = options.fetch
  const now = options.now ?? (() => Date.now())
  const listeners = new Set<() => void>()

  let notices: VisibleNotice[] = []
  let dismissed: string[] = []
  let requestGeneration = 0
  let expiryTimer: ReturnType<typeof setTimeout> | undefined

  const readDismissals = (): void => {
    if (!storage) return
    let raw: string | null
    try {
      raw = storage.getItem(NOTICE_DISMISSALS_STORAGE_KEY)
    } catch {
      return
    }
    if (raw === null) return
    const parsed = parseDismissals(raw)
    if (parsed === null) {
      try { storage.removeItem(NOTICE_DISMISSALS_STORAGE_KEY) } catch { /* unavailable */ }
      return
    }
    dismissed = parsed
  }

  const writeDismissals = (): void => {
    if (!storage) return
    try {
      storage.setItem(NOTICE_DISMISSALS_STORAGE_KEY, JSON.stringify({
        version: 1,
        dismissedRevisionIds: dismissed,
      }))
    } catch {
      /* Dismissal persistence is advisory; the in-memory state still applies. */
    }
  }

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* A failing subscriber must not break notice updates. */
      }
    }
  }

  readDismissals()

  const dismissedSet = (): Set<string> => new Set(dismissed)

  const pruneExpired = (): void => {
    const currentTime = now()
    const active = notices.filter(entry => (noticeExpiries.get(entry) ?? Infinity) > currentTime)
    if (active.length === notices.length) return
    notices = active
    notify()
  }

  const scheduleExpiry = (): void => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    expiryTimer = undefined
    if (listeners.size === 0) return
    const deadline = Math.min(...notices.map(entry => noticeExpiries.get(entry) ?? Infinity))
    if (!Number.isFinite(deadline)) return
    // Browsers clamp long timeouts; revisit distant deadlines without expiring early.
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined
      pruneExpired()
      scheduleExpiry()
    }, Math.min(Math.max(0, deadline - now()), 2_147_483_647))
  }

  /**
   * Moves dismissals for notices that are still being served to the tail of the
   * bounded list. The cap then evicts ids for notices that have gone away
   * instead of resurfacing one the reader already dismissed. Only the order
   * changes, never the set, so visible notices are unaffected.
   */
  const retainLiveDismissals = (): void => {
    if (dismissed.length === 0) return
    const live = new Set(notices.map((entry) => entry.revisionId))
    const stale = dismissed.filter((id) => !live.has(id))
    if (stale.length === dismissed.length) return
    const reordered = [...stale, ...dismissed.filter((id) => live.has(id))]
    if (reordered.every((id, index) => id === dismissed[index])) return
    dismissed = reordered
    writeDismissals()
  }

  const visibleNotices = (): readonly VisibleNotice[] => {
    pruneExpired()
    const hidden = dismissedSet()
    return notices.filter((entry) => !hidden.has(entry.revisionId))
  }

  const refresh = async (): Promise<void> => {
    const generation = ++requestGeneration
    const request = fetchImpl ?? globalThis.fetch
    if (!request) return
    let response: Response
    try {
      response = await request(new URL(ENDPOINT, globalThis.location.origin).toString(), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
    } catch {
      return
    }
    if (!response.ok || !isJsonResponse(response)) return
    let body: unknown
    try {
      body = await response.json() as unknown
    } catch {
      return
    }
    if (generation !== requestGeneration) return
    const parsed = parseNoticesResponse(body, now())
    // A malformed payload leaves the previously displayed notices intact.
    if (parsed === null) return
    const beforeVisible = visibleNotices()
    const beforeAll = notices
    notices = parsed
    scheduleExpiry()
    retainLiveDismissals()
    if (!sameNotices(beforeAll, notices) || !sameNotices(beforeVisible, visibleNotices())) notify()
  }

  const dismiss = (revisionId: string): void => {
    if (typeof revisionId !== 'string') return
    if (revisionId.length === 0 || revisionId.length > MAX_REVISION_ID_LENGTH) return
    if (dismissed.includes(revisionId)) return
    dismissed = [...dismissed, revisionId].slice(-MAX_DISMISSALS)
    writeDismissals()
    notify()
  }

  return {
    visibleNotices,
    allNotices: () => { pruneExpired(); return [...notices] },
    invalidateSession: () => {
      requestGeneration += 1
      notices = []
      scheduleExpiry()
      notify()
    },
    dismiss,
    refresh,
    subscribe: (listener) => {
      listeners.add(listener)
      pruneExpired()
      scheduleExpiry()
      return () => { listeners.delete(listener); scheduleExpiry() }
    },
  }
}

let defaultStore: NoticeCentreStore | undefined

/** Session authority invalidates cached eligibility before its next request. */
export function invalidateDefaultNoticeSession(): void {
  if (!defaultStore) return
  defaultStore.invalidateSession()
  void defaultStore.refresh()
}

export function getDefaultNoticeCentreStore(): NoticeCentreStore {
  defaultStore ??= createNoticeCentreStore()
  return defaultStore
}
