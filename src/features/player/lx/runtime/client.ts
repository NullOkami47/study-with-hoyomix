import {
  LX_RPC_MAX_BYTES,
  LX_VM_CALL_TIMEOUT_MS,
  isWorkerResponse,
  type LxMusicUrlResult,
  type LxWorkerDisposeRequest,
  type LxWorkerLoadRequest,
  type LxWorkerMusicUrlRequest,
  type LxWorkerRequest,
  type LxWorkerResponse,
} from './protocol'

export interface LxRuntimeClientOptions {
  workerFactory?: () => Worker
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
  private callTimeoutMs: number
  private disposed = false

  constructor(options?: LxRuntimeClientOptions) {
    this.workerFactory = options?.workerFactory ?? (() => {
      return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    })
    this.callTimeoutMs = options?.callTimeoutMs ?? LX_VM_CALL_TIMEOUT_MS
  }

  private ensureWorker(): Worker {
    if (this.disposed) {
      throw new Error('LxRuntimeClient has been disposed')
    }

    if (!this.worker) {
      this.worker = this.workerFactory()

      this.worker.onmessage = (event: MessageEvent) => {
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

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        const timeoutError = new Error(`LX call timed out after ${this.callTimeoutMs}ms`)
        // Terminate worker on timeout so it doesn't leave orphaned execution
        this.terminateWorkerInternal(timeoutError)
        reject(timeoutError)
      }, this.callTimeoutMs)

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

    const id = `load_${clientIdCounter++}_${Date.now()}`
    const request: LxWorkerLoadRequest = {
      type: 'load',
      id,
      script,
    }

    return this.sendRequest<{ initedMeta?: unknown }>(request)
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

    return this.sendRequest<LxMusicUrlResult>(request)
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
