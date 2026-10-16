import variant from '@jitl/quickjs-wasmfile-release-asyncify'
import {
  newQuickJSAsyncWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
} from 'quickjs-emscripten-core'
import {
  LX_VM_MEMORY_BYTES,
  LX_VM_STACK_BYTES,
  LX_VM_CALL_TIMEOUT_MS,
  LX_HTTP_MAX_RESPONSE_BYTES,
  type LxMusicUrlResult,
} from './protocol'

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

export interface QuickJsLxHostOptions {
  memoryLimitBytes?: number
  stackSizeBytes?: number
  callTimeoutMs?: number
  fetch?: typeof fetch
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

export class QuickJsLxHost {
  private runtime: QuickJSAsyncRuntime | null = null
  private context: QuickJSAsyncContext | null = null
  private activeTimers = new Map<number, ReturnType<typeof setTimeout>>()
  private nextTimerId = 1
  private customFetch: typeof fetch
  private callTimeoutMs: number
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
  }

  static async create(options?: QuickJsLxHostOptions): Promise<QuickJsLxHost> {
    const qjs = await getQuickJsModule()
    const runtime = qjs.newRuntime()
    runtime.setMemoryLimit(options?.memoryLimitBytes ?? LX_VM_MEMORY_BYTES)
    runtime.setMaxStackSize(options?.stackSizeBytes ?? LX_VM_STACK_BYTES)
    const context = runtime.newContext()

    const host = new QuickJsLxHost(runtime, context, options)
    await host.initSandbox()
    return host
  }

  get isAlive(): boolean {
    return !this.disposed && this.context !== null && this.context.alive
  }

  private async initSandbox(): Promise<void> {
    if (!this.context) return

    // Register host fetch
    const hostFetch = this.context.newAsyncifiedFunction('__hostFetch', async (urlHandle, optHandle, cbHandle) => {
      if (!this.context || !this.context.alive) return
      const url = this.context.dump(urlHandle)
      const options = (this.context.dump(optHandle) || {}) as Record<string, unknown>

      const result = await this.performControlledFetch(url, options)

      if (cbHandle && cbHandle.alive && this.context && this.context.alive && this.context.typeof(cbHandle) === 'function') {
        let errHandle = this.context.null
        let respHandle = this.context.null
        let bodyHandle = this.context.null

        let needDisposeErr = false
        let needDisposeResp = false
        let needDisposeBody = false

        try {
          if (!result.success) {
            const errObj = { message: result.error }
            const errRes = this.context.evalCode('(' + JSON.stringify(errObj) + ')')
            errHandle = this.context.unwrapResult(errRes)
            needDisposeErr = true
          } else {
            const respRes = this.context.evalCode('(' + JSON.stringify(result.response) + ')')
            respHandle = this.context.unwrapResult(respRes)
            needDisposeResp = true

            const bodyRes = this.context.evalCode('(' + JSON.stringify(result.response.body) + ')')
            bodyHandle = this.context.unwrapResult(bodyRes)
            needDisposeBody = true
          }

          const callRes = this.context.callFunction(cbHandle, this.context.undefined, errHandle, respHandle, bodyHandle)
          if ('value' in callRes && callRes.value && callRes.value.alive) {
            callRes.value.dispose()
          } else if ('error' in callRes && callRes.error && callRes.error.alive) {
            callRes.error.dispose()
          }
        } finally {
          if (needDisposeErr && errHandle.alive) errHandle.dispose()
          if (needDisposeResp && respHandle.alive) respHandle.dispose()
          if (needDisposeBody && bodyHandle.alive) bodyHandle.dispose()
        }
      }
    })
    this.context.setProp(this.context.global, '__hostFetch', hostFetch)
    hostFetch.dispose()

    // Register host timers
    const hostSetTimeout = this.context.newFunction('__hostSetTimeout', (cbHandle, delayHandle) => {
      const ctx = this.context
      if (!ctx || !ctx.alive) return undefined
      const id = this.nextTimerId++
      const rawDelay = typeof ctx.dump(delayHandle) === 'number' ? (ctx.dump(delayHandle) as number) : 0
      const delay = Math.min(Math.max(0, rawDelay), this.callTimeoutMs)

      const dupCb = cbHandle.dup()
      const timer = setTimeout(() => {
        this.activeTimers.delete(id)
        if (this.context && this.context.alive && dupCb.alive) {
          try {
            const callRes = this.context.callFunction(dupCb, this.context.undefined)
            if ('value' in callRes && callRes.value && callRes.value.alive) {
              callRes.value.dispose()
            } else if ('error' in callRes && callRes.error && callRes.error.alive) {
              callRes.error.dispose()
            }
          } catch {
            // Ignore guest callback errors
          } finally {
            if (dupCb.alive) dupCb.dispose()
          }
        }
      }, delay)

      this.activeTimers.set(id, timer)
      return ctx.newNumber(id)
    })
    this.context.setProp(this.context.global, '__hostSetTimeout', hostSetTimeout)
    hostSetTimeout.dispose()

    const hostClearTimeout = this.context.newFunction('__hostClearTimeout', (idHandle) => {
      if (!this.context || !this.context.alive) return
      const id = this.context.dump(idHandle) as number
      const timer = this.activeTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        this.activeTimers.delete(id)
      }
    })
    this.context.setProp(this.context.global, '__hostClearTimeout', hostClearTimeout)
    hostClearTimeout.dispose()

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
  ): Promise<{ success: true; response: { statusCode: number; status: number; headers: Record<string, string>; body: unknown } } | { success: false; error: string }> {
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
      } else if (options.data !== undefined) {
        body = typeof options.data === 'string' ? options.data : JSON.stringify(options.data)
      }
    }

    const timeout = typeof options.timeout === 'number' && options.timeout > 0
      ? Math.min(options.timeout, this.callTimeoutMs)
      : this.callTimeoutMs

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await this.customFetch(parsedUrl.toString(), {
        method: rawMethod,
        headers: requestHeaders,
        body,
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      })

      // Check Content-Length if present
      const contentLengthHeader = response.headers.get('content-length')
      if (contentLengthHeader) {
        const len = parseInt(contentLengthHeader, 10)
        if (!isNaN(len) && len > LX_HTTP_MAX_RESPONSE_BYTES) {
          return { success: false, error: `Response exceeds maximum size of ${LX_HTTP_MAX_RESPONSE_BYTES} bytes` }
        }
      }

      // Read response body with size limit
      const arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength > LX_HTTP_MAX_RESPONSE_BYTES) {
        return { success: false, error: `Response body exceeds maximum size of ${LX_HTTP_MAX_RESPONSE_BYTES} bytes` }
      }

      const text = new TextDecoder('utf-8').decode(arrayBuffer)
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
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  async evalCode(code: string): Promise<unknown> {
    this.assertAlive()
    const deadline = Date.now() + this.callTimeoutMs
    this.runtime!.setInterruptHandler(shouldInterruptAfterDeadline(deadline))

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
      if (this.isAlive) {
        this.runtime!.setInterruptHandler(() => false)
      }
    }
  }

  async loadSource(script: string): Promise<{ initedMeta?: unknown }> {
    this.assertAlive()
    const deadline = Date.now() + this.callTimeoutMs
    this.runtime!.setInterruptHandler(shouldInterruptAfterDeadline(deadline))

    try {
      const res = await this.context!.evalCodeAsync(script)
      if (res.error) {
        const err = this.context!.dump(res.error)
        res.error.dispose()
        throw new Error(`Failed to execute LX script: ${typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err)}`)
      }
      res.value.dispose()

      // Give asynchronous inited handlers or pending microtasks a moment to settle
      const initedCheckDeadline = Date.now() + 1000
      let initedMeta: unknown = undefined

      while (Date.now() < initedCheckDeadline) {
        this.runtime!.executePendingJobs()
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
        await new Promise((r) => setTimeout(r, 10))
      }

      return { initedMeta }
    } finally {
      if (this.isAlive) {
        this.runtime!.setInterruptHandler(() => false)
      }
    }
  }

  async callMusicUrl(
    source: string,
    songInfo: Record<string, unknown>,
    quality: string,
  ): Promise<LxMusicUrlResult> {
    this.assertAlive()
    const deadline = Date.now() + this.callTimeoutMs
    this.runtime!.setInterruptHandler(shouldInterruptAfterDeadline(deadline))

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
        throw new Error(`LX musicUrl rejected: ${typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err)}`)
      } else {
        // Pump jobs until settled or deadline
        rawResult = await this.waitForPromiseResult(res.value, deadline)
        res.value.dispose()
      }

      return this.parseMusicUrlResult(rawResult, quality)
    } finally {
      if (this.isAlive) {
        this.runtime!.setInterruptHandler(() => false)
      }
    }
  }

  private async waitForPromiseResult(promiseHandle: Parameters<QuickJSAsyncContext['getPromiseState']>[0], deadline: number): Promise<unknown> {
    while (Date.now() <= deadline) {
      if (!this.context || !this.context.alive) {
        throw new Error('Runtime terminated while awaiting musicUrl promise')
      }

      const state = this.context.getPromiseState(promiseHandle)
      if (state.type === 'fulfilled') {
        const val = this.context.dump(state.value)
        state.value.dispose()
        return val
      }
      if (state.type === 'rejected') {
        const err = this.context.dump(state.error)
        state.error.dispose()
        throw new Error(`LX musicUrl rejected: ${typeof err === 'object' && err !== null && 'message' in err ? String((err as { message: unknown }).message) : String(err)}`)
      }

      if (this.runtime) {
        const jobRes = this.runtime.executePendingJobs()
        if (jobRes.error) {
          const err = this.context.dump(jobRes.error)
          jobRes.error.dispose()
          throw new Error(`QuickJS microtask error: ${String(err)}`)
        }
      }

      await new Promise((r) => setTimeout(r, 5))
    }

    throw new Error(`LX musicUrl call timed out after ${this.callTimeoutMs}ms`)
  }

  private validateMediaUrl(url: string): string {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Unsupported media URL scheme: ${parsed.protocol}`)
      }
      return url
    } catch (e: unknown) {
      if (e instanceof Error && e.message.startsWith('Unsupported media URL scheme')) {
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

      let requestHeaders: Record<string, string> | undefined = undefined
      const rawHeaders = (obj.headers ?? obj.requestHeaders) as Record<string, unknown> | undefined
      if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
        requestHeaders = {}
        for (const [k, v] of Object.entries(rawHeaders)) {
          if (typeof k === 'string' && typeof v === 'string') {
            requestHeaders[k] = v
          }
        }
      }

      const actualQuality = typeof obj.quality === 'string' && obj.quality.trim()
        ? obj.quality.trim()
        : (typeof obj.actualQuality === 'string' && obj.actualQuality.trim() ? obj.actualQuality.trim() : requestedQuality)

      return { url: this.validateMediaUrl(url), requestHeaders, actualQuality }
    }

    throw new Error(`Unexpected musicUrl result type: ${typeof raw}`)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer)
    }
    this.activeTimers.clear()

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
