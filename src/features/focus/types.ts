export const FOCUS_SESSION_SCHEMA_VERSION = 1 as const

export interface FocusSessionRecord {
  id: string
  schemaVersion: 1
  startedAt: string
  endedAt: string
  plannedFocusSeconds: number
  actualFocusSeconds: number
  status: 'completed' | 'interrupted'
  phase: 'focus'
  createdAt: string
}

export interface FocusHistoryExport {
  schemaVersion: 1
  sessions: FocusSessionRecord[]
}

export class FocusValidationError extends Error {
  readonly path: string
  readonly reason: string

  constructor(path: string, reason: string) {
    super(`${path} ${reason}`)
    this.name = 'FocusValidationError'
    this.path = path
    this.reason = reason
  }
}

const RECORD_KEYS = [
  'id',
  'schemaVersion',
  'startedAt',
  'endedAt',
  'plannedFocusSeconds',
  'actualFocusSeconds',
  'status',
  'phase',
  'createdAt',
] as const

const RECORD_KEY_SET = new Set<string>(RECORD_KEYS)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/u
const CANONICAL_ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

function validationError(path: string, reason: string): never {
  throw new FocusValidationError(path, reason)
}

function parseRecordObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    validationError(path, 'must be an object')
  }
  const candidate = value as Record<string, unknown>
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== 'string' || !RECORD_KEY_SET.has(key)) {
      validationError(path, `contains unknown field ${String(key)}`)
    }
  }
  for (const key of RECORD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
      validationError(`${path}.${key}`, 'is required')
    }
  }
  return candidate
}

function parseUuid(value: unknown, path: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    validationError(path, 'must be a UUID')
  }
  return value.toLowerCase()
}

function parseIsoInstant(value: unknown, path: string): string {
  if (typeof value !== 'string') validationError(path, 'must be an ISO-8601 instant')
  const match = ISO_INSTANT_PATTERN.exec(value)
  if (!match) validationError(path, 'must be an ISO-8601 instant')

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const millisecond = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3))
  const offsetHour = match[8] === 'Z' ? 0 : Number(match[10])
  const offsetMinute = match[8] === 'Z' ? 0 : Number(match[11])

  const calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  calendar.setUTCHours(hour, minute, second, millisecond)
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
  ) validationError(path, 'must be a valid ISO-8601 instant')

  const offsetSign = match[9] === '-' ? -1 : 1
  const offsetMilliseconds = offsetSign * (offsetHour * 60 + offsetMinute) * 60_000
  const canonical = new Date(calendar.getTime() - offsetMilliseconds).toISOString()
  if (!CANONICAL_ISO_INSTANT_PATTERN.test(canonical)) {
    validationError(path, 'must canonicalise to a four-digit UTC year')
  }
  return canonical
}

function parsePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    validationError(path, 'must be a positive safe integer')
  }
  return value
}

export function parseFocusSessionRecord(
  value: unknown,
  path = 'focusSessionRecord',
): FocusSessionRecord {
  const candidate = parseRecordObject(value, path)
  const id = parseUuid(candidate.id, `${path}.id`)
  if (candidate.schemaVersion !== FOCUS_SESSION_SCHEMA_VERSION) {
    validationError(`${path}.schemaVersion`, `must equal ${FOCUS_SESSION_SCHEMA_VERSION}`)
  }
  const startedAt = parseIsoInstant(candidate.startedAt, `${path}.startedAt`)
  const endedAt = parseIsoInstant(candidate.endedAt, `${path}.endedAt`)
  const plannedFocusSeconds = parsePositiveInteger(
    candidate.plannedFocusSeconds,
    `${path}.plannedFocusSeconds`,
  )
  const actualFocusSeconds = parsePositiveInteger(
    candidate.actualFocusSeconds,
    `${path}.actualFocusSeconds`,
  )
  if (candidate.status !== 'completed' && candidate.status !== 'interrupted') {
    validationError(`${path}.status`, 'must be completed or interrupted')
  }
  if (candidate.phase !== 'focus') validationError(`${path}.phase`, 'must equal focus')
  const createdAt = parseIsoInstant(candidate.createdAt, `${path}.createdAt`)

  if (endedAt < startedAt) validationError(`${path}.endedAt`, 'must not precede startedAt')
  if (actualFocusSeconds > plannedFocusSeconds) {
    validationError(`${path}.actualFocusSeconds`, 'must not exceed plannedFocusSeconds')
  }
  if (candidate.status === 'completed' && actualFocusSeconds !== plannedFocusSeconds) {
    validationError(`${path}.actualFocusSeconds`, 'must equal plannedFocusSeconds when completed')
  }

  return {
    id,
    schemaVersion: FOCUS_SESSION_SCHEMA_VERSION,
    startedAt,
    endedAt,
    plannedFocusSeconds,
    actualFocusSeconds,
    status: candidate.status,
    phase: 'focus',
    createdAt,
  }
}
