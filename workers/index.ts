import {createCatalogueAdminHandler,type CatalogueEnv} from './catalogue/adminRoutes'
import { cataloguePublicResponse } from './catalogue/publicRoutes'
import { createAuthHandler, type AuthEnv } from './auth/routes'
import { createAdminHandler } from './admin/routes'
import { createFocusHandler } from './focus/routes'
import { createLibraryHandler } from './library/routes'
import { createAccountPreferencesHandler } from './account/preferences'
import { createProviderPreferencesHandler } from './providers/preferences'
import { createProviderHandler } from './providers/routes'
import type { BackgroundEnv } from './backgrounds/routes'
import { authenticateProxyIngress } from './proxyIngress'
import { IMPLEMENTED_LX_PROVIDER_IDS, type ProviderEnv } from './providers/config'

import { getBuildInfo } from './buildInfo'
import { presenceRoute, type PresenceEnv } from './presence'
export { OnlinePresence } from './presence'

interface AppEnv extends AuthEnv, ProviderEnv, BackgroundEnv, CatalogueEnv, PresenceEnv {
  API_PROXY_SECRET?: string
  BACKEND_ORIGIN?: string
  PROXY_FRONTEND_ORIGIN?: string
}

const ROUTED_PROVIDER_IDS = [
  'chksz',
  'meting',
  'piped',
  'invidious',
  'jellyfin',
  'gd-studio',
  'lx-huanyin',
  ...IMPLEMENTED_LX_PROVIDER_IDS,
] as const

const isProviderPath = (path: string): boolean =>
  path === '/api/providers/config' ||
  path === '/api/providers/chksz/discover' ||
  path === '/api/providers/chksz/artwork' ||
  path.startsWith('/api/providers/jellyfin/artwork/') ||
  ROUTED_PROVIDER_IDS.some((providerId) =>
    path === `/api/providers/${providerId}/resolve` ||
    path.startsWith(`/api/providers/${providerId}/media/`))

const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

export const applyApiSecurityHeaders = (response: Response): Response => {
  // A WebSocket handshake owns a live socket; rewrapping it loses that socket.
  if (response.status === 101) return response
  const headers = new Headers(response.headers)
  headers.set('content-security-policy', API_CONTENT_SECURITY_POLICY)
  headers.set('referrer-policy', 'no-referrer')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

const routeRequest = (request: Request, env: AppEnv): Promise<Response> => {
  const path = new URL(request.url).pathname
  if (path === '/api/presence' || path === '/api/presence/visitor') return presenceRoute(request, env)
  if (path === '/api/build-info' || path === '/api/version') {
    return Promise.resolve(Response.json(getBuildInfo(), {
      headers: { 'cache-control': 'no-store' },
    }))
  }
  if (path === '/api/catalogue') return cataloguePublicResponse(request, env.DB)
  if (path === '/api/admin/catalogue' || path.startsWith('/api/admin/catalogue/')) return createCatalogueAdminHandler(env).fetch(request)
  if (isProviderPath(path)) return createProviderHandler(env).fetch(request)
  if (
    path.startsWith('/api/admin/') || path === '/api/notices' ||
    path === '/api/account/background-selection' ||
    path === '/api/backgrounds' || path.startsWith('/api/backgrounds/')
  ) return createAdminHandler(env).fetch(request)
  if (path === '/api/account/ui-preferences') return createAccountPreferencesHandler(env).fetch(request)
  if (path === '/api/account/provider-preferences') {
    return createProviderPreferencesHandler(env).fetch(request)
  }
  if (path === '/api/focus-sessions') return createFocusHandler(env).fetch(request)
  if (path === '/api/library' || path === '/api/library/merge' || path === '/api/history' ||
    path === '/api/export' || path === '/api/account/delete') {
    return createLibraryHandler(env).fetch(request)
  }
  return createAuthHandler(env).fetch(request)
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const incoming = await authenticateProxyIngress(request, env)
    const response = incoming instanceof Response ? incoming : await routeRequest(incoming, env)
    if (!(incoming instanceof Response) && incoming.method === 'POST' && response.ok &&
      ['/api/logout', '/api/logout-all', '/api/account/delete'].includes(new URL(incoming.url).pathname) && env.PRESENCE) {
      // Revocation is already committed. Refresh every Owner session, including other tabs/devices.
      try {
        await env.PRESENCE.get(env.PRESENCE.idFromName('study-with-hoyomix')).fetch(new Request('https://presence.internal/revalidate', { method: 'POST' }))
      } catch { /* Revoked auth must remain successful even if presence is unavailable; the Owner lease fails closed on its next check. */ }
    }
    return applyApiSecurityHeaders(response)
  },
}
