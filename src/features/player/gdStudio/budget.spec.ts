import { describe, expect, it } from 'vitest'

import {
  GD_STUDIO_API_ORIGIN,
  GD_STUDIO_DEFAULT_BUDGET,
  GD_STUDIO_WINDOW_MS,
  GdStudioBudget,
} from './budget'

describe('the shared GD Studio budget', () => {
  it('admits requests up to the configured limit and then refuses them', () => {
    const budget = new GdStudioBudget({ channelName: null, limit: 3, now: () => 1_000 })
    expect(budget.tryAcquire(1_000).ok).toBe(true)
    expect(budget.tryAcquire(1_001).ok).toBe(true)
    expect(budget.tryAcquire(1_002).ok).toBe(true)

    const refused = budget.tryAcquire(1_003)
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('budget_exhausted')
    // The window frees up when the oldest request leaves it.
    expect(refused.retryAfterMs).toBe(1_000 + GD_STUDIO_WINDOW_MS - 1_003)
  })

  it('uses a rolling window, not a fixed one', () => {
    const budget = new GdStudioBudget({ channelName: null, limit: 2, windowMs: 1_000, now: () => 0 })
    expect(budget.tryAcquire(0).ok).toBe(true)
    expect(budget.tryAcquire(100).ok).toBe(true)
    expect(budget.tryAcquire(500).ok).toBe(false)
    // The first request has left the window, so a slot has opened up.
    expect(budget.tryAcquire(1_001).ok).toBe(true)
  })

  it('counts a refused request as free and an admitted one as spent', () => {
    const budget = new GdStudioBudget({ channelName: null, limit: 2, windowMs: 60_000, now: () => 0 })
    budget.tryAcquire(0)
    budget.tryAcquire(1)
    expect(budget.tryAcquire(2).ok).toBe(false)
    expect(budget.remaining(2)).toBe(0)
  })

  it('backs off when a 429 says so, and recovers afterwards', () => {
    let clock = 5_000
    const budget = new GdStudioBudget({ channelName: null, now: () => clock })
    budget.noteRateLimited(10_000, clock)

    const refused = budget.tryAcquire(6_000)
    expect(refused.ok).toBe(false)
    expect(refused.reason).toBe('backing_off')
    expect(refused.retryAfterMs).toBe(9_000)

    clock = 16_000
    expect(budget.tryAcquire(clock).ok).toBe(true)
  })

  it('clamps a hostile Retry-After so it cannot silence the player for an hour', () => {
    let clock = 0
    const budget = new GdStudioBudget({ channelName: null, now: () => clock })
    budget.noteRateLimited(60 * 60 * 1000, clock)
    clock += 10 * 60 * 1000 + 1
    expect(budget.tryAcquire(clock).ok).toBe(true)
  })

  it('shares its window with another instance through the channel', () => {
    const listeners: Array<(message: unknown) => void> = []
    const channel = {
      postMessage: (message: unknown) => {
        for (const listener of listeners) listener({ data: message } as MessageEvent)
      },
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        listeners.push(listener as (event: unknown) => void)
      },
      close: () => undefined,
    } as unknown as BroadcastChannel

    // Two instances that share one channel, as a page and its worker would.
    const page = new GdStudioBudget({ limit: 2, windowMs: 60_000, now: () => 0, channelName: 'test', createChannel: () => channel })
    const worker = new GdStudioBudget({ limit: 2, windowMs: 60_000, now: () => 0, channelName: 'test', createChannel: () => channel })

    expect(page.tryAcquire(0).ok).toBe(true)
    // The page's request is visible to the worker, so the worker sees one slot left.
    expect(worker.remaining(0)).toBe(1)
    expect(worker.tryAcquire(1).ok).toBe(true)
    // Both instances now agree the window is full.
    expect(page.tryAcquire(2).ok).toBe(false)
    expect(worker.tryAcquire(3).ok).toBe(false)
  })

  it('keeps working when the channel is unavailable', () => {
    const budget = new GdStudioBudget({ limit: 1, windowMs: 60_000, now: () => 0, channelName: null })
    expect(budget.tryAcquire(0).ok).toBe(true)
    expect(budget.tryAcquire(1).ok).toBe(false)
  })

  it('survives a page reload through its persisted window', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage

    const first = new GdStudioBudget({ limit: 2, windowMs: 60_000, now: () => 0, channelName: null, storage })
    first.tryAcquire(0)
    first.tryAcquire(10)

    const reloaded = new GdStudioBudget({ limit: 2, windowMs: 60_000, now: () => 20, channelName: null, storage })
    expect(reloaded.remaining(20)).toBe(0)
  })

  it('ignores a corrupt persisted window instead of failing', () => {
    const storage = {
      getItem: () => '{not json',
      setItem: () => undefined,
    } as unknown as Storage
    const budget = new GdStudioBudget({ limit: 2, windowMs: 60_000, now: () => 0, channelName: null, storage })
    expect(budget.remaining(0)).toBe(2)
  })

  it('guards only the GD Studio origin', () => {
    expect(GdStudioBudget.guards(new URL(`${GD_STUDIO_API_ORIGIN}/api.php`))).toBe(true)
    expect(GdStudioBudget.guards(new URL('https://music-api.gdstudio.xyz.evil.example/api.php'))).toBe(false)
    expect(GdStudioBudget.guards(new URL('https://api.chksz.com/api/163_music'))).toBe(false)
  })

  it('leaves headroom under the published 50-request limit', () => {
    expect(GD_STUDIO_DEFAULT_BUDGET).toBeLessThan(50)
    expect(GD_STUDIO_DEFAULT_BUDGET).toBe(40)
  })
})
