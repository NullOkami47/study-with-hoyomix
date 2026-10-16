import { describe, expect, it } from 'vitest'

import { FocusValidationError } from './types'
import type { FocusSessionRecord } from './types'
import { dayKeyAt, deriveFocusStatistics } from './statistics'

const focusRecord = (overrides: Partial<FocusSessionRecord> = {}): FocusSessionRecord => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  schemaVersion: 1,
  startedAt: '2026-08-25T00:00:00.000Z',
  endedAt: '2026-08-25T00:05:00.000Z',
  plannedFocusSeconds: 1_500,
  actualFocusSeconds: 1_500,
  status: 'completed',
  phase: 'focus',
  createdAt: '2026-08-25T00:05:00.000Z',
  ...overrides,
})

describe('focus statistics', () => {
  it('derives Latin ISO day keys in the requested IANA zone across a DST boundary', () => {
    expect(dayKeyAt('2026-08-25T00:30:00.000Z', 'Asia/Hong_Kong')).toBe('2026-08-25')
    expect(dayKeyAt('2026-08-25T08:30:00.000+08:00', 'Asia/Hong_Kong')).toBe('2026-08-25')
    expect(dayKeyAt('2026-08-25T00:30:00.000Z', 'America/Los_Angeles')).toBe('2026-08-24')
    expect(dayKeyAt('2026-03-08T08:30:00.000Z', 'America/Los_Angeles')).toBe('2026-03-08')
    expect(dayKeyAt('2026-03-08T10:30:00.000Z', 'America/Los_Angeles')).toBe('2026-03-08')
  })

  it('uses endedAt in the requested IANA zone and counts interrupted time without extending a completion streak', () => {
    const result = deriveFocusStatistics([
      focusRecord({ endedAt: '2026-08-25T00:30:00.000Z', actualFocusSeconds: 600, status: 'interrupted' }),
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440001', endedAt: '2026-08-24T23:30:00.000Z' }),
    ], { now: '2026-08-24T12:00:00.000Z', timeZone: 'America/Los_Angeles' })

    expect(result.today).toEqual({
      dayKey: '2026-08-24', focusSeconds: 2_100, sessionCount: 2, completedSessionCount: 1,
    })
    expect(result.currentStreakDays).toBe(1)
  })

  it('returns dense trailing seven local calendar days across a year boundary and excludes future rows', () => {
    const result = deriveFocusStatistics([
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440001', endedAt: '2025-12-25T23:59:00.000Z', actualFocusSeconds: 240 }),
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440002', endedAt: '2025-12-26T23:59:00.000Z', actualFocusSeconds: 300 }),
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440003', endedAt: '2025-12-31T23:59:00.000Z', actualFocusSeconds: 120, status: 'interrupted' }),
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440004', endedAt: '2026-01-01T00:05:00.000Z', actualFocusSeconds: 600 }),
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440005', endedAt: '2026-01-02T00:01:00.000Z', actualFocusSeconds: 90 }),
    ], { now: '2026-01-01T12:00:00.000Z', timeZone: 'UTC' })

    expect(result.lastSevenDays).toEqual([
      { dayKey: '2025-12-26', focusSeconds: 300, sessionCount: 1, completedSessionCount: 1 },
      { dayKey: '2025-12-27', focusSeconds: 0, sessionCount: 0, completedSessionCount: 0 },
      { dayKey: '2025-12-28', focusSeconds: 0, sessionCount: 0, completedSessionCount: 0 },
      { dayKey: '2025-12-29', focusSeconds: 0, sessionCount: 0, completedSessionCount: 0 },
      { dayKey: '2025-12-30', focusSeconds: 0, sessionCount: 0, completedSessionCount: 0 },
      { dayKey: '2025-12-31', focusSeconds: 120, sessionCount: 1, completedSessionCount: 0 },
      { dayKey: '2026-01-01', focusSeconds: 600, sessionCount: 1, completedSessionCount: 1 },
    ])
    expect(result.totalFocusSeconds).toBe(1_260)
    expect(result.completedSessionCount).toBe(3)
    expect(result.calendarDays).toEqual([
      { dayKey: '2025-12-25', focusSeconds: 240, sessionCount: 1, completedSessionCount: 1 },
      { dayKey: '2025-12-26', focusSeconds: 300, sessionCount: 1, completedSessionCount: 1 },
      { dayKey: '2025-12-31', focusSeconds: 120, sessionCount: 1, completedSessionCount: 0 },
      { dayKey: '2026-01-01', focusSeconds: 600, sessionCount: 1, completedSessionCount: 1 },
    ])
  })

  it('requires a completion on every local day of the streak and interrupted-only today breaks it', () => {
    const completedStreak = deriveFocusStatistics([
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440001', endedAt: '2026-08-24T00:05:00.000Z' }),
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440002', endedAt: '2026-08-25T00:04:00.000Z' }),
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440003', endedAt: '2026-08-25T00:05:00.000Z', actualFocusSeconds: 60, status: 'interrupted' }),
    ], { now: '2026-08-25T12:00:00.000Z', timeZone: 'UTC' })
    const interruptedToday = deriveFocusStatistics([
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440004', endedAt: '2026-08-24T00:05:00.000Z' }),
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440005', endedAt: '2026-08-25T00:05:00.000Z', actualFocusSeconds: 60, status: 'interrupted' }),
    ], { now: '2026-08-25T12:00:00.000Z', timeZone: 'UTC' })

    expect(completedStreak.currentStreakDays).toBe(2)
    expect(interruptedToday.currentStreakDays).toBe(0)
  })

  it('excludes non-positive rows and returns stable empty statistics', () => {
    const result = deriveFocusStatistics([
      focusRecord({ actualFocusSeconds: 0 }),
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440001', actualFocusSeconds: -1, status: 'interrupted' }),
    ], { now: '2026-08-25T12:00:00.000Z', timeZone: 'UTC' })
    const empty = deriveFocusStatistics([], { now: '2026-08-25T12:00:00.000Z', timeZone: 'UTC' })

    expect(result.today).toEqual({ dayKey: '2026-08-25', focusSeconds: 0, sessionCount: 0, completedSessionCount: 0 })
    expect(result.totalFocusSeconds).toBe(0)
    expect(result.completedSessionCount).toBe(0)
    expect(result.calendarDays).toEqual([])
    expect(empty.lastSevenDays.map((day) => day.dayKey)).toEqual([
      '2026-08-19', '2026-08-20', '2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24', '2026-08-25',
    ])
  })

  it('keeps distinct same-day records in deterministic calendar order', () => {
    const result = deriveFocusStatistics([
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440002', endedAt: '2026-08-24T00:05:00.000Z', actualFocusSeconds: 90, status: 'interrupted' }),
      focusRecord({ id: '550e8400-e29b-41d4-a716-446655440001', endedAt: '2026-08-24T00:04:00.000Z', actualFocusSeconds: 300 }),
    ], { now: '2026-08-25T12:00:00.000Z', timeZone: 'UTC' })

    expect(result.calendarDays).toEqual([
      { dayKey: '2026-08-24', focusSeconds: 390, sessionCount: 2, completedSessionCount: 1 },
    ])
  })

  it('rejects an invalid IANA time zone with the shared validation error type', () => {
    expect(() => dayKeyAt('2026-08-25T00:00:00.000Z', 'Mars/Olympus_Mons'))
      .toThrow(FocusValidationError)
  })

  it('requires an explicit non-blank IANA time zone instead of accepting host defaults', () => {
    expect(() => dayKeyAt('2026-08-25T00:00:00.000Z', undefined as unknown as string))
      .toThrow(FocusValidationError)
    expect(() => deriveFocusStatistics([], {
      now: '2026-08-25T00:00:00.000Z', timeZone: '   ',
    }))
      .toThrow(FocusValidationError)
  })

  it('requires an explicit ISO instant offset for day keys and statistics now', () => {
    expect(() => dayKeyAt('2026-08-25T00:00:00', 'UTC')).toThrow(FocusValidationError)
    expect(() => deriveFocusStatistics([], {
      now: '2026-08-25T00:00:00', timeZone: 'UTC',
    }))
      .toThrow(FocusValidationError)
  })
})
