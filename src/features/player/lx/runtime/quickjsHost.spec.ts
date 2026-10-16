import { describe, it, expect, vi, afterEach } from 'vitest'
import { QuickJsLxHost } from './quickjsHost'

describe('QuickJsLxHost Sandbox', () => {
  let host: QuickJsLxHost | null = null

  afterEach(() => {
    if (host) {
      host.dispose()
      host = null
    }
  })

  it('proves no window, document, localStorage, DOM, fetch or XMLHttpRequest in sandbox', async () => {
    host = await QuickJsLxHost.create()

    expect(await host.evalCode('typeof window')).toBe('undefined')
    expect(await host.evalCode('typeof document')).toBe('undefined')
    expect(await host.evalCode('typeof localStorage')).toBe('undefined')
    expect(await host.evalCode('typeof sessionStorage')).toBe('undefined')
    expect(await host.evalCode('typeof fetch')).toBe('undefined')
    expect(await host.evalCode('typeof XMLHttpRequest')).toBe('undefined')
  })

  it('proves eval and Function constructors are disabled', async () => {
    host = await QuickJsLxHost.create()

    expect(await host.evalCode('typeof eval')).toBe('undefined')
    expect(await host.evalCode('typeof Function')).toBe('undefined')

    await expect(host.evalCode('eval("1 + 1")')).rejects.toThrow()
    await expect(host.evalCode('(function(){}).constructor("return 1")()')).rejects.toThrow()
    await expect(host.evalCode('(async function(){}).constructor("return 1")()')).rejects.toThrow()
    await expect(host.evalCode('(function*(){}).constructor("return 1")()')).rejects.toThrow()
  })

  it('exposes minimal lx metadata, redacted console, and buffer utilities', async () => {
    host = await QuickJsLxHost.create()

    expect(await host.evalCode('lx.version')).toBe('2.0.0')
    expect(await host.evalCode('lx.env')).toBe('desktop')
    expect(await host.evalCode('lx.EVENT_NAMES.request')).toBe('request')
    expect(await host.evalCode('lx.EVENT_NAMES.inited')).toBe('inited')
    expect(await host.evalCode('lx.EVENT_NAMES.updateAlert')).toBe('updateAlert')

    // Console functions are no-ops
    expect(await host.evalCode('typeof console.log')).toBe('function')
    expect(await host.evalCode('console.log("secret-test"); 1')).toBe(1)

    // Buffer utility
    expect(await host.evalCode('lx.utils.buffer.from("hello").toString()')).toBe('hello')
    expect(await host.evalCode('lx.utils.buffer.from("48656c6c6f", "hex").toString()')).toBe('Hello')
    expect(await host.evalCode('lx.utils.buffer.from("SGVsbG8=", "base64").toString()')).toBe('Hello')
  })

  it('handles bounded setTimeout in sandbox', async () => {
    host = await QuickJsLxHost.create()

    const script = `
      let timeoutFired = false;
      setTimeout(() => {
        timeoutFired = true;
      }, 10);
    `
    await host.evalCode(script)
    await new Promise((r) => setTimeout(r, 40))
    expect(await host.evalCode('timeoutFired')).toBe(true)
  })

  describe('Controlled HTTP Bridge', () => {
    it('rejects non-HTTPS URLs', async () => {
      const mockFetch = vi.fn()
      host = await QuickJsLxHost.create({ fetch: mockFetch as unknown as typeof fetch })

      const script = `
        let errResult = null;
        lx.request('http://insecure.example.com/api', {}, (err, resp) => {
          errResult = err;
        });
      `
      await host.evalCode(script)
      await new Promise((r) => setTimeout(r, 20))
      const err = (await host.evalCode('errResult')) as { message: string }
      expect(err).toBeTruthy()
      expect(err.message).toContain('Only HTTPS is supported')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('rejects disallowed HTTP methods', async () => {
      const mockFetch = vi.fn()
      host = await QuickJsLxHost.create({ fetch: mockFetch as unknown as typeof fetch })

      const script = `
        let errResult = null;
        lx.request('https://api.example.com/delete', { method: 'DELETE' }, (err, resp) => {
          errResult = err;
        });
      `
      await host.evalCode(script)
      await new Promise((r) => setTimeout(r, 20))
      const err = (await host.evalCode('errResult')) as { message: string }
      expect(err).toBeTruthy()
      expect(err.message).toContain('HTTP method DELETE is not allowed')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('strips forbidden headers like cookie and authorization', async () => {
      let interceptedHeaders: Headers | null = null
      const mockFetch = vi.fn().mockImplementation((url, init) => {
        interceptedHeaders = init.headers
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
      })

      host = await QuickJsLxHost.create({ fetch: mockFetch as unknown as typeof fetch })

      const script = `
        let respResult = null;
        lx.request('https://api.example.com/test', {
          method: 'GET',
          headers: {
            'Authorization': 'Bearer secret-token',
            'Cookie': 'session=abc',
            'X-Custom-Header': 'allowed-value',
            'Sec-Fetch-Mode': 'cors',
            'Proxy-Authorization': 'basic xyz',
          }
        }, (err, resp) => {
          respResult = resp;
        });
      `
      await host.evalCode(script)
      await new Promise((r) => setTimeout(r, 30))

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(interceptedHeaders).not.toBeNull()
      expect(interceptedHeaders!.has('authorization')).toBe(false)
      expect(interceptedHeaders!.has('cookie')).toBe(false)
      expect(interceptedHeaders!.has('sec-fetch-mode')).toBe(false)
      expect(interceptedHeaders!.has('proxy-authorization')).toBe(false)
      expect(interceptedHeaders!.get('x-custom-header')).toBe('allowed-value')

      const resp = (await host.evalCode('respResult')) as { statusCode: number; body: { ok: boolean } }
      expect(resp.statusCode).toBe(200)
      expect(resp.body).toEqual({ ok: true })
    })

    it('rejects responses larger than 1 MiB', async () => {
      // Create response larger than 1 MiB
      const largeContent = new Uint8Array(1024 * 1024 + 100)
      const mockFetch = vi.fn().mockResolvedValue(new Response(largeContent, {
        status: 200,
        headers: { 'content-length': String(largeContent.byteLength) },
      }))

      host = await QuickJsLxHost.create({ fetch: mockFetch as unknown as typeof fetch })

      const script = `
        let errResult = null;
        lx.request('https://api.example.com/large-file', {}, (err, resp) => {
          errResult = err;
        });
      `
      await host.evalCode(script)
      await new Promise((r) => setTimeout(r, 30))

      const err = (await host.evalCode('errResult')) as { message: string }
      expect(err).toBeTruthy()
      expect(err.message).toContain('Response exceeds maximum size')
    })
  })

  describe('Source Registration and musicUrl Resolution', () => {
    it('registers event handler and returns direct string URL', async () => {
      host = await QuickJsLxHost.create()

      const script = `
        lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
          if (action === 'musicUrl') {
            return 'https://cdn.example.com/' + source + '/' + info.musicInfo.id + '.mp3';
          }
        });
      `
      await host.loadSource(script)

      const result = await host.callMusicUrl('wy', { id: '12345' }, 'standard')
      expect(result).toEqual({
        url: 'https://cdn.example.com/wy/12345.mp3',
        actualQuality: 'standard',
        requestHeaders: undefined,
      })
    })

    it('exposes the MeloX musicInfo self-reference inside the guest', async () => {
      // The host-side payload must stay serializable, so the self-reference is created by
      // __lxDispatchMusicUrl inside the guest. Scripts in the wild read info.musicInfo.musicInfo,
      // so removing it guest-side would break them just as badly as the cyclic wire payload did.
      host = await QuickJsLxHost.create()

      const script = `
        lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
          if (action === 'musicUrl') {
            if (info.musicInfo.musicInfo !== info.musicInfo) {
              throw new Error('musicInfo self-reference missing');
            }
            return 'https://cdn.example.com/' + source + '/' + info.musicInfo.id + '.mp3';
          }
        });
      `
      await host.loadSource(script)

      const result = await host.callMusicUrl('wy', { id: '999' }, 'standard')
      expect(result).toMatchObject({ url: 'https://cdn.example.com/wy/999.mp3' })
    })

    it('handles async handler returning object with headers and actualQuality', async () => {
      host = await QuickJsLxHost.create()

      const script = `
        lx.on(lx.EVENT_NAMES.request, async ({ source, action, info }) => {
          if (action === 'musicUrl') {
            return {
              url: 'https://cdn.example.com/' + info.musicInfo.id + '.flac',
              headers: {
                'User-Agent': 'CustomAudioPlayer',
                'Referer': 'https://music.example.com'
              },
              quality: 'lossless'
            };
          }
        });
      `
      await host.loadSource(script)

      const result = await host.callMusicUrl('tx', { id: 'track_999' }, 'flac')
      expect(result).toEqual({
        url: 'https://cdn.example.com/track_999.flac',
        requestHeaders: {
          'User-Agent': 'CustomAudioPlayer',
          'Referer': 'https://music.example.com',
        },
        actualQuality: 'lossless',
      })
    })

    it('rejects musicUrl with unsupported URL scheme (e.g. javascript:, ftp:)', async () => {
      host = await QuickJsLxHost.create()

      const script = `
        lx.on(lx.EVENT_NAMES.request, ({ action }) => {
          if (action === 'musicUrl') {
            return 'javascript:alert(1)';
          }
        });
      `
      await host.loadSource(script)

      await expect(
        host.callMusicUrl('wy', { id: '123' }, 'standard'),
      ).rejects.toThrow(/Unsupported media URL scheme/i)
    })

    it('supports send(inited) metadata extraction', async () => {
      host = await QuickJsLxHost.create()

      const script = `
        lx.send(lx.EVENT_NAMES.inited, {
          openDevTools: false,
          sources: {
            wy: { name: 'NetEase', qualitys: ['128k', '320k', 'flac'] }
          }
        });
      `
      const { initedMeta } = await host.loadSource(script)
      expect(initedMeta).toEqual({
        openDevTools: false,
        sources: {
          wy: { name: 'NetEase', qualitys: ['128k', '320k', 'flac'] },
        },
      })
    })

    it('loads and resolves an original synthetic LX source', async () => {
      host = await QuickJsLxHost.create()
      const script = `
        lx.on(lx.EVENT_NAMES.request, ({ source, action, info }) => {
          if (action !== 'musicUrl') throw new Error('unsupported');
          return 'https://media.example.invalid/' + info.musicInfo.songmid + '.mp3';
        });
        lx.send(lx.EVENT_NAMES.inited, {
          sources: { wy: { name: 'Synthetic Source', qualitys: ['128k'] } }
        });
      `
      const { initedMeta } = await host.loadSource(script)
      expect(initedMeta).toMatchObject({ sources: { wy: { name: 'Synthetic Source' } } })
      const result = await host.callMusicUrl('wy', { songmid: '123456789' }, '128k')
      expect(result.url).toBe('https://media.example.invalid/123456789.mp3')
    })
  })

  describe('Timeout and Interruption', () => {
    it('interrupts infinite CPU loop within deadline', async () => {
      host = await QuickJsLxHost.create({ callTimeoutMs: 150 })

      await expect(host.evalCode('while(true) {}')).rejects.toThrow()
    })
  })
})
