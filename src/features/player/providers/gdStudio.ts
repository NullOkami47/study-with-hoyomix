import type { Track, TrackSource } from '../../catalog/types'
import { isChkszExternalId } from '../../../shared/chksz'
import { isGdStudioQuality, type PlaybackQualityPreferencesStore } from '../qualityPreferences'
import { getSharedGdStudioBudget, type GdStudioBudget } from '../gdStudio/budget'
import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import { ProviderResolveError, type AudioProvider, type Playable } from './types'

export interface GdStudioProviderOptions extends ServerProxyProviderOptions {
  budget?: Pick<GdStudioBudget, 'tryAcquire' | 'noteRateLimited'>
  now?: () => number
  qualityStore?: Pick<PlaybackQualityPreferencesStore, 'gdStudioQuality'>
}

function mappedSource(track: Track): TrackSource | undefined {
  const explicit = track.sources.find((source) => source.provider === 'gd-studio')
  if (explicit) return explicit
  const netease = track.sources.find((source) => source.provider === 'chksz' && isChkszExternalId(source.externalId))
  return netease ? { provider: 'gd-studio', externalId: 'netease:' + netease.externalId + ':320' } : undefined
}

function retryAfterMs(value: string | null, now: number): number {
  if (value === null || !value.trim()) return 30_000
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 30_000
}

/** Independent official API playback via the existing same-origin guarded media proxy. */
export function createGdStudioProvider(options: GdStudioProviderOptions = {}): AudioProvider {
  const budget = options.budget ?? getSharedGdStudioBudget()
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
  const proxy = createServerProxyProvider('gd-studio', 'gd-studio', {
    ...options,
    fetch: async (input, init) => {
      const response = await fetchImpl(input, init)
      if (response.status === 429) budget.noteRateLimited(retryAfterMs(response.headers.get('retry-after'), now()))
      return response
    },
  })
  return {
    id: 'gd-studio',
    canResolve: (track) => Boolean(mappedSource(track)),
    async resolve(track: Track, signal: AbortSignal): Promise<Playable | null> {
      if (signal.aborted) throw signal.reason ?? new DOMException('GD Studio resolution aborted', 'AbortError')
      let source = mappedSource(track)
      const quality = options.qualityStore?.gdStudioQuality()
      // Change only the bitrate of a valid binding; Automatic preserves the catalogue default.
      if (source && isGdStudioQuality(quality) && quality !== 'auto' &&
          /^[a-z0-9-]+:[a-zA-Z0-9_-]{1,64}(?::(?:128|192|320|740|999))?$/.test(source.externalId)) {
        const [platform, id] = source.externalId.split(':')
        source = { ...source, externalId: `${platform}:${id}:${quality}` }
      }
      if (!source) return null
      if (!budget.tryAcquire().ok) throw new ProviderResolveError('rate_limited')
      // Only this request's view gains the derived mapping; the canonical track and catalogue stay intact.
      const mapped = { ...track, sources: [source, ...track.sources.filter(candidate => candidate.provider !== 'gd-studio')] }
      return proxy.resolve(mapped, signal)
    },
  }
}
