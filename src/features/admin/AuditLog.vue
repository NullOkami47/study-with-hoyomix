<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import type { AdminAuditEntry, AdminAuditFilter, AdminAuditPage, AdminRepository, AdminRole } from './client'
import AdminPageHeader from './primitives/AdminPageHeader.vue'
import AdminStatusChip from './primitives/AdminStatusChip.vue'
import AdminEmptyState from './primitives/AdminEmptyState.vue'
import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'
import { formatRelative as formatRelativeHelper } from './format'

const props = defineProps<{
  repository: AdminRepository
  role: AdminRole | null
}>()

const { locale } = usePreferences()

function t(key: string, params?: Record<string, unknown>): string {
  return translate(locale.value, key as TranslationKey, params)
}

const repo = props.repository
const DASH = '\u2014'
const PAGE_SIZE = 25

const entries = ref<AdminAuditEntry[]>([])
const total = ref(0)
const offset = ref(0)
const loading = ref(true)
const errorMessage = ref('')
const expandedRows = ref<Record<string, boolean>>({})

const filterActor = ref('')
const filterAction = ref('')
const filterTarget = ref('')
const filterModule = ref('')
const filterFrom = ref('')
const filterTo = ref('')

const canExport = computed(() => props.role === 'owner')
const hasMore = computed(() => offset.value + entries.value.length < total.value)
const hasPrev = computed(() => offset.value > 0)
const rangeText = computed(() => {
  if (entries.value.length === 0) return DASH
  const start = offset.value + 1
  const end = offset.value + entries.value.length
  return t('admin.audit.range', { start, end, total: total.value }) || `${start}\u2013${end} of ${total.value}`
})

function buildFilter(): AdminAuditFilter {
  const filter: AdminAuditFilter = { limit: PAGE_SIZE, offset: offset.value }
  if (filterActor.value) filter.actor = filterActor.value
  if (filterAction.value) filter.action = filterAction.value
  if (filterTarget.value) filter.target = filterTarget.value
  if (filterModule.value) filter.module = filterModule.value
  const from = Number(filterFrom.value)
  if (filterFrom.value && Number.isInteger(from) && from >= 0) filter.from = from
  const to = Number(filterTo.value)
  if (filterTo.value && Number.isInteger(to) && to >= 0) filter.to = to
  return filter
}

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    const page: AdminAuditPage = await repo.listAudit(buildFilter())
    entries.value = page.entries
    total.value = page.total
  } catch {
    errorMessage.value = t('admin.audit.loadError') || 'Failed to load audit log.'
  } finally {
    loading.value = false
  }
}

function applyFilters(): void {
  offset.value = 0
  void load()
}

function applyPreset(hours: number | null): void {
  if (hours === null) {
    filterFrom.value = ''
    filterTo.value = ''
  } else {
    const now = Date.now()
    filterFrom.value = String(now - hours * 3600 * 1000)
    filterTo.value = String(now)
  }
  applyFilters()
}

function nextPage(): void {
  offset.value += PAGE_SIZE
  void load()
}

function prevPage(): void {
  offset.value = Math.max(0, offset.value - PAGE_SIZE)
  void load()
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

function formatRelative(ms: number): string {
  return formatRelativeHelper(ms, locale.value)
}

function detailJson(detail: Record<string, unknown>): string {
  const keys = Object.keys(detail)
  return keys.length === 0 ? DASH : JSON.stringify(detail)
}

function formatPrettyJson(detail: Record<string, unknown>): string {
  return JSON.stringify(detail, null, 2)
}

function toggleExpand(id: string): void {
  expandedRows.value = {
    ...expandedRows.value,
    [id]: !expandedRows.value[id],
  }
}

async function exportLog(): Promise<void> {
  try {
    const page = await repo.exportAudit(buildFilter())
    const blob = new Blob([JSON.stringify(page, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'audit-export.json'
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch {
    errorMessage.value = t('admin.audit.exportError') || 'Failed to export audit log.'
  }
}

onMounted(load)
</script>

<template>
  <section class="audit-log" data-audit-log>
    <AdminPageHeader
      :title="t('admin.audit.title') || 'Audit log'"
      :subtitle="t('admin.audit.subtitle') || 'Immutable record of administrative actions, provider mutations, and catalogue publishes.'"
    >
      <template #actions>
        <button
          v-if="canExport"
          type="button"
          class="audit-log__btn-export"
          data-audit-export
          @click="exportLog"
        >
          <span>{{ t('admin.audit.exportJson') || 'Export JSON' }}</span>
        </button>
      </template>
    </AdminPageHeader>

    <!-- Quick Presets -->
    <div class="audit-log__preset-bar">
      <span class="audit-log__preset-label">{{ t('admin.audit.quickRange') || 'Quick time range:' }}</span>
      <div class="audit-log__preset-buttons">
        <button type="button" class="audit-log__preset-btn" @click="applyPreset(1)">{{ t('admin.audit.preset.1h') || 'Last 1h' }}</button>
        <button type="button" class="audit-log__preset-btn" @click="applyPreset(24)">{{ t('admin.audit.preset.24h') || 'Last 24h' }}</button>
        <button type="button" class="audit-log__preset-btn" @click="applyPreset(168)">{{ t('admin.audit.preset.7d') || 'Last 7d' }}</button>
        <button type="button" class="audit-log__preset-btn" @click="applyPreset(null)">{{ t('admin.audit.preset.all') || 'All time' }}</button>
      </div>
    </div>

    <!-- Structured Filter Bar -->
    <form class="audit-log__filters" data-audit-filters @submit.prevent="applyFilters">
      <div class="audit-log__filter-grid">
        <label class="audit-log__field">
          <span>{{ t('admin.audit.field.actor') || 'Actor' }}</span>
          <input v-model="filterActor" type="text" data-audit-filter-actor :placeholder="t('admin.audit.field.actorPlaceholder') || 'user id'" />
        </label>
        <label class="audit-log__field">
          <span>{{ t('admin.audit.field.action') || 'Action' }}</span>
          <input v-model="filterAction" type="text" data-audit-filter-action :placeholder="t('admin.audit.field.actionPlaceholder') || 'notice.publish'" />
        </label>
        <label class="audit-log__field">
          <span>{{ t('admin.audit.field.target') || 'Target' }}</span>
          <input v-model="filterTarget" type="text" data-audit-filter-target :placeholder="t('admin.audit.field.targetPlaceholder') || 'provider:youtube'" />
        </label>
        <label class="audit-log__field">
          <span>{{ t('admin.audit.field.module') || 'Module' }}</span>
          <input v-model="filterModule" type="text" data-audit-filter-module :placeholder="t('admin.audit.field.modulePlaceholder') || 'notice'" />
        </label>
        <label class="audit-log__field">
          <span>{{ t('admin.audit.field.from') || 'From (ms)' }}</span>
          <input v-model="filterFrom" type="number" min="0" data-audit-filter-from :placeholder="t('admin.audit.field.epochMs') || 'Epoch ms'" />
        </label>
        <label class="audit-log__field">
          <span>{{ t('admin.audit.field.to') || 'To (ms)' }}</span>
          <input v-model="filterTo" type="number" min="0" data-audit-filter-to :placeholder="t('admin.audit.field.epochMs') || 'Epoch ms'" />
        </label>
      </div>
      <div class="audit-log__filter-actions">
        <button type="submit" class="audit-log__btn-apply" data-audit-apply>{{ t('admin.audit.applyFilters') || 'Apply filters' }}</button>
      </div>
    </form>

    <p v-if="loading" class="audit-log__status" role="status">{{ t('admin.audit.loading') || 'Loading audit log...' }}</p>
    <p v-else-if="errorMessage" class="audit-log__error" role="alert">{{ errorMessage }}</p>

    <div v-if="!loading" class="audit-log__table-wrap">
      <ul class="audit-log__list" data-audit-list>
        <li
          v-for="entry in entries"
          :key="entry.id"
          class="audit-log__entry"
          :data-audit-id="entry.id"
          :data-audit-action="entry.action"
          :data-audit-target="entry.targetKey"
        >
          <div class="audit-log__entry-main">
            <div class="audit-log__entry-col audit-log__entry-col--time">
              <span class="audit-log__time" :data-audit-created="entry.id">{{ formatTime(entry.createdAt) }}</span>
              <span class="audit-log__time-rel">{{ formatRelative(entry.createdAt) }}</span>
            </div>

            <div class="audit-log__entry-col audit-log__entry-col--action">
              <AdminStatusChip variant="info" size="sm">
                <span class="audit-log__action">{{ entry.action }}</span>
              </AdminStatusChip>
            </div>

            <div class="audit-log__entry-col audit-log__entry-col--actor">
              <span class="audit-log__actor-label">{{ t('admin.audit.actorLabel') || 'Actor:' }}</span>
              <span class="audit-log__actor">{{ entry.actorUserId ?? DASH }}</span>
            </div>

            <div class="audit-log__entry-col audit-log__entry-col--target">
              <span class="audit-log__target-label">{{ t('admin.audit.targetLabel') || 'Target:' }}</span>
              <span class="audit-log__target">{{ entry.targetKey }}</span>
            </div>

            <div class="audit-log__entry-col audit-log__entry-col--expand">
              <button
                type="button"
                class="audit-log__btn-toggle-detail"
                @click="toggleExpand(entry.id)"
              >
                {{ expandedRows[entry.id] ? (t('admin.audit.hideDetails') || 'Hide details') : (t('admin.audit.inspectPayload') || 'Inspect payload') }}
              </button>
            </div>
          </div>

          <!-- Concise JSON summary or formatted full view -->
          <div class="audit-log__entry-detail-row">
            <span class="audit-log__detail" :data-audit-detail="entry.id">
              {{ detailJson(entry.detail) }}
            </span>
            <div v-if="expandedRows[entry.id]" class="audit-log__expanded-payload">
              <pre>{{ formatPrettyJson(entry.detail) }}</pre>
            </div>
          </div>
        </li>

        <li v-if="entries.length === 0" class="audit-log__empty">
          <AdminEmptyState
            :title="t('admin.audit.emptyTitle') || 'No audit entries'"
            :message="t('admin.audit.emptyDesc') || 'No administrative log entries match the current filter.'"
            icon="📜"
          />
        </li>
      </ul>
    </div>

    <footer v-if="!loading && entries.length > 0" class="audit-log__pager">
      <span class="audit-log__range" data-audit-range>{{ rangeText }}</span>
      <div class="audit-log__pager-buttons">
        <button type="button" data-audit-prev :disabled="!hasPrev" @click="prevPage">{{ t('admin.audit.prev') || 'Previous' }}</button>
        <button type="button" data-audit-next :disabled="!hasMore" @click="nextPage">{{ t('admin.audit.next') || 'Next' }}</button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.audit-log {
  display: grid;
  gap: 1rem;
  min-width: 0;
  padding: 1.25rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
}

.audit-log__btn-export {
  padding: 0.5rem 1rem;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--glass-edge);
  border-radius: 0.5rem;
  color: var(--colour-accent-strong);
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.audit-log__btn-export:hover {
  background: rgba(255, 255, 255, 0.15);
}

.audit-log__preset-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
}

.audit-log__preset-buttons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.audit-log__preset-btn {
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--glass-edge);
  color: var(--colour-text-muted);
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.audit-log__preset-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--colour-text-primary);
}

.audit-log__filters {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--glass-edge);
  border-radius: 8px;
}

.audit-log__filter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.75rem;
}

.audit-log__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.audit-log__field span {
  font-size: 0.75rem;
  color: var(--colour-text-muted);
}

.audit-log__field input {
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--glass-edge);
  border-radius: 6px;
  color: var(--colour-text-primary);
  font-size: 0.8125rem;
}

.audit-log__filter-actions {
  display: flex;
  justify-content: flex-end;
}

.audit-log__btn-apply {
  padding: 6px 16px;
  border-radius: 6px;
  background: #2563eb;
  border: none;
  color: #ffffff;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.audit-log__btn-apply:hover {
  background: #1d4ed8;
}

.audit-log__table-wrap {
  overflow-x: auto;
}

.audit-log__list {
  display: grid;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.audit-log__entry {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.875rem 1rem;
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  font-size: 0.8125rem;
}

.audit-log__entry-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.audit-log__entry-col {
  display: flex;
  align-items: center;
  gap: 6px;
}

.audit-log__entry-col--time {
  font-family: monospace;
  font-size: 0.75rem;
  gap: 8px;
}

.audit-log__time-rel {
  color: var(--colour-text-muted);
}

.audit-log__actor-label,
.audit-log__target-label {
  color: var(--colour-text-muted);
  font-size: 0.75rem;
}

.audit-log__actor,
.audit-log__target {
  font-weight: 600;
}

.audit-log__btn-toggle-detail {
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--glass-edge);
  color: #38bdf8;
  font-size: 0.75rem;
  cursor: pointer;
}

.audit-log__btn-toggle-detail:hover {
  background: rgba(56, 189, 248, 0.15);
}

.audit-log__entry-detail-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.audit-log__detail {
  font-family: monospace;
  font-size: 0.75rem;
  color: var(--colour-text-muted);
  overflow-wrap: anywhere;
  display: block;
}

.audit-log__expanded-payload {
  margin-top: 4px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
}

.audit-log__expanded-payload pre {
  margin: 0;
  font-family: monospace;
  font-size: 0.75rem;
  color: #e2e8f0;
  overflow-x: auto;
}

.audit-log__pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 0.75rem;
  border-top: 1px solid var(--glass-edge);
}

.audit-log__range {
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
}

.audit-log__pager-buttons {
  display: flex;
  gap: 8px;
}

.audit-log__pager-buttons button {
  padding: 6px 12px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--glass-edge);
  color: var(--colour-text-primary);
  font-size: 0.8125rem;
  cursor: pointer;
}

.audit-log__pager-buttons button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.audit-log__status,
.audit-log__error {
  margin: 0;
  font-size: 0.875rem;
}

.audit-log__error {
  color: #f87171;
}

.audit-log__empty {
  list-style: none;
}
</style>
