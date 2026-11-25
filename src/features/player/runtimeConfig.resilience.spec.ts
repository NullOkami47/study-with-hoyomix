import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeProviderRepository } from './runtimeConfig'

const url = new URL('/api/providers/config', window.location.origin).href
const row = (id = 'gd-studio') => ({ id, available: true, enabled: true, automaticEligible: true, priority: 10 })
const response = (providers: unknown[] = [row()], status = 200) => {
  const value = new Response(JSON.stringify({ version: 1, providers }), { status, headers: { 'content-type': 'application/json' } })
  Object.defineProperty(value, 'url', { value: url })
  return value
}
const ids = (registry: Awaited<ReturnType<ReturnType<typeof createRuntimeProviderRepository>['load']>>) =>
  registry.selectable().map(({ provider }) => provider.id)
const preferences = () => ({ isDisabled: () => false, revision: () => 0 })

afterEach(() => vi.useRealTimers())

describe('provider configuration during background network failures', () => {
  it('keeps the last validated providers after a transient TTL refresh and preserves preparation identity', async () => {
    let now = 0
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => now, providerPreferences: preferences() })
    const valid = await repository.load()
    now = 60_000
    expect(await repository.load()).toBe(valid)
    expect(ids(await repository.load())).toEqual(['gd-studio'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    // Stale playback eligibility must not be advertised as freshly verified administrative state.
    expect(await repository.states()).toEqual([])
    expect(repository.peek()).toBeUndefined()
  })

  it('uses safe cached configuration during forced media renewal without caching an empty registry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => 0, providerPreferences: preferences() })
    const valid = await repository.load()
    const renewed = await repository.load({ forceRefresh: true })
    expect(ids(renewed)).toEqual(['gd-studio'])
    expect(renewed).not.toBe(valid)
    expect(await repository.load()).toBe(renewed)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('bounds stale age from the last successful validation, never from the latest failed fetch', async () => {
    let now = 0
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(new TypeError('offline'))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => now, providerPreferences: preferences() })
    await repository.load()
    now = 119_999
    expect(ids(await repository.load())).toEqual(['gd-studio'])
    now = 120_000
    await expect(repository.load()).rejects.toMatchObject({ name: 'ProviderConfigurationUnavailableError' })
    expect(repository.peek()).toBeUndefined()
  })

  it('honours a clock rollback instead of extending stale permission indefinitely', async () => {
    let now = 1000
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(new TypeError('offline'))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => now, providerPreferences: preferences() })
    await repository.load()
    now = 0
    await expect(repository.load({ forceRefresh: true })).rejects.toMatchObject({ name: 'ProviderConfigurationUnavailableError' })
  })

  it('applies a local disable while a coalesced forced refresh is pending', async () => {
    let finish!: (reason: unknown) => void
    let disabled = false
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise<Response>((_, reject) => { finish = reject }))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => 0, providerPreferences: {
      isDisabled: () => disabled, revision: () => disabled ? 1 : 0,
    } })
    await repository.load()
    const first = repository.load({ forceRefresh: true })
    disabled = true
    const second = repository.load()
    finish(new TypeError('offline'))
    expect(ids(await first)).toEqual([])
    expect(await second).toBe(await first)
    expect(repository.peek()).toBeUndefined()
  })

  it('does not retain a removed local credential on stale fallback', async () => {
    let key: string | null = 'chksz_test_key'
    const fetcher = vi.fn().mockResolvedValueOnce(response([row(), {
      ...row('chksz'), userKeySupported: true, ownerFallbackAvailable: false,
    }])).mockRejectedValue(new TypeError('offline'))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => 0, providerPreferences: preferences(),
      chkszCredentials: { key: () => key, revision: () => key ? 0 : 1 },
    })
    expect(ids(await repository.load())).toContain('chksz')
    key = null
    expect(ids(await repository.load({ forceRefresh: true }))).toEqual(['gd-studio'])
  })

  it('backs off repeated failed refreshes, then accepts an authoritative empty response', async () => {
    let now = 0
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(response([]))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => now, providerPreferences: preferences() })
    await repository.load()
    expect(ids(await repository.load({ forceRefresh: true }))).toEqual(['gd-studio'])
    for (let i = 0; i < 10; i++) expect(ids(await repository.load({ forceRefresh: true }))).toEqual(['gd-studio'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    now = 1000
    expect(ids(await repository.load({ forceRefresh: true }))).toEqual([])
    fetcher.mockRejectedValue(new TypeError('offline'))
    now = 7000
    expect(ids(await repository.load())).toEqual([])
    expect(await repository.states()).toEqual([])
  })

  it.each([401, 403, 404])('does not reuse revoked permission after HTTP %s, even on a later network error', async (status) => {
    let now = 0
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response([], status)).mockRejectedValue(new TypeError('offline'))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => now, providerPreferences: preferences() })
    await repository.load()
    expect(ids(await repository.load({ forceRefresh: true }))).toEqual([])
    now = 6000
    await expect(repository.load()).rejects.toMatchObject({ name: 'ProviderConfigurationUnavailableError' })
  })

  it.each([408, 429, 500, 502, 503, 504])('retains validated playback configuration after a transient HTTP %s', async (status) => {
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response([], status))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => 0, providerPreferences: preferences() })
    await repository.load()
    expect(ids(await repository.load({ forceRefresh: true }))).toEqual(['gd-studio'])
  })

  it('fails closed for malformed successful data rather than classifying it as an outage', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response([{ ...row(), enabled: 'yes' }]))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => 0, providerPreferences: preferences() })
    await repository.load()
    expect(ids(await repository.load({ forceRefresh: true }))).toEqual([])
    expect(await repository.states()).toEqual([])
  })

  it('observes and invalidates redirects instead of mistaking native redirect rejection for a network outage', async () => {
    let now = 0
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response()).mockImplementationOnce(async (_input, init) => {
      // Native fetch with redirect:error throws the same TypeError as a dropped connection.
      if (init?.redirect === 'error') throw new TypeError('fetch failed')
      return response([], 302)
    }).mockRejectedValue(new TypeError('offline'))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, now: () => now, providerPreferences: preferences() })
    await repository.load()
    expect(ids(await repository.load({ forceRefresh: true }))).toEqual([])
    now = 6000
    await expect(repository.load()).rejects.toMatchObject({ name: 'ProviderConfigurationUnavailableError' })
  })

  it('signals temporary configuration unavailability distinctly when there is no validated snapshot', async () => {
    const repository = createRuntimeProviderRepository({ fetch: vi.fn().mockRejectedValue(new TypeError('offline')) })
    await expect(repository.load()).rejects.toMatchObject({ name: 'ProviderConfigurationUnavailableError' })
    await expect(repository.prefetch()).resolves.toBeUndefined()
    await expect(repository.states()).resolves.toEqual([])
  })

  it('bounds a hung config fetch and ignores its late successful response', async () => {
    vi.useFakeTimers()
    let finish!: (value: Response) => void
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve }))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, providerPreferences: preferences() })
    await repository.load()
    const pending = repository.load({ forceRefresh: true })
    let settled = false
    void pending.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(4000)
    expect(settled).toBe(true)
    expect(ids(await pending)).toEqual(['gd-studio'])
    finish(response([]))
    await Promise.resolve()
    expect(ids(await repository.load())).toEqual(['gd-studio'])
    expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
