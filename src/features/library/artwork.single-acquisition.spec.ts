import { describe, expect, it, vi } from 'vitest'
import { png } from './test/artworkImages'
import { createArtworkCache, publicArtworkUrl } from './artworkCache'

const url = (id: number) => '/api/providers/lx/artwork/' + id
const bytesOf = (blob: Blob) => new Promise<Uint8Array>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer)); r.onerror = reject; r.readAsArrayBuffer(blob) })
function setup() {
  let now = 0, sequence = 0
  const objects = new Map<string, Blob>(), revoked: string[] = []
  const request = vi.fn(async (key: RequestInfo | URL) => new Response(png(Number(String(key).match(/[0-9]+$/)?.[0]) || 1), { headers: { 'content-type': 'image/png', 'cache-control': 'public,max-age=3600' } }))
  const decode = vi.fn(async (_source: string, _signal: AbortSignal) => ({ naturalWidth: 16, naturalHeight: 16 }))
  const createObjectURL = (blob: Blob) => { const key = 'blob:http://localhost/' + ++sequence; objects.set(key, blob); return key }
  const revokeObjectURL = (key: string) => { revoked.push(key); objects.delete(key) }
  const releaseImage = vi.fn()
  const cache = createArtworkCache({ fetch: request as typeof fetch, now: () => now, decode, releaseImage, createObjectURL, revokeObjectURL })
  return { cache, request, decode, objects, revoked, releaseImage, advance(ms: number) { now += ms } }
}

describe('validated artwork byte ownership', () => {
  it('displays only a Blob containing exactly the one validated acquisition', async () => {
    const h = setup(), first = h.cache.acquire(url(1)), joined = h.cache.acquire(url(1))
    const [a, b] = await Promise.all([first.ready, joined.ready])
    expect(a?.url).toMatch(/^blob:/); expect(b).toEqual(a)
    expect(await bytesOf(h.objects.get(a!.url)!)).toEqual(png(1))
    expect(h.decode).toHaveBeenCalledWith(a!.url, expect.any(AbortSignal))
    expect(h.request).toHaveBeenCalledExactlyOnceWith(url(1), expect.objectContaining({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' }))
    first.release(); expect(h.revoked).toEqual([])
    joined.release(); h.cache.clear(); expect(h.revoked).toEqual([a!.url])
  })
  it('retains ten successful tracks beyond HTTP freshness and evicts the least recently played', async () => {
    const h = setup()
    for (let i = 1; i <= 10; i++) { h.cache.played('t' + i, [url(i)]); const l = h.cache.acquire(url(i)); expect(await l.ready).not.toBeNull(); l.release() }
    h.advance(24 * 3600000)
    for (let i = 1; i <= 10; i++) { const l = h.cache.acquire(url(i)); expect(await l.ready).not.toBeNull(); l.release() }
    expect(h.request).toHaveBeenCalledTimes(10)
    const evicted = h.cache.peek(url(2))!.url
    h.cache.played('t1', [url(1)]); h.cache.played('t11', [url(11)])
    const l = h.cache.acquire(url(11)); await l.ready; l.release()
    expect(h.cache.snapshot().tracks).toEqual(['t3','t4','t5','t6','t7','t8','t9','t10','t1','t11'])
    expect(h.cache.peek(url(1))).toBeDefined(); expect(h.cache.peek(url(2))).toBeUndefined()
    expect(h.revoked).toContain(evicted); expect(h.cache.snapshot().assets).toBe(10)
    h.cache.clear(); expect(h.objects.size).toBe(0)
  })
  it('deduplicates shared album bytes after both provider bindings have been validated', async () => {
    const h = setup()
    h.request.mockImplementation(async () => new Response(png(1), { headers: { 'content-type': 'image/png', 'cache-control': 'public,max-age=3600' } }))
    const a = h.cache.acquire(url(1)), b = h.cache.acquire('/api/providers/gd-studio/artwork/2')
    const [one, two] = await Promise.all([a.ready, b.ready])
    expect(one?.url).toBe(two?.url); expect(h.cache.snapshot().assets).toBe(1)
    expect(h.request).toHaveBeenCalledTimes(2)
    expect(two?.sourceUrl).toBe('/api/providers/gd-studio/artwork/2')
    a.release(); expect(h.revoked).toEqual([]); b.release(); h.cache.clear(); expect(h.revoked).toEqual([one!.url])
  })
  it.each(['clear', 'invalidate'] as const)('keeps visible and Media Session owners alive through %s', async action => {
    const h = setup(), l = h.cache.acquire(url(1), { pin: false }), image = await l.ready
    const releaseMetadata = h.cache.retain(image!.url)!
    if (action === 'clear') h.cache.clear(); else h.cache.invalidate(url(1))
    expect(h.cache.peek(url(1))).toBeUndefined(); expect(h.revoked).toEqual([])
    l.release(); expect(h.revoked).toEqual([])
    expect(await bytesOf(h.objects.get(image!.url)!)).toEqual(png(1))
    releaseMetadata(); releaseMetadata(); expect(h.revoked).toEqual([image!.url])
    expect(h.cache.snapshot().assets).toBe(0)
  })
  it('never revokes the currently visible cover when the playback LRU evicts it', async () => {
    const h = setup(); h.cache.played('t1', [url(1)])
    const l = h.cache.acquire(url(1)), image = await l.ready
    for (let i = 2; i <= 11; i++) h.cache.played('t' + i, [url(i)])
    expect(h.revoked).toEqual([]); expect(h.objects.has(image!.url)).toBe(true)
    l.release(); expect(h.revoked).toEqual([image!.url])
  })
  it.each(['private,max-age=3600','public,no-store,max-age=3600','public,no-cache,max-age=3600','max-age=3600','public,max-age=0'])('rejects %s without native fallback', async policy => {
    const h = setup(); h.request.mockImplementation(async () => new Response(png(), { headers: { 'content-type': 'image/png', 'cache-control': policy } }))
    const l = h.cache.acquire(url(1)); expect(await l.ready).toBeNull(); l.release()
    expect(h.decode).not.toHaveBeenCalled(); expect(h.objects.size).toBe(0)
  })
  it.each(['Cookie', 'Authorization', '*'])('rejects sensitive Vary: %s', async vary => {
    const h = setup(); h.request.mockImplementation(async () => new Response(png(), { headers: { 'content-type': 'image/png', 'cache-control': 'public,max-age=3600', vary } }))
    const l = h.cache.acquire(url(1)); expect(await l.ready).toBeNull(); l.release(); expect(h.decode).not.toHaveBeenCalled()
  })
  it.each(['image/svg+xml','image/png, text/html','image/png; boundary=unsafe'])('rejects malformed or active MIME %s', async mime => {
    const h = setup(); h.request.mockImplementation(async () => new Response(png(), { headers: { 'content-type': mime, 'cache-control': 'public,max-age=3600' } }))
    const l = h.cache.acquire(url(1)); expect(await l.ready).toBeNull(); l.release(); expect(h.objects.size).toBe(0)
  })
  it('rejects malformed, wrong-signature, excessive dimensions and oversized bytes before decoding', async () => {
    for (const bytes of [new Uint8Array([1,2,3]), new Uint8Array(6 * 1024 * 1024), png(1, 2048, 1024)]) {
      const h = setup(); h.request.mockImplementation(async () => new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public,max-age=3600' } }))
      const l = h.cache.acquire(url(1)); expect(await l.ready).toBeNull(); l.release(); expect(h.decode).not.toHaveBeenCalled(); expect(h.objects.size).toBe(0)
    }
  })
  it('rejects redirects and unauthorised URLs without creating a display resource', async () => {
    const h = setup()
    for (const source of ['https://evil.invalid/a.png', url(1) + '?token=secret', '/api/providers/chksz/artwork?url=' + encodeURIComponent('https://p1.music.126.net/a.jpg?signature=secret')]) {
      const l = h.cache.acquire(source); expect(await l.ready).toBeNull(); l.release()
    }
    expect(h.request).not.toHaveBeenCalled()
    h.request.mockImplementation(async () => { const r = new Response(png(), { headers: { 'content-type': 'image/png', 'cache-control': 'public,max-age=3600' } }); Object.defineProperty(r, 'redirected', { value: true }); return r })
    const l = h.cache.acquire(url(1)); expect(await l.ready).toBeNull(); l.release(); expect(h.objects.size).toBe(0)
    expect(publicArtworkUrl('/api/providers/gd-studio/artwork/netease%3A111%3A320')).toBe('/api/providers/gd-studio/artwork/111')
  })
  it('bounds transient retries and honours Retry-After across remount attempts', async () => {
    const h = setup(); h.request.mockImplementation(async () => new Response(null, { status: 429, headers: { 'retry-after': '90' } }))
    const run = async () => { const l = h.cache.acquire(url(1)); expect(await l.ready).toBeNull(); l.release() }
    await run(); await run(); expect(h.request).toHaveBeenCalledOnce()
    h.advance(90000); await run(); h.advance(90000); await run(); expect(h.request).toHaveBeenCalledTimes(2)
    h.advance(300000); await run(); expect(h.request).toHaveBeenCalledTimes(3)
  })
  it('releases a cancelled late decoder exactly once without repopulating the cache', async () => {
    const h = setup(); let finish!: (image: { naturalWidth: number; naturalHeight: number }) => void
    h.decode.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const l = h.cache.acquire(url(1)); await vi.waitFor(() => expect(h.decode).toHaveBeenCalledOnce())
    h.cache.clear(); expect(await l.ready).toBeNull(); finish({ naturalWidth: 16, naturalHeight: 16 }); l.release()
    expect(h.objects.size).toBe(0); await vi.waitFor(() => expect(h.releaseImage).toHaveBeenCalledOnce()); expect(h.revoked).toHaveLength(1)
  })
})
