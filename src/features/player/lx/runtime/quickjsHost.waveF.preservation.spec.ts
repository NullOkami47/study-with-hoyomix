// Wave F preservation (task 22, design Property 2 / Property 12 preservation clause, requirement
// 3.6). Observation-first: every expectation below was observed on the unfixed tree (3a30d77) and
// must still hold after M-11 adds the callback deadline, the timer cap, the streaming byte counter,
// the http:/custom-header rejection and the Worker reload.
//
// Inputs stay outside every M-11 bug clause: few timers (far below any cap chosen from
// scripts/lx-source-candidates.json), callbacks that finish in a few milliseconds, bodies at or
// below LX_HTTP_MAX_RESPONSE_BYTES, and https media results without request headers. The Wave E
// csp_blocked refusal (H-01) is re-checked here because M-11 rebases onto the same request path.
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { LX_CSP_BLOCKED } from '../../../../shared/lxCspPolicy'
import { LX_HTTP_MAX_RESPONSE_BYTES } from './protocol'
import { QuickJsLxHost } from './quickjsHost'

const FIXTURE_CSP = { connect: ['https://api.example.com'], media: [] }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (host: QuickJsLxHost, expression: string, attempts = 200) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await host.evalCode(expression)
    if (value !== null && value !== undefined) return value
    await sleep(10)
  }
  return null
}

describe('LX guest timers within limits behave as before (3.6)', () => {
  it('fires every scheduled short timer callback once, in delay order, and the guest sees its effects', async () => {
    const host = await QuickJsLxHost.create()
    // Control scheduling only: real host/guest clocks still bound CPU work and sandbox deadlines.
    // Native timer queues can deliver overdue callbacks out of due-time order under load.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 6 }),
          fc.integer({ min: 0, max: 3 }),
          async (delays, workMs) => {
            const fired = await host.evalCode(`
              globalThis.__fired = [];
              ${JSON.stringify(delays)}.forEach(function (delay, index) {
                setTimeout(function () {
                  var end = Date.now() + ${workMs};
                  while (Date.now() < end) {}
                  globalThis.__fired.push(index);
                }, delay);
              });
              globalThis.__fired.length
            `)
            expect(fired).toBe(0)
            // No host scheduling time elapses during registration or the guest's bounded CPU work.
            await vi.advanceTimersByTimeAsync(40)
            const order = await host.evalCode('__fired') as number[]
            const expected = delays.map((delay, index) => ({ delay, index }))
              .sort((a, b) => a.delay - b.delay || a.index - b.index).map(({ index }) => index)
            expect([...order].sort((a, b) => a - b)).toEqual(delays.map((_, index) => index))
            // With one scheduling origin, assert every delay and creation-order tie, without slack.
            expect(order, `delays=${delays}`).toEqual(expected)
            // Nothing fires twice.
            await vi.advanceTimersByTimeAsync(30)
            expect(await host.evalCode('__fired')).toEqual(expected)
          },
        ),
        // Retain 15 generated cases in addition to the CI counterexample and zero/equal-delay ties.
        { numRuns: 17, examples: [[[35, 4, 12, 5], 3], [[0, 0, 1, 5, 5], 3]] },
      )
    } finally {
      try {
        host.dispose()
      } finally {
        vi.useRealTimers()
      }
    }
  }, 30_000) // fast-check property: generous wall-clock bound for a loaded CI runner

  it('returns a timer handle and a cleared timer never fires', async () => {
    // Observed on the unfixed tree: clearTimeout does not free the duplicated callback handle, so
    // disposing this host would trip QuickJS's leak assertion. It is deliberately not disposed.
    const host = await QuickJsLxHost.create()
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }), async (cancel) => {
        await host.evalCode(`
          globalThis.__fired = [];
          globalThis.__ids = ${JSON.stringify(cancel)}.map(function (_, index) {
            return setTimeout(function () { globalThis.__fired.push(index) }, 5);
          });
          ${JSON.stringify(cancel)}.forEach(function (drop, index) { if (drop) clearTimeout(__ids[index]) });
        `)
        const ids = await host.evalCode('__ids') as unknown[]
        for (const id of ids) expect(typeof id).toBe('number')
        await sleep(60)
        const fired = (await host.evalCode('__fired') as number[]).sort((a, b) => a - b)
        expect(fired).toEqual(cancel.flatMap((drop, index) => (drop ? [] : [index])))
      }),
      { numRuns: 10 },
    )
  }, 30_000) // fast-check property: generous wall-clock bound for a loaded CI runner
})

describe('LX lx.request bodies within the limit are returned unchanged (3.6)', () => {
  let host: QuickJsLxHost
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
  beforeAll(async () => {
    host = await QuickJsLxHost.create({ fetch: fetch as unknown as typeof globalThis.fetch, cspSources: FIXTURE_CSP })
  })
  afterAll(() => host.dispose())

  it('delivers declared and chunked bodies up to LX_HTTP_MAX_RESPONSE_BYTES intact', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ min: 0, max: 4096 }),
          fc.integer({ min: 4096, max: 256 * 1024 }),
          fc.constantFrom(LX_HTTP_MAX_RESPONSE_BYTES - 1, LX_HTTP_MAX_RESPONSE_BYTES),
        ),
        fc.boolean(),
        fc.integer({ min: 1024, max: 64 * 1024 }),
        fc.constantFrom('a', 'z', '0'),
        async (size, declared, chunk, fill) => {
          fetch.mockReset()
          const bytes = new TextEncoder().encode(fill.repeat(size))
          fetch.mockImplementation(async () => {
            if (declared) {
              return new Response(bytes, { headers: { 'content-type': 'text/plain', 'content-length': String(size) } })
            }
            let offset = 0
            return new Response(new ReadableStream<Uint8Array>({
              pull(controller) {
                if (offset >= bytes.byteLength) { controller.close(); return }
                controller.enqueue(bytes.slice(offset, offset + chunk))
                offset += chunk
              },
            }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/plain' } })
          })
          await host.evalCode(`globalThis.__r = null; lx.request('https://api.example.com/body', {}, function (err, resp) {
            globalThis.__r = err ? { error: String(err.message) }
              : { status: resp.statusCode, length: String(resp.body).length, uniform: String(resp.body).split(${JSON.stringify(fill)}).join('') === '' }
          })`)
          const result = await waitFor(host, '__r') as { error?: string; status?: number; length?: number; uniform?: boolean } | null
          expect(result, `size=${size} declared=${declared} chunk=${chunk}`).toEqual({ status: 200, length: size, uniform: true })
          expect(fetch).toHaveBeenCalledTimes(1)
        },
      ),
      { numRuns: 20 },
    )
  }, 30_000) // 20 property runs with bodies up to 1 MiB: slow on a loaded CI runner, not a behaviour bound

  it('still refuses an https target outside connect-src with csp_blocked before any network use (Wave E H-01)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-z][a-z0-9]{1,12}$/u), fc.stringMatching(/^[a-z0-9]{0,10}$/u), async (label, path) => {
        fetch.mockReset()
        fetch.mockImplementation(async () => Response.json({ ok: true }))
        await host.evalCode(`globalThis.__r = null; lx.request('https://${label}.blocked.example/${path}', {}, function (err, resp) {
          globalThis.__r = err ? { error: String(err.message) } : { status: resp.statusCode }
        })`)
        const result = await waitFor(host, '__r') as { error?: string } | null
        expect(result?.error ?? '').toMatch(new RegExp(`^${LX_CSP_BLOCKED}:`, 'u'))
        expect(fetch).not.toHaveBeenCalled()
      }),
      { numRuns: 15 },
    )
  })
})

describe('LX musicUrl results on https without request headers resolve unchanged (3.6)', () => {
  // The ChKSz media family is in media-src in every build.
  const mediaUrl = fc.tuple(fc.stringMatching(/^m[0-9]{1,3}$/u), fc.stringMatching(/^[a-z0-9]{1,12}$/u))
    .map(([shard, file]) => `https://${shard}.music.126.net/${file}.mp3`)
  let host: QuickJsLxHost
  beforeAll(async () => {
    host = await QuickJsLxHost.create()
    await host.loadSource(`
      lx.on(lx.EVENT_NAMES.request, function (request) {
        var reply = globalThis.__reply;
        if (reply.async) return new Promise(function (resolve) { setTimeout(function () { resolve(reply.value) }, 5) });
        return reply.value;
      });
    `)
  })
  afterAll(() => host.dispose())

  it('returns the https URL and the effective quality, with no request headers', async () => {
    await fc.assert(
      fc.asyncProperty(
        mediaUrl,
        fc.constantFrom('string', 'url', 'data', 'nested'),
        fc.option(fc.constantFrom('128k', '320k', 'flac'), { nil: undefined }),
        fc.boolean(),
        fc.constantFrom('128k', '320k'),
        async (url, shape, quality, async, requested) => {
          const value = shape === 'string' ? url
            : shape === 'url' ? { url, ...(quality ? { quality } : {}) }
              : shape === 'data' ? { data: url, ...(quality ? { quality } : {}) }
                : { data: { url }, ...(quality ? { quality } : {}) }
          await host.evalCode(`globalThis.__reply = ${JSON.stringify({ value, async })}`)
          const result = await host.callMusicUrl('wy', { id: '1' }, requested)
          expect(result.url).toBe(url)
          expect(result.requestHeaders).toBeUndefined()
          expect(result.actualQuality).toBe(shape !== 'string' && quality ? quality : requested)
        },
      ),
      { numRuns: 25 },
    )
  })
})
