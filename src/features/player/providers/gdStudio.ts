import type { Track, TrackSource } from '../../catalog/types'
import { isChkszExternalId } from '../../../shared/chksz'
import { isGdStudioQuality, type PlaybackQualityPreferencesStore } from '../qualityPreferences'
import { getSharedGdStudioBudget, type GdStudioBudget } from '../gdStudio/budget'
import { createServerProxyProvider, type ServerProxyProviderOptions } from './proxy'
import { ProviderResolveError, type AudioProvider, type Playable } from './types'

// Upper bound on the Worker-minted ticket, not an inferred lifetime of the upstream URL.
const MAX_TICKET_REMAINING_MS = 120_000
const HIGH_BITRATE_FALLBACK_CHAIN: Readonly<Record<string, readonly string[]>> = {
  '999': ['999', '740', '320'],
  '740': ['740', '320'],
}

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
  return {
    id: 'gd-studio',
    canResolve: (track) => Boolean(mappedSource(track)),
    async resolve(track: Track, signal: AbortSignal): Promise<Playable | null> {
      if (signal.aborted) throw signal.reason ?? new DOMException('GD Studio resolution aborted', 'AbortError')
      const source = mappedSource(track)
      if (!source) return null

      const quality = options.qualityStore?.gdStudioQuality()
      const canRewriteBitrate =
        /^[a-z0-9-]+:[a-zA-Z0-9_-]{1,64}(?::(?:128|192|320|740|999))?$/.test(source.externalId)
      let candidates: TrackSource[]
      if (canRewriteBitrate && isGdStudioQuality(quality) && quality !== 'auto') {
        const [platform, id] = source.externalId.split(':')
        const bitrates = HIGH_BITRATE_FALLBACK_CHAIN[quality] ?? [quality]
        candidates = bitrates.map(br => ({ ...source, externalId: `${platform}:${id}:${br}` }))
      } else {
        candidates = [source]
      }

      let lastError: unknown
      for (let attempt = 0; attempt < candidates.length; attempt += 1) {
        if (signal.aborted) throw signal.reason ?? new DOMException('GD Studio resolution aborted', 'AbortError')
        const budgetDecision = budget.tryAcquire()
        if (!budgetDecision.ok) {
          if (attempt === 0) throw new ProviderResolveError('rate_limited')
          throw lastError
        }

        const candidateSource = candidates[attempt]!
        // Only this request's view gains the derived mapping; the canonical track and catalogue stay intact.
        const mapped = {
          ...track,
          sources: [candidateSource, ...track.sources.filter(candidate => candidate.provider !== 'gd-studio')],
        }
        let lastStatus: number | undefined
        const attemptProxy = createServerProxyProvider('gd-studio', 'gd-studio', {
          ...options,
          includeExpiry: true,
          now,
          fetch: async (input, init) => {
            const response = await fetchImpl(input, init)
            lastStatus = response.status
            if (response.status === 429) budget.noteRateLimited(retryAfterMs(response.headers.get('retry-after'), now()))
            return response
          },
        })
        try {
          const playable = await attemptProxy.resolve(mapped, signal)
          if (playable?.expiresAt !== undefined) {
            // When the Worker emits `ttlMs`/`issuedAt`, `proxy.ts` translates it to a conservative
            // client-local deadline before reaching here; legacy `expiresAt`-only payloads retain the
            // direct clock check against `now()`.
            const remainingMs = playable.expiresAt - now()
            if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > MAX_TICKET_REMAINING_MS) {
              throw new ProviderResolveError('invalid_response')
            }
          }
          return playable
        } catch (error) {
          const canStepDown =
            attempt + 1 < candidates.length &&
            error instanceof ProviderResolveError &&
            error.code === 'unavailable' &&
            lastStatus === 502
          if (!canStepDown) throw error
          lastError = error
        }
      }
      throw lastError
    },
  }
}
