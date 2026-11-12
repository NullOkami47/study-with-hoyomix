import { describe, it, expect, vi } from 'vitest'
import { scanOfficialFeeds } from '../catalogue/discovery/scanner'
const channel = 'UCAAAAAAAAAAAAAAAAAAAAAA'
describe('bounded Admin public feed scan', () => {
  it('parses entry fields, deduplicates IDs and preserves game evidence', async () => {
    const xml =
      '<feed><entry><yt:videoId>abcdefghijk</yt:videoId><title>Genshin Impact — New Dawn</title><published>2026-11-06T00:00:00Z</published></entry></feed>'
    const result = await scanOfficialFeeds([channel], {
      fetch: async () => new Response(xml),
      now: () => 1,
    })
    expect(result.discoveries).toHaveLength(1)
    expect(result.discoveries[0]).toMatchObject({
      title: 'Genshin Impact — New Dawn',
      games: ['genshin'],
      videoId: 'abcdefghijk',
    })
  })
  it('stops on quota failure instead of returning an empty successful scan', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 429 }))
    await expect(
      scanOfficialFeeds([channel], { fetch: fetcher }),
    ).rejects.toThrow('discovery_rate_limited')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
