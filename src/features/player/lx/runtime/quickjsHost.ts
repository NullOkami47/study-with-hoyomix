import variant from '@jitl/quickjs-wasmfile-release-asyncify'
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from 'quickjs-emscripten-core'
import {
  LX_VM_MEMORY_BYTES,
  LX_VM_STACK_BYTES,
  LX_VM_CALL_TIMEOUT_MS,
  LX_INIT_TIMEOUT_MS,
  LX_HTTP_REQUEST_TIMEOUT_MS,
  LX_RESOLVE_TIMEOUT_MS,
  LX_HTTP_MAX_RESPONSE_BYTES,
  LX_GUEST_MAX_ACTIVE_TIMERS,
  LX_INVALID_RESPONSE,
  LX_NETWORK_ERROR,
  LX_RATE_LIMITED,
  LX_REQUEST_TALLY,
  type LxMusicUrlResult,
} from './protocol'
import { BUILD_LX_CSP_SOURCES, currentSelfOrigin, isLxTargetAllowed, type LxCspSources } from '../cspAllowList'
import { LX_CSP_BLOCKED, upgradeLxMediaUrlToHttps } from '../../../../shared/lxCspPolicy'

interface QuickJsModuleInternals {
  callbacks: {
    deleteRuntime: (rt: number) => void
    runtimeCallbacks: Map<number, unknown>
    cToHostCallbacks: {
      freeHostRef: (asyncify: unknown, rt: number, hostRefId: number) => void
    }
  }
}

let qjsModulePromise: Promise<QuickJSAsyncWASMModule> | null = null

export async function getQuickJsModule(): Promise<QuickJSAsyncWASMModule> {
  if (!qjsModulePromise) {
    qjsModulePromise = (async () => {
      const qjs = await newQuickJSAsyncWASMModuleFromVariant(variant)
      const internals = qjs as unknown as QuickJsModuleInternals

      // Fix upstream quickjs-emscripten-core deleteRuntime ordering bug where
      // deleteRuntime is called before QTS_FreeRuntime, causing freeHostRef to fail.
      const origDeleteRuntime = internals.callbacks.deleteRuntime.bind(internals.callbacks)
      internals.callbacks.deleteRuntime = function (rt: number) {
        queueMicrotask(() => origDeleteRuntime(rt))
      }

      const origFreeHostRef = internals.callbacks.cToHostCallbacks.freeHostRef.bind(internals.callbacks.cToHostCallbacks)
      internals.callbacks.cToHostCallbacks.freeHostRef = function (asyncify: unknown, rt: number, hostRefId: number) {
        if (!internals.callbacks.runtimeCallbacks.has(rt)) {
          return
        }
        return origFreeHostRef(asyncify, rt, hostRefId)
      }

      return qjs
    })()
  }
  return qjsModulePromise
}

type RequestGateResult = { ok: boolean; retryAfterMs?: number } | null

export interface QuickJsLxHostOptions {
  memoryLimitBytes?: number
  stackSizeBytes?: number
  /** One guest execution slice (see `LX_VM_CALL_TIMEOUT_MS`). */
  callTimeoutMs?: number
  /** Script load plus `inited` announcement (see `LX_INIT_TIMEOUT_MS`). */
  initTimeoutMs?: number
  /** Ceiling for one `lx.request` (see `LX_HTTP_REQUEST_TIMEOUT_MS`). */
  httpTimeoutMs?: number
  /** Budget for one `musicUrl` call end to end (see `LX_RESOLVE_TIMEOUT_MS`). */
  resolveTimeoutMs?: number
  fetch?: typeof fetch
  /**
   * CSP source lists `lx.request` targets are checked against (H-01). Defaults to the build's
   * emitted lists; only `connect` is consulted here. Tests inject their own fixture origins.
   */
  cspSources?: LxCspSources
  /** The origin `'self'` stands for; defaults to the worker's own origin. */
  selfOrigin?: string
  /**
   * A quota gate consulted before an outbound request is sent, used to keep a shared upstream
   * inside its published rate limit. Returning `false` refuses the request before any network use;
   * a granted request is recorded by the gate itself, because the upstream counts attempts.
   */
  requestGate?: (url: URL) => RequestGateResult | Promise<RequestGateResult>
  /** Host-only observation, before reading the body, so a 429 also backs off on an oversized body. */
  onResponse?: (url: URL, response: Response) => void
}

/** A response (or refusal) waiting to be handed to the guest callback that asked for it. */
interface PendingGuestCall {
  callback: QuickJSHandle
  outcome: FetchOutcome
}

type FetchOutcome =
  | { success: true; response: { statusCode: number; status: number; headers: Record<string, string>; body: unknown } }
  | { success: false; error: string }

/** Per-resolution request accounting, appended to a failure so `lxUser.ts` can classify it. */
interface RequestTally {
  ok: number
  httpError: number
  blocked: number
  timeout: number
}

const FORBIDDEN_HEADERS = new Set([
  'cookie',
  'cookie2',
  'authorization',
  'proxy-authorization',
  'proxy-authenticate',
  'origin',
  'referer',
  'host',
  'connection',
  'keep-alive',
  'upgrade',
])

function isForbiddenHeader(headerName: string): boolean {
  const lower = headerName.toLowerCase().trim()
  if (FORBIDDEN_HEADERS.has(lower)) return true
  if (lower.startsWith('sec-') || lower.startsWith('proxy-')) return true
  return false
}

/**
 * Reads a response body up to `limit` bytes. Returns null as soon as the running total exceeds the
 * limit, after cancelling the reader so the rest of the body is never pulled. A body of exactly
 * `limit` bytes is returned intact.
 */
async function readBodyWithinLimit(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer())
    return buffer.byteLength > limit ? null : buffer
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limit) {
        chunks.length = 0
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export class QuickJsLxHost {
  private runtime: QuickJSAsyncRuntime | null = null
  private context: QuickJSAsyncContext | null = null
  /** Pending guest timers with the duplicated callback handle each one owns (freed on fire/clear/dispose). */
  private activeTimers = new Map<number, { timer: ReturnType<typeof setTimeout>; callback: QuickJSHandle }>()
  private nextTimerId = 1
  /**
   * Deadlines of every host-initiated guest invocation currently in progress (M-11). The runtime's
   * interrupt handler is installed once and interrupts guest code as soon as any active deadline
   * has passed, so a timer callback that fires while a top-level call is awaiting is bounded by the
   * earlier of the two deadlines, and no guest code ever runs without one.
   */
  private activeDeadlines: number[] = []
  /**
   * `lx.request` callbacks waiting to be delivered. The host fetch is deliberately NOT an
   * asyncified (blocking) call: a blocking host function suspends the whole guest for the duration
   * of one request, so a script that races N aggregators with `Promise.any` degrades into N serial
   * requests and blows the resolution budget. Instead the guest call returns immediately and its
   * callback is queued here, then delivered from `pumpOnce()` between guest turns.
   */
  private pendingGuestCalls: PendingGuestCall[] = []
  /** In-flight `lx.request` operations, keyed by request id, with the controller that aborts them. */
  private inflightRequests = new Map<number, AbortController>()
  /** Duplicated guest callback handles owned by in-flight requests (freed on delivery or dispose). */
  private outstandingCallbacks = new Map<number, QuickJSHandle>()
  private nextRequestId = 1
  private requestTally: RequestTally = { ok: 0, httpError: 0, blocked: 0, timeout: 0 }
  private customFetch: typeof fetch
  private callTimeoutMs: number
  private initTimeoutMs: number
  private httpTimeoutMs: number
  private resolveTimeoutMs: number
  private cspSources: LxCspSources
  private selfOrigin: string | undefined
  private requestGate: QuickJsLxHostOptions['requestGate']
  private onResponse: QuickJsLxHostOptions['onResponse']
  private disposed = false

  private constructor(
    runtime: QuickJSAsyncRuntime,
    context: QuickJSAsyncContext,
    options?: QuickJsLxHostOptions,
  ) {
    this.runtime = runtime
    this.context = context
    this.customFetch = options?.fetch ?? globalThis.fetch.bind(globalThis)
    this.callTimeoutMs = options?.callTimeoutMs ?? LX_VM_CALL_TIMEOUT_MS
    this.initTimeoutMs = options?.initTimeoutMs ?? LX_INIT_TIMEOUT_MS
    this.httpTimeoutMs = options?.httpTimeoutMs ?? LX_HTTP_REQUEST_TIMEOUT_MS
    this.resolveTimeoutMs = options?.resolveTimeoutMs ?? LX_RESOLVE_TIMEOUT_MS
    this.cspSources = options?.cspSources ?? BUILD_LX_CSP_SOURCES
    this.selfOrigin = options?.selfOrigin ?? currentSelfOrigin()
    this.requestGate = options?.requestGate
    this.onResponse = options?.onResponse
  }

  static async create(options?: QuickJsLxHostOptions): Promise<QuickJsLxHost> {
    const qjs = await getQuickJsModule()
    const runtime = qjs.newRuntime()
    runtime.setMemoryLimit(options?.memoryLimitBytes ?? LX_VM_MEMORY_BYTES)
    runtime.setMaxStackSize(options?.stackSizeBytes ?? LX_VM_STACK_BYTES)
    const context = runtime.newContext()

    const host = new QuickJsLxHost(runtime, context, options)
    runtime.setInterruptHandler(() => host.deadlinePassed())
    await host.initSandbox()
    return host
  }

  private deadlinePassed(): boolean {
    if (this.activeDeadlines.length === 0) return false
    const now = Date.now()
    for (const deadline of this.activeDeadlines) {
      if (now > deadline) return true
    }
    return false
  }

  /** Opens a deadline for one host-initiated guest invocation; pair with `exitDeadline`. */
  private enterDeadline(budgetMs: number = this.callTimeoutMs): number {
    const deadline = Date.now() + budgetMs
    this.activeDeadlines.push(deadline)
    return deadline
  }

  private exitDeadline(deadline: number): void {
    const index = this.activeDeadlines.indexOf(deadline)
    if (index >= 0) this.activeDeadlines.splice(index, 1)
  }

  private disposeCallResult(callRes: { value?: QuickJSHandle; error?: QuickJSHandle }): void {
    if ('value' in callRes && callRes.value && callRes.value.alive) {
      callRes.value.dispose()
    } else if ('error' in callRes && callRes.error && callRes.error.alive) {
      callRes.error.dispose()
    }
  }

  get isAlive(): boolean {
    return !this.disposed && this.context !== null && this.context.alive
  }

  /** Counts one finished `lx.request` so a failed resolution can say *why* it failed. */
  private recordTally(outcome: FetchOutcome): void {
    if (outcome.success) {
      if (outcome.response.status >= 400) this.requestTally.httpError++
      else this.requestTally.ok++
      return
    }
    if (outcome.error.startsWith(LX_NETWORK_ERROR)) this.requestTally.blocked++
    else if (outcome.error.includes('timed out')) this.requestTally.timeout++
    else this.requestTally.blocked++
  }

  private resetTally(): void {
    this.requestTally = { ok: 0, httpError: 0, blocked: 0, timeout: 0 }
  }

  private tallySuffix(): string {
    const { ok, httpError, blocked, timeout } = this.requestTally
    return ` ${LX_REQUEST_TALLY}${ok} http_error=${httpError} blocked=${blocked} timeout=${timeout}`
  }

  /**
   * Hands every queued response to its guest callback, then drains the guest's microtask queue.
   * Must run between guest turns; it is what makes a non-blocking `lx.request` behave like the
   * reference host's.
   */
  private pumpOnce(): void {
    const ctx = this.context
    if (!ctx || !ctx.alive) return

    while (this.pendingGuestCalls.length > 0) {
      const call = this.pendingGuestCalls.shift()
      if (!call) break
      this.deliver(call)
      if (!ctx.alive) return
    }

    if (this.runtime) {
      const jobRes = this.runtime.executePendingJobs()
      if (jobRes.error) {
        const err = ctx.dump(jobRes.error)
        jobRes.error.dispose()
        throw new Error(`QuickJS microtask error: ${String(err)}`)
      }
    }
  }

  /** Invokes one queued `lx.request` callback as a bounded guest turn. */
  private deliver(call: PendingGuestCall): void {
    const ctx = this.context
    if (!ctx || !ctx.alive) {
      if (call.callback.alive) call.callback.dispose()
      return
    }
    if (!call.callback.alive) return

    let errHandle = ctx.null
    let respHandle = ctx.null
    let bodyHandle = ctx.null
    let needDisposeErr = false
    let needDisposeResp = false
    let needDisposeBody = false

    const deadline = this.enterDeadline()
    try {
      if (!call.outcome.success) {
        const errRes = ctx.evalCode('(' + JSON.stringify({ message: call.outcome.error }) + ')')
        errHandle = ctx.unwrapResult(errRes)
        needDisposeErr = true
      } else {
        const respRes = ctx.evalCode('(' + JSON.stringify(call.outcome.response) + ')')
        respHandle = ctx.unwrapResult(respRes)
        needDisposeResp = true

        const bodyRes = ctx.evalCode('(' + JSON.stringify(call.outcome.response.body) + ')')
        bodyHandle = ctx.unwrapResult(bodyRes)
        needDisposeBody = true
      }

      // M-11: the lx.request callback is guest code re-entered by the host; bound it like any call.
      this.disposeCallResult(ctx.callFunction(call.callback, ctx.undefined, errHandle, respHandle, bodyHandle))
    } catch {
      // A throwing guest callback must not take the host down; the script sees its own error.
    } finally {
      this.exitDeadline(deadline)
      if (needDisposeErr && errHandle.alive) errHandle.dispose()
      if (needDisposeResp && respHandle.alive) respHandle.dispose()
      if (needDisposeBody && bodyHandle.alive) bodyHandle.dispose()
      if (call.callback.alive) call.callback.dispose()
    }
  }

  /** Whether the guest has registered its `lx.request` handler yet. */
  private hasRequestHandler(): boolean {
    const ctx = this.context
    if (!ctx || !ctx.alive) return false
    const res = ctx.evalCode('__lxHasRequestHandler()')
    if ('value' in res && res.value) {
      const val = ctx.dump(res.value)
      res.value.dispose()
      return val === true
    }
    if ('error' in res && res.error) res.error.dispose()
    return false
  }

  /**
   * Drives the guest until it has no pending host work. Intended for callers that fire
   * `lx.request` directly instead of going through `musicUrl`.
   */
  async settle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      this.pumpOnce()
      if (this.inflightRequests.size === 0 && this.pendingGuestCalls.length === 0) return
      await new Promise((r) => setTimeout(r, 2))
    }
  }

  private async initSandbox(): Promise<void> {
    if (!this.context) return

    // Register host fetch.
    //
    // Deliberately a plain `newFunction`, not `newAsyncifiedFunction`. An asyncified host call
    // suspends the guest until the promise resolves, so a script that races several aggregators in
    // parallel (`Promise.any` / `Promise.race`) actually issues them one after another: measured on
    // Hei Music, seven parallel probes became seven serial requests totalling ~15.7 s and every one
    // of them missed the old 4 s resolution budget. Returning immediately and delivering the
    // callback from `pumpOnce()` restores real concurrency (~1.9 s for the same script).
    const hostFetch = this.context.newFunction('__hostFetch', (urlHandle, optHandle, cbHandle) => {
      const ctx = this.context
      if (!ctx || !ctx.alive) return ctx ? ctx.undefined : undefined

      let url: unknown
      let options: Record<string, unknown> = {}
      try {
        url = ctx.dump(urlHandle)
        const dumpedOptions = ctx.dump(optHandle)
        if (dumpedOptions && typeof dumpedOptions === 'object' && !Array.isArray(dumpedOptions)) {
          options = dumpedOptions as Record<string, unknown>
        }
      } catch {
        return ctx.undefined
      }

      const hasCallback =
        cbHandle && cbHandle.alive && ctx.typeof(cbHandle) === 'function'
      const id = this.nextRequestId++
      const controller = new AbortController()

      if (!hasCallback) {
        // Nothing to deliver to; still validate so a misuse surfaces in the guest's own errors.
        void this.performControlledFetch(url, options, controller.signal).catch(() => undefined)
        return ctx.undefined
      }

      const cbDup = cbHandle.dup()
      this.inflightRequests.set(id, controller)
      this.outstandingCallbacks.set(id, cbDup)

      const settle = (outcome: FetchOutcome): void => {
        this.inflightRequests.delete(id)
        this.outstandingCallbacks.delete(id)
        if (!cbDup.alive) return
        if (this.disposed) {
          cbDup.dispose()
          return
        }
        this.recordTally(outcome)
        this.pendingGuestCalls.push({ callback: cbDup, outcome })
      }

      void this.performControlledFetch(url, options, controller.signal)
        .then(settle)
        .catch((e: unknown) => {
          settle({ success: false, error: `${LX_NETWORK_ERROR}: ${e instanceof Error ? e.message : String(e)}` })
        })

      // `lx.request` returns an abort function in the reference host; scripts use it to cancel the
      // losers of a race.
      return ctx.newFunction('abort', () => {
        this.inflightRequests.get(id)?.abort()
      })
    })
    this.context.setProp(this.context.global, '__hostFetch', hostFetch)
    hostFetch.dispose()

    // Register host timers
    const hostSetTimeout = this.context.newFunction('__hostSetTimeout', (cbHandle, delayHandle) => {
      const ctx = this.context
      if (!ctx || !ctx.alive) return undefined
      // M-11: bound the duplicated callback handles a script can pin (see LX_GUEST_MAX_ACTIVE_TIMERS).
      if (this.activeTimers.size >= LX_GUEST_MAX_ACTIVE_TIMERS) {
        throw new RangeError(`Too many active timers (limit ${LX_GUEST_MAX_ACTIVE_TIMERS})`)
      }
      const id = this.nextTimerId++
      const rawDelay = typeof ctx.dump(delayHandle) === 'number' ? (ctx.dump(delayHandle) as number) : 0
      const delay = Math.min(Math.max(0, rawDelay), this.callTimeoutMs)

      const dupCb = cbHandle.dup()
      const timer = setTimeout(() => {
        this.activeTimers.delete(id)
        try {
          if (this.context && this.context.alive && dupCb.alive) {
            // M-11: a timer callback runs after the scheduling call returned; give it its own
            // deadline so a CPU-bound callback is interrupted instead of stalling the worker.
            const deadline = this.enterDeadline()
            try {
              this.disposeCallResult(this.context.callFunction(dupCb, this.context.undefined))
            } catch {
              // Ignore guest callback errors
            } finally {
              this.exitDeadline(deadline)
            }
          }
        } finally {
          if (dupCb.alive) dupCb.dispose()
        }
      }, delay)

      this.activeTimers.set(id, { timer, callback: dupCb })
      return ctx.newNumber(id)
    })
    this.context.setProp(this.context.global, '__hostSetTimeout', hostSetTimeout)
    hostSetTimeout.dispose()

    const hostClearTimeout = this.context.newFunction('__hostClearTimeout', (idHandle) => {
      if (!this.context || !this.context.alive) return
      const id = this.context.dump(idHandle) as number
      const entry = this.activeTimers.get(id)
      if (entry) {
        clearTimeout(entry.timer)
        this.activeTimers.delete(id)
        // Free the duplicated callback now; leaving it pinned leaks a GC object and aborts
        // QuickJS's leak assertion when the runtime is freed.
        if (entry.callback.alive) entry.callback.dispose()
      }
    })
    this.context.setProp(this.context.global, '__hostClearTimeout', hostClearTimeout)
    hostClearTimeout.dispose()

    // Randomness for `lx.utils.crypto.randomBytes`. Delivered as hex text rather than a byte array
    // so the value crosses the RPC boundary as one primitive, and bounded so a script cannot ask
    // for an unbounded allocation.
    const hostRandomHex = this.context.newFunction('__hostRandomHex', (countHandle) => {
      const ctx = this.context
      if (!ctx || !ctx.alive) return ctx ? ctx.undefined : undefined
      const raw = ctx.dump(countHandle)
      const count = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(Math.max(0, Math.floor(raw)), 8192) : 0
      const bytes = new Uint8Array(Math.ceil(count / 2))
      globalThis.crypto.getRandomValues(bytes)
      let hex = ''
      for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
      return ctx.newString(hex.slice(0, count))
    })
    this.context.setProp(this.context.global, '__hostRandomHex', hostRandomHex)
    hostRandomHex.dispose()

    // Inject bootstrap code
    const bootstrapCode = `
      // Clean globals
      globalThis.window = undefined;
      globalThis.document = undefined;
      globalThis.localStorage = undefined;
      globalThis.sessionStorage = undefined;
      globalThis.fetch = undefined;
      globalThis.XMLHttpRequest = undefined;

      // Disable eval and Function
      delete globalThis.eval;
      globalThis.eval = undefined;
      delete globalThis.Function;
      globalThis.Function = undefined;
      [
        function(){},
        async function(){},
        function*(){},
        async function*(){}
      ].forEach(function(fn) {
        try {
          var proto = Object.getPrototypeOf(fn);
          if (proto) {
            Object.defineProperty(proto, 'constructor', {
              value: undefined,
              writable: false,
              configurable: false,
            });
          }
        } catch (_) {}
      });

      // Redacted console
      globalThis.console = {
        log() {},
        info() {},
        warn() {},
        error() {},
        debug() {},
        trace() {},
      };

      // Timers
      globalThis.setTimeout = function(fn, delay) {
        return __hostSetTimeout(fn, delay);
      };
      globalThis.clearTimeout = function(id) {
        return __hostClearTimeout(id);
      };

      // Base64 helpers
      if (typeof globalThis.btoa === 'undefined') {
        const bChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
        globalThis.btoa = function(input) {
          let str = String(input);
          let out = '';
          for (let block = 0, charCode, idx = 0, map = bChars;
               str.charAt(idx | 0) || (map = '=', idx % 1);
               out += map.charAt(63 & block >> 8 - idx % 1 * 8)) {
            charCode = str.charCodeAt(idx += 3/4);
            if (charCode > 0xFF) {
              throw new Error("'btoa' failed: The string to be encoded contains characters outside of the Latin1 range.");
            }
            block = block << 8 | charCode;
          }
          return out;
        };
      }
      if (typeof globalThis.atob === 'undefined') {
        const bChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
        globalThis.atob = function(input) {
          let str = String(input).replace(/=+$/, '');
          if (str.length % 4 === 1) {
            throw new Error("'atob' failed: The string to be decoded is not correctly encoded.");
          }
          let out = '';
          for (let bc = 0, bs, buffer, idx = 0;
               buffer = str.charAt(idx++);
               ~buffer && (bs = bc % 4 ? bs * 64 + buffer : buffer,
                 bc++ % 4) ? out += String.fromCharCode(255 & bs >> (-2 * bc & 6)) : 0) {
            buffer = bChars.indexOf(buffer);
          }
          return out;
        };
      }

      function __createBuffer(bytes) {
        return {
          length: bytes.length,
          toString(enc) {
            if (enc === 'hex') {
              return bytes.map(b => (b & 0xff).toString(16).padStart(2, '0')).join('');
            }
            if (enc === 'base64') {
              return btoa(bytes.map(b => String.fromCharCode(b)).join(''));
            }
            return bytes.map(b => String.fromCharCode(b)).join('');
          }
        };
      }

      function __hexToBytes(hex) {
        const out = [];
        for (let i = 0; i + 1 < hex.length; i += 2) {
          const v = parseInt(hex.substr(i, 2), 16);
          out.push(isNaN(v) ? 0 : v);
        }
        return out;
      }

      // MD5, RFC 1321. Kept in the guest so lx.utils.crypto.md5 costs no host round-trip and
      // grants no additional capability. Verified against Node's crypto in the unit tests.
      function __md5(input) {
        const msg = [];
        for (let i = 0; i < input.length; i++) {
          const c = input.charCodeAt(i);
          if (c < 0x80) {
            msg.push(c);
          } else if (c < 0x800) {
            msg.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
          } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
            const c2 = input.charCodeAt(i + 1);
            const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
            msg.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
            i++;
          } else {
            msg.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
          }
        }
        const bitLen = msg.length * 8;
        msg.push(0x80);
        while (msg.length % 64 !== 56) msg.push(0);
        const lo = bitLen >>> 0;
        const hi = Math.floor(bitLen / 4294967296) >>> 0;
        msg.push(lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, (lo >>> 24) & 0xff);
        msg.push(hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, (hi >>> 24) & 0xff);

        let a0 = 0x67452301;
        let b0 = 0xefcdab89;
        let c0 = 0x98badcfe;
        let d0 = 0x10325476;
        const SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
        const K = [];
        for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

        for (let off = 0; off < msg.length; off += 64) {
          const M = [];
          for (let j = 0; j < 16; j++) {
            const base = off + j * 4;
            M.push((msg[base]) | (msg[base + 1] << 8) | (msg[base + 2] << 16) | (msg[base + 3] << 24));
          }
          let A = a0;
          let B = b0;
          let C = c0;
          let D = d0;
          for (let i = 0; i < 64; i++) {
            let F;
            let g;
            if (i < 16) {
              F = (B & C) | (~B & D);
              g = i;
            } else if (i < 32) {
              F = (D & B) | (~D & C);
              g = (5 * i + 1) % 16;
            } else if (i < 48) {
              F = B ^ C ^ D;
              g = (3 * i + 5) % 16;
            } else {
              F = C ^ (B | ~D);
              g = (7 * i) % 16;
            }
            F = (F + A + K[i] + M[g]) >>> 0;
            const s = SHIFTS[(i >> 4) * 4 + (i % 4)];
            A = D;
            D = C;
            C = B;
            B = (B + (((F << s) | (F >>> (32 - s))) >>> 0)) >>> 0;
          }
          a0 = (a0 + A) >>> 0;
          b0 = (b0 + B) >>> 0;
          c0 = (c0 + C) >>> 0;
          d0 = (d0 + D) >>> 0;
        }

        let hex = '';
        for (const word of [a0, b0, c0, d0]) {
          for (let k = 0; k < 4; k++) {
            const byte = (word >>> (k * 8)) & 0xff;
            hex += (byte < 16 ? '0' : '') + byte.toString(16);
          }
        }
        return hex;
      }

      // LX namespace
      const __lxHandlers = new Map();
      let __lxInitedMeta = null;

      globalThis.lx = {
        version: '2.0.0',
        env: 'desktop',
        EVENT_NAMES: {
          request: 'request',
          inited: 'inited',
          updateAlert: 'updateAlert',
        },
        currentScriptInfo: {},
        on(event, handler) {
          if (typeof event === 'string' && typeof handler === 'function') {
            __lxHandlers.set(event, handler);
          }
        },
        send(event, data) {
          if (event === 'inited') {
            __lxInitedMeta = data;
          }
        },
        request(url, options, callback) {
          if (typeof options === 'function') {
            callback = options;
            options = {};
          }
          options = options || {};
          return __hostFetch(url, options, callback);
        },
        utils: {
          buffer: {
            from(data, encoding) {
              if (typeof data === 'string') {
                if (encoding === 'hex') {
                  const bytes = [];
                  for (let i = 0; i < data.length; i += 2) {
                    bytes.push(parseInt(data.substr(i, 2), 16) || 0);
                  }
                  return __createBuffer(bytes);
                }
                if (encoding === 'base64') {
                  const bin = atob(data);
                  const bytes = [];
                  for (let i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i));
                  return __createBuffer(bytes);
                }
                const bytes = [];
                for (let i = 0; i < data.length; i++) bytes.push(data.charCodeAt(i));
                return __createBuffer(bytes);
              }
              if (Array.isArray(data) || (data && data.length !== undefined)) {
                return __createBuffer(Array.from(data));
              }
              return __createBuffer([]);
            },
            // Present in the reference host and used by ten of the audited sources; without it
            // those sources throw inside their own request path and look like dead upstreams.
            bufToString(buf, encoding) {
              if (!buf) return '';
              if (typeof buf.toString === 'function') return buf.toString(encoding);
              return __createBuffer(Array.from(buf)).toString(encoding);
            }
          },
          crypto: {
            // md5 is required during *load* by 独家音源-v7, so a host without it cannot even
            // initialise that source. Implemented in-guest: no host round-trip, no extra capability.
            md5(input) {
              return __md5(typeof input === 'string' ? input : String(input));
            },
            randomBytes(count) {
              const n = typeof count === 'number' && count > 0 ? Math.min(Math.floor(count), 4096) : 0;
              return __createBuffer(__hexToBytes(__hostRandomHex(n * 2)));
            }
          }
        }
      };

      globalThis.__lxDispatchMusicUrl = function(source, songInfo, quality) {
        const handler = __lxHandlers.get('request');
        if (!handler) {
          throw new Error('No request handler registered by LX script');
        }
        // LX scripts read the song object from info.musicInfo, and some also read
        // info.musicInfo.musicInfo. The self-reference is created here, inside the guest,
        // so the host never has to send a cyclic object across the RPC boundary.
        songInfo.musicInfo = songInfo;
        return handler({
          source: source,
          action: 'musicUrl',
          info: {
            type: quality,
            musicInfo: songInfo,
          },
        });
      };

      globalThis.__lxGetInited = function() {
        return __lxInitedMeta;
      };

      globalThis.__lxHasRequestHandler = function() {
        return __lxHandlers.has('request');
      };
    `

    const bRes = await this.context.evalCodeAsync(bootstrapCode)
    if (bRes.error) {
      const err = this.context.dump(bRes.error)
      bRes.error.dispose()
      throw new Error(`Failed to bootstrap QuickJS sandbox: ${JSON.stringify(err)}`)
    }
    bRes.value.dispose()
  }

  private async performControlledFetch(
    rawUrl: unknown,
    options: Record<string, unknown>,
    externalSignal?: AbortSignal,
  ): Promise<FetchOutcome> {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return { success: false, error: 'URL must be a non-empty string' }
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(rawUrl)
    } catch {
      return { success: false, error: 'Invalid URL' }
    }

    if (parsedUrl.protocol !== 'https:') {
      return { success: false, error: `Protocol ${parsedUrl.protocol} is not allowed. Only HTTPS is supported.` }
    }

    // H-01: the worker runs under the document's connect-src. Refuse a target that policy would
    // block before any network use, with a specific code instead of an opaque fetch failure.
    if (!isLxTargetAllowed('connect', parsedUrl, this.cspSources, this.selfOrigin)) {
      return { success: false, error: `${LX_CSP_BLOCKED}: ${parsedUrl.origin} is not permitted by this deployment's connect-src` }
    }

    // A shared upstream with a published rate limit is gated here, so a script's internal race
    // consumes the same budget as our own resolver and cannot multiply the cost.
    let gate: RequestGateResult | undefined
    try { gate = await this.requestGate?.(parsedUrl) }
    catch { gate = { ok: false } }
    if (this.disposed || externalSignal?.aborted) return { success: false, error: 'Request aborted' }
    if (gate && !gate.ok) {
      const waited = gate.retryAfterMs !== undefined ? Math.ceil(gate.retryAfterMs / 1000) : 0
      return {
        success: false,
        error: `${LX_RATE_LIMITED}: ${parsedUrl.host} budget exhausted${waited > 0 ? `, retry after ~${waited}s` : ''}`,
      }
    }

    const rawMethod = typeof options.method === 'string' ? options.method.toUpperCase() : 'GET'
    if (rawMethod !== 'GET' && rawMethod !== 'POST') {
      return { success: false, error: `HTTP method ${rawMethod} is not allowed. Only GET and POST are supported.` }
    }

    // Build headers and strip forbidden ones
    const requestHeaders = new Headers()
    if (options.headers && typeof options.headers === 'object') {
      for (const [key, val] of Object.entries(options.headers as Record<string, unknown>)) {
        if (typeof key === 'string' && typeof val === 'string') {
          if (!isForbiddenHeader(key)) {
            requestHeaders.set(key, val)
          }
        }
      }
    }

    // Build body
    let body: BodyInit | undefined = undefined
    if (rawMethod === 'POST') {
      if (options.json !== undefined) {
        try {
          body = JSON.stringify(options.json)
          if (!requestHeaders.has('content-type')) {
            requestHeaders.set('content-type', 'application/json')
          }
        } catch {
          return { success: false, error: 'Failed to serialize JSON body' }
        }
      } else if (options.form !== undefined && typeof options.form === 'object' && options.form !== null) {
        const params = new URLSearchParams()
        for (const [k, v] of Object.entries(options.form as Record<string, unknown>)) {
          params.append(k, String(v ?? ''))
        }
        body = params.toString()
        if (!requestHeaders.has('content-type')) {
          requestHeaders.set('content-type', 'application/x-www-form-urlencoded')
        }
      } else if (typeof options.body === 'string') {
        body = options.body
      } else if (options.body !== undefined && options.body !== null && typeof options.body === 'object') {
        // The reference host serialises an object-valued `body` as JSON. Dropping it silently made
        // every POST-based aggregator look like it answered with an unusable payload.
        try {
          body = JSON.stringify(options.body)
          if (!requestHeaders.has('content-type')) {
            requestHeaders.set('content-type', 'application/json')
          }
        } catch {
          return { success: false, error: 'Failed to serialize request body' }
        }
      } else if (options.data !== undefined) {
        body = typeof options.data === 'string' ? options.data : JSON.stringify(options.data)
      }
    }

    // One request may not exceed the HTTP budget, whatever the script asks for. The budget is the
    // per-request ceiling (LX_HTTP_REQUEST_TIMEOUT_MS), not the single-slice VM budget: scripts
    // legitimately allow themselves ~5 s for a slow aggregator.
    const timeout = typeof options.timeout === 'number' && options.timeout > 0
      ? Math.min(options.timeout, this.httpTimeoutMs)
      : this.httpTimeoutMs

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort()
      else externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    try {
      const response = await this.customFetch(parsedUrl.toString(), {
        method: rawMethod,
        headers: requestHeaders,
        body,
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      })

      this.onResponse?.(parsedUrl, response)

      // Check Content-Length if present
      const contentLengthHeader = response.headers.get('content-length')
      if (contentLengthHeader) {
        const len = parseInt(contentLengthHeader, 10)
        if (!isNaN(len) && len > LX_HTTP_MAX_RESPONSE_BYTES) {
          return { success: false, error: `Response exceeds maximum size of ${LX_HTTP_MAX_RESPONSE_BYTES} bytes` }
        }
      }

      // M-11: count bytes while streaming and stop at the first chunk past the limit, so at most
      // LX_HTTP_MAX_RESPONSE_BYTES plus one chunk is ever buffered (Content-Length may be absent).
      const bodyBytes = await readBodyWithinLimit(response, LX_HTTP_MAX_RESPONSE_BYTES)
      if (!bodyBytes) {
        return { success: false, error: `Response body exceeds maximum size of ${LX_HTTP_MAX_RESPONSE_BYTES} bytes` }
      }

      const text = new TextDecoder('utf-8').decode(bodyBytes)
      let parsedBody: unknown = text
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('json') || (text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
        try {
          parsedBody = JSON.parse(text)
        } catch {
          parsedBody = text
        }
      }

      // Build allowlisted response headers
      const safeHeaders: Record<string, string> = {}
      response.headers.forEach((v, k) => {
        const lower = k.toLowerCase()
        if (!lower.includes('cookie') && !lower.includes('auth')) {
          safeHeaders[lower] = v
        }
      })

      return {
        success: true,
        response: {
          statusCode: response.status,
          status: response.status,
          headers: safeHeaders,
          body: parsedBody,
        },
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        return { success: false, error: `HTTP request timed out after ${timeout}ms` }
      }
      // The fetch itself rejected: a network-level failure that may succeed on a retry. The stable
      // prefix lets lxUser.ts keep that classification across the guest script (task 41.7).
      return { success: false, error: `${LX_NETWORK_ERROR}: ${err instanceof Error ? err.message : String(err)}` }
    } finally {
      clearTimeout(timer)
    }
  }

  async evalCode(code: string): Promise<unknown> {
    this.assertAlive()
    // Flush deliveries before evaluating. `lx.request` no longer blocks the guest, so any guest
    // turn is a legitimate point for a queued response to land; without this, a caller polling a
    // guest variable would never see one.
    this.pumpOnce()
    const deadline = this.enterDeadline()

    try {
      const res = await this.context!.evalCodeAsync(code)
      if (res.error) {
        const err = this.context!.dump(res.error)
        res.error.dispose()
        throw new Error(typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err))
      }
      const val = this.context!.dump(res.value)
      res.value.dispose()
      return val
    } finally {
      this.exitDeadline(deadline)
    }
  }

  async loadSource(script: string): Promise<{ initedMeta?: unknown }> {
    this.assertAlive()
    const deadline = this.enterDeadline(this.initTimeoutMs)

    try {
      const res = await this.context!.evalCodeAsync(script)
      if (res.error) {
        const err = this.context!.dump(res.error)
        res.error.dispose()
        throw new Error(`Failed to execute LX script: ${typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err)}`)
      }
      res.value.dispose()

      // Settle the script's bootstrap. Many real scripts probe an aggregator before announcing
      // `inited`, so this loop has to keep pumping responses — that window is exactly what the old
      // blocking fetch used to hide, and why a 1 s check was long enough for it but not for them.
      const initDeadline = Date.now() + this.initTimeoutMs
      let initedMeta: unknown = undefined
      let idleTurns = 0

      while (Date.now() < initDeadline) {
        this.pumpOnce()

        const metaRes = this.context!.evalCode('__lxGetInited()')
        if ('value' in metaRes && metaRes.value) {
          const val = this.context!.dump(metaRes.value)
          metaRes.value.dispose()
          if (val !== null && val !== undefined) {
            initedMeta = val
            break
          }
        } else if ('error' in metaRes && metaRes.error) {
          metaRes.error.dispose()
        }

        // Nothing in flight and nothing queued means no further announcement can arrive from the
        // network. Stop as soon as the handler exists, and after a short grace otherwise, so a
        // script that never announces itself does not burn the whole budget.
        const idle = this.inflightRequests.size === 0 && this.pendingGuestCalls.length === 0
        if (idle) {
          if (this.hasRequestHandler()) break
          idleTurns++
          if (idleTurns >= 20) break
        } else {
          idleTurns = 0
        }

        await new Promise((r) => setTimeout(r, 5))
      }

      return { initedMeta }
    } finally {
      this.exitDeadline(deadline)
    }
  }

  async callMusicUrl(
    source: string,
    songInfo: Record<string, unknown>,
    quality: string,
  ): Promise<LxMusicUrlResult> {
    this.assertAlive()
    // Counts are per resolution: requests a script makes while initialising are not this call's.
    this.resetTally()
    const deadline = this.enterDeadline(this.resolveTimeoutMs)

    try {
      const code = `__lxDispatchMusicUrl(${JSON.stringify(source)}, ${JSON.stringify(songInfo)}, ${JSON.stringify(quality)})`
      const res = await this.context!.evalCodeAsync(code)
      if (res.error) {
        const err = this.context!.dump(res.error)
        res.error.dispose()
        throw new Error(`LX musicUrl error: ${typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err)}`)
      }

      let rawResult: unknown
      const promiseState = this.context!.getPromiseState(res.value)

      if ('notAPromise' in promiseState && promiseState.notAPromise) {
        rawResult = this.context!.dump(res.value)
        res.value.dispose()
      } else if (promiseState.type === 'fulfilled') {
        rawResult = this.context!.dump(promiseState.value)
        promiseState.value.dispose()
        res.value.dispose()
      } else if (promiseState.type === 'rejected') {
        const err = this.context!.dump(promiseState.error)
        promiseState.error.dispose()
        res.value.dispose()
        throw new Error(`LX musicUrl rejected: ${typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err)}${this.tallySuffix()}`)
      } else {
        // Pump jobs until settled or deadline
        try {
          rawResult = await this.waitForPromiseResult(res.value, deadline)
        } finally {
          res.value.dispose()
        }
      }

      try {
        return this.parseMusicUrlResult(rawResult, quality)
      } catch (err: unknown) {
        // The script answered but the answer was unusable. The tally says whether the upstreams
        // were reachable at all, which is the difference between "the payload was unusable" and
        // "we never got a response".
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`${message}${this.tallySuffix()}`)
      }
    } finally {
      this.exitDeadline(deadline)
    }
  }

  private async waitForPromiseResult(promiseHandle: Parameters<QuickJSAsyncContext['getPromiseState']>[0], deadline: number): Promise<unknown> {
    while (Date.now() <= deadline) {
      if (!this.context || !this.context.alive) {
        throw new Error('Runtime terminated while awaiting musicUrl promise')
      }

      // Deliver whatever arrived since the last turn, then drain microtasks, before re-reading the
      // promise state: a resolved `Promise.any` only becomes visible once its callbacks have run.
      this.pumpOnce()

      const state = this.context.getPromiseState(promiseHandle)
      if (state.type === 'fulfilled') {
        const val = this.context.dump(state.value)
        state.value.dispose()
        return val
      }
      if (state.type === 'rejected') {
        const err = this.context.dump(state.error)
        state.error.dispose()
        throw new Error(`LX musicUrl rejected: ${typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err)}${this.tallySuffix()}`)
      }

      await new Promise((r) => setTimeout(r, 2))
    }

    throw new Error(`LX musicUrl call timed out after ${this.resolveTimeoutMs}ms${this.tallySuffix()}`)
  }

  private validateMediaUrl(url: string): string {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:') {
        // A plaintext URL on a host that could never be promoted is refused here, exactly as
        // before. A plaintext URL on a trusted media host is handed to the provider instead: the
        // provider promotes it to HTTPS and proves the promoted form actually loads before using
        // it. The sandbox cannot check playability, and refusing every http: URL outright made
        // tracks that play perfectly look dead (seven of nine sampled resolutions were `http:`).
        if (!upgradeLxMediaUrlToHttps(url)) {
          // M-11: a page served over HTTPS cannot play plaintext media (mixed content / media-src).
          throw new Error(`${LX_INVALID_RESPONSE}: plaintext http: media URL is not playable`)
        }
        return url
      }
      if (parsed.protocol !== 'https:') {
        throw new Error(`Unsupported media URL scheme: ${parsed.protocol}`)
      }
      return url
    } catch (e: unknown) {
      if (e instanceof Error && (e.message.startsWith('Unsupported media URL scheme') || e.message.startsWith(`${LX_INVALID_RESPONSE}:`))) {
        throw e
      }
      throw new Error(`Invalid media URL format: ${url}`)
    }
  }

  private parseMusicUrlResult(raw: unknown, requestedQuality: string): LxMusicUrlResult {
    if (!raw) {
      throw new Error('LX script returned empty musicUrl result')
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (!trimmed) {
        throw new Error('LX script returned empty music URL string')
      }
      return { url: this.validateMediaUrl(trimmed), actualQuality: requestedQuality }
    }

    if (typeof raw === 'object' && raw !== null) {
      const obj = raw as Record<string, unknown>
      let url = typeof obj.url === 'string' ? obj.url.trim() : undefined
      if (!url && typeof obj.data === 'string') {
        url = obj.data.trim()
      } else if (!url && obj.data && typeof obj.data === 'object') {
        const inner = obj.data as Record<string, unknown>
        if (typeof inner.url === 'string') {
          url = inner.url.trim()
        }
      }

      if (!url) {
        throw new Error('LX script result did not contain a valid url string')
      }

      // M-11 / 3.6: the media element cannot send custom request headers, so a result that needs
      // them is refused here instead of being passed through to the provider.
      for (const rawHeaders of [obj.headers, obj.requestHeaders]) {
        if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders) && Object.keys(rawHeaders).length > 0) {
          throw new Error(`${LX_INVALID_RESPONSE}: media URL needs custom request headers`)
        }
      }

      const actualQuality = typeof obj.quality === 'string' && obj.quality.trim()
        ? obj.quality.trim()
        : (typeof obj.actualQuality === 'string' && obj.actualQuality.trim() ? obj.actualQuality.trim() : requestedQuality)

      return { url: this.validateMediaUrl(url), actualQuality }
    }

    throw new Error(`Unexpected musicUrl result type: ${typeof raw}`)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    // Free every pending timer's duplicated callback before the context: a handle left alive here
    // trips QuickJS's `list_empty(&rt->gc_obj_list)` assertion in JS_FreeRuntime.
    for (const { timer, callback } of this.activeTimers.values()) {
      clearTimeout(timer)
      if (callback.alive) {
        try {
          callback.dispose()
        } catch {
          // ignore
        }
      }
    }
    this.activeTimers.clear()
    this.activeDeadlines = []

    // Abort every in-flight request and free the callback handle it still owns. A handle left alive
    // here is what made `JS_FreeRuntime` abort (and poisoned every later host in the same process).
    for (const controller of this.inflightRequests.values()) {
      try {
        controller.abort()
      } catch {
        // ignore
      }
    }
    this.inflightRequests.clear()
    for (const callback of this.outstandingCallbacks.values()) {
      if (callback.alive) {
        try {
          callback.dispose()
        } catch {
          // ignore
        }
      }
    }
    this.outstandingCallbacks.clear()

    for (const call of this.pendingGuestCalls) {
      if (call.callback.alive) {
        try {
          call.callback.dispose()
        } catch {
          // ignore
        }
      }
    }
    this.pendingGuestCalls.length = 0

    if (this.context && this.context.alive) {
      try {
        this.context.dispose()
      } catch {
        // ignore
      }
      this.context = null
    }

    if (this.runtime && this.runtime.alive) {
      try {
        this.runtime.dispose()
      } catch {
        // ignore
      }
      this.runtime = null
    }
  }

  private assertAlive(): void {
    if (!this.isAlive) {
      throw new Error('QuickJsLxHost has been disposed')
    }
  }
}
