import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import { ProviderHealthEvents } from './health'
import {
  ProviderRegistry,
  type ProviderRegistration,
} from './providers/registry'
import {
  ProviderResolveError,
  type AudioProvider,
  type Playable,
  type ProviderAttempt,
} from './providers/types'
import { resolveTrack } from './resolver'

const track: Track = {
  id: 'track-test',
  title: 'Test Track',
  aliases: {},
  games: ['hsr'],
  relationIds: [],
  tabs: ['focus'],
  workGroupId: 'work-test',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [
    { provider: 'r2', externalId: 'audio/test-v1.ogg' },
    { provider: 'youtube', externalId: 'abcdefghijk' },
    { provider: 'qijie', externalId: 'test-track' },
  ],
}

const youtubePlayable: Playable = { kind: 'youtube', videoId: 'abcdefghijk' }

function provider(
  id: string,
  resolve: AudioProvider['resolve'],
): AudioProvider {
  return { id, resolve }
}

function registration(
  audioProvider: AudioProvider,
  overrides: Partial<Omit<ProviderRegistration, 'provider'>> = {},
): ProviderRegistration {
  return {
    provider: audioProvider,
    enabled: true,
    priority: 100,
    timeoutMs: 1_000,
    ...overrides,
  }
}

function expectValidAttempts(attempts: ProviderAttempt[]): void {
  for (const attempt of attempts) {
    expect(Number.isFinite(attempt.latencyMs)).toBe(true)
    expect(attempt.latencyMs).toBeGreaterThanOrEqual(0)
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ProviderRegistry', () => {
  it.each([
    [
      'a non-boolean enabled flag',
      { provider: provider('r2', async () => null), enabled: 'false', priority: 1, timeoutMs: 100 },
    ],
    [
      'a provider without resolve',
      { provider: { id: 'r2' }, enabled: true, priority: 1, timeoutMs: 100 },
    ],
    [
      'a provider id with surrounding whitespace',
      {
        provider: provider(' r2 ', async () => null),
        enabled: true,
        priority: 1,
        timeoutMs: 100,
      },
    ],
    [
      'a provider id outside the lowercase ASCII slug contract',
      {
        provider: provider('R2?', async () => null),
        enabled: true,
        priority: 1,
        timeoutMs: 100,
      },
    ],
  ])('rejects %s at the runtime configuration boundary', (_case, malformed) => {
    expect(() => new ProviderRegistry([malformed as ProviderRegistration])).toThrow()
  })

  it('uses fixed code-unit ordering for providers with equal priority', () => {
    const registry = new ProviderRegistry([
      registration(provider('provider-2', async () => null), { priority: 10 }),
      registration(provider('provider-10', async () => null), { priority: 10 }),
    ])

    expect(registry.enabled().map(({ provider: configuredProvider }) => configuredProvider.id)).toEqual([
      'provider-10',
      'provider-2',
    ])
  })

  it('returns an immutable configuration snapshot that cannot mutate later resolution', () => {
    const registry = new ProviderRegistry([
      registration(provider('r2', async () => null), {
        enabled: true,
        priority: 10,
        timeoutMs: 500,
      }),
    ])
    const snapshot = registry.enabled()

    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot[0])).toBe(true)
    expect(() => {
      const mutable = snapshot[0] as ProviderRegistration
      mutable.enabled = false
      mutable.priority = -1
      mutable.timeoutMs = -1
    }).toThrow(TypeError)
    expect(registry.enabled()[0]).toMatchObject({ enabled: true, priority: 10, timeoutMs: 500 })
  })

  it('returns only the matching enabled selectable registration for an explicit override', () => {
    const registry = new ProviderRegistry([
      registration(provider('r2', async () => null), { priority: 10 }),
      registration(provider('lx', async () => null), { priority: 20 }),
      registration(provider('jellyfin', async () => null), { priority: 30 }),
    ])

    const enabled = registry.enabled('lx')
    expect(enabled.map(({ provider: p }) => p.id)).toEqual(['lx'])
  })

  it('returns an empty array when an explicit override does not match any enabled registration', () => {
    const registry = new ProviderRegistry([
      registration(provider('r2', async () => null), { priority: 10 }),
      registration(provider('disabled-provider', async () => null), { enabled: false, priority: 20 }),
    ])

    expect(registry.enabled('missing-provider')).toEqual([])
    expect(registry.enabled('disabled-provider')).toEqual([])
  })
})

describe('resolveTrack', () => {
  it('resolves providers sequentially by deterministic priority and stops at the first success', async () => {
    const calls: string[] = []
    const registry = new ProviderRegistry([
      registration(
        provider('youtube', async () => {
          calls.push('youtube')
          return youtubePlayable
        }),
        { priority: 20 },
      ),
      registration(
        provider('r2', async () => {
          calls.push('r2')
          return null
        }),
        { priority: 10 },
      ),
      registration(
        provider('qijie', async () => {
          calls.push('qijie')
          return { kind: 'audio', url: 'https://media.invalid/qijie.mp3', mimeType: 'audio/mpeg' }
        }),
        { priority: 30 },
      ),
    ])

    const result = await resolveTrack(track, registry)

    expect(calls).toEqual(['r2', 'youtube'])
    expect(result).toMatchObject({
      ok: true,
      providerId: 'youtube',
      playable: youtubePlayable,
      attempts: [
        { providerId: 'r2', ok: false, code: 'unavailable' },
        { providerId: 'youtube', ok: true },
      ],
    })
    expectValidAttempts(result.attempts)
  })

  it('times out one provider through its AbortSignal and continues to the next provider', async () => {
    vi.useFakeTimers()
    let timedOutSignal: AbortSignal | undefined
    const registry = new ProviderRegistry([
      registration(
        provider('r2', (_track, signal) => {
          timedOutSignal = signal
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }),
        { priority: 10, timeoutMs: 25 },
      ),
      registration(provider('youtube', async () => youtubePlayable), { priority: 20 }),
    ])

    const pendingResult = resolveTrack(track, registry)
    await vi.advanceTimersByTimeAsync(25)
    const result = await pendingResult

    expect(timedOutSignal?.aborted).toBe(true)
    expect(result).toMatchObject({
      ok: true,
      providerId: 'youtube',
      attempts: [
        { providerId: 'r2', ok: false, code: 'timeout', latencyMs: 25 },
        { providerId: 'youtube', ok: true },
      ],
    })
  })

  it('stops immediately when the caller aborts without trying another provider', async () => {
    const calls: string[] = []
    const caller = new AbortController()
    const abortReason = new DOMException('Playback cancelled', 'AbortError')
    const registry = new ProviderRegistry([
      registration(
        provider('r2', (_track, signal) => {
          calls.push('r2')
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        }),
        { priority: 10 },
      ),
      registration(
        provider('youtube', async () => {
          calls.push('youtube')
          return youtubePlayable
        }),
        { priority: 20 },
      ),
    ])

    const pendingResult = resolveTrack(track, registry, { signal: caller.signal })
    caller.abort(abortReason)

    await expect(pendingResult).rejects.toBe(abortReason)
    expect(calls).toEqual(['r2'])
  })

  it('skips disabled providers', async () => {
    const disabledResolve = vi.fn(async () => ({
      kind: 'audio' as const,
      url: 'https://media.invalid/r2.ogg',
      mimeType: 'audio/ogg',
    }))
    const registry = new ProviderRegistry([
      registration(provider('r2', disabledResolve), { enabled: false, priority: 10 }),
      registration(provider('youtube', async () => youtubePlayable), { priority: 20 }),
    ])

    const result = await resolveTrack(track, registry)

    expect(disabledResolve).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      providerId: 'youtube',
      attempts: [{ providerId: 'youtube', ok: true }],
    })
  })

  it('excludes a provider that failed during actual media playback and continues fallback', async () => {
    const r2 = vi.fn(async () => ({ kind: 'audio' as const, url: 'https://media.invalid/broken.ogg', mimeType: 'audio/ogg' }))
    const registry = new ProviderRegistry([
      registration(provider('r2', r2), { priority: 10 }),
      registration(provider('youtube', async () => youtubePlayable), { priority: 20 }),
    ])

    const result = await resolveTrack(track, registry, { excludeProviderIds: ['r2'] })

    expect(r2).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, providerId: 'youtube' })
  })

  it('tries a valid enabled source override before the configured priority order', async () => {
    const calls: string[] = []
    const registry = new ProviderRegistry([
      registration(
        provider('r2', async () => {
          calls.push('r2')
          return { kind: 'audio', url: 'https://media.invalid/r2.ogg', mimeType: 'audio/ogg' }
        }),
        { priority: 10 },
      ),
      registration(
        provider('youtube', async () => {
          calls.push('youtube')
          return youtubePlayable
        }),
        { priority: 20 },
      ),
    ])

    const result = await resolveTrack(track, registry, { sourceOverride: 'youtube' })

    expect(calls).toEqual(['youtube'])
    expect(result).toMatchObject({ ok: true, providerId: 'youtube' })
  })

  it('returns an exhausted result with zero attempts for an unknown or disabled source override', async () => {
    const calls: string[] = []
    const registry = new ProviderRegistry([
      registration(
        provider('r2', async () => {
          calls.push('r2')
          return { kind: 'audio', url: 'https://media.invalid/r2.ogg', mimeType: 'audio/ogg' }
        }),
        { priority: 10 },
      ),
      registration(
        provider('qijie', async () => {
          calls.push('qijie')
          return null
        }),
        { enabled: false, priority: 5 },
      ),
    ])

    const unknownResult = await resolveTrack(track, registry, { sourceOverride: 'missing-provider' })
    expect(calls).toEqual([])
    expect(unknownResult).toEqual({
      ok: false,
      code: 'exhausted',
      attempts: [],
    })

    const disabledResult = await resolveTrack(track, registry, { sourceOverride: 'qijie' })
    expect(calls).toEqual([])
    expect(disabledResult).toEqual({
      ok: false,
      code: 'exhausted',
      attempts: [],
    })
  })

  it('does not fall back to automatic when an enabled override is not mapped to the track', async () => {
    const calls: string[] = []
    const registry = new ProviderRegistry([
      registration(
        provider('r2', async () => {
          calls.push('r2')
          return { kind: 'audio', url: 'https://media.invalid/r2.ogg', mimeType: 'audio/ogg' }
        }),
        { priority: 10 },
      ),
      registration(
        provider('public-meting', async () => {
          calls.push('public-meting')
          return null
        }),
        { priority: 20 },
      ),
    ])

    const result = await resolveTrack(track, registry, { sourceOverride: 'public-meting' })

    expect(calls).toEqual([])
    expect(result).toEqual({
      ok: false,
      code: 'exhausted',
      attempts: [{ providerId: 'public-meting', ok: false, code: 'not_mapped', latencyMs: 0 }],
    })
  })

  it('tries only the overridden provider on sourceOverride: "lx", returning exhausted after failure without trying Jellyfin', async () => {
    const lxResolve = vi.fn().mockResolvedValue(null)
    const jellyfinResolve = vi.fn().mockResolvedValue({
      kind: 'audio' as const,
      url: 'https://media.invalid/jellyfin.mp3',
      mimeType: 'audio/mpeg',
    })

    const genericLx: AudioProvider = {
      id: 'lx',
      canResolve: () => true,
      resolve: lxResolve,
    }
    const jellyfin: AudioProvider = {
      id: 'jellyfin',
      canResolve: () => true,
      resolve: jellyfinResolve,
    }

    const registry = new ProviderRegistry([
      registration(genericLx, { priority: 10 }),
      registration(jellyfin, { priority: 20 }),
    ])

    const result = await resolveTrack(track, registry, { sourceOverride: 'lx' })

    expect(lxResolve).toHaveBeenCalledTimes(1)
    expect(jellyfinResolve).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      code: 'exhausted',
      attempts: [{ providerId: 'lx', ok: false, code: 'unavailable' }],
    })
  })

  it('attempts a provider with no matching track.sources entry when canResolve(track) returns true', async () => {
    const generic: AudioProvider = {
      id: 'lx',
      canResolve: () => true,
      resolve: vi.fn().mockResolvedValue({
        kind: 'audio' as const,
        url: 'https://media.example/song.mp3',
        mimeType: 'audio/mpeg',
      }),
    }

    const result = await resolveTrack(track, new ProviderRegistry([
      registration(generic, { priority: 10 }),
    ]))

    expect(result).toMatchObject({ ok: true, providerId: 'lx' })
    expect(generic.resolve).toHaveBeenCalledTimes(1)
  })

  it('emits not_mapped for a legacy provider without canResolve when track.sources entry is missing', async () => {
    const legacy = provider('legacy-unmapped', vi.fn().mockResolvedValue({
      kind: 'audio' as const,
      url: 'https://media.example/song.mp3',
      mimeType: 'audio/mpeg',
    }))

    const result = await resolveTrack(track, new ProviderRegistry([
      registration(legacy, { priority: 10 }),
    ]))

    expect(result).toMatchObject({
      ok: false,
      code: 'exhausted',
      attempts: [{ providerId: 'legacy-unmapped', ok: false, code: 'not_mapped', latencyMs: 0 }],
    })
    expect(legacy.resolve).not.toHaveBeenCalled()
  })

  it('emits not_mapped when canResolve returns false even if resolve exists', async () => {
    const ineligible: AudioProvider = {
      id: 'chksz',
      canResolve: () => false,
      resolve: vi.fn().mockResolvedValue(null),
    }

    const result = await resolveTrack(track, new ProviderRegistry([
      registration(ineligible, { priority: 10 }),
    ]))

    expect(result).toMatchObject({
      ok: false,
      code: 'exhausted',
      attempts: [{ providerId: 'chksz', ok: false, code: 'not_mapped', latencyMs: 0 }],
    })
    expect(ineligible.resolve).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown kind', { kind: 'stream', url: 'https://media.invalid/secret' }],
    ['empty audio URL', { kind: 'audio', url: '', mimeType: 'audio/mpeg' }],
    ['missing audio MIME type', { kind: 'audio', url: 'https://media.invalid/secret' }],
    ['empty YouTube video ID', { kind: 'youtube', videoId: '' }],
  ])('classifies a malformed Playable response as invalid_response: %s', async (_case, malformed) => {
    const registry = new ProviderRegistry([
      registration(provider('r2', async () => malformed as Playable), { priority: 10 }),
      registration(provider('youtube', async () => youtubePlayable), { priority: 20 }),
    ])

    const result = await resolveTrack(track, registry)

    expect(result).toMatchObject({
      ok: true,
      providerId: 'youtube',
      attempts: [
        { providerId: 'r2', ok: false, code: 'invalid_response' },
        { providerId: 'youtube', ok: true },
      ],
    })
  })

  it('projects a valid provider response into the exact public Playable shape', async () => {
    const secret = 'Bearer provider-secret'
    const registry = new ProviderRegistry([
      registration(
        provider('r2', async () =>
          ({
            kind: 'audio',
            url: 'https://media.invalid/r2.ogg',
            mimeType: 'audio/ogg',
            mediaUrl: 'https://media.invalid/private-stream',
            providerMessage: secret,
            headers: { authorization: secret },
          }) as Playable,
        ),
      ),
    ])

    const result = await resolveTrack(track, registry)

    expect(result).toMatchObject({
      ok: true,
      providerId: 'r2',
      playable: {
        kind: 'audio',
        url: 'https://media.invalid/r2.ogg',
        mimeType: 'audio/ogg',
      },
    })
    if (result.ok) {
      expect(Object.keys(result.playable).sort()).toEqual(['kind', 'mimeType', 'url'])
    }
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain('private-stream')
  })

  it('records typed provider failures and reports typed complete exhaustion', async () => {
    const secretUrl = 'https://media.invalid/private-token'
    const registry = new ProviderRegistry([
      registration(
        provider('r2', async () => {
          throw new ProviderResolveError('rate_limited')
        }),
        { priority: 10 },
      ),
      registration(
        provider('youtube', async () => {
          throw new Error(`upstream exposed ${secretUrl}`)
        }),
        { priority: 20 },
      ),
      registration(provider('qijie', async () => null), { priority: 30 }),
      registration(provider('public-meting', async () => youtubePlayable), { priority: 40 }),
    ])

    const result = await resolveTrack(track, registry)

    expect(result).toEqual({
      ok: false,
      code: 'exhausted',
      attempts: [
        { providerId: 'r2', ok: false, code: 'rate_limited', latencyMs: expect.any(Number) },
        { providerId: 'youtube', ok: false, code: 'unavailable', latencyMs: expect.any(Number) },
        { providerId: 'qijie', ok: false, code: 'unavailable', latencyMs: expect.any(Number) },
        { providerId: 'public-meting', ok: false, code: 'not_mapped', latencyMs: 0 },
      ],
    })
    expect(JSON.stringify(result)).not.toContain(secretUrl)
    expectValidAttempts(result.attempts)
  })

  it('emits URL-free ProviderAttempt health events without logging resolved media URLs', async () => {
    const secretUrl = 'https://media.invalid/audio/private-token.ogg'
    const health = new ProviderHealthEvents()
    const observed: ProviderAttempt[] = []
    health.subscribe((attempt) => observed.push(attempt))
    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ]
    const registry = new ProviderRegistry([
      registration(
        provider('r2', async () => ({ kind: 'audio', url: secretUrl, mimeType: 'audio/ogg' })),
      ),
    ])

    const result = await resolveTrack(track, registry, { onAttempt: health.emit })

    expect(result).toMatchObject({ ok: true, providerId: 'r2' })
    expect(observed).toEqual(result.attempts)
    expect(JSON.stringify(observed)).not.toContain(secretUrl)
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
  })

  it('removes the internal provider AbortSignal listener after resolution', async () => {
    let removedAbortListener = false
    const registry = new ProviderRegistry([
      registration(
        provider('r2', async (_track, signal) => {
          const removeEventListener = signal.removeEventListener.bind(signal)
          vi.spyOn(signal, 'removeEventListener').mockImplementation((type, listener, options) => {
            if (type === 'abort') removedAbortListener = true
            removeEventListener(type, listener, options)
          })
          return { kind: 'audio', url: 'https://media.invalid/r2.ogg', mimeType: 'audio/ogg' }
        }),
      ),
    ])

    const result = await resolveTrack(track, registry)

    expect(result).toMatchObject({ ok: true, providerId: 'r2' })
    expect(removedAbortListener).toBe(true)
  })
})

describe('deterministic provider chain with user exclusions', () => {
  const chainTrack: Track = {
    ...track,
    sources: [
      { provider: 'r2', externalId: 'audio/test-v1.ogg' },
      { provider: 'meting', externalId: 'netease:123456789' },
      { provider: 'lx-huibq', externalId: 'kw:ABC:320k' },
      { provider: 'lx-ikun', externalId: 'wy:123456:flac' },
      { provider: 'chksz', externalId: '1315196858' },
      { provider: 'piped', externalId: 'abcdefghijk' },
      { provider: 'invidious', externalId: 'abcdefghijk' },
      { provider: 'youtube', externalId: 'abcdefghijk' },
    ],
  }

  const PRIORITIES: Record<string, number> = {
    r2: 1,
    meting: 2,
    'lx-huibq': 3,
    'lx-ikun': 4,
    chksz: 11,
    piped: 12,
    invidious: 13,
    youtube: 90,
  }

  const audio = (id: string): Playable =>
    ({ kind: 'audio', url: `https://media.invalid/${id}.mp3`, mimeType: 'audio/mpeg' })

  /**
   * Builds a registry the way the runtime does: server deployment/Admin state and
   * geo eligibility first, then the user's exclusion set.
   */
  const chain = (options: {
    ids: readonly string[]
    userDisabled?: readonly string[]
    automaticIneligible?: readonly string[]
    failing?: Readonly<Record<string, ProviderResolveError['code']>>
    calls?: string[]
  }) => {
    const userDisabled = new Set(options.userDisabled ?? [])
    const ineligible = new Set(options.automaticIneligible ?? ['youtube'])
    return new ProviderRegistry(options.ids
      .filter((id) => !userDisabled.has(id))
      .map((id) => registration(
        provider(id, async () => {
          options.calls?.push(id)
          const failure = options.failing?.[id]
          if (failure) throw new ProviderResolveError(failure)
          return audio(id)
        }),
        {
          priority: PRIORITIES[id] ?? 50,
          automaticEligible: !ineligible.has(id),
        },
      )))
  }

  const CN_CHAIN = ['r2', 'meting', 'lx-huibq', 'lx-ikun', 'chksz', 'piped', 'invidious', 'youtube']

  it('falls back from R2 through Meting to lx-huibq', async () => {
    const calls: string[] = []
    const registry = chain({
      ids: CN_CHAIN,
      failing: { r2: 'unavailable', meting: 'unavailable' },
      calls,
    })

    const result = await resolveTrack(chainTrack, registry)

    expect(result).toMatchObject({ ok: true, providerId: 'lx-huibq' })
    expect(calls).toEqual(['r2', 'meting', 'lx-huibq'])
  })

  it('skips a user-disabled lx-huibq and uses lx-ikun instead', async () => {
    const calls: string[] = []
    const registry = chain({
      ids: CN_CHAIN,
      userDisabled: ['lx-huibq'],
      failing: { r2: 'unavailable', meting: 'unavailable' },
      calls,
    })

    const result = await resolveTrack(chainTrack, registry)

    expect(result).toMatchObject({ ok: true, providerId: 'lx-ikun' })
    expect(calls).toEqual(['r2', 'meting', 'lx-ikun'])
    expect(calls).not.toContain('lx-huibq')
  })

  it('attempts a rate-limited LX provider exactly once and continues', async () => {
    const calls: string[] = []
    const registry = chain({
      ids: CN_CHAIN,
      failing: {
        r2: 'unavailable',
        meting: 'unavailable',
        'lx-huibq': 'rate_limited',
      },
      calls,
    })

    const result = await resolveTrack(chainTrack, registry)

    expect(result).toMatchObject({ ok: true, providerId: 'lx-ikun' })
    expect(calls.filter((id) => id === 'lx-huibq')).toHaveLength(1)
    expect(result.attempts.find(({ providerId }) => providerId === 'lx-huibq'))
      .toMatchObject({ ok: false, code: 'rate_limited' })
  })

  it('uses the full CN order including ChKSz when every provider fails', async () => {
    const calls: string[] = []
    const registry = chain({
      ids: CN_CHAIN,
      failing: Object.fromEntries(CN_CHAIN.map((id) => [id, 'unavailable' as const])),
      calls,
    })

    const result = await resolveTrack(chainTrack, registry)

    expect(result.ok).toBe(false)
    expect(calls).toEqual([
      'r2', 'meting', 'lx-huibq', 'lx-ikun', 'chksz', 'piped', 'invidious',
    ])
    expect(calls).not.toContain('youtube')
  })

  it('omits ChKSz from the non-CN Automatic order', async () => {
    const calls: string[] = []
    const registry = chain({
      ids: CN_CHAIN,
      automaticIneligible: ['youtube', 'chksz'],
      failing: Object.fromEntries(CN_CHAIN.map((id) => [id, 'unavailable' as const])),
      calls,
    })

    const result = await resolveTrack(chainTrack, registry)

    expect(result.ok).toBe(false)
    expect(calls).toEqual(['r2', 'meting', 'lx-huibq', 'lx-ikun', 'piped', 'invidious'])
    expect(calls).not.toContain('chksz')
  })

  it('never attempts YouTube in the Automatic chain', async () => {
    const calls: string[] = []
    const registry = chain({
      ids: CN_CHAIN,
      failing: Object.fromEntries(
        CN_CHAIN.filter((id) => id !== 'youtube').map((id) => [id, 'unavailable' as const]),
      ),
      calls,
    })

    await resolveTrack(chainTrack, registry)

    expect(calls).not.toContain('youtube')
  })

  it('does not attempt a blocked LX source that the server never registered', async () => {
    const calls: string[] = []
    const blockedTrack: Track = {
      ...chainTrack,
      sources: [
        ...chainTrack.sources,
        { provider: 'lx-qdy', externalId: 'kw:ABC:320k' },
        { provider: 'lx-sixyin', externalId: 'wy:123456:320k' },
      ],
    }
    // Deployment-unavailable providers never reach the registry at all.
    const registry = chain({
      ids: CN_CHAIN,
      failing: Object.fromEntries(CN_CHAIN.map((id) => [id, 'unavailable' as const])),
      calls,
    })

    await resolveTrack(blockedTrack, registry)

    expect(calls).not.toContain('lx-qdy')
    expect(calls).not.toContain('lx-sixyin')
  })

  it('reports no eligible source when the user disables every automatic provider', async () => {
    const calls: string[] = []
    const registry = chain({
      ids: CN_CHAIN,
      userDisabled: ['r2', 'meting', 'lx-huibq', 'lx-ikun', 'chksz', 'piped', 'invidious'],
      calls,
    })

    const result = await resolveTrack(chainTrack, registry)

    expect(result.ok).toBe(false)
    expect(calls).toEqual([])
  })
})
