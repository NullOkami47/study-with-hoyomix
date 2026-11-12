// The build's emitted `connect-src`/`media-src` source lists (H-01, D1 = B). `vite.config.ts`
// defines `__HOYOMIX_LX_CSP__` from the same validated inputs that write `_headers`, so the runtime
// check refuses exactly what the document policy would refuse. Without the constant (Vitest, the
// live-smoke harness) the base lists apply: the narrowest policy, never an open one.
import { BASE_LX_CSP_SOURCES, cspSourcesAllow, type LxCspSources } from '../../../shared/lxCspPolicy'

export type { LxCspSources } from '../../../shared/lxCspPolicy'

export const BUILD_LX_CSP_SOURCES: LxCspSources =
  typeof __HOYOMIX_LX_CSP__ !== 'undefined' && __HOYOMIX_LX_CSP__ ? __HOYOMIX_LX_CSP__ : BASE_LX_CSP_SOURCES

/** The document origin `'self'` stands for; a dedicated worker shares its page's origin. */
export function currentSelfOrigin(): string | undefined {
  const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin
  return typeof origin === 'string' && origin !== 'null' ? origin : undefined
}

export function isLxTargetAllowed(
  kind: keyof LxCspSources,
  url: URL,
  sources: LxCspSources = BUILD_LX_CSP_SOURCES,
  selfOrigin: string | undefined = currentSelfOrigin(),
): boolean {
  return cspSourcesAllow(sources[kind], url, selfOrigin)
}
