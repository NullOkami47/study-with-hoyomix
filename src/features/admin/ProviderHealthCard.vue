<script setup lang="ts">
import { computed } from 'vue'
import type { AdminProvider, ProviderStatus } from './client'
import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'
import { formatRelative as formatRelativeHelper } from './format'

const props = defineProps<{
  providers: AdminProvider[]
  loading?: boolean
}>()

const { locale } = usePreferences()

function t(key: string): string {
  return translate(locale.value, key as TranslationKey)
}

const DASH = '\u2014'

const statusOrder: Record<ProviderStatus, number> = {
  unavailable: 0,
  degraded: 1,
  unknown: 2,
  healthy: 3,
}

const sorted = computed(() =>
  [...props.providers].sort(
    (a, b) => statusOrder[a.status] - statusOrder[b.status] || a.priority - b.priority,
  ),
)

const formatLatency = (latencyMs: number | null): string =>
  latencyMs === null ? DASH : `${latencyMs} ms`

const formatRelative = (checkedAt: number | null): string =>
  formatRelativeHelper(checkedAt, locale.value)
</script>

<template>
  <section class="provider-health" data-provider-health-card>
    <header class="provider-health__header">
      <h3>{{ t('admin.providers.title') || 'Provider health' }}</h3>
      <span
        v-if="loading"
        class="provider-health__loading"
        role="status"
        aria-live="polite"
      >{{ t('admin.providers.refreshing') || 'Checking...' }}</span>
    </header>

    <ul class="provider-health__list">
      <li
        v-for="provider in sorted"
        :key="provider.key"
        class="provider-health__item"
        :data-provider-key="provider.key"
        :data-provider-status="provider.status"
      >
        <!--
          Decorative. The status is already stated in words in the cell beside it, so the dot
          is a second rendering of the same fact for sighted users. It previously carried
          aria-label="Status: healthy", which axe reports as aria-prohibited-attr (WCAG 4.1.2):
          a plain span has no role for that name to attach to, so browsers may drop it
          entirely -- and where it is honoured it announces the status twice. Marking it hidden
          is the accurate description of what it is, not a suppression of the finding.
        -->
        <span
          class="provider-health__dot"
          :class="`provider-health__dot--${provider.status}`"
          aria-hidden="true"
        ></span>
        <span class="provider-health__name">{{ provider.key }}</span>
        <span
          class="provider-health__status"
          :data-provider-status-text="provider.status"
        >{{ provider.status }}</span>
        <span
          class="provider-health__metric provider-health__metric--latency"
        >{{ formatLatency(provider.latencyMs) }}</span>
        <span
          class="provider-health__metric provider-health__metric--failure"
          :data-provider-failure="provider.failureClass ?? 'none'"
        >{{ provider.failureClass ?? DASH }}</span>
        <span class="provider-health__metric provider-health__metric--checked">
          {{ formatRelative(provider.checkedAt) }}
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.provider-health {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
  padding: 1rem 1.25rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
}

.provider-health__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
}

.provider-health__header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.provider-health__loading {
  color: var(--colour-text-muted);
  font-size: 0.8125rem;
}

.provider-health__list {
  display: grid;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Six columns reserved 436px against a 430px container, and the name column was
   already sitting on its 5rem floor, so the row could not fit however narrow the name
   got. The name is the column that may shrink -- it wraps -- so it carries no floor. */
.provider-health__item {
  display: grid;
  grid-template-columns: 0.75rem minmax(0, 1fr) 5rem 4.5rem 5rem 4.5rem;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--glass-edge);
  font-size: 0.875rem;
}

.provider-health__item:last-child {
  border-bottom: none;
}

.provider-health__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--colour-text-muted);
}

.provider-health__dot--healthy {
  background: #4ade80;
  box-shadow: 0 0 0.25rem rgb(74 222 128 / 60%);
}

.provider-health__dot--degraded {
  background: #fbbf24;
  box-shadow: 0 0 0.25rem rgb(251 191 36 / 60%);
}

.provider-health__dot--unavailable {
  background: #f87171;
  box-shadow: 0 0 0.25rem rgb(248 113 113 / 60%);
}

.provider-health__dot--unknown {
  background: var(--colour-text-muted);
}

.provider-health__name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.provider-health__status {
  text-transform: capitalize;
  font-variant-numeric: tabular-nums;
}

.provider-health__status[data-provider-status-text="healthy"] {
  color: #4ade80;
}

.provider-health__status[data-provider-status-text="degraded"] {
  color: #fbbf24;
}

.provider-health__status[data-provider-status-text="unavailable"] {
  color: #f87171;
}

.provider-health__metric {
  color: var(--colour-text-muted);
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.provider-health__metric--checked {
  font-size: 0.8125rem;
}

.provider-health__metric--failure[data-provider-failure="none"] {
  opacity: 0.5;
}

@media (max-width: 36rem) {
  /* The status column is sized by its longest word rather than a guessed 4.5rem, which
     'unavailable' overran by 4px. The name column takes what is left and wraps. */
  .provider-health__item {
    grid-template-columns: 0.75rem minmax(0, 1fr) auto;
    grid-template-areas:
      "dot name status"
      ".   latency checked"
      ".   failure failure";
    row-gap: 0.125rem;
  }
  .provider-health__name { grid-area: name; }
  .provider-health__status { grid-area: status; }
  .provider-health__dot { grid-area: dot; }
  /* Was :first-of-type, which matched nothing: every child here is a span, so the
     first of that type is the status dot, and the dot carries no metric class. Latency
     therefore had no area and auto-placed into the 12px dot column, where a dash for an
     unmeasured provider needed 15px. Named like its two siblings instead. */
  .provider-health__metric--latency { grid-area: latency; }
  .provider-health__metric--failure { grid-area: failure; }
  .provider-health__metric--checked { grid-area: checked; }
}
</style>
