import { build } from 'esbuild'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from './miniflare-compat'

const TOKEN = 'synthetic-quota-analytics-token'
const CHANNEL = 'UCAAAAAAAAAAAAAAAAAAAAAA'
const VIDEO = 'abcdefghijk'
const BODY_MARKER = 'synthetic-private-response-body'

type Call = { host: string; method: string; path: string }
let mf: Miniflare
let calls: Call[]
let redirectTarget: 'quota' | 'oembed' | 'netease' | 'gd-studio' | 'feed' | undefined
let redirectStatus: number

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { readAccountDailyD1Writes } from './workers/catalogue/discovery/automationPublish';
        import { checkDiscoverySources } from './workers/catalogue/discovery/sources';
        import { scanOfficialFeeds } from './workers/catalogue/discovery/scanner';
        import { classifyDeterministically } from './workers/catalogue/discovery/model';

        const discovery = {
          videoId: ${JSON.stringify(VIDEO)},
          title: 'New Dawn',
          album: 'Test Album',
          games: ['genshin'],
          artistChannelId: ${JSON.stringify(CHANNEL)},
          albumBrowseId: 'MPRE-one',
          durationSeconds: 180,
          evidence: ['https://music.youtube.com/watch?v=${VIDEO}'],
        };
        const candidate = {
          id: 'hoyo-test',
          trackId: 'hoyo-test',
          discovery,
          suggestion: classifyDeterministically(discovery, 'hoyo-test'),
          classificationReviewed: false,
          sources: [],
          conflicts: [],
          revision: 1,
          stageState: 'pending',
          createdAt: 1,
          updatedAt: 1,
        };
        const fakeDb = { prepare: () => ({ all: async () => ({ results: [] }), first: async () => null }) };

        export default {
          async fetch(request, env) {
            const url = new URL(request.url);
            const op = url.searchParams.get('op');
            if (op === 'quota') {
              const metrics = await readAccountDailyD1Writes({
                ...env,
                DB: fakeDb,
                PUBLIC_ORIGIN: 'https://study.example',
                CATALOGUE_DISCOVERY_CF_ACCOUNT_ID: 'a'.repeat(32),
              });
              return Response.json({ metrics });
            }
            if (op === 'sources') {
              const req = new Request('https://study.example/api/admin/catalogue/discovery', {
                headers: { origin: 'https://study.example' },
              });
              const checks = await checkDiscoverySources(
                candidate,
                { DB: fakeDb, PUBLIC_ORIGIN: 'https://study.example', GD_STUDIO_API_BASE_URL: 'https://music-api.gdstudio.xyz', GD_STUDIO_MEDIA_ALLOWED_HOSTNAMES: 'media.fixture.example' },
                req,
                'admin',
                { now: () => 1000 },
              );
              return Response.json({ checks });
            }
            if (op === 'scan') {
              try {
                const manifest = await scanOfficialFeeds([${JSON.stringify(CHANNEL)}], { now: () => 1 });
                return Response.json({ manifest });
              } catch (error) {
                return Response.json({ error: error instanceof Error ? error.message : 'failed' }, { status: 502 });
              }
            }
            return new Response(null, { status: 404 });
          },
        };
      `,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  })
  mf = new Miniflare({
    modules: true,
    script: result.outputFiles[0]!.text,
    compatibilityDate: '2025-12-01',
    bindings: {
      CATALOGUE_DISCOVERY_QUOTA_API_TOKEN: TOKEN,
    },
    outboundService: async (request) => {
      const url = new URL(request.url)
      calls.push({ host: url.host, method: request.method, path: url.pathname })
      const stage =
        url.host === 'api.cloudflare.com'
          ? 'quota'
          : url.host === 'www.youtube.com' && url.pathname === '/oembed'
            ? 'oembed'
            : url.host === 'music.163.com'
              ? 'netease'
              : url.host === 'www.youtube.com' && url.pathname === '/feeds/videos.xml'
                ? 'feed'
                : url.host === 'music-api.gdstudio.xyz' && url.pathname === '/api.php' && url.searchParams.get('types') === 'search' ? 'gd-studio' : undefined
      if (!stage) return new Response(null, { status: 500 })
      if (redirectTarget === stage) {
        return new Response(BODY_MARKER + ' ' + TOKEN, {
          status: redirectStatus,
          headers: { location: url.origin + '/redirect-sink' },
        })
      }
      if (stage === 'quota') {
        return Response.json({
          data: { viewer: { accounts: [{ d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: 42 } }] }] } },
        })
      }
      if (stage === 'oembed') {
        return Response.json({
          title: 'New Dawn',
          author_name: 'HOYO-MiX',
          author_url: 'https://www.youtube.com/channel/' + CHANNEL,
        })
      }
      if (stage === 'netease') {
        return Response.json({ code: 200, result: { songCount: 0 } })
      }
      if (stage === 'gd-studio') return Response.json([])
      return new Response(
        `<feed><entry><yt:videoId>${VIDEO}</yt:videoId><title>Genshin Impact — New Dawn</title><published>2026-11-06T00:00:00Z</published></entry></feed>`,
      )
    },
  })
})

beforeEach(() => {
  calls = []
  redirectTarget = undefined
})

afterAll(async () => {
  await mf?.dispose()
})

describe('Discovery native workerd transport', () => {
  it('queries D1 analytics quota via native workerd fetch', async () => {
    const response = await mf.dispatchFetch('https://study.example/?op=quota')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { metrics: { rowsWritten: number; scope: string } | null }
    expect(body.metrics).toMatchObject({ scope: 'account', rowsWritten: 42 })
    expect(calls).toEqual([{ host: 'api.cloudflare.com', method: 'POST', path: '/client/v4/graphql' }])
  })

  it('qualifies discovery sources via native workerd fetch', async () => {
    const response = await mf.dispatchFetch('https://study.example/?op=sources')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { checks: Array<{ provider: string; status: string }> }
    expect(body.checks.find((x) => x.provider === 'youtube')?.status).toBe('valid')
    expect(calls.some((c) => c.host === 'www.youtube.com' && c.path === '/oembed')).toBe(true)
    expect(calls.some((c) => c.host === 'music.163.com')).toBe(true)
  })

  it('scans official feeds via native workerd fetch', async () => {
    const response = await mf.dispatchFetch('https://study.example/?op=scan')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { manifest: { discoveries: Array<{ videoId: string }> } }
    expect(body.manifest.discoveries[0]?.videoId).toBe(VIDEO)
    expect(calls).toEqual([{ host: 'www.youtube.com', method: 'GET', path: '/feeds/videos.xml' }])
  })

  for (const [stage, op] of [
    ['quota', 'quota'],
    ['oembed', 'sources'],
    ['netease', 'sources'],
    ['gd-studio', 'sources'],
    ['feed', 'scan'],
  ] as const) {
    it.each([301, 302, 303, 307, 308])(
      `refuses ${stage} redirect HTTP %s once without following`,
      async (status) => {
        redirectTarget = stage
        redirectStatus = status
        const response = await mf.dispatchFetch(`https://study.example/?op=${op}`)
        const text = await response.text()
        expect(text.includes(TOKEN) || text.includes(BODY_MARKER)).toBe(false)
        expect(calls.some(({ path }) => path === '/redirect-sink')).toBe(false)
        if (op === 'quota') {
          expect(response.status).toBe(200)
          expect(JSON.parse(text)).toEqual({ metrics: null })
          expect(calls).toHaveLength(1)
        } else if (op === 'scan') {
          expect(response.status).toBe(502)
          expect(JSON.parse(text)).toEqual({ error: 'discovery_upstream_unavailable' })
          expect(calls).toHaveLength(1)
        } else {
          expect(response.status).toBe(200)
          const parsed = JSON.parse(text) as { checks: Array<{ provider: string; status: string }> }
          const route = stage === 'oembed' ? ['youtube', 'www.youtube.com', '/oembed']
            : stage === 'netease' ? ['netease', 'music.163.com', '/api/search/get'] : ['gd-studio', 'music-api.gdstudio.xyz', '/api.php']
          expect(parsed.checks.find((x) => x.provider === route[0])?.status).toBe('unavailable')
          expect(calls.filter(c => c.host === route[1] && c.path === route[2])).toHaveLength(1)
        }
      },
    )
  }
})
