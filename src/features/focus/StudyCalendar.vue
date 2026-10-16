<script setup lang="ts">
import { computed } from 'vue'

import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import {
  createFocusCalendarWeeks,
  focusSessionCountText,
  focusWeekdayLabels,
  formatLongFocusDuration,
} from './presentation'
import { deriveFocusStatistics } from './statistics'
import type { FocusSessionRecord } from './types'

const props = defineProps<{
  sessions: FocusSessionRecord[]
  timeZone: string
}>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)

function completedText(count: number): string {
  return text('focus.calendar.completed').replace('{count}', String(count))
}

const statistics = computed(() => deriveFocusStatistics(props.sessions, {
  now: new Date().toISOString(),
  timeZone: props.timeZone,
}))

const weeks = computed(() => createFocusCalendarWeeks(statistics.value.calendarDays, text))
const weekdayLabels = computed(() => focusWeekdayLabels(locale.value))
</script>

<template>
  <section class="focus-calendar" data-focus-calendar>
    <p
      v-if="statistics.calendarDays.length === 0"
      class="focus-calendar__empty"
      data-focus-calendar-empty
      role="status"
    >
      {{ text('focus.calendar.empty') }}
    </p>
    <div class="focus-calendar__table-wrap">
      <table>
        <caption>{{ text('focus.calendar.title') }}</caption>
        <thead>
          <tr>
            <th v-for="weekday in weekdayLabels" :key="weekday" scope="col">{{ weekday }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="week in weeks" :key="week.days[0].dayKey">
            <component
              :is="index === 0 ? 'th' : 'td'"
              v-for="(day, index) in week.days"
              :key="day.dayKey"
              :scope="index === 0 ? 'row' : undefined"
              :class="{ 'focus-calendar__week': index === 0 }"
              :data-focus-calendar-day="day.dayKey"
            >
              <span v-if="index === 0" class="focus-calendar__visually-hidden">{{ week.label }}. </span>
              <time :datetime="day.dayKey">{{ day.dayKey }}</time>
              <span>{{ formatLongFocusDuration(day.focusSeconds, text) }}</span>
              <span>{{ focusSessionCountText(day.sessionCount, text) }}</span>
              <span>{{ completedText(day.completedSessionCount) }}</span>
            </component>
          </tr>
        </tbody>
      </table>
    </div>

    <ol
      class="focus-calendar__list"
      data-focus-calendar-list
      :aria-label="text('focus.calendar.listLabel')"
    >
      <li v-for="day in statistics.calendarDays" :key="day.dayKey">
        <time :datetime="day.dayKey">{{ day.dayKey }}</time>:
        {{ formatLongFocusDuration(day.focusSeconds, text) }},
        {{ focusSessionCountText(day.sessionCount, text) }},
        {{ completedText(day.completedSessionCount) }}
      </li>
    </ol>
  </section>
</template>

<style scoped>
.focus-calendar { min-width: 0; padding: 1rem; color: var(--colour-text-primary); }
.focus-calendar__table-wrap { min-width: 0; overflow-x: auto; }
.focus-calendar__empty { margin: 0 0 0.75rem; color: var(--colour-text-muted); line-height: 1.5; }
table { width: 100%; min-width: 42rem; border-collapse: separate; border-spacing: 0.25rem; }
caption { margin-block-end: 0.75rem; font-weight: 700; text-align: start; }
th, td { padding: 0.75rem; text-align: start; vertical-align: top; background: var(--colour-surface-opaque); border: var(--glass-border); border-radius: 0.5rem; }
thead th { color: var(--colour-text-muted); font-size: 0.75rem; }
tbody th, tbody td { font-weight: 400; }
tbody time, tbody span { display: block; }
tbody time { margin-block-end: 0.5rem; font-size: 0.75rem; font-variant-numeric: tabular-nums; font-weight: 700; }
tbody span:not(.focus-calendar__visually-hidden) { color: var(--colour-text-muted); font-size: 0.75rem; line-height: 1.5; }
.focus-calendar__visually-hidden,
.focus-calendar__list {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 35rem) {
  .focus-calendar__table-wrap {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  .focus-calendar__list {
    position: static;
    display: grid;
    width: auto;
    height: auto;
    gap: 0.75rem;
    margin: 0;
    padding-inline-start: 1.5rem;
    overflow: visible;
    clip: auto;
    white-space: normal;
  }
  .focus-calendar__list li {
    padding: 0.75rem;
    color: var(--colour-text-muted);
    background: var(--colour-surface-opaque);
    border: var(--glass-border);
    border-radius: 0.5rem;
    line-height: 1.5;
  }
  .focus-calendar__list time {
    color: var(--colour-text-primary);
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }
}
</style>
