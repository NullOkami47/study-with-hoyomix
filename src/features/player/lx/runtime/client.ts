import { getSharedGdStudioBudget } from '../../gdStudio/budget'
import {
  LX_RPC_MAX_BYTES,
  LX_VM_CALL_TIMEOUT_MS,
  LX_INIT_TIMEOUT_MS,
  LX_RESOLVE_TIMEOUT_MS,
  LX_RPC_GRACE_MS,
  isWorkerResponse,
  isBudgetQuery,
  type LxBudgetReply,
  type LxMusicUrlResult,
  type LxWorkerDisposeRequest,
  type LxWorkerLoadRequest,
  type LxWorkerMusicUrlRequest,
  type LxWorkerRequest,
  type LxWorkerResponse,
} from './protocol'

export interface LxRuntimeClientOptions {
  workerFactory?: () => Worker
  /**
   * Overrides the RPC deadline. Left unset, each request type uses its own in-worker budget plus
   * `LX_RPC_GRACE_MS`, so the worker's specific error arrives instead of a generic RPC timeout.
   */
  callTimeoutMs?: number
}

interface PendingRpc {
  resolve: (value: any) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  type: string
}

let clientIdCounter = 1

export class LxRuntimeClient {
  private worker: Worker | null = null
  private pending = new Map<string, PendingRpc>()
  private workerFactory: () => Worker
  /** Explicit override for every RPC deadline; null means "per request type". */
  private callTimeoutMs: number | null
  private disposed = false
  /** The last script the current or previous Worker loaded successfully (M-11 reload). */
  private loadedScript: string | null = null
  /** True when the Worker holding `loadedScript` was terminated and its replacement has no source. */
  private needsReload = false
  private reloading: Promise<void> | null = null

  constructor(options?: LxRuntimeClientOptions) {
    this.workerFactory = options?.workerFactory ?? (() => {
      return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    })
    this.callTimeoutMs = options?.callTimeoutMs ?? null
  }

  /** The RPC deadline for one request type: the in-worker budget plus a delivery grace. */
  private rpcDeadlineFor(type: LxWorkerRequest['type']): number {
    if (this.callTimeoutMs !== null) return this.callTimeoutMs
    if (type === 'load') return LX_INIT_TIMEOUT_MS + LX_RPC_GRACE_MS
    if (type === 'musicUrl') return LX_RESOLVE_TIMEOUT_MS + LX_RPC_GRACE_MS
    return LX_VM_CALL_TIMEOUT_MS
  }

  private ensureWorker(): Worker {
    if (this.disposed) {
      throw new Error('LxRuntimeClient has been disposed')
    }

    if (!this.worker) {
      this.worker = this.workerFactory()

      const worker = this.worker
      this.worker.onmessage = (event: MessageEvent) => {
        if (this.worker !== worker) return
        this.handleMessage(event.data)
      }

      this.worker.onerror = (event: ErrorEvent) => {
        this.handleWorkerFatal(new Error(`LX Worker error: ${event.message || 'unknown error'}`))
      }

      this.worker.onmessageerror = () => {
        this.handleWorkerFatal(new Error('LX Worker message deserialization error'))
      }
    }

    return this.worker
  }

  private handleMessage(data: unknown): void {
    if (isBudgetQuery(data)) {
      const budget = getSharedGdStudioBudget()
      if (data.type === 'gd_budget_backoff') {
        budget.noteRateLimited(data.retryAfterMs!)
      } else {
        const reply: LxBudgetReply = { type: 'gd_budget_result', id: data.id, ...budget.tryAcquire() }
        this.worker?.postMessage(reply)
      }
      return
    }
    if (!isWorkerResponse(data)) {
      this.handleWorkerFatal(new Error('Protocol error: Invalid worker response'))
      return
    }

    const response = data as LxWorkerResponse
    if (!response.id) {
      if (response.type === 'error') {
        this.handleWorkerFatal(new Error(`Worker fatal error: ${response.error}`))
      }
      return
    }

    const pending = this.pending.get(response.id)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(response.id)

    if (response.type === 'load_result') {
      if (response.success) {
        pending.resolve({ initedMeta: response.initedMeta })
      } else {
        pending.reject(new Error(response.error || 'Failed to load LX source'))
      }
      return
    }

    if (response.type === 'musicUrl_result') {
      if (response.success) {
        pending.resolve({
          url: response.url,
          requestHeaders: response.requestHeaders,
          actualQuality: response.actualQuality,
        })
      } else {
        pending.reject(new Error(response.error || 'Failed to resolve music URL'))
      }
      return
    }

    if (response.type === 'error') {
      pending.reject(new Error(response.error || 'Worker error'))
      return
    }
  }

  private handleWorkerFatal(error: Error): void {
    this.terminateWorkerInternal(error)
  }

  private terminateWorkerInternal(error: Error): void {
    if (this.worker) {
      try {
        this.worker.terminate()
      } catch {
        // ignore
      }
      this.worker = null
      // M-11: the replacement Worker starts empty; reload the source before its next RPC.
      if (this.loadedScript !== null) this.needsReload = true
    }

    // Reject all pending RPCs
    const pendingList = Array.from(this.pending.values())
    this.pending.clear()

    for (const item of pendingList) {
      clearTimeout(item.timer)
      item.reject(error)
    }
  }

  private sendRequest<T>(request: LxWorkerRequest): Promise<T> {
    const worker = this.ensureWorker()
    const deadlineMs = this.rpcDeadlineFor(request.type)

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        const timeoutError = new Error(`LX call timed out after ${deadlineMs}ms`)
        // Terminate worker on timeout so it doesn't leave orphaned execution
        this.terminateWorkerInternal(timeoutError)
        reject(timeoutError)
      }, deadlineMs)

      this.pending.set(request.id, {
        resolve,
        reject,
        timer,
        type: request.type,
      })

      try {
        worker.postMessage(request)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(request.id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async loadSource(script: string): Promise<{ initedMeta?: unknown }> {
    if (typeof script !== 'string') {
      throw new Error('Script must be a string')
    }
    if (script.length > 512 * 1024) {
      throw new Error('Script exceeds maximum allowed size (512 KiB)')
    }

    // A fresh load replaces whatever a reload would have restored.
    this.needsReload = false
    this.loadedScript = null
    const result = await this.sendLoad(script)
    this.loadedScript = script
    return result
  }

  private sendLoad(script: string): Promise<{ initedMeta?: unknown }> {
    const id = `load_${clientIdCounter++}_${Date.now()}`
    const request: LxWorkerLoadRequest = {
      type: 'load',
      id,
      script,
    }

    return this.sendRequest<{ initedMeta?: unknown }>(request)
  }

  /** Reloads the current source into a Worker recreated after termination (M-11). */
  private async ensureSourceLoaded(): Promise<void> {
    if (!this.needsReload || this.loadedScript === null) return
    if (!this.reloading) {
      const script = this.loadedScript
      this.reloading = (async () => {
        try {
          await this.sendLoad(script)
          if (this.loadedScript === script) this.needsReload = false
        } finally {
          this.reloading = null
        }
      })()
    }
    await this.reloading
  }

  async callMusicUrl(
    source: string,
    songInfo: Record<string, unknown>,
    quality: string,
  ): Promise<LxMusicUrlResult> {
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error('source must be a non-empty string')
    }
    if (!songInfo || typeof songInfo !== 'object' || Array.isArray(songInfo)) {
      throw new Error('songInfo must be a non-empty object')
    }
    if (typeof quality !== 'string' || !quality.trim()) {
      throw new Error('quality must be a non-empty string')
    }

    const id = `url_${clientIdCounter++}_${Date.now()}`
    const request: LxWorkerMusicUrlRequest = {
      type: 'musicUrl',
      id,
      source,
      songInfo,
      quality,
    }

    // Enforce RPC max size before sending
    try {
      const jsonStr = JSON.stringify(request)
      if (jsonStr.length > LX_RPC_MAX_BYTES) {
        throw new Error(`RPC payload exceeds maximum size of ${LX_RPC_MAX_BYTES} bytes`)
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('maximum size')) throw err
      throw new Error('Failed to serialize musicUrl request')
    }

    await this.ensureSourceLoaded()
    return this.sendRequest<LxMusicUrlResult>(request)
  }

  /** Cancellation releases the whole isolate immediately, even while guest code is awaiting I/O. */
  abort(reason?: unknown): void {
    if (this.disposed) return
    this.disposed = true
    this.loadedScript = null
    this.needsReload = false
    this.terminateWorkerInternal(reason instanceof Error ? reason : new Error('LX resolution aborted'))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    if (this.worker) {
      const id = `dispose_${clientIdCounter++}_${Date.now()}`
      const request: LxWorkerDisposeRequest = {
        type: 'dispose',
        id,
      }

      try {
        await Promise.race([
          this.sendRequest<void>(request),
          new Promise((resolve) => setTimeout(resolve, 200)),
        ])
      } catch {
        // ignore errors during dispose
      } finally {
        this.terminateWorkerInternal(new Error('Client disposed'))
      }
    }
  }
}
