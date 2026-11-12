import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LxRuntimeClient } from './client'
import { setupWorkerHandler } from './worker'
import { getSharedGdStudioBudget, resetSharedGdStudioBudget } from '../../gdStudio/budget'

vi.mock('../cspAllowList', async (importOriginal) => {
  const original = await importOriginal<typeof import('../cspAllowList')>()
  return { ...original, BUILD_LX_CSP_SOURCES: { connect: ['https://music-api.gdstudio.xyz'], media: ['https://cdn.example.com'] } }
})

class BudgetWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror = null
  terminated = false
  private handler = setupWorkerHandler((data) => {
    if (!this.terminated) this.onmessage?.({ data } as MessageEvent)
  })
  postMessage(data: unknown) { queueMicrotask(() => { if (!this.terminated) void this.handler(data) }) }
  terminate() {
    this.terminated = true
    // A real Worker destroys its WASM heap on termination; the in-process fixture must too.
    void this.handler({ type: 'dispose', id: 'terminate' })
  }
}
const script = `
  lx.on(lx.EVENT_NAMES.request, () => new Promise((resolve, reject) => {
    lx.request('https://music-api.gdstudio.xyz/api.php?types=url', {}, (err, res) => {
      if (err) reject(new Error(err.message || String(err)));
      else resolve('https://cdn.example.com/audio.mp3');
    });
  }));
`
const clients: LxRuntimeClient[] = []
const workers: BudgetWorker[] = []
async function makeClient() {
  const client = new LxRuntimeClient({ workerFactory: () => {
    const worker = new BudgetWorker()
    workers.push(worker)
    return worker as unknown as Worker
  } })
  clients.push(client)
  await client.loadSource(script)
  return client
}

describe('GD Studio admission through actual LX worker RPC', () => {
  beforeEach(() => {
    localStorage.clear()
    resetSharedGdStudioBudget()
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })
  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.dispose()))
    workers.splice(0)
    resetSharedGdStudioBudget()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('retains the page budget across separate resolution clients and replacement workers', async () => {
    for (let i = 0; i < 38; i++) expect(getSharedGdStudioBudget().tryAcquire().ok).toBe(true)
    const first = await makeClient()
    await first.callMusicUrl('wy', { id: '1' }, '128k')
    await first.dispose()
    const next = await makeClient()
    await next.callMusicUrl('wy', { id: '2' }, '128k')
    workers.at(-1)!.onerror?.({ message: 'replacement' } as ErrorEvent)
    await expect(next.callMusicUrl('wy', { id: '3' }, '128k')).rejects.toThrow('rate_limited')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('restores the default page budget after reload without broadcast history', async () => {
    for (let i = 0; i < 40; i++) getSharedGdStudioBudget().tryAcquire()
    resetSharedGdStudioBudget()
    const client = await makeClient()
    await expect(client.callMusicUrl('wy', { id: '1' }, '128k')).rejects.toThrow('rate_limited')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shares an actual upstream 429 backoff with the next worker', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('slow', { status: 429, headers: { 'retry-after': '60' } }))
    const first = await makeClient()
    await first.callMusicUrl('wy', { id: '1' }, '128k')
    await first.dispose()
    const next = await makeClient()
    await expect(next.callMusicUrl('wy', { id: '2' }, '128k')).rejects.toThrow('rate_limited')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('refuses GD Studio when the parent coordinator does not answer, including malformed approvals', async () => {
    const messages: unknown[] = []
    const handler = setupWorkerHandler((data) => { messages.push(data) })
    await handler({ type: 'load', id: 'load', script })
    const call = handler({ type: 'musicUrl', id: 'resolve', source: 'wy', songInfo: { id: '1' }, quality: '128k' })
    // Even a message claiming approval cannot bypass validation or spend a different pending ID.
    await handler({ type: 'gd_budget_result', id: 'budget_1', ok: true, retryAfterMs: NaN })
    await handler({ type: 'gd_budget_result', id: 'unknown', ok: true, retryAfterMs: 0 })
    await call
    expect(messages).toContainEqual(expect.objectContaining({ type: 'gd_budget_acquire' }))
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'musicUrl_result', success: false, error: expect.stringContaining('rate_limited'),
    }))
    expect(fetch).not.toHaveBeenCalled()
    await handler({ type: 'dispose', id: 'dispose' })
  })

  it('retains a bounded page budget when browser storage is unavailable', async () => {
    vi.stubGlobal('localStorage', undefined)
    for (let i = 0; i < 39; i++) getSharedGdStudioBudget().tryAcquire()
    const first = await makeClient()
    await first.callMusicUrl('wy', { id: '1' }, '128k')
    await first.dispose()
    const next = await makeClient()
    await expect(next.callMusicUrl('wy', { id: '2' }, '128k')).rejects.toThrow('rate_limited')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('ignores delayed quota messages from a terminated worker', async () => {
    const client = await makeClient()
    const staleMessage = workers.at(-1)!.onmessage!
    workers.at(-1)!.onerror?.({ message: 'replacement' } as ErrorEvent)
    staleMessage({ data: { type: 'gd_budget_backoff', id: 'budget_1', retryAfterMs: 600_000 } } as MessageEvent)
    await expect(client.callMusicUrl('wy', { id: '1' }, '128k')).resolves.toMatchObject({ url: 'https://cdn.example.com/audio.mp3' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

})
