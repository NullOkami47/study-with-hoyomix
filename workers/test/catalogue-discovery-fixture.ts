/** Deterministic external boundary only: D1, catalogue and resolver code remain real. */
export const DISCOVERY_CHANNEL = 'UCAAAAAAAAAAAAAAAAAAAAAA'
export function discoveryWav(seconds = 10): Uint8Array {
  const samples = 8000 * seconds
  const data = new Uint8Array(44 + samples * 2)
  const view = new DataView(data.buffer)
  const ascii = (offset: number, s: string) =>
    [...s].forEach((c, i) => (data[offset + i] = c.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, data.length - 8, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true)
  view.setUint32(28, 16000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i++)
    view.setInt16(
      44 + i * 2,
      Math.round(1200 * Math.sin((i * 2 * Math.PI * 440) / 8000)),
      true,
    )
  return data
}
export function discoveryCache(): Pick<Cache, 'match' | 'put'> {
  const tickets = new Map<string, Response>()
  return {
    async match(request) {
      return tickets
        .get(String(request instanceof Request ? request.url : request))
        ?.clone()
    },
    async put(request, response) {
      tickets.set(
        String(request instanceof Request ? request.url : request),
        response.clone(),
      )
    },
  } as Pick<Cache, 'match' | 'put'>
}
export function discoveryUpstream(): typeof fetch {
  const bytes = discoveryWav()
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname === 'www.youtube.com' && url.pathname === '/oembed')
      return Response.json({
        title: 'New Dawn',
        author_name: 'HOYO-MiX',
        author_url: 'https://www.youtube.com/channel/' + DISCOVERY_CHANNEL,
      })
    if (
      url.hostname === 'www.youtube.com' &&
      url.pathname === '/feeds/videos.xml'
    )
      return new Response(
        '<feed><entry><yt:videoId>abcdefghijk</yt:videoId><title>New Dawn</title><published>2026-11-06T00:00:00Z</published></entry></feed>',
        { headers: { 'content-type': 'application/atom+xml' } },
      )
    if (url.hostname === 'music.163.com' && url.pathname === '/api/search/get')
      return Response.json({
        code: 200,
        result: {
          songCount: 1,
          songs: [
            {
              id: 9876543210,
              name: 'New Dawn',
              artists: [{ id: 12487174, name: 'HOYO-MiX' }],
              album: { name: 'New Album' },
              duration: 180000,
            },
          ],
        },
      })
    if (
      url.hostname === 'music-api.gdstudio.xyz' &&
      url.searchParams.get('types') === 'search'
    )
      return Response.json([
        {
          id: '9876543210',
          name: 'New Dawn',
          artist: ['HOYO-MiX'],
          album: 'New Album',
          duration: 180,
        },
      ])
    if (
      url.hostname === 'music-api.gdstudio.xyz' &&
      url.searchParams.get('types') === 'url'
    )
      return Response.json({
        url: 'https://media.fixture.example/new-dawn.wav',
        br: 320,
      })
    if (url.hostname === 'media.fixture.example') {
      const range = new Headers(init?.headers).get('range')
      const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '')
      const start = match ? Number(match[1]) : 0
      const end =
        match && match[2]
          ? Math.min(Number(match[2]), bytes.length - 1)
          : bytes.length - 1
      const status = match ? 206 : 200
      const body = bytes.slice(start, end + 1)
      return new Response(init?.method === 'HEAD' ? null : body, {
        status,
        headers: {
          'content-type': 'audio/wav',
          'content-length': String(body.length),
          'accept-ranges': 'bytes',
          ...(match
            ? {
                'content-range':
                  'bytes ' + start + '-' + end + '/' + bytes.length,
              }
            : {}),
        },
      })
    }
    return new Response(null, { status: 404 })
  }
}
