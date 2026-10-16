import { allowsConfiguredSources } from '../thirdPartyConsent'
import {
  CHKSZ_KEY_MAX_LENGTH,
  CHKSZ_LEVEL,
  CHKSZ_MAX_RESPONSE_BYTES,
  CHKSZ_MUSIC_ENDPOINT,
  chkszFailureCode,
  chkszLevel,
  createChkszArtworkProxyUrl,
  isChkszApiKey,
  isChkszExternalId,
  validateChkszMetadata,
  validateChkszPlaybackMetadata,
} from '../../../shared/chksz'
import { isChkszDenied } from '../../../shared/chkszDiscovery'
import type { Track, TrackSource } from '../../catalog/types'
import type { ChkszCredentialStore } from '../chkszCredentialStore'
import type { PlaybackQualityPreferencesStore } from '../qualityPreferences'
import { createServerProxyProvider } from './proxy'
import {
  ProviderResolveError,
  type AudioProvider,
  type AudioQualityMetadata,
  type Playable,
} from './types'

/**
 * The repository's established direct-audio convention for ChKSz. The upstream API does not
 * return a trustworthy MIME, so the type is declared rather than inferred from a filename.
 */
const CHKSZ_AUDIO_MIME_TYPE = 'audio/mpeg'

export interface ChkszProviderOptions {
  credentialStore?: Pick<ChkszCredentialStore, 'key'>
  qualityStore?: Pick<PlaybackQualityPreferencesStore, 'chkszQuality'>
  /** Whether the deployment has an owner key plus owner fallback enabled. */
  ownerFallbackAvailable?: boolean
  fetch?: typeof fetch
  /** Whether dynamic catalogue-wide discovery is enabled. */
  dynamicDiscovery?: boolean
  /** Optional override for discovery endpoint URL. */
  discoverEndpoint?: string
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Provider request aborted', 'AbortError')
}

function isAbort(signal: AbortSignal, error: unknown): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
}

function findSource(track: Track, providerId: string): TrackSource | undefined {
  return track.sources.find((source) => source.provider === providerId)
}

/**
 * Bounded, MIME-checked JSON read. The HTTP status is always evaluated before the body is
 * trusted, so a 402 is never reported as a malformed response.
 */
async function readBoundedJson(
  response: Response,
  maximum: number,
  signal: AbortSignal,
): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new ProviderResolveError('invalid_response')

  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
      throw new ProviderResolveError('invalid_response')
    }
  }

  const reader = response.body?.getReader()
  if (!reader) throw new ProviderResolveError('invalid_response')

  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maximum) {
        await reader.cancel()
        throw new ProviderResolveError('invalid_response')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof ProviderResolveError) throw error
    if (isAbort(signal, error)) throw abortReason(signal)
    throw new ProviderResolveError('invalid_response')
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new ProviderResolveError('invalid_response')
  }
}

/**
 * Direct browser resolution. The user's key travels only to api.chksz.com, never to this
 * application's backend for this direct playback path. Dynamic discovery below
 * separately sends the key to the site's Worker. Never include it in logs or error copy.
 */
async function resolveClientDirect(
  source: TrackSource,
  userKey: string,
  level: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Playable> {
  const requestUrl = new URL(CHKSZ_MUSIC_ENDPOINT)
  requestUrl.search = new URLSearchParams({
    id: source.externalId,
    level,
    type: 'json',
    apikey: userKey,
  }).toString()

  let response: Response
  try {
    response = await fetchImpl(requestUrl.toString(), {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    if (isAbort(signal, error)) throw abortReason(signal)
    throw new ProviderResolveError('unavailable')
  }

  // Status first: a 402 must never be reported as a malformed body.
  const failure = chkszFailureCode(response.status)
  if (failure) throw new ProviderResolveError(failure)

  const body = await readBoundedJson(response, CHKSZ_MAX_RESPONSE_BYTES, signal)
  const playbackMetadata = validateChkszPlaybackMetadata(body, source.externalId, level)
  if (!playbackMetadata) throw new ProviderResolveError('invalid_response')

  const quality: AudioQualityMetadata = {
    ...(playbackMetadata.level ? { tier: playbackMetadata.level } : {}),
    ...(typeof playbackMetadata.bitrate === 'number' && playbackMetadata.bitrate > 0
      ? { bitrate: playbackMetadata.bitrate }
      : {}),
  }
  const hasQuality = Object.keys(quality).length > 0
  const artworkUrl = playbackMetadata.artworkUrl
    ? createChkszArtworkProxyUrl(playbackMetadata.artworkUrl) ?? undefined
    : undefined

  return {
    kind: 'audio',
    url: playbackMetadata.mediaUrl.toString(),
    mimeType: CHKSZ_AUDIO_MIME_TYPE,
    ...(hasQuality || artworkUrl ? {
      metadata: {
        ...(hasQuality ? { quality } : {}),
        ...(artworkUrl ? { artworkUrl } : {}),
      },
    } : {}),
  }
}

function getDiscoverEndpoint(endpointOverride?: string): string {
  if (endpointOverride) return endpointOverride
  try {
    if (typeof globalThis.location?.origin === 'string') {
      const origin = new URL(globalThis.location.origin)
      return new URL('/api/providers/chksz/discover', origin).toString()
    }
  } catch {}
  return '/api/providers/chksz/discover'
}

async function discoverChkszTrackClient(
  track: Track,
  userKey: string | null,
  endpoint: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  }
  if (userKey) {
    headers['x-chksz-api-key'] = userKey
  }

  const rawAliases = track.aliases ? Object.values(track.aliases).flat() : []
  const body = JSON.stringify({
    trackId: track.id,
    metadata: {
      title: track.title,
      vocalStatus: track.vocalStatus,
      aliases: rawAliases,
    },
  })

  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      cache: 'no-store',
      headers,
      body,
      signal,
    })
  } catch (error) {
    if (isAbort(signal, error)) throw abortReason(signal)
    throw new ProviderResolveError('unavailable')
  }

  if (response.status === 429) {
    throw new ProviderResolveError('rate_limited')
  }
  if (response.status === 401 || response.status === 400) {
    let errorCode: string | null = null
    try {
      const errBody = (await readBoundedJson(response, 1024, signal)) as Record<string, unknown>
      errorCode = typeof errBody?.error === 'string' ? errBody.error : null
    } catch {}
    if (errorCode === 'invalid_credential') throw new ProviderResolveError('invalid_credential')
    if (errorCode === 'credential_required') throw new ProviderResolveError('credential_required')
    throw new ProviderResolveError('unavailable')
  }
  if (response.status === 403) {
    throw new ProviderResolveError('unavailable')
  }
  if (!response.ok) {
    throw new ProviderResolveError('unavailable')
  }

  const data = (await readBoundedJson(response, 4096, signal)) as Record<string, unknown>
  if (data?.ok === true && typeof data?.externalId === 'string' && isChkszExternalId(data.externalId)) {
    const denyCheck = isChkszDenied(track.id, data.externalId)
    if (denyCheck.blocked) {
      throw new ProviderResolveError('unavailable')
    }
    return data.externalId
  }

  throw new ProviderResolveError('invalid_response')
}

/**
 * Hybrid ChKSz provider.
 *
 * - a user key exists  -> resolve directly against api.chksz.com from the browser
 * - no user key, owner fallback available -> the existing Worker resolver path
 * - neither -> credential_required, and the registry does not register the provider
 *
 * The provider id is always the canonical `chksz`.
 */
export function createChkszProvider(options: ChkszProviderOptions = {}): AudioProvider {
  const credentialStore = options.credentialStore
  const qualityStore = options.qualityStore ?? { chkszQuality: () => 'standard' }
  const fetchImpl = options.fetch ?? fetch
  const ownerFallbackAvailable = options.ownerFallbackAvailable === true
  const dynamicDiscovery = options.dynamicDiscovery === true

  // The fallback deliberately carries no request headers: with a user key present this path
  // is unreachable, and with no user key there is nothing to send. Structurally, the user's
  // key can never reach /api/providers/chksz/resolve.
  //
  // The selected level is resolved lazily at request time rather than captured here, so a
  // preference changed between construction and playback is still honoured, and so the
  // user-key path does not read or depend on the preference store.
  //
  // Constructed lazily: building it eagerly would resolve the application origin up front and
  // could throw before the direct path (which needs no fallback at all) ever runs.
  let serverFallback: AudioProvider | undefined
  const getServerFallback = (): AudioProvider => {
    serverFallback ??= createServerProxyProvider('chksz', 'chksz', {
      fetch: options.fetch,
      validateExternalId: (value) => isChkszExternalId(value),
      // The Worker validates this against the same seven-level set. The LX preference is a
      // different axis and is never consulted here.
      requestBody: () => ({ level: chkszLevel(qualityStore.chkszQuality()) }),
    })
    return serverFallback
  }

  return {
    id: 'chksz',
    canResolve(track: Track): boolean {
      const source = findSource(track, 'chksz')
      if (source) {
        if (!isChkszExternalId(source.externalId)) return false
        return !isChkszDenied(track.id, source.externalId).blocked
      }

      if (!dynamicDiscovery || track.id.startsWith('sample-')) return false

      const hasCredentials = ((allowsConfiguredSources() ? credentialStore?.key() : null) != null) || ownerFallbackAvailable
      if (!hasCredentials) return false

      return !isChkszDenied(track.id, null).blocked
    },
    async resolve(track: Track, signal: AbortSignal): Promise<Playable | null> {
      if (signal.aborted) throw abortReason(signal)
      if (!allowsConfiguredSources() && !ownerFallbackAvailable) return null

      // 1. Static binding takes absolute precedence if present
      const source = findSource(track, 'chksz')
      if (source) {
        if (!isChkszExternalId(source.externalId)) {
          throw new ProviderResolveError('invalid_response')
        }
        const deny = isChkszDenied(track.id, source.externalId)
        if (deny.blocked) {
          throw new ProviderResolveError('unavailable')
        }

        const candidate = (allowsConfiguredSources() ? credentialStore?.key() : null) ?? null
        if (candidate !== null) {
          // A stored key that no longer satisfies the contract is rejected locally rather than
          // being sent upstream or silently altered.
          if (candidate.length > CHKSZ_KEY_MAX_LENGTH || !isChkszApiKey(candidate)) {
            throw new ProviderResolveError('invalid_credential')
          }
          const quality = qualityStore.chkszQuality()
          const level = chkszLevel(quality)
          return resolveClientDirect(source, candidate, level, signal, fetchImpl)
        }

        if (ownerFallbackAvailable) return getServerFallback().resolve(track, signal)
        throw new ProviderResolveError('credential_required')
      }

      // 2. If dynamic discovery is not enabled or this is a demo sample track, return null when no static ChKSz source exists
      if (!dynamicDiscovery || track.id.startsWith('sample-')) return null

      // 3. Dynamic discovery path
      const candidate = (allowsConfiguredSources() ? credentialStore?.key() : null) ?? null
      let userKey: string | null = null
      if (candidate !== null) {
        if (candidate.length > CHKSZ_KEY_MAX_LENGTH || !isChkszApiKey(candidate)) {
          throw new ProviderResolveError('invalid_credential')
        }
        userKey = candidate
      } else if (!ownerFallbackAvailable) {
        throw new ProviderResolveError('credential_required')
      }

      const trackDeny = isChkszDenied(track.id, null)
      if (trackDeny.blocked) {
        throw new ProviderResolveError('unavailable')
      }

      const discoverUrl = getDiscoverEndpoint(options.discoverEndpoint)
      const externalId = await discoverChkszTrackClient(track, userKey, discoverUrl, signal, fetchImpl)

      const discoveredSource: TrackSource = {
        provider: 'chksz',
        externalId,
      }

      if (userKey !== null) {
        const quality = qualityStore.chkszQuality()
        const level = chkszLevel(quality)
        return resolveClientDirect(discoveredSource, userKey, level, signal, fetchImpl)
      }

      if (ownerFallbackAvailable) {
        const syntheticTrack: Track = {
          ...track,
          sources: [...track.sources.filter((s) => s.provider !== 'chksz'), discoveredSource],
        }
        return getServerFallback().resolve(syntheticTrack, signal)
      }

      throw new ProviderResolveError('credential_required')
    },
  }
}
