// Wave E preservation (task 18, design Property 2, requirement 3.6). Observation-first: every
// expectation below was observed on the unfixed tree (ee34b3b) and must still hold after H-01 adds
// the csp_blocked check (D1 = B) to lx.request and to returned media URLs.
//
// Sandbox-compliant traffic here only targets origins that EVERY build's CSP already lists, so the
// H-01 check must let it through whatever LX_ALLOWED_ORIGINS holds: lx.request goes to the
// connect-src origin https://api.chksz.com and media URLs use the media-src family
// https://*.music.126.net. Refusals are asserted as "refused before any network use", not by their
// message, because H-01 may run its origin check before the protocol or method check.
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Track } from '../../../catalog/types'
import { createLxUserProvider } from '../../providers/lxUser'
import type { ProviderAttempt } from '../../providers/types'
import type { LxSourceRecord, LxSourceRepository } from '../types'
import type { LxRuntimeClient } from './client'
import { LX_HTTP_MAX_RESPONSE_BYTES, validateWorkerRequest } from './protocol'
import { QuickJsLxHost } from './quickjsHost'

const LISTED_API = 'https://api.chksz.com'
const FORBIDDEN = ['cookie', 'cookie2', 'authorization', 'proxy-authorization', 'proxy-authenticate', 'origin', 'referer',
  'host', 'connection', 'keep-alive', 'upgrade', 'sec-fetch-mode', 'sec-ch-ua', 'proxy-anything']

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs one lx.request from inside the guest and returns what its callback saw. */
const guestRequest = async (host: QuickJsLxHost, url: string, options: Record<string, unknown>) => {
  await host.evalCode(`globalThis.__p = null; lx.request(${JSON.stringify(url)}, ${JSON.stringify(options)}, (err, resp) => {
    globalThis.__p = err ? { error: String(err.message) } : { status: resp.statusCode, body: resp.body, headers: resp.headers }
  })`)
  for (let wait = 0; wait < 200 && (await host.evalCode('globalThis.__p')) === null; wait++) await sleep(5)
  return (await host.evalCode('globalThis.__p')) as { error?: string; status?: number; body?: unknown } | null
}

describe('LX sandbox limits are unchanged (requirement 3.6)', () => {
  let host: QuickJsLxHost
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()

  beforeAll(async () => {
    host = await QuickJsLxHost.create({ fetch: fetch as unknown as typeof globalThis.fetch })
  })
  afterAll(() => {
    host.dispose()
  })

  it('exposes no DOM, storage, network or code-generation globals and refuses every constructor escape', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('window', 'document', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'XMLHttpRequest',
          'WebSocket', 'importScripts', 'navigator', 'location', 'eval', 'Function', 'caches', 'postMessage'),
        async (name) => {
          expect(await host.evalCode(`typeof ${name}`), name).toBe('undefined')
        },
      ),
      { numRuns: 30 },
    )
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('(function(){})', '(async function(){})', '(function*(){})', '(async function*(){})', '(() => 0)', '({ m(){} }).m'),
        fc.constantFrom('constructor', "['constructor']"),
        async (fn, access) => {
          const code = access.startsWith('[') ? `${fn}${access}("return 1")()` : `${fn}.${access}("return 1")()`
          await expect(host.evalCode(code), code).rejects.toThrow()
        },
      ),
      { numRuns: 20 },
    )
  })

  it('refuses non-HTTPS targets and methods other than GET and POST before any network use', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.tuple(fc.constantFrom('http', 'ws', 'wss', 'ftp', 'file', 'data', 'javascript', 'blob'), fc.stringMatching(/^[a-z][a-z0-9]{1,10}$/u))
            .map(([scheme, host]) => ({ url: `${scheme}://${host}.example/x`, method: 'GET' })),
          fc.oneof(fc.constantFrom('PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'), fc.stringMatching(/^[A-Z]{3,8}$/u).filter((value) => value !== 'GET' && value !== 'POST'))
            .map((method) => ({ url: `${LISTED_API}/v1/test`, method })),
        ),
        async ({ url, method }) => {
          fetch.mockReset()
          const result = await guestRequest(host, url, { method })
          expect(result?.error, `${method} ${url}`).toEqual(expect.any(String))
          expect(fetch).not.toHaveBeenCalled()
        },
      ),
      { numRuns: 40 },
    )
  })

  it('sends a compliant request without credentials or redirects, strips forbidden headers and returns the response', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('GET', 'POST', 'get', 'post'),
        fc.stringMatching(/^[a-z0-9]{1,12}$/u),
        fc.subarray(FORBIDDEN, { minLength: 1 }),
        fc.dictionary(fc.stringMatching(/^x-[a-z]{1,10}$/u), fc.stringMatching(/^[A-Za-z0-9]{1,16}$/u), { minKeys: 1, maxKeys: 3 }),
        fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/u), fc.integer(), { maxKeys: 3 }),
        async (method, pathPart, forbidden, custom, payload) => {
          fetch.mockReset()
          fetch.mockImplementation(async () => Response.json({ ok: true, echo: pathPart }))
          const headers = { ...custom, ...Object.fromEntries(forbidden.map((name) => [name.replace(/^./u, (c) => c.toUpperCase()), 'leak'])) }
          const result = await guestRequest(host, `${LISTED_API}/${pathPart}`, { method, headers, ...(method.toUpperCase() === 'POST' ? { json: payload } : {}) })
          expect(result).toMatchObject({ status: 200, body: { ok: true, echo: pathPart } })
          expect(fetch).toHaveBeenCalledTimes(1)
          const [url, init] = fetch.mock.calls[0]
          expect(url).toBe(`${LISTED_API}/${pathPart}`)
          expect(init.method).toBe(method.toUpperCase())
          expect(init.credentials).toBe('omit')
          expect(init.redirect).toBe('error')
          const sent = new Headers(init.headers)
          for (const name of forbidden) expect(sent.has(name), name).toBe(false)
          for (const [name, value] of Object.entries(custom)) expect(sent.get(name)).toBe(value)
          if (method.toUpperCase() === 'POST') expect(JSON.parse(String(init.body))).toEqual(payload)
        },
      ),
      { numRuns: 25 },
    )
  })

  it('refuses responses above the 1 MiB limit, by Content-Length or by body', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 4096 }), fc.boolean(), async (excess, declared) => {
        fetch.mockReset()
        const body = new Uint8Array(LX_HTTP_MAX_RESPONSE_BYTES + excess)
        fetch.mockImplementation(async () => new Response(body, declared ? { headers: { 'content-length': String(body.byteLength) } } : {}))
        const result = await guestRequest(host, `${LISTED_API}/large`, {})
        expect(result?.error).toMatch(/exceeds maximum size/u)
      }),
      { numRuns: 6 },
    )
  })

  it('accepts a load request up to 512 KiB and refuses anything longer', () => {
    fc.assert(
      fc.property(fc.integer({ min: -64, max: 64 }), (offset) => {
        const length = 512 * 1024 + offset
        const result = validateWorkerRequest({ type: 'load', id: 'size', script: 'x'.repeat(length) })
        expect(result.valid, `length ${length}`).toBe(length <= 512 * 1024)
      }),
      { numRuns: 60 },
    )
  })

  it('interrupts a runaway loop at the call timeout and refuses unbounded recursion, staying usable', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 50, max: 250 }), async (callTimeoutMs) => {
        const limited = await QuickJsLxHost.create({ callTimeoutMs })
        try {
          const started = Date.now()
          await expect(limited.evalCode('while (true) {}')).rejects.toThrow()
          expect(Date.now() - started).toBeLessThan(callTimeoutMs + 1500)
          await expect(limited.evalCode('function f(n) { return f(n + 1) + 1 } f(0)')).rejects.toThrow()
          expect(await limited.evalCode('1 + 1')).toBe(2)
        } finally {
          limited.dispose()
        }
      }),
      { numRuns: 3 },
    )
  })

  it('refuses an allocation beyond the VM memory limit', async () => {
    // Observed on the unfixed tree: after an out-of-memory error the runtime cannot be freed cleanly
    // (QuickJS asserts in JS_FreeRuntime), so this host is deliberately not reused or disposed.
    const limited = await QuickJsLxHost.create()
    await expect(limited.evalCode("let s = 'x'; while (true) s = s + s")).rejects.toThrow()
  }, 30_000)
})

describe('LX provider still rejects results that need custom request headers (requirement 3.6)', () => {
  const track: Track = {
    id: 'track-p36',
    title: 'P36 Fixture',
    aliases: {},
    games: ['genshin'],
    relationIds: [],
    tabs: ['focus'],
    workGroupId: 'wg-p36',
    needsClassification: false,
    vocalStatus: 'instrumental',
    sources: [{ provider: 'chksz', externalId: '1315196858' }],
  }
  const source: LxSourceRecord = {
    id: 'builtin-p36-fixture', name: 'P36 Fixture', sha256: 'sha256-p36', enabled: true, priority: 0,
    script: '// fixture', builtIn: true, importedAt: 1, updatedAt: 1,
  }
  const repository = {
    list: async () => [source],
    get: async () => source,
    setEnabled: async () => undefined,
    reorder: async () => undefined,
    delete: async () => undefined,
    importScript: vi.fn(),
    importRemote: vi.fn(),
    refreshRemote: vi.fn(),
  } as unknown as LxSourceRepository
  // The ChKSz media family is in media-src in every build.
  const listedMedia = fc.tuple(fc.stringMatching(/^m[0-9]{1,3}[a-z]?$/u), fc.stringMatching(/^[a-z0-9]{1,12}$/u))
    .map(([shard, file]) => `https://${shard}.music.126.net/${file}.mp3`)

  const resolveWith = async (result: { url: string; requestHeaders?: Record<string, string> }) => {
    const attempts: ProviderAttempt[] = []
    const provider = createLxUserProvider({
      sourceRepository: repository,
      qualityStore: { lxQuality: () => 'standard' },
      onSubAttempt: (attempt) => attempts.push(attempt),
      runtimeClientFactory: () => ({
        loadSource: async () => ({ initedMeta: undefined }),
        callMusicUrl: async () => result,
        dispose: async () => undefined,
      }) as unknown as LxRuntimeClient,
    })
    return { playable: await provider.resolve(track, new AbortController().signal), attempts }
  }

  it('never plays a media URL that needs custom request headers', async () => {
    await fc.assert(
      fc.asyncProperty(listedMedia, fc.dictionary(fc.constantFrom('Referer', 'User-Agent', 'X-Token', 'Cookie'), fc.stringMatching(/^[a-z0-9]{1,10}$/u), { minKeys: 1 }), async (url, requestHeaders) => {
        const { playable, attempts } = await resolveWith({ url, requestHeaders })
        expect(playable).toBeNull()
        expect(attempts.some((attempt) => attempt.ok)).toBe(false)
      }),
      { numRuns: 15 },
    )
  })

  it('plays a header-free HTTPS media URL on a CSP-listed origin unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(listedMedia, async (url) => {
        const { playable, attempts } = await resolveWith({ url })
        expect(playable).toEqual({ kind: 'audio', url, mimeType: 'audio/mpeg' })
        expect(attempts.map((attempt) => attempt.ok)).toEqual([true])
      }),
      { numRuns: 15 },
    )
  })
})
