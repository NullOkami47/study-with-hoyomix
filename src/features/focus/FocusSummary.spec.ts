import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'

import { usePreferences } from '../../stores/preferences'
import type { FocusStatistics } from './statistics'
import type { FocusSessionRecord } from './types'
import FocusSummary from './FocusSummary.vue'

function focusRecord(
  overrides: Partial<FocusSessionRecord> = {},
): FocusSessionRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    schemaVersion: 1,
    startedAt: '2026-08-25T00:00:00.000Z',
    endedAt: '2026-08-25T00:01:30.000Z',
    plannedFocusSeconds: 1_500,
    actualFocusSeconds: 90,
    status: 'interrupted',
    phase: 'focus',
    createdAt: '2026-08-25T00:01:30.000Z',
    ...overrides,
  }
}

const statistics: FocusStatistics = {
  timeZone: 'Asia/Hong_Kong',
  today: {
    dayKey: '2026-08-25',
    focusSeconds: 2_100,
    sessionCount: 3,
    completedSessionCount: 2,
  },
  lastSevenDays: [],
  calendarDays: [],
  totalFocusSeconds: 2_100,
  completedSessionCount: 2,
  currentStreakDays: 1,
}

beforeEach(() => {
  usePreferences().setLocale('en')
})

describe('FocusSummary', () => {
  it('reports an interrupted session with actual duration and truthful today totals', () => {
    const wrapper = mount(FocusSummary, {
      props: {
        record: focusRecord(),
        statistics,
      },
    })

    expect(wrapper.get('[data-focus-summary-status]').text()).toContain('Interrupted')
    expect(wrapper.get('[data-focus-summary-duration]').text()).toContain('1m 30s')
    expect(wrapper.get('[data-focus-summary-today-actual]').text()).toContain('35m')
    expect(wrapper.get('[data-focus-summary-today-completed]').text()).toContain('2')
    expect(wrapper.text()).not.toMatch(/track|provider|listening/iu)
  })
})
