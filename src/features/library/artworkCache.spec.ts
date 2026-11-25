import { describe, expect, it, vi } from 'vitest'
import { createArtworkCache, publicArtworkUrl, type ArtworkLease } from './artworkCache'
import { artworkDimensions } from './artworkImage'
import { png } from './test/artworkImages'

const url = (id: number) => '/api/providers/lx/artwork/' + id
function setup(options: { maxBytes?: number } = {}) {
  let time = 1000, sequence = 0
  const fetch = vi.fn(async (source: RequestInfo | URL) => new Response(png(Number(String(source).match(/[0-9]+$/)?.[0]) || 1), {
    headers: { 'content-type': 'image/png', 'cache-control': 'public,max-age=3600' },
  }))
  const releaseImage = vi.fn(), revokeObjectURL = vi.fn()
  const decode = vi.fn(async (source: string, _signal: AbortSignal) => ({ naturalWidth: 16, naturalHeight: 16, source }))
  const cache = createArtworkCache({ fetch: fetch as typeof globalThis.fetch, now: () => time, releaseImage, decode,
    createObjectURL: () => 'blob:http://localhost/' + ++sequence, revokeObjectURL, ...options })
  return { cache, fetch, releaseImage, revokeObjectURL, decode, advance: (ms: number) => { time += ms } }
}

describe('bounded decoded artwork ownership', () => {
  it('does not fetch a ninth visible Library cover and resumes once a lease becomes evictable', async () => {
    const h = setup(), visible: ArtworkLease[] = []
    for (let id = 1; id <= 8; id++) { const lease = h.cache.acquire(url(id), { pin: false }); await lease.ready; visible.push(lease) }
    const ninth = h.cache.acquire(url(9), { pin: false }); expect(await ninth.ready).toBeNull()
    expect(ninth.capacityLimited).toBe(true); expect(h.cache.retryAt(url(9))).toBeUndefined(); expect(h.fetch).toHaveBeenCalledTimes(8)
    let retry: ArtworkLease | undefined
    const wake = vi.fn(() => { retry = h.cache.acquire(url(9), { pin: false }) })
    const unsubscribe = h.cache.onCapacityAvailable(wake, ninth.capacityVersion)
    ninth.release(); await Promise.resolve(); expect(wake).not.toHaveBeenCalled()
    visible[0]!.release(); await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce())
    expect(await retry!.ready).not.toBeNull(); expect(h.fetch).toHaveBeenCalledTimes(9)
    unsubscribe(); visible.forEach(l => l.release()); retry!.release(); h.cache.clear()
  })
  it('reuses a successfully loaded paused cover across player remounts without inventing play recency', async () => {
    const h = setup(), first = h.cache.acquire(url(1)), image = await first.ready
    first.release(); expect(h.revokeObjectURL).not.toHaveBeenCalled()
    const mounted = h.cache.acquire(url(1)); expect((await mounted.ready)?.url).toBe(image!.url)
    expect(h.fetch).toHaveBeenCalledOnce(); expect(h.cache.snapshot().tracks).toEqual([])
    mounted.release(); h.cache.clear(); expect(h.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(image!.url)
  })
  it('cancels a capacity listener and does not recursively wake on repeated denied acquisitions', async () => {
    const h = setup(), visible: ArtworkLease[] = []
    for (let id = 1; id <= 8; id++) { const l = h.cache.acquire(url(id), { pin: false }); await l.ready; visible.push(l) }
    const denied = h.cache.acquire(url(9), { pin: false }); await denied.ready; denied.release()
    const wake = vi.fn(), unsubscribe = h.cache.onCapacityAvailable(wake, denied.capacityVersion)
    for (let i = 0; i < 3; i++) { const l = h.cache.acquire(url(9), { pin: false }); expect(await l.ready).toBeNull(); l.release() }
    await Promise.resolve(); expect(wake).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledTimes(8)
    unsubscribe(); visible[0]!.release(); await Promise.resolve(); expect(wake).not.toHaveBeenCalled()
    visible.forEach(l => l.release()); h.cache.clear()
  })
  it('does not miss capacity released between a refusal and listener registration', async () => {
    const h = setup(), visible: ArtworkLease[] = []
    for (let id = 1; id <= 8; id++) { const l = h.cache.acquire(url(id), { pin: false }); await l.ready; visible.push(l) }
    const denied = h.cache.acquire(url(9), { pin: false }); await denied.ready; denied.release()
    visible[0]!.release()
    const wake = vi.fn(); h.cache.onCapacityAvailable(wake, denied.capacityVersion)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce())
    visible.forEach(l => l.release()); h.cache.clear()
  })
  it('canonicalises approved ChKSz size aliases into one artwork acquisition', async () => {
    const h = setup(), base = '/api/providers/chksz/artwork?url=' + encodeURIComponent('https://p1.music.126.net/cover.jpg')
    const small = '/api/providers/chksz/artwork?url=' + encodeURIComponent('https://p1.music.126.net/cover.jpg?param=64y64')
    const repeated = '/api/providers/chksz/artwork?url=' + encodeURIComponent('https://p1.music.126.net/cover.jpg?param=256y256&param=512y512')
    expect(publicArtworkUrl(small)).toBe(base); expect(publicArtworkUrl(repeated)).toBe(base)
    const a = h.cache.acquire(small), b = h.cache.acquire(repeated), c = h.cache.acquire(base)
    expect(await a.ready).toEqual(await b.ready); expect(await b.ready).toEqual(await c.ready)
    expect(h.fetch).toHaveBeenCalledOnce(); a.release(); b.release(); c.release()
  })
  it('rejects freshness exhausted during decode and releases the provisional Blob', async () => {
    const h = setup()
    h.fetch.mockImplementation(async () => new Response(png(), { headers: { 'content-type': 'image/png', 'cache-control': 'public,max-age=3600', age: '3599' } }))
    h.decode.mockImplementation(async source => { h.advance(2000); return { naturalWidth: 16, naturalHeight: 16, source } })
    const l = h.cache.acquire(url(1)); expect(await l.ready).toBeNull(); l.release()
    expect(h.cache.snapshot().assets).toBe(0); expect(h.revokeObjectURL).toHaveBeenCalledOnce()
  })
  it('rejects a changed final response URL before parsing or decoding', async () => {
    const h = setup()
    h.fetch.mockImplementation(async () => { const response = new Response(png(), { headers: { 'content-type': 'image/png', 'cache-control': 'public,max-age=3600' } }); Object.defineProperty(response, 'url', { value: 'https://elsewhere.invalid/private' }); return response })
    const l = h.cache.acquire(url(1)); expect(await l.ready).toBeNull(); l.release(); expect(h.decode).not.toHaveBeenCalled()
  })
  it('does not publish a resource until decode succeeds and all consumers share its Blob', async () => {
    const h = setup(); let finish!: (image: { naturalWidth: number; naturalHeight: number; source: string }) => void
    h.decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const a = h.cache.acquire(url(1)), b = h.cache.acquire(url(1))
    await vi.waitFor(() => expect(h.decode).toHaveBeenCalledOnce())
    expect(h.cache.peek(url(1))).toBeUndefined()
    finish({ naturalWidth: 16, naturalHeight: 16, source: 'blob:http://localhost/1' })
    const [one, two] = await Promise.all([a.ready, b.ready])
    expect(one).toEqual(two); expect(one?.url).toBe('blob:http://localhost/1'); expect(h.fetch).toHaveBeenCalledOnce()
    a.release(); expect(h.revokeObjectURL).not.toHaveBeenCalled(); b.release(); h.cache.clear(); expect(h.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(one!.url)
  })
  it('fails closed on exhausted capacity without evicting an image held by a visible consumer', async () => {
    const h = setup({ maxBytes: png().length })
    const a = h.cache.acquire(url(1), { pin: false }); const image = await a.ready
    const b = h.cache.acquire(url(2)); expect(await b.ready).toBeNull()
    expect(h.cache.peek(url(1))?.url).toBe(image!.url); expect(h.revokeObjectURL).not.toHaveBeenCalled()
    expect(h.cache.snapshot().bytes).toBe(png().length)
    a.release(); b.release(); h.cache.clear(); expect(h.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(image!.url)
  })
  it('retains a bounded Library LRU across remounts without altering play recency', async () => {
    const h = setup()
    h.cache.played('played', [url(1)]); const playing = h.cache.acquire(url(1)); await playing.ready; playing.release()
    for (let i = 2; i <= 9; i++) { const l = h.cache.acquire(url(i), { pin: false }); await l.ready; l.release() }
    const again = h.cache.acquire(url(2), { pin: false }); await again.ready; again.release()
    expect(h.fetch).toHaveBeenCalledTimes(9)
    const newcomer = h.cache.acquire(url(10), { pin: false }); await newcomer.ready; newcomer.release()
    expect(h.cache.peek(url(2))).toBeDefined(); expect(h.cache.peek(url(3))).toBeUndefined()
    expect(h.cache.peek(url(1))).toBeDefined(); expect(h.cache.snapshot().tracks).toEqual(['played'])
    expect(h.cache.snapshot().assets).toBe(9); h.cache.clear()
  })
  it('keeps eight visible Library assets while retaining ten separately played covers', async () => {
    const h = setup(), browsing = Array.from({ length: 8 }, (_, i) => h.cache.acquire(url(100 + i), { pin: false }))
    await Promise.all(browsing.map(l => l.ready))
    for (let i = 1; i <= 10; i++) { h.cache.played('t' + i, [url(i)]); const l = h.cache.acquire(url(i)); expect(await l.ready).not.toBeNull(); l.release() }
    expect(h.cache.snapshot().assets).toBe(18); expect(h.revokeObjectURL).not.toHaveBeenCalled()
    for (let i = 1; i <= 10; i++) { const l = h.cache.acquire(url(i)); await l.ready; l.release() }
    expect(h.fetch).toHaveBeenCalledTimes(18)
    browsing.forEach(l => l.release()); h.cache.clear(); expect(h.revokeObjectURL).toHaveBeenCalledTimes(18)
  })
  it('retains ten covers at the admitted byte and pixel limits without a refetch', async () => {
    const h = setup()
    h.fetch.mockImplementation(async source => new Response(png(Number(String(source).match(/[0-9]+$/)?.[0]), 1024, 1024, 5 * 1024 * 1024), {
      headers: { 'content-type': 'image/png', 'cache-control': 'public,max-age=3600' },
    }))
    h.decode.mockImplementation(async source => ({ naturalWidth: 1024, naturalHeight: 1024, source }))
    for (let i = 1; i <= 10; i++) { h.cache.played('t' + i, [url(i)]); const l = h.cache.acquire(url(i)); expect(await l.ready).not.toBeNull(); l.release() }
    expect(h.cache.snapshot().assets).toBe(10); expect(h.cache.snapshot().bytes).toBe(50 * 1024 * 1024)
    expect(h.cache.snapshot().pixels).toBe(10 * 1024 * 1024)
    for (let i = 1; i <= 10; i++) { const l = h.cache.acquire(url(i)); expect(await l.ready).not.toBeNull(); l.release() }
    expect(h.fetch).toHaveBeenCalledTimes(10); h.cache.clear(); expect(h.revokeObjectURL).toHaveBeenCalledTimes(10)
  })
  it('holds only one successful candidate per track in the retention window', async () => {
    const h = setup(); h.cache.played('one', [url(1), url(2)])
    const a = h.cache.acquire(url(1)); await a.ready
    const b = h.cache.acquire(url(2)); await b.ready; a.release(); b.release()
    expect(h.cache.snapshot().assets).toBe(1); expect(h.cache.peek(url(1))).toBeDefined(); expect(h.cache.peek(url(2))).toBeUndefined()
    h.cache.clear()
  })
  it('keeps a recently played successful cover after replacement failure and swaps only after success', async () => {
    const h = setup(); h.cache.played('a', [url(1)])
    const first = h.cache.acquire(url(1)), image = await first.ready
    h.cache.updateBinding('a', [url(2)])
    h.fetch.mockImplementationOnce(async () => new Response(null, { status: 503 }))
    const failed = h.cache.acquire(url(2)); expect(await failed.ready).toBeNull(); failed.release(); first.release()
    expect(h.cache.peek(url(1))?.url).toBe(image!.url); expect(h.revokeObjectURL).not.toHaveBeenCalled()
    const revisit = h.cache.acquire(url(1)); expect((await revisit.ready)?.url).toBe(image!.url); revisit.release()
    expect(h.fetch).toHaveBeenCalledTimes(2)
    h.advance(30001)
    const replacement = h.cache.acquire(url(2)); expect(await replacement.ready).not.toBeNull(); replacement.release()
    expect(h.cache.peek(url(2))).toBeDefined(); expect(h.cache.peek(url(1))).toBeUndefined()
    expect(h.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(image!.url); h.cache.clear()
  })
  it('cleans up a late cancelled decode while a fresh epoch independently acquires the same cover', async () => {
    const h = setup(); let finish!: (image: { naturalWidth: number; naturalHeight: number; source: string }) => void
    h.decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = h.cache.acquire(url(1)); await vi.waitFor(() => expect(h.decode).toHaveBeenCalledOnce())
    h.cache.clear(); expect(await first.ready).toBeNull()
    const next = h.cache.acquire(url(1)); expect((await next.ready)?.url).toMatch(/^blob:/)
    finish({ naturalWidth: 16, naturalHeight: 16, source: 'old' }); first.release()
    await vi.waitFor(() => expect(h.revokeObjectURL).toHaveBeenCalledOnce())
    expect(h.cache.snapshot().assets).toBe(1); next.release(); h.cache.clear(); expect(h.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
  it('limits concurrent fetch and decode work to four and cancels queued work on clear', async () => {
    const h = setup(), resolvers: (() => void)[] = []
    h.decode.mockImplementation(source => new Promise(resolve => resolvers.push(() => resolve({ naturalWidth: 16, naturalHeight: 16, source }))))
    const leases = Array.from({ length: 8 }, (_, i) => h.cache.acquire(url(i + 1)))
    await vi.waitFor(() => expect(h.decode).toHaveBeenCalledTimes(4))
    h.cache.clear(); resolvers.splice(0).forEach(f => f())
    expect(await Promise.all(leases.map(l => l.ready))).toEqual(Array(8).fill(null))
    leases.forEach(l => l.release()); expect(h.fetch).toHaveBeenCalledTimes(4)
    await vi.waitFor(() => expect(h.revokeObjectURL).toHaveBeenCalledTimes(4))
    expect(h.cache.snapshot().assets).toBe(0)
  })
  it('limits queued work to 64 while four acquisitions are stalled', async () => {
    const h = setup(), resolvers: ((response: Response) => void)[] = []
    h.fetch.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)))
    const leases = Array.from({ length: 150 }, (_, i) => h.cache.acquire(url(i + 1)))
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(4))
    expect(h.cache.snapshot().queued).toBeLessThanOrEqual(64)
    h.cache.clear(); resolvers.forEach(resolve => resolve(new Response(null, { status: 503 })))
    expect(await Promise.all(leases.map(l => l.ready))).toEqual(Array(150).fill(null))
    leases.forEach(l => l.release()); expect(h.fetch).toHaveBeenCalledTimes(4)
  })
  it('reserves decode memory before accepting concurrent assets', async () => {
    const h = setup({ maxBytes: png().length })
    let finish!: (image: { naturalWidth: number; naturalHeight: number; source: string }) => void
    h.decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const a = h.cache.acquire(url(1)); await vi.waitFor(() => expect(h.decode).toHaveBeenCalledOnce())
    expect(h.cache.snapshot().bytes).toBe(png().length)
    const b = h.cache.acquire(url(2)); expect(await b.ready).toBeNull()
    expect(h.decode).toHaveBeenCalledOnce(); expect(h.cache.snapshot().bytes).toBe(png().length)
    finish({ naturalWidth: 16, naturalHeight: 16, source: 'one' }); await a.ready; a.release(); b.release(); h.cache.clear()
    expect(h.cache.snapshot().bytes).toBe(0)
  })
  it('revokes a permanently stalled decoder on abort and frees the hash for a later acquisition', async () => {
    const h = setup(); h.decode.mockImplementationOnce(() => new Promise(() => {}))
    const a = h.cache.acquire(url(1)); await vi.waitFor(() => expect(h.decode).toHaveBeenCalledOnce())
    h.cache.clear(); expect(await a.ready).toBeNull(); a.release()
    expect(h.revokeObjectURL).toHaveBeenCalledOnce(); expect(h.cache.snapshot().bytes).toBe(0)
    const b = h.cache.acquire(url(1)); expect(await b.ready).not.toBeNull(); b.release(); h.cache.clear()
    expect(h.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
  it('settles a fetch that ignores cancellation by the eight-second acquisition deadline', async () => {
    vi.useFakeTimers()
    try {
      const h = setup(); h.fetch.mockImplementation(() => new Promise(() => {}))
      const l = h.cache.acquire(url(1)); await vi.advanceTimersByTimeAsync(8000)
      expect(await l.ready).toBeNull(); l.release(); expect(h.cache.snapshot().assets).toBe(0)
      const again = h.cache.acquire(url(1)); expect(await again.ready).toBeNull(); again.release(); expect(h.fetch).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
  it.each([
    { 'content-length': '9999999' }, { 'content-length': '1' }, { 'content-length': '-1' },
    { 'set-cookie': 'private=x' }, { age: '3600' }, { age: '-1' }, { 'cache-control': 'public,max-age=1,max-age=3600' },
  ])('rejects unsafe headers before publishing bytes: %j', async headers => {
    const responseHeaders = new Headers({ 'content-type': 'image/png', 'cache-control': 'public,max-age=3600' })
    for (const [name, value] of Object.entries(headers)) if (value !== undefined) responseHeaders.set(name, value)
    const h = setup(); h.fetch.mockImplementation(async () => new Response(png(), { headers: responseHeaders }))
    const l = h.cache.acquire(url(1)); expect(await l.ready).toBeNull(); l.release(); expect(h.decode).not.toHaveBeenCalled()
  })
  it('rejects post-decode dimensions that disagree with the validated file header', async () => {
    const h = setup(); h.decode.mockImplementation(async source => ({ naturalWidth: 32, naturalHeight: 32, source }))
    const l = h.cache.acquire(url(1)); expect(await l.ready).toBeNull(); l.release()
    expect(h.revokeObjectURL).toHaveBeenCalledOnce(); expect(h.releaseImage).toHaveBeenCalledOnce()
  })
  it('checks dimensions of static JPEG, GIF and WebP independently of the decoder', () => {
    const images = [
      ['image/jpeg', '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDwGiiimI//2Q=='],
      ['image/gif', 'R0lGODdhEAAQAIEAAAECAwAAAAAAAAAAACwAAAAAEAAQAEAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBADs='],
      ['image/webp', 'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoQABAAAUAmJaQAA3AA/v0gUAA='],
    ]
    for (const [mime, base64] of images) {
      const bytes = new Uint8Array(Buffer.from(base64!, 'base64'))
      expect(artworkDimensions(bytes, mime!)).toEqual({ width: 16, height: 16 })
      expect(artworkDimensions(bytes.subarray(0, 12), mime!)).toBeNull()
      if (mime === 'image/jpeg') {
        const sof = Buffer.from(bytes).indexOf(Buffer.from([255, 192]))
        const segment = bytes.subarray(sof, sof + 19)
        const duplicate = new Uint8Array([...bytes.subarray(0, sof), ...segment, ...bytes.subarray(sof)])
        expect(artworkDimensions(duplicate, mime)).toBeNull()
        const dnl = new Uint8Array([...bytes.subarray(0, bytes.length - 2), 255, 220, 0, 4, 16, 0, 255, 217])
        expect(artworkDimensions(dnl, mime)).toBeNull()
      } else if (mime === 'image/webp') {
        const extended = Buffer.alloc(18)
        extended.write('VP8X'); extended.writeUInt32LE(10, 4); extended[12] = 15; extended[15] = 15
        const late = Buffer.concat([bytes, extended]); late.writeUInt32LE(late.length - 8, 4)
        expect(artworkDimensions(late, mime)).toBeNull()
      }
    }
    const original = png()
    const duplicatePng = new Uint8Array([...original.subarray(0, 33), ...original.subarray(8, 33), ...original.subarray(33)])
    expect(artworkDimensions(duplicatePng, 'image/png')).toBeNull()
  })
  it('rejects animated image containers before their frame decoders can allocate memory', () => {
    const animated = [
      ['image/png', 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAAQAAAAEAAAAAAAAAAAAAEACgAAY0bPJQAAACNJREFUeJxjZGRiZiAFMJGkmmFUA3GAiUh1cDCqgRhAcigBAEZiACaW165OAAAAGmZjVEwAAAABAAAAEAAAABAAAAAAAAAAAAABAAoAAPg1JfEAAAAnZmRBVAAAAAJ4nGNkYWVjIAUwkaSaYVQDcYCJSHVwMKqBGEByKAEAYeAAL9S3mt0AAAAASUVORK5CYII='],
      ['image/gif', 'R0lGODlhEAAQAIEAAAECAwAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAEAAQAAAIHQABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFgQEBACH5BAEKAAEALAAAAAAQABAAgQQFBgAAAAAAAAAAAAgdAAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWBAQEAOw=='],
    ]
    for (const [mime, base64] of animated) expect(artworkDimensions(new Uint8Array(Buffer.from(base64!, 'base64')), mime!)).toBeNull()
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16); webp[20] = 2
    expect(artworkDimensions(webp, 'image/webp')).toBeNull()
  })
})
