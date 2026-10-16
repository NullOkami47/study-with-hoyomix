import type { Env } from '../env'
import { findSession, readCookie, SESSION_COOKIE } from '../auth/session'
import { LibraryValidationError } from '../../src/features/library/types'
import { readBoundedJsonRequest } from '../providers/boundedJson'
import {
  clearHistory,
  deleteAccount,
  exportAccountData,
  markAvatarDeletionProcessed,
  readLibrary,
  type AvatarDeletionEvent,
} from './repository'

export interface LibraryEnv extends Env {
  PUBLIC_ORIGIN: string
  SESSION_HMAC_SECRET: string
}

export interface LibraryRouteOptions {
  crypto?: Crypto
  now?: () => number
  emitAvatarDeletion?: (event: AvatarDeletionEvent) => Promise<void>
}

const json = (value: unknown, status = 200) => Response.json(value, {
  status,
  headers: { 'cache-control': 'no-store' },
})

const exactKeys = (value: unknown, required: readonly string[], optional: readonly string[] = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LibraryValidationError('request', 'must be an object')
  const candidate = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  if (Object.keys(candidate).some((key) => !allowed.has(key)) || required.some((key) => !(key in candidate))) {
    throw new LibraryValidationError('request', 'has an invalid shape')
  }
  return candidate
}

const requestJson = async (request: Request) => {
  try {
    return await readBoundedJsonRequest(request, 5 * 1024 * 1024)
  } catch {
    throw new LibraryValidationError('request', 'must be bounded application/json')
  }
}

export function createLibraryHandler(env: LibraryEnv, options: LibraryRouteOptions = {}) {
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
    if (isMutation && request.headers.get('origin') !== origin) return json({ error: 'forbidden_origin' }, 403)
    const userId = await authenticatedUserId(request)
    if (!userId) return json({ error: 'authentication_required' }, 401)

    try {
      if (request.method === 'GET' && route === '/api/library') return json(await readLibrary(env.DB, userId))
      if (request.method === 'POST' && (route === '/api/library/merge' || route === '/api/history')) {
        // Preserve historical account data and read/deletion controls while
        // preventing old clients from resuming unsupported account sync.
        return json({ error: 'account_library_sync_retired' }, 410)
      }
      if (request.method === 'GET' && route === '/api/history') {
        return json({ recentHistory: (await readLibrary(env.DB, userId)).recentHistory })
      }
      if (request.method === 'DELETE' && route === '/api/history') {
        await clearHistory(env.DB, userId)
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      }
      if (request.method === 'GET' && route === '/api/export') return json(await exportAccountData(env.DB, userId))
      if (request.method === 'POST' && route === '/api/account/delete') {
        const body = exactKeys(await requestJson(request), ['confirmation'])
        if (body.confirmation !== 'DELETE') return json({ error: 'deletion_confirmation_required' }, 400)
        const eventId = cryptoApi.randomUUID()
        const event = await deleteAccount(env.DB, userId, now(), eventId)
        if (event && options.emitAvatarDeletion) {
          try {
            await options.emitAvatarDeletion(event)
            await markAvatarDeletionProcessed(env.DB, eventId, now())
          } catch {
            // The transactional outbox row remains pending for a later retry.
          }
        }
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      }
      return json({ error: 'not_found' }, 404)
    } catch (error) {
      if (error instanceof LibraryValidationError) return json({ error: 'invalid_library', path: error.path }, 400)
      return json({ error: 'library_operation_failed' }, 500)
    }
  }

  return { fetch: fetchHandler }
}
