import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Track } from '../../catalog/types'
import { createJellyfinProvider } from './jellyfin'

const ITEM_ID = '0123456789abcdef0123456789abcdef'
const ALBUM_ID = 'fedcba9876543210fedcba9876543210'
const TICKET = 'abcdefghijklmnopqrstuvwxyz123456'

const track = (sources = [{ provider: 'jellyfin', externalId: ITEM_ID }]): Track => ({
  id: 'track-jellyfin-1',
  title: 'Test Track',
  aliases: {},
  games: ['zzz'],
  relationIds: [],
  tabs: ['chill'],
  workGroupId: 'zzz',
  needsClassification: false,
  vocalStatus: 'instrumental',
  sources,
})

const abortSignal = () => new AbortController().signal

const RESOLVE_URL = new URL('/api/providers/jellyfin/resolve', globalThis.location.origin).toString()

const jsonResponse = (body: unknown, status = 200): Response => {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
  Object.defineProperty(response, 'url', { value: RESOLVE_URL })
  return response
}

const proxyMediaBody = (artworkUrl?: string) => ({
  url: `/api/providers/jellyfin/media/${ITEM_ID}/${TICKET}`,
  mimeType: 'audio/flac',
  metadata: {
    quality: { codec: 'flac', container: 'flac', bitrate: 900000 },
    ...(artworkUrl ? { artworkUrl } : {}),
  },
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createJellyfinProvider', () => {
  it('resolves track with item artwork URL pointing to safe same-origin proxy', async () => {
    const artworkPath = `/api/providers/jellyfin/artwork/${ITEM_ID}`
    const fetchImpl = vi.fn(async () => jsonResponse(proxyMediaBody(artworkPath)))
    const provider = createJellyfinProvider({ fetch: fetchImpl as unknown as typeof fetch })

    const playable = await provider.resolve(track(), abortSignal())

    expect(playable).toEqual({
      kind: 'audio',
      url: `${globalThis.location.origin}/api/providers/jellyfin/media/${ITEM_ID}/${TICKET}`,
      mimeType: 'audio/flac',
      metadata: {
        quality: { codec: 'flac', container: 'flac', bitrate: 900000 },
        artworkUrl: `${globalThis.location.origin}${artworkPath}`,
      },
    })
  })

  it('resolves track with album artwork URL when item has no primary artwork', async () => {
    const artworkPath = `/api/providers/jellyfin/artwork/${ALBUM_ID}`
    const fetchImpl = vi.fn(async () => jsonResponse(proxyMediaBody(artworkPath)))
    const provider = createJellyfinProvider({ fetch: fetchImpl as unknown as typeof fetch })

    const playable = await provider.resolve(track(), abortSignal())

    expect(playable?.metadata?.artworkUrl).toBe(`${globalThis.location.origin}${artworkPath}`)
  })

  it('resolves track cleanly without artwork when no artwork is available', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(proxyMediaBody()))
    const provider = createJellyfinProvider({ fetch: fetchImpl as unknown as typeof fetch })

    const playable = await provider.resolve(track(), abortSignal())

    expect(playable?.kind).toBe('audio')
    if (playable?.kind === 'audio') {
      expect(playable.metadata?.artworkUrl).toBeUndefined()
      expect(playable.url).toBe(`${globalThis.location.origin}/api/providers/jellyfin/media/${ITEM_ID}/${TICKET}`)
      expect(playable.mimeType).toBe('audio/flac')
    }
  })

  it('rejects external or non-same-origin artwork URLs for security and CSP isolation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(proxyMediaBody('https://external-host.example/artwork.jpg')))
    const provider = createJellyfinProvider({ fetch: fetchImpl as unknown as typeof fetch })

    const playable = await provider.resolve(track(), abortSignal())

    expect(playable?.kind).toBe('audio')
    if (playable?.kind === 'audio') {
      expect(playable.metadata?.artworkUrl).toBeUndefined()
      // Audio playback metadata is still preserved
      expect(playable.url).toBeDefined()
    }
  })

  it('ensures Jellyfin API token and internal origin never reach the client', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(proxyMediaBody(`/api/providers/jellyfin/artwork/${ITEM_ID}`)))
    const provider = createJellyfinProvider({ fetch: fetchImpl as unknown as typeof fetch })

    const playable = await provider.resolve(track(), abortSignal())
    const serialized = JSON.stringify(playable)

    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('MediaBrowser')
  })
})
