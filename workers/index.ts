import { createVkeysHandler } from './providers/vkeysRoutes'
import {createCatalogueAdminHandler,type CatalogueEnv} from './catalogue/adminRoutes'
import { cataloguePublicResponse } from './catalogue/publicRoutes'
import { authStartRateLimiter, createAuthHandler, type AuthEnv } from './auth/routes'
import { findSession, readCookie, SESSION_COOKIE } from './auth/session'
import type { ExecutionContext, ScheduledController } from './env'
import { runMaintenance } from './maintenance'
import { runDiscoveryAutomationCycle } from './catalogue/discovery/automationCycle'
import { createAdminHandler } from './admin/routes'
import { createFocusHandler } from './focus/routes'
import { createLibraryHandler } from './library/routes'
import { createAccountPreferencesHandler } from './account/preferences'
import { createProviderPreferencesHandler } from './providers/preferences'
import { createProviderHandler } from './providers/routes'
import { createLxPublicHandler } from './lx/publicRoutes'
import { createLxSourcesHandler } from './admin/lxSources'
import { adminMutationOriginGuard } from './admin/authz'
import type { BackgroundEnv } from './backgrounds/routes'
import { authenticateProxyIngress } from './proxyIngress'
import { IMPLEMENTED_LX_PROVIDER_IDS, type ProviderEnv } from './providers/config'

import { getBuildInfo } from './buildInfo'
import { presenceRoute, type PresenceEnv } from './presence'
import { createDiscoveryIngestHandler } from './catalogue/discovery/routes'
export { OnlinePresence } from './presence'
import { chatRoute, type ChatEnv } from './chat/routes'
export { ChatRoom } from './chat/ChatRoom'

interface AppEnv extends AuthEnv, ProviderEnv, BackgroundEnv, CatalogueEnv, PresenceEnv, ChatEnv {
  API_PROXY_SECRET?: string
  /**
   * The approved LX origins, in the same syntax as the build-time `LX_ALLOWED_ORIGINS`. It must
   * name the same origins as the build; the client additionally checks the real document policy,
   * so a mismatch can only make a source unusable, never widen access.
   */
  LX_ALLOWED_ORIGINS?: string
  /** L-17: exact HTTPS origins of the trusted Worker upstream and Vercel frontend; proxy ingress is refused without both. */
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
  'vkeys',
  'lx-huanyin',
  ...IMPLEMENTED_LX_PROVIDER_IDS,
] as const

const isProviderPath = (path: string): boolean =>
  path === '/api/providers/config' ||
  path === '/api/providers/chksz/discover' ||
  path === '/api/providers/chksz/artwork' ||
  path.startsWith('/api/providers/jellyfin/artwork/') ||
  path.startsWith('/api/providers/lx/artwork/') ||
  path.startsWith('/api/providers/gd-studio/artwork/') ||
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

// `ctx` is threaded through so routes can defer post-response work with `ctx.waitUntil` (H-02, H-03).
// It is optional because tests and older call sites invoke `fetch(request, env)`.
const routeRequest = (request: Request, env: AppEnv, ctx?: ExecutionContext): Promise<Response> => {
  const path = new URL(request.url).pathname
  if (path === '/api/chat' || path.startsWith('/api/chat/')) return chatRoute(request, env)
  if (path === '/api/presence' || path === '/api/presence/visitor') return presenceRoute(request, env)
  if (path === '/api/build-info' || path === '/api/version') {
    return Promise.resolve(Response.json(getBuildInfo(), {
      headers: { 'cache-control': 'no-store' },
    }))
  }
  if (path === '/api/catalogue/discovery/runs') return createDiscoveryIngestHandler(env).fetch(request)
  if (path === '/api/catalogue') return cataloguePublicResponse(request, env.DB, ctx)
  // The published global LX sources: anonymous and read-only.
  if (path === '/api/lx/sources' || path.startsWith('/api/lx/sources/')) {
    return createLxPublicHandler(env).fetch(request)
  }
  // The registry itself: Owner-only mutations, with the same cross-origin guard the rest of the
  // Admin surface uses.
  if (path === '/api/admin/lx/sources' || path.startsWith('/api/admin/lx/sources/')) {
    const originGuard = adminMutationOriginGuard(request, new URL(env.PUBLIC_ORIGIN).origin)
    if (originGuard) return Promise.resolve(originGuard)
    return createLxSourcesHandler(env, {
      requireOwner: async (ownerRequest: Request) => {
        const session = await findSession(
          env.DB,
          readCookie(ownerRequest, SESSION_COOKIE),
          env.SESSION_HMAC_SECRET,
          Date.now(),
          crypto,
        )
        if (!session) return Response.json({ error: 'authentication_required' }, { status: 401 })
        if (session.role !== 'owner') return Response.json({ error: 'forbidden' }, { status: 403 })
        // The id, not just the verdict: every mutation writes an audit record naming this user.
        return { id: session.userId }
      },
    }).fetch(request)
  }
  if (path === '/api/admin/catalogue' || path.startsWith('/api/admin/catalogue/')) return createCatalogueAdminHandler(env).fetch(request)
  if (path === '/api/providers/vkeys/resolve' || path.startsWith('/api/providers/vkeys/media/')) return createVkeysHandler(env).fetch(request)
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
  return createAuthHandler(env, { startLimiter: authStartRateLimiter(env) }).fetch(request)
}

const REVOCATION_PATHS = ['/api/logout', '/api/logout-all', '/api/account/delete']

const sessionUserId = async (request: Request, env: AppEnv): Promise<string | null> => {
  const session = await findSession(env.DB, readCookie(request, SESSION_COOKIE), env.SESSION_HMAC_SECRET, Date.now(), crypto)
  return session?.userId ?? null
}

export default {
  async fetch(request: Request, env: AppEnv, ctx?: ExecutionContext): Promise<Response> {
    const incoming = await authenticateProxyIngress(request, env)
    const path = incoming instanceof Response ? '' : new URL(incoming.url).pathname
    const revocation = !(incoming instanceof Response) && incoming.method === 'POST' && REVOCATION_PATHS.includes(path)
    // Account deletion removes the session, so the chat room learns who left only if the
    // user is resolved first (one session read, on this rare path only; H-02 step 2).
    const deletedUserId = revocation && path === '/api/account/delete' && env.CHAT
      ? await sessionUserId(incoming as Request, env).catch(() => null)
      : null
    const response = incoming instanceof Response ? incoming : await routeRequest(incoming, env, ctx)
    if (revocation && response.ok) {
      // The revocation is already committed and every chat/presence operation re-checks the
      // session, so the responses never wait for the Durable Objects (H-02 step 1).
      const work: Promise<unknown>[] = []
      if (env.CHAT) {
        const chat = env.CHAT
        const body = path === '/api/account/delete'
          ? { reason: 'account_delete', ...(deletedUserId ? { userId: deletedUserId } : {}) }
          : { reason: path === '/api/logout-all' ? 'logout_all' : 'logout' }
        work.push(Promise.resolve().then(() => chat.get(chat.idFromName('global')).fetch(new Request('https://chat.internal/revalidate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }))).catch(() => { /* Every subsequent chat operation still validates the committed session state. */ }))
      }
      if (env.PRESENCE) {
        const presence = env.PRESENCE
        // Refresh every Owner session, including other tabs/devices.
        work.push(Promise.resolve().then(() => presence.get(presence.idFromName('study-with-hoyomix')).fetch(new Request('https://presence.internal/revalidate', { method: 'POST' })))
          .catch(() => { /* Revoked auth must remain successful even if presence is unavailable; the Owner lease fails closed on its next check. */ }))
      }
      if (ctx) for (const promise of work) ctx.waitUntil(promise)
      else await Promise.all(work) // No execution context (direct test calls): keep the old ordering.
    }
    return applyApiSecurityHeaders(response)
  },

  // Cron Trigger "17 * * * *" (wrangler.toml [triggers]): bounded prune of expired OAuth flows and
  // dead sessions (H-04 step 3, L-15). A failed run is not retried; the next hourly run resumes.
  async scheduled(controller: ScheduledController, env: AppEnv, _ctx?: ExecutionContext): Promise<void> {
    try {
      const result = await runMaintenance(env.DB, controller.scheduledTime)
      console.log(JSON.stringify({ event: 'maintenance', cron: controller.cron, ...result }))
    } catch (error) {
      controller.noRetry?.()
      throw error
    }
    // The unattended discovery cycle shares this hourly trigger but paces itself to its own
    // interval, so it runs at most once a week. It is opt-in per environment and returns a
    // `skipped` result when disabled, so this is a no-op unless an operator turned it on.
    // Deliberately after maintenance and in its own try: a discovery failure must never mask
    // or prevent the prune above, and it is never retried either.
    try {
      const cycle = await runDiscoveryAutomationCycle(env, {
        now: Date.now,
      })
      if (cycle.outcome !== 'skipped')
        console.log(JSON.stringify({
          event: 'catalogue-discovery-automation',
          cron: controller.cron,
          cycleId: cycle.cycleId,
          outcome: cycle.outcome,
          publishedRevision: cycle.publishedRevision,
          phases: cycle.phases.map((p) => ({ phase: p.phase, processed: p.processed, failed: p.failed, outcome: p.outcome })),
        }))
    } catch (error) {
      console.log(JSON.stringify({
        event: 'catalogue-discovery-automation',
        cron: controller.cron,
        outcome: 'failed',
        reason: error instanceof Error ? error.message : 'unknown_error',
      }))
    }
  },
}
