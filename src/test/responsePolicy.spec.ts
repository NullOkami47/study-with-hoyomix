// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import fc from 'fast-check'

import {
  createResponsePolicyPlugin,
  buildHeadersFile,
  buildContentSecurityPolicy,
  readDefaultResponsePolicyEnvironment,
  lxCspDefineFor,
  lxCspSourcesFor,
  type ResponsePolicyEnvironment,
} from '../../vite.config'
import { BASE_LX_CSP_SOURCES, cspSourcesAllow, parseLxAllowedOrigins } from '../shared/lxCspPolicy'

// Deployment values that exist in the real environment but that the policy type deliberately does
// not name. Object.assign lets them arrive the way any unknown variable would, without widening the
// production type to admit a slot for a provider secret.
const withDeploymentValues = (extra: Record<string, string>): ResponsePolicyEnvironment =>
  Object.assign({} as ResponsePolicyEnvironment, extra)

const directives = (policy: string): Map<string, string[]> =>
  new Map(policy.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...values] = part.split(/\s+/u)
    return [name, values]
  }))

const YOUTUBE = 'https://www.youtube.com'
// The LX sandbox compiles its QuickJS emscripten module with WebAssembly inside a dedicated
// worker. Without this keyword in script-src the compilation is blocked and every LX source
// fails silently, so it is part of the required script-src surface, not slack. It is not a
// JavaScript eval relaxation and the 'unsafe-eval' prohibition below still holds.
const WASM_UNSAFE_EVAL = "'wasm-unsafe-eval'"
// The only ChKSz entries the policy may contain. Client-direct resolution needs the API origin
// reachable and the media family loadable; nothing else.
const CHKSZ_API = 'https://api.chksz.com'
const CHKSZ_MEDIA = 'https://*.music.126.net'

describe('application response policy', () => {
  it('takes staging and production presence only from the explicit policy inputs of that build (M-13)', () => {
    // Each release build gets its own explicit inputs; the Worker runtime names (PUBLIC_ORIGIN,
    // R2_BASE_URL) that a deploy shell may also carry are never consulted.
    const staging = {
      RESPONSE_POLICY_PUBLIC_ORIGIN: 'https://staging.example',
      RESPONSE_POLICY_R2_BASE_URL: 'https://staging-media.example/',
      PUBLIC_ORIGIN: 'https://production.example',
      R2_BASE_URL: 'https://production-media.example/',
    }
    for (const mode of ['staging', 'production']) {
      const environment = readDefaultResponsePolicyEnvironment(mode, staging)
      expect(environment.PUBLIC_ORIGIN, mode).toBe('https://staging.example')
      expect(environment.R2_BASE_URL, mode).toBe('https://staging-media.example/')
      expect(environment.LX_ALLOWED_ORIGINS, mode).toBe('')
      const policy = buildContentSecurityPolicy(environment)
      expect(policy).toContain("connect-src 'self' https://staging-media.example https://api.chksz.com wss://staging.example")
      expect(policy).not.toContain('production')
    }
    // A runtime name alone is not a policy input: the release build refuses instead of using it.
    expect(() => readDefaultResponsePolicyEnvironment('staging', { PUBLIC_ORIGIN: 'https://production.example', R2_BASE_URL: 'https://production-media.example/' }))
      .toThrow(/RESPONSE_POLICY_PUBLIC_ORIGIN is missing/u)
    // LX_ALLOWED_ORIGINS is read and passed through unchanged (validated by the H-01 allow-list).
    expect(readDefaultResponsePolicyEnvironment('production', { ...staging, LX_ALLOWED_ORIGINS: ' https://lx.example ' }).LX_ALLOWED_ORIGINS)
      .toBe('https://lx.example')
  })
  it('permits only the configured HTTPS origin over WSS, with every other directive unchanged', () => {
    const before = directives(buildContentSecurityPolicy({}))
    const after = directives(buildContentSecurityPolicy({ PUBLIC_ORIGIN: 'https://study.example' }))
    expect(after.get('connect-src')).toEqual(["'self'", CHKSZ_API, 'wss://study.example'])
    for (const [directive, values] of before) if (directive !== 'connect-src') expect(after.get(directive)).toEqual(values)
  })
  it.each(['http://study.example', 'https://user:password@study.example', 'https://study.example/path',
    'https://study.example/', 'https://study.example?secret=value', 'https://study.example#fragment',
    'wss://study.example', 'https://*.example', 'https://study.example\\evil', 'https://study.example\n'])('rejects unsafe presence origin %s', (PUBLIC_ORIGIN) => {
    expect(directives(buildContentSecurityPolicy({ PUBLIC_ORIGIN })).get('connect-src')).toEqual(["'self'", CHKSZ_API])
  })
  it('serves the policy to the document, not only to the API', () => {
    // Workers Static Assets answers every non-/api/* path, so the policy has to travel in the
    // _headers file that layer reads. A rule that matched only /api/* would leave the browsing
    // context that needs a CSP without one.
    const file = buildHeadersFile({})
    expect(file.split('\n')[0]).toBe('/*')
    expect(file).not.toMatch(/^\/api/mu)
    expect(file).toMatch(/^ {2}Content-Security-Policy: /mu)
  })

  it('defaults to none and never falls back to a permissive default', () => {
    const parsed = directives(buildContentSecurityPolicy({}))
    expect(parsed.get('default-src')).toEqual(["'none'"])
    for (const [name, values] of parsed) {
      expect(values, name).not.toContain('*')
      expect(values, name).not.toContain('https:')
      expect(values, name).not.toContain('data:')
      if (name === 'img-src') expect(values).toEqual(["'self'", 'blob:'])
      else expect(values, name).not.toContain('blob:')
      expect(values, name).not.toContain("'unsafe-inline'")
      expect(values, name).not.toContain("'unsafe-eval'")
    }
  })

  it('permits scripts from this origin, the official YouTube IFrame origin, and WebAssembly compilation', () => {
    // Measured in Chromium: the bootstrap at /iframe_api loads www-widgetapi.js from the same
    // https://www.youtube.com origin, so one entry is sufficient and two would be slack.
    // 'wasm-unsafe-eval' is required by the LX sandbox, not slack: without it the QuickJS
    // emscripten module cannot compile and LX fails silently.
    expect(directives(buildContentSecurityPolicy({})).get('script-src'))
      .toEqual(["'self'", YOUTUBE, WASM_UNSAFE_EVAL])
  })

  it('frames only the official YouTube player and refuses to be framed', () => {
    const parsed = directives(buildContentSecurityPolicy({}))
    expect(parsed.get('frame-src')).toEqual([YOUTUBE])
    expect(parsed.get('frame-ancestors')).toEqual(["'none'"])
  })

  it('needs no browser-facing Meting origin', () => {
    // Meting resolves through /api/providers/meting/media/..., which proxy.ts pins to same-origin,
    // so neither a Meting origin nor a Meting frame belongs in the policy.
    const policy = buildContentSecurityPolicy(withDeploymentValues({
      METING_API_BASE_URL: 'https://meting.invalid',
      METING_MEDIA_ALLOWED_HOSTNAMES: 'media.meting.invalid',
    }))
    expect(policy).not.toMatch(/meting/iu)
  })

  it('keeps non-ChKSz proxied provider media same-origin', () => {
    // Piped, Invidious and the lx providers still resolve through /api/providers/<id>/media/...,
    // which proxy.ts pins to same-origin, so they contribute no browser-facing origin.
    const parsed = directives(buildContentSecurityPolicy(withDeploymentValues({
      PIPED_API_BASE_URL: 'https://piped.invalid',
      INVIDIOUS_API_BASE_URL: 'https://invidious.invalid',
      LX_HUIBQ_API_BASE_URL: 'https://huibq.invalid',
    })))
    expect(parsed.get('connect-src')).toEqual(["'self'", CHKSZ_API])
    expect(parsed.get('media-src')).toEqual(["'self'", CHKSZ_MEDIA])
    for (const value of parsed.get('connect-src') ?? []) {
      expect(value).not.toMatch(/piped|invidious|huibq/u)
    }
  })

  it('permits exactly the ChKSz API origin, the ChKSz media family and only the configured LX origins', () => {
    // Deliberately updated for H-01 (D1 = B): an empty LX list adds nothing, and a configured list
    // adds exactly its origins to connect-src and media-src, never a global https: or *.
    const parsed = directives(buildContentSecurityPolicy({}))
    expect(parsed.get('connect-src')).toEqual(["'self'", CHKSZ_API])
    expect(parsed.get('media-src')).toEqual(["'self'", CHKSZ_MEDIA])
    const listed = directives(buildContentSecurityPolicy({ LX_ALLOWED_ORIGINS: 'https://lx-api.example.com, https://*.lx-cdn.example.com' }))
    expect(listed.get('connect-src')).toEqual(["'self'", CHKSZ_API, 'https://lx-api.example.com', 'https://*.lx-cdn.example.com'])
    expect(listed.get('media-src')).toEqual(["'self'", CHKSZ_MEDIA, 'https://lx-api.example.com', 'https://*.lx-cdn.example.com'])
    for (const [name, values] of listed) {
      if (name !== 'connect-src' && name !== 'media-src') expect(values, name).toEqual(parsed.get(name))
      expect(values, name).not.toContain('https:')
      expect(values, name).not.toContain('*')
    }
  })

  it('never grants ChKSz origins to scripts, frames or images', () => {
    const parsed = directives(buildContentSecurityPolicy({}))
    for (const name of ['script-src', 'frame-src', 'img-src', 'object-src', 'default-src']) {
      for (const value of parsed.get(name) ?? []) {
        expect(value, name).not.toMatch(/chksz|music\.126\.net/u)
      }
    }
  })

  it('never emits a global wildcard or a broader ChKSz family', () => {
    const policy = buildContentSecurityPolicy(withDeploymentValues({
      R2_BASE_URL: 'https://media.example.com/audio/',
      R2_ALLOWED_HOSTNAMES: 'media.example.com',
    }))
    const values = [...directives(policy).values()].flat()
    for (const forbidden of [
      '*', 'https:', 'https://*', 'https://*.chksz.com', 'https://*.126.net',
      'https://chksz.com', 'https://music.126.net',
    ]) {
      expect(values, forbidden).not.toContain(forbidden)
    }
  })

  it('keeps the operator ChKSz key and any request URL out of the policy', () => {
    const policy = buildContentSecurityPolicy(withDeploymentValues({
      CHKSZ_API_KEY: 'operator-only-value',
    }))
    expect(policy).not.toContain('operator-only-value')
    expect(policy).not.toMatch(/apikey/iu)
    expect(policy).not.toMatch(/163_music/u)
  })

  it('adds the R2 origin to media-src and connect-src when R2 is configured', () => {
    // r2.ts uses redirect: 'error' and requires the final URL to equal the request URL, so exactly
    // one origin is contacted: the one R2_BASE_URL names.
    const parsed = directives(buildContentSecurityPolicy({
      R2_BASE_URL: 'https://media.example.com/audio/',
      R2_ALLOWED_HOSTNAMES: 'media.example.com,spare.example.com',
    }))
    expect(parsed.get('media-src')).toEqual(["'self'", 'https://media.example.com', CHKSZ_MEDIA])
    expect(parsed.get('connect-src')).toEqual(["'self'", 'https://media.example.com', CHKSZ_API])
    // The allowlist bounds the base URL; it is not itself a set of origins to permit.
    expect(parsed.get('media-src')).not.toContain('https://spare.example.com')
  })

  it('yields no R2 entry when the deployment value is malformed rather than a broken one', () => {
    for (const environment of [
      { R2_BASE_URL: 'http://media.example.com/', R2_ALLOWED_HOSTNAMES: 'media.example.com' },
      { R2_BASE_URL: 'https://media.example.com:8443/', R2_ALLOWED_HOSTNAMES: 'media.example.com' },
      { R2_BASE_URL: 'https://media.example.com/?token=secret', R2_ALLOWED_HOSTNAMES: 'media.example.com' },
      { R2_BASE_URL: 'https://user:pass@media.example.com/', R2_ALLOWED_HOSTNAMES: 'media.example.com' },
      { R2_BASE_URL: 'https://media.example.com/', R2_ALLOWED_HOSTNAMES: 'other.example.com' },
      { R2_BASE_URL: 'https://localhost/', R2_ALLOWED_HOSTNAMES: 'localhost' },
      { R2_BASE_URL: 'https://media.example.com/' },
    ]) {
      const parsed = directives(buildContentSecurityPolicy(environment))
      expect(parsed.get('media-src'), JSON.stringify(environment)).toEqual(["'self'", CHKSZ_MEDIA])
      expect(parsed.get('connect-src'), JSON.stringify(environment)).toEqual(["'self'", CHKSZ_API])
    }
  })

  it('adds the analytics origin only when the analytics script is actually injected', () => {
    const off = directives(buildContentSecurityPolicy({}))
    expect(off.get('script-src')).toEqual(["'self'", YOUTUBE, WASM_UNSAFE_EVAL])
    expect(off.get('connect-src')).toEqual(["'self'", CHKSZ_API])

    const on = directives(buildContentSecurityPolicy({
      VITE_ANALYTICS_ID: 'site-test',
      VITE_ANALYTICS_URL: 'https://analytics.example.com/script.js',
    }))
    expect(on.get('script-src')).toEqual(["'self'", YOUTUBE, 'https://analytics.example.com', WASM_UNSAFE_EVAL])
    expect(on.get('connect-src')).toEqual(["'self'", 'https://analytics.example.com', CHKSZ_API])

    // Rejected by the same validation that refuses to inject the tag: no tag, no origin.
    const rejected = directives(buildContentSecurityPolicy({
      VITE_ANALYTICS_ID: 'site-test',
      VITE_ANALYTICS_URL: 'http://analytics.example.com/script.js',
    }))
    expect(rejected.get('script-src')).toEqual(["'self'", YOUTUBE, WASM_UNSAFE_EVAL])
  })

  it('exposes no secret merely to permit a resource', () => {
    const policy = buildContentSecurityPolicy(withDeploymentValues({
      R2_BASE_URL: 'https://media.example.com/audio/',
      R2_ALLOWED_HOSTNAMES: 'media.example.com',
      CHKSZ_API_KEY: 'chksz-secret-value',
      LX_HUIBQ_REQUEST_KEY: 'huibq-secret-value',
      LX_IKUN_REQUEST_KEY: 'ikun-secret-value',
      OAUTH_STATE_SECRET: 'oauth-secret-value',
      GOOGLE_CLIENT_SECRET: 'google-secret-value',
      VITE_ANALYTICS_ID: 'site-test',
      VITE_ANALYTICS_URL: 'https://analytics.example.com/script.js',
    }))
    for (const secret of [
      'chksz-secret-value', 'huibq-secret-value', 'ikun-secret-value',
      'oauth-secret-value', 'google-secret-value',
    ]) {
      expect(policy).not.toContain(secret)
    }
    // Nor a path, query or fragment: only origins.
    expect(policy).not.toContain('/audio/')
    expect(policy).not.toContain('/script.js')
  })

  it('revalidates update-sensitive resources and caches only hashed assets immutably', () => {
    const file = buildHeadersFile({})
    expect(file).toMatch(/^\/\*\n(?: {2}.+\n)* {2}Cache-Control: no-cache$/mu)
    expect(file).toMatch(/^\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/mu)
    expect(file).not.toMatch(/^\/sw\.js\n {2}Cache-Control: .*immutable/mu)
  })

  it('sets the non-CSP headers that do real work and no obsolete ones', () => {
    const file = buildHeadersFile({})
    expect(file).toMatch(/^ {2}X-Content-Type-Options: nosniff$/mu)
    expect(file).toMatch(/^ {2}Referrer-Policy: no-referrer$/mu)
    expect(file).toMatch(/^ {2}Permissions-Policy: /mu)
    // Superseded by frame-ancestors, and X-XSS-Protection is actively harmful.
    expect(file).not.toMatch(/X-Frame-Options/iu)
    expect(file).not.toMatch(/X-XSS-Protection/iu)
    expect(file).not.toMatch(/Expect-CT/iu)
    expect(file).not.toMatch(/X-Permitted-Cross-Domain-Policies/iu)
  })

  it('delegates to YouTube only the features its embed needs, not every feature it requests', () => {
    const policy = buildHeadersFile({}).match(/^ {2}Permissions-Policy: (.+)$/mu)?.[1] ?? ''
    const allowList = new Map(
      policy.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
        const [feature, list] = entry.split('=')
        return [feature, list ?? '']
      }),
    )

    // Measured from the iframe the official API builds: allow="accelerometer; autoplay;
    // clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen.
    const requestedByEmbed = [
      'accelerometer', 'autoplay', 'clipboard-write', 'encrypted-media',
      'gyroscope', 'picture-in-picture', 'web-share', 'fullscreen',
    ]
    const delegated = requestedByEmbed.filter((feature) => allowList.get(feature)?.includes(YOUTUBE))
    expect(delegated.sort()).toEqual(['autoplay', 'encrypted-media', 'fullscreen'])

    // Everything the embed asked for but does not need is denied outright, to no origin at all.
    for (const feature of requestedByEmbed.filter((name) => !delegated.includes(name))) {
      expect(allowList.get(feature), feature).toBe('()')
    }

    // The capability surface the application never touches stays closed.
    for (const feature of ['camera', 'microphone', 'geolocation', 'usb', 'serial', 'hid',
      'bluetooth', 'midi', 'payment', 'display-capture', 'idle-detection', 'screen-wake-lock',
      'xr-spatial-tracking', 'clipboard-read', 'local-fonts']) {
      expect(allowList.get(feature), feature).toBe('()')
    }

    // The Studio calls requestFullscreen, so this origin must keep it.
    expect(allowList.get('fullscreen')).toContain('self')
  })

  it('locks down base-uri, form-action and object-src', () => {
    const parsed = directives(buildContentSecurityPolicy({}))
    expect(parsed.get('base-uri')).toEqual(["'none'"])
    expect(parsed.get('form-action')).toEqual(["'none'"])
    expect(parsed.get('object-src')).toEqual(["'none'"])
  })

  it('reads only build-time values from the real environment, never a provider secret', () => {
    // The default reader is what runs in CI, where every provider secret is present in process.env.
    const secrets = {
      CHKSZ_API_KEY: 'chksz-secret-value',
      LX_HUIBQ_REQUEST_KEY: 'huibq-secret-value',
      LX_IKUN_REQUEST_KEY: 'ikun-secret-value',
      OAUTH_STATE_SECRET: 'oauth-secret-value',
      GOOGLE_CLIENT_SECRET: 'google-secret-value',
      SESSION_HMAC_SECRET: 'session-secret-value',
    }
    const restore = { ...process.env }
    Object.assign(process.env, secrets, {
      RESPONSE_POLICY_R2_BASE_URL: 'https://media.example.com/audio/',
    })
    try {
      const emitted: { fileName: string; source: string }[] = []
      createResponsePolicyPlugin().generateBundle.call({
        emitFile: (file: { fileName: string; source: string }) => emitted.push(file),
      })
      expect(emitted[0].source).toContain('https://media.example.com')
      for (const secret of Object.values(secrets)) expect(emitted[0].source).not.toContain(secret)
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in restore)) delete process.env[key]
      Object.assign(process.env, restore)
    }
  })

  it('emits the file into the build output through a Vite plugin', () => {
    const emitted: { fileName: string; source: string }[] = []
    const plugin = createResponsePolicyPlugin(() => ({}))
    plugin.generateBundle.call(
      { emitFile: (file: { fileName: string; source: string }) => emitted.push(file) },
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0].fileName).toBe('_headers')
    expect(emitted[0].source).toBe(buildHeadersFile({}))
  })

  it('uses explicit localhost defaults outside release modes and never local wrangler or dev.vars configuration (M-13)', () => {
    // Replaces the former fallback to wrangler.remote.toml, .dev.vars and ../sibling-repo/*:
    // whatever operator files exist in or next to this checkout, a non-release build sees none of them.
    const restore = { ...process.env }
    for (const name of ['RESPONSE_POLICY_PUBLIC_ORIGIN', 'RESPONSE_POLICY_R2_BASE_URL', 'LX_ALLOWED_ORIGINS',
      'PUBLIC_ORIGIN', 'R2_BASE_URL', 'R2_ALLOWED_HOSTNAMES', 'VITE_ANALYTICS_ID', 'VITE_ANALYTICS_URL']) delete process.env[name]
    try {
      for (const mode of [undefined, 'development', 'test', 'bundle']) {
        expect(readDefaultResponsePolicyEnvironment(mode), String(mode)).toEqual({
          VITE_ANALYTICS_ID: undefined,
          VITE_ANALYTICS_URL: undefined,
          PUBLIC_ORIGIN: 'http://localhost:3000',
          R2_BASE_URL: undefined,
          R2_ALLOWED_HOSTNAMES: undefined,
          LX_ALLOWED_ORIGINS: '',
        })
        const emitted: { fileName: string; source: string }[] = []
        createResponsePolicyPlugin(() => readDefaultResponsePolicyEnvironment(mode)).generateBundle.call({
          emitFile: (file: { fileName: string; source: string }) => emitted.push(file),
        })
        expect(emitted.map((file) => file.fileName)).toEqual(['_headers'])
        // The http://localhost default is same-origin ('self'), so it adds no origin at all.
        expect(emitted[0].source, String(mode)).toBe(buildHeadersFile({}))
      }
      // The same unset environment is not enough for a release build: it fails instead of guessing.
      for (const mode of ['production', 'staging']) expect(() => readDefaultResponsePolicyEnvironment(mode), mode).toThrow(/missing/u)
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in restore)) delete process.env[key]
      Object.assign(process.env, restore)
    }
  })
})

// Wave E exploration (task 17, M-13 / design Property 13). Encodes the expected behaviour, so it
// FAILS on the unfixed tree: readDefaultResponsePolicyEnvironment() falls back to gitignored
// operator files in and next to the checkout, and silently builds with missing or non-HTTPS inputs.
describe('build CSP depends only on explicit inputs (Property 13)', () => {
  const POLICY_VARIABLES = [
    'PUBLIC_ORIGIN', 'R2_BASE_URL', 'R2_ALLOWED_HOSTNAMES', 'LX_ALLOWED_ORIGINS',
    'RESPONSE_POLICY_PUBLIC_ORIGIN', 'RESPONSE_POLICY_R2_BASE_URL',
  ]
  const DECOY_FILES = [
    'wrangler.remote.toml', '.dev.vars', 'wrangler.toml', 'wrangler.staging.toml',
    '../sibling-repo/wrangler.remote.toml', '../sibling-repo/.dev.vars',
  ] as const

  /** Runs `body` with cwd in a fresh checkout-like temp dir and only `variables` set among the policy inputs. */
  const inCheckout = <T>(variables: Record<string, string>, decoys: Map<string, string>, body: () => T): T => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm13-'))
    const checkout = path.join(root, 'checkout')
    fs.mkdirSync(path.join(root, 'sibling-repo'), { recursive: true })
    fs.mkdirSync(checkout)
    for (const [file, content] of decoys) fs.writeFileSync(path.join(checkout, file), content)
    const cwd = process.cwd()
    const saved = Object.fromEntries(POLICY_VARIABLES.map((name) => [name, process.env[name]]))
    for (const name of POLICY_VARIABLES) delete process.env[name]
    Object.assign(process.env, variables)
    process.chdir(checkout)
    try {
      return body()
    } finally {
      process.chdir(cwd)
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  const headersFor = (mode: string) => {
    const emitted: { source: string }[] = []
    createResponsePolicyPlugin(() => readDefaultResponsePolicyEnvironment(mode)).generateBundle.call({
      emitFile: (file: { source: string }) => emitted.push(file),
    })
    return emitted[0]?.source
  }

  const EXPLICIT = {
    RESPONSE_POLICY_PUBLIC_ORIGIN: 'https://study.example',
    RESPONSE_POLICY_R2_BASE_URL: 'https://media.example.com/',
  }

  it('emits identical _headers whatever decoy .dev.vars, wrangler and sibling files exist', () => {
    const label = fc.stringMatching(/^[a-z][a-z0-9]{2,10}$/u)
    fc.assert(
      fc.property(
        fc.constantFrom('production', 'staging'),
        fc.subarray([...DECOY_FILES], { minLength: 1 }),
        label,
        (mode, files, decoy) => {
          const values = [
            `PUBLIC_ORIGIN = "https://${decoy}.decoy.example"`,
            `R2_BASE_URL = "https://${decoy}-media.decoy.example/"`,
            `R2_ALLOWED_HOSTNAMES = "${decoy}-media.decoy.example"`,
          ].join('\n')
          const decoys = new Map(files.map((file) => [file, file.endsWith('.toml') ? `[vars]\n${values}\n` : `${values}\n`]))
          const clean = inCheckout(EXPLICIT, new Map(), () => headersFor(mode))
          const withDecoys = inCheckout(EXPLICIT, decoys, () => headersFor(mode))
          expect(withDecoys, `mode=${mode} files=${files.join(',')}`).not.toContain('decoy.example')
          expect(withDecoys).toBe(clean)
        },
      ),
      { numRuns: 30, endOnFailure: true },
    )
  })

  it('fails a production or staging build when a policy input is missing', () => {
    for (const mode of ['production', 'staging']) {
      const partial: Record<string, string>[] = [
        {},
        { RESPONSE_POLICY_PUBLIC_ORIGIN: EXPLICIT.RESPONSE_POLICY_PUBLIC_ORIGIN },
        { RESPONSE_POLICY_R2_BASE_URL: EXPLICIT.RESPONSE_POLICY_R2_BASE_URL },
      ]
      for (const variables of partial) {
        expect(() => inCheckout(variables, new Map(), () => headersFor(mode)), `mode=${mode} ${JSON.stringify(variables)}`).toThrow()
      }
    }
  })

  it('fails a production or staging build when a policy input is not HTTPS', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('production', 'staging'),
        fc.constantFrom('RESPONSE_POLICY_PUBLIC_ORIGIN', 'RESPONSE_POLICY_R2_BASE_URL'),
        fc.constantFrom('http:', 'ws:', 'wss:', 'ftp:'),
        (mode, variable, scheme) => {
          const variables: Record<string, string> = { ...EXPLICIT, [variable]: EXPLICIT[variable as keyof typeof EXPLICIT].replace(/^https:/u, scheme) }
          expect(() => inCheckout(variables, new Map(), () => headersFor(mode)), `mode=${mode} ${variable}=${variables[variable]}`).toThrow()
        },
      ),
      { numRuns: 16, endOnFailure: true },
    )
  })
})

// H-01 (D1 = B): the operator LX allow-list. The client check reads the same lists the CSP emits.
describe('LX_ALLOWED_ORIGINS operator allow-list (H-01)', () => {
  const RELEASE = { RESPONSE_POLICY_PUBLIC_ORIGIN: 'https://study.example', RESPONSE_POLICY_R2_BASE_URL: 'https://media.example.com/' }

  it('accepts exact HTTPS origins and one leading wildcard label, separated by commas or whitespace', () => {
    expect(parseLxAllowedOrigins('')).toEqual([])
    expect(parseLxAllowedOrigins(undefined)).toEqual([])
    expect(parseLxAllowedOrigins(' https://LX.Example.com,https://*.cdn.example.com\nhttps://lx.example.com  https://a-b.example.co.uk ,'))
      .toEqual(['https://lx.example.com', 'https://*.cdn.example.com', 'https://a-b.example.co.uk'])
  })

  it.each([
    '*', 'https://', 'https://*', 'https://*.com', 'https://a.*.example.com', 'https://*.*.example.com',
    'https://*example.com', 'http://lx.example.com', 'wss://lx.example.com', '//lx.example.com', 'lx.example.com',
    'https://lx.example.com/', 'https://lx.example.com/path', 'https://lx.example.com:8443', 'https://lx.example.com:443',
    'https://user:pw@lx.example.com', 'https://lx.example.com?q=1', 'https://lx.example.com#f', 'https://localhost',
    'https://1.2.3.4', 'https://[::1]', 'https://-lx.example.com', 'https://lx_.example.com', 'https://lx.example.com\\x',
    'https://lx%2eexample.com',
  ])('rejects %s', (entry) => {
    expect(() => parseLxAllowedOrigins(`https://ok.example.com,${entry}`)).toThrow(/^LX_ALLOWED_ORIGINS entry 2 /u)
  })

  it('fails every build mode on an invalid entry, naming the variable but never echoing the value', () => {
    const value = 'https://lx.example.com/?token=operator-secret-value'
    for (const mode of [undefined, 'development', 'test', 'bundle', 'production', 'staging']) {
      let message = ''
      try {
        readDefaultResponsePolicyEnvironment(mode, { ...RELEASE, LX_ALLOWED_ORIGINS: value })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message, String(mode)).toMatch(/LX_ALLOWED_ORIGINS entry 1 must be an exact HTTPS origin/u)
      expect(message, String(mode)).not.toContain('operator-secret-value')
      expect(message, String(mode)).not.toContain('lx.example.com')
    }
    // The pure builder refuses too, so no caller can emit an unvalidated entry.
    expect(() => buildContentSecurityPolicy({ LX_ALLOWED_ORIGINS: 'http:' })).toThrow(/LX_ALLOWED_ORIGINS/u)
  })

  it('appends valid origins once, after the existing entries, in release builds', () => {
    const environment = readDefaultResponsePolicyEnvironment('production', {
      ...RELEASE, LX_ALLOWED_ORIGINS: 'https://lx.example.com https://api.chksz.com https://lx.example.com',
    })
    const parsed = directives(buildContentSecurityPolicy(environment))
    expect(parsed.get('connect-src')).toEqual(["'self'", 'https://media.example.com', CHKSZ_API, 'wss://study.example', 'https://lx.example.com'])
    expect(parsed.get('media-src')).toEqual(["'self'", 'https://media.example.com', CHKSZ_MEDIA, 'https://lx.example.com', 'https://api.chksz.com'])
  })

  it('opens only connect-src and media-src, with the https: scheme-source, when LX_ALLOWED_ORIGINS is https: (Owner decision: allow all)', () => {
    const environment = { ...RELEASE, LX_ALLOWED_ORIGINS: ' HTTPS: ' }
    const open = directives(buildContentSecurityPolicy(readDefaultResponsePolicyEnvironment('production', environment)))
    const closed = directives(buildContentSecurityPolicy(readDefaultResponsePolicyEnvironment('production', { ...RELEASE, LX_ALLOWED_ORIGINS: '' })))
    expect(open.get('connect-src')).toEqual([...closed.get('connect-src')!, 'https:'])
    expect(open.get('media-src')).toEqual([...closed.get('media-src')!, 'https:'])
    for (const [name, values] of closed) {
      if (name === 'connect-src' || name === 'media-src') continue
      expect(open.get(name), name).toEqual(values)
    }
    expect([...open.keys()]).toEqual([...closed.keys()])
  })
  it('replaces the specific hosts with https: instead of listing both, and keeps http:, ws: and * closed', () => {
    const parsed = directives(buildContentSecurityPolicy(readDefaultResponsePolicyEnvironment('production', {
      ...RELEASE, LX_ALLOWED_ORIGINS: 'https://lx.example.com,https:',
    })))
    for (const name of ['connect-src', 'media-src']) {
      expect(parsed.get(name), name).toContain('https:')
      expect(parsed.get(name), name).not.toContain('https://lx.example.com')
      for (const forbidden of ['*', 'http:', 'ws:', 'wss:', 'data:', 'blob:', 'https://*']) expect(parsed.get(name), `${name} ${forbidden}`).not.toContain(forbidden)
    }
    for (const name of ['script-src', 'img-src', 'style-src', 'frame-src', 'worker-src', 'default-src']) {
      expect(parsed.get(name) ?? [], name).not.toContain('https:')
    }
  })
  it.each(['http:', 'wss:', 'ws:', 'https:*', 'https:/', 'https:443', 'https:,*'])('still refuses %s', (entry) => {
    expect(() => parseLxAllowedOrigins(entry)).toThrow(/^LX_ALLOWED_ORIGINS entry /u)
  })
  it('hands the client an https: scheme-source that matches any HTTPS target but never http:', () => {
    const sources = lxCspSourcesFor({ LX_ALLOWED_ORIGINS: 'https:' })
    expect(cspSourcesAllow(sources.connect, new URL('https://103.79.184.97:8443/api'))).toBe(true)
    expect(cspSourcesAllow(sources.media, new URL('https://never-listed.example.org/a.mp3'))).toBe(true)
    expect(cspSourcesAllow(sources.media, new URL('http://never-listed.example.org/a.mp3'))).toBe(false)
  })
  it('exposes to the client exactly the connect-src and media-src lists the CSP emits', () => {
    expect(lxCspSourcesFor({})).toEqual(BASE_LX_CSP_SOURCES)
    const label = fc.stringMatching(/^[a-z][a-z0-9]{1,10}$/u)
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.boolean(), label).map(([wild, name]) => `https://${wild ? '*.' : ''}${name}.lx.example.com`), { maxLength: 4 }),
        fc.option(label.map((name) => `https://${name}.example`), { nil: undefined }),
        fc.boolean(),
        (lx, publicOrigin, r2) => {
          const environment: ResponsePolicyEnvironment = {
            LX_ALLOWED_ORIGINS: lx.join(','),
            PUBLIC_ORIGIN: publicOrigin,
            ...(r2 ? { R2_BASE_URL: 'https://media.example.com/a/', R2_ALLOWED_HOSTNAMES: 'media.example.com' } : {}),
          }
          const parsed = directives(buildContentSecurityPolicy(environment))
          expect(lxCspSourcesFor(environment)).toEqual({ connect: parsed.get('connect-src'), media: parsed.get('media-src') })
        },
      ),
      { numRuns: 100 },
    )
  })

  it('defines the client constant from the build inputs, and the base lists for a release-mode server', () => {
    const restore = { ...process.env }
    Object.assign(process.env, RELEASE, { LX_ALLOWED_ORIGINS: 'https://lx.example.com' })
    try {
      expect(lxCspDefineFor('production', 'build').connect).toContain('https://lx.example.com')
      expect(lxCspDefineFor('bundle', 'build').media).toContain('https://lx.example.com')
      expect(lxCspDefineFor('production', 'serve')).toEqual(BASE_LX_CSP_SOURCES)
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in restore)) delete process.env[key]
      Object.assign(process.env, restore)
    }
  })

  it('matches targets the way the emitted sources do', () => {
    const sources = ["'self'", 'https://lx.example.com', 'https://*.cdn.example.com', 'wss://study.example']
    const allow = (url: string) => cspSourcesAllow(sources, new URL(url), 'https://study.example')
    expect(allow('https://lx.example.com/api/url?id=1')).toBe(true)
    expect(allow('https://LX.example.com:443/x')).toBe(true)
    expect(allow('https://a.b.cdn.example.com/t.mp3')).toBe(true)
    expect(allow('https://study.example/api')).toBe(true)
    for (const url of ['https://cdn.example.com/t.mp3', 'https://lx.example.com:8443/x', 'http://lx.example.com/x',
      'https://lx.example.com.evil.test/x', 'https://evil-lx.example.com/x', 'https://study.example:444/x']) {
      expect(allow(url), url).toBe(false)
    }
    expect(cspSourcesAllow(["'self'"], new URL('https://study.example/'), undefined)).toBe(false)
  })
})
