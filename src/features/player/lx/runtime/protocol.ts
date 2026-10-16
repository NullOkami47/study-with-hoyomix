export const LX_VM_MEMORY_BYTES = 16 * 1024 * 1024
export const LX_VM_STACK_BYTES = 512 * 1024
export const LX_VM_CALL_TIMEOUT_MS = 4_000
export const LX_RPC_MAX_BYTES = 256 * 1024
export const LX_HTTP_MAX_RESPONSE_BYTES = 1024 * 1024

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
