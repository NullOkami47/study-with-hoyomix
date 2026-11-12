const scenario = process.env.PROVIDER_SMOKE_TEST_SCENARIO
const appOrigin = 'https://preview.example.invalid'
const metingMediaPath =
  '/api/providers/meting/media/netease%3A123456789/abcdefghijklmnopqrstuvwxyzABCDEF'
const validR2Config = {
  baseUrl: 'https://media.preview.example.invalid/smoke/',
  allowedHostnames: ['media.preview.example.invalid'],
}
const validProviders = [
  { id: 'youtube', available: true, enabled: true, automaticEligible: false, priority: 90 },
  { id: 'piped', available: false, enabled: false, automaticEligible: false, priority: 4 },
  { id: 'invidious', available: false, enabled: false, automaticEligible: false, priority: 5 },
  { id: 'meting', available: false, enabled: false, automaticEligible: false, priority: 2 },
  { id: 'r2', available: true, enabled: true, automaticEligible: true, priority: 1, config: validR2Config },
  { id: 'chksz', available: true, enabled: true, automaticEligible: false, priority: 3, userKeySupported: true, ownerFallbackAvailable: false },
]
const validConfig = { version: 1, providers: validProviders }

function response(
  url,
  body,
  contentType = 'application/json',
  headers = {},
  redirected = false,
  status = 200,
) {
  const value = new Response(body, {
    headers: { 'content-type': contentType, ...headers },
    status,
  })
  Object.defineProperty(value, 'url', { value: url })
  Object.defineProperty(value, 'redirected', { value: redirected })
  return value
}

function assertRequest(condition) {
  if (!condition) throw new Error('unexpected smoke fixture request')
}

function hasExactHeaders(init, expected) {
  const headers = new Headers(init.headers)
  const entries = [...headers.entries()]
  return entries.length === Object.keys(expected).length &&
    Object.entries(expected).every(([name, value]) => headers.get(name) === value)
}

function hasExactSameOriginUrl(url, pathname) {
  return url.origin === appOrigin && url.pathname === pathname &&
    !url.username && !url.password && !url.search && !url.hash
}

let calls = 0
const routes = []
process.on('exit', () => {
  console.error(`TEST_FETCH_CALLS=${calls}`)
  console.error(`TEST_FETCH_ROUTES=${routes.length === 0 ? 'none' : routes.join(',')}`)
})
globalThis.fetch = async (input, init = {}) => {
  calls += 1
  const url = String(input)
  let requestUrl = new URL(url)
  if (
    scenario === 'meting-request-cross-origin' &&
    requestUrl.pathname === '/api/providers/meting/resolve'
  ) {
    requestUrl = new URL('https://operator.meting.example/api/providers/meting/resolve')
  }
  if (
    scenario === 'meting-request-path-suffix' && requestUrl.pathname === metingMediaPath &&
    init.method === 'HEAD'
  ) {
    requestUrl = new URL(`${appOrigin}${metingMediaPath}/suffix`)
  }
  const isConfig = hasExactSameOriginUrl(requestUrl, '/api/providers/config')
  const isMetingResolve = hasExactSameOriginUrl(requestUrl, '/api/providers/meting/resolve')
  const isMetingMedia = hasExactSameOriginUrl(requestUrl, metingMediaPath)
  const isMetingPath = requestUrl.pathname.startsWith('/api/providers/meting/')
  if (calls === 1) {
    assertRequest(isConfig)
    assertRequest(
      init.method === 'GET' && init.cache === 'no-store' && init.redirect === 'error' &&
      init.body === undefined && hasExactHeaders(init, { accept: 'application/json' }),
    )
    routes.push('config=1')
  } else if (isMetingPath && !isMetingResolve && !isMetingMedia) {
    assertRequest(false)
  }
  if (isMetingResolve) routes.push('meting-resolve=1')
  else if (isMetingMedia) {
    routes.push(`meting-media-${init.method === 'HEAD' ? 'head' : 'range'}=1`)
  }
  if (calls === 1) {
    if (scenario === 'timeout-config') {
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('sensitive-timeout-detail')), {
          once: true,
        })
      })
    }
    if (scenario === 'network-error-config') throw new Error('sensitive-network-detail')
    if (scenario === 'extra-root-config') {
      return response(url, JSON.stringify({ ...validConfig, secret: 'must-be-rejected' }))
    }
    if (scenario === 'bad-version-config') {
      return response(url, JSON.stringify({ ...validConfig, version: 2 }))
    }
    if (scenario === 'oversized-config') {
      return response(url, `${' '.repeat(65_537)}${JSON.stringify(validConfig)}`)
    }
    if (scenario === 'declared-oversized-config') {
      return response(url, JSON.stringify(validConfig), 'application/json', {
        'content-length': '65537',
      })
    }
    if (scenario === 'redirected-config') {
      return response(url, JSON.stringify(validConfig), 'application/json', {}, true)
    }
    if (scenario === 'html-config') {
      return response(url, JSON.stringify(validConfig), 'text/html')
    }
    if (scenario === 'unknown-provider-config') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [...validProviders, { id: 'custom', available: true, enabled: true, priority: 1 }],
      }))
    }
    if (scenario === 'legacy-meting-provider-config') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{ id: 'public-meting', available: false, enabled: false, priority: 6 }],
      }))
    }
    if (scenario === 'duplicate-provider-config') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [...validProviders, validProviders[0]],
      }))
    }
    if (scenario === 'nonboolean-provider-config') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{ id: 'youtube', available: 'true', enabled: true, priority: 2 }],
      }))
    }
    if (scenario === 'bad-priority-config') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{ id: 'youtube', available: true, enabled: true, priority: 1.5 }],
      }))
    }
    if (scenario === 'extra-provider-key-config') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'youtube', available: true, enabled: true, priority: 2, endpoint: 'https://evil.invalid',
        }],
      }))
    }
    if (scenario === 'r2-missing-config') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [
          ...validProviders,
          { id: 'r2', available: true, enabled: true, priority: 1 },
        ],
      }))
    }
    if (scenario === 'unavailable-r2-config') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'r2', available: false, enabled: false, priority: 1, config: validR2Config,
        }],
      }))
    }
    if (scenario === 'non-r2-config') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'youtube', available: true, enabled: true, priority: 2, config: validR2Config,
        }],
      }))
    }
    if (scenario === 'r2-extra-config-key') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'r2', available: true, enabled: true, priority: 1,
          config: { ...validR2Config, token: 'must-be-rejected' },
        }],
      }))
    }
    if (scenario === 'r2-query-base-url') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'r2', available: true, enabled: true, priority: 1,
          config: { ...validR2Config, baseUrl: `${validR2Config.baseUrl}?signature=secret` },
        }],
      }))
    }
    if (scenario === 'r2-http-base-url') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'r2', available: true, enabled: true, priority: 1,
          config: { ...validR2Config, baseUrl: 'http://media.preview.example.invalid/smoke/' },
        }],
      }))
    }
    if (scenario === 'r2-credential-base-url') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'r2', available: true, enabled: true, priority: 1,
          config: { ...validR2Config, baseUrl: 'https://user:secret@media.preview.example.invalid/smoke/' },
        }],
      }))
    }
    if (scenario === 'r2-port-base-url') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'r2', available: true, enabled: true, priority: 1,
          config: { ...validR2Config, baseUrl: 'https://media.preview.example.invalid:8443/smoke/' },
        }],
      }))
    }
    if (scenario === 'r2-hash-base-url') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'r2', available: true, enabled: true, priority: 1,
          config: { ...validR2Config, baseUrl: `${validR2Config.baseUrl}#private` },
        }],
      }))
    }
    if (scenario === 'r2-host-not-allowlisted') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'r2', available: true, enabled: true, priority: 1,
          config: { ...validR2Config, allowedHostnames: ['other.example.invalid'] },
        }],
      }))
    }
    if (scenario === 'r2-duplicate-allowlist') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'r2', available: true, enabled: true, priority: 1,
          config: {
            ...validR2Config,
            allowedHostnames: [
              'media.preview.example.invalid',
              'media.preview.example.invalid',
            ],
          },
        }],
      }))
    }
    if (scenario === 'r2-private-hostname') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [{
          id: 'r2', available: true, enabled: true, priority: 1,
          config: { baseUrl: 'https://media.internal/', allowedHostnames: ['media.internal'] },
        }],
      }))
    }
    if (scenario === 'r2-not-effective') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [
          { id: 'youtube', available: true, enabled: true, automaticEligible: false, priority: 90 },
          { id: 'r2', available: false, enabled: false, automaticEligible: false, priority: 1 },
          { id: 'chksz', available: true, enabled: true, automaticEligible: false, priority: 3, userKeySupported: true, ownerFallbackAvailable: false },
        ],
      }))
    }
    if (scenario === 'chksz-unavailable' || scenario === 'chksz-admin-disabled') {
      return response(url, JSON.stringify({
        version: 1,
        providers: [
          { id: 'youtube', available: true, enabled: true, automaticEligible: false, priority: 90 },
          { id: 'r2', available: true, enabled: true, automaticEligible: true, priority: 1, config: validR2Config },
          {
            id: 'chksz',
            userKeySupported: true,
            ownerFallbackAvailable: false,
            available: scenario === 'chksz-admin-disabled',
            enabled: false,
            automaticEligible: false,
            priority: 20,
          },
        ],
      }))
    }
    if (scenario === 'meting-admin-disabled') {
      return response(url, JSON.stringify({
        version: 1,
        providers: validProviders.map((provider) => provider.id === 'meting'
          ? { ...provider, available: true, enabled: false }
          : provider),
      }))
    }
    if (scenario.startsWith('meting-') || scenario === 'valid-meting-media') {
      return response(url, JSON.stringify({
        version: 1,
        providers: validProviders.map((provider) => provider.id === 'meting'
          ? { ...provider, available: true, enabled: true }
          : provider),
      }))
    }
    return response(url, JSON.stringify(validConfig))
  }

  if (requestUrl.hostname === 'media.preview.example.invalid') {
    if (init.method === 'HEAD') {
      if (scenario === 'r2-head-non-audio') return response(url, null, 'text/html')
      return response(url, null, 'audio/ogg', { 'accept-ranges': 'bytes' })
    }
    if (scenario === 'r2-range-redirected') {
      return response('https://attacker.example/private-object', null, 'audio/ogg', {
        'content-range': 'bytes 0-0/20',
      }, true, 206)
    }
    if (scenario === 'r2-bad-content-range') {
      return response(url, new Uint8Array([0]), 'audio/ogg', {
        'content-range': 'bytes 1-1/20',
      }, false, 206)
    }
    return response(url, new Uint8Array([0]), 'audio/ogg', {
      'accept-ranges': 'bytes',
      'content-range': 'bytes 0-0/20',
    }, false, 206)
  }

  if (isMetingResolve) {
    assertRequest(
      init.method === 'POST' && init.cache === 'no-store' && init.redirect === 'error' &&
      init.body === JSON.stringify({ externalId: 'netease:123456789' }) &&
      hasExactHeaders(init, {
        'content-type': 'application/json',
        origin: appOrigin,
      }),
    )
    const preparedValue = {
      url: scenario === 'meting-malformed-ticket'
        ? '/api/providers/meting/media/netease%253A123456789/abcdefghijklmnopqrstuvwxyzABCDEF'
        : scenario === 'meting-mismatched-ticket'
          ? '/api/providers/meting/media/tencent%3A123456789/abcdefghijklmnopqrstuvwxyzABCDEF'
          : '/api/providers/meting/media/netease%3A123456789/abcdefghijklmnopqrstuvwxyzABCDEF',
      mimeType: scenario === 'meting-uppercase-prepared-mime' ? 'Audio/MPEG' : 'audio/mpeg',
    }
    return response(url, JSON.stringify(preparedValue))
  }

  if (isMetingMedia) {
    if (init.method === 'HEAD') {
      assertRequest(
        init.cache === 'no-store' && init.redirect === 'error' && init.body === undefined &&
        hasExactHeaders(init, {}),
      )
      if (scenario === 'meting-head-non-audio') return response(url, null, 'text/html')
      if (scenario === 'meting-head-405') return response(url, null, 'audio/mpeg', {}, false, 405)
      if (scenario === 'meting-head-501') return response(url, null, 'audio/mpeg', {}, false, 501)
      if (scenario === 'meting-head-mime-mismatch') return response(url, null, 'audio/ogg')
      if (scenario === 'meting-head-redirected') {
        return response('https://operator.meting.example/private-media', null, 'audio/mpeg', {}, true)
      }
      return response(url, null, 'audio/mpeg', { 'accept-ranges': 'bytes' })
    }
    assertRequest(
      init.method === 'GET' && init.cache === 'no-store' && init.redirect === 'error' &&
      init.body === undefined && hasExactHeaders(init, { range: 'bytes=0-0' }),
    )
    if (scenario === 'meting-range-200-no-content-range') {
      return response(url, new Uint8Array([0]), 'audio/mpeg', {}, false, 200)
    }
    if (scenario === 'meting-range-200-with-content-range') {
      return response(url, new Uint8Array([0]), 'audio/mpeg', {
        'content-range': 'bytes 0-0/20',
      }, false, 200)
    }
    if (scenario === 'meting-range-206-no-content-range') {
      return response(url, new Uint8Array([0]), 'audio/mpeg', {}, false, 206)
    }
    if (scenario === 'meting-range-206-malformed-content-range') {
      return response(url, new Uint8Array([0]), 'audio/mpeg', {
        'content-range': 'bytes nope',
      }, false, 206)
    }
    if (scenario === 'meting-range-206-wrong-start') {
      return response(url, new Uint8Array([0]), 'audio/mpeg', {
        'content-range': 'bytes 1-1/20',
      }, false, 206)
    }
    if (scenario === 'meting-range-206-wildcard-total') {
      return response(url, new Uint8Array([0]), 'audio/mpeg', {
        'content-range': 'bytes 0-0/*',
      }, false, 206)
    }
    if (scenario === 'meting-range-mime-mismatch') {
      return response(url, new Uint8Array([0]), 'audio/ogg', {
        'content-range': 'bytes 0-0/20',
      }, false, 206)
    }
    if (scenario === 'meting-bad-content-range') {
      return response(url, new Uint8Array([0]), 'audio/mpeg', {
        'content-range': 'bytes 1-1/20',
      }, false, 206)
    }
    return response(url, new Uint8Array([0]), 'audio/mpeg', {
      'accept-ranges': 'bytes',
      'content-range': 'bytes 0-0/20',
    }, false, 206)
  }

  if (requestUrl.pathname === '/api/providers/chksz/resolve') {
    if (scenario === 'network-error-resolve') throw new Error('sensitive-resolve-detail')
    const preparedValue = {
      url: scenario === 'credential-resolve'
        ? 'https://user:password@preview.example.invalid/api/providers/chksz/media/opaque'
        : scenario === 'cross-origin-resolve'
          ? 'https://attacker.example/api/providers/chksz/media/opaque'
          : scenario === 'wrong-path-resolve'
            ? `${appOrigin}/api/providers/other/media/opaque`
            : scenario === 'mismatched-media-id-resolve'
              ? `${appOrigin}/api/providers/chksz/media/9000000003/abcdefghijklmnopqrstuvwxyzABCDEF`
              : scenario === 'bad-nonce-resolve'
                ? `${appOrigin}/api/providers/chksz/media/1315196858/short-nonce`
                : scenario === 'missing-nonce-resolve'
                  ? `${appOrigin}/api/providers/chksz/media/1315196858/`
                  : scenario === 'oversized-nonce-resolve'
                    ? `${appOrigin}/api/providers/chksz/media/1315196858/abcdefghijklmnopqrstuvwxyzABCDEFG`
                    : scenario === 'encoded-path-confusion-resolve'
                      ? `${appOrigin}/api/providers/chksz/media/1315196858/extra/%2e%2e/abcdefghijklmnopqrstuvwxyzABCDEF`
                : scenario === 'query-resolve'
                  ? `${appOrigin}/api/providers/chksz/media/1315196858/abcdefghijklmnopqrstuvwxyzABCDEF?download=1`
                  : scenario === 'trailing-segment-resolve'
                    ? `${appOrigin}/api/providers/chksz/media/1315196858/abcdefghijklmnopqrstuvwxyzABCDEF/extra`
                    : scenario === 'hash-resolve'
                      ? `${appOrigin}/api/providers/chksz/media/opaque#fragment`
                      : `${appOrigin}/api/providers/chksz/media/1315196858/abcdefghijklmnopqrstuvwxyzABCDEF`,
      mimeType: scenario === 'empty-audio-subtype' ? 'audio/' : 'audio/mpeg',
      ...(scenario === 'extra-resolve-key' ? { upstream: 'must-be-rejected' } : {}),
    }
    const prepared = JSON.stringify(preparedValue)
    if (scenario === 'html-resolve') return response(url, prepared, 'text/html')
    if (scenario === 'oversized-resolve') {
      return response(url, `${' '.repeat(65_537)}${prepared}`)
    }
    if (scenario === 'declared-oversized-resolve') {
      return response(url, prepared, 'application/json', { 'content-length': '65537' })
    }
    if (scenario === 'redirected-resolve') {
      return response(url, prepared, 'application/json', {}, true)
    }
    if (scenario === 'rate-limited-resolve') {
      return response(url, JSON.stringify({ error: 'rate_limited' }), 'application/json', {}, false, 429)
    }
    return response(url, prepared)
  }

  if (requestUrl.pathname.startsWith('/api/providers/chksz/media/')) {
    if (init.method === 'HEAD') {
      if (scenario === 'chksz-media-rate-limited') {
        return response(url, null, 'application/json', {}, false, 429)
      }
      if (scenario === 'chksz-head-non-audio') return response(url, null, 'text/html')
      if (scenario === 'chksz-head-redirected') {
        return response('https://sensitive.music.126.net/hidden', null, 'audio/mpeg', {}, true)
      }
      return response(url, null, 'audio/mpeg', { 'accept-ranges': 'bytes' })
    }
    if (scenario === 'chksz-range-cross-origin') {
      return response('https://sensitive.music.126.net/hidden', new Uint8Array([0]), 'audio/mpeg', {
        'content-range': 'bytes 0-0/20',
      }, true, 206)
    }
    if (scenario === 'chksz-bad-content-range') {
      return response(url, new Uint8Array([0]), 'audio/mpeg', {
        'content-range': 'bytes 1-1/20',
      }, false, 206)
    }
    return response(url, new Uint8Array([0]), 'audio/mpeg', {
      'accept-ranges': 'bytes',
      'content-range': 'bytes 0-0/20',
    }, false, 206)
  }

  throw new Error('unexpected smoke fixture request')
}
