import type { Discovery, DiscoveryManifest } from './types'
import { parseDiscoveryManifest } from './model'
const unescapeXml = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
export async function scanOfficialFeeds(
  channelIds: string[],
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<DiscoveryManifest> {
  if (!channelIds.length) throw new Error('discovery_not_configured')
  const discoveries: Discovery[] = []
  for (const channel of channelIds.slice(0, 4)) {
    const url = new URL('https://www.youtube.com/feeds/videos.xml')
    url.searchParams.set('channel_id', channel)
    const response = await (options.fetch ?? fetch)(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        response.status === 429
          ? 'discovery_rate_limited'
          : 'discovery_upstream_unavailable',
      )
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('discovery_upstream_unavailable')
    let xml = '',
      size = 0
    try {
      const decoder = new TextDecoder()
      while (true) {
        const x = await reader.read()
        if (x.done) break
        size += x.value.byteLength
        if (size > 256 * 1024) throw new Error('discovery_response_too_large')
        xml += decoder.decode(x.value, { stream: true })
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
      const entry = match[1]
      const value = (name: string) =>
        unescapeXml(
          new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(
            entry,
          )?.[1] ?? '',
        )
      const title = value('title')
      const videoId = value('yt:videoId')
      const published = value('published').slice(0, 10)
      const games: Discovery['games'] = []
      if (/genshin|原神/i.test(title)) games.push('genshin')
      if (/star.?rail|星穹鐵道|星穹铁道/i.test(title)) games.push('hsr')
      if (/zenless|絕區零|绝区零/i.test(title)) games.push('zzz')
      if (!games.length || !/^[-_a-zA-Z0-9]{11}$/.test(videoId)) continue
      discoveries.push({
        videoId,
        title,
        album: 'YouTube public release — album requires review',
        games,
        artistChannelId: channel,
        albumBrowseId: 'channel-' + channel,
        ...(published ? { releaseDate: published } : {}),
        evidence: ['https://www.youtube.com/watch?v=' + videoId],
      })
    }
  }
  return parseDiscoveryManifest({
    schemaVersion: 1,
    runId:
      'scan-' +
      (options.now ?? Date.now)().toString(36) +
      '-' +
      crypto.randomUUID().slice(0, 8),
    discoveries,
  })
}
