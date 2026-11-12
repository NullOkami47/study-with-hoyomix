export const LX_VM_MEMORY_BYTES = 16 * 1024 * 1024
export const LX_VM_STACK_BYTES = 512 * 1024
/**
 * Budget for **one guest execution slice**: a single host→guest entry (eval, a `lx.request`
 * callback delivery, a timer callback). This bounds CPU-bound guest code; it is NOT a budget for a
 * whole `musicUrl` resolution, which spans many such slices.
 *
 * Keeping these four budgets distinct is what makes real LX scripts work. A script's `musicUrl`
 * races several aggregators in parallel and needs seconds of wall clock, while each individual
 * callback still has to be interruptible within a few hundred milliseconds. One shared 4 s budget
 * used to cap the whole resolution and made every multi-endpoint script look dead.
 */
export const LX_VM_CALL_TIMEOUT_MS = 4_000
/** Budget for loading a script and waiting for its `inited` announcement (or handler registration). */
export const LX_INIT_TIMEOUT_MS = 15_000
/** Ceiling for one `lx.request`, regardless of the `timeout` the script asks for. */
export const LX_HTTP_REQUEST_TIMEOUT_MS = 15_000
/** Budget for one `musicUrl` call end to end, across every parallel request it makes. */
export const LX_RESOLVE_TIMEOUT_MS = 30_000
/**
 * Grace added to a worker RPC deadline on top of the in-worker budget, so the worker's own, more
 * specific error (timeout, network, CSP) reaches the provider instead of being replaced by a
 * generic RPC timeout.
 */
export const LX_RPC_GRACE_MS = 5_000
export const LX_RPC_MAX_BYTES = 256 * 1024
export const LX_HTTP_MAX_RESPONSE_BYTES = 1024 * 1024
/**
 * Most guest timers that may be pending at once (M-11). Chosen by static reading of the scripts in
 * the catalogue validation contract (星海 v2.3.13, lx-music-source.js, Huibq.js) and the built-in
 * 裤佬 script: none of them calls `setTimeout`/`setInterval` at all (request timeouts are passed to
 * `lx.request` as an option, and parallelism is `Promise.any` over two requests). The realistic
 * maximum is therefore 0; 32 leaves ample headroom for retry/backoff helpers in other user scripts
 * while bounding the duplicated callback handles a hostile script can pin.
 */
export const LX_GUEST_MAX_ACTIVE_TIMERS = 32
/**
 * Stable prefix of a sandbox refusal of a musicUrl result this deployment cannot play (plaintext
 * `http:` media, or media that needs custom request headers). `lxUser.ts` maps it to the
 * `invalid_response` failure code.
 */
export const LX_INVALID_RESPONSE = 'invalid_response'
/**
 * Stable prefix of an `lx.request` failure where the host `fetch` itself rejected (a dropped
 * connection, DNS failure, refused redirect), as opposed to the sandbox's own refusals (timeout,
 * size limit, CSP, protocol or method). `lxUser.ts` maps it to a transient `unavailable` sub-source
 * attempt (task 41.7), so the store retries the track instead of skipping it.
 */
export const LX_NETWORK_ERROR = 'network_error'
/**
 * Stable prefix of the per-call request tally the host appends to a failed `musicUrl` message, e.g.
 * `requests ok=0 http_error=3 blocked=4 timeout=0`. Without it every LX failure collapses into
 * `unavailable`, which cannot tell "the aggregators answered and the payload was unusable" from
 * "the browser never got a readable response" from "the upstreams returned 5xx". `lxUser.ts` maps
 * the counts to `invalid_response`, `transport_blocked` and `http_error` respectively.
 */
export const LX_REQUEST_TALLY = 'requests ok='
/**
 * Stable prefix of a request the host refused because a shared upstream's budget was exhausted.
 * `lxUser.ts` maps it to the `rate_limited` failure code, and the source loop moves on to another
 * source instead of waiting.
 */
export const LX_RATE_LIMITED = 'rate_limited'

export interface LxWorkerLoadRequest {
  type: 'load'
  id: string
  script: string
}

export interface LxWorkerMusicUrlRequest {
  type: 'musicUrl'
  id: string
  source: string
  songInfo: Record<string, unknown>
  quality: string
}

export interface LxWorkerDisposeRequest {
  type: 'dispose'
  id: string
}

export type LxWorkerRequest =
  | LxWorkerLoadRequest
  | LxWorkerMusicUrlRequest
  | LxWorkerDisposeRequest

export interface LxWorkerLoadResponse {
  type: 'load_result'
  id: string
  success: boolean
  initedMeta?: unknown
  error?: string
}

export interface LxWorkerMusicUrlResponse {
  type: 'musicUrl_result'
  id: string
  success: boolean
  url?: string
  requestHeaders?: Record<string, string>
  actualQuality?: string
  error?: string
}

export interface LxWorkerErrorResponse {
  type: 'error'
  id?: string
  error: string
}

export type LxWorkerResponse =
  | LxWorkerLoadResponse
  | LxWorkerMusicUrlResponse
  | LxWorkerErrorResponse

export interface LxMusicUrlResult {
  url?: string
  requestHeaders?: Record<string, string>
  actualQuality?: string
}

export type RequestValidationResult =
  | { valid: true; request: LxWorkerRequest }
  | { valid: false; error: string; id?: string }

export function validateWorkerRequest(data: unknown): RequestValidationResult {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Request payload must be an object' }
  }

  const msg = data as Record<string, unknown>
  const id = typeof msg.id === 'string' ? msg.id : undefined

  if (!id) {
    return { valid: false, error: 'Request missing valid id' }
  }

  if (typeof msg.type !== 'string') {
    return { valid: false, id, error: 'Request missing valid type' }
  }

  if (msg.type === 'load') {
    if (typeof msg.script !== 'string') {
      return { valid: false, id, error: 'Load request missing valid script string' }
    }
    if (msg.script.length > 512 * 1024) {
      return { valid: false, id, error: 'Script exceeds maximum allowed size (512 KiB)' }
    }
    return { valid: true, request: { type: 'load', id, script: msg.script } }
  }

  // Enforce RPC max size for non-load messages
  try {
    const jsonStr = JSON.stringify(data)
    if (jsonStr.length > LX_RPC_MAX_BYTES) {
      return { valid: false, id, error: `RPC payload exceeds maximum size of ${LX_RPC_MAX_BYTES} bytes` }
    }
  } catch {
    return { valid: false, id, error: 'RPC payload could not be serialized' }
  }

  if (msg.type === 'musicUrl') {
    if (typeof msg.source !== 'string' || !msg.source.trim()) {
      return { valid: false, id, error: 'musicUrl request missing valid source' }
    }
    if (!msg.songInfo || typeof msg.songInfo !== 'object' || Array.isArray(msg.songInfo)) {
      return { valid: false, id, error: 'musicUrl request missing valid songInfo object' }
    }
    if (typeof msg.quality !== 'string' || !msg.quality.trim()) {
      return { valid: false, id, error: 'musicUrl request missing valid quality' }
    }
    return {
      valid: true,
      request: {
        type: 'musicUrl',
        id,
        source: msg.source,
        songInfo: msg.songInfo as Record<string, unknown>,
        quality: msg.quality,
      },
    }
  }

  if (msg.type === 'dispose') {
    return { valid: true, request: { type: 'dispose', id } }
  }

  return { valid: false, id, error: `Unknown request type: ${String(msg.type)}` }
}

export function isWorkerResponse(data: unknown): data is LxWorkerResponse {
  if (!data || typeof data !== 'object') return false
  const msg = data as Record<string, unknown>
  if (typeof msg.type !== 'string') return false
  if (msg.type === 'load_result' || msg.type === 'musicUrl_result') {
    return typeof msg.id === 'string' && typeof msg.success === 'boolean'
  }
  if (msg.type === 'error') {
    return typeof msg.error === 'string'
  }
  return false
}

/** Host-only quota coordination. Guest code never receives this channel or its identifiers. */
export const LX_BUDGET_RPC_TIMEOUT_MS = 1_000
export interface LxBudgetQuery {
  type: 'gd_budget_acquire' | 'gd_budget_backoff'
  id: string
  retryAfterMs?: number
}
export interface LxBudgetReply {
  type: 'gd_budget_result'
  id: string
  ok: boolean
  retryAfterMs: number
}
export function isBudgetQuery(data: unknown): data is LxBudgetQuery {
  if (!data || typeof data !== 'object') return false
  const msg = data as Record<string, unknown>
  if (typeof msg.id !== 'string' || !msg.id || msg.id.length > 100) return false
  return msg.type === 'gd_budget_acquire' || (msg.type === 'gd_budget_backoff'
    && typeof msg.retryAfterMs === 'number' && Number.isFinite(msg.retryAfterMs)
    && msg.retryAfterMs >= 0 && msg.retryAfterMs <= 600_000)
}
export function isBudgetReply(data: unknown): data is LxBudgetReply {
  if (!data || typeof data !== 'object') return false
  const msg = data as Record<string, unknown>
  return msg.type === 'gd_budget_result' && typeof msg.id === 'string' && !!msg.id
    && msg.id.length <= 100 && typeof msg.ok === 'boolean'
    && typeof msg.retryAfterMs === 'number' && Number.isFinite(msg.retryAfterMs)
    && msg.retryAfterMs >= 0 && msg.retryAfterMs <= 600_000
}
