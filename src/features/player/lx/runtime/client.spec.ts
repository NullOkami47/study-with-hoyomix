import { describe, it, expect, vi, afterEach } from 'vitest'
import { LxRuntimeClient } from './client'
import { setupWorkerHandler } from './worker'
import { LX_RPC_MAX_BYTES } from './protocol'

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

  it('resolves musicUrl through worker RPC', async () => {
    client = new LxRuntimeClient({
      workerFactory: () => new TestWorker() as unknown as Worker,
    })

    const script = `
      lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
        if (action === 'musicUrl') {
          return {
            url: 'https://cdn.example.com/audio/' + info.musicInfo.id + '.flac',
            headers: { 'X-Custom-Auth': 'allowed' },
            quality: 'lossless'
          };
        }
      });
    `
    await client.loadSource(script)

    const result = await client.callMusicUrl('wy', { id: 'song_123' }, 'flac')
    expect(result).toEqual({
      url: 'https://cdn.example.com/audio/song_123.flac',
      requestHeaders: { 'X-Custom-Auth': 'allowed' },
      actualQuality: 'lossless',
    })
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
