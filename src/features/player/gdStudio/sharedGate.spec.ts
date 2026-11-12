// The GD Studio budget is shared, and this is the test that says so.
//
// Two paths can reach `music-api.gdstudio.xyz`: our own resolver (`resolveGdStudioUrl`) and an LX
// source script running inside the QuickJS worker, which reports the request through the worker's
// `gateRequest` before it touches the network. GD Studio publishes a limit of 50 requests per 5
// minutes and we budget 40; that number only means anything if both paths draw on the *same*
// window. If each kept its own counter the effective limit would be 80, and the limit is the reason
// this provider is browser-direct instead of a Worker relay in the first place.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GD_STUDIO_API_ORIGIN,
  GD_STUDIO_DEFAULT_BUDGET,
  GD_STUDIO_WINDOW_MS,
  GdStudioBudget,
  getSharedGdStudioBudget,
  resetSharedGdStudioBudget,
} from './budget'
import { resetGdStudioInFlight, resolveGdStudioUrl } from './browserClient'

const NOW = 1_700_000_000_000

/** Exactly what `workers/lx/runtime/worker.ts` does before an LX script's request goes out. */
const lxGate = (url: URL, budget: GdStudioBudget, at: number) =>
  `${url.protocol}//${url.host}` === GD_STUDIO_API_ORIGIN ? budget.tryAcquire(at) : null

const okResponse = () =>
  new Response(JSON.stringify({ url: 'https://m801.music.126.net/a.mp3', br: 320 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('GD Studio shared budget', () => {
  beforeEach(() => {
    resetSharedGdStudioBudget()
    resetGdStudioInFlight()
  })

  afterEach(() => {
    resetSharedGdStudioBudget()
    resetGdStudioInFlight()
    vi.useRealTimers()
  })

  it('defaults to 40 requests per rolling 5 minutes', () => {
    expect(GD_STUDIO_DEFAULT_BUDGET).toBe(40)
    expect(GD_STUDIO_WINDOW_MS).toBe(5 * 60 * 1000)
    const budget = new GdStudioBudget({ channelName: null })
    expect(budget.remaining(NOW)).toBe(40)
  })

  it('counts an LX script request against the same window the direct client uses', async () => {
    const budget = getSharedGdStudioBudget()
    const target = new URL(`${GD_STUDIO_API_ORIGIN}/api.php?types=url`)

    // 39 requests from "LX scripts" — the gate the worker installs.
    for (let index = 0; index < 39; index++) {
      expect(lxGate(target, budget, NOW)?.ok).toBe(true)
    }
    expect(budget.remaining(NOW)).toBe(1)

    // The 40th is spent by our own resolver, and it must be the last one.
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch
    const first = await resolveGdStudioUrl({ id: '9000000001', budget, fetch: fetchImpl, now: () => NOW })
    expect(first.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Now the window is full: the next LX request is refused *before* it is sent.
    expect(lxGate(target, budget, NOW)?.ok).toBe(false)

    const second = await resolveGdStudioUrl({ id: '9000000002', budget, fetch: fetchImpl, now: () => NOW })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.failure).toBe('budget_exhausted')
    // Refused without a request: a refused call costs nothing because it was never sent.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not gate an origin that is not GD Studio', () => {
    const budget = getSharedGdStudioBudget()
    expect(lxGate(new URL('https://yy.zddyr.top/api'), budget, NOW)).toBeNull()
    expect(budget.remaining(NOW)).toBe(40)
  })

  it('reports a 429 as rate_limited and backs off instead of retrying', async () => {
    const budget = getSharedGdStudioBudget()
    const fetchImpl = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })) as unknown as typeof fetch

    const first = await resolveGdStudioUrl({ id: '1', budget, fetch: fetchImpl, now: () => NOW })
    expect(first.ok).toBe(false)
    if (!first.ok) {
      expect(first.failure).toBe('rate_limited')
      expect(first.retryAfterMs).toBe(30_000)
    }

    // The next attempt is refused locally, without another request.
    const second = await resolveGdStudioUrl({ id: '2', budget, fetch: fetchImpl, now: () => NOW + 1_000 })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.failure).toBe('backing_off')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // ...and the back-off expires on its own.
    expect(budget.tryAcquire(NOW + 31_000).ok).toBe(true)
  })

  it('clamps a hostile Retry-After so it cannot silence the player for an hour', async () => {
    const budget = getSharedGdStudioBudget()
    const fetchImpl = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '999999' } })) as unknown as typeof fetch
    await resolveGdStudioUrl({ id: '1', budget, fetch: fetchImpl, now: () => NOW })
    expect(budget.tryAcquire(NOW + 9 * 60 * 1000).ok).toBe(false)
    expect(budget.tryAcquire(NOW + 11 * 60 * 1000).ok).toBe(true)
  })

  it('converges with another tab over the broadcast channel', () => {
    const budget = new GdStudioBudget({ channelName: null })
    // What another tab posts when it spends a request.
    budget.observeRemote({ kind: 'request', at: NOW })
    budget.observeRemote({ kind: 'request', at: NOW + 1 })
    expect(budget.remaining(NOW + 2)).toBe(38)

    budget.observeRemote({ kind: 'backoff', until: NOW + 5_000 })
    expect(budget.tryAcquire(NOW + 3)?.reason).toBe('backing_off')
    expect(budget.tryAcquire(NOW + 6_000).ok).toBe(true)
  })

  it('ignores a malformed message rather than corrupting the window', () => {
    const budget = new GdStudioBudget({ channelName: null })
    budget.observeRemote(null)
    budget.observeRemote({ kind: 'request', at: 'soon' })
    budget.observeRemote({ kind: 'backoff', until: Number.NaN })
    expect(budget.remaining(NOW)).toBe(40)
  })

  it('guards exactly one origin', () => {
    expect(GdStudioBudget.guards(new URL(`${GD_STUDIO_API_ORIGIN}/api.php`))).toBe(true)
    expect(GdStudioBudget.guards(new URL('https://music-api.gdstudio.xyz.evil.test/api.php'))).toBe(false)
    expect(GdStudioBudget.guards(new URL('http://music-api.gdstudio.xyz/api.php'))).toBe(false)
  })
})
