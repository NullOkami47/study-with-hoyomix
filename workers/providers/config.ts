import type { AuthEnv } from '../auth/routes'
import type { D1Database } from '../env'
import { parseJellyfinUserId } from './jellyfin'

export const PLAYBACK_PROVIDER_IDS = ['chksz', 'lx', 'jellyfin'] as const
export type PlaybackProviderId = typeof PLAYBACK_PROVIDER_IDS[number]

export type LegacyProviderId =
  | 'r2' | 'meting'
  | 'lx-huibq' | 'lx-ikun' | 'lx-juhe' | 'lx-qdy'
  | 'lx-flower' | 'lx-lx' | 'lx-grass' | 'lx-sixyin'
  | 'piped' | 'invidious' | 'youtube' | 'qijie' | 'gd-studio'
  | 'lx-huanyin'

export type CanonicalProviderId = PlaybackProviderId | LegacyProviderId

export type AutomaticProviderPolicy = 'direct' | 'never'
export type ImplementedLxProviderId = 'lx-huibq' | 'lx-ikun'

export const IMPLEMENTED_LX_PROVIDER_IDS: readonly ImplementedLxProviderId[] =
  Object.freeze(['lx-huibq', 'lx-ikun'] as const)

export interface ProviderEnv extends AuthEnv {
  R2_BASE_URL?: string
  R2_ALLOWED_HOSTNAMES?: string
  PIPED_API_BASE_URL?: string
  INVIDIOUS_API_BASE_URL?: string
  PIPED_MEDIA_ALLOWED_HOSTNAMES?: string
  INVIDIOUS_MEDIA_ALLOWED_HOSTNAMES?: string
  METING_API_BASE_URL?: string
  METING_MEDIA_ALLOWED_HOSTNAMES?: string
  LX_HUIBQ_API_BASE_URL?: string
  LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES?: string
  LX_HUIBQ_REQUEST_KEY?: string
  LX_IKUN_API_BASE_URL?: string
  LX_IKUN_MEDIA_ALLOWED_HOSTNAMES?: string
  LX_IKUN_REQUEST_KEY?: string
  CHKSZ_API_KEY?: string
  JELLYFIN_BASE_URL?: string
  JELLYFIN_API_TOKEN?: string
  JELLYFIN_USER_ID?: string
  GD_STUDIO_API_BASE_URL?: string
  GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES?: string
  HUANYIN_API_BASE_URL?: string
  HUANYIN_MEDIA_ALLOWED_HOSTNAMES?: string
}

export interface ProviderState {
  id: PlaybackProviderId
  adminEnabled: boolean
  deploymentAvailable: boolean
  effectiveEnabled: boolean
  priority: number
  status: 'unknown' | 'healthy' | 'degraded' | 'unavailable'
  failureClass: string | null
  latencyMs: number | null
  checkedAt: number | null
  updatedAt: number
  automaticPolicy: AutomaticProviderPolicy
  publicConfig?: { baseUrl: string; allowedHostnames: string[] }
}

interface CanonicalProviderDefinition {
  id: PlaybackProviderId
  defaults: { enabled: boolean; priority: number }
  automaticPolicy: AutomaticProviderPolicy
}

interface ProviderHealthRow {
  providerKey: string
  enabled: number
  priority: number
  status: ProviderState['status']
  failureClass: string | null
  latencyMs: number | null
  checkedAt: number | null
  updatedAt: number
}

export const CANONICAL_PROVIDERS: readonly CanonicalProviderDefinition[] = Object.freeze([
  Object.freeze({ id: 'chksz' as const, defaults: Object.freeze({ enabled: true, priority: 10 }), automaticPolicy: 'direct' as const }),
  Object.freeze({ id: 'lx' as const, defaults: Object.freeze({ enabled: true, priority: 20 }), automaticPolicy: 'direct' as const }),
  Object.freeze({ id: 'jellyfin' as const, defaults: Object.freeze({ enabled: true, priority: 30 }), automaticPolicy: 'direct' as const }),
])

const validStatuses = new Set<ProviderState['status']>(['unknown', 'healthy', 'degraded', 'unavailable'])

const PRIVATE_HOST_SUFFIXES = [
  'localhost',
  'local',
  'internal',
  'lan',
  'home',
  'home.arpa',
  'localdomain',
  'intranet',
  'private',
  'corp',
] as const

const isPublicHostname = (hostname: string) => {
  if (
    hostname.length > 253 || hostname.endsWith('.') || !hostname.includes('.') ||
    hostname.includes(':') || hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(hostname)
  ) return false

  if (PRIVATE_HOST_SUFFIXES.some((suffix) =>
    hostname === suffix || hostname.endsWith(`.${suffix}`))) return false

  return hostname.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
}

const parseAllowedHostnames = (value: string | undefined) => {
  if (!value) return null

  const hostnames: string[] = []
  for (const rawHostname of value.split(',')) {
    const hostname = rawHostname.trim().toLowerCase()
    if (!hostname) continue
    try {
      const parsed = new URL(`https://${hostname}`)
      if (
        parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
        parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.hostname !== hostname ||
        !isPublicHostname(parsed.hostname)
      ) return null
      hostnames.push(parsed.hostname)
    } catch {
      return null
    }
  }

  return hostnames.length > 0 ? [...new Set(hostnames)] : null
}

const parseMetingAllowedHostnames = (value: string | undefined) => {
  if (!value) return null

  const hostnames: string[] = []
  for (const rawHostname of value.split(',')) {
    const hostname = rawHostname.trim()
    if (!hostname || hostname !== hostname.toLowerCase() || hostnames.includes(hostname)) return null
    try {
      const parsed = new URL(`https://${hostname}`)
      if (
        parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
        parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.hostname !== hostname ||
        !isPublicHostname(parsed.hostname)
      ) return null
      hostnames.push(parsed.hostname)
    } catch {
      return null
    }
  }

  return hostnames
}

// Narrowed to the two values it reads so the build can derive the CSP media origin from the same
// validation the Worker enforces. A ProviderEnv still satisfies this, so no caller changes.
export const readR2PublicConfig = (env: Pick<ProviderEnv, 'R2_BASE_URL' | 'R2_ALLOWED_HOSTNAMES'>) => {
  if (!env.R2_BASE_URL) return null

  try {
    const parsed = new URL(env.R2_BASE_URL)
    if (
      parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      parsed.search || parsed.hash || !isPublicHostname(parsed.hostname)
    ) return null
    if (!parsed.pathname.endsWith('/')) parsed.pathname = `${parsed.pathname}/`

    const allowedHostnames = parseAllowedHostnames(env.R2_ALLOWED_HOSTNAMES)
    if (!allowedHostnames || !allowedHostnames.includes(parsed.hostname)) return null
    return { baseUrl: parsed.toString(), allowedHostnames }
  } catch {
    return null
  }
}

export const parseConfiguredResolverOrigin = (value: string | undefined): string | null => {
  if (!value) return null

  try {
    const parsed = new URL(value)
    if (
      parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      parsed.pathname !== '/' || parsed.search || parsed.hash || !isPublicHostname(parsed.hostname) ||
      (value !== parsed.origin && value !== `${parsed.origin}/`)
    ) return null
    return parsed.origin
  } catch {
    return null
  }
}

export const configuredResolverOrigin = (
  id: 'piped' | 'invidious',
  env: ProviderEnv,
) => parseConfiguredResolverOrigin(
  id === 'piped' ? env.PIPED_API_BASE_URL : env.INVIDIOUS_API_BASE_URL,
)

export const configuredResolverMediaHostnames = (
  id: 'piped' | 'invidious',
  env: ProviderEnv,
): string[] | null => {
  const origin = configuredResolverOrigin(id, env)
  if (!origin) return null
  const hostname = new URL(origin).hostname
  const raw = id === 'piped'
    ? env.PIPED_MEDIA_ALLOWED_HOSTNAMES
    : env.INVIDIOUS_MEDIA_ALLOWED_HOSTNAMES
  if (raw === undefined || raw.trim() === '') return [hostname]
  const configured = parseAllowedHostnames(raw)
  return configured ? [...new Set([hostname, ...configured])] : null
}

export const configuredMetingOrigin = (env: ProviderEnv) =>
  parseConfiguredResolverOrigin(env.METING_API_BASE_URL)

export const configuredMetingMediaHostnames = (env: ProviderEnv) =>
  parseMetingAllowedHostnames(env.METING_MEDIA_ALLOWED_HOSTNAMES)

const lxConfigValue = (
  id: ImplementedLxProviderId,
  env: ProviderEnv,
  field: 'origin' | 'mediaHostnames' | 'requestKey',
): string | undefined => {
  if (id === 'lx-huibq') {
    if (field === 'origin') return env.LX_HUIBQ_API_BASE_URL
    if (field === 'mediaHostnames') return env.LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES
    return env.LX_HUIBQ_REQUEST_KEY
  }
  if (field === 'origin') return env.LX_IKUN_API_BASE_URL
  if (field === 'mediaHostnames') return env.LX_IKUN_MEDIA_ALLOWED_HOSTNAMES
  return env.LX_IKUN_REQUEST_KEY
}

export const configuredLxOrigin = (id: ImplementedLxProviderId, env: ProviderEnv) =>
  parseConfiguredResolverOrigin(lxConfigValue(id, env, 'origin'))

export const configuredLxMediaHostnames = (
  id: ImplementedLxProviderId,
  env: ProviderEnv,
) => parseMetingAllowedHostnames(lxConfigValue(id, env, 'mediaHostnames'))

export const configuredLxRequestKey = (
  id: ImplementedLxProviderId,
  env: ProviderEnv,
): string | null => {
  const value = lxConfigValue(id, env, 'requestKey')
  return value && /^[\x21-\x7e]{1,256}$/.test(value) ? value : null
}

export const configuredJellyfinOrigin = (env: ProviderEnv): string | null =>
  parseConfiguredResolverOrigin(env.JELLYFIN_BASE_URL)

export const configuredJellyfinApiToken = (env: ProviderEnv): string | null => {
  const value = env.JELLYFIN_API_TOKEN
  return value && /^[\x21-\x7e]{1,256}$/.test(value) ? value : null
}

/**
 * Jellyfin identifies the acting user by GUID. Jellyfin 12 returns HTTP 400 for the single-item
 * metadata route when no user context is supplied, so a user ID is a hard requirement rather
 * than an optional enrichment. It is an identifier, not a credential, so it lives in `[vars]`
 * alongside the base URL rather than in the Worker secret store.
 */
export const configuredJellyfinUserId = (env: ProviderEnv): string | null => {
  const value = env.JELLYFIN_USER_ID
  if (!value) return null
  return parseJellyfinUserId(value)
}

export const configuredGdStudioOrigin = (env: ProviderEnv): string | null =>
  parseConfiguredResolverOrigin(env.GD_STUDIO_API_BASE_URL)

export const configuredGdStudioMediaHostnames = (env: ProviderEnv): string[] | null =>
  parseMetingAllowedHostnames(env.GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES)

export const configuredHuanyinOrigin = (env: ProviderEnv): string | null =>
  parseConfiguredResolverOrigin(env.HUANYIN_API_BASE_URL)

export const configuredHuanyinMediaHostnames = (env: ProviderEnv): string[] | null =>
  parseMetingAllowedHostnames(env.HUANYIN_MEDIA_ALLOWED_HOSTNAMES)

export const deploymentAvailable = (id: CanonicalProviderId, env: ProviderEnv) => {
  switch (id) {
    case 'youtube':
      return true
    case 'r2':
      return readR2PublicConfig(env) !== null
    case 'piped':
      return configuredResolverOrigin(id, env) !== null &&
        configuredResolverMediaHostnames(id, env) !== null
    case 'invidious':
      return configuredResolverOrigin(id, env) !== null &&
        configuredResolverMediaHostnames(id, env) !== null
    case 'chksz':
    case 'lx':
      return true
    case 'meting':
      return configuredMetingOrigin(env) !== null &&
        configuredMetingMediaHostnames(env) !== null
    case 'lx-huibq':
    case 'lx-ikun':
      return configuredLxOrigin(id, env) !== null &&
        configuredLxMediaHostnames(id, env) !== null &&
        configuredLxRequestKey(id, env) !== null
    case 'jellyfin':
      return configuredJellyfinOrigin(env) !== null &&
        configuredJellyfinApiToken(env) !== null &&
        configuredJellyfinUserId(env) !== null
    case 'gd-studio':
      return configuredGdStudioOrigin(env) !== null &&
        configuredGdStudioMediaHostnames(env) !== null
    case 'lx-huanyin':
      return configuredHuanyinOrigin(env) !== null &&
        configuredHuanyinMediaHostnames(env) !== null
    case 'qijie':
    case 'lx-juhe':
    case 'lx-qdy':
    case 'lx-flower':
    case 'lx-lx':
    case 'lx-grass':
    case 'lx-sixyin':
      return false
  }
}

export const deploymentAvailableProviderIds = (env: ProviderEnv) =>
  CANONICAL_PROVIDERS
    .filter(({ id }) => deploymentAvailable(id, env))
    .map(({ id }) => id)

export const readProviderStates = async (db: D1Database, env: ProviderEnv): Promise<ProviderState[]> => {
  const rows = await db.prepare(`
    SELECT
      provider_key AS providerKey,
      enabled,
      priority,
      status,
      failure_class AS failureClass,
      latency_ms AS latencyMs,
      checked_at AS checkedAt,
      updated_at AS updatedAt
    FROM provider_health
  `).all<ProviderHealthRow>()
  const rowsById = new Map(rows.results.map((row) => [row.providerKey, row]))

  return CANONICAL_PROVIDERS.map(({ id, defaults, automaticPolicy }) => {
    const row = rowsById.get(id)
    const adminEnabled = row ? row.enabled === 1 : defaults.enabled
    const available = deploymentAvailable(id, env)
    return {
      id,
      adminEnabled,
      deploymentAvailable: available,
      effectiveEnabled: available && adminEnabled,
      priority: row?.priority ?? defaults.priority,
      status: row && validStatuses.has(row.status) ? row.status : 'unknown',
      failureClass: row?.failureClass ?? null,
      latencyMs: row?.latencyMs ?? null,
      checkedAt: row?.checkedAt ?? null,
      updatedAt: row?.updatedAt ?? 0,
      automaticPolicy,
    }
  })
}
