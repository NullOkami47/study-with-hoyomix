import type { Track } from '../catalog/types'
import type { ProviderRegistrationSnapshot } from './providers/registry'
import { isProviderEligible, ProviderRegistry } from './providers/registry'
import {
  ProviderResolveError,
  type Playable,
  type PlaybackPresentationMetadata,
  type ProviderAttempt,
  type ResolveFailureCode,
} from './providers/types'

export interface ResolveOptions {
  excludeProviderIds?: readonly string[]
  signal?: AbortSignal
  sourceOverride?: string
  onAttempt?: (attempt: ProviderAttempt) => void
}

export type ResolveResult =
  | {
      ok: true
      providerId: string
      playable: Playable
      attempts: ProviderAttempt[]
    }
  | {
      ok: false
      code: 'exhausted'
      attempts: ProviderAttempt[]
    }

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Playback resolution aborted', 'AbortError')
}

function projectPlayable(value: unknown): Playable | null {
  if (typeof value !== 'object' || value === null) return null

  const candidate = value as Record<string, unknown>
  const metadata = (typeof candidate.metadata === 'object' && candidate.metadata !== null)
    ? (candidate.metadata as PlaybackPresentationMetadata)
    : undefined

  if (candidate.kind === 'youtube') {
    if (typeof candidate.videoId !== 'string' || candidate.videoId.trim().length === 0) {
      return null
    }
    return {
      kind: 'youtube',
      videoId: candidate.videoId,
      ...(metadata ? { metadata } : {}),
    }
  }
  if (candidate.kind === 'audio') {
    if (
      typeof candidate.url !== 'string' ||
      candidate.url.trim().length === 0 ||
      typeof candidate.mimeType !== 'string' ||
      !candidate.mimeType.startsWith('audio/')
    ) {
      return null
    }
    return {
      kind: 'audio',
      url: candidate.url,
      mimeType: candidate.mimeType,
      ...(metadata ? { metadata } : {}),
    }
  }
  return null
}

function emitAttempt(
  attempts: ProviderAttempt[],
  attempt: ProviderAttempt,
  listener?: (attempt: ProviderAttempt) => void,
): void {
  attempts.push(attempt)
  if (!listener) return

  try {
    listener(attempt)
  } catch {
    // Health reporting is best-effort and cannot break anonymous playback.
  }
}

function failureCode(error: unknown): ResolveFailureCode {
  return error instanceof ProviderResolveError ? error.code : 'unavailable'
}

async function resolveProvider(
  track: Track,
  registration: ProviderRegistrationSnapshot,
  callerSignal?: AbortSignal,
): Promise<{ playable: Playable | null; code?: ResolveFailureCode; latencyMs: number }> {
  const startedAt = Date.now()
  const providerController = new AbortController()
  let timedOut = false

  const handleCallerAbort = (): void => providerController.abort(abortReason(callerSignal!))
  if (callerSignal) {
    if (callerSignal.aborted) throw abortReason(callerSignal)
    callerSignal.addEventListener('abort', handleCallerAbort, { once: true })
  }

  const timeout = setTimeout(() => {
    timedOut = true
    providerController.abort(new ProviderResolveError('timeout'))
  }, registration.timeoutMs)

  let rejectProviderAbort: (reason: unknown) => void = () => undefined
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectProviderAbort = reject
  })
  const handleProviderAbort = (): void =>
    rejectProviderAbort(abortReason(providerController.signal))
  providerController.signal.addEventListener('abort', handleProviderAbort, { once: true })

  try {
    const value = await Promise.race([
      registration.provider.resolve(track, providerController.signal),
      abortPromise,
    ])
    const latencyMs = Math.max(0, Date.now() - startedAt)
    if (value === null) return { playable: null, code: 'unavailable', latencyMs }
    const playable = projectPlayable(value)
    if (!playable) return { playable: null, code: 'invalid_response', latencyMs }
    return { playable, latencyMs }
  } catch (error) {
    if (callerSignal?.aborted) throw abortReason(callerSignal)
    return {
      playable: null,
      code: timedOut ? 'timeout' : failureCode(error),
      latencyMs: Math.max(0, Date.now() - startedAt),
    }
  } finally {
    clearTimeout(timeout)
    providerController.signal.removeEventListener('abort', handleProviderAbort)
    callerSignal?.removeEventListener('abort', handleCallerAbort)
  }
}

export async function resolveTrack(
  track: Track,
  registry: ProviderRegistry,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  if (options.signal?.aborted) throw abortReason(options.signal)

  const attempts: ProviderAttempt[] = []
  const excludedProviderIds = new Set(options.excludeProviderIds ?? [])
  const sourceOverride =
    typeof options.sourceOverride === 'string' && options.sourceOverride.trim().length > 0
      ? options.sourceOverride.trim()
      : undefined

  for (const registration of registry.enabled(sourceOverride)) {
    if (options.signal?.aborted) throw abortReason(options.signal)

    const providerId = registration.provider.id
    if (excludedProviderIds.has(providerId)) continue
    const eligible = isProviderEligible(registration.provider, track)
    if (!eligible) {
      emitAttempt(
        attempts,
        { providerId, ok: false, code: 'not_mapped', latencyMs: 0 },
        options.onAttempt,
      )
      continue
    }

    const resolved = await resolveProvider(track, registration, options.signal)
    if (resolved.playable) {
      emitAttempt(
        attempts,
        { providerId, ok: true, latencyMs: resolved.latencyMs },
        options.onAttempt,
      )
      return { ok: true, providerId, playable: resolved.playable, attempts }
    }

    emitAttempt(
      attempts,
      {
        providerId,
        ok: false,
        code: resolved.code ?? 'unavailable',
        latencyMs: resolved.latencyMs,
      },
      options.onAttempt,
    )
  }

  return { ok: false, code: 'exhausted', attempts }
}
