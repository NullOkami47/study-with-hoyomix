<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import type { AdminNotice, AdminNoticeInput, AdminRepository } from './client'
import NoticeEditor from './NoticeEditor.vue'
import AdminPageHeader from './primitives/AdminPageHeader.vue'
import AdminStatusChip from './primitives/AdminStatusChip.vue'
import AdminEmptyState from './primitives/AdminEmptyState.vue'
import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'

const props = defineProps<{
  repository: AdminRepository
}>()

const { locale } = usePreferences()

function t(key: string): string {
  return translate(locale.value, key as TranslationKey)
}

const repo = props.repository
const notices = ref<AdminNotice[]>([])
const loading = ref(true)
const editing = ref<AdminNotice | 'new' | null>(null)
const submitting = ref(false)
const errorMessage = ref('')
const activeTab = ref<'all' | 'published' | 'draft' | 'archived'>('all')

const DASH = '\u2014'

const sortedNotices = computed(() =>
  [...notices.value].sort((a, b) => b.updatedAt - a.updatedAt),
)

const filteredNotices = computed(() => {
  if (activeTab.value === 'all') return sortedNotices.value
  return sortedNotices.value.filter((n) => n.status === activeTab.value)
})

const editingNotice = computed<AdminNotice | null>(() =>
  editing.value === 'new' || editing.value === null ? null : editing.value,
)

function contentSnippet(notice: AdminNotice): string {
  const first = (['zh-Hant', 'zh-Hans', 'en'] as const)
    .map((locale) => notice.content?.[locale])
    .find((value) => typeof value === 'string' && value.length > 0)
  return first ?? DASH
}

function formatTimestamp(ms: number | null): string {
  if (ms === null) return DASH
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
}

function severityVariant(severity: string): 'info' | 'warning' | 'danger' {
  if (severity === 'critical') return 'danger'
  if (severity === 'warning') return 'warning'
  return 'info'
}

function statusVariant(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'published') return 'success'
  if (status === 'draft') return 'warning'
  return 'neutral'
}

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    notices.value = await repo.listNotices()
  } catch {
    errorMessage.value = t('admin.notices.loadError') || 'Failed to load notices.'
  } finally {
    loading.value = false
  }
}

async function onSubmit(input: AdminNoticeInput): Promise<void> {
  submitting.value = true
  errorMessage.value = ''
  try {
    if (editing.value === 'new') {
      await repo.createNotice(input)
    } else if (editing.value !== null) {
      await repo.patchNotice(editing.value.id, input)
    }
    editing.value = null
    await load()
  } catch {
    errorMessage.value = editing.value === 'new' ? (t('admin.notices.createError') || 'Failed to create notice.') : (t('admin.notices.saveError') || 'Failed to save notice.')
  } finally {
    submitting.value = false
  }
}

async function onPublish(id: string): Promise<void> {
  try {
    await repo.publishNotice(id)
    await load()
  } catch {
    errorMessage.value = t('admin.notices.publishError') || 'Failed to publish notice.'
  }
}

async function onArchive(id: string): Promise<void> {
  try {
    await repo.archiveNotice(id)
    await load()
  } catch {
    errorMessage.value = t('admin.notices.archiveError') || 'Failed to archive notice.'
  }
}

onMounted(load)
</script>

<template>
  <section class="notice-manager" data-notice-manager>
    <AdminPageHeader
      :title="t('admin.notices.title') || 'Notices'"
      :subtitle="t('admin.notices.subtitle') || 'Publish system maintenance banners and announcements.'"
    >
      <template #actions>
        <button
          v-if="editing === null"
          type="button"
          class="notice-manager__btn-new"
          data-notice-new
          @click="editing = 'new'"
        >
          <span>{{ t('admin.notices.new') || '+ New notice' }}</span>
        </button>
      </template>
    </AdminPageHeader>

    <p v-if="loading" class="notice-manager__status" role="status">{{ t('admin.notices.loading') || 'Loading notices...' }}</p>
    <p v-else-if="errorMessage && editing === null" class="notice-manager__error" role="alert">{{ errorMessage }}</p>

    <!-- Notice Editor Form -->
    <NoticeEditor
      v-if="editing !== null"
      :notice="editingNotice"
      :submitting="submitting"
      @submit="onSubmit"
      @cancel="editing = null"
    />

    <!-- Notice Management List -->
    <template v-if="!loading && editing === null">
      <!-- Status Tabs -->
      <div class="notice-manager__tabs">
        <button
          type="button"
          class="notice-manager__tab"
          :class="{ 'notice-manager__tab--active': activeTab === 'all' }"
          @click="activeTab = 'all'"
        >
          {{ t('admin.notices.tabs.all') || 'All' }} ({{ notices.length }})
        </button>
        <button
          type="button"
          class="notice-manager__tab"
          :class="{ 'notice-manager__tab--active': activeTab === 'published' }"
          @click="activeTab = 'published'"
        >
          {{ t('admin.notices.tabs.active') || 'Active' }} ({{ notices.filter(n => n.status === 'published').length }})
        </button>
        <button
          type="button"
          class="notice-manager__tab"
          :class="{ 'notice-manager__tab--active': activeTab === 'draft' }"
          @click="activeTab = 'draft'"
        >
          {{ t('admin.notices.tabs.draft') || 'Drafts' }} ({{ notices.filter(n => n.status === 'draft').length }})
        </button>
        <button
          type="button"
          class="notice-manager__tab"
          :class="{ 'notice-manager__tab--active': activeTab === 'archived' }"
          @click="activeTab = 'archived'"
        >
          {{ t('admin.notices.tabs.archived') || 'Archived' }} ({{ notices.filter(n => n.status === 'archived').length }})
        </button>
      </div>

      <ul class="notice-manager__list" data-notice-list>
        <li
          v-for="notice in filteredNotices"
          :key="notice.id"
          class="notice-manager__item"
          :data-notice-id="notice.id"
          :data-notice-status="notice.status"
          :data-notice-severity="notice.severity"
        >
          <div class="notice-manager__item-head">
            <div class="notice-manager__badges">
              <AdminStatusChip
                :variant="severityVariant(notice.severity)"
                size="sm"
              >
                <span class="notice-manager__severity" :data-notice-severity-badge="notice.severity">
                  {{ notice.severity }}
                </span>
              </AdminStatusChip>
              <AdminStatusChip
                :variant="statusVariant(notice.status)"
                size="sm"
              >
                <span class="notice-manager__status-text" :data-notice-status-badge="notice.status">
                  {{ notice.status }}
                </span>
              </AdminStatusChip>
              <span class="notice-manager__targeting">{{ notice.targeting }}</span>
            </div>
            <div class="notice-manager__actions">
              <button type="button" class="notice-manager__action-btn" data-notice-edit @click="editing = notice">
                {{ t('admin.catalogue.edit') || 'Edit' }}
              </button>
              <button
                v-if="notice.status === 'draft'"
                type="button"
                class="notice-manager__action-btn notice-manager__action-btn--publish"
                data-notice-publish
                @click="onPublish(notice.id)"
              >
                {{ t('admin.catalogue.publish') || 'Publish' }}
              </button>
              <button
                v-if="notice.status !== 'archived'"
                type="button"
                class="notice-manager__action-btn notice-manager__action-btn--archive"
                data-notice-archive
                @click="onArchive(notice.id)"
              >
                {{ t('admin.notices.archive') || 'Archive' }}
              </button>
            </div>
          </div>

          <p class="notice-manager__snippet" :data-notice-snippet="notice.id">
            {{ contentSnippet(notice) }}
          </p>

          <dl class="notice-manager__schedule">
            <div><dt>{{ t('admin.notices.starts') || 'Starts' }}</dt><dd>{{ formatTimestamp(notice.startAt) }}</dd></div>
            <div><dt>{{ t('admin.notices.ends') || 'Ends' }}</dt><dd>{{ formatTimestamp(notice.endAt) }}</dd></div>
            <div><dt>{{ t('admin.notices.updated') || 'Updated' }}</dt><dd>{{ formatTimestamp(notice.updatedAt) }}</dd></div>
          </dl>
        </li>

        <li v-if="filteredNotices.length === 0" class="notice-manager__empty">
          <AdminEmptyState
            :title="t('admin.notices.emptyTitle') || 'No notices found'"
            :message="t('admin.notices.emptyDesc') || 'No notices match the selected category tab.'"
            icon="📢"
          />
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.notice-manager {
  display: grid;
  gap: 1.25rem;
  min-width: 0;
  padding: 1.25rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
}

.notice-manager__btn-new {
  padding: 0.5rem 1rem;
  background: #2563eb;
  color: #ffffff;
  border: none;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.notice-manager__btn-new:hover {
  background: #1d4ed8;
}

.notice-manager__tabs {
  display: flex;
  gap: 6px;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--glass-edge);
  overflow-x: auto;
}

.notice-manager__tab {
  padding: 6px 12px;
  border-radius: 6px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--colour-text-muted);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.notice-manager__tab:hover {
  color: var(--colour-text-primary);
  background: rgba(255, 255, 255, 0.05);
}

.notice-manager__tab--active {
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.1);
  border-color: rgba(56, 189, 248, 0.25);
  font-weight: 600;
}

.notice-manager__list {
  display: grid;
  gap: 1rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.notice-manager__item {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1.125rem;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  transition: border-color 0.15s ease;
}

.notice-manager__item:hover {
  border-color: rgba(255, 255, 255, 0.14);
}

.notice-manager__item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.notice-manager__badges {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.notice-manager__targeting {
  font-size: 0.75rem;
  color: var(--colour-text-muted);
  text-transform: capitalize;
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 8px;
  border-radius: 4px;
}

.notice-manager__snippet {
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.5;
  color: var(--colour-text-primary);
}

.notice-manager__schedule {
  display: flex;
  flex-wrap: wrap;
  gap: 1.25rem;
  margin: 0;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  font-size: 0.75rem;
}

.notice-manager__schedule dt {
  color: var(--colour-text-muted);
}

.notice-manager__schedule dd {
  margin: 2px 0 0;
  color: var(--colour-text-primary);
  font-family: monospace;
}

.notice-manager__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.notice-manager__action-btn {
  padding: 5px 12px;
  border-radius: 6px;
  font-size: 0.8125rem;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--glass-edge);
  color: var(--colour-text-primary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.notice-manager__action-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.notice-manager__action-btn--publish {
  background: rgba(34, 197, 94, 0.15);
  border-color: rgba(34, 197, 94, 0.3);
  color: #4ade80;
}

.notice-manager__action-btn--publish:hover {
  background: rgba(34, 197, 94, 0.25);
}

.notice-manager__action-btn--archive {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.25);
  color: #f87171;
}

.notice-manager__action-btn--archive:hover {
  background: rgba(239, 68, 68, 0.2);
}

.notice-manager__empty {
  list-style: none;
}

.notice-manager__status,
.notice-manager__error {
  margin: 0;
  font-size: 0.875rem;
}

.notice-manager__error {
  color: #f87171;
}

/* Badge hook preservation */
.notice-manager__severity[data-notice-severity-badge="critical"] { color: #f87171; }
.notice-manager__severity[data-notice-severity-badge="warning"] { color: #fbbf24; }
.notice-manager__severity[data-notice-severity-badge="info"] { color: #4ade80; }
</style>
