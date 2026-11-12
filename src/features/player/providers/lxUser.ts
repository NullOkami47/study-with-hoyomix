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
import {
  ProviderResolveError,
  type AudioProvider,
  type Playable,
  type ProviderAttempt,
  type ResolveFailureCode,
} from './types'
import { BUILD_LX_CSP_SOURCES, isLxTargetAllowed, type LxCspSources } from '../lx/cspAllowList'
import { LX_CSP_BLOCKED, upgradeLxMediaUrlToHttps } from '../../../shared/lxCspPolicy'
import { LX_INVALID_RESPONSE, LX_NETWORK_ERROR, LX_REQUEST_TALLY } from '../lx/runtime/protocol'
import { probeMediaPlayable, type MediaProbe } from '../mediaProbe'
import type { LxGlobalSourceRepository } from '../lx/globalSourceRepository'

export interface LxUserProviderOptions {
  sourceRepository?: LxSourceRepository
  runtimeClientFactory?: () => LxRuntimeClient
  qualityStore?: Pick<PlaybackQualityPreferencesStore, 'lxQuality'>
  /** Default sink for direct calls that do not supply a per-resolution context. */
  onSubAttempt?: (attempt: ProviderAttempt) => void
  /**
   * CSP source lists a returned media URL is checked against (H-01). Defaults to the build's
   * emitted lists; only `media` is consulted here. Tests inject their own fixture origins.
   */
  cspSources?: LxCspSources
  /** The origin `'self'` stands for; defaults to the document origin. */
  selfOrigin?: string
  /**
   * Proves a promoted `https:` URL actually loads before committing to it. Defaults to a detached
   * `<audio>` metadata probe; tests inject a stub.
   */
  mediaProbe?: MediaProbe
  /**
   * The registry of sources the Owner publishes for everybody. Its sources join the chain ahead of
   * the user's own imports, in the Owner's order; the user's imports keep their own order and their
   * own settings.
   */
  globalSourceRepository?: LxGlobalSourceRepository
}

/**
 * Joins the published global sources and the user's own imports into one chain.
 *
 * The order is: the app's built-in source, then the published global sources in the Owner's order,
 * then the user's own imports in the user's order. A user's import is never replaced or deleted by
 * a published source.
 *
 * Two scripts with the same digest are the same script, so they are not run twice: the first
 * occurrence in the chain wins. One exception: if the user has *disabled* their own copy of a
 * script, that decision also suppresses the published copy of the same script — otherwise a user
 * could not turn a source off while the Owner had it published.
 */
export function mergeLxSourceChain(
  personal: readonly LxSourceRecord[],
  global: readonly LxSourceRecord[],
): LxSourceRecord[] {
  const byPriority = (a: LxSourceRecord, b: LxSourceRecord): number =>
    a.priority - b.priority || a.id.localeCompare(b.id)
  const builtIns = personal.filter((source) => source.builtIn).sort(byPriority)
  const imports = personal.filter((source) => !source.builtIn).sort(byPriority)
  const published = [...global].sort(byPriority)

  const disabledDigests = new Set(
    personal.filter((source) => !source.builtIn && !source.enabled).map((source) => source.sha256),
  )
  const suppressed = new Set(
    [...published.filter((source) => disabledDigests.has(source.sha256))].map((source) => source.sha256),
  )

  const seen = new Set<string>()
  const chain: LxSourceRecord[] = []
  for (const source of [...builtIns, ...published, ...imports]) {
    if (suppressed.has(source.sha256)) continue
    if (seen.has(source.sha256)) continue
    seen.add(source.sha256)
    chain.push(source)
  }
  return chain
}

/**
 * Turns the host's per-resolution request tally into a truthful failure code.
 *
 * The sandbox appends `requests ok=N http_error=N blocked=N timeout=N` to a failed `musicUrl`.
 * `blocked` means no readable response at all (CORS, CSP or a transport refusal); `http_error`
 * means the upstreams answered with 4xx/5xx; `ok > 0` with a failed resolution means they answered
 * and the payload was unusable. With no tally at all (a script that failed before any request, or a
 * mocked runtime) the honest answer is `unavailable` rather than a guess.
 */
export function classifyLxFailure(message: string): ResolveFailureCode {
  const tally = /requests ok=(\d+) http_error=(\d+) blocked=(\d+) timeout=(\d+)/u.exec(message)
  if (tally) {
    const ok = Number(tally[1])
    const httpError = Number(tally[2])
    const blocked = Number(tally[3])
    const timedOut = Number(tally[4])
    if (ok === 0) {
      if (timedOut > 0) return 'timeout'
      if (blocked > 0) return 'transport_blocked'
      if (httpError > 0) return 'http_error'
    }
    return 'invalid_response'
  }
  if (message.includes(LX_REQUEST_TALLY)) return 'invalid_response'
  return 'unavailable'
}

/** A refusal raised by the sandbox's `lx.request` CSP check, possibly rethrown by the script. */
function isCspBlockedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(`${LX_CSP_BLOCKED}:`)
}

/** A sandbox refusal of an unplayable musicUrl result (`http:` media or custom headers, M-11). */
function isInvalidResponseError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(`${LX_INVALID_RESPONSE}:`) && !isCspBlockedError(err)
}

/** A rejected host `fetch` behind `lx.request`, possibly rethrown by the script (task 41.7). */
function isNetworkError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(`${LX_NETWORK_ERROR}:`) && !isCspBlockedError(err)
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const message = err.message.toLowerCase()
  return message.includes('timeout') || message.includes('timed out')
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
  const cspSources = options.cspSources ?? BUILD_LX_CSP_SOURCES
  const mediaProbe = options.mediaProbe ?? probeMediaPlayable
  // Resolved per check, not here, so the default follows the document origin it runs under.
  const mediaAllowed = (url: string): boolean =>
    isLxTargetAllowed('media', new URL(url), cspSources, options.selfOrigin)

  return {
    id: 'lx',

    canResolve(track: Track): boolean {
      return deriveLxCandidates(track).length > 0
    },

    async resolve(track: Track, signal: AbortSignal, context): Promise<Playable | null> {
      const onSubAttempt = context?.onSubAttempt ?? options.onSubAttempt
      if (signal.aborted) return null

      const candidates = deriveLxCandidates(track)
      if (candidates.length === 0) return null

      const storedPersonalSources = await repository.list()
      // Once the site manages Kulao, a revoked or unavailable registry must never
      // resurrect the old release snapshot from IndexedDB.
      const personalSources = options.globalSourceRepository?.managesBundledSource
        ? storedPersonalSources.filter(source => !source.builtIn)
        : storedPersonalSources
      // A published source is an enhancement, never a prerequisite. If the registry is unreachable
      // or answers with something unusable, personal imports remain available. The managed Kulao
      // snapshot stays revoked until the site authorises it again. `try`/`catch` rather than `.catch()`: a synchronous
      // throw from `list()` would escape before a promise handler was attached.
      let globalSources: LxSourceRecord[] = []
      if (options.globalSourceRepository) {
        try {
          globalSources = await options.globalSourceRepository.list()
        } catch {
          globalSources = []
        }
      }
      const chain = mergeLxSourceChain(personalSources, globalSources)
      // A published source is a third-party source like any other: it needs the user's consent to
      // use configured sources, exactly as an imported one does.
      const enabledSources: LxSourceRecord[] = chain.filter(
        (s: LxSourceRecord) => s.enabled && (s.builtIn || allowsConfiguredSources()),
      )

      if (enabledSources.length === 0 || signal.aborted) return null

      const client = runtimeClientFactory()
      const abortRuntime = () => client.abort(signal.reason)
      signal.addEventListener('abort', abortRuntime, { once: true })

      try {
        if (signal.aborted) { abortRuntime(); return null }
        const preferredQuality = qualityStore.lxQuality()
        const fallbackTiers = QUALITY_FALLBACK_TIERS[preferredQuality] ?? QUALITY_FALLBACK_TIERS.standard

        for (const source of enabledSources) {
          if (signal.aborted) return null

          const sourceStart = Date.now()
          let sourceAttemptEmitted = false
          let lastErrorCode: ResolveFailureCode | undefined = undefined
          /** Whether `lastErrorCode` came from a network-level `lx.request` failure (task 41.7). */
          let lastErrorTransient = false

          let initedMeta: unknown = undefined
          try {
            const loadRes = await client.loadSource(source.script)
            initedMeta = loadRes.initedMeta
          } catch (err: unknown) {
            // Registry deadlines abort the isolate before its own RPC timer expires. Preserve
            // that typed reason instead of turning cancellation into a permanent source failure.
            const reason = signal.aborted ? signal.reason ?? err : err
            const code: ResolveFailureCode = reason instanceof ProviderResolveError
              ? reason.code
              : isTimeoutError(reason) ? 'timeout' : 'unavailable'
            onSubAttempt?.({
              providerId: 'lx',
              sourceId: source.id,
              sourceName: source.name,
              ok: false,
              latencyMs: Math.max(0, Date.now() - sourceStart),
              code,
              ...(reason instanceof ProviderResolveError && reason.transient ? { transient: true as const } : {}),
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
                if (signal.aborted) return null

                // CRITICAL: Reject media URLs that require custom request headers
                if (result?.requestHeaders && Object.keys(result.requestHeaders).length > 0) {
                  onSubAttempt?.({
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

                if (isPlayableMediaUrl(result?.url) && !mediaAllowed(result.url)) {
                  // H-01: media-src would refuse this URL on the element. Refuse it here with the
                  // specific code (recorded once for the source below) and keep looking: another
                  // tier, candidate or source may return a listed origin.
                  lastErrorCode = 'csp_blocked'
                  continue
                }

                if (isPlayableMediaUrl(result?.url)) {
                  onSubAttempt?.({
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
                  // A plaintext URL on a media host this deployment already trusts is worth exactly
                  // one promotion attempt: the same signed path over TLS is what actually plays.
                  // Verify it loads first, so a dead signature falls through to the next source
                  // rather than stopping playback on a URL we only believed in.
                  const promoted = upgradeLxMediaUrlToHttps(result?.url)
                  if (promoted && mediaAllowed(promoted) && (await mediaProbe(promoted, signal))) {
                    onSubAttempt?.({
                      providerId: 'lx',
                      sourceId: source.id,
                      sourceName: source.name,
                      ok: true,
                      latencyMs: Math.max(0, Date.now() - sourceStart),
                    })
                    return {
                      kind: 'audio',
                      url: promoted,
                      mimeType: inferMimeType(promoted),
                    }
                  }

                  // Not promotable, or the promoted form did not load. Record the precise reason and
                  // keep looking: another tier, another candidate or another source may still return
                  // HTTPS media.
                  onSubAttempt?.({
                    providerId: 'lx',
                    sourceId: source.id,
                    sourceName: source.name,
                    ok: false,
                    latencyMs: Math.max(0, Date.now() - sourceStart),
                    code: 'media_insecure',
                  })
                  sourceAttemptEmitted = true
                  lastErrorCode = 'media_insecure'
                  continue
                }
              } catch (err: unknown) {
                if (signal.aborted) {
                  // Emit before returning: the next quality tier's cancellation guard would
                  // otherwise discard this source's timeout evidence entirely.
                  const reason = signal.reason ?? err
                  const code: ResolveFailureCode = lastErrorCode === 'csp_blocked'
                    ? 'csp_blocked'
                    : reason instanceof ProviderResolveError
                      ? reason.code
                      : isTimeoutError(reason) ? 'timeout' : 'unavailable'
                  onSubAttempt?.({
                    providerId: 'lx', sourceId: source.id, sourceName: source.name, ok: false,
                    latencyMs: Math.max(0, Date.now() - sourceStart), code,
                    ...(code !== 'csp_blocked' && reason instanceof ProviderResolveError && reason.transient ? { transient: true as const } : {}),
                  })
                  return null
                }
                if (isInvalidResponseError(err)) {
                  // M-11: the sandbox now refuses plaintext `http:` media and results that need
                  // custom request headers itself. Report it like the in-band refusals above, so
                  // diagnostics are unchanged and the loop keeps looking; an earlier csp_blocked
                  // for this source stays the recorded code (Wave E H-01 sticky rule).
                  if (lastErrorCode === 'csp_blocked') continue
                  onSubAttempt?.({
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
                const cspBlocked = isCspBlockedError(err)
                const network = !cspBlocked && isNetworkError(err)
                const message = err instanceof Error ? err.message : ''
                // A failure that carries the host's request tally says *why* it failed, so prefer
                // that over the old binary "network or unavailable" split. A resolve-level timeout
                // is still a timeout whatever the tally says.
                const code: ResolveFailureCode = cspBlocked
                  ? 'csp_blocked'
                  : isTimeoutError(err)
                    ? 'timeout'
                    : message.includes(LX_REQUEST_TALLY)
                      ? classifyLxFailure(message)
                      : network ? 'unavailable' : 'unavailable'
                // A policy refusal is the actionable outcome; a later generic failure of the
                // same source does not overwrite it (Wave E H-01 sticky rule).
                if (lastErrorCode !== 'csp_blocked') {
                  lastErrorCode = code
                  // Task 41.7: a dropped request may succeed on a retry; keep that on the attempt.
                  lastErrorTransient = network
                }
                continue
              }
            }
          }

          if (!sourceAttemptEmitted) {
            onSubAttempt?.({
              providerId: 'lx',
              sourceId: source.id,
              sourceName: source.name,
              ok: false,
              latencyMs: Math.max(0, Date.now() - sourceStart),
              code: lastErrorCode ?? 'unavailable',
              ...(lastErrorTransient && lastErrorCode === 'unavailable' ? { transient: true as const } : {}),
            })
          }
        }

        return null
      } finally {
        signal.removeEventListener('abort', abortRuntime)
        try {
          await client.dispose()
        } catch {
          // Ignore disposal errors
        }
      }
    },
  }
}
