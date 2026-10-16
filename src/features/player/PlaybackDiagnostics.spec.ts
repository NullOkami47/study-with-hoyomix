import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../catalog/types'
import { createPlaybackStore } from './store'
import { ProviderRegistry } from './providers/registry'
import { ProviderResolveError, type ProviderAttempt } from './providers/types'
import { createChkszProvider } from './providers/chksz'
import { createLxUserProvider } from './providers/lxUser'
import { youtubeProvider } from './providers/youtube'
import type { LxRuntimeClient } from './lx/runtime/client'
import type { LxSourceRecord, LxSourceRepository } from './lx/types'
import { usePreferences } from '../../stores/preferences'
import PlaybackDiagnostics from './PlaybackDiagnostics.vue'

const track: Track = {
  id: 'track-a',
  title: 'A New Day',
  aliases: {},
  games: ['zzz'],
  relationIds: ['place:new-eridu'],
  tabs: ['focus'],
  workGroupId: 'work-a',
  vocalStatus: 'instrumental', needsClassification: false,
  sources: [{ provider: 'youtube', externalId: 'abcdefghijk' }],
}

// Sentinels that must never reach the rendered diagnostics. Each one is deliberately
// recognisable so a leak produces an unambiguous failure.
const SENTINEL_CHKSZ_KEY = 'chksz_sentinel_key_never_render_0123456789'
const SENTINEL_LX_SCRIPT_BODY = 'lx-script-body-sentinel-9f2c'
const SENTINEL_AUTH_HEADER = 'Bearer authorization-sentinel-4b7d'

const lxTrack: Track = {
  ...track,
  sources: [{ provider: 'lx', externalId: 'wy:2100334024' }],
}

/** The label half of each rendered attempt line, before the ` · ` separator. */
function attemptLabels(wrapper: VueWrapper): string[] {
  return wrapper
    .get('[data-playback-diagnostics]')
    .findAll('ul li')
    .map((item) => item.text().split(' · ')[0])
}

function createLxSource(id: string, name: string, priority: number, script: string): LxSourceRecord {
  return {
    id,
    name,
    sha256: `sha256-${id}`,
    enabled: true,
    priority,
    script,
    builtIn: id.startsWith('builtin'),
    importedAt: 1_000,
    updatedAt: 1_000,
  }
}

function createLxRepository(sources: LxSourceRecord[]): LxSourceRepository {
  return {
    list: vi.fn().mockResolvedValue(sources),
    get: vi.fn().mockImplementation(async (id: string) => sources.find((s) => s.id === id) ?? null),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    reorder: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    importScript: vi.fn(),
    importRemote: vi.fn(),
    refreshRemote: vi.fn(),
  }
}

/**
 * Drives the real composite LX provider and returns the attempt records it emits, so the
 * rendering assertions below run against the exact records the provider produces rather than
 * hand-written fixtures.
 */
async function collectLxAttempts(
  sources: LxSourceRecord[],
  client: Partial<LxRuntimeClient>,
): Promise<ProviderAttempt[]> {
  const attempts: ProviderAttempt[] = []
  const provider = createLxUserProvider({
    sourceRepository: createLxRepository(sources),
    runtimeClientFactory: () => client as LxRuntimeClient,
    qualityStore: { lxQuality: () => 'standard' },
    onSubAttempt: (attempt) => attempts.push(attempt),
  })
  await provider.resolve(lxTrack, new AbortController().signal)
  return attempts
}

/**
 * Mounts the real component over a store whose attempt trace is exactly `attempts`.
 *
 * The store's `resolve` seam is used to inject a fixed attempt trace so this spec pins the
 * rendering contract independently of resolution timing; the records fed in here are the real
 * provider's own output, captured by `collectLxAttempts`. The end-to-end coverage that the
 * production registry forwards the composite provider's `onSubAttempt` sink into
 * `store.attempts` lives in `lxSubAttemptDiagnostics.spec.ts`.
 */
function mountWithAttempts(attempts: ProviderAttempt[]) {
  const player = createPlaybackStore({
    registry: new ProviderRegistry([
      {
        provider: { id: 'lx', async resolve() { return null } },
        enabled: true,
        priority: 1,
        timeoutMs: 100,
      },
    ]),
    resolve: async () => ({ ok: false as const, code: 'exhausted' as const, attempts }),
  })
  const wrapper = mount(PlaybackDiagnostics, { props: { player } })
  return { player, wrapper }
}

describe('PlaybackDiagnostics', () => {
  beforeEach(() => usePreferences().setLocale('en'))

  it('localises provider failure details instead of exposing machine codes', async () => {
    usePreferences().setLocale('zh-Hant')
    const player = createPlaybackStore({
      registry: new ProviderRegistry([
        {
          provider: {
            id: 'r2',
            async resolve() {
              throw new ProviderResolveError('rate_limited')
            },
          },
          enabled: true,
          priority: 1,
          timeoutMs: 100,
        },
        { provider: youtubeProvider, enabled: true, priority: 2, timeoutMs: 100 },
      ]),
    })
    const trackWithFallback: Track = {
      ...track,
      sources: [
        { provider: 'r2', externalId: 'track-a' },
        { provider: 'youtube', externalId: 'abcdefghijk' },
      ],
    }
    const wrapper = mount(PlaybackDiagnostics, {
      props: {
        player,
      },
    })

    await player.playNow(trackWithFallback)
    await flushPromises()

    const diagnostics = wrapper.get('[data-playback-diagnostics]')
    expect(diagnostics.get('h3').text()).toBe('播放來源')
    expect(diagnostics.get('h4').text()).toBe('來源嘗試記錄')
    expect(diagnostics.text()).toContain('R2')
    expect(diagnostics.text()).not.toContain('rate_limited')

    wrapper.unmount()
  })

  it('renders the actionable ChKSz failure copy for a ChKSz attempt', async () => {
    const player = createPlaybackStore({
      registry: new ProviderRegistry([
        {
          provider: {
            id: 'chksz',
            async resolve() {
              throw new ProviderResolveError('quota_exhausted')
            },
          },
          enabled: true,
          priority: 1,
          timeoutMs: 100,
        },
        { provider: youtubeProvider, enabled: true, priority: 2, timeoutMs: 100 },
      ]),
    })
    const trackWithChksz: Track = {
      ...track,
      sources: [
        { provider: 'chksz', externalId: '3334421408' },
        { provider: 'youtube', externalId: 'abcdefghijk' },
      ],
    }
    const wrapper = mount(PlaybackDiagnostics, { props: { player } })

    await player.playNow(trackWithChksz)
    await flushPromises()

    const diagnostics = wrapper.get('[data-playback-diagnostics]').text()
    expect(diagnostics).toContain('Your free and paid ChKSz quota is exhausted.')
    // The machine code is never surfaced, and the copy never carries a key or request URL.
    expect(diagnostics).not.toContain('quota_exhausted')
    expect(diagnostics).not.toMatch(/chksz_[A-Za-z0-9]/u)
    expect(diagnostics).not.toContain('api.chksz.com')

    wrapper.unmount()
  })

  it('labels the three simplified top-level providers', async () => {
    const player = createPlaybackStore({
      registry: new ProviderRegistry([
        {
          provider: {
            id: 'chksz',
            async resolve() {
              throw new ProviderResolveError('credential_required')
            },
          },
          enabled: true,
          priority: 1,
          timeoutMs: 100,
        },
        {
          provider: { id: 'lx', async resolve() { return null } },
          enabled: true,
          priority: 2,
          timeoutMs: 100,
        },
        {
          provider: {
            id: 'jellyfin',
            async resolve() {
              return { kind: 'audio' as const, url: 'https://media.example.com/a.mp3', mimeType: 'audio/mpeg' }
            },
          },
          enabled: true,
          priority: 3,
          timeoutMs: 100,
        },
      ]),
    })
    const multiProviderTrack: Track = {
      ...track,
      sources: [
        { provider: 'chksz', externalId: '3334421408' },
        { provider: 'lx', externalId: 'wy:2100334024' },
        { provider: 'jellyfin', externalId: '1234567890abcdef1234567890abcdef' },
      ],
    }
    const wrapper = mount(PlaybackDiagnostics, { props: { player } })

    await player.playNow(multiProviderTrack)
    await flushPromises()

    expect(attemptLabels(wrapper)).toEqual(['ChKSz BYOK', 'LX Music', 'Jellyfin'])

    wrapper.unmount()
  })

  it('labels each LX sub-attempt with its source name', async () => {
    const attempts = await collectLxAttempts(
      [
        createLxSource('synthetic-pinned-source', 'Synthetic Pinned Source', 10, '// built-in'),
        createLxSource('custom-1', 'My Source', 20, '// custom'),
      ],
      {
        loadSource: vi.fn().mockRejectedValue(new Error('sandbox unavailable')),
        callMusicUrl: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined),
      },
    )
    expect(attempts.map((attempt) => attempt.providerId)).toEqual(['lx', 'lx'])

    const { player, wrapper } = mountWithAttempts(attempts)
    await player.playNow(lxTrack)
    await flushPromises()

    expect(attemptLabels(wrapper)).toEqual(['LX / Synthetic Pinned Source', 'LX / My Source'])

    wrapper.unmount()
  })

  it('degrades to the plain LX Music label when a sub-attempt carries no source name', async () => {
    const { player, wrapper } = mountWithAttempts([
      { providerId: 'lx', ok: false, code: 'unavailable', latencyMs: 12 },
    ])
    await player.playNow(lxTrack)
    await flushPromises()

    const diagnostics = wrapper.get('[data-playback-diagnostics]').text()
    expect(attemptLabels(wrapper)).toEqual(['LX Music'])
    expect(diagnostics).not.toContain('LX /')

    wrapper.unmount()
  })

  it('bounds and strips an adversarial LX source name', async () => {
    const hostileName = `<img src=x onerror="alert(1)">${'A'.repeat(300)}`
    const attempts = await collectLxAttempts(
      [createLxSource('custom-hostile', hostileName, 20, '// hostile')],
      {
        loadSource: vi.fn().mockRejectedValue(new Error('sandbox unavailable')),
        callMusicUrl: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined),
      },
    )

    const { player, wrapper } = mountWithAttempts(attempts)
    await player.playNow(lxTrack)
    await flushPromises()

    const diagnostics = wrapper.get('[data-playback-diagnostics]').text()
    expect(diagnostics).toContain('LX / img src=x onerror="alert(1)"')
    expect(diagnostics).not.toContain('<')
    expect(diagnostics).not.toContain('>')
    // The label is bounded: an unbounded name cannot flood the diagnostics panel.
    expect(diagnostics).not.toContain('A'.repeat(200))

    wrapper.unmount()
  })

  it('strips control and format characters from an LX source name', async () => {
    // A bidi override, a NUL, a newline and a tab are the spoofing vectors that let a hostile
    // script's @name forge an extra diagnostics line or reverse the rendered text.
    const hostileName = 'Good\u202Eevil\u0000\n\tforged'
    const attempts = await collectLxAttempts(
      [createLxSource('custom-control', hostileName, 20, '// hostile')],
      {
        loadSource: vi.fn().mockRejectedValue(new Error('sandbox unavailable')),
        callMusicUrl: vi.fn(),
        dispose: vi.fn().mockResolvedValue(undefined),
      },
    )

    const { player, wrapper } = mountWithAttempts(attempts)
    await player.playNow(lxTrack)
    await flushPromises()

    const diagnostics = wrapper.get('[data-playback-diagnostics]').text()
    expect(diagnostics).toContain('LX / Good evil forged')
    for (const character of ['\u202E', '\u0000', '\n', '\t']) {
      expect(diagnostics).not.toContain(character)
    }
    // The whole hostile name collapses onto a single rendered line.
    expect(diagnostics.match(/LX \/ /gu)).toHaveLength(1)

    wrapper.unmount()
  })

  it('never renders a ChKSz key from a failing keyed attempt', async () => {
    const requestedUrls: string[] = []
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input))
      return new Response(JSON.stringify({ code: 402, msg: 'quota' }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      })
    })
    const player = createPlaybackStore({
      registry: new ProviderRegistry([
        {
          provider: createChkszProvider({
            credentialStore: { key: () => SENTINEL_CHKSZ_KEY },
            qualityStore: { chkszQuality: () => 'standard' },
            fetch: fetchStub as unknown as typeof fetch,
          }),
          enabled: true,
          priority: 1,
          timeoutMs: 100,
        },
      ]),
    })
    const trackWithChksz: Track = {
      ...track,
      sources: [{ provider: 'chksz', externalId: '3334421408' }],
    }
    const wrapper = mount(PlaybackDiagnostics, { props: { player } })

    await player.playNow(trackWithChksz)
    await flushPromises()

    // The key really is in play: the provider sent it upstream with the request.
    expect(requestedUrls[0]).toContain(SENTINEL_CHKSZ_KEY)

    const diagnostics = wrapper.get('[data-playback-diagnostics]').text()
    expect(diagnostics).toContain('Your free and paid ChKSz quota is exhausted.')
    expect(diagnostics).not.toContain(SENTINEL_CHKSZ_KEY)
    expect(diagnostics).not.toMatch(/chksz_[A-Za-z0-9]/u)

    wrapper.unmount()
  })

  it('never renders an LX source script body, only its name', async () => {
    const attempts = await collectLxAttempts(
      [
        createLxSource(
          'synthetic-pinned-source',
          'Synthetic Pinned Source',
          10,
          `/* ${SENTINEL_LX_SCRIPT_BODY} */\n// @name Synthetic Pinned Source`,
        ),
      ],
      {
        loadSource: vi.fn().mockResolvedValue({ initedMeta: { sources: { wy: { qualitys: ['128k'] } } } }),
        callMusicUrl: vi.fn().mockRejectedValue(new Error('sandbox failure')),
        dispose: vi.fn().mockResolvedValue(undefined),
      },
    )

    const { player, wrapper } = mountWithAttempts(attempts)
    await player.playNow(lxTrack)
    await flushPromises()

    expect(JSON.stringify(attempts)).not.toContain(SENTINEL_LX_SCRIPT_BODY)
    const diagnostics = wrapper.get('[data-playback-diagnostics]').text()
    expect(diagnostics).toContain('LX / Synthetic Pinned Source')
    expect(diagnostics).not.toContain(SENTINEL_LX_SCRIPT_BODY)

    wrapper.unmount()
  })

  it('never renders the media request headers the LX provider rejects', async () => {
    const attempts = await collectLxAttempts(
      [createLxSource('custom-headers', 'Header Source', 20, '// headers')],
      {
        loadSource: vi.fn().mockResolvedValue({ initedMeta: { sources: { wy: { qualitys: ['128k'] } } } }),
        callMusicUrl: vi.fn().mockResolvedValue({
          url: 'https://media.example.com/a.mp3',
          requestHeaders: { Authorization: SENTINEL_AUTH_HEADER, Referer: 'https://example.com' },
        }),
        dispose: vi.fn().mockResolvedValue(undefined),
      },
    )
    expect(attempts).toHaveLength(1)
    expect(attempts[0].code).toBe('invalid_response')

    const { player, wrapper } = mountWithAttempts(attempts)
    await player.playNow(lxTrack)
    await flushPromises()

    expect(JSON.stringify(attempts)).not.toContain(SENTINEL_AUTH_HEADER)
    const diagnostics = wrapper.get('[data-playback-diagnostics]').text()
    expect(diagnostics).toContain('LX / Header Source')
    expect(diagnostics).toContain('invalid response')
    expect(diagnostics).not.toContain('Authorization')
    expect(diagnostics).not.toContain(SENTINEL_AUTH_HEADER)

    wrapper.unmount()
  })
})
