import { describe, it, expect, vi, afterEach } from 'vitest'
import { QuickJsLxHost } from './quickjsHost'
import { LxRuntimeClient } from './client'
import { setupWorkerHandler } from './worker'
import { LX_HTTP_MAX_RESPONSE_BYTES, LX_NETWORK_ERROR } from './protocol'

// H-01: lx.request is checked against the build's connect-src. These cases exercise the sandbox's
// request plumbing against fixture hosts, so they inject a connect list naming those hosts (the
// fixture API) instead of relying on the build.
const FIXTURE_CSP = {
  connect: ['https://api.example.com'],
  media: [],
}

describe('QuickJsLxHost Sandbox', () => {
  let host: QuickJsLxHost | null = null

  afterEach(() => {
    if (host) {
      host.dispose()
      host = null
    }
  })

  it('proves no window, document, localStorage, DOM, fetch or XMLHttpRequest in sandbox', async () => {
    host = await QuickJsLxHost.create()

    expect(await host.evalCode('typeof window')).toBe('undefined')
    expect(await host.evalCode('typeof document')).toBe('undefined')
    expect(await host.evalCode('typeof localStorage')).toBe('undefined')
    expect(await host.evalCode('typeof sessionStorage')).toBe('undefined')
    expect(await host.evalCode('typeof fetch')).toBe('undefined')
    expect(await host.evalCode('typeof XMLHttpRequest')).toBe('undefined')
  })

  it('proves eval and Function constructors are disabled', async () => {
    host = await QuickJsLxHost.create()

    expect(await host.evalCode('typeof eval')).toBe('undefined')
    expect(await host.evalCode('typeof Function')).toBe('undefined')

    await expect(host.evalCode('eval("1 + 1")')).rejects.toThrow()
    await expect(host.evalCode('(function(){}).constructor("return 1")()')).rejects.toThrow()
    await expect(host.evalCode('(async function(){}).constructor("return 1")()')).rejects.toThrow()
    await expect(host.evalCode('(function*(){}).constructor("return 1")()')).rejects.toThrow()
  })

  it('exposes minimal lx metadata, redacted console, and buffer utilities', async () => {
    host = await QuickJsLxHost.create()

    expect(await host.evalCode('lx.version')).toBe('2.0.0')
    expect(await host.evalCode('lx.env')).toBe('desktop')
    expect(await host.evalCode('lx.EVENT_NAMES.request')).toBe('request')
    expect(await host.evalCode('lx.EVENT_NAMES.inited')).toBe('inited')
    expect(await host.evalCode('lx.EVENT_NAMES.updateAlert')).toBe('updateAlert')

    // Console functions are no-ops
    expect(await host.evalCode('typeof console.log')).toBe('function')
    expect(await host.evalCode('console.log("secret-test"); 1')).toBe(1)

    // Buffer utility
    expect(await host.evalCode('lx.utils.buffer.from("hello").toString()')).toBe('hello')
    expect(await host.evalCode('lx.utils.buffer.from("48656c6c6f", "hex").toString()')).toBe('Hello')
    expect(await host.evalCode('lx.utils.buffer.from("SGVsbG8=", "base64").toString()')).toBe('Hello')
  })

  it('handles bounded setTimeout in sandbox', async () => {
    host = await QuickJsLxHost.create()

    const script = `
      let timeoutFired = false;
      setTimeout(() => {
        timeoutFired = true;
      }, 10);
    `
    await host.evalCode(script)
    await new Promise((r) => setTimeout(r, 40))
    expect(await host.evalCode('timeoutFired')).toBe(true)
  })

  describe('Controlled HTTP Bridge', () => {
    it('rejects non-HTTPS URLs', async () => {
      const mockFetch = vi.fn()
      host = await QuickJsLxHost.create({ fetch: mockFetch as unknown as typeof fetch, cspSources: FIXTURE_CSP })

      const script = `
        let errResult = null;
        lx.request('http://insecure.example.com/api', {}, (err, resp) => {
          errResult = err;
        });
      `
      await host.evalCode(script)
      await new Promise((r) => setTimeout(r, 20))
      const err = (await host.evalCode('errResult')) as { message: string }
      expect(err).toBeTruthy()
      expect(err.message).toContain('Only HTTPS is supported')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('rejects disallowed HTTP methods', async () => {
      const mockFetch = vi.fn()
      host = await QuickJsLxHost.create({ fetch: mockFetch as unknown as typeof fetch, cspSources: FIXTURE_CSP })

      const script = `
        let errResult = null;
        lx.request('https://api.example.com/delete', { method: 'DELETE' }, (err, resp) => {
          errResult = err;
        });
      `
      await host.evalCode(script)
      await new Promise((r) => setTimeout(r, 20))
      const err = (await host.evalCode('errResult')) as { message: string }
      expect(err).toBeTruthy()
      expect(err.message).toContain('HTTP method DELETE is not allowed')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('strips forbidden headers like cookie and authorization', async () => {
      let interceptedHeaders: Headers | null = null
      const mockFetch = vi.fn().mockImplementation((url, init) => {
        interceptedHeaders = init.headers
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
      })

      host = await QuickJsLxHost.create({ fetch: mockFetch as unknown as typeof fetch, cspSources: FIXTURE_CSP })

      const script = `
        let respResult = null;
        lx.request('https://api.example.com/test', {
          method: 'GET',
          headers: {
            'Authorization': 'Bearer secret-token',
            'Cookie': 'session=abc',
            'X-Custom-Header': 'allowed-value',
            'Sec-Fetch-Mode': 'cors',
            'Proxy-Authorization': 'basic xyz',
          }
        }, (err, resp) => {
          respResult = resp;
        });
      `
      await host.evalCode(script)
      await new Promise((r) => setTimeout(r, 30))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(interceptedHeaders).not.toBeNull()
      expect(interceptedHeaders!.has('authorization')).toBe(false)
      expect(interceptedHeaders!.has('cookie')).toBe(false)
      expect(interceptedHeaders!.has('sec-fetch-mode')).toBe(false)
      expect(interceptedHeaders!.has('proxy-authorization')).toBe(false)
      expect(interceptedHeaders!.get('x-custom-header')).toBe('allowed-value')

      const resp = (await host.evalCode('respResult')) as { statusCode: number; body: { ok: boolean } }
      expect(resp.statusCode).toBe(200)
      expect(resp.body).toEqual({ ok: true })
    })

    it('rejects responses larger than 1 MiB', async () => {
      // Create response larger than 1 MiB
      const largeContent = new Uint8Array(1024 * 1024 + 100)
      const mockFetch = vi.fn().mockResolvedValue(new Response(largeContent, {
        status: 200,
        headers: { 'content-length': String(largeContent.byteLength) },
      }))

      host = await QuickJsLxHost.create({ fetch: mockFetch as unknown as typeof fetch, cspSources: FIXTURE_CSP })

      const script = `
        let errResult = null;
        lx.request('https://api.example.com/large-file', {}, (err, resp) => {
          errResult = err;
        });
      `
      await host.evalCode(script)
      await new Promise((r) => setTimeout(r, 30))

      const err = (await host.evalCode('errResult')) as { message: string }
      expect(err).toBeTruthy()
      expect(err.message).toContain('Response exceeds maximum size')
    })

    const requestError = async (fetchImpl: typeof fetch, options: string = '{}'): Promise<string> => {
      host = await QuickJsLxHost.create({ fetch: fetchImpl, cspSources: FIXTURE_CSP, callTimeoutMs: 200 })
      await host.evalCode(`
        let errResult = null;
        lx.request('https://api.example.com/drop', ${options}, (err) => { errResult = err; });
      `)
      for (let i = 0; i < 50 && (await host.evalCode('errResult')) === null; i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
      return ((await host.evalCode('errResult')) as { message: string }).message
    }

    it('prefixes a rejected host fetch with the network_error marker (task 41.7)', async () => {
      const message = await requestError((async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch)
      expect(message).toBe(`${LX_NETWORK_ERROR}: Failed to fetch`)
    })

    it('reports its own request timeout without the network_error marker', async () => {
      const hanging = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
      const message = await requestError(hanging, '{ timeout: 20 }')
      expect(message).toBe('HTTP request timed out after 20ms')
    })

    it('keeps an upstream 5xx a response, not a network error', async () => {
      host = await QuickJsLxHost.create({
        fetch: (async () => new Response('down', { status: 503 })) as unknown as typeof fetch,
        cspSources: FIXTURE_CSP,
      })
      await host.evalCode(`
        let result = null;
        lx.request('https://api.example.com/down', {}, (err, resp) => { result = { err, status: resp && resp.statusCode }; });
      `)
      await new Promise((r) => setTimeout(r, 30))
      expect(await host.evalCode('result')).toEqual({ err: null, status: 503 })
    })
  })

  describe('Source Registration and musicUrl Resolution', () => {
    it('registers event handler and returns direct string URL', async () => {
      host = await QuickJsLxHost.create()

      const script = `
        lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
          if (action === 'musicUrl') {
            return 'https://cdn.example.com/' + source + '/' + info.musicInfo.id + '.mp3';
          }
        });
      `
      await host.loadSource(script)

      const result = await host.callMusicUrl('wy', { id: '12345' }, 'standard')
      expect(result).toEqual({
        url: 'https://cdn.example.com/wy/12345.mp3',
        actualQuality: 'standard',
        requestHeaders: undefined,
      })
    })

    it('exposes the MeloX musicInfo self-reference inside the guest', async () => {
      // The host-side payload must stay serializable, so the self-reference is created by
      // __lxDispatchMusicUrl inside the guest. Scripts in the wild read info.musicInfo.musicInfo,
      // so removing it guest-side would break them just as badly as the cyclic wire payload did.
      host = await QuickJsLxHost.create()

      const script = `
        lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
          if (action === 'musicUrl') {
            if (info.musicInfo.musicInfo !== info.musicInfo) {
              throw new Error('musicInfo self-reference missing');
            }
            return 'https://cdn.example.com/' + source + '/' + info.musicInfo.id + '.mp3';
          }
        });
      `
      await host.loadSource(script)

      const result = await host.callMusicUrl('wy', { id: '999' }, 'standard')
      expect(result).toMatchObject({ url: 'https://cdn.example.com/wy/999.mp3' })
    })

    // Deliberately changed by M-11 (task 23.5): this used to pin `requestHeaders` passthrough. The
    // media element cannot send custom headers (3.6), so the sandbox now refuses such a result with
    // the `invalid_response` prefix instead of handing the headers to the provider.
    it('refuses an async handler result that needs custom headers with invalid_response', async () => {
      host = await QuickJsLxHost.create()

      const script = `
        lx.on(lx.EVENT_NAMES.request, async ({ source, action, info }) => {
          if (action === 'musicUrl') {
            return {
              url: 'https://cdn.example.com/' + info.musicInfo.id + '.flac',
              headers: {
                'User-Agent': 'CustomAudioPlayer',
                'Referer': 'https://music.example.com'
              },
              quality: 'lossless'
            };
          }
        });
      `
      await host.loadSource(script)

      await expect(host.callMusicUrl('tx', { id: 'track_999' }, 'flac'))
        .rejects.toThrow(/invalid_response: media URL needs custom request headers/)
    })

    it('rejects musicUrl with unsupported URL scheme (e.g. javascript:, ftp:)', async () => {
      host = await QuickJsLxHost.create()

      const script = `
        lx.on(lx.EVENT_NAMES.request, ({ action }) => {
          if (action === 'musicUrl') {
            return 'javascript:alert(1)';
          }
        });
      `
      await host.loadSource(script)

      await expect(
        host.callMusicUrl('wy', { id: '123' }, 'standard'),
      ).rejects.toThrow(/Unsupported media URL scheme/i)
    })

    it('supports send(inited) metadata extraction', async () => {
      host = await QuickJsLxHost.create()

      const script = `
        lx.send(lx.EVENT_NAMES.inited, {
          openDevTools: false,
          sources: {
            wy: { name: 'NetEase', qualitys: ['128k', '320k', 'flac'] }
          }
        });
      `
      const { initedMeta } = await host.loadSource(script)
      expect(initedMeta).toEqual({
        openDevTools: false,
        sources: {
          wy: { name: 'NetEase', qualitys: ['128k', '320k', 'flac'] },
        },
      })
    })

    it('rejects a plaintext media URL returned by an original synthetic source', async () => {
      host = await QuickJsLxHost.create({ cspSources: FIXTURE_CSP })
      const script = `
        lx.on(lx.EVENT_NAMES.request, () => 'http://media.example.invalid/synthetic.mp3');
        lx.send(lx.EVENT_NAMES.inited, {
          sources: { wy: { name: 'Synthetic Source', qualitys: ['128k'] } }
        });
      `
      const { initedMeta } = await host.loadSource(script)
      expect(initedMeta).toBeTruthy()
      expect((initedMeta as { sources?: Record<string, unknown> }).sources).toHaveProperty('wy')
      await expect(host.callMusicUrl('wy', { songmid: 'synthetic-track' }, '128k'))
        .rejects.toThrow(/^invalid_response: plaintext http: media URL/)
    })
  })

  describe('Timeout and Interruption', () => {
    it('interrupts infinite CPU loop within deadline', async () => {
      host = await QuickJsLxHost.create({ callTimeoutMs: 150 })

      await expect(host.evalCode('while(true) {}')).rejects.toThrow()
    })
  })
})

// Wave F exploration (task 21, design Property 12, M-11). These encode the expected behaviour and
// are expected to FAIL on the unfixed tree (3a30d77).
describe('M-11 LX sandbox limits everywhere (Property 12)', () => {
  let host: QuickJsLxHost | null = null
  let client: LxRuntimeClient | null = null
  afterEach(async () => {
    if (host) { host.dispose(); host = null }
    if (client) { await client.dispose(); client = null }
  })
  /** Resolves with the longest single event-loop stall seen while `waitMs` elapses. */
  const longestStall = async (waitMs: number) => {
    let last = performance.now()
    let longest = 0
    const end = last + waitMs
    while (performance.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }
    return longest
  }
  it('interrupts a CPU-bound guest timer callback within the call deadline', async () => {
    // A bounded 3-second busy loop stands in for `for(;;){}`: on the unfixed tree a truly infinite
    // loop would block this test process forever, so the counterexample could not be recorded.
    const deadlineMs = 150
    host = await QuickJsLxHost.create({ callTimeoutMs: deadlineMs })
    await host.loadSource(`
      lx.send(lx.EVENT_NAMES.inited, { sources: {} });
      setTimeout(function () { var end = Date.now() + 3000; while (Date.now() < end) {} }, 0);
    `)
    const stall = await longestStall(400)
    expect(stall).toBeLessThan(deadlineMs + 750)
  })
  it('caps the number of concurrently active guest timers', async () => {
    host = await QuickJsLxHost.create()
    const outcome = await host.evalCode(`
      (function () {
        var created = 0, error = null;
        for (var i = 0; i < 1000; i++) {
          try { setTimeout(function () {}, 50); created++; }
          catch (e) { error = String((e && e.message) || e); break; }
        }
        return { created: created, error: error };
      })()
    `) as { created: number; error: string | null }
    // Let every admitted timer fire before dispose: the unfixed dispose() leaks the duplicated
    // callback handles of pending timers, which aborts QuickJS and poisons later tests in this file.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(outcome.created).toBeLessThan(1000)
    expect(outcome.error).not.toBeNull()
  })
  it('stops reading a chunked body after the byte limit plus one chunk and cancels the reader', async () => {
    const CHUNK = 64 * 1024
    const TOTAL = LX_HTTP_MAX_RESPONSE_BYTES * 2
    let pulled = 0
    let cancelled = false
    const mockFetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= TOTAL) { controller.close(); return }
        pulled += CHUNK
        controller.enqueue(new Uint8Array(CHUNK))
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'application/octet-stream' } }))
    host = await QuickJsLxHost.create({ fetch: mockFetch as unknown as typeof fetch, cspSources: FIXTURE_CSP })
    await host.evalCode(`
      var chunkedErr = null;
      lx.request('https://api.example.com/chunked', {}, function (err) { chunkedErr = err; });
    `)
    let err: { message: string } | null = null
    for (let attempt = 0; attempt < 100 && !err; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      err = await host.evalCode('chunkedErr') as { message: string } | null
    }
    const observed = `pulled=${pulled} cancelled=${cancelled} err=${JSON.stringify(err)}`
    expect(pulled, observed).toBeLessThanOrEqual(LX_HTTP_MAX_RESPONSE_BYTES + CHUNK)
    expect(cancelled, observed).toBe(true)
    expect(err?.message ?? '').toMatch(/exceeds maximum size/)
  })
  it('rejects a plaintext http: media URL from musicUrl', async () => {
    host = await QuickJsLxHost.create()
    await host.loadSource(`
      lx.on(lx.EVENT_NAMES.request, function () { return 'http://cdn.example.com/plain.mp3'; });
    `)
    await expect(host.callMusicUrl('wy', { id: '1' }, '128k')).rejects.toThrow()
  })
  it('rejects a musicUrl result that needs custom request headers', async () => {
    host = await QuickJsLxHost.create()
    await host.loadSource(`
      lx.on(lx.EVENT_NAMES.request, function () {
        return { url: 'https://cdn.example.com/a.mp3', headers: { 'X-Custom-Auth': 'needed' } };
      });
    `)
    await expect(host.callMusicUrl('wy', { id: '1' }, '128k')).rejects.toThrow()
  })
  it('reloads the current source into a recreated Worker after a hung one is terminated', async () => {
    let created = 0
    const factory = () => {
      const index = created++
      const post = (worker: { terminated: boolean; onmessage: ((event: MessageEvent) => void) | null }) =>
        (message: unknown) => { if (!worker.terminated) worker.onmessage?.({ data: message } as MessageEvent) }
      const worker = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        onerror: null as ((event: ErrorEvent) => void) | null,
        onmessageerror: null as ((event: MessageEvent) => void) | null,
        terminated: false,
        handler: null as unknown as (data: unknown) => Promise<void>,
        postMessage(message: unknown) {
          if (this.terminated) throw new Error('Worker is terminated')
          const data = message as { type?: string; songInfo?: { id?: string } }
          // The first Worker hangs on one call, like a guest stuck outside every deadline.
          if (index === 0 && data.type === 'musicUrl' && data.songInfo?.id === 'hang') return
          queueMicrotask(() => { void this.handler(message) })
        },
        terminate() { this.terminated = true },
      }
      worker.handler = setupWorkerHandler(post(worker))
      return worker as unknown as Worker
    }
    client = new LxRuntimeClient({ workerFactory: factory, callTimeoutMs: 2000 })
    await client.loadSource(`
      lx.on(lx.EVENT_NAMES.request, function (request) {
        return 'https://cdn.example.com/' + request.info.musicInfo.id + '.mp3';
      });
    `)
    await expect(client.callMusicUrl('wy', { id: 'hang' }, '128k')).rejects.toThrow(/timed out/i)
    const result = await client.callMusicUrl('wy', { id: 'after-restart' }, '128k')
    expect(created).toBe(2)
    expect(result.url).toBe('https://cdn.example.com/after-restart.mp3')
  }, 20_000)
})
