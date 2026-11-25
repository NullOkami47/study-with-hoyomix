import type { D1Database, ExecutionContext } from '../env'
import { readCatalogueRevision, readCatalogueSnapshot, serialiseCatalogue } from './repository'

// H-03 (design D3 = Cache API + memo): the public catalogue changes only with a revision bump, so a
// serialised body is kept per origin and revision instead of re-running the six-query projection.
const PUBLIC_CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=60'
const CACHE_KEY_PREFIX = 'https://catalogue.internal/v2/'

interface CachedCatalogue {
  scope: string
  revision: string
  body: string
  etag: string
}

// Only the latest scope/revision is kept: one catalogue copy (a few MB) per isolate.
let memo: CachedCatalogue | null = null
// Track only in-flight scope/revision reads; settled promises must not retain extra catalogue copies.
const pending = new Map<string, Promise<CachedCatalogue>>()

function cacheKey(scope: string, revision: string): string {
  return CACHE_KEY_PREFIX + encodeURIComponent(scope) + '/' + revision
}

/** `caches.default` when the runtime has the Cache API (Workers); absent in Node tests. */
function edgeCache(): Cache | null {
  const storage = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches
  return storage?.default ?? null
}

async function strongEtag(revision: string, body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))
  const prefix = Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `"rev-${revision}-${prefix}"`
}

/** If-None-Match uses the weak comparison (RFC 9110 13.1.2): `W/` is ignored, `*` matches. */
function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false
  return header.split(',').some((candidate) => {
    const value = candidate.trim()
    return value === '*' || value.replace(/^W\//u, '') === etag
  })
}

async function fromEdgeCache(cache: Cache | null, scope: string, revision: string): Promise<CachedCatalogue | null> {
  if (!cache) return null
  try {
    const hit = await cache.match(cacheKey(scope, revision))
    const etag = hit?.headers.get('etag')
    if (!hit || !hit.ok || !etag) return null
    return { scope, revision, body: await hit.text(), etag }
  } catch {
    return null
  }
}

async function loadRevision(
  db: D1Database,
  scope: string,
  revision: string,
  ctx: ExecutionContext | undefined,
): Promise<CachedCatalogue> {
  const cache = edgeCache()
  const cached = await fromEdgeCache(cache, scope, revision)
  if (cached) return cached
  // Throws on any D1 failure or the 10 MiB bound; a failure is never stored anywhere.
  const serialised = serialiseCatalogue(await readCatalogueSnapshot(db))
  const entry = { ...serialised, scope, etag: await strongEtag(serialised.revision, serialised.body) }
  if (cache) {
    const put = cache
      .put(
        cacheKey(scope, entry.revision),
        new Response(entry.body, {
          headers: {
            'content-type': 'application/json',
            etag: entry.etag,
            // Origin separates catalogues whose independent databases share a revision.
            'cache-control': 'public, max-age=86400',
          },
        }),
      )
      .catch(() => undefined)
    if (ctx) ctx.waitUntil(put)
    else await put
  }
  return entry
}

async function catalogueForRevision(
  db: D1Database,
  scope: string,
  revision: string,
  ctx: ExecutionContext | undefined,
): Promise<CachedCatalogue> {
  if (memo?.scope === scope && memo.revision === revision) return memo
  const key = cacheKey(scope, revision)
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const promise = loadRevision(db, scope, revision, ctx)
  pending.set(key, promise)
  try {
    const entry = await promise
    // The batch may have observed a newer revision than the one-row read; keep whichever is served.
    if (!memo || memo.scope !== scope || Number(entry.revision) >= Number(memo.revision)) memo = entry
    return entry
  } finally {
    if (pending.get(key) === promise) pending.delete(key)
  }
}

export async function cataloguePublicResponse(
  request: Request,
  db: D1Database,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'GET')
    return Response.json(
      { error: 'method_not_allowed' },
      { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } },
    )
  try {
    const revision = String(await readCatalogueRevision(db))
    const entry = await catalogueForRevision(db, new URL(request.url).origin, revision, ctx)
    const headers = { etag: entry.etag, 'cache-control': PUBLIC_CACHE_CONTROL }
    if (matchesIfNoneMatch(request.headers.get('if-none-match'), entry.etag))
      return new Response(null, { status: 304, headers })
    return new Response(entry.body, {
      headers: { 'content-type': 'application/json', ...headers },
    })
  } catch {
    return Response.json(
      { error: 'catalogue_unavailable' },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    )
  }
}
