import { translate, type Locale } from '../../i18n'

export function formatRelative(checkedAt: number | null, locale: Locale): string {
  if (checkedAt === null) return '\u2014'
  const seconds = Math.max(0, Math.round((Date.now() - checkedAt) / 1000))
  if (seconds < 60) {
    return translate(locale, 'admin.time.secondsAgo').replace('{n}', String(seconds))
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return translate(locale, 'admin.time.minutesAgo').replace('{n}', String(minutes))
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return translate(locale, 'admin.time.hoursAgo').replace('{n}', String(hours))
  }
  const days = Math.round(hours / 24)
  return translate(locale, 'admin.time.daysAgo').replace('{n}', String(days))
}
