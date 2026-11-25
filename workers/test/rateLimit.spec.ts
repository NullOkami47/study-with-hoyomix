// Wave E shared limiter port (design "Shared Infrastructure" step 1, decision D2) and the OAuth
// start limit through worker.fetch (design Properties 3 and 8).
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import worker from '../index'
import {
  bindingRateLimiter,
  clientAddress,
  InMemoryRateLimiter,
  rateLimitKey,
  selectRateLimiter,
  type RateLimitBinding,
} from '../rateLimit'

const ORIGIN = 'https://study.example'

describe('InMemoryRateLimiter', () => {
  it('accepts the budget, then refuses with a Retry-After until the window resets', async () => {
    let now = 1_000_000
    const limiter = new InMemoryRateLimiter({ limit: 2, periodMs: 10_000, now: () => now })
    expect(await limiter.limit('k')).toEqual({ success: true })
    expect(await limiter.limit('k')).toEqual({ success: true })
    expect(await limiter.limit('k')).toEqual({ success: false, retryAfter: 10 })
    now += 4_500
    expect(await limiter.limit('k')).toEqual({ success: false, retryAfter: 6 })
    expect(await limiter.limit('other')).toEqual({ success: true })
    now += 5_500
    expect(await limiter.limit('k')).toEqual({ success: true })
  })

  it('bounds the number of tracked keys', async () => {
    const limiter = new InMemoryRateLimiter({ limit: 1, periodMs: 60_000, now: () => 0, maxKeys: 3 })
    for (const key of ['a', 'b', 'c', 'd']) expect((await limiter.limit(key)).success).toBe(true)
    // 'a' was evicted to make room for 'd', so it starts a fresh window; 'd' is still limited.
    expect((await limiter.limit('a')).success).toBe(true)
    expect((await limiter.limit('d')).success).toBe(false)
  })

  it('rejects an invalid configuration', () => {
    expect(() => new InMemoryRateLimiter({ limit: 0, periodMs: 1 })).toThrow('invalid_rate_limit')
    expect(() => new InMemoryRateLimiter({ limit: 1, periodMs: 0 })).toThrow('invalid_rate_limit_period')
  })

  // Property 8 (limiter core): for any interleaving of keys and clock steps, the accepted requests
  // per key per window never exceed the limit, and every refusal carries a positive Retry-After
  // that does not outlast the window.
  it('never accepts more than the limit per key per window', async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 1_000, max: 60_000 }),
      fc.array(fc.record({ key: fc.constantFrom('a', 'b', 'c'), step: fc.integer({ min: 0, max: 20_000 }) }), { maxLength: 120 }),
      async (limit, periodMs, events) => {
        let now = 0
        const limiter = new InMemoryRateLimiter({ limit, periodMs, now: () => now })
        const windows = new Map<string, { start: number; accepted: number }>()
        for (const { key, step } of events) {
          now += step
          const result = await limiter.limit(key)
          let window = windows.get(key)
          if (!window || now >= window.start + periodMs) {
            window = { start: now, accepted: 0 }
            windows.set(key, window)
          }
          if (result.success) {
            window.accepted++
            expect(window.accepted).toBeLessThanOrEqual(limit)
          } else {
            expect(window.accepted).toBe(limit)
            expect(result.retryAfter).toBeGreaterThan(0)
            expect(result.retryAfter! * 1000).toBeLessThanOrEqual(window.start + periodMs - now + 999)
          }
        }
      },
    ), { numRuns: 100 })
  })
})

describe('binding backend', () => {
  it('maps the binding decision and fails open to the fallback when the binding throws', async () => {
    const decisions = [true, false]
    const keys: string[] = []
    const binding: RateLimitBinding = { limit: async ({ key }) => { keys.push(key); return { success: decisions.shift()! } } }
    const fallback = new InMemoryRateLimiter({ limit: 1, periodMs: 60_000, now: () => 0 })
    const limiter = bindingRateLimiter(binding, 60, fallback)
    expect(await limiter.limit('k')).toEqual({ success: true })
    expect(await limiter.limit('k')).toEqual({ success: false, retryAfter: 60 })
    expect(keys).toEqual(['k', 'k'])

    const failing = bindingRateLimiter({ limit: async () => { throw new Error('binding outage') } }, 60, fallback)
    expect(await failing.limit('k')).toEqual({ success: true })
    expect((await failing.limit('k')).success).toBe(false)
  })

  it('uses the fallback when no binding is configured', () => {
    const fallback = new InMemoryRateLimiter({ limit: 1, periodMs: 1 })
    expect(selectRateLimiter(undefined, 60, fallback)).toBe(fallback)
    expect(selectRateLimiter({ limit: async () => ({ success: true }) }, 60, fallback)).not.toBe(fallback)
  })
})

describe('keys', () => {
  it('hashes the client address with a per-route prefix and never contains it raw', async () => {
    const key = await rateLimitKey('auth-start', '203.0.113.7')
    expect(key).toMatch(/^auth-start:[0-9a-f]{64}$/)
    expect(key).not.toContain('203.0.113.7')
    expect(await rateLimitKey('auth-start', '203.0.113.7')).toBe(key)
    expect(await rateLimitKey('other-route', '203.0.113.7')).not.toBe(key.replace('auth-start', 'other-route'))
    expect(await rateLimitKey('auth-start', '203.0.113.8')).not.toBe(key)
  })

  it('reads the Cloudflare client address and shares one bucket when it is absent', () => {
    expect(clientAddress(new Request(ORIGIN, { headers: { 'cf-connecting-ip': ' 198.51.100.4 ' } }))).toBe('198.51.100.4')
    expect(clientAddress(new Request(ORIGIN))).toBe('unknown')
  })
})

// Properties 3 and 8 through the real entry point. The D1 binding throws on any use, so a passing
// run also proves that anonymous starts, limited or not, never touch D1.
describe('OAuth start through worker.fetch with a D1 binding that must not be used', () => {
  const unusableDatabase = new Proxy({}, { get: () => { throw new Error('D1 must not be used by OAuth start') } })
  const env = {
    DB: unusableDatabase,
    PUBLIC_ORIGIN: ORIGIN,
    SESSION_HMAC_SECRET: 'rate-limit-test-session-secret',
    OAUTH_STATE_SECRET: 'rate-limit-test-state-secret',
    GOOGLE_CLIENT_ID: 'test-google-client',
    GOOGLE_CLIENT_SECRET: 'TEST-google-secret',
    GITHUB_CLIENT_ID: 'test-github-client',
    GITHUB_CLIENT_SECRET: 'TEST-github-secret',
  }
  const start = (provider: string, ip: string) => (worker.fetch as (...args: unknown[]) => Promise<Response>)(
    new Request(`${ORIGIN}/api/auth/${provider}/start`, { headers: { 'cf-connecting-ip': ip } }),
    env,
    { waitUntil: () => {}, passThroughOnException: () => {} },
  )

  it('accepts at most 20 starts per client address for any interleaving, and refuses the rest with 429', async () => {
    let run = 0
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ client: fc.integer({ min: 0, max: 2 }), provider: fc.constantFrom('github', 'google') }), { minLength: 1, maxLength: 70 }),
      async (requests) => {
        // Fresh addresses per run: the module-scope limiter outlives a run, as it does in an isolate.
        const prefix = `198.18.${++run}`
        const sent = new Map<number, number>()
        for (const { client, provider } of requests) {
          const response = await start(provider, `${prefix}.${client}`)
          const index = (sent.get(client) ?? 0) + 1
          sent.set(client, index)
          if (index <= 20) {
            expect(response.status).toBe(302)
            expect(response.headers.get('set-cookie')).toContain('__Host-oauth=')
          } else {
            expect(response.status).toBe(429)
            expect(await response.json()).toEqual({ error: 'rate_limited' })
            expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
            expect(response.headers.get('set-cookie')).toBeNull()
          }
        }
      },
    ), { numRuns: 25 })
  })
})
