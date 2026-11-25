<script setup lang="ts">
import { computed } from 'vue'
import { Play, RefreshCw } from 'lucide-vue-next'
import type { AdminDiscoveryStatus, AdminDiscoveryCycle } from './client'
import AdminStatusChip from './primitives/AdminStatusChip.vue'
import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'

const props = defineProps<{ status: AdminDiscoveryStatus; busy: boolean; lastResult?: AdminDiscoveryCycle }>()
defineEmits<{ run: []; refresh: [] }>()
const { locale } = usePreferences()
const t = (key: string, params?: Record<string, unknown>) => translate(locale.value, ('admin.catalogue.discovery.ops.' + key) as TranslationKey, params)
const monitoring = computed(() => props.status.monitoring)
const latest = computed(() => {
  const recorded = props.status.automation?.cycles[0]
  return props.lastResult && (!recorded || props.lastResult.startedAt > recorded.startedAt) ? props.lastResult : recorded
})
const when = (at: number) => new Date(at).toLocaleString(locale.value === 'en' ? 'en-GB' : locale.value)
const age = (ms: number | null) => ms === null ? t('never') : ms >= 86400000 ? t('days', { count: Math.floor(ms / 86400000) })
  : ms >= 3600000 ? t('hours', { count: Math.floor(ms / 3600000) }) : t('minutes', { count: Math.floor(ms / 60000) })
const variant = (outcome: string) => ['completed', 'configured', 'enabled'].includes(outcome) ? 'success'
  : ['failed', 'error', 'invalid'].includes(outcome) ? 'danger'
  : ['stale', 'waiting', 'missing', 'unconfigured'].includes(outcome) ? 'warning' : 'neutral'
const configKeys = ['automation', 'autoPublish', 'channels', 'ingestion', 'sheets', 'quota'] as const
const countKeys = ['discovered', 'classified', 'published'] as const
</script>

<template>
  <section class="discovery-ops" data-discovery-operations :aria-label="t('title')" :aria-busy="busy">
    <header class="discovery-ops__header">
      <div><h4>{{ t('title') }}</h4><p>{{ t('runHelp') }}</p></div>
      <div class="discovery-ops__actions">
        <button type="button" data-discovery-refresh :disabled="busy" @click="$emit('refresh')">
          <RefreshCw :size="16" aria-hidden="true" />{{ t('refresh') }}
        </button>
        <button type="button" data-discovery-run-now :disabled="busy || !status.automation?.enabled || !status.automation?.canRun" @click="$emit('run')">
          <Play :size="16" aria-hidden="true" />{{ busy ? t('busy') : t('runNow') }}
        </button>
      </div>
    </header>
    <p v-if="!status.automation?.canRun">{{ t('runGate') }}</p>
    <template v-if="monitoring">
      <dl class="discovery-ops__counts">
        <div v-for="key in countKeys" :key="key"><dt>{{ t(key) }}</dt><dd :data-discovery-count="key">{{ monitoring.counts[key] }}</dd></div>
      </dl>
      <details class="discovery-ops__config" :open="monitoring.configuration.automation !== 'enabled' || monitoring.configuration.sheets !== 'configured' || monitoring.configuration.quota !== 'configured'">
        <summary>{{ t('configuration') }}</summary>
        <dl class="discovery-ops__metadata">
          <div v-for="key in configKeys" :key="key" :data-discovery-config="key">
            <dt>{{ t('config.' + key) }}</dt><dd><AdminStatusChip :variant="variant(monitoring.configuration[key])" size="sm">{{ t(monitoring.configuration[key]) }}</AdminStatusChip></dd>
          </div>
        </dl>
        <p>{{ t('configHelp') }}</p>
      </details>
      <p data-discovery-schedule>{{ t('scheduleUnverified') }}</p>
      <div class="discovery-ops__observation">
        <h5>{{ t('externalAi') }}</h5>
        <div class="discovery-ops__line">
          <AdminStatusChip data-discovery-ai-state :data-state="monitoring.externalAi.state" :variant="variant(monitoring.externalAi.state)" size="sm">{{ t('ai.' + monitoring.externalAi.state) }}</AdminStatusChip>
          <span>{{ t('waitingCount', { count: monitoring.externalAi.waiting }) }}</span>
        </div>
        <p>{{ t('aiUnverified') }}</p>
        <p v-if="monitoring.externalAi.oldestPendingAt !== null">{{ t('oldest') }}: {{ when(monitoring.externalAi.oldestPendingAt) }}</p>
        <code v-if="monitoring.externalAi.reason">{{ monitoring.externalAi.reason }}</code>
      </div>
      <div class="discovery-ops__observation">
        <h5>{{ t('scanner') }}</h5>
        <p data-discovery-scanner-age>{{ t('age') }}: {{ age(monitoring.scanner.ageMs) }} <AdminStatusChip v-if="monitoring.scanner.stale" variant="warning" size="sm">{{ t('stale') }}</AdminStatusChip></p>
        <p v-if="monitoring.scanner.lastRun"><time :datetime="new Date(monitoring.scanner.lastRun.createdAt).toISOString()">{{ when(monitoring.scanner.lastRun.createdAt) }}</time> · <code>{{ monitoring.scanner.lastRun.runId }}</code> · <code>{{ monitoring.scanner.lastRun.outcome }}</code></p>
        <p v-if="monitoring.scanner.lastRun">{{ t('scanCounts', { added: monitoring.scanner.lastRun.added, discovered: monitoring.scanner.lastRun.discovered }) }}</p>
        <p v-if="monitoring.scanner.lastFailure">{{ t('lastFailure') }}: {{ when(monitoring.scanner.lastFailure.createdAt) }} · <AdminStatusChip variant="danger" size="sm">{{ monitoring.scanner.lastFailure.outcome }}</AdminStatusChip></p>
        <p>{{ t('scannerBoundary') }}</p>
      </div>
    </template>
    <p v-else>{{ t('statusUnavailable') }}</p>
    <div class="discovery-ops__observation" aria-live="polite">
      <h5>{{ t('latest') }}</h5>
      <template v-if="latest">
        <div class="discovery-ops__line"><AdminStatusChip :variant="variant(latest.outcome)" size="sm">{{ t('cycle.' + latest.outcome) }}</AdminStatusChip><code>{{ latest.cycleId }}</code></div>
        <p>{{ t('started') }}: {{ when(latest.startedAt) }}<template v-if="latest.finishedAt !== undefined"> · {{ t('finished') }}: {{ when(latest.finishedAt) }}</template></p>
        <p v-if="latest.publishedRevision !== null">{{ t('publishedRevision') }}: {{ latest.publishedRevision }}</p>
        <ul class="discovery-ops__phases">
          <li v-for="(phase, index) in latest.phases" :key="index">
            <strong>{{ t('phase.' + phase.phase) }}</strong>
            <span>{{ t('phaseCounts', { processed: phase.processed, failed: phase.failed }) }}</span>
            <code>{{ phase.outcome }}</code>
            <ul v-if="phase.details.length"><li v-for="detail in phase.details" :key="detail"><code>{{ detail }}</code></li></ul>
          </li>
        </ul>
        <p>{{ t('phaseHelp') }}</p>
      </template>
      <p v-else>{{ t('never') }}</p>
    </div>
  </section>
</template>

<style scoped>
.discovery-ops { display: flex; flex-direction: column; gap: 1rem; min-width: 0; padding: 1rem; border: 1px solid var(--glass-edge); border-radius: var(--radius-control); background: var(--colour-surface-glass); }
.discovery-ops h4, .discovery-ops h5, .discovery-ops p, .discovery-ops dl, .discovery-ops dd { margin: 0; }
.discovery-ops p, .discovery-ops dt { color: var(--colour-text-muted); }
.discovery-ops__header, .discovery-ops__actions, .discovery-ops__line { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.discovery-ops__header { justify-content: space-between; align-items: flex-start; gap: 1rem; }
.discovery-ops__header > div:first-child { flex: 1; min-width: min(100%, 15rem); }
.discovery-ops__counts, .discovery-ops__metadata { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
.discovery-ops__counts dd { font-size: 1.75rem; font-weight: 700; }
.discovery-ops__metadata { grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); margin-bottom: 0.75rem !important; }
.discovery-ops__observation { display: flex; flex-direction: column; gap: 0.5rem; }
.discovery-ops__phases { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.75rem; }
.discovery-ops__phases > li { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem 1rem; }
.discovery-ops__phases ul { flex-basis: 100%; padding-left: 1rem; }
.discovery-ops code, .discovery-ops p, .discovery-ops dd { overflow-wrap: anywhere; }
.discovery-ops button { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; min-height: 44px; padding: 0.5rem 0.75rem; font: inherit; border: 1px solid var(--glass-edge); border-radius: var(--radius-control); background: var(--colour-surface-glass); color: var(--colour-text-primary); cursor: pointer; }
.discovery-ops button:disabled { opacity: 0.5; cursor: default; }
.discovery-ops button:focus-visible { outline: 2px solid var(--colour-focus); outline-offset: 3px; }
.discovery-ops summary { min-height: 44px; cursor: pointer; align-content: center; }
.discovery-ops summary:focus-visible { outline: 2px solid var(--colour-focus); outline-offset: 3px; }
@media (max-width: 640px) {
  .discovery-ops__counts { grid-template-columns: 1fr; gap: 0.5rem; }
  .discovery-ops__counts > div { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  .discovery-ops__actions { width: 100%; }
  .discovery-ops__actions button { flex: 1; }
}
</style>
