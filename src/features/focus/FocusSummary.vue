<script setup lang="ts">
import { computed } from 'vue'

import { translate, type TranslationKey } from '../../i18n'
import { usePreferences } from '../../stores/preferences'
import { formatCompactFocusDuration } from './presentation'
import type { FocusStatistics } from './statistics'
import type { FocusSessionRecord } from './types'

const props = defineProps<{
  record: FocusSessionRecord
  statistics: FocusStatistics
}>()
const { locale } = usePreferences()
const text = (key: TranslationKey): string => translate(locale.value, key)

const statusKey = computed<TranslationKey>(() => (
  props.record.status === 'completed'
    ? 'focus.summary.completed'
    : 'focus.summary.interrupted'
))
</script>

<template>
  <section class="focus-summary" data-focus-summary>
    <p class="focus-summary__status" data-focus-summary-status role="status">
      {{ text(statusKey) }}
    </p>
    <dl>
      <div>
        <dt>{{ text('focus.summary.finishedDuration') }}</dt>
        <dd data-focus-summary-duration>{{ formatCompactFocusDuration(record.actualFocusSeconds, text) }}</dd>
      </div>
      <div>
        <dt>{{ text('focus.summary.todayActual') }}</dt>
        <dd data-focus-summary-today-actual>{{ formatCompactFocusDuration(statistics.today.focusSeconds, text) }}</dd>
      </div>
      <div>
        <dt>{{ text('focus.summary.todayCompleted') }}</dt>
        <dd data-focus-summary-today-completed>{{ statistics.today.completedSessionCount }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.focus-summary {
  display: grid;
  gap: 1rem;
  min-width: 0;
  padding: 1rem;
  color: var(--colour-text-primary);
}

.focus-summary__status {
  margin: 0;
  color: var(--colour-accent-strong);
  font-size: 1rem;
  font-weight: 700;
}

dl {
  display: grid;
  gap: 0.75rem;
  margin: 0;
}

dl > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: baseline;
  padding: 0.75rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
}

dt {
  color: var(--colour-text-muted);
  font-size: 0.875rem;
  line-height: 1.5;
}

dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

@media (max-width: 23.5rem) {
  dl > div { grid-template-columns: 1fr; gap: 0.25rem; }
}
</style>
