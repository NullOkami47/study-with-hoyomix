// @vitest-environment node
// Response policy header preservation tests ensuring explicit HTTPS build inputs only
// insert the configured origins into media-src and connect-src relative to the minimal baseline
// (1210 bytes, SHA-256 598777b2...ce87).
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { buildHeadersFile, createResponsePolicyPlugin, readDefaultResponsePolicyEnvironment } from '../../vite.config'

const BASELINE_SHA256 = '598777b224f1c1253d156a301a55262838277b4b7caad9a9fcfcce34e5d6ce87'
const BASELINE_BYTES = 1210
const BASELINE_MEDIA = "media-src 'self' https://*.music.126.net;"
const BASELINE_CONNECT = "connect-src 'self' https://api.chksz.com;"

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const baseline = () => buildHeadersFile({})

/** The baseline with exactly the explicit origins inserted where the observed builds put them. */
const expectedFor = (publicOrigin: string | undefined, r2Origin: string | undefined) => baseline()
  .replace(BASELINE_MEDIA, `media-src 'self'${r2Origin ? ` ${r2Origin}` : ''} https://*.music.126.net;`)
  .replace(BASELINE_CONNECT, `connect-src 'self'${r2Origin ? ` ${r2Origin}` : ''} https://api.chksz.com${publicOrigin ? ` wss://${new URL(publicOrigin).host}` : ''};`)

const directives = (file: string) => {
  const policy = file.match(/^ {2}Content-Security-Policy: (.+)$/mu)![1]
  return new Map(policy.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name, ...values] = part.split(/\s+/u)
    return [name, values] as const
  }))
}

/** Requirement 3.7 on any emitted file. */
const expectDocumentPolicy = (file: string) => {
  const parsed = directives(file)
  for (const name of ['default-src', 'frame-ancestors', 'object-src', 'base-uri']) expect(parsed.get(name), name).toEqual(["'none'"])
  for (const [name, values] of parsed) {
    if (name === 'img-src') expect(values).toEqual(["'self'", 'blob:'])
    else expect(values, name).not.toContain('blob:')
    for (const forbidden of ['https:', '*', 'http:', 'data:', "'unsafe-inline'", "'unsafe-eval'"]) expect(values, `${name} ${forbidden}`).not.toContain(forbidden)
  }
  const permissions = (value: string) => value.match(/^ {2}Permissions-Policy: .+$/mu)![0]
  expect(permissions(file)).toBe(permissions(baseline()))
  // Everything outside the CSP line is byte-identical to the baseline.
  const withoutCsp = (value: string) => value.replace(/^ {2}Content-Security-Policy: .+$/mu, '')
  expect(withoutCsp(file)).toBe(withoutCsp(baseline()))
}

const label = fc.stringMatching(/^[a-z][a-z0-9]{1,12}$/u)
const publicOrigin = fc.option(fc.tuple(label, fc.constantFrom('example', 'example.com', 'pages.dev')).map(([name, suffix]) => `https://${name}.${suffix}`), { nil: undefined })
const r2 = fc.option(
  fc.tuple(label, fc.array(fc.stringMatching(/^[a-z0-9]{1,8}$/u), { maxLength: 2 }), fc.array(label, { maxLength: 2 }))
    .map(([host, segments, spare]) => {
      const hostname = `${host}.r2-media.example.com`
      return {
        baseUrl: `https://${hostname}/${segments.map((segment) => `${segment}/`).join('')}`,
        allowed: [hostname, ...spare.map((name) => `${name}.spare.example.com`)].join(','),
        origin: `https://${hostname}`,
      }
    }),
  { nil: undefined },
)

describe('explicit HTTPS policy inputs keep the 11.5 _headers baseline (requirement 3.7)', () => {
  it('emits the 11.5 clean baseline byte for byte when no origin is supplied', () => {
    const file = baseline()
    // Only the reviewed image Blob capability differs from the frozen baseline.
    const original = file.replace("img-src 'self' blob:;", "img-src 'self';")
    expect(new TextEncoder().encode(original).byteLength).toBe(BASELINE_BYTES)
    expect(sha256(original)).toBe(BASELINE_SHA256)
    expectDocumentPolicy(file)
    // An empty LX allow-list (absent or blank) adds nothing.
    expect(buildHeadersFile({ LX_ALLOWED_ORIGINS: '' } as never)).toBe(file)
  })

  it('for any explicit HTTPS origin and R2 base URL, inserts exactly those origins and changes nothing else', () => {
    fc.assert(
      fc.property(publicOrigin, r2, fc.constantFrom(undefined, ''), (origin, media, lxAllowed) => {
        const file = buildHeadersFile({
          PUBLIC_ORIGIN: origin,
          R2_BASE_URL: media?.baseUrl,
          R2_ALLOWED_HOSTNAMES: media?.allowed,
          ...(lxAllowed === undefined ? {} : { LX_ALLOWED_ORIGINS: lxAllowed }),
        } as never)
        expect(file).toBe(expectedFor(origin, media?.origin))
        expectDocumentPolicy(file)
        // Only the origin of R2_BASE_URL is permitted, never the spare allow-listed hostnames.
        expect(file).not.toMatch(/spare\.example\.com/u)
      }),
      { numRuns: 200 },
    )
  })

  it('builds production and staging _headers from explicit inputs in a clean checkout identically to the pure builder', () => {
    // Both naming schemes are set: the current PUBLIC_ORIGIN/R2_BASE_URL and the 19.5 explicit
    // RESPONSE_POLICY_* names, so this observation holds before and after M-13.
    const NAMES = ['PUBLIC_ORIGIN', 'R2_BASE_URL', 'R2_ALLOWED_HOSTNAMES', 'LX_ALLOWED_ORIGINS',
      'RESPONSE_POLICY_PUBLIC_ORIGIN', 'RESPONSE_POLICY_R2_BASE_URL', 'VITE_ANALYTICS_ID', 'VITE_ANALYTICS_URL']
    fc.assert(
      fc.property(
        fc.constantFrom('production', 'staging'),
        fc.tuple(label, fc.constantFrom('example', 'example.com')).map(([name, suffix]) => `https://${name}.${suffix}`),
        r2.filter((value) => value !== undefined),
        (mode, origin, media) => {
          const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p37-'))
          const checkout = path.join(root, 'checkout')
          fs.mkdirSync(checkout)
          const cwd = process.cwd()
          const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]))
          for (const name of NAMES) delete process.env[name]
          Object.assign(process.env, {
            PUBLIC_ORIGIN: origin,
            RESPONSE_POLICY_PUBLIC_ORIGIN: origin,
            R2_BASE_URL: media!.baseUrl,
            RESPONSE_POLICY_R2_BASE_URL: media!.baseUrl,
            R2_ALLOWED_HOSTNAMES: media!.allowed,
            LX_ALLOWED_ORIGINS: '',
          })
          process.chdir(checkout)
          try {
            const emitted: { fileName: string; source: string }[] = []
            createResponsePolicyPlugin(() => readDefaultResponsePolicyEnvironment(mode)).generateBundle.call({
              emitFile: (file: { fileName: string; source: string }) => emitted.push(file),
            })
            expect(emitted.map((file) => file.fileName)).toEqual(['_headers'])
            expect(emitted[0].source, `mode=${mode}`).toBe(expectedFor(origin, media!.origin))
            expectDocumentPolicy(emitted[0].source)
          } finally {
            process.chdir(cwd)
            for (const [name, value] of Object.entries(saved)) {
              if (value === undefined) delete process.env[name]
              else process.env[name] = value
            }
            fs.rmSync(root, { recursive: true, force: true })
          }
        },
      ),
      { numRuns: 30 },
    )
  })
})
