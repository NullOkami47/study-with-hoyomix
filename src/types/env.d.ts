/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_DEMO_CATALOG?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/**
 * The `connect-src` and `media-src` source lists of this build's `_headers` CSP, defined by
 * `vite.config.ts` (H-01). Undefined outside a Vite build that loads that config.
 */
declare const __HOYOMIX_LX_CSP__: { readonly connect: readonly string[]; readonly media: readonly string[] } | undefined
