// Shared rate limiter port (design "Shared Infrastructure", decision D2).
//
// Backends:
// - `bindingRateLimiter`: the Cloudflare Workers Rate Limiting binding (`[[ratelimits]]`). It is
//   approximate and per Cloudflare location, and its period can only be 10 or 60 seconds.
// - `InMemoryRateLimiter`: a fixed-window limiter. Used as the module-scope (per-isolate) fallback
//   when the binding is absent or fails, and as the deterministic test double.
//
// Keys passed to `limit()` are already hashed (`rateLimitKey`); raw client addresses are never
// stored as keys or logged.

export interface RateLimitResult {
  success: boolean
  /** Seconds until the caller may retry. Set when `success` is false. */
  retryAfter?: number
}

export interface RateLimiter {
  limit(key: string): Promise<RateLimitResult>
}

/** The shape of a Workers Rate Limiting binding (`env.<NAME>.limit({ key })`). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

interface Window {
  count: number
  resetAt: number
}

export interface InMemoryRateLimiterOptions {
  limit: number
  periodMs: number
  now?: () => number
  /** Upper bound on tracked keys so a key flood cannot grow isolate memory without limit. */
  maxKeys?: number
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>()
  private readonly limitPerWindow: number
  private readonly periodMs: number
  private readonly now: () => number
  private readonly maxKeys: number

  constructor({ limit, periodMs, now = Date.now, maxKeys = 10_000 }: InMemoryRateLimiterOptions) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid_rate_limit')
    if (!Number.isFinite(periodMs) || periodMs < 1) throw new Error('invalid_rate_limit_period')
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error('invalid_rate_limit_capacity')
    this.limitPerWindow = limit
    this.periodMs = periodMs
    this.now = now
    this.maxKeys = maxKeys
  }

  async limit(key: string): Promise<RateLimitResult> {
    const now = this.now()
    let window = this.windows.get(key)
    if (!window || window.resetAt <= now) {
      if (window) this.windows.delete(key)
      this.makeRoom(now)
      window = { count: 0, resetAt: now + this.periodMs }
      this.windows.set(key, window)
    }
    if (window.count >= this.limitPerWindow) {
      return { success: false, retryAfter: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) }
    }
    window.count++
    return { success: true }
  }

  private makeRoom(now: number) {
    if (this.windows.size < this.maxKeys) return
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key)
    // Still full: evict the oldest windows (Map iteration follows insertion order).
    for (const key of this.windows.keys()) {
      if (this.windows.size < this.maxKeys) break
      this.windows.delete(key)
    }
  }
}

/**
 * Wraps a Rate Limiting binding. A binding failure fails open to `fallback`, so a limiter outage
 * never blocks the caller outright but the isolate still bounds it.
 */
export const bindingRateLimiter = (
  binding: RateLimitBinding,
  periodSeconds: number,
  fallback: RateLimiter,
): RateLimiter => ({
  async limit(key) {
    let success: boolean
    try {
      success = (await binding.limit({ key })).success === true
    } catch {
      return fallback.limit(key)
    }
    return success ? { success: true } : { success: false, retryAfter: periodSeconds }
  },
})

/** The binding when it is configured, otherwise the module-scope fallback. */
export const selectRateLimiter = (
  binding: RateLimitBinding | undefined,
  periodSeconds: number,
  fallback: RateLimiter,
): RateLimiter => binding && typeof binding.limit === 'function'
  ? bindingRateLimiter(binding, periodSeconds, fallback)
  : fallback

const encoder = new TextEncoder()

/** `<route>:<sha-256 hex>` over a fixed per-route prefix and the client identifier. */
export const rateLimitKey = async (route: string, clientId: string, cryptoApi: Crypto = crypto): Promise<string> => {
  const digest = await cryptoApi.subtle.digest('SHA-256', encoder.encode(`hoyomix-rate-limit:v1:${route}:${clientId}`))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return `${route}:${hex}`
}

/** The Cloudflare-supplied client address; requests without one share a single bucket. */
export const clientAddress = (request: Request): string =>
  request.headers.get('cf-connecting-ip')?.trim() || 'unknown'

export const rateLimitedResponse = (retryAfter: number | undefined, fallbackSeconds: number) =>
  Response.json({ error: 'rate_limited' }, {
    status: 429,
    headers: {
      'cache-control': 'no-store',
      'retry-after': String(Math.max(1, Math.ceil(retryAfter ?? fallbackSeconds))),
    },
  })
