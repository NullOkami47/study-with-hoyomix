import type { FocusSessionRepository } from './localRepository'
import { parseFocusSessionRecord, type FocusSessionRecord } from './types'
import { useAccountSession } from '../account/session'

export const MAX_REMOTE_FOCUS_SESSIONS = 512

export interface FocusMergeResult {
  insertedIds: string[]
  duplicateIds: string[]
}

export interface RemoteFocusSessionRepository {
  load(): Promise<FocusSessionRecord[]>
  merge(records: FocusSessionRecord[]): Promise<FocusMergeResult>
}

export interface RemoteFocusSessionRepositoryOptions {
  fetch?: typeof fetch
}

const FOCUS_SESSIONS_PATH = '/api/focus-sessions'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function envelope(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path}: invalid object`)
  }
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).length !== keys.length || keys.some((key) => !(key in candidate))) {
    throw new Error(`${path}: invalid shape`)
  }
  return candidate
}

function parseIds(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_REMOTE_FOCUS_SESSIONS) {
    throw new Error(`${path}: invalid array`)
  }
  return value.map((id, index) => {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw new Error(`${path}[${index}]: invalid id`)
    }
    return id
  })
}

async function body(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`remote_focus_${response.status}`)
  return response.json()
}

function uniqueSessions(records: readonly FocusSessionRecord[]): FocusSessionRecord[] {
  const unique = new Map<string, FocusSessionRecord>()
  for (const [index, value] of records.entries()) {
    const session = parseFocusSessionRecord(value, `focusSessions[${index}]`)
    const existing = unique.get(session.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(session)) {
      throw new Error('focus_session_conflict')
    }
    unique.set(session.id, session)
  }
  return [...unique.values()]
}

function captureAccount() {
  const session = useAccountSession()
  const revision = session.revision.value
  const userId = session.userId.value
  return {
    userId,
    assertCurrent() {
      if (session.revision.value !== revision || session.userId.value !== userId) {
        throw new Error('focus_session_account_changed')
      }
    },
  }
}

export function createRemoteFocusSessionRepository(
  options: RemoteFocusSessionRepositoryOptions = {},
): RemoteFocusSessionRepository {
  const fetcher = options.fetch ?? fetch
  const request = async (account: ReturnType<typeof captureAccount>, init?: RequestInit, path = FOCUS_SESSIONS_PATH) => {
    account.assertCurrent()
    const response = await fetcher(path, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15_000),
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(account.userId ? { 'x-account-user-id': account.userId } : {}),
      },
    })
    account.assertCurrent()
    return response
  }

  return {
    async load() {
      const account = captureAccount()
      const sessions: FocusSessionRecord[] = []
      let cursor: string | null = null
      do {
        const path = `${FOCUS_SESSIONS_PATH}?limit=${MAX_REMOTE_FOCUS_SESSIONS}${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`
        const value = await body(await request(account, undefined, path))
        account.assertCurrent()
        const paged = Boolean(value && typeof value === 'object' && 'nextCursor' in value)
        const response = envelope(value, paged ? ['sessions', 'nextCursor'] : ['sessions'], 'remoteFocusSessions')
        if (!Array.isArray(response.sessions) || (paged && response.sessions.length > MAX_REMOTE_FOCUS_SESSIONS)) {
          throw new Error('remoteFocusSessions.sessions: invalid array')
        }
        const page = response.sessions.map((session, index) =>
          parseFocusSessionRecord(session, `remoteFocusSessions.sessions[${index}]`))
        if (paged) {
          let previous = cursor ?? ''
          for (const session of page) {
            if (session.id <= previous) throw new Error('remoteFocusSessions: invalid cursor order')
            previous = session.id
          }
          const next = response.nextCursor
          if (next !== null && (typeof next !== 'string' || !UUID_PATTERN.test(next) ||
            next !== page.at(-1)?.id || next <= (cursor ?? ''))) {
            throw new Error('remoteFocusSessions: invalid cursor')
          }
          cursor = next as string | null
        } else {
          // Older Workers return the complete history in the original envelope.
          cursor = null
        }
        sessions.push(...page)
      } while (cursor !== null)
      return uniqueSessions(sessions)
    },
    async merge(records) {
      const account = captureAccount()
      // Validate the entire upload before writing its first bounded batch.
      const sessions = uniqueSessions(records)
      const result: FocusMergeResult = { insertedIds: [], duplicateIds: [] }
      for (let offset = 0; offset < sessions.length; offset += MAX_REMOTE_FOCUS_SESSIONS) {
        const batch = sessions.slice(offset, offset + MAX_REMOTE_FOCUS_SESSIONS)
        const response = envelope(
          await body(await request(account, { method: 'POST', body: JSON.stringify({ sessions: batch }) })),
          ['insertedIds', 'duplicateIds'],
          'focusMergeResult',
        )
        account.assertCurrent()
        const insertedIds = parseIds(response.insertedIds, 'focusMergeResult.insertedIds')
        const duplicateIds = parseIds(response.duplicateIds, 'focusMergeResult.duplicateIds')
        const acknowledged = new Set([...insertedIds, ...duplicateIds])
        if (acknowledged.size !== batch.length || insertedIds.length + duplicateIds.length !== batch.length ||
          batch.some(session => !acknowledged.has(session.id))) {
          throw new Error('focusMergeResult: invalid acknowledgement')
        }
        result.insertedIds.push(...insertedIds)
        result.duplicateIds.push(...duplicateIds)
      }
      return result
    },
  }
}

let defaultRemoteRepository: RemoteFocusSessionRepository | undefined

export function getDefaultRemoteFocusSessionRepository(): RemoteFocusSessionRepository {
  defaultRemoteRepository ??= createRemoteFocusSessionRepository()
  return defaultRemoteRepository
}

/**
 * Compatibility helper for callers with an explicitly scoped repository.
 * The workspace coordinator owns automatic sync; failures never clear history.
 */
export async function syncLocalFocusSessions(
  local: FocusSessionRepository,
  remote: RemoteFocusSessionRepository,
): Promise<FocusMergeResult> {
  const account = captureAccount()
  const sessions = await local.list()
  account.assertCurrent()
  if (sessions.length === 0) return { insertedIds: [], duplicateIds: [] }
  return remote.merge(sessions)
}


/**
 * Two-way Focus history merge. Each immutable record is keyed by its ID,
 * and a divergent local/remote record aborts before any writes.
 */
export async function syncFocusSessionsAcrossDevices(
  local: FocusSessionRepository,
  remote: RemoteFocusSessionRepository,
  assertActive: () => void = () => undefined,
): Promise<FocusMergeResult & { downloadedCount: number }> {
  const account = captureAccount()
  const assertCurrent = () => { account.assertCurrent(); assertActive() }
  assertCurrent()
  const [localValues, remoteValues] = await Promise.all([local.list(), remote.load()])
  assertCurrent()
  const localSessions = uniqueSessions(localValues)
  const remoteSessions = uniqueSessions(remoteValues)
  const localById = new Map(localSessions.map(session => [session.id, session]))
  for (const session of remoteSessions) {
    const existing = localById.get(session.id)
    if (existing && JSON.stringify(existing) !== JSON.stringify(session)) {
      throw new Error('focus_session_conflict')
    }
  }
  const result = localSessions.length
    ? await remote.merge(localSessions)
    : { insertedIds: [], duplicateIds: [] }
  assertCurrent()
  let downloadedCount = 0
  for (const session of remoteSessions) {
    assertCurrent()
    if (!localById.has(session.id)) {
      if (await local.recordIfAbsent(session) === 'inserted') downloadedCount += 1
    }
  }
  return { ...result, downloadedCount }
}
