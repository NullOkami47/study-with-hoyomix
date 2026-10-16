import { FocusValidationError } from './types'
import type { FocusSessionRecord } from './types'

export interface FocusDay {
  dayKey: string
  focusSeconds: number
  sessionCount: number
  completedSessionCount: number
}

export interface FocusStatistics {
  timeZone: string
  today: FocusDay
  lastSevenDays: FocusDay[]
  calendarDays: FocusDay[]
  totalFocusSeconds: number
  completedSessionCount: number
  currentStreakDays: number
}

export interface FocusStatisticsOptions {
  now: string
  timeZone: string
}

const EXPLICIT_ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u

function createDayFormatter(timeZone: string): Intl.DateTimeFormat {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    throw new FocusValidationError('timeZone', 'must be a valid IANA time zone')
  }
  try {
    return new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  } catch {
    throw new FocusValidationError('timeZone', 'must be a valid IANA time zone')
  }
}

function dateAtExplicitInstant(instant: unknown): Date {
  if (typeof instant !== 'string') {
    throw new FocusValidationError('instant', 'must be a valid ISO-8601 instant with an explicit offset')
  }
  const match = EXPLICIT_ISO_INSTANT_PATTERN.exec(instant)
  if (!match) {
    throw new FocusValidationError('instant', 'must be a valid ISO-8601 instant with an explicit offset')
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10])
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11])
  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  calendar.setUTCHours(hour, minute, second)
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    throw new FocusValidationError('instant', 'must be a valid ISO-8601 instant with an explicit offset')
  }

  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) {
    throw new FocusValidationError('instant', 'must be a valid ISO-8601 instant with an explicit offset')
  }
  return date
}

function dayKeyFromFormatter(
  formatter: Intl.DateTimeFormat,
  instant: string,
): string {
  const date = dateAtExplicitInstant(instant)

  const parts = formatter.formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): string | undefined => (
    parts.find((part) => part.type === type)?.value
  )
  const year = get('year')
  const month = get('month')
  const day = get('day')
  if (!year || !month || !day) {
    throw new FocusValidationError('instant', 'could not produce a calendar day')
  }
  return `${year}-${month}-${day}`
}

function shiftDayKey(dayKey: string, offset: number): string {
  const [year, month, day] = dayKey.split('-').map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day + offset)
  const shiftedYear = String(date.getUTCFullYear()).padStart(4, '0')
  const shiftedMonth = String(date.getUTCMonth() + 1).padStart(2, '0')
  const shiftedDay = String(date.getUTCDate()).padStart(2, '0')
  return `${shiftedYear}-${shiftedMonth}-${shiftedDay}`
}

function emptyDay(dayKey: string): FocusDay {
  return { dayKey, focusSeconds: 0, sessionCount: 0, completedSessionCount: 0 }
}

export function dayKeyAt(instant: string, timeZone: string): string {
  return dayKeyFromFormatter(createDayFormatter(timeZone), instant)
}

export function deriveFocusStatistics(
  records: readonly FocusSessionRecord[],
  { now, timeZone }: FocusStatisticsOptions,
): FocusStatistics {
  const formatter = createDayFormatter(timeZone)
  const todayKey = dayKeyFromFormatter(formatter, now)
  const days = new Map<string, FocusDay>()
  let totalFocusSeconds = 0
  let completedSessionCount = 0

  for (const record of records) {
    if (!Number.isFinite(record.actualFocusSeconds) || record.actualFocusSeconds <= 0) continue

    const dayKey = dayKeyFromFormatter(formatter, record.endedAt)
    if (dayKey > todayKey) continue

    const day = days.get(dayKey) ?? emptyDay(dayKey)
    day.focusSeconds += record.actualFocusSeconds
    day.sessionCount += 1
    totalFocusSeconds += record.actualFocusSeconds
    if (record.status === 'completed') {
      day.completedSessionCount += 1
      completedSessionCount += 1
    }
    days.set(dayKey, day)
  }

  const lastSevenDayKeys = Array.from(
    { length: 7 },
    (_unused, index) => shiftDayKey(todayKey, index - 6),
  )
  const lastSevenDays = lastSevenDayKeys.map((dayKey) => days.get(dayKey) ?? emptyDay(dayKey))
  const today = lastSevenDays[6]

  let currentStreakDays = 0
  let streakDayKey = todayKey
  while ((days.get(streakDayKey)?.completedSessionCount ?? 0) > 0) {
    currentStreakDays += 1
    streakDayKey = shiftDayKey(streakDayKey, -1)
  }

  const calendarDays = [...days.values()]
    .sort((left, right) => left.dayKey.localeCompare(right.dayKey))

  return {
    timeZone,
    today,
    lastSevenDays,
    calendarDays,
    totalFocusSeconds,
    completedSessionCount,
    currentStreakDays,
  }
}
