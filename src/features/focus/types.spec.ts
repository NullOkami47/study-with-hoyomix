import { describe, expect, it } from 'vitest'

import {
  FOCUS_SESSION_SCHEMA_VERSION,
  FocusValidationError,
  parseFocusSessionRecord,
} from './types'
import type { FocusSessionRecord } from './types'

const focusRecord = (overrides: Partial<FocusSessionRecord> = {}): FocusSessionRecord => ({
  id: '550e8400-e29b-41d4-a716-446655440000',
  schemaVersion: 1,
  startedAt: '2026-08-25T00:00:00.000Z',
  endedAt: '2026-08-25T00:05:00.000Z',
  plannedFocusSeconds: 300,
  actualFocusSeconds: 300,
  status: 'completed',
  phase: 'focus',
  createdAt: '2026-08-25T00:05:00.000Z',
  ...overrides,
})

describe('focus session record validation', () => {
  it('accepts only the exact immutable schema and emits canonical field order', () => {
    const parsed = parseFocusSessionRecord(focusRecord(), 'record')

    expect(FOCUS_SESSION_SCHEMA_VERSION).toBe(1)
    expect(parsed).toEqual(focusRecord())
    expect(Object.keys(parsed)).toEqual([
      'id',
      'schemaVersion',
      'startedAt',
      'endedAt',
      'plannedFocusSeconds',
      'actualFocusSeconds',
      'status',
      'phase',
      'createdAt',
    ])
  })

  it('normalises equivalent UUID and ISO instant spellings', () => {
    const parsed = parseFocusSessionRecord(focusRecord({
      id: '550E8400-E29B-41D4-A716-446655440000',
      startedAt: '2026-08-25T08:00:00+08:00',
      endedAt: '2026-08-25T08:05:00.000+08:00',
      createdAt: '2026-08-25T08:05:00.000+08:00',
    }))

    expect(parsed).toEqual(focusRecord())
    expect(parseFocusSessionRecord(parsed)).toEqual(parsed)
    for (const instant of [parsed.startedAt, parsed.endedAt, parsed.createdAt]) {
      expect(instant).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
    }
  })

  it.each([
    '2026-08-25T00:00:00.0000Z',
    '2026-08-25T00:00:00.0001Z',
    '2026-08-25T00:00:00.1234+00:00',
  ])('rejects lossy sub-millisecond instant %s', (startedAt) => {
    expect(() => parseFocusSessionRecord(focusRecord({ startedAt })))
      .toThrow(FocusValidationError)
  })

  it.each([
    '0000-01-01T00:00:00.000+14:00',
    '9999-12-31T23:59:59.999-14:00',
  ])('rejects offsets that canonicalise outside the four-digit UTC year grammar: %s', (createdAt) => {
    expect(() => parseFocusSessionRecord(focusRecord({ createdAt })))
      .toThrow(FocusValidationError)
  })

  it.each([
    ['track metadata', { trackId: 'private-track' }],
    ['provider metadata', { provider: 'private-provider' }],
    ['listening metadata', { mediaUrl: 'https://example.com/private' }],
  ])('rejects unknown %s', (_label, unknownFields) => {
    expect(() => parseFocusSessionRecord({ ...focusRecord(), ...unknownFields }, 'record'))
      .toThrow(FocusValidationError)
  })

  it.each([
    ['id', { id: 'not-a-uuid' }],
    ['schemaVersion', { schemaVersion: 2 }],
    ['startedAt', { startedAt: '2026-08-25' }],
    ['endedAt', { endedAt: '2026-02-30T00:05:00.000Z' }],
    ['createdAt', { createdAt: '2026-08-25T00:05:00' }],
    ['plannedFocusSeconds', { plannedFocusSeconds: 0 }],
    ['plannedFocusSeconds', { plannedFocusSeconds: 1.5 }],
    ['actualFocusSeconds', { actualFocusSeconds: -1 }],
    ['actualFocusSeconds', { actualFocusSeconds: 1.5 }],
    ['status', { status: 'paused' }],
    ['phase', { phase: 'break' }],
  ])('rejects an invalid %s field', (_field, overrides) => {
    expect(() => parseFocusSessionRecord({ ...focusRecord(), ...overrides }, 'record'))
      .toThrow(FocusValidationError)
  })

  it('rejects missing fields and non-record values', () => {
    const { createdAt: _createdAt, ...missingCreatedAt } = focusRecord()

    expect(() => parseFocusSessionRecord(missingCreatedAt, 'record')).toThrow(FocusValidationError)
    expect(() => parseFocusSessionRecord(null, 'record')).toThrow(FocusValidationError)
    expect(() => parseFocusSessionRecord([], 'record')).toThrow(FocusValidationError)
  })

  it('rejects impossible time and duration orderings', () => {
    expect(() => parseFocusSessionRecord(focusRecord({
      endedAt: '2026-08-24T23:59:59.000Z',
    }), 'record')).toThrow(FocusValidationError)
    expect(() => parseFocusSessionRecord(focusRecord({
      actualFocusSeconds: 301,
    }), 'record')).toThrow(FocusValidationError)
    expect(() => parseFocusSessionRecord(focusRecord({
      actualFocusSeconds: 299,
      status: 'completed',
    }), 'record')).toThrow(FocusValidationError)
  })

  it('accepts a positive interrupted duration without adding implementation metadata', () => {
    expect(parseFocusSessionRecord(focusRecord({
      actualFocusSeconds: 37,
      status: 'interrupted',
    }))).toEqual(focusRecord({ actualFocusSeconds: 37, status: 'interrupted' }))
  })
})
