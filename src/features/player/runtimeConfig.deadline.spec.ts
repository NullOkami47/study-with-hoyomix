import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../catalog/types'
import type { AudioProvider } from './providers/types'
import { resolveTrack } from './resolver'
import { createRuntimeProviderRepository } from './runtimeConfig'

const current = { id: 'slow-but-playable', title: 'Slow but playable', sources: [{ provider: 'lx', externalId: 'wy:123:320k' }] } as Track
const playable = { kind: 'audio' as const, url: 'https://media.invalid/recovered.mp3', mimeType: 'audio/mpeg' }
async function registryFor(resolve: AudioProvider['resolve']) {
  const response = new Response(JSON.stringify({ version: 1, providers: [
    { id: 'lx', available: true, enabled: true, automaticEligible: true, priority: 1 },
  ] }), { headers: { 'content-type': 'application/json' } })
  Object.defineProperty(response, 'url', { value: new URL('/api/providers/config', window.location.origin).toString() })
  return createRuntimeProviderRepository({
    fetch: vi.fn().mockResolvedValue(response),
    providerPreferences: { isDisabled: () => false, revision: () => 0 },
    lxProviderFactory: () => ({ id: 'lx', canResolve: () => true, resolve }),
  }).load()
}
afterEach(() => vi.useRealTimers())

describe('LX end-to-end provider deadline', () => {
  it('allows a playable LX response after a five-second mobile network delay', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const registry = await registryFor(async (_track, callerSignal) => {
      signal = callerSignal
      await new Promise(resolve => setTimeout(resolve, 5_000))
      return playable
    })
    const pending = resolveTrack(current, registry)
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await pending
    expect(result).toMatchObject({ ok: true, providerId: 'lx', playable })
    expect(signal?.aborted).toBe(false)
  })

  it('still aborts a provider that does not settle within one minute', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const registry = await registryFor(async (_track, callerSignal) => {
      signal = callerSignal
      return new Promise(() => {})
    })
    const pending = resolveTrack(current, registry)
    await vi.advanceTimersByTimeAsync(60_001)
    expect(await pending).toMatchObject({ ok: false, attempts: [{ providerId: 'lx', code: 'timeout' }] })
    expect(signal?.aborted).toBe(true)
  })
})
