import { describe, it, expect, vi, afterEach } from 'vitest'
import { LxRuntimeClient } from './client'
import { setupWorkerHandler } from './worker'
import { LX_RPC_MAX_BYTES } from './protocol'
import { ProviderResolveError } from '../../providers/types'
import { playbackLog } from '../../playbackLog'

class TestWorker implements Partial<Worker> {
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: ErrorEvent) => void) | null = null
  onmessageerror: ((ev: MessageEvent) => void) | null = null
  terminated = false

  private handler: (data: unknown) => Promise<void>

  constructor(handlerOverride?: (post: (msg: any) => void) => (data: unknown) => Promise<void>) {
    const post = (resp: any) => {
      if (this.terminated) return
      this.onmessage?.({ data: resp } as MessageEvent)
    }
    this.handler = handlerOverride ? handlerOverride(post) : setupWorkerHandler(post)
  }

  postMessage(message: unknown): void {
    if (this.terminated) {
      throw new Error('Worker is terminated')
    }
    queueMicrotask(async () => {
      if (this.terminated) return
      try {
        await this.handler(message)
      } catch (err) {
        this.onerror?.({ message: String(err) } as ErrorEvent)
      }
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

describe('LxRuntimeClient', () => {
  let client: LxRuntimeClient | null = null

  afterEach(async () => {
    if (client) {
      await client.dispose()
      client = null
    }
  })

  it('loads a source script and retrieves inited metadata', async () => {
    client = new LxRuntimeClient({
      workerFactory: () => new TestWorker() as unknown as Worker,
    })

    const script = `
      lx.send(lx.EVENT_NAMES.inited, {
        openDevTools: false,
        sources: {
          wy: { name: 'NetEase', qualitys: ['128k', '320k', 'flac'] }
        }
      });
      lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
        if (action === 'musicUrl') {
          return 'https://cdn.example.com/' + info.musicInfo.id + '.mp3';
        }
      });
    `

    const { initedMeta } = await client.loadSource(script)
    expect(initedMeta).toEqual({
      openDevTools: false,
      sources: {
        wy: { name: 'NetEase', qualitys: ['128k', '320k', 'flac'] },
      },
    })
  })

  // Deliberately changed by M-11 (task 23.5): this used to return `headers` from the guest and pin
  // their passthrough as `requestHeaders`. The sandbox now refuses results that need custom headers
  // (3.6), so the RPC round trip is checked with a header-free result, and the refusal crossing the
  // Worker boundary is checked separately below.
  it('resolves musicUrl through worker RPC', async () => {
    client = new LxRuntimeClient({
      workerFactory: () => new TestWorker() as unknown as Worker,
    })

    const script = `
      lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
        if (action === 'musicUrl') {
          return {
            url: 'https://cdn.example.com/audio/' + info.musicInfo.id + '.flac',
            quality: 'lossless'
          };
        }
      });
    `
    await client.loadSource(script)

    const result = await client.callMusicUrl('wy', { id: 'song_123' }, 'flac')
    expect(result).toEqual({
      url: 'https://cdn.example.com/audio/song_123.flac',
      actualQuality: 'lossless',
    })
    expect(result.requestHeaders).toBeUndefined()
  })

  it('surfaces the sandbox refusal of a result needing custom headers through worker RPC', async () => {
    client = new LxRuntimeClient({
      workerFactory: () => new TestWorker() as unknown as Worker,
    })
    await client.loadSource(`
      lx.on(lx.EVENT_NAMES.request, () => ({ url: 'https://cdn.example.com/a.flac', headers: { 'X-Custom-Auth': 'needed' } }));
    `)
    await expect(client.callMusicUrl('wy', { id: 'song_123' }, 'flac')).rejects.toThrow(/^invalid_response:/)
  })

  it('enforces call timeout and terminates unresponsive worker', async () => {
    let createdWorkers = 0
    const workerInstances: TestWorker[] = []

    // Custom worker that hangs forever on musicUrl
    const hangingFactory = () => {
      createdWorkers++
      const worker = new TestWorker((post) => {
        return async (data: any) => {
          if (data?.type === 'load') {
            post({ type: 'load_result', id: data.id, success: true })
          }
          // On musicUrl, intentionally do nothing (hang)
        }
      })
      workerInstances.push(worker)
      return worker as unknown as Worker
    }

    client = new LxRuntimeClient({
      workerFactory: hangingFactory,
      callTimeoutMs: 60,
    })

    await client.loadSource('// dummy')
    expect(createdWorkers).toBe(1)
    expect(workerInstances[0].terminated).toBe(false)

    // callMusicUrl should time out and terminate worker 0
    await expect(client.callMusicUrl('wy', { id: 'test' }, '128k')).rejects.toThrow(/timed out/i)
    expect(workerInstances[0].terminated).toBe(true)

    // Next call should recreate fresh worker
    await client.loadSource('// fresh')
    expect(createdWorkers).toBe(2)
    expect(workerInstances[1].terminated).toBe(false)
  })

  it('rejects oversized script in loadSource (client side)', async () => {
    client = new LxRuntimeClient({
      workerFactory: () => new TestWorker() as unknown as Worker,
    })

    const oversizedScript = 'a'.repeat(512 * 1024 + 10)
    await expect(client.loadSource(oversizedScript)).rejects.toThrow(/maximum allowed size/i)
  })

  it('rejects oversized RPC payload in callMusicUrl', async () => {
    client = new LxRuntimeClient({
      workerFactory: () => new TestWorker() as unknown as Worker,
    })

    const hugePayload: Record<string, unknown> = {
      id: '123',
      bloat: 'x'.repeat(LX_RPC_MAX_BYTES + 100),
    }

    await expect(client.callMusicUrl('wy', hugePayload, '128k')).rejects.toThrow(/maximum size/i)
  })

  it('handles malformed worker responses by terminating worker', async () => {
    const workerHolder: { current: TestWorker | null } = { current: null }
    const malformedFactory = () => {
      workerHolder.current = new TestWorker((post) => {
        return async (_data: any) => {
          // Post invalid response object missing required fields
          post({ invalid: 'garbage' })
        }
      })
      return workerHolder.current as unknown as Worker
    }

    client = new LxRuntimeClient({
      workerFactory: malformedFactory,
      callTimeoutMs: 100,
    })

    await expect(client.loadSource('// test')).rejects.toThrow(/Protocol error|timed out/i)
    expect(workerHolder.current?.terminated).toBe(true)
  })

  it('terminates worker and cleans up on dispose', async () => {
    const workerHolder: { current: TestWorker | null } = { current: null }
    client = new LxRuntimeClient({
      workerFactory: () => {
        workerHolder.current = new TestWorker()
        return workerHolder.current as unknown as Worker
      },
    })

    await client.loadSource('// test')
    expect(workerHolder.current?.terminated).toBe(false)

    await client.dispose()
    expect(workerHolder.current?.terminated).toBe(true)

    // Cannot call after dispose
    await expect(client.loadSource('// test')).rejects.toThrow(/disposed/i)
  })
})


it('abort terminates a busy Worker synchronously and rejects all pending RPCs',async()=>{
 const worker=new TestWorker(()=>()=>new Promise(()=>{}))
 const client=new LxRuntimeClient({workerFactory:()=>worker as unknown as Worker})
 const pending=client.loadSource('// pending')
 const rejection=expect(pending).rejects.toThrow(/abort/i)
 try{client.abort();expect(worker.terminated).toBe(true);await rejection;await client.dispose()}finally{worker.terminate();await client.dispose()}
})

it('retains the caller timeout reason when aborting a busy Worker', async () => {
  const worker = new TestWorker(() => () => new Promise(() => {}))
  const client = new LxRuntimeClient({ workerFactory: () => worker as unknown as Worker })
  const reason = new ProviderResolveError('timeout')
  const rejection = expect(client.loadSource('// pending')).rejects.toBe(reason)
  try {
    client.abort(reason)
    expect(worker.terminated).toBe(true)
    await rejection
  } finally {
    worker.terminate()
    await client.dispose()
  }
})

it('records redacted lx.worker.error and lx.worker.timeout breadcrumbs without leaking tokens or raw URLs', async () => {
  playbackLog.clear()
  const worker = new TestWorker((post) => async (data: any) => {
    if (data?.type === 'load') {
      post({ type: 'error', error: 'paper lantern at https://guest.local/path?token=TOP_SECRET_123 Bearer abc.def.ghi' })
    }
  })
  const errClient = new LxRuntimeClient({ workerFactory: () => worker as unknown as Worker })
  await expect(errClient.loadSource('// test')).rejects.toThrow(/Worker fatal error/)
  await errClient.dispose()

  const hangingWorker = new TestWorker(() => async () => {})
  const timeoutClient = new LxRuntimeClient({
    workerFactory: () => hangingWorker as unknown as Worker,
    callTimeoutMs: 25,
  })
  await expect(timeoutClient.loadSource('// hang')).rejects.toThrow(/timed out/i)
  await timeoutClient.dispose()

  const entries = playbackLog.snapshot()
  const workerErr = entries.find((e) => e.type === 'lx.worker.error')
  const workerTimeout = entries.find((e) => e.type === 'lx.worker.timeout')
  expect(workerErr).toMatchObject({ category: 'fatal', level: 'error', stage: 'worker', requestType: 'load', pendingCount: 1 })
  expect(workerErr).not.toHaveProperty('message')
  expect(playbackLog.exportJson()).not.toMatch(/paper lantern|guest\.local|TOP_SECRET_123|abc\.def\.ghi/u)
  expect(workerTimeout).toMatchObject({ level: 'error', stage: 'rpc', requestType: 'load', deadlineMs: 25 })
})

it.each(['onerror', 'onmessageerror'] as const)('ignores a terminated Worker’s late %s during the replacement load', async (eventName) => {
  playbackLog.clear()
  const first = new TestWorker(() => async () => {})
  const next = new TestWorker((post) => async (data) => {
    if (typeof data === 'object' && data !== null && 'id' in data) {
      post({ type: 'load_result', id: data.id, success: true })
    }
  })
  const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(next)
  const client = new LxRuntimeClient({ workerFactory: factory })
  try {
    const rejected = expect(client.loadSource('// first')).rejects.toThrow(/Worker error/i)
    const late = first[eventName]!
    first.onerror!({ message: 'paper lantern' } as ErrorEvent)
    await rejected
    const replacement = client.loadSource('// second')
    late({} as ErrorEvent & MessageEvent)
    await expect(replacement).resolves.toBeDefined()
    expect(next.terminated).toBe(false)
    const fatals = playbackLog.snapshot().filter((entry) => entry.type === 'lx.worker.error')
    expect(fatals).toHaveLength(1)
    expect(fatals[0]).toMatchObject({ category: 'runtime', requestType: 'load' })
  } finally {
    await client.dispose()
  }
})
