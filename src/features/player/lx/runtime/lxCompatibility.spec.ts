// Regression tests for the LX runtime compatibility fixes ported onto main.
//
// Each block names the defect it pins. The defects were found by running the *same* script (Hei
// Music, SHA-256 78d3cad4…) in a reference host that plays it and in ours that did not: the
// script loads, registers five platforms and then loses every one of its parallel aggregator
// probes. Nothing about the upstreams was wrong.
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { QuickJsLxHost } from './quickjsHost'
import { GD_STUDIO_API_ORIGIN } from '../../gdStudio/budget'
import { GdStudioBudget } from '../../gdStudio/budget'
import {
  LX_HTTP_REQUEST_TIMEOUT_MS,
  LX_INIT_TIMEOUT_MS,
  LX_RESOLVE_TIMEOUT_MS,
  LX_VM_CALL_TIMEOUT_MS,
} from './protocol'

const CSP = { connect: ['https://api.example.com'], media: ['https://*.example.com'] } as const

const md5 = (value: string) => createHash('md5').update(value, 'utf8').digest('hex')

describe('LX runtime compatibility fixes', () => {
  let host: QuickJsLxHost | null = null

  afterEach(() => {
    host?.dispose()
    host = null
  })

  describe('parallel lx.request', () => {
    it('issues several requests concurrently instead of serialising them', async () => {
      const started: number[] = []
      const gates: Array<() => void> = []
      const fetchMock = vi.fn(async (url: string) => {
        started.push(Date.now())
        await new Promise<void>((resolve) => gates.push(resolve))
        return new Response(JSON.stringify({ url }), { headers: { 'content-type': 'application/json' } })
      })

      host = await QuickJsLxHost.create({
        fetch: fetchMock as unknown as typeof fetch,
        cspSources: { connect: [...CSP.connect], media: [...CSP.media] },
      })

      await host.evalCode(`
        globalThis.done = 0;
        for (let i = 0; i < 4; i++) {
          lx.request('https://api.example.com/v1/' + i, {}, () => { globalThis.done++; });
        }
      `)

      // All four must be in flight before any of them is allowed to finish.
      await vi.waitFor(() => expect(started.length).toBe(4), { timeout: 5_000 })

      const spread = Math.max(...started) - Math.min(...started)
      // Serialised requests would each start only after the previous one completed, so the spread
      // would be at least the sum of the individual latencies. A generous bound still separates
      // the two behaviours without being timing-flaky.
      expect(spread).toBeLessThan(2_000)

      for (const gate of gates) gate()
      await host.settle()
      expect(await host.evalCode('globalThis.done')).toBe(4)
    })

    it('returns an abort function from lx.request so a losing race can be cancelled', async () => {
      const fetchMock = vi.fn(async () => new Response('{}'))
      host = await QuickJsLxHost.create({
        fetch: fetchMock as unknown as typeof fetch,
        cspSources: { connect: [...CSP.connect], media: [...CSP.media] },
      })
      const type = await host.evalCode(`
        const abort = lx.request('https://api.example.com/v1/x', {}, () => {});
        typeof abort;
      `)
      expect(type).toBe('function')
    })
  })

  describe('timeout budgets', () => {
    it('keeps the single-slice VM budget short and gives a resolution a longer one', () => {
      // Four distinct budgets: a guest slice, an initialisation, one HTTP request, one resolution.
      expect(LX_VM_CALL_TIMEOUT_MS).toBe(4_000)
      expect(LX_INIT_TIMEOUT_MS).toBeGreaterThan(LX_VM_CALL_TIMEOUT_MS)
      expect(LX_HTTP_REQUEST_TIMEOUT_MS).toBeGreaterThan(LX_VM_CALL_TIMEOUT_MS)
      expect(LX_RESOLVE_TIMEOUT_MS).toBeGreaterThan(LX_HTTP_REQUEST_TIMEOUT_MS)
    })

    it('does not cut a single request short at the single-slice budget', async () => {
      const fetchMock = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 300))
        return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
      })
      host = await QuickJsLxHost.create({
        fetch: fetchMock as unknown as typeof fetch,
        cspSources: { connect: [...CSP.connect], media: [...CSP.media] },
      })
      await host.evalCode(`
        globalThis.__p = null;
        lx.request('https://api.example.com/slow', {}, (err, resp) => {
          globalThis.__p = err ? { error: String(err.message) } : { status: resp.statusCode };
        });
      `)
      await vi.waitFor(async () => expect(await host!.evalCode('globalThis.__p')).not.toBeNull(), { timeout: 5_000 })
      expect(await host.evalCode('globalThis.__p')).toEqual({ status: 200 })
    })
  })

  describe('lx.utils', () => {
    it('computes md5 with the same digests as Node crypto', async () => {
      host = await QuickJsLxHost.create()
      const vectors = ['', 'abc', 'The quick brown fox jumps over the lazy dog', '你好', 'HOYO-MiX', 'a'.repeat(200)]
      for (const value of vectors) {
        const actual = await host.evalCode(`lx.utils.crypto.md5(${JSON.stringify(value)})`)
        expect(actual, value).toBe(md5(value))
      }
    })

    it('round-trips a buffer through from() and bufToString()', async () => {
      host = await QuickJsLxHost.create()
      const hex = await host.evalCode(`
        const buf = lx.utils.buffer.from('48656c6c6f', 'hex');
        lx.utils.buffer.bufToString(buf, 'hex');
      `)
      expect(hex).toBe('48656c6c6f')
    })

    it('produces random bytes of the requested length', async () => {
      host = await QuickJsLxHost.create()
      const length = await host.evalCode('lx.utils.crypto.randomBytes(16).length')
      expect(length).toBe(16)
      const a = await host.evalCode('lx.utils.buffer.bufToString(lx.utils.crypto.randomBytes(16), "hex")')
      const b = await host.evalCode('lx.utils.buffer.bufToString(lx.utils.crypto.randomBytes(16), "hex")')
      expect(a).toHaveLength(32)
      expect(a).not.toBe(b)
    })
  })

  describe('request bodies', () => {
    it('serialises an object-valued body as JSON', async () => {
      let seen: BodyInit | null | undefined
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        seen = init.body
        return new Response('{}')
      })
      host = await QuickJsLxHost.create({
        fetch: fetchMock as unknown as typeof fetch,
        cspSources: { connect: [...CSP.connect], media: [...CSP.media] },
      })
      await host.evalCode(`
        lx.request('https://api.example.com/post', { method: 'POST', body: { a: 1, b: 'two' } }, () => {});
      `)
      await host.settle()
      expect(String(seen)).toBe('{"a":1,"b":"two"}')
    })
  })

  describe('failure classification', () => {
    it('reports how the source failed rather than only that it failed', async () => {
      const fetchMock = vi.fn(async () => new Response('nope', { status: 503 }))
      host = await QuickJsLxHost.create({
        fetch: fetchMock as unknown as typeof fetch,
        cspSources: { connect: [...CSP.connect], media: [...CSP.media] },
      })
      await host.evalCode(`
        lx.on(lx.EVENT_NAMES.request, () => new Promise((resolve) => {
          lx.request('https://api.example.com/v1/x', {}, () => resolve(null));
        }));
      `)

      let message = ''
      try {
        await host.callMusicUrl('wy', { songmid: '1' }, '128k')
      } catch (err: unknown) {
        message = err instanceof Error ? err.message : String(err)
      }

      // The tally is what lets the provider say "the upstream answered with 5xx" instead of the
      // undifferentiated "unavailable".
      expect(message).toMatch(/requests ok=\d+ http_error=\d+ blocked=\d+ timeout=\d+/)
      expect(message).toMatch(/http_error=1/)
    })
  })

  describe('the shared upstream budget', () => {
    it('charges a script\'s requests for a rate-limited upstream to the same budget as ours', async () => {
      // The budget is shared between our own resolver and whatever an LX script does internally, so
      // a burst from either side is visible to both.
      const budget = new GdStudioBudget({ limit: 2, windowMs: 60_000, channelName: null, now: () => 1_000 })
      const fetchMock = vi.fn(async () => new Response('{}'))
      host = await QuickJsLxHost.create({
        fetch: fetchMock as unknown as typeof fetch,
        cspSources: { connect: ['https://music-api.gdstudio.xyz', ...CSP.connect], media: [...CSP.media] },
        requestGate: (url) =>
          `${url.protocol}//${url.host}` === GD_STUDIO_API_ORIGIN ? budget.tryAcquire(1_000) : null,
      })

      await host.evalCode(`
        globalThis.outcomes = [];
        for (let i = 0; i < 4; i++) {
          lx.request('https://music-api.gdstudio.xyz/api.php?i=' + i, {}, (err) => {
            globalThis.outcomes.push(err ? String(err.message) : 'ok');
          });
        }
      `)
      await host.settle()

      const outcomes = await host.evalCode('globalThis.outcomes') as string[]
      expect(outcomes).toHaveLength(4)
      // Two went out; the other two were refused locally and never reached the network.
      const refused = outcomes.filter((message) => message.includes('budget exhausted'))
      expect(refused).toHaveLength(2)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(refused[0]).toMatch(/rate_limited/)
    })
  })

  describe('disposal', () => {
    it('frees the runtime even when requests were still in flight', async () => {
      const fetchMock = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5_000))
        return new Response('{}')
      })
      const local = await QuickJsLxHost.create({
        fetch: fetchMock as unknown as typeof fetch,
        cspSources: { connect: [...CSP.connect], media: [...CSP.media] },
      })
      await local.evalCode(`lx.request('https://api.example.com/hang', {}, () => {});`)
      // Disposing with an outstanding callback must not abort the runtime: a leaked handle trips
      // QuickJS's free-timeout assertion and poisons every later host in the same process.
      expect(() => local.dispose()).not.toThrow()

      const next = await QuickJsLxHost.create()
      expect(await next.evalCode('1 + 1')).toBe(2)
      next.dispose()
    })
  })
})
