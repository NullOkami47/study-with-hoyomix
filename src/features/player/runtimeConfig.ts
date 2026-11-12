import { createGdStudioProvider } from './providers/gdStudio'
import { createChkszProvider } from './providers/chksz'
import { createVkeysProvider } from './providers/vkeys'
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
  type ProviderPreferencesStore,
} from './providerPreferences'
import {
  getDefaultPlaybackQualityPreferencesStore,
  type PlaybackQualityPreferencesStore,
} from './qualityPreferences'

import { LX_INIT_TIMEOUT_MS, LX_RESOLVE_TIMEOUT_MS, LX_RPC_GRACE_MS } from './lx/runtime/protocol'
import { MEDIA_PROBE_TIMEOUT_MS } from './mediaProbe'

const CONFIG_ENDPOINT = '/api/providers/config'
const TTL_MS = 5_000
const PROVIDER_TIMEOUT_MS = 4_000
// LX loads a sandbox, resolves through third-party endpoints, then may probe media. A single
// 4 s registry deadline cancelled healthy mobile requests before those bounded phases finished.
const LX_PROVIDER_TIMEOUT_MS = LX_INIT_TIMEOUT_MS + LX_RESOLVE_TIMEOUT_MS + MEDIA_PROBE_TIMEOUT_MS + LX_RPC_GRACE_MS
const VKEYS_TIMEOUT_MS = 10_000

export const CANONICAL_PROVIDER_IDS = ['chksz', 'lx', 'jellyfin', 'gd-studio', 'vkeys'] as const
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
  prefetch(): Promise<void>
  states(options?: RuntimeProviderLoadOptions): Promise<readonly PublicProviderState[]>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

  const providers = value.providers.map(parseProvider)
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
    } else if (provider.id === 'vkeys') {
      audioProvider = createVkeysProvider()
    }
    if (!audioProvider) continue

    registrations.push({
      provider: audioProvider,
      enabled: true,
      automaticEligible: provider.automaticEligible,
      priority: provider.priority,
      timeoutMs: provider.id === 'lx' ? LX_PROVIDER_TIMEOUT_MS :
        provider.id === 'vkeys' ? VKEYS_TIMEOUT_MS : PROVIDER_TIMEOUT_MS,
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
  const now = options.now ?? (() => performance.now())
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

  const rebuild = (body: unknown): ProviderRegistry => {
    try {
      return parseRegistry(body, chkszCredentials, providerPreferences, lxProviderFactory, qualityStore)
    } catch {
      return new ProviderRegistry([])
    }
  }

  const load = (loadOptions: RuntimeProviderLoadOptions = {}): Promise<ProviderRegistry> => {
    if (inFlight) return inFlight
    if (!loadOptions.forceRefresh && cached && now() - cached.loadedAt < TTL_MS) {
      // A local preference change or credential change must take effect at this
      // resolution boundary rather than waiting for the unrelated server-config TTL to expire.
      const revision = providerPreferences.revision()
      const credRevision = chkszCredentials.revision?.() ?? 0
      if (revision === cached.preferenceRevision && credRevision === cached.credentialRevision) {
        return Promise.resolve(cached.registry)
      }
      const registry = rebuild(cached.body)
      cached = { ...cached, preferenceRevision: revision, credentialRevision: credRevision, registry }
      return Promise.resolve(registry)
    }

    const request = (async (): Promise<ProviderRegistry> => {
      let registry: ProviderRegistry
      let body: unknown
      try {
        const response = await fetchImpl(requestUrl, {
          cache: 'no-store',
          headers: { accept: 'application/json' },
          method: 'GET',
          redirect: 'error',
        })
        if (!response.ok || !hasExpectedFinalUrl(response, requestUrl) || !isJsonResponse(response)) {
          throw new Error('Invalid runtime provider response')
        }
        body = await response.json()
        // A routine TTL refresh of identical configuration must not replace provider instances:
        // next-track preparations compare their verified selection with the current registry.
        // Active-source recovery explicitly forces a rebuild and keeps its fresh-provider contract.
        const unchanged = !loadOptions.forceRefresh && cached?.body !== undefined &&
          cached.preferenceRevision === providerPreferences.revision() &&
          cached.credentialRevision === (chkszCredentials.revision?.() ?? 0) &&
          JSON.stringify(body) === JSON.stringify(cached.body)
        registry = unchanged ? cached!.registry :
          parseRegistry(body, chkszCredentials, providerPreferences, lxProviderFactory, qualityStore)
      } catch {
        body = undefined
        registry = new ProviderRegistry([])
      }
      cached = {
        loadedAt: now(),
        preferenceRevision: providerPreferences.revision(),
        credentialRevision: chkszCredentials.revision?.() ?? 0,
        body,
        registry,
      }
      return registry
    })()

    inFlight = request
    void request.finally(() => {
      if (inFlight === request) inFlight = undefined
    })
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
    await load(loadOptions)
    const body = cached?.body
    if (!isRecord(body) || !Array.isArray(body.providers)) return []
    try {
      return body.providers
        .map(parseProvider)
        .map(({
          id,
          available,
          enabled,
          automaticEligible,
          priority,
        }) => ({ id, available, enabled, automaticEligible, priority }))
        .sort((left, right) => left.priority - right.priority)
    } catch {
      return []
    }
  }

  const peek = (): ProviderRegistry | undefined => {
    if (inFlight || !cached || cached.body === undefined) return undefined
    const age = now() - cached.loadedAt
    if (age < 0 || age >= TTL_MS || cached.preferenceRevision !== providerPreferences.revision() ||
      cached.credentialRevision !== (chkszCredentials.revision?.() ?? 0)) return undefined
    return cached.registry
  }

  return { load, peek, prefetch, states }
}
