<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Locale } from '../../i18n'
import { agreementCopy, THIRD_PARTY_AGREEMENT_VERSION } from './thirdPartyAgreement'
const props = defineProps<{ locale: Locale; pending: boolean; accepted: boolean }>()
const emit = defineEmits<{ (event: 'accept'): void; (event: 'cancel'): void; (event: 'withdraw'): void }>()
const copy = computed(() => agreementCopy[props.locale])
const checked = ref(false)
const expanded = ref(false)
const consentCheckbox = ref<HTMLInputElement>()
watch(() => props.pending, async (pending) => {
  checked.value = false
  if (pending) {
    await nextTick()
    consentCheckbox.value?.focus()
    consentCheckbox.value?.scrollIntoView?.({ block: 'nearest' })
  }
})
</script>
<template>
  <div class="source-agreement" data-settings-source-agreement>
    <button type="button" data-agreement-read :aria-expanded="expanded || pending" @click="expanded = !expanded">{{ copy.read }}</button>
    <div v-if="expanded || pending" class="source-agreement__content" data-agreement-content @keydown.esc.stop="emit('cancel')">
      <h4>{{ copy.title }} — {{ THIRD_PARTY_AGREEMENT_VERSION }}</h4>
      <p v-for="paragraph in copy.paragraphs" :key="paragraph">{{ paragraph }}</p>
      <template v-if="pending">
        <label><input ref="consentCheckbox" v-model="checked" data-agreement-check type="checkbox" /> {{ copy.check }}</label>
        <div class="source-agreement__actions">
          <button type="button" data-agreement-accept :disabled="!checked" @click="emit('accept')">{{ copy.accept }}</button>
          <button type="button" data-agreement-cancel @click="emit('cancel')">{{ copy.cancel }}</button>
        </div>
      </template>
    </div>
    <p v-if="accepted" role="status">{{ copy.accepted }} — {{ THIRD_PARTY_AGREEMENT_VERSION }}</p>
    <button type="button" data-agreement-withdraw @click="emit('withdraw')">{{ copy.withdraw }}</button>
  </div>
</template>
<style scoped>
.source-agreement { display: grid; gap: var(--liquid-space); }
.source-agreement__content { display: grid; gap: var(--liquid-space); min-width: 0; padding-block: var(--liquid-space); }
.source-agreement__content p { color: var(--liquid-text-secondary); line-height: 1.6; overflow-wrap: anywhere; }
.source-agreement__actions { display: flex; flex-wrap: wrap; gap: var(--liquid-space); }
.source-agreement button, .source-agreement label { min-height: 44px; }
</style>
