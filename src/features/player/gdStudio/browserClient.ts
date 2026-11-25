// Resolves a track's audio URL from GD Studio, from the listener's browser.
//
// Architecture: the browser talks to `music-api.gdstudio.xyz` directly and plays the CDN URL it
// returns. Our Cloudflare Worker distributes configuration and approved source snapshots, but it is
// **not** the GD Studio resolver: every request it relayed would count against one shared server
// quota and scale with traffic, which is exactly what the published 50-requests-per-5-minutes limit
// forbids.
//
// Everything here is bounded and honest about failure:
//   * the request is gated by the shared budget *before* it is sent, and the attempt is recorded
//     whether or not it succeeds;
//   * identical in-flight requests are shared, so a script's internal race cannot multiply the cost;
//   * a 429 sets a bounded back-off and is reported as `rate_limited`, never retried in a loop;
//   * a URL that the deployment's media policy would refuse is reported as such instead of being
//     handed to an element that would refuse it anyway.
//
// GD音乐台 (GD Studio) is credited as the upstream: it is a free public service of unknown
// ownership with no SLA, and it must not be presented to listeners as our own.

import { GD_STUDIO_API_ORIGIN, getSharedGdStudioBudget, GdStudioBudget } from './budget'
import { isLxTargetAllowed, type LxCspSources } from '../lx/cspAllowList'

export const GD_STUDIO_ALLOWED_SOURCES = ['netease'] as const
export type GdStudioSource = (typeof GD_STUDIO_ALLOWED_SOURCES)[number]

/** The bitrates GD Studio publishes. Kept to the ones our player actually uses. */
export const GD_STUDIO_ALLOWED_BITRATES = [128, 192, 320] as const

export type GdStudioResolveFailure =
  | 'budget_exhausted'
  | 'backing_off'
  | 'rate_limited'
  | 'csp_blocked'
  | 'invalid_response'
  | 'unavailable'

export interface GdStudioResolveOptions {
  /** The NetEase song id. Our catalogue already carries one for every track. */
  id: string
  source?: GdStudioSource
  /** Target bitrate. The API may return a lower one; that is reported back, not hidden. */
  br?: 128 | 192 | 320
  budget?: GdStudioBudget
  cspSources?: LxCspSources
  selfOrigin?: string
  fetch?: typeof fetch
  signal?: AbortSignal
  /** Test seam: the clock used for the budget and the in-flight map. */
  now?: () => number
}

export type GdStudioResolveResult =
  | { ok: true; url: string; bitrate: number | null; fromDedup: boolean }
  | { ok: false; failure: GdStudioResolveFailure; detail?: string; retryAfterMs?: number }

interface GdStudioUrlResponse {
  url?: unknown
  br?: unknown
}

/** In-flight requests, keyed by the exact request, so a race shares one response. */
const inFlight = new Map<string, Promise<GdStudioResolveResult>>()

const parseRetryAfter = (value: string | null, atMs: number): number => {
  if (!value) return 30_000
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - atMs)
  return 30_000
}

const isHttpsUrl = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && URL.canParse(value) && new URL(value).protocol === 'https:'

/**
 * Resolves one track. Concurrent calls for the same track and bitrate share a single request and
 * therefore a single unit of budget.
 */
export async function resolveGdStudioUrl(options: GdStudioResolveOptions): Promise<GdStudioResolveResult> {
  const source = options.source ?? 'netease'
  const br = options.br ?? 320
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  // The shared budget is the default: an unmanaged call path would silently bypass the limit.
  const budget = options.budget ?? getSharedGdStudioBudget()
  const cspSources = options.cspSources

  if (!GD_STUDIO_ALLOWED_SOURCES.includes(source)) {
    return { ok: false, failure: 'invalid_response', detail: `Unknown source ${source}` }
  }

  // The deployment's document policy decides whether this origin may be contacted at all. Refusing
  // here is what keeps the CSP authoritative: no amount of code below can widen it.
  let target: URL
  try {
    target = new URL(`${GD_STUDIO_API_ORIGIN}/api.php`)
  } catch {
    return { ok: false, failure: 'unavailable', detail: 'The GD Studio endpoint could not be built' }
  }
  if (cspSources && !isLxTargetAllowed('connect', target, cspSources, options.selfOrigin)) {
    return { ok: false, failure: 'csp_blocked', detail: `${GD_STUDIO_API_ORIGIN} is not permitted by this deployment` }
  }

  const key = `${source}:${options.id}:${br}`
  const existing = inFlight.get(key)
  if (existing) {
    const shared = await existing
    return shared.ok ? { ...shared, fromDedup: true } : shared
  }

  const request = performRequest({ ...options, source, br, now, fetch: fetchImpl, budget, target })
  inFlight.set(key, request)
  try {
    return await request
  } finally {
    inFlight.delete(key)
  }
}

async function performRequest(options: {
  id: string
  source: GdStudioSource
  br: number
  budget: GdStudioBudget | null
  cspSources?: LxCspSources
  selfOrigin?: string
  fetch: typeof fetch
  signal?: AbortSignal
  now: () => number
  target: URL
}): Promise<GdStudioResolveResult> {
  const { budget, now, fetch: fetchImpl, target } = options

  if (budget) {
    const acquisition = budget.tryAcquire(now())
    if (!acquisition.ok) {
      return {
        ok: false,
        failure: acquisition.reason ?? 'budget_exhausted',
        retryAfterMs: acquisition.retryAfterMs,
      }
    }
  }

  target.searchParams.set('types', 'url')
  target.searchParams.set('source', options.source)
  target.searchParams.set('id', options.id)
  target.searchParams.set('br', String(options.br))

  let response: Response
  try {
    response = await fetchImpl(target.toString(), {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: options.signal,
    })
  } catch (error: unknown) {
    return { ok: false, failure: 'unavailable', detail: error instanceof Error ? error.message : String(error) }
  }

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now())
    budget?.noteRateLimited(retryAfterMs, now())
    return { ok: false, failure: 'rate_limited', retryAfterMs }
  }

  if (!response.ok) {
    return { ok: false, failure: 'unavailable', detail: `HTTP ${response.status}` }
  }

  let body: GdStudioUrlResponse
  try {
    body = (await response.json()) as GdStudioUrlResponse
  } catch {
    return { ok: false, failure: 'invalid_response', detail: 'The response was not JSON' }
  }

  // A plaintext or non-HTTPS URL can never play on an HTTPS page; report it rather than hand it to
  // an element that will refuse it.
  if (!isHttpsUrl(body.url)) {
    return { ok: false, failure: 'invalid_response', detail: 'The response carried no usable HTTPS audio URL' }
  }

  const bitrate = typeof body.br === 'number' ? body.br : null
  return { ok: true, url: body.url, bitrate, fromDedup: false }
}

/** Test seam: forget every shared in-flight request. */
export function resetGdStudioInFlight(): void {
  inFlight.clear()
}
