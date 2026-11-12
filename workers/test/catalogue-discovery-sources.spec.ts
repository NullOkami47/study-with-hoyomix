import { describe, expect, it, vi } from 'vitest'
import { checkDiscoverySources } from '../catalogue/discovery/sources'
import { classifyDeterministically } from '../catalogue/discovery/model'
import { catalogueDatabase } from './catalogue-fixture'
import { issueSession } from '../auth/session'
import { discoveryCache, discoveryUpstream } from './catalogue-discovery-fixture'
const discovery = {
  videoId: 'abcdefghijk',
  title: 'New Dawn',
  album: 'Test Album',
  games: ['genshin'],
  artistChannelId: 'UCAAAAAAAAAAAAAAAAAAAAAA',
  albumBrowseId: 'MPRE-one',
  durationSeconds: 180,
  evidence: ['https://music.youtube.com/watch?v=abcdefghijk'],
}
const candidate = {
  id: 'hoyo-test',
  trackId: 'hoyo-test',
  discovery,
  suggestion: classifyDeterministically(discovery as any, 'hoyo-test'),
  classificationReviewed: false,
  sources: [],
  conflicts: [],
  revision: 1,
  stageState: 'pending',
  createdAt: 1,
  updatedAt: 1,
} as any
const env = {
  PUBLIC_ORIGIN: 'https://study.example',
  DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
} as any
const request = new Request(
  'https://study.example/api/admin/catalogue/discovery',
  { headers: { origin: 'https://study.example' } },
)
describe('discovery source qualification', () => {
  it('checks the exact YouTube identity and reports missing provider permissions', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        title: 'New Dawn',
        author_name: 'HOYO-MiX',
        author_url: 'https://www.youtube.com/channel/UCAAAAAAAAAAAAAAAAAAAAAA',
      }),
    )
    const result = await checkDiscoverySources(
      candidate,
      env,
      request,
      'admin',
      { fetch: fetcher, now: () => 1000 },
    )
    expect(result.find((x) => x.provider === 'youtube')).toMatchObject({
      externalId: 'abcdefghijk',
      status: 'valid',
    })
    expect(result.find((x) => x.provider === 'chksz')?.status).toBe(
      'permission_required',
    )
    expect(result.some((x) => x.provider === 'jellyfin')).toBe(false)
  })
  it('does not treat a lookalike artist name as official channel identity', async () => {
    const result = await checkDiscoverySources(
      candidate,
      env,
      request,
      'admin',
      {
        fetch: async () =>
          Response.json({
            title: 'New Dawn',
            author_name: 'HOYO-MiX',
            author_url: 'https://www.youtube.com/@untrusted',
          }),
        now: () => 1000,
      },
    )
    expect(result.find((x) => x.provider === 'youtube')?.status).toBe(
      'unverified',
    )
  })
  it('does not accept unavailable or different versions of the YouTube recording', async () => {
    const result = await checkDiscoverySources(
      candidate,
      env,
      request,
      'admin',
      {
        fetch: async () =>
          Response.json({ title: 'New Dawn (Live)', author_name: 'HOYO-MiX' }),
        now: () => 1000,
      },
    )
    expect(result.find((x) => x.provider === 'youtube')?.status).toBe('invalid')
  })
  it('returns finite safe outcomes on quota failures with no retry or response leakage', async () => {
    const fetcher = vi.fn(
      async () => new Response('private quota error', { status: 429 }),
    )
    const result = await checkDiscoverySources(
      candidate,
      env,
      request,
      'admin',
      { fetch: fetcher, now: () => 1000 },
    )
    expect(result.find((x) => x.provider === 'youtube')?.status).toBe(
      'rate_limited',
    )
    expect(JSON.stringify(result)).not.toContain('private quota error')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

// Real resolver/media handlers and disposable D1; only the public HTTP boundary is a fixture.
describe('official NetEase authority across provider fallbacks', () => {
  const song = {
    id: 9876543210, name: 'New Dawn', artists: [{ id: 99999999, name: 'HOYO-MiX' }],
    album: { name: 'New Album' }, duration: 180000,
  }
  async function qualify(
    publicReply: () => Response,
    gdId = '9876543210',
    extra: { chkszId?: number; wy?: boolean } = {},
  ) {
    const fixture = await catalogueDatabase()
    try {
      await fixture.db.prepare("UPDATE provider_health SET enabled=1 WHERE provider_key='gd-studio'").run()
      const resolverEnv = {
        DB: fixture.db, PUBLIC_ORIGIN: 'https://study.example',
        SESSION_HMAC_SECRET: 'offline-fixture-session-long-enough',
        GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz',
        GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.fixture.example',
        ...(extra.chkszId !== undefined ? { CHKSZ_API_KEY: 'offline-chksz-fixture-key' } : {}),
        ...(extra.wy ? {
          LX_HUIBQ_API_BASE_URL: 'https://lx.fixture.example',
          LX_HUIBQ_MEDIA_ALLOWED_HOSTNAMES: 'media.fixture.example',
          LX_HUIBQ_REQUEST_KEY: 'offline-lx-fixture-key',
        } : {}),
      }
      const actor = 'offline-authority-' + crypto.randomUUID()
      let sourceRequest = request
      if (extra.chkszId !== undefined) {
        await fixture.db.prepare("UPDATE provider_health SET enabled=1 WHERE provider_key='chksz'").run()
        await fixture.db.prepare("INSERT INTO admin_settings(setting_key,setting_json,updated_at) VALUES ('provider.chksz.ownerKeyFallback',?,0)").bind(JSON.stringify({ enabled: true })).run()
        await fixture.db.prepare("INSERT INTO users(id,display_name,role,created_at,updated_at) VALUES (?,?,'admin',0,0)").bind(actor, actor).run()
        const session = await issueSession(fixture.db, actor, resolverEnv.SESSION_HMAC_SECRET, 100000, crypto)
        sourceRequest = new Request(request, { headers: { origin: resolverEnv.PUBLIC_ORIGIN, cookie: '__Host-session=' + session.token } })
      }
      if (extra.wy)
        await fixture.db.prepare("UPDATE provider_health SET enabled=1 WHERE provider_key IN ('lx','lx-huibq')").run()
      const upstream = discoveryUpstream()
      const resolvedIds: string[] = []
      const chkszResolvedIds: string[] = []
      const wyResolvedIds: string[] = []
      const fetcher: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.hostname === 'music.163.com') return publicReply()
        if (url.hostname === 'music-api.gdstudio.xyz') {
          if (url.searchParams.get('types') === 'search')
            return Response.json([{ id: gdId, name: 'New Dawn', artist: ['HOYO-MiX'], album: 'New Album', duration: 180 }])
          if (url.searchParams.get('types') === 'url') resolvedIds.push(url.searchParams.get('id')!)
        }
        if (url.hostname === 'api.chksz.com' && url.pathname === '/api/163_search')
          return Response.json({ code: 200, data: { songs: [{ id: extra.chkszId, name: 'New Dawn', artists: ['HOYO-MiX'], album: 'New Album', duration: 180000 }] } })
        if (url.hostname === 'api.chksz.com' && url.pathname === '/api/163_music') {
          chkszResolvedIds.push(url.searchParams.get('id')!)
          return Response.json({ code: 200, data: { id: extra.chkszId, level: url.searchParams.get('level'), url: 'https://m801.music.126.net/canonical-fixture.wav' } })
        }
        if (url.hostname === 'm801.music.126.net')
          return upstream('https://media.fixture.example/canonical-fixture.wav', init)
        if (url.hostname === 'lx.fixture.example') {
          wyResolvedIds.push(url.pathname.split('/')[3])
          return Response.json({ code: 0, url: 'https://media.fixture.example/canonical-fixture.mp3' })
        }
        if (url.hostname === 'media.fixture.example' && url.pathname === '/canonical-fixture.mp3') {
          const bytes = new Uint8Array(1024)
          bytes.set([0xff, 0xfb, 0x90, 0x64])
          return new Response(bytes, { status: 206, headers: {
            'content-type': 'audio/mpeg', 'content-length': '1024',
            'content-range': 'bytes 0-1023/4096', 'accept-ranges': 'bytes',
          } })
        }
        return upstream(input, init)
      }
      const result = await checkDiscoverySources({
        ...candidate,
        suggestion: { ...candidate.suggestion, album: 'New Album', vocal_status: 'vocal' },
      }, resolverEnv as any, sourceRequest, actor, {
        fetch: fetcher, now: () => 100000, cache: discoveryCache(),
      })
      return { result, resolvedIds, chkszResolvedIds, wyResolvedIds }
    } finally {
      await fixture.dispose()
    }
  }

  it('does not qualify the same GD candidate after an explicit official artist-ID mismatch', async () => {
    const { result, resolvedIds } = await qualify(() => Response.json({ code: 200, result: { songs: [song] } }))
    expect(result.some(s => s.provider === 'gd-studio' && s.externalId === 'netease:9876543210' && s.status === 'valid')).toBe(false)
    expect(resolvedIds).toEqual([])
  })

  it('rejects a leading-zero GD alias of an officially denied numeric song ID before resolving', async () => {
    const { result, resolvedIds } = await qualify(
      () => Response.json({ code: 200, result: { songs: [song] } }),
      '09876543210',
    )
    expect(resolvedIds).toEqual([])
    expect(result.some(s => s.provider === 'gd-studio' && s.status === 'valid')).toBe(false)
  })

  it.each([
    ['unavailable authority', () => new Response(null, { status: 503 })],
    ['empty search', () => Response.json({ code: 200, result: { songCount: 0 } })],
    ['missing artist IDs', () => Response.json({ code: 200, result: { songs: [{ ...song, artists: [{ name: 'HOYO-MiX' }] }] } })],
    ['official artist credit', () => Response.json({ code: 200, result: { songs: [{ ...song, artists: [{ id: 12487174, name: 'HOYO-MiX' }] }] } })],
  ] as const)('preserves a verified provider fallback with %s', async (_, response) => {
    const { result } = await qualify(response)
    expect(result).toContainEqual(expect.objectContaining({ provider: 'gd-studio', externalId: 'netease:9876543210', status: 'valid' }))
  })

  it('keeps a different GD candidate eligible when only another ID was denied', async () => {
    const { result } = await qualify(() => Response.json({ code: 200, result: { songs: [song] } }), '9876543211')
    expect(result).toContainEqual(expect.objectContaining({ provider: 'gd-studio', externalId: 'netease:9876543211', status: 'valid' }))
  })
  it.each([
    [9876543210, '00000000009876543210'],
    ['09876543210', '9876543210'],
    ['1234567890123456789', '01234567890123456789'],
    ['12345678901234567890', '12345678901234567890'],
  ] as const)('matches official denial %s to GD decimal identity %s without resolving', async (officialId, gdId) => {
    const { result, resolvedIds } = await qualify(
      () => Response.json({ code: 200, result: { songs: [{ ...song, id: officialId }] } }), gdId,
    )
    expect(resolvedIds).toEqual([])
    expect(result.some(s => s.provider === 'gd-studio' && s.status === 'valid')).toBe(false)
  })

  it('keeps distinct 20-digit IDs separate even when Number would round them together', async () => {
    const { result, resolvedIds } = await qualify(
      () => Response.json({ code: 200, result: { songs: [{ ...song, id: '12345678901234567890' }] } }),
      '12345678901234567891',
    )
    expect(resolvedIds).toEqual(['12345678901234567891'])
    expect(result).toContainEqual(expect.objectContaining({ provider: 'gd-studio', externalId: 'netease:12345678901234567891', status: 'valid' }))
  })

  it.each([
    ['outage', () => new Response(null, { status: 503 })],
    ['empty result', () => Response.json({ code: 200, result: { songCount: 0 } })],
    ['missing artist IDs', () => Response.json({ code: 200, result: { songs: [{ ...song, artists: [{ name: 'HOYO-MiX' }] }] } })],
  ] as const)('preserves leading-zero GD fallback for unknown authority: %s', async (_, reply) => {
    const { result, resolvedIds } = await qualify(reply, '09876543210')
    expect(resolvedIds).toEqual(['09876543210'])
    expect(result).toContainEqual(expect.objectContaining({ provider: 'gd-studio', externalId: 'netease:09876543210', status: 'valid' }))
  })

  it('treats an unsafe numeric official ID as unknown instead of trusting rounded identity', async () => {
    const { result, resolvedIds } = await qualify(
      () => Response.json({ code: 200, result: { songs: [{ ...song, id: 9007199254740992 }] } }),
      '9007199254740992',
    )
    expect(resolvedIds).toEqual(['9007199254740992'])
    expect(result).toContainEqual(expect.objectContaining({ provider: 'gd-studio', externalId: 'netease:9007199254740992', status: 'valid' }))
  })

  it('filters official metadata aliases using the same decimal denial key', async () => {
    const { result, resolvedIds } = await qualify(() => Response.json({ code: 200, result: { songs: [
      { ...song, id: '09876543210' },
      { ...song, artists: [{ id: 12487174, name: 'HOYO-MiX' }] },
    ] } }))
    expect(resolvedIds).toEqual([])
    expect(result.some(s => s.reason === 'official_metadata_only')).toBe(false)
    expect(result.some(s => s.provider === 'gd-studio' && s.status === 'valid')).toBe(false)
  })

  it('blocks the same ChKSz identity after a leading-zero official denial', async () => {
    const { result, resolvedIds, chkszResolvedIds } = await qualify(
      () => Response.json({ code: 200, result: { songs: [{ ...song, id: '09876543210' }] } }),
      '9876543210', { chkszId: 9876543210 },
    )
    expect(resolvedIds).toEqual([])
    expect(chkszResolvedIds).toEqual([])
    expect(result.some(s => ['gd-studio', 'chksz'].includes(s.provider) && s.status === 'valid')).toBe(false)
  })

  it('keeps a genuinely different ChKSz fallback eligible', async () => {
    const { result, chkszResolvedIds } = await qualify(
      () => Response.json({ code: 200, result: { songs: [song] } }),
      '9876543210', { chkszId: 9876543211 },
    )
    expect(chkszResolvedIds).toEqual(['9876543211'])
    expect(result).toContainEqual(expect.objectContaining({ provider: 'chksz', externalId: '9876543211', status: 'valid' }))
  })

  it('does not resolve a denied GD alias through a downstream wy provider', async () => {
    const { result, resolvedIds, wyResolvedIds } = await qualify(
      () => Response.json({ code: 200, result: { songs: [song] } }),
      '09876543210', { wy: true },
    )
    expect(resolvedIds).toEqual([])
    expect(wyResolvedIds).toEqual([])
    expect(result.some(s => ['gd-studio', 'lx-huibq'].includes(s.provider) && s.status === 'valid')).toBe(false)
  })

  it('preserves a leading-zero wy fallback when official authority is unavailable', async () => {
    const { result, wyResolvedIds } = await qualify(
      () => new Response(null, { status: 503 }), '09876543210', { wy: true },
    )
    expect(wyResolvedIds).toEqual(['09876543210'])
    expect(result).toContainEqual(expect.objectContaining({ provider: 'lx-huibq', externalId: 'wy:09876543210:320k', status: 'valid' }))
  })

})
