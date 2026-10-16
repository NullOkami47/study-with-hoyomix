import type { Env } from '../env'
import { findSession, readCookie, SESSION_COOKIE } from '../auth/session'
import { readBoundedJsonRequest } from '../providers/boundedJson'
import {
  FocusValidationError,
  parseFocusSessionRecord,
  type FocusSessionRecord,
} from '../../src/features/focus/types'
import {
  FocusSessionConflictError,
  MAX_FOCUS_SESSIONS_PER_REQUEST,
  mergeFocusSessions,
  readFocusSessions,
  readFocusSessionsPage,
} from './repository'

export interface FocusEnv extends Env {
  PUBLIC_ORIGIN: string
  SESSION_HMAC_SECRET: string
}

export interface FocusRouteOptions {
  crypto?: Crypto
  now?: () => number
}

const MAX_FOCUS_REQUEST_BYTES = 512 * 1024

const json = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { 'cache-control': 'no-store' },
})

async function requestSessions(request: Request): Promise<FocusSessionRecord[]> {
  let body: unknown
  try {
    body = await readBoundedJsonRequest(request, MAX_FOCUS_REQUEST_BYTES)
  } catch {
    throw new FocusValidationError('request', 'must be bounded application/json')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new FocusValidationError('request', 'must be an object')
  }
  const candidate = body as Record<string, unknown>
  const keys = Object.keys(candidate)
  if (keys.length !== 1 || keys[0] !== 'sessions') {
    throw new FocusValidationError('request', 'must contain exactly one sessions field')
  }
  if (!Array.isArray(candidate.sessions)) {
    throw new FocusValidationError('request.sessions', 'must be an array')
  }
  return candidate.sessions.map(
    (session, index) => parseFocusSessionRecord(session, `request.sessions[${index}]`),
  )
}

export function createFocusHandler(env: FocusEnv, options: FocusRouteOptions = {}) {
  const cryptoApi = options.crypto ?? crypto
  const now = options.now ?? Date.now
  const origin = new URL(env.PUBLIC_ORIGIN).origin

  const authenticatedUserId = async (request: Request) => {
    const token = readCookie(request, SESSION_COOKIE)
    return (await findSession(env.DB, token, env.SESSION_HMAC_SECRET, now(), cryptoApi))?.userId ?? null
  }

  const fetchHandler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const route = url.pathname
    const isMutation = request.method !== 'GET' && request.method !== 'HEAD'
    if (isMutation && request.headers.get('origin') !== origin) {
      return json({ error: 'forbidden_origin' }, 403)
    }
    const userId = await authenticatedUserId(request)
    if (!userId) return json({ error: 'authentication_required' }, 401)
    const expectedUserId = request.headers.get('x-account-user-id')
    if (expectedUserId !== null && expectedUserId !== userId) {
      return json({ error: 'focus_session_account_changed' }, 409)
    }

    try {
      if (request.method === 'GET' && route === '/api/focus-sessions') {
        if (url.searchParams.size > 0) {
          const limit = url.searchParams.get('limit')
          const after = url.searchParams.get('after')
          if (!limit || !/^[1-9][0-9]*$/u.test(limit) || Number(limit) > MAX_FOCUS_SESSIONS_PER_REQUEST ||
            (after !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(after)) ||
            [...url.searchParams.keys()].some(key => key !== 'limit' && key !== 'after') ||
            url.searchParams.getAll('limit').length !== 1 || url.searchParams.getAll('after').length > 1) {
            return json({ error: 'invalid_focus_pagination' }, 400)
          }
          return json(await readFocusSessionsPage(env.DB, userId, Number(limit), after ?? ''))
        }
        return json({ sessions: await readFocusSessions(env.DB, userId) })
      }
      if (request.method === 'POST' && route === '/api/focus-sessions') {
        const sessions = await requestSessions(request)
        if (sessions.length > MAX_FOCUS_SESSIONS_PER_REQUEST) {
          return json({ error: 'focus_session_batch_too_large' }, 413)
        }
        return json(await mergeFocusSessions(env.DB, userId, sessions))
      }
      return json({ error: 'not_found' }, 404)
    } catch (error) {
      if (error instanceof FocusSessionConflictError) {
        return json({ error: 'focus_session_conflict', id: error.id }, 409)
      }
      if (error instanceof FocusValidationError) {
        return json({ error: 'invalid_focus_session', path: error.path }, 400)
      }
      return json({ error: 'focus_operation_failed' }, 500)
    }
  }

  return { fetch: fetchHandler }
}
