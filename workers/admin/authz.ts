import type { AuthEnv } from '../auth/routes'
import { findSession, readCookie, SESSION_COOKIE } from '../auth/session'
const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
export function adminMutationOriginGuard(request: Request, publicOrigin: string): Response | null {
  const path = new URL(request.url).pathname
  const mutation = ['PATCH', 'PUT', 'POST', 'DELETE'].includes(request.method)
  return mutation &&
    (path.startsWith('/api/admin/') || path === '/api/account/background-selection') &&
    request.headers.get('origin') !== publicOrigin
    ? json({ error: 'forbidden_origin' }, 403)
    : null
}
export function createAdminAuthorisation(
  env: AuthEnv,
  options: { now?: () => number; crypto?: Crypto } = {},
) {
  const now = options.now ?? Date.now,
    cryptoApi = options.crypto ?? globalThis.crypto
  const currentUser = async (request: Request) => {
    const session = await findSession(
      env.DB,
      readCookie(request, SESSION_COOKIE),
      env.SESSION_HMAC_SECRET,
      now(),
      cryptoApi,
    )
    if (!session) return json({ error: 'authentication_required' }, 401)
    return { id: session.userId, role: session.role }
  }
  const currentAdmin = async (
    request: Request,
  ): Promise<{ id: string; role: 'admin' | 'owner' } | Response> => {
    const session = await currentUser(request)
    if (session instanceof Response) return session
    if (session.role !== 'admin' && session.role !== 'owner')
      return json({ error: 'forbidden' }, 403)
    return { id: session.id, role: session.role }
  }
  return { currentUser, currentAdmin }
}
