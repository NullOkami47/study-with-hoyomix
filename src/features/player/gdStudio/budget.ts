// The shared browser-side budget for GD Studio requests.
//
// GD Studio documents a dynamic limit of 50 requests per 5 minutes. This limiter's job is to keep
// *this browser* comfortably inside that: a conservative 40 requests per rolling 5 minutes, so a
// burst never brushes the published ceiling.
//
// What it counts — and this is the part that is easy to get wrong — is every outgoing API request
// the browser makes, not just playback attempts:
//   * search, url, picture and lyric requests;
//   * requests made directly by our own resolver;
//   * requests made *inside* an LX source script, which the QuickJS host reports through
//     `acquire()` before it touches the network;
//   * failed requests and retries, which consume real quota on the server too;
//   * the losers of a script's internal aggregator race, which were still sent.
//
// What it does NOT claim: that a client-side counter makes the deployment compliant with the
// server's per-IP limit. Several devices behind one NAT share that quota and cannot see each
// other's counters. The headroom exists for exactly that reason.
//
// The page admits all its Worker requests through bounded RPC and retains that window when a
// Worker is replaced. Tabs fan their admissions out over BroadcastChannel cooperatively; this is
// not an atomic cross-tab or per-IP quota. Without that channel each page still enforces its window.

export const GD_STUDIO_DEFAULT_BUDGET = 40
export const GD_STUDIO_WINDOW_MS = 5 * 60 * 1000
/** The one origin this budget guards. */
export { GD_STUDIO_API_ORIGIN } from '../../../shared/gdStudio'
import { GD_STUDIO_API_ORIGIN } from '../../../shared/gdStudio'

export interface GdStudioBudgetOptions {
  limit?: number
  windowMs?: number
  /** Broadcast channel name. Pass `null` to disable fan-out (tests, single-context use). */
  channelName?: string | null
  /** A persistence layer, used to survive a page reload. Unavailable inside a Worker. */
  storage?: Storage | null
  /** Overrides `BroadcastChannel`; lets tests observe the fan-out without a real channel. */
  createChannel?: ((name: string) => BroadcastChannel | null) | null
  now?: () => number
}

export interface AcquireResult {
  ok: boolean
  /** When refused, how long until a request may be attempted again. */
  retryAfterMs: number
  /** When refused, why: the window is full, or a 429 asked us to back off. */
  reason?: 'budget_exhausted' | 'backing_off'
}

interface PersistedWindow {
  /** Timestamps of the requests this browser has made, oldest last. */
  events: number[]
  /** Absolute time until which a 429 told us to stop. */
  backoffUntil: number
}

const STORAGE_KEY = 'hoyomix:gd-studio-budget:v1'

export class GdStudioBudget {
  private readonly limit: number
  private readonly windowMs: number
  private readonly nowFn: () => number
  private events: number[] = []
  private backoffUntil = 0
  private channel: BroadcastChannel | null
  private storage: Storage | null

  constructor(options: GdStudioBudgetOptions = {}) {
    this.limit = options.limit ?? GD_STUDIO_DEFAULT_BUDGET
    this.windowMs = options.windowMs ?? GD_STUDIO_WINDOW_MS
    this.nowFn = options.now ?? Date.now
    this.storage = options.storage ?? null

    if (options.channelName === null) {
      this.channel = null
    } else if (options.createChannel) {
      this.channel = options.createChannel(options.channelName ?? 'hoyomix:gd-studio-budget:v1')
    } else if (typeof BroadcastChannel === 'function') {
      this.channel = new BroadcastChannel(options.channelName ?? 'hoyomix:gd-studio-budget:v1')
    } else {
      this.channel = null
    }

    this.restore()
    this.channel?.addEventListener('message', (event: MessageEvent) => {
      this.observeRemote(event.data)
    })
  }

  /** True when a URL belongs to the origin this budget guards. */
  static guards(url: URL): boolean {
    return `${url.protocol}//${url.host}` === GD_STUDIO_API_ORIGIN
  }

  /**
   * Asks to spend one request, and spends it if the answer is yes.
   *
   * A refused request costs nothing, because it was never sent. An admitted one is recorded
   * immediately — before the outcome is known — because the server counts attempts, not successes.
   */
  tryAcquire(atMs: number = this.nowFn()): AcquireResult {
    this.prune(atMs)

    if (atMs < this.backoffUntil) {
      return { ok: false, retryAfterMs: this.backoffUntil - atMs, reason: 'backing_off' }
    }

    if (this.events.length >= this.limit) {
      const oldest = this.events[0] ?? atMs
      return { ok: false, retryAfterMs: Math.max(1, oldest + this.windowMs - atMs), reason: 'budget_exhausted' }
    }

    this.events.push(atMs)
    this.persist()
    this.broadcast({ kind: 'request', at: atMs })
    return { ok: true, retryAfterMs: 0 }
  }

  /** How many requests may still be made inside the current window. */
  remaining(atMs: number = this.nowFn()): number {
    this.prune(atMs)
    return Math.max(0, this.limit - this.events.length)
  }

  /** When the current window frees up a slot, in milliseconds from `atMs`. */
  retryAfter(atMs: number = this.nowFn()): number {
    this.prune(atMs)
    if (atMs < this.backoffUntil) return this.backoffUntil - atMs
    if (this.events.length >= this.limit) {
      const oldest = this.events[0] ?? atMs
      return Math.max(1, oldest + this.windowMs - atMs)
    }
    return 0
  }

  /**
   * Honours a 429. `retryAfterMs` comes from the response's `Retry-After` header when it carries
   * one, and is clamped so a hostile or broken header cannot silence the player for an hour.
   */
  noteRateLimited(retryAfterMs: number, atMs: number = this.nowFn()): void {
    const clamped = Math.min(Math.max(0, Math.round(retryAfterMs)), 10 * 60 * 1000)
    this.backoffUntil = Math.max(this.backoffUntil, atMs + clamped)
    this.persist()
    this.broadcast({ kind: 'backoff', until: this.backoffUntil })
  }

  /** Feeds a request another instance in this browser has made. */
  observeRemote(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const data = message as { kind?: unknown; at?: unknown; until?: unknown }
    if (data.kind === 'request' && typeof data.at === 'number') {
      this.events.push(data.at)
      this.events.sort((a, b) => a - b)
      this.persist()
    } else if (data.kind === 'backoff' && typeof data.until === 'number') {
      this.backoffUntil = Math.max(this.backoffUntil, data.until)
      this.persist()
    }
  }

  private prune(atMs: number): void {
    const cutoff = atMs - this.windowMs
    if (this.events.length > 0 && this.events[0]! < cutoff) {
      this.events = this.events.filter((timestamp) => timestamp >= cutoff)
    }
  }

  private broadcast(message: unknown): void {
    this.channel?.postMessage(message)
  }

  private restore(): void {
    const storage = this.storage
    if (!storage) return
    try {
      const raw = storage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as PersistedWindow
      const atMs = this.nowFn()
      if (Array.isArray(parsed.events)) {
        this.events = parsed.events.filter((timestamp) => typeof timestamp === 'number' && timestamp >= atMs - this.windowMs)
      }
      if (typeof parsed.backoffUntil === 'number') this.backoffUntil = parsed.backoffUntil
    } catch {
      // A corrupt or unreadable snapshot must not take the player down; start from empty.
      this.events = []
      this.backoffUntil = 0
    }
  }

  private persist(): void {
    const storage = this.storage
    if (!storage) return
    try {
      const snapshot: PersistedWindow = { events: this.events.slice(-this.limit), backoffUntil: this.backoffUntil }
      storage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      // Quota or privacy mode: the in-memory window still applies.
    }
  }

  /** Stops listening to the fan-out channel. Safe to call more than once. */
  dispose(): void {
    this.channel?.close()
    this.channel = null
  }
}

/**
 * Shares one budget instance across everything in this JS context.
 *
 * The page owns this instance. QuickJS Workers ask their parent for admission over bounded RPC,
 * so replacing a Worker never resets its quota. Available localStorage survives page reloads;
 * BroadcastChannel provides cooperative cross-tab fan-out.
 */
let sharedBudget: GdStudioBudget | null = null

export function getSharedGdStudioBudget(): GdStudioBudget {
  if (!sharedBudget) {
    let storage: Storage | null = null
    try { storage = globalThis.localStorage ?? null } catch { /* Privacy mode: retain the page window. */ }
    sharedBudget = new GdStudioBudget({ storage })
  }
  return sharedBudget
}

/** Test seam: forget the shared instance so the next construction starts clean. */
export function resetSharedGdStudioBudget(): void {
  sharedBudget?.dispose()
  sharedBudget = null
}
