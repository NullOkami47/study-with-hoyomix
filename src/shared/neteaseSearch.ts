/** Public, unauthenticated NetEase metadata contract already used by scripts/netease-hoyomix-residual-search.mjs. */
import type { ChkszCandidateInput } from './chkszMatcher'
export const NETEASE_SEARCH_ORIGIN = 'https://music.163.com'
export const NETEASE_HOYOMIX_ARTIST_ID = 12487174
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export function buildNeteaseSearchUrl(title: string): URL {
  if (!title.trim() || title.length > 500) throw new Error('invalid_search')
  const url = new URL('/api/search/get', NETEASE_SEARCH_ORIGIN)
  url.search = new URLSearchParams({
    s: title,
    type: '1',
    limit: '10',
    offset: '0',
  }).toString()
  return url
}
export function parseNeteaseSearch(
  value: unknown,
): ChkszCandidateInput[] | null {
  if (!record(value) || value.code !== 200 || !record(value.result)) return null
  const songs = value.result.songs
  if (!Array.isArray(songs)) return value.result.songCount === 0 ? [] : null
  return songs.slice(0, 10).flatMap((song) => {
    if (
      !record(song) ||
      typeof song.id !== 'number' ||
      !Number.isSafeInteger(song.id) ||
      song.id <= 0 ||
      typeof song.name !== 'string' ||
      song.name.length > 500
    )
      return []
    const credits = Array.isArray(song.artists)
      ? song.artists
      : Array.isArray(song.ar)
        ? song.ar
        : []
    if (!credits.some((a) => record(a) && a.id === NETEASE_HOYOMIX_ARTIST_ID))
      return []
    const album = record(song.album)
      ? song.album
      : record(song.al)
        ? song.al
        : {}
    const duration = song.duration ?? song.dt
    return [
      {
        id: String(song.id),
        name: song.name,
        artists: credits
          .filter(record)
          .map((a) => (typeof a.name === 'string' ? a.name : ''))
          .join(', '),
        album: typeof album.name === 'string' ? album.name : '',
        durationMs:
          typeof duration === 'number' &&
          Number.isFinite(duration) &&
          duration > 0
            ? duration
            : null,
      },
    ]
  })
}
