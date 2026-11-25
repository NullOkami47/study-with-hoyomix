import { afterEach, expect, it, vi } from 'vitest'
import { clearArtworkCache, resolveChkszArtwork } from './artwork'
import { sharedArtworkCache } from './artworkCache'

afterEach(() => { clearArtworkCache(); vi.restoreAllMocks() })
const cover = '/api/providers/chksz/artwork?url=' + encodeURIComponent('https://p1.music.126.net/fixture.jpg')
const response = () => Response.json({ metadata: { artworkUrl: cover } })
const flush = async () => { for (let n = 0; n < 50; n++) await Promise.resolve() }

it('invalidates all observers of a joined legacy resolver when the artwork epoch clears', async () => {
  let finish!: (value: Response) => void
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const first = resolveChkszArtwork('first', '123')
  const joined = resolveChkszArtwork('second', '123')
  await flush(); clearArtworkCache(); finish(response())
  expect(await first).toBeNull()
  expect(await joined).toBeNull()
})

it('does not start queued legacy POSTs from a cleared epoch', async () => {
  const pending: Array<(value: Response) => void> = []
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { pending.push(resolve) }))
  const requests = Array.from({ length: 8 }, (_, n) => resolveChkszArtwork('track-' + n, String(n + 100)))
  await flush(); expect(fetcher).toHaveBeenCalledTimes(4)
  clearArtworkCache(); pending.splice(0).forEach(finish => finish(response()))
  await flush()
  expect(fetcher).toHaveBeenCalledTimes(4)
  expect(await Promise.all(requests)).toEqual(Array(8).fill(null))
})

it('bounds waiting legacy work while four requests are stalled', async () => {
  const pending: Array<(value: Response) => void> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { pending.push(resolve) }))
  const requests = Array.from({ length: 150 }, (_, n) => resolveChkszArtwork('track-' + n, String(n + 100)))
  await flush()
  expect(sharedArtworkCache.snapshot().queued).toBeLessThanOrEqual(64)
  clearArtworkCache(); pending.splice(0).forEach(finish => finish(response()))
  expect(await Promise.all(requests)).toEqual(Array(150).fill(null))
})
