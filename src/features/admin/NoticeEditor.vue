<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AdminNotice, AdminNoticeInput, Locale, NoticeContent, NoticeSeverity, NoticeTargeting } from './client'
import { usePreferences } from '../../stores/preferences'
import { translate, type TranslationKey } from '../../i18n'

const { locale: currentLocale } = usePreferences()

function t(key: string, params?: Record<string, unknown>): string {
  return translate(currentLocale.value, key as TranslationKey, params)
}

const props = defineProps<{
  notice: AdminNotice | null
  submitting?: boolean
}>()

const emit = defineEmits<{
  (event: 'submit', input: AdminNoticeInput): void
  (event: 'cancel'): void
}>()

const SEVERITIES: readonly NoticeSeverity[] = ['info', 'warning', 'critical']
const TARGETINGS: readonly NoticeTargeting[] = ['everyone', 'authenticated', 'anonymous', 'admin']
const LOCALES: readonly { value: Locale; label: string }[] = [
  { value: 'zh-Hant', label: '繁體中文' },
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'en', label: 'English' },
]
const CONTENT_MAX = 1_000

const isEdit = computed(() => props.notice !== null)
const severity = ref<NoticeSeverity>(props.notice?.severity ?? 'info')
const targeting = ref<NoticeTargeting>(props.notice?.targeting ?? 'everyone')
const content = ref<NoticeContent>(Object.fromEntries(
  LOCALES.map((locale) => [locale.value, props.notice?.content?.[locale.value] ?? '']),
) as NoticeContent)
const startInput = ref(toLocalDateTimeInput(props.notice?.startAt ?? null))
const endInput = ref(toLocalDateTimeInput(props.notice?.endAt ?? null))
const showPreview = ref(false)
const validationError = ref('')

function toLocalDateTimeInput(ms: number | null): string {
  if (ms === null) return ''
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromLocalDateTimeInput(value: string): number | null {
  if (!value) return null
 const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

const trimmedContent = computed<NoticeContent>(() => {
  const result: NoticeContent = {}
  for (const locale of LOCALES) {
    const value = content.value[locale.value]?.trim() ?? ''
    if (value.length > 0) result[locale.value] = value
  }
  return result
})

const canSubmit = computed(() => !props.submitting && Object.keys(trimmedContent.value).length > 0)

function buildInput(): AdminNoticeInput {
  return {
    severity: severity.value,
    targeting: targeting.value,
    content: trimmedContent.value,
    startAt: fromLocalDateTimeInput(startInput.value),
    endAt: fromLocalDateTimeInput(endInput.value),
  }
}

function validate(input: AdminNoticeInput): boolean {
  if (Object.keys(input.content).length === 0) {
    validationError.value = t('admin.notices.validationAtLeastOne') || 'At least one locale must have content.'
    return false
  }
  for (const locale of LOCALES) {
    const value = input.content[locale.value]
    if (value !== undefined && value.length > CONTENT_MAX) {
      validationError.value = t('admin.notices.validationExceeds', { locale: locale.label, max: CONTENT_MAX }) || `${locale.label} content exceeds ${CONTENT_MAX} characters.`
      return false
    }
  }
  if (input.startAt !== null && input.endAt !== null && input.endAt < input.startAt) {
    validationError.value = t('admin.notices.validationTimeOrder') || 'End time must not be before the start time.'
    return false
  }
  validationError.value = ''
  return true
}

function onSubmit(): void {
  const input = buildInput()
  if (!validate(input)) return
  emit('submit', input)
}

function clearStart(): void { startInput.value = '' }
function clearEnd(): void { endInput.value = '' }
</script>

<template>
  <form class="notice-editor" data-notice-editor @submit.prevent="onSubmit">
    <header class="notice-editor__header">
      <h4>{{ isEdit ? (t('admin.notices.editNotice') || 'Edit notice') : (t('admin.notices.newNotice') || 'New notice') }}</h4>
      <button type="button" data-notice-preview-toggle @click="showPreview = !showPreview">
        {{ showPreview ? (t('admin.notices.hidePreview') || 'Hide preview') : (t('admin.notices.showPreview') || 'Preview') }}
      </button>
    </header>

    <div v-if="showPreview" class="notice-editor__preview" data-notice-preview>
      <span class="notice-editor__preview-severity" :data-notice-preview-severity="severity">{{ severity }}</span>
      <dl>
        <div v-for="loc in LOCALES" :key="loc.value">
          <dt>{{ loc.label }}</dt>
          <dd>{{ content[loc.value] || '\u2014' }}</dd>
        </div>
      </dl>
      <p v-if="startInput || endInput">
        {{ t('admin.notices.schedulePrefix') || 'Schedule:' }} {{ startInput || (t('admin.notices.now') || 'now') }} \u2192 {{ endInput || (t('admin.notices.open') || 'open') }}
      </p>
    </div>

    <label class="notice-editor__field">
      <span>{{ t('admin.notices.severity') || 'Severity' }}</span>
      <select v-model="severity" data-notice-field-severity>
        <option v-for="value in SEVERITIES" :key="value" :value="value">{{ value }}</option>
      </select>
    </label>

    <label class="notice-editor__field">
      <span>{{ t('admin.notices.audience') || 'Audience' }}</span>
      <select v-model="targeting" data-notice-field-targeting>
        <option v-for="value in TARGETINGS" :key="value" :value="value">{{ value }}</option>
      </select>
    </label>

    <fieldset class="notice-editor__locales">
      <legend>{{ t('admin.notices.contentLegend') || 'Content (at least one locale required)' }}</legend>
      <label v-for="loc in LOCALES" :key="loc.value" class="notice-editor__field">
        <span>{{ loc.label }}</span>
        <textarea
          v-model="content[loc.value]"
          :data-notice-field-content="loc.value"
          rows="3"
          maxlength="1000"
        ></textarea>
      </label>
    </fieldset>

    <div class="notice-editor__schedule">
      <label class="notice-editor__field">
        <span>{{ t('admin.notices.starts') || 'Starts' }}</span>
        <div class="notice-editor__schedule-input">
          <input v-model="startInput" type="datetime-local" data-notice-field-start />
          <button v-if="startInput" type="button" data-notice-clear-start @click="clearStart">{{ t('admin.notices.clear') || 'Clear' }}</button>
        </div>
      </label>
      <label class="notice-editor__field">
        <span>{{ t('admin.notices.ends') || 'Ends' }}</span>
        <div class="notice-editor__schedule-input">
          <input v-model="endInput" type="datetime-local" data-notice-field-end />
          <button v-if="endInput" type="button" data-notice-clear-end @click="clearEnd">{{ t('admin.notices.clear') || 'Clear' }}</button>
        </div>
      </label>
    </div>

    <p v-if="validationError" class="notice-editor__error" role="alert">{{ validationError }}</p>

    <div class="notice-editor__actions">
      <button type="submit" data-notice-submit :disabled="!canSubmit">
        {{ props.submitting ? (t('admin.notices.saving') || 'Saving...') : (isEdit ? (t('admin.notices.saveChanges') || 'Save changes') : (t('admin.notices.createNotice') || 'Create notice')) }}
      </button>
      <button type="button" data-notice-cancel @click="emit('cancel')">{{ t('admin.common.cancel') || 'Cancel' }}</button>
    </div>
  </form>
</template>

<style scoped>
.notice-editor {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
  padding: 1rem 1.25rem;
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: var(--radius-surface);
}

.notice-editor__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.notice-editor__header h4 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}

.notice-editor__preview {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border: var(--glass-border);
  border-radius: 0.5rem;
  background: rgb(255 255 255 / 4%);
  font-size: 0.875rem;
}

.notice-editor__preview dl {
  display: grid;
  gap: 0.25rem;
  margin: 0;
}

.notice-editor__preview dt {
  color: var(--colour-text-muted);
  font-size: 0.8125rem;
}

.notice-editor__preview dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.notice-editor__preview-severity {
  text-transform: capitalize;
  font-weight: 700;
}

.notice-editor__field {
  display: grid;
  gap: 0.25rem;
  min-width: 0;
}

.notice-editor__field > span {
  color: var(--colour-text-muted);
  font-size: 0.8125rem;
}

.notice-editor__field select,
.notice-editor__field input,
.notice-editor__field textarea {
  width: 100%;
  min-height: 2.5rem;
  padding: 0.5rem 0.75rem;
  color: var(--colour-text-primary);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  font: inherit;
  resize: vertical;
}

.notice-editor__locales {
  display: grid;
  gap: 0.75rem;
  margin: 0;
  padding: 0.75rem 1rem;
  border: var(--glass-border);
  border-radius: 0.5rem;
}

.notice-editor__locales legend {
  color: var(--colour-text-muted);
  font-size: 0.8125rem;
  padding: 0 0.5rem;
}

.notice-editor__schedule {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.notice-editor__schedule-input {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.notice-editor__schedule-input input {
  flex: 1;
}

.notice-editor__actions {
  display: flex;
  gap: 0.5rem;
}

.notice-editor__actions button {
  min-height: 2.5rem;
  padding: 0.5rem 1rem;
  color: var(--colour-accent-strong);
  background: var(--colour-surface-opaque);
  border: var(--glass-border);
  border-radius: 0.5rem;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: transform var(--motion-duration) ease, filter var(--motion-duration) ease;
}

.notice-editor__actions button:hover:not(:disabled) {
  filter: var(--control-hover-filter);
}

.notice-editor__actions button:active:not(:disabled) {
  transform: scale(0.96);
  filter: var(--control-active-filter);
}

.notice-editor__actions button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.notice-editor__error {
  margin: 0;
  color: #f87171;
  font-size: 0.8125rem;
}

@media (max-width: 36rem) {
  .notice-editor__schedule {
    grid-template-columns: 1fr;
  }
}
</style>
