import type { TranslationKey } from '../../i18n'
import type { FocusDay } from './statistics'

type FocusText = (key: TranslationKey) => string

export interface FocusCalendarWeek {
  days: FocusDay[]
  label: string
}

function shiftDayKey(dayKey: string, offset: number): string {
  const [year, month, day] = dayKey.split('-').map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day + offset)
  return [
    String(date.getUTCFullYear()).padStart(4, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function mondayOffset(dayKey: string): number {
  const [year, month, day] = dayKey.split('-').map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return (date.getUTCDay() + 6) % 7
}

function emptyDay(dayKey: string): FocusDay {
  return { dayKey, focusSeconds: 0, sessionCount: 0, completedSessionCount: 0 }
}

function countText(
  count: number,
  singular: TranslationKey,
  plural: TranslationKey,
  text: FocusText,
): string {
  return text(count === 1 ? singular : plural).replace('{count}', String(count))
}

export function formatCompactFocusDuration(totalSeconds: number, text: FocusText): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes > 0 && remainder > 0) {
    return text('focus.duration.minutesSeconds')
      .replace('{minutes}', String(minutes))
      .replace('{seconds}', String(remainder))
  }
  if (minutes > 0) return text('focus.duration.minutes').replace('{minutes}', String(minutes))
  return text('focus.duration.seconds').replace('{seconds}', String(remainder))
}

export function formatLongFocusDuration(totalSeconds: number, text: FocusText): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  const parts: string[] = []
  if (minutes > 0 || remainder === 0) {
    parts.push(countText(minutes, 'focus.duration.longMinute', 'focus.duration.longMinutes', text))
  }
  if (remainder > 0) {
    parts.push(countText(remainder, 'focus.duration.longSecond', 'focus.duration.longSeconds', text))
  }
  return parts.join(' ')
}

export function focusSessionCountText(count: number, text: FocusText): string {
  return countText(count, 'focus.calendar.session', 'focus.calendar.sessions', text)
}

export function createFocusCalendarWeeks(
  recordedDays: FocusDay[],
  text: FocusText,
): FocusCalendarWeek[] {
  if (recordedDays.length === 0) return []
  const byDay = new Map(recordedDays.map((day) => [day.dayKey, day]))
  const first = shiftDayKey(recordedDays[0].dayKey, -mondayOffset(recordedDays[0].dayKey))
  const lastRecorded = recordedDays[recordedDays.length - 1].dayKey
  const last = shiftDayKey(lastRecorded, 6 - mondayOffset(lastRecorded))
  const weeks: FocusCalendarWeek[] = []
  let cursor = first
  while (cursor <= last) {
    const days = Array.from({ length: 7 }, (_unused, index) => {
      const dayKey = shiftDayKey(cursor, index)
      return byDay.get(dayKey) ?? emptyDay(dayKey)
    })
    weeks.push({
      days,
      label: text('focus.calendar.weekLabel')
        .replace('{start}', days[0].dayKey)
        .replace('{end}', days[6].dayKey),
    })
    cursor = shiftDayKey(cursor, 7)
  }
  return weeks
}

export function focusWeekdayLabels(locale: string): string[] {
  return Array.from({ length: 7 }, (_unused, index) => (
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
      .format(new Date(Date.UTC(2021, 0, 4 + index)))
  ))
}
