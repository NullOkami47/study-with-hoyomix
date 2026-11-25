import { GdStudioBudget } from '../../gdStudio/budget'
import { validateWorkerRequest, isBudgetReply, LX_BUDGET_RPC_TIMEOUT_MS, type LxBudgetQuery, type LxWorkerResponse } from './protocol'
import { QuickJsLxHost } from './quickjsHost'

export function setupWorkerHandler(
  postMessage: (response: LxWorkerResponse | LxBudgetQuery) => void,
): (data: unknown) => Promise<void> {
  let host: QuickJsLxHost | null = null
  let budgetId = 0
  const waiting = new Map<string, (result: { ok: boolean; retryAfterMs: number }) => void>()
  const denied = { ok: false, retryAfterMs: LX_BUDGET_RPC_TIMEOUT_MS }
  const gateRequest = (url: URL) => {
    if (!GdStudioBudget.guards(url)) return null
    // A missing parent, stalled channel or excessive fan-out must never create a fresh quota.
    if (waiting.size >= 40) return Promise.resolve(denied)
    return new Promise<{ ok: boolean; retryAfterMs: number }>((resolve) => {
      const id = `budget_${++budgetId}`
      const timer = setTimeout(() => { waiting.delete(id); resolve(denied) }, LX_BUDGET_RPC_TIMEOUT_MS)
      waiting.set(id, (result) => { clearTimeout(timer); waiting.delete(id); resolve(result) })
      try { postMessage({ type: 'gd_budget_acquire', id }) }
      catch { waiting.get(id)?.(denied) }
    })
  }
  const noteResponse = (url: URL, response: Response) => {
    if (!GdStudioBudget.guards(url) || response.status !== 429) return
    const raw = response.headers.get('retry-after')
    const seconds = raw === null ? NaN : Number(raw)
    const date = raw === null ? NaN : Date.parse(raw)
    const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000
      : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 30_000
    postMessage({ type: 'gd_budget_backoff', id: `budget_${++budgetId}`, retryAfterMs: Math.min(delay, 600_000) })
  }

  return async (data: unknown) => {
    if (isBudgetReply(data)) {
      waiting.get(data.id)?.(data)
      return
    }
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
        host = await QuickJsLxHost.create({ requestGate: gateRequest, onResponse: noteResponse })
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
        for (const settle of [...waiting.values()]) settle(denied)
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
