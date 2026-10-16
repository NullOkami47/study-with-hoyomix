<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { usePreferences } from '../../../stores/preferences'
import { translate, type TranslationKey } from '../../../i18n'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description?: string
  variant?: 'danger' | 'warning' | 'primary'
  confirmText?: string
  cancelText?: string
  requirePhrase?: string
  requireReason?: boolean
  loading?: boolean
  error?: string
  teleport?: boolean
  dialogDataAttr?: string
  confirmDataAttr?: string
  cancelDataAttr?: string
  phraseDataAttr?: string
  reasonDataAttr?: string
  errorDataAttr?: string
  disableInvalid?: boolean
}>(), {
  description: '',
  variant: 'danger',
  confirmText: undefined,
  cancelText: undefined,
  requirePhrase: '',
  requireReason: false,
  loading: false,
  error: '',
  teleport: true,
  dialogDataAttr: undefined,
  confirmDataAttr: undefined,
  cancelDataAttr: undefined,
  phraseDataAttr: undefined,
  reasonDataAttr: undefined,
  errorDataAttr: undefined,
  disableInvalid: true,
})

const { locale } = usePreferences()

function t(key: string): string {
  return translate(locale.value, key as TranslationKey)
}

const effectiveConfirmText = computed(() => props.confirmText ?? (t('admin.confirmDialog.confirm') || 'Confirm'))
const effectiveCancelText = computed(() => props.cancelText ?? (t('admin.confirmDialog.cancel') || 'Cancel'))

const phrasePromptParts = computed(() => {
  const pattern = t('admin.confirmDialog.phrasePrompt') || 'Type {phrase} to confirm:'
  return pattern.split('{phrase}')
})

const emit = defineEmits<{
  (e: 'confirm', payload: { confirmation?: string; reason?: string }): void
  (e: 'cancel'): void
}>()

const typedPhrase = ref('')
const reason = ref('')
const dialogRef = ref<HTMLElement | null>(null)
const phraseInputRef = ref<HTMLInputElement | null>(null)
const openerElement = ref<HTMLElement | null>(null)
let isSubmitting = false

const isPhraseValid = computed(() => {
  if (!props.requirePhrase) return true
  return typedPhrase.value === props.requirePhrase
})

const isReasonValid = computed(() => {
  if (!props.requireReason) return true
  return reason.value.trim().length > 0
})

const canConfirm = computed(() => {
  if (props.loading) return false
  if (!props.disableInvalid) return true
  return isPhraseValid.value && isReasonValid.value
})

function getFocusableElements(): HTMLElement[] {
  if (!dialogRef.value) return []
  const selector = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  const elements = Array.from(dialogRef.value.querySelectorAll<HTMLElement>(selector))
  return elements.filter((el) => {
    return el.getAttribute('aria-hidden') !== 'true'
  })
}

function onKeydown(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    onCancel()
    return
  }
  if (e.key === 'Tab') {
    const focusable = getFocusableElements()
    if (focusable.length === 0) {
      e.preventDefault()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement as HTMLElement | null

    if (e.shiftKey) {
      if (!active || active === first || !dialogRef.value?.contains(active)) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (!active || active === last || !dialogRef.value?.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
  }
}

function onFocusin(e: FocusEvent) {
  if (!props.open || !dialogRef.value) return
  const target = e.target as HTMLElement | null
  if (target && !dialogRef.value.contains(target)) {
    e.preventDefault()
    const focusable = getFocusableElements()
    if (focusable.length > 0) {
      focusable[0].focus()
    } else {
      dialogRef.value.focus()
    }
  }
}

function restoreOpener() {
  if (openerElement.value && typeof openerElement.value.focus === 'function') {
    openerElement.value.focus()
  }
  openerElement.value = null
}

function onCancel() {
  emit('cancel')
}

function onSubmitButtonClick(e: MouseEvent) {
  const form = (e.currentTarget as HTMLElement)?.closest('form')
  if (form && !form.isConnected) {
    onConfirm()
  }
}

function onConfirm() {
  if (isSubmitting) return
  if (props.disableInvalid && !canConfirm.value) return
  isSubmitting = true
  try {
    emit('confirm', {
      confirmation: props.requirePhrase ? typedPhrase.value : undefined,
      reason: props.requireReason ? reason.value.trim() : undefined,
    })
  } finally {
    setTimeout(() => {
      isSubmitting = false
    }, 0)
  }
}

async function setupFocusTrap() {
  openerElement.value = (document.activeElement as HTMLElement) ?? null
  window.addEventListener('keydown', onKeydown, true)
  document.addEventListener('focusin', onFocusin, true)
  await nextTick()
  if (phraseInputRef.value) {
    phraseInputRef.value.focus()
  } else if (dialogRef.value) {
    const focusable = getFocusableElements()
    if (focusable.length > 0) {
      focusable[0].focus()
    } else {
      dialogRef.value.focus()
    }
  }
}

function teardownFocusTrap() {
  window.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('focusin', onFocusin, true)
  restoreOpener()
  typedPhrase.value = ''
  reason.value = ''
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      void setupFocusTrap()
    } else {
      teardownFocusTrap()
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  teardownFocusTrap()
})
</script>

<template>
  <Teleport to="body" :disabled="!teleport">
    <div
      v-if="open"
      class="admin-dialog-backdrop"
      data-admin-dialog-backdrop
      @click.self="onCancel"
    >
      <div
        ref="dialogRef"
        class="admin-dialog"
        :class="[`admin-dialog--${variant}`]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-dialog-title"
        :aria-describedby="description ? 'admin-dialog-desc' : undefined"
        data-admin-confirm-dialog
        :[dialogDataAttr]="dialogDataAttr ? '' : undefined"
      >
        <header class="admin-dialog__header">
          <div class="admin-dialog__icon" aria-hidden="true">
            <span v-if="variant === 'danger'">⚠️</span>
            <span v-else-if="variant === 'warning'">⚡</span>
            <span v-else>ℹ️</span>
          </div>
          <div class="admin-dialog__header-text">
            <h3 id="admin-dialog-title" class="admin-dialog__title">{{ title }}</h3>
            <p v-if="description" id="admin-dialog-desc" class="admin-dialog__description">
              {{ description }}
            </p>
          </div>
        </header>

        <form class="admin-dialog__body" @submit.prevent="onConfirm">
          <slot />

          <div v-if="requirePhrase" class="admin-dialog__form-group">
            <label for="admin-confirm-phrase" class="admin-dialog__label">
              <span>{{ phrasePromptParts[0] }}</span><strong class="admin-dialog__phrase">{{ requirePhrase }}</strong><span>{{ phrasePromptParts[1] ?? '' }}</span>
            </label>
            <input
              id="admin-confirm-phrase"
              ref="phraseInputRef"
              v-model="typedPhrase"
              type="text"
              class="admin-dialog__input"
              data-admin-confirm-input
              :[phraseDataAttr]="phraseDataAttr ? '' : undefined"
              autocomplete="off"
              :placeholder="requirePhrase"
            />
          </div>

          <div v-if="requireReason" class="admin-dialog__form-group">
            <label for="admin-confirm-reason" class="admin-dialog__label">
              {{ t('admin.confirmDialog.reasonPrompt') || 'Reason (required for audit log):' }}
            </label>
            <input
              id="admin-confirm-reason"
              v-model="reason"
              type="text"
              class="admin-dialog__input"
              data-admin-reason-input
              :[reasonDataAttr]="reasonDataAttr ? '' : undefined"
              :placeholder="t('admin.confirmDialog.reasonPlaceholder') || 'e.g. Scheduled emergency maintenance'"
            />
          </div>

          <p
            v-if="error"
            class="admin-dialog__error"
            role="alert"
            data-admin-dialog-error
            :[errorDataAttr]="errorDataAttr ? '' : undefined"
          >
            {{ error }}
          </p>

          <footer class="admin-dialog__footer">
            <button
              type="button"
              class="admin-dialog__button admin-dialog__button--cancel"
              data-admin-cancel-button
              :[cancelDataAttr]="cancelDataAttr ? '' : undefined"
              @click="onCancel"
            >
              {{ effectiveCancelText }}
            </button>
            <button
              type="submit"
              class="admin-dialog__button"
              :class="[`admin-dialog__button--${variant}`]"
              :disabled="!canConfirm"
              data-admin-confirm-button
              :[confirmDataAttr]="confirmDataAttr ? '' : undefined"
              @click="onSubmitButtonClick"
            >
              <span v-if="loading">{{ t('admin.confirmDialog.saving') || 'Saving...' }}</span>
              <span v-else>{{ effectiveConfirmText }}</span>
            </button>
          </footer>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.admin-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  animation: fade-in 0.2s ease;
}

.admin-dialog {
  width: 100%;
  max-width: 520px;
  background: #181920;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
  overflow: hidden;
  animation: scale-up 0.2s ease;
}

.admin-dialog--danger {
  border-color: rgba(239, 68, 68, 0.4);
}

.admin-dialog__header {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.admin-dialog__icon {
  font-size: 1.75rem;
  line-height: 1;
  flex-shrink: 0;
}

.admin-dialog__header-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.admin-dialog__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: #f8fafc;
}

.admin-dialog__description {
  margin: 0;
  font-size: 0.875rem;
  color: #94a3b8;
  line-height: 1.5;
}

.admin-dialog__body {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.admin-dialog__form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.admin-dialog__label {
  font-size: 0.875rem;
  color: #cbd5e1;
}

.admin-dialog__phrase {
  color: #ef4444;
  font-family: monospace;
  background: rgba(239, 68, 68, 0.15);
  padding: 2px 6px;
  border-radius: 4px;
}

.admin-dialog__input {
  width: 100%;
  padding: 10px 12px;
  font-size: 0.875rem;
  background: rgba(0, 0, 0, 0.4);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  color: #f8fafc;
  box-sizing: border-box;
}

.admin-dialog__input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
}

.admin-dialog__error {
  margin: 0;
  font-size: 0.875rem;
  color: #ef4444;
}

.admin-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 8px;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.admin-dialog__button {
  padding: 9px 18px;
  font-size: 0.875rem;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
  border: none;
}

.admin-dialog__button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.admin-dialog__button--cancel {
  background: rgba(255, 255, 255, 0.08);
  color: #cbd5e1;
}

.admin-dialog__button--cancel:hover {
  background: rgba(255, 255, 255, 0.14);
}

.admin-dialog__button--danger {
  background: #dc2626;
  color: #ffffff;
}

.admin-dialog__button--danger:not(:disabled):hover {
  background: #b91c1c;
}

.admin-dialog__button--warning {
  background: #d97706;
  color: #ffffff;
}

.admin-dialog__button--primary {
  background: #2563eb;
  color: #ffffff;
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes scale-up {
  from { transform: scale(0.95); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
</style>
