import { allowsConfiguredSources } from '../thirdPartyConsent'
import type { Track } from '../../catalog/types'
import { deriveLxCandidates } from '../lx/candidates'
import { LxRuntimeClient } from '../lx/runtime/client'
import { getDefaultLxSourceRepository } from '../lx/sourceRepository'
import type { LxSourceRecord, LxSourceRepository } from '../lx/types'
import {
  getDefaultPlaybackQualityPreferencesStore,
  type LxQuality,
  type PlaybackQualityPreferencesStore,
} from '../qualityPreferences'
import type {
  AudioProvider,
  Playable,
  ProviderAttempt,
  ResolveFailureCode,
} from './types'

export interface LxUserProviderOptions {
  sourceRepository?: LxSourceRepository
  runtimeClientFactory?: () => LxRuntimeClient
  qualityStore?: Pick<PlaybackQualityPreferencesStore, 'lxQuality'>
  onSubAttempt?: (attempt: ProviderAttempt) => void
}

const QUALITY_FALLBACK_TIERS: Record<LxQuality, readonly string[]> = {
  standard: ['128k'],
  high: ['320k', '128k'],
  lossless: ['flac', '320k', '128k'],
  hires: ['flac24bit', 'flac', '320k', '128k'],
}

export function inferMimeType(url: string): string {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    if (pathname.endsWith('.flac')) return 'audio/flac'
    if (pathname.endsWith('.mp3')) return 'audio/mpeg'
    if (pathname.endsWith('.m4a') || pathname.endsWith('.mp4')) return 'audio/mp4'
    if (pathname.endsWith('.ogg')) return 'audio/ogg'
    if (pathname.endsWith('.wav')) return 'audio/wav'
    if (pathname.endsWith('.webm')) return 'audio/webm'
    if (pathname.endsWith('.aac')) return 'audio/aac'
  } catch {
    const lower = url.toLowerCase().split('?')[0]
    if (lower.endsWith('.flac')) return 'audio/flac'
    if (lower.endsWith('.mp3')) return 'audio/mpeg'
    if (lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'audio/mp4'
    if (lower.endsWith('.ogg')) return 'audio/ogg'
    if (lower.endsWith('.wav')) return 'audio/wav'
  }
  return 'audio/mpeg'
}

/**
 * How an LX source's returned media URL relates to this deployment's media transport policy.
 *
 * `media-src` in the generated CSP is `'self'` plus the R2 origin plus `https://*.music.126.net`
 * (`vite.config.ts`), so a plaintext `http:` URL can never be played — the media element refuses it
 * before a single byte is fetched. A source that only yields `http:` media is therefore unhealthy
 * rather than unlucky, and deciding that here is what lets the source loop move on to the next
 * enabled source instead of surfacing an opaque `unavailable` after the browser has already
 * rejected the element.
 *
 * `insecure` is deliberately distinct from `invalid`: one is a policy refusal about a well-formed
 * URL, the other is a malformed value. Both are refused, for different reasons.
 */
type MediaUrlScheme = 'https' | 'insecure' | 'invalid'

function classifyMediaUrl(url: unknown): MediaUrlScheme {
  if (typeof url !== 'string' || !url.trim()) return 'invalid'
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return 'https'
    if (parsed.protocol === 'http:') return 'insecure'
    return 'invalid'
  } catch {
    return 'invalid'
  }
}

/**
 * True only for media this deployment is actually permitted to play.
 *
 * Deliberately HTTPS-only. Widening this to `http:` would not make the audio play; it would only
 * move the refusal from here to the CSP, where it is indistinguishable from a dead upstream.
 */
function isPlayableMediaUrl(url: unknown): url is string {
  return classifyMediaUrl(url) === 'https'
}

function getDeclaredQualities(initedMeta: unknown, platformSource: string): Set<string> | null {
  if (!initedMeta || typeof initedMeta !== 'object') return null
  const meta = initedMeta as Record<string, unknown>
  if (!meta.sources || typeof meta.sources !== 'object') return null
  const sourcesObj = meta.sources as Record<string, unknown>
  const sourceInfo = sourcesObj[platformSource]
  if (!sourceInfo || typeof sourceInfo !== 'object') return null
  const info = sourceInfo as Record<string, unknown>
  const qualities = (
    Array.isArray(info.qualitys)
      ? info.qualitys
      : Array.isArray(info.qualities)
      ? info.qualities
      : null
  ) as string[] | null

  if (!qualities || qualities.length === 0) return null
  return new Set(qualities)
}

export function createLxUserProvider(options: LxUserProviderOptions = {}): AudioProvider {
  const repository = options.sourceRepository ?? getDefaultLxSourceRepository()
  const runtimeClientFactory = options.runtimeClientFactory ?? (() => new LxRuntimeClient())
  const qualityStore = options.qualityStore ?? getDefaultPlaybackQualityPreferencesStore()

  return {
    id: 'lx',

    canResolve(track: Track): boolean {
      return deriveLxCandidates(track).length > 0
    },

    async resolve(track: Track, signal: AbortSignal): Promise<Playable | null> {
      if (signal.aborted) return null

      const candidates = deriveLxCandidates(track)
      if (candidates.length === 0) return null

      const allSources = await repository.list()
      const enabledSources: LxSourceRecord[] = allSources
        .filter((s: LxSourceRecord) => s.enabled && (s.builtIn || allowsConfiguredSources()))
        .sort((a: LxSourceRecord, b: LxSourceRecord) => a.priority - b.priority)

      if (enabledSources.length === 0 || signal.aborted) return null

      const client = runtimeClientFactory()

      try {
        const preferredQuality = qualityStore.lxQuality()
        const fallbackTiers = QUALITY_FALLBACK_TIERS[preferredQuality] ?? QUALITY_FALLBACK_TIERS.standard

        for (const source of enabledSources) {
          if (signal.aborted) return null

          const sourceStart = Date.now()
          let sourceAttemptEmitted = false
          let lastErrorCode: ResolveFailureCode | undefined = undefined

          let initedMeta: unknown = undefined
          try {
            const loadRes = await client.loadSource(source.script)
            initedMeta = loadRes.initedMeta
          } catch (err: unknown) {
            const isTimeout =
              err instanceof Error &&
              (err.message.toLowerCase().includes('timeout') ||
                err.message.toLowerCase().includes('timed out'))
            const code: ResolveFailureCode = isTimeout ? 'timeout' : 'unavailable'
            options.onSubAttempt?.({
              providerId: 'lx',
              sourceId: source.id,
              sourceName: source.name,
              ok: false,
              latencyMs: Math.max(0, Date.now() - sourceStart),
              code,
            })
            continue
          }

          for (const candidate of candidates) {
            if (signal.aborted) return null

            const declared = getDeclaredQualities(initedMeta, candidate.source)
            let effectiveTiers = fallbackTiers
            if (declared && declared.size > 0 && fallbackTiers.some((q) => declared.has(q))) {
              effectiveTiers = fallbackTiers.filter((q) => declared.has(q))
            }

            for (const tier of effectiveTiers) {
              if (signal.aborted) return null

              const anyTrack = track as unknown as Record<string, unknown>
              const artistText =
                typeof anyTrack.artist === 'string' && anyTrack.artist.trim()
                  ? anyTrack.artist.trim()
                  : 'HOYO-MiX'

              const musicInfo: Record<string, unknown> = {
                id: candidate.id,
                songId: candidate.id,
                songmid: candidate.id,
                mid: candidate.id,
                hash: candidate.id,
                name: track.title,
                title: track.title,
                singer: artistText,
                artist: artistText,
                source: candidate.source,
                quality: tier,
                musicInfo: undefined,
              }

              if (typeof anyTrack.album === 'string' && anyTrack.album.trim()) {
                musicInfo.album = anyTrack.album.trim()
              }
              if (typeof anyTrack.duration === 'number' && Number.isFinite(anyTrack.duration)) {
                musicInfo.duration = anyTrack.duration
                musicInfo.interval = anyTrack.duration
              }

              // The MeloX/LX contract exposes the song object to itself as `musicInfo.musicInfo`.
              // That self-reference is attached inside the guest by `__lxDispatchMusicUrl`, NOT
              // here: putting it on the wire would make the RPC payload cyclic. Structured clone
              // preserves cycles but drops non-enumerable properties, so a `toJSON` escape hatch
              // cannot survive `postMessage`, and the worker's JSON size guard would then reject
              // every `musicUrl` request outright.
              try {
                const result = await client.callMusicUrl(candidate.source, musicInfo, tier)

                // CRITICAL: Reject media URLs that require custom request headers
                if (result?.requestHeaders && Object.keys(result.requestHeaders).length > 0) {
                  options.onSubAttempt?.({
                    providerId: 'lx',
                    sourceId: source.id,
                    sourceName: source.name,
                    ok: false,
                    latencyMs: Math.max(0, Date.now() - sourceStart),
                    code: 'invalid_response',
                  })
                  sourceAttemptEmitted = true
                  lastErrorCode = 'invalid_response'
                  continue
                }

                if (isPlayableMediaUrl(result?.url)) {
                  options.onSubAttempt?.({
                    providerId: 'lx',
                    sourceId: source.id,
                    sourceName: source.name,
                    ok: true,
                    latencyMs: Math.max(0, Date.now() - sourceStart),
                  })
                  return {
                    kind: 'audio',
                    url: result.url,
                    mimeType: inferMimeType(result.url),
                  }
                }

                if (classifyMediaUrl(result?.url) === 'insecure') {
                  // Well-formed but unplayable here. Record this source as failed with a precise
                  // code and keep looking: another tier, another candidate or another source may
                  // still return HTTPS media. This is the case the bundled sources actually hit.
                  options.onSubAttempt?.({
                    providerId: 'lx',
                    sourceId: source.id,
                    sourceName: source.name,
                    ok: false,
                    latencyMs: Math.max(0, Date.now() - sourceStart),
                    code: 'invalid_response',
                  })
                  sourceAttemptEmitted = true
                  lastErrorCode = 'invalid_response'
                  continue
                }
              } catch (err: unknown) {
                const isTimeout =
                  err instanceof Error &&
                  (err.message.toLowerCase().includes('timeout') ||
                    err.message.toLowerCase().includes('timed out'))
                const code: ResolveFailureCode = isTimeout ? 'timeout' : 'unavailable'
                lastErrorCode = code
                continue
              }
            }
          }

          if (!sourceAttemptEmitted) {
            options.onSubAttempt?.({
              providerId: 'lx',
              sourceId: source.id,
              sourceName: source.name,
              ok: false,
              latencyMs: Math.max(0, Date.now() - sourceStart),
              code: lastErrorCode ?? 'unavailable',
            })
          }
        }

        return null
      } finally {
        try {
          await client.dispose()
        } catch {
          // Ignore disposal errors
        }
      }
    },
  }
}
