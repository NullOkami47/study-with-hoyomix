import { validateWorkerRequest, type LxWorkerResponse } from './protocol'
import { QuickJsLxHost } from './quickjsHost'

export function setupWorkerHandler(
  postMessage: (response: LxWorkerResponse) => void,
): (data: unknown) => Promise<void> {
  let host: QuickJsLxHost | null = null

  return async (data: unknown) => {
    const validation = validateWorkerRequest(data)
    if (!validation.valid) {
      postMessage({
        type: 'error',
        id: validation.id,
        error: validation.error,
      })
      return
    }

    const req = validation.request
    try {
      if (req.type === 'load') {
        if (host) {
          host.dispose()
          host = null
        }
        host = await QuickJsLxHost.create()
        const { initedMeta } = await host.loadSource(req.script)
        postMessage({
          type: 'load_result',
          id: req.id,
          success: true,
          initedMeta,
        })
        return
      }

      if (req.type === 'musicUrl') {
        if (!host) {
          postMessage({
            type: 'musicUrl_result',
            id: req.id,
            success: false,
            error: 'No LX source loaded in runtime',
          })
          return
        }
        const result = await host.callMusicUrl(req.source, req.songInfo, req.quality)
        postMessage({
          type: 'musicUrl_result',
          id: req.id,
          success: true,
          url: result.url,
          requestHeaders: result.requestHeaders,
          actualQuality: result.actualQuality,
        })
        return
      }

      if (req.type === 'dispose') {
        if (host) {
          host.dispose()
          host = null
        }
        postMessage({
          type: 'load_result',
          id: req.id,
          success: true,
        })
        return
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (req.type === 'load') {
        postMessage({ type: 'load_result', id: req.id, success: false, error: errorMsg })
      } else if (req.type === 'musicUrl') {
        postMessage({ type: 'musicUrl_result', id: req.id, success: false, error: errorMsg })
      } else {
        postMessage({ type: 'error', id: req.id, error: errorMsg })
      }
    }
  }
}

// In worker global context, bind to self
if (typeof self !== 'undefined' && typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function') {
  const handler = setupWorkerHandler((resp) => {
    self.postMessage(resp)
  })
  self.addEventListener('message', (event: MessageEvent) => {
    void handler(event.data)
  })
}
