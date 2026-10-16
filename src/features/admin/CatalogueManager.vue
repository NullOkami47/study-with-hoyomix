<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { ExternalLink, RefreshCw, Upload, Check, AlertTriangle, Pencil, Save, X, Eye } from 'lucide-vue-next'
import type { AdminRepository, CatalogueStatus, ImportBatch, ChangeKind, Proposal } from './client'
import AdminFieldDiff from './primitives/AdminFieldDiff.vue'
import AdminStatusChip from './primitives/AdminStatusChip.vue'
import CatalogueTrackBrowser from './CatalogueTrackBrowser.vue'
import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'
import { ALLOWED_STRUCTURAL_FIELDS } from './catalogueSchema'

const props = defineProps<{ repository: AdminRepository }>()
const { locale } = usePreferences()
const text = (key: string, params?: Record<string, unknown>) => translate(locale.value, ('admin.catalogue.' + key) as TranslationKey, params)

const status = ref<CatalogueStatus>()
const batch = ref<ImportBatch | null>(null)
const busy = ref(false)
const loaded = ref(false)
const error = ref(false)
const exportConfirm = ref(false)
const exported = ref(false)
const filter = ref('all')
/**
 * The Sheet proposal pipeline only ever shows *deltas*; browsing and correcting the published
 * catalogue is a separate job, so it gets its own view and is the default one. The choice is
 * persisted so a reload (or an edit round-trip) does not drop the admin back to Tracks.
 */
const VIEW_STORAGE_KEY = 'study-with-hoyomix.admin-catalogue-view.v1'
const readStoredView = (): 'tracks' | 'review' => {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'review' ? 'review' : 'tracks'
  } catch {
    return 'tracks'
  }
}
const view = ref<'tracks' | 'review'>(readStoredView())
watch(view, (value) => {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, value)
  } catch {
    // Storage unavailable: the view simply does not persist.
  }
})
const editor = ref<{
  changeId: string
  batchId: string
  reviewRevision: number
  json: string
  entityType?: string
  kind?: string
}>()
const editError = ref(false)
const editorMode = ref<'form' | 'raw'>('form')
const rawDiffsVisible = ref<Record<string, boolean>>({})
const numericErrors = ref<Record<string, string>>({})

let alive = true

const categories: ChangeKind[] = [
  'new_track',
  'metadata_change',
  'classification_change',
  'new_source',
  'source_change',
  'new_alias',
  'conflict',
  'validation_error',
]

const terminal = computed(
  () => !batch.value || ['published', 'rejected'].includes(batch.value.status),
)

const blockers = computed(
  () =>
    batch.value?.changes.filter((c) => c.validationState !== 'valid' && c.decision !== 'rejected')
      .length ?? 0,
)

const approved = computed(
  () => batch.value?.changes.filter((c) => c.decision === 'approved').length ?? 0,
)

const rows = computed(() =>
  [...(batch.value?.changes ?? [])]
    .filter((c) => filter.value === 'all' || c.kind === filter.value)
    .sort((a, b) => Number(b.validationState !== 'valid') - Number(a.validationState !== 'valid')),
)

const sheetUrl = computed(() => {
  try {
    const url = new URL(status.value?.sheetUrl ?? '')
    return url.protocol === 'https:' &&
      url.hostname === 'docs.google.com' &&
      /^\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : undefined
  } catch {
    return undefined
  }
})

type FieldType = 'string' | 'number' | 'boolean' | 'null' | 'preserved'

interface FormField {
  key: string
  label: string
  type: FieldType
  value: unknown
  isPreserved: boolean
}

const editableFields = computed<FormField[]>(() => {
  if (!editor.value) return []
  try {
    const obj = JSON.parse(editor.value.json)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return []
    const entityType = editor.value.entityType ?? 'track'
    const allowed = ALLOWED_STRUCTURAL_FIELDS[entityType] ?? new Set()

    return Object.keys(obj).map((key) => {
      const val = obj[key]
      const isAllowed = allowed.has(key)
      const isComplex = val !== null && typeof val === 'object'

      let type: FieldType = 'string'
      let isPreserved = false

      if (!isAllowed || isComplex) {
        type = 'preserved'
        isPreserved = true
      } else if (typeof val === 'boolean') {
        type = 'boolean'
      } else if (typeof val === 'number') {
        type = 'number'
      } else if (val === null) {
        type = 'null'
      } else {
        type = 'string'
      }

      return {
        key,
        label: formatFieldLabel(key),
        type,
        value: val,
        isPreserved,
      }
    })
  } catch {
    return []
  }
})

const hasEditableScalarFields = computed(() => {
  return editableFields.value.some((f) => !f.isPreserved)
})

const hasNumericErrors = computed(() => {
  return Object.keys(numericErrors.value).length > 0
})

function formatFieldLabel(key: string): string {
  const trans = text(('field.' + key) as TranslationKey)
  if (trans && !trans.startsWith('admin.catalogue.')) return trans
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())
}

function formatPreservedSummary(val: unknown): string {
  if (Array.isArray(val)) {
    return text('complexSummaryArray', { n: val.length }) || `Array (${val.length} items)`
  }
  if (val && typeof val === 'object') {
    const keys = Object.keys(val)
    return text('complexSummaryObject', { n: keys.length }) || `Object (${keys.length} keys)`
  }
  if (typeof val === 'boolean') {
    return text('complexSummaryBoolean', { val: String(val) }) || `Boolean (${val})`
  }
  if (typeof val === 'number') {
    return text('complexSummaryNumber', { val: String(val) }) || `Number (${val})`
  }
  if (typeof val === 'string') {
    return text('complexSummaryString', { val }) || `String ("${val}")`
  }
  return text('complexSummaryDefault') || 'Custom data'
}

function parseCurrentJson(): Record<string, unknown> | null {
  if (!editor.value) return null
  try {
    const obj = JSON.parse(editor.value.json)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function updateStringField(key: string, newValue: string): void {
  const obj = parseCurrentJson()
  if (!obj || !editor.value) return
  obj[key] = newValue
  editor.value.json = JSON.stringify(obj, null, 2)
}

function updateNumberField(key: string, newValue: string): void {
  const obj = parseCurrentJson()
  if (!obj || !editor.value) return
  const trimmed = newValue.trim()
  if (trimmed === '') {
    numericErrors.value[key] = text('numericRequired') || 'Numeric value is required'
    return
  }
  const num = Number(trimmed)
  if (Number.isNaN(num)) {
    numericErrors.value[key] = text('numericRequired') || 'Numeric value is required'
    return
  }
  delete numericErrors.value[key]
  obj[key] = num
  editor.value.json = JSON.stringify(obj, null, 2)
}

function updateBooleanField(key: string, checked: boolean): void {
  const obj = parseCurrentJson()
  if (!obj || !editor.value) return
  obj[key] = checked
  editor.value.json = JSON.stringify(obj, null, 2)
}

function updateNullableField(key: string, newValue: string): void {
  const obj = parseCurrentJson()
  if (!obj || !editor.value) return
  obj[key] = newValue.trim() === '' ? null : newValue
  editor.value.json = JSON.stringify(obj, null, 2)
}

function toggleRawDiff(changeId: string) {
  rawDiffsVisible.value = {
    ...rawDiffsVisible.value,
    [changeId]: !rawDiffsVisible.value[changeId],
  }
}

async function perform(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = false
  try {
    await action()
  } catch {
    if (alive) error.value = true
  } finally {
    if (alive) busy.value = false
  }
}

async function update(action: () => Promise<ImportBatch>) {
  await perform(async () => {
    const value = await action()
    if (alive) batch.value = value
  })
}

async function load() {
  await perform(async () => {
    const value = await props.repository.getCatalogueStatus()
    if (alive) {
      status.value = value
      batch.value = value.lastBatch
      loaded.value = true
    }
  })
}

async function exportSheet() {
  exportConfirm.value = false
  await perform(async () => {
    await props.repository.exportCatalogueSheet()
    if (alive) exported.value = true
  })
}

async function startEdit(change: Proposal) {
  if (busy.value || terminal.value || editor.value || !change.after || !batch.value) return
  error.value = false
  editError.value = false
  numericErrors.value = {}
  const isPlainObj = typeof change.after === 'object' && change.after !== null && !Array.isArray(change.after)
  editorMode.value = isPlainObj ? 'form' : 'raw'
  editor.value = {
    changeId: change.changeId,
    batchId: batch.value.batchId,
    reviewRevision: batch.value.reviewRevision,
    json: format(change.after),
    entityType: change.entityType,
    kind: change.kind,
  }
  await nextTick()
  if (editorMode.value === 'form') {
    const firstInput = document.querySelector<HTMLElement>(
      '.catalogue-manager__form-grid input:not([disabled]), .catalogue-manager__form-grid select:not([disabled])',
    )
    if (firstInput) {
      firstInput.focus()
      return
    }
  }
  document.getElementById('catalogue-proposal-after')?.focus()
}

async function setEditorMode(mode: 'form' | 'raw') {
  editorMode.value = mode
  await nextTick()
  if (mode === 'raw') {
    document.getElementById('catalogue-proposal-after')?.focus()
  } else {
    const firstInput = document.querySelector<HTMLElement>(
      '.catalogue-manager__form-grid input:not([disabled]), .catalogue-manager__form-grid select:not([disabled])',
    )
    firstInput?.focus()
  }
}

async function closeEditor() {
  const changeId = editor.value?.changeId
  editor.value = undefined
  editError.value = false
  numericErrors.value = {}
  await nextTick()
  if (alive) document.getElementById('catalogue-edit-' + changeId)?.focus()
}

async function saveEdit() {
  if (!editor.value || busy.value || terminal.value) return
  if (editorMode.value === 'form' && hasNumericErrors.value) return
  const current = editor.value
  editError.value = false
  await perform(async () => {
    let after: unknown
    try {
      after = JSON.parse(current.json)
      if (!after || typeof after !== 'object' || Array.isArray(after)) throw new Error()
    } catch {
      editError.value = true
      return
    }
    const value = await props.repository.editCatalogueChange(
      current.batchId,
      current.changeId,
      after as Record<string, unknown>,
      current.reviewRevision,
    )
    if (alive) {
      batch.value = value
      await closeEditor()
    }
  })
}

function canOwnerApproveR2(change: Proposal): boolean {
  return status.value?.role === 'owner' &&
    change.entityType === 'source' &&
    change.decision === 'pending' &&
    change.validationState === 'error' &&
    change.messages.length === 1 &&
    change.messages[0] === 'r2_owner_verification_required' &&
    change.after?.provider === 'r2' &&
    typeof change.after.evidence === 'string' &&
    change.after.evidence.trim().length > 0
}

const format = (value: unknown) => JSON.stringify(value, null, 2)

onMounted(() => void load())
onBeforeUnmount(() => {
  alive = false
})
</script>

<template>
  <div class="catalogue-manager" data-catalogue-manager :aria-busy="busy">
    <header class="catalogue-manager__header">
      <div>
        <h2>{{ text('title') }}</h2>
        <p>{{ text('subtitle') }}</p>
      </div>
      <span class="catalogue-manager__stage">{{ text('staging') }}</span>
    </header>

    <nav class="catalogue-manager__views" :aria-label="text('title')">
      <button
        type="button"
        data-catalogue-view="tracks"
        :class="{ 'catalogue-manager__view--active': view === 'tracks' }"
        :aria-pressed="view === 'tracks'"
        @click="view = 'tracks'"
      >
        {{ text('viewTracks') }}
      </button>
      <button
        type="button"
        data-catalogue-view="review"
        :class="{ 'catalogue-manager__view--active': view === 'review' }"
        :aria-pressed="view === 'review'"
        @click="view = 'review'"
      >
        {{ text('viewReview') }}
      </button>
    </nav>

    <CatalogueTrackBrowser v-if="view === 'tracks'" :repository="repository" />

    <template v-else>
    <!-- Lifecycle Pipeline Stepper -->
    <nav :aria-label="text('reviewPipeline') || 'Catalogue review pipeline'" class="catalogue-manager__stepper" tabindex="0">
      <div class="catalogue-manager__step catalogue-manager__step--complete">
        <span class="catalogue-manager__step-num">1</span>
        <span class="catalogue-manager__step-text">{{ text('step1') || '1. Google Sheet' }}</span>
      </div>
      <span class="catalogue-manager__step-sep" aria-hidden="true">&rarr;</span>
      <div
        class="catalogue-manager__step"
        :class="{
          'catalogue-manager__step--active': batch?.status === 'draft',
          'catalogue-manager__step--complete': batch && batch.status !== 'draft'
        }"
      >
        <span class="catalogue-manager__step-num">2</span>
        <span class="catalogue-manager__step-text">{{ text('step2') || '2. Pull & Validate' }}</span>
      </div>
      <span class="catalogue-manager__step-sep" aria-hidden="true">&rarr;</span>
      <div
        class="catalogue-manager__step"
        :class="{
          'catalogue-manager__step--active': batch?.status === 'validated',
          'catalogue-manager__step--complete': batch?.status === 'published'
        }"
      >
        <span class="catalogue-manager__step-num">3</span>
        <span class="catalogue-manager__step-text">{{ text('step3') || '3. Review Diffs' }}</span>
      </div>
      <span class="catalogue-manager__step-sep" aria-hidden="true">&rarr;</span>
      <div
        class="catalogue-manager__step"
        :class="{ 'catalogue-manager__step--complete': batch?.status === 'published' }"
      >
        <span class="catalogue-manager__step-num">4</span>
        <span class="catalogue-manager__step-text">{{ text('step4') || '4. Publish' }}</span>
      </div>
    </nav>

    <p v-if="error" class="catalogue-manager__error-banner" role="alert">{{ text('error') }}</p>
    <p v-if="!loaded && !error" class="catalogue-manager__loading-state" role="status">{{ text('loading') }}</p>
    <p v-if="loaded && !status?.configured" class="catalogue-manager__notice">
      {{ text('notConfigured') }}
    </p>

    <div class="catalogue-manager__toolbar">
      <a
        v-if="sheetUrl"
        :href="sheetUrl"
        target="_blank"
        rel="noopener noreferrer"
        data-catalogue-sheet
      >
        <ExternalLink :size="16" aria-hidden="true" />
        <span>{{ text('sheet') }}</span>
      </a>
      <button
        type="button"
        :disabled="busy || !!editor || !status?.configured"
        data-catalogue-sync
        @click="update(() => repository.syncCatalogue())"
      >
        <RefreshCw :size="16" aria-hidden="true" />
        <span>{{ text('sync') }}</span>
      </button>
      <button
        type="button"
        :disabled="busy || !!editor || !status?.configured"
        data-catalogue-export
        @click="exportConfirm = !exportConfirm"
      >
        <Upload :size="16" aria-hidden="true" />
        <span>{{ text('export') }}</span>
      </button>
    </div>

    <p v-if="status?.serviceAccountEmail" class="catalogue-manager__connection">
      {{ status.serviceAccountEmail }}
    </p>

    <div v-if="exportConfirm" class="catalogue-manager__notice catalogue-manager__notice--warning">
      <p>{{ text('exportWarning') }}</p>
      <div class="catalogue-manager__toolbar">
        <button type="button" data-catalogue-export-confirm :disabled="busy || !!editor" @click="exportSheet">
          {{ text('exportConfirm') }}
        </button>
        <button type="button" @click="exportConfirm = false">{{ text('cancel') }}</button>
      </div>
    </div>
    <p v-if="exported" class="catalogue-manager__success-notice" role="status">{{ text('exported') }}</p>

    <template v-if="batch">
      <dl class="catalogue-manager__batch">
        <div>
          <dt>{{ text('status') }}</dt>
          <dd>
            <AdminStatusChip
              :variant="batch.status === 'published' ? 'success' : batch.status === 'rejected' ? 'danger' : 'warning'"
              size="sm"
            >
              {{ text(batch.status) }}
            </AdminStatusChip>
          </dd>
        </div>
        <div>
          <dt>{{ text('lastSync') }}</dt>
          <dd>
            {{ new Date(batch.updatedAt).toLocaleString(locale === 'en' ? 'en-GB' : locale) }}
          </dd>
        </div>
      </dl>

      <section :aria-label="text('summary')" class="catalogue-manager__summary">
        <div v-for="category in categories" :key="category" :data-catalogue-summary="category">
          <strong>{{ batch.summary[category] ?? 0 }}</strong>
          <span>{{ text(category) }}</span>
        </div>
      </section>

      <p v-if="blockers" class="catalogue-manager__notice catalogue-manager__notice--blocker" data-catalogue-blocking>
        <AlertTriangle :size="18" aria-hidden="true" />
        <span>{{ text('blocking') }} ({{ blockers }})</span>
      </p>

      <div class="catalogue-manager__toolbar catalogue-manager__review-actions">
        <label class="catalogue-manager__filter-group">
          <span>{{ text('filter') }}</span>
          <select v-model="filter" data-catalogue-filter :disabled="busy || !!editor">
            <option value="all">{{ text('all') }}</option>
            <option v-for="category in categories" :key="category" :value="category">
              {{ text(category) }}
            </option>
          </select>
        </label>
        <button
          type="button"
          :disabled="busy || terminal || !!editor"
          data-catalogue-bulk
          @click="update(() => repository.approveCatalogueHighConfidence(batch!.batchId, batch!.reviewRevision))"
        >
          <Check :size="16" aria-hidden="true" />
          <span>{{ text('bulk') }}</span>
        </button>
        <button
          type="button"
          class="catalogue-manager__publish"
          :disabled="busy || terminal || !!editor || blockers > 0 || approved === 0"
          data-catalogue-publish
          @click="update(() => repository.publishCatalogueBatch(batch!.batchId, batch!.reviewRevision))"
        >
          {{ text('publish') }} ({{ approved }})
        </button>
      </div>

      <p v-if="!rows.length" class="catalogue-manager__empty-diffs">{{ text('noChanges') }}</p>

      <ol class="catalogue-manager__changes">
        <li
          v-for="change in rows"
          :key="change.changeId"
          :data-catalogue-change="change.changeId"
          class="catalogue-manager__change-card"
          :class="{ 'catalogue-manager__change--issue': change.validationState !== 'valid' }"
        >
          <header class="catalogue-manager__change-header">
            <div class="catalogue-manager__change-title">
              <h3>{{ text(change.kind) }}</h3>
              <code class="catalogue-manager__entity-key">{{ change.entityKey }}</code>
            </div>
            <AdminStatusChip
              :variant="change.decision === 'approved' ? 'success' : change.decision === 'rejected' ? 'danger' : 'neutral'"
              size="sm"
            >
              {{ text(change.decision) }}
            </AdminStatusChip>
          </header>

          <ul v-if="change.messages.length" class="catalogue-manager__messages">
            <li v-for="message in change.messages" :key="message" class="catalogue-manager__message-item">
              <AlertTriangle :size="14" aria-hidden="true" />
              <span>{{ message }}</span>
            </li>
          </ul>

          <!-- Human-Readable Field Diff & Raw Fallback -->
          <div v-if="change.before || change.after" class="catalogue-manager__diff-container">
            <AdminFieldDiff
              :before="change.before as Record<string, any>"
              :after="change.after as Record<string, any>"
            />

            <!-- Power user toggle for raw json comparison -->
            <div class="catalogue-manager__raw-toggle-wrap">
              <button
                type="button"
                class="catalogue-manager__raw-toggle-btn"
                @click="toggleRawDiff(change.changeId)"
              >
                <Eye :size="14" aria-hidden="true" />
                <span>{{ rawDiffsVisible[change.changeId] ? (text('hideRaw') || 'Hide raw JSON') : (text('inspectRaw') || 'Inspect raw JSON') }}</span>
              </button>
            </div>

            <div
              v-show="rawDiffsVisible[change.changeId]"
              class="catalogue-manager__diff"
            >
              <div>
                <h4>{{ text('before') }}</h4>
                <pre>{{ format(change.before) }}</pre>
              </div>
              <div>
                <h4>{{ text('after') }}</h4>
                <pre>{{ format(change.after) }}</pre>
              </div>
            </div>
          </div>

          <!-- Structured & Raw Proposal Editor -->
          <form
            v-if="editor?.changeId === change.changeId"
            class="catalogue-manager__editor"
            data-catalogue-edit-form
            @submit.prevent="saveEdit"
          >
            <div class="catalogue-manager__editor-nav">
              <span class="catalogue-manager__editor-title">{{ text('edit') }}</span>
              <div class="catalogue-manager__editor-mode-switch">
                <button
                  type="button"
                  class="catalogue-manager__mode-btn"
                  :class="{ 'catalogue-manager__mode-btn--active': editorMode === 'form' }"
                  @click="setEditorMode('form')"
                >
                  {{ text('structuredEditor') || 'Form Editor' }}
                </button>
                <button
                  type="button"
                  class="catalogue-manager__mode-btn"
                  :class="{ 'catalogue-manager__mode-btn--active': editorMode === 'raw' }"
                  @click="setEditorMode('raw')"
                >
                  {{ text('rawJsonEditor') || 'Raw JSON' }}
                </button>
              </div>
            </div>

            <!-- Structured form view -->
            <div v-show="editorMode === 'form'" class="catalogue-manager__form-grid">
              <div v-if="!hasEditableScalarFields" class="catalogue-manager__form-notice">
                <p>{{ text('complexFieldsOnly') || 'This item contains complex structures best edited in Raw JSON mode.' }}</p>
                <button type="button" class="catalogue-manager__mode-btn" @click="editorMode = 'raw'">
                  {{ text('switchRawJson') || 'Switch to Raw JSON' }}
                </button>
              </div>

              <div
                v-for="field in editableFields"
                :key="field.key"
                class="catalogue-manager__form-group"
                :class="{ 'catalogue-manager__form-group--checkbox': field.type === 'boolean' }"
              >
                <!-- Boolean field: Checkbox -->
                <template v-if="field.type === 'boolean'">
                  <label class="catalogue-manager__checkbox-label">
                    <input
                      :id="`catalogue-field-${field.key}`"
                      type="checkbox"
                      :checked="Boolean(field.value)"
                      :disabled="busy"
                      @change="updateBooleanField(field.key, ($event.target as HTMLInputElement).checked)"
                    />
                    <span>{{ field.label }}</span>
                  </label>
                </template>

                <!-- Number field: type="number" -->
                <template v-else-if="field.type === 'number'">
                  <label :for="`catalogue-field-${field.key}`">{{ field.label }}</label>
                  <input
                    :id="`catalogue-field-${field.key}`"
                    type="number"
                    step="any"
                    :value="field.value"
                    :disabled="busy"
                    :aria-invalid="Boolean(numericErrors[field.key]) || undefined"
                    @input="updateNumberField(field.key, ($event.target as HTMLInputElement).value)"
                  />
                  <span
                    v-if="numericErrors[field.key]"
                    class="catalogue-manager__field-error"
                    :data-catalogue-field-error="field.key"
                    role="alert"
                  >
                    {{ numericErrors[field.key] }}
                  </span>
                </template>

                <!-- Nullable field: null originally -->
                <template v-else-if="field.type === 'null'">
                  <label :for="`catalogue-field-${field.key}`">
                    {{ field.label }}
                    <span class="catalogue-manager__null-tag">(null)</span>
                  </label>
                  <input
                    :id="`catalogue-field-${field.key}`"
                    type="text"
                    :value="field.value ?? ''"
                    placeholder="null"
                    :disabled="busy"
                    @input="updateNullableField(field.key, ($event.target as HTMLInputElement).value)"
                  />
                </template>

                <!-- Preserved field: unknown scalar, array, or object -->
                <template v-else-if="field.isPreserved">
                  <label>{{ field.label }}</label>
                  <div
                    class="catalogue-manager__complex-badge"
                    :data-catalogue-preserved-field="field.key"
                    :data-catalogue-complex-field="field.key"
                  >
                    <span class="catalogue-manager__complex-summary">{{ formatPreservedSummary(field.value) }}</span>
                    <span class="catalogue-manager__complex-hint">{{ text('preservedHint') || 'Preserved — switch to Raw JSON to edit' }}</span>
                  </div>
                </template>

                <!-- String / Default field -->
                <template v-else>
                  <label :for="`catalogue-field-${field.key}`">{{ field.label }}</label>
                  <input
                    :id="`catalogue-field-${field.key}`"
                    type="text"
                    :value="field.value"
                    :disabled="busy"
                    @input="updateStringField(field.key, ($event.target as HTMLInputElement).value)"
                  />
                </template>
              </div>
            </div>

            <!-- Raw JSON Textarea (Always rendered so data-catalogue-edit-after & id exist) -->
            <div
              class="catalogue-manager__textarea-wrap"
              :class="{ 'catalogue-manager__textarea-wrap--hidden': editorMode === 'form' }"
            >
              <label for="catalogue-proposal-after">{{ text('editFields') }}</label>
              <textarea
                id="catalogue-proposal-after"
                v-model="editor.json"
                data-catalogue-edit-after
                rows="10"
                :disabled="busy"
                :aria-invalid="editError || undefined"
                spellcheck="false"
              />
            </div>

            <p v-if="editError" class="catalogue-manager__edit-error" role="alert">{{ text('invalidEdit') }}</p>
            <div class="catalogue-manager__toolbar">
              <button type="submit" data-catalogue-edit-save :disabled="busy || (editorMode === 'form' && hasNumericErrors)">
                <Save :size="16" aria-hidden="true" />
                <span>{{ text('saveEdit') }}</span>
              </button>
              <button type="button" data-catalogue-edit-cancel :disabled="busy" @click="closeEditor">
                <X :size="16" aria-hidden="true" />
                <span>{{ text('cancel') }}</span>
              </button>
            </div>
          </form>

          <footer class="catalogue-manager__change-footer">
            <span class="catalogue-manager__confidence">
              {{ text('confidence') }}:
              <strong>{{ change.confidence === null ? '—' : Math.round(change.confidence * 100) + '%' }}</strong>
            </span>
            <div class="catalogue-manager__toolbar">
              <button
                v-if="!terminal && change.after && change.entityType !== 'validation'"
                :id="'catalogue-edit-' + change.changeId"
                type="button"
                :disabled="busy || !!editor"
                :data-catalogue-edit="change.changeId"
                :aria-label="text('edit') + ' ' + change.entityKey"
                @click="startEdit(change)"
              >
                <Pencil :size="16" aria-hidden="true" />
                <span>{{ text('edit') }}</span>
              </button>
              <button
                v-if="change.validationState === 'valid'"
                type="button"
                :disabled="busy || terminal || !!editor || change.decision === 'approved'"
                :data-catalogue-accept="change.changeId"
                :aria-label="text('accept') + ' ' + change.entityKey"
                @click="
                  update(() =>
                    repository.decideCatalogueChange(
                      batch!.batchId, change.changeId, 'approved', batch!.reviewRevision,
                    ),
                  )
                "
              >
                {{ text('accept') }}
              </button>
              <button
                v-if="canOwnerApproveR2(change)"
                type="button"
                class="catalogue-manager__r2-approve-btn"
                :disabled="busy || terminal || !!editor"
                :data-catalogue-r2-owner-approve="change.changeId"
                :aria-label="text('ownerApproveR2') + ' ' + change.entityKey"
                @click="update(() => repository.approveCatalogueR2AsOwner(
                  batch!.batchId, change.changeId, batch!.reviewRevision,
                ))"
              >
                {{ text('ownerApproveR2') }}
              </button>
              <button
                type="button"
                :disabled="busy || terminal || !!editor || change.decision === 'rejected'"
                :data-catalogue-reject="change.changeId"
                :aria-label="text('reject') + ' ' + change.entityKey"
                @click="
                  update(() =>
                    repository.decideCatalogueChange(
                      batch!.batchId, change.changeId, 'rejected', batch!.reviewRevision,
                    ),
                  )
                "
              >
                {{ text('reject') }}
              </button>
            </div>
          </footer>
        </li>
      </ol>
    </template>
    <p v-else-if="loaded" class="catalogue-manager__empty">{{ text('empty') }}</p>
    </template>
  </div>
</template>

<style scoped>
.catalogue-manager {
  display: grid;
  gap: 1.25rem;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  color: var(--colour-text-primary);
}

h2, h3, h4, p {
  margin: 0;
}

h2 {
  font-size: 1.5rem;
  font-weight: 700;
}

h3 {
  font-size: 1rem;
  font-weight: 600;
}

h4 {
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
  margin-bottom: 4px;
}

.catalogue-manager__header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  min-width: 0;
  max-width: 100%;
}

.catalogue-manager__header p,
.catalogue-manager__connection {
  color: var(--colour-text-muted);
  margin-top: 0.5rem;
  overflow-wrap: anywhere;
  font-size: 0.875rem;
}

.catalogue-manager__stage {
  color: #38bdf8;
  font-size: 0.875rem;
  font-weight: 600;
  padding: 4px 10px;
  background: rgba(56, 189, 248, 0.1);
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 9999px;
}

.catalogue-manager .catalogue-manager__views {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.catalogue-manager .catalogue-manager__views button {
  min-height: 2.25rem;
  padding: 0.375rem 0.875rem;
  border: 1px solid var(--glass-edge);
  border-radius: 9999px;
  background: var(--colour-surface-opaque);
  color: var(--colour-text-muted);
  font-size: 0.8125rem;
}

.catalogue-manager .catalogue-manager__views button.catalogue-manager__view--active {
  color: #38bdf8;
  border-color: rgba(56, 189, 248, 0.4);
  background: rgba(56, 189, 248, 0.1);
  font-weight: 600;
}

/* Stepper */
.catalogue-manager__stepper {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: var(--colour-surface-opaque);
  border: 1px solid var(--glass-edge);
  border-radius: 10px;
  overflow-x: auto;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

.catalogue-manager__step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
  white-space: nowrap;
}

.catalogue-manager__step-num {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.75rem;
}

.catalogue-manager__step--active {
  color: #38bdf8;
  font-weight: 600;
}

.catalogue-manager__step--active .catalogue-manager__step-num {
  background: #0284c7;
  color: #ffffff;
}

.catalogue-manager__step--complete {
  color: #4ade80;
}

.catalogue-manager__step--complete .catalogue-manager__step-num {
  background: #16a34a;
  color: #ffffff;
}

.catalogue-manager__step-sep {
  color: var(--colour-text-muted);
  opacity: 0.4;
}

.catalogue-manager__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
}

.catalogue-manager button,
.catalogue-manager a,
.catalogue-manager select,
.catalogue-manager textarea,
.catalogue-manager input[type="text"],
.catalogue-manager input[type="number"] {
  min-height: 2.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--glass-edge);
  border-radius: 0.5rem;
  background: var(--colour-surface-opaque);
  color: var(--colour-text-primary);
  font: inherit;
  font-size: 0.875rem;
  box-sizing: border-box;
  max-width: 100%;
}

.catalogue-manager button,
.catalogue-manager a {
  display: inline-flex;
  gap: 0.5rem;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  text-decoration: none;
  font-weight: 500;
  transition: all 0.15s ease;
}

.catalogue-manager button:hover:not(:disabled),
.catalogue-manager a:hover {
  border-color: var(--colour-accent);
  background: rgba(255, 255, 255, 0.08);
}

.catalogue-manager button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.catalogue-manager button.catalogue-manager__publish {
  color: #38bdf8;
  border-color: rgba(56, 189, 248, 0.4);
  background: rgba(56, 189, 248, 0.1);
  font-weight: 600;
}

.catalogue-manager button.catalogue-manager__r2-approve-btn {
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.1);
  font-weight: 600;
}

.catalogue-manager__batch {
  display: flex;
  flex-wrap: wrap;
  gap: 2rem;
  margin: 0;
}

dt {
  color: var(--colour-text-muted);
  font-size: 0.8125rem;
}

dd {
  margin: 0.25rem 0 0;
  font-weight: 600;
}

.catalogue-manager__summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
  gap: 0.75rem;
}

.catalogue-manager__summary > div {
  background: var(--colour-surface-opaque);
  border: 1px solid var(--glass-edge);
  border-radius: 0.75rem;
  padding: 0.875rem 1rem;
  display: grid;
  gap: 0.25rem;
}

.catalogue-manager__summary strong {
  font-size: 1.5rem;
  font-weight: 700;
}

.catalogue-manager__summary span {
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
}

.catalogue-manager__notice {
  padding: 1rem;
  border-radius: 0.5rem;
  background: var(--colour-surface-opaque);
  border: 1px solid var(--glass-edge);
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.catalogue-manager__notice--warning {
  border-color: rgba(234, 179, 8, 0.4);
  background: rgba(234, 179, 8, 0.08);
}

.catalogue-manager__notice--blocker {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.08);
  color: #f87171;
  font-weight: 500;
}

.catalogue-manager__filter-group {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  color: var(--colour-text-muted);
}

.catalogue-manager__changes {
  display: grid;
  gap: 1rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.catalogue-manager__change-card {
  padding: 1.25rem;
  border-radius: 0.75rem;
  background: var(--colour-surface-opaque);
  border: 1px solid var(--glass-edge);
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

.catalogue-manager__change--issue {
  border-color: rgba(239, 68, 68, 0.4);
  box-shadow: 0 0 0 1px rgba(239, 68, 68, 0.15);
}

.catalogue-manager__change-header,
.catalogue-manager__change-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
}

.catalogue-manager__change-title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.catalogue-manager__entity-key {
  font-size: 0.8125rem;
  color: #38bdf8;
  background: rgba(56, 189, 248, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
}

.catalogue-manager__messages {
  display: grid;
  gap: 0.375rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.catalogue-manager__message-item {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #f87171;
  font-size: 0.8125rem;
}

.catalogue-manager__diff-container {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.catalogue-manager__raw-toggle-wrap {
  display: flex;
  justify-content: flex-end;
}

.catalogue-manager__raw-toggle-btn {
  background: none !important;
  border: none !important;
  padding: 2px 6px !important;
  min-height: auto !important;
  font-size: 0.75rem !important;
  color: var(--colour-text-muted) !important;
  cursor: pointer;
}

.catalogue-manager__raw-toggle-btn:hover {
  color: var(--colour-text-primary) !important;
  text-decoration: underline;
}

.catalogue-manager__diff {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  padding: 0.75rem;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 8px;
}

.catalogue-manager__diff pre {
  margin: 0;
  font-size: 0.75rem;
  overflow-x: auto;
  color: #94a3b8;
}

/* Structured Editor */
.catalogue-manager__editor {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}

.catalogue-manager__editor-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.catalogue-manager__editor-title {
  font-size: 0.875rem;
  font-weight: 600;
}

.catalogue-manager__editor-mode-switch {
  display: flex;
  gap: 4px;
  background: rgba(255, 255, 255, 0.05);
  padding: 2px;
  border-radius: 6px;
}

.catalogue-manager__mode-btn {
  min-height: auto !important;
  padding: 3px 8px !important;
  font-size: 0.75rem !important;
  border: none !important;
  background: transparent !important;
  color: var(--colour-text-muted) !important;
  border-radius: 4px !important;
}

.catalogue-manager__mode-btn--active {
  background: rgba(255, 255, 255, 0.15) !important;
  color: #ffffff !important;
  font-weight: 600 !important;
}

.catalogue-manager__form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr));
  gap: 0.75rem;
  min-width: 0;
  max-width: 100%;
}

.catalogue-manager__form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.catalogue-manager__form-group--checkbox {
  justify-content: flex-end;
}

.catalogue-manager__checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  cursor: pointer;
  padding-top: 1.25rem;
}

.catalogue-manager__checkbox-label input[type="checkbox"] {
  width: 1.125rem;
  height: 1.125rem;
  cursor: pointer;
  accent-color: var(--colour-accent);
}

.catalogue-manager__null-tag {
  color: var(--colour-text-muted);
  font-style: italic;
  font-size: 0.75rem;
}

.catalogue-manager__complex-badge {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px dashed rgba(255, 255, 255, 0.15);
  border-radius: 6px;
}

.catalogue-manager__complex-summary {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--colour-text-primary);
}

.catalogue-manager__complex-hint {
  font-size: 0.75rem;
  color: var(--colour-text-muted);
}

.catalogue-manager__form-notice {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.75rem 1rem;
  background: rgba(59, 130, 246, 0.1);
  border: 1px solid rgba(59, 130, 246, 0.2);
  border-radius: 6px;
}

.catalogue-manager__form-notice p {
  margin: 0;
  font-size: 0.8125rem;
  color: #93c5fd;
}

.catalogue-manager__form-group label {
  font-size: 0.75rem;
  color: var(--colour-text-muted);
}

.catalogue-manager__textarea-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

.catalogue-manager__textarea-wrap textarea {
  width: 100%;
  box-sizing: border-box;
}

.catalogue-manager__textarea-wrap--hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}

.catalogue-manager__field-error {
  color: #f87171;
  font-size: 0.75rem;
}

.catalogue-manager__edit-error {
  color: #f87171;
  font-size: 0.8125rem;
}

.catalogue-manager__confidence {
  font-size: 0.8125rem;
  color: var(--colour-text-muted);
}

.catalogue-manager__confidence strong {
  color: var(--colour-text-primary);
}

@media (max-width: 640px) {
  .catalogue-manager__diff {
    grid-template-columns: 1fr;
  }
}
</style>
