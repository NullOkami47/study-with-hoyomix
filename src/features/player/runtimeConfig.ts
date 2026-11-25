import { createGdStudioProvider } from './providers/gdStudio'
import { createChkszProvider } from './providers/chksz'
import { createLxUserProvider } from './providers/lxUser'
import { ProviderRegistry, type ProviderRegistration } from './providers/registry'
import type { AudioProvider } from './providers/types'
import {
  getDefaultGlobalSourceRepository,
  type LxGlobalSourceRepository,
} from './lx/globalSourceRepository'
import {
  getDefaultChkszCredentialStore,
  type ChkszCredentialStore,
} from './chkszCredentialStore'
import {
  getDefaultProviderPreferencesStore,
  RETIRED_PROVIDER_IDS,
  type ProviderPreferencesStore,
} from './providerPreferences'
import {
  getDefaultPlaybackQualityPreferencesStore,
  type PlaybackQualityPreferencesStore,
} from './qualityPreferences'

import { LX_INIT_TIMEOUT_MS, LX_RESOLVE_TIMEOUT_MS, LX_RPC_GRACE_MS } from './lx/runtime/protocol'
import { MEDIA_PROBE_TIMEOUT_MS } from './mediaProbe'
import { recordPlayback } from './playbackLog'
import { ProviderConfigurationUnavailableError } from './providerConfigFailure'

const CONFIG_ENDPOINT = '/api/providers/config'
const TTL_MS = 5_000
// Playback-only lease, measured from validation, never extended by a failed request.
// Settings/administrative consumers require fresh data. Playback may also use this lease
// while a routine refresh is pending; explicit refresh and known revocation take priority.
const STALE_IF_ERROR_MS = 120_000
const CONFIG_TIMEOUT_MS = 4_000
const CONFIG_RETRY_DELAYS_MS = [1_000, 3_000, 9_000, 30_000] as const
const PROVIDER_TIMEOUT_MS = 4_000
// LX loads a sandbox, resolves through third-party endpoints, then may probe media. A single
// 4 s registry deadline cancelled healthy mobile requests before those bounded phases finished.
const LX_PROVIDER_TIMEOUT_MS = LX_INIT_TIMEOUT_MS + LX_RESOLVE_TIMEOUT_MS + MEDIA_PROBE_TIMEOUT_MS + LX_RPC_GRACE_MS

export const CANONICAL_PROVIDER_IDS = ['chksz', 'lx', 'gd-studio'] as const
export type CanonicalProviderId = typeof CANONICAL_PROVIDER_IDS[number]

interface PublicProviderConfig {
  available: boolean
  enabled: boolean
  automaticEligible: boolean
  id: CanonicalProviderId
  priority: number
  userKeySupported?: true
  ownerFallbackAvailable?: boolean
}

export type RuntimeProviderPreferences =
  Pick<ProviderPreferencesStore, 'isDisabled' | 'revision'>

export interface RuntimeProviderRepositoryOptions {
  fetch?: typeof fetch
  now?: () => number
  chkszCredentials?: Pick<ChkszCredentialStore, 'key' | 'revision'>
  providerPreferences?: RuntimeProviderPreferences
  lxProviderFactory?: () => AudioProvider
  /**
   * The published global LX sources. Defaults to the page-wide repository; tests inject a fixture
   * so they can describe a deployment with sources, or with none.
   */
  globalSourceRepository?: LxGlobalSourceRepository
  qualityStore?: Pick<PlaybackQualityPreferencesStore, 'chkszQuality'> & Partial<Pick<PlaybackQualityPreferencesStore, 'gdStudioQuality'>>
}

export interface RuntimeProviderLoadOptions {
  forceRefresh?: boolean
}

/**
 * The non-sensitive per-provider server state Settings needs to describe a
 * source truthfully. It never carries credentials, endpoints, or health detail.
 */
export interface PublicProviderState {
  id: CanonicalProviderId
  available: boolean
  enabled: boolean
  automaticEligible: boolean
  priority: number
}

export interface RuntimeProviderRepository {
  load(options?: RuntimeProviderLoadOptions): Promise<ProviderRegistry>
  /** Current, unexpired configuration only; never fetches or rebuilds. */
  peek(): ProviderRegistry | undefined
  /** Bounded playback lease with current local permissions and advisory refresh. */
  loadPlayback(options?: RuntimeProviderLoadOptions): Promise<ProviderRegistry>
  /** Synchronous playback adoption check; never starts a network request. */
  peekPlayback(): ProviderRegistry | undefined
  prefetch(): Promise<void>
  states(options?: RuntimeProviderLoadOptions): Promise<readonly PublicProviderState[]>
  /** Subscribe to authoritative public state only after configuration validation completes. */
  subscribeStates(listener: (states: readonly PublicProviderState[]) => void): () => void
}

/**
 * The single definition of "this provider row is effective". Both the registry
 * builder below and every UI surface that hides or shows provider controls read
 * it, so a control can never be visible for a provider playback would skip.
 */
function isEnabledRow(row: { available: boolean; enabled: boolean }): boolean {
  return row.available && row.enabled
}

/**
 * Authoritative, fail-closed "this provider is usable" predicate derived solely
 * from the public `GET /api/providers/config` state.
 *
 * It deliberately reads the server row and nothing else. A stored user
 * preference, a previously imported script, or a stale cache cannot make it
 * return true: an absent row (configuration could not be loaded), an
 * unavailable deployment, and an Admin-disabled provider all read as false.
 * Callers that hide a control on `false` therefore fail closed by construction.
 */
export function isProviderEnabled(
  states: readonly { id: CanonicalProviderId; available: boolean; enabled: boolean }[],
  id: CanonicalProviderId,
): boolean {
  const state = states.find((value) => value.id === id)
  return state !== undefined && isEnabledRow(state)
}

const providerIds = new Set<string>(CANONICAL_PROVIDER_IDS)

/**
 * A row for a retired provider is ignored rather than treated as a malformed
 * response. This keeps a same-window deployment skew (an older Worker still
 * advertising `vkeys`) from blanking every supported provider, while a retired
 * id can never become selectable: it is removed before provider validation.
 * The set lives with the preference contract so both remote readers agree.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function currentProviderRows(values: readonly unknown[]): unknown[] {
  return values.filter((value) =>
    !(isRecord(value) && typeof value.id === 'string' && RETIRED_PROVIDER_IDS.has(value.id)))
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
}

function parseProvider(value: unknown): PublicProviderConfig {
  if (!isRecord(value) || !hasExactKeys(
    value,
    ['id', 'available', 'enabled', 'automaticEligible', 'priority'],
    ['config', 'userKeySupported', 'ownerFallbackAvailable'],
  )) {
    throw new Error('Invalid provider configuration')
  }
  if (
    typeof value.id !== 'string' || !providerIds.has(value.id) ||
    typeof value.available !== 'boolean' || typeof value.enabled !== 'boolean' ||
    typeof value.automaticEligible !== 'boolean' ||
    !Number.isInteger(value.priority) || (value.priority as number) < 0 || (value.priority as number) > 1_000
  ) {
    throw new Error('Invalid provider configuration')
  }

  const id = value.id as CanonicalProviderId
  if (value.config !== undefined) {
    throw new Error('Unsupported provider public configuration')
  }
  if (id === 'chksz') {
    if (value.userKeySupported !== true || typeof value.ownerFallbackAvailable !== 'boolean') {
      throw new Error('Invalid ChKSz credential capability')
    }
  } else if (value.userKeySupported !== undefined || value.ownerFallbackAvailable !== undefined) {
    throw new Error('Unsupported provider credential capability')
  }

  return {
    id,
    available: value.available,
    enabled: value.enabled,
    automaticEligible: value.automaticEligible,
    priority: value.priority as number,
    ...(id === 'chksz' ? {
      userKeySupported: true as const,
      ownerFallbackAvailable: value.ownerFallbackAvailable as boolean,
    } : {}),
  }
}

function parseRegistry(
  value: unknown,
  chkszCredentials: Pick<ChkszCredentialStore, 'key'>,
  providerPreferences: RuntimeProviderPreferences,
  lxProviderFactory: () => AudioProvider,
  qualityStore: Pick<PlaybackQualityPreferencesStore, 'chkszQuality'> & Partial<Pick<PlaybackQualityPreferencesStore, 'gdStudioQuality'>>,
): ProviderRegistry {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'providers'])) {
    throw new Error('Invalid runtime provider response')
  }
  if (value.version !== 1 || !Array.isArray(value.providers)) {
    throw new Error('Unsupported runtime provider response')
  }

  const providers = currentProviderRows(value.providers).map(parseProvider)
  const ids = new Set<CanonicalProviderId>()
  const registrations: ProviderRegistration[] = []

  const rawKey = chkszCredentials.key()

  for (const provider of providers) {
    if (ids.has(provider.id)) throw new Error(`Duplicate provider: ${provider.id}`)
    ids.add(provider.id)
    if (!isEnabledRow(provider)) continue
    // A user preference is an exclusion layer only. It is applied after server
    // deployment/Admin state, so it can never resurrect an ineligible provider.
    if (providerPreferences.isDisabled(provider.id)) continue
    if (
      provider.id === 'chksz' &&
      !rawKey &&
      provider.ownerFallbackAvailable !== true
    ) continue

    let audioProvider: AudioProvider | undefined
    if (provider.id === 'chksz') {
      audioProvider = createChkszProvider({
        credentialStore: chkszCredentials,
        qualityStore,
        ownerFallbackAvailable: provider.ownerFallbackAvailable === true,
        dynamicDiscovery: true,
      })
    } else if (provider.id === 'lx') {
      audioProvider = lxProviderFactory()
    } else if (provider.id === 'gd-studio') {
      audioProvider = createGdStudioProvider({
        qualityStore: qualityStore.gdStudioQuality ? { gdStudioQuality: qualityStore.gdStudioQuality } : undefined,
      })
    }
    if (!audioProvider) continue

    registrations.push({
      provider: audioProvider,
      enabled: true,
      automaticEligible: provider.automaticEligible,
      priority: provider.priority,
      timeoutMs: provider.id === 'lx' ? LX_PROVIDER_TIMEOUT_MS : PROVIDER_TIMEOUT_MS,
    })
  }

  return new ProviderRegistry(registrations)
}

function isJsonResponse(response: Response): boolean {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
    'application/json'
}

function hasExpectedFinalUrl(response: Response, requestUrl: string): boolean {
  return !response.redirected && response.url === requestUrl
}

export function createRuntimeProviderRepository(
  options: RuntimeProviderRepositoryOptions = {},
): RuntimeProviderRepository {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const chkszCredentials = options.chkszCredentials ?? getDefaultChkszCredentialStore()
  const providerPreferences = options.providerPreferences ?? getDefaultProviderPreferencesStore()
  // Without this the registry is inert: the provider would never look at a published source, and a
  // source the Owner added would reach nobody. It is resolved lazily by the provider, so an empty
  // (or unreachable) registry costs one cached request per minute and changes nothing else.
  const globalSourceRepository = options.globalSourceRepository ?? getDefaultGlobalSourceRepository()
  const lxProviderFactory = options.lxProviderFactory ?? (() =>
    createLxUserProvider({
      globalSourceRepository,
    }))
  const qualityStore = options.qualityStore ?? getDefaultPlaybackQualityPreferencesStore()
  const requestUrl = new URL(CONFIG_ENDPOINT, window.location.origin).toString()
  let cached:
    | { loadedAt: number; preferenceRevision: number; credentialRevision: number; body: unknown; registry: ProviderRegistry }
    | undefined
  let inFlight: Promise<ProviderRegistry> | undefined
  let inFlightForceRefresh = false
  let transientFailure: { at: number; retryAt: number; count: number; error: ProviderConfigurationUnavailableError } | undefined
  const publicStateListeners = new Set<(states: readonly PublicProviderState[]) => void>()
  let publishedPublicStates: readonly PublicProviderState[] | undefined

  const publicStatesFrom = (body: unknown): readonly PublicProviderState[] => {
    if (!isRecord(body) || !Array.isArray(body.providers)) return []
    try {
      return currentProviderRows(body.providers)
        .map(parseProvider)
        .map(({ id, available, enabled, automaticEligible, priority }) => ({ id, available, enabled, automaticEligible, priority }))
        .sort((left, right) => left.priority - right.priority)
    } catch { return [] }
  }
  const publishPublicStates = (states: readonly PublicProviderState[]): void => {
    publishedPublicStates = states.map(state => ({ ...state }))
    for (const listener of publicStateListeners) {
      try { listener(publishedPublicStates.map(state => ({ ...state }))) } catch { /* Consumers cannot interrupt validation. */ }
    }
  }
  const subscribeStates = (listener: (states: readonly PublicProviderState[]) => void): (() => void) => {
    publicStateListeners.add(listener)
    if (publishedPublicStates !== undefined) {
      try { listener(publishedPublicStates.map(state => ({ ...state }))) } catch { /* Subscribers are isolated. */ }
    }
    return () => publicStateListeners.delete(listener)
  }

  const rebuild = (body: unknown): ProviderRegistry => {
    try {
      return parseRegistry(body, chkszCredentials, providerPreferences, lxProviderFactory, qualityStore)
    } catch {
      return new ProviderRegistry([])
    }
  }

  const currentRegistry = (forceRebuild = false): ProviderRegistry => {
    const revision = providerPreferences.revision()
    const credRevision = chkszCredentials.revision?.() ?? 0
    if (cached && (forceRebuild || revision !== cached.preferenceRevision || credRevision !== cached.credentialRevision)) {
      cached = { ...cached, preferenceRevision: revision, credentialRevision: credRevision, registry: rebuild(cached.body) }
    }
    return cached!.registry
  }

  const staleRegistry = (forceRebuild = false): ProviderRegistry => {
    const age = cached ? now() - cached.loadedAt : -1
    if (!cached || cached.body === undefined || age < 0 || age >= STALE_IF_ERROR_MS) {
      throw transientFailure!.error
    }
    // Reapply live exclusions/credentials even while a shared refresh is failing.
    const registry = currentRegistry(forceRebuild)
    recordPlayback('provider.config.stale', {
      ageMs: age, providers: registry.selectable().length, retry: transientFailure!.count,
      classification: transientFailure!.error.classification, status: transientFailure!.error.status,
    })
    return registry
  }

  const readConfiguration = async (signal: AbortSignal): Promise<unknown> => {
    let response: Response
    try {
      response = await fetchImpl(requestUrl, {
        cache: 'no-store', headers: { accept: 'application/json' }, method: 'GET', redirect: 'manual', signal,
      })
    } catch (error) {
      if (error instanceof TypeError || (error instanceof DOMException && error.name === 'NetworkError')) {
        throw new ProviderConfigurationUnavailableError('network')
      }
      throw error
    }
    // Never classify a wrong-origin/redirected response as an eligible stale fallback.
    if (!hasExpectedFinalUrl(response, requestUrl)) throw new Error('Invalid runtime provider response')
    if (!response.ok) {
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
        throw new ProviderConfigurationUnavailableError('http', response.status)
      }
      throw new Error('Invalid runtime provider response')
    }
    if (!isJsonResponse(response)) throw new Error('Invalid runtime provider response')
    try { return await response.json() } catch (error) {
      if (error instanceof TypeError) throw new ProviderConfigurationUnavailableError('network')
      throw error
    }
  }

  const load = (loadOptions: RuntimeProviderLoadOptions = {}): Promise<ProviderRegistry> => {
    if (inFlight) {
      // A forced read joining a routine refresh still closes the playback snapshot
      // and rebuilds provider instances when the shared validation completes.
      if (loadOptions.forceRefresh) inFlightForceRefresh = true
      return inFlight
    }
    if (transientFailure && now() >= transientFailure.at && now() < transientFailure.retryAt) {
      try { return Promise.resolve(staleRegistry()) } catch (error) { return Promise.reject(error) }
    }
    if (!loadOptions.forceRefresh && !transientFailure && cached && now() >= cached.loadedAt && now() - cached.loadedAt < TTL_MS) {
      // A local preference change or credential change must take effect at this
      // resolution boundary rather than waiting for the unrelated server-config TTL to expire.
      return Promise.resolve(currentRegistry())
    }

    inFlightForceRefresh = Boolean(loadOptions.forceRefresh)
    const request = (async (): Promise<ProviderRegistry> => {
      let registry: ProviderRegistry
      let body: unknown
      const controller = new AbortController()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        body = await Promise.race([
          readConfiguration(controller.signal),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              const error = new ProviderConfigurationUnavailableError('timeout')
              reject(error)
              controller.abort(error)
            }, CONFIG_TIMEOUT_MS)
          }),
        ])
        // A routine TTL refresh of identical configuration must not replace provider instances:
        // next-track preparations compare their verified selection with the current registry.
        // Active-source recovery explicitly forces a rebuild and keeps its fresh-provider contract.
        const unchanged = !inFlightForceRefresh && cached?.body !== undefined &&
          cached.preferenceRevision === providerPreferences.revision() &&
          cached.credentialRevision === (chkszCredentials.revision?.() ?? 0) &&
          JSON.stringify(body) === JSON.stringify(cached.body)
        registry = unchanged ? cached!.registry :
          parseRegistry(body, chkszCredentials, providerPreferences, lxProviderFactory, qualityStore)
        transientFailure = undefined
        recordPlayback('provider.config.validated', { providers: registry.selectable().length, forceRefresh: inFlightForceRefresh })
      } catch (error) {
        if (error instanceof ProviderConfigurationUnavailableError) {
          const count = (transientFailure?.count ?? 0) + 1
          const at = now()
          const delayMs = CONFIG_RETRY_DELAYS_MS[Math.min(count - 1, CONFIG_RETRY_DELAYS_MS.length - 1)]
          transientFailure = { at, retryAt: at + delayMs, count, error }
          recordPlayback('provider.config.failed', {
            classification: error.classification, status: error.status, retry: count, delayMs,
            online: navigator.onLine, visibility: document.visibilityState,
            controller: Boolean(navigator.serviceWorker?.controller),
          })
          publishPublicStates([])
          return staleRegistry(inFlightForceRefresh)
        }
        // Explicit denial, redirects, schema errors and malformed data invalidate the lease.
        transientFailure = undefined
        body = undefined
        registry = new ProviderRegistry([])
        recordPlayback('provider.config.rejected', { classification: 'invalid-or-denied' })
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
      cached = {
        loadedAt: now(),
        preferenceRevision: providerPreferences.revision(),
        credentialRevision: chkszCredentials.revision?.() ?? 0,
        body,
        registry,
      }
      publishPublicStates(publicStatesFrom(body))
      return registry
    })()

    inFlight = request
    const settled = () => {
      if (inFlight === request) {
        inFlight = undefined
        inFlightForceRefresh = false
      }
    }
    void request.then(settled, settled)
    return request
  }

  const prefetch = async (): Promise<void> => {
    try {
      await load()
    } catch {
      // Prefetch is advisory and cannot block local workspace features.
    }
  }

  const states = async (
    loadOptions: RuntimeProviderLoadOptions = {},
  ): Promise<readonly PublicProviderState[]> => {
    try { await load(loadOptions) } catch { return [] }
    if (transientFailure) return []
    return publicStatesFrom(cached?.body)
  }

  const peek = (): ProviderRegistry | undefined => {
    if (inFlight || transientFailure || !cached || cached.body === undefined) return undefined
    const age = now() - cached.loadedAt
    if (age < 0 || age >= TTL_MS || cached.preferenceRevision !== providerPreferences.revision() ||
      cached.credentialRevision !== (chkszCredentials.revision?.() ?? 0)) return undefined
    return cached.registry
  }

  const peekPlayback = (): ProviderRegistry | undefined => {
    if (inFlightForceRefresh || !cached || cached.body === undefined) return undefined
    const age = now() - cached.loadedAt
    if (age < 0 || age >= STALE_IF_ERROR_MS) return undefined
    // Rebuild after a preference/credential revision before a caller can adopt media.
    // The lease clock belongs to server validation and is never renewed here.
    return currentRegistry()
  }

  const loadPlayback = (loadOptions: RuntimeProviderLoadOptions = {}): Promise<ProviderRegistry> => {
    if (loadOptions.forceRefresh) return load(loadOptions)
    const registry = peekPlayback()
    // An empty selection cannot support a handover. Once its normal TTL expires,
    // await the bounded validation so a newly re-enabled provider can start playback.
    if (!registry || registry.selectable().length === 0) return load(loadOptions)
    if (transientFailure || now() - cached!.loadedAt >= TTL_MS) {
      // No timer/retry loop: load coalesces refreshes and enforces retry backoff.
      // Late responses to its 4 s deadline cannot mutate the validated cache.
      void load().catch(() => {})
    }
    return Promise.resolve(registry)
  }

  return { load, peek, loadPlayback, peekPlayback, prefetch, states, subscribeStates }
}
