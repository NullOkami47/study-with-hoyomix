import { defineConfig, type HtmlTagDescriptor, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

import * as fs from 'node:fs'
import * as path from 'node:path'

import { readR2PublicConfig } from './workers/providers/config'
import { CHKSZ_API_ORIGIN, CHKSZ_MEDIA_HOST_SUFFIX } from './src/shared/chksz'
import { createPublicNoticesPlugin } from './scripts/public-notices'

export interface AnalyticsEnvironment {
  VITE_ANALYTICS_ID?: string
  VITE_ANALYTICS_URL?: string
}

const WEBSITE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const RAW_CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/

function canonicalHttpsAuthority(rawUrl: string): string | null {
  if (!rawUrl.startsWith('https://') || rawUrl.includes('\\') || RAW_CONTROL_CHARACTER.test(rawUrl)) return null
  return rawUrl.slice('https://'.length).split(/[/?#]/, 1)[0] || null
}

function hasExplicitPort(authority: string): boolean {
  const hostAndPort = authority.slice(authority.lastIndexOf('@') + 1)
  if (!hostAndPort.startsWith('[')) return hostAndPort.includes(':')
  const closingBracket = hostAndPort.indexOf(']')
  return closingBracket >= 0 && hostAndPort[closingBracket + 1] === ':'
}

export interface AnalyticsPlugin extends Plugin {
  transformIndexHtml: (html: string) => HtmlTagDescriptor[]
}

// The single decision point for the analytics tag. The injector and the response policy both read
// it, so the policy cannot permit an origin the build did not inject, or omit one it did.
function analyticsScript(environment: AnalyticsEnvironment): { id: string; url: URL } | null {
  const id = environment.VITE_ANALYTICS_ID?.trim()
  const rawUrl = environment.VITE_ANALYTICS_URL?.trim()
  if (!id || !rawUrl || !WEBSITE_ID.test(id)) return null
  const authority = canonicalHttpsAuthority(rawUrl)
  if (!authority || hasExplicitPort(authority)) return null
  let url: URL
  try { url = new URL(rawUrl) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null
  return { id, url }
}

function analyticsTags(environment: AnalyticsEnvironment): HtmlTagDescriptor[] {
  const script = analyticsScript(environment)
  if (!script) return []
  return [{
    tag: 'script',
    injectTo: 'head',
    attrs: { defer: true, src: script.url.href, 'data-website-id': script.id },
  }]
}

export function createAnalyticsPlugin(
  readEnvironment = (): AnalyticsEnvironment => ({
    VITE_ANALYTICS_ID: process.env.VITE_ANALYTICS_ID,
    VITE_ANALYTICS_URL: process.env.VITE_ANALYTICS_URL,
  }),
): AnalyticsPlugin {
  return {
    name: 'analytics-injector',
    transformIndexHtml: () => analyticsTags(readEnvironment()),
  }
}

// Workers Static Assets serves every path that is not /api/*, and the _headers file is the only
// mechanism that decorates those responses. Adding headers to Worker /api/* replies would leave the
// HTML document itself without a policy, which is the case that actually matters.
export interface ResponsePolicyEnvironment extends AnalyticsEnvironment {
  R2_BASE_URL?: string
  R2_ALLOWED_HOSTNAMES?: string
  PUBLIC_ORIGIN?: string
}

function presenceWebSocketOrigin(rawOrigin?: string): string | null {
  if (!rawOrigin || RAW_CONTROL_CHARACTER.test(rawOrigin) || rawOrigin.includes('\\')) return null
  try {
    const url = new URL(rawOrigin)
    if (url.protocol !== 'https:' || url.origin !== rawOrigin || url.hostname.includes('*') || url.username || url.password || url.search || url.hash) return null
    return `wss://${url.host}`
  } catch { return null }
}

// The official IFrame bootstrap and the www-widgetapi.js it pulls in are both served from this one
// origin, measured in Chromium, so a second YouTube entry would be slack rather than coverage.
const YOUTUBE_IFRAME_ORIGIN = 'https://www.youtube.com'

// Derived from the shared ChKSz policy so the policy file cannot drift from the origins the
// provider actually contacts. The media family is not enumerable, so the suffix wildcard is
// the narrowest correct expression — still far tighter than a global `https:`.
const CHKSZ_API_CSP_ORIGIN = CHKSZ_API_ORIGIN
const CHKSZ_MEDIA_CSP_ORIGIN = `https://*${CHKSZ_MEDIA_HOST_SUFFIX}`

export function buildContentSecurityPolicy(environment: ResponsePolicyEnvironment): string {
  const analytics = analyticsScript(environment)
  const analyticsOrigin = analytics ? analytics.url.origin : null
  // Reuses the Worker's own validation, so a malformed deployment value yields no entry rather than
  // a broken or over-permissive one, and the origin cannot drift from the one R2 actually serves.
  // r2.ts sets redirect: 'error' and rejects any final URL that differs from the request URL, so
  // exactly one origin is ever contacted: not the whole R2_ALLOWED_HOSTNAMES allowlist.
  const r2 = readR2PublicConfig(environment)
  const r2Origin = r2 ? new URL(r2.baseUrl).origin : null

  const directives: [string, (string | null)[]][] = [
    ['default-src', ["'none'"]],
    ['script-src', ["'self'", YOUTUBE_IFRAME_ORIGIN, analyticsOrigin, "'wasm-unsafe-eval'"]],
    // 'wasm-unsafe-eval' is required by the LX sandbox: the QuickJS runtime compiles its
    // emscripten module with WebAssembly.instantiate inside the dedicated worker, and a
    // script-src without this keyword blocks that compilation outright. The failure is
    // silent — every LX source fails and playback falls through to Jellyfin — so the
    // keyword is load-bearing rather than cosmetic. It permits WebAssembly compilation
    // only; it does not re-enable JavaScript eval or 'unsafe-eval'.
    // Measured: Vue's :style bindings are element style attributes, which style-src does not gate,
    // so the application runs clean without 'unsafe-inline'.
    ['style-src', ["'self'"]],
    ['img-src', ["'self'"]],
    // Every other provider resolves through /api/providers/<id>/media/..., which the Worker pins to
    // same-origin. Meting included: it needs no browser-facing origin and no frame.
    // ChKSz is the exception: with a user key the browser resolves and plays directly, so the API
    // origin must be reachable and the media family must be loadable.
    ['media-src', ["'self'", r2Origin, CHKSZ_MEDIA_CSP_ORIGIN]],
    // Some engines do not match wss: against 'self'. Permit only the configured document origin.
    ['connect-src', ["'self'", r2Origin, analyticsOrigin, CHKSZ_API_CSP_ORIGIN, presenceWebSocketOrigin(environment.PUBLIC_ORIGIN)]],
    ['font-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['worker-src', ["'self'"]],
    ['frame-src', [YOUTUBE_IFRAME_ORIGIN]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'none'"]],
    ['object-src', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
  ]

  return directives
    .map(([name, values]) => [name, ...values.filter((value): value is string => value !== null)].join(' '))
    .join('; ')
}

// Denies the capability surface the application never touches. A document-level denial here cannot
// be re-opened by a subframe's own allow attribute, so this decides what the YouTube embed gets.
//
// Measured: the official IFrame API builds its iframe with
//   allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture;
//          web-share"  allowfullscreen
// Requested is not the same as needed. The embed is delegated three of those:
//   autoplay        the application calls playVideo() itself
//   fullscreen      playerVars set controls: 1 and the iframe sets allowfullscreen, so a fullscreen
//                   button is rendered; denying it would leave a visibly dead control
//   encrypted-media the embed asks for it on every video. Denial is untested against real playback,
//                   and a broken audio transport is a worse outcome than one scoped delegation to
//                   the single official origin. Tightening candidate for the release-candidate gate,
//                   where real media can prove whether music playback engages EME at all.
// accelerometer and gyroscope serve 360/VR video, and clipboard-write, web-share and
// picture-in-picture serve sharing and detached-window features this application does not offer.
const YOUTUBE_DELEGATED = `self "${YOUTUBE_IFRAME_ORIGIN}"`
const PERMISSIONS_POLICY = [
  'accelerometer=()', 'ambient-light-sensor=()', `autoplay=(${YOUTUBE_DELEGATED})`,
  'bluetooth=()', 'camera=()', 'clipboard-read=()', 'clipboard-write=()', 'display-capture=()',
  `encrypted-media=("${YOUTUBE_IFRAME_ORIGIN}")`, `fullscreen=(${YOUTUBE_DELEGATED})`,
  'gamepad=()', 'geolocation=()', 'gyroscope=()', 'hid=()', 'idle-detection=()', 'local-fonts=()',
  'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()', 'picture-in-picture=()',
  'publickey-credentials-get=()', 'screen-wake-lock=()', 'serial=()', 'usb=()', 'web-share=()',
  'xr-spatial-tracking=()',
].join(', ')

export function buildHeadersFile(environment: ResponsePolicyEnvironment): string {
  return [
    '/*',
    `  Content-Security-Policy: ${buildContentSecurityPolicy(environment)}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    `  Permissions-Policy: ${PERMISSIONS_POLICY}`,
    '  Cache-Control: no-cache',
    '',
    '/backgrounds/*',
    '  ! Cache-Control',
    '  Cache-Control: public, max-age=604800, stale-while-revalidate=86400',
    '',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n')
}

export interface ResponsePolicyPlugin extends Plugin {
  generateBundle: (this: { emitFile: (file: { type: 'asset'; fileName: string; source: string }) => void }) => void
}

function parseConfigFileVars(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {}
    const content = fs.readFileSync(filePath, 'utf8')
    const result: Record<string, string> = {}
    let inVars = false
    const isToml = filePath.endsWith('.toml')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      if (isToml && trimmed.startsWith('[')) {
        inVars = trimmed === '[vars]'
        continue
      }
      if (!isToml || inVars || !trimmed.includes('=')) {
        const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/)
        if (match) {
          let val = match[2].trim()
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
          }
          result[match[1]] = val
        }
      }
    }
    return result
  } catch {
    return {}
  }
}

export function readDefaultResponsePolicyEnvironment(mode?: string, readVars = parseConfigFileVars): ResponsePolicyEnvironment {
  let r2BaseUrl = process.env.R2_BASE_URL
  let r2AllowedHostnames = process.env.R2_ALLOWED_HOSTNAMES
  let publicOrigin = process.env.PUBLIC_ORIGIN

  const candidatePaths = mode === 'staging' ? [path.resolve(process.cwd(), 'wrangler.staging.toml')] : [
    path.resolve(process.cwd(), 'wrangler.remote.toml'),
    path.resolve(process.cwd(), '.dev.vars'),
    path.resolve(process.cwd(), 'wrangler.toml'),
  ]
  if (!publicOrigin) {
    for (const candidate of candidatePaths) {
      const vars = readVars(candidate)
      if (vars.PUBLIC_ORIGIN) { publicOrigin = vars.PUBLIC_ORIGIN; break }
    }
  }

  if (!r2BaseUrl) {
    for (const p of candidatePaths) {
      const vars = readVars(p)
      if (vars.R2_BASE_URL) {
        r2BaseUrl = vars.R2_BASE_URL
        r2AllowedHostnames = r2AllowedHostnames || vars.R2_ALLOWED_HOSTNAMES
        break
      }
    }
  }

  return {
    VITE_ANALYTICS_ID: process.env.VITE_ANALYTICS_ID,
    VITE_ANALYTICS_URL: process.env.VITE_ANALYTICS_URL,
    R2_BASE_URL: r2BaseUrl,
    R2_ALLOWED_HOSTNAMES: r2AllowedHostnames,
    PUBLIC_ORIGIN: publicOrigin,
  }
}

export function createResponsePolicyPlugin(
  readEnvironment = readDefaultResponsePolicyEnvironment,
): ResponsePolicyPlugin {
  return {
    name: 'response-policy',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: buildHeadersFile(readEnvironment()) })
    },
  }
}

export function createBuildInfoPlugin(): Plugin {
  return {
    name: 'build-info-injector',
    transformIndexHtml() {
      // No hardcoded fallbacks: a build must identify itself or not ship. The
      // environment is read from the baked build identity, never guessed from a
      // hostname (production is served from a *.workers.dev origin).
      let commit = 'unknown'
      let buildTime = new Date().toISOString()
      let environment = process.env.BUILD_ENV?.trim() || 'development'
      try {
        const infoPath = path.resolve(__dirname, 'workers/buildInfo.json')
        if (fs.existsSync(infoPath)) {
          const parsed = JSON.parse(fs.readFileSync(infoPath, 'utf8'))
          if (parsed.commit) commit = parsed.commit
          if (parsed.buildTime) buildTime = parsed.buildTime
          if (parsed.environment) environment = parsed.environment
        }
      } catch {}
      if (commit === 'unknown') {
        console.warn(
          'build-info-injector: workers/buildInfo.json is missing or has no commit. ' +
            'Run `npm run generate:build-info` (or set BUILD_COMMIT) before building.',
        )
      }
      return [
        {
          tag: 'meta',
          attrs: { name: 'build-commit', content: commit },
          injectTo: 'head',
        },
        {
          tag: 'meta',
          attrs: { name: 'build-time', content: buildTime },
          injectTo: 'head',
        },
        {
          tag: 'meta',
          attrs: { name: 'build-env', content: environment },
          injectTo: 'head',
        },
      ]
    },
  }
}

export function createDevAuthMockPlugin(): Plugin {
  return {
    name: 'dev-auth-mock',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' || !req.url) return next()
        let pathname: string
        try { pathname = new URL(req.url, 'http://localhost').pathname } catch { return next() }
        const oauthStart = /^\/api\/auth\/(?:google|github|linuxdo)\/start$/.test(pathname)
        if (pathname !== '/api/auth/providers' && pathname !== '/api/session' && !oauthStart) return next()
        res.setHeader('X-Hoyomix-Dev-Auth-Mock', '1')
        res.setHeader('Cache-Control', 'no-store')
        if (pathname === '/api/auth/providers') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ mock: true, providers: { google: true, github: true, linuxdo: true } }))
          return
        }
        if (pathname === '/api/session') {
          res.statusCode = 401
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ mock: true, error: 'unauthorized' }))
          return
        }
        res.statusCode = 501
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('Development auth mock: OAuth did not occur. This preview cannot sign in or link identities.')
      })
    },
  }
}

// Vite 8 uses base64url bundle hashes; retain caching for both old hex and new hashes.
export function cacheChineseTitleConverter({ request, url }: { request: Request; url: URL }): boolean {
  return request.method === 'GET' && url.origin === self.location.origin &&
    /^\/assets\/chinese-title-converter-[A-Za-z0-9_-]{8}\.js$/.test(url.pathname)
}

export default defineConfig(({ mode, command }) => ({
  plugins: [
    createPublicNoticesPlugin(),
    vue(),
    // Vite 4 preview resolves serve in production mode; configureServer only runs in dev.
    ...(command === 'serve' && mode === 'development' && process.env.HOYOMIX_DEV_AUTH_PREVIEW === '1'
      ? [createDevAuthMockPlugin()] : []),
    createAnalyticsPlugin(),
    createResponsePolicyPlugin(() => readDefaultResponsePolicyEnvironment(mode)),
    createBuildInfoPlugin(),
    VitePWA({
      injectRegister: null,
      registerType: 'prompt',
      includeAssets: [
        'manifest.webmanifest',
        'pwa-icon-192.png',
        'pwa-icon-512.png',
        'robots.txt',
      ],
      manifest: false,
      workbox: {
        importScripts: ['chinese-title-cache.js'],
        globPatterns: ['index.html', 'assets/**/*.{js,css,png,svg,woff,woff2}', 'legal/*.txt'],
        globIgnores: ['assets/backgroundTranscode*', 'assets/chinese-title-converter-*.js', '**/*.{mp3,mp4,m4a,aac,ogg,oga,opus,wav,flac,webm,m3u,m3u8}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [
          /^\/legal\//,
          /^\/api\//,
          /^\/oauth(?:\/|$)/,
          /^\/chat(?:\/|$)/,
          /\.(?:mp3|mp4|m4a|aac|ogg|oga|opus|wav|flac|webm|m3u8?)(?:$|\?)/i,
        ],
        runtimeCaching: [
          {
            // Dictionaries are presentation-only and must not be fetched by an
            // English PWA install. Keep successful on-demand loads for offline use.
            urlPattern: cacheChineseTitleConverter,
            handler: 'CacheFirst',
            options: {
              cacheName: 'chinese-title-converter',
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 2, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern: ({ request, url }) =>
              request.method === 'GET' &&
              url.origin === self.location.origin &&
              /^\/catalogue\/(?:v[0-9][\w.-]*|[a-z0-9-]+\.[a-f0-9]{8,})\.json$/i.test(url.pathname),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'versioned-catalogue-metadata',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 6, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  base: process.env.NODE_ENV === 'production' ? './' : '/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks(id) {
          const modulePath = id.replace(/\\/g, '/')
          if (modulePath.endsWith('/src/features/catalog/chineseTitleConverter.ts') || modulePath.includes('/node_modules/opencc-js/'))
            return 'chinese-title-converter'
        },
      },
    },
  },
  server: { port: 3000 },
  publicDir: 'public',
  assetsInclude: ['**/*.mp4', '**/*.webm', '**/*.ogg'],
  optimizeDeps: { include: ['vue'] },
  // The LX sandbox runtime is a module Worker (`lx/runtime/client.ts`) whose QuickJS
  // dependency graph code-splits. Vite's default `iife` worker format cannot emit
  // multiple chunks, so the production build fails outright without this. ES output
  // matches the `{ type: 'module' }` worker construction already in use.
  worker: { format: 'es' },
}))
