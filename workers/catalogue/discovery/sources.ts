import {
  buildNeteaseSearchUrl,
  parseNeteaseSearch,
  NETEASE_HOYOMIX_ARTIST_ID,
} from '../../../src/shared/neteaseSearch'
import {
  classifyCandidates,
  normalizeTitle,
  type ChkszCandidateInput,
} from '../../../src/shared/chkszMatcher'
import { sameVersionFamily } from '../../../src/shared/versionSignature'
import { isChkszDenied } from '../../../src/shared/chkszDiscovery'
import { createProviderHandler } from '../../providers/routes'
import {
  readProviderStates,
  configuredGdStudioOrigin,
  configuredMetingOrigin,
  deploymentAvailable,
  type ProviderEnv,
} from '../../providers/config'
import { readChkszOwnerFallbackEnabled } from '../../providers/chkszCredentials'
import {
  executeChkszAdminSearch,
  chkszAdminSearchRateLimiter,
} from '../../providers/chkszSearchProxy'
import { readBoundedJsonResponse } from '../../providers/boundedJson'
import { validSourceId } from '../validation'
import type { DiscoveryCandidate, SourceCheck } from './types'
/** Compare decimal identities without rounding long strings or rewriting provider bindings. */
function neteaseDecimalKey(value: unknown): string | null {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value)) return null
  return value.replace(/^0+/, '') || null
}

/** Absence/outage is not denial. Only complete numeric artist credits can contradict authority. */
function deniedNeteaseIds(value: unknown): Set<string> {
  const denied = new Set<string>()
  if (!value || typeof value !== 'object') return denied
  const response = value as Record<string, unknown>
  if (response.code !== 200 || !response.result || typeof response.result !== 'object') return denied
  const songs = (response.result as Record<string, unknown>).songs
  if (!Array.isArray(songs)) return denied
  for (const song of songs.slice(0, 10)) {
    if (!song || typeof song !== 'object') continue
    const id = neteaseDecimalKey(song.id)
    if (id === null) continue
    const credits = Array.isArray(song.artists) ? song.artists : Array.isArray(song.ar) ? song.ar : []
    if (credits.length && credits.every((artist: unknown) => artist && typeof artist === 'object' &&
      Number.isSafeInteger((artist as Record<string, unknown>).id) && Number((artist as Record<string, unknown>).id) > 0) &&
      !credits.some((artist: { id: number }) => artist.id === NETEASE_HOYOMIX_ARTIST_ID))
      denied.add(id)
  }
  return denied
}
interface Options {
  fetch?: typeof fetch
  now?: () => number
  cache?: Pick<Cache, 'match' | 'put'>
}
export async function checkDiscoverySources(
  c: DiscoveryCandidate,
  env: ProviderEnv,
  request: Request,
  actor: string,
  options: Options = {},
): Promise<SourceCheck[]> {
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const results: SourceCheck[] = []
  let deniedIds = new Set<string>()
  const isOfficiallyDenied = (id: unknown) => {
    const key = neteaseDecimalKey(id)
    return key !== null && deniedIds.has(key)
  }
  const add = (
    provider: string,
    externalId: string,
    status: SourceCheck['status'],
    reason: string,
    confidence = 0,
  ) =>
    results.push({
      provider,
      externalId,
      status,
      reason,
      confidence,
      checkedAt: now(),
    })
  const get = async (url: URL): Promise<{ status: number; value: unknown }> => {
    try {
      const r = await fetcher(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) {
        await r.body?.cancel()
        return { status: r.status, value: null }
      }
      const b = await readBoundedJsonResponse(r, 128 * 1024)
      return { status: b.ok ? 200 : 502, value: b.ok ? b.value : null }
    } catch {
      return { status: 502, value: null }
    }
  }
  // Official video IDs are checked using the embeddability metadata endpoint; no stream extraction.
  const yt = new URL('https://www.youtube.com/oembed')
  yt.searchParams.set(
    'url',
    'https://www.youtube.com/watch?v=' + c.discovery.videoId,
  )
  yt.searchParams.set('format', 'json')
  const youtube = await get(yt)
  const y = youtube.value as Record<string, unknown> | null
  if (youtube.status === 429)
    add('youtube', c.discovery.videoId, 'rate_limited', 'quota_exceeded')
  else if (youtube.status !== 200 || !y || typeof y.title !== 'string')
    add('youtube', c.discovery.videoId, 'unavailable', 'not_embeddable')
  else if (
    normalizeTitle(y.title) !== normalizeTitle(c.discovery.title) ||
    !sameVersionFamily(y.title, c.discovery.title)
  )
    add(
      'youtube',
      c.discovery.videoId,
      'invalid',
      'recording_identity_mismatch',
    )
  else if (
    y.author_url !==
      'https://www.youtube.com/channel/' + c.discovery.artistChannelId &&
    y.author_url !==
      'https://www.youtube.com/channel/' + c.discovery.artistChannelId + '/'
  )
    add(
      'youtube',
      c.discovery.videoId,
      'unverified',
      'official_channel_identity_required',
    )
  else
    add('youtube', c.discovery.videoId, 'valid', 'official_video_embeddable', 1)
  const states = await readProviderStates(env.DB, env)
  const enabled = (id: string) =>
    states.find((s) => s.id === id)?.effectiveEnabled === true
  const canonical = {
    track_id: c.trackId,
    title: c.discovery.title,
    album: c.suggestion.album,
    vocal_status: c.suggestion.vocal_status,
    duration_s: c.discovery.durationSeconds,
    aliases: Object.values(c.suggestion.aliases).flat(),
  }
  const boundedFetch: typeof fetch = (input, init) =>
    fetcher(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(8000),
    })
  const resolver = createProviderHandler(env, {
    fetch: boundedFetch,
    now,
    cache: options.cache,
  })
  const verify = async (provider: string, externalId: string) => {
    const platformId = provider === 'chksz' ? externalId : /^(?:netease|wy):([0-9]{1,20})(?::|$)/.exec(externalId)?.[1]
    if (isOfficiallyDenied(platformId)) {
      add(provider, externalId, 'invalid', 'official_artist_identity_mismatch')
      return
    }
    if (
      !validSourceId(provider, externalId) ||
      (provider === 'chksz' && isChkszDenied(c.trackId, externalId).blocked)
    ) {
      add(provider, externalId, 'invalid', 'source_policy_rejected')
      return
    }
    const headers = new Headers({
      'content-type': 'application/json',
      origin: new URL(env.PUBLIC_ORIGIN).origin,
    })
    const cookie = request.headers.get('cookie')
    if (cookie) headers.set('cookie', cookie)
    try {
      const response = await resolver.fetch(
        new Request(
          new URL('/api/providers/' + provider + '/resolve', env.PUBLIC_ORIGIN),
          { method: 'POST', headers, body: JSON.stringify({ externalId }) },
        ),
      )
      if (!response.ok) {
        await response.body?.cancel()
        add(
          provider,
          externalId,
          response.status === 429
            ? 'rate_limited'
            : response.status === 401 || response.status === 403
              ? 'permission_required'
              : 'unavailable',
          'resolver_rejected',
        )
        return
      }
      const parsed = await readBoundedJsonResponse(response, 64 * 1024)
      const value = parsed.ok ? (parsed.value as Record<string, unknown>) : null
      if (!value || typeof value.url !== 'string') {
        add(provider, externalId, 'invalid', 'resolver_invalid')
        return
      }
      const url = new URL(value.url, env.PUBLIC_ORIGIN)
      if (
        url.origin !== new URL(env.PUBLIC_ORIGIN).origin ||
        !url.pathname.startsWith('/api/providers/' + provider + '/media/')
      ) {
        add(provider, externalId, 'invalid', 'resolver_media_policy')
        return
      }
      const media = await resolver.fetch(
        new Request(url, { headers: { range: 'bytes=0-1023' } }),
      )
      const type = media.headers.get('content-type') ?? ''
      const ok =
        (media.status === 200 || media.status === 206) &&
        type.startsWith('audio/')
      await media.body?.cancel()
      add(
        provider,
        externalId,
        ok ? 'valid' : 'unavailable',
        ok ? 'resolver_audio_probe' : 'media_probe_failed',
        ok ? 0.95 : 0,
      )
    } catch {
      add(provider, externalId, 'unavailable', 'resolver_unavailable')
    }
  }
  let netease: string | null = null
  const neteaseSearch = await get(buildNeteaseSearchUrl(c.discovery.title))
  if (neteaseSearch.status !== 200)
    add(
      'netease',
      '',
      neteaseSearch.status === 429 ? 'rate_limited' : 'unavailable',
      'public_search_unavailable',
    )
  else {
    deniedIds = deniedNeteaseIds(neteaseSearch.value)
    const candidates = parseNeteaseSearch(neteaseSearch.value)
    if (candidates === null)
      add('netease', '', 'unverified', 'invalid_search_metadata')
    else {
      const matched = classifyCandidates(canonical, candidates.filter((item) => !isOfficiallyDenied(item.id)))
      netease = matched.accepted_external_id
      add(
        'netease',
        netease ?? '',
        'unverified',
        netease
          ? 'official_metadata_only'
          : 'identity_' + matched.confidence.toLowerCase(),
        netease ? 0.95 : 0,
      )
    }
  }

  if (enabled('gd-studio') && configuredGdStudioOrigin(env) && netease) {
    await verify('gd-studio', 'netease:' + netease)
  } else if (enabled('gd-studio') && configuredGdStudioOrigin(env)) {
    const url = new URL('/api.php', configuredGdStudioOrigin(env)!)
    url.search = new URLSearchParams({
      types: 'search',
      source: 'netease',
      name: c.discovery.title,
      count: '10',
      pages: '1',
    }).toString()
    const r = await get(url)
    if (r.status !== 200)
      add(
        'gd-studio',
        '',
        r.status === 429 ? 'rate_limited' : 'unavailable',
        'search_unavailable',
      )
    else {
      const a = Array.isArray(r.value) ? r.value : []
      const candidates: ChkszCandidateInput[] = a
        .filter(
          (v) =>
            v &&
            typeof v === 'object' &&
            typeof v.id === 'string' &&
            /^[0-9]{1,20}$/.test(v.id) &&
            typeof v.name === 'string',
        )
        .map((v) => ({
          id: v.id,
          name: v.name,
          artists: Array.isArray(v.artist)
            ? v.artist.join(', ')
            : String(v.artist ?? ''),
          album: typeof v.album === 'string' ? v.album : '',
          durationMs: typeof v.duration === 'number' ? v.duration * 1000 : null,
        }))
      const match = classifyCandidates(canonical, candidates.filter((item) => !isOfficiallyDenied(item.id)))
      if (match.accepted_external_id) {
        netease = match.accepted_external_id
        await verify('gd-studio', 'netease:' + netease)
      } else
        add(
          'gd-studio',
          '',
          'unverified',
          'identity_' + match.confidence.toLowerCase(),
        )
    }
  } else
    add(
      'gd-studio',
      '',
      'permission_required',
      'provider_not_configured_or_disabled',
    )
  if (
    enabled('chksz') &&
    env.CHKSZ_API_KEY &&
    (await readChkszOwnerFallbackEnabled(env.DB))
  ) {
    const r = await executeChkszAdminSearch(
      actor,
      { keyword: c.discovery.title.slice(0, 80), limit: 10, offset: 0 },
      env.CHKSZ_API_KEY,
      {
        fetch: fetcher,
        now,
        limiter: chkszAdminSearchRateLimiter(env.AUTH_START_LIMITER),
      },
    )
    const a = Array.isArray(r.body.candidates)
      ? (r.body.candidates as ChkszCandidateInput[])
      : []
    if (r.status !== 200)
      add(
        'chksz',
        '',
        r.status === 429 ? 'rate_limited' : 'unavailable',
        'search_unavailable',
      )
    else {
      const match = classifyCandidates(canonical, a.filter((item) => !isOfficiallyDenied(item.id)))
      if (match.accepted_external_id) {
        netease ??= match.accepted_external_id
        await verify('chksz', match.accepted_external_id)
      } else
        add(
          'chksz',
          '',
          'unverified',
          'identity_' + match.confidence.toLowerCase(),
        )
    }
  } else
    add('chksz', '', 'permission_required', 'owner_fallback_not_authorised')
  for (const provider of ['meting', 'lx-huibq', 'lx-ikun']) {
    const on =
      provider === 'meting'
        ? !!configuredMetingOrigin(env)
        : enabled('lx') &&
          deploymentAvailable(provider as 'lx-huibq' | 'lx-ikun', env)
    if (!on)
      add(
        provider,
        '',
        'permission_required',
        'resolver_not_configured_or_disabled',
      )
    else if (!netease)
      add(provider, '', 'unverified', 'verified_platform_identity_required')
    else
      await verify(
        provider,
        provider === 'meting'
          ? 'netease:' + netease
          : 'wy:' + netease + ':320k',
      )
  }
  return results
}
