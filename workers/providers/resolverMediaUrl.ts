const ABSOLUTE_HTTPS_URL = /^https:\/\/([^/?#]+)(?:[/?#]|$)/
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
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

export interface ResolverMediaUrlPolicyOptions {
  configuredOrigin: string
  extraAllowedHostnames?: readonly string[]
}

const isPublicHostname = (hostname: string): boolean => {
  if (
    hostname !== hostname.toLowerCase() || hostname.length > 253 || hostname.endsWith('.') ||
    !hostname.includes('.') || hostname.includes(':') || hostname.startsWith('[') ||
    /^\d+(?:\.\d+){3}$/.test(hostname)
  ) return false
  if (PRIVATE_HOST_SUFFIXES.some((suffix) =>
    hostname === suffix || hostname.endsWith(`.${suffix}`))) return false
  return hostname.split('.').every((label) => DNS_LABEL.test(label))
}

const isGoogleVideoHostname = (hostname: string): boolean =>
  hostname === 'googlevideo.com' || hostname.endsWith('.googlevideo.com')

const createMediaUrlValidator = (
  allowed: ReadonlySet<string>,
  allowGoogleVideo: boolean,
) => {
  const validateAbsolute = (value: string): URL | null => {
    if (/[^\u0021-\u007e]/.test(value) || value.includes('\\')) return null
    const raw = ABSOLUTE_HTTPS_URL.exec(value)
    const authority = raw?.[1]
    if (
      !authority || authority !== authority.toLowerCase() || authority.includes('@') ||
      authority.includes(':') || authority.includes('%')
    ) return null

    try {
      const parsed = new URL(value)
      if (
        parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
        parsed.hash || parsed.hostname !== authority || parsed.host !== authority ||
        !isPublicHostname(parsed.hostname) ||
        (!allowed.has(parsed.hostname) &&
          !(allowGoogleVideo && isGoogleVideoHostname(parsed.hostname)))
      ) return null
      return parsed
    } catch {
      return null
    }
  }

  return (value: unknown, current?: URL): URL | null => {
    if (typeof value !== 'string' || value === '') return null
    if (URL_SCHEME.test(value)) return validateAbsolute(value)
    if (!current || /[^\u0021-\u007e]/.test(value) || value.includes('\\')) return null
    try {
      return validateAbsolute(new URL(value, current).toString())
    } catch {
      return null
    }
  }
}

export const createResolverMediaUrlValidator = (
  options: ResolverMediaUrlPolicyOptions,
) => {
  const configured = new URL(options.configuredOrigin)
  const allowed = new Set([configured.hostname, ...(options.extraAllowedHostnames ?? [])])
  return createMediaUrlValidator(allowed, true)
}

export const createExactMediaUrlValidator = (
  allowedHostnames: readonly string[],
) => createMediaUrlValidator(
  new Set(allowedHostnames.filter((hostname) =>
    hostname === hostname.toLowerCase() && isPublicHostname(hostname))),
  false,
)
