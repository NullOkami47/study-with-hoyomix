// @vitest-environment node
// The build and the Worker both read `LX_ALLOWED_ORIGINS`, independently, and turn it into two
// different things: the build writes `connect-src`/`media-src` into `_headers`, the Worker decides
// whether a source may be published. If the two ever disagree, the registry publishes sources the
// document policy refuses — the browser then skips them, so the failure is silent and looks like a
// broken source rather than a misconfiguration.
//
// Nothing at runtime can compare the two values (the Worker cannot read `_headers`), so the
// guarantee has to be structural: one parser, one normal form, and the same input producing the same
// set on both sides. These tests pin that, and pin the fail-closed direction for a bad value.

import { describe, expect, it } from 'vitest'

import { buildHeadersFile, lxCspSourcesFor, readDefaultResponsePolicyEnvironment, type ResponsePolicyEnvironment } from '../../vite.config'
import { parseLxAllowedOrigins } from '../shared/lxCspPolicy'

const environment = (lx: string): ResponsePolicyEnvironment => ({
  PUBLIC_ORIGIN: 'https://hoyomix.example',
  R2_BASE_URL: 'https://media.example',
  R2_ALLOWED_HOSTNAMES: 'media.example',
  LX_ALLOWED_ORIGINS: lx,
})

/** The origins a directive carries, in emitted order. */
const directiveOrigins = (headers: string, directive: 'connect-src' | 'media-src'): string[] => {
  const line = headers.split('\n').find((entry) => entry.trimStart().toLowerCase().startsWith('content-security-policy:'))
  if (!line) throw new Error('no Content-Security-Policy line')
  const match = line.match(new RegExp(`${directive} ([^;]+)`, 'u'))
  if (!match) throw new Error(`no ${directive} directive`)
  return match[1]!.trim().split(/\s+/u).filter((source) => source.startsWith('https://'))
}

const SAMPLE = 'https://yy.zddyr.top,https://music-api.gdstudio.xyz,https://*.zddyr.top'

describe('build-time CSP and Worker allow-list parity', () => {
  it('emits exactly the parsed origins, in both directives', () => {
    const parsed = parseLxAllowedOrigins(SAMPLE)
    const headers = buildHeadersFile(environment(SAMPLE))
    for (const directive of ['connect-src', 'media-src'] as const) {
      const emitted = directiveOrigins(headers, directive).filter((source) => parsed.includes(source))
      expect(emitted).toEqual(parsed)
    }
  })

  it('carries no LX origin that the allow-list does not name', () => {
    const parsed = new Set(parseLxAllowedOrigins(SAMPLE))
    const headers = buildHeadersFile(environment(SAMPLE))
    const baseline = new Set([
      ...directiveOrigins(buildHeadersFile(environment('')), 'connect-src'),
      ...directiveOrigins(buildHeadersFile(environment('')), 'media-src'),
    ])
    for (const directive of ['connect-src', 'media-src'] as const) {
      for (const source of directiveOrigins(headers, directive)) {
        if (baseline.has(source)) continue
        expect(parsed.has(source), `${source} in ${directive} is not in the allow-list`).toBe(true)
      }
    }
  })

  it('normalises to a fixed point, so the Worker and the build cannot disagree about spelling', () => {
    const once = parseLxAllowedOrigins('  HTTPS://YY.ZDDYR.TOP , https://music-api.gdstudio.xyz ')
    expect(once).toEqual(['https://yy.zddyr.top', 'https://music-api.gdstudio.xyz'])
    expect(parseLxAllowedOrigins(once.join(','))).toEqual(once)
    expect(parseLxAllowedOrigins(once.join(' '))).toEqual(once)
  })

  it('collapses duplicates rather than emitting an origin twice', () => {
    const duplicated = parseLxAllowedOrigins('https://a.example,https://a.example,https://b.example')
    expect(duplicated).toEqual(['https://a.example', 'https://b.example'])
    const headers = buildHeadersFile(environment('https://a.example,https://a.example'))
    expect(directiveOrigins(headers, 'connect-src').filter((source) => source === 'https://a.example')).toHaveLength(1)
  })

  it('fails the build on a value the Worker would treat as empty', () => {
    // A release build must refuse rather than silently emit a narrower policy than the operator
    // asked for; the Worker's equivalent behaviour is to approve nothing, which is the same
    // direction (fail closed) reached differently.
    expect(() => readDefaultResponsePolicyEnvironment('production', {
      RESPONSE_POLICY_PUBLIC_ORIGIN: 'https://hoyomix.example',
      RESPONSE_POLICY_R2_BASE_URL: 'https://media.example',
      LX_ALLOWED_ORIGINS: 'https://*',
    })).toThrow(/LX_ALLOWED_ORIGINS/u)
    expect(() => parseLxAllowedOrigins('https://*')).toThrow()
  })

  it('never emits a wildcard wider than one label', () => {
    // `https://*.example.com` matches one or more labels but not the bare suffix; a bare `*` or a
    // suffix-only entry is refused by the parser, so it cannot reach the header.
    expect(parseLxAllowedOrigins('https://*.example.com')).toEqual(['https://*.example.com'])
    for (const invalid of ['*', 'https://*', '*.example.com', 'https://example.*']) {
      expect(() => parseLxAllowedOrigins(invalid)).toThrow()
    }
  })

  it('keeps the two client source lists equal to the emitted directives', () => {
    const env = environment(SAMPLE)
    const sources = lxCspSourcesFor(env)
    const headers = buildHeadersFile(env)
    expect(sources.connect.filter((source) => source.startsWith('https://')))
      .toEqual(directiveOrigins(headers, 'connect-src'))
    expect(sources.media.filter((source) => source.startsWith('https://')))
      .toEqual(directiveOrigins(headers, 'media-src'))
  })
})

describe('build-time CSP and Worker parity for the https: scheme-source', () => {
  it('parses to the same single entry on both sides and emits it in connect-src and media-src', () => {
    expect(parseLxAllowedOrigins(' HTTPS: ')).toEqual(['https:'])
    const sources = lxCspSourcesFor(environment('https:'))
    expect(sources.connect).toContain('https:')
    expect(sources.media).toContain('https:')
    const headers = buildHeadersFile(environment('https:'))
    const line = headers.split('\n').find((entry) => entry.trimStart().toLowerCase().startsWith('content-security-policy:'))!
    for (const directive of ['connect-src', 'media-src']) {
      expect(line.match(new RegExp(`${directive} ([^;]+)`, 'u'))![1]!.trim().split(/\s+/u)).toContain('https:')
    }
  })
})