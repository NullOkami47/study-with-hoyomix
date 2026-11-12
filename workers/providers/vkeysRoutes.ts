import { createVkeysMediaFetch } from './vkeysMediaFetch'
import identities from './publicVkeysIdentities.json' with { type: 'json' }
import type { ProviderEnv } from './config'
import { readProviderStates } from './config'
import { readBoundedJsonRequest } from './boundedJson'
import { createTransientMedia } from './transientMedia'
import { resolveVkeysMetadata, validateVkeysMediaUrl, type VkeysIdentity } from './vkeys'
import { InMemoryRateLimiter, clientAddress, rateLimitKey, rateLimitedResponse, type RateLimiter } from '../rateLimit'

const TRACK_ID = /^[a-z0-9][a-z0-9-]{0,127}$/
const defaultIdentityById = new Map<string, VkeysIdentity>((identities as VkeysIdentity[]).map(row => [row.trackId, row]))
const clientLimiter = new InMemoryRateLimiter({ limit: 12, periodMs: 60_000, maxKeys: 512 })
const upstreamLimiter = new InMemoryRateLimiter({ limit: 10, periodMs: 60_000, maxKeys: 1 })
interface Dependencies {
  /** Trusted operator/test input; never read from the request body. */
  identities?: readonly VkeysIdentity[]
  fetch?: typeof fetch
  crypto?: Crypto
  now?: () => number
  cache?: Pick<Cache, 'match' | 'put'>
  limiter?: RateLimiter
  globalLimiter?: RateLimiter
}
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

/** Original, catalogue-bound adapter. No credentials or upstream URLs reach the browser. */
export function createVkeysHandler(env: ProviderEnv, dependencies: Dependencies = {}) {
  const identityById = dependencies.identities
    ? new Map(dependencies.identities.map(row => [row.trackId, row]))
    : defaultIdentityById
  const fetchImpl = dependencies.fetch ?? globalThis.fetch.bind(globalThis)
  const cryptoApi = dependencies.crypto ?? globalThis.crypto
  const now = dependencies.now ?? Date.now
  const cache = dependencies.cache ?? (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default
  const enabled = async () => {
    if (env.VKEYS_ENABLED !== 'true') return false
    try { return (await readProviderStates(env.DB, env)).some(row => row.id === 'vkeys' && row.effectiveEnabled) } catch { return false }
  }
  return { async fetch(request: Request): Promise<Response> {
    let origin: URL
    try { origin = new URL(env.PUBLIC_ORIGIN) } catch { return json({ error: 'unavailable' }, 503) }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return json({ error: 'unavailable' }, 503)
    const url = new URL(request.url)
    const media = createTransientMedia({
      providerId: 'vkeys', publicOrigin: origin.origin, externalIdPattern: TRACK_ID,
      validateUrl: (value, current) => {
        if (typeof value !== 'string' || /[\\\s]/.test(value)) return null
        try { return validateVkeysMediaUrl(current ? new URL(value, current).href : value) } catch { return null }
      }, isEffective: enabled, allowFormEncodedAudio: true, includeExpiry: true,
    }, { cache, crypto: cryptoApi, fetch: createVkeysMediaFetch(fetchImpl), now })
    if (url.pathname.startsWith('/api/providers/vkeys/media/')) return media.serve(request, url)
    if (url.pathname !== '/api/providers/vkeys/resolve') return json({ error: 'not_found' }, 404)
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
    if (url.origin !== origin.origin || url.search || request.headers.get('origin') !== origin.origin) return json({ error: 'invalid_response' }, 400)
    if (!await enabled()) return json({ error: 'unavailable' }, 503)
    let body: unknown
    try { body = await readBoundedJsonRequest(request, 1024) } catch { return json({ error: 'invalid_response' }, 400) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('externalId' in body) || typeof body.externalId !== 'string' || !TRACK_ID.test(body.externalId)) return json({ error: 'invalid_response' }, 400)
    const identity = identityById.get(body.externalId)
    if (!identity) return json({ error: 'not_found' }, 404)
    for (const [limiter, key] of [
      [dependencies.limiter ?? clientLimiter, await rateLimitKey('vkeys', clientAddress(request), cryptoApi)],
      [dependencies.globalLimiter ?? upstreamLimiter, 'vkeys-upstream'],
    ] as const) {
      const decision = await limiter.limit(key)
      if (!decision.success) return rateLimitedResponse(decision.retryAfter, 60)
    }
    const result = await resolveVkeysMetadata({ identity, fetch: fetchImpl, signal: request.signal, now })
    if (!result.ok) return json({ error: result.error }, result.error === 'rate_limited' ? 429 : result.error === 'timeout' ? 504 : 502)
    const ticket = await media.prepare({ externalId: identity.trackId, validatedUrl: result.mediaUrl, mimeType: result.mimeType, ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }) })
    return ticket ? json(ticket) : json({ error: 'unavailable' }, 503)
  } }
}
