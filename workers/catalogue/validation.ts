export const canonicalId = (s: string) => /^[a-z0-9][a-z0-9_-]{0,119}$/.test(s)
export const relationId = (s: string) =>
  /^(place|character|npc|faction|event):[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(s)
export const validConfidence = (s: string) => s === '' || /^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/.test(s)
export const validDate = (s: string) =>
  s === '' ||
  (/^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s)
export function validSourceId(provider: string, id: string): boolean {
  if (provider === 'r2')
    return /^tracks\/authorized\/[a-f0-9]{64}\.(mp3|ogg|m4a|wav|flac)$/.test(id)
  if (['youtube', 'piped', 'invidious'].includes(provider)) return /^[A-Za-z0-9_-]{11}$/.test(id)
  if (provider === 'meting') return /^(netease|tencent):[0-9]{1,20}$/.test(id)
  if (provider === 'chksz') return /^[0-9]{1,20}$/.test(id)
  if (provider === 'lx-huibq') return /^(kw|kg|tx|wy|mg):[A-Za-z0-9_-]{1,96}:(128k|320k)$/.test(id)
  if (provider === 'lx-ikun') {
    const match =
      /^(kw|wy|git):[A-Za-z0-9_-]{1,96}:(128k|320k|flac|flac24bit|hires|atmos|master)$/.exec(id)
    return (
      !!match &&
      (match[1] === 'wy' ||
        (match[1] === 'kw' && !['atmos', 'master'].includes(match[2])) ||
        (match[1] === 'git' && ['128k', '320k', 'flac'].includes(match[2])))
    )
  }
  if (provider === 'jellyfin')
    return /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.test(id)
  if (provider === 'gd-studio')
    return /^(netease|tencent):[0-9]{1,20}(?::(?:128|320|flac))?$/.test(id)
  // Known but unimplemented resolvers have no trustworthy binding grammar yet.
  return false
}
