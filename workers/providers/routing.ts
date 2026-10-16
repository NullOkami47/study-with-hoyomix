import type { ProviderState } from './config'
import { isAuthenticatedProxyRequest } from '../proxyIngress'

interface CloudflareRequest extends Request {
  readonly cf?: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const cloudflareCountry = (request: Request): string | undefined => {
  // Cloudflare sees the Vercel egress country, not the browser's country.
  if (isAuthenticatedProxyRequest(request)) return undefined
  try {
    const cf = (request as CloudflareRequest).cf
    if (!isRecord(cf)) return undefined
    return typeof cf.country === 'string' ? cf.country : undefined
  } catch {
    return undefined
  }
}

export const automaticProviderEligible = (
  state: Pick<ProviderState, 'automaticPolicy' | 'effectiveEnabled'>,
  country: string | undefined,
): boolean => state.effectiveEnabled && state.automaticPolicy === 'direct'
