import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePreferences } from '../../stores/preferences'
import type { FocusSessionRecord } from './types'
import StudyCalendar from './StudyCalendar.vue'

function focusRecord(
  overrides: Partial<FocusSessionRecord> = {},
): FocusSessionRecord {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    schemaVersion: 1,
    startedAt: '2026-08-10T15:50:00.000Z',
    endedAt: '2026-08-10T16:15:00.000Z',
    plannedFocusSeconds: 1_500,
    actualFocusSeconds: 1_500,
    status: 'completed',
    phase: 'focus',
    createdAt: '2026-08-10T16:15:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-12T08:00:00.000Z'))
  usePreferences().setLocale('en')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('StudyCalendar', () => {
  it('exposes explicit-zone day values through a semantic table and ordered list', () => {
    const sessions = [
      focusRecord(),
      focusRecord({
        id: '33333333-3333-4333-8333-333333333333',
        startedAt: '2026-08-10T16:35:00.000Z',
        endedAt: '2026-08-10T16:45:00.000Z',
        actualFocusSeconds: 600,
        status: 'interrupted',
        createdAt: '2026-08-10T16:45:00.000Z',
      }),
    ]
    const wrapper = mount(StudyCalendar, {
      props: { sessions, timeZone: 'Asia/Hong_Kong' },
    })

    expect(wrapper.get('table caption').text()).toContain('Focus calendar')
    expect(wrapper.findAll('th[scope="col"]')).toHaveLength(7)
    expect(wrapper.findAll('th[scope="row"].focus-calendar__week')).not.toHaveLength(0)

    const tableDay = wrapper.get('[data-focus-calendar-day="2026-08-11"]')
    expect(tableDay.text()).toContain('2026-08-11')
    expect(tableDay.text()).toContain('35 minutes')
    expect(tableDay.text()).toContain('2 sessions')
    expect(tableDay.text()).toContain('1 completed')

    const fallback = wrapper.get('ol[data-focus-calendar-list]')
    expect(fallback.attributes('aria-hidden')).toBeUndefined()
    expect(fallback.text()).toContain('2026-08-11')
    expect(fallback.text()).toContain('35 minutes')
    expect(fallback.text()).toContain('2 sessions')
    expect(fallback.text()).toContain('1 completed')
    expect(wrapper.get('[data-focus-calendar-day="2026-08-10"]').text()).toContain('0 sessions')
  })

  it('announces an empty local history without removing the calendar semantics', () => {
    const wrapper = mount(StudyCalendar, {
      props: { sessions: [], timeZone: 'Asia/Hong_Kong' },
    })

    expect(wrapper.get('[data-focus-calendar-empty][role="status"]').text())
      .toContain('No focus sessions yet')
    expect(wrapper.get('table caption').text()).toContain('Focus calendar')
    expect(wrapper.findAll('th[scope="col"]')).toHaveLength(7)
    expect(wrapper.get('ol[data-focus-calendar-list]').element).toBeTruthy()
  })
})
