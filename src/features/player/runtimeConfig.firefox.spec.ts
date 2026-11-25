import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeProviderRepository, type RuntimeProviderRepository } from './runtimeConfig'

const endpoint = new URL('/api/providers/config', window.location.origin).href
const gd = { id: 'gd-studio', available: true, enabled: true, automaticEligible: true, priority: 1 }
function response(providers: unknown[] = [gd], status = 200) {
  const value = Response.json({ version: 1, providers }, { status })
  Object.defineProperty(value, 'url', { value: endpoint })
  return value
}
const playback = (repository: RuntimeProviderRepository, options = {}) =>
  repository.loadPlayback(options)
const snapshot = (repository: RuntimeProviderRepository) =>
  repository.peekPlayback()
const ids = (registry: Awaited<ReturnType<RuntimeProviderRepository['load']>>) =>
  registry.selectable().map(({ provider }) => provider.id)

afterEach(() => vi.useRealTimers())

describe('Firefox prepared handover configuration lease', () => {
  it.each([[41_245, false], [32_059, true]] as const)(
    'uses an eligible playback snapshot during a %ims refresh (failure=%s)', async (delay, fail) => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      const fetcher = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() =>
        new Promise((resolve, reject) => setTimeout(() => fail ? reject(new TypeError('offline')) : resolve(response()), delay)))
      const repository = createRuntimeProviderRepository({ fetch: fetcher })
      const initial = await repository.load()
      await vi.advanceTimersByTimeAsync(60_000)
      const refresh = repository.load()
      let result: unknown
      const handover = playback(repository).then(value => { result = value })
      await vi.advanceTimersByTimeAsync(250)
      expect(result, 'a usable playback lease must not wait for advisory configuration refresh').toBe(initial)
      expect(snapshot(repository)).toBe(initial)
      // The ordinary settings/configuration read remains pending and fail-closed.
      expect(repository.peek()).toBeUndefined()
      expect(fetcher).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(delay)
      await Promise.all([refresh, handover])
      expect(await playback(repository)).toBe(initial)
    },
  )

  it('applies a local provider disable immediately while the refresh is pending', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let disabled = false
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise(() => {}))
    const repository = createRuntimeProviderRepository({ fetch: fetcher, providerPreferences: {
      isDisabled: () => disabled, revision: () => disabled ? 1 : 0,
    } })
    await repository.load()
    await vi.advanceTimersByTimeAsync(60_000)
    const refresh = repository.load()
    disabled = true
    expect(snapshot(repository)).toBeDefined()
    expect(ids(snapshot(repository)!)).toEqual([])
    let result: string[] | undefined
    const handover = playback(repository).then(value => { result = ids(value) })
    await vi.advanceTimersByTimeAsync(250)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(4000)
    await Promise.all([refresh, handover])
    expect(result).toEqual([])
  })

  it('removes revoked credentials at the synchronous adoption boundary', async () => {
    let key: string | null = 'synthetic-test-key'
    const repository = createRuntimeProviderRepository({ fetch: vi.fn().mockResolvedValue(response([
      { id: 'chksz', available: true, enabled: true, automaticEligible: true, priority: 1,
        userKeySupported: true, ownerFallbackAvailable: false },
    ])), chkszCredentials: { key: () => key, revision: () => key ? 0 : 1 } })
    await repository.load()
    key = null
    expect(snapshot(repository)).toBeDefined()
    expect(ids(snapshot(repository)!)).toEqual([])
  })

  it('keeps an explicit forced refresh authoritative and bounded', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise(() => {}))
    const repository = createRuntimeProviderRepository({ fetch: fetcher })
    await repository.load()
    const refresh = playback(repository, { forceRefresh: true })
    let settled = false
    void refresh.then(() => { settled = true })
    expect(snapshot(repository)).toBeUndefined()
    await vi.advanceTimersByTimeAsync(250)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(3750)
    expect(ids(await refresh)).toEqual(['gd-studio'])
  })

  it('promotes a routine in-flight request to forced validation without exposing an old playback snapshot', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let finish!: (value: Response) => void
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() =>
      new Promise<Response>(resolve => { finish = resolve }))
    const repository = createRuntimeProviderRepository({ fetch: fetcher })
    const initial = await repository.load()
    await vi.advanceTimersByTimeAsync(6000)
    const routine = repository.load()
    const forced = playback(repository, { forceRefresh: true })
    expect(snapshot(repository)).toBeUndefined()
    finish(response())
    const refreshed = await forced
    expect(await routine).toBe(refreshed)
    expect(refreshed).not.toBe(initial)
    expect(snapshot(repository)).toBe(refreshed)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([200, 403])('cannot resurrect a provider after an authoritative empty/denied response (%s)', async status => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce(response([], status))
    const repository = createRuntimeProviderRepository({ fetch: fetcher })
    await repository.load()
    await vi.advanceTimersByTimeAsync(6000)
    await playback(repository)
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshot(repository)?.selectable() ?? []).toEqual([])
    expect(ids(await playback(repository))).toEqual([])
  })

  it('awaits stale empty configuration so a successful refresh can restore playback eligibility', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    let finish!: (value: Response) => void
    const fetcher = vi.fn().mockResolvedValueOnce(response([])).mockImplementationOnce(() =>
      new Promise<Response>(resolve => { finish = resolve }))
    const repository = createRuntimeProviderRepository({ fetch: fetcher })
    await repository.load()
    await vi.advanceTimersByTimeAsync(6000)
    let settled = false
    const loading = playback(repository).then(registry => { settled = true; return registry })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    finish(response())
    expect(ids(await loading)).toEqual(['gd-studio'])
  })

  it('never extends the lease after repeated transient refresh failures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const fetcher = vi.fn().mockResolvedValueOnce(response()).mockRejectedValue(new TypeError('offline'))
    const repository = createRuntimeProviderRepository({ fetch: fetcher })
    await repository.load()
    await vi.advanceTimersByTimeAsync(119_999)
    expect(ids(await playback(repository))).toEqual(['gd-studio'])
    await vi.advanceTimersByTimeAsync(1)
    expect(snapshot(repository)).toBeUndefined()
    await expect(playback(repository)).rejects.toMatchObject({ name: 'ProviderConfigurationUnavailableError' })
  })
})
